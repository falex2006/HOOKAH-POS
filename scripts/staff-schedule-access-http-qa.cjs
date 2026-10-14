'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { config, folder, options } = require('./staff-schedule-local-config.cjs');
const { Client } = require('pg');
async function main() {
  const c = config(), f = JSON.parse(fs.readFileSync(path.join(folder, 'fixtures.json'), 'utf8'));
  const base = `http://127.0.0.1:${c.appPort}`;
  const db = new Client(options(c));
  await db.connect();
  let expectedEmployeeIds;
  try { expectedEmployeeIds = new Set((await db.query('SELECT id FROM users WHERE venue_id=$1', [f.venues[0]])).rows.map(x => x.id)); }
  finally { await db.end(); }
  async function request(route, token, method = 'GET', input) {
    const res = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: input === undefined ? undefined : JSON.stringify(input) });
    return { status: res.status, value: await res.json() };
  }
  async function login(i) {
    const result = await request('/api/login', null, 'POST', { username: f.users[i].login, password: f.password });
    assert.equal(result.status, 200); return result.value.token;
  }
  const owner = await login(0), manager = await login(2), foreign = await login(4);
  const prefix = '/api/staff/schedule';
  assert.equal((await request(prefix + '/employees')).status, 401);
  const grants = await request(prefix + '/grants', owner);
  assert.equal(grants.status, 200);
  let version = grants.value.items.find(x => x.userId === f.users[2].id).version;
  async function grant(access) {
    const r = await request(prefix + '/grants', owner, 'PUT', { userId: f.users[2].id, access, version });
    assert.equal(r.status, 200); version = r.value.version;
  }
  await grant('none');
  assert.equal((await request(prefix + '?from=2026-10-12&to=2026-10-18', manager)).status, 403);
  assert.equal((await request(prefix + '/employees', manager)).status, 403);
  assert.equal((await request(prefix + '/grants', manager, 'PUT', { userId: f.users[2].id, access: 'manage', version })).status, 403);
  assert.equal((await request(prefix + '/grants', foreign, 'PUT', { userId: f.users[2].id, access: 'manage', version })).status, 404);
  await grant('view');
  const employees = await request(prefix + '/employees', manager);
  assert.equal(employees.status, 200);
  for (const row of employees.value.items) {
    assert.deepEqual(Object.keys(row).sort(), ['active', 'id', 'name', 'role']);
    assert.ok(expectedEmployeeIds.has(row.id));
  }
  assert.equal((await request(prefix, manager, 'POST', {})).status, 403);
  await grant('manage');
  assert.equal((await request(prefix + '/access', manager)).value.manage, true);
  await grant('none');
  assert.equal((await request(prefix + '/employees', manager)).status, 403);
  console.log('SCHEDULE HTTP ACCESS: PASS grant/view/manage/revoke on same token, minimal employee DTO, unauthorized/self-grant/foreign tenant denied.');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
