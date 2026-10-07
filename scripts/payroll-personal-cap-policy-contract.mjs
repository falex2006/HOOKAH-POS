import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { collectPersonalCapIncreases: collect } = require('../payroll-personal-cap-policy.js');
const employee = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const fixture = () => ({ effectiveFrom: '2026-10-01', effectiveTo: '2026-10-31',
  roleParameters: { bar: { cap: { rateBps: 3000 } }, hookah: { cap: { rateBps: 4000 } } },
  roleAssignments: [{ employeeId: employee, roleId: 'bar', effectiveFrom: '2026-10-01', effectiveTo: '2026-10-14' },
    { employeeId: employee.toUpperCase(), roleId: 'hookah', effectiveFrom: '2026-10-15', effectiveTo: '2026-10-31' }],
  employeeOverrides: [{ employeeId: employee.toUpperCase(), path: 'cap.rateBps', mode: 'override', value: 3500 }] });
const expected = { employeeId: employee, roleId: 'bar', path: 'cap.rateBps', effectiveFrom: '2026-10-01',
  effectiveTo: '2026-10-14', roleRateBps: 3000, personalRateBps: 3500 };
const original = fixture(); const before = structuredClone(original);
assert.deepEqual(collect(original), [expected]); assert.deepEqual(original, before);
for (const value of [0, 2999, 3000]) { const input = fixture(); input.employeeOverrides[0].value = value; assert.deepEqual(collect(input), []); }
{ const input = fixture(); input.employeeOverrides[0].mode = 'inherit'; delete input.employeeOverrides[0].value; assert.deepEqual(collect(input), []); }
{ const input = fixture(); input.employeeOverrides[0].value = 3001; assert.equal(collect(input)[0].personalRateBps, 3001); }
{ const input = fixture(); input.employeeOverrides[0].effectiveFrom = '2026-10-14'; input.employeeOverrides[0].effectiveTo = '2026-10-15';
  assert.deepEqual(collect(input), [{ ...expected, effectiveFrom: '2026-10-14', effectiveTo: '2026-10-14' }]); }
{ const input = fixture(); input.employeeOverrides[0].effectiveFrom = '2026-11-01'; input.employeeOverrides[0].effectiveTo = '2026-11-30'; assert.deepEqual(collect(input), []); }
{ const input = fixture(); input.effectiveTo = null; input.roleAssignments = [{ employeeId: employee, roleId: 'bar', effectiveFrom: '2026-09-01' }];
  input.employeeOverrides[0].effectiveFrom = '2026-09-01'; input.employeeOverrides[0].effectiveTo = null;
  assert.deepEqual(collect(input), [{ ...expected, effectiveTo: null }]); }
{ const input = fixture(); input.employeeOverrides[0].value = 4500; assert.equal(collect(input).length, 2); }
{ const input = fixture(); input.roleAssignments.push({ employeeId: other, roleId: 'bar', effectiveFrom: '2026-10-01' });
  input.employeeOverrides.push({ employeeId: other, path: 'cap.rateBps', mode: 'override', value: 10000 });
  const normal = collect(input); input.roleAssignments.reverse(); input.employeeOverrides.reverse(); assert.deepEqual(collect(input), normal);
  normal[0].roleRateBps = 0; assert.equal(input.roleParameters.bar.cap.rateBps, 3000); }
const reject = (change, suffix) => { const input = fixture(); change(input); assert.throws(() => collect(input), error => error.code === `payroll_personal_cap_${suffix}`); };
reject(input => { input.effectiveFrom = '2026-02-30'; }, 'window_invalid');
reject(input => { input.effectiveTo = '2026-09-30'; }, 'window_invalid');
reject(input => { input.employeeOverrides[0].effectiveFrom = '2026-10-20'; input.employeeOverrides[0].effectiveTo = '2026-10-19'; }, 'window_invalid');
for (const value of [-1, 10001, 1.5, Number.MAX_SAFE_INTEGER + 1, '3500', null, NaN, Infinity]) reject(input => { input.employeeOverrides[0].value = value; }, 'rate_invalid');
reject(input => { input.roleParameters.bar.cap.rateBps = 10001; }, 'rate_invalid');
{ const input = fixture(); delete input.roleParameters.bar.cap;
  assert.ok(collect(input).every(row => row.roleId !== 'bar'), 'absent role cap creates no increase exception'); }
reject(input => { input.roleParameters.bar.cap = {}; }, 'role_baseline_missing');
reject(input => { input.roleAssignments[1].effectiveFrom = '2026-10-14'; }, 'assignment_ambiguous');
reject(input => { input.employeeOverrides.push({ ...input.employeeOverrides[0], mode: 'inherit' }); }, 'override_ambiguous');
reject(input => { input.employeeOverrides[0].employeeId = 'unknown'; }, 'employee_invalid');
reject(input => { input.roleAssignments[0].roleId = 'unknown'; }, 'role_invalid');
reject(input => { input.employeeOverrides[0].mode = 'unknown'; }, 'override_invalid');
let getters = 0;
reject(input => { Object.defineProperty(input.roleParameters.bar.cap, 'rateBps', { get() { getters++; return 3000; } }); }, 'definition_invalid');
assert.equal(getters, 0);
reject(input => { Object.setPrototypeOf(input.roleParameters.bar, { cap: { rateBps: 3000 } }); }, 'definition_invalid');
reject(input => { Object.defineProperty(input, '__proto__', { value: {} }); }, 'definition_invalid');
reject(input => { input.extra = input; }, 'definition_invalid');
reject(input => { input.employeeOverrides = Array(2); }, 'definition_invalid');
// Service capacity is 15,000 total child rows. Large sequential histories must
// not gain a lower helper limit or quadratic overlap validation.
const dayAt = index => new Date(Date.UTC(2000, 0, 1 + index)).toISOString().slice(0, 10);
const large = { effectiveFrom: dayAt(0), effectiveTo: dayAt(14999), roleParameters: { bar: { cap: { rateBps: 3000 } } },
  roleAssignments: Array.from({ length: 15000 }, (_, i) => ({ employeeId: employee, roleId: 'bar', effectiveFrom: dayAt(i), effectiveTo: dayAt(i) })),
  employeeOverrides: [] };
assert.deepEqual(collect(large), []);
large.roleAssignments.reverse(); assert.deepEqual(collect(large), []);
large.roleAssignments = [{ employeeId: employee, roleId: 'bar', effectiveFrom: dayAt(0), effectiveTo: dayAt(14999) }];
large.employeeOverrides = Array.from({ length: 14999 }, (_, i) => ({ employeeId: employee, path: 'cap.rateBps', mode: 'override', value: 3001,
  effectiveFrom: dayAt(i), effectiveTo: dayAt(i) }));
const largeResult = collect(large); assert.equal(largeResult.length, 14999);
large.employeeOverrides.reverse(); assert.deepEqual(collect(large), largeResult);
console.log('PAYROLL PERSONAL CAP POLICY CONTRACT: PASS (dated higher-cap exceptions, strict identity/rates/windows, ambiguity, detached pure result)');
