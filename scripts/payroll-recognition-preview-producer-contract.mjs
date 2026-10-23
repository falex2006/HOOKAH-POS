import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { buildPayrollRecognitionManifest } = require('../payroll-recognition-manifest');
const { buildPayrollRecognitionPreview } = require('../payroll-recognition-preview');

const id = n => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;
const venueId = id(1), sellerId = id(2), orderId = id(3), snapshotId = id(4), itemId = id(5), pricingLineId = id(6);
const saleEventId = id(7), saleLineEventId = id(8);
const firstRefundId = id(9), firstRefundEventId = id(10), firstRefundItemId = id(11), firstRefundLineEventId = id(12);
const laterRefundId = id(13), laterRefundEventId = id(14), laterRefundItemId = id(15), laterRefundLineEventId = id(16);
const saleAt = '2026-10-10T10:00:00.000000Z', soldAt = '2026-10-10T09:00:00.000000Z';
const refundAt = '2026-11-05T10:00:00.000000Z', laterRefundAt = '2026-12-05T10:00:00.000000Z';
const timezone = 'Asia/Yekaterinburg';
const epoch = { venue_id: venueId, policy_version: 1, activation_scope: 'new_venue',
  activated_at: '2026-10-01T00:00:00.000001Z', timezone_snapshot: timezone, activated_local_date: '2026-10-01' };
const saleEvent = { id: saleEventId, venue_id: venueId, order_id: orderId, snapshot_id: snapshotId,
  policy_version: 1, recognized_at: saleAt, timezone_snapshot: timezone, recognized_local_date: '2026-10-10',
  source_closed_at: saleAt, currency_code: 'RUB', coverage_status: 'complete', coverage_reasons: [] };
const saleLine = { id: saleLineEventId, venue_id: venueId, sale_event_id: saleEventId, snapshot_id: snapshotId,
  order_id: orderId, order_item_id: itemId, pricing_line_id: pricingLineId, seller_id: sellerId,
  sold_at: soldAt, attribution_captured_at: saleAt, attribution_policy_version: 1, eligibility_status: 'same_venue',
  eligibility_venue_id: venueId, employee_venue_id: venueId };
const pricingLine = { id: pricingLineId, venue_id: venueId, order_id: orderId, snapshot_id: snapshotId,
  order_item_id: itemId, quantity: '1.000', unit_price: '100.00', gross_minor: '10000', discount_minor: '0',
  net_minor: '10000', eligible: false, seller_id: sellerId, sold_at: soldAt,
  seller_in_venue: true, seller_in_organization: true, product_facts: {} };
const refundEvent = (id, refundId, recognizedAt, recognizedDate, payout) => ({ id, venue_id: venueId, refund_id: refundId,
  order_id: orderId, original_sale_event_id: saleEventId, policy_version: 1, recognized_at: recognizedAt,
  timezone_snapshot: timezone, recognized_local_date: recognizedDate, currency_code: 'RUB',
  item_attribution_status: 'complete', payout_minor: String(payout), tender_total_minor: String(payout),
  coverage_status: 'complete', coverage_reasons: [] });
const refundHeader = (id, refundId, recognizedAt, recognizedDate, payout) => ({ id: refundId, venue_id: venueId,
  order_id: orderId, item_attribution_status: 'complete', recognition_policy_version: 1,
  payroll_recognized_at: recognizedAt, payroll_timezone_snapshot: timezone,
  payroll_recognized_local_date: recognizedDate, payout_minor: String(payout) });
const refundItem = (id, refundId, quantity, value, sequence, previousQuantity, previousValue, cumulativeQuantity, cumulativeValue) => ({
  id, venue_id: venueId, refund_id: refundId, order_id: orderId, snapshot_id: snapshotId, order_item_id: itemId,
  returned_quantity: quantity, returned_item_value_minor: String(value), producer_sequence: String(sequence),
  previous_returned_quantity: previousQuantity, cumulative_returned_quantity: cumulativeQuantity,
  previous_returned_item_value_minor: String(previousValue), cumulative_returned_item_value_minor: String(cumulativeValue)
});
const refundLine = (id, refundEventId, refundItemId, quantity, value, sequence, previousQuantity, previousValue,
  cumulativeQuantity, cumulativeValue) => ({ id, venue_id: venueId, refund_event_id: refundEventId,
  refund_item_id: refundItemId, order_id: orderId, snapshot_id: snapshotId, order_item_id: itemId,
  original_sale_line_event_id: saleLineEventId, producer_sequence: String(sequence),
  previous_returned_quantity: previousQuantity, returned_quantity: quantity, cumulative_returned_quantity: cumulativeQuantity,
  previous_returned_item_value_minor: String(previousValue), returned_item_value_minor: String(value),
  cumulative_returned_item_value_minor: String(cumulativeValue) });

