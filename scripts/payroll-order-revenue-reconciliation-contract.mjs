import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { buildPayrollOrderRevenueReconciliation } = require('../payroll-order-revenue-reconciliation.js');

const venueId = '11111111-1111-4111-8111-111111111111';
const orderId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const eventId = '33333333-3333-4333-8333-333333333333';
const lineId = '44444444-4444-4444-8444-444444444444';
const period = { from: '2026-10-01', to: '2026-10-31' };
const manifest = { venueId, currency: 'RUB', period, status: 'available', watermark: 'a'.repeat(64),
  closedOrderSales: [{ eventId, venueId, orderId, sourceClosedAt: '2026-10-02T10:00:00.000000Z', coverageStatus: 'complete',
    lines: [{ saleLineEventId: lineId, saleEventId: eventId, venueId, orderId, netMinor: 9000 }] }] };
const orders = [{ orderId, closedAt: '2026-10-02T10:00:00.000000Z', canonicalPricing: {
  snapshotId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', subtotalMinor: '10000', discountMinor: '1000',
  minimumAdjustmentMinor: '1000', finalTotalMinor: '10000', valid: true } }];

const complete = buildPayrollOrderRevenueReconciliation({ venueId, currency: 'RUB', period,
  venueTimezone: 'Asia/Yekaterinburg', orders, recognitionManifest: manifest });
assert.equal(complete.status, 'available');
assert.equal(complete.officialReady, false);
assert.equal(complete.persistence, 'none');
assert.deepEqual(complete.totals, { closedOrderTotalMinor: 10000, recognizedLineNetMinor: 9000,
  minimumPriceAdjustmentMinor: 1000, unattributedResidualMinor: 0 });
assert.equal(complete.orders.length, 1);
assert.equal(complete.sourceWatermark, 'e1c9e3cd8cf2456c59d225d59f020d66b84cb9959d6ab6052353a2063977d939',
  'unchanged in-period inputs retain their pre-filter watermark');
assert.equal(complete.sourceWatermark, buildPayrollOrderRevenueReconciliation({ venueId, currency: 'RUB', period,
  venueTimezone: 'Asia/Yekaterinburg', orders, recognitionManifest: manifest }).sourceWatermark);
assert.notEqual(complete.sourceWatermark, buildPayrollOrderRevenueReconciliation({ venueId, currency: 'RUB', period,
  venueTimezone: 'Asia/Yekaterinburg', orders: [{ ...orders[0], canonicalPricing: { ...orders[0].canonicalPricing, finalTotalMinor: '10001' } }],
  recognitionManifest: manifest }).sourceWatermark);

const missingEvent = buildPayrollOrderRevenueReconciliation({ venueId, currency: 'RUB', period,
  venueTimezone: 'Asia/Yekaterinburg', orders, recognitionManifest: { ...manifest, closedOrderSales: [] } });
assert.equal(missingEvent.status, 'incomplete');
assert.equal(missingEvent.coverage.complete, false);
assert.equal(missingEvent.closedOrderCount, 1, 'a closed order remains in the denominator when recognition is missing');
assert.equal(missingEvent.unrecognizedOrderCount, 1);
assert.equal(missingEvent.orders[0].closedOrderTotalMinor, 10000);
assert.equal(missingEvent.orders[0].recognizedLineNetMinor, null);
assert.equal(missingEvent.totals.closedOrderTotalMinor, null, 'incomplete periods hide aggregate totals');

const empty = buildPayrollOrderRevenueReconciliation({ venueId, currency: 'RUB', period,
  venueTimezone: 'Asia/Yekaterinburg', orders: [], recognitionManifest: { ...manifest, closedOrderSales: [] } });
assert.equal(empty.status, 'available');
assert.equal(empty.closedOrderCount, 0);
assert.deepEqual(empty.totals, { closedOrderTotalMinor: 0, recognizedLineNetMinor: 0,
  minimumPriceAdjustmentMinor: 0, unattributedResidualMinor: 0 });
assert.throws(() => buildPayrollOrderRevenueReconciliation({ venueId, currency: 'RUB', period,
  venueTimezone: 'Asia/Yekaterinburg', orders: [{ ...orders[0], canonicalPricing: { ...orders[0].canonicalPricing, finalTotalMinor: '9007199254740992' } }],
  recognitionManifest: manifest }), /payroll_order_reconciliation_amount_out_of_range/);

