import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
const require = createRequire(import.meta.url);
const { buildPayrollVerifiedCalculation } = require('../payroll-verified-calculation.js');
const { buildPayrollRecognitionPreview } = require('../payroll-recognition-preview.js');
const { buildPayrollFullEmployeeNetRevenueSource } = require('../payroll-full-employee-net-revenue-source.js');
const { buildPayrollOrderRevenueReconciliation } = require('../payroll-order-revenue-reconciliation.js');
const { buildPayrollPersonalRevenueSource } = require('../payroll-personal-revenue-source.js');
const { eligibilityPayloadSha256, eligibilitySourceWatermark, buildEligibleEmployees } = require('../payroll-employment-eligibility.js');
const { buildPayrollCalculatorSales } = require('../payroll-team-fund-source.js');

const stable = value => Array.isArray(value) ? `[${value.map(stable).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`
    : JSON.stringify(value);
const digest = value => createHash('sha256').update(stable(value)).digest('hex');
const venueId = '11111111-1111-4111-8111-111111111111';
const employeeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const orderId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const snapshotId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const saleEventId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const saleLineId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const orderItemId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const period = { from: '2026-10-01', to: '2026-10-31', timezone: 'UTC' };
const policies = { schemaVersion: 1, selectionReason: 'Owner selected immutable sale and event-date refund facts.',
  saleCredit: { kind: 'line_seller_snapshot' }, discountAllocation: { kind: 'immutable_line_snapshot' },
  refunds: { recognition: 'recognized_event_date', closedRunTreatment: 'next_open_run_adjustment', paidAdjustment: 'owner_review_variable_pay_only',
    uncoveredBalance: 'carry_forward_review', clawback: 'no_automatic_clawback' } };
const roleAssignment = { employeeId, roleId: 'bar', effectiveFrom: period.from, effectiveTo: null };
const scheme = { id: '22222222-2222-4222-8222-222222222222', versionId: '33333333-3333-4333-8333-333333333333',
  currency: 'RUB', mode: 'stable_percent', sourcePolicies: policies, roleAssignments: [roleAssignment],
  roleParameters: { bar: { perShiftCents: 0, stableRateBps: 1000 } },
  payoutRiskAcknowledgement: { confirmed: true, policyCode: 'payroll-own-revenue-ceiling-v1', configDigest: 'a'.repeat(64),
    acknowledgedBy: 'owner', acknowledgedAt: '2026-10-01T00:00:00.000Z' }, payoutRiskAcknowledgementCurrent: true };

const manifest = { schemaVersion: 1, status: 'available', officialReady: false, venueId, currency: 'RUB',
  period: { from: period.from, to: period.to }, watermark: digest({ fixture: 'verified-no-refund-sale' }), reasons: [],
  sales: [{ eventId: saleEventId, venueId, orderId, snapshotId, currency: 'RUB', recognizedLocalDate: '2026-10-11',
    sourceClosedAt: '2026-10-11T10:00:00.000000Z', coverageStatus: 'complete', lines: [{ saleEventId, orderId, venueId, netMinor: 10000 }] }],
  closedOrderSales: [{ eventId: saleEventId, venueId, orderId, snapshotId, currency: 'RUB', recognizedLocalDate: '2026-10-11',
    sourceClosedAt: '2026-10-11T10:00:00.000000Z', coverageStatus: 'complete', lines: [{ saleEventId, orderId, venueId, netMinor: 10000 }] }],
  saleEvents: [], saleLines: [{ saleLineEventId: saleLineId, saleEventId, venueId, orderId, snapshotId, orderItemId,
    sellerId: employeeId, eligibilityStatus: 'same_venue', eligibilityVenueId: venueId, employeeVenueId: venueId,
    recognizedLocalDate: '2026-10-11', grossMinor: 10000, discountMinor: 0, netMinor: 10000,
    productFacts: { productId: orderItemId } }], refundEvents: [], refundHistory: [], refundOriginalSaleAttributions: [],
  relatedRefundCoverage: { schemaVersion: 1, status: 'complete',
    scope: 'all_recorded_refunds_for_payroll_related_orders_as_of_repeatable_read_snapshot', sourceWatermark: null,
    periodSaleOrderIds: [orderId], coveredOrderIds: [orderId], relatedRefundHeaderIds: [], relatedRefundEventIds: [],
    relatedRefundItemIds: [], relatedRefundLineEventIds: [] } };
