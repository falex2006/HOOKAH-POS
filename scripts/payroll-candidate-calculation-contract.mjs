import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
const require = createRequire(import.meta.url);
const { buildPayrollCandidateCalculation } = require('../payroll-candidate-calculation.js');
const { buildPayrollCandidateSnapshotBundle, verifyPayrollCandidateSnapshotBundle } = require('../payroll-candidate-snapshot-bundle.js');
const { buildPayrollCalculationInputContract } = require('../payroll-calculation-input-contract.js');
const { buildPayrollRecognitionPreview } = require('../payroll-recognition-preview.js');
const { buildPayrollFullEmployeeNetRevenueSource } = require('../payroll-full-employee-net-revenue-source.js');
const { buildPayrollTeamFundSource } = require('../payroll-team-fund-source.js');
const { eligibilityPayloadSha256, eligibilitySourceWatermark, buildEligibleEmployees } = require('../payroll-employment-eligibility.js');

const stable = value => Array.isArray(value) ? `[${value.map(stable).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`
    : JSON.stringify(value);
const digest = value => createHash('sha256').update(stable(value)).digest('hex');
const venueId = '11111111-1111-4111-8111-111111111111';
const employeeId = '22222222-2222-4222-8222-222222222222';
const roleAssignment = { employeeId, roleId: 'bar', effectiveFrom: '2026-10-01', effectiveTo: null };
const period = { from: '2026-10-01', to: '2026-10-31' };
const policies = { schemaVersion: 1, selectionReason: 'Owner selected immutable line seller and recognized event facts.',
  saleCredit: { kind: 'line_seller_snapshot' }, discountAllocation: { kind: 'immutable_line_snapshot' },
  refunds: { recognition: 'recognized_event_date', closedRunTreatment: 'next_open_run_adjustment',
    paidAdjustment: 'owner_review_variable_pay_only', uncoveredBalance: 'carry_forward_review', clawback: 'no_automatic_clawback' } };
const scheme = { id: '33333333-3333-4333-8333-333333333333', versionId: '44444444-4444-4444-8444-444444444444',
  currency: 'RUB', mode: 'percent_only', sourcePolicies: policies, roleAssignments: [roleAssignment],
  roleParameters: { bar: { stableRateBps: 1000 } }, payoutRiskAcknowledgementCurrent: true,
  payoutRiskAcknowledgement: { confirmed: true, policyCode: 'payroll-own-revenue-ceiling-v1', configDigest: 'a'.repeat(64),
    acknowledgedBy: 'owner', acknowledgedAt: '2026-10-01T00:00:00.000Z' } };
const manifest = { schemaVersion: 1, status: 'available', officialReady: false, venueId, currency: 'RUB', period,
  watermark: 'b'.repeat(64), reasons: [],
  sales: [{ eventId: '55555555-5555-4555-8555-555555555555', venueId, orderId: '66666666-6666-4666-8666-666666666666',
    snapshotId: '77777777-7777-4777-8777-777777777777', currency: 'RUB', recognizedLocalDate: '2026-10-11' }],
  saleLines: [{ saleLineEventId: '88888888-8888-4888-8888-888888888888', saleEventId: '55555555-5555-4555-8555-555555555555',
    venueId, orderId: '66666666-6666-4666-8666-666666666666', snapshotId: '77777777-7777-4777-8777-777777777777',
    orderItemId: '99999999-9999-4999-8999-999999999999', sellerId: employeeId, eligibilityStatus: 'same_venue',
    eligibilityVenueId: venueId, employeeVenueId: venueId, recognizedLocalDate: '2026-10-11', grossMinor: 15000,
    discountMinor: 2500, netMinor: 12500, productFacts: { productId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } }],
  refundHistory: [], refundOriginalSaleAttributions: [], refundEvents: [],
  relatedRefundCoverage: { schemaVersion: 1, status: 'complete',
    scope: 'all_recorded_refunds_for_payroll_related_orders_as_of_repeatable_read_snapshot',
    periodSaleOrderIds: ['66666666-6666-4666-8666-666666666666'], coveredOrderIds: ['66666666-6666-4666-8666-666666666666'],
    relatedRefundHeaderIds: [], relatedRefundEventIds: [],
    relatedRefundItemIds: [], relatedRefundLineEventIds: [], sourceWatermark: 'b'.repeat(64) } };
