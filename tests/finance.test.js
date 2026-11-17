import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,labels,catalog,serve,secrets} from './helpers.js';
import {allocate,buildStatements,normalizeSplitRule} from '../src/royalties.js';
import {budgetAlerts} from '../src/alert-delivery.js';

test('allocation is exact for positive and negative amounts', () => {
  assert.deepEqual(allocate(100n,[{shareBps:3333},{shareBps:3333},{shareBps:3334}]),[33n,33n,34n]);
  assert.deepEqual(allocate(-101n,[{shareBps:5000},{shareBps:5000}]).reduce((a,b)=>a+b,0n),-101n);
  assert.deepEqual(allocate(1n,[{shareBps:5000},{shareBps:5000}]),[1n,0n]);
  assert.throws(()=>normalizeSplitRule({labelId:'alpha',scopeKind:'label',splits:[{payeeId:'@artist',shareBps:6000},{payeeId:'@label',shareBps:3000}]}),/10000/);
});

test('rule precedence: track over release over label over system default', () => {
  const rules=new Map([['label:',{splits:[{payeeId:'@label',name:'Label',shareBps:10000}]}],
    ['track:t1',{splits:[{payeeId:'@artist',shareBps:4000},{payeeId:'producer',name:'Producer',shareBps:2000},{payeeId:'@label',shareBps:4000}]}]]);
  const lines=[{currency:'USD',artistId:'a',artistName:'A',releaseId:'r',trackId:'t1',kind:'sale',recognized:true,amountMinor:'1000'},
    {currency:'USD',artistId:'a',artistName:'A',releaseId:'r',trackId:'t2',kind:'sale',recognized:false,amountMinor:'500'},
    {currency:'EUR',artistId:'a',artistName:'A',releaseId:'r',trackId:'t1',kind:'royalty',recognized:true,amountMinor:'10'}];
  const s=buildStatements(lines,rules);
  const get=(p,c)=>s.find(x=>x.payeeId===p && x.currency===c);
  assert.equal(get('artist:a','USD').recognizedMinor,'400');
  assert.equal(get('producer','USD').recognizedMinor,'200');
  assert.equal(get('label','USD').recognizedMinor,'400');
  assert.equal(get('label','USD').pendingMinor,'500');
  assert.equal(get('artist:a','EUR').recognizedMinor,'4');
  const none=buildStatements([lines[1]],new Map());
  assert.deepEqual(none.map(x=>[x.payeeId,x.pendingMinor]),[['artist:a','250'],['label','250']]);
});

test('budget alerts flag overruns and near-limit budgets', () => {
  const out=budgetAlerts([{labelId:'a',id:'b1',name:'B1',period:'2026-11',currency:'USD',amountMinor:'100',spentMinor:'130',status:'over',utilizationBps:13000},
    {labelId:'a',id:'b2',name:'B2',period:'2026-11',currency:'USD',amountMinor:'100',spentMinor:'95',status:'near-limit',utilizationBps:9500}]);
  assert.deepEqual(out.map(a=>[a.type,a.severity]),[['budget_overrun','critical'],['budget_near_limit','warning']]);
});

