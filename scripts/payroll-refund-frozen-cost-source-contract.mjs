import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { buildPayrollRefundFrozenCostSource, readPayrollRefundFrozenCostSourceInTransaction,
  PAYROLL_REFUND_FROZEN_COST_POLICY } = require('../payroll-refund-frozen-cost-source.js');
const { buildPayrollRefundEarningsProjection, PAYROLL_REFUND_HISTORY_SCOPE } = require('../payroll-refund-earnings-projection.js');
const { beginPayrollVerifiedRunSourceTransaction } = require('../payroll-source-fence.js');
const { buildSaleCostEvidence, saleCostEvidenceFingerprint } = require('../pos-sale-cost-evidence.js');
const { PAYROLL_REMAINING_NET_EARNINGS_POLICY, PAYROLL_REFUND_ADJUSTED_VENUE_TURNOVER_POLICY,
  PAYROLL_FROZEN_SALE_DEPLETION_COST_PAYROLL_POLICY } = require('../payroll-source-policies.js');

const venueId = '00000000-0000-4000-8000-000000000001';
const currency = 'RUB';
const period = { from: '2025-06-01', to: '2025-06-30' };
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const policy = () => ({ schemaVersion: 2, selectionReason: 'Owner explicitly selected the refund-aware payroll incentive basis',
  saleCredit: { kind: 'line_seller_snapshot' }, discountAllocation: { kind: 'immutable_line_snapshot' },
  refunds: { recognition: 'recognized_event_date', closedRunTreatment: 'next_open_run_adjustment', paidAdjustment: 'owner_review_variable_pay_only',
    uncoveredBalance: 'carry_forward_review', clawback: 'no_automatic_clawback' },
  earnings: { refunds: PAYROLL_REMAINING_NET_EARNINGS_POLICY, venueTurnover: PAYROLL_REFUND_ADJUSTED_VENUE_TURNOVER_POLICY,
    marginCost: PAYROLL_FROZEN_SALE_DEPLETION_COST_PAYROLL_POLICY } });
const sale = ({ n, date, quantity, net }) => ({ saleLineEventId: uuid(100 + n), saleEventId: uuid(200 + n), venueId, currency,
  orderId: uuid(300 + n), orderItemId: uuid(400 + n), snapshotId: uuid(500 + n), pricingLineId: uuid(600 + n),
  sellerId: uuid(700), recognizedAt: `${date}T10:00:00.000000Z`, recognizedLocalDate: date, timezoneSnapshot: 'UTC',
  soldAt: `${date}T09:00:00.000000Z`, quantity: String(quantity), grossMinor: net, discountMinor: 0, netMinor: net,
  productFacts: { productId: uuid(800 + n), productName: `Item ${n}` } });
const lines = [sale({ n: 1, date: '2025-06-10', quantity: 2, net: 200 }),
  sale({ n: 2, date: '2025-06-12', quantity: 4, net: 400 }),
  sale({ n: 3, date: '2025-06-15', quantity: 1, net: 100 }),
  sale({ n: 4, date: '2025-05-31', quantity: 1, net: 100 })];
const refundEvent = (n, line, day, payout) => ({ venueId, currency, refundId: uuid(900 + n), refundEventId: uuid(1000 + n),
  orderId: line.orderId, originalSaleEventId: line.saleEventId, recognizedAt: `${day}T11:00:00.000000Z`,
  recognizedLocalDate: day, timezoneSnapshot: 'UTC', payoutMinor: payout, tenderTotalMinor: payout, itemAttributionStatus: 'complete' });
