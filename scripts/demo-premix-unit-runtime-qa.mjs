import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const portal = readFileSync(new URL('../portal.js', import.meta.url), 'utf8');
const parserStart = portal.indexOf('const demoRecipeUnitAliases =');
const parserEnd = portal.indexOf('const demoPendingSummary =', parserStart);
const routeStart = portal.indexOf("if (path === '/api/inventory/premixes/produce' && method === 'POST')");
const routeEnd = portal.indexOf("if (path === '/api/products' && method === 'POST')", routeStart);
assert.ok(parserStart >= 0 && parserEnd > parserStart, 'demo unit parser must be discoverable');
assert.ok(routeStart >= 0 && routeEnd > routeStart, 'actual demo premix production route must be discoverable');

const parserSource = portal.slice(parserStart, parserEnd);
const routeSource = portal.slice(routeStart, routeEnd);
const execute = new Function('path', 'method', 'input', 'portalPermissions', 'demoState', 'demoSave', 'portalUser', 'demoAllocatePremixConsumption', `${parserSource}\nreturn (async () => { ${routeSource} })();`);
const produce = (state, payload) => execute('/api/inventory/premixes/produce', 'POST', payload, new Set(['inventory']), state, () => { state.saved = (state.saved || 0) + 1; }, { name: 'QA' }, () => []);
const stateFor = (recipe, inventory) => ({ recipes: [recipe], inventory, premixBatches: [], movements: [], audit: [] });

const itemRouteStart = portal.indexOf("if (path === '/api/inventory/items' && method === 'POST')");
const itemRouteEnd = portal.indexOf('\n', itemRouteStart);
assert.ok(itemRouteStart >= 0 && itemRouteEnd > itemRouteStart, 'demo inventory create route must be discoverable');
class FrozenDate extends Date { static now() { return 1234567890; } }
const demoVisibleAlcoholLink = (value) => {
  assert.ok(value === undefined || value === null || value === '', 'this fixture does not exercise alcohol catalog links');
  return null;
};
const createDemoItem = new Function('path', 'method', 'input', 'portalPermissions', 'demoState', 'demoSave', 'portalUser', 'Date', 'demoVisibleAlcoholLink', `return (async () => { ${portal.slice(itemRouteStart, itemRouteEnd)} })();`);
const demoItems = { inventory: [], audit: [] };
const demoItemArgs = ['/api/inventory/items', 'POST', { name: 'QA premix source', unit: 'мл' }, new Set(['inventory']), demoItems, () => {}, { name: 'QA' }, FrozenDate, demoVisibleAlcoholLink];
const firstDemoItem = await createDemoItem(...demoItemArgs);
const secondDemoItem = await createDemoItem(...demoItemArgs);
assert.notEqual(firstDemoItem.id, secondDemoItem.id, 'rapid demo inventory creates retain distinct IDs in one millisecond');
assert.equal(demoItems.inventory.length, 2);

// Ingredient quantity is converted into the stock item's unit before debit/costing.
const gramsState = stateFor({ id: 'recipe-g', name: 'Тест, г → кг', recipeType: 'premix', ingredients: [{ ingredientId: 'sugar', name: 'Сахар', quantity: '1000 г' }], yieldQuantity: 1, yieldUnit: 'шт' }, [
  { id: 'sugar', name: 'Сахар', unit: 'кг', onHand: 2, cost: 250 },
  { id: 'out-g', name: 'Сироп', unit: 'шт', onHand: 0, cost: 0 },
]);
const gramsBatch = await produce(gramsState, { recipeId: 'recipe-g', outputItemId: 'out-g', multiplier: 1 });
assert.equal(gramsState.inventory[0].onHand, 1, '1000 g must debit exactly 1 kg');
assert.equal(gramsBatch.ingredients[0].quantity, 1);
assert.equal(gramsBatch.ingredients[0].unit, 'кг');
assert.equal(gramsBatch.totalCost, 250, 'cost is based on the converted stock quantity');

// Ingredient debit and batch yield are both converted independently (mL → L).
const litersState = stateFor({ id: 'recipe-ml', name: 'Тест, мл → л', recipeType: 'premix', ingredients: [{ ingredientId: 'juice', name: 'Сок', quantity: '500 мл' }], yieldQuantity: 1500, yieldUnit: 'мл' }, [
  { id: 'juice', name: 'Сок', unit: 'л', onHand: 2, cost: 120 },
  { id: 'out-l', name: 'Премикс', unit: 'л', onHand: 0.25, cost: 0 },
]);
const litersBatch = await produce(litersState, { recipeId: 'recipe-ml', outputItemId: 'out-l', multiplier: 1 });
assert.equal(litersState.inventory[0].onHand, 1.5, '500 mL must debit 0.5 L');
assert.equal(litersBatch.ingredients[0].quantity, 0.5);
assert.equal(litersBatch.totalCost, 60);
assert.equal(litersBatch.outputQuantity, 1.5, '1500 mL yield must be recorded as 1.5 L');
assert.equal(litersState.inventory[1].onHand, 1.75);
assert.equal(litersBatch.outputUnit, 'л');

// Incompatible units fail closed before stock, output, audit, or batch mutation.
const mismatchState = stateFor({ id: 'recipe-bad', name: 'Тест несовместимых единиц', recipeType: 'premix', ingredients: [{ ingredientId: 'powder', name: 'Порошок', quantity: '2 шт' }], yieldQuantity: 1, yieldUnit: 'л' }, [
  { id: 'powder', name: 'Порошок', unit: 'кг', onHand: 4, cost: 30 },
  { id: 'out-bad', name: 'Жидкость', unit: 'л', onHand: 0, cost: 0 },
]);
await assert.rejects(produce(mismatchState, { recipeId: 'recipe-bad', outputItemId: 'out-bad', multiplier: 1 }), /recipe_ingredient_unit_mismatch/);
assert.deepEqual(mismatchState.inventory.map((item) => item.onHand), [4, 0]);
assert.equal(mismatchState.premixBatches.length, 0);
assert.equal(mismatchState.audit.length, 0);
assert.equal(mismatchState.saved || 0, 0, 'invalid unit input must not persist a partial production');

console.log('DEMO PREMIX UNIT RUNTIME QA: PASS (g→kg costing/debit; mL→L ingredient and yield; incompatible unit fails closed without mutation)');
