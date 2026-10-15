'use strict';
const { ScheduleError, normalize, range, UUID } = require('./staff-schedule-domain');
const { instant } = require('./staff-schedule-copy');
const fail = code => { throw new ScheduleError(code, 400); };
const addDays = (day, n) => new Date(Date.parse(day+'T12:00Z')+n*86400000).toISOString().slice(0,10);
function users(value) {
  if (!Array.isArray(value) || !value.length || value.length>100 || value.some(id=>typeof id!=='string'||!UUID.test(id)) || new Set(value.map(x=>x.toLowerCase())).size!==value.length) fail('planning_users_invalid');
  return value.map(x=>x.toLowerCase()).sort();
}
function recurrence(value) {
  if(!value||typeof value!=='object')fail('planning_pattern_invalid');
  const ints=(v,min,max)=>Array.isArray(v)&&v.length>0&&v.length<=max-min+1&&v.every(n=>Number.isInteger(n)&&n>=min&&n<=max)&&new Set(v).size===v.length;
  if(value.type==='weekdays'&&ints(value.weekdays,1,7))return {type:'weekdays',weekdays:[...value.weekdays].sort((a,b)=>a-b)};
  if(value.type==='cycle'&&Number.isInteger(value.cycleDays)&&value.cycleDays>=1&&value.cycleDays<=93&&ints(value.dayOffsets,0,value.cycleDays-1)){
    range(value.anchorDate,value.anchorDate);return {type:'cycle',anchorDate:value.anchorDate,cycleDays:value.cycleDays,dayOffsets:[...value.dayOffsets].sort((a,b)=>a-b)};
  }
  fail('planning_pattern_invalid');
}
function slot(value) {
  if(!value||typeof value!=='object'||Array.isArray(value))fail('planning_slot_invalid');
  const kind=value.kind||'shift',note=value.note??'',breakMinutes=value.breakMinutes??0;
  if(typeof note!=='string'||note.length>500)fail('schedule_note_invalid');
  const functionId=value.functionId==null?null:typeof value.functionId==='string'&&UUID.test(value.functionId)?value.functionId.toLowerCase():fail('schedule_function_id_invalid');
  if(kind!=='shift'){
    if(!['day_off','vacation','sick','other_absence'].includes(kind)||value.startTime!=null||value.endTime!=null||value.endDayOffset!=null||breakMinutes!==0||functionId)fail('planning_slot_invalid');
    return {kind,note,breakMinutes:0};
  }
  if(typeof value.startTime!=='string'||typeof value.endTime!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(value.startTime)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(value.endTime)||![0,1].includes(value.endDayOffset??0))fail('planning_slot_invalid');
  const minutes=t=>Number(t.slice(0,2))*60+Number(t.slice(3)),duration=minutes(value.endTime)+(value.endDayOffset??0)*1440-minutes(value.startTime);
  if(duration<=0||duration>1440||!Number.isInteger(breakMinutes)||breakMinutes<0||breakMinutes>=duration)fail('planning_slot_invalid');
  return {kind,startTime:value.startTime,endTime:value.endTime,endDayOffset:value.endDayOffset??0,breakMinutes,note,functionId};
}
function slots(value){
  if(!Array.isArray(value)||!value.length||value.length>24)fail('planning_pattern_invalid');
  return value.map(slot);
}
function definition(value) {
  if(!value||typeof value!=='object'||Array.isArray(value))fail('planning_pattern_invalid');
  const pattern=recurrence(value.pattern);
  // Legacy {pattern,slots} remains byte-shape compatible in API responses and application.
  if(value.schemaVersion===undefined)return {pattern,slots:slots(value.slots)};
  if(value.schemaVersion!==2||!['selected','team'].includes(value.mode))fail('planning_pattern_invalid');
  if(value.mode==='selected')return {schemaVersion:2,mode:'selected',pattern,slots:slots(value.slots)};
  if(!Array.isArray(value.members)||!value.members.length||value.members.length>50)fail('planning_pattern_invalid');
  const members=value.members.map(member=>{
    if(!member||typeof member!=='object'||Array.isArray(member)||typeof member.userId!=='string'||!UUID.test(member.userId))fail('planning_pattern_invalid');
    const functionId=member.functionId==null?null:typeof member.functionId==='string'&&UUID.test(member.functionId)?member.functionId.toLowerCase():fail('schedule_function_id_invalid');
    return {userId:member.userId.toLowerCase(),functionId,slots:slots(member.slots)};
  });
  if(new Set(members.map(member=>member.userId)).size!==members.length)fail('planning_pattern_invalid');
  return {schemaVersion:2,mode:'team',pattern,members};
}
function expand(input, timezone) {
  range(input.from,input.to);const ids=users(input.userIds),def=definition(input.definition),result=[];
  const targets=def.schemaVersion===2&&def.mode==='team'
    ? (ids.some(id=>!def.members.some(member=>member.userId===id))?fail('planning_template_member_invalid'):def.members.filter(member=>ids.includes(member.userId)))
    : ids.map(userId=>({userId,functionId:null,slots:def.slots}));
  if(!targets.length)fail('planning_users_invalid');
  for(let day=input.from;day<=input.to;day=addDays(day,1)){
    const p=def.pattern,weekday=new Date(day+'T12:00Z').getUTCDay()||7;
    const offset=p.type==='cycle'?((Math.round((Date.parse(day)-Date.parse(p.anchorDate))/86400000)%p.cycleDays)+p.cycleDays)%p.cycleDays:0;
    if(!(p.type==='weekdays'?p.weekdays.includes(weekday):p.dayOffsets.includes(offset)))continue;
    for(const member of targets)for(const item of member.slots){
      const payload={userId:member.userId,workDate:day,kind:item.kind,note:item.note,breakMinutes:item.breakMinutes};
      if(item.kind==='shift'){
        payload.plannedStart=instant(day+'T'+item.startTime,timezone);
        payload.plannedEnd=instant(addDays(day,item.endDayOffset)+'T'+item.endTime,timezone);
        payload.functionId=item.functionId||member.functionId||null;
      }
      result.push({operation:'create',payload:normalize(payload,timezone)});
      if(result.length>200)fail('planning_operations_limit');
    }
  }
  return result;
}
module.exports={definition,expand,users,addDays};
