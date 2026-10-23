import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { buildPayrollRefundAwareSnapshot } = require('../payroll-refund-aware-snapshot.js');
const { mapPayrollTypedSnapshotRows } = require('../payroll-typed-snapshot-serializer.js');
const { mapPayrollMilestoneStorageRows } = require('../payroll-milestone-storage-serializer.js');
const { makePayrollRefundAwareFixture, payrollRefundAwareModes } = await import('./payroll-refund-aware-calculation-contract.mjs');

const frozen = value => !value || typeof value !== 'object' || Object.isFrozen(value) && Object.values(value).every(frozen);
let checks = 0;
const check = (value, label) => { assert.ok(value, label); checks++; };

// Invalid and incomplete source contexts must stay detached and fail closed.
for (const args of [undefined, {}, { venueId: 'not-a-uuid', runId: 'not-a-uuid' },
  { venueId: '00000000-0000-4000-8000-000000000001', runId: '00000000-0000-4000-8000-000000000002',
    scheme: {}, period: {}, periodClosure: {}, recognitionEvidence: {}, employmentEligibility: {} }]) {
  const result = buildPayrollRefundAwareSnapshot(args);
  check(result.status === 'blocked', 'bad source is blocked');
  check(result.officialReady === false && result.payoutEligible === false && result.sourceAttested === false
    && result.persistence === 'none', 'blocked output carries no authority');
  check(result.snapshotInput === null && result.mappedRows === null && result.milestoneRows === null
    && result.refundQuantityEvidence === null, 'blocked output carries no partial DTO');
  check(frozen(result), 'blocked result is immutable');
}

const result = buildPayrollRefundAwareSnapshot({
  venueId: '00000000-0000-4000-8000-000000000001', runId: '00000000-0000-4000-8000-000000000002',
  scheme: { versionId: '00000000-0000-4000-8000-000000000003' }, period: { from: '2026-09-01', to: '2026-09-30' },
  periodClosure: {}, recognitionEvidence: {}, employmentEligibility: {}
});
check(result.status === 'blocked' && result.reasons.length === 1, 'invalid policy or source cannot produce a candidate snapshot');
check(result.verifiedCalculation?.officialReady !== true && result.verifiedCalculation?.payoutEligible !== true
  && result.verifiedCalculation?.persistence !== 'ready', 'calculation is never upgraded by adapter');

const id = n => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;
const cents = value => { const match = /^(-?)(\d+)\.(\d{2})$/.exec(value); assert.ok(match, `invalid decimal ${value}`);
  return Number(BigInt(`${match[1]}${match[2]}${match[3]}`)); };
