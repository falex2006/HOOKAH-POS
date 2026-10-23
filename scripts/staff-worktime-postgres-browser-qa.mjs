import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { assertQaDatabaseIdentity, validateQaDatabaseUrl } from './postgres-qa-safety.mjs';
import { attendanceApprovalJourney } from './staff-attendance-approval-browser-journey.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const target = validateQaDatabaseUrl(process.env.MIGRATIONS_PG_TEST_DATABASE_URL, 'Worktime UI QA database');
assert.match(target.database, /^orders_qa_[a-f0-9]{16}$/i);
assert.equal(target.database, process.env.LOCAL_FULL_PG_OWNED_DATABASE, 'requires a runner-owned disposable database');
assert.ok(process.env.PLAYWRIGHT_PACKAGE_PATH); assert.ok(process.env.CHROME_PATH);
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_PACKAGE_PATH);
const db = new pg.Client({ connectionString: target.url.href, connectionTimeoutMillis: 5000 });
const ids = Object.fromEntries(['org', 'venue', 'owner', 'manager', 'foreignOrg', 'foreignVenue', 'foreignOwner'].map(key => [key, randomUUID()]));
const marker = randomBytes(6).toString('hex'), password = randomBytes(24).toString('hex');
const salt = randomBytes(16).toString('hex'), hash = `scrypt$${salt}$${scryptSync(password, salt, 64).toString('hex')}`;
const logins = Object.fromEntries(['owner', 'manager', 'foreignOwner'].map(key => [key, `worktime-${key}-${marker}`]));
const artifactRoot = path.join(root, 'tmp', 'staff-worktime-postgres');
const artifacts = path.join(artifactRoot, `run-${Date.now()}-${randomBytes(3).toString('hex')}`); fs.mkdirSync(artifacts, { recursive: true });
const testedHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim();
fs.writeFileSync(path.join(artifactRoot, 'latest-run.json'), JSON.stringify({ testedHead, artifacts, note: 'Run pointer only; PASS requires this directory report plus terminal and runner cleanup' }, null, 2));
const assetPaths = ['staff-schedule-ui.js', 'staff-schedule-ui.css', 'staff-attendance-ui.js', 'staff-attendance-ui.css', 'app.js', 'portal.js', 'style.css'];
const assetHashes = () => Object.fromEntries(assetPaths.flatMap(file => [file, `dist/${file}`]).map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]));
const testedAssets = assetHashes();
fs.writeFileSync(path.join(artifacts, 'tested-assets-before.json'), JSON.stringify({ testedHead, testedAssets }, null, 2));
let server, serverClosed, browser, connected = false, checks = 0;
const errors = [], check = (value, description) => { assert.ok(value, description); checks++; };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  await db.connect(); connected = true;
  const identity = (await db.query('SELECT current_database() AS database,inet_server_addr()::text AS address,inet_server_port() AS port,COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname=current_user),false) AS superuser')).rows[0];
  assertQaDatabaseIdentity(identity, target.database, Number(target.url.port || 5432), 'worktime UI PostgreSQL QA');
  await db.query('BEGIN');
  try {
    await db.query("INSERT INTO organizations(id,name,slug,timezone) VALUES($1,'Worktime QA',$2,'Asia/Yekaterinburg'),($3,'Foreign Worktime QA',$4,'Asia/Yekaterinburg')", [ids.org, `worktime-${marker}`, ids.foreignOrg, `worktime-foreign-${marker}`]);
    await db.query("INSERT INTO organization_subscriptions(organization_id,status) VALUES($1,'trialing'),($2,'trialing')", [ids.org, ids.foreignOrg]);
    await db.query("INSERT INTO venues(id,organization_id,name,timezone) VALUES($1,$2,'Worktime QA venue','Asia/Yekaterinburg'),($3,$4,'Foreign Worktime QA venue','Asia/Yekaterinburg')", [ids.venue, ids.org, ids.foreignVenue, ids.foreignOrg]);
    for (const key of ['owner', 'manager', 'foreignOwner']) {
      const foreign = key === 'foreignOwner', org = foreign ? ids.foreignOrg : ids.org, venue = foreign ? ids.foreignVenue : ids.venue, role = key === 'manager' ? 'manager' : 'owner';
      await db.query('INSERT INTO users(id,organization_id,venue_id,full_name,login,password_hash,role,permission_scopes) VALUES($1,$2,$3,$4,$5,$6,$7,\'[]\'::jsonb)', [ids[key], org, venue, `QA ${key}`, logins[key], hash, role]);
      await db.query("INSERT INTO organization_memberships(organization_id,user_id,membership_role,status) VALUES($1,$2,$3,'active')", [org, ids[key], role === 'owner' ? 'owner' : 'member']);
    }
    await db.query('COMMIT');
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  let output = '', base = '';
  server = spawn(process.execPath, ['server.js'], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', DATABASE_URL: target.url.href, VENUE_ID: ids.venue, AUTH_REQUIRED: 'true', DEMO_MODE: 'false', NODE_ENV: 'test', API_RATE_LIMIT: '10000' } });
  serverClosed = new Promise(resolve => server.once('close', resolve));
  server.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; }); server.stderr.setEncoding('utf8').on('data', chunk => { output += chunk; });
  const deadline = Date.now() + 20000;
  while (!base && Date.now() < deadline) { const match = output.match(/CRM running on http:\/\/localhost:(\d+)/); if (match) base = `http://127.0.0.1:${match[1]}`; else if (server.exitCode !== null) throw Error('Owned worktime QA server exited during startup'); else await delay(50); }
  assert.ok(base, 'owned worktime QA server starts');
  check((await (await fetch(base + '/api/health')).json()).database === 'postgres', 'real PostgreSQL server');
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH });
  for (const width of [390, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, locale: 'ru-RU', reducedMotion: 'reduce' });
    const page = await context.newPage(); page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
    await page.goto(base + '/login'); await page.locator('#login-username').fill(logins.owner); await page.locator('#login-password').fill(password);
    await page.locator('#login-form button[type=submit]').click(); await page.waitForURL(url => url.pathname !== '/login');
    await page.goto(base + '/admin#staff-schedule'); await page.locator('[data-create]:enabled').waitFor();
    let failList = true;
    const failSchedule = async route => {
      const url = new URL(route.request().url());
      if (failList && url.pathname === '/api/staff/schedule') return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'schedule_unavailable' }) });
      return route.continue();
    };
    await page.route('**/api/staff/schedule?*', failSchedule); await page.locator('[data-next]').click(); await page.locator('[data-schedule-load-retry]').waitFor();
    check(await page.locator('[data-create]').isDisabled(), 'failed list blocks create');
    check(await page.locator('[data-grid]').innerText() === '', 'failed list clears real rows');
    await page.screenshot({ path: path.join(artifacts, `schedule-error-${width}.png`) });
    failList = false; await page.locator('[data-schedule-load-retry]').click(); await page.locator('[data-create]:enabled').waitFor();
    await page.unroute('**/api/staff/schedule?*', failSchedule);
    await page.locator('[data-create]').click(); const dialog = page.locator('dialog[open]'); await dialog.waitFor();
    await dialog.locator('[name=userId]').selectOption(ids.manager);
    await dialog.locator('[name=kind]').selectOption('day_off');
    let day = await dialog.locator('[name=workDate]').inputValue();
    if (width === 1440) { day = new Date(Date.parse(day + 'T12:00:00Z') + 86400000).toISOString().slice(0, 10); await dialog.locator('[name=workDate]').fill(day); }
    const beforeCount = (await db.query('SELECT count(*)::int count FROM staff_schedules WHERE venue_id=$1', [ids.venue])).rows[0].count;
    await dialog.locator('[data-submit]').click(); await dialog.waitFor({ state: 'detached' });
    const saved = (await db.query('SELECT id,user_id,kind FROM staff_schedules WHERE venue_id=$1 AND user_id=$2 AND work_date=$3::date AND kind=\'day_off\' AND status=\'planned\'', [ids.venue, ids.manager, day])).rows;
    check(saved.length === 1, 'schedule UI save persisted one selected employee/day/type');
    check((await db.query('SELECT count(*)::int count FROM staff_schedules WHERE venue_id=$1', [ids.venue])).rows[0].count === beforeCount + 1, 'one save creates exactly one record');
    await page.reload(); await page.locator('[data-next]:enabled').waitFor(); await page.locator('[data-next]').click();
    await page.locator(`[data-entry="${saved[0].id}"]:visible`).first().waitFor();
    check(true, 'saved schedule record reappears after page reload');
    await page.screenshot({ path: path.join(artifacts, `schedule-reloaded-${width}.png`) });
    await page.goto(base + '/admin#staff-attendance'); await page.locator('[data-attendance-tab="settings"]').waitFor(); await page.locator('[data-attendance-tab="settings"]').click();
    const minutes = width === 390 ? 15 : 30;
    await page.locator('[data-attendance-policy] [name=preparationMinutes]').fill(String(minutes));
    await page.locator('[data-attendance-policy] button[type=submit]').click();
    await page.locator('[data-attendance-feedback]').filter({ hasText: 'Правила выхода сохранены' }).waitFor();
    check((await db.query('SELECT preparation_minutes FROM staff_attendance_policies WHERE venue_id=$1', [ids.venue])).rows[0]?.preparation_minutes === minutes, 'attendance UI policy persisted');
    await page.reload(); await page.locator('[data-attendance-tab="settings"]').waitFor(); await page.locator('[data-attendance-tab="settings"]').click();
    check(await page.locator('[data-attendance-policy] [name=preparationMinutes]').inputValue() === String(minutes), 'policy value read back after page reload');
    await page.screenshot({ path: path.join(artifacts, `attendance-reloaded-${width}.png`) });
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'actual portal fits viewport');
    await context.close();
  }
  await attendanceApprovalJourney({ browser, db, base, ids, logins, password, artifacts, check, errors });
  // Real server authorization/tenant reads, separate from UI fault injection.
  const request = await browser.newContext();
  for (const key of ['manager', 'foreignOwner']) {
    const login = await request.request.post(base + '/api/login', { data: { username: logins[key], password } });
    check(login.status() === 200, 'legitimate synthetic account login');
    const session = await login.json(), headers = { Authorization: `Bearer ${session.token}` };
    if (key === 'manager') {
      const denied = await request.request.get(base + '/api/staff/attendance/management', { headers });
      check(denied.status() === 403, 'manager without attendance delegation is denied by server');
    } else {
      const foreign = await request.request.get(base + '/api/staff/attendance/management', { headers }); check(foreign.status() === 200, 'foreign owner sees own management');
      check((await foreign.json()).settings?.preparationMinutes === 0, 'foreign tenant cannot read saved policy');
    }
  }
  await request.close(); check(errors.length === 0, 'no browser JS errors');
  assert.deepEqual(assetHashes(), testedAssets, 'tested product assets stay unchanged throughout the suite');
  fs.writeFileSync(path.join(artifacts, 'report.json'), JSON.stringify({ checks, widths: [390, 1440], baseCommit: '17d93081', testedHead, testedAssets, scope: 'actual owner schedule/policy and manager attendance request/approval/start/end UI/API/DB/reload; manager management denial and foreign tenant policy API; injected GET503 and initial request POST503, held real approval POST', errors }, null, 2));
  console.log(`WORKTIME POSTGRES BROWSER QA: PASS (${checks} assertions; actual owner UI/API/DB/reload3901440; manager denial; tenant policy isolation)`);
} finally {
  try { await browser?.close(); }
  finally {
    try {
      if (server && server.exitCode === null && server.signalCode === null) {
        if (process.platform === 'win32') spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `taskkill /PID ${server.pid} /T /F`], { windowsHide: true, stdio: 'ignore' });
        else server.kill('SIGTERM');
        assert.equal(await Promise.race([serverClosed.then(() => true), delay(5000).then(() => false)]), true, 'owned QA server stopped');
      }
    } finally { if (connected) await db.end(); }
  }
  // The runner drops the entire owned random QA DB even if this suite fails.
}
