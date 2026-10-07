import assert from 'node:assert/strict';
import { randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { assertQaDatabaseIdentity, isDisposableLoopbackQaContainer, validateQaDatabaseUrl } from './postgres-qa-safety.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = validateQaDatabaseUrl(process.env.MIGRATIONS_PG_TEST_DATABASE_URL, 'MIGRATIONS_PG_TEST_DATABASE_URL');
assert.match(target.database, /^inventory_qa_[a-f0-9]{16}$/i, 'race QA requires a runner-created random disposable database');
assert.equal(target.database, process.env.LOCAL_FULL_PG_OWNED_DATABASE, 'only the local regression runner may own this database');
assert.equal(process.env.MIGRATIONS_PG_TEST_DOCKER_CONTAINER, 'hookah-full-regression-qa-20261001', 'race QA requires the exact disposable regression container');
const runnerConfig = JSON.parse(fs.readFileSync(path.join(root, 'tmp', 'full-local-qa', 'runtime.json'), 'utf8'));
assert.equal(target.url.hostname, '127.0.0.1', 'race QA must connect directly to the regression loopback binding');
assert.equal(Number(target.url.port), runnerConfig.regressionPort, 'race QA must use the declared disposable PostgreSQL port');
assert.equal(decodeURIComponent(target.url.username), runnerConfig.dbUser, 'race QA must use the dedicated runner PostgreSQL role');
assert.equal(decodeURIComponent(target.url.password), runnerConfig.dbPassword, 'race QA must use the private runner PostgreSQL credential');

const db = new pg.Client({ connectionString: target.url.href, connectionTimeoutMillis: 5000 });
const ids = { organization: randomUUID(), venue: randomUUID(), owner: randomUUID() };
const marker = randomUUID().slice(0, 8);
const ownerLogin = `qa16-owner-${marker}`;
const ownerPassword = `qa16-${randomUUID()}`;
const hash = (value) => { const salt = randomBytes(16).toString('hex'); return `scrypt$${salt}$${scryptSync(value, salt, 64).toString('hex')}`; };
let server, exitWait, output = '', base = '', token = '', passed = false, checks = 0;

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
const request = async (route, method = 'GET', body, bearer = token, expectedStatus) => {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: { ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}), 'X-Organization-Id': ids.organization, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (expectedStatus !== undefined) assert.equal(response.status, expectedStatus, `${method} ${route}: ${JSON.stringify(payload)}`);
  return { status: response.status, payload };
};
const balance = async (ingredientId) => Number((await db.query(`SELECT COALESCE(SUM(CASE WHEN direction IN ('in','transfer','adjustment') THEN quantity WHEN direction IN ('out','waste') THEN -quantity ELSE 0 END),0)::numeric AS balance FROM stock_movements WHERE venue_id=$1 AND ingredient_id=$2`, [ids.venue, ingredientId])).rows[0].balance);
const concurrentRequests = async (closePath, movementBody, firstOperation) => {
  let ready = 0;
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  const launch = (run) => (async () => { ready++; if (ready === 2) release(); await barrier; return run(); })();
  const operations = {
    close: () => request(closePath, 'POST', { paymentMethod: 'cash' }),
    movement: () => request('/api/inventory/movements', 'POST', movementBody),
  };
  const names = firstOperation === 'movement' ? ['movement', 'close'] : ['close', 'movement'];
  const results = await Promise.allSettled(names.map((name) => launch(operations[name])));
  for (const result of results) if (result.status === 'rejected') throw result.reason;
  return Object.fromEntries(names.map((name, index) => [name, results[index].value]));
};

