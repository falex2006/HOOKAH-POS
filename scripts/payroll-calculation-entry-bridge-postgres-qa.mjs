import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { validateQaDatabaseUrl, assertQaDatabaseIdentity } from './postgres-qa-safety.mjs';
import { addProvenance } from './payroll-provenance-storage-fixture.mjs';
const require = createRequire(import.meta.url);
const { Client, Pool } = require('pg');
const { calculatePayrollScheme } = require('../payroll-schemes');
const { buildCalculatorReplay } = require('../payroll-calculator-replay');
const { persistPayrollSnapshotBundleInTransaction } = require('../payroll-snapshot-persistence');
const target = validateQaDatabaseUrl(process.env.MIGRATIONS_PG_TEST_DATABASE_URL);
assert.match(target.database, /^orders_qa_[a-f0-9]{16}$/);
assert.equal(target.database, process.env.LOCAL_FULL_PG_OWNED_DATABASE);
await require('./local-full-pg-regression.cjs').verifyOwnerPinQaDatabaseUrl(target.url.href);
const pool = new Pool({ connectionString: target.url.href, max: 5 });
const ids = Object.fromEntries(['org', 'venue', 'owner', 'scheme', 'version', 'product'].map(k => [k, randomUUID()]));
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}` : JSON.stringify(value);
const sha = value => createHash('sha256').update(value).digest('hex');
const insert = async (db, table, row) => {
  const names = Object.keys(row); return db.query(`INSERT INTO ${table}(${names.join(',')}) VALUES(${names.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`, Object.values(row));
};
const fail = (promise, code, message) => assert.rejects(promise, error => error.code === code && (!message || error.message.includes(message)));
const clients = [];
let checks = 0;
async function fixture(employeeId = randomUUID()) {
  const prior = (await pool.query('SELECT id FROM users WHERE id=$1', [employeeId])).rows[0];
  if (!prior) await insert(pool, 'users', { id: employeeId, venue_id: ids.venue, organization_id: ids.org, full_name: 'Frozen Employee', login: `bridge-${employeeId}`, role: 'bartender' });
  const orderId = randomUUID(), itemId = randomUUID(), runId = randomUUID();
  await insert(pool, 'orders', { id: orderId, venue_id: ids.venue, status: 'open', opened_by: ids.owner });
  await insert(pool, 'order_items', { id: itemId, order_id: orderId, product_id: ids.product, quantity: 1, unit_price: 100, sales_employee_id: employeeId, sold_at: '2026-10-01T12:00:00Z' });
  const scenario = { scheme: { id: ids.scheme, versionId: ids.version, name: 'Frozen scheme', currency: 'RUB', mode: 'percent_only', applyMilestones: false, roleParameters: { bar: { stableRateBps: 1000 } } },
    periodFrom: '2026-10-01', periodTo: '2026-10-01', employees: [{ id: employeeId }], attendance: [], sourceEvidence: {},
    roleAssignments: [{ employeeId, roleId: 'bar', effectiveFrom: '2026-10-01' }],
    coverage: { kind: 'month_to_date_complete', from: '2026-10-01', through: '2026-10-01', complete: true, watermark: 'synthetic' },
    sales: [{ id: itemId, employeeId, menuItemId: ids.product, department: 'bar', date: '2026-10-01', commissionBaseCents: 10000, turnoverCents: 10000 }] };
  const result = calculatePayrollScheme(scenario); assert.equal(result.status, 'ready');
  const input = { venueId: ids.venue, runId, venueTimezone: 'UTC', attendance: [], employees: [{ id: employeeId, name: 'Frozen Employee' }], result,
    sourceLines: [{ id: itemId, orderId, orderItemId: itemId, employeeId, menuItemId: ids.product, menuItemName: 'Tea', department: 'bar', roleId: 'bar', localDate: '2026-10-01', soldAt: '2026-10-01T12:00:00Z', quantity: '1', grossCents: 10000, discountCents: 0, refundCents: 0, commissionBaseCents: 10000, turnoverCents: 10000 }] };
  const run = { id: runId, venue_id: ids.venue, scheme_version_id: ids.version, period_from: '2026-10-01', period_to: '2026-10-01', status: 'ready', source_coverage: 'complete', commission_basis: 'net_after_discounts_refunds', eligible_line_count: 1, unattributed_line_count: 0, missing_net_line_count: 0, input_watermark: 'synthetic', input_checksum: 'a'.repeat(64), engine_version: 'synthetic', idempotency_key: runId, created_by: ids.owner, created_by_name: 'Owner', venue_timezone: 'UTC', currency: 'RUB', milestone_evidence_version: 0 };
  const bundle = addProvenance({ run, input });
  const evidence = JSON.parse(bundle.provenance.evidence_payload);
  evidence.schemeSnapshot = scenario.scheme; evidence.calculatorReplay = buildCalculatorReplay(scenario, result);
  bundle.provenance.evidence_payload = canonical(evidence);
  bundle.provenance.evidence_sha256 = sha(bundle.provenance.evidence_payload);
  bundle.run.input_checksum = bundle.provenance.evidence_sha256;
  const db = await pool.connect();
  try { await db.query('BEGIN'); await persistPayrollSnapshotBundleInTransaction(db, bundle); await db.query('COMMIT'); }
  catch (error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
  return { employeeId, runId, hash: bundle.provenance.evidence_sha256 };
}
const linkedRow = f => ({ id: randomUUID(), venue_id: ids.venue, user_id: f.employeeId, period_from: '2026-10-01', period_to: '2026-10-01', amount: '10.00', status: 'draft', calculation_run_id: f.runId, calculation_provenance_sha256: f.hash, calculation_gross_cents: 1000, materialized_by: ids.owner, materialized_by_name: 'Owner', materialized_at: new Date().toISOString(), employee_name_snapshot: 'Frozen Employee', calculation_scheme_name_snapshot: 'Frozen scheme' });
const legacyRow = (employeeId, from = '2026-10-01', to = from) => ({ id: randomUUID(), venue_id: ids.venue, user_id: employeeId, period_from: from, period_to: to, amount: '1.00', status: 'draft' });
const cancel = (db, id) => db.query("UPDATE payroll_entries SET status='cancelled',cancelled_at=clock_timestamp(),cancelled_by=$2,cancellation_reason='Owner cancellation' WHERE id=$1", [id, ids.owner]);
const entryDto = entry => ({ schemaVersion: 1, entry: { id: entry.id, userId: entry.user_id, status: entry.status, origin: 'calculation_run', calculationRunId: entry.calculation_run_id, provenanceSha256: entry.calculation_provenance_sha256, amountCents: Number(entry.calculation_gross_cents), periodFrom: '2026-10-01', periodTo: '2026-10-01', currency: 'RUB', employeeName: entry.employee_name_snapshot, schemeName: entry.calculation_scheme_name_snapshot, financeCategoryId: entry.finance_category_id || null, allowedActions: ['cancel'], transitionBlockedReason: 'payroll_run_payout_not_enabled', officialReady: false, payoutEligible: false }, replayed: false, existing: false });
async function connected() { const db = new Client({ connectionString: target.url.href }); await db.connect(); clients.push(db); return db; }
async function waitForLock(db) {
  const pid = db.processID;
  for (let i = 0; i < 150; i++) {
    const row = (await pool.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1', [pid])).rows[0];
    if (row?.wait_event_type === 'Lock') return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Concurrent operation did not reach the exclusion lock');
}
try {
  assertQaDatabaseIdentity((await pool.query('SELECT current_database() database,inet_server_addr() address,inet_server_port() port,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) superuser')).rows[0], target.database, Number(target.url.port));
  const migration = readFileSync(new URL('../migrations/202_payroll_calculation_entry_bridge.sql', import.meta.url), 'utf8');
  await pool.query(migration); await pool.query(migration); checks++;
  const schemaProbe = await pool.connect();
  try {
    await schemaProbe.query('BEGIN');
    await schemaProbe.query('ALTER TABLE payroll_entries DROP CONSTRAINT payroll_entries_mixed_calculation_overlap');
    await schemaProbe.query('ALTER TABLE payroll_entries ADD CONSTRAINT payroll_entries_mixed_calculation_overlap CHECK(amount>=0)');
    await fail(schemaProbe.query(migration), '23514', 'overlap_constraint_mismatch'); checks++;
  } finally { await schemaProbe.query('ROLLBACK'); schemaProbe.release(); }
  assert.equal((await pool.query("SELECT count(*)::int n FROM pg_constraint WHERE conrelid='payroll_entries'::regclass AND contype='x' AND conname IN ('payroll_entries_mixed_calculation_overlap','payroll_entries_calculation_overlap')")).rows[0].n, 2); checks++;
  await insert(pool, 'organizations', { id: ids.org, name: 'Calculation entry QA', slug: `bridge-${ids.org}`, timezone: 'UTC' });
  await insert(pool, 'venues', { id: ids.venue, organization_id: ids.org, name: 'Calculation entry QA', timezone: 'UTC' });
  await insert(pool, 'users', { id: ids.owner, venue_id: ids.venue, organization_id: ids.org, full_name: 'Owner', login: `bridge-${ids.owner}`, role: 'owner' });
  await insert(pool, 'products', { id: ids.product, venue_id: ids.venue, name: 'Tea', category: 'bar', sale_price: 100 });
  await insert(pool, 'payroll_schemes', { id: ids.scheme, venue_id: ids.venue, name: 'Frozen scheme', created_by: ids.owner, created_by_name: 'Owner' });
  await insert(pool, 'payroll_scheme_versions', { id: ids.version, venue_id: ids.venue, scheme_id: ids.scheme, version_no: 1, mode: 'percent_only', effective_from: '2026-10-01', effective_to: '2026-10-31', created_by: ids.owner, created_by_name: 'Owner' });
  await pool.query("UPDATE payroll_scheme_versions SET status='active',status_changed_by=$1,status_changed_by_name='Owner',status_changed_at=now() WHERE id=$2", [ids.owner, ids.version]);
  const f = await fixture();
  await pool.query('UPDATE users SET is_active=false WHERE id=$1', [ids.owner]);
  await fail(insert(pool, 'payroll_entries', linkedRow(f)), '23514', 'owner_invalid'); checks++;
  await pool.query('UPDATE users SET is_active=true WHERE id=$1', [ids.owner]);
  await fail(insert(pool, 'payroll_entries', legacyRow(f.employeeId, '2026-10-02', '2026-10-01')), '23514', 'period_invalid'); checks++;
  await fail(insert(pool, 'payroll_entries', legacyRow(f.employeeId, '-infinity', 'infinity')), '23514', 'period_invalid'); checks++;
  const good = linkedRow(f);
  for (const patch of [{ amount: '9.00' }, { calculation_gross_cents: 999 }, { calculation_provenance_sha256: 'f'.repeat(64) }, { period_to: '2026-10-02' }, { user_id: ids.owner }, { employee_name_snapshot: 'Wrong' }, { calculation_scheme_name_snapshot: 'Wrong' }, { materialized_by: f.employeeId }, { approved_at: new Date() }]) {
    await fail(insert(pool, 'payroll_entries', { ...good, ...patch, id: randomUUID() }), '23514'); checks++;
  }
  for (const status of ['approved', 'paid']) { await fail(insert(pool, 'payroll_entries', { ...good, status, id: randomUUID() }), '23514', 'payroll_run_payout_not_enabled'); checks++; }
  const entry = (await insert(pool, 'payroll_entries', good)).rows[0]; checks++;
  await fail(insert(pool, 'payroll_entries', { ...good, id: randomUUID() }), '23505'); checks++;
  for (const field of ['amount=11', 'calculation_run_id=NULL', 'calculation_gross_cents=1100', "employee_name_snapshot='Changed'", "period_to='2026-10-02'", 'materialized_by=NULL']) {
    await fail(pool.query(`UPDATE payroll_entries SET ${field} WHERE id=$1`, [entry.id]), '55000'); checks++;
  }
  for (const status of ['approved', 'paid']) { await fail(pool.query('UPDATE payroll_entries SET status=$2 WHERE id=$1', [entry.id, status]), '23514', 'payroll_run_payout_not_enabled'); checks++; }
  await fail(pool.query('DELETE FROM payroll_entries WHERE id=$1', [entry.id]), '55000'); checks++;
  await fail(pool.query('TRUNCATE payroll_entries CASCADE'), '55000'); checks++;
  await fail(insert(pool, 'payroll_entries', legacyRow(f.employeeId)), '23P01'); checks++;
  // Touching inclusive dates overlap, adjacent nonoverlapping dates do not.
  await fail(insert(pool, 'payroll_entries', legacyRow(f.employeeId, '2026-09-30', '2026-10-01')), '23P01'); checks++;
  const adjacent = (await insert(pool, 'payroll_entries', legacyRow(f.employeeId, '2026-10-02'))).rows[0]; checks++;
  await fail(pool.query("UPDATE payroll_entries SET period_from='2026-10-01' WHERE id=$1", [adjacent.id]), '23P01'); checks++;
  const legacyA = (await insert(pool, 'payroll_entries', legacyRow(ids.owner))).rows[0];
  await insert(pool, 'payroll_entries', legacyRow(ids.owner)); checks++;
  await pool.query("UPDATE payroll_entries SET status='approved' WHERE id=$1", [legacyA.id]); checks++;
  await pool.query('DELETE FROM payroll_entries WHERE id=$1', [legacyA.id]); checks++;
  await fail(pool.query('UPDATE payroll_entries SET calculation_run_id=$2 WHERE id=$1', [adjacent.id, f.runId]), '23514', 'insert_only'); checks++;
  const response = canonical(entryDto(entry));
  const request = { venue_id: ids.venue, idempotency_key: 'bridge-request-1', request_hash: 'a'.repeat(64), created_by: ids.owner, entry_id: entry.id, response_payload: response, response_sha256: sha(response) };
  await insert(pool, 'payroll_calculation_entry_requests', request); checks++;
  await fail(insert(pool, 'payroll_calculation_entry_requests', request), '23505'); checks++;
  await fail(pool.query('UPDATE payroll_calculation_entry_requests SET request_hash=$1', ['b'.repeat(64)]), '55000'); checks++;
  await fail(pool.query('DELETE FROM payroll_calculation_entry_requests'), '55000'); checks++;
  await fail(pool.query('TRUNCATE payroll_calculation_entry_requests'), '55000'); checks++;
  const forged = canonical({ ...entryDto(entry), entry: { ...entryDto(entry).entry, amountCents: 999 } });
  await fail(insert(pool, 'payroll_calculation_entry_requests', { ...request, idempotency_key: 'bridge-forged', response_payload: forged, response_sha256: sha(forged) }), '23514'); checks++;
  for (const patch of [{ status: 'paid' }, { allowedActions: ['approve', 'pay'] }]) {
    const forgedState = canonical({ ...entryDto(entry), entry: { ...entryDto(entry).entry, ...patch } });
    await fail(insert(pool, 'payroll_calculation_entry_requests', { ...request, idempotency_key: `bridge-${randomUUID()}`, response_payload: forgedState, response_sha256: sha(forgedState) }), '23514', 'response_mismatch'); checks++;
  }
  await pool.query('UPDATE users SET is_active=false WHERE id=$1', [f.employeeId]);
  await fail(pool.query("UPDATE payroll_entries SET status='cancelled',cancelled_at=now(),cancelled_by=$2,cancellation_reason='Inactive actor denied' WHERE id=$1", [entry.id, f.employeeId]), '23514', 'cancellation_invalid'); checks++;
  await pool.query('UPDATE users SET is_active=true WHERE id=$1', [f.employeeId]);
  await fail(pool.query("UPDATE payroll_entries SET status='cancelled',cancelled_at=now(),cancelled_by=$2,cancellation_reason='no' WHERE id=$1", [entry.id, ids.owner]), '23514', 'cancellation_invalid'); checks++;
  // DB retains legacy finance-role cancellation boundary; authenticated service
  // grants the permission. The actor must still be active in this venue.
  await pool.query("UPDATE payroll_entries SET status='cancelled',cancelled_at=now(),cancelled_by=$2,cancellation_reason='Finance user cancellation' WHERE id=$1", [entry.id, f.employeeId]); checks++;
  assert.equal((await pool.query('SELECT response_payload FROM payroll_calculation_entry_requests WHERE venue_id=$1 AND idempotency_key=$2', [ids.venue, request.idempotency_key])).rows[0].response_payload, response); checks++;
  await fail(insert(pool, 'payroll_entries', { ...good, id: randomUUID() }), '23505'); checks++;
  await fail(pool.query("UPDATE payroll_entries SET status='draft' WHERE id=$1", [entry.id]), '55000'); checks++;
  await insert(pool, 'payroll_entries', legacyRow(f.employeeId)); checks++;
  // Concurrent mixed INSERT at repeatable read: exclusion checks uncommitted
  // rows even after both snapshots were established before the first write.
  const race = await fixture(), a = await connected(), b = await connected();
  await a.query('BEGIN ISOLATION LEVEL REPEATABLE READ'); await b.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  await a.query('SELECT count(*) FROM payroll_entries'); await b.query('SELECT count(*) FROM payroll_entries');
  const raceLinked = (await insert(a, 'payroll_entries', linkedRow(race))).rows[0];
  const pending = insert(b, 'payroll_entries', legacyRow(race.employeeId)).then(() => ({ ok: true }), error => ({ error }));
  await waitForLock(b); await a.query('COMMIT');
  assert.equal((await pending).error?.code, '23P01'); await b.query('ROLLBACK'); checks++;
  // Concurrent linked/linked pair (different run IDs) uses second exclusion.
  const race2 = await fixture(), race2Other = await fixture(race2.employeeId);
  await a.query('BEGIN'); await b.query('BEGIN');
  await insert(a, 'payroll_entries', linkedRow(race2));
  const pair = insert(b, 'payroll_entries', linkedRow(race2Other)).then(() => ({ ok: true }), error => ({ error }));
  await waitForLock(b); await a.query('COMMIT'); assert.equal((await pair).error?.code, '23P01'); await b.query('ROLLBACK'); checks++;
  // Concurrent UPDATE of a legacy period also observes an uncommitted link.
  const race3 = await fixture(), moving = (await insert(pool, 'payroll_entries', legacyRow(race3.employeeId, '2026-10-02'))).rows[0];
  await a.query('BEGIN'); await b.query('BEGIN'); await insert(a, 'payroll_entries', linkedRow(race3));
  const moved = b.query("UPDATE payroll_entries SET period_from='2026-10-01' WHERE id=$1", [moving.id]).then(() => ({ ok: true }), error => ({ error }));
  await waitForLock(b); await a.query('COMMIT'); assert.equal((await moved).error?.code, '23P01'); await b.query('ROLLBACK'); checks++;
  // A committed cancellation releases the overlap range; the original
  // run/employee identity remains consumed permanently.
  await a.query('BEGIN'); await b.query('BEGIN'); await cancel(a, raceLinked.id);
  const afterCancel = insert(b, 'payroll_entries', legacyRow(race.employeeId)).then(value => ({ value }), error => ({ error }));
  await waitForLock(b); await a.query('COMMIT'); assert.ok((await afterCancel).value); await b.query('COMMIT'); checks++;
  await fail(insert(pool, 'payroll_entries', linkedRow(race)), '23505'); checks++;
  assert.equal((await pool.query('SELECT count(*)::int n FROM expenses WHERE venue_id=$1', [ids.venue])).rows[0].n, 0); checks++;
  await pool.query(migration); checks++;
  console.log(`PASS payroll calculation entry bridge PostgreSQL QA (${checks} checks; synthetic persisted source evidence, real schema/exclusions, no payout/source-authority claim)`);
} finally {
  for (const db of clients) { try { await db.query('ROLLBACK'); } catch (_) {} await db.end(); }
  await pool.end();
}
