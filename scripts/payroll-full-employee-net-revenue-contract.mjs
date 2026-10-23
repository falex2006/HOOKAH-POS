import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { buildPayrollRecognitionPreview } = require('../payroll-recognition-preview.js');
const { buildPayrollFullEmployeeNetRevenueSource } = require('../payroll-full-employee-net-revenue-source.js');

const venueId = '11111111-1111-4111-8111-111111111111';
const employeeId = '22222222-2222-4222-8222-222222222222';
const saleEventId = '44444444-4444-4444-8444-444444444444';
const saleLineId = '55555555-5555-4555-8555-555555555555';
const itemId = '66666666-6666-4666-8666-666666666666';
const refundEventId = '77777777-7777-4777-8777-777777777777';
const refundLineId = '88888888-8888-4888-8888-888888888888';
const policies = { schemaVersion: 1, selectionReason: 'Owner accepted immutable source facts.',
  saleCredit: { kind: 'line_seller_snapshot' }, discountAllocation: { kind: 'immutable_line_snapshot' },
  refunds: { recognition: 'recognized_event_date', closedRunTreatment: 'next_open_run_adjustment',
    paidAdjustment: 'owner_review_variable_pay_only', uncoveredBalance: 'carry_forward_review', clawback: 'no_automatic_clawback' } };
