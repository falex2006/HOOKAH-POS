import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../payroll-scheme-ui.js', import.meta.url), 'utf8');
const start = source.indexOf('  const escapeHtml ='), end = source.indexOf('  const venueLocalToday =', start);
const context = { structuredClone }; vm.createContext(context);
vm.runInContext(`${source.slice(start,end)}\nglobalThis.helpers={editorRoleOverrideImpact,editorRoleImpactHtml,editorApply};`, context);
const { editorRoleOverrideImpact: impact, editorRoleImpactHtml: html, editorApply: apply } = context.helpers;
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const definition = { effectiveFrom: '2026-10-01', effectiveTo: '2026-10-31', roleParameters: { bar: {}, kitchen: {} },
  roleAssignments: [{ employeeId: id.toUpperCase(), roleId: 'bar', effectiveFrom: '2026-09-01', effectiveTo: '2026-10-15' },
    { employeeId: id, roleId: 'kitchen', effectiveFrom: '2026-10-16' }],
  employeeOverrides: [{ employeeId: id, path: 'perShiftCents', mode: 'override', value: 0, effectiveFrom: '2026-10-15', effectiveTo: null },
    { employeeId: id, path: 'stableRateBps', mode: 'inherit', effectiveFrom: '2026-10-01' },
    { employeeId: id, path: 'cap.rateBps', mode: 'override', value: 1500, effectiveFrom: '2026-11-01' }] };
const original = structuredClone(definition);
const bar = impact(definition, 'bar'); assert.equal(bar.length, 1);
assert.equal(bar[0].value, 0); assert.equal(bar[0].from, '2026-10-15'); assert.equal(bar[0].to, '2026-10-15');
assert.equal(impact(definition, 'kitchen')[0].from, '2026-10-16');
assert.equal(impact(definition, 'bar', 'stableRateBps').length, 0);
assert.equal(impact(definition, 'bar', 'cap.basis').length, 0);
assert.deepEqual(definition, original, 'helper does not rewrite UUIDs or JSON');
for (const date of ['2026-02-30', '2026-13-01', '2026-1-01', '']) {
  const invalid = structuredClone(definition); invalid.roleAssignments[0].effectiveFrom = date;
  assert.throws(() => impact(invalid, 'bar'));
}
const reversed = structuredClone(definition); reversed.employeeOverrides[0].effectiveTo = '2026-10-14'; assert.throws(() => impact(reversed,'bar'));
const overlap = structuredClone(definition); overlap.roleAssignments[1].effectiveFrom = '2026-10-15'; assert.throws(() => impact(overlap,'bar'), /пересекаются/);
const duplicate = structuredClone(definition); duplicate.employeeOverrides.push({ ...duplicate.employeeOverrides[0], employeeId: id.toUpperCase() }); assert.throws(() => impact(duplicate,'bar'), /пересекаются/);
for (const patch of [{ employeeId: null }, { roleId: '__proto__' }, { effectiveTo: {} }]) {
  const bad = structuredClone(definition); Object.assign(bad.roleAssignments[0],patch); assert.throws(() => impact(bad,'bar'));
}
const badPath = structuredClone(definition); badPath.employeeOverrides[0].path='__proto__.polluted'; assert.throws(() => impact(badPath,'bar'));
const inherited = apply(definition, [], [{ index: 0, employeeId: id, path: 'perShiftCents', mode: 'inherit', text: '', effectiveFrom: '2026-10-15', effectiveTo: '' }]);
assert.equal(impact(inherited, 'bar').length, 0);
const unsaved = apply(definition, [], [{ index: 0, employeeId: id, path: 'perShiftCents', mode: 'override', text: '10', effectiveFrom: '', effectiveTo: '' }]);
assert.equal(impact(unsaved,'bar')[0].from, '2026-10-01', 'blank start uses canonical open override intersection');
assert.equal(impact(unsaved,'bar')[0].value, 1000);
const open = structuredClone(definition); delete open.effectiveTo; delete open.employeeOverrides[0].effectiveFrom;
assert.equal(impact(open,'kitchen').find(row => row.path==='perShiftCents').to,'9999-12-31');
const malicious = html([{ employeeId: '<img src=x>', path: 'mode', value: '<script>', from: '2026-10-01', to: '2026-10-31' }], '<b>');
assert.match(malicious,/&lt;img/); assert.match(malicious,/&lt;script&gt;/); assert.match(malicious,/&lt;b&gt;/);
assert.doesNotMatch(malicious, /<img|<script|<b>/);
assert.match(source,/data-grid-role-impact/); assert.match(source,/definitionField.addEventListener\('input', refreshRoleImpact\)/);
assert.match(source,/editorApply\(gridSource, rawGridFields\(\), rawGridOverrides\(\)\)/);
assert.match(source,/data\.impactState|dataset\.impactState/);
console.log('PAYROLL ROLE OVERRIDE IMPACT: PASS (calendar intersections, exact paths, inheritance, UUID comparisons, unsaved edits, escaping)');
