import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { validateQaDatabaseUrl, assertQaDatabaseIdentity } from './postgres-qa-safety.mjs';

const databaseUrl = process.env.MIGRATIONS_PG_TEST_DATABASE_URL;
const target = validateQaDatabaseUrl(databaseUrl, 'MIGRATIONS_PG_TEST_DATABASE_URL');
const playwrightPath = process.env.PLAYWRIGHT_PACKAGE_PATH;
if (!playwrightPath) throw new Error('Set PLAYWRIGHT_PACKAGE_PATH');
const require = createRequire(import.meta.url);
const { Client } = require('pg');
const { chromium } = require(playwrightPath);
const db = new Client({ connectionString: databaseUrl });
const ids = { organization: randomUUID(), venue: randomUUID(), user: randomUUID(), zone: randomUUID(), source: randomUUID(), destination: randomUUID(), blocked: randomUUID(), occupied: randomUUID(), product: randomUUID(), order: randomUUID(), otherOrder: randomUUID() };
const qaLogin = `pos-transfer-${ids.venue}`;
const qaPassword = 'qa-browser-admin';
const salt = randomBytes(16).toString('hex');
const passwordHash = `scrypt$${salt}$${scryptSync(qaPassword, salt, 64).toString('hex')}`;
let browser;
let server;
let serverExit;
let connected = false;
let fixtureCreated = false;
let passed = false;

