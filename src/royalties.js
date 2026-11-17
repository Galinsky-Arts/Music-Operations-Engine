import {createHash} from 'node:crypto';
import {requireThat} from './errors.js';
import {identifier,title} from './validation.js';

/**
 * Revenue recognition and royalty splits (MOE-013).
 *
 * Recognition policy: a revenue line is *recognized* when its source reports it settled (distributor
 * status `settled`/`reversed`, or a fact whose metadata.settlement is `settled`); otherwise it is
 * *pending* (accrued, not yet received). Refunds and reversals reduce the period in which they occur.
 * Currencies are never combined. Allocation uses basis points and the largest-remainder method, so
 * every payee share sums exactly to the line amount.
 *
 * Rule precedence per line: track rule → release rule → label rule → system default.
 * The system default (used only when a label has configured nothing) is 50% to the line's catalog
 * artist and 50% to the label; lines without artist attribution go 100% to the label.
 */
export const ARTIST='@artist',LABEL='@label';
export const SYSTEM_DEFAULT_SPLITS=Object.freeze([{payeeId:ARTIST,name:'Primary artist',shareBps:5000},{payeeId:LABEL,name:'Label',shareBps:5000}]);
export const PERIOD=/^\d{4}-(0[1-9]|1[0-2])$/;

export function normalizePeriod(value) {
  requireThat(typeof value==='string' && PERIOD.test(value),'period must be YYYY-MM',400);
  return value;
}
export function normalizeSplitRule(raw) {
  requireThat(raw && typeof raw==='object' && !Array.isArray(raw),'Split rule must be an object',400);
  const labelId=identifier(raw.labelId,'labelId');
  requireThat(['label','release','track'].includes(raw.scopeKind),'scopeKind must be label, release or track',400);
  const scopeId=raw.scopeKind==='label' ? '' : identifier(raw.scopeId,'scopeId');
  requireThat(Array.isArray(raw.splits) && raw.splits.length>=1 && raw.splits.length<=50,'splits must list 1–50 payees',400);
  const seen=new Set();let total=0;
  const splits=raw.splits.map(s=>{
    requireThat(s && typeof s==='object','Each split must be an object',400);
    const payeeId=s.payeeId===ARTIST || s.payeeId===LABEL ? s.payeeId : identifier(s.payeeId,'payeeId');
    requireThat(!seen.has(payeeId),'Duplicate payee in split rule',400);seen.add(payeeId);
    requireThat(Number.isInteger(s.shareBps) && s.shareBps>0 && s.shareBps<=10000,'shareBps must be 1–10000',400);
    total+=s.shareBps;
    return {payeeId,name:s.name===undefined ? payeeId : title(s.name,'payee name'),shareBps:s.shareBps};
  });
  requireThat(total===10000,'Split shares must total exactly 10000 basis points (100%)',400);
  const note=raw.note===undefined || raw.note===null ? null : title(raw.note,'note');
  return {labelId,scopeKind:raw.scopeKind,scopeId,splits,note};
}

/** Allocate an exact signed integer amount by basis points; remainders go to the largest fractional parts. */
export function allocate(amount,splits) {
  const value=BigInt(amount),negative=value<0n,abs=negative ? -value : value;
  const parts=splits.map((s,i)=>{const raw=abs*BigInt(s.shareBps);return {i,base:raw/10000n,rem:raw%10000n};});
  let left=abs-parts.reduce((sum,p)=>sum+p.base,0n);
  for (const p of [...parts].sort((a,b)=>(b.rem>a.rem ? 1 : b.rem<a.rem ? -1 : a.i-b.i))) { if (left<=0n) break;p.base+=1n;left-=1n; }
  return parts.sort((a,b)=>a.i-b.i).map(p=>negative ? -p.base : p.base);
}

function resolvePayee(split,line) {
  if (split.payeeId===ARTIST) return line.artistId ? {payeeId:'artist:'+line.artistId,name:line.artistName || line.artistId} : {payeeId:'label',name:'Label (unattributed artist)'};
  if (split.payeeId===LABEL) return {payeeId:'label',name:'Label'};
  return {payeeId:split.payeeId,name:split.name};
}

/**
 * Build per-payee statements from grouped revenue lines.
 * lines: [{currency,artistId,artistName,releaseId,trackId,trackName,kind,recognized:boolean,amountMinor}]
 * rules: Map keyed 'label:'|'release:<id>'|'track:<id>' → {splits,...}
 */
export function buildStatements(lines,rules) {
  const payees=new Map();
  for (const line of lines) {
    let rule=null,ruleScope='system-default';
    const candidates=[line.trackId && ['track:'+line.trackId,'track'],line.releaseId && ['release:'+line.releaseId,'release'],['label:','label']].filter(Boolean);
    for (const [key,scope] of candidates) if (rules.has(key)) { rule=rules.get(key);ruleScope=scope;break; }
    let splits=rule ? rule.splits : SYSTEM_DEFAULT_SPLITS;
    if (!rule && !line.artistId) splits=[{payeeId:LABEL,name:'Label',shareBps:10000}];
    const shares=allocate(line.amountMinor,splits);
    splits.forEach((split,i)=>{
      const payee=resolvePayee(split,line),key=payee.payeeId+'\0'+line.currency;
      if (!payees.has(key)) payees.set(key,{payeeId:payee.payeeId,payeeName:payee.name,currency:line.currency,recognizedMinor:0n,pendingMinor:0n,lines:new Map()});
      const p=payees.get(key);
      const lineKey=[line.trackId||'',line.releaseId||'',line.kind,ruleScope,split.shareBps].join('\0');
      if (!p.lines.has(lineKey)) p.lines.set(lineKey,{trackId:line.trackId||null,track:line.trackName||null,releaseId:line.releaseId||null,kind:line.kind,
        ruleScope,shareBps:split.shareBps,recognizedMinor:0n,pendingMinor:0n,grossLineMinor:0n});
      const l=p.lines.get(lineKey);
      l.grossLineMinor+=BigInt(line.amountMinor);
      if (line.recognized) { p.recognizedMinor+=shares[i];l.recognizedMinor+=shares[i]; }
      else { p.pendingMinor+=shares[i];l.pendingMinor+=shares[i]; }
    });
  }
  return [...payees.values()].map(p=>({payeeId:p.payeeId,payeeName:p.payeeName,currency:p.currency,
    recognizedMinor:p.recognizedMinor.toString(),pendingMinor:p.pendingMinor.toString(),
    lines:[...p.lines.values()].map(l=>({...l,recognizedMinor:l.recognizedMinor.toString(),pendingMinor:l.pendingMinor.toString(),grossLineMinor:l.grossLineMinor.toString()}))
      .sort((a,b)=>String(a.releaseId).localeCompare(String(b.releaseId)) || String(a.trackId).localeCompare(String(b.trackId)) || a.kind.localeCompare(b.kind))}))
    .sort((a,b)=>a.payeeId.localeCompare(b.payeeId) || a.currency.localeCompare(b.currency));
}

export function statementId(labelId,period,payeeId,currency) {
  return createHash('sha256').update([labelId,period,payeeId,currency].join('\0')).digest('hex');
}
export function statementHash(statement) {
  return createHash('sha256').update(JSON.stringify([statement.recognizedMinor,statement.pendingMinor,statement.lines])).digest('hex');
}
export const statementCsvColumns=['labelId','period','payeeId','payeeName','currency','status','releaseId','trackId','track','kind','ruleScope','shareBps','grossLineMinor','recognizedMinor','pendingMinor'];
