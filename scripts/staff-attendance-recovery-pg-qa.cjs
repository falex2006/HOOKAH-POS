'use strict';
// Real service + HTTP recovery proof in a fresh guarded disposable database.
// Reuses the established runtime creator, never a preview/shared QA database.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {randomUUID,createHash}=require('node:crypto');
const {Pool}=require('pg');
const {createRuntime,freePort,startServer,stopServer,root}=require('./staff-attendance-http-qa.cjs');
const {options}=require('./staff-schedule-local-config.cjs');
const m=require('../staff-attendance-mutations');
const s=require('../staff-attendance-service');
const {resolveAttendanceAccess}=require('../staff-attendance-access');
const key=()=>({requestKey:randomUUID()});
const json=value=>JSON.parse(JSON.stringify(value));
const owned=['staff-attendance-access.js','staff-attendance-service.js','staff-attendance-mutations.js','staff-attendance-routes.js','migrations/115_staff_attendance_recovery.sql'];
const hashes=()=>Object.fromEntries(owned.map(file=>[file,createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex')]));
const loadedHashes=hashes();
const reject=(promise,code)=>assert.rejects(promise,error=>error.code===code);

async function main(){
  assert(process.argv.includes('--run'),'Explicit --run required');
  const runtime=await createRuntime(`attendance_http_recovery_${Date.now()}_${randomUUID().slice(0,8)}`);
  const pool=new Pool({...options(runtime.cfg),max:6,connectionTimeoutMillis:10000,statement_timeout:15000,lock_timeout:10000});
  let child,checks=0;
  const check=async(label,run)=>{await run();console.log(`PASS ${++checks}: ${label}`);};
  const users=Object.fromEntries(runtime.fixtures.users.map(u=>[u.label,u]));
  const actor=label=>({userId:users[label].id,venueId:runtime.fixtures.venues[users[label].tenant]});
  const owner=actor('owner'),employee=actor('employee'),manager=actor('manager'),admin=actor('admin'),foreign=actor('foreign');
  const grant=async(label,fields={})=>{
    const row=(await pool.query('SELECT version FROM staff_attendance_grants WHERE venue_id=$1 AND user_id=$2',[owner.venueId,users[label].id])).rows[0];
    return m.saveGrant(pool,owner,{...key(),userId:users[label].id,version:row?.version||0,managePolicy:false,approve:false,...fields});
  };
  const open=()=>m.start(pool,employee,key());
  const closeInput=session=>({...key(),id:session.id,version:session.version,reason:'Сотрудник забыл завершить работу'});
  const row=async id=>(await pool.query('SELECT * FROM staff_attendance_sessions WHERE id=$1',[id])).rows[0];
  try{
    const protectedNames=(await pool.query(`SELECT tablename FROM pg_tables WHERE schemaname='public'
      AND (tablename LIKE 'payroll_%' OR tablename LIKE 'staff_schedule%' OR tablename='staff_work_logs'
      OR tablename LIKE 'shift%' OR tablename LIKE 'order%' OR tablename LIKE 'payment%'
      OR tablename LIKE 'stock%' OR tablename LIKE 'inventory_%' OR tablename='expenses') ORDER BY tablename`)).rows.map(r=>r.tablename);
    const snapshot=async()=>{
      const result={};for(const table of protectedNames){assert.match(table,/^[a-z0-9_]+$/);result[table]=(await pool.query(`SELECT count(*)::text count,
        md5(coalesce(string_agg(h,'' ORDER BY h),'')) hash FROM (SELECT md5(row_to_json(t)::text) h FROM "${table}" t) r`)).rows[0];}return result;
    };
    const baseline=await snapshot();
    await check('independent grant defaults and legacy saveGrant preservation',async()=>{
      assert.equal((await resolveAttendanceAccess(pool,owner)).closeSessions,true);
      assert.equal((await resolveAttendanceAccess(pool,manager)).closeSessions,false);
      assert.equal((await grant('admin',{approve:true})).closeSessions,false);
      assert.equal((await grant('manager',{closeSessions:true})).closeSessions,true);
      assert.equal((await grant('manager',{approve:true})).closeSessions,true);
      assert.equal((await grant('manager',{closeSessions:false})).closeSessions,false);
      await grant('manager',{closeSessions:true});
      const access=await resolveAttendanceAccess(pool,manager);
      assert.equal(access.closeSessions,true);assert.equal(access.approve,false);assert.equal(access.managePolicy,false);assert.equal(access.grant,false);
      await reject(m.saveGrant(pool,manager,{...key(),userId:admin.userId,version:1,managePolicy:false,approve:false,closeSessions:true}),'attendance_forbidden');
    });
    await check('close-only management visibility; approval alone does not close',async()=>{
      const session=await open(),input=closeInput(session);
      const page=await s.management(pool,manager);
      assert(page.sessions.some(item=>item.id===session.id&&item.userId===employee.userId));
      assert.deepEqual(page.requests,[]);assert.deepEqual(page.grants,[]);
      assert((await s.management(pool,admin)).sessions.some(item=>item.id===session.id));
      await reject(m.closeSession(pool,admin,input),'attendance_forbidden');
      await reject(m.closeSession(pool,employee,input),'attendance_forbidden');
      await reject(m.closeSession(pool,foreign,input),'attendance_session_conflict');
      await reject(m.closeSession(pool,manager,{...input,version:0}),'attendance_session_conflict');
      await m.closeSession(pool,manager,input);
    });
    let closed,input;
    await check('server-time recovery; before/after immutable event; replay conflict',async()=>{
      const session=await open();input=closeInput(session);
      const lower=(await pool.query('SELECT clock_timestamp() now')).rows[0].now;
      closed=await m.closeSession(pool,manager,input);
      const upper=(await pool.query('SELECT clock_timestamp() now')).rows[0].now;
      assert(new Date(closed.endedAt)>=lower&&new Date(closed.endedAt)<=upper);
      assert.equal(closed.endedBy,manager.userId);assert.equal(closed.endReason,input.reason);assert.equal(closed.userId,employee.userId);
      assert.equal(closed.version,session.version+1);
      assert.deepEqual(json(await m.closeSession(pool,manager,input)),json(closed));
      await reject(m.closeSession(pool,manager,{...input,reason:'Другая причина'}),'attendance_idempotency_conflict');
      await reject(m.closeSession(pool,manager,{...input,...key()}),'attendance_session_conflict');
      const events=(await pool.query("SELECT * FROM staff_attendance_events WHERE entity_id=$1 AND action='manager_end'",[session.id])).rows;
      assert.equal(events.length,1);assert.equal(events[0].before_json.endedAt,null);
      assert.equal(events[0].before_json.version,session.version);assert.equal(events[0].after_json.endedBy,manager.userId);
      assert.deepEqual(events[0].after_json,json(closed));
      await assert.rejects(pool.query("UPDATE staff_attendance_events SET action='changed' WHERE id=$1",[events[0].id]),{code:'55000'});
    });
    await check('latestSession note visible only to subject; active semantics unchanged',async()=>{
      let status=await s.selfStatus(pool,employee);
      assert.equal(status.session,null);assert.equal(status.latestSession.id,closed.id);assert.equal(status.latestSession.endReason,input.reason);
      assert.equal((await s.selfStatus(pool,admin)).latestSession,null);
      const session=await open();status=await s.selfStatus(pool,employee);
      assert.equal(status.session.id,session.id);assert.equal(status.admission,null);assert.equal(status.latestSession.id,closed.id);
      const ended=await m.end(pool,employee,{...key(),id:session.id,version:session.version});
      assert.equal(ended.endedBy,null);assert.equal(ended.endReason,null);
      assert.equal((await s.selfStatus(pool,employee)).latestSession.id,session.id);
    });
    await check('own recovery prohibited; normal end remains available',async()=>{
      const session=await m.start(pool,manager,key());
      await reject(m.closeSession(pool,manager,closeInput(session)),'attendance_own_session_use_end');
      await m.end(pool,manager,{...key(),id:session.id,version:session.version});
    });
    await check('self end racing recovery has one winner and no double event',async()=>{
      const session=await open();
      const results=await Promise.allSettled([m.end(pool,employee,{...key(),id:session.id,version:session.version}),m.closeSession(pool,manager,closeInput(session))]);
      assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
      assert.equal(results.find(r=>r.status==='rejected').reason.code,'attendance_session_conflict');
      assert.equal((await row(session.id)).version,2);
      assert.equal((await pool.query("SELECT count(*)::int n FROM staff_attendance_events WHERE entity_id=$1 AND action IN ('end','manager_end')",[session.id])).rows[0].n,1);
    });
    await check('concurrent identical recovery replays; revoked grant cannot replay',async()=>{
      const session=await open(),body=closeInput(session);
      const results=await Promise.all([m.closeSession(pool,manager,body),m.closeSession(pool,manager,body)]);
      assert.deepEqual(json(results[0]),json(results[1]));
      await grant('manager',{closeSessions:false});
      await reject(m.closeSession(pool,manager,body),'attendance_forbidden');
      await grant('manager',{closeSessions:true});
    });
    await check('deactivated subject can be recovered; inactive actor cannot',async()=>{
      const session=await open();
      await pool.query('UPDATE users SET is_active=false WHERE id=ANY($1::uuid[])',[[employee.userId,manager.userId]]);
      try{
        await reject(m.closeSession(pool,manager,closeInput(session)),'attendance_forbidden');
        await m.closeSession(pool,owner,closeInput(session));
      }finally{await pool.query('UPDATE users SET is_active=true WHERE id=ANY($1::uuid[])',[[employee.userId,manager.userId]]);}
    });
    await check('migration constraints, actor organization guard and replay preserve data',async()=>{
      const session=await open();
      for(const [sql,args] of [
        ['UPDATE staff_attendance_sessions SET ended_by=$2 WHERE id=$1',[session.id,manager.userId]],
        ["UPDATE staff_attendance_sessions SET end_reason='why' WHERE id=$1",[session.id]],
        ["UPDATE staff_attendance_sessions SET ended_at=clock_timestamp(),ended_by=$2,end_reason='ab' WHERE id=$1",[session.id,manager.userId]],
        ["UPDATE staff_attendance_sessions SET ended_at=clock_timestamp(),ended_by=user_id,end_reason='own' WHERE id=$1",[session.id]],
        ["UPDATE staff_attendance_sessions SET ended_at=clock_timestamp(),ended_by=$2,end_reason='foreign' WHERE id=$1",[session.id,foreign.userId]]
      ])await assert.rejects(pool.query(sql,args),{code:'23514'});
      const before=json(await row(session.id));
      await runtime.db.query('BEGIN');
      try { await runtime.db.query(fs.readFileSync(path.join(root,'migrations/115_staff_attendance_recovery.sql'),'utf8')); }
      finally { await runtime.db.query('ROLLBACK'); }
      await pool.query(fs.readFileSync(path.join(root,'migrations/115_staff_attendance_recovery.sql'),'utf8'));
      assert.deepEqual(json(await row(session.id)),before);
      await m.closeSession(pool,owner,closeInput(session));
    });
    await check('bounded start reason/plannedEnd DTO from stored snapshot',async()=>{
      const session=await open();
      // Synthetic snapshot only in this run database: no historical/shared edits.
      await pool.query(`UPDATE staff_attendance_sessions SET basis='outside_schedule',schedule_snapshot=$2::jsonb WHERE id=$1`,
        [session.id,JSON.stringify({reason:'Подмена коллеги',plannedEnd:'2035-01-01T18:00:00Z',privateSentinel:'must not leak'})]);
      const a=(await s.selfStatus(pool,employee)).session;
      const b=(await s.management(pool,manager)).sessions.find(item=>item.id===session.id);
      for(const value of [a,b]){assert.equal(value.startReason,'Подмена коллеги');assert.equal(value.plannedEnd,'2035-01-01T18:00:00Z');assert.equal(value.basis,'outside_schedule');assert(!JSON.stringify(value).includes('must not leak'));}
      await m.closeSession(pool,manager,closeInput(session));
      assert.equal((await s.selfStatus(pool,employee)).latestSession.startReason,'Подмена коллеги');
    });
    await check('real authenticated HTTP recovery and strict origin/body validation',async()=>{
      const port=await freePort();assert(![31946,31947,31948].includes(port));
      child=await startServer(runtime,port);const base=`http://127.0.0.1:${port}`;
      const login=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:JSON.stringify({username:users.owner.login,password:runtime.fixtures.password}),signal:AbortSignal.timeout(10000)});
      assert.equal(login.status,200);const cookie=login.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
      const session=await open(),url=base+`/api/staff/attendance/sessions/${session.id}/close`;
      const request=async(body,headers={Origin:base})=>{
        const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie,...headers},body:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
        return {status:r.status,body:await r.json()};
      };
      const body={...key(),version:session.version,reason:'Закрыто после проверки'};
      assert.equal((await request(body,{Origin:'https://evil.example'})).status,403);
      assert.equal((await request(body,{})).status,403);
      assert.equal((await request({...body,endedAt:'2000-01-01'})).status,400);
      const result=await request(body);assert.equal(result.status,200);assert.equal(result.body.endedBy,owner.userId);
      assert.equal(result.body.userId,employee.userId);assert.equal(result.body.endReason,body.reason);
      assert.deepEqual((await request(body)).body,result.body);
    });
    await check('payroll/cash/worklog/schedule unchanged and tested source stable',async()=>{
      assert.deepEqual(await snapshot(),baseline);assert.deepEqual(hashes(),loadedHashes);
    });
    console.log(JSON.stringify({result:'PASS',suites:checks,protectedTables:protectedNames.length,realPostgres:true,realHttp:true,sourceHashes:loadedHashes}));
  }finally{
    await stopServer(child);
    await pool.end();
    await runtime.dispose();
  }
}
main().catch(error=>{console.error(JSON.stringify({result:'FAIL',code:error.code||error.name,message:error.message}));process.exitCode=1;});
