'use strict';
const { ScheduleError, capabilities, UUID } = require('./staff-schedule-domain');
const deny = () => { throw new ScheduleError('schedule_forbidden', 403); };
async function resolveAccess(db, principal, lock = false) {
  if (!UUID.test(String(principal?.userId || '')) || !UUID.test(String(principal?.venueId || ''))) return deny();
  if (lock) {
    // Acquire first, then read grants in a fresh READ COMMITTED statement snapshot.
    await db.query('SELECT id FROM users WHERE id=$1 FOR SHARE', [principal.userId]);
  }
  // Never trust a role or grant supplied by the browser or a cached session.
  const result = await db.query(`SELECT u.role, v.timezone, g.access, g.can_publish, g.can_manage_settings
    FROM users u JOIN venues v ON v.id=$2
    LEFT JOIN staff_schedule_grants g ON g.venue_id=v.id AND g.user_id=u.id
    WHERE u.id=$1 AND u.is_active AND u.deleted_at IS NULL AND v.is_active
      AND (u.venue_id=v.id OR (u.role='owner' AND u.organization_id=v.organization_id))
    ${lock ? 'FOR SHARE OF u,v' : ''}`, [principal.userId, principal.venueId]);
  const row = result.rows[0];
  if (!row) return deny();
  const resolved = capabilities(row.role, row.access);
  return { ...resolved, self: true, canPublish: row.role === 'owner' || (resolved.manage && row.can_publish === true),
    canManageSettings: row.role === 'owner' || (resolved.manage && row.can_manage_settings === true), timezone: row.timezone, role: row.role };
}
async function setGrant(pool, principal, input) {
  if (!input || !UUID.test(String(input.userId || '')) || !['none', 'view', 'manage'].includes(input.access)
      || !Number.isSafeInteger(input.version) || input.version < 0
      || (input.canPublish !== undefined && typeof input.canPublish !== 'boolean')
      || (input.canPublish === true && input.access !== 'manage')
      || (input.canManageSettings !== undefined && typeof input.canManageSettings !== 'boolean')
      || (input.canManageSettings === true && input.access !== 'manage')) throw new ScheduleError('schedule_grant_invalid');
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    if (!(await resolveAccess(db, principal, true)).grant) deny();
    // Serialize creation as well as revision updates; locking a missing grant row is insufficient.
    const employee = await db.query(`SELECT role FROM users WHERE id=$1 AND venue_id=$2
      AND is_active AND deleted_at IS NULL FOR UPDATE`, [input.userId, principal.venueId]);
    if (!employee.rows[0]) throw new ScheduleError('schedule_employee_not_found', 404);
    if (!['admin', 'manager'].includes(employee.rows[0].role)) throw new ScheduleError('schedule_grant_role_invalid');
    const current = (await db.query('SELECT access,version,can_publish,can_manage_settings FROM staff_schedule_grants WHERE venue_id=$1 AND user_id=$2 FOR UPDATE', [principal.venueId, input.userId])).rows[0];
    if ((current?.version || 0) !== input.version) throw new ScheduleError('schedule_grant_conflict', 409);
    const next = input.version + 1;
    const canPublish = input.access === 'manage' && (input.canPublish ?? current?.can_publish ?? false);
    const canManageSettings = input.access === 'manage' && (input.canManageSettings ?? current?.can_manage_settings ?? false);
    await db.query(`INSERT INTO staff_schedule_grants(venue_id,user_id,access,version,granted_by,can_publish,can_manage_settings)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(venue_id,user_id) DO UPDATE
      SET access=EXCLUDED.access,version=EXCLUDED.version,granted_by=EXCLUDED.granted_by,can_publish=EXCLUDED.can_publish,
          can_manage_settings=EXCLUDED.can_manage_settings,updated_at=now()`,
    [principal.venueId, input.userId, input.access, next, principal.userId, canPublish, canManageSettings]);
    await db.query(`INSERT INTO staff_schedule_grant_events(venue_id,user_id,actor_id,previous_access,access,version,previous_can_publish,can_publish,previous_can_manage_settings,can_manage_settings)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [principal.venueId, input.userId, principal.userId,
      current?.access || 'none', input.access, next, current?.can_publish || false, canPublish,
      current?.can_manage_settings || false, canManageSettings]);
    await db.query('COMMIT');
    return { userId: input.userId, access: input.access, version: next, canPublish, canManageSettings };
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}
module.exports = { resolveAccess, setGrant };
