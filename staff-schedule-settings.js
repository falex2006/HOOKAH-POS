'use strict';
const { beginPayrollSourceProducerTransaction } = require('./payroll-source-fence');

const { createHash } = require('node:crypto');
const { ScheduleError, UUID, version } = require('./staff-schedule-domain');
const { resolveAccess } = require('./staff-schedule-access');

const fail = (code, status = 400) => { throw new ScheduleError(code, status); };
const stable = value => Array.isArray(value) ? value.map(stable)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const fingerprint = input => createHash('sha256').update(JSON.stringify(stable(input))).digest('hex');
const id = value => {
  if (typeof value !== 'string' || !UUID.test(value)) fail('schedule_function_id_invalid');
  return value.toLowerCase();
};
const functionName = value => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80) fail('schedule_function_name_invalid');
  return value.trim();
};
const requestKey = value => {
  if (typeof value !== 'string' || !UUID.test(value)) fail('schedule_request_key_required');
  return value.toLowerCase();
};
const configEvent = async (db, principal, type, entityId, action, before, after) => db.query(
  `INSERT INTO staff_schedule_config_events(venue_id,actor_id,entity_type,entity_id,action,before_data,after_data)
   VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)`,
  [principal.venueId, principal.userId, type, entityId, action, before == null ? null : JSON.stringify(before), JSON.stringify(after)]
);

async function listFunctions(db, principal) {
  const access = await resolveAccess(db, principal);
  if (!access.view) fail('schedule_forbidden', 403);
  const rows = await db.query(`SELECT id,name,active,sort_order AS "sortOrder",version
    FROM staff_schedule_functions WHERE venue_id=$1 ORDER BY active DESC,sort_order,name,id`, [principal.venueId]);
  return { items: rows.rows };
}

async function saveFunction(pool, principal, functionId, method, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('schedule_settings_input_invalid');
  const key = requestKey(input.requestKey), signature = fingerprint({ functionId, method, input });
  const db = await pool.connect();
  try {
    await beginPayrollSourceProducerTransaction(db, principal.venueId);
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`schedule:${principal.venueId}`]);
    const access = await resolveAccess(db, principal, true);
    if (!access.canManageSettings) fail('schedule_settings_forbidden', 403);
    const replay = (await db.query(`SELECT fingerprint,response FROM staff_schedule_requests
      WHERE venue_id=$1 AND actor_id=$2 AND request_key=$3`, [principal.venueId, principal.userId, key])).rows[0];
    if (replay) {
      if (replay.fingerprint !== signature) fail('schedule_request_conflict', 409);
      await db.query('COMMIT'); return replay.response;
    }
    let row, before = null;
    if (method === 'POST' && functionId == null) {
      if (input.version !== undefined) fail('schedule_function_version_invalid');
      const name = functionName(input.name), active = input.active ?? true, sortOrder = input.sortOrder ?? 0;
      if (typeof active !== 'boolean' || !Number.isSafeInteger(sortOrder) || Math.abs(sortOrder) > 100000) fail('schedule_function_invalid');
      row = (await db.query(`INSERT INTO staff_schedule_functions(venue_id,name,active,sort_order,created_by)
        VALUES($1,$2,$3,$4,$5) RETURNING id,name,active,sort_order AS "sortOrder",version`,
      [principal.venueId, name, active, sortOrder, principal.userId])).rows[0];
      await configEvent(db, principal, 'function', row.id, 'create', null, row);
    } else if (method === 'PATCH' && functionId != null) {
      const currentId = id(functionId);
      before = (await db.query(`SELECT id,name,active,sort_order AS "sortOrder",version FROM staff_schedule_functions
        WHERE venue_id=$1 AND id=$2 FOR UPDATE`, [principal.venueId, currentId])).rows[0];
      if (!before) fail('schedule_function_not_found', 404);
      if (version(input.version) !== before.version) fail('schedule_function_version_conflict', 409);
      const name = input.name === undefined ? before.name : functionName(input.name);
      const active = input.active === undefined ? before.active : input.active;
      const sortOrder = input.sortOrder === undefined ? before.sortOrder : input.sortOrder;
      if (typeof active !== 'boolean' || !Number.isSafeInteger(sortOrder) || Math.abs(sortOrder) > 100000) fail('schedule_function_invalid');
      row = (await db.query(`UPDATE staff_schedule_functions SET name=$3,active=$4,sort_order=$5,version=version+1,updated_at=now()
        WHERE venue_id=$1 AND id=$2 RETURNING id,name,active,sort_order AS "sortOrder",version`,
      [principal.venueId, currentId, name, active, sortOrder])).rows[0];
      await configEvent(db, principal, 'function', row.id, active ? 'update' : 'archive', before, row);
    } else fail('schedule_function_method_invalid', 405);
    const response = row;
    await db.query(`INSERT INTO staff_schedule_requests(venue_id,actor_id,request_key,fingerprint,response)
      VALUES($1,$2,$3,$4,$5::jsonb)`, [principal.venueId, principal.userId, key, signature, JSON.stringify(response)]);
    await db.query('COMMIT');
    return response;
  } catch (error) {
    await db.query('ROLLBACK');
    if (error.code === '23505') fail('schedule_function_name_conflict', 409);
    throw error;
  } finally { db.release(); }
}

