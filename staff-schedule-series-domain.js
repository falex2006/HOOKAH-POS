'use strict';

const {UUID,range}=require('./staff-schedule-domain');
const pattern=require('./staff-schedule-pattern');
const {ScheduleError}=require('./staff-schedule-domain');
const {randomUUID}=require('node:crypto');
const fail=(code,status=400)=>{throw new ScheduleError(code,status);};
const addDays=(day,count)=>new Date(Date.parse(`${day}T12:00:00Z`)+count*86400000).toISOString().slice(0,10);
const daysBetween=(from,to)=>(Date.parse(`${to}T00:00:00Z`)-Date.parse(`${from}T00:00:00Z`))/86400000;
const date=value=>{range(value,value);return value;};

function normalizeRecurrence(value,anchorDate){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['pattern','slots','cycleOffset','slotKeys'].includes(key)))fail('schedule_series_recurrence_invalid');
  const definition=pattern.definition({schemaVersion:2,mode:'selected',pattern:value.pattern,slots:value.slots});
  const slotKeys=value.slotKeys??definition.slots.map(()=>randomUUID());
  if(!Array.isArray(slotKeys)||slotKeys.length!==definition.slots.length||slotKeys.some(key=>typeof key!=='string'||!UUID.test(key))||new Set(slotKeys.map(key=>key.toLowerCase())).size!==slotKeys.length)fail('schedule_series_recurrence_invalid');
  if(definition.pattern.type==='cycle'){
    if(definition.pattern.anchorDate!==anchorDate)fail('schedule_series_anchor_mismatch');
    const offset=value.cycleOffset??0;
    if(!Number.isSafeInteger(offset)||offset<0||offset>=definition.pattern.cycleDays)fail('schedule_series_recurrence_invalid');
    return {pattern:definition.pattern,slots:definition.slots,slotKeys:slotKeys.map(key=>key.toLowerCase()),cycleOffset:offset};
  }
  if(value.cycleOffset!==undefined&&value.cycleOffset!==0)fail('schedule_series_recurrence_invalid');
  return {pattern:definition.pattern,slots:definition.slots,slotKeys:slotKeys.map(key=>key.toLowerCase()),cycleOffset:0};
}

function occursOn(pattern,cycleOffset,anchorDate,day){
  const weekday=new Date(`${day}T12:00:00Z`).getUTCDay()||7;
  if(pattern.type==='weekdays')return pattern.weekdays.includes(weekday);
  const elapsed=daysBetween(anchorDate,day),offset=((elapsed%pattern.cycleDays)+pattern.cycleDays)%pattern.cycleDays;
  const shifted=(offset+cycleOffset)%pattern.cycleDays;
  return pattern.dayOffsets.includes(shifted);
}
function normalizeExceptions(value,anchorDate,untilDate,recurrence){
  if(value===undefined)return [];
  if(!Array.isArray(value)||value.length>200)fail('schedule_series_exceptions_invalid');
  const seen=new Set();
  return value.map(item=>{
    if(!item||typeof item!=='object'||Array.isArray(item)||Object.keys(item).some(key=>!['occurrenceDate','occurrenceKey','kind','slot','reason'].includes(key)))fail('schedule_series_exceptions_invalid');
    const occurrenceDate=date(item.occurrenceDate),occurrenceKey=typeof item.occurrenceKey==='string'?item.occurrenceKey.toLowerCase():item.occurrenceKey;
    if(occurrenceDate<anchorDate||occurrenceDate>untilDate||typeof occurrenceKey!=='string'||!UUID.test(occurrenceKey)||!recurrence.slotKeys.includes(occurrenceKey.toLowerCase())||!occursOn(recurrence.pattern,recurrence.cycleOffset,anchorDate,occurrenceDate)||!['skip','replace'].includes(item.kind))fail('schedule_series_exceptions_invalid');
    const identity=`${occurrenceDate}:${occurrenceKey}`;if(seen.has(identity))fail('schedule_series_exception_duplicate');seen.add(identity);
    const reason=item.reason===undefined?'':item.reason;if(typeof reason!=='string'||reason.length>500)fail('schedule_reason_invalid');
    if(item.kind==='skip'){
      if(item.slot!==undefined)fail('schedule_series_exceptions_invalid');
      return {occurrenceDate,occurrenceKey,kind:'skip',reason:reason.trim()};
    }
    const definition=pattern.definition({schemaVersion:2,mode:'selected',pattern:{type:'weekdays',weekdays:[1]},slots:[item.slot]});
    return {occurrenceDate,occurrenceKey,kind:'replace',slot:definition.slots[0],reason:reason.trim()};
  }).sort((a,b)=>a.occurrenceDate.localeCompare(b.occurrenceDate)||a.occurrenceKey.localeCompare(b.occurrenceKey));
}

