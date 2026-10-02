import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { calculatePayrollScheme, validateScheme } = require('../payroll-schemes.js');

const baseInput = {
  periodFrom: '2026-09-01',
  periodTo: '2026-09-02',
  coverage: { kind: 'month_to_date_complete', from: '2026-09-01', through: '2026-09-02', complete: true, watermark: 'contract-fixture-v1' },
  monthClosed: false,
  employees: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
  roleAssignments: [
    { employeeId: 'a', roleId: 'bartender', effectiveFrom: '2026-09-01', effectiveTo: '2026-09-30' },
    { employeeId: 'b', roleId: 'hookah', effectiveFrom: '2026-09-01', effectiveTo: '2026-09-30' },
    { employeeId: 'c', roleId: 'hookah', effectiveFrom: '2026-09-01', effectiveTo: '2026-09-30' }
  ],
  sales: [
    { id: 'line-1', date: '2026-09-01', employeeId: 'a', menuItemId: 'water', department: 'bar', turnoverCents: 15000, commissionBaseCents: 15000 },
    { id: 'line-2', date: '2026-09-02', employeeId: 'a', menuItemId: 'cola', department: 'bar', turnoverCents: 5000, commissionBaseCents: 5000 },
    { id: 'line-3', date: '2026-09-02', employeeId: 'a', menuItemId: 'special', department: 'bar', turnoverCents: 5000, commissionBaseCents: 5000 },
    { id: 'line-4', date: '2026-09-02', employeeId: 'a', menuItemId: 'water', department: 'bar', turnoverCents: 10000, commissionBaseCents: 10000 }
  ],
  scheme: {
    id: 'scheme-default',
    versionId: 'scheme-v1',
    currency: 'RUB',
    mode: 'progressive_daily',
    milestoneCapPolicy: 'separate_from_shift_cap',
    roleParameters: {
      bartender: { perShiftCents: 10000, stableRateBps: 1000, bracketRatesBps: { 0: 1000, 20000: 2000 } },
      hookah: { perShiftCents: 12000, bracketRatesBps: { 0: 500, 20000: 1500 }, cap: { rateBps: 3000, basis: 'employee_department_day', department: 'hookah' }, milestoneBonusesCents: { 20000: 5000 } }
    },
    employeeOverrides: [
      { employeeId: 'a', path: 'bracketRatesBps.20000', mode: 'override', value: 2500 },
      { employeeId: 'c', path: 'milestoneBonusesCents.20000', mode: 'override', value: 0 }
    ],
    itemRules: [
      { id: 'cola-role-add', menuItemId: 'cola', roleId: 'bartender', mode: 'additive', rateBps: 500 },
      { id: 'special-person-replace', menuItemId: 'special', employeeId: 'a', mode: 'replace', rateBps: 5000 }
    ]
  }
};

const progressive = calculatePayrollScheme(baseInput);
assert.equal(progressive.status, 'ready');
assert.equal(progressive.monthTurnoverCents, 35000);
assert.equal(progressive.daily[0].employees.find((row) => row.employeeId === 'a').commissionCents, 1500);
const day2A = progressive.daily[1].employees.find((row) => row.employeeId === 'a');
assert.equal(day2A.shifts, 1);
assert.equal(day2A.basePayCents, 10000);
assert.equal(day2A.commissionCents, 6500); // personal threshold override + additive and replace item rules
assert.equal(day2A.amountCents, 16500);
assert.equal(progressive.daily[1].lines.find((line) => line.lineId === 'line-2').appliedRateBps, 3000);
assert.equal(progressive.daily[1].lines.find((line) => line.lineId === 'line-3').appliedRateBps, 5000);
assert.equal(progressive.daily[1].employees.find((row) => row.employeeId === 'b').shifts, 0);
assert.equal(progressive.daily[1].employees.find((row) => row.employeeId === 'b').amountCents, 5000); // milestone bonus despite no sale
assert.equal(progressive.employees.find((row) => row.employeeId === 'c').milestoneBonusCents, 0); // explicit zero override

