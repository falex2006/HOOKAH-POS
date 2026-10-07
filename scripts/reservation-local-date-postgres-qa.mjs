import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertQaDatabaseIdentity, validateQaDatabaseUrl } from './postgres-qa-safety.mjs';

const require = createRequire(import.meta.url);
const { Pool } = require('pg');
const { ReservationRepository } = require('../db.js');
const connectionString = process.env.MIGRATIONS_PG_TEST_DATABASE_URL;
const target = validateQaDatabaseUrl(connectionString, 'Reservation calendar-date QA');
assert.equal(target.url.hostname, '127.0.0.1');
assert.equal(Number(target.url.port), 31931, 'Only disposable regression PostgreSQL is allowed');
assert.match(target.database, /^reservations_qa_[a-f0-9]+$/i, 'Only a freshly migrated disposable reservation database is allowed');
assert.equal(process.env.MIGRATIONS_PG_TEST_DOCKER_CONTAINER, 'hookah-full-regression-qa-20261001');
const inspection = spawnSync('docker', ['inspect', process.env.MIGRATIONS_PG_TEST_DOCKER_CONTAINER], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
assert.equal(inspection.status, 0, 'Disposable QA container must exist');
const container = JSON.parse(inspection.stdout)[0];
assert.equal(container.Name, '/hookah-full-regression-qa-20261001');
assert.equal(container.State.Running, true);
assert.equal(container.Config.Labels?.['hookah.local-qa'], '20261001');
assert.equal(container.Config.Image, 'postgres:16-alpine');
assert.equal(container.HostConfig.AutoRemove, true);
assert.equal(container.Mounts.length, 1);
assert.equal(container.Mounts[0].Type, 'volume');
assert.equal(container.Mounts[0].Destination, '/var/lib/postgresql/data');
assert.match(container.Mounts[0].Name, /^[a-f0-9]{64}$/i);
assert.equal(container.Mounts[0].RW, true);
assert.equal(Object.keys(container.HostConfig.PortBindings).length, 1);
assert.deepEqual(container.HostConfig.PortBindings['5432/tcp'], [{ HostIp: '127.0.0.1', HostPort: '31931' }]);
const pool = new Pool({ connectionString, max: 2 });
const childMode = process.argv[2] === '--child';
let fixturesTouched = false;
const fixtures = childMode ? JSON.parse(process.argv[3]) : ['Asia/Yekaterinburg', 'America/Los_Angeles'].map(timezone => ({
  org: randomUUID(), venue: randomUUID(), zone: randomUUID(), table: randomUUID(), guest: randomUUID(), timezone
}));

async function runChild() {
  const hostTimezone = process.env.TZ;
  assert.ok(['Asia/Yekaterinburg', 'America/Los_Angeles'].includes(hostTimezone));
  assert.equal(Intl.DateTimeFormat().resolvedOptions().timeZone, hostTimezone, 'Node must apply the selected host timezone');
  // Replay only the old SELECT projection to prove this regression detects the defect.
  // No product source, PostgreSQL type parser, or stored timestamp is changed.
  if (process.env.RESERVATION_QA_LEGACY_PROJECTION === '1') {
    const query = pool.query.bind(pool);
    pool.query = (sql, ...args) => query(typeof sql === 'string' && sql.startsWith('SELECT r.id,')
      ? sql.replace(/to_char\((\(r\.starts_at AT TIME ZONE .*?\)),\s*'YYYY-MM-DD'\) AS date/, '$1::date AS date')
      : sql, ...args);
  }
  const repository = new ReservationRepository(pool);
  for (const fixture of fixtures) {
    for (const time of ['00:15', '17:00', '23:45']) {
      const created = await repository.create({ venueId: fixture.venue, clientId: fixture.guest,
        tableId: fixture.table, guestName: 'Synthetic date QA', date: '2026-10-03', time, guests: 2, deposit: 125.50 });
      const rows = await repository.list(fixture.venue, '2026-10-03');
      const row = rows.find(entry => entry.id === created.id);
      assert.ok(row, 'Saved reservation must remain in its requested venue calendar day');
      assert.equal(typeof row.date, 'string', 'Calendar date must not be a host-local JavaScript Date');
      assert.equal(row.date, '2026-10-03');
      assert.equal(row.time, time);
      assert.equal(JSON.parse(JSON.stringify(row)).date, '2026-10-03', 'JSON preserves the exact calendar date');
      assert.equal(row.tableId, fixture.table);
      assert.equal(Number(row.depositRequired), 125.50, 'reservation stores the amount required by the venue');
      assert.equal(Number(row.depositPaid), 0, 'creating a reservation never claims money was collected');
      assert.equal(Number(row.deposit), 0, 'legacy collected-deposit alias stays truthful for a new unpaid reservation');
      const allRows = await repository.list(fixture.venue);
      assert.equal(allRows.find(entry => entry.id === created.id).date, '2026-10-03');
      for (const wrongDay of ['2026-10-02', '2026-10-04']) {
        assert.equal((await repository.list(fixture.venue, wrongDay)).some(entry => entry.id === created.id), false);
      }
      const otherVenue = fixtures.find(entry => entry.venue !== fixture.venue);
      assert.equal((await repository.list(otherVenue.venue)).some(entry => entry.id === created.id), false, 'Venue isolation survives date formatting');
      const expectedInstant = fixture.timezone === 'Asia/Yekaterinburg'
        ? { '00:15': '2026-10-02T19:15:00.000Z', '17:00': '2026-10-03T12:00:00.000Z', '23:45': '2026-10-03T18:45:00.000Z' }[time]
        : { '00:15': '2026-10-03T07:15:00.000Z', '17:00': '2026-10-04T00:00:00.000Z', '23:45': '2026-10-04T06:45:00.000Z' }[time];
      const stored = (await pool.query('SELECT starts_at,deposit_required,deposit_paid FROM reservations WHERE id=$1 AND venue_id=$2', [created.id, fixture.venue])).rows[0];
      assert.equal(stored.starts_at.toISOString(), expectedInstant, 'UTC instant is derived from venue timezone, independently of host timezone');
      assert.equal(Number(stored.deposit_required), 125.50);
      assert.equal(Number(stored.deposit_paid), 0);
    }
  }
  console.log(`PASS reservation calendar dates: host=${hostTimezone}, 2 venue timezones, 6 create/list/JSON/UTC scenarios`);
}

async function spawnHost(timezone, legacy = false) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--child', JSON.stringify(fixtures)], {
    windowsHide: true, env: { ...process.env, TZ: timezone, RESERVATION_QA_LEGACY_PROJECTION: legacy ? '1' : '0' }, stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  let errors = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { errors += chunk; });
  const timeout = setTimeout(() => child.kill('SIGTERM'), 30000);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  clearTimeout(timeout);
  if (legacy) {
    assert.notEqual(code, 0, 'Old PostgreSQL date projection must fail the canonical calendar-date regression');
    assert.match(errors, /Calendar date must not be a host-local JavaScript Date/);
    console.log(`PASS regression sensitivity: legacy date projection is rejected under host=${timezone}`);
    return;
  }
  assert.equal(code, 0, `Reservation regression failed under host ${timezone}: ${errors}`);
  process.stdout.write(output);
}

