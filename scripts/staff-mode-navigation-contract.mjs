import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const app = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const distApp = fs.readFileSync(new URL('../dist/app.js', import.meta.url), 'utf8');
const distHtml = fs.readFileSync(new URL('../dist/index.html', import.meta.url), 'utf8');
const syncScript = fs.readFileSync(new URL('../scripts/sync-published-assets.mjs', import.meta.url), 'utf8');
const appRevision = syncScript.match(/appRevision = '(\d+)'/)?.[1];
assert.ok(appRevision, 'app cache revision must be declared in the asset sync script');
assert.doesNotMatch(app, /staff-telegram-link\.js|__staffTelegramLinkLoaded/, 'staff sidebar must not mount a Telegram contact shortcut');
assert.doesNotMatch(html, /staff-telegram-link/, 'staff markup must not include a Telegram footer link');
assert.doesNotMatch(distHtml, /staff-telegram-link/, 'published staff markup must not include a Telegram footer link');

assert.match(app, /const preserveWorkspaceRoute=\(href\)=>/);
assert.match(app, /queryParams\.delete\('mode'\)/);
assert.match(app, /next\.searchParams\.delete\('operator'\)/);
assert.match(app, /staff-guests-link.*preserveWorkspaceRoute\(['"]\/clients['"]\)/s);
assert.match(app, /label\.includes\('Бронирования'\).*hasStaffPermission\('reservations',staffSessionPermissions\)/s,
  'reservation navigation must re-check the authenticated permission before redirect');
assert.match(app, /label\.includes\('Финансы'\).*hasStaffPermission\('finance_read',staffSessionPermissions\)/s,
  'finance navigation must re-check the authenticated permission before redirect');
assert.doesNotMatch(app, /operatorId|actingAccount|режим сотрудника/);

// The employee sidebar stays hidden until the authenticated session is read.
assert.equal([...html.matchAll(/<nav class="portal-nav" hidden aria-busy="true" data-session-pending="true">/g)].length, 2);
const staffNavButtons = [...html.matchAll(/<button\b([^>]*)data-permission="[^"]+"([^>]*)>([\s\S]*?)<\/button>/g)];
assert.ok(staffNavButtons.length > 0, 'staff navigation must contain permission-filtered buttons');
assert.ok(staffNavButtons.every(([, before, after]) => /aria-label="[^"]+"/.test(before + after)),
  'icon-only staff navigation buttons must preserve their labels for assistive technology');
assert.match(app, /staffFetchJson\('\/api\/session'\)/);
assert.doesNotMatch(app, /cachedSession|releasePendingStaffNavigation/);
assert.match(app, /data-staff-session-retry/);
assert.match(app, /if\(!s\?\.user\)return/);
assert.match(app, /item\.hidden=!hasStaffPermission\(item\.dataset\.permission,permissions\)/,
  'every nav item must be both hidden when forbidden and restored when its permission is granted');

// Exercise the exact permission predicate used by the UI against the server's
// manager permission profile, including the inventory/finance read aliases.
const permissionHelper = app.match(/const staffPermissionAliases=\{[^;]+;\s*const hasStaffPermission=\(required,permissions\)=>[^;]+;/);
assert.ok(permissionHelper, 'the UI permission predicate must stay explicit and testable');
const hasStaffPermission = vm.runInNewContext(`${permissionHelper[0]}; hasStaffPermission`);
const managerPermissions = new Set(['floor', 'orders', 'reservations', 'inventory_read', 'finance_read', 'staff_view', 'tasks_manage', 'settings', 'loyalty']);
for (const permission of ['floor', 'orders', 'inventory_read', 'finance_read', 'loyalty']) {
  assert.equal(hasStaffPermission(permission, managerPermissions), true, `manager must see ${permission}`);
}
assert.equal(hasStaffPermission('inventory', managerPermissions), false, 'read-only manager must not get inventory write access');
assert.equal(hasStaffPermission('staff_manage', managerPermissions), false, 'manager must not get personnel-management access');
const adminHelper=app.match(/const canOpenStaffAdmin=[^;]+;/);
assert.ok(adminHelper);
const canOpenStaffAdmin=vm.runInNewContext(`${adminHelper[0]};canOpenStaffAdmin`);
assert.equal(canOpenStaffAdmin(managerPermissions),true,'manager authoritative grants allow management panel');
assert.equal(canOpenStaffAdmin(new Set()),false,'role name cannot restore absent grants');
assert.equal(canOpenStaffAdmin(new Set(['staff_view'])),true,'custom personnel read grant allows panel');
assert.match(app, /link\.className='staff-admin-nav-link'/,
  'the authorized management return remains in the sidebar navigation');
assert.doesNotMatch(app, /staff-admin-switch/,
  'the duplicate management-panel link must not remain in the user profile footer');
assert.match(app, /\.portal-nav:not\(\.staff-admin-nav\)/,
  'role-filtered employee sections must not hide the separate role-gated admin return link');
assert.match(app, /manager:\['floor','orders','reservations','inventory_read','finance_read','loyalty'\]/,
  'static demonstration role should mirror the manager navigation shape');

// Published assets must be exact copies, so a correct local fix cannot vanish
// or diverge on a static dist deployment.
assert.equal(distApp, app);
assert.equal(distHtml, html);
assert.match(html, new RegExp(`app\\.js\\?rev=${appRevision}`));
assert.doesNotMatch(html, /Мария|Darkside Blueberry|2 100 ₽|<span>Смена открыта<\/span>/,
  'initial workspace must not impersonate a demo employee or show a fake order/shift');
assert.match(html, /<section class="order" inert>/, 'order actions remain inert until session verification');
assert.match(app, /if\(staffSessionVerified\)\{mountStaffExtensions\(\);/,
  'profile extensions mount only after staff session verification');
const css = fs.readFileSync(new URL('../style.css', import.meta.url), 'utf8');
assert.match(css, /\.staff-theme \.portal-sidebar \.portal-nav button\[hidden\][\s\S]*?display:none!important/,
  'server-hidden buttons must stay visually hidden despite authored display rules');

console.log('STAFF SESSION NAVIGATION CONTRACT: PASS (server-driven permissions, manager links, fail-closed loading, root/dist parity)');