const event1 = refundEvent(1, lines[0], '2025-06-11', 200);
const event2 = refundEvent(2, lines[1], '2025-06-13', 50);
const refundLine = (n, line, event, returnedQuantity, returnedValue) => ({ venueId, refundId: event.refundId,
  refundEventId: event.refundEventId, refundItemId: uuid(1100 + n), refundLineEventId: uuid(1200 + n), orderId: line.orderId,
  orderItemId: line.orderItemId, snapshotId: line.snapshotId, originalSaleEventId: line.saleEventId,
  originalSaleLineEventId: line.saleLineEventId, producerSequence: 1, previousReturnedQuantity: '0.000',
  returnedQuantity: `${returnedQuantity}.000`, cumulativeReturnedQuantity: `${returnedQuantity}.000`,
  previousReturnedItemValueMinor: 0, returnedItemValueMinor: returnedValue, cumulativeReturnedItemValueMinor: returnedValue });
const refundLines = [refundLine(1, lines[0], event1, 2, 200), refundLine(2, lines[1], event2, 1, 100)];
const coverage = { status: 'complete', scope: PAYROLL_REFUND_HISTORY_SCOPE, sourceWatermark: 'a'.repeat(64),
  saleLineEventIds: lines.map(row => row.saleLineEventId), orderIds: lines.map(row => row.orderId),
  refundHeaderIds: [event1.refundId, event2.refundId], refundEventIds: [event1.refundEventId, event2.refundEventId],
  refundItemIds: refundLines.map(row => row.refundItemId), refundLineEventIds: refundLines.map(row => row.refundLineEventId),
  lineTotals: [{ saleLineEventId: lines[0].saleLineEventId, cumulativeReturnedQuantity: '2.000', cumulativeReturnedItemValueMinor: 200 },
    { saleLineEventId: lines[1].saleLineEventId, cumulativeReturnedQuantity: '1.000', cumulativeReturnedItemValueMinor: 100 },
    { saleLineEventId: lines[2].saleLineEventId, cumulativeReturnedQuantity: '0.000', cumulativeReturnedItemValueMinor: 0 },
    { saleLineEventId: lines[3].saleLineEventId, cumulativeReturnedQuantity: '0.000', cumulativeReturnedItemValueMinor: 0 }] };
const projection = buildPayrollRefundEarningsProjection({ schemaVersion: 1, venueId, currency, period,
  manifestWatermark: coverage.sourceWatermark, saleLines: lines, refundEvents: [event1, event2], refundLines, coverage });
const makeEvidence = (line, n, quantity) => {
  const movementId = uuid(1300 + n), ingredientId = uuid(1400 + n);
  const capture = { captureVersion: 1, status: 'captured', reasons: [],
    lines: [{ orderItemId: line.orderItemId, productId: line.productFacts.productId, inventoryMode: 'tracked', quantity: `${quantity}.000000` }],
    movements: [{ movementId, ingredientId, quantity: `${quantity}.000000` }],
    components: [{ orderItemId: line.orderItemId, ingredientId, movementId, quantity: `${quantity}.000000`, unitCost: '1.0000' }] };
  const totalCostMinor = quantity * 100;
  const base = buildSaleCostEvidence({ venueId, orderId: line.orderId, capture, totalCostMinor });
  const epochActivatedAt = '2024-01-01T00:00:00.000000Z';
  const payload = { ...base, epochActivatedAt };
  return { ...payload, watermark: saleCostEvidenceFingerprint(payload) };
};
const evidence = lines.slice(0, 3).map((line, i) => makeEvidence(line, i + 1, Number(line.quantity)));
const args = { venueId, currency, period, sourcePolicies: policy(), projection, evidenceByOrder: evidence };

