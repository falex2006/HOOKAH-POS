import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../payroll-scheme-ui.js', import.meta.url), 'utf8');
const start = source.indexOf('  const EDITOR_MODES =');
const end = source.indexOf('  const venueLocalToday =', start);
assert.ok(start > 0 && end > start);
const context = { structuredClone }; vm.createContext(context);
vm.runInContext(`${source.slice(start, end)}\nglobalThis.helpers = { editorDecimal, editorFormat, editorApply, editorOverrideValue, editorGet, editorSet, editorMilestoneThresholds };`, context);
const { editorDecimal: parse, editorFormat: format, editorApply: apply, editorOverrideValue: value } = context.helpers;
assert.equal(parse('123,45'), 12345); assert.equal(parse('0'), 0); assert.equal(parse('1.2'), 120);
assert.equal(parse('90071992547409.91'), Number.MAX_SAFE_INTEGER);
assert.equal(format(Number.MAX_SAFE_INTEGER), '90071992547409.91');
for (const input of ['-1', '0.001', '1e3', 'Infinity', '', '90071992547409.92', '1.']) assert.throws(() => parse(input));
assert.equal(value('baseRateBps', '65'), 6500); assert.equal(value('perShiftCents', '0'), 0);
assert.equal(value('applyMilestones', 'false'), false); assert.throws(() => value('baseRateBps', '100.01'));
assert.throws(() => value('perShiftCents', '')); assert.throws(() => value('lossPolicy', 'clamp'));
const definition = { mode: 'stable_percent', currency: 'RUB', effectiveFrom: '2026-10-01', future: { keep: true },
  roleParameters: { bar: { perShiftCents: 50000, stableRateBps: 1600, future: { rate: 'keep' }, cap: { rateBps: 3000, basis: 'venue_day' } } },
  roleAssignments: [{ employeeId: 'uuid', roleId: 'bar', effectiveFrom: '2026-10-01', future: 'assignment' }], itemRules: [{ future: 'rule' }],
  employeeOverrides: [{ employeeId: 'uuid', path: 'perShiftCents', mode: 'override', value: 10000, effectiveFrom: '2026-10-01', future: 'audit' }] };
