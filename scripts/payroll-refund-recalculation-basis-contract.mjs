import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { buildPayrollRefundRecalculationBasis: build, buildSavedPayrollRefundRecalculationBasis: buildSaved } = require('../payroll-refund-recalculation-basis');
const { buildPayrollRefundEarningsProjection: project, PAYROLL_REFUND_HISTORY_SCOPE: scope } = require('../payroll-refund-earnings-projection');
const { buildCalculatorReplay } = require('../payroll-calculator-replay');
const { calculatePayrollScheme } = require('../payroll-schemes');
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const clone = value => structuredClone(value);
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
function sourceFixture() {
  const sale = { saleLineEventId: id(1), saleEventId: id(2), venueId: id(3), currency: 'RUB', orderId: id(4), orderItemId: id(5),
    snapshotId: id(6), pricingLineId: id(7), sellerId: id(8), recognizedAt: '2026-09-01T12:00:00.123456Z',
    recognizedLocalDate: '2026-09-01', timezoneSnapshot: 'Asia/Yekaterinburg', soldAt: '2026-09-01T10:00:00.123456Z',
    quantity: '3.000', grossMinor: 120, discountMinor: 20, netMinor: 100, productFacts: { productId: id(9), department: 'legacy-classification' } };
  const event = { venueId: id(3), currency: 'RUB', refundId: id(11), refundEventId: id(21), orderId: id(4), originalSaleEventId: id(2),
    recognizedAt: '2026-10-02T12:00:00.123456Z', recognizedLocalDate: '2026-10-02', timezoneSnapshot: 'Asia/Yekaterinburg',
    payoutMinor: 500, tenderTotalMinor: 500, itemAttributionStatus: 'complete' };
  const line = { venueId: id(3), refundId: id(11), refundEventId: id(21), refundItemId: id(31), refundLineEventId: id(41),
    orderId: id(4), orderItemId: id(5), snapshotId: id(6), originalSaleEventId: id(2), originalSaleLineEventId: id(1),
    producerSequence: 1, previousReturnedQuantity: '0.000', returnedQuantity: '2.000', cumulativeReturnedQuantity: '2.000',
    previousReturnedItemValueMinor: 0, returnedItemValueMinor: 67, cumulativeReturnedItemValueMinor: 67 };
  return { schemaVersion: 1, venueId: id(3), currency: 'RUB', period: { from: '2026-09-01', to: '2026-09-30' }, manifestWatermark: 'a'.repeat(64),
    saleLines: [sale], refundEvents: [event], refundLines: [line], coverage: { status: 'complete', scope, sourceWatermark: 'a'.repeat(64),
      saleLineEventIds: [id(1)], orderIds: [id(4)], refundHeaderIds: [id(11)], refundEventIds: [id(21)], refundItemIds: [id(31)],
      refundLineEventIds: [id(41)], lineTotals: [{ saleLineEventId: id(1), cumulativeReturnedQuantity: '2.000', cumulativeReturnedItemValueMinor: 67 }] } };
}
function inputFixture(source, mode = 'progressive_daily') {
  const sales = source.saleLines.filter(line => line.recognizedLocalDate >= source.period.from && line.recognizedLocalDate <= source.period.to);
  const employees = [...new Set(sales.map(line => line.sellerId))].map(id => ({ id }));
  const target = { targetCents: 10, baseRateBps: 1000, bonusRateBps: 1500, excessRatePolicy: 'add_to_base' };
  return { periodFrom: source.period.from, periodTo: source.period.to, monthClosed: true,
    coverage: { kind: mode === 'final_month_threshold' ? 'month_closed_complete' : 'month_to_date_complete', from: source.period.from, through: source.period.to, complete: true, watermark: 'sales-1' },
    attendanceCoverage: { kind: 'approved_attendance_complete', from: source.period.from, through: source.period.to, complete: true, watermark: 'attendance-1' },
    employees, roleAssignments: employees.map(employee => ({ employeeId: employee.id, roleId: 'bartender', effectiveFrom: '2026-09-01', effectiveTo: '2026-09-30' })),
    attendance: employees.map(employee => ({ id: `shift-${employee.id}`, employeeId: employee.id, date: '2026-09-01', approved: true, workedMinutes: 480, plannedMinutes: 480 })),
    sales: sales.map(line => ({ id: line.saleLineEventId, date: line.recognizedLocalDate, employeeId: line.sellerId,
      menuItemId: line.productFacts.productId, department: 'bar', turnoverCents: line.netMinor, commissionBaseCents: line.netMinor,
      ...(mode === 'margin_target' ? { costSnapshot: { id: 'cost-frozen', version: 'v1', currency: 'RUB', costCents: 30 } } : {}) })),
    sourceEvidence: { originalEvidenceMustNotBeReattested: true },
    scheme: { id: 'scheme', versionId: 'v1', currency: 'RUB', mode, roleParameters: { bartender: { perShiftCents: 0,
      stableRateBps: 1000, bracketRatesBps: { 0: 1000 }, ...target, lossPolicy: 'offset_daily_losses', itemRuleBasis: 'net_revenue',
      teamWeight: 1, teamFund: { poolId: 'pool', ...target, departments: ['bar'], distributionPolicy: 'configured_weights' } } },
      employeeOverrides: [], itemRules: [], applyMilestones: false } };
}
const save = input => { const result = calculatePayrollScheme(input); assert.equal(result.status, 'ready', JSON.stringify(result.blockers)); return buildCalculatorReplay(input, result); };
const fixture = () => { const source = sourceFixture(); return { venueId: source.venueId, calculatorReplay: save(inputFixture(source)), projection: project(source) }; };
let checks = 0;
const check = (value, label) => { assert.ok(value, label); checks++; };
const invalid = (mutate, suffix) => { const args = clone(fixture()); mutate(args);
  assert.throws(() => build(args), error => error.code?.startsWith('payroll_refund_recalculation_basis_') && (!suffix || error.code.endsWith(suffix))); checks++; };
