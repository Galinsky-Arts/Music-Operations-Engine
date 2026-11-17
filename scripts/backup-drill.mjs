// Backup/restore drill: compare every engine table between two databases (e.g. a Neon backup branch and a
// branch restored from it) by row count and an order-independent content digest. Strictly read-only:
// each side runs in a READ ONLY, REPEATABLE READ transaction. Prints JSON without connection details.
// Usage: BACKUP_DRILL_SOURCE_URL=... BACKUP_DRILL_TARGET_URL=... node scripts/backup-drill.mjs
import pg from 'pg';
import {pathToFileURL} from 'node:url';

export async function snapshot(connectionString) {
  const client=new pg.Client({connectionString});
  await client.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const tables=(await client.query(`SELECT table_name FROM information_schema.tables
WHERE table_schema=current_schema() AND table_type='BASE TABLE' AND table_name LIKE 'music\\_%' ORDER BY table_name`)).rows.map(r=>r.table_name);
    const out={};
    for (const t of tables) {
      const r=(await client.query(`SELECT count(*)::text AS rows,COALESCE(md5(string_agg(h,'' ORDER BY h)),md5('')) AS digest
FROM (SELECT md5(x::text) AS h FROM ${client.escapeIdentifier(t)} x) s`)).rows[0];
      out[t]={rows:r.rows,digest:r.digest};
    }
    const version=(await client.query('SELECT COALESCE(max(version),0) AS v FROM music_schema_migrations')).rows[0].v;
    await client.query('COMMIT');
    return {schemaVersion:Number(version),tables:out};
  } finally { await client.end(); }
}

export function compare(source,target) {
  const names=[...new Set([...Object.keys(source.tables),...Object.keys(target.tables)])].sort();
  const tables=names.map(name=>{const a=source.tables[name],b=target.tables[name];
    return {table:name,sourceRows:a?.rows ?? null,targetRows:b?.rows ?? null,rowsMatch:a?.rows===b?.rows,digestMatch:Boolean(a&&b&&a.digest===b.digest)};});
  return {match:source.schemaVersion===target.schemaVersion && tables.every(t=>t.rowsMatch&&t.digestMatch),
    schemaVersion:{source:source.schemaVersion,target:target.schemaVersion},tableCount:names.length,
    totalRows:{source:tables.reduce((s,t)=>s+BigInt(t.sourceRows||0),0n).toString(),target:tables.reduce((s,t)=>s+BigInt(t.targetRows||0),0n).toString()},
    mismatches:tables.filter(t=>!t.rowsMatch||!t.digestMatch),tables};
}

export async function runDrill(sourceUrl,targetUrl) {
  if (!sourceUrl || !targetUrl) throw new Error('BACKUP_DRILL_SOURCE_URL and BACKUP_DRILL_TARGET_URL are required');
  const startedAt=new Date().toISOString();
  const [source,target]=await Promise.all([snapshot(sourceUrl),snapshot(targetUrl)]);
  return {event:'backup.drill',startedAt,finishedAt:new Date().toISOString(),...compare(source,target)};
}

if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  runDrill(process.env.BACKUP_DRILL_SOURCE_URL,process.env.BACKUP_DRILL_TARGET_URL)
    .then(r=>{console.log(JSON.stringify(r,null,2));process.exitCode=r.match ? 0 : 2;})
    .catch(e=>{console.error('Drill failed: '+e.message);process.exitCode=1;});
}
