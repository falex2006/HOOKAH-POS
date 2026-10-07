import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { calculatePayrollScheme: calculate } = require('../payroll-schemes.js');
const { reconcilePayrollSnapshotResult: reconcile } = require('../payroll-snapshot-reconciliation.js');
const { calculateTargetIncentive } = require('../payroll-incentive-math.js');
const fixture = (mode = 'stable_percent') => ({ scheme: { id: 's', versionId: 'v', mode, roleParameters: { bar: {
  perShiftCents: 1000, stableRateBps: 1000, bracketRatesBps: { 0: 1000 }, targetCents: 5000, baseRateBps: 1000, bonusRateBps: 2000,
  excessRatePolicy: 'replace_base', lossPolicy: 'offset_daily_losses', itemRuleBasis: 'net_revenue', teamWeight: 1,
  teamFund: { poolId: 'pool', targetCents: 5000, baseRateBps: 1000, bonusRateBps: 2000, excessRatePolicy: 'replace_base', departments: ['bar'], distributionPolicy: 'configured_weights' }
} }, employeeOverrides: [], itemRules: [] }, periodFrom: '2026-10-01', periodTo: '2026-10-01', employees: [{ id: 'a' }, { id: 'zero' }],
roleAssignments: [{ employeeId: 'a', roleId: 'bar', effectiveFrom: '2026-10-01' }, { employeeId: 'zero', roleId: 'empty', effectiveFrom: '2026-10-01' }],
attendance: [{ id: 'shift', employeeId: 'a', date: '2026-10-01', approved: true, workedMinutes: 60, plannedMinutes: 60 }],
coverage: { kind: 'month_to_date_complete', from: '2026-10-01', through: '2026-10-01', complete: true, watermark: 'scenario' },
attendanceCoverage: { kind: 'approved_attendance_complete', from: '2026-10-01', through: '2026-10-01', complete: true, watermark: 'scenario' },
sales: [{ id: 'sale', employeeId: 'a', menuItemId: 'menu', department: 'bar', date: '2026-10-01', turnoverCents: 10000, commissionBaseCents: 10000,
  costSnapshot: { id: 'cost', version: 'v', currency: 'RUB', costCents: 1000 } }] });
