import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { buildPayrollRefundEarningsProjection: project, PAYROLL_REFUND_HISTORY_SCOPE: scope } = require('../payroll-refund-earnings-projection');
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const clone = value => structuredClone(value);
const at = date => `${date}T12:00:00.123456Z`;
function fixture() {
  const sale = { saleLineEventId: id(1), saleEventId: id(2), venueId: id(3), currency: 'RUB', orderId: id(4),
    orderItemId: id(5), snapshotId: id(6), pricingLineId: id(7), sellerId: id(8), recognizedAt: at('2026-09-01'),
    recognizedLocalDate: '2026-09-01', timezoneSnapshot: 'Asia/Yekaterinburg', soldAt: '2026-09-01T10:00:00.123456Z',
    quantity: '3.000', grossMinor: 120, discountMinor: 20, netMinor: 100,
    productFacts: { productId: id(9), productName: 'Frozen item', department: 'bar' } };
  const events = [1, 2].map(n => ({ venueId: id(3), currency: 'RUB', refundId: id(10 + n), refundEventId: id(20 + n),
    orderId: id(4), originalSaleEventId: id(2), recognizedAt: at(`2026-10-0${n}`), recognizedLocalDate: `2026-10-0${n}`,
    timezoneSnapshot: 'Asia/Yekaterinburg', payoutMinor: 500 + n, tenderTotalMinor: 500 + n, itemAttributionStatus: 'complete' }));
  const lines = events.map((event, index) => ({ venueId: id(3), refundId: event.refundId, refundEventId: event.refundEventId,
    refundItemId: id(31 + index), refundLineEventId: id(41 + index), orderId: id(4), orderItemId: id(5), snapshotId: id(6),
    originalSaleEventId: id(2), originalSaleLineEventId: id(1), producerSequence: index + 1,
    previousReturnedQuantity: `${index}.000`, returnedQuantity: '1.000', cumulativeReturnedQuantity: `${index + 1}.000`,
    previousReturnedItemValueMinor: index ? 33 : 0, returnedItemValueMinor: index ? 34 : 33,
    cumulativeReturnedItemValueMinor: index ? 67 : 33 }));
  return { schemaVersion: 1, venueId: id(3), currency: 'RUB', period: { from: '2026-09-01', to: '2026-09-30' },
    manifestWatermark: 'a'.repeat(64), saleLines: [sale], refundEvents: events, refundLines: lines,
    coverage: { status: 'complete', scope, sourceWatermark: 'a'.repeat(64), saleLineEventIds: [id(1)], orderIds: [id(4)],
      refundHeaderIds: [id(11), id(12)], refundEventIds: [id(21), id(22)], refundItemIds: [id(31), id(32)],
      refundLineEventIds: [id(41), id(42)], lineTotals: [{ saleLineEventId: id(1), cumulativeReturnedQuantity: '2.000', cumulativeReturnedItemValueMinor: 67 }] } };
}
let checks = 0;
const check = (condition, message) => { assert.ok(condition, message); checks++; };
const invalid = (mutate, expected) => {
  const input = fixture(); mutate(input);
  assert.throws(() => project(input), error => error.code?.startsWith('payroll_refund_earnings_') && (!expected || error.code.endsWith(expected)));
  checks++;
};
{
  const input = fixture(), before = clone(input), output = project(input), line = output.saleLines[0];
  assert.deepEqual(input, before); checks++;
  assert.deepEqual([line.grossMinor, line.discountMinor, line.netMinor, line.refundCents, line.remainingNetCents], [120, 20, 100, 67, 33]); checks++;
  assert.deepEqual([line.quantity, line.cumulativeReturnedQuantity, line.remainingQuantity], ['3.000', '2.000', '1.000']); checks++;
  check(line.recognizedLocalDate === '2026-09-01' && line.sellerId === id(8) && line.snapshotId === id(6), 'original earning attribution retained');
  check(output.recognitionHistory.refundEvents[1].recognizedLocalDate === '2026-10-02', 'late recognition date retained');
  check(output.recognitionHistory.refundEvents[1].payoutMinor === 502 && line.refundCents === 67, 'cash refund does not become commission deduction');
  check(output.officialReady === false && output.payoutEligible === false && output.status === 'projected');
  const frozen = value => !value || typeof value !== 'object' || Object.isFrozen(value) && Object.values(value).every(frozen);
  check(frozen(output)); input.saleLines[0].productFacts.productName = 'Changed';
  check(output.saleLines[0].productFacts.productName === 'Frozen item', 'output detached');
  const shuffled = fixture(); shuffled.refundEvents.reverse(); shuffled.refundLines.reverse();
  for (const value of Object.values(shuffled.coverage)) if (Array.isArray(value)) value.reverse();
  assert.deepEqual(project(shuffled), output); checks++;
  const reordered = value => Array.isArray(value) ? value.map(reordered) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reordered(child)])) : value;
  check(project(reordered(fixture())).projectionWatermark === output.projectionWatermark, 'canonical key order');
  const cashOnly = fixture(); cashOnly.refundEvents[0].payoutMinor = cashOnly.refundEvents[0].tenderTotalMinor = 9999;
  const changed = project(cashOnly);
  check(changed.saleLines[0].remainingNetCents === 33 && changed.projectionWatermark !== output.projectionWatermark);
}
{
  const input = fixture(); input.refundLines[1].returnedQuantity = '2.000'; input.refundLines[1].cumulativeReturnedQuantity = '3.000';
  input.refundLines[1].returnedItemValueMinor = 67; input.refundLines[1].cumulativeReturnedItemValueMinor = 100;
  Object.assign(input.coverage.lineTotals[0], { cumulativeReturnedQuantity: '3.000', cumulativeReturnedItemValueMinor: 100 });
  const result = project(input);
  check(result.saleLines.length === 1 && result.saleLines[0].remainingNetCents === 0 && result.saleLines[0].remainingQuantity === '0.000', 'zero line retained');
}
{
  const input = fixture(); input.refundEvents = []; input.refundLines = [];
  for (const key of ['refundHeaderIds', 'refundEventIds', 'refundItemIds', 'refundLineEventIds']) input.coverage[key] = [];
  Object.assign(input.coverage.lineTotals[0], { cumulativeReturnedQuantity: '0.000', cumulativeReturnedItemValueMinor: 0 });
  const result = project(input); check(result.saleLines[0].remainingNetCents === 100 && result.saleLines[0].remainingQuantity === '3.000');
  input.refundEvents.push({ ...fixture().refundEvents[0], itemAttributionStatus: 'not_applicable' });
  input.coverage.refundHeaderIds = [id(11)]; input.coverage.refundEventIds = [id(21)];
  check(project(input).saleLines[0].refundCents === 0, 'nonmerchandise payout has no merchandise deduction');
}
{
  const input = fixture(); input.period = { from: '2026-10-01', to: '2026-10-31' };
  const result = project(input); check(result.saleLines[0].inEarningPeriod === false && result.saleLines[0].recognizedLocalDate === '2026-09-01');
}
{
  const input = fixture(), second = { ...clone(input.saleLines[0]), saleLineEventId: id(70), orderItemId: id(71),
    pricingLineId: id(72), sellerId: id(73), quantity: '0.125', grossMinor: 0, discountMinor: 0, netMinor: 0 };
  input.saleLines.push(second); input.coverage.saleLineEventIds.push(id(70));
  input.coverage.lineTotals.push({ saleLineEventId: id(70), cumulativeReturnedQuantity: '0.000', cumulativeReturnedItemValueMinor: 0 });
  const output = project(input);
  check(output.saleLines.length === 2 && output.saleLines[1].sellerId === id(73) && output.saleLines[1].remainingQuantity === '0.125');
  const shuffled = clone(input); shuffled.saleLines.reverse(); shuffled.coverage.saleLineEventIds.reverse(); shuffled.coverage.lineTotals.reverse();
  assert.deepEqual(project(shuffled), output); checks++;
  input.saleLines[1].pricingLineId = id(7);
  assert.throws(() => project(input), { code: 'payroll_refund_earnings_duplicate_identity' }); checks++;
}
{
  // A one-cent product returned in fractional quantities proves cumulative,
  // rather than independently rounded, refund allocation (0,1,0 cents).
  const input = fixture(); Object.assign(input.saleLines[0], { grossMinor: 1, discountMinor: 0, netMinor: 1 });
  Object.assign(input.refundLines[0], { previousReturnedItemValueMinor: 0, returnedItemValueMinor: 0, cumulativeReturnedItemValueMinor: 0 });
  Object.assign(input.refundLines[1], { previousReturnedItemValueMinor: 0, returnedItemValueMinor: 1, cumulativeReturnedItemValueMinor: 1 });
  input.coverage.lineTotals[0].cumulativeReturnedItemValueMinor = 1;
  check(project(input).saleLines[0].remainingNetCents === 0 && project(input).saleLines[0].remainingQuantity === '1.000');
}
{
  const input = fixture();
  input.refundEvents[0].recognizedAt = '2026-09-01T12:00:00.123455Z'; input.refundEvents[0].recognizedLocalDate = '2026-09-01';
  assert.throws(() => project(input), { code: 'payroll_refund_earnings_refund_lineage_invalid' }); checks++;
  input.refundEvents[0].recognizedAt = '2026-09-01T12:00:00.123456Z';
  check(project(input).recognitionHistory.refundEvents[0].recognizedAt.endsWith('.123456Z'));
}
{
  const input = fixture(); input.refundEvents.splice(1); input.coverage.refundHeaderIds.splice(1); input.coverage.refundEventIds.splice(1);
  input.refundLines[1].refundId = id(11); input.refundLines[1].refundEventId = id(21);
  assert.throws(() => project(input), { code: 'payroll_refund_earnings_duplicate_identity' }); checks++;
}
for (const mutate of [
  x => { x.schemaVersion = 2; }, x => { x.currency = 'USD'; }, x => { x.manifestWatermark = 'bad'; },
  x => { x.extra = true; }, x => { delete x.saleLines; }, x => { x.period.to = '2026-10-01'; },
  x => { x.period.from = '2026-09-31'; }, x => { x.venueId = ['bad']; }, x => { x.saleLines[0].venueId = id(99); },
  x => { x.saleLines[0].currency = 'USD'; }, x => { x.saleLines[0].netMinor = 99; },
  x => { x.saleLines[0].discountMinor = -1; }, x => { x.saleLines[0].grossMinor = Number.MAX_SAFE_INTEGER + 1; },
  x => { x.saleLines[0].quantity = '0.000'; }, x => { x.saleLines[0].quantity = '3.0001'; },
  x => { x.saleLines[0].quantity = '03.000'; }, x => { x.saleLines[0].quantity = 3; },
  x => { x.saleLines[0].recognizedAt = '2026-09-01T12:00:00.123Z'; },
  x => { x.saleLines[0].recognizedAt = '2026-09-01T25:00:00.123456Z'; },
  x => { x.saleLines[0].soldAt = at('2026-09-02'); }, x => { x.saleLines[0].timezoneSnapshot = 'Invalid/Zone'; },
  x => { x.saleLines[0].recognizedLocalDate = '2026-09-02'; }, x => { x.saleLines[0].productFacts.productId = null; },
  x => { x.saleLines.push(clone(x.saleLines[0])); }, x => { x.refundEvents.push(clone(x.refundEvents[0])); },
  x => { x.refundLines.push(clone(x.refundLines[0])); },
  x => { x.refundEvents[1].refundId = x.refundEvents[0].refundId; },
  x => { x.refundEvents[0].currency = 'USD'; }, x => { x.refundEvents[0].venueId = id(99); },
  x => { x.refundEvents[0].originalSaleEventId = id(99); }, x => { x.refundEvents[0].tenderTotalMinor++; },
  x => { x.refundEvents[0].itemAttributionStatus = 'unattributed'; }, x => { x.refundEvents[0].itemAttributionStatus = 'not_applicable'; },
  x => { x.refundEvents[0].recognizedAt = at('2026-08-01'); x.refundEvents[0].recognizedLocalDate = '2026-08-01'; },
  x => { x.refundEvents[0].recognizedLocalDate = '2026-10-03'; },
  ...['venueId', 'refundId', 'refundEventId', 'orderId', 'orderItemId', 'snapshotId', 'originalSaleEventId', 'originalSaleLineEventId']
    .map(key => x => { x.refundLines[0][key] = id(99); }),
  x => { x.refundLines[1].refundItemId = x.refundLines[0].refundItemId; },
  x => { x.refundLines[1].refundLineEventId = x.refundLines[0].refundLineEventId; },
  x => { x.refundLines[1].producerSequence = 1; }, x => { x.refundLines[0].producerSequence = 2; },
  x => { x.refundLines[0].producerSequence = '1'; }, x => { x.refundLines[0].returnedQuantity = '0.000'; },
  x => { x.refundLines[1].previousReturnedQuantity = '0.000'; }, x => { x.refundLines[1].previousReturnedItemValueMinor = 32; },
  x => { x.refundLines[1].cumulativeReturnedQuantity = '4.000'; }, x => { x.refundLines[1].cumulativeReturnedItemValueMinor = 101; },
  x => { x.refundLines[1].returnedItemValueMinor = 33; x.refundLines[1].cumulativeReturnedItemValueMinor = 66; },
  x => { x.coverage.status = 'incomplete'; }, x => { x.coverage.scope = 'period_only'; },
  x => { x.coverage.sourceWatermark = 'b'.repeat(64); }, x => { x.coverage.lineTotals = []; },
  x => { x.coverage.lineTotals[0].cumulativeReturnedItemValueMinor = 66; },
  x => { x.coverage.lineTotals[0].cumulativeReturnedQuantity = '1.000'; },
  ...['saleLineEventIds', 'orderIds', 'refundHeaderIds', 'refundEventIds', 'refundItemIds', 'refundLineEventIds']
    .flatMap(key => [x => { x.coverage[key].pop(); }, x => { x.coverage[key].push(x.coverage[key][0]); }]),
  x => { x.coverage.lineTotals.push(clone(x.coverage.lineTotals[0])); },
  x => { x.refundLines[0].returnedItemValueMinor = -1; }, x => { x.saleLines = new Array(1); },
  x => { x.saleLines[0].productFacts.self = x.saleLines[0].productFacts; },
  x => { x.saleLines[0].productFacts.bad = undefined; }, x => { x.saleLines[0].netMinor = NaN; },
  x => { x.saleLines[0].productFacts[Symbol('x')] = 1; },
  x => { Object.defineProperty(x.saleLines[0], 'quantity', { get() { assert.fail('getter must not execute'); }, enumerable: true }); },
  x => { x.saleLines = Array(20001).fill(x.saleLines[0]); }
]) invalid(mutate);
console.log(`PASS payroll-refund-earnings-projection-contract: ${checks} pure checks; no source attestation, engine eligibility, persistence or PG claim`);
