'use strict';

// Current source economics, not a saved-run freshness claim or payroll action.
// Recognition dates are immutable sale snapshots; cash refund payouts never
// reduce merchandise earnings or the frozen minimum-order adjustment.
const { createHash } = require('node:crypto');
const { hasPayrollVerifiedWriteSnapshot } = require('./payroll-source-fence');
const { readPayrollRecognitionEvidenceInTransaction } = require('./payroll-recognition-manifest');
const { buildPayrollRefundEarningsSource } = require('./payroll-refund-earnings-source');
const { validateCanonicalPayrollPricingOrder } = require('./payroll-canonical-pricing-source');
const { PAYROLL_REFUND_ADJUSTED_VENUE_TURNOVER_POLICY: POLICY } = require('./payroll-source-policies');
const FACT_ARRAYS = ['saleEvents', 'saleLines', 'orders', 'pricingHeaders', 'pricingLines', 'orderItems', 'candidateOrders',
  'refundEvents', 'refundLines', 'refundHeaders', 'relatedRefundHeaders', 'relatedRefundItems', 'refundItems', 'refundTenders', 'candidateRefunds'];
const fail = suffix => { const code = `payroll_refund_economic_source_${suffix}`; throw Object.assign(new TypeError(code), { code }); };
const plain = value => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
const nativeDate = value => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Date.prototype;
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : nativeDate(value) ? JSON.stringify(Date.prototype.toISOString.call(value))
    : plain(value) ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const inspect = (input, root) => {
  const active = new WeakSet(); let nodes = 0;
  const visit = (value, path, depth) => {
    if (++nodes > 2500000 || depth > 64) fail('structure_limit');
    if (value === null || typeof value === 'boolean') return;
    if (typeof value === 'string') { if (value.length > (path === 'output.evidence.payload' ? 40 * 1024 * 1024 : 1048576)) fail('structure_limit'); return; }
    // Raw JSON pricing terms may contain fractional percentages. Economic
    // amounts are checked separately as exact integer minor units below.
    if (typeof value === 'number') { if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER || Object.is(value, -0)) fail('json_invalid'); return; }
    if (nativeDate(value)) {
      // Existing SELECT s.* includes this unused pricing-header metadata as a
      // native pg Date. All chronology/recognition columns remain exact strings.
      if (!/^evidence\.facts\.pricingHeaders\.\d+\.sold_at$/.test(path) || Reflect.ownKeys(value).length
          || !Number.isFinite(Date.prototype.getTime.call(value))) fail('json_invalid');
      return;
    }
    if ((!plain(value) && !Array.isArray(value)) || active.has(value)) fail('json_invalid');
    active.add(value);
    const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(value);
    if (keys.some(key => typeof key !== 'string') || Object.values(descriptors).some(d => !Object.hasOwn(d, 'value'))) fail('json_invalid');
    if (Array.isArray(value) && (value.length > 20000 || keys.length !== value.length + 1
        || keys.some(key => key !== 'length' && !/^(0|[1-9][0-9]*)$/.test(key)))) fail('json_invalid');
    for (const key of keys) if (key !== 'length' || !Array.isArray(value)) visit(descriptors[key].value, `${path}.${key}`, depth + 1);
    active.delete(value);
  };
  visit(input, root, 0);
  if (Buffer.byteLength(canonical(input), 'utf8') > 40 * 1024 * 1024) fail('structure_limit');
};
const shape = (value, required, optional = []) => {
  if (!plain(value) || Reflect.ownKeys(value).some(key => typeof key !== 'string' || ![...required, ...optional].includes(key))
      || required.some(key => !Object.hasOwn(value, key))) fail('shape_invalid');
};
const normalizeOptions = options => {
  inspect(options, 'options'); shape(options, ['venueId', 'from', 'to'], ['currency']);
  return { venueId: options.venueId, currency: options.currency ?? 'RUB', from: options.from, to: options.to };
};
const safe = value => { if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) fail('amount_overflow'); return Number(value); };
const freeze = value => { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
// Preserve property insertion order: the legacy manifest hashes raw fact rows
// using JSON.stringify. A canonical serializer must not reorder these rows'
// object keys when this evidence is persisted and subsequently replayed.
const jsonCopy = value => nativeDate(value) ? Date.prototype.toISOString.call(value)
  : Array.isArray(value) ? value.map(jsonCopy) : plain(value)
    ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, jsonCopy(child)])) : value;
const sorted = rows => rows.slice().sort((a, b) => canonical(a).localeCompare(canonical(b), 'en'));
const index = (rows, key) => {
  const map = new Map();
  for (const row of rows) {
    if (!plain(row)) fail('row_invalid');
    const id = row[key]; if (!map.has(id)) map.set(id, []); map.get(id).push(row);
  }
  return map;
};
const one = rows => { if (!Array.isArray(rows) || rows.length !== 1) fail('order_coverage_mismatch'); return rows[0]; };

