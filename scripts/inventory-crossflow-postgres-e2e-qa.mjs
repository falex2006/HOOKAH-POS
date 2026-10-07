import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID, randomBytes, scryptSync } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertQaDatabaseIdentity, validateQaDatabaseUrl } from './postgres-qa-safety.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const databaseUrl = process.env.INVENTORY_CROSSFLOW_PG_TEST_DATABASE_URL;
const target = validateQaDatabaseUrl(databaseUrl, 'INVENTORY_CROSSFLOW_PG_TEST_DATABASE_URL');
assert.match(target.database, /^inventory_qa_[a-f0-9]{16}$/i, 'crossflow QA requires a runner-created random inventory database');
assert.equal(target.database, process.env.LOCAL_FULL_PG_OWNED_DATABASE, 'only the local regression runner may own this disposable database');
const { Client } = createRequire(import.meta.url)('pg');
const client = new Client({ connectionString: target.url.href, connectionTimeoutMillis: 5000 });
const organizationId = randomUUID();
const venueId = randomUUID();
const ownerId = randomUUID();
const workerId = randomUUID();
const foreignOrganizationId = randomUUID();
const foreignVenueId = randomUUID();
const foreignOwnerId = randomUUID();
const zoneId = randomUUID();
const tableId = randomUUID();
const password = 'inventory-crossflow-qa-password';
let server;
let serverOutput = '';
let checks = 0;
let ownerToken = '';
let workerToken = '';
let foreignToken = '';

function credentials() {
  const salt = randomBytes(16).toString('hex');
  return `scrypt$${salt}$${scryptSync(password, salt, 64).toString('hex')}`;
}

async function request(base, token, orgId, route, method = 'GET', body, expectedStatus = 200) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(orgId ? { 'X-Organization-Id': orgId } : {}),
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json();
  assert.equal(response.status, expectedStatus, `${method} ${route}: ${JSON.stringify(result)}`);
  checks++;
  return result;
}

async function login(base, loginName, orgId) {
  const result = await request(base, '', orgId, '/api/login', 'POST', { username: loginName, password }, 200);
  assert.ok(result.token, `${loginName} receives an authenticated session`);
  checks++;
  return result;
}

async function balance(ingredientId) {
  const result = await client.query(`SELECT COALESCE(SUM(CASE
    WHEN direction IN ('in','transfer','adjustment') THEN quantity
    WHEN direction IN ('out','waste') THEN -quantity ELSE 0 END),0)::numeric AS balance
    FROM stock_movements WHERE venue_id=$1 AND ingredient_id=$2`, [venueId, ingredientId]);
  return Number(result.rows[0].balance);
}

