import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,labels,serve,secrets} from './helpers.js';
import {createFailureLimiter} from '../src/rate-limit.js';
import {createWorker} from '../src/worker.js';

test('failure limiter blocks after the limit and expires with its window',()=>{
  let t=0;const limiter=createFailureLimiter({limit:3,windowMs:1000,now:()=>t});
  for (let i=0;i<3;i++) { assert.equal(limiter.retryAfterSeconds('a'),0);limiter.fail('a'); }
  assert.equal(limiter.retryAfterSeconds('a'),1);assert.equal(limiter.retryAfterSeconds('b'),0);
  t=1001;assert.equal(limiter.retryAfterSeconds('a'),0);
  limiter.fail('a');limiter.reset('a');assert.equal(limiter.retryAfterSeconds('a'),0);
});

test('sign-in and bearer authentication failures are rate limited with Retry-After',async t=>{
  const f=await fixture();t.after(()=>f.close());await labels(f.store);
  await f.store.putAccount({email:'op@example.com',password:'operator-password-long-enough',role:'artist',labelIds:['alpha']});
  const api=await serve(f.store,{loginLimiter:createFailureLimiter({limit:2}),authLimiter:createFailureLimiter({limit:3})});t.after(()=>api.close());
  for (let i=0;i<2;i++) assert.equal((await api.request('/v1/auth/token',{key:'',body:{email:'op@example.com',password:'wrong-password-value'}})).status,401);
  const blocked=await api.request('/v1/auth/token',{key:'',body:{email:'op@example.com',password:'operator-password-long-enough'}});
  assert.equal(blocked.status,429);
  for (let i=0;i<3;i++) assert.equal((await api.request('/v1/summary',{key:'x'.repeat(40)})).status,401);
  assert.equal((await api.request('/v1/summary',{key:secrets.admin})).status,429);
});

test('in-process worker ingests inline fact jobs, rejects bad payloads, and leaves unhandled sources queued',async t=>{
  const f=await fixture();t.after(()=>f.close());await labels(f.store);
  const now=new Date('2026-11-01T00:00:00Z');
  const good=await f.store.enqueueJob({kind:'ingest',source:'manual',labelId:'alpha',payload:{facts:[{externalId:'w-1',type:'stream',occurredAt:'2026-10-30T00:00:00Z',quantity:5,artist:'A',release:'R',track:'T'}]}},'admin',now);
  const bad=await f.store.enqueueJob({kind:'ingest',source:'manual',labelId:'alpha',payload:{facts:[{externalId:'w-2',type:'stream',occurredAt:'2026-10-30T00:00:00Z',labelId:'beta'}]},maxAttempts:1},'admin',now);
  const resync=await f.store.enqueueJob({kind:'resync',source:'manual',labelId:'alpha',maxAttempts:1},'admin',now);
  const other=await f.store.enqueueJob({kind:'ingest',source:'distributor-x',labelId:'alpha',payload:{facts:[]}},'admin',now);
  const worker=createWorker(f.store,{sources:['manual'],now:()=>now});
  const results=Object.fromEntries((await worker.tick()).map(r=>[r.id,r.result]));
  assert.equal(results[good.id],'succeeded');assert.equal(results[bad.id],'label_mismatch');assert.equal(results[resync.id],'unsupported_job_kind');
  assert.equal(results[other.id],undefined);
  const jobs=Object.fromEntries((await f.store.jobs({labelIds:['alpha']})).map(j=>[j.id,j.status]));
  assert.equal(jobs[good.id],'succeeded');assert.equal(jobs[bad.id],'dead_letter');assert.equal(jobs[other.id],'queued');
  const summary=[];for await (const fact of f.store.iterate({labelIds:['alpha']})) summary.push(fact);
  assert.equal(summary.length,1);assert.equal(summary[0].externalId,'w-1');assert.equal(summary[0].labelId,'alpha');
  const w=createWorker(f.store,{intervalMs:10});w.start();await w.stop();
});
