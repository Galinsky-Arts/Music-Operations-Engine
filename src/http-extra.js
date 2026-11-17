import {createHash,randomUUID} from 'node:crypto';
import {permit,permitLabel} from './auth.js';
import {requireThat} from './errors.js';
import {csvRow} from './csv.js';
import {identifier} from './validation.js';
import {normalizePeriod,statementCsvColumns} from './royalties.js';
import {PROVIDERS,parseProviderReport,providerStatus,toolostMapping} from './providers.js';
import {parseCsv} from './core.js';
import {deliveryConfig,publicDeliveryConfig} from './alert-delivery.js';
import {seedDemoData,DEMO_LABEL} from './demo-seed.js';

const one=(params,name)=>{requireThat(params.getAll(name).length<=1,'Repeated '+name+' parameter',400);return params.get(name);};
function limitParam(params,fallback,max) {
  const v=one(params,'limit');
  if (v===null) return fallback;
  requireThat(/^\d{1,6}$/.test(v) && Number(v)>=1 && Number(v)<=max,'limit must be 1–'+max,400);
  return Number(v);
}
function singleLabel(filter) {
  requireThat(filter.labelIds.length===1,'Choose a single labelId for this operation',400);
  return filter.labelIds[0];
}

/**
 * Routes for royalties, budgets, alert feed, stored rollups, provider imports, account administration and demo data.
 * Returns true when it handled the request.
 */
