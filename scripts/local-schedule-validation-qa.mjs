import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {handleScheduleAccessRoute}=require('../staff-schedule-routes');
const {normalize}=require('../staff-schedule-domain');
const id='00000000-0000-0000-0000-000000000001';
async function invoke(input,role='owner') {
  let result;
  await handleScheduleAccessRoute({req:{method:'POST',headers:{authorization:'Bearer test'},user:{id,venueId:id}},res:{},url:new URL('http://localhost/api/staff/schedule'),
    pool:{query:async()=>({rows:[{role,timezone:'Asia/Yekaterinburg',access:'none'}]}),connect:async()=>{throw new Error('Invalid input must not start transaction');}},
    readBody:async()=>input,json:(_,status,data)=>{result={status,data};}});
  return result;
}
assert.equal((await invoke({})).data.error,'schedule_request_key_required');
assert.equal((await invoke({requestKey:id,version:1})).data.error,'schedule_create_version_forbidden');
assert.equal((await invoke({},'admin')).status,403);
const base={userId:id,workDate:'2026-11-10',plannedStart:'2026-11-10T10:00+05:00',plannedEnd:'2026-11-10T18:00+05:00'};
for(const input of [{...base,workDate:'2026-02-30'},{...base,plannedStart:null},{...base,plannedEnd:base.plannedStart},{...base,breakMinutes:480}]) assert.throws(()=>normalize(input,'Asia/Yekaterinburg'));
assert.equal(normalize(base,'Asia/Yekaterinburg').workDate,base.workDate);
console.log('SCHEDULE VALIDATION: PASS active dispatcher auth/key/create-version and domain validation; not runtime integration.');
