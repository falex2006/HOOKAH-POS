// Imported by the parent PostgreSQL QA only after it has created and paid the
// complete refund-aware correction scenario. This module never connects on its
// own and every mutation probe is rolled back.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const sha = value => createHash('sha256').update(value, 'utf8').digest('hex');
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const insertRow = (db, table, row) => {
  const keys = Object.keys(row);
  assert.ok(keys.length && keys.every(key => /^[a-z][a-z0-9_]*$/.test(key)));
  return db.query(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')})`, keys.map(key => row[key]));
};

export async function verifyRefundAwareCorrectionStorageGuards({ pool, venueId, originalEntryId, targetEntryId, owner }) {
  assert.ok(pool && typeof pool.connect === 'function');
  for (const id of [venueId, originalEntryId, targetEntryId, owner?.userId]) assert.match(id, UUID);
  assert.equal(owner.venueId, venueId);
  const db = await pool.connect();
  let checks = 0, releaseError = null;
  try {
    const tables = (await db.query(`SELECT table_name FROM information_schema.tables
      WHERE table_schema=current_schema() AND table_type='BASE TABLE'
        AND (left(table_name,8) IN ('payroll_','finance_') OR table_name='expenses') ORDER BY table_name`)).rows.map(x => x.table_name);
    for (const table of tables) assert.match(table, /^[a-z][a-z0-9_]*$/);
    for (const required of ['payroll_refund_aware_paid_assessments','payroll_correction_claims','payroll_correction_batches',
      'payroll_correction_events','payroll_correction_requests','payroll_run_provenance','expenses']) assert.ok(tables.includes(required), `${required} is present`);
    const state = async () => {
      const result = {};
      for (const table of tables) result[table] = (await db.query(`SELECT count(*)::int AS count,
        encode(sha256(convert_to(COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text,'UTF8')),'hex') AS hash
        FROM "${table}" t`)).rows[0];
      return result;
    };
    const baseline = await state();
    const rollback = async action => {
      await db.query('BEGIN');
      try { await action(); } finally { await db.query('ROLLBACK'); }
      assert.deepEqual(await state(), baseline, 'rollback-only probe preserves every payroll and finance table');
    };
    const rejects = async (label, action, code, needle) => {
      await rollback(async () => {
        let failure;
        try { await action(); } catch (error) { failure = error; }
        assert.ok(failure, `${label}: expected a database rejection`);
        assert.equal(failure.code, code, `${label}: unexpected SQLSTATE (${failure.message})`);
        assert.ok(String(failure.message).includes(needle), `${label}: expected ${needle}, received ${failure.message}`);
      });
      checks++;
    };

    const original = (await db.query(`SELECT e.*,e.period_from::text AS period_from_text,e.period_to::text AS period_to_text
      FROM payroll_entries e WHERE e.venue_id=$1 AND e.id=$2`, [venueId, originalEntryId])).rows[0];
    assert.equal(original?.status, 'paid');
    const claim = (await db.query(`SELECT * FROM payroll_correction_claims WHERE venue_id=$1 AND original_entry_id=$2
      AND source_kind='period_v2'`, [venueId, originalEntryId])).rows[0];
    assert.ok(claim, 'real period-v2 claim exists');
    const assessment = (await db.query(`SELECT * FROM payroll_refund_aware_paid_assessments
      WHERE venue_id=$1 AND run_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1`, [venueId, original.calculation_run_id])).rows[0];
    assert.ok(assessment, 'real immutable assessment exists');
    const sql208 = await readFile(new URL('../migrations/208_payroll_refund_aware_paid_corrections.sql', import.meta.url), 'utf8');
    await rollback(async () => { await db.query(sql208); await db.query(sql208); }); checks++;

    await rejects('assessment update', () => db.query(`UPDATE payroll_refund_aware_paid_assessments SET payload=payload WHERE venue_id=$1 AND id=$2`, [venueId, assessment.id]),
      '55000', 'payroll_refund_aware_correction_history_immutable');
    await rejects('assessment delete', () => db.query(`DELETE FROM payroll_refund_aware_paid_assessments WHERE venue_id=$1 AND id=$2`, [venueId, assessment.id]),
      '55000', 'payroll_refund_aware_correction_history_immutable');
    await rejects('assessment truncate', () => db.query('TRUNCATE payroll_refund_aware_paid_assessments'),
      '0A000', 'referenced in a foreign key constraint');
    await rejects('assessment cascading truncate', () => db.query('TRUNCATE payroll_refund_aware_paid_assessments CASCADE'),
      '55000', 'immutable');

    const periodPayload = JSON.parse(assessment.payload);
    const invalidAssessment = (mutate, hashMode = 'valid') => {
      const payload = structuredClone(periodPayload); mutate(payload);
      const text = canonical(payload);
      return { ...assessment, id: randomUUID(), assessment_hash: hashMode === 'spoof' ? 'f'.repeat(64) : sha(text), payload: text };
    };
    await rejects('assessment missing candidate gross', () => insertRow(db, 'payroll_refund_aware_paid_assessments',
      invalidAssessment(p => { delete p.paidReviews[0].candidateGrossCents; })), '23514', 'payroll_refund_aware_paid_review_entry_mismatch');
    await rejects('assessment missing current employee amount', () => insertRow(db, 'payroll_refund_aware_paid_assessments',
      invalidAssessment(p => { delete p.employeeDeltas[0].current.amountCents; })), '23514', 'payroll_refund_aware_paid_review_entry_mismatch');
    await rejects('assessment empty employee cohort', () => insertRow(db, 'payroll_refund_aware_paid_assessments',
      invalidAssessment(p => { p.employeeDeltas = []; p.paidReviews = []; })), '23514', 'payroll_refund_aware_employee_cohort_invalid');
    await rejects('assessment raw hash spoof', () => insertRow(db, 'payroll_refund_aware_paid_assessments',
      invalidAssessment(() => {}, 'spoof')), '23514', 'payroll_refund_aware_assessment_hash_invalid');

    // The run-level basis lock must reject legacy line claims even when the
    // insert attempts to use arbitrary line IDs: the mixed-basis guard runs first.
    const lineClaim = { ...claim, id: randomUUID(), source_kind: 'line_v1', cohort_assessment_id: null,
      refund_line_event_id: randomUUID(), source_snapshot_line_id: randomUUID(), assessment_id: randomUUID(),
      created_at: new Date().toISOString() };
    await rejects('mixed v1 line claim on period run', () => insertRow(db, 'payroll_correction_claims', lineClaim),
      '23514', 'payroll_correction_mixed_run_basis');

    const duplicateClaim = { ...claim, id: randomUUID(), created_at: new Date().toISOString() };
    await rejects('duplicate stable period claim', () => insertRow(db, 'payroll_correction_claims', duplicateClaim),
      '23505', 'payroll_correction_claim_period_original_employee_uq');

    const lastBatch = (await db.query(`SELECT * FROM payroll_correction_batches WHERE venue_id=$1
      AND original_entry_id=$2 AND cohort_assessment_id IS NOT NULL ORDER BY created_at DESC,id DESC LIMIT 1`, [venueId, originalEntryId])).rows[0];
    assert.ok(lastBatch, 'real period batch exists');
    const invalidBatch = { ...lastBatch, id: randomUUID(), operation: 'waive', target_entry_id: null,
      target_sequence_no: null, target_before_cents: null, target_after_cents: null, protected_fixed_cents: null,
      total_cents: '1', event_count: 1, created_at: new Date().toISOString() };
    const badPlan = JSON.parse(lastBatch.plan_payload);
    const disposed = Number((await db.query(`SELECT COALESCE(sum(CASE WHEN kind='release' THEN -amount_cents ELSE amount_cents END),0)::text AS cents
      FROM payroll_correction_events WHERE venue_id=$1 AND claim_id=$2`, [venueId, claim.id])).rows[0].cents);
    badPlan.operation = 'waive'; badPlan.targetEntryId = null; badPlan.targetRunId = null; badPlan.targetProvenanceSha256 = null;
    badPlan.waiveCents = 1; badPlan.alreadyDisposedCents = disposed;
    badPlan.allocations = [{ ...badPlan.allocations[0], alreadyDisposedCents: disposed, waiveCents: 1 }];
    invalidBatch.plan_payload = canonical(badPlan); invalidBatch.plan_hash = sha(invalidBatch.plan_payload);
    await rejects('over-allocation beyond current period potential', () => insertRow(db, 'payroll_correction_batches', invalidBatch),
      '23514', 'payroll_refund_aware_waiver_invalid');

    return { status: 'passed', checks, transactionMode: 'rollback_only', migrationReplayCount: 2,
      assessmentImmutable: true, mixedRunBasisBlocked: true, duplicateStableClaimBlocked: true,
      overAllocationBlocked: true, financialRowsChanged: false, tablesChecked: tables.length };
  } finally { db.release(releaseError || undefined); }
}
