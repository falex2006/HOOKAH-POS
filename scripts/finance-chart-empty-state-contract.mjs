import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const portal = readFileSync(new URL('../portal.js', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../style.css', import.meta.url), 'utf8');
const chartStart = portal.indexOf('const drawFinanceChart = (analytics) => {');
const chartEnd = portal.indexOf('\n  };', chartStart);
assert.ok(chartStart >= 0 && chartEnd > chartStart, 'finance chart renderer exists');
const chart = portal.slice(chartStart, chartEnd);
assert.ok(chart.includes('class="finance-data-table-wrap" tabindex="0" role="region" aria-label="Динамика показателей по дням"'), 'scrollable table is named and keyboard focusable');
const dateFormatterSource = portal.slice(portal.indexOf('const formatRuDate ='), portal.indexOf('; const pluralRu='));
const formatDate = new Function(`${dateFormatterSource}; return formatRuDate;`)();
assert.equal(formatDate('2026-09-23'), '23.09.2026');
assert.equal(formatDate('2026-01-02').slice(0, 5), '02.01');
assert.equal(formatDate(null), '—');
assert.equal(formatDate('not-a-date'), 'not-a-date');
for (const group of ['finance-chart', 'payment']) {
  const buttons = [...portal.matchAll(new RegExp(`<button[^>]*aria-pressed="(true|false)"[^>]*data-${group}-view="([^"]+)"`, 'g'))];
  assert.equal(buttons.filter((match) => match[1] === 'true').length, 1, `${group}: one initial selected view`);
  assert.equal(buttons.length, group === 'payment' ? 4 : 3);
}
assert.ok((portal.match(/item\.setAttribute\('aria-pressed', String\(item === button\)\)/g) || []).length >= 2, 'all view handlers synchronize pressed state');
const bindingStart = portal.indexOf("document.querySelectorAll('[data-payment-view]').forEach((button) => { button.disabled = false;");
assert.ok(bindingStart >= 0, 'payment handlers replace the previous load closure');
const bindingEnd = portal.indexOf(' const shiftStateKnown =', bindingStart);
assert.ok(bindingEnd > bindingStart, 'payment view handlers end before shared shift rendering');
const binding = portal.slice(bindingStart, bindingEnd);
const buttons = ['donut', 'bars', 'line', 'table'].map((view) => ({
  dataset: { paymentView: view }, classList: { toggle() {} },
  setAttribute(name, value) { this[name] = value; }
}));
const calls = [];
const bind = new Function('document', 'renderPayments', binding);
const documentMock = { querySelectorAll: () => buttons };
bind(documentMock, (view) => calls.push(`old:${view}`));
bind(documentMock, (view) => calls.push(`current:${view}`));
buttons[3].onclick();
assert.deepEqual(calls, ['current:table'], 'repeat loading dispatches only the current payment renderer');
assert.deepEqual(buttons.map((button) => button['aria-pressed']), ['false', 'false', 'false', 'true']);
assert.ok(chart.includes('esc(formatRuDate(days[index].date))'), 'point tooltip uses Russian date');
assert.ok(chart.includes('esc(formatRuDate(day.date))'), 'table uses full Russian date');
assert.ok(chart.includes('esc(formatRuDate(days[index].date).slice(0, 5))'), 'line axis uses day.month');
assert.ok(chart.includes('esc(formatRuDate(day.date).slice(0, 5))'), 'bar axis uses day.month');
assert.ok(!chart.includes("slice(5).replace('-', '.')"), 'US month.day labels removed');

assert.match(chart, /if \(metric === 'orders' \|\| metric === 'average' \|\| metric === 'average_median'\) return orders > 0/,
  'orders and average-check series require actual order activity');
assert.match(chart, /if \(metric === 'expenses'\) return expenses > 0/,
  'expense series requires actual expense activity');
assert.match(chart, /if \(metric === 'profit'\) return orders > 0 \|\| revenue > 0 \|\| expenses > 0 \|\| costOfGoods > 0/,
  'profit series distinguishes a real zero result from no source activity');
assert.ok(chart.includes('chart.innerHTML = days.length && hasMetricData ?') && chart.includes('class="finance-chart-summary"'),
  'summary and plot are omitted when no activity exists for the selected metric');
assert.match(chart, /class="finance-chart-empty" role="status" aria-live="polite"/,
  'empty period uses an accessible explanatory state instead of a flat zero chart');
assert.match(styles, /\.finance-chart-empty\{[^}]*min-height:210px/,
  'the no-data state has intentional layout and visual hierarchy');
assert.match(styles, /\.finance-kpi-grid\{grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/,
  'the three finance KPIs fill the available desktop row');
assert.match(styles, /\.finance-expenses-panel #expense-form>\.form-row\{[^}]*grid-template-columns:minmax\(0,1fr\)/,
  'finance expense fields stack within the narrow phone workspace');
assert.match(styles, /\.finance-expenses-panel #expense-form\{[^}]*grid-template-columns:minmax\(0,1fr\)/,
  'the expense form grid itself must release its content-sized implicit track on phones');
assert.match(styles, /\.finance-expenses-panel #expense-list \.payment-row>strong\{[^}]*flex:0 0 auto;white-space:nowrap/,
  'expense amounts retain their full readable value on narrow screens');
assert.match(styles, /\.finance-expenses-panel #expense-list \.payment-row>span\{[^}]*min-width:0/,
  'expense descriptions can wrap without forcing the amount into a narrow column');

console.log('FINANCE CHART EMPTY STATE CONTRACT: PASS (zero activity is explicit; desktop KPI row matches its three-card content)');