function buildPayrollRefundEconomicSource(evidence, rawOptions) {
  inspect(evidence, 'evidence'); shape(evidence, ['manifest', 'facts']);
  shape(evidence.facts, ['epoch', ...FACT_ARRAYS]);
  for (const name of FACT_ARRAYS) if (!Array.isArray(evidence.facts[name])) fail('facts_invalid');
  const options = normalizeOptions(rawOptions), { venueId, currency, from, to } = options;
  const projection = buildPayrollRefundEarningsSource(evidence, options);
  const { manifest, facts } = evidence;
  const orders = index(facts.orders, 'id'), events = index(facts.saleEvents, 'order_id'), headers = index(facts.pricingHeaders, 'order_id'),
    pricing = index(facts.pricingLines, 'order_id'), items = index(facts.orderItems, 'order_id'), projected = index(projection.saleLines, 'orderId');
  const orderEconomics = projection.coverage.orderIds.map(orderId => {
    const order = one(orders.get(orderId)), event = one(events.get(orderId)), header = one(headers.get(orderId));
    const pricingLines = pricing.get(orderId) || [], itemRows = items.get(orderId) || [], lines = projected.get(orderId) || [];
    const validated = validateCanonicalPayrollPricingOrder({ order, header, lines: pricingLines, itemIds: itemRows.map(row => row.id) }, { venueId, currency });
    if (validated.unknownSellerLineCount || validated.unsupportedCrossVenueLineCount || !lines.length
        || event.snapshot_id !== header.id || lines.length !== validated.order.lineSnapshots.length) fail('order_coverage_mismatch');
    const portions = new Map(validated.order.lineSnapshots.map(row => [row.portionId, row]));
    let originalNet = 0n, refundedNet = 0n, remainingNet = 0n;
    for (const line of lines) {
      const portion = portions.get(line.pricingLineId);
      if (!portion || line.orderId !== orderId || line.saleEventId !== event.id || line.snapshotId !== header.id
          || line.recognizedLocalDate !== event.recognized_local_date || line.recognizedAt !== event.recognized_at
          || line.timezoneSnapshot !== event.timezone_snapshot || line.orderItemId !== portion.orderItemId
          || line.sellerId !== portion.sellerId || line.netMinor !== portion.netSaleCents || line.quantity !== normalizeQuantity(portion.quantity)
          || canonical(line.productFacts) !== canonical(portion.productFacts)) fail('line_price_binding_mismatch');
      portions.delete(line.pricingLineId);
      originalNet += BigInt(line.netMinor); refundedNet += BigInt(line.refundCents); remainingNet += BigInt(line.remainingNetCents);
    }
    const adjustment = BigInt(validated.order.minimumAdjustmentCents), originalTotal = BigInt(validated.order.finalTotalCents);
    if (portions.size || originalNet + adjustment !== originalTotal || originalNet - refundedNet !== remainingNet) fail('order_conservation_mismatch');
    const inEarningPeriod = event.recognized_local_date >= from && event.recognized_local_date <= to;
    return { orderId, saleEventId: event.id, snapshotId: header.id, recognizedAt: event.recognized_at,
      recognizedLocalDate: event.recognized_local_date, timezoneSnapshot: event.timezone_snapshot, inEarningPeriod,
      originalMerchandiseCents: safe(originalNet), cumulativeReturnedMerchandiseCents: safe(refundedNet), remainingMerchandiseCents: safe(remainingNet),
      originalAdjustmentCents: safe(adjustment), remainingAdjustmentCents: safe(adjustment),
      originalTotalCents: safe(originalTotal), remainingTotalCents: safe(originalTotal - refundedNet),
      saleLineEventIds: lines.map(line => line.saleLineEventId).sort(),
      pricingSnapshot: structuredClone(validated.order),
      pricingFactsWatermark: hash({ order, header, pricingLines: sorted(pricingLines), orderItems: sorted(itemRows) }) };
  }).sort((a, b) => a.orderId.localeCompare(b.orderId, 'en'));
  const dayTotals = new Map();
  for (let ms = Date.parse(`${from}T00:00:00Z`), end = Date.parse(`${to}T00:00:00Z`); ms <= end; ms += 86400000) {
    dayTotals.set(new Date(ms).toISOString().slice(0, 10), { original: 0n, remaining: 0n, adjustment: 0n });
  }
  for (const order of orderEconomics) if (order.inEarningPeriod) {
    const day = dayTotals.get(order.recognizedLocalDate);
    if (!day) fail('period_coverage_mismatch');
    day.original += BigInt(order.originalTotalCents); day.remaining += BigInt(order.remainingTotalCents); day.adjustment += BigInt(order.originalAdjustmentCents);
  }
  const originalDaily = [], remainingDaily = [], adjustmentDaily = [];
  for (const [date, day] of dayTotals) {
    originalDaily.push({ date, turnoverCents: safe(day.original) }); remainingDaily.push({ date, turnoverCents: safe(day.remaining) });
    adjustmentDaily.push({ date, originalAdjustmentCents: safe(day.adjustment), remainingAdjustmentCents: safe(day.adjustment) });
  }
  const merchandiseByRefund = new Map();
  for (const line of projection.recognitionHistory.refundLines) merchandiseByRefund.set(line.refundEventId,
    (merchandiseByRefund.get(line.refundEventId) || 0n) + BigInt(line.returnedItemValueMinor));
  const treasuryRefundFacts = projection.recognitionHistory.refundEvents.map(event => ({
    refundEventId: event.refundEventId, refundId: event.refundId, orderId: event.orderId, recognizedAt: event.recognizedAt,
    recognizedLocalDate: event.recognizedLocalDate, timezoneSnapshot: event.timezoneSnapshot,
    payoutMinor: event.payoutMinor, tenderTotalMinor: event.tenderTotalMinor,
    returnedMerchandiseMinor: safe(merchandiseByRefund.get(event.refundEventId) || 0n) }));
  const total = rows => safe(rows.reduce((sum, row) => sum + BigInt(row.turnoverCents), 0n));
  const payload = { schemaVersion: 1, policyCode: POLICY, status: 'economic_source_prepared', officialReady: false,
    payoutEligible: false, sourceAttested: false, persistence: 'none', venueId, currency, period: { from, to },
    dateBasis: 'frozen_original_sale_recognized_local_date', savedSourceComparison: 'not_performed',
    projection, originalDaily, remainingDaily, adjustmentDaily, orderEconomics, treasuryRefundFacts,
    totals: { originalTurnoverCents: total(originalDaily), remainingTurnoverCents: total(remainingDaily),
      minimumAdjustmentCents: safe(adjustmentDaily.reduce((sum, row) => sum + BigInt(row.originalAdjustmentCents), 0n)) },
    coverage: { complete: true, from, through: to, dayCount: dayTotals.size,
      orderIds: projection.coverage.orderIds.slice(), inPeriodOrderIds: orderEconomics.filter(row => row.inEarningPeriod).map(row => row.orderId),
      saleLineEventIds: projection.coverage.saleLineEventIds.slice(), scope: projection.coverage.scope },
    manifestWatermark: manifest.watermark, projectionWatermark: projection.projectionWatermark,
    factsWatermark: hash({ epoch: facts.epoch, ...Object.fromEntries(FACT_ARRAYS.map(name => [name, sorted(facts[name])])) }),
    evidence: { encoding: 'json-preserved-property-order-v1', payload: JSON.stringify(jsonCopy({ manifest, facts })) },
    watermarkScope: 'full_recognition_cohort_canonical_remaining_venue_economics_v1' };
  return freeze({ ...payload, sourceWatermark: hash(payload) });
}
const normalizeQuantity = value => { const [whole, fraction = ''] = value.split('.'); return `${whole}.${fraction.padEnd(3, '0')}`; };

async function readPayrollRefundEconomicSourceInTransaction(db, rawOptions) {
  const options = normalizeOptions(rawOptions);
  if (!db || typeof db.query !== 'function' || !hasPayrollVerifiedWriteSnapshot(db, options.venueId)) fail('verified_write_snapshot_required');
  return buildPayrollRefundEconomicSource(await readPayrollRecognitionEvidenceInTransaction(db, options), options);
}

function validatePayrollRefundEconomicSource(output) {
  inspect(output, 'output');
  if (!plain(output) || !plain(output.evidence) || output.evidence.encoding !== 'json-preserved-property-order-v1'
      || typeof output.evidence.payload !== 'string') fail('replay_evidence_required');
  let evidence;
  try { evidence = JSON.parse(output.evidence.payload); } catch (_) { fail('replay_evidence_invalid'); }
  const rebuilt = buildPayrollRefundEconomicSource(evidence, { venueId: output.venueId, currency: output.currency,
    from: output.period?.from, to: output.period?.to });
  if (canonical(rebuilt) !== canonical(output)) fail('replay_mismatch');
  return rebuilt;
}

module.exports = { buildPayrollRefundEconomicSource, readPayrollRefundEconomicSourceInTransaction, validatePayrollRefundEconomicSource };
