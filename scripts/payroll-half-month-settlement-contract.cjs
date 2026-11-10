'use strict';
const assert = require('node:assert/strict');
const { reconcilePayrollHalfMonthSettlement: reconcile } = require('../payroll-half-month-settlement');
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const venueId = id(1), employeeId = id(2), runId = id(3), entryId = id(4);
const base = () => ({ venueId, month: '2026-10', currency: 'RUB', monthClosed: true, sourcesFresh: true,
  monthlyGrossByEmployee: [{ employeeId, grossMinor: 10001 }],
  h2GrossByEmployee: [{ employeeId, grossMinor: 8001 }],
  h1States: [{ venueId, employeeId, month: '2026-10', currency: 'RUB', runId, entryId, claimId: id(5),
    period: { from: '2026-10-01', to: '2026-10-14' }, status: 'approved', usableForH2: true,
    grossAccruedMinor: 2000, netDueMinor: 1800, appliedCorrectionMinor: 200, paidMinor: 0 }] });
let checks = 0;
const ok = (value, label) => { assert.ok(value, label); checks++; };
const equal = (actual, expected, label) => { assert.deepEqual(actual, expected, label); checks++; };
const rejected = (input, code) => {
  const result = reconcile(input);
  equal(result.status, 'blocked', code);
  ok(result.reasons.includes(code), `${code}: reason`);
  equal([result.officialReady, result.payoutEligible, result.settlementAuthorized, result.persistence],
    [false, false, false, 'none'], `${code}: no authority`);
};

{
  const input = base();
  const result = reconcile(input);
  equal(result.status, 'h2_reconciled_candidate');
  const item = result.items[0];
  equal([item.monthlyGrossMinor, item.h1GrossAccruedMinor, item.h2GrossAccruedMinor], [10001, 2000, 8001],
    '100.01 total keeps exact kopecks and subtracts H1 gross');
  equal([item.h1NetDueMinor, item.h1PaidMinor, item.h1OutstandingPayableMinor, item.h1AppliedCorrectionMinor],
    [1800, 0, 1800, 200], 'unpaid H1 remains separate payable; its correction is not deducted from H2');
  equal(result.items[0].period, { from: '2026-10-15', to: '2026-10-31' });
  equal([result.officialReady, result.payoutEligible, result.settlementAuthorized, result.persistence],
    [false, false, false, 'none'], 'pure reconciler never authorizes settlement');
}
{
  const input = base();
  input.h1States[0] = { ...input.h1States[0], status: 'paid', paidMinor: 1800 };
  const result = reconcile(input);
  equal(result.status, 'h2_reconciled_candidate');
  equal(result.items[0].h1OutstandingPayableMinor, 0, 'already-paid H1 is not included in H2 amount');
}
{
  const input = base(); input.h1States[0] = { ...input.h1States[0], usableForH2: false };
  rejected(input, 'payroll_half_month_h1_not_usable');
}
{
  const input = base(); input.h2GrossByEmployee[0].grossMinor = 8000;
  rejected(input, 'payroll_half_month_h2_calculation_mismatch');
}
{
  const input = base(); input.monthlyGrossByEmployee[0].grossMinor = 1999;
  rejected(input, 'payroll_half_month_negative_residual_requires_review');
}
{
  const input = base(); input.h1States[0] = { ...input.h1States[0], month: '2026-09' };
  rejected(input, 'payroll_half_month_h1_binding_mismatch');
}
{
  const input = base(); input.h1States[0] = { ...input.h1States[0], venueId: id(99) };
  rejected(input, 'payroll_half_month_h1_binding_mismatch');
}
{
  const input = base(); input.monthClosed = false;
  rejected(input, 'payroll_half_month_month_context_unverified');
}
{
  const input = base(); input.h1States[0] = { ...input.h1States[0], grossAccruedMinor: 2000,
    netDueMinor: 1801, appliedCorrectionMinor: 200 };
  rejected(input, 'payroll_half_month_h1_ledger_mismatch');
}
{
  const input = base(); input.h1States.push({ ...input.h1States[0] });
  rejected(input, 'payroll_half_month_h1_state_invalid');
}
{
  const input = base(); input.h1States[0] = { ...input.h1States[0], paidMinor: 1801 };
  rejected(input, 'payroll_half_month_h1_ledger_mismatch');
}

console.log(`payroll-half-month-settlement-contract: ok (${checks} checks; no DB/API authority)`);
