import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { calculateTargetIncentive: calculate, allocateIncentiveFund: allocate } = require('../payroll-incentive-math.js');

const parameters = { targetCents: 10000, baseRateBps: 1600, bonusRateBps: 4000, excessRatePolicy: 'replace_base' };
assert.equal(calculate({ ...parameters, basisCents: 5000 }).commissionCents, 800);
assert.equal(calculate({ ...parameters, basisCents: 5000 }).roundingPolicy, 'component_half_up_v1');
assert.equal(calculate({ ...parameters, basisCents: 10000 }).commissionCents, 1600);
assert.equal(calculate({ ...parameters, basisCents: 15000 }).commissionCents, 3600);
assert.equal(calculate({ ...parameters, basisCents: 15000, excessRatePolicy: 'add_to_base' }).commissionCents, 4400);
assert.equal(calculate({ ...parameters, basisCents: 15000, targetCents: 0 }).commissionCents, 6000);
assert.equal(calculate({ ...parameters, basisCents: 0 }).commissionCents, 0);
assert.equal(calculate({ ...parameters, basisCents: 1, baseRateBps: 5000 }).commissionCents, 1, 'half cent rounds up');
assert.equal(calculate({ ...parameters, basisCents: 2, targetCents: 1, baseRateBps: 5000, bonusRateBps: 5000 }).commissionCents, 2, 'components round independently');
assert.throws(() => calculate({ ...parameters, basisCents: 1, excessRatePolicy: undefined }), /policy_required/);
for (const value of [-1, 0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '100']) {
  assert.throws(() => calculate({ ...parameters, basisCents: value }), /invalid_basis/);
  assert.throws(() => allocate(value, []), /invalid_fund/);
}
assert.throws(() => calculate({ ...parameters, basisCents: 1, bonusRateBps: 10001 }), /invalid_bonus/);
assert.throws(() => calculate({ ...parameters, basisCents: Number.MAX_SAFE_INTEGER, targetCents: 0, baseRateBps: 10000, bonusRateBps: 10000, excessRatePolicy: 'add_to_base' }), /safe_integer/);
assert.equal(calculate({ ...parameters, basisCents: Number.MAX_SAFE_INTEGER, targetCents: 0, bonusRateBps: 10000 }).commissionCents, Number.MAX_SAFE_INTEGER);

assert.deepEqual(allocate(2, [{ id: 'c', weight: 1 }, { id: 'b', weight: 1 }, { id: 'a', weight: 1 }]), [
  { id: 'a', weight: 1, amountCents: 1 }, { id: 'b', weight: 1, amountCents: 1 }, { id: 'c', weight: 1, amountCents: 0 }
]);
assert.deepEqual(allocate(0, []), []);
assert.deepEqual(allocate(2, [{ id: 'я', weight: 1 }, { id: 'a', weight: 1 }, { id: 'Z', weight: 1 }]).map((row) => [row.id, row.amountCents]), [['Z', 1], ['a', 1], ['я', 0]], 'code-unit ties must not depend on host locale');
assert.deepEqual(allocate(0, [{ id: 'a', weight: 0 }]), [{ id: 'a', weight: 0, amountCents: 0 }]);
assert.throws(() => allocate(1, []), /requires_recipient_weight/);
assert.throws(() => allocate(1, [{ id: 'a', weight: 0 }]), /requires_recipient_weight/);
assert.throws(() => allocate(0, [{ id: 'a', weight: 1 }, { id: 'a', weight: 2 }]), /recipient_id/);
assert.throws(() => allocate(1, [{ id: 'a', weight: -1 }]), /recipient_weight/);
const huge = allocate(Number.MAX_SAFE_INTEGER, [{ id: 'a', weight: Number.MAX_SAFE_INTEGER }, { id: 'b', weight: Number.MAX_SAFE_INTEGER }]);
assert.equal(huge.reduce((sum, row) => sum + BigInt(row.amountCents), 0n), BigInt(Number.MAX_SAFE_INTEGER));
for (let fund = 0; fund <= 50; fund += 1) for (let a = 0; a <= 5; a += 1) for (let b = 0; b <= 5; b += 1) {
  if (!a && !b) continue;
  const rows = [{ id: 'a', weight: a }, { id: 'b', weight: b }, { id: 'zero', weight: 0 }];
  const result = allocate(fund, rows);
  assert.deepEqual(result, allocate(fund, rows.slice().reverse()));
  assert.equal(result.reduce((sum, row) => sum + row.amountCents, 0), fund);
  assert.equal(result.find((row) => row.id === 'zero').amountCents, 0);
  for (const row of result) {
    const quota = fund * row.weight / (a + b);
    assert.ok(row.amountCents === Math.floor(quota) || row.amountCents === Math.ceil(quota));
  }
}
console.log('PAYROLL INCENTIVE MATH CONTRACT: PASS (explicit excess policy, integral rounding, overflow, fund conservation and stable allocation)');
