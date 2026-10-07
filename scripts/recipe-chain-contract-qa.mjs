import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const migration = fs.readFileSync(new URL('../migrations/029_inventory_recipe_outputs.sql', import.meta.url), 'utf8');
let checks = 0;

assert.match(source, /const client = transactionClient \|\| await pool\.connect\(\);/);
assert.match(source, /const ownsTransaction = !transactionClient;/);
assert.match(source, /await client\.query\('BEGIN'\)/);
assert.match(source, /SAVEPOINT legacy_recipe_lookup/);
assert.match(source, /ROLLBACK TO SAVEPOINT legacy_recipe_lookup/);
assert.match(source, /await client\.query\('SELECT id FROM ingredients[\s\S]*FOR UPDATE'/);
assert.match(source, /error\.code !== '42P01'/);
assert.match(source, /alreadyDepleted: true/);
assert.match(source, /order_costs/);
checks += 9;
assert.match(migration, /yield_quantity/);
assert.match(migration, /yield_unit/);
assert.match(migration, /portion_count/);
checks += 3;
assert.match(source, /const parseRecipeQuantity = \(value, targetUnit, fallbackUnit = null\) =>/,
  'server must own strict recipe quantity and unit validation');
assert.match(source, /raw\.match\(\/\^\(\[0-9\]\+\(\?:\\\.\[0-9\]\+\)\?\)\\s\*\(\[a-zа-яё\]\+\)\?\$\/i\)/,
  'recipe quantity parser must accept a positive numeric amount with an optional recognized unit');
assert.match(source, /recipeUnitFactors\[sourceUnit\]\[normalizedTarget\]/,
  'server parser must convert only compatible normalized units');
assert.match(source, /const parsed = parseRecipeQuantity\(item\.quantity, stockItem\.unit, item\.unit \|\| null\);/,
  'recipe normalization must validate each line against its linked stock item');
assert.match(source, /const recipeQuantityHasFiniteCost = \(parsed, stockItem\) =>[\s\S]*Number\.isFinite\(lineCost \* 100\)/,
  'recipe create/update must reject quantities outside the finite line-cost range');
assert.match(source, /const quantity = Number\(\(parsed\.amount \* parsed\.factor\)\.toFixed\(6\)\);[\s\S]*const unitCost = Number\(stockItem\.cost \|\| 0\); const lineCost = quantity \* unitCost;[\s\S]*Number\.isFinite\(lineCost \* 100\)[\s\S]*cost: Math\.round\(lineCost \* 100\) \/ 100/,
  'recipe costing must convert the measured quantity, validate finite cost, then round cents');
checks += 6;

console.log(`RECIPE CHAIN CONTRACT QA: ${checks} checks passed`);
