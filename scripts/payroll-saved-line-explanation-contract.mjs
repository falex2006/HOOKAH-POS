import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Execute the actual UI renderer, including zero/negative/unknown stored facts.
const source = readFileSync(new URL('../payroll-scheme-ui.js', import.meta.url), 'utf8');
const start = source.indexOf('    const savedLineRule =');
const end = source.indexOf('    const dayDetails =', start);
assert.ok(start >= 0 && end > start);
const render = vm.runInNewContext(`${source.slice(start, end)}; savedLineRule`, {
  money: (value, currency) => `${value} ${currency}`
});
assert.equal(render({ commissionKind: 'scalar', appliedRateBps: 1250 }, 'RUB'), '12.5%');
assert.match(render({ commissionKind: 'personal_target' }, 'RUB'), /личному плану/);
const margin = render({ commissionKind: 'margin_target', netCostCents: 0, signedMarginCents: -250 }, 'RUB');
assert.match(margin, /Себестоимость: 0 RUB/);
assert.match(margin, /Маржа: -250 RUB/);
assert.match(render({ commissionKind: 'margin_target', netCostCents: null }, 'RUB'), /нет сохранённых данных/);
assert.match(render({ commissionKind: 'team_source', poolIncluded: true, poolBasisCents: 1200 }, 'RUB'), /Включена в фонд.*1200 RUB/);
for (const [reason, expected] of [['item_replacement', /отдельная комиссия/], ['department_outside_pool', /цех не входит/]]) {
  const html = render({ commissionKind: 'team_source', poolIncluded: false, poolBasisCents: 0, poolExclusionReason: reason }, 'RUB');
  assert.match(html, expected);
  assert.match(html, /только комиссия по товару/);
  assert.doesNotMatch(html, /Распределение по плану/);
}
assert.match(render({ commissionKind: 'team_source', poolIncluded: null, poolBasisCents: null }, 'RUB'), /Участие не подтверждено/);
assert.match(source, /additive: 'Доплата к основной ставке'/);
console.log('PASS saved-line explanation: scalar, personal plan, margin zero/loss/unknown, team inclusion/exclusions; actual UI renderer');
