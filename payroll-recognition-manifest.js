'use strict';
const { hasPayrollVerifiedWriteSnapshot, hasPayrollVerifiedSourceSnapshot } = require('./payroll-source-fence');

const { createHash, randomBytes } = require('node:crypto');
const { validateCanonicalPayrollPricingOrder } = require('./payroll-canonical-pricing-source');

const fail = suffix => { const code = `payroll_recognition_manifest_${suffix}`; throw Object.assign(new TypeError(code), { code }); };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const dateValid = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))
  && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
const uuid = value => { if (typeof value !== 'string' || !UUID.test(value)) fail('identity_invalid'); return value; };
const isoDate = value => { if (!dateValid(value)) fail('date_invalid'); return value; };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const array = value => { if (!Array.isArray(value)) fail('facts_invalid'); return value; };
const int = (value, { positive = false, max = Number.MAX_SAFE_INTEGER } = {}) => {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0) || value > max) fail('amount_invalid'); return BigInt(value);
};
const minorText = (value, { positive = false } = {}) => {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value) || value.length > 16) fail('amount_invalid');
  const n = BigInt(value); if (n > BigInt(Number.MAX_SAFE_INTEGER) || (positive && n === 0n)) fail('amount_invalid'); return n;
};
const decimalUnits = (value, scale, { positive = false } = {}) => {
  if (typeof value !== 'string' || value.length > 32 || !new RegExp(`^(0|[1-9][0-9]*)(?:\\.([0-9]{1,${scale}}))?$`).test(value)) fail('decimal_invalid');
  const [whole, fraction = ''] = value.split('.');
  const n = BigInt(whole) * 10n ** BigInt(scale) + BigInt(fraction.padEnd(scale, '0'));
  if (n > 999999999999999n || (positive && n === 0n)) fail('decimal_invalid'); return n;
};

