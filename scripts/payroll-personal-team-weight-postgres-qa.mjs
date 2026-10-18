import assert from 'node:assert/strict';
import { randomBytes, scryptSync } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { validateQaDatabaseUrl, assertQaDatabaseIdentity } from './postgres-qa-safety.mjs';

// Run only through local-full-pg-regression: it migrates and owns this fresh DB.
// This suite does not start a container, migrate a schema, or touch an app DB.
const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const target = validateQaDatabaseUrl(process.env.MIGRATIONS_PG_TEST_DATABASE_URL);
assert.match(process.env.LOCAL_FULL_PG_OWNED_DATABASE || '', /^orders_qa_[a-f0-9]{16}$/);
assert.equal(target.database, process.env.LOCAL_FULL_PG_OWNED_DATABASE);
await require('./local-full-pg-regression.cjs').verifyOwnerPinQaDatabaseUrl(target.url.href);
const lock = JSON.parse(await readFile(path.join(root, 'tmp/full-local-qa/pg-regression-runner.lock'), 'utf8'));
assert.equal(Number(lock.pid), process.ppid);
assert.match(lock.id || '', /^[0-9a-f-]{36}$/i);
assert.ok(process.env.PLAYWRIGHT_PACKAGE_PATH, 'PLAYWRIGHT_PACKAGE_PATH required');
const { Client } = require('pg');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE_PATH);
const db = new Client({ connectionString: target.url.href });
const artifacts = path.join(root, 'tmp/full-local-qa/payroll-personal-team-weight-qa', `${Date.now()}-${process.pid}`);
const evidence = { status: 'RUNNING', scope: 'owner configuration and scenario only; no official source or payout claim', assertions: [], screenshots: [], errors: [] };
const password = randomBytes(24).toString('hex');
const salt = randomBytes(16).toString('hex');
const passwordHash = `scrypt$${salt}$${scryptSync(password, salt, 64).toString('hex')}`;
const ack = { confirmed: true, policyCode: 'payroll-own-revenue-ceiling-v1' };
let child, browser, page;
const reveal = async locator => {
  // Open actual disclosure controls, outermost first. Do not force hidden clicks.
  const ancestors = locator.locator('xpath=ancestor::details');
  for (let i = 0; i < await ancestors.count(); i++) {
    const details = ancestors.nth(i);
    if (!await details.evaluate(node => node.open)) await details.locator(':scope > summary').click();
  }
};
const select = async (locator, value) => {
  await reveal(locator);
  if (await locator.getAttribute('data-custom-select') === '1') {
    const wrapper = locator.locator('xpath=..');
    await wrapper.locator('.custom-select-trigger').click();
    await wrapper.locator(`[role=option][data-value="${value}"]`).click();
  } else await locator.selectOption(value);
};
try {
  await mkdir(artifacts, { recursive: true });
  await db.connect();
  const identity = (await db.query('SELECT current_database() AS database,inet_server_addr() AS address,inet_server_port() AS port,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser')).rows[0];
  assertQaDatabaseIdentity(identity, target.database, Number(target.url.port), 'Payroll personal weight QA');
  const org = (await db.query("INSERT INTO organizations(name,slug,timezone) VALUES('Payroll weight QA',$1,'Asia/Yekaterinburg') RETURNING id", [`payroll-weight-${process.pid}`])).rows[0].id;
  await db.query("INSERT INTO organization_subscriptions(organization_id,status) VALUES($1,'trialing')", [org]);
  const venue = (await db.query("INSERT INTO venues(organization_id,name,timezone) VALUES($1,'Payroll weight QA','Asia/Yekaterinburg') RETURNING id", [org])).rows[0].id;
  const users = {};
  for (const [key, role, membership] of [['owner', 'owner', 'owner'], ['a', 'bartender', 'member'], ['b', 'bartender', 'member'], ['reader', 'manager', 'member']]) {
    const login = `payroll-weight-${process.pid}-${key}`;
    const id = (await db.query('INSERT INTO users(organization_id,venue_id,full_name,login,password_hash,role) VALUES($1,$2,$3,$4,$5,$6) RETURNING id', [org, venue, `Payroll weight ${key}`, login, passwordHash, role])).rows[0].id;
    await db.query("INSERT INTO organization_memberships(organization_id,user_id,membership_role,status) VALUES($1,$2,$3,'active')", [org, id, membership]);
    if (key === 'reader') await db.query("UPDATE users SET permission_scopes='[\"finance_read\"]'::jsonb WHERE id=$1", [id]);
    users[key] = { id, login };
  }
  const counts = async () => (await db.query('SELECT (SELECT count(*)::int FROM payroll_entries) AS entries,(SELECT count(*)::int FROM expenses) AS expenses,(SELECT count(*)::int FROM payroll_calculation_runs) AS runs')).rows[0];
  const before = await counts();
  child = spawn(process.execPath, ['server.js'], { cwd: root, windowsHide: true,
    env: { ...process.env, SKIP_LOCAL_ENV: 'true', DATABASE_URL: target.url.href, VENUE_ID: venue, HOST: '127.0.0.1', PORT: '0', NODE_ENV: 'test', AUTH_REQUIRED: 'true', COOKIE_SECURE: 'false', DEMO_MODE: 'false', API_RATE_LIMIT: '10000' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', () => {}); // Server diagnostics may contain connection credentials.
  const base = await new Promise((resolve, reject) => {
    let output = ''; const timer = setTimeout(() => reject(Error('Payroll QA server startup timeout')), 20000);
    child.stdout.on('data', chunk => { output += chunk; const match = output.match(/CRM running on http:\/\/localhost:(\d+)/); if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); } });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(Error(`Payroll QA server exited ${code}`)); });
  });
  assert.equal((await (await fetch(`${base}/api/health`)).json()).database, 'postgres');
  browser = await chromium.launch({ headless: true, ...((process.env.CHROME_PATH || process.env.PLAYWRIGHT_EXECUTABLE_PATH) ? { executablePath: process.env.CHROME_PATH || process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'ru-RU' });
  page.setDefaultTimeout(30000);
  page.on('pageerror', error => evidence.errors.push(error.message));
  const login = async (p, name) => {
    await p.goto(`${base}/login`);
    await p.locator('#login-username').fill(name); await p.locator('#login-password').fill(password);
    const pending = p.waitForResponse(r => new URL(r.url()).pathname === '/api/login' && r.request().method() === 'POST');
    await p.locator('#login-form button[type=submit]').click(); assert.equal((await pending).status(), 200);
    await p.waitForURL(url => url.pathname !== '/login');
  };
  await login(page, users.owner.login);
  const api = async (p, pathname, method = 'GET', body) => p.evaluate(async ({ pathname, method, body }) => {
    const response = await fetch(pathname, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  }, { pathname, method, body });
  const workspace = async key => page.locator(`.scheme-workspace-nav [data-scheme-workspace="${key}"]`).click();
  const payroll = async () => {
    await page.goto(`${base}/finance`, { waitUntil: 'networkidle' });
    await page.locator('.finance-view-navigation [data-finance-view="payroll"]').click();
    await reveal(page.locator('[data-scheme-new]'));
  };
  const card = parameter => page.locator('[data-grid-override]').filter({ has: page.locator(`[data-grid-override-path][value="${parameter}"]`) });
  const responseFor = (pathname, method) => page.waitForResponse(r => new URL(r.url()).pathname === pathname && r.request().method() === method);
  const fixture = policy => {
    const fund = { poolId: 'one', targetCents: 10000, baseRateBps: 1600, bonusRateBps: 4000, excessRatePolicy: 'replace_base', departments: ['bar'], distributionPolicy: policy };
    const configured = policy === 'configured_weights';
    return { mode: configured ? 'stable_percent' : 'team_fund', currency: 'RUB', effectiveFrom: '2026-11-01', effectiveTo: '2026-11-30', applyMilestones: false,
      roleParameters: { bartender: { perShiftCents: 0, ...(configured ? { stableRateBps: 1000 } : {}), teamFund: structuredClone(fund) },
        colleague: { perShiftCents: 0, ...(configured ? { mode: 'team_fund', teamWeight: 1 } : {}), teamFund: structuredClone(fund) } },
      roleAssignments: [{ employeeId: users.a.id, roleId: 'bartender', effectiveFrom: '2026-11-01', effectiveTo: '2026-11-30' }, { employeeId: users.b.id, roleId: 'colleague', effectiveFrom: '2026-11-01', effectiveTo: '2026-11-30' }], employeeOverrides: [], itemRules: [] };
  };
  const scenario = definition => ({ periodFrom: '2026-11-01', periodTo: '2026-11-02', employees: [users.a, users.b].map(u => ({ id: u.id })), roleAssignments: definition.roleAssignments,
    attendance: [users.a, users.b].map((u, i) => ({ id: `shift-${i}`, employeeId: u.id, date: '2026-11-02', approved: true, workedMinutes: i ? 180 : 60, plannedMinutes: 180 })),
    sales: [users.a, users.b].map((u, i) => ({ id: `line-${i}`, employeeId: u.id, date: '2026-11-02', department: 'bar', menuItemId: 'tea', turnoverCents: 15000, commissionBaseCents: 15000 })),
    coverage: { kind: 'month_to_date_complete', from: '2026-11-01', through: '2026-11-02', complete: true, watermark: 'synthetic-scenario' },
    attendanceCoverage: { kind: 'approved_attendance_complete', from: '2026-11-01', through: '2026-11-02', complete: true, watermark: 'synthetic-scenario' } });
  const capture = async name => { const file = `${name}.png`; await page.screenshot({ path: path.join(artifacts, file), fullPage: true }); evidence.screenshots.push(file); };
  const createdVersions = [];
  for (const policy of ['approved_minutes', 'configured_weights']) {
    const definition = fixture(policy), configured = policy === 'configured_weights';
    await payroll(); await page.locator('[data-scheme-new]').click();
    await page.locator('[data-scheme-name]').fill(`Personal weight ${policy}`);
    await reveal(page.locator('[data-scheme-definition]'));
    await page.locator('[data-scheme-definition]').fill(JSON.stringify(definition));
    await page.locator('[data-scheme-grid-rebuild]').click();
    for (const [parameter, value] of [...(configured ? [['mode', 'team_fund']] : []), ['teamWeight', '3']]) {
      await reveal(page.locator('[data-grid-add-override]')); await page.locator('[data-grid-add-override]').click();
      const fresh = page.locator('[data-grid-override="new"]').last();
      await fresh.locator('[data-grid-employee]').fill(users.a.id); await fresh.locator('[data-grid-override-path]').fill(parameter);
      await fresh.locator('[data-grid-override-value]').fill(value); await fresh.locator('[data-grid-override-from]').fill('2026-11-02'); await fresh.locator('[data-grid-override-to]').fill('2026-11-14');
    }
    await page.locator('[data-scheme-grid-apply]').click(); await page.locator('[data-scheme-risk-acknowledged]').check();
    const creation = responseFor('/api/payroll/schemes', 'POST'); await page.locator('[data-scheme-save]').click();
    const created = await creation; assert.equal(created.status(), 201, JSON.stringify(await created.json()));
    const versionId = (await created.json()).versions[0].versionId; createdVersions.push(versionId);
    const endpoint = `/api/payroll/versions/${versionId}`;
    const pgRows = async () => (await db.query('SELECT parameter_path AS path,override_mode AS mode,value_json AS value,effective_from::text AS "from",effective_to::text AS "to" FROM payroll_employee_overrides WHERE venue_id=$1 AND scheme_version_id=$2 ORDER BY parameter_path', [venue, versionId])).rows;
    const verify = async (weight, inherit = false) => {
      const read = await api(page, endpoint); assert.equal(read.status, 200);
      assert.deepEqual(read.body.roleParameters, definition.roleParameters, 'personal parameter must not change either role');
      assert.equal(Object.hasOwn(read.body.roleParameters.bartender, 'teamWeight'), false);
      const paths = configured ? [['mode', 'team_fund'], ['teamWeight', weight]] : [['teamWeight', weight]];
      const expected = paths.map(([parameter, value]) => ({ path: parameter, mode: inherit ? 'inherit' : 'override', value: inherit ? null : value, from: '2026-11-02', to: '2026-11-14' }));
      assert.deepEqual(await pgRows(), expected);
      for (const expectedRow of expected) {
        const row = read.body.employeeOverrides.find(r => r.path === expectedRow.path);
        assert.equal(row.employeeId, users.a.id); assert.equal(row.mode, expectedRow.mode);
        assert.equal(row.value, inherit ? undefined : expectedRow.value);
        assert.equal(row.effectiveFrom, expectedRow.from); assert.equal(row.effectiveTo, expectedRow.to);
      }
      return read.body;
    };
    const reopen = async () => {
      await payroll(); await workspace('list');
      const opening = responseFor(endpoint, 'GET'); await page.locator(`[data-scheme-open-version="${versionId}"]`).click(); assert.equal((await opening).status(), 200);
      await page.waitForFunction(() => document.querySelector('[data-scheme-definition]')?.value.includes('teamWeight') && !document.querySelector('[data-scheme-save]')?.disabled);
      await reveal(card('teamWeight').locator('[data-grid-override-value]'));
    };
    const save = async (status = 200) => {
      await page.locator('[data-scheme-grid-apply]').click(); await page.locator('[data-scheme-risk-acknowledged]').check();
      const pending = responseFor(endpoint, 'PUT'); await page.locator('[data-scheme-save]').click();
      const response = await pending; assert.equal(response.status(), status, JSON.stringify(await response.json()));
      return response.json();
    };
    const preview = async (expectedA, expectedB, expectedFund) => {
      await workspace('trial'); await reveal(page.locator('[data-scheme-preview-input]'));
      await page.locator('[data-scheme-preview-input]').fill(JSON.stringify(scenario(definition)));
      const pending = responseFor(`${endpoint}/preview`, 'POST'); await page.locator('[data-scheme-run-preview]').click();
      const response = await pending; assert.equal(response.status(), 200);
      const result = await response.json(); assert.equal(result.official, false); assert.equal(result.persistence, 'none'); assert.equal(result.result.status, 'ready');
      assert.equal(result.result.employees.find(e => e.employeeId === users.a.id).amountCents, expectedA);
      assert.equal(result.result.employees.find(e => e.employeeId === users.b.id).amountCents, expectedB);
      assert.equal(result.result.daily.find(d => d.date === '2026-11-02').teamFunds[0].fundCents, expectedFund);
      const amounts = [expectedA, expectedB].map(value => new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', minimumFractionDigits: 2 }).format(value / 100)).sort();
      await page.waitForFunction(expected => JSON.stringify([...document.querySelectorAll('[data-scheme-preview-result] > table:first-of-type tbody tr td:nth-child(8) strong, [data-scheme-preview-result] > div > table tbody tr td:nth-child(8) strong')].map(n => n.textContent).sort()) === JSON.stringify(expected), amounts);
      assert.match(await page.locator('[data-scheme-preview-result]').innerText(), /сценар/i);
    };
    await verify(3); await reopen(); assert.equal(await card('teamWeight').locator('[data-grid-override-value]').inputValue(), '3');
    assert.equal(await card('teamWeight').locator('[data-grid-override-from]').inputValue(), '2026-11-02');
    assert.equal(await card('teamWeight').locator('[data-grid-override-to]').inputValue(), '2026-11-14');
    await capture(`${policy}-personal-3`); await preview(configured ? 7200 : 2400, configured ? 2400 : 7200, 9600);
    await workspace('configuration'); await reveal(card('teamWeight').locator('[data-grid-override-value]'));
    await card('teamWeight').locator('[data-grid-override-value]').fill('0'); await save(); await verify(0); await reopen();
    assert.equal(await card('teamWeight').locator('[data-grid-override-value]').inputValue(), '0'); await preview(configured ? 0 : 2400, configured ? 9600 : 7200, 9600);
    await workspace('configuration'); await reveal(card('teamWeight').locator('[data-grid-inherit]'));
    const beforeRejectedRows = await pgRows();
    const revisions = async () => (await db.query('SELECT count(*)::int AS n FROM payroll_scheme_version_revisions WHERE venue_id=$1 AND scheme_version_id=$2', [venue, versionId])).rows[0].n;
    const beforeRejectedRevisions = await revisions();
    await card('teamWeight').locator('[data-grid-inherit]').click();
    if (configured) {
      assert.equal((await save(400)).error, 'invalid_personal_parameters');
      assert.deepEqual(await pgRows(), beforeRejectedRows); assert.equal(await revisions(), beforeRejectedRevisions);
      await page.waitForFunction(() => document.querySelector('[data-scheme-message]')?.textContent.includes('Личные параметры неполны'));
      await reveal(card('mode').locator('[data-grid-inherit]'));
      await card('mode').locator('[data-grid-inherit]').click();
    }
    await save(); await verify(undefined, true); await reopen();
    assert.equal(await card('teamWeight').locator('[data-grid-override-value]').inputValue(), ''); assert.equal(await card('teamWeight').locator('[data-grid-override-mode]').inputValue(), 'inherit');
    // With mode inherited, A's 15000 sale earns stable 10%=1500; B's independent
    // pool sees only B's 15000: 10000*16% + 5000*40%=3600, entirely to B.
    await preview(configured ? 1500 : 2400, configured ? 3600 : 7200, configured ? 3600 : 9600);
    await workspace('configuration');
    for (const [parameter, value] of [...(configured ? [['mode', 'team_fund']] : []), ['teamWeight', '3']]) {
      await select(card(parameter).locator('[data-grid-override-mode]'), 'override'); await card(parameter).locator('[data-grid-override-value]').fill(value);
    }
    await save(); await verify(3); await reopen(); await preview(configured ? 7200 : 2400, configured ? 2400 : 7200, 9600);
    await capture(`${policy}-scenario-restored`);
    await workspace('list'); const activating = responseFor(`${endpoint}/activate`, 'POST');
    await page.locator(`[data-scheme-activate="${versionId}"]`).click(); const activated = await activating; assert.equal(activated.status(), 200); assert.equal((await activated.json()).status, 'active');
    await reopen(); await page.waitForFunction(() => document.querySelector('[data-scheme-grid-fieldset]')?.disabled === true);
    assert.equal(await card('teamWeight').locator('[data-grid-override-value]').isDisabled(), true); assert.equal(await card('teamWeight').locator('[data-grid-inherit]').isDisabled(), true);
    assert.equal(await page.locator('[data-scheme-definition]').evaluate(node => node.readOnly), true); assert.equal(await page.locator('[data-scheme-save]').isHidden(), true);
    const final = await verify(3); const immutableRows = await pgRows();
    const update = await api(page, endpoint, 'PUT', { definition: { ...definition, employeeOverrides: final.employeeOverrides }, payoutRiskAcknowledgement: ack });
    assert.equal(update.status, 409); assert.deepEqual(await pgRows(), immutableRows);
    evidence.assertions.push(`${policy}: real UI create, typed personal weight without role leaf, PG/read/reload, 3/0/inherit/restore, independent scenario amounts, active immutable; ${configured ? 'incomplete inherit rolls back rows and revisions' : 'minutes unaffected by configured personal weight'}`);
  }
  const reader = await browser.newPage(); await login(reader, users.reader.login);
  for (const id of createdVersions) {
    assert.equal((await api(reader, `/api/payroll/versions/${id}`)).status, 403);
    assert.equal((await api(reader, `/api/payroll/versions/${id}`, 'PUT', { definition: fixture('approved_minutes'), payoutRiskAcknowledgement: ack })).status, 403);
  }
  await reader.close();
  assert.deepEqual(await counts(), before, 'configuration and scenario create no payroll entry, expense or run');
  assert.deepEqual(evidence.errors.filter(e => !e.includes('ViewTransition opt-in disabled')), []);
  evidence.assertions.push('finance_read member cannot read/write owner schemes; all payroll entries/expenses/runs unchanged');
  evidence.status = 'PASS'; console.log(`PAYROLL PERSONAL TEAM WEIGHT POSTGRES QA: PASS ${artifacts}`);
} catch (error) {
  evidence.status = 'FAIL'; evidence.failure = { name: error.name, message: error.message };
  if (page && !page.isClosed()) {
    evidence.failureUi = await page.locator('[data-scheme-message],[data-scheme-grid-message]').allTextContents().catch(() => []);
    await page.screenshot({ path: path.join(artifacts, 'failure.png'), fullPage: true }).catch(() => {});
  }
  throw error;
} finally {
  // Runner owns DB teardown; always close child processes before it drops the DB.
  try { await mkdir(artifacts, { recursive: true }); await writeFile(path.join(artifacts, 'evidence.json'), JSON.stringify(evidence, null, 2)); }
  finally {
    try { await browser?.close(); }
    finally {
      try { if (child && child.exitCode === null) { const ended = once(child, 'exit'); child.kill(); await ended; } }
      finally { await db.end(); }
    }
  }
}
