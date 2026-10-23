import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { buildPayrollRefundCounterfactual: build } = require('../payroll-refund-counterfactual');
const { buildSavedPayrollRefundRecalculationBasis: basisFor } = require('../payroll-refund-recalculation-basis');
const { buildPayrollRefundEarningsProjection: project, PAYROLL_REFUND_HISTORY_SCOPE: scope } = require('../payroll-refund-earnings-projection');
const { buildCalculatorReplay } = require('../payroll-calculator-replay');
const { calculatePayrollScheme } = require('../payroll-schemes');
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const clone = value => structuredClone(value);
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const dates = Array.from({ length: 30 }, (_, index) => `2026-09-${String(index + 1).padStart(2, '0')}`);
const policies = () => ({ schemaVersion: 2, selectionReason: 'Explicit immutable payroll depletion model', saleCredit: { kind: 'line_seller_snapshot' },
  discountAllocation: { kind: 'immutable_line_snapshot' }, refunds: { recognition: 'recognized_event_date', closedRunTreatment: 'next_open_run_adjustment',
    paidAdjustment: 'owner_review_variable_pay_only', uncoveredBalance: 'carry_forward_review', clawback: 'no_automatic_clawback' },
  earnings: { refunds: 'remaining_merchandise_original_sale_date_v1', venueTurnover: 'canonical_total_less_merchandise_returns_v1', marginCost: 'frozen_sale_depletion_cost_payroll_v1' } });
