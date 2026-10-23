'use strict';

// Pure earnings projection, not source attestation or payout authorization.
// The server adapter must supply ALL related refund history in one fenced
// snapshot. Current recognitionManifest.refundEvents alone is period-limited
// and does not satisfy this contract. Paid/open classification belongs to the
// caller; this function never applies a correction or changes a financial date.
const { createHash } = require('node:crypto');
const POLICY = 'payroll_remaining_merchandise_original_sale_date_v1';
const SCOPE = 'all_recorded_refunds_for_payroll_related_orders_as_of_repeatable_read_snapshot';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const MAX_ROWS = 20000;
const fail = suffix => { const code = `payroll_refund_earnings_${suffix}`; throw Object.assign(new TypeError(code), { code }); };
const plain = value => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
// Reject executable/non-JSON inputs before inspecting their values. This is a
// strict versioned internal DTO, not a permissive cast of browser/raw SQL data.
const inspectJson = input => {
  const active = new WeakSet(); let nodes = 0;
  const visit = (value, depth) => {
    if (++nodes > 2000000 || depth > 32) fail('structure_limit');
    if (value === null || typeof value === 'boolean') return;
    if (typeof value === 'string') { if (value.length > 4096) fail('structure_limit'); return; }
    if (typeof value === 'number') { if (!Number.isSafeInteger(value) || Object.is(value, -0)) fail('json_invalid'); return; }
    if ((!plain(value) && !Array.isArray(value)) || active.has(value)) fail('json_invalid');
    active.add(value);
    const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(value);
    if (keys.some(key => typeof key !== 'string') || Object.values(descriptors).some(d => !Object.hasOwn(d, 'value'))) fail('json_invalid');
    if (Array.isArray(value) && (keys.length !== value.length + 1 || keys.some(key => key !== 'length' && !/^(0|[1-9][0-9]*)$/.test(key)))) fail('json_invalid');
    for (const key of keys) if (key !== 'length' || !Array.isArray(value)) visit(descriptors[key].value, depth + 1);
    active.delete(value);
  };
  visit(input, 0);
};
const shape = (value, keys) => {
  if (!plain(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail('shape_invalid');
};
const rows = value => { if (!Array.isArray(value) || value.length > MAX_ROWS) fail('rows_invalid'); return value; };
const uuid = value => { if (typeof value !== 'string' || !UUID.test(value)) fail('identity_invalid'); return value; };
const money = value => { if (!Number.isSafeInteger(value) || value < 0) fail('amount_invalid'); return BigInt(value); };
const date = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00Z`))
      || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) fail('date_invalid');
  return value;
};
const instant = value => {
  const m = typeof value === 'string' && value.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/);
  if (!m || Number(m[2]) > 23 || Number(m[3]) > 59 || Number(m[4]) > 59) fail('timestamp_invalid');
  date(m[1]);
  return BigInt(Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.000Z`)) * 1000n + BigInt(m[5]);
};
const recognition = row => {
  const value = instant(row.recognizedAt); date(row.recognizedLocalDate);
  if (typeof row.timezoneSnapshot !== 'string' || !row.timezoneSnapshot.trim()) fail('timezone_invalid');
  let local;
  try { local = new Intl.DateTimeFormat('en-CA', { timeZone: row.timezoneSnapshot,
    year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(row.recognizedAt)); }
  catch (_) { fail('timezone_invalid'); }
  if (local !== row.recognizedLocalDate) fail('recognition_date_mismatch');
  return value;
};
const quantity = value => {
  if (typeof value !== 'string' || value.length > 32 || !/^(0|[1-9][0-9]*)(?:\.[0-9]{1,3})?$/.test(value)) fail('quantity_invalid');
  const [whole, fraction = ''] = value.split('.'), n = BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, '0'));
  if (n > 999999999999999n) fail('quantity_invalid');
  return n;
};
const quantityText = value => `${value / 1000n}.${String(value % 1000n).padStart(3, '0')}`;
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : plain(value) ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const exactIds = (actual, expected) => {
  rows(actual); actual.forEach(uuid);
  if (new Set(actual).size !== actual.length || canonical([...actual].sort()) !== canonical([...new Set(expected)].sort())) fail('coverage_mismatch');
};
const unique = (map, key, value) => { if (map.has(key)) fail('duplicate_identity'); map.set(key, value); };

