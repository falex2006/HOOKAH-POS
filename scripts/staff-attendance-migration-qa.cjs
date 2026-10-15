'use strict';
// No .env/external URL, no shared QA database writes, no Docker recreation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Client } = require('pg');
const { config, options } = require('./staff-schedule-local-config.cjs');
const root = path.resolve(__dirname, '..');
const migration = '113_staff_attendance.sql';
const quote = value => '"' + value.replace(/"/g, '""') + '"';

async function main() {
  const c = config(); // Exact local named pipe/container/volume/port identity guard.
  const name = `attendance_qa_${Date.now()}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  assert.match(name, /^attendance_qa_[0-9]+_[a-f0-9]{12}$/);
  assert.notEqual(name, c.database);
  const connection = { ...options(c), connectionTimeoutMillis: 10000 };
  const admin = new Client({ ...connection, database: 'postgres' });
  let created = false, db, checks = 0;
  const sql = file => fs.readFileSync(path.join(root, file), 'utf8');
  const atomic = async source => {
    await db.query('BEGIN');
    try { await db.query(source); await db.query('COMMIT'); }
    catch (error) { await db.query('ROLLBACK'); throw error; }
  };
  const reject = async (source, args, code) => {
    await db.query('BEGIN');
    try { await assert.rejects(db.query(source, args), error => error.code === code); checks++; }
    finally { await db.query('ROLLBACK'); }
  };
  const baseline = async () => {
    const tables = (await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename NOT LIKE 'staff_attendance_%' ORDER BY tablename")).rows;
    const result = {};
    for (const { tablename } of tables) {
      result[tablename] = (await db.query(`SELECT count(*)::text AS count,
        md5(coalesce(string_agg(h,'' ORDER BY h),'')) AS hash
        FROM (SELECT md5(row_to_json(t)::text) h FROM public.${quote(tablename)} t) rows`)).rows[0];
    }
    return result;
  };
  await admin.connect();
  try {
    assert.equal((await admin.query('SELECT current_database() AS db')).rows[0].db, 'postgres');
    await admin.query(`CREATE DATABASE ${quote(name)} TEMPLATE template0`);
    created = true;
    db = new Client({ ...connection, database: name });
    await db.connect();
    assert.equal((await db.query('SELECT current_database() AS db')).rows[0].db, name);
    await db.query("SET statement_timeout='60s'");
    await atomic(sql('schema.sql'));
    const migrations = fs.readdirSync(path.join(root, 'migrations')).filter(f => f.endsWith('.sql')).sort();
    assert(migrations.includes(migration));
    assert.equal(migrations.at(-1), '115_staff_attendance_recovery.sql', 'Review runner baseline before adding subsequent migrations');
    // Recovery 115 depends on the attendance tables created by target 113.
    for (const file of migrations.filter(f => f !== migration && f !== '115_staff_attendance_recovery.sql')) await atomic(sql(`migrations/${file}`));
    const org = randomUUID(), otherOrg = randomUUID();
    const venue = randomUUID(), sibling = randomUUID(), foreignVenue = randomUUID();
    const employee = randomUUID(), owner = randomUUID(), foreignUser = randomUUID();
    await db.query('INSERT INTO organizations(id,name,slug) VALUES ($1,$2,$3),($4,$5,$6)',
      [org, 'QA', `qa-${org}`, otherOrg, 'QA other', `qa-${otherOrg}`]);
    await db.query('INSERT INTO venues(id,name,organization_id) VALUES ($1,$2,$3),($4,$5,$3),($6,$7,$8)',
      [venue, 'QA venue', org, sibling, 'QA sibling', foreignVenue, 'QA foreign', otherOrg]);
    await db.query(`INSERT INTO users(id,venue_id,organization_id,full_name,login,role)
      VALUES ($1::uuid,$2,$3,'QA employee',$1::text,'bartender'),
      ($4::uuid,$5,$3,'QA owner',$4::text,'owner'),($6::uuid,$7,$8,'QA foreign',$6::text,'owner')`,
    [employee, venue, org, owner, sibling, foreignUser, foreignVenue, otherOrg]);
    await db.query('INSERT INTO staff_work_logs(venue_id,user_id,started_at,ended_at) VALUES($1,$2,$3,$4)',
      [venue, employee, '2035-01-01T10:00:00Z', '2035-01-01T11:00:00Z']);
    const before = await baseline();
    await atomic(sql(`migrations/${migration}`));
    await atomic(sql(`migrations/${migration}`));
    await atomic(sql('migrations/115_staff_attendance_recovery.sql'));
    checks += 2;
    await db.query('INSERT INTO staff_attendance_policies(venue_id,updated_by) VALUES($1,$2)', [venue, owner]);
    await reject('UPDATE staff_attendance_policies SET preparation_minutes=241 WHERE venue_id=$1', [venue], '23514');
    await reject('UPDATE staff_attendance_policies SET mode=\'invalid\' WHERE venue_id=$1', [venue], '23514');
    await reject('UPDATE staff_attendance_policies SET updated_by=$2 WHERE venue_id=$1', [venue, foreignUser], '23514');
    await db.query('INSERT INTO staff_attendance_grants(venue_id,user_id,updated_by) VALUES($1,$2,$3)', [venue, employee, owner]);
    await reject('INSERT INTO staff_attendance_grants(venue_id,user_id,updated_by) VALUES($1,$2,$3)', [venue, foreignUser, owner], '23503');
    const sessionSql = `INSERT INTO staff_attendance_sessions(venue_id,user_id,basis,policy_snapshot,schedule_snapshot,timezone,start_request_key)
      VALUES($1,$2,'free','{}','{}','Asia/Yekaterinburg',$3) RETURNING id`;
    const startKey = randomUUID();
    const session = (await db.query(sessionSql, [venue, employee, startKey])).rows[0].id;
    await reject(sessionSql, [venue, employee, randomUUID()], '23505');
    await reject(sessionSql, [venue, foreignUser, randomUUID()], '23503');
    await reject('UPDATE staff_attendance_sessions SET ended_at=started_at-interval \'1 second\' WHERE id=$1', [session], '23514');
    await db.query('UPDATE staff_attendance_sessions SET ended_at=started_at,version=version+1 WHERE id=$1', [session]);
    await reject(sessionSql, [venue, employee, startKey], '23505');
    await db.query(sessionSql, [venue, employee, randomUUID()]);
    const requestKey = randomUUID();
    const requestSql = `INSERT INTO staff_attendance_requests(venue_id,user_id,reason,window_start,window_end,request_key)
      VALUES($1,$2,'QA attendance','2035-01-01T10:00:00Z','2035-01-01T11:00:00Z',$3) RETURNING id`;
    const request = (await db.query(requestSql, [venue, employee, requestKey])).rows[0].id;
    await reject(requestSql, [venue, employee, requestKey], '23505');
    await reject('UPDATE staff_attendance_requests SET window_end=window_start+interval \'25 hours\' WHERE id=$1', [request], '23514');
    await reject('UPDATE staff_attendance_requests SET consumed_at=window_start WHERE id=$1', [request], '23514');
    await reject('UPDATE staff_attendance_requests SET status=\'approved\' WHERE id=$1', [request], '23514');
    await reject('UPDATE staff_attendance_requests SET status=\'approved\',decided_by=$2,decided_at=window_start WHERE id=$1', [request, foreignUser], '23514');
    await db.query('UPDATE staff_attendance_requests SET status=\'approved\',decided_by=$2,decided_at=window_start,consumed_at=window_start,version=version+1 WHERE id=$1', [request, owner]);
    const eventKey = randomUUID();
    const eventSql = `INSERT INTO staff_attendance_events(venue_id,actor_id,action,entity_type,entity_id,request_key,request_fingerprint,response_data)
      VALUES($1,$2,'clock_in','session',$3,$4,$5,'{"ok":true}') RETURNING id`;
    const event = (await db.query(eventSql, [venue, employee, session, eventKey, 'a'.repeat(64)])).rows[0].id;
    await reject(eventSql, [venue, employee, session, eventKey, 'b'.repeat(64)], '23505');
    await reject(eventSql, [venue, foreignUser, session, randomUUID(), 'a'.repeat(64)], '23514');
    await reject(eventSql, [venue, employee, session, randomUUID(), null], '23514');
    await db.query(eventSql, [venue, owner, session, null, null]);
    await db.query(eventSql, [venue, owner, session, null, null]);
    await reject('UPDATE staff_attendance_events SET action=\'changed\' WHERE id=$1', [event], '55000');
    await reject('DELETE FROM staff_attendance_events WHERE id=$1', [event], '55000');
    await reject('TRUNCATE staff_attendance_events', [], '55000');
    assert.deepEqual((await db.query('SELECT response_data FROM staff_attendance_events WHERE venue_id=$1 AND actor_id=$2 AND request_key=$3', [venue, employee, eventKey])).rows[0].response_data, { ok: true });
    await atomic(sql(`migrations/${migration}`)); // Replay with live attendance facts.
    assert.deepEqual(await baseline(), before, 'Existing tables changed');
    checks += 3;
    console.log(JSON.stringify({ result: 'PASS', checks, migrations: migrations.length,
      unchangedExistingTables: Object.keys(before).length, database: name }));
  } finally {
    try { if (db) await db.end(); }
    finally {
      try {
        if (created) {
          config(); // Revalidate exact owned local runtime before deleting only our DB.
          await admin.query(`DROP DATABASE ${quote(name)}`);
          assert.equal((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [name])).rowCount, 0);
          console.log(JSON.stringify({ cleanup: 'PASS', database: name }));
        }
      } finally { await admin.end(); }
    }
  }
}
main().catch(error => { console.error(JSON.stringify({ result: 'FAIL', code: error.code || error.name, message: error.message })); process.exitCode = 1; });
