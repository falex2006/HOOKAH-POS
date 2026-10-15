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
const key = () => randomUUID();

async function main() {
  const c = config();
  const fixtures = JSON.parse(fs.readFileSync(path.join(folder, 'fixtures.json'), 'utf8'));
  assert.equal(fixtures.database, c.database);
  const pool = new Pool(options(c));
  let child, checks = 0;
  const eq = (actual, expected, label) => { assert.deepEqual(actual, expected, label); checks++; };
  try {
    const identity = (await pool.query('SELECT current_database() AS database,current_user AS username')).rows[0];
    eq(identity, { database: c.database, username: c.dbUser }, 'dedicated PostgreSQL identity');
    const migrations = await pool.query("SELECT name FROM schedule_qa_migrations WHERE name IN ('104_staff_schedule_foundation.sql','105_staff_schedule_binding_versions.sql')");
    eq(migrations.rowCount, 2, 'binding migrations applied');
    const ownerId = fixtures.users[0].id;
    const ownerRow = (await pool.query('SELECT venue_id,organization_id,role FROM users WHERE id=$1', [ownerId])).rows[0];
    eq(ownerRow, { venue_id: fixtures.venues[0], organization_id: fixtures.organizations[0], role: 'owner' }, 'synthetic owner');
    const manager = { id: key(), login: `binding-manager-${key()}@example.test`, role: 'manager' };
    const employee = { id: key(), login: `binding-employee-${key()}@example.test`, role: 'bartender' };
    const foreign = { id: key(), login: `binding-foreign-${key()}@example.test`, role: 'bartender' };
    for (const [person, tenant] of [[manager, 0], [employee, 0], [foreign, 1]]) {
      await pool.query(`INSERT INTO users(id,venue_id,organization_id,full_name,login,password_hash,role)
        SELECT $1,$2,$3,'Bindings HTTP QA',$4,password_hash,$5 FROM users WHERE id=$6`,
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
      cwd: root, env: { ...isolatedEnvironment(c, fixtures), PORT: String(port) }, stdio: 'ignore', windowsHide: true
    });
    let spawnError;
    child.once('error', error => { spawnError = error; });
    const base = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null) throw new Error('Isolated bindings QA server exited');
      try { if ((await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(500) })).ok) { ready = true; break; } } catch {}
      await sleep(100);
    }
    assert.ok(ready, 'ephemeral loopback server ready'); checks++;
    async function loginAs(username) {
      const response = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password: fixtures.password }) });
      eq(response.status, 200, 'synthetic login');
      return (await response.json()).token;
    }
    async function request(user, suffix, method = 'GET', body) {
      const response = await fetch(`${base}/api/staff/schedule${suffix}`, {
        method, headers: { 'Content-Type': 'application/json', ...(user ? { Authorization: `Bearer ${user.token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      return { status: response.status, value: await response.json() };
    }
    const owner = { token: await loginAs(fixtures.users[0].login) };
    manager.token = await loginAs(manager.login);
    const bindings = '/template-bindings';
    const suggestion = id => `/template-suggestions?employeeId=${id}`;
    eq((await request(null, bindings)).status, 401, 'anonymous binding read');
    eq((await request(manager, bindings)).status, 403, 'manager without grant');
    eq((await request(manager, suggestion(employee.id))).status, 403, 'manager without schedule grant');
    eq((await request(owner, bindings)).status, 200, 'owner settings read');
    eq((await request(owner, '/grants', 'PUT', { userId: manager.id, access: 'manage', version: 0, canManageSettings: false })).status, 200, 'owner grants manage only');
    eq((await request(manager, bindings)).status, 403, 'manager settings read denied');
    eq((await request(manager, suggestion(employee.id))).status, 200, 'manager can request suggestions');
    eq((await request(owner, '/grants', 'PUT', { userId: manager.id, access: 'manage', version: 1, canManageSettings: true })).status, 200, 'owner grants settings');
    eq((await request(manager, bindings)).status, 200, 'manager settings read');
    async function template(name) {
      const response = await request(manager, '/templates', 'POST', { name: `Bindings QA ${name} ${key().slice(0, 8)}`,
        definition: { schemaVersion: 2, mode: 'selected', pattern: { type: 'weekdays', weekdays: [1, 2, 3, 4, 5, 6, 7] },
          slots: [{ kind: 'shift', startTime: '10:00', endTime: '18:00', endDayOffset: 0, breakMinutes: 0 }] }, requestKey: key() });
      eq(response.status, 201, `create ${name} template`); return response.value;
    }
    const morning = await template('morning'), evening = await template('evening'), personal = await template('personal');
    const input = (templateId, targetKind, target, priority = 100) => ({ templateId, targetKind,
      ...(targetKind === 'employee' ? { targetUserId: target } : { targetRoleKey: target }), priority, active: true, version: 0, requestKey: key() });
    const systemPayload = input(morning.id, 'crm_role', 'system:bartender');
    const system = await request(manager, bindings, 'POST', systemPayload);
    eq(system.status, 201, 'system role binding create'); eq(system.value.version, 1, 'initial binding version');
    eq((await request(manager, bindings, 'POST', systemPayload)).value, system.value, 'idempotent replay');
    const reused = await request(manager, bindings, 'POST', { ...systemPayload, priority: 99 });
    eq(reused.status, 409, 'key reuse rejected'); eq(reused.value.error, 'schedule_request_conflict', 'key reuse code');
    eq((await request(manager, bindings, 'POST', input(evening.id, 'employee', foreign.id))).status, 404, 'cross tenant target denied');
    eq((await request(manager, suggestion(foreign.id))).status, 404, 'cross tenant suggestion denied');
    const systemSuggestion = await request(manager, suggestion(employee.id));
    eq(systemSuggestion.status, 200, 'system suggestion'); eq(systemSuggestion.value.selection.templateId, morning.id, 'system role selected');
    const customRole = await pool.query(`INSERT INTO custom_staff_roles(venue_id,organization_id,name,is_active)
      VALUES($1,$2,$3,true) RETURNING id`, [fixtures.venues[0], fixtures.organizations[0], `Bindings QA ${key().slice(0, 8)}`]);
    const customId = customRole.rows[0].id;
    await pool.query('UPDATE users SET custom_role_id=$1 WHERE id=$2', [customId, employee.id]);
    const custom = await request(manager, bindings, 'POST', input(evening.id, 'crm_role', `custom:${customId}`));
    eq(custom.status, 201, 'custom role binding create');
    const ambiguous = await request(manager, suggestion(employee.id));
    eq(ambiguous.status, 200, 'ambiguous suggestion'); eq(ambiguous.value.requiresChoice, true, 'human choice required');
    eq(new Set(ambiguous.value.choices.map(item => item.templateId)), new Set([morning.id, evening.id]), 'both role choices');
    const explicit = await request(manager, `${suggestion(employee.id)}&explicitTemplateId=${evening.id}`);
    eq(explicit.value.selection.templateId, evening.id, 'explicit choice wins');
    const defaultSaved = await request(manager, `/employees/${employee.id}/defaults`, 'PUT', { templateId: personal.id, version: 0, requestKey: key() });
    eq(defaultSaved.status, 200, 'personal default created');
    const preferred = await request(manager, suggestion(employee.id));
    eq(preferred.value.source, 'employee_default', 'personal default precedence');
    eq(preferred.value.selection.templateId, personal.id, 'personal default selected');
    const employeeBinding = await request(manager, bindings, 'POST', input(evening.id, 'employee', employee.id));
    eq(employeeBinding.status, 201, 'employee binding create');
    eq((await request(manager, suggestion(employee.id))).value.selection.templateId, personal.id, 'default beats employee binding');
    const stale = await request(manager, `${bindings}/${system.value.id}`, 'PATCH', { ...systemPayload, version: 99, requestKey: key() });
    eq(stale.status, 409, 'stale version rejected'); eq(stale.value.error, 'schedule_binding_version_conflict', 'version conflict code');
    const archived = await request(manager, `${bindings}/${system.value.id}`, 'PATCH', { ...systemPayload, version: 1, active: false, requestKey: key() });
    eq(archived.status, 200, 'binding deactivated'); eq(archived.value.version, 2, 'binding revision advanced');
    const visible = await request(manager, bindings);
    eq(visible.status, 200, 'binding list');
    eq(visible.value.items.some(item => item.id === system.value.id), false, 'inactive hidden by default');
    const all = await request(manager, `${bindings}?includeInactive=true`);
    eq(all.value.items.find(item => item.id === system.value.id).active, false, 'inactive readback');
    const database = await pool.query('SELECT version,active,target_role_key FROM staff_schedule_template_bindings WHERE venue_id=$1 AND id=$2', [fixtures.venues[0], system.value.id]);
    eq(database.rows[0], { version: 2, active: false, target_role_key: 'system:bartender' }, 'PostgreSQL readback');
    const audit = await pool.query(`SELECT actor_id,action,before_data,after_data FROM staff_schedule_config_events
      WHERE venue_id=$1 AND entity_type='template_binding' AND entity_id=$2 ORDER BY id`, [fixtures.venues[0], system.value.id]);
    eq(audit.rowCount, 2, 'create/update audit, replay did not duplicate');
    eq(audit.rows.every(row => row.actor_id === manager.id), true, 'audited manager');
    eq(audit.rows.map(row => row.action), ['create', 'update'], 'audit actions');
    eq(audit.rows[1].before_data.version, 1, 'audited prior version');
    eq(audit.rows[1].after_data.version, 2, 'audited new version');
    const templateArchived = await request(owner, `/templates/${morning.id}`, 'PATCH', { version: 1, archived: true, requestKey: key() });
    eq(templateArchived.status, 200, 'template archived');
    eq(templateArchived.value.archived, true, 'template archive persisted');
    const archivedVisible = await request(manager, `${bindings}?includeInactive=true`);
    eq(archivedVisible.value.items.some(item => item.id === system.value.id), false, 'archived template binding hidden');
    const archivedAll = await request(manager, `${bindings}?includeInactive=true&includeArchived=true`);
    eq(archivedAll.value.items.find(item => item.id === system.value.id).templateArchived, true, 'archived template admin readback');
    const archivedSuggestion = await request(manager, suggestion(employee.id));
    eq(archivedSuggestion.value.selection.templateId, personal.id, 'archived template excluded from suggestion');
    eq((await request(owner, '/grants', 'PUT', { userId: manager.id, access: 'none', version: 2 })).status, 200, 'owner revokes grant');
    eq((await request(manager, bindings)).status, 403, 'read denied after revocation');
    eq((await request(manager, bindings, 'POST', input(morning.id, 'employee', employee.id))).status, 403, 'write denied after revocation');
    console.log(`BINDINGS HTTP PASS ${checks}: isolated ${c.database}; grants, roles, choices, defaults, version, replay, tenant, audit`);
  } finally {
    if (child && child.exitCode === null) {
      child.kill();
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), sleep(3000)]);
    }
    await pool.end();
  }
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
