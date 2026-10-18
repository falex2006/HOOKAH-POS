import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const portal = readFileSync(new URL('../portal.js', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const helperStart = portal.indexOf('const demoDiscountError =');
const helperEnd = portal.indexOf('\n', portal.indexOf('const demoDiscountCanRead =', helperStart));
const routeStart = portal.indexOf("  if (path === '/api/discount-groups' && method === 'GET')");
const routeEnd = portal.indexOf("  if (path === '/api/clients' && method === 'GET')", routeStart);
assert.ok(helperStart >= 0 && helperEnd > helperStart && routeStart >= 0 && routeEnd > routeStart);

const portalPermissions = new Set(['staff_manage']);
const demoDefaultVenue = { id: 'venue-a' };
const demoState = { networkCurrentId: null, discountGroups: [{ id: 'seed', name: 'Базовая', active: true, discountPercent: 0, bonusPercent: 0, depositMin: 0 }] };
let saves = 0;
const demoSave = () => { saves += 1; };
const window = { location: { origin: 'http://localhost' } };
const demoCall = new Function('portalPermissions', 'hasPortalPermission', 'demoState', 'demoDefaultVenue', 'window', 'demoSave',
  `${portal.slice(helperStart, helperEnd)}\nreturn async (url, options = {}) => { const path = new URL(url, window.location.origin).pathname; const method = options.method || 'GET'; const input = options.body ? JSON.parse(options.body) : {};\n${portal.slice(routeStart, routeEnd)}\n};`
)(portalPermissions, (permission) => permission === 'dashboard' || portalPermissions.has(permission), demoState, demoDefaultVenue, window, demoSave);
const call = (path, method = 'GET', body) => demoCall(path, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
const error = async (promise, code) => assert.rejects(promise, (failure) => failure.payload?.error === code);

const first = await call('/api/discount-groups', 'POST', { name: 'QA VIP', depositMin: 1.25 });
assert.equal(first.venueId, 'venue-a');
const second = await call('/api/discount-groups', 'POST', { name: 'QA Regular' });
const saved = saves;
await error(call('/api/discount-groups', 'POST', { name: '  qa vip  ' }), 'discount_group_name_exists');
await error(call(`/api/discount-groups/${second.id}`, 'PATCH', { name: 'qa vip' }), 'discount_group_name_exists');
await error(call('/api/discount-groups', 'POST', { name: 'Fractional cents', depositMin: 1.005 }), 'invalid_discount_group');
await error(call('/api/discount-groups', 'POST', { name: 'Too large', depositMin: 10_000_000_000 }), 'invalid_discount_group');
assert.equal(saves, saved, 'rejections do not persist state');
assert.equal(second.name, 'QA Regular');
await call(`/api/discount-groups/${first.id}`, 'PATCH', { active: false });
await error(call('/api/discount-groups', 'POST', { name: 'QA VIP' }), 'discount_group_name_exists');
assert.equal((await call('/api/discount-groups')).items.length, 2);
assert.equal((await call('/api/discount-groups?includeArchived=true')).items.length, 3);

demoState.networkCurrentId = 'venue-b';
assert.equal((await call('/api/discount-groups?includeArchived=true')).items.length, 0);
await error(call(`/api/discount-groups/${first.id}`, 'PATCH', { active: true }), 'discount_group_not_found');
const other = await call('/api/discount-groups', 'POST', { name: 'QA VIP' });
assert.equal(other.venueId, 'venue-b');
demoState.networkCurrentId = null;
assert.equal((await call('/api/discount-groups?includeArchived=true')).items.length, 3);

portalPermissions.clear(); portalPermissions.add('orders');
assert.equal((await call('/api/discount-groups')).items.length, 2);
await error(call('/api/discount-groups?includeArchived=true'), 'forbidden');
await error(call('/api/discount-groups', 'POST', { name: 'No access' }), 'forbidden');
portalPermissions.clear(); portalPermissions.add('finance');
assert.equal((await call('/api/discount-groups?includeArchived=true')).items.length, 3);
console.log('DISCOUNT GROUPS DEMO QA: PASS (duplicate, deposit, venue, permissions)');
