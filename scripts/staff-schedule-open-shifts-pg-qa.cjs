'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {Pool}=require('pg');
const {config,folder,options}=require('./staff-schedule-local-config.cjs');
const planning=require('../staff-schedule-planning');
const schedule=require('../staff-schedule-service');
const demand=require('../staff-schedule-demand');

async function main(){
 const c=config(),f=JSON.parse(fs.readFileSync(path.join(folder,'fixtures.json'),'utf8'));
 assert.equal(c.database,'staff_schedule_qa','refusing non-QA database');
 const pool=new Pool(options(c)),owner={userId:f.users[0].id,venueId:f.venues[0]},key=()=>randomUUID();
 try{
  assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name,'staff_schedule_qa');
  const activeFunction=(await pool.query('SELECT id FROM staff_schedule_functions WHERE venue_id=$1 AND active ORDER BY id LIMIT 1',[owner.venueId])).rows[0];assert.ok(activeFunction);
  const employeeId=key(),functionId=activeFunction.id,workDate=new Date(Date.UTC(2050,0,1)+Math.floor(Math.random()*36500)*86400000).toISOString().slice(0,10);
  const demandRule=await demand.saveDemandRule(pool,owner,null,{functionId,scope:'date_range',effectiveFrom:workDate,effectiveTo:workDate,startTime:'10:00',endTime:'18:00',endDayOffset:0,requiredCount:2,active:true,requestKey:key()},0);
  await pool.query(`INSERT INTO users(id,venue_id,organization_id,full_name,login,role) VALUES($1,$2,$3,'Open Shift QA',$4,'bartender')`,[employeeId,owner.venueId,f.organizations[0],`open-shift-${employeeId}@example.test`]);
  await pool.query(`INSERT INTO staff_schedule_employee_functions(venue_id,user_id,function_id,active,is_primary,created_by) VALUES($1,$2,$3,true,true,$4)
    ON CONFLICT(venue_id,user_id,function_id) DO UPDATE SET active=true,is_primary=true`,[owner.venueId,employeeId,functionId,owner.userId]);
  const call=(id,action,method,input)=>planning.handle(pool,owner,'drafts',id,action,method,input);
  let draft=await call(null,null,'POST',{name:'Open shift QA',from:workDate,to:workDate,userIds:[employeeId],requestKey:key()});
  const entry={userId:null,workDate,kind:'open_shift',functionId,plannedStart:`${workDate}T10:00:00+05:00`,plannedEnd:`${workDate}T18:00:00+05:00`,breakMinutes:0,breakIntervals:[],note:'QA'};
  draft=await call(draft.id,null,'PATCH',{version:draft.version,requestKey:key(),operations:[{operation:'create',payload:entry}]});
  let preview=await call(draft.id,'publish-preview','POST',{version:draft.version});assert.equal(preview.conflicts.length,0);
  assert.ok(preview.coverage.advisories.some(item=>item.code==='schedule_coverage_deficit'&&item.required===2&&item.covered===1),'open slot contributes one unit but reveals the remaining demand deficit');
  await demand.saveDemandRule(pool,owner,demandRule.id,{functionId,scope:'date_range',effectiveFrom:workDate,effectiveTo:workDate,startTime:'10:00',endTime:'18:00',endDayOffset:0,requiredCount:1,active:true,requestKey:key()},demandRule.version);
  await assert.rejects(()=>call(draft.id,'publish','POST',{version:draft.version,fingerprint:preview.fingerprint,requestKey:key(),confirmWarnings:true,reason:'QA publish'}),error=>error.code==='planning_preview_changed');
  preview=await call(draft.id,'publish-preview','POST',{version:draft.version});
  draft=await call(draft.id,'publish','POST',{version:draft.version,fingerprint:preview.fingerprint,requestKey:key(),confirmWarnings:true,reason:'QA publish'});
  assert.equal(draft.state,'published');
  let saved=(await pool.query('SELECT id,user_id,kind,function_id FROM staff_schedules WHERE venue_id=$1 AND work_date=$2::date AND kind=\'open_shift\' ORDER BY created_at DESC LIMIT 1',[owner.venueId,workDate])).rows[0];
  assert.ok(saved);assert.equal(saved.user_id,null);assert.equal(saved.kind,'open_shift');
  const listed=await schedule.list(pool,owner,workDate,workDate);assert.ok(listed.items.some(item=>item.id===saved.id&&item.kind==='open_shift'&&item.userId===null));
  await assert.rejects(()=>schedule.save(pool,owner,{requestKey:key(),version:1,userId:employeeId,workDate,kind:'shift',functionId,
    plannedStart:entry.plannedStart,plannedEnd:entry.plannedEnd,breakMinutes:0,note:'assign'},saved.id),error=>error.code==='schedule_open_shift_requires_draft');
  let assignment=await call(null,null,'POST',{name:'Assign open shift QA',from:workDate,to:workDate,userIds:[employeeId],requestKey:key()});
  assignment=await call(assignment.id,null,'PATCH',{version:assignment.version,requestKey:key(),operations:[{operation:'update',sourceId:saved.id,sourceVersion:1,payload:{...entry,userId:employeeId,kind:'shift'}}]});
  preview=await call(assignment.id,'publish-preview','POST',{version:assignment.version});assert.equal(preview.conflicts.length,0);assert.equal(preview.coverage.advisories.length,0,'assignment fulfills the configured minimum demand');
  assignment=await call(assignment.id,'publish','POST',{version:assignment.version,fingerprint:preview.fingerprint,requestKey:key(),confirmWarnings:true,reason:'QA assignment'});
  const readback=(await pool.query('SELECT id,user_id,kind FROM staff_schedules WHERE venue_id=$1 AND id=$2',[owner.venueId,saved.id])).rows[0];
  assert.equal(readback.id,saved.id);assert.equal(readback.user_id,employeeId);assert.equal(readback.kind,'shift');
  assert.equal(assignment.state,'published');
  console.log('STAFF SCHEDULE OPEN SHIFT PG PASS: draft-only creation, calendar readback, direct reassign blocked, same-row assignment through qualified draft/publish.');
 }finally{await pool.end();}
}
main().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