async function employeeFunctions(db, principal, employeeId) {
  const access = await resolveAccess(db, principal);
  if (!access.view) fail('schedule_forbidden', 403);
  const employee = id(employeeId);
  const exists = await db.query(`SELECT id FROM users WHERE venue_id=$1 AND id=$2 AND deleted_at IS NULL`, [principal.venueId, employee]);
  if (!exists.rowCount) fail('schedule_employee_not_found', 404);
  const [rows, latest] = await Promise.all([
    db.query(`SELECT ef.function_id AS "functionId",f.name,ef.is_primary AS "isPrimary"
      FROM staff_schedule_employee_functions ef JOIN staff_schedule_functions f
        ON f.venue_id=ef.venue_id AND f.id=ef.function_id
      WHERE ef.venue_id=$1 AND ef.user_id=$2 AND ef.active ORDER BY ef.is_primary DESC,f.sort_order,f.name`, [principal.venueId, employee]),
    db.query(`SELECT COALESCE(MAX(id),0)::bigint AS version FROM staff_schedule_config_events
      WHERE venue_id=$1 AND entity_type='employee_function' AND entity_id=$2`, [principal.venueId, employee])
  ]);
  return { userId: employee, version: Number(latest.rows[0].version), items: rows.rows };
}

async function setEmployeeFunctions(pool, principal, employeeId, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('schedule_settings_input_invalid');
  const employee = id(employeeId), key = requestKey(input.requestKey);
  if (!Array.isArray(input.functionIds) || input.functionIds.length > 50) fail('schedule_employee_functions_invalid');
  const functionIds = input.functionIds.map(id);
  if (new Set(functionIds).size !== functionIds.length) fail('schedule_employee_functions_invalid');
  const primaryId = input.primaryFunctionId == null ? null : id(input.primaryFunctionId);
  if (primaryId && !functionIds.includes(primaryId)) fail('schedule_employee_functions_invalid');
  if (!Number.isSafeInteger(input.version) || input.version < 0) fail('schedule_function_version_required');
  const signature = fingerprint({ employee, input: { ...input, functionIds: [...functionIds].sort() } }), db = await pool.connect();
  try {
    await beginPayrollSourceProducerTransaction(db, principal.venueId);
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`schedule:${principal.venueId}`]);
    const access = await resolveAccess(db, principal, true);
    if (!access.canManageSettings) fail('schedule_settings_forbidden', 403);
    const replay = (await db.query(`SELECT fingerprint,response FROM staff_schedule_requests
      WHERE venue_id=$1 AND actor_id=$2 AND request_key=$3`, [principal.venueId, principal.userId, key])).rows[0];
    if (replay) {
      if (replay.fingerprint !== signature) fail('schedule_request_conflict', 409);
      await db.query('COMMIT'); return replay.response;
    }
    const user = await db.query(`SELECT id FROM users WHERE venue_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE`, [principal.venueId, employee]);
    if (!user.rowCount) fail('schedule_employee_not_found', 404);
    const before = (await db.query(`SELECT ef.function_id AS "functionId",f.name,ef.is_primary AS "isPrimary"
      FROM staff_schedule_employee_functions ef JOIN staff_schedule_functions f
        ON f.venue_id=ef.venue_id AND f.id=ef.function_id
      WHERE ef.venue_id=$1 AND ef.user_id=$2 AND ef.active ORDER BY ef.function_id`, [principal.venueId, employee])).rows;
    const currentVersion = Number((await db.query(`SELECT COALESCE(MAX(id),0)::bigint AS version FROM staff_schedule_config_events
      WHERE venue_id=$1 AND entity_type='employee_function' AND entity_id=$2`, [principal.venueId, employee])).rows[0].version);
    if (currentVersion !== input.version) fail('schedule_function_version_conflict', 409);
    const eligible = functionIds.length ? await db.query(`SELECT id FROM staff_schedule_functions
      WHERE venue_id=$1 AND active AND id=ANY($2::uuid[]) ORDER BY id`, [principal.venueId, functionIds]) : { rows: [] };
    if (eligible.rows.length !== functionIds.length) fail('schedule_function_not_found', 404);
    await db.query(`UPDATE staff_schedule_employee_functions SET active=false,is_primary=false
      WHERE venue_id=$1 AND user_id=$2 AND active AND NOT (function_id=ANY($3::uuid[]))`, [principal.venueId, employee, functionIds]);
    for (const functionId of functionIds) {
      await db.query(`INSERT INTO staff_schedule_employee_functions(venue_id,user_id,function_id,active,is_primary,created_by)
        VALUES($1,$2,$3,true,$4,$5) ON CONFLICT(venue_id,user_id,function_id) DO UPDATE
        SET active=true,is_primary=EXCLUDED.is_primary`,
      [principal.venueId, employee, functionId, functionId === primaryId, principal.userId]);
    }
    const after = (await db.query(`SELECT ef.function_id AS "functionId",f.name,ef.is_primary AS "isPrimary"
      FROM staff_schedule_employee_functions ef JOIN staff_schedule_functions f
        ON f.venue_id=ef.venue_id AND f.id=ef.function_id
      WHERE ef.venue_id=$1 AND ef.user_id=$2 AND ef.active ORDER BY ef.function_id`, [principal.venueId, employee])).rows;
    await configEvent(db, principal, 'employee_function', employee, 'replace', before, after);
    const newVersion = Number((await db.query(`SELECT MAX(id)::bigint AS version FROM staff_schedule_config_events
      WHERE venue_id=$1 AND entity_type='employee_function' AND entity_id=$2`, [principal.venueId, employee])).rows[0].version);
    const response = { userId: employee, version: newVersion, items: after };
    await db.query(`INSERT INTO staff_schedule_requests(venue_id,actor_id,request_key,fingerprint,response)
      VALUES($1,$2,$3,$4,$5::jsonb)`, [principal.venueId, principal.userId, key, signature, JSON.stringify(response)]);
    await db.query('COMMIT'); return response;
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally { db.release(); }
}

