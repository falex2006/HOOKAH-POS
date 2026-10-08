import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const start = source.indexOf('async function pgOrderPricing(');
const end = source.indexOf('async function writePosOrderPricingSnapshot(', start);
assert.ok(start >= 0 && end > start);
const readPricing = new Function(`${source.slice(start, end)}; return pgOrderPricing;`)();

// Frozen facts must win even when mutable order metadata disagrees.
for (const scenario of [
  { name: 'group wins', source: 'guest_group', group: 'frozen-group', gross: 20000, discount: 2000, base: 200, amount: 20 },
  { name: 'promotion wins over group', source: 'promotion', group: 'frozen-group', gross: 20000, discount: 5000, base: 200, amount: 0 },
  { name: 'manual wins over group', source: 'manual', group: 'frozen-group', gross: 20000, discount: 5000, base: 200, amount: 0 },
  { name: 'zero group basis', source: 'none', group: 'frozen-group', gross: 0, discount: 0, base: 0, amount: 0 },
  { name: 'no group', source: 'promotion', group: null, gross: 20000, discount: 5000, base: null, amount: null },
]) {
  const snapshot = {
    subtotal_minor: scenario.gross, discount_minor: scenario.discount,
    final_total_minor: scenario.gross - scenario.discount, minimum_adjustment_minor: 0,
    discount_source: scenario.source, winner_terms: { promotionId: 'frozen-promotion', version: 2 },
    frozen_terms: { groupDiscountGroupId: scenario.group, groupDiscountPercent: 10, offers: [] }, lines: [],
  };
  const before = structuredClone(snapshot);
  let calls = 0;
  const client = { query: async (sql, params) => {
    assert.match(sql, /^SELECT /, 'canonical pricing reads cannot mutate frozen facts');
    calls++;
    if (sql.includes('FROM orders WHERE')) return { rows: [{ venueId: 'venue-a', groupDiscountGroupId: 'changed-group', groupDiscountBase: 999, groupDiscountAmount: 999 }] };
    if (sql.includes('FROM pos_order_pricing_snapshots')) {
      assert.deepEqual(params, ['venue-a', 'order-a'], 'canonical read stays scoped to order venue');
      return { rows: [snapshot] };
    }
    assert.match(sql, /FROM payments WHERE/);
    return { rows: [{ paid: '10' }] };
  } };
  const pricing = await readPricing(client, 'order-a', 999);
  assert.deepEqual([pricing.groupDiscountBase, pricing.groupDiscountAmount], [scenario.base, scenario.amount], scenario.name);
  assert.equal(pricing.due, (scenario.gross - scenario.discount) / 100, 'mutable minimum cannot reprice a frozen order');
  assert.deepEqual(pricing.selectedPromotion, scenario.source === 'promotion' ? snapshot.winner_terms : null);
  assert.deepEqual(snapshot, before, 'canonical facts remain unchanged');
  assert.equal(calls, 3, 'canonical read never loads current group or promotion policy');
}
console.log('PG ORDER PRICING SNAPSHOT QA: PASS (5 frozen group/offer scenarios)');
