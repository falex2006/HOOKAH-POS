import assert from 'node:assert/strict';
import { randomBytes, randomInt, randomUUID, scryptSync } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { assertQaDatabaseIdentity, validateQaDatabaseUrl } from './postgres-qa-safety.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const databaseUrl = process.env.MIGRATIONS_PG_TEST_DATABASE_URL;
const target = validateQaDatabaseUrl(databaseUrl, 'MIGRATIONS_PG_TEST_DATABASE_URL');
assert.match(target.database, /^orders_qa_[a-f0-9]{16}$/i, '#47 browser journey requires a runner-created random disposable database');
assert.equal(target.database, process.env.LOCAL_FULL_PG_OWNED_DATABASE, 'only the local regression runner may own this database');
assert.ok(process.env.MIGRATIONS_PG_TEST_DOCKER_CONTAINER, 'database must be owned by the local regression runner');
const playwrightPath = process.env.PLAYWRIGHT_PACKAGE_PATH;
assert.ok(playwrightPath, 'Set PLAYWRIGHT_PACKAGE_PATH');
const { chromium } = createRequire(import.meta.url)(playwrightPath);
const db = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
const ids = { organization: randomUUID(), venue: randomUUID(), owner: randomUUID(), ingredient: randomUUID(), product: randomUUID(), shift: randomUUID() };
const marker = randomUUID().slice(0, 8);
const ownerLogin = `qa47-browser-${marker}`;
const ownerPassword = `qa47-${randomUUID()}`;
const pin = String(randomInt(1000, 10000));
const ingredientName = `QA47 ingredient ${marker}`;
const productName = `QA47 tracked drink ${marker}`;
let connected = false;
let server;
let serverExit;
let browser;
let context;
let passed = false;
let checks = 0;
let output = '';

const hash = (value) => {
  const salt = randomBytes(16).toString('hex');
  return `scrypt$${salt}$${scryptSync(value, salt, 64).toString('hex')}`;
};
const waitForServer = async () => {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const match = output.match(/CRM running on http:\/\/localhost:(\d+)/);
    if (match) return `http://127.0.0.1:${match[1]}`;
    if (server.exitCode !== null) throw new Error(`QA server exited before startup: ${output}`);
    await delay(50);
  }
  throw new Error(`QA server did not start within 20 seconds: ${output}`);
};
const balance = async () => Number((await db.query(`SELECT COALESCE(SUM(CASE WHEN direction IN ('in','transfer','adjustment') THEN quantity WHEN direction IN ('out','waste') THEN -quantity ELSE 0 END),0)::numeric AS balance FROM stock_movements WHERE venue_id=$1 AND ingredient_id=$2`, [ids.venue, ids.ingredient])).rows[0].balance);

