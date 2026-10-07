import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertQaDatabaseIdentity, validateQaDatabaseUrl } from './postgres-qa-safety.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = validateQaDatabaseUrl(process.env.RECIPE_COST_BREAKDOWN_TEST_DATABASE_URL, 'RECIPE_COST_BREAKDOWN_TEST_DATABASE_URL');
assert.match(target.database, /^inventory_qa_[a-f0-9]{16}$/i, 'recipe cost browser QA requires a runner-created random inventory database');
assert.equal(target.database, process.env.LOCAL_FULL_PG_OWNED_DATABASE, 'only the local regression runner may own this disposable database');
const playwrightPath = process.env.PLAYWRIGHT_PACKAGE_PATH;
if (!playwrightPath) throw new Error('local PostgreSQL runner must provide the configured Playwright package');
const { chromium } = createRequire(import.meta.url)(playwrightPath);
const { Client } = createRequire(import.meta.url)('pg');
const client = new Client({ connectionString: target.url.href, connectionTimeoutMillis: 5000 });
const organizationId = randomUUID();
const venueId = randomUUID();
const ownerId = randomUUID();
const password = 'recipe-cost-breakdown-qa-password';
let server;
let serverOutput = '';
let browser;
let checks = 0;

function passwordHash() {
  const salt = randomBytes(16).toString('hex');
  return `scrypt$${salt}$${scryptSync(password, salt, 64).toString('hex')}`;
}

async function request(context, base, token, route, method = 'GET', body, expectedStatus = 200) {
  const response = await context.request.fetch(`${base}${route}`, {
    method,
    data: body,
    headers: { Authorization: `Bearer ${token}`, 'X-Organization-Id': organizationId },
  });
  const payload = await response.json();
  assert.equal(response.status(), expectedStatus, `${method} ${route}: ${JSON.stringify(payload)}`);
  checks++;
  return payload;
}