function buildPayrollRefundEarningsProjection(input) {
  inspectJson(input);
  shape(input, ['schemaVersion', 'venueId', 'currency', 'period', 'manifestWatermark', 'saleLines', 'refundEvents', 'refundLines', 'coverage']);
  if (input.schemaVersion !== 1 || input.currency !== 'RUB' || !HASH.test(input.manifestWatermark || '')) fail('context_invalid');
  uuid(input.venueId); shape(input.period, ['from', 'to']); date(input.period.from); date(input.period.to);
  if (input.period.from > input.period.to || input.period.from.slice(0, 7) !== input.period.to.slice(0, 7)) fail('period_invalid');
  const sales = new Map(), items = new Map(), pricingLines = new Map(), saleEvents = new Map(), orders = new Map(), saleInstants = new Map();
  for (const row of rows(input.saleLines)) {
    shape(row, ['saleLineEventId', 'saleEventId', 'venueId', 'currency', 'orderId', 'orderItemId', 'snapshotId', 'pricingLineId',
      'sellerId', 'recognizedAt', 'recognizedLocalDate', 'timezoneSnapshot', 'soldAt', 'quantity', 'grossMinor', 'discountMinor', 'netMinor', 'productFacts']);
    for (const key of ['saleLineEventId', 'saleEventId', 'venueId', 'orderId', 'orderItemId', 'snapshotId', 'pricingLineId', 'sellerId']) uuid(row[key]);
    if (row.venueId !== input.venueId || row.currency !== input.currency || !plain(row.productFacts)) fail('sale_context_invalid');
    uuid(row.productFacts.productId);
    const at = recognition(row), soldAt = instant(row.soldAt), q = quantity(row.quantity);
    if (q <= 0n || soldAt > at || money(row.grossMinor) - money(row.discountMinor) !== money(row.netMinor)) fail('sale_amount_invalid');
    const parent = canonical({ orderId: row.orderId, snapshotId: row.snapshotId, recognizedAt: row.recognizedAt,
      recognizedLocalDate: row.recognizedLocalDate, timezoneSnapshot: row.timezoneSnapshot });
    if ((saleEvents.has(row.saleEventId) && saleEvents.get(row.saleEventId) !== parent)
        || (orders.has(row.orderId) && orders.get(row.orderId) !== row.saleEventId)) fail('sale_lineage_invalid');
    saleEvents.set(row.saleEventId, parent); saleInstants.set(row.saleEventId, at); orders.set(row.orderId, row.saleEventId);
    unique(items, row.orderItemId, row.saleLineEventId);
    unique(pricingLines, row.pricingLineId, row.saleLineEventId);
    unique(sales, row.saleLineEventId, { row, at, q, net: BigInt(row.netMinor), history: [] });
  }
  const events = new Map(), headers = new Map();
  for (const row of rows(input.refundEvents)) {
    shape(row, ['venueId', 'currency', 'refundId', 'refundEventId', 'orderId', 'originalSaleEventId', 'recognizedAt',
      'recognizedLocalDate', 'timezoneSnapshot', 'payoutMinor', 'tenderTotalMinor', 'itemAttributionStatus']);
    for (const key of ['venueId', 'refundId', 'refundEventId', 'orderId', 'originalSaleEventId']) uuid(row[key]);
    if (row.venueId !== input.venueId || row.currency !== input.currency || orders.get(row.orderId) !== row.originalSaleEventId
        || !['complete', 'not_applicable'].includes(row.itemAttributionStatus)) fail('refund_context_invalid');
    if (money(row.payoutMinor) !== money(row.tenderTotalMinor)) fail('refund_tender_mismatch');
    const at = recognition(row);
    if (at < saleInstants.get(row.originalSaleEventId)) fail('refund_lineage_invalid');
    unique(headers, row.refundId, row.refundEventId); unique(events, row.refundEventId, { row, at, lineIds: [] });
  }
  const refundItems = new Map(), refundLines = new Map(), eventItems = new Map();
  for (const row of rows(input.refundLines)) {
    shape(row, ['venueId', 'refundId', 'refundEventId', 'refundItemId', 'refundLineEventId', 'orderId', 'orderItemId', 'snapshotId',
      'originalSaleEventId', 'originalSaleLineEventId', 'producerSequence', 'previousReturnedQuantity', 'returnedQuantity',
      'cumulativeReturnedQuantity', 'previousReturnedItemValueMinor', 'returnedItemValueMinor', 'cumulativeReturnedItemValueMinor']);
    for (const key of ['venueId', 'refundId', 'refundEventId', 'refundItemId', 'refundLineEventId', 'orderId', 'orderItemId', 'snapshotId', 'originalSaleEventId', 'originalSaleLineEventId']) uuid(row[key]);
    const event = events.get(row.refundEventId), sale = sales.get(row.originalSaleLineEventId);
    if (!event || !sale || row.venueId !== input.venueId || row.refundId !== event.row.refundId
        || row.orderId !== event.row.orderId || row.orderId !== sale.row.orderId || row.orderItemId !== sale.row.orderItemId
        || row.snapshotId !== sale.row.snapshotId || row.originalSaleEventId !== sale.row.saleEventId
        || row.originalSaleEventId !== event.row.originalSaleEventId || event.at < sale.at) fail('refund_lineage_invalid');
    if (!Number.isSafeInteger(row.producerSequence) || row.producerSequence < 1) fail('sequence_invalid');
    unique(refundItems, row.refundItemId, row.refundLineEventId); unique(refundLines, row.refundLineEventId, row);
    unique(eventItems, `${row.refundEventId}/${row.orderItemId}`, row.refundLineEventId);
    event.lineIds.push(row.refundLineEventId); sale.history.push(row);
  }
  for (const event of events.values()) {
    if ((event.row.itemAttributionStatus === 'complete') !== (event.lineIds.length > 0)) fail('refund_classification_invalid');
  }
  const coverage = input.coverage;
  shape(coverage, ['status', 'scope', 'sourceWatermark', 'saleLineEventIds', 'orderIds', 'refundHeaderIds', 'refundEventIds', 'refundItemIds', 'refundLineEventIds', 'lineTotals']);
  if (coverage.status !== 'complete' || coverage.scope !== SCOPE || coverage.sourceWatermark !== input.manifestWatermark) fail('coverage_invalid');
  for (const [key, values] of [['saleLineEventIds', sales.keys()], ['orderIds', orders.keys()], ['refundHeaderIds', headers.keys()],
    ['refundEventIds', events.keys()], ['refundItemIds', refundItems.keys()], ['refundLineEventIds', refundLines.keys()]]) exactIds(coverage[key], [...values]);
  const totals = new Map();
  for (const row of rows(coverage.lineTotals)) {
    shape(row, ['saleLineEventId', 'cumulativeReturnedQuantity', 'cumulativeReturnedItemValueMinor']); uuid(row.saleLineEventId);
    unique(totals, row.saleLineEventId, row);
  }
  exactIds([...totals.keys()], [...sales.keys()]);
  const projected = [];
  for (const sale of sales.values()) {
    const history = sale.history.sort((a, b) => a.producerSequence - b.producerSequence);
    let q = 0n, value = 0n;
    for (const [index, row] of history.entries()) {
      const previousQ = quantity(row.previousReturnedQuantity), deltaQ = quantity(row.returnedQuantity), nextQ = quantity(row.cumulativeReturnedQuantity);
      const previousValue = money(row.previousReturnedItemValueMinor), deltaValue = money(row.returnedItemValueMinor), nextValue = money(row.cumulativeReturnedItemValueMinor);
      if (row.producerSequence !== index + 1 || previousQ !== q || previousValue !== value || deltaQ <= 0n
          || nextQ !== q + deltaQ || nextQ > sale.q || nextValue !== value + deltaValue || nextValue > sale.net) fail('history_transition_invalid');
      // Same cumulative half-up policy as immutable item-return producer092.
      if (nextValue !== (2n * sale.net * nextQ + sale.q) / (2n * sale.q)) fail('history_value_invalid');
      q = nextQ; value = nextValue;
    }
    const terminal = totals.get(sale.row.saleLineEventId);
    if (quantity(terminal.cumulativeReturnedQuantity) !== q || money(terminal.cumulativeReturnedItemValueMinor) !== value) fail('history_coverage_mismatch');
    projected.push({ ...structuredClone(sale.row), quantity: quantityText(sale.q),
      inEarningPeriod: sale.row.recognizedLocalDate >= input.period.from && sale.row.recognizedLocalDate <= input.period.to,
      cumulativeReturnedQuantity: quantityText(q), remainingQuantity: quantityText(sale.q - q),
      refundCents: Number(value), remainingNetCents: Number(sale.net - value),
      refundLineEventIds: history.map(row => row.refundLineEventId) });
  }
  projected.sort((a, b) => a.recognizedLocalDate.localeCompare(b.recognizedLocalDate) || a.saleLineEventId.localeCompare(b.saleLineEventId));
  const sortedEvents = [...events.values()].map(event => structuredClone(event.row)).sort((a, b) => a.refundEventId.localeCompare(b.refundEventId));
  const sortedLines = [...refundLines.values()].map(structuredCloneSafe).sort((a, b) => a.originalSaleLineEventId.localeCompare(b.originalSaleLineEventId)
    || a.producerSequence - b.producerSequence);
  const result = { schemaVersion: 1, policyCode: POLICY, status: 'projected', officialReady: false, payoutEligible: false,
    venueId: input.venueId, currency: input.currency, period: structuredClone(input.period), manifestWatermark: input.manifestWatermark,
    saleLines: projected, recognitionHistory: { refundEvents: sortedEvents, refundLines: sortedLines },
    coverage: { ...structuredClone(coverage), ...Object.fromEntries(['saleLineEventIds', 'orderIds', 'refundHeaderIds', 'refundEventIds', 'refundItemIds', 'refundLineEventIds']
      .map(key => [key, [...coverage[key]].sort()])), lineTotals: [...totals.values()].map(structuredCloneSafe)
      .sort((a, b) => a.saleLineEventId.localeCompare(b.saleLineEventId)) } };
  return freeze({ ...result, projectionWatermark: digest(result) });
}
const structuredCloneSafe = value => structuredClone(value);
module.exports = { buildPayrollRefundEarningsProjection, PAYROLL_REFUND_EARNINGS_POLICY: POLICY, PAYROLL_REFUND_HISTORY_SCOPE: SCOPE };
