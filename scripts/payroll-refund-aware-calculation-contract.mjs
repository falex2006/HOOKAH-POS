// Pure source-to-engine contracts; no database or financial writes.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { makePayrollRefundEconomicFacts, payrollRefundEconomicFixtureOptions } from './payroll-refund-economic-source-contract.mjs';
const require = createRequire(import.meta.url);
const { buildPayrollRefundAwareCalculation: build } = require('../payroll-refund-aware-calculation');
const { buildPayrollRecognitionManifest } = require('../payroll-recognition-manifest');
const { eligibilityPayloadSha256, eligibilitySourceWatermark } = require('../payroll-employment-eligibility');
const { mappingPayloadSha256 } = require('../payroll-product-department-source');
const { buildSaleCostEvidence, saleCostEvidenceFingerprint } = require('../pos-sale-cost-evidence');
const id = n => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;
const clone = value => structuredClone(value);
export const payrollRefundAwareModes = ['progressive_daily', 'stable_percent', 'percent_only', 'final_month_threshold', 'personal_target', 'team_fund', 'margin_target'];

// Complete typed source arguments, reusable by the independent snapshot suite.
// opts.modify runs last and deliberately permits invalid fixtures for contracts.
export function makePayrollRefundAwareFixture(mode = 'progressive_daily', opts = {}) {
  const { venueId, currency, from, to } = payrollRefundEconomicFixtureOptions;
  const period = { from, to }, facts = makePayrollRefundEconomicFacts();
  if (opts.noRefunds) for (const key of ['refundEvents', 'refundLines', 'refundHeaders', 'relatedRefundHeaders', 'relatedRefundItems', 'refundItems', 'refundTenders', 'candidateRefunds']) facts[key] = [];
  if (opts.fullReturn) for (const row of [facts.refundLines[0], facts.refundItems[0]]) {
    row.returned_quantity = row.cumulative_returned_quantity = '1.000';
    row.returned_item_value_minor = row.cumulative_returned_item_value_minor = '10000';
  }
  if (opts.twoEmployees) {
    const ids = new Map([20, 21, 22, 23, 24, 25, 26, 90].map(n => [id(n), id(n + 100)]));
    const replace = value => Array.isArray(value) ? value.map(replace)
      : value instanceof Date ? new Date(value) : value && typeof value === 'object'
        ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replace(v)])) : ids.get(value) || value;
    for (const key of ['saleEvents', 'saleLines', 'orders', 'pricingHeaders', 'pricingLines', 'orderItems']) facts[key].push(replace(facts[key][0]));
  }
  const employeeIds = opts.twoEmployees ? [id(24), id(124)] : [id(24)];
  const sourcePolicies = { schemaVersion: 2, selectionReason: 'Owner explicitly selected refund-aware payroll incentive basis',
    saleCredit: { kind: 'line_seller_snapshot' }, discountAllocation: { kind: 'immutable_line_snapshot' },
    refunds: { recognition: 'recognized_event_date', closedRunTreatment: 'next_open_run_adjustment', paidAdjustment: 'owner_review_variable_pay_only',
      uncoveredBalance: 'carry_forward_review', clawback: 'no_automatic_clawback' },
    earnings: { refunds: 'remaining_merchandise_original_sale_date_v1', venueTurnover: 'canonical_total_less_merchandise_returns_v1',
      marginCost: 'frozen_sale_depletion_cost_payroll_v1' } };
  const scheme = { id: id(400), versionId: id(401), currency, mode, sourcePolicies, effectiveFrom: from, effectiveTo: null,
    roleAssignments: employeeIds.map(employeeId => ({ employeeId, roleId: 'bar', effectiveFrom: from, effectiveTo: null })),
    roleParameters: { bar: { perShiftCents: 0, stableRateBps: 1000, bracketRatesBps: { 0: 1000, 15000: 2000 },
      targetCents: 1000, baseRateBps: 1000, bonusRateBps: 1500, excessRatePolicy: 'add_to_base',
      lossPolicy: 'offset_daily_losses', itemRuleBasis: 'net_revenue', teamWeight: 1,
      teamFund: { poolId: 'pool', targetCents: 1000, baseRateBps: 1000, bonusRateBps: 1500,
        excessRatePolicy: 'add_to_base', departments: ['bar'], distributionPolicy: 'configured_weights' } } },
    employeeOverrides: [], itemRules: [], applyMilestones: false,
    payoutRiskAcknowledgement: { confirmed: true, policyCode: 'payroll-own-revenue-ceiling-v1', configDigest: 'a'.repeat(64),
      acknowledgedBy: 'owner', acknowledgedAt: '2026-10-01T00:00:00.000Z' }, payoutRiskAcknowledgementCurrent: true };
  const eligibilityFacts = employeeIds.map(employeeId => ({ employeeId, effectiveFrom: from, effectiveTo: null }));
  const periods = eligibilityFacts.map((row, i) => ({ ...row, employeeName: `QA employee ${i + 1}` }));
  const reason = 'Owner confirmed eligible roster';
  const revision = { id: id(450), revisionNo: 1, reason, idempotency_key: 'refund-aware-contract',
    payload_sha256: eligibilityPayloadSha256(eligibilityFacts, reason), periodCount: periods.length,
    created_by: id(451), created_by_name: 'Owner QA', created_at: '2026-10-01 00:00:00+00' };
  revision.sourceWatermark = eligibilitySourceWatermark(venueId, revision, periods);
  const employmentEligibility = { revision, periods, component: { status: 'available', reasons: [], sourceWatermark: revision.sourceWatermark,
    watermarkScope: 'owner_attested_payroll_employment_eligibility_revision', revisionId: revision.id, revisionNo: 1, periodCount: periods.length } };
  const approvedAttendanceSource = {
    attendance: employeeIds.map((employeeId, i) => ({ id: id(460 + i), employeeId, date: '2026-10-10', approved: true, workedMinutes: 480, plannedMinutes: 480 })),
    attendanceCoverage: { kind: 'approved_attendance_complete', from, through: to, complete: true, watermark: 'b'.repeat(64) },
    sourceAttendanceApproval: { approvalId: id(465), revision: 1, sourceWatermark: 'b'.repeat(64), periodFrom: from, periodTo: to,
      approvedByName: 'Owner QA', approvedAt: '2026-11-01T00:00:00.000Z' } };
  const mappings = [id(90), ...(opts.twoEmployees ? [id(190)] : [])].map(productId => ({ productId, productName: 'Frozen product',
    departmentCode: 'bar', departmentName: 'Бар', effectiveFrom: from, effectiveTo: null }));
  const departmentMapping = { mappings, revision: { id: id(470), revisionNo: 1, supersedesRevisionId: null,
    reason: 'Owner confirmed original product classification', idempotencyKey: 'refund-aware-department', payloadSha256: mappingPayloadSha256(mappings),
    mappingCount: mappings.length, effectiveFrom: from, retroactiveAttested: true, retroactiveReason: 'Owner confirms frozen mapping',
    createdBy: id(451), createdByName: 'Owner QA', createdAt: '2026-10-01T00:00:00.000Z' } };
  const costEvidenceByOrder = mode === 'margin_target' ? facts.saleLines.map((line, i) => {
    const movementId = id(500 + i), ingredientId = id(510 + i), productId = i ? id(190) : id(90);
    const capture = { captureVersion: 1, status: 'captured', reasons: [],
      lines: [{ orderItemId: line.order_item_id, productId, inventoryMode: 'tracked', quantity: '1.000000' }],
      movements: [{ movementId, ingredientId, quantity: '1.000000' }],
      components: [{ orderItemId: line.order_item_id, ingredientId, movementId, quantity: '1.000000', unitCost: '1.0000' }] };
    const base = buildSaleCostEvidence({ venueId, orderId: line.order_id, capture, totalCostMinor: 100 });
    const payload = { ...base, epochActivatedAt: '2024-01-01T00:00:00.000000Z' };
    return { ...payload, watermark: saleCostEvidenceFingerprint(payload) };
  }) : null;
  const args = { venueId, scheme, period,
    periodClosure: { schemaVersion: 1, venueId, period: clone(period), timezone: 'Asia/Yekaterinburg', transactionTimestamp: '2026-11-06T00:00:00.000Z', venueLocalDate: '2026-11-06' },
    recognitionEvidence: { manifest: buildPayrollRecognitionManifest(facts, payrollRefundEconomicFixtureOptions), facts },
    employmentEligibility, approvedAttendanceSource, departmentMapping, costEvidenceByOrder };
  if (opts.modify) opts.modify(args);
  return args;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let checks = 0;
  const eq = (a, b, label) => { assert.deepEqual(a, b, label); checks++; };
  const check = (value, label) => { assert.ok(value, label); checks++; };
  const deepFrozen = value => !value || typeof value !== 'object' || Object.isFrozen(value) && Object.values(value).every(deepFrozen);
  const success = (args, label = args.scheme.mode) => {
    const before = clone(args), result = build(args);
    eq(result.status, 'refund_aware_calculated', `${label}: ${result.reasons}`);
    eq(args, before, `${label}: no input mutations`);
    eq([result.schemaVersion, result.officialReady, result.payoutEligible, result.sourceAttested, result.persistence], [2, false, false, false, 'none']);
    check(deepFrozen(result), `${label}: deeply frozen`);
    eq(result.calculationWatermark, build(args).calculationWatermark, `${label}: deterministic`);
    eq(result.engineResult.status, 'ready');
    check(Number.isSafeInteger(result.amountCents) && result.amountCents >= 0);
    eq(result.amountCents, result.engineResult.employees.reduce((sum, row) => sum + row.amountCents, 0));
    return result;
  };
  const blocked = (mode, modify, expected) => {
    const args = makePayrollRefundAwareFixture(mode, { modify }), before = clone(args), result = build(args);
    eq(result.status, 'blocked', `${mode}: expected block ${expected}, got ${result.reasons}`);
    eq(args, before, 'failure must not mutate caller evidence');
    eq([result.input, result.engineResult, result.amountCents], [null, null, null], 'blocked sources cannot leak a payable amount');
    eq([result.officialReady, result.payoutEligible, result.sourceAttested, result.persistence], [false, false, false, 'none']);
    check(result.reasons.length > 0 && result.reasons.every(reason => typeof reason === 'string'));
    if (expected) check(result.reasons.some(reason => reason.includes(expected)), result.reasons.join(','));
  };
  const expectedPartial = [750, 750, 750, 750, 1725, 1725, 1700];
  const expectedOriginal = [1000, 1000, 1000, 1000, 2350, 2350, 2325];
  const expectedTeam = [3500, 1750, 1750, 3500, 4075, 4225, 4025];
  for (const [index, mode] of payrollRefundAwareModes.entries()) {
    const args = makePayrollRefundAwareFixture(mode), result = success(args);
    eq(result.amountCents, expectedPartial[index]);
    eq(result.input.sales.map(row => [row.id, row.employeeId, row.date, row.commissionBaseCents, row.turnoverCents]),
      [[id(26), id(24), '2026-10-10', 7500, 7500]], 'refund changes original earning day, never refund day');
    eq(result.economics.treasuryRefundFacts[0].payoutMinor, 50, 'cash payout differs from merchandise deduction');
    eq(result.economics.projection.recognitionHistory.refundEvents[0].recognizedLocalDate, '2026-11-05');
    eq(result.input.personalRevenueSource.daily.length, 31);
    eq(result.input.personalRevenueSource.daily[9].netRevenueCents, 7500);
    eq(result.input.personalRevenueSource.daily.filter(row => row.netRevenueCents === 0).length, 30);
    eq(result.input.scheme, args.scheme, 'frozen scheme/roles/weights copied exactly');
    eq(result.economics.remainingDaily[9].turnoverCents, 8200, 'minimum adjustment remains 700');
    const original = success(makePayrollRefundAwareFixture(mode, { noRefunds: true }), `${mode}/no refunds`);
    eq(original.amountCents, expectedOriginal[index]);
    check(original.inputWatermark !== result.inputWatermark && original.calculationWatermark !== result.calculationWatermark);
    const zero = success(makePayrollRefundAwareFixture(mode, { fullReturn: true }), `${mode}/full return`);
    eq(zero.amountCents, 0);
    eq(zero.input.sales.length, 1, 'zero sales retained for exact lineage');
    eq([zero.input.sales[0].commissionBaseCents, zero.input.sales[0].turnoverCents], [0, 0]);
    eq(zero.economics.remainingDaily[9].turnoverCents, 700);
    const team = success(makePayrollRefundAwareFixture(mode, { twoEmployees: true }), `${mode}/two employees`);
    eq(team.amountCents, expectedTeam[index]);
    eq(team.engineResult.employees.length, 2);
    eq(team.input.personalRevenueSource.daily.length, 62);
    eq(team.input.sales.map(row => row.commissionBaseCents), [7500, 10000]);
    if (mode === 'margin_target') {
      eq(zero.input.sales[0].costSnapshot.costCents, 100, 'full return retains frozen depletion cost');
      eq(zero.input.sales[0].commissionBaseCents - zero.input.sales[0].costSnapshot.costCents, -100, 'negative margin is a valid incentive input');
      eq(zero.costs.refundAdjustedReady, false);
      eq(zero.costs.accountingScope, 'payroll_incentive_only_not_actual_cogs');
    }
    if (team.team) for (const key of ['departmentShiftAllocation', 'teamMembershipAndWeights']) {
      eq(team.team[key].schemaVersion, 2);
      eq(team.team[key].economicSourceWatermark, team.economics.sourceWatermark);
      check(!Object.hasOwn(team.team[key], 'zeroRefundCandidateRequired'));
      eq(team.team[key].sourceAttested, false);
    }
    const forged = clone(args);
    Object.assign(forged, { officialReady: true, sourceAttested: true, payoutEligible: true, amountCents: 99999999,
      input: original.input, engineResult: original.engineResult, economics: original.economics });
    eq(build(forged), result, 'caller calculated fields cannot override verified source result');
  }
  blocked('percent_only', a => { delete a.scheme.sourcePolicies; }, 'explicit_policy');
  blocked('percent_only', a => { a.scheme.sourcePolicies.schemaVersion = 1; delete a.scheme.sourcePolicies.earnings; }, 'explicit_policy');
  blocked('margin_target', a => { a.scheme.sourcePolicies.earnings.marginCost = 'remaining_quantity_ratio'; }, 'explicit_policy');
  blocked('percent_only', a => { a.scheme.payoutRiskAcknowledgementCurrent = false; }, 'acknowledgement');
  blocked('percent_only', a => { a.period.from = '2026-10-02'; }, 'context');
  blocked('percent_only', a => { a.venueId = id(999); }, 'period_not_closed');
  blocked('percent_only', a => { a.periodClosure = null; }, 'period_not_closed');
  blocked('percent_only', a => { a.periodClosure.venueLocalDate = '2026-11-05'; }, 'period_not_closed');
  blocked('percent_only', a => { a.periodClosure.transactionTimestamp = '2026-10-30T00:00:00Z'; a.periodClosure.venueLocalDate = '2026-10-30'; }, 'period_not_closed');
  blocked('percent_only', a => { a.periodClosure.timezone = 'Invalid/timezone'; }, 'period_not_closed');
  blocked('percent_only', a => { a.employmentEligibility = null; });
  blocked('percent_only', a => { a.employmentEligibility.component.sourceWatermark = 'f'.repeat(64); });
  blocked('percent_only', a => { a.employmentEligibility.revision.payload_sha256 = 'f'.repeat(64); });
  blocked('percent_only', a => { a.employmentEligibility.periods[0].employeeName = ''; });
  blocked('percent_only', a => { a.employmentEligibility.periods[0].employeeId = id(999); });
  blocked('percent_only', a => { a.scheme.roleAssignments[0].effectiveFrom = '2026-10-11'; }, 'role_coverage');
  blocked('stable_percent', a => { a.approvedAttendanceSource = null; }, 'approved_attendance');
  blocked('stable_percent', a => { a.approvedAttendanceSource.sourceAttendanceApproval.approvalId = 'not-uuid'; }, 'approved_attendance');
  blocked('stable_percent', a => { a.approvedAttendanceSource.attendanceCoverage.watermark = 'f'.repeat(64); }, 'approved_attendance');
  blocked('stable_percent', a => { a.approvedAttendanceSource.attendance[0].approved = false; });
  blocked('stable_percent', a => { a.approvedAttendanceSource.attendance[0].id = 'bad'; });
  blocked('stable_percent', a => { a.approvedAttendanceSource.attendance[0].employeeId = id(999); });
  blocked('team_fund', a => { a.departmentMapping = null; }, 'department');
  blocked('team_fund', a => { a.departmentMapping.revision.payloadSha256 = 'f'.repeat(64); }, 'department');
  blocked('team_fund', a => { a.departmentMapping.mappings[0].productId = id(999); }, 'department');
  blocked('margin_target', a => { a.costEvidenceByOrder = null; });
  blocked('margin_target', a => { a.costEvidenceByOrder[0].watermark = 'f'.repeat(64); });
  blocked('margin_target', a => { a.costEvidenceByOrder[0].orderId = id(999); });
  blocked('margin_target', a => {
    const evidence = a.costEvidenceByOrder[0];
    evidence.allocation.lines[0].totalCostMinor = 1;
    const { watermark, ...payload } = evidence;
    evidence.watermark = saleCostEvidenceFingerprint(payload);
  });
  blocked('percent_only', a => { a.costEvidenceByOrder = []; }, 'unexpected_cost');
  blocked('percent_only', a => { a.recognitionEvidence.manifest.watermark = 'f'.repeat(64); });
  blocked('percent_only', a => { a.recognitionEvidence.facts.refundLines = []; });
  blocked('percent_only', a => { a.recognitionEvidence.facts.pricingHeaders[0].final_total_minor = '-1'; });
  blocked('final_month_threshold', a => {
    a.period.to = a.periodClosure.period.to = '2026-10-30';
    a.recognitionEvidence.manifest = buildPayrollRecognitionManifest(a.recognitionEvidence.facts, { ...payrollRefundEconomicFixtureOptions, to: a.period.to });
  }, 'full_month');
  blocked('stable_percent', a => { a.scheme.roleParameters.bar.perShiftCents = 100000; }, 'engine_not_ready');
  // A return can lower everybody's venue bracket, not just the original seller.
  const crossed = success(makePayrollRefundAwareFixture('progressive_daily', { twoEmployees: true, fullReturn: true }));
  eq(crossed.amountCents, 1000);
  eq(crossed.engineResult.employees.map(row => row.amountCents), [0, 1000]);
  // A pooled allocation onto a member with zero personal revenue follows the
  // existing engine's critical protection; this adapter cannot bypass it.
  const protectedTeam = build(makePayrollRefundAwareFixture('team_fund', { twoEmployees: true, fullReturn: true }));
  eq(protectedTeam.status, 'blocked');
  check(protectedTeam.reasons.includes('payroll_refund_aware_engine_not_ready'));
  eq([protectedTeam.input, protectedTeam.engineResult, protectedTeam.amountCents], [null, null, null]);
  // Removing attendance is allowed only in the configured attendance-free mode.
  success(makePayrollRefundAwareFixture('percent_only', { modify: a => { a.approvedAttendanceSource = null; } }));
  // Proofs supplied to a pure builder carry no private DB capability or payment authority.
  const authority = success(makePayrollRefundAwareFixture('team_fund'));
  eq(authority.input.sourceEvidence.capabilityVersion, 'employee_attributed_remaining_net_refund_v2');
  eq(authority.economics.sourceAttested, false);
  console.log(`payroll-refund-aware-calculation-contract: ok (${checks} checks; all seven modes, pure sources, no PG)`);
}
