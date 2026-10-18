import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';

// Current source closures in a small deterministic DOM. This is not browser/API/PG QA.
const root = new URL('../', import.meta.url);
const source = fs.readFileSync(new URL('portal.js', root), 'utf8');
const css = fs.readFileSync(new URL('style.css', root), 'utf8');
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
const span = (start, end) => {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, `source boundaries: ${start}`);
  return source.slice(a, b);
};
const checks = [];
const check = async (name, fn) => {
  try { await fn(); checks.push({ name, status: 'PASS' }); }
  catch (error) { checks.push({ name, status: 'FAIL', error: error.stack }); }
};
const tick = () => new Promise(resolve => setImmediate(resolve));
const stockDraw = span("const draw = (query = '') => { const rows = document.querySelector('#inventory-rows');", '\n    document.addEventListener');
const stockLoad = span('const inventoryLoadErrorMarkup = () =>', 'const updateMovementUnit =');
const autoDraw = span('  const drawAutoOrders = () => {', '  const loadAutoOrders = async () => {');
const autoLoad = span('  const loadAutoOrders = async () => {', "  document.querySelector('#auto-order-search')?.addEventListener");
const premixLoad = span('const loadPremixData = () => {', '; loadPremixData();');

const stockFixture = (writer = false) => {
  const rows = { innerHTML: '', isConnected: true };
  const nodes = {
    '#inventory-rows': rows,
    '#stock-visible-count': { textContent: '' },
    '#inventory-department-filter': { value: '', innerHTML: '' },
    '#inventory-search': { value: '' },
    '#inventory-count': { textContent: '' },
    '#inventory-low': { textContent: '' },
    '#inventory-last': { textContent: '' },
    '#movement-journal-count': { textContent: '' },
    '#movement-history-list': { innerHTML: '' },
    '#movement-item': { value: '', innerHTML: '', options: [], _customSelectRefresh() {} },
    '#movement-unit': { value: '', _customSelectRefresh() {} },
    '#movement-unit-hint': { textContent: '' },
    '#inventory-movement-dialog': { open: false },
  };
  const document = { querySelector: selector => nodes[selector] || null };
  const requests = [], notices = [];
  const context = vm.createContext({
    allItems: [], inventoryLoadState: 'loaded', inventoryLoadGeneration: 0, payload: null,
    canWriteInventory: writer, document, target: { querySelector: selector => nodes[selector] || null },
    normalizeInventorySearch: value => String(value || '').toLocaleLowerCase('ru-RU'), esc: String,
    displayName: value => String(value ?? ''), money: value => `${Number(value || 0)} ₽`,
    alcoholProfileById: () => null, alcoholItemLabel: () => '',
    api: path => new Promise((resolve, reject) => requests.push({ path, resolve, reject })),
    refreshInventoryContext() {}, invalidateRecipeCostCache() {}, renderPurchaseLines() {}, getPurchaseLines: () => [], updatePurchasePreviews() {},
    updateMovementUnit() {}, formatRuDate: String, portalNotice: (...args) => notices.push(args),
  });
  const functions = vm.runInContext(`(()=>{${stockLoad}\n${stockDraw}; return {draw,load};})()`, context);
  context.nodes = nodes;
  return { context, nodes, rows, requests, notices, draw: functions.draw, load: functions.load };
};

