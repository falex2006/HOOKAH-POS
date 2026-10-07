import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { validateQaDatabaseUrl } from './postgres-qa-safety.mjs';

// Run against memory by default. PG mode requires an already migrated, isolated
// local shifts_qa database; neither application ports nor external DBs are used.
const databaseUrl = process.env.SHIFT_NOTIFICATIONS_TEST_DATABASE_URL || '';
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const organizationId = randomUUID();
let venueA = randomUUID();
let venueB = randomUUID();
const ownerId = randomUUID();
const triggerName = `shift_audit_qa_${suffix}`;
const root = fileURLToPath(new URL('../', import.meta.url));
let database, child, triggerInstalled = false;
const tokens = new Set();
const listener = net.createServer();
listener.listen(0, '127.0.0.1');
await once(listener, 'listening');
const port = listener.address().port;
await new Promise((resolve) => listener.close(resolve));
const base = `http://127.0.0.1:${port}`;

const request = async (path, { token, method = 'GET', body } = {}) => {
  const response = await fetch(base + path, {
    method, signal: AbortSignal.timeout(15000),
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return { status: response.status, payload: await response.json().catch(() => ({})) };
};
const expect = (response, status, label) => {
  assert.equal(response.status, status, `${label}: ${JSON.stringify(response.payload)}`);
  return response.payload;
};
const start = async () => {
  let output = '';
  child = spawn(process.execPath, ['server.js'], {
    cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DATABASE_URL: databaseUrl,
      AUTH_REQUIRED: 'true', DEMO_MODE: 'true', VENUE_ID: databaseUrl ? venueA : '00000000-0000-0000-0000-000000000001',
      DEMO_OWNER_PASSWORD: 'demo', DEMO_ADMIN_PASSWORD: 'admin', DEMO_STAFF_PASSWORD: 'demo' }
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`QA server startup timeout: ${output}`)), 15000);
    const finish = (error) => { clearTimeout(timer); error ? reject(error) : resolve(); };
    child.stdout.on('data', (chunk) => { output += chunk; if (output.includes('CRM running on')) finish(); });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.once('error', finish);
    child.once('exit', (code) => finish(new Error(`QA server exited ${code}: ${output}`)));
  });
};
const stop = async () => {
  if (!child || child.exitCode !== null) return;
  const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
  child = null;
};
const login = async (username) => {
  const result = expect(await request('/api/login', { method: 'POST', body: { username, password: 'demo' } }), 200, 'login');
  tokens.add(result.token); return result.token;
};
const feed = async (token) => expect(await request('/api/notifications?limit=100', { token }), 200, 'notification feed');
const events = (payload) => payload.items.filter((item) => ['shift_opened', 'shift_closed'].includes(item.type));
const open = (token, openingCash = 100.25) => request('/api/shifts', { token, method: 'POST', body: { openingCash } });
const close = (token, id, closingCash = 100.25) => request(`/api/shifts/${encodeURIComponent(id)}/close`, {
  token, method: 'POST', body: { closingCash, checklistConfirmed: true }
});
const select = async (token, venueId) => expect(await request(`/api/network/venues/${encodeURIComponent(venueId)}/select`, { token, method: 'POST' }), 200, 'select venue');
const installAuditFailure = async () => {
  // The trigger affects only this run's venue and shift audit rows. UUID/name
  // originate here, never from user input; cleanup always removes both objects.
  await database.query(`CREATE FUNCTION ${triggerName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.venue_id='${venueA}'::uuid AND NEW.action IN ('shift.opened','shift.closed') THEN
      RAISE EXCEPTION 'isolated_shift_qa_audit_failure';
    END IF; RETURN NEW; END $$`);
  triggerInstalled = true;
  await database.query(`CREATE TRIGGER ${triggerName} BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION ${triggerName}()`);
};
const removeAuditFailure = async () => {
  if (!database || !triggerInstalled) return;
  await database.query(`DROP TRIGGER IF EXISTS ${triggerName} ON audit_events`);
  await database.query(`DROP FUNCTION IF EXISTS ${triggerName}()`);
  triggerInstalled = false;
};