const capped = calculatePayrollScheme({
  ...baseInput,
  employees: [{ id: 'b' }],
  roleAssignments: [baseInput.roleAssignments[1]],
  periodFrom: '2026-09-03',
  periodTo: '2026-09-03',
  coverage: { ...baseInput.coverage, through: '2026-09-03', watermark: 'cap-fixture-v1' },
  sales: [{ id: 'hookah-sale', date: '2026-09-03', employeeId: 'b', menuItemId: 'hookah', department: 'hookah', turnoverCents: 20000, commissionBaseCents: 20000 }],
  scheme: { ...baseInput.scheme, roleParameters: { hookah: { perShiftCents: 10000, bracketRatesBps: { 0: 5000 }, cap: { rateBps: 3000, basis: 'employee_department_day', department: 'hookah' } } }, employeeOverrides: [], itemRules: [] }
});
assert.equal(capped.status, 'ready');
assert.equal(capped.employees.find((row) => row.employeeId === 'b').amountBeforeCapCents, 20000);
assert.equal(capped.employees.find((row) => row.employeeId === 'b').amountCents, 6000);
assert.equal(capped.employees.find((row) => row.employeeId === 'b').capReductionCents, 14000);

const stable = calculatePayrollScheme({
  ...baseInput,
  employees: [{ id: 'a' }],
  roleAssignments: [baseInput.roleAssignments[0]],
  periodTo: '2026-09-01',
  coverage: { ...baseInput.coverage, through: '2026-09-01', watermark: 'stable-fixture-v1' },
  sales: [baseInput.sales[0]],
  scheme: { id: 'stable', versionId: 'stable-v1', mode: 'stable_percent', roleParameters: { bartender: { perShiftCents: 10000, stableRateBps: 1000 } } }
});
assert.equal(stable.status, 'ready');
assert.equal(stable.employees.find((row) => row.employeeId === 'a').amountCents, 11500);

const personalMode = calculatePayrollScheme({
  ...baseInput,
  employees: [{ id: 'a' }],
  roleAssignments: [baseInput.roleAssignments[0]],
  periodTo: '2026-09-01',
  coverage: { ...baseInput.coverage, through: '2026-09-01', watermark: 'personal-fixture-v1' },
  sales: [baseInput.sales[0]],
  scheme: {
    ...baseInput.scheme,
    employeeOverrides: [
      { employeeId: 'a', path: 'mode', mode: 'override', value: 'stable_percent' },
      { employeeId: 'a', path: 'stableRateBps', mode: 'override', value: 2000 }
    ],
    itemRules: []
  }
});
assert.equal(personalMode.status, 'ready');
assert.equal(personalMode.daily[0].lines[0].baseRateBps, 2000);
assert.equal(personalMode.daily[0].employees.find((row) => row.employeeId === 'a').mode, 'stable_percent');
assert.equal(personalMode.employees.find((row) => row.employeeId === 'a').amountCents, 13000);

const percentOnly = calculatePayrollScheme({
  ...baseInput,
  employees: [{ id: 'a' }],
  roleAssignments: [baseInput.roleAssignments[0]],
  periodTo: '2026-09-01',
  coverage: { ...baseInput.coverage, through: '2026-09-01', watermark: 'percent-fixture-v1' },
  sales: [baseInput.sales[0]],
  scheme: { id: 'percent-only', versionId: 'percent-v1', mode: 'percent_only', roleParameters: { bartender: { stableRateBps: 1000 } } }
});
assert.equal(percentOnly.status, 'ready');
assert.equal(percentOnly.employees.find((row) => row.employeeId === 'a').basePayCents, 0);
assert.equal(percentOnly.employees.find((row) => row.employeeId === 'a').amountCents, 1500);

