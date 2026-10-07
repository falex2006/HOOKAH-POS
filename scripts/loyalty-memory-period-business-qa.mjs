import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildMemoryPeriodBusiness, summarizeMemoryReservationPrepayments } = require('../loyalty-memory-reconciliation');
const venueId = 'venue-a';
const timeZone = 'Asia/Yekaterinburg';
const base = { venueId, timeZone, from: '2026-10-01', to: '2026-10-01' };
const pricedOrder = {
  id: 'order-a', venueId, status: 'closed', closedAt: '2026-09-30T20:00:00.000Z', pricingVersion: 1,
  subtotalSnapshot: 200, discountTotalSnapshot: 20, minimumAdjustmentSnapshot: 0, finalTotalSnapshot: 180,
  effectiveDiscountSource: 'promotion', groupDiscountAmount: 0,
  selectedPromotionSnapshot: { name: 'QA акция', amount: 20 },
  items: [{ unitPrice: 100, quantity: 2 }],
  payments: [{ method: 'card', amount: 180, status: 'paid', createdAt: '2026-09-30T20:00:00.000Z' }]
};
const guest = { id: 'guest-a', venueId, depositTopUps: [{ method: 'cash', amount: 50, createdAt: '2026-09-30T20:30:00.000Z' }] };
const reservation = { id: 'booking-a', venueId, prepaymentReceipts: [{ id: 'receipt-a', method: 'qr', amount: 40, createdAt: '2026-09-30T20:45:00.000Z' }] };
const report = buildMemoryPeriodBusiness({ ...base, orders: [pricedOrder], guests: [guest], reservations: [reservation] });
assert.deepEqual(report.sales, {
  orders: 1, unsnapshottedOrders: 0, gross: 200, discounts: 20, minimumAdjustment: 0, net: 180,
  discountsBySource: { promotion: 20 }, discountsByGroup: {}, discountsByPromotion: { 'QA акция': 20 }
});
assert.deepEqual(report.receipts.byMethod, { cash: 50, qr: 40, card: 180 });
assert.deepEqual(report.receipts.bySource, { guest_account_top_up: 50, reservation_prepayment: 40, order_payment: 180 });
assert.equal(report.payouts.byMethod, null, 'memory mode does not claim an empty payout ledger');
assert.equal(report.coverage.complete, false);

const emptyReport = buildMemoryPeriodBusiness(base);
assert.equal(emptyReport.sales.orders, 0);
assert.equal(emptyReport.sales.gross, 0, 'supported empty sales are a verified zero');
assert.deepEqual(emptyReport.receipts.byMethod, {}, 'supported empty receipts are a verified empty result');

const legacyOrder = { id: 'legacy-order', venueId, status: 'closed', closedAt: '2026-09-30T20:00:00.000Z', items: [{ unitPrice: 100, quantity: 1 }], payments: [] };
const incomplete = buildMemoryPeriodBusiness({ ...base, orders: [legacyOrder] });
assert.equal(incomplete.sales.gross, 100, 'gross can be reconstructed from saved lines');
assert.equal(incomplete.sales.discounts, null, 'missing legacy price data is unknown rather than zero');
assert.equal(incomplete.sales.minimumAdjustment, null);
assert.equal(incomplete.sales.net, 0, 'the report does not invent paid revenue without a payment');
assert.equal(incomplete.sales.unsnapshottedOrders, 1);
assert.equal(incomplete.sales.discountsBySource, null);
const ordinaryOrder = { ...pricedOrder, selectedPromotionSnapshot: null, effectiveDiscountSource: 'none', discountTotalSnapshot: 0 };
const ordinary = buildMemoryPeriodBusiness({ ...base, orders: [ordinaryOrder] });
assert.deepEqual(ordinary.sales.discountsByPromotion, {}, 'a saved null promotion snapshot means no promotion, not unknown data');
const promotionWithoutAmount = buildMemoryPeriodBusiness({ ...base, orders: [{ ...pricedOrder, selectedPromotionSnapshot: { name: 'Без суммы' } }] });
assert.equal(promotionWithoutAmount.sales.discountsByPromotion, null, 'missing promotion amount is not reported as a known zero');
const withoutClosureDate = buildMemoryPeriodBusiness({ ...base, orders: [{ ...pricedOrder, id: 'missing-closure', closedAt: null, createdAt: '2026-09-30T20:00:00.000Z' }] });
assert.equal(withoutClosureDate.sales.orders, 0, 'a missing closure timestamp is never replaced by the creation date');
assert.ok(withoutClosureDate.coverage.unavailable.some((entry) => entry.includes('no valid closure date')));

const liability = summarizeMemoryReservationPrepayments([{
  id: 'booking-a', venueId, verifiedDepositPaid: 90,
  prepaymentReceipts: [{ id: 'receipt-a', amount: 100 }],
  prepaymentAllocations: [{ id: 'allocation-a', receiptId: 'receipt-a', amount: 70 }],
  prepaymentRefunds: [{ receiptId: 'receipt-a', amount: 10 }, { receiptId: 'orphan-receipt', amount: 999 }]
}, { id: 'other-booking', venueId: 'venue-b', verifiedDepositPaid: 999, prepaymentReceipts: [{ id: 'receipt-b', amount: 999 }] }], venueId);
assert.deepEqual(liability, { unapplied: 20, verifiedCounterMismatchCount: 0, verifiedCounterMismatchAmount: 0 });
console.log('LOYALTY MEMORY PERIOD BUSINESS QA: PASS (period/tz, snapshot values, true zero vs unknown, tender source/method, tenant scope, refund-adjusted prepayment)');
