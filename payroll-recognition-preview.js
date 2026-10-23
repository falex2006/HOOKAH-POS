'use strict';

// Read-only projection of the existing recognition manifest for payroll
// preview. It preserves sale and refund evidence as separate signed events;
// it deliberately does not call the wage calculator or create a run/entry.

const { normalizePayrollSourcePolicies } = require('./payroll-source-policies');
const { createHash } = require('node:crypto');

const fail = (code) => { throw Object.assign(new TypeError(code), { code }); };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = value => typeof value === 'string' && DATE.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))
  && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
const amount = (value, code) => {
  if (!Number.isSafeInteger(value) || value < 0) fail(code);
  return value;
};
const sumSafely = (rows, field) => {
  const total = rows.reduce((sum, row) => sum + BigInt(row[field]), 0n);
  if (total > BigInt(Number.MAX_SAFE_INTEGER) || total < BigInt(Number.MIN_SAFE_INTEGER)) fail('payroll_recognition_preview_total_overflow');
  return Number(total);
};

const buildPayrollRecognitionPreview = (manifest, sourcePolicies) => {
  const policy = normalizePayrollSourcePolicies(sourcePolicies);
  if (!policy || policy.saleCredit.kind !== 'line_seller_snapshot'
      || policy.discountAllocation.kind !== 'immutable_line_snapshot'
      || policy.refunds.recognition !== 'recognized_event_date') {
    return { schemaVersion: 1, status: 'unsupported', officialReady: false, calculationReady: false,
      sourceStatus: 'unsupported', sourceReasons: ['payroll_recognition_preview_policy_unsupported'],
      calculationReasons: ['payroll_recognition_preview_policy_unsupported'],
      reasons: ['payroll_recognition_preview_policy_unsupported'], saleLines: [], refundAdjustments: [], watermark: null };
  }
  if (!manifest || manifest.schemaVersion !== 1 || manifest.status !== 'available' || manifest.officialReady !== false
      || !UUID.test(String(manifest.venueId || '')) || !validDate(manifest.period?.from) || !validDate(manifest.period?.to)
      || manifest.period.from > manifest.period.to || !/^[a-f0-9]{64}$/.test(String(manifest.watermark || ''))
      || !Array.isArray(manifest.saleLines) || !Array.isArray(manifest.refundEvents)) {
    return { schemaVersion: 1, status: 'incomplete', officialReady: false, calculationReady: false,
      sourceStatus: 'incomplete',
      sourceReasons: [...new Set([...(Array.isArray(manifest?.reasons) ? manifest.reasons : []), 'payroll_recognition_manifest_incomplete'])].sort(),
      calculationReasons: [],
      reasons: [...new Set([...(Array.isArray(manifest?.reasons) ? manifest.reasons : []), 'payroll_recognition_manifest_incomplete'])].sort(),
      saleLines: [], refundAdjustments: [], watermark: manifest?.watermark || null };
  }
  const reasons = new Set();
  const saleByEventId = new Map((Array.isArray(manifest.sales) ? manifest.sales : [])
    .filter(row => row && typeof row === 'object').map(row => [row.eventId, row]));
  const saleLineByEventId = new Map();
  const saleValueByLineId = new Map();
  const refundHistoryCapByLineId = new Map();
  const seenSales = new Set();
  const saleLines = [];
  for (const line of manifest.saleLines) {
    if (!line || typeof line !== 'object') {
      reasons.add('payroll_recognition_sale_line_invalid');
      continue;
    }
    const parent = saleByEventId.get(line.saleEventId);
    if (!UUID.test(String(line.saleLineEventId || '')) || !UUID.test(String(line.saleEventId || ''))
        || !UUID.test(String(line.sellerId || '')) || !UUID.test(String(line.orderItemId || ''))
        || seenSales.has(line.saleLineEventId) || line.eligibilityStatus !== 'same_venue' || !parent
        || line.venueId !== manifest.venueId || parent.venueId !== manifest.venueId
        || line.orderId !== parent.orderId || line.snapshotId !== parent.snapshotId
        || line.eligibilityVenueId !== manifest.venueId || line.employeeVenueId !== manifest.venueId
        || !validDate(line.recognizedLocalDate) || line.recognizedLocalDate < manifest.period.from
        || line.recognizedLocalDate > manifest.period.to || parent.currency !== manifest.currency
        || parent.recognizedLocalDate !== line.recognizedLocalDate) {
      reasons.add('payroll_recognition_sale_line_invalid');
      continue;
    }
    let netMinor;
    try {
      const grossMinor = amount(line.grossMinor, 'payroll_recognition_sale_amount_invalid');
      const discountMinor = amount(line.discountMinor, 'payroll_recognition_sale_amount_invalid');
      netMinor = amount(line.netMinor, 'payroll_recognition_sale_amount_invalid');
      if (grossMinor - discountMinor !== netMinor) fail('payroll_recognition_sale_amount_invalid');
    }
    catch (_) { reasons.add('payroll_recognition_sale_amount_invalid'); continue; }
    seenSales.add(line.saleLineEventId);
    saleLineByEventId.set(line.saleLineEventId, { id: line.saleLineEventId, saleEventId: line.saleEventId,
      orderId: line.orderId, orderItemId: line.orderItemId, sellerId: line.sellerId, venueId: line.venueId });
    saleValueByLineId.set(line.saleLineEventId, netMinor);
    saleLines.push({ id: line.saleLineEventId, saleEventId: line.saleEventId, orderItemId: line.orderItemId,
      orderId: line.orderId, employeeId: line.sellerId, date: line.recognizedLocalDate, currency: manifest.currency,
      menuItemId: line.productFacts?.productId || null,
      commissionBaseCents: netMinor, netRevenueCents: netMinor, source: 'recognized_sale_line',
      sourceWatermark: manifest.watermark });
  }
  const refundHistory = new Map((Array.isArray(manifest.refundHistory) ? manifest.refundHistory : [])
    .filter(row => row && typeof row === 'object' && UUID.test(String(row.originalSaleLineEventId || '')))
    .map(row => [row.originalSaleLineEventId, row]));
  for (const [lineId, history] of refundHistory) {
    try {
      const cumulativeMinor = amount(history.cumulativeReturnedItemValueMinor, 'payroll_recognition_refund_history_invalid');
      if (!UUID.test(String(history.orderId || '')) || !UUID.test(String(history.orderItemId || ''))
          || typeof history.cumulativeReturnedQuantity !== 'string' || !/^\d+\.\d{3}$/.test(history.cumulativeReturnedQuantity)) {
        fail('payroll_recognition_refund_history_invalid');
      }
      refundHistoryCapByLineId.set(lineId, cumulativeMinor);
    } catch (_) { reasons.add('payroll_recognition_refund_history_invalid'); }
  }
  const relatedByLineId = new Map();
  const relatedRawByLineId = new Map();
  const seenRelated = new Set();
  if (!Array.isArray(manifest.refundOriginalSaleAttributions)) reasons.add('payroll_recognition_related_sale_attributions_missing');
  for (const row of Array.isArray(manifest.refundOriginalSaleAttributions) ? manifest.refundOriginalSaleAttributions : []) {
    if (!row || !UUID.test(String(row.saleEventId || '')) || !UUID.test(String(row.saleLineEventId || ''))
        || !UUID.test(String(row.orderId || '')) || !UUID.test(String(row.snapshotId || ''))
        || !UUID.test(String(row.orderItemId || '')) || !UUID.test(String(row.sellerId || ''))
        || seenRelated.has(row.saleLineEventId) || row.venueId !== manifest.venueId
        || row.eligibilityStatus !== 'same_venue' || row.eligibilityVenueId !== manifest.venueId
        || row.employeeVenueId !== manifest.venueId || row.attributionPolicyVersion !== 1
        || !validDate(row.recognizedLocalDate) || (row.recognizedLocalDate >= manifest.period.from && row.recognizedLocalDate <= manifest.period.to)
        || row.currency !== manifest.currency) {
      reasons.add('payroll_recognition_related_sale_attribution_invalid');
      continue;
    }
    const referencedByCurrentRefund = manifest.refundEvents.some(event => event?.originalSaleEventId === row.saleEventId
      && event.orderId === row.orderId && Array.isArray(event.lines)
      && event.lines.some(line => line?.originalSaleLineEventId === row.saleLineEventId && line.orderItemId === row.orderItemId));
    if (!referencedByCurrentRefund || saleLineByEventId.has(row.saleLineEventId)) {
      reasons.add('payroll_recognition_related_sale_attribution_orphaned');
      continue;
    }
    let grossMinor; let discountMinor; let netMinor; let cumulativeMinor;
    try {
      grossMinor = amount(row.grossMinor, 'payroll_recognition_related_sale_amount_invalid');
      discountMinor = amount(row.discountMinor, 'payroll_recognition_related_sale_amount_invalid');
      netMinor = amount(row.netMinor, 'payroll_recognition_related_sale_amount_invalid');
      cumulativeMinor = amount(row.cumulativeReturnedItemValueMinor, 'payroll_recognition_related_sale_history_invalid');
      if (grossMinor - discountMinor !== netMinor || cumulativeMinor > netMinor
          || typeof row.cumulativeReturnedQuantity !== 'string' || !/^\d+\.\d{3}$/.test(row.cumulativeReturnedQuantity)) {
        fail('payroll_recognition_related_sale_history_invalid');
      }
    } catch (_) { reasons.add('payroll_recognition_related_sale_history_invalid'); continue; }
    seenRelated.add(row.saleLineEventId);
    const relatedHistory = refundHistory.get(row.saleLineEventId);
    if (!relatedHistory || relatedHistory.orderId !== row.orderId || relatedHistory.orderItemId !== row.orderItemId
        || relatedHistory.cumulativeReturnedQuantity !== row.cumulativeReturnedQuantity
        || relatedHistory.cumulativeReturnedItemValueMinor !== cumulativeMinor) {
      reasons.add('payroll_recognition_related_sale_history_mismatch');
      continue;
    }
    relatedByLineId.set(row.saleLineEventId, { id: row.saleLineEventId, saleEventId: row.saleEventId,
      orderId: row.orderId, orderItemId: row.orderItemId, sellerId: row.sellerId, venueId: row.venueId });
    relatedRawByLineId.set(row.saleLineEventId, row);
    saleValueByLineId.set(row.saleLineEventId, netMinor);
    refundHistoryCapByLineId.set(row.saleLineEventId, cumulativeMinor);
  }
  const refundAdjustments = [];
  const seenRefundLines = new Set();
  const refundValueBySaleLine = new Map();
  const referencedSaleLineIds = new Set();
  for (const event of manifest.refundEvents) {
    if (!event || !UUID.test(String(event.eventId || '')) || !validDate(event.recognizedLocalDate)
        || event.recognizedLocalDate < manifest.period.from || event.recognizedLocalDate > manifest.period.to
        || event.currency !== manifest.currency || !Array.isArray(event.lines)) {
      reasons.add('payroll_recognition_refund_event_invalid');
      continue;
    }
    for (const line of event.lines) {
      referencedSaleLineIds.add(line?.originalSaleLineEventId);
      if (!line || !UUID.test(String(line.refundItemId || '')) || !UUID.test(String(line.originalSaleLineEventId || ''))
          || !UUID.test(String(line.orderItemId || '')) || seenRefundLines.has(line.refundItemId)) {
        reasons.add('payroll_recognition_refund_line_invalid');
        continue;
      }
      const original = saleLineByEventId.get(line.originalSaleLineEventId) || relatedByLineId.get(line.originalSaleLineEventId);
      if (!original || original.orderItemId !== line.orderItemId
          || (original.venueId && original.venueId !== manifest.venueId)
          || event.originalSaleEventId !== original.saleEventId || event.orderId !== original.orderId) {
        reasons.add('payroll_recognition_refund_original_sale_attribution_missing');
        continue;
      }
      const history = refundHistory.get(original.id);
      if (!history || history.orderId !== original.orderId || history.orderItemId !== original.orderItemId) {
        reasons.add('payroll_recognition_refund_history_missing');
        continue;
      }
      const relatedSource = relatedRawByLineId.get(original.id);
      if (relatedSource && (history.cumulativeReturnedQuantity !== relatedSource.cumulativeReturnedQuantity
          || history.cumulativeReturnedItemValueMinor !== relatedSource.cumulativeReturnedItemValueMinor)) {
        reasons.add('payroll_recognition_related_sale_history_mismatch');
        continue;
      }
      let returnedMinor;
      try { returnedMinor = amount(line.returnedItemValueMinor, 'payroll_recognition_refund_amount_invalid'); }
      catch (_) { reasons.add('payroll_recognition_refund_amount_invalid'); continue; }
      seenRefundLines.add(line.refundItemId);
      const returnedTotal = (refundValueBySaleLine.get(original.id) || 0n) + BigInt(returnedMinor);
      refundValueBySaleLine.set(original.id, returnedTotal);
      refundAdjustments.push({ id: line.refundItemId, refundEventId: event.eventId,
        originalSaleLineId: original.id, originalSaleEventId: original.saleEventId,
        orderId: original.orderId, orderItemId: original.orderItemId, employeeId: original.sellerId,
        date: event.recognizedLocalDate, currency: event.currency, commissionBaseAdjustmentCents: -returnedMinor,
        netRevenueAdjustmentCents: -returnedMinor, source: 'recognized_line_refund',
        treatment: 'preview_only_next_open_run_review', automaticClawback: false, sourceWatermark: manifest.watermark });
    }
  }
  for (const [lineId, attribution] of relatedByLineId) {
    if (!referencedSaleLineIds.has(lineId) || saleLineByEventId.has(lineId)
        || refundHistoryCapByLineId.get(lineId) === undefined) reasons.add('payroll_recognition_related_sale_attribution_orphaned');
  }
  const invalidRefundSaleLines = new Set();
  for (const [lineId, returnedTotal] of refundValueBySaleLine) {
    const saleNet = saleValueByLineId.get(lineId);
    const fullHistoryCap = refundHistoryCapByLineId.get(lineId);
    if (saleNet === undefined || fullHistoryCap === undefined || returnedTotal > BigInt(saleNet)
        || returnedTotal > BigInt(fullHistoryCap)) {
      reasons.add(fullHistoryCap === undefined ? 'payroll_recognition_refund_history_missing'
        : 'payroll_recognition_refund_exceeds_original_sale');
      invalidRefundSaleLines.add(lineId);
    }
  }
  if (invalidRefundSaleLines.size) {
    for (let index = refundAdjustments.length - 1; index >= 0; index -= 1) {
      if (invalidRefundSaleLines.has(refundAdjustments[index].originalSaleLineId)) refundAdjustments.splice(index, 1);
    }
  }
  saleLines.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  refundAdjustments.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const sourceReasons = [...reasons].sort();
  // The current wage engine has no signed refund input, and its full input
  // contract also requires sourced employee, role, department and attendance
  // coverage. Keep this projection explicitly non-calculating until those
  // contracts are joined in a single server-owned snapshot.
  reasons.add('payroll_calculator_signed_refund_input_missing');
  reasons.add('payroll_calculator_department_employee_attendance_sources_missing');
  const projectionWatermark = createHash('sha256').update(JSON.stringify({ schemaVersion: 1, manifestWatermark: manifest.watermark,
    sourcePolicies: policy, venueId: manifest.venueId, currency: manifest.currency, period: manifest.period,
    scope: 'recognized_line_events_preview_only' })).digest('hex');
  const calculationReasons = ['payroll_calculator_signed_refund_input_missing',
    'payroll_calculator_department_employee_attendance_sources_missing'];
  return { schemaVersion: 1, status: reasons.size > 0 ? 'incomplete' : 'available', officialReady: false,
    calculationReady: false, sourceStatus: sourceReasons.length ? 'incomplete' : 'available', sourceReasons,
    calculationReasons, reasons: [...reasons].sort(), venueId: manifest.venueId, currency: manifest.currency,
    period: structuredClone(manifest.period), saleLines, refundAdjustments,
    saleNetRevenueCents: sumSafely(saleLines, 'netRevenueCents'),
    refundNetRevenueAdjustmentCents: sumSafely(refundAdjustments, 'netRevenueAdjustmentCents'),
    sourceWatermark: manifest.watermark, projectionWatermark, sourceScope: 'recognized_line_events_preview_only' };
};

module.exports = { buildPayrollRecognitionPreview };
