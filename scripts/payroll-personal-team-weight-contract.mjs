import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { calculatePayrollScheme: calculate, validateScheme, validatePersonalScalarAssignments } = createRequire(import.meta.url)('../payroll-schemes.js');

const day = n => `2026-10-0${n}`;
const fixture = (policy = 'approved_minutes') => {
  const teamFund = { poolId: 'shared', targetCents: 10000, baseRateBps: 1600, bonusRateBps: 4000,
    excessRatePolicy: 'replace_base', departments: ['bar'], distributionPolicy: policy };
  const params = { perShiftCents: 0, teamFund, ...(policy === 'configured_weights' ? { teamWeight: 1 } : {}) };
  return {
    scheme: { id: 's', versionId: 'v', currency: 'RUB', mode: 'team_fund',
      roleParameters: { bar: structuredClone(params), other: structuredClone(params) }, employeeOverrides: [], itemRules: [] },
    periodFrom: day(1), periodTo: day(3), employees: [{ id: 'a' }, { id: 'b' }],
    roleAssignments: [{ employeeId: 'a', roleId: 'bar', effectiveFrom: day(1) }, { employeeId: 'b', roleId: 'other', effectiveFrom: day(1) }],
    coverage: { kind: 'month_to_date_complete', from: day(1), through: day(3), complete: true, watermark: 'scenario' },
    attendanceCoverage: { kind: 'approved_attendance_complete', from: day(1), through: day(3), complete: true, watermark: 'scenario' },
    attendance: [1, 2, 3].flatMap(n => ['a', 'b'].map(employeeId => ({ id: `shift-${employeeId}-${n}`, employeeId,
      date: day(n), approved: true, workedMinutes: employeeId === 'a' ? 60 : 180, plannedMinutes: 180 }))),
    sales: [1, 2, 3].flatMap(n => ['a', 'b'].map(employeeId => ({ id: `line-${employeeId}-${n}`, employeeId,
      date: day(n), menuItemId: 'tea', department: 'bar', turnoverCents: 15000, commissionBaseCents: 15000 })))
  };
};
const personal = (value, from = day(2), to = day(2)) => ({ employeeId: 'a', path: 'teamWeight', mode: 'override', value, effectiveFrom: from, effectiveTo: to });
const ready = input => {
  assert.deepEqual(validateScheme(input.scheme), []);
  assert.deepEqual(validatePersonalScalarAssignments(input.scheme, input.roleAssignments), []);
  const result = calculate(input);
  assert.equal(result.status, 'ready', JSON.stringify(result.blockers));
  return result;
};
const allocations = result => result.daily.map(row => row.employees.map(employee => employee.teamFundCents));
const unchangedFund = result => {
  for (const row of result.daily) {
    // 10000 * 16% + (30000 - 10000) * 40% = 9600 minor units.
    assert.equal(row.teamFunds[0].fundCents, 9600);
    assert.equal(row.employees.reduce((sum, employee) => sum + employee.teamFundCents, 0), 9600);
  }
};

// A weight is allowed without a role leaf, but minutes still determine allocation.
for (const value of [0, 3, Number.MAX_SAFE_INTEGER]) {
  const input = fixture(); input.scheme.employeeOverrides = [personal(value)];
  const copy = structuredClone(input), result = ready(input);
  assert.deepEqual(allocations(result), [[2400, 7200], [2400, 7200], [2400, 7200]]);
  assert.equal(Object.hasOwn(input.scheme.roleParameters.bar, 'teamWeight'), false);
  unchangedFund(result); assert.deepEqual(input, copy, 'no mutation of role, source data or personal configuration');
  input.scheme.employeeOverrides = [{ ...personal(value), mode: 'inherit', value: undefined }];
  assert.deepEqual(ready(input), ready(fixture()), 'inherit preserves absence of role weight');
}

// Configured weights change only distribution, not pool size or sales attribution.
const configured = fixture('configured_weights'); configured.scheme.employeeOverrides = [personal(3)];
assert.deepEqual(allocations(ready(configured)), [[4800, 4800], [7200, 2400], [4800, 4800]]);
unchangedFund(ready(configured));
configured.scheme.employeeOverrides[0].value = 0;
assert.deepEqual(allocations(ready(configured)), [[4800, 4800], [0, 9600], [4800, 4800]]);
configured.scheme.employeeOverrides[0].mode = 'inherit';
assert.deepEqual(ready(configured), ready(fixture('configured_weights')));

