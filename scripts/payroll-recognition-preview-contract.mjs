import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { buildPayrollRecognitionPreview } = require('../payroll-recognition-preview');

const ids = {
  venue: '11111111-1111-4111-8111-111111111111', employee: '22222222-2222-4222-8222-222222222222',
  order: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', snapshot: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  sale: '33333333-3333-4333-8333-333333333333', saleLine: '44444444-4444-4444-8444-444444444444',
  item: '55555555-5555-4555-8555-555555555555', refund: '66666666-6666-4666-8666-666666666666',
  refundLine: '77777777-7777-4777-8777-777777777777'
};
const policies = { schemaVersion: 1, selectionReason: 'Owner selected immutable sale and event-date refund facts.',
  saleCredit: { kind: 'line_seller_snapshot' }, discountAllocation: { kind: 'immutable_line_snapshot' },
  refunds: { recognition: 'recognized_event_date', closedRunTreatment: 'next_open_run_adjustment',
    paidAdjustment: 'owner_review_variable_pay_only', uncoveredBalance: 'carry_forward_review', clawback: 'no_automatic_clawback' } };
const manifest = () => ({ schemaVersion: 1, status: 'available', officialReady: false, venueId: ids.venue, currency: 'RUB',
  period: { from: '2026-10-01', to: '2026-10-31', timezone: 'Europe/Moscow' }, watermark: 'a'.repeat(64), reasons: [],
  sales: [{ eventId: ids.sale, venueId: ids.venue, orderId: ids.order, snapshotId: ids.snapshot, currency: 'RUB', recognizedLocalDate: '2026-10-11' }],
  saleLines: [{ saleLineEventId: ids.saleLine, saleEventId: ids.sale, venueId: ids.venue, orderId: ids.order, snapshotId: ids.snapshot, orderItemId: ids.item, sellerId: ids.employee,
    eligibilityStatus: 'same_venue', eligibilityVenueId: ids.venue, employeeVenueId: ids.venue,
    recognizedLocalDate: '2026-10-11', grossMinor: 15000, discountMinor: 2500, netMinor: 12500 }],
  refundHistory: [{ originalSaleLineEventId: ids.saleLine, orderId: ids.order, orderItemId: ids.item,
    cumulativeReturnedQuantity: '0.250', cumulativeReturnedItemValueMinor: 2500 }],
  refundOriginalSaleAttributions: [],
  refundEvents: [{ eventId: ids.refund, orderId: ids.order, originalSaleEventId: ids.sale,
    currency: 'RUB', recognizedLocalDate: '2026-10-20', lines: [
    { refundItemId: ids.refundLine, originalSaleLineEventId: ids.saleLine, orderItemId: ids.item, returnedItemValueMinor: 2500 }
  ] }] });

const result = buildPayrollRecognitionPreview(manifest(), policies);
assert.equal(result.status, 'incomplete');
assert.equal(result.officialReady, false);
assert.equal(result.calculationReady, false);
assert.equal(result.saleLines.length, 1);
assert.equal(result.saleLines[0].commissionBaseCents, 12500);
assert.equal(result.saleLines[0].netRevenueCents, 12500);
assert.equal(result.refundAdjustments.length, 1);
assert.equal(result.refundAdjustments[0].employeeId, ids.employee);
assert.equal(result.refundAdjustments[0].date, '2026-10-20');
assert.equal(result.refundAdjustments[0].netRevenueAdjustmentCents, -2500);
assert.equal(result.refundAdjustments[0].automaticClawback, false);
assert.equal(result.saleNetRevenueCents, 12500);
assert.equal(result.refundNetRevenueAdjustmentCents, -2500);
assert.ok(result.reasons.includes('payroll_calculator_signed_refund_input_missing'));
assert.ok(result.reasons.includes('payroll_calculator_department_employee_attendance_sources_missing'));
assert.match(result.projectionWatermark, /^[a-f0-9]{64}$/);

const malformedSaleLine = manifest();
malformedSaleLine.saleLines = [null];
const malformedSaleLineResult = buildPayrollRecognitionPreview(malformedSaleLine, policies);
assert.ok(malformedSaleLineResult.reasons.includes('payroll_recognition_sale_line_invalid'));
assert.deepEqual(malformedSaleLineResult.saleLines, []);

const unsupportedPolicy = buildPayrollRecognitionPreview(manifest(), { ...policies,
  saleCredit: { kind: 'order_responsible_snapshot' } });
assert.equal(unsupportedPolicy.status, 'unsupported');
assert.deepEqual(unsupportedPolicy.saleLines, []);

