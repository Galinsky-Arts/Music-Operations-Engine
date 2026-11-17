import {createHash} from 'node:crypto';
import {ApiError,requireThat} from './errors.js';
import {exact,identifier} from './validation.js';
import {dedupedFacts,decodeCursor,encodeCursor,pageLimit} from './reporting-store.js';
import {passwordDigest} from './accounts.js';

const iso=v=>v ? new Date(v).toISOString() : null;
const roles={tenant_admin:['read','ingest','manage'],label_manager:['read','ingest'],team_member:['read'],artist:['read']};
export function alertFingerprint(a) {
  return createHash('sha256').update([a.type,a.labelId,a.source,a.metric || '',a.budgetId || ''].join('\0')).digest('hex');
}
const midnight=v=>v===null || v===undefined || /T00:00:00\.000Z$/.test(v);

/**
 * Stored (materialized) daily rollups, persisted alert feed, import history and account administration.
 * Stored rollups are per label; the in-process worker refreshes a label whenever its fact watermark changes.
 */
export function opsStore(pool,transaction,audit) {
  async function rollupFreshness(labelId,q=pool) {
    return (await q.query(`SELECT s.watermark,s.fact_count::text AS "factCount",s.refreshed_at AS "refreshedAt",x.w AS current,x.c::text AS "currentCount"
FROM (SELECT MAX(updated_at) AS w,COUNT(*) AS c FROM music_facts WHERE label_id=$1) x
LEFT JOIN music_rollup_state s ON s.label_id=$1`,[labelId])).rows[0];
  }
  const fresh=f=>f && f.refreshedAt && f.factCount===f.currentCount && iso(f.watermark)===iso(f.current);
  return {
    async refreshRollups(labelId,now=new Date()) {
      identifier(labelId,'labelId');
      return transaction(async c=>{
        await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',['rollup:'+labelId]);
        const state=await rollupFreshness(labelId,c);
        await c.query('DELETE FROM music_rollup_daily WHERE label_id=$1',[labelId]);
        const inserted=await c.query(`${dedupedFacts}
INSERT INTO music_rollup_daily(label_id,date,source,type,currency,facts,quantity,amount_minor)
SELECT label_id,to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD'),source,type,currency,COUNT(*),SUM(quantity),SUM(amount_minor)
FROM deduped GROUP BY 1,2,3,4,5`,[[labelId],null,null,null]);
        await c.query(`INSERT INTO music_rollup_state(label_id,watermark,fact_count,refreshed_at) VALUES($1,$2,$3,$4)
ON CONFLICT(label_id) DO UPDATE SET watermark=EXCLUDED.watermark,fact_count=EXCLUDED.fact_count,refreshed_at=EXCLUDED.refreshed_at`,
          [labelId,state.current,state.currentCount,now]);
        return {labelId,rows:inserted.rowCount ?? null,refreshedAt:now.toISOString()};
      });
    },
    async staleRollupLabels() {
      return (await pool.query(`SELECT l.id FROM music_labels l LEFT JOIN music_rollup_state s ON s.label_id=l.id
LEFT JOIN LATERAL (SELECT MAX(updated_at) AS w,COUNT(*) AS c FROM music_facts f WHERE f.label_id=l.id) x ON true
WHERE s.label_id IS NULL OR s.watermark IS DISTINCT FROM x.w OR s.fact_count<>x.c ORDER BY l.id`)).rows.map(r=>r.id);
    },
    async rollupStatus({labelIds}) {
      const out=[];
      for (const labelId of labelIds) {
        const f=await rollupFreshness(labelId);
        out.push({labelId,refreshedAt:iso(f?.refreshedAt),fresh:Boolean(fresh(f)),facts:exact(f?.currentCount || 0)});
      }
      return out;
    },
    /** Serve a single-label daily rollup page from the stored table when it is current; otherwise return null. */
    async storedDailyRollups({labelIds,sources=null,from=null,to=null,limit,cursor=null}) {
      if (labelIds.length!==1 || !midnight(from) || !midnight(to)) return null;
      const f=await rollupFreshness(labelIds[0]);
      if (!fresh(f)) return null;
      const size=pageLimit(limit,{max:5000,fallback:1000}),after=decodeCursor(cursor,5);
      const day=v=>v ? v.slice(0,10) : null;
      const rows=(await pool.query(`SELECT date,label_id AS "labelId",source,type,trim(currency) AS currency,facts::text,quantity::text,amount_minor::text AS "amountMinor"
FROM music_rollup_daily WHERE label_id=$1 AND ($2::text[] IS NULL OR source=ANY($2)) AND ($3::text IS NULL OR date>=$3) AND ($4::text IS NULL OR date<$4)
AND ($5::text IS NULL OR (date,label_id,source,type,currency)>($5::text,$6::text,$7::text,$8::text,$9::bpchar))
ORDER BY date,label_id,source,type,currency LIMIT $10`,[labelIds[0],sources,day(from),day(to),...(after ?? [null,null,null,null,null]),size+1])).rows
        .map(r=>({...r,facts:exact(r.facts),quantity:exact(r.quantity),amountMinor:exact(r.amountMinor)}));
      const more=rows.length>size,rollups=rows.slice(0,size),last=rollups.at(-1);
      return {rollups,nextCursor:more ? encodeCursor([last.date,last.labelId,last.source,last.type,last.currency]) : null,
        materialized:true,refreshedAt:iso(f.refreshedAt)};
    },
    /** Persist evaluated alerts: open new ones, refresh existing ones, resolve those no longer present. */
    async syncAlerts(alerts,now=new Date()) {
      return transaction(async c=>{
        const opened=[],escalated=[];
        const seen=new Set();
        for (const a of alerts) {
          const fp=alertFingerprint(a);seen.add(fp);
          const prev=(await c.query('SELECT severity,resolved_at FROM music_alert_events WHERE fingerprint=$1',[fp])).rows[0];
          const details={observed:a.observed ?? null,expected:a.expected ?? null,metric:a.metric ?? null,budgetId:a.budgetId ?? null};
          if (!prev || prev.resolved_at) {
            await c.query(`INSERT INTO music_alert_events(fingerprint,label_id,source,type,severity,message,details,first_seen_at,last_seen_at)
VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8) ON CONFLICT(fingerprint) DO UPDATE SET severity=EXCLUDED.severity,message=EXCLUDED.message,details=EXCLUDED.details,
first_seen_at=EXCLUDED.first_seen_at,last_seen_at=EXCLUDED.last_seen_at,resolved_at=NULL,acknowledged_at=NULL,acknowledged_by=NULL,delivered_at=NULL,delivery_error=NULL`,
              [fp,a.labelId,a.source,a.type,a.severity,a.message,JSON.stringify(details),now]);
            opened.push({fingerprint:fp,...a});
          } else {
            await c.query('UPDATE music_alert_events SET severity=$2,message=$3,details=$4,last_seen_at=$5 WHERE fingerprint=$1',[fp,a.severity,a.message,JSON.stringify(details),now]);
            if (prev.severity!=='critical' && a.severity==='critical') escalated.push({fingerprint:fp,...a});
          }
        }
        const open=(await c.query('SELECT fingerprint FROM music_alert_events WHERE resolved_at IS NULL')).rows.map(r=>r.fingerprint.trim());
        const gone=open.filter(fp=>!seen.has(fp));
        if (gone.length) await c.query('UPDATE music_alert_events SET resolved_at=$2 WHERE fingerprint=ANY($1::bpchar[])',[gone,now]);
        return {opened,escalated,resolved:gone.length};
      });
    },
    async markAlertDelivery(fingerprint,{error=null,now=new Date()}={}) {
      await pool.query('UPDATE music_alert_events SET delivered_at=CASE WHEN $2::text IS NULL THEN $3::timestamptz ELSE delivered_at END,delivery_error=$2 WHERE fingerprint=$1',[fingerprint,error,now]);
    },
    async alertFeed({labelIds,status='open',limit=200}) {
      requireThat(['open','all','acknowledged','resolved'].includes(status),'Invalid alert status filter',400);
      const rows=(await pool.query(`SELECT fingerprint,label_id AS "labelId",source,type,severity,message,details,first_seen_at AS "firstSeenAt",last_seen_at AS "lastSeenAt",
resolved_at AS "resolvedAt",acknowledged_at AS "acknowledgedAt",acknowledged_by AS "acknowledgedBy",delivered_at AS "deliveredAt",delivery_error AS "deliveryError"
FROM music_alert_events WHERE label_id=ANY($1::text[])
AND ($2='all' OR ($2='open' AND resolved_at IS NULL) OR ($2='acknowledged' AND acknowledged_at IS NOT NULL AND resolved_at IS NULL) OR ($2='resolved' AND resolved_at IS NOT NULL))
ORDER BY resolved_at IS NULL DESC,CASE severity WHEN 'critical' THEN 0 ELSE 1 END,last_seen_at DESC LIMIT $3`,[labelIds,status,limit])).rows;
      return rows.map(r=>({...r,fingerprint:r.fingerprint.trim(),firstSeenAt:iso(r.firstSeenAt),lastSeenAt:iso(r.lastSeenAt),resolvedAt:iso(r.resolvedAt),
        acknowledgedAt:iso(r.acknowledgedAt),deliveredAt:iso(r.deliveredAt)}));
    },
    async acknowledgeAlert(fingerprint,labelIds,actor='system') {
      requireThat(typeof fingerprint==='string' && /^[0-9a-f]{64}$/.test(fingerprint),'Invalid alert id',400);
      return transaction(async c=>{
        const r=await c.query(`UPDATE music_alert_events SET acknowledged_at=now(),acknowledged_by=$3 WHERE fingerprint=$1 AND label_id=ANY($2::text[]) RETURNING label_id`,[fingerprint,labelIds,actor]);
        requireThat(r.rows.length,'Alert not found',404);
        await audit(c,actor,'alert.acknowledged',[r.rows[0].label_id],{fingerprint});
        return {fingerprint,acknowledged:true};
      });
    },
    async recordImport(entry) {
      await pool.query(`INSERT INTO music_imports(id,label_id,provider,file_name,content_hash,row_count,accepted,rejected,errors,status,imported_by)
VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[entry.id,entry.labelId,entry.provider,entry.fileName,entry.contentHash,entry.rowCount,entry.accepted,entry.rejected,
        JSON.stringify(entry.errors.slice(0,100)),entry.status,entry.importedBy]);
    },
    async imports({labelIds,limit=100}) {
      return (await pool.query(`SELECT id,label_id AS "labelId",provider,file_name AS "fileName",row_count AS "rowCount",accepted,rejected,errors,status,
imported_by AS "importedBy",imported_at AS "importedAt" FROM music_imports WHERE label_id=ANY($1::text[]) ORDER BY imported_at DESC LIMIT $2`,[labelIds,limit])).rows
        .map(r=>({...r,importedAt:iso(r.importedAt)}));
    },
    async accounts() {
      return (await pool.query(`SELECT id,email,display_name AS "displayName",role,label_ids AS "labelIds",disabled_at AS "disabledAt",created_at AS "createdAt",updated_at AS "updatedAt"
FROM music_accounts ORDER BY email`)).rows.map(r=>({...r,disabled:Boolean(r.disabledAt),disabledAt:iso(r.disabledAt),createdAt:iso(r.createdAt),updatedAt:iso(r.updatedAt),permissions:roles[r.role]}));
    },
    async accountById(id) {
      const r=(await pool.query(`SELECT id,email,display_name AS "displayName",role,label_ids AS "labelIds",disabled_at AS "disabledAt" FROM music_accounts WHERE id=$1`,[id])).rows[0];
      return r ? {...r,disabled:Boolean(r.disabledAt),disabledAt:iso(r.disabledAt),permissions:roles[r.role]} : null;
    },
    async updateAccount(id,raw,actor='system') {
      requireThat(typeof id==='string' && id.length<=64,'Invalid account id',400);
      requireThat(raw && typeof raw==='object' && !Array.isArray(raw),'Account update must be an object',400);
      return transaction(async c=>{
        const cur=(await c.query('SELECT role,label_ids AS "labelIds" FROM music_accounts WHERE id=$1 FOR UPDATE',[id])).rows[0];
        if (!cur) throw new ApiError(404,'Account not found');
        const role=raw.role ?? cur.role;
        requireThat(Object.hasOwn(roles,role),'Invalid account role',400);
        let labelIds=raw.labelIds ?? (role==='tenant_admin' ? ['*'] : cur.labelIds);
        requireThat(Array.isArray(labelIds),'labelIds must be an array',400);
        labelIds=[...new Set(labelIds)];
        if (role==='tenant_admin') labelIds=['*'];
        else {
          requireThat(labelIds.length>0 && labelIds.length<=1000 && !labelIds.includes('*'),'Scoped roles require 1–1000 explicit labels',400);
          labelIds.forEach(x=>identifier(x,'account label'));
          requireThat((await c.query('SELECT id FROM music_labels WHERE id=ANY($1::text[])',[labelIds])).rows.length===labelIds.length,'Account label scope contains an unknown label',422);
        }
        const sets=['role=$2','label_ids=$3','updated_at=now()'],params=[id,role,labelIds];
        if (raw.displayName!==undefined) { requireThat(raw.displayName===null || (typeof raw.displayName==='string' && raw.displayName.length<=120),'Invalid displayName',400);params.push(raw.displayName);sets.push('display_name=$'+params.length); }
        if (raw.disabled!==undefined) { requireThat(typeof raw.disabled==='boolean','disabled must be boolean',400);sets.push(raw.disabled ? 'disabled_at=COALESCE(disabled_at,now())' : 'disabled_at=NULL'); }
        if (raw.password!==undefined) {
          requireThat(typeof raw.password==='string' && raw.password.length>=14 && raw.password.length<=256,'Password must be 14–256 characters',400);
          const d=await passwordDigest(raw.password);params.push(d.salt,d.hash);sets.push('password_salt=$'+(params.length-1),'password_hash=$'+params.length);
        }
        await c.query('UPDATE music_accounts SET '+sets.join(',')+' WHERE id=$1',params);
        if (raw.disabled===true || raw.password!==undefined || raw.role!==undefined || raw.labelIds!==undefined)
          await c.query('UPDATE music_account_sessions SET revoked_at=now() WHERE account_id=$1 AND revoked_at IS NULL',[id]);
        await audit(c,actor,'account.updated',labelIds,{accountId:id,role,disabled:raw.disabled,passwordReset:raw.password!==undefined});
        return {id,role,labelIds,permissions:roles[role]};
      });
    },
    async markSyntheticLabel(labelId) {
      await pool.query('UPDATE music_labels SET synthetic=true WHERE id=$1',[identifier(labelId,'labelId')]);
    },
    /** Delete every record of a synthetic label. Refuses real (non-synthetic) labels. */
    async deleteSyntheticLabel(labelId,actor='system') {
      identifier(labelId,'labelId');
      return transaction(async c=>{
        const label=(await c.query('SELECT synthetic FROM music_labels WHERE id=$1 FOR UPDATE',[labelId])).rows[0];
        if (!label) return {labelId,deleted:false};
        requireThat(label.synthetic===true,'Only synthetic labels can be removed this way',409);
        const families=(await c.query('SELECT family_id FROM music_label_memberships WHERE label_id=$1',[labelId])).rows.map(r=>r.family_id);
        for (const table of ['music_payouts','music_royalty_statements','music_split_rules','music_expenses','music_budgets','music_imports','music_alert_events',
          'music_rollup_daily','music_rollup_state','music_distributor_reconciliations','music_distributor_rows','music_distributor_statements','music_facts',
          'music_attendance_reports','music_jobs','music_connector_credentials','music_connectors','music_external_ids'])
          await c.query('DELETE FROM '+table+' WHERE label_id=$1',[labelId]);
        await c.query('DELETE FROM music_catalog WHERE label_id=$1',[labelId]);
        await c.query('DELETE FROM music_label_memberships WHERE label_id=$1',[labelId]);
        await c.query('DELETE FROM music_labels WHERE id=$1',[labelId]);
        for (const f of families) await c.query('DELETE FROM music_label_families f WHERE id=$1 AND NOT EXISTS(SELECT 1 FROM music_label_memberships m WHERE m.family_id=f.id)',[f]);
        await audit(c,actor,'demo.removed',[labelId],{});
        return {labelId,deleted:true};
      });
    },
    async syntheticLabels(labelIds) {
      return (await pool.query('SELECT id FROM music_labels WHERE synthetic AND id=ANY($1::text[]) ORDER BY id',[labelIds])).rows.map(r=>r.id);
    }
  };
}
