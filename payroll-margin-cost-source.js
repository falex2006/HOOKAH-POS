'use strict';

// Pure consumer of verified producer reader results. Never accepts browser DTOs,
// reconstructs historical costs, or proves period coverage from cost epochs.
const { createHash } = require('node:crypto');
const { manifestHasCompleteNoRefundHistory } = require('./payroll-no-refund-coverage');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const money = value => Number.isSafeInteger(value) && value >= 0;
const quantity = value => {
  if (typeof value !== 'string' || !/^\d{1,15}(?:\.\d{1,6})?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  const scaled = BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, '0'));
  return scaled > 0n ? scaled : null;
};
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
  && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

function buildPayrollMarginCostSource({ venueId, currency, period, recognitionManifest: manifest, evidenceByOrder } = {}) {
  const reasons = new Set(), rows = [], producerWatermarks = [];
  const context = { schemaVersion: 1, venueId, currency, period: period && { from: period.from, to: period.to },
    candidateOnly: true, officialReady: false, refundAdjustedReady: false,
    watermarkScope: 'payroll_no_refund_sale_line_cost_v1' };
  const finish = () => {
    const complete = reasons.size === 0;
    const payload = { ...context, status: complete ? 'available' : 'incomplete', reasons: [...reasons].sort(),
      rows: complete ? rows.sort((a, b) => a.saleLineEventId.localeCompare(b.saleLineEventId)) : [],
      coverage: { complete, recognitionWatermark: manifest?.watermark || null,
        saleLineEventIds: complete ? rows.map(row => row.saleLineEventId).sort() : [],
        producerWatermarks: producerWatermarks.sort((a, b) => a.orderId.localeCompare(b.orderId)) } };
    return { ...payload, sourceWatermark: digest(payload) };
  };
  if (!UUID.test(venueId || '') || currency !== 'RUB' || !validDate(period?.from) || !validDate(period?.to)
      || period.from > period.to || period.from.slice(0, 7) !== period.to.slice(0, 7)) {
    reasons.add('payroll_margin_cost_context_invalid'); return finish();
  }
  if (manifest?.schemaVersion !== 1 || manifest.status !== 'available' || manifest.venueId !== venueId
      || manifest.currency !== currency || manifest.period?.from !== period.from || manifest.period?.to !== period.to
      || !HASH.test(manifest.watermark || '') || !Array.isArray(manifest.saleLines) || !Array.isArray(manifest.sales)
      || !Array.isArray(manifest.refundEvents) || manifest.refundEvents.length || !manifestHasCompleteNoRefundHistory(manifest)) {
    reasons.add('payroll_margin_cost_no_refund_coverage_unproven'); return finish();
  }
  if (!Array.isArray(evidenceByOrder) || manifest.saleLines.length > 20000 || evidenceByOrder.length > 20000) {
    reasons.add('payroll_margin_cost_evidence_invalid'); return finish();
  }
  const orders = new Map(), lineIds = new Set(), itemIds = new Set();
  for (const sale of manifest.sales) {
    if (!UUID.test(sale?.orderId || '') || !UUID.test(sale?.eventId || '') || orders.has(sale.orderId)) {
      reasons.add('payroll_margin_cost_sale_identity_invalid'); continue;
    }
    orders.set(sale.orderId, { eventId: sale.eventId, lines: new Map() });
  }
  for (const line of manifest.saleLines) {
    const order = orders.get(line?.orderId);
    if (!order || line.saleEventId !== order.eventId || line.venueId !== venueId
        || !UUID.test(line.saleLineEventId || '') || !UUID.test(line.orderItemId || '')
        || lineIds.has(line.saleLineEventId) || itemIds.has(line.orderItemId) || quantity(line.quantity) === null
        || !UUID.test(line.productFacts?.productId || '')) {
      reasons.add('payroll_margin_cost_line_identity_invalid'); continue;
    }
    lineIds.add(line.saleLineEventId); itemIds.add(line.orderItemId); order.lines.set(line.orderItemId, line);
  }
  const seenOrders = new Set();
  for (const evidence of evidenceByOrder) {
    const order = orders.get(evidence?.orderId);
    if (!order || seenOrders.has(evidence.orderId)) { reasons.add('payroll_margin_cost_order_coverage_mismatch'); continue; }
    seenOrders.add(evidence.orderId);
    if (evidence.status !== 'complete' || evidence.schemaVersion !== 1 || evidence.policyVersion !== 1
        || evidence.scope !== 'sale_depletion_cost' || evidence.venueId !== venueId || evidence.currency !== currency
        || evidence.valuationMethod !== 'ingredient_cost_at_depletion_v1' || evidence.refundAdjustedReady !== false
        || !HASH.test(evidence.watermark || '') || !money(evidence.totalCostMinor)
        || !Array.isArray(evidence.reasons) || evidence.reasons.length
        || evidence.allocation?.status !== 'complete' || evidence.allocation.totalCostMinor !== evidence.totalCostMinor
        || !Array.isArray(evidence.allocation.lines) || evidence.allocation.lines.length !== order.lines.size) {
      reasons.add('payroll_margin_cost_producer_incomplete'); continue;
    }
    producerWatermarks.push({ orderId: evidence.orderId, watermark: evidence.watermark });
    const seenItems = new Set(); let sum = 0n;
    for (const allocated of evidence.allocation.lines) {
      const line = order.lines.get(allocated?.orderItemId);
      if (!line || seenItems.has(allocated.orderItemId) || allocated.productId !== line.productFacts.productId
          || quantity(allocated.quantity) === null || quantity(allocated.quantity) !== quantity(line.quantity)
          || !money(allocated.totalCostMinor)) { reasons.add('payroll_margin_cost_line_binding_mismatch'); continue; }
      seenItems.add(allocated.orderItemId); sum += BigInt(allocated.totalCostMinor);
      rows.push({ saleLineEventId: line.saleLineEventId, orderId: line.orderId, orderItemId: line.orderItemId,
        productId: allocated.productId, quantity: line.quantity, producerWatermark: evidence.watermark,
        costSnapshot: { id: `${line.orderId}/${line.orderItemId}`, version: evidence.watermark,
          currency, costCents: allocated.totalCostMinor } });
    }
    if (seenItems.size !== order.lines.size || sum !== BigInt(evidence.totalCostMinor)) reasons.add('payroll_margin_cost_total_mismatch');
  }
  if (seenOrders.size !== orders.size || rows.length !== manifest.saleLines.length
      || [...orders.values()].some(order => !order.lines.size)) reasons.add('payroll_margin_cost_order_coverage_mismatch');
  return finish();
}

module.exports = { buildPayrollMarginCostSource };
