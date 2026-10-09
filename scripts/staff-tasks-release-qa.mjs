import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
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
