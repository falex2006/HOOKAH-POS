import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { Pool } from 'pg';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { assertQaDatabaseIdentity, isDisposableLoopbackQaContainer, validateQaDatabaseUrl } from './postgres-qa-safety.mjs';

const base = process.argv[2] || 'http://127.0.0.1:3219';
const target = new URL(base);
if (!['127.0.0.1', 'localhost'].includes(target.hostname) || target.port !== '3219' || process.env.CRM_QA_DATABASE_NAME !== 'territory_qa') {
  throw new Error('Use the isolated port 3219 server and explicitly identify territory_qa');
}
const databaseUrl = process.env.MIGRATIONS_PG_TEST_DATABASE_URL;
const identity = validateQaDatabaseUrl(databaseUrl, 'purchase auto-order QA database');
assert.equal(identity.database, 'territory_qa');
const expectedPgPort = Number(process.env.MIGRATIONS_PG_TEST_PORT || 55433);
assert.ok(Number.isInteger(expectedPgPort) && expectedPgPort > 0 && expectedPgPort <= 65535,
  'MIGRATIONS_PG_TEST_PORT must be a valid TCP port');
assert.equal(Number(identity.url.port), expectedPgPort, 'use the explicitly configured disposable QA PostgreSQL port');
const pool = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5000 });
try {
  const { rows } = await pool.query(`SELECT current_database() AS database, inet_server_addr()::text AS address,
    inet_server_port() AS port, COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname=current_user),false) AS superuser`);
  assertQaDatabaseIdentity(rows[0], identity.database, expectedPgPort, 'purchase auto-order QA database');
  const containerName = process.env.MIGRATIONS_PG_TEST_DOCKER_CONTAINER;
  if (!containerName) throw new Error('This fixture test requires a disposable QA PostgreSQL container');
  const inspected = spawnSync('docker', ['inspect', containerName], { encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024 });
  if (inspected.error || inspected.status !== 0) throw new Error('Disposable QA PostgreSQL container unavailable');
  const container = JSON.parse(inspected.stdout)[0];
  assert.ok(isDisposableLoopbackQaContainer(container, rows[0].address, Number(rows[0].port), expectedPgPort), 'QA PostgreSQL must be an auto-removed, loopback-only disposable container');
} finally { await pool.end(); }
const fixturePool = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5000 });
try {
  await fixturePool.query("INSERT INTO venues (id,name) VALUES ('00000000-0000-0000-0000-000000000001','QA auto-order venue') ON CONFLICT (id) DO NOTHING");
  await fixturePool.query("UPDATE venues SET organization_id='00000000-0000-0000-0000-000000000010' WHERE id='00000000-0000-0000-0000-000000000001'");
  await fixturePool.query("INSERT INTO inventory_departments (venue_id,code,name) VALUES ('00000000-0000-0000-0000-000000000001','bar','Бар') ON CONFLICT (venue_id,code) DO NOTHING");
} catch (error) {
  await fixturePool.end();
  throw error;
}
await new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once('error', reject);
  probe.listen(3219, '127.0.0.1', () => probe.close(resolve));
});
const child = spawn(process.execPath, [fileURLToPath(new URL('../server.js', import.meta.url))], {
  cwd: fileURLToPath(new URL('..', import.meta.url)), windowsHide: true, stdio: 'ignore',
  env: { ...process.env, DATABASE_URL: databaseUrl, HOST: '127.0.0.1', PORT: '3219', AUTH_REQUIRED: 'false', DEMO_MODE: 'false', VENUE_ID: '00000000-0000-0000-0000-000000000001' },
});
let childError = null;
child.on('error', (error) => { childError = error; });
let serverReady = false;
for (let attempt = 0; attempt < 40; attempt += 1) {
  if (childError) throw childError;
  if (child.exitCode !== null) throw new Error('Isolated QA server exited before health check');
  try {
    const response = await fetch(`${base}/api/health`);
    if (response.ok && (await response.json()).database === 'postgres') { serverReady = true; break; }
  } catch {}
  await new Promise((resolve) => setTimeout(resolve, 250));
}
if (!serverReady) { child.kill(); throw new Error('Isolated QA PostgreSQL server did not become healthy'); }
const request = async (path, method = 'GET', input, expectedStatus = 200) => {
  const response = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: input === undefined ? undefined : JSON.stringify(input) });
  const data = await response.json();
  assert.equal(response.status, expectedStatus, `${method} ${path}: ${JSON.stringify(data)}`);
  return data;
};
try {
const health = await request('/api/health');
assert.equal(health.database, 'postgres', 'QA server must use PostgreSQL');

const suffix = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
const item = await request('/api/inventory/items', 'POST', {
  name: `QA Поступление ${suffix}`, department: 'bar', itemType: 'ingredient', unit: 'мл',
  purchaseUnit: 'бутылка', packMultiplier: 1000, cost: 0.5, minLevel: 20,
}, 201);
assert.equal(Number(item.onHand || 0), 0);
const suggestions = await request('/api/inventory/auto-orders');
assert.ok(suggestions.items.some((entry) => entry.id === item.id), 'new low-stock item appears in recommendations');
const order = await request('/api/inventory/auto-orders', 'POST', { items: [{ itemId: item.id, quantity: 2000 }] }, 201);
assert.equal(order.status, 'sent');
assert.equal(Number(order.lines[0].receivedQuantity), 0);

const createDraft = (number, sourceAutoOrderId = order.id) => request('/api/inventory/purchase-documents', 'POST', {
  supplierName: 'QA поставщик', documentNumber: `QA-${suffix}-${number}`, sourceAutoOrderId,
  lines: [{ ingredientId: item.id, quantity: 1, unit: 'бутылка', unitCost: 250 }],
}, 201);
const firstDraft = await createDraft('1');
assert.equal(firstDraft.status, 'draft');
assert.equal(Number(firstDraft.lines[0].stockQuantity), 1000);
assert.equal(Number((await request('/api/inventory')).items.find((entry) => entry.id === item.id).onHand), 0, 'draft must not change stock');
await request(`/api/inventory/auto-orders/${order.id}`, 'PATCH', { status: 'cancelled' }, 409);

const posted = await request(`/api/inventory/purchase-documents/${firstDraft.id}/post`, 'POST', undefined, 200);
assert.equal(posted.document.status, 'posted');
assert.equal(Number((await request('/api/inventory')).items.find((entry) => entry.id === item.id).onHand), 1000);
await request(`/api/inventory/purchase-documents/${firstDraft.id}/post`, 'POST', undefined, 409);
let refreshedOrder = (await request('/api/inventory/auto-orders')).requests.find((entry) => entry.id === order.id);
assert.equal(refreshedOrder.status, 'partially_received');
assert.equal(Number(refreshedOrder.lines[0].receivedQuantity), 1000);

const abandonedDraft = await createDraft('void');
const voided = await request(`/api/inventory/purchase-documents/${abandonedDraft.id}/void`, 'POST');
assert.equal(voided.status, 'voided');
assert.equal(Number((await request('/api/inventory')).items.find((entry) => entry.id === item.id).onHand), 1000, 'void must not change stock');
refreshedOrder = (await request('/api/inventory/auto-orders')).requests.find((entry) => entry.id === order.id);
assert.equal(Number(refreshedOrder.lines[0].receivedQuantity), 1000, 'void must not count as received');

const finalDraft = await createDraft('2');
await request(`/api/inventory/purchase-documents/${finalDraft.id}/post`, 'POST');
refreshedOrder = (await request('/api/inventory/auto-orders')).requests.find((entry) => entry.id === order.id);
assert.equal(refreshedOrder.status, 'received');
assert.equal(Number(refreshedOrder.lines[0].receivedQuantity), 2000);
const finalStock = (await request('/api/inventory')).items.find((entry) => entry.id === item.id);
assert.equal(Number(finalStock.onHand), 2000);
assert.equal(Number(finalStock.cost), 0.25);

const fractionalItem = await request('/api/inventory/items', 'POST', {
  name: `QA fractional receipt ${suffix}`, department: 'bar', itemType: 'ingredient', unit: 'кг',
  purchaseUnit: 'микро-пачка', packMultiplier: 0.0006, cost: 0,
}, 201);
const fractionalDraft = await request('/api/inventory/purchase-documents', 'POST', {
  supplierName: 'QA дробный поставщик', documentNumber: `QA-FRACTION-${suffix}`,
  lines: [{ ingredientId: fractionalItem.id, quantity: 1, unit: 'микро-пачка', unitCost: 1 }],
}, 201);
assert.equal(Number(fractionalDraft.lines[0].stockQuantity), 0.0006, 'purchase document retains six-decimal stock quantity');
await request(`/api/inventory/purchase-documents/${fractionalDraft.id}/post`, 'POST', undefined, 200);
assert.equal(Number((await request('/api/inventory')).items.find((entry) => entry.id === fractionalItem.id).onHand), 0.0006,
  'posted receipt and stock ledger preserve the exact fractional quantity');
const fractionalMovement = await request('/api/inventory/movements', 'POST', {
  itemId: fractionalItem.id, delta: -0.0006, unit: 'кг', reason: `QA exact fractional depletion ${suffix}`,
}, 201);
assert.equal(Number(fractionalMovement.onHandAfter), 0, 'manual depletion reaches exactly zero at six decimal places');
assert.equal(Number((await request('/api/inventory')).items.find((entry) => entry.id === fractionalItem.id).onHand), 0,
  're-read balance agrees with the fractional movement ledger');
const fractionalSourceItem = await request('/api/inventory/items', 'POST', {
  name: `QA fractional purchase quantity ${suffix}`, department: 'bar', itemType: 'ingredient', unit: 'мл',
  purchaseUnit: 'бутылка', packMultiplier: 1000, cost: 0,
}, 201);
const fractionalSourceDraft = await request('/api/inventory/purchase-documents', 'POST', {
  supplierName: 'QA точное количество', documentNumber: `QA-SOURCE-FRACTION-${suffix}`,
  lines: [{ ingredientId: fractionalSourceItem.id, quantity: 0.0006, unit: 'бутылка', unitCost: 0.01 }],
}, 201);
assert.equal(Number(fractionalSourceDraft.lines[0].quantity), 0.0006, 'purchase source quantity retains six decimal places');
assert.equal(Number(fractionalSourceDraft.lines[0].stockQuantity), 0.6, 'fractional source quantity converts exactly to base stock quantity');
await request(`/api/inventory/purchase-documents/${fractionalSourceDraft.id}/post`, 'POST', undefined, 200);
assert.equal(Number((await request('/api/inventory')).items.find((entry) => entry.id === fractionalSourceItem.id).onHand), 0.6,
  'posted receipt preserves fractional source quantity through conversion and ledger reread');

const zeroPriceItem = await request('/api/inventory/items', 'POST', {
  name: `QA zero-price receipt ${suffix}`, department: 'bar', itemType: 'ingredient', unit: 'мл',
  purchaseUnit: 'бутылка', packMultiplier: 1000, cost: 0,
}, 201);
const zeroPriceDraft = await request('/api/inventory/purchase-documents', 'POST', {
  supplierName: 'QA бесплатная поставка', documentNumber: `QA-ZERO-PRICE-${suffix}`,
  lines: [{ ingredientId: zeroPriceItem.id, quantity: 1, unit: 'бутылка', unitCost: 0 }],
}, 201);
assert.equal(Number(zeroPriceDraft.lines[0].unitCost), 0, 'draft keeps an explicitly provided zero purchase price');
assert.equal(Number(zeroPriceDraft.lines[0].receiptUnitCost), 0, 'zero purchase price normalizes to zero per base unit');
assert.equal(Number(zeroPriceDraft.lines[0].lineTotal), 0, 'zero purchase price produces an exact zero line total');
assert.equal(Number(zeroPriceDraft.lines[0].stockQuantity), 1000, 'zero price does not erase the converted receipt quantity');
assert.equal(Number((await request('/api/inventory')).items.find((entry) => entry.id === zeroPriceItem.id).onHand), 0,
  'zero-priced draft does not change stock before posting');
const zeroPriceDraftPg = await fixturePool.query(`SELECT d.status,l.unit_cost,l.receipt_unit_cost,l.line_total,l.stock_quantity,l.source_movement_id,
    (SELECT count(*)::int FROM stock_movements m WHERE m.venue_id=$2 AND m.ingredient_id=$3) AS movement_count
  FROM inventory_purchase_documents d JOIN inventory_purchase_document_lines l ON l.document_id=d.id AND l.venue_id=d.venue_id
  WHERE d.id=$1 AND d.venue_id=$2`, [zeroPriceDraft.id, '00000000-0000-0000-0000-000000000001', zeroPriceItem.id]);
assert.equal(zeroPriceDraftPg.rowCount, 1, 'zero-priced draft and line persist for the synthetic venue');
assert.equal(zeroPriceDraftPg.rows[0].status, 'draft');
assert.equal(Number(zeroPriceDraftPg.rows[0].unit_cost), 0);
assert.equal(Number(zeroPriceDraftPg.rows[0].receipt_unit_cost), 0);
assert.equal(Number(zeroPriceDraftPg.rows[0].line_total), 0);
assert.equal(Number(zeroPriceDraftPg.rows[0].stock_quantity), 1000);
assert.equal(zeroPriceDraftPg.rows[0].source_movement_id, null);
assert.equal(zeroPriceDraftPg.rows[0].movement_count, 0, 'zero-priced draft has not written a stock movement');
const zeroPricePosted = await request(`/api/inventory/purchase-documents/${zeroPriceDraft.id}/post`, 'POST', undefined, 200);
assert.equal(zeroPricePosted.document.status, 'posted');
const zeroPriceInventory = (await request('/api/inventory')).items.find((entry) => entry.id === zeroPriceItem.id);
assert.equal(Number(zeroPriceInventory.onHand), 1000, 'posting a zero-priced receipt adds its physical quantity');
assert.equal(Number(zeroPriceInventory.cost), 0, 'posting a zero-priced receipt keeps an explicit zero stock cost');
const zeroPricePostedPg = await fixturePool.query(`SELECT d.status,l.unit_cost,l.receipt_unit_cost,l.line_total,l.stock_quantity,l.source_movement_id,
    m.ingredient_id,m.direction,m.quantity
  FROM inventory_purchase_documents d JOIN inventory_purchase_document_lines l ON l.document_id=d.id AND l.venue_id=d.venue_id
  JOIN stock_movements m ON m.id=l.source_movement_id AND m.venue_id=l.venue_id
  WHERE d.id=$1 AND d.venue_id=$2`, [zeroPriceDraft.id, '00000000-0000-0000-0000-000000000001']);
assert.equal(zeroPricePostedPg.rowCount, 1, 'posted zero-priced line has exactly one linked movement');
assert.equal(zeroPricePostedPg.rows[0].status, 'posted');
assert.equal(Number(zeroPricePostedPg.rows[0].unit_cost), 0);
assert.equal(Number(zeroPricePostedPg.rows[0].receipt_unit_cost), 0);
assert.equal(Number(zeroPricePostedPg.rows[0].line_total), 0);
assert.equal(Number(zeroPricePostedPg.rows[0].stock_quantity), 1000);
assert.ok(zeroPricePostedPg.rows[0].source_movement_id);
assert.equal(zeroPricePostedPg.rows[0].ingredient_id, zeroPriceItem.id);
assert.equal(zeroPricePostedPg.rows[0].direction, 'in');
assert.equal(Number(zeroPricePostedPg.rows[0].quantity), 1000);

const stalePackageItem = await request('/api/inventory/items', 'POST', {
  name: `QA stale package receipt ${suffix}`, department: 'bar', itemType: 'ingredient', unit: 'мл',
  purchaseUnit: 'бутылка', packMultiplier: 1000, cost: 0.5,
}, 201);
const stalePackageDraft = await request('/api/inventory/purchase-documents', 'POST', {
  supplierName: 'QA stale package supplier', documentNumber: `QA-STALE-PACK-${suffix}`,
  lines: [{ ingredientId: stalePackageItem.id, quantity: 1, unit: 'бутылка', unitCost: 250 }],
}, 201);
assert.equal(Number(stalePackageDraft.lines[0].packMultiplier), 1000, 'draft snapshots the original 1000 ml bottle factor');
assert.equal(Number(stalePackageDraft.lines[0].stockQuantity), 1000, 'draft snapshots the corresponding stock quantity');
const staleBaseline = await fixturePool.query(`SELECT i.cost,COUNT(sm.id)::int AS movements,
    COALESCE((SELECT json_agg(json_build_object('orderId',c.order_id,'cost',c.cost) ORDER BY c.order_id)
      FROM order_costs c WHERE c.venue_id=i.venue_id),'[]'::json) AS cogs
  FROM ingredients i LEFT JOIN stock_movements sm ON sm.venue_id=i.venue_id AND sm.ingredient_id=i.id
  WHERE i.id=$1 GROUP BY i.id`, [stalePackageItem.id]);
assert.equal(staleBaseline.rows[0].movements, 0, 'stale package fixture starts without stock movements');
const changedPackage = await request(`/api/inventory/items/${stalePackageItem.id}`, 'PATCH', { packMultiplier: 700 }, 200);
assert.equal(Number(changedPackage.packMultiplier), 700, 'ingredient packaging can change after the draft was saved');
const stalePost = await request(`/api/inventory/purchase-documents/${stalePackageDraft.id}/post`, 'POST', {}, 400);
assert.deepEqual({ error: stalePost.error, detail: stalePost.detail }, {
  error: 'purchase_document_post_failed', detail: 'purchase_item_unit_changed',
}, 'posting a draft with a stale package factor returns the established API error contract');
const staleInventory = (await request('/api/inventory')).items.find((entry) => entry.id === stalePackageItem.id);
assert.equal(Number(staleInventory.onHand), 0, 'rejected stale package receipt does not change on-hand stock');
assert.equal(Number(staleInventory.cost), Number(staleBaseline.rows[0].cost), 'rejected stale package receipt does not change ingredient cost');
const staleFacts = await fixturePool.query(`SELECT d.status,l.source_movement_id,i.cost,COUNT(sm.id)::int AS movements,
    COALESCE((SELECT json_agg(json_build_object('orderId',c.order_id,'cost',c.cost) ORDER BY c.order_id)
      FROM order_costs c WHERE c.venue_id=i.venue_id),'[]'::json) AS cogs
  FROM inventory_purchase_documents d
  JOIN inventory_purchase_document_lines l ON l.document_id=d.id
  JOIN ingredients i ON i.id=l.ingredient_id AND i.venue_id=l.venue_id
  LEFT JOIN stock_movements sm ON sm.venue_id=i.venue_id AND sm.ingredient_id=i.id
  WHERE d.id=$1 AND d.venue_id=$2 GROUP BY d.id,l.id,i.id`, [stalePackageDraft.id, '00000000-0000-0000-0000-000000000001']);
assert.equal(staleFacts.rowCount, 1, 'stored stale draft and line can be re-read after the rejected post');
assert.equal(staleFacts.rows[0].status, 'draft', 'failed posting leaves the purchase document editable as a draft');
assert.equal(staleFacts.rows[0].source_movement_id, null, 'failed posting records no source movement on the draft line');
assert.equal(staleFacts.rows[0].movements, staleBaseline.rows[0].movements, 'failed posting adds no stock movement');
assert.equal(Number(staleFacts.rows[0].cost), Number(staleBaseline.rows[0].cost), 'failed posting preserves stored ingredient cost');
assert.deepEqual(staleFacts.rows[0].cogs, staleBaseline.rows[0].cogs, 'failed posting does not add or change venue COGS snapshots');

const archivedDraftItem = await request('/api/inventory/items', 'POST', {
  name: `QA archived draft ingredient ${suffix}`, department: 'bar', itemType: 'ingredient', unit: 'мл',
  purchaseUnit: 'бутылка', packMultiplier: 1000, cost: 0.5,
}, 201);
const archivedOrder = await request('/api/inventory/auto-orders', 'POST', { items: [{ itemId: archivedDraftItem.id, quantity: 1000 }] }, 201);
const archivedDraft = await request('/api/inventory/purchase-documents', 'POST', {
  supplierName: 'QA archive with open draft', documentNumber: `QA-ARCHIVE-DRAFT-${suffix}`, sourceAutoOrderId: archivedOrder.id,
  lines: [{ ingredientId: archivedDraftItem.id, quantity: 1, unit: 'бутылка', unitCost: 250 }],
}, 201);
assert.equal(archivedDraft.status, 'draft', 'archive fixture has a saved open purchase draft');
assert.equal(archivedDraft.lines[0].ingredientId, archivedDraftItem.id, 'open draft references the synthetic ingredient');
const archivedDraftItemResponse = await request(`/api/inventory/items/${archivedDraftItem.id}`, 'DELETE', undefined, 200);
assert.equal(archivedDraftItemResponse.id, archivedDraftItem.id, 'zero-stock ingredient can be archived while a draft references it');
const inventoryAfterDraftItemArchive = await request('/api/inventory');
assert.equal(inventoryAfterDraftItemArchive.items.some(entry => entry.id === archivedDraftItem.id), false, 'archived ingredient is omitted from active inventory');
const retainedArchivedDraft = await request(`/api/inventory/purchase-documents/${archivedDraft.id}`);
assert.equal(retainedArchivedDraft.status, 'draft', 'archiving the ingredient does not remove or change the open draft');
assert.equal(retainedArchivedDraft.lines.length, 1, 'open draft line remains readable after ingredient archive');
assert.equal(retainedArchivedDraft.lines[0].ingredientId, archivedDraftItem.id, 'retained draft line remains linked to archived ingredient');
assert.equal(retainedArchivedDraft.lines[0].ingredientName, archivedDraftItem.name, 'retained draft preserves the ingredient name snapshot for editing');
const archivedDraftFacts = await fixturePool.query(`SELECT i.is_marked,d.status,l.ingredient_id,l.source_movement_id,
    (SELECT count(*)::int FROM stock_movements sm WHERE sm.venue_id=d.venue_id AND sm.ingredient_id=i.id) AS movement_count
  FROM ingredients i JOIN inventory_purchase_documents d ON d.id=$2 AND d.venue_id=i.venue_id
  JOIN inventory_purchase_document_lines l ON l.document_id=d.id AND l.venue_id=d.venue_id AND l.ingredient_id=i.id
  WHERE i.id=$1 AND i.venue_id=$3`, [archivedDraftItem.id, archivedDraft.id, '00000000-0000-0000-0000-000000000001']);
assert.equal(archivedDraftFacts.rowCount, 1, 'archived ingredient and its open draft line are venue-scoped and retained in PostgreSQL');
assert.equal(archivedDraftFacts.rows[0].is_marked, false, 'ingredient archive is persisted');
assert.equal(archivedDraftFacts.rows[0].status, 'draft', 'purchase document remains open in PostgreSQL');
assert.equal(archivedDraftFacts.rows[0].ingredient_id, archivedDraftItem.id, 'draft line remains linked in PostgreSQL');
assert.equal(archivedDraftFacts.rows[0].source_movement_id, null, 'unposted draft has no source movement');
assert.equal(archivedDraftFacts.rows[0].movement_count, 0, 'archive and draft retention create no stock movements');
const archivedPost = await request(`/api/inventory/purchase-documents/${archivedDraft.id}/post`, 'POST', undefined, 409);
assert.deepEqual({ error: archivedPost.error, detail: archivedPost.detail, ingredientId: archivedPost.ingredientId }, {
  error: 'purchase_ingredient_archived', detail: 'purchase_ingredient_archived', ingredientId: archivedDraftItem.id,
}, 'archived ingredient cannot be posted from a retained draft');
const archivedOrderAfterPost = (await request('/api/inventory/auto-orders')).requests.find((entry) => entry.id === archivedOrder.id);
assert.ok(archivedOrderAfterPost, 'linked auto-order remains readable after rejected post');
assert.equal(archivedOrderAfterPost.status, 'sent', 'rejected post does not advance linked auto-order');
assert.equal(Number(archivedOrderAfterPost.lines[0].receivedQuantity), 0, 'rejected post does not record received auto-order quantity');
const archivedAfterPost = await request(`/api/inventory/purchase-documents/${archivedDraft.id}`);
assert.equal(archivedAfterPost.status, 'draft', 'rejected post leaves the archived draft open');
const archivedPostFacts = await fixturePool.query(`SELECT d.status,l.source_movement_id,i.cost,
    (SELECT count(*)::int FROM stock_movements sm WHERE sm.venue_id=d.venue_id AND sm.ingredient_id=i.id) AS movement_count
  FROM inventory_purchase_documents d JOIN inventory_purchase_document_lines l ON l.document_id=d.id AND l.venue_id=d.venue_id
  JOIN ingredients i ON i.id=l.ingredient_id AND i.venue_id=l.venue_id WHERE d.id=$1 AND d.venue_id=$2`, [archivedDraft.id, '00000000-0000-0000-0000-000000000001']);
assert.equal(archivedPostFacts.rowCount, 1);
assert.equal(archivedPostFacts.rows[0].status, 'draft');
assert.equal(archivedPostFacts.rows[0].source_movement_id, null, 'rejected post records no line movement');
assert.equal(Number(archivedPostFacts.rows[0].cost), Number(archivedDraftItem.cost), 'rejected post preserves the archived item cost');
assert.equal(archivedPostFacts.rows[0].movement_count, 0, 'rejected post creates no hidden stock movement');
const archivedVoidedDraft = await request(`/api/inventory/purchase-documents/${archivedDraft.id}/void`, 'POST');
assert.equal(archivedVoidedDraft.status, 'voided', 'retained draft can still be voided after item archival');
const archivedOrderAfterVoid = (await request('/api/inventory/auto-orders')).requests.find((entry) => entry.id === archivedOrder.id);
assert.equal(archivedOrderAfterVoid.status, 'sent', 'void leaves the unreceived auto-order open');
assert.equal(Number(archivedOrderAfterVoid.lines[0].receivedQuantity), 0, 'void still does not count archived draft quantity as received');
assert.equal((await request(`/api/inventory/auto-orders/${archivedOrder.id}`, 'PATCH', { status: 'cancelled' }, 200)).status, 'cancelled',
  'voided archived draft releases the auto-order cancellation lock');

const cancellableOrder = await request('/api/inventory/auto-orders', 'POST', { items: [{ itemId: item.id, quantity: 1000 }] }, 201);
const cancellableDraft = await createDraft('cancel', cancellableOrder.id);
await request(`/api/inventory/auto-orders/${cancellableOrder.id}`, 'PATCH', { status: 'cancelled' }, 409);
await request(`/api/inventory/purchase-documents/${cancellableDraft.id}/void`, 'POST');
const cancelled = await request(`/api/inventory/auto-orders/${cancellableOrder.id}`, 'PATCH', { status: 'cancelled' });
assert.equal(cancelled.status, 'cancelled', 'voided draft must release cancellation lock');
const verificationPool = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5000 });
try {
  const { rows: [storedOrder] } = await verificationPool.query('SELECT status,lines FROM inventory_auto_orders WHERE id=$1', [order.id]);
  assert.equal(storedOrder.status, 'received');
  assert.equal(Number(storedOrder.lines[0].receivedQuantity), 2000);
  const { rows: storedDocuments } = await verificationPool.query(`SELECT d.id,d.status,l.source_movement_id AS movement_id
    FROM inventory_purchase_documents d JOIN inventory_purchase_document_lines l ON l.document_id=d.id
    WHERE d.id=ANY($1::uuid[])`, [[firstDraft.id, abandonedDraft.id, finalDraft.id]]);
  const byId = new Map(storedDocuments.map((row) => [row.id, row]));
  assert.equal(byId.get(firstDraft.id).status, 'posted');
  assert.ok(byId.get(firstDraft.id).movement_id);
  assert.equal(byId.get(abandonedDraft.id).status, 'voided');
  assert.equal(byId.get(abandonedDraft.id).movement_id, null);
  assert.equal(byId.get(finalDraft.id).status, 'posted');
  assert.ok(byId.get(finalDraft.id).movement_id);
} finally { await verificationPool.end(); }
console.log('PASS isolated PostgreSQL auto-order → draft → partial receipt → void → full receipt');
} finally {
  child.kill();
  if (child.exitCode === null) await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
  await fixturePool.end();
}
