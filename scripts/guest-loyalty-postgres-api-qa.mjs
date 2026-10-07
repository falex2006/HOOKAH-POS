import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';

const databaseUrl = process.env.MIGRATIONS_PG_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('Set MIGRATIONS_PG_TEST_DATABASE_URL to an isolated PostgreSQL QA database');
assert.match(new URL(databaseUrl).pathname, /(?:test|qa|scratch)/i,
  'refusing test writes unless the database name clearly identifies a test/QA/scratch database');

const require = createRequire(import.meta.url);
const { Client, Pool } = require('pg');
const setup = new Client({ connectionString: databaseUrl });
const pool = new Pool({ connectionString: databaseUrl, max: 4 });
const server = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const groupStart = server.indexOf("if (pathname === '/api/discount-groups' && req.method === 'GET')");
const groupEnd = server.indexOf("if (pathname === '/api/clients' && req.method === 'GET')", groupStart);
const guestStart = server.indexOf("if (pathname === '/api/clients' && req.method === 'POST')");
const guestEnd = server.indexOf('const clientHistory = pathname.match', guestStart);
const guestListStart = server.indexOf("if (pathname === '/api/clients' && req.method === 'GET')");
const guestListEnd = server.indexOf('const clientArchive = pathname.match', guestListStart);
const loyaltyStart = server.indexOf('const clientLoyalty = pathname.match');
const loyaltyEnd = server.indexOf('const productImage = pathname.match', loyaltyStart);
const accountStart = server.indexOf('const clientAccountEntries = pathname.match');
const accountEnd = server.indexOf('const productImage = pathname.match', accountStart);
assert.ok(groupStart >= 0 && groupEnd > groupStart, 'discount group API handlers are present');
assert.ok(guestStart >= 0 && guestEnd > guestStart, 'guest create/update API handlers are present');
assert.ok(guestListStart >= 0 && guestListEnd > guestListStart, 'guest list API handler is present');
assert.ok(loyaltyStart >= 0 && loyaltyEnd > loyaltyStart, 'loyalty adjustment API handler is present');
assert.ok(accountStart >= 0 && accountEnd > accountStart, 'guest account ledger API handler is present');
const groupRoute = server.slice(groupStart, groupEnd);
const guestRoute = server.slice(guestStart, guestEnd);
const guestListRoute = server.slice(guestListStart, guestListEnd);
const loyaltyRoute = server.slice(loyaltyStart, loyaltyEnd);
const accountRoute = server.slice(accountStart, accountEnd);
const phoneNormalizer = server.match(/const normalizePhoneNumbers = .*?;\r?\n/)?.[0];
assert.ok(phoneNormalizer, 'production phone normalizer is available');
const normalizePhoneNumbers = new Function(`${phoneNormalizer}; return normalizePhoneNumbers;`)();

let venueId;
let otherVenueId;
let setupConnected = false;
const callApi = async ({ route, path, method = 'GET', body = {}, permissions = ['loyalty', 'staff_manage', 'orders'], venue = venueId }) => {
  let response;
  const pathname = new URL(`http://localhost${path}`).pathname;
  const json = (_res, status, data) => { response = { status, data }; return response; };
  const denyUnlessAny = (req, res, required) => {
    if (required.some((permission) => req.user?.permissions?.includes(permission))) return false;
    json(res, 403, { error: 'forbidden', permissions: required }); return true;
  };
  const hasPermission = (req, permission) => req.user?.permissions?.includes(permission) === true;
  const clients = [];
  const discountGroups = [];
  const url = new URL(`http://localhost${path}`);
  const recordAudit = async (req, action, entityType, entityId, beforeData, afterData) => {
    await pool.query('INSERT INTO audit_events (venue_id,actor_id,action,entity_type,entity_id,before_data,after_data) VALUES ($1,$2,$3,$4,$5,$6,$7)', [venue, null, action, entityType, entityId || null, beforeData || null, afterData || null]);
  };
  const handler = new Function('pathname','url','req','res','repositories','venueDbId','denyUnlessAny','body','json','recordAudit','hasPermission','normalizePhoneNumbers','clients','discountGroups',
    `return (async()=>{${route}})();`);
  await handler(pathname, url, { method, headers: {}, user: { id: null, role: 'owner', permissions } }, {}, { pool }, venue, denyUnlessAny,
    async () => body, json, recordAudit, hasPermission, normalizePhoneNumbers, clients, discountGroups);
  return response;
};

