'use strict';
const { beginPayrollSourceProducerTransaction } = require('./payroll-source-fence');

const { createHash } = require('node:crypto');
const { ScheduleError, UUID } = require('./staff-schedule-domain');
const { resolveAccess } = require('./staff-schedule-access');
const { localDate } = require('./staff-schedule-domain');

const fail = (code, status = 400) => { throw new ScheduleError(code, status); };
const stable = value => Array.isArray(value) ? value.map(stable)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
const uuid = value => typeof value === 'string' && UUID.test(value);
const time = value => typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
const requestKey = value => { if (!uuid(value)) fail('schedule_request_key_required'); return value.toLowerCase(); };

function normalize(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !['version', 'requestKey', 'thresholds', 'businessHoursEnabled', 'intervals'].includes(key))) {
    fail('schedule_venue_policy_input_invalid');
  }
  const thresholds = input.thresholds;
  if (!thresholds || typeof thresholds !== 'object' || Array.isArray(thresholds)
    || Object.keys(thresholds).some(key => !['maxWeeklyMinutes', 'minimumRestMinutes', 'maximumConsecutiveDays'].includes(key))) {
    fail('schedule_venue_policy_input_invalid');
  }
  const value = (key, min, max) => {
    const item = thresholds[key];
    if (item === null) return null;
    if (!Number.isSafeInteger(item) || item < min || item > max) fail('schedule_venue_policy_threshold_invalid');
    return item;
  };
  if (!Number.isSafeInteger(input.version) || input.version < 0 || typeof input.businessHoursEnabled !== 'boolean'
    || !Array.isArray(input.intervals) || input.intervals.length > 70) fail('schedule_venue_policy_input_invalid');
  const intervals = input.intervals.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || Object.keys(item).some(key => !['weekday', 'startTime', 'endTime', 'endDayOffset'].includes(key))
      || !Number.isSafeInteger(item.weekday) || item.weekday < 1 || item.weekday > 7
      || !time(item.startTime) || !time(item.endTime) || ![0, 1].includes(item.endDayOffset ?? 0)) fail('schedule_venue_policy_interval_invalid');
    const offset = item.endDayOffset ?? 0;
    if ((offset === 0 && item.endTime <= item.startTime)
      || (offset === 1 && item.endTime === item.startTime && item.startTime !== '00:00')) fail('schedule_venue_policy_interval_invalid');
    return { weekday: item.weekday, startTime: item.startTime, endTime: item.endTime, endDayOffset: offset };
  }).sort((a, b) => a.weekday - b.weekday || a.startTime.localeCompare(b.startTime) || a.endTime.localeCompare(b.endTime) || a.endDayOffset - b.endDayOffset);
  const keys = intervals.map(item => `${item.weekday}:${item.startTime}:${item.endTime}:${item.endDayOffset}`);
  if (new Set(keys).size !== keys.length) fail('schedule_venue_policy_interval_duplicate');
  return {
    version: input.version,
    requestKey: requestKey(input.requestKey),
    thresholds: {
      maxWeeklyMinutes: value('maxWeeklyMinutes', 1, 10080),
      minimumRestMinutes: value('minimumRestMinutes', 0, 10080),
      maximumConsecutiveDays: value('maximumConsecutiveDays', 1, 93)
    },
    businessHoursEnabled: input.businessHoursEnabled,
    intervals
  };
}

async function read(db, venueId, timezone) {
  const policy = (await db.query(`SELECT max_weekly_minutes AS "maxWeeklyMinutes",minimum_rest_minutes AS "minimumRestMinutes",
      maximum_consecutive_days AS "maximumConsecutiveDays",business_hours_enabled AS "businessHoursEnabled",version
    FROM staff_schedule_venue_policies WHERE venue_id=$1`, [venueId])).rows[0];
  const intervals = await db.query(`SELECT id,weekday,to_char(start_time,'HH24:MI') AS "startTime",to_char(end_time,'HH24:MI') AS "endTime",
      end_day_offset AS "endDayOffset",active,version FROM staff_schedule_venue_business_intervals
    WHERE venue_id=$1 AND active ORDER BY weekday,start_time,end_time,id`, [venueId]);
  const configVersion = Number((await db.query(`SELECT COALESCE(MAX(id),0)::bigint AS version FROM staff_schedule_config_events
    WHERE venue_id=$1 AND entity_type='venue_policy'`, [venueId])).rows[0].version);
  return {
    venueId, timezone, version: policy?.version ?? 0, configurationVersion: configVersion,
    thresholds: {
      maxWeeklyMinutes: policy?.maxWeeklyMinutes ?? null,
      minimumRestMinutes: policy?.minimumRestMinutes ?? null,
      maximumConsecutiveDays: policy?.maximumConsecutiveDays ?? null
    },
    businessHoursEnabled: policy?.businessHoursEnabled ?? false,
    intervals: intervals.rows
  };
}

