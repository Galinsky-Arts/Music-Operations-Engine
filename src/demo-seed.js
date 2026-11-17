/**
 * Synthetic demo data. Everything lives in one label flagged `synthetic=true` (id `synthetic-demo`) whose
 * names say "synthetic"; every fact carries metadata.synthetic=true and the reporting API marks responses
 * that include it. Seeding is idempotent and removal deletes only this synthetic label's records.
 */
import {normalizeFact} from './core.js';

export const DEMO_LABEL='synthetic-demo',DEMO_FAMILY='synthetic-demo-family';
const ARTISTS=[['demo-artist-nova','Nova Lights (synthetic)'],['demo-artist-river','River Static (synthetic)'],['demo-artist-pines','Hollow Pines (synthetic)']];
const RELEASES=[['demo-rel-afterglow','Afterglow (synthetic LP)','demo-artist-nova','000000000017'],['demo-rel-static','Static Bloom EP (synthetic)','demo-artist-river','000000000024'],
  ['demo-rel-pines','Under Pines (synthetic single)','demo-artist-pines','000000000031']];
const TRACKS=[['demo-trk-1','Neon Harbor','demo-rel-afterglow'],['demo-trk-2','Glass Tides','demo-rel-afterglow'],['demo-trk-3','Last Ferry','demo-rel-afterglow'],
  ['demo-trk-4','Copper Wire','demo-rel-static'],['demo-trk-5','Low Signal','demo-rel-static'],['demo-trk-6','Feedback Garden','demo-rel-static'],
  ['demo-trk-7','Under Pines','demo-rel-pines'],['demo-trk-8','Moss & Ember','demo-rel-pines']];
const isrc=i=>'ZZDEM26'+String(i+1).padStart(5,'0');

function rng(seed) { let s=seed>>>0;return ()=>{s=(Math.imul(s,1664525)+1013904223)>>>0;return s/4294967296;}; }
const day=(now,offset)=>new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()-offset)).toISOString().slice(0,10);
const month=(now,back)=>{const d=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()-back,1));return d.toISOString().slice(0,7);};

