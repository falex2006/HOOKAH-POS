'use strict';
const assert=require('node:assert/strict');
const pattern=require('../staff-schedule-pattern');
const first='10000000-0000-4000-8000-000000000001',second='10000000-0000-4000-8000-000000000002',fn='20000000-0000-4000-8000-000000000001';
const days={type:'weekdays',weekdays:[1,2,3,4,5,6,7]},date='2032-02-02';let checks=0;
const legacy={pattern:days,slots:[{kind:'shift',startTime:'10:00',endTime:'18:00',breakMinutes:30}]};
assert.deepEqual(pattern.definition(legacy),{pattern:days,slots:[{kind:'shift',startTime:'10:00',endTime:'18:00',endDayOffset:0,breakMinutes:30,note:'',functionId:null}]});checks++;
assert.equal(pattern.expand({from:date,to:date,userIds:[first,second],definition:legacy},'Asia/Yekaterinburg').length,2);checks++;
const definition={schemaVersion:2,mode:'team',pattern:days,members:[
  {userId:first,functionId:fn,slots:[{kind:'shift',startTime:'10:00',endTime:'18:00',breakMinutes:30,note:'Утро'}]},
  {userId:second,functionId:null,slots:[{kind:'shift',startTime:'14:00',endTime:'22:00',breakMinutes:45,note:'Вечер',functionId:fn}]}
]};
const expanded=pattern.expand({from:date,to:date,userIds:[first,second],definition},'Asia/Yekaterinburg');
assert.equal(expanded.length,2);assert.equal(expanded[0].payload.plannedStart,'2032-02-02T05:00:00.000Z');assert.equal(expanded[1].payload.plannedStart,'2032-02-02T09:00:00.000Z');assert.equal(expanded[0].payload.functionId,fn);assert.equal(expanded[1].payload.functionId,fn);assert.equal(expanded[0].payload.note,'Утро');assert.equal(expanded[1].payload.note,'Вечер');checks++;
assert.equal(pattern.expand({from:date,to:date,userIds:[second],definition},'Asia/Yekaterinburg').length,1);checks++;
assert.throws(()=>pattern.expand({from:date,to:date,userIds:['10000000-0000-4000-8000-000000000003'],definition},'Asia/Yekaterinburg'),e=>e.code==='planning_template_member_invalid');checks++;
assert.throws(()=>pattern.definition({...definition,members:[...definition.members,definition.members[0]]}),e=>e.code==='planning_pattern_invalid');checks++;
assert.throws(()=>pattern.definition({...definition,members:[{userId:first,slots:[{kind:'shift',startTime:'22:00',endTime:'06:00',functionId:'bad'}]}]}),e=>e.code==='schedule_function_id_invalid');checks++;
console.log(`SCHEDULE TEMPLATE V2 PASS ${checks}: legacy {pattern,slots} preserved; selected/team modes; per-member time/function/note; subset application; invalid scope and definitions.`);
