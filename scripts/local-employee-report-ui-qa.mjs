import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Execute the actual portal branches and renderer. No browser, PostgreSQL or product writes.
const source = fs.readFileSync(new URL('../portal.js', import.meta.url), 'utf8');
const branch = (path) => {
  const start = source.indexOf(`  if (path === '${path}'`);
  const end = source.indexOf('  if (path ===', start + 1);
  assert.ok(start >= 0 && end > start, `${path}: actual employee demo branch exists`);
  return source.slice(start, end);
};
const renderStart = source.indexOf('function renderEmployeeFinanceReport(target)');
const renderEnd = source.indexOf('function renderFinanceReport()', renderStart);
assert.ok(renderStart >= 0 && renderEnd > renderStart, 'actual employee renderer exists');
const renderer = source.slice(renderStart, renderEnd);
const fixedInstant = '2026-10-01T22:30:00Z';
class FixedDate extends Date {
  constructor(...args) { super(...(args.length ? args : [fixedInstant])); }
  static now() { return new Date(fixedInstant).getTime(); }
}
const payment = (amount, createdAt, status = 'paid') => ({ amount, createdAt, status });
const own = (overrides) => ({ venueId: 'venue-a', openedById: 'roman', payments: [], ...overrides });
const orders = [
  own({ status: 'closed', closedAt: '2026-10-01T23:00:00Z', payments: [payment(40, '2026-10-01T18:59:59Z'), payment(60, '2026-10-01T22:00:00Z')] }),
  own({ status: 'open', payments: [payment(20, '2026-10-01T23:00:00Z', 'partially_paid')] }),
  own({ status: 'closed', closedAt: '2026-10-02T01:00:00Z' }),
  own({ status: 'closed', closedAt: '2026-10-01T18:59:59Z', payments: [payment(10, '2026-10-01T19:00:00Z'), payment(30, '2026-10-02T19:00:00Z')] }),
  own({ status: 'open', payments: [payment(777, '2026-10-01T23:00:00Z', 'failed'), payment(555, null)] }),
  own({ openedById: 'another-person', status: 'closed', closedAt: '2026-10-01T23:00:00Z', payments: [payment(999, '2026-10-01T23:00:00Z')] }),
  own({ venueId: 'venue-b', status: 'closed', closedAt: '2026-10-01T23:00:00Z', payments: [payment(888, '2026-10-01T23:00:00Z')] }),
];
let scenarios = 0;
const bootstrap = source.slice(0, source.indexOf('const compressUploadedImage ='));
assert.ok(bootstrap.includes('portal_permission_required'), 'actual portal bootstrap loaded');
for (const role of ['bartender', 'hookah_master', 'senior_bartender', 'senior_hookah_master', 'cleaner', 'security', 'technician', 'other_staff']) {
  const redirects = [];
  assert.doesNotThrow(() => vm.runInNewContext(bootstrap, {
    localStorage: { getItem: (key) => key === 'crm_session_token' ? 'synthetic-session' : JSON.stringify({ id: 'roman', role }) },
    URLSearchParams,
    window: { __portalSessionVerified: true, location: { replace: (url) => redirects.push(url), reload() {} } },
  }, { timeout: 1000 }), `${role}: existing operational session can reach its report/tasks UI`);
  assert.equal(redirects.length, 0); scenarios++;
}
for (const role of ['platform_owner', 'unknown_role']) {
  const redirects = [];
  assert.throws(() => vm.runInNewContext(bootstrap, {
    localStorage: { getItem: (key) => key === 'crm_session_token' ? 'synthetic-session' : JSON.stringify({ id: 'roman', role }) },
    URLSearchParams,
    window: { __portalSessionVerified: true, location: { replace: (url) => redirects.push(url), reload() {} } },
  }, { timeout: 1000 }), /portal_permission_required/);
  assert.deepEqual(redirects, ['/']); scenarios++;
}
async function runDemo(path, role, rows = orders) {
  return vm.runInNewContext(`(async () => { ${branch(path)} })()`, {
    path, method: 'GET', Date: FixedDate, Intl, URL, window: { location: { origin: 'http://localhost' } },
    url: `${path}?date=2000-01-01&type=waiter`,
    portalUser: { id: 'roman', name: 'Роман', role },
    demoSelectedVenue: () => ({ id: 'venue-a', timezone: 'Asia/Yekaterinburg' }),
    demoReadOrders: () => rows,
    // Deliberately UTC: business-day logic must not depend on the browser timezone.
    localDateKey: (value = new FixedDate()) => new FixedDate(value).toISOString().slice(0, 10),
  }, { timeout: 1000 });
}
for (const role of ['bartender', 'hookah_master', 'senior_bartender', 'senior_hookah_master', 'cleaner', 'security', 'technician', 'other_staff']) {
  const report = await runDemo('/api/finance/report', role);
  const summary = await runDemo('/api/finance/summary', role);
  assert.equal(report.employeeView, true, role);
  assert.equal(report.date, '2026-10-02', `${role}: use venue day, ignore arbitrary query date`);
  assert.equal(report.type, 'x', `${role}: employee cannot request waiter report`);
  assert.equal(report.revenue, 90, `${role}: own payments today, partial/open included, foreign venue/actor excluded`);
  assert.equal(report.checksCount, 2, `${role}: independent close date, including a zero-payment check`);
  assert.equal(report.revenue, summary.revenue, `${role}: report and summary agree`);
  assert.equal(report.date, summary.date, `${role}: report and summary agree on venue day`);
  for (const field of ['cash', 'card', 'qr', 'cashier', 'byPaymentMethod', 'byStaff', 'byStation']) assert.equal(field in report, false, `${role}: no private manager field ${field}`);
  scenarios++;
}
const emptyReport = await runDemo('/api/finance/report', 'hookah_master', []);
assert.equal(emptyReport.revenue, 0); assert.equal(emptyReport.checksCount, 0); scenarios++;

