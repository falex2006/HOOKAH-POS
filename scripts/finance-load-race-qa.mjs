import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../portal.js', import.meta.url), 'utf8');
const start = source.indexOf('  let financeReadState =');
const end = source.indexOf('\n  const syncFinanceDateLabel =', start);
assert.ok(start >= 0 && end > start);
const implementation = source.slice(start, end);
const nodes = new Map();
const node = (selector) => {
  if (!nodes.has(selector)) nodes.set(selector, { value: '2026-09-29', dataset: { paymentView: 'donut' }, textContent: '', innerHTML: '', classList: { toggle() {} }, setAttribute() {}, addEventListener(event, handler) { this.handler = handler; }, insertAdjacentHTML() {} });
  return nodes.get(selector);
};
const requests = [];
const api = (url) => new Promise((resolve, reject) => requests.push({ url, resolve, reject }));
const notices = [];
const portalShiftListeners = new Set();
const load = new Function('api', 'document', 'window', 'target', 'money', 'pluralRu', 'formatRuDate', 'esc', 'displayName', 'drawFinanceChart', 'portalNotice', 'portalShiftListeners', 'refreshPortalShiftState', 'canManagePortalShift', 'adminNavigationAllowed', `${implementation}\nreturn load;`)(
  api, { querySelector: node, querySelectorAll: () => [] }, {}, { querySelector: node, querySelectorAll: () => [] }, String, () => 'заказов', String, String, String, () => {}, (...args) => notices.push(args), portalShiftListeners, () => api('/api/shifts'), () => true, true,
);
const initial = load();
node('#finance-date').value = '2026-09-28';
const latest = load();
assert.ok(requests[3].url.endsWith('2026-09-28'));
const resolveGroup = (offset, revenue) => {
  requests[offset].resolve({ revenue, paymentMethods: {}, byPaymentMethod: {} });
  requests[offset + 1].resolve({});
  requests[offset + 2].resolve({ days: [], avgTablesPerDay: 0 });
};
resolveGroup(3, 28);
await latest;
assert.equal(node('#finance-revenue').textContent, '28');
resolveGroup(0, 29);
await initial;
assert.equal(node('#finance-revenue').textContent, '28', 'old success cannot overwrite current date');
const failedOld = load();
const goodNew = load();
resolveGroup(9, 100);
await goodNew;
requests[6].reject(new Error('old failure'));
await failedOld;
assert.equal(node('#finance-revenue').textContent, '100', 'old failure cannot overwrite current result');
assert.equal(notices.length, 0, 'stale errors cannot show a notice');
const failedCurrent = load();
requests[12].reject(new Error('current failure'));
await failedCurrent;
assert.equal(node('#finance-revenue').textContent, '—');
assert.equal(node('#finance-orders').textContent, '—', 'failed refresh clears stale order count');
assert.equal(notices.length, 1, 'current errors remain visible');
console.log('FINANCE LOAD RACE QA: PASS (stale success/error ignored, current error visible)');
