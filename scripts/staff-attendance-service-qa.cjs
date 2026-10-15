'use strict';
// Real PostgreSQL, synthetic fixtures, exact guarded local container only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { Client, Pool } = require('pg');
const { config, options } = require('./staff-schedule-local-config.cjs');
const root = path.resolve(__dirname, '..');
const sources = ['staff-attendance-mutations.js', 'staff-attendance-service.js', 'staff-attendance-access.js', 'staff-attendance-domain.js'];
const sourceHashes = () => Object.fromEntries(sources.map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]));
const loadedHashes = sourceHashes();
const m = require('../staff-attendance-mutations');
const s = require('../staff-attendance-service');
const { resolveAttendanceAccess } = require('../staff-attendance-access');
const q = value => '"' + value.replace(/"/g, '""') + '"';
const key = () => ({ requestKey: randomUUID() });
const json = value => JSON.parse(JSON.stringify(value));
const deny = (promise, code) => assert.rejects(promise, error => error.code === code);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  const cfg = config();
  const name = `attendance_service_${Date.now()}_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
  assert.match(name, /^attendance_service_[0-9]+_[a-f0-9]{8}$/);
  assert.notEqual(name, cfg.database);
  const connection = { ...options(cfg), connectionTimeoutMillis: 10000, statement_timeout: 15000, lock_timeout: 10000 };
  const admin = new Client({ ...connection, database: 'postgres' });
  let created = false, db, pool;
  const results = [];
  const test = async (label, run) => {
    try { await run(); results.push({ label, result: 'PASS' }); }
    catch (error) { results.push({ label, result: 'FAIL', code: error.code || error.name, constraint: error.constraint || null }); }
  };
  await admin.connect();
  try {
    assert.equal((await admin.query('SELECT current_database() AS db')).rows[0].db, 'postgres');
    await admin.query(`CREATE DATABASE ${q(name)} TEMPLATE template0`); created = true;
    db = new Client({ ...connection, database: name }); await db.connect();
    assert.equal((await db.query('SELECT current_database() AS db')).rows[0].db, name);
    const files = ['schema.sql', ...fs.readdirSync(path.join(root, 'migrations')).filter(f => f.endsWith('.sql')).sort().map(f => `migrations/${f}`)];
    for (const file of files) {
      await db.query('BEGIN');
      try { await db.query(fs.readFileSync(path.join(root, file), 'utf8')); await db.query('COMMIT'); }
      catch (error) { await db.query('ROLLBACK'); throw error; }
    }
    pool = new Pool({ ...connection, database: name, max: 8 });
    const fixtures = [];
    for (let i = 0; i < 13; i++) {
      const org = randomUUID(), venue = randomUUID(), sibling = randomUUID();
      await db.query('INSERT INTO organizations(id,name,slug) VALUES($1,\'QA attendance\',$2)', [org, `qa-${org}`]);
      await db.query('INSERT INTO venues(id,name,organization_id,timezone) VALUES($1,\'QA\',$3,\'Asia/Yekaterinburg\'),($2,\'QA sibling\',$3,\'Asia/Yekaterinburg\')', [venue, sibling, org]);
      const f = { venue, sibling };
      for (const [label, role, home] of [['owner','owner',venue], ['employee','bartender',venue], ['manager','manager',venue], ['admin','admin',venue], ['siblingOwner','owner',sibling], ['second','hookah_master',venue]]) {
        const id = randomUUID();
        await db.query('INSERT INTO users(id,venue_id,organization_id,full_name,login,role) VALUES($1,$2,$3,$4,$5,$6)', [id, home, org, `QA ${label}`, `qa-${id}`, role]);
        f[label] = { userId: id, venueId: home };
      }
      fixtures.push(f);
    }
    // Schedule fixtures are established BEFORE the protected-table baseline.
    for (const [i, startMinutes, endMinutes] of [[1,30,120], [2,-30,60]]) {
      const f = fixtures[i];
      f.schedule = (await db.query(`INSERT INTO staff_schedules(venue_id,user_id,work_date,planned_start,planned_end,created_by)
        VALUES($1,$2,(clock_timestamp() AT TIME ZONE 'Asia/Yekaterinburg')::date,
          clock_timestamp()+$3*interval '1 minute',clock_timestamp()+$4*interval '1 minute',$5) RETURNING id`,
      [f.venue, f.employee.userId, startMinutes, endMinutes, f.owner.userId])).rows[0].id;
    }
    await db.query(`INSERT INTO staff_work_logs(venue_id,user_id,started_at,ended_at)
      VALUES($1,$2,'2035-01-01T10:00:00Z','2035-01-01T11:00:00Z')`, [fixtures[0].venue, fixtures[0].employee.userId]);
    const protectedTables = (await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename NOT LIKE 'staff_attendance_%' ORDER BY tablename")).rows.map(r => r.tablename);
    const snapshot = async () => {
      const result = {};
      for (const table of protectedTables) result[table] = (await db.query(`SELECT count(*)::text AS count,
        md5(coalesce(string_agg(h,'' ORDER BY h),'')) AS hash FROM (SELECT md5(row_to_json(t)::text) h FROM public.${q(table)} t) rows`)).rows[0];
      return result;
    };
    const baseline = await snapshot();
    const policy = (f, mode, preparationMinutes = 0, version = 0, actor = f.owner) => m.savePolicy(pool, actor, { ...key(), mode, preparationMinutes, version });
    const finish = (f, session) => m.end(pool, f.employee, { ...key(), id: session.id, version: session.version });
    const stored = async id => (await pool.query('SELECT * FROM staff_attendance_sessions WHERE id=$1', [id])).rows[0];

    await test('default free start/end; replay and key conflicts; server identity/time', async () => {
      const f = fixtures[0];
      assert.deepEqual(await s.readPolicy(pool, f.venue), { mode: 'free', preparationMinutes: 0, version: 0 });
      const input = key(), a = await m.start(pool, f.employee, input);
      assert.deepEqual(json(await m.start(pool, f.employee, input)), json(a));
      await deny(m.start(pool, f.employee, { ...input, reason: 'different' }), 'attendance_idempotency_conflict');
      await deny(m.end(pool, f.employee, { ...key(), id: a.id, version: 0 }), 'attendance_session_conflict');
      const close = { ...key(), id: a.id, version: a.version };
      const ended = await m.end(pool, f.employee, close);
      assert.deepEqual(json(await m.end(pool, f.employee, close)), json(ended));
      assert(new Date(ended.endedAt) >= new Date(a.startedAt));
      assert.equal((await stored(a.id)).user_id, f.employee.userId);
      assert.equal((await s.selfStatus(pool, f.employee)).session, null);
    });
    await test('early preparation admission and snapshots', async () => {
      const f = fixtures[1]; await policy(f, 'approval', 60);
      const a = await m.start(pool, f.employee, key()), row = await stored(a.id);
      assert.equal(row.basis, 'preparation'); assert.equal(row.schedule_id, f.schedule);
      assert.equal(row.policy_snapshot.preparationMinutes, 60); await finish(f, a);
    });
    await test('scheduled admission; running session remains finishable after policy changes', async () => {
      const f = fixtures[2]; await policy(f, 'approval');
      const a = await m.start(pool, f.employee, key()); assert.equal((await stored(a.id)).basis, 'scheduled');
      await policy(f, 'warn', 0, 1); assert.equal((await s.selfStatus(pool, f.employee)).admission, null); await finish(f, a);
    });
    await test('warn reason required and saved', async () => {
      const f = fixtures[3]; await policy(f, 'warn');
      await deny(m.start(pool, f.employee, key()), 'attendance_reason_required');
      const a = await m.start(pool, f.employee, { ...key(), reason: 'Подмена коллеги' });
      assert.equal((await stored(a.id)).schedule_snapshot.reason, 'Подмена коллеги'); await finish(f, a);
    });
    await test('approval request/replay/decision/start; one consumption only', async () => {
      const f = fixtures[4]; await policy(f, 'approval');
      await deny(m.start(pool, f.employee, key()), 'attendance_approval_required');
      const input = { ...key(), reason: 'Внеплановая работа' };
      const request = await m.requestException(pool, f.employee, input);
      assert.equal(new Date(request.windowEnd) - new Date(request.windowStart), 2 * 3600000);
      assert.deepEqual(json(await m.requestException(pool, f.employee, input)), json(request));
      await deny(m.requestException(pool, f.employee, { ...key(), reason: 'Ещё заявка' }), 'attendance_request_pending');
      await deny(m.decide(pool, f.owner, { ...key(), id: request.id, version: 0, decision: 'approved' }), 'attendance_request_conflict');
      const decision = { ...key(), id: request.id, version: request.version, decision: 'approved' };
      const approved = await m.decide(pool, f.owner, decision);
      assert.deepEqual(json(await m.decide(pool, f.owner, decision)), json(approved));
      const start = { ...key(), approvalId: request.id };
      const a = await m.start(pool, f.employee, start);
      assert.deepEqual(json(await m.start(pool, f.employee, start)), json(a));
      assert.equal((await stored(a.id)).basis, 'approved_exception'); await finish(f, a);
      await deny(m.start(pool, f.employee, { ...key(), approvalId: request.id }), 'attendance_approval_invalid');
      await deny(m.cancel(pool, f.employee, { ...key(), id: request.id, version: approved.version + 1 }), 'attendance_request_conflict');
    });
    await test('rejection/cancellation and self-approval denied', async () => {
      const f = fixtures[5];
      let r = await m.requestException(pool, f.owner, { ...key(), reason: 'Своя заявка' });
      await deny(m.decide(pool, f.owner, { ...key(), id: r.id, version: r.version, decision: 'approved' }), 'attendance_request_conflict');
      await m.cancel(pool, f.owner, { ...key(), id: r.id, version: r.version });
      r = await m.requestException(pool, f.employee, { ...key(), reason: 'Заявка сотрудника' });
      const rejected = await m.decide(pool, f.owner, { ...key(), id: r.id, version: r.version, decision: 'rejected', note: 'Нет необходимости' });
      assert.equal(rejected.status, 'rejected');
      await deny(m.start(pool, f.employee, { ...key(), approvalId: r.id }), 'attendance_approval_invalid');
    });
    await test('concurrent identical starts replay; distinct starts single winner', async () => {
      const f = fixtures[6], input = key();
      const pair = await Promise.all([m.start(pool, f.employee, input), m.start(pool, f.employee, input)]);
      assert.deepEqual(json(pair[0]), json(pair[1])); await finish(f, pair[0]);
      const race = await Promise.allSettled([m.start(pool, f.employee, key()), m.start(pool, f.employee, key())]);
      assert.equal(race.filter(r => r.status === 'fulfilled').length, 1);
      assert.equal(race.find(r => r.status === 'rejected').reason.code, 'attendance_already_started');
      await finish(f, race.find(r => r.status === 'fulfilled').value);
    });
    await test('grant/revoke; stale policy and grant versions; roles independent', async () => {
      const f = fixtures[7];
      await deny(policy(f, 'warn', 0, 0, f.manager), 'attendance_forbidden');
      await deny(s.management(pool, f.admin), 'attendance_forbidden');
      const grant = { ...key(), userId: f.manager.userId, managePolicy: true, approve: true, version: 0 };
      await m.saveGrant(pool, f.owner, grant);
      const change = { ...key(), mode: 'warn', preparationMinutes: 0, version: 0 };
      await m.savePolicy(pool, f.manager, change);
      await deny(policy(f, 'free', 0, 0), 'attendance_policy_conflict');
      await deny(m.saveGrant(pool, f.owner, { ...grant, ...key() }), 'attendance_grant_conflict');
      await m.saveGrant(pool, f.owner, { ...key(), userId: f.manager.userId, managePolicy: false, approve: false, version: 1 });
      await deny(m.savePolicy(pool, f.manager, change), 'attendance_forbidden');
      await deny(s.management(pool, f.manager), 'attendance_forbidden');
      assert.equal((await resolveAttendanceAccess(pool, f.manager)).self, true);
    });
    await test('cross-tenant/venue deny; sibling owner management but no self', async () => {
      const f = fixtures[8], other = fixtures[9];
      await deny(m.start(pool, { userId: other.employee.userId, venueId: f.venue }, key()), 'attendance_forbidden');
      const siblingActor = { ...f.siblingOwner, venueId: f.venue };
      await policy(f, 'free', 0, 0, siblingActor);
      await deny(m.start(pool, siblingActor, key()), 'attendance_forbidden');
      const a = await m.start(pool, f.employee, key());
      await deny(m.end(pool, f.second, { ...key(), id: a.id, version: a.version }), 'attendance_session_conflict');
      await deny(m.end(pool, other.employee, { ...key(), id: a.id, version: a.version }), 'attendance_session_conflict');
      await finish(f, a);
    });
    await test('inactive employee denied without bypassing fresh DB state', async () => {
      const f = fixtures[10];
      await db.query('UPDATE users SET is_active=false WHERE id=$1', [f.employee.userId]);
      try { await deny(m.start(pool, f.employee, key()), 'attendance_forbidden'); }
      finally { await db.query('UPDATE users SET is_active=true WHERE id=$1', [f.employee.userId]); }
    });
    await test('scheduler advisory lock blocks start then releases cleanly', async () => {
      const f = fixtures[11], holder = await pool.connect();
      let pending;
      try {
        await holder.query('BEGIN');
        await holder.query("SELECT pg_advisory_xact_lock(hashtextextended('schedule:' || $1::text,0))", [f.venue]);
        pending = m.start(pool, f.employee, key());
        // Attach rejection handling immediately; inspect actual server lock wait.
        const settled = pending.then(value => ({ value }), error => ({ error }));
        let observed = false;
        for (let i = 0; i < 40; i++) {
          const waiting = await db.query(`SELECT 1 FROM pg_stat_activity WHERE datname=$1
            AND wait_event_type='Lock' AND wait_event='advisory'
            AND query LIKE '%hashtextextended%'`, [name]);
          if (waiting.rowCount) { observed = true; break; }
          await pause(50);
        }
        await holder.query('COMMIT');
        const result = await settled;
        if (result.error) throw result.error;
        await finish(f, result.value);
        assert(observed, 'Start did not wait on scheduler advisory lock');
      } finally {
        await holder.query('ROLLBACK').catch(() => {}); holder.release();
        if (pending) await pending.catch(() => {});
      }
    });
    await test('concurrent approval consumption admits only one session', async () => {
      const f = fixtures[12]; await policy(f, 'approval');
      const r = await m.requestException(pool, f.employee, { ...key(), reason: 'Срочная подмена' });
      await m.decide(pool, f.owner, { ...key(), id: r.id, version: r.version, decision: 'approved' });
      const race = await Promise.allSettled([m.start(pool, f.employee, { ...key(), approvalId: r.id }), m.start(pool, f.employee, { ...key(), approvalId: r.id })]);
      assert.equal(race.filter(r => r.status === 'fulfilled').length, 1);
      assert.equal(race.find(r => r.status === 'rejected').reason.code, 'attendance_already_started');
      const persisted = (await db.query('SELECT consumed_at,version FROM staff_attendance_requests WHERE id=$1', [r.id])).rows[0];
      assert(persisted.consumed_at); assert.equal(persisted.version, 3);
      await finish(f, race.find(r => r.status === 'fulfilled').value);
    });
    await test('all non-attendance tables unchanged including payroll/cash', async () => assert.deepEqual(await snapshot(), baseline));
    await test('tested product source unchanged during run', async () => assert.deepEqual(sourceHashes(), loadedHashes));
    for (const result of results) console.log(JSON.stringify(result));
    const failed = results.filter(r => r.result === 'FAIL').length;
    console.log(JSON.stringify({ result: failed ? 'FAIL' : 'PASS', suites: results.length, failed,
      migrations: files.length - 1, protectedTables: protectedTables.length, sourceHashes: loadedHashes }));
    if (failed) process.exitCode = 1;
  } finally {
    try { if (pool) await pool.end(); }
    finally {
      try { if (db) await db.end(); }
      finally {
        try {
          if (created) {
            config(); await admin.query(`DROP DATABASE ${q(name)}`);
            assert.equal((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [name])).rowCount, 0);
            console.log(JSON.stringify({ cleanup: 'PASS', database: name }));
          }
        } finally { await admin.end(); }
      }
    }
  }
}
main().catch(error => { console.error(JSON.stringify({ result: 'FAIL', code: error.code || error.name, constraint: error.constraint || null })); process.exitCode = 1; });
