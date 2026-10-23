import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { buildPayrollRefundReview } = require('../payroll-refund-review.js');

const venueId = '11111111-1111-4111-8111-111111111111';
const employeeId = '22222222-2222-4222-8222-222222222222';
const saleLineId = '33333333-3333-4333-8333-333333333333';
const refundItemId = '44444444-4444-4444-8444-444444444444';
const secondRefundItemId = '44444444-4444-4444-8444-444444444445';
const refundEventId = '55555555-5555-4555-8555-555555555555';
const saleEventId = '99999999-9999-4999-8999-999999999999';
const manifest = { status: 'available', venueId, currency: 'RUB', period: { from: '2026-11-01', to: '2026-11-30' },
  watermark: 'a'.repeat(64), reasons: [], saleLines: [],
  sales: [],
  refundOriginalSaleAttributions: [{ saleLineEventId: saleLineId, sellerId: employeeId, venueId, eligibilityStatus: 'same_venue',
    saleEventId,
    orderId: '66666666-6666-4666-8666-666666666666', orderItemId: '77777777-7777-4777-8777-777777777777',
    productFacts: { productId: '88888888-8888-4888-8888-888888888888', productName: 'Кальян' }, recognizedLocalDate: '2026-10-31', currency: 'RUB' }],
  refundEvents: [{ eventId: refundEventId, refundId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    originalSaleEventId: saleEventId, orderId: '66666666-6666-4666-8666-666666666666',
    recognizedLocalDate: '2026-11-03', currency: 'RUB', lines: [{ refundItemId, orderItemId: '77777777-7777-4777-8777-777777777777',
      originalSaleLineEventId: saleLineId, returnedItemValueMinor: 1275 }, { refundItemId: secondRefundItemId,
      orderItemId: '77777777-7777-4777-8777-777777777777', originalSaleLineEventId: saleLineId, returnedItemValueMinor: 250 }] }] };
const projection = { sourceStatus: 'available', sourceReasons: [], sourceWatermark: manifest.watermark, projectionWatermark: 'b'.repeat(64),
  refundAdjustments: [{ id: refundItemId, refundEventId, originalSaleEventId: saleEventId, originalSaleLineId: saleLineId, employeeId, orderId: '66666666-6666-4666-8666-666666666666',
    orderItemId: '77777777-7777-4777-8777-777777777777', date: '2026-11-03', currency: 'RUB', netRevenueAdjustmentCents: -1275 },
  { id: secondRefundItemId, refundEventId, originalSaleEventId: saleEventId, originalSaleLineId: saleLineId, employeeId,
    orderId: '66666666-6666-4666-8666-666666666666', orderItemId: '77777777-7777-4777-8777-777777777777',
    date: '2026-11-03', currency: 'RUB', netRevenueAdjustmentCents: -250 }] };

const review = buildPayrollRefundReview(manifest, projection);
assert.equal(review.status, 'available');
assert.equal(review.rows[0].refundDate, '2026-11-03');
assert.equal(review.rows[0].originalSaleDate, '2026-10-31', 'late recognized refund preserves prior-period sale date');
assert.equal(review.rows[0].employeeId, employeeId, 'refund follows original credited seller');
assert.equal(review.rows[0].menuItemName, 'Кальян');
assert.equal(review.totalMerchandiseNetRevenueDeltaCents, -1525, 'signed merchandise delta remains negative');
assert.equal(review.impactStatus, 'not_applied', 'review evidence is not applied to salary');
assert.deepEqual(review.employeeDays, [{ employeeId, recognizedDate: '2026-11-03', merchandiseNetRevenueDeltaCents: -1525,
  refundItemIds: [refundItemId, secondRefundItemId].sort(), refundEventIds: [refundEventId], originalSaleLineIds: [saleLineId] }],
'same-day refund items are reconciled by original employee and immutable recognition date');
assert.equal(buildPayrollRefundReview(manifest, projection).sourceWatermark, review.sourceWatermark, 'employee/day evidence replays deterministically');
assert.equal(review.payoutEligible, false);
assert.equal(review.nonPayable, true);
assert.match(review.sourceWatermark, /^[a-f0-9]{64}$/);

