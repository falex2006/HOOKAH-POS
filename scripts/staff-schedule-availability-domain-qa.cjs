'use strict';
const assert=require('node:assert/strict');
const {evaluateAvailability}=require('../staff-schedule-availability');

const userId='00000000-0000-0000-0000-000000000001';
const venueId='00000000-0000-0000-0000-000000000002';
const rows=(rules=[])=>({query:async sql=>({rows:sql.includes('FROM staff_schedule_availability_rules')?rules:[]})});
const shift=(start,end)=>[{id:'new:test',userId,kind:'shift',plannedStart:start,plannedEnd:end}];

async function main(){
  const rule={user_id:userId,weekday:1,kind:'available',startTime:'20:00',endTime:'04:00',endDayOffset:1,effectiveFrom:'2032-02-01',effectiveTo:null,id:'window'};
  const inside=await evaluateAvailability(rows([rule]),venueId,'Asia/Yekaterinburg',shift('2032-02-02T22:00:00+05:00','2032-02-03T03:00:00+05:00'));
  assert.deepEqual(inside.conflicts,[],'overnight shift inside the available window');
  const outside=await evaluateAvailability(rows([rule]),venueId,'Asia/Yekaterinburg',shift('2032-02-02T22:00:00+05:00','2032-02-03T08:00:00+05:00'));
  assert.equal(outside.conflicts[0]?.code,'schedule_availability_outside_window','overnight availability must constrain the next-day segment');
  const santiago=await evaluateAvailability(rows(),venueId,'America/Santiago',shift('2024-09-08T08:00:00-03:00','2024-09-08T17:00:00-03:00'));
  assert.deepEqual(santiago.conflicts,[],'missing local 00:00 must not reject an ordinary daytime shift');
  console.log('AVAILABILITY DOMAIN PASS: overnight coverage and midnight DST boundary');
}
main().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
