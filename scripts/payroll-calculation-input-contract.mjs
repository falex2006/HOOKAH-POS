import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
const require = createRequire(import.meta.url);
const { buildPayrollCalculationInputContract } = require('../payroll-calculation-input-contract.js');
const { CALCULATOR_INPUT_CAPABILITIES } = require('../payroll-schemes.js');
const { buildPayrollRecognitionPreview } = require('../payroll-recognition-preview.js');
const { buildPayrollFullEmployeeNetRevenueSource } = require('../payroll-full-employee-net-revenue-source.js');
const { buildPayrollOrderRevenueReconciliation } = require('../payroll-order-revenue-reconciliation.js');
const { buildPayrollPersonalRevenueSource } = require('../payroll-personal-revenue-source.js');
const { eligibilityPayloadSha256, eligibilitySourceWatermark } = require('../payroll-employment-eligibility.js');
const stable = value => {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
};
const fingerprint = value => createHash('sha256').update(stable(value)).digest('hex');

const venueId = '11111111-1111-4111-8111-111111111111';
const scheme = { versionId: '22222222-2222-4222-8222-222222222222', mode: 'progressive_daily', currency: 'RUB',
  roleParameters: { bar: { perShiftCents: 0, stableRateBps: 1000 } }, roleAssignments: [],
  payoutRiskAcknowledgement: { confirmed: true, policyCode: 'payroll-own-revenue-ceiling-v1', configDigest: 'a'.repeat(64),
    acknowledgedBy: 'owner', acknowledgedAt: '2026-10-01T00:00:00Z' }, payoutRiskAcknowledgementCurrent: true };
const period = { from: '2026-10-01', to: '2026-10-31', timezone: 'UTC' };
const sourcePolicies = { schemaVersion: 1, selectionReason: 'Owner selected immutable sale and event-date refund facts.',
  saleCredit: { kind: 'line_seller_snapshot' }, discountAllocation: { kind: 'immutable_line_snapshot' },
  refunds: { recognition: 'recognized_event_date', closedRunTreatment: 'next_open_run_adjustment', paidAdjustment: 'owner_review_variable_pay_only',
    uncoveredBalance: 'carry_forward_review', clawback: 'no_automatic_clawback' } };
const components = Object.fromEntries([
  'sourcePolicies', 'approvedAttendance', 'canonicalLinePricing', 'payrollSaleCredit', 'recognitionManifest',
  'recognizedLineRefunds', 'fullEmployeeNetRevenue', 'marginCosts', 'departmentShiftAllocation', 'employeeRoleCoverage'
].map(key => [key, { status: 'unsupported', reasons: [`${key}_not_attested`] }]));
const readiness = { schemaVersion: 1, versionId: scheme.versionId, period, components };

assert.deepEqual(CALCULATOR_INPUT_CAPABILITIES, { signedRefundAdjustments: false, fullEmployeeNetRevenue: false, historicalEmploymentIntervals: true, explicitNoRefundEmployeeNetRevenue: true },
  'candidate input contract must follow capabilities declared by the actual wage engine');
const missingBundle = buildPayrollCalculationInputContract({ venueId, scheme, period, readiness });
assert.equal(missingBundle.status, 'blocked');
assert.equal(missingBundle.calculatorInput, null, 'unverified or absent data never becomes empty input collections');
assert.ok(missingBundle.reasons.includes('payroll_calculation_source_bundle_unavailable'));
assert.ok(missingBundle.reasons.includes('payroll_calculator_signed_refund_input_missing'));
assert.ok(!missingBundle.reasons.includes('payroll_calculator_historical_employment_interval_input_missing'),
  'the engine capability follows its tested support for historical eligibility intervals');
assert.ok(missingBundle.reasons.includes('payroll_calculator_full_employee_net_revenue_input_missing'));
assert.ok(missingBundle.requiredFacts.includes('venueDailyTurnover'));

const departmentScheme = { ...scheme, mode: 'stable_percent', roleParameters: { bar: { cap: { basis: 'employee_department_day' } } } };
const departmentRequiredFacts = ['employeeEligibility', 'approvedAttendance', 'canonicalLinePricing', 'payrollSaleCredit',
  'recognitionManifest', 'recognizedLineRefunds', 'fullEmployeeNetRevenue', 'employeeRoleCoverage', 'immutableDepartmentAttribution'];
const departmentReadinessComponents = { sourcePolicies: { status: 'available', reasons: [] } };
for (const fact of departmentRequiredFacts) departmentReadinessComponents[fact] = {
  status: 'available', reasons: [], sourceWatermark: fact === 'immutableDepartmentAttribution' ? 'd'.repeat(64) : 'e'.repeat(64),
  watermarkScope: `${fact}_verified_source`, venueId, currency: 'RUB', period
};
const departmentReadiness = { schemaVersion: 1, versionId: departmentScheme.versionId, period, components: departmentReadinessComponents };
const departmentBundleComponents = Object.fromEntries(departmentRequiredFacts.map(fact => [fact, { ...departmentReadinessComponents[fact] }]));
const departmentBundle = { schemaVersion: 1, venueId, schemeVersionId: departmentScheme.versionId, currency: 'RUB', period,
  readinessWatermark: fingerprint(departmentReadiness.components), components: departmentBundleComponents,
  calculatorInput: { periodFrom: period.from, periodTo: period.to } };
departmentBundle.inputWatermark = fingerprint(departmentBundle);
const departmentGate = buildPayrollCalculationInputContract({ venueId, scheme: departmentScheme, period,
  readiness: departmentReadiness, sourceBundle: departmentBundle });
