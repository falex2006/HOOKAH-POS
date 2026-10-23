'use strict';
const { beginPayrollSourceProducerTransaction } = require('./payroll-source-fence');

// Stage 04: one personal shift default per (venue, employee, work function).
// Routes deliberately live elsewhere; see the exported functions below.
const { createHash } = require('node:crypto');
const { ScheduleError, UUID } = require('./staff-schedule-domain');
const { resolveAccess } = require('./staff-schedule-access');

const fail = (code, status = 400) => { throw new ScheduleError(code, status); };
const uuid = (value, code) => {
  if (typeof value !== 'string' || !UUID.test(value)) fail(code);
  return value.toLowerCase();
};
const nullableUuid = (value, code) => value == null ? null : uuid(value, code);
const clock = value => {
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) fail('schedule_default_time_invalid');
  return value;
};
const minutes = time => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
const rowSql = `id,user_id AS "userId",function_id AS "functionId",template_id AS "templateId",
  to_char(start_time,'HH24:MI') AS "startTime",to_char(end_time,'HH24:MI') AS "endTime",
  end_day_offset AS "endDayOffset",break_minutes AS "breakMinutes",version`;
const stable = value => Array.isArray(value) ? value.map(stable)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])])) : value;
const fingerprint = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');

function inputDefault(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(k => !['functionId', 'templateId', 'startTime', 'endTime', 'endDayOffset', 'breakMinutes', 'version', 'requestKey'].includes(k))) {
    fail('schedule_default_input_invalid');
  }
  if (!Number.isSafeInteger(input.version) || input.version < 0) fail('schedule_default_version_invalid');
  const requestKey = uuid(input.requestKey, 'schedule_request_key_required');
  const functionId = nullableUuid(input.functionId, 'schedule_function_id_invalid');
  const templateId = nullableUuid(input.templateId, 'schedule_template_id_invalid');
  const hasStart = input.startTime != null, hasEnd = input.endTime != null;
  if (hasStart !== hasEnd || (!hasStart && !templateId)) fail('schedule_default_time_invalid');
  const startTime = hasStart ? clock(input.startTime) : null;
  const endTime = hasEnd ? clock(input.endTime) : null;
  const endDayOffset = input.endDayOffset === undefined ? 0 : input.endDayOffset;
  const breakMinutes = input.breakMinutes === undefined ? 0 : input.breakMinutes;
  if (![0, 1].includes(endDayOffset) || !Number.isSafeInteger(breakMinutes) || breakMinutes < 0) fail('schedule_default_time_invalid');
  if (hasStart) {
    const duration = minutes(endTime) + endDayOffset * 1440 - minutes(startTime);
    if (duration <= 0 || duration > 1440 || breakMinutes >= duration) fail('schedule_default_time_invalid');
  } else if (endDayOffset !== 0 || breakMinutes !== 0) {
    // A template-only default inherits its entire interval and break.
    fail('schedule_default_time_invalid');
  }
  return { functionId, templateId, startTime, endTime, endDayOffset, breakMinutes,
    version: input.version, requestKey };
}

async function ensureEmployee(db, principal, employeeId, lock = false) {
  const result = await db.query(`SELECT id FROM users WHERE venue_id=$1 AND id=$2 AND is_active
    AND deleted_at IS NULL ${lock ? 'FOR UPDATE' : ''}`, [principal.venueId, employeeId]);
  if (!result.rowCount) fail('schedule_employee_not_found', 404);
}

async function ensureFunction(db, principal, employeeId, functionId) {
  if (!functionId) return;
  const found = await db.query(`SELECT f.id FROM staff_schedule_functions f
    JOIN staff_schedule_employee_functions ef ON ef.venue_id=f.venue_id AND ef.function_id=f.id
    WHERE f.venue_id=$1 AND f.id=$2 AND f.active AND ef.user_id=$3 AND ef.active`,
  [principal.venueId, functionId, employeeId]);
  if (!found.rowCount) fail('schedule_default_function_unavailable', 409);
}

async function ensureTemplate(db, principal, employeeId, templateId, functionId) {
  if (!templateId) return;
  const result = await db.query(`SELECT definition FROM staff_schedule_templates
    WHERE venue_id=$1 AND id=$2 AND NOT archived`, [principal.venueId, templateId]);
  if (!result.rowCount) fail('schedule_template_not_found', 404);
  const definition = result.rows[0].definition;
  const member = definition?.schemaVersion === 2 && definition.mode === 'team'
    ? definition.members?.find(item => item.userId === employeeId) : null;
  if (definition?.mode === 'team' && !member) fail('schedule_default_template_incompatible', 409);
  const slots = member ? member.slots : definition?.slots;
  if (!Array.isArray(slots) || slots.length !== 1 || slots[0]?.kind !== 'shift') {
    fail('schedule_default_template_incompatible', 409);
  }
  const slot = slots[0];
  // Older JSON definitions are not constrained by a SQL shape check.
  let duration;
  try {
    duration = minutes(clock(slot.endTime)) + slot.endDayOffset * 1440 - minutes(clock(slot.startTime));
  } catch { fail('schedule_default_template_incompatible', 409); }
  if (![0, 1].includes(slot.endDayOffset) || duration <= 0 || duration > 1440
      || !Number.isSafeInteger(slot.breakMinutes) || slot.breakMinutes < 0 || slot.breakMinutes >= duration) {
    fail('schedule_default_template_incompatible', 409);
  }
  let slotFunction = slot.functionId || member?.functionId || null;
  if (slotFunction && (typeof slotFunction !== 'string' || !UUID.test(slotFunction))) {
    fail('schedule_default_template_incompatible', 409);
  }
  if (slotFunction) slotFunction = slotFunction.toLowerCase();
  if (functionId && slotFunction && functionId !== slotFunction) fail('schedule_default_template_incompatible', 409);
  if (slotFunction) await ensureFunction(db, principal, employeeId, slotFunction);
}

