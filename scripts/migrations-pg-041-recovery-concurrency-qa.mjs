import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';

const databaseUrl = process.env.MIGRATIONS_PG_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('Set MIGRATIONS_PG_TEST_DATABASE_URL to an isolated PostgreSQL test database');
const parsed = new URL(databaseUrl);
assert.match(parsed.pathname, /(?:test|qa|scratch)/i,
  'refusing test writes unless the database name clearly identifies a test/QA/scratch database');

const require = createRequire(import.meta.url);
const { Client } = require('pg');
const setup = new Client({ connectionString: databaseUrl });
const schema = `migration_041_qa_${process.pid}_${Date.now()}`;
const quoteIdentifier = (value) => `"${String(value).replaceAll('"', '""')}"`;
const migration = fs.readFileSync(new URL('../migrations/041_single_open_shift.sql', import.meta.url), 'utf8');
const venueId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const oldShiftId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const newerShiftId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

try {
  await setup.connect();
  await setup.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
  await setup.query(`SET search_path TO ${quoteIdentifier(schema)}, public`);
  await setup.query(`CREATE TABLE venues (id uuid PRIMARY KEY)`);
  await setup.query('INSERT INTO venues (id) VALUES ($1),($2)', [venueId, '99999999-9999-4999-8999-999999999999']);
  await setup.query(`CREATE TABLE audit_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), venue_id uuid NOT NULL REFERENCES venues(id), actor_id uuid,
    action text NOT NULL, entity_type text NOT NULL, entity_id uuid, after_data jsonb
  )`);
  await setup.query(`CREATE TABLE shifts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    venue_id uuid NOT NULL,
    opened_by uuid NOT NULL,
    opened_at timestamptz NOT NULL DEFAULT now(),
    closed_at timestamptz,
    opening_cash numeric(12,2) NOT NULL DEFAULT 0,
    closing_cash numeric(12,2)
  )`);
  await setup.query('INSERT INTO shifts (id,venue_id,opened_by,closed_at) VALUES ($1,$2,$4,NULL),($3,$2,$4,NULL)', [oldShiftId, venueId, newerShiftId, '12121212-1212-4212-8212-121212121212']);

  await setup.query('BEGIN');
  await setup.query(`SET LOCAL search_path TO ${quoteIdentifier(schema)}, public`);
  await assert.rejects(setup.query(migration), (error) => error.code === 'P0001'
    && /duplicate open shifts exist/.test(error.message),
  '041 must stop with a specific error when a venue already has duplicate open shifts');
  await setup.query('ROLLBACK');

  const afterRejectedMigration = await setup.query('SELECT id,closed_at FROM shifts WHERE venue_id=$1 ORDER BY id', [venueId]);
  assert.equal(afterRejectedMigration.rowCount, 2, 'the failed migration must preserve both historical shift rows');
  assert.ok(afterRejectedMigration.rows.every((row) => row.closed_at === null),
    'the migration must not guess which duplicate shift to close');

  // Model an explicitly reviewed/manual resolution only in this disposable schema.
  // Production recovery must use shift-specific evidence before choosing a row.
  await setup.query('UPDATE shifts SET closed_at=now() WHERE id=$1', [oldShiftId]);
  await setup.query('BEGIN');
  await setup.query(`SET LOCAL search_path TO ${quoteIdentifier(schema)}, public`);
  await setup.query(migration);
  await setup.query('COMMIT');
  await setup.query('UPDATE shifts SET closed_at=now() WHERE id=$1', [newerShiftId]);

  const contenders = [new Client({ connectionString: databaseUrl }), new Client({ connectionString: databaseUrl })];
  await Promise.all(contenders.map(async (client) => {
    await client.connect();
    await client.query(`SET search_path TO ${quoteIdentifier(schema)}, public`);
  }));
  try {
    const contenderIds = [
      'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      'ffffffff-ffff-4fff-8fff-ffffffffffff',
    ];
    const attempts = await Promise.allSettled(contenders.map((client, index) => client.query(
      'INSERT INTO shifts (id,venue_id,opened_by,closed_at) VALUES ($1,$2,$3,NULL)', [contenderIds[index], venueId, '12121212-1212-4212-8212-121212121212'],
    )));
    assert.equal(attempts.filter((result) => result.status === 'fulfilled').length, 1,
      `exactly one concurrent open-shift insert for a venue must succeed: ${attempts.map((result) => result.status === 'rejected' ? `${result.reason.code}:${result.reason.message}` : 'fulfilled').join('; ')}`);
    const rejected = attempts.find((result) => result.status === 'rejected');
    assert.equal(rejected.reason.code, '23505', 'the losing concurrent insert must be rejected by the unique index');

    await contenders[0].query('INSERT INTO shifts (id,venue_id,opened_by,closed_at) VALUES ($1,$2,$3,now())', ['12121212-1212-4212-8212-121212121212', venueId, '12121212-1212-4212-8212-121212121212']);
    await contenders[1].query('INSERT INTO shifts (id,venue_id,opened_by,closed_at) VALUES ($1,$2,$3,NULL)', ['dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', '12121212-1212-4212-8212-121212121212']);
    const counts = await setup.query(`SELECT venue_id,COUNT(*) FILTER (WHERE closed_at IS NULL)::int AS open_count
      FROM shifts GROUP BY venue_id ORDER BY venue_id`);
    assert.equal(counts.rows.find((row) => row.venue_id === venueId).open_count, 1,
      'one venue has at most one open shift while closed shift history remains allowed');
    assert.equal(counts.rows.find((row) => row.venue_id === 'dddddddd-dddd-4ddd-8ddd-dddddddddddd').open_count, 1,
      'another venue may independently keep an open shift');
  } finally {
    await Promise.all(contenders.map((client) => client.end()));
  }

  await setup.query('UPDATE shifts SET closed_at=now() WHERE closed_at IS NULL');
  const server = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const validShiftCashStart = server.indexOf('const validCashAmount =');
  const validShiftCashEnd = server.indexOf('\n};', validShiftCashStart) + 3;
  const validShiftCashSource = server.slice(validShiftCashStart, validShiftCashEnd);
  const routeStart = server.indexOf("if (pathname === '/api/shifts' && req.method === 'POST')");
  const routeEnd = server.indexOf("if (pathname === '/api/venue' && req.method === 'GET')", routeStart);
  assert.ok(routeStart >= 0 && routeEnd > routeStart, 'the production shift-open handler is available for PostgreSQL concurrency QA');
  const route = server.slice(routeStart, routeEnd);
  const apiVenueId = '99999999-9999-4999-8999-999999999999';
  const openThroughApi = async (openingCash) => {
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    await client.query(`SET search_path TO ${quoteIdentifier(schema)}, public`);
    const handle = { query: client.query.bind(client), release: () => { void client.end(); } };
    return new Function('pathname','req','res','repositories','venueDbId','denyUnlessAny','body','json','recordAudit','shifts',
      `${validShiftCashSource}\nreturn (async()=>{${route}})();`)(
      '/api/shifts', { method: 'POST', user: { id: '12121212-1212-4212-8212-121212121212', name: 'QA' } }, {},
      { pool: { connect: async () => handle } }, apiVenueId, () => false, async () => ({ openingCash }),
      (_res, status, data) => ({ status, data }), () => {}, [],
    );
  };
  const apiAttempts = await Promise.all([openThroughApi(100), openThroughApi(200)]);
  assert.deepEqual(apiAttempts.map((result) => result.status).sort(), [201, 409],
    `the actual shift API route uses its advisory lock to serialize simultaneous opens: ${JSON.stringify(apiAttempts)}`);
  assert.equal(apiAttempts.find((result) => result.status === 409).data.error, 'shift_already_open');
  assert.equal((await setup.query('SELECT COUNT(*)::int AS count FROM shifts WHERE venue_id=$1 AND closed_at IS NULL', [apiVenueId])).rows[0].count, 1,
    'the real API concurrent requests leave one persisted open shift');

  console.log('MIGRATION 041 PG RECOVERY/CONCURRENCY QA: PASS (duplicate migration fails without altering rows; explicit QA-only resolution permits retry; concurrent DB inserts and actual API requests each leave exactly one open shift; closed history and another venue remain valid)');
} finally {
  if (setup._connected) {
    await setup.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`).catch(() => {});
    await setup.end();
  }
}
