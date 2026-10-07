import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const portal = readFileSync(new URL('../portal.js', import.meta.url), 'utf8');
const capture = portal.slice(portal.indexOf("document.addEventListener('submit'"), portal.indexOf('\n', portal.indexOf("document.addEventListener('submit'")));
assert.match(capture, /'movement-form', 'inventory-item-form'/, 'inventory forms must own pending state');

const start = portal.indexOf("  if (canWriteInventory) { const form = document.querySelector('#inventory-item-form')");
const end = portal.indexOf('\n  load();', start);
assert.ok(start > 0 && end > start, 'inventory item editor block exists');

const fields = new Map();
for (const key of ['name', 'department', 'subdepartment', 'category', 'type', 'unit', 'purchase-unit', 'pack', 'cost', 'min', 'supplier', 'barcode', 'alcohol-catalog', 'tobacco-catalog', 'note']) fields.set(`#inventory-item-${key}`, { value: '', disabled: false, addEventListener() {} });
fields.get('#inventory-item-name').value = 'QA позиция';
fields.get('#inventory-item-department').value = 'bar';
fields.get('#inventory-item-unit').value = 'шт';
fields.get('#inventory-item-pack').value = '1';
const message = { textContent: '', className: '' };
const submitButton = { disabled: false, textContent: 'Сохранить позицию' };
let onSubmit;
const form = {
  dataset: { itemId: '' }, hidden: true,
  reset() {}, scrollIntoView() {},
  querySelector: () => submitButton,
  querySelectorAll: () => [...fields.values(), submitButton],
  addEventListener: (event, callback) => { if (event === 'submit') onSubmit = callback; },
};
let onNew;
let onCancel;
const newButton = { disabled: false, addEventListener: (_event, callback) => { onNew = callback; } };
const cancelButton = { addEventListener: (_event, callback) => { onCancel = callback; } };
const editorTitle = { textContent: '' };
const inventoryItemEditor = { hidden: true, querySelector: () => editorTitle };
const requests = [];
const notices = [];
const document = {
  querySelector: (selector) => ({ '#inventory-item-form': form, '#inventory-item-message': message, '#new-inventory-item': newButton, '#cancel-inventory-item': cancelButton, '#inventory-rows': { addEventListener() {} } })[selector] || fields.get(selector),
};
vm.runInNewContext(portal.slice(start, end), {
  canWriteInventory: true,
  document,
  inventoryItemEditor,
  inventorySubdepartments: [],
  productCategoryItems: [],
  syncAlcoholLinkSelector() {},
  syncTobaccoLinkSelector() {},
  allItems: [],
  api: () => new Promise((resolve, reject) => requests.push({ resolve, reject })),
  portalNotice: (text, kind) => notices.push({ text, kind }),
  load: () => {},
  loadAutoOrders: () => {},
  Event: class {},
});
const submit = () => onSubmit({ preventDefault() {} });
const settle = async () => { await new Promise((resolve) => setImmediate(resolve)); };

submit();
assert.equal(requests.length, 1);
assert.equal(form.dataset.submitting, '1');
assert.equal(submitButton.disabled, true);
assert.equal(newButton.disabled, true);
submit();
assert.equal(requests.length, 1, 'slow POST must not be duplicated');
onCancel();
onNew();
assert.equal(form.hidden, true, 'pending request must not switch or close the editor');
requests[0].reject({ payload: { error: 'inventory_department_not_found' } });
await settle();
assert.equal(message.textContent, 'Выберите действующий цех из справочника');
assert.equal(submitButton.disabled, false, 'API error must immediately unlock submit');
assert.equal(newButton.disabled, false);
assert.equal(form.dataset.submitting, '0');

submit();
assert.equal(requests.length, 2, 'retry must start immediately');
requests[1].resolve({ id: 'qa-item' });
await settle();
assert.equal(form.dataset.submitting, '0');
assert.deepEqual(notices, [{ text: 'Позиция сохранена', kind: 'success' }]);

const movementStart = portal.indexOf("document.querySelector('#movement-form')?.addEventListener('submit'");
const movementEnd = portal.indexOf('\n  if (canWriteInventory)', movementStart);
assert.ok(movementStart > 0 && movementEnd > movementStart);
const movementFields = new Map([
  ['#movement-direction', { value: 'out', disabled: false }],
  ['#movement-item', { value: 'item-1', disabled: false }],
  ['#movement-delta', { value: '2', disabled: false }],
  ['#movement-unit', { value: 'шт', disabled: false }],
  ['#movement-reason', { value: 'QA расход', disabled: false }],
]);
const movementMessage = { textContent: '', className: '' };
const movementButton = { disabled: false, textContent: 'Сохранить операцию' };
const movementClose = { disabled: false };
const movementCancel = { disabled: false };
let movementModalCloseCount = 0;
let movementResetCount = 0;
let selectRefreshCount = 0;
movementFields.get('#movement-item')._customSelectRefresh = () => { selectRefreshCount += 1; };
const movementForm = { dataset: {}, reset: () => { movementResetCount += 1; }, querySelector: () => movementButton, querySelectorAll: () => [...movementFields.values()] };
let onMovementSubmit;
const movementRequests = [];
vm.runInNewContext(portal.slice(movementStart, movementEnd), {
  document: { querySelector: (selector) => selector === '#movement-form' ? { addEventListener: (_event, callback) => { onMovementSubmit = callback; } } : selector === '#movement-message' ? movementMessage : selector === '#inventory-movement-dialog [data-journal-close]' ? movementClose : selector === '#movement-cancel' ? movementCancel : movementFields.get(selector) },
  api: () => new Promise((resolve, reject) => movementRequests.push({ resolve, reject })),
  portalNotice: () => {},
  closeMovementEditor: (key) => { assert.equal(key, 'movement'); assert.equal(movementForm.dataset.submitting, '0', 'movement closes after pending releases'); assert.equal(movementClose.disabled, false); assert.equal(movementCancel.disabled, false); movementModalCloseCount += 1; },
  load: () => {}, loadAutoOrders: () => {},
});
const submitMovement = () => onMovementSubmit({ preventDefault() {}, target: movementForm });
submitMovement();
assert.equal(movementRequests.length, 1);
assert.equal(movementButton.disabled, true);
assert.equal(movementClose.disabled, true);
assert.equal(movementCancel.disabled, true);
assert.equal(movementFields.get('#movement-delta').disabled, true);
submitMovement();
assert.equal(movementRequests.length, 1, 'pending movement must not duplicate');
movementRequests[0].reject({ payload: { error: 'insufficient_stock' } });
await settle();
assert.equal(movementMessage.textContent, 'Недостаточно остатка для расхода');
assert.equal(movementButton.disabled, false);
assert.equal(movementButton.textContent, 'Сохранить операцию');
assert.equal(movementFields.get('#movement-delta').disabled, false);
assert.equal(movementClose.disabled, false);
assert.equal(movementCancel.disabled, false);
assert.equal(movementModalCloseCount, 0, 'failed movement remains open');
assert.ok(selectRefreshCount >= 2, 'custom select must refresh on lock and unlock');
submitMovement();
assert.equal(movementRequests.length, 2);
movementRequests[1].resolve({ id: 'movement-qa' });
await settle();
assert.equal(movementResetCount, 1, 'successful movement must reset form once');
assert.equal(movementModalCloseCount, 1, 'successful movement requests modal close once');
assert.equal(movementMessage.textContent, 'Движение сохранено, остаток обновлён');
assert.equal(movementButton.disabled, false);

console.log('INVENTORY FORM PENDING QA: PASS (item and movement pending/error, duplicate guard, editor lock)');
