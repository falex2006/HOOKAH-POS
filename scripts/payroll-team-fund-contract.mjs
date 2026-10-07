import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { calculatePayrollScheme: calculate } = createRequire(import.meta.url)('../payroll-schemes.js');
const fixture = () => {
  const teamFund = { poolId: 'both', targetCents: 10000, baseRateBps: 1600, bonusRateBps: 4000,
    excessRatePolicy: 'replace_base', departments: ['bar', 'hookah'], distributionPolicy: 'configured_weights' };
  return { scheme: { id: 's', versionId: 'v', mode: 'team_fund', roleParameters: {
    bar: { perShiftCents: 0, teamWeight: 1, teamFund }, hookah: { perShiftCents: 0, teamWeight: 1, teamFund: { ...teamFund, departments: ['hookah', 'bar'] } }
  }, employeeOverrides: [], itemRules: [] }, employees: [{ id: 'a' }, { id: 'b' }],
  roleAssignments: [{ employeeId: 'a', roleId: 'bar', effectiveFrom: '2026-10-01' }, { employeeId: 'b', roleId: 'hookah', effectiveFrom: '2026-10-01' }],
  periodFrom: '2026-10-01', periodTo: '2026-10-01', attendance: [],
  coverage: { kind: 'month_to_date_complete', from: '2026-10-01', through: '2026-10-01', complete: true, watermark: 'scenario' },
  attendanceCoverage: { kind: 'approved_attendance_complete', from: '2026-10-01', through: '2026-10-01', complete: true, watermark: 'scenario' },
  sales: [{ id: 'x', employeeId: 'a', menuItemId: 'x', department: 'bar', date: '2026-10-01', commissionBaseCents: 15000, turnoverCents: 15000 },
    { id: 'y', employeeId: 'b', menuItemId: 'y', department: 'hookah', date: '2026-10-01', commissionBaseCents: 15000, turnoverCents: 15000 }] };
};
const result = calculate(fixture());
assert.equal(result.status, 'ready');
assert.equal(result.daily[0].teamFunds.length, 1);
assert.equal(result.daily[0].teamFunds[0].fundCents, 9600);
assert.deepEqual(result.employees.map((row) => row.teamFundCents), [4800, 4800]);
assert.equal(result.employees.reduce((sum, row) => sum + row.commissionCents, 0), 0);
assert.equal(result.daily[0].lines.reduce((sum, row) => sum + row.commissionCents, 0), 0);
const shuffle = fixture(); shuffle.employees.reverse(); shuffle.roleAssignments.reverse(); shuffle.sales.reverse();
assert.deepEqual(calculate(shuffle), result);
const override = fixture(); override.scheme.employeeOverrides = [{ employeeId: 'a', path: 'teamWeight', mode: 'override', value: 3 }];
assert.deepEqual(calculate(override).employees.map((row) => row.teamFundCents), [7200, 2400]);
const zero = fixture(); zero.scheme.roleParameters.bar.teamWeight = 0;
assert.deepEqual(calculate(zero).employees.map((row) => row.teamFundCents), [0, 9600], 'zero-weight sales still contribute');
zero.scheme.roleParameters.hookah.teamWeight = 0;
assert.ok(calculate(zero).blockers.includes('positive_team_fund_requires_weight'));
zero.sales = []; assert.equal(calculate(zero).status, 'ready');
const minutes = fixture(); for (const params of Object.values(minutes.scheme.roleParameters)) params.teamFund.distributionPolicy = 'approved_minutes';
assert.ok(calculate(minutes).blockers.includes('positive_team_fund_requires_weight'));
minutes.attendance = [{ id: 'shift', employeeId: 'a', date: '2026-10-01', approved: true, workedMinutes: 60, plannedMinutes: 60 }];
assert.deepEqual(calculate(minutes).employees.map((row) => row.teamFundCents), [9600, 0]);
const conflict = fixture(); conflict.scheme.roleParameters.hookah.teamFund.targetCents = 0;
const multipleShifts = structuredClone(minutes);
multipleShifts.attendance.push({ ...multipleShifts.attendance[0], id: 'second', workedMinutes: 30, plannedMinutes: 60 });
multipleShifts.attendance.push({ ...multipleShifts.attendance[0], id: 'other', employeeId: 'b', workedMinutes: 30, plannedMinutes: 60 });
assert.deepEqual(calculate(multipleShifts).employees.map((row) => row.teamFundCents), [7200, 2400]);
const independentPools = fixture();
independentPools.scheme.roleParameters.hookah.teamFund.poolId = 'hookah-only';
assert.equal(calculate(independentPools).daily[0].teamFunds.length, 2);
assert.deepEqual(calculate(independentPools).employees.map((row) => row.teamFundCents), [3600, 3600]);
assert.ok(calculate(conflict).blockers.includes('conflicting_team_pool'));
conflict.sales = []; assert.ok(calculate(conflict).blockers.includes('conflicting_team_pool'));
const missing = fixture(); missing.employees.pop(); assert.equal(calculate(missing).status, 'blocked');
const duplicate = fixture(); duplicate.employees.push({ id: 'a' }); assert.ok(calculate(duplicate).blockers.includes('duplicate_employee_id'));
const replacement = fixture(); replacement.scheme.itemRules = [{ menuItemId: 'x', roleId: 'bar', mode: 'replace', rateBps: 1000 }];
assert.equal(calculate(replacement).daily[0].teamFunds[0].fundCents, 3600);
assert.equal(calculate(replacement).employees[0].commissionCents, 1500);
const additive = fixture(); additive.scheme.itemRules = [{ menuItemId: 'x', roleId: 'bar', mode: 'additive', rateBps: 1000 }];
assert.equal(calculate(additive).daily[0].teamFunds[0].fundCents, 9600);
assert.equal(calculate(additive).employees[0].amountCents, 6300);
const outside = fixture(); outside.sales[0].department = 'kitchen';
assert.equal(calculate(outside).daily[0].teamFunds[0].basisCents, 15000);
const capped = fixture(); capped.scheme.roleParameters.bar.cap = { basis: 'employee_department_day', department: 'bar', rateBps: 1000 };
assert.deepEqual(calculate(capped).employees.map((row) => row.amountCents), [1500, 4800], 'caps do not redistribute');
const ceiling = fixture(); ceiling.sales[1].turnoverCents = 0;
assert.equal(calculate(ceiling).payoutEligible, false);
const overflow = fixture(); overflow.sales[0].commissionBaseCents = Number.MAX_SAFE_INTEGER; overflow.sales[1].commissionBaseCents = Number.MAX_SAFE_INTEGER;
assert.ok(calculate(overflow).blockers.includes('amount_exceeds_safe_integer_cents'));
const mixed = fixture(); mixed.scheme.roleParameters.hookah = { mode: 'percent_only', stableRateBps: 1000 };
assert.equal(calculate(mixed).daily[0].teamFunds[0].basisCents, 15000);
assert.equal(calculate(mixed).employees[1].commissionCents, 1500);
const invalid = fixture(); invalid.scheme.employeeOverrides = [{ employeeId: 'a', path: 'teamFund.targetCents', mode: 'override', value: 0 }];
assert.equal(calculate(invalid).status, 'blocked');
const noSalesMember = fixture(); noSalesMember.sales.pop();
assert.deepEqual(calculate(noSalesMember).daily[0].teamFunds[0].memberIds, ['a', 'b']);
assert.deepEqual(calculate(noSalesMember).employees.map((row) => row.teamFundCents), [1800, 1800]);
assert.equal(calculate(noSalesMember).payoutEligible, false, 'configured weights intentionally include active member without sales');
const inactive = fixture(); inactive.employees[1].activeFrom = '2026-10-02'; inactive.sales.pop();
assert.deepEqual(calculate(inactive).daily[0].teamFunds[0].memberIds, ['a']);
const reset = fixture(); reset.periodTo = '2026-10-02'; reset.coverage.through = '2026-10-02'; reset.attendanceCoverage.through = '2026-10-02';
reset.sales.push(...reset.sales.map((row) => ({ ...row, id: `${row.id}2`, date: '2026-10-02' })));
assert.deepEqual(calculate(reset).daily.map((day) => day.teamFunds[0].fundCents), [9600, 9600]);
const modeOverride = fixture(); modeOverride.scheme.mode = 'stable_percent';
for (const params of Object.values(modeOverride.scheme.roleParameters)) params.stableRateBps = 1000;
modeOverride.scheme.employeeOverrides = [{ employeeId: 'a', path: 'mode', mode: 'override', value: 'team_fund' }];
assert.equal(calculate(modeOverride).daily[0].teamFunds[0].fundCents, 3600);
delete modeOverride.scheme.roleParameters.bar.teamFund;
assert.ok(calculate(modeOverride).blockers.includes('team_fund_required'));
console.log('PAYROLL TEAM FUND CONTRACT: PASS');