function normalizeSeries(input,timezone,existing=null){
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['name','userId','functionId','anchorDate','untilDate','recurrence','exceptions','version','requestKey','state','reason'].includes(key)))fail('schedule_series_input_invalid');
  const name=typeof input.name==='string'&&input.name.trim().length>=1&&input.name.trim().length<=120?input.name.trim():fail('schedule_series_name_invalid');
  const userId=typeof input.userId==='string'&&UUID.test(input.userId)?input.userId.toLowerCase():fail('schedule_employee_invalid');
  const functionId=input.functionId==null?null:typeof input.functionId==='string'&&UUID.test(input.functionId)?input.functionId.toLowerCase():fail('schedule_function_id_invalid');
  const anchorDate=date(input.anchorDate),untilDate=date(input.untilDate);
  if(untilDate<anchorDate||daysBetween(anchorDate,untilDate)>365)fail('schedule_series_horizon_invalid');
  const recurrence=normalizeRecurrence(input.recurrence,anchorDate);
  const exceptions=normalizeExceptions(input.exceptions??existing?.exceptions?.filter(item=>item.kind!=='manual')??[],anchorDate,untilDate,recurrence);
  const state=input.state??existing?.state??'active';if(!['active','paused','archived'].includes(state))fail('schedule_series_state_invalid');
  const reason=input.reason===undefined?'':input.reason;if(typeof reason!=='string'||reason.length>500)fail('schedule_reason_invalid');
  return {name,userId,functionId,anchorDate,untilDate,timezone,recurrence,exceptions,state,reason:reason.trim()};
}

function expandSeries(series,from,to,timezone){
  range(from,to);
  if(from<series.anchorDate||to>series.untilDate)fail('schedule_series_range_invalid');
  if(series.state!=='active')fail('schedule_series_inactive',409);
  const recurrence=series.recurrence,exceptions=new Map((series.exceptions||[]).map(item=>[`${item.occurrenceDate}:${item.occurrenceKey}`,item]));
  const selected=recurrence.pattern.type==='cycle'&&recurrence.cycleOffset
    ? {...recurrence.pattern,dayOffsets:recurrence.pattern.dayOffsets.map(offset=>(offset-recurrence.cycleOffset+recurrence.pattern.cycleDays)%recurrence.pattern.cycleDays)}
    : recurrence.pattern;
  const definition={schemaVersion:2,mode:'selected',pattern:selected,slots:recurrence.slots};
  const result=[];
  for(let day=from;day<=to;day=addDays(day,1)){
    const occurrences=pattern.expand({from:day,to:day,userIds:[series.userId],definition},timezone);
    occurrences.forEach((op,index)=>{
      const occurrenceKey=recurrence.slotKeys[index],exception=exceptions.get(`${day}:${occurrenceKey}`);
      if(exception?.kind==='skip'||exception?.kind==='manual')return;
      const payload={...op.payload,functionId:op.payload.functionId||series.functionId||null};
      if(exception?.kind==='replace'){
        const replacement=pattern.expand({from:day,to:day,userIds:[series.userId],definition:{schemaVersion:2,mode:'selected',pattern:{type:'weekdays',weekdays:[new Date(`${day}T12:00Z`).getUTCDay()||7]},slots:[exception.slot]}},timezone)[0]?.payload;
        if(!replacement)fail('schedule_series_exception_invalid');
        Object.assign(payload,replacement,{functionId:replacement.functionId||series.functionId||null});
      }
      result.push({operation:'create',payload,occurrenceDate:day,occurrenceKey});
      if(result.length>200)fail('planning_operations_limit');
    });
  }
  return result;
}

module.exports={normalizeSeries,normalizeRecurrence,normalizeExceptions,expandSeries,daysBetween,addDays,occursOn};
