'use strict';

const { ScheduleError } = require('./staff-schedule-domain');
const demand = require('./staff-schedule-demand-domain');
const fail = code => { throw new ScheduleError(code, 409); };
const addDays = (date, count) => new Date(Date.parse(`${date}T12:00:00Z`) + count * 86400000).toISOString().slice(0, 10);
function wall(timestamp, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hourCycle:'h23' }).formatToParts(new Date(timestamp));
  const get = type => parts.find(part => part.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}
function instant(local, timezone) {
  const guess = Date.parse(`${local}Z`), offsets = new Set();
  for (const hours of [-36,-12,0,12,36]) { const sample=guess+hours*3600000; offsets.add(Date.parse(`${wall(sample,timezone)}Z`)-sample); }
  const matches=[...offsets].map(offset=>guess-offset).filter(value=>wall(value,timezone)===local);
  if(matches.length!==1)fail('schedule_demand_time_ambiguous');
  return matches[0];
}
function intervalFor(date, rule, timezone) {
  const start=instant(`${date}T${rule.startTime}`,timezone);
  const end=instant(`${addDays(date,rule.endDayOffset)}T${rule.endTime}`,timezone);
  if(end<=start)fail('schedule_demand_time_invalid');
  return {start,end};
}
function activeSegments(from,to,rules,rows,timezone) {
  const advisories=[];
  for(let date=from;date<=to;date=addDays(date,1)) {
    for(const functionId of [...new Set(rules.filter(rule=>rule.active).map(rule=>rule.functionId))]) {
      const dayRules=demand.resolveForDate(rules,functionId,date);
      for(const rule of dayRules) {
        let required;
        try{required=intervalFor(date,rule,timezone);}catch(error){if(!(error instanceof ScheduleError))throw error;advisories.push({code:'schedule_coverage_time_unverifiable',functionId,workDate:date,ruleId:rule.id});continue;}
        const candidates=[];
        for(const row of rows) {
          if(row.status!=='planned'||row.kind==='day_off'||row.kind==='vacation'||row.kind==='sick'||row.kind==='other_absence'||row.functionId!==functionId||!row.plannedStart||!row.plannedEnd)continue;
          const start=Date.parse(row.plannedStart),end=Date.parse(row.plannedEnd);
          if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start)continue;
          if(Number(row.breakMinutes||0)>0&&!(row.breakIntervals||[]).length){
            const a=Math.max(required.start,start),b=Math.min(required.end,end);
            if(b>a)advisories.push({code:'schedule_coverage_break_unknown',functionId,workDate:date,start:new Date(a).toISOString(),end:new Date(b).toISOString(),scheduleId:row.id,unplacedBreakMinutes:Number(row.breakMinutes)});
            continue;
          }
          const breaks=(row.breakIntervals||[]).map(item=>({start:Date.parse(item.start),end:Date.parse(item.end)}));
          const segments=[];let cursor=start;
          for(const pause of breaks.sort((a,b)=>a.start-b.start)) { if(pause.start>cursor)segments.push({start:cursor,end:pause.start}); cursor=Math.max(cursor,pause.end); }
          if(cursor<end)segments.push({start:cursor,end});
          for(const segment of segments)if(segment.start<required.end&&required.start<segment.end)candidates.push({start:segment.start,end:segment.end,userId:row.kind==='open_shift'?null:row.userId,open:row.kind==='open_shift'});
        }
        const bounds=[required.start,required.end];
        for(const item of candidates){bounds.push(Math.max(required.start,item.start),Math.min(required.end,item.end));}
        // Include cross-function boundaries so a legacy/invalid double booking is never
        // counted as two stations just because it was not part of this function's candidates.
        for(const row of rows){if(row.status!=='planned'||row.kind!=='shift'||!row.userId||!row.plannedStart||!row.plannedEnd)continue;const start=Date.parse(row.plannedStart),end=Date.parse(row.plannedEnd);if(start<required.end&&required.start<end){bounds.push(Math.max(required.start,start),Math.min(required.end,end));for(const pause of row.breakIntervals||[]){const a=Date.parse(pause.start),b=Date.parse(pause.end);if(a<required.end&&required.start<b)bounds.push(Math.max(required.start,a),Math.min(required.end,b));}}}
        const sorted=[...new Set(bounds)].sort((a,b)=>a-b);
        for(let i=0;i<sorted.length-1;i++) {
          const start=sorted[i],end=sorted[i+1];if(end<=start)continue;
          const occupying=candidates.filter(item=>item.start<end&&start<item.end);
          const ambiguous=new Set();
          for(const item of occupying.filter(candidate=>candidate.userId))for(const other of rows){if(other.status!=='planned'||other.kind!=='shift'||!other.userId||other.userId!==item.userId||other.functionId===functionId||!other.plannedStart||!other.plannedEnd)continue;const a=Date.parse(other.plannedStart),b=Date.parse(other.plannedEnd);if(a>=end||b<=start)continue;const onBreak=(other.breakIntervals||[]).some(pause=>Date.parse(pause.start)<=start&&Date.parse(pause.end)>=end);if(!onBreak)ambiguous.add(item.userId);}
          for(const userId of ambiguous)advisories.push({code:'schedule_coverage_double_assigned',functionId,workDate:date,start:new Date(start).toISOString(),end:new Date(end).toISOString(),userId});
          const people=new Set(occupying.filter(item=>item.userId&&!ambiguous.has(item.userId)).map(item=>item.userId));
          const open=occupying.filter(item=>item.open).length;
          const count=people.size+open;
          if(count!==rule.requiredCount)advisories.push({code:count<rule.requiredCount?'schedule_coverage_deficit':'schedule_coverage_surplus',functionId,workDate:date,start:new Date(start).toISOString(),end:new Date(end).toISOString(),required:rule.requiredCount,covered:count,shortfall:Math.max(0,rule.requiredCount-count),surplus:Math.max(0,count-rule.requiredCount)});
        }
      }
    }
  }
  return [...new Map(advisories.map(item=>[JSON.stringify(item),item])).values()].slice(0,200);
}
async function evaluateCoverage(db,venueId,from,to,timezone,rows) {
  const result=await db.query(`SELECT id,function_id,weekday,work_date::text,effective_from::text,effective_to::text,
      to_char(start_time,'HH24:MI') AS start_time,to_char(end_time,'HH24:MI') AS end_time,end_day_offset,required_count,active,timezone,version
    FROM staff_schedule_demand_rules WHERE venue_id=$1 AND active`,[venueId]);
  const rules=result.rows.map(row=>({id:row.id,functionId:row.function_id,scope:row.weekday==null?'date_range':'weekly',weekday:row.weekday,
    effectiveFrom:row.effective_from,effectiveTo:row.effective_to,startTime:row.start_time,endTime:row.end_time,endDayOffset:row.end_day_offset,
    requiredCount:row.required_count,active:row.active,timezone:row.timezone,version:row.version}));
  const staleRules=rules.filter(rule=>rule.timezone!==timezone);
  if(staleRules.length)return {advisories:[{code:'schedule_demand_timezone_changed',ruleIds:staleRules.map(rule=>rule.id),oldTimezones:[...new Set(staleRules.map(rule=>rule.timezone))],timezone}],
    configurationVersion:rules.map(rule=>({id:rule.id,version:rule.version,active:rule.active,timezone:rule.timezone})).sort((a,b)=>a.id.localeCompare(b.id))};
  const advisories=activeSegments(from,to,rules,rows,timezone);
  return {advisories,configurationVersion:rules.map(rule=>({id:rule.id,version:rule.version,active:rule.active})).sort((a,b)=>a.id.localeCompare(b.id))};
}
module.exports={evaluateCoverage,activeSegments,intervalFor};