const incompleteFor = (candidateManifest = manifest, candidateProjection = projection) => {
  const result = buildPayrollRefundReview(candidateManifest, candidateProjection);
  assert.equal(result.status, 'incomplete');
  assert.equal(result.totalMerchandiseNetRevenueDeltaCents, null);
  assert.deepEqual(result.rows, [], 'a mismatched source never exposes partial refund rows or total');
  assert.deepEqual(result.employeeDays, [], 'a mismatched source never exposes partial employee/day totals');
  return result;
};
incompleteFor(manifest, { ...projection, sourceWatermark: 'c'.repeat(64) });
incompleteFor({ ...manifest, refundEvents: undefined });
incompleteFor(manifest, { ...projection, refundAdjustments: [{ ...projection.refundAdjustments[0], refundEventId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }] });
incompleteFor(manifest, { ...projection, refundAdjustments: [{ ...projection.refundAdjustments[0], date: '2026-11-04' }] });
incompleteFor(manifest, { ...projection, refundAdjustments: [{ ...projection.refundAdjustments[0], netRevenueAdjustmentCents: -1274 }] });
incompleteFor(manifest, { ...projection, refundAdjustments: [...projection.refundAdjustments, projection.refundAdjustments[0]] });
incompleteFor(manifest, { ...projection, refundAdjustments: [] });
incompleteFor({ ...manifest, refundEvents: [{ ...manifest.refundEvents[0], lines: [
  ...manifest.refundEvents[0].lines, { ...manifest.refundEvents[0].lines[0], refundItemId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }
] }] });
incompleteFor({ ...manifest, refundOriginalSaleAttributions: [{ ...manifest.refundOriginalSaleAttributions[0],
  saleEventId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }] });
const parentSaleLine = { saleLineEventId: saleLineId, orderItemId: '77777777-7777-4777-8777-777777777777',
  sellerId: employeeId, venueId };
const currentSaleLineId = '33333333-3333-4333-8333-333333333334';
const currentSaleEventId = '99999999-9999-4999-8999-999999999998';
const currentSaleLine = { saleLineEventId: currentSaleLineId, saleEventId: currentSaleEventId, sellerId: employeeId,
  venueId, eligibilityStatus: 'same_venue', orderId: '66666666-6666-4666-8666-666666666667',
  orderItemId: '77777777-7777-4777-8777-777777777778', recognizedLocalDate: '2026-11-02', currency: 'RUB' };
const withCurrentSale = { ...manifest, saleLines: [currentSaleLine], sales: [{ eventId: currentSaleEventId,
  venueId, orderId: currentSaleLine.orderId, currency: 'RUB', recognizedLocalDate: currentSaleLine.recognizedLocalDate,
  lines: [{ saleLineEventId: currentSaleLineId, orderItemId: currentSaleLine.orderItemId, sellerId: employeeId, venueId }] }] };
assert.equal(buildPayrollRefundReview(withCurrentSale, projection).status, 'available',
  'an in-period sale line is accepted when its parent event and immutable child line match');
incompleteFor({ ...withCurrentSale, sales: [] });
incompleteFor({ ...withCurrentSale, sales: [{ ...withCurrentSale.sales[0], lines: [] }] });
for (const inPeriodDate of [manifest.period.from, manifest.period.to]) {
  incompleteFor({ ...manifest, refundOriginalSaleAttributions: [{ ...manifest.refundOriginalSaleAttributions[0],
    recognizedLocalDate: inPeriodDate }] });
}
incompleteFor({ ...manifest, sales: [{ eventId: saleEventId, venueId, orderId: '66666666-6666-4666-8666-666666666666',
  currency: 'RUB', recognizedLocalDate: '2026-10-31', lines: [] }] });
incompleteFor({ ...manifest, sales: [{ eventId: saleEventId, venueId, orderId: '66666666-6666-4666-8666-666666666666',
  currency: 'RUB', recognizedLocalDate: '2026-10-30', lines: [parentSaleLine] }] });

const incomplete = buildPayrollRefundReview({ ...manifest, status: 'incomplete', reasons: ['period_precedes_recognition_epoch'] }, projection);
assert.equal(incomplete.status, 'incomplete');
assert.equal(incomplete.totalMerchandiseNetRevenueDeltaCents, null);
assert.deepEqual(incomplete.rows, [], 'partial source coverage never exposes a partial total');
assert.deepEqual(incomplete.employeeDays, [], 'partial source coverage never exposes employee/day totals');

const badLineage = buildPayrollRefundReview(manifest, { ...projection, refundAdjustments: [
  { ...projection.refundAdjustments[0], originalSaleLineId: '66666666-6666-4666-8666-666666666666' }
] });
assert.equal(badLineage.status, 'incomplete');
assert.equal(badLineage.totalMerchandiseNetRevenueDeltaCents, null);
assert.deepEqual(badLineage.rows, [], 'unknown sale-line identity blocks refund review output');
assert.deepEqual(badLineage.employeeDays, []);
console.log('PASS payroll-refund-review-contract');
