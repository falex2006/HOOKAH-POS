import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {validateQaDatabaseUrl,assertQaDatabaseIdentity} from './postgres-qa-safety.mjs';
import {canTransitionPayroll,calculatePayrollAmount,countInclusiveDays,isValidIsoDate} from '../payroll.js';
const {Client,Pool}=createRequire(import.meta.url)('pg');
const target=validateQaDatabaseUrl(process.env.MIGRATIONS_PG_TEST_DATABASE_URL);
assert.match(target.database,/^inventory_qa_[a-f0-9]{16}$/);
assert.equal(target.database,process.env.LOCAL_FULL_PG_OWNED_DATABASE);
const db=new Client({connectionString:target.url.href});
const pool=new Pool({connectionString:target.url.href,max:4});
const sql=fs.readFileSync(new URL('../docs/requirements/sql/payroll-entry-overlap-constraint.sql',import.meta.url),'utf8');
const source=fs.readFileSync(new URL('../server.js',import.meta.url),'utf8');
const start=source.indexOf('const payrollEntryPath = pathname.match(');
const end=source.indexOf("if (pathname === '/api/inventory/auto-orders'",start);
assert.ok(start>=0&&end>start);
const route=source.slice(start,end);
let venue,user,ruleA,ruleB;
const call=async(method,path,input={})=>{
 let response;
 const result=await new Function('pathname','req','res','url','repositories','venueDbId','denyUnless','body','json','recordAudit','today','isValidIsoDate','countInclusiveDays','calculatePayrollAmount','canTransitionPayroll',`return (async()=>{${route}})();`)(
  path,{method,user:{id:user}}, {},new URL(`http://local${path}`),{pool},venue,()=>false,async()=>input,
  (_res,status,data)=>response={status,data},()=>{},()=> '2026-10-20',isValidIsoDate,countInclusiveDays,calculatePayrollAmount,canTransitionPayroll);
 return response||result;
};
try{
 await db.connect();
 assertQaDatabaseIdentity((await db.query('SELECT current_database() database,inet_server_addr() address,inet_server_port() port,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) superuser')).rows[0],target.database,Number(target.url.port));
 venue=(await db.query("INSERT INTO venues(name,timezone) VALUES('Payroll real schema QA','Asia/Yekaterinburg') RETURNING id")).rows[0].id;
 user=(await db.query("INSERT INTO users(venue_id,full_name,login,role) VALUES($1,'Payroll overlap QA',$2,'bartender') RETURNING id",[venue,`payroll-overlap-${process.pid}`])).rows[0].id;
 ruleA=(await db.query("INSERT INTO payroll_rules(venue_id,name,rule_type,rate) VALUES($1,'A','hourly',100) RETURNING id",[venue])).rows[0].id;
 ruleB=(await db.query("INSERT INTO payroll_rules(venue_id,name,rule_type,rate) VALUES($1,'B','hourly',100) RETURNING id",[venue])).rows[0].id;
 // Current schema accepts legacy overlapping drafts. Upgrade must abort without
 // altering either row; this QA fixture explicitly removes the collision.
 const legacyA=(await db.query("INSERT INTO payroll_entries(venue_id,user_id,rule_id,period_from,period_to,amount,status) VALUES($1,$2,$3,'2026-09-01','2026-09-10',0,'draft') RETURNING id",[venue,user,ruleA])).rows[0].id;
 const legacyB=(await db.query("INSERT INTO payroll_entries(venue_id,user_id,rule_id,period_from,period_to,amount,status) VALUES($1,$2,$3,'2026-09-10','2026-09-20',0,'draft') RETURNING id",[venue,user,ruleB])).rows[0].id;
 const legacyBefore=(await db.query('SELECT * FROM payroll_entries WHERE id=ANY($1::uuid[]) ORDER BY id',[[legacyA,legacyB]])).rows;
 await db.query('BEGIN');await assert.rejects(()=>db.query(sql),e=>e.code==='23P01'&&e.message.includes('overlap_preflight'));await db.query('ROLLBACK');
 assert.deepEqual((await db.query('SELECT * FROM payroll_entries WHERE id=ANY($1::uuid[]) ORDER BY id',[[legacyA,legacyB]])).rows,legacyBefore);
 await db.query('DELETE FROM payroll_entries WHERE id=ANY($1::uuid[])',[[legacyA,legacyB]]);
 await db.query('BEGIN');try{await db.query(sql);await db.query('COMMIT');}catch(e){await db.query('ROLLBACK');throw e;}
 await db.query('BEGIN');try{await db.query(sql);await db.query('COMMIT');}catch(e){await db.query('ROLLBACK');throw e;}
 await db.query("INSERT INTO staff_work_logs(venue_id,user_id,started_at,ended_at,source) VALUES($1,$2,'2026-10-05T05:00:00Z','2026-10-05T13:00:00Z','manual')",[venue,user]);
 const a=await call('POST','/api/payroll/entries',{userId:user,ruleId:ruleA,periodFrom:'2026-10-01',periodTo:'2026-10-10'});
 assert.equal(a.status,201,JSON.stringify(a));assert.equal(a.data.amount,800);
 const replay=await call('POST','/api/payroll/entries',{userId:user,ruleId:ruleA,periodFrom:'2026-10-01',periodTo:'2026-10-10'});
 assert.equal(replay.status,201);assert.equal(replay.data.id,a.data.id);
 const clash=await call('POST','/api/payroll/entries',{userId:user,ruleId:ruleB,periodFrom:'2026-10-10',periodTo:'2026-10-20'});
 assert.equal(clash.status,409,JSON.stringify(clash));assert.equal(clash.data.error,'payroll_period_overlap');
 const approved=await call('PATCH',`/api/payroll/entries/${a.data.id}`,{action:'approve'});
 assert.equal(approved.status,200,JSON.stringify(approved));
 const stillClash=await call('POST','/api/payroll/entries',{userId:user,ruleId:ruleB,periodFrom:'2026-10-10',periodTo:'2026-10-20'});
 assert.equal(stillClash.status,409);assert.equal(stillClash.data.error,'payroll_period_overlap');
 const adjacent=await call('POST','/api/payroll/entries',{userId:user,ruleId:ruleB,periodFrom:'2026-10-11',periodTo:'2026-10-20'});
 assert.equal(adjacent.status,201,JSON.stringify(adjacent));
 assert.equal((await db.query('SELECT count(*)::int n FROM payroll_entries WHERE venue_id=$1',[venue])).rows[0].n,2);
 const race=await Promise.all([
  call('POST','/api/payroll/entries',{userId:user,ruleId:ruleA,periodFrom:'2026-11-01',periodTo:'2026-11-15'}),
  call('POST','/api/payroll/entries',{userId:user,ruleId:ruleB,periodFrom:'2026-11-15',periodTo:'2026-11-30'}),
 ]);
 assert.deepEqual(race.map(x=>x.status).sort(),[201,409],JSON.stringify(race));
 assert.equal((await db.query("SELECT count(*)::int n FROM payroll_entries WHERE venue_id=$1 AND period_from >= '2026-11-01'",[venue])).rows[0].n,1);
 const retryIndex=race.findIndex(x=>x.status===409);
 const retry=await call('POST','/api/payroll/entries',{userId:user,ruleId:retryIndex?ruleB:ruleA,periodFrom:retryIndex?'2026-11-15':'2026-11-01',periodTo:retryIndex?'2026-11-30':'2026-11-15'});
 assert.equal(retry.status,409);assert.equal(retry.data.error,'payroll_period_overlap');

 assert.equal((await db.query("SELECT count(*)::int n FROM expenses WHERE venue_id=$1 AND source='payroll'",[venue])).rows[0].n,0);
 const bank=(await db.query("INSERT INTO finance_accounts(venue_id,code,name,kind,allowed_payment_methods) VALUES($1,'overlap_qa_bank','Overlap QA bank','bank',ARRAY['bank_transfer']::text[]) RETURNING id",[venue])).rows[0].id;
 const payment={action:'pay',paymentDate:'2026-10-20',paymentAccountId:bank,paymentMethod:'bank_transfer'};
 const paid=await call('PATCH',`/api/payroll/entries/${a.data.id}`,payment);
 assert.equal(paid.status,200,JSON.stringify(paid));assert.ok(paid.data.expense_id);
 const paidAgain=await call('PATCH',`/api/payroll/entries/${a.data.id}`,payment);
 assert.equal(paidAgain.status,409);
 assert.equal((await db.query("SELECT count(*)::int n FROM expenses WHERE venue_id=$1 AND source='payroll'",[venue])).rows[0].n,1);
 const expense=(await db.query("SELECT id,amount FROM expenses WHERE venue_id=$1 AND source='payroll'",[venue])).rows[0];
 assert.equal(Number(expense.amount),800);assert.equal(expense.id,paid.data.expense_id);
 assert.equal((await db.query('SELECT expense_id,amount FROM payroll_entries WHERE id=$1',[a.data.id])).rows[0].expense_id,expense.id);
 console.log('PASS payroll-entry-overlap-real-schema-qa: migration-built table, replay, extracted route draft/approve/pay with real PG, concurrent cross-rule overlap, adjacent, single expense');
}finally{if(venue)await db.query('DELETE FROM venues WHERE id=$1',[venue]).catch(()=>{});await pool.end();await db.end();}