async function listEmployeeDefaults(db, principal, employeeId) {
  const employee = uuid(employeeId, 'schedule_employee_invalid');
  const access = await resolveAccess(db, principal);
  if (!access.view) fail('schedule_forbidden', 403);
  await ensureEmployee(db, principal, employee);
  const result = await db.query(`SELECT ${rowSql} FROM staff_schedule_employee_defaults
    WHERE venue_id=$1 AND user_id=$2 ORDER BY function_id NULLS FIRST,id`, [principal.venueId, employee]);
  return { userId: employee, items: result.rows };
}

async function putEmployeeDefault(pool, principal, employeeId, input) {
  const employee = uuid(employeeId, 'schedule_employee_invalid');
  const next = inputDefault(input);
  const signature = fingerprint({ operation: 'putEmployeeDefault', employeeId: employee, ...next });
  const db = await pool.connect();
  try {
    await beginPayrollSourceProducerTransaction(db, principal.venueId);
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`schedule:${principal.venueId}`]);
    const access = await resolveAccess(db, principal, true);
    if (!access.canManageSettings) fail('schedule_settings_forbidden', 403);
    const replay = (await db.query(`SELECT fingerprint,response FROM staff_schedule_requests
      WHERE venue_id=$1 AND actor_id=$2 AND request_key=$3`,
    [principal.venueId, principal.userId, next.requestKey])).rows[0];
    if (replay) {
      if (replay.fingerprint !== signature) fail('schedule_request_conflict', 409);
      await db.query('COMMIT');
      return replay.response;
    }
    await ensureEmployee(db, principal, employee, true);
    const before = (await db.query(`SELECT ${rowSql} FROM staff_schedule_employee_defaults
      WHERE venue_id=$1 AND user_id=$2 AND function_id IS NOT DISTINCT FROM $3::uuid FOR UPDATE`,
    [principal.venueId, employee, next.functionId])).rows[0] || null;
    if ((before?.version || 0) !== next.version) fail('schedule_default_version_conflict', 409);
    await ensureFunction(db, principal, employee, next.functionId);
    await ensureTemplate(db, principal, employee, next.templateId, next.functionId);
    const after = before ? (await db.query(`UPDATE staff_schedule_employee_defaults
      SET template_id=$4,start_time=$5::time,end_time=$6::time,end_day_offset=$7,
        break_minutes=$8,version=version+1,updated_at=now()
      WHERE venue_id=$1 AND user_id=$2 AND id=$3 RETURNING ${rowSql}`,
    [principal.venueId, employee, before.id, next.templateId, next.startTime, next.endTime,
      next.endDayOffset, next.breakMinutes])).rows[0]
      : (await db.query(`INSERT INTO staff_schedule_employee_defaults
        (venue_id,user_id,function_id,template_id,start_time,end_time,end_day_offset,break_minutes,created_by)
        VALUES($1,$2,$3,$4,$5::time,$6::time,$7,$8,$9) RETURNING ${rowSql}`,
      [principal.venueId, employee, next.functionId, next.templateId, next.startTime,
        next.endTime, next.endDayOffset, next.breakMinutes, principal.userId])).rows[0];
    await db.query(`INSERT INTO staff_schedule_config_events
      (venue_id,actor_id,entity_type,entity_id,action,before_data,after_data)
      VALUES($1,$2,'employee_default',$3,$4,$5::jsonb,$6::jsonb)`,
    [principal.venueId, principal.userId, after.id, before ? 'update' : 'create',
      before ? JSON.stringify(before) : null, JSON.stringify(after)]);
    await db.query(`INSERT INTO staff_schedule_requests(venue_id,actor_id,request_key,fingerprint,response)
      VALUES($1,$2,$3,$4,$5::jsonb)`,
    [principal.venueId, principal.userId, next.requestKey, signature, JSON.stringify(after)]);
    await db.query('COMMIT');
    return after;
  } catch (error) {
    await db.query('ROLLBACK');
    if (error.code === '23505') fail('schedule_default_conflict', 409);
    throw error;
  } finally { db.release(); }
}

module.exports = { listEmployeeDefaults, putEmployeeDefault };
