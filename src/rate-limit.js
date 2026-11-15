/**
 * In-memory sliding-window failure limiter for authentication endpoints.
 * Single-process scope: each replica limits independently. Memory is bounded by maxKeys.
 */
export function createFailureLimiter({windowMs=15*60*1000,limit=10,maxKeys=20000,now=()=>Date.now()}={}) {
  const failures=new Map();
  const recent=(key,t)=>(failures.get(key)||[]).filter(x=>t-x<windowMs);
  return Object.freeze({
    retryAfterSeconds(...keys) {
      const t=now();let wait=0;
      for (const key of keys) {
        const list=recent(key,t);
        if (list.length>=limit) wait=Math.max(wait,Math.ceil((list[list.length-limit]+windowMs-t)/1000));
      }
      return wait>0 ? Math.max(1,wait) : 0;
    },
    fail(...keys) {
      const t=now();
      if (failures.size>=maxKeys) for (const [key] of failures) { if (!recent(key,t).length) failures.delete(key); }
      if (failures.size>=maxKeys) failures.clear();
      for (const key of keys) failures.set(key,[...recent(key,t),t].slice(-limit*2));
    },
    reset(...keys) { for (const key of keys) failures.delete(key); }
  });
}
export function clientAddress(req,trustProxy=false) {
  if (trustProxy) {
    const forwarded=req.headers['true-client-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (forwarded) return String(forwarded).slice(0,64);
  }
  return req.socket?.remoteAddress || 'unknown';
}
