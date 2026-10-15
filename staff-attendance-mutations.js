'use strict';
const { createHash } = require('node:crypto');
const { UUID } = require('./staff-schedule-domain');
const { AttendanceError, policy, reason } = require('./staff-attendance-domain');
const { resolveAttendanceAccess } = require('./staff-attendance-access');
const { readPolicy, admission } = require('./staff-attendance-service');
const fail = (code, status = 400) => { throw new AttendanceError(code, status); };
const uuid = value => { if (typeof value !== 'string' || !UUID.test(value)) fail('attendance_id_invalid'); return value.toLowerCase(); };
const version = value => { if (!Number.isSafeInteger(value) || value < 0) fail('attendance_version_invalid'); return value; };
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const sessionColumns = 'id,user_id AS "userId",started_at AS "startedAt",ended_at AS "endedAt",ended_by AS "endedBy",end_reason AS "endReason",version';
const requestColumns = 'id,user_id AS "userId",reason,status,window_start AS "windowStart",window_end AS "windowEnd",version,consumed_at AS "consumedAt"';

async function mutate(pool, principal, action, input, capability, operation) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('attendance_input_invalid');
  const key = uuid(input.requestKey);
  const fingerprint = createHash('sha256').update(JSON.stringify(stable({ action, input }))).digest('hex');
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    // All attendance writers use this order, including grant and policy changes.
    await db.query("SELECT pg_advisory_xact_lock(hashtext('staff_attendance'),hashtext($1::text))", [principal.venueId]);
    // Scheduler batch publication locks rows in operation order. Share its
    // venue serialization before any user/entity locks to avoid crossed rows.
    if (action === 'start') await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`schedule:${principal.venueId}`]);
    await db.query('SELECT id FROM users WHERE id=$1 FOR SHARE', [principal.userId]);
    await db.query('SELECT id FROM venues WHERE id=$1 FOR SHARE', [principal.venueId]);
    const access = await resolveAttendanceAccess(db, principal);
    if (!access[capability]) fail('attendance_forbidden', 403);
    const prior = (await db.query('SELECT request_fingerprint,response_data FROM staff_attendance_events WHERE venue_id=$1 AND actor_id=$2 AND request_key=$3', [principal.venueId, principal.userId, key])).rows[0];
    if (prior) {
      if (prior.request_fingerprint !== fingerprint) fail('attendance_idempotency_conflict', 409);
      await db.query('COMMIT'); return prior.response_data;
    }
    const result = await operation(db, access, key);
    const response = result.response;
    await db.query(`INSERT INTO staff_attendance_events(venue_id,actor_id,action,entity_type,entity_id,before_json,after_json,request_key,request_fingerprint,response_data)
      VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10::jsonb)`,
    [principal.venueId, principal.userId, action, result.type, result.id, result.before == null ? null : JSON.stringify(result.before), JSON.stringify(response), key, fingerprint, JSON.stringify(response)]);
    await db.query('COMMIT'); return response;
  } catch (error) { await db.query('ROLLBACK').catch(() => {}); throw error; }
  finally { db.release(); }
}

