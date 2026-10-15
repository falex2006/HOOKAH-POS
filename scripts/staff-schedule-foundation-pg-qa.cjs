'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {randomUUID}=require('node:crypto');
const {Pool}=require('pg');
const {config,folder,options}=require('./staff-schedule-local-config.cjs');

async function main(){
 const c=config(),f=JSON.parse(fs.readFileSync(`${folder}/fixtures.json`,'utf8'));
 assert.equal(c.database,'staff_schedule_qa');assert.equal(f.database,c.database);
 const pool=new Pool(options(c)),db=await pool.connect();let checks=0;
 const owner=f.users[0],employee=f.users[3],venue=f.venues[0],otherVenue=f.venues[1];
 const attempt=async(sql,args,code)=>{
  await db.query('SAVEPOINT expected_failure');
  try{await db.query(sql,args);assert.fail(`Expected ${code||'constraint'} rejection`);}
  catch(error){if(error.code==='ERR_ASSERTION')throw error;if(code)assert.equal(error.code,code,`Expected PostgreSQL ${code}, received ${error.code}: ${error.message}`);checks++;}
  finally{await db.query('ROLLBACK TO SAVEPOINT expected_failure');await db.query('RELEASE SAVEPOINT expected_failure');}
 };
 try{
  const identity=await db.query("SELECT current_database() AS db, current_user AS usr, to_regclass('public.staff_schedule_functions') AS functions, to_regclass('public.staff_schedule_series') AS series");
  assert.equal(identity.rows[0].db,c.database);assert.equal(identity.rows[0].usr,c.dbUser);assert.ok(identity.rows[0].functions);assert.ok(identity.rows[0].series);checks++;
  await db.query('BEGIN');
  const functionId=randomUUID(),otherFunction=randomUUID(),templateId=randomUUID();
  await db.query('INSERT INTO staff_schedule_functions(id,venue_id,name,created_by) VALUES($1,$2,$3,$4),($5,$6,$7,$8)',[functionId,venue,'Утренний сотрудник',owner.id,otherFunction,otherVenue,'Бармен',f.users[4].id]);
  await attempt('INSERT INTO staff_schedule_functions(venue_id,name,created_by) VALUES($1,$2,$3)',[venue,' утренний сотрудник ',owner.id],'23505');
  await attempt('INSERT INTO staff_schedule_employee_functions(venue_id,user_id,function_id,created_by) VALUES($1,$2,$3,$4)',[otherVenue,employee.id,functionId,owner.id],'23503');
  await db.query('INSERT INTO staff_schedule_employee_functions(venue_id,user_id,function_id,is_primary,created_by) VALUES($1,$2,$3,true,$4)',[venue,employee.id,functionId,owner.id]);
  await attempt('INSERT INTO staff_schedule_grants(venue_id,user_id,access,version,granted_by,can_manage_settings) VALUES($1,$2,\'view\',1,$3,true)',[venue,f.users[2].id,owner.id],'23514');
  await attempt('INSERT INTO staff_schedule_availability_rules(venue_id,user_id,weekday,rule_kind,start_time,end_time,effective_from,created_by) VALUES($1,$2,8,\'available\',\'10:00\',\'17:00\',\'2035-01-01\',$3)',[venue,employee.id,owner.id],'23514');
  await db.query(`INSERT INTO staff_schedule_availability_rules(venue_id,user_id,weekday,rule_kind,start_time,end_time,end_day_offset,effective_from,created_by)
    VALUES($1,$2,5,'unavailable','00:00','00:00',1,'2035-01-01',$3)`,[venue,employee.id,owner.id]);checks++;
  await attempt('INSERT INTO staff_schedule_demand_rules(venue_id,function_id,weekday,work_date,start_time,end_time,required_count,timezone,updated_by,created_by) VALUES($1,$2,1,NULL,\'18:00\',\'20:00\',0,\'Asia/Yekaterinburg\',$3,$3)',[venue,functionId,owner.id],'23514');
  await db.query(`INSERT INTO staff_schedule_templates(id,venue_id,name,definition,created_by)
    VALUES($1,$2,'QA team template','{"pattern":{"type":"weekdays","weekdays":[1]},"slots":[{"kind":"shift","startTime":"10:00","endTime":"17:00"}]}',$3)`,[templateId,venue,owner.id]);
  await db.query(`INSERT INTO staff_schedule_template_bindings(venue_id,template_id,target_kind,target_user_id,created_by)
    VALUES($1,$2,'employee',$3,$4)`,[venue,templateId,employee.id,owner.id]);checks++;
  await attempt(`INSERT INTO staff_schedule_template_bindings(venue_id,template_id,target_kind,target_role_key,created_by)
    VALUES($1,$2,'crm_role',NULL,$3)`,[venue,templateId,owner.id],'23514');
  const seriesId=randomUUID();
  await db.query(`INSERT INTO staff_schedule_series(id,venue_id,name,user_id,function_id,anchor_date,until_date,timezone,recurrence,source_template_id,source_template_version,created_by)
    VALUES($1,$2,'QA 2/2',$3,$4,'2035-01-01','2035-12-31','Asia/Yekaterinburg','{"type":"cycle","cycleDays":4,"dayOffsets":[0,1]}',$5,1,$6)`,[seriesId,venue,employee.id,functionId,templateId,owner.id]);checks++;
  await attempt(`INSERT INTO staff_schedule_series(venue_id,name,user_id,anchor_date,until_date,timezone,recurrence,created_by)
    VALUES($1,'Too long',$2,'2035-01-01','2037-01-01','Asia/Yekaterinburg','{}',$3)`,[venue,employee.id,owner.id],'23514');
  const openId=randomUUID();
  await db.query(`INSERT INTO staff_schedules(id,venue_id,user_id,function_id,work_date,planned_start,planned_end,kind,status,break_minutes,break_intervals,created_by,updated_by)
    VALUES($1,$2,NULL,$3,'2035-01-03','2035-01-03T18:00+05:00','2035-01-04T02:00+05:00','open_shift','planned',30,'[]',$4,$4)`,[openId,venue,functionId,owner.id]);checks++;
  await attempt(`INSERT INTO staff_schedules(venue_id,user_id,work_date,kind,status,created_by)
    VALUES($1,NULL,'2035-01-04','shift','planned',$2)`,[venue,owner.id],'23514');
  await attempt(`INSERT INTO staff_schedules(venue_id,user_id,function_id,work_date,kind,status,created_by)
    VALUES($1,NULL,NULL,'2035-01-04','open_shift','planned',$2)`,[venue,owner.id],'23514');
  await attempt(`INSERT INTO staff_schedules(venue_id,user_id,function_id,work_date,kind,status,break_intervals,created_by)
    VALUES($1,NULL,$2,'2035-01-04','open_shift','planned','{}',$3)`,[venue,functionId,owner.id],'23514');
  const row=await db.query('SELECT user_id,kind,function_id,planned_start,planned_end FROM staff_schedules WHERE id=$1 AND venue_id=$2',[openId,venue]);
  assert.equal(row.rowCount,1);assert.equal(row.rows[0].user_id,null);assert.equal(row.rows[0].kind,'open_shift');assert.equal(row.rows[0].function_id,functionId);checks++;
  const facts=await db.query('SELECT count(*)::int n FROM staff_work_logs WHERE venue_id=$1 AND user_id=$2',[venue,employee.id]);
  assert.ok(Number.isInteger(facts.rows[0].n));checks++;
  await db.query('ROLLBACK');
  console.log(`SCHEDULE FOUNDATION PG PASS ${checks}: identity-fenced isolated DB; tenant FKs; active function uniqueness; grants/settings constraint; availability; templates; bounded series; open-shift and JSON checks; transaction rolled back.`);
 }catch(error){await db.query('ROLLBACK').catch(()=>{});throw error;}
 finally{db.release();await pool.end();}
}
main().catch(error=>{console.error(error.message);console.error(error.stack?.split('\n').filter(line=>line.trim().startsWith('at ')).slice(0,4).join('\n'));process.exitCode=1;});