const nodes = new Map();
let currentReport = true;
const staleSelectors = [];
for (const id of ['date', 'refresh', 'message', 'revenue', 'checks', 'number']) {
  nodes.set(`#employee-report-${id}`, { textContent: '', disabled: false, get isConnected() { return currentReport; }, handlers: {}, addEventListener(type, handler) { this.handlers[type] = handler; } });
}
const target = { innerHTML: '', contains: (value) => currentReport && [...nodes.values()].includes(value), querySelector: (selector) => { assert.ok(nodes.has(selector), `known employee element ${selector}`); if (!currentReport) { staleSelectors.push(selector); return null; } return nodes.get(selector); } };
const requests = [];
const api = (url) => new Promise((resolve, reject) => { requests.push({ url, resolve, reject }); });
const helpers = source.split(/\r?\n/).filter((line) => line.startsWith('const formatRuDate =')).join('\n');
assert.ok(helpers.includes('const money='), 'actual date and money formatters are loaded');
vm.runInNewContext(`${helpers}\n${renderer}\nrenderEmployeeFinanceReport(target);`, { target, api, icon: () => '', Intl, Date, setTimeout }, { timeout: 1000 });
const flush = async () => { await new Promise((resolve) => setImmediate(resolve)); };
const node = (id) => nodes.get(`#employee-report-${id}`);
assert.equal(requests.length, 1); assert.equal(requests[0].url, '/api/finance/report');
assert.equal(node('refresh').disabled, true); assert.match(node('message').textContent, /Обновляем/);
assert.match(target.innerHTML, /aria-live="polite"/); assert.match(target.innerHTML, /по времени заведения/);
assert.doesNotMatch(target.innerHTML, /<input|<select|id="report-(cash|digital|payments|secondary|type|date)"/);
scenarios++;
await node('refresh').handlers.click();
assert.equal(requests.length, 1, 'pending guard prevents parallel loads'); scenarios++;
requests[0].resolve({ employeeView: true, date: '2026-10-02', revenue: 90, checksCount: 2, reportNumber: 'OWN-X', cash: 999999, byStaff: { PRIVATE: 99999 } });
await flush();
assert.equal(node('date').textContent, '02.10.2026'); assert.equal(node('revenue').textContent, '90 ₽');
assert.equal(node('checks').textContent, 2); assert.equal(node('number').textContent, 'OWN-X');
assert.equal(node('refresh').disabled, false); assert.equal(node('message').textContent, '');
assert.doesNotMatch(target.innerHTML, /PRIVATE|999999/); scenarios++;
const failedRefresh = node('refresh').handlers.click();
assert.equal(requests.length, 2); requests[1].reject(new Error('SQL_PRIVATE_SECRET')); await failedRefresh;
assert.equal(node('revenue').textContent, '—'); assert.equal(node('checks').textContent, '—'); assert.equal(node('number').textContent, '');
assert.equal(node('refresh').disabled, false); assert.match(node('message').textContent, /Повторите попытку/); assert.doesNotMatch(node('message').textContent, /SQL_PRIVATE_SECRET/); scenarios++;
const retry = node('refresh').handlers.click(); requests[2].resolve({ employeeView: true, date: '2026-10-02', revenue: 0 }); await retry;
assert.equal(node('revenue').textContent, '0 ₽'); assert.equal(node('checks').textContent, 0); assert.equal(node('message').textContent, ''); scenarios++;
const badDto = node('refresh').handlers.click(); requests[3].resolve({ revenue: 999999, cash: 999999, byStaff: { PRIVATE: 123 } }); await badDto;
assert.equal(node('revenue').textContent, '—'); assert.equal(node('checks').textContent, '—'); assert.match(node('message').textContent, /Не удалось/); scenarios++;
const navigated = node('refresh').handlers.click(); currentReport = false;
requests[4].resolve({ employeeView: true, date: '2026-10-02', revenue: 123, checksCount: 4 });
await assert.doesNotReject(navigated, 'response after navigation must not update the next page or throw from catch');
assert.equal(staleSelectors.every((selector) => selector === '#employee-report-refresh'), true, 'obsolete render may check its identity but cannot query replacement figures');
assert.equal(node('revenue').textContent, '—', 'stale response does not update detached figures'); scenarios++;
currentReport = true;
const navigatedError = node('refresh').handlers.click(); currentReport = false;
requests[5].reject(new Error('NAVIGATED_PRIVATE_FAILURE'));
await assert.doesNotReject(navigatedError, 'network failure after navigation must not throw from obsolete renderer');
assert.equal(staleSelectors.every((selector) => selector === '#employee-report-refresh'), true); scenarios++;
currentReport = true;
assert.equal(requests.every((request) => request.url === '/api/finance/report'), true, 'no adjustable employee date/type requests'); scenarios++;
const dispatchStart = source.indexOf('function renderFinanceReport()');
const dispatchEnd = source.indexOf('  target.innerHTML =', dispatchStart);
assert.ok(dispatchEnd > dispatchStart);
for (const role of ['bartender', 'hookah_master', 'senior_bartender', 'senior_hookah_master', 'cleaner', 'security', 'technician', 'other_staff']) {
  let delegated = false;
  vm.runInNewContext(`${source.slice(dispatchStart, dispatchEnd)}\n}\nrenderFinanceReport();`, {
    document: { querySelector: () => target }, portalUser: { role }, renderEmployeeFinanceReport: (value) => { assert.equal(value, target); delegated = true; },
  }, { timeout: 1000 });
  assert.equal(delegated, true, `${role}: actual report entry routes to restricted renderer`); scenarios++;
}
console.log(`PASS local employee report UI/demo: ${scenarios} scenarios (actual source, no browser/DB writes)`);