const originalAuthRequired = process.env.AUTH_REQUIRED;
process.env.AUTH_REQUIRED = 'true';
try {
  await setup.connect();
  setupConnected = true;
  venueId = (await setup.query("INSERT INTO venues (name) VALUES ('Guest loyalty API QA') RETURNING id")).rows[0].id;
  otherVenueId = (await setup.query("INSERT INTO venues (name) VALUES ('Guest loyalty tenant QA') RETURNING id")).rows[0].id;

  assert.equal((await callApi({ route: groupRoute, path: '/api/discount-groups', permissions: [] })).status, 403,
    'guest-program list requires a relevant permission');
  assert.equal((await callApi({ route: groupRoute, path: '/api/discount-groups', method: 'POST', permissions: [], body: { name: 'Blocked' } })).status, 403,
    'guest-program creation requires a relevant permission');
  assert.equal((await callApi({ route: groupRoute, path: '/api/discount-groups', method: 'POST', body: { name: 'Out of range', depositMin: 10000000000 } })).status, 400,
    'deposit minimum above the PostgreSQL numeric(12,2) limit is rejected as input instead of failing on persistence');
  assert.equal((await callApi({ route: groupRoute, path: '/api/discount-groups', method: 'POST', body: { name: 'Fractional cents', depositMin: 1.005 } })).status, 400,
    'deposit minimum with fractional kopecks is rejected instead of being rounded differently by PostgreSQL');

  const created = await callApi({ route: groupRoute, path: '/api/discount-groups', method: 'POST', body: {
    name: 'VIP', discountPercent: 10, bonusPercent: 2.5, depositMin: 3000,
  } });
  assert.equal(created.status, 201, JSON.stringify(created));
  assert.equal(created.data.discountPercent, 10);
  assert.equal(created.data.bonusPercent, 2.5);
  assert.equal(created.data.depositMin, 3000);
  const listed = await callApi({ route: groupRoute, path: '/api/discount-groups' });
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.data.items.map((item) => item.id), [created.data.id]);
  const duplicate = await callApi({ route: groupRoute, path: '/api/discount-groups', method: 'POST', body: { name: 'vip' } });
  assert.equal(duplicate.status, 409, 'names are unique per venue without case sensitivity');
  const updated = await callApi({ route: groupRoute, path: `/api/discount-groups/${created.data.id}`, method: 'PATCH', body: { bonusPercent: 3, depositMin: 4500 } });
  assert.equal(updated.status, 200);
  assert.equal(updated.data.bonusPercent, 3);
  assert.equal(updated.data.depositMin, 4500);
  assert.equal((await callApi({ route: groupRoute, path: `/api/discount-groups/${created.data.id}`, method: 'PATCH', body: { depositMin: 10000000000 } })).status, 400,
    'deposit-minimum range validation also applies to program edits');
  assert.equal((await callApi({ route: groupRoute, path: `/api/discount-groups/${created.data.id}`, venue: otherVenueId, method: 'PATCH', body: { name: 'Foreign edit' } })).status, 404,
    'another venue cannot edit this guest program');
  assert.deepEqual((await callApi({ route: groupRoute, path: '/api/discount-groups', venue: otherVenueId })).data.items, [],
    'guest programs are isolated by venue');

  const archivedGroup = await callApi({ route: groupRoute, path: `/api/discount-groups/${created.data.id}`, method: 'PATCH', body: { active: false } });
  assert.equal(archivedGroup.status, 200);
  assert.equal(archivedGroup.data.active, false, 'a loyalty program can be archived without deleting its history or guest links');
  assert.deepEqual((await callApi({ route: groupRoute, path: '/api/discount-groups' })).data.items, [], 'archived programs are not assignable in the default active list');
  assert.equal((await callApi({ route: groupRoute, path: '/api/discount-groups?includeArchived=true', permissions: ['orders'] })).status, 403,
    'ordinary order staff cannot browse the archive');
  const archivedList = await callApi({ route: groupRoute, path: '/api/discount-groups?includeArchived=true', permissions: ['finance'] });
  assert.equal(archivedList.data.items.find((item) => item.id === created.data.id).active, false);
  const restoredGroup = await callApi({ route: groupRoute, path: `/api/discount-groups/${created.data.id}`, method: 'PATCH', body: { active: true } });
  assert.equal(restoredGroup.status, 200);
  assert.equal(restoredGroup.data.active, true, 'a manager can restore an archived program');
  assert.ok((await callApi({ route: groupRoute, path: '/api/discount-groups' })).data.items.some((item) => item.id === created.data.id));

  const guest = await callApi({ route: guestRoute, path: '/api/clients', method: 'POST', body: {
    name: 'QA Guest', phoneNumbers: [{ number: '+79990000001', primary: true }], discountGroupId: created.data.id,
    bonusBalance: 0, depositBalance: 0,
  } });
  assert.equal(guest.status, 201, JSON.stringify(guest));
  assert.equal(guest.data.discountGroupId, created.data.id);
  assert.equal(Number(guest.data.loyaltyPoints), 0);
  assert.equal(Number(guest.data.depositBalance), 0);
  const guestId = guest.data.id;
  const openingAdjustment = await callApi({ route: loyaltyRoute, path: `/api/clients/${guestId}/loyalty`, method: 'POST', body: { delta: 125, reason: 'QA opening balance', idempotencyKey: 'qa-opening-0001' } });
  assert.equal(openingAdjustment.status, 200, JSON.stringify(openingAdjustment));
  assert.equal(openingAdjustment.data.bonusBalance, 125);
  const retryAdjustment = await callApi({ route: loyaltyRoute, path: `/api/clients/${guestId}/loyalty`, method: 'POST', body: { delta: 125, reason: 'QA opening balance', idempotencyKey: 'qa-opening-0001' } });
  assert.equal(retryAdjustment.status, 200);
  assert.equal(retryAdjustment.data.duplicate, true, 'repeated idempotency key returns the existing operation without applying it twice');
  const mismatchedRetry = await callApi({ route: loyaltyRoute, path: `/api/clients/${guestId}/loyalty`, method: 'POST', body: { delta: 126, reason: 'Different payload', idempotencyKey: 'qa-opening-0001' } });
  assert.equal(mismatchedRetry.status, 409, 'an idempotency key cannot be reused with another payload');
  const createAudit = await setup.query("SELECT action,entity_id FROM audit_events WHERE venue_id=$1 AND entity_type='client' AND entity_id=$2 AND action='client.created'", [venueId, guestId]);
  assert.equal(createAudit.rows.length, 1, 'successful PostgreSQL guest creation writes its persistent audit event before returning');
  const ordersOnlyCreate = await callApi({ route: guestRoute, path: '/api/clients', method: 'POST', permissions: ['orders'], body: {
    name: 'Unauthorized QA Guest', phoneNumbers: [{ number: '+79990000009', primary: true }], discountGroupId: created.data.id,
    bonusBalance: 999, depositBalance: 50000,
  } });
  assert.equal(ordersOnlyCreate.status, 403, 'orders-only roles cannot set protected discount, bonus, or deposit fields while creating guests');
  const noUnauthorizedGuest = await setup.query("SELECT count(*)::int AS count FROM guests WHERE venue_id=$1 AND full_name='Unauthorized QA Guest'", [venueId]);
  assert.equal(noUnauthorizedGuest.rows[0].count, 0, 'denied guest creation does not persist a guest or protected balances');
  const initialBalanceCreate = await callApi({ route: guestRoute, path: '/api/clients', method: 'POST', body: {
    name: 'Unjournaled QA Guest', phoneNumbers: [{ number: '+79990000007', primary: true }], bonusBalance: 25,
  } });
  assert.equal(initialBalanceCreate.status, 409, 'new guests cannot be created with an unjournaled nonzero balance');
  const ordersOnlyBasicCreate = await callApi({ route: guestRoute, path: '/api/clients', method: 'POST', permissions: ['orders'], body: {
    name: 'Orders-only QA Guest', phoneNumbers: [{ number: '+79990000008', primary: true }],
  } });
  assert.equal(ordersOnlyBasicCreate.status, 201, 'orders-only staff may still create an ordinary guest profile for order service');
  assert.equal((await callApi({ route: guestListRoute, path: '/api/clients', permissions: [] })).status, 403,
    'guest balances are unavailable to roles without a guest/list permission');
  const guestList = await callApi({ route: guestListRoute, path: '/api/clients' });
  assert.equal(guestList.status, 200, JSON.stringify(guestList));
  assert.equal(guestList.data.items.find((item) => item.id === guestId).discountGroupId, created.data.id);
  assert.equal(Number(guestList.data.items.find((item) => item.id === guestId).discountPercent), 10);
  assert.equal(Number(guestList.data.items.find((item) => item.id === guestId).bonusBalance), 125);
  assert.equal(Number(guestList.data.items.find((item) => item.id === guestId).depositBalance), 0);
  const ordersOnlyBalancePatch = await callApi({ route: guestRoute, path: `/api/clients/${guestId}`, method: 'PATCH', permissions: ['orders'], body: { bonusBalance: 999999, depositBalance: 50000, discountGroupId: null } });
  assert.equal(ordersOnlyBalancePatch.status, 403, 'orders-only roles cannot use guest profile PATCH to change protected balances or loyalty group');
  const unchangedAfterDeniedPatch = await callApi({ route: guestListRoute, path: '/api/clients' });
  assert.equal(Number(unchangedAfterDeniedPatch.data.items.find((item) => item.id === guestId).bonusBalance), 125,
    'denied protected-field PATCH leaves guest bonus balance unchanged');
  assert.equal(Number(unchangedAfterDeniedPatch.data.items.find((item) => item.id === guestId).depositBalance), 0,
    'denied protected-field PATCH leaves guest deposit unchanged');
  const unauthorizedBalanceOverwrite = await callApi({ route: guestRoute, path: `/api/clients/${guestId}`, method: 'PATCH', body: { bonusBalance: 999, depositBalance: 50 } });
  assert.equal(unauthorizedBalanceOverwrite.status, 409, 'even privileged profile edits cannot overwrite account balances outside the movement journal');
  const insufficientAdjustment = await callApi({ route: loyaltyRoute, path: `/api/clients/${guestId}/loyalty`, method: 'POST', body: { delta: -100000, reason: 'QA must not overdraft', idempotencyKey: 'qa-overdraft-01' } });
  assert.equal(insufficientAdjustment.status, 409, 'bonus adjustments cannot make the balance negative');
  const ledger = await callApi({ route: accountRoute, path: `/api/clients/${guestId}/account-entries` });
  assert.equal(ledger.status, 200, JSON.stringify(ledger));
  assert.equal(ledger.data.balances.bonus, 125);
  assert.ok(ledger.data.items.some((entry) => entry.accountType === 'bonus' && entry.amount === 125 && entry.sourceType === 'manual_adjustment'));
  assert.equal((await callApi({ route: loyaltyRoute, path: `/api/clients/${guestId}/loyalty`, method: 'POST', permissions: [], body: { delta: 5, reason: 'forbidden test', idempotencyKey: 'qa-forbidden-01' } })).status, 403,
    'roles without loyalty permission cannot adjust guest balances');
  const concurrentAdjustments = await Promise.all([
    callApi({ route: loyaltyRoute, path: `/api/clients/${guestId}/loyalty`, method: 'POST', body: { delta: 20, reason: 'concurrent test A', idempotencyKey: 'qa-adjustment-a' } }),
    callApi({ route: loyaltyRoute, path: `/api/clients/${guestId}/loyalty`, method: 'POST', body: { delta: 10, reason: 'concurrent test B', idempotencyKey: 'qa-adjustment-b' } }),
    callApi({ route: loyaltyRoute, path: `/api/clients/${guestId}/loyalty`, method: 'POST', body: { delta: -5, reason: 'concurrent test C', idempotencyKey: 'qa-adjustment-c' } }),
    callApi({ route: loyaltyRoute, path: `/api/clients/${guestId}/loyalty`, method: 'POST', body: { delta: -15, reason: 'concurrent test D', idempotencyKey: 'qa-adjustment-d' } }),
  ]);
  assert.ok(concurrentAdjustments.every((result) => result.status === 200), 'concurrent positive and negative adjustments all succeed');
  assert.ok(concurrentAdjustments.every((result) => result.data.bonusBalance === result.data.loyaltyPoints), 'API returns synchronized balance aliases');
  const afterConcurrentAdjustments = await callApi({ route: guestListRoute, path: '/api/clients' });
  assert.equal(Number(afterConcurrentAdjustments.data.items.find((item) => item.id === guestId).loyaltyPoints), 135,
    'concurrent adjustments preserve the sum of every serialized update');
  const finalLedger = await callApi({ route: accountRoute, path: `/api/clients/${guestId}/account-entries` });
  assert.equal(finalLedger.data.items.length, 5, 'each accepted adjustment is represented once, including concurrent operations');
  assert.equal(finalLedger.data.items.reduce((sum, entry) => sum + (entry.accountType === 'bonus' ? entry.amount : 0), 0), 135,
    'bonus journal sum reconciles to the current balance');
  const foreignAdjustment = await callApi({ route: loyaltyRoute, path: `/api/clients/${guestId}/loyalty`, venue: otherVenueId, method: 'POST', body: { delta: 10, reason: 'wrong venue', idempotencyKey: 'qa-foreign-01' } });
  assert.equal(foreignAdjustment.status, 404, 'another venue cannot adjust this guest balance');
  const patch = await callApi({ route: guestRoute, path: `/api/clients/${guestId}`, method: 'PATCH', body: {
    discountGroupId: null,
  } });
  assert.equal(patch.status, 200, JSON.stringify(patch));
  assert.equal(patch.data.discountGroupId, null);
  assert.equal(Number(patch.data.loyaltyPoints), 135);
  assert.equal(Number(patch.data.depositBalance), 0);
  const updateAudit = await setup.query("SELECT action,entity_id FROM audit_events WHERE venue_id=$1 AND entity_type='client' AND entity_id=$2 AND action='client.updated'", [venueId, guestId]);
  assert.equal(updateAudit.rows.length, 1, 'successful PostgreSQL guest update writes its persistent audit event before returning');
  const stored = await setup.query('SELECT discount_group_id AS "discountGroupId",loyalty_points AS "loyaltyPoints",deposit_balance AS "depositBalance" FROM guests WHERE id=$1 AND venue_id=$2', [guestId, venueId]);
  assert.equal(stored.rows.length, 1);
  assert.equal(stored.rows[0].discountGroupId, null);
  assert.equal(Number(stored.rows[0].loyaltyPoints), 135);
  assert.equal(Number(stored.rows[0].depositBalance), 0);
  const listedAfterUpdate = await callApi({ route: guestListRoute, path: '/api/clients' });
  assert.equal(listedAfterUpdate.data.items.find((item) => item.id === guestId).discountGroupId, null);
  assert.equal(Number(listedAfterUpdate.data.items.find((item) => item.id === guestId).bonusBalance), 135);
  assert.equal(Number(listedAfterUpdate.data.items.find((item) => item.id === guestId).depositBalance), 0);
  const wrongTenantUpdate = await callApi({ route: guestRoute, path: `/api/clients/${guestId}`, venue: otherVenueId, method: 'PATCH', body: { depositBalance: 999 } });
  assert.equal(wrongTenantUpdate.status, 404, 'another venue cannot update guest balances');
  const invalidBalance = await callApi({ route: guestRoute, path: `/api/clients/${guestId}`, method: 'PATCH', body: { depositBalance: -1 } });
  assert.equal(invalidBalance.status, 409, 'balance changes must use the immutable movement journal');
  const invalidGroupId = await callApi({ route: guestRoute, path: `/api/clients/${guestId}`, method: 'PATCH', body: { discountGroupId: 'not-a-uuid' } });
  assert.equal(invalidGroupId.status, 400, 'malformed guest-program IDs are rejected as validation errors');

  console.log('Guest loyalty PostgreSQL API QA: PASS (tenant isolation, permissions, durable program/guest balances)');
} finally {
  if (originalAuthRequired === undefined) delete process.env.AUTH_REQUIRED;
  else process.env.AUTH_REQUIRED = originalAuthRequired;
  if (setupConnected) {
    await setup.query('DELETE FROM guest_account_entries WHERE venue_id = ANY($1::uuid[])', [[venueId, otherVenueId].filter(Boolean)]);
    const remainingEntries = await setup.query('SELECT count(*)::int AS count FROM guest_account_entries WHERE venue_id = ANY($1::uuid[])', [[venueId, otherVenueId].filter(Boolean)]);
    assert.equal(remainingEntries.rows[0].count, 0, 'QA fixture account entries are cleaned before guest/venue teardown');
    await setup.query('DELETE FROM guests WHERE venue_id = ANY($1::uuid[])', [[venueId, otherVenueId].filter(Boolean)]).catch(() => {});
    await setup.query('DELETE FROM guest_discount_groups WHERE venue_id = ANY($1::uuid[])', [[venueId, otherVenueId].filter(Boolean)]).catch(() => {});
    await setup.query('DELETE FROM venues WHERE id = ANY($1::uuid[])', [[venueId, otherVenueId].filter(Boolean)]).catch(() => {});
  }
  await setup.end();
  await pool.end();
}
