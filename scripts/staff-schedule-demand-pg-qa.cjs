'use strict';
// Intentionally not part of the local aggregate yet. Run only after stage07 API wiring
// and the coordinator's explicit QA-DB window; this script must never target production.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {Pool}=require('pg');
const {config,folder,options}=require('./staff-schedule-local-config.cjs');
const demand=require('../staff-schedule-demand');

async function main(){
 const runtime=config(),fixtures=JSON.parse(fs.readFileSync(path.join(folder,'fixtures.json'),'utf8'));
 assert.equal(runtime.database,'staff_schedule_qa','refusing non-QA database');
 const pool=new Pool(options(runtime));
 const principal={userId:fixtures.users[0].id,venueId:fixtures.venues[0]};
 try{
  assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name,'staff_schedule_qa');
  const functions=(await pool.query('SELECT id FROM staff_schedule_functions WHERE venue_id=$1 AND active ORDER BY id LIMIT 1',[principal.venueId])).rows;
  assert.ok(functions.length,'QA fixture requires an active work function');
  const before=(await demand.listDemandRules(pool,principal,functions[0].id)).items;
  const key=()=>require('node:crypto').randomUUID();
  const anchor=new Date(Date.UTC(2050,0,1)+Math.floor(Math.random()*36500)*86400000).toISOString().slice(0,10),to=new Date(Date.parse(`${anchor}T12:00:00Z`)+2*86400000).toISOString().slice(0,10);
  const body={functionId:functions[0].id,scope:'date_range',effectiveFrom:anchor,effectiveTo:to,startTime:'10:00',endTime:'14:00',endDayOffset:0,requiredCount:2,active:true,requestKey:key()};
  const created=await demand.saveDemandRule(pool,principal,null,body,0);
  assert.deepEqual(await demand.saveDemandRule(pool,principal,null,body,0),created,'same request replays the original result');
  await assert.rejects(()=>demand.saveDemandRule(pool,principal,null,{...body,requiredCount:7},0),error=>error.code==='schedule_request_conflict');
  assert.equal(created.version,1);assert.equal(created.timezone,(await demand.listDemandRules(pool,principal)).timezone);
  assert.ok((await demand.listDemandRules(pool,principal,functions[0].id)).items.some(row=>row.id===created.id));
  await assert.rejects(()=>demand.saveDemandRule(pool,principal,null,{...body,requestKey:key(),startTime:'13:00',endTime:'16:00'},0),error=>error.code==='schedule_demand_overlap');
  const updated=await demand.saveDemandRule(pool,principal,created.id,{...body,requestKey:key(),requiredCount:3},created.version);
  assert.equal(updated.version,2);assert.equal(updated.requiredCount,3);
  await assert.rejects(()=>demand.saveDemandRule(pool,principal,created.id,{...body,requestKey:key(),requiredCount:4},created.version),error=>error.code==='schedule_demand_version_conflict');
  const otherVenue={userId:fixtures.users[4].id,venueId:fixtures.venues[1]};
  await assert.rejects(()=>demand.saveDemandRule(pool,otherVenue,created.id,{...body,requestKey:key(),requiredCount:4},updated.version),error=>error.code==='schedule_demand_not_found');
  const history=await pool.query("SELECT count(*)::int AS n FROM staff_schedule_config_events WHERE venue_id=$1 AND entity_type='demand_rule' AND entity_id=$2",[principal.venueId,created.id]);
  assert.equal(history.rows[0].n,2,'create/update each have a scoped audit event');
  await demand.saveDemandRule(pool,principal,created.id,{...body,requestKey:key(),active:false},updated.version);
  console.log(`STAFF SCHEDULE DEMAND PG PASS: tenant/version/audit/readback; prior fixture rows ${before.length}.`);
 }finally{await pool.end();}
}
main().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