const args = clone(fixture()), before = clone(args), result = build(args);
assert.deepEqual(args, before); checks++;
check(result.saleLines[0].remainingNetCents === 33 && result.saleLines[0].remainingQuantity === '1.000');
for (const key of ['employeeDaily', 'departmentDaily', 'venueDaily']) {
  check(result[key][0].remainingNetCents === 33 && result[key][0].remainingQuantity === '1.000', key);
}
check(result.departmentDaily[0].department === 'bar', 'department remains the frozen calculator attribution');
check(result.treasuryRefundFacts[0].payoutMinor === 500 && result.treasuryRefundFacts[0].returnedMerchandiseMinor === 67);
check(result.needsOrderAdjustmentAttestation === true && result.turnoverSource === false);
check(result.officialReady === false && result.payoutEligible === false && result.persistence === 'none');
check(result.sourceAttested === false && result.requiresSavedRunProvenanceBinding === true);
check(result.basisWatermark !== result.projection.projectionWatermark && result.replayHashes.inputSha256 === args.calculatorReplay.inputSha256);
check(!Object.hasOwn(result, 'input') && !Object.hasOwn(result, 'sourceEvidence') && !Object.hasOwn(result.saleLines[0], 'costSnapshot'));
check(result.projection.recognitionHistory.refundEvents[0].recognizedLocalDate === '2026-10-02');
const frozen = value => !value || typeof value !== 'object' || Object.isFrozen(value) && Object.values(value).every(frozen);
check(frozen(result));
args.projection.saleLines[0].productFacts.department = 'changed';
check(result.projection.saleLines[0].productFacts.department === 'legacy-classification');
check(build(before).basisWatermark === result.basisWatermark);
for (const mode of ['progressive_daily', 'stable_percent', 'percent_only', 'final_month_threshold', 'personal_target', 'team_fund', 'margin_target']) {
  const source = sourceFixture(); const basis = build({ venueId: source.venueId, calculatorReplay: save(inputFixture(source, mode)), projection: project(source) });
  check(basis.saleLines[0].remainingNetCents === 33, mode);
  check(basis.needsRemainingCostAttestation === (mode === 'margin_target'), `${mode} remaining cost requirement`);
}
{
  const source = sourceFixture(); Object.assign(source.refundLines[0], { returnedQuantity: '3.000', cumulativeReturnedQuantity: '3.000', returnedItemValueMinor: 100, cumulativeReturnedItemValueMinor: 100 });
  Object.assign(source.coverage.lineTotals[0], { cumulativeReturnedQuantity: '3.000', cumulativeReturnedItemValueMinor: 100 });
  const basis = build({ venueId: source.venueId, calculatorReplay: save(inputFixture(source)), projection: project(source) });
  check(basis.saleLines.length === 1 && basis.saleLines[0].remainingNetCents === 0 && basis.employeeDaily[0].remainingQuantity === '0.000', 'zero lines/groups retained');
}
{
  const source = sourceFixture(); const historical = { ...clone(source.saleLines[0]), saleLineEventId: id(101), saleEventId: id(102), orderId: id(104),
    orderItemId: id(105), snapshotId: id(106), pricingLineId: id(107), recognizedAt: '2026-08-31T12:00:00.123456Z',
    recognizedLocalDate: '2026-08-31', soldAt: '2026-08-31T10:00:00.123456Z' };
  source.saleLines.push(historical); source.coverage.saleLineEventIds.push(id(101)); source.coverage.orderIds.push(id(104));
  source.coverage.lineTotals.push({ saleLineEventId: id(101), cumulativeReturnedQuantity: '0.000', cumulativeReturnedItemValueMinor: 0 });
  const basis = build({ venueId: source.venueId, calculatorReplay: save(inputFixture(source)), projection: project(source) });
  check(basis.saleLines.length === 1 && basis.projection.saleLines.length === 2 && basis.venueDaily[0].remainingNetCents === 33, 'full history retained but excluded from earning aggregates');
  check(basis.basisWatermark !== result.basisWatermark, 'outside-period facts remain hash-bound');
}
for (const field of ['remainingNetCents', 'remainingQuantity', 'inEarningPeriod', 'netMinor', 'sellerId', 'saleLineEventId']) {
  invalid(args => { args.projection.saleLines[0][field] = field === 'remainingNetCents' ? 34 : field === 'netMinor' ? 101 : field === 'remainingQuantity' ? '2.000' : field === 'inEarningPeriod' ? false : id(200); });
}
invalid(args => { args.projection.extra = true; }, 'projection_mismatch');
invalid(args => { args.projection.projectionWatermark = 'b'.repeat(64); }, 'projection_mismatch');
invalid(args => { args.projection.saleLines[0].remainingNetCents = 34; const copy = clone(args.projection); delete copy.projectionWatermark; args.projection.projectionWatermark = hash(copy); }, 'projection_mismatch');
invalid(args => { args.venueId = id(999); }, 'period_or_context_mismatch');
invalid(args => { args.calculatorReplay = null; }, 'replay_unavailable');
invalid(args => { args.calculatorReplay.input.sales[0].commissionBaseCents++; }, 'replay_invalid');
invalid(args => { args.calculatorReplay.engineRevision = 'b'.repeat(64); }, 'replay_unavailable');
invalid(args => { args.calculatorReplay.result.employees[0].amountCents++; args.calculatorReplay.resultSha256 = hash(args.calculatorReplay.result); }, 'replay_unavailable');
for (const [key, value] of [['id', id(222)], ['employeeId', id(222)], ['date', '2026-09-02'], ['menuItemId', id(222)], ['commissionBaseCents', 99], ['turnoverCents', 99], ['currency', 'USD']]) {
  invalid(args => { const input = clone(args.calculatorReplay.input); input.sales[0][key] = value;
    if (key === 'employeeId') { input.employees.push({ id: value }); input.roleAssignments.push({ ...input.roleAssignments[0], employeeId: value }); }
    args.calculatorReplay = save(input); }, 'sale_binding_mismatch');
}
invalid(args => { const input = clone(args.calculatorReplay.input); input.sales = []; args.calculatorReplay = save(input); }, 'sale_coverage_mismatch');
invalid(args => { const input = clone(args.calculatorReplay.input); input.coverage.kind = 'month_closed_complete'; input.coverage.through = '2026-09-30'; input.periodTo = '2026-09-15'; input.monthClosed = true;
  args.calculatorReplay = save(input); const source = sourceFixture(); source.period.to = '2026-09-15'; args.projection = project(source); }, 'coverage_mismatch');
