import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const reservePort = async () => {
  const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const { port } = server.address(); await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); return port;
};
const port = await reservePort();
const child = spawn(process.execPath, ['server.js'], {
  cwd: fileURLToPath(new URL('../', import.meta.url)), windowsHide: true,
  env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DATABASE_URL: '', AUTH_REQUIRED: 'true', DEMO_ADMIN_PASSWORD: 'admin', DEMO_OWNER_PASSWORD: 'demo', DEMO_STAFF_PASSWORD: 'demo' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const baseUrl = `http://127.0.0.1:${port}`;
let output = '';
child.stdout.on('data', (chunk) => { output += chunk.toString(); });
child.stderr.on('data', (chunk) => { output += chunk.toString(); });
const request = async (path, { method = 'GET', token, cookieToken, body } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(cookieToken ? { Cookie: `crm_session=${encodeURIComponent(cookieToken)}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const payload = await response.json().catch(() => ({})); return { status: response.status, payload };
};
const login = async (username, password) => {
  const result = await request('/api/login', { method: 'POST', body: { username, password } });
  assert.equal(result.status, 200, `${username} login`); return result.payload.token;
};
let floorZoneId = null;
let floorVenueId = null;
const createTable = async (token, label) => {
  const floor = await request('/api/floor', { token });
  assert.equal(floor.status, 200, `floor lookup: ${floor.payload.error || floor.status}`);
  if (!floorZoneId || floorVenueId !== floor.payload.venueId) {
    floorVenueId = floor.payload.venueId;
    floorZoneId = floor.payload.zones?.[0]?.id || null;
    if (!floorZoneId) {
      const zone = await request('/api/floor/zones', { method: 'POST', token, body: { name: `QA ${Date.now()}`, expectedVenueId: floorVenueId } });
      assert.equal(zone.status, 201, `floor zone creation: ${zone.payload.error || zone.status}`);
      floorZoneId = zone.payload.id;
    }
  }
  const table = await request('/api/floor/tables', { method: 'POST', token, body: { zoneId: floorZoneId, expectedVenueId: floorVenueId, name: `QA ${label} ${Date.now()} ${Math.random().toString(36).slice(2, 7)}`, capacity: 2 } });
  assert.equal(table.status, 201, `floor table creation: ${table.payload.error || table.status}`);
  return table.payload.id;
};
try {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`CRM startup timed out: ${output}`)), 10_000);
    const ready = (chunk) => { if (String(chunk).includes('CRM running on')) { clearTimeout(timeout); child.stdout.off('data', ready); resolve(); } };
    child.stdout.on('data', ready); child.once('error', reject); child.once('exit', (code) => reject(new Error(`CRM exited (${code}): ${output}`)));
  });
  const owner = await login('owner', 'demo');
  const admin = await login('admin', 'admin');
  const staff = await login('staff', 'demo');
  const managerCreated = await request('/api/staff', { method: 'POST', token: owner, body: { name: 'Notification QA manager', role: 'manager', login: 'notification_manager', password: 'demo', birthDate: '1990-01-01' } });
  assert.equal(managerCreated.status, 201, JSON.stringify(managerCreated.payload));
  const manager = await login('notification_manager', 'demo');
  const scopedAdmin = async (loginName, permissionScopes) => {
    const result = await request('/api/staff', { method: 'POST', token: owner, body: { name: `QA ${loginName}`, role: 'admin', login: loginName, password: 'demo', birthDate: '1990-01-01', permissionScopes } });
    assert.equal(result.status, 201, `${loginName} admin creation: ${JSON.stringify(result.payload)}`);
    return login(loginName, 'demo');
  };
  const settingsAdmin = await scopedAdmin('notification_settings_admin', ['settings']);
  const ordersAdmin = await scopedAdmin('notification_orders_admin', ['orders']);
  const inventoryAdmin = await scopedAdmin('notification_inventory_admin', ['inventory']);
  assert.equal((await request('/api/notifications', { token: settingsAdmin })).status, 403, 'settings-only admin has no notification source permission');
  assert.equal((await request('/api/orders', { token: settingsAdmin })).status, 403, 'target orders API rejects a user without orders permission');

  const created = await request('/api/orders', { method: 'POST', token: owner, body: { tableId: await createTable(owner, 'notification-first') } });
  assert.equal(created.status, 201, `first order: ${created.payload.error || created.status}`);
  const deleted = await request(`/api/orders/${encodeURIComponent(created.payload.id)}`, { method: 'DELETE', token: owner, body: { comment: 'Notification QA', writeoff: false } });
  assert.equal(deleted.status, 200);
  const deletedBusinessStatus = (await request('/api/orders', { token: owner })).payload.items.find((item) => item.id === created.payload.id)?.status;
  assert.equal(deletedBusinessStatus, deleted.payload.status, 'notification read workflow starts with the source object status unchanged');

  const ownerFeed = await request('/api/notifications?limit=20', { token: owner });
  assert.equal(ownerFeed.status, 200); assert.equal(ownerFeed.payload.unreadCount, 1);
  const event = ownerFeed.payload.items.find((item) => item.type === 'order_deleted');
  assert.ok(event); assert.equal(event.readAt, null); assert.equal(event.href, '/orders');
  assert.equal('totalCost' in event, false); assert.equal('deletedItems' in event, false);
  const repeated = await request('/api/notifications?limit=20', { token: owner });
  assert.deepEqual(repeated.payload.items.map((item) => item.id), ownerFeed.payload.items.map((item) => item.id), 'polling preserves stable unique event IDs');
  assert.equal(repeated.payload.unreadCount, 1);
  assert.equal(new Set(repeated.payload.items.map((item) => item.id)).size, repeated.payload.items.length, 'polling does not duplicate event IDs');
  assert.equal((await request('/api/notifications', { token: ordersAdmin })).payload.items.some((item) => item.id === event.id), true, 'orders-only admin sees only its permitted event source');
  assert.equal((await request('/api/orders', { token: ordersAdmin })).status, 200, 'event target API remains permission checked for an authorized orders-only admin');
  const inventoryFeed = await request('/api/notifications', { token: inventoryAdmin });
  assert.equal(inventoryFeed.status, 200); assert.equal(inventoryFeed.payload.items.some((item) => item.id === event.id), false, 'inventory-only admin does not see order events');
  const ignoredVenueOverride = await request('/api/notifications?venueId=foreign-venue', { token: owner });
  assert.equal(ignoredVenueOverride.payload.items[0].id, event.id, 'client venue query cannot alter session venue scope');

  const adminIndependent = await request('/api/notifications?limit=20', { token: admin });
  assert.equal(adminIndependent.payload.unreadCount, 1, 'another user has an independent unread receipt');
  const forgedSingleRead = await request(`/api/notifications/${encodeURIComponent(event.id)}/read`, { method: 'PUT', token: admin, body: { userId: 'forged-owner', venueId: 'forged-venue' } });
  assert.equal(forgedSingleRead.status, 200);
  assert.equal((await request('/api/notifications', { token: admin })).payload.unreadCount, 0, 'single-read is bound to authenticated admin, ignoring body identity');
  assert.equal((await request('/api/notifications', { token: owner })).payload.items.find((item) => item.id === event.id).readAt, null, 'forged single-read cannot change owner receipt');

  const markOwnerRead = await request(`/api/notifications/${encodeURIComponent(event.id)}/read`, { method: 'PUT', token: owner });
  assert.equal(markOwnerRead.status, 200); assert.equal(markOwnerRead.payload.unreadCount, 0);
  const ownerAfterRead = await request('/api/notifications?limit=20', { token: owner });
  assert.equal(ownerAfterRead.payload.items.find((item) => item.id === event.id).readAt !== null, true, 'read state survives another GET');
  assert.equal((await request('/api/orders', { token: owner })).payload.items.find((item) => item.id === created.payload.id)?.status, deletedBusinessStatus, 'marking notification read does not change the business object status');
  assert.equal((await request('/api/orders', { token: owner })).payload.items.find((item) => item.id === created.payload.id)?.status, deletedBusinessStatus, 'marking notification read does not change the business object status');
  const ownerFirstVenueReadAt = ownerAfterRead.payload.items.find((item) => item.id === event.id).readAt;
  const managerIndependent = await request('/api/notifications?limit=20', { token: manager });
  assert.equal(managerIndependent.status, 200); assert.equal(managerIndependent.payload.unreadCount, 1, 'manager with orders and inventory permissions receives the event independently');

  const venuesBefore = await request('/api/network/venues', { token: owner });
  assert.equal(venuesBefore.status, 200);
  const defaultVenue = venuesBefore.payload.items.find((item) => item.isCurrent);
  assert.ok(defaultVenue, 'owner starts in a selected venue');
  const otherOwnerSession = await login('owner', 'demo');
  const otherOwnerInitialVenueId = (await request('/api/session', { token: otherOwnerSession })).payload.user.venueId;
  const archivedVenue = await request('/api/network/venues', { method: 'POST', token: owner, body: { name: 'Notification QA archived venue', city: 'Тюмень', address: 'QA archived' } });
  assert.equal(archivedVenue.status, 201);
  assert.equal((await request(`/api/network/venues/${archivedVenue.payload.id}`, { method: 'DELETE', token: owner })).status, 200);
  const secondVenue = await request('/api/network/venues', { method: 'POST', token: owner, body: { name: 'Notification QA second venue', city: 'Тюмень', address: 'QA street 2' } });
  assert.equal(secondVenue.status, 201, `second venue creation: ${JSON.stringify(secondVenue.payload)}`);
  const switchVenue = async (venueId, useCookie = false) => {
    const auth = useCookie ? { cookieToken: owner } : { token: owner };
    const switched = await request(`/api/network/venues/${encodeURIComponent(venueId)}/select`, { method: 'POST', ...auth });
    assert.equal(switched.status, 200, `venue switch to ${venueId}`);
    assert.equal((await request('/api/session', auth)).payload.user.venueId, venueId, 'selected venue survives a fresh authenticated request');
  };
  await switchVenue(secondVenue.payload.id, true);
  assert.equal((await request('/api/session', { token: otherOwnerSession })).payload.user.venueId, otherOwnerInitialVenueId, 'another token of the same owner retains its selected venue');
  assert.ok((await request('/api/notifications', { token: otherOwnerSession })).payload.items.some((item) => item.id === event.id), 'same-owner second session still sees first-venue events');
  for (const rejectedId of [archivedVenue.payload.id, 'unknown-notification-venue']) {
    assert.equal((await request(`/api/network/venues/${rejectedId}/select`, { method: 'POST', token: owner })).status, 404);
    assert.equal((await request('/api/session', { token: owner })).payload.user.venueId, secondVenue.payload.id, 'rejected selection preserves session venue');
  }
  assert.equal((await request(`/api/network/venues/${secondVenue.payload.id}/select`, { method: 'POST', token: staff })).status, 403, 'staff cannot switch venue without settings permission');
  assert.equal((await request('/api/notifications', { method: 'POST', token: owner, body: { venueId: defaultVenue.id } })).status, 200, 'read-all uses selected venue despite a forged body');
  const secondVenueEmpty = await request('/api/notifications?venueId=00000000-0000-0000-0000-000000000001', { token: owner });
  assert.equal(secondVenueEmpty.status, 200);
  assert.equal(secondVenueEmpty.payload.items.some((item) => item.id === event.id), false, 'authenticated venue context excludes first-venue events even when client query forges venueId');
  const crossVenueRead = await request(`/api/notifications/${encodeURIComponent(event.id)}/read`, { method: 'PUT', token: owner });
  assert.equal(crossVenueRead.status, 404, 'event ID from another venue cannot be marked read');
  const secondOrder = await request('/api/orders', { method: 'POST', token: owner, body: { tableId: await createTable(owner, 'notification-second-venue') } });
  assert.equal(secondOrder.status, 201, `second venue order: ${JSON.stringify(secondOrder.payload)}`);
  const secondDeleted = await request(`/api/orders/${encodeURIComponent(secondOrder.payload.id)}`, { method: 'DELETE', token: owner, body: { comment: 'Notification QA second venue', writeoff: false } });
  assert.equal(secondDeleted.status, 200);
  const secondVenueEvent = (await request('/api/notifications', { token: owner })).payload.items.find((item) => item.type === 'order_deleted');
  assert.ok(secondVenueEvent); assert.notEqual(secondVenueEvent.id, event.id);
  assert.equal((await request('/api/notifications', { token: otherOwnerSession })).payload.items.some((item) => item.id === secondVenueEvent.id), false, 'same-user other token does not inherit the switched venue');
  const secondVenueRead = await request(`/api/notifications/${encodeURIComponent(secondVenueEvent.id)}/read`, { method: 'PUT', token: owner });
  assert.equal(secondVenueRead.status, 200);
  assert.equal((await request('/api/notifications', { token: admin })).payload.items.some((item) => item.id === secondVenueEvent.id), false, 'a second user still has only its own venue context');
  assert.equal((await request(`/api/notifications/${encodeURIComponent(secondVenueEvent.id)}/read`, { method: 'PUT', token: admin })).status, 404, 'another user cannot mark a foreign-venue event read');
  await switchVenue(defaultVenue.id);
  const firstVenueAgain = await request('/api/notifications', { token: owner });
  assert.equal(firstVenueAgain.payload.items.find((item) => item.id === event.id)?.readAt, ownerFirstVenueReadAt, 'receipt in second venue does not change the first-venue receipt');
  await switchVenue(secondVenue.payload.id);
  assert.ok((await request('/api/notifications', { token: owner })).payload.items.find((item) => item.id === secondVenueEvent.id)?.readAt, 'receipt remains attached to the same user and second venue');
  await switchVenue(defaultVenue.id);

  const invalidRead = await request('/api/notifications/order_deleted%3Aforeign-event/read', { method: 'PUT', token: owner });
  assert.equal(invalidRead.status, 404, 'unknown event IDs cannot be marked read');
  const staffFeed = await request('/api/notifications', { token: staff });
  assert.equal(staffFeed.status, 403, 'operational employee cannot read the management inbox');
  const markAll = await request('/api/notifications', { method: 'POST', token: admin, body: { userId: 'forged-user', venueId: 'forged-venue' } });
  assert.equal(markAll.status, 200); assert.equal(markAll.payload.unreadCount, 0);
  assert.equal((await request('/api/notifications', { token: admin })).payload.unreadCount, 0, 'mark all persists across reads');
  assert.equal((await request('/api/notifications', { token: owner })).payload.unreadCount, 0, 'marking all as another user does not change owner state');
  console.log('NOTIFICATIONS API QA: owner, scoped admins, manager, employee denial, two-venue event/read isolation, safe DTO, stable IDs, per-user receipts, read-all, and unknown IDs passed');
} finally {
  child.kill('SIGTERM');
}