assert.ok(departmentGate.requiredFacts.includes('immutableDepartmentAttribution'));
assert.ok(!departmentGate.reasons.includes('payroll_calculation_immutableDepartmentAttribution_evidence_incomplete'));
assert.ok(!departmentGate.reasons.includes('payroll_calculation_immutableDepartmentAttribution_readiness_binding_mismatch'),
  'the source bundle and readiness bind the same department watermark when a department cap requires it');

const partialAttendanceReadiness = structuredClone(readiness);
partialAttendanceReadiness.components.approvedAttendance = { status: 'available', reasons: [], sourceWatermark: 'c'.repeat(64),
  watermarkScope: 'owner_approved_attendance_snapshot' };
const partialAttendanceBundle = { schemaVersion: 1, venueId, schemeVersionId: scheme.versionId, currency: 'RUB', period,
  readinessWatermark: fingerprint(partialAttendanceReadiness.components),
  components: { approvedAttendance: { ...partialAttendanceReadiness.components.approvedAttendance, venueId, currency: 'RUB', period } },
  calculatorInput: { periodFrom: period.from, periodTo: period.to, attendance: [{ id: '33333333-3333-4333-8333-333333333333',
    employeeId: '44444444-4444-4444-8444-444444444444', date: '2026-10-02', approved: true, workedMinutes: 120, plannedMinutes: 480 }],
    attendanceCoverage: { kind: 'approved_attendance_complete', from: `${period.from.slice(0, 7)}-01`, through: period.to, complete: true, watermark: 'c'.repeat(64) } } };
partialAttendanceBundle.inputWatermark = fingerprint(partialAttendanceBundle);
const attendanceOnly = buildPayrollCalculationInputContract({ venueId, scheme, period, readiness: partialAttendanceReadiness,
  sourceBundle: partialAttendanceBundle });
assert.equal(attendanceOnly.status, 'blocked');
assert.equal(attendanceOnly.calculatorInput, null, 'verified attendance alone never becomes a payroll calculator input');
assert.ok(attendanceOnly.reasons.includes('payroll_calculation_employees_collection_missing'));
assert.ok(attendanceOnly.reasons.includes('payroll_calculation_roleAssignments_collection_missing'));
assert.ok(attendanceOnly.reasons.includes('payroll_calculation_sales_collection_missing'));

const wrongContext = buildPayrollCalculationInputContract({ venueId, scheme, period, readiness, sourceBundle: {
  schemaVersion: 1, venueId, schemeVersionId: scheme.versionId, currency: 'USD', period,
  readinessWatermark: '0'.repeat(64), inputWatermark: 'a'.repeat(64), components: {}, calculatorInput: {}
} });
assert.equal(wrongContext.status, 'blocked');
assert.equal(wrongContext.calculatorInput, null);
assert.ok(wrongContext.reasons.includes('payroll_calculation_source_bundle_context_mismatch'));
assert.ok(wrongContext.reasons.includes('payroll_calculation_input_watermark_mismatch'));

const required = ['sourcePolicies', 'employeeEligibility', 'approvedAttendance', 'canonicalLinePricing', 'payrollSaleCredit', 'recognitionManifest',
  'recognizedLineRefunds', 'fullEmployeeNetRevenue', 'venueDailyTurnover'];
const readinessComponents = Object.fromEntries(required.filter(fact => fact !== 'sourcePolicies').map(fact => [fact, {
  status: 'available', reasons: [], sourceWatermark: `${fact.length}`.repeat(64).slice(0, 64), watermarkScope: `${fact}_source`,
  venueId, currency: 'RUB', period
}]));
readinessComponents.sourcePolicies = { status: 'available', reasons: [] };
const roleAttestation = { status: 'available', reasons: [], sourceWatermark: 'e'.repeat(64), watermarkScope: 'employee_role_coverage' };
readinessComponents.employeeRoleCoverage = { ...roleAttestation };
const availableReadiness = { schemaVersion: 1, versionId: scheme.versionId, period, components: readinessComponents };
const emptyEligibilityPeriods = [];
const eligibilityRevision = { id: '88888888-8888-4888-8888-888888888888', revisionNo: 1, reason: 'Owner roster confirmed',
  idempotency_key: 'payroll-employment:qa-contract', payload_sha256: eligibilityPayloadSha256(emptyEligibilityPeriods, 'Owner roster confirmed'),
  periodCount: 0, created_by: '99999999-9999-4999-8999-999999999999', created_by_name: 'Owner QA',
  created_at: '2026-10-19 10:00:00+00' };
eligibilityRevision.sourceWatermark = eligibilitySourceWatermark(venueId, eligibilityRevision, emptyEligibilityPeriods);
readinessComponents.employeeEligibility = { status: 'available', reasons: [], sourceWatermark: eligibilityRevision.sourceWatermark,
  watermarkScope: 'owner_attested_payroll_employment_eligibility_revision', revisionId: eligibilityRevision.id, revisionNo: 1, periodCount: 0 };
const inputBundle = { schemaVersion: 1, venueId, schemeVersionId: scheme.versionId, currency: 'RUB', period: { from: period.from, to: period.to },
  readinessWatermark: fingerprint(readinessComponents), components: {
    ...Object.fromEntries(Object.entries(readinessComponents).filter(([fact]) => fact !== 'sourcePolicies')),
    employeeEligibility: { ...readinessComponents.employeeEligibility, venueId, currency: 'RUB', period },
    employeeRoleCoverage: { ...readinessComponents.employeeRoleCoverage, venueId, currency: 'RUB', period }
  },
  employmentEligibility: { revision: eligibilityRevision, periods: emptyEligibilityPeriods },
  calculatorInput: { periodFrom: period.from, periodTo: period.to, employmentEligibilityRevisionId: eligibilityRevision.id,
    coverage: { kind: 'month_to_date_complete', from: `${period.from.slice(0, 7)}-01`, through: period.to, complete: true, watermark: 'd'.repeat(64) },
    attendanceCoverage: { kind: 'approved_attendance_complete', from: `${period.from.slice(0, 7)}-01`, through: period.to, complete: true, watermark: readinessComponents.approvedAttendance.sourceWatermark },
    employees: [], roleAssignments: [], attendance: [], sales: [], venueDailyTurnover: [] } };
