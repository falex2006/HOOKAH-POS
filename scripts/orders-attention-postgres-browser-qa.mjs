import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID, scrypt as scryptCallback } from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { assertQaDatabaseIdentity, validateQaDatabaseUrl } from './postgres-qa-safety.mjs';

const scrypt = promisify(scryptCallback);
const databaseUrl = process.env.MIGRATIONS_PG_TEST_DATABASE_URL;
const target = validateQaDatabaseUrl(databaseUrl, 'MIGRATIONS_PG_TEST_DATABASE_URL');
const playwrightPath = process.env.PLAYWRIGHT_PACKAGE_PATH;
if (!playwrightPath) throw new Error('Set PLAYWRIGHT_PACKAGE_PATH');
const { Client } = createRequire(import.meta.url)('pg');
const { chromium } = createRequire(import.meta.url)(playwrightPath);
const db = new Client({ connectionString: databaseUrl });
const marker = randomUUID().slice(0, 8);
const ids = {
  organization: randomUUID(), venue: randomUUID(), owner: randomUUID(), staff: randomUUID(),
  open: randomUUID(), progress: randomUUID(), ready: randomUUID(), paid: randomUUID(), due: randomUUID(), cancelled: randomUUID(),
};
const ownerLogin = `qa_orders_attention_${marker}`;
const staffLogin = `qa_orders_attention_staff_${marker}`;
const password = `qa-orders-${randomUUID()}`;
const openedAt = new Date();
const createdAt = {
  open: new Date(openedAt.getTime() - 60_000),
  progress: new Date(openedAt.getTime() - 90_000),
  paid: new Date(openedAt.getTime() - 120_000),
  ready: new Date(openedAt.getTime() - 180_000),
  due: new Date(openedAt.getTime() - 240_000),
  cancelled: new Date(openedAt.getTime() - 300_000),
};
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
  if (!stopped) throw new Error('Order attention QA server did not stop within 5 seconds');
};

