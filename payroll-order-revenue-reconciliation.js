'use strict';

const { createHash } = require('node:crypto');

const fail = code => { throw Object.assign(new TypeError(code), { code }); };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const minor = value => {
  const text = String(value);
  if (!/^(0|[1-9][0-9]*)$/.test(text) || text.length > 16) fail('payroll_order_reconciliation_amount_invalid');
  const amount = BigInt(text);
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) fail('payroll_order_reconciliation_amount_out_of_range');
  return amount;
};
const stable = value => Array.isArray(value) ? `[${value.map(stable).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`
    : JSON.stringify(value);

// Pure, candidate-only reconciliation. Orders remain the denominator even
// when their payroll sale event or any of its lines is missing.
const buildPayrollOrderRevenueReconciliation = ({ venueId, currency, period, venueTimezone, orders, recognitionManifest }) => {
  if (!UUID.test(String(venueId || '')) || typeof currency !== 'string' || !period || !Array.isArray(orders)
      || !recognitionManifest || recognitionManifest.venueId !== venueId || recognitionManifest.currency !== currency
      || recognitionManifest.period?.from !== period.from || recognitionManifest.period?.to !== period.to) {
    fail('payroll_order_reconciliation_evidence_invalid');
  }
  const reasons = new Set();
  const eventByOrder = new Map();
  let dateFormatter;
  try {
    if (typeof venueTimezone !== 'string' || !venueTimezone) throw new TypeError();
    dateFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: venueTimezone, year: 'numeric', month: '2-digit', day: '2-digit' });
  } catch (_) { fail('payroll_order_reconciliation_timezone_invalid'); }
  // The manifest keeps a padded candidate window and full related history.
  // Match the closed-order denominator's current venue timezone, not the
  // recognition event's frozen local date. Keep the original timestamp bytes.
  const sourceSales = (Array.isArray(recognitionManifest.closedOrderSales) ? recognitionManifest.closedOrderSales : recognitionManifest.sales || []).filter(event => {
    const value = event?.sourceClosedAt;
    const match = typeof value === 'string' && value.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/);
    const instant = match ? new Date(value) : null;
    if (!match || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59
        || !Number.isFinite(instant.getTime()) || instant.toISOString().slice(0, 10) !== match[1]) {
      reasons.add('payroll_order_reconciliation_sale_event_close_timestamp_invalid');
      return true;
    }
    const parts = Object.fromEntries(dateFormatter.formatToParts(instant).map(part => [part.type, part.value]));
    const localDate = `${parts.year}-${parts.month}-${parts.day}`;
    return localDate >= period.from && localDate <= period.to;
  });
  for (const event of sourceSales) {
    if (!event || event.venueId !== venueId || !UUID.test(String(event.orderId || '')) || event.coverageStatus !== 'complete') {
      reasons.add('payroll_order_reconciliation_sale_event_coverage_incomplete');
      continue;
    }
    if (!eventByOrder.has(event.orderId)) eventByOrder.set(event.orderId, []);
    eventByOrder.get(event.orderId).push(event);
  }
  const linesByOrder = new Map();
  for (const event of sourceSales) {
    for (const line of event?.lines || []) {
      if (!line || line.venueId !== venueId || line.orderId !== event.orderId || line.saleEventId !== event.eventId) {
        reasons.add('payroll_order_reconciliation_sale_line_invalid');
        continue;
      }
      if (!linesByOrder.has(line.orderId)) linesByOrder.set(line.orderId, []);
      linesByOrder.get(line.orderId).push(line);
    }
  }
  const seen = new Set();
  let recognizedCount = 0;
  const rows = orders.map(order => {
    if (!order || !UUID.test(String(order.orderId || '')) || seen.has(order.orderId)) fail('payroll_order_reconciliation_order_identity_invalid');
    seen.add(order.orderId);
    const rowReasons = [];
    const header = order.canonicalPricing;
    if (!header || header.valid !== true) rowReasons.push('canonical_pricing_snapshot_missing_or_invalid');
    const total = header?.valid === true ? minor(header.finalTotalMinor) : null;
    const itemNet = header?.valid === true ? minor(header.subtotalMinor) - minor(header.discountMinor) : null;
    const minimumAdjustment = header?.valid === true ? minor(header.minimumAdjustmentMinor) : null;
    const lines = linesByOrder.get(order.orderId) || [];
    const events = eventByOrder.get(order.orderId) || [];
    let lineNet = 0n;
    for (const line of lines) {
      if (!events.some(event => event.eventId === line.saleEventId)) rowReasons.push('recognized_sale_line_parent_missing');
      else lineNet += minor(line.netMinor);
    }
    if (events.length !== 1) rowReasons.push(events.length ? 'multiple_recognized_sale_events_for_closed_order' : 'recognized_sale_event_missing');
    else if (events[0].sourceClosedAt !== order.closedAt) rowReasons.push('sale_event_close_timestamp_mismatch');
    if (total !== null && (itemNet + minimumAdjustment !== total)) rowReasons.push('canonical_order_total_mismatch');
    if (total !== null && lineNet !== itemNet) rowReasons.push('recognized_sale_lines_do_not_cover_canonical_items');
    const valid = rowReasons.length === 0;
    if (valid) recognizedCount += 1;
    return {
      orderId: order.orderId,
      closedAt: order.closedAt,
      amountSource: header?.valid === true ? 'canonical_pricing_snapshot' : 'unknown',
      closedOrderTotalMinor: total === null ? null : Number(total),
      recognizedLineNetMinor: valid ? Number(lineNet) : null,
      minimumPriceAdjustmentMinor: valid ? Number(minimumAdjustment) : null,
      unattributedResidualMinor: valid ? Number(total - lineNet - minimumAdjustment) : null,
      status: valid ? 'available' : 'incomplete',
      reasons: [...new Set(rowReasons)].sort()
    };
  }).sort((a, b) => a.orderId.localeCompare(b.orderId, 'en'));
  if (recognitionManifest.status !== 'available') reasons.add('payroll_recognition_manifest_incomplete');
  for (const [orderId, events] of eventByOrder) {
    if (!seen.has(orderId) && events.some(event => event.sourceClosedAt)) reasons.add('recognized_sale_event_order_outside_closed_order_source');
  }
  for (const row of rows) for (const reason of row.reasons) reasons.add(reason);
  const complete = reasons.size === 0 && rows.every(row => row.status === 'available');
  const sum = field => rows.reduce((total, row) => total + BigInt(row[field] ?? 0), 0n);
  const totals = complete ? {
    closedOrderTotalMinor: Number(sum('closedOrderTotalMinor')),
    recognizedLineNetMinor: Number(sum('recognizedLineNetMinor')),
    minimumPriceAdjustmentMinor: Number(sum('minimumPriceAdjustmentMinor')),
    unattributedResidualMinor: Number(sum('unattributedResidualMinor'))
  } : { closedOrderTotalMinor: null, recognizedLineNetMinor: null, minimumPriceAdjustmentMinor: null, unattributedResidualMinor: null };
  const facts = { schemaVersion: 1, venueId, currency, period, venueTimezone, manifestWatermark: recognitionManifest.watermark,
    orders: orders.map(order => ({ orderId: order.orderId, closedAt: order.closedAt, canonicalPricing: order.canonicalPricing })),
    saleEvents: sourceSales, rows, reasons: [...reasons].sort() };
  return {
    schemaVersion: 1, status: complete ? 'available' : 'incomplete', candidateOnly: true, officialReady: false, persistence: 'none',
    currency, period: { ...period, timezone: venueTimezone }, amountBasis: 'canonical_closed_order_total_pre_refund',
    closedOrderCount: rows.length, recognizedOrderCount: recognizedCount, unrecognizedOrderCount: rows.length - recognizedCount,
    totals, coverage: { complete, missingSaleEventCount: rows.filter(row => row.reasons.includes('recognized_sale_event_missing')).length,
      invalidSnapshotCount: rows.filter(row => row.reasons.includes('canonical_pricing_snapshot_missing_or_invalid')).length },
    orders: rows, reasons: [...reasons].sort(), sourceWatermark: createHash('sha256').update(stable(facts)).digest('hex'),
    watermarkScope: 'payroll_owner_closed_order_to_recognized_line_reconciliation'
  };
};

module.exports = { buildPayrollOrderRevenueReconciliation };
