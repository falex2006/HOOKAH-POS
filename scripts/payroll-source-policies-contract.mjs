import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { PAYROLL_SOURCE_POLICY_V1, PAYROLL_SOURCE_POLICY_V2, PAYROLL_REMAINING_NET_EARNINGS_POLICY,
  PAYROLL_REFUND_ADJUSTED_VENUE_TURNOVER_POLICY, PAYROLL_FROZEN_SALE_DEPLETION_COST_PAYROLL_POLICY,
  normalizePayrollSourcePolicies: normalize, requiredPayrollSourceFacts: facts } = createRequire(import.meta.url)('../payroll-source-policies.js');
const fixture = () => ({ schemaVersion: 1, selectionReason: '  Владелец выбрал построчный расчёт  ', saleCredit: { kind: 'line_seller_snapshot' },
  discountAllocation: { kind: 'immutable_line_snapshot' }, refunds: { recognition: 'recognized_event_date', closedRunTreatment: 'next_open_run_adjustment',
    paidAdjustment: 'owner_review_variable_pay_only', uncoveredBalance: 'carry_forward_review', clawback: 'no_automatic_clawback' } });
assert.equal(normalize(undefined), undefined); assert.deepEqual(facts(undefined), ['explicit_owner_source_policy_selection']);
const input = fixture(), before = structuredClone(input), normalized = normalize(input);
assert.deepEqual(input, before); assert.equal(normalized.selectionReason, input.selectionReason.trim());
assert.equal(PAYROLL_SOURCE_POLICY_V1, 1); assert.equal(PAYROLL_SOURCE_POLICY_V2, 2);
assert.deepEqual(normalized, { schemaVersion: 1, selectionReason: 'Владелец выбрал построчный расчёт', saleCredit: { kind: 'line_seller_snapshot' },
  discountAllocation: { kind: 'immutable_line_snapshot' }, refunds: { recognition: 'recognized_event_date', closedRunTreatment: 'next_open_run_adjustment',
    paidAdjustment: 'owner_review_variable_pay_only', uncoveredBalance: 'carry_forward_review', clawback: 'no_automatic_clawback' } },
'legacy v1 normalized output remains byte-compatible');
normalized.saleCredit.kind = 'changed'; assert.equal(input.saleCredit.kind, 'line_seller_snapshot');
for (const credit of ['line_seller_snapshot', 'order_responsible_snapshot', 'explicit_line_allocation']) for (const discount of ['immutable_line_snapshot', 'eligible_gross_proportional_fixed_order']) for (const recognition of ['recognized_event_date', 'original_sale_period_correction']) {
  const value = fixture(); value.saleCredit.kind = credit; value.discountAllocation = discount === 'immutable_line_snapshot' ? { kind: discount } : {
    kind: discount, rounding: 'largest_remainder_code_unit_v1', eligibility: 'pricing_source_snapshot' }; value.refunds.recognition = recognition;
  assert.equal(normalize(value).saleCredit.kind, credit); assert.ok(facts(value).length > 10);
  const result = facts(value); result.push('tampered'); assert.ok(!facts(value).includes('tampered'));
}
const reject = (edit) => { const value = fixture(); edit(value); assert.throws(() => normalize(value), (error) => error instanceof TypeError && error.code.startsWith('payroll_')); };
for (const value of [null, [], {}, 'policy', 1, true, Object.create(null)]) assert.throws(() => normalize(value));
reject((v) => v.schemaVersion = 2); reject((v) => v.schemaVersion = '1');
reject((v) => v.selectionReason = 'ab'); reject((v) => v.selectionReason = 'x'.repeat(1001)); reject((v) => v.selectionReason = null);
reject((v) => v.unknown = true); reject((v) => delete v.refunds); reject((v) => v.saleCredit.kind = 'opened_by');
reject((v) => v.saleCredit.employeeId = 'guess'); reject((v) => v.saleCredit = []); reject((v) => v.saleCredit.kind = {});
reject((v) => v.discountAllocation.rounding = 'largest_remainder_code_unit_v1');
reject((v) => v.discountAllocation = { kind: 'eligible_gross_proportional_fixed_order', rounding: 'guess', eligibility: 'pricing_source_snapshot' });
reject((v) => v.refunds.clawback = 'automatic'); reject((v) => v.refunds.extra = true); reject((v) => v.refunds.recognition = 'payment_status');
reject((v) => v.saleCredit = Object.create({ kind: 'line_seller_snapshot' }));
reject((v) => Object.defineProperty(v.saleCredit, '__proto__', { value: {}, enumerable: true }));
reject((v) => Object.defineProperty(v.refunds, 'constructor', { value: {}, enumerable: true }));
reject((v) => Object.defineProperty(v, Symbol('hidden'), { value: true }));
reject((v) => Object.defineProperty(v, 'selectionReason', { get() { throw new Error('getter must not run'); } }));
reject((v) => Object.defineProperty(v.discountAllocation, 'kind', { get() { throw new Error('nested getter must not run'); } }));
reject((v) => Object.setPrototypeOf(v.discountAllocation, { kind: 'immutable_line_snapshot' }));
assert.throws(() => normalize(JSON.parse('{"__proto__":{},"schemaVersion":1}')));
assert.equal({}.polluted, undefined);
const v2 = () => ({ schemaVersion: 2, selectionReason: 'Owner explicitly opted into refund-aware payroll incentive basis',
  saleCredit: { kind: 'line_seller_snapshot' }, discountAllocation: { kind: 'immutable_line_snapshot' },
  refunds: { recognition: 'recognized_event_date', closedRunTreatment: 'next_open_run_adjustment', paidAdjustment: 'owner_review_variable_pay_only',
    uncoveredBalance: 'carry_forward_review', clawback: 'no_automatic_clawback' },
  earnings: { refunds: PAYROLL_REMAINING_NET_EARNINGS_POLICY, venueTurnover: PAYROLL_REFUND_ADJUSTED_VENUE_TURNOVER_POLICY,
    marginCost: PAYROLL_FROZEN_SALE_DEPLETION_COST_PAYROLL_POLICY } });
