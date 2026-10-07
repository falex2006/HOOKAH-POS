import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID, randomBytes, scrypt as scryptCallback } from 'node:crypto';
import { promisify } from 'node:util';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertQaDatabaseIdentity, isDisposableLoopbackQaContainer, validateQaDatabaseUrl } from './postgres-qa-safety.mjs';

const { database, url } = validateQaDatabaseUrl(process.env.MIGRATIONS_PG_TEST_DATABASE_URL, 'MIGRATIONS_PG_TEST_DATABASE_URL');
assert.match(database, /^orders_qa_[a-f0-9]{16}$/i, 'department boundary fixtures require a runner-created disposable database');
assert.equal(database, process.env.LOCAL_FULL_PG_OWNED_DATABASE, 'department boundary QA must use the exact database created by the local runner');
assert.equal(process.env.MIGRATIONS_PG_TEST_DOCKER_CONTAINER, 'hookah-full-regression-qa-20261001', 'department boundary QA must use the verified disposable PostgreSQL runner');
const require = createRequire(import.meta.url);
const { Client } = require('pg');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const client = new Client({ connectionString: url.href, connectionTimeoutMillis: 5000 });
const orgA = randomUUID(), orgB = randomUUID();
const venueA1 = randomUUID(), venueA2 = randomUUID(), venueB = randomUUID();
const ownerA = randomUUID(), writeManagerA = randomUUID(), readManagerA = randomUUID(), bartenderA = randomUUID();
const siblingOwner = randomUUID(), foreignOwner = randomUUID();
const password = `qa-${randomUUID()}`;
const loginPrefix = `inventory-department-${randomUUID()}`;
const users = [
  { id: ownerA, venue: venueA1, org: orgA, role: 'owner', suffix: 'owner-a', scopes: [] },
  { id: writeManagerA, venue: venueA1, org: orgA, role: 'manager', suffix: 'write-manager-a', scopes: ['inventory'] },
  { id: readManagerA, venue: venueA1, org: orgA, role: 'manager', suffix: 'read-manager-a', scopes: ['inventory_read'] },
  { id: bartenderA, venue: venueA1, org: orgA, role: 'bartender', suffix: 'bartender-a', scopes: ['orders'] },
  { id: siblingOwner, venue: venueA2, org: orgA, role: 'owner', suffix: 'sibling-owner', scopes: [] },
  { id: foreignOwner, venue: venueB, org: orgB, role: 'owner', suffix: 'foreign-owner', scopes: [] },
].map((user) => ({ ...user, login: `${loginPrefix}-${user.suffix}` }));
const passwordSalt = randomBytes(16).toString('hex');
const passwordHash = `scrypt$${passwordSalt}$${(await promisify(scryptCallback)(password, passwordSalt, 64)).toString('hex')}`;
let server, exitWait, output = '', base = '', checks = 0;

const api = async (route, method = 'GET', body, token = '', expected = 200) => {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  assert.equal(response.status, expected, `${method} ${route}: ${JSON.stringify(payload)}`);
  checks++;
  return payload;
};
const login = async (suffix) => (await api('/api/login', 'POST', { username: `${loginPrefix}-${suffix}`, password }, '', 200)).token;
const readDepartment = async (venueId, code) => {
  const { rows } = await client.query(`SELECT venue_id AS "venueId",code,name,description,color,sort_order AS "sortOrder",is_active AS active
    FROM inventory_departments WHERE venue_id=$1 AND code=$2`, [venueId, code]);
  checks++;
  return rows[0] || null;
};
const departmentCreateAuditCount = async (venueId, code) => Number((await client.query(`SELECT count(*)::int AS count FROM audit_events
  WHERE venue_id=$1 AND action='inventory.department_created' AND entity_type='inventory_department' AND after_data->>'code'=$2`, [venueId, code])).rows[0].count);