const complete = buildPayrollRefundFrozenCostSource(args);
assert.equal(complete.status, 'available');
assert.equal(complete.policyCode, PAYROLL_REFUND_FROZEN_COST_POLICY);
assert.equal(complete.rows.length, 3, 'only original sale lines in the requested earnings period require costs');
assert.deepEqual(complete.rows.map(row => [row.originalQuantity, row.remainingQuantity, row.costSnapshot.costCents]),
  [['2.000', '0.000', 200], ['4.000', '3.000', 400], ['1.000', '1.000', 100]],
'full, partial and untouched returns retain exact original frozen cost');
assert.equal(complete.refundAdjustedReady, false);
assert.equal(complete.accountingScope, 'payroll_incentive_only_not_actual_cogs');
assert.equal(complete.officialReady, false); assert.equal(complete.payoutEligible, false);
assert.equal(complete.persistence, 'none'); assert.equal(complete.financialAuthority, 'none');
assert.equal(complete.coverage.complete, true); assert.equal(complete.sourceWatermark.length, 64);
assert.equal(complete.coverage.producerWatermarks.length, 3);
assert.equal(complete.evidenceByOrder.length, 3, 'verified producer payloads are retained for persisted provenance');

// A multi-line sale must not let a caller reassign the immutable order cost
// between products while keeping the original producer watermark.
{
  const first = { ...lines[0], orderId: uuid(330), saleEventId: uuid(230), snapshotId: uuid(530),
    orderItemId: uuid(431), pricingLineId: uuid(631), productFacts: { productId: uuid(831), productName: 'First' },
    recognizedAt: '2025-06-10T10:00:00.000000Z', recognizedLocalDate: '2025-06-10', soldAt: '2025-06-10T09:00:00.000000Z',
    quantity: '1.000', grossMinor: 100, discountMinor: 0, netMinor: 100 };
  const second = { ...first, saleLineEventId: uuid(102), orderItemId: uuid(432), pricingLineId: uuid(632),
    productFacts: { productId: uuid(832), productName: 'Second' } };
  const multiCoverage = { status: 'complete', scope: PAYROLL_REFUND_HISTORY_SCOPE, sourceWatermark: 'b'.repeat(64),
    saleLineEventIds: [first.saleLineEventId, second.saleLineEventId], orderIds: [first.orderId], refundHeaderIds: [],
    refundEventIds: [], refundItemIds: [], refundLineEventIds: [], lineTotals: [first, second].map(line => ({
      saleLineEventId: line.saleLineEventId, cumulativeReturnedQuantity: '0.000', cumulativeReturnedItemValueMinor: 0 })) };
  const multiProjection = buildPayrollRefundEarningsProjection({ schemaVersion: 1, venueId, currency, period,
    manifestWatermark: multiCoverage.sourceWatermark, saleLines: [first, second], refundEvents: [], refundLines: [], coverage: multiCoverage });
  const movement1 = uuid(1301), movement2 = uuid(1302), ingredient1 = uuid(1401), ingredient2 = uuid(1402);
  const capture = { captureVersion: 1, status: 'captured', reasons: [], lines: [first, second].map(line => ({
    orderItemId: line.orderItemId, productId: line.productFacts.productId, inventoryMode: 'tracked', quantity: '1.000000' })),
    movements: [{ movementId: movement1, ingredientId: ingredient1, quantity: '1.000000' },
      { movementId: movement2, ingredientId: ingredient2, quantity: '1.000000' }],
    components: [{ orderItemId: first.orderItemId, ingredientId: ingredient1, movementId: movement1, quantity: '1.000000', unitCost: '2.0000' },
      { orderItemId: second.orderItemId, ingredientId: ingredient2, movementId: movement2, quantity: '1.000000', unitCost: '1.0000' }] };
  const base = buildSaleCostEvidence({ venueId, orderId: first.orderId, capture, totalCostMinor: 300 });
  const epochActivatedAt = '2024-01-01T00:00:00.000000Z';
  const producerPayload = { ...base, epochActivatedAt };
  const multiEvidence = { ...producerPayload, watermark: saleCostEvidenceFingerprint(producerPayload) };
  const multiArgs = { ...args, projection: multiProjection, evidenceByOrder: [multiEvidence] };
  const validMulti = buildPayrollRefundFrozenCostSource(multiArgs);
  assert.equal(validMulti.status, 'available');
  assert.deepEqual(validMulti.rows.map(row => row.costSnapshot.costCents), [200, 100]);
  const forged = structuredClone(multiEvidence);
  forged.allocation.lines[0].totalCostMinor = 150;
  forged.allocation.lines[1].totalCostMinor = 150;
  const rejectedForgery = buildPayrollRefundFrozenCostSource({ ...multiArgs, evidenceByOrder: [forged] });
  assert.equal(rejectedForgery.status, 'incomplete');
  assert.ok(rejectedForgery.reasons.includes('payroll_refund_frozen_cost_producer_payload_mismatch'));
}