const AVAILABILITY_KINDS = new Set(['available', 'unavailable', 'preferred']);
const localDateValue = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T12:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
};
const localTimeValue = value => typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
function availabilityItems(input, exceptions) {
  if (!Array.isArray(input) || input.length > (exceptions ? 120 : 70)) fail('schedule_availability_invalid');
  return input.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || !AVAILABILITY_KINDS.has(item.kind)
      || !localTimeValue(item.startTime) || !localTimeValue(item.endTime)
      || ![0, 1].includes(item.endDayOffset ?? 0)
      || typeof (item.note ?? '') !== 'string' || (item.note ?? '').length > 500) fail('schedule_availability_invalid');
    const offset = item.endDayOffset ?? 0;
    if ((offset === 0 && item.endTime <= item.startTime)
      || (offset === 1 && item.endTime === item.startTime && item.startTime !== '00:00')) fail('schedule_availability_interval_invalid');
    if (exceptions) {
      if (!localDateValue(item.workDate)) fail('schedule_availability_date_invalid');
      return { workDate: item.workDate, kind: item.kind, startTime: item.startTime, endTime: item.endTime,
        endDayOffset: offset, note: item.note ?? '' };
    }
    if (!Number.isSafeInteger(item.weekday) || item.weekday < 1 || item.weekday > 7
      || !localDateValue(item.effectiveFrom) || (item.effectiveTo != null && !localDateValue(item.effectiveTo))
      || (item.effectiveTo && item.effectiveTo < item.effectiveFrom)) fail('schedule_availability_rule_invalid');
    return { weekday: item.weekday, kind: item.kind, startTime: item.startTime, endTime: item.endTime,
      endDayOffset: offset, effectiveFrom: item.effectiveFrom, effectiveTo: item.effectiveTo ?? null, note: item.note ?? '' };
  });
}

async function employeeAvailability(db, principal, employeeId) {
  const access = await resolveAccess(db, principal);
  if (!access.canManageSettings) fail('schedule_settings_forbidden', 403);
  const employee = id(employeeId);
  const exists = await db.query('SELECT id FROM users WHERE venue_id=$1 AND id=$2 AND deleted_at IS NULL', [principal.venueId, employee]);
  if (!exists.rowCount) fail('schedule_employee_not_found', 404);
  const rules = await db.query(`SELECT id,weekday,rule_kind AS kind,to_char(start_time,'HH24:MI') AS "startTime",to_char(end_time,'HH24:MI') AS "endTime",end_day_offset AS "endDayOffset",
      effective_from::text AS "effectiveFrom",effective_to::text AS "effectiveTo",note,version
      FROM staff_schedule_availability_rules WHERE venue_id=$1 AND user_id=$2 AND active ORDER BY weekday,start_time,id`, [principal.venueId, employee]);
  const exceptions = await db.query(`SELECT id,work_date::text AS "workDate",rule_kind AS kind,to_char(start_time,'HH24:MI') AS "startTime",to_char(end_time,'HH24:MI') AS "endTime",end_day_offset AS "endDayOffset",note,version
      FROM staff_schedule_availability_exceptions WHERE venue_id=$1 AND user_id=$2 AND active ORDER BY work_date,start_time,id`, [principal.venueId, employee]);
  const latest = await db.query(`SELECT COALESCE(MAX(id),0)::bigint AS version FROM staff_schedule_config_events
      WHERE venue_id=$1 AND entity_type IN ('availability_rule','availability_exception') AND entity_id=$2`, [principal.venueId, employee]);
  return { userId: employee, version: Number(latest.rows[0].version), rules: rules.rows, exceptions: exceptions.rows };
}

