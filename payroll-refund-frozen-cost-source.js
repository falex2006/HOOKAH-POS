'use strict';

// Private payroll incentive-cost reader. This preserves the original frozen
// sale-depletion valuation; it does not attest physical return, restock, or
// refund-adjusted COGS and creates no accounting or payout authority.
const { createHash } = require('node:crypto');
const { hasPayrollVerifiedSourceSnapshot } = require('./payroll-source-fence');
const { buildSaleCostEvidence, readSaleCostEvidence, saleCostEvidenceFingerprint } = require('./pos-sale-cost-evidence');
const { buildPayrollRefundEarningsProjection } = require('./payroll-refund-earnings-projection');
const { normalizePayrollSourcePolicies, PAYROLL_FROZEN_SALE_DEPLETION_COST_PAYROLL_POLICY: POLICY } = require('./payroll-source-policies');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const MAX_LINES = 20000;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const SALE_KEYS = ['saleLineEventId', 'saleEventId', 'venueId', 'currency', 'orderId', 'orderItemId', 'snapshotId', 'pricingLineId',
  'sellerId', 'recognizedAt', 'recognizedLocalDate', 'timezoneSnapshot', 'soldAt', 'quantity', 'grossMinor', 'discountMinor', 'netMinor', 'productFacts'];
const fail = suffix => { throw Object.assign(new TypeError(`payroll_refund_frozen_cost_${suffix}`),
  { code: `payroll_refund_frozen_cost_${suffix}` }); };
