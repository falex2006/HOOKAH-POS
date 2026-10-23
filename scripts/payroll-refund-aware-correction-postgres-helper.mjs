import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { seedUnpaidSupersessionFixture } from './payroll-unpaid-supersession-fixture.mjs';
import { verifyRefundAwareCorrectionStorageGuards } from './payroll-refund-aware-correction-storage-guards.mjs';
const require = createRequire(import.meta.url);
const { makeService } = require('../payroll-scheme-service');

// Only the guarded parent supplies this disposable database. All settlements
// use normal owner services and real immutable source/expense/receipt guards.
export async function verifyRefundAwarePaidCorrections({ pool, sourcePolicies }) {
  const period = (await pool.query(`SELECT (date_trunc('month',CURRENT_DATE)-interval '2 months')::date::text AS "from",
    (date_trunc('month',CURRENT_DATE)-interval '1 month'-interval '1 day')::date::text AS "to"`)).rows[0];
  const f = await seedUnpaidSupersessionFixture({ pool, period, sourcePolicies, withTarget: true });
  const { ids, owner, service, run, refund, targetSource } = f;
  const materialize = async (runId, employeeId) => (await service.materializeCalculationEntry(owner, runId,
    { employeeId, financeCategoryId: null, idempotencyKey: `period-entry:${randomUUID()}` })).entry;
  const transition = async (entryId, action, positive = false) => {
    const state = await service.getCalculationEntryState(owner, entryId);
    return service.transitionCalculationEntry(owner, entryId, { action, expectedStateHash: state.stateHash,
      idempotencyKey: `period-${action}:${randomUUID()}`, reason: action === 'cancel' ? 'Owner cancels target and releases its complete correction' : null,
      paymentDate: action === 'pay' ? period.to : null, paymentAccountId: action === 'pay' && positive ? ids.account : null,
      paymentMethod: action === 'pay' && positive ? 'card' : null });
  };
  const original = await materialize(run.runId, ids.employee), zeroOriginal = await materialize(run.runId, ids.zeroEmployee);
  await transition(original.id, 'approve'); await transition(original.id, 'pay', true);
  await transition(zeroOriginal.id, 'approve'); await transition(zeroOriginal.id, 'pay');
  const expensesBefore = (await pool.query('SELECT count(*)::int AS n FROM expenses WHERE venue_id=$1', [ids.venue])).rows[0].n;
  assert.equal(expensesBefore, 1);
  const originalRows = (await pool.query(`SELECT id,status,amount::text,expense_id FROM payroll_entries
    WHERE venue_id=$1 AND calculation_run_id=$2 ORDER BY id`, [ids.venue, run.runId])).rows;
  await refund('0.5', 'paid-period-first-half');
  const context = await service.getRefundAwareCorrectionContext(owner, original.id);
  assert.equal(context.currentPotentialCents, 500); assert.equal(context.remainingCents, 500);
  assert.equal((await service.getRefundAwareCorrectionContext(owner, zeroOriginal.id)).remainingCents, 0);
  const targetPeriod = targetSource.nextPeriod;
  const targetVersion = (await service.createScheme(owner, { name: 'Future variable correction target',
    payoutRiskAcknowledgement: { confirmed: true, policyCode: 'payroll-own-revenue-ceiling-v1' },
    definition: { mode: 'percent_only', currency: 'RUB', effectiveFrom: targetPeriod.from, effectiveTo: targetPeriod.to,
      applyMilestones: false, roleParameters: { bar: { stableRateBps: 500 } },
      roleAssignments: [ids.employee, ids.zeroEmployee].map(employeeId => ({ employeeId, roleId: 'bar',
        effectiveFrom: targetPeriod.from, effectiveTo: targetPeriod.to })), employeeOverrides: [], itemRules: [], sourcePolicies }
  })).versions[0];
  await service.activateVersion(owner, targetVersion.versionId);
  let targetRun = await service.createRefundAwareRun(owner, { schemeVersionId: targetVersion.versionId,
    periodFrom: targetPeriod.from, periodTo: targetPeriod.to, idempotencyKey: 'period-target-run' });
  assert.equal(targetRun.amountCents, 500);
  let target = await materialize(targetRun.runId, ids.employee);
  const previewFor = () => service.previewRefundAwareCorrection(owner,
    { operation: 'apply', originalEntryId: original.id, targetEntryId: target.id });
  const preview = await previewFor();
  assert.equal(preview.applyCents, 500); assert.equal(preview.targetAfterCents, 0);
  const command = { operation: 'apply', originalEntryId: original.id, targetEntryId: target.id,
    expectedPlanHash: preview.planHash, reason: 'Owner applies reviewed whole-period reduction to a future draft', idempotencyKey: 'period-first-apply' };
  const tables = ['payroll_entries', 'expenses', 'payroll_correction_claims', 'payroll_correction_batches',
    'payroll_correction_events', 'payroll_correction_requests', 'payroll_refund_aware_paid_assessments'];
  const state = async () => {
    const result = {};
    for (const table of tables) result[table] = (await pool.query(`SELECT count(*)::int AS count,
      encode(sha256(convert_to(COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text,'UTF8')),'hex') AS hash
      FROM ${table} t WHERE venue_id=$1`, [ids.venue])).rows[0];
    return result;
  };
  const beforeApply = await state();
  await assert.rejects(service.applyRefundAwareCorrection({ ...owner, userId: ids.employee }, command), error => error.status === 403);
  await assert.rejects(service.applyRefundAwareCorrection(owner, { ...command, expectedPlanHash: 'f'.repeat(64) }), error => error.code === 'payroll_refund_correction_plan_stale');
  assert.deepEqual(await state(), beforeApply);
  for (const table of ['payroll_refund_aware_paid_assessments', 'payroll_correction_claims', 'payroll_correction_batches',
    'payroll_correction_events', 'payroll_entries', 'payroll_correction_requests']) {
    let injected = false;
    const failing = makeService({ query: (...args) => pool.query(...args), connect: async () => {
      const db = await pool.connect();
      return { query: async (sql, values) => {
        const result = await db.query(sql, values);
        if (!injected && new RegExp(`^(INSERT INTO|UPDATE) ${table}(?:\\s|\\()`).test(String(sql).trim())) {
          injected = true; await db.query('SELECT 1/0');
        }
        return result;
      }, release: error => db.release(error) };
    } });
    await assert.rejects(failing.applyRefundAwareCorrection(owner, { ...command, idempotencyKey: `period-fault:${table}` }));
    assert.equal(injected, true, `${table}: actual write reached`);
    assert.deepEqual(await state(), beforeApply, `${table}: complete rollback preserves paid source and future net`);
  }
  const applied = await Promise.all([service.applyRefundAwareCorrection(owner, command), service.applyRefundAwareCorrection(owner, command)]);
  assert.deepEqual(applied.map(row => row.replayed).sort(), [false, true]);
  assert.equal(applied[0].batchId, applied[1].batchId);
  const afterApply = await state();
  await assert.rejects(service.applyRefundAwareCorrection(owner, { ...command, reason: 'Changed command with same key' }), error => error.code === 'payroll_refund_correction_idempotency_conflict');
  assert.deepEqual(await state(), afterApply);
  assert.equal((await service.getRefundAwareCorrectionContext(owner, original.id)).remainingCents, 0);
  await transition(target.id, 'cancel');
  assert.equal((await service.getRefundAwareCorrectionContext(owner, original.id)).remainingCents, 500);
  const historical = (await pool.query('SELECT amount::text,status FROM payroll_entries WHERE id=$1', [target.id])).rows[0];
  assert.deepEqual(historical, { amount: '0.00', status: 'cancelled' });
  targetRun = await service.createRefundAwareRun(owner, { schemeVersionId: targetVersion.versionId,
    periodFrom: targetPeriod.from, periodTo: targetPeriod.to, idempotencyKey: 'period-target-after-cancellation' });
  target = await materialize(targetRun.runId, ids.employee);
  const second = await previewFor();
  await service.applyRefundAwareCorrection(owner, { ...command, targetEntryId: target.id,
    expectedPlanHash: second.planHash, idempotencyKey: 'period-second-apply' });
  await transition(target.id, 'approve'); await transition(target.id, 'pay');
  assert.equal((await service.applyRefundAwareCorrection(owner, command)).replayed, true, 'original receipt survives target cancellation and later settlement');
  await refund('0.5', 'paid-period-second-half');
  const afterSecond = await service.getRefundAwareCorrectionContext(owner, original.id);
  assert.equal(afterSecond.currentPotentialCents, 1000); assert.equal(afterSecond.remainingCents, 500);
  const waiver = await service.previewRefundAwareCorrection(owner, { operation: 'waive', originalEntryId: original.id, targetEntryId: null });
  assert.equal(waiver.firstAssessedCents, 500); assert.equal(waiver.highWaterAssessedCents, 1000); assert.equal(waiver.waiveCents, 500);
  const waiveCommand = { operation: 'waive', originalEntryId: original.id, targetEntryId: null,
    expectedPlanHash: waiver.planHash, reason: 'Owner waives the remaining reviewed period reduction', idempotencyKey: 'period-waive-rest' };
  const waived = await service.applyRefundAwareCorrection(owner, waiveCommand);
  assert.equal(waived.totalCents, 500); assert.equal((await service.applyRefundAwareCorrection(owner, waiveCommand)).replayed, true);
  assert.equal((await service.getRefundAwareCorrectionContext(owner, original.id)).remainingCents, 0);
  const claims = (await pool.query(`SELECT assessed_cents::text,source_kind,refund_line_event_id,source_snapshot_line_id
    FROM payroll_correction_claims WHERE venue_id=$1 AND original_entry_id=$2`, [ids.venue, original.id])).rows;
  assert.deepEqual(claims, [{ assessed_cents: '500', source_kind: 'period_v2', refund_line_event_id: null, source_snapshot_line_id: null }]);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM expenses WHERE venue_id=$1', [ids.venue])).rows[0].n, expensesBefore);
  assert.deepEqual((await pool.query(`SELECT id,status,amount::text,expense_id FROM payroll_entries
    WHERE venue_id=$1 AND calculation_run_id=$2 ORDER BY id`, [ids.venue, run.runId])).rows, originalRows);
  const guards = await verifyRefundAwareCorrectionStorageGuards({ pool, venueId: ids.venue, originalEntryId: original.id, targetEntryId: target.id, owner });
  console.log(`PASS actual208 storage: ${guards.checks} rollback-only guards, replay twice, immutable assessments, complete cohort, exact hash, mixed-basis and duplicate stable-claim refusal, current-limit protection`);
  console.log('PASS actual v2 paid whole-period correction: positive/zero source, stable first claim, current cumulative limit, concurrent apply, cancellation release, future zero settlement, later return and waiver; one original expense');
  return { status: 'passed', venueId: ids.venue, originalEntryId: original.id, targetEntryId: target.id };
}