const finalMonth = calculatePayrollScheme({
  ...baseInput,
  employees: [{ id: 'a' }],
  roleAssignments: [baseInput.roleAssignments[0]],
  periodFrom: '2026-09-01',
  periodTo: '2026-09-30',
  coverage: { kind: 'month_closed_complete', from: '2026-09-01', through: '2026-09-30', complete: true, watermark: 'closed-fixture-v1' },
  monthClosed: true,
  scheme: { id: 'month-end', versionId: 'month-v1', mode: 'final_month_threshold', roleParameters: { bartender: { perShiftCents: 10000, bracketRatesBps: { 0: 500, 30000: 1500 } } } }
});
assert.equal(finalMonth.status, 'ready');
assert.equal(finalMonth.daily[0].lines[0].appliedRateBps, 1500); // final month bracket is used on every day
const provisionalFinalMonth = calculatePayrollScheme({ ...baseInput, scheme: { ...baseInput.scheme, mode: 'final_month_threshold' } });
assert.ok(provisionalFinalMonth.blockers.includes('closed_month_required'));
const partialClosedFinalMonth = calculatePayrollScheme({
  ...baseInput,
  coverage: { kind: 'month_closed_complete', from: '2026-09-01', through: '2026-09-30', complete: true, watermark: 'partial-closed-fixture' },
  monthClosed: true,
  scheme: { id: 'month-end', versionId: 'month-v1', mode: 'final_month_threshold', roleParameters: { bartender: { perShiftCents: 10000, bracketRatesBps: { 0: 500 } }, hookah: { perShiftCents: 10000, bracketRatesBps: { 0: 500 } } } }
});
assert.ok(partialClosedFinalMonth.blockers.includes('full_month_period_required'));

const missingAuthor = calculatePayrollScheme({
  ...baseInput,
  sales: [...baseInput.sales, { id: 'unattributed', date: '2026-09-02', employeeId: null, menuItemId: 'tea', department: 'bar', turnoverCents: 1000, commissionBaseCents: 1000 }]
});
assert.equal(missingAuthor.status, 'blocked');
assert.ok(missingAuthor.blockers.includes('unattributed_sales_line'));

const overlappingRoles = calculatePayrollScheme({
  ...baseInput,
  roleAssignments: [...baseInput.roleAssignments, { employeeId: 'a', roleId: 'hookah', effectiveFrom: '2026-09-02', effectiveTo: '2026-09-04' }]
});
assert.ok(overlappingRoles.blockers.includes('overlapping_role_assignments'));

const roleGap = calculatePayrollScheme({
  ...baseInput,
  roleAssignments: [{ ...baseInput.roleAssignments[0], effectiveTo: '2026-09-01' }]
});
assert.ok(roleGap.blockers.includes('role_assignment_gap'));

const invalidCoverage = calculatePayrollScheme({ ...baseInput, coverage: { ...baseInput.coverage, complete: false } });
assert.ok(invalidCoverage.blockers.includes('sales_coverage_manifest_required'));
const linePastCoverage = calculatePayrollScheme({
  ...baseInput,
  sales: [...baseInput.sales, { id: 'past-coverage', date: '2026-09-03', employeeId: 'a', menuItemId: 'tea', department: 'bar', turnoverCents: 100, commissionBaseCents: 100 }]
});
assert.ok(linePastCoverage.blockers.includes('invalid_sales_line'));
const unknownOverride = calculatePayrollScheme({
  ...baseInput,
  scheme: { ...baseInput.scheme, employeeOverrides: [...baseInput.scheme.employeeOverrides, { employeeId: 'missing', path: 'perShiftCents', mode: 'override', value: 100 }] }
});
assert.ok(unknownOverride.blockers.includes('employee_override_employee_unknown'));

const duplicateRules = validateScheme({ ...baseInput.scheme, itemRules: [...baseInput.scheme.itemRules, baseInput.scheme.itemRules[0]] });
assert.ok(duplicateRules.includes('duplicate_item_rule'));

console.log('PAYROLL SCHEMES CONTRACT: PASS');
