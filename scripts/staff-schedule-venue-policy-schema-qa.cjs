'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Client } = require('pg');
const { config, options } = require('./staff-schedule-local-config.cjs');

async function main() {
  const runtime = config(); // verifies fixed container, volume identity and loopback mapping
  const client = new Client(options(runtime));
  const migration = fs.readFileSync(path.join(__dirname, '..', 'migrations', '106_staff_schedule_venue_policy.sql'), 'utf8');
  await client.connect();
  let transaction = false;
  try {
    const identity = (await client.query('SELECT current_database() AS database')).rows[0];
    assert.equal(identity.database, runtime.database);
    assert.equal(identity.database, 'staff_schedule_qa');

    const beforePolicy = (await client.query("SELECT to_regclass('public.staff_schedule_venue_policies')::text AS name")).rows[0].name;
    const beforeCounts = beforePolicy ? (await client.query(`SELECT
      (SELECT count(*)::int FROM staff_schedule_venue_policies) policies,
      (SELECT count(*)::int FROM staff_schedule_venue_business_intervals) intervals,
      (SELECT count(*)::int FROM staff_schedule_config_events WHERE entity_type='venue_policy') events`)).rows[0] : null;

    await client.query('BEGIN');
    transaction = true;
    const base = await client.query("SELECT to_regclass('public.staff_schedule_config_events') AS events, to_regclass('public.staff_schedule_employee_defaults') AS defaults");
    assert.ok(base.rows[0].events && base.rows[0].defaults, 'Expected isolated schedule schema through migration 105');

    // Exercise first application and replay only within this transaction.
    await client.query(migration);
    await client.query(migration);

    const columns = (await client.query(
      `SELECT table_name, column_name, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema='public' AND table_name IN ('staff_schedule_venue_policies','staff_schedule_venue_business_intervals')`
    )).rows;
    const column = (table, name) => columns.find(item => item.table_name === table && item.column_name === name);
    for (const name of ['max_weekly_minutes', 'minimum_rest_minutes', 'maximum_consecutive_days']) {
      assert.equal(column('staff_schedule_venue_policies', name)?.is_nullable, 'YES', `${name} must be optional`);
    }
    assert.equal(column('staff_schedule_venue_policies', 'business_hours_enabled')?.column_default, 'false', 'Business-hour warnings start disabled');
    assert.equal(column('staff_schedule_venue_policies', 'version')?.column_default, '1');
    assert.equal(column('staff_schedule_venue_business_intervals', 'end_day_offset')?.column_default, '0');

    const constraints = (await client.query(
      `SELECT conname, pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE conrelid IN ('staff_schedule_venue_policies'::regclass, 'staff_schedule_venue_business_intervals'::regclass, 'staff_schedule_config_events'::regclass)`
    )).rows;
    const definitions = constraints.map(row => `${row.conname} ${row.definition}`).join('\n');
    assert.match(definitions, /max_weekly_minutes IS NULL/i);
    assert.match(definitions, /max_weekly_minutes > 0/i);
    assert.match(definitions, /minimum_rest_minutes IS NULL/i);
    assert.match(definitions, /minimum_rest_minutes >= 0/i);
    assert.match(definitions, /maximum_consecutive_days IS NULL/i);
    assert.match(definitions, /maximum_consecutive_days > 0/i);
    assert.match(definitions, /venue_policy/);
    assert.match(definitions, /FOREIGN KEY \(venue_id, created_by\)/i);
    assert.match(definitions, /FOREIGN KEY \(venue_id, updated_by\)/i);

    const fixture = (await client.query(
      `SELECT v.id AS venue_id, u.id AS user_id
       FROM venues v JOIN users u ON u.venue_id=v.id
       ORDER BY v.id, u.id LIMIT 1`
    )).rows[0];
    assert.ok(fixture, 'Expected a synthetic venue/user in the isolated QA database');
    const policyResult = await client.query(
      `INSERT INTO staff_schedule_venue_policies
         (venue_id, max_weekly_minutes, minimum_rest_minutes, maximum_consecutive_days,
          business_hours_enabled, version, created_by, updated_by)
       VALUES ($1, NULL, NULL, NULL, false, 1, $2, $2) RETURNING venue_id`,
      [fixture.venue_id, fixture.user_id]
    );
    assert.equal(policyResult.rowCount, 1, 'Unset values must be insertable and disable threshold checks');
    await client.query(
      `UPDATE staff_schedule_venue_policies
       SET max_weekly_minutes=2400, minimum_rest_minutes=600, maximum_consecutive_days=6,
           business_hours_enabled=true, version=version+1, updated_by=$2
       WHERE venue_id=$1`,
      [fixture.venue_id, fixture.user_id]
    );
    const policy = (await client.query('SELECT * FROM staff_schedule_venue_policies WHERE venue_id=$1', [fixture.venue_id])).rows[0];
    assert.equal(policy.version, 2);
    assert.equal(policy.max_weekly_minutes, 2400);
    assert.equal(policy.minimum_rest_minutes, 600);
    assert.equal(policy.maximum_consecutive_days, 6);

    const dayIntervals = [
      ['10:00', '14:00', 0], ['17:00', '22:00', 0], ['20:00', '02:00', 1]
    ];
    for (const [start, end, offset] of dayIntervals) {
      await client.query(
        `INSERT INTO staff_schedule_venue_business_intervals
          (venue_id, weekday, start_time, end_time, end_day_offset, created_by, updated_by)
         VALUES ($1, 1, $2::time, $3::time, $4, $5, $5)`,
        [fixture.venue_id, start, end, offset, fixture.user_id]
      );
    }
    const intervalCount = (await client.query(
      'SELECT count(*)::int AS count FROM staff_schedule_venue_business_intervals WHERE venue_id=$1 AND weekday=1 AND active',
      [fixture.venue_id]
    )).rows[0].count;
    assert.equal(intervalCount, 3, 'Supports multiple intervals per weekday, including overnight');

    await client.query(
      `INSERT INTO staff_schedule_config_events
        (venue_id, actor_id, entity_type, entity_id, action, before_data, after_data)
       VALUES ($1, $2, 'venue_policy', $3, 'qa_update', NULL, $4::jsonb)`,
      [fixture.venue_id, fixture.user_id, fixture.venue_id, JSON.stringify({ version: policy.version, intervals: dayIntervals.length })]
    );
    assert.equal((await client.query("SELECT count(*)::int AS count FROM staff_schedule_config_events WHERE venue_id=$1 AND entity_type='venue_policy'", [fixture.venue_id])).rows[0].count, 1);

    async function violates(statement, values, label) {
      const savepoint = `sp_${randomUUID().replaceAll('-', '')}`;
      await client.query(`SAVEPOINT ${savepoint}`);
      let rejected = false;
      try { await client.query(statement, values); } catch { rejected = true; }
      await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      await client.query(`RELEASE SAVEPOINT ${savepoint}`);
      assert.ok(rejected, label);
    }
    await violates(
      `UPDATE staff_schedule_venue_policies SET minimum_rest_minutes=-1 WHERE venue_id=$1`,
      [fixture.venue_id], 'Negative minimum rest must be rejected'
    );
    await violates(
      `INSERT INTO staff_schedule_venue_business_intervals
        (venue_id, weekday, start_time, end_time, end_day_offset, created_by, updated_by)
       VALUES ($1, 2, '10:00', '09:00', 0, $2, $2)`,
      [fixture.venue_id, fixture.user_id], 'Same-day interval with a non-increasing end must be rejected'
    );
    await violates(
      `INSERT INTO staff_schedule_venue_business_intervals
        (venue_id, weekday, start_time, end_time, end_day_offset, created_by, updated_by)
       VALUES ($1, 2, '10:00', '11:00', 0, $2, $2)`,
      [randomUUID(), fixture.user_id], 'Intervals must reference a policy in the same venue'
    );

    await client.query('ROLLBACK');
    transaction = false;
    const afterPolicy = (await client.query("SELECT to_regclass('public.staff_schedule_venue_policies')::text AS name")).rows[0].name;
    assert.equal(afterPolicy, beforePolicy, 'Schema QA must leave migration state unchanged');
    if (beforePolicy) {
      const afterCounts = (await client.query(`SELECT
        (SELECT count(*)::int FROM staff_schedule_venue_policies) policies,
        (SELECT count(*)::int FROM staff_schedule_venue_business_intervals) intervals,
        (SELECT count(*)::int FROM staff_schedule_config_events WHERE entity_type='venue_policy') events`)).rows[0];
      assert.deepEqual(afterCounts, beforeCounts, 'Schema QA must roll back all fixture data');
    }
    console.log('STAFF SCHEDULE VENUE POLICY SCHEMA QA: PASS (migration/replay, nullable disabled thresholds, venue scope, version fields, weekday/overnight intervals, audit entity, constraint rejection, rollback)');
  } finally {
    if (transaction) await client.query('ROLLBACK').catch(() => {});
    await client.end();
  }
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