const projection = buildPayrollRecognitionPreview(manifest, policies);
const fullNet = buildPayrollFullEmployeeNetRevenueSource(manifest, policies);
assert.equal(projection.sourceStatus, 'available');
assert.equal(fullNet.status, 'available');
const eligibilityPeriod = [{ employeeId, effectiveFrom: period.from, effectiveTo: null }];
const revision = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', revisionNo: 1, reason: 'Owner confirmed eligible roster',
  idempotency_key: 'candidate-calculation-contract', payload_sha256: eligibilityPayloadSha256(eligibilityPeriod, 'Owner confirmed eligible roster'),
  periodCount: 1, created_by: employeeId, created_by_name: 'Owner QA', created_at: '2026-10-01 00:00:00+00' };
revision.sourceWatermark = eligibilitySourceWatermark(venueId, revision, eligibilityPeriod.map(row => ({ ...row, employeeName: 'QA employee' })));
const readinessComponents = {};
const put = (key, scope, watermark = (key.length.toString(16).repeat(64)).slice(0, 64)) => {
  readinessComponents[key] = { status: 'available', reasons: [], sourceWatermark: watermark, watermarkScope: scope,
    venueId, currency: 'RUB', period };
};
readinessComponents.sourcePolicies = { status: 'available', reasons: [] };
put('employeeEligibility', 'owner_attested_payroll_employment_eligibility_revision', revision.sourceWatermark);
readinessComponents.employeeEligibility.revisionId = revision.id;
readinessComponents.employeeEligibility.revisionNo = revision.revisionNo;
readinessComponents.employeeEligibility.periodCount = revision.periodCount;
put('canonicalLinePricing', 'canonical_line_pricing');
put('payrollSaleCredit', 'payroll_sale_credit');
put('recognitionManifest', 'immutable_recognition_manifest', manifest.watermark);
put('recognizedLineRefunds', 'immutable_recognized_sale_and_refund_candidate_projection', projection.projectionWatermark);
put('fullEmployeeNetRevenue', fullNet.watermarkScope, fullNet.sourceWatermark);
put('employeeRoleCoverage', 'owner_attested_employee_role_coverage');
const readiness = { schemaVersion: 1, versionId: scheme.versionId, period, components: readinessComponents };
const bundleComponents = Object.fromEntries(Object.entries(readinessComponents).filter(([key]) => key !== 'sourcePolicies')
  .map(([key, value]) => [key, structuredClone(value)]));
const sales = projection.saleLines.map(line => ({ id: line.id, employeeId: line.employeeId, date: line.date,
  currency: line.currency, menuItemId: line.menuItemId, department: 'unclassified', turnoverCents: line.netRevenueCents,
  commissionBaseCents: line.commissionBaseCents, sourceWatermark: manifest.watermark }));
const calculatorInput = { periodFrom: period.from, periodTo: period.to,
  employmentEligibilityRevisionId: revision.id,
  employees: buildEligibleEmployees(eligibilityPeriod, period.from, period.to), roleAssignments: [roleAssignment], sales,
  coverage: { kind: 'month_to_date_complete', from: period.from, through: period.to, complete: true, watermark: 'c'.repeat(64) } };
const sourceBundle = { schemaVersion: 1, venueId, schemeVersionId: scheme.versionId, currency: 'RUB', period,
  readinessWatermark: digest(readiness.components), components: bundleComponents, recognitionManifest: manifest,
  recognizedLineProjection: { schemaVersion: 1, venueId, currency: 'RUB', period, sourceWatermark: manifest.watermark,
    projectionWatermark: projection.projectionWatermark, sourceStatus: projection.sourceStatus, sourceReasons: projection.sourceReasons,
    saleLines: projection.saleLines, refundAdjustments: projection.refundAdjustments },
  fullEmployeeNetRevenue: fullNet, employmentEligibility: { revision, periods: eligibilityPeriod.map(row => ({ ...row, employeeName: 'QA employee' })) },
  calculatorInput };
sourceBundle.inputWatermark = digest(sourceBundle);
const calculate = (currentBundle = sourceBundle, currentManifest = manifest) => buildPayrollCandidateCalculation({ venueId, scheme,
  period, readiness, sourceBundle: { ...currentBundle, recognitionManifest: currentManifest } });