async function getVenuePolicy(db, principal) {
  const client = await db.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const access = await resolveAccess(client, principal);
    if (!access.canManageSettings) fail('schedule_settings_forbidden', 403);
    const value = await read(client, principal.venueId, access.timezone);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

async function saveVenuePolicy(pool, principal, input) {
  const value = normalize(input), signature = hash({
    version: value.version, thresholds: value.thresholds,
    businessHoursEnabled: value.businessHoursEnabled, intervals: value.intervals
  });
  const db = await pool.connect();
  try {
    await beginPayrollSourceProducerTransaction(db, principal.venueId);
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`schedule:${principal.venueId}`]);
    const access = await resolveAccess(db, principal, true);
    if (!access.canManageSettings) fail('schedule_settings_forbidden', 403);
    const replay = (await db.query(`SELECT fingerprint,response FROM staff_schedule_requests
      WHERE venue_id=$1 AND actor_id=$2 AND request_key=$3`, [principal.venueId, principal.userId, value.requestKey])).rows[0];
    if (replay) {
      if (replay.fingerprint !== signature) fail('schedule_request_conflict', 409);
      await db.query('COMMIT'); return replay.response;
    }
    const before = await read(db, principal.venueId, access.timezone);
    if (before.version !== value.version) fail('schedule_venue_policy_version_conflict', 409);
    const nextVersion = before.version + 1, thresholds = value.thresholds;
    await db.query(`INSERT INTO staff_schedule_venue_policies
        (venue_id,max_weekly_minutes,minimum_rest_minutes,maximum_consecutive_days,business_hours_enabled,version,created_by,updated_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$7)
      ON CONFLICT(venue_id) DO UPDATE SET max_weekly_minutes=EXCLUDED.max_weekly_minutes,
        minimum_rest_minutes=EXCLUDED.minimum_rest_minutes,maximum_consecutive_days=EXCLUDED.maximum_consecutive_days,
        business_hours_enabled=EXCLUDED.business_hours_enabled,version=EXCLUDED.version,updated_by=EXCLUDED.updated_by,updated_at=now()`,
    [principal.venueId, thresholds.maxWeeklyMinutes, thresholds.minimumRestMinutes, thresholds.maximumConsecutiveDays,
      value.businessHoursEnabled, nextVersion, principal.userId]);
    await db.query(`UPDATE staff_schedule_venue_business_intervals SET active=false,version=version+1,updated_by=$2,updated_at=now()
      WHERE venue_id=$1 AND active`, [principal.venueId, principal.userId]);
    for (const interval of value.intervals) await db.query(`INSERT INTO staff_schedule_venue_business_intervals
        (venue_id,weekday,start_time,end_time,end_day_offset,created_by,updated_by)
      VALUES($1,$2,$3,$4,$5,$6,$6)`, [principal.venueId, interval.weekday, interval.startTime, interval.endTime,
      interval.endDayOffset, principal.userId]);
    const preliminary = await read(db, principal.venueId, access.timezone);
    await db.query(`INSERT INTO staff_schedule_config_events
      (venue_id,actor_id,entity_type,entity_id,action,before_data,after_data)
      VALUES($1,$2,'venue_policy',$1,'replace',$3::jsonb,$4::jsonb)`,
    [principal.venueId, principal.userId, JSON.stringify(before), JSON.stringify(preliminary)]);
    const response = await read(db, principal.venueId, access.timezone);
    await db.query(`INSERT INTO staff_schedule_requests(venue_id,actor_id,request_key,fingerprint,response)
      VALUES($1,$2,$3,$4,$5::jsonb)`,
    [principal.venueId, principal.userId, value.requestKey, signature, JSON.stringify(response)]);
    await db.query('COMMIT');
    return response;
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally { db.release(); }
}

