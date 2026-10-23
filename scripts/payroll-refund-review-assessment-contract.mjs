import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { calculatePayrollScheme } = require('../payroll-schemes');
const { buildCalculatorReplay } = require('../payroll-calculator-replay');
const { buildPayrollRefundReviewAssessment: build, collectPayrollRefundReviewAssessment: collect } = require('../payroll-refund-review-assessment');
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().filter(key => value[key] !== undefined)
    .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const sha = value => createHash('sha256').update(canonical(value)).digest('hex');
const money = cents => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
const fixture = ({ base = 10000, rate = 1000, mode = 'percent_only', returned = [2500], cap = null, roleMode = null, perShiftCents = 0 } = {}) => {
  const scheme = { id: id(2), versionId: id(3), currency: 'RUB', mode,
    roleParameters: { bartender: { stableRateBps: rate, perShiftCents, bracketRatesBps: { 0: rate }, ...(cap ? { cap } : {}), ...(roleMode ? { mode: roleMode } : {}) } },
    employeeOverrides: [], itemRules: [], applyMilestones: false };
  const input = { periodFrom: '2026-09-01', periodTo: '2026-09-01',
    coverage: { kind: 'month_to_date_complete', from: '2026-09-01', through: '2026-09-01', complete: true, watermark: 'fixture' },
    attendance: perShiftCents ? [{ id: id(15), employeeId: id(4), date: '2026-09-01', approved: true, workedMinutes: 480, plannedMinutes: 480 }] : [],
    attendanceCoverage: { kind: 'approved_attendance_complete', from: '2026-09-01', through: '2026-09-01', complete: true, watermark: 'fixture-attendance' },
    employees: [{ id: id(4) }], roleAssignments: [{ employeeId: id(4), roleId: 'bartender', effectiveFrom: '2026-09-01' }],
    sales: [{ id: id(5), employeeId: id(4), date: '2026-09-01', menuItemId: id(6), department: 'bar', commissionBaseCents: base, turnoverCents: base }],
    sourceEvidence: {}, scheme };
  const result = calculatePayrollScheme(input);
  assert.equal(result.status, 'ready');
  const evidence = { schemaVersion: 1, venueId: id(1), runId: id(7), schemeVersionId: id(3), currency: 'RUB',
    period: { from: input.periodFrom, to: input.periodTo }, schemeSnapshot: scheme,
    calculatorReplay: structuredClone(buildCalculatorReplay(input, result)) };
  const snapshotLines = [{ id: id(8), snapshotId: id(9), venueId: id(1), runId: id(7), employeeId: id(4),
    localDate: input.periodFrom, employeeName: 'Сотрудник из снимка', menuItemName: 'Название из снимка', orderId: id(10), orderItemId: id(11), commissionBase: money(base),
    commissionAmount: money(result.daily[0].lines[0].commissionCents), originalSaleLineEventId: id(5),
    originalSaleEventId: id(12), pricingSnapshotId: id(13), pricingLineId: id(14) }];
  let previous = 0;
  const refundRows = returned.map((amount, index) => {
    const row = { venueId: id(1), orderId: id(10), orderItemId: id(11), originalSaleEventId: id(12),
      originalSaleLineEventId: id(5), pricingSnapshotId: id(13), refundId: id(100 + index), refundEventId: id(200 + index),
      refundItemId: id(300 + index), refundLineEventId: id(400 + index), producerSequence: index + 1,
      returnedItemValueMinor: String(amount), previousReturnedItemValueMinor: String(previous), cumulativeReturnedItemValueMinor: String(previous + amount),
      refundRecognizedDate: '2026-10-23', refundRecognizedAt: '2026-10-23T10:00:00.000000Z', refundTimezone: 'UTC' };
    previous += amount; return row;
  });
  const manifest = { schemaVersion: 1, status: 'available', venueId: id(1), currency: 'RUB', period: evidence.period,
    watermark: 'a'.repeat(64), reasons: [], saleLines: [{ saleLineEventId: id(5), saleEventId: id(12), snapshotId: id(13),
      orderId: id(10), orderItemId: id(11), pricingLineId: id(14), sellerId: id(4), recognizedLocalDate: input.periodFrom,
      productFacts: { productId: id(6) }, netMinor: base }],
    refundHistory: returned.length ? [{ orderId: id(10), orderItemId: id(11), originalSaleLineEventId: id(5), cumulativeReturnedItemValueMinor: previous }] : [],
    relatedRefundCoverage: { status: 'complete', sourceWatermark: 'a'.repeat(64), coveredOrderIds: [id(10)],
      relatedRefundHeaderIds: refundRows.map(row => row.refundId), relatedRefundEventIds: refundRows.map(row => row.refundEventId),
      relatedRefundItemIds: refundRows.map(row => row.refundItemId), relatedRefundLineEventIds: refundRows.map(row => row.refundLineEventId) } };
  return { header: { runId: id(7) }, evidence, provenanceSha256: sha(evidence), manifest, snapshotLines, refundRows };
};
let checks = 0;
const ok = (fn) => { fn(); checks++; };
const blocked = (f, code) => { const actual = build(f); assert.equal(actual.coverage, 'needs_review'); assert.equal(actual.impactCents, null);
  assert.ok(actual.reasons.includes(code), actual.reasons.join(',')); assert.ok(actual.lines.every(line => line.salaryImpactCents === null)); return actual; };
