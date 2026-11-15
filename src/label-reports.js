import {createHash} from 'node:crypto';
import {dedupedFacts} from './reporting-store.js';

/**
 * Label report payloads for the Command Center report modules (`/v1/labels/{labelId}/reports/{name}`).
 * Every value comes from stored facts, catalog, distributor statements or audit records. When the engine
 * holds no data for a report, it returns empty collections with status `awaiting-producer`; fields the
 * engine does not record are `null` ("not reported"), never estimated.
 */
export const SYSTEM='music-operations-engine';
export const REPORTS=['catalog','streams','sales','toolost','stems','trackzero','scenesignal','events','artist','health'];
const moduleId=/^[A-Za-z0-9_-]{8,128}$/;
/** Report modules accept 8–128 [A-Za-z0-9_-] identifiers; other engine ids map to a stable digest form. */
export function reportId(value) {
  const text=String(value);
  return moduleId.test(text) ? text : 'id_'+createHash('sha256').update(text).digest('hex').slice(0,40);
}
const slug=value=>{const s=String(value||'').toLowerCase().replace(/[^a-z0-9_-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,64);return s.length>=2 ? s : 'unspecified';};
const ms=value=>new Date(value).getTime();
const month=value=>new Date(value).toISOString().slice(0,7);
const source=(revision,observedAtMs,extra={})=>({system:SYSTEM,kind:'live',revision,observedAtMs,...extra});
const status=items=>items.length ? 'live' : 'awaiting-producer';
const MAX=10000;

export function labelReportStore(pool) {
  const q=async(sql,params)=>(await pool.query(sql,params)).rows;
  const reports={
    async catalog(labelId) {
      const rev=(await q(`SELECT COALESCE(MAX(id),0)::text AS id,MAX(created_at) AS at FROM music_audit WHERE action='catalog.put' AND $1=ANY(label_ids)`,[labelId]))[0];
      const revision=Number(rev.id),observedAtMs=rev.at ? ms(rev.at) : 0;
      const items=await q(`SELECT id,kind,name,release_id AS "releaseId",isrc,upc FROM music_catalog WHERE label_id=$1 AND kind IN ('release','track') ORDER BY name,id`,[labelId]);
      const releases=items.filter(i=>i.kind==='release').map(r=>({labelId,releaseId:reportId(r.id),catalogId:r.id,title:r.name,releaseDate:null,upc:r.upc||null,
        works:[],tracks:items.filter(t=>t.kind==='track' && t.releaseId===r.id).map(t=>({trackId:reportId(t.id),catalogId:t.id,title:t.name,isrc:t.isrc ? t.isrc.trim() : null,workIds:[]})),
        artworkUrl:null,source:source(revision,observedAtMs,{status:'live'})}));
      return {status:status(releases),releases,notReported:['releaseDate','works','artworkUrl']};
    },
    async streams(labelId,{sources}) {
      const rows=await q(`${dedupedFacts}
SELECT to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM') AS period,source,territory,SUM(quantity)::text AS streams,MAX(updated_at) AS at
FROM deduped WHERE type='stream' GROUP BY 1,2,3 ORDER BY 1 DESC,2,3`,[[labelId],sources,null,null]);
      const all=new Map(),records=[];
      for (const r of rows) {
        const platform=slug(r.source),at=ms(r.at),key=r.period+'\0'+platform;
        const total=all.get(key)||{period:r.period,platform,streams:0n,at:0};
        total.streams+=BigInt(r.streams);total.at=Math.max(total.at,at);all.set(key,total);
        if (/^[A-Z]{2}$/.test(r.territory || '')) records.push({labelId,period:r.period,country:r.territory,platform,streams:r.streams,source:source(at,at)});
      }
      for (const t of all.values()) records.push({labelId,period:t.period,country:'ALL',platform:t.platform,streams:t.streams.toString(),source:source(t.at,t.at)});
      return {status:status(records),records:records.slice(0,MAX),truncated:records.length>MAX};
    },
    async sales(labelId,{sources}) {
      const rows=await q(`SELECT id,type,occurred_at AS "occurredAt",amount_minor::text AS "amountMinor",currency,channel,territory,metadata,updated_at AS at
FROM music_facts WHERE label_id=$1 AND ($2::text[] IS NULL OR source=ANY($2)) AND type IN ('sale','refund') ORDER BY occurred_at DESC,id DESC LIMIT ${MAX+1}`,[labelId,sources]);
      const truncated=rows.length>MAX,facts=rows.slice(0,MAX).reverse();
      const orderOf=f=>typeof f.metadata?.orderId==='string' ? reportId(f.metadata.orderId) : reportId(f.id);
      const orders=new Map(),events=[],unattributed=new Map();
      const event=(f,kind)=>({labelId,eventId:reportId(f.id),orderId:orderOf(f),storefront:slug(f.channel),
        country:/^[A-Z]{2}$/.test(f.territory || '') ? f.territory : 'ZZ',currency:f.currency,period:month(f.occurredAt),kind,
        settlement:f.metadata?.settlement==='settled' ? 'settled' : 'pending',amountMinor:f.amountMinor,source:source(ms(f.at),ms(f.at))});
      for (const f of facts.filter(f=>f.type==='sale')) {
        const e=event(f,'sale');events.push(e);
        const o=orders.get(e.orderId)||{sale:0n,refund:0n,currency:e.currency,storefront:e.storefront,country:e.country};o.sale+=BigInt(e.amountMinor);orders.set(e.orderId,o);
      }
      for (const f of facts.filter(f=>f.type==='refund')) {
        const e=event(f,'refund'),o=typeof f.metadata?.orderId==='string' ? orders.get(e.orderId) : null;
        // A refund is attributed only to a reported sale of the same order and dimensions; others are totalled separately.
        if (o && o.currency===e.currency && o.storefront===e.storefront && o.country===e.country && o.refund+BigInt(e.amountMinor)<=o.sale) { o.refund+=BigInt(e.amountMinor);events.push(e); }
        else unattributed.set(e.currency,(unattributed.get(e.currency)||0n)+BigInt(e.amountMinor));
      }
      return {status:status(events),events,truncated,
        unattributedRefunds:[...unattributed].map(([currency,amount])=>({currency,amountMinor:amount.toString()})),
        notes:'Unknown territory is reported as ZZ, unknown storefront as unspecified; settlement is pending unless the source marked it settled.'};
    },
    async toolost(labelId) {
      const statements=await q(`SELECT s.source,s.statement_id AS "statementId",s.content_hash AS "contentHash",s.imported_at AS at FROM music_distributor_statements s
WHERE s.label_id=$1 AND lower(s.source)='toolost' ORDER BY s.imported_at DESC LIMIT 100`,[labelId]);
      const result=[];
      for (const s of statements) {
        const lines=await q(`SELECT id,release_id AS "releaseId",track_id AS "trackId",occurred_at AS "occurredAt",currency,net_minor::text AS net,reverses_external_id AS reverses
FROM music_distributor_rows WHERE label_id=$1 AND source=$2 AND statement_id=$3 ORDER BY occurred_at,id LIMIT ${MAX}`,[labelId,s.source,s.statementId]);
        const currencies=[...new Set(lines.map(l=>l.currency.trim()))];
        for (const currency of currencies) {
          const own=lines.filter(l=>l.currency.trim()===currency);
          const total=own.reduce((sum,l)=>sum+BigInt(l.net),0n);
          result.push({provider:'TooLost',labelId,statementId:reportId(currencies.length>1 ? s.statementId+'-'+currency : s.statementId),providerStatementId:s.statementId,
            period:month(own.reduce((min,l)=>new Date(l.occurredAt)<min ? new Date(l.occurredAt) : min,new Date(own[0].occurredAt))),currency,royaltiesMinor:total.toString(),
            lines:own.map(l=>({lineId:reportId(l.id),releaseId:reportId(l.releaseId),trackId:reportId(l.trackId),
              kind:l.reverses ? 'reversal' : BigInt(l.net)<0n ? 'adjustment' : 'royalty',units:null,royaltyMinor:l.net})),
            source:{system:'TooLost',kind:'live',revision:ms(s.at),observedAtMs:ms(s.at),documentSha256:s.contentHash,documentHashBasis:'normalized-rows'}});
        }
      }
      return {status:status(result),statements:result,notReported:['units']};
    },
    async scenesignal(labelId) {
      const rows=await q(`${dedupedFacts}
SELECT metadata->'scene'->>'sessionId' AS session,MIN(occurred_at) AS started,MAX(updated_at) AS at,
SUM(quantity) FILTER(WHERE type='attendance')::text AS attendance,
COUNT(*) FILTER(WHERE type='play' AND metadata->'scene' ? 'musicMs')::text AS plays,
COUNT(*) FILTER(WHERE type='sale')::text AS sales,SUM(amount_minor) FILTER(WHERE type='sale')::text AS amount,
COUNT(DISTINCT currency) FILTER(WHERE type='sale')::integer AS currencies,MIN(currency) FILTER(WHERE type='sale') AS currency
FROM deduped WHERE metadata->'scene'->>'sessionId' IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 1000`,[[labelId],['scenesignal'],null,null]);
      const sessions=rows.map(r=>{const at=ms(r.at);return {labelId,sessionId:reportId(r.session),eventId:null,startedAt:new Date(r.started).toISOString(),status:null,
        attendance:r.attendance || '0',engagements:r.plays,commerceTransactions:r.sales,
        commerceMinor:r.currencies>1 ? null : (r.amount || '0'),currency:r.currencies===1 ? r.currency.trim() : 'XXX',source:{system:'SceneSignal',kind:'live',revision:at,observedAtMs:at}};});
      return {status:status(sessions),sessions,notReported:['eventId','status'],notes:'engagements counts music plays; commerceMinor is null when a session mixes currencies.'};
    },
    async health(labelId,{sources}) {
      const rows=await q(`SELECT source,COUNT(*)::text AS records,MAX(updated_at) AS at FROM music_facts WHERE label_id=$1 AND ($2::text[] IS NULL OR source=ANY($2)) GROUP BY source ORDER BY source`,[labelId,sources]);
      const observations=rows.map(r=>({labelId,sourceId:slug(r.source),metricId:'records',accessVerified:true,kind:'live',valueDecimal:r.records,revision:ms(r.at),observedAtMs:ms(r.at),maxAgeMs:48*3600000}));
      return {status:status(observations),observations};
    },
    async stems() { return {status:'awaiting-producer',receipts:[],reason:'No Stems White Label integration has delivered receipts (MOE-010).'}; },
    async events() { return {status:'awaiting-producer',events:[],reason:'No publish-approved public calendar source is connected.'}; },
    async artist() { return {status:'awaiting-producer',artistId:null,statements:[],reason:'Royalty split allocations are not implemented (MOE-013).'}; },
    async trackzero() { return {status:'not-applicable',creatorId:null,events:[],reason:'Creator contribution views require a creator-scoped identity; label sessions use the aggregate TrackZero summary.'}; }
  };
  return {
    async labelReport(name,labelId,{sources=null}={}) {
      const body=await reports[name](labelId,{sources});
      return {labelId,report:name,generatedAt:new Date().toISOString(),...body};
    }
  };
}
