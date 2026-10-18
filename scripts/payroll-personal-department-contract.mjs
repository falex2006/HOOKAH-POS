import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { calculatePayrollScheme: calculate, validateScheme, validatePersonalScalarAssignments } = createRequire(import.meta.url)('../payroll-schemes.js');

// Configuration/scenario proof only; these fixtures do not attest shift sources.
const day = n => `2026-10-0${n}`;
const fixture = () => ({
  scheme: { id: 's', versionId: 'v', mode: 'stable_percent', currency: 'RUB',
    roleParameters: { r: { perShiftCents: 0, stableRateBps: 5000, department: 'bar', cap: { basis: 'employee_department_day', rateBps: 3000 } } },
    employeeOverrides: [], itemRules: [] },
  periodFrom: day(1), periodTo: day(3), employees: [{ id: 'a' }, { id: 'b' }],
  roleAssignments: ['a', 'b'].map(employeeId => ({ employeeId, roleId: 'r', effectiveFrom: day(1), effectiveTo: day(3) })),
  attendance: [],
  sales: [1, 2, 3].flatMap(n => ['a', 'b'].flatMap(employeeId => [['bar', 10000], ['hookah', 30000]].map(([department, amount]) => ({
    id: `${employeeId}-${n}-${department}`, employeeId, department, date: day(n), menuItemId: department,
    commissionBaseCents: amount, turnoverCents: amount
  })))),
  coverage: { kind: 'month_to_date_complete', from: day(1), through: day(3), complete: true, watermark: 'scenario' },
  attendanceCoverage: { kind: 'approved_attendance_complete', from: day(1), through: day(3), complete: true, watermark: 'scenario' }
});
const override = (path, value, from = day(2), to = day(2)) => ({ employeeId: 'a', path, value, mode: 'override', effectiveFrom: from, effectiveTo: to });
const ready = input => {
  assert.deepEqual(validateScheme(input.scheme), []);
  assert.deepEqual(validatePersonalScalarAssignments(input.scheme, input.roleAssignments), []);
  const result = calculate(input);
  assert.equal(result.status, 'ready', JSON.stringify(result.blockers));
  return result;
};
const amounts = (result, id = 'a') => result.daily.map(d => d.employees.find(e => e.employeeId === id).amountCents);
const inspectMoney = result => {
  for (const d of result.daily) for (const employee of d.employees) {
    // Independent oracle: (10000 + 30000) * 50% = 20000 before cap.
    assert.equal(employee.commissionCents, 20000);
    assert.equal(employee.amountBeforeCapCents, 20000);
    assert.equal(employee.capReductionCents, 20000 - employee.amountCents);
    assert.deepEqual(employee.departmentTurnoverCents, { bar: 10000, hookah: 30000 });
  }
};
const cases = [];
const check = (name, run) => cases.push([name, run]);

check('personal department fallback changes only intended employee and date', () => {
  const input = fixture(), baseline = ready(input);
  assert.deepEqual(amounts(baseline), [3000, 3000, 3000]);
  input.scheme.employeeOverrides = [override('department', 'hookah')];
  const before = structuredClone(input), result = ready(input);
  assert.deepEqual(amounts(result), [3000, 9000, 3000]);
  assert.deepEqual(result.employees.find(e => e.employeeId === 'b'), baseline.employees.find(e => e.employeeId === 'b'));
  inspectMoney(result); assert.deepEqual(input, before, 'roles, overrides and sales stay detached');
  input.scheme.employeeOverrides[0].mode = 'inherit'; delete input.scheme.employeeOverrides[0].value;
  assert.deepEqual(ready(input), baseline, 'inherit restores the exact role department leaf');
});

check('specific role cap department takes precedence over personal general department', () => {
  const input = fixture(); input.scheme.roleParameters.r.cap.department = 'bar';
  input.scheme.employeeOverrides = [override('department', 'hookah')];
  assert.deepEqual(amounts(ready(input)), [3000, 3000, 3000]);
  input.scheme.employeeOverrides.push(override('cap.department', 'hookah'));
  const result = ready(input); assert.deepEqual(amounts(result), [3000, 9000, 3000]); inspectMoney(result);
  input.scheme.employeeOverrides.reverse(); assert.deepEqual(ready(input), result);
  const specific = input.scheme.employeeOverrides.find(r => r.path === 'cap.department'); specific.mode = 'inherit'; delete specific.value;
  assert.deepEqual(amounts(ready(input)), [3000, 3000, 3000], 'inherit restores role cap.department, not personal department');
});

check('inherit absent specific leaf falls back to effective personal department', () => {
  const input = fixture(); input.scheme.employeeOverrides = [override('department', 'hookah'), override('cap.department', 'bar')];
  assert.deepEqual(amounts(ready(input)), [3000, 3000, 3000]);
  input.scheme.employeeOverrides[1].mode = 'inherit'; delete input.scheme.employeeOverrides[1].value;
  assert.deepEqual(amounts(ready(input)), [3000, 9000, 3000]);
});