const candidate = calculate();
assert.equal(candidate.status, 'scenario_ready', (candidate.reasons || []).join(', '));
assert.equal(candidate.amountCents, 1250, '10 percent is calculated on the immutable item net after its discount');
assert.equal(candidate.officialReady, false);
assert.equal(candidate.payoutEligible, false);
assert.equal(candidate.nonPayable, true);
assert.equal(candidate.nonAccrual, true);
assert.ok(candidate.requiredFacts.includes('canonicalLinePricing'), 'candidate result carries required source facts for same-source comparison');
assert.equal(candidate.employees.reduce((sum, row) => sum + row.amountCents, 0), candidate.amountCents);
const candidateSnapshot = buildPayrollCandidateSnapshotBundle({ venueId, scheme, period, venueTimezone: 'Asia/Yekaterinburg',
  sourceBundle, candidateCalculation: candidate });
assert.equal(candidateSnapshot.candidateOnly, true);
assert.equal(candidateSnapshot.officialReady, false);
assert.equal(candidateSnapshot.persistence, 'none');
assert.equal(Object.hasOwn(candidateSnapshot, 'runId'), false, 'candidate snapshot has no official run identity');
assert.equal(candidateSnapshot.lines.length, 1);
assert.equal(candidateSnapshot.lines[0].commissionBaseCents, 12500);
assert.equal(candidateSnapshot.lines[0].refundMinor, 0);
assert.equal(candidateSnapshot.amountCents, 1250);
assert.deepEqual(candidateSnapshot.personalRevenueReconciliation, { status: 'matched',
  scope: 'no_refund_merchandise_net_only', sourceWatermark: fullNet.sourceWatermark,
  amountCents: 12500, employeeDayCount: candidateSnapshot.employeeDays.length });
for (const targetDate of ['2026-10-01', '2026-10-11']) {
  const wrongRevenue = structuredClone(candidate);
  const targetDay = wrongRevenue.daily.find(day => day.date === targetDate);
  if (!targetDay.employees.length) {
    targetDay.employees.push({ employeeId: candidate.employees[0].employeeId, amountCents: 0, personalRevenueCents: 0 });
    assert.equal(buildPayrollCandidateSnapshotBundle({ venueId, scheme, period,
      venueTimezone: 'Asia/Yekaterinburg', sourceBundle, candidateCalculation: wrongRevenue })
      .personalRevenueReconciliation.amountCents, 12500, 'covered sparse source day has exactly zero revenue');
  }
  targetDay.employees[0].personalRevenueCents += 1;
  assert.throws(() => buildPayrollCandidateSnapshotBundle({ venueId, scheme, period,
    venueTimezone: 'Asia/Yekaterinburg', sourceBundle, candidateCalculation: wrongRevenue }),
  error => error.code === 'payroll_candidate_snapshot_personal_revenue_day_reconciliation_failed',
  'both sparse zero days and sale days must reconcile without changing salary totals');
}
for (const mutate of [
  bundle => { delete bundle.fullEmployeeNetRevenue; },
  bundle => { bundle.fullEmployeeNetRevenue.daily[0].netMinor += 1; },
  bundle => { bundle.fullEmployeeNetRevenue.sourceWatermark = 'f'.repeat(64); },
  bundle => { bundle.fullEmployeeNetRevenue.daily[0].netMinor = Number.MAX_SAFE_INTEGER + 1; }
]) {
  const alteredBundle = structuredClone(sourceBundle); mutate(alteredBundle);
  delete alteredBundle.inputWatermark; alteredBundle.inputWatermark = digest(alteredBundle);
  assert.throws(() => buildPayrollCandidateSnapshotBundle({ venueId, scheme, period,
    venueTimezone: 'Asia/Yekaterinburg', sourceBundle: alteredBundle,
    candidateCalculation: { ...candidate, inputWatermark: alteredBundle.inputWatermark } }),
  error => error.code === 'payroll_candidate_snapshot_personal_revenue_source_binding_mismatch',
  'rehashing the outer envelope must not validate missing or altered revenue evidence');
}
assert.match(candidateSnapshot.snapshotWatermark, /^[a-f0-9]{64}$/);
assert.equal(candidateSnapshot.candidateResultWatermark, digest(candidate), 'snapshot watermark binds the complete calculator result');
assert.equal(verifyPayrollCandidateSnapshotBundle({ snapshot: candidateSnapshot, candidateCalculation: candidate }), true);
const tamperedCandidateResult = structuredClone(candidate); tamperedCandidateResult.amountCents += 1;
assert.equal(verifyPayrollCandidateSnapshotBundle({ snapshot: candidateSnapshot, candidateCalculation: tamperedCandidateResult }), false,
  'a changed candidate result is rejected even when the saved digest remains SHA-256-shaped');
