import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../payroll-scheme-ui.js', import.meta.url), 'utf8');
assert.equal(fs.readFileSync(new URL('../dist/payroll-scheme-ui.js', import.meta.url), 'utf8'), source);
const start = source.indexOf('  const EDITOR_MODES ='), end = source.indexOf('  const venueLocalToday =', start);
assert.ok(start > 0 && end > start);
const context = vm.createContext({ structuredClone });
vm.runInContext(source.slice(start, end) + '\nglobalThis.helpers={editorValue,editorOverrideValue,editorApply,editorInheritedParameter,editorInheritedCaption,editorRoleOverrideImpact,editorPersonalCapIncreases,EDITOR_FIELDS,EDITOR_DEPARTMENT_HELP};', context);
const { editorValue: roleValue, editorOverrideValue: personalValue, editorApply: apply, editorInheritedParameter: read, editorInheritedCaption: caption } = context.helpers;
const definition = { mode: 'stable_percent', effectiveFrom: '2026-10-01', roleParameters: {
  bar: { perShiftCents: 0, stableRateBps: 5000, department: 'bar', cap: { basis: 'employee_department_day', rateBps: 3000, department: 'hookah' } },
  next: { perShiftCents: 0, stableRateBps: 5000, department: 'kitchen' }
}, roleAssignments: [{ employeeId: 'a', roleId: 'bar', effectiveFrom: '2026-10-01', effectiveTo: '2026-10-14' },
  { employeeId: 'a', roleId: 'next', effectiveFrom: '2026-10-15' }], employeeOverrides: [], itemRules: [] };
const personal = (path, text) => ({ index: null, employeeId: 'a', path, text, mode: 'override', effectiveFrom: '2026-10-02', effectiveTo: '2026-10-14' });
const invalid = ['', ' ', ' bar', 'bar ', 'a\tb', 'a\nb', 'a\u0000b', 'a\u007fb', 'a\u0085b', '\ud800', '\udfff', 'a\ud800b', null, undefined, 0, true, [], {}, 'x'.repeat(81), '😀'.repeat(81)];
for (const path of ['department', 'cap.department']) {
  assert.equal(context.helpers.EDITOR_FIELDS.find(row => row[0] === path)[2], 'departmentKey');
  for (const key of ['bar', 'Бар', 'цех кальянов', '0', 'x'.repeat(80), '😀'.repeat(80)]) {
    assert.equal(personalValue(path, key), key, 'exact string preserved, never converted to a number');
    assert.equal(roleValue(key, 'departmentKey'), key);
    const before = structuredClone(definition), changed = apply(definition, [], [personal(path, key)]);
    assert.equal(changed.employeeOverrides[0].value, key); assert.deepEqual(definition, before);
    assert.deepEqual(changed.roleParameters, definition.roleParameters);
    assert.equal(changed.employeeOverrides[0].effectiveFrom, '2026-10-02');
    assert.equal(changed.employeeOverrides[0].effectiveTo, '2026-10-14');
    const inherited = apply(changed, [], [{ ...personal(path, ''), index: 0, mode: 'inherit' }]);
    assert.equal(inherited.employeeOverrides[0].mode, 'inherit');
    assert.equal(Object.hasOwn(inherited.employeeOverrides[0], 'value'), false);
  }
  for (const value of invalid) {
    assert.throws(() => personalValue(path, value), `personal ${path}: ${String(value)}`);
    if (value !== '') {
      assert.throws(() => roleValue(value, 'departmentKey'));
      assert.throws(() => apply(definition, [{ role: 'bar', path, type: 'text', text: value }], []), 'path enforces type even if supplied field type is text');
    }
  }
  const cleared = apply(definition, [{ role: 'bar', path, type: 'departmentKey', text: '' }], []);
  assert.equal(path === 'department' ? Object.hasOwn(cleared.roleParameters.bar, 'department') : Object.hasOwn(cleared.roleParameters.bar.cap, 'department'), false);
}
assert.equal(roleValue('', 'departmentKey'), undefined, 'only truly empty role input removes the optional leaf');
assert.equal(read(definition, { employeeId: 'a', path: 'department', effectiveFrom: '2026-10-02' }).value, 'bar');
assert.equal(read(definition, { employeeId: 'a', path: 'cap.department', effectiveFrom: '2026-10-02' }).value, 'hookah');
const switched = { employeeId: 'a', path: 'cap.department', effectiveFrom: '2026-10-15' };
assert.equal(read(definition, switched).value, undefined, 'exact missing cap leaf is not mislabeled as inherited kitchen');
assert.equal(read(definition, { ...switched, path: 'department' }).value, 'kitchen');
assert.match(caption(definition, switched), /именно этого параметра.*цех лимита имеет приоритет/);
assert.throws(() => read(definition, { ...switched, path: 'department' }, [{ role: 'next', path: 'department', type: 'text', text: ' kitchen ' }]));
assert.match(context.helpers.EDITOR_DEPARTMENT_HELP, /цех лимита роли имеет приоритет даже над личным цехом сотрудника/);
assert.match(context.helpers.EDITOR_DEPARTMENT_HELP, /увеличить сумму выплаты при прежнем проценте/);
assert.match(source, /payroll_personal_department_schema_required:/);

