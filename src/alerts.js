/**
 * Deterministic operational alerts. They are derived on request from stored facts and job state;
 * delivery (email/chat/paging) and acknowledgement state are deployment concerns outside the engine.
 */
export const alertDefaults=Object.freeze({staleHours:48,backlogMinutes:60,minBaseline:10,dropRatio:0.2,spikeRatio:5});

export function evaluateAlerts({freshness=[],jobs=[],daily=[],window},{now,staleHours=alertDefaults.staleHours,backlogMinutes=alertDefaults.backlogMinutes,
  minBaseline=alertDefaults.minBaseline,dropRatio=alertDefaults.dropRatio,spikeRatio=alertDefaults.spikeRatio}={}) {
  const alerts=[],at=now.getTime();
  for (const f of freshness) {
    const age=(at-Date.parse(f.lastIngestedAt))/3600000;
    if (age>staleHours) alerts.push({type:'source_stale',severity:age>staleHours*3 ? 'critical' : 'warning',labelId:f.labelId,source:f.source,
      observed:{lastIngestedAt:f.lastIngestedAt,hoursSinceIngest:Math.floor(age)},expected:{maxHours:staleHours},
      message:`No ${f.source} data ingested for ${Math.floor(age)} hours`});
  }
  for (const j of jobs) {
    if (j.deadLetter>0) alerts.push({type:'jobs_dead_letter',severity:'critical',labelId:j.labelId,source:j.source,
      observed:{deadLetter:j.deadLetter},expected:{deadLetter:0},message:`${j.deadLetter} ${j.source} job(s) dead-lettered`});
    if (j.backlog>0 && j.oldestReadyAt && (at-Date.parse(j.oldestReadyAt))/60000>backlogMinutes) {
      const minutes=Math.floor((at-Date.parse(j.oldestReadyAt))/60000);
      alerts.push({type:'jobs_backlog_stale',severity:'warning',labelId:j.labelId,source:j.source,
        observed:{backlog:j.backlog,oldestReadyAt:j.oldestReadyAt,minutesWaiting:minutes},expected:{maxMinutes:backlogMinutes},
        message:`${j.backlog} ${j.source} job(s) waiting ${minutes} minutes`});
    }
  }
  // Volume anomalies: the last complete UTC day against the mean of the preceding days in the window.
  if (window) {
    const lastDay=new Date(Date.parse(window.to)-86400000).toISOString().slice(0,10);
    const series=new Map();
    for (const row of daily) {
      const key=JSON.stringify([row.labelId,row.source,row.type]);
      if (!series.has(key)) series.set(key,new Map());
      series.get(key).set(row.date,BigInt(row.quantity));
    }
    const days=[];for (let t=Date.parse(window.from);t<Date.parse(window.to)-86400000;t+=86400000) days.push(new Date(t).toISOString().slice(0,10));
    for (const [key,values] of series) {
      const [labelId,source,type]=JSON.parse(key);
      const baseline=days.reduce((sum,d)=>sum+(values.get(d) ?? 0n),0n);
      const mean=Number(baseline)/days.length;
      if (!days.length || mean<minBaseline) continue;
      const observed=Number(values.get(lastDay) ?? 0n);
      const ratio=observed/mean;
      if (ratio<=dropRatio || ratio>=spikeRatio) alerts.push({type:ratio<=dropRatio ? 'volume_drop' : 'volume_spike',
        severity:observed===0 ? 'critical' : 'warning',labelId,source,metric:type,
        observed:{date:lastDay,quantity:String(values.get(lastDay) ?? 0n)},expected:{dailyMean:Math.round(mean*100)/100,baselineDays:days.length},
        message:`${source} ${type} volume on ${lastDay} was ${Math.round(ratio*100)}% of the ${days.length}-day mean`});
    }
  }
  const rank={critical:0,warning:1};
  return alerts.sort((a,b)=>rank[a.severity]-rank[b.severity] || a.type.localeCompare(b.type) || a.labelId.localeCompare(b.labelId) || a.source.localeCompare(b.source));
}
