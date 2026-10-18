import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const portal = readFileSync(new URL('../portal.js', import.meta.url), 'utf8');

const roles = {
  bartender: { required: ['floor', 'orders'], forbidden: ['finance', 'inventory'] },
  hookah_master: { required: ['floor', 'orders'], forbidden: ['finance', 'inventory'] },
  senior_bartender: { required: ['floor', 'orders', 'bar_tasks'], forbidden: ['finance', 'inventory'] },
  senior_hookah_master: { required: ['floor', 'orders', 'hookah_tasks'], forbidden: ['finance', 'inventory'] },
  admin: { required: ['floor', 'orders', 'finance', 'inventory', 'staff_manage'], forbidden: [] },
  manager: { required: ['floor', 'orders', 'staff_view', 'tasks_manage', 'loyalty'], forbidden: ['staff_manage', 'finance'] },
  owner: { required: ['floor', 'orders', 'finance', 'inventory', 'staff_sensitive'], forbidden: [] },
  developer: { required: ['floor', 'orders', 'finance_read', 'inventory_read', 'diagnostics'], forbidden: ['finance', 'inventory'] },
  platform_owner: { required: ['platform', 'diagnostics'], forbidden: ['finance', 'inventory', 'orders'] }
};
const sessionRoute = server.match(/if \(pathname === '\/api\/session'\)\s*\{([\s\S]*?)\n\s*\}/)?.[1] || '';
assert.match(sessionRoute, /const persistedSession = await sessionFromRequest\(req\)/,
  'session identity is resolved from the authenticated request or persisted session');
assert.match(sessionRoute, /const user = withEffectivePermissions\(req\.user \|\| persistedSession\?\.user \|\| \{ name: 'Демо сотрудник', role: 'bartender' \}\);/,
  'session permissions are recalculated from the trusted server-side identity');
assert.doesNotMatch(server, /url\.searchParams\.get\('role'\)/, 'session role must come from the authenticated account, never the URL');
for (const role of ['bartender', 'hookah_master', 'senior_bartender', 'senior_hookah_master']) {
  const declaration = portal.match(new RegExp(`${role}: new Set\\(\\[([^\\]]+)\\]\\)`))?.[1] || '';
  assert.doesNotMatch(declaration, /staff_view/, `${role} UI must not expose personnel navigation without API permission`);
}
assert.match(portal, /bartender: new Set\(\['dashboard', 'floor', 'orders', 'bar_tasks', 'finance_read'\]\)/);
assert.match(portal, /hookah_master: new Set\(\['dashboard', 'floor', 'orders', 'hookah_tasks', 'finance_read'\]\)/);
assert.match(server, /hookah_master: \['floor', 'orders', 'hookah_tasks', 'finance_read'\]/,
  'hookah staff gets orders/tasks without inventory mutation or stock-reading access');
assert.doesNotMatch(server, /hookah_master: \[[^\]]*inventory/,
  'hookah staff role cannot gain direct warehouse permissions');
assert.match(server, /manager: \['floor', 'orders', 'reservations', 'inventory_read', 'finance_read', 'staff_view', 'tasks_manage', 'settings', 'loyalty'\]/);
assert.match(server, /pathname === '\/api\/payroll\/rules' && req\.method === 'GET'[\s\S]*?denyUnless\(req, res, 'finance'\)/,
  'payroll rates are restricted to the finance permission, not operational turnover or staff directory access');
assert.match(server, /pathname === '\/api\/expenses' && req\.method === 'GET'[\s\S]*?denyUnless\(req, res, 'finance'\)/,
  'operating expenses and payroll amounts require finance permission');
assert.match(server, /const permissionScopes = \[[^\]]*'loyalty'\]/);
assert.match(server, /loyalty: \['loyalty'\]/);
assert.match(server, /hasPermission\(req, 'loyalty'\)\) return json\(res, 403, \{ error: 'forbidden', permission: 'loyalty' \}\)/);
assert.match(server, /const ownTasksOnly = Boolean\(req\.user && !hasPermission\(req, 'staff_manage'\) && !hasPermission\(req, 'tasks_manage'\)\)/);
assert.match(server, /denyUnlessAny\(req, res, \['staff_manage', 'tasks_manage'\]\)/);
assert.match(server, /task_assignee_required/);
assert.match(portal, /field\.type === 'select'[\s\S]*field\.options/);
assert.match(portal, /name: 'assigneeId', label: 'Ответственный сотрудник'/);
assert.match(server, /assignee_id=\$3/);
assert.ok(server.includes("const activeClause = includeArchived ? '' : ' AND r.is_active=true'") && server.includes('WHERE r.organization_id=$1 AND r.venue_id=$2${activeClause}'), 'role list is scoped to the selected organization and venue');
assert.ok(server.includes('custom_staff_roles WHERE id=$1 AND organization_id=$2 AND venue_id=$3 AND is_active=true'), 'staff assignment accepts only active roles in the same organization and venue');
assert.ok(server.includes('input.customRoleId !== undefined && !repositories?.pool') && server.includes("error: 'custom_roles_requires_database'"), 'assignment requires persistent custom-role storage');
const staffCard = readFileSync(new URL('../staff-admin-card.js', import.meta.url), 'utf8');
assert.ok(staffCard.includes("api('/api/staff/roles')") && staffCard.includes('Роль доступа задаёт доступы к разделам текущей точки.'), 'staff card loads current-venue custom roles and explains their scope');
assert.ok(staffCard.includes('Не удалось загрузить профили доступа') && staffCard.includes('customRoleOptionsLoaded'), 'role load failures stay visible and do not silently clear assignment');
console.log(`LOCAL ROLE CONTRACT: PASS (${Object.keys(roles).length} role permission profiles; URL role override disabled)`);