try {
  await db.connect();
  connected = true;
  const identity = await db.query('SELECT current_database() AS database,inet_server_addr()::text AS address,inet_server_port() AS port,rolsuper AS superuser FROM pg_roles WHERE rolname=current_user');
  assertQaDatabaseIdentity(identity.rows[0], target.database, Number(target.url.port || 5432));

  const ownerHash = await passwordHash(password);
  const staffHash = await passwordHash(password);
  await db.query('BEGIN');
  try {
    await db.query('INSERT INTO organizations (id,name,slug,plan,timezone,is_active) VALUES ($1,$2,$3,$4,$5,true)', [ids.organization, 'QA Orders Attention', `qa-orders-attention-${marker}`, 'starter', 'Asia/Yekaterinburg']);
    await db.query("INSERT INTO organization_subscriptions (organization_id,plan,status,seats_limit,venues_limit,billing_mode) VALUES ($1,'starter','trialing',5,1,'test_free')", [ids.organization]);
    await db.query('INSERT INTO venues (id,organization_id,name,city,format,timezone,is_current,is_active) VALUES ($1,$2,$3,$4,$5,$6,true,true)', [ids.venue, ids.organization, 'QA Orders Attention Venue', 'Тюмень', 'кальян-бар', 'Asia/Yekaterinburg']);
    await db.query("INSERT INTO users (id,organization_id,venue_id,full_name,login,password_hash,role) VALUES ($1,$2,$3,'QA Orders Owner',$4,$5,'owner'),($6,$2,$3,'QA Orders Staff',$7,$8,'cleaner')", [ids.owner, ids.organization, ids.venue, ownerLogin, ownerHash, ids.staff, staffLogin, staffHash]);
    await db.query("INSERT INTO organization_memberships (organization_id,user_id,membership_role,status,is_primary) VALUES ($1,$2,'owner','active',true),($1,$3,'member','active',false)", [ids.organization, ids.owner, ids.staff]);
    await db.query(`INSERT INTO orders (id,venue_id,opened_by,status,created_at,closed_at,final_total_snapshot)
      VALUES ($1,$2,$3,'open',$4,NULL,NULL),($5,$2,$3,'in_progress',$6,NULL,NULL),($7,$2,$3,'ready',$8,NULL,NULL),($9,$2,$3,'closed',$10,$11,100),($12,$2,$3,'closed',$13,$14,100),($15,$2,$3,'cancelled',$16,$17,100)`, [
      ids.open, ids.venue, ids.owner, createdAt.open, ids.progress, createdAt.progress, ids.ready, createdAt.ready, ids.paid, createdAt.paid, createdAt.paid,
      ids.due, createdAt.due, createdAt.due, ids.cancelled, createdAt.cancelled, createdAt.cancelled,
    ]);
    await db.query("INSERT INTO payments (order_id,method,amount,status,created_at) VALUES ($1,'cash',100,'paid',$2),($3,'cash',70,'paid',$4)", [
      ids.paid, createdAt.paid, ids.due, createdAt.due,
    ]);
    await db.query('COMMIT');
    fixturesCreated = true;
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }

  child = spawn(process.execPath, ['server.js'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    windowsHide: true,
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', DATABASE_URL: databaseUrl, VENUE_ID: ids.venue, AUTH_REQUIRED: 'true', DEMO_MODE: 'false', NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  childExit = new Promise((resolve) => child.once('exit', resolve));
  child.stdout.on('data', (chunk) => { serverOutput += chunk; });
  child.stderr.on('data', (chunk) => { serverOutput += chunk; });
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Order attention server did not start within 15 seconds: ${serverOutput}`)), 15000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    const findAddress = () => {
      const match = serverOutput.match(/CRM running on http:\/\/localhost:(\d+)/);
      if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); }
    };
    child.stdout.on('data', findAddress);
    childExit.then((code) => { if (code !== null) { clearTimeout(timer); reject(new Error(`Order attention server exited before startup (${code}): ${serverOutput}`)); } });
  });
  const healthBody = await (await fetch(`${base}/api/health`)).json();
  assert.equal(healthBody.database, 'postgres');

  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ru-RU' });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => { if (error.message !== 'Transition was aborted because of invalid state. ViewTransition opt-in disabled') pageErrors.push(error.stack || error.message); });
  await page.goto(`${base}/login`, { waitUntil: 'networkidle' });
  await page.locator('#login-username').fill(ownerLogin);
  await page.locator('#login-password').fill(password);
  await page.locator('#login-form button[type="submit"]').click();
  await page.waitForURL((url) => !url.pathname.includes('/login'));
  await page.goto(`${base}/orders`, { waitUntil: 'networkidle' });
  await page.locator('#orders-sort').waitFor({ state: 'visible' });
  await page.locator(`[data-order-id="${ids.open}"]`).waitFor();

  const rowIds = async () => page.locator('#orders-rows > tr[data-order-id]').evaluateAll((rows) => rows.map((row) => row.dataset.orderId));
  const expectedNewest = [ids.open, ids.progress, ids.paid, ids.ready, ids.due, ids.cancelled];
  assert.equal(await page.locator('#orders-sort').inputValue(), 'newest', 'default sort is newest first');
  assert.deepEqual(await rowIds(), expectedNewest, 'populated queue defaults to newest-first order');
  await page.locator(`[data-order-id="${ids.open}"]`).getByText('Требует внимания: Заказ открыт').waitFor();
  await page.locator(`[data-order-id="${ids.progress}"]`).getByText('Требует внимания: Заказ готовится').waitFor();
  await page.locator(`[data-order-id="${ids.ready}"]`).getByText('Требует внимания: Готов к выдаче').waitFor();
  await page.locator(`[data-order-id="${ids.due}"]`).getByText('Требует внимания: Остаток оплаты').waitFor();
  assert.equal(await page.locator(`[data-order-id="${ids.paid}"] .order-attention-note`).count(), 0, 'fully paid closed order has no attention note');
  assert.equal(await page.locator(`[data-order-id="${ids.cancelled}"] .order-attention-note`).count(), 0, 'cancelled order with stale unpaid snapshot is not presented as customer-payable');

  const apiResult = await page.evaluate(async () => {
    const response = await fetch('/api/orders?scope=all&attention=1');
    return { status: response.status, body: await response.json() };
  });
  assert.equal(apiResult.status, 200);
  assert.deepEqual(apiResult.body.items.map((order) => order.id).sort(), [ids.open, ids.progress, ids.ready, ids.due].sort(), 'API attention filter matches operational status and authoritative amount due');
  assert.deepEqual(apiResult.body.items.find((order) => order.id === ids.due).attentionReasons, ['payment_due']);
  assert.equal(apiResult.body.items.find((order) => order.id === ids.paid), undefined);
  assert.equal(apiResult.body.items.find((order) => order.id === ids.cancelled), undefined, 'cancelled stale amount is excluded from attention queue');

  const staffContext = await browser.newContext();
  const staffLoginResponse = await staffContext.request.post(`${base}/api/login`, { data: { username: staffLogin, password } });
  assert.equal(staffLoginResponse.status(), 200);
  const staffToken = (await staffLoginResponse.json()).token;
  const deniedList = await staffContext.request.get(`${base}/api/orders?scope=all`, { headers: { Authorization: `Bearer ${staffToken}` } });
  assert.equal(deniedList.status(), 403, 'role without order permission cannot read the order queue');
  await staffContext.close();

  await page.locator('#orders-sort').selectOption('attention');
  const attentionSorted = await rowIds();
  assert.deepEqual(attentionSorted.slice(0, 4).sort(), [ids.open, ids.progress, ids.ready, ids.due].sort(), 'attention sort places all actionable orders first');
  assert.deepEqual(attentionSorted.slice(4), [ids.paid, ids.cancelled], 'settled closed/cancelled rows follow attention rows');

  await page.locator('#orders-status').selectOption('closed');
  assert.deepEqual((await rowIds()).sort(), [ids.paid, ids.due].sort(), 'status filter redraws populated rows without losing selected attention sort');
  await page.locator('#orders-status').selectOption('');
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(await page.locator('#orders-sort').inputValue(), 'newest', 'a fresh page load restores the default sort');
  assert.deepEqual(await rowIds(), expectedNewest, 'reload restores newest-first order from PostgreSQL timestamps');

  for (const width of [320, 375, 768, 1440]) {
    await page.setViewportSize({ width, height: 800 });
    const layout = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth + 1, firstRowVisible: Boolean(document.querySelector('#orders-rows tr[data-order-id]')?.getClientRects().length), reasonVisible: Boolean(document.querySelector('.order-attention-note')?.getClientRects().length) }));
    assert.equal(layout.overflow, false, `order queue overflows at ${width}px`);
    assert.equal(layout.firstRowVisible, true, `order queue is hidden at ${width}px`);
    assert.equal(layout.reasonVisible, true, `attention reason is hidden at ${width}px`);
  }
  assert.deepEqual(pageErrors, [], `browser exceptions: ${pageErrors.join('; ')}`);
  await context.close();
  passed = true;
} finally {
  let teardownError;
  try { if (browser) await closeWithin(browser.close(), 'Playwright browser'); } catch (error) { teardownError = error; }
  try { await cleanupChild(); } catch (error) { teardownError ||= error; }
  if (connected && fixturesCreated) {
    try {
      await db.query('BEGIN');
      try {
        await db.query('DELETE FROM auth_sessions WHERE user_id=ANY($1::uuid[])', [[ids.owner, ids.staff]]);
        await db.query('DELETE FROM audit_events WHERE venue_id=$1 OR actor_id=ANY($2::uuid[])', [ids.venue, [ids.owner, ids.staff]]);
        await db.query('DELETE FROM payments WHERE order_id=ANY($1::uuid[])', [[ids.open, ids.progress, ids.ready, ids.paid, ids.due, ids.cancelled]]);
        await db.query('DELETE FROM order_items WHERE order_id=ANY($1::uuid[])', [[ids.open, ids.progress, ids.ready, ids.paid, ids.due, ids.cancelled]]);
        await db.query('DELETE FROM orders WHERE id=ANY($1::uuid[])', [[ids.open, ids.progress, ids.ready, ids.paid, ids.due, ids.cancelled]]);
        await db.query('DELETE FROM organization_memberships WHERE organization_id=$1', [ids.organization]);
        await db.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [[ids.owner, ids.staff]]);
        await db.query('DELETE FROM venues WHERE id=$1', [ids.venue]);
        await db.query('DELETE FROM organization_subscriptions WHERE organization_id=$1', [ids.organization]);
        await db.query('DELETE FROM organizations WHERE id=$1', [ids.organization]);
        await db.query('COMMIT');
      } catch (error) {
        await db.query('ROLLBACK');
        throw error;
      }
      assert.equal((await db.query('SELECT COUNT(*)::int AS count FROM orders WHERE id=ANY($1::uuid[])', [[ids.open, ids.progress, ids.ready, ids.paid, ids.due, ids.cancelled]])).rows[0].count, 0, 'QA orders cleanup completed');
      assert.equal((await db.query('SELECT COUNT(*)::int AS count FROM organizations WHERE id=$1', [ids.organization])).rows[0].count, 0, 'QA organization cleanup completed');
    } catch (error) {
      teardownError ||= error;
    }
  }
  try { if (connected) await closeWithin(db.end(), 'PostgreSQL connection'); } catch (error) { teardownError ||= error; }
  if (teardownError) throw teardownError;
}

if (passed) console.log('ORDERS ATTENTION POSTGRES BROWSER QA: PASS (newest default, reasons, paid vs due, attention filter/sort, status filter, reload, four widths, cleanup)');
