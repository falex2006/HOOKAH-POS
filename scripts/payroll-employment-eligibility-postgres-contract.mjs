import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { validateQaDatabaseUrl, assertQaDatabaseIdentity } from './postgres-qa-safety.mjs';

const require = createRequire(import.meta.url), { Client, Pool } = require('pg');
const { makeService } = require('../payroll-scheme-service');
const root = fileURLToPath(new URL('../', import.meta.url));
const target = validateQaDatabaseUrl(process.env.MIGRATIONS_PG_TEST_DATABASE_URL);
assert.equal(process.env.MIGRATIONS_PG_TEST_DOCKER_CONTAINER, 'hookah-full-regression-qa-20261001');
assert.equal(target.database, 'hookah_local_qa');
const lock = JSON.parse(readFileSync(path.join(root, 'tmp/full-local-qa/pg-regression-runner.lock'), 'utf8'));
assert.equal(Number(lock.pid), process.ppid, 'the project guarded PostgreSQL runner must own this process');
const schema = `payroll_employment_qa_${process.pid}_${Date.now()}`;
assert.match(schema, /^payroll_employment_qa_\d+_\d+$/);
const db = new Client({ connectionString: target.url.href });
const scopedUrl = new URL(target.url); scopedUrl.searchParams.set('options', `-c search_path=${schema},public`);
let pool, created = false;
const id = () => randomUUID();
const expectQueryError = async (callback, code) => {
  try {
    await callback();
    assert.fail(`expected SQLSTATE ${code}`);
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {});
    assert.equal(error.code, code, `expected SQLSTATE ${code}, got ${error.code}: ${error.message}`);
  }
};

