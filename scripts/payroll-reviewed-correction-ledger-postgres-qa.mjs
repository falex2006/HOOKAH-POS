import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateQaDatabaseUrl, assertQaDatabaseIdentity } from './postgres-qa-safety.mjs';
const require = createRequire(import.meta.url);
const { Client, Pool } = require('pg');
const target = validateQaDatabaseUrl(process.env.MIGRATIONS_PG_TEST_DATABASE_URL);
assert.match(target.database, /^orders_qa_[a-f0-9]{16}$/);
assert.equal(target.database, process.env.LOCAL_FULL_PG_OWNED_DATABASE);
await require('./local-full-pg-regression.cjs').verifyOwnerPinQaDatabaseUrl(target.url.href);
const pool = new Pool({ connectionString: target.url.href, max: 5 });
const migration = readFileSync(new URL('../migrations/203_payroll_reviewed_correction_applications.sql', import.meta.url), 'utf8');
const schema = `correction_ledger_qa_${randomUUID().replaceAll('-', '')}`;
const sha = value => createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}` : JSON.stringify(value);
const ids = Object.fromEntries(['venue', 'owner', 'employee', 'other', 'org', 'original', 'originalRun', 'target', 'targetRun', 'expense', 'assessment', 'snapshotLine', 'refund', 'order', 'item'].map(k => [k, randomUUID()]));
const originalHash = 'a'.repeat(64), assessmentHash = 'b'.repeat(64), sourceHash = 'c'.repeat(64), targetHash = 'd'.repeat(64);
const clients = []; let checks = 0;
const insert = (db, table, row) => { const fields = Object.keys(row); return db.query(`INSERT INTO ${table}(${fields.join(',')}) VALUES(${fields.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`, Object.values(row)); };
const fail = (promise, message, code = '23514') => assert.rejects(promise, error => error.code === code && (!message || error.message.includes(message)));
async function connect(shadow = true) {
  const db = new Client({ connectionString: target.url.href }); await db.connect(); clients.push(db);
  if (shadow) await db.query(`SET search_path="${schema}",public`);
  return db;
}
async function rejected(db, fn, message, code = '23514') {
  await db.query('BEGIN');
  try { await fail((async () => { await fn(); await db.query('COMMIT'); })(), message, code); checks++; }
  finally { await db.query('ROLLBACK'); }
}
const claimRow = (overrides = {}) => ({ id: randomUUID(), venue_id: ids.venue, employee_id: ids.employee, currency: 'RUB', original_entry_id: ids.original, original_run_id: ids.originalRun, original_expense_id: ids.expense, original_provenance_sha256: originalHash, refund_line_event_id: ids.refund, source_snapshot_line_id: ids.snapshotLine, assessment_id: ids.assessment, assessment_hash: assessmentHash, source_hash: sourceHash, assessed_cents: 100, created_by: ids.owner, created_by_name: 'Owner', ...overrides });
function batchRow(operation, cents, sequence, before, after, overrides = {}) {
  const plan = { schemaVersion: 1, policyVersion: 'owner-reviewed-variable-correction-v1', venueId: ids.venue, employeeId: ids.employee,
    currency: 'RUB', originalEntryId: ids.original, originalRunId: ids.originalRun, originalExpenseId: ids.expense,
    originalProvenanceSha256: originalHash, targetEntryId: operation === 'waive' ? null : ids.target,
    targetProvenanceSha256: targetHash, assessmentHash, sourceHash, ledgerHash: 'e'.repeat(64),
    targetBeforeCents: before, targetAfterCents: after, protectedFixedCents: operation === 'waive' ? null : 20,
    allocations: [{ refundLineEventId: ids.refund, sourceSnapshotLineId: ids.snapshotLine, assessedCents: 100, alreadyDisposedCents: 0,
      ...(operation === 'waive' ? { waiveCents: cents } : { applyCents: cents }) }],
    ...(operation === 'waive' ? { operation: 'waive', waiveCents: cents } : { applyCents: cents }), officialReady: false, payoutEligible: false };
  if (operation === 'release') {
    plan.operation = 'release'; plan.releaseCents = cents; plan.cancelledHistoricalCents = before;
    plan.releases = [{ reversesEventId: randomUUID(), originalEntryId: ids.original, refundLineEventId: ids.refund, amountCents: cents }];
    after = before;
  }
  const body = canonical(plan);
  return { id: randomUUID(), venue_id: ids.venue, employee_id: ids.employee, currency: 'RUB', operation,
    original_entry_id: operation === 'release' ? null : ids.original, target_entry_id: operation === 'waive' ? null : ids.target,
    target_sequence_no: operation === 'waive' ? null : sequence, assessment_id: operation === 'release' ? null : ids.assessment,
    assessment_hash: operation === 'release' ? null : assessmentHash, source_hash: operation === 'release' ? null : sourceHash, ledger_hash: plan.ledgerHash,
    plan_payload: body, plan_hash: sha(body), event_count: 1, total_cents: cents,
    target_before_cents: before, target_after_cents: after, protected_fixed_cents: operation === 'waive' ? null : 20,
    reason: 'Owner reviewed correction', created_by: ids.owner, created_by_name: 'Owner', ...overrides };
}
const eventRow = (claim, batch, sequence, reverses = null, overrides = {}) => ({ id: randomUUID(), venue_id: ids.venue, employee_id: ids.employee,
  claim_id: claim.id, batch_id: batch.id, claim_sequence_no: sequence, kind: batch.operation, amount_cents: batch.total_cents,
  target_entry_id: batch.target_entry_id, reverses_event_id: reverses, ...overrides });
async function operation(db, claim, batch, sequence, { reverses = null, releaseParents = null, amountUpdate = true, cancel = false } = {}) {
  const plan = JSON.parse(batch.plan_payload);
  if (batch.operation === 'release' && releaseParents) {
    plan.releases = releaseParents.map(parent => ({ reversesEventId: parent.id, originalEntryId: ids.original, refundLineEventId: ids.refund, amountCents: Number(parent.amount_cents) }));
    batch.event_count = releaseParents.length;
  } else if (batch.operation === 'release') plan.releases[0].reversesEventId = reverses;
  else plan.allocations[0].alreadyDisposedCents = Number((await db.query("SELECT COALESCE(sum(CASE WHEN kind='release' THEN -amount_cents ELSE amount_cents END),0)::text n FROM payroll_correction_events WHERE venue_id=$1 AND claim_id=$2", [ids.venue, claim.id])).rows[0].n);
  batch.plan_payload = canonical(plan); batch.plan_hash = sha(batch.plan_payload);
  await insert(db, 'payroll_correction_batches', batch);
  let row;
  if (releaseParents) {
    for (let index = 0; index < releaseParents.length; index++) row = (await insert(db, 'payroll_correction_events', eventRow(claim, batch, sequence + index, releaseParents[index].id, { amount_cents: releaseParents[index].amount_cents }))).rows[0];
  } else row = (await insert(db, 'payroll_correction_events', eventRow(claim, batch, sequence, reverses))).rows[0];
  if (batch.operation === 'apply' && amountUpdate) await db.query('UPDATE payroll_entries SET amount=$2::numeric/100 WHERE id=$1', [batch.target_entry_id, batch.target_after_cents]);
  if (cancel) await db.query("UPDATE payroll_entries SET status='cancelled' WHERE id=$1", [batch.target_entry_id]);
  return row;
}
async function waitForLock(db) {
  for (let i = 0; i < 150; i++) {
    if ((await pool.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1', [db.processID])).rows[0]?.wait_event_type === 'Lock') return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Expected ledger concurrency lock not observed');
}
try {
  assertQaDatabaseIdentity((await pool.query('SELECT current_database() database,inet_server_addr() address,inet_server_port() port,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) superuser')).rows[0], target.database, Number(target.url.port));
  // Actual full schema, unchanged202 guard: a mere draft/legacy row cannot
  // become a paid linked source by inserting a correction claim.
  await pool.query(migration); await pool.query(migration); checks++;
  await insert(pool, 'organizations', { id: ids.org, name: 'Correction gate QA', slug: `correction-${ids.org}` });
  await insert(pool, 'venues', { id: ids.venue, organization_id: ids.org, name: 'Correction gate QA', timezone: 'UTC' });
  for (const [key, role] of [['owner', 'owner'], ['employee', 'bartender']]) await insert(pool, 'users', { id: ids[key], venue_id: ids.venue, organization_id: ids.org, full_name: key, login: `correction-${ids[key]}`, role });
  const realDraft = randomUUID();
  await insert(pool, 'payroll_entries', { id: realDraft, venue_id: ids.venue, user_id: ids.employee, period_from: '2026-01-01', period_to: '2026-01-31', amount: '1.00', status: 'draft' });
  await fail(insert(pool, 'payroll_correction_claims', claimRow({ original_entry_id: realDraft })), 'original_paid_basis_required'); checks++;
  assert.equal((await pool.query('SELECT count(*)::int n FROM payroll_correction_claims')).rows[0].n, 0); checks++;
  assert.equal((await pool.query("SELECT count(*)::int n FROM pg_trigger WHERE tgrelid='public.payroll_entries'::regclass AND tgname='payroll_calculation_entry_guard' AND tgenabled='O'")).rows[0].n, 1); checks++;
  // Synthetic source fixture, deliberately separate schema. These minimal
  // source relations do not attest POS recognition, paid source provenance,
  // replay, or public lifecycle. The actual203 ledger DDL/triggers run intact.
  // No trigger on any public table is disabled, replaced, or bypassed.
  await pool.query(`CREATE SCHEMA "${schema}"`);
  const db = await connect();
  await db.query(`CREATE TABLE users(id uuid PRIMARY KEY,venue_id uuid NOT NULL,full_name text,role text,is_active boolean DEFAULT true,deleted_at timestamptz,UNIQUE(venue_id,id));
    CREATE TABLE expenses(id uuid PRIMARY KEY,venue_id uuid,source text,amount numeric,UNIQUE(venue_id,id));
    CREATE TABLE payroll_run_provenance(venue_id uuid,run_id uuid,PRIMARY KEY(venue_id,run_id));
    CREATE TABLE payroll_entries(id uuid PRIMARY KEY,venue_id uuid,user_id uuid,status text,calculation_run_id uuid,calculation_provenance_sha256 char(64),calculation_gross_cents bigint,expense_id uuid,amount numeric,period_from date,period_to date,paid_at timestamptz,paid_by uuid,payment_date date,cancelled_at timestamptz,cancelled_by uuid,cancellation_reason text,UNIQUE(venue_id,id));
    CREATE TABLE payroll_daily_snapshot_lines(id uuid PRIMARY KEY,venue_id uuid,run_id uuid,employee_id uuid,order_id uuid,order_item_id uuid,UNIQUE(venue_id,id));
    CREATE TABLE payroll_daily_snapshots(id uuid PRIMARY KEY,venue_id uuid,run_id uuid,employee_id uuid,base_pay numeric,final_amount numeric);
    CREATE TABLE pos_payroll_refund_line_events(id uuid PRIMARY KEY,venue_id uuid,order_id uuid,order_item_id uuid);
    CREATE TABLE payroll_refund_review_assessments(id uuid PRIMARY KEY,venue_id uuid,run_id uuid,assessment_hash char(64),source_hash char(64),coverage text,payload text,UNIQUE(venue_id,id));`);
  await db.query(migration); await db.query(migration); checks++;
  for (const [key, role] of [['owner', 'owner'], ['employee', 'bartender'], ['other', 'owner']]) await insert(db, 'users', { id: ids[key], venue_id: key === 'other' ? ids.other : ids.venue, full_name: key === 'owner' ? 'Owner' : key, role });
  await insert(db, 'expenses', { id: ids.expense, venue_id: ids.venue, source: 'payroll', amount: 1 });
  for (const run of [ids.originalRun, ids.targetRun]) await insert(db, 'payroll_run_provenance', { venue_id: ids.venue, run_id: run });
  await insert(db, 'payroll_entries', { id: ids.original, venue_id: ids.venue, user_id: ids.employee, status: 'paid', calculation_run_id: ids.originalRun, calculation_provenance_sha256: originalHash, calculation_gross_cents: 100, expense_id: ids.expense, amount: 1, period_from: '2026-01-01', period_to: '2026-01-31', paid_at: new Date(), paid_by: ids.owner, payment_date: '2026-02-01' });
  await insert(db, 'payroll_entries', { id: ids.target, venue_id: ids.venue, user_id: ids.employee, status: 'draft', calculation_run_id: ids.targetRun, calculation_provenance_sha256: targetHash, calculation_gross_cents: 100, amount: 1, period_from: '2026-02-01', period_to: '2026-02-28' });
  await insert(db, 'payroll_daily_snapshots', { id: randomUUID(), venue_id: ids.venue, run_id: ids.targetRun, employee_id: ids.employee, base_pay: 0.2, final_amount: 1 });
  await insert(db, 'payroll_daily_snapshot_lines', { id: ids.snapshotLine, venue_id: ids.venue, run_id: ids.originalRun, employee_id: ids.employee, order_id: ids.order, order_item_id: ids.item });
  await insert(db, 'pos_payroll_refund_line_events', { id: ids.refund, venue_id: ids.venue, order_id: ids.order, order_item_id: ids.item });
  const assessment = { provenanceSha256: originalHash, lines: [{ employeeId: ids.employee, refundLineEventId: ids.refund, sourceSnapshotLineId: ids.snapshotLine, salaryImpactCents: -100, reasons: [] }] };
  await insert(db, 'payroll_refund_review_assessments', { id: ids.assessment, venue_id: ids.venue, run_id: ids.originalRun, assessment_hash: assessmentHash, source_hash: sourceHash, coverage: 'complete', payload: canonical(assessment) });
  for (const patch of [{ assessed_cents: 99 }, { employee_id: ids.owner }, { created_by: ids.employee }, { original_provenance_sha256: targetHash }, { created_by: ids.other }, { original_entry_id: ids.target }]) {
    await rejected(db, () => insert(db, 'payroll_correction_claims', claimRow(patch)), null);
  }
  const claim = claimRow(); await insert(db, 'payroll_correction_claims', claim); checks++;
  await rejected(db, () => insert(db, 'payroll_correction_claims', claimRow()), null, '23505');
  await rejected(db, () => db.query('UPDATE payroll_entries SET amount=2 WHERE id=$1', [ids.original]), 'original_history_immutable', '55000');
  await rejected(db, () => db.query('DELETE FROM payroll_entries WHERE id=$1', [ids.original]), 'original_history_immutable', '55000');
  await rejected(db, () => db.query('DELETE FROM expenses WHERE id=$1', [ids.expense]), null, '23503');
  await rejected(db, () => insert(db, 'payroll_correction_batches', batchRow('apply', 30, 1, 100, 70)), 'batch_incomplete');
  await rejected(db, () => operation(db, claim, batchRow('apply', 30, 1, 100, 70), 1, { amountUpdate: false }), 'target_net_reconciliation_required');
  await rejected(db, () => operation(db, claim, batchRow('apply', 90, 1, 100, 10), 1), null);
  await rejected(db, () => operation(db, claim, batchRow('apply', 30, 2, 100, 70), 1), 'target_sequence_conflict');
  await rejected(db, () => operation(db, claim, batchRow('apply', 30, null, 100, 70), 1), 'target_sequence_conflict');
  await rejected(db, async () => {
    const swapped = batchRow('apply', 30, 1, 100, 70), plan = JSON.parse(swapped.plan_payload);
    plan.allocations[0].refundLineEventId = randomUUID();
    swapped.plan_payload = canonical(plan); swapped.plan_hash = sha(swapped.plan_payload);
    await operation(db, claim, swapped, 1);
  }, 'event_plan_mismatch');
  await db.query('BEGIN');
  const apply1Batch = batchRow('apply', 30, 1, 100, 70), apply1 = await operation(db, claim, apply1Batch, 1);
  await db.query('COMMIT'); checks++;
  assert.equal((await db.query('SELECT amount::text FROM payroll_entries WHERE id=$1', [ids.target])).rows[0].amount, '0.70000000000000000000'); checks++;
  await db.query('BEGIN');
  const apply2 = await operation(db, claim, batchRow('apply', 10, 2, 70, 60), 2);
  await db.query('COMMIT'); checks++;
  await db.query('BEGIN');
  const waiveBatch = batchRow('waive', 20, null, null, null), waiver = await operation(db, claim, waiveBatch, 3);
  await db.query('COMMIT'); checks++;
  await rejected(db, () => operation(db, claim, batchRow('waive', 41, null, null, null), 4), 'source_overallocated');
  await rejected(db, () => operation(db, claim, batchRow('release', 40, 3, 60, 60), 4, { releaseParents: [apply1, apply2] }), 'release_requires_cancel');
  await rejected(db, () => operation(db, claim, batchRow('release', 20, 3, 60, 60), 4, { reverses: apply1.id, cancel: true }), null);
  await rejected(db, () => operation(db, claim, batchRow('release', 40, 3, 60, 60), 4, { reverses: waiver.id, cancel: true }), 'release_invalid');
  await rejected(db, () => db.query("UPDATE payroll_entries SET status='cancelled' WHERE id=$1", [ids.target]), 'cancel_requires_full_release');
  await rejected(db, async () => {
    await operation(db, claim, batchRow('release', 40, 3, 60, 60), 4, { releaseParents: [apply1, apply2], cancel: true });
    await db.query('UPDATE payroll_entries SET amount=1 WHERE id=$1', [ids.target]);
  }, 'cancel_historical_amount_changed');
  const response = canonical({ batchId: apply1Batch.id, operation: 'apply', officialReady: false, payoutEligible: false, replayed: false });
  const request = { venue_id: ids.venue, idempotency_key: 'ledger-request-1', request_hash: 'f'.repeat(64), batch_id: apply1Batch.id, created_by: ids.owner, response_payload: response, response_hash: sha(response) };
  await insert(db, 'payroll_correction_requests', request); checks++;
  await rejected(db, () => insert(db, 'payroll_correction_requests', request), null, '23505');
  for (const table of ['claims', 'batches', 'events', 'requests']) {
    await rejected(db, () => db.query(`DELETE FROM payroll_correction_${table}`), 'history_immutable', '55000');
    await rejected(db, () => db.query(`TRUNCATE payroll_correction_${table} CASCADE`), 'history_immutable', '55000');
  }
  await db.query('BEGIN');
  // Queue an earlier draft row image, then cancel/release later in the same
  // transaction. Deferred validation must read the final cancelled state.
  await db.query('UPDATE payroll_entries SET amount=amount WHERE id=$1', [ids.target]);
  const release = await operation(db, claim, batchRow('release', 40, 3, 60, 60), 4, { releaseParents: [apply1, apply2], cancel: true });
  await db.query('COMMIT'); checks++;
  assert.equal((await db.query('SELECT amount::text FROM payroll_entries WHERE id=$1', [ids.target])).rows[0].amount, '0.60000000000000000000'); checks++;
  assert.equal((await db.query('SELECT response_payload FROM payroll_correction_requests WHERE idempotency_key=$1', [request.idempotency_key])).rows[0].response_payload, response); checks++;
  await rejected(db, () => operation(db, claim, batchRow('release', 40, 4, 100, 100), 6, { releaseParents: [apply1, apply2] }), 'target_capacity_mismatch');
  // Permanent waiver survives release: remaining economic source is80, not100.
  assert.equal((await db.query("SELECT sum(CASE WHEN kind='release' THEN -amount_cents ELSE amount_cents END)::text n FROM payroll_correction_events WHERE claim_id=$1", [claim.id])).rows[0].n, '20'); checks++;
  // Concurrent waivers start with the same RR snapshot and claim sequence.
  // Row locks plus unique(claim,sequence) reject stale aggregate spending.
  const a = await connect(), b = await connect();
  await a.query('BEGIN ISOLATION LEVEL REPEATABLE READ'); await b.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  await a.query('SELECT count(*) FROM payroll_correction_events'); await b.query('SELECT count(*) FROM payroll_correction_events');
  await operation(a, claim, batchRow('waive', 50, null, null, null), 6);
  const concurrent = operation(b, claim, batchRow('waive', 50, null, null, null), 6).then(() => ({ ok: true }), error => ({ error }));
  await waitForLock(b); await a.query('COMMIT'); assert.equal((await concurrent).error?.code, '23505'); await b.query('ROLLBACK'); checks++;
  await rejected(db, () => operation(db, claim, batchRow('waive', 31, null, null, null), 7), 'source_overallocated');

  // Actual store SQL and private transaction capability against the actual203
  // ledger. Only upstream source proof/collection/snapshot persistence are
  // module-local seams, because public202 intentionally cannot make paid runs.
  for (const key of ['employee', 'original', 'originalRun', 'target', 'targetRun', 'expense', 'assessment', 'snapshotLine', 'refund', 'order', 'item']) ids[key] = randomUUID();
  await insert(db, 'users', { id: ids.employee, venue_id: ids.venue, full_name: 'Store Employee', role: 'bartender' });
  await insert(db, 'expenses', { id: ids.expense, venue_id: ids.venue, source: 'payroll', amount: 1 });
  for (const run of [ids.originalRun, ids.targetRun]) await insert(db, 'payroll_run_provenance', { venue_id: ids.venue, run_id: run });
  await insert(db, 'payroll_entries', { id: ids.original, venue_id: ids.venue, user_id: ids.employee, status: 'paid', calculation_run_id: ids.originalRun, calculation_provenance_sha256: originalHash, calculation_gross_cents: 100, expense_id: ids.expense, amount: 1, period_from: '2026-01-01', period_to: '2026-01-31', paid_at: new Date(), paid_by: ids.owner, payment_date: '2026-02-01' });
  await insert(db, 'payroll_entries', { id: ids.target, venue_id: ids.venue, user_id: ids.employee, status: 'draft', calculation_run_id: ids.targetRun, calculation_provenance_sha256: targetHash, calculation_gross_cents: 100, amount: 1, period_from: '2026-02-01', period_to: '2026-02-28' });
  await insert(db, 'payroll_daily_snapshots', { id: randomUUID(), venue_id: ids.venue, run_id: ids.targetRun, employee_id: ids.employee, base_pay: 0.2, final_amount: 1 });
  await insert(db, 'payroll_daily_snapshot_lines', { id: ids.snapshotLine, venue_id: ids.venue, run_id: ids.originalRun, employee_id: ids.employee, order_id: ids.order, order_item_id: ids.item });
  await insert(db, 'pos_payroll_refund_line_events', { id: ids.refund, venue_id: ids.venue, order_id: ids.order, order_item_id: ids.item });
  const storePayload = { schemaVersion: 1, policyVersion: 'saved-run-refund-review-v1', basis: 'saved_calculation_unposted', venueId: ids.venue,
    runId: ids.originalRun, currency: 'RUB', provenanceSha256: originalHash, sourceHash, coverage: 'complete', impactCents: -100, reasons: [],
    lines: [{ employeeId: ids.employee, refundLineEventId: ids.refund, sourceSnapshotLineId: ids.snapshotLine, salaryImpactCents: -100, reasons: [] }], officialReady: false, payoutEligible: false };
  const storeAssessmentHash = sha(canonical(storePayload));
  await insert(db, 'payroll_refund_review_assessments', { id: ids.assessment, venue_id: ids.venue, run_id: ids.originalRun, assessment_hash: storeAssessmentHash, source_hash: sourceHash, coverage: 'complete', payload: canonical(storePayload) });
  const filename = fileURLToPath(new URL('../payroll-reviewed-correction-store.js', import.meta.url));
  const Module = require('node:module'), isolated = new Module(filename), originalRequire = createRequire(filename);
  let sourceReads = 0;
  isolated.require = name => {
    if (name === './payroll-calculation-entry-evidence') return { verifyPayrollCalculationEntryEvidence: async (connection, actor, row) => {
      sourceReads++;
      assert.equal(actor.venueId, row.venue_id);
      const current = (await connection.query('SELECT *,period_from::text AS f,period_to::text AS t FROM payroll_entries WHERE id=$1', [row.id])).rows[0];
      return { entryId: current.id, venueId: current.venue_id, employeeId: current.user_id, runId: current.calculation_run_id,
        origin: 'calculation_run', currency: 'RUB', evidenceHashes: { provenanceSha256: current.calculation_provenance_sha256 },
        periodFrom: current.f, periodTo: current.t, entryStatus: current.status, grossCents: Number(current.calculation_gross_cents),
        netCents: Math.round(Number(current.amount) * 100), protectedFixedCents: current.id === ids.target ? 20 : 0,
        eligibleVariableCents: current.id === ids.target ? 80 : 100,
        expense: current.expense_id ? { id: current.expense_id, source: 'payroll', venueId: current.venue_id, entryId: current.id, amountCents: 100 } : null };
    } };
    if (name === './payroll-refund-review-assessment') return { collectPayrollRefundReviewAssessment: async () => { sourceReads++; return structuredClone(storePayload); } };
    if (name === './payroll-refund-review-store') return { saveRefundReviewAssessment: async () => ({ latestAssessment: { id: ids.assessment, assessmentHash: storeAssessmentHash } }) };
    return originalRequire(name);
  };
  isolated._compile(readFileSync(filename, 'utf8'), filename);
  const store = isolated.exports, actor = { venueId: ids.venue, userId: ids.owner };
  const { beginPayrollVerifiedRunSourceTransaction, hasPayrollVerifiedWriteSnapshot } = require('../payroll-source-fence');
  async function fenced(fn, injectAfter = null) {
    const releaseFence = await beginPayrollVerifiedRunSourceTransaction(db, ids.venue);
    const query = db.query.bind(db);
    if (injectAfter) db.query = async (...args) => {
      const value = await query(...args);
      if (injectAfter.test(String(args[0]))) throw Object.assign(new Error('Injected after real SQL write'), { code: 'QA_AFTER_WRITE' });
      return value;
    };
    try {
      assert.equal(hasPayrollVerifiedWriteSnapshot(db, ids.venue), true);
      const result = await fn(); await db.query('COMMIT'); return result;
    } catch (error) { await query('ROLLBACK'); throw error; }
    finally { db.query = query; await releaseFence(); assert.equal(hasPayrollVerifiedWriteSnapshot(db, ids.venue), false); }
  }
  const storeState = async () => (await db.query(`SELECT (SELECT count(*)::int FROM payroll_correction_claims WHERE employee_id=$1) claims,
    (SELECT count(*)::int FROM payroll_correction_batches WHERE employee_id=$1) batches,
    (SELECT count(*)::int FROM payroll_correction_events WHERE employee_id=$1) events,
    (SELECT count(*)::int FROM payroll_correction_requests r JOIN payroll_correction_batches b ON b.id=r.batch_id WHERE b.employee_id=$1) requests,
    (SELECT amount::text FROM payroll_entries WHERE id=$2) target_amount`, [ids.employee, ids.target])).rows[0];
  const applyInput = { operation: 'apply', originalEntryId: ids.original, targetEntryId: ids.target, expectedPlanHash: '0'.repeat(64), reason: 'Store apply QA', idempotencyKey: 'store-apply-1' };
  const previewInput = ({ operation, originalEntryId, targetEntryId }) => ({ operation, originalEntryId, targetEntryId });
  await assert.rejects(store.previewReviewedCorrection(db, actor, previewInput(applyInput)), { code: 'payroll_correction_source_transaction_required' }); checks++;
  applyInput.expectedPlanHash = (await fenced(() => store.previewReviewedCorrection(db, actor, previewInput(applyInput)))).planHash;
  const beforeStore = await storeState();
  for (const expression of [/UPDATE payroll_entries SET amount=/, /INSERT INTO payroll_correction_requests/]) {
    await assert.rejects(fenced(() => store.applyReviewedCorrection(db, actor, applyInput), expression), { code: 'QA_AFTER_WRITE' });
    assert.deepEqual(await storeState(), beforeStore); checks++;
  }
  const storeApply = await fenced(() => store.applyReviewedCorrection(db, actor, applyInput));
  assert.equal(storeApply.totalCents, 80); assert.equal(storeApply.targetAfterCents, 20); checks++;
  const waiverInput = { ...applyInput, operation: 'waive', targetEntryId: null, reason: 'Store waiver QA', idempotencyKey: 'store-waive-1' };
  waiverInput.expectedPlanHash = (await fenced(() => store.previewReviewedCorrection(db, actor, previewInput(waiverInput)))).planHash;
  const storeWaiver = await fenced(() => store.applyReviewedCorrection(db, actor, waiverInput)); assert.equal(storeWaiver.totalCents, 20); checks++;
  const cancellation = { targetEntryId: ids.target, expectedPlanHash: '0'.repeat(64), reason: 'Store cancel QA', idempotencyKey: 'store-cancel-1' };
  cancellation.expectedPlanHash = (await fenced(() => store.previewReviewedCorrectionCancellation(db, actor, cancellation))).planHash;
  const storeCancel = await fenced(() => store.cancelReviewedCorrectionTarget(db, actor, cancellation));
  assert.equal(storeCancel.totalCents, 80); assert.equal(storeCancel.cancelledHistoricalCents, 20); checks++;
  const afterCancel = await storeState(), readsBeforeRetry = sourceReads;
  assert.deepEqual(await fenced(() => store.applyReviewedCorrection(db, actor, applyInput)), { ...storeApply, replayed: true });
  assert.deepEqual(await fenced(() => store.cancelReviewedCorrectionTarget(db, actor, cancellation)), { ...storeCancel, replayed: true });
  assert.equal(sourceReads, readsBeforeRetry); assert.deepEqual(await storeState(), afterCancel); checks++;
  assert.equal((await db.query('SELECT status FROM payroll_entries WHERE id=$1', [ids.target])).rows[0].status, 'cancelled'); checks++;
  assert.equal((await db.query("SELECT sum(CASE WHEN kind='release' THEN -amount_cents ELSE amount_cents END)::text n FROM payroll_correction_events WHERE employee_id=$1", [ids.employee])).rows[0].n, '20'); checks++;
  assert.equal((await pool.query('SELECT count(*)::int n FROM payroll_correction_events')).rows[0].n, 0); checks++;
  assert.equal((await pool.query('SELECT count(*)::int n FROM expenses WHERE venue_id=$1', [ids.venue])).rows[0].n, 0); checks++;
  await db.query(migration); checks++;
  console.log(`PASS payroll reviewed correction ledger PostgreSQL QA (${checks} checks; actual203 ledger with isolated synthetic source schema; public202 untouched, source/payment/financial acceptance NOT claimed)`);
} finally {
  for (const db of clients) { try { await db.query('ROLLBACK'); } catch (_) {} await db.end(); }
  // Entire disposable database is removed by the parent runner. Immutable
  // journal triggers intentionally prevent cleanup by deleting journal rows.
  await pool.end();
}
