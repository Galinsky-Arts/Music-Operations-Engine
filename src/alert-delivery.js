import {createHmac} from 'node:crypto';

/**
 * Alert delivery. The in-app feed (music_alert_events) is always on. Outbound delivery is OFF until configured:
 *  - Webhook: ALERT_WEBHOOK_URL (https) and optional ALERT_WEBHOOK_SECRET (adds X-Alert-Signature: sha256=<hex HMAC of body>).
 *  - Email:   ALERT_EMAIL_TO, ALERT_EMAIL_FROM and RESEND_API_KEY (sent through the Resend HTTP API).
 * Only newly opened or escalated-to-critical alerts are delivered; failures are recorded on the alert.
 */
export function deliveryConfig(env=process.env) {
  let webhook=null;
  if (env.ALERT_WEBHOOK_URL) {
    try { const u=new URL(env.ALERT_WEBHOOK_URL);if (u.protocol==='https:' && !u.username && !u.password) webhook=u.toString(); } catch {}
  }
  const emailReady=Boolean(env.ALERT_EMAIL_TO && env.ALERT_EMAIL_FROM && env.RESEND_API_KEY);
  return {
    webhook:{enabled:Boolean(webhook),url:webhook,signed:Boolean(webhook && env.ALERT_WEBHOOK_SECRET),secret:env.ALERT_WEBHOOK_SECRET || null,
      enableWith:'Set ALERT_WEBHOOK_URL (https) and optionally ALERT_WEBHOOK_SECRET on the engine service.'},
    email:{enabled:emailReady,to:emailReady ? String(env.ALERT_EMAIL_TO).split(',').map(s=>s.trim()).filter(Boolean) : [],from:env.ALERT_EMAIL_FROM || null,apiKey:env.RESEND_API_KEY || null,
      enableWith:'Set ALERT_EMAIL_TO, ALERT_EMAIL_FROM and RESEND_API_KEY on the engine service.'}
  };
}
export function publicDeliveryConfig(config) {
  return {feed:{enabled:true},webhook:{enabled:config.webhook.enabled,signed:config.webhook.signed,enableWith:config.webhook.enableWith},
    email:{enabled:config.email.enabled,recipients:config.email.to.length,enableWith:config.email.enableWith}};
}
export async function deliverAlert(alert,config,{fetchImpl=fetch}={}) {
  const payload={event:'alert.opened',alert:{id:alert.fingerprint,type:alert.type,severity:alert.severity,labelId:alert.labelId,source:alert.source,
    message:alert.message,observed:alert.observed ?? null,expected:alert.expected ?? null},sentAt:new Date().toISOString(),service:'music-operations-engine'};
  const errors=[];
  if (config.webhook.enabled) {
    const body=JSON.stringify(payload),headers={'content-type':'application/json'};
    if (config.webhook.secret) headers['x-alert-signature']='sha256='+createHmac('sha256',config.webhook.secret).update(body).digest('hex');
    try { const r=await fetchImpl(config.webhook.url,{method:'POST',headers,body,redirect:'error',signal:AbortSignal.timeout(10000)});await r.body?.cancel?.();if (!r.ok) errors.push('webhook_'+r.status); }
    catch { errors.push('webhook_unreachable'); }
  }
  if (config.email.enabled) {
    try {
      const r=await fetchImpl('https://api.resend.com/emails',{method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),
        headers:{authorization:'Bearer '+config.email.apiKey,'content-type':'application/json'},
        body:JSON.stringify({from:config.email.from,to:config.email.to,subject:`[${alert.severity}] ${alert.labelId}: ${alert.message}`.slice(0,200),
          text:`${alert.message}\n\nLabel: ${alert.labelId}\nSource: ${alert.source}\nType: ${alert.type}\nSeverity: ${alert.severity}\n\nOpen the Command Center alert feed to acknowledge.`})});
      await r.body?.cancel?.();if (!r.ok) errors.push('email_'+r.status);
    } catch { errors.push('email_unreachable'); }
  }
  return errors.length ? errors.join(',') : null;
}

/** Budget alerts derived from budgets-with-actuals rows. */
export function budgetAlerts(budgets) {
  const out=[];
  for (const b of budgets) {
    if (b.status==='over') out.push({type:'budget_overrun',severity:BigInt(b.spentMinor)*10n>BigInt(b.amountMinor)*12n ? 'critical' : 'warning',labelId:b.labelId,source:'budget',
      budgetId:b.id,metric:b.id,observed:{spentMinor:b.spentMinor,currency:b.currency},expected:{amountMinor:b.amountMinor},
      message:`Budget "${b.name}" (${b.period}) is over by ${(BigInt(b.spentMinor)-BigInt(b.amountMinor)).toString()} ${b.currency} minor units`});
    else if (b.status==='near-limit') out.push({type:'budget_near_limit',severity:'warning',labelId:b.labelId,source:'budget',budgetId:b.id,metric:b.id,
      observed:{spentMinor:b.spentMinor,currency:b.currency},expected:{amountMinor:b.amountMinor},
      message:`Budget "${b.name}" (${b.period}) has used ${Math.floor(b.utilizationBps/100)}%`});
  }
  return out;
}
