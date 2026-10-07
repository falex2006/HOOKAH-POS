import assert from 'node:assert/strict';
import { randomBytes, randomUUID, scrypt as scryptCallback } from 'node:crypto';
import { promisify } from 'node:util';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { assertQaDatabaseIdentity, validateQaDatabaseUrl } from './postgres-qa-safety.mjs';

const scrypt = promisify(scryptCallback);
const databaseUrl = process.env.MIGRATIONS_PG_TEST_DATABASE_URL;
const target = validateQaDatabaseUrl(databaseUrl);
const playwrightPath = process.env.PLAYWRIGHT_PACKAGE_PATH;
if (!playwrightPath) throw new Error('Set PLAYWRIGHT_PACKAGE_PATH');
const { chromium } = createRequire(import.meta.url)(playwrightPath);
const db = new pg.Client({ connectionString: databaseUrl });
const marker = randomUUID().slice(0, 8);
const ids = { organization: randomUUID(), venue: randomUUID(), owner: randomUUID(), staff: randomUUID(), manager: randomUUID(), foreignOrganization: randomUUID(), foreignVenue: randomUUID() };
const ownerLogin = `qa_floor_owner_${marker}`;
const staffLogin = `qa_floor_staff_${marker}`;
const managerLogin = `qa_floor_manager_${marker}`;
const password = `qa-floor-${randomUUID()}`;
let connected = false;
let fixturesCreated = false;
let child;
let childExit;
let browser;
let passed = false;
let serverOutput = '';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const closeWithin = async (promise, label, timeoutMs = 5000) => {
  const closed = await Promise.race([Promise.resolve(promise).then(() => true), delay(timeoutMs).then(() => false)]);
  if (!closed) throw new Error(`${label} did not close within ${timeoutMs}ms`);
};
const passwordHash = async (value) => {
  const salt = randomBytes(16).toString('hex');
  const key = await scrypt(value, salt, 64);
  return `scrypt$${salt}$${key.toString('hex')}`;
};
const cleanupChild = async () => {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
  const stopped = await Promise.race([childExit.then(() => true), delay(5000).then(() => false)]);
  if (!stopped) throw new Error('Floor QA server did not stop within 5 seconds');
};
const readCount = async (table, condition, values) => Number((await db.query(`SELECT COUNT(*)::int AS count FROM ${table} WHERE ${condition}`, values)).rows[0].count);

