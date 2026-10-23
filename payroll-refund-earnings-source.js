'use strict';

// Internal full-cohort reader/adapter. No period filtering of refund history,
// no payroll status classification, no writes and no monetary authorization.
const { hasPayrollVerifiedWriteSnapshot } = require('./payroll-source-fence');
const { buildPayrollRecognitionManifest, readPayrollRecognitionEvidenceInTransaction } = require('./payroll-recognition-manifest');
const { validateCanonicalPayrollPricingOrder } = require('./payroll-canonical-pricing-source');
const { buildPayrollRefundEarningsProjection, PAYROLL_REFUND_HISTORY_SCOPE } = require('./payroll-refund-earnings-projection');
const fail = suffix => { const code = `payroll_refund_earnings_source_${suffix}`; throw Object.assign(new TypeError(code), { code }); };
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const integer = value => {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value) || value.length > 16 || !Number.isSafeInteger(Number(value))) fail('integer_invalid');
  return Number(value);
};
const exact = (actual, expected) => {
  if (new Set(actual).size !== actual.length || new Set(expected).size !== expected.length
      || canonical([...actual].sort()) !== canonical([...expected].sort())) fail('coverage_mismatch');
};
const one = rows => { if (rows.length !== 1) fail('lineage_invalid'); return rows[0]; };
const validInstant = value => {
  const match = typeof value === 'string' && value.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d{6})Z$/);
  if (!match) return false;
  const time = Date.parse(`${match[1]}.000Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 19) === match[1];
};

// Pure adapter exported for deterministic contract tests. A caller-supplied
// facts object is not DB authority: production uses the fenced reader below.
function buildPayrollRefundEarningsSource({ manifest, facts }, options) {
  if (!manifest || !facts || !options) fail('evidence_required');
  const repeated = buildPayrollRecognitionManifest(facts, options);
  if (repeated.status !== 'available' || canonical(repeated) !== canonical(manifest)
      || manifest.relatedRefundCoverage?.status !== 'complete'
      || manifest.relatedRefundCoverage.sourceWatermark !== manifest.watermark) fail('manifest_invalid');
  const { venueId, currency = 'RUB', from, to } = options, coverage = manifest.relatedRefundCoverage;
  const orderIds = coverage.coveredOrderIds;
  if (!Array.isArray(orderIds) || orderIds.length > 20000 || new Set(orderIds).size !== orderIds.length) fail('coverage_invalid');
  const cohort = new Set(orderIds), saleLines = [];
  const saleEvents = facts.saleEvents.filter(row => cohort.has(row.order_id));
  exact(saleEvents.map(row => row.order_id), orderIds);
  for (const orderId of orderIds) {
    const event = one(saleEvents.filter(row => row.order_id === orderId));
    const order = one(facts.orders.filter(row => row.id === orderId));
    const header = one(facts.pricingHeaders.filter(row => row.order_id === orderId));
    const pricing = facts.pricingLines.filter(row => row.order_id === orderId);
    const recognized = facts.saleLines.filter(row => row.sale_event_id === event.id);
    const itemIds = facts.orderItems.filter(row => row.order_id === orderId).map(row => row.id);
    if (order.status !== 'closed' || event.venue_id !== venueId || event.currency_code !== currency
        || event.policy_version !== 1 || event.coverage_status !== 'complete' || !Array.isArray(event.coverage_reasons)
        || event.coverage_reasons.length || event.snapshot_id !== header.id || event.source_closed_at !== order.closed_at) fail('sale_invalid');
    const validated = validateCanonicalPayrollPricingOrder({ order, header, lines: pricing, itemIds }, { venueId, currency });
    if (validated.unknownSellerLineCount || validated.unsupportedCrossVenueLineCount) fail('seller_invalid');
    exact(recognized.map(row => row.order_item_id), pricing.map(row => row.order_item_id));
    for (const priced of pricing) {
      const line = one(recognized.filter(row => row.order_item_id === priced.order_item_id));
      if (line.venue_id !== venueId || line.order_id !== orderId || line.snapshot_id !== header.id
          || line.pricing_line_id !== priced.id || line.seller_id !== priced.seller_id || line.sold_at !== priced.sold_at
          || line.attribution_policy_version !== 1 || line.eligibility_status !== 'same_venue'
          || line.eligibility_venue_id !== venueId || line.employee_venue_id !== venueId
          || !validInstant(line.attribution_captured_at)) fail('sale_lineage_invalid');
      saleLines.push({ saleLineEventId: line.id, saleEventId: event.id, venueId, currency, orderId,
        orderItemId: priced.order_item_id, snapshotId: header.id, pricingLineId: priced.id, sellerId: line.seller_id,
        recognizedAt: event.recognized_at, recognizedLocalDate: event.recognized_local_date,
        timezoneSnapshot: event.timezone_snapshot, soldAt: line.sold_at, quantity: priced.quantity,
        grossMinor: integer(priced.gross_minor), discountMinor: integer(priced.discount_minor), netMinor: integer(priced.net_minor),
        productFacts: structuredClone(priced.product_facts) });
    }
  }
  const rawEvents = facts.refundEvents.filter(row => cohort.has(row.order_id));
  const rawLines = facts.refundLines.filter(row => cohort.has(row.order_id));
  const rawItems = facts.refundItems.filter(row => cohort.has(row.order_id));
  const rawHeaders = facts.refundHeaders.filter(row => cohort.has(row.order_id));
  exact(rawEvents.map(row => row.id), coverage.relatedRefundEventIds);
  exact(rawHeaders.map(row => row.id), coverage.relatedRefundHeaderIds);
  exact(rawEvents.map(row => row.refund_id), coverage.relatedRefundHeaderIds);
  exact(rawLines.map(row => row.id), coverage.relatedRefundLineEventIds);
  exact(rawItems.map(row => row.id), coverage.relatedRefundItemIds);
  exact(rawLines.map(row => row.refund_item_id), coverage.relatedRefundItemIds);
  const refundEvents = rawEvents.map(row => ({ venueId: row.venue_id, currency: row.currency_code,
    refundId: row.refund_id, refundEventId: row.id, orderId: row.order_id, originalSaleEventId: row.original_sale_event_id,
    recognizedAt: row.recognized_at, recognizedLocalDate: row.recognized_local_date, timezoneSnapshot: row.timezone_snapshot,
    payoutMinor: integer(row.payout_minor), tenderTotalMinor: integer(row.tender_total_minor), itemAttributionStatus: row.item_attribution_status }));
  const refundLines = rawLines.map(row => {
    const event = one(rawEvents.filter(event => event.id === row.refund_event_id));
    const item = one(rawItems.filter(item => item.id === row.refund_item_id));
    if (item.refund_id !== event.refund_id || item.venue_id !== row.venue_id || item.order_id !== row.order_id
        || item.order_item_id !== row.order_item_id || item.snapshot_id !== row.snapshot_id) fail('refund_lineage_invalid');
    for (const key of ['producer_sequence', 'previous_returned_quantity', 'returned_quantity', 'cumulative_returned_quantity',
      'previous_returned_item_value_minor', 'returned_item_value_minor', 'cumulative_returned_item_value_minor']) {
      if (item[key] !== row[key]) fail('refund_item_mismatch');
    }
    return { venueId: row.venue_id, refundId: event.refund_id, refundEventId: row.refund_event_id,
      refundItemId: row.refund_item_id, refundLineEventId: row.id, orderId: row.order_id, orderItemId: row.order_item_id,
      snapshotId: row.snapshot_id, originalSaleEventId: event.original_sale_event_id, originalSaleLineEventId: row.original_sale_line_event_id,
      producerSequence: integer(row.producer_sequence), previousReturnedQuantity: row.previous_returned_quantity,
      returnedQuantity: row.returned_quantity, cumulativeReturnedQuantity: row.cumulative_returned_quantity,
      previousReturnedItemValueMinor: integer(row.previous_returned_item_value_minor), returnedItemValueMinor: integer(row.returned_item_value_minor),
      cumulativeReturnedItemValueMinor: integer(row.cumulative_returned_item_value_minor) };
  });
  const lineTotals = saleLines.map(line => {
    const history = manifest.refundHistory.filter(row => row.originalSaleLineEventId === line.saleLineEventId);
    if (history.length > 1 || (!history.length && rawLines.some(row => row.original_sale_line_event_id === line.saleLineEventId))) fail('history_invalid');
    return { saleLineEventId: line.saleLineEventId, cumulativeReturnedQuantity: history[0]?.cumulativeReturnedQuantity || '0.000',
      cumulativeReturnedItemValueMinor: history[0]?.cumulativeReturnedItemValueMinor ?? 0 };
  });
  return buildPayrollRefundEarningsProjection({ schemaVersion: 1, venueId, currency, period: { from, to },
    manifestWatermark: manifest.watermark, saleLines, refundEvents, refundLines,
    coverage: { status: 'complete', scope: PAYROLL_REFUND_HISTORY_SCOPE, sourceWatermark: manifest.watermark,
      saleLineEventIds: saleLines.map(line => line.saleLineEventId), orderIds,
      refundHeaderIds: coverage.relatedRefundHeaderIds, refundEventIds: coverage.relatedRefundEventIds,
      refundItemIds: coverage.relatedRefundItemIds, refundLineEventIds: coverage.relatedRefundLineEventIds, lineTotals } });
}
async function readPayrollRefundEarningsSourceInTransaction(db, options) {
  if (!db || !options || !hasPayrollVerifiedWriteSnapshot(db, options.venueId)) fail('verified_write_snapshot_required');
  const evidence = await readPayrollRecognitionEvidenceInTransaction(db, options);
  return buildPayrollRefundEarningsSource(evidence, options);
}
module.exports = { buildPayrollRefundEarningsSource, readPayrollRefundEarningsSourceInTransaction };
