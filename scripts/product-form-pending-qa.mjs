import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const portal = readFileSync(new URL('../portal.js', import.meta.url), 'utf8');
const capture = portal.slice(portal.indexOf("document.addEventListener('submit'"), portal.indexOf('\n', portal.indexOf("document.addEventListener('submit'")));
assert.match(capture, /'product-form'/, 'product form must own pending state');
const productBlock = /if \(canWriteInventory\) \{\s+const form = document\.querySelector\('#product-form'\);/.exec(portal);
const start = productBlock?.index ?? -1;
const end = portal.indexOf('  const purchaseForm = ', start);
assert.ok(start > 0 && end > start, 'product handlers found');
const block = portal.slice(start, end);
assert.match(block, /if \(form\.dataset\.submitting === '1'\) return;/);
assert.match(block, /if \(form\.dataset\.imageProcessing === '1'\)/);
assert.match(block, /await api\(id \? `\/api\/products/);
assert.match(block, /try \{ const data = await api\('\/api\/products'\); drawProducts\(data\.items\); \}/);

const handlers = new Map();
const elements = new Map();
const make = (id, value = '') => ({ id, value, disabled: false, hidden: false, textContent: '', className: '', innerHTML: '', closest: () => ({ after() {} }), addEventListener: (name, callback) => handlers.set(`${id}:${name}`, callback) });
for (const id of ['product-id', 'product-name', 'product-category', 'product-price', 'product-inventory-mode', 'product-aliases', 'product-image-file', 'delete-product', 'save-product', 'new-product', 'cancel-product', 'product-form-title', 'product-form-hint', 'product-form-status', 'product-message']) elements.set(`#${id}`, make(id));
const form = { dataset: {}, hidden: false, reset: () => {}, reportValidity: () => true, querySelectorAll: () => [...elements.values()], addEventListener: (name, callback) => handlers.set(`product-form:${name}`, callback) };
elements.set('#product-form', form);
elements.get('#product-name').value = 'QA товар';
elements.get('#product-category').value = 'Бар';
elements.get('#product-price').value = '350';
elements.get('#product-inventory-mode').value = 'tracked';
let selectRefreshCount = 0;
elements.get('#product-inventory-mode')._customSelectRefresh = () => { selectRefreshCount += 1; };
const requests = [];
const notices = [];
let previewCount = 0;
let resetCount = 0;
form.reset = () => { resetCount += 1; };
let compressResolve;
vm.runInNewContext(block, {
  canWriteInventory: true,
  document: {
    querySelector: (selector) => selector === '#product-preparation-station' ? null : elements.get(selector),
    createElement: (tagName) => ({ tagName, textContent: '', id: '', innerHTML: '', append() {} }),
  },
  pendingProductImage: null,
  productImageChanged: false,
  syncProductPreview: () => { previewCount += 1; },
  setProductEditorMode: () => {},
  icon: () => '',
  compressUploadedImage: () => new Promise((resolve) => { compressResolve = resolve; }),
  portalNotice: (message, kind) => notices.push({ message, kind }),
  api: (url, options) => new Promise((resolve, reject) => requests.push({ url, options, resolve, reject })),
  drawProducts: () => {},
  window: { confirm: () => true },
});
const submit = () => handlers.get('product-form:submit')({ preventDefault() {} });
const tick = () => new Promise((resolve) => setImmediate(resolve));

submit();
assert.equal(requests.length, 1);
assert.equal(requests[0].options.method, 'POST');
assert.equal(form.dataset.submitting, '1');
assert.ok(selectRefreshCount >= 1, 'custom inventory select must refresh on lock');
submit();
assert.equal(requests.length, 1, 'slow create must not duplicate');
handlers.get('cancel-product:click')();
assert.equal(resetCount, 0, 'cancel cannot erase pending editor');
handlers.get('delete-product:click')();
assert.equal(requests.length, 1, 'delete cannot overlap save');
requests[0].reject({ payload: { error: 'invalid_product' } });
await tick();
assert.equal(form.dataset.submitting, '0');
assert.ok(selectRefreshCount >= 2, 'custom inventory select must refresh on unlock');
assert.equal(elements.get('#save-product').disabled, false);
assert.equal(elements.get('#product-message').textContent, 'Проверьте название, категорию и цену.');
submit();
assert.equal(requests.length, 2, 'retry must send immediately');
requests[1].resolve({ id: 'qa-product' });
await tick();
assert.equal(requests[2].url, '/api/products');
requests[2].reject(new Error('refresh failed'));
await tick();
assert.equal(resetCount, 1, 'successful mutation closes editor despite refresh failure');
assert.equal(form.dataset.submitting, '0');
assert.ok(notices.some((item) => item.message.includes('Товар создан')));
assert.ok(notices.some((item) => item.message.includes('каталог не обновился')));

elements.get('#product-image-file').files = [{ type: 'image/png', size: 100 }];
handlers.get('product-image-file:change')();
assert.equal(form.dataset.imageProcessing, '1');
submit();
assert.equal(requests.length, 3, 'submit waits for image compression');
handlers.get('cancel-product:click')();
const previewBeforeStaleImage = previewCount;
compressResolve('data:image/png;base64,QA');
await tick();
assert.equal(form.dataset.imageProcessing, '0');
assert.equal(previewCount, previewBeforeStaleImage, 'stale compression must not change next editor preview');

console.log('PASS product form pending, retry, refresh failure, and image generation QA');
