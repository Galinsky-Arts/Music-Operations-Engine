import {createHash} from 'node:crypto';
import {parseCsv,normalizeFact} from './core.js';
import {requireThat} from './errors.js';
import {currencyExponent,minorUnits} from './distributor.js';

/**
 * Provider report presets. Each provider can be fed today by uploading its exported report (CSV) through
 * POST /v1/imports. Header matching is case/space-insensitive against the alias lists; a caller can override
 * any field with an explicit `mapping` of field → column header. Live API pulls exist only where the provider
 * offers an authorized reporting API, and stay OFF until credentials and PROVIDER_LIVE_PULLS are configured.
 */
export const PROVIDERS=Object.freeze({
  spotify:{name:'Spotify for Artists',factType:'stream',channel:'spotify',
    columns:{date:['date','day','period'],quantity:['streams','stream count','plays'],track:['song','track','title','song title','track name'],
      isrc:['isrc'],territory:['country','territory','country code'],release:['release','album']},
    liveApi:{available:false,reason:'Spotify for Artists has no public reporting API. Export the CSV from Spotify for Artists (Music → Songs/Timeline → download) and upload it.'}},
  apple:{name:'Apple Music for Artists',factType:'stream',channel:'apple-music',
    columns:{date:['date','day'],quantity:['plays','streams','play count'],track:['song','song name','track','title'],isrc:['isrc'],
      territory:['country','territory','storefront'],release:['album','release']},
    liveApi:{available:false,reason:'Apple Music for Artists offers no public reporting API. Export the CSV from Apple Music for Artists and upload it.'}},
  youtube:{name:'YouTube',factType:'stream',channel:'youtube',
    columns:{date:['date','day'],quantity:['views','plays','streams'],track:['video title','title','asset title','track'],isrc:['isrc'],
      territory:['country','geography','territory'],release:['album','release'],externalRef:['video','video id','content','asset id']},
    liveApi:{available:true,requires:['CONNECTOR_MASTER_KEY','PROVIDER_LIVE_PULLS includes youtube','stored OAuth credential (clientId, clientSecret, refreshToken) for the label youtube connector'],
      reason:'YouTube Analytics API v2 (reports.query, channel==MINE, metrics=views, dimensions=day,video).'}},
  stems:{name:'Stems White Label',factType:null,channel:'stems',
    columns:{date:['date','order date','created at','created_at'],amount:['amount','total','net','price'],currency:['currency'],type:['type','kind','transaction type'],
      track:['product','item','track','title'],isrc:['isrc'],territory:['country','territory'],externalRef:['order id','order_id','transaction id','id'],quantity:['quantity','units','qty']},
    liveApi:{available:false,reason:'The Stems reporting API contract is not published yet. Export orders/licences as CSV from the Stems admin and upload them.'}},
  toolost:{name:'TooLost',distributor:true,
    columns:{externalId:['transaction id','id','line id','reference'],occurredAt:['date','sale date','period date','reporting date'],isrc:['isrc'],upc:['upc'],
      currency:['currency'],gross:['gross','gross revenue','gross amount'],fees:['fees','fee','distribution fee'],net:['net','net revenue','earnings','royalty'],
      payoutStatus:['status','payout status'],settlementId:['settlement id','payment id','payout id'],reversesExternalId:['reverses','reverses id','original transaction id']},
    liveApi:{available:false,reason:'TooLost offers no public statement API. Download the statement CSV from TooLost and upload it (ISRCs must be mapped in the catalog).'}},
  manual:{name:'Engine CSV (manual)',factType:null,channel:'',columns:{},
    liveApi:{available:false,reason:'Manual uploads use the engine fact columns: externalId,type,occurredAt,quantity,amountMinor,currency,artist,release,track,isrc,territory.'}}
});

const norm=s=>String(s).trim().toLowerCase().replace(/[\s_]+/g,' ');
export function resolveColumns(provider,headers,override={}) {
  const preset=PROVIDERS[provider];
  const byNorm=new Map(headers.map(h=>[norm(h),h]));
  const out={};
  for (const [field,aliases] of Object.entries(preset.columns)) {
    if (override[field]!==undefined) { requireThat(headers.includes(override[field]),'Mapped column "'+String(override[field]).slice(0,80)+'" is not in the file',422);out[field]=override[field];continue; }
    const hit=aliases.map(a=>byNorm.get(norm(a))).find(Boolean);
    if (hit) out[field]=hit;
  }
  return out;
}
function decimalMinor(value,currency) {
  const exp=currencyExponent.get(currency);
  requireThat(exp!==undefined,'Unsupported currency '+currency);
  const cleaned=String(value).trim().replace(/^\$/,'').replace(/,/g,'');
  return minorUnits(cleaned,'amount',exp);
}
function day(value) {
  const text=String(value||'').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0,10);
  const us=/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  if (us) return us[3]+'-'+us[1].padStart(2,'0')+'-'+us[2].padStart(2,'0');
  if (/^\d{4}-\d{2}$/.test(text)) return text+'-01';
  return text;
}

/**
 * Parse an exported provider report into engine facts. Rows that fail validation are reported with their
 * row number and are not ingested; valid rows are. External ids are content-derived, so re-uploading the
 * same export is idempotent.
 */
