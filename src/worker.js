import {normalizeFact} from './core.js';
import {PLATFORMS} from './platforms.js';

/**
 * In-process job worker. It claims only sources that have a registered handler, so jobs for
 * providers without a live connector stay queued and visible in source health instead of
 * being dead-lettered by a worker that cannot run them.
 */
export const defaultHandlers=Object.freeze({
  // Inline ingest: payload.facts (≤64 KiB per job) are normalized exactly like POST /v1/ingest.
  async ingest(job,store) {
    const raw=job.payload?.facts;
    if (!Array.isArray(raw) || raw.length===0 || raw.length>10000) return {errorCode:'invalid_payload',permanent:true};
    if (raw.some(r=>r && typeof r==='object' && r.labelId!==undefined && r.labelId!==job.labelId)) return {errorCode:'label_mismatch',permanent:true};
    if (PLATFORMS.includes(job.source)) return {errorCode:'platform_requires_signed_endpoint',permanent:true};
    let facts;
    try { facts=raw.map(r=>normalizeFact(r,job.source,{labelId:job.labelId})); }
    catch { return {errorCode:'invalid_payload',permanent:true}; }
    if (facts.some(f=>f.labelId!==job.labelId || f.metadata.logicalActivityId || f.metadata.trackzero || f.metadata.scene))
      return {errorCode:'invalid_payload',permanent:true};
    await store.upsert(facts,'worker:'+job.id);
    return null;
  }
});

export function createWorker(store,{sources=['manual'],workerId='engine-worker',handlers=defaultHandlers,intervalMs=15000,batch=10,
  now=()=>new Date(),log=()=>{},maintenance=null}={}) {
  let timer=null,running=null,stopped=true;
  async function processJob(job) {
    const handler=handlers[job.kind];
    try {
      const failure=handler ? await handler(job,store) : {errorCode:'unsupported_job_kind',permanent:true};
      if (!failure) { await store.completeJob(job.id,workerId,now());return 'succeeded'; }
      const at=now();
      // Permanent failures still use the bounded retry path, but with the shortest delay; they dead-letter at maxAttempts.
      await store.failJob(job.id,workerId,{errorCode:failure.errorCode,retryAt:new Date(at.getTime()+(failure.permanent?1000:60000)).toISOString()},at);
      return failure.errorCode;
    } catch(error) {
      const at=now();
      await store.failJob(job.id,workerId,{errorCode:error?.status ? 'rejected_'+error.status : 'handler_error',retryAt:new Date(at.getTime()+60000).toISOString()},at).catch(()=>{});
      return 'handler_error';
    }
  }
  async function tick() {
    const results=[];
    for (const source of sources) {
      const jobs=await store.claimJobs({source,workerId,limit:batch,now:now()});
      for (const job of jobs) results.push({id:job.id,result:await processJob(job)});
    }
    if (results.length) log({event:'worker.tick',processed:results.length});
    if (maintenance) await maintenance.run().catch(error=>log({event:'maintenance.error',name:error?.name,code:error?.code||'internal'}));
    return results;
  }
  function schedule() {
    if (stopped) return;
    timer=setTimeout(()=>{running=tick().catch(error=>log({event:'worker.error',name:error?.name,code:error?.code||'internal'}))
      .finally(()=>{running=null;schedule();});},intervalMs);
    timer.unref?.();
  }
  return Object.freeze({
    tick,
    start() { if (!stopped) return;stopped=false;schedule(); },
    async stop() { stopped=true;clearTimeout(timer);await running; }
  });
}