const changed = apply(definition, [{ role: 'bar', path: 'stableRateBps', type: 'rate', text: '0' }, { role: 'bar', path: 'perShiftCents', type: 'money', text: '1000.25' }], []);
assert.equal(changed.roleParameters.bar.stableRateBps, 0); assert.equal(changed.roleParameters.bar.perShiftCents, 100025);
assert.deepEqual(changed.future, definition.future); assert.deepEqual(changed.itemRules, definition.itemRules);
assert.deepEqual(changed.roleAssignments, definition.roleAssignments); assert.deepEqual(changed.roleParameters.bar.future, definition.roleParameters.bar.future);
assert.equal(definition.roleParameters.bar.stableRateBps, 1600, 'source is not mutated');
for (const [text, expected] of [['true', true], ['false', false]]) {
  const bool = apply(definition, [{ role: 'bar', path: 'applyMilestones', type: 'boolean', text }], []);
  assert.equal(bool.roleParameters.bar.applyMilestones, expected);
  assert.deepEqual(bool.roleParameters.bar.future, definition.roleParameters.bar.future);
  assert.deepEqual(apply(bool, [{ role: 'bar', path: 'applyMilestones', type: 'boolean', text }], []), bool);
  const inheritedBool = apply(bool, [{ role: 'bar', path: 'applyMilestones', type: 'boolean', text: '' }], []);
  assert.equal(Object.hasOwn(inheritedBool.roleParameters.bar, 'applyMilestones'), false);
}
for (const text of ['0', '1', 'FALSE', 'null', 'yes']) assert.throws(() => apply(definition, [{ role: 'bar', path: 'applyMilestones', type: 'boolean', text }], []));
const inherit = apply(definition, [], [{ index: 0, employeeId: 'uuid', path: 'perShiftCents', mode: 'inherit', text: '', effectiveFrom: '2026-10-01', effectiveTo: '' }]);
assert.equal(inherit.employeeOverrides[0].mode, 'inherit'); assert.equal(inherit.employeeOverrides[0].future, 'audit');
assert.equal(Object.hasOwn(inherit.employeeOverrides[0], 'value'), false);
const zero = apply(definition, [], [{ index: 0, employeeId: 'uuid', path: 'perShiftCents', mode: 'override', text: '0', effectiveFrom: '2026-10-01', effectiveTo: '2026-10-05' }]);
assert.equal(zero.employeeOverrides[0].value, 0);
const second = { index: null, employeeId: 'uuid', path: 'perShiftCents', mode: 'override', text: '5', effectiveFrom: '2026-10-06', effectiveTo: '' };
assert.equal(apply(zero, [], [second]).employeeOverrides.length, 2);
assert.throws(() => apply(zero, [], [{ ...second, effectiveFrom: '2026-10-05' }]), /пересекаются/);
assert.throws(() => apply(zero, [], [{ ...second, effectiveFrom: '2026-02-30' }]), /дат/);
assert.equal(apply(definition, [], [], [0]).employeeOverrides.length, 0);
const explicitNull = structuredClone(definition); explicitNull.employeeOverrides[0].effectiveTo = null;
const noOpEdit = { index: 0, employeeId: 'uuid', path: 'perShiftCents', mode: 'override', text: '100', effectiveFrom: '2026-10-01', effectiveTo: '' };
assert.deepEqual(apply(explicitNull, [], [noOpEdit]), explicitNull, 'blank unchanged window preserves explicit null');
const finiteEnd = structuredClone(explicitNull); finiteEnd.employeeOverrides[0].effectiveTo = '2026-10-05';
assert.equal(Object.hasOwn(apply(finiteEnd, [], [noOpEdit]).employeeOverrides[0], 'effectiveTo'), false, 'clearing finite end omits it');
for (const path of ['__proto__.polluted', 'constructor.prototype.polluted', 'cap.__proto__.polluted', 'prototype.polluted']) {
  assert.throws(() => context.helpers.editorSet({}, path, true), /путь/);
  assert.throws(() => context.helpers.editorGet({}, path), /путь/);
}
assert.equal(context.helpers.editorGet(Object.create({ inherited: { value: 1 } }), 'inherited.value'), undefined);
const inherited = Object.create({ cap: { shared: true } }); context.helpers.editorSet(inherited, 'cap.rateBps', 1000);
assert.equal(Object.hasOwn(inherited, 'cap'), true); assert.equal(inherited.cap.shared, undefined);
assert.equal({}.polluted, undefined);
const cleared = apply(definition, [{ role: 'bar', path: 'cap.rateBps', type: 'rate', text: '' }, { role: 'bar', path: 'cap.basis', type: 'text', text: '' }], []);
assert.equal(Object.hasOwn(cleared.roleParameters.bar, 'cap'), false);
const bonusDefinition = structuredClone(definition);
bonusDefinition.roleParameters.bar.milestoneBonusesCents = { 30000000: 250000, 50000000: 0 };
const bonusChanged = apply(bonusDefinition, [{ role: 'bar', path: 'milestoneBonusesCents.30000000', type: 'money', text: '2000,25' },
  { role: 'bar', path: 'milestoneBonusesCents.50000000', type: 'money', text: '0' },
  { role: 'bar', path: 'milestoneBonusesCents.70000000', type: 'money', text: '' }], []);
assert.deepEqual(bonusChanged.roleParameters.bar.milestoneBonusesCents, { 30000000: 200025, 50000000: 0 });
assert.deepEqual(bonusChanged.employeeOverrides, bonusDefinition.employeeOverrides);
assert.deepEqual(bonusChanged.roleParameters.bar.future, bonusDefinition.roleParameters.bar.future);
const bonusRemoved = apply(bonusChanged, [{ role: 'bar', path: 'milestoneBonusesCents.30000000', type: 'money', text: '' }], []);
assert.equal(Object.hasOwn(bonusRemoved.roleParameters.bar.milestoneBonusesCents, '30000000'), false);
assert.equal(bonusRemoved.roleParameters.bar.milestoneBonusesCents['50000000'], 0);
assert.deepEqual(Array.from(context.helpers.editorMilestoneThresholds(bonusDefinition)), ['30000000', '50000000']);
for (const key of ['0', '-1', '01', '1e3', '9007199254740992']) {
  const invalidBonus = structuredClone(definition); invalidBonus.roleParameters.bar.milestoneBonusesCents = { [key]: 0 };
  assert.throws(() => context.helpers.editorMilestoneThresholds(invalidBonus));
}
assert.match(source, /data-scheme-grid-fieldset/); assert.match(source, /data-grid-inherit/); assert.match(source, /data-grid-rate-table/);
assert.match(source, /gridFieldset\.disabled = true; definitionField\.readOnly = true/);
assert.match(source, /if \(gridDirty\)/, 'unapplied grid cannot silently save stale JSON');
assert.match(source, /payoutRiskAcknowledgementField\.checked = false; rebuildGrid\(\)/);
console.log('PAYROLL SCHEME EDITOR CONTRACT: PASS (exact familiar units, preservation, inheritance, windows and pending controls)');
