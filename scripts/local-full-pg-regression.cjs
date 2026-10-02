'use strict';
// This launcher accepts only the private, explicitly owned disposable local QA target.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { Pool } = require('pg');
const root = path.resolve(__dirname, '..');
const folder = path.join(root, 'tmp', 'full-local-qa');
const suites = new Set([
  'postgres-qa.mjs', 'payroll-lifecycle-migration-preflight.mjs', 'migrations-pg-upgrade-qa.mjs',
  'migrations-pg-runtime-qa.mjs', 'migrations-pg-041-recovery-concurrency-qa.mjs',
  'venue-inventory-departments-postgres-qa.mjs', 'purchase-payment-postgres-api-qa.mjs',
  'guest-loyalty-postgres-api-qa.mjs', 'finance-categories-postgres-api-qa.mjs',
  'loyalty-promotions-postgres-qa.mjs',
  'payroll-lifecycle-postgres-api-qa.mjs', 'tasks-postgres-e2e-qa.mjs', 'delivery-persistence-qa.mjs',
  'finance-employee-postgres-qa.mjs', 'shift-cash-postgres-e2e-qa.mjs',
  'finance-shift-analytics-postgres-qa.mjs', 'paid-order-balance-postgres-qa.mjs',
  'recipe-depletion-pg-runtime-qa.mjs', 'dashboard-pending-metrics-postgres-qa.mjs',
  'session-preferences-postgres-qa.mjs', 'shift-notifications-e2e-qa.mjs',
  'notifications-postgres-qa.mjs', 'purchase-auto-order-postgres-e2e-qa.mjs',
  'saas-quota-suspension-postgres-qa.mjs', 'audit-privacy-postgres-qa.mjs',
  'scoped-role-dependencies-postgres-qa.mjs',
  'reservation-local-date-postgres-qa.mjs',
  'reservation-prepayment-postgres-qa.mjs',
  'staff-identity-postgres-qa.mjs',
  'staff-login-race-postgres-qa.mjs',
]);

