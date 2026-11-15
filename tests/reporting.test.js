import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,labels,catalog,serve,secrets} from './helpers.js';
import {evaluateAlerts} from '../src/alerts.js';
import {csvCell} from '../src/csv.js';

const fact=(id,date,extra={})=>({externalId:id,type:'stream',occurredAt:date,quantity:1,artist:'A',release:'R',track:'T',...extra});

test('MOE-011: ISRCs are canonicalized, unique per label, and map facts to the canonical track',async t=>{
  const f=await fixture();t.after(()=>f.close());await labels(f.store);await catalog(f.store);
  await assert.rejects(f.store.putCatalog({labelId:'alpha',id:'dupe',kind:'track',name:'Dupe',artistId:'artist',releaseId:'album',isrc:'us-aaa-26-00001'}),/already mapped/);
  await f.store.putCatalog({labelId:'alpha',id:'track',kind:'track',name:'Track',artistId:'artist',releaseId:'album',isrc:'US-AAA-26-00001'});
  const api=await serve(f.store);t.after(()=>api.close());
  const ingest=await api.request('/v1/ingest',{body:{source:'dsp',labelId:'alpha',facts:[fact('m1','2026-11-01',{isrc:'us-aaa-26-00001'}),fact('u1','2026-11-01',{isrc:'GBXYZ2600002'})]}});
  assert.equal(ingest.status,200);
  const bad=await api.request('/v1/ingest',{body:{source:'dsp',labelId:'alpha',facts:[fact('c1','2026-11-01',{isrc:'USAAA2600001',trackId:'other'})]}});
  assert.equal(bad.status,422);
  assert.equal((await api.request('/v1/ingest',{body:{source:'dsp',labelId:'alpha',facts:[fact('x','2026-11-01',{isrc:'not-an-isrc'})]}})).status,422);
  const lookup=await api.request('/v1/catalog/isrc/US-AAA-26-00001');
  assert.equal(lookup.status,200);assert.equal(lookup.body.isrc,'USAAA2600001');
  assert.deepEqual(lookup.body.tracks.map(x=>[x.labelId,x.trackId,x.releaseId,x.artistId]),[['alpha','track','album','artist']]);
  assert.deepEqual(lookup.body.facts,[{labelId:'alpha',facts:1,unmapped:0}]);
  const facts=await api.request('/v1/facts?labelId=alpha');
  const mapped=facts.body.facts.find(x=>x.externalId==='m1');
  assert.equal(mapped.trackId,'track');assert.equal(mapped.releaseId,'album');assert.equal(mapped.isrc,'USAAA2600001');
  const unmapped=await api.request('/v1/catalog/unmapped-isrcs?labelId=alpha');
  assert.deepEqual(unmapped.body.items.map(x=>[x.isrc,x.facts]),[['GBXYZ2600002',1]]);
  assert.equal((await api.request('/v1/catalog/isrc/USAAA2600001?labelId=beta',{key:secrets.alpha})).status,403);
});

test('MOE-012: keyset pagination over facts and catalog, and deduplicated daily SQL rollups',async t=>{
  const f=await fixture();t.after(()=>f.close());await labels(f.store);await catalog(f.store);
  const api=await serve(f.store);t.after(()=>api.close());
  const rows=Array.from({length:25},(_,i)=>fact('p'+String(i).padStart(2,'0'),'2026-11-0'+(1+i%3),{quantity:i+1}));
  rows.push({...fact('s1','2026-11-01'),amountMinor:'9007199254740993',type:'sale',currency:'USD'});
  assert.equal((await api.request('/v1/ingest',{body:{source:'dsp',labelId:'alpha',facts:rows}})).status,200);
  const seen=[];let cursor=null,pages=0;
  do {
    const page=await api.request('/v1/facts?labelId=alpha&limit=7'+(cursor ? '&cursor='+cursor : ''));
    assert.equal(page.status,200);seen.push(...page.body.facts.map(x=>x.externalId));cursor=page.body.nextCursor;pages++;
  } while (cursor);
  assert.equal(pages,4);assert.equal(seen.length,26);assert.equal(new Set(seen).size,26);
  assert.equal((await api.request('/v1/facts?limit=7&cursor=%%%')).status,400);
  assert.equal((await api.request('/v1/facts?limit=7&cursor=WzFd')).status,400);
  assert.equal((await api.request('/v1/facts?limit=0')).status,400);
  const cat1=await api.request('/v1/catalog?labelId=alpha&limit=2');
  assert.equal(cat1.body.items.length,2);assert.ok(cat1.body.nextCursor);
  const cat2=await api.request('/v1/catalog?labelId=alpha&limit=2&cursor='+cat1.body.nextCursor);
  assert.equal(cat2.body.items.length,1);assert.equal(cat2.body.nextCursor,null);
  assert.equal((await api.request('/v1/catalog?labelId=alpha&kind=track')).body.items.length,1);
  const rollup=await api.request('/v1/rollups/daily?labelId=alpha');
  const streams=rollup.body.rollups.filter(r=>r.type==='stream');
  assert.equal(streams.reduce((s,r)=>s+r.quantity,0),325);assert.equal(streams.length,3);
  assert.equal(rollup.body.rollups.find(r=>r.type==='sale').amountMinor,'9007199254740993');
  const summary=await api.request('/v1/summary?labelId=alpha');assert.equal(summary.body.counts.streams,325);
  const paged=await api.request('/v1/rollups/daily?labelId=alpha&limit=2');assert.equal(paged.body.rollups.length,2);assert.ok(paged.body.nextCursor);
});