try {
  if (databaseUrl) {
    const target = validateQaDatabaseUrl(databaseUrl, 'SHIFT_NOTIFICATIONS_TEST_DATABASE_URL');
    assert.match(target.database, /^shifts_qa(?:_|$)/i, 'only a disposable shifts_qa database is allowed');
    const { Client } = createRequire(import.meta.url)('pg');
    database = new Client({ connectionString: databaseUrl });
    await database.connect();
    const identity = (await database.query('SELECT current_database() AS name')).rows[0];
    assert.equal(identity.name, target.database, 'connected database matches the guarded URL');
    await database.query(`INSERT INTO organizations(id,name,slug,plan) VALUES($1,'Shift notification QA',$2,'network')`, [organizationId, `shifts-qa-${suffix}`]);
    await database.query(`INSERT INTO organization_subscriptions(organization_id,plan,status,seats_limit,venues_limit) VALUES($1,'network','active',30,10)`, [organizationId]);
    await database.query(`INSERT INTO venues(id,organization_id,name,city,address) VALUES($1,$3,'Shift QA A','QA','QA'),($2,$3,'Shift QA B','QA','QA')`, [venueA, venueB, organizationId]);
    await database.query(`INSERT INTO users(id,venue_id,organization_id,full_name,login,password_hash,role) VALUES($1,$2,$3,'Shift QA Owner',$4,'demo','owner')`, [ownerId, venueA, organizationId, `shift_owner_${suffix}`]);
    await database.query(`INSERT INTO organization_memberships(organization_id,user_id,membership_role) VALUES($1,$2,'owner')`, [organizationId, ownerId]);
  }
  await start();
  const owner = await login(databaseUrl ? `shift_owner_${suffix}` : 'owner');
  const addAccount = async (label, role, permissionScopes) => {
    const username = `shift_${label}_${suffix}`;
    expect(await request('/api/staff', { token: owner, method: 'POST', body: {
      name: `Shift QA ${label}`, login: username, password: 'demo', birthDate: '1990-01-01', role,
      ...(permissionScopes ? { permissionScopes } : {})
    } }), 201, `create ${label}`);
    return login(username);
  };
  const admin = await addAccount('admin', 'admin');
  const manager = await addAccount('manager', 'manager');
  const employee = await addAccount('employee', 'hookah_master');
  const finance = await addAccount('finance', 'admin', ['finance']);
  const settings = await addAccount('settings', 'admin', ['settings']);
  if (!databaseUrl) {
    const venues = expect(await request('/api/network/venues', { token: owner }), 200, 'venues');
    venueA = venues.items.find((item) => item.isCurrent).id;
    venueB = expect(await request('/api/network/venues', { token: owner, method: 'POST', body: { name: 'Shift QA B', city: 'QA', address: 'QA' } }), 201, 'second venue').id;
  }
  for (const token of [employee, settings]) {
    expect(await request('/api/notifications', { token }), 403, 'restricted notification feed');
  }
  expect(await open(finance), 403, 'finance-only admin cannot mutate a shift');
  expect(await request('/api/shifts', { token: owner, method: 'POST', body: {} }), 400, 'opening amount is required');
  const invalidAmounts = [null, true, false, [], {}, '', '   ', -1, 100000001, 0.001, '1.001'];
  for (const value of invalidAmounts) expect(await open(owner, value), 400, `invalid opening amount ${JSON.stringify(value)}`);
  assert.equal(events(await feed(owner)).length, 0, 'invalid inputs produce no events');

  const openingRace = await Promise.all([open(owner), open(employee)]);
  assert.deepEqual(openingRace.map((r) => r.status).sort(), [201, 409], 'one concurrent opening succeeds');
  const shift = openingRace.find((r) => r.status === 201).payload;
  assert.equal(Number(shift.openingCash), 100.25);
  const employeeState = expect(await request('/api/shifts', { token: employee }), 200, 'employee can read current shift');
  assert.equal(employeeState.current.id, shift.id);
  assert.equal(Object.hasOwn(employeeState.current, 'openedByName'), false, 'employee does not receive management-only opener identity');
  const openedFeed = await feed(owner);
  const openedEvent = events(openedFeed)[0];
  assert.equal(events(openedFeed).length, 1, 'one event per successful opening');
  assert.equal(openedEvent.type, 'shift_opened'); assert.equal(openedEvent.shiftId, shift.id);
  const allowedFields = new Set(['id', 'type', 'title', 'summary', 'createdAt', 'shiftId', 'readAt', 'href', 'requiresAction']);
  for (const token of [owner, admin, manager, finance]) {
    const item = events(await feed(token))[0];
    assert.equal(item.id, openedEvent.id, 'all authorized recipients see the same stable event');
    assert.equal(item.readAt, null);
    for (const key of Object.keys(item)) assert.ok(allowedFields.has(key), `event must not expose cash/private data: ${key}`);
  }
  assert.deepEqual(events(await feed(owner)).map((item) => item.id), [openedEvent.id], 'polling never duplicates events');
  expect(await request(`/api/shifts/${encodeURIComponent(shift.id)}/close`, { token: owner, method: 'POST', body: { closingCash: 100.25 } }), 400, 'closing checklist is required');
  for (const value of invalidAmounts) expect(await close(owner, shift.id, value), 400, `invalid closing amount ${JSON.stringify(value)}`);
  assert.equal(events(await feed(owner)).length, 1, 'failed close validation produces no event');

  if (databaseUrl) {
    await select(owner, venueB);
  assert.equal(expect(await request('/api/shifts', { token: owner }), 200, 'venue B shift').current, null, 'A shift is not returned in B');
  assert.equal(events(await feed(owner)).length, 0, 'no A notification in B');
  expect(await close(owner, shift.id), 404, 'cross-venue close denied');
  expect(await request(`/api/notifications/${encodeURIComponent(openedEvent.id)}/read`, { token: owner, method: 'PUT' }), 404, 'cross-venue receipt denied');
  const second = expect(await open(owner, 0), 201, 'independent B shift');
  const bEvent = events(await feed(owner))[0];
  assert.notEqual(bEvent.id, openedEvent.id);
  const bStatus = expect(await request('/api/shifts', { token: owner }), 200, 'B reread');
  assert.ok(bStatus.current.openedByName, 'management opener remains visible when home venue differs');
  assert.equal(events(await feed(admin)).some((item) => item.id === bEvent.id), false, 'admin A cannot see B events');
    expect(await close(owner, second.id, 0), 200, 'close B');
    await select(owner, venueA);
    assert.equal(expect(await request('/api/shifts', { token: owner }), 200, 'A reread').current.id, shift.id);
  }

  const closingRace = await Promise.all([close(owner, shift.id), close(employee, shift.id)]);
  assert.deepEqual(closingRace.map((r) => r.status).sort(), [200, 404], 'one concurrent close succeeds');
  const closed = closingRace.find((r) => r.status === 200).payload;
  assert.equal(Number(closed.expectedCash), 100.25); assert.equal(Number(closed.cashVariance), 0);
  const afterClose = events(await feed(owner));
  assert.equal(afterClose.length, 2, 'duplicate close produces no extra notification');
  assert.equal(afterClose.filter((item) => item.type === 'shift_closed').length, 1);
  const employeeClosed = expect(await request('/api/shifts', { token: employee }), 200, 'employee closed state');
  assert.equal(employeeClosed.current, null); assert.deepEqual(employeeClosed.items, [], 'employee receives no historical shift amounts');
  expect(await request(`/api/notifications/${encodeURIComponent(openedEvent.id)}/read`, { token: owner, method: 'PUT', body: { userId: 'forged', venueId: venueB } }), 200, 'owner single read');
  assert.ok(events(await feed(owner)).find((item) => item.id === openedEvent.id).readAt, 'single read persists on an independent GET');
  assert.equal(events(await feed(manager)).filter((item) => !item.readAt).length, 2, 'receipts remain independent');
  expect(await request('/api/notifications', { token: admin, method: 'POST', body: { userId: 'forged', venueId: venueB } }), 200, 'admin read all');
  assert.equal(events(await feed(admin)).filter((item) => !item.readAt).length, 0);
  assert.equal(events(await feed(owner)).filter((item) => !item.readAt).length, 1, 'another user read-all leaves owner unread unchanged');

  if (database) {
    await installAuditFailure();
    expect(await open(owner), 409, 'failed audit rolls back shift opening');
    assert.equal(expect(await request('/api/shifts', { token: owner }), 200, 'after audit failure').current, null);
    assert.equal(events(await feed(owner)).length, 2);
    await removeAuditFailure();
    const third = expect(await open(owner), 201, 'open after trigger removal');
    await installAuditFailure();
    expect(await close(owner, third.id), 409, 'failed audit rolls back shift closing');
    assert.equal(expect(await request('/api/shifts', { token: owner }), 200, 'close rollback reread').current.id, third.id);
    assert.equal(events(await feed(owner)).length, 3);
    await removeAuditFailure();
    const beforeRestart = events(await feed(owner));
    const adminBeforeRestart = events(await feed(admin));
    await stop(); await start();
    assert.equal(expect(await request('/api/shifts', { token: owner }), 200, 'shift survives restart').current.id, third.id);
    assert.deepEqual(events(await feed(owner)), beforeRestart, 'event IDs/unread/read survive restart');
    assert.deepEqual(events(await feed(admin)), adminBeforeRestart, 'other user receipt survives restart');
    expect(await close(owner, third.id), 200, 'close persisted shift');
  }
  console.log(`SHIFT NOTIFICATIONS E2E QA: PASS (${database ? 'PostgreSQL, transactional audit rollback and restart persistence' : 'isolated memory'}; role/privacy checks, valid money, duplicate races, stable events, two venues, per-user read/read-all)`);
} finally {
  if (child && child.exitCode === null) {
    await Promise.allSettled([...tokens].map((token) => request('/api/logout', { token, method: 'POST' })));
  }
  await stop();
  if (database) {
    try {
      await removeAuditFailure();
      await database.query('DELETE FROM notification_reads WHERE venue_id=ANY($1::uuid[])', [[venueA, venueB]]);
      await database.query('DELETE FROM audit_events WHERE venue_id=ANY($1::uuid[])', [[venueA, venueB]]);
      await database.query('DELETE FROM shifts WHERE venue_id=ANY($1::uuid[])', [[venueA, venueB]]);
      await database.query('DELETE FROM auth_sessions WHERE user_id IN (SELECT id FROM users WHERE organization_id=$1)', [organizationId]);
      await database.query('DELETE FROM users WHERE organization_id=$1', [organizationId]);
      await database.query('DELETE FROM venues WHERE organization_id=$1', [organizationId]);
      await database.query('DELETE FROM organizations WHERE id=$1', [organizationId]);
    } finally { await database.end(); }
  }
}