export function parseProviderReport({provider,csv,labelId,mapping={}}) {
  requireThat(Object.hasOwn(PROVIDERS,provider) && !PROVIDERS[provider].distributor,'Unknown provider for fact import',400);
  requireThat(typeof csv==='string' && csv.length>0,'CSV text is required',400);
  requireThat(mapping && typeof mapping==='object' && !Array.isArray(mapping),'mapping must be an object',400);
  const rows=parseCsv(csv.replace(/^\uFEFF/,''));
  requireThat(rows.length>0,'The file has no data rows',422);
  requireThat(rows.length<=50000,'Upload up to 50,000 rows per file',413);
  const preset=PROVIDERS[provider];
  if (provider==='manual') {
    const facts=[],errors=[];
    rows.forEach((row,i)=>{try{facts.push(normalizeFact(row,'manual',{labelId}));}catch(e){errors.push({row:i+2,error:e.message});}});
    return {facts,errors,columns:Object.keys(rows[0])};
  }
  const headers=Object.keys(rows[0]);
  const cols=resolveColumns(provider,headers,mapping);
  const required=preset.factType==='stream' ? ['date','quantity'] : ['date','amount','currency'];
  for (const f of required) requireThat(cols[f],'Could not find a "'+f+'" column. Columns found: '+headers.slice(0,30).join(', ')+'. Supply mapping.'+f,422);
  const facts=[],errors=[],seen=new Map();
  rows.forEach((row,i)=>{
    try {
      const pick=f=>cols[f] ? String(row[cols[f]] ?? '').trim() : '';
      const base={occurredAt:day(pick('date')),track:pick('track').slice(0,200),release:pick('release').slice(0,200),channel:preset.channel,
        territory:/^[A-Za-z]{2}$/.test(pick('territory')) ? pick('territory').toUpperCase() : '',isrc:pick('isrc') || undefined,
        metadata:{import:provider}};
      let fact;
      if (preset.factType==='stream') {
        const q=pick('quantity').replace(/,/g,'');
        requireThat(/^\d+$/.test(q),'quantity must be a whole number');
        fact={...base,type:'stream',quantity:q};
      } else {
        const currency=pick('currency').toUpperCase() || 'USD';
        const minor=BigInt(decimalMinor(pick('amount'),currency));
        const kind=pick('type').toLowerCase();
        const refund=/refund|chargeback|reversal/.test(kind) || minor<0n;
        const q=pick('quantity').replace(/,/g,'');
        fact={...base,type:refund ? 'refund' : 'sale',amountMinor:(minor<0n ? -minor : minor).toString(),currency,quantity:/^\d+$/.test(q) ? q : '1',
          metadata:{import:provider,kind:kind || (refund ? 'refund' : 'sale'),...(pick('externalRef') ? {orderId:pick('externalRef')} : {}),settlement:'pending'}};
      }
      const identity=JSON.stringify([provider,headers.map(h=>row[h])]);
      const n=(seen.get(identity) || 0)+1;seen.set(identity,n);
      fact.externalId=provider+':'+createHash('sha256').update(identity+'\0'+n).digest('hex').slice(0,40);
      facts.push(normalizeFact(fact,provider,{labelId}));
    } catch(e) { errors.push({row:i+2,error:e.message}); }
  });
  return {facts,errors,columns:headers,mapping:cols};
}

export function toolostMapping(headers,override={}) {
  const cols=resolveColumns('toolost',headers,override);
  for (const f of ['externalId','occurredAt','isrc','currency','gross','fees','net','payoutStatus'])
    requireThat(cols[f],'Could not find a TooLost "'+f+'" column. Columns found: '+headers.slice(0,30).join(', ')+'. Supply mapping.'+f,422);
  return cols;
}

/** Configuration status for every provider: what is on, and what to set to enable live pulls. */
export function providerStatus(env=process.env) {
  const live=new Set(String(env.PROVIDER_LIVE_PULLS || '').split(',').map(s=>s.trim()).filter(Boolean));
  return Object.entries(PROVIDERS).map(([id,p])=>({id,name:p.name,csvImport:true,
    liveApi:{available:p.liveApi.available,enabled:p.liveApi.available && live.has(id) && Boolean(env.CONNECTOR_MASTER_KEY),
      reason:p.liveApi.reason,requires:p.liveApi.requires || []},
    columns:p.columns}));
}

/** YouTube Analytics live pull (OFF until enabled). Returns normalized stream facts for [startDate,endDate]. */
export async function pullYouTube({credential,labelId,startDate,endDate,fetchImpl=fetch}) {
  let c;try{c=JSON.parse(credential);}catch{throw new Error('youtube credential must be JSON');}
  requireThat(c && c.clientId && c.clientSecret && c.refreshToken,'youtube credential requires clientId, clientSecret and refreshToken');
  const token=await fetchImpl('https://oauth2.googleapis.com/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({client_id:c.clientId,client_secret:c.clientSecret,refresh_token:c.refreshToken,grant_type:'refresh_token'}),signal:AbortSignal.timeout(15000)});
  if (!token.ok) throw Object.assign(new Error('youtube token refresh failed'),{code:'auth_failed',status:token.status});
  const {access_token:accessToken}=await token.json();
  const url=new URL('https://youtubeanalytics.googleapis.com/v2/reports');
  url.search=new URLSearchParams({ids:'channel==MINE',startDate,endDate,metrics:'views',dimensions:'day,video',maxResults:'200',sort:'day'}).toString();
  const res=await fetchImpl(url,{headers:{authorization:'Bearer '+accessToken,accept:'application/json'},signal:AbortSignal.timeout(30000)});
  if (!res.ok) throw Object.assign(new Error('youtube report failed'),{code:'report_failed',status:res.status});
  const body=await res.json();
  const idx=Object.fromEntries((body.columnHeaders || []).map((h,i)=>[h.name,i]));
  return (body.rows || []).map(r=>normalizeFact({externalId:'yt:'+r[idx.day]+':'+r[idx.video],type:'stream',occurredAt:r[idx.day],quantity:String(r[idx.views]),
    channel:'youtube',track:'YouTube video '+r[idx.video],metadata:{import:'youtube-api',videoId:r[idx.video]}},'youtube',{labelId}));
}
