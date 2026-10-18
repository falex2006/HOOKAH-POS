import assert from 'node:assert/strict';
import { randomBytes, scryptSync } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { validateQaDatabaseUrl, assertQaDatabaseIdentity } from './postgres-qa-safety.mjs';
import { runDepartmentBrowserQa } from './payroll-personal-department-browser-helper.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const target = validateQaDatabaseUrl(process.env.MIGRATIONS_PG_TEST_DATABASE_URL);
assert.match(process.env.LOCAL_FULL_PG_OWNED_DATABASE || '', /^orders_qa_[a-f0-9]{16}$/);
assert.equal(target.database, process.env.LOCAL_FULL_PG_OWNED_DATABASE);
await require('./local-full-pg-regression.cjs').verifyOwnerPinQaDatabaseUrl(target.url.href);
const lock = JSON.parse(await readFile(path.join(root, 'tmp/full-local-qa/pg-regression-runner.lock'), 'utf8'));
assert.equal(Number(lock.pid), process.ppid);
assert.match(lock.id || '', /^[0-9a-f-]{36}$/i);
assert.ok(process.env.PLAYWRIGHT_PACKAGE_PATH, 'PLAYWRIGHT_PACKAGE_PATH required for browser helper');
assert.ok(process.env.CHROME_PATH || process.env.PLAYWRIGHT_EXECUTABLE_PATH, 'Configured browser executable required');
const { Client } = require('pg');
const { makeService } = require('../payroll-scheme-service.js');
const db = new Client({ connectionString: target.url.href });
const migration = await readFile(new URL('../migrations/143_payroll_personal_departments.sql', import.meta.url), 'utf8');
const artifacts = path.join(root, 'tmp/full-local-qa/payroll-personal-department-qa', `${Date.now()}-${process.pid}`);
const evidence = { status: 'RUNNING', scope: 'owner configuration, schema guards and scenario; no official source or payout claim', assertions: [] };
const password = randomBytes(24).toString('hex'), salt = randomBytes(16).toString('hex');
const passwordHash = `scrypt$${salt}$${scryptSync(password, salt, 64).toString('hex')}`;
const ack = { confirmed: true, policyCode: 'payroll-own-revenue-ceiling-v1' };
let child;
let savepointNo = 0;
try {
  await mkdir(artifacts, { recursive: true });
  await db.connect();
  const identity = (await db.query('SELECT current_database() AS database,inet_server_addr() AS address,inet_server_port() AS port,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser')).rows[0];
  assertQaDatabaseIdentity(identity, target.database, Number(target.url.port), 'Payroll personal department QA');
  const organization = async suffix => {
    const org = (await db.query("INSERT INTO organizations(name,slug,timezone) VALUES('Payroll department QA',$1,'Asia/Yekaterinburg') RETURNING id", [`payroll-department-${process.pid}-${suffix}`])).rows[0].id;
    await db.query("INSERT INTO organization_subscriptions(organization_id,status) VALUES($1,'trialing')", [org]);
    const venueId = (await db.query("INSERT INTO venues(organization_id,name,timezone) VALUES($1,'Payroll department QA','Asia/Yekaterinburg') RETURNING id", [org])).rows[0].id;
    return { org, venue: venueId };
  };
  const local = await organization('local'), foreign = await organization('foreign'), venue = local.venue;
  const users = {};
  for (const [key, role, membership, tenant] of [['owner', 'owner', 'owner', local], ['a', 'bartender', 'member', local], ['b', 'bartender', 'member', local], ['reader', 'manager', 'member', local], ['foreignOwner', 'owner', 'owner', foreign]]) {
    const login = `payroll-department-${process.pid}-${key.toLowerCase()}`;
    const id = (await db.query('INSERT INTO users(organization_id,venue_id,full_name,login,password_hash,role) VALUES($1,$2,$3,$4,$5,$6) RETURNING id', [tenant.org, tenant.venue, `Payroll department ${key}`, login, passwordHash, role])).rows[0].id;
    await db.query("INSERT INTO organization_memberships(organization_id,user_id,membership_role,status) VALUES($1,$2,$3,'active')", [tenant.org, id, membership]);
    if (key === 'reader') await db.query("UPDATE users SET permission_scopes='[\"finance_read\"]'::jsonb WHERE id=$1", [id]);
    users[key] = { id, login };
  }
  const protectedCounts = async () => (await db.query('SELECT (SELECT count(*)::int FROM payroll_entries) AS entries,(SELECT count(*)::int FROM expenses) AS expenses,(SELECT count(*)::int FROM payroll_calculation_runs) AS runs')).rows[0];
  const beforeProtected = await protectedCounts();
  const configState = async () => {
    const result = {};
    for (const table of ['payroll_schemes', 'payroll_scheme_versions', 'payroll_role_assignments', 'payroll_employee_overrides', 'payroll_item_commission_rules', 'payroll_scheme_version_revisions']) result[table] = (await db.query(`SELECT * FROM ${table} ORDER BY id`)).rows;
    return result;
  };
  const constraints = async () => (await db.query("SELECT conname,contype,convalidated,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid=to_regclass('payroll_employee_overrides') ORDER BY conname")).rows;
  const baseDefinition = () => ({ mode: 'stable_percent', currency: 'RUB', effectiveFrom: '2026-11-01', effectiveTo: '2026-11-30', applyMilestones: false,
    roleParameters: { bartender: { perShiftCents: 0, stableRateBps: 5000, department: 'bar', cap: { rateBps: 3000, basis: 'employee_department_day' } } },
    roleAssignments: [{ employeeId: users.a.id, roleId: 'bartender', effectiveFrom: '2026-11-01', effectiveTo: '2026-11-30' }], employeeOverrides: [], itemRules: [] });
  const override = (parameter, value, mode = 'override') => ({ employeeId: users.a.id, path: parameter, mode, ...(mode === 'inherit' ? {} : { value }), effectiveFrom: '2026-11-02', effectiveTo: '2026-11-14' });
  const scenario = (hookahKey = 'hookah') => ({ periodFrom: '2026-11-01', periodTo: '2026-11-02', employees: [{ id: users.a.id }], attendance: [],
    sales: [['bar', 10000], [hookahKey, 30000]].map(([department, amount], index) => ({ id: `department-line-${index}`, employeeId: users.a.id, department, date: '2026-11-02', turnoverCents: amount, commissionBaseCents: amount })),
    coverage: { kind: 'month_to_date_complete', from: '2026-11-01', through: '2026-11-02', complete: true, watermark: 'scenario-only' },
    attendanceCoverage: { kind: 'approved_attendance_complete', from: '2026-11-01', through: '2026-11-02', complete: true, watermark: 'scenario-only' } });

  child = spawn(process.execPath, ['server.js'], { cwd: root, windowsHide: true,
    env: { ...process.env, SKIP_LOCAL_ENV: 'true', DATABASE_URL: target.url.href, VENUE_ID: venue, HOST: '127.0.0.1', PORT: '0', NODE_ENV: 'test', AUTH_REQUIRED: 'true', COOKIE_SECURE: 'false', DEMO_MODE: 'false', API_RATE_LIMIT: '10000' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', () => {}); // Do not disclose server connection configuration.
  const base = await new Promise((resolve, reject) => {
    let output = ''; const timer = setTimeout(() => reject(Error('Payroll department QA server startup timeout')), 20000);
    child.stdout.on('data', chunk => { output += chunk; const match = output.match(/CRM running on http:\/\/localhost:(\d+)/); if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); } });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(Error(`Payroll department QA server exited ${code}`)); });
  });
  assert.equal((await (await fetch(`${base}/api/health`)).json()).database, 'postgres');
  const cookies = {};
  const api = async (pathname, method = 'GET', body, who = 'owner') => {
    const response = await fetch(`${base}${pathname}`, { method, headers: { Origin: base, 'Sec-Fetch-Site': 'same-origin', ...(cookies[who] ? { Cookie: cookies[who] } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json(), response };
  };
  for (const who of ['owner', 'reader', 'foreignOwner']) {
    const login = await api('/api/login', 'POST', { username: users[who].login, password }, who);
    assert.equal(login.status, 200, `synthetic ${who} authentication`);
    cookies[who] = login.response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    assert.ok(cookies[who], 'authenticated session cookie required');
  }
  const create = async (name, definition) => {
    const result = await api('/api/payroll/schemes', 'POST', { name, definition, payoutRiskAcknowledgement: ack });
    assert.equal(result.status, 201, JSON.stringify(result.body)); return result.body;
  };
  const baseline = await create('Legacy role departments', baseDefinition());
  const versionId = baseline.versions[0].versionId, endpoint = `/api/payroll/versions/${versionId}`;
  const beforeReplay = await configState(), catalogBeforeReplay = await constraints();
  await db.query('BEGIN');
  try { await db.query(migration); await db.query(migration); await db.query('COMMIT'); }
  catch (error) { await db.query('ROLLBACK'); throw error; }
  assert.deepEqual(await configState(), beforeReplay, '143 replay does not rewrite any config/history row');
  assert.deepEqual(await constraints(), catalogBeforeReplay, '143 replay preserves the complete CHECK/FK/unique catalog');
  evidence.assertions.push('143 actual PostgreSQL replay twice preserves config/history rows and complete constraint catalog');

  const save = async (definition, status = 200) => {
    const result = await api(endpoint, 'PUT', { definition, payoutRiskAcknowledgement: ack });
    assert.equal(result.status, status, JSON.stringify(result.body)); return result.body;
  };
  const read = async () => { const result = await api(endpoint); assert.equal(result.status, 200); return result.body; };
  const verify = async definition => {
    const result = await read(); assert.deepEqual(result.roleParameters, definition.roleParameters);
    assert.equal(result.employeeOverrides.length, definition.employeeOverrides.length);
    for (const expected of definition.employeeOverrides) {
      const row = result.employeeOverrides.find(value => value.path === expected.path);
      for (const field of ['employeeId', 'path', 'mode', 'effectiveFrom', 'effectiveTo']) assert.equal(row[field], expected[field]);
      assert.equal(row.value, expected.mode === 'inherit' ? undefined : expected.value);
      const persisted = (await db.query('SELECT override_mode AS mode,value_json AS value,effective_from::text AS "from",effective_to::text AS "to" FROM payroll_employee_overrides WHERE venue_id=$1 AND scheme_version_id=$2 AND employee_id=$3 AND parameter_path=$4', [venue, versionId, users.a.id, expected.path])).rows;
      assert.deepEqual(persisted, [{ mode: expected.mode, value: expected.mode === 'inherit' ? null : expected.value, from: expected.effectiveFrom, to: expected.effectiveTo }]);
    }
    return result;
  };
  const preview = async (expected, hookahKey = 'hookah') => {
    const response = await api(`${endpoint}/preview`, 'POST', { previewInput: scenario(hookahKey) });
    assert.equal(response.status, 200, JSON.stringify(response.body)); const body = response.body;
    assert.equal(body.official, false); assert.equal(body.persistence, 'none'); assert.equal(body.result.status, 'ready');
    const row = body.result.employees.find(employee => employee.employeeId === users.a.id);
    // 10000 bar + 30000 hookah at 50%=20000 commission. Only cap basis changes.
    assert.equal(row.commissionCents, 20000); assert.equal(row.amountCents, expected);
    assert.equal(row.capReductionCents, 20000 - expected); assert.equal(row.personalRevenueCents, 40000);
  };
  await preview(3000);
  for (const parameter of ['department', 'cap.department']) {
    const definition = baseDefinition(); definition.employeeOverrides = [override(parameter, 'hookah')];
    await save(definition); await verify(definition); await preview(9000);
    definition.employeeOverrides = [override(parameter, undefined, 'inherit')];
    await save(definition); await verify(definition); await preview(3000);
  }
  const priority = baseDefinition(); priority.employeeOverrides = [override('department', 'hookah'), override('cap.department', 'bar')];
  await save(priority); await verify(priority); await preview(3000);
  priority.employeeOverrides[1] = override('cap.department', undefined, 'inherit');
  await save(priority); await verify(priority); await preview(9000);
  priority.roleParameters.bartender.cap.department = 'bar';
  await save(priority); await verify(priority); await preview(3000);
  const unicode = '😀'.repeat(80), unicodeDefinition = baseDefinition();
  unicodeDefinition.employeeOverrides = [override('cap.department', unicode)];
  await save(unicodeDefinition); await verify(unicodeDefinition); await preview(9000, unicode);
  assert.equal((await db.query("SELECT char_length(value_json #>> '{}') AS n FROM payroll_employee_overrides WHERE scheme_version_id=$1 AND parameter_path='cap.department'", [versionId])).rows[0].n, 80);
  evidence.assertions.push('actual owner HTTP save/read/direct PG/preview: both personal keys 3000→9000→inherit3000, specific-key priority, exact 80 supplementary Unicode code points');

  const accepted = await configState();
  for (const parameter of ['department', 'cap.department']) for (const value of ['', ' bar', 'bar\u00a0', 'bar\u0001x', '\ufeffbar', 1, null, ['bar'], { key: 'bar' }, '😀'.repeat(81), '\ud800']) {
    const invalid = baseDefinition(); invalid.employeeOverrides = [override(parameter, value)];
    await save(invalid, 400); assert.deepEqual(await configState(), accepted, 'invalid personal key leaves all revisions/config rows unchanged');
  }
  const expiry = baseDefinition(); delete expiry.roleParameters.bartender.cap; delete expiry.roleParameters.bartender.department;
  expiry.employeeOverrides = [override('cap.rateBps', 3000), override('cap.basis', 'employee_department_day'), override('department', 'hookah')];
  expiry.employeeOverrides[2].effectiveTo = '2026-11-13';
  await save(expiry, 400); assert.deepEqual(await configState(), accepted, 'full-window missing key outside preview is atomic');
  const escapedTenant = baseDefinition(); escapedTenant.employeeOverrides = [{ ...override('department', 'hookah'), employeeId: users.foreignOwner.id }];
  await save(escapedTenant, 400); assert.deepEqual(await configState(), accepted, 'foreign employee cannot enter owner venue scheme');
  evidence.assertions.push('invalid typed/Unicode keys and full-window expiry reject with unchanged rows/revisions; foreign employee FK cannot cross tenant');

  // Exercise the real table CHECKs through isolated savepoints. Every probe is
  // rolled back, including accepted values; no synthetic personal rows survive.
  await db.query('BEGIN');
  try {
    const insertProbe = async (parameter, value, mode = 'override', sqlNull = false, expectedCode = null) => {
      const point = `department_probe_${++savepointNo}`; await db.query(`SAVEPOINT ${point}`);
      let caught;
      try {
        await db.query(`INSERT INTO payroll_employee_overrides
          (venue_id,scheme_version_id,employee_id,parameter_path,override_mode,value_json,effective_from,effective_to,created_by,created_by_name)
          VALUES($1,$2,$3,$4,$5,$6::jsonb,'2026-11-20','2026-11-21',$7,'Department QA owner')`,
        [venue, versionId, users.a.id, parameter, mode, sqlNull ? null : JSON.stringify(value), users.owner.id]);
      } catch (error) { caught = error; }
      finally { await db.query(`ROLLBACK TO SAVEPOINT ${point}`); await db.query(`RELEASE SAVEPOINT ${point}`); }
      if (expectedCode) assert.ok([].concat(expectedCode).includes(caught?.code), `${parameter}/${JSON.stringify(value)} expected ${expectedCode}, got ${caught?.code || 'accepted'}`);
      else if (caught) throw caught;
    };
    for (const parameter of ['department', 'cap.department']) {
      for (const value of ['bar', 'Bar', 'цех кальянов', unicode, 'x'.repeat(80)]) await insertProbe(parameter, value);
      await insertProbe(parameter, undefined, 'inherit', true);
      await insertProbe(parameter, 'bar', 'inherit', false, '23514');
      await insertProbe(parameter, undefined, 'override', true, '23514');
      for (const value of ['', ' bar', 'bar ', '\u00a0bar', 'bar\ufeff', 'bar\u0001x', 'ba\u007fr', 'ba\u0085r', false, 1, null, ['bar'], { key: 'bar' }, 'x'.repeat(81), '😀'.repeat(81)]) await insertProbe(parameter, value, 'override', false, '23514');
      // PostgreSQL versions classify rejected JSON Unicode as invalid_text_representation,
      // untranslatable_character or character_not_in_repertoire. None reaches CHECK evaluation.
      for (const value of ['ba\u0000r', '\ud800']) await insertProbe(parameter, value, 'override', false, ['22P02', '22P05', '22021']);
    }
    const oldPaths = { mode: 'stable_percent', applyMilestones: false, milestoneEligibility: 'all_active', perShiftCents: 0, stableRateBps: 1000, targetCents: 0, baseRateBps: 0, bonusRateBps: 0, excessRatePolicy: 'replace_base', teamWeight: 0, lossPolicy: 'offset_daily_losses', itemRuleBasis: 'net_revenue', 'bracketRatesBps.0': 0, 'cap.rateBps': 0, 'cap.basis': 'venue_day', 'milestoneBonusesCents.40000000': 0 };
    for (const [parameter, value] of Object.entries(oldPaths)) await insertProbe(parameter, value);
    for (const parameter of ['department.name', 'cap.department.name', 'teamFund.departments', 'department\n']) await insertProbe(parameter, 'bar', 'override', false, '23514');
  } finally { await db.query('ROLLBACK'); }
  assert.deepEqual(await configState(), accepted);
  evidence.assertions.push('real table probes: both new typed CHECKs, inherit NULL-only, 80-codepoint boundary, NBSP/BOM/control rejection, JSONB invalid Unicode, all 089 paths preserved; all probes rolled back');

  // Missing-capability testing uses the real service and a real PG transaction.
  // Only transaction boundaries are adapted to savepoints, so service rollback
  // remains observable without committing the temporary capability removal.
  const principal = { venueId: venue, userId: users.owner.id };
  const oldGateDefinitions = ['department', 'cap.department'].flatMap(parameter => ['override', 'inherit'].map(mode => {
    const definition = baseDefinition(); definition.employeeOverrides = [override(parameter, 'hookah', mode)]; return definition;
  }));
  const activationFixtures = [];
  for (const [index, definition] of oldGateDefinitions.entries()) activationFixtures.push(await create(`Capability activation ${index}`, definition));
  const beforeCapability = await configState(), beforeCapabilityCatalog = await constraints();
  await db.query('BEGIN');
  try {
    await db.query('ALTER TABLE payroll_employee_overrides DROP CONSTRAINT payroll_employee_overrides_department_value_check');
    let activeSavepoint = null;
    const savepointClient = {
      async query(text, values) {
        const command = typeof text === 'string' ? text.trim() : '';
        if (command.startsWith('BEGIN')) { assert.equal(activeSavepoint, null); activeSavepoint = `department_service_${++savepointNo}`; return db.query(`SAVEPOINT ${activeSavepoint}`); }
        if (command === 'COMMIT') { assert.ok(activeSavepoint); const point = activeSavepoint; activeSavepoint = null; return db.query(`RELEASE SAVEPOINT ${point}`); }
        if (command === 'ROLLBACK') { assert.ok(activeSavepoint); const point = activeSavepoint; activeSavepoint = null; await db.query(`ROLLBACK TO SAVEPOINT ${point}`); return db.query(`RELEASE SAVEPOINT ${point}`); }
        return db.query(text, values);
      },
      release() { assert.equal(activeSavepoint, null, 'service releases after commit/rollback'); }
    };
    const service = makeService({ query: (...args) => db.query(...args), connect: async () => savepointClient });
    const rejectsGate = async action => {
      const before = await configState();
      await assert.rejects(action, error => error?.status === 409 && error?.code === 'payroll_personal_department_schema_required');
      assert.equal(activeSavepoint, null); assert.deepEqual(await configState(), before, 'missing capability is atomic');
    };
    for (const [index, definition] of oldGateDefinitions.entries()) {
      await rejectsGate(() => service.createScheme(principal, { name: `Old schema refused ${index}`, definition, payoutRiskAcknowledgement: ack }));
      await rejectsGate(() => service.replaceDraftVersion(principal, versionId, definition, ack));
      await rejectsGate(() => service.createVersion(principal, baseline.id, definition, ack));
      await rejectsGate(() => service.activateVersion(principal, activationFixtures[index].versions[0].versionId));
    }
    const old = await service.createScheme(principal, { name: 'Old schema role-only remains supported', definition: baseDefinition(), payoutRiskAcknowledgement: ack });
    await service.replaceDraftVersion(principal, old.versions[0].versionId, baseDefinition(), ack);
    await service.createVersion(principal, old.id, baseDefinition(), ack);
    assert.equal((await service.activateVersion(principal, old.versions[0].versionId)).status, 'active');
    assert.equal(activeSavepoint, null);
  } finally { await db.query('ROLLBACK'); }
  assert.deepEqual(await configState(), beforeCapability, 'capability test never commits fixture state');
  assert.deepEqual(await constraints(), beforeCapabilityCatalog, 'capability CHECK restored by rollback');
  evidence.assertions.push('real service/PG missing-capability matrix: both paths including inherit reject create/update/new-version/activate with409 and atomic rollback; role-only configs still work; DDL rollback restores capability');

  for (const who of ['reader', 'foreignOwner']) {
    const expectedStatus = who === 'reader' ? 403 : 404;
    assert.equal((await api(endpoint, 'GET', undefined, who)).status, expectedStatus);
    assert.equal((await api(endpoint, 'PUT', { definition: baseDefinition(), payoutRiskAcknowledgement: ack }, who)).status, expectedStatus);
  }
  const finalDefinition = baseDefinition(); finalDefinition.employeeOverrides = [override('department', 'hookah')];
  await save(finalDefinition); await verify(finalDefinition); await preview(9000);
  const activated = await api(`${endpoint}/activate`, 'POST'); assert.equal(activated.status, 200); assert.equal(activated.body.status, 'active');
  const immutable = await configState();
  assert.equal((await api(endpoint, 'PUT', { definition: baseDefinition(), payoutRiskAcknowledgement: ack })).status, 409);
  assert.deepEqual(await configState(), immutable); assert.equal((await verify(finalDefinition)).status, 'active');
  const next = await api(`/api/payroll/schemes/${baseline.id}/versions`, 'POST', { definition: finalDefinition, payoutRiskAcknowledgement: ack });
  assert.equal(next.status, 201, JSON.stringify(next.body)); assert.equal(next.body.versionNo, 2); assert.equal(next.body.employeeOverrides[0].value, 'hookah');
  evidence.assertions.push('HTTP reader403/foreign-owner404, active immutable PUT409, preserved active readback and additive new-version typed configuration');

  evidence.browser = await runDepartmentBrowserQa({ base, password, users, venue, db, artifacts });
  assert.deepEqual(await protectedCounts(), beforeProtected, 'schema/config/preview/browser QA creates no payroll entry, expense or run');
  evidence.assertions.push('payroll_entries, expenses and payroll_calculation_runs unchanged across complete suite');
  evidence.status = 'PASS'; console.log(`PAYROLL PERSONAL DEPARTMENT POSTGRES QA: PASS ${artifacts}`);
} catch (error) {
  evidence.status = 'FAIL'; evidence.failure = { name: error.name, message: error.message }; throw error;
} finally {
  // Only runner owns DB/container teardown. Close the server before it drops DB.
  try { await mkdir(artifacts, { recursive: true }); await writeFile(path.join(artifacts, 'evidence.json'), JSON.stringify(evidence, null, 2)); }
  finally {
    try { if (child && child.exitCode === null) { const ended = once(child, 'exit'); child.kill(); await ended; } }
    finally { await db.end(); }
  }
}
