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
const execute = new Function('path', 'method', 'input', 'portalPermissions', 'hasPortalPermission', 'demoState', 'demoSave', 'portalUser', 'demoAllocatePremixConsumption', `${parserSource}\nreturn (async () => { ${routeSource} })();`);
const produce = (state, payload) => { const permissions = new Set(['inventory']); return execute('/api/inventory/premixes/produce', 'POST', payload, permissions, (permission) => permissions.has(permission), state, () => { state.saved = (state.saved || 0) + 1; }, { name: 'QA' }, () => []); };
const stateFor = (recipe, inventory) => ({ recipes: [recipe], inventory, premixBatches: [], movements: [], audit: [] });

const itemRouteStart = portal.indexOf("if (path === '/api/inventory/items' && method === 'POST')");
const itemRouteEnd = portal.indexOf('\n', itemRouteStart);
assert.ok(itemRouteStart >= 0 && itemRouteEnd > itemRouteStart, 'demo inventory create route must be discoverable');
class FrozenDate extends Date { static now() { return 1234567890; } }
const demoVisibleAlcoholLink = (value) => {
  assert.ok(value === undefined || value === null || value === '', 'this fixture does not exercise alcohol catalog links');
  return null;
};
const createDemoItem = new Function('path', 'method', 'input', 'portalPermissions', 'hasPortalPermission', 'demoState', 'demoSave', 'portalUser', 'Date', 'demoVisibleAlcoholLink', `return (async () => { ${portal.slice(itemRouteStart, itemRouteEnd)} })();`);
const demoItems = { inventory: [], audit: [] };
const demoItemPermissions = new Set(['inventory']);
const demoItemArgs = ['/api/inventory/items', 'POST', { name: 'QA premix source', unit: 'мл' }, demoItemPermissions, (permission) => demoItemPermissions.has(permission), demoItems, () => {}, { name: 'QA' }, FrozenDate, demoVisibleAlcoholLink];
const firstDemoItem = await createDemoItem(...demoItemArgs);
const secondDemoItem = await createDemoItem(...demoItemArgs);
assert.notEqual(firstDemoItem.id, secondDemoItem.id, 'rapid demo inventory creates retain distinct IDs in one millisecond');
assert.equal(demoItems.inventory.length, 2);

// Ingredient quantity is converted into the stock item's unit before debit/costing.
const gramsState = stateFor({ id: 'recipe-g', name: 'Тест, г → кг', recipeType: 'premix', outputIngredientId: 'out-g', ingredients: [{ ingredientId: 'sugar', name: 'Сахар', quantity: '1000 г' }], yieldQuantity: 1, yieldUnit: 'шт' }, [
  { id: 'sugar', name: 'Сахар', unit: 'кг', onHand: 2, cost: 250 },
  { id: 'out-g', name: 'Сироп', unit: 'шт', onHand: 0, cost: 0 },
]);
const gramsBatch = await produce(gramsState, { recipeId: 'recipe-g', outputItemId: 'out-g', multiplier: 1 });
assert.equal(gramsState.inventory[0].onHand, 1, '1000 g must debit exactly 1 kg');
assert.equal(gramsBatch.ingredients[0].quantity, 1);
assert.equal(gramsBatch.ingredients[0].unit, 'кг');
assert.equal(gramsBatch.totalCost, 250, 'cost is based on the converted stock quantity');

// Ingredient debit and batch yield are both converted independently (mL → L).
const litersState = stateFor({ id: 'recipe-ml', name: 'Тест, мл → л', recipeType: 'premix', outputIngredientId: 'out-l', ingredients: [{ ingredientId: 'juice', name: 'Сок', quantity: '500 мл' }], yieldQuantity: 1500, yieldUnit: 'мл' }, [
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
assert.equal(litersState.inventory[1].cost, 34.2857, 'premix output average cost includes prior stock and this batch');
assert.equal(litersBatch.batchUnitCost, 40, 'batch cost per output unit uses converted output quantity');

// A late lot-allocation rejection must not mutate stock, output cost, audit or persistence.
const expiredState = stateFor({ id: 'recipe-expired', name: 'Тест отказа просроченного сырья', recipeType: 'premix', outputIngredientId: 'out-expired', ingredients: [{ ingredientId: 'expired-source', name: 'Сырьё', quantity: '1 мл' }], yieldQuantity: 100, yieldUnit: 'мл' }, [
  { id: 'expired-source', name: 'Сырьё', unit: 'мл', onHand: 2, cost: 20 },
  { id: 'out-expired', name: 'Премикс', unit: 'мл', onHand: 100, cost: 10 },
]);
await assert.rejects(produce(expiredState, { recipeId: 'recipe-expired', outputItemId: 'out-expired', multiplier: 1 }, () => { throw new Error('expired_premix_stock'); }), /expired_premix_stock/);
assert.deepEqual(expiredState.inventory.map((item) => item.onHand), [2, 100], 'rejected expired lot changes no ingredient or output stock');
assert.equal(expiredState.inventory[1].cost, 10, 'rejected expired lot leaves output average cost unchanged');
assert.equal(expiredState.movements.length, 0);
assert.equal(expiredState.premixBatches.length, 0);
assert.equal(expiredState.audit.length, 0);
assert.equal(expiredState.saved || 0, 0, 'rejected expired lot is not persisted');

// Incompatible units fail closed before stock, output, audit, or batch mutation.
const mismatchState = stateFor({ id: 'recipe-bad', name: 'Тест несовместимых единиц', recipeType: 'premix', outputIngredientId: 'out-bad', ingredients: [{ ingredientId: 'powder', name: 'Порошок', quantity: '2 шт' }], yieldQuantity: 1, yieldUnit: 'л' }, [
  { id: 'powder', name: 'Порошок', unit: 'кг', onHand: 4, cost: 30 },
  { id: 'out-bad', name: 'Жидкость', unit: 'л', onHand: 0, cost: 0 },
]);
await assert.rejects(produce(mismatchState, { recipeId: 'recipe-bad', outputItemId: 'out-bad', multiplier: 1 }), /recipe_ingredient_unit_mismatch/);
const wrongOutputState = stateFor({ id: 'recipe-bound', name: 'Закреплённый выход', recipeType: 'premix', outputIngredientId: 'out-l', ingredients: [] }, [{ id: 'out-l', name: 'Премикс', unit: 'л', onHand: 0, cost: 0 }, { id: 'other-output', name: 'Другой выход', unit: 'л', onHand: 0, cost: 0 }]);
await assert.rejects(produce(wrongOutputState, { recipeId: 'recipe-bound', outputItemId: 'other-output', multiplier: 1 }), /premix_output_binding_mismatch/);
assert.deepEqual(wrongOutputState.inventory.map((item) => item.onHand), [0, 0], 'a forged output binding is rejected before mutation');
assert.deepEqual(mismatchState.inventory.map((item) => item.onHand), [4, 0]);
assert.equal(mismatchState.premixBatches.length, 0);
assert.equal(mismatchState.audit.length, 0);
assert.equal(mismatchState.saved || 0, 0, 'invalid unit input must not persist a partial production');

console.log('DEMO PREMIX UNIT RUNTIME QA: PASS (g→kg costing/debit; mL→L ingredient and yield; incompatible unit fails closed without mutation)');