export async function seedDemoData(store,{actor='demo-seed',now=new Date(),days=60}={}) {
  await store.putFamily({id:DEMO_FAMILY,name:'Synthetic demo family (not real data)'},actor);
  await store.putLabel({id:DEMO_LABEL,name:'Synthetic Demo Label (not real data)',familyIds:[DEMO_FAMILY]},actor);
  await store.markSyntheticLabel(DEMO_LABEL);
  const artistOf=new Map(RELEASES.map(r=>[r[0],r[2]]));
  for (const [id,name] of ARTISTS) await store.putCatalog({labelId:DEMO_LABEL,id,kind:'artist',name},actor);
  for (const [id,name,artistId,upc] of RELEASES) await store.putCatalog({labelId:DEMO_LABEL,id,kind:'release',name,artistId,upc},actor);
  for (const [i,[id,name,releaseId]] of TRACKS.entries()) await store.putCatalog({labelId:DEMO_LABEL,id,kind:'track',name,releaseId,artistId:artistOf.get(releaseId),isrc:isrc(i)},actor);
  const rand=rng(20261117),facts=[],meta={synthetic:true};
  const territories=['US','GB','DE','BR','JP'];
  for (let d=days;d>=1;d--) {
    const date=day(now,d);
    for (const [i,[trackId,name,releaseId]] of TRACKS.entries()) {
      const artistId=artistOf.get(releaseId),weight=1+(TRACKS.length-i)/4,trend=1+(days-d)/days;
      for (const [source,scale] of [['spotify',900],['apple',380],['youtube',520]]) {
        const territory=territories[Math.floor(rand()*territories.length)];
        facts.push({source,externalId:`demo:${source}:${date}:${trackId}`,type:'stream',occurredAt:date,quantity:Math.round(scale*weight*trend*(0.6+rand()*0.8)),
          artistId,releaseId,trackId,track:name,channel:source,territory,metadata:meta});
      }
      if (rand()<0.18) {
        const amount=[99,129,999,1299][Math.floor(rand()*4)],orderId=`demo-order-${date}-${i}`;
        facts.push({source:'stems',externalId:`demo:stems:${orderId}`,type:'sale',occurredAt:date+'T15:00:00Z',quantity:1,amountMinor:amount,currency:'USD',
          artistId,releaseId,trackId,track:name,channel:'stems-store',territory:territories[Math.floor(rand()*3)],
          metadata:{...meta,orderId,settlement:d>30 ? 'settled' : 'pending'}});
        if (rand()<0.1) facts.push({source:'stems',externalId:`demo:stems:${orderId}:refund`,type:'refund',occurredAt:day(now,Math.max(1,d-1))+'T09:00:00Z',quantity:1,
          amountMinor:amount,currency:'USD',artistId,releaseId,trackId,track:name,channel:'stems-store',territory:'US',metadata:{...meta,orderId,settlement:'settled'}});
      }
    }
  }
  for (const [n,offset] of [[1,40],[2,21],[3,6]]) {
    const date=day(now,offset)+'T20:00:00Z';
    facts.push({source:'events',externalId:`demo:event:${n}`,type:'event',occurredAt:date,quantity:1,channel:'live',territory:'US',metadata:{...meta,eventName:`Synthetic showcase #${n}`}});
    facts.push({source:'events',externalId:`demo:attendance:${n}`,type:'attendance',occurredAt:date,quantity:80+Math.round(rand()*220),channel:'live',territory:'US',metadata:meta});
  }
  for (let i=0;i<facts.length;i+=500) await store.upsert(facts.slice(i,i+500).map(f=>normalizeFact(f,f.source,{labelId:DEMO_LABEL})),actor);
  // Two months of distributor (TooLost-format) statements: the older month settled, the newer reported only.
  const header='Transaction ID,Date,ISRC,UPC,Currency,Gross,Fees,Net,Status,Settlement ID';
  for (const [back,status] of [[2,'settled'],[1,'reported']]) {
    const period=month(now,back),lines=[header],r=rng(Number(period.replace('-','')));
    TRACKS.forEach(([trackId,,releaseId],i)=>{
      const gross=200+Math.floor(r()*4000),fees=Math.round(gross*0.15),net=gross-fees,cents=v=>(v/100).toFixed(2);
      const upc=RELEASES.find(x=>x[0]===releaseId)[3];
      lines.push([`demo-tl-${period}-${trackId}`,period+'-28',isrc(i),upc,'USD',cents(gross),cents(fees),cents(net),status,status==='settled' ? `demo-settlement-${period}` : ''].join(','));
    });
    await store.importDistributorStatement({csv:lines.join('\n'),labelId:DEMO_LABEL,source:'toolost',statementId:`demo-toolost-${period}`,
      mapping:{externalId:'Transaction ID',occurredAt:'Date',isrc:'ISRC',upc:'UPC',currency:'Currency',gross:'Gross',fees:'Fees',net:'Net',payoutStatus:'Status',settlementId:'Settlement ID'}},actor);
  }
  await store.putSplitRule({labelId:DEMO_LABEL,scopeKind:'label',splits:[{payeeId:'@artist',name:'Primary artist',shareBps:5000},{payeeId:'@label',name:'Label',shareBps:5000}],
    note:'Synthetic demo default: 50/50 net'},actor);
  await store.putSplitRule({labelId:DEMO_LABEL,scopeKind:'track',scopeId:'demo-trk-1',splits:[{payeeId:'@artist',name:'Primary artist',shareBps:4000},
    {payeeId:'demo-producer',name:'Demo Producer (synthetic)',shareBps:2000},{payeeId:'@label',name:'Label',shareBps:4000}],note:'Synthetic producer point example'},actor);
  const current=month(now,0),previous=month(now,1);
  await store.putBudget({labelId:DEMO_LABEL,id:'demo-marketing-'+current,name:'Marketing (synthetic)',period:current,category:'marketing',currency:'USD',amountMinor:250000},actor);
  await store.putBudget({labelId:DEMO_LABEL,id:'demo-video-'+current,name:'Music video (synthetic)',period:current,category:'production',currency:'USD',amountMinor:150000,releaseId:'demo-rel-static'},actor);
  const existing=await store.expenses({labelIds:[DEMO_LABEL]});
  if (!existing.length) {
    await store.recordExpense({labelId:DEMO_LABEL,budgetId:'demo-marketing-'+current,occurredOn:day(now,3),currency:'USD',amountMinor:120000,description:'Playlist pitching campaign (synthetic)',vendor:'Synthetic vendor'},actor);
    await store.recordExpense({labelId:DEMO_LABEL,budgetId:'demo-video-'+current,occurredOn:day(now,2),currency:'USD',amountMinor:165000,description:'Video shoot (synthetic)',vendor:'Synthetic studio'},actor);
  }
  await store.generateStatements({labelId:DEMO_LABEL,period:month(now,2),finalize:true},actor);
  await store.generateStatements({labelId:DEMO_LABEL,period:previous,finalize:false},actor);
  return {labelId:DEMO_LABEL,familyId:DEMO_FAMILY,facts:facts.length,synthetic:true,
    note:'Synthetic demo data only. Remove it with DELETE /v1/admin/demo-data.'};
}