inputBundle.inputWatermark = fingerprint(inputBundle);

const noRefundScheme = { ...scheme, mode: 'stable_percent', sourcePolicies };
const noRefundReadiness = structuredClone(availableReadiness);
noRefundReadiness.period = { ...period };
const noRefundBundle = structuredClone(inputBundle);
noRefundBundle.period = { from: period.from, to: period.to };
delete noRefundBundle.periodClosure;
const noRefundClosure = { schemaVersion: 1, venueId, period: { from: period.from, to: period.to },
  transactionTimestamp: '2026-11-01T02:00:00.000Z', venueLocalDate: '2026-11-01', timezone: period.timezone };
noRefundBundle.components = Object.fromEntries(Object.entries(noRefundReadiness.components)
  .filter(([name]) => name !== 'sourcePolicies').map(([name, component]) => [name, { ...component, venueId, currency: 'RUB', period: { from: period.from, to: period.to } }]));
noRefundBundle.readinessWatermark = fingerprint(noRefundReadiness.components);
noRefundBundle.recognitionManifest = { schemaVersion: 1, status: 'available', officialReady: false, venueId, currency: 'RUB',
  period: { from: period.from, to: period.to }, watermark: fingerprint({ noRefundManifest: true }), reasons: [], sales: [],
  closedOrderSales: [], saleEvents: [], saleLines: [], refundEvents: [], refundHistory: [], refundOriginalSaleAttributions: [],
  watermarkScope: 'payroll_recognition_manifest',
  relatedRefundCoverage: { schemaVersion: 1, status: 'complete',
    scope: 'all_recorded_refunds_for_payroll_related_orders_as_of_repeatable_read_snapshot',
    sourceWatermark: null, periodSaleOrderIds: [], coveredOrderIds: [],
    relatedRefundHeaderIds: [], relatedRefundEventIds: [], relatedRefundItemIds: [], relatedRefundLineEventIds: [] } };
const noRefundProjection = buildPayrollRecognitionPreview(noRefundBundle.recognitionManifest, sourcePolicies);
assert.equal(noRefundProjection.sourceStatus, 'available', 'fixture uses the same normalized source policy as sourced-preview contracts');
noRefundBundle.recognitionManifest.relatedRefundCoverage.sourceWatermark = noRefundBundle.recognitionManifest.watermark;
noRefundBundle.recognizedLineProjection = { schemaVersion: 1, venueId, currency: 'RUB', period: { from: period.from, to: period.to },
  sourceWatermark: noRefundBundle.recognitionManifest.watermark, projectionWatermark: noRefundProjection.projectionWatermark,
  sourceStatus: noRefundProjection.sourceStatus, sourceReasons: noRefundProjection.sourceReasons,
  saleLines: noRefundProjection.saleLines, refundAdjustments: noRefundProjection.refundAdjustments };
noRefundBundle.components.recognitionManifest.sourceWatermark = noRefundBundle.recognitionManifest.watermark;
noRefundBundle.components.recognitionManifest.watermarkScope = 'payroll_recognition_manifest';
noRefundBundle.components.recognizedLineRefunds = { ...noRefundBundle.components.recognizedLineRefunds,
  status: 'available', reasons: [], sourceWatermark: noRefundProjection.projectionWatermark,
  watermarkScope: 'immutable_recognized_sale_and_refund_candidate_projection' };
noRefundReadiness.components.recognitionManifest = { ...noRefundReadiness.components.recognitionManifest,
  status: 'available', reasons: [], sourceWatermark: noRefundBundle.recognitionManifest.watermark,
  watermarkScope: 'payroll_recognition_manifest' };
noRefundReadiness.components.recognizedLineRefunds = { ...noRefundReadiness.components.recognizedLineRefunds,
  status: 'available', reasons: [], sourceWatermark: noRefundProjection.projectionWatermark,
  watermarkScope: 'immutable_recognized_sale_and_refund_candidate_projection' };
noRefundBundle.fullEmployeeNetRevenue = buildPayrollFullEmployeeNetRevenueSource(noRefundBundle.recognitionManifest, sourcePolicies);
noRefundBundle.components.fullEmployeeNetRevenue = { ...noRefundBundle.components.fullEmployeeNetRevenue,
  status: noRefundBundle.fullEmployeeNetRevenue.status, reasons: noRefundBundle.fullEmployeeNetRevenue.reasons,
  sourceWatermark: noRefundBundle.fullEmployeeNetRevenue.sourceWatermark,
  watermarkScope: noRefundBundle.fullEmployeeNetRevenue.watermarkScope };
noRefundReadiness.components.fullEmployeeNetRevenue = { ...noRefundReadiness.components.fullEmployeeNetRevenue,
  status: noRefundBundle.fullEmployeeNetRevenue.status, reasons: noRefundBundle.fullEmployeeNetRevenue.reasons,
  sourceWatermark: noRefundBundle.fullEmployeeNetRevenue.sourceWatermark,
  watermarkScope: noRefundBundle.fullEmployeeNetRevenue.watermarkScope };
