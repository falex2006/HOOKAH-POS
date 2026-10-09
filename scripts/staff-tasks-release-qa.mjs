import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomUUID, randomBytes, scryptSync } from 'node:crypto';
import { assertQaDatabaseIdentity, validateQaDatabaseUrl } from './postgres-qa-safety.mjs';

// Execute the shipped task route unchanged. This isolates its policy from HTTP
// session middleware; login/session contracts are covered by separate release QA.
const root = new URL('../', import.meta.url);
const source = fs.readFileSync(new URL('server.js', root), 'utf8');
const begin = source.indexOf("if (pathname === '/api/tasks' && req.method === 'GET')");
const end = source.indexOf("if (pathname === '/api/reservations' && req.method === 'GET')", begin);
assert.ok(begin > 0 && end > begin);
const helpers = source.slice(source.indexOf('function normalizeTaskDeadline(input)'), source.indexOf('\nconst root ='));
const handler = new Function('pathname', 'req', 'res', 'url', 'repositories', 'venueDbId', 'denyUnlessAny', 'hasPermission', 'body', 'json', 'recordAudit', 'tasks', 'staff',
  `return (async()=>{${helpers}\n${source.slice(begin, end)}})();`);
const user = (id, permissions, role) => ({ id, permissions, role });
const employee = user(randomUUID(), ['orders'], 'hookah_master');
const other = user(randomUUID(), ['orders'], 'bartender');
const manager = user(randomUUID(), ['tasks_manage']);
const staffManager = user(randomUUID(), ['staff_manage']);
const viewer = user(employee.id, ['staff_view']);
const memoryTasks = [];
const staff = [employee, other, manager, staffManager].map(person => ({ ...person, active: true, name: 'Synthetic task QA' }));
let pool = null;
let venueId = randomUUID();
let queryOverride = null;
const api = async (identity, method = 'GET', id = '', input = {}, venue = venueId) => {
  let result;
  const url = new URL(`http://localhost/api/tasks${id ? '/' + id : ''}`);
  const hasPermission = (req, permission) => req.user.permissions.includes(permission);
  const json = (_res, status, data) => { result = { status, data: structuredClone(data) }; };
  const denyUnlessAny = (req, res, permissions) => {
    if (permissions.some(permission => hasPermission(req, permission))) return false;
    json(res, 403, { error: 'forbidden' }); return true;
  };
  await handler(url.pathname, { method, user: identity }, {}, url, pool ? { pool: queryOverride || pool } : null,
    venue, denyUnlessAny, hasPermission, async () => input, json, () => {}, memoryTasks, staff);
  assert.ok(result, 'route responded');
  return result;
};
let checks = 0;
const expect = (response, status, message) => { assert.equal(response.status, status, message + ': ' + JSON.stringify(response)); checks++; return response.data; };
async function policySuite(mode) {
  // Memory task IDs use Date.now(); wait only for a new millisecond between creates.
  const a = expect(await api(manager, 'POST', '', { title: 'Assigned A', assigneeId: employee.id }), 201, 'manager creates');
  await new Promise(resolve => setTimeout(resolve, 2));
  const b = expect(await api(staffManager, 'POST', '', { title: 'Assigned B', assigneeId: other.id }), 201, 'staff manager creates');
  for (const identity of [employee, viewer]) {
    const items = expect(await api(identity), 200, 'employee/viewer lists').items;
    assert.deepEqual(items.map(item => item.id), [a.id]); checks++;
  }
  for (const identity of [manager, staffManager]) {
    const items = expect(await api(identity), 200, 'management-only permission lists').items;
    assert.equal(items.length, 2); checks++;
  }
  expect(await api(user(employee.id, [])), 403, 'no permission read denied');
  expect(await api(employee, 'POST', '', { title: 'Forbidden', assigneeId: employee.id }), 403, 'employee creation denied');
  expect(await api(other, 'PATCH', a.id, { status: 'done' }), 403, 'other assignee update denied');
  expect(await api(employee, 'PATCH', a.id, { title: 'Changed' }), 403, 'employee content edit denied');
  expect(await api(employee, 'DELETE', a.id), 403, 'employee delete denied');
  expect(await api(employee, 'PATCH', a.id, { status: 'cancelled' }), 403, 'employee cancellation denied');
  expect(await api(employee, 'PATCH', a.id, { status: ['cancelled'] }), 400, 'non-string cancellation denied');
  for (const status of ['in_progress', 'done']) assert.equal(expect(await api(other, 'PATCH', b.id, { status }), 200, 'bartender assigned status').status, status);
  expect(await api(other, 'PATCH', b.id, { status: 'cancelled' }), 403, 'bartender cancellation denied');
  for (const status of ['in_progress', 'done']) {
    assert.equal(expect(await api(employee, 'PATCH', a.id, { status }), 200, 'assigned employee status').status, status); checks++;
    assert.equal(expect(await api(manager), 200, 'management reread').items.find(item => item.id === a.id).status, status); checks++;
  }
  assert.equal(expect(await api(manager, 'PATCH', a.id, { status: 'cancelled' }), 200, 'manager cancels').status, 'cancelled');
  for (const status of ['open', 'in_progress', 'done']) expect(await api(employee, 'PATCH', a.id, { status }), 403, 'cancelled task revival denied');
  assert.equal(expect(await api(staffManager, 'PATCH', a.id, { status: 'open' }), 200, 'staff manager revives').status, 'open');
  expect(await api(manager, 'DELETE', b.id), 200, 'manager delete allowed');
  console.log(`STAFF TASK POLICY ${mode}: PASS`);
  return a.id;
}
await policySuite('MEMORY');

