import assert from 'node:assert/strict';
import { randomBytes, randomInt, randomUUID, scryptSync } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { assertQaDatabaseIdentity, validateQaDatabaseUrl } from './postgres-qa-safety.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = validateQaDatabaseUrl(process.env.MIGRATIONS_PG_TEST_DATABASE_URL, 'MIGRATIONS_PG_TEST_DATABASE_URL');
assert.match(target.database, /^inventory_qa_[a-f0-9]{16}$/i, 'acceptance #47 requires a runner-created random disposable database');
assert.equal(target.database, process.env.LOCAL_FULL_PG_OWNED_DATABASE, 'only the local regression runner may own this database');
const db = new pg.Client({ connectionString: target.url.href, connectionTimeoutMillis: 5000 });
const ids = { organization: randomUUID(), venue: randomUUID(), owner: randomUUID(), staff: randomUUID(), foreignOrganization: randomUUID(), foreignVenue: randomUUID(), foreignOwner: randomUUID() };
const marker = randomUUID().slice(0, 8);
const ownerLogin = `qa47-owner-${marker}`, staffLogin = `qa47-staff-${marker}`, foreignLogin = `qa47-foreign-${marker}`;
const ownerPassword = `qa47-${randomUUID()}`, staffPassword = `qa47-${randomUUID()}`, foreignPassword = `qa47-${randomUUID()}`;
const pin = String(randomInt(1000, 10000));
let server, output = '', base = '', token = '', passed = false, checks = 0;

const hash = (value) => {
  const salt = randomBytes(16).toString('hex');
  return `scrypt$${salt}$${scryptSync(value, salt, 64).toString('hex')}`;
};
const waitForServer = async () => {
  const deadline = Date.now() + 20000;
  while (!base && Date.now() < deadline) {
    const match = output.match(/CRM running on http:\/\/localhost:(\d+)/);
    if (match) base = `http://127.0.0.1:${match[1]}`;
    else if (server.exitCode !== null) throw new Error(`QA server exited before startup: ${output}`);
    else await delay(50);
  }
  assert.ok(base, `QA server starts: ${output}`);
};
const api = async (route, method = 'GET', body, bearer = token, organization = ids.organization, status = 200) => {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: { ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}), ...(organization ? { 'X-Organization-Id': organization } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  assert.equal(response.status, status, `${method} ${route}: ${JSON.stringify(payload)}`);
  checks++;
  return payload;
};
const balance = async (ingredientId) => Number((await db.query(`SELECT COALESCE(SUM(CASE WHEN direction IN ('in','transfer','adjustment') THEN quantity WHEN direction IN ('out','waste') THEN -quantity ELSE 0 END),0)::numeric AS balance FROM stock_movements WHERE venue_id=$1 AND ingredient_id=$2`, [ids.venue, ingredientId])).rows[0].balance);
const floorTable = async (zoneId, tableId) => {
  const floor = await api('/api/floor');
  return floor.zones.find((zone) => zone.id === zoneId)?.tables.find((table) => table.id === tableId);
};

