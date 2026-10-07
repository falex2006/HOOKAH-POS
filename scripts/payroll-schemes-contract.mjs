import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { calculatePayrollScheme, validateScheme } = require('../payroll-schemes.js');

const baseInput = {
  periodFrom: '2026-09-01',
  periodTo: '2026-09-02',
  coverage: { kind: 'month_to_date_complete', from: '2026-09-01', through: '2026-09-02', complete: true, watermark: 'contract-fixture-v1' },
  attendanceCoverage: { kind: 'approved_attendance_complete', from: '2026-09-01', through: '2026-09-02', complete: true, watermark: 'attendance-fixture-v1' },
  monthClosed: false,
  employees: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
  roleAssignments: [
    { employeeId: 'a', roleId: 'bartender', effectiveFrom: '2026-09-01', effectiveTo: '2026-09-30' },
    { employeeId: 'b', roleId: 'hookah', effectiveFrom: '2026-09-01', effectiveTo: '2026-09-30' },
    { employeeId: 'c', roleId: 'hookah', effectiveFrom: '2026-09-01', effectiveTo: '2026-09-30' }
  ],
  attendance: [
    { id: 'shift-a-1', employeeId: 'a', date: '2026-09-01', approved: true, workedMinutes: 480, plannedMinutes: 480 },
    { id: 'shift-a-2', employeeId: 'a', date: '2026-09-02', approved: true, workedMinutes: 480, plannedMinutes: 480 }
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
assert.equal(progressive.payoutEligible, false, 'independent milestone obligations can breach the strict personal daily revenue guard');
assert.ok(progressive.criticalErrors.some((error) => error.employeeId === 'b' && error.date === '2026-09-02'
  && error.payoutCents === 5000 && error.personalRevenueCents === 0), 'zero-sale milestone recipient is reported as a critical payout violation');
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
assert.equal(progressive.venueTurnoverBasis, 'sales_line_sum_scenario', 'legacy scenario callers are explicitly marked as line-derived venue turnover');

const attendanceOnlyShift = calculatePayrollScheme({
  ...baseInput,
  periodFrom: '2026-09-03', periodTo: '2026-09-03',
  coverage: { ...baseInput.coverage, through: '2026-09-03' },
  attendanceCoverage: { ...baseInput.attendanceCoverage, through: '2026-09-03' },
  roleAssignments: [
    { employeeId: 'a', roleId: 'bartender', effectiveFrom: '2026-09-01', effectiveTo: '2026-09-30' },
    { employeeId: 'b', roleId: 'hookah', effectiveFrom: '2026-09-01', effectiveTo: '2026-09-30' },
    { employeeId: 'c', roleId: 'hookah', effectiveFrom: '2026-09-01', effectiveTo: '2026-09-30' }
  ],
  attendance: [
    { id: 'zero-sales-shift', employeeId: 'a', date: '2026-09-03', approved: true, workedMinutes: 240, plannedMinutes: 480 },
    { id: 'second-half', employeeId: 'a', date: '2026-09-03', approved: true, workedMinutes: 240, plannedMinutes: 480 }
  ], sales: [],
  scheme: { ...baseInput.scheme, roleParameters: { bartender: { perShiftCents: 10000, stableRateBps: 0, bracketRatesBps: { 0: 0 } }, hookah: { perShiftCents: 0, bracketRatesBps: { 0: 0 } } }, employeeOverrides: [], itemRules: [] }
});
assert.equal(attendanceOnlyShift.status, 'ready');
assert.equal(attendanceOnlyShift.employees[0].shifts, 2, 'approved scheduled shifts, not sales, determine shift count');
assert.equal(attendanceOnlyShift.employees[0].basePayCents, 10000, 'each shift is prorated and rounded half up independently');
assert.deepEqual(attendanceOnlyShift.daily[0].employees[0].shiftDetails.map((shift) => [shift.workedMinutes, shift.plannedMinutes, shift.amountCents]), [[240, 480, 5000], [240, 480, 5000]], 'daily result preserves per-shift minute and amount lineage');
const missingAttendance = calculatePayrollScheme({ ...baseInput, attendance: undefined });
assert.ok(missingAttendance.blockers.includes('input_collections_required'), 'missing attendance manifest blocks shift-rate calculation');
const invalidAttendance = calculatePayrollScheme({ ...baseInput, attendance: [{ id: 'bad', employeeId: 'a', date: '2026-09-01', approved: false, workedMinutes: 200, plannedMinutes: 480 }] });
assert.ok(invalidAttendance.blockers.includes('invalid_attendance_row'));
const inactiveSales = calculatePayrollScheme({ ...baseInput, employees: [{ id: 'a', activeTo: '2026-08-31' }, { id: 'b' }, { id: 'c' }] });
assert.ok(inactiveSales.blockers.includes('sales_outside_employee_active_period'));
const incompleteAttendanceCoverage = calculatePayrollScheme({ ...baseInput, attendanceCoverage: { ...baseInput.attendanceCoverage, complete: false } });
assert.ok(incompleteAttendanceCoverage.blockers.includes('attendance_coverage_manifest_required'));
const inactiveAttendance = calculatePayrollScheme({ ...baseInput, employees: [{ id: 'a', activeTo: '2026-09-01' }, { id: 'b' }, { id: 'c' }] });
assert.ok(inactiveAttendance.blockers.includes('attendance_outside_employee_active_period'));

const endedEmployee = calculatePayrollScheme({
  ...baseInput,
  periodFrom: '2026-09-01', periodTo: '2026-09-02',
  employees: [{ id: 'b', activeTo: '2026-09-01' }], roleAssignments: [baseInput.roleAssignments[1]], attendance: [], sales: [],
  scheme: { ...baseInput.scheme, employeeOverrides: baseInput.scheme.employeeOverrides.filter((item) => item.employeeId === 'b'), itemRules: [] },
  venueDailyTurnover: [ { date: '2026-09-01', turnoverCents: 0 }, { date: '2026-09-02', turnoverCents: 20000 } ]
});
assert.equal(endedEmployee.status, 'ready', endedEmployee.blockers.join(','));
assert.equal(endedEmployee.employees[0].milestoneBonusCents, 0, 'employee inactive on crossing date is ineligible for milestone');

const unattributedTurnover = calculatePayrollScheme({ ...baseInput, sales: [...baseInput.sales, { id: 'unattributed-turnover', date: '2026-09-02', employeeId: null, department: 'bar', turnoverCents: 10000, commissionBaseCents: 0 }] });
assert.ok(unattributedTurnover.blockers.includes('unattributed_sales_line'), 'positive turnover with zero commission base still needs attribution');

assert.ok(validateScheme({ ...baseInput.scheme, itemRules: {} }).includes('invalid_item_rules'));
assert.ok(validateScheme({ ...baseInput.scheme, employeeOverrides: {} }).includes('invalid_employee_overrides'));
assert.ok(validateScheme({ ...baseInput.scheme, itemRules: [null] }).includes('invalid_item_rule'));
assert.ok(validateScheme({ ...baseInput.scheme, employeeOverrides: [null] }).includes('invalid_employee_override'));
const malformedCollections = calculatePayrollScheme({
  ...baseInput,
  scheme: { ...baseInput.scheme, employeeOverrides: {}, itemRules: {} }
});
assert.equal(malformedCollections.status, 'blocked', 'malformed scheme collections block safely instead of throwing during calculation');
const malformedCollectionRows = calculatePayrollScheme({
  ...baseInput,
  scheme: { ...baseInput.scheme, employeeOverrides: [null], itemRules: [null] }
});
assert.equal(malformedCollectionRows.status, 'blocked', 'null rows inside scheme collections block safely');
assert.ok(calculatePayrollScheme({ ...baseInput, roleAssignments: [null] }).blockers.includes('invalid_role_assignment'), 'malformed role assignment rows return a blocker safely');
assert.ok(calculatePayrollScheme({ ...baseInput, employees: [null] }).blockers.includes('invalid_employee'), 'malformed employee rows return a blocker safely');
assert.ok(!validateScheme({ ...baseInput.scheme, employeeOverrides: [
  { employeeId: 'a', path: 'perShiftCents', mode: 'override', value: 100, effectiveFrom: '2026-09-01', effectiveTo: '2026-09-10' },
  { employeeId: 'a', path: 'perShiftCents', mode: 'override', value: 200, effectiveFrom: '2026-09-11', effectiveTo: '2026-09-30' }
] }).includes('overlapping_employee_override'), 'nonoverlapping effective overrides are valid');
assert.ok(validateScheme({ ...baseInput.scheme, employeeOverrides: [
  { employeeId: 'a', path: 'perShiftCents', mode: 'override', value: 100, effectiveFrom: '2026-09-01', effectiveTo: '2026-09-12' },
  { employeeId: 'a', path: 'perShiftCents', mode: 'override', value: 200, effectiveFrom: '2026-09-12', effectiveTo: '2026-09-30' }
] }).includes('overlapping_employee_override'), 'overlapping effective overrides are rejected');

const venueDailyManifest = calculatePayrollScheme({
  ...baseInput,
  venueDailyTurnover: [
    { date: '2026-09-01', turnoverCents: 25000 },
    { date: '2026-09-02', turnoverCents: 20000 }
  ]
});
assert.equal(venueDailyManifest.status, 'ready');
assert.equal(venueDailyManifest.venueTurnoverBasis, 'venue_daily_manifest_scenario');
assert.equal(venueDailyManifest.monthTurnoverCents, 45000, 'explicit daily venue totals override attributed line totals');
assert.equal(venueDailyManifest.daily[0].venueTurnoverCents, 25000, 'venue totals can include non-commissionable revenue');
assert.equal(venueDailyManifest.daily[0].employees.find((row) => row.employeeId === 'a').commissionCents, 3750,
  'progressive daily bracket uses the venue series while commission keeps the line basis');
assert.equal(venueDailyManifest.daily[0].employees.find((row) => row.employeeId === 'b').milestoneBonusCents, 5000,
  'milestone crossing uses the explicit venue series');

const effectiveOverride = calculatePayrollScheme({
  ...baseInput,
  scheme: {
    ...baseInput.scheme,
    employeeOverrides: [{ employeeId: 'a', path: 'perShiftCents', mode: 'override', value: 0, effectiveFrom: '2026-09-02', effectiveTo: '2026-09-02' }],
    itemRules: []
  }
});
assert.equal(effectiveOverride.status, 'ready');
assert.equal(effectiveOverride.daily[0].employees.find((row) => row.employeeId === 'a').basePayCents, 10000);
assert.equal(effectiveOverride.daily[1].employees.find((row) => row.employeeId === 'a').basePayCents, 0);

const capped = calculatePayrollScheme({
  ...baseInput,
  employees: [{ id: 'b' }],
  roleAssignments: [baseInput.roleAssignments[1]],
  periodFrom: '2026-09-03',
  periodTo: '2026-09-03',
  coverage: { ...baseInput.coverage, through: '2026-09-03', watermark: 'cap-fixture-v1' },
  attendanceCoverage: { ...baseInput.attendanceCoverage, through: '2026-09-03' },
  attendance: [{ id: 'cap-shift', employeeId: 'b', date: '2026-09-03', approved: true, workedMinutes: 480, plannedMinutes: 480 }],
  venueDailyTurnover: [
    { date: '2026-09-01', turnoverCents: 0 },
    { date: '2026-09-02', turnoverCents: 0 },
    { date: '2026-09-03', turnoverCents: 50000 }
  ],
  sales: [{ id: 'hookah-sale', date: '2026-09-03', employeeId: 'b', menuItemId: 'hookah', department: 'hookah', turnoverCents: 20000, commissionBaseCents: 8000 }],
  scheme: { ...baseInput.scheme, roleParameters: { hookah: { perShiftCents: 10000, bracketRatesBps: { 0: 5000 }, cap: { rateBps: 3000, basis: 'employee_department_day', department: 'hookah' } } }, employeeOverrides: [], itemRules: [] }
});
assert.equal(capped.status, 'ready');
assert.equal(capped.daily[0].lines[0].commissionCents, 4000, 'commission remains based on net commissionable line amount');
assert.equal(capped.daily[0].employees[0].departmentSalesCents.hookah, 8000, 'existing commission-base diagnostic retains its prior meaning');
assert.equal(capped.daily[0].employees[0].departmentTurnoverCents.hookah, 20000, 'cap diagnostics expose employee-attributed department turnover');
assert.equal(capped.daily[0].employees[0].personalRevenueCents, 20000, 'scenario payout guard uses attributed turnover, independently of the 8000 commission base');
assert.equal(capped.payoutEligible, true, 'scenario guard does not substitute the smaller commission base for the distinct turnover proxy');
assert.equal(capped.daily[0].venueTurnoverCents, 50000, 'venue total is independent of employee-attributed line turnover');
assert.equal(capped.daily[0].employees[0].capCents, 6000, 'cap is calculated from turnover rather than commission base');
assert.equal(capped.employees.find((row) => row.employeeId === 'b').amountBeforeCapCents, 14000);
assert.equal(capped.employees.find((row) => row.employeeId === 'b').amountCents, 6000);
assert.equal(capped.employees.find((row) => row.employeeId === 'b').capReductionCents, 8000);

const venueDayCap = calculatePayrollScheme({
  ...baseInput,
  employees: [{ id: 'b' }],
  roleAssignments: [baseInput.roleAssignments[1]],
  periodFrom: '2026-09-03',
  periodTo: '2026-09-03',
  coverage: { ...baseInput.coverage, through: '2026-09-03', watermark: 'venue-cap-fixture-v1' },
  attendanceCoverage: { ...baseInput.attendanceCoverage, through: '2026-09-03' },
  attendance: [{ id: 'venue-cap-shift', employeeId: 'b', date: '2026-09-03', approved: true, workedMinutes: 480, plannedMinutes: 480 }],
  venueDailyTurnover: [
    { date: '2026-09-01', turnoverCents: 0 },
    { date: '2026-09-02', turnoverCents: 0 },
    { date: '2026-09-03', turnoverCents: 50000 }
  ],
  sales: [{ id: 'hookah-venue-cap', date: '2026-09-03', employeeId: 'b', menuItemId: 'hookah', department: 'hookah', turnoverCents: 20000, commissionBaseCents: 8000 }],
  scheme: { ...baseInput.scheme, roleParameters: { hookah: { perShiftCents: 10000, bracketRatesBps: { 0: 5000 }, cap: { rateBps: 1000, basis: 'venue_day' } } }, employeeOverrides: [], itemRules: [] }
});
assert.equal(venueDayCap.status, 'ready');
assert.equal(venueDayCap.daily[0].employees[0].capCents, 5000, 'venue_day cap uses explicit full-venue turnover');
assert.equal(venueDayCap.daily[0].employees[0].amountCents, 5000);

const scopedDepartmentCap = calculatePayrollScheme({
  ...baseInput,
  employees: [{ id: 'b' }, { id: 'c' }],
  roleAssignments: [baseInput.roleAssignments[1], { ...baseInput.roleAssignments[1], employeeId: 'c' }],
  periodFrom: '2026-09-03',
  periodTo: '2026-09-03',
  coverage: { ...baseInput.coverage, through: '2026-09-03', watermark: 'scoped-department-cap-v1' },
  attendanceCoverage: { ...baseInput.attendanceCoverage, through: '2026-09-03' },
  attendance: [
    { id: 'scoped-shift-b', employeeId: 'b', date: '2026-09-03', approved: true, workedMinutes: 480, plannedMinutes: 480 },
    { id: 'scoped-shift-c', employeeId: 'c', date: '2026-09-03', approved: true, workedMinutes: 480, plannedMinutes: 480 }
  ],
  venueDailyTurnover: [
    { date: '2026-09-01', turnoverCents: 0 },
    { date: '2026-09-02', turnoverCents: 0 },
    { date: '2026-09-03', turnoverCents: 50000 }
  ],
  sales: [
    { id: 'hookah-sale-b1', date: '2026-09-03', employeeId: 'b', menuItemId: 'hookah', department: 'hookah', turnoverCents: 5000, commissionBaseCents: 5000 },
    { id: 'hookah-sale-b2', date: '2026-09-03', employeeId: 'b', menuItemId: 'hookah', department: 'hookah', turnoverCents: 3000, commissionBaseCents: 3000 },
    { id: 'bar-sale-b', date: '2026-09-03', employeeId: 'b', menuItemId: 'tea', department: 'bar', turnoverCents: 4000, commissionBaseCents: 4000 },
    { id: 'hookah-sale-c', date: '2026-09-03', employeeId: 'c', menuItemId: 'hookah', department: 'hookah', turnoverCents: 12000, commissionBaseCents: 12000 }
  ],
  scheme: {
    ...baseInput.scheme,
    applyMilestones: false,
    roleParameters: { hookah: { perShiftCents: 10000, bracketRatesBps: { 0: 5000 }, cap: { rateBps: 3000, basis: 'employee_department_day', department: 'hookah' } } },
    employeeOverrides: [], itemRules: []
  }
});
assert.equal(scopedDepartmentCap.status, 'ready');
const bDepartmentDay = scopedDepartmentCap.daily[0].employees.find((row) => row.employeeId === 'b');
const cDepartmentDay = scopedDepartmentCap.daily[0].employees.find((row) => row.employeeId === 'c');
assert.deepEqual(bDepartmentDay.departmentTurnoverCents, { hookah: 8000, bar: 4000 },
  'department turnover aggregates same-employee lines but keeps departments separate');
assert.equal(scopedDepartmentCap.daily[0].venueTurnoverCents, 50000);
assert.equal(bDepartmentDay.capCents, 2400, 'employee cap excludes another employee and other departments');
assert.equal(bDepartmentDay.amountCents, 2400);
assert.equal(cDepartmentDay.capCents, 3600, 'each employee uses their own department turnover');
assert.equal(cDepartmentDay.amountCents, 3600);

const stable = calculatePayrollScheme({
  ...baseInput,
  employees: [{ id: 'a' }],
  roleAssignments: [baseInput.roleAssignments[0]],
  periodTo: '2026-09-01',
  coverage: { ...baseInput.coverage, through: '2026-09-01', watermark: 'stable-fixture-v1' },
  attendanceCoverage: { ...baseInput.attendanceCoverage, through: '2026-09-01' },
  attendance: [{ id: 'stable-shift', employeeId: 'a', date: '2026-09-01', approved: true, workedMinutes: 480, plannedMinutes: 480 }],
  sales: [baseInput.sales[0]],
  scheme: { id: 'stable', versionId: 'stable-v1', mode: 'stable_percent', roleParameters: { bartender: { perShiftCents: 10000, stableRateBps: 1000 } } }
});
assert.equal(stable.status, 'ready');
assert.equal(stable.payoutEligible, true, 'personal daily compensation below personal net revenue is eligible');
assert.equal(stable.employees.find((row) => row.employeeId === 'a').personalRevenueCents, 15000);
assert.equal(stable.employees.find((row) => row.employeeId === 'a').amountCents, 11500);

const personalRevenueBoundary = calculatePayrollScheme({
  ...baseInput,
  employees: [{ id: 'a' }], roleAssignments: [baseInput.roleAssignments[0]], periodTo: '2026-09-01',
  coverage: { ...baseInput.coverage, through: '2026-09-01', watermark: 'revenue-boundary-v1' },
  attendanceCoverage: { ...baseInput.attendanceCoverage, through: '2026-09-01' }, attendance: [], sales: [baseInput.sales[0]],
  scheme: { id: 'revenue-boundary', versionId: 'revenue-boundary-v1', mode: 'percent_only', roleParameters: { bartender: { stableRateBps: 10000 } }, applyMilestones: false }
});
assert.equal(personalRevenueBoundary.employees.find((row) => row.employeeId === 'a').amountCents, 15000);
assert.equal(personalRevenueBoundary.payoutEligible, true, 'exact equality with personal daily revenue passes the guard');
assert.deepEqual(personalRevenueBoundary.criticalErrors, []);

const personalRevenueExceeded = calculatePayrollScheme({
  ...baseInput,
  employees: [{ id: 'a' }], roleAssignments: [baseInput.roleAssignments[0]], periodTo: '2026-09-01',
  coverage: { ...baseInput.coverage, through: '2026-09-01', watermark: 'revenue-exceeded-v1' },
  attendanceCoverage: { ...baseInput.attendanceCoverage, through: '2026-09-01' },
  attendance: [{ id: 'guard-shift', employeeId: 'a', date: '2026-09-01', approved: true, workedMinutes: 480, plannedMinutes: 480 }],
  sales: [baseInput.sales[0]],
  scheme: { id: 'revenue-exceeded', versionId: 'revenue-exceeded-v1', mode: 'progressive_daily', applyMilestones: false,
    roleParameters: { bartender: { perShiftCents: 20000, bracketRatesBps: { 0: 1000 } } } }
});
assert.equal(personalRevenueExceeded.status, 'ready', 'scenario math stays available for comparison');
assert.equal(personalRevenueExceeded.payoutEligible, false, 'critical guard disallows fixing a result that overpays own daily revenue');
assert.deepEqual(personalRevenueExceeded.criticalErrors, [{ code: 'employee_daily_pay_exceeds_personal_revenue', employeeId: 'a',
  date: '2026-09-01', payoutCents: 21500, personalRevenueCents: 15000, excessCents: 6500 }]);

const personalMode = calculatePayrollScheme({
  ...baseInput,
  employees: [{ id: 'a' }],
  roleAssignments: [baseInput.roleAssignments[0]],
  periodTo: '2026-09-01',
  coverage: { ...baseInput.coverage, through: '2026-09-01', watermark: 'personal-fixture-v1' },
  attendanceCoverage: { ...baseInput.attendanceCoverage, through: '2026-09-01' },
  attendance: [{ id: 'personal-shift', employeeId: 'a', date: '2026-09-01', approved: true, workedMinutes: 480, plannedMinutes: 480 }],
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
  attendanceCoverage: { ...baseInput.attendanceCoverage, through: '2026-09-01' },
  attendance: [],
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
  attendanceCoverage: { kind: 'approved_attendance_complete', from: '2026-09-01', through: '2026-09-30', complete: true, watermark: 'closed-attendance-fixture-v1' },
  venueDailyTurnover: Array.from({ length: 30 }, (_, index) => ({
    date: `2026-09-${String(index + 1).padStart(2, '0')}`,
    turnoverCents: index === 0 ? 25000 : 0
  })),
  attendance: [{ id: 'month-shift', employeeId: 'a', date: '2026-09-01', approved: true, workedMinutes: 480, plannedMinutes: 480 }],
  monthClosed: true,
  scheme: { id: 'month-end', versionId: 'month-v1', mode: 'final_month_threshold', roleParameters: { bartender: { perShiftCents: 10000, bracketRatesBps: { 0: 500, 30000: 1500 } } } }
});
assert.equal(finalMonth.status, 'ready');
assert.equal(finalMonth.monthTurnoverCents, 25000, 'closed-month total uses the full venue series');
assert.equal(finalMonth.daily[0].lines[0].appliedRateBps, 500); // line sum exceeds the threshold but canonical venue total does not
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
const incompleteVenueTurnover = calculatePayrollScheme({ ...baseInput, venueDailyTurnover: [{ date: '2026-09-01', turnoverCents: 1000 }] });
assert.ok(incompleteVenueTurnover.blockers.includes('invalid_venue_daily_turnover_manifest'), 'explicit venue totals require all covered dates, including zero days');
const venueTurnoverInteriorGap = calculatePayrollScheme({
  ...baseInput,
  coverage: { ...baseInput.coverage, through: '2026-09-03' },
  venueDailyTurnover: [{ date: '2026-09-01', turnoverCents: 1000 }, { date: '2026-09-03', turnoverCents: 0 }]
});
assert.ok(venueTurnoverInteriorGap.blockers.includes('invalid_venue_daily_turnover_manifest'), 'same-length venue series with a missing interior day is rejected');
assert.equal(venueTurnoverInteriorGap.status, 'blocked', 'invalid venue turnover must never appear ready');
const venueTurnoverOutOfRange = calculatePayrollScheme({
  ...baseInput,
  venueDailyTurnover: [
    { date: '2026-09-01', turnoverCents: 1000 },
    { date: '2026-09-02', turnoverCents: 0 },
    { date: '2026-09-03', turnoverCents: 0 }
  ]
});
assert.ok(venueTurnoverOutOfRange.blockers.includes('invalid_venue_daily_turnover_manifest'), 'extra venue date outside coverage is rejected');
for (const invalidAmount of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
  const invalidVenueAmount = calculatePayrollScheme({
    ...baseInput,
    venueDailyTurnover: [
      { date: '2026-09-01', turnoverCents: invalidAmount },
      { date: '2026-09-02', turnoverCents: 0 }
    ]
  });
  assert.ok(invalidVenueAmount.blockers.includes('invalid_venue_daily_turnover_manifest'), `unsafe/negative/noninteger venue turnover ${invalidAmount} is rejected`);
  assert.equal(invalidVenueAmount.status, 'blocked');
}
const malformedCoverageVenueTurnover = calculatePayrollScheme({
  ...baseInput,
  coverage: { ...baseInput.coverage, from: undefined },
  venueDailyTurnover: []
});
assert.ok(malformedCoverageVenueTurnover.blockers.includes('invalid_venue_daily_turnover_manifest'), 'explicit venue series with malformed coverage is rejected without throwing');
const farFutureVenueCoverage = calculatePayrollScheme({
  ...baseInput,
  coverage: { ...baseInput.coverage, through: '9999-12-31' },
  venueDailyTurnover: []
});
assert.ok(farFutureVenueCoverage.blockers.includes('invalid_venue_daily_turnover_manifest'), 'venue coverage is bounded before calendar enumeration');
assert.equal(farFutureVenueCoverage.status, 'blocked');
const maxLengthVenueCoverage = calculatePayrollScheme({
  ...baseInput,
  periodFrom: '2026-10-01',
  periodTo: '2026-10-31',
  monthClosed: true,
  coverage: { kind: 'month_closed_complete', from: '2026-10-01', through: '2026-10-31', complete: true, watermark: 'max-31-day-coverage' },
  sales: [],
  venueDailyTurnover: Array.from({ length: 31 }, (_, index) => ({ date: `2026-10-${String(index + 1).padStart(2, '0')}`, turnoverCents: 0 }))
});
assert.ok(!maxLengthVenueCoverage.blockers.includes('invalid_venue_daily_turnover_manifest'), 'a complete 31-day venue manifest is accepted');
const year9999VenueCoverage = calculatePayrollScheme({
  ...baseInput,
  periodFrom: '9999-12-01',
  periodTo: '9999-12-31',
  monthClosed: true,
  coverage: { kind: 'month_closed_complete', from: '9999-12-01', through: '9999-12-31', complete: true, watermark: 'year-9999-boundary' },
  attendanceCoverage: { kind: 'approved_attendance_complete', from: '9999-12-01', through: '9999-12-31', complete: true, watermark: 'year-9999-attendance' },
  employees: [{ id: 'a' }],
  roleAssignments: [{ employeeId: 'a', roleId: 'bartender', effectiveFrom: '9999-12-01', effectiveTo: '9999-12-31' }],
  scheme: { ...baseInput.scheme, employeeOverrides: baseInput.scheme.employeeOverrides.filter((override) => override.employeeId === 'a') },
  sales: [],
  venueDailyTurnover: Array.from({ length: 31 }, (_, index) => ({ date: `9999-12-${String(index + 1).padStart(2, '0')}`, turnoverCents: 0 }))
});
assert.ok(!year9999VenueCoverage.blockers.includes('invalid_venue_daily_turnover_manifest'), '31-day manifest ending at year 9999 boundary is enumerated without overflow');
assert.equal(year9999VenueCoverage.status, 'ready', `a complete year-9999 run reaches calculation output without calendar rollover (${year9999VenueCoverage.blockers.join(',')})`);
assert.equal(year9999VenueCoverage.daily.length, 31, 'year-9999 monthly aggregation produces all 31 venue-local days');
const yearZeroLeapMonthCoverage = calculatePayrollScheme({
  ...baseInput,
  periodFrom: '0000-02-01',
  periodTo: '0000-02-29',
  monthClosed: true,
  coverage: { kind: 'month_closed_complete', from: '0000-02-01', through: '0000-02-29', complete: true, watermark: 'year-zero-leap-month' },
  attendanceCoverage: { kind: 'approved_attendance_complete', from: '0000-02-01', through: '0000-02-29', complete: true, watermark: 'year-zero-attendance' },
  employees: [{ id: 'a' }],
  roleAssignments: [{ employeeId: 'a', roleId: 'bartender', effectiveFrom: '0000-02-01', effectiveTo: '0000-02-29' }],
  scheme: { ...baseInput.scheme, employeeOverrides: baseInput.scheme.employeeOverrides.filter((override) => override.employeeId === 'a') },
  sales: [],
  venueDailyTurnover: Array.from({ length: 29 }, (_, index) => ({ date: `0000-02-${String(index + 1).padStart(2, '0')}`, turnoverCents: 0 }))
});
assert.ok(!yearZeroLeapMonthCoverage.blockers.includes('closed_month_mismatch'), 'year-zero leap February ends on February 29');
assert.ok(!yearZeroLeapMonthCoverage.blockers.includes('invalid_venue_daily_turnover_manifest'), 'the full year-zero leap-month venue manifest is accepted');
assert.equal(yearZeroLeapMonthCoverage.status, 'ready', 'year-zero leap month calculates through the complete calendar');
assert.equal(yearZeroLeapMonthCoverage.daily.length, 29, 'year-zero leap month emits all 29 local days');
const invalidLongPayrollPeriod = calculatePayrollScheme({
  ...baseInput,
  periodFrom: '2026-01-01',
  periodTo: '9999-12-31',
  roleAssignments: [{ employeeId: 'a', roleId: 'bartender', effectiveFrom: '2026-01-01', effectiveTo: '9999-12-31' }],
  coverage: { kind: 'month_closed_complete', from: '2026-01-01', through: '9999-12-31', complete: true, watermark: 'invalid-long-period' },
  venueDailyTurnover: []
});
assert.ok(invalidLongPayrollPeriod.blockers.includes('invalid_single_month_period'), 'invalid multi-century payroll period is rejected without unbounded date loops');
const duplicateVenueTurnover = calculatePayrollScheme({
  ...baseInput,
  venueDailyTurnover: [
    { date: '2026-09-01', turnoverCents: 1000 },
    { date: '2026-09-01', turnoverCents: 0 },
    { date: '2026-09-02', turnoverCents: 1000 }
  ]
});
assert.ok(duplicateVenueTurnover.blockers.includes('invalid_venue_daily_turnover_manifest'), 'duplicate venue dates are rejected');
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