function validateConfig(c) {
  assert.equal(c?.database, 'hookah_local_qa', 'Unexpected QA database');
  assert.equal(c?.regressionPort, 31931, 'Unexpected disposable QA port');
  assert.equal(c?.regressionContainer, 'hookah-full-regression-qa-20261001', 'Unexpected QA container');
  assert.equal(c?.dbPort, 31930, 'Unexpected companion local QA port');
  assert.equal(c?.appPort, 31932, 'Unexpected companion local QA app');
  assert.match(c?.dbUser || '', /^[a-z_][a-z0-9_]{0,62}$/i, 'Invalid synthetic QA role');
  assert.ok(typeof c?.dbPassword === 'string' && c.dbPassword.length >= 16, 'Missing private QA credential');
  return c;
}
function validateContainer(item, c) {
  assert.equal(item?.Name, '/' + c.regressionContainer, 'Unexpected container identity');
  assert.equal(item.Config?.Labels?.['hookah.local-qa'], '20261001', 'Missing QA ownership label');
  assert.equal(item.Config?.Image, 'postgres:16-alpine', 'Unexpected QA image');
  assert.equal(item.State?.Running, true, 'Disposable QA container is not running');
  assert.equal(item.HostConfig?.AutoRemove, true, 'Only disposable auto-remove regression containers are accepted');
  assert.equal((item.HostConfig?.Binds || []).length, 0, 'Bind mounts are forbidden');
  const mounts = item.Mounts || [];
  assert.equal(mounts.length, 1, 'Expected exactly one disposable data mount');
  assert.equal(mounts[0].Type, 'volume');
  assert.match(mounts[0].Name, /^[a-f0-9]{64}$/i, 'Named or unrelated data volume is forbidden');
  assert.equal(mounts[0].Destination, '/var/lib/postgresql/data');
  assert.equal(mounts[0].RW, true);
  for (const ports of [item.HostConfig?.PortBindings, item.NetworkSettings?.Ports]) {
    assert.deepEqual(Object.keys(ports || {}), ['5432/tcp'], 'Unexpected published ports');
    assert.deepEqual(ports['5432/tcp'], [{ HostIp: '127.0.0.1', HostPort: '31931' }], 'Only exact loopback31931 binding is accepted');
  }
}
function suiteName(value = 'postgres-qa.mjs') {
  const name = value.startsWith('scripts/') ? value.slice(8) : value;
  assert.ok(suites.has(name), 'Test is outside the explicit local PostgreSQL allowlist');
  assert.ok(fs.existsSync(path.join(__dirname, name)), 'Allowlisted test file is missing');
  return name;
}
function readConfig() { return validateConfig(JSON.parse(fs.readFileSync(path.join(folder, 'runtime.json'), 'utf8'))); }
function urlFor(c, database = c.database) {
  return `postgresql://${encodeURIComponent(c.dbUser)}:${encodeURIComponent(c.dbPassword)}@127.0.0.1:31931/${database}`;
}
function safeText(value, c, extraSecrets = []) {
  let text = String(value).replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/gi, '[redacted QA database URL]');
  for (const secret of [c?.dbPassword, c?.password, c?.appKey, ...extraSecrets].filter(Boolean)) text = text.split(secret).join('[redacted]');
  return text.replace(/("?(?:token|password|pinHash|passwordHash)"?\s*[:=]\s*)"?[^\s",}]+"?/gi, '$1[redacted]');
}
async function verifyTarget(c) {
  const inspection = spawnSync('docker', ['inspect', c.regressionContainer], { windowsHide: true, encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 });
  assert.equal(inspection.status, 0, 'Owned disposable QA container could not be inspected');
  validateContainer(JSON.parse(inspection.stdout)[0], c);
  const { validateQaDatabaseUrl, assertQaDatabaseIdentity } = await import('./postgres-qa-safety.mjs');
  const target = validateQaDatabaseUrl(urlFor(c));
  process.env.MIGRATIONS_PG_TEST_DOCKER_CONTAINER = c.regressionContainer;
  const pool = new Pool({ connectionString: target.url.href, connectionTimeoutMillis: 5000, max: 1 });
  try {
    const identity = (await pool.query('SELECT current_database() AS database,inet_server_addr()::text AS address,inet_server_port() AS port,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser')).rows[0];
    assertQaDatabaseIdentity(identity, c.database, 31931);
  } finally { await pool.end(); }
}
function killOwnedChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  else child.kill('SIGTERM');
}
async function execute(name, env, c, args = [], extraSecrets = []) {
  fs.mkdirSync(folder, { recursive: true });
  const logPath = path.join(folder, 'pg-' + name + '.log');
  const child = spawn(process.execPath, [path.join(__dirname, name), ...args], { cwd: root, windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let data = '', timedOut = false;
  child.stdout.on('data', chunk => { data += chunk; });
  child.stderr.on('data', chunk => { data += chunk; });
  const timer = setTimeout(() => { timedOut = true; killOwnedChild(child); }, 15 * 60_000);
  let code;
  try { code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }); }
  finally { clearTimeout(timer); }
  fs.writeFileSync(logPath, safeText(data, c, extraSecrets));
  assert.ok(!timedOut && code === 0, `${name} failed; sanitized details: tmp/full-local-qa/pg-${name}.log`);
  console.log('PASS PostgreSQL ' + name);
}
async function runSuite(value) {
  const name = suiteName(value), c = readConfig();
  fs.mkdirSync(folder, { recursive: true });
  const lockPath = path.join(folder, 'pg-regression-runner.lock');
  const lockId = crypto.randomUUID();
  const lock = fs.openSync(lockPath, 'wx');
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, id: lockId })); fs.closeSync(lock);
  const ownedDatabases = new Set();
  let app;
  const inherited = { ...process.env };
  for (const key of Object.keys(inherited)) if (/DATABASE_URL|^PG[A-Z_]+$|^SAAS_OWNER_|(?:PASSWORD|TOKEN|PASSPORT_KEY|SESSION_SECRET)$/.test(key)) delete inherited[key];
  const env = { ...inherited, DATABASE_URL: '', NODE_ENV: 'test', HOST: '127.0.0.1', DEMO_MODE: 'false',
    MIGRATIONS_PG_TEST_DATABASE_URL: urlFor(c), PAYROLL_LIFECYCLE_TEST_DATABASE_URL: urlFor(c),
    RECIPE_DEPLETION_PG_TEST_DATABASE_URL: urlFor(c), SHIFT_NOTIFICATIONS_TEST_DATABASE_URL: urlFor(c),
    MIGRATIONS_PG_TEST_DOCKER_CONTAINER: c.regressionContainer };
  async function freshDatabase(database) {
    assert.match(database, /^(?:postgres_qa_[a-f0-9]+|orders_qa_[a-f0-9]+|promotions_qa_[a-f0-9]+|shifts_qa_[a-f0-9]+|reservations_qa_[a-f0-9]+|audit_qa_[a-f0-9]+|notifications_qa_[a-f0-9]+|territory_qa)$/);
    await verifyTarget(c);
    const admin = new Pool({ connectionString: urlFor(c), max: 1 });
    try {
      assert.equal((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [database])).rowCount, 0, 'Refusing an existing extra QA database');
      await admin.query('CREATE DATABASE "' + database + '"'); ownedDatabases.add(database);
    } finally { await admin.end(); }
    const pool = new Pool({ connectionString: urlFor(c, database), max: 1 });
    try {
      await pool.query(fs.readFileSync(path.join(root, 'schema.sql'), 'utf8'));
      for (const migration of fs.readdirSync(path.join(root, 'migrations')).filter(n => n.endsWith('.sql')).sort()) await pool.query(fs.readFileSync(path.join(root, 'migrations', migration), 'utf8'));
    } finally { await pool.end(); }
    return urlFor(c, database);
  }
  try {
    await verifyTarget(c);
    if (name === 'shift-notifications-e2e-qa.mjs') env.SHIFT_NOTIFICATIONS_TEST_DATABASE_URL = await freshDatabase('shifts_qa_' + crypto.randomBytes(8).toString('hex'));
    if (name === 'notifications-postgres-qa.mjs') env.NOTIFICATIONS_TEST_DATABASE_URL = await freshDatabase('notifications_qa_' + crypto.randomBytes(8).toString('hex'));
    if (name === 'postgres-qa.mjs') env.MIGRATIONS_PG_TEST_DATABASE_URL = await freshDatabase('postgres_qa_' + crypto.randomBytes(8).toString('hex'));
    if (['paid-order-balance-postgres-qa.mjs', 'shift-cash-postgres-e2e-qa.mjs', 'dashboard-pending-metrics-postgres-qa.mjs', 'finance-shift-analytics-postgres-qa.mjs', 'guest-loyalty-postgres-api-qa.mjs'].includes(name)) env.MIGRATIONS_PG_TEST_DATABASE_URL = await freshDatabase('orders_qa_' + crypto.randomBytes(8).toString('hex'));
    if (name === 'recipe-depletion-pg-runtime-qa.mjs') env.RECIPE_DEPLETION_PG_TEST_DATABASE_URL = await freshDatabase('orders_qa_' + crypto.randomBytes(8).toString('hex'));
    if (name === 'loyalty-promotions-postgres-qa.mjs') env.MIGRATIONS_PG_TEST_DATABASE_URL = await freshDatabase('promotions_qa_' + crypto.randomBytes(8).toString('hex'));
    if (name === 'reservation-prepayment-postgres-qa.mjs') env.MIGRATIONS_PG_TEST_DATABASE_URL = await freshDatabase('reservations_qa_' + crypto.randomBytes(8).toString('hex'));
    if (name === 'reservation-local-date-postgres-qa.mjs') env.MIGRATIONS_PG_TEST_DATABASE_URL = await freshDatabase('reservations_qa_' + crypto.randomBytes(8).toString('hex'));
    if (name === 'audit-privacy-postgres-qa.mjs') env.MIGRATIONS_PG_TEST_DATABASE_URL = await freshDatabase('audit_qa_' + crypto.randomBytes(8).toString('hex'));
    if (name === 'purchase-auto-order-postgres-e2e-qa.mjs') {
      env.MIGRATIONS_PG_TEST_DATABASE_URL = await freshDatabase('territory_qa');
      env.CRM_QA_DATABASE_NAME = 'territory_qa'; env.MIGRATIONS_PG_TEST_PORT = '31931';
    }
    if (name === 'saas-quota-suspension-postgres-qa.mjs') {
      const password = crypto.randomBytes(32).toString('hex'), email = 'local-full-qa@example.invalid';
      let output = '';
      app = spawn(process.execPath, [path.join(root, 'server.js')], { cwd: root, windowsHide: true, env: { ...env, DATABASE_URL: urlFor(c), PORT: '0', AUTH_REQUIRED: 'true', SAAS_OWNER_EMAIL: email, SAAS_OWNER_PASSWORD: password }, stdio: ['ignore', 'pipe', 'pipe'] });
      let startupError;
      app.once('error', error => { startupError = error; });
      app.stdout.on('data', chunk => { output += chunk; }); app.stderr.on('data', chunk => { output += chunk; });
      let base;
      for (let i = 0; i < 200; i++) {
        assert.ok(!startupError, 'Owned SaaS QA app could not be started');
        const match = output.match(/CRM running on http:\/\/localhost:(\d+)/);
        if (match) { base = 'http://127.0.0.1:' + match[1]; break; }
        assert.equal(app.exitCode, null, 'Owned SaaS QA app exited during startup');
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.ok(base, 'Owned SaaS QA app did not start');
      await execute(name, { ...env, SAAS_OWNER_EMAIL: email, SAAS_OWNER_PASSWORD: password }, c, [base], [password]);
    } else await execute(name, env, c);
  } finally {
    if (app?.pid) {
      const close = app.exitCode === null && app.signalCode === null ? new Promise(resolve => app.once('close', resolve)) : Promise.resolve();
      killOwnedChild(app); await close;
    }
    try {
      for (const database of ownedDatabases) {
        await verifyTarget(c);
        const pool = new Pool({ connectionString: urlFor(c), max: 1 });
        try { await pool.query('DROP DATABASE "' + database + '"'); } finally { await pool.end(); }
      }
    } finally {
      if (JSON.parse(fs.readFileSync(lockPath, 'utf8')).id === lockId) fs.unlinkSync(lockPath);
    }
  }
}
function checkGuards() {
  const c = { database: 'hookah_local_qa', regressionPort: 31931, regressionContainer: 'hookah-full-regression-qa-20261001', dbPort: 31930, appPort: 31932, dbUser: 'qa_user', dbPassword: 'synthetic-qa-credential-only' };
  const item = { Name: '/' + c.regressionContainer, Config: { Image: 'postgres:16-alpine', Labels: { 'hookah.local-qa': '20261001' } }, State: { Running: true }, HostConfig: { AutoRemove: true, Binds: [], PortBindings: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '31931' }] } }, NetworkSettings: { Ports: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '31931' }] } }, Mounts: [{ Type: 'volume', Name: 'a'.repeat(64), Destination: '/var/lib/postgresql/data', RW: true }] };
  let checks = 0; validateConfig(c); checks++; validateContainer(item, c); checks++; suiteName(); checks++;
  for (const [key, value] of [['database','production'],['regressionPort',5432],['regressionContainer','production'],['dbPort',5432],['appPort',80],['dbUser','bad/user'],['dbPassword','']]) { assert.throws(() => validateConfig({ ...c, [key]: value })); checks++; }
  for (const change of [x=>x.Name='/production',x=>x.Config.Labels['hookah.local-qa']='other',x=>x.Config.Image='postgres:other',x=>x.State.Running=false,x=>x.HostConfig.AutoRemove=false,x=>x.HostConfig.Binds=['/prod:/data'],x=>x.HostConfig.PortBindings['5432/tcp'][0].HostIp='0.0.0.0',x=>x.NetworkSettings.Ports['5432/tcp'][0].HostIp='::',x=>x.NetworkSettings.Ports['5432/tcp'][0].HostPort='5432',x=>x.Mounts[0].Name='production-data',x=>x.Mounts[0].Type='bind',x=>x.Mounts[0].RW=false,x=>x.Mounts.push({...x.Mounts[0]})]) { const x=structuredClone(item); change(x); assert.throws(()=>validateContainer(x,c)); checks++; }
  for (const value of ['../server.js','server.js','scripts/notifications-browser-qa.mjs','company-venue-postgres-qa.mjs','scripts/../postgres-qa.mjs']) { assert.throws(()=>suiteName(value)); checks++; }
  assert.equal(safeText('postgresql://qa:synthetic@localhost/db '+c.dbPassword,c).includes(c.dbPassword),false); checks++;
  console.log(`LOCAL FULL PG RUNNER GUARDS: PASS (${checks} cases; no Docker/database mutations)`);
}
module.exports = { runSuite, checkGuards, suites, validateConfig, validateContainer, safeText };
if (require.main === module) {
  if (process.argv.length > 3) { console.error('LOCAL FULL PG STOPPED: accepts exactly one allowlisted suite or guard mode'); process.exitCode = 1; }
  else if (process.argv[2] === '--check-guards') checkGuards();
  else if (process.argv[2] === '--guard') verifyTarget(readConfig()).then(() => console.log('LOCAL FULL PG TARGET: PASS (read-only verification)')).catch(() => { console.error('LOCAL FULL PG TARGET: FAIL; inspect private configuration and owned container'); process.exitCode = 1; });
  else runSuite(process.argv[2]).catch(error => { console.error('LOCAL FULL PG STOPPED: ' + safeText(error.message, (() => { try { return readConfig(); } catch { return {}; } })())); process.exitCode = 1; });
}
