import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../portal.js', import.meta.url), 'utf8');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve));

function createApi() {
  const calls = [];
  const api = (url) => {
    const request = deferred();
    calls.push({ url, ...request });
    return request.promise;
  };
  return { api, calls };
}

function makeNode(value = '') {
  return {
    value,
    innerHTML: '',
    textContent: '',
    addEventListener() {},
  };
}

function extractedObligationLoader(api) {
  const start = source.indexOf('let businessObligationItems = [];');
  const end = source.indexOf('\n  const newObligationForm', start);
  assert.ok(start >= 0 && end > start, 'extract the real business-obligation loader');

  const obligationList = makeNode();
  const ruleList = makeNode();
  const from = makeNode('2026-09-01');
  const to = makeNode('2026-09-30');
  const obligationSection = { querySelector: (selector) => selector.includes('-from') ? from : to };
  const state = new Function(
    'api', 'obligationList', 'ruleList', 'obligationSection',
    'renderFinanceAccountList', 'drawPayroll', 'drawPayables', 'payablePaymentPending',
    'formatRuDate', 'money', 'esc', 'canDecideFinance',
    `${source.slice(start, end)}\nreturn { loadBusinessObligations, get items() { return businessObligationItems; } };`,
  )(
    api, obligationList, ruleList, obligationSection,
    () => {}, () => {}, () => {}, false,
    (value) => String(value), (value) => String(value), (value) => String(value), false,
  );
  return { ...state, obligationList, ruleList, from, to };
}

function obligationResult(count) {
  return {
    items: [],
    overdue: { items: [], totalCount: count, totalBalanceDue: count, asOfDate: '2026-09-30' },
  };
}

function resolveObligationBatch(calls, batch, count) {
  const group = calls.slice(batch * 3, batch * 3 + 3);
  assert.equal(group.length, 3, `obligation request batch ${batch} started`);
  for (const call of group) {
    if (call.url.startsWith('/api/finance/payables?')) call.resolve(obligationResult(count));
    else if (call.url === '/api/finance/recurring-rules') call.resolve({ items: [] });
    else if (call.url === '/api/finance/accounts?active=false') call.resolve({ items: [] });
    else assert.fail(`unexpected obligation request: ${call.url}`);
  }
}

async function testObligationSuccessRace() {
  const { api, calls } = createApi();
  const loader = extractedObligationLoader(api);
  const older = loader.loadBusinessObligations();
  loader.from.value = '2026-10-01';
  loader.to.value = '2026-10-31';
  const newer = loader.loadBusinessObligations();
  assert.match(calls[3].url, /from=2026-10-01/);
  resolveObligationBatch(calls, 1, 20);
  await newer;
  assert.match(loader.obligationList.innerHTML, /Просрочено на 2026-09-30: 20/);
  resolveObligationBatch(calls, 0, 10);
  await older;
  assert.match(loader.obligationList.innerHTML, /Просрочено на 2026-09-30: 20/, 'older success cannot replace the selected period');
}

async function testObligationStaleError() {
  const { api, calls } = createApi();
  const loader = extractedObligationLoader(api);
  const older = loader.loadBusinessObligations();
  loader.from.value = '2026-10-01';
  loader.to.value = '2026-10-31';
  const newer = loader.loadBusinessObligations();
  resolveObligationBatch(calls, 1, 20);
  await newer;
  calls[0].reject(new Error('stale request failure'));
  calls[1].resolve({ items: [] });
  calls[2].resolve({ items: [] });
  await older;
  assert.match(loader.obligationList.innerHTML, /Просрочено на 2026-09-30: 20/, 'older failure cannot replace the current result');
}

function extractedReadOnlyOtherIncomeLoader(api) {
  const start = source.lastIndexOf("const list=otherIncomeSection.querySelector('[data-other-income-list]');");
  assert.ok(start >= 0, 'extract the actual read-only other-income loader');
  const end = source.indexOf(";otherIncomeSection.querySelector('[data-other-income-reload]')", start);
  assert.ok(end > start, 'find the end of the read-only loader setup');

  const list = makeNode();
  const fields = {
    '[data-other-income-list]': list,
    '[data-other-income-from]': makeNode('2026-09-01'),
    '[data-other-income-to]': makeNode('2026-09-30'),
    '[data-other-income-status]': makeNode(''),
    '[data-other-income-search]': makeNode(''),
    '[data-other-income-reload]': makeNode(),
    '[data-other-income-filter]': makeNode(),
  };
  const otherIncomeSection = { querySelector: (selector) => fields[selector] };
  const load = new Function(
    'api', 'otherIncomeSection', 'esc', 'money',
    `if (false) {} else {\n${source.slice(start, end)}\nreturn load;\n}`,
  )(api, otherIncomeSection, (value) => String(value ?? ''), (value) => String(value ?? ''));
  return { load, list, fields };
}