try {
  await client.connect();
  const identity = (await client.query(`SELECT current_database() AS database,inet_server_addr()::text AS address,
    inet_server_port() AS port,COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname=current_user),false) AS superuser`)).rows[0];
  assertQaDatabaseIdentity(identity, target.database, Number(target.url.port || 5432), 'recipe cost browser QA target');

  await client.query('INSERT INTO organizations(id,name,slug,timezone) VALUES($1,$2,$3,$4)', [organizationId, 'Recipe cost browser QA', `recipe-cost-${organizationId}`, 'Asia/Yekaterinburg']);
  await client.query("INSERT INTO organization_subscriptions(organization_id,status) VALUES($1,'trialing')", [organizationId]);
  await client.query('INSERT INTO venues(id,organization_id,name,timezone) VALUES($1,$2,$3,$4)', [venueId, organizationId, 'Recipe cost browser QA venue', 'Asia/Yekaterinburg']);
  await client.query("INSERT INTO inventory_departments(venue_id,code,name) VALUES($1,'hookah','Кальянный цех') ON CONFLICT(venue_id,code) DO UPDATE SET name=EXCLUDED.name", [venueId]);
  await client.query("INSERT INTO users(id,organization_id,venue_id,full_name,login,password_hash,role) VALUES($1,$2,$3,'QA owner',$4,$5,'owner')", [ownerId, organizationId, venueId, `recipe-cost-owner-${venueId}`, passwordHash()]);
  await client.query("INSERT INTO organization_memberships(organization_id,user_id,membership_role,status) VALUES($1,$2,'owner','active')", [organizationId, ownerId]);

  server = spawn(process.execPath, ['server.js'], {
    cwd: root,
    windowsHide: true,
    env: { ...process.env, PORT: '0', HOST: '127.0.0.1', DATABASE_URL: target.url.href,
      VENUE_ID: venueId, AUTH_REQUIRED: 'true', NODE_ENV: 'test', API_RATE_LIMIT: '5000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.setEncoding('utf8').on('data', chunk => { serverOutput += chunk; });
  server.stderr.setEncoding('utf8').on('data', chunk => { serverOutput += chunk; });
  let base;
  const until = Date.now() + 20000;
  while (!base && Date.now() < until) {
    const match = serverOutput.match(/CRM running on http:\/\/localhost:(\d+)/);
    if (match) base = `http://127.0.0.1:${match[1]}`;
    else if (server.exitCode !== null) throw new Error(`isolated QA API server exited early: ${serverOutput}`);
    else await delay(50);
  }
  assert.ok(base, `isolated PostgreSQL API server starts: ${serverOutput}`); checks++;

  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ru-RU', reducedMotion: 'reduce' });
  const page = await context.newPage();
  const pageErrors = [];
  const failedApiResponses = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('response', response => {
    if (response.url().includes('/api/') && response.status() >= 400 && !(response.url().endsWith('/api/session') && response.status() === 401)) {
      failedApiResponses.push(`${response.status()} ${response.url()}`);
    }
  });

  await page.goto(`${base}/login`, { waitUntil: 'networkidle' });
  await page.locator('#login-username').fill(`recipe-cost-owner-${venueId}`);
  await page.locator('#login-password').fill(password);
  await page.locator('#login-form button[type="submit"]').click();
  await page.waitForURL(url => !url.pathname.includes('/login'), { timeout: 10000 });
  const token = await page.evaluate(() => localStorage.getItem('crm_session_token'));
  assert.ok(token, 'synthetic owner has an authenticated session'); checks++;

  const category = await request(context, base, token, '/api/product-categories', 'POST', {
    name: `QA recipe category ${venueId.slice(0, 8)}`, department: 'hookah',
  }, 201);
  const ingredient = await request(context, base, token, '/api/inventory/items', 'POST', {
    name: `QA bottle ingredient ${venueId.slice(0, 8)}`, unit: 'мл', purchaseUnit: 'бутылка', packMultiplier: 700,
    itemType: 'ingredient', cost: 1.8, department: 'hookah', category: category.name, categoryId: category.id,
  }, 201);
  const secondIngredient = await request(context, base, token, '/api/inventory/items', 'POST', {
    name: `QA syrup ingredient ${venueId.slice(0, 8)}`, unit: 'мл', purchaseUnit: 'флакон', packMultiplier: 500,
    itemType: 'ingredient', cost: 0.8, department: 'hookah', category: category.name, categoryId: category.id,
  }, 201);
  const gramIngredient = await request(context, base, token, '/api/inventory/items', 'POST', {
    name: `QA gram ingredient ${venueId.slice(0, 8)}`, unit: 'г', purchaseUnit: 'кг', packMultiplier: 1000,
    itemType: 'ingredient', cost: 0.42, department: 'hookah', category: category.name, categoryId: category.id,
  }, 201);
  const pieceIngredient = await request(context, base, token, '/api/inventory/items', 'POST', {
    name: `QA piece ingredient ${venueId.slice(0, 8)}`, unit: 'шт', itemType: 'ingredient', cost: 18,
    department: 'hookah', category: category.name, categoryId: category.id,
  }, 201);
  const product = await request(context, base, token, '/api/products', 'POST', {
    name: `QA recipe drink ${venueId.slice(0, 8)}`, category: 'Напитки', price: 600,
  }, 201);
  const overflowQuantity = `${'9'.repeat(309)} г`;
  const createOverflow = await request(context, base, token, '/api/recipes', 'POST', {
    name: `QA invalid overflow recipe ${venueId.slice(0, 8)}`,
    ingredients: [{ ingredientId: gramIngredient.id, name: gramIngredient.name, quantity: overflowQuantity }],
  }, 400);
  assert.equal(createOverflow.error, 'invalid_recipe_quantity', 'non-finite recipe amount is rejected'); checks++;
  const conversionOverflow = await request(context, base, token, '/api/recipes', 'POST', {
    name: `QA invalid conversion overflow ${venueId.slice(0, 8)}`,
    ingredients: [{ ingredientId: gramIngredient.id, name: gramIngredient.name, quantity: `${'1'}${'0'.repeat(307)} кг` }],
  }, 400);
  assert.equal(conversionOverflow.error, 'invalid_recipe_quantity', 'finite amount that overflows during unit conversion is rejected'); checks++;
  const costOverflow = await request(context, base, token, '/api/recipes', 'POST', {
    name: `QA invalid cost overflow ${venueId.slice(0, 8)}`,
    ingredients: [{ ingredientId: ingredient.id, name: ingredient.name, quantity: `${'1'}${'7'.repeat(308)} мл` }],
  }, 400);
  assert.equal(costOverflow.error, 'invalid_recipe_quantity', 'finite amount that overflows line-cost calculation is rejected'); checks++;
  const recipesAfterRejectedCreate = await request(context, base, token, '/api/recipes');
  assert.equal(recipesAfterRejectedCreate.items.length, 0, 'rejected recipe quantities do not persist a recipe'); checks++;
  const recipe = await request(context, base, token, '/api/recipes', 'POST', {
    productId: product.id, name: product.name,
    ingredients: [
      { ingredientId: ingredient.id, name: ingredient.name, quantity: '0.2 л' },
      { ingredientId: secondIngredient.id, name: secondIngredient.name, quantity: '30 мл' },
      { ingredientId: gramIngredient.id, name: gramIngredient.name, quantity: '0.012 кг' },
      { ingredientId: pieceIngredient.id, name: pieceIngredient.name, quantity: '2 шт' },
    ],
    yieldQuantity: 1, yieldUnit: 'порция', portionCount: 1,
  }, 201);
  const rejectedUpdate = await request(context, base, token, `/api/recipes/${recipe.id}`, 'PATCH', {
    ingredients: [{ ingredientId: gramIngredient.id, name: gramIngredient.name, quantity: overflowQuantity }],
  }, 400);
  assert.equal(rejectedUpdate.error, 'invalid_recipe_quantity', 'non-finite recipe amount is rejected on update'); checks++;
  const recipesAfterRejectedUpdate = await request(context, base, token, '/api/recipes');
  const recipeAfterRejectedUpdate = recipesAfterRejectedUpdate.items.find(item => item.id === recipe.id);
  assert.equal(recipeAfterRejectedUpdate.ingredients[0].quantity, '0.2 л', 'rejected update leaves the saved recipe unchanged'); checks++;
  const cost = await request(context, base, token, `/api/recipes/${recipe.id}/cost`);
  const line = cost.lines[0];
  assert.equal(cost.lines.length, 4, 'all four synthetic ingredients are saved on the recipe'); checks++;
  assert.equal(Number(line.recipeQuantity), 0.2, 'cost DTO retains the original recipe quantity'); checks++;
  assert.equal(line.recipeUnit, 'л', 'cost DTO retains the original recipe unit'); checks++;
  assert.equal(Number(line.quantity), 200, 'cost DTO also returns normalized stock quantity'); checks++;
  assert.equal(line.unit, 'мл', 'normalized quantity carries the stock unit'); checks++;
  assert.equal(Number(line.unitCost), 1.8, 'normalized unit price is current stock cost'); checks++;
  assert.equal(line.purchaseUnit, 'бутылка', 'current procurement unit is present'); checks++;
  assert.equal(Number(line.packMultiplier), 700, 'current procurement conversion factor is present'); checks++;
  assert.equal(Number(line.packageEquivalentCost), 1260, 'package equivalent is derived from current average cost'); checks++;
  assert.equal(Number(line.cost), 360, 'first line contribution uses normalized quantity and current unit cost'); checks++;
  assert.equal(Number(cost.lines[1].cost), 24, 'second line contribution uses its own current unit cost'); checks++;
  assert.equal(Number(cost.lines[2].recipeQuantity), 0.012, 'gram component retains its kilogram recipe quantity'); checks++;
  assert.equal(cost.lines[2].recipeUnit, 'кг', 'gram component retains its recipe unit'); checks++;
  assert.equal(Number(cost.lines[2].quantity), 12, 'kilogram recipe quantity normalizes to 12 stock grams'); checks++;
  assert.equal(Number(cost.lines[2].cost), 5.04, 'gram component uses normalized quantity and current gram cost'); checks++;
  assert.equal(Number(cost.lines[3].quantity), 2, 'piece component keeps two stock units'); checks++;
  assert.equal(Number(cost.lines[3].cost), 36, 'piece component uses its own current unit cost'); checks++;
  assert.equal(Number(cost.totalCost), 425.04, 'recipe total equals all four rounded line contributions'); checks++;
  assert.equal(Number(cost.costPerPortion), 425.04, 'per-portion cost includes every component'); checks++;

  await page.goto(`${base}/inventory?view=recipes`, { waitUntil: 'networkidle' });
  const card = page.locator(`[data-recipe-card="${recipe.id}"]`);
  await card.waitFor({ state: 'visible' });
  const detail = card.locator('.recipe-card-cost');
  await detail.getByText('Текущая себестоимость:', { exact: false }).waitFor({ state: 'visible', timeout: 10000 });
  await page.waitForFunction((id) => document.querySelector(`[data-recipe-card="${id}"] .recipe-card-cost`)?.innerText.includes('Расчётная стоимость фасовки'), recipe.id);
  const visibleBreakdown = (await detail.innerText()).replace(/\s+/g, ' ');
  assert.match(visibleBreakdown, /0[,.]2 л/, 'saved recipe card shows the recipe quantity and unit'); checks++;
  assert.match(visibleBreakdown, /Для расчёта: 200 мл/, 'saved recipe card shows the normalized stock quantity'); checks++;
  assert.match(visibleBreakdown, /Закупочная фасовка: бутылка = 700 мл/, 'saved recipe card shows procurement unit and factor'); checks++;
  assert.match(visibleBreakdown, /Расчётная стоимость фасовки по текущей средней себестоимости: 1\s?260/, 'saved recipe card labels package value as derived from current average cost'); checks++;
  assert.match(visibleBreakdown, /складская единица: 1[,.]8(?:0)? ₽\/мл/, 'saved recipe card shows normalized stock-unit price'); checks++;
  assert.match(visibleBreakdown, /360/, 'saved recipe card shows first line contribution'); checks++;
  assert.match(visibleBreakdown, /QA Syrup Ingredient .*30 мл\s*Для расчёта: 30 мл\s*Закупочная фасовка: флакон = 500 мл/, 'saved recipe card shows the second ingredient line and its normalized quantity'); checks++;
  assert.match(visibleBreakdown, /QA Gram Ingredient .*0[,.]012 кг\s*Для расчёта: 12 г/, 'saved recipe card shows kilogram-to-gram normalization for another component'); checks++;
  assert.match(visibleBreakdown, /QA Piece Ingredient .*2 шт\s*Для расчёта: 2 шт/, 'saved recipe card shows the piece component'); checks++;
  assert.match(visibleBreakdown, /425[,.]04/, 'saved recipe card shows the total from all four components'); checks++;
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'recipe detail fits the 390px viewport without horizontal overflow'); checks++;

  await card.locator('[data-recipe-edit]').click();
  await page.waitForFunction((id) => document.querySelector('#recipe-id')?.value === id, recipe.id);
  await page.waitForFunction((id) => [...(document.querySelector('#recipe-ingredient-select')?.options || [])].some(option => option.value === id), ingredient.id);
  await page.locator('[data-recipe-step="4"]').click();
  const preview = page.locator('#recipe-cost-lines');
  await preview.locator('.recipe-cost-line').first().waitFor({ state: 'visible' });
  const visiblePreview = (await preview.innerText()).replace(/\s+/g, ' ');
  assert.match(visiblePreview, /Закупочная фасовка: бутылка = 700 мл/, 'wizard preview shows the same current procurement factor'); checks++;
  assert.match(visiblePreview, /Расчётная стоимость фасовки по текущей средней себестоимости: 1\s?260/, 'wizard preview explains package-equivalent cost'); checks++;
  assert.match(visiblePreview, /1[,.]8(?:0)? ₽\/мл/, 'wizard preview shows normalized stock-unit price'); checks++;
  assert.match(visiblePreview, /Для расчёта: 200 мл/, 'wizard preview shows normalized stock quantity'); checks++;
  assert.match(visiblePreview, /360/, 'wizard preview shows the recipe line contribution'); checks++;
  assert.match(visiblePreview, /QA Syrup Ingredient .*30 мл\s*Для расчёта: 30 мл/, 'wizard preview shows the second ingredient line'); checks++;
  assert.match(visiblePreview, /QA Gram Ingredient .*0[,.]012 кг\s*Для расчёта: 12 г/, 'wizard preview shows the normalized gram component'); checks++;
  assert.match(visiblePreview, /QA Piece Ingredient .*2 шт\s*Для расчёта: 2 шт/, 'wizard preview shows the piece component'); checks++;
  assert.match(await page.locator('#recipe-total-cost').innerText(), /425[,.]04/, 'wizard preview total matches the four-component saved cost endpoint'); checks++;

  // Changing the procurement factor after saving must update only its derived package equivalent.
  const inventoryBeforeFactorChange = await request(context, base, token, '/api/inventory');
  const ingredientBeforeFactorChange = inventoryBeforeFactorChange.items.find(item => item.id === ingredient.id);
  assert.ok(ingredientBeforeFactorChange, 'saved recipe ingredient is present in venue inventory'); checks++;
  const movementsBeforeFactorChange = inventoryBeforeFactorChange.movements.length;
  assert.equal(Number(ingredientBeforeFactorChange.onHand), 0, 'factor-change fixture starts without stock'); checks++;
  await request(context, base, token, `/api/inventory/items/${ingredient.id}`, 'PATCH', { packMultiplier: 500 });
  const updatedCost = await request(context, base, token, `/api/recipes/${recipe.id}/cost`);
  const updatedLine = updatedCost.lines[0];
  assert.equal(Number(updatedLine.recipeQuantity), 0.2, 'saved recipe quantity remains 0.2 after procurement factor change'); checks++;
  assert.equal(Number(updatedLine.quantity), 200, 'normalized recipe quantity remains 200ml after procurement factor change'); checks++;
  assert.equal(Number(updatedLine.unitCost), 1.8, 'base-unit cost remains unchanged after procurement factor change'); checks++;
  assert.equal(Number(updatedLine.packMultiplier), 500, 'saved recipe cost reads the new procurement factor'); checks++;
  assert.equal(Number(updatedLine.packageEquivalentCost), 900, 'package-equivalent value recalculates from the new factor'); checks++;
  assert.equal(Number(updatedLine.cost), 360, 'saved recipe line contribution remains unchanged'); checks++;
  assert.equal(Number(updatedCost.totalCost), 425.04, 'all-component recipe total remains unchanged after procurement factor change'); checks++;
  await page.goto(`${base}/inventory?view=recipes`, { waitUntil: 'networkidle' });
  const reloadedCard = page.locator(`[data-recipe-card="${recipe.id}"]`);
  await reloadedCard.waitFor({ state: 'visible' });
  const reloadedDetail = reloadedCard.locator('.recipe-card-cost');
  await page.waitForFunction((id) => document.querySelector(`[data-recipe-card="${id}"] .recipe-card-cost`)?.innerText.includes('Закупочная фасовка: бутылка = 500 мл'), recipe.id);
  const reloadedBreakdown = (await reloadedDetail.innerText()).replace(/\s+/g, ' ');
  assert.match(reloadedBreakdown, /0[,.]2 л/, 'reloaded saved recipe card retains original recipe quantity'); checks++;
  assert.match(reloadedBreakdown, /Для расчёта: 200 мл/, 'reloaded saved recipe card retains normalized quantity'); checks++;
  assert.match(reloadedBreakdown, /Расчётная стоимость фасовки по текущей средней себестоимости: 900/, 'reloaded saved recipe card shows recalculated package equivalent'); checks++;
  assert.match(reloadedBreakdown, /складская единица: 1[,.]8(?:0)? ₽\/мл/, 'reloaded saved recipe card retains base-unit cost'); checks++;
  assert.match(reloadedBreakdown, /360/, 'reloaded saved recipe card retains line contribution'); checks++;
  assert.match(reloadedBreakdown, /425[,.]04/, 'reloaded saved recipe card retains all-component recipe total'); checks++;
  const inventoryAfterFactorChange = await request(context, base, token, '/api/inventory');
  const ingredientAfterFactorChange = inventoryAfterFactorChange.items.find(item => item.id === ingredient.id);
  assert.equal(Number(ingredientAfterFactorChange.onHand), Number(ingredientBeforeFactorChange.onHand), 'factor change does not change stock on hand'); checks++;
  assert.equal(inventoryAfterFactorChange.movements.length, movementsBeforeFactorChange, 'factor change does not create stock movements'); checks++;
  await reloadedCard.locator('[data-recipe-edit]').click();
  await page.waitForFunction((id) => document.querySelector('#recipe-id')?.value === id, recipe.id);
  await page.locator('[data-recipe-step="4"]').click();
  await page.locator('#recipe-cost-lines .recipe-cost-line').first().waitFor({ state: 'visible' });
  const refreshedPreview = (await page.locator('#recipe-cost-lines').innerText()).replace(/\s+/g, ' ');
  assert.match(refreshedPreview, /Закупочная фасовка: бутылка = 500 мл/, 'reopened wizard preview shows updated procurement factor'); checks++;
  assert.match(refreshedPreview, /Расчётная стоимость фасовки по текущей средней себестоимости: 900/, 'reopened wizard preview recalculates package equivalent'); checks++;
  assert.match(refreshedPreview, /1[,.]8(?:0)? ₽\/мл/, 'reopened wizard preview retains base-unit cost'); checks++;
  assert.match(refreshedPreview, /Для расчёта: 200 мл/, 'reopened wizard preview retains normalized recipe quantity'); checks++;
  assert.match(refreshedPreview, /360/, 'reopened wizard preview retains recipe line contribution'); checks++;
  assert.match(await page.locator('#recipe-total-cost').innerText(), /425[,.]04/, 'reopened wizard preview retains all-component recipe total'); checks++;
  assert.deepEqual(pageErrors, [], `recipe route has no browser page errors: ${JSON.stringify(pageErrors)}`); checks++;
  assert.deepEqual(failedApiResponses, [], `recipe route has no failed API responses: ${JSON.stringify(failedApiResponses)}`); checks++;

  const screenshotDir = path.join(root, 'tmp', 'full-local-qa');
  await preview.scrollIntoViewIfNeeded();
  await page.waitForTimeout(4500);
  await page.screenshot({ path: path.join(screenshotDir, 'recipe-cost-breakdown-390.png'), fullPage: false });
  console.log(`RECIPE COST BREAKDOWN POSTGRES BROWSER QA: PASS (${checks} checks; 390x844; four recipe components across ml, g and шт; original and normalized quantities, procurement factor, current-average equivalent, unit price, line costs and total; saved card and wizard preview)`);
  await context.close();
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server && server.exitCode === null) {
    server.kill();
    await Promise.race([new Promise(resolve => server.once('exit', resolve)), delay(3000)]);
  }
  if (client._connected) await client.end();
}
