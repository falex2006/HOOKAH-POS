import assert from 'node:assert/strict';
import { randomBytes, randomUUID, randomInt, scryptSync, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { validateQaDatabaseUrl, assertQaDatabaseIdentity } from './postgres-qa-safety.mjs';

const url = process.env.STAFF_PIN_CARD_TEST_DATABASE_URL;
const target = validateQaDatabaseUrl(url, 'Staff PIN card QA');
assert.equal(target.url.hostname, '127.0.0.1');
assert.equal(target.url.port, '31931');
assert.match(target.database, /^orders_qa_[a-f0-9]{16}$/);
assert.equal(target.database, process.env.LOCAL_FULL_PG_OWNED_DATABASE);
const require = createRequire(import.meta.url);
await require('./local-full-pg-regression.cjs').verifyOwnerPinQaDatabaseUrl(url);
assert.ok(process.env.PLAYWRIGHT_PACKAGE_PATH && process.env.CHROME_PATH, 'Configured browser package and executable required');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE_PATH);
const db = new pg.Client({ connectionString: url });
const org = randomUUID(), venue = randomUUID(), owner = randomUUID();
const username = 'qa_staff36_' + randomBytes(8).toString('hex');
const password = randomBytes(32).toString('hex');
const pin = String(randomInt(0, 10000)).padStart(4, '0');
const nextPin = String((Number(pin) + randomInt(1, 10000)) % 10000).padStart(4, '0');
const worker = randomUUID(), workerLogin = 'qa_staff36_' + randomBytes(8).toString('hex');
const workerPassword = randomBytes(32).toString('hex');
const workerSalt = randomBytes(16).toString('hex');
const workerHash = `scrypt$${workerSalt}$${scryptSync(workerPassword, workerSalt, 64).toString('hex')}`;
const salt = randomBytes(16).toString('hex');
const hash = `scrypt$${salt}$${scryptSync(password, salt, 64).toString('hex')}`;
let browser, child, childClosed, connected = false;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  await db.connect(); connected = true;
  assertQaDatabaseIdentity((await db.query('SELECT current_database() AS database,inet_server_addr()::text AS address,inet_server_port() AS port,rolsuper AS superuser FROM pg_roles WHERE rolname=current_user')).rows[0], target.database, 31931);
  await db.query('BEGIN');
  try {
    await db.query("INSERT INTO organizations(id,name,slug,plan) VALUES($1,'Synthetic staff36 QA',$2,'starter')", [org, username]);
    await db.query("INSERT INTO organization_subscriptions(organization_id,plan,status,seats_limit,venues_limit,billing_mode) VALUES($1,'starter','trialing',5,1,'test_free')", [org]);
    await db.query("INSERT INTO venues(id,organization_id,name,is_current,is_active) VALUES($1,$2,'Synthetic staff36 venue',true,true)", [venue, org]);
    await db.query("INSERT INTO users(id,organization_id,venue_id,full_name,login,password_hash,role) VALUES($1,$2,$3,'Synthetic staff36',$4,$5,'owner')", [owner, org, venue, username, hash]);
    await db.query("INSERT INTO organization_memberships(organization_id,user_id,membership_role,status,is_primary) VALUES($1,$2,'owner','active',true)", [org, owner]);
    await db.query("INSERT INTO users(id,organization_id,venue_id,full_name,login,password_hash,role) VALUES($1,$2,$3,'Synthetic staff36 worker',$4,$5,'bartender')", [worker, org, venue, workerLogin, workerHash]);
    await db.query("INSERT INTO organization_memberships(organization_id,user_id,membership_role,status) VALUES($1,$2,'member','active')", [org, worker]);
    await db.query('COMMIT');
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  let output = '';
  child = spawn(process.execPath, ['server.js'], { cwd: fileURLToPath(new URL('../', import.meta.url)), windowsHide: true,
    env: { ...process.env, DATABASE_URL: url, HOST: '127.0.0.1', PORT: '0', VENUE_ID: venue, AUTH_REQUIRED: 'true', DEMO_MODE: 'false', NODE_ENV: 'test' }, stdio: ['ignore','pipe','pipe'] });
  childClosed = new Promise(resolve => child.once('close', resolve));
  let startupError;
  child.once('error', error => { startupError = error; });
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  let base;
  for (let i = 0; i < 300; i++) {
    assert.ok(!startupError && child.exitCode === null, 'Owned QA server failed to start');
    const match = output.match(/CRM running on http:\/\/localhost:(\d+)/);
    if (match) { base = `http://127.0.0.1:${match[1]}`; break; }
    await delay(50);
  }
  assert.ok(base, 'Owned QA server startup timeout');
  assert.equal((await (await fetch(base + '/api/health')).json()).database, 'postgres');
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  page.setDefaultNavigationTimeout(30000);
  await page.goto(base + '/login', { waitUntil: 'networkidle' });
  await page.locator('#login-username').fill(username);
  await page.locator('#login-password').fill(password);
  await page.locator('#login-form button[type="submit"]').click();
  await page.waitForURL(u => u.pathname !== '/login');
  await page.goto(base + '/admin#staff', { waitUntil: 'networkidle' });
  const modal = page.locator('.staff-admin-modal');
  const openCard = async () => {
    await page.locator('.staff-edit[data-staff="' + worker + '"]').click();
    await modal.waitFor({ state: 'visible' });
    await page.waitForFunction(() => !document.querySelector('.staff-admin-modal [name="customRoleId"]')?.hasAttribute('aria-busy'));
  };
  const savePin = async value => {
    await modal.locator('[name="pin_new"]').fill(value);
    await modal.locator('[name="pin_confirm"]').fill(value);
    const profile = page.waitForResponse(r => r.url().endsWith('/api/staff/' + worker + '/profile') && r.request().method() === 'PATCH');
    const saved = page.waitForResponse(r => r.url().endsWith('/api/staff/' + worker + '/pin') && r.request().method() === 'PATCH');
    await modal.locator('button[type="submit"]').click();
    assert.equal((await profile).status(), 200);
    assert.equal((await saved).status(), 200);
    await modal.waitFor({ state: 'detached' });
  };
  await openCard();
  // A real profile save followed by a simulated transport/server failure of only the PIN PATCH.
  const rejectPin = route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'staff_pin_save_failed' }) });
  await page.route('**/api/staff/' + worker + '/pin', rejectPin);
  await modal.locator('[name="workNotes"]').fill('Synthetic partial save evidence');
  await modal.locator('[name="pin_new"]').fill(pin);
  await modal.locator('[name="pin_confirm"]').fill(pin);
  const profileSaved = page.waitForResponse(r => r.url().endsWith('/api/staff/' + worker + '/profile') && r.request().method() === 'PATCH');
  const pinFailed = page.waitForResponse(r => r.url().endsWith('/api/staff/' + worker + '/pin') && r.request().method() === 'PATCH');
  await modal.locator('button[type="submit"]').click();
  assert.equal((await profileSaved).status(), 200);
  assert.equal((await pinFailed).status(), 503);
  await page.waitForFunction(() => document.querySelector('.staff-admin-message')?.textContent.includes('Карточка сохранена, но PIN не установлен'));
  assert.equal(await modal.count(), 1, 'Failed PIN update keeps card open');
  const partial = (await db.query('SELECT work_notes, pin_hash IS NOT NULL AS configured FROM users WHERE id=$1', [worker])).rows[0];
  assert.equal(partial.work_notes, 'Synthetic partial save evidence');
  assert.equal(partial.configured, false, 'Failed PIN update does not create a PIN');
  await page.unroute('**/api/staff/' + worker + '/pin', rejectPin);
  await savePin(pin);
  assert.equal((await db.query('SELECT pin_hash IS NOT NULL AS configured FROM users WHERE id=$1', [worker])).rows[0].configured, true);
  // Reopen from the refreshed server-backed directory before using the worker account.
  await openCard();
  assert.equal(await modal.locator('.staff-admin-pin-state').innerText(), 'Настроен');
  assert.equal(await modal.locator('[name="pin_new"]').inputValue(), '');
  assert.equal(await modal.locator('[name="pin_confirm"]').inputValue(), '');
  await modal.locator('.staff-admin-close').click();
  const staffContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const staffPage = await staffContext.newPage();
  staffPage.setDefaultTimeout(30000); staffPage.setDefaultNavigationTimeout(30000);
  await staffPage.goto(base + '/login', { waitUntil: 'networkidle' });
  await staffPage.locator('#login-username').fill(workerLogin);
  await staffPage.locator('#login-password').fill(workerPassword);
  await staffPage.locator('#login-form button[type="submit"]').click();
  await staffPage.waitForURL(u => u.pathname !== '/login');
  await staffPage.locator('#lock-screen-button').waitFor();
  const originalRoute = staffPage.url();
  const token = await staffPage.evaluate(() => localStorage.getItem('crm_session_token'));
  assert.ok(token);
  const cookie = (await staffContext.cookies()).find(c => c.name === 'crm_session')?.value;
  assert.ok(cookie === token, 'Own worker cookie and bearer match');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const sessionRows = async () => (await db.query('SELECT user_id,created_at,expires_at,token_hash=$2 AS matches FROM auth_sessions WHERE user_id=$1 ORDER BY created_at', [worker, tokenHash])).rows;
  const initialSessions = await sessionRows();
  assert.equal(initialSessions.length, 1); assert.equal(initialSessions[0].matches, true);
  const lock = async () => {
    await staffPage.locator('#lock-screen-button').click();
    await staffPage.locator('.screen-lock-overlay[aria-hidden="false"]').waitFor({ state: 'visible' });
    assert.equal(await staffPage.locator('.screen-lock-overlay').getAttribute('data-reason'), 'manual');
  };
  const unlock = async (value, status) => {
    const response = staffPage.waitForResponse(r => r.url().endsWith('/api/session/unlock') && r.request().method() === 'POST');
    await staffPage.locator('#screen-lock-pin').fill(value);
    const result = await response;
    assert.equal(result.status(), status);
    if (status === 401) assert.equal((await result.json()).error, 'invalid_pin');
    if (status === 200) await staffPage.waitForFunction(() => document.querySelector('.screen-lock-overlay')?.getAttribute('aria-hidden') === 'true' && !document.body.classList.contains('screen-locked'));
    else {
      await staffPage.waitForFunction(() => Boolean(document.querySelector('#screen-lock-message')?.textContent));
      assert.equal(await staffPage.locator('.screen-lock-overlay').getAttribute('aria-hidden'), 'false');
    }
  };
  await lock(); await unlock(pin, 200);
  await openCard(); await savePin(nextPin);
  await lock(); await unlock(pin, 401); await unlock(nextPin, 200);
  assert.equal(staffPage.url(), originalRoute);
  assert.ok(await staffPage.evaluate(() => localStorage.getItem('crm_session_token')) === token, 'Worker bearer unchanged');
  assert.ok((await staffContext.cookies()).find(c => c.name === 'crm_session')?.value === cookie, 'Worker cookie unchanged');
  assert.ok(JSON.stringify(await sessionRows()) === JSON.stringify(initialSessions), 'Worker persisted session unchanged');
  const active = await staffContext.request.get(base + '/api/session', { headers: { Authorization: 'Bearer ' + token } });
  assert.equal(active.status(), 200);
  const user = (await active.json()).user;
  assert.equal(user.id, worker); assert.equal(user.organizationId, org); assert.equal(user.venueId, venue);
  console.log('STAFF36 PIN CARD BROWSER PG QA: PASS (card profile200/PIN503 truthful error, retry PIN save, worker manual lock, external card PIN change, old401/new200, same session)');
} finally {
  try { if (browser) await browser.close(); }
  finally {
    try {
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill();
        assert.equal(await Promise.race([childClosed.then(() => true), delay(5000).then(() => false)]), true, 'Owned QA server cleanup timeout');
      }
    } finally { if (connected) await db.end(); }
  }
}
