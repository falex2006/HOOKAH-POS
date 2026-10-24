import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../payroll-scheme-ui.js', import.meta.url), 'utf8');
assert.equal(readFileSync(new URL('../dist/payroll-scheme-ui.js', import.meta.url), 'utf8'), source);
const start = source.indexOf('  const renderOrderRevenueReconciliation = payload => {');
const end = source.indexOf('  const renderRefundReview = payload => {', start);
assert.ok(start >= 0 && end > start);
const context = vm.createContext({
  money: (minor, currency) => `${minor}minor ${currency}`,
  escapeHtml: value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
  readinessReasonLabel: value => value
});
vm.runInContext(`${source.slice(start, end)};globalThis.render = renderOrderRevenueReconciliation;`, context);
const period = { from: '2026-10-01', to: '2026-10-31' };
const fields = ['closedOrderTotalMinor', 'recognizedLineNetMinor', 'minimumPriceAdjustmentMinor', 'unattributedResidualMinor'];
function payload(values) {
  const orders = values.map(([total, lines, adjustment = total - lines, residual = 0], index) => ({
    orderId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, status: 'available',
    closedAt: '2026-10-02', closedOrderTotalMinor: total, recognizedLineNetMinor: lines,
    minimumPriceAdjustmentMinor: adjustment, unattributedResidualMinor: residual
  }));
  return { period, sources: { orderRevenueReconciliation: {
    schemaVersion: 1, candidateOnly: true, officialReady: false, persistence: 'none', status: 'available',
    currency: 'RUB', period, orders, reasons: [], coverage: { complete: true },
    closedOrderCount: orders.length, recognizedOrderCount: orders.length, sourceWatermark: 'a'.repeat(64),
    totals: Object.fromEntries(fields.map(field => [field, orders.reduce((sum, row) => sum + row[field], 0)]))
  } } };
}
const summary = value => context.render(value).match(/<p data-payroll-reconciliation-difference>(.*?)<\/p>/)?.[1];
assert.match(summary(payload([[10000, 9000]])), /1000minor RUB · 10,00%/);
assert.match(summary(payload([[10000, 10000]])), /0minor RUB · 0,00%/);
assert.match(summary(payload([[20000, 19999]])), /1minor RUB · 0,01%/, 'half-up tie');
assert.match(summary(payload([[20001, 20000]])), /1minor RUB · 0,00%/, 'below half-up tie');
assert.match(summary(payload([[0, 0]])), /не рассчитывается/);
assert.match(summary(payload([])), /не рассчитывается/);
assert.match(summary(payload([[10000, 9000], [90000, 90000]])), /1000minor RUB · 1,00%/, 'weighted aggregate, not average percentages');
assert.match(summary(payload([[Number.MAX_SAFE_INTEGER, 0]])), /100,00%/, 'integer multiplication must remain exact');
const labels = context.render(payload([[10000, 9000]]));
assert.match(labels, /Сверка закрытых чеков до возвратов/);
assert.match(labels, /В том числе корректировка до минимальной суммы: 1000minor RUB/);
assert.match(labels, /нераспределённый остаток: 0minor RUB/);
assert.match(labels, /<th>Разница, ₽ и %<\/th>/);
assert.match(labels, /<td>1000minor RUB · 10,00%<\/td>/);
for (const status of ['incomplete', 'unsupported']) {
  const value = payload([[10000, 9000]]);
  const data = value.sources.orderRevenueReconciliation;
  data.status = status; data.coverage.complete = false; data.totals = null;
  const html = context.render(value);
  assert.match(html, /Итоги скрыты/);
  assert.doesNotMatch(html, /data-payroll-reconciliation-difference|minor RUB|10,00%/);
}
const offsetting = payload([[10000, 9000, 500], [10000, 9000, 1500]]);
assert.throws(() => context.render(offsetting), /Сумма чека не совпадает/, 'bad rows must not cancel in aggregate');
const badTotals = payload([[10000, 9000]]);
badTotals.sources.orderRevenueReconciliation.totals.closedOrderTotalMinor++;
assert.throws(() => context.render(badTotals), /Итоги сверки не совпадают/);
const missingCoverage = payload([[10000, 9000]]);
missingCoverage.sources.orderRevenueReconciliation.coverage.complete = false;
assert.throws(() => context.render(missingCoverage), /Подтверждённые итоги/);
console.log('PASS reconciliation renderer: actual renderer VM, integer rounding, zero denominator, weighted totals, per-row integrity, incomplete coverage; no browser/DB execution');
