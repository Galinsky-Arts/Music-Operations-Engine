import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {randomBytes} from 'node:crypto';
import {createStore} from '../src/store.js';
import {runDrill} from '../scripts/backup-drill.mjs';
import {labels,catalog} from './helpers.js';

test('backup drill matches an exact copy and detects drift',{skip:!process.env.TEST_DATABASE_URL && 'needs TEST_DATABASE_URL (PostgreSQL)'},async()=>{
  const base=process.env.TEST_DATABASE_URL,a='drill_a_'+randomBytes(6).toString('hex'),b='drill_b_'+randomBytes(6).toString('hex');
  const admin=new pg.Pool({connectionString:base});
  await admin.query('CREATE SCHEMA '+a);await admin.query('CREATE SCHEMA '+b);
  const url=s=>{const u=new URL(base);u.searchParams.set('options','-c search_path='+s);return u.toString();};
  try {
    const pool=new pg.Pool({connectionString:base,options:'-c search_path='+a});
    const store=await createStore(pool);await labels(store);await catalog(store);
    await store.upsert([{id:'x',labelId:'alpha',source:'s',externalId:'e',type:'stream',occurredAt:'2026-11-01T00:00:00.000Z',quantity:3,amountMinor:0,currency:'USD',artist:'',release:'',track:'',channel:'',territory:'',metadata:{}}]);
    await store.close();
    const tables=(await admin.query(`SELECT table_name FROM information_schema.tables WHERE table_schema=$1`,[a])).rows.map(r=>r.table_name);
    for (const t of tables) await admin.query(`CREATE TABLE ${b}.${t} AS TABLE ${a}.${t}`);
    let r=await runDrill(url(a),url(b));
    assert.equal(r.match,true);assert.ok(r.tableCount>=20);assert.equal(r.mismatches.length,0);
    await admin.query(`UPDATE ${b}.music_facts SET quantity=4`);
    r=await runDrill(url(a),url(b));
    assert.equal(r.match,false);assert.deepEqual(r.mismatches.map(m=>[m.table,m.rowsMatch,m.digestMatch]),[['music_facts',true,false]]);
  } finally { await admin.query(`DROP SCHEMA ${a} CASCADE`);await admin.query(`DROP SCHEMA ${b} CASCADE`);await admin.end(); }
});
