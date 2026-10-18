'use strict';

const operationalRoles = new Set(['bartender', 'hookah_master', 'senior_bartender', 'senior_hookah_master', 'cleaner', 'security', 'technician', 'other_staff', 'staff']);

function createFinanceReportVenueAccess({ pool, resolvePermissions }) {
  return async function listFinanceReportVenues({ user, selectedVenueId = null } = {}) {
    if (!pool || !user?.id || !user?.organizationId) return [];
    if (selectedVenueId !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(selectedVenueId))) return [];
    const { rows } = await pool.query(`SELECT v.id,v.name,v.timezone AS "timeZone",u.role,
        u.permission_scopes AS "permissionScopes",u.custom_role_id AS "customRoleId",
        cr.permission_scopes AS "customRolePermissionScopes",(cr.id IS NOT NULL) AS "customRoleActive",
        sro.permission_scopes AS "rolePermissionScopes",(sro.role IS NOT NULL) AS "rolePermissionOverrideActive"
      FROM venues v
      JOIN organizations o ON o.id=v.organization_id AND o.is_active=true
      JOIN organization_subscriptions os ON os.organization_id=o.id AND os.status<>'cancelled'
      JOIN organization_memberships m ON m.organization_id=o.id AND m.user_id=$2 AND m.status='active'
      JOIN users u ON u.id=m.user_id AND u.organization_id=o.id AND u.is_active=true
      LEFT JOIN custom_staff_roles cr ON cr.id=u.custom_role_id AND cr.organization_id=u.organization_id AND cr.venue_id=v.id AND cr.is_active=true
      LEFT JOIN system_role_permission_overrides sro ON sro.venue_id=v.id AND sro.role=u.role::text
      WHERE v.organization_id=$1 AND v.is_active=true AND ($3::uuid IS NULL OR v.id=$3)
      ORDER BY v.id`, [user.organizationId, user.id, selectedVenueId]);
    return rows.flatMap((row) => {
      const role = String(row.role || '').toLowerCase();
      if (operationalRoles.has(role)) return [];
      const permissions = resolvePermissions({
        ...user,
        role: row.role,
        permissionScopes: row.permissionScopes,
        customRoleId: row.customRoleId,
        customRoleActive: row.customRoleActive === true,
        customRolePermissionScopes: row.customRolePermissionScopes,
        rolePermissionScopes: row.rolePermissionScopes,
        rolePermissionOverrideActive: row.rolePermissionOverrideActive === true
      });
      if (!permissions.includes('finance') && !permissions.includes('finance_read')) return [];
      return [{ id: row.id, name: row.name, timeZone: row.timeZone, permissions, isCurrent: String(row.id) === String(user.venueId || '') }];
    });
  };
}

module.exports = { createFinanceReportVenueAccess };