try {
  await db.connect();
  connected = true;
  const identity = (await db.query(`SELECT current_database() AS database, inet_server_addr()::text AS address, inet_server_port() AS port,
    (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser`)).rows[0];
  assertQaDatabaseIdentity(identity, target.database, Number(target.url.port || 5432), 'POS transfer browser QA database');
  await db.query('BEGIN');
  try {
    await db.query("INSERT INTO organizations (id,name,slug,plan) VALUES ($1,'Isolated POS transfer QA',$2,'starter')", [ids.organization, `pos-transfer-${ids.organization}`]);
    await db.query("INSERT INTO organization_subscriptions (organization_id,plan,status,seats_limit,venues_limit) VALUES ($1,'starter','trialing',20,5)", [ids.organization]);
    await db.query("INSERT INTO venues (id,organization_id,name,timezone) VALUES ($1,$2,'Isolated POS transfer QA','Asia/Yekaterinburg')", [ids.venue, ids.organization]);
    await db.query("INSERT INTO users (id,venue_id,organization_id,full_name,login,password_hash,role) VALUES ($1,$2,$3,'POS transfer QA',$4,$5,'admin')", [ids.user, ids.venue, ids.organization, qaLogin, passwordHash]);
    await db.query("INSERT INTO organization_memberships (organization_id,user_id,membership_role,status) VALUES ($1,$2,'admin','active')", [ids.organization, ids.user]);
    await db.query("INSERT INTO shifts (venue_id,opened_by,opening_cash) VALUES ($1,$2,0)", [ids.venue, ids.user]);
    await db.query("INSERT INTO zones (id,venue_id,name) VALUES ($1,$2,'QA зал переноса')", [ids.zone, ids.venue]);
    for (const [id, name, status] of [[ids.source, 'QA исходный', 'occupied'], [ids.destination, 'QA целевой', 'free'], [ids.blocked, 'QA закрытый', 'blocked'], [ids.occupied, 'QA занятый', 'occupied']]) {
      await db.query('INSERT INTO tables (id,zone_id,name,status) VALUES ($1,$2,$3,$4)', [id, ids.zone, name, status]);
    }
    await db.query("INSERT INTO products (id,venue_id,name,category,sale_price,inventory_mode) VALUES ($1,$2,'QA услуга переноса','Услуги',100,'non_stock')", [ids.product, ids.venue]);
    await db.query("INSERT INTO orders (id,venue_id,table_id,opened_by,status) VALUES ($1,$2,$3,$4,'open'),($5,$2,$6,$4,'open')", [ids.order, ids.venue, ids.source, ids.user, ids.otherOrder, ids.occupied]);
    await db.query("INSERT INTO order_items (order_id,product_id,quantity,unit_price,station) VALUES ($1,$2,1,100,'bar')", [ids.order, ids.product]);
    await db.query('COMMIT');
    fixtureCreated = true;
  } catch (error) { await db.query('ROLLBACK'); throw error; }

  server = spawn(process.execPath, ['server.js'], { cwd: fileURLToPath(new URL('../', import.meta.url)), windowsHide: true,
    env: { ...process.env, DATABASE_URL: databaseUrl, VENUE_ID: ids.venue, AUTH_REQUIRED: 'false', DEMO_MODE: 'false', NODE_ENV: 'test', HOST: '127.0.0.1', PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  serverExit = new Promise((resolve) => server.once('exit', resolve));
  let output = '';
  server.stdout.on('data', (chunk) => { output += chunk; });
  server.stderr.on('data', (chunk) => { output += chunk; });
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`POS transfer QA server did not start: ${output}`)), 20000);
    server.once('error', reject);
    server.stdout.on('data', () => { const match = output.match(/CRM running on http:\/\/localhost:(\d+)/); if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); } });
  });
  assert.equal((await (await fetch(`${base}/api/health`)).json()).database, 'postgres');
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 375, height: 812 }, locale: 'ru-RU' });
  const errors = [];
  page.on('pageerror', (error) => { if (error.message !== 'Transition was aborted because of invalid state. ViewTransition opt-in disabled') errors.push(error.message); });
  await page.goto(`${base}/login`, { waitUntil: 'networkidle' });
  await page.locator('#login-username').fill(qaLogin);
  await page.locator('#login-password').fill(qaPassword);
  await page.locator('#login-form button[type="submit"]').click();
  // The login handler uses replace() and a local session token; wait for the
  // authenticated state rather than assuming a navigation event is observable.
  await page.waitForFunction(() => Boolean(localStorage.getItem('crm_session_token')));
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.locator(`[data-zone-id="${ids.zone}"]`).click();
  await page.locator(`[data-table="${ids.source}"]`).click();
  assert.equal(await page.locator('#transfer-order').isDisabled(), false);
  await page.locator('#transfer-order').click();
  const select = page.locator('#staff-action-form select[name="tableId"]');
  await select.waitFor();
  assert.equal(await select.locator(`option[value="${ids.destination}"]`).count(), 1);
  for (const id of [ids.source, ids.blocked, ids.occupied]) assert.equal(await select.locator(`option[value="${id}"]`).count(), 0, `unavailable table ${id} omitted`);
  await select.selectOption(ids.destination);
  const sent = page.waitForRequest((request) => request.method() === 'POST' && request.url().endsWith(`/api/orders/${ids.order}/transfer`));
  const response = page.waitForResponse((result) => result.request().method() === 'POST' && result.url().endsWith(`/api/orders/${ids.order}/transfer`));
  await page.locator('#staff-action-submit').click();
  assert.equal((await sent).postDataJSON().tableId, ids.destination, 'POS sends exact PostgreSQL table UUID');
  assert.equal((await response).status(), 200);
  const persisted = await db.query('SELECT table_id AS "tableId" FROM orders WHERE id=$1', [ids.order]);
  assert.equal(persisted.rows[0].tableId, ids.destination);
  const tableStates = (await db.query('SELECT id,status FROM tables WHERE id=ANY($1::uuid[])', [[ids.source, ids.destination]])).rows;
  assert.equal(tableStates.find((table) => table.id === ids.source).status, 'free');
  assert.equal(tableStates.find((table) => table.id === ids.destination).status, 'occupied');
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator(`[data-zone-id="${ids.zone}"]`).click();
  await page.locator(`[data-table="${ids.destination}"]`).click();
  assert.match(await page.locator('.order h2').innerText(), /QA целевой/);
  const invalid = await page.evaluate(async ({ order, blocked, occupied, missing }) => {
    const send = async (tableId) => { const response = await fetch(`/api/orders/${order}/transfer`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tableId }) }); return { status: response.status, body: await response.json() }; };
    return { blocked: await send(blocked), occupied: await send(occupied), missing: await send(missing) };
  }, { order: ids.order, blocked: ids.blocked, occupied: ids.occupied, missing: randomUUID() });
  assert.deepEqual([invalid.blocked.status, invalid.blocked.body.error], [404, 'target_table_not_found']);
  assert.deepEqual([invalid.occupied.status, invalid.occupied.body.error], [409, 'target_table_has_active_order']);
  assert.deepEqual([invalid.missing.status, invalid.missing.body.error], [404, 'target_table_not_found']);
  assert.deepEqual(errors, [], `POS page errors: ${errors.join('; ')}`);
  passed = true;
} finally {
  await browser?.close();
  if (server && server.exitCode === null && server.signalCode === null) server.kill();
  if (serverExit && server?.exitCode === null && server?.signalCode === null) await Promise.race([serverExit, delay(3000)]);
  if (connected) {
    if (fixtureCreated) {
      await db.query('BEGIN');
      try {
        await db.query('DELETE FROM audit_events WHERE venue_id=$1', [ids.venue]);
        await db.query('DELETE FROM order_items WHERE order_id IN ($1,$2)', [ids.order, ids.otherOrder]);
        await db.query('DELETE FROM orders WHERE venue_id=$1', [ids.venue]);
        await db.query('DELETE FROM products WHERE venue_id=$1', [ids.venue]);
        await db.query('DELETE FROM shifts WHERE venue_id=$1', [ids.venue]);
        await db.query('ALTER TABLE inventory_purchase_reversal_policies DISABLE TRIGGER USER');
        await db.query('DELETE FROM inventory_purchase_reversal_policies WHERE venue_id=$1', [ids.venue]);
        await db.query('ALTER TABLE inventory_purchase_reversal_policies ENABLE TRIGGER USER');
        await db.query('DELETE FROM users WHERE venue_id=$1', [ids.venue]);
        await db.query('DELETE FROM zones WHERE venue_id=$1', [ids.venue]);
        await db.query('DELETE FROM venues WHERE id=$1', [ids.venue]);
        await db.query('DELETE FROM organizations WHERE id=$1', [ids.organization]);
        await db.query('COMMIT');
      } catch (error) { await db.query('ROLLBACK'); throw error; }
      assert.equal(Number((await db.query('SELECT count(*) AS count FROM venues WHERE id=$1', [ids.venue])).rows[0].count), 0, 'QA venue removed');
    }
    await db.end();
  }
}
if (passed) console.log('POS TRANSFER POSTGRES BROWSER QA: PASS (UUID selection, persisted transfer, unavailable targets, cleanup)');
