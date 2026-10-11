import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Execute the actual server handler and policy in isolation. No server or DB writes.
const source = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const handlerStart = source.indexOf('  const staffPinPath = pathname.match(');
const handlerEnd = source.indexOf("\nif (staffProfile && req.method === 'GET')", handlerStart);
assert(handlerStart >= 0 && handlerEnd > handlerStart, 'PIN handler boundaries');
const handler = source.slice(handlerStart, handlerEnd);
const policy = source.match(/^const canManageStaffTarget = .*;$/m)?.[0];
const deny = source.match(/^const denyUnless = .*;$/m)?.[0];
const venueScope = source.match(/const notificationVenueScope = [\s\S]*?\n};/)?.[0];
assert(policy && deny && venueScope, 'actual server policy dependencies');
assert.match(handler, /SELECT id,role FROM users WHERE id=\$1 AND venue_id=\$2 AND is_active=true AND deleted_at IS NULL/);
assert.match(handler, /WHERE id=\$2 AND venue_id=\$3 AND role=\$4 AND is_active=true AND deleted_at IS NULL/);
assert.equal((handler.match(/!isSelf && !canManageStaffTarget/g) || []).length, 2);

const venueA = '00000000-0000-0000-0000-000000000001';
const venueB = '00000000-0000-0000-0000-000000000002';
const targetUuid = '00000000-0000-0000-0000-000000000003';
let scenarios = 0;

async function exercise(branch, options, expectedStatus) {
  const { actorRole = 'manager', targetRole = 'bartender', self = false,
    permission = ['owner', 'admin', 'manager'].includes(actorRole),
    targetVenue = venueA, actorVenue = venueA, active = true, deleted = false,
    missing = false, pin = '1234', changedRole = null, legacyMemoryVenue = false } = options;
  const targetId = branch === 'pg' ? targetUuid : 'memory-target';
  const target = { id: targetId, role: targetRole, name: 'Fixture', active,
    deletedAt: deleted ? '2026-01-01' : null, venueId: targetVenue, pinHash: 'before' };
  if (legacyMemoryVenue) delete target.venueId;
  const session = { user: { id: targetId, pinConfigured: false }, unlockHash: 'before' };
  const audit = [], notifications = [], queries = [];
  let writes = 0, hashCalls = 0, response;
  const repositories = branch === 'pg' ? { pool: { query: async (sql, params) => {
    queries.push({ sql, params });
    if (sql.startsWith('SELECT')) {
      assert.deepEqual(Array.from(params), [targetId, actorVenue]);
      return { rows: !missing && targetVenue === params[1] && active && !deleted ? [{ id: targetId, role: targetRole }] : [] };
    }
    assert(sql.startsWith('UPDATE users SET pin_hash='), 'only expected mutation');
    assert.deepEqual(Array.from(params).slice(1), [targetId, actorVenue, targetRole]);
    if (changedRole && changedRole !== params[3]) return { rows: [] };
    assert(!missing && targetVenue === params[2] && active && !deleted);
    writes += 1;
    return { rows: [{ id: targetId, name: 'Fixture', pinUpdatedAt: '2026-01-01' }] };
  } } } : null;
  const context = vm.createContext({
    process: { env: { AUTH_REQUIRED: 'true' } }, repositories,
    req: { method: 'PATCH', user: { id: self ? targetId : 'actor', role: actorRole, venueId: actorVenue } },
    res: {}, pathname: `/api/staff/${targetId}/pin`, venueDbId: actorVenue,
    defaultVenueDbId: venueA, currentVenueId: 'venue-territory',
    staff: branch === 'memory' && !missing ? [target] : [], sessions: new Map([['fixture', session]]),
    staffNotifications: notifications, crypto: { randomUUID: () => 'fixture' },
    body: async () => ({ pin }), hasPermission: () => permission,
    hashPassword: async () => { hashCalls += 1; return 'fixture-hash'; },
    json: (_req, status, payload) => { response = { status, payload }; return response; },
    recordAudit: (...args) => audit.push(args),
  });
  await vm.runInContext(`${policy}\n${deny}\n${venueScope}\n(async () => {${handler}\n})()`, context);
  assert.equal(response?.status, expectedStatus, `${branch} ${JSON.stringify(options)}`);
  if (expectedStatus === 403 && permission && !self) assert.equal(response.payload.error, targetRole === 'owner' ? 'owner_staff_protected' : 'staff_management_required');
  if (expectedStatus === 200) {
    assert.equal(hashCalls, 1); assert.equal(audit.length, 1);
    assert.equal(session.user.pinConfigured, true);
    if (branch === 'pg') assert.equal(writes, 1);
    else { assert.equal(target.pinHash, 'fixture-hash'); assert.equal(notifications.length, 1); }
  } else {
    assert.equal(writes, 0); assert.equal(target.pinHash, 'before');
    assert.equal(audit.length, 0); assert.equal(notifications.length, 0);
    assert.equal(session.unlockHash, 'before'); assert.equal(session.user.pinConfigured, false);
    assert.equal(hashCalls, changedRole ? 1 : 0, 'authorization before hashing');
  }
  if (branch === 'pg' && expectedStatus === 403) assert(!queries.some(({ sql }) => sql.startsWith('UPDATE')));
  scenarios += 1;
}

for (const branch of ['memory', 'pg']) {
  for (const actorRole of ['manager', 'admin']) {
    for (const targetRole of ['owner', 'admin', 'developer']) await exercise(branch, { actorRole, targetRole }, 403);
    await exercise(branch, { actorRole, targetRole: 'bartender' }, 200);
  }
  for (const targetRole of ['owner', 'admin', 'developer', 'bartender']) await exercise(branch, { actorRole: 'owner', targetRole }, 200);
  for (const actorRole of ['owner', 'admin', 'developer', 'bartender']) await exercise(branch, { actorRole, targetRole: actorRole, self: true, permission: false }, 200);
  await exercise(branch, { actorRole: 'bartender', permission: false }, 403);
  await exercise(branch, { actorRole: 'bartender', permission: true }, 403);
  await exercise(branch, { actorRole: 'owner', targetVenue: venueB }, 404);
  await exercise(branch, { actorRole: 'owner', self: true, targetVenue: venueB }, 404);
  await exercise(branch, { actorRole: 'manager', targetRole: 'owner', targetVenue: venueB }, 404);
  await exercise(branch, { actorRole: 'owner', active: false }, 404);
  await exercise(branch, { actorRole: 'owner', deleted: true }, 404);
  await exercise(branch, { actorRole: 'owner', missing: true }, 404);
  await exercise(branch, { pin: '12xx' }, 400);
}
await exercise('memory', { actorRole: 'owner', legacyMemoryVenue: true }, 200);
await exercise('memory', { actorRole: 'owner', legacyMemoryVenue: true, actorVenue: 'venue-territory' }, 200);
await exercise('memory', { actorRole: 'owner', legacyMemoryVenue: true, actorVenue: venueB }, 404);
await exercise('pg', { changedRole: 'owner' }, 404);
console.log(JSON.stringify({ status: 'PASS', scenarios, scope: 'actual PIN handler in VM; controlled SQL double; no live API/DB' }));
