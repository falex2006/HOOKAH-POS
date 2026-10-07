import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { collectPersonalCapIncreases } = require('../payroll-personal-cap-policy.js');
const source = fs.readFileSync(new URL('../payroll-scheme-ui.js', import.meta.url), 'utf8');
const start = source.indexOf('  const escapeHtml ='), end = source.indexOf('  const venueLocalToday =', start);
const context = { structuredClone }; vm.createContext(context);
vm.runInContext(`${source.slice(start, end)}\nglobalThis.detect=editorPersonalCapIncreases;`, context);
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const base = { effectiveFrom: '2026-10-01', effectiveTo: '2026-10-31', roleParameters: { bar: { cap: { rateBps: 3000 } }, kitchen: { cap: { rateBps: 4000 } } },
  roleAssignments: [{ employeeId: id.toUpperCase(), roleId: 'bar', effectiveFrom: '2026-09-01', effectiveTo: '2026-10-15' },
    { employeeId: id, roleId: 'kitchen', effectiveFrom: '2026-10-16', effectiveTo: null }],
  employeeOverrides: [{ employeeId: id, path: 'cap.rateBps', mode: 'override', value: 3500, effectiveFrom: '2026-10-15', effectiveTo: null }] };
for (const rate of [0, 3000, 3001, 3500, 4000, 4001, 10000]) {
  const data = structuredClone(base); data.employeeOverrides[0].value = rate;
  assert.deepEqual(JSON.parse(JSON.stringify(context.detect(data))), collectPersonalCapIncreases(data));
}
for (const mutate of [d => d.employeeOverrides[0].mode = 'inherit', d => { d.employeeOverrides[0].effectiveFrom = '2026-11-01'; d.employeeOverrides[0].effectiveTo = '2026-11-30'; },
  d => { d.effectiveTo = null; delete d.employeeOverrides[0].effectiveFrom; }, d => d.employeeOverrides[0].path = 'cap.basis']) {
  const data = structuredClone(base); mutate(data);
  if (data.employeeOverrides[0].path === 'cap.basis') data.employeeOverrides[0].value = 'venue_day';
  assert.deepEqual(JSON.parse(JSON.stringify(context.detect(data))), collectPersonalCapIncreases(data));
}
{ const data = structuredClone(base); delete data.roleParameters.bar.cap;
  assert.deepEqual(JSON.parse(JSON.stringify(context.detect(data))), collectPersonalCapIncreases(data)); }
for (const mutate of [d => d.roleParameters.bar.cap = {}, d => d.roleParameters.bar.cap = null, d => d.employeeOverrides[0].effectiveFrom = '2026-02-30',
  d => d.roleAssignments[1].effectiveFrom = '2026-10-15']) {
  const data = structuredClone(base); mutate(data);
  assert.throws(() => context.detect(data)); assert.throws(() => collectPersonalCapIncreases(data));
}
assert.match(source, /data-personal-cap-acknowledged/);
assert.match(source, /payoutRiskAcknowledgement\.personalCapIncrease/);
assert.match(source, /editor\.addEventListener\('change', resetPersonalCapAcknowledgement\)/);
console.log('PAYROLL PERSONAL CAP UI: PASS (advisory/server parity, dated higher rates, invalid state, separate acknowledgement)');
