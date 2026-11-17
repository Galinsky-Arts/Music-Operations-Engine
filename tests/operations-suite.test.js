import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,labels,catalog,serve,secrets} from './helpers.js';
import {loadCredentials} from '../src/auth.js';
import {createMaintenance,workerHandlers} from '../src/maintenance.js';
import {parseProviderReport,providerStatus} from '../src/providers.js';
import {DEMO_LABEL} from '../src/demo-seed.js';

const consoleKey='e'.repeat(40);
const withConsole=loadCredentials({ENGINE_API_KEY:secrets.admin,ENGINE_CONSOLE_KEY:consoleKey,ENGINE_CREDENTIALS:JSON.stringify([{id:'alpha',key:secrets.alpha,labels:['alpha'],permissions:['read','ingest']}])});

test('provider presets parse exported reports idempotently and report bad rows', () => {
  const csv='﻿Date,Song,ISRC,Streams,Country\n2026-11-01,Track,USAAA2600001,"1,200",US\n2026-11-01,Track,USAAA2600001,abc,US\n';
  const r=parseProviderReport({provider:'spotify',csv,labelId:'alpha'});
  assert.equal(r.facts.length,1);assert.equal(r.facts[0].quantity,1200);assert.equal(r.facts[0].type,'stream');
  assert.deepEqual(r.errors.map(e=>e.row),[3]);
  assert.equal(parseProviderReport({provider:'spotify',csv,labelId:'alpha'}).facts[0].externalId,r.facts[0].externalId);
  const stems=parseProviderReport({provider:'stems',csv:'Order ID,Date,Amount,Currency,Type\no1,2026-11-02,$12.99,USD,sale\no1,2026-11-03,-12.99,USD,refund\n',labelId:'alpha'});
  assert.deepEqual(stems.facts.map(f=>[f.type,f.amountMinor]),[['sale',1299],['refund',1299]]);
  assert.throws(()=>parseProviderReport({provider:'apple',csv:'Foo,Bar\n1,2\n',labelId:'alpha'}),/date/);
  const status=providerStatus({PROVIDER_LIVE_PULLS:'youtube'});
  assert.equal(status.find(p=>p.id==='youtube').liveApi.enabled,false,'live pull needs CONNECTOR_MASTER_KEY too');
  assert.equal(status.find(p=>p.id==='spotify').liveApi.available,false);
});

