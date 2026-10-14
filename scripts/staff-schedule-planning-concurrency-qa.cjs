'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {Pool}=require('pg');
const {config,folder,options}=require('./staff-schedule-local-config.cjs');
const planning=require('../staff-schedule-planning');
const live=require('../staff-schedule-service');
const {setGrant}=require('../staff-schedule-access');
async function main(){
 const c=config(),f=JSON.parse(fs.readFileSync(path.join(folder,'fixtures.json'),'utf8'));assert.equal(f.database,c.database);
 const pool=new Pool(options(c)),p={userId:f.users[0].id,venueId:f.venues[0]},key=()=>randomUUID();
 const employee=key(),manager=key();
 try{
  for(const [id,role] of [[employee,'bartender'],[manager,'manager']])await pool.query(`INSERT INTO users(id,venue_id,organization_id,full_name,login,role) VALUES($1,$2,$3,'Planning concurrency QA',$4,$5)`,[id,p.venueId,f.organizations[0],`planning-race-${id}@example.test`,role]);
  const payload=(start,end)=>({userId:employee,workDate:'2033-06-01',plannedStart:`2033-06-01T${start}+05:00`,plannedEnd:`2033-06-01T${end}+05:00`,requestKey:key()});
  const a=await live.save(pool,p,payload('10:00','14:00')),b=await live.save(pool,p,payload('14:00','18:00'));
  const call=(id,action,method,input,actor=p,db=pool)=>planning.handle(db,actor,'drafts',id,action,method,input);
  let d=await call(null,null,'POST',{name:'Atomic swap',from:'2033-06-01',to:'2033-06-02',userIds:[employee],requestKey:key()});
  const ops=[{operation:'update',sourceId:a.id,sourceVersion:1,payload:payload('14:00','18:00')},{operation:'update',sourceId:b.id,sourceVersion:1,payload:payload('10:00','14:00')}];
  d=await call(d.id,null,'PATCH',{version:1,operations:ops,requestKey:key()});
  const preview=await call(d.id,'publish-preview','POST',{version:2});
  const pub={version:2,fingerprint:preview.fingerprint,requestKey:key()};
  const read=async()=>({rows:(await pool.query('SELECT * FROM staff_schedules WHERE user_id=$1 ORDER BY id',[employee])).rows,events:(await pool.query('SELECT * FROM staff_schedule_events WHERE schedule_id=ANY($1::uuid[]) ORDER BY id',[[a.id,b.id]])).rows});
  const before=await read();
  const injected={connect:async()=>{const db=await pool.connect();let writes=0;return {query:async(sql,args)=>{if(sql.startsWith('UPDATE staff_schedules')&&++writes===2)throw new Error('QA injected second-write failure');return db.query(sql,args);},release:()=>db.release()};}};
  await assert.rejects(()=>call(d.id,'publish','POST',pub,p,injected),/QA injected/);
  assert.deepEqual(await read(),before);
  assert.equal((await call(d.id,null,'GET',{})).state,'open');
  assert.equal((await pool.query('SELECT count(*)::int n FROM staff_schedule_requests WHERE request_key=$1',[pub.requestKey])).rows[0].n,0);
  await setGrant(pool,p,{userId:manager,access:'manage',canPublish:true,version:0});
  const actor={userId:manager,venueId:p.venueId};
  const revoker=await pool.connect();let releaseBarrier;const reached=new Promise(r=>{releaseBarrier=r;});
  const barrier={connect:async()=>{const db=await pool.connect();return {query:(sql,args)=>{if(sql==='SELECT id FROM users WHERE id=$1 FOR SHARE')releaseBarrier();return db.query(sql,args);},release:()=>db.release()};}};
  let pending;
  try{
   await revoker.query('BEGIN');await revoker.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[manager]);
   pending=call(d.id,'publish','POST',{...pub,requestKey:key()},actor,barrier).then(value=>({value}),error=>({error}));
   await reached;
   await revoker.query('UPDATE staff_schedule_grants SET can_publish=false,version=version+1 WHERE venue_id=$1 AND user_id=$2',[p.venueId,manager]);
   await revoker.query('COMMIT');
   assert.equal((await pending).error?.code,'schedule_publish_forbidden');
   assert.deepEqual(await read(),before);
  }finally{await revoker.query('ROLLBACK');revoker.release();}
  const races=await Promise.allSettled([call(d.id,'publish','POST',pub),call(d.id,'publish','POST',{...pub,requestKey:key()})]);
  assert.equal(races.filter(x=>x.status==='fulfilled').length,1);
  assert.equal(races.find(x=>x.status==='rejected').reason.code,'draft_closed');
  assert.equal((await read()).events.length,before.events.length+2);
  // Cross-midnight row outside the draft's date range still blocks a new early shift.
  await live.save(pool,p,{userId:employee,workDate:'2033-06-02',plannedStart:'2033-06-02T22:00+05:00',plannedEnd:'2033-06-03T04:00+05:00',requestKey:key()});
  let night=await call(null,null,'POST',{name:'Night boundary',from:'2033-06-03',to:'2033-06-03',userIds:[employee],requestKey:key()});
  night=await call(night.id,null,'PATCH',{version:1,requestKey:key(),operations:[{operation:'create',payload:{userId:employee,workDate:'2033-06-03',plannedStart:'2033-06-03T02:00+05:00',plannedEnd:'2033-06-03T06:00+05:00'}}]});
  assert.ok((await call(night.id,'publish-preview','POST',{version:2})).conflicts.some(x=>x.code==='schedule_overlap'));
  // A historical row may predate duration limits; do not overlook a multi-day interval.
  await pool.query(`INSERT INTO staff_schedules(venue_id,user_id,work_date,planned_start,planned_end)
    VALUES($1,$2,'2033-07-01','2033-07-01T10:00+05:00','2033-07-05T18:00+05:00')`,[p.venueId,employee]);
  let legacy=await call(null,null,'POST',{name:'Long legacy boundary',from:'2033-07-04',to:'2033-07-04',userIds:[employee],requestKey:key()});
  legacy=await call(legacy.id,null,'PATCH',{version:1,requestKey:key(),operations:[{operation:'create',payload:{userId:employee,workDate:'2033-07-04',plannedStart:'2033-07-04T12:00+05:00',plannedEnd:'2033-07-04T18:00+05:00'}}]});
  assert.ok((await call(legacy.id,'publish-preview','POST',{version:2})).conflicts.some(x=>x.code==='schedule_overlap'));
  console.log('PLANNING CONCURRENCY PASS: injected failure rolls back rows/history/replay; revoke-before-publish denies; concurrent publication exactly once; adjacent-day and long legacy overlap.');
 }finally{await pool.end();}
}
main().catch(e=>{console.error(e.message);console.error(e.stack?.split('\n').filter(l=>l.trim().startsWith('at ')).slice(0,3).join('\n'));process.exitCode=1;});
