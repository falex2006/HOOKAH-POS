'use strict';

// Owner intent only. Validation/fact requirements execute no source policy and
// establish neither manifest coverage nor authority for an official run.
const fail = (code) => { throw Object.assign(new TypeError(code), { code }); };
const object = (value, keys, code, required = keys) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
      || Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !keys.includes(key))
      || required.some((key) => !Object.hasOwn(value, key))
      || Object.values(Object.getOwnPropertyDescriptors(value)).some((descriptor) => !Object.hasOwn(descriptor, 'value'))) fail(code);
};
const exact = (value, expected, code) => { if (value !== expected) fail(code); };
const normalizePayrollSourcePolicies = (value) => {
  if (value === undefined) return undefined;
  object(value, ['schemaVersion', 'selectionReason', 'saleCredit', 'discountAllocation', 'refunds'], 'payroll_source_policies_invalid');
  exact(value.schemaVersion, 1, 'payroll_source_policies_version_invalid');
  if (typeof value.selectionReason !== 'string' || value.selectionReason.trim().length < 3 || value.selectionReason.trim().length > 1000) fail('payroll_source_policies_reason_invalid');
  object(value.saleCredit, ['kind'], 'payroll_sale_credit_policy_invalid');
  if (!['line_seller_snapshot', 'order_responsible_snapshot', 'explicit_line_allocation'].includes(value.saleCredit.kind)) fail('payroll_sale_credit_policy_invalid');
  object(value.discountAllocation, ['kind', 'rounding', 'eligibility'], 'payroll_discount_policy_invalid', ['kind']);
  if (value.discountAllocation.kind === 'immutable_line_snapshot') object(value.discountAllocation, ['kind'], 'payroll_discount_policy_invalid');
  else if (value.discountAllocation.kind === 'eligible_gross_proportional_fixed_order') {
    object(value.discountAllocation, ['kind', 'rounding', 'eligibility'], 'payroll_discount_policy_invalid');
    exact(value.discountAllocation.rounding, 'largest_remainder_code_unit_v1', 'payroll_discount_policy_invalid');
    exact(value.discountAllocation.eligibility, 'pricing_source_snapshot', 'payroll_discount_policy_invalid');
  } else fail('payroll_discount_policy_invalid');
  object(value.refunds, ['recognition', 'closedRunTreatment', 'paidAdjustment', 'uncoveredBalance', 'clawback'], 'payroll_refund_policy_invalid');
  if (!['recognized_event_date', 'original_sale_period_correction'].includes(value.refunds.recognition)) fail('payroll_refund_policy_invalid');
  for (const [key, expected] of Object.entries({ closedRunTreatment: 'next_open_run_adjustment', paidAdjustment: 'owner_review_variable_pay_only',
    uncoveredBalance: 'carry_forward_review', clawback: 'no_automatic_clawback' })) exact(value.refunds[key], expected, 'payroll_refund_policy_invalid');
  return { schemaVersion: 1, selectionReason: value.selectionReason.trim(), saleCredit: { kind: value.saleCredit.kind },
    discountAllocation: value.discountAllocation.kind === 'immutable_line_snapshot' ? { kind: 'immutable_line_snapshot' } : {
      kind: 'eligible_gross_proportional_fixed_order', rounding: 'largest_remainder_code_unit_v1', eligibility: 'pricing_source_snapshot' },
    refunds: { recognition: value.refunds.recognition, closedRunTreatment: value.refunds.closedRunTreatment,
      paidAdjustment: value.refunds.paidAdjustment, uncoveredBalance: value.refunds.uncoveredBalance, clawback: value.refunds.clawback } };
};
const requiredPayrollSourceFacts = (value) => {
  const policy = normalizePayrollSourcePolicies(value);
  if (policy === undefined) return ['explicit_owner_source_policy_selection'];
  const facts = ['venue_currency_timezone_snapshot', 'consistent_source_watermark_and_full_coverage', 'immutable_sale_portions',
    'finance_full_employee_net_revenue_using_selected_credit_policy', 'approved_attendance_revision',
    'finance_recognized_line_refund_events', 'original_sale_refund_allocation_lineage', 'closed_run_adjustment_lineage',
    'owner_reviewed_variable_pay_adjustments', 'uncovered_adjustment_balance_review'];
  facts.push(...({ line_seller_snapshot: ['immutable_line_seller_identity'], order_responsible_snapshot: ['explicit_immutable_order_payroll_responsible_identity'],
    explicit_line_allocation: ['immutable_employee_line_credit_allocations', 'complete_line_credit_allocation_conservation'] })[policy.saleCredit.kind]);
  facts.push(...(policy.discountAllocation.kind === 'immutable_line_snapshot' ? ['canonical_immutable_line_pricing_snapshot'] : [
    'immutable_selected_fixed_order_discount', 'pricing_source_eligible_portion_gross_snapshot', 'complete_fixed_discount_allocation_conservation']));
  if (policy.refunds.recognition === 'original_sale_period_correction') facts.push('immutable_original_period_correction_run_lineage');
  else facts.push('finance_refund_recognition_date');
  return facts.slice().sort();
};
module.exports = { normalizePayrollSourcePolicies, requiredPayrollSourceFacts };