const tamperedCandidateSnapshot = structuredClone(candidateSnapshot); tamperedCandidateSnapshot.lines[0].commissionCents += 1;
assert.equal(verifyPayrollCandidateSnapshotBundle({ snapshot: tamperedCandidateSnapshot, candidateCalculation: candidate }), false,
  'a changed snapshot line is rejected even when its saved watermark remains SHA-256-shaped');
assert.deepEqual(candidateSnapshot.lines[0].calculationEvidence, candidate.daily.find(day => day.date === '2026-10-11').lines[0],
  'typed line explanation is retained without flattening mode-specific evidence');
assert.deepEqual(buildPayrollCandidateSnapshotBundle({ venueId, scheme, period, venueTimezone: 'Asia/Yekaterinburg',
  sourceBundle, candidateCalculation: candidate }), candidateSnapshot, 'candidate snapshot replay is byte-stable');
const officializedCandidate = { ...candidate, payoutEligible: true };
assert.throws(() => buildPayrollCandidateSnapshotBundle({ venueId, scheme, period, venueTimezone: 'Asia/Yekaterinburg',
  sourceBundle, candidateCalculation: officializedCandidate }), error => error.code === 'payroll_candidate_snapshot_candidate_only_required');
const blockedCandidate = { ...candidate, status: 'blocked', amountCents: null };
assert.throws(() => buildPayrollCandidateSnapshotBundle({ venueId, scheme, period, venueTimezone: 'Asia/Yekaterinburg',
  sourceBundle, candidateCalculation: blockedCandidate }), error => error.code === 'payroll_candidate_snapshot_candidate_only_required');
const changedSourceBundle = structuredClone(sourceBundle);
changedSourceBundle.recognitionManifest.saleLines[0].netMinor += 1;
assert.throws(() => buildPayrollCandidateSnapshotBundle({ venueId, scheme, period, venueTimezone: 'Asia/Yekaterinburg',
  sourceBundle: changedSourceBundle, candidateCalculation: candidate }), error => error.code === 'payroll_candidate_snapshot_source_watermark_mismatch');