const plain = value => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : plain(value) ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value);
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
const safeNumber = value => value >= 0n && value <= MAX_SAFE ? Number(value) : fail('amount_overflow');
const money = value => Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : fail('amount_invalid');
const jsonSafe = value => {
  const active = new WeakSet(); let count = 0;
  const visit = (node, depth) => {
    if (++count > 2000000 || depth > 48) fail('structure_limit');
    if (node === null || typeof node === 'boolean') return;
    if (typeof node === 'string') { if (node.length > 65536) fail('structure_limit'); return; }
    if (typeof node === 'number') { if (!Number.isSafeInteger(node) || Object.is(node, -0)) fail('json_invalid'); return; }
    if ((!Array.isArray(node) && !plain(node)) || active.has(node)) fail('json_invalid');
    active.add(node);
    const keys = Reflect.ownKeys(node), descriptors = Object.getOwnPropertyDescriptors(node);
    if (keys.some(key => typeof key !== 'string') || Object.values(descriptors).some(d => !Object.hasOwn(d, 'value'))
        || (Array.isArray(node) && (keys.length !== node.length + 1
          || keys.some(key => key !== 'length' && !/^(0|[1-9][0-9]*)$/.test(key))))) fail('json_invalid');
    for (const key of keys) if (key !== 'length' || !Array.isArray(node)) visit(descriptors[key].value, depth + 1);
    active.delete(node);
  };
  visit(value, 0);
  if (Buffer.byteLength(canonical(value), 'utf8') > 32 * 1024 * 1024) fail('structure_limit');
};
const equal = (a, b) => canonical(a) === canonical(b);
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const quantityUnits = value => {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/.test(value)) fail('quantity_invalid');
  const [whole, fraction = ''] = value.split('.');
  const units = BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, '0'));
  if (units > 999999999999999999n) fail('quantity_invalid');
  return units;
};
const shape = (value, keys) => {
  if (!plain(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail('shape_invalid');
};
const projectionFor = (projection, venueId, currency, period) => {
  jsonSafe(projection);
  if (!plain(projection) || !Array.isArray(projection.saleLines) || !plain(projection.recognitionHistory)
      || !Array.isArray(projection.recognitionHistory.refundEvents) || !Array.isArray(projection.recognitionHistory.refundLines)
      || !plain(projection.coverage) || projection.venueId !== venueId || projection.currency !== currency
      || projection.period?.from !== period.from || projection.period?.to !== period.to) fail('projection_context_invalid');
  let verified;
  try {
    verified = buildPayrollRefundEarningsProjection({ schemaVersion: projection.schemaVersion, venueId: projection.venueId,
      currency: projection.currency, period: projection.period, manifestWatermark: projection.manifestWatermark,
      saleLines: projection.saleLines.map(line => Object.fromEntries(SALE_KEYS.map(key => [key, line[key]]))),
      refundEvents: projection.recognitionHistory.refundEvents, refundLines: projection.recognitionHistory.refundLines,
      coverage: projection.coverage });
  } catch (_) { fail('projection_invalid'); }
  if (!equal(verified, projection) || !HASH.test(verified.projectionWatermark || '')
      || verified.coverage?.status !== 'complete' || verified.coverage.sourceWatermark !== verified.manifestWatermark) fail('projection_mismatch');
  const periodLines = verified.saleLines.filter(line => line.inEarningPeriod);
  if (periodLines.length > MAX_LINES) fail('line_limit_exceeded');
  const ids = new Set();
  for (const line of periodLines) {
    if (!UUID.test(line.saleLineEventId || '') || !UUID.test(line.orderId || '') || !UUID.test(line.orderItemId || '')
        || !UUID.test(line.productFacts?.productId || '') || ids.has(line.saleLineEventId)) fail('line_identity_invalid');
    ids.add(line.saleLineEventId);
    const original = quantityUnits(line.quantity), remaining = quantityUnits(line.remainingQuantity);
    if (remaining > original || !Number.isSafeInteger(line.remainingNetCents) || line.remainingNetCents < 0) fail('line_projection_invalid');
  }
  return { verified, periodLines };
};
const blocked = (context, reason) => ({ schemaVersion: 1, policyCode: POLICY, status: 'incomplete', reasons: [...new Set([reason])].sort(),
  officialReady: false, payoutEligible: false, persistence: 'none', financialAuthority: 'none', refundAdjustedReady: false,
  accountingScope: 'payroll_incentive_only_not_actual_cogs', venueId: context.venueId || null, currency: context.currency || null,
  period: context.period || null, rows: [], evidenceByOrder: [],
  coverage: { complete: false, projectionWatermark: null, saleLineEventIds: [], producerWatermarks: [] },
  sourceWatermark: null });

function buildPayrollRefundFrozenCostSource({ venueId, currency, period, sourcePolicies, projection, evidenceByOrder } = {}) {
  const context = { venueId, currency, period: period && { from: period.from, to: period.to } };
  try {
    if (!UUID.test(venueId || '') || currency !== 'RUB' || !validDate(period?.from) || !validDate(period?.to)
        || period.from > period.to || period.from.slice(0, 7) !== period.to.slice(0, 7)) fail('context_invalid');
    const policy = normalizePayrollSourcePolicies(sourcePolicies);
    if (policy?.schemaVersion !== 2 || policy.earnings?.marginCost !== POLICY) fail('explicit_v2_policy_required');
    const { verified, periodLines } = projectionFor(projection, venueId, currency, period);
    if (!Array.isArray(evidenceByOrder) || evidenceByOrder.length > MAX_LINES) fail('evidence_invalid');
    jsonSafe(evidenceByOrder);
    const allProjectionLinesByOrder = new Map();
    for (const line of verified.saleLines) {
      if (!allProjectionLinesByOrder.has(line.orderId)) allProjectionLinesByOrder.set(line.orderId, new Map());
      const map = allProjectionLinesByOrder.get(line.orderId);
      if (map.has(line.orderItemId)) fail('line_duplicate');
      map.set(line.orderItemId, line);
    }
    const inPeriodByOrder = new Map();
    for (const line of periodLines) {
      if (!inPeriodByOrder.has(line.orderId)) inPeriodByOrder.set(line.orderId, new Set());
      inPeriodByOrder.get(line.orderId).add(line.saleLineEventId);
    }
    const expectedOrderIds = [...inPeriodByOrder.keys()].sort();
    const evidenceMap = new Map();
    for (const evidence of evidenceByOrder) {
      if (!plain(evidence) || !UUID.test(evidence.orderId || '') || evidenceMap.has(evidence.orderId)) fail('order_duplicate_or_invalid');
      evidenceMap.set(evidence.orderId, evidence);
    }
    if (!equal([...evidenceMap.keys()].sort(), expectedOrderIds)) fail('order_coverage_mismatch');
    const rows = [], producerWatermarks = [], lineIds = new Set();
    for (const orderId of expectedOrderIds) {
      const evidence = evidenceMap.get(orderId), projectedLines = allProjectionLinesByOrder.get(orderId);
      if (!projectedLines || !projectedLines.size || evidence.status !== 'complete' || evidence.schemaVersion !== 1
          || evidence.policyVersion !== 1 || evidence.scope !== 'sale_depletion_cost' || evidence.venueId !== venueId
          || evidence.orderId !== orderId || evidence.currency !== currency || evidence.valuationMethod !== 'ingredient_cost_at_depletion_v1'
          || evidence.refundAdjustedReady !== false || !HASH.test(evidence.watermark || '')
          || !Number.isSafeInteger(evidence.totalCostMinor) || evidence.totalCostMinor < 0
          || !Array.isArray(evidence.reasons) || evidence.reasons.length !== 0
          || evidence.allocation?.status !== 'complete' || evidence.allocation.totalCostMinor !== evidence.totalCostMinor
          || !Array.isArray(evidence.allocation.lines) || evidence.allocation.lines.length !== projectedLines.size) fail('producer_incomplete');
      if (evidence.observedOrderCostMinor !== evidence.totalCostMinor || typeof evidence.epochActivatedAt !== 'string'
          || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(evidence.epochActivatedAt)) fail('producer_context_invalid');
      const producerPayload = { ...buildSaleCostEvidence({ venueId, orderId, capture: evidence.capture,
        totalCostMinor: evidence.observedOrderCostMinor }), epochActivatedAt: evidence.epochActivatedAt };
      // The watermark authenticates the producer payload, but caller supplied
      // JSON must also be exactly that payload. Otherwise an altered allocation
      // with the original valid watermark could reassign order cost to lines.
      if (saleCostEvidenceFingerprint(producerPayload) !== evidence.watermark
          || !equal(evidence, { ...producerPayload, watermark: evidence.watermark })) fail('producer_payload_mismatch');
      producerWatermarks.push({ orderId, watermark: evidence.watermark });
      const allocationByItem = new Map(); let orderTotal = 0n;
      for (const allocated of evidence.allocation.lines) {
        if (!plain(allocated) || !UUID.test(allocated.orderItemId || '') || allocationByItem.has(allocated.orderItemId)
            || !Number.isSafeInteger(allocated.totalCostMinor) || allocated.totalCostMinor < 0) fail('allocation_invalid');
        const sourceLine = projectedLines.get(allocated.orderItemId);
        if (!sourceLine || allocated.productId !== sourceLine.productFacts.productId
            || quantityUnits(allocated.quantity) !== quantityUnits(sourceLine.quantity)) fail('line_binding_mismatch');
        allocationByItem.set(allocated.orderItemId, allocated);
        orderTotal += BigInt(allocated.totalCostMinor);
        if (orderTotal > MAX_SAFE) fail('amount_overflow');
      }
      if (allocationByItem.size !== projectedLines.size || orderTotal !== BigInt(evidence.totalCostMinor)) fail('allocation_coverage_mismatch');
      for (const line of periodLines.filter(row => row.orderId === orderId)) {
        if (lineIds.has(line.saleLineEventId)) fail('line_duplicate');
        lineIds.add(line.saleLineEventId);
        const allocated = allocationByItem.get(line.orderItemId);
        if (!allocated) fail('line_cost_missing');
        const costSnapshot = { id: `${line.orderId}/${line.orderItemId}`, version: evidence.watermark,
          currency, costCents: allocated.totalCostMinor };
        const economicWatermark = digest({ policyCode: POLICY, venueId, currency, period, projectionWatermark: verified.projectionWatermark,
          saleLineEventId: line.saleLineEventId, orderId: line.orderId, orderItemId: line.orderItemId,
          productId: line.productFacts.productId, originalQuantity: line.quantity, remainingQuantity: line.remainingQuantity,
          producerWatermark: evidence.watermark, costSnapshot });
        rows.push({ saleLineEventId: line.saleLineEventId, orderId: line.orderId, orderItemId: line.orderItemId,
          productId: line.productFacts.productId, originalQuantity: line.quantity, remainingQuantity: line.remainingQuantity,
          producerWatermark: evidence.watermark, economicWatermark, costSnapshot });
      }
    }
    if (lineIds.size !== periodLines.length) fail('period_line_coverage_mismatch');
    rows.sort((a, b) => a.saleLineEventId.localeCompare(b.saleLineEventId));
    producerWatermarks.sort((a, b) => a.orderId.localeCompare(b.orderId));
    const payload = { schemaVersion: 1, policyCode: POLICY, status: 'available', reasons: [], venueId, currency,
      period: { from: period.from, to: period.to }, policyVersion: 2, accountingScope: 'payroll_incentive_only_not_actual_cogs',
      refundAdjustedReady: false, officialReady: false, payoutEligible: false, persistence: 'none', financialAuthority: 'none',
      watermarkScope: 'payroll_refund_frozen_sale_depletion_cost_v2',
      coverage: { complete: true, projectionWatermark: verified.projectionWatermark,
        saleLineEventIds: rows.map(row => row.saleLineEventId), producerWatermarks },
      // Verified immutable producer payloads remain available for saved provenance
      // and future replay; never require cost evidence for unrelated outer-period orders.
      evidenceByOrder: expectedOrderIds.map(orderId => structuredClone(evidenceMap.get(orderId))), rows };
    return { ...payload, sourceWatermark: digest(payload) };
  } catch (error) {
    const code = typeof error?.code === 'string' && error.code.startsWith('payroll_refund_frozen_cost_')
      ? error.code : 'payroll_refund_frozen_cost_evidence_invalid';
    return blocked(context, code);
  }
}

async function readPayrollRefundFrozenCostSourceInTransaction(db, options = {}) {
  if (!db || typeof db.query !== 'function') fail('client_required');
  if (!hasPayrollVerifiedSourceSnapshot(db, options.venueId)) fail('verified_write_snapshot_required');
  let policy;
  try { policy = normalizePayrollSourcePolicies(options.sourcePolicies); }
  catch (_) { return blocked(options, 'payroll_refund_frozen_cost_explicit_v2_policy_required'); }
  if (policy?.schemaVersion !== 2 || policy.earnings?.marginCost !== POLICY) return blocked(options, 'payroll_refund_frozen_cost_explicit_v2_policy_required');
  let verified;
  try { verified = projectionFor(options.projection, options.venueId, options.currency, options.period); }
  catch (error) {
    return blocked(options, typeof error?.code === 'string' ? error.code : 'payroll_refund_frozen_cost_projection_invalid');
  }
  const orderIds = [...new Set(verified.periodLines.map(line => line.orderId))].sort();
  const evidenceByOrder = [];
  for (const orderId of orderIds) evidenceByOrder.push(await readSaleCostEvidence(db, { venueId: options.venueId, orderId }));
  return buildPayrollRefundFrozenCostSource({ ...options, evidenceByOrder });
}

module.exports = { buildPayrollRefundFrozenCostSource, readPayrollRefundFrozenCostSourceInTransaction,
  PAYROLL_REFUND_FROZEN_COST_POLICY: POLICY };