async function setEmployeeAvailability(pool, principal, employeeId, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !Number.isSafeInteger(input.version) || input.version < 0) fail('schedule_availability_input_invalid');
  const employee = id(employeeId), key = requestKey(input.requestKey);
  const rules = availabilityItems(input.rules, false), exceptions = availabilityItems(input.exceptions, true);
  const signature = fingerprint({ employee, input: { version: input.version, rules, exceptions } }), db = await pool.connect();
  try {
    await beginPayrollSourceProducerTransaction(db, principal.venueId);
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`schedule:${principal.venueId}`]);
    const access = await resolveAccess(db, principal, true);
    if (!access.canManageSettings) fail('schedule_settings_forbidden', 403);
    const replay = (await db.query(`SELECT fingerprint,response FROM staff_schedule_requests WHERE venue_id=$1 AND actor_id=$2 AND request_key=$3`,
      [principal.venueId, principal.userId, key])).rows[0];
    if (replay) {
      if (replay.fingerprint !== signature) fail('schedule_request_conflict', 409);
      await db.query('COMMIT'); return replay.response;
    }
    const employeeRow = await db.query('SELECT id FROM users WHERE venue_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE', [principal.venueId, employee]);
    if (!employeeRow.rowCount) fail('schedule_employee_not_found', 404);
    const before = await employeeAvailability(db, principal, employee);
    if (before.version !== input.version) fail('schedule_availability_version_conflict', 409);
    await db.query(`UPDATE staff_schedule_availability_rules SET active=false,version=version+1,updated_at=now()
      WHERE venue_id=$1 AND user_id=$2 AND active`, [principal.venueId, employee]);
    await db.query(`UPDATE staff_schedule_availability_exceptions SET active=false,version=version+1,updated_at=now()
      WHERE venue_id=$1 AND user_id=$2 AND active`, [principal.venueId, employee]);
    for (const rule of rules) {
      const row = (await db.query(`INSERT INTO staff_schedule_availability_rules(venue_id,user_id,weekday,rule_kind,start_time,end_time,end_day_offset,effective_from,effective_to,note,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id,weekday,rule_kind AS kind,start_time::text AS "startTime",end_time::text AS "endTime",end_day_offset AS "endDayOffset",effective_from::text AS "effectiveFrom",effective_to::text AS "effectiveTo",note,version`,
      [principal.venueId, employee, rule.weekday, rule.kind, rule.startTime, rule.endTime, rule.endDayOffset, rule.effectiveFrom, rule.effectiveTo, rule.note, principal.userId])).rows[0];
    }
    for (const exception of exceptions) {
      const row = (await db.query(`INSERT INTO staff_schedule_availability_exceptions(venue_id,user_id,work_date,rule_kind,start_time,end_time,end_day_offset,note,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,work_date::text AS "workDate",rule_kind AS kind,start_time::text AS "startTime",end_time::text AS "endTime",end_day_offset AS "endDayOffset",note,version`,
      [principal.venueId, employee, exception.workDate, exception.kind, exception.startTime, exception.endTime, exception.endDayOffset, exception.note, principal.userId])).rows[0];
    }
    await configEvent(db, principal, 'availability_rule', employee, 'replace', before.rules, rules);
    await configEvent(db, principal, 'availability_exception', employee, 'replace', before.exceptions, exceptions);
    const after = await employeeAvailability(db, principal, employee);
    await db.query(`INSERT INTO staff_schedule_requests(venue_id,actor_id,request_key,fingerprint,response) VALUES($1,$2,$3,$4,$5::jsonb)`,
      [principal.venueId, principal.userId, key, signature, JSON.stringify(after)]);
    await db.query('COMMIT'); return after;
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}

module.exports = { listFunctions, saveFunction, employeeFunctions, setEmployeeFunctions, employeeAvailability, setEmployeeAvailability };
