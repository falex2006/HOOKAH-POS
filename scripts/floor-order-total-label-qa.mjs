import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const helper = source.match(/function tableOrderTotalLabel\(orders\)\s*\{[\s\S]*?\n\}/)?.[0];
assert.ok(helper, 'floor total label helper is present');
const label = vm.runInNewContext(`(${helper})`);

assert.equal(label([]), '', 'empty table has no order amount');
assert.equal(label([{ status: 'closed', pricingTotal: 900 }]), '', 'closed order has no floor amount');
assert.equal(label([{ status: 'open', pricingTotal: 0 }]), 'Заказ 0 ₽', 'zero priced active order is explicit');
assert.equal(label([{ status: 'open', pricingTotal: 120.25 }, { status: 'ready', pricingTotal: 79.75 }, { status: 'closed', pricingTotal: 500 }]), 'Заказ 200 ₽', 'multiple active order totals sum in cents; closed history is excluded');
assert.equal(label([{ status: 'in_progress', pricingTotal: null }]), 'Заказ —', 'missing canonical pricing does not become zero');
assert.equal(label([{ status: 'open', pricingTotal: 100 }, { status: 'ready', pricingTotal: -1 }]), 'Заказ —', 'invalid canonical pricing does not produce a misleading sum');

console.log('FLOOR ORDER TOTAL LABEL QA: PASS');
