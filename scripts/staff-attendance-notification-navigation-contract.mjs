import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
const notification = read('../notification-center.js');
const portalNotification = read('../portal.js');
const app = read('../app.js');
const attendance = read('../staff-attendance-ui.js');
const routes = read('../portal-session.js');
const map = JSON.parse(read('../site-map.json'));

assert.equal(read('../dist/notification-center.js'), notification);
assert.equal(read('../dist/portal.js'), portalNotification);
assert.equal(read('../dist/app.js'), app);
assert.equal(read('../dist/staff-attendance-ui.js'), attendance);
assert.equal(read('../dist/portal-session.js'), routes);
assert.match(notification, /attendanceTypes = new Set\(\['attendance_request','attendance_decision','attendance_expired','attendance_overdue','attendance_closed','attendance_warning'\]\)/);
assert.match(notification, /hasAttendancePermission[\s\S]*?attendanceOnly = hasAttendancePermission && !hasNotificationPermission/);
assert.match(notification, /!attendanceOnly \|\| attendanceTypes\.has\(item\.type\)/,
  'attendance-only bell must filter category rows while preserving the server-authoritative unread count');
assert.match(notification, /allowedNotificationHrefs[\s\S]*?\/admin#staff-attendance[\s\S]*?\/#staff-attendance/);
assert.match(notification, /closeNotificationPanel\(false\)[\s\S]*?staff-attendance:open-self[\s\S]*?staff-attendance:open-management/);
assert.match(portalNotification, /closeNotificationPanel\(false\)[\s\S]*?staff-attendance:open-management/,
  'management bell same-hash clicks close the panel and dispatch the overview action');
assert.match(notification, /staff-attendance:changed[\s\S]*?loadNotifications\(false\)/,
  'successful attendance mutations refresh the notification bell');
assert.match(app, /openSelfAttendanceDeepLink[\s\S]*?staff-attendance:open-self/);
assert.match(attendance, /openOverview\(\)[\s\S]*?hasUnsavedInput\(\)[\s\S]*?renderManagement\(\)/);
assert.match(attendance, /data-session-close/);
assert.match(attendance, /name="confirm" required/);
assert.match(attendance, /Недавние выходы вне планового окна[\s\S]*?item\.startReason/,
  'management overview retains recent outside-schedule basis and explanation for notification follow-through');
assert.match(attendance, /focusedInForm[\s\S]*?details\[open\]/,
  '20-second polling must not interrupt focused form controls or expanded interactions');
assert.match(routes, /staff_attendance_close/);
assert.deepEqual(map.staffAttendancePresentation.managementPermissions,
  ['staff_attendance_policy_manage', 'staff_attendance_approval', 'staff_attendance_close']);
assert.equal(map.staffAttendancePresentation.defaultManagementView, 'daily-overview');
console.log('STAFF ATTENDANCE NOTIFICATION/NAVIGATION CONTRACT: PASS');