try {
  await db.connect();
  const identity = (await db.query(`SELECT current_database() AS database,inet_server_addr()::text AS address,
    inet_server_port() AS port,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser`)).rows[0];
  assertQaDatabaseIdentity(identity, target.database, Number(target.url.port));
  await db.query(`CREATE SCHEMA "${schema}"`); created = true;
  await db.query(`SET search_path TO "${schema}",public`);
  await db.query(readFileSync(path.join(root, 'schema.sql'), 'utf8'));
  const migrationNames = readdirSync(path.join(root, 'migrations')).filter(name => /^\d{3}.*\.sql$/.test(name)).sort();
  for (const name of migrationNames) {
    await db.query(readFileSync(path.join(root, 'migrations', name), 'utf8'));
  }
  await db.query(readFileSync(path.join(root, 'migrations/188_payroll_employment_eligibility_history.sql'), 'utf8'));
  pool = new Pool({ connectionString: scopedUrl.href, max: 4 });
  const service = makeService(pool);
  const venueId = id(), foreignVenueId = id();
  await db.query("INSERT INTO venues(id,name,timezone) VALUES($1,'Payroll employment QA','UTC'),($2,'Foreign payroll employment QA','UTC')", [venueId, foreignVenueId]);
  const user = async (venue, role, label) => (await db.query(`INSERT INTO users(venue_id,full_name,login,role)
    VALUES($1,$2,$3,$4) RETURNING id::text`, [venue, `QA ${label}`, `employment-${id()}`, role])).rows[0].id;
  const ownerId = await user(venueId, 'owner', 'Owner');
  const employeeId = await user(venueId, 'bartender', 'Employee');
  const managerId = await user(venueId, 'manager', 'Manager');
  const foreignOwnerId = await user(foreignVenueId, 'owner', 'Foreign owner');
  const foreignEmployeeId = await user(foreignVenueId, 'bartender', 'Foreign employee');
  const owner = { venueId, userId: ownerId }, foreignOwner = { venueId: foreignVenueId, userId: foreignOwnerId };
  const period = { employeeId, effectiveFrom: '2026-10-01', effectiveTo: '2026-10-31' };
  const request = { reason: 'Confirm October eligibility periods', idempotencyKey: `eligibility:${id()}`, expectedRevisionId: null, periods: [period] };
  const beforeLedgers = (await db.query(`SELECT (SELECT count(*)::int FROM payroll_entries) entries,
    (SELECT count(*)::int FROM expenses) expenses,(SELECT count(*)::int FROM payroll_calculation_runs) runs`)).rows[0];

  const first = await service.createEmploymentEligibilityRevision(owner, request);
  assert.equal(first.revisionNo, 1);
  assert.equal(first.periodCount, 1);
  assert.equal(first.periods[0].employeeName, 'QA Employee', 'employee display name is snapshotted by PostgreSQL');
  assert.equal(first.periods[0].effectiveFrom, period.effectiveFrom);
  const exactReplay = await service.createEmploymentEligibilityRevision(owner, request);
  assert.equal(exactReplay.id, first.id);
  assert.equal(exactReplay.replayed, true);
  await assert.rejects(() => service.createEmploymentEligibilityRevision(owner, { ...request, periods: [] }),
    error => error.code === 'payroll_employment_idempotency_conflict' && error.status === 409);
  const roster = await service.listEmploymentEligibilityEmployees(owner);
  assert.ok(roster.items.some(row => row.id === employeeId && row.name === 'QA Employee' && row.active === true));
  assert.ok(!roster.items.some(row => row.id === foreignEmployeeId), 'minimal roster is scoped to the authenticated venue');
  const separated = await service.createEmploymentEligibilityRevision(owner, { reason: 'Confirm a later rehire period',
    idempotencyKey: `eligibility:${id()}`, expectedRevisionId: first.id, periods: [
      { employeeId, effectiveFrom: '2026-01-01', effectiveTo: '2026-03-31' },
      { employeeId, effectiveFrom: '2026-07-01', effectiveTo: null }
    ] });
  assert.equal(separated.revisionNo, 2);
  assert.equal(separated.periods.length, 2, 'a revision can preserve disjoint hire/rehire intervals');
  const concurrentKeys = [`eligibility:${id()}`, `eligibility:${id()}`];
  const concurrent = await Promise.allSettled(concurrentKeys.map((idempotencyKey, index) => service.createEmploymentEligibilityRevision(owner, {
    reason: `Confirm concurrent revision ${index + 1}`, idempotencyKey, expectedRevisionId: separated.id, periods: [period]
  })));
  const concurrentSuccesses = concurrent.filter(result => result.status === 'fulfilled').map(result => result.value);
  const concurrentConflicts = concurrent.filter(result => result.status === 'rejected');
  assert.equal(concurrentSuccesses.length, 1, 'only one stale full-snapshot editor can replace the same base revision');
  assert.equal(concurrentConflicts.length, 1);
  assert.equal(concurrentConflicts[0].reason.code, 'payroll_employment_revision_conflict');
  assert.equal(concurrentConflicts[0].reason.status, 409);
  const finalRevision = await service.createEmploymentEligibilityRevision(owner, { reason: 'Confirm final current revision',
    idempotencyKey: `eligibility:${id()}`, expectedRevisionId: concurrentSuccesses[0].id, periods: [period] });
  assert.equal(finalRevision.revisionNo, 4, 'a refreshed base can append the next monotonic revision');
  const firstReadback = await service.createEmploymentEligibilityRevision(owner, request);
  assert.equal(firstReadback.id, first.id);
  assert.equal(firstReadback.replayed, true, 'a retry after later revisions returns its original immutable revision');
  assert.deepEqual(firstReadback.periods.map(row => ({ employeeId: row.employeeId, effectiveFrom: row.effectiveFrom, effectiveTo: row.effectiveTo })), [period]);
  const latestRevisionId = finalRevision.id;
  const readback = await service.getEmploymentEligibilityHistory(owner);
  assert.equal(readback.current.id, latestRevisionId);
  assert.ok(readback.history.some(row => row.id === first.id));
  const committedRevisionCount = (await db.query('SELECT count(*)::int AS count FROM payroll_employment_eligibility_revisions WHERE venue_id=$1', [venueId])).rows[0].count;
  assert.equal((await service.getEmploymentEligibilityHistory(foreignOwner)).current, null, 'another venue cannot read this roster');
  await assert.rejects(() => service.getEmploymentEligibilityHistory({ venueId, userId: managerId }),
    error => error.status === 403);
  await assert.rejects(() => service.createEmploymentEligibilityRevision({ venueId, userId: managerId }, { ...request, idempotencyKey: `eligibility:${id()}` }),
    error => error.status === 403);

  // A committed revision cannot gain child rows later, even if both transactions begin in the same timestamp tick.
  await expectQueryError(async () => {
    const revisionId = first.id;
    await db.query(`INSERT INTO payroll_employment_eligibility_periods
      (venue_id,revision_id,employee_id,employee_name_snapshot,effective_from,effective_to)
      VALUES($1,$2,$3,'late child','2026-10-01','2026-10-31')`, [venueId, revisionId, employeeId]);
  }, '55000');

  const incompleteKey = `eligibility:${id()}`;
  await db.query('BEGIN');
  await db.query(`INSERT INTO payroll_employment_eligibility_revisions
    (venue_id,revision_no,supersedes_revision_id,reason,idempotency_key,payload_sha256,period_count,created_by,created_by_name)
    VALUES($1,5,$2,'Confirm a deliberately incomplete revision',$3,$4,1,$5,'forged owner name')`,
  [venueId, latestRevisionId, incompleteKey, 'a'.repeat(64), ownerId]);
  await assert.rejects(() => db.query('COMMIT'), error => error.code === '23514');
  await db.query('ROLLBACK').catch(() => {});
  assert.equal((await db.query('SELECT count(*)::int AS count FROM payroll_employment_eligibility_revisions WHERE venue_id=$1', [venueId])).rows[0].count, committedRevisionCount,
    'deferred incompleteness rolls the whole revision back');

  const nonOwnerKey = `eligibility:${id()}`;
  await expectQueryError(() => db.query(`INSERT INTO payroll_employment_eligibility_revisions
    (venue_id,revision_no,supersedes_revision_id,reason,idempotency_key,payload_sha256,period_count,created_by,created_by_name)
    VALUES($1,5,$2,'Confirm a non-owner revision',$3,$4,0,$5,'Manager')`, [venueId, latestRevisionId, nonOwnerKey, 'b'.repeat(64), managerId]), '42501');
  await expectQueryError(() => db.query(`INSERT INTO payroll_employment_eligibility_revisions
    (venue_id,revision_no,supersedes_revision_id,reason,idempotency_key,payload_sha256,period_count,created_by,created_by_name)
    VALUES($1,5,$2,'Confirm a cross-venue actor',$3,$4,0,$5,'Foreign owner')`, [venueId, latestRevisionId, `eligibility:${id()}`, 'c'.repeat(64), foreignOwnerId]), '42501');

  const foreignEmployeeRevision = `eligibility:${id()}`;
  await expectQueryError(async () => {
    await db.query('BEGIN');
    const result = await db.query(`INSERT INTO payroll_employment_eligibility_revisions
      (venue_id,revision_no,supersedes_revision_id,reason,idempotency_key,payload_sha256,period_count,created_by,created_by_name)
      VALUES($1,5,$2,'Confirm a foreign employee rejection',$3,$4,1,$5,'Owner') RETURNING id`,
    [venueId, latestRevisionId, foreignEmployeeRevision, 'd'.repeat(64), ownerId]);
    await db.query(`INSERT INTO payroll_employment_eligibility_periods
      (venue_id,revision_id,employee_id,employee_name_snapshot,effective_from,effective_to)
      VALUES($1,$2,$3,'forged foreign employee','2026-10-01','2026-10-31')`, [venueId, result.rows[0].id, foreignEmployeeId]);
  }, '23503');

  const overlapsKey = `eligibility:${id()}`;
  await expectQueryError(async () => {
    await db.query('BEGIN');
    const result = await db.query(`INSERT INTO payroll_employment_eligibility_revisions
      (venue_id,revision_no,supersedes_revision_id,reason,idempotency_key,payload_sha256,period_count,created_by,created_by_name)
      VALUES($1,1,NULL,'Confirm overlap rejection',$2,$3,2,$4,'Owner') RETURNING id`,
    [foreignVenueId, overlapsKey, 'e'.repeat(64), foreignOwnerId]);
    await db.query(`INSERT INTO payroll_employment_eligibility_periods
      (venue_id,revision_id,employee_id,employee_name_snapshot,effective_from,effective_to)
      VALUES($1,$2,$3,'employee','2026-10-01','2026-10-05')`, [foreignVenueId, result.rows[0].id, foreignEmployeeId]);
    await db.query(`INSERT INTO payroll_employment_eligibility_periods
      (venue_id,revision_id,employee_id,employee_name_snapshot,effective_from,effective_to)
      VALUES($1,$2,$3,'employee','2026-10-05','2026-10-10')`, [foreignVenueId, result.rows[0].id, foreignEmployeeId]);
  }, '23P01');

  await expectQueryError(() => db.query('UPDATE payroll_employment_eligibility_revisions SET reason=reason WHERE venue_id=$1 AND id=$2', [venueId, first.id]), '55000');
  await expectQueryError(() => db.query('DELETE FROM payroll_employment_eligibility_periods WHERE venue_id=$1 AND revision_id=$2', [venueId, first.id]), '55000');
  await expectQueryError(() => db.query('TRUNCATE payroll_employment_eligibility_periods'), '55000');
  assert.deepEqual((await db.query(`SELECT (SELECT count(*)::int FROM payroll_entries) entries,
    (SELECT count(*)::int FROM expenses) expenses,(SELECT count(*)::int FROM payroll_calculation_runs) runs`)).rows[0], beforeLedgers,
  'source history creation never writes payroll entries, runs, or expenses');
  console.log('PAYROLL EMPLOYMENT ELIGIBILITY POSTGRES: PASS (ordered bootstrap/replay, idempotency, owner/tenant isolation, disjoint periods, concurrent sequence, transaction identity, late-child rejection, overlap, immutability, no ledger writes)');
} finally {
  if (pool) await pool.end();
  if (created) {
    await db.query(`DROP SCHEMA "${schema}" CASCADE`);
    assert.equal((await db.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [schema])).rows.length, 0);
  }
  await db.end();
}
