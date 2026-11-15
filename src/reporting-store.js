import {ApiError,requireThat} from './errors.js';
import {exact} from './validation.js';
import {canonicalIsrc} from './catalog.js';

const factFields=`id,label_id AS "labelId",source,external_id AS "externalId",type,occurred_at AS "occurredAt",
quantity::text,amount_minor::text AS "amountMinor",currency,artist,release_title AS release,track,channel,territory,
artist_id AS "artistId",release_id AS "releaseId",track_id AS "trackId",isrc,metadata`;

/** Opaque keyset cursors: base64url JSON arrays, validated on read. */
export function encodeCursor(values) { return Buffer.from(JSON.stringify(values)).toString('base64url'); }
export function decodeCursor(cursor,length) {
  if (cursor===null || cursor===undefined) return null;
  requireThat(typeof cursor==='string' && cursor.length<=1024 && /^[A-Za-z0-9_-]+$/.test(cursor),'Invalid cursor',400);
  let values;
  try { values=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8')); } catch { throw new ApiError(400,'Invalid cursor'); }
  requireThat(Array.isArray(values) && values.length===length && values.every(v=>typeof v==='string' && v.length<=512),'Invalid cursor',400);
  return values;
}
export function pageLimit(limit,{max=1000,fallback=100}={}) {
  const value=limit===undefined || limit===null ? fallback : limit;
  requireThat(Number.isInteger(value) && value>=1 && value<=max,'limit must be 1–'+max,400);
  return value;
}
const iso=v=>v===null || v===undefined ? null : new Date(v).toISOString();
const factRow=r=>({...r,quantity:exact(r.quantity),amountMinor:exact(r.amountMinor),occurredAt:iso(r.occurredAt),isrc:r.isrc ? r.isrc.trim() : null});

// Shared logical activities (one physical measurement reported for several labels/sources) count once,
// at their first (occurred_at,id) occurrence, matching the streaming summary in core.js.
const dedupedFacts=`WITH scoped AS (
  SELECT * FROM music_facts WHERE label_id=ANY($1::text[]) AND ($2::text[] IS NULL OR source=ANY($2))
    AND ($3::timestamptz IS NULL OR occurred_at>=$3) AND ($4::timestamptz IS NULL OR occurred_at<$4)
), deduped AS (
  SELECT DISTINCT ON (source,COALESCE(metadata->>'logicalActivityId','fact:'||id)) *
  FROM scoped ORDER BY source,COALESCE(metadata->>'logicalActivityId','fact:'||id),occurred_at,id
)`;

export function reportingStore(pool) {
  return {
    async catalogPage({labelIds,kind=null,limit,cursor=null}) {
      requireThat(Array.isArray(labelIds),'Catalog requires an explicit label scope');
      requireThat(kind===null || ['artist','release','track'].includes(kind),'Invalid catalog kind',400);
      const size=pageLimit(limit),after=decodeCursor(cursor,2);
      const rows=(await pool.query(`SELECT id,label_id AS "labelId",kind,name,artist_id AS "artistId",release_id AS "releaseId",isrc,upc
FROM music_catalog WHERE label_id=ANY($1::text[]) AND ($2::text IS NULL OR kind=$2)
AND ($3::text IS NULL OR (label_id,id)>($3::text,$4::text)) ORDER BY label_id,id LIMIT $5`,
        [labelIds,kind,after?.[0] ?? null,after?.[1] ?? null,size+1])).rows;
      const more=rows.length>size,items=rows.slice(0,size);
      return {items,nextCursor:more ? encodeCursor([items.at(-1).labelId,items.at(-1).id]) : null};
    },
    async factsPage({labelIds,sources=null,from=null,to=null,limit,cursor=null}) {
      requireThat(Array.isArray(labelIds),'Reporting requires an explicit label scope');
      const size=pageLimit(limit),after=decodeCursor(cursor,2);
      if (after) requireThat(!Number.isNaN(Date.parse(after[0])),'Invalid cursor',400);
      const rows=(await pool.query(`SELECT ${factFields} FROM music_facts WHERE label_id=ANY($1::text[])
AND ($2::text[] IS NULL OR source=ANY($2)) AND ($3::timestamptz IS NULL OR occurred_at>=$3) AND ($4::timestamptz IS NULL OR occurred_at<$4)
AND ($5::timestamptz IS NULL OR (occurred_at,id)>($5::timestamptz,$6::text)) ORDER BY occurred_at,id LIMIT $7`,
        [labelIds,sources,from,to,after?.[0] ?? null,after?.[1] ?? null,size+1])).rows.map(factRow);
      const more=rows.length>size,facts=rows.slice(0,size);
      return {facts,nextCursor:more ? encodeCursor([facts.at(-1).occurredAt,facts.at(-1).id]) : null};
    },
    async dailyRollups({labelIds,sources=null,from=null,to=null,limit,cursor=null}) {
      requireThat(Array.isArray(labelIds),'Reporting requires an explicit label scope');
      const size=pageLimit(limit,{max:5000,fallback:1000}),after=decodeCursor(cursor,5);
      const rows=(await pool.query(`${dedupedFacts}, grouped AS (
  SELECT to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD') AS date,label_id AS "labelId",source,type,currency,
    COUNT(*)::text AS facts,SUM(quantity)::text AS quantity,SUM(amount_minor)::text AS "amountMinor"
  FROM deduped GROUP BY 1,2,3,4,5
)
SELECT * FROM grouped WHERE ($5::text IS NULL OR (date,"labelId",source,type,currency)>($5::text,$6::text,$7::text,$8::text,$9::text))
ORDER BY date,"labelId",source,type,currency LIMIT $10`,
        [labelIds,sources,from,to,...(after ?? [null,null,null,null,null]),size+1])).rows
        .map(r=>({...r,facts:exact(r.facts),quantity:exact(r.quantity),amountMinor:exact(r.amountMinor)}));
      const more=rows.length>size,rollups=rows.slice(0,size);
      const last=rollups.at(-1);
      return {rollups,nextCursor:more ? encodeCursor([last.date,last.labelId,last.source,last.type,last.currency]) : null};
    },
    async catalogByIsrc({labelIds,isrc}) {
      const code=canonicalIsrc(isrc);
      const tracks=(await pool.query(`SELECT t.label_id AS "labelId",t.id AS "trackId",t.name AS track,t.isrc,
r.id AS "releaseId",r.name AS release,r.upc,a.id AS "artistId",a.name AS artist
FROM music_catalog t LEFT JOIN music_catalog r ON r.label_id=t.label_id AND r.id=t.release_id
LEFT JOIN music_catalog a ON a.label_id=t.label_id AND a.id=t.artist_id
WHERE t.kind='track' AND t.isrc=$1 AND t.label_id=ANY($2::text[]) ORDER BY t.label_id,t.id`,[code,labelIds])).rows;
      const facts=(await pool.query(`SELECT label_id AS "labelId",COUNT(*)::text AS facts,COUNT(*) FILTER(WHERE track_id IS NULL)::text AS unmapped
FROM music_facts WHERE isrc=$1 AND label_id=ANY($2::text[]) GROUP BY label_id ORDER BY label_id`,[code,labelIds])).rows
        .map(r=>({...r,facts:exact(r.facts),unmapped:exact(r.unmapped)}));
      return {isrc:code,tracks,facts};
    },
    async unmappedIsrcs({labelIds,sources=null,limit}) {
      const size=pageLimit(limit,{max:1000,fallback:100});
      return (await pool.query(`SELECT label_id AS "labelId",isrc,COUNT(*)::text AS facts,MIN(occurred_at) AS "firstSeenAt",MAX(occurred_at) AS "lastSeenAt",
array_agg(DISTINCT source ORDER BY source) AS sources
FROM music_facts WHERE label_id=ANY($1::text[]) AND ($2::text[] IS NULL OR source=ANY($2)) AND isrc IS NOT NULL AND track_id IS NULL
GROUP BY label_id,isrc ORDER BY COUNT(*) DESC,label_id,isrc LIMIT $3`,[labelIds,sources,size])).rows
        .map(r=>({...r,isrc:r.isrc.trim(),facts:exact(r.facts),firstSeenAt:iso(r.firstSeenAt),lastSeenAt:iso(r.lastSeenAt)}));
    },
    async alertInputs({labelIds,sources=null,now,days=15}) {
      const end=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()));
      const start=new Date(end.getTime()-days*86400000);
      const freshness=(await pool.query(`SELECT label_id AS "labelId",source,MAX(updated_at) AS "lastIngestedAt",COUNT(*)::text AS records
FROM music_facts WHERE label_id=ANY($1::text[]) AND ($2::text[] IS NULL OR source=ANY($2)) GROUP BY label_id,source ORDER BY label_id,source`,[labelIds,sources])).rows
        .map(r=>({...r,lastIngestedAt:iso(r.lastIngestedAt),records:exact(r.records)}));
      const jobs=(await pool.query(`SELECT label_id AS "labelId",source,
COUNT(*) FILTER(WHERE status='dead_letter')::integer AS "deadLetter",
COUNT(*) FILTER(WHERE status IN ('queued','retry'))::integer AS backlog,
MIN(available_at) FILTER(WHERE status IN ('queued','retry')) AS "oldestReadyAt"
FROM music_jobs WHERE label_id=ANY($1::text[]) AND ($2::text[] IS NULL OR source=ANY($2)) GROUP BY label_id,source ORDER BY label_id,source`,[labelIds,sources])).rows
        .map(r=>({...r,oldestReadyAt:iso(r.oldestReadyAt)}));
      const daily=(await pool.query(`${dedupedFacts}
SELECT to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD') AS date,label_id AS "labelId",source,type,SUM(quantity)::text AS quantity
FROM deduped GROUP BY 1,2,3,4 ORDER BY 1,2,3,4`,[labelIds,sources,start.toISOString(),end.toISOString()])).rows
        .map(r=>({...r,quantity:BigInt(r.quantity)}));
      return {freshness,jobs,daily,window:{from:start.toISOString(),to:end.toISOString()}};
    }
  };
}