const resultFor = (mode) => {
  const input = fixture(mode); input.scheme.roleParameters.empty = { mode: 'percent_only', stableRateBps: 0 };
  if (mode === 'final_month_threshold') {
    input.periodTo = '2026-10-31'; input.coverage = { ...input.coverage, kind: 'month_closed_complete', through: '2026-10-31' };
    input.attendanceCoverage.through = '2026-10-31'; input.monthClosed = true;
  }
  const result = calculate(input); assert.equal(result.payoutEligible, true); return result;
};
for (const mode of ['progressive_daily', 'stable_percent', 'percent_only', 'final_month_threshold', 'personal_target', 'team_fund', 'margin_target']) {
  const result = resultFor(mode); const before = structuredClone(result);
  assert.equal(reconcile(result).arithmeticValidated, true, mode); assert.deepEqual(result, before, 'no mutation');
}
const cappedInput = fixture('progressive_daily'); cappedInput.scheme.roleParameters.empty = { mode: 'percent_only', stableRateBps: 0 };
cappedInput.scheme.roleParameters.bar.cap = { basis: 'venue_day', rateBps: 500 };
cappedInput.scheme.roleParameters.bar.milestoneBonusesCents = { 1: 1000 };
cappedInput.scheme.milestoneCapPolicy = 'separate_from_shift_cap';
const capped = calculate(cappedInput); assert.equal(capped.daily[0].employees[0].amountCents, 1500);
assert.equal(reconcile(capped).arithmeticValidated, true, 'milestone above shift cap allowed');
cappedInput.scheme.milestoneCapPolicy = 'included_in_cap'; assert.equal(reconcile(calculate(cappedInput)).arithmeticValidated, true);
const tamper = (mode, edit, expected) => {
  const result = resultFor(mode); edit(result);
  assert.throws(() => reconcile(result), (error) => error instanceof TypeError && error.code === `payroll_reconciliation_${expected}`);
};
tamper('stable_percent', (r) => r.status = 'blocked', 'result_not_ready');
tamper('stable_percent', (r) => r.payoutEligible = false, 'result_not_ready');
tamper('stable_percent', (r) => r.daily[0].employees[0].amountBeforeCapCents++, 'components_mismatch');
tamper('stable_percent', (r) => r.daily[0].employees[0].amountCents++, 'cap_reduction_mismatch');
tamper('stable_percent', (r) => r.employees[0].commissionCents++, 'period_total_mismatch');
tamper('stable_percent', (r) => r.daily[0].lines[0].commissionCents++, 'scalar_commission_mismatch');
tamper('stable_percent', (r) => r.daily[0].lines[0].employeeId = 'missing', 'line_employee_mismatch');
tamper('stable_percent', (r) => r.daily[0].employees[0].shiftDetails[0].amountCents++, 'shift_pay_mismatch');
tamper('stable_percent', (r) => r.daily[0].employees[0].shifts++, 'shift_count_mismatch');
tamper('stable_percent', (r) => r.daily.push(structuredClone(r.daily[0])), 'day_invalid');
tamper('stable_percent', (r) => r.daily[0].lines.push(structuredClone(r.daily[0].lines[0])), 'line_duplicate');
tamper('stable_percent', (r) => r.employees.push(structuredClone(r.employees[0])), 'employee_duplicate');
tamper('final_month_threshold', (r) => r.daily.pop(), 'day_coverage_missing');
tamper('stable_percent', (r) => r.daily[0].employees[0].itemAdjustmentsCents = 1, 'item_adjustment_unsupported');
tamper('stable_percent', (r) => r.daily[0].employees[0].basePayCents = null, 'money_invalid');
tamper('personal_target', (r) => r.daily[0].lines[0].targetAllocation.baseCommissionCents++, 'line_incentive_mismatch');
tamper('personal_target', (r) => r.daily[0].employees[0].targetIncentive.baseCommissionCents++, 'incentive_components_mismatch');
tamper('team_fund', (r) => r.daily[0].teamFunds[0].allocations[0].amountCents++, 'pool_conservation');
tamper('team_fund', (r) => r.daily[0].teamFunds[0].memberIds.push('missing'), 'pool_members_mismatch');
tamper('team_fund', (r) => r.daily[0].teamFunds[0].sourceLineIds = [], 'pool_source_mismatch');
tamper('team_fund', (r) => r.daily[0].teamFunds[0].basisCents++, 'incentive_formula_mismatch');
tamper('team_fund', (r) => r.daily[0].lines[0].teamFundSource.poolId = 'missing', 'pool_source_mismatch');
tamper('margin_target', (r) => r.daily[0].lines[0].costSnapshot.costCents++, 'margin_cost_mismatch');
tamper('margin_target', (r) => r.daily[0].employees[0].marginIncentive.signedMarginCents++, 'signed_margin_mismatch');
tamper('margin_target', (r) => r.daily[0].employees[0].marginIncentive.lossOffsetCents++, 'loss_offset_mismatch');
const additiveInput = fixture('margin_target'); additiveInput.scheme.roleParameters.empty = { mode: 'percent_only', stableRateBps: 0 };
additiveInput.scheme.itemRules = [{ menuItemId: 'menu', roleId: 'bar', mode: 'additive', rateBps: 1000 }];
assert.equal(reconcile(calculate(additiveInput)).arithmeticValidated, true, 'ordinary item addition already inside commission');
tamper('personal_target', (r) => r.daily[0].employees[0].targetIncentive.baseRateBps++, 'incentive_formula_mismatch');
const overtime = resultFor('stable_percent'); overtime.daily[0].employees[0].shiftDetails[0].workedMinutes = 120;
assert.equal(reconcile(overtime).arithmeticValidated, true, 'worked minutes alone do not establish pay entitlement');
for (const mode of ['personal_target', 'margin_target']) {
  const input = fixture(mode); input.scheme.roleParameters.empty = { mode: 'percent_only', stableRateBps: 0 };
  input.sales = [0, 1].map((index) => ({ ...input.sales[0], id: `split${index}`, commissionBaseCents: 5000, turnoverCents: 5000,
    costSnapshot: { ...input.sales[0].costSnapshot, costCents: 500 } }));
  const split = calculate(input); assert.equal(reconcile(split).arithmeticValidated, true);
  const key = mode === 'personal_target' ? 'targetAllocation' : 'marginAllocation';
  split.daily[0].lines[0][key].baseCommissionCents++; split.daily[0].lines[0].commissionCents++;
  split.daily[0].lines[1][key].baseCommissionCents--; split.daily[0].lines[1].commissionCents--;
  assert.throws(() => reconcile(split), (error) => error.code === 'payroll_reconciliation_line_distribution_mismatch', 'coherent transferred cent must fail deterministic distribution');
}
const coherentScalar = resultFor('stable_percent'); coherentScalar.daily[0].lines[0].commissionCents++;
for (const row of [coherentScalar.daily[0].employees[0], coherentScalar.employees[0]]) for (const field of ['commissionCents', 'amountBeforeCapCents', 'amountCents']) row[field]++;
assert.throws(() => reconcile(coherentScalar), (error) => error.code === 'payroll_reconciliation_scalar_commission_mismatch');
const hiddenSource = resultFor('team_fund'), pool = hiddenSource.daily[0].teamFunds[0];
Object.assign(pool, calculateTargetIncentive({ basisCents: 0, targetCents: pool.targetCents, baseRateBps: pool.baseRateBps, bonusRateBps: pool.bonusRateBps, excessRatePolicy: pool.excessRatePolicy }));
pool.fundCents = 0; pool.sourceLineIds = []; for (const allocation of pool.allocations) allocation.amountCents = 0;
hiddenSource.daily[0].lines[0].teamFundSource.included = false; hiddenSource.daily[0].lines[0].teamFundSource.basisCents = 0;
for (const row of [hiddenSource.daily[0].employees[0], hiddenSource.employees[0]]) { row.teamFundCents = 0; row.amountBeforeCapCents = row.basePayCents; row.amountCents = row.basePayCents; }
assert.throws(() => reconcile(hiddenSource), (error) => error.code === 'payroll_reconciliation_pool_line_eligibility_mismatch');
tamper('margin_target', (r) => r.daily[0].employees[0].marginIncentive.lossPolicy = 'clamp', 'margin_policy_invalid');
tamper('margin_target', (r) => r.daily[0].lines[0].appliedRateBps = 0, 'typed_line_rate_invalid');
tamper('margin_target', (r) => r.daily[0].lines[0].marginAllocation.payableBasisCents++, 'margin_basis_alias_mismatch');
const inventedTeamRate = resultFor('team_fund');
Object.assign(inventedTeamRate.daily[0].lines[0], { baseRateBps: 1000, appliedRateBps: 1000, commissionCents: 1000 });
for (const row of [inventedTeamRate.daily[0].employees[0], inventedTeamRate.employees[0]]) for (const field of ['commissionCents', 'amountBeforeCapCents', 'amountCents']) row[field] += 1000;
assert.throws(() => reconcile(inventedTeamRate), (error) => error.code === 'payroll_reconciliation_team_base_rate_invalid');
console.log('PAYROLL SNAPSHOT RECONCILIATION CONTRACT: PASS (all modes, capped milestone, typed evidence and tamper failures)');