const itemRuleBundle = structuredClone(sourceBundle);
itemRuleBundle.calculatorInput.sales[0].menuItemId = null;
itemRuleBundle.inputWatermark = digest(Object.fromEntries(Object.entries(itemRuleBundle).filter(([key]) => key !== 'inputWatermark')));
const itemRuleCandidate = buildPayrollCandidateCalculation({ venueId,
  scheme: { ...scheme, itemRules: [{ id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', menuItemId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    roleId: 'bar', mode: 'replace', rateBps: 1500 }] }, period, readiness, sourceBundle: itemRuleBundle });
assert.equal(itemRuleCandidate.status, 'blocked', 'an item-rule scenario cannot silently omit the immutable menu item identity');
assert.ok(itemRuleCandidate.requiredFacts.includes('canonicalLinePricing'), 'blocked candidate retains its required raw source list');
assert.ok(itemRuleCandidate.reasons.includes('payroll_calculation_sale_item_identity_missing'));
const refundManifest = structuredClone(manifest);
refundManifest.refundEvents.push({ eventId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', orderId: '66666666-6666-4666-8666-666666666666',
  originalSaleEventId: '55555555-5555-4555-8555-555555555555', currency: 'RUB', recognizedLocalDate: '2026-10-20', lines: [] });
assert.equal(calculate(sourceBundle, refundManifest).status, 'blocked', 'any refund event blocks this no-refund candidate path');
const outOfPeriodRefundManifest = structuredClone(manifest);
outOfPeriodRefundManifest.relatedRefundCoverage.relatedRefundHeaderIds = ['cccccccc-cccc-4ccc-8ccc-cccccccccccc'];
const outOfPeriodRefundCandidate = calculate(sourceBundle, outOfPeriodRefundManifest);
assert.equal(outOfPeriodRefundManifest.refundEvents.length, 0, 'later refund is absent from the period-only projection');
assert.equal(outOfPeriodRefundCandidate.status, 'blocked', 'all-time related raw refund headers block zero-refund candidate input');
assert(outOfPeriodRefundCandidate.reasons.includes('payroll_candidate_no_refund_coverage_not_proven'));

const teamScheme = structuredClone(scheme);
teamScheme.versionId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
teamScheme.mode = 'team_fund';
teamScheme.roleParameters = { bar: { mode: 'team_fund', perShiftCents: 0, teamFund: { poolId: 'house', targetCents: 20000,
  baseRateBps: 1000, bonusRateBps: 0, excessRatePolicy: 'replace_base', distributionPolicy: 'approved_minutes', departments: ['drinks'] } } };
const teamReadiness = structuredClone(readiness);
teamReadiness.versionId = teamScheme.versionId;
const teamBundle = structuredClone(sourceBundle);
teamBundle.schemeVersionId = teamScheme.versionId;
const teamAttendance = [{ id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', employeeId, date: '2026-10-11',
  approved: true, workedMinutes: 180, plannedMinutes: 240 }];
const teamAttendanceCoverage = { kind: 'approved_attendance_complete', from: period.from, through: period.to,
  complete: true, watermark: 'd'.repeat(64) };
const mappingRevisionId = 'abababab-abab-4bab-8bab-abababababab';
const departmentAttribution = { schemaVersion: 1, status: 'available', reasons: [],
  sourceWatermark: 'e'.repeat(64), watermarkScope: 'payroll_owner_attested_product_department_classification',
  coverage: { venueId, period, timezone: 'Asia/Yekaterinburg', complete: true, mappingRevisionId,
    recognitionWatermark: manifest.watermark },
  rows: [{ saleLineEventId: projection.saleLines[0].id, employeeId, recognizedLocalDate: projection.saleLines[0].date,
    departmentCode: 'drinks' }] };
teamBundle.departmentAttribution = departmentAttribution;
teamBundle.calculatorInput.sales = teamBundle.calculatorInput.sales.map(row => ({ ...row, department: 'drinks' }));
teamBundle.calculatorInput.attendance = teamAttendance;
teamBundle.calculatorInput.attendanceCoverage = teamAttendanceCoverage;
const teamEvidence = buildPayrollTeamFundSource({ venueId, scheme: teamScheme, period: { ...period, timezone: 'Asia/Yekaterinburg' },
  currency: 'RUB', employees: teamBundle.calculatorInput.employees, roleAssignments: teamBundle.calculatorInput.roleAssignments,
  sales: teamBundle.calculatorInput.sales, attendance: teamAttendance, attendanceCoverage: teamAttendanceCoverage,
  departmentAttribution, employmentEligibility: teamBundle.employmentEligibility });
assert.equal(teamEvidence.status, 'available', (teamEvidence.reasons || []).join(', '));
teamBundle.teamFundEvidence = teamEvidence;
teamBundle.components.approvedAttendance = { status: 'available', reasons: [], sourceWatermark: teamAttendanceCoverage.watermark,
  watermarkScope: 'owner_approved_attendance_snapshot', venueId, currency: 'RUB', period };
teamBundle.components.immutableDepartmentAttribution = { status: 'available', reasons: [],
  sourceWatermark: departmentAttribution.sourceWatermark, watermarkScope: departmentAttribution.watermarkScope, venueId, currency: 'RUB', period };
for (const key of ['departmentShiftAllocation', 'teamMembershipAndWeights']) {
  const component = teamEvidence[key];
  const binding = { status: component.status, reasons: component.reasons, sourceWatermark: component.sourceWatermark,
    watermarkScope: component.watermarkScope, venueId, currency: 'RUB', period };
  teamBundle.components[key] = binding;
  teamReadiness.components[key] = structuredClone(binding);
}
teamReadiness.components.approvedAttendance = structuredClone(teamBundle.components.approvedAttendance);
teamReadiness.components.immutableDepartmentAttribution = structuredClone(teamBundle.components.immutableDepartmentAttribution);
teamBundle.readinessWatermark = digest(teamReadiness.components);
teamBundle.inputWatermark = digest(Object.fromEntries(Object.entries(teamBundle).filter(([key]) => key !== 'inputWatermark')));
const teamCandidate = buildPayrollCandidateCalculation({ venueId, scheme: teamScheme, period, readiness: teamReadiness,
  sourceBundle: teamBundle });
const teamOfficialInput = buildPayrollCalculationInputContract({ venueId, scheme: teamScheme, period, readiness: teamReadiness,
  sourceBundle: teamBundle, purpose: 'official' });
assert.equal(teamOfficialInput.status, 'blocked');
assert.ok(teamOfficialInput.reasons.includes('payroll_team_fund_candidate_evidence_not_official'),
  'candidate-only team membership evidence cannot become an official calculator input');
assert.equal(teamCandidate.status, 'scenario_ready', (teamCandidate.reasons || []).join(', '));
assert.equal(teamCandidate.amountCents, 1250, `daily team pool shares use only the included mapped department base: ${JSON.stringify(teamCandidate.daily?.find(row => row.date === '2026-10-11'))}`);
assert.equal(teamCandidate.officialReady, false);
assert.equal(teamCandidate.payoutEligible, false);
assert.equal(teamCandidate.nonPayable, true);
assert.equal(teamCandidate.nonAccrual, true);
const teamCandidateSnapshot = buildPayrollCandidateSnapshotBundle({ venueId, scheme: teamScheme, period,
  venueTimezone: 'Asia/Yekaterinburg', sourceBundle: teamBundle, candidateCalculation: teamCandidate });
assert.equal(teamCandidateSnapshot.lines[0].department, 'drinks');
assert.equal(teamCandidateSnapshot.lines[0].commissionCents, 0,
  'team-fund commission is represented by the team pool snapshot fields, not duplicated on source lines');
assert.deepEqual(teamCandidateSnapshot.lines[0].calculationEvidence, teamCandidate.daily.find(day => day.date === '2026-10-11').lines[0]);
assert.deepEqual(teamCandidateSnapshot.days.find(day => day.date === '2026-10-11').teamFunds,
  teamCandidate.daily.find(day => day.date === '2026-10-11').teamFunds, 'team-fund distribution evidence is preserved');
const teamTamperedBundle = structuredClone(teamBundle);
teamTamperedBundle.teamFundEvidence.teamMembershipAndWeights.pools[0].members[0].weight += 1;
teamTamperedBundle.inputWatermark = digest(Object.fromEntries(Object.entries(teamTamperedBundle).filter(([key]) => key !== 'inputWatermark')));
assert.equal(buildPayrollCandidateCalculation({ venueId, scheme: teamScheme, period, readiness: teamReadiness,
  sourceBundle: teamTamperedBundle }).status, 'blocked', 'team member weights are recomputed and source-bound');
const { buildPayrollMarginCostSource } = require('../payroll-margin-cost-source');
const marginScheme = structuredClone(teamScheme);
marginScheme.mode = 'margin_target';
marginScheme.roleParameters = { bar: { perShiftCents: 0, targetCents: 20000, baseRateBps: 1000,
  bonusRateBps: 2000, excessRatePolicy: 'replace_base', lossPolicy: 'offset_daily_losses', itemRuleBasis: 'net_revenue' } };
const marginBundle = structuredClone(teamBundle), marginReadiness = structuredClone(teamReadiness);
marginBundle.recognitionManifest.saleLines[0].quantity = '1';
const marginRaw = marginBundle.recognitionManifest.saleLines[0];
marginBundle.marginCostEvidenceByOrder = [{ schemaVersion: 1, policyVersion: 1, scope: 'sale_depletion_cost',
  status: 'complete', reasons: [], venueId, orderId: marginRaw.orderId, currency: 'RUB',
  valuationMethod: 'ingredient_cost_at_depletion_v1', refundAdjustedReady: false, watermark: 'f'.repeat(64), totalCostMinor: 2500,
  allocation: { status: 'complete', totalCostMinor: 2500, lines: [{ orderItemId: marginRaw.orderItemId,
    productId: marginRaw.productFacts.productId, quantity: '1.000000', totalCostMinor: 2500 }] } }];
marginBundle.marginCostSource = buildPayrollMarginCostSource({ venueId, currency: 'RUB', period,
  recognitionManifest: marginBundle.recognitionManifest, evidenceByOrder: marginBundle.marginCostEvidenceByOrder });
assert.equal(marginBundle.marginCostSource.status, 'available');
marginBundle.calculatorInput.sales[0].costSnapshot = marginBundle.marginCostSource.rows[0].costSnapshot;
const marginEvidence = buildPayrollTeamFundSource({ venueId, scheme: marginScheme, period: { ...period, timezone: 'Asia/Yekaterinburg' },
  currency: 'RUB', employees: marginBundle.calculatorInput.employees, roleAssignments: marginBundle.calculatorInput.roleAssignments,
  sales: marginBundle.calculatorInput.sales, attendance: teamAttendance, attendanceCoverage: teamAttendanceCoverage,
  departmentAttribution, employmentEligibility: marginBundle.employmentEligibility });
marginBundle.teamFundEvidence = marginEvidence;
for (const [key, component] of Object.entries({ marginCosts: marginBundle.marginCostSource,
  departmentShiftAllocation: marginEvidence.departmentShiftAllocation, teamMembershipAndWeights: marginEvidence.teamMembershipAndWeights })) {
  const binding = { status: component.status, reasons: component.reasons, sourceWatermark: component.sourceWatermark,
    watermarkScope: component.watermarkScope, venueId, currency: 'RUB', period };
  marginBundle.components[key] = binding; marginReadiness.components[key] = structuredClone(binding);
}
marginBundle.readinessWatermark = digest(marginReadiness.components);
const rehash = bundle => { delete bundle.inputWatermark; bundle.inputWatermark = digest(bundle); return bundle; };
rehash(marginBundle);
const marginCandidate = buildPayrollCandidateCalculation({ venueId, scheme: marginScheme, period,
  readiness: marginReadiness, sourceBundle: marginBundle });
assert.equal(marginCandidate.status, 'scenario_ready', JSON.stringify(marginCandidate.reasons));
assert.equal(marginCandidate.amountCents, 1000, '10% of (12500 net revenue - 2500 full line cost)');
const marginSnapshot = buildPayrollCandidateSnapshotBundle({ venueId, scheme: marginScheme, period,
  venueTimezone: 'Asia/Yekaterinburg', sourceBundle: marginBundle, candidateCalculation: marginCandidate });
assert.equal(marginSnapshot.lines[0].signedMarginCents, 10000);
assert.equal(marginSnapshot.lines[0].costSnapshot.costCents, 2500);
assert.equal(marginSnapshot.lines[0].producerWatermark, 'f'.repeat(64));
assert.equal(marginSnapshot.lines[0].costSourceWatermark, marginBundle.marginCostSource.sourceWatermark);
for (const [mode, expectedAmount] of [['replace', 1250], ['additive', 2250]]) {
  const itemScheme = structuredClone(marginScheme);
  itemScheme.itemRules = [{ id: 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd', menuItemId: marginRaw.productFacts.productId,
    roleId: 'bar', mode, rateBps: 1000 }];
  const itemCandidate = buildPayrollCandidateCalculation({ venueId, scheme: itemScheme, period,
    readiness: marginReadiness, sourceBundle: marginBundle });
  assert.equal(itemCandidate.status, 'scenario_ready', JSON.stringify(itemCandidate.reasons));
  assert.equal(itemCandidate.amountCents, expectedAmount, `${mode} keeps full cost lineage and configured revenue commission`);
  const itemSnapshot = buildPayrollCandidateSnapshotBundle({ venueId, scheme: itemScheme, period,
    venueTimezone: 'Asia/Yekaterinburg', sourceBundle: marginBundle, candidateCalculation: itemCandidate });
  assert.equal(itemSnapshot.lines[0].signedMarginCents, 10000);
  assert.equal(itemSnapshot.lines[0].costSnapshot.costCents, 2500);
}
const mixedScheme = structuredClone(marginScheme);
mixedScheme.roleParameters.bar.mode = 'percent_only';
mixedScheme.roleParameters.bar.stableRateBps = 1000;
const mixedCandidate = buildPayrollCandidateCalculation({ venueId, scheme: mixedScheme, period,
  readiness: marginReadiness, sourceBundle: marginBundle });
assert.equal(mixedCandidate.status, 'scenario_ready', JSON.stringify(mixedCandidate.reasons));
assert.equal(mixedCandidate.amountCents, 1250, 'role mode overrides global margin mode');
const mixedSnapshot = buildPayrollCandidateSnapshotBundle({ venueId, scheme: mixedScheme, period,
  venueTimezone: 'Asia/Yekaterinburg', sourceBundle: marginBundle, candidateCalculation: mixedCandidate });
assert.equal(mixedSnapshot.lines[0].costSnapshot, undefined, 'non-margin role does not report cost as part of its calculation');
for (const mutate of [b => { b.calculatorInput.sales[0].costSnapshot.costCents++; },
  b => { b.marginCostEvidenceByOrder[0].watermark = 'e'.repeat(64); },
  b => { b.marginCostEvidenceByOrder[0].allocation.lines[0].productId = venueId; },
  b => { b.recognitionManifest.relatedRefundCoverage.relatedRefundHeaderIds.push(employeeId); }]) {
  const tampered = structuredClone(marginBundle); mutate(tampered); rehash(tampered);
  assert.equal(buildPayrollCandidateCalculation({ venueId, scheme: marginScheme, period,
    readiness: marginReadiness, sourceBundle: tampered }).status, 'blocked');
}
for (const field of ['costSnapshot', 'signedMarginCents', 'marginCents']) {
  const tampered = structuredClone(marginCandidate), line = tampered.daily.find(day => day.lines.length).lines[0];
  if (field === 'costSnapshot') line.costSnapshot.costCents++; else line[field]++;
  assert.throws(() => buildPayrollCandidateSnapshotBundle({ venueId, scheme: marginScheme, period,
    venueTimezone: 'Asia/Yekaterinburg', sourceBundle: marginBundle, candidateCalculation: tampered }),
  error => error.code === 'payroll_candidate_snapshot_margin_cost_calculated_binding_mismatch');
}
assert.ok(buildPayrollCalculationInputContract({ venueId, scheme: marginScheme, period, readiness: marginReadiness,
  sourceBundle: marginBundle, purpose: 'official' }).reasons.includes('payroll_margin_cost_candidate_evidence_not_official'));
const { buildPayrollPersonalRevenueSource } = require('../payroll-personal-revenue-source');
const explicitBundle = structuredClone(sourceBundle);
explicitBundle.orderRevenueReconciliation = { status: 'available', coverage: { complete: true }, currency: 'RUB', period,
  sourceWatermark: '9'.repeat(64), orders: [{ orderId: manifest.saleLines[0].orderId, status: 'available',
    recognizedLineNetMinor: 12500, closedOrderTotalMinor: 12500, minimumPriceAdjustmentMinor: 0, unattributedResidualMinor: 0 }] };
const explicitSource = bundle => buildPayrollPersonalRevenueSource({ venueId, currency: 'RUB', period,
  recognitionManifest: bundle.recognitionManifest, sourcePolicies: scheme.sourcePolicies,
  fullEmployeeNetRevenue: bundle.fullEmployeeNetRevenue, orderRevenueReconciliation: bundle.orderRevenueReconciliation });
explicitBundle.calculatorInput.personalRevenueSource = explicitSource(explicitBundle);
assert.equal(explicitBundle.calculatorInput.personalRevenueSource.status, 'available'); rehash(explicitBundle);
const explicitCandidate = calculate(explicitBundle);
assert.equal(explicitCandidate.status, 'scenario_ready', JSON.stringify(explicitCandidate.reasons));
assert.equal(explicitCandidate.amountCents, 1250);
const explicitSnapshot = buildPayrollCandidateSnapshotBundle({ venueId, scheme, period, venueTimezone: 'Asia/Yekaterinburg',
  sourceBundle: explicitBundle, candidateCalculation: explicitCandidate });
assert.deepEqual(explicitSnapshot.personalRevenueCeilingSource, explicitBundle.calculatorInput.personalRevenueSource);
for (const mutate of [b => { b.orderRevenueReconciliation.orders[0].minimumPriceAdjustmentMinor = 1; },
  b => { b.orderRevenueReconciliation.orders[0].unattributedResidualMinor = 1; },
  b => { b.orderRevenueReconciliation.orders = []; },
  b => { b.orderRevenueReconciliation.orders = [null]; },
  b => { b.calculatorInput.personalRevenueSource.daily[0].netRevenueCents++; },
  b => { b.fullEmployeeNetRevenue.daily[0].netMinor++; }]) {
  const bad = structuredClone(explicitBundle); mutate(bad); rehash(bad);
  assert.equal(calculate(bad).status, 'blocked', 'explicit daily source cannot be replaced by sale-derived fallback');
}
console.log('PASS payroll-candidate-calculation-contract');