// Personal mode and personal weight can complete a team configuration on a stable role.
const modeChange = fixture('configured_weights');
Object.assign(modeChange.scheme.roleParameters.bar, { mode: 'stable_percent', stableRateBps: 1000 });
delete modeChange.scheme.roleParameters.bar.teamWeight;
modeChange.scheme.employeeOverrides = [personal(3), { ...personal(3), path: 'mode', value: 'team_fund' }];
const modeCopy = structuredClone(modeChange), changed = ready(modeChange);
assert.deepEqual(changed.daily[1].employees.map(row => row.teamFundCents), [7200, 2400]);
assert.equal(changed.daily[0].employees[0].commissionCents, 1500);
assert.equal(changed.daily[2].employees[0].commissionCents, 1500);
assert.deepEqual(modeChange, modeCopy);
modeChange.scheme.employeeOverrides.reverse(); assert.deepEqual(ready(modeChange), changed, 'override order does not change mode/weight resolution');
for (const field of ['employees', 'roleAssignments', 'attendance', 'sales']) modeChange[field].reverse();
assert.deepEqual(ready(modeChange), changed, 'input order does not change allocation');
modeChange.scheme.employeeOverrides.find(row => row.path === 'teamWeight').mode = 'inherit';
assert.ok(validatePersonalScalarAssignments(modeChange.scheme, modeChange.roleAssignments).includes('invalid_team_weight'));
assert.equal(calculate(modeChange).status, 'blocked', 'inherit must not invent a missing required weight');

// Dated settings survive a role transition, while each role keeps its distribution policy.
const transition = fixture();
transition.scheme.roleParameters.weighted = { ...structuredClone(transition.scheme.roleParameters.bar), teamWeight: 1,
  teamFund: { ...structuredClone(transition.scheme.roleParameters.bar.teamFund), poolId: 'weighted', distributionPolicy: 'configured_weights' } };
transition.roleAssignments = ['a', 'b'].flatMap(employeeId => [
  { employeeId, roleId: 'bar', effectiveFrom: day(1), effectiveTo: day(1) },
  { employeeId, roleId: 'weighted', effectiveFrom: day(2) }
]);
transition.scheme.employeeOverrides = [personal(3, day(1), day(2))];
assert.deepEqual(allocations(ready(transition)), [[2400, 7200], [7200, 2400], [4800, 4800]]);
unchangedFund(ready(transition));

for (const value of [-1, 0.5, '3', null, true, Number.MAX_SAFE_INTEGER + 1]) {
  const input = fixture(); input.scheme.employeeOverrides = [personal(value)];
  assert.ok(validateScheme(input.scheme).includes('invalid_employee_override_value'));
  assert.equal(calculate(input).status, 'blocked');
}
const forbidden = fixture(); forbidden.scheme.employeeOverrides = [{ ...personal(0), path: 'teamFund.targetCents' }];
assert.ok(validateScheme(forbidden.scheme).includes('invalid_employee_override'));
const incompleteRole = fixture('configured_weights');
delete incompleteRole.scheme.roleParameters.bar.teamWeight;
incompleteRole.scheme.employeeOverrides = [personal(3, day(1), day(3))];
assert.ok(validateScheme(incompleteRole.scheme).includes('invalid_team_weight'), 'personal values do not bypass complete base-role validation');
assert.equal(calculate(incompleteRole).status, 'blocked');
const expired = fixture('configured_weights');
Object.assign(expired.scheme.roleParameters.bar, { mode: 'stable_percent', stableRateBps: 1000 });
delete expired.scheme.roleParameters.bar.teamWeight;
expired.scheme.employeeOverrides = [personal(3), { ...personal(3, day(2), day(3)), path: 'mode', value: 'team_fund' }];
assert.ok(validatePersonalScalarAssignments(expired.scheme, expired.roleAssignments).includes('invalid_team_weight'), 'weight expiry is checked beyond the preview period');
const noMinutes = fixture(); noMinutes.attendance = []; noMinutes.scheme.employeeOverrides = [personal(3, day(1), day(3))];
assert.ok(calculate(noMinutes).blockers.includes('positive_team_fund_requires_weight'), 'configured weight cannot replace missing approved minutes');
console.log('PAYROLL PERSONAL TEAM WEIGHT: PASS (missing role leaf, both policies, zero/inherit, dated role and mode transitions, conservation)');