test('imports, console delegation, accounts, demo data, stored rollups and alert feed', async () => {
  const f=await fixture();await labels(f.store);await catalog(f.store);
  const delivered=[];
  const fetchImpl=async(url,init)=>{delivered.push({url:String(url),headers:init.headers,body:JSON.parse(init.body)});return new Response('{}',{status:200});};
  const env={ALERT_WEBHOOK_URL:'https://hooks.example.test/alerts',ALERT_WEBHOOK_SECRET:'s'.repeat(32)};
  const maintenance=createMaintenance(f.store,{env,fetchImpl,alertIntervalMs:0});
  const api=await serve(f.store,{credentials:withConsole,env,maintenance});
  try {
    // Provider import through the API, with history.
    let r=await api.request('/v1/imports',{key:secrets.alpha,body:{provider:'spotify',labelId:'alpha',fileName:'spotify.csv',
      csv:'Date,Song,ISRC,Streams\n2026-11-01,Track,USAAA2600001,100\n2026-11-02,Track,USAAA2600001,120\n'}});
    assert.equal(r.status,200);assert.equal(r.body.import.accepted,2);assert.equal(r.body.import.status,'imported');
    r=await api.request('/v1/imports',{key:secrets.alpha,body:{provider:'toolost',labelId:'alpha',
      csv:'Transaction ID,Date,ISRC,Currency,Gross,Fees,Net,Status\nt1,2026-10-02,USAAA2600001,USD,10.00,1.50,8.50,reported\n'}});
    assert.equal(r.status,200);assert.equal(r.body.import.accepted,1);
    r=await api.request('/v1/imports?labelId=alpha',{key:secrets.alpha});
    assert.equal(r.body.imports.length,2);
    r=await api.request('/v1/summary?labelId=alpha',{key:secrets.alpha});
    assert.equal(r.body.counts.streams,220);assert.equal(r.body.synthetic,false);
    // Console delegation records the acting user; accounts are administered by manage credentials.
    r=await api.request('/v1/accounts',{key:consoleKey,headers:{'x-acting-user':'ops@example.test'},body:{email:'m@example.test',password:'correct horse battery',role:'label_manager',labelIds:['alpha'],displayName:'Manager'}});
    assert.equal(r.status,201);const id=r.body.account.id;
    assert.equal((await api.request('/v1/accounts',{key:secrets.alpha})).status,403);
    r=await api.request('/v1/accounts/verify',{key:consoleKey,body:{email:'m@example.test',password:'correct horse battery'}});
    assert.equal(r.status,200);assert.deepEqual(r.body.account.labelIds,['alpha']);assert.equal(r.body.account.role,'label_manager');
    assert.equal((await api.request('/v1/accounts/verify',{key:consoleKey,body:{email:'m@example.test',password:'wrong password!!'}})).status,401);
    r=await api.request('/v1/accounts/'+id,{key:consoleKey,body:{disabled:true}});
    assert.equal(r.status,200);
    assert.equal((await api.request('/v1/accounts/verify',{key:consoleKey,body:{email:'m@example.test',password:'correct horse battery'}})).status,401);
    r=await api.request('/v1/accounts',{key:consoleKey});
    assert.equal(r.body.accounts[0].disabled,true);
    const audit=await api.request('/v1/audit');
    assert.ok(audit.body.records.some(a=>a.actor==='command-center-console/ops@example.test' && a.action==='account.created'));
    // Demo data: clearly synthetic, removable.
    r=await api.request('/v1/admin/demo-data',{key:consoleKey,body:{}});
    assert.equal(r.status,200);assert.equal(r.body.synthetic,true);
    r=await api.request('/v1/summary?labelId='+DEMO_LABEL,{key:consoleKey});
    assert.equal(r.body.synthetic,true);assert.ok(r.body.counts.streams>0);
    r=await api.request('/v1/summary',{key:consoleKey});
    assert.equal(r.body.synthetic,false);assert.deepEqual(r.body.syntheticLabelIds,[DEMO_LABEL]);
    r=await api.request('/v1/scopes',{key:consoleKey});
    assert.equal(r.body.labels.find(l=>l.id===DEMO_LABEL).synthetic,true);
    r=await api.request('/v1/royalties/statements?labelId='+DEMO_LABEL,{key:consoleKey});
    assert.ok(r.body.statements.some(s=>s.status==='final'));
    // Stored rollups serve single-label queries once refreshed.
    r=await api.request('/v1/rollups/daily?labelId='+DEMO_LABEL+'&limit=5',{key:consoleKey});
    assert.equal(r.body.materialized,true);assert.equal(r.body.rollups.length,5);
    const live=await f.store.dailyRollups({labelIds:[DEMO_LABEL],limit:5});
    assert.deepEqual(r.body.rollups,live.rollups);
    await api.request('/v1/ingest',{key:secrets.alpha,body:{source:'store',labelId:'alpha',facts:[{externalId:'x',type:'stream',occurredAt:'2026-11-03'}]}});
    assert.equal((await api.request('/v1/rollups/daily?labelId=alpha',{key:secrets.alpha})).body.materialized,false);
    const run=await maintenance.run();
    assert.ok(run.rollupsRefreshed>=1);
    assert.equal((await api.request('/v1/rollups/daily?labelId=alpha',{key:secrets.alpha})).body.materialized,true);
    // Alert feed: budget overrun in the synthetic label is recorded but not delivered externally.
    r=await api.request('/v1/alerts/feed?labelId='+DEMO_LABEL,{key:consoleKey});
    assert.ok(r.body.alerts.some(a=>a.type==='budget_overrun'));
    assert.ok(delivered.every(d=>d.body.alert.labelId!==DEMO_LABEL));
    await api.request('/v1/budgets',{key:secrets.alpha,body:{labelId:'alpha',id:'b',name:'B',period:new Date().toISOString().slice(0,7),amountMinor:10}});
    await api.request('/v1/expenses',{key:secrets.alpha,body:{labelId:'alpha',budgetId:'b',occurredOn:new Date().toISOString().slice(0,10),amountMinor:50,description:'x'}});
    await maintenance.alerts();
    const hook=delivered.find(d=>d.body.alert.type==='budget_overrun' && d.body.alert.labelId==='alpha');
    assert.ok(hook,'new real-label alert delivered to webhook');assert.match(hook.headers['x-alert-signature'],/^sha256=[0-9a-f]{64}$/);
    r=await api.request('/v1/alerts/feed?labelId=alpha',{key:secrets.alpha});
    const alert=r.body.alerts.find(a=>a.type==='budget_overrun');assert.ok(alert.deliveredAt);
    assert.equal((await api.request('/v1/alerts/feed/'+alert.fingerprint+'/ack',{key:secrets.alpha,body:{}})).status,200);
    r=await api.request('/v1/alerts/delivery',{key:secrets.alpha});
    assert.equal(r.body.webhook.enabled,true);assert.equal(r.body.email.enabled,false);
    // Removing demo data only touches the synthetic label.
    r=await api.request('/v1/admin/demo-data/remove',{key:consoleKey,body:{}});
    assert.equal(r.body.deleted,true);
    r=await api.request('/v1/scopes',{key:consoleKey});
    assert.ok(!r.body.labels.some(l=>l.id===DEMO_LABEL));
    assert.equal((await api.request('/v1/summary?labelId=alpha',{key:secrets.alpha})).body.counts.streams,221);
  } finally { await api.close();await f.close(); }
});

test('live provider pulls stay off until configured', async () => {
  const h=workerHandlers({});
  assert.deepEqual(await h.resync({source:'youtube',labelId:'alpha',payload:{}},{}),{errorCode:'live_pull_disabled',permanent:true});
  assert.deepEqual(await h.resync({source:'spotify',labelId:'alpha',payload:{}},{}),{errorCode:'live_api_unavailable',permanent:true});
});