ok(() => { const actual = build(fixture()); assert.equal(actual.coverage, 'complete'); assert.equal(actual.impactCents, -250);
  assert.equal(actual.lines[0].merchandiseDeltaCents, -2500); assert.equal(actual.lines[0].salaryImpactCents, -250);
  assert.equal(actual.basis, 'saved_calculation_unposted'); assert.equal(actual.payoutEligible, false); assert.equal(actual.officialReady, false); });
ok(() => { const actual = build(fixture({ base: 10, rate: 1000, returned: [1, 5] })); assert.equal(actual.impactCents, -1);
  assert.deepEqual(actual.lines.map(row => row.salaryImpactCents), [0, -1]); });
ok(() => assert.equal(build(fixture({ base: 0, returned: [] })).impactCents, 0));
ok(() => assert.equal(build(fixture({ base: 99, rate: 0, returned: [99] })).impactCents, 0));
ok(() => assert.equal(build(fixture({ returned: [10000] })).impactCents, -1000));
ok(() => { const f = fixture(); f.refundRows[0].producerSequence = '1'; assert.equal(build(f).impactCents, -250); });
ok(() => { const actual = build(fixture()); assert.equal(actual.lines[0].employeeName, 'Сотрудник из снимка'); assert.equal(actual.lines[0].menuItemName, 'Название из снимка'); });
ok(() => assert.equal(build(fixture({ mode: 'stable_percent' })).impactCents, -250));
ok(() => blocked(fixture({ roleMode: 'progressive_daily' }), 'payroll_refund_review_nonlinear_mode_unsupported'));
ok(() => { const f = fixture({ returned: [1000, 2000] }); const a = build(f); f.refundRows.reverse(); assert.deepEqual(build(f), a); });
ok(() => { const f = fixture(); const before = structuredClone(f); build(f); assert.deepEqual(f, before); });
ok(() => { const f = fixture(); const a = build(f); f.refundRows[0].refundRecognizedAt = '2026-10-23T10:00:01.000000Z'; assert.notEqual(build(f).sourceHash, a.sourceHash); });
ok(() => { const f = fixture(); f.manifest.status = 'incomplete'; f.manifest.reasons = ['refund_source_coverage_incomplete']; blocked(f, 'payroll_refund_review_source_coverage_incomplete'); });
ok(() => { const f = fixture(); f.refundRows[0].originalSaleLineEventId = id(999); blocked(f, 'payroll_refund_review_refund_lineage_mismatch'); });
ok(() => { const f = fixture(); f.snapshotLines[0].employeeId = id(999); blocked(f, 'payroll_refund_review_original_line_mismatch'); });
ok(() => { const f = fixture(); f.snapshotLines[0].commissionAmount = '20.00'; blocked(f, 'payroll_refund_review_original_line_mismatch'); });
ok(() => { const f = fixture(); f.refundRows = []; blocked(f, 'payroll_refund_review_all_time_coverage_mismatch'); });
ok(() => { const f = fixture(); f.refundRows.push(structuredClone(f.refundRows[0])); blocked(f, 'payroll_refund_review_refund_item_coverage_mismatch'); });
ok(() => { const f = fixture(); f.refundRows[0].producerSequence = 2; blocked(f, 'payroll_refund_review_scalar_lineage_or_amount_unsupported'); });
ok(() => blocked(fixture({ returned: [10001] }), 'payroll_refund_review_scalar_lineage_or_amount_unsupported'));
ok(() => blocked(fixture({ mode: 'progressive_daily' }), 'payroll_refund_review_nonlinear_mode_unsupported'));
ok(() => blocked(fixture({ cap: { basis: 'employee_department_day', department: 'bar', rateBps: 500 } }), 'payroll_refund_review_nonlinear_components_unsupported'));
ok(() => { const f = fixture(); f.evidence.calculatorReplay.engineRevision = 'b'.repeat(64); f.provenanceSha256 = sha(f.evidence); blocked(f, 'payroll_refund_review_replay_unavailable'); });
ok(() => { const f = fixture(); delete f.evidence.calculatorReplay; f.provenanceSha256 = sha(f.evidence); blocked(f, 'payroll_refund_review_replay_unavailable'); });
for (const missing of [false, true]) ok(() => {
  const f = fixture();
  if (missing) delete f.evidence.calculatorReplay;
  else f.evidence.calculatorReplay.engineRevision = 'b'.repeat(64);
  f.provenanceSha256 = sha(f.evidence);
  const actual = blocked(f, 'payroll_refund_review_replay_unavailable'), line = actual.lines[0];
  assert.equal(line.sourceSnapshotLineId, f.snapshotLines[0].id);
  assert.equal(line.sourceSnapshotId, f.snapshotLines[0].snapshotId);
  assert.equal(line.employeeId, f.snapshotLines[0].employeeId);
  assert.equal(line.employeeName, f.snapshotLines[0].employeeName);
  assert.equal(line.pricingLineId, f.snapshotLines[0].pricingLineId);
  assert.equal(line.originalSaleLineEventId, f.refundRows[0].originalSaleLineEventId);
  assert.equal(line.merchandiseDeltaCents, -2500);
  assert.equal(line.salaryImpactCents, null, 'identity evidence never substitutes for numerical replay');
});
ok(() => { const f = fixture(); f.manifest.refundHistory[0].cumulativeReturnedItemValueMinor = 1; blocked(f, 'payroll_refund_review_return_history_mismatch'); });
ok(() => { const f = fixture(); f.refundRows[0].returnedItemValueMinor = '9007199254740992'; blocked(f, 'payroll_refund_review_return_amount_invalid'); });
ok(() => { const f = fixture(); f.refundRows[0].refundEventId = null; const actual = blocked(f, 'payroll_refund_review_refund_header_mismatch'); assert.equal(actual.lines.length, 1); });
ok(() => { const f = fixture(); f.refundRows[0].refundItemId = null; const actual = blocked(f, 'payroll_refund_review_refund_item_unavailable'); assert.equal(actual.lines.length, 1); });
ok(() => { const f = fixture(); f.provenanceSha256 = 'c'.repeat(64); assert.throws(() => build(f), /saved_context_invalid/); });
// The recognition reader can cover an extra order because its refund is in the
// period. Its raw identities must reconcile, but it is not this run's earning.
const withExtraCohort = () => {
  const f = fixture(), extra = { ...f.refundRows[0], orderId: id(700), orderItemId: id(701), originalSaleEventId: id(702),
    originalSaleLineEventId: id(703), pricingSnapshotId: id(704), refundId: id(705), refundEventId: id(706),
    refundItemId: id(707), refundLineEventId: id(708) };
  f.refundRows.push(extra);
  const covered = f.manifest.relatedRefundCoverage;
  covered.coveredOrderIds.push(extra.orderId);
  covered.relatedRefundHeaderIds.push(extra.refundId); covered.relatedRefundEventIds.push(extra.refundEventId);
  covered.relatedRefundItemIds.push(extra.refundItemId); covered.relatedRefundLineEventIds.push(extra.refundLineEventId);
  return f;
};
ok(() => { const original = build(fixture()), extra = build(withExtraCohort());
  assert.equal(extra.coverage, 'complete'); assert.equal(extra.impactCents, original.impactCents);
  assert.deepEqual(extra.lines, original.lines, 'an unrelated covered refund is not an employee earning in this run');
  assert.notEqual(extra.sourceHash, original.sourceHash, 'the covered cohort remains part of the source dependency'); });
