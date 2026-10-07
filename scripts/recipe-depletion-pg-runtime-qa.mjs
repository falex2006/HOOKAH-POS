import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { randomBytes, scryptSync } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const databaseUrl = process.env.RECIPE_DEPLETION_PG_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('Set RECIPE_DEPLETION_PG_TEST_DATABASE_URL to an isolated PostgreSQL QA database');
const parsedUrl = new URL(databaseUrl);
assert.match(parsedUrl.pathname, /(?:test|qa|scratch)/i,
  'refusing writes unless the database name clearly identifies a test/QA/scratch database');
const databaseName = decodeURIComponent(parsedUrl.pathname.replace(/^\//, ''));
const runnerOwnsDatabase = databaseName === process.env.LOCAL_FULL_PG_OWNED_DATABASE
  && /^inventory_qa_[a-f0-9]+$/i.test(databaseName);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { Client } = require('pg');
const venueId = randomUUID();
const organizationId = randomUUID();
// Every run owns a fresh actor and venue. Never adopt or clean up a seeded account.
const actorId = randomUUID();
const zoneId = randomUUID();
const tableId = randomUUID();
const failureFunction = 'qa_recipe_order_close_failure';
const failureTrigger = 'qa_recipe_order_close_failure';
const processTimezone = 'Etc/GMT+12';
const venueTimezone = 'Pacific/Kiritimati';
const client = new Client({ connectionString: databaseUrl });
let server;
let serverOutput = '';
let checks = 0;
let sessionToken = '';

async function req(base, url, method = 'GET', data, expected = 200) {
  const response = await fetch(`${base}${url}`, {
    method,
    headers: { ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}), 'Content-Type': 'application/json', 'X-Organization-Id': organizationId },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const result = await response.json();
  assert.equal(response.status, expected, `${method} ${url}: ${JSON.stringify(result)}`);
  checks++;
  return result;
}

async function ownerReq(base, token, url, method = 'GET', data, expected = 200) {
  const response = await fetch(`${base}${url}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Organization-Id': organizationId },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const result = await response.json();
  assert.equal(response.status, expected, `${method} ${url}: ${JSON.stringify(result)}`);
  checks++;
  return result;
}

async function authenticatedReq(base, token, url, method = 'GET', data, expected = 200) {
  const response = await fetch(`${base}${url}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Organization-Id': organizationId },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const result = await response.json();
  assert.equal(response.status, expected, `${method} ${url}: ${JSON.stringify(result)}`);
  checks++;
  return result;
}

async function getBalance(ingredientId) {
  const result = await client.query(`SELECT COALESCE(SUM(CASE
    WHEN direction IN ('in','transfer','adjustment') THEN quantity
    WHEN direction IN ('out','waste') THEN -quantity ELSE 0 END),0)::numeric AS balance
    FROM stock_movements WHERE venue_id=$1 AND ingredient_id=$2`, [venueId, ingredientId]);
  return Number(result.rows[0].balance);
}

async function getOrderCost(orderId) {
  const result = await client.query('SELECT cost FROM order_costs WHERE venue_id=$1 AND order_id=$2', [venueId, orderId]);
  return result.rows[0] ? Number(result.rows[0].cost) : null;
}

async function getBusinessDate() {
  const result = await client.query(`SELECT COALESCE(NULLIF(v.timezone,''),NULLIF(org.timezone,''),'Asia/Yekaterinburg') AS timezone
    FROM venues v LEFT JOIN organizations org ON org.id=v.organization_id WHERE v.id=$1`, [venueId]);
  const timezone = result.rows[0]?.timezone || 'Asia/Yekaterinburg';
  const date = await client.query('SELECT (now() AT TIME ZONE $1)::date::text AS date', [timezone]);
  return date.rows[0].date;
}

async function cleanSyntheticVenue(id) {
  await client.query(`DROP TRIGGER IF EXISTS ${failureTrigger} ON orders`).catch(() => {});
  await client.query(`DROP FUNCTION IF EXISTS public.${failureFunction}()`).catch(() => {});
  await client.query('BEGIN');
  try {
    // Posted purchase documents and premix batch movements are immutable
    // through product workflows. For this isolated fixture teardown only,
    // disable those guards in-transaction while keeping foreign keys enabled.
    await client.query('ALTER TABLE inventory_purchase_document_lines DISABLE TRIGGER inventory_purchase_line_lifecycle_guard');
    await client.query('ALTER TABLE inventory_purchase_documents DISABLE TRIGGER inventory_purchase_document_delete_guard');
    await client.query('ALTER TABLE inventory_premix_batch_movements DISABLE TRIGGER inventory_premix_batch_movement_immutable_guard');
    await client.query('DELETE FROM payments WHERE order_id IN (SELECT id FROM orders WHERE venue_id=$1)', [id]);
    await client.query('DELETE FROM discounts WHERE order_id IN (SELECT id FROM orders WHERE venue_id=$1)', [id]);
    await client.query('DELETE FROM payroll_entries WHERE venue_id=$1', [id]);
    await client.query('DELETE FROM expenses WHERE venue_id=$1', [id]);
    await client.query('DELETE FROM inventory_purchase_document_lines WHERE venue_id=$1', [id]);
    await client.query('DELETE FROM inventory_premix_batch_movements WHERE venue_id=$1', [id]);
    await client.query('DELETE FROM inventory_premix_batches WHERE venue_id=$1', [id]);
    await client.query('DELETE FROM inventory_recipe_cards WHERE venue_id=$1', [id]);
    await client.query('DELETE FROM inventory_purchase_documents WHERE venue_id=$1', [id]);
    await client.query('DELETE FROM inventory_auto_orders WHERE venue_id=$1', [id]);
    await client.query('DELETE FROM inventory_subdepartments WHERE venue_id=$1', [id]);
    await client.query('DELETE FROM tasks WHERE venue_id=$1', [id]);
    await client.query('DELETE FROM staff_schedules WHERE venue_id=$1', [id]);
    await client.query('DELETE FROM staff_work_logs WHERE venue_id=$1', [id]);
    await client.query('DELETE FROM payroll_rules WHERE venue_id=$1', [id]);
    await client.query('DELETE FROM audit_events WHERE venue_id=$1', [id]);
    await client.query('DELETE FROM integration_events WHERE venue_id=$1', [id]);
    await client.query('DELETE FROM order_costs WHERE venue_id=$1', [id]);
    await client.query('DELETE FROM stock_movements WHERE venue_id=$1', [id]);
    await client.query('DELETE FROM orders WHERE venue_id=$1', [id]);
    await client.query('DELETE FROM reservations WHERE venue_id=$1', [id]);
    await client.query('DELETE FROM shifts WHERE venue_id=$1', [id]);
    await client.query('DELETE FROM product_categories WHERE venue_id=$1', [id]);
    await client.query('DELETE FROM products WHERE venue_id=$1', [id]);
    await client.query('DELETE FROM ingredients WHERE venue_id=$1', [id]);
    await client.query('DELETE FROM guests WHERE venue_id=$1', [id]);
    await client.query('DELETE FROM zones WHERE venue_id=$1', [id]);
    await client.query('DELETE FROM inventory_departments WHERE venue_id=$1', [id]);
    await client.query('DELETE FROM users WHERE venue_id=$1', [id]);
    await client.query('DELETE FROM venues WHERE id=$1', [id]);
    await client.query('DELETE FROM organization_memberships WHERE organization_id=$1', [organizationId]);
    await client.query('DELETE FROM organizations WHERE id=$1', [organizationId]);
    await client.query('ALTER TABLE inventory_premix_batch_movements ENABLE TRIGGER inventory_premix_batch_movement_immutable_guard');
    await client.query('ALTER TABLE inventory_purchase_document_lines ENABLE TRIGGER inventory_purchase_line_lifecycle_guard');
    await client.query('ALTER TABLE inventory_purchase_documents ENABLE TRIGGER inventory_purchase_document_delete_guard');
    const scopedTables = await client.query(`SELECT format('%I.%I', table_schema, table_name) AS relation
      FROM information_schema.columns WHERE table_schema='public' AND column_name='venue_id'`);
    for (const { relation } of scopedTables.rows) {
      const remaining = await client.query(`SELECT 1 FROM ${relation} WHERE venue_id::text=$1 LIMIT 1`, [id]);
      assert.equal(remaining.rowCount, 0, `synthetic venue cleanup removes all rows from ${relation}`);
    }
    assert.equal((await client.query('SELECT 1 FROM venues WHERE id=$1', [id])).rowCount, 0,
      'synthetic venue cleanup removes its test venue');
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
}

try {
  await client.connect();
  assert.equal((await client.query('SELECT id FROM users WHERE id=$1', [actorId])).rowCount, 0,
    'the random QA actor ID is unused before fixture creation');
  await client.query('INSERT INTO organizations (id,name,slug,timezone) VALUES ($1,$2,$3,$4)', [organizationId, 'QA warehouse organization', `qa-${organizationId}`, venueTimezone]);
  await client.query("INSERT INTO organization_subscriptions (organization_id,status) VALUES ($1,'trialing')", [organizationId]);
  await client.query('INSERT INTO venues (id,organization_id,name,timezone) VALUES ($1,$2,$3,$4)', [venueId, organizationId, 'Синтетическая QA-точка', venueTimezone]);
  const passwordSalt = randomBytes(16).toString('hex');
  const passwordHash = `scrypt$${passwordSalt}$${scryptSync('qa-owner-password', passwordSalt, 64).toString('hex')}`;
  const pinSalt = randomBytes(16).toString('hex');
  const pinHash = `scrypt$${pinSalt}$${scryptSync('2468', pinSalt, 64).toString('hex')}`;
  await client.query('INSERT INTO users (id,organization_id,venue_id,full_name,login,password_hash,pin_hash,pin_updated_at,role) VALUES ($1,$2,$3,$4,$5,$6,$7,now(),$8)', [actorId, organizationId, venueId, 'QA Владелец', `qa-${venueId}`, passwordHash, pinHash, 'owner']);
  await client.query("INSERT INTO organization_memberships (organization_id,user_id,membership_role,status) VALUES ($1,$2,'owner','active')", [organizationId, actorId]);
  await client.query('INSERT INTO inventory_departments (venue_id,code,name) VALUES ($1,$2,$3) ON CONFLICT (venue_id,code) DO UPDATE SET name=EXCLUDED.name', [venueId, 'bar', 'Бар']);
  await client.query('INSERT INTO zones (id,venue_id,name) VALUES ($1,$2,$3)', [zoneId, venueId, 'QA зона']);
  await client.query('INSERT INTO tables (id,zone_id,name,capacity,status) VALUES ($1,$2,$3,2,$4)', [tableId, zoneId, 'QA стол', 'free']);

  server = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: '0',
      HOST: '127.0.0.1',
      DATABASE_URL: databaseUrl,
      VENUE_ID: venueId,
      AUTH_REQUIRED: 'true',
      NODE_ENV: 'test',
      API_RATE_LIMIT: '5000',
      BUSINESS_TIMEZONE: processTimezone,
      PGOPTIONS: '-c timezone=UTC',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.setEncoding('utf8').on('data', (chunk) => { serverOutput += chunk; });
  server.stderr.setEncoding('utf8').on('data', (chunk) => { serverOutput += chunk; });

  let base;
  const until = Date.now() + 20000;
  while (!base && Date.now() < until) {
    const match = serverOutput.match(/CRM running on http:\/\/localhost:(\d+)/);
    if (match) base = `http://127.0.0.1:${match[1]}`;
    else if (server.exitCode !== null) throw new Error(`QA API server exited early: ${serverOutput}`);
    else await delay(50);
  }
  assert.ok(base, `isolated PostgreSQL API server starts: ${serverOutput}`);

  const health = await req(base, '/api/health');
  assert.equal(health.database, 'postgres', 'test exercises the actual PostgreSQL repository path'); checks++;
  const loginResponse = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Organization-Id': organizationId }, body: JSON.stringify({ username: `qa-${venueId}`, password: 'qa-owner-password' }) });
  const loginData = await loginResponse.json();
  assert.equal(loginResponse.status, 200, 'PostgreSQL QA owner can create a real server session');
  sessionToken = loginData.token;
  assert.ok(sessionToken, 'login response contains the bearer session');
  checks += 2;
  assert.equal((await authenticatedReq(base, sessionToken, '/api/session/unlock', 'POST', { pin: '2468' })).ok, true,
    'PIN unlock reads and verifies the current PostgreSQL PIN hash');
  assert.equal((await authenticatedReq(base, sessionToken, `/api/staff/${actorId}/pin`, 'PATCH', { pin: '9753' })).pinConfigured, true,
    'authenticated owner changes PIN in PostgreSQL without logging out');
  await authenticatedReq(base, sessionToken, '/api/session/unlock', 'POST', { pin: '2468' }, 401);
  assert.equal((await authenticatedReq(base, sessionToken, '/api/session/unlock', 'POST', { pin: '9753' })).ok, true,
    'the same HTTP session accepts the new PIN and rejects the old PIN immediately');
  const staffWithPin = await authenticatedReq(base, sessionToken, '/api/staff');
  assert.equal(staffWithPin.items.find((entry) => entry.id === actorId)?.pinConfigured, true,
    'PostgreSQL staff list exposes PIN configured state without exposing the hash');
  const preservedSessionPreferences = await authenticatedReq(base, sessionToken, '/api/session/preferences');
  assert.deepEqual(preservedSessionPreferences.preferences, {}, 'PIN unlock and rotation leave the authenticated account session usable');
  const emptyZone = await ownerReq(base, sessionToken, '/api/floor/zones', 'POST', { expectedVenueId: venueId, name: `QA пустой зал ${venueId.slice(0, 8)}` }, 201);
  const floorBeforeTable = await ownerReq(base, sessionToken, '/api/floor');
  const listedEmptyZone = floorBeforeTable.zones.find((zone) => zone.id === emptyZone.id);
  assert.ok(listedEmptyZone, 'a newly created PostgreSQL hall remains visible before any table is assigned');
  assert.deepEqual(listedEmptyZone.tables, [], 'an empty hall is returned with an empty table list, not a phantom table'); checks += 2;
  const floorTable = await ownerReq(base, sessionToken, '/api/floor/tables', 'POST', { expectedVenueId: venueId, zoneId: emptyZone.id, name: 'Стол QA', capacity: 2 }, 201);
  const floorAfterTable = await ownerReq(base, sessionToken, '/api/floor');
  assert.ok(floorAfterTable.zones.find((zone) => zone.id === emptyZone.id)?.tables.some((table) => table.id === floorTable.id),
    'a table attached to a new PostgreSQL hall remains visible after refreshing the floor'); checks++;
  await ownerReq(base, sessionToken, `/api/floor/tables/${encodeURIComponent(floorTable.id)}`, 'DELETE', { expectedVenueId: venueId }, 200);
  await ownerReq(base, sessionToken, `/api/floor/zones/${encodeURIComponent(emptyZone.id)}`, 'DELETE', { expectedVenueId: venueId }, 200);
  await ownerReq(base, sessionToken, '/api/shifts', 'POST', { openingCash: 100 }, 201);

  const currentDate = await getBusinessDate();
  const timezoneMismatch = await client.query('SELECT (now() AT TIME ZONE $1)::date <> (now() AT TIME ZONE $2)::date AS differs', [processTimezone, venueTimezone]);
  assert.equal(timezoneMismatch.rows[0].differs, true, 'fixture forces process and venue business dates to differ'); checks++;
  await client.query(`INSERT INTO staff_work_logs (venue_id,user_id,started_at,ended_at,source,note)
    VALUES ($1,$2,($3::date::timestamp + INTERVAL '30 minutes') AT TIME ZONE $4,($3::date::timestamp + INTERVAL '90 minutes') AT TIME ZONE $4,'manual','QA venue-local default date')`,
  [venueId, actorId, currentDate, venueTimezone]);
  const defaultWorkTimeResponse = await fetch(`${base}/api/staff/time`, { headers: { Authorization: `Bearer ${sessionToken}`, 'X-Organization-Id': organizationId } });
  assert.equal(defaultWorkTimeResponse.status, 200, 'default work-time request succeeds with venue-local dates');
  const defaultWorkTime = await defaultWorkTimeResponse.json();
  const localBoundaryLog = defaultWorkTime.items.find((entry) => entry.note === 'QA venue-local default date');
  assert.ok(localBoundaryLog, 'omitted work-time dates select the venue-local current date, not the process date');
  assert.equal(Number(localBoundaryLog.hours), 1, 'local-day work-log boundary keeps the exact elapsed hour'); checks += 4;

  const stockItem = await req(base, '/api/inventory/items', 'POST', {
    name: 'QA сироп для продажи', unit: 'мл', itemType: 'ingredient', cost: 0, department: 'bar',
  }, 201);
  const secondStockItem = await req(base, '/api/inventory/items', 'POST', {
    name: 'QA сок для продажи', unit: 'мл', itemType: 'ingredient', cost: 0, department: 'bar',
  }, 201);
  const supplierReceipt = await req(base, '/api/inventory/purchase-documents', 'POST', {
    supplierName: 'Synthetic QA supplier', documentNumber: `QA-${venueId.slice(0, 8)}`,
    documentDate: currentDate, lines: [
      { ingredientId: stockItem.id, quantity: 3, unit: 'л', unitCost: 20 },
      { ingredientId: secondStockItem.id, quantity: 2, unit: 'л', unitCost: 30 },
    ],
  }, 201);
  assert.equal(Number(supplierReceipt.totalCost), 120, 'purchase lines retain their total supplier cost'); checks++;
  const postedReceipt = await req(base, `/api/inventory/purchase-documents/${supplierReceipt.id}/post`, 'POST', {}, 200);
  assert.equal(postedReceipt.document.status, 'posted', 'posting the supplier document commits the receipt'); checks++;
  assert.equal(await getBalance(stockItem.id), 3000, 'posted receipt converts 3 liters into 3000 ml in the stock ledger'); checks++;
  assert.equal(await getBalance(secondStockItem.id), 2000, 'posted receipt converts 2 liters into 2000 ml in the stock ledger'); checks++;
  const firstPurchasePayment = await req(base, `/api/finance/purchase-payables/${supplierReceipt.id}/payments`, 'POST', {
    amount: 45, paymentDate: currentDate, paymentMethod: 'bank_transfer', idempotencyKey: `qa-chain:${venueId}:1`,
  }, 201);
  assert.equal(Number(firstPurchasePayment.balanceDue), 75, 'partial supplier payment leaves the exact open balance'); checks++;
  const finalPurchasePayment = await req(base, `/api/finance/purchase-payables/${supplierReceipt.id}/payments`, 'POST', {
    amount: 75, paymentDate: currentDate, paymentMethod: 'cash', idempotencyKey: `qa-chain:${venueId}:2`,
  }, 201);
  assert.equal(Number(finalPurchasePayment.balanceDue), 0, 'final supplier payment settles the posted purchase'); checks++;

  const product = await req(base, '/api/products', 'POST', {
    name: `QA напиток ${venueId.slice(0, 8)}`, category: 'Бар', price: 150,
  }, 201);
  const recipe = await req(base, '/api/recipes', 'POST', {
    productId: product.id,
    name: product.name,
    ingredients: [
      { ingredientId: stockItem.id, name: stockItem.name, quantity: '1 л' },
      { ingredientId: secondStockItem.id, name: secondStockItem.name, quantity: '200 мл' },
    ],
    yieldQuantity: 1,
    yieldUnit: 'порция',
    portionCount: 1,
  }, 201);
  assert.equal(recipe.productId, product.id); checks++;

  async function createOrder() {
    const order = await req(base, '/api/orders', 'POST', { tableId }, 201);
    await req(base, `/api/orders/${order.id}/items`, 'POST', { productId: product.id, quantity: 1 }, 201);
    return order.id;
  }

  async function createOrderFor(productId, quantity = 1) {
    const dedicatedTable = await ownerReq(base, sessionToken, '/api/floor/tables', 'POST', { expectedVenueId: venueId, zoneId, name: `QA раздельный стол ${randomUUID().slice(0, 8)}`, capacity: 2 }, 201);
    const order = await req(base, '/api/orders', 'POST', { tableId: dedicatedTable.id }, 201);
    await req(base, `/api/orders/${order.id}/items`, 'POST', { productId, quantity }, 201);
    return order.id;
  }

  const shortageProduct = await req(base, '/api/products', 'POST', {
    name: `QA нехватка сырья ${venueId.slice(0, 8)}`, category: 'Бар', price: 90,
  }, 201);
  await req(base, '/api/recipes', 'POST', {
    productId: shortageProduct.id,
    name: shortageProduct.name,
    ingredients: [{ ingredientId: stockItem.id, name: stockItem.name, quantity: '4 л' }],
    yieldQuantity: 1,
    yieldUnit: 'порция',
    portionCount: 1,
  }, 201);
  const shortageOrderId = await createOrderFor(shortageProduct.id);
  const shortageBalanceBefore = await getBalance(stockItem.id);
  const shortageMovementsBefore = await client.query(
    'SELECT COUNT(*)::int AS count, COALESCE(SUM(quantity),0)::numeric AS quantity FROM stock_movements WHERE venue_id=$1 AND ingredient_id=$2',
    [venueId, stockItem.id],
  );
  assert.equal(shortageBalanceBefore, 3000, 'shortage fixture starts with exactly 3000 ml before a 4000 ml recipe requirement'); checks++;
  const shortageClose = await req(base, `/api/orders/${shortageOrderId}/close`, 'POST', { paymentMethod: 'cash' }, 409);
  assert.equal(shortageClose.error, 'insufficient_recipe_stock', 'sale close rejects a recipe requiring more ingredient than venue stock');
  assert.deepEqual(shortageClose.missing.map(({ ingredientId, quantity, onHand }) => ({ ingredientId, quantity: Number(quantity), onHand: Number(onHand) })),
    [{ ingredientId: stockItem.id, quantity: 4000, onHand: 3000 }], 'shortage response identifies the exact component, converted requirement, and available balance'); checks += 2;
  const shortageState = await client.query(`SELECT o.status,
      (SELECT COUNT(*)::int FROM payments p WHERE p.order_id=o.id) AS payments,
      (SELECT COUNT(*)::int FROM order_costs c WHERE c.order_id=o.id) AS cogs,
      (SELECT COUNT(*)::int FROM stock_movements m WHERE m.order_id=o.id AND m.direction='out') AS depletions
    FROM orders o WHERE o.id=$1 AND o.venue_id=$2`, [shortageOrderId, venueId]);
  assert.deepEqual(shortageState.rows[0], { status: 'open', payments: 0, cogs: 0, depletions: 0 },
    'rejected shortage leaves the order open without payment, COGS, or partial stock movement'); checks++;
  assert.equal(await getBalance(stockItem.id), shortageBalanceBefore, 'shortage rollback preserves the ingredient stock balance'); checks++;
  const shortageMovementsAfter = await client.query(
    'SELECT COUNT(*)::int AS count, COALESCE(SUM(quantity),0)::numeric AS quantity FROM stock_movements WHERE venue_id=$1 AND ingredient_id=$2',
    [venueId, stockItem.id],
  );
  assert.deepEqual(shortageMovementsAfter.rows[0], shortageMovementsBefore.rows[0], 'shortage rollback leaves ingredient movement count and total unchanged'); checks++;
  await req(base, `/api/orders/${shortageOrderId}/payments`, 'POST', { amount: 30, method: 'cash' }, 201);
  const shortageFinalPayment = await req(base, `/api/orders/${shortageOrderId}/payments`, 'POST', { amount: 60, method: 'card' }, 409);
  assert.equal(shortageFinalPayment.error, 'insufficient_recipe_stock', 'final installment cannot complete a sale while recipe stock is insufficient'); checks++;
  const shortageInstallmentState = await client.query(`SELECT o.status,
      (SELECT COUNT(*)::int FROM payments p WHERE p.order_id=o.id) AS payments,
      (SELECT COALESCE(SUM(p.amount),0)::numeric FROM payments p WHERE p.order_id=o.id) AS paid,
      (SELECT COUNT(*)::int FROM order_costs c WHERE c.order_id=o.id) AS cogs,
      (SELECT COUNT(*)::int FROM stock_movements m WHERE m.order_id=o.id AND m.direction='out') AS depletions
    FROM orders o WHERE o.id=$1 AND o.venue_id=$2`, [shortageOrderId, venueId]);
  assert.deepEqual(shortageInstallmentState.rows[0], { status: 'open', payments: 1, paid: '30.00', cogs: 0, depletions: 0 },
    'failed final installment rolls back its payment while preserving the earlier partial payment and open order'); checks++;
  assert.equal(await getBalance(stockItem.id), shortageBalanceBefore, 'failed final installment preserves shortage stock balance'); checks++;

  const aggregateProductA = await req(base, '/api/products', 'POST', {
    name: `QA aggregate shortage A ${venueId.slice(0, 8)}`, category: 'Бар', price: 50,
  }, 201);
  const aggregateProductB = await req(base, '/api/products', 'POST', {
    name: `QA aggregate shortage B ${venueId.slice(0, 8)}`, category: 'Бар', price: 50,
  }, 201);
  for (const aggregateProduct of [aggregateProductA, aggregateProductB]) {
    await req(base, '/api/recipes', 'POST', {
      productId: aggregateProduct.id, name: aggregateProduct.name,
      ingredients: [{ ingredientId: stockItem.id, name: stockItem.name, quantity: '2 л' }],
      yieldQuantity: 1, yieldUnit: 'порция', portionCount: 1,
    }, 201);
  }
  const aggregateShortageOrderId = await createOrderFor(aggregateProductA.id);
  await req(base, `/api/orders/${aggregateShortageOrderId}/items`, 'POST', { productId: aggregateProductB.id, quantity: 1 }, 201);
  assert.equal(await getBalance(stockItem.id), 3000, 'each two-liter order item individually fits the 3000 ml stock fixture'); checks++;
  const aggregateMovementBaseline = await client.query(
    'SELECT COUNT(*)::int AS count, COALESCE(SUM(quantity),0)::numeric AS quantity FROM stock_movements WHERE venue_id=$1 AND ingredient_id=$2',
    [venueId, stockItem.id],
  );
  const aggregateShortageClose = await req(base, `/api/orders/${aggregateShortageOrderId}/close`, 'POST', { paymentMethod: 'cash' }, 409);
  assert.equal(aggregateShortageClose.error, 'insufficient_recipe_stock', 'close rejects the combined 4000 ml requirement across two products'); checks++;
  assert.deepEqual(aggregateShortageClose.missing.map(({ ingredientId, quantity, onHand }) => ({ ingredientId, quantity: Number(quantity), onHand: Number(onHand) })),
    [{ ingredientId: stockItem.id, quantity: 4000, onHand: 3000 }], 'shortage payload aggregates both order lines for their shared ingredient'); checks++;
  const aggregateShortageState = await client.query(`SELECT o.status,
      (SELECT COUNT(*)::int FROM payments p WHERE p.order_id=o.id) AS payments,
      (SELECT COUNT(*)::int FROM order_costs c WHERE c.order_id=o.id) AS cogs,
      (SELECT COUNT(*)::int FROM stock_movements m WHERE m.order_id=o.id AND m.direction='out') AS depletions
    FROM orders o WHERE o.id=$1 AND o.venue_id=$2`, [aggregateShortageOrderId, venueId]);
  assert.deepEqual(aggregateShortageState.rows[0], { status: 'open', payments: 0, cogs: 0, depletions: 0 },
    'aggregate shortage leaves the whole multi-product order open with no partial financial or stock effects'); checks++;
  assert.equal(await getBalance(stockItem.id), shortageBalanceBefore, 'aggregate shortage leaves shared stock unchanged'); checks++;
  const aggregateMovementAfter = await client.query(
    'SELECT COUNT(*)::int AS count, COALESCE(SUM(quantity),0)::numeric AS quantity FROM stock_movements WHERE venue_id=$1 AND ingredient_id=$2',
    [venueId, stockItem.id],
  );
  assert.deepEqual(aggregateMovementAfter.rows[0], aggregateMovementBaseline.rows[0], 'aggregate shortage leaves the shared ingredient movement count and total unchanged'); checks++;

  const firstOrderId = await createOrder();

  const unconfiguredProduct = await req(base, '/api/products', 'POST', {
    name: `QA tracked without recipe ${venueId.slice(0, 8)}`, category: 'Бар', price: 150,
  }, 201);
  assert.equal(unconfiguredProduct.inventoryMode, 'tracked', 'new PostgreSQL catalog products expose explicit tracked mode'); checks++;
  const unconfiguredCloseId = await createOrderFor(unconfiguredProduct.id);
  const blockedClose = await req(base, `/api/orders/${unconfiguredCloseId}/close`, 'POST', { paymentMethod: 'cash' }, 409);
  assert.equal(blockedClose.error, 'product_recipe_required', 'manual close rejects tracked sale product with no recipe'); checks++;
  let rejectedState = await client.query(`SELECT o.status,
      (SELECT count(*)::int FROM payments p WHERE p.order_id=o.id) AS payments,
      (SELECT count(*)::int FROM order_costs c WHERE c.order_id=o.id) AS cogs
    FROM orders o WHERE o.id=$1`, [unconfiguredCloseId]);
  assert.deepEqual(rejectedState.rows[0], { status: 'open', payments: 0, cogs: 0 }, 'rejected missing-recipe close has no payment, COGS or status mutation'); checks++;

  const unconfiguredPaymentId = await createOrderFor(unconfiguredProduct.id);
  await req(base, `/api/orders/${unconfiguredPaymentId}/payments`, 'POST', { amount: 50, method: 'cash' }, 201);
  const blockedFinalPayment = await req(base, `/api/orders/${unconfiguredPaymentId}/payments`, 'POST', { amount: 100, method: 'cash' }, 409);
  assert.equal(blockedFinalPayment.error, 'product_recipe_required', 'final installment rejects a tracked product without recipe'); checks++;
  rejectedState = await client.query(`SELECT o.status,
      (SELECT count(*)::int FROM payments p WHERE p.order_id=o.id) AS payments,
      (SELECT COALESCE(SUM(p.amount),0)::numeric FROM payments p WHERE p.order_id=o.id) AS paid,
      (SELECT count(*)::int FROM order_costs c WHERE c.order_id=o.id) AS cogs
    FROM orders o WHERE o.id=$1`, [unconfiguredPaymentId]);
  assert.deepEqual(rejectedState.rows[0], { status: 'open', payments: 1, paid: '50.00', cogs: 0 }, 'failed final installment rolls back its payment, leaving only the earlier partial payment'); checks++;

  const reviewProduct = await req(base, '/api/products', 'POST', {
    name: `QA legacy needs review ${venueId.slice(0, 8)}`, category: 'Бар', price: 150,
  }, 201);
  await req(base, `/api/products/${reviewProduct.id}`, 'PATCH', { inventoryMode: 'needs_review' }, 200);
  const reviewOrderId = await createOrderFor(reviewProduct.id);
  const blockedReview = await req(base, `/api/orders/${reviewOrderId}/close`, 'POST', { paymentMethod: 'cash' }, 409);
  assert.equal(blockedReview.error, 'product_inventory_mode_required', 'unclassified product requires review before sale finalization'); checks++;
  const firstClose = await req(base, `/api/orders/${firstOrderId}/close`, 'POST', { paymentMethod: 'cash' }, 200);
  assert.equal(firstClose.status, 'closed');
  assert.equal(await getOrderCost(firstOrderId), 26, '1 l at 20 RUB/l plus 200 ml at 30 RUB/l costs 26 RUB and is persisted as COGS'); checks += 2;
  assert.equal(await getBalance(stockItem.id), 2000, 'sale subtracts 1000 ml from the real PostgreSQL ledger'); checks++;
  assert.equal(await getBalance(secondStockItem.id), 1800, 'the second recipe component subtracts 200 ml from its real PostgreSQL ledger'); checks++;

  const failedOrderId = await createOrder();
  await client.query(`CREATE FUNCTION public.${failureFunction}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.id = '${failedOrderId}'::uuid AND NEW.status='closed' THEN
        RAISE EXCEPTION 'qa_injected_close_failure';
      END IF;
      RETURN NEW;
    END;
  $$`);
  await client.query(`CREATE TRIGGER ${failureTrigger} BEFORE UPDATE OF status ON orders
    FOR EACH ROW EXECUTE FUNCTION public.${failureFunction}()`);
  const rejectedClose = await req(base, `/api/orders/${failedOrderId}/close`, 'POST', { paymentMethod: 'cash' }, 409);
  assert.equal(rejectedClose.error, 'order_close_failed'); checks++;
  assert.equal(await getBalance(stockItem.id), 2000, 'failure after recipe depletion rolls back the stock movement'); checks++;
  assert.equal(await getBalance(secondStockItem.id), 1800, 'failure rolls back every component movement'); checks++;
  const afterInjectedFailure = await client.query(`SELECT o.status,
      (SELECT count(*)::int FROM payments p WHERE p.order_id=o.id) AS payments,
      (SELECT count(*)::int FROM order_costs c WHERE c.order_id=o.id) AS cogs
    FROM orders o WHERE o.id=$1`, [failedOrderId]);
  assert.deepEqual(afterInjectedFailure.rows[0], { status: 'open', payments: 0, cogs: 0 }, 'failed close leaves order, payments and COGS unchanged'); checks++;
  await client.query(`DROP TRIGGER ${failureTrigger} ON orders`);
  await client.query(`DROP FUNCTION public.${failureFunction}()`);

  const priceChangeReceipt = await req(base, '/api/inventory/purchase-documents', 'POST', {
    supplierName: 'Synthetic QA price change', documentNumber: `QA-PRICE-${venueId.slice(0, 8)}`,
    documentDate: currentDate, lines: [{ ingredientId: stockItem.id, quantity: 1, unit: 'л', unitCost: 100 }],
  }, 201);
  await req(base, `/api/inventory/purchase-documents/${priceChangeReceipt.id}/post`, 'POST', {}, 200);
  await req(base, `/api/finance/purchase-payables/${priceChangeReceipt.id}/payments`, 'POST', {
    amount: 100, paymentDate: currentDate, paymentMethod: 'cash', idempotencyKey: `qa-chain:${venueId}:3`,
  }, 201);
  assert.equal(Number((await client.query('SELECT cost FROM ingredients WHERE id=$1', [stockItem.id])).rows[0].cost), 0.0467,
    'weighted average unit cost retains four decimal places instead of rounding every ml to a kopeck'); checks++;
  const retryClose = await req(base, `/api/orders/${failedOrderId}/close`, 'POST', { paymentMethod: 'cash' }, 200);
  assert.equal(retryClose.status, 'closed');
  assert.equal(await getOrderCost(failedOrderId), 52.7, 'retry rounds final recipe cost to kopecks after preserving weighted unit-cost precision'); checks += 2;
  assert.equal(await getBalance(stockItem.id), 2000, 'retry depletes exactly one portion, not the failed attempt plus retry'); checks++;
  assert.equal(await getBalance(secondStockItem.id), 1600, 'retry consumes exactly one second-component portion after the rolled-back attempt'); checks++;
  const duplicateClose = await req(base, `/api/orders/${failedOrderId}/close`, 'POST', { paymentMethod: 'cash' }, 409);
  assert.equal(duplicateClose.error, 'order_already_final'); checks++;
  assert.equal(await getBalance(stockItem.id), 2000, 'duplicate close cannot deplete inventory again'); checks++;
  assert.equal(await getBalance(secondStockItem.id), 1600, 'duplicate close cannot consume a recipe component again'); checks++;

  const premixOutput = await req(base, '/api/inventory/items', 'POST', {
    name: 'QA premix output', unit: 'мл', itemType: 'ingredient', cost: 0, department: 'bar',
  }, 201);
  const premixRecipe = await req(base, '/api/recipes', 'POST', {
    name: 'QA weighted-cost premix', recipeType: 'premix',
    ingredients: [
      { ingredientId: stockItem.id, name: stockItem.name, quantity: '1 л' },
      { ingredientId: secondStockItem.id, name: secondStockItem.name, quantity: '200 мл' },
    ],
    yieldQuantity: 1200, yieldUnit: 'мл', portionCount: 1,
  }, 201);
  const premixBatch = await req(base, '/api/inventory/premixes/produce', 'POST', {
    recipeId: premixRecipe.id, outputItemId: premixOutput.id, multiplier: 1,
    actualOutput: 1100, expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  }, 201);
  assert.equal(Number(premixBatch.totalCost), 52.7, 'premix cost uses the precise weighted cost of the milliliter stock unit');
  assert.equal(Number(premixBatch.plannedOutputQuantity), 1200);
  assert.equal(Number(premixBatch.outputQuantity), 1100, 'actual yield is posted to stock separately from the planned recipe yield');
  assert.equal(Number((await client.query('SELECT cost FROM ingredients WHERE id=$1', [premixOutput.id])).rows[0].cost), 0.0479,
    'premix output persists sub-kopeck unit cost so later recipes do not round each ml to a kopeck');
  assert.equal(await getBalance(premixOutput.id), 1100, 'actual premix output quantity is added to the stock ledger');
  assert.equal(await getBalance(stockItem.id), 1000, 'premix production consumes its first component exactly once');
  assert.equal(await getBalance(secondStockItem.id), 1400, 'premix production consumes its second component exactly once'); checks += 7;
  const premixHistory = await req(base, '/api/inventory/premixes');
  const listedPremixBatch = premixHistory.items.find((entry) => entry.id === premixBatch.id);
  assert.equal(Number(listedPremixBatch.remainingQuantity), 1100);
  assert.equal(Number(listedPremixBatch.plannedOutputQuantity), 1200);
  assert.equal(listedPremixBatch.producedById, actorId, 'batch history exposes the saved producer'); checks += 3;
  const batchCount = await req(base, `/api/inventory/premixes/${premixBatch.id}/count`, 'POST', { actualQuantity: 1080, reason: 'QA inventory count' }, 200);
  assert.equal(Number(batchCount.remainingQuantity), 1080, 'inventory count appends a lot-level adjustment'); checks++;
  const batchWaste = await req(base, `/api/inventory/premixes/${premixBatch.id}/waste`, 'POST', { quantity: 10, reason: 'QA spoilage' }, 200);
  assert.equal(Number(batchWaste.remainingQuantity), 1070, 'spoilage reduces this specific lot and total stock'); checks++;
  const issuedFromBatch = await req(base, '/api/inventory/movements', 'POST', { itemId: premixOutput.id, delta: -70, unit: 'мл', reason: 'QA FEFO issue' }, 201);
  const historyAfterIssue = await req(base, '/api/inventory/premixes');
  assert.equal(Number(historyAfterIssue.items.find((entry) => entry.id === premixBatch.id).remainingQuantity), 1000, 'ordinary stock issues allocate to the produced batch'); checks++;
  assert.equal(Number(issuedFromBatch.delta), -70);

  const cancellableOutput = await req(base, '/api/inventory/items', 'POST', {
    name: 'QA premix cancellable output', unit: 'мл', itemType: 'ingredient', cost: 0, department: 'bar',
  }, 201);
  await req(base, '/api/inventory/movements', 'POST', { itemId: stockItem.id, delta: 1000, unit: 'мл', reason: 'QA premix source top-up' }, 201);
  await req(base, '/api/inventory/movements', 'POST', { itemId: secondStockItem.id, delta: 200, unit: 'мл', reason: 'QA premix source top-up' }, 201);
  const cancellableBatch = await req(base, '/api/inventory/premixes/produce', 'POST', { recipeId: premixRecipe.id, outputItemId: cancellableOutput.id, multiplier: 1, expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString() }, 201);
  await client.query('UPDATE inventory_premix_batches SET expires_at=now()-interval \'1 day\' WHERE id=$1', [cancellableBatch.id]);
  const expiredIssue = await req(base, '/api/inventory/movements', 'POST', { itemId: cancellableOutput.id, delta: -1, unit: 'мл', reason: 'QA expired issue' }, 409);
  assert.equal(expiredIssue.error, 'expired_premix_stock', 'expired tracked stock cannot be consumed'); checks++;
  assert.equal(await getBalance(cancellableOutput.id), 1200, 'rejected expired-lot consumption rolls the movement back'); checks++;
  const voidedBatch = await req(base, `/api/inventory/premixes/${cancellableBatch.id}/void`, 'POST', { reason: 'QA cancellation' }, 200);
  assert.equal(voidedBatch.status, 'voided', 'untouched issue may be reversed without deleting the batch'); checks++;
  assert.equal(await getBalance(cancellableOutput.id), 0, 'void reversal removes the batch output from stock'); checks++;
  assert.equal(await getBalance(stockItem.id), 2000, 'void reversal restores consumed recipe ingredients'); checks++;
  assert.equal(await getBalance(secondStockItem.id), 1600, 'void reversal restores all recipe components'); checks++;
  const voidHistory = await req(base, '/api/inventory/premixes');
  assert.equal(voidHistory.items.find((entry) => entry.id === cancellableBatch.id).status, 'voided', 'voided batches remain visible in history'); checks++;

  const snapshots = await client.query('SELECT cost FROM order_costs WHERE order_id=$1', [firstOrderId]);
  assert.equal(Number(snapshots.rows[0].cost), 26, 'historical COGS snapshot is unchanged after a later purchase changes weighted cost'); checks++;
  const paymentRows = await client.query('SELECT amount,status,shift_id FROM payments WHERE order_id=$1', [failedOrderId]);
  assert.equal(paymentRows.rowCount, 1);
  assert.equal(Number(paymentRows.rows[0].amount), 150);
  assert.equal(paymentRows.rows[0].status, 'paid');
  assert.ok(paymentRows.rows[0].shift_id, 'sale payment retains shift attribution'); checks += 4;
  const activeShift = await client.query('SELECT id FROM shifts WHERE venue_id=$1 AND closed_at IS NULL', [venueId]);
  assert.equal(activeShift.rowCount, 1, 'sale flow retains one active shift for later cash reconciliation'); checks++;

  const previousUtcDate = new Date(`${currentDate}T00:00:00Z`);
  previousUtcDate.setUTCDate(previousUtcDate.getUTCDate() - 1);
  const utcPreviousDayAfterLocalMidnight = `${previousUtcDate.toISOString().slice(0, 10)}T22:30:00Z`;
  await client.query('UPDATE orders SET closed_at=$2::timestamptz WHERE id=$1', [firstOrderId, utcPreviousDayAfterLocalMidnight]);
  await client.query("UPDATE venues SET timezone='Mars/Olympus' WHERE id=$1", [venueId]);
  const organizationFallbackSummary = await req(base, '/api/finance/summary');
  assert.equal(organizationFallbackSummary.date, currentDate, 'invalid venue timezone first falls back to the valid organization timezone'); checks++;
  const organizationFallbackReport = await req(base, '/api/finance/report');
  assert.equal(organizationFallbackReport.date, currentDate, 'X report uses the same organization timezone before the global fallback'); checks++;
  await client.query("UPDATE organizations SET timezone='Mars/Olympus' WHERE id=$1", [organizationId]);
  const fallbackDateRows = await client.query("SELECT (now() AT TIME ZONE 'Asia/Yekaterinburg')::date::text AS date");
  const fallbackDate = fallbackDateRows.rows[0].date;
  const corruptedZoneSummaryResponse = await fetch(`${base}/api/finance/summary`, { headers: { Authorization: `Bearer ${sessionToken}`, 'X-Organization-Id': organizationId } });
  assert.equal(corruptedZoneSummaryResponse.status, 200, 'legacy invalid venue timezone falls back instead of breaking the finance summary');
  const corruptedZoneSummary = await corruptedZoneSummaryResponse.json();
  assert.equal(corruptedZoneSummary.date, fallbackDate, 'when venue and organization timezones are both invalid, the established Asia/Yekaterinburg fallback is used'); checks += 2;
  const corruptedZoneReportResponse = await fetch(`${base}/api/finance/report`, { headers: { Authorization: `Bearer ${sessionToken}`, 'X-Organization-Id': organizationId } });
  assert.equal(corruptedZoneReportResponse.status, 200, 'legacy invalid venue timezone falls back instead of breaking the X report');
  assert.equal((await corruptedZoneReportResponse.json()).date, fallbackDate, 'X report uses the same resilient timezone fallback'); checks += 2;
  await client.query('UPDATE organizations SET timezone=$2 WHERE id=$1', [organizationId, venueTimezone]);
  await client.query('UPDATE venues SET timezone=$2 WHERE id=$1', [venueId, venueTimezone]);
  const financeSummaryResponse = await fetch(`${base}/api/finance/summary`, { headers: { Authorization: `Bearer ${sessionToken}`, 'X-Organization-Id': organizationId } });
  assert.equal(financeSummaryResponse.status, 200, 'default finance summary succeeds when process and venue dates differ');
  const financeSummary = await financeSummaryResponse.json();
  assert.equal(financeSummary.date, currentDate, 'default finance date comes from the venue timezone, not the process timezone');
  assert.equal(Number(financeSummary.revenue), 300, 'venue-local finance summary includes sales across the UTC date boundary');
  assert.equal(Number(financeSummary.closedOrders), 2, 'venue-local summary counts both checks on the venue business date');
  assert.equal(Number(financeSummary.paymentCount), 4, 'venue-local summary counts closed-sale payments, an earlier partial receipt, and the shortage order installment across the UTC date boundary'); checks += 5;
  const financeReportResponse = await fetch(`${base}/api/finance/report?date=${encodeURIComponent(currentDate)}&type=x`, { headers: { Authorization: `Bearer ${sessionToken}`, 'X-Organization-Id': organizationId } });
  assert.equal(financeReportResponse.status, 200, 'X report succeeds for explicit venue-local business date');
  const financeReport = await financeReportResponse.json();
  assert.equal(financeReport.date, currentDate, 'X report preserves the requested local calendar date');
  assert.equal(Number(financeReport.revenue), 300, 'X report uses venue-local UTC boundaries');
  assert.equal(financeReport.checksCount, 2, 'X report includes both checks on the venue date'); checks += 4;
  const analyticsResponse = await fetch(`${base}/api/analytics?days=7`, { headers: { Authorization: `Bearer ${sessionToken}`, 'X-Organization-Id': organizationId } });
  assert.equal(analyticsResponse.status, 200);
  const analytics = await analyticsResponse.json();
  const today = analytics.days.find((day) => day.date === currentDate);
  assert.ok(today, 'selected analytics period includes the synthetic sales date');
  assert.match(today.date, /^\d{4}-\d{2}-\d{2}$/, 'analytics serializes PostgreSQL date values as stable ISO calendar dates');
  assert.equal(Number(today.revenue), 300, 'analytics revenue reads both paid product sales');
  assert.equal(Number(today.costOfGoods), 78.7, 'analytics COGS sums the two immutable order snapshots: 26 + 52.7');
  assert.equal(Number(today.expenses), 0, 'supplier principal does not count as a second operating expense');
  assert.equal(Number(today.cashOutflow), 220, 'supplier settlements remain visible in cash flow');
  assert.equal(Number(today.payroll), 0, 'unpaid payroll is not recorded as an incurred operating result');
  assert.equal(Number(today.netProfit), 221.3, 'current-day profit equals revenue 300 minus COGS 78.7'); checks += 8;

  const manualExpenseResponse = await fetch(`${base}/api/expenses`, {
    method: 'POST', headers: { Authorization: `Bearer ${sessionToken}`, 'Content-Type': 'application/json', 'X-Organization-Id': organizationId },
    body: JSON.stringify({ category: 'QA операционные расходы', amount: 18, expenseDate: currentDate, description: 'synthetic operating expense', source: 'manual' }),
  });
  assert.equal(manualExpenseResponse.status, 201);
  const withOperatingExpenseResponse = await fetch(`${base}/api/analytics?days=7`, { headers: { Authorization: `Bearer ${sessionToken}`, 'X-Organization-Id': organizationId } });
  assert.equal(withOperatingExpenseResponse.status, 200);
  const withOperatingExpense = await withOperatingExpenseResponse.json();
  const afterExpense = withOperatingExpense.days.find((day) => day.date === currentDate);
  assert.ok(afterExpense);
  assert.equal(Number(afterExpense.expenses), 18, 'manual operating expense is counted once as accrual');
  assert.equal(Number(afterExpense.cashOutflow), 238, 'cash flow includes 220 RUB supplier payments and one 18 RUB operating payment');
  assert.equal(Number(afterExpense.netProfit), 203.3, 'profit subtracts COGS and manual operating expense');
  assert.equal(Number(withOperatingExpense.netProfit), 203.3, 'period profit equals 300 revenue − 78.7 COGS − 18 expense'); checks += 7;

  const rule = await client.query(`INSERT INTO payroll_rules (venue_id,name,rule_type,rate)
    VALUES ($1,'QA hourly finance','hourly',50) RETURNING id`, [venueId]);
  await client.query(`INSERT INTO staff_work_logs (venue_id,user_id,started_at,ended_at,source)
    VALUES ($1,$2,$3::date::timestamp AT TIME ZONE $4,($3::date::timestamp + INTERVAL '4 hours') AT TIME ZONE $4,'manual')`,
  [venueId, actorId, currentDate, venueTimezone]);
  const payrollDraftResponse = await fetch(`${base}/api/payroll/entries`, {
    method: 'POST', headers: { Authorization: `Bearer ${sessionToken}`, 'Content-Type': 'application/json', 'X-Organization-Id': organizationId },
    body: JSON.stringify({ userId: actorId, ruleId: rule.rows[0].id, periodFrom: currentDate, periodTo: currentDate }),
  });
  assert.equal(payrollDraftResponse.status, 201);
  const payrollDraft = await payrollDraftResponse.json();
  assert.equal(Number(payrollDraft.amount), 200, 'the payroll amount comes from four worked hours at 50 RUB/hour');
  const approvePayrollResponse = await fetch(`${base}/api/payroll/entries/${payrollDraft.id}`, {
    method: 'PATCH', headers: { Authorization: `Bearer ${sessionToken}`, 'Content-Type': 'application/json', 'X-Organization-Id': organizationId }, body: JSON.stringify({ action: 'approve' }),
  });
  assert.equal(approvePayrollResponse.status, 200);
  const approvedPayrollAnalyticsResponse = await fetch(`${base}/api/analytics?days=7`, { headers: { Authorization: `Bearer ${sessionToken}`, 'X-Organization-Id': organizationId } });
  assert.equal(approvedPayrollAnalyticsResponse.status, 200);
  const approvedPayrollAnalytics = await approvedPayrollAnalyticsResponse.json();
  const approvedPayrollDay = approvedPayrollAnalytics.days.find((day) => day.date === currentDate);
  assert.ok(approvedPayrollDay);
  assert.equal(Number(approvedPayrollDay.payroll), 200, 'approved salary accrues to operating profit before cash payment');
  assert.equal(Number(approvedPayrollDay.cashOutflow), 238, 'approved-but-unpaid salary is not shown as cash outflow');
  assert.ok(Math.abs(Number(approvedPayrollDay.netProfit) - 3.3) < 0.001, 'accrual profit includes approved salary exactly once');
  const payPayrollResponse = await fetch(`${base}/api/payroll/entries/${payrollDraft.id}`, {
    method: 'PATCH', headers: { Authorization: `Bearer ${sessionToken}`, 'Content-Type': 'application/json', 'X-Organization-Id': organizationId },
    body: JSON.stringify({ action: 'pay', paymentDate: currentDate }),
  });
  assert.equal(payPayrollResponse.status, 200);
  const paidPayroll = await payPayrollResponse.json();
  assert.ok(paidPayroll.expense_id, 'salary payout is linked to exactly one payroll cashflow expense');
  const afterPayrollResponse = await fetch(`${base}/api/analytics?days=7`, { headers: { Authorization: `Bearer ${sessionToken}`, 'X-Organization-Id': organizationId } });
  assert.equal(afterPayrollResponse.status, 200);
  const afterPayrollAnalytics = await afterPayrollResponse.json();
  const afterPayroll = afterPayrollAnalytics.days.find((day) => day.date === currentDate);
  assert.ok(afterPayroll);
  assert.equal(Number(afterPayroll.payroll), 200, 'paid salary is included in accrued operational result once');
  assert.equal(Number(afterPayroll.expenses), 218, 'profit expenses include the 18 RUB manual cost and 200 RUB salary once');
  assert.equal(Number(afterPayroll.cashOutflow), 438, 'cash flow includes supplier payments, operating expenses and salary actually paid');
  assert.ok(Math.abs(Number(afterPayroll.netProfit) - 3.3) < 0.001, 'profit equals 300 revenue − 78.7 COGS − 18 operating cost − 200 salary');
  assert.ok(Math.abs(Number(afterPayrollAnalytics.netProfit) - 3.3) < 0.001, 'period P&L reconciles to the independently expected result'); checks += 11;

  const portionIngredient = await req(base, '/api/inventory/items', 'POST', {
    name: `QA portion ingredient ${venueId.slice(0, 8)}`, unit: 'мл', itemType: 'ingredient', cost: 0.1, department: 'bar',
  }, 201);
  await req(base, '/api/inventory/movements', 'POST', {
    itemId: portionIngredient.id, delta: 400, unit: 'мл', reason: 'QA four-portion recipe opening stock',
  }, 201);
  const portionProduct = await req(base, '/api/products', 'POST', {
    name: `QA four-portion sale ${venueId.slice(0, 8)}`, category: 'Бар', price: 100,
  }, 201);
  const portionRecipe = await req(base, '/api/recipes', 'POST', {
    productId: portionProduct.id, name: portionProduct.name,
    ingredients: [{ ingredientId: portionIngredient.id, name: portionIngredient.name, quantity: '400 мл' }],
    yieldQuantity: 4, yieldUnit: 'порция', portionCount: 4,
  }, 201);
  const portionRecipeCost = await req(base, `/api/recipes/${portionRecipe.id}/cost`);
  assert.equal(Number(portionRecipeCost.totalCost), 40, 'four-portion recipe cost is the full 400 ml batch cost'); checks++;
  assert.equal(Number(portionRecipeCost.costPerPortion), 10, 'four-portion recipe exposes cost per served portion'); checks++;
  const onePortionOrderId = await createOrderFor(portionProduct.id, 1);
  await req(base, `/api/orders/${onePortionOrderId}/close`, 'POST', { paymentMethod: 'cash' }, 200);
  assert.equal(await getBalance(portionIngredient.id), 300, 'selling one of four portions consumes 100 ml from PostgreSQL stock'); checks++;
  assert.equal(await getOrderCost(onePortionOrderId), 10, 'one-portion sale snapshots 10 RUB COGS'); checks++;
  const twoPortionOrderId = await createOrderFor(portionProduct.id, 2);
  await req(base, `/api/orders/${twoPortionOrderId}/close`, 'POST', { paymentMethod: 'cash' }, 200);
  assert.equal(await getBalance(portionIngredient.id), 100, 'selling two portions consumes 200 ml from PostgreSQL stock'); checks++;
  assert.equal(await getOrderCost(twoPortionOrderId), 20, 'two-portion sale snapshots 20 RUB COGS'); checks++;

  const duplicateLineIngredient = await req(base, '/api/inventory/items', 'POST', {
    name: `QA duplicate recipe lines ${venueId.slice(0, 8)}`, unit: 'мл', itemType: 'ingredient', cost: 0.1, department: 'bar',
  }, 201);
  await req(base, '/api/inventory/movements', 'POST', {
    itemId: duplicateLineIngredient.id, delta: 100, unit: 'мл', reason: 'QA duplicate recipe line opening stock',
  }, 201);
  const duplicateLineProduct = await req(base, '/api/products', 'POST', {
    name: `QA repeated ingredient sale ${venueId.slice(0, 8)}`, category: 'Бар', price: 100,
  }, 201);
  const duplicateLineRecipe = await req(base, '/api/recipes', 'POST', {
    productId: duplicateLineProduct.id, name: duplicateLineProduct.name,
    ingredients: [
      { ingredientId: duplicateLineIngredient.id, name: duplicateLineIngredient.name, quantity: '30 мл' },
      { ingredientId: duplicateLineIngredient.id, name: duplicateLineIngredient.name, quantity: '20 мл' },
    ],
    yieldQuantity: 1, yieldUnit: 'порция', portionCount: 1,
  }, 201);
  assert.equal(duplicateLineRecipe.ingredients.length, 2, 'API preserves both recipe lines that refer to the same ingredient'); checks++;
  const duplicateLineCost = await req(base, `/api/recipes/${duplicateLineRecipe.id}/cost`);
  assert.equal(Number(duplicateLineCost.totalCost), 5, 'recipe cost sums repeated 30 ml and 20 ml lines at 0.10 RUB/ml'); checks++;
  const duplicateLineOrderId = await createOrderFor(duplicateLineProduct.id);
  await req(base, `/api/orders/${duplicateLineOrderId}/close`, 'POST', { paymentMethod: 'cash' }, 200);
  assert.equal(await getBalance(duplicateLineIngredient.id), 50, 'sale depletes the combined 50 ml requirement exactly once'); checks++;
  assert.equal(await getOrderCost(duplicateLineOrderId), 5, 'order COGS contains the combined repeated-ingredient cost'); checks++;
  const duplicateLineMovement = await client.query(`SELECT COUNT(*)::int AS count,COALESCE(SUM(quantity),0)::numeric AS quantity
    FROM stock_movements WHERE venue_id=$1 AND order_id=$2 AND ingredient_id=$3 AND direction='out'`,
  [venueId, duplicateLineOrderId, duplicateLineIngredient.id]);
  assert.deepEqual(duplicateLineMovement.rows[0], { count: 1, quantity: '50.000000' }, 'duplicate recipe lines become one order-linked 50 ml stock movement'); checks++;

  await req(base, '/api/product-categories', 'POST', { name: 'Табаки', department: 'hookah' }, 201);
  const tobacco = await req(base, '/api/inventory/items', 'POST', {
    name: 'QA tobacco 100g pack', unit: 'г', purchaseUnit: 'пачка', packMultiplier: 100,
    itemType: 'ingredient', cost: 0, department: 'hookah', category: 'Табаки',
  }, 201);
  const tobaccoReceipt = await req(base, '/api/inventory/purchase-documents', 'POST', {
    supplierName: 'Synthetic tobacco supplier', documentNumber: '', documentDate: '',
    lines: [{ ingredientId: tobacco.id, quantity: 1, unit: 'пачка', unitCost: 120 }],
  }, 201);
  assert.equal(tobaccoReceipt.documentNumber, null, 'supplier invoice number is genuinely optional');
  assert.equal(tobaccoReceipt.documentDate, null, 'blank supplier invoice date stays NULL and is not replaced with today');
  assert.ok(tobaccoReceipt.recordedAt, 'system creation timestamp remains separate from the nullable supplier date');
  assert.equal(Number(tobaccoReceipt.totalCost), 120, 'purchase value is price per 100g pack, not per gram');
  assert.equal(Number(tobaccoReceipt.lines[0].stockQuantity), 100, 'one 100g tobacco pack adds exactly 100g to stock');
  assert.equal(Number(tobaccoReceipt.lines[0].receiptUnitCost), 1.2, 'pack purchase price normalizes to 1.20 RUB per stock gram'); checks += 6;
  await req(base, `/api/inventory/purchase-documents/${tobaccoReceipt.id}/post`, 'POST', {}, 200);
  assert.equal(await getBalance(tobacco.id), 100, 'posting the pack receipt writes 100g to the stock ledger'); checks++;
  const tobaccoProduct = await req(base, '/api/products', 'POST', { name: 'QA hookah card', category: 'Кальян', price: 500 }, 201);
  const tobaccoRecipe = await req(base, '/api/recipes', 'POST', {
    productId: tobaccoProduct.id, name: tobaccoProduct.name,
    ingredients: [{ ingredientId: tobacco.id, name: tobacco.name, quantity: '18 г' }],
    yieldQuantity: 1, yieldUnit: 'порция', portionCount: 1,
  }, 201);
  const tobaccoOrder = await req(base, '/api/orders', 'POST', { tableId }, 201);
  await req(base, `/api/orders/${tobaccoOrder.id}/items`, 'POST', { productId: tobaccoProduct.id, quantity: 1 }, 201);
  const hookahStaffLogin = `qa-hookah-${venueId}`;
  const hookahPasswordSalt = randomBytes(16).toString('hex');
  const hookahPasswordHash = `scrypt$${hookahPasswordSalt}$${scryptSync('qa-hookah-password', hookahPasswordSalt, 64).toString('hex')}`;
  const hookahStaff = await client.query(`INSERT INTO users (organization_id,venue_id,full_name,login,password_hash,role)
    VALUES ($1,$2,'QA Кальянщик',$3,$4,'hookah_master') RETURNING id`, [organizationId, venueId, hookahStaffLogin, hookahPasswordHash]);
  await client.query("INSERT INTO organization_memberships (organization_id,user_id,membership_role,status) VALUES ($1,$2,'member','active')", [organizationId, hookahStaff.rows[0].id]);
  const hookahLoginResponse = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Organization-Id': organizationId }, body: JSON.stringify({ username: hookahStaffLogin, password: 'qa-hookah-password' }) });
  const hookahLogin = await hookahLoginResponse.json();
  assert.equal(hookahLoginResponse.status, 200, 'PostgreSQL hookah worker can sign in to the separate staff account');
  assert.ok(hookahLogin.permissions.includes('hookah_tasks') && hookahLogin.permissions.includes('orders'), 'hookah worker receives hookah task and order permissions');
  assert.ok(!hookahLogin.permissions.includes('inventory') && !hookahLogin.permissions.includes('inventory_read'), 'hookah worker has no direct warehouse permission'); checks += 3;
  await authenticatedReq(base, hookahLogin.token, '/api/inventory', 'GET', undefined, 403);
  await authenticatedReq(base, hookahLogin.token, '/api/inventory/movements', 'POST', { itemId: tobacco.id, delta: -1, unit: 'г', reason: 'Forbidden QA staff movement' }, 403);
  await authenticatedReq(base, hookahLogin.token, '/api/orders', 'GET');
  const hookahTasks = await authenticatedReq(base, hookahLogin.token, '/api/tasks');
  assert.ok(Array.isArray(hookahTasks.items), 'hookah worker can read own operational tasks'); checks++;
  await req(base, `/api/orders/${tobaccoOrder.id}/close`, 'POST', { paymentMethod: 'cash' }, 200);
  const hookahOrderRead = await authenticatedReq(base, hookahLogin.token, '/api/orders?scope=all');
  assert.ok(hookahOrderRead.items.some((order) => order.id === tobaccoOrder.id && order.status === 'closed'), 'hookah worker can re-read the completed sale after warehouse depletion'); checks++;
  assert.equal(await getBalance(tobacco.id), 82, 'one sold hookah card debits exactly 18g from the 100g pack');
  assert.equal(await getOrderCost(tobaccoOrder.id), 21.6, '18g at 1.20 RUB/g produces 21.60 RUB historical recipe COGS'); checks += 5;
  const microTobaccoProduct = await req(base, '/api/products', 'POST', { name: 'QA micro tobacco recipe', category: 'Кальян', price: 50 }, 201);
  await req(base, '/api/recipes', 'POST', {
    productId: microTobaccoProduct.id, name: microTobaccoProduct.name,
    ingredients: [{ ingredientId: tobacco.id, name: tobacco.name, quantity: '0.0006 г' }],
    yieldQuantity: 1, yieldUnit: 'порция', portionCount: 1,
  }, 201);
  const microTobaccoOrder = await req(base, '/api/orders', 'POST', { tableId }, 201);
  await req(base, `/api/orders/${microTobaccoOrder.id}/items`, 'POST', { productId: microTobaccoProduct.id, quantity: 1 }, 201);
  await req(base, `/api/orders/${microTobaccoOrder.id}/close`, 'POST', { paymentMethod: 'cash' }, 200);
  assert.equal(await getBalance(tobacco.id), 81.9994, 'recipe sales retain a six-decimal ingredient debit in the stock ledger'); checks++;

  const categoryCatalog = await req(base, '/api/product-categories', 'GET', undefined, 200);
  const strongSpiritsCategory = categoryCatalog.items.find((item) => item.department === 'bar' && item.name === 'Крепкий алкоголь' && item.active !== false);
  assert.ok(strongSpiritsCategory, 'new venue receives the canonical bar category'); checks++;
  const raceStock = await req(base, '/api/inventory/items', 'POST', {
    name: 'QA concurrent close stock', unit: 'шт', itemType: 'ingredient', cost: 1,
    department: 'bar', category: strongSpiritsCategory.name, categoryId: strongSpiritsCategory.id,
  }, 201);
  await req(base, '/api/inventory/movements', 'POST', { itemId: raceStock.id, delta: 1, unit: 'шт', reason: 'One unit for concurrent close QA' }, 201);
  const concurrentProduct = await req(base, '/api/products', 'POST', { name: 'QA concurrent stock product', category: 'Бар', price: 150 }, 201);
  await req(base, '/api/recipes', 'POST', {
    productId: concurrentProduct.id, name: concurrentProduct.name,
    ingredients: [{ ingredientId: raceStock.id, name: raceStock.name, quantity: '1 шт' }],
    yieldQuantity: 1, yieldUnit: 'порция', portionCount: 1,
  }, 201);
  const concurrentOrderA = await createOrderFor(concurrentProduct.id);
  const concurrentOrderB = await createOrderFor(concurrentProduct.id);
  const concurrentCloseResults = await Promise.all([concurrentOrderA, concurrentOrderB].map(async (orderId) => {
    const response = await fetch(`${base}/api/orders/${orderId}/close`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${sessionToken}`, 'X-Organization-Id': organizationId, 'Content-Type': 'application/json' },
      body: JSON.stringify({ paymentMethod: 'cash' }),
    });
    return { status: response.status, data: await response.json() };
  }));
  const successfulCloses = concurrentCloseResults.filter((result) => result.status === 200);
  const rejectedCloses = concurrentCloseResults.filter((result) => result.status === 409);
  assert.equal(successfulCloses.length, 1, 'only one competing order can consume the final unit');
  assert.equal(rejectedCloses.length, 1, 'the competing order fails cleanly when the shared stock is gone');
  assert.equal(await getBalance(raceStock.id), 0, 'concurrent recipe closes cannot drive the ledger balance below zero');
  const concurrentLedger = await client.query(`SELECT COUNT(*) FILTER (WHERE direction='in')::int AS receipts,
    COUNT(*) FILTER (WHERE direction='out')::int AS depletions
    FROM stock_movements WHERE venue_id=$1 AND ingredient_id=$2`, [venueId, raceStock.id]);
  assert.deepEqual(concurrentLedger.rows[0], { receipts: 1, depletions: 1 }, 'concurrent close records exactly one receipt and one depletion'); checks += 4;
  const concurrentOrderState = await client.query(`SELECT o.id,o.status,
    (SELECT count(*)::int FROM payments p WHERE p.order_id=o.id) AS payments
    FROM orders o WHERE o.id=ANY($1::uuid[])`, [[concurrentOrderA, concurrentOrderB]]);
  assert.deepEqual(concurrentOrderState.rows.map((row) => row.status).sort(), ['closed', 'open'], 'losing close leaves its order open');
  assert.deepEqual(concurrentOrderState.rows.filter((row) => row.status === 'open').map((row) => row.payments), [0], 'losing close rolls back its payment'); checks += 2;

  const spirit = await req(base, '/api/inventory/items', 'POST', {
    name: 'QA spirit 700ml bottle', unit: 'мл', purchaseUnit: 'бутылка', packMultiplier: 700,
    itemType: 'ingredient', cost: 0, department: 'bar', category: 'Крепкий алкоголь',
  }, 201);
  const spiritReceipt = await req(base, '/api/inventory/purchase-documents', 'POST', {
    supplierName: 'Synthetic spirit supplier', documentNumber: `QA-BOTTLE-${venueId.slice(0, 8)}`,
    documentDate: currentDate, lines: [{ ingredientId: spirit.id, quantity: 1, unit: 'бутылка', unitCost: 350 }],
  }, 201);
  assert.equal(Number(spiritReceipt.lines[0].stockQuantity), 700, 'one 700ml bottle converts to 700ml of stock');
  assert.equal(Number(spiritReceipt.lines[0].receiptUnitCost), 0.5, 'bottle cost normalizes to 0.50 RUB per ml'); checks += 2;
  await req(base, `/api/inventory/purchase-documents/${spiritReceipt.id}/post`, 'POST', {}, 200);
  const spiritProduct = await req(base, '/api/products', 'POST', { name: 'QA cocktail', category: 'Коктейли', price: 300 }, 201);
  await req(base, '/api/recipes', 'POST', {
    productId: spiritProduct.id, name: spiritProduct.name,
    ingredients: [{ ingredientId: spirit.id, name: spirit.name, quantity: '50 мл' }],
    yieldQuantity: 1, yieldUnit: 'порция', portionCount: 1,
  }, 201);
  const spiritOrder = await req(base, '/api/orders', 'POST', { tableId }, 201);
  await req(base, `/api/orders/${spiritOrder.id}/items`, 'POST', { productId: spiritProduct.id, quantity: 1 }, 201);
  await req(base, `/api/orders/${spiritOrder.id}/close`, 'POST', { paymentMethod: 'cash' }, 200);
  assert.equal(await getBalance(spirit.id), 650, 'one 50ml cocktail leaves 650ml in a 700ml bottle');
  assert.equal(await getOrderCost(spiritOrder.id), 25, '50ml at 0.50 RUB/ml produces 25 RUB historical recipe COGS'); checks += 4;
  const nonStockProduct = await req(base, '/api/products', 'POST', {
    name: `QA explicit non-stock service ${venueId.slice(0, 8)}`, category: 'Услуги', price: 150, inventoryMode: 'non_stock',
  }, 201);
  const nonStockOrderId = await createOrderFor(nonStockProduct.id);
  const nonStockClose = await req(base, `/api/orders/${nonStockOrderId}/close`, 'POST', { paymentMethod: 'cash' }, 200);
  assert.equal(nonStockClose.status, 'closed', 'explicit non-stock service can close without a recipe');
  assert.equal(await getOrderCost(nonStockOrderId), 0, 'explicit non-stock service persists an honest zero COGS snapshot'); checks += 2;
  const nonStockRecipeBinding = await req(base, '/api/recipes', 'POST', {
    productId: nonStockProduct.id, name: nonStockProduct.name,
    ingredients: [{ ingredientId: spirit.id, name: spirit.name, quantity: '10 мл' }],
    yieldQuantity: 1, yieldUnit: 'порция', portionCount: 1,
  }, 409);
  assert.equal(nonStockRecipeBinding.error, 'non_stock_product_has_recipe', 'non-stock products cannot silently carry ignored sale recipes'); checks++;

  const emptyLegacyProduct = await req(base, '/api/products', 'POST', {
    name: `QA empty legacy recipe ${venueId.slice(0, 8)}`, category: 'Бар', price: 150,
  }, 201);
  await client.query('INSERT INTO recipes (product_id) VALUES ($1)', [emptyLegacyProduct.id]);
  const emptyLegacyOrderId = await createOrderFor(emptyLegacyProduct.id);
  const emptyLegacyClose = await req(base, `/api/orders/${emptyLegacyOrderId}/close`, 'POST', { paymentMethod: 'cash' }, 409);
  assert.equal(emptyLegacyClose.error, 'product_recipe_required', 'an empty legacy recipe header is not accepted as a stock recipe'); checks++;
  rejectedState = await client.query(`SELECT o.status,
      (SELECT count(*)::int FROM payments p WHERE p.order_id=o.id) AS payments,
      (SELECT count(*)::int FROM order_costs c WHERE c.order_id=o.id) AS cogs
    FROM orders o WHERE o.id=$1`, [emptyLegacyOrderId]);
  assert.deepEqual(rejectedState.rows[0], { status: 'open', payments: 0, cogs: 0 }, 'empty legacy recipe rejection leaves the order untouched'); checks++;
  const modeBlockedByOpenOrder = await req(base, `/api/products/${emptyLegacyProduct.id}`, 'PATCH', { inventoryMode: 'non_stock' }, 409);
  assert.equal(modeBlockedByOpenOrder.error, 'product_has_open_orders', 'a live order prevents changing the stock-accounting mode'); checks++;
  await req(base, `/api/orders/${emptyLegacyOrderId}`, 'DELETE', { comment: 'QA resolve empty legacy recipe', writeoff: false }, 200);
  const emptyLegacyResolved = await req(base, `/api/products/${emptyLegacyProduct.id}`, 'PATCH', { inventoryMode: 'non_stock' }, 200);
  assert.equal(emptyLegacyResolved.inventoryMode, 'non_stock', 'an unusable legacy recipe header does not block explicit non-stock classification'); checks++;
  const resolvedLegacyOrderId = await createOrderFor(emptyLegacyProduct.id);
  const resolvedLegacyClose = await req(base, `/api/orders/${resolvedLegacyOrderId}/close`, 'POST', { paymentMethod: 'cash' }, 200);
  assert.equal(resolvedLegacyClose.status, 'closed', 'a legacy item can close after its inventory mode is explicitly resolved'); checks++;

  const sameName = `QA ambiguous generic ${venueId.slice(0, 8)}`;
  const genericA = await req(base, '/api/products', 'POST', { name: sameName, category: 'Бар', price: 150 }, 201);
  const genericB = await req(base, '/api/products', 'POST', { name: sameName, category: 'Бар', price: 150 }, 201);
  await req(base, '/api/recipes', 'POST', {
    name: sameName,
    ingredients: [{ ingredientId: spirit.id, name: spirit.name, quantity: '10 мл' }],
    yieldQuantity: 1, yieldUnit: 'порция', portionCount: 1,
  }, 201);
  for (const duplicateProduct of [genericA, genericB]) {
    const duplicateOrderId = await createOrderFor(duplicateProduct.id);
    const duplicateClose = await req(base, `/api/orders/${duplicateOrderId}/close`, 'POST', { paymentMethod: 'cash' }, 409);
    assert.equal(duplicateClose.error, 'product_recipe_ambiguous', 'one name-only recipe cannot be assigned to duplicate product names'); checks++;
  }

  const duplicateDirectProduct = await req(base, '/api/products', 'POST', {
    name: `QA multiple direct cards ${venueId.slice(0, 8)}`, category: 'Бар', price: 150,
  }, 201);
  const duplicateCardIngredients = JSON.stringify([{ ingredientId: spirit.id, name: spirit.name, quantity: '10 мл', unit: 'мл' }]);
  await client.query("INSERT INTO inventory_recipe_cards (venue_id,product_id,name,ingredients,recipe_type) VALUES ($1,$2,$3,$4::jsonb,'sale'),($1,$2,$3 || ' copy',$4::jsonb,'sale')", [venueId, duplicateDirectProduct.id, duplicateDirectProduct.name, duplicateCardIngredients]);
  const duplicateDirectOrderId = await createOrderFor(duplicateDirectProduct.id);
  const duplicateDirectClose = await req(base, `/api/orders/${duplicateDirectOrderId}/close`, 'POST', { paymentMethod: 'cash' }, 409);
  assert.equal(duplicateDirectClose.error, 'product_recipe_ambiguous', 'multiple active directly-bound sale cards fail closed instead of choosing the latest'); checks++;

  const raceProduct = await req(base, '/api/products', 'POST', {
    name: `QA mode/order race ${venueId.slice(0, 8)}`, category: 'Бар', price: 150,
  }, 201);
  const raceTable = await ownerReq(base, sessionToken, '/api/floor/tables', 'POST', { expectedVenueId: venueId, zoneId, name: `QA race table ${randomUUID().slice(0, 8)}`, capacity: 2 }, 201);
  const raceOrder = await req(base, '/api/orders', 'POST', { tableId: raceTable.id }, 201);
  const [raceModeResponse, raceItemResponse] = await Promise.all([
    fetch(`${base}/api/products/${raceProduct.id}`, { method: 'PATCH', headers: { Authorization: `Bearer ${sessionToken}`, 'X-Organization-Id': organizationId, 'Content-Type': 'application/json' }, body: JSON.stringify({ inventoryMode: 'non_stock' }) }),
    fetch(`${base}/api/orders/${raceOrder.id}/items`, { method: 'POST', headers: { Authorization: `Bearer ${sessionToken}`, 'X-Organization-Id': organizationId, 'Content-Type': 'application/json' }, body: JSON.stringify({ productId: raceProduct.id, quantity: 1 }) }),
  ]);
  const [raceMode, raceItem] = await Promise.all([raceModeResponse.json(), raceItemResponse.json()]);
  assert.ok([200, 409].includes(raceModeResponse.status), `mode transition race returned ${raceModeResponse.status}: ${JSON.stringify(raceMode)}`);
  assert.equal(raceItemResponse.status, 201, `serialized order-item insertion succeeds: ${JSON.stringify(raceItem)}`);
  const raceState = (await client.query('SELECT p.inventory_mode,o.status FROM products p JOIN order_items oi ON oi.product_id=p.id JOIN orders o ON o.id=oi.order_id WHERE p.id=$1 AND o.id=$2', [raceProduct.id, raceOrder.id])).rows[0];
  assert.ok((raceModeResponse.status === 200 && raceState.inventory_mode === 'non_stock') || (raceModeResponse.status === 409 && raceState.inventory_mode === 'tracked'), 'mode update and order-item insertion serialize on the product row'); checks += 3;
  if (raceState.inventory_mode === 'non_stock') {
    assert.equal((await req(base, `/api/orders/${raceOrder.id}/close`, 'POST', { paymentMethod: 'cash' }, 200)).status, 'closed', 'order started after explicit non-stock mode may close');
  } else {
    assert.equal((await req(base, `/api/orders/${raceOrder.id}/close`, 'POST', { paymentMethod: 'cash' }, 409)).error, 'product_recipe_required', 'tracked item cannot close without its recipe after rejected mode transition');
  }

  const recipeRaceProduct = await req(base, '/api/products', 'POST', {
    name: `QA mode/recipe race ${venueId.slice(0, 8)}`, category: 'Бар', price: 150,
  }, 201);
  const recipeRacePayload = {
    productId: recipeRaceProduct.id, name: recipeRaceProduct.name,
    ingredients: [{ ingredientId: spirit.id, name: spirit.name, quantity: '10 мл' }],
    yieldQuantity: 1, yieldUnit: 'порция', portionCount: 1,
  };
  const [recipeRaceModeResponse, recipeRaceCardResponse] = await Promise.all([
    fetch(`${base}/api/products/${recipeRaceProduct.id}`, { method: 'PATCH', headers: { Authorization: `Bearer ${sessionToken}`, 'X-Organization-Id': organizationId, 'Content-Type': 'application/json' }, body: JSON.stringify({ inventoryMode: 'non_stock' }) }),
    fetch(`${base}/api/recipes`, { method: 'POST', headers: { Authorization: `Bearer ${sessionToken}`, 'X-Organization-Id': organizationId, 'Content-Type': 'application/json' }, body: JSON.stringify(recipeRacePayload) }),
  ]);
  const [recipeRaceMode, recipeRaceCard] = await Promise.all([recipeRaceModeResponse.json(), recipeRaceCardResponse.json()]);
  assert.ok((recipeRaceModeResponse.status === 200 && recipeRaceCardResponse.status === 409)
    || (recipeRaceModeResponse.status === 409 && recipeRaceCardResponse.status === 201),
  `mode transition and sale-recipe binding serialize; mode=${recipeRaceModeResponse.status} ${JSON.stringify(recipeRaceMode)}, recipe=${recipeRaceCardResponse.status} ${JSON.stringify(recipeRaceCard)}`);
  assert.equal(recipeRaceModeResponse.status === 200 ? recipeRaceCard.error : recipeRaceMode.error, 'non_stock_product_has_recipe', 'only one of the competing stock-mode and recipe-binding changes may commit'); checks += 2;

  await req(base, '/api/inventory/movements', 'POST', { itemId: raceStock.id, delta: 1, unit: 'шт', reason: 'One unit for duplicate close QA' }, 201);
  const duplicateRaceOrder = await createOrderFor(concurrentProduct.id);
  const duplicateRaceStartBalance = await getBalance(raceStock.id);
  const duplicateCloseResults = await Promise.all([1, 2].map(async () => {
    const response = await fetch(`${base}/api/orders/${duplicateRaceOrder}/close`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${sessionToken}`, 'X-Organization-Id': organizationId, 'Content-Type': 'application/json' },
      body: JSON.stringify({ paymentMethod: 'cash' }),
    });
    return { status: response.status, data: await response.json() };
  }));
  assert.deepEqual(duplicateCloseResults.map((result) => result.status).sort(), [200, 409], 'concurrent close requests for one order serialize to one success and one conflict'); checks++;
  assert.equal(duplicateCloseResults.find((result) => result.status === 200).data.status, 'closed', 'winning duplicate-close response reports a closed order');
  assert.equal(duplicateCloseResults.find((result) => result.status === 409).data.error, 'order_already_final', 'losing duplicate-close response reports the finalized order'); checks += 2;
  const duplicateCloseState = await client.query(`SELECT o.status,
    (SELECT COUNT(*)::int FROM payments p WHERE p.order_id=o.id AND p.status='paid') AS payments,
    (SELECT COUNT(*)::int FROM order_costs c WHERE c.order_id=o.id) AS cost_snapshots,
    (SELECT COUNT(*)::int FROM stock_movements m WHERE m.order_id=o.id AND m.ingredient_id=$2 AND m.direction='out') AS depletions,
    (SELECT COALESCE(SUM(m.quantity),0)::numeric FROM stock_movements m WHERE m.order_id=o.id AND m.ingredient_id=$2 AND m.direction='out') AS depleted
    FROM orders o WHERE o.id=$1 AND o.venue_id=$3`, [duplicateRaceOrder, raceStock.id, venueId]);
  const duplicateCloseFacts = duplicateCloseState.rows[0];
  assert.deepEqual({ status: duplicateCloseFacts.status, payments: duplicateCloseFacts.payments, cost_snapshots: duplicateCloseFacts.cost_snapshots, depletions: duplicateCloseFacts.depletions },
    { status: 'closed', payments: 1, cost_snapshots: 1, depletions: 1 }, 'one same-order close commits exactly one payment, cost snapshot, and recipe debit');
  assert.equal(Number(duplicateCloseFacts.depleted), 1, 'the single same-order recipe movement records one portion'); checks += 2;
  assert.equal(duplicateRaceStartBalance - await getBalance(raceStock.id), 1, 'concurrent duplicate close depletes exactly one recipe portion'); checks++;

  console.log(`RECIPE DEPLETION POSTGRES API QA: PASS (${checks} assertions; venue-local work log→purchase/payment→stock→pack/bottle conversions→tobacco and cocktail recipes→sale/depletion→COGS→payroll→P&L/cashflow; all data is synthetic)`);
} finally {
  if (server && server.exitCode === null) {
    server.kill();
    await Promise.race([new Promise((resolve) => server.once('exit', resolve)), delay(3000)]);
  }
  if (client._connected) {
    if (!runnerOwnsDatabase) await cleanSyntheticVenue(venueId);
    await client.end();
  }
}