noRefundBundle.components.venueDailyTurnover = { status: 'available', reasons: [], sourceWatermark: 'f'.repeat(64),
  watermarkScope: 'owner_closed_order_turnover_pre_refund', venueId, currency: 'RUB', period: { from: period.from, to: period.to } };
noRefundReadiness.components.venueDailyTurnover = { ...noRefundBundle.components.venueDailyTurnover };
noRefundBundle.venueDailyTurnover = { from: period.from, through: period.to, venueTimezone: period.timezone,
  amountBasis: 'finance_recognized_closed_order_total_pre_refund', refundsIncluded: false,
  sourceWatermark: noRefundReadiness.components.venueDailyTurnover.sourceWatermark,
  venueDailyTurnover: Array.from({ length: 31 }, (_, index) => ({ date: `2026-10-${String(index + 1).padStart(2, '0')}`, turnoverCents: 0 })) };
noRefundBundle.calculatorInput.venueDailyTurnover = noRefundBundle.venueDailyTurnover.venueDailyTurnover;
noRefundBundle.calculatorInput.venueDailyTurnoverCoverage = { from: period.from, through: period.to, complete: true,
  venueId, currency: 'RUB', period: { from: period.from, to: period.to }, venueTimezone: period.timezone,
  sourceWatermark: noRefundReadiness.components.venueDailyTurnover.sourceWatermark,
  watermarkScope: 'owner_closed_order_turnover_pre_refund', refundsIncluded: false,
  amountBasis: 'finance_recognized_closed_order_total_pre_refund' };
noRefundBundle.orderRevenueReconciliation = buildPayrollOrderRevenueReconciliation({ venueId, currency: 'RUB', period,
  venueTimezone: period.timezone, orders: [], recognitionManifest: noRefundBundle.recognitionManifest });
noRefundBundle.calculatorInput.personalRevenueSource = buildPayrollPersonalRevenueSource({ venueId, currency: 'RUB', period,
  recognitionManifest: noRefundBundle.recognitionManifest, sourcePolicies, fullEmployeeNetRevenue: noRefundBundle.fullEmployeeNetRevenue,
  orderRevenueReconciliation: noRefundBundle.orderRevenueReconciliation });
noRefundBundle.readinessWatermark = fingerprint(noRefundReadiness.components);
noRefundBundle.inputWatermark = fingerprint(Object.fromEntries(Object.entries(noRefundBundle).filter(([key]) => key !== 'inputWatermark')));
const noRefundInput = buildPayrollCalculationInputContract({ venueId, scheme: noRefundScheme, period, readiness: noRefundReadiness,
  sourceBundle: noRefundBundle, attestations: { venueDailyTurnover: noRefundReadiness.components.venueDailyTurnover },
  purpose: 'official_no_refund_input', periodClosure: noRefundClosure });
assert.equal(noRefundInput.status, 'verified_no_refund_input', JSON.stringify(noRefundInput.reasons));
assert.equal(noRefundInput.capabilityVersion, 'employee_attributed_merchandise_net_no_refund_v1');
assert.equal(noRefundInput.officialReady, false);
assert.equal(noRefundInput.payoutEligible, false);
assert.equal(noRefundInput.persistence, 'none');
assert.equal(noRefundInput.calculatorInput.scheme.versionId, scheme.versionId);
assert.equal(noRefundInput.reasons.length, 0);

const openPeriod = buildPayrollCalculationInputContract({ venueId, scheme: noRefundScheme, period, readiness: noRefundReadiness,
  attestations: { venueDailyTurnover: noRefundReadiness.components.venueDailyTurnover }, sourceBundle: noRefundBundle,
  purpose: 'official_no_refund_input', periodClosure: { ...noRefundClosure, venueLocalDate: period.to } });
assert.equal(openPeriod.status, 'blocked');
assert.ok(openPeriod.reasons.includes('payroll_calculation_period_not_closed'));

const laterClosure = { ...noRefundClosure, transactionTimestamp: '2026-11-02T02:00:00.000Z', venueLocalDate: '2026-11-02' };
const laterClosedInput = buildPayrollCalculationInputContract({ venueId, scheme: noRefundScheme, period, readiness: noRefundReadiness,
  attestations: { venueDailyTurnover: noRefundReadiness.components.venueDailyTurnover }, sourceBundle: noRefundBundle,
  purpose: 'official_no_refund_input', periodClosure: laterClosure });
assert.equal(laterClosedInput.inputWatermark, noRefundInput.inputWatermark, 'closure time does not change source input fingerprint');
assert.notEqual(laterClosedInput.closureWatermark, noRefundInput.closureWatermark, 'closure proof is separately fingerprinted');