class FakeControl {
  constructor(dataset, value = '') { this.dataset = dataset; this.value = value; this.checked = true; this.listeners = []; }
  addEventListener(type, fn) { this.listeners.push([type, fn]); }
}
const autoFixture = (writer = true) => {
  let controls = [], quantities = new Map(), rows = [];
  const body = {
    querySelector(selector) { return selector === 'tr:not([hidden])' ? (rows.some(row => !row.hidden) ? rows.find(row => !row.hidden) : null) : null; },
    append(row) { rows.push(row); },
    get rows() { return rows; },
  };
  const list = {
    set innerHTML(markup) {
      this._markup = markup;
      controls = []; quantities = new Map(); rows = [];
      const tableBody = markup.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1] || '';
      for (const match of tableBody.matchAll(/<tr([^>]*)>([\s\S]*?)<\/tr>/g)) rows.push({ hidden: /\shidden\b/.test(match[1]), html: match[0], className: '' });
      for (const match of markup.matchAll(/<input type="checkbox" data-auto-order-item="([^"]+)"[^>]*>/g)) controls.push(new FakeControl({ autoOrderItem: match[1] }));
      for (const match of markup.matchAll(/<input class="auto-order-quantity"[^>]*value="([^"]*)"[^>]*data-auto-order-quantity="([^"]+)"[^>]*>/g)) quantities.set(match[2], new FakeControl({ autoOrderQuantity: match[2] }, match[1]));
    },
    get innerHTML() { return this._markup || ''; },
    querySelectorAll(selector) { return selector === '[data-auto-order-item]' ? controls : []; },
    querySelector(selector) { const m = selector.match(/^\[data-auto-order-quantity="(.+)"\]$/); return m ? quantities.get(m[1]) || null : selector === 'tbody' ? body : null; },
    addEventListener() {},
  };
  // CSS.escape is used to find a quantity field by item id.
  const search = { value: '' }, count = { textContent: '', className: '' }, create = { disabled: false };
  const history = { innerHTML: '', querySelectorAll: () => [] };
  const document = { querySelector(selector) { return ({ '#auto-order-list': list, '#auto-order-low-count': count, '#auto-order-history-list': history, '#auto-order-search': search, '#create-auto-order': create })[selector] || null; }, createElement: () => ({ className: '', innerHTML: '' }) };
  const apiRequests = [];
  const context = vm.createContext({ document, canWriteInventory: writer, autoOrderState: { items: [], requests: [], error: null, hasLoaded: false }, autoOrderCreatePending: false, autoOrderCancelPending: new Set(), autoOrderStatus: {}, normalizeInventorySearch: value => String(value || '').toLocaleLowerCase('ru-RU'), CSS: { escape: String }, pluralRu: n => `${n} позиции`, esc: String, displayName: String, money: String, formatRuDate: String, window: { confirm: () => false }, api: path => new Promise((resolve, reject) => apiRequests.push({ path, resolve, reject })), portalNotice: () => {}, refreshInventoryContext: () => {}, openAutoOrderReceipt: () => {} });
  const functions = vm.runInContext(`(()=>{let autoOrderLoadGeneration=0;${autoDraw}\n${autoLoad}\nreturn {drawAutoOrders,loadAutoOrders};})()`, context);
  return { context, list, body, search, count, create, history, controls: () => controls, quantities: () => quantities, requests: apiRequests, draw: functions.drawAutoOrders, load: functions.loadAutoOrders };
};

