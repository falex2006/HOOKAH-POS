import assert from 'node:assert/strict';
import fs from 'node:fs';
const server = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const portal = fs.readFileSync(new URL('../portal.js', import.meta.url), 'utf8');
const migration = fs.readFileSync(new URL('../migrations/037_inventory_premix.sql', import.meta.url), 'utf8');
const bindingMigration = fs.readFileSync(new URL('../migrations/110_premix_recipe_output_binding.sql', import.meta.url), 'utf8');
assert.match(migration, /inventory_premix_batches/);
assert.match(migration, /recipe_type/);
assert.match(server, /\/api\/inventory\/premixes\/produce/);
assert.match(server, /insufficient_premix_stock/);
assert.match(server, /inventory\.premix_produced/);
assert.match(server, /UPDATE ingredients SET cost=\$1 WHERE id=\$2 AND venue_id=\$3/,
  'premix production must publish its weighted unit cost to the output inventory item');
assert.match(server, /nextOutputCost = nextOutputQuantity > 0 \? \(\(previousOutputQuantity \* Number\(outputRow\.cost \|\| 0\)\) \+ totalCost\) \/ nextOutputQuantity/,
  'existing premix stock and new batch cost must be combined using weighted average cost');
assert.match(server, /premix_output_cannot_be_an_ingredient/,
  'the produced output cannot also be consumed as its own ingredient');
assert.match(bindingMigration, /output_ingredient_id uuid/);
assert.match(bindingMigration, /inventory_recipe_cards_premix_output_unique_idx/);
assert.match(bindingMigration, /inventory_premix_batch_recipe_binding_guard/);
assert.match(bindingMigration, /TG_OP='INSERT' OR OLD\.recipe_type IS DISTINCT FROM 'premix'/,
  'new premix cards require an output while legacy null bindings remain repairable');
assert.match(bindingMigration, /OLD\.output_ingredient_id IS NOT NULL AND NEW\.output_ingredient_id IS DISTINCT FROM OLD\.output_ingredient_id/,
  'legacy history can be preserved while an ambiguous unbound card is assigned its future output');
assert.match(server, /premix_output_binding_mismatch/);
assert.match(portal, /recipe-output-ingredient/);
assert.match(portal, /outputItemId: recipe\.outputIngredientId/);
assert.match(server, /combinedRequirements/,
  'duplicate recipe lines for the same ingredient must be aggregated before stock validation');
assert.match(server, /const combinedRequirements = new Map\(\); for \(const entry of requirements\)/,
  'demo production must validate aggregated requirements before it changes any stock');
assert.match(portal, /Заготовки и премиксы/);
assert.match(portal, /href: '\/inventory\?view=premixes'/);
assert.match(portal, /window\.addEventListener\('popstate', \(\) => setInventoryView/);
assert.match(portal, /recipeType/);
console.log('PREMIX CONTRACT: PASS');