function sourceFixture() {
  const sale = { saleLineEventId: id(1), saleEventId: id(2), venueId: id(3), currency: 'RUB', orderId: id(4), orderItemId: id(5),
    snapshotId: id(6), pricingLineId: id(7), sellerId: id(8), recognizedAt: '2026-09-01T12:00:00.123456Z',
    recognizedLocalDate: '2026-09-01', timezoneSnapshot: 'Asia/Yekaterinburg', soldAt: '2026-09-01T10:00:00.123456Z',
    quantity: '3.000', grossMinor: 12000, discountMinor: 2000, netMinor: 10000, productFacts: { productId: id(9), department: 'frozen' } };
  const event = { venueId: id(3), currency: 'RUB', refundId: id(11), refundEventId: id(21), orderId: id(4), originalSaleEventId: id(2),
    recognizedAt: '2026-10-02T12:00:00.123456Z', recognizedLocalDate: '2026-10-02', timezoneSnapshot: 'Asia/Yekaterinburg',
    payoutMinor: 500, tenderTotalMinor: 500, itemAttributionStatus: 'complete' };
  const line = { venueId: id(3), refundId: id(11), refundEventId: id(21), refundItemId: id(31), refundLineEventId: id(41),
    orderId: id(4), orderItemId: id(5), snapshotId: id(6), originalSaleEventId: id(2), originalSaleLineEventId: id(1),
    producerSequence: 1, previousReturnedQuantity: '0.000', returnedQuantity: '2.000', cumulativeReturnedQuantity: '2.000',
    previousReturnedItemValueMinor: 0, returnedItemValueMinor: 6667, cumulativeReturnedItemValueMinor: 6667 };
  return { schemaVersion: 1, venueId: id(3), currency: 'RUB', period: { from: dates[0], to: dates.at(-1) }, manifestWatermark: 'a'.repeat(64),
    saleLines: [sale], refundEvents: [event], refundLines: [line], coverage: { status: 'complete', scope, sourceWatermark: 'a'.repeat(64),
      saleLineEventIds: [id(1)], orderIds: [id(4)], refundHeaderIds: [id(11)], refundEventIds: [id(21)], refundItemIds: [id(31)],
      refundLineEventIds: [id(41)], lineTotals: [{ saleLineEventId: id(1), cumulativeReturnedQuantity: '2.000', cumulativeReturnedItemValueMinor: 6667 }] } };
}
function addSale(source, { base = 100, date = dates[0], sellerId = id(base + 8), net = 10000 } = {}) {
  const row = { ...clone(source.saleLines[0]), saleLineEventId: id(base + 1), saleEventId: id(base + 2), orderId: id(base + 4), orderItemId: id(base + 5),
    snapshotId: id(base + 6), pricingLineId: id(base + 7), sellerId, recognizedAt: `${date}T12:00:00.123456Z`, recognizedLocalDate: date,
    soldAt: `${date}T10:00:00.123456Z`, grossMinor: net, discountMinor: 0, netMinor: net };
  source.saleLines.push(row); source.coverage.saleLineEventIds.push(row.saleLineEventId); source.coverage.orderIds.push(row.orderId);
  source.coverage.lineTotals.push({ saleLineEventId: row.saleLineEventId, cumulativeReturnedQuantity: '0.000', cumulativeReturnedItemValueMinor: 0 });
}
const fullReturn = source => {
  Object.assign(source.refundLines[0], { returnedQuantity: '3.000', cumulativeReturnedQuantity: '3.000', returnedItemValueMinor: 10000, cumulativeReturnedItemValueMinor: 10000 });
  Object.assign(source.coverage.lineTotals[0], { cumulativeReturnedQuantity: '3.000', cumulativeReturnedItemValueMinor: 10000 });
};
function inputFixture(source, mode) {
  const employees = [...new Set(source.saleLines.filter(line => line.recognizedLocalDate >= dates[0] && line.recognizedLocalDate <= dates.at(-1)).map(line => line.sellerId))].map(id => ({ id }));
  const target = { targetCents: 1000, baseRateBps: 1000, bonusRateBps: 1500, excessRatePolicy: 'add_to_base' };
  return { periodFrom: dates[0], periodTo: dates.at(-1), monthClosed: true,
    coverage: { kind: mode === 'final_month_threshold' ? 'month_closed_complete' : 'month_to_date_complete', from: dates[0], through: dates.at(-1), complete: true, watermark: 'sales-1' },
    attendanceCoverage: { kind: 'approved_attendance_complete', from: dates[0], through: dates.at(-1), complete: true, watermark: 'attendance-1' },
    employees, roleAssignments: employees.map(employee => ({ employeeId: employee.id, roleId: 'bartender', effectiveFrom: dates[0], effectiveTo: dates.at(-1) })),
    attendance: employees.map(employee => ({ id: `shift-${employee.id}`, employeeId: employee.id, date: dates[0], approved: true, workedMinutes: 480, plannedMinutes: 480 })),
    sales: source.saleLines.filter(line => line.recognizedLocalDate >= dates[0] && line.recognizedLocalDate <= dates.at(-1)).map(line => ({ id: line.saleLineEventId,
      date: line.recognizedLocalDate, employeeId: line.sellerId, menuItemId: line.productFacts.productId, department: 'bar', turnoverCents: line.netMinor, commissionBaseCents: line.netMinor,
      ...(mode === 'margin_target' ? { costSnapshot: { id: `cost-${line.saleLineEventId}`, version: 'v1', currency: 'RUB', costCents: 3000 } } : {}) })),
    sourceEvidence: { oldProof: 'must remain only in baseline' },
    scheme: { id: 'scheme', versionId: 'v1', currency: 'RUB', mode, sourcePolicies: policies(), roleParameters: { bartender: { perShiftCents: 100,
      stableRateBps: 1000, bracketRatesBps: { 0: 1000, 15000: 2000 }, ...target, lossPolicy: 'offset_daily_losses', itemRuleBasis: 'net_revenue',
      teamWeight: 1, teamFund: { poolId: 'pool', ...target, departments: ['bar'], distributionPolicy: 'configured_weights' } } },
      employeeOverrides: [], itemRules: [], applyMilestones: false } };
}
function fixture({ mode = 'progressive_daily', modifySource = () => {}, modifyInput = () => {}, explicitVenue = false } = {}) {
  const source = sourceFixture(); modifySource(source); const input = inputFixture(source, mode);
  if (explicitVenue) input.venueDailyTurnover = dates.map(date => ({ date,
    turnoverCents: input.sales.filter(line => line.date === date).reduce((sum, line) => sum + line.turnoverCents, 0) + (date === dates[0] ? 700 : 0) }));
  modifyInput(input);
  const result = calculatePayrollScheme(input); assert.equal(result.status, 'ready', JSON.stringify(result.blockers));
  assert.deepEqual(result.criticalErrors, [], 'baseline fixture must be replayable');
  const replay = buildCalculatorReplay(input, result), total = result.employees.reduce((sum, employee) => sum + employee.amountCents, 0);
  const evidence = { schemaVersion: 1, venueId: source.venueId, runId: id(301), schemeVersionId: input.scheme.versionId,
    currency: 'RUB', period: clone(source.period), calculatorReplay: replay, schemeSnapshot: clone(input.scheme), sourceEvidence: clone(input.sourceEvidence), totalAmountCents: total };
  const args = { header: { schemaVersion: 1, state: 'saved', runId: evidence.runId, period: clone(evidence.period), currency: 'RUB',
    scheme: { versionId: evidence.schemeVersionId }, amountCents: total }, evidence, provenanceSha256: hash(evidence), projection: project(source) };
  const basis = basisFor(args), originalDaily = dates.map(date => ({ date,
    turnoverCents: input.sales.filter(line => line.date === date).reduce((sum, line) => sum + line.turnoverCents, 0) }));
  args.economicInputs = { schemaVersion: 1, basisWatermark: basis.basisWatermark,
    venueTurnover: explicitVenue ? { policyCode: 'canonical_total_less_merchandise_returns_v1', originalDaily: clone(input.venueDailyTurnover),
      remainingDaily: dates.map(date => ({ date, turnoverCents: (basis.venueDaily.find(row => row.date === date)?.remainingNetCents || 0)
        + input.venueDailyTurnover.find(row => row.date === date).turnoverCents - originalDaily.find(row => row.date === date).turnoverCents })),
      adjustmentDaily: dates.map(date => { const adjustment = input.venueDailyTurnover.find(row => row.date === date).turnoverCents - originalDaily.find(row => row.date === date).turnoverCents;
        return { date, originalAdjustmentCents: adjustment, remainingAdjustmentCents: adjustment }; }) } : null,
    remainingCosts: basis.needsRemainingCostAttestation ? { policyCode: 'frozen_sale_depletion_cost_payroll_v1', currency: 'RUB',
      lines: input.sales.filter(sale => sale.costSnapshot).map(sale => { const line = basis.saleLines.find(row => row.saleLineEventId === sale.id);
        return { saleLineEventId: sale.id, originalCostSnapshot: clone(sale.costSnapshot), originalQuantity: line.originalQuantity,
          remainingQuantity: line.remainingQuantity, remainingCostCents: sale.costSnapshot.costCents }; }) } : null };
  return clone(args);
}
let checks = 0;
const check = (value, label) => { assert.ok(value, label); checks++; };
const frozen = value => !value || typeof value !== 'object' || Object.isFrozen(value) && Object.values(value).every(frozen);
for (const mode of ['progressive_daily', 'stable_percent', 'percent_only', 'final_month_threshold', 'personal_target', 'team_fund', 'margin_target']) {
  const args = fixture({ mode }), before = clone(args), result = build(args);
  check(result.status === 'counterfactual_calculated', `${mode}: ${result.reasons}`);
  check(result.deltas.employees[0].delta.amountCents < 0, mode);
  check(result.deltas.employees[0].delta.fixedBaseCents === 0, 'fixed preserved');
  check(result.deltas.daily.length === 30 && result.counterfactual.result.daily.length === 30, 'whole period');
  check(result.counterfactual.input.personalRevenueSource.daily.length === 30 && result.counterfactual.input.personalRevenueSource.daily[1].netRevenueCents === 0, 'zero-filled revenue');
  check(result.counterfactual.input.sales[0].turnoverCents === 3333 && result.counterfactual.input.sales[0].commissionBaseCents === 3333);
  for (const key of ['scheme', 'employees', 'attendance', 'attendanceCoverage', 'roleAssignments']) { assert.deepEqual(result.counterfactual.input[key], args.evidence.calculatorReplay.input[key]); checks++; }
  check(!Object.hasOwn(result.counterfactual.input, 'sourceEvidence') && result.baseline.input.sourceEvidence.oldProof === 'must remain only in baseline');
  check(result.counterfactual.input.coverage.watermark !== result.baseline.input.coverage.watermark);
  check(result.counterfactual.input.personalRevenueSource.policyCode === 'employee_attributed_merchandise_net_v1');
  check(result.officialReady === false && result.payoutEligible === false && result.sourceAttested === false && result.financialAction === 'none');
  check(frozen(result)); assert.deepEqual(args, before); checks++;
  check(build(args).counterfactualWatermark === result.counterfactualWatermark, 'deterministic');
}
{
  const args = fixture({ mode: 'margin_target', modifySource: fullReturn, modifyInput: input => { input.scheme.roleParameters.bartender.perShiftCents = 0; } });
  const result = build(args);
  check(result.status === 'counterfactual_calculated');
  check(result.counterfactual.input.sales.length === 1 && result.counterfactual.input.sales[0].commissionBaseCents === 0);
  check(result.counterfactual.input.sales[0].costSnapshot.costCents === 3000 && result.counterfactual.result.daily[0].lines[0].signedMarginCents === -3000, 'zero quantity retains full frozen depletion cost');
  check(result.counterfactual.result.employees[0].amountCents === 0 && result.deltas.employees[0].delta.fixedBaseCents === 0);
}
{
  const args = fixture({ modifySource: fullReturn }), result = build(args);
  check(result.status === 'blocked' && result.deltas === null, 'fixed exceeding remaining personal revenue blocks all salary deltas');
  check(result.reasons.includes('employee_daily_pay_exceeds_personal_revenue') && result.counterfactual.result.criticalErrors.length === 1);
  check(result.counterfactual.input.sales.length === 1 && result.baseline.result.employees[0].amountCents === 1100);
}
{
  const args = fixture({ explicitVenue: true }), result = build(args);
  check(result.status === 'counterfactual_calculated' && result.counterfactual.input.venueDailyTurnover[0].turnoverCents === 4033);
  check(result.baseline.input.venueDailyTurnover[0].turnoverCents === 10700, 'original canonical adjustment preserved independently');
  args.economicInputs.venueTurnover = null;
  check(build(args).status === 'blocked' && build(args).deltas === null, 'explicit venue cannot blindly reuse original');
}
{
  const args = fixture({ mode: 'final_month_threshold', modifySource: source => addSale(source, { date: dates[1] }),
    modifyInput: input => { input.attendance = input.attendance.filter(row => row.employeeId === id(8)); } });
  const result = build(args), other = result.deltas.employees.find(row => row.employeeId === id(108));
  check(other.baseline.amountCents === 2000 && other.counterfactual.amountCents === 1000 && other.delta.amountCents === -1000,
    'refund changes whole-month threshold for a different employee and later date');
  check(result.deltas.daily.find(row => row.employeeId === id(108) && row.date === dates[1]).delta.amountCents === -1000);
}
{
  const args = fixture({ mode: 'team_fund', modifySource: source => addSale(source), modifyInput: input => { input.scheme.roleParameters.bartender.perShiftCents = 0; } });
  const result = build(args);
  check(result.status === 'counterfactual_calculated' && result.deltas.employees.every(row => row.delta.teamFundCents < 0), 'full team fund recalculated for both members');
  check(result.counterfactual.result.daily[0].teamFunds[0].allocations.length === 2);
}
{
  const args = fixture({ modifySource: source => addSale(source), modifyInput: input => {
    input.roleAssignments[1].roleId = 'margin_role';
    input.scheme.roleParameters.margin_role = { ...clone(input.scheme.roleParameters.bartender), mode: 'margin_target' };
    input.sales[1].costSnapshot = { id: 'frozen-mixed-role', version: 'v1', currency: 'RUB', costCents: 3000 };
  } });
  const result = build(args);
  check(result.status === 'counterfactual_calculated' && result.counterfactual.result.modes.includes('margin_target'), 'mixed per-role modes preserve frozen resolution');
  check(result.deltas.employees.find(row => row.employeeId === id(108)).delta.amountCents === 0,
    'unchanged margin employee keeps its own frozen role formula while another role crosses a shared threshold');
}
{
  const args = fixture({ modifySource: source => {
    source.refundLines = []; source.refundEvents = [];
    for (const field of ['refundHeaderIds', 'refundEventIds', 'refundItemIds', 'refundLineEventIds']) source.coverage[field] = [];
    Object.assign(source.coverage.lineTotals[0], { cumulativeReturnedQuantity: '0.000', cumulativeReturnedItemValueMinor: 0 });
  } });
  const result = build(args);
  assert.deepEqual(result.counterfactual.result, result.baseline.result); checks++;
  check(result.deltas.totals.delta.amountCents === 0 && result.deltas.daily.every(row => Object.values(row.delta).every(value => value === 0)), 'no refunds gives exact result identity');
}
{
  const args = fixture({ modifyInput: input => { input.scheme.roleParameters.bartender.cap = { rateBps: 500, basis: 'venue_day' }; } });
  const result = build(args), delta = result.deltas.employees[0];
  check(delta.baseline.amountCents === 500 && delta.counterfactual.amountCents === 167);
  check(delta.delta.fixedBaseCents === 0 && delta.delta.capReductionCents !== 0, 'cap reduction kept separate from fixed pay');
}
{
  const args = fixture({ modifyInput: input => { input.scheme.roleParameters.bartender.perShiftCents = 500;
    input.scheme.roleParameters.bartender.cap = { rateBps: 1000, basis: 'venue_day' }; } });
  const result = build(args), delta = result.deltas.employees[0];
  check(delta.baseline.residualAfterFixedCents === 500 && delta.counterfactual.residualAfterFixedCents === -167, 'post-cap amount below fixed preserved as signed residual');
  check(delta.delta.amountCents === -667 && delta.delta.fixedBaseCents === 0, 'raw reduction can exceed previously paid variable residual');
  check(result.deltaApplicationEligible === false && result.requiresPaidVariableProtectionReview === true, 'no automatic deduction authority');
}
{
  const args = fixture({ explicitVenue: true, modifyInput: input => {
    input.sales[0].sourceWatermark = 'b'.repeat(64);
    input.venueDailyTurnoverCoverage = { sourceWatermark: 'c'.repeat(64), watermarkScope: 'owner_closed_order_turnover_pre_refund',
      amountBasis: 'canonical_closed_order_total_pre_refund', refundsIncluded: false, complete: true };
    input.personalRevenueSource = { schemaVersion: 1, policyCode: 'employee_attributed_merchandise_net_v1', currency: 'RUB',
      period: { from: dates[0], to: dates.at(-1) }, sourceWatermark: 'd'.repeat(64), coverage: { complete: true },
      daily: [{ employeeId: id(8), date: dates[0], netRevenueCents: 10000 }] };
  } });
  const result = build(args), input = result.counterfactual.input;
  check(input.sales[0].sourceWatermark !== 'b'.repeat(64) && input.sales[0].sourceAttested === false);
  check(input.venueDailyTurnoverCoverage.sourceWatermark !== 'c'.repeat(64) && input.venueDailyTurnoverCoverage.sourceAttested === false);
  check(input.venueDailyTurnoverCoverage.refundsIncluded === true && input.venueDailyTurnoverCoverage.amountBasis === 'canonical_total_less_merchandise_returns_v1');
  check(input.personalRevenueSource.sourceWatermark !== 'd'.repeat(64) && input.personalRevenueSource.sourceAttested === false);
  check(result.baseline.input.sales[0].sourceWatermark === 'b'.repeat(64) && result.baseline.input.venueDailyTurnoverCoverage.refundsIncluded === false);
}
{
  const args = fixture({ modifySource: source => addSale(source, { date: dates[1], sellerId: id(8) }),
    modifyInput: input => { input.scheme.applyMilestones = true; input.scheme.roleParameters.bartender.milestoneBonusesCents = { 15000: 500 }; } });
  const result = build(args);
  check(result.deltas.employees[0].baseline.milestoneBonusCents === 500 && result.deltas.employees[0].counterfactual.milestoneBonusCents === 0,
    'future milestone reevaluated over whole period');
}
const invalid = (mutate, suffix, options = {}) => { const args = fixture(options); mutate(args);
  assert.throws(() => build(args), error => error.code?.endsWith(suffix), suffix); checks++; };