manifest.relatedRefundCoverage.sourceWatermark = manifest.watermark;
const projection = buildPayrollRecognitionPreview(manifest, policies);
assert.equal(projection.sourceStatus, 'available');
const fullNet = buildPayrollFullEmployeeNetRevenueSource(manifest, policies);
assert.equal(fullNet.status, 'available');
const eligibilityFacts = [{ employeeId, effectiveFrom: period.from, effectiveTo: null }];
const eligibilityPeriods = [{ ...eligibilityFacts[0], employeeName: 'QA employee' }];
const revision = { id: '44444444-4444-4444-8444-444444444444', revisionNo: 1, reason: 'Owner confirmed eligible roster',
  idempotency_key: 'verified-calculation-contract', payload_sha256: eligibilityPayloadSha256(eligibilityFacts, 'Owner confirmed eligible roster'),
  periodCount: 1, created_by: '55555555-5555-4555-8555-555555555555', created_by_name: 'Owner QA', created_at: '2026-10-01 00:00:00+00' };
revision.sourceWatermark = eligibilitySourceWatermark(venueId, revision, eligibilityPeriods);
const readinessComponents = {
  sourcePolicies: { status: 'available', reasons: [] },
  employeeEligibility: { status: 'available', reasons: [], sourceWatermark: revision.sourceWatermark,
    watermarkScope: 'owner_attested_payroll_employment_eligibility_revision', revisionId: revision.id, revisionNo: 1, periodCount: 1 },
  approvedAttendance: { status: 'available', reasons: [], sourceWatermark: 'a'.repeat(64), watermarkScope: 'owner_approved_attendance_snapshot' },
  canonicalLinePricing: { status: 'available', reasons: [], sourceWatermark: 'b'.repeat(64), watermarkScope: 'canonical_line_pricing' },
  payrollSaleCredit: { status: 'available', reasons: [], sourceWatermark: 'c'.repeat(64), watermarkScope: 'payroll_sale_credit' },
  recognitionManifest: { status: 'available', reasons: [], sourceWatermark: manifest.watermark, watermarkScope: 'payroll_recognition_manifest' },
  recognizedLineRefunds: { status: 'available', reasons: [], sourceWatermark: projection.projectionWatermark,
    watermarkScope: 'immutable_recognized_sale_and_refund_candidate_projection' },
  fullEmployeeNetRevenue: { status: fullNet.status, reasons: fullNet.reasons, sourceWatermark: fullNet.sourceWatermark,
    watermarkScope: fullNet.watermarkScope },
  employeeRoleCoverage: { status: 'available', reasons: [], sourceWatermark: 'd'.repeat(64), watermarkScope: 'owner_attested_employee_role_coverage' }
};
for (const fact of ['employeeEligibility', 'approvedAttendance', 'canonicalLinePricing', 'payrollSaleCredit', 'recognitionManifest',
  'recognizedLineRefunds', 'fullEmployeeNetRevenue', 'employeeRoleCoverage']) {
  readinessComponents[fact] = { ...readinessComponents[fact], venueId, currency: 'RUB', period: { from: period.from, to: period.to } };
}
const readiness = { schemaVersion: 1, versionId: scheme.versionId, period, components: readinessComponents };
const reconciliation = buildPayrollOrderRevenueReconciliation({ venueId, currency: 'RUB', period,
  venueTimezone: period.timezone, orders: [{ orderId, closedAt: '2026-10-11T10:00:00.000000Z',
    canonicalPricing: { valid: true, subtotalMinor: '10000', discountMinor: '0', minimumAdjustmentMinor: '0', finalTotalMinor: '10000' } }],
  recognitionManifest: manifest });
const personalRevenue = buildPayrollPersonalRevenueSource({ venueId, currency: 'RUB', period,
  recognitionManifest: manifest, sourcePolicies: policies, fullEmployeeNetRevenue: fullNet,
  orderRevenueReconciliation: reconciliation });
assert.equal(personalRevenue.status, 'available');
const calculatorSales = buildPayrollCalculatorSales({ currency: 'RUB', recognitionManifest: manifest, recognitionProjection: projection });
const calculatorInput = { periodFrom: period.from, periodTo: period.to, employmentEligibilityRevisionId: revision.id,
  employees: buildEligibleEmployees(eligibilityFacts, period.from, period.to), roleAssignments: [roleAssignment], attendance: [], sales: calculatorSales,
  coverage: { kind: 'month_to_date_complete', from: '2026-10-01', through: period.to, complete: true, watermark: 'e'.repeat(64) },
  attendanceCoverage: { kind: 'approved_attendance_complete', from: '2026-10-01', through: period.to, complete: true,
    watermark: readinessComponents.approvedAttendance.sourceWatermark }, personalRevenueSource: personalRevenue };
const components = Object.fromEntries(Object.entries(readinessComponents).filter(([key]) => key !== 'sourcePolicies')
  .map(([key, value]) => [key, structuredClone(value)]));
