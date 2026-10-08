import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const child = spawn(process.execPath, ['server.js'], {
  cwd: root,
  env: { ...process.env, PORT: '0', HOST: '127.0.0.1', DATABASE_URL: '', DEMO_MODE: 'true', AUTH_REQUIRED: 'false', NODE_ENV: 'test' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
child.stderr.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
let base;
try {
  const until = Date.now() + 15000;
  while (!base && Date.now() < until) {
    const match = output.match(/CRM running on http:\/\/localhost:(\d+)/);
    if (match) base = `http://127.0.0.1:${match[1]}`;
    else if (child.exitCode !== null) throw new Error(`QA server exited early:\n${output}`);
    else await delay(50);
  }
  assert.ok(base, `isolated QA server starts; output: ${output}`);
  let checks = 0;
  async function req(url, method = 'GET', data, expected = 200, token = null) {
    const response = await fetch(`${base}${url}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: data === undefined ? undefined : JSON.stringify(data) });
    const result = await response.json();
    assert.equal(response.status, expected, `${method} ${url}: ${JSON.stringify(result)}`);
    checks++;
    return result;
  }
  const staffSession = await req('/api/login', 'POST', { username: 'staff', password: 'demo' });
  const staffToken = staffSession.token;
  let floorZoneId = null;
  let floorVenueId = null;
  async function createTableId(label) {
    if (!floorZoneId) {
      const floor = await req('/api/floor'); floorVenueId = floor.venueId; floorZoneId = floor.zones?.[0]?.id || null;
      if (!floorZoneId) floorZoneId = (await req('/api/floor/zones', 'POST', { name: `QA ${Date.now()}`, expectedVenueId: floorVenueId }, 201)).id;
    }
    return (await req('/api/floor/tables', 'POST', { zoneId: floorZoneId, expectedVenueId: floorVenueId, name: `QA ${label} ${Date.now()} ${Math.random().toString(36).slice(2,7)}`, capacity: 2 }, 201)).id;
  }
  const health = await req('/api/health');
  assert.equal(health.database, 'memory', 'runtime test exercises the actual isolated in-memory API path'); checks++;
  const openedShift = await req('/api/shifts', 'POST', { openingCash: 0 }, 201);

  const mixedUnitSource = await req('/api/inventory/items', 'POST', { name: 'QA premix mixed-unit source', unit: 'л', itemType: 'ingredient', cost: 10 }, 201);
  const mixedUnitOutput = await req('/api/inventory/items', 'POST', { name: 'QA premix mixed-unit output', unit: 'порция', itemType: 'ingredient', cost: 0 }, 201);
  await req('/api/inventory/movements', 'POST', { itemId: mixedUnitSource.id, delta: 1, unit: 'л', reason: 'Premix mixed-unit regression fixture' }, 201);
  const mixedUnitRecipe = await req('/api/recipes', 'POST', {
    name: 'QA mixed-unit duplicate premix', recipeType: 'premix', yieldQuantity: 1, yieldUnit: 'порция', portionCount: 1,
    ingredients: [
      { ingredientId: mixedUnitSource.id, name: mixedUnitSource.name, quantity: '500 мл' },
      { ingredientId: mixedUnitSource.id, name: mixedUnitSource.name, quantity: '0.5 л' },
    ],
  }, 201);
  const mixedUnitBatch = await req('/api/inventory/premixes/produce', 'POST', { recipeId: mixedUnitRecipe.id, outputItemId: mixedUnitOutput.id, multiplier: 1 }, 201);
  assert.equal(mixedUnitBatch.recipeName, mixedUnitRecipe.name, 'produced memory batch includes the readable recipe name');
  const mixedUnitHistory = await req('/api/inventory/premixes');
  assert.equal(mixedUnitHistory.items.find((item) => item.id === mixedUnitBatch.id)?.recipeName, mixedUnitRecipe.name, 'read-only batch history retains the readable recipe name'); checks += 2;
  assert.equal(mixedUnitBatch.ingredients.length, 1, 'compatible duplicate lines aggregate to one stock debit');
  assert.equal(mixedUnitBatch.ingredients[0].quantity, 1, '500 ml + 0.5 l aggregates as 1 l in the stock item unit');
  assert.equal(mixedUnitBatch.totalCost, 10, 'aggregated mixed-unit ingredients are costed once at stock-unit cost'); checks += 3;
  const afterMixedPremix = await req('/api/inventory');
  assert.equal(afterMixedPremix.items.find((item) => item.id === mixedUnitSource.id).onHand, 0, 'mixed-unit premix debit matches the aggregated stock quantity'); checks++;

  const premixSource = await req('/api/inventory/items', 'POST', { name: 'QA premix duplicate source', unit: 'л', itemType: 'ingredient', cost: 10 }, 201);
  const premixOutput = await req('/api/inventory/items', 'POST', { name: 'QA premix duplicate output', unit: 'порция', itemType: 'ingredient', cost: 0 }, 201);
  await req('/api/inventory/movements', 'POST', { itemId: premixSource.id, delta: 1, unit: 'л', reason: 'Premix duplicate regression fixture' }, 201);
  const premixRecipe = await req('/api/recipes', 'POST', {
    name: 'QA duplicate ingredient premix', recipeType: 'premix', yieldQuantity: 1, yieldUnit: 'порция', portionCount: 1,
    ingredients: [
      { ingredientId: premixSource.id, name: premixSource.name, quantity: '0.75 л' },
      { ingredientId: premixSource.id, name: premixSource.name, quantity: '0.75 л' },
    ],
  }, 201);
  const overdraw = await req('/api/inventory/premixes/produce', 'POST', { recipeId: premixRecipe.id, outputItemId: premixOutput.id, multiplier: 1 }, 409);
  assert.equal(overdraw.error, 'insufficient_premix_stock', 'duplicate recipe lines are validated after quantities are aggregated'); checks++;
  const premixInventory = await req('/api/inventory');
  assert.equal(premixInventory.items.find((item) => item.id === premixSource.id).onHand, 1, 'rejected premix production leaves source stock unchanged');
  assert.equal(premixInventory.items.find((item) => item.id === premixOutput.id).onHand, 0, 'rejected premix production leaves output stock unchanged'); checks += 2;

  const stockItem = await req('/api/inventory/items', 'POST', { name: 'QA recipe stock', unit: 'мл', itemType: 'ingredient', cost: 0.01 }, 201);
  await req('/api/inventory/movements', 'POST', { itemId: stockItem.id, delta: 1000, unit: 'мл', reason: 'Recipe runtime QA supply' }, 201);
  const product = await req('/api/products', 'POST', { name: `QA recipe sale ${Date.now()}`, category: 'bar', price: 100 }, 201);
  await req('/api/recipes', 'POST', { productId: product.id, name: product.name, ingredients: [], yieldQuantity: 1, yieldUnit: 'порция', portionCount: 1 }, 400);
  const saleRecipe = await req('/api/recipes', 'POST', { productId: product.id, name: product.name, ingredients: [{ ingredientId: stockItem.id, name: stockItem.name, quantity: '1 л' }], yieldQuantity: 1, yieldUnit: 'порция', portionCount: 1 }, 201);
  const invalidRecipeRebind = await req(`/api/recipes/${saleRecipe.id}`, 'PATCH', { recipeType: 'premix' }, 400);
  assert.equal(invalidRecipeRebind.error, 'premix_product_binding_not_allowed', 'memory mode rejects turning a product-bound sale recipe into a premix'); checks++;
  const unchangedSaleRecipe = (await req('/api/recipes')).items.find((item) => item.id === saleRecipe.id);
  assert.equal(unchangedSaleRecipe.recipeType, 'sale', 'rejected sale-to-premix edit leaves the linked sale recipe unchanged'); checks++;
  await req('/api/recipes', 'POST', { productId: product.id, name: 'QA incompatible unit', ingredients: [{ ingredientId: stockItem.id, name: stockItem.name, quantity: '1 кг' }], yieldQuantity: 1, yieldUnit: 'порция', portionCount: 1 }, 400);

  async function createOrder(label = 'sale') {
    const order = await req('/api/orders', 'POST', { tableId: await createTableId(label) }, 201);
    await req(`/api/orders/${order.id}/items`, 'POST', { productId: product.id, quantity: 1 }, 201, staffToken);
    return order.id;
  }
  const successfulOrderId = await createOrder('successful-sale');
  const close = await req(`/api/orders/${successfulOrderId}/close`, 'POST', { paymentMethod: 'cash' });
  assert.equal(close.status, 'closed'); assert.equal(close.costOfGoods, 10, '1 l recipe cost is calculated from 1000 ml at 0.01 per ml'); checks += 2;
  const afterSale = await req('/api/inventory');
  assert.equal(afterSale.items.find((item) => item.id === stockItem.id).onHand, 0, 'sale depletes linked inventory after valid conversion'); checks++;
  const analytics = await req('/api/analytics?days=7');
  assert.equal(analytics.totalCostOfGoods, 10, 'memory analytics preserve the stored cost of goods after sale');
  assert.equal(analytics.netProfit, null, 'memory analytics do not assert full profit without a payroll ledger');
  assert.equal(analytics.days.reduce((sum, day) => sum + day.costOfGoods, 0), 10, 'daily cost of goods matches the aggregate');
  assert.ok(analytics.days.every((day) => day.netProfit === null && day.payroll === null), 'daily payroll and full profit remain unknown without the ledger'); checks += 4;

  const rejectedOrderId = await createOrder('rejected-sale');
  const rejectedClose = await req(`/api/orders/${rejectedOrderId}/close`, 'POST', { paymentMethod: 'cash' }, 409);
  assert.equal(rejectedClose.error, 'insufficient_recipe_stock'); checks++;
  const openOrder = (await req('/api/orders')).items.find((entry) => entry.id === rejectedOrderId);
  assert.equal(openOrder.status, 'open', 'failed depletion does not close the order'); checks++;
  assert.equal((await req(`/api/orders/${rejectedOrderId}/payments`)).items.length, 0, 'failed depletion records no payment'); checks++;
  assert.equal((await req('/api/inventory')).items.find((item) => item.id === stockItem.id).onHand, 0, 'failed depletion leaves stock unchanged'); checks++;

  const unmappedProduct = await req('/api/products', 'POST', { name: `QA no-recipe tracked ${Date.now()}`, category: 'bar', price: 100 }, 201);
  assert.equal(unmappedProduct.inventoryMode, 'tracked', 'new catalog item explicitly defaults to stock tracking'); checks++;
  const unmappedOrder = await req('/api/orders', 'POST', { tableId: await createTableId('unmapped') }, 201);
  await req(`/api/orders/${unmappedOrder.id}/items`, 'POST', { productId: unmappedProduct.id, quantity: 1 }, 201, staffToken);
  const blockedClose = await req(`/api/orders/${unmappedOrder.id}/close`, 'POST', { paymentMethod: 'cash' }, 409);
  assert.equal(blockedClose.error, 'product_recipe_required', 'tracked product cannot close without a linked recipe'); checks++;
  assert.equal((await req('/api/orders')).items.find((entry) => entry.id === unmappedOrder.id).status, 'open', 'missing-recipe close preserves the open order'); checks++;
  await req(`/api/orders/${unmappedOrder.id}/payments`, 'POST', { amount: 50, method: 'cash' }, 201);
  const blockedFinalPayment = await req(`/api/orders/${unmappedOrder.id}/payments`, 'POST', { amount: 50, method: 'cash' }, 409);
  assert.equal(blockedFinalPayment.error, 'product_recipe_required', 'final installment is rejected until recipe exists'); checks++;
  assert.equal((await req(`/api/orders/${unmappedOrder.id}/payments`)).items.length, 1, 'failed final installment rolls back the attempted payment'); checks++;
  const nonStockProduct = await req('/api/products', 'POST', { name: `QA service item ${Date.now()}`, category: 'Услуги', price: 100, inventoryMode: 'non_stock' }, 201);
  const nonStockOrder = await req('/api/orders', 'POST', { tableId: await createTableId('non-stock') }, 201);
  await req(`/api/orders/${nonStockOrder.id}/items`, 'POST', { productId: nonStockProduct.id, quantity: 1 }, 201, staffToken);
  const nonStockClose = await req(`/api/orders/${nonStockOrder.id}/close`, 'POST', { paymentMethod: 'cash' }, 200);
  assert.equal(nonStockClose.status, 'closed'); assert.equal(nonStockClose.costOfGoods, 0, 'explicit non-stock service can close without recipe COGS'); checks += 2;
  const reviewProduct = await req('/api/products', 'POST', { name: `QA review item ${Date.now()}`, category: 'bar', price: 100 }, 201);
  await req(`/api/products/${reviewProduct.id}`, 'PATCH', { inventoryMode: 'needs_review' }, 200);
  const reviewOrder = await req('/api/orders', 'POST', { tableId: await createTableId('review') }, 201);
  await req(`/api/orders/${reviewOrder.id}/items`, 'POST', { productId: reviewProduct.id, quantity: 1 }, 201, staffToken);
  const blockedReviewClose = await req(`/api/orders/${reviewOrder.id}/close`, 'POST', { paymentMethod: 'cash' }, 409);
  assert.equal(blockedReviewClose.error, 'product_inventory_mode_required', 'unclassified legacy product cannot close as a zero-cost sale'); checks++;
  assert.equal((await req('/api/inventory')).items.find((item) => item.id === stockItem.id).onHand, 0, 'review/missing-recipe attempts do not change stock'); checks++;

  const shiftClose = await req(`/api/shifts/${openedShift.id}/close`, 'POST', { closingCash: 250, checklist: { version: 1, items: { ordersReviewed: true, cashCounted: true, inventoryReviewed: true, externalFiscalReportsHandled: true } } });
  assert.equal(shiftClose.expectedCash, 250, 'expected cash includes cash payments recorded in the open shift');
  assert.equal(shiftClose.cashVariance, 0, 'cash reconciliation matches opening float plus attributed cash sales'); checks += 2;

  console.log(`RECIPE DEPLETION RUNTIME QA: ${checks} checks passed (memory API: explicit tracked/non-stock/review modes, missing recipe close/final-payment rollback, mixed-unit premix, sales depletion, COGS/profit and cash reconciliation; PostgreSQL requires a separate test server)`);
} finally {
  child.kill();
  await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(3000)]);
}