try {
  await client.connect();
  const identity = (await client.query(`SELECT current_database() AS database,inet_server_addr()::text AS address,
    inet_server_port() AS port,COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname=current_user),false) AS superuser`)).rows[0];
  assertQaDatabaseIdentity(identity, target.database, Number(target.url.port || 5432), 'inventory crossflow QA target');

  await client.query('INSERT INTO organizations(id,name,slug,timezone) VALUES($1,$2,$3,$4)', [organizationId, 'Inventory crossflow QA', `inventory-crossflow-${organizationId}`, 'Asia/Yekaterinburg']);
  await client.query("INSERT INTO organization_subscriptions(organization_id,status) VALUES($1,'trialing')", [organizationId]);
  await client.query('INSERT INTO venues(id,organization_id,name,timezone) VALUES($1,$2,$3,$4)', [venueId, organizationId, 'Inventory crossflow QA venue', 'Asia/Yekaterinburg']);
  await client.query("INSERT INTO inventory_departments(venue_id,code,name) VALUES($1,'hookah','Кальянный цех') ON CONFLICT(venue_id,code) DO UPDATE SET name=EXCLUDED.name", [venueId]);
  await client.query("INSERT INTO users(id,organization_id,venue_id,full_name,login,password_hash,role) VALUES($1,$2,$3,'QA owner',$4,$5,'owner')", [ownerId, organizationId, venueId, `inventory-owner-${venueId}`, credentials()]);
  await client.query("INSERT INTO organization_memberships(organization_id,user_id,membership_role,status) VALUES($1,$2,'owner','active')", [organizationId, ownerId]);
  await client.query("INSERT INTO users(id,organization_id,venue_id,full_name,login,password_hash,role) VALUES($1,$2,$3,'QA hookah worker',$4,$5,'hookah_master')", [workerId, organizationId, venueId, `inventory-worker-${venueId}`, credentials()]);
  await client.query("INSERT INTO organization_memberships(organization_id,user_id,membership_role,status) VALUES($1,$2,'member','active')", [organizationId, workerId]);
  await client.query('INSERT INTO zones(id,venue_id,name) VALUES($1,$2,$3)', [zoneId, venueId, `QA zone ${venueId.slice(0, 8)}`]);
  await client.query("INSERT INTO tables(id,zone_id,name,capacity,status) VALUES($1,$2,'QA table',2,'free')", [tableId, zoneId]);

  await client.query('INSERT INTO organizations(id,name,slug,timezone) VALUES($1,$2,$3,$4)', [foreignOrganizationId, 'Foreign inventory QA', `inventory-crossflow-foreign-${foreignOrganizationId}`, 'Asia/Yekaterinburg']);
  await client.query("INSERT INTO organization_subscriptions(organization_id,status) VALUES($1,'trialing')", [foreignOrganizationId]);
  await client.query('INSERT INTO venues(id,organization_id,name,timezone) VALUES($1,$2,$3,$4)', [foreignVenueId, foreignOrganizationId, 'Foreign inventory QA venue', 'Asia/Yekaterinburg']);
  await client.query("INSERT INTO users(id,organization_id,venue_id,full_name,login,password_hash,role) VALUES($1,$2,$3,'Foreign QA owner',$4,$5,'owner')", [foreignOwnerId, foreignOrganizationId, foreignVenueId, `inventory-foreign-owner-${foreignVenueId}`, credentials()]);
  await client.query("INSERT INTO organization_memberships(organization_id,user_id,membership_role,status) VALUES($1,$2,'owner','active')", [foreignOrganizationId, foreignOwnerId]);

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
  const health = await request(base, '', '', '/api/health');
  assert.equal(health.database, 'postgres', 'scenario is backed by PostgreSQL'); checks++;
  const owner = await login(base, `inventory-owner-${venueId}`, organizationId); ownerToken = owner.token;
  const worker = await login(base, `inventory-worker-${venueId}`, organizationId); workerToken = worker.token;
  const foreign = await login(base, `inventory-foreign-owner-${foreignVenueId}`, foreignOrganizationId); foreignToken = foreign.token;

  const category = await request(base, ownerToken, organizationId, '/api/product-categories', 'POST', {
    name: `QA tobacco category ${venueId.slice(0, 8)}`, department: 'hookah',
  }, 201);
  const renamedCategory = await request(base, ownerToken, organizationId, `/api/product-categories/${category.id}`, 'PATCH', {
    name: `QA tobacco category renamed ${venueId.slice(0, 8)}`, department: 'hookah',
  });
  assert.equal(renamedCategory.name, `QA tobacco category renamed ${venueId.slice(0, 8)}`); checks++;
  const categoryRead = await request(base, ownerToken, organizationId, '/api/product-categories?status=active');
  assert.ok(categoryRead.items.some(item => item.id === category.id && item.name === renamedCategory.name), 'category create/update persists and appears after a fresh catalog read'); checks++;

  const archiveCategory = await request(base, ownerToken, organizationId, '/api/product-categories', 'POST', {
    name: `QA archive category ${venueId.slice(0, 8)}`, department: 'hookah',
  }, 201);
  await request(base, ownerToken, organizationId, `/api/product-categories/${archiveCategory.id}`, 'DELETE', undefined, 200);
  const archivedCategories = await request(base, ownerToken, organizationId, '/api/product-categories?status=archived');
  assert.ok(archivedCategories.items.some(item => item.id === archiveCategory.id && item.active === false), 'category delete archives the unused category and survives a fresh read'); checks++;

  const ingredient = await request(base, ownerToken, organizationId, '/api/inventory/items', 'POST', {
    name: `QA tobacco ${venueId.slice(0, 8)}`, unit: 'г', purchaseUnit: 'пачка', packMultiplier: 100,
    itemType: 'ingredient', cost: 0, department: 'hookah', category: renamedCategory.name, categoryId: category.id,
  }, 201);
  assert.equal(ingredient.categoryId, category.id, 'ingredient stores the category foreign key selected through the API'); checks++;
  const receipt = await request(base, ownerToken, organizationId, '/api/inventory/purchase-documents', 'POST', {
    supplierName: 'Synthetic QA supplier', documentNumber: `QA-${venueId.slice(0, 8)}`,
    lines: [{ ingredientId: ingredient.id, quantity: 1, unit: 'пачка', unitCost: 120 }],
  }, 201);
  const posted = await request(base, ownerToken, organizationId, `/api/inventory/purchase-documents/${receipt.id}/post`, 'POST', {}, 200);
  assert.equal(posted.document.status, 'posted');
  assert.equal(Number(posted.document.lines[0].stockQuantity), 100, 'one 100g pack is received as 100g of stock'); checks += 2;
  const receiptRead = await request(base, ownerToken, organizationId, `/api/inventory/purchase-documents/${receipt.id}`);
  assert.equal(receiptRead.status, 'posted', 'posted receipt persists across a fresh detail read'); checks++;
  const ingredientRead = await request(base, ownerToken, organizationId, '/api/inventory');
  assert.ok(ingredientRead.items.some(item => item.id === ingredient.id && item.categoryId === category.id && Number(item.onHand) === 100), 'fresh stock read retains category link and exact received balance'); checks++;
  assert.equal(await balance(ingredient.id), 100, 'receipt ledger contains the exact 100g balance'); checks++;

  const product = await request(base, ownerToken, organizationId, '/api/products', 'POST', {
    name: `QA hookah product ${venueId.slice(0, 8)}`, category: 'Кальян', price: 500,
  }, 201);
  const recipe = await request(base, ownerToken, organizationId, '/api/recipes', 'POST', {
    productId: product.id, name: product.name,
    ingredients: [{ ingredientId: ingredient.id, name: ingredient.name, quantity: '18 г' }],
    yieldQuantity: 1, yieldUnit: 'порция', portionCount: 1,
  }, 201);
  const recipeRead = await request(base, ownerToken, organizationId, '/api/recipes');
  assert.ok(recipeRead.items.some(item => item.id === recipe.id && item.productId === product.id
    && item.ingredients?.some(line => line.ingredientId === ingredient.id)), 'recipe and ingredient link are present after a fresh read'); checks++;
  const recipeCost = await request(base, ownerToken, organizationId, `/api/recipes/${recipe.id}/cost`);
  assert.equal(Number(recipeCost.costPerPortion), 21.6, 'the linked recipe calculates 18g at 1.20 RUB/g'); checks++;

  await request(base, ownerToken, organizationId, '/api/shifts', 'POST', { openingCash: 0 }, 201);
  const order = await request(base, ownerToken, organizationId, '/api/orders', 'POST', { tableId }, 201);
  await request(base, ownerToken, organizationId, `/api/orders/${order.id}/items`, 'POST', { productId: product.id, quantity: 1 }, 201);
  await request(base, ownerToken, organizationId, `/api/orders/${order.id}/close`, 'POST', { paymentMethod: 'cash' }, 200);
  const orderRead = await request(base, workerToken, organizationId, '/api/orders?scope=all');
  assert.ok(orderRead.items.some(item => item.id === order.id && item.status === 'closed'), 'authorized hookah staff can reread the completed sale'); checks++;
  await request(base, workerToken, organizationId, '/api/inventory', 'GET', undefined, 403);
  await request(base, workerToken, organizationId, `/api/product-categories/${category.id}`, 'PATCH', { name: 'Unauthorized category change', department: 'hookah' }, 403);
  await request(base, workerToken, organizationId, `/api/inventory/purchase-documents/${receipt.id}/post`, 'POST', {}, 403);
  const afterSale = await request(base, ownerToken, organizationId, '/api/inventory');
  assert.equal(Number(afterSale.items.find(item => item.id === ingredient.id)?.onHand), 82, 'sale depletes exactly 18g after a fresh stock read'); checks++;
  assert.equal(await balance(ingredient.id), 82, 'ledger balance is 82g after the sale'); checks++;
  const costSnapshot = await client.query('SELECT cost FROM order_costs WHERE venue_id=$1 AND order_id=$2', [venueId, order.id]);
  assert.equal(costSnapshot.rowCount, 1, 'sale persists exactly one COGS snapshot');
  assert.equal(Number(costSnapshot.rows[0].cost), 21.6, 'sale snapshots 21.60 RUB COGS from the recipe'); checks += 2;
  const saleMovement = await client.query(`SELECT count(*)::int AS count,COALESCE(sum(quantity),0)::numeric AS quantity
    FROM stock_movements WHERE venue_id=$1 AND order_id=$2 AND ingredient_id=$3 AND direction='out'`, [venueId, order.id, ingredient.id]);
  assert.equal(saleMovement.rows[0].count, 1, 'order has exactly one linked depletion movement');
  assert.equal(Number(saleMovement.rows[0].quantity), 18, 'linked depletion movement records exactly 18g'); checks += 2;

  const foreignCategories = await request(base, foreignToken, foreignOrganizationId, '/api/product-categories?status=active');
  assert.ok(!foreignCategories.items.some(item => item.id === category.id), 'foreign tenant cannot see the category in its catalog'); checks++;
  await request(base, foreignToken, foreignOrganizationId, `/api/product-categories/${category.id}`, 'PATCH', { name: 'Foreign tenant attempt', department: 'hookah' }, 404);
  const foreignStock = await request(base, foreignToken, foreignOrganizationId, '/api/inventory');
  assert.ok(!foreignStock.items.some(item => item.id === ingredient.id), 'foreign tenant cannot see the linked ingredient'); checks++;
  await request(base, foreignToken, foreignOrganizationId, `/api/inventory/purchase-documents/${receipt.id}`, 'GET', undefined, 404);
  const foreignRecipes = await request(base, foreignToken, foreignOrganizationId, '/api/recipes');
  assert.ok(!foreignRecipes.items.some(item => item.id === recipe.id), 'foreign tenant cannot see the recipe'); checks++;
  const foreignOrders = await request(base, foreignToken, foreignOrganizationId, '/api/orders?scope=all');
  assert.ok(!foreignOrders.items.some(item => item.id === order.id), 'foreign tenant cannot see the sale'); checks++;

  await request(base, ownerToken, organizationId, `/api/product-categories/${category.id}`, 'DELETE', undefined, 409);
  console.log(`INVENTORY CROSSFLOW POSTGRES API QA: PASS (${checks} checks; category CRUD/guards→receipt/readback→recipe→sale/depletion/COGS; API and PostgreSQL only)`);
} finally {
  if (server && server.exitCode === null) {
    server.kill();
    await Promise.race([new Promise(resolve => server.once('exit', resolve)), delay(3000)]);
  }
  if (client._connected) await client.end();
}