try {
  const identity = (await pool.query('SELECT current_database() AS database, inet_server_addr()::text AS address, inet_server_port() AS port, COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname=current_user),false) AS superuser')).rows[0];
  assertQaDatabaseIdentity(identity, target.database, 31931, 'Reservation date PostgreSQL');
  if (childMode) await runChild();
  else {
    fixturesTouched = true;
    for (const fixture of fixtures) {
      await pool.query("INSERT INTO organizations(id,name,slug,plan) VALUES($1,'Reservation date QA',$2,'enterprise')", [fixture.org, `reservation-date-${fixture.org}`]);
      await pool.query("INSERT INTO venues(id,organization_id,name,timezone) VALUES($1,$2,'Reservation date QA',$3)", [fixture.venue, fixture.org, fixture.timezone]);
      await pool.query("INSERT INTO zones(id,venue_id,name) VALUES($1,$2,'Date QA zone')", [fixture.zone, fixture.venue]);
      await pool.query("INSERT INTO tables(id,zone_id,name,capacity) VALUES($1,$2,'Date QA table',4)", [fixture.table, fixture.zone]);
      await pool.query("INSERT INTO guests(id,venue_id,full_name) VALUES($1,$2,'Synthetic date QA')", [fixture.guest, fixture.venue]);
    }
    for (const timezone of ['Asia/Yekaterinburg', 'America/Los_Angeles']) await spawnHost(timezone);
    assert.equal(Number((await pool.query('SELECT count(*) AS count FROM reservations WHERE venue_id=ANY($1::uuid[])', [fixtures.map(entry => entry.venue)])).rows[0].count), 12);
    await spawnHost('Asia/Yekaterinburg', true);
    console.log('PASS reservation calendar date PostgreSQL regression: 12 scenarios, exact ISO calendar strings, tenant isolation, owned fixture cleanup');
  }
} finally {
  if (fixturesTouched) {
    const venues = fixtures.map(entry => entry.venue);
    await pool.query('DELETE FROM reservations WHERE venue_id=ANY($1::uuid[])', [venues]);
    await pool.query('DELETE FROM guests WHERE id=ANY($1::uuid[])', [fixtures.map(entry => entry.guest)]);
    await pool.query('DELETE FROM tables WHERE id=ANY($1::uuid[])', [fixtures.map(entry => entry.table)]);
    await pool.query('DELETE FROM zones WHERE id=ANY($1::uuid[])', [fixtures.map(entry => entry.zone)]);
    await pool.query('DELETE FROM venues WHERE id=ANY($1::uuid[])', [venues]);
    await pool.query('DELETE FROM organizations WHERE id=ANY($1::uuid[])', [fixtures.map(entry => entry.org)]);
    assert.equal(Number((await pool.query('SELECT count(*) AS count FROM venues WHERE id=ANY($1::uuid[])', [venues])).rows[0].count), 0);
  }
  await pool.end();
}