function extractedWritableOtherIncomeLoader(api) {
  const start = source.indexOf('const loadOtherIncome=async()=>{');
  assert.ok(start >= 0, 'extract the actual writable other-income list renderer');
  const end = source.indexOf('\n    const resetOtherIncomeForm=', start);
  assert.ok(end > start, 'find the end of the writable other-income loader');

  const list = makeNode();
  const fields = {
    '[data-other-income-list]': list,
    '[data-other-income-from]': makeNode('2026-09-01'),
    '[data-other-income-to]': makeNode('2026-09-30'),
    '[data-other-income-status]': makeNode(''),
    '[data-other-income-search]': makeNode(''),
  };
  const otherIncomeSection = { querySelector: (selector) => fields[selector] };
  const load = new Function(
    'api', 'otherIncomeSection', 'list', 'getReceiptAttempt', 'getRefundAttempt',
    'canDecideFinance', 'otherIncomeAccountOptions', 'otherIncomeMethodOptions',
    'otherIncomeMethods', 'localDateKey', 'esc', 'money',
    `let request=0;\n${source.slice(start, end)}\nreturn loadOtherIncome;`,
  )(
    api, otherIncomeSection, list, () => null, () => null, false,
    () => '<option value="">Счёт</option>', () => '<option value="">Способ</option>',
    {}, () => '2026-09-30', (value) => String(value ?? ''), (value) => String(value ?? ''),
  );
  return { load, list, fields };
}

function incomeResult(title, { netRecognizedAmount = 10, totalAmount = 10 } = {}) {
  return {
    items: [{
      id: title,
      title,
      categoryName: 'Тестовая категория',
      recognitionDate: '2026-09-15',
      status: 'cancelled',
      netRecognizedAmount,
      totalAmount,
      receivedAmount: 0,
      refundedAmount: 0,
      balanceDue: 10,
      unreceivedRecognition: 10,
      cashReceivedBeyondNetRecognition: 0,
    }],
  };
}

async function testReadOnlyOtherIncomeSuccessRace() {
  const { api, calls } = createApi();
  const loader = extractedReadOnlyOtherIncomeLoader(api);
  loader.fields['[data-other-income-search]'].value = 'older';
  const older = loader.load();
  loader.fields['[data-other-income-search]'].value = 'newer';
  const newer = loader.load();
  assert.match(calls[1].url, /q=newer/);
  calls[1].resolve(incomeResult('Новый результат'));
  await newer;
  await flushMicrotasks();
  assert.match(loader.list.innerHTML, /Новый результат/);
  calls[0].resolve(incomeResult('Старый результат'));
  await older;
  await flushMicrotasks();
  assert.match(loader.list.innerHTML, /Новый результат/, 'older success cannot replace the current filters');
  assert.doesNotMatch(loader.list.innerHTML, /Старый результат/);
}

async function testReadOnlyOtherIncomeStaleError() {
  const { api, calls } = createApi();
  const loader = extractedReadOnlyOtherIncomeLoader(api);
  const older = loader.load();
  loader.fields['[data-other-income-search]'].value = 'newer';
  const newer = loader.load();
  calls[1].resolve(incomeResult('Новый результат'));
  await newer;
  await flushMicrotasks();
  calls[0].reject(new Error('stale request failure'));
  await older;
  await flushMicrotasks();
  assert.match(loader.list.innerHTML, /Новый результат/, 'older failure cannot replace the current result');
  assert.doesNotMatch(loader.list.innerHTML, /Не удалось загрузить прочие доходы/);
}

async function testReadOnlyOtherIncomeZeroNetRecognition() {
  const { api, calls } = createApi();
  const loader = extractedReadOnlyOtherIncomeLoader(api);
  const pending = loader.load();
  assert.equal(calls.length, 1, 'read-only other-income loader makes one request');
  calls[0].resolve(incomeResult('Исправленный доход', { netRecognizedAmount: 0, totalAmount: 100 }));
  await pending;
  await flushMicrotasks();
  assert.match(loader.list.innerHTML, /чистое признание 0/, 'zero net recognition remains visible');
  assert.doesNotMatch(loader.list.innerHTML, /чистое признание 100/, 'zero net recognition is not replaced by gross total');
}

async function testWritableOtherIncomeZeroNetRecognition() {
  const { api, calls } = createApi();
  const loader = extractedWritableOtherIncomeLoader(api);
  const pending = loader.load();
  assert.equal(calls.length, 1, 'writable list loader makes one request');
  calls[0].resolve(incomeResult('Исправленный доход', { netRecognizedAmount: 0, totalAmount: 100 }));
  await pending;
  assert.match(loader.list.innerHTML, /Чистое признание 0/, 'writable list preserves zero net recognition');
  assert.doesNotMatch(loader.list.innerHTML, /Чистое признание 100/, 'writable list does not substitute gross total');
}

const checks = [
  ['obligation stale success', testObligationSuccessRace],
  ['obligation stale error', testObligationStaleError],
  ['read-only other-income stale success', testReadOnlyOtherIncomeSuccessRace],
  ['read-only other-income stale error', testReadOnlyOtherIncomeStaleError],
  ['read-only other-income zero net recognition', testReadOnlyOtherIncomeZeroNetRecognition],
  ['writable other-income zero net recognition', testWritableOtherIncomeZeroNetRecognition],
];
const failures = [];
for (const [name, check] of checks) {
  try {
    await check();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push(error);
    console.error(`FAIL ${name}: ${error.message}`);
  }
}
assert.equal(failures.length, 0, 'all finance workspace stale-response checks pass');
console.log('FINANCE WORKSPACE RACE QA: PASS (stale responses ignored; zero net recognition preserved in both other-income lists)');
