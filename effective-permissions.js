'use strict';

// Database adapters must supply presence flags: an empty role is not a missing role.
function createPermissionResolver({ rolePermissions, scopedPermissionMap, normalizePermissionScopes }) {
  const expand = (scopes) => [...new Set(scopes.flatMap((scope) => scopedPermissionMap[scope] || []))];
  return (user = {}) => {
    const base = Array.isArray(rolePermissions[user?.role]) ? [...rolePermissions[user.role]] : [];
    const policy = { version: 1, source: 'base', systemRoleCeilingActive: false, blockedPermissions: [] };
    if (!base.length) return { permissions: [], policy };
    if (['owner', 'platform_owner'].includes(user.role)) {
      return { permissions: base, policy: { ...policy, source: 'protected' } };
    }

    const customActive = user.customRoleActive === true;
    const systemActive = user.rolePermissionOverrideActive === true;
    const personalScopes = normalizePermissionScopes(user.permissionScopes);
    const selectedScopes = customActive ? normalizePermissionScopes(user.customRolePermissionScopes)
      : personalScopes.length ? personalScopes : null;
    policy.source = customActive ? 'custom' : selectedScopes ? 'personal' : systemActive ? 'system' : 'base';
    policy.systemRoleCeilingActive = systemActive;

    // Preserve exact historical defaults (the editor's scope defaults are broader).
    if (selectedScopes === null && !systemActive) return { permissions: base, policy };
    let permissions = expand(selectedScopes === null ? normalizePermissionScopes(user.rolePermissionScopes) : selectedScopes);
    if (systemActive && selectedScopes !== null) {
      const ceiling = new Set(expand(normalizePermissionScopes(user.rolePermissionScopes)));
      policy.blockedPermissions = permissions.filter((permission) => !ceiling.has(permission));
      permissions = permissions.filter((permission) => ceiling.has(permission));
    }

    // Role-specific helpers must not bypass a withdrawn business capability.
    if (permissions.includes('orders')) {
      permissions.push(...base.filter((permission) => ['bar_tasks', 'hookah_tasks'].includes(permission)));
    }
    if (base.includes('diagnostics') && permissions.includes('settings')) permissions.push('diagnostics');
    return { permissions: [...new Set(permissions)], policy };
  };
}

module.exports = { createPermissionResolver };