const refundBundle = structuredClone(noRefundBundle);
refundBundle.recognitionManifest.refundEvents.push({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
refundBundle.inputWatermark = fingerprint(Object.fromEntries(Object.entries(refundBundle).filter(([key]) => key !== 'inputWatermark')));
const withRefund = buildPayrollCalculationInputContract({ venueId, scheme: noRefundScheme, period, readiness: noRefundReadiness,
  attestations: { venueDailyTurnover: noRefundReadiness.components.venueDailyTurnover }, sourceBundle: refundBundle, purpose: 'official_no_refund_input' });
assert.equal(withRefund.status, 'blocked');
assert.ok(withRefund.reasons.includes('payroll_official_no_refund_coverage_not_proven'));
const incompleteRoleReadiness = structuredClone(availableReadiness);
incompleteRoleReadiness.components.employeeRoleCoverage = { ...roleAttestation, status: 'incomplete',
  reasons: ['payroll_employee_role_coverage_assignment_gap'] };
const incompleteRoleBundle = structuredClone(inputBundle);
incompleteRoleBundle.components.employeeRoleCoverage = { ...incompleteRoleReadiness.components.employeeRoleCoverage,
  venueId, currency: 'RUB', period };
incompleteRoleBundle.readinessWatermark = fingerprint(incompleteRoleReadiness.components);
incompleteRoleBundle.inputWatermark = fingerprint(Object.fromEntries(Object.entries(incompleteRoleBundle).filter(([key]) => key !== 'inputWatermark')));
const roleCoverageBlocked = buildPayrollCalculationInputContract({ venueId, scheme, period, readiness: incompleteRoleReadiness,
  sourceBundle: incompleteRoleBundle });
assert.equal(roleCoverageBlocked.status, 'blocked', 'incomplete active employee-day role coverage blocks the calculator input');
assert.equal(roleCoverageBlocked.calculatorInput, null);
assert.ok(roleCoverageBlocked.reasons.includes('payroll_employee_role_coverage_assignment_gap'));
const mismatchedSource = structuredClone(inputBundle);
mismatchedSource.components.recognitionManifest.sourceWatermark = 'f'.repeat(64);
const watermarkPayload = structuredClone(mismatchedSource);
delete watermarkPayload.inputWatermark;
mismatchedSource.inputWatermark = fingerprint(watermarkPayload);
const boundMismatch = buildPayrollCalculationInputContract({ venueId, scheme, period, readiness: availableReadiness,
  attestations: { employeeRoleCoverage: roleAttestation }, sourceBundle: mismatchedSource });
assert.ok(boundMismatch.reasons.includes('payroll_calculation_recognitionManifest_readiness_binding_mismatch'),
  'a self-consistent bundle hash cannot replace the readiness source watermark');
assert.equal(boundMismatch.calculatorInput, null);

const employeeId = '33333333-3333-4333-8333-333333333333';
const roleAssignment = { employeeId, roleId: 'bar', effectiveFrom: period.from, effectiveTo: null };
const schemeWithRole = { ...scheme, roleAssignments: [roleAssignment] };
const boundEligibilityBundle = (periodRows) => {
  const bundle = structuredClone(inputBundle), ready = structuredClone(availableReadiness);
  const revision = bundle.employmentEligibility.revision;
  bundle.employmentEligibility.periods = periodRows;
  revision.periodCount = periodRows.length;
  revision.payload_sha256 = eligibilityPayloadSha256(periodRows.map(({ employeeId, effectiveFrom, effectiveTo }) => ({ employeeId, effectiveFrom, effectiveTo })), revision.reason);
  revision.sourceWatermark = eligibilitySourceWatermark(venueId, revision, periodRows);
  for (const target of [bundle.components.employeeEligibility, ready.components.employeeEligibility]) {
    target.sourceWatermark = revision.sourceWatermark;
    target.periodCount = periodRows.length;
  }
  bundle.readinessWatermark = fingerprint(ready.components);
  bundle.calculatorInput.employmentEligibilityRevisionId = revision.id;
  bundle.calculatorInput.roleAssignments = [roleAssignment];
  bundle.inputWatermark = fingerprint(Object.fromEntries(Object.entries(bundle).filter(([key]) => key !== 'inputWatermark')));
  return { bundle, ready };
};
const employmentPeriods = [
  { employeeId, employeeName: 'QA employee', effectiveFrom: period.from, effectiveTo: '2026-10-03' },
  { employeeId, employeeName: 'QA employee', effectiveFrom: '2026-10-06', effectiveTo: null }
];
const eligibilityBound = boundEligibilityBundle(employmentPeriods);
eligibilityBound.bundle.calculatorInput.employees = [{ id: employeeId, activeIntervals: [
  { from: period.from, to: '2026-10-03' }, { from: '2026-10-06', to: period.to }
] }];
eligibilityBound.bundle.inputWatermark = fingerprint(Object.fromEntries(Object.entries(eligibilityBound.bundle).filter(([key]) => key !== 'inputWatermark')));
const matchedEligibility = buildPayrollCalculationInputContract({ venueId, scheme: schemeWithRole, period, readiness: eligibilityBound.ready,
  attestations: { employeeRoleCoverage: roleAttestation }, sourceBundle: eligibilityBound.bundle });
assert.ok(!matchedEligibility.reasons.includes('payroll_calculation_employee_eligibility_roster_mismatch'));
assert.ok(!matchedEligibility.reasons.includes('payroll_calculation_employee_eligibility_period_mismatch'),
  'disjoint employee intervals must match the owner-attested source exactly');
const dormantEmployeeId = '77777777-7777-4777-8777-777777777777';
const dormantOverlapAssignments = [
  { employeeId: dormantEmployeeId, roleId: 'bar', effectiveFrom: '2025-01-01', effectiveTo: '2025-12-31' },
  { employeeId: dormantEmployeeId, roleId: 'bar', effectiveFrom: '2025-06-01', effectiveTo: '2026-01-31' }
];
const staleOverlapScheme = { ...schemeWithRole, roleAssignments: [...schemeWithRole.roleAssignments, ...dormantOverlapAssignments] };
const staleOverlapBundle = structuredClone(eligibilityBound.bundle);
staleOverlapBundle.calculatorInput.roleAssignments = staleOverlapScheme.roleAssignments;
staleOverlapBundle.inputWatermark = fingerprint(Object.fromEntries(Object.entries(staleOverlapBundle).filter(([key]) => key !== 'inputWatermark')));
const staleOverlapResult = buildPayrollCalculationInputContract({ venueId, scheme: staleOverlapScheme, period,
  readiness: eligibilityBound.ready, attestations: { employeeRoleCoverage: roleAttestation }, sourceBundle: staleOverlapBundle });
assert.ok(!staleOverlapResult.reasons.includes('payroll_calculation_role_assignment_overlap'),
  'historical overlap for an employee with no active days in this period does not block the input');
assert.ok(!staleOverlapResult.reasons.includes('payroll_calculation_role_assignments_scheme_mismatch'));
assert.ok(!matchedEligibility.reasons.includes('payroll_calculator_historical_employment_interval_input_missing'));
assert.equal(matchedEligibility.calculatorInput, null, 'unsupported source requirements still block the calculator input');
const secondEligibilityRevision = structuredClone(eligibilityBound);
const previousRevisionId = '99999999-9999-4999-8999-999999999999';
const revision2 = secondEligibilityRevision.bundle.employmentEligibility.revision;
revision2.revisionNo = 2;
revision2.supersedes_revision_id = previousRevisionId;
revision2.payload_sha256 = eligibilityPayloadSha256(secondEligibilityRevision.bundle.employmentEligibility.periods
  .map(({ employeeId: id, effectiveFrom, effectiveTo }) => ({ employeeId: id, effectiveFrom, effectiveTo })), revision2.reason, previousRevisionId);
revision2.sourceWatermark = eligibilitySourceWatermark(venueId, revision2, secondEligibilityRevision.bundle.employmentEligibility.periods);
for (const component of [secondEligibilityRevision.bundle.components.employeeEligibility,
  secondEligibilityRevision.ready.components.employeeEligibility]) {
  component.revisionNo = 2;
  component.sourceWatermark = revision2.sourceWatermark;
}
secondEligibilityRevision.bundle.readinessWatermark = fingerprint(secondEligibilityRevision.ready.components);
secondEligibilityRevision.bundle.inputWatermark = fingerprint(Object.fromEntries(Object.entries(secondEligibilityRevision.bundle).filter(([key]) => key !== 'inputWatermark')));
const validatedRevision2 = buildPayrollCalculationInputContract({ venueId, scheme: schemeWithRole, period,
  readiness: secondEligibilityRevision.ready, attestations: { employeeRoleCoverage: roleAttestation }, sourceBundle: secondEligibilityRevision.bundle });
assert.ok(!validatedRevision2.reasons.includes('payroll_calculation_employee_eligibility_payload_mismatch'),
  'revision 2 integrity hash includes the predecessor revision ID used at save time');
assert.ok(!validatedRevision2.reasons.includes('payroll_calculation_employee_eligibility_watermark_mismatch'));
assert.equal(validatedRevision2.calculatorInput, null, 'revision 2 integrity does not relax independent source requirements');
const changedEligibilityRows = structuredClone(eligibilityBound.bundle);
changedEligibilityRows.calculatorInput.employees[0].activeIntervals[1].from = '2026-10-05';
changedEligibilityRows.inputWatermark = fingerprint(Object.fromEntries(Object.entries(changedEligibilityRows).filter(([key]) => key !== 'inputWatermark')));
const changedEligibility = buildPayrollCalculationInputContract({ venueId, scheme: schemeWithRole, period, readiness: eligibilityBound.ready,
  attestations: { employeeRoleCoverage: roleAttestation }, sourceBundle: changedEligibilityRows });
assert.ok(changedEligibility.reasons.includes('payroll_calculation_employee_eligibility_period_mismatch'), JSON.stringify(changedEligibility));
const wrongEligibilityRevision = structuredClone(eligibilityBound.bundle);
wrongEligibilityRevision.calculatorInput.employmentEligibilityRevisionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
wrongEligibilityRevision.inputWatermark = fingerprint(Object.fromEntries(Object.entries(wrongEligibilityRevision).filter(([key]) => key !== 'inputWatermark')));
const wrongEligibilityBinding = buildPayrollCalculationInputContract({ venueId, scheme: schemeWithRole, period, readiness: eligibilityBound.ready,
  attestations: { employeeRoleCoverage: roleAttestation }, sourceBundle: wrongEligibilityRevision });
assert.ok(wrongEligibilityBinding.reasons.includes('payroll_calculation_employee_eligibility_revision_mismatch'));

const malformedRowsBundle = structuredClone(inputBundle);
malformedRowsBundle.calculatorInput.employees = [{ id: employeeId, activeFrom: period.from, activeTo: null }];
malformedRowsBundle.calculatorInput.roleAssignments = [roleAssignment];
malformedRowsBundle.calculatorInput.attendance = [{ id: '55555555-5555-4555-8555-555555555555', employeeId: '66666666-6666-4666-8666-666666666666',
  date: period.from, approved: true, workedMinutes: 60, plannedMinutes: 60 }];
malformedRowsBundle.inputWatermark = fingerprint(Object.fromEntries(Object.entries(malformedRowsBundle).filter(([key]) => key !== 'inputWatermark')));
const invalidEmployeeJoin = buildPayrollCalculationInputContract({ venueId, scheme: schemeWithRole, period, readiness: availableReadiness,
  attestations: { employeeRoleCoverage: roleAttestation }, sourceBundle: malformedRowsBundle });
assert.ok(invalidEmployeeJoin.reasons.includes('payroll_calculation_attendance_row_invalid'),
  'a verified-looking attendance row cannot refer to an employee outside the source employee collection');
assert.ok(invalidEmployeeJoin.reasons.includes('payroll_calculation_employee_eligibility_roster_mismatch'),
  'employees outside the exact owner-attested effective-date roster block the input');
assert.equal(invalidEmployeeJoin.calculatorInput, null);

const caseSensitiveEmployeeId = 'abcdefab-cdef-4abc-8def-abcdefabcdef';
const uppercaseEmployeeId = caseSensitiveEmployeeId.toUpperCase();
const caseVariantScheme = { ...schemeWithRole, roleAssignments: [{ ...roleAssignment, employeeId: caseSensitiveEmployeeId }] };
const mixedCaseUuidBundle = structuredClone(inputBundle);
mixedCaseUuidBundle.calculatorInput.employees = [{ id: caseSensitiveEmployeeId, activeFrom: period.from, activeTo: null }];
mixedCaseUuidBundle.calculatorInput.roleAssignments = [{ ...roleAssignment, employeeId: uppercaseEmployeeId }];
mixedCaseUuidBundle.calculatorInput.attendance = [{ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'.toUpperCase(),
  employeeId: uppercaseEmployeeId, date: period.from, approved: true, workedMinutes: 60, plannedMinutes: 60 }];
mixedCaseUuidBundle.calculatorInput.sales = [{ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'.toUpperCase(),
  employeeId: uppercaseEmployeeId, date: period.from, currency: 'RUB', department: 'bar', turnoverCents: 100,
  commissionBaseCents: 100, sourceWatermark: readinessComponents.recognitionManifest.sourceWatermark }];
mixedCaseUuidBundle.inputWatermark = fingerprint(Object.fromEntries(Object.entries(mixedCaseUuidBundle).filter(([key]) => key !== 'inputWatermark')));
const mixedCaseUuid = buildPayrollCalculationInputContract({ venueId, scheme: caseVariantScheme, period, readiness: availableReadiness,
  attestations: { employeeRoleCoverage: roleAttestation }, sourceBundle: mixedCaseUuidBundle });
assert.ok(!mixedCaseUuid.reasons.includes('payroll_calculation_attendance_row_invalid'),
  'valid UUID casing differences must not break attendance employee joins');
assert.ok(!mixedCaseUuid.reasons.includes('payroll_calculation_sale_row_invalid'),
  'valid UUID casing differences must not break sale employee joins');
assert.ok(!mixedCaseUuid.reasons.includes('payroll_calculation_role_assignments_scheme_mismatch'),
  'role assignment identity comparison is case-insensitive for UUID values');

const duplicateAttendanceUuidBundle = structuredClone(mixedCaseUuidBundle);
duplicateAttendanceUuidBundle.calculatorInput.attendance.push({ ...duplicateAttendanceUuidBundle.calculatorInput.attendance[0],
  id: duplicateAttendanceUuidBundle.calculatorInput.attendance[0].id.toLowerCase() });
duplicateAttendanceUuidBundle.inputWatermark = fingerprint(Object.fromEntries(Object.entries(duplicateAttendanceUuidBundle)
  .filter(([key]) => key !== 'inputWatermark')));
const duplicateAttendanceUuid = buildPayrollCalculationInputContract({ venueId, scheme: caseVariantScheme, period,
  readiness: availableReadiness, attestations: { employeeRoleCoverage: roleAttestation }, sourceBundle: duplicateAttendanceUuidBundle });
assert.ok(duplicateAttendanceUuid.reasons.includes('payroll_calculation_attendance_row_invalid'),
  'duplicate UUIDs with different letter casing are still rejected');

const attendanceOutsideActivePeriod = structuredClone(malformedRowsBundle);
attendanceOutsideActivePeriod.calculatorInput.employees = [{ id: employeeId, activeFrom: '2026-10-03', activeTo: null }];
attendanceOutsideActivePeriod.calculatorInput.attendance[0].employeeId = employeeId;
attendanceOutsideActivePeriod.calculatorInput.attendance[0].date = '2026-10-02';
attendanceOutsideActivePeriod.inputWatermark = fingerprint(Object.fromEntries(Object.entries(attendanceOutsideActivePeriod).filter(([key]) => key !== 'inputWatermark')));
const activeAttendance = buildPayrollCalculationInputContract({ venueId, scheme: schemeWithRole, period, readiness: availableReadiness,
  attestations: { employeeRoleCoverage: roleAttestation }, sourceBundle: attendanceOutsideActivePeriod });
assert.ok(activeAttendance.reasons.includes('payroll_calculation_attendance_outside_employee_active_period'));

const malformedCoverageBundle = structuredClone(inputBundle);
malformedCoverageBundle.calculatorInput.coverage.kind = 'unknown';
malformedCoverageBundle.inputWatermark = fingerprint(Object.fromEntries(Object.entries(malformedCoverageBundle).filter(([key]) => key !== 'inputWatermark')));
const malformedCoverage = buildPayrollCalculationInputContract({ venueId, scheme, period, readiness: availableReadiness,
  attestations: { employeeRoleCoverage: roleAttestation }, sourceBundle: malformedCoverageBundle });
assert.ok(malformedCoverage.reasons.includes('payroll_calculation_sales_coverage_manifest_invalid'));

const malformedAttendanceCoverageBundle = structuredClone(inputBundle);
malformedAttendanceCoverageBundle.calculatorInput.attendanceCoverage.kind = 'unknown';
malformedAttendanceCoverageBundle.inputWatermark = fingerprint(Object.fromEntries(Object.entries(malformedAttendanceCoverageBundle).filter(([key]) => key !== 'inputWatermark')));
const malformedAttendanceCoverage = buildPayrollCalculationInputContract({ venueId, scheme, period, readiness: availableReadiness,
  attestations: { employeeRoleCoverage: roleAttestation }, sourceBundle: malformedAttendanceCoverageBundle });
assert.ok(malformedAttendanceCoverage.reasons.includes('payroll_calculation_attendance_coverage_manifest_invalid'));

const uncoveredAttendanceBundle = structuredClone(malformedRowsBundle);
uncoveredAttendanceBundle.calculatorInput.attendance[0].employeeId = employeeId;
uncoveredAttendanceBundle.calculatorInput.roleAssignments[0].effectiveTo = period.from;
uncoveredAttendanceBundle.inputWatermark = fingerprint(Object.fromEntries(Object.entries(uncoveredAttendanceBundle).filter(([key]) => key !== 'inputWatermark')));
const schemeWithRoleGap = { ...scheme, roleAssignments: [{ ...roleAssignment, effectiveTo: period.from }] };
const roleGap = buildPayrollCalculationInputContract({ venueId, scheme: schemeWithRoleGap, period, readiness: availableReadiness,
  attestations: { employeeRoleCoverage: roleAttestation }, sourceBundle: uncoveredAttendanceBundle });
assert.ok(roleGap.reasons.includes('payroll_calculation_role_assignment_gap'),
  'the saved version must assign exactly one payroll role throughout an employee active interval');
assert.equal(roleGap.calculatorInput, null);
const activeOverlapAssignment = { employeeId, roleId: 'bar', effectiveFrom: '2026-10-15', effectiveTo: null };
const activeOverlapScheme = { ...schemeWithRole, roleAssignments: [roleAssignment, activeOverlapAssignment] };
const activeOverlapBundle = structuredClone(eligibilityBound.bundle);
activeOverlapBundle.calculatorInput.roleAssignments = activeOverlapScheme.roleAssignments;
activeOverlapBundle.inputWatermark = fingerprint(Object.fromEntries(Object.entries(activeOverlapBundle).filter(([key]) => key !== 'inputWatermark')));
const activeOverlap = buildPayrollCalculationInputContract({ venueId, scheme: activeOverlapScheme, period,
  readiness: eligibilityBound.ready, attestations: { employeeRoleCoverage: roleAttestation }, sourceBundle: activeOverlapBundle });
assert.ok(activeOverlap.reasons.includes('payroll_calculation_role_assignment_overlap'),
  'overlapping roles still block when they collide on an active employee-day');

const invalidSalesBundle = structuredClone(inputBundle);
invalidSalesBundle.calculatorInput.employees = [{ id: employeeId, activeFrom: period.from, activeTo: null }];
invalidSalesBundle.calculatorInput.roleAssignments = [roleAssignment];
invalidSalesBundle.calculatorInput.sales = [{ id: '77777777-7777-4777-8777-777777777777', employeeId, date: period.from, currency: 'RUB',
  turnoverCents: 10000, commissionBaseCents: 10000,
  sourceWatermark: readinessComponents.recognitionManifest.sourceWatermark }];
invalidSalesBundle.inputWatermark = fingerprint(Object.fromEntries(Object.entries(invalidSalesBundle).filter(([key]) => key !== 'inputWatermark')));
const saleMissingDepartment = buildPayrollCalculationInputContract({ venueId, scheme: schemeWithRole, period, readiness: availableReadiness,
  attestations: { employeeRoleCoverage: roleAttestation }, sourceBundle: invalidSalesBundle });
assert.ok(saleMissingDepartment.reasons.includes('payroll_calculation_sale_row_invalid'),
  'a source line cannot reach the calculator without the department field the calculator and snapshot contract consume');
assert.equal(saleMissingDepartment.calculatorInput, null);

const saleOutsideActivePeriodBundle = structuredClone(invalidSalesBundle);
saleOutsideActivePeriodBundle.calculatorInput.employees = [{ id: employeeId, activeFrom: '2026-10-03', activeTo: null }];
saleOutsideActivePeriodBundle.calculatorInput.sales[0].department = 'bar';
saleOutsideActivePeriodBundle.calculatorInput.sales[0].date = '2026-10-02';
saleOutsideActivePeriodBundle.inputWatermark = fingerprint(Object.fromEntries(Object.entries(saleOutsideActivePeriodBundle).filter(([key]) => key !== 'inputWatermark')));
const activeSale = buildPayrollCalculationInputContract({ venueId, scheme: schemeWithRole, period, readiness: availableReadiness,
  attestations: { employeeRoleCoverage: roleAttestation }, sourceBundle: saleOutsideActivePeriodBundle });
assert.ok(activeSale.reasons.includes('payroll_calculation_sale_outside_employee_active_period'));

assert.throws(() => buildPayrollCalculationInputContract({ venueId, period, readiness }), /payroll_calculation_input_evidence_required/);
const validV2 = require('../payroll-source-policies').normalizePayrollSourcePolicies({ ...sourcePolicies, schemaVersion: 2,
  earnings: { refunds: 'remaining_merchandise_original_sale_date_v1', venueTurnover: 'canonical_total_less_merchandise_returns_v1',
    marginCost: 'frozen_sale_depletion_cost_payroll_v1' } });
for (const sourcePolicy of [{ schemaVersion: 2 }, validV2]) for (const purpose of ['official', 'candidate_preview', 'official_no_refund_input']) {
  const v2 = buildPayrollCalculationInputContract({ venueId, scheme: { ...schemeWithRole,
    sourcePolicies: sourcePolicy }, period,
    readiness: availableReadiness, sourceBundle: inputBundle, purpose });
  assert.equal(v2.status, 'blocked'); assert.equal(v2.calculatorInput, null);
  assert.deepEqual(v2.reasons, ['payroll_refund_policy_requires_versioned_input']);
}
console.log('PASS payroll-calculation-input-contract');