test('MOE-015: CSV exports neutralize formulas and stream complete scoped data',async t=>{
  assert.equal(csvCell('=HYPERLINK("x")'),'"\'=HYPERLINK(""x"")"');assert.equal(csvCell('-5'),'-5');assert.equal(csvCell('+1 555'),"'+1 555");
  assert.equal(csvCell('a,b'),'"a,b"');assert.equal(csvCell(null),'');
  const f=await fixture();t.after(()=>f.close());await labels(f.store);
  const api=await serve(f.store);t.after(()=>api.close());
  await api.request('/v1/ingest',{body:{source:'dsp',labelId:'alpha',facts:[fact('e1','2026-11-01',{artist:'=cmd|calc'}),fact('e2','2026-11-02')]}});
  await api.request('/v1/ingest',{body:{source:'dsp',labelId:'beta',facts:[fact('hidden','2026-11-01')]}});
  const res=await fetch(await urlFor(api,'/v1/exports/facts.csv?labelId=alpha'),{headers:{Authorization:'Bearer '+secrets.admin}});
  assert.equal(res.status,200);assert.match(res.headers.get('content-type'),/text\/csv/);assert.match(res.headers.get('content-disposition'),/attachment/);
  const text=await res.text();const lines=text.trim().split('\r\n');
  assert.equal(lines.length,3);assert.match(lines[0],/^occurredAt,labelId,source/);assert.match(text,/'=cmd\|calc/);assert.doesNotMatch(text,/hidden/);
  const daily=await (await fetch(await urlFor(api,'/v1/exports/daily.csv?labelId=alpha'),{headers:{Authorization:'Bearer '+secrets.admin}})).text();
  assert.equal(daily.trim().split('\r\n').length,3);
  assert.equal((await fetch(await urlFor(api,'/v1/exports/facts.csv'))).status,401);
  assert.equal((await fetch(await urlFor(api,'/v1/exports/facts.csv?labelId=beta'),{headers:{Authorization:'Bearer '+secrets.alpha}})).status,403);
});

test('MOE-015: anomaly and operational alerts are derived deterministically',async t=>{
  const now=new Date('2026-11-15T12:00:00Z');
  const daily=[];
  for (let d=1;d<=13;d++) daily.push({date:'2026-10-'+String(d+17).padStart(2,'0'),labelId:'alpha',source:'dsp',type:'stream',quantity:100n});
  daily.push({date:'2026-10-31',labelId:'alpha',source:'dsp',type:'stream',quantity:100n});
  const window={from:'2026-10-31T00:00:00.000Z',to:'2026-11-15T00:00:00.000Z'};
  const series=[];for (let d=0;d<14;d++) series.push({date:new Date(Date.parse(window.from)+d*86400000).toISOString().slice(0,10),labelId:'alpha',source:'dsp',type:'stream',quantity:100n});
  series.push({date:'2026-11-14',labelId:'alpha',source:'dsp',type:'stream',quantity:5n});
  const spikes=series.slice(0,14).map(r=>({...r,source:'tz',type:'play'}));spikes.push({date:'2026-11-14',labelId:'alpha',source:'tz',type:'play',quantity:900n});
  const quiet=[{date:'2026-11-14',labelId:'alpha',source:'tiny',type:'stream',quantity:0n}];
  const alerts=evaluateAlerts({window,daily:[...series.filter(r=>r.date!=='2026-11-14'),series.at(-1),...spikes,...quiet],
    freshness:[{labelId:'alpha',source:'dsp',lastIngestedAt:'2026-11-10T00:00:00Z'},{labelId:'alpha',source:'tz',lastIngestedAt:'2026-11-15T11:00:00Z'}],
    jobs:[{labelId:'alpha',source:'dsp',deadLetter:2,backlog:3,oldestReadyAt:'2026-11-15T09:00:00Z'}]},{now});
  const types=alerts.map(a=>a.type+':'+a.source);
  assert.ok(types.includes('volume_drop:dsp'));assert.ok(types.includes('volume_spike:tz'));assert.ok(types.includes('source_stale:dsp'));
  assert.ok(types.includes('jobs_dead_letter:dsp'));assert.ok(types.includes('jobs_backlog_stale:dsp'));
  assert.ok(!types.some(t=>t.endsWith(':tiny')));assert.ok(!types.includes('source_stale:tz'));
  assert.equal(alerts[0].severity,'critical');

  const f=await fixture();t.after(()=>f.close());await labels(f.store);
  const api=await serve(f.store);t.after(()=>api.close());
  await api.request('/v1/ingest',{body:{source:'dsp',labelId:'alpha',facts:[fact('a1','2026-11-01')]}});
  const res=await api.request('/v1/alerts?labelId=alpha&staleHours=1000');
  assert.equal(res.status,200);assert.ok(Array.isArray(res.body.alerts));assert.equal(res.body.thresholds.staleHours,1000);
  assert.equal((await api.request('/v1/alerts?staleHours=0')).status,400);
});

async function urlFor(api,path) { return api.url(path); }