try {
  await db.connect();
  connected = true;
  const identity = (await db.query(`SELECT current_database() AS database,inet_server_addr()::text AS address,inet_server_port() AS port,COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname=current_user),false) AS superuser`)).rows[0];
  assertQaDatabaseIdentity(identity, target.database, Number(target.url.port || 5432), 'acceptance #47 browser PostgreSQL QA');

  await db.query('BEGIN');
  try {
    await db.query('INSERT INTO organizations(id,name,slug,timezone) VALUES($1,$2,$3,$4)', [ids.organization, 'QA47 browser journey', `qa47-browser-${ids.organization}`, 'Asia/Yekaterinburg']);
    await db.query("INSERT INTO organization_subscriptions(organization_id,status) VALUES($1,'trialing')", [ids.organization]);
    await db.query('INSERT INTO venues(id,organization_id,name,timezone) VALUES($1,$2,$3,$4)', [ids.venue, ids.organization, 'QA47 browser venue', 'Asia/Yekaterinburg']);
    await db.query(`INSERT INTO users(id,organization_id,venue_id,full_name,login,password_hash,pin_hash,pin_updated_at,role,permission_scopes)
      VALUES($1,$2,$3,'QA47 browser owner',$4,$5,$6,now(),'owner','[]'::jsonb)`, [ids.owner, ids.organization, ids.venue, ownerLogin, hash(ownerPassword), hash(pin)]);
    await db.query("INSERT INTO organization_memberships(organization_id,user_id,membership_role,status) VALUES($1,$2,'owner','active')", [ids.organization, ids.owner]);
    await db.query("INSERT INTO inventory_departments(venue_id,code,name) VALUES($1,'bar','Бар') ON CONFLICT(venue_id,code) DO NOTHING", [ids.venue]);
    await db.query(`INSERT INTO ingredients(id,venue_id,organization_id,name,category,unit,cost,department,purchase_unit,pack_multiplier,is_marked)
      VALUES($1,$2,$3,$4,'QA47','мл',0.5,'bar','л',1000,true)`, [ids.ingredient, ids.venue, ids.organization, ingredientName]);
    await db.query(`INSERT INTO products(id,venue_id,name,category,sale_price,inventory_mode)
      VALUES($1,$2,$3,'Бар',100,'tracked')`, [ids.product, ids.venue, productName]);
    await db.query(`INSERT INTO inventory_recipe_cards(venue_id,product_id,name,ingredients,yield_quantity,yield_unit,portion_count,recipe_type)
      VALUES($1,$2,$3,$4::jsonb,1,'порция',1,'sale')`, [ids.venue, ids.product, productName, JSON.stringify([{ ingredientId: ids.ingredient, name: ingredientName, quantity: '20 мл' }])]);
    await db.query(`INSERT INTO stock_movements(venue_id,ingredient_id,direction,quantity,reason,created_by)
      VALUES($1,$2,'in',100,'QA47 opening balance',$3)`, [ids.venue, ids.ingredient, ids.owner]);
    await db.query(`INSERT INTO shifts(id,venue_id,opened_by,opening_cash) VALUES($1,$2,$3,0)`, [ids.shift, ids.venue, ids.owner]);
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }

  server = spawn(process.execPath, ['server.js'], {
    cwd: root,
    windowsHide: true,
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', DATABASE_URL: target.url.href, VENUE_ID: ids.venue, AUTH_REQUIRED: 'true', DEMO_MODE: 'false', NODE_ENV: 'test', API_RATE_LIMIT: '5000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverExit = new Promise((resolve) => server.once('exit', resolve));
  server.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
  server.stderr.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
  const base = await waitForServer();
  const health = await fetch(`${base}/api/health`);
  assert.equal(health.status, 200, 'QA server is healthy'); checks++;
  assert.equal((await health.json()).database, 'postgres', 'browser journey uses PostgreSQL'); checks++;

  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ru-RU' });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => { if (error.message !== 'Transition was aborted because of invalid state. ViewTransition opt-in disabled') pageErrors.push(error.stack || error.message); });
  await page.goto(`${base}/login`, { waitUntil: 'networkidle' });
  await page.locator('#login-username').fill(ownerLogin);
  await page.locator('#login-password').fill(ownerPassword);
  await page.locator('#login-form button[type="submit"]').click();
  await page.waitForURL((url) => url.pathname !== '/login');
  const initialToken = await page.evaluate(() => localStorage.getItem('crm_session_token'));
  assert.ok(initialToken, 'password UI login establishes the browser session'); checks++;

  await page.goto(`${base}/admin`, { waitUntil: 'networkidle' });
  await page.locator('#lock-screen-button').waitFor();
  await page.locator('#lock-screen-button').click();
  await page.locator('.screen-lock-overlay[aria-hidden="false"]').waitFor({ state: 'visible' });
  const pinResponse = page.waitForResponse((response) => response.url().endsWith('/api/session/unlock') && response.request().method() === 'POST');
  await page.locator('#screen-lock-pin').fill(pin);
  assert.equal((await pinResponse).status(), 200, 'real screen-lock UI accepts the configured PIN'); checks++;
  await page.waitForFunction(() => document.querySelector('.screen-lock-overlay')?.getAttribute('aria-hidden') === 'true' && !document.body.classList.contains('screen-locked'));
  assert.equal(await page.evaluate(() => localStorage.getItem('crm_session_token')), initialToken, 'PIN unlock resumes the same bearer session'); checks++;
  const session = await page.evaluate(async () => {
    const response = await fetch('/api/session', { headers: { Authorization: `Bearer ${localStorage.getItem('crm_session_token')}` } });
    return { status: response.status, body: await response.json() };
  });
  assert.equal(session.status, 200); checks++;
  assert.equal(session.body.user.id, ids.owner, 'PIN unlock retains the same owner identity'); checks++;

  await page.goto(`${base}/admin#venue-layout-settings`, { waitUntil: 'networkidle' });
  await page.locator('#new-floor-zone').waitFor({ state: 'visible' });
  await page.waitForFunction(() => !document.querySelector('#new-floor-zone')?.disabled);
  const floorBefore = await page.evaluate(async () => {
    const response = await fetch('/api/floor', { headers: { Authorization: `Bearer ${localStorage.getItem('crm_session_token')}` } });
    return response.json();
  });
  assert.deepEqual(floorBefore.zones, [], 'new venue starts without a hall'); checks++;
  await page.locator('#new-floor-zone').click();
  await page.locator('#venue-zone-name').fill(`QA47 зал ${marker}`);
  const hallResponsePromise = page.waitForResponse((response) => response.request().method() === 'POST' && response.url().endsWith('/api/floor/zones'));
  await page.locator('#venue-zone-form button[type="submit"]').click();
  const hallResponse = await hallResponsePromise;
  assert.equal(hallResponse.status(), 201, 'UI creates the hall'); checks++;
  const hall = await hallResponse.json();
  await page.locator('#venue-room-form').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#venue-room-zone').inputValue(), hall.id, 'new table form points to the UI-created hall'); checks++;
  await page.locator('#venue-room-name').fill(`QA47 стол ${marker}`);
  await page.locator('#venue-room-min-capacity').fill('2');
  await page.locator('#venue-room-max-capacity').fill('2');
  const tableResponsePromise = page.waitForResponse((response) => response.request().method() === 'POST' && response.url().endsWith('/api/floor/tables'));
  await page.locator('#venue-room-submit').click();
  const tableResponse = await tableResponsePromise;
  assert.equal(tableResponse.status(), 201, 'UI creates the table'); checks++;
  const table = await tableResponse.json();
  assert.equal((await db.query('SELECT id,zone_id FROM tables WHERE id=$1', [table.id])).rows[0]?.zone_id, hall.id, 'the exact UI-created table identity is persisted'); checks++;

  await page.goto(base, { waitUntil: 'networkidle' });
  await page.locator(`[data-zone-id="${hall.id}"]`).waitFor();
  await page.locator(`[data-zone-id="${hall.id}"]`).click();
  await page.locator(`[data-table="${table.id}"]`).click();
  await page.locator('#table-context-actions [data-table-action="close-panel"]').evaluate((node) => node.click());
  assert.equal(await page.locator(`[data-table="${table.id}"]`).evaluate((node) => node.classList.contains('sel')), true, 'closing the table card preserves the selected table'); checks++;
  await page.locator(`[data-table="${table.id}"]`).click();
  const orderCreatePromise = page.waitForResponse((response) => response.request().method() === 'POST' && response.url().endsWith('/api/orders'));
  await page.locator('.order > .primary').click();
  await page.locator(`[data-name="${productName}"]`).waitFor({ state: 'visible' });
  const itemCreatePromise = page.waitForResponse((response) => response.request().method() === 'POST' && /\/api\/orders\/[0-9a-f-]+\/items$/.test(response.url()));
  await page.locator(`[data-name="${productName}"]`).click();
  const orderResponse = await orderCreatePromise;
  assert.equal(orderResponse.status(), 201, 'POS UI opens an order from the newly created table'); checks++;
  const order = await orderResponse.json();
  assert.equal(order.tableId, table.id, 'POS order uses the exact hall-settings table ID'); checks++;
  assert.equal((await itemCreatePromise).status(), 201, 'POS UI adds the tracked recipe item'); checks++;
  const occupiedFloor = await page.evaluate(async () => {
    const response = await fetch('/api/floor', { headers: { Authorization: `Bearer ${localStorage.getItem('crm_session_token')}` } });
    return response.json();
  });
  assert.equal(occupiedFloor.zones.find((zone) => zone.id === hall.id)?.tables.find((entry) => entry.id === table.id)?.status, 'occupied', 'the same table is occupied during its open POS order'); checks++;
  const orderMore = page.locator('.order-more');
  if (await orderMore.count()) await orderMore.locator('summary').click();
  await page.locator('#split-payment:not([disabled])').click();
  await page.locator('#payment-cash').fill('100');
  const paymentResponsePromise = page.waitForResponse((response) => response.request().method() === 'POST' && response.url().endsWith(`/api/orders/${order.id}/payments`));
  await page.locator('#payment-form [type="submit"]').click();
  const paymentResponse = await paymentResponsePromise;
  assert.equal(paymentResponse.status(), 201, 'POS UI accepts the full synthetic cash sale'); checks++;
  assert.equal((await paymentResponse.json()).closed, true, 'full payment closes the order'); checks++;

  const persisted = (await db.query(`SELECT o.status,o.table_id,
      (SELECT count(*)::int FROM order_items oi WHERE oi.order_id=o.id) AS item_rows,
      (SELECT count(*)::int FROM payments p WHERE p.order_id=o.id AND p.status='paid') AS paid_rows,
      (SELECT count(*)::int FROM order_costs c WHERE c.order_id=o.id) AS cost_rows,
      (SELECT c.cost FROM order_costs c WHERE c.order_id=o.id) AS cogs,
      (SELECT count(*)::int FROM stock_movements m WHERE m.order_id=o.id AND m.ingredient_id=$2 AND m.direction='out') AS debit_rows,
      (SELECT COALESCE(SUM(m.quantity),0)::numeric FROM stock_movements m WHERE m.order_id=o.id AND m.ingredient_id=$2 AND m.direction='out') AS debit_quantity
    FROM orders o WHERE o.id=$1 AND o.venue_id=$3`, [order.id, ids.ingredient, ids.venue])).rows[0];
  assert.ok(persisted, 'the browser-created sale order persists in the owner venue'); checks++;
  assert.equal(persisted.status, 'closed'); checks++;
  assert.equal(persisted.table_id, table.id, 'closed order retains the browser-created table link'); checks++;
  assert.equal(persisted.item_rows, 1); checks++;
  assert.equal(persisted.paid_rows, 1); checks++;
  assert.equal(persisted.cost_rows, 1); checks++;
  assert.equal(persisted.cogs, '10.00', '20 ml at 0.50 RUB/ml produces exact 10 RUB COGS'); checks++;
  assert.equal(persisted.debit_rows, 1); checks++;
  assert.equal(Number(persisted.debit_quantity), 20, 'the order writes exactly one 20 ml inventory debit'); checks++;
  assert.equal(await balance(), 80, '100 ml opening stock is reduced by exactly 20 ml'); checks++;
  const floor = await page.evaluate(async () => {
    const response = await fetch('/api/floor', { headers: { Authorization: `Bearer ${localStorage.getItem('crm_session_token')}` } });
    return response.json();
  });
  assert.equal(floor.zones.find((zone) => zone.id === hall.id)?.tables.find((entry) => entry.id === table.id)?.status, 'free', 'paid closed order releases the same table'); checks++;
  assert.deepEqual(pageErrors, [], `browser journey has no page errors: ${pageErrors.join('; ')}`); checks++;
  passed = true;
} finally {
  if (context) await context.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
  if (server && server.exitCode === null && server.signalCode === null) {
    if (process.platform === 'win32') spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `taskkill /PID ${server.pid} /T /F`], { windowsHide: true, stdio: 'ignore' });
    else server.kill('SIGTERM');
    await Promise.race([serverExit, delay(5000)]);
  }
  if (connected) await db.end().catch(() => {});
}

if (passed) console.log(`ACCEPTANCE #47 BROWSER POS JOURNEY: PASS (${checks} assertions; password login → real PIN unlock → UI hall/table → same-ID POS sale → exact stock debit and COGS; isolated runner database)`);
