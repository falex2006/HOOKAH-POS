import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {validateQaDatabaseUrl,assertQaDatabaseIdentity} from './postgres-qa-safety.mjs';
const {Client}=createRequire(import.meta.url)('pg');
const target=validateQaDatabaseUrl(process.env.MIGRATIONS_PG_TEST_DATABASE_URL);
assert.match(target.database,/^inventory_qa_[a-f0-9]{16}$/);assert.equal(target.database,process.env.LOCAL_FULL_PG_OWNED_DATABASE);
const db=new Client({connectionString:target.url.href});
const schema=`payroll_overlap_constraint_${process.pid}_${Date.now()}`;
const sql=readFileSync(new URL('../docs/requirements/sql/payroll-entry-overlap-constraint.sql',import.meta.url),'utf8');
const site=randomUUID(),user=randomUUID();let peers=[];
const insert=async(client,{from='2026-10-01',to='2026-10-10',status='draft',venue=site,employee=user,rule=null}={})=>{
 const id=randomUUID();await client.query('INSERT INTO payroll_entries VALUES($1,$2,$3,$4,$5,$6,$7)',[id,venue,employee,rule,status,from,to]);return id;};
const apply=async()=>{await db.query('BEGIN');try{await db.query(sql);await db.query('COMMIT');}catch(error){await db.query('ROLLBACK');throw error;}};
const reject=async(action,codes)=>assert.rejects(action,e=>codes.includes(e.code));
try{
 await db.connect();assertQaDatabaseIdentity((await db.query('SELECT current_database() database,inet_server_addr() address,inet_server_port() port,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) superuser')).rows[0],target.database,Number(target.url.port));
 await db.query(`CREATE SCHEMA "${schema}"`);await db.query(`SET search_path TO "${schema}",public`);
 await db.query('CREATE TABLE payroll_entries(id uuid PRIMARY KEY,venue_id uuid,user_id uuid,rule_id uuid,status text,period_from date,period_to date)');
 await insert(db);const conflict=await insert(db,{from:'2026-10-10',to:'2026-10-20',rule:randomUUID(),status:'paid'});
 const before=(await db.query('SELECT * FROM payroll_entries ORDER BY id')).rows;
 await reject(apply,['23P01']);assert.deepEqual((await db.query('SELECT * FROM payroll_entries ORDER BY id')).rows,before,'failed upgrade preserves legacy rows');
 assert.equal((await db.query("SELECT count(*)::int n FROM pg_constraint WHERE conrelid='payroll_entries'::regclass AND conname LIKE 'payroll_entries_active_%'")).rows[0].n,0);
 // Explicit fixture resolution, never performed by the candidate migration.
 await db.query("UPDATE payroll_entries SET status='cancelled' WHERE id=$1",[conflict]);
 const invalid=await insert(db,{from:null});await reject(apply,['23514']);
 assert.equal((await db.query('SELECT period_from FROM payroll_entries WHERE id=$1',[invalid])).rows[0].period_from,null);
 await db.query('DELETE FROM payroll_entries WHERE id=$1',[invalid]);
 // Same-name weak constraints must fail without being silently accepted or repaired.
 for (const name of ['payroll_entries_active_period_valid','payroll_entries_active_period_exclusion']) {
  await db.query(`ALTER TABLE payroll_entries ADD CONSTRAINT ${name} CHECK (true)`);
  await assert.rejects(apply,e=>e.code==='23514'&&e.message.includes('constraint_definition_mismatch'));
  assert.equal((await db.query("SELECT pg_get_constraintdef(oid) definition FROM pg_constraint WHERE conrelid='payroll_entries'::regclass AND conname=$1",[name])).rows[0].definition,'CHECK (true)');
  await db.query(`ALTER TABLE payroll_entries DROP CONSTRAINT ${name}`);
 }
 await apply();await apply();
 await reject(()=>insert(db,{from:'2026-10-10',to:'2026-10-11',rule:randomUUID()}),['23P01']);
 await insert(db,{from:'2026-10-11',to:'2026-10-20',status:'approved',rule:randomUUID()});
 await insert(db,{employee:randomUUID()});await insert(db,{venue:randomUUID()});await insert(db,{status:'cancelled'});
 await reject(()=>db.query("UPDATE payroll_entries SET status='approved' WHERE id=$1",[conflict]),['23P01']);
 for(const row of [{from:null},{to:null},{from:'infinity',to:'infinity'},{from:'-infinity'},{from:'2026-11-02',to:'2026-11-01'},{venue:null},{employee:null}]) await reject(()=>insert(db,row),['23514','22000']);
 const racer=randomUUID();peers=[new Client({connectionString:target.url.href}),new Client({connectionString:target.url.href})];
 for(const client of peers){await client.connect();await client.query(`SET search_path TO "${schema}",public`);}
 const raced=await Promise.allSettled(peers.map((client,index)=>insert(client,{employee:racer,from:index?'2026-12-15':'2026-12-01',to:index?'2026-12-31':'2026-12-15',rule:index?randomUUID():null})));
 assert.equal(raced.filter(x=>x.status==='fulfilled').length,1);const rejected=raced.filter(x=>x.status==='rejected');
 assert.equal(rejected.length,1);assert.ok(['23P01','40P01'].includes(rejected[0].reason.code),`unexpected race error: ${rejected[0].reason.code}`);
 // GiST concurrent insertions may deadlock; after the winner commits a retry
 // must still reject the losing interval as an exclusion violation.
 const loser=raced.findIndex(x=>x.status==='rejected');
 await reject(()=>insert(peers[loser],{employee:racer,from:loser?'2026-12-15':'2026-12-01',to:loser?'2026-12-31':'2026-12-15',rule:loser?randomUUID():null}),['23P01']);
 assert.equal((await db.query('SELECT count(*)::int n FROM payroll_entries WHERE user_id=$1',[racer])).rows[0].n,1);
 console.log('PASS payroll-entry-overlap-constraint-postgres-qa: locked preflight, unchanged conflicting history, replay, concurrent all-rule exclusion, inclusive boundaries and invalid active rows');
}finally{for(const client of peers)await client.end().catch(()=>{});await db.query('ROLLBACK').catch(()=>{});await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(()=>{});await db.end();}
