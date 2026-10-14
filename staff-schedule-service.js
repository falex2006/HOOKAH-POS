'use strict';
const { createHash } = require('node:crypto');
const { ScheduleError, normalize, range, version, localDate, UUID } = require('./staff-schedule-domain');
const { resolveAccess } = require('./staff-schedule-access');
const fail = (code, status = 400) => { throw new ScheduleError(code, status); };
const dto = row => ({ id: row.id, venue_id: row.venue_id, created_by: row.created_by, created_at: row.created_at, userId: row.user_id, user_id: row.user_id,
  workDate: String(row.work_date).slice(0, 10), work_date: String(row.work_date).slice(0, 10),
  plannedStart: row.planned_start, plannedEnd: row.planned_end,
  planned_start: row.planned_start, planned_end: row.planned_end,
  breakMinutes: row.break_minutes, kind: row.kind, status: row.status, version: row.version,
  note: row.note ?? null, cancelReason: row.cancel_reason || '', userName: row.userName || null });
async function get(pool, principal, id) {
  if (!UUID.test(String(id))) fail('schedule_id_invalid');
  if (!(await resolveAccess(pool,principal)).view) fail('schedule_forbidden',403);
  const result = await pool.query('SELECT *,work_date::text AS work_date FROM staff_schedules WHERE id=$1 AND venue_id=$2',[id,principal.venueId]);
  if (!result.rowCount) fail('schedule_not_found',404);
  return dto(result.rows[0]);
}
async function list(pool, principal, from, to) {
  const access = await resolveAccess(pool, principal);
  if (!access.view) fail('schedule_forbidden', 403);
  from ||= localDate(new Date(),access.timezone); to ||= from;
  range(from, to);
  const result = await pool.query(`SELECT s.*,s.work_date::text AS work_date,u.full_name AS "userName"
    FROM staff_schedules s JOIN users u ON u.id=s.user_id AND u.venue_id=s.venue_id
    WHERE s.venue_id=$1 AND (s.work_date BETWEEN $2::date AND $3::date
      OR (s.status='planned' AND s.kind='shift'
        AND s.planned_start < (($3::date+1)::timestamp AT TIME ZONE $4)
        AND s.planned_end > ($2::date::timestamp AT TIME ZONE $4)))
    ORDER BY s.work_date,s.planned_start,s.id`, [principal.venueId, from, to, access.timezone]);
  const logs = await pool.query(`SELECT user_id,started_at,ended_at FROM staff_work_logs
    WHERE venue_id=$1 AND (started_at AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date
    ORDER BY user_id,started_at,ended_at`, [principal.venueId,from,to,access.timezone]);
  const all = result.rows.map(dto);
  // Carry-in records are display-only: preserve the established start-date totals and API items contract.
  return { items: all.filter(item => item.workDate >= from && item.workDate <= to),
    continuations: all.filter(item => item.workDate < from),
    actual: actualTotals(logs.rows), timezone: access.timezone, access };
}
function actualTotals(logs) {
  const groups = new Map();
  for (const log of logs) {
    if (!groups.has(log.user_id)) groups.set(log.user_id, { userId:log.user_id, intervals:[], openIntervals:0, invalidIntervals:0 });
    const group = groups.get(log.user_id);
    if (!log.ended_at) { group.openIntervals++; continue; }
    const start=Date.parse(log.started_at), end=Date.parse(log.ended_at);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end<=start) { group.invalidIntervals++; continue; }
    group.intervals.push([start,end]);
  }
  return [...groups.values()].map(group => {
    const merged=[];
    for (const interval of group.intervals.sort((a,b)=>a[0]-b[0])) {
      const last=merged[merged.length-1];
      if (last && interval[0]<=last[1]) last[1]=Math.max(last[1],interval[1]); else merged.push([...interval]);
    }
    return {userId:group.userId,minutes:merged.reduce((sum,[start,end])=>sum+(end-start)/60000,0),openIntervals:group.openIntervals,invalidIntervals:group.invalidIntervals};
  });
}
async function save(pool, principal, input, id = null, transaction = null) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !UUID.test(String(input.requestKey || ''))) fail('schedule_request_key_required');
  if (id && !UUID.test(id)) fail('schedule_id_invalid');
  if (!id && input.version !== undefined) fail('schedule_create_version_forbidden');
  const fingerprint = createHash('sha256').update(JSON.stringify({ id, input })).digest('hex');
  const db = transaction || await pool.connect();
  try {
    if (!transaction) await db.query('BEGIN');
    // A single venue mutation lock prevents overlap races, including reassignment and batch operations.
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`schedule:${principal.venueId}`]);
    // Hold actor row through commit. Grant revocation locks this row, giving a defined order.
    const access = await resolveAccess(db, principal, true);
    if (!access.manage) fail('schedule_forbidden', 403);
    const replay = (await db.query('SELECT fingerprint,response FROM staff_schedule_requests WHERE venue_id=$1 AND actor_id=$2 AND request_key=$3', [principal.venueId, principal.userId, input.requestKey])).rows[0];
    if (replay) {
      if (replay.fingerprint !== fingerprint) fail('schedule_request_conflict', 409);
      if (!transaction) await db.query('COMMIT'); return replay.response;
    }
    const before = id ? (await db.query('SELECT *,work_date::text AS work_date FROM staff_schedules WHERE id=$1 AND venue_id=$2 FOR UPDATE', [id, principal.venueId])).rows[0] : null;
    if (id && !before) fail('schedule_not_found', 404);
    if (before && version(input.version) !== before.version) fail('schedule_version_conflict', 409);
    if (before?.status === 'cancelled') fail('schedule_already_cancelled', 409);
    const reason = input.reason === undefined ? '' : input.reason;
    if (typeof reason !== 'string' || reason.length > 500) fail('schedule_reason_invalid');
    const cancel = input.status === 'cancelled';
    if (input.status !== undefined && !['planned', 'cancelled'].includes(input.status)) fail('schedule_status_invalid');
    if (cancel && (!before || !reason.trim())) fail('schedule_cancel_reason_required');
    const entry = cancel ? dto(before) : normalize(input, access.timezone);
    const today = localDate(new Date(), access.timezone);
    if ((entry.workDate < today || (before && before.work_date < today)) && !reason.trim()) fail('schedule_past_reason_required');
    const employee = await db.query('SELECT id,is_active,deleted_at FROM users WHERE id=$1 AND venue_id=$2 FOR SHARE', [entry.userId, principal.venueId]);
    if (!employee.rows[0] || (!cancel && (!employee.rows[0].is_active || employee.rows[0].deleted_at))) fail('schedule_employee_unavailable', 409);
    if (!cancel) {
      const conflicts = await db.query(`SELECT id FROM staff_schedules WHERE venue_id=$1 AND user_id=$2
        AND status='planned' AND ($3::uuid IS NULL OR id<>$3)
        AND COALESCE(planned_start,work_date::timestamp AT TIME ZONE $7) < COALESCE($5::timestamptz,($6::date+1)::timestamp AT TIME ZONE $7)
        AND COALESCE(planned_end,(work_date+1)::timestamp AT TIME ZONE $7) > COALESCE($4::timestamptz,$6::date::timestamp AT TIME ZONE $7)
        LIMIT 1`, [principal.venueId, entry.userId, id, entry.plannedStart, entry.plannedEnd, entry.workDate, access.timezone]);
      if (conflicts.rowCount) fail('schedule_overlap', 409);
    }
    const values = [principal.venueId, entry.userId, entry.workDate, entry.plannedStart, entry.plannedEnd, entry.note,
      entry.kind, entry.breakMinutes, principal.userId, cancel ? 'cancelled' : 'planned', cancel ? reason.trim() : null];
    const result = before ? await db.query(`UPDATE staff_schedules SET user_id=$2,work_date=$3,planned_start=$4,planned_end=$5,
      note=$6,kind=$7,break_minutes=$8,updated_by=$9,status=$10,cancel_reason=$11,version=version+1,updated_at=now()
      WHERE venue_id=$1 AND id=$12 RETURNING *,work_date::text AS work_date`, [...values, id])
      : await db.query(`INSERT INTO staff_schedules(venue_id,user_id,work_date,planned_start,planned_end,note,kind,break_minutes,created_by,status,cancel_reason,updated_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$9) RETURNING *,work_date::text AS work_date`, values);
    const after = result.rows[0];
    await db.query(`INSERT INTO staff_schedule_events(venue_id,schedule_id,actor_id,before_data,after_data,reason)
      VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6)`, [principal.venueId, after.id, principal.userId, before ? JSON.stringify(before) : null, JSON.stringify(after), reason.trim()]);
    const response = dto(after);
    await db.query('INSERT INTO staff_schedule_requests(venue_id,actor_id,request_key,fingerprint,response) VALUES($1,$2,$3,$4,$5::jsonb)', [principal.venueId, principal.userId, input.requestKey, fingerprint, JSON.stringify(response)]);
    if (!transaction) await db.query('COMMIT'); return response;
  } catch (error) { if (!transaction) await db.query('ROLLBACK'); throw error; }
  finally { if (!transaction) db.release(); }
}
async function saveBatch(pool, principal, input, transaction = null) {
  if (!UUID.test(String(input?.requestKey || '')) || !Array.isArray(input.items) || !input.items.length || input.items.length > 200) fail('schedule_batch_invalid');
  if (input.items.some(item => !item || !UUID.test(String(item.requestKey || '')) || item.requestKey === input.requestKey)
      || new Set(input.items.map(item => item.requestKey)).size !== input.items.length) fail('schedule_batch_keys_invalid');
  const fingerprint = createHash('sha256').update(JSON.stringify({ batch: input })).digest('hex');
  const db = transaction || await pool.connect();
  try {
    if (!transaction) await db.query('BEGIN');
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`schedule:${principal.venueId}`]);
    if (!(await resolveAccess(db, principal, true)).manage) fail('schedule_forbidden', 403);
    const replay = (await db.query('SELECT fingerprint,response FROM staff_schedule_requests WHERE venue_id=$1 AND actor_id=$2 AND request_key=$3', [principal.venueId, principal.userId, input.requestKey])).rows[0];
    if (replay) {
      if (replay.fingerprint !== fingerprint) fail('schedule_request_conflict', 409);
      if (!transaction) await db.query('COMMIT'); return replay.response;
    }
    const items = [];
    for (const item of input.items) items.push(await save(pool, principal, item, null, db));
    const response = { items };
    await db.query('INSERT INTO staff_schedule_requests(venue_id,actor_id,request_key,fingerprint,response) VALUES($1,$2,$3,$4,$5::jsonb)', [principal.venueId, principal.userId, input.requestKey, fingerprint, JSON.stringify(response)]);
    if (!transaction) await db.query('COMMIT'); return response;
  } catch (error) { if (!transaction) await db.query('ROLLBACK'); throw error; }
  finally { if (!transaction) db.release(); }
}
module.exports = { list, get, save, saveBatch, actualTotals };