// Optional PG mode deliberately accepts only the existing private disposable
// localhost QA environment, after the project's strict container guard passes.
if (process.argv.includes('--postgres')) {
  const guard = spawnSync(process.execPath, ['scripts/local-full-pg-regression.cjs', '--guard'], { cwd: root, encoding: 'utf8', windowsHide: true });
  assert.equal(guard.status, 0, 'owned disposable QA target guard must pass');
  const config = JSON.parse(fs.readFileSync(new URL('tmp/full-local-qa/runtime.json', root), 'utf8'));
  const databaseUrl = `postgresql://${encodeURIComponent(config.dbUser)}:${encodeURIComponent(config.dbPassword)}@127.0.0.1:31931/hookah_local_qa`;
  const target = validateQaDatabaseUrl(databaseUrl);
  process.env.MIGRATIONS_PG_TEST_DOCKER_CONTAINER = config.regressionContainer;
  const require = createRequire(import.meta.url);
  pool = new (require('pg').Client)({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
  await pool.connect();
  const venues = [];
  try {
    const identity = (await pool.query('SELECT current_database() AS database,inet_server_addr()::text AS address,inet_server_port() AS port,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser')).rows[0];
    assertQaDatabaseIdentity(identity, target.database, 31931);
    await pool.query('BEGIN');
    for (const label of ['Task policy release QA', 'Task policy other tenant QA']) {
      venues.push((await pool.query('INSERT INTO venues(name) VALUES($1) RETURNING id', [label])).rows[0].id);
    }
    venueId = venues[0];
    for (const person of staff) await pool.query('INSERT INTO users(id,venue_id,full_name,login,role) VALUES($1,$2,$3,$4,$5)', [person.id, venueId, person.name, 'task-release-' + person.id, person.role || 'manager']);
    const taskId = await policySuite('POSTGRESQL');
    assert.deepEqual(expect(await api(manager, 'GET', '', {}, venues[1]), 200, 'other tenant lists').items, []); checks++;
    expect(await api(manager, 'PATCH', taskId, { status: 'cancelled' }, venues[1]), 404, 'other tenant write denied');
    for (const race of ['cancel', 'reassign']) {
      await api(manager, 'PATCH', taskId, { status: 'open', assigneeId: employee.id });
      let injected = false;
      queryOverride = { query: async (sql, values) => {
        const result = await pool.query(sql, values);
        if (!injected && sql.startsWith('SELECT id,status,assignee_id')) {
          injected = true;
          if (race === 'cancel') await pool.query("UPDATE tasks SET status='cancelled' WHERE id=$1 AND venue_id=$2", [taskId, venueId]);
          else await pool.query('UPDATE tasks SET assignee_id=$1 WHERE id=$2 AND venue_id=$3', [other.id, taskId, venueId]);
        }
        return result;
      } };
      const conflict = expect(await api(employee, 'PATCH', taskId, { status: 'done' }), 409, 'concurrent ' + race + ' blocks stale employee update');
      assert.equal(conflict.error, 'task_changed'); checks++;
      queryOverride = null;
      const persisted = (await pool.query('SELECT status,assignee_id FROM tasks WHERE id=$1 AND venue_id=$2', [taskId, venueId])).rows[0];
      assert.equal(persisted.status, race === 'cancel' ? 'cancelled' : 'open');
      assert.equal(persisted.assignee_id, race === 'cancel' ? employee.id : other.id); checks += 2;
    }
    console.log('STAFF TASK PG TENANT/RACE: PASS (cancel and reassign between authorization read and write)');
  } finally {
    queryOverride = null;
    await pool.query('ROLLBACK');
    if (venues.length) assert.equal((await pool.query('SELECT 1 FROM venues WHERE id=ANY($1::uuid[])', [venues])).rowCount, 0);
    await pool.end();
    console.log('STAFF TASK QA CLEANUP: PASS (transaction rolled back, runner-created venues absent)');
  }
}
console.log(`STAFF TASK RELEASE QA: PASS (${checks} policy assertions; no production access)`);

// Full middleware/session -> HTTP API -> PG -> fresh GET coverage, using a new
// database owned exclusively by this run. Never point this mode at a live app.
if (process.argv.includes('--http')) {
  const require = createRequire(import.meta.url);
  const { Pool } = require('pg');
  const guards = require('./local-full-pg-regression.cjs');
  const config = guards.validateConfig(JSON.parse(fs.readFileSync(new URL('tmp/full-local-qa/runtime.json', root), 'utf8')));
  const guard = () => assert.equal(spawnSync(process.execPath, ['scripts/local-full-pg-regression.cjs', '--guard'], { cwd: root, encoding: 'utf8', windowsHide: true }).status, 0, 'owned disposable target verified');
  guard();
  const database = 'tasks_qa_' + randomBytes(8).toString('hex');
  const connectionString = name => `postgresql://${encodeURIComponent(config.dbUser)}:${encodeURIComponent(config.dbPassword)}@127.0.0.1:31931/${name}`;
  const admin = new Pool({ connectionString: connectionString(config.database), max: 1 });
  let db, app, created = false;
  const httpStartCount = checks;
  try {
    assert.equal((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [database])).rowCount, 0);
    await admin.query(`CREATE DATABASE "${database}"`); created = true;
    db = new Pool({ connectionString: connectionString(database), max: 2 });
    await db.query(fs.readFileSync(new URL('schema.sql', root), 'utf8'));
    for (const file of fs.readdirSync(new URL('migrations/', root)).filter(name => name.endsWith('.sql')).sort()) await db.query(fs.readFileSync(new URL('migrations/' + file, root), 'utf8'));
    const org = randomUUID(), venue = randomUUID(), foreignOrg = randomUUID(), foreignVenue = randomUUID();
    for (const [organizationId, venueId] of [[org, venue], [foreignOrg, foreignVenue]]) {
      await db.query('INSERT INTO organizations(id,name,slug) VALUES($1,$2,$3)', [organizationId, 'Tasks release QA', 'qa-' + organizationId]);
      await db.query("INSERT INTO organization_subscriptions(organization_id,plan,status,seats_limit,venues_limit) VALUES($1,'enterprise','active',50,5)", [organizationId]);
      await db.query('INSERT INTO venues(id,organization_id,name) VALUES($1,$2,$3)', [venueId, organizationId, 'Tasks release QA venue']);
    }
    const password = randomBytes(24).toString('hex'), salt = randomBytes(16).toString('hex');
    const hash = `scrypt$${salt}$${scryptSync(password, salt, 64).toString('hex')}`;
    const actors = {};
    for (const role of ['owner', 'manager', 'bartender', 'hookah_master', 'foreign']) {
      const id = randomUUID(), foreign = role === 'foreign'; actors[role] = id;
      await db.query('INSERT INTO users(id,venue_id,organization_id,full_name,login,password_hash,role) VALUES($1,$2,$3,$4,$5,$6,$7)', [id, foreign ? foreignVenue : venue, foreign ? foreignOrg : org, 'Tasks QA ' + role, 'qa_' + id, hash, foreign ? 'owner' : role]);
      await db.query("INSERT INTO organization_memberships(organization_id,user_id,membership_role,status) VALUES($1,$2,'member','active')", [foreign ? foreignOrg : org, id]);
    }
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (/DATABASE_URL|^PG[A-Z_]+$|^SAAS_OWNER_|(?:PASSWORD|TOKEN|PASSPORT_KEY|SESSION_SECRET)$/.test(key)) delete env[key];
    app = spawn(process.execPath, ['server.js'], { cwd: root, windowsHide: true, env: { ...env, HOST: '127.0.0.1', PORT: '0', NODE_ENV: 'test', AUTH_REQUIRED: 'true', DEMO_MODE: 'false', DATABASE_URL: connectionString(database), VENUE_ID: venue, API_RATE_LIMIT: '10000' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const base = await new Promise((resolve, reject) => {
      let output = ''; const timeout = setTimeout(() => reject(Error('Owned HTTP QA startup timeout')), 20000);
      app.once('error', reject); app.once('exit', () => { clearTimeout(timeout); reject(Error('Owned HTTP QA app exited')); });
      app.stdout.on('data', chunk => { output += chunk; const port = output.match(/CRM running on http:\/\/localhost:(\d+)/)?.[1]; if (port) { clearTimeout(timeout); resolve('http://127.0.0.1:' + port); } });
      app.stderr.on('data', () => {});
    });
    const http = async (path, token, method = 'GET', body, expected = 200) => {
      const response = await fetch(base + path, { method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      const data = await response.json(); assert.equal(response.status, expected, `${method} ${path}: ${data.error || 'unexpected response'}`); checks++; return data;
    };
    const tokens = {};
    for (const [role, id] of Object.entries(actors)) tokens[role] = (await http('/api/login', '', 'POST', { username: 'qa_' + id, password })).token;
    for (const role of ['bartender', 'hookah_master']) {
      const otherRole = role === 'bartender' ? 'hookah_master' : 'bartender';
      const task = await http('/api/tasks', tokens.manager, 'POST', { title: 'Assigned ' + role, assigneeId: actors[role] }, 201);
      assert.ok((await http('/api/tasks', tokens[role])).items.some(item => item.id === task.id)); checks++;
      assert.ok(!(await http('/api/tasks', tokens[otherRole])).items.some(item => item.id === task.id)); checks++;
      await http('/api/tasks/' + task.id, tokens[otherRole], 'PATCH', { status: 'done' }, 403);
      await http('/api/tasks/' + task.id, tokens[role], 'DELETE', undefined, 403);
      await http('/api/tasks/' + task.id, tokens[role], 'PATCH', { status: 'cancelled' }, 403);
      for (const status of ['in_progress', 'done']) {
        await http('/api/tasks/' + task.id, tokens[role], 'PATCH', { status });
        assert.equal((await http('/api/tasks', tokens.manager)).items.find(item => item.id === task.id)?.status, status); checks++;
        assert.equal((await db.query('SELECT status FROM tasks WHERE id=$1 AND venue_id=$2', [task.id, venue])).rows[0].status, status); checks++;
      }
      await http('/api/tasks/' + task.id, tokens.manager, 'PATCH', { status: 'cancelled' });
      for (const status of ['open', 'in_progress', 'done']) await http('/api/tasks/' + task.id, tokens[role], 'PATCH', { status }, 403);
      assert.equal((await http('/api/tasks', tokens[role])).items.find(item => item.id === task.id)?.status, 'cancelled'); checks++;
      await http('/api/tasks/' + task.id, tokens.foreign, 'PATCH', { status: 'done' }, 404);
      assert.ok(!(await http('/api/tasks', tokens.foreign)).items.some(item => item.id === task.id)); checks++;
      await http('/api/tasks/' + task.id, tokens.owner, 'PATCH', { status: 'open' });
      await http('/api/tasks/' + task.id, tokens.manager, 'DELETE');
    }
    console.log(`STAFF TASK HTTP POSTGRES QA: PASS (${checks - httpStartCount} checks; actual login/session/RBAC/API/DB/fresh GET for bartender and hookah master)`);
  } catch (error) {
    throw new Error(guards.safeText(error.message, config));
  } finally {
    if (app && app.exitCode === null) { const closed = new Promise(resolve => app.once('exit', resolve)); app.kill(); await closed; }
    if (db) await db.end();
    try {
      if (created) { guard(); assert.match(database, /^tasks_qa_[a-f0-9]{16}$/); await admin.query(`DROP DATABASE "${database}"`); assert.equal((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [database])).rowCount, 0); }
    } finally { await admin.end(); }
    console.log('STAFF TASK HTTP QA CLEANUP: PASS (owned server stopped, fresh database removed)');
  }
}