try {
  await db.connect();
  const identity = (await db.query(`SELECT current_database() AS database,inet_server_addr()::text AS address,inet_server_port() AS port,COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname=current_user),false) AS superuser`)).rows[0];
  assertQaDatabaseIdentity(identity, target.database, Number(target.url.port || 5432), 'acceptance #47 PostgreSQL browser QA');

  await db.query('BEGIN');
  try {
    await db.query('INSERT INTO organizations(id,name,slug,timezone) VALUES($1,$2,$3,$4),($5,$6,$7,$4)', [ids.organization, 'QA47 Journey', `qa47-${ids.organization}`, 'Asia/Yekaterinburg', ids.foreignOrganization, 'QA47 Foreign', `qa47-foreign-${ids.foreignOrganization}`]);
    await db.query("INSERT INTO organization_subscriptions(organization_id,status) VALUES($1,'trialing'),($2,'trialing')", [ids.organization, ids.foreignOrganization]);
    await db.query('INSERT INTO venues(id,organization_id,name,timezone) VALUES($1,$2,$3,$4),($5,$6,$7,$4)', [ids.venue, ids.organization, 'QA47 Journey venue', 'Asia/Yekaterinburg', ids.foreignVenue, ids.foreignOrganization, 'QA47 Foreign venue']);
    await db.query(`INSERT INTO users(id,organization_id,venue_id,full_name,login,password_hash,pin_hash,pin_updated_at,role,permission_scopes) VALUES
      ($1,$2,$3,'QA47 owner',$4,$5,$6,now(),'owner','[]'::jsonb),($7,$2,$3,'QA47 staff',$8,$9,$10,now(),'bartender','["orders"]'::jsonb),($11,$12,$13,'QA47 foreign owner',$14,$15,NULL,NULL,'owner','[]'::jsonb)`,
    [ids.owner, ids.organization, ids.venue, ownerLogin, hash(ownerPassword), hash(pin), ids.staff, staffLogin, hash(staffPassword), hash(pin), ids.foreignOwner, ids.foreignOrganization, ids.foreignVenue, foreignLogin, hash(foreignPassword)]);
    await db.query("INSERT INTO organization_memberships(organization_id,user_id,membership_role,status) VALUES($1,$2,'owner','active'),($1,$3,'member','active'),($4,$5,'owner','active')", [ids.organization, ids.owner, ids.staff, ids.foreignOrganization, ids.foreignOwner]);
    await db.query("INSERT INTO inventory_departments(venue_id,code,name) VALUES($1,'bar','Бар'),($2,'bar','Бар') ON CONFLICT(venue_id,code) DO NOTHING", [ids.venue, ids.foreignVenue]);
    await db.query('COMMIT');
  } catch (error) { await db.query('ROLLBACK'); throw error; }

  server = spawn(process.execPath, ['server.js'], {
    cwd: root, windowsHide: true,
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', DATABASE_URL: target.url.href, VENUE_ID: ids.venue, AUTH_REQUIRED: 'true', DEMO_MODE: 'false', NODE_ENV: 'test', API_RATE_LIMIT: '5000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
  server.stderr.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
  await waitForServer();
  assert.equal((await api('/api/health', 'GET', undefined, '', '', 200)).database, 'postgres', 'the authenticated path is backed by PostgreSQL'); checks++;

  const ownerLoginResponse = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Organization-Id': ids.organization }, body: JSON.stringify({ username: ownerLogin, password: ownerPassword }) });
  assert.equal(ownerLoginResponse.status, 200, 'synthetic owner authenticates with the password login endpoint'); checks++;
  token = (await ownerLoginResponse.json()).token;
  assert.ok(token, 'authenticated login returns the bearer session used for the complete journey'); checks++;
  assert.equal((await api('/api/session/unlock', 'POST', { pin })).ok, true, 'staff PIN unlock verifies the configured synthetic PostgreSQL PIN'); checks++;
  assert.equal((await api('/api/session')).user.id, ids.owner, 'PIN unlock preserves the authenticated owner session for the journey'); checks++;

  const initialFloor = await api('/api/floor');
  assert.deepEqual(initialFloor.zones, [], 'new QA venue begins with no halls'); checks++;
  const hall = await api('/api/floor/zones', 'POST', { expectedVenueId: ids.venue, name: `QA47 зал ${marker}` }, token, ids.organization, 201);
  const emptyHallRead = await api('/api/floor');
  assert.deepEqual(emptyHallRead.zones.find((zone) => zone.id === hall.id)?.tables, [], 'newly created hall is readable before adding its first table'); checks++;
  const table = await api('/api/floor/tables', 'POST', { expectedVenueId: ids.venue, zoneId: hall.id, name: `QA47 стол ${marker}`, capacity: 2 }, token, ids.organization, 201);
  assert.equal((await floorTable(hall.id, table.id))?.status, 'free', 'created table is visible and free after a fresh floor read'); checks++;

  const ingredient = await api('/api/inventory/items', 'POST', { name: `QA47 ингредиент ${marker}`, unit: 'мл', itemType: 'ingredient', cost: 0.5, department: 'bar' }, token, ids.organization, 201);
  await api('/api/inventory/movements', 'POST', { itemId: ingredient.id, delta: 100, unit: 'мл', reason: 'QA47 synthetic opening balance' }, token, ids.organization, 201);
  const product = await api('/api/products', 'POST', { name: `QA47 напиток ${marker}`, category: 'Бар', price: 150 }, token, ids.organization, 201);
  await api('/api/recipes', 'POST', { productId: product.id, name: product.name, ingredients: [{ ingredientId: ingredient.id, name: ingredient.name, quantity: '50 мл' }], yieldQuantity: 1, yieldUnit: 'порция', portionCount: 1 }, token, ids.organization, 201);
  await api('/api/shifts', 'POST', { openingCash: 0 }, token, ids.organization, 201);
  const order = await api('/api/orders', 'POST', { tableId: table.id }, token, ids.organization, 201);
  assert.equal((await floorTable(hall.id, table.id))?.status, 'occupied', 'the same created table becomes occupied while its order is open'); checks++;
  await api(`/api/orders/${order.id}/items`, 'POST', { productId: product.id, quantity: 1 }, token, ids.organization, 201);

  const staffLoginResponse = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Organization-Id': ids.organization }, body: JSON.stringify({ username: staffLogin, password: staffPassword }) });
  assert.equal(staffLoginResponse.status, 200, 'scoped staff can log in');
  const staffSession = await staffLoginResponse.json();
  await api('/api/session/unlock', 'POST', { pin }, staffSession.token, ids.organization, 200);
  await api('/api/inventory', 'GET', undefined, staffSession.token, ids.organization, 403);
  await api('/api/floor/zones', 'POST', { expectedVenueId: ids.venue, name: 'QA47 forbidden staff hall' }, staffSession.token, ids.organization, 403);
  assert.ok((await api('/api/orders?scope=all', 'GET', undefined, staffSession.token, ids.organization)).items.some((entry) => entry.id === order.id), 'authorized staff can read the open operational order'); checks++;

  const foreignLoginResponse = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Organization-Id': ids.foreignOrganization }, body: JSON.stringify({ username: foreignLogin, password: foreignPassword }) });
  assert.equal(foreignLoginResponse.status, 200, 'foreign tenant QA owner can establish an isolated session'); checks++;
  const foreignSession = await foreignLoginResponse.json();
  assert.deepEqual((await api('/api/floor', 'GET', undefined, foreignSession.token, ids.foreignOrganization)).zones, [], 'foreign tenant cannot read the QA hall/table'); checks++;
  assert.equal((await api('/api/inventory', 'GET', undefined, foreignSession.token, ids.foreignOrganization)).items.some((item) => item.id === ingredient.id), false, 'foreign tenant cannot read the QA ingredient'); checks++;
  assert.equal((await api('/api/orders?scope=all', 'GET', undefined, foreignSession.token, ids.foreignOrganization)).items.some((entry) => entry.id === order.id), false, 'foreign tenant cannot read the QA order'); checks++;
  const foreignTableOrder = await api('/api/orders', 'POST', { tableId: table.id }, foreignSession.token, ids.foreignOrganization, 409);
  assert.equal(foreignTableOrder.detail, 'table_not_found_or_unavailable', 'foreign table IDs are rejected without crossing the venue boundary'); checks++;

  await api(`/api/orders/${order.id}/close`, 'POST', { paymentMethod: 'cash' }, token, ids.organization, 200);
  assert.equal((await floorTable(hall.id, table.id))?.status, 'free', 'the same table returns to free after order close'); checks++;
  const orderRead = await api('/api/orders?scope=all');
  assert.ok(orderRead.items.some((entry) => entry.id === order.id && entry.tableId === table.id && entry.status === 'closed'), 'closed order readback retains its hall table reference'); checks++;
  assert.equal(await balance(ingredient.id), 50, 'the order debits exactly 50ml from the synthetic PostgreSQL ingredient ledger'); checks++;
  const persisted = await db.query(`SELECT o.status,o.table_id,(SELECT count(*)::int FROM order_costs c WHERE c.order_id=o.id) AS cost_rows,(SELECT c.cost FROM order_costs c WHERE c.order_id=o.id) AS cost,(SELECT count(*)::int FROM stock_movements m WHERE m.order_id=o.id AND m.ingredient_id=$2 AND m.direction='out') AS debit_rows FROM orders o WHERE o.id=$1 AND o.venue_id=$3`, [order.id, ingredient.id, ids.venue]);
  assert.deepEqual(persisted.rows[0], { status: 'closed', table_id: table.id, cost_rows: 1, cost: '25.00', debit_rows: 1 }, 'same order/table has one immutable 25 RUB COGS snapshot and one ingredient debit'); checks++;
  passed = true;
} finally {
  if (server?.pid && server.exitCode === null && server.signalCode === null) {
    const close = new Promise((resolve) => server.once('close', resolve));
    if (process.platform === 'win32') spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `taskkill /PID ${server.pid} /T /F`], { windowsHide: true, stdio: 'ignore' });
    else server.kill('SIGTERM');
    await Promise.race([close, delay(5000)]);
  }
  if (db._connected) await db.end();
}

if (passed) console.log(`ACCEPTANCE #47 POS JOURNEY POSTGRES QA: PASS (${checks} assertions; authenticated login→staff PIN unlock→new hall/table→same-table order→ingredient depletion→COGS; staff/tenant isolation; runner drops disposable database)`);
