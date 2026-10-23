import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { seedUnpaidSupersessionFixture } from './payroll-unpaid-supersession-fixture.mjs';
import { verifyUnpaidSupersessionStorageGuards } from './payroll-unpaid-supersession-storage-guards.mjs';
const require = createRequire(import.meta.url);
const { makeService } = require('../payroll-scheme-service');

// The parent owns the disposable database and the one-at-a-time QA runner.
export async function verifyUnpaidSupersession({ pool, period, sourcePolicies }) {
  const { ids, owner, service, run, refund } = await seedUnpaidSupersessionFixture({ pool, period, sourcePolicies });
  const employees = [ids.employee, ids.zeroEmployee];
  const originals = [];
  for (const employeeId of employees) originals.push((await service.materializeCalculationEntry(owner, run.runId,
    { employeeId, financeCategoryId: null, idempotencyKey: `unpaid-initial:${employeeId}` })).entry);
  const tables = ['payroll_entries', 'expenses', 'payroll_calculation_runs', 'payroll_run_provenance', 'payroll_daily_snapshots',
    'payroll_daily_snapshot_lines', 'payroll_calculation_entry_transitions', 'payroll_calculation_entry_transition_requests',
    'payroll_calculation_entry_requests', 'payroll_run_supersession_requests', 'payroll_correction_events'];
  const state = async () => {
    const result = {};
    for (const table of tables) result[table] = (await pool.query(`SELECT count(*)::int AS count,
      encode(sha256(convert_to(COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text,'UTF8')),'hex') AS hash
      FROM ${table} t WHERE venue_id=$1`, [ids.venue])).rows[0];
    return result;
  };
  const before = await state();
  await assert.rejects(service.previewUnpaidRunSupersession({ ...owner, userId: ids.employee }, run.runId), e => e.status === 403);
  const prior = await service.previewUnpaidRunSupersession(owner, run.runId);
  assert.equal(prior.monetaryWrites, false);
  assert.equal((await service.previewUnpaidRunSupersession(owner, run.runId)).planHash, prior.planHash, 'closure clock must not invalidate same-source plan');
  assert.deepEqual(await state(), before, 'preview writes nothing');
  await refund('0.5', 'unpaid-first-half-return');
  const preview = await service.previewUnpaidRunSupersession(owner, run.runId);
  assert.notEqual(preview.planHash, prior.planHash);
  assert.equal(preview.replacementAmounts.reduce((sum, row) => sum + row.amountCents, 0), 500);
  const command = { expectedPlanHash: preview.planHash, reason: 'Owner replaces the whole unpaid cohort after a merchandise return', idempotencyKey: 'unpaid-whole-replacement' };
  const refundedState = await state();
  await assert.rejects(service.commitUnpaidRunSupersession(owner, run.runId, { ...command, expectedPlanHash: prior.planHash }), e => e.status === 409);
  assert.deepEqual(await state(), refundedState);
  // Fail only after real writes. Every table, including cancelled originals,
  // child receipts and snapshots, must return to the exact pre-command state.
  for (const failedTable of ['payroll_calculation_entry_transitions', 'payroll_calculation_entry_transition_requests',
    'payroll_calculation_runs', 'payroll_run_provenance', 'payroll_daily_snapshot_lines', 'payroll_entries',
    'payroll_calculation_entry_requests', 'payroll_run_supersession_requests']) {
    let injected = false;
    const failing = makeService({ query: (...args) => pool.query(...args), connect: async () => {
      const db = await pool.connect();
      return { query: async (sql, values) => {
        const result = await db.query(sql, values);
        if (!injected && new RegExp(`^INSERT INTO ${failedTable}(?:\\s|\\()`).test(String(sql).trim())) {
          injected = true; await db.query('SELECT 1/0');
        }
        return result;
      }, release: error => db.release(error) };
    } });
    await assert.rejects(failing.commitUnpaidRunSupersession(owner, run.runId,
      { ...command, idempotencyKey: `unpaid-fault:${failedTable}` }), e => e.code === '22012');
    assert.equal(injected, true, `${failedTable} actual write reached`);
    assert.deepEqual(await state(), refundedState, `${failedTable}: complete rollback`);
  }
  const results = await Promise.all([service.commitUnpaidRunSupersession(owner, run.runId, command),
    service.commitUnpaidRunSupersession(owner, run.runId, command)]);
  assert.equal(results[0].replacementRunId, results[1].replacementRunId);
  assert.deepEqual(results.map(row => row.replayed).sort(), [false, true]);
  const result = results[0];
  assert.equal(result.entries.length, 2);
  assert.equal(result.entries.reduce((sum, row) => sum + row.amountCents, 0), 500);
  const old = await service.listCalculationEntries(owner, run.runId);
  assert.ok(old.items.every(row => row.status === 'cancelled'));
  const replacement = await service.listCalculationEntries(owner, result.replacementRunId);
  assert.equal(replacement.items.length, 2);
  assert.ok(replacement.items.every(row => row.status === 'draft'));
  assert.equal(replacement.items.reduce((sum, row) => sum + row.amountCents, 0), 500);
  assert.deepEqual(replacement.items.map(row => row.userId).sort(), employees.sort());
  assert.equal((await service.getSavedRun(owner, run.runId)).amountCents, 1000);
  assert.equal((await service.getSavedRun(owner, result.replacementRunId)).amountCents, 500);
  assert.equal((await service.checkSavedRunFreshness(owner, result.replacementRunId)).status, 'current');
  const finalState = await state();
  assert.equal(finalState.expenses.count, 0); assert.equal(finalState.payroll_run_supersession_requests.count, 1);
  assert.equal((await service.commitUnpaidRunSupersession(owner, run.runId, command)).replayed, true);
  await assert.rejects(service.commitUnpaidRunSupersession(owner, run.runId, { ...command, reason: 'Changed reason with same key' }), e => e.status === 409);
  await assert.rejects(service.commitUnpaidRunSupersession(owner, run.runId, { ...command, idempotencyKey: 'unpaid-competing-command' }), e => e.status === 409);
  assert.deepEqual(await state(), finalState);
  await refund('0.5', 'unpaid-second-half-return');
  const chainedPreview = await service.previewUnpaidRunSupersession(owner, result.replacementRunId);
  const chained = await service.commitUnpaidRunSupersession(owner, result.replacementRunId,
    { expectedPlanHash: chainedPreview.planHash, reason: 'Second return replaces the remaining unpaid cohort', idempotencyKey: 'unpaid-chained-replacement' });
  assert.equal(chained.entries.length, 2);
  assert.equal(chained.entries.reduce((sum, row) => sum + row.amountCents, 0), 0);
  assert.ok((await service.listCalculationEntries(owner, result.replacementRunId)).items.every(row => row.status === 'cancelled'));
  assert.ok((await service.listCalculationEntries(owner, chained.replacementRunId)).items.every(row => row.status === 'draft' && row.amountCents === 0));
  assert.equal((await service.replaySavedRun(owner, run.runId)).verification.status, 'matched');
  assert.equal((await service.getSavedRun(owner, result.replacementRunId)).amountCents, 500);
  assert.equal((await state()).expenses.count, 0);
  assert.equal((await verifyUnpaidSupersessionStorageGuards({ pool, venueId: ids.venue,
    originalRunId: run.runId, replacementRunId: chained.replacementRunId, owner })).status, 'passed');
  console.log('PASS actual atomic unpaid v2 supersession: all employees/zero rows, old immutable run, stale plan, eight real-write rollback stages, concurrent and historical exact replay, no expense');
  return { status: 'passed', runId: run.runId, replacementRunId: result.replacementRunId };
}