// SQL uses this fixed UTC codec so ordering and the watermark retain all six
// PostgreSQL timestamp digits. Never normalize recognition facts through Date.
const instantMicros = value => {
  const m = typeof value === 'string' && value.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/);
  if (!m || !dateValid(m[1]) || Number(m[2]) > 23 || Number(m[3]) > 59 || Number(m[4]) > 59) fail('timestamp_invalid');
  const ms = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.000Z`);
  if (!Number.isFinite(ms)) fail('timestamp_invalid');
  return BigInt(ms) * 1000n + BigInt(m[5]);
};
const timestampValid = value => { try { instantMicros(value); return true; } catch (_) { return false; } };
const localDateAt = (timestamp, timezone) => {
  const micros = instantMicros(timestamp);
  const d = new Date(Number(micros / 1000n));
  let formatter;
  try { formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }); }
  catch (_) { fail('timezone_invalid'); }
  const p = Object.fromEntries(formatter.formatToParts(d).map(part => [part.type, part.value]));
  return `${p.year}-${p.month}-${p.day}`;
};
const sorted = rows => rows.slice().sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), 'en'));
const digest = input => createHash('sha256').update(JSON.stringify(input)).digest('hex');
const plusReason = (set, reason) => set.add(reason);
const eventIsInPeriod = (row, from, to) => typeof row.recognized_local_date === 'string'
  && row.recognized_local_date >= from && row.recognized_local_date <= to;

const validateEpoch = (epoch, venueId, from) => {
  if (!plain(epoch) || uuid(epoch.venue_id) !== venueId || epoch.policy_version !== 1
      || !['existing_at_install', 'new_venue'].includes(epoch.activation_scope)) fail('epoch_invalid');
  const activated = instantMicros(epoch.activated_at);
  if ((epoch.timezone_snapshot === null) !== (epoch.activated_local_date === null)) fail('epoch_invalid');
  if (epoch.timezone_snapshot !== null) {
    if (typeof epoch.timezone_snapshot !== 'string' || localDateAt(epoch.activated_at, epoch.timezone_snapshot) !== epoch.activated_local_date) fail('epoch_invalid');
  }
  const periodEnvelope = BigInt(Date.parse(`${from}T00:00:00.000Z`)) * 1000n - 86400000000n;
  const epochComplete = epoch.activation_scope === 'new_venue' || periodEnvelope >= activated;
  return { epoch: structuredClone(epoch), epochComplete, periodEnvelope };
};

const validateSalePricing = (sale, facts, venueId, currency) => {
  const order = facts.ordersById.get(sale.order_id), header = facts.pricingHeadersByOrder.get(sale.order_id);
  if (!order || !header || header.id !== sale.snapshot_id) return { error: 'sale_pricing_source_missing' };
  // Recognition evidence is retained, but a reopened/canceled order needs an
  // explicit financial correction policy before it can fund payroll or margin.
  if (order.status !== 'closed') return { error: 'sale_order_not_closed' };
  const sourceLines = facts.pricingLinesByOrder.get(sale.order_id) || [];
  const itemIds = facts.orderItemsByOrder.get(sale.order_id) || [];
  try {
    const validated = validateCanonicalPayrollPricingOrder({ order, header, lines: sourceLines, itemIds }, { venueId, currency });
    return { validated, header, sourceLines, itemIds };
  } catch (error) {
    if (error.code?.startsWith('payroll_canonical_pricing_')) return { error: 'canonical_pricing_invalid' };
    throw error;
  }
};

const validateSale = (sale, facts, venueId, currency, reasons) => {
  if (uuid(sale.venue_id) !== venueId || sale.policy_version !== 1 || sale.currency_code !== currency) plusReason(reasons, 'sale_identity_or_currency_invalid');
  if (!['complete', 'incomplete'].includes(sale.coverage_status) || !Array.isArray(sale.coverage_reasons)) plusReason(reasons, 'sale_coverage_invalid');
  else if (sale.coverage_status !== 'complete' || sale.coverage_reasons.length) plusReason(reasons, 'sale_source_coverage_incomplete');
  if (sale.recognized_local_date === null || sale.timezone_snapshot === null) plusReason(reasons, 'sale_recognition_date_unassignable');
  else {
    try {
      if (localDateAt(sale.recognized_at, sale.timezone_snapshot) !== sale.recognized_local_date) plusReason(reasons, 'sale_recognition_date_mismatch');
    } catch (error) {
      if (!error.code?.startsWith('payroll_recognition_manifest_')) throw error;
      plusReason(reasons, 'sale_recognition_date_invalid');
    }
  }
  const priced = validateSalePricing(sale, facts, venueId, currency);
  if (priced.error) { plusReason(reasons, priced.error); return []; }
  if (sale.source_closed_at !== priced.validated.order.closedAt) plusReason(reasons, 'sale_close_source_mismatch');
  const lines = facts.saleLinesByEvent.get(sale.id) || [], byItem = new Map();
  for (const line of lines) {
    if (byItem.has(line.order_item_id)) plusReason(reasons, 'sale_line_duplicate');
    byItem.set(line.order_item_id, line);
  }
  if (lines.length !== priced.sourceLines.length || byItem.size !== priced.sourceLines.length) plusReason(reasons, 'sale_line_coverage_mismatch');
  const manifestLines = [];
  for (const pricing of priced.sourceLines.slice().sort((a, b) => a.order_item_id.localeCompare(b.order_item_id, 'en'))) {
    const line = byItem.get(pricing.order_item_id);
    if (!line) { plusReason(reasons, 'sale_line_coverage_mismatch'); continue; }
    if (line.venue_id !== venueId || line.sale_event_id !== sale.id || line.order_id !== sale.order_id
        || line.snapshot_id !== sale.snapshot_id || line.pricing_line_id !== pricing.id) plusReason(reasons, 'sale_line_lineage_mismatch');
    if (line.seller_id !== pricing.seller_id || line.sold_at !== pricing.sold_at) plusReason(reasons, 'sale_line_seller_snapshot_mismatch');
    if (line.eligibility_status !== 'same_venue' || line.eligibility_venue_id !== venueId || line.employee_venue_id !== venueId
        || line.attribution_policy_version !== 1 || line.attribution_captured_at === null || line.seller_id === null) {
      plusReason(reasons, line.eligibility_status === 'cross_venue' ? 'cross_venue_employee_unsupported' : 'sale_line_employee_eligibility_unknown');
    }
    if (line.sold_at !== null) {
      try { instantMicros(line.sold_at); } catch (_) { plusReason(reasons, 'sale_line_timestamp_invalid'); }
    }
    try { if (line.attribution_captured_at !== null) instantMicros(line.attribution_captured_at); }
    catch (_) { plusReason(reasons, 'sale_line_attribution_timestamp_invalid'); }
    manifestLines.push({
      saleLineEventId: line.id, saleEventId: sale.id, venueId, snapshotId: sale.snapshot_id,
      orderId: sale.order_id, orderItemId: pricing.order_item_id, pricingLineId: pricing.id,
      sellerId: line.seller_id, eligibilityStatus: line.eligibility_status, eligibilityVenueId: line.eligibility_venue_id,
      employeeVenueId: line.employee_venue_id, attributionPolicyVersion: line.attribution_policy_version,
      attributionCapturedAt: line.attribution_captured_at, recognizedAt: sale.recognized_at,
      recognizedLocalDate: sale.recognized_local_date, timezoneSnapshot: sale.timezone_snapshot,
      soldAt: line.sold_at, quantity: pricing.quantity, grossMinor: Number(pricing.gross_minor), net_minor: pricing.net_minor,
      discountMinor: Number(pricing.discount_minor), netMinor: Number(pricing.net_minor), productFacts: structuredClone(pricing.product_facts)
    });
  }
  return manifestLines;
};

const validateReturnHistory = (saleLine, rawRows, eventRows, refundEventById, rawHeaderById, reasons) => {
  if (!rawRows.length && !eventRows.length) return { quantity: '0.000', valueMinor: 0 };
  if (rawRows.length !== eventRows.length) plusReason(reasons, 'refund_line_event_coverage_mismatch');
  const eventByItem = new Map(eventRows.map(row => [row.refund_item_id, row]));
  const rows = rawRows.slice().sort((a, b) => Number(a.producer_sequence || 0) - Number(b.producer_sequence || 0));
  let q = 0n, value = 0n, expectedSequence = 1n;
  const originalQ = decimalUnits(saleLine.quantity, 3, { positive: true });
  const originalNet = minorText(String(saleLine.net_minor));
  for (const row of rows) {
    const lineEvent = eventByItem.get(row.id), evt = lineEvent ? refundEventById.get(lineEvent.refund_event_id) : null;
    const header = rawHeaderById.get(row.refund_id);
    if (!lineEvent || !evt || !header || evt.refund_id !== row.refund_id || evt.order_id !== row.order_id
        || lineEvent.refund_event_id !== evt.id || lineEvent.order_id !== row.order_id
        || lineEvent.snapshot_id !== row.snapshot_id || lineEvent.order_item_id !== row.order_item_id
        || lineEvent.venue_id !== row.venue_id || lineEvent.venue_id !== saleLine.venue_id) plusReason(reasons, 'refund_line_event_lineage_mismatch');
    if (!lineEvent || !evt || !header) continue;
    if (row.producer_sequence === null || lineEvent.producer_sequence === null) { plusReason(reasons, 'refund_history_legacy_unsequenced'); continue; }
    if (!/^[1-9][0-9]*$/.test(String(row.producer_sequence)) || BigInt(row.producer_sequence) !== expectedSequence
        || String(lineEvent.producer_sequence) !== String(row.producer_sequence)) plusReason(reasons, 'refund_history_sequence_gap');
    const seq = BigInt(row.producer_sequence); expectedSequence = seq + 1n;
    const previousQ = decimalUnits(String(row.previous_returned_quantity), 3);
    const deltaQ = decimalUnits(String(row.returned_quantity), 3, { positive: true });
    const cumulativeQ = decimalUnits(String(row.cumulative_returned_quantity), 3);
    const previousValue = minorText(String(row.previous_returned_item_value_minor));
    const deltaValue = minorText(String(row.returned_item_value_minor));
    const cumulativeValue = minorText(String(row.cumulative_returned_item_value_minor));
    if (previousQ !== q || previousValue !== value || cumulativeQ !== previousQ + deltaQ || cumulativeQ > originalQ
        || decimalUnits(String(lineEvent.previous_returned_quantity), 3) !== previousQ
        || decimalUnits(String(lineEvent.returned_quantity), 3, { positive: true }) !== deltaQ
        || decimalUnits(String(lineEvent.cumulative_returned_quantity), 3) !== cumulativeQ
        || BigInt(lineEvent.previous_returned_item_value_minor) !== previousValue
        || BigInt(lineEvent.returned_item_value_minor) !== deltaValue
        || BigInt(lineEvent.cumulative_returned_item_value_minor) !== cumulativeValue) plusReason(reasons, 'refund_history_transition_mismatch');
    const expectedValue = (2n * originalNet * cumulativeQ + originalQ) / (2n * originalQ);
    if (cumulativeValue !== expectedValue || deltaValue !== expectedValue - previousValue || cumulativeValue > originalNet) plusReason(reasons, 'refund_history_value_mismatch');
    q = cumulativeQ; value = cumulativeValue;
  }
  return { quantity: `${q / 1000n}.${String(q % 1000n).padStart(3, '0')}`, valueMinor: Number(value) };
};

const buildPayrollRecognitionManifest = (facts, { venueId, currency = 'RUB', from, to } = {}) => {
  uuid(venueId); isoDate(from); isoDate(to);
  if (from !== `${from.slice(0, 7)}-01` || from.slice(0, 7) !== to.slice(0, 7) || to < from) fail('period_invalid');
  if (currency !== 'RUB') fail('currency_unsupported');
  if (!plain(facts)) fail('facts_invalid');
  for (const field of ['saleEvents', 'saleLines', 'orders', 'pricingHeaders', 'pricingLines', 'orderItems', 'candidateOrders',
    'refundEvents', 'refundLines', 'refundHeaders', 'relatedRefundHeaders', 'relatedRefundItems', 'refundItems', 'refundTenders', 'candidateRefunds']) array(facts[field]);
  const reasons = new Set();
  let epochResult;
  try { epochResult = validateEpoch(facts.epoch, venueId, from); }
  catch (error) { if (!error.code?.startsWith('payroll_recognition_manifest_')) throw error; plusReason(reasons, 'recognition_epoch_invalid'); }
  if (!epochResult) return { schemaVersion: 1, status: 'incomplete', officialReady: false, venueId, currency, period: { from, to },
    reasons: [...reasons], epoch: null, saleEvents: [], sales: [], saleLines: [], refundEvents: [], refunds: [],
    refundOriginalSaleAttributions: [], refundHistory: [], relatedRefundCoverage: null,
    watermark: null, watermarkScope: null };
  const { epoch, epochComplete } = epochResult;
  if (!epochComplete) plusReason(reasons, 'period_precedes_recognition_epoch');
  const ordersById = new Map(facts.orders.map(row => [row.id, row]));
  const pricingHeadersByOrder = new Map(facts.pricingHeaders.map(row => [row.order_id, row]));
  const pricingLinesByOrder = new Map(); for (const row of facts.pricingLines) { if (!pricingLinesByOrder.has(row.order_id)) pricingLinesByOrder.set(row.order_id, []); pricingLinesByOrder.get(row.order_id).push(row); }
  const orderItemsByOrder = new Map(); for (const row of facts.orderItems) { if (!orderItemsByOrder.has(row.order_id)) orderItemsByOrder.set(row.order_id, []); orderItemsByOrder.get(row.order_id).push(row.id); }
  const saleLinesByEvent = new Map(); for (const row of facts.saleLines) { if (!saleLinesByEvent.has(row.sale_event_id)) saleLinesByEvent.set(row.sale_event_id, []); saleLinesByEvent.get(row.sale_event_id).push(row); }
  const readFacts = { ...facts, ordersById, pricingHeadersByOrder, pricingLinesByOrder, orderItemsByOrder, saleLinesByEvent };
  const eventByOrder = new Map();
  for (const row of facts.saleEvents) { if (eventByOrder.has(row.order_id)) plusReason(reasons, 'duplicate_sale_recognition'); eventByOrder.set(row.order_id, row); }
  const activationMicros = instantMicros(epoch.activated_at);
  for (const order of facts.candidateOrders) {
    if (order.venue_id !== venueId || order.status !== 'closed') { plusReason(reasons, 'candidate_order_identity_invalid'); continue; }
    if (order.closed_at === null) { plusReason(reasons, 'closed_order_without_timestamp_present'); continue; }
    const closed = instantMicros(order.closed_at);
    if (closed >= activationMicros && !eventByOrder.has(order.id)) plusReason(reasons, 'post_epoch_sale_recognition_missing');
  }
  for (const order of facts.candidateRefunds) {
    if (order.venue_id !== venueId) { plusReason(reasons, 'candidate_refund_identity_invalid'); continue; }
    if (instantMicros(order.created_at) >= activationMicros && !facts.refundEvents.some(event => event.refund_id === order.id)) plusReason(reasons, 'post_epoch_refund_recognition_missing');
  }
  const selectedRefundEventsForLineage = facts.refundEvents.filter(row => row.recognized_local_date === null || eventIsInPeriod(row, from, to));
  const candidateClosedOrderIds = new Set(facts.candidateOrders.filter(order => order.venue_id === venueId && order.status === 'closed').map(order => order.id));
  const selectedRefundOrders = new Set(selectedRefundEventsForLineage.map(row => row.order_id));
  const selectedOriginalSaleIds = new Set(selectedRefundEventsForLineage.map(row => row.original_sale_event_id).filter(Boolean));
  const relevantSales = facts.saleEvents.filter(row => row.recognized_local_date === null || eventIsInPeriod(row, from, to)
    || selectedRefundOrders.has(row.order_id) || selectedOriginalSaleIds.has(row.id));
  if (facts.saleEvents.some(row => row.recognized_local_date === null)) plusReason(reasons, 'unassignable_sale_recognition_present');
  for (const row of facts.saleEvents) if (row.recognized_local_date !== null && !dateValid(row.recognized_local_date)) plusReason(reasons, 'sale_recognition_date_invalid');
  const saleManifestLines = [];
  for (const sale of relevantSales) saleManifestLines.push(...validateSale(sale, readFacts, venueId, currency, reasons));
  const sales = relevantSales.filter(row => eventIsInPeriod(row, from, to)).map(row => ({
    eventId: row.id, venueId: row.venue_id, orderId: row.order_id, snapshotId: row.snapshot_id,
    policyVersion: row.policy_version, recognizedAt: row.recognized_at, timezoneSnapshot: row.timezone_snapshot,
    recognizedLocalDate: row.recognized_local_date, sourceClosedAt: row.source_closed_at,
    currency: row.currency_code, coverageStatus: row.coverage_status, lines: saleManifestLines.filter(line => line.saleEventId === row.id)
  }));
  const periodSalesById = new Map(sales.map(row => [row.eventId, row]));
  const closedOrderSales = facts.saleEvents.filter(row => candidateClosedOrderIds.has(row.order_id)).map(row => {
    const periodSale = periodSalesById.get(row.id);
    if (periodSale) return periodSale;
    const localReasons = new Set();
    const lines = validateSale(row, readFacts, venueId, currency, localReasons);
    return { eventId: row.id, venueId: row.venue_id, orderId: row.order_id, snapshotId: row.snapshot_id,
      policyVersion: row.policy_version, recognizedAt: row.recognized_at, timezoneSnapshot: row.timezone_snapshot,
      recognizedLocalDate: row.recognized_local_date, sourceClosedAt: row.source_closed_at,
      currency: row.currency_code, coverageStatus: localReasons.size ? 'incomplete' : row.coverage_status,
      reasons: [...localReasons].sort(), lines };
  });

  const refundEventById = new Map(facts.refundEvents.map(row => [row.id, row]));
  const refundEventByRefundId = new Map();
  for (const event of facts.refundEvents) {
    if (refundEventByRefundId.has(event.refund_id)) plusReason(reasons, 'duplicate_refund_recognition');
    refundEventByRefundId.set(event.refund_id, event);
  }
  const periodSaleOrderIds = [...new Set(sales.map(event => event.orderId))].sort();
  const periodRefundOrderIds = facts.refundEvents.filter(event => event.recognized_local_date === null
    || eventIsInPeriod(event, from, to)).map(event => event.order_id);
  const candidateRefundOrderIds = facts.candidateRefunds.map(row => row.order_id);
  const coveredOrderIds = [...new Set([...periodSaleOrderIds, ...periodRefundOrderIds, ...candidateRefundOrderIds])].sort();
  const coveredOrderIdSet = new Set(coveredOrderIds);
  const coveredRefundEvents = facts.refundEvents.filter(event => coveredOrderIdSet.has(event.order_id));
  const linkedRefundHeaderIds = new Set();
  const relatedRefundHeaderById = new Map();
  for (const header of facts.relatedRefundHeaders) {
    if (!header || !UUID.test(String(header.id || '')) || header.venue_id !== venueId
        || !UUID.test(String(header.order_id || '')) || !coveredOrderIdSet.has(header.order_id)
        || !ordersById.has(header.order_id) || ordersById.get(header.order_id)?.venue_id !== venueId || !timestampValid(header.created_at)) {
      plusReason(reasons, 'related_refund_header_invalid');
      continue;
    }
    if (linkedRefundHeaderIds.has(header.id)) plusReason(reasons, 'related_refund_header_duplicate');
    linkedRefundHeaderIds.add(header.id);
    relatedRefundHeaderById.set(header.id, header);
    const event = refundEventByRefundId.get(header.id);
    if (!event || event.refund_id !== header.id || event.order_id !== header.order_id || event.venue_id !== venueId) {
      plusReason(reasons, 'related_refund_recognition_missing');
    }
  }
  for (const event of coveredRefundEvents) {
    if (!linkedRefundHeaderIds.has(event.refund_id)) plusReason(reasons, 'related_refund_header_missing');
  }
  const detailedRefundItemIds = new Set(facts.refundItems.map(item => item.id));
  const relatedRefundItemIds = new Set();
  for (const item of facts.relatedRefundItems) {
    if (!item || !UUID.test(String(item.id || '')) || !UUID.test(String(item.refund_id || ''))
        || !UUID.test(String(item.order_id || '')) || item.venue_id !== venueId || !coveredOrderIdSet.has(item.order_id)
        || !ordersById.has(item.order_id) || ordersById.get(item.order_id)?.venue_id !== venueId) {
      plusReason(reasons, 'related_refund_item_invalid');
      continue;
    }
    if (relatedRefundItemIds.has(item.id)) plusReason(reasons, 'related_refund_item_duplicate');
    relatedRefundItemIds.add(item.id);
    const header = relatedRefundHeaderById.get(item.refund_id);
    if (!header || header.order_id !== item.order_id) plusReason(reasons, 'related_refund_item_header_mismatch');
    if (!detailedRefundItemIds.has(item.id)) plusReason(reasons, 'related_refund_item_history_missing');
  }
  for (const item of facts.refundItems) {
    if (coveredOrderIdSet.has(item.order_id) && !relatedRefundItemIds.has(item.id)) plusReason(reasons, 'related_refund_item_attestation_missing');
  }
  const saleEventById = new Map(facts.saleEvents.map(row => [row.id, row]));
  const rawHeaderById = new Map(facts.refundHeaders.map(row => [row.id, row]));
  const refundLineByItem = new Map();
  for (const row of facts.refundLines) {
    if (refundLineByItem.has(row.refund_item_id)) plusReason(reasons, 'refund_line_event_duplicate');
    refundLineByItem.set(row.refund_item_id, row);
  }
  const tenderTotalByRefund = new Map(facts.refundTenders.map(row => [row.refund_id, row.tender_total_minor]));
  // The discovery window can include a neighbouring sale whose later refund
  // is outside this period too. All loaded refund history is validated below,
  // so its originals need the same validation without entering period totals.
  const historyOriginalIds = new Set(facts.refundEvents.map(row => row.original_sale_event_id));
  const historyOrderIds = new Set(facts.refundEvents.map(row => row.order_id));
  const relevantSaleIds = new Set(relevantSales.map(row => row.id));
  const historySaleLines = facts.saleEvents.filter(row => !relevantSaleIds.has(row.id)
    && (historyOriginalIds.has(row.id) || historyOrderIds.has(row.order_id)))
    .flatMap(row => validateSale(row, readFacts, venueId, currency, reasons));
  const saleLineByIdentity = new Map([...saleManifestLines, ...historySaleLines]
    .map(line => [`${line.orderId}/${line.orderItemId}`, line]));
  const refundItemsByItem = new Map(), refundEventsByItem = new Map();
  for (const row of facts.refundItems) { const key = `${row.order_id}/${row.order_item_id}`; if (!refundItemsByItem.has(key)) refundItemsByItem.set(key, []); refundItemsByItem.get(key).push(row); }
  for (const row of facts.refundLines) { const key = `${row.order_id}/${row.order_item_id}`; if (!refundEventsByItem.has(key)) refundEventsByItem.set(key, []); refundEventsByItem.get(key).push(row); }
  const relevantRefundEvents = facts.refundEvents.filter(row => row.recognized_local_date === null || eventIsInPeriod(row, from, to));
  if (facts.refundEvents.some(row => row.recognized_local_date === null)) plusReason(reasons, 'unassignable_refund_recognition_present');
  for (const row of facts.refundEvents) if (row.recognized_local_date !== null && !dateValid(row.recognized_local_date)) plusReason(reasons, 'refund_recognition_date_invalid');
  // All refund events for a linked order participate in full 092 history,
  // including events recognized outside this payroll period. Validate their
  // immutable coverage and payout lineage too; a broken prior event must not
  // silently influence a later cumulative merchandise return.
  for (const evt of facts.refundEvents) {
    if (evt.venue_id !== venueId || evt.policy_version !== 1 || evt.currency_code !== currency) plusReason(reasons, 'refund_identity_or_currency_invalid');
    if (evt.coverage_status !== 'complete' || !Array.isArray(evt.coverage_reasons) || evt.coverage_reasons.length) plusReason(reasons, 'refund_source_coverage_incomplete');
    if (evt.recognized_local_date === null || evt.timezone_snapshot === null) plusReason(reasons, 'refund_recognition_date_unassignable');
    else {
      try { if (localDateAt(evt.recognized_at, evt.timezone_snapshot) !== evt.recognized_local_date) plusReason(reasons, 'refund_recognition_date_mismatch'); }
      catch (_) { plusReason(reasons, 'refund_recognition_date_invalid'); }
    }
    const header = rawHeaderById.get(evt.refund_id);
    if (!header || header.venue_id !== venueId || header.order_id !== evt.order_id || header.id !== evt.refund_id
        || header.item_attribution_status !== evt.item_attribution_status || header.recognition_policy_version !== 1
        || header.payroll_recognized_at !== evt.recognized_at || header.payroll_timezone_snapshot !== evt.timezone_snapshot
        || header.payroll_recognized_local_date !== evt.recognized_local_date) plusReason(reasons, 'refund_header_lineage_mismatch');
    const payout = minorText(String(evt.payout_minor), { positive: true }), tender = minorText(String(evt.tender_total_minor));
    const observedTender = tenderTotalByRefund.get(evt.refund_id);
    if (payout !== tender || observedTender === undefined || minorText(String(observedTender)) !== payout
        || (header && minorText(String(header.payout_minor), { positive: true }) !== payout)) plusReason(reasons, 'refund_tender_conservation_mismatch');
    const originalSale = saleEventById.get(evt.original_sale_event_id);
    if (!originalSale || originalSale.order_id !== evt.order_id || originalSale.coverage_status !== 'complete') plusReason(reasons, 'refund_original_sale_event_invalid');
    if (!['complete', 'unattributed', 'not_applicable'].includes(evt.item_attribution_status)) plusReason(reasons, 'refund_item_classification_invalid');
    const lines = facts.refundLines.filter(line => line.refund_event_id === evt.id);
    if (evt.item_attribution_status === 'complete' && !lines.length) plusReason(reasons, 'refund_item_attribution_empty');
    if (evt.item_attribution_status === 'unattributed') plusReason(reasons, 'refund_item_attribution_unknown');
    if (evt.item_attribution_status === 'not_applicable' && lines.length) plusReason(reasons, 'refund_item_attribution_unexpected');
    for (const line of lines) {
      const original = saleLineByIdentity.get(`${line.order_id}/${line.order_item_id}`);
      const item = facts.refundItems.find(row => row.id === line.refund_item_id);
      if (!original || !item || line.original_sale_line_event_id !== original.saleLineEventId
          || line.venue_id !== venueId || item.venue_id !== venueId || line.snapshot_id !== original.snapshotId
          || item.snapshot_id !== line.snapshot_id) plusReason(reasons, 'refund_original_sale_line_missing');
      else {
        const historyKey = `${line.order_id}/${line.order_item_id}`;
        const rawHistory = refundItemsByItem.get(historyKey) || [], eventHistory = refundEventsByItem.get(historyKey) || [];
        const sourceLine = readFacts.pricingLinesByOrder.get(line.order_id)?.find(row => row.order_item_id === line.order_item_id);
        if (!sourceLine || sourceLine.seller_id !== original.sellerId) plusReason(reasons, 'refund_original_seller_mismatch');
        else validateReturnHistory({ ...sourceLine, venue_id: venueId }, rawHistory, eventHistory, refundEventById, rawHeaderById, reasons);
      }
    }
  }
  for (const item of facts.refundItems) {
    if (!refundEventByRefundId.has(item.refund_id) || !refundLineByItem.has(item.id)) plusReason(reasons, 'refund_history_recognition_missing');
  }
  const refunds = relevantRefundEvents.filter(row => eventIsInPeriod(row, from, to)).map(row => ({
    eventId: row.id, refundId: row.refund_id, orderId: row.order_id, originalSaleEventId: row.original_sale_event_id,
    policyVersion: row.policy_version, recognizedAt: row.recognized_at, timezoneSnapshot: row.timezone_snapshot,
    recognizedLocalDate: row.recognized_local_date, currency: row.currency_code,
    itemAttributionStatus: row.item_attribution_status, payoutMinor: Number(row.payout_minor), tenderTotalMinor: Number(row.tender_total_minor),
    // The two monetary facts deliberately remain separate: payout may include non-merchandise tender.
    lines: facts.refundLines.filter(line => line.refund_event_id === row.id).map(line => ({
      refundItemId: line.refund_item_id, orderItemId: line.order_item_id,
      originalSaleLineEventId: line.original_sale_line_event_id, producerSequence: line.producer_sequence,
      returnedQuantity: line.returned_quantity, returnedItemValueMinor: Number(line.returned_item_value_minor)
    }))
  }));
  const canonicalFacts = {
    schemaVersion: 1, epoch, venueId, currency, period: { from, to },
    saleEvents: sorted(relevantSales), saleLines: sorted(facts.saleLines), orders: sorted(facts.orders),
    pricingHeaders: sorted(facts.pricingHeaders), pricingLines: sorted(facts.pricingLines), orderItems: sorted(facts.orderItems),
    candidateOrders: sorted(facts.candidateOrders), refundEvents: sorted(facts.refundEvents), refundLines: sorted(facts.refundLines),
    refundHeaders: sorted(facts.refundHeaders), refundItems: sorted(facts.refundItems), refundTenders: sorted(facts.refundTenders),
    candidateRefunds: sorted(facts.candidateRefunds)
  };
  const refundHistory = [...refundItemsByItem.entries()].map(([key, rows]) => {
    const [orderId, orderItemId] = key.split('/'), original = saleLineByIdentity.get(key);
    if (!original) { plusReason(reasons, 'refund_history_original_sale_missing'); return { orderId, orderItemId, complete: false }; }
    const summary = validateReturnHistory({ ...original, venue_id: venueId }, rows, refundEventsByItem.get(key) || [], refundEventById, rawHeaderById, reasons);
    return { orderId, orderItemId, originalSaleLineEventId: original.saleLineEventId,
      cumulativeReturnedQuantity: summary.quantity, cumulativeReturnedItemValueMinor: summary.valueMinor };
  });
  const relatedRefundCoverageFacts = {
    schemaVersion: 1,
    scope: 'all_recorded_refunds_for_payroll_related_orders_as_of_repeatable_read_snapshot',
    periodSaleOrderIds,
    coveredOrderIds,
    relatedRefundHeaderIds: [...linkedRefundHeaderIds].sort(),
    relatedRefundEventIds: [...new Set(coveredRefundEvents.map(event => event.id))].sort(),
    relatedRefundItemIds: [...relatedRefundItemIds].sort(),
    relatedRefundLineEventIds: [...new Set(facts.refundLines.filter(line => coveredOrderIdSet.has(line.order_id)).map(line => line.id))].sort()
  };
  const relatedRefundCoverage = {
    ...relatedRefundCoverageFacts,
    status: 'incomplete',
    sourceWatermark: null
  };
  const periodRefundSaleLineIds = new Set(refunds.flatMap(event => event.lines.map(line => line.originalSaleLineEventId)));
  const periodSaleEventIds = new Set(sales.map(event => event.eventId));
  const saleEventByLine = new Map(relevantSales.map(event => [event.id, event]));
  const historyBySaleLine = new Map(refundHistory.filter(row => row.originalSaleLineEventId)
    .map(row => [row.originalSaleLineEventId, row]));
  const refundOriginalSaleAttributions = saleManifestLines
    .filter(line => periodRefundSaleLineIds.has(line.saleLineEventId) && !periodSaleEventIds.has(line.saleEventId))
    .map(line => {
      const event = saleEventByLine.get(line.saleEventId), history = historyBySaleLine.get(line.saleLineEventId);
      if (!event || !history) { plusReason(reasons, 'refund_original_sale_attribution_missing'); return null; }
      return { saleEventId: line.saleEventId, saleLineEventId: line.saleLineEventId, venueId: line.venueId,
        orderId: line.orderId, snapshotId: line.snapshotId, orderItemId: line.orderItemId,
        sellerId: line.sellerId, eligibilityStatus: line.eligibilityStatus, eligibilityVenueId: line.eligibilityVenueId,
        employeeVenueId: line.employeeVenueId, attributionPolicyVersion: line.attributionPolicyVersion,
        recognizedAt: event.recognized_at, recognizedLocalDate: event.recognized_local_date,
        timezoneSnapshot: event.timezone_snapshot, currency: event.currency_code,
        productFacts: structuredClone(line.productFacts),
        grossMinor: line.grossMinor, discountMinor: line.discountMinor, netMinor: line.netMinor,
        cumulativeReturnedQuantity: history.cumulativeReturnedQuantity,
        cumulativeReturnedItemValueMinor: history.cumulativeReturnedItemValueMinor };
    }).filter(Boolean).sort((a, b) => a.saleLineEventId.localeCompare(b.saleLineEventId, 'en'));
  canonicalFacts.refundOriginalSaleAttributions = refundOriginalSaleAttributions;
  canonicalFacts.relatedRefundCoverage = relatedRefundCoverageFacts;
  canonicalFacts.relatedRefundHeaders = sorted(facts.relatedRefundHeaders);
  canonicalFacts.relatedRefundItems = sorted(facts.relatedRefundItems);
  const watermark = digest(canonicalFacts);
  relatedRefundCoverage.status = reasons.size ? 'incomplete' : 'complete';
  relatedRefundCoverage.sourceWatermark = watermark;
  return { schemaVersion: 1, status: reasons.size ? 'incomplete' : 'available', officialReady: false, venueId, currency,
    period: { from, to }, epoch: { activationScope: epoch.activation_scope, activatedAt: epoch.activated_at, policyVersion: epoch.policy_version },
    reasons: [...reasons].sort(), saleEvents: sales, sales,
    saleLines: saleManifestLines.filter(line => sales.some(sale => sale.eventId === line.saleEventId)), closedOrderSales,
    refundEvents: refunds, refunds, refundOriginalSaleAttributions, refundHistory, relatedRefundCoverage,
    watermark, watermarkScope: 'epoch_and_immutable_recognition_with_all_related_refund_headers_and_items_v3' };
};

const ts = column => `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const REQUIRED_RECOGNITION_COLUMNS = Object.freeze([
  'pos_payroll_recognition_epochs.venue_id','pos_payroll_recognition_epochs.policy_version','pos_payroll_recognition_epochs.activated_at',
  'pos_payroll_recognition_epochs.activation_scope','pos_payroll_recognition_epochs.timezone_snapshot','pos_payroll_recognition_epochs.activated_local_date',
  'orders.id','orders.venue_id','orders.status','orders.closed_at','orders.pricing_locked_at',
  'order_refunds.id','order_refunds.venue_id','order_refunds.order_id','order_refunds.created_at','order_refunds.amount','order_refunds.item_attribution_status',
  'order_refunds.payroll_recognition_policy_version','order_refunds.payroll_recognized_at','order_refunds.payroll_timezone_snapshot','order_refunds.payroll_recognized_local_date',
  'pos_payroll_sale_events.id','pos_payroll_sale_events.venue_id','pos_payroll_sale_events.order_id','pos_payroll_sale_events.snapshot_id','pos_payroll_sale_events.policy_version',
  'pos_payroll_sale_events.recognized_at','pos_payroll_sale_events.timezone_snapshot','pos_payroll_sale_events.recognized_local_date','pos_payroll_sale_events.source_closed_at',
  'pos_payroll_sale_events.currency_code','pos_payroll_sale_events.coverage_status','pos_payroll_sale_events.coverage_reasons',
  'pos_payroll_refund_events.id','pos_payroll_refund_events.venue_id','pos_payroll_refund_events.refund_id','pos_payroll_refund_events.order_id',
  'pos_payroll_refund_events.original_sale_event_id','pos_payroll_refund_events.policy_version','pos_payroll_refund_events.recognized_at',
  'pos_payroll_refund_events.timezone_snapshot','pos_payroll_refund_events.recognized_local_date','pos_payroll_refund_events.currency_code',
  'pos_payroll_refund_events.item_attribution_status','pos_payroll_refund_events.payout_minor','pos_payroll_refund_events.tender_total_minor',
  'pos_payroll_refund_events.coverage_status','pos_payroll_refund_events.coverage_reasons',
  'pos_order_pricing_snapshots.id','pos_order_pricing_snapshots.venue_id','pos_order_pricing_snapshots.order_id','pos_order_pricing_snapshots.schema_version',
  'pos_order_pricing_snapshots.policy_version','pos_order_pricing_snapshots.currency_code','pos_order_pricing_snapshots.currency_scale','pos_order_pricing_snapshots.sold_at',
  'pos_order_pricing_snapshots.transaction_at','pos_order_pricing_snapshots.subtotal_minor','pos_order_pricing_snapshots.discount_minor',
  'pos_order_pricing_snapshots.minimum_adjustment_minor','pos_order_pricing_snapshots.final_total_minor','pos_order_pricing_snapshots.discount_source',
  'pos_order_pricing_snapshots.winner_source_id','pos_order_pricing_snapshots.winner_source_ids','pos_order_pricing_snapshots.winner_terms',
  'pos_order_pricing_snapshots.eligible_item_ids','pos_order_pricing_snapshots.frozen_terms',
  'pos_order_pricing_snapshot_lines.id','pos_order_pricing_snapshot_lines.venue_id','pos_order_pricing_snapshot_lines.snapshot_id',
  'pos_order_pricing_snapshot_lines.order_id','pos_order_pricing_snapshot_lines.order_item_id','pos_order_pricing_snapshot_lines.seller_id',
  'pos_order_pricing_snapshot_lines.sold_at','pos_order_pricing_snapshot_lines.quantity','pos_order_pricing_snapshot_lines.unit_price',
  'pos_order_pricing_snapshot_lines.gross_minor','pos_order_pricing_snapshot_lines.discount_minor','pos_order_pricing_snapshot_lines.net_minor',
  'pos_order_pricing_snapshot_lines.eligible','pos_order_pricing_snapshot_lines.product_facts',
  'pos_payroll_sale_line_events.id','pos_payroll_sale_line_events.venue_id','pos_payroll_sale_line_events.sale_event_id','pos_payroll_sale_line_events.snapshot_id',
  'pos_payroll_sale_line_events.order_id','pos_payroll_sale_line_events.order_item_id','pos_payroll_sale_line_events.pricing_line_id','pos_payroll_sale_line_events.seller_id',
  'pos_payroll_sale_line_events.sold_at','pos_payroll_sale_line_events.attribution_captured_at','pos_payroll_sale_line_events.attribution_policy_version',
  'pos_payroll_sale_line_events.eligibility_status','pos_payroll_sale_line_events.eligibility_venue_id','pos_payroll_sale_line_events.employee_venue_id',
  'pos_payroll_refund_line_events.id','pos_payroll_refund_line_events.venue_id','pos_payroll_refund_line_events.refund_event_id','pos_payroll_refund_line_events.refund_item_id',
  'pos_payroll_refund_line_events.order_id','pos_payroll_refund_line_events.snapshot_id','pos_payroll_refund_line_events.order_item_id','pos_payroll_refund_line_events.original_sale_line_event_id',
  'pos_payroll_refund_line_events.producer_sequence','pos_payroll_refund_line_events.previous_returned_quantity','pos_payroll_refund_line_events.returned_quantity',
  'pos_payroll_refund_line_events.cumulative_returned_quantity','pos_payroll_refund_line_events.previous_returned_item_value_minor',
  'pos_payroll_refund_line_events.returned_item_value_minor','pos_payroll_refund_line_events.cumulative_returned_item_value_minor',
  'order_refund_items.id','order_refund_items.venue_id','order_refund_items.refund_id','order_refund_items.order_id','order_refund_items.snapshot_id',
  'order_refund_items.order_item_id','order_refund_items.returned_quantity','order_refund_items.returned_item_value_minor','order_refund_items.producer_sequence',
  'order_refund_items.previous_returned_quantity','order_refund_items.cumulative_returned_quantity','order_refund_items.previous_returned_item_value_minor',
  'order_refund_items.cumulative_returned_item_value_minor','order_refund_items.return_policy_version','order_refund_items.created_at',
  'order_refund_tenders.venue_id','order_refund_tenders.refund_id','order_refund_tenders.amount',
  'order_items.id','order_items.order_id','users.id','users.venue_id','users.organization_id','venues.id','venues.organization_id',
  'organization_memberships.organization_id','organization_memberships.user_id','organization_memberships.status'
]);
const unsupportedSchema = ({ venueId, currency, from, to }) => ({ schemaVersion: 1, status: 'unsupported', officialReady: false,
  venueId, currency, period: { from, to }, reasons: ['recognition_source_schema_missing'], saleEvents: [], sales: [], saleLines: [],
  refundEvents: [], refunds: [], refundOriginalSaleAttributions: [], refundHistory: [], relatedRefundCoverage: null,
  watermark: null, watermarkScope: null });