const waitForDepartmentCreateAudit = async (venueId, code, expected) => {
  const auditDeadline = Date.now() + 2000;
  let count = await departmentCreateAuditCount(venueId, code);
  while (count !== expected && Date.now() < auditDeadline) { await delay(20); count = await departmentCreateAuditCount(venueId, code); }
  return count;
};
const assertDepartmentCodeAbsent = async (code, label) => {
  for (const venueId of [venueA1, venueA2, venueB]) assert.equal(await readDepartment(venueId, code), null, `${label}: no department row in venue ${venueId}`);
};
const restoreDepartmentUrl = (code) => `/api/inventory/departments/${encodeURIComponent(code)}/restore`;


try {
  await client.connect();
  const identity = (await client.query(`SELECT current_database() AS database,inet_server_addr()::text AS address,
    inet_server_port() AS port,COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname=current_user),false) AS superuser`)).rows[0];
  const containerInspection = spawnSync('docker', ['inspect', process.env.MIGRATIONS_PG_TEST_DOCKER_CONTAINER], { encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024 });
  assert.equal(containerInspection.status, 0, 'verified disposable PostgreSQL runner container must be inspectable');
  const [runnerContainer] = JSON.parse(containerInspection.stdout);
  assert.equal(runnerContainer?.Name, '/hookah-full-regression-qa-20261001', 'fixtures must target the exact owned QA container');
  assert.ok(isDisposableLoopbackQaContainer(runnerContainer, String(identity.address), Number(identity.port), Number(url.port || 5432)),
    'department boundary fixtures require a direct connection to the disposable runner container, never a persistent loopback PostgreSQL service');
  assertQaDatabaseIdentity(identity, database, Number(url.port || 5432), 'Inventory department authenticated boundary QA');

  await client.query('BEGIN');
  await client.query(`INSERT INTO organizations(id,name,slug,plan) VALUES($1,'Inventory Department QA A',$3,'network'),($2,'Inventory Department QA B',$4,'network')`,
    [orgA, orgB, `inventory-dept-${orgA}`, `inventory-dept-${orgB}`]);
  await client.query(`INSERT INTO organization_subscriptions(organization_id,plan,status,seats_limit,venues_limit)
    VALUES($1,'network','active',20,5),($2,'network','active',20,5)`, [orgA, orgB]);
  await client.query(`INSERT INTO venues(id,organization_id,name,timezone) VALUES
    ($1,$4,'Inventory Department QA A1','Asia/Yekaterinburg'),($2,$4,'Inventory Department QA A2','Asia/Yekaterinburg'),
    ($3,$5,'Inventory Department QA B','Asia/Yekaterinburg')`, [venueA1, venueA2, venueB, orgA, orgB]);
  for (const user of users) {
    await client.query(`INSERT INTO users(id,venue_id,organization_id,full_name,login,password_hash,role,permission_scopes)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
    [user.id, user.venue, user.org, `Inventory Department QA ${user.suffix}`, user.login, passwordHash, user.role, JSON.stringify(user.scopes)]);
    await client.query('INSERT INTO organization_memberships(organization_id,user_id,membership_role,status) VALUES($1,$2,$3,\'active\')',
      [user.org, user.id, user.role === 'owner' ? 'owner' : 'member']);
  }
  await client.query('COMMIT');

  server = spawn(process.execPath, ['server.js'], {
    cwd: root, windowsHide: true,
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', DATABASE_URL: url.href, VENUE_ID: venueA1, AUTH_REQUIRED: 'true', COOKIE_SECURE: 'false', NODE_ENV: 'test', API_RATE_LIMIT: '5000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  exitWait = new Promise((resolve) => server.once('exit', resolve));
  server.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
  server.stderr.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
  const deadline = Date.now() + 20000;
  while (!base && Date.now() < deadline) {
    const match = output.match(/CRM running on http:\/\/localhost:(\d+)/);
    if (match) base = `http://127.0.0.1:${match[1]}`;
    else if (server.exitCode !== null) throw new Error(`QA server exited: ${output}`);
    else await delay(50);
  }
  assert.ok(base, 'authenticated QA server started');
  assert.equal((await api('/api/health')).database, 'postgres');

  const ownerToken = await login('owner-a');
  const writeToken = await login('write-manager-a');
  const readToken = await login('read-manager-a');
  const bartenderToken = await login('bartender-a');
  const siblingToken = await login('sibling-owner');
  const foreignToken = await login('foreign-owner');
  const deniedCreates = [
    { label: 'no session', token: '', expected: 401 },
    { label: 'inventory_read manager', token: readToken, expected: 403 },
    { label: 'bartender', token: bartenderToken, expected: 403 },
  ];
  for (const denied of deniedCreates) {
    const attemptedCode = `qa-denied-${randomUUID().slice(0, 8)}`;
    const response = await api('/api/inventory/departments', 'POST', { code: attemptedCode, name: `Denied ${denied.label}` }, denied.token, denied.expected);
    if (denied.expected === 403) assert.equal(response.error, 'forbidden', `${denied.label} create is rejected by scope`);
    else assert.ok(response.error, `${denied.label} create is rejected by authentication`);
    checks++;
    await assertDepartmentCodeAbsent(attemptedCode, `${denied.label} create has no persisted side effects`);
    for (const venueId of [venueA1, venueA2, venueB]) {
      assert.equal(await departmentCreateAuditCount(venueId, attemptedCode), 0, `${denied.label} create emits no audit in venue ${venueId}`);
      checks++;
    }
  }
  const venueOwnerTokens = [
    { venueId: venueA1, token: ownerToken },
    { venueId: venueA2, token: siblingToken },
    { venueId: venueB, token: foreignToken },
  ];
  for (const scopedCreate of [
    { label: 'sibling venue owner', venueId: venueA2, token: siblingToken },
    { label: 'foreign organization owner', venueId: venueB, token: foreignToken },
  ]) {
    const scopedCode = `qa-owned-${randomUUID().slice(0, 8)}`;
    const payload = { code: scopedCode, name: `Created by ${scopedCreate.label}`, description: 'Authenticated venue binding', color: 'green', sortOrder: 31 };
    const scopedCreated = await api('/api/inventory/departments', 'POST', payload, scopedCreate.token, 201);
    assert.deepEqual(scopedCreated, { id: scopedCode, ...payload, active: true }, `${scopedCreate.label} receives a normalized create response`); checks++;
    assert.deepEqual(await readDepartment(scopedCreate.venueId, scopedCode), { venueId: scopedCreate.venueId, ...payload, active: true }, `${scopedCreate.label} creation persists only to its authenticated venue`);
    const scopedReadback = await api('/api/inventory/departments?status=active', 'GET', undefined, scopedCreate.token);
    assert.equal(scopedReadback.items.some((item) => item.code === scopedCode), true, `${scopedCreate.label} sees its created department after a fresh GET`); checks++;
    assert.equal(await waitForDepartmentCreateAudit(scopedCreate.venueId, scopedCode, 1), 1, `${scopedCreate.label} create writes one venue-scoped audit event`); checks++;
    for (const otherVenue of venueOwnerTokens.filter((candidate) => candidate.venueId !== scopedCreate.venueId)) {
      assert.equal(await readDepartment(otherVenue.venueId, scopedCode), null, `${scopedCreate.label} creates no row in venue ${otherVenue.venueId}`);
      const otherList = await api('/api/inventory/departments?status=active', 'GET', undefined, otherVenue.token);
      assert.equal(otherList.items.some((item) => item.code === scopedCode), false, `${scopedCreate.label} department is hidden from venue ${otherVenue.venueId}`); checks++;
      assert.equal(await departmentCreateAuditCount(otherVenue.venueId, scopedCode), 0, `${scopedCreate.label} create emits no audit in venue ${otherVenue.venueId}`); checks++;
    }
  }
  const code = `qa-dept-${randomUUID().slice(0, 8)}`;
  const ownerCreatePayload = {
    code, name: 'Цех QA до изменения', description: 'Исходное описание', color: 'amber', sortOrder: 17,
  };
  const created = await api('/api/inventory/departments', 'POST', ownerCreatePayload, ownerToken, 201);
  assert.equal(created.code, code); checks++;
  assert.deepEqual(await readDepartment(venueA1, code), { venueId: venueA1, ...ownerCreatePayload, active: true }, 'owner create is persisted in its authenticated venue');
  assert.equal(await waitForDepartmentCreateAudit(venueA1, code, 1), 1, 'owner create writes one audit event'); checks++;

  const editable = { name: 'Цех QA переименован', description: 'Полное обновлённое описание', color: 'violet', sortOrder: 23 };
  const renamed = await api(`/api/inventory/departments/${encodeURIComponent(code)}`, 'PATCH', editable, writeToken, 200);
  assert.deepEqual([renamed.name, renamed.description, renamed.color, renamed.sortOrder, renamed.active],
    [editable.name, editable.description, editable.color, editable.sortOrder, true]); checks++;
  assert.deepEqual(await readDepartment(venueA1, code), {
    venueId: venueA1, code, ...editable, active: true,
  }, 'authorized manager update is persisted under the authenticated venue');

  const stable = await readDepartment(venueA1, code);
  for (const [label, token] of [['inventory_read manager', readToken], ['bartender without inventory write', bartenderToken]]) {
    const deniedPatch = await api(`/api/inventory/departments/${encodeURIComponent(code)}`, 'PATCH', { ...editable, name: `${label} must not rename` }, token, 403);
    assert.equal(deniedPatch.error, 'forbidden'); checks++;
    const deniedDelete = await api(`/api/inventory/departments/${encodeURIComponent(code)}`, 'DELETE', undefined, token, 403);
    assert.equal(deniedDelete.error, 'forbidden'); checks++;
    assert.deepEqual(await readDepartment(venueA1, code), stable, `${label} denials leave the database unchanged`);
  }
  const noSessionPatch = await api(`/api/inventory/departments/${encodeURIComponent(code)}`, 'PATCH', editable, '', 401);
  assert.ok(noSessionPatch.error, 'PATCH requires an authenticated session'); checks++;
  const noSessionDelete = await api(`/api/inventory/departments/${encodeURIComponent(code)}`, 'DELETE', undefined, '', 401);
  assert.ok(noSessionDelete.error, 'DELETE requires an authenticated session'); checks++;
  assert.deepEqual(await readDepartment(venueA1, code), stable, 'unauthenticated attempts do not change the source department');

  for (const [label, token] of [['sibling venue owner', siblingToken], ['foreign organization owner', foreignToken]]) {
    const scopedList = await api('/api/inventory/departments?status=all', 'GET', undefined, token);
    assert.equal(scopedList.items.some((item) => item.code === code), false, `${label} cannot see the source department in list results`); checks++;
    const hiddenPatch = await api(`/api/inventory/departments/${encodeURIComponent(code)}`, 'PATCH', { ...editable, name: `${label} must not rename` }, token, 404);
    assert.equal(hiddenPatch.error, 'inventory_department_not_found'); checks++;
    const hiddenDelete = await api(`/api/inventory/departments/${encodeURIComponent(code)}`, 'DELETE', undefined, token, 404);
    assert.equal(hiddenDelete.error, 'inventory_department_not_found'); checks++;
    assert.deepEqual(await readDepartment(venueA1, code), stable, `${label} cannot change the source venue department`);
  }

  const activeReadback = await api('/api/inventory/departments?status=active', 'GET', undefined, ownerToken);
  assert.equal(activeReadback.items.some((item) => item.code === code && item.name === editable.name), true, 'updated department is visible after a fresh authenticated GET'); checks++;
  const managerReadback = await api('/api/inventory/departments?status=active', 'GET', undefined, readToken);
  assert.equal(managerReadback.items.some((item) => item.code === code && item.name === editable.name), true, 'inventory_read may view its own venue departments'); checks++;

  const managerArchiveCode = `qa-archive-${randomUUID().slice(0, 8)}`;
  const managerArchiveCreated = await api('/api/inventory/departments', 'POST', {
    code: managerArchiveCode, name: 'Цех для архивации менеджером', description: 'Менеджерский архив', color: 'amber', sortOrder: 24,
  }, ownerToken, 201);
  assert.equal(managerArchiveCreated.code, managerArchiveCode); checks++;
  const blockingCategoryId = randomUUID();
  const blockingCategoryName = `QA department archive guard ${randomUUID().slice(0, 8)}`;
  await client.query('INSERT INTO product_categories(id,venue_id,name,department,subdepartment_id,is_active) VALUES($1,$2,$3,$4,NULL,true)',
    [blockingCategoryId, venueA1, blockingCategoryName, managerArchiveCode]);
  const blockedManagerArchive = await api(`/api/inventory/departments/${encodeURIComponent(managerArchiveCode)}`, 'DELETE', undefined, writeToken, 409);
  assert.equal(blockedManagerArchive.error, 'inventory_department_in_use', 'an active category blocks department archive with the domain error'); checks++;
  assert.deepEqual(await readDepartment(venueA1, managerArchiveCode), {
    venueId: venueA1, code: managerArchiveCode, name: 'Цех для архивации менеджером', description: 'Менеджерский архив', color: 'amber', sortOrder: 24, active: true,
  }, 'rejected archive leaves the department active in PostgreSQL');
  const blockingCategoryReadback = (await client.query('SELECT id,venue_id AS "venueId",name,department,is_active AS active FROM product_categories WHERE id=$1 AND venue_id=$2', [blockingCategoryId, venueA1])).rows[0];
  assert.deepEqual(blockingCategoryReadback, { id: blockingCategoryId, venueId: venueA1, name: blockingCategoryName, department: managerArchiveCode, active: true }); checks++;
  const managerActiveWithCategory = await api('/api/inventory/departments?status=active', 'GET', undefined, readToken);
  assert.equal(managerActiveWithCategory.items.some((item) => item.code === managerArchiveCode && item.active === true), true, 'fresh active list retains the protected department'); checks++;
  const blockedArchiveAuditCount = Number((await client.query(`SELECT count(*)::int AS count FROM audit_events
    WHERE venue_id=$1 AND action='inventory.department_archived' AND entity_type='inventory_department' AND after_data->>'code'=$2`, [venueA1, managerArchiveCode])).rows[0].count);
  assert.equal(blockedArchiveAuditCount, 0, 'rejected archive emits no department-archived audit event'); checks++;
  const removedBlockingCategory = await client.query('DELETE FROM product_categories WHERE id=$1 AND venue_id=$2 AND department=$3 AND is_active=true', [blockingCategoryId, venueA1, managerArchiveCode]);
  assert.equal(removedBlockingCategory.rowCount, 1, 'synthetic blocking category fixture is removed before the positive control'); checks++;
  const managerArchived = await api(`/api/inventory/departments/${encodeURIComponent(managerArchiveCode)}`, 'DELETE', undefined, writeToken, 200);
  assert.equal(managerArchived.active, false, 'inventory manager may archive an unused department'); checks++;
  assert.deepEqual(await readDepartment(venueA1, managerArchiveCode), {
    venueId: venueA1, code: managerArchiveCode, name: 'Цех для архивации менеджером', description: 'Менеджерский архив', color: 'amber', sortOrder: 24, active: false,
  }, 'manager archive is persisted under the authenticated venue');

  const archived = await api(`/api/inventory/departments/${encodeURIComponent(code)}`, 'DELETE', undefined, ownerToken, 200);
  assert.equal(archived.active, false); checks++;
  assert.deepEqual(await readDepartment(venueA1, code), { venueId: venueA1, code, ...editable, active: false }, 'owner archive is stored as an inactive venue-scoped row');
  const archivedReadback = await api('/api/inventory/departments?status=archived', 'GET', undefined, ownerToken);
  assert.equal(archivedReadback.items.some((item) => item.code === code && item.active === false), true, 'archived department is visible after a fresh authenticated GET'); checks++;
  assert.equal((await api(`/api/inventory/departments/${encodeURIComponent(code)}`, 'DELETE', undefined, ownerToken, 404)).error, 'inventory_department_not_found'); checks++;
  assert.equal((await api(`/api/inventory/departments/${encodeURIComponent(code)}`, 'PATCH', editable, ownerToken, 404)).error, 'inventory_department_not_found'); checks++;
  const restoreAuditCount = async () => Number((await client.query(`SELECT count(*)::int AS count FROM audit_events
    WHERE venue_id=$1 AND action='inventory.department_restored' AND entity_type='inventory_department' AND after_data->>'code'=$2`, [venueA1, code])).rows[0].count);
  const waitForRestoreAuditCount = async (expected) => {
    const auditDeadline = Date.now() + 2000;
    let count = await restoreAuditCount();
    while (count !== expected && Date.now() < auditDeadline) { await delay(20); count = await restoreAuditCount(); }
    return count;
  };
  const archivedDepartment = await readDepartment(venueA1, code);
  assert.equal(archivedDepartment.active, false, 'restore fixture begins archived'); checks++;
  assert.equal(await restoreAuditCount(), 0, 'restore fixture has no previous restore audit'); checks++;
  await api(restoreDepartmentUrl(code), 'POST', undefined, '', 401);
  for (const [label, token] of [['inventory_read manager', readToken], ['bartender', bartenderToken]]) {
    const deniedRestore = await api(restoreDepartmentUrl(code), 'POST', undefined, token, 403);
    assert.equal(deniedRestore.error, 'forbidden', `${label} cannot restore departments`); checks++;
  }
  for (const [label, token] of [['sibling venue owner', siblingToken], ['foreign organization owner', foreignToken]]) {
    const hiddenRestore = await api(restoreDepartmentUrl(code), 'POST', undefined, token, 404);
    assert.equal(hiddenRestore.error, 'inventory_archived_entry_not_found', `${label} cannot restore another venue's department`); checks++;
  }
  assert.equal((await api(restoreDepartmentUrl('qa-dept-missing'), 'POST', undefined, ownerToken, 404)).error, 'inventory_archived_entry_not_found'); checks++;
  assert.deepEqual(await readDepartment(venueA1, code), archivedDepartment, 'unauthorized, cross-venue and not-archived restore attempts leave the row unchanged');
  assert.equal(await restoreAuditCount(), 0, 'failed restore attempts emit no restore audit event'); checks++;
  const restoredDepartment = await api(restoreDepartmentUrl(code), 'POST', undefined, writeToken, 200);
  assert.equal(restoredDepartment.active, true, 'authorized inventory manager restores the archived department'); checks++;
  assert.deepEqual(await readDepartment(venueA1, code), { venueId: venueA1, code, ...editable, active: true }, 'restore is persisted only in the source venue');
  const restoredReadback = await api('/api/inventory/departments?status=active', 'GET', undefined, readToken);
  assert.equal(restoredReadback.items.some((item) => item.code === code && item.active === true), true, 'restored department appears in a fresh active list'); checks++;
  const archivedAfterRestore = await api('/api/inventory/departments?status=archived', 'GET', undefined, readToken);
  assert.equal(archivedAfterRestore.items.some((item) => item.code === code), false, 'restored department leaves the archived list'); checks++;
  assert.equal(await waitForRestoreAuditCount(1), 1, 'successful restore writes one audit event keyed by the non-UUID department code'); checks++;
  assert.equal((await api(restoreDepartmentUrl(code), 'POST', undefined, ownerToken, 404)).error, 'inventory_archived_entry_not_found'); checks++;
  assert.equal(await waitForRestoreAuditCount(1), 1, 'replayed restore does not create another audit event'); checks++;

  console.log(`ACCEPTANCE #48 INVENTORY DEPARTMENT BOUNDARIES: PASS (${checks} authenticated API/PG assertions; real session roles, venue/org isolation, denial snapshots and fresh readback)`);
} finally {
  if (server?.pid && server.exitCode === null && server.signalCode === null) {
    const close = new Promise((resolve) => server.once('close', resolve));
    if (process.platform === 'win32') spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `taskkill /PID ${server.pid} /T /F`], { windowsHide: true, stdio: 'ignore' });
    else server.kill('SIGTERM');
    await close;
  }
  await exitWait?.catch(() => {});
  await client.end().catch(() => {});
}
