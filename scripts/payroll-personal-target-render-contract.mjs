import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { calculatePayrollScheme } = require('../payroll-schemes.js');
const ui = fs.readFileSync(new URL('../payroll-scheme-ui.js', import.meta.url), 'utf8');
const extract = (start, end) => {
  const first = ui.indexOf(start);
  const last = ui.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first, 'extract actual production renderer');
  return ui.slice(first, last);
};
const context = vm.createContext({ Intl, Map, Number });
vm.runInContext([
  extract('  const escapeHtml =', '  const venueLocalToday ='),
  extract('  const money =', '  const blockerLabels ='),
  'const MAX_RENDERED_EMPLOYEE_DAYS = 2000; const MAX_RENDERED_LINES = 2000; const blockerLabels = {amount_exceeds_safe_integer_cents:"Сумма слишком велика"}; const renderBlockers = () => ""; const renderCriticalErrors = () => "";',
  extract('  const renderDetails =', '  const renderPreview ='),
  'globalThis.render = renderDetails;'
].join('\n'), context);
const input = {
  scheme: { id: 'scheme', versionId: 'v', mode: 'personal_target', roleParameters: { bar: { perShiftCents: 0, targetCents: 10000, baseRateBps: 1600, bonusRateBps: 6500, excessRatePolicy: 'replace_base' } } },
  periodFrom: '2026-10-01', periodTo: '2026-10-01', employees: [{ id: 'a' }], attendance: [],
  roleAssignments: [{ employeeId: 'a', roleId: 'bar', effectiveFrom: '2026-10-01' }],
  coverage: { kind: 'month_to_date_complete', from: '2026-10-01', through: '2026-10-01', complete: true, watermark: 'render-scenario' },
  attendanceCoverage: { kind: 'approved_attendance_complete', from: '2026-10-01', through: '2026-10-01', complete: true, watermark: 'render-attendance' },
  sales: [{ id: '<script>x</script>', employeeId: 'a', date: '2026-10-01', department: 'bar', turnoverCents: 15000, commissionBaseCents: 15000 }]
};
const result = calculatePayrollScheme(input);
assert.equal(result.status, 'ready');
const html = context.render(result, new Map([['a', '<img src=x onerror=evil>']]));
assert.match(html, /Личный дневной план/);
assert.match(html, /комиссионная база/);
assert.match(html, /повышенная ставка заменяет базовую сверх плана/);
assert.match(html, /Дневной план: до/);
assert.doesNotMatch(html, /<script>|<img src=x/);
assert.match(html, /&lt;script&gt;/);
assert.doesNotMatch(html, /<td>0%<\/td>/);
input.scheme.roleParameters.bar.excessRatePolicy = 'add_to_base';
assert.match(context.render(calculatePayrollScheme(input), new Map()), /повышенная ставка добавляется к базовой/);
const overflow = structuredClone(result);
overflow.daily[0].employees[0].targetIncentive = { status: 'blocked', blocker: 'amount_exceeds_safe_integer_cents' };
const overflowHtml = context.render(overflow, new Map());
assert.match(overflowHtml, /Личный дневной план: Сумма слишком велика/);
assert.doesNotMatch(overflowHtml, /повышенная ставка заменяет/);
const teamInput = structuredClone(input);
teamInput.scheme.mode = 'team_fund';
teamInput.scheme.roleParameters.bar = { perShiftCents: 0, teamWeight: 1, teamFund: {
  poolId: '<team>', targetCents: 10000, baseRateBps: 1600, bonusRateBps: 4000,
  excessRatePolicy: 'replace_base', departments: ['bar'], distributionPolicy: 'configured_weights'
} };
const teamResult = calculatePayrollScheme(teamInput);
assert.equal(teamResult.status, 'ready');
const teamHtml = context.render(teamResult, new Map([['a', '<employee>']]));
assert.match(teamHtml, /Командный фонд &lt;team&gt;/);
assert.match(teamHtml, /по настроенным весам независимо от выхода/);
assert.match(teamHtml, /Доля командного фонда до лимитов/);
assert.match(teamHtml, /Командный фонд за период до лимитов/);
assert.match(teamHtml, /Вклад в общий фонд/);
assert.doesNotMatch(teamHtml, /<team>|<employee>/);
const limitedHtml = context.render(teamResult, new Map(), null, { employeeDays: 2000, lines: 2000, poolAllocations: 0 });
assert.match(limitedHtml, /Скрыто 1 долей/);
const marginInput = structuredClone(input);
marginInput.scheme.mode = 'margin_target';
marginInput.scheme.roleParameters.bar = { perShiftCents: 0, targetCents: 10000, baseRateBps: 1600, bonusRateBps: 4800,
  excessRatePolicy: 'replace_base', lossPolicy: 'offset_daily_losses', itemRuleBasis: 'net_revenue' };
marginInput.sales[0].costSnapshot = { id: '<cost>', version: '<v1>', currency: 'RUB', costCents: 10000 };
marginInput.sales.push({ ...marginInput.sales[0], id: 'loss-line', commissionBaseCents: 1000, turnoverCents: 1000,
  costSnapshot: { id: 'loss-cost', version: 'v1', currency: 'RUB', costCents: 6000 } });
const marginResult = calculatePayrollScheme(marginInput);
assert.equal(marginResult.status, 'ready');
assert.equal(marginResult.daily[0].employees[0].marginIncentive.signedMarginCents, 0);
const marginHtml = context.render(marginResult, new Map());
assert.match(marginHtml, /Маржа за день/);
assert.match(marginHtml, /зачтённые убытки/);
assert.match(marginHtml, /Себестоимость/);
assert.match(marginHtml, /-50/);
assert.match(marginHtml, /&lt;cost&gt;.*&lt;v1&gt;/);
assert.doesNotMatch(marginHtml, /<cost>|<v1>|<td>0%<\/td>/);
console.log('PAYROLL PERSONAL TARGET RENDER CONTRACT: PASS (actual renderer, component explanation, null rate and escaped content)');