const deepFrozen = value => !value || typeof value !== 'object' || Object.isFrozen(value) && Object.values(value).every(deepFrozen);
const good = (mode, options = {}) => {
  const sourceArgs = makePayrollRefundAwareFixture(mode, options), before = structuredClone(sourceArgs);
  const snapshot = buildPayrollRefundAwareSnapshot({ ...sourceArgs, runId: id(900) });
  assert.equal(snapshot.status, 'refund_aware_snapshot_input', `${mode}/${options.fullReturn ? 'full' : 'partial'}: ${snapshot.reasons}`);
  assert.equal(snapshot.officialReady, false); assert.equal(snapshot.payoutEligible, false);
  assert.equal(snapshot.sourceAttested, false); assert.equal(snapshot.persistence, 'none');
  assert.equal(snapshot.verifiedCalculation.status, 'refund_aware_calculated');
  assert.deepEqual(sourceArgs, before, 'snapshot mapping must not mutate source evidence');
  assert.ok(deepFrozen(snapshot));
  assert.equal(Boolean(snapshot.snapshotInput.sourceAttendanceApproval), Array.isArray(snapshot.verifiedCalculation.input.attendance));
  if (snapshot.snapshotInput.sourceAttendanceApproval) assert.equal(snapshot.snapshotInput.sourceAttendanceApproval.approvalId,
    sourceArgs.approvedAttendanceSource.sourceAttendanceApproval.approvalId);
  assert.equal(Array.isArray(snapshot.snapshotInput.attendance), Array.isArray(snapshot.verifiedCalculation.input.attendance));
  if (Array.isArray(snapshot.snapshotInput.attendance)) assert.equal(snapshot.snapshotInput.attendance.length,
    sourceArgs.approvedAttendanceSource.attendance.length);
  assert.equal(snapshot.milestoneRows.milestoneEvidenceVersion, 0);
  assert.equal(snapshot.snapshotInput.sourceLines.length, snapshot.verifiedCalculation.input.sales.length);
  assert.equal(snapshot.mappedRows.snapshotLines.length, snapshot.snapshotInput.sourceLines.length);
  assert.deepEqual(mapPayrollTypedSnapshotRows(snapshot.snapshotInput), snapshot.mappedRows, 'typed snapshot canonical remap');
  assert.deepEqual(mapPayrollMilestoneStorageRows(snapshot.snapshotInput), snapshot.milestoneRows, 'milestone snapshot canonical remap');
  const projection = snapshot.verifiedCalculation.economics.projection;
  const line = snapshot.snapshotInput.sourceLines[0], projected = projection.saleLines.find(row => row.saleLineEventId === line.id);
  assert.equal(line.quantity, projected.quantity, 'typed snapshot retains original quantity');
  assert.equal(line.refundCents, projected.refundCents);
  assert.equal(line.commissionBaseCents, projected.remainingNetCents);
  assert.equal(line.grossCents, projected.grossMinor);
  assert.equal(line.discountCents, projected.discountMinor);
  const mappedLine = snapshot.mappedRows.snapshotLines[0];
  assert.equal(mappedLine.quantity, projected.quantity);
  assert.equal(cents(mappedLine.refund_amount), projected.refundCents);
  assert.equal(cents(mappedLine.commission_base_net), projected.remainingNetCents);
  assert.equal(cents(mappedLine.gross_amount), projected.grossMinor);
  assert.equal(cents(mappedLine.discount_amount), projected.discountMinor);
  assert.equal(snapshot.refundQuantityEvidence.lines[0].originalQuantity, projected.quantity);
  assert.equal(snapshot.refundQuantityEvidence.lines[0].returnedQuantity, projected.cumulativeReturnedQuantity);
  assert.equal(snapshot.refundQuantityEvidence.lines[0].remainingQuantity, projected.remainingQuantity);
  assert.deepEqual(snapshot.refundQuantityEvidence.lines[0].refundEventIds,
    projection.recognitionHistory.refundLines.filter(row => row.originalSaleLineEventId === line.id).map(row => row.refundEventId).sort());
  assert.equal(snapshot.snapshotInputWatermark, buildPayrollRefundAwareSnapshot({ ...sourceArgs, runId: id(900) }).snapshotInputWatermark,
    'snapshot DTO and evidence hash must be deterministic');
  const dailyTotal = snapshot.mappedRows.dailySnapshots.reduce((sum, row) => sum + cents(row.final_amount), 0);
  assert.equal(dailyTotal, snapshot.verifiedCalculation.amountCents, 'mapped daily totals reconcile to candidate calculation');
  if (options.fullReturn) {
    assert.equal(projected.quantity, '1.000');
    assert.equal(projected.remainingQuantity, '0.000');
    assert.equal(line.quantity, '1.000');
    assert.equal(line.commissionBaseCents, 0);
    if (mode === 'margin_target') assert.equal(line.costSnapshot.costCents, 100, 'full return keeps original frozen cost');
  }
  return snapshot;
};

for (const mode of payrollRefundAwareModes) {
  const partial = good(mode), full = good(mode, { fullReturn: true });
  assert.equal(partial.refundQuantityEvidence.manifestWatermark, partial.verifiedCalculation.economics.manifestWatermark);
  assert.equal(partial.refundQuantityEvidence.economicWatermark, partial.verifiedCalculation.economics.sourceWatermark);
  assert.equal(full.snapshotInput.sourceLines[0].commissionBaseCents, 0);
}

// The source manifest contains the in-period original sale while the sealed
// projection carries its later, out-of-period refund history.
{
  const snapshot = good('percent_only');
  const history = snapshot.refundQuantityEvidence.lines[0];
  assert.equal(history.recognizedLocalDate.slice(0, 7), '2026-10');
  assert.ok(snapshot.verifiedCalculation.economics.projection.recognitionHistory.refundEvents
    .some(event => event.recognizedLocalDate > snapshot.verifiedCalculation.period.to), 'late refund history is retained in candidate evidence');
}

console.log(`payroll refund-aware snapshot contract: PASS (${checks} fail-closed assertions plus all-mode success mapping)`);
