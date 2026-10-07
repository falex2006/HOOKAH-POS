import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { calculatePayrollScheme: calculate, validateScheme } = require('../payroll-schemes.js');
const fixture = () => ({
  scheme: { id: 's', versionId: 'v', mode: 'personal_target', roleParameters: { bar: {
    perShiftCents: 0, targetCents: 10000, baseRateBps: 1600, bonusRateBps: 6500, excessRatePolicy: 'replace_base'
  } }, employeeOverrides: [], itemRules: [] },
  periodFrom: '2026-10-01', periodTo: '2026-10-02', employees: [{ id: 'a' }],
  roleAssignments: [{ employeeId: 'a', roleId: 'bar', effectiveFrom: '2026-10-01' }], attendance: [],
  coverage: { kind: 'month_to_date_complete', from: '2026-10-01', through: '2026-10-02', complete: true, watermark: 'scenario' },
  attendanceCoverage: { kind: 'approved_attendance_complete', from: '2026-10-01', through: '2026-10-02', complete: true, watermark: 'scenario' },
  sales: [{ id: '1', employeeId: 'a', date: '2026-10-01', department: 'bar', menuItemId: 'x', turnoverCents: 15000, commissionBaseCents: 15000 }]
});
const amount = (input) => calculate(input).employees[0].commissionCents;
for (const [basis, expected] of [[9999, 1600], [10000, 1600], [10001, 1601], [15000, 4850]]) {
  const input = fixture(); input.sales[0].commissionBaseCents = basis; input.sales[0].turnoverCents = basis;
  assert.equal(amount(input), expected);
}
const additive = fixture(); additive.scheme.roleParameters.bar.excessRatePolicy = 'add_to_base';
assert.equal(amount(additive), 5650);
const reset = fixture(); reset.sales.push({ ...reset.sales[0], id: '2', date: '2026-10-02' });
assert.equal(amount(reset), 9700, 'target resets each day');
const split = fixture(); split.sales = [
  { ...split.sales[0], id: 'z', commissionBaseCents: 7500, turnoverCents: 7500 },
  { ...split.sales[0], id: 'b', commissionBaseCents: 7500, turnoverCents: 7500 }
];
const result = calculate(split);
assert.deepEqual(result, calculate({ ...split, sales: split.sales.slice().reverse() }));
assert.equal(result.daily[0].lines.reduce((sum, row) => sum + row.commissionCents, 0), 4850);
assert.equal(result.daily[0].lines[0].appliedRateBps, null);
assert.equal(result.daily[0].employees[0].targetIncentive.roundingPolicy, 'component_half_up_v1');
const override = fixture(); override.scheme.employeeOverrides = [{ employeeId: 'a', path: 'targetCents', mode: 'override', value: 0 }];
assert.equal(amount(override), 9750);
for (const [path, value] of [['targetCents', -1], ['baseRateBps', 10001], ['bonusRateBps', '6500'], ['excessRatePolicy', 'guess']]) {
  const input = fixture(); input.scheme.employeeOverrides = [{ employeeId: 'a', path, mode: 'override', value }];
  assert.ok(validateScheme(input.scheme).includes('invalid_employee_override_value'));
}
const missing = fixture(); delete missing.scheme.roleParameters.bar.targetCents;
assert.equal(calculate(missing).status, 'blocked');
const replaced = fixture(); replaced.scheme.itemRules = [{ menuItemId: 'x', roleId: 'bar', mode: 'replace', rateBps: 1000 }];
assert.equal(amount(replaced), 1500);
assert.equal(calculate(replaced).daily[0].employees[0].targetIncentive.basisCents, 0);
const itemAdditive = fixture(); itemAdditive.scheme.itemRules = [{ menuItemId: 'x', employeeId: 'a', mode: 'additive', rateBps: 1000 }];
assert.equal(amount(itemAdditive), 6350);
assert.equal(calculate(itemAdditive).daily[0].lines[0].targetAllocation.additiveCommissionCents, 1500);
const mixed = fixture(); mixed.sales.push({ ...mixed.sales[0], id: '2', menuItemId: 'y' });
mixed.scheme.itemRules = [{ menuItemId: 'x', roleId: 'bar', mode: 'replace', rateBps: 1000 }];
const mixedResult = calculate(mixed);
assert.equal(mixedResult.employees[0].commissionCents, 6350);
assert.equal(mixedResult.daily[0].employees[0].targetIncentive.basisCents, 15000);
assert.equal(mixedResult.daily[0].lines.reduce((sum, row) => sum + row.commissionCents, 0), 6350);
const attendanceOnly = fixture(); attendanceOnly.sales = [];
attendanceOnly.attendance = [{ id: 'shift', employeeId: 'a', date: '2026-10-01', approved: true, workedMinutes: 60, plannedMinutes: 60 }];
assert.equal(calculate(attendanceOnly).daily[0].employees[0].targetIncentive.basisCents, 0);
const capped = fixture(); capped.scheme.roleParameters.bar.cap = { basis: 'venue_day', rateBps: 1000 };
assert.equal(calculate(capped).employees[0].amountCents, 1500);
const invalidId = fixture(); invalidId.sales[0].id = 1;
assert.ok(calculate(invalidId).blockers.includes('invalid_target_sales_line_id'));
const modeOverride = fixture(); modeOverride.scheme.mode = 'stable_percent';
modeOverride.scheme.roleParameters.bar.stableRateBps = 1000;
modeOverride.scheme.employeeOverrides = [{ employeeId: 'a', path: 'mode', mode: 'override', value: 'personal_target' }];
assert.equal(amount(modeOverride), 4850);
delete modeOverride.scheme.roleParameters.bar.targetCents;
assert.ok(calculate(modeOverride).blockers.includes('invalid_targetCents'));
const ceiling = fixture(); ceiling.scheme.roleParameters.bar = { ...ceiling.scheme.roleParameters.bar, targetCents: 0, baseRateBps: 10000, bonusRateBps: 10000, excessRatePolicy: 'add_to_base' };
assert.equal(calculate(ceiling).payoutEligible, false);
assert.equal(calculate(ceiling).criticalErrors[0].code, 'employee_daily_pay_exceeds_personal_revenue');
const overflow = fixture(); overflow.sales[0].commissionBaseCents = Number.MAX_SAFE_INTEGER; overflow.sales[0].turnoverCents = Number.MAX_SAFE_INTEGER;
overflow.scheme.roleParameters.bar = { ...ceiling.scheme.roleParameters.bar };
assert.equal(calculate(overflow).status, 'blocked');
assert.ok(calculate(overflow).blockers.includes('amount_exceeds_safe_integer_cents'));
console.log('PAYROLL PERSONAL TARGET CONTRACT: PASS');
