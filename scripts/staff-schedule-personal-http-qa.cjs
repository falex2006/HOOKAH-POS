'use strict';
// Opt-in real HTTP + guarded schedule QA PostgreSQL. No browser or shared preview.
// Only UUID-owned fixtures are mutated; cleanup is verified, including on failure.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { config, folder, options } = require('./staff-schedule-local-config.cjs');
const { isolatedEnvironment } = require('./staff-schedule-local-env.cjs');
const root = path.resolve(__dirname, '..');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
  assert.ok(process.argv.includes('--run'), 'Opt-in required: node scripts/staff-schedule-personal-http-qa.cjs --run');
  const c = config(); // Exact container/image/volume/loopback identity guard, never .env.
  const f = JSON.parse(fs.readFileSync(path.join(folder, 'fixtures.json'), 'utf8'));
  assert.equal(f.database, c.database);
  const pool = new Pool(options(c));
  const users = [], records = [], functions = [], logs = [];
  let child, identityVerified = false, failure;
  let checks = 0;
  const pass = name => { checks++; console.log(`PASS ${name}`); };
  try {
    const identity = (await pool.query('SELECT current_database() AS database,current_user AS username')).rows[0];
    assert.deepEqual(identity, { database: c.database, username: c.dbUser });
    identityVerified = true;
    for (const [index, role] of ['bartender', 'hookah_master', 'bartender'].entries()) {
      const tenant = index === 2 ? 1 : 0;
      const user = { id: randomUUID(), login: `personal-http-${randomUUID()}@example.test`, tenant, role };
      users.push(user);
      const inserted = await pool.query(`INSERT INTO users(id,venue_id,organization_id,full_name,login,password_hash,role)
        SELECT $1,$2,$3,$4,$5,password_hash,$6 FROM users WHERE id=$7`,
      [user.id, f.venues[tenant], f.organizations[tenant], `Personal HTTP ${role}`, user.login, role, f.users[0].id]);
      assert.equal(inserted.rowCount, 1);
      await pool.query(`INSERT INTO organization_memberships(organization_id,user_id,membership_role,status,is_primary)
        VALUES($1,$2,'member','active',false)`, [f.organizations[tenant], user.id]);
    }
    const fn = randomUUID(); functions.push(fn);
    await pool.query(`INSERT INTO staff_schedule_functions(id,venue_id,name,created_by) VALUES($1,$2,$3,$4)`,
      [fn, f.venues[0], `Personal HTTP ${fn}`, users[0].id]);
    const zone = (await pool.query('SELECT timezone FROM venues WHERE id=$1', [f.venues[0]])).rows[0].timezone;
    async function entry(user, date, kind = 'shift', status = 'planned', start = '09:00', end = '15:00', endDate = date) {
      const id = randomUUID(); records.push(id);
      const timed = kind === 'shift' || kind === 'open_shift';
      await pool.query(`INSERT INTO staff_schedules(id,venue_id,user_id,work_date,kind,status,planned_start,planned_end,
          break_minutes,note,cancel_reason,created_by,function_id)
        VALUES($1,$2,$3,$4,$5,$6,$7::timestamp AT TIME ZONE $9,$8::timestamp AT TIME ZONE $9,
          $10,'PRIVATE_MEDICAL_NOTE','PRIVATE_CANCEL_REASON',$11,$12)`,
      [id, f.venues[user.tenant], kind === 'open_shift' ? null : user.id, date, kind, status,
        timed ? `${date}T${start}` : null, timed ? `${endDate}T${end}` : null, zone,
        timed ? 15 : 0, user.id, user.tenant === 0 ? fn : null]);
      return id;
    }
    const own = await entry(users[0], '2032-01-10');
    const illness = await entry(users[0], '2032-01-11', 'sick');
    const carry = await entry(users[0], '2032-01-09', 'shift', 'planned', '22:00', '06:00', '2032-01-10');
    const peer = await entry(users[1], '2032-01-10');
    const peerCarry = await entry(users[1], '2032-01-09', 'shift', 'planned', '22:00', '06:00', '2032-01-10');
    const peerIllness = await entry(users[1], '2032-01-11', 'sick');
    const hidden = [await entry(users[0], '2032-01-12', 'shift', 'cancelled'),
      await entry(users[1], '2032-01-12', 'shift', 'cancelled'),
      await entry(users[0], '2032-01-12', 'open_shift'),
      await entry(users[2], '2032-01-10'),
      await entry(users[0], '2032-01-09', 'shift', 'planned', '18:00', '00:00', '2032-01-10')];
    const log = randomUUID(); logs.push(log);
    await pool.query(`INSERT INTO staff_work_logs(id,venue_id,user_id,started_at,ended_at,note)
      VALUES($1,$2,$3,'2032-01-10T09:00Z','2032-01-10T15:00Z','PRIVATE_ACTUAL_LOG')`, [log, f.venues[0], users[1].id]);
    await pool.query(`INSERT INTO staff_schedule_events(venue_id,schedule_id,actor_id,after_data,reason)
      VALUES($1,$2,$3,'{}','PRIVATE_AUDIT_REASON')`, [f.venues[0], own, users[0].id]);
    const probe = net.createServer();
    await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
    const port = probe.address().port;
    await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
    assert.ok(![31944, 31945].includes(port), 'Never use shared preview ports');
    child = spawn(process.execPath, [path.join(root, 'server.js')], {
      cwd: root, env: { ...isolatedEnvironment(c, f), PORT: String(port) }, stdio: 'ignore', windowsHide: true
    });
    let spawnError; child.once('error', error => { spawnError = error; });
    const base = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let i = 0; i < 150; i++) {
      if (spawnError) throw spawnError;
      assert.equal(child.exitCode, null, 'Fresh child exited before readiness');
      try { if ((await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(500) })).ok) { ready = true; break; } } catch {}
      await delay(100);
    }
    assert.ok(ready, 'Fresh child readiness');
    async function request(route, token, method = 'GET', body) {
      const response = await fetch(base + route, { method, signal: AbortSignal.timeout(5000),
        headers: { 'Content-Type': 'application/json', Origin: base, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json() };
    }
    for (const user of users) {
      const login = await request('/api/login', null, 'POST', { username: user.login, password: f.password });
      assert.equal(login.status, 200, `Login ${user.role}`); user.token = login.body.token;
      assert.ok(user.token);
    }
    const prefix = '/api/staff/schedule', range = '?from=2032-01-10&to=2032-01-12';
    assert.equal((await request(prefix + '/personal' + range)).status, 401);
    for (const user of users.slice(0, 2)) {
      const access = await request(prefix + '/access', user.token);
      assert.equal(access.status, 200);
      assert.equal(access.body.self, true); assert.equal(access.body.view, false); assert.equal(access.body.manage, false);
      const session = await request('/api/session', user.token);
      assert.equal(session.status, 200);
      assert.ok(session.body.permissions.includes('staff_schedule_self'));
      assert.ok(!session.body.permissions.includes('staff_schedule_view'));
      assert.ok(!session.body.permissions.includes('staff_schedule_manage'));
      const result = await request(prefix + '/personal' + range + `&userId=${users[2].id}&venueId=${f.venues[1]}`, user.token);
      assert.equal(result.status, 200, 'Personal endpoint must be ready');
      const body = result.body;
      assert.deepEqual(Object.keys(body).sort(), ['from','items','selfUserId','team','timezone','to'].sort());
      assert.equal(body.selfUserId, user.id); assert.equal(body.timezone, zone);
      assert.equal(body.from, '2032-01-10'); assert.equal(body.to, '2032-01-12');
      assert.ok(body.items.every(row => row.userId === user.id));
      const expectedOwn = user === users[0] ? [own, illness, carry] : [peer, peerCarry, peerIllness];
      assert.deepEqual(body.items.map(row => row.id).sort(), expectedOwn.sort());
      const expectedTeam = user === users[0] ? [peer, peerCarry] : [own, carry];
      assert.deepEqual(body.team.filter(row => users.some(u => u.id === row.userId)).map(row => row.id).sort(), expectedTeam.sort());
      assert.ok(body.team.every(row => row.userId !== user.id));
      const common = ['id','userId','userName','workDate','plannedStart','plannedEnd','functionName'];
      for (const row of body.team) assert.deepEqual(Object.keys(row).sort(), common.slice().sort());
      for (const row of body.items) assert.deepEqual(Object.keys(row).sort(), [...common,'kind','breakMinutes'].sort());
      assert.ok(body.items.some(row => row.kind === 'sick'));
      assert.ok(body.items.some(row => row.kind === 'shift' && row.breakMinutes === 15));
      assert.doesNotMatch(JSON.stringify(body), /PRIVATE_|cancelReason|"note"|"history"|"actual"/);
      for (const id of hidden) assert.ok(!JSON.stringify(body).includes(id));
      for (const suffix of ['', '/employees', '/grants', `/${own}`, `/${own}/history`, '/drafts', '/templates', '/series', '/functions', '/demand-rules'])
        assert.equal((await request(prefix + suffix, user.token)).status, 403, `${user.role} GET ${suffix}`);
      for (const [suffix, method] of [['','POST'], [`/${own}`,'PATCH'], ['/drafts','POST'], ['/copy/apply','POST'], ['/grants','PUT']])
        assert.equal((await request(prefix + suffix, user.token, method, {})).status, 403, `${method} ${suffix}`);
      for (const method of ['POST','PATCH','PUT','DELETE'])
        assert.equal((await request(prefix + '/personal', user.token, method, {})).status, 405);
      pass(`${user.role}: self/session permissions, DTO privacy, night carry, scope spoofing and management denials`);
    }
    const foreign = await request(prefix + '/personal' + range, users[2].token);
    assert.equal(foreign.status, 200);
    assert.ok(![...foreign.body.items,...foreign.body.team].some(row => [users[0].id, users[1].id].includes(row.userId)));
    pass('reverse tenant isolation');
    for (const query of ['from=invalid&to=2032-01-12', 'from=2032-02-30&to=2032-03-01',
      'from=2032-01-12&to=2032-01-10', 'from=2032-01-01&to=2032-04-03'])
      assert.equal((await request(prefix + '/personal?' + query, users[0].token)).status, 400, query);
    for (const query of ['from=2032-01-10&to=2032-01-10', 'from=2032-01-01&to=2032-04-02'])
      assert.equal((await request(prefix + '/personal?' + query, users[0].token)).status, 200, query);
    pass('1/93-day boundaries and invalid/94-day range rejection');
    await pool.query('UPDATE users SET is_active=false WHERE id=$1', [users[0].id]);
    for (const route of [prefix + '/personal' + range, prefix + '/access']) {
      const denied = await request(route, users[0].token);
      assert.ok([401,403].includes(denied.status), 'Inactive stale session must not read schedule');
    }
    const staleSession = await request('/api/session', users[0].token);
    if (staleSession.status === 200) assert.ok(!staleSession.body.permissions.includes('staff_schedule_self'));
    else assert.ok([401,403].includes(staleSession.status));
    pass('inactive user with stale token denied');
  } catch (error) { failure = error; }
  finally {
    const cleanupErrors = [];
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      const stopped = new Promise(resolve => child.once('close', resolve));
      if (process.platform === 'win32') {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', error => cleanupErrors.push(error));
      } else child.kill('SIGTERM');
      await Promise.race([stopped, delay(5000)]);
      if (child.exitCode === null && child.signalCode === null) cleanupErrors.push(new Error('Child termination not confirmed'));
    }
    if (identityVerified) {
      for (const [sql, ids] of [
        ['DELETE FROM staff_schedule_events WHERE schedule_id=ANY($1::uuid[])', records],
        ['DELETE FROM staff_schedules WHERE id=ANY($1::uuid[])', records],
        ['DELETE FROM staff_work_logs WHERE id=ANY($1::uuid[])', logs],
        ['DELETE FROM staff_schedule_functions WHERE id=ANY($1::uuid[])', functions],
        ['DELETE FROM users WHERE id=ANY($1::uuid[])', users.map(user => user.id)]
      ]) { try { await pool.query(sql, [ids]); } catch (error) { cleanupErrors.push(error); } }
      for (const [table, ids] of [['users', users.map(user => user.id)], ['staff_schedules', records], ['staff_work_logs', logs], ['staff_schedule_functions', functions]]) {
        try { assert.equal((await pool.query(`SELECT id FROM ${table} WHERE id=ANY($1::uuid[])`, [ids])).rowCount, 0, `Cleanup ${table}`); }
        catch (error) { cleanupErrors.push(error); }
      }
    }
    await pool.end();
    if (cleanupErrors.length) failure = new AggregateError([...(failure ? [failure] : []), ...cleanupErrors], 'HTTP QA or cleanup failed');
    else if (identityVerified) console.log('CLEANUP PASS: owned fixture rows removed; fresh child stopped.');
  }
  if (failure) throw failure;
  console.log(`PERSONAL SCHEDULE HTTP QA PASS (${checks} groups; fresh child + guarded PostgreSQL; no browser proof).`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
