'use strict';
// Unit/route contract: no HTTP server, DB or browser. Real PG is a separate script.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { handleAttendanceRoute } = require('../staff-attendance-routes');
const { closeSession, saveGrant } = require('../staff-attendance-mutations');
const id='10000000-0000-4000-8000-000000000001';
const principal={userId:id,venueId:'20000000-0000-4000-8000-000000000001'};
async function call({headers={host:'localhost',origin:'http://localhost'},body={requestKey:id,version:1,reason:'Forgotten session'},method='POST',user={id,venueId:principal.venueId},pool={}}={}) {
  let response;
  await handleAttendanceRoute({req:{method,user,headers},res:{},url:new URL(`http://localhost/api/staff/attendance/sessions/${id}/close`),pool,
    readBody:async()=>body,json:(_res,status,data)=>{response={status,data};}});
  return response;
}
test('recovery requires origin even with bearer; rejects foreign/missing origin and cross-site', async()=>{
  for(const headers of [
    {host:'localhost',authorization:'Bearer test'},
    {host:'localhost',origin:'https://evil.test',authorization:'Bearer test'},
    {host:'localhost',origin:'http://localhost','sec-fetch-site':'cross-site'},
    {host:'localhost',origin:'https://localhost'}
  ]) assert.equal((await call({headers})).status,403);
});
test('recovery auth/method guards and no caller-controlled identity/time', async()=>{
  assert.equal((await call({user:null})).status,401);
  assert.equal((await call({method:'DELETE'})).status,405);
  for(const field of ['endedAt','endedBy','endReason','startedAt','userId','venueId','id','approved']){
    const result=await call({body:{requestKey:id,version:1,reason:'forgotten', [field]:id}});
    assert.equal(result.status,400);assert.equal(result.data.error,'attendance_input_invalid');
  }
});
test('recovery validates reason/version and prohibits extra fields before connecting', ()=>{
  const pool={connect(){throw Error('must not connect');}};
  for(const reason of ['', '  ', 'ab', 'x'.repeat(501), null, 123])assert.throws(()=>closeSession(pool,principal,{id,requestKey:id,version:1,reason}),{code:'attendance_reason_required'});
  for(const version of [-1,1.5,'1',null])assert.throws(()=>closeSession(pool,principal,{id,requestKey:id,version,reason:'forgotten'}),{code:'attendance_version_invalid'});
  assert.throws(()=>closeSession(pool,principal,{id,requestKey:id,version:1,reason:'forgotten',endedAt:'2000-01-01'}),{code:'attendance_input_invalid'});
  for(const closeSessions of [null,0,'true',{}])assert.throws(()=>saveGrant(pool,principal,{userId:id,version:0,managePolicy:false,approve:false,closeSessions}),{code:'attendance_grant_invalid'});
});
test('route binds session ID from path and reaches independent capability', async()=>{
  const queries=[];
  const db={release(){},async query(sql,args){queries.push({sql,args});if(sql.includes('FROM users u'))return {rows:[{role:'manager',homeVenueId:principal.venueId,approve:true,closeSessions:false}]};return {rows:[]};}};
  const result=await call({pool:{connect:async()=>db}});
  assert.equal(result.status,403);assert.equal(result.data.error,'attendance_forbidden');
  assert(queries.some(q=>q.sql==='ROLLBACK'));
  assert(!queries.some(q=>q.sql.includes('FROM staff_attendance_sessions')));
});