const premixFixture = (writer = true) => {
  const node = (props = {}) => Object.assign({ innerHTML: '', hidden: false, isConnected: true, dataset: {}, classList: { add() {}, remove() {} }, setAttribute() {}, removeAttribute() {}, querySelector: () => null, querySelectorAll: () => [], append() {} }, props);
  const recipe = node({ value: '', options: [], set innerHTML(value) { this._html = value; this.options = [...value.matchAll(/<option value="([^"]*)"/g)].map(m => ({ value: m[1] })); }, get innerHTML() { return this._html || ''; } });
  const output = node({ value: '', options: [], set innerHTML(value) { this._html = value; this.options = [...value.matchAll(/<option value="([^"]*)"/g)].map(m => ({ value: m[1] })); }, get innerHTML() { return this._html || ''; } });
  const form = node({ querySelectorAll: () => [] }); const production = node(); const guidance = node(); const list = node();
  const nodes = { '#premix-recipe': writer ? recipe : null, '#premix-output': writer ? output : null, '#premix-form': writer ? form : null, '#premix-production': writer ? production : null, '#premix-empty-guidance': writer ? guidance : null, '#premix-batches': list };
  const target = { querySelector: selector => nodes[selector] || null };
  const document = { querySelector: selector => nodes[selector] || null };
  const context = vm.createContext({ document, target, canWriteInventory: writer, api: () => Promise.resolve({ items: [] }), esc: String, displayName: String, money: String, refreshInventoryContext() {} });
  const load = vm.runInContext(`(()=>{${premixLoad}; return loadPremixData;})()`, context);
  return { context, nodes, load };
};

await check('stock renderer preserves source ordering and exposes critical state; search filters without changing source order', () => {
  const f = stockFixture(true);
  f.context.allItems = [
    { id: 'normal', name: 'Сироп', category: 'Бар', department: 'bar', unit: 'л', onHand: 8, minLevel: 2 },
    { id: 'critical', name: 'Критичный табак', category: 'Табак', department: 'hookah', unit: 'г', onHand: 2, minLevel: 2 },
    { id: 'unset', name: 'Вода', category: 'Бар', department: 'bar', unit: 'л', onHand: 0, minLevel: 0 },
  ];
  f.draw();
  assert.ok(f.nodes['#inventory-rows'].innerHTML.indexOf('data-item="normal"') < f.nodes['#inventory-rows'].innerHTML.indexOf('data-item="critical"'), 'critical rows do not get silently resorted');
  assert.match(f.nodes['#inventory-rows'].innerHTML, /Критичный табак[\s\S]*?Нужно пополнить/);
  assert.match(f.nodes['#inventory-rows'].innerHTML, /Порог не задан/);
  f.draw('Критичный');
  assert.match(f.nodes['#inventory-rows'].innerHTML, /Критичный табак/);
  assert.doesNotMatch(f.nodes['#inventory-rows'].innerHTML, /Сироп/);
  assert.equal(f.nodes['#stock-visible-count'].textContent, '1 / 3');
});

await check('stock search cannot replace initial loading or read-error states; search survives successful retry', async () => {
  const f = stockFixture(true), nodes = f.nodes;
  nodes['#inventory-search'].value = 'UI062';
  f.context.inventoryLoadState = 'loading';
  f.draw(nodes['#inventory-search'].value);
  assert.match(f.rows.innerHTML, /Загрузка складских позиций/);
  assert.doesNotMatch(f.rows.innerHTML, /По выбранным условиям позиций нет/);
  assert.equal(nodes['#stock-visible-count'].textContent, '—');

  f.context.inventoryLoadState = 'error';
  f.draw(nodes['#inventory-search'].value);
  assert.match(f.rows.innerHTML, /Не удалось загрузить склад/);
  assert.match(f.rows.innerHTML, /data-inventory-retry/);
  assert.doesNotMatch(f.rows.innerHTML, /По выбранным условиям позиций нет/);
  assert.equal(nodes['#stock-visible-count'].textContent, '—');

  const retry = f.load();
  assert.match(f.rows.innerHTML, /Загрузка складских позиций/);
  f.requests[0].resolve({ items: [{ id: 'critical', name: 'UI062 critical stock', category: 'Bar', department: 'bar', unit: 'ml', onHand: 0, minLevel: 10 }], lowStock: [], movements: [] });
  await retry;
  assert.equal(f.context.inventoryLoadState, 'loaded');
  assert.equal(nodes['#inventory-search'].value, 'UI062');
  assert.match(f.rows.innerHTML, /UI062 critical stock/);
  assert.doesNotMatch(f.rows.innerHTML, /Загрузка складских позиций|По выбранным условиям позиций нет/);
  assert.equal(nodes['#stock-visible-count'].textContent, '1 / 1');
});

await check('auto-order starts with a loading state, not an empty healthy state', async () => {
  const f = autoFixture(); const requests = f.requests;
  const pending = f.load();
  assert.equal(requests[0].path, '/api/inventory/auto-orders');
  assert.match(f.list.innerHTML, /Загрузка рекомендаций/);
  assert.doesNotMatch(f.list.innerHTML, /Пополнение пока не требуется/);
  requests[0].resolve({ items: [], requests: [] }); await pending;
  assert.match(f.list.innerHTML, /Пополнение пока не требуется/);
});

await check('stock loader ignores stale failure and displays retry for the current failure', async () => {
  const f = stockFixture(true), requests = f.requests;
  const old = f.load(), current = f.load();
  assert.match(f.rows.innerHTML, /Загрузка складских позиций/);
  requests[0].reject(new Error('older offline')); await old;
  assert.doesNotMatch(f.rows.innerHTML, /Не удалось загрузить склад/);
  assert.equal(f.notices.length, 0, 'stale failure has no user-visible effects');
  requests[1].reject(new Error('current offline')); await current;
  assert.match(f.rows.innerHTML, /Не удалось загрузить склад/);
  assert.match(f.rows.innerHTML, /data-inventory-retry/);
  assert.equal(f.notices.length, 1, 'current error is reported');
});

await check('auto-order search hides non-matches and rerender preserves checkbox, quantity and search', () => {
  const f = autoFixture();
  f.context.autoOrderState = { error: null, hasLoaded: true, requests: [], items: [
    { id: 'a', name: 'Сироп', department: 'Бар', category: 'Сиропы', supplier: 'Поставщик А', onHand: 0, minLevel: 2, orderQuantity: 10, targetLevel: 10, packMultiplier: 1, estimate: 120 },
    { id: 'b', name: 'Табак', department: 'Кальянная', category: 'Табак', supplier: 'Поставщик Б', onHand: 1, minLevel: 5, orderQuantity: 4, targetLevel: 5, packMultiplier: 1, estimate: 80 },
  ] };
  f.draw();
  const sirup = f.controls().find(control => control.dataset.autoOrderItem === 'a');
  sirup.checked = false;
  f.quantities().get('a').value = '17';
  f.search.value = 'Поставщик А'; f.draw();
  assert.equal(f.body.rows.length, 2, 'matching row and hidden non-match remain in table DOM');
  assert.equal(f.body.rows[0].hidden, false); assert.equal(f.body.rows[1].hidden, true);
  assert.equal(f.controls().find(control => control.dataset.autoOrderItem === 'a').checked, false);
  assert.equal(f.quantities().get('a').value, '17');
  assert.equal(f.search.value, 'Поставщик А');
  f.search.value = 'not found'; f.draw();
  assert.ok(f.body.rows.some(row => row.className === 'auto-order-search-empty'));
  assert.equal(f.controls().find(control => control.dataset.autoOrderItem === 'a').checked, false);
  assert.equal(f.quantities().get('a').value, '17');
});

await check('auto-order response generation ignores older success and error', async () => {
  for (const staleReject of [false, true]) {
    const f = autoFixture(), requests = f.requests;
    const old = f.load(), fresh = f.load();
    requests[1].resolve({ items: [{ id: 'fresh', name: 'Fresh', onHand: 0, minLevel: 1, orderQuantity: 1 }], requests: [] }); await fresh;
    const markup = f.list.innerHTML;
    staleReject ? requests[0].reject(new Error('stale')) : requests[0].resolve({ items: [{ id: 'stale', name: 'Stale' }], requests: [] });
    await old;
    assert.equal(f.list.innerHTML, markup, 'old response cannot overwrite current rows');
  }
});

await check('premix retry/read-only prerequisites and stale generation/node identity guards', async () => {
  const f = premixFixture(true), requests = [];
  f.context.api = path => new Promise((resolve, reject) => requests.push({ path, resolve, reject }));
  const first = f.load(); assert.deepEqual(requests.map(r => r.path), ['/api/recipes', '/api/inventory', '/api/inventory/premixes']);
  requests.slice(0, 3).forEach(request => request.reject(new Error('offline'))); await first;
  assert.equal(f.nodes['#premix-form'].hidden, true);
  assert.match(f.nodes['#premix-empty-guidance'].innerHTML, /Не удалось загрузить данные премиксов/);
  const retry = f.load(); requests.slice(3, 6).forEach((request, index) => request.resolve({ items: index === 0 ? [{ id: 'recipe', name: 'Сироп', recipeType: 'premix' }] : index === 1 ? [{ id: 'stock', name: 'Заготовка', unit: 'л' }] : [] })); await retry;
  assert.equal(f.nodes['#premix-form'].dataset.canProduce, 'true'); assert.equal(f.nodes['#premix-form'].hidden, false);

  const old = f.load(), newer = f.load();
  requests.slice(9, 12).forEach((request, index) => request.resolve({ items: index === 2 ? [{ id: 'new-batch', recipeName: 'Newest' }] : [] })); await newer;
  const currentMarkup = f.nodes['#premix-batches'].innerHTML;
  requests.slice(6, 9).forEach(request => request.reject(new Error('stale'))); await old;
  assert.equal(f.nodes['#premix-batches'].innerHTML, currentMarkup, 'older failure cannot replace newer success');

  const replaced = f.load(); const staleNode = f.nodes['#premix-batches'];
  f.nodes['#premix-batches'] = { ...staleNode, innerHTML: 'replacement', isConnected: true };
  requests.slice(12, 15).forEach((request, index) => request.resolve({ items: index === 2 ? [{ id: 'wrong', recipeName: 'Wrong node' }] : [] })); await replaced;
  assert.equal(f.nodes['#premix-batches'].innerHTML, 'replacement', 'response for detached list cannot render into replacement list');

  const readonlyError = premixFixture(false), readonlyErrorRequests = [];
  readonlyError.context.api = path => new Promise((resolve, reject) => readonlyErrorRequests.push({ path, resolve, reject }));
  const readonlyFailure = readonlyError.load();
  assert.deepEqual(readonlyErrorRequests.map(request => request.path), ['/api/inventory/premixes'], 'readonly history does not fetch write-only prerequisites');
  readonlyErrorRequests[0].reject(new Error('readonly offline')); await readonlyFailure;
  assert.match(readonlyError.nodes['#premix-batches'].innerHTML, /История партий временно недоступна/);
  assert.match(readonlyError.nodes['#premix-batches'].innerHTML, /data-premix-retry/);

  const readonly = premixFixture(false), readonlyRequests = [];
  readonly.context.api = path => { readonlyRequests.push(path); return Promise.resolve({ items: [{ recipeName: 'Readonly batch', outputQuantity: 1 }] }); };
  await readonly.load();
  assert.deepEqual(readonlyRequests, ['/api/inventory/premixes']);
  assert.match(readonly.nodes['#premix-batches'].innerHTML, /Readonly batch/);
});

await check('premix controls remain gated until prerequisites load; CSS theme and dist mirrors stay scoped', () => {
  const portalDist = fs.readFileSync(new URL('dist/portal.js', root));
  const cssDist = fs.readFileSync(new URL('dist/style.css', root));
  assert.deepEqual(fs.readFileSync(new URL('portal.js', root)), portalDist, 'portal source/dist mirror');
  assert.deepEqual(fs.readFileSync(new URL('style.css', root)), cssDist, 'style source/dist mirror');
  assert.match(source, /#premix-form[\s\S]{0,800}disabled/);
  const scopedStart = css.indexOf('/* UI-06.2 inventory views consume the shared operational primitives. */');
  assert.ok(scopedStart >= 0, 'scoped UI-06.2 CSS section is present');
  const scoped = css.slice(scopedStart);
  assert.match(scoped, /\.panel\.ui-inventory-operations/);
  assert.match(scoped, /\.inventory-auto-orders-mode \.inventory-operations-toolbar/);
  assert.match(css, /\.inventory-stock-mode \.inventory-stock-panel thead th\{position:sticky/);
  assert.match(scoped, /\.panel\.ui-inventory-operations \.ui-table-region/);
  assert.match(scoped, /\.inventory-premixes-mode #premix-empty-guidance/);
  assert.doesNotMatch(scoped, /!important|@keyframes|filter:\s*blur/i);
});

const result = { generatedAt: new Date().toISOString(), scope: 'Actual-source VM/DOM mechanics only; no browser/API/PostgreSQL evidence', hashes: { portal: hash(source), css: hash(css), stockDraw: hash(stockDraw), autoDraw: hash(autoDraw), autoLoad: hash(autoLoad), premixLoad: hash(premixLoad) }, checks, passed: checks.filter(item => item.status === 'PASS').length, failed: checks.filter(item => item.status === 'FAIL').length };
fs.mkdirSync(new URL('../tmp/ui062/', import.meta.url), { recursive: true });
fs.writeFileSync(new URL('../tmp/ui062/qa-source-results.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');
fs.writeFileSync(new URL('../tmp/ui062/qa-source-results.md', import.meta.url), `# UI-06.2 source-runtime QA\n\nGenerated: ${result.generatedAt}\n\nScope: ${result.scope}.\n\n${checks.map(item => `- ${item.status}: ${item.name}${item.error ? `\n\n  \`${item.error.replaceAll('\n', '\n  ')}\`` : ''}`).join('\n')}\n\n${result.passed} passed, ${result.failed} failed.\n`);
for (const item of checks) console.log(`${item.status} ${item.name}${item.error ? `\n${item.error}` : ''}`);
console.log(`${result.passed} passed, ${result.failed} failed`);
if (result.failed) process.exitCode = 1;
