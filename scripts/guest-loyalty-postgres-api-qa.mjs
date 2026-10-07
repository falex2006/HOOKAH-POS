import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

const databaseUrl = process.env.MIGRATIONS_PG_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('Set MIGRATIONS_PG_TEST_DATABASE_URL to an isolated PostgreSQL QA database');
assert.match(new URL(databaseUrl).pathname, /(?:test|qa|scratch)/i,
  'refusing test writes unless the database name clearly identifies a test/QA/scratch database');

const require = createRequire(import.meta.url);
const { Client, Pool } = require('pg');
const { AuditRepository } = require('../db.js');
const setup = new Client({ connectionString: databaseUrl });
const pool = new Pool({ connectionString: databaseUrl, max: 4 });
const auditRepository = new AuditRepository(pool);
const auditTriggerName = `qa_loyalty_audit_fail_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
let auditTriggerCreated = false;
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
const callApi = async ({ route, path, method = 'GET', body = {}, permissions = ['loyalty', 'staff_manage', 'orders'], role = 'owner', venue = venueId }) => {
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
  const handler = new Function('pathname','url','req','res','repositories','venueDbId','currentVenueId','requestVenueId','denyUnlessAny','body','json','recordAudit','hasPermission','normalizePhoneNumbers','clients','discountGroups',
    `return (async()=>{${route}})();`);
  await handler(pathname, url, { method, headers: {}, user: { id: null, role, permissions } }, {}, { pool, audit: auditRepository }, venue, venue, venue, denyUnlessAny,
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
  assert.equal((await setup.query('SELECT count(*)::int AS count FROM guests WHERE id=$1 AND venue_id=$2', [guestId, venueId])).rows[0].count, 1, 'guest API fixture persisted in the expected QA tenant');
  await setup.query(`CREATE FUNCTION ${auditTriggerName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='client.loyalty_adjusted' THEN RAISE EXCEPTION 'qa_loyalty_audit_rejected'; END IF; RETURN NEW; END $$`);
  await setup.query(`CREATE TRIGGER ${auditTriggerName} BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION ${auditTriggerName}()`);
  auditTriggerCreated = true;
  const auditRejectedAdjustment = await callApi({ route: loyaltyRoute, path: `/api/clients/${guestId}/loyalty`, method: 'POST', body: { delta: 125, reason: 'QA rejected audit', idempotencyKey: 'qa-audit-failure-01' } });
  assert.equal(auditRejectedAdjustment.status, 503, 'manual adjustment fails if its durable audit event cannot be written');
  assert.equal(Number((await setup.query('SELECT loyalty_points FROM guests WHERE id=$1 AND venue_id=$2', [guestId, venueId])).rows[0].loyalty_points), 0, 'failed audit rolls back the guest balance change');
  assert.equal(Number((await setup.query("SELECT count(*)::int AS count FROM guest_account_entries WHERE venue_id=$1 AND guest_id=$2 AND source_key='loyalty-adjustment:qa-audit-failure-01'", [venueId, guestId])).rows[0].count), 0, 'failed audit rolls back the account ledger entry');
  await setup.query(`DROP TRIGGER ${auditTriggerName} ON audit_events`);
  await setup.query(`DROP FUNCTION ${auditTriggerName}()`);
  auditTriggerCreated = false;
  const openingAdjustment = await callApi({ route: loyaltyRoute, path: `/api/clients/${guestId}/loyalty`, method: 'POST', body: { delta: 125, reason: 'QA opening balance', idempotencyKey: 'qa-opening-0001' } });
  assert.equal(openingAdjustment.status, 200, JSON.stringify(openingAdjustment));
  assert.equal(openingAdjustment.data.bonusBalance, 125);
  const retryAdjustment = await callApi({ route: loyaltyRoute, path: `/api/clients/${guestId}/loyalty`, method: 'POST', body: { delta: 125, reason: 'QA opening balance', idempotencyKey: 'qa-opening-0001' } });
  assert.equal(retryAdjustment.status, 200);
  assert.equal(retryAdjustment.data.duplicate, true, 'repeated idempotency key returns the existing operation without applying it twice');
  const adjustmentAudit = await setup.query("SELECT before_data,after_data FROM audit_events WHERE venue_id=$1 AND entity_type='client' AND entity_id=$2 AND action='client.loyalty_adjusted' AND after_data->>'sourceKey'='loyalty-adjustment:qa-opening-0001'", [venueId, guestId]);
  assert.equal(adjustmentAudit.rows.length, 1, 'accepted bonus adjustment has one durable audit row linked to its immutable ledger key');
  assert.equal(Number(adjustmentAudit.rows[0].before_data.loyaltyPoints), 0);
  assert.equal(Number(adjustmentAudit.rows[0].after_data.loyaltyPoints), 125);
  const mismatchedRetry = await callApi({ route: loyaltyRoute, path: `/api/clients/${guestId}/loyalty`, method: 'POST', body: { delta: 126, reason: 'Different payload', idempotencyKey: 'qa-opening-0001' } });
  assert.equal(mismatchedRetry.status, 409, 'an idempotency key cannot be reused with another payload');
  const createAudit = await setup.query("SELECT action,entity_id,after_data FROM audit_events WHERE venue_id=$1 AND entity_type='client' AND entity_id=$2 AND action='client.created'", [venueId, guestId]);
  assert.equal(createAudit.rows.length, 1, 'successful PostgreSQL guest creation writes its persistent audit event before returning');
  assert.deepEqual(createAudit.rows[0].after_data, { profileCreated: true }, 'guest profile audit stores an action summary instead of contact or preference data');
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
  const ordersOnlyGuestList = await callApi({ route: guestListRoute, path: '/api/clients', permissions: ['orders'], role: 'bartender' });
  const ordersOnlyGuest = ordersOnlyGuestList.data.items.find((item) => item.id === guestId);
  assert.equal(ordersOnlyGuest.loyaltyPoints, undefined, 'orders-only guest list omits the bonus balance');
  assert.equal(ordersOnlyGuest.depositBalance, undefined, 'orders-only guest list omits the stored-value balance');
  const ordersOnlyProfileEdit = await callApi({ route: guestRoute, path: `/api/clients/${guestId}`, method: 'PATCH', permissions: ['orders'], role: 'bartender', body: { nickname: 'Service-only edit' } });
  assert.equal(ordersOnlyProfileEdit.status, 200, JSON.stringify(ordersOnlyProfileEdit));
  assert.equal(ordersOnlyProfileEdit.data.loyaltyPoints, undefined, 'ordinary profile PATCH does not bypass guest bonus balance read permission');
  assert.equal(ordersOnlyProfileEdit.data.bonusBalance, undefined, 'ordinary profile PATCH omits the bonus alias for orders-only staff');
  assert.equal(ordersOnlyProfileEdit.data.depositBalance, undefined, 'ordinary profile PATCH omits the stored-value balance for orders-only staff');
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
  const ordersOnlyLedger = await callApi({ route: accountRoute, path: `/api/clients/${guestId}/account-entries`, permissions: ['orders'], role: 'bartender' });
  assert.equal(ordersOnlyLedger.status, 403, 'orders-only service access does not expose a guest financial ledger');
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
  assert.equal(updateAudit.rows.length, 2, 'each successful PostgreSQL guest profile update writes its persistent audit event before returning');
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

  // Reversal API: strict finance-only permission, partial cap, idempotency, and bonus clawback.
  const reversalUser = (await setup.query("INSERT INTO users (venue_id,full_name,login,role) VALUES ($1,'Reversal QA','reversal-qa-'||substr(gen_random_uuid()::text,1,8),'owner') RETURNING id", [venueId])).rows[0].id;
  const shiftId = (await setup.query('INSERT INTO shifts (venue_id,opened_by) VALUES ($1,$2) RETURNING id', [venueId, reversalUser])).rows[0].id;
  const bonusSource = (await setup.query("INSERT INTO guest_account_entries (venue_id,guest_id,account_type,amount,reason,source_type,source_key) VALUES ($1,$2,'bonus',50,'QA earned bonus','order','qa-order:bonus-earned:v1') RETURNING id", [venueId, guestId])).rows[0].id;
  await setup.query('UPDATE guests SET loyalty_points=5 WHERE id=$1 AND venue_id=$2', [guestId, venueId]);
  const reversePath = `/api/clients/${guestId}/account-entries/${bonusSource}/reversals`;
  const reverseBody = { amount: 30, method: 'clawback', reason: 'QA revoke award', idempotencyKey: 'qa-reversal-bonus-01' };
  assert.equal((await callApi({ route: accountRoute, path: reversePath, method: 'POST', body: reverseBody, permissions: ['finance_read'] })).status, 403,
    'read-only finance and other non-finance roles cannot reverse guest ledger movements');
  const reversed = await callApi({ route: accountRoute, path: reversePath, method: 'POST', body: reverseBody, permissions: ['finance'] });
  assert.equal(reversed.status, 201, JSON.stringify(reversed));
  assert.equal(reversed.data.immediateWalletDelta, -5);
  assert.equal(reversed.data.clawbackAmount, 25);
  assert.equal(reversed.data.balances.bonus, 0);
  const replay = await callApi({ route: accountRoute, path: reversePath, method: 'POST', body: reverseBody, permissions: ['finance'] });
  assert.equal(replay.status, 200); assert.equal(replay.data.idempotentReplay, true); assert.equal(replay.data.clawbackAmount, 25);
  assert.equal((await callApi({ route: accountRoute, path: reversePath, method: 'POST', body: { ...reverseBody, amount: 31 }, permissions: ['finance'] })).status, 409,
    'same idempotency key with changed payload is rejected');
  assert.equal((await callApi({ route: accountRoute, path: reversePath, method: 'POST', body: { ...reverseBody, amount: 21, idempotencyKey: 'qa-reversal-bonus-02' }, permissions: ['finance'] })).status, 409,
    'cumulative reversals cannot exceed the original award');
  assert.equal(Number((await setup.query('SELECT SUM(amount) AS amount FROM guest_bonus_clawback_entries WHERE venue_id=$1 AND guest_id=$2', [venueId, guestId])).rows[0].amount), 25,
    'unrecoverable bonus amount remains as an immutable future earning hold');
  await setup.query('UPDATE guest_discount_groups SET bonus_percent=10 WHERE id=$1 AND venue_id=$2', [created.data.id, venueId]);
  await setup.query('UPDATE guests SET discount_group_id=$1 WHERE id=$2 AND venue_id=$3', [created.data.id, guestId, venueId]);
  const orderId = (await setup.query("INSERT INTO orders (venue_id,guest_id,opened_by,status) VALUES ($1,$2,$3,'closed') RETURNING id", [venueId, guestId, reversalUser])).rows[0].id;
  const accrualStart = server.indexOf('async function accrueGuestOrderBonus(');
  const accrualEnd = server.indexOf('\nfunction accrueMemoryOrderBonus', accrualStart);
  assert.ok(accrualStart >= 0 && accrualEnd > accrualStart, 'order bonus accrual service is present');
  const accrualDependencies = { roundMoney: value => Math.round(Number(value) * 100) / 100, loyaltyBonusAccrual: (base, percent) => ({ base, percent, earned: Math.floor(base * percent / 100) }) };
  const accrueGuestOrderBonus = new Function('roundMoney','loyaltyBonusAccrual', `${server.slice(accrualStart, accrualEnd)};return accrueGuestOrderBonus;`)(accrualDependencies.roundMoney, accrualDependencies.loyaltyBonusAccrual);
  const accrualClient = await pool.connect();
  let appliedAward;
  try { appliedAward = await accrueGuestOrderBonus(accrualClient, { venueId, guestId, orderId, eligibleBase: 100, actorId: reversalUser }); }
  finally { accrualClient.release(); }
  assert.equal(appliedAward.earned, 0, 'future earned points first pay down the clawback without increasing spendable balance');
  assert.equal(Number((await setup.query('SELECT loyalty_points FROM guests WHERE id=$1 AND venue_id=$2', [guestId, venueId])).rows[0].loyalty_points), 0);
  assert.equal(Number((await setup.query('SELECT SUM(amount) AS amount FROM guest_bonus_clawback_entries WHERE venue_id=$1 AND guest_id=$2', [venueId, guestId])).rows[0].amount), 15,
    'future award consumes the oldest immutable clawback amount');
  const replayAfterHoldUse = await callApi({ route: accountRoute, path: reversePath, method: 'POST', body: reverseBody, permissions: ['finance'] });
  assert.equal(replayAfterHoldUse.data.immediateWalletDelta, -5, 'idempotent replay preserves the original immediate balance movement after future hold consumption');
  assert.equal(replayAfterHoldUse.data.clawbackAmount, 25, 'idempotent replay preserves original held amount after partial repayment');
  const bonusSourceForLoyalty = (await setup.query("INSERT INTO guest_account_entries (venue_id,guest_id,account_type,amount,reason,source_type,source_key) VALUES ($1,$2,'bonus',5,'QA loyalty-role award','order','qa-loyalty-role-award:bonus-earned') RETURNING id", [venueId, guestId])).rows[0].id;
  const loyaltyClawback = await callApi({ route: accountRoute, path: `/api/clients/${guestId}/account-entries/${bonusSourceForLoyalty}/reversals`, method: 'POST', role: 'bartender', permissions: ['loyalty'], body: { amount: 5, method: 'clawback', reason: 'QA loyalty role', idempotencyKey: 'qa-reversal-loyalty-01' } });
  assert.equal(loyaltyClawback.status, 201, 'explicit loyalty permission allows an internal bonus clawback without external payout');
  const clawbackLedger = await callApi({ route: accountRoute, path: `/api/clients/${guestId}/account-entries` });
  const zeroDeltaReversal = clawbackLedger.data.items.find(item => item.reversedSourceEntryId === bonusSourceForLoyalty);
  assert.ok(zeroDeltaReversal, 'a fully spent award clawback remains visible in account history with no ledger balance movement');
  assert.equal(zeroDeltaReversal.entryKind, 'reversal');
  assert.equal(Number(zeroDeltaReversal.amount), 0, 'a zero-delta reversal is not misrepresented as a balance debit');
  assert.equal(zeroDeltaReversal.reversalMethod, 'clawback');
  assert.equal(zeroDeltaReversal.reversalShiftId, shiftId);
  assert.equal(Number(zeroDeltaReversal.reversedAmount), 5);
  const depositSource = (await setup.query("INSERT INTO guest_account_entries (venue_id,guest_id,account_type,amount,reason,source_type,source_key) VALUES ($1,$2,'deposit',40,'QA deposit top-up','deposit_top_up','qa-deposit-top-up-01') RETURNING id", [venueId, guestId])).rows[0].id;
  await setup.query('UPDATE guests SET deposit_balance=40 WHERE id=$1 AND venue_id=$2', [guestId, venueId]);
  const internalWriteOff = await callApi({ route: accountRoute, path: `/api/clients/${guestId}/account-entries/${depositSource}/reversals`, method: 'POST', role: 'bartender', permissions: ['loyalty'], body: { amount: 1, method: 'wallet', reason: 'QA internal balance correction', idempotencyKey: 'qa-reversal-internal-01' } });
  assert.equal(internalWriteOff.status, 201, 'loyalty permission allows a guest-balance-only reversal of a top-up');
  const managerPayout = await callApi({ route: accountRoute, path: `/api/clients/${guestId}/account-entries/${depositSource}/reversals`, method: 'POST', role: 'manager', permissions: ['finance'], body: { amount: 20, method: 'cash', reason: 'QA unauthorized payout', idempotencyKey: 'qa-reversal-manager-01' } });
  assert.equal(managerPayout.status, 403, 'a finance permission alone does not grant external payout to non-owner/admin roles');
  const depositRefund = await callApi({ route: accountRoute, path: `/api/clients/${guestId}/account-entries/${depositSource}/reversals`, method: 'POST', permissions: ['finance'], body: { amount: 20, method: 'cash', reason: 'QA cash refund', idempotencyKey: 'qa-reversal-deposit-01' } });
  assert.equal(depositRefund.status, 201, JSON.stringify(depositRefund));
  assert.equal(depositRefund.data.balances.deposit, 19, 'external deposit refund reduces the guest liability after the preceding internal balance adjustment');
  assert.equal(Number((await setup.query("SELECT SUM(amount) AS amount FROM guest_account_reversals WHERE venue_id=$1 AND shift_id=$2 AND payout_method='cash'", [venueId, shiftId])).rows[0].amount), 20,
    'cash outflow is attributed to the actual handling shift');
  const simultaneousCashReturns = await Promise.all([
    callApi({ route: accountRoute, path: `/api/clients/${guestId}/account-entries/${depositSource}/reversals`, method: 'POST', permissions: ['finance'], body: { amount: 15, method: 'cash', reason: 'QA concurrent cash A', idempotencyKey: 'qa-reversal-race-a' } }),
    callApi({ route: accountRoute, path: `/api/clients/${guestId}/account-entries/${depositSource}/reversals`, method: 'POST', permissions: ['finance'], body: { amount: 15, method: 'cash', reason: 'QA concurrent cash B', idempotencyKey: 'qa-reversal-race-b' } }),
  ]);
  assert.deepEqual(simultaneousCashReturns.map(result => result.status).sort(), [201, 409], 'concurrent distinct keys serialize and cannot exceed the source amount');
  await setup.query('UPDATE guests SET deposit_balance=0 WHERE id=$1 AND venue_id=$2', [guestId, venueId]);
  const insufficientPayout = await callApi({ route: accountRoute, path: `/api/clients/${guestId}/account-entries/${depositSource}/reversals`, method: 'POST', permissions: ['finance'], body: { amount: 1, method: 'card', reason: 'QA insufficient wallet', idempotencyKey: 'qa-reversal-no-funds' } });
  assert.equal(insufficientPayout.status, 409); assert.equal(insufficientPayout.data.error, 'insufficient_deposit_balance');
  const fractionalPayout = await callApi({ route: accountRoute, path: `/api/clients/${guestId}/account-entries/${depositSource}/reversals`, method: 'POST', permissions: ['finance'], body: { amount: 0.29, method: 'card', reason: 'QA exact fractional cents', idempotencyKey: 'qa-reversal-cents-01' } });
  assert.equal(fractionalPayout.status, 409); assert.equal(fractionalPayout.data.error, 'insufficient_deposit_balance', 'valid two-decimal JavaScript numbers pass cent precision validation');
  const spendSource = (await setup.query("INSERT INTO guest_account_entries (venue_id,guest_id,account_type,amount,reason,source_type,source_key) VALUES ($1,$2,'deposit',-10,'QA wallet spend','order','qa-order:deposit-redeem') RETURNING id", [venueId, guestId])).rows[0].id;
  const walletRestore = await callApi({ route: accountRoute, path: `/api/clients/${guestId}/account-entries/${spendSource}/reversals`, method: 'POST', permissions: ['finance'], body: { amount: 10, method: 'wallet', reason: 'QA restore guest funds', idempotencyKey: 'qa-reversal-wallet-01' } });
  assert.equal(walletRestore.status, 201); assert.equal(walletRestore.data.balances.deposit, 10, 'reversing a wallet spend returns funds to the same account');
  assert.equal(Number((await setup.query("SELECT SUM(amount) AS amount FROM guest_account_reversals WHERE venue_id=$1 AND shift_id=$2 AND payout_method='cash'", [venueId, shiftId])).rows[0].amount), 35,
    'wallet restoration does not add to cash outflow');
  const reversalAudit = await setup.query("SELECT count(*)::int AS count FROM audit_events WHERE venue_id=$1 AND action='guest.account_reversed' AND entity_id=$2", [venueId, reversed.data.id]);
  assert.equal(reversalAudit.rows[0].count, 1, 'reversal and audit commit once');
  assert.equal((await callApi({ route: accountRoute, path: reversePath, method: 'POST', body: { ...reverseBody, idempotencyKey: 'qa-reversal-tenant-01' }, venue: otherVenueId, permissions: ['finance'] })).status, 404,
    'reversal cannot cross venue boundaries');

  const invalidBalance = await callApi({ route: guestRoute, path: `/api/clients/${guestId}`, method: 'PATCH', body: { depositBalance: -1 } });
  assert.equal(invalidBalance.status, 409, 'balance changes must use the immutable movement journal');
  const invalidGroupId = await callApi({ route: guestRoute, path: `/api/clients/${guestId}`, method: 'PATCH', body: { discountGroupId: 'not-a-uuid' } });
  assert.equal(invalidGroupId.status, 400, 'malformed guest-program IDs are rejected as validation errors');

  console.log('Guest loyalty PostgreSQL API QA: PASS (tenant isolation, permissions, durable program/guest balances)');
} finally {
  if (originalAuthRequired === undefined) delete process.env.AUTH_REQUIRED;
  else process.env.AUTH_REQUIRED = originalAuthRequired;
  if (setupConnected) {
    if (auditTriggerCreated) {
      await setup.query(`DROP TRIGGER IF EXISTS ${auditTriggerName} ON audit_events`).catch(() => {});
      await setup.query(`DROP FUNCTION IF EXISTS ${auditTriggerName}()`).catch(() => {});
    }
    await setup.query('DELETE FROM guest_bonus_clawback_entries WHERE venue_id = ANY($1::uuid[])', [[venueId, otherVenueId].filter(Boolean)]).catch(() => {});
    await setup.query('DELETE FROM guest_account_reversals WHERE venue_id = ANY($1::uuid[])', [[venueId, otherVenueId].filter(Boolean)]).catch(() => {});
    await setup.query('DELETE FROM guest_account_entries WHERE venue_id = ANY($1::uuid[])', [[venueId, otherVenueId].filter(Boolean)]);
    const remainingEntries = await setup.query('SELECT count(*)::int AS count FROM guest_account_entries WHERE venue_id = ANY($1::uuid[])', [[venueId, otherVenueId].filter(Boolean)]);
    assert.equal(remainingEntries.rows[0].count, 0, 'QA fixture account entries are cleaned before guest/venue teardown');
    await setup.query('DELETE FROM guests WHERE venue_id = ANY($1::uuid[])', [[venueId, otherVenueId].filter(Boolean)]).catch(() => {});
    await setup.query('DELETE FROM guest_discount_groups WHERE venue_id = ANY($1::uuid[])', [[venueId, otherVenueId].filter(Boolean)]).catch(() => {});
    await setup.query('DELETE FROM shifts WHERE venue_id = ANY($1::uuid[])', [[venueId, otherVenueId].filter(Boolean)]).catch(() => {});
    await setup.query("DELETE FROM users WHERE login LIKE 'reversal-qa-%' AND venue_id = ANY($1::uuid[])", [[venueId, otherVenueId].filter(Boolean)]).catch(() => {});
    await setup.query('DELETE FROM venues WHERE id = ANY($1::uuid[])', [[venueId, otherVenueId].filter(Boolean)]).catch(() => {});
  }
  await setup.end();
  await pool.end();
}