assert.deepEqual(normalize(v2()), v2());
assert.equal(normalize(undefined), undefined, 'v2 is never selected by default');
const v2facts = facts(v2());
for (const required of ['versioned_remaining_net_refund_earnings', 'refund_adjusted_canonical_venue_turnover',
  'frozen_original_depletion_cost_for_payroll_incentive', 'immutable_original_period_correction_run_lineage']) assert.ok(v2facts.includes(required));
for (const remove of [v => delete v.earnings, v => delete v.earnings.refunds, v => delete v.earnings.venueTurnover,
  v => delete v.earnings.marginCost, v => delete v.refunds, v => delete v.saleCredit, v => delete v.discountAllocation]) {
  const value = v2(); remove(value); assert.throws(() => normalize(value));
}
for (const edit of [v => v.schemaVersion = '2', v => v.schemaVersion = 1, v => v.saleCredit.kind = 'order_responsible_snapshot',
  v => v.discountAllocation = { kind: 'eligible_gross_proportional_fixed_order', rounding: 'largest_remainder_code_unit_v1', eligibility: 'pricing_source_snapshot' },
  v => v.refunds.recognition = 'original_sale_period_correction', v => v.earnings.refunds = 'actual_cost_after_stock_return',
  v => v.earnings.venueTurnover = 'pre_refund_total', v => v.earnings.marginCost = 'verified_actual_cogs',
  v => v.earnings.marginCost = null, v => v.earnings.extra = true, v => v.earnings = [],
  v => v.earnings = Object.create({ refunds: PAYROLL_REMAINING_NET_EARNINGS_POLICY })]) {
  const value = v2(); edit(value); assert.throws(() => normalize(value), error => error instanceof TypeError && error.code.startsWith('payroll_'));
}
assert.equal(v2().earnings.marginCost, 'frozen_sale_depletion_cost_payroll_v1', 'policy names a payroll incentive basis, not actual COGS or stock-restock proof');
console.log('PAYROLL SOURCE POLICIES CONTRACT: PASS (v1-compatible output, explicit strict v2 opt-in and versioned evidence facts)');
