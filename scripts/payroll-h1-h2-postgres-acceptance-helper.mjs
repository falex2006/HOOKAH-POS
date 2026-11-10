import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { makeService } = require('../payroll-scheme-service');

const payInput = (idempotencyKey, accountId) => ({ action: 'pay', idempotencyKey,
  paymentDate: new Date().toISOString().slice(0, 10), paymentAccountId: accountId,
  paymentMethod: 'card', reason: null });
const cancelInput = (idempotencyKey, reason) => ({ action: 'cancel', idempotencyKey,
  paymentDate: null, paymentAccountId: null, paymentMethod: null, reason });
const linkedExpenses = async (pool, venueId, entryIds) => (await pool.query(`SELECT payroll_calculation_entry_id::text AS entry_id,
    count(*)::int AS count FROM expenses WHERE venue_id=$1 AND payroll_calculation_entry_id=ANY($2::uuid[])
    GROUP BY payroll_calculation_entry_id ORDER BY payroll_calculation_entry_id`, [venueId, entryIds])).rows;

// Real-source fixture callback inserts a partial return against a day-15 sale
// after the first H2 candidate has been persisted. It returns the resulting
// recognized refund event for the caller to verify independently.
export async function verifyH1H2PostgresAcceptance({ service, pool, owner, ids, period, schemeVersionId,
  initialMonthlyRun, h1EmployeeId, h1EntryId, h2OnlyEmployeeId, paymentAccountId,
  observeH1, createLateRefund }) {
  assert.equal(typeof service.materializeSecondHalfCalculationEntry, 'function',
    'schema5 H2 writer must be integrated before this acceptance scope is run');
  assert.equal(typeof service.listCalculationEntries, 'function');
  assert.equal(typeof observeH1, 'function'); assert.equal(typeof createLateRefund, 'function');
  assert.equal(initialMonthlyRun.status, 'ready');

  const h1Approved = await service.getCalculationEntryState(owner, h1EntryId);
  assert.equal(h1Approved.entry.status, 'approved', 'case A starts with approved H1');
  assert.equal(h1Approved.sourceStatus, 'current');
  assert.ok(h1Approved.allowedActions.includes('pay'));
  const month = period.from.slice(0, 7), monthlyRunId = initialMonthlyRun.runId;
  const materialize = (employeeId, key) => service.materializeSecondHalfCalculationEntry(owner, monthlyRunId,
    { employeeId, financeCategoryId: null, idempotencyKey: key });
  const firstPair = await Promise.all([
    materialize(h1EmployeeId, 'h2-a-initial-materialize'),
    materialize(h1EmployeeId, 'h2-a-initial-materialize')
  ]);
  const h2A = firstPair[0].currentEntry || firstPair[0].entry;
  const h2AReplay = firstPair[1].currentEntry || firstPair[1].entry;
  assert.equal(h2A.id, h2AReplay.id, 'same H2 POST key under concurrency resolves to one entry');
  assert.equal(h2A.halfKind, 'h2'); assert.equal(h2A.monthlyRunId, monthlyRunId);
  assert.equal(h2A.periodFrom, `${month}-15`); assert.ok(h2A.grossCents > 0);
  assert.deepEqual(firstPair.map(row => row.replayed).sort(), [false, true]);

  // Case B has no H1 entry because its only attributable sale is on day 15.
  // Successful H2 creation with an exact zero H1 basis proves the verified
  // zero-base path rather than treating absent H1 data as zero implicitly.
  const noH1Entry = (await pool.query(`SELECT count(*)::int AS count FROM payroll_entries
    WHERE venue_id=$1 AND user_id=$2 AND period_from=$3::date AND period_to=$4::date AND payroll_half_kind='h1'`,
  [ids.venue, h2OnlyEmployeeId, period.from, `${month}-14`])).rows[0];
  assert.equal(noH1Entry.count, 0);
  const h2BResult = await materialize(h2OnlyEmployeeId, 'h2-b-zero-h1-materialize');
  const h2B = h2BResult.currentEntry || h2BResult.entry;
  assert.equal(h2B.halfKind, 'h2'); assert.equal(h2B.monthlyRunId, monthlyRunId);
  assert.ok(h2B.grossCents > 0, 'case B earns only in H2');
  assert.equal(h2B.h2Reconciliation.h1GrossAccruedMinor, 0);
  assert.equal(h2B.h2Reconciliation.h2GrossAccruedMinor, h2B.h2Reconciliation.monthlyGrossMinor,
    'the persisted zero-base proof reconciles the full monthly gross to H2');

  const listed = await service.listCalculationEntries(owner, monthlyRunId);
  assert.equal(listed.items.filter(row => row.id === h2A.id || row.id === h2B.id).length, 2,
    'reload exposes per-employee H2 child entries on the monthly run');
  assert.equal(listed.items.find(row => row.id === h2A.id).halfKind, 'h2');

  const migration = spawnSync(process.execPath,[fileURLToPath(new URL('./migrate.js',import.meta.url))],
    {env:{...process.env,DATABASE_URL:process.env.MIGRATIONS_PG_TEST_DATABASE_URL},encoding:'utf8',windowsHide:true});
  assert.equal(migration.status,0,migration.stderr);
  const afterMigration=await service.listCalculationEntries(owner,monthlyRunId);
  assert.deepEqual(afterMigration.items,listed.items,'populated migration replay preserves both original H2 claims');
  const h1State = await service.getCalculationEntryState(owner, h1EntryId);
  const h1Paid = await service.transitionCalculationEntry(owner, h1EntryId,
    { ...payInput('h2-a-pay-h1', paymentAccountId), expectedStateHash: h1State.stateHash });
  assert.equal(h1Paid.entry.status, 'paid');
  const h1AfterPay = await observeH1(h1EmployeeId);
  assert.equal(h1AfterPay.status, 'paid'); assert.equal(h1AfterPay.usableForH2, true);

  const refund = await createLateRefund();
  assert.ok(refund?.recognizedLocalDate > period.to, 'partial refund is recognized after the closed sale month');
  const oldH2Amounts = { a: h2A.grossCents, b: h2B.grossCents };
  for (const entry of [h2A, h2B]) {
    const state = await service.getCalculationEntryState(owner, entry.id);
    const cancelled = await service.transitionCalculationEntry(owner, entry.id,
      { ...cancelInput(`h2-cancel-${entry.userId.slice(-6)}`, 'Replace draft after recognized late refund'),
        expectedStateHash: state.stateHash });
    assert.equal(cancelled.entry.status, 'cancelled');
  }

  const revisedMonthly = await service.createRefundAwareRun(owner, { schemeVersionId,
    periodFrom: period.from, periodTo: period.to, idempotencyKey: 'h2-monthly-after-late-refund' });
  assert.equal(revisedMonthly.status, 'ready', JSON.stringify(revisedMonthly));
  assert.notEqual(revisedMonthly.runId, monthlyRunId);
  const replacement = employeeId => service.materializeSecondHalfCalculationEntry(owner, revisedMonthly.runId,
    { employeeId, financeCategoryId: null, idempotencyKey: `h2-revised-${employeeId.slice(-8)}` });
  const revised = await Promise.all([replacement(h1EmployeeId), replacement(h2OnlyEmployeeId)]);
  const h2AReplacement = revised[0].currentEntry || revised[0].entry;
  const h2BReplacement = revised[1].currentEntry || revised[1].entry;
  assert.equal(h2AReplacement.halfKind, 'h2'); assert.notEqual(h2AReplacement.id, h2A.id);
  assert.ok(h2AReplacement.grossCents < oldH2Amounts.a,
    `late refund must reduce H2 accrued amount (${oldH2Amounts.a} -> ${h2AReplacement.grossCents})`);
  assert.equal(oldH2Amounts.b, h2BReplacement.grossCents, 'refund of A leaves B H2 unchanged');
  assert.equal(h2AReplacement.h2Reconciliation.monthlyGrossMinor - h2AReplacement.h2Reconciliation.h1GrossAccruedMinor,
    h2AReplacement.h2Reconciliation.h2GrossAccruedMinor);
  assert.equal((await observeH1(h1EmployeeId)).status, 'paid', 'H1 paid identity survives H2 recomputation');

  const h2State = await service.getCalculationEntryState(owner, h2AReplacement.id);
  assert.equal(h2State.sourceStatus, 'current'); assert.ok(h2State.allowedActions.includes('approve'));
  const h2Approved = await service.transitionCalculationEntry(owner, h2AReplacement.id, { action: 'approve',
    expectedStateHash: h2State.stateHash, idempotencyKey: 'h2-a-approve-final',
    paymentDate: null, paymentAccountId: null, paymentMethod: null, reason: null });
  assert.equal(h2Approved.entry.status, 'approved');

  const approvedState = await service.getCalculationEntryState(owner,h2AReplacement.id);
  assert.ok(approvedState.allowedActions.includes('pay'));
  const h1AndH2 = [h1EntryId, h2AReplacement.id];
  const beforeRollback = await linkedExpenses(pool, ids.venue, h1AndH2);
  assert.equal(beforeRollback.length, 1, 'only the paid H1 entry has an expense before H2 payment');
  let injected = false;
  const failingPool = { query: (...args) => pool.query(...args), connect: async () => {
    const client = await pool.connect();
    return { query: async (sql, values) => {
      const result = await client.query(sql, values);
      if (!injected && String(sql).trimStart().startsWith('INSERT INTO expenses')) {
        injected = true;
        throw Object.assign(new Error('injected_h2_payment_rollback'), { code: '22012' });
      }
      return result;
    }, release: error => client.release(error) };
  } };
  const failingService = makeService(failingPool), payKey = 'h2-a-pay-final';
  await assert.rejects(failingService.transitionCalculationEntry(owner, h2AReplacement.id,
    { ...payInput(payKey, paymentAccountId), expectedStateHash: approvedState.stateHash }), error => error.code === 'payroll_entry_lifecycle_unavailable' && error.status === 503);
  assert.equal(injected, true);
  assert.deepEqual(await linkedExpenses(pool, ids.venue, h1AndH2), beforeRollback,
    'failed H2 pay rolls back its expense and transition without extra money');
  assert.equal((await service.getCalculationEntryState(owner, h2AReplacement.id)).entry.status, 'approved');

  const h2Paid = await service.transitionCalculationEntry(owner, h2AReplacement.id,
    { ...payInput(payKey, paymentAccountId), expectedStateHash: approvedState.stateHash });
  assert.equal(h2Paid.entry.status, 'paid'); assert.ok(h2Paid.entry.expenseId);
  const paidReplay = await service.transitionCalculationEntry(owner, h2AReplacement.id,
    { ...payInput(payKey, paymentAccountId), expectedStateHash: approvedState.stateHash });
  assert.equal(paidReplay.replayed, true); assert.equal(paidReplay.entry.expenseId, h2Paid.entry.expenseId);
  const finalExpenses = await linkedExpenses(pool, ids.venue, h1AndH2);
  assert.deepEqual(finalExpenses.map(row => [row.entry_id, row.count]), h1AndH2.sort().map(id => [id, 1]),
    'one and only one expense is linked to each paid H1/H2 entry');
  assert.equal((await service.getCalculationEntryState(owner, h2AReplacement.id)).entry.status, 'paid');
  return { monthlyRunId, revisedMonthlyRunId: revisedMonthly.runId,
    h1EntryId, h2DraftEntryId: h2A.id, h2EntryId: h2AReplacement.id,
    oldH2Cents: oldH2Amounts.a, revisedH2Cents: h2AReplacement.grossCents,
    refundId: refund.id, expenseCounts: finalExpenses };
}
