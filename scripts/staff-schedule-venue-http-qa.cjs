'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {randomUUID}=require('node:crypto'),{Pool}=require('pg');
const {config,folder,options}=require('./staff-schedule-local-config.cjs');
async function main(){
  const c=config(),f=JSON.parse(fs.readFileSync(path.join(folder,'fixtures.json'),'utf8')),pool=new Pool(options(c)),base=`http://127.0.0.1:${c.appPort}`;
  const venue=randomUUID(),employee=randomUUID();let token;
  async function request(route,method='GET',input){const r=await fetch(base+route,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:input===undefined?undefined:JSON.stringify(input)});return {status:r.status,value:await r.json()};}
  try{
    await pool.query("INSERT INTO venues(id,organization_id,name,timezone) VALUES($1,$2,'Venue session QA','Asia/Yekaterinburg')",[venue,f.organizations[0]]);
    await pool.query("INSERT INTO users(id,venue_id,organization_id,full_name,login,role) VALUES($1,$2,$3,'Venue employee QA',$4,'bartender')",[employee,venue,f.organizations[0],`${employee}@example.test`]);
    const login=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:f.users[0].login,password:f.password})});assert.equal(login.status,200);token=(await login.json()).token;
    assert.equal((await request(`/api/network/venues/${venue}/select`,'POST',{})).status,200);
    const session=await request('/api/session');assert.equal(session.status,200);assert.equal(session.value.user.venueId,venue);assert.ok(session.value.permissions.includes('staff_schedule_manage'));
    assert.equal((await pool.query('SELECT venue_id FROM users WHERE id=$1',[f.users[0].id])).rows[0].venue_id,f.venues[0],'Home venue not rewritten');
    const employees=await request('/api/staff/schedule/employees');assert.deepEqual(employees.value.items.map(x=>x.id),[employee]);
    const created=await request('/api/staff/schedule','POST',{userId:employee,workDate:'2026-12-20',plannedStart:'2026-12-20T10:00+05:00',plannedEnd:'2026-12-20T18:00+05:00',requestKey:randomUUID(),reason:'Venue session QA'});assert.equal(created.status,201);assert.equal(created.value.venue_id,venue);
    assert.equal((await request(`/api/network/venues/${f.venues[1]}/select`,'POST',{})).status,404);
    assert.equal((await request('/api/session')).value.user.venueId,venue);
    assert.equal((await request(`/api/network/venues/${f.venues[0]}/select`,'POST',{})).status,200);
    assert.equal((await request('/api/staff/schedule/'+created.value.id)).status,404);
    assert.equal((await request('/api/staff/schedule/'+created.value.id,'PATCH',{status:'cancelled',version:1,reason:'wrong venue',requestKey:randomUUID()})).status,404);
    assert.equal((await pool.query('SELECT status FROM staff_schedules WHERE id=$1',[created.value.id])).rows[0].status,'planned');
    console.log('VENUE SESSION HTTP PASS: owner selects second same-org venue, session200/grants/employee/save201; foreign select404; switched-back stale read/write404 without mutation.');
  }finally{if(token)await request(`/api/network/venues/${f.venues[0]}/select`,'POST',{});await pool.end();}
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
