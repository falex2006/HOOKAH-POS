import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const portal = readFileSync(new URL('../portal.js', import.meta.url), 'utf8');
const capture = portal.slice(portal.indexOf("document.addEventListener('submit'"), portal.indexOf('\n', portal.indexOf("document.addEventListener('submit'")));
assert.match(capture, /'recipe-form'/, 'recipe form must own its pending state');
const scope = portal.indexOf("const form = document.querySelector('#recipe-form')");
const start = portal.indexOf('    const lockRecipeControls = () => {', scope);
const end = portal.indexOf('    loadRecipes();', start);
assert.ok(start > scope && end > start, 'recipe submit handler exists');
assert.match(portal.slice(start, end), /if \(form\.dataset\.submitting === '1'\) return/, 'delete/grid actions must respect pending save');
assert.match(portal.slice(scope, start), /#new-recipe'\)\?\.addEventListener\('click', \(\) => \{ if \(form\.dataset\.submitting !== '1'\)/, 'new editor must stay closed while saving');

const fields = new Map();
for (const id of ['recipe-id', 'recipe-name', 'recipe-category', 'recipe-product', 'recipe-type', 'recipe-yield-quantity', 'recipe-yield-unit', 'recipe-portion-count', 'recipe-technology', 'recipe-serve']) fields.set(`#${id}`, { value: '' });
fields.get('#recipe-name').value = 'QA карта';
fields.get('#recipe-category').value = 'Коктейли';
fields.get('#recipe-type').value = 'sale';
fields.get('#recipe-yield-quantity').value = '1';
fields.get('#recipe-yield-unit').value = 'порция';
fields.get('#recipe-portion-count').value = '1';
fields.get('#recipe-product').disabled = true;
let selectRefreshCount = 0;
fields.get('#recipe-product')._customSelectRefresh = () => { selectRefreshCount += 1; };
const submitButton = { disabled: false, textContent: 'Сохранить карту' };
const newButton = { disabled: false };
const recipeMessage = { textContent: '', className: '' };
let onSubmit;
let formResetCount = 0;
const form = { hidden: false, dataset: {}, reset: () => { formResetCount += 1; }, addEventListener: (_event, callback) => { onSubmit = callback; }, querySelector: () => submitButton, querySelectorAll: () => [...fields.values(), submitButton] };
let onFormDelete;
let onGridClick;
const deleteButton = { disabled: false, addEventListener: (_event, callback) => { onFormDelete = callback; } };
const recipeGrid = { addEventListener: (_event, callback) => { onGridClick = callback; } };
const requests = [];
const notices = [];
vm.runInNewContext(portal.slice(start, end), {
  form,
  document: { querySelector: (selector) => selector === '#new-recipe' ? newButton : selector === '#delete-recipe' ? deleteButton : fields.get(selector) },
  validateRecipeProgress: () => true,
  calculateRecipeCost: () => ({ valid: true }),
  parseIngredientLines: () => [{ ingredientId: 'stock-1', quantity: '1 шт', unit: 'шт' }],
  recipeMessage,
  recipeGrid,
  recipeItems: [{ id: 'recipe-1', name: 'QA карта' }],
  window: { confirm: () => true },
  api: (url, options) => new Promise((resolve, reject) => requests.push({ url, options, resolve, reject })),
  loadRecipes: () => Promise.resolve(),
  resetRecipeForm: () => {},
  portalNotice: (message, kind) => notices.push({ message, kind }),
});
const submit = () => onSubmit({ preventDefault() {} });
const settle = async () => { await new Promise((resolve) => setImmediate(resolve)); };

submit();
assert.equal(requests.length, 1);
assert.equal(requests[0].url, '/api/recipes');
assert.equal(requests[0].options.method, 'POST');
assert.equal(JSON.parse(requests[0].options.body).category, 'Коктейли');
assert.equal(form.dataset.submitting, '1');
assert.equal(submitButton.disabled, true);
assert.equal(newButton.disabled, true);
submit();
assert.equal(requests.length, 1, 'slow create must not duplicate');
requests[0].reject({ payload: { error: 'recipe_ingredient_not_found' } });
await settle();
assert.equal(recipeMessage.textContent, 'Ингредиент не найден в текущем складе');
assert.equal(submitButton.disabled, false, 'error must unlock immediately');
assert.equal(submitButton.textContent, 'Сохранить карту');
assert.equal(newButton.disabled, false);
assert.equal(fields.get('#recipe-product').disabled, true, 'premix product state must survive pending');
assert.ok(selectRefreshCount >= 2);

fields.get('#recipe-id').value = 'recipe-1';
submitButton.textContent = 'Сохранить изменения';
submit();
assert.equal(requests.length, 2);
assert.equal(requests[1].url, '/api/recipes/recipe-1');
assert.equal(requests[1].options.method, 'PATCH');
requests[1].resolve({ id: 'recipe-1' });
await settle();
assert.equal(form.hidden, true);
assert.equal(form.dataset.submitting, '0');
assert.equal(submitButton.textContent, 'Сохранить изменения');
assert.deepEqual(notices, [{ message: 'Изменения технологической карты сохранены', kind: 'success' }]);

const rowDelete = { dataset: { recipeDelete: 'recipe-1' }, disabled: false };
onGridClick({ target: { closest: (selector) => selector === '[data-recipe-delete]' ? rowDelete : null } });
assert.equal(requests.length, 3);
assert.equal(requests[2].options.method, 'DELETE');
submit();
onFormDelete();
onGridClick({ target: { closest: (selector) => selector === '[data-recipe-delete]' ? rowDelete : null } });
assert.equal(requests.length, 3, 'pending delete must block save and other deletes');
requests[2].reject(new Error('offline'));
await settle();
assert.equal(form.dataset.submitting, '0');
assert.equal(rowDelete.disabled, false);

onFormDelete();
assert.equal(requests.length, 4);
assert.equal(requests[3].options.method, 'DELETE');
submit();
assert.equal(requests.length, 4, 'form delete must block overlapping edit');
requests[3].resolve({ ok: true });
await settle();
assert.equal(form.dataset.submitting, '0');
assert.equal(deleteButton.disabled, false);
form.hidden = false;
onGridClick({ target: { closest: (selector) => selector === '[data-recipe-delete]' ? rowDelete : null } });
assert.equal(requests.length, 5);
requests[4].resolve({ ok: true });
await settle();
assert.equal(form.hidden, true, 'deleting the open recipe must close its editor');
assert.equal(formResetCount, 1);

console.log('RECIPE FORM PENDING QA: PASS (save/delete serialization, error retry, locked controls, label restore)');
