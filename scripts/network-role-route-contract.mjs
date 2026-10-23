import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync('portal-session.js', 'utf8');
const routeGuard = source.match(/const canAccessRoute = \(session, pathname, hash = ''\) => \{[\s\S]*?\n  \};/)?.[0];
const navigationStart = source.indexOf('  const canUseNavigation = (session, href, permission) =>');
const navigationEnd = source.indexOf('\n  function updateRetryButton', navigationStart);
const navigationGuard = navigationStart >= 0 && navigationEnd > navigationStart ? source.slice(navigationStart, navigationEnd).trim() : '';
assert.ok(routeGuard && navigationGuard, 'session route and navigation guards are available');
const context = vm.createContext({ URL, window: { location: { origin: 'http://example.invalid' } } });
vm.runInContext(`${routeGuard}\n${navigationGuard}\nglobalThis.guards={canAccessRoute,canUseNavigation};`, context);
const { canAccessRoute, canUseNavigation } = context.guards;
const role = (name, permissions = ['settings']) => ({ user: { id: `qa-${name}`, role: name }, permissions });
for (const name of ['owner', 'admin', 'developer']) assert.equal(canAccessRoute(role(name), '/network'), true, `${name} retains network route`);
for (const name of ['manager', 'platform_owner', 'bartender', 'cleaner']) assert.equal(canAccessRoute(role(name), '/network'), false, `${name} cannot enter network route even with settings`);
assert.equal(canAccessRoute(role('owner', []), '/network'), false, 'owner without settings remains denied');
assert.equal(canUseNavigation(role('manager'), '/network', 'settings'), false, 'navigation reuses the same network identity guard');
assert.equal(canUseNavigation(role('admin'), '/network', 'settings'), true, 'authorized navigation remains available');
const portal = fs.readFileSync('portal.js', 'utf8');
const sidebarStart = portal.indexOf('const canUseNetworkRoute =');
const sidebarEnd = portal.indexOf('\nconst operationsNav', sidebarStart);
assert.ok(sidebarStart >= 0 && sidebarEnd > sidebarStart, 'network sidebar role helper exists');
const sidebarCode = portal.slice(sidebarStart, sidebarEnd) + '\nglobalThis.sidebar={canUseNetworkRoute,hasNavigationPermission};';
for (const name of ['owner', 'admin', 'developer', 'manager', 'platform_owner', 'bartender']) {
  const permissions = new Set(['settings']);
  const sidebarContext = vm.createContext({ portalUser: { role: name }, hasPortalPermission: (key) => permissions.has(key), portalPermissions: permissions });
  vm.runInContext(sidebarCode, sidebarContext);
  const allowed = ['owner', 'admin', 'developer'].includes(name);
  assert.equal(sidebarContext.sidebar.canUseNetworkRoute(), allowed, `${name} sidebar route role gate`);
  assert.equal(sidebarContext.sidebar.hasNavigationPermission({ getAttribute: () => '/network', dataset: { permission: 'settings' } }), allowed, `${name} menu visibility gate`);
}
assert.match(portal, /page === 'network' && !canUseNetworkRoute\(\)/, 'portal page guard also blocks denied direct renders');
console.log('NETWORK ROLE ROUTE CONTRACT: PASS (owner/admin/developer allowlist; manager/platform owner/operations denied; settings scope retained)');