invalid(args => { const input = clone(args.calculatorReplay.input); input.periodFrom = '2026-09-02'; input.monthClosed = false; args.calculatorReplay = save(input);
  const source = sourceFixture(); source.period.from = '2026-09-02'; args.projection = project(source); }, 'period_or_context_mismatch');
invalid(args => { Object.defineProperty(args.projection, 'saleLines', { get() { throw new Error('getter executed'); }, enumerable: true }); }, 'json_invalid');
invalid(args => { args.projection.coverage.loop = args.projection; }, 'json_invalid');
invalid(args => { args.projection.saleLines[2] = args.projection.saleLines[0]; }, 'json_invalid');
{
  const source = sourceFixture(), second = { ...clone(source.saleLines[0]), saleLineEventId: id(201), orderItemId: id(205), pricingLineId: id(207),
    sellerId: id(208), quantity: '0.125', grossMinor: 7, discountMinor: 0, netMinor: 7 };
  source.saleLines.push(second); source.coverage.saleLineEventIds.push(second.saleLineEventId);
  source.coverage.lineTotals.push({ saleLineEventId: second.saleLineEventId, cumulativeReturnedQuantity: '0.000', cumulativeReturnedItemValueMinor: 0 });
  const input = inputFixture(source), saved = save(input);
  const basis = build({ venueId: source.venueId, calculatorReplay: saved, projection: project(source) });
  check(basis.employeeDaily.length === 2 && basis.departmentDaily.length === 1 && basis.venueDaily.length === 1);
  check(basis.departmentDaily[0].remainingNetCents === 40 && basis.departmentDaily[0].remainingQuantity === '1.125');
  source.saleLines.reverse(); source.coverage.saleLineEventIds.reverse(); source.coverage.lineTotals.reverse();
  check(build({ venueId: source.venueId, calculatorReplay: saved, projection: project(source) }).basisWatermark === basis.basisWatermark, 'canonical source ordering');
}
{
  const source = sourceFixture(); source.refundLines = [];
  source.refundEvents[0].itemAttributionStatus = 'not_applicable'; source.coverage.refundItemIds = []; source.coverage.refundLineEventIds = [];
  Object.assign(source.coverage.lineTotals[0], { cumulativeReturnedQuantity: '0.000', cumulativeReturnedItemValueMinor: 0 });
  const basis = build({ venueId: source.venueId, calculatorReplay: save(inputFixture(source)), projection: project(source) });
  check(basis.saleLines[0].remainingNetCents === 100 && basis.treasuryRefundFacts[0].returnedMerchandiseMinor === 0, 'cash-only refund does not reduce merchandise');
  source.refundEvents = []; source.coverage.refundHeaderIds = []; source.coverage.refundEventIds = [];
  check(build({ venueId: source.venueId, calculatorReplay: save(inputFixture(source)), projection: project(source) }).treasuryRefundFacts.length === 0);
}
const savedFixture = () => {
  const args = clone(fixture()), total = args.calculatorReplay.result.employees.reduce((sum, row) => sum + row.amountCents, 0);
  const evidence = { schemaVersion: 1, venueId: args.venueId, runId: id(301), schemeVersionId: args.calculatorReplay.input.scheme.versionId,
    currency: 'RUB', period: clone(args.projection.period), calculatorReplay: args.calculatorReplay,
    schemeSnapshot: clone(args.calculatorReplay.input.scheme), sourceEvidence: clone(args.calculatorReplay.input.sourceEvidence), totalAmountCents: total };
  return { header: { schemaVersion: 1, state: 'saved', runId: evidence.runId, period: clone(evidence.period), currency: 'RUB',
    scheme: { versionId: evidence.schemeVersionId }, amountCents: total }, evidence, provenanceSha256: hash(evidence), projection: args.projection };
};
{
  const args = savedFixture(), before = clone(args), basis = buildSaved(args);
  assert.deepEqual(args, before); checks++;
  check(basis.savedRunBinding.provenanceSha256 === args.provenanceSha256 && basis.savedRunBinding.runId === args.evidence.runId);
  check(basis.sourceAttested === false && basis.requiresSavedRunProvenanceBinding === false && basis.requiresSavedRunStorageAttestation === true);
  check(basis.replayBasisWatermark === result.basisWatermark && basis.basisWatermark !== result.basisWatermark && frozen(basis));
  check(buildSaved(args).basisWatermark === basis.basisWatermark);
}
const invalidSaved = (mutate, suffix, rehash = false) => {
  const args = savedFixture(); mutate(args); if (rehash) args.provenanceSha256 = hash(args.evidence);
  assert.throws(() => buildSaved(args), error => error.code?.endsWith(suffix)); checks++;
};
invalidSaved(args => { args.provenanceSha256 = 'b'.repeat(64); }, 'saved_provenance_invalid');
invalidSaved(args => { args.evidence.sourceEvidence.originalEvidenceMustNotBeReattested = false; }, 'saved_provenance_invalid');
invalidSaved(args => { args.header.runId = id(302); }, 'saved_provenance_invalid');
invalidSaved(args => { args.header.venueId = id(999); }, 'saved_provenance_invalid');
invalidSaved(args => { args.header.currency = 'USD'; }, 'saved_context_mismatch');
invalidSaved(args => { args.header.period.to = '2026-09-29'; }, 'saved_context_mismatch');
invalidSaved(args => { args.header.scheme.versionId = 'other'; }, 'saved_context_mismatch');
invalidSaved(args => { args.evidence.sourceEvidence.originalEvidenceMustNotBeReattested = false; }, 'saved_replay_context_mismatch', true);
invalidSaved(args => { args.evidence.schemeSnapshot.name = 'forged'; }, 'saved_replay_context_mismatch', true);
invalidSaved(args => { args.evidence.venueId = id(999); }, 'period_or_context_mismatch', true);
invalidSaved(args => { args.header.amountCents++; }, 'saved_total_mismatch');
invalidSaved(args => { args.evidence.totalAmountCents++; }, 'saved_total_mismatch', true);
console.log(`payroll-refund-recalculation-basis-contract: ok (${checks} checks)`);
