'use strict';
// Helpers are also used by the separate opt-in attendance preview launcher.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { randomUUID, randomBytes, scryptSync } = require('node:crypto');
const { Client } = require('pg');
const { config, options } = require('./staff-schedule-local-config.cjs');
const { isolatedEnvironment } = require('./staff-schedule-local-env.cjs');
const root = path.resolve(__dirname, '..');
const quote = value => '"' + value.replace(/"/g, '""') + '"';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const key = () => ({ requestKey: randomUUID() });

async function createRuntime(database, password = randomBytes(20).toString('base64url')) {
  assert.match(database, /^attendance_(?:http|preview)_[a-z0-9_]{1,40}$/);
  const cfg = config(); assert.notEqual(database, cfg.database);
  const conn = { ...options(cfg), connectionTimeoutMillis: 10000, statement_timeout: 60000 };
  const admin = new Client({ ...conn, database: 'postgres' });
  let db, created = false;
  const dispose = async () => {
    try { if (db) { await db.end(); db = null; } }
    finally {
      try {
        if (created) {
          config(); await admin.query(`DROP DATABASE ${quote(database)}`); created = false;
          assert.equal((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [database])).rowCount, 0);
          console.log(JSON.stringify({ cleanup: 'PASS', database }));
        }
      } finally { await admin.end(); }
    }
  };
  await admin.connect();
  try {
    assert.equal((await admin.query('SELECT current_database() AS db')).rows[0].db, 'postgres');
    await admin.query(`CREATE DATABASE ${quote(database)} TEMPLATE template0`); created = true;
    db = new Client({ ...conn, database }); await db.connect();
    assert.equal((await db.query('SELECT current_database() AS db')).rows[0].db, database);
    const files = ['schema.sql', ...fs.readdirSync(path.join(root, 'migrations')).filter(f => f.endsWith('.sql')).sort().map(f => `migrations/${f}`)];
    for (const file of files) {
      await db.query('BEGIN');
      try { await db.query(fs.readFileSync(path.join(root, file), 'utf8')); await db.query('COMMIT'); }
      catch (error) { await db.query('ROLLBACK'); throw error; }
    }
    const fixtures = { database, password, organizations: [randomUUID(), randomUUID()], venues: [randomUUID(), randomUUID()], users: [] };
    const salt = randomBytes(16).toString('hex');
    const hash = `scrypt$${salt}$${scryptSync(password, salt, 64).toString('hex')}`;
    for (let i = 0; i < 2; i++) {
      await db.query('INSERT INTO organizations(id,name,slug,timezone) VALUES($1,$2,$3,\'Asia/Yekaterinburg\')', [fixtures.organizations[i], 'Attendance QA', `qa-${fixtures.organizations[i]}`]);
      await db.query("INSERT INTO organization_subscriptions(organization_id,plan,status,seats_limit,venues_limit) VALUES($1,'network','active',50,10)", [fixtures.organizations[i]]);
      await db.query('INSERT INTO venues(id,organization_id,name,timezone) VALUES($1,$2,$3,\'Asia/Yekaterinburg\')', [fixtures.venues[i], fixtures.organizations[i], `Attendance QA ${i}`]);
    }
    for (const [label, role, tenant] of [['owner','owner',0], ['admin','admin',0], ['manager','manager',0], ['employee','bartender',0], ['foreign','owner',1]]) {
      const user = { id: randomUUID(), label, role, tenant, login: `attendance-${label}@example.test` };
      fixtures.users.push(user);
      await db.query('INSERT INTO users(id,venue_id,organization_id,full_name,login,password_hash,role) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [user.id, fixtures.venues[tenant], fixtures.organizations[tenant], `Тестовый ${label}`, user.login, hash, role]);
      await db.query("INSERT INTO organization_memberships(organization_id,user_id,membership_role,status,is_primary) VALUES($1,$2,$3,'active',$4)",
        [fixtures.organizations[tenant], user.id, role === 'owner' ? 'owner' : 'member', role === 'owner']);
    }
    return { cfg: { ...cfg, database }, db, fixtures, dispose,
      retain: async () => { await db.end(); db = null; await admin.end(); } };
  } catch (error) { await dispose(); throw error; }
}
async function freePort(wanted = 0) {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(wanted, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  assert(![31943,31944,31945].includes(port)); return port;
}
async function stopServer(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const ended = once(child, 'exit'); child.kill();
  let timer;
  try { await Promise.race([ended, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Owned server did not stop; refusing DB drop')), 10000); })]); }
  finally { clearTimeout(timer); }
}
async function startServer(runtime, port) {
  const child = spawn(process.execPath, [path.join(root, 'server.js')], {
    cwd: root, env: { ...isolatedEnvironment(runtime.cfg, runtime.fixtures), PORT: String(port) }, stdio: 'ignore', windowsHide: true
  });
  let spawnError; child.once('error', error => { spawnError = error; });
  try {
    for (let i = 0; i < 150; i++) {
      if (spawnError) throw spawnError;
      assert.equal(child.exitCode, null, 'Owned server exited before readiness');
      try { if ((await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(500) })).ok) return child; } catch {}
      await delay(100);
    }
    throw new Error('Owned server readiness timeout');
  } catch (error) { await stopServer(child); throw error; }
}
async function main() {
  assert(process.argv.includes('--run'), 'Explicit --run required');
  const port = await freePort();
  assert.notEqual(port, 31946, 'HTTP QA must not use the dedicated browser preview port');
  const runtime = await createRuntime(`attendance_http_${Date.now()}_${randomBytes(4).toString('hex')}`);
  let child, checks = 0;
  try {
    child = await startServer(runtime, port);
    const base = `http://127.0.0.1:${port}`, prefix = '/api/staff/attendance';
    // Fetch anonymously: dynamic UI modules must be publicly served, not HTML fallbacks.
    for (const [file, mime, marker] of [
      ['staff-attendance-ui.js', /^(?:application|text)\/javascript(?:\s*;|$)/i, 'window.HOOKAH_ATTENDANCE'],
      ['staff-attendance-ui.css', /^text\/css(?:\s*;|$)/i, '.attendance-page']
    ]) {
      const response = await fetch(`${base}/${file}`, { signal: AbortSignal.timeout(10000), redirect: 'error' });
      assert.equal(response.status, 200, `${file}: public status`); checks++;
      assert.match(response.headers.get('content-type') || '', mime, `${file}: content type`); checks++;
      const content = await response.text();
      assert(content.includes(marker), `${file}: module marker`); checks++;
      assert.doesNotMatch(content, /^\s*(?:<!doctype\s+html|<html\b)/i, `${file}: HTML fallback`); checks++;
      assert.equal(content, fs.readFileSync(path.join(root, file), 'utf8'), `${file}: exact source parity`); checks++;
    }
    async function request(route, actor, method = 'GET', body, extra = {}) {
      const response = await fetch(base + route, { method, signal: AbortSignal.timeout(10000),
        headers: { 'Content-Type': 'application/json', Origin: base, ...(actor ? { Cookie: actor.cookie } : {}), ...extra },
        ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
      const parsed = await response.json();
      assert.doesNotMatch(JSON.stringify(parsed), /password_hash|DATABASE_URL|stack trace|constraint .*check/i);
      return { status: response.status, body: parsed, cookies: response.headers.getSetCookie() };
    }
    async function expect(route, actor, method, body, status, extra) {
      const result = await request(route.startsWith('/api/') ? route : prefix + route, actor, method, body, extra);
      assert.equal(result.status, status, `${method} ${route}: ${result.body.error || result.status}`); checks++; return result.body;
    }
    for (const user of runtime.fixtures.users) {
      const login = await request('/api/login', null, 'POST', { username: user.login, password: runtime.fixtures.password });
      assert.equal(login.status, 200, `Login ${user.label}`);
      user.cookie = login.cookies.map(cookie => cookie.split(';')[0]).join('; ');
      assert(user.cookie); checks++;
    }
    const by = Object.fromEntries(runtime.fixtures.users.map(u => [u.label,u]));
    const protectedNames = (await runtime.db.query(`SELECT tablename FROM pg_tables WHERE schemaname='public'
      AND (tablename LIKE 'payroll_%' OR tablename LIKE 'staff_schedule%' OR tablename='staff_work_logs'
        OR tablename LIKE 'shift%' OR tablename LIKE 'order%' OR tablename LIKE 'payment%'
        OR tablename LIKE 'stock%' OR tablename LIKE 'inventory_%' OR tablename='expenses') ORDER BY tablename`)).rows.map(r => r.tablename);
    const snapshot = async () => {
      const result = {};
      for (const table of protectedNames) result[table] = (await runtime.db.query(`SELECT count(*)::text count,
        md5(coalesce(string_agg(h,'' ORDER BY h),'')) hash FROM (SELECT md5(row_to_json(t)::text) h FROM ${quote(table)} t) r`)).rows[0];
      return result;
    };
    const baseline = await snapshot();
    await expect('/self', null, 'GET', undefined, 401);
    for (const label of ['owner','employee','admin','foreign']) {
      const session = await expect('/api/session', by[label], 'GET', undefined, 200);
      assert(session.permissions.includes('staff_attendance_self'));
      assert.equal(session.permissions.includes('staff_attendance_policy_manage'), ['owner','foreign'].includes(label));
      assert.equal(session.permissions.includes('staff_attendance_approval'), ['owner','foreign'].includes(label));
    }
    await expect('/management', by.employee, 'GET', undefined, 403);
    await expect('/management', by.admin, 'GET', undefined, 403);
    await expect('/management', by.owner, 'GET', undefined, 200);
    for (const headers of [{ Origin: 'https://evil.example' }, { Origin: '' }, { 'Sec-Fetch-Site': 'cross-site' }])
      await expect('/start', by.employee, 'POST', key(), 403, headers);
    for (const input of [null, [], {}, { ...key(), userId: by.foreign.id }, { ...key(), startedAt: '2000-01-01' }, { requestKey: 'invalid' }])
      await expect('/start', by.employee, 'POST', input, 400);
    await expect('/policy', by.owner, 'PUT', { ...key(), mode: 'free', preparationMinutes: 241, version: 0 }, 400);
    await expect('/policy', by.owner, 'PUT', { ...key(), mode: 'free', preparationMinutes: 0, version: '0' }, 400);
    const startKey = key();
    const started = await expect('/start', by.employee, 'POST', startKey, 200);
    assert.deepEqual(await expect('/start', by.employee, 'POST', startKey, 200), started);
    await expect('/start', by.employee, 'POST', { ...startKey, reason: 'Другой запрос' }, 409);
    await expect('/end', by.foreign, 'POST', { ...key(), id: started.id, version: started.version }, 409);
    const foreign = await expect('/management', by.foreign, 'GET', undefined, 200);
    assert(!JSON.stringify(foreign).includes(started.id));
    await expect('/end', by.employee, 'POST', { ...key(), id: started.id, version: 0 }, 409);
    await expect('/end', by.employee, 'POST', { ...key(), id: started.id, version: started.version }, 200);
    await expect('/grants', by.owner, 'PUT', { ...key(), userId: by.admin.id, managePolicy: true, approve: true, version: 0 }, 200);
    const delegated = await expect('/api/session', by.admin, 'GET', undefined, 200);
    assert(delegated.permissions.includes('staff_attendance_policy_manage')); assert(delegated.permissions.includes('staff_attendance_approval'));
    await expect('/policy', by.admin, 'PUT', { ...key(), mode: 'approval', preparationMinutes: 0, version: 0 }, 200);
    await expect('/start', by.employee, 'POST', key(), 409);
    const requested = await expect('/requests', by.employee, 'POST', { ...key(), reason: 'Срочная подмена' }, 200);
    await expect(`/requests/${requested.id}/decision`, by.foreign, 'POST', { ...key(), version: requested.version, decision: 'approved' }, 409);
    await expect(`/requests/${requested.id}/decision`, by.admin, 'POST', { ...key(), version: requested.version, decision: 'approved' }, 200);
    const admitted = await expect('/start', by.employee, 'POST', { ...key(), approvalId: requested.id }, 200);
    const self = await expect('/self', by.employee, 'GET', undefined, 200);
    assert(self.serverNow); assert.equal(self.requests.find(r => r.id === requested.id).status, 'used');
    await expect('/end', by.employee, 'POST', { ...key(), id: admitted.id, version: admitted.version }, 200);
    await expect('/start', by.employee, 'POST', { ...key(), approvalId: requested.id }, 409);
    const expiredRequest = await expect('/requests', by.employee, 'POST', { ...key(), reason: 'Истекающая заявка' }, 200);
    // Controlled clock fixture in OUR disposable DB, never historical/shared data.
    await runtime.db.query(`UPDATE staff_attendance_requests SET window_start=clock_timestamp()-interval '2 hours',
      window_end=clock_timestamp()-interval '1 hour' WHERE id=$1`, [expiredRequest.id]);
    const expiredSelf = await expect('/self', by.employee, 'GET', undefined, 200);
    assert.equal(expiredSelf.requests.find(r => r.id === expiredRequest.id).status, 'expired');
    assert.equal((await runtime.db.query('SELECT status FROM staff_attendance_requests WHERE id=$1', [expiredRequest.id])).rows[0].status, 'pending');
    const renewed = await expect('/requests', by.employee, 'POST', { ...key(), reason: 'Новая заявка после истечения' }, 200);
    await expect(`/requests/${renewed.id}/cancel`, by.employee, 'POST', { ...key(), version: renewed.version }, 200);
    await expect('/grants', by.owner, 'PUT', { ...key(), userId: by.admin.id, managePolicy: false, approve: false, version: 1 }, 200);
    await expect('/management', by.admin, 'GET', undefined, 403);
    const revoked = await expect('/api/session', by.admin, 'GET', undefined, 200);
    assert(!revoked.permissions.includes('staff_attendance_approval')); assert(!revoked.permissions.includes('staff_attendance_policy_manage'));
    await expect('/policy', by.admin, 'PUT', { ...key(), mode: 'free', preparationMinutes: 0, version: 1 }, 403);
    assert.deepEqual(await snapshot(), baseline); checks++;
    console.log(JSON.stringify({ result: 'PASS', checks, protectedTables: protectedNames.length, realAuth: true, cookieCsrf: true }));
  } finally { await stopServer(child); await runtime.dispose(); }
}
module.exports = { createRuntime, freePort, startServer, stopServer, root };
if (require.main === module) main().catch(error => { console.error(JSON.stringify({ result: 'FAIL', code: error.code || error.name, message: error.message })); process.exitCode = 1; });