const base = { schemaVersion: 1, status: 'available', officialReady: false, venueId, currency: 'RUB',
  period: { from: '2026-10-01', to: '2026-10-31' }, watermark: 'a'.repeat(64), reasons: [],
  sales: [{ eventId: saleEventId, venueId, orderId: '99999999-9999-4999-8999-999999999999',
    snapshotId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', currency: 'RUB', recognizedLocalDate: '2026-10-05' }],
  saleLines: [{ saleLineEventId: saleLineId, saleEventId, venueId, orderId: '99999999-9999-4999-8999-999999999999',
    snapshotId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', orderItemId: itemId, sellerId: employeeId,
    eligibilityStatus: 'same_venue', eligibilityVenueId: venueId, employeeVenueId: venueId,
    recognizedLocalDate: '2026-10-05', grossMinor: 10000, discountMinor: 1000, netMinor: 9000 }],
  refundHistory: [{ originalSaleLineEventId: saleLineId, orderId: '99999999-9999-4999-8999-999999999999',
    orderItemId: itemId, cumulativeReturnedQuantity: '0.500', cumulativeReturnedItemValueMinor: 4500 }],
  refundOriginalSaleAttributions: [],
  refundEvents: [{ eventId: refundEventId, orderId: '99999999-9999-4999-8999-999999999999', originalSaleEventId: saleEventId,
    currency: 'RUB', recognizedLocalDate: '2026-10-20', lines: [{ refundItemId: refundLineId,
      originalSaleLineEventId: saleLineId, orderItemId: itemId, returnedItemValueMinor: 4500 }] }] };
const projection = buildPayrollRecognitionPreview(base, policies);
assert.equal(projection.sourceStatus, 'available');
const result = buildPayrollFullEmployeeNetRevenueSource(base, policies);
assert.equal(result.status, 'available');
assert.equal(result.amount, 4500, 'discounted sale less item return is recognized merchandise net');
assert.deepEqual(result.daily.map(({ employeeId: id, date, netMinor }) => [id, date, netMinor]), [
  [employeeId, '2026-10-05', 9000], [employeeId, '2026-10-20', -4500]
]);
assert.equal(result.daily[1].sourceEvents[0].eventId, refundEventId);
assert.equal(result.daily[1].sourceEvents[0].originalSaleLineId, saleLineId);
assert.equal(result.officialReady, false);
assert.equal(result.watermarkScope, 'full_employee_net_revenue_candidate_series');

const overflowing = structuredClone(base);
overflowing.saleLines = [
  { ...overflowing.saleLines[0], grossMinor: Number.MAX_SAFE_INTEGER, discountMinor: 0, netMinor: Number.MAX_SAFE_INTEGER },
  { ...overflowing.saleLines[0], saleLineEventId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab',
    orderItemId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbc', grossMinor: 2, discountMinor: 0, netMinor: 2 }
];
overflowing.refundHistory.push({ originalSaleLineEventId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab',
  orderId: '99999999-9999-4999-8999-999999999999', orderItemId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbc',
  cumulativeReturnedQuantity: '0.000', cumulativeReturnedItemValueMinor: 0 });
assert.throws(() => buildPayrollRecognitionPreview(overflowing, policies),
  error => error?.code === 'payroll_recognition_preview_total_overflow', 'fixture reaches the upstream recognized-total overflow');
const overflowResult = buildPayrollFullEmployeeNetRevenueSource(overflowing, policies);
assert.equal(overflowResult.status, 'incomplete', 'upstream safe-integer aggregation overflow blocks the candidate source');
assert.equal(overflowResult.amount, null);
assert.deepEqual(overflowResult.daily, []);
assert.equal(overflowResult.officialReady, false);
assert.deepEqual(overflowResult.reasons, ['full_employee_net_revenue_total_overflow']);
assert.throws(() => buildPayrollFullEmployeeNetRevenueSource(base, { schemaVersion: 1 }),
  error => error?.code === 'payroll_source_policies_invalid', 'unrelated projection errors are not masked as overflow');

const empty = { ...base, sales: [], saleLines: [], refundHistory: [], refundEvents: [], watermark: 'b'.repeat(64) };
const emptyProjection = buildPayrollRecognitionPreview(empty, policies);
const emptyResult = buildPayrollFullEmployeeNetRevenueSource(empty, policies);
assert.equal(emptyResult.status, 'available', 'a complete, explicitly covered empty period is a known zero');
assert.equal(emptyResult.amount, 0);
assert.deepEqual(emptyResult.daily, []);

const incomplete = { ...empty, status: 'incomplete', reasons: ['post_epoch_sale_recognition_missing'], watermark: 'c'.repeat(64) };
const incompleteProjection = buildPayrollRecognitionPreview(incomplete, policies);
const incompleteResult = buildPayrollFullEmployeeNetRevenueSource(incomplete, policies);
assert.equal(incompleteResult.status, 'incomplete');
assert.equal(incompleteResult.amount, null, 'unproven coverage never becomes zero');
assert.deepEqual(incompleteResult.daily, [], 'partial employee totals are not exposed');
assert.ok(incompleteResult.reasons.length > 0, 'unproven coverage carries an explicit blocking reason');

const crossPeriod = { ...base, sales: [], saleLines: [], refundHistory: [{ originalSaleLineEventId: saleLineId,
  orderId: '99999999-9999-4999-8999-999999999999', orderItemId: itemId,
  cumulativeReturnedQuantity: '0.500', cumulativeReturnedItemValueMinor: 4500 }],
  refundOriginalSaleAttributions: [{ saleEventId, saleLineEventId: saleLineId, orderId: '99999999-9999-4999-8999-999999999999',
    snapshotId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', orderItemId: itemId, sellerId: employeeId, venueId,
    eligibilityStatus: 'same_venue', eligibilityVenueId: venueId, employeeVenueId: venueId, attributionPolicyVersion: 1,
    recognizedLocalDate: '2026-09-30', currency: 'RUB', grossMinor: 10000, discountMinor: 1000, netMinor: 9000,
    cumulativeReturnedQuantity: '0.500', cumulativeReturnedItemValueMinor: 4500 }] };
const crossPeriodResult = buildPayrollFullEmployeeNetRevenueSource(crossPeriod, policies);
assert.equal(crossPeriodResult.status, 'available');
assert.deepEqual(crossPeriodResult.daily.map(({ employeeId: id, date, netMinor }) => [id, date, netMinor]), [[employeeId, '2026-10-20', -4500]],
  'a later-period refund remains negative and belongs to the original credited seller');
assert.equal(crossPeriodResult.daily[0].sourceEvents[0].originalSaleLineId, saleLineId);

const wrongRefundPolicy = { ...policies, refunds: { ...policies.refunds, recognition: 'original_sale_period_correction' } };
assert.equal(buildPayrollFullEmployeeNetRevenueSource(base, wrongRefundPolicy).status, 'unsupported');

console.log('PASS payroll-full-employee-net-revenue-contract');