const facts = { epoch, saleEvents: [saleEvent], saleLines: [saleLine], orders: [{ id: orderId, venue_id: venueId,
    status: 'closed', closed_at: saleAt, pricing_locked_at: soldAt }],
  pricingHeaders: [{ id: snapshotId, venue_id: venueId, order_id: orderId, schema_version: 1, policy_version: 1,
    currency_code: 'RUB', currency_scale: 2, transaction_at: soldAt, subtotal_minor: '10000', discount_minor: '0',
    minimum_adjustment_minor: '0', final_total_minor: '10000', discount_source: 'none', eligible_item_ids: [],
    winner_terms: null, frozen_terms: { allocationPolicy: 'largest-remainder-item-id-v1' } }],
  pricingLines: [pricingLine], orderItems: [{ id: itemId, order_id: orderId }], candidateOrders: [],
  refundEvents: [refundEvent(firstRefundEventId, firstRefundId, refundAt, '2026-11-05', 9000),
    refundEvent(laterRefundEventId, laterRefundId, laterRefundAt, '2026-12-05', 3000)],
  refundLines: [refundLine(firstRefundLineEventId, firstRefundEventId, firstRefundItemId, '0.250', 2500, 1, '0.000', 0, '0.250', 2500),
    refundLine(laterRefundLineEventId, laterRefundEventId, laterRefundItemId, '0.150', 1500, 2, '0.250', 2500, '0.400', 4000)],
  refundHeaders: [refundHeader(firstRefundEventId, firstRefundId, refundAt, '2026-11-05', 9000),
    refundHeader(laterRefundEventId, laterRefundId, laterRefundAt, '2026-12-05', 3000)],
  relatedRefundHeaders: [{ id: firstRefundId, venue_id: venueId, order_id: orderId, created_at: refundAt },
    { id: laterRefundId, venue_id: venueId, order_id: orderId, created_at: laterRefundAt }],
  relatedRefundItems: [{ id: firstRefundItemId, venue_id: venueId, refund_id: firstRefundId, order_id: orderId },
    { id: laterRefundItemId, venue_id: venueId, refund_id: laterRefundId, order_id: orderId }],
  refundItems: [refundItem(firstRefundItemId, firstRefundId, '0.250', 2500, 1, '0.000', 0, '0.250', 2500),
    refundItem(laterRefundItemId, laterRefundId, '0.150', 1500, 2, '0.250', 2500, '0.400', 4000)],
  refundTenders: [{ refund_id: firstRefundId, tender_total_minor: '9000' }, { refund_id: laterRefundId, tender_total_minor: '3000' }],
  candidateRefunds: [] };

const manifest = buildPayrollRecognitionManifest(facts, { venueId, currency: 'RUB', from: '2026-11-01', to: '2026-11-30' });
assert.equal(manifest.status, 'available', JSON.stringify(manifest.reasons));
assert.equal(manifest.sales.length, 0);
assert.equal(manifest.saleLines.length, 0);
assert.equal(manifest.refundEvents.length, 1);
assert.equal(manifest.refundEvents[0].lines[0].returnedItemValueMinor, 2500);
assert.equal(manifest.refundOriginalSaleAttributions.length, 1);
assert.equal(manifest.refundOriginalSaleAttributions[0].netMinor, 10000);
assert.equal(manifest.refundOriginalSaleAttributions[0].cumulativeReturnedItemValueMinor, 4000,
  'the original-line cap is full history and can exceed this period delta');

const sourcePolicies = { schemaVersion: 1, selectionReason: 'Owner selected immutable sale and event-date refund facts.',
  saleCredit: { kind: 'line_seller_snapshot' }, discountAllocation: { kind: 'immutable_line_snapshot' },
  refunds: { recognition: 'recognized_event_date', closedRunTreatment: 'next_open_run_adjustment',
    paidAdjustment: 'owner_review_variable_pay_only', uncoveredBalance: 'carry_forward_review', clawback: 'no_automatic_clawback' } };
const preview = buildPayrollRecognitionPreview(manifest, sourcePolicies);
assert.equal(preview.saleLines.length, 0, 'prior-period sale must not become current-period sale credit');
assert.equal(preview.refundAdjustments.length, 1);
assert.equal(preview.refundAdjustments[0].employeeId, sellerId);
assert.equal(preview.refundAdjustments[0].date, '2026-11-05');
assert.equal(preview.refundAdjustments[0].netRevenueAdjustmentCents, -2500,
  'monthly adjustment comes from the November event delta, never the full-history cumulative value');
assert.equal(preview.officialReady, false);
assert.equal(preview.calculationReady, false);
console.log('PASS payroll-recognition-preview-producer-contract.mjs');
