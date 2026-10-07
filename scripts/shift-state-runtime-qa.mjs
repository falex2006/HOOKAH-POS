import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const staff = fs.readFileSync('app.js', 'utf8');
const portal = fs.readFileSync('portal.js', 'utf8');
const storage = new Map([['crm_session_user', JSON.stringify({ id: 'qa', venueId: 'venue-territory' })]]);
const staticContext = {
  Promise, Date, Number, JSON, Math, Error,
  localStorage: { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
  staticStaffDemo: () => true,
  window: { HOOKAH_SHIFT_CLOSE: { checklistVersion: 1, checklistItems: [{ id: 'ordersReviewed' }, { id: 'cashCounted' }, { id: 'inventoryReviewed' }, { id: 'externalFiscalReportsHandled' }], validateChecklist: (value) => Boolean(value?.version === 1 && value?.items?.ordersReviewed && value?.items?.cashCounted && value?.items?.inventoryReviewed && value?.items?.externalFiscalReportsHandled), freezeChecklist: (value, actorId, confirmedAt) => ({ version: 1, items: Object.entries(value.items).map(([id]) => ({ id, checked: true, checkedBy: actorId, checkedAt: confirmedAt })) }) }, },
};
const staticStart = staff.indexOf('const validStaticShiftCash=');
const staticEnd = staff.indexOf('const shiftCloseFailureMessage=', staticStart);
assert.ok(staticStart >= 0 && staticEnd > staticStart);
vm.runInNewContext(`${staff.slice(staticStart, staticEnd)};this.shiftApi=shiftApi;`, staticContext);
const demo = staticContext.shiftApi;
assert.equal((await demo()).current, null);
const opened = await demo({ method: 'POST', body: JSON.stringify({ openingCash: 0 }) });
assert.equal((await demo()).current.id, opened.id);
await assert.rejects(demo({ method: 'POST', body: JSON.stringify({ openingCash: 0 }) }), /shift_already_open/);
const closePath = `/api/shifts/${opened.id}/close`;
await assert.rejects(demo({ method: 'POST', url: closePath, body: JSON.stringify({ closingCash: 0 }) }), /shift_checklist_required/);
await demo({ method: 'POST', url: closePath, body: JSON.stringify({ closingCash: 0, checklist: { version: 1, items: { ordersReviewed: true, cashCounted: true, inventoryReviewed: true, externalFiscalReportsHandled: true } } }) });
assert.equal((await demo()).current, null, 'closed static fixture is never current');
await assert.rejects(demo({ method: 'POST', url: closePath, body: JSON.stringify({ closingCash: 0, checklist: { version: 1, items: { ordersReviewed: true, cashCounted: true, inventoryReviewed: true, externalFiscalReportsHandled: true } } }) }), /shift_not_found_or_closed/);
for (const amount of [null, true, [], {}, -1, 0.001, 100000001]) {
  await assert.rejects(demo({ method: 'POST', body: JSON.stringify({ openingCash: amount }) }), /opening_cash_required/);
}
const demoEvents = JSON.parse(storage.get('territory_crm_shift_events'));
assert.deepEqual(demoEvents.map((e) => e.action), ['shift.opened', 'shift.closed']);
assert.equal(new Set(demoEvents.map((e) => e.id)).size, 2);
assert.ok(demoEvents.every((e) => e.venueId === 'venue-territory' && !('openingCash' in e)));

staticContext.URL = URL;
staticContext.location = { origin: 'http://localhost' };
const notificationStart = staff.indexOf('const staticShiftNotificationsApi=');
vm.runInNewContext(`${staff.slice(notificationStart, staticStart)};this.notifications=staticShiftNotificationsApi;`, staticContext);
let inbox = await staticContext.notifications('/api/notifications');
assert.equal(inbox.unreadCount, 2);
assert.ok(inbox.items.every(item => !('openingCash' in item) && !('closingCash' in item)));
await staticContext.notifications(`/api/notifications/${encodeURIComponent(inbox.items[0].id)}/read`, { method: 'PUT' });
assert.equal((await staticContext.notifications('/api/notifications?filter=unread')).items.length, 1);
storage.set('crm_session_user', JSON.stringify({ id: 'other-user', venueId: 'venue-territory' }));
assert.equal((await staticContext.notifications('/api/notifications')).unreadCount, 2, 'read receipts are per user');
await staticContext.notifications('/api/notifications', { method: 'POST' });
assert.equal((await staticContext.notifications('/api/notifications')).unreadCount, 0);
storage.set('crm_session_user', JSON.stringify({ id: 'qa', venueId: 'other-venue' }));
assert.equal((await staticContext.notifications('/api/notifications')).items.length, 0, 'inbox is per venue');
await assert.rejects(staticContext.notifications(`/api/notifications/${encodeURIComponent(inbox.items[0].id)}/read`, { method: 'PUT' }), /notification_not_found/);

const header = { dataset: {}, classList: { toggle() {} } };
let current = null, responseGate, failed = false, invalid = false, reads = 0;
const windowEvents = {}, documentEvents = {}, timers = [];
const document = { visibilityState: 'visible', querySelector: () => header, addEventListener: (type, callback) => { documentEvents[type] = callback; } };
const management = {
  Promise, Boolean, String, Object, Error, AbortSignal,
  document,
  portalPermissions: new Set(['floor']),
  window: { setInterval: (callback, delay) => { timers.push({ callback, delay }); }, addEventListener: (type, callback) => { windowEvents[type] = callback; } },
  api: async (url, options) => {
    assert.equal(url, '/api/shifts'); assert.equal(options, undefined, 'shift status read does not pass an invalid fetch signal');
    reads++;
    if (responseGate) await new Promise((resolve) => { responseGate = resolve; });
    if (failed) throw Error('unavailable');
    return invalid ? {} : { current, items: current ? [current] : [] };
  },
};
const start = portal.indexOf('const portalShiftListeners =');
const end = portal.indexOf('let portalContextGeneration =', start);
assert.ok(start >= 0 && end > start);
vm.runInNewContext(`${portal.slice(start, end)};this.contract={refreshPortalShiftState,publishPortalShift,portalShiftListeners};this.setPending=value=>portalShiftActionPending=value;`, management);
const { refreshPortalShiftState: refresh, portalShiftListeners: listeners } = management.contract;
const subscriberStates = [];
listeners.add((data, error) => subscriberStates.push(error ? 'error' : data.current ? 'open' : 'closed'));
responseGate = true;
const first = refresh(), duplicate = refresh();
assert.equal(first, duplicate, 'only one pending shift read'); assert.equal(reads, 1);
responseGate(); responseGate = null; await first;
assert.equal(header.dataset.shiftState, 'closed'); assert.equal(subscriberStates.at(-1), 'closed');
current = { id: 'qa-shift', openedByName: 'QA Manager' };
await refresh(); assert.equal(header.dataset.shiftState, 'open'); assert.match(header.textContent, /QA Manager/);
assert.equal(subscriberStates.at(-1), 'open');
failed = true; await refresh(); assert.equal(header.dataset.shiftState, 'error'); assert.equal(subscriberStates.at(-1), 'error');
failed = false; invalid = true; await refresh(); assert.equal(header.dataset.shiftState, 'error');
invalid = false; current = null; await refresh(); assert.equal(header.dataset.shiftState, 'closed');
assert.equal(timers[0].delay, 20000);
const before = reads;
document.visibilityState = 'hidden'; timers[0].callback(); assert.equal(reads, before, 'hidden tabs do not poll');
document.visibilityState = 'visible'; management.setPending(true); windowEvents.focus(); assert.equal(reads, before, 'form/mutation skips polling');
management.setPending(false); documentEvents.visibilitychange(); await refresh(); assert.equal(reads, before + 1, 'returning to tab rechecks actual state');
management.portalPermissions.clear(); await refresh(); assert.equal(reads, before + 1, 'no shift permission means no request');
assert.match(portal, /portalShiftListeners\.add\(\(data,error\)=>\{if\(error\)return;const key=JSON\.stringify/,
  'dashboard shift KPIs subscribe to transition fingerprints');
assert.match(portal, /api\(`\/api\/finance\/summary[^\n]+refreshPortalShiftState\(\)/,
  'finance load uses the shared shift reader');
assert.equal(fs.readFileSync('dist/app.js', 'utf8').replaceAll('\r\n', '\n'), staff.replaceAll('\r\n', '\n'));
assert.equal(fs.readFileSync('dist/portal.js', 'utf8').replaceAll('\r\n', '\n'), portal.replaceAll('\r\n', '\n'));
console.log('SHIFT STATE RUNTIME QA: PASS (closed demo, stable transitions, shared header/panels, errors, deduplication, visibility/action guards, permissions, dist parity)');
