'use strict';

// Owner-facing read-only refund impact projection. This is evidence for review,
// never a payroll calculator input, adjustment application, or posting.
const { createHash } = require('node:crypto');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))
  && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const unavailable = (manifest, projection, status, reasons) => ({ schemaVersion: 1, status, officialReady: false,
  candidateOnly: true, nonPayable: true, nonAccrual: true, payoutEligible: false,
  impactStatus: 'not_applied',
  venueId: manifest?.venueId || null, currency: manifest?.currency || null,
  period: manifest?.period ? structuredClone(manifest.period) : null,
  totalMerchandiseNetRevenueDeltaCents: null, rows: [], employeeDays: [], reasons: [...new Set(reasons)].sort(),
  sourceWatermark: projection?.projectionWatermark || null,
  watermarkScope: 'payroll_refund_review_projection' });

const buildPayrollRefundReview = (manifest, projection) => {
  if (!manifest || !projection || !['available', 'incomplete', 'unsupported'].includes(projection.sourceStatus)
      || !Array.isArray(projection.refundAdjustments)) {
    return unavailable(manifest, projection, 'incomplete', ['payroll_refund_review_source_invalid']);
  }
  if (projection.sourceStatus !== 'available' || manifest.status !== 'available'
      || !UUID.test(String(manifest.venueId || '')) || !/^[A-Z]{3}$/.test(String(manifest.currency || ''))
      || !validDate(manifest.period?.from) || !validDate(manifest.period?.to)
      || !/^[a-f0-9]{64}$/.test(String(manifest.watermark || ''))
      || !/^[a-f0-9]{64}$/.test(String(projection.projectionWatermark || ''))
      || projection.sourceWatermark !== manifest.watermark) {
    const reasons = [...new Set([...(projection.sourceReasons || []), ...(manifest.reasons || [])])];
    return unavailable(manifest, projection, projection.sourceStatus === 'unsupported' ? 'unsupported' : 'incomplete',
      reasons.length ? reasons : [projection.sourceWatermark !== manifest.watermark
        ? 'payroll_refund_review_source_watermark_mismatch' : 'payroll_refund_review_coverage_unavailable']);
  }
  const saleFacts = new Map();
  const saleEvents = new Map();
  if (!Array.isArray(manifest.sales)) {
    return unavailable(manifest, projection, 'incomplete', ['payroll_refund_review_sale_events_missing']);
  }
  for (const event of manifest.sales) {
    if (!event || !UUID.test(String(event.eventId || '')) || !UUID.test(String(event.orderId || ''))
        || event.venueId !== manifest.venueId || event.currency !== manifest.currency
        || !validDate(event.recognizedLocalDate) || !Array.isArray(event.lines) || saleEvents.has(event.eventId)) {
      return unavailable(manifest, projection, 'incomplete', ['payroll_refund_review_sale_event_invalid']);
    }
    saleEvents.set(event.eventId, event);
  }
  const validateSaleLineAttribution = (row, parentRequired, historicalOnly = false) => {
    const id = row?.saleLineEventId;
    if (!UUID.test(String(id || '')) || !UUID.test(String(row.saleEventId || '')) || !UUID.test(String(row.sellerId || ''))
        || row.venueId !== manifest.venueId || row.eligibilityStatus !== 'same_venue'
        || !validDate(row.recognizedLocalDate)
        || (historicalOnly && row.recognizedLocalDate >= manifest.period.from && row.recognizedLocalDate <= manifest.period.to)
        || saleFacts.has(id)) {
      return false;
    }
    const parent = saleEvents.get(row.saleEventId);
    if ((parentRequired && !parent) || (parent && (parent.orderId !== row.orderId || parent.recognizedLocalDate !== row.recognizedLocalDate
        || parent.currency !== row.currency || parent.venueId !== row.venueId
        || !parent.lines.some(line => line?.saleLineEventId === id && line.orderItemId === row.orderItemId
          && line.sellerId === row.sellerId && line.venueId === row.venueId)))) {
      return false;
    }
    saleFacts.set(id, row);
    return true;
  };
  if (!Array.isArray(manifest.saleLines) || !Array.isArray(manifest.refundOriginalSaleAttributions)) {
    return unavailable(manifest, projection, 'incomplete', ['payroll_refund_review_sale_line_facts_missing']);
  }
  for (const row of manifest.saleLines) {
    if (!validateSaleLineAttribution(row, true)) {
      return unavailable(manifest, projection, 'incomplete', ['payroll_refund_review_sale_event_binding_mismatch']);
    }
  }
  for (const row of manifest.refundOriginalSaleAttributions) {
    if (!validateSaleLineAttribution(row, false, true)) {
      return unavailable(manifest, projection, 'incomplete', ['payroll_refund_review_sale_event_binding_mismatch']);
    }
  }
  const ids = new Set();
  const sourceRefundLines = new Map();
  if (!Array.isArray(manifest.refundEvents)) {
    return unavailable(manifest, projection, 'incomplete', ['payroll_refund_review_refund_events_missing']);
  }
  for (const event of manifest.refundEvents) {
    if (!event || !UUID.test(String(event.eventId || '')) || !UUID.test(String(event.refundId || ''))
        || !UUID.test(String(event.orderId || '')) || !UUID.test(String(event.originalSaleEventId || ''))
        || !validDate(event.recognizedLocalDate) || event.recognizedLocalDate < manifest.period.from
        || event.recognizedLocalDate > manifest.period.to || event.currency !== manifest.currency
        || !Array.isArray(event.lines)) {
      return unavailable(manifest, projection, 'incomplete', ['payroll_refund_review_source_event_invalid']);
    }
    for (const line of event.lines) {
      if (!line || !UUID.test(String(line.refundItemId || '')) || !UUID.test(String(line.orderItemId || ''))
          || !UUID.test(String(line.originalSaleLineEventId || ''))
          || !Number.isSafeInteger(line.returnedItemValueMinor) || line.returnedItemValueMinor < 0
          || sourceRefundLines.has(line.refundItemId)) {
        return unavailable(manifest, projection, 'incomplete', ['payroll_refund_review_source_line_invalid']);
      }
      sourceRefundLines.set(line.refundItemId, { event, line });
    }
  }
  if (sourceRefundLines.size !== projection.refundAdjustments.length) {
    return unavailable(manifest, projection, 'incomplete', ['payroll_refund_review_source_line_coverage_mismatch']);
  }
  const rows = [];
  const employeeDayTotals = new Map();
  let total = 0n;
  for (const row of projection.refundAdjustments) {
    if (!row || !UUID.test(String(row.id || '')) || !UUID.test(String(row.refundEventId || ''))
        || !UUID.test(String(row.originalSaleLineId || '')) || !UUID.test(String(row.employeeId || ''))
        || ids.has(row.id) || !validDate(row.date) || row.date < manifest.period.from || row.date > manifest.period.to
        || row.currency !== manifest.currency || !Number.isSafeInteger(row.netRevenueAdjustmentCents)
        || row.netRevenueAdjustmentCents > 0 || !saleFacts.has(row.originalSaleLineId)) {
      return unavailable(manifest, projection, 'incomplete', ['payroll_refund_review_lineage_invalid']);
    }
    const source = sourceRefundLines.get(row.id);
    if (!source || source.event.eventId !== row.refundEventId || source.event.orderId !== row.orderId
        || source.event.originalSaleEventId !== row.originalSaleEventId
        || source.event.recognizedLocalDate !== row.date || source.event.currency !== row.currency
        || source.line.refundItemId !== row.id || source.line.originalSaleLineEventId !== row.originalSaleLineId
        || source.line.orderItemId !== row.orderItemId
        || BigInt(row.netRevenueAdjustmentCents) !== -BigInt(source.line.returnedItemValueMinor)) {
      return unavailable(manifest, projection, 'incomplete', ['payroll_refund_review_source_line_mismatch']);
    }
    const original = saleFacts.get(row.originalSaleLineId);
    if (original.saleEventId !== row.originalSaleEventId || original.sellerId !== row.employeeId
        || original.orderId !== row.orderId || original.orderItemId !== row.orderItemId) {
      return unavailable(manifest, projection, 'incomplete', ['payroll_refund_review_sale_line_binding_mismatch']);
    }
    ids.add(row.id);
    total += BigInt(row.netRevenueAdjustmentCents);
    const reviewRow = { refundItemId: row.id, refundEventId: row.refundEventId,
      originalSaleLineId: row.originalSaleLineId, employeeId: row.employeeId,
      orderId: row.orderId, orderItemId: row.orderItemId,
      menuItemId: original.productFacts?.productId || null,
      menuItemName: typeof original.productFacts?.productName === 'string' ? original.productFacts.productName : null,
      refundDate: row.date, originalSaleDate: original.recognizedLocalDate,
      merchandiseNetRevenueDeltaCents: row.netRevenueAdjustmentCents, currency: row.currency };
    rows.push(reviewRow);
    const employeeDayKey = `${row.employeeId}|${row.date}`;
    if (!employeeDayTotals.has(employeeDayKey)) employeeDayTotals.set(employeeDayKey, {
      employeeId: row.employeeId, recognizedDate: row.date, total: 0n, refundItemIds: [], refundEventIds: [], originalSaleLineIds: []
    });
    const employeeDay = employeeDayTotals.get(employeeDayKey);
    employeeDay.total += BigInt(row.netRevenueAdjustmentCents);
    employeeDay.refundItemIds.push(row.id);
    employeeDay.refundEventIds.push(row.refundEventId);
    employeeDay.originalSaleLineIds.push(row.originalSaleLineId);
  }
  if (total < BigInt(Number.MIN_SAFE_INTEGER) || total > 0n
      || [...employeeDayTotals.values()].some(row => row.total < BigInt(Number.MIN_SAFE_INTEGER)
        || row.total > BigInt(Number.MAX_SAFE_INTEGER))) {
    return unavailable(manifest, projection, 'incomplete', ['payroll_refund_review_total_out_of_range']);
  }
  rows.sort((a, b) => a.refundDate.localeCompare(b.refundDate)
    || a.refundEventId.localeCompare(b.refundEventId) || a.refundItemId.localeCompare(b.refundItemId));
  const employeeDays = [...employeeDayTotals.values()].map(row => ({
    employeeId: row.employeeId, recognizedDate: row.recognizedDate,
    merchandiseNetRevenueDeltaCents: Number(row.total), refundItemIds: [...new Set(row.refundItemIds)].sort(),
    refundEventIds: [...new Set(row.refundEventIds)].sort(), originalSaleLineIds: [...new Set(row.originalSaleLineIds)].sort()
  })).sort((a, b) => a.recognizedDate.localeCompare(b.recognizedDate) || a.employeeId.localeCompare(b.employeeId));
  if (employeeDays.reduce((sum, row) => sum + BigInt(row.merchandiseNetRevenueDeltaCents), 0n) !== total) {
    return unavailable(manifest, projection, 'incomplete', ['payroll_refund_review_employee_day_reconciliation_failed']);
  }
  const sourceWatermark = digest({ schemaVersion: 1, manifestWatermark: manifest.watermark,
    projectionWatermark: projection.projectionWatermark, rows, employeeDays });
  return { schemaVersion: 1, status: 'available', officialReady: false, candidateOnly: true,
    nonPayable: true, nonAccrual: true, payoutEligible: false, impactStatus: 'not_applied', venueId: manifest.venueId,
    currency: manifest.currency, period: structuredClone(manifest.period), totalMerchandiseNetRevenueDeltaCents: Number(total),
    rows, employeeDays, reasons: [], sourceWatermark, watermarkScope: 'payroll_refund_review_projection' };
};

module.exports = { buildPayrollRefundReview };
