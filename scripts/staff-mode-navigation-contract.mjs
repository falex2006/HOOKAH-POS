import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const app = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const distApp = fs.readFileSync(new URL('../dist/app.js', import.meta.url), 'utf8');
const distHtml = fs.readFileSync(new URL('../dist/index.html', import.meta.url), 'utf8');
const portal = fs.readFileSync(new URL('../portal.js', import.meta.url), 'utf8');
const distPortal = fs.readFileSync(new URL('../dist/portal.js', import.meta.url), 'utf8');
const portalSession = fs.readFileSync(new URL('../portal-session.js', import.meta.url), 'utf8');
const distPortalSession = fs.readFileSync(new URL('../dist/portal-session.js', import.meta.url), 'utf8');
const attendanceUi = fs.readFileSync(new URL('../staff-attendance-ui.js', import.meta.url), 'utf8');
const attendanceCss = fs.readFileSync(new URL('../staff-attendance-ui.css', import.meta.url), 'utf8');
const distAttendanceUi = fs.readFileSync(new URL('../dist/staff-attendance-ui.js', import.meta.url), 'utf8');
const distAttendanceCss = fs.readFileSync(new URL('../dist/staff-attendance-ui.css', import.meta.url), 'utf8');
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
assert.match(app, /financeRoute.*hasStaffPermission\('finance_read',staffSessionPermissions\)/s,
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
assert.match(app, /personalScheduleLink\.dataset\.permission='staff_schedule_self'/,
  'the employee self-schedule entry must be tagged with the distinct server permission');
assert.match(app, /staffSessionPermissions\.has\('staff_schedule_self'\).*preserveWorkspaceRoute\('\/admin#staff-schedule'\)/,
  'the self-schedule action must re-check the session permission before navigating');
assert.match(app, /#staff-primary-navigation \.portal-nav[\s\S]*?staff-personal-schedule-link[\s\S]*?Мой график/,
  'the actual employee primary navigation must render the self-schedule entry');
assert.match(app, /staff_attendance_self/,
  'personal attendance entry must use only the server-provided self permission');
assert.match(app, /staff-attendance:open-self/,
  'personal attendance deep links and same-hash notification clicks must open the self dialog');
assert.match(app, /staff-attendance-ui\.js\?rev=3/,
  'personal attendance loader must request the responsive UI revision');
assert.match(app, /dialog\.showModal\(\)[\s\S]*?mountSelf\(host,\{api:staffFetchJson\}\)/,
  'personal attendance must open an accessible in-workspace dialog and mount its self view');
assert.match(app, /const clearStaffAccessState=\(phase='denied'\)=>\{\s*closeStaffAttendanceDialog\(\)/,
  'session/access changes must dispose the personal attendance dialog');
assert.match(portalSession, /hash === '#staff-attendance'.*any\('staff_attendance_policy_manage', 'staff_attendance_approval', 'staff_attendance_close'\)/,
  'management route requires a narrow attendance capability, not general settings');
assert.match(portal, /href: '\/admin#staff-attendance'.*anyPermissions: \['staff_attendance_policy_manage', 'staff_attendance_approval', 'staff_attendance_close'\].*label: 'Выходы сотрудников'/,
  'team navigation must show attendance management to either delegated capability');
assert.match(portal, /function renderAttendanceManagementRoute\(target\)[\s\S]*?mountManagement\(target, \{ api, selfUserId: attendanceSession\?\.user\?\.id \}\)/,
  'management route must load the bounded attendance UI and mount the management view');
assert.match(portal, /staff-attendance-ui\.css\?rev=4/,
  'management route must request the responsive attendance styles');
assert.match(attendanceUi, /classList\.add\('attendance-route'\)/,
  'attendance renderer must scope its route-specific shell styles');
assert.match(attendanceUi, /dispose\(\)\s*\{[^}]*classList\.remove\('attendance-route'\)/,
  'attendance renderer must remove its shell scope during disposal');
assert.match(attendanceCss, /@media\(max-width:900px\)\{body\.attendance-route \.portal-main\{[^}]*flex-basis:100%\}body\.attendance-route \.portal-app\{grid-template-columns:minmax\(0,1fr\)\}\}/,
  'the attendance workspace must take the full mobile width like the schedule route');
assert.match(attendanceCss, /body\.portal\.light-theme\.attendance-route \.portal-sidebar/,
  'light-theme shell corrections must be isolated to the attendance route');
assert.match(attendanceUi, /Отменить черновик и обновить[\s\S]*?window\.confirm/,
  'dirty forms must have an explicit confirmed discard path');
assert.match(attendanceUi, /content\.addEventListener\('input'/,
  'dirty tracking must be attached to the persistent content host once');
assert.match(attendanceUi, /openOverview\(\)[\s\S]*?hasUnsavedInput\(\)/,
  'same-hash management notification links open overview without discarding drafts');
assert.match(attendanceUi, /item\.plannedEnd \? Date\.parse\(item\.plannedEnd\) \+ 60 \* 60 \* 1000 : Date\.parse\(item\.startedAt\) \+ 16 \* 60 \* 60 \* 1000/,
  'overdue sessions use the frozen planned end or a 16-hour fallback');

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
assert.equal(hasStaffPermission('staff_schedule_self', managerPermissions), false,
  'a management role/profile without an explicit self-schedule grant must not see the employee link');
assert.equal(hasStaffPermission('staff_schedule_self', new Set(['staff_schedule_self'])), true,
  'the explicit self-schedule grant must make the actual nav item visible');
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
assert.equal(distPortal, portal, 'published portal loader must match its source');
assert.equal(distPortalSession, portalSession, 'published session gate must match its source');
assert.equal(distAttendanceUi, attendanceUi, 'published attendance UI must match its source');
assert.equal(distAttendanceCss, attendanceCss, 'published attendance styles must match their source');
assert.match(portal, /personal\.onload\s*=\s*\(\)\s*=>\s*selfOnly\s*\?\s*resolve\(\)\s*:\s*loadPlanning\(\)/,
  'self-only schedule access must load its personal view without waiting for management planning UI');
assert.match(portal, /staff-schedule-ui\.css\?rev=5/,
  'schedule CSS cache revision must be bumped with the latest visual styles');
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