try {
  await db.connect();
  connected = true;
  const identity = await db.query('SELECT current_database() AS database,inet_server_addr()::text AS address,inet_server_port() AS port,rolsuper AS superuser FROM pg_roles WHERE rolname=current_user');
  assertQaDatabaseIdentity(identity.rows[0], target.database, Number(target.url.port || 5432));

  const ownerHash = await passwordHash(password);
  const staffHash = await passwordHash(password);
  const managerHash = await passwordHash(password);
  await db.query('BEGIN');
  try {
    await db.query('INSERT INTO organizations (id,name,slug,plan,timezone,is_active) VALUES ($1,$2,$3,$4,$5,true)', [ids.organization, 'QA Floor Management', `qa-floor-${marker}`, 'starter', 'Asia/Yekaterinburg']);
    await db.query("INSERT INTO organization_subscriptions (organization_id,plan,status,seats_limit,venues_limit,billing_mode) VALUES ($1,'starter','trialing',5,1,'test_free')", [ids.organization]);
    await db.query('INSERT INTO venues (id,organization_id,name,city,format,timezone,is_current,is_active) VALUES ($1,$2,$3,$4,$5,$6,true,true)', [ids.venue, ids.organization, 'QA Floor Venue', 'Тюмень', 'кальян-бар', 'Asia/Yekaterinburg']);
    await db.query("INSERT INTO users (id,organization_id,venue_id,full_name,login,password_hash,role) VALUES ($1,$2,$3,'QA Floor Owner',$4,$5,'owner'),($6,$2,$3,'QA Floor Staff',$7,$8,'bartender'),($9,$2,$3,'QA Floor Manager',$10,$11,'manager')", [ids.owner, ids.organization, ids.venue, ownerLogin, ownerHash, ids.staff, staffLogin, staffHash, ids.manager, managerLogin, managerHash]);
    await db.query("INSERT INTO organization_memberships (organization_id,user_id,membership_role,status,is_primary) VALUES ($1,$2,'owner','active',true),($1,$3,'member','active',false),($1,$4,'member','active',false)", [ids.organization, ids.owner, ids.staff, ids.manager]);
    await db.query('INSERT INTO organizations (id,name,slug,plan,timezone,is_active) VALUES ($1,$2,$3,$4,$5,true)', [ids.foreignOrganization, 'QA Foreign Floor Organization', `qa-floor-foreign-${marker}`, 'starter', 'Asia/Yekaterinburg']);
    await db.query('INSERT INTO venues (id,organization_id,name,city,format,timezone,is_current,is_active) VALUES ($1,$2,$3,$4,$5,$6,true,true)', [ids.foreignVenue, ids.foreignOrganization, 'QA Foreign Venue', 'Тюмень', 'кальян-бар', 'Asia/Yekaterinburg']);
    const foreignZoneId = randomUUID(); const foreignTableId = randomUUID();
    await db.query('INSERT INTO zones (id,venue_id,name) VALUES ($1,$2,$3)', [foreignZoneId, ids.foreignVenue, 'QA Foreign Hall']);
    await db.query('INSERT INTO tables (id,zone_id,name,capacity) VALUES ($1,$2,$3,2)', [foreignTableId, foreignZoneId, 'QA Foreign Table']);
    ids.foreignZone = foreignZoneId; ids.foreignTable = foreignTableId;
    await db.query('COMMIT');
    fixturesCreated = true;
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }

  child = spawn(process.execPath, ['server.js'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    windowsHide: true,
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', DATABASE_URL: databaseUrl, VENUE_ID: ids.venue, AUTH_REQUIRED: 'true', DEMO_MODE: 'false', NODE_ENV: 'test', API_RATE_LIMIT: '10000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  childExit = new Promise((resolve) => child.once('exit', resolve));
  child.stdout.on('data', (chunk) => { serverOutput += chunk; });
  child.stderr.on('data', (chunk) => { serverOutput += chunk; });
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Floor QA server did not start within 15 seconds: ${serverOutput}`)), 15000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    const findAddress = () => {
      const match = serverOutput.match(/CRM running on http:\/\/localhost:(\d+)/);
      if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); }
    };
    child.stdout.on('data', findAddress);
    childExit.then((code) => { if (code !== null) { clearTimeout(timer); reject(new Error(`Floor QA server exited before startup (${code}): ${serverOutput}`)); } });
  });
  const health = await fetch(`${base}/api/health`);
  const healthBody = await health.json();
  assert.equal(health.status, 200, JSON.stringify(healthBody));
  assert.equal(healthBody.database, 'postgres', 'QA app server must be connected to PostgreSQL');

  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  const ownerContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ru-RU' });
  const page = await ownerContext.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => { if (error.message !== 'Transition was aborted because of invalid state. ViewTransition opt-in disabled') pageErrors.push(error.stack || error.message); });
  await page.goto(`${base}/login`, { waitUntil: 'networkidle' });
  await page.locator('#login-username').fill(ownerLogin);
  await page.locator('#login-password').fill(password);
  await page.locator('#login-form button[type="submit"]').click();
  await page.waitForURL((url) => !url.pathname.includes('/login'));
  await page.goto(`${base}/admin#venue-layout-settings`, { waitUntil: 'networkidle' });
  await page.locator('#new-floor-zone').waitFor({ state: 'visible' });
  await page.waitForFunction(() => !document.querySelector('#new-floor-zone')?.disabled);

  const api = async (path, method = 'GET', body, context = ownerContext) => context.request.fetch(`${base}${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, data: body }),
  });
  const initial = await api('/api/floor');
  assert.equal(initial.status(), 200);
  const initialFloor = await initial.json();
  assert.equal(initialFloor.venueId, ids.venue);
  assert.deepEqual(initialFloor.zones, [], 'random disposable venue starts without halls or tables');
  assert.equal(await readCount('zones', 'venue_id=$1', [ids.venue]), 0);
  assert.equal(await readCount('tables', 'zone_id IN (SELECT id FROM zones WHERE venue_id=$1)', [ids.venue]), 0);

  const beforeForeignAudit = await readCount('audit_events', 'venue_id=$1', [ids.venue]);
  for (const [path, method, body, expected] of [
    [`/api/floor/zones/${ids.foreignZone}`, 'PATCH', { expectedVenueId: ids.venue, name: 'forged' }, 'zone_not_found'],
    [`/api/floor/zones/${ids.foreignZone}`, 'DELETE', { expectedVenueId: ids.venue }, 'zone_not_found'],
    [`/api/floor/tables/${ids.foreignTable}`, 'PATCH', { expectedVenueId: ids.venue, name: 'forged' }, 'table_not_found'],
    [`/api/floor/tables/${ids.foreignTable}`, 'DELETE', { expectedVenueId: ids.venue }, 'table_not_found'],
  ]) {
    const response = await api(path, method, body);
    assert.equal(response.status(), 404, `${method} must hide foreign venue records`);
    assert.equal((await response.json()).error, expected);
  }
  assert.equal(await readCount('audit_events', 'venue_id=$1', [ids.venue]), beforeForeignAudit, 'foreign venue denials produce no audit writes');
  assert.deepEqual((await (await api('/api/floor')).json()).zones, [], 'foreign venue hall is not returned in the selected venue floor');

  await page.locator('#new-floor-zone').click();
  await page.locator('#venue-zone-name').fill('QA Основной зал');
  const hallCreate = page.waitForResponse((response) => response.request().method() === 'POST' && response.url().endsWith('/api/floor/zones'));
  await page.locator('#venue-zone-form button[type="submit"]').click();
  const hallResponse = await hallCreate;
  assert.equal(hallResponse.status(), 201);
  const hall = await hallResponse.json();
  assert.equal(hall.name, 'QA Основной зал');
  await page.getByText('Зал создан. Добавьте в него первый стол.').waitFor();
  await page.locator('#venue-room-form').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#venue-room-zone').inputValue(), hall.id, 'first table form targets the newly created hall');

  await page.locator('#venue-room-name').fill('QA Стол 1');
  await page.locator('#venue-room-min-capacity').fill('1');
  await page.locator('#venue-room-max-capacity').fill('100');
  const tableCreate = page.waitForResponse((response) => response.request().method() === 'POST' && response.url().endsWith('/api/floor/tables'));
  await page.locator('#venue-room-submit').click();
  const tableResponse = await tableCreate;
  assert.equal(tableResponse.status(), 201);
  const table = await tableResponse.json();
  assert.equal(table.name, 'QA Стол 1');
  assert.deepEqual([table.minCapacity, table.maxCapacity, table.capacity], [1, 100, 100]);

  const managerContext = await browser.newContext({ viewport: { width: 768, height: 900 }, locale: 'ru-RU' });
  const managerLoginResponse = await managerContext.request.post(`${base}/api/login`, { data: { username: managerLogin, password } });
  assert.equal(managerLoginResponse.status(), 200, 'manager fixture can authenticate');
  const managerTableEdit = await managerContext.request.fetch(`${base}/api/floor/tables/${table.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, data: { expectedVenueId: ids.venue, layout: { x: 120, y: 80 } } });
  assert.equal(managerTableEdit.status(), 200, 'manager with settings permission can update floor layout');
  assert.deepEqual((await db.query('SELECT layout->>\'x\' AS x,layout->>\'y\' AS y FROM tables WHERE id=$1', [table.id])).rows[0], { x: '120', y: '80' }, 'manager floor edit persists in the tenant PostgreSQL table');
  await managerContext.close();
  await page.locator('[data-room-edit]').waitFor();
  const createdRows = await db.query('SELECT z.id AS zone_id,z.name AS zone_name,t.id AS table_id,t.name AS table_name,t.capacity,t.min_capacity,t.max_capacity,t.status::text AS status FROM zones z JOIN tables t ON t.zone_id=z.id WHERE z.venue_id=$1', [ids.venue]);
  assert.deepEqual(createdRows.rows, [{ zone_id: hall.id, zone_name: 'QA Основной зал', table_id: table.id, table_name: 'QA Стол 1', capacity: 100, min_capacity: 1, max_capacity: 100, status: 'free' }], 'browser-created hall/table and guest range are stored in PostgreSQL');

  const beforeInvalid = await db.query('SELECT id,name,capacity,min_capacity,max_capacity FROM tables WHERE id=$1', [table.id]);
  const zoneCountBeforeInvalid = await readCount('zones', 'venue_id=$1', [ids.venue]);
  const tableCountBeforeInvalid = await readCount('tables', 'zone_id IN (SELECT id FROM zones WHERE venue_id=$1)', [ids.venue]);
  const invalidRanges = [
    { name: 'QA invalid reversed', capacity: 1, minCapacity: 2, maxCapacity: 1 },
    { name: 'QA invalid zero', capacity: 1, minCapacity: 0, maxCapacity: 1 },
    { name: 'QA invalid over 100', capacity: 101, minCapacity: 1, maxCapacity: 101 },
  ];
  for (const range of invalidRanges) {
    const response = await api('/api/floor/tables', 'POST', { expectedVenueId: ids.venue, zoneId: hall.id, minimumOrderTotal: 0, ...range });
    assert.equal(response.status(), 400, `${range.name} must be rejected: ${await response.text()}`);
  }
  const invalidEdit = await api(`/api/floor/tables/${table.id}`, 'PATCH', { expectedVenueId: ids.venue, name: 'Should not persist', capacity: 1, minCapacity: 1, maxCapacity: 101 });
  assert.equal(invalidEdit.status(), 400, 'invalid table edit must be rejected');
  assert.equal(await readCount('zones', 'venue_id=$1', [ids.venue]), zoneCountBeforeInvalid, 'invalid ranges add no halls');
  assert.equal(await readCount('tables', 'zone_id IN (SELECT id FROM zones WHERE venue_id=$1)', [ids.venue]), tableCountBeforeInvalid, 'invalid ranges add no tables');
  assert.deepEqual((await db.query('SELECT id,name,capacity,min_capacity,max_capacity FROM tables WHERE id=$1', [table.id])).rows, beforeInvalid.rows, 'invalid table edit changes no database row');

  const staffContext = await browser.newContext({ viewport: { width: 375, height: 800 }, locale: 'ru-RU' });
  const staffLoginResponse = await staffContext.request.post(`${base}/api/login`, { data: { username: staffLogin, password } });
  assert.equal(staffLoginResponse.status(), 200);
  const staffPage = await staffContext.newPage();
  const staffToken = (await staffLoginResponse.json()).token;
  const staffMutation = await fetch(`${base}/api/floor/zones`, { method: 'POST', headers: { Authorization: `Bearer ${staffToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedVenueId: ids.venue, name: 'QA forbidden staff hall' }) });
  assert.equal(staffMutation.status, 403, 'bartender without settings permission cannot mutate halls');
  const staffTableMutation = await fetch(`${base}/api/floor/tables`, { method: 'POST', headers: { Authorization: `Bearer ${staffToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedVenueId: ids.venue, zoneId: hall.id, name: 'QA forbidden staff table', capacity: 2, minCapacity: 1, maxCapacity: 2 }) });
  assert.equal(staffTableMutation.status, 403, 'bartender without settings permission cannot mutate tables');
  assert.equal(await readCount('zones', 'venue_id=$1', [ids.venue]), zoneCountBeforeInvalid, 'denied staff calls add no halls');
  assert.equal(await readCount('tables', 'zone_id IN (SELECT id FROM zones WHERE venue_id=$1)', [ids.venue]), tableCountBeforeInvalid, 'denied staff calls add no tables');
  const staffDenied = await staffContext.request;
  const staffAuditBefore = await readCount('audit_events', 'venue_id=$1', [ids.venue]);
  for (const [path, method, body] of [
    [`/api/floor/zones/${hall.id}`, 'PATCH', { expectedVenueId: ids.venue, name: 'forbidden edit' }],
    [`/api/floor/zones/${hall.id}`, 'DELETE', { expectedVenueId: ids.venue }],
    [`/api/floor/tables/${table.id}`, 'PATCH', { expectedVenueId: ids.venue, name: 'forbidden edit' }],
    [`/api/floor/tables/${table.id}`, 'DELETE', { expectedVenueId: ids.venue }],
  ]) {
    const response = await staffDenied.fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json' }, data: body });
    assert.equal(response.status(), 403, `bartender ${method} is denied settings mutation`);
  }
  assert.equal(await readCount('audit_events', 'venue_id=$1', [ids.venue]), staffAuditBefore, 'denied bartender updates/deletes produce no audit writes');
  await staffContext.close();

  const beforeStale = await db.query('SELECT id,name,sort_order FROM zones WHERE venue_id=$1 ORDER BY id', [ids.venue]);
  const staleMutation = await api('/api/floor/zones', 'POST', { expectedVenueId: randomUUID(), name: 'QA stale hall' });
  assert.equal(staleMutation.status(), 409, 'stale expectedVenueId is rejected');
  assert.equal((await staleMutation.json()).error, 'venue_context_changed');
  assert.deepEqual((await db.query('SELECT id,name,sort_order FROM zones WHERE venue_id=$1 ORDER BY id', [ids.venue])).rows, beforeStale.rows, 'stale venue rejection leaves no partial hall rows');
  assert.equal(await readCount('tables', 'zone_id IN (SELECT id FROM zones WHERE venue_id=$1)', [ids.venue]), tableCountBeforeInvalid, 'stale venue rejection leaves table rows unchanged');
  const staleHallPatch = await api(`/api/floor/zones/${hall.id}`, 'PATCH', { expectedVenueId: randomUUID(), name: 'QA stale hall edit' });
  const staleHallDelete = await api(`/api/floor/zones/${hall.id}`, 'DELETE', { expectedVenueId: randomUUID() });
  const staleTablePatch = await api(`/api/floor/tables/${table.id}`, 'PATCH', { expectedVenueId: randomUUID(), name: 'QA stale table edit' });
  const staleTableDelete = await api(`/api/floor/tables/${table.id}`, 'DELETE', { expectedVenueId: randomUUID() });
  for (const response of [staleHallPatch, staleHallDelete, staleTablePatch, staleTableDelete]) {
    assert.equal(response.status(), 409, 'stale venue blocks every hall/table edit and delete');
    assert.equal((await response.json()).error, 'venue_context_changed');
  }
  assert.equal(await readCount('zones', 'venue_id=$1', [ids.venue]), zoneCountBeforeInvalid, 'stale edit/delete leaves hall rows unchanged');
  assert.equal(await readCount('tables', 'zone_id IN (SELECT id FROM zones WHERE venue_id=$1)', [ids.venue]), tableCountBeforeInvalid, 'stale edit/delete leaves table rows unchanged');

  await page.locator(`[data-zone-edit="${hall.id}"]`).click();
  await page.locator('.action-modal[role="dialog"] [name="name"]').fill('QA Зал переименован');
  const hallPatch = page.waitForResponse((response) => response.request().method() === 'PATCH' && response.url().endsWith(`/api/floor/zones/${hall.id}`));
  await page.locator('.action-modal[role="dialog"] button[type="submit"]').click();
  assert.equal((await hallPatch).status(), 200, 'hall edit completes through the settings UI');
  await page.locator('[data-zone="' + hall.id + '"] h3').getByText('QA Зал переименован').waitFor();
  await page.locator(`[data-room-edit="${table.id}"]`).click();
  const tableDialog = page.locator('.action-modal[role="dialog"]');
  await tableDialog.locator('[name="name"]').fill('QA Стол изменён');
  await tableDialog.locator('[name="minCapacity"]').fill('7');
  await tableDialog.locator('[name="maxCapacity"]').fill('9');
  await tableDialog.locator('[name="minimumOrderTotal"]').fill('250');
  const tablePatch = page.waitForResponse((response) => response.request().method() === 'PATCH' && response.url().endsWith(`/api/floor/tables/${table.id}`));
  await tableDialog.locator('button[type="submit"]').click();
  assert.equal((await tablePatch).status(), 200, 'table edit completes through the settings UI');
  await page.getByText('QA Стол изменён').waitFor();
  const editedDb = await db.query('SELECT z.name AS zone_name,t.name AS table_name,t.capacity,t.min_capacity,t.max_capacity,t.min_order_total::text AS deposit FROM zones z JOIN tables t ON t.zone_id=z.id WHERE z.venue_id=$1 AND t.id=$2', [ids.venue, table.id]);
  assert.deepEqual(editedDb.rows[0], { zone_name: 'QA Зал переименован', table_name: 'QA Стол изменён', capacity: 9, min_capacity: 7, max_capacity: 9, deposit: '250.00' });

  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('#venue-zone-list').getByText('QA Зал переименован').waitFor();
  await page.locator('#venue-zone-list').getByText('QA Стол изменён').waitFor();
  await page.locator('#venue-zone-list').getByText('7–9 гостей').waitFor();
  const afterReload = await api('/api/floor');
  const reloadedFloor = await afterReload.json();
  assert.equal(reloadedFloor.zones.find((entry) => entry.id === hall.id)?.name, 'QA Зал переименован');
  assert.deepEqual(((reloadedFloor.zones.find((entry) => entry.id === hall.id)?.tables || []).find((entry) => entry.id === table.id)), { id: table.id, name: 'QA Стол изменён', status: 'free', capacity: 9, minCapacity: 7, maxCapacity: 9, minimumOrderTotal: 250, layout: { x: 120, y: 80 } });

  const hallBeforeDependentDelete = await db.query('SELECT id,name,sort_order FROM zones WHERE id=$1', [hall.id]);
  const tableBeforeDependentDelete = await db.query('SELECT id,zone_id,name,status::text AS status FROM tables WHERE id=$1', [table.id]);
  const hallAuditBeforeDependentDelete = await readCount('audit_events', 'venue_id=$1', [ids.venue]);
  await page.locator(`[data-zone-delete="${hall.id}"]`).click();
  const dependentHallConfirm = page.locator('.action-modal[role="dialog"]');
  const dependentHallDelete = page.waitForResponse((response) => response.request().method() === 'DELETE' && response.url().endsWith(`/api/floor/zones/${hall.id}`));
  await dependentHallConfirm.locator('button[type="submit"]').click();
  const dependentHallResponse = await dependentHallDelete;
  assert.equal(dependentHallResponse.status(), 409, 'hall with dependent tables is rejected through the settings UI');
  assert.equal((await dependentHallResponse.json()).error, 'zone_not_empty');
  await page.locator('#portal-notice').getByText('Нельзя удалить зону, пока в ней есть столы').waitFor();
  assert.deepEqual((await db.query('SELECT id,name,sort_order FROM zones WHERE id=$1', [hall.id])).rows, hallBeforeDependentDelete.rows, 'rejected hall deletion preserves the hall');
  assert.deepEqual((await db.query('SELECT id,zone_id,name,status::text AS status FROM tables WHERE id=$1', [table.id])).rows, tableBeforeDependentDelete.rows, 'rejected hall deletion preserves its table');
  assert.equal(await readCount('audit_events', 'venue_id=$1', [ids.venue]), hallAuditBeforeDependentDelete, 'rejected hall deletion adds no audit row');

  const blockedTransition = await api(`/api/floor/tables/${table.id}`, 'PATCH', { expectedVenueId: ids.venue, status: 'blocked' });
  assert.equal(blockedTransition.status(), 200, 'the existing blocked status is the supported disable path');
  assert.equal((await db.query('SELECT status::text AS status FROM tables WHERE id=$1', [table.id])).rows[0].status, 'blocked');
  assert.equal((await (await api('/api/floor')).json()).zones.find((zone) => zone.id === hall.id).tables.find((entry) => entry.id === table.id).status, 'blocked', 'blocked state survives API re-read');
  const freeTransition = await api(`/api/floor/tables/${table.id}`, 'PATCH', { expectedVenueId: ids.venue, status: 'free' });
  assert.equal(freeTransition.status(), 200, 'a disabled table can be re-enabled as free');
  for (const status of ['occupied', 'reserved', 'awaiting_payment']) {
    const statusBefore = (await db.query('SELECT status::text AS status FROM tables WHERE id=$1', [table.id])).rows[0].status;
    const invalidStatus = await api(`/api/floor/tables/${table.id}`, 'PATCH', { expectedVenueId: ids.venue, status });
    assert.equal(invalidStatus.status(), 400, `${status} is derived or unsupported as a manual transition`);
    assert.equal((await invalidStatus.json()).error, 'invalid_table_status');
    assert.equal((await db.query('SELECT status::text AS status FROM tables WHERE id=$1', [table.id])).rows[0].status, statusBefore, `${status} rejection leaves the stored state unchanged`);
  }

  const stateHallResponse = await api('/api/floor/zones', 'POST', { expectedVenueId: ids.venue, name: 'QA Статусы и история' });
  assert.equal(stateHallResponse.status(), 201);
  const stateHall = await stateHallResponse.json();
  const stateTables = {};
  for (const key of ['occupied', 'reserved', 'closedOrder', 'cancelledReservation']) {
    const response = await api('/api/floor/tables', 'POST', { expectedVenueId: ids.venue, zoneId: stateHall.id, name: `QA ${key}`, capacity: 4, minCapacity: 1, maxCapacity: 4 });
    assert.equal(response.status(), 201, `${key} fixture table is created through the authorized API`);
    stateTables[key] = await response.json();
  }
  const activeOrder = await api('/api/orders', 'POST', { tableId: stateTables.occupied.id });
  assert.equal(activeOrder.status(), 201, 'an actual open order drives occupied state');
  const activeOrderRecord = await activeOrder.json();
  ids.activeOrder = activeOrderRecord.id;
  const floorWithActivityResponse = await api('/api/floor');
  assert.equal(floorWithActivityResponse.status(), 200);
  const floorWithActivity = await floorWithActivityResponse.json();
  const getState = (tableId) => floorWithActivity.zones.find((zone) => zone.id === stateHall.id)?.tables.find((entry) => entry.id === tableId)?.status;
  assert.equal(getState(stateTables.occupied.id), 'occupied', 'active order is reflected as occupied on floor re-read');
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.locator(`.tabs [data-zone-id="${stateHall.id}"]`).click();
  assert.equal(await page.locator(`[data-table="${stateTables.occupied.id}"]`).getAttribute('data-status'), 'occupied', 'work floor visibly renders an open-order table as occupied');
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator(`.tabs [data-zone-id="${stateHall.id}"]`).click();
  assert.equal(await page.locator(`[data-table="${stateTables.occupied.id}"]`).getAttribute('data-status'), 'occupied', 'occupied state survives work-floor reload');
  await page.goto(`${base}/admin#venue-layout-settings`, { waitUntil: 'networkidle' });
  await page.locator(`[data-room-delete="${stateTables.occupied.id}"]`).waitFor({ state: 'visible' });

  const auditBeforeActivityReject = await readCount('audit_events', 'venue_id=$1', [ids.venue]);
  const occupiedDelete = await api(`/api/floor/tables/${stateTables.occupied.id}`, 'DELETE', { expectedVenueId: ids.venue });
  assert.equal(occupiedDelete.status(), 409);
  assert.equal((await occupiedDelete.json()).error, 'table_in_use');
  const blockOccupied = await api(`/api/floor/tables/${stateTables.occupied.id}`, 'PATCH', { expectedVenueId: ids.venue, status: 'blocked' });
  assert.equal(blockOccupied.status(), 409, 'a live order cannot be hidden by the manual blocked state');
  assert.equal((await blockOccupied.json()).error, 'table_has_live_activity');
  assert.equal(await readCount('tables', 'id=$1', [stateTables.occupied.id]), 1, 'occupied table survives rejected operations');
  assert.equal(await readCount('orders', 'id=$1 AND table_id=$2 AND status=\'open\'', [activeOrderRecord.id, stateTables.occupied.id]), 1, 'open order survives rejected table operations');
  assert.equal(await readCount('audit_events', 'venue_id=$1', [ids.venue]), auditBeforeActivityReject, 'rejected activity operations add no audit rows');

  await db.query("UPDATE orders SET status='closed',closed_at=now() WHERE id=$1", [activeOrderRecord.id]);
  const historicOrderDelete = await api(`/api/floor/tables/${stateTables.occupied.id}`, 'DELETE', { expectedVenueId: ids.venue });
  assert.equal(historicOrderDelete.status(), 409, 'closed order history prevents physical table deletion');
  assert.equal((await historicOrderDelete.json()).error, 'table_has_history');
  const disableHistoricTable = await api(`/api/floor/tables/${stateTables.occupied.id}`, 'PATCH', { expectedVenueId: ids.venue, status: 'blocked' });
  assert.equal(disableHistoricTable.status(), 200, 'blocked state remains available to keep a historical table out of service');
  assert.equal(await readCount('orders', 'id=$1 AND table_id=$2', [activeOrderRecord.id, stateTables.occupied.id]), 1, 'disable path preserves the order reference');

  await db.query("INSERT INTO reservations (id,venue_id,table_id,starts_at,ends_at,guests_count,status) VALUES ($1,$2,$3,((now() AT TIME ZONE 'Asia/Yekaterinburg')::date + time '12:00') AT TIME ZONE 'Asia/Yekaterinburg',((now() AT TIME ZONE 'Asia/Yekaterinburg')::date + time '13:00') AT TIME ZONE 'Asia/Yekaterinburg',2,'confirmed')", [randomUUID(), ids.venue, stateTables.reserved.id]);
  const currentReservation = (await db.query('SELECT id FROM reservations WHERE table_id=$1 ORDER BY id DESC LIMIT 1', [stateTables.reserved.id])).rows[0];
  ids.currentReservation = currentReservation.id;
  await db.query("INSERT INTO reservations (id,venue_id,table_id,starts_at,ends_at,guests_count,status) VALUES ($1,$2,$3,now()-INTERVAL '2 days',now()-INTERVAL '1 day',2,'cancelled')", [randomUUID(), ids.venue, stateTables.cancelledReservation.id]);
  const oldReservation = (await db.query('SELECT id FROM reservations WHERE table_id=$1 ORDER BY id DESC LIMIT 1', [stateTables.cancelledReservation.id])).rows[0];
  ids.cancelledReservation = oldReservation.id;
  const floorWithReservations = await (await api('/api/floor')).json();
  const stateFrom = (tableId) => floorWithReservations.zones.find((zone) => zone.id === stateHall.id)?.tables.find((entry) => entry.id === tableId)?.status;
  assert.equal(stateFrom(stateTables.reserved.id), 'reserved', 'confirmed current-day booking is reflected as reserved');
  assert.equal(stateFrom(stateTables.cancelledReservation.id), 'free', 'cancelled historical booking does not make a table appear reserved');
  const auditBeforeReservedBlock = await readCount('audit_events', 'venue_id=$1', [ids.venue]);
  const blockReserved = await api(`/api/floor/tables/${stateTables.reserved.id}`, 'PATCH', { expectedVenueId: ids.venue, status: 'blocked' });
  assert.equal(blockReserved.status(), 409, 'a confirmed current-day booking cannot be hidden by the manual blocked state');
  assert.equal((await blockReserved.json()).error, 'table_has_live_activity');
  assert.equal((await db.query('SELECT status::text AS status FROM tables WHERE id=$1', [stateTables.reserved.id])).rows[0].status, 'free', 'rejected block leaves reserved table storage unchanged');
  assert.equal(await readCount('audit_events', 'venue_id=$1', [ids.venue]), auditBeforeReservedBlock, 'rejected reserved-table block adds no audit row');
  for (const key of ['reserved', 'cancelledReservation']) {
    const snapshot = await db.query('SELECT id,zone_id,name,status::text AS status FROM tables WHERE id=$1', [stateTables[key].id]);
    const reservationId = key === 'reserved' ? ids.currentReservation : ids.cancelledReservation;
    const reservationBefore = await db.query('SELECT id,table_id,status FROM reservations WHERE id=$1', [reservationId]);
    const auditBefore = await readCount('audit_events', 'venue_id=$1', [ids.venue]);
    const rejected = await api(`/api/floor/tables/${stateTables[key].id}`, 'DELETE', { expectedVenueId: ids.venue });
    assert.equal(rejected.status(), 409, `${key} reservation reference prevents physical deletion`);
    assert.equal((await rejected.json()).error, 'table_has_history');
    assert.deepEqual((await db.query('SELECT id,zone_id,name,status::text AS status FROM tables WHERE id=$1', [stateTables[key].id])).rows, snapshot.rows, `${key} table is unchanged after rejection`);
    assert.deepEqual((await db.query('SELECT id,table_id,status FROM reservations WHERE id=$1', [reservationId])).rows, reservationBefore.rows, `${key} reservation is unchanged after rejection`);
    assert.equal(await readCount('audit_events', 'venue_id=$1', [ids.venue]), auditBefore, `${key} rejection adds no audit record`);
  }

  await page.reload({ waitUntil: 'networkidle' });
  const adminFloorAfterFixture = await api('/api/floor');
  const adminFloorSnapshot = await adminFloorAfterFixture.json();
  assert.equal(adminFloorAfterFixture.status(), 200, `owner floor reread after fixture creation: ${JSON.stringify(adminFloorSnapshot)}`);
  assert.ok(adminFloorSnapshot.zones.some((zone) => zone.id === stateHall.id), `API reread should include the state hall: ${JSON.stringify(adminFloorSnapshot.zones.map((zone) => zone.id))}`);
  const adminZoneText = await page.locator('#venue-zone-list').innerText();
  assert.match(adminZoneText, /QA Статусы и история/, `settings UI should reload synthetic tables; API: ${JSON.stringify(adminFloorSnapshot.zones.map((zone) => ({ id: zone.id, name: zone.name, tables: zone.tables.map((table) => table.id) })))}; rendered: ${adminZoneText}`);
  await page.locator(`[data-room-delete="${stateTables.cancelledReservation.id}"]`).waitFor({ state: 'visible' });
  await page.locator(`[data-room-delete="${stateTables.cancelledReservation.id}"]`).click();
  const historyConfirm = page.locator('.action-modal[role="dialog"]');
  const historyDelete = page.waitForResponse((response) => response.request().method() === 'DELETE' && response.url().endsWith(`/api/floor/tables/${stateTables.cancelledReservation.id}`));
  await historyConfirm.locator('button[type="submit"]').click();
  assert.equal((await historyDelete).status(), 409, 'historical table refusal is presented through the settings UI');
  await page.locator('#portal-notice').getByText('Сохраните стол; архивации нет.').waitFor();
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator(`[data-room-delete="${stateTables.cancelledReservation.id}"]`).waitFor();
  assert.equal(await readCount('tables', 'id=$1', [stateTables.cancelledReservation.id]), 1, 'historically referenced UI table remains after reload');

  for (const width of [320, 375, 768, 1440]) {
    await page.setViewportSize({ width, height: 800 });
    const geometry = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth + 1, hallVisible: Boolean(document.querySelector('#venue-zone-list .venue-zone-card')?.getClientRects().length), tableVisible: Boolean(document.querySelector('#venue-zone-list .venue-room-row')?.getClientRects().length) }));
    assert.equal(geometry.overflow, false, `hall settings overflow at ${width}px`);
    assert.equal(geometry.hallVisible, true, `hall is not visible at ${width}px`);
    assert.equal(geometry.tableVisible, true, `table is not visible at ${width}px`);
  }

  await page.locator(`[data-room-delete="${table.id}"]`).click();
  const tableConfirm = page.locator('.action-modal[role="dialog"]');
  await tableConfirm.locator('button[type="submit"]').click();
  await page.locator(`[data-room-delete="${table.id}"]`).waitFor({ state: 'detached' });
  assert.equal(await readCount('tables', 'id=$1', [table.id]), 0, 'UI table deletion is persisted');
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator(`[data-zone="${hall.id}"]`).waitFor();
  assert.equal(await page.locator(`[data-room-delete="${table.id}"]`).count(), 0, 'deleted table remains absent after reload');
  await page.locator(`[data-zone-delete="${hall.id}"]`).click();
  const hallConfirm = page.locator('.action-modal[role="dialog"]');
  const emptyHallDelete = page.waitForResponse((response) => response.request().method() === 'DELETE' && response.url().endsWith(`/api/floor/zones/${hall.id}`));
  await hallConfirm.locator('button[type="submit"]').click();
  const emptyHallResponse = await emptyHallDelete;
  assert.equal(emptyHallResponse.status(), 200, `empty hall deletion succeeds through settings UI: ${await emptyHallResponse.text()}`);
  assert.equal(await readCount('tables', 'zone_id=$1', [hall.id]), 0, 'every child table is removed before the empty hall delete');
  await page.locator(`[data-zone="${hall.id}"]`).waitFor({ state: 'detached' });
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(await page.locator(`[data-zone="${hall.id}"]`).count(), 0, 'empty hall deletion remains absent after reload');
  assert.equal(await readCount('zones', 'id=$1', [hall.id]), 0);

  await page.goto(base, { waitUntil: 'networkidle' });
  await page.locator(`.tabs [data-zone-id="${stateHall.id}"]`).waitFor({ state: 'visible' });
  await page.locator(`.tabs [data-zone-id="${stateHall.id}"]`).click();
  for (const [key, expectedStatus] of [['occupied', 'blocked'], ['reserved', 'reserved'], ['cancelledReservation', 'free']]) {
    const statusSelector = `[data-table="${stateTables[key].id}"]`;
    await page.locator(statusSelector).waitFor({ state: 'visible' });
    assert.equal(await page.locator(statusSelector).getAttribute('data-status'), expectedStatus, `work floor renders ${key} state`);
  }
  for (const width of [320, 375, 768, 1440]) {
    await page.setViewportSize({ width, height: 800 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `work floor overflows at ${width}px`);
    assert.equal(await page.locator(`[data-table="${stateTables.reserved.id}"]`).getAttribute('data-status'), 'reserved', `reserved table is present at ${width}px`);
  }
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(await page.locator(`[data-table="${stateTables.reserved.id}"]`).getAttribute('data-status'), 'reserved', 'reserved state remains after work-floor reload');

  assert.deepEqual(pageErrors, [], `browser exceptions: ${pageErrors.join('; ')}`);
  await ownerContext.close();
  passed = true;
} finally {
  let teardownError;
  try { if (browser) await closeWithin(browser.close(), 'Playwright browser'); } catch (error) { teardownError = error; }
  try { await cleanupChild(); } catch (error) { teardownError ||= error; }
  if (connected && fixturesCreated) {
    try {
      await db.query('BEGIN');
      try {
        await db.query('DELETE FROM auth_sessions WHERE user_id=ANY($1::uuid[])', [[ids.owner, ids.staff, ids.manager]]);
        await db.query('DELETE FROM audit_events WHERE venue_id=$1 OR actor_id=ANY($2::uuid[])', [ids.venue, [ids.owner, ids.staff, ids.manager]]);
        await db.query('DELETE FROM orders WHERE venue_id=$1', [ids.venue]);
        await db.query('DELETE FROM reservations WHERE venue_id=$1', [ids.venue]);
        await db.query('DELETE FROM tables WHERE zone_id IN (SELECT id FROM zones WHERE venue_id=$1)', [ids.venue]);
        await db.query('DELETE FROM zones WHERE venue_id=$1', [ids.venue]);
        await db.query('DELETE FROM organization_memberships WHERE organization_id=$1', [ids.organization]);
        await db.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [[ids.owner, ids.staff, ids.manager]]);
        await db.query('DELETE FROM venues WHERE id=$1', [ids.venue]);
        await db.query('DELETE FROM venues WHERE id=$1', [ids.foreignVenue]);
        await db.query('DELETE FROM organization_subscriptions WHERE organization_id=$1', [ids.organization]);
        await db.query('DELETE FROM organizations WHERE id=$1', [ids.organization]);
        await db.query('DELETE FROM organizations WHERE id=$1', [ids.foreignOrganization]);
        await db.query('COMMIT');
      } catch (error) {
        await db.query('ROLLBACK');
        throw error;
      }
      assert.equal(await readCount('venues', 'id=$1', [ids.venue]), 0, 'QA venue cleanup completed');
      assert.equal(await readCount('organizations', 'id=$1', [ids.organization]), 0, 'QA organization cleanup completed');
    } catch (error) {
      teardownError ||= error;
    }
  }
  try { if (connected) await closeWithin(db.end(), 'PostgreSQL connection'); } catch (error) { teardownError ||= error; }
  if (teardownError) throw teardownError;
}

if (passed) console.log('FLOOR MANAGEMENT POSTGRES BROWSER QA: PASS (UI hall/table lifecycle, active and historical references, derived states, status gates, tenant/owner-manager-bartender/stale guards, reload, four widths, cleanup)');