function start(pool, principal, input) {
  return mutate(pool, principal, 'start', input, 'self', async (db, access, key) => {
    if ((await db.query('SELECT id FROM staff_attendance_sessions WHERE user_id=$1 AND ended_at IS NULL', [principal.userId])).rows.length) fail('attendance_already_started', 409);
    const settings = await readPolicy(db, principal.venueId);
    const { now, decision } = await admission(db, principal, settings, true);
    let basis = decision.basis;
    let note = null;
    let approvalId = null;
    if (input.approvalId) {
      approvalId = uuid(input.approvalId);
      const approval = (await db.query(`UPDATE staff_attendance_requests SET consumed_at=$4,version=version+1
        WHERE id=$1 AND venue_id=$2 AND user_id=$3 AND status='approved' AND consumed_at IS NULL
          AND window_start <= $4::timestamptz AND window_end > $4::timestamptz RETURNING id`,
      [approvalId, principal.venueId, principal.userId, now])).rows[0];
      if (!approval) fail('attendance_approval_invalid', 409);
      basis = 'approved_exception';
    } else if (decision.decision === 'approval_required') fail('attendance_approval_required', 409);
    else if (decision.decision === 'reason_required') note = reason(input.reason);
    const snapshot = { ...decision, reason: note, approvalId };
    const response = (await db.query(`INSERT INTO staff_attendance_sessions(venue_id,user_id,started_at,basis,schedule_id,policy_snapshot,schedule_snapshot,timezone,start_request_key)
      VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9) RETURNING ${sessionColumns}`,
    [principal.venueId, principal.userId, now, basis, decision.scheduleId, JSON.stringify(settings), JSON.stringify(snapshot), access.timezone, key])).rows[0];
    return { type: 'session', id: response.id, response };
  });
}
function end(pool, principal, input) {
  const id = uuid(input.id); version(input.version);
  return mutate(pool, principal, 'end', input, 'self', async db => {
    const response = (await db.query(`UPDATE staff_attendance_sessions SET ended_at=clock_timestamp(),version=version+1
      WHERE id=$1 AND venue_id=$2 AND user_id=$3 AND version=$4 AND ended_at IS NULL RETURNING ${sessionColumns}`,
    [id, principal.venueId, principal.userId, input.version])).rows[0];
    if (!response) fail('attendance_session_conflict', 409);
    return { type: 'session', id, response };
  });
}
function closeSession(pool, principal, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !['id','requestKey','version','reason'].includes(key))) fail('attendance_input_invalid');
  const id = uuid(input.id); version(input.version);
  const note = reason(input.reason);
  return mutate(pool, principal, 'manager_end', input, 'closeSessions', async db => {
    const before = (await db.query(`SELECT ${sessionColumns} FROM staff_attendance_sessions
      WHERE id=$1 AND venue_id=$2 FOR UPDATE`, [id, principal.venueId])).rows[0];
    if (!before) fail('attendance_session_conflict', 409);
    if (before.userId === principal.userId) fail('attendance_own_session_use_end', 403);
    if (before.endedAt || before.version !== input.version) fail('attendance_session_conflict', 409);
    // Read the server clock in this UPDATE, after locks. No caller timestamp or
    // policy/schedule admission participates in closing forgotten attendance.
    const response = (await db.query(`UPDATE staff_attendance_sessions
      SET ended_at=clock_timestamp(),ended_by=$4,end_reason=$5,version=version+1
      WHERE id=$1 AND venue_id=$2 AND version=$3 AND ended_at IS NULL RETURNING ${sessionColumns}`,
    [id, principal.venueId, input.version, principal.userId, note])).rows[0];
    if (!response) fail('attendance_session_conflict', 409);
    return { type: 'session', id, before, response };
  });
}
function savePolicy(pool, principal, input) {
  const next = policy({ mode: input.mode, preparationMinutes: input.preparationMinutes }); version(input.version);
  return mutate(pool, principal, 'policy', input, 'managePolicy', async db => {
    const before = await readPolicy(db, principal.venueId);
    if (before.version !== input.version) fail('attendance_policy_conflict', 409);
    await db.query(`INSERT INTO staff_attendance_policies(venue_id,mode,preparation_minutes,version,updated_by) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(venue_id) DO UPDATE SET mode=EXCLUDED.mode,preparation_minutes=EXCLUDED.preparation_minutes,
        version=EXCLUDED.version,updated_by=EXCLUDED.updated_by,updated_at=clock_timestamp()`,
    [principal.venueId, next.mode, next.preparationMinutes, input.version + 1, principal.userId]);
    return { type: 'policy', id: principal.venueId, before, response: { ...next, version: input.version + 1 } };
  });
}
function saveGrant(pool, principal, input) {
  const userId = uuid(input.userId); version(input.version);
  if (typeof input.managePolicy !== 'boolean' || typeof input.approve !== 'boolean') fail('attendance_grant_invalid');
  if (input.closeSessions !== undefined && typeof input.closeSessions !== 'boolean') fail('attendance_grant_invalid');
  return mutate(pool, principal, 'grant', input, 'grant', async db => {
    const employee = (await db.query(`SELECT role FROM users WHERE id=$1 AND venue_id=$2 AND is_active AND deleted_at IS NULL FOR SHARE`, [userId, principal.venueId])).rows[0];
    if (!employee || !['admin', 'manager'].includes(employee.role)) fail('attendance_grant_employee_invalid');
    const before = (await db.query('SELECT version,can_manage_policy AS "managePolicy",can_approve AS approve,can_close_sessions AS "closeSessions" FROM staff_attendance_grants WHERE venue_id=$1 AND user_id=$2', [principal.venueId, userId])).rows[0];
    if ((before?.version || 0) !== input.version) fail('attendance_grant_conflict', 409);
    const closeSessions = input.closeSessions ?? before?.closeSessions ?? false;
    await db.query(`INSERT INTO staff_attendance_grants(venue_id,user_id,can_manage_policy,can_approve,version,updated_by,can_close_sessions)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(venue_id,user_id) DO UPDATE SET can_manage_policy=EXCLUDED.can_manage_policy,
        can_approve=EXCLUDED.can_approve,can_close_sessions=EXCLUDED.can_close_sessions,version=EXCLUDED.version,updated_by=EXCLUDED.updated_by,updated_at=clock_timestamp()`,
    [principal.venueId, userId, input.managePolicy, input.approve, input.version + 1, principal.userId, closeSessions]);
    return { type: 'grant', id: userId, before, response: { userId, managePolicy: input.managePolicy, approve: input.approve, closeSessions, version: input.version + 1 } };
  });
}
function requestException(pool, principal, input) {
  const note = reason(input.reason);
  return mutate(pool, principal, 'request', input, 'self', async (db, access, key) => {
    const pending = await db.query(`SELECT id FROM staff_attendance_requests WHERE venue_id=$1 AND user_id=$2 AND status='pending' AND window_end>clock_timestamp()`, [principal.venueId, principal.userId]);
    if (pending.rows.length) fail('attendance_request_pending', 409);
    const response = (await db.query(`INSERT INTO staff_attendance_requests(venue_id,user_id,reason,window_start,window_end,request_key)
      VALUES($1,$2,$3,statement_timestamp(),statement_timestamp()+interval '2 hours',$4) RETURNING ${requestColumns}`,
    [principal.venueId, principal.userId, note, key])).rows[0];
    return { type: 'request', id: response.id, response };
  });
}
function decide(pool, principal, input) {
  const id = uuid(input.id); version(input.version);
  if (!['approved', 'rejected'].includes(input.decision)) fail('attendance_decision_invalid');
  const note = input.note == null || input.note === '' ? null : reason(input.note);
  return mutate(pool, principal, 'decide', input, 'approve', async db => {
    // Decisions never start work for the employee: they grant a single bounded admission.
    const response = (await db.query(`UPDATE staff_attendance_requests SET status=$4,decided_by=$5,decided_at=clock_timestamp(),decision_note=$6,version=version+1
      WHERE id=$1 AND venue_id=$2 AND version=$3 AND status='pending' AND window_end>clock_timestamp()
        AND user_id<>$5 RETURNING ${requestColumns}`, [id, principal.venueId, input.version, input.decision, principal.userId, note])).rows[0];
    if (!response) fail('attendance_request_conflict', 409);
    return { type: 'request', id, response };
  });
}
function cancel(pool, principal, input) {
  const id = uuid(input.id); version(input.version);
  return mutate(pool, principal, 'cancel', input, 'self', async db => {
    const response = (await db.query(`UPDATE staff_attendance_requests SET status='cancelled',version=version+1
      WHERE id=$1 AND venue_id=$2 AND user_id=$3 AND version=$4 AND status IN ('pending','approved') AND consumed_at IS NULL RETURNING ${requestColumns}`,
    [id, principal.venueId, principal.userId, input.version])).rows[0];
    if (!response) fail('attendance_request_conflict', 409);
    return { type: 'request', id, response };
  });
}
module.exports = { start, end, closeSession, savePolicy, saveGrant, requestException, decide, cancel };
