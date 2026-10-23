'use strict';
const { beginPayrollSourceProducerTransaction } = require('./payroll-source-fence');

// Venue-scoped template bindings; optimistic revisions are provided by migration 105.
const { createHash } = require('node:crypto');
const { ScheduleError, UUID } = require('./staff-schedule-domain');
const { resolveAccess } = require('./staff-schedule-access');

const fail = (code, status = 400) => { throw new ScheduleError(code, status); };
const uuid = value => {
  if (typeof value !== 'string' || !UUID.test(value)) fail('schedule_binding_id_invalid');
  return value.toLowerCase();
};
const optionalUuid = value => value == null ? null : uuid(value);
const roleKeys = employee => [
  `system:${employee.role}`,
  ...(employee.custom_role_id && employee.custom_role_active ? [`custom:${employee.custom_role_id}`] : [])
];
const bindingDTO = row => ({
  id: row.id, templateId: row.template_id, templateName: row.template_name,
  templateVersion: row.template_version, targetKind: row.target_kind,
  targetUserId: row.target_user_id, targetRoleKey: row.target_role_key,
  targetFunctionId: row.target_function_id, priority: row.priority, version: row.version,
  active: row.active, templateArchived: row.template_archived
});
const templateDTO = row => ({
  templateId: row.id, templateName: row.name, templateVersion: row.version,
  definition: row.definition
});
const applicable = (template, employeeId, qualified) => {
  const def = template.definition;
  const member = def?.schemaVersion === 2 && def.mode === 'team'
    ? (Array.isArray(def.members) && def.members.find(item => item.userId === employeeId)) : null;
  if (def?.schemaVersion === 2 && def.mode === 'team' && !member) return false;
  const slots = member ? member.slots : def?.slots;
  if (!Array.isArray(slots)) return false;
  if (member?.functionId && !qualified.has(member.functionId)) return false;
  return slots.every(slot => !slot.functionId || qualified.has(slot.functionId));
};
const uniqueTemplates = rows => {
  const found = new Map();
  for (const row of rows) if (!found.has(row.template_id)) found.set(row.template_id, {
    ...templateDTO({ id: row.template_id, name: row.template_name,
      version: row.template_version, definition: row.definition }),
    sources: []
  });
  for (const row of rows) {
    const entry = found.get(row.template_id);
    if (!entry.sources.some(source => source.kind === row.target_kind && source.key === row.target_key)) {
      entry.sources.push({ kind: row.target_kind, key: row.target_key });
    }
  }
  return [...found.values()];
};

// GET settings projection. Archived templates are hidden unless explicitly
// requested for administrative cleanup; they are never returned as suggestions.
async function listBindings(pool, principal, options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)
      || (options.includeInactive !== undefined && typeof options.includeInactive !== 'boolean')
      || (options.includeArchived !== undefined && typeof options.includeArchived !== 'boolean')) fail('schedule_binding_input_invalid');
  const db = await pool.connect();
  try {
    const access = await resolveAccess(db, principal);
    if (!access.canManageSettings) fail('schedule_settings_forbidden', 403);
    const result = await db.query(`SELECT b.id,b.template_id,t.name AS template_name,t.version AS template_version,b.version,
        b.target_kind,b.target_user_id,b.target_role_key,b.target_function_id,b.priority,b.active,
        t.archived AS template_archived
      FROM staff_schedule_template_bindings b
      JOIN staff_schedule_templates t ON t.venue_id=b.venue_id AND t.id=b.template_id
      WHERE b.venue_id=$1 AND ($2::boolean OR b.active) AND ($3::boolean OR NOT t.archived)
      ORDER BY b.active DESC,b.priority,b.target_kind,t.name,b.id`,
    [principal.venueId, options.includeInactive === true, options.includeArchived === true]);
    return { items: result.rows.map(bindingDTO), writeAvailable: true };
  } finally { db.release(); }
}