ok(() => { const f = withExtraCohort(); f.refundRows.pop();
  const actual = blocked(f, 'payroll_refund_review_all_time_coverage_mismatch'); assert.equal(actual.lines.length, 1); });
ok(() => { const f = withExtraCohort(); const first = build(f);
  assert.deepEqual(build(structuredClone(f)), first, 'identical persisted facts have identical payloads');
  f.refundRows.reverse(); assert.deepEqual(build(f), first, 'SQL row order is not a source change'); });
ok(() => { const f = fixture({ mode: 'stable_percent', perShiftCents: 1000, returned: [9000] });
  const saved = structuredClone(f.evidence.calculatorReplay.result);
  assert.equal(saved.daily[0].employees[0].basePayCents, 1000); assert.equal(saved.employees[0].amountCents, 2000);
  blocked(f, 'payroll_refund_review_remaining_personal_ceiling_conflict');
  assert.deepEqual(f.evidence.calculatorReplay.result, saved, 'fixed pay and saved totals are not reduced to fit the new ceiling'); });
ok(() => { const f = fixture({ mode: 'stable_percent', perShiftCents: 1000, returned: [2500] });
  const actual = build(f); assert.equal(actual.coverage, 'complete'); assert.equal(actual.impactCents, -250);
  assert.equal(f.evidence.calculatorReplay.result.daily[0].employees[0].basePayCents, 1000, 'supported variable review preserves fixed pay'); });