const blocked = value => { const result = buildPayrollRefundFrozenCostSource(value); assert.equal(result.status, 'incomplete');
  assert.equal(result.rows.length, 0); assert.equal(result.officialReady, false); return result; };
blocked({ ...args, sourcePolicies: { ...policy(), schemaVersion: 1, earnings: undefined } });
blocked({ ...args, sourcePolicies: { ...policy(), earnings: { ...policy().earnings, marginCost: 'actual_cogs_after_return' } } });
blocked({ ...args, evidenceByOrder: evidence.slice(1) });
blocked({ ...args, evidenceByOrder: [...evidence, evidence[0]] });
blocked({ ...args, evidenceByOrder: [...evidence, makeEvidence(lines[3], 4, 1)] });
blocked({ ...args, evidenceByOrder: evidence.map((row, index) => index ? row : { ...row,
  allocation: { ...row.allocation, lines: row.allocation.lines.map(line => ({ ...line, productId: uuid(9999) })) } }) });
blocked({ ...args, evidenceByOrder: evidence.map((row, index) => index ? row : { ...row,
  allocation: { ...row.allocation, lines: row.allocation.lines.map(line => ({ ...line, quantity: '99.000000' })) } }) });
blocked({ ...args, evidenceByOrder: evidence.map((row, index) => index ? row : { ...row, totalCostMinor: Number.MAX_SAFE_INTEGER + 1,
  observedOrderCostMinor: Number.MAX_SAFE_INTEGER + 1 }) });
blocked({ ...args, projection: { ...projection, projectionWatermark: 'f'.repeat(64) } });

const queried = [];
const costByOrder = new Map(evidence.map(row => [row.orderId, row]));
const fakeDb = { async query(sql, params = []) {
  if (sql === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ WRITE') return { rows: [] };
  if (sql.includes('pg_advisory_lock(hashtextextended')) return { rows: [] };
  if (sql.includes('pg_advisory_unlock(hashtextextended')) return { rows: [{ unlocked: true }] };
  if (sql.includes('FROM orders o LEFT JOIN pos_sale_cost_evidence')) {
    const orderId = params[1]; queried.push(orderId); const row = costByOrder.get(orderId);
    return { rows: row ? [{ payload: Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'watermark')),
      watermark: row.watermark, epochActivatedAt: row.epochActivatedAt }] : [] };
  }
  throw new Error(`unexpected DB query: ${sql}`);
} };
await assert.rejects(readPayrollRefundFrozenCostSourceInTransaction(fakeDb, args), /verified_write_snapshot_required/);
const cleanup = await beginPayrollVerifiedRunSourceTransaction(fakeDb, venueId);
try {
  const read = await readPayrollRefundFrozenCostSourceInTransaction(fakeDb, args);
  assert.equal(read.status, 'available'); assert.equal(read.rows.length, 3); assert.equal(read.evidenceByOrder.length, 3);
  assert.deepEqual(queried.sort(), evidence.map(row => row.orderId).sort(), 'fenced reader reads unique in-period orders only');
  assert.ok(!queried.includes(lines[3].orderId), 'out-of-period related history does not require cost reads');
} finally { await cleanup(); }

console.log('PAYROLL REFUND FROZEN COST SOURCE CONTRACT: PASS (v2 opt-in, 187 line binding, full/partial/zero quantities, fenced DB reads, no COGS authority)');
