import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const portal = readFileSync(new URL('../portal.js', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const start = portal.indexOf("  if (path.startsWith('/api/dashboard/shift-kpis') && [");
const end = portal.indexOf("  if (path.startsWith('/api/dashboard/shift-kpis'))", start + 1);
assert.ok(start >= 0 && end > start, 'demo employee KPI branch exists before management branch');
const actor = { id: 'employee-a', role: 'bartender' };
const venue = { id: 'venue-a', timezone: 'Asia/Yekaterinburg' };
const now = new Date();
const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
const orders = [
  { venueId: venue.id, openedById: actor.id, status: 'closed', closedAt: now.toISOString(), payments: [
    { method: 'cash', amount: 40, status: 'paid', createdAt: yesterday.toISOString(), shiftId: 'prior-day-shift' },
    { method: 'card', amount: 60, status: 'paid', createdAt: now.toISOString(), shiftId: 'prior-day-shift' },
  ] },
  { venueId: venue.id, openedById: 'employee-b', status: 'closed', closedAt: now.toISOString(), payments: [{ method: 'cash', amount: 70, status: 'paid', createdAt: now.toISOString() }] },
  { venueId: 'venue-b', openedById: actor.id, status: 'closed', closedAt: now.toISOString(), payments: [{ method: 'cash', amount: 90, status: 'paid', createdAt: now.toISOString() }] },
];
const employeePermissions = new Set(['orders', 'finance_read']);
const hasPortalPermission = (permission) => permission === 'dashboard' || employeePermissions.has(permission);
const hasPermissions = (permissions, permission) => permission === 'dashboard' || permissions.has(permission);
const run = new Function('portalUser', 'demoSelectedVenue', 'demoReadOrders', 'window', 'hasPortalPermission',
  `return (url) => { const path = new URL(url, window.location.origin).pathname;\n${portal.slice(start, end)}\n};`
)(actor, () => venue, () => orders, { location: { origin: 'http://localhost' } }, hasPortalPermission);

const result = run('/api/dashboard/shift-kpis?date=1999-01-01&shiftId=prior-day-shift');
assert.equal(result.employeeView, true);
assert.equal(result.totals.revenue, 60, 'today includes only own post-midnight payment in selected venue');
assert.equal(result.totals.paymentCount, 1);
assert.equal(result.totals.closedOrders, 1);
assert.equal(result.totals.cashless, 60);
assert.equal(result.selectedShiftId, null, 'employee cannot choose historical shift');
assert.deepEqual(result.shifts, [{ id: 'employee-today' }], 'employee sees no shift identity or times');
const financeStart = portal.indexOf("  if (path === '/api/finance/summary' && [");
const financeEnd = portal.indexOf("  if (path === '/api/finance/summary')", financeStart + 1);
assert.ok(financeStart >= 0 && financeEnd > financeStart, 'demo employee finance branch exists before management branch');
const financeRun = new Function('portalUser', 'demoSelectedVenue', 'demoReadOrders', 'window',
  `return (url) => { const path = new URL(url, window.location.origin).pathname;\n${portal.slice(financeStart, financeEnd)}\n};`
)(actor, () => venue, () => orders, { location: { origin: 'http://localhost' } });
const financeResult = financeRun('/api/finance/summary?date=1999-01-01');
assert.equal(financeResult.revenue, 60, 'employee finance headline equals own payments made today');
assert.equal(financeResult.employeeView, true);
assert.equal(financeResult.byPaymentMethod, undefined, 'no venue-wide breakdown is exposed');
const metricsStart = portal.indexOf("   if (path === '/api/metrics')");
const metricsEnd = portal.indexOf("  if (path === '/api/analytics')", metricsStart + 1);
assert.ok(metricsStart >= 0 && metricsEnd > metricsStart, 'demo metrics branch exists');
const metricsBranch = new Function('portalUser', 'portalPermissions', 'hasPortalPermission', 'demoPendingSummary', 'demoReadOrders', 'demoState', 'localDateKey', 'path',
  `${portal.slice(metricsStart, metricsEnd)}\nreturn null;`);
const employeeMetricPermissions = new Set(['orders', 'finance_read']);
const employeeMetrics = metricsBranch(actor, employeeMetricPermissions, (permission) => permission === 'dashboard' || employeeMetricPermissions.has(permission), () => ({ pendingOrders: 2, pendingRevenue: 900 }), () => orders, {}, () => '2026-09-30', '/api/metrics');
assert.deepEqual(employeeMetrics, { employeeView: true, openOrders: 2, pendingOrders: 2 }, 'operational demo metrics exclude venue-wide revenue and discounts');
const scopedPermissions = new Set(['reservations']);
const scopedMetrics = metricsBranch({ role: 'admin' }, scopedPermissions, (permission) => permission === 'dashboard' || scopedPermissions.has(permission), () => ({ pendingOrders: 2, pendingRevenue: 900 }), () => orders, { reservations: [{ status: 'confirmed', date: '2026-09-30' }] }, () => '2026-09-30', '/api/metrics');
assert.deepEqual(scopedMetrics, { reservationsToday: 1 }, 'scoped demo metrics expose only the allowed module');
const shiftStart = portal.indexOf("  if (path === '/api/shifts' && method === 'GET')");
const shiftEnd = portal.indexOf("  if (path === '/api/", shiftStart + 1);
assert.ok(shiftStart >= 0 && shiftEnd > shiftStart, 'demo shift read branch exists');
const shiftBranch = new Function('portalUser', 'portalPermissions', 'hasPortalPermission', 'demoState', 'path', 'method',
  `${portal.slice(shiftStart, shiftEnd)}\nreturn null;`);
const demoShift = { id: 'demo-shift', openedAt: '2026-09-30T07:00:00Z', closedAt: null, openingCash: 120, closingCash: 300, expectedCash: 290 };
const shiftPermissions = new Set(['orders', 'floor', 'finance_read']);
assert.deepEqual(shiftBranch(actor, shiftPermissions, (permission) => hasPermissions(shiftPermissions, permission), { shift: demoShift }, '/api/shifts', 'GET').current,
  { id: demoShift.id, openedAt: demoShift.openedAt, closedAt: null, openingCash: 120 }, 'operational demo shift excludes reconciliation despite finance_read');
const adminShiftPermissions = new Set(['orders', 'floor']);
assert.deepEqual(shiftBranch({ role: 'admin' }, adminShiftPermissions, (permission) => hasPermissions(adminShiftPermissions, permission), { shift: demoShift }, '/api/shifts', 'GET').current,
  { id: demoShift.id, openedAt: demoShift.openedAt, closedAt: null, openingCash: 120 }, 'orders-only admin sees operational shift state');
const settingsPermissions = new Set(['settings']);
assert.throws(() => shiftBranch({ role: 'admin' }, settingsPermissions, (permission) => hasPermissions(settingsPermissions, permission), { shift: demoShift }, '/api/shifts', 'GET'), /403/, 'settings-only admin cannot read shift');
const notificationStart = portal.indexOf('  const demoNotificationReadPath =');
const notificationEnd = portal.indexOf('  const discountDecision =', notificationStart + 1);
assert.ok(notificationStart >= 0 && notificationEnd > notificationStart, 'demo notification branch exists');
const notificationBranch = new Function('portalUser', 'portalPermissions', 'hasPortalPermission', 'localStorage', 'demoSelectedVenue', 'demoState', 'url', 'window', 'path', 'method',
  `${portal.slice(notificationStart, notificationEnd)}\nreturn null;`);
const notificationRecords = [
  { id: 'inventory', venueId: 'demo-venue-territory', type: 'inventory_auto_order', totalEstimate: 123, notificationRecipients: ['admin'] },
  { id: 'deleted', venueId: 'demo-venue-territory', type: 'order_deleted', totalCost: 456, deletedItems: [{ unitCost: 456 }], notificationRecipients: ['admin'] },
  { id: 'staff', venueId: 'demo-venue-territory', type: 'staff_pin_updated', staffName: 'QA', notificationRecipients: ['admin'] },
];
const notificationStorage = { getItem: (key) => key === 'territory_crm_staff_notifications' ? JSON.stringify(notificationRecords) : null };
const defaultVenue = { id: 'demo-venue-territory' };
const notificationDemo = { inventoryAutoOrders: [{ id:'inventory',venueId:defaultVenue.id,status:'sent' }], discounts:[] };
const readNotices = (user, permissions, storage, selectedVenue) => notificationBranch(user, permissions, (permission) => hasPermissions(permissions, permission), storage, () => selectedVenue, notificationDemo, '/api/notifications', {location:{origin:'http://localhost'}}, '/api/notifications', 'GET');
const readDefaultNotices = (user, permissions, storage = notificationStorage) => readNotices(user, permissions, storage, defaultVenue);
assert.throws(() => readDefaultNotices({ role: 'admin' }, new Set(['settings'])), /403/, 'settings-only demo notifications are forbidden');
assert.throws(() => readDefaultNotices(actor, new Set(['orders', 'finance_read'])), /403/, 'operational demo user cannot read manager notifications');
assert.deepEqual(readDefaultNotices({ role: 'admin' }, new Set(['inventory_read'])).items.map((item) => item.id), ['inventory_auto_order:inventory'], 'inventory-only demo receives only stock event');
const orderNotice = readDefaultNotices({ role: 'admin' }, new Set(['orders'])).items;
assert.deepEqual(orderNotice.map((item) => item.id), ['order_deleted:deleted'], 'orders-only demo receives only deletion event');
assert.equal(Object.hasOwn(orderNotice[0], 'totalCost'), false, 'orders-only demo deletion hides cost');
assert.equal(Object.hasOwn(orderNotice[0], 'deletedItems'), false, 'orders-only demo deletion hides item costs');
const twoVenueStorage = { getItem: key => key === 'territory_crm_staff_notifications' ? JSON.stringify([{ id: 'first', venueId: defaultVenue.id, type: 'order_deleted', notificationRecipients: ['admin'] }, { id: 'second', venueId: 'venue-two', type: 'order_deleted', notificationRecipients: ['admin'] }]) : null };
assert.deepEqual(readDefaultNotices({ role: 'admin' }, new Set(['orders']), twoVenueStorage).items.map((item) => item.id), ['order_deleted:first'], 'default demo venue excludes another venue event');
assert.deepEqual(readNotices({ role: 'admin' }, new Set(['orders']), twoVenueStorage, { id:'venue-two' }).items.map((item) => item.id), ['order_deleted:second'], 'second demo venue excludes default venue event');
assert.deepEqual(readDefaultNotices({ role: 'admin' }, new Set(['orders']), { getItem: key => key === 'territory_crm_staff_notifications' ? JSON.stringify([{ id: 'legacy', type: 'order_deleted', notificationRecipients: ['admin'] }]) : null }).items, [], 'untagged legacy event is hidden when its venue cannot be proven');
const staffStart = portal.indexOf("  if (path === '/api/staff' && method === 'GET')");
const staffEnd = portal.indexOf("  if (path === '/api/staff' && method === 'POST')", staffStart + 1);
assert.ok(staffStart >= 0 && staffEnd > staffStart, 'demo staff permission branch exists');
const staffBranch = new Function('portalPermissions', 'hasPortalPermission', 'demoState', 'demoStaffPublic', 'path', 'method',
  `${portal.slice(staffStart, staffEnd)}\nreturn null;`);
const financeReadPermissions = new Set(['finance_read']);
assert.throws(() => staffBranch(financeReadPermissions, (permission) => hasPermissions(financeReadPermissions, permission), { staff: [{ id: 'private' }] }, (person) => person, '/api/staff', 'GET'), /HTTP 403/, 'employee cannot read demo staff directory');
const staffViewPermissions = new Set(['staff_view']);
assert.deepEqual(staffBranch(staffViewPermissions, (permission) => hasPermissions(staffViewPermissions, permission), { staff: [{ id: 'visible' }] }, (person) => person, '/api/staff', 'GET'), { items: [{ id: 'visible' }] }, 'authorized directory remains available');
console.log('DASHBOARD OVERNIGHT EMPLOYEE DEMO QA: PASS (current venue/day, own payments, aligned finance headline, masked shift and tampered filters)');
