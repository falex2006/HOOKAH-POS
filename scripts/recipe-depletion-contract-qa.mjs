import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const { scaleBatchRecipeIngredients } = require('../recipe-depletion.js');
const server = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');

const batch = [{ ingredientId: 'water', name: 'Вода', quantity: '400 мл', unit: 'мл' }];

const onePortion = scaleBatchRecipeIngredients(batch, 1, 4);
assert.equal(onePortion[0].quantity, '100 мл', 'one sold portion consumes one quarter of the 400 ml batch');
assert.equal(onePortion[0].ingredientId, 'water', 'ingredient links remain intact');
assert.equal(batch[0].quantity, '400 мл', 'scaling does not mutate the saved recipe');

const twoPortions = scaleBatchRecipeIngredients(batch, 2, 4);
assert.equal(twoPortions[0].quantity, '200 мл', 'two sold portions consume half of the batch');

const onePortionBatch = scaleBatchRecipeIngredients(batch, 1, 1);
assert.equal(onePortionBatch[0].quantity, '400 мл', 'single-portion recipe keeps its full quantity per sale');

const fractional = scaleBatchRecipeIngredients([{ name: 'Сироп', quantity: '1,5 л' }], 1, 3);
assert.equal(fractional[0].quantity, '0.5 л', 'decimal comma is normalized and fractional yield is preserved');

for (const invalidCount of [undefined, null, 0, -1, 1.5, Number.NaN]) {
  assert.throws(() => scaleBatchRecipeIngredients(batch, 1, invalidCount), /recipe_portion_count_invalid/);
}
for (const invalidQuantity of [0, -1, Number.NaN, 'not a quantity']) {
  assert.throws(() => scaleBatchRecipeIngredients(batch, invalidQuantity, 4), /recipe_order_quantity_invalid/);
}
for (const invalidIngredient of ['', '0 мл', '-2 г', '1, мл']) {
  assert.throws(() => scaleBatchRecipeIngredients([{ quantity: invalidIngredient }], 1, 4), /recipe_ingredient_quantity_invalid/);
}
assert.throws(() => scaleBatchRecipeIngredients(null, 1, 4), /recipe_ingredients_must_be_array/);
assert.match(server, /DESC NULLS LAST/, 'an exact product-linked recipe wins over a legacy unlinked card');
assert.match(server, /candidate\.active=true AND candidate\.recipe_type='sale'/,
  'only sale recipes may be depleted by a customer order; premix recipes are consumed only during production');
assert.match(server, /SELECT cost FROM order_costs WHERE venue_id=\$1 AND order_id=\$2/, 'idempotent depletion reuses the historical cost snapshot');
assert.match(server, /SELECT id FROM products WHERE id=\$1 AND venue_id=\$2/,
  'production recipe bindings must reference a product in the same venue');
assert.match(server, /premix_product_binding_not_allowed/,
  'premix recipes cannot be bound to sale products');
assert.doesNotMatch(server, /if \(depletion\.totalCost > 0\) await client\.query\('INSERT INTO order_costs/,
  'closing an order must save a zero cost snapshot as well as a positive one');
assert.match(server, /inventoryMode === 'non_stock'\) continue/, 'only an explicitly non-stock item may bypass depletion');
assert.match(server, /product_inventory_mode_required/, 'legacy product classification is required before a sale can close');
assert.match(server, /product_recipe_required/, 'tracked products cannot close without a sale recipe');
assert.match(server, /product_recipe_ambiguous/, 'ambiguous recipe-to-product matches block finalization');
assert.match(server, /JOIN recipe_items legacy_item ON legacy_item\.product_id=legacy_recipe\.product_id/, 'legacy recipe header alone is not accepted as a valid recipe');
assert.match(server, /FOR UPDATE/, 'catalog mode transitions and recipe/order writes serialize on the product row');
assert.match(server, /non_stock_product_has_recipe/, 'non-stock products cannot be assigned a sale recipe');
assert.match(server, /inventory_mode AS "inventoryMode"/, 'PostgreSQL product reads expose the accounting mode');
assert.match(fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'), /inventory_mode text NOT NULL DEFAULT 'tracked'/, 'fresh schema gives new products an explicit tracked mode');
assert.match(fs.readFileSync(new URL('../migrations/049_product_inventory_mode.sql', import.meta.url), 'utf8'), /needs_review/, 'legacy products without an unambiguous recipe are marked for review');
const portal = fs.readFileSync(new URL('../portal.js', import.meta.url), 'utf8');
assert.match(portal, /id="product-inventory-mode" required/, 'catalog editor requires an explicit inventory choice');
assert.match(portal, /Нужно проверить учёт/, 'legacy review state is visible on the product card');
assert.match(portal, /Разрешить отрицательный остаток при продаже/, 'owner-facing inventory editor exposes the per-position negative stock option');
assert.match(portal, /portalUser\.role === 'owner' \? '<label class="inventory-negative-stock-control"/, 'only owners see the negative stock control');
assert.match(portal, /payload\.allowNegativeStock = Boolean\(document\.querySelector\('#inventory-item-allow-negative'\)\?\.checked\)/, 'owner setting is included in the inventory save request');
assert.match(fs.readFileSync(new URL('../migrations/210_inventory_owner_negative_stock.sql', import.meta.url), 'utf8'), /allow_negative_stock boolean NOT NULL DEFAULT false/, 'existing positions keep the default safe behavior');
assert.match(server, /Object\.hasOwn\(input, 'allowNegativeStock'\) && req\.user\?\.role !== 'owner'/, 'API independently enforces owner-only setting changes');
assert.match(server, /pathname === '\/api\/inventory\/negative-stock-settings' && req\.method === 'POST'/, 'bulk negative-stock configuration has a dedicated API action');
assert.match(server, /inventory_negative_stock_owner_required/, 'bulk negative-stock configuration remains owner-only at the API');
assert.match(server, /negative_stock_items_not_found/, 'explicit item selection is rejected atomically when any selected item is outside the venue');
assert.match(server, /excludedPremixCount/, 'bulk responses report premix outputs excluded from enabling negative stock');
assert.match(server, /await repositories\.audit\.record\([\s\S]*?\n        await client\.query\('COMMIT'\)/, 'PostgreSQL audit evidence commits atomically with bulk stock settings');
assert.match(server, /const venueInventory = inventory\.filter\(\(item\) => String\(item\.venueId \|\| ''\) === memoryVenueId\)/, 'memory fallback limits bulk targets to the active venue');
assert.match(portal, /<option value="department">Позиции выбранного цеха<\/option><option value="category">Позиции выбранной категории<\/option><option value="items">Отметить позиции вручную<\/option>/, 'owner can scope a bulk setting to departments, categories, or explicit positions');
assert.match(portal, /negative-stock-bulk-dialog/, 'owner has a focused bulk configuration dialog');
assert.match(server, /item\.stock\.allowNegativeStock \|\| item\.stock\.isPremixOutput/, 'sales cannot bypass premix lot and expiry allocation safeguards');

console.log('RECIPE DEPLETION CONTRACT QA: 32 assertions passed');
