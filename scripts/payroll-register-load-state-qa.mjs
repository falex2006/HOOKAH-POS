import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../portal.js', import.meta.url), 'utf8');
const start = source.indexOf('let payrollItems = []');
const end = source.indexOf('const refreshPayrollViews', start);
assert.ok(start >= 0 && end > start, 'real payroll register implementation is available');
const implementation = source.slice(start, end);

function harness() {
  const requests = [];
  const fields = new Map();
  for (const name of ['user', 'rule', 'from', 'to']) {
    fields.set(`#payroll-filter-${name}`, {
      value: name === 'from' ? '2026-09-01' : name === 'to' ? '2026-09-30' : '',
      html: '',
      get innerHTML() { return this.html; },
      set innerHTML(value) { this.html = value; this.value = ''; },
    });
  }
  let html = '';
  let retry;
  const register = {
    get innerHTML() { return html; },
    set innerHTML(value) { html = value; retry = undefined; },
    querySelector(selector) {
      assert.equal(selector, '#payroll-retry');
      return html.includes('id="payroll-retry"')
        ? { addEventListener(event, handler) { assert.equal(event, 'click'); retry = handler; } }
        : null;
    },
    insertAdjacentHTML(position, value) { assert.equal(position, 'afterbegin'); html = value + html; },
    querySelectorAll() { return []; },
  };
  const api = (url) => new Promise((resolve, reject) => requests.push({ url, resolve, reject }));
  const window = { __portalSessionVerified: { user: { id: 'qa-owner', role: 'owner', venueId: 'qa-venue' } }, __portalSessionGate: { blocked: false } };
  const localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  const createPayrollLinkedController = () => ({ pending: () => null, listPending: () => [] });
  const financeAccountItems = [];
  const { load, draw } = new Function(
    'payrollSection', 'register', 'registerMessage', 'api', 'staticDemo',
    'esc', 'displayName', 'formatRuDate', 'money', 'entryStatuses', 'todayDate', 'window', 'localStorage', 'createPayrollLinkedController', 'financeAccountItems',
    `let loadPayroll; ${implementation}\nreturn { load: loadPayroll, draw: drawPayroll };`,
  )(
    { querySelector(selector) { assert.ok(fields.has(selector), selector); return fields.get(selector); } },
    register, { textContent: '' }, api, () => false,
    String, String, String, String, { draft: ['Черновик', 'warning'] }, '2026-09-29', window, localStorage, createPayrollLinkedController, financeAccountItems,
  );
  return {
    requests, register, load, draw,
    field(name) { return fields.get(`#payroll-filter-${name}`); },
    retry() { assert.equal(typeof retry, 'function', 'retry button has a real click handler'); return retry(); },
  };
}

const row = (label) => ({
  id: label, userId: `user-${label}`, userName: label,
  ruleId: `rule-${label}`, ruleName: `Hourly ${label}`,
  periodFrom: '2026-09-01', periodTo: '2026-09-30', hours: 8, amount: 4000, status: 'draft',
});

async function populate(h, label = 'Initial employee') {
  const pending = h.load();
  h.requests.at(-1).resolve({ items: [row(label)] });
  await pending;
  assert.ok(h.register.innerHTML.includes(label));
}

function changeFiltersPreserving(h, expected) {
  h.field('user').value = 'some-user';
  h.draw();
  assert.equal(h.register.innerHTML, expected, 'employee filter preserves non-ready state');
  h.field('rule').value = 'some-rule';
  h.draw();
  assert.equal(h.register.innerHTML, expected, 'rule filter preserves non-ready state');
  h.field('user').value = '';
  h.field('rule').value = '';
}

for (const [from, to] of [['2026-10-01', '2026-09-30'], ['', '2026-09-30'], ['2026-09-01', '']]) {
  const h = harness();
  await populate(h);
  h.field('from').value = from;
  h.field('to').value = to;
  await h.load();
  assert.equal(h.requests.length, 1, 'invalid range does not call API');
  assert.match(h.register.innerHTML, /Укажите корректный диапазон дат/);
  changeFiltersPreserving(h, h.register.innerHTML);
}

{
  const h = harness();
  await populate(h);
  const pending = h.load();
  assert.match(h.register.innerHTML, /Загрузка зарплатного реестра/);
  changeFiltersPreserving(h, h.register.innerHTML);
  h.requests.at(-1).reject(new Error('network unavailable'));
  await pending;
  assert.match(h.register.innerHTML, /Повторить загрузку/);
  changeFiltersPreserving(h, h.register.innerHTML);
  const retry = h.retry();
  assert.equal(h.requests.length, 3, 'retry issues a new request');
  h.requests.at(-1).resolve({ items: [row('Recovered employee')] });
  await retry;
  assert.match(h.register.innerHTML, /Recovered employee/);
  assert.doesNotMatch(h.register.innerHTML, /Повторить загрузку/);
}

for (const staleOutcome of ['success', 'failure']) {
  const h = harness();
  const older = h.load();
  h.field('from').value = '2026-10-01';
  h.field('to').value = '2026-10-31';
  const latest = h.load();
  assert.match(h.requests[1].url, /from=2026-10-01&to=2026-10-31/);
  h.requests[1].resolve({ items: [row('Latest employee')] });
  await latest;
  const expected = h.register.innerHTML;
  const expectedOptions = h.field('user').innerHTML;
  if (staleOutcome === 'success') h.requests[0].resolve({ items: [row('Stale employee')] });
  else h.requests[0].reject(new Error('stale network failure'));
  await older;
  assert.equal(h.register.innerHTML, expected, `stale ${staleOutcome} cannot replace latest rows`);
  assert.equal(h.field('user').innerHTML, expectedOptions, 'stale request cannot replace filter options');
  h.draw();
  assert.equal(h.register.innerHTML, expected, 'latest loaded state remains usable');
}

{
  const h = harness();
  const older = h.load();
  const latest = h.load();
  const loading = h.register.innerHTML;
  h.requests[0].resolve({ items: [row('Stale employee')] });
  await older;
  assert.equal(h.register.innerHTML, loading, 'stale success cannot end current loading state');
  changeFiltersPreserving(h, loading);
  h.requests[1].resolve({ items: [] });
  await latest;
  assert.match(h.register.innerHTML, /За выбранный период начислений нет/);
}

for (const staleOutcome of ['success', 'failure']) {
  const h = harness();
  const pending = h.load();
  h.field('to').value = '';
  await h.load();
  const invalid = h.register.innerHTML;
  assert.match(invalid, /Укажите корректный диапазон дат/);
  if (staleOutcome === 'success') h.requests[0].resolve({ items: [row('Stale employee')] });
  else h.requests[0].reject(new Error('stale network failure'));
  await pending;
  assert.equal(h.register.innerHTML, invalid, `pending ${staleOutcome} cannot replace invalid range`);
  changeFiltersPreserving(h, invalid);
}

console.log('PAYROLL REGISTER LOAD STATE QA: PASS (invalid/loading/error filters, retry, stale success/failure, pending to invalid)');
