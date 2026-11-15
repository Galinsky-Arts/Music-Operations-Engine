import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,serve,secrets} from './helpers.js';
import {normalizeFact} from '../src/core.js';
import {reportId,REPORTS} from '../src/label-reports.js';

const mapping={externalId:'Transaction',occurredAt:'Date',isrc:'ISRC',currency:'Currency',gross:'Gross',fees:'Fees',net:'Net',payoutStatus:'Status',settlementId:'Settlement'};
export async function seedLabelReports(store) {
  await store.putLabel({id:'label_alpha',name:'Alpha Records'});
  await store.putLabel({id:'label_beta',name:'Beta Records'});
  await store.putCatalog({labelId:'label_alpha',id:'artist',kind:'artist',name:'Artist'});
  await store.putCatalog({labelId:'label_alpha',id:'release_one',kind:'release',name:'Release One',artistId:'artist',upc:'123456789012'});
  await store.putCatalog({labelId:'label_alpha',id:'track_one',kind:'track',name:'Track One',artistId:'artist',releaseId:'release_one',isrc:'USABC1234567'});
  const facts=[
    {externalId:'s1',type:'stream',occurredAt:'2026-10-03T00:00:00Z',quantity:40,territory:'US'},
    {externalId:'s2',type:'stream',occurredAt:'2026-10-04T00:00:00Z',quantity:2,territory:''},
    {externalId:'o1',type:'sale',occurredAt:'2026-10-05T00:00:00Z',amountMinor:1000,currency:'USD',channel:'Bandcamp',territory:'GB',metadata:{orderId:'order_0001'}},
    {externalId:'r1',type:'refund',occurredAt:'2026-10-06T00:00:00Z',amountMinor:400,currency:'USD',channel:'Bandcamp',territory:'GB',metadata:{orderId:'order_0001'}},
    {externalId:'r2',type:'refund',occurredAt:'2026-10-06T00:00:00Z',amountMinor:250,currency:'USD',channel:'Bandcamp',territory:'GB'}
  ].map(f=>normalizeFact({artist:'Artist',...f},'dsp',{labelId:'label_alpha'}));
  facts.push(...[
    {externalId:'ss1',type:'attendance',occurredAt:'2026-10-07T20:00:00Z',quantity:12,metadata:{scene:{sessionId:'night'},logicalActivityId:'attendance:night:1'}},
    {externalId:'ss2',type:'play',occurredAt:'2026-10-07T21:00:00Z',metadata:{scene:{sessionId:'night',musicMs:'1000'}}}
  ].map(f=>normalizeFact({artist:'Artist',...f},'scenesignal',{labelId:'label_alpha'})));
  facts.push(normalizeFact({externalId:'b1',type:'stream',occurredAt:'2026-10-03T00:00:00Z',quantity:9,artist:'B'},'dsp',{labelId:'label_beta'}));
  await store.upsert(facts,'test');
  await store.importDistributorStatement({labelId:'label_alpha',source:'toolost',statementId:'october',mapping,
    csv:'Transaction,Date,ISRC,Currency,Gross,Fees,Net,Status,Settlement\na1,2026-10-01,USABC1234567,USD,1.25,0.10,1.15,pending,\n'},'test');
}

test('label reports are read-only, label-scoped and source-checked',async t=>{
  const f=await fixture();t.after(()=>f.close());await seedLabelReports(f.store);
  const api=await serve(f.store);t.after(()=>api.close());
  assert.equal((await api.request('/v1/labels/label_alpha/reports/streams',{key:secrets.alpha})).status,403);
  assert.equal((await api.request('/v1/labels/label_alpha/reports/unknown')).status,404);
  assert.equal((await api.request('/v1/labels/label_missing/reports/streams')).status,404);
  assert.equal((await api.request('/v1/labels/label_alpha/reports/streams?labelId=x')).status,400);
  assert.equal((await api.request('/v1/labels/label_alpha/reports/streams',{method:'POST',body:{}})).status,405);
  assert.equal((await fetch(api.url('/v1/labels/label_alpha/reports/streams'))).status,401);
});

