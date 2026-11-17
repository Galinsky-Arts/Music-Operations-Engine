import {evaluateAlerts} from './alerts.js';
import {budgetAlerts,deliverAlert,deliveryConfig} from './alert-delivery.js';
import {pullYouTube} from './providers.js';
import {defaultHandlers} from './worker.js';

/**
 * Periodic in-process maintenance run by the worker loop:
 *  - refresh stored daily rollups for labels whose facts changed (bounded per run);
 *  - evaluate alerts for every label, persist the in-app feed and deliver new alerts when delivery is configured.
 */
export function createMaintenance(store,{env=process.env,fetchImpl=fetch,now=()=>new Date(),alertIntervalMs=Number(env.ALERT_EVAL_INTERVAL_MS || 300000),
  rollupBatch=5,log=()=>{}}={}) {
  let lastAlertRun=0,lastSummary=null;
  async function refreshRollups() {
    const stale=(await store.staleRollupLabels()).slice(0,rollupBatch);
    for (const labelId of stale) await store.refreshRollups(labelId,now());
    return stale.length;
  }
  async function alerts() {
    const at=now(),labels=(await store.scopes(null)).labels;
    const labelIds=labels.map(l=>l.id),synthetic=new Set(labels.filter(l=>l.synthetic).map(l=>l.id));
    const inputs=await store.alertInputs({labelIds,sources:null,now:at});
    const recent=new Date(Date.UTC(at.getUTCFullYear(),at.getUTCMonth()-1,1)).toISOString().slice(0,7);
    const budgets=(await store.budgets({labelIds})).filter(b=>b.period>=recent);
    const found=[...evaluateAlerts(inputs,{now:at}),...budgetAlerts(budgets)];
    const result=await store.syncAlerts(found,at);
    const config=deliveryConfig(env);
    let delivered=0,failed=0;
    if (config.webhook.enabled || config.email.enabled) {
      for (const alert of [...result.opened,...result.escalated]) {
        if (synthetic.has(alert.labelId)) continue; // synthetic demo alerts stay in the in-app feed only
        const error=await deliverAlert(alert,config,{fetchImpl});
        await store.markAlertDelivery(alert.fingerprint,{error,now:at});
        if (error) failed++;else delivered++;
      }
    }
    lastSummary={evaluatedAt:at.toISOString(),open:found.length,opened:result.opened.length,resolved:result.resolved,delivered,failed};
    return lastSummary;
  }
  return Object.freeze({
    refreshRollups,alerts,
    status:()=>lastSummary,
    async run({force=false}={}) {
      const out={rollupsRefreshed:await refreshRollups()};
      if (force || now().getTime()-lastAlertRun>=alertIntervalMs) { lastAlertRun=now().getTime();out.alerts=await alerts(); }
      if (out.rollupsRefreshed || out.alerts) log({event:'maintenance.run',rollups:out.rollupsRefreshed,alerts:out.alerts?.open ?? null});
      return out;
    }
  });
}

/** Worker handlers including live provider resync. Live pulls stay OFF unless PROVIDER_LIVE_PULLS lists the provider. */
export function workerHandlers(env=process.env,{fetchImpl=fetch}={}) {
  const live=new Set(String(env.PROVIDER_LIVE_PULLS || '').split(',').map(s=>s.trim()).filter(Boolean));
  return Object.freeze({
    ...defaultHandlers,
    async resync(job,store) {
      if (job.source!=='youtube') return {errorCode:'live_api_unavailable',permanent:true};
      if (!live.has('youtube') || !env.CONNECTOR_MASTER_KEY) return {errorCode:'live_pull_disabled',permanent:true};
      const end=new Date(),start=new Date(end.getTime()-7*86400000);
      const startDate=job.payload?.startDate || start.toISOString().slice(0,10),endDate=job.payload?.endDate || end.toISOString().slice(0,10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) return {errorCode:'invalid_payload',permanent:true};
      let credential;
      try { credential=await store.connectorCredential(job.labelId,'youtube','worker:'+job.id); } catch { return {errorCode:'credential_missing',permanent:true}; }
      try {
        const facts=await pullYouTube({credential,labelId:job.labelId,startDate,endDate,fetchImpl});
        if (facts.length) await store.upsert(facts,'worker:'+job.id);
        return null;
      } catch(error) { return {errorCode:error.code || 'pull_failed',permanent:error.code==='auth_failed'}; }
    }
  });
}
