import assert from 'node:assert/strict';
import { randomBytes, randomUUID, randomInt, scryptSync, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { validateQaDatabaseUrl, assertQaDatabaseIdentity } from './postgres-qa-safety.mjs';

const url = process.env.CROSS_TAB_LOCK_TEST_DATABASE_URL;
const target = validateQaDatabaseUrl(url, 'Cross-tab lock/logout QA');
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
const username = 'qa_tabs4041_' + randomBytes(8).toString('hex');
const password = randomBytes(32).toString('hex');
const pin = String(randomInt(0, 10000)).padStart(4, '0');
const salt = randomBytes(16).toString('hex');
const hash = `scrypt$${salt}$${scryptSync(password, salt, 64).toString('hex')}`;
let browser, child, childClosed, connected = false;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  await db.connect(); connected = true;
  assertQaDatabaseIdentity((await db.query('SELECT current_database() AS database,inet_server_addr()::text AS address,inet_server_port() AS port,rolsuper AS superuser FROM pg_roles WHERE rolname=current_user')).rows[0], target.database, 31931);
  await db.query('BEGIN');
  try {
    await db.query("INSERT INTO organizations(id,name,slug,plan) VALUES($1,'Synthetic tabs4041 QA',$2,'starter')", [org, username]);
    await db.query("INSERT INTO organization_subscriptions(organization_id,plan,status,seats_limit,venues_limit,billing_mode) VALUES($1,'starter','trialing',5,1,'test_free')", [org]);
    await db.query("INSERT INTO venues(id,organization_id,name,is_current,is_active) VALUES($1,$2,'Synthetic tabs4041 venue',true,true)", [venue, org]);
    await db.query("INSERT INTO users(id,organization_id,venue_id,full_name,login,password_hash,role) VALUES($1,$2,$3,'Synthetic tabs4041',$4,$5,'owner')", [owner, org, venue, username, hash]);
    await db.query("INSERT INTO organization_memberships(organization_id,user_id,membership_role,status,is_primary) VALUES($1,$2,'owner','active',true)", [org, owner]);
    const pinSalt = randomBytes(16).toString('hex');
    const pinHash = 'scrypt$' + pinSalt + '$' + scryptSync(pin, pinSalt, 64).toString('hex');
    await db.query('UPDATE users SET pin_hash=$1,pin_updated_at=now(),preferences=$2::jsonb WHERE id=$3', [pinHash, JSON.stringify({lockTimeoutMinutes:0}), owner]);
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
  await page.goto(base + '/admin', { waitUntil: 'networkidle' });
  const token = await page.evaluate(() => localStorage.getItem('crm_session_token'));
  assert.ok(token);
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const sessionRows = async () => (await db.query('SELECT token_hash,user_id,created_at,expires_at FROM auth_sessions WHERE user_id=$1 ORDER BY created_at', [owner])).rows;
  const initialSessions = await sessionRows();
  assert.equal(initialSessions.length, 1);
  assert.ok(initialSessions[0].token_hash === tokenHash, 'Session hash matches browser bearer');
  const initialCookie = (await context.cookies()).find(cookie => cookie.name === 'crm_session')?.value;
  assert.ok(initialCookie === token, 'Cookie matches browser bearer');
  const second = await context.newPage();
  second.setDefaultTimeout(30000); second.setDefaultNavigationTimeout(30000);
  await second.goto(base + '/admin', { waitUntil: 'networkidle' });
  await second.locator('#lock-screen-button').waitFor();
  const originalRoute = page.url(), secondRoute = second.url();
  const locked = async tab => {
    await tab.waitForFunction(() => document.querySelector('.screen-lock-overlay')?.getAttribute('aria-hidden') === 'false' && document.body.classList.contains('screen-locked'));
  };
  const unlocked = async tab => {
    await tab.waitForFunction(() => document.querySelector('.screen-lock-overlay')?.getAttribute('aria-hidden') === 'true' && !document.body.classList.contains('screen-locked'));
  };
  const preserved = async () => {
    for (const tab of [page, second]) assert.ok(await tab.evaluate(() => localStorage.getItem('crm_session_token')) === token, 'Shared bearer remains unchanged');
    assert.ok((await context.cookies()).find(c => c.name === 'crm_session')?.value === initialCookie, 'Shared cookie remains unchanged');
    assert.ok(JSON.stringify(await sessionRows()) === JSON.stringify(initialSessions), 'Same persisted session remains active');
    const active = await context.request.get(base + '/api/session', { headers: { Authorization: 'Bearer ' + token } });
    assert.equal(active.status(),200); assert.equal((await active.json()).user.id,owner);
  };
  await page.locator('#lock-screen-button').click();
  await Promise.all([locked(page), locked(second)]);
  await preserved();
  await second.reload({ waitUntil: 'networkidle' });
  await locked(second);
  assert.equal(page.url(),originalRoute); assert.equal(second.url(),secondRoute);
  let secondUnlocks=0;
  let totalUnlocks=0,totalLogouts=0;
  context.on('request',r=>{if(r.method()==='POST'){if(r.url().endsWith('/api/session/unlock'))totalUnlocks++;if(r.url().endsWith('/api/logout'))totalLogouts++;}});
  second.on('request',r=>{if(r.url().endsWith('/api/session/unlock') && r.method()==='POST') secondUnlocks++;});
  const response = page.waitForResponse(r=>r.url().endsWith('/api/session/unlock') && r.request().method()==='POST');
  await page.locator('#screen-lock-pin').fill(pin);
  assert.equal((await response).status(),200);
  await Promise.all([unlocked(page),unlocked(second)]);
  assert.equal(secondUnlocks,0,'Second tab accepts confirmed unlock event without another PIN request');
  assert.equal(totalUnlocks,1,'Exactly one PIN unlock request across both tabs');
  assert.equal(page.url(),originalRoute); assert.equal(second.url(),secondRoute);
  await preserved();
  await page.locator('#lock-screen-button').click();
  await Promise.all([locked(page),locked(second)]);
  const logout = second.waitForResponse(r=>r.url().endsWith('/api/logout') && r.request().method()==='POST');
  await second.locator('#screen-lock-exit').click();
  assert.equal((await logout).status(),200);
  assert.equal(totalLogouts,1,'Exactly one logout request across both tabs');
  await Promise.all([page.waitForURL(u=>u.pathname==='/login'),second.waitForURL(u=>u.pathname==='/login')]);
  for(const tab of [page,second]) {
    assert.ok(await tab.evaluate(()=>localStorage.getItem('crm_session_token')) === null, 'Shared bearer cleared');
    assert.ok(await tab.evaluate(()=>localStorage.getItem('crm_session_user')) === null, 'Shared identity cleared');
  }
  assert.ok(!(await context.cookies()).some(c=>c.name==='crm_session'), 'Logout cookie removed');
  for (let i=0;i<100 && (await sessionRows()).length;i++) await delay(50);
  assert.equal((await sessionRows()).length,0,'Logout revokes original persisted server session');
  const revoked = await context.request.get(base+'/api/session',{headers:{Authorization:'Bearer '+token}});
  assert.equal(revoked.status(),401);
  await second.reload({waitUntil:'networkidle'});
  assert.equal(new URL(second.url()).pathname,'/login');
  assert.equal(await second.locator('.screen-lock-overlay').count(),0,'Reload after logout cannot restore workspace lock');
  assert.equal(await second.locator('.trusted-pin-card').isVisible(),false,'Revoked session has no trusted PIN return card');
  console.log('CROSS TAB40/41 BROWSER PG QA: PASS (manual lock both tabs, locked reload, explicit unlock sync same session, logout both login, revoked bearer401)');
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
