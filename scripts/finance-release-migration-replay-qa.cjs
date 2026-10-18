'use strict';
// Upgrade/replay against the exact private disposable QA container only. Never reads DATABASE_URL.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { Client } = require('pg');
const guards = require('./local-full-pg-regression.cjs');
const root = path.resolve(__dirname, '..');
const folder = path.join(root, 'tmp', 'full-local-qa');
const defaultBaseline = '481e94e608472715ab530f0931e6acdc0a1bbffe';
function git(args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  assert.equal(result.status, 0, 'Cannot read pinned Git baseline');
  return result.stdout;
}
async function verifyTarget(config) {
  if (typeof guards.verifyTarget === 'function') return guards.verifyTarget(config);
  // Older launcher versions expose --guard rather than the function. Same exact ownership checks.
  const result = spawnSync(process.execPath, [path.join(__dirname, 'local-full-pg-regression.cjs'), '--guard'], {
    cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30000,
  });
  assert.equal(result.status, 0, 'Disposable container ownership verification failed');
}
function connection(config, database) {
  return new Client({ host: '127.0.0.1', port: 31931, user: config.dbUser, password: config.dbPassword,
    database, ssl: false, connectionTimeoutMillis: 5000, statement_timeout: 120000, application_name: 'finance-release-migration-replay-qa' });
}
async function apply(client, label, sql) {
  await client.query('BEGIN');
  try { await client.query(sql); await client.query('COMMIT'); }
  catch (error) { await client.query('ROLLBACK'); throw new Error(`${label}: ${error.message}`); }
}
async function main() {
  const baseline = process.argv[2] || defaultBaseline;
  assert.match(baseline, /^[a-f0-9]{40}$/, 'Baseline must be a complete pinned commit SHA');
  assert.equal(git(['rev-parse', '--verify', `${baseline}^{commit}`]).trim(), baseline);
  const baselineSchema = git(['show', `${baseline}:schema.sql`]);
  const baselineMigrations = git(['ls-tree', '-r', '--name-only', baseline, 'migrations']).trim().split(/\r?\n/)
    .filter(name => /^migrations\/[\w-]+\.sql$/.test(name)).sort().map(name => ({ name, sql: git(['show', `${baseline}:${name}`]) }));
  const currentMigrations = fs.readdirSync(path.join(root, 'migrations')).filter(name => /^[\w-]+\.sql$/.test(name)).sort()
    .map(name => ({ name, sql: fs.readFileSync(path.join(root, 'migrations', name), 'utf8') }));
  assert.ok(baselineMigrations.length && currentMigrations.length >= baselineMigrations.length);
  let config;
  try { config = guards.validateConfig(JSON.parse(fs.readFileSync(path.join(folder, 'runtime.json'), 'utf8'))); }
  catch { throw new Error('Private disposable QA configuration is missing or invalid'); }
  const lockPath = path.join(folder, 'pg-regression-runner.lock');
  const lockId = crypto.randomUUID(), database = 'finance_release_qa_' + crypto.randomBytes(8).toString('hex');
  assert.match(database, /^finance_release_qa_[a-f0-9]{16}$/);
  const lock = fs.openSync(lockPath, 'wx');
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, id: lockId })); fs.closeSync(lock);
  let admin, client, owned = false, failure;
  try {
    await verifyTarget(config);
    admin = connection(config, config.database); await admin.connect();
    assert.equal((await admin.query('SELECT current_database() AS name')).rows[0].name, config.database);
    assert.equal((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [database])).rowCount, 0, 'Refusing existing database');
    await admin.query(`CREATE DATABASE "${database}"`); owned = true;
    client = connection(config, database); await client.connect();
    assert.equal((await client.query('SELECT current_database() AS name')).rows[0].name, database);
    await apply(client, 'baseline schema', baselineSchema);
    for (const migration of baselineMigrations) await apply(client, 'baseline ' + migration.name, migration.sql);
    console.log(`BASELINE PASS ${baseline} (${baselineMigrations.length} migrations)`);
    const org = crypto.randomUUID(), venue = crypto.randomUUID(), actor = crypto.randomUUID();
    await client.query('BEGIN');
    try {
      await client.query("INSERT INTO organizations(id,name,slug) VALUES($1,'Finance release synthetic QA',$2)", [org, 'finance-release-' + org]);
      await client.query("INSERT INTO venues(id,organization_id,name,timezone) VALUES($1,$2,'Finance release synthetic QA','Asia/Yekaterinburg')", [venue, org]);
      await client.query("INSERT INTO users(id,organization_id,venue_id,full_name,login,role) VALUES($1,$2,$3,'Synthetic QA owner',$4,'owner')", [actor, org, venue, 'release-' + actor]);
      await client.query("INSERT INTO orders(venue_id,opened_by,status) VALUES($1,$2,'open')", [venue, actor]);
      const order = (await client.query('SELECT id FROM orders WHERE venue_id=$1', [venue])).rows[0].id;
      await client.query("INSERT INTO payments(order_id,method,amount,status,idempotency_key) VALUES($1,'cash',25.50,'paid',$2)", [order, crypto.randomUUID()]);
      await client.query("INSERT INTO staff_schedules(venue_id,user_id,work_date,planned_start,planned_end,created_by,note) VALUES($1,$2,'2026-11-10','2026-11-10T10:00:00+05:00','2026-11-10T18:00:00+05:00',$2,'Preserve original schedule')", [venue, actor]);
      await client.query("INSERT INTO staff_attendance_policies(venue_id,mode,preparation_minutes,updated_by) VALUES($1,'warn',15,$2)", [venue, actor]);
      await client.query('INSERT INTO staff_attendance_grants(venue_id,user_id,can_approve,updated_by) VALUES($1,$2,true,$2)', [venue, actor]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    const snapshots = async () => {
      const result = {};
      for (const [table, columns, where] of [
        ['orders','id,venue_id,opened_by,status,created_at','venue_id=$1'],
        ['payments','id,order_id,method,amount,status,idempotency_key,created_at','order_id IN (SELECT id FROM orders WHERE venue_id=$1)'],
        ['staff_schedules','id,venue_id,user_id,work_date,planned_start,planned_end,created_by,note','venue_id=$1'],
        ['staff_attendance_policies','venue_id,mode,preparation_minutes,version,updated_by','venue_id=$1'],
        ['staff_attendance_grants','venue_id,user_id,can_approve,can_manage_policy,version,updated_by','venue_id=$1'],
      ]) result[table] = (await client.query(`SELECT ${columns} FROM ${table} WHERE ${where} ORDER BY 1`, [venue])).rows;
      return result;
    };
    const before = await snapshots();
    for (const rows of Object.values(before)) assert.equal(rows.length, 1, 'Every preservation fixture must exist');
    for (let pass = 1; pass <= 2; pass++) {
      for (const migration of currentMigrations) await apply(client, `pass ${pass} ${migration.name}`, migration.sql);
      assert.deepEqual(await snapshots(), before, `Seeded upstream data changed on pass ${pass}`);
      for (const table of ['staff_schedules','staff_schedule_functions','staff_schedule_series','staff_schedule_grants','staff_attendance_sessions','staff_attendance_policies','finance_categories','finance_accounts','finance_payables','finance_recurring_rules','finance_payable_recognitions','finance_payable_offsets','finance_funding_events','finance_other_income_documents','finance_unified_report_snapshots']) {
        assert.ok((await client.query('SELECT to_regclass($1) AS name', ['public.' + table])).rows[0].name, `Missing ${table}`);
      }
      console.log(`CURRENT PASS ${pass} (${currentMigrations.length} migrations; order/payment/schedule/attendance preserved)`);
    }
    console.log('FINANCE RELEASE MIGRATION UPGRADE + REPLAY: PASS');
  } catch (error) { failure = error; }
  finally {
    if (client) await client.end().catch(() => {});
    try {
      if (owned) {
        await verifyTarget(config);
        assert.match(database, /^finance_release_qa_[a-f0-9]{16}$/);
        await admin.query(`DROP DATABASE "${database}"`);
        assert.equal((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [database])).rowCount, 0);
        console.log('CLEANUP PASS (only runner-created database removed)');
      }
    } catch (error) { failure = new Error(`${failure ? failure.message + '; ' : ''}owned QA cleanup failed: ${error.message}`); }
    if (admin) await admin.end().catch(() => {});
    const holder = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    assert.equal(holder.id, lockId, 'Never remove another runner lock');
    fs.unlinkSync(lockPath);
  }
  if (failure) throw new Error(guards.safeText(failure.message, config));
}
main().catch(error => { console.error('FINANCE RELEASE MIGRATION REPLAY: FAIL: ' + error.message); process.exitCode = 1; });