try {
  await db.connect();
  const identity = (await db.query(`SELECT current_database() AS database,inet_server_addr()::text AS address,inet_server_port() AS port,COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname=current_user),false) AS superuser`)).rows[0];
  const containerInspection = spawnSync('docker', ['inspect', process.env.MIGRATIONS_PG_TEST_DOCKER_CONTAINER], { encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024 });
  assert.equal(containerInspection.status, 0, 'verified disposable PostgreSQL runner container must be inspectable');
  const [runnerContainer] = JSON.parse(containerInspection.stdout);
  assert.equal(runnerContainer?.Name, '/hookah-full-regression-qa-20261001', 'race fixtures must target the exact owned QA container');
  assert.ok(isDisposableLoopbackQaContainer(runnerContainer, String(identity.address), Number(identity.port), Number(target.url.port)), 'race fixtures require a direct connection to the disposable runner container, never a persistent loopback PostgreSQL service');
  assertQaDatabaseIdentity(identity, target.database, Number(target.url.port || 5432), 'sale/manual movement race QA');
  checks++;

  await db.query('BEGIN');
  try {
    await db.query('INSERT INTO organizations(id,name,slug,timezone) VALUES($1,$2,$3,$4)', [ids.organization, 'QA16 Race', `qa16-${ids.organization}`, 'Asia/Yekaterinburg']);
    await db.query("INSERT INTO organization_subscriptions(organization_id,status) VALUES($1,'trialing')", [ids.organization]);
    await db.query('INSERT INTO venues(id,organization_id,name,timezone) VALUES($1,$2,$3,$4)', [ids.venue, ids.organization, 'QA16 Race venue', 'Asia/Yekaterinburg']);
    await db.query(`INSERT INTO users(id,organization_id,venue_id,full_name,login,password_hash,role,permission_scopes) VALUES($1,$2,$3,'QA16 owner',$4,$5,'owner','["inventory","orders","settings"]'::jsonb)`, [ids.owner, ids.organization, ids.venue, ownerLogin, hash(ownerPassword)]);
    await db.query("INSERT INTO organization_memberships(organization_id,user_id,membership_role,status) VALUES($1,$2,'owner','active')", [ids.organization, ids.owner]);
    await db.query('COMMIT');
  } catch (error) { await db.query('ROLLBACK'); throw error; }

  server = spawn(process.execPath, ['server.js'], {
    cwd: root, windowsHide: true,
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', DATABASE_URL: target.url.href, VENUE_ID: ids.venue, AUTH_REQUIRED: 'true', DEMO_MODE: 'false', NODE_ENV: 'test', API_RATE_LIMIT: '5000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  exitWait = new Promise((resolve) => server.once('exit', resolve));
  server.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
  server.stderr.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
  await waitForServer();
  const health = await request('/api/health', 'GET', undefined, '', 200);
  assert.equal(health.payload.database, 'postgres', 'race requests use a PostgreSQL-backed authenticated server'); checks++;

  const login = await request('/api/login', 'POST', { username: ownerLogin, password: ownerPassword }, '', 200);
  token = login.payload.token;
  assert.ok(token, 'synthetic owner login returns a bearer session'); checks++;
  assert.equal((await request('/api/session')).payload.user.id, ids.owner, 'owner session is active'); checks++;
  await request('/api/shifts', 'POST', { openingCash: 0 }, token, 201);
  const hall = await request('/api/floor/zones', 'POST', { expectedVenueId: ids.venue, name: `QA16 race hall ${marker}` }, token, 201);
  const tables = [];
  for (const index of [1, 2]) tables.push(await request('/api/floor/tables', 'POST', { expectedVenueId: ids.venue, zoneId: hall.payload.id, name: `QA16 race table ${marker} ${index}`, capacity: 2 }, token, 201));

  const cases = [
    { label: 'sale-close launched first', firstOperation: 'close' },
    { label: 'manual movement launched first', firstOperation: 'movement' },
  ];
  for (const scenario of cases) {
    const ingredient = await request('/api/inventory/items', 'POST', { name: `QA16 race ingredient ${marker} ${cases.indexOf(scenario)}`, unit: 'мл', itemType: 'ingredient', cost: 0.5, department: 'bar' }, token, 201);
    await request('/api/inventory/movements', 'POST', { itemId: ingredient.payload.id, delta: 100, unit: 'мл', reason: `QA16 synthetic opening ${marker}` }, token, 201);
    const product = await request('/api/products', 'POST', { name: `QA16 race drink ${marker} ${cases.indexOf(scenario)}`, category: 'Бар', price: 150 }, token, 201);
    await request('/api/recipes', 'POST', { productId: product.payload.id, name: product.payload.name, ingredients: [{ ingredientId: ingredient.payload.id, name: ingredient.payload.name, quantity: '60 мл' }], yieldQuantity: 1, yieldUnit: 'порция', portionCount: 1 }, token, 201);
    const order = await request('/api/orders', 'POST', { tableId: tables[cases.indexOf(scenario)].payload.id }, token, 201);
    await request(`/api/orders/${order.payload.id}/items`, 'POST', { productId: product.payload.id, quantity: 1 }, token, 201);

    const raced = await concurrentRequests(`/api/orders/${order.payload.id}/close`, { itemId: ingredient.payload.id, delta: -60, unit: 'мл', reason: `QA16 competing manual out ${marker}` }, scenario.firstOperation);

    const closeWon = raced.close.status === 200;
    const manualWon = raced.movement.status === 201;
    assert.notEqual(closeWon, manualWon, `${scenario.label}: exactly one operation commits`); checks++;
    assert.equal(raced.close.status, closeWon ? 200 : 409, `${scenario.label}: sale close is success or a stock conflict`); checks++;
    assert.equal(raced.movement.status, manualWon ? 201 : 409, `${scenario.label}: manual movement is success or a stock conflict`); checks++;
    if (!closeWon) assert.equal(raced.close.payload.error, 'insufficient_recipe_stock', 'losing sale reports the recipe shortage');
    if (!manualWon) assert.equal(raced.movement.payload.error, 'insufficient_stock', 'losing manual movement reports insufficient stock');
    checks += Number(!closeWon) + Number(!manualWon);

    const [currentBalance, persisted, orderRead] = await Promise.all([
      balance(ingredient.payload.id),
      db.query(`SELECT o.status,(SELECT count(*)::int FROM order_costs c WHERE c.order_id=o.id) AS cost_rows,(SELECT c.cost FROM order_costs c WHERE c.order_id=o.id) AS cost,(SELECT count(*)::int FROM payments p WHERE p.order_id=o.id AND p.status IN ('paid','partially_paid')) AS paid_rows,(SELECT COALESCE(sum(sm.quantity),0)::numeric FROM stock_movements sm WHERE sm.venue_id=o.venue_id AND sm.ingredient_id=$2 AND sm.direction='out') AS out_quantity,(SELECT count(*)::int FROM stock_movements sm WHERE sm.venue_id=o.venue_id AND sm.ingredient_id=$2 AND sm.direction='out') AS out_rows,(SELECT count(*)::int FROM stock_movements sm WHERE sm.venue_id=o.venue_id AND sm.ingredient_id=$2 AND sm.order_id=o.id AND sm.direction='out') AS order_debits,(SELECT count(*)::int FROM stock_movements sm WHERE sm.venue_id=o.venue_id AND sm.ingredient_id=$2 AND sm.order_id IS NULL AND sm.direction='out' AND sm.reason LIKE 'QA16 competing manual out%') AS manual_debits FROM orders o WHERE o.id=$1 AND o.venue_id=$3`, [order.payload.id, ingredient.payload.id, ids.venue]),
      request('/api/orders?scope=all', 'GET', undefined, token, 200),
    ]);
    assert.equal(currentBalance, 40, `${scenario.label}: ledger balance remains exactly 40ml`); checks++;
    const row = persisted.rows[0];
    assert.equal(Number(row.out_quantity), 60, `${scenario.label}: only 60ml is debited in total`); checks++;
    assert.equal(row.out_rows, 1, `${scenario.label}: one out movement exists`); checks++;
    assert.equal(row.order_debits, closeWon ? 1 : 0, `${scenario.label}: only a winning sale owns a debit`); checks++;
    assert.equal(row.manual_debits, manualWon ? 1 : 0, `${scenario.label}: only a winning manual operation owns a standalone movement`); checks++;
    assert.equal(row.status, closeWon ? 'closed' : 'open', `${scenario.label}: order state follows the winning operation`); checks++;
    assert.equal(row.cost_rows, closeWon ? 1 : 0, `${scenario.label}: COGS snapshot is atomic with sale close`); checks++;
    if (closeWon) assert.equal(Number(row.cost), 30, `${scenario.label}: winning sale snapshots 30 RUB COGS`);
    checks += Number(closeWon);
    assert.equal(row.paid_rows, closeWon ? 1 : 0, `${scenario.label}: payment is atomic with sale close`); checks++;
    const orderDto = orderRead.payload.items.find((entry) => entry.id === order.payload.id);
    assert.equal(orderDto?.status, row.status, `${scenario.label}: fresh API read matches persisted order status`); checks++;
    const inventoryRead = await request('/api/inventory', 'GET', undefined, token, 200);
    assert.equal(Number(inventoryRead.payload.items.find((entry) => entry.id === ingredient.payload.id)?.onHand), 40, `${scenario.label}: fresh inventory API read reflects the reconciled balance`); checks++;
    assert.ok(inventoryRead.payload.movements.some((entry) => entry.itemId === ingredient.payload.id), `${scenario.label}: fresh inventory read includes the movement journal`); checks++;
  }
  passed = true;
} finally {
  if (server?.pid && server.exitCode === null && server.signalCode === null) {
    if (process.platform === 'win32') spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `taskkill /PID ${server.pid} /T /F`], { windowsHide: true, stdio: 'ignore' });
    else server.kill('SIGTERM');
    await exitWait;
  }
  if (db._connected) await db.end();
}

if (passed) console.log(`ACCEPTANCE #16 SALE/MANUAL MOVEMENT RACE QA: PASS (${checks} assertions; two concurrent authenticated PostgreSQL cases; exact stock, movement, order, payment and COGS invariants; runner drops disposable database)`);