// GET planner suggestion. Explicit choice wins; a function-specific personal
// default wins over a general one. Bindings never break ties by priority: when
// several templates match the same tier the caller must ask the human.
async function suggestTemplates(pool, principal, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('schedule_binding_input_invalid');
  const employeeId = uuid(input.employeeId);
  const functionId = optionalUuid(input.functionId);
  const explicitTemplateId = optionalUuid(input.explicitTemplateId);
  const db = await pool.connect();
  try {
    await db.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const access = await resolveAccess(db, principal);
    if (!access.manage) fail('schedule_forbidden', 403);
    const employee = (await db.query(`SELECT u.id,u.role,u.custom_role_id,
        COALESCE(cr.is_active,false) AS custom_role_active
      FROM users u LEFT JOIN custom_staff_roles cr
        ON cr.id=u.custom_role_id AND cr.venue_id=u.venue_id
        AND cr.organization_id=u.organization_id
      WHERE u.venue_id=$1 AND u.id=$2 AND u.is_active AND u.deleted_at IS NULL`,
    [principal.venueId, employeeId])).rows[0];
    if (!employee) fail('schedule_employee_not_found', 404);
    const qualifications = await db.query(`SELECT ef.function_id FROM staff_schedule_employee_functions ef
      JOIN staff_schedule_functions f ON f.venue_id=ef.venue_id AND f.id=ef.function_id
      WHERE ef.venue_id=$1 AND ef.user_id=$2 AND ef.active AND f.active`,
    [principal.venueId, employeeId]);
    const qualified = new Set(qualifications.rows.map(row => row.function_id));
    if (functionId && !qualified.has(functionId)) fail('schedule_function_not_qualified', 409);
    const templates = await db.query(`SELECT id,name,version,definition FROM staff_schedule_templates
      WHERE venue_id=$1 AND NOT archived`, [principal.venueId]);
    const eligible = new Map(templates.rows.filter(row => applicable(row, employeeId, qualified)).map(row => [row.id, row]));
    if (explicitTemplateId) {
      const selected = eligible.get(explicitTemplateId);
      if (!selected) fail('schedule_template_not_available', 404);
      await db.query('COMMIT');
      return { employeeId, functionId, source: 'explicit', selection: templateDTO(selected), choices: [], requiresChoice: false };
    }
    const defaults = await db.query(`SELECT id,function_id,template_id,
        to_char(start_time,'HH24:MI') AS start_time,to_char(end_time,'HH24:MI') AS end_time,
        end_day_offset,break_minutes,version
      FROM staff_schedule_employee_defaults
      WHERE venue_id=$1 AND user_id=$2 AND (function_id IS NULL OR function_id=$3)
      ORDER BY (function_id IS NOT NULL) DESC,id`, [principal.venueId, employeeId, functionId]);
    const personal = defaults.rows.find(row => {
      if (row.template_id && eligible.has(row.template_id)) return true;
      return row.start_time != null && row.end_time != null;
    });
    if (personal) {
      const template = personal.template_id && eligible.get(personal.template_id);
      const selection = template ? templateDTO(template) : {
        startTime: personal.start_time, endTime: personal.end_time,
        endDayOffset: personal.end_day_offset, breakMinutes: personal.break_minutes
      };
      await db.query('COMMIT');
      return { employeeId, functionId, source: 'employee_default', defaultId: personal.id,
        defaultVersion: personal.version, selection, choices: [], requiresChoice: false };
    }
    const keys = roleKeys(employee);
    const bindings = await db.query(`SELECT b.template_id,b.target_kind,
        COALESCE(b.target_user_id::text,b.target_role_key,b.target_function_id::text) AS target_key,
        t.name AS template_name,t.version AS template_version,t.definition
      FROM staff_schedule_template_bindings b
      JOIN staff_schedule_templates t ON t.venue_id=b.venue_id AND t.id=b.template_id
      WHERE b.venue_id=$1 AND b.active AND NOT t.archived AND
        ((b.target_kind='employee' AND b.target_user_id=$2)
          OR (b.target_kind='crm_role' AND b.target_role_key=ANY($3::text[]))
          OR (b.target_kind='work_function' AND b.target_function_id=$4))
      ORDER BY b.priority,b.template_id,b.id`,
    [principal.venueId, employeeId, keys, functionId]);
    const applicableBindings = bindings.rows.filter(row => eligible.has(row.template_id));
    const tiers = [
      ['employee_binding', applicableBindings.filter(row => row.target_kind === 'employee')],
      ['role_or_function_binding', applicableBindings.filter(row => row.target_kind !== 'employee')]
    ];
    const [source, matching] = tiers.find(([, rows]) => rows.length) || ['none', []];
    const choices = uniqueTemplates(matching);
    await db.query('COMMIT');
    return { employeeId, functionId, source,
      selection: choices.length === 1 ? choices[0] : null,
      choices: choices.length > 1 ? choices : [], requiresChoice: choices.length > 1 };
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}

const stable = value => Array.isArray(value) ? value.map(stable)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const fingerprint = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
const systemRoles = new Set(['owner', 'admin', 'manager', 'developer', 'senior_bartender',
  'senior_hookah_master', 'bartender', 'hookah_master', 'cleaner', 'security', 'technician', 'other_staff']);

// POST: saveBinding(pool, principal, null, 'POST', input), input.version=0.
// PATCH: saveBinding(pool, principal, bindingId, 'PATCH', input), input.version=current.
// Both require a caller-generated UUID requestKey and complete replacement fields.
async function saveBinding(pool, principal, bindingId, method, input) {
  if (!['POST', 'PATCH'].includes(method) || !input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(key => !['templateId', 'targetKind', 'targetUserId', 'targetRoleKey',
        'targetFunctionId', 'priority', 'active', 'version', 'requestKey'].includes(key))) fail('schedule_binding_input_invalid');
  const id = method === 'PATCH' ? uuid(bindingId) : null;
  if ((method === 'POST' && bindingId != null) || !Number.isSafeInteger(input.version)
      || input.version < (id ? 1 : 0) || (!id && input.version !== 0)) fail('schedule_binding_version_invalid');
  const key = uuid(input.requestKey), templateId = uuid(input.templateId);
  if (!['employee', 'crm_role', 'work_function'].includes(input.targetKind)
      || !Number.isSafeInteger(input.priority) || input.priority < 0 || input.priority > 10000
      || typeof input.active !== 'boolean') fail('schedule_binding_input_invalid');
  const targetUserId = input.targetKind === 'employee' ? uuid(input.targetUserId) : null;
  const targetFunctionId = input.targetKind === 'work_function' ? uuid(input.targetFunctionId) : null;
  const targetRoleKey = input.targetKind === 'crm_role' ? input.targetRoleKey : null;
  if (input.targetKind === 'crm_role' && targetRoleKey == null) fail('schedule_binding_role_invalid');
  if ((input.targetKind !== 'employee' && input.targetUserId != null)
      || (input.targetKind !== 'work_function' && input.targetFunctionId != null)
      || (input.targetKind !== 'crm_role' && input.targetRoleKey != null)) fail('schedule_binding_target_invalid');
  if (targetRoleKey != null && (typeof targetRoleKey !== 'string' || targetRoleKey.length > 80
      || targetRoleKey.trim() !== targetRoleKey || !/^(system:[a-z_]+|custom:[0-9a-f-]{36})$/.test(targetRoleKey))) fail('schedule_binding_role_invalid');
  const next = { templateId, targetKind: input.targetKind, targetUserId, targetRoleKey,
    targetFunctionId, priority: input.priority, active: input.active };
  const signature = fingerprint({ operation: 'saveBinding', id, method, version: input.version, next });
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
      await db.query('COMMIT');
      return replay.response;
    }
    const previous = id ? (await db.query(`SELECT * FROM staff_schedule_template_bindings
      WHERE venue_id=$1 AND id=$2 FOR UPDATE`, [principal.venueId, id])).rows[0] : null;
    if (id && !previous) fail('schedule_binding_not_found', 404);
    if (previous && previous.version !== input.version) fail('schedule_binding_version_conflict', 409);
    const template = (await db.query(`SELECT id,archived FROM staff_schedule_templates
      WHERE venue_id=$1 AND id=$2 FOR SHARE`, [principal.venueId, templateId])).rows[0];
    if (!template) fail('schedule_template_not_available', 404);
    if (template.archived && input.active) fail('schedule_binding_template_archived', 409);
    if (targetUserId) {
      const employee = await db.query(`SELECT id FROM users WHERE venue_id=$1 AND id=$2
        AND is_active AND deleted_at IS NULL FOR SHARE`, [principal.venueId, targetUserId]);
      if (!employee.rowCount && input.active) fail('schedule_employee_not_found', 404);
      if (!employee.rowCount && (!previous || previous.target_user_id !== targetUserId)) fail('schedule_employee_not_found', 404);
    }
    if (targetFunctionId) {
      const func = await db.query(`SELECT id,active FROM staff_schedule_functions
        WHERE venue_id=$1 AND id=$2 FOR SHARE`, [principal.venueId, targetFunctionId]);
      if (!func.rowCount) fail('schedule_function_not_found', 404);
      if (!func.rows[0].active && input.active) fail('schedule_binding_function_inactive', 409);
    }
    if (targetRoleKey?.startsWith('system:')) {
      if (!systemRoles.has(targetRoleKey.slice(7))) fail('schedule_binding_role_invalid');
    } else if (targetRoleKey?.startsWith('custom:')) {
      const customId = uuid(targetRoleKey.slice(7));
      const role = await db.query(`SELECT cr.id,cr.is_active FROM custom_staff_roles cr
        JOIN venues v ON v.id=cr.venue_id AND v.organization_id=cr.organization_id
        WHERE cr.venue_id=$1 AND cr.id=$2 FOR SHARE OF cr`, [principal.venueId, customId]);
      if (!role.rowCount) fail('schedule_binding_role_not_found', 404);
      if (!role.rows[0].is_active && input.active) fail('schedule_binding_role_inactive', 409);
    }
    const saved = id ? (await db.query(`UPDATE staff_schedule_template_bindings SET
        template_id=$3,target_kind=$4,target_user_id=$5,target_role_key=$6,target_function_id=$7,
        priority=$8,active=$9,version=version+1,updated_at=now()
        WHERE venue_id=$1 AND id=$2 AND version=$10 RETURNING *`,
    [principal.venueId, id, templateId, next.targetKind, targetUserId, targetRoleKey,
      targetFunctionId, next.priority, next.active, input.version])).rows[0]
      : (await db.query(`INSERT INTO staff_schedule_template_bindings
        (venue_id,template_id,target_kind,target_user_id,target_role_key,target_function_id,priority,active,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [principal.venueId, templateId, next.targetKind, targetUserId, targetRoleKey,
        targetFunctionId, next.priority, next.active, principal.userId])).rows[0];
    if (!saved) fail('schedule_binding_version_conflict', 409);
    const response = { id: saved.id, templateId: saved.template_id, targetKind: saved.target_kind,
      targetUserId: saved.target_user_id, targetRoleKey: saved.target_role_key,
      targetFunctionId: saved.target_function_id, priority: saved.priority,
      active: saved.active, version: saved.version };
    await db.query(`INSERT INTO staff_schedule_config_events
      (venue_id,actor_id,entity_type,entity_id,action,before_data,after_data)
      VALUES($1,$2,'template_binding',$3,$4,$5::jsonb,$6::jsonb)`,
    [principal.venueId, principal.userId, saved.id, id ? 'update' : 'create',
      previous ? JSON.stringify(previous) : null, JSON.stringify(response)]);
    await db.query(`INSERT INTO staff_schedule_requests
      (venue_id,actor_id,request_key,fingerprint,response) VALUES($1,$2,$3,$4,$5::jsonb)`,
    [principal.venueId, principal.userId, key, signature, JSON.stringify(response)]);
    await db.query('COMMIT');
    return response;
  } catch (error) {
    await db.query('ROLLBACK');
    if (error.code === '23505') fail('schedule_binding_duplicate', 409);
    throw error;
  } finally { db.release(); }
}

module.exports = { listBindings, suggestTemplates, saveBinding, systemRoles };
