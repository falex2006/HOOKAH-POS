'use strict';
const { createHash, randomUUID } = require('node:crypto');
const { ScheduleError, UUID, range, normalize, localDate } = require('./staff-schedule-domain');
const { resolveAccess } = require('./staff-schedule-access');
const { saveBatch } = require('./staff-schedule-service');
const fail = (code, status = 400) => { throw new ScheduleError(code, status); };
const hash = input => createHash('sha256').update(JSON.stringify(input)).digest('hex');
const dayAdd = (date, days) => new Date(Date.parse(date + 'T12:00Z') + days * 86400000).toISOString().slice(0, 10);
function wall(instant, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(instant));
  const get = name => parts.find(p => p.type === name).value;
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}
function instant(local, timezone) {
  const guess = Date.parse(local + 'Z'), offsets = new Set();
  for (const hours of [-36,-12,0,12,36]) { const sample = guess + hours * 3600000; offsets.add(Date.parse(wall(sample, timezone) + 'Z') - sample); }
  const candidates = [...offsets].map(offset => guess - offset).filter(value => wall(value, timezone) === local);
  if (candidates.length !== 1) fail('schedule_copy_time_ambiguous', 409);
  return new Date(candidates[0]).toISOString().replace('.000Z','Z');
}
function validate(input) {
  range(input?.sourceFrom, input?.sourceFrom); range(input?.targetFrom, input?.targetFrom);
  if (input.sourceFrom === input.targetFrom) fail('schedule_copy_same_week');
  if (!Array.isArray(input.userIds) || !input.userIds.length || input.userIds.length > 100 || input.userIds.some(id => !UUID.test(String(id)))) fail('schedule_copy_employees_required');
}
async function preview(db, principal, input) {
  validate(input);
  const access = await resolveAccess(db, principal);
  if (!access.manage) fail('schedule_forbidden', 403);
  const source = await db.query(`SELECT s.*,s.work_date::text AS work_date,u.full_name AS name,u.is_active,u.deleted_at
    FROM staff_schedules s JOIN users u ON u.id=s.user_id AND u.venue_id=s.venue_id
    WHERE s.venue_id=$1 AND s.user_id=ANY($2::uuid[]) AND s.status='planned'
      AND s.work_date BETWEEN $3::date AND $3::date+6 ORDER BY s.work_date,s.user_id,s.id`, [principal.venueId,input.userIds,input.sourceFrom]);
  if (source.rowCount > 200) fail('schedule_copy_limit');
  const shiftDays = Math.round((Date.parse(input.targetFrom) - Date.parse(input.sourceFrom)) / 86400000);
  const items = [];
  for (const row of source.rows) {
    let conflict = !row.is_active || row.deleted_at ? 'schedule_employee_unavailable' : null;
    let item = { userId: row.user_id, workDate: dayAdd(row.work_date, shiftDays), kind: row.kind, breakMinutes: row.break_minutes, note: row.note || '', plannedStart: null, plannedEnd: null };
    try {
      if (row.kind === 'shift') {
        if (!row.planned_start || !row.planned_end) fail('schedule_plan_incomplete',409);
        const move = value => { const valueLocal = wall(value, access.timezone); return instant(dayAdd(valueLocal.slice(0,10),shiftDays) + valueLocal.slice(10), access.timezone); };
        item.plannedStart = move(row.planned_start); item.plannedEnd = move(row.planned_end);
      }
      item = normalize(item, access.timezone);
      const overlap = await db.query(`SELECT id FROM staff_schedules WHERE venue_id=$1 AND user_id=$2 AND status='planned'
        AND COALESCE(planned_start,work_date::timestamp AT TIME ZONE $6) < COALESCE($4::timestamptz,($5::date+1)::timestamp AT TIME ZONE $6)
        AND COALESCE(planned_end,(work_date+1)::timestamp AT TIME ZONE $6) > COALESCE($3::timestamptz,$5::date::timestamp AT TIME ZONE $6) LIMIT 1`,
      [principal.venueId,item.userId,item.plannedStart,item.plannedEnd,item.workDate,access.timezone]);
      if (overlap.rowCount) conflict = 'schedule_overlap';
    } catch (error) { if (!(error instanceof ScheduleError)) throw error; conflict = error.code; }
    items.push({ sourceId: row.id, sourceVersion: row.version, employeeName: row.name, ...item, conflict });
  }
  const fingerprint = hash({ sourceFrom: input.sourceFrom, targetFrom: input.targetFrom, timezone: access.timezone,
    items: items.map(({ conflict, ...item }) => item) });
  return { sourceFrom: input.sourceFrom, targetFrom: input.targetFrom, timezone: access.timezone,
    today: localDate(new Date(), access.timezone), fingerprint, items };
}
async function apply(pool, principal, input) {
  validate(input);
  if (!UUID.test(String(input.requestKey || '')) || !Array.isArray(input.sourceIds) || !input.sourceIds.length || new Set(input.sourceIds).size !== input.sourceIds.length) fail('schedule_copy_selection_required');
  const fingerprint = hash({ copy: input });
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`schedule:${principal.venueId}`]);
    if (!(await resolveAccess(db, principal, true)).manage) fail('schedule_forbidden', 403);
    const replay = (await db.query('SELECT fingerprint,response FROM staff_schedule_requests WHERE venue_id=$1 AND actor_id=$2 AND request_key=$3', [principal.venueId,principal.userId,input.requestKey])).rows[0];
    if (replay) { if (replay.fingerprint !== fingerprint) fail('schedule_request_conflict',409); await db.query('COMMIT'); return replay.response; }
    const current = await preview(db, principal, input);
    if (current.fingerprint !== input.fingerprint) fail('schedule_copy_source_changed',409);
    const selected = input.sourceIds.map(id => current.items.find(item => item.sourceId === id));
    if (selected.some(item => !item)) fail('schedule_copy_selection_invalid');
    if (selected.some(item => item.conflict)) fail('schedule_copy_conflict',409);
    const reason = input.reason === undefined ? '' : input.reason;
    if (typeof reason !== 'string' || reason.length > 500) fail('schedule_reason_invalid');
    if (selected.some(item => item.workDate < current.today) && !reason.trim()) fail('schedule_past_reason_required');
    const result = await saveBatch(pool, principal, { requestKey: randomUUID(), items: selected.map(item => ({ userId:item.userId, workDate:item.workDate, kind:item.kind, plannedStart:item.plannedStart, plannedEnd:item.plannedEnd, breakMinutes:item.breakMinutes, note:item.note, reason, requestKey:randomUUID() })) }, db);
    await db.query('INSERT INTO staff_schedule_requests(venue_id,actor_id,request_key,fingerprint,response) VALUES($1,$2,$3,$4,$5::jsonb)', [principal.venueId,principal.userId,input.requestKey,fingerprint,JSON.stringify(result)]);
    await db.query('COMMIT'); return result;
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}
module.exports = { preview, apply, wall, instant };