test('label reports project stored data honestly and mark empty reports awaiting-producer',async t=>{
  const f=await fixture();t.after(()=>f.close());await seedLabelReports(f.store);
  const api=await serve(f.store);t.after(()=>api.close());
  const get=async name=>{const r=await api.request('/v1/labels/label_alpha/reports/'+name);assert.equal(r.status,200,name);assert.equal(r.body.labelId,'label_alpha');return r.body;};
  const catalog=await get('catalog');
  assert.equal(catalog.status,'live');assert.equal(catalog.releases.length,1);
  const release=catalog.releases[0];
  assert.equal(release.releaseId,'release_one');assert.equal(release.releaseDate,null);assert.deepEqual(release.works,[]);
  assert.deepEqual(release.tracks.map(x=>[x.trackId,x.isrc]),[['track_one','USABC1234567']]);
  assert.equal(release.source.system,'music-operations-engine');assert.ok(release.source.revision>0);
  const streams=await get('streams');
  const rows=Object.fromEntries(streams.records.map(r=>[r.country,r.streams]));
  assert.deepEqual(rows,{US:'40',ALL:'42'});assert.ok(streams.records.every(r=>r.platform==='dsp'&&r.period==='2026-10'));
  const sales=await get('sales');
  assert.deepEqual(sales.events.map(e=>[e.kind,e.orderId,e.storefront,e.country,e.amountMinor,e.settlement]),
    [['sale','order_0001','bandcamp','GB','1000','pending'],['refund','order_0001','bandcamp','GB','400','pending']]);
  assert.deepEqual(sales.unattributedRefunds,[{currency:'USD',amountMinor:'250'}]);
  const toolost=await get('toolost');
  assert.equal(toolost.statements.length,1);const st=toolost.statements[0];
  assert.equal(st.provider,'TooLost');assert.equal(st.statementId,reportId('october'));assert.equal(st.providerStatementId,'october');
  assert.equal(st.royaltiesMinor,'115');assert.equal(st.lines[0].units,null);assert.equal(st.lines[0].trackId,'track_one');assert.match(st.source.documentSha256,/^[a-f0-9]{64}$/);
  const scene=await get('scenesignal');
  assert.equal(scene.sessions.length,1);
  assert.deepEqual([scene.sessions[0].attendance,scene.sessions[0].engagements,scene.sessions[0].status,scene.sessions[0].currency],['12','1',null,'XXX']);
  const health=await get('health');
  assert.deepEqual(health.observations.map(o=>[o.sourceId,o.valueDecimal]),[['dsp','5'],['scenesignal','2']]);
  for (const name of ['stems','events','artist']) assert.equal((await get(name)).status,'awaiting-producer');
  assert.equal((await get('trackzero')).status,'not-applicable');
  const beta=(await api.request('/v1/labels/label_beta/reports/streams')).body;
  assert.deepEqual(beta.records.map(r=>r.streams),['9']);
  const empty=(await api.request('/v1/labels/label_beta/reports/catalog')).body;
  assert.equal(empty.status,'awaiting-producer');assert.deepEqual(empty.releases,[]);
  assert.equal(REPORTS.length,10);
  if (process.env.WRITE_REPORT_FIXTURE) {
    const {writeFile}=await import('node:fs/promises');const out={};
    for (const name of REPORTS) out[name]=await get(name);
    await writeFile(process.env.WRITE_REPORT_FIXTURE,JSON.stringify(out,null,1));
  }
});

test('report identifiers keep compatible ids and map others to stable digests',()=>{
  assert.equal(reportId('release_one'),'release_one');
  assert.match(reportId('a.b'),/^id_[0-9a-f]{40}$/);assert.equal(reportId('a.b'),reportId('a.b'));
});
