'use strict';
const assert=require('node:assert/strict');
const {randomUUID,randomBytes}=require('node:crypto');
const {createRuntime,freePort,startServer,stopServer}=require('./staff-attendance-http-qa.cjs');
async function main(){
  assert(process.argv.includes('--run'),'Explicit --run required');
  const runtime=await createRuntime(`attendance_http_notif_${Date.now()}_${randomBytes(3).toString('hex')}`);
  let child,checks=0;
  try{
    const port=await freePort();assert.notEqual(port,31946);child=await startServer(runtime,port);
    const base=`http://127.0.0.1:${port}`,key=()=>({requestKey:randomUUID()});
    async function req(path,user,method='GET',input,status=200,headers={}){
      const r=await fetch(base+path,{method,signal:AbortSignal.timeout(15000),headers:{'Content-Type':'application/json',Origin:base,...(user?.cookie?{Cookie:user.cookie}:{}),...headers},...(input===undefined?{}:{body:JSON.stringify(input)})});
      const data=await r.json();assert.equal(r.status,status,`${method} ${path}: ${JSON.stringify(data)}`);checks++;
      return {data,cookies:r.headers.getSetCookie()};
    }
    for(const u of runtime.fixtures.users){const r=await req('/api/login',null,'POST',{username:u.login,password:runtime.fixtures.password});u.cookie=r.cookies.map(c=>c.split(';')[0]).join('; ');}
    const u=Object.fromEntries(runtime.fixtures.users.map(x=>[x.label,x])),venue=runtime.fixtures.venues[0];
    const cashEvent=randomUUID();
    await runtime.db.query("INSERT INTO audit_events(venue_id,actor_id,action,entity_type,entity_id) VALUES($1,$2,'shift.opened','shift',$3)",[venue,u.owner.id,cashEvent]);
    const api=async(p,user,method='GET',body,status=200)=> (await req('/api/staff/attendance'+p,user,method,body,status)).data;
    const notifications=async user=>(await req('/api/notifications?limit=50',user)).data;
    const read=async(id,user,status=200)=>req(`/api/notifications/${encodeURIComponent(id)}/read`,user,'PUT',undefined,status);
    const baseline=await runtime.db.query("SELECT (SELECT count(*) FROM shifts) cash,(SELECT count(*) FROM staff_work_logs) logs,(SELECT count(*) FROM payroll_entries) payroll");
    await api('/policy',u.owner,'PUT',{...key(),version:0,mode:'approval',preparationMinutes:0});
    await api('/grants',u.owner,'PUT',{...key(),userId:u.manager.id,version:0,managePolicy:false,approve:true,closeSessions:false});
    const first=await api('/requests',u.employee,'POST',{...key(),reason:'Тестовая замена'}),requestId=`attendance_request:${first.id}`;
    assert((await notifications(u.owner)).items.some(i=>i.id===requestId));
    assert((await notifications(u.manager)).items.some(i=>i.id===requestId));
    assert(!(await notifications(u.admin)).items.some(i=>i.id===requestId));
    assert(!(await notifications(u.employee)).items.some(i=>i.id===requestId));
    assert(!(await notifications(u.foreign)).items.some(i=>i.id===requestId));
    await read(requestId,u.foreign,404);await read(requestId,u.employee,404);
    await read(requestId,u.manager);assert((await notifications(u.manager)).items.find(i=>i.id===requestId).readAt);
    assert(!(await notifications(u.owner)).items.find(i=>i.id===requestId).readAt);
    await api('/grants',u.owner,'PUT',{...key(),userId:u.manager.id,version:1,managePolicy:false,approve:false,closeSessions:false});
    assert(!(await notifications(u.manager)).items.some(i=>i.id===requestId));await read(requestId,u.manager,404);
    const decision=await api(`/requests/${first.id}/decision`,u.owner,'POST',{...key(),version:first.version,decision:'approved',note:'Тестовое одобрение'});
    assert(!(await notifications(u.owner)).items.some(i=>i.id===requestId));
    const employeeFeed=await notifications(u.employee),approved=employeeFeed.items.find(i=>i.id===`attendance_decision:${first.id}`);
    assert(approved?.requiresAction);assert.equal(approved.href,'/#staff-attendance');
    assert(employeeFeed.items.every(i=>i.type.startsWith('attendance_')),'No finance/order leakage to operational employee');
    assert((await notifications(u.owner)).items.some(i=>i.id===`shift_opened:${cashEvent}`),'Nonempty cash notification fixture visible to owner');
    await req('/api/notifications',u.employee,'POST',undefined,403,{Origin:'https://foreign.example'});
    await req(`/api/notifications/${encodeURIComponent(approved.id)}/read`,u.employee,'PUT',undefined,403,{Origin:'https://foreign.example'});
    await req('/api/notifications',u.employee,'POST');assert.equal((await notifications(u.employee)).unreadCount,0);
    const started=await api('/start',u.employee,'POST',{...key(),approvalId:decision.id});
    assert.equal((await notifications(u.employee)).items.find(i=>i.id===approved.id).requiresAction,false);
    // Synthetic elapsed-time fixture only in our guarded disposable database.
    await runtime.db.query("UPDATE staff_attendance_sessions SET started_at=clock_timestamp()-interval '17 hours' WHERE id=$1",[started.id]);
    const reminder=`attendance_overdue:${started.id}`;
    assert((await notifications(u.employee)).items.some(i=>i.id===reminder));
    assert((await notifications(u.owner)).items.some(i=>i.id===reminder));
    assert(!(await notifications(u.foreign)).items.some(i=>i.id===reminder));
    await api(`/sessions/${started.id}/close`,u.owner,'POST',{...key(),version:started.version,reason:'Тест: сотрудник подтвердил завершение'});
    assert(!(await notifications(u.owner)).items.some(i=>i.id===reminder));
    assert((await notifications(u.employee)).items.some(i=>i.id===`attendance_closed:${started.id}`));
    const self=await api('/self',u.employee);assert.equal(self.session,null);assert(self.latestSession.endReason);
    const second=await api('/requests',u.employee,'POST',{...key(),reason:'Тест истечения'});
    await runtime.db.query("UPDATE staff_attendance_requests SET window_start=clock_timestamp()-interval '3 hours',window_end=clock_timestamp()-interval '1 hour' WHERE id=$1",[second.id]);
    const expired=await notifications(u.employee);assert(expired.items.some(i=>i.id===`attendance_expired:${second.id}`));
    assert(!(await notifications(u.owner)).items.some(i=>i.id===`attendance_request:${second.id}`));
    const third=await api('/requests',u.employee,'POST',{...key(),reason:'Тест отказа'});
    await api(`/requests/${third.id}/decision`,u.owner,'POST',{...key(),version:third.version,decision:'rejected',note:'Тестовый отказ'});
    assert((await notifications(u.employee)).items.some(i=>i.id===`attendance_decision:${third.id}`&&!i.requiresAction));
    await api('/policy',u.owner,'PUT',{...key(),version:1,mode:'warn',preparationMinutes:0});
    const warned=await api('/start',u.employee,'POST',{...key(),reason:'Тест выхода с пояснением'});
    assert((await notifications(u.owner)).items.some(i=>i.id===`attendance_warning:${warned.id}`));
    await api('/end',u.employee,'POST',{...key(),id:warned.id,version:warned.version});
    await req('/api/notifications',u.employee,'POST');
    const oldId=randomUUID();
    await runtime.db.query(`INSERT INTO staff_attendance_requests(id,venue_id,user_id,reason,window_start,window_end,status,decided_by,decided_at,request_key,created_at)
      VALUES($1,$2,$3,'QA old unread',now()-interval '2 hours',now()-interval '1 hour','rejected',$4,now()-interval '2 hours',$5,now()-interval '2 hours')`,[oldId,venue,u.employee.id,u.owner.id,randomUUID()]);
    const more=await runtime.db.query(`INSERT INTO staff_attendance_requests(venue_id,user_id,reason,window_start,window_end,status,decided_by,decided_at,request_key)
      SELECT $1,$2,'QA newer read',now(),now()+interval '2 hours','rejected',$3,now(),gen_random_uuid() FROM generate_series(1,101) RETURNING id`,[venue,u.employee.id,u.owner.id]);
    await runtime.db.query("INSERT INTO notification_reads(venue_id,user_id,notification_key) SELECT $1,$2,'attendance_decision:'||id FROM unnest($3::uuid[]) id",[venue,u.employee.id,more.rows.map(x=>x.id)]);
    const unread=(await req('/api/notifications?filter=unread&limit=20',u.employee)).data;
    assert(unread.items.some(i=>i.id===`attendance_decision:${oldId}`),'Unread older than101 read events remains reachable');
    const {collectAttendanceNotifications}=require('../staff-attendance-notifications');let statements=0;
    await collectAttendanceNotifications({query:(sql,args)=>{statements++;assert(sql.includes('attendance_access AS'),'ACL in same SQL snapshot');return runtime.db.query(sql,args);}}, {venueId:venue,userId:u.manager.id});
    assert.equal(statements,1,'No access/feed race between separate statements');
    assert.deepEqual((await runtime.db.query("SELECT (SELECT count(*) FROM shifts) cash,(SELECT count(*) FROM staff_work_logs) logs,(SELECT count(*) FROM payroll_entries) payroll")).rows,baseline.rows);
    console.log(JSON.stringify({result:'PASS',httpChecks:checks,scenarios:'request/decision/revoke/read/allread/expiry/reminder/recovery/warn/tenant/no-finance-leak',venueScoped:true}));
  }finally{await stopServer(child);await runtime.dispose();}
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
