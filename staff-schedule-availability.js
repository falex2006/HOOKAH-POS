'use strict';

const { ScheduleError, localDate } = require('./staff-schedule-domain');

const addDays = (date, count) => new Date(Date.parse(`${date}T12:00:00Z`) + count * 86400000).toISOString().slice(0, 10);
const weekday = date => (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7 + 1;
const overlaps = (a, b) => a.start < b.end && b.start < a.end;
const contains = (windows, interval) => {
  let cursor=interval.start;
  for(const window of windows.slice().sort((a,b)=>a.start-b.start)){
    if(window.end<=cursor)continue;
    if(window.start>cursor)return false;
    cursor=window.end;
    if(cursor>=interval.end)return true;
  }
  return false;
};

function wall(timestamp, timezone) {
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(timestamp));
  const get=type=>parts.find(part=>part.type===type).value;
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}
function instant(local, timezone) {
  const guess=Date.parse(`${local}Z`),offsets=new Set();
  for(const hours of [-36,-12,0,12,36]){const sample=guess+hours*3600000;offsets.add(Date.parse(`${wall(sample,timezone)}Z`)-sample);}
  const candidates=[...offsets].map(offset=>guess-offset).filter(timestamp=>wall(timestamp,timezone)===local);
  if(candidates.length!==1)throw new ScheduleError('schedule_availability_time_ambiguous',409);
  return new Date(candidates[0]).toISOString();
}

function asInterval(date, item, timezone) {
  const start = Date.parse(instant(`${date}T${item.startTime}`, timezone));
  const endDate = addDays(date, item.endDayOffset);
  const end = Date.parse(instant(`${endDate}T${item.endTime}`, timezone));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new ScheduleError('schedule_availability_time_invalid', 409);
  return { start, end, id: item.id, kind: item.kind, workDate: date };
}

function localMidnight(date, timezone) {
  // Some zones jump over, or repeat, 00:00. Find the first instant of the
  // calendar date rather than asking the wall-clock resolver for 00:00.
  const guess=Date.parse(`${date}T00:00:00Z`);
  let low=guess-48*3600000,high=guess+48*3600000;
  if(localDate(new Date(low),timezone)>=date||localDate(new Date(high),timezone)<date)
    throw new ScheduleError('schedule_availability_date_invalid',409);
  while(high-low>1){const mid=low+Math.floor((high-low)/2);if(localDate(new Date(mid),timezone)<date)low=mid;else high=mid;}
  return high;
}

async function evaluateAvailability(db, venueId, timezone, entries) {
  const employees = [...new Set(entries.filter(row => row.userId && row.kind === 'shift').map(row => row.userId))];
  if (!employees.length) return { conflicts: [], warnings: [], configurationVersion: {} };
  const ruleRows=await db.query(`SELECT user_id,weekday,rule_kind AS kind,to_char(start_time,'HH24:MI') AS "startTime",to_char(end_time,'HH24:MI') AS "endTime",end_day_offset AS "endDayOffset",
      effective_from::text AS "effectiveFrom",effective_to::text AS "effectiveTo",id
      FROM staff_schedule_availability_rules WHERE venue_id=$1 AND user_id=ANY($2::uuid[]) AND active`, [venueId, employees]);
  const exceptionRows=await db.query(`SELECT user_id,work_date::text AS "workDate",rule_kind AS kind,to_char(start_time,'HH24:MI') AS "startTime",to_char(end_time,'HH24:MI') AS "endTime",end_day_offset AS "endDayOffset",id
      FROM staff_schedule_availability_exceptions WHERE venue_id=$1 AND user_id=ANY($2::uuid[]) AND active`, [venueId, employees]);
  const versions=await db.query(`SELECT entity_id AS "userId",MAX(id)::bigint AS version FROM staff_schedule_config_events
      WHERE venue_id=$1 AND entity_type IN ('availability_rule','availability_exception') AND entity_id=ANY($2::uuid[]) GROUP BY entity_id`, [venueId, employees]);
  const rules = new Map(), exceptions = new Map();
  for (const row of ruleRows.rows) { const list = rules.get(row.user_id) || []; list.push(row); rules.set(row.user_id, list); }
  for (const row of exceptionRows.rows) { const key = `${row.user_id}:${row.workDate}`, list = exceptions.get(key) || []; list.push(row); exceptions.set(key, list); }
  const conflicts = [], warnings = [];
  for (const row of entries) {
    if (!row.userId || row.kind !== 'shift' || !row.plannedStart || !row.plannedEnd) continue;
    const shift = { start: Date.parse(row.plannedStart), end: Date.parse(row.plannedEnd) };
    if (!Number.isFinite(shift.start) || !Number.isFinite(shift.end) || shift.end <= shift.start) continue;
    const first = localDate(new Date(shift.start), timezone), last = localDate(new Date(shift.end - 1), timezone);
    const daySegments = [];
    for (let date = first; date <= last; date = addDays(date, 1)) {
      const start = Math.max(shift.start, localMidnight(date, timezone));
      const end = Math.min(shift.end, localMidnight(addDays(date, 1), timezone));
      if (end > start) daySegments.push({ date, start, end });
    }
    const userRules = rules.get(row.userId) || [];
    const intervalsByDate = new Map();
    // Previous-day windows may cross midnight; include them when evaluating this shift.
    for (let date = addDays(first, -1); date <= last; date = addDays(date, 1)) {
      const dated = exceptions.get(`${row.userId}:${date}`);
      const applicable = dated?.length ? dated : userRules.filter(rule => rule.weekday === weekday(date)
        && date >= rule.effectiveFrom && (!rule.effectiveTo || date <= rule.effectiveTo));
      intervalsByDate.set(date, applicable.map(item => ({ ...asInterval(date, item, timezone), kind: item.kind })));
    }
    let hard = null, soft = null;
    for (const segment of daySegments) {
      const nearby = [addDays(segment.date, -1), segment.date].flatMap(date => intervalsByDate.get(date) || []);
      const unavailable = nearby.filter(item => item.kind === 'unavailable');
      if (unavailable.some(item => overlaps(item, segment))) { hard = { code: 'schedule_availability_unavailable', userId: row.userId, workDate: segment.date, scheduleId: row.id }; break; }
      const available = nearby.filter(item => item.kind === 'available');
      const hasAvailableWindowToday = (intervalsByDate.get(segment.date) || []).some(item => item.kind === 'available');
      if ((hasAvailableWindowToday || available.some(item => overlaps(item,segment))) && !contains(available, segment)) { hard = { code: 'schedule_availability_outside_window', userId: row.userId, workDate: segment.date, scheduleId: row.id }; break; }
      const preferred = nearby.filter(item => item.kind === 'preferred');
      const hasPreferenceToday = (intervalsByDate.get(segment.date) || []).some(item => item.kind === 'preferred');
      if ((hasPreferenceToday || preferred.some(item => overlaps(item,segment))) && !contains(preferred, segment)) soft = { code: 'schedule_preferred_availability_mismatch', userId: row.userId, workDate: segment.date, scheduleId: row.id };
    }
    if (hard) conflicts.push(hard);
    if (soft) warnings.push(soft);
    if (conflicts.length >= 200) break;
  }
  const versionMap=Object.fromEntries(employees.sort().map(userId=>[userId,Number(versions.rows.find(row=>row.userId===userId)?.version||0)]));
  return { conflicts, warnings, configurationVersion: versionMap };
}

module.exports = { evaluateAvailability };
