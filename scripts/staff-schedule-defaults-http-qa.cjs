'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { config, folder, options } = require('./staff-schedule-local-config.cjs');
const { isolatedEnvironment } = require('./staff-schedule-local-env.cjs');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  // config() checks the fixed local Docker endpoint, container/volume identity and loopback binding.
  const c = config();
  const fixtures = JSON.parse(fs.readFileSync(path.join(folder, 'fixtures.json'), 'utf8'));
  assert.equal(fixtures.database, c.database);
  const pool = new Pool(options(c));
  let child;
  let checks = 0;
  const eq = (actual, expected, label) => {
    assert.deepEqual(actual, expected, label);
    checks++;
  };
  const key = () => randomUUID();
  try {
    // A second identity check is performed by PostgreSQL before any fixture write.
    const identity = (await pool.query('SELECT current_database() AS database, current_user AS username')).rows[0];
    eq(identity.database, c.database, 'dedicated QA database');
    eq(identity.username, c.dbUser, 'dedicated QA database role');
    const ownerId = fixtures.users[0].id;
    const ownerRow = await pool.query('SELECT venue_id,organization_id,role FROM users WHERE id=$1', [ownerId]);
    eq(ownerRow.rows[0], { venue_id: fixtures.venues[0], organization_id: fixtures.organizations[0], role: 'owner' }, 'synthetic owner identity');
    const migration = await pool.query("SELECT name FROM schedule_qa_migrations WHERE name='104_staff_schedule_foundation.sql'");
    eq(migration.rowCount, 1, 'defaults migration applied to QA database');

    const manager = { id: key(), login: `defaults-manager-${key()}@example.test`, role: 'manager' };
    const employee = { id: key(), login: `defaults-employee-${key()}@example.test`, role: 'bartender' };
    const foreignEmployee = { id: key(), login: `defaults-foreign-${key()}@example.test`, role: 'bartender' };
    for (const [person, tenant] of [[manager, 0], [employee, 0], [foreignEmployee, 1]]) {
      await pool.query(`INSERT INTO users(id,venue_id,organization_id,full_name,login,password_hash,role)
        SELECT $1,$2,$3,'Defaults HTTP QA',$4,password_hash,$5 FROM users WHERE id=$6`,
      [person.id, fixtures.venues[tenant], fixtures.organizations[tenant], person.login, person.role, ownerId]);
      await pool.query(`INSERT INTO organization_memberships(organization_id,user_id,membership_role,status,is_primary)
        VALUES($1,$2,'member','active',false)`, [fixtures.organizations[tenant], person.id]);
    }

    const probe = net.createServer();
    await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
    const port = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    const root = path.join(__dirname, '..');
    child = spawn(process.execPath, [path.join(root, 'server.js')], {
      cwd: root, env: { ...isolatedEnvironment(c, fixtures), PORT: String(port) },
      stdio: 'ignore', windowsHide: true
    });
    let spawnError;
    child.once('error', error => { spawnError = error; });
    const base = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null) throw new Error('Isolated defaults QA server exited');
      try {
        if ((await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(500) })).ok) { ready = true; break; }
      } catch { /* server still starting */ }
      await sleep(100);
    }
    assert.ok(ready, 'isolated defaults QA server readiness');
    checks++;

    async function loginAs(username) {
      const response = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password: fixtures.password }) });
      eq(response.status, 200, `login ${username}`);
      return (await response.json()).token;
    }
    async function request(user, suffix, method = 'GET', body) {
      const response = await fetch(`${base}/api/staff/schedule${suffix}`, {
        method, headers: { 'Content-Type': 'application/json', ...(user ? { Authorization: `Bearer ${user.token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      return { status: response.status, value: await response.json() };
    }
    const owner = { id: ownerId, token: await loginAs(fixtures.users[0].login) };
    manager.token = await loginAs(manager.login);
    const target = `/employees/${employee.id}/defaults`;
    const foreignTarget = `/employees/${foreignEmployee.id}/defaults`;
    const timeInput = { functionId: null, startTime: '10:00', endTime: '18:00', breakMinutes: 30, version: 0, requestKey: key() };

    eq((await request(null, target)).status, 401, 'unauthenticated read');
    eq((await request(manager, target)).status, 403, 'manager read before grant');
    eq((await request(manager, target, 'PUT', timeInput)).status, 403, 'manager write before grant');
    const empty = await request(owner, target);
    eq(empty.status, 200, 'owner empty read');
    eq(empty.value, { userId: employee.id, items: [] }, 'new employee has no defaults');
    const limitedGrant = await request(owner, '/grants', 'PUT', { userId: manager.id, access: 'manage', version: 0, canManageSettings: false });
    eq(limitedGrant.status, 200, 'owner grants schedule management');
    eq(limitedGrant.value.canManageSettings, false, 'settings remain separately denied');
    eq((await request(manager, target)).status, 200, 'manager can read after manage grant');
    const settingsDenied = await request(manager, target, 'PUT', timeInput);
    eq(settingsDenied.status, 403, 'manage grant does not imply settings');
    eq(settingsDenied.value.error, 'schedule_settings_forbidden', 'settings denial code');
    const settingsGrant = await request(owner, '/grants', 'PUT', { userId: manager.id, access: 'manage', version: 1, canManageSettings: true });
    eq(settingsGrant.status, 200, 'owner grants settings');
    eq(settingsGrant.value.canManageSettings, true, 'settings granted');

    // A selected-person template supplies a single unambiguous shift.
    const template = await request(manager, '/templates', 'POST', {
      name: `Defaults QA ${key().slice(0, 8)}`,
      definition: { schemaVersion: 2, mode: 'selected', pattern: { type: 'weekdays', weekdays: [1, 2, 3, 4, 5, 6, 7] },
        slots: [{ kind: 'shift', startTime: '18:00', endTime: '02:00', endDayOffset: 1, breakMinutes: 20 }] },
      requestKey: key()
    });
    eq(template.status, 201, 'create template for template-only default');
    const workFunction = await request(manager, '/functions', 'POST', { name: `Defaults QA function ${key().slice(0, 8)}`, requestKey: key() });
    eq(workFunction.status, 201, 'create work function');
    const qualification = await request(manager, `/employees/${employee.id}/functions`, 'PUT', {
      version: 0, functionIds: [workFunction.value.id], primaryFunctionId: workFunction.value.id, requestKey: key()
    });
    eq(qualification.status, 200, 'qualify synthetic employee');

    // The null-function entry uses template time; the function-specific entry uses explicit time.
    const templateInput = { templateId: template.value.id, version: 0, requestKey: key() };
    const templateDefault = await request(manager, target, 'PUT', templateInput);
    eq(templateDefault.status, 200, 'save template-only default');
    eq(templateDefault.value.templateId, template.value.id, 'template reference persisted');
    eq(templateDefault.value.startTime, null, 'template time inherited');
    eq(templateDefault.value.version, 1, 'template default version');
    const timed = { ...timeInput, functionId: workFunction.value.id, requestKey: key() };
    const timedDefault = await request(manager, target, 'PUT', timed);
    eq(timedDefault.status, 200, 'save explicit-time default');
    eq(timedDefault.value.functionId, workFunction.value.id, 'function reference persisted');
    eq(timedDefault.value.startTime, '10:00', 'explicit start persisted');
    eq(timedDefault.value.endTime, '18:00', 'explicit end persisted');
    eq(timedDefault.value.breakMinutes, 30, 'explicit break persisted');

    const replay = await request(manager, target, 'PUT', timed);
    eq(replay.status, 200, 'idempotent replay status');
    eq(replay.value, timedDefault.value, 'idempotent replay response');
    const collision = await request(manager, target, 'PUT', { ...timed, endTime: '19:00' });
    eq(collision.status, 409, 'request key collision status');
    eq(collision.value.error, 'schedule_request_conflict', 'request key collision code');
    const stale = await request(manager, target, 'PUT', { ...timed, version: 0, requestKey: key() });
    eq(stale.status, 409, 'stale version status');
    eq(stale.value.error, 'schedule_default_version_conflict', 'stale version code');
    const updated = await request(manager, target, 'PUT', { ...timed, version: 1, startTime: '11:00', requestKey: key() });
    eq(updated.status, 200, 'versioned update status');
    eq(updated.value.version, 2, 'versioned update increments version');
    eq(updated.value.startTime, '11:00', 'versioned update persisted');

    eq((await request(owner, foreignTarget)).status, 404, 'foreign employee read denied');
    eq((await request(manager, foreignTarget, 'PUT', { ...timeInput, requestKey: key() })).status, 404, 'foreign employee write denied');
    const readback = await request(manager, target);
    eq(readback.status, 200, 'manager readback');
    eq(readback.value.items.length, 2, 'both defaults returned');
    eq(readback.value.items.find(item => item.functionId === null), templateDefault.value, 'template default readback');
    eq(readback.value.items.find(item => item.functionId === workFunction.value.id), updated.value, 'time default readback');
    const databaseRows = await pool.query(`SELECT id,version,function_id,template_id,to_char(start_time,'HH24:MI') AS start_time
      FROM staff_schedule_employee_defaults WHERE venue_id=$1 AND user_id=$2 ORDER BY function_id NULLS FIRST`,
    [fixtures.venues[0], employee.id]);
    eq(databaseRows.rowCount, 2, 'two rows in isolated PostgreSQL');
    eq(databaseRows.rows.find(row => row.function_id === null).template_id, template.value.id, 'template persisted in PostgreSQL');
    eq(databaseRows.rows.find(row => row.function_id === workFunction.value.id).start_time, '11:00', 'time persisted in PostgreSQL');
    const events = await pool.query(`SELECT actor_id,entity_id,action,before_data,after_data FROM staff_schedule_config_events
      WHERE venue_id=$1 AND entity_type='employee_default' AND entity_id=ANY($2::uuid[]) ORDER BY id`,
    [fixtures.venues[0], [templateDefault.value.id, timedDefault.value.id]]);
    eq(events.rowCount, 3, 'create/create/update audit without duplicate replay');
    eq(events.rows.map(row => row.action), ['create', 'create', 'update'], 'audit action sequence');
    eq(events.rows.every(row => row.actor_id === manager.id), true, 'audited actor');
    eq(events.rows[0].before_data, null, 'create audit before state');
    eq(events.rows[2].before_data.version, 1, 'update audit previous version');
    eq(events.rows[2].after_data.version, 2, 'update audit resulting version');

    const revoked = await request(owner, '/grants', 'PUT', { userId: manager.id, access: 'none', version: 2 });
    eq(revoked.status, 200, 'owner revokes grant');
    eq(revoked.value.canManageSettings, false, 'settings permission revoked');
    eq((await request(manager, target)).status, 403, 'manager read denied after revoke');
    eq((await request(manager, target, 'PUT', { ...timed, version: 2, requestKey: key() })).status, 403, 'manager write denied after revoke');
    eq((await request(owner, target)).value.items.length, 2, 'owner can still read defaults');
    console.log(`DEFAULTS HTTP PASS ${checks}: dedicated ${c.database}; grant/revoke, version, replay, collision, tenant, template/time, PostgreSQL readback and audit`);
  } finally {
    if (child && child.exitCode === null) {
      child.kill();
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), sleep(3000)]);
    }
    await pool.end();
  }
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