export async function extraRoutes({req,res,url,principal,store,respond,readBody,reportFilter,env,maintenance}) {
  const p=url.pathname,m=req.method,params=url.searchParams;
  const body=async()=>(await readBody(req)).data;
  const scoped=async()=>reportFilter(params,principal,store);

  if (m==='GET' && p==='/v1/auth/me') {
    permit(principal,'read');
    const account=principal.accountId ? await store.accountById(principal.accountId) : null;
    return respond(200,{id:principal.id,kind:principal.accountId ? 'account' : 'credential',email:account?.email ?? null,displayName:account?.displayName ?? null,
      role:principal.role ?? null,labels:principal.labels,permissions:principal.permissions}),true;
  }
  if (p==='/v1/accounts' && m==='GET') { permit(principal,'manage');return respond(200,{accounts:await store.accounts()}),true; }
  if (p==='/v1/accounts/verify' && m==='POST') {
    permit(principal,'manage');const d=await body();
    return respond(200,{account:await store.verifyAccount(d.email,d.password,principal.id)}),true;
  }
  const accountRoute=/^\/v1\/accounts\/([0-9a-f-]{36})$/.exec(p);
  if (accountRoute && m==='POST') { permit(principal,'manage');return respond(200,{account:await store.updateAccount(accountRoute[1],await body(),principal.id)}),true; }

  // Royalties (MOE-013)
  if (p==='/v1/royalties/rules') {
    if (m==='GET') { permit(principal,'read');const f=await scoped();return respond(200,{rules:await store.splitRules({labelIds:f.labelIds}),scope:{labelIds:f.labelIds}}),true; }
    if (m==='POST') { permit(principal,'ingest');const d=await body();permitLabel(principal,d.labelId);return respond(200,{rule:await store.putSplitRule(d,principal.id)}),true; }
  }
  if (p==='/v1/royalties/rules/delete' && m==='POST') { permit(principal,'ingest');const d=await body();permitLabel(principal,d.labelId);return respond(200,await store.deleteSplitRule(d,principal.id)),true; }
  if (p==='/v1/royalties/preview' && m==='GET') {
    permit(principal,'read');const f=await scoped();
    return respond(200,await store.royaltyPreview(singleLabel(f),normalizePeriod(one(params,'period')))),true;
  }
  if (p==='/v1/royalties/statements') {
    if (m==='GET') {
      permit(principal,'read');const f=await scoped();
      const payeeId=one(params,'payeeId');if (payeeId!==null) identifier(payeeId,'payeeId');
      return respond(200,{statements:await store.royaltyStatements({labelIds:f.labelIds,period:one(params,'period'),payeeId,withLines:one(params,'lines')==='1'}),scope:{labelIds:f.labelIds}}),true;
    }
    if (m==='POST') {
      const d=await body();permit(principal,d.finalize===true ? 'manage' : 'ingest');permitLabel(principal,d.labelId);
      return respond(200,await store.generateStatements({labelId:d.labelId,period:d.period,finalize:d.finalize===true},principal.id)),true;
    }
  }
  if (p==='/v1/royalties/balances' && m==='GET') { permit(principal,'read');const f=await scoped();return respond(200,{balances:await store.royaltyBalances(f.labelIds),scope:{labelIds:f.labelIds}}),true; }
  if (p==='/v1/royalties/payouts') {
    if (m==='GET') { permit(principal,'read');const f=await scoped();return respond(200,{payouts:await store.payouts({labelIds:f.labelIds}),scope:{labelIds:f.labelIds}}),true; }
    if (m==='POST') { permit(principal,'manage');const d=await body();permitLabel(principal,d.labelId);return respond(201,{payout:await store.recordPayout(d,principal.id)}),true; }
  }
  if (p==='/v1/exports/royalties.csv' && m==='GET') {
    permit(principal,'read');const f=await scoped();const period=one(params,'period');
    if (period!==null) normalizePeriod(period);
    const statements=await store.royaltyStatements({labelIds:f.labelIds,period,withLines:true});
    res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',
      'Content-Disposition':'attachment; filename="royalty-statements'+(period ? '-'+period : '')+'.csv"'});
    res.write(csvRow(statementCsvColumns));
    for (const s of statements) for (const l of s.lines) res.write(csvRow(statementCsvColumns.map(c=>c in l ? l[c] : s[c])));
    return res.end(),true;
  }

  // Budgets
  if (p==='/v1/budgets') {
    if (m==='GET') { permit(principal,'read');const f=await scoped();const period=one(params,'period');return respond(200,{budgets:await store.budgets({labelIds:f.labelIds,period}),scope:{labelIds:f.labelIds}}),true; }
    if (m==='POST') { permit(principal,'ingest');const d=await body();permitLabel(principal,d.labelId);return respond(200,{budget:await store.putBudget(d,principal.id)}),true; }
  }
  if (p==='/v1/expenses') {
    if (m==='GET') { permit(principal,'read');const f=await scoped();const b=one(params,'budgetId');if (b!==null) identifier(b,'budgetId');
      return respond(200,{expenses:await store.expenses({labelIds:f.labelIds,budgetId:b}),scope:{labelIds:f.labelIds}}),true; }
    if (m==='POST') { permit(principal,'ingest');const d=await body();permitLabel(principal,d.labelId);return respond(201,{expense:await store.recordExpense(d,principal.id)}),true; }
  }

  // Alert feed and delivery
  if (p==='/v1/alerts/feed' && m==='GET') {
    permit(principal,'read');const f=await scoped();
    return respond(200,{alerts:await store.alertFeed({labelIds:f.labelIds,status:one(params,'status') || 'open',limit:limitParam(params,200,1000)}),
      lastEvaluation:maintenance?.status() ?? null,scope:{labelIds:f.labelIds}}),true;
  }
  const ack=/^\/v1\/alerts\/feed\/([0-9a-f]{64})\/ack$/.exec(p);
  if (ack && m==='POST') {
    permit(principal,'ingest');
    const labelIds=principal.labels.includes('*') ? (await store.scopes(null)).labels.map(l=>l.id) : principal.labels;
    return respond(200,await store.acknowledgeAlert(ack[1],labelIds,principal.id)),true;
  }
  if (p==='/v1/alerts/delivery' && m==='GET') { permit(principal,'read');return respond(200,{...publicDeliveryConfig(deliveryConfig(env)),lastEvaluation:maintenance?.status() ?? null}),true; }
  if (p==='/v1/alerts/evaluate' && m==='POST') { permit(principal,'manage');requireThat(maintenance,'Maintenance is not running',503);return respond(200,await maintenance.alerts()),true; }

  // Stored rollups
  if (p==='/v1/rollups/status' && m==='GET') { permit(principal,'read');const f=await scoped();return respond(200,{labels:await store.rollupStatus({labelIds:f.labelIds})}),true; }
  if (p==='/v1/rollups/refresh' && m==='POST') { permit(principal,'manage');const d=await body();permitLabel(principal,d.labelId);return respond(200,await store.refreshRollups(d.labelId)),true; }

  // Provider connectors and imports
  if (p==='/v1/providers' && m==='GET') { permit(principal,'read');return respond(200,{providers:providerStatus(env)}),true; }
  if (p==='/v1/connectors') {
    if (m==='GET') { permit(principal,'read');const f=await scoped();return respond(200,{connectors:await store.connectors({labelIds:f.labelIds})}),true; }
    if (m==='POST') { permit(principal,'manage');const d=await body();permitLabel(principal,d.labelId);return respond(200,{connector:await store.putConnector(d,principal.id)}),true; }
  }
  if (p==='/v1/imports') {
    if (m==='GET') { permit(principal,'read');const f=await scoped();return respond(200,{imports:await store.imports({labelIds:f.labelIds,limit:limitParam(params,100,500)})}),true; }
    if (m==='POST') {
      permit(principal,'ingest');const d=await body();permitLabel(principal,d.labelId);
      requireThat(Object.hasOwn(PROVIDERS,d.provider),'Unknown provider',400);
      requireThat(typeof d.csv==='string' && d.csv.length>0,'csv text is required',400);
      const fileName=typeof d.fileName==='string' ? d.fileName.replace(/[^\w.\- ]/g,'_').slice(0,200) : null;
      const contentHash=createHash('sha256').update(d.csv).digest('hex'),id=randomUUID();
      const scope=await store.scopes(principal.labels.includes('*') ? null : principal.labels);
      requireThat(scope.labels.some(l=>l.id===d.labelId),'Label not found',404);
      let result;
      if (PROVIDERS[d.provider].distributor) {
        const text=d.csv.replace(/^﻿/,''),rows=parseCsv(text);
        requireThat(rows.length>0,'The file has no data rows',422);
        const mapping=toolostMapping(Object.keys(rows[0]),d.mapping || {});
        const statementId=d.statementId ? identifier(d.statementId,'statementId') : 'upload-'+contentHash.slice(0,24);
        try {
          const r=await store.importDistributorStatement({csv:text,labelId:d.labelId,source:d.provider,statementId,mapping},principal.id);
          result={rowCount:rows.length,accepted:r.accepted,rejected:0,errors:[],status:r.duplicateStatement ? 'duplicate' : 'imported',statementId};
        } catch(error) {
          if (!error.status) throw error;
          result={rowCount:rows.length,accepted:0,rejected:rows.length,errors:[{row:null,error:error.message}],status:'rejected',statementId};
        }
      } else {
        const parsed=parseProviderReport({provider:d.provider,csv:d.csv,labelId:d.labelId,mapping:d.mapping || {}});
        let accepted=0;const errors=[...parsed.errors];
        for (let i=0;i<parsed.facts.length;i+=2000) {
          const chunk=parsed.facts.slice(i,i+2000);
          try { accepted+=await store.upsert(chunk,principal.id); }
          catch(error) { if (!error.status) throw error;errors.push({row:null,error:'Rows '+(i+1)+'–'+(i+chunk.length)+' rejected: '+error.message}); }
        }
        const rejected=parsed.facts.length+parsed.errors.length-accepted;
        result={rowCount:parsed.facts.length+parsed.errors.length,accepted,rejected,errors,status:accepted===0 ? 'rejected' : rejected ? 'partial' : 'imported',mapping:parsed.mapping};
      }
      await store.recordImport({id,labelId:d.labelId,provider:d.provider,fileName,contentHash,rowCount:result.rowCount,accepted:result.accepted,
        rejected:result.rejected,errors:result.errors,status:result.status,importedBy:principal.id});
      return respond(result.status==='rejected' ? 422 : 200,{import:{id,provider:d.provider,labelId:d.labelId,fileName,...result,errors:result.errors.slice(0,100)}}),true;
    }
  }

  // Synthetic demo data
  if (p==='/v1/admin/demo-data' && m==='POST') {
    permit(principal,'manage');
    requireThat(principal.labels.includes('*'),'Demo data requires system-wide authority',403);
    const result=await seedDemoData(store,{actor:principal.id});
    await store.refreshRollups(DEMO_LABEL).catch(()=>{});
    return respond(200,result),true;
  }
  if (p==='/v1/admin/demo-data/remove' && m==='POST') {
    permit(principal,'manage');
    requireThat(principal.labels.includes('*'),'Demo data requires system-wide authority',403);
    return respond(200,await store.deleteSyntheticLabel(DEMO_LABEL,principal.id)),true;
  }
  return false;
}
