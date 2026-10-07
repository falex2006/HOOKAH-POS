import assert from 'node:assert/strict';
import { randomBytes, randomUUID, randomInt, scryptSync, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { validateQaDatabaseUrl, assertQaDatabaseIdentity } from './postgres-qa-safety.mjs';

const url = process.env.AUTOLOCK_EXPIRY_TEST_DATABASE_URL;
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
const username = 'qa_expiry41_' + randomBytes(8).toString('hex');
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
    await db.query("INSERT INTO organizations(id,name,slug,plan) VALUES($1,'Synthetic expiry41 QA',$2,'starter')", [org, username]);
    await db.query("INSERT INTO organization_subscriptions(organization_id,plan,status,seats_limit,venues_limit,billing_mode) VALUES($1,'starter','trialing',5,1,'test_free')", [org]);
    await db.query("INSERT INTO venues(id,organization_id,name,is_current,is_active) VALUES($1,$2,'Synthetic expiry41 venue',true,true)", [venue, org]);
    await db.query("INSERT INTO users(id,organization_id,venue_id,full_name,login,password_hash,role) VALUES($1,$2,$3,'Synthetic expiry41',$4,$5,'owner')", [owner, org, venue, username, hash]);
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
  // Both navigations settled at networkidle. Verify initial controls before a real UI change.
  await second.locator('#lock-settings-button').click();
  assert.equal(await second.locator('#lock-timeout-select').inputValue(),'0');
  await second.locator('.lock-settings-close').click();
  await page.locator('#lock-settings-button').click();
  assert.equal(await page.locator('#lock-timeout-select').inputValue(),'0');
  await page.locator('#lock-timeout-select').selectOption('1');
  const saved=page.waitForResponse(r=>r.url().endsWith('/api/session/preferences') && r.request().method()==='PATCH');
  await page.locator('.lock-settings-save').click();
  assert.equal((await saved).status(),200);
  assert.equal(Number((await db.query('SELECT preferences FROM users WHERE id=$1',[owner])).rows[0].preferences.lockTimeoutMinutes),1);
  await second.waitForFunction(()=>Number(JSON.parse(localStorage.getItem('crm_session_user')||'{}').preferences?.lockTimeoutMinutes)===1);
  await second.locator('#lock-settings-button').click();
  const secondTimeout=await second.locator('#lock-timeout-select').inputValue();
  await second.locator('.lock-settings-close').click();
  console.log('AUTOLOCK41 SECOND TAB SETTING: '+secondTimeout+' (expected1)');
  assert.equal(secondTimeout,'1','Second tab must reflect updated auto-lock preference');
  await page.locator('.lock-settings-dialog').waitFor({state:'hidden'});
  let stopActivity=false,activityError;
  const activity=(async()=>{for(let i=0;i<90 && !stopActivity;i++){if(i%10===0)await page.mouse.move(i%20===0?100:150,100);await delay(1000);}})().catch(error=>{activityError=error;});
  try {
    await second.waitForFunction(()=>document.querySelector('.screen-lock-overlay')?.getAttribute('aria-hidden')==='false' && document.querySelector('.screen-lock-overlay')?.dataset.reason==='auto',null,{timeout:75000});
    await page.waitForFunction(()=>document.querySelector('.screen-lock-overlay')?.getAttribute('aria-hidden')==='false');
    assert.equal(await page.locator('.screen-lock-overlay').getAttribute('data-reason'),'manual','Active first tab receives second tab automatic lock event');
  } finally { stopActivity=true; await activity; }
  assert.ok(!activityError,'Real pointer activity completed safely');
  assert.ok(JSON.stringify(await sessionRows())===JSON.stringify(initialSessions),'Natural auto-lock preserves server session');
  console.log('AUTOLOCK41 NATURAL TIMER: PASS (inactive second tab auto; active first tab manual via storage)');
  const expired=await db.query("UPDATE auth_sessions SET expires_at=now()-interval '1 second' WHERE user_id=$1 AND token_hash=$2",[owner,tokenHash]);
  assert.equal(expired.rowCount,1,'Only exact synthetic session expired');
  const revoked=await context.request.get(base+'/api/session',{headers:{Authorization:'Bearer '+token}});
  assert.equal(revoked.status(),401);
  const unlock=page.waitForResponse(r=>r.url().endsWith('/api/session/unlock') && r.request().method()==='POST');
  await page.locator('#screen-lock-pin').fill(pin);
  assert.equal((await unlock).status(),401,'Correct PIN cannot restore expired server session');
  await page.waitForFunction(()=>Boolean(document.querySelector('#screen-lock-message')?.textContent));
  assert.equal(await page.locator('.screen-lock-overlay').getAttribute('aria-hidden'),'false');
  assert.equal(await second.locator('.screen-lock-overlay').getAttribute('aria-hidden'),'false');
  console.log('SESSION EXPIRY41: PASS (exact synthetic persisted expiry; old bearer401; correct PIN401; both remain locked)');
  console.log('AUTOLOCK/EXPIRY41 BROWSER PG QA: PASS');
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
