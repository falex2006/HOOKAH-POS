import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../portal.js', import.meta.url), 'utf8');
const parserMatch = source.match(/    const parseIngredientLines = \(\) =>[^\n]+;/);
assert.ok(parserMatch, 'recipe ingredient parser is present in portal.js');

const inventory = [
  { id: 'stock-mint', name: 'Мята — свежая', unit: 'г', cost: 0.42 },
  { id: 'stock-syrup', name: 'Сироп', unit: 'мл', cost: 1.25 },
];
let fieldValue = 'Мята — свежая — 12 г [stock-mint]\nСироп — 8 мл [stock-syrup]';
const context = {
  document: { querySelector: () => ({ value: fieldValue }) },
  recipeInventoryItems: inventory,
};
vm.createContext(context);
vm.runInContext(`${parserMatch[0]}; this.parseIngredientLines = parseIngredientLines;`, context);

let parsed = Array.from(context.parseIngredientLines());
assert.equal(parsed.length, 2);
assert.equal(parsed[0].name, 'Мята — свежая');
assert.equal(parsed[0].ingredientId, 'stock-mint');
assert.equal(parsed[0].quantity, '12 г');
assert.equal(parsed[0].unit, 'г');
assert.equal(parsed[1].name, 'Сироп');
assert.equal(parsed[1].ingredientId, 'stock-syrup');
assert.equal(parsed[1].quantity, '8 мл');
assert.equal(parsed[1].unit, 'мл');

// Exercise the same stock-link, quantity, and unit conditions used by the UI cost preview.
const costLines = parsed.map((line) => {
  const item = inventory.find((entry) => entry.id === line.ingredientId || entry.name.toLocaleLowerCase('ru-RU') === line.name.toLocaleLowerCase('ru-RU'));
  const match = line.quantity.match(/^([0-9]+(?:[.,][0-9]+)?)\s*(г|кг|мл|л|шт|порция|уп|упаковка)$/i);
  const quantity = Number((match?.[1] || '').replace(',', '.'));
  const valid = Boolean(item && match && quantity > 0 && item.unit === match[2].toLocaleLowerCase('ru-RU'));
  return { valid, cost: valid ? Math.round(quantity * item.cost * 100) / 100 : 0 };
});
assert.deepEqual(Array.from(costLines, (line) => line.valid), [true, true]);
assert.equal(costLines.reduce((total, line) => total + line.cost, 0), 15.04);

fieldValue = 'Мята — свежая — 0 г [stock-mint]\nМята — свежая — [stock-mint]';
parsed = Array.from(context.parseIngredientLines());
assert.equal(parsed[0].name, 'Мята — свежая');
assert.equal(parsed[0].quantity, '0 г');
assert.equal(parsed[1].name, 'Мята — свежая');
assert.equal(parsed[1].quantity, '');
const malformedCost = parsed.map((line) => {
  const item = inventory.find((entry) => entry.id === line.ingredientId);
  const match = line.quantity.match(/^([0-9]+(?:[.,][0-9]+)?)\s*(г|кг|мл|л|шт|порция|уп|упаковка)$/i);
  const quantity = Number((match?.[1] || '').replace(',', '.'));
  return Boolean(item && match && quantity > 0 && item.unit === match[2].toLocaleLowerCase('ru-RU'));
});
assert.deepEqual(Array.from(malformedCost), [false, false]);

console.log('RECIPE EM DASH PARSER QA: 18 assertions passed');
