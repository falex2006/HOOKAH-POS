import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceSql = fs.readFileSync(path.join(root, 'payroll-venue-turnover-source.js'), 'utf8');
assert.match(sourceSql, /u\.role='owner' AND u\.is_active=true AND u\.deleted_at IS NULL/);
assert.match(sourceSql, /o\.venue_id=c\.venue_id AND o\.status='closed'/);
assert.match(sourceSql, /o\.closed_at AT TIME ZONE c\.timezone/);
assert.match(sourceSql, /o\.final_total_snapshot/);
assert.match(sourceSql, /generate_series\(\$3::date,\$4::date,interval '1 day'\)/);
assert.match(sourceSql, /missing_closed_at_count/);
assert.match(sourceSql, /md5\(/);
assert.doesNotMatch(sourceSql, /\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b/i, 'source adapter is read-only');

if (process.env.PAYROLL_TURNOVER_SOURCE_STATIC_ONLY === '1') {
  console.log('PAYROLL VENUE TURNOVER SOURCE CONTRACT: STATIC PASS (PostgreSQL runtime explicitly skipped)');
} else {
  const databaseUrl = process.env.MIGRATIONS_PG_TEST_DATABASE_URL;
  if (!databaseUrl) throw new Error('Set MIGRATIONS_PG_TEST_DATABASE_URL or explicitly set PAYROLL_TURNOVER_SOURCE_STATIC_ONLY=1');
  assert.match(new URL(databaseUrl).pathname, /(?:test|qa|scratch)/i,
    'refusing source test writes unless database name clearly identifies a test/QA/scratch database');
  const require = createRequire(import.meta.url);
  const { Client } = require('pg');
  const { makePayrollVenueTurnoverSource, PayrollVenueTurnoverSourceError } = require(path.join(root, 'payroll-venue-turnover-source.js'));
  const client = new Client({ connectionString: databaseUrl });
  const schema = `payroll_turnover_source_qa_${process.pid}_${Date.now()}`;
  const quoteSchema = `"${schema}"`;
  const venueA = 'a0000000-0000-4000-8000-000000000001';
  const venueB = 'b0000000-0000-4000-8000-000000000001';
  const ownerA = 'a0000000-0000-4000-8000-000000000002';
  const ownerB = 'b0000000-0000-4000-8000-000000000002';
  const staffA = 'a0000000-0000-4000-8000-000000000003';
  const order = (id) => `${id.slice(0, 8)}-0000-4000-8000-${id.slice(-12)}`;

  try {
    await client.connect();
    await client.query('BEGIN');
    await client.query(`CREATE SCHEMA ${quoteSchema}`);
    await client.query(`SET LOCAL search_path TO ${quoteSchema},public`);
    await client.query(`CREATE TABLE venues(id uuid PRIMARY KEY,timezone text NOT NULL);
      CREATE TABLE users(id uuid PRIMARY KEY,venue_id uuid NOT NULL,role text NOT NULL,is_active boolean NOT NULL,deleted_at timestamptz);
      CREATE TABLE orders(id uuid PRIMARY KEY,venue_id uuid NOT NULL,status text NOT NULL,closed_at timestamptz,final_total_snapshot numeric(12,2));`);
    await client.query('INSERT INTO venues(id,timezone) VALUES ($1,$3),($2,$4)', [venueA, venueB, 'Asia/Yekaterinburg', 'Europe/Moscow']);
    await client.query(`INSERT INTO users(id,venue_id,role,is_active) VALUES
      ($1,$3,'owner',true),($2,$4,'owner',true),($5,$3,'bartender',true)`, [ownerA, ownerB, venueA, venueB, staffA]);
    const service = makePayrollVenueTurnoverSource(client);
    const principalA = { userId: ownerA, venueId: venueA };
    const principalB = { userId: ownerB, venueId: venueB };
    const firstOrder = order('a0000000-0000-4000-8000-000000000010');
    const secondOrder = order('a0000000-0000-4000-8000-000000000011');
    const openOrder = order('a0000000-0000-4000-8000-000000000012');
    const otherVenueOrder = order('b0000000-0000-4000-8000-000000000013');
    const exactLowerBoundaryOrder = order('a0000000-0000-4000-8000-000000000016');
    const beforeLowerBoundaryOrder = order('a0000000-0000-4000-8000-000000000017');
    await client.query(`INSERT INTO orders(id,venue_id,status,closed_at,final_total_snapshot) VALUES
      ($1,$2,'closed','2026-09-01T18:00:00Z',100.25),
      ($3,$2,'closed','2026-09-01T20:30:00Z',200.50),
      ($4,$2,'open','2026-09-01T19:00:00Z',9000),
      ($5,$6,'closed','2026-09-01T18:00:00Z',7000),
      ($7,$2,'closed','2026-08-31T19:00:00Z',1.00),
      ($8,$2,'closed','2026-08-31T18:59:59Z',5000)`,
    [firstOrder, venueA, secondOrder, openOrder, otherVenueOrder, venueB, exactLowerBoundaryOrder, beforeLowerBoundaryOrder]);

    const result = await service.getVenueDailyTurnover(principalA, { from: '2026-09-01', through: '2026-09-03' });
    assert.equal(result.venueTimezone, 'Asia/Yekaterinburg');
    assert.equal(result.official, false);
    assert.equal(result.persistence, 'none');
    assert.equal(result.previewOnly, true);
    assert.equal(result.source, 'closed_order_final_total_snapshot_preview');
    assert.equal(result.sourceWatermarkPurpose, 'preview_change_detection_only');
    assert.equal(result.venueDailyTurnover.length, 3, 'calendar includes each day and explicit zeros');
    assert.deepEqual(result.venueDailyTurnover, [
      { date: '2026-09-01', turnoverCents: 10125 },
      { date: '2026-09-02', turnoverCents: 20050 },
      { date: '2026-09-03', turnoverCents: 0 }
    ], 'close dates follow venue timezone, closed snapshots count once, open and other-venue rows are excluded');
    assert.equal(typeof result.sourceWatermark, 'string');
    assert.equal(result.sourceWatermark.length, 32);
    assert.equal((await service.getVenueDailyTurnover(principalA, { from: '2026-09-01', through: '2026-09-03' })).sourceWatermark,
      result.sourceWatermark, 'identical source state yields a stable watermark');
    await client.query('UPDATE orders SET final_total_snapshot=101.25 WHERE id=$1', [firstOrder]);
    assert.notEqual((await service.getVenueDailyTurnover(principalA, { from: '2026-09-01', through: '2026-09-03' })).sourceWatermark,
      result.sourceWatermark, 'changed closed snapshot changes the source watermark');
    await assert.rejects(service.getVenueDailyTurnover({ userId: staffA, venueId: venueA }, { from: '2026-09-01', through: '2026-09-03' }),
      (error) => error instanceof PayrollVenueTurnoverSourceError && error.code === 'payroll_venue_turnover_owner_or_venue_unavailable' && error.status === 403);
    const ignoredTenantOverride = await service.getVenueDailyTurnover(principalA, { from: '2026-09-01', through: '2026-09-03', venueId: venueB });
    assert.equal(ignoredTenantOverride.venueTimezone, 'Asia/Yekaterinburg', 'client cannot override tenant scope');
    assert.equal(ignoredTenantOverride.venueDailyTurnover[0].turnoverCents, 10225, 'untrusted tenant id cannot expose other-venue turnover');
    await client.query(`INSERT INTO orders(id,venue_id,status,closed_at,final_total_snapshot) VALUES
      ('a0000000-0000-4000-8000-000000000015',$1,'closed',NULL,1)`, [venueA]);
    await assert.rejects(service.getVenueDailyTurnover(principalA, { from: '2026-09-01', through: '2026-09-03' }),
      (error) => error instanceof PayrollVenueTurnoverSourceError && error.code === 'payroll_venue_turnover_closed_at_missing'
        && error.status === 409 && error.details.missingClosedAtCount === 1,
      'closed orders without close timestamps block the source instead of disappearing from the series');
    await client.query("DELETE FROM orders WHERE id='a0000000-0000-4000-8000-000000000015'");
    await client.query(`INSERT INTO orders(id,venue_id,status,closed_at,final_total_snapshot) VALUES
      ('a0000000-0000-4000-8000-000000000014',$1,'closed','2026-09-02T20:00:00Z',NULL)`, [venueA]);
    await assert.rejects(service.getVenueDailyTurnover(principalA, { from: '2026-09-01', through: '2026-09-03' }),
      (error) => error instanceof PayrollVenueTurnoverSourceError && error.code === 'payroll_venue_turnover_snapshot_missing'
        && error.status === 409 && error.details.missingSnapshotCount === 1,
      'legacy closed orders without final snapshots block the series instead of using a payroll-specific fallback');
    for (const invalidPeriod of [
      { from: '2026-09-02', through: '2026-09-03' },
      { from: '2026-09-01', through: '2026-10-01' },
      { from: '2026-09-03', through: '2026-09-01' },
      { from: '2026-09-01', through: '2026-09-31' }
    ]) await assert.rejects(service.getVenueDailyTurnover(principalA, invalidPeriod),
      (error) => error instanceof PayrollVenueTurnoverSourceError && error.code === 'invalid_payroll_venue_turnover_period');
    await service.getVenueDailyTurnover(principalB, { from: '2026-09-01', through: '2026-09-03' });
    await client.query('ROLLBACK');
    console.log('PAYROLL VENUE TURNOVER SOURCE CONTRACT: STATIC + POSTGRESQL PASS');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}