test('royalty statements, finalization, payouts and budgets over HTTP', async () => {
  const f=await fixture();await labels(f.store);await catalog(f.store);
  const api=await serve(f.store);
  try {
    const facts=[{externalId:'s1',type:'sale',occurredAt:'2026-10-03T10:00:00Z',amountMinor:1000,currency:'USD',trackId:'track',metadata:{settlement:'settled'}},
      {externalId:'s2',type:'sale',occurredAt:'2026-10-04T10:00:00Z',amountMinor:600,currency:'USD',trackId:'track'},
      {externalId:'r1',type:'refund',occurredAt:'2026-10-05T10:00:00Z',amountMinor:200,currency:'USD',trackId:'track',metadata:{settlement:'settled'}},
      {externalId:'s3',type:'sale',occurredAt:'2026-11-01T10:00:00Z',amountMinor:999,currency:'USD',trackId:'track',metadata:{settlement:'settled'}}];
    assert.equal((await api.request('/v1/ingest',{body:{source:'store',labelId:'alpha',facts}})).status,200);
    let r=await api.request('/v1/royalties/preview?labelId=alpha&period=2026-10');
    assert.equal(r.status,200);assert.equal(r.body.defaultRule,'system-default');
    assert.deepEqual(r.body.revenue,[{currency:'USD',recognizedMinor:'800',pendingMinor:'600'}]);
    assert.equal((await api.request('/v1/royalties/rules',{body:{labelId:'alpha',scopeKind:'track',scopeId:'track',
      splits:[{payeeId:'@artist',shareBps:7000},{payeeId:'@label',shareBps:3000}]}})).status,200);
    assert.equal((await api.request('/v1/royalties/rules',{body:{labelId:'alpha',scopeKind:'track',scopeId:'nope',splits:[{payeeId:'@label',shareBps:10000}]}})).status,422);
    r=await api.request('/v1/royalties/statements',{key:secrets.alpha,body:{labelId:'alpha',period:'2026-10',finalize:true}});
    assert.equal(r.status,403,'finalizing requires manage');
    r=await api.request('/v1/royalties/statements',{body:{labelId:'alpha',period:'2026-10',finalize:true}});
    assert.equal(r.status,200);assert.equal(r.body.statements.length,2);
    r=await api.request('/v1/royalties/statements?labelId=alpha&period=2026-10');
    const artist=r.body.statements.find(s=>s.payeeId==='artist:artist');
    assert.equal(artist.recognizedMinor,'560');assert.equal(artist.pendingMinor,'420');assert.equal(artist.status,'final');
    // Late data does not change a finalized statement; the conflict is reported.
    await api.request('/v1/ingest',{body:{source:'store',labelId:'alpha',facts:[{externalId:'late',type:'sale',occurredAt:'2026-10-20T10:00:00Z',amountMinor:100,currency:'USD',trackId:'track',metadata:{settlement:'settled'}}]}});
    r=await api.request('/v1/royalties/statements',{body:{labelId:'alpha',period:'2026-10'}});
    assert.equal(r.body.conflicts.length,2);
    r=await api.request('/v1/royalties/balances?labelId=alpha');
    assert.equal(r.body.balances.find(b=>b.payeeId==='artist:artist').balanceMinor,'560');
    assert.equal((await api.request('/v1/royalties/payouts',{body:{labelId:'alpha',payeeId:'artist:artist',currency:'USD',amountMinor:600,reference:'wire-1'}})).status,422);
    assert.equal((await api.request('/v1/royalties/payouts',{body:{labelId:'alpha',payeeId:'artist:artist',currency:'USD',amountMinor:500,reference:'wire-1'}})).status,201);
    r=await api.request('/v1/royalties/balances?labelId=alpha');
    assert.equal(r.body.balances.find(b=>b.payeeId==='artist:artist').balanceMinor,'60');
    const csv=await (await fetch(api.url('/v1/exports/royalties.csv?labelId=alpha&period=2026-10'),{headers:{Authorization:'Bearer '+secrets.admin}})).text();
    assert.match(csv,/^labelId,period,payeeId/);assert.match(csv,/artist:artist/);
    // Budgets
    assert.equal((await api.request('/v1/budgets',{key:secrets.alpha,body:{labelId:'alpha',id:'mkt',name:'Marketing',period:'2026-11',currency:'USD',amountMinor:1000}})).status,200);
    assert.equal((await api.request('/v1/budgets',{key:secrets.alpha,body:{labelId:'beta',id:'mkt',name:'Marketing',period:'2026-11',amountMinor:1000}})).status,403);
    assert.equal((await api.request('/v1/expenses',{key:secrets.alpha,body:{labelId:'alpha',budgetId:'mkt',occurredOn:'2026-11-02',currency:'EUR',amountMinor:5,description:'x'}})).status,422);
    assert.equal((await api.request('/v1/expenses',{key:secrets.alpha,body:{labelId:'alpha',budgetId:'mkt',occurredOn:'2026-11-02',currency:'USD',amountMinor:1100,description:'Ads'}})).status,201);
    r=await api.request('/v1/budgets?labelId=alpha');
    assert.equal(r.body.budgets[0].status,'over');assert.equal(r.body.budgets[0].remainingMinor,'-100');
  } finally { await api.close();await f.close(); }
});
