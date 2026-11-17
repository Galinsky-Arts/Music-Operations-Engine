import {randomUUID} from 'node:crypto';
import {requireThat} from './errors.js';
import {identifier,integer,title} from './validation.js';
import {buildStatements,normalizePeriod,normalizeSplitRule,statementHash,statementId,SYSTEM_DEFAULT_SPLITS} from './royalties.js';

const currency=value=>{const c=String(value||'').toUpperCase();requireThat(/^[A-Z]{3}$/.test(c),'Invalid currency',400);return c;};
const iso=v=>v ? new Date(v).toISOString() : null;
const periodRange=period=>{const [y,m]=period.split('-').map(Number);return [new Date(Date.UTC(y,m-1,1)).toISOString(),new Date(Date.UTC(y,m,1)).toISOString()];};
const statementRow=r=>({id:r.id.trim(),labelId:r.labelId,period:r.period,payeeId:r.payeeId,payeeName:r.payeeName,currency:r.currency.trim(),
  recognizedMinor:r.recognizedMinor,pendingMinor:r.pendingMinor,status:r.status,generatedAt:iso(r.generatedAt),finalizedAt:iso(r.finalizedAt),
  ...(r.lines ? {lines:r.lines} : {})});

export function normalizeBudget(raw) {
  requireThat(raw && typeof raw==='object' && !Array.isArray(raw),'Budget must be an object',400);
  const amount=integer(raw.amountMinor,'amountMinor');
  requireThat(amount>0n,'amountMinor must be positive',400);
  return {labelId:identifier(raw.labelId,'labelId'),id:identifier(raw.id,'budget id'),name:title(raw.name),period:normalizePeriod(raw.period),
    category:identifier(raw.category || 'general','category'),currency:currency(raw.currency || 'USD'),amountMinor:amount.toString(),
    releaseId:raw.releaseId ? identifier(raw.releaseId,'releaseId') : null};
}
export function normalizeExpense(raw) {
  requireThat(raw && typeof raw==='object' && !Array.isArray(raw),'Expense must be an object',400);
  const amount=integer(raw.amountMinor,'amountMinor');
  requireThat(amount>0n,'amountMinor must be positive',400);
  requireThat(typeof raw.occurredOn==='string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.occurredOn) && !Number.isNaN(Date.parse(raw.occurredOn)),'occurredOn must be YYYY-MM-DD',400);
  return {labelId:identifier(raw.labelId,'labelId'),budgetId:identifier(raw.budgetId,'budgetId'),occurredOn:raw.occurredOn,
    currency:currency(raw.currency || 'USD'),amountMinor:amount.toString(),description:title(raw.description,'description'),
    vendor:raw.vendor ? title(raw.vendor,'vendor') : null};
}

export function financeStore(pool,transaction,audit) {
  async function rules(labelId) {
    const rows=(await pool.query(`SELECT scope_kind AS "scopeKind",scope_id AS "scopeId",splits,note,updated_by AS "updatedBy",updated_at AS "updatedAt"
FROM music_split_rules WHERE label_id=$1 ORDER BY scope_kind,scope_id`,[labelId])).rows;
    return rows.map(r=>({labelId,...r,updatedAt:iso(r.updatedAt)}));
  }
  async function revenueLines(labelId,period) {
    const [from,to]=periodRange(period);
    const rows=(await pool.query(`SELECT trim(f.currency) AS currency,COALESCE(f.artist_id,t.artist_id) AS "artistId",a.name AS "artistName",
COALESCE(f.release_id,t.release_id) AS "releaseId",f.track_id AS "trackId",COALESCE(t.name,NULLIF(f.track,'')) AS "trackName",f.type AS kind,
COALESCE(f.metadata->>'settlement','')='settled' AS recognized,
SUM(CASE WHEN f.type='refund' THEN -f.amount_minor ELSE f.amount_minor END)::text AS "amountMinor"
FROM music_facts f LEFT JOIN music_catalog t ON t.label_id=f.label_id AND t.id=f.track_id AND t.kind='track'
LEFT JOIN music_catalog a ON a.label_id=f.label_id AND a.id=COALESCE(f.artist_id,t.artist_id)
WHERE f.label_id=$1 AND f.type IN ('sale','refund','royalty') AND f.occurred_at>=$2 AND f.occurred_at<$3
GROUP BY 1,2,3,4,5,6,7,8
UNION ALL
SELECT trim(d.currency),d.artist_id,a.name,d.release_id,d.track_id,t.name,'distributor:'||d.source,
d.provider_status IN ('settled','reversed'),SUM(d.net_minor)::text
FROM music_distributor_rows d LEFT JOIN music_catalog a ON a.label_id=d.label_id AND a.id=d.artist_id
LEFT JOIN music_catalog t ON t.label_id=d.label_id AND t.id=d.track_id
WHERE d.label_id=$1 AND d.occurred_at>=$2::date AND d.occurred_at<$3::date
GROUP BY 1,2,3,4,5,6,7,8`,[labelId,from,to])).rows;
    return rows.filter(r=>BigInt(r.amountMinor)!==0n);
  }
  async function preview(labelId,period) {
    period=normalizePeriod(period);
    const ruleList=await rules(labelId);
    const map=new Map(ruleList.map(r=>[r.scopeKind+':'+r.scopeId,r]));
    const lines=await revenueLines(labelId,period);
    const statements=buildStatements(lines,map);
    const totals={};
    for (const l of lines) {
      totals[l.currency] ??= {recognizedMinor:0n,pendingMinor:0n};
      totals[l.currency][l.recognized ? 'recognizedMinor' : 'pendingMinor']+=BigInt(l.amountMinor);
    }
    return {labelId,period,statements,revenue:Object.entries(totals).map(([c,t])=>({currency:c,recognizedMinor:t.recognizedMinor.toString(),pendingMinor:t.pendingMinor.toString()})),
      rules:ruleList,defaultRule:ruleList.some(r=>r.scopeKind==='label') ? 'label' : 'system-default',systemDefault:SYSTEM_DEFAULT_SPLITS,
      policy:'Recognized = reported settled by the source; pending = reported but not settled. Refunds and reversals reduce the period they occur in. Currencies are never combined.'};
  }
  async function balances(labelIds,q=pool) {
    const owed=(await q.query(`SELECT label_id AS "labelId",payee_id AS "payeeId",MAX(payee_name) AS "payeeName",trim(currency) AS currency,
SUM(recognized_minor)::text AS earned FROM music_royalty_statements WHERE label_id=ANY($1::text[]) AND status='final' GROUP BY 1,2,4`,[labelIds])).rows;
    const paid=(await q.query(`SELECT label_id AS "labelId",payee_id AS "payeeId",trim(currency) AS currency,SUM(amount_minor)::text AS paid
FROM music_payouts WHERE label_id=ANY($1::text[]) GROUP BY 1,2,3`,[labelIds])).rows;
    const map=new Map();
    for (const r of owed) map.set([r.labelId,r.payeeId,r.currency].join('\0'),{...r,paid:'0'});
    for (const r of paid) {
      const key=[r.labelId,r.payeeId,r.currency].join('\0');
      map.set(key,{...(map.get(key) || {labelId:r.labelId,payeeId:r.payeeId,payeeName:r.payeeId,currency:r.currency,earned:'0'}),paid:r.paid});
    }
    return [...map.values()].map(b=>({labelId:b.labelId,payeeId:b.payeeId,payeeName:b.payeeName,currency:b.currency,
      earnedMinor:b.earned,paidMinor:b.paid,balanceMinor:(BigInt(b.earned)-BigInt(b.paid)).toString()}))
      .sort((a,b)=>a.labelId.localeCompare(b.labelId) || a.payeeId.localeCompare(b.payeeId) || a.currency.localeCompare(b.currency));
  }
  return {
    async putSplitRule(raw,actor='system') {
      const rule=normalizeSplitRule(raw);
      return transaction(async c=>{
        if (rule.scopeKind!=='label') {
          const item=(await c.query('SELECT kind FROM music_catalog WHERE label_id=$1 AND id=$2',[rule.labelId,rule.scopeId])).rows[0];
          requireThat(item?.kind===rule.scopeKind,'scopeId must reference a '+rule.scopeKind+' in the label catalog',422);
        } else requireThat((await c.query('SELECT 1 FROM music_labels WHERE id=$1',[rule.labelId])).rows.length,'Unknown label',422);
        await c.query(`INSERT INTO music_split_rules(label_id,scope_kind,scope_id,splits,note,updated_by) VALUES($1,$2,$3,$4,$5,$6)
ON CONFLICT(label_id,scope_kind,scope_id) DO UPDATE SET splits=EXCLUDED.splits,note=EXCLUDED.note,updated_by=EXCLUDED.updated_by,updated_at=now()`,
          [rule.labelId,rule.scopeKind,rule.scopeId,JSON.stringify(rule.splits),rule.note,actor]);
        await audit(c,actor,'royalty.split_rule.put',[rule.labelId],{scopeKind:rule.scopeKind,scopeId:rule.scopeId,payees:rule.splits.length});
        return rule;
      });
    },
    async deleteSplitRule({labelId,scopeKind,scopeId=''},actor='system') {
      identifier(labelId,'labelId');
      requireThat(['label','release','track'].includes(scopeKind),'Invalid scopeKind',400);
      return transaction(async c=>{
        const r=await c.query('DELETE FROM music_split_rules WHERE label_id=$1 AND scope_kind=$2 AND scope_id=$3 RETURNING 1',[labelId,scopeKind,scopeKind==='label' ? '' : scopeId]);
        requireThat(r.rows.length,'Split rule not found',404);
        await audit(c,actor,'royalty.split_rule.deleted',[labelId],{scopeKind,scopeId});
        return {deleted:true};
      });
    },
    async splitRules({labelIds}) { const out=[];for (const id of labelIds) out.push(...await rules(id));return out; },
    royaltyPreview:preview,
    async generateStatements({labelId,period,finalize=false},actor='system') {
      identifier(labelId,'labelId');
      requireThat(typeof finalize==='boolean','finalize must be a boolean',400);
      const result=await preview(labelId,period);
      return transaction(async c=>{
        const saved=[],conflicts=[];
        for (const s of result.statements) {
          const id=statementId(labelId,result.period,s.payeeId,s.currency),hash=statementHash(s);
          const prev=(await c.query('SELECT status,content_hash AS hash FROM music_royalty_statements WHERE id=$1 FOR UPDATE',[id])).rows[0];
          if (prev?.status==='final') {
            if (prev.hash.trim()!==hash) conflicts.push({payeeId:s.payeeId,currency:s.currency,reason:'Source data changed after this statement was finalized; the finalized statement is unchanged. Post the difference as an adjustment in a later period.'});
            saved.push({payeeId:s.payeeId,currency:s.currency,status:'final',changed:false});continue;
          }
          await c.query(`INSERT INTO music_royalty_statements(id,label_id,period,payee_id,payee_name,currency,recognized_minor,pending_minor,lines,content_hash,status,generated_by,finalized_at)
VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
ON CONFLICT(id) DO UPDATE SET payee_name=EXCLUDED.payee_name,recognized_minor=EXCLUDED.recognized_minor,pending_minor=EXCLUDED.pending_minor,
lines=EXCLUDED.lines,content_hash=EXCLUDED.content_hash,status=EXCLUDED.status,generated_by=EXCLUDED.generated_by,generated_at=now(),finalized_at=EXCLUDED.finalized_at`,
            [id,labelId,result.period,s.payeeId,s.payeeName,s.currency,s.recognizedMinor,s.pendingMinor,JSON.stringify(s.lines),hash,finalize ? 'final' : 'draft',actor,finalize ? new Date() : null]);
          saved.push({payeeId:s.payeeId,currency:s.currency,status:finalize ? 'final' : 'draft',changed:prev?.hash?.trim()!==hash});
        }
        // Drafts for payees no longer present in the period are removed; finalized statements are never deleted.
        const keep=result.statements.map(s=>statementId(labelId,result.period,s.payeeId,s.currency));
        await c.query(`DELETE FROM music_royalty_statements WHERE label_id=$1 AND period=$2 AND status='draft' AND NOT (id=ANY($3::bpchar[]))`,[labelId,result.period,keep]);
        await audit(c,actor,finalize ? 'royalty.statements.finalized' : 'royalty.statements.generated',[labelId],{period:result.period,statements:saved.length,conflicts:conflicts.length});
        return {labelId,period:result.period,statements:saved,conflicts,revenue:result.revenue};
      });
    },
    async royaltyStatements({labelIds,period=null,payeeId=null,withLines=false}) {
      if (period!==null) normalizePeriod(period);
      const rows=(await pool.query(`SELECT id,label_id AS "labelId",period,payee_id AS "payeeId",payee_name AS "payeeName",currency,
recognized_minor::text AS "recognizedMinor",pending_minor::text AS "pendingMinor",status,generated_at AS "generatedAt",finalized_at AS "finalizedAt"
${withLines ? ',lines' : ''} FROM music_royalty_statements WHERE label_id=ANY($1::text[]) AND ($2::text IS NULL OR period=$2) AND ($3::text IS NULL OR payee_id=$3)
ORDER BY period DESC,label_id,payee_id,currency LIMIT 2000`,[labelIds,period,payeeId])).rows;
      return rows.map(statementRow);
    },
    royaltyBalances:balances,
    async recordPayout(raw,actor='system') {
      requireThat(raw && typeof raw==='object','Payout must be an object',400);
      const labelId=identifier(raw.labelId,'labelId'),payeeId=identifier(raw.payeeId,'payeeId'),cur=currency(raw.currency);
      const amount=integer(raw.amountMinor,'amountMinor');requireThat(amount>0n,'amountMinor must be positive',400);
      const reference=title(raw.reference,'reference');
      const paidAt=raw.paidAt ? new Date(raw.paidAt) : new Date();
      requireThat(!Number.isNaN(paidAt.getTime()),'Invalid paidAt',400);
      return transaction(async c=>{
        await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',['payout:'+labelId+':'+payeeId]);
        const balance=(await balances([labelId],c)).find(b=>b.payeeId===payeeId && b.currency===cur);
        requireThat(balance && BigInt(balance.balanceMinor)>=amount,'Payout exceeds the finalized statement balance for this payee and currency',422);
        const id=randomUUID();
        await c.query(`INSERT INTO music_payouts(id,label_id,payee_id,currency,amount_minor,reference,paid_at,recorded_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
          [id,labelId,payeeId,cur,amount.toString(),reference,paidAt,actor]);
        await audit(c,actor,'royalty.payout.recorded',[labelId],{payeeId,currency:cur,amountMinor:amount.toString(),reference});
        return {id,labelId,payeeId,currency:cur,amountMinor:amount.toString(),reference,paidAt:paidAt.toISOString()};
      });
    },
    async payouts({labelIds,limit=500}) {
      return (await pool.query(`SELECT id,label_id AS "labelId",payee_id AS "payeeId",trim(currency) AS currency,amount_minor::text AS "amountMinor",reference,
paid_at AS "paidAt",recorded_by AS "recordedBy" FROM music_payouts WHERE label_id=ANY($1::text[]) ORDER BY paid_at DESC LIMIT $2`,[labelIds,limit])).rows
        .map(r=>({...r,paidAt:iso(r.paidAt)}));
    },
    async putBudget(raw,actor='system') {
      const b=normalizeBudget(raw);
      return transaction(async c=>{
        if (b.releaseId) requireThat((await c.query(`SELECT 1 FROM music_catalog WHERE label_id=$1 AND id=$2 AND kind='release'`,[b.labelId,b.releaseId])).rows.length,'releaseId must reference a release in the label',422);
        const prev=(await c.query('SELECT currency FROM music_budgets WHERE label_id=$1 AND id=$2',[b.labelId,b.id])).rows[0];
        requireThat(!prev || prev.currency.trim()===b.currency || !(await c.query('SELECT 1 FROM music_expenses WHERE label_id=$1 AND budget_id=$2 LIMIT 1',[b.labelId,b.id])).rows.length,
          'Budget currency cannot change after expenses are recorded',409);
        await c.query(`INSERT INTO music_budgets(label_id,id,name,period,category,currency,amount_minor,release_id,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
ON CONFLICT(label_id,id) DO UPDATE SET name=EXCLUDED.name,period=EXCLUDED.period,category=EXCLUDED.category,currency=EXCLUDED.currency,
amount_minor=EXCLUDED.amount_minor,release_id=EXCLUDED.release_id,updated_by=EXCLUDED.updated_by,updated_at=now()`,
          [b.labelId,b.id,b.name,b.period,b.category,b.currency,b.amountMinor,b.releaseId,actor]);
        await audit(c,actor,'budget.put',[b.labelId],{id:b.id,period:b.period});
        return b;
      });
    },
    async recordExpense(raw,actor='system') {
      const e=normalizeExpense(raw);
      return transaction(async c=>{
        const budget=(await c.query('SELECT currency FROM music_budgets WHERE label_id=$1 AND id=$2',[e.labelId,e.budgetId])).rows[0];
        requireThat(budget,'Unknown budget',404);
        requireThat(budget.currency.trim()===e.currency,'Expense currency must match the budget currency',422);
        const id=randomUUID();
        await c.query(`INSERT INTO music_expenses(id,label_id,budget_id,occurred_on,currency,amount_minor,description,vendor,recorded_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [id,e.labelId,e.budgetId,e.occurredOn,e.currency,e.amountMinor,e.description,e.vendor,actor]);
        await audit(c,actor,'budget.expense.recorded',[e.labelId],{budgetId:e.budgetId,amountMinor:e.amountMinor});
        return {id,...e};
      });
    },
    async budgets({labelIds,period=null}) {
      if (period!==null) normalizePeriod(period);
      const rows=(await pool.query(`SELECT b.label_id AS "labelId",b.id,b.name,b.period,b.category,trim(b.currency) AS currency,b.amount_minor::text AS "amountMinor",
b.release_id AS "releaseId",COALESCE(SUM(e.amount_minor),0)::text AS "spentMinor",COUNT(e.id)::integer AS expenses
FROM music_budgets b LEFT JOIN music_expenses e ON e.label_id=b.label_id AND e.budget_id=b.id
WHERE b.label_id=ANY($1::text[]) AND ($2::text IS NULL OR b.period=$2) GROUP BY b.label_id,b.id ORDER BY b.period DESC,b.label_id,b.id`,[labelIds,period])).rows;
      return rows.map(r=>{const amount=BigInt(r.amountMinor),spent=BigInt(r.spentMinor);
        return {...r,remainingMinor:(amount-spent).toString(),utilizationBps:Number(spent*10000n/amount),status:spent>amount ? 'over' : spent*10n>=amount*9n ? 'near-limit' : 'ok'};});
    },
    async expenses({labelIds,budgetId=null,limit=500}) {
      return (await pool.query(`SELECT id,label_id AS "labelId",budget_id AS "budgetId",to_char(occurred_on,'YYYY-MM-DD') AS "occurredOn",trim(currency) AS currency,
amount_minor::text AS "amountMinor",description,vendor,recorded_by AS "recordedBy" FROM music_expenses
WHERE label_id=ANY($1::text[]) AND ($2::text IS NULL OR budget_id=$2) ORDER BY occurred_on DESC,recorded_at DESC LIMIT $3`,[labelIds,budgetId,limit])).rows;
    }
  };
}