// Submit also traverses the impact/risk helpers after the structured editor.
// Exercise that separate path, including validation before cap-rate filtering.
const { editorRoleOverrideImpact: impact, editorPersonalCapIncreases: increases } = context.helpers;
const employee = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const riskDefinition = structuredClone(definition);
for (const assignment of riskDefinition.roleAssignments) assignment.employeeId = employee;
riskDefinition.employeeOverrides = ['department', 'cap.department'].map((path, index) => ({
  employeeId: employee, path, mode: 'override', value: index ? 'bar' : 'hookah', effectiveFrom: '2026-10-02', effectiveTo: '2026-10-14'
}));
const riskCopy = structuredClone(riskDefinition);
assert.deepEqual(structuredClone(impact(riskDefinition)), [
  { roleId: 'bar', employeeId: employee, path: 'cap.department', value: 'bar', from: '2026-10-02', to: '2026-10-14' },
  { roleId: 'bar', employeeId: employee, path: 'department', value: 'hookah', from: '2026-10-02', to: '2026-10-14' }
]);
assert.deepEqual(structuredClone(increases(riskDefinition)), [], 'department changes do not fabricate a higher-percentage acknowledgement');
assert.deepEqual(riskDefinition, riskCopy);
riskDefinition.employeeOverrides.push({ ...riskDefinition.employeeOverrides[0], path: 'cap.rateBps', value: 4000 });
assert.deepEqual(structuredClone(increases(riskDefinition)), [{ employeeId: employee, roleId: 'bar', path: 'cap.rateBps',
  effectiveFrom: '2026-10-02', effectiveTo: '2026-10-14', roleRateBps: 3000, personalRateBps: 4000 }]);
for (const path of ['department', 'cap.department']) {
  for (const value of ['😀'.repeat(80), '0', 'цех кальянов']) {
    const raw = structuredClone(riskDefinition); raw.employeeOverrides.find(row => row.path === path).value = value;
    assert.equal(impact(raw, undefined, path)[0].value, value);
    assert.equal(increases(raw).length, 1, 'valid department must not prevent submitting a real cap-rate increase');
  }
  for (const value of invalid) {
    const raw = structuredClone(riskDefinition); raw.employeeOverrides.find(row => row.path === path).value = value;
    assert.throws(() => impact(raw), `raw impact ${path}: ${String(value)}`);
    assert.throws(() => increases(raw), 'cap-rate filtering must not skip malformed departments');
  }
  const inherited = structuredClone(riskDefinition); const row = inherited.employeeOverrides.find(row => row.path === path);
  row.mode = 'inherit'; delete row.value;
  assert.equal(impact(inherited, undefined, path).length, 0);
  assert.equal(increases(inherited).length, 1);
  const dated = structuredClone(riskDefinition); dated.employeeOverrides.find(row => row.path === path).effectiveTo = '2026-02-30';
  assert.throws(() => impact(dated)); assert.throws(() => increases(dated));
}
console.log('PAYROLL PERSONAL DEPARTMENT UI: PASS (strict exact Unicode strings, role removal, personal inherit, dated caption, submit impact/risk and source/dist parity)');