const readRecognitionEvidence = async (db, options, includeFacts) => {
  if (!db || typeof db.query !== 'function' || !plain(options)) fail('transaction_required');
  const guard = `payroll_manifest_${randomBytes(8).toString('hex')}`;
  await db.query(`SAVEPOINT ${guard}`);
  try {
    const isolation = (await db.query('SHOW transaction_isolation')).rows?.[0]?.transaction_isolation;
    const readOnly = (await db.query('SHOW transaction_read_only')).rows?.[0]?.transaction_read_only;
    if (isolation !== 'repeatable read' || (readOnly !== 'on'
        && !(readOnly === 'off' && hasPayrollVerifiedWriteSnapshot(db, options.venueId)))) fail('repeatable_read_read_only_required');
    const { venueId, from, to, currency = 'RUB' } = options;
    uuid(venueId); isoDate(from); isoDate(to);
    const capability = (await db.query(`WITH required AS (
        SELECT split_part(item,'.',1) AS table_name,split_part(item,'.',2) AS column_name
        FROM unnest($1::text[]) AS req(item)
      )
      SELECT count(*) FILTER (WHERE a.attnum IS NULL)::int AS missing_count
      FROM required r LEFT JOIN pg_class c ON c.oid=to_regclass(r.table_name)
      LEFT JOIN pg_attribute a ON a.attrelid=c.oid AND a.attname=r.column_name AND NOT a.attisdropped`, [REQUIRED_RECOGNITION_COLUMNS])).rows[0];
    if (Number(capability?.missing_count) > 0) {
      const manifest = unsupportedSchema({ venueId, currency, from, to });
      return includeFacts ? { manifest, facts: null } : manifest;
    }
    const epoch = (await db.query(`SELECT venue_id::text,policy_version,${ts('activated_at')} AS activated_at,activation_scope,timezone_snapshot,activated_local_date::text
      FROM pos_payroll_recognition_epochs WHERE venue_id=$1`, [venueId])).rows[0] || null;
    const params = [venueId, from, to];
    const candidateOrders = (await db.query(`SELECT id::text,venue_id::text,status,${ts('closed_at')} AS closed_at FROM orders
      WHERE venue_id=$1 AND status='closed' AND (closed_at IS NULL OR (closed_at>=($2::date::timestamp AT TIME ZONE 'UTC')-interval '24 hours'
      AND closed_at<(($3::date+1)::timestamp AT TIME ZONE 'UTC')+interval '24 hours')) ORDER BY id`, params)).rows;
    const candidateRefunds = (await db.query(`SELECT id::text,venue_id::text,order_id::text,${ts('created_at')} AS created_at FROM order_refunds
      WHERE venue_id=$1 AND created_at>=($2::date::timestamp AT TIME ZONE 'UTC')-interval '24 hours'
      AND created_at<(($3::date+1)::timestamp AT TIME ZONE 'UTC')+interval '24 hours' ORDER BY id`, params)).rows;
    const candidateOrderIds = [...new Set([...candidateOrders.map(row => row.id), ...candidateRefunds.map(row => row.order_id)])].sort();
    const saleEvents = (await db.query(`SELECT id::text,venue_id::text,order_id::text,snapshot_id::text,policy_version,${ts('recognized_at')} AS recognized_at,
      timezone_snapshot,recognized_local_date::text,${ts('source_closed_at')} AS source_closed_at,currency_code,coverage_status,coverage_reasons
      FROM pos_payroll_sale_events WHERE venue_id=$1 AND (recognized_local_date BETWEEN $2::date AND $3::date OR recognized_local_date IS NULL OR order_id=ANY($4::uuid[]))
      ORDER BY recognized_local_date NULLS FIRST,id`, [...params, candidateOrderIds])).rows;
    const linkedOrderIds = [...new Set([...candidateOrderIds, ...saleEvents.map(row => row.order_id)])].sort();
    const relevantRefundEvents = (await db.query(`SELECT id::text,venue_id::text,refund_id::text,order_id::text,original_sale_event_id::text,policy_version,
      ${ts('recognized_at')} AS recognized_at,timezone_snapshot,recognized_local_date::text,currency_code,item_attribution_status,payout_minor::text,tender_total_minor::text,coverage_status,coverage_reasons
      FROM pos_payroll_refund_events WHERE venue_id=$1 AND (recognized_local_date BETWEEN $2::date AND $3::date OR recognized_local_date IS NULL OR order_id=ANY($4::uuid[]))
      ORDER BY recognized_local_date NULLS FIRST,order_id,id`, [...params, linkedOrderIds])).rows;
    const coverageOrderIds = [...new Set([
      ...saleEvents.filter(row => eventIsInPeriod(row, from, to)).map(row => row.order_id),
      ...relevantRefundEvents.filter(row => row.recognized_local_date === null || eventIsInPeriod(row, from, to)).map(row => row.order_id),
      ...candidateRefunds.map(row => row.order_id)
    ])].sort();
    const relatedRefundHeaders = coverageOrderIds.length ? (await db.query(`SELECT id::text,venue_id::text,order_id::text,
      ${ts('created_at')} AS created_at FROM order_refunds WHERE venue_id=$1 AND order_id=ANY($2::uuid[]) ORDER BY order_id,id`,
    [venueId, coverageOrderIds])).rows : [];
    const relatedRefundItems = coverageOrderIds.length ? (await db.query(`SELECT id::text,venue_id::text,refund_id::text,order_id::text
      FROM order_refund_items WHERE venue_id=$1 AND order_id=ANY($2::uuid[]) ORDER BY order_id,refund_id,id`,
    [venueId, coverageOrderIds])).rows : [];
    const relevantOrderIds = [...new Set([...linkedOrderIds, ...relevantRefundEvents.map(row => row.order_id)])].sort();
    const orders = (await db.query(`SELECT id::text,venue_id::text,${ts('closed_at')} AS closed_at,${ts('pricing_locked_at')} AS pricing_locked_at,status FROM orders WHERE venue_id=$1 AND id=ANY($2::uuid[]) ORDER BY id`, [venueId, relevantOrderIds])).rows;
    const pricingHeaders = (await db.query(`SELECT s.*,${ts('s.transaction_at')} AS transaction_at FROM pos_order_pricing_snapshots s WHERE s.venue_id=$1 AND s.order_id=ANY($2::uuid[]) ORDER BY s.order_id`, [venueId, relevantOrderIds])).rows;
    const pricingLines = (await db.query(`SELECT l.*,l.quantity::text AS quantity,l.unit_price::text AS unit_price,${ts('l.sold_at')} AS sold_at,
      EXISTS(SELECT 1 FROM users u WHERE u.id=l.seller_id AND u.venue_id=l.venue_id) AS seller_in_venue,
      EXISTS(SELECT 1 FROM users u JOIN venues v ON v.id=l.venue_id WHERE u.id=l.seller_id AND v.organization_id IS NOT NULL
        AND (u.organization_id=v.organization_id OR EXISTS(SELECT 1 FROM organization_memberships m WHERE m.organization_id=v.organization_id AND m.user_id=u.id AND m.status='active'))) AS seller_in_organization
      FROM pos_order_pricing_snapshot_lines l WHERE l.venue_id=$1 AND l.order_id=ANY($2::uuid[]) ORDER BY l.order_id,l.order_item_id`, [venueId, relevantOrderIds])).rows;
    const orderItems = (await db.query(`SELECT oi.id::text,oi.order_id::text FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE o.venue_id=$1 AND o.id=ANY($2::uuid[]) ORDER BY oi.order_id,oi.id`, [venueId, relevantOrderIds])).rows;
    const saleEventIds = [...new Set(saleEvents.filter(row => relevantOrderIds.includes(row.order_id)).map(row => row.id))];
    const saleLines = (await db.query(`SELECT id::text,venue_id::text,sale_event_id::text,snapshot_id::text,order_id::text,order_item_id::text,pricing_line_id::text,
      seller_id::text,${ts('sold_at')} AS sold_at,${ts('attribution_captured_at')} AS attribution_captured_at,attribution_policy_version,
      eligibility_status,eligibility_venue_id::text,employee_venue_id::text FROM pos_payroll_sale_line_events
      WHERE venue_id=$1 AND sale_event_id=ANY($2::uuid[]) ORDER BY sale_event_id,order_item_id,id`, [venueId, saleEventIds])).rows;
    const refundIds = [...new Set(relevantRefundEvents.map(row => row.refund_id))];
    const refundHeaders = (await db.query(`SELECT r.id::text,r.venue_id::text,r.order_id::text,r.item_attribution_status,
      r.payroll_recognition_policy_version AS recognition_policy_version,${ts('r.payroll_recognized_at')} AS payroll_recognized_at,
      r.payroll_timezone_snapshot, r.payroll_recognized_local_date::text, (r.amount*100)::bigint::text AS payout_minor
      FROM order_refunds r WHERE r.venue_id=$1 AND r.id=ANY($2::uuid[]) ORDER BY r.id`, [venueId, refundIds])).rows;
    const refundTenders = (await db.query(`SELECT t.refund_id::text,COALESCE(round(sum(t.amount)*100),0)::bigint::text AS tender_total_minor
      FROM order_refund_tenders t WHERE t.venue_id=$1 AND t.refund_id=ANY($2::uuid[]) GROUP BY t.refund_id ORDER BY t.refund_id`, [venueId, refundIds])).rows;
    const refundEventIds = [...new Set(relevantRefundEvents.map(row => row.id))];
    const refundLines = (await db.query(`SELECT id::text,venue_id::text,refund_event_id::text,refund_item_id::text,order_id::text,snapshot_id::text,order_item_id::text,
      original_sale_line_event_id::text,producer_sequence::text,previous_returned_quantity::text,returned_quantity::text,cumulative_returned_quantity::text,
      previous_returned_item_value_minor::text,returned_item_value_minor::text,cumulative_returned_item_value_minor::text
      FROM pos_payroll_refund_line_events WHERE venue_id=$1 AND refund_event_id=ANY($2::uuid[]) ORDER BY order_id,order_item_id,producer_sequence NULLS FIRST,id`, [venueId, refundEventIds])).rows;
    const returnedItemIds = [...new Set(refundLines.map(row => row.order_item_id))];
    const refundItems = (await db.query(`SELECT i.id::text,i.venue_id::text,i.refund_id::text,i.order_id::text,i.snapshot_id::text,i.order_item_id::text,
      i.returned_quantity::text,i.returned_item_value_minor::text,i.producer_sequence::text,i.previous_returned_quantity::text,
      i.cumulative_returned_quantity::text,i.previous_returned_item_value_minor::text,i.cumulative_returned_item_value_minor::text
      FROM order_refund_items i WHERE i.venue_id=$1 AND (i.order_item_id=ANY($2::uuid[]) OR i.refund_id=ANY($3::uuid[]))
      ORDER BY i.order_id,i.order_item_id,i.producer_sequence NULLS FIRST,i.id`, [venueId, returnedItemIds, refundIds])).rows;
    const allHistoryRefundIds = [...new Set(refundItems.map(row => row.refund_id))];
    const extraEvents = allHistoryRefundIds.filter(id => !refundIds.includes(id));
    const extraRefundTenders = extraEvents.length ? (await db.query(`SELECT t.refund_id::text,COALESCE(round(sum(t.amount)*100),0)::bigint::text AS tender_total_minor
      FROM order_refund_tenders t WHERE t.venue_id=$1 AND t.refund_id=ANY($2::uuid[]) GROUP BY t.refund_id ORDER BY t.refund_id`, [venueId, extraEvents])).rows : [];
    const extraRefundEvents = extraEvents.length ? (await db.query(`SELECT id::text,venue_id::text,refund_id::text,order_id::text,original_sale_event_id::text,policy_version,
      ${ts('recognized_at')} AS recognized_at,timezone_snapshot,recognized_local_date::text,currency_code,item_attribution_status,payout_minor::text,tender_total_minor::text,coverage_status,coverage_reasons
      FROM pos_payroll_refund_events WHERE venue_id=$1 AND refund_id=ANY($2::uuid[]) ORDER BY id`, [venueId, extraEvents])).rows : [];
    const allRefundHeaders = extraEvents.length ? (await db.query(`SELECT r.id::text,r.venue_id::text,r.order_id::text,r.item_attribution_status,
      r.payroll_recognition_policy_version AS recognition_policy_version,${ts('r.payroll_recognized_at')} AS payroll_recognized_at,
      r.payroll_timezone_snapshot,r.payroll_recognized_local_date::text,(r.amount*100)::bigint::text AS payout_minor
      FROM order_refunds r WHERE r.venue_id=$1 AND r.id=ANY($2::uuid[]) ORDER BY r.id`, [venueId, extraEvents])).rows : [];
    const allRefundLines = extraEvents.length ? (await db.query(`SELECT id::text,venue_id::text,refund_event_id::text,refund_item_id::text,order_id::text,snapshot_id::text,order_item_id::text,
      original_sale_line_event_id::text,producer_sequence::text,previous_returned_quantity::text,returned_quantity::text,cumulative_returned_quantity::text,
      previous_returned_item_value_minor::text,returned_item_value_minor::text,cumulative_returned_item_value_minor::text
      FROM pos_payroll_refund_line_events WHERE venue_id=$1 AND refund_item_id=ANY($2::uuid[]) AND NOT(refund_event_id=ANY($3::uuid[]))
      ORDER BY order_id,order_item_id,producer_sequence NULLS FIRST,id`, [venueId, refundItems.map(row => row.id), refundEventIds])).rows : [];
    const historyOrderIds = [...new Set([...relevantOrderIds, ...refundItems.map(row => row.order_id)])].sort();
    const historySaleEvents = historyOrderIds.length ? (await db.query(`SELECT id::text,venue_id::text,order_id::text,snapshot_id::text,policy_version,${ts('recognized_at')} AS recognized_at,
      timezone_snapshot,recognized_local_date::text,${ts('source_closed_at')} AS source_closed_at,currency_code,coverage_status,coverage_reasons
      FROM pos_payroll_sale_events WHERE venue_id=$1 AND order_id=ANY($2::uuid[]) ORDER BY order_id,id`, [venueId, historyOrderIds])).rows : [];
    const historySaleIds = [...new Set(historySaleEvents.map(row => row.id))];
    const historySaleLines = historySaleIds.length ? (await db.query(`SELECT id::text,venue_id::text,sale_event_id::text,snapshot_id::text,order_id::text,order_item_id::text,pricing_line_id::text,
      seller_id::text,${ts('sold_at')} AS sold_at,${ts('attribution_captured_at')} AS attribution_captured_at,attribution_policy_version,eligibility_status,
      eligibility_venue_id::text,employee_venue_id::text FROM pos_payroll_sale_line_events WHERE venue_id=$1 AND sale_event_id=ANY($2::uuid[]) ORDER BY sale_event_id,order_item_id,id`, [venueId, historySaleIds])).rows : [];
    const historyRefundEvents = [...relevantRefundEvents, ...extraRefundEvents];
    const facts = { epoch, saleEvents: historySaleEvents, saleLines: historySaleLines, orders, pricingHeaders, pricingLines, orderItems,
      candidateOrders, refundEvents: historyRefundEvents, refundLines: [...refundLines, ...allRefundLines],
      refundHeaders: [...refundHeaders, ...allRefundHeaders], relatedRefundHeaders, relatedRefundItems, refundItems,
      refundTenders: [...refundTenders, ...extraRefundTenders], candidateRefunds };
    const manifest = buildPayrollRecognitionManifest(facts, { venueId, currency, from, to });
    return includeFacts ? { manifest, facts } : manifest;
  } catch (error) {
    try { await db.query(`ROLLBACK TO SAVEPOINT ${guard}`); } catch (_) { /* caller owns original transaction outcome */ }
    throw error;
  } finally {
    try { await db.query(`RELEASE SAVEPOINT ${guard}`); } catch (_) { /* release is best effort on an aborted caller transaction */ }
  }
};

const readPayrollRecognitionManifestInTransaction = (db, options) => readRecognitionEvidence(db, options, false);
// Additive server-only sidecar. Preserve the legacy manifest/hash and query
// cohort exactly; detailed facts are never added to the old public DTO.
const readPayrollRecognitionEvidenceInTransaction = (db, options) => {
  if (!db || !options || !hasPayrollVerifiedSourceSnapshot(db, options.venueId)) fail('verified_write_snapshot_required');
  return readRecognitionEvidence(db, options, true);
};
module.exports = { buildPayrollRecognitionManifest, readPayrollRecognitionManifestInTransaction,
  readPayrollRecognitionEvidenceInTransaction };