const reconcile = (sales, selectedOrders = orders, venueTimezone = 'Asia/Yekaterinburg') =>
  buildPayrollOrderRevenueReconciliation({ venueId, currency: 'RUB', period, venueTimezone,
    orders: selectedOrders, recognitionManifest: { ...manifest, closedOrderSales: sales } });
const sourceSale = manifest.closedOrderSales[0];
const padded = [
  { ...sourceSale, orderId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', sourceClosedAt: '2026-09-30T18:59:59.999999Z', recognizedLocalDate: period.from },
  sourceSale,
  { ...sourceSale, orderId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', sourceClosedAt: '2026-10-31T19:00:00.000000Z', recognizedLocalDate: period.to }
];
const before = structuredClone(padded);
const paddedResult = reconcile(padded);
assert.equal(paddedResult.status, 'available', 'before/after padded candidates cannot block a complete period');
assert.deepEqual(paddedResult.totals, complete.totals);
assert.equal(paddedResult.sourceWatermark, complete.sourceWatermark, 'only the matching source cohort is reconciled');
assert.deepEqual(padded, before, 'full manifest history is left untouched');

for (const [timezone, timestamp, included] of [
  ['Asia/Yekaterinburg', '2026-09-30T18:59:59.999999Z', false],
  ['Asia/Yekaterinburg', '2026-09-30T19:00:00.000000Z', true],
  ['Asia/Yekaterinburg', '2026-10-31T18:59:59.999999Z', true],
  ['Asia/Yekaterinburg', '2026-10-31T19:00:00.000000Z', false],
  ['America/New_York', '2026-10-01T03:59:59.999999Z', false],
  ['America/New_York', '2026-10-01T04:00:00.000000Z', true],
  ['America/New_York', '2026-11-01T03:59:59.999999Z', true],
  ['America/New_York', '2026-11-01T04:00:00.000000Z', false],
  ['Asia/Kathmandu', '2026-09-30T18:14:59.999999Z', false],
  ['Asia/Kathmandu', '2026-09-30T18:15:00.000000Z', true]
]) {
  const sale = { ...sourceSale, sourceClosedAt: timestamp,
    recognizedLocalDate: included ? '2026-09-01' : '2026-10-15' };
  const selected = included ? [{ ...orders[0], closedAt: timestamp }] : [];
  const result = reconcile([sale], selected, timezone);
  assert.equal(result.status, 'available', `${timezone} ${timestamp}: current source close date controls inclusion`);
  assert.equal(result.recognizedOrderCount, included ? 1 : 0);
  if (included) {
    const missingDenominator = reconcile([sale], [], timezone);
    assert.equal(missingDenominator.status, 'incomplete');
    assert.ok(missingDenominator.reasons.includes('recognized_sale_event_order_outside_closed_order_source'),
      'an in-period sale cannot disappear when its closed-order denominator is missing');
  }
}
for (const sourceClosedAt of [undefined, null, '', 'invalid', '2026-02-30T10:00:00.000000Z',
  '2026-10-01T24:00:00.000000Z', '2026-10-01T00:60:00.000000Z']) {
  const result = reconcile([{ ...sourceSale, sourceClosedAt }], []);
  assert.equal(result.status, 'incomplete', `invalid timestamp ${sourceClosedAt} must not be silently excluded`);
  assert.ok(result.reasons.includes('payroll_order_reconciliation_sale_event_close_timestamp_invalid'));
  assert.equal(result.totals.closedOrderTotalMinor, null);
}
assert.equal(reconcile([null], []).status, 'incomplete', 'invalid event cannot become empty available evidence');
assert.throws(() => reconcile([], [], 'invalid/timezone'), /payroll_order_reconciliation_timezone_invalid/);
assert.equal(reconcile([sourceSale, sourceSale]).status, 'incomplete', 'in-period duplicate detection remains active');
const legacySales = buildPayrollOrderRevenueReconciliation({ venueId, currency: 'RUB', period,
  venueTimezone: 'Asia/Yekaterinburg', orders, recognitionManifest: { ...manifest, closedOrderSales: undefined, sales: padded } });
assert.equal(legacySales.sourceWatermark, complete.sourceWatermark, 'legacy sales fallback uses the same period boundary');
console.log('payroll-order-revenue-reconciliation-contract: ok');