for (const departmentPath of ['department', 'cap.department']) check(`standalone cap with new ${departmentPath} and no role leaves`, () => {
  const input = fixture(); delete input.scheme.roleParameters.r.cap; delete input.scheme.roleParameters.r.department;
  input.scheme.employeeOverrides = [override('cap.rateBps', 3000), override('cap.basis', 'employee_department_day'), override(departmentPath, 'hookah')];
  const before = structuredClone(input), result = ready(input);
  assert.deepEqual(amounts(result), [20000, 9000, 20000]);
  assert.deepEqual(amounts(result, 'b'), [20000, 20000, 20000]); assert.deepEqual(input, before);
  for (const path of ['cap.rateBps', 'cap.basis', departmentPath]) {
    const broken = structuredClone(input); broken.scheme.employeeOverrides = broken.scheme.employeeOverrides.filter(r => r.path !== path);
    assert.equal(calculate(broken).status, 'blocked', `missing ${path} cannot be invented`);
    assert.ok(validatePersonalScalarAssignments(broken.scheme, broken.roleAssignments).length);
  }
  for (const row of input.scheme.employeeOverrides) { row.mode = 'inherit'; delete row.value; }
  assert.deepEqual(amounts(ready(input)), [20000, 20000, 20000]);
});

check('department only does not create an implicit cap; specific cap leaf alone is incomplete', () => {
  const input = fixture(); delete input.scheme.roleParameters.r.cap; delete input.scheme.roleParameters.r.department;
  input.scheme.employeeOverrides = [override('department', 'hookah')];
  assert.deepEqual(amounts(ready(input)), [20000, 20000, 20000]);
  input.scheme.employeeOverrides[0].path = 'cap.department';
  assert.equal(calculate(input).status, 'blocked');
});

check('dated expiry revalidates required department outside the preview period', () => {
  const input = fixture(); delete input.scheme.roleParameters.r.cap; delete input.scheme.roleParameters.r.department;
  input.scheme.employeeOverrides = [override('cap.rateBps', 3000, day(1), day(3)), override('cap.basis', 'employee_department_day', day(1), day(3)), override('department', 'hookah', day(1), day(2))];
  input.periodTo = day(2);
  assert.ok(validatePersonalScalarAssignments(input.scheme, input.roleAssignments).includes('cap_department_required'));
  input.scheme.employeeOverrides[2].effectiveTo = day(3);
  assert.deepEqual(validatePersonalScalarAssignments(input.scheme, input.roleAssignments), []);
});

check('personal windows cross roles without changing the explicit cap priority', () => {
  const input = fixture(); input.scheme.roleParameters.next = { ...structuredClone(input.scheme.roleParameters.r), department: 'hookah', cap: { basis: 'employee_department_day', rateBps: 3000, department: 'bar' } };
  input.roleAssignments = [{ employeeId: 'a', roleId: 'r', effectiveFrom: day(1), effectiveTo: day(1) }, { employeeId: 'a', roleId: 'next', effectiveFrom: day(2), effectiveTo: day(3) }, input.roleAssignments[1]];
  input.scheme.employeeOverrides = [override('department', 'hookah', day(1), day(3)), override('cap.department', 'hookah', day(2), day(2))];
  const result = ready(input); assert.deepEqual(amounts(result), [9000, 9000, 3000]); inspectMoney(result);
  for (const key of ['employees', 'roleAssignments', 'sales']) input[key].reverse();
  input.scheme.employeeOverrides.reverse(); assert.deepEqual(ready(input), result);
});

const invalid = ['', ' ', ' bar', 'bar ', '\tbar', 'ba\nr', 'ba\u0000r', 'ba\u007fr', 'ba\u0085r', null, false, true, 0, 7, [], {}, ['bar'], { id: 'bar' }, 'x'.repeat(81), '😀'.repeat(81)];
check('strict personal and dormant role department types', () => {
  for (const value of invalid) for (const path of ['department', 'cap.department']) {
    const personal = fixture(); personal.scheme.employeeOverrides = [override(path, value)];
    assert.ok(validateScheme(personal.scheme).length, `personal ${path}: ${JSON.stringify(value)}`);
    assert.equal(calculate(personal).status, 'blocked');
    const role = fixture(); role.scheme.roleParameters.r.cap.basis = 'venue_day';
    if (path === 'department') role.scheme.roleParameters.r.department = value;
    else role.scheme.roleParameters.r.cap.department = value;
    assert.ok(validateScheme(role.scheme).length, `dormant role ${path}: ${JSON.stringify(value)}`);
    assert.equal(calculate(role).status, 'blocked');
  }
});

check('valid exact department keys and Unicode codepoint boundary', () => {
  for (const key of ['😀'.repeat(80), 'x'.repeat(80), '123', 'Bar', 'цех кальянов']) {
    const input = fixture(); input.scheme.roleParameters.r.department = key;
    for (const line of input.sales) if (line.department === 'bar') line.department = key;
    input.scheme.employeeOverrides = [override('cap.department', key)];
    const before = structuredClone(input); assert.deepEqual(amounts(ready(input)), [3000, 3000, 3000]); assert.deepEqual(input, before);
  }
  const exact = fixture(); exact.scheme.employeeOverrides = [override('department', 'BAR')];
  assert.deepEqual(amounts(ready(exact)), [3000, 0, 3000], 'department keys are not case-normalized');
});

check('malformed sales department keys block before calculation', () => {
  for (const value of [...invalid, undefined]) {
    const input = fixture(); input.sales[0].department = value;
    const result = calculate(input);
    assert.equal(result.status, 'blocked', `sales department ${JSON.stringify(value)}`);
    assert.ok(result.blockers.includes('invalid_sales_line'));
  }
});

const failures = [];
for (const [name, run] of cases) {
  try { run(); console.log(`PASS ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.message}`); }
}
assert.deepEqual(failures, [], 'personal department semantics and strict identifiers must hold; scenario only');
console.log(`PAYROLL PERSONAL DEPARTMENT: PASS (${cases.length} cases; exact-leaf inheritance, independent 3000/9000 caps, strict strings and dated validation)`);
