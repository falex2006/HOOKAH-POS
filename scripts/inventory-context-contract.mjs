import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const portal = readFileSync(new URL('../portal.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');
const requiredViews = ['stock', 'auto-orders', 'movements', 'recipes', 'premixes', 'directories', 'products'];
for (const view of requiredViews) {
  assert.match(portal, new RegExp(`(?:^|\\n)\\s*['"]?${view}['"]?: \\{ title:`), `missing contextual title and KPI contract for ${view}`);
}
for (const id of ['inventory-page-heading', 'inventory-page-description', 'inventory-header-actions', 'inventory-kpi-label-1', 'inventory-kpi-value-3']) {
  assert.ok(portal.includes(`id="${id}"`), `contextual warehouse shell is missing ${id}`);
}
for (const action of ['item', 'receipt', 'adjustment', 'department', 'subdepartment', 'category']) {
  assert.ok(portal.includes(`'${action}'`) && portal.includes(`action === '${action}'`), `header action is not wired: ${action}`);
}
for (const action of ['auto-order', 'recipe', 'premix', 'product']) {
  assert.doesNotMatch(portal.match(/const inventoryViewContent = \{[\s\S]*?\n  \};/)?.[0] || '', new RegExp(`actions: \\[\\['${action}'`), `duplicate top-level CTA remains for ${action}`);
}
assert.match(portal, /id="create-auto-order"/, 'the single stock replenishment action remains available in its panel');
assert.match(portal, /id="new-recipe"/, 'the single recipe creation action remains available in its panel');
assert.match(portal, /id="new-product"/, 'the single product creation action remains available in its panel');
assert.match(portal, /const addButton = document\.querySelector\('#new-product'\);\s*if \(addButton\) \{ addButton\.disabled = true; addButton\.textContent = 'Форма открыта'; \}/,
  'opening the product editor must prevent a repeated create click from wiping entered data');
assert.match(portal, /addButton\.disabled = form\.dataset\.submitting === '1'; addButton\.innerHTML = `\$\{icon\('plus'\)\} Добавить товар`/,
  'closing or saving the product editor must restore the add-product action');
assert.match(portal, /id="open-products"/, 'directory panel retains its catalog navigation action');
assert.match(portal, /actions: \[\['department', 'Новый цех', 'primary'\], \['subdepartment', 'Новый подцех', ''\], \['category', 'Новая категория', ''\]\]/,
  'directory creation actions belong together in the page heading');
const directoryPanelMarkup = portal.match(/const categoryPanel = document\.createElement\('section'\);[\s\S]*?target\.append\(categoryPanel\)/)?.[0] || '';
assert.doesNotMatch(directoryPanelMarkup, /id="new-inventory-department"|id="new-inventory-subdepartment"|id="new-product-category"/,
  'directory body must not duplicate its heading creation actions');
for (const id of ['new-recipe', 'new-product', 'create-auto-order']) {
  assert.equal(portal.match(new RegExp(`id="${id}"`, 'g'))?.length || 0, 1, `expected one visible source control for ${id}`);
}
assert.match(portal, /actions: \[\], kpis: \[\['К заказу'/, 'auto-order header must not repeat its conditional panel CTA');
assert.match(portal, /product-catalog-empty/, 'catalog empty state must have its semantic class');
assert.match(portal, /class="empty visual-catalog-empty product-catalog-empty"/, 'catalog empty state must match the responsive full-width style');
assert.match(portal, /const emptyMessage = productItems\.length[\s\S]*По запросу ничего не найдено[\s\S]*Каталог пока пуст/,
  'catalog must distinguish an empty inventory from a search with no matches');
assert.match(css, /\.visual-catalog-empty\{grid-column:1\/-1/, 'catalog empty state must span the catalog grid');
assert.match(portal, /recipe\.productId && productItems\.some\(\(product\) => String\(product\.id\) === String\(recipe\.productId\)\)/,
  'recipe linkage KPI must count only valid links to existing menu products');
assert.match(portal, /id="premix-empty-guidance"/, 'premix empty state must explain how to create the required recipe');
assert.match(portal, /querySelectorAll\('select,input,button\[type=submit\]'\)\.forEach\(\(control\) => \{ control\.disabled = !canProduce \|\| \(control\.matches\('button\[type=submit\]'\) && premixForm\.dataset\.submitting === '1'\); \}\)/,
  'premix production controls must remain disabled until a recipe and output stock item exist');
assert.match(portal, /id="premix-submit" type="submit" disabled/, 'premix submit must start disabled before availability is confirmed');
assert.match(portal, /data-premix-create-recipe/, 'premix empty state must offer a direct route to recipe creation');
for (const legacy of ['inventory-count', 'inventory-low', 'inventory-last']) {
  assert.match(portal, new RegExp(`id="${legacy}"`), `existing inventory data binding must remain compatible: ${legacy}`);
}
assert.match(portal, /refreshInventoryContext\(\)/, 'context KPI values must refresh as data loads');
assert.match(portal, /searchParams\.get\('view'\) \|\| 'stock'/, 'context must follow the canonical query view after refresh');
assert.match(css, /\.inventory-header-actions\{display:flex;align-items:center;justify-content:flex-end;gap:10px;flex-wrap:wrap\}/,
  'context actions should wrap evenly without introducing a new layout language');
assert.match(css, /@container crm-content \(max-width:560px\)\{[\s\S]*?\.inventory-page-title>\.toolbar-row\{grid-template-columns:minmax\(0,1fr\)/,
  'header actions must stack on narrow screens');
assert.match(css, /\.inventory-context-kpis>\.kpi>strong\{overflow-wrap:anywhere;font-variant-numeric:tabular-nums\}/,
  'context KPIs must handle long values consistently');

console.log(`INVENTORY CONTEXT CONTRACT: PASS (${requiredViews.length} views, one primary action per view, empty states and responsive layout)`);
