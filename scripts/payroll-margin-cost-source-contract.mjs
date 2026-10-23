import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { buildPayrollMarginCostSource: build } = require('../payroll-margin-cost-source');
const id = n => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;
const hash = 'a'.repeat(64), period = { from: '2026-10-01', to: '2026-10-19' };
const source = {
  venueId: id(1), currency: 'RUB', period,
  recognitionManifest: { schemaVersion: 1, status: 'available', venueId: id(1), currency: 'RUB', period,
    watermark: hash, sales: [{ orderId: id(2), eventId: id(3) }], refundEvents: [],
    relatedRefundCoverage: { schemaVersion: 1, status: 'complete',
      scope: 'all_recorded_refunds_for_payroll_related_orders_as_of_repeatable_read_snapshot', sourceWatermark: hash,
      periodSaleOrderIds: [id(2)], coveredOrderIds: [id(2)], relatedRefundHeaderIds: [], relatedRefundEventIds: [],
      relatedRefundItemIds: [], relatedRefundLineEventIds: [] },
    saleLines: [4, 5].map(n => ({ venueId: id(1), saleLineEventId: id(n + 10), saleEventId: id(3), orderId: id(2),
      orderItemId: id(n), quantity: '2', productFacts: { productId: id(6) } })) },
  evidenceByOrder: [{ schemaVersion: 1, policyVersion: 1, scope: 'sale_depletion_cost', status: 'complete', reasons: [],
    venueId: id(1), orderId: id(2), currency: 'RUB', valuationMethod: 'ingredient_cost_at_depletion_v1',
    refundAdjustedReady: false, watermark: 'b'.repeat(64), totalCostMinor: 3,
    allocation: { status: 'complete', totalCostMinor: 3, lines: [4, 5].map((n, i) => ({ orderItemId: id(n),
      productId: id(6), quantity: '2.000000', totalCostMinor: 2 - i })) } }]
};
const result = build(source);
assert.equal(result.status, 'available');
assert.deepEqual(result.rows.map(row => row.costSnapshot.costCents), [2, 1], 'full line cost must not be multiplied by quantity');
assert.equal(result.officialReady, false); assert.equal(result.refundAdjustedReady, false);
assert.equal(result.coverage.complete, true);
const permutation = structuredClone(source);
permutation.recognitionManifest.saleLines.reverse(); permutation.evidenceByOrder[0].allocation.lines.reverse();
assert.deepEqual(build(permutation), result);
const bad = mutate => { const input = structuredClone(source); mutate(input); const output = build(input);
  assert.equal(output.status, 'incomplete'); assert.deepEqual(output.rows, []); assert.equal(output.coverage.complete, false); };
bad(x => x.evidenceByOrder.pop());
bad(x => x.evidenceByOrder.push(x.evidenceByOrder[0]));
bad(x => x.evidenceByOrder[0].allocation.lines.pop());
bad(x => x.evidenceByOrder[0].allocation.lines[1] = x.evidenceByOrder[0].allocation.lines[0]);
bad(x => x.evidenceByOrder[0].allocation.lines[0].quantity = '1');
bad(x => x.evidenceByOrder[0].allocation.lines[0].productId = id(9));
bad(x => x.evidenceByOrder[0].allocation.lines[0].totalCostMinor = Number.MAX_SAFE_INTEGER + 1);
bad(x => x.evidenceByOrder[0].allocation.lines[0].totalCostMinor = -1);
bad(x => x.evidenceByOrder[0].allocation.lines[0].totalCostMinor = 3);
bad(x => x.evidenceByOrder[0].status = 'incomplete');
bad(x => x.evidenceByOrder[0].venueId = id(9));
bad(x => x.evidenceByOrder[0].watermark = 'invalid');
bad(x => x.evidenceByOrder[0].reasons.push('valuation_zero_unattested'));
bad(x => x.recognitionManifest.relatedRefundCoverage.relatedRefundHeaderIds.push(id(9)));
bad(x => x.recognitionManifest.relatedRefundCoverage.relatedRefundItemIds.push(id(9)));
bad(x => x.recognitionManifest.refundEvents.push({}));
bad(x => x.recognitionManifest.status = 'incomplete');
bad(x => x.recognitionManifest.saleLines[0].saleEventId = id(9));
bad(x => x.recognitionManifest.saleLines.push(x.recognitionManifest.saleLines[0]));
bad(x => x.period = { from: '2026-02-30', to: '2026-02-30' });
const changed = structuredClone(source); changed.evidenceByOrder[0].watermark = 'c'.repeat(64);
assert.notEqual(build(changed).sourceWatermark, result.sourceWatermark);
const empty = structuredClone(source);
empty.recognitionManifest.sales = []; empty.recognitionManifest.saleLines = [];
empty.recognitionManifest.relatedRefundCoverage.periodSaleOrderIds = [];
empty.recognitionManifest.relatedRefundCoverage.coveredOrderIds = []; empty.evidenceByOrder = [];
assert.equal(build(empty).status, 'available', 'proven empty recognition period permits empty costs');
assert.deepEqual(build(empty).rows, []);
empty.recognitionManifest.status = 'incomplete';
assert.equal(build(empty).status, 'incomplete', 'missing recognition coverage is never an empty period');
const freeze = x => { if (x && typeof x === 'object') { Object.values(x).forEach(freeze); Object.freeze(x); } return x; };
assert.deepEqual(build(freeze(source)), result);
assert.equal(build().status, 'incomplete');
console.log('PAYROLL MARGIN COST SOURCE CONTRACT: PASS');
