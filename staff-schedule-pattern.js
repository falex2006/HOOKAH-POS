'use strict';
const { ScheduleError, normalize, range, UUID } = require('./staff-schedule-domain');
const { instant } = require('./staff-schedule-copy');
const fail = code => { throw new ScheduleError(code, 400); };
const addDays = (day, n) => new Date(Date.parse(day+'T12:00Z')+n*86400000).toISOString().slice(0,10);
function users(value) {
  if (!Array.isArray(value) || !value.length || value.length>100 || value.some(id=>typeof id!=='string'||!UUID.test(id)) || new Set(value.map(x=>x.toLowerCase())).size!==value.length) fail('planning_users_invalid');
  return value.map(x=>x.toLowerCase()).sort();
}
function definition(value) {
  if (!value || typeof value!=='object' || !value.pattern || !Array.isArray(value.slots) || !value.slots.length || value.slots.length>24) fail('planning_pattern_invalid');
  const p=value.pattern;
  let pattern;
  const ints=(v,min,max)=>Array.isArray(v)&&v.length>0&&v.length<=max-min+1&&v.every(n=>Number.isInteger(n)&&n>=min&&n<=max)&&new Set(v).size===v.length;
  if(p.type==='weekdays' && ints(p.weekdays,1,7)) pattern={type:p.type,weekdays:[...p.weekdays].sort((a,b)=>a-b)};
  else if(p.type==='cycle' && Number.isInteger(p.cycleDays)&&p.cycleDays>=1&&p.cycleDays<=93&&ints(p.dayOffsets,0,p.cycleDays-1)) {
    range(p.anchorDate,p.anchorDate); pattern={type:p.type,anchorDate:p.anchorDate,cycleDays:p.cycleDays,dayOffsets:[...p.dayOffsets].sort((a,b)=>a-b)};
  } else fail('planning_pattern_invalid');
  const slots=value.slots.map(s=>{
    if(!s || typeof s!=='object') fail('planning_slot_invalid');
    const kind=s.kind||'shift', note=s.note??'', breakMinutes=s.breakMinutes??0;
    if(typeof note!=='string'||note.length>500) fail('schedule_note_invalid');
    if(kind!=='shift') {
      if(!['day_off','vacation','sick','other_absence'].includes(kind)||s.startTime!=null||s.endTime!=null||s.endDayOffset!=null||breakMinutes!==0) fail('planning_slot_invalid');
      return {kind,note,breakMinutes:0};
    }
    if(typeof s.startTime!=='string'||typeof s.endTime!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(s.startTime)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(s.endTime)||![0,1].includes(s.endDayOffset??0)) fail('planning_slot_invalid');
    const minutes=t=>Number(t.slice(0,2))*60+Number(t.slice(3));
    const duration=minutes(s.endTime)+(s.endDayOffset??0)*1440-minutes(s.startTime);
    if(duration<=0||duration>1440||!Number.isInteger(breakMinutes)||breakMinutes<0||breakMinutes>=duration) fail('planning_slot_invalid');
    return {kind,startTime:s.startTime,endTime:s.endTime,endDayOffset:s.endDayOffset??0,breakMinutes,note};
  });
  return {pattern,slots};
}
function expand(input, timezone) {
  range(input.from,input.to); const ids=users(input.userIds), def=definition(input.definition), result=[];
  for(let day=input.from;day<=input.to;day=addDays(day,1)) {
    const p=def.pattern, weekday=new Date(day+'T12:00Z').getUTCDay()||7;
    const offset=p.type==='cycle'?((Math.round((Date.parse(day)-Date.parse(p.anchorDate))/86400000)%p.cycleDays)+p.cycleDays)%p.cycleDays:0;
    if(!(p.type==='weekdays'?p.weekdays.includes(weekday):p.dayOffsets.includes(offset))) continue;
    for(const userId of ids) for(const slot of def.slots) {
      const payload={userId,workDate:day,kind:slot.kind,note:slot.note,breakMinutes:slot.breakMinutes};
      if(slot.kind==='shift') { payload.plannedStart=instant(day+'T'+slot.startTime,timezone); payload.plannedEnd=instant(addDays(day,slot.endDayOffset)+'T'+slot.endTime,timezone); }
      result.push({operation:'create',payload:normalize(payload,timezone)});
      if(result.length>200) fail('planning_operations_limit');
    }
  }
  return result;
}
module.exports={definition,expand,users,addDays};