const addDays = (date, count) => new Date(Date.parse(`${date}T12:00:00Z`) + count * 86400000).toISOString().slice(0, 10);
const weekday = date => (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7 + 1;
const monday = date => addDays(date, -(weekday(date) - 1));
const weekdayOfTimestamp = (timestamp, timezone) => weekday(localDate(new Date(timestamp), timezone));
const wall = (timestamp, timezone) => {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(timestamp));
  const get = type => parts.find(part => part.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
};
const instant = (local, timezone) => {
  const guess=Date.parse(`${local}Z`),offsets=new Set();
  for(const hours of [-36,-12,0,12,36]){const sample=guess+hours*3600000;offsets.add(Date.parse(`${wall(sample,timezone)}Z`)-sample);}
  const candidates=[...offsets].map(offset=>guess-offset).filter(value=>wall(value,timezone)===local);
  if(candidates.length!==1)throw new Error('policy_time_ambiguous');
  return new Date(candidates[0]).toISOString();
};
const localMidnight = (date, timezone) => {
  const guess = Date.parse(`${date}T00:00:00Z`);
  let low = guess - 48 * 3600000, high = guess + 48 * 3600000;
  if (localDate(new Date(low), timezone) >= date || localDate(new Date(high), timezone) < date) throw new Error('policy_date_invalid');
  while (high - low > 1) { const mid = low + Math.floor((high - low) / 2); if (localDate(new Date(mid), timezone) < date) low = mid; else high = mid; }
  return high;
};

async function evaluateVenuePolicy(db, venueId, timezone, candidateRows, excludedIds = [], contextRows = null) {
  const config = await read(db, venueId, timezone);
  const employees = [...new Set(candidateRows.filter(row => row.userId && row.kind === 'shift').map(row => row.userId))];
  const policyFingerprint = hash({ timezone: config.timezone, version: config.version, configurationVersion: config.configurationVersion,
    thresholds: config.thresholds, businessHoursEnabled: config.businessHoursEnabled,
    intervals: config.intervals.map(({ id, weekday: day, startTime, endTime, endDayOffset, version: v }) => ({ id, weekday: day, startTime, endTime, endDayOffset, version: v })) });
  if (!employees.length) return { warnings: [], configurationVersion: policyFingerprint, policy: { version: config.version, configurationFingerprint: policyFingerprint, timezone } };
  const instants = candidateRows.filter(row => employees.includes(row.userId) && row.kind === 'shift' && row.plannedStart && row.plannedEnd)
    .flatMap(row => [Date.parse(row.plannedStart), Date.parse(row.plannedEnd)]).filter(Number.isFinite);
  if (!instants.length) return { warnings: [], configurationVersion: policyFingerprint, policy: { version: config.version, configurationFingerprint: policyFingerprint, timezone } };
  const first = localDate(new Date(Math.min(...instants)), timezone), last = localDate(new Date(Math.max(...instants)), timezone);
  const pad = Math.max(7, config.thresholds.maximumConsecutiveDays || 1);
  const from = addDays(first, -pad), to = addDays(last, pad);
  const fromInstant = new Date(localMidnight(from, timezone)).toISOString(), toInstant = new Date(localMidnight(addDays(to,1), timezone)).toISOString();
  const existing = await db.query(`SELECT id,user_id AS "userId",work_date::text AS "workDate",planned_start AS "plannedStart",planned_end AS "plannedEnd",
      kind,break_minutes AS "breakMinutes",break_intervals AS "breakIntervals" FROM staff_schedules WHERE venue_id=$1 AND user_id=ANY($2::uuid[]) AND status='planned'
      AND COALESCE(planned_start,work_date::timestamp AT TIME ZONE $5) < $4::timestamptz
      AND COALESCE(planned_end,(work_date+1)::timestamp AT TIME ZONE $5) > $3::timestamptz
      AND NOT(id=ANY($6::uuid[])) ORDER BY user_id,planned_start,work_date,id`, [venueId, employees, fromInstant, toInstant, timezone, excludedIds]);
  const byId = new Map();
  for (const row of existing.rows.map(row => ({ ...row, plannedStart: row.plannedStart && new Date(row.plannedStart).toISOString(), plannedEnd: row.plannedEnd && new Date(row.plannedEnd).toISOString() }))) byId.set(row.id,row);
  for (const row of contextRows || []) if(row.id) byId.set(row.id,row);
  for (const row of candidateRows) if(row.id) byId.set(row.id,row);
  const rows=[...byId.values()].filter(row=>row.userId&&row.kind==='shift'&&row.plannedStart&&row.plannedEnd);
  const candidateIds=new Set(candidateRows.map(row=>row.id).filter(Boolean));
  const warnings = [], pushed = new Set();
  const add = warning => { const key = hash(warning); if (!pushed.has(key) && warnings.length < 200) { pushed.add(key); warnings.push(warning); } };
  const byUser = new Map();
  for (const row of rows) { const list = byUser.get(row.userId) || []; list.push(row); byUser.set(row.userId, list); }
  for (const [userId, shifts] of byUser) {
    const intervals = shifts.map(row => ({ row, start: Date.parse(row.plannedStart), end: Date.parse(row.plannedEnd) })).filter(x => Number.isFinite(x.start) && x.end > x.start).sort((a,b) => a.start-b.start || a.end-b.end);
    if (config.thresholds.minimumRestMinutes !== null) for (let i=1;i<intervals.length;i++) {
      const gap=(intervals[i].start-intervals[i-1].end)/60000;
      if(gap>=0&&gap<config.thresholds.minimumRestMinutes&&candidateIds.has(intervals[i].row.id)) add({code:'schedule_minimum_rest',userId,workDate:intervals[i].row.workDate,scheduleId:intervals[i].row.id||null,previousScheduleId:intervals[i-1].row.id||null,actualMinutes:Math.floor(gap),thresholdMinutes:config.thresholds.minimumRestMinutes});
    }
    const minutesByWeek=new Map(), workedDates=new Set(), unknownBreakWeeks=new Map();
    for(const item of intervals){
      const {row,start,end}=item,first=localDate(new Date(start),timezone),last=localDate(new Date(end-1),timezone);
      const startWeek=monday(first),endWeek=monday(last),breakIntervals=Array.isArray(row.breakIntervals)?row.breakIntervals:[];
      const breakPlacementUnknown=Number(row.breakMinutes||0)>0&&!breakIntervals.length&&startWeek!==endWeek;
      for(let date=first;date<=last;date=addDays(date,1)){
        workedDates.add(date);
        const segStart=Math.max(start,localMidnight(date,timezone)),segEnd=Math.min(end,localMidnight(addDays(date,1),timezone));
        const week=monday(date), duration=Math.max(0,(segEnd-segStart)/60000);
        const exactBreak=breakIntervals.reduce((sum,interval)=>{
          const breakStart=Date.parse(interval.start),breakEnd=Date.parse(interval.end);
          return Number.isFinite(breakStart)&&Number.isFinite(breakEnd)&&breakEnd>breakStart
            ?sum+Math.max(0,Math.min(segEnd,breakEnd)-Math.max(segStart,breakStart))/60000:sum;
        },0);
        const unknownBreak=breakPlacementUnknown?0:(!breakIntervals.length&&date===first?Number(row.breakMinutes||0):0);
        const net=duration-exactBreak-unknownBreak;
        minutesByWeek.set(week,(minutesByWeek.get(week)||0)+Math.max(0,net));
        if(breakPlacementUnknown){const weeks=unknownBreakWeeks.get(row.id)||new Set();weeks.add(week);unknownBreakWeeks.set(row.id,weeks);}
      }
      if(breakPlacementUnknown)for(const weekStart of unknownBreakWeeks.get(row.id)||[])if(candidateIds.has(row.id))add({code:'schedule_weekly_break_unknown',userId,workDate:row.workDate,scheduleId:row.id||null,weekStart,unplacedBreakMinutes:Number(row.breakMinutes||0)});
      if(config.businessHoursEnabled&&candidateIds.has(row.id)){
        let covered=false;
        try{
          const windows=[];
          for(let date=addDays(first,-1);date<=last;date=addDays(date,1)) for(const rule of config.intervals.filter(x=>x.weekday===weekday(date))){
            const windowStart=Date.parse(instant(`${date}T${rule.startTime}`,timezone));
            const windowEnd=Date.parse(instant(`${addDays(date,rule.endDayOffset)}T${rule.endTime}`,timezone));
            if(windowEnd>windowStart)windows.push({start:windowStart,end:windowEnd});
          }
          let cursor=start; for(const window of windows.sort((a,b)=>a.start-b.start)){if(window.end<=cursor)continue;if(window.start>cursor)break;cursor=Math.max(cursor,window.end);if(cursor>=end){covered=true;break;}}
          if(!covered)add({code:'schedule_outside_business_hours',userId,workDate:row.workDate,scheduleId:row.id||null});
        }catch{add({code:'schedule_business_hours_unverifiable',userId,workDate:row.workDate,scheduleId:row.id||null});}
      }
    }
    if(config.thresholds.maxWeeklyMinutes!==null) for(const [weekStart,actualMinutes] of minutesByWeek) if(actualMinutes>config.thresholds.maxWeeklyMinutes) add({code:'schedule_max_weekly_minutes',userId,weekStart,actualMinutes:Math.floor(actualMinutes),thresholdMinutes:config.thresholds.maxWeeklyMinutes});
    if(config.thresholds.maximumConsecutiveDays!==null){
      const worked=[...workedDates].sort();let run=0,previous=null;
      for(const date of worked){run=previous&&addDays(previous,1)===date?run+1:1;previous=date;if(run>config.thresholds.maximumConsecutiveDays)add({code:'schedule_max_consecutive_days',userId,workDate:date,actualDays:run,thresholdDays:config.thresholds.maximumConsecutiveDays});}
    }
  }
  return { warnings, configurationVersion: policyFingerprint, policy: { version: config.version, configurationFingerprint: policyFingerprint, timezone } };
}

module.exports = { getVenuePolicy, saveVenuePolicy, read, evaluateVenuePolicy };