const sourceBundle = { schemaVersion: 1, venueId, schemeVersionId: scheme.versionId, currency: 'RUB',
  period: { from: period.from, to: period.to }, readinessWatermark: digest(readiness.components), components,
  recognitionManifest: manifest,
  recognizedLineProjection: { schemaVersion: 1, venueId, currency: 'RUB', period: { from: period.from, to: period.to },
    sourceWatermark: manifest.watermark, projectionWatermark: projection.projectionWatermark, sourceStatus: projection.sourceStatus,
    sourceReasons: projection.sourceReasons, saleLines: projection.saleLines, refundAdjustments: projection.refundAdjustments },
  fullEmployeeNetRevenue: fullNet, orderRevenueReconciliation: reconciliation,
  employmentEligibility: { revision, periods: eligibilityPeriods },
  venueDailyTurnover: { from: '2026-10-01', through: period.to, venueTimezone: period.timezone,
    amountBasis: 'finance_recognized_closed_order_total_pre_refund', refundsIncluded: false,
    sourceWatermark: 'f'.repeat(64), venueDailyTurnover: Array.from({ length: 31 }, (_, index) => ({
      date: `2026-10-${String(index + 1).padStart(2, '0')}`, turnoverCents: 0 })) },
  calculatorInput: { ...calculatorInput } };
sourceBundle.components.venueDailyTurnover = { status: 'available', reasons: [], sourceWatermark: 'f'.repeat(64),
  watermarkScope: 'owner_closed_order_turnover_pre_refund', venueId, currency: 'RUB', period: { from: period.from, to: period.to } };
sourceBundle.calculatorInput.venueDailyTurnover = sourceBundle.venueDailyTurnover.venueDailyTurnover;
sourceBundle.calculatorInput.venueDailyTurnoverCoverage = { from: '2026-10-01', through: period.to, complete: true,
  venueId, currency: 'RUB', period: { from: period.from, to: period.to }, venueTimezone: period.timezone,
  sourceWatermark: 'f'.repeat(64), watermarkScope: 'owner_closed_order_turnover_pre_refund', refundsIncluded: false,
  amountBasis: 'finance_recognized_closed_order_total_pre_refund' };
readinessComponents.venueDailyTurnover = { ...sourceBundle.components.venueDailyTurnover };
sourceBundle.readinessWatermark = digest(readiness.components);
sourceBundle.inputWatermark = digest(sourceBundle);
const periodClosure = { schemaVersion: 1, venueId, period: { from: period.from, to: period.to },
  transactionTimestamp: '2026-11-01T02:00:00.000Z', venueLocalDate: '2026-11-01', timezone: period.timezone };

const calculated = buildPayrollVerifiedCalculation({ venueId, scheme, period, readiness, sourceBundle, periodClosure });
assert.equal(calculated.status, 'verified_calculation', calculated.reasons.join(', '));
assert.equal(calculated.officialReady, false);
assert.equal(calculated.payoutEligible, false);
assert.equal(calculated.persistence, 'none');
assert.equal(calculated.engineResult.status, 'ready', 'the wage engine ran on verified server-owned input');
assert.equal(calculated.amountCents, 1000, '10 percent is calculated by the wage engine on the recognized clean line net');
assert.equal(Object.isFrozen(calculated), true);
assert.equal(Object.isFrozen(calculated.input), true);
assert.equal(Object.isFrozen(calculated.engineResult.employees), true);
assert.equal(calculated.inputWatermark, sourceBundle.inputWatermark);
assert.equal(calculated.closureWatermark.length, 64);
assert.equal(calculated.calculationWatermark.length, 64);
assert.throws(() => { calculated.engineResult.mode = 'forged'; }, TypeError, 'returned result is immutable');

const missingRefundHistory = structuredClone(sourceBundle);
missingRefundHistory.recognitionManifest.relatedRefundCoverage.relatedRefundHeaderIds = ['66666666-6666-4666-8666-666666666666'];
missingRefundHistory.inputWatermark = digest(Object.fromEntries(Object.entries(missingRefundHistory).filter(([key]) => key !== 'inputWatermark')));
const blockedSource = buildPayrollVerifiedCalculation({ venueId, scheme, period, readiness, sourceBundle: missingRefundHistory, periodClosure });
assert.equal(blockedSource.status, 'blocked');
assert.equal(blockedSource.engineResult, null);
assert.equal(blockedSource.input, null);
assert.ok(blockedSource.reasons.includes('payroll_official_no_refund_coverage_not_proven'));

const openPeriod = buildPayrollVerifiedCalculation({ venueId, scheme, period, readiness, sourceBundle,
  periodClosure: { ...periodClosure, venueLocalDate: period.to } });
assert.equal(openPeriod.status, 'blocked');
assert.equal(openPeriod.engineResult, null);
assert.ok(openPeriod.reasons.includes('payroll_calculation_period_not_closed'));
sourceBundle.calculatorInput.sales.push({ id: '99999999-9999-4999-8999-999999999999' });
assert.equal(calculated.input.sales.length, 1, 'returned verified input is detached from its mutable source bundle');
console.log('PASS payroll-verified-calculation-contract');