// Isolated capability-dependency test: no engine file or engine result changes.
// A reload captures the alternative revision provider, then module state is
// restored even if the assertion fails. This tests hashing, not a deployment.
ok(() => { const modulePath = require.resolve('../payroll-refund-review-assessment');
  const existing = require.cache[modulePath], replayModule = require('../payroll-calculator-replay');
  const getManifest = replayModule.getCalculatorReplayEngineManifest;
  try {
    replayModule.getCalculatorReplayEngineManifest = () => ({ ...getManifest(), engineRevision: 'f'.repeat(64) });
    delete require.cache[modulePath];
    const isolatedBuild = require('../payroll-refund-review-assessment').buildPayrollRefundReviewAssessment;
    const f = fixture(), ordinary = build(f), alternative = isolatedBuild(f);
    assert.notEqual(alternative.sourceHash, ordinary.sourceHash, 'assessment engine capability is a sourceHash dependency');
    assert.equal(alternative.provenanceSha256, ordinary.provenanceSha256);
    assert.equal(alternative.impactCents, ordinary.impactCents);
    assert.deepEqual(alternative.lines, ordinary.lines);
  } finally { replayModule.getCalculatorReplayEngineManifest = getManifest; require.cache[modulePath] = existing; }
});
await assert.rejects(() => collect({ query() { throw new Error('must not read'); } }, { venueId: id(1) }, id(7)), /fenced_write_snapshot_required/); checks++;
console.log(`PASS payroll refund review assessment pure contracts: ${checks}`);