invalid(args => { args.economicInputs.basisWatermark = 'b'.repeat(64); }, 'economic_basis_mismatch');
invalid(args => { args.economicInputs.extra = true; }, 'shape_invalid');
invalid(args => { args.economicInputs.venueTurnover = {}; }, 'unexpected_venue_proof');
invalid(args => { args.economicInputs.venueTurnover.originalDaily[0].turnoverCents++; }, 'venue_binding_mismatch', { explicitVenue: true });
invalid(args => { args.economicInputs.venueTurnover.remainingDaily[0].turnoverCents = 10700; }, 'venue_binding_mismatch', { explicitVenue: true });
invalid(args => { args.economicInputs.venueTurnover.adjustmentDaily[0].remainingAdjustmentCents = 200; args.economicInputs.venueTurnover.remainingDaily[0].turnoverCents = 3533; }, 'venue_binding_mismatch', { explicitVenue: true });
invalid(args => { args.economicInputs.venueTurnover.remainingDaily.pop(); }, 'venue_coverage_mismatch', { explicitVenue: true });
invalid(args => { args.economicInputs.venueTurnover.remainingDaily[1] = clone(args.economicInputs.venueTurnover.remainingDaily[0]); }, 'venue_coverage_mismatch', { explicitVenue: true });
invalid(args => { args.economicInputs.venueTurnover.remainingDaily[0].turnoverCents = -1; }, 'amount_invalid', { explicitVenue: true });
invalid(args => { args.economicInputs.remainingCosts.lines[0].remainingCostCents = 1000; }, 'cost_depletion_mismatch', { mode: 'margin_target' });
invalid(args => { args.economicInputs.remainingCosts.lines[0].remainingCostCents = 0; }, 'cost_depletion_mismatch', { mode: 'margin_target', modifySource: fullReturn, modifyInput: input => { input.scheme.roleParameters.bartender.perShiftCents = 0; } });
invalid(args => { args.economicInputs.remainingCosts.lines[0].originalCostSnapshot.costCents = 1000; }, 'cost_binding_mismatch', { mode: 'margin_target' });
invalid(args => { args.economicInputs.remainingCosts.lines[0].remainingQuantity = '2.000'; }, 'cost_binding_mismatch', { mode: 'margin_target' });
invalid(args => { args.economicInputs.remainingCosts.lines = []; }, 'cost_coverage_mismatch', { mode: 'margin_target' });
invalid(args => { args.economicInputs.remainingCosts.policyCode = 'proportional_net'; }, 'cost_policy_invalid', { mode: 'margin_target' });
invalid(args => { args.economicInputs.remainingCosts = {}; }, 'unexpected_cost_proof');
invalid(args => { Object.defineProperty(args.economicInputs, 'venueTurnover', { get() { throw new Error('getter executed'); }, enumerable: true }); }, 'json_invalid');
invalid(args => { args.economicInputs.cycle = args.economicInputs; }, 'json_invalid');
{
  const args = fixture({ mode: 'margin_target' }); args.economicInputs.remainingCosts = null;
  check(build(args).status === 'blocked' && build(args).reasons.includes('frozen_cost_economic_proof_required'));
  for (const transform of [input => { delete input.scheme.sourcePolicies; }, input => { input.scheme.sourcePolicies.schemaVersion = 1; delete input.scheme.sourcePolicies.earnings; },
    input => { input.scheme.sourcePolicies.earnings.marginCost = 'other'; }]) {
    const result = build(fixture({ mode: 'margin_target', modifyInput: transform }));
    check(result.status === 'blocked' && result.deltas === null && result.reasons.includes('frozen_cost_policy_opt_in_required'));
  }
  check(build(fixture({ modifyInput: input => { input.scheme.sourcePolicies.schemaVersion = 1; delete input.scheme.sourcePolicies.earnings; } })).status === 'counterfactual_calculated', 'nonmargin legacy v1 supported');
}
console.log(`payroll-refund-counterfactual-contract: ok (${checks} checks)`);
