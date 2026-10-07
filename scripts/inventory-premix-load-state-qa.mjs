import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const portal = readFileSync(new URL('../portal.js', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../style.css', import.meta.url), 'utf8');
const dashboardStart = portal.indexOf('function renderDashboard()');
const inventoryStart = portal.indexOf('function renderInventory()');
assert.ok(dashboardStart >= 0 && inventoryStart > dashboardStart, 'dashboard and inventory renderers must exist');
const dashboardSource = portal.slice(dashboardStart, inventoryStart);
assert.doesNotMatch(dashboardSource, /loadPremixData|premix-empty-guidance|premix-form/, 'premix controls must not be wired to the dashboard route');
const inventorySource = portal.slice(inventoryStart, portal.indexOf('function renderFinance()', inventoryStart));
assert.match(inventorySource, /if \(purchaseForm\) document\.querySelector\('#purchase-date'\)\.value = '';\s*renderPurchaseLines\(\); loadPurchaseDocuments\(\);/, 'read-only inventory renders without the purchase date editor');
assert.match(inventorySource, /const dataPromise = canManagePremixes \? Promise\.all\(\[api\('\/api\/recipes'\), api\('\/api\/inventory'\), api\('\/api\/inventory\/premixes'\)\]\) : Promise\.all\(\[Promise\.resolve\(\{ items: \[\] \}\), Promise\.resolve\(\{ items: \[\] \}\), api\('\/api\/inventory\/premixes'\)\]\)/,
  'read-only roles load premix history without requesting write-only recipe or inventory data');
assert.match(inventorySource, /const loadPremixData = \(\) => \{[\s\S]*?const list = document\.querySelector\('#premix-batches'\)[\s\S]*?refreshInventoryContext\(\);\s*\}\);/,
  'premix completion refreshes inventory context after the batch history is rendered');
assert.match(inventorySource, /const premixPanel = document\.createElement\('section'\)[\s\S]*?target\.append\(premixPanel\)[\s\S]*?loadPremixData\(\);/, 'inventory route must mount the premix panel before loading its data');
assert.match(styles, /\.premix-setup-guidance:not\(\[hidden\]\)\{[^}]*display:flex[^}]*flex-direction:column[^}]*gap:8px/s, 'visible premix guidance must separate its heading, explanation and action');
const start = portal.indexOf('  const loadPremixData = () => {');
const end = portal.indexOf('; loadPremixData();', start);
assert.ok(start >= 0 && end > start, 'premix loader must be discoverable');
const loaderSource = portal.slice(start, end + 1);

const createFixture = () => {
  const controls = [0, 1, 2].map((index) => ({ disabled: false, matches: () => index === 2 }));
  const classes = new Set(); const attributes = new Map();
  const nodes = {
    '#premix-recipe': { innerHTML: '' },
    '#premix-output': { innerHTML: '' },
    '#premix-form': { dataset: {}, querySelectorAll: () => controls },
    '#premix-empty-guidance': { hidden: true, innerHTML: '', classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name) }, setAttribute: (key, value) => attributes.set(key, value), removeAttribute: (key) => attributes.delete(key) },
    '#premix-batches': { innerHTML: '' },
  };
  const document = { querySelector: (selector) => nodes[selector] || null };
  const deps = { document, nodes, classes, attributes, controls };
  return deps;
};
const loadPremixData = (api, fixture) => new Function('api', 'document', 'esc', 'displayName', 'money', 'canWriteInventory', 'refreshInventoryContext', `${loaderSource}\nreturn loadPremixData;`)(
  api, fixture.document, String, String, (amount) => `${Number(amount || 0)} ₽`, true, () => {});

const failedFixture = createFixture();
const fail = loadPremixData((path) => path === '/api/inventory' ? Promise.reject(new Error('offline')) : Promise.resolve({ items: [] }), failedFixture);
await fail();
assert.equal(failedFixture.nodes['#premix-empty-guidance'].hidden, false);
assert.equal(failedFixture.attributes.get('role'), 'alert');
assert.ok(failedFixture.classes.has('auto-order-load-error'));
assert.match(failedFixture.nodes['#premix-empty-guidance'].innerHTML, /Не удалось загрузить данные премиксов/);
assert.match(failedFixture.nodes['#premix-empty-guidance'].innerHTML, /data-premix-retry/);
assert.ok(failedFixture.controls.every((control) => control.disabled), 'production stays disabled while prerequisites are unknown');
assert.match(failedFixture.nodes['#premix-batches'].innerHTML, /История партий временно недоступна/);

const recoveredFixture = createFixture();
const recover = loadPremixData((path) => Promise.resolve(path === '/api/recipes' ? { items: [{ id: 'r', name: 'Сироп', recipeType: 'premix', yieldQuantity: 1, yieldUnit: 'л' }] } : path === '/api/inventory' ? { items: [{ id: 'o', name: 'Сироп', unit: 'л' }] } : { items: [] }), recoveredFixture);
await recover();
assert.equal(recoveredFixture.nodes['#premix-empty-guidance'].hidden, true);
assert.ok(!recoveredFixture.classes.has('auto-order-load-error'));
assert.ok(recoveredFixture.controls.every((control) => !control.disabled), 'successful retry restores the production form');
recoveredFixture.nodes['#premix-form'].dataset.submitting = '1';
await recover();
assert.ok(recoveredFixture.controls.slice(0, 2).every((control) => !control.disabled), 'reload keeps selectors available while producing');
assert.equal(recoveredFixture.controls[2].disabled, true, 'reload cannot re-enable production during an in-flight batch');
assert.match(recoveredFixture.nodes['#premix-recipe'].innerHTML, /Сироп/);
assert.match(recoveredFixture.nodes['#premix-batches'].innerHTML, /Партии ещё не приготовлены/);

const readOnlyNodes = { '#premix-batches': { innerHTML: '' } };
const readOnlyFixture = { document: { querySelector: (selector) => readOnlyNodes[selector] || null } };
const readOnlyRequests = [];
const readOnlyLoad = loadPremixData((path) => { readOnlyRequests.push(path); return Promise.resolve({ items: [{ recipeName: 'Тестовый премикс', outputQuantity: 2, outputUnit: 'л', createdAt: '2026-09-29T10:00:00Z' }] }); }, readOnlyFixture);
await readOnlyLoad();
assert.deepEqual(readOnlyRequests, ['/api/inventory/premixes'], 'read-only role loads history without requesting write-only recipe/stock data');
assert.match(readOnlyNodes['#premix-batches'].innerHTML, /Тестовый премикс/);

console.log('INVENTORY PREMIX LOAD STATE QA: PASS (route wiring, failure/retry, successful recovery and read-only history)');
