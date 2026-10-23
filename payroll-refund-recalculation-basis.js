'use strict';

// Pure merchandise basis only: no engine input, source re-attestation, paid/open
// classification, accrual or payout authority is created by this module.
const { createHash } = require('node:crypto');
const { executeCalculatorReplay, validateCalculatorReplay } = require('./payroll-calculator-replay');
const { buildPayrollRefundEarningsProjection } = require('./payroll-refund-earnings-projection');
const POLICY = 'saved_replay_remaining_merchandise_basis_v1';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const fail = suffix => { throw Object.assign(new TypeError(`payroll_refund_recalculation_basis_${suffix}`),
  { code: `payroll_refund_recalculation_basis_${suffix}` }); };
const plain = value => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : plain(value) ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const inspectJson = input => {
  const active = new WeakSet(); let nodes = 0;
  const visit = (value, depth) => {
    if (++nodes > 2000000 || depth > 64) fail('structure_limit');
    if (value === null || typeof value === 'boolean') return;
    if (typeof value === 'string') { if (value.length > 1048576) fail('structure_limit'); return; }
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
  if (Buffer.byteLength(canonical(input), 'utf8') > 32 * 1024 * 1024) fail('structure_limit');
};
const shape = (value, keys) => {
  if (!plain(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail('shape_invalid');
};
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const quantityUnits = value => { const [whole, fraction] = value.split('.'); return BigInt(whole) * 1000n + BigInt(fraction); };
const quantityText = value => `${value / 1000n}.${String(value % 1000n).padStart(3, '0')}`;
const safe = value => { if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < 0n) fail('aggregate_out_of_range'); return Number(value); };
const SALE_KEYS = ['saleLineEventId', 'saleEventId', 'venueId', 'currency', 'orderId', 'orderItemId', 'snapshotId', 'pricingLineId',
  'sellerId', 'recognizedAt', 'recognizedLocalDate', 'timezoneSnapshot', 'soldAt', 'quantity', 'grossMinor', 'discountMinor', 'netMinor', 'productFacts'];

function buildPayrollRefundRecalculationBasis(args) {
  inspectJson(args); shape(args, ['venueId', 'calculatorReplay', 'projection']);
  const { venueId, calculatorReplay, projection } = args;
  if (!UUID.test(venueId || '')) fail('venue_invalid');
  let replay;
  try { replay = executeCalculatorReplay(calculatorReplay); } catch (_) { fail('replay_invalid'); }
  if (!replay?.matched || replay.status !== 'matched' || replay.replayVerified !== true) fail('replay_unavailable');
  if (!plain(projection) || !Array.isArray(projection.saleLines) || !plain(projection.recognitionHistory)) fail('projection_invalid');
  let verifiedProjection;
  try {
    verifiedProjection = buildPayrollRefundEarningsProjection({ schemaVersion: projection.schemaVersion, venueId: projection.venueId,
      currency: projection.currency, period: projection.period, manifestWatermark: projection.manifestWatermark,
      saleLines: projection.saleLines.map(line => Object.fromEntries(SALE_KEYS.map(key => [key, line[key]]))),
      refundEvents: projection.recognitionHistory.refundEvents, refundLines: projection.recognitionHistory.refundLines,
      coverage: projection.coverage });
  } catch (_) { fail('projection_invalid'); }
  if (canonical(verifiedProjection) !== canonical(projection)) fail('projection_mismatch');
  const input = calculatorReplay.input;
  if (projection.venueId !== venueId || replay.result.currency !== projection.currency
      || input.periodFrom !== projection.period.from || input.periodTo !== projection.period.to
      || input.periodFrom !== `${input.periodFrom.slice(0, 7)}-01`) fail('period_or_context_mismatch');
  // Wider replay coverage needs a wider independently supplied projection. V1
  // accepts exact coverage only, never silently narrows month-to-date facts.
  if (input.coverage?.complete !== true || input.coverage.from !== projection.period.from
      || input.coverage.through !== projection.period.to) fail('coverage_mismatch');
  const inPeriod = verifiedProjection.saleLines.filter(line => line.inEarningPeriod);
  const frozenSales = new Map(input.sales.map(line => [line.id, line]));
  if (frozenSales.size !== input.sales.length || inPeriod.length !== frozenSales.size) fail('sale_coverage_mismatch');
  const saleLines = inPeriod.map(line => {
    const sale = frozenSales.get(line.saleLineEventId);
    if (!sale || sale.employeeId !== line.sellerId || sale.date !== line.recognizedLocalDate
        || sale.menuItemId !== line.productFacts.productId || sale.commissionBaseCents !== line.netMinor || sale.turnoverCents !== line.netMinor
        || (Object.hasOwn(sale, 'currency') && sale.currency !== projection.currency)
        || typeof sale.department !== 'string' || !sale.department.trim()) fail('sale_binding_mismatch');
    return { saleLineEventId: line.saleLineEventId, saleEventId: line.saleEventId, orderId: line.orderId,
      orderItemId: line.orderItemId, employeeId: sale.employeeId, date: sale.date, productId: sale.menuItemId,
      department: sale.department, originalNetCents: line.netMinor, originalQuantity: line.quantity,
      refundedNetCents: line.refundCents, remainingNetCents: line.remainingNetCents, remainingQuantity: line.remainingQuantity };
  });
  const aggregate = keys => {
    const groups = new Map();
    for (const line of saleLines) {
      const key = canonical(keys.map(field => line[field]));
      if (!groups.has(key)) groups.set(key, { dimensions: Object.fromEntries(keys.map(field => [field, line[field]])), net: 0n, quantity: 0n, ids: [] });
      const group = groups.get(key);
      group.net += BigInt(line.remainingNetCents); group.quantity += quantityUnits(line.remainingQuantity); group.ids.push(line.saleLineEventId);
    }
    return [...groups].sort(([a], [b]) => a.localeCompare(b, 'en')).map(([, group]) => ({ ...group.dimensions,
      remainingNetCents: safe(group.net), remainingQuantity: quantityText(group.quantity), saleLineEventIds: group.ids.sort() }));
  };
  const merchandiseByRefund = new Map();
  for (const line of verifiedProjection.recognitionHistory.refundLines) merchandiseByRefund.set(line.refundEventId,
    (merchandiseByRefund.get(line.refundEventId) || 0n) + BigInt(line.returnedItemValueMinor));
  const treasuryRefundFacts = verifiedProjection.recognitionHistory.refundEvents.map(event => ({
    refundId: event.refundId, refundEventId: event.refundEventId, orderId: event.orderId,
    recognizedAt: event.recognizedAt, recognizedLocalDate: event.recognizedLocalDate, timezoneSnapshot: event.timezoneSnapshot,
    payoutMinor: event.payoutMinor, tenderTotalMinor: event.tenderTotalMinor,
    returnedMerchandiseMinor: safe(merchandiseByRefund.get(event.refundEventId) || 0n)
  }));
  const needsRemainingCostAttestation = replay.result.mode === 'margin_target' || replay.result.modes?.includes('margin_target') === true
    || replay.result.daily.some(day => (day.employees || []).some(employee => employee.mode === 'margin_target'))
    || input.sales.some(sale => Object.hasOwn(sale, 'costSnapshot'));
  const result = { schemaVersion: 1, policyCode: POLICY, status: 'basis_prepared', officialReady: false, payoutEligible: false,
    persistence: 'none', sourceAttested: false, requiresSavedRunProvenanceBinding: true,
    venueId, currency: projection.currency, period: structuredClone(projection.period),
    amountBasis: 'remaining_merchandise_on_original_recognition_date',
    aggregateQuantityMeaning: 'bookkeeping_sum_of_source_quantities_not_comparable_physical_units',
    replayHashes: { engineRevision: replay.engineRevision, inputSha256: replay.inputSha256, resultSha256: replay.resultSha256 },
    saleLines, employeeDaily: aggregate(['employeeId', 'date']), departmentDaily: aggregate(['department', 'date']), venueDaily: aggregate(['date']),
    needsRemainingCostAttestation, remainingCostBasis: 'frozen_original_cost_and_remaining_quantity_requires_separate_attestation',
    needsOrderAdjustmentAttestation: true, turnoverSource: false, treasuryRefundFacts,
    // Complete related history, including original sales outside the earning
    // period and late refunds, remains part of this independent basis hash.
    projection: structuredClone(verifiedProjection) };
  return freeze({ ...result, basisWatermark: createHash('sha256').update(canonical(result)).digest('hex') });
}

function buildSavedPayrollRefundRecalculationBasis(args) {
  inspectJson(args); shape(args, ['header', 'evidence', 'provenanceSha256', 'projection']);
  const { header, evidence, provenanceSha256, projection } = args;
  if (!plain(header) || !plain(evidence) || header.schemaVersion !== 1 || header.state !== 'saved' || evidence.schemaVersion !== 1
      || !UUID.test(header.runId || '') || !UUID.test(evidence.venueId || '') || header.runId !== evidence.runId
      || (Object.hasOwn(header, 'venueId') && header.venueId !== evidence.venueId)
      || !/^[a-f0-9]{64}$/.test(provenanceSha256 || '')
      || createHash('sha256').update(canonical(evidence)).digest('hex') !== provenanceSha256) fail('saved_provenance_invalid');
  if (header.currency !== evidence.currency || header.period?.from !== evidence.period?.from || header.period?.to !== evidence.period?.to
      || !plain(evidence.schemeSnapshot) || !plain(evidence.sourceEvidence)
      || header.scheme?.versionId !== evidence.schemeSnapshot.versionId || evidence.schemeVersionId !== evidence.schemeSnapshot.versionId
      || evidence.schemeSnapshot.currency !== evidence.currency) fail('saved_context_mismatch');
  try {
    validateCalculatorReplay(evidence.calculatorReplay, { schemeSnapshot: evidence.schemeSnapshot,
      sourceEvidence: evidence.sourceEvidence, period: evidence.period, currency: evidence.currency });
  } catch (_) { fail('saved_replay_context_mismatch'); }
  const basis = buildPayrollRefundRecalculationBasis({ venueId: evidence.venueId, calculatorReplay: evidence.calculatorReplay, projection });
  const total = safe(evidence.calculatorReplay.result.employees.reduce((sum, employee) => sum + BigInt(employee.amountCents), 0n));
  if (header.amountCents !== total || evidence.totalAmountCents !== total) fail('saved_total_mismatch');
  const { basisWatermark, ...facts } = basis;
  // A caller-supplied hash binds these facts, but only the server can attest
  // that this envelope is the stored run and that its DB source fence is held.
  const result = { ...facts, requiresSavedRunProvenanceBinding: false, requiresSavedRunStorageAttestation: true,
    replayBasisWatermark: basisWatermark,
    savedRunBinding: { runId: evidence.runId, venueId: evidence.venueId, provenanceSha256,
      schemeVersionId: evidence.schemeVersionId, currency: evidence.currency, period: structuredClone(evidence.period) } };
  return freeze({ ...result, basisWatermark: createHash('sha256').update(canonical(result)).digest('hex') });
}

module.exports = { buildPayrollRefundRecalculationBasis, buildSavedPayrollRefundRecalculationBasis,
  PAYROLL_REFUND_RECALCULATION_BASIS_POLICY: POLICY };
