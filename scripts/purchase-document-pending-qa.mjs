import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const portal = readFileSync(new URL('../portal.js', import.meta.url), 'utf8');
const capture = portal.slice(portal.indexOf("document.addEventListener('submit'"), portal.indexOf('\n', portal.indexOf("document.addEventListener('submit'")));
assert.match(capture, /'purchase-document-form'/, 'purchase form must own pending state');
const renderStart = portal.indexOf('  const renderPurchaseLines = (lines =');
const renderEnd = portal.indexOf('\n  const getPurchaseLines', renderStart);
assert.ok(renderStart > 0 && renderEnd > renderStart, 'purchase line renderer found');
const renderContext = {
  purchaseLines: { innerHTML: '' },
  allItems: [{ id: 'active-stock', name: 'Активный ингредиент', unit: 'мл', purchaseUnit: 'бутылка', packMultiplier: 1000 }],
  purchaseUnitChoices: ['шт', 'г', 'кг', 'мл', 'л', 'порция', 'уп', 'упаковка'],
  purchaseFactor: () => 1000,
  money: (value) => String(value),
  displayName: (value) => value,
  esc: (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;'),
};
vm.runInNewContext(`${portal.slice(renderStart, renderEnd)}\nglobalThis.renderPurchaseLines = renderPurchaseLines;`, renderContext);
renderContext.renderPurchaseLines([{ ingredientId: 'archived-stock', ingredientName: 'Сироп <архив>', quantity: 1, unit: 'бутылка', unitCost: 250 }]);
assert.match(renderContext.purchaseLines.innerHTML, /value="archived-stock" selected>Архивная позиция: Сироп &lt;архив&gt;/,
  'archived line snapshot stays selected and safely rendered in the editor');
assert.match(renderContext.purchaseLines.innerHTML, /value="active-stock".*Активный ингредиент/,
  'editor offers an active replacement alongside the archived snapshot');
assert.match(renderContext.purchaseLines.innerHTML, /Позиция архивирована[\s\S]*в приходе по автозаказу/,
  'editor explains the linked auto-order replacement boundary');
const start = portal.indexOf("  purchaseForm?.addEventListener('submit', async (event) => {");
const end = portal.indexOf("  if (purchaseForm) document.querySelector('#purchase-date').value = '';", start);
assert.ok(start > 0 && end > start, 'purchase handlers found');
const block = portal.slice(start, end);

const handlers = { list: [] };
const message = { textContent: '', className: '' };
const fields = new Map([
  ['#purchase-message', message], ['#purchase-supplier', { value: 'QA поставщик', focus: () => {} }],
  ['#purchase-number', { value: 'QA-1' }], ['#purchase-date', { value: '' }],
  ['#purchase-note', { value: '' }], ['#purchase-save', { textContent: 'Сохранить черновик' }],
  ['#purchase-cancel', { hidden: true, addEventListener: (_name, handler) => { handlers.cancel = handler; } }],
  ['#purchase-order-context', { hidden: true }],
  ['#purchase-document-list', { addEventListener: (_name, handler) => { handlers.list.push(handler); } }],
]);
const form = { dataset: {}, addEventListener: (_name, handler) => { handlers.submit = handler; }, scrollIntoView: () => {} };
const requests = [];
const notices = [];
let resetCount = 0;
let loadResult = true;
const context = {
  purchaseForm: form, purchaseActionPending: false,
  setPurchasePending: (pending) => { context.purchaseActionPending = pending; },
  getPurchaseLines: () => [{ ingredientId: 'stock-1', quantity: 1, unit: 'шт', unitCost: 10 }],
  document: { querySelector: (selector) => fields.get(selector) },
  resetPurchaseForm: () => { resetCount += 1; },
  loadPurchaseDocuments: async () => loadResult,
  loadAutoOrders: async () => true,
  load: async () => true,
  purchaseDocuments: [{ id: 'draft-1', status: 'draft', supplierName: 'QA поставщик', totalCost: 10, sourceAutoOrderId: 'order-1', lines: [{ ingredientId: 'stock-1', quantity: 1, unit: 'шт', unitCost: 10 }] }],
  api: (url, options) => new Promise((resolve, reject) => requests.push({ url, options, resolve, reject })),
  portalNotice: (text, kind) => notices.push({ text, kind }),
  window: { confirm: () => true }, money: (value) => String(value),
  renderPurchaseLines: () => {}, updatePurchasePreviews: () => {},
};
vm.runInNewContext(block, context);
const tick = () => new Promise((resolve) => setImmediate(resolve));
const submit = () => handlers.submit({ preventDefault() {} });
const click = (attribute) => ({ target: { closest: (selector) => selector === `[${attribute}]` ? { dataset: { purchasePost: 'draft-1', purchaseVoid: 'draft-1' } } : null } });
const post = () => handlers.list[1](click('data-purchase-post'));
const voidDraft = () => handlers.list[3](click('data-purchase-void'));

fields.get('#purchase-supplier').value = '';
submit();
assert.equal(requests.length, 0);
assert.match(message.textContent, /Укажите поставщика/);
fields.get('#purchase-supplier').value = 'QA поставщик';
submit();
assert.equal(context.purchaseActionPending, true);
assert.equal(requests.length, 1);
assert.equal(requests[0].options.method, 'POST');
submit(); handlers.cancel(); await post(); await voidDraft();
assert.equal(requests.length, 1, 'save blocks duplicate, post, and void');
assert.equal(resetCount, 0, 'cancel cannot replace pending editor');
requests[0].reject({ payload: { error: 'invalid_purchase_unit' } });
await tick();
assert.equal(context.purchaseActionPending, false);
assert.match(message.textContent, /единицу закупки/);
submit();
assert.equal(requests.length, 2, 'failed save retries immediately');
let resolveLoad;
loadResult = new Promise((resolve) => { resolveLoad = resolve; });
requests[1].resolve({ id: 'draft-1' });
await tick();
assert.equal(resetCount, 0, 'new line controls must not appear during slow refresh');
assert.equal(context.purchaseActionPending, true);
resolveLoad(false);
await tick();
assert.equal(resetCount, 1);
assert.match(message.textContent, /Черновик сохранён/);
assert.ok(notices.some((item) => item.text.includes('список не обновился')));

const postPromise = post();
assert.equal(requests.length, 3);
assert.equal(requests[2].url, '/api/inventory/purchase-documents/draft-1/post');
await voidDraft();
assert.equal(requests.length, 3, 'void cannot race post');
requests[2].reject({ payload: { error: 'purchase_document_post_failed', detail: 'purchase_item_unit_changed' } });
await postPromise;
assert.ok(notices.some((item) => item.text.includes('Карточка позиции изменилась')));
assert.equal(context.purchaseActionPending, false);

const archivedPostPromise = post();
assert.equal(requests.length, 4);
requests[3].reject({ payload: { error: 'purchase_ingredient_archived', detail: 'purchase_ingredient_archived' } });
await archivedPostPromise;
assert.ok(notices.some((item) => item.text.includes('для автозаказа — из этой заявки')));
assert.equal(context.purchaseActionPending, false, 'archived-position rejection releases the pending state');

const voidPromise = voidDraft();
assert.equal(requests.length, 5);
assert.equal(requests[4].url, '/api/inventory/purchase-documents/draft-1/void');
requests[4].resolve({ status: 'voided' });
await voidPromise;
assert.ok(notices.some((item) => item.text.includes('Черновик отменён')));
assert.equal(context.purchaseActionPending, false);

console.log('PASS purchase draft save, retry, post/void serialization, and refresh warning QA');