const incomplete = buildPayrollRecognitionPreview({ ...manifest(), status: 'incomplete', reasons: ['sale_source_coverage_incomplete'] }, policies);
assert.equal(incomplete.status, 'incomplete');
assert.deepEqual(incomplete.saleLines, []);
assert.ok(incomplete.reasons.includes('sale_source_coverage_incomplete'));

const badRefund = manifest();
badRefund.refundEvents[0].lines[0].originalSaleLineEventId = ids.refund;
const missingOriginal = buildPayrollRecognitionPreview(badRefund, policies);
assert.ok(missingOriginal.reasons.includes('payroll_recognition_refund_original_sale_attribution_missing'));
assert.deepEqual(missingOriginal.refundAdjustments, []);

const overRefund = manifest();
overRefund.refundEvents[0].lines[0].returnedItemValueMinor = 13000;
assert.ok(buildPayrollRecognitionPreview(overRefund, policies).reasons.includes('payroll_recognition_refund_exceeds_original_sale'));

const priorPeriodRefund = manifest();
priorPeriodRefund.sales = [];
priorPeriodRefund.saleLines = [];
priorPeriodRefund.refundHistory[0].cumulativeReturnedQuantity = '0.500';
priorPeriodRefund.refundHistory[0].cumulativeReturnedItemValueMinor = 4000;
priorPeriodRefund.refundOriginalSaleAttributions = [{ saleEventId: ids.sale, saleLineEventId: ids.saleLine,
  venueId: ids.venue, orderId: ids.order, snapshotId: ids.snapshot, orderItemId: ids.item, sellerId: ids.employee,
  eligibilityStatus: 'same_venue', eligibilityVenueId: ids.venue, employeeVenueId: ids.venue, attributionPolicyVersion: 1,
  recognizedAt: '2026-09-11T10:00:00.000Z', recognizedLocalDate: '2026-09-11', timezoneSnapshot: 'Europe/Moscow',
  currency: 'RUB', grossMinor: 15000, discountMinor: 2500, netMinor: 12500,
  cumulativeReturnedQuantity: '0.500', cumulativeReturnedItemValueMinor: 4000 }];
const priorPeriodResult = buildPayrollRecognitionPreview(priorPeriodRefund, policies);
assert.equal(priorPeriodResult.saleLines.length, 0);
assert.equal(priorPeriodResult.refundAdjustments.length, 1);
assert.equal(priorPeriodResult.refundAdjustments[0].employeeId, ids.employee);
assert.equal(priorPeriodResult.refundAdjustments[0].netRevenueAdjustmentCents, -2500,
  'monthly adjustment is the event delta, not full-history cumulative returned value');
assert.ok(!priorPeriodResult.reasons.includes('payroll_recognition_refund_original_sale_attribution_missing'));

const futureHistoryCapTooLow = structuredClone(priorPeriodRefund);
futureHistoryCapTooLow.refundOriginalSaleAttributions[0].cumulativeReturnedItemValueMinor = 2000;
futureHistoryCapTooLow.refundHistory[0].cumulativeReturnedItemValueMinor = 2000;
const capMismatch = buildPayrollRecognitionPreview(futureHistoryCapTooLow, policies);
assert.ok(capMismatch.reasons.includes('payroll_recognition_refund_exceeds_original_sale'));
assert.equal(capMismatch.refundAdjustments.length, 0, 'invalid line suppresses all adjustments for that original line');

const changedPolicyWatermark = buildPayrollRecognitionPreview(manifest(), { ...policies, selectionReason: 'Owner confirmed the same immutable source again.' });
assert.notEqual(changedPolicyWatermark.projectionWatermark, result.projectionWatermark);

const crossTenantLine = manifest();
crossTenantLine.saleLines[0].employeeVenueId = '88888888-8888-4888-8888-888888888888';
assert.ok(buildPayrollRecognitionPreview(crossTenantLine, policies).reasons.includes('payroll_recognition_sale_line_invalid'));
const crossTenantParent = manifest();
crossTenantParent.sales[0].venueId = '88888888-8888-4888-8888-888888888888';
assert.ok(buildPayrollRecognitionPreview(crossTenantParent, policies).reasons.includes('payroll_recognition_sale_line_invalid'));
const orphanSaleLine = manifest();
orphanSaleLine.sales = [];
assert.ok(buildPayrollRecognitionPreview(orphanSaleLine, policies).reasons.includes('payroll_recognition_sale_line_invalid'));
console.log('PASS payroll-recognition-preview-contract.mjs');
