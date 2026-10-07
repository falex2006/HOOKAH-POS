import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID, randomBytes, scrypt as scryptCallback } from 'node:crypto';
import { promisify } from 'node:util';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertQaDatabaseIdentity, validateQaDatabaseUrl } from './postgres-qa-safety.mjs';

const databaseUrl = process.env.MIGRATIONS_PG_TEST_DATABASE_URL;
const { database, url } = validateQaDatabaseUrl(databaseUrl, 'MIGRATIONS_PG_TEST_DATABASE_URL');
assert.match(database, /^(?:orders_qa|alcohol_api_qa)_[a-f0-9]{16}$/i,
  'API fixtures require a freshly created, runner-owned disposable QA database');
const require = createRequire(import.meta.url);
const { Client } = require('pg');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const client = new Client({ connectionString: url.href, connectionTimeoutMillis: 5000 });
const orgA = randomUUID(), orgB = randomUUID();
const venueA1 = randomUUID(), venueA2 = randomUUID(), venueB = randomUUID();
const ownerA = randomUUID(), managerA = randomUUID(), bartenderA = randomUUID(), ownerB = randomUUID();
const password = `qa-${randomUUID()}`;
const loginPrefix = `alcohol-${randomUUID()}`;
const users = [
  { id: ownerA, venue: venueA1, org: orgA, role: 'owner', suffix: 'owner-a' },
  { id: managerA, venue: venueA2, org: orgA, role: 'manager', suffix: 'manager-a' },
  { id: bartenderA, venue: venueA1, org: orgA, role: 'bartender', suffix: 'bartender-a' },
  { id: ownerB, venue: venueB, org: orgB, role: 'owner', suffix: 'owner-b' },
];
const logins = Object.fromEntries(users.map((user) => [user.suffix, `${loginPrefix}-${user.suffix}`]));
const salt = randomBytes(16).toString('hex');
const passwordHash = `scrypt$${salt}$${(await promisify(scryptCallback)(password, salt, 64)).toString('hex')}`;
let server, exitWait, output = '', base = '';
const api = async (route, method = 'GET', body, token = '', expected = 200) => {
  const response = await fetch(`${base}${route}`, { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const payload = await response.json().catch(() => ({}));
  assert.equal(response.status, expected, `${method} ${route}: ${JSON.stringify(payload)}`);
  return payload;
};
const login = async (suffix) => (await api('/api/login', 'POST', { username: logins[suffix], password }, '', 200)).token;

try {
  await client.connect();
  const identity = (await client.query(`SELECT current_database() AS database, inet_server_addr()::text AS address,
    inet_server_port() AS port, COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname=current_user),false) AS superuser`)).rows[0];
  assertQaDatabaseIdentity(identity, database, Number(url.port || 5432), 'Alcohol catalog API QA');

  await client.query('BEGIN');
  await client.query(`INSERT INTO organizations(id,name,slug,plan) VALUES ($1,'Alcohol API QA A',$3,'network'),($2,'Alcohol API QA B',$4,'network')`, [orgA, orgB, `alcohol-api-${orgA}`, `alcohol-api-${orgB}`]);
  await client.query(`INSERT INTO organization_subscriptions(organization_id,plan,status,seats_limit,venues_limit) VALUES ($1,'network','active',20,5),($2,'network','active',20,5)`,[orgA,orgB]);
  await client.query(`INSERT INTO venues(id,organization_id,name,timezone) VALUES
    ($1,$4,'Alcohol API QA A1','Asia/Yekaterinburg'),($2,$4,'Alcohol API QA A2','Asia/Yekaterinburg'),($3,$5,'Alcohol API QA B','Asia/Yekaterinburg')`, [venueA1, venueA2, venueB, orgA, orgB]);
  for (const user of users) {
    await client.query('INSERT INTO users(id,venue_id,organization_id,full_name,login,password_hash,role,permission_scopes) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)',
      [user.id, user.venue, user.org, `Alcohol API QA ${user.suffix}`, logins[user.suffix], passwordHash, user.role, JSON.stringify(user.suffix==='manager-a'?['inventory']:user.suffix==='bartender-a'?['inventory_categories']:[])]);
    await client.query('INSERT INTO organization_memberships(organization_id,user_id,membership_role,status) VALUES($1,$2,$3,\'active\')',
      [user.org, user.id, user.role === 'owner' ? 'owner' : 'member']);
  }
  await client.query('COMMIT');

  server = spawn(process.execPath, ['server.js'], { cwd: root, windowsHide: true, env: { ...process.env, HOST: '127.0.0.1', PORT: '0', DATABASE_URL: url.href, VENUE_ID: venueA1, AUTH_REQUIRED: 'true', COOKIE_SECURE: 'false', NODE_ENV: 'test', API_RATE_LIMIT: '5000' }, stdio: ['ignore', 'pipe', 'pipe'] });
  exitWait = new Promise((resolve) => server.once('exit', resolve));
  server.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
  server.stderr.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
  const deadline = Date.now() + 20000;
  while (!base && Date.now() < deadline) {
    const match = output.match(/CRM running on http:\/\/localhost:(\d+)/);
    if (match) base = `http://127.0.0.1:${match[1]}`;
    else if (server.exitCode !== null) throw new Error(`QA server exited: ${output}`);
    else await delay(50);
  }
  assert.ok(base, 'authenticated QA server started');
  assert.equal((await api('/api/health')).database, 'postgres');

  const ownerToken = await login('owner-a');
  const managerToken = await login('manager-a');
  const bartenderToken = await login('bartender-a');
  const otherTenantToken = await login('owner-b');
  const catalogInput = { scope: 'organization', brand: 'QA Distillery', productLine: 'Reserve', name: 'QA Whiskey', spiritType: 'whisky', spiritSubtype: 'Scotch', country: 'Scotland', abv: 40, bottleMl: 700, ageYears: 12, barcode: `qa-${randomUUID()}`, aliases: ['qa single malt'], description: 'QA catalog record' };
  const shared = await api('/api/alcohol-catalog', 'POST', catalogInput, ownerToken, 201);
  assert.equal(shared.scope, 'organization');
  await api('/api/alcohol-catalog', 'POST', { ...catalogInput, barcode: `duplicate-${randomUUID()}` }, ownerToken, 409);
  assert.equal((await api('/api/alcohol-catalog?q=QA%20Whiskey', 'GET', undefined, managerToken)).items.some((item) => item.id === shared.id), true, 'organization catalog is visible from a second venue in the same organization');
  assert.equal((await api('/api/alcohol-catalog', 'GET', undefined, otherTenantToken)).items.some((item) => item.id === shared.id), false, 'catalog is hidden from another organization');
  assert.equal((await api(`/api/alcohol-catalog/${shared.id}`, 'GET', undefined, otherTenantToken, 404)).error, 'alcohol_catalog_item_not_found');

  const venueCatalog = await api('/api/alcohol-catalog', 'POST', { ...catalogInput, scope: 'venue', brand: 'Local QA Distillery', name: 'QA Local Gin', spiritType: 'gin', spiritSubtype: 'London Dry', bottleMl: 500, barcode: `local-${randomUUID()}` }, ownerToken, 201);
  assert.equal((await api('/api/alcohol-catalog', 'GET', undefined, managerToken)).items.some((item) => item.id === venueCatalog.id), false, 'venue catalog stays within its venue');
  assert.equal((await api('/api/alcohol-catalog', 'POST', { ...catalogInput, scope: 'organization', name: 'Denied organization write' }, managerToken, 403)).error, 'alcohol_catalog_network_admin_required', 'organization catalog write requires identity manager role');
  assert.equal((await api('/api/alcohol-catalog', 'POST', { ...catalogInput, scope: 'venue', name: 'Denied bartender write' }, bartenderToken, 403)).error, 'forbidden', 'inventory write permission is enforced');
  await api('/api/alcohol-catalog', 'GET', undefined, bartenderToken, 200);

  const ingredient = await api('/api/inventory/items', 'POST', { name: 'QA Whiskey stock', department: 'bar', category: 'Без категории', itemType: 'ingredient', unit: 'мл', cost: 0.5, alcoholCatalogItemId: shared.id }, ownerToken, 201);
  const legacy = await api('/api/inventory/items', 'POST', { name: 'QA legacy unlinked spirit', department: 'bar', category: 'Без категории', itemType: 'ingredient', unit: 'мл', cost: 0.5 }, ownerToken, 201);
  assert.equal(legacy.alcoholCatalogItemId, null, 'existing API contract supports nullable alcohol link');
  assert.equal((await api('/api/inventory', 'GET', undefined, ownerToken)).items.find((item) => item.id === ingredient.id).alcoholCatalogItem.name, 'QA Whiskey', 'inventory readback joins descriptive catalog fields');
  const hookahCategory = await api('/api/product-categories', 'POST', { name: 'QA Tobacco', department: 'hookah', subdepartmentId: null }, ownerToken, 201);
  const tobacco = await api('/api/tobacco-catalog', 'POST', { scope: 'venue', brand: 'QA Tobacco Brand', productLine: 'Line A', flavor: 'QA Mint', productType: 'tobacco', packageGrams: 100, strength: 'средняя' }, ownerToken, 201);
  const tobaccoIngredient = await api('/api/inventory/items', 'POST', { name: 'QA Mint 100 g', department: 'hookah', subdepartment: '', category: hookahCategory.name, categoryId: hookahCategory.id, itemType: 'ingredient', unit: 'г', purchaseUnit: 'пачка', packMultiplier: 100, cost: 1.2, tobaccoCatalogItemId: tobacco.id }, ownerToken, 201);
  assert.equal(tobaccoIngredient.categoryId, hookahCategory.id, 'inventory category FK round-trips through the existing category directory');
  assert.equal(tobaccoIngredient.category, hookahCategory.name, 'legacy category label remains in the response');
  assert.equal(tobaccoIngredient.tobaccoCatalogItemId, tobacco.id);
  assert.equal(tobaccoIngredient.unit, 'г'); assert.equal(tobaccoIngredient.purchaseUnit, 'пачка');
  assert.equal(Number(tobaccoIngredient.packMultiplier), 100); assert.equal(Number(tobaccoIngredient.cost), 1.2);
  const categoryList = await api('/api/product-categories', 'GET', undefined, ownerToken);
  assert.equal(categoryList.items.some((item) => item.id === hookahCategory.id), true, 'category remains readable after a fresh GET');
  const tobaccoReadback = (await api('/api/inventory', 'GET', undefined, ownerToken)).items.find((item) => item.id === tobaccoIngredient.id);
  assert.equal(tobaccoReadback.categoryId, hookahCategory.id); assert.equal(tobaccoReadback.tobaccoCatalogItem.flavor, 'QA Mint');
  assert.equal(tobaccoReadback.tobaccoCatalogItem.strength, 'средняя'); assert.equal(Number(tobaccoReadback.tobaccoCatalogItem.packageGrams), 100);
  const foreignHookahCategory = (await api('/api/product-categories', 'GET', undefined, otherTenantToken)).items.find((item) => item.department === 'hookah');
  assert.equal((await api('/api/inventory/items', 'POST', { name: 'QA foreign category', department: 'hookah', category: foreignHookahCategory.name, categoryId: hookahCategory.id, unit: 'г' }, otherTenantToken, 400)).error, 'inventory_category_not_found');
  assert.equal((await api('/api/inventory/items', 'POST', { name: 'QA category-only stock denial', department: 'hookah', category: hookahCategory.name, categoryId: hookahCategory.id, unit: 'г' }, bartenderToken, 403)).error, 'forbidden');
  const renamedHookahCategory = await api(`/api/product-categories/${hookahCategory.id}`, 'PATCH', { name: 'QA Tobacco Renamed', department: 'hookah', subdepartmentId: null }, ownerToken, 200);
  assert.equal((await api('/api/inventory', 'GET', undefined, ownerToken)).items.find((item) => item.id === tobaccoIngredient.id).category, renamedHookahCategory.name, 'FK-linked legacy label follows category rename');
  assert.equal((await api('/api/inventory/items', 'POST', { name: 'QA invalid link', department: 'bar', category: 'Без категории', unit: 'мл', alcoholCatalogItemId: randomUUID() }, ownerToken, 400)).error, 'alcohol_catalog_item_not_found_or_inactive');
  assert.equal((await api('/api/inventory/items', 'POST', { name: 'QA cross tenant link', department: 'bar', category: 'Без категории', unit: 'мл', alcoholCatalogItemId: shared.id }, otherTenantToken, 400)).error, 'alcohol_catalog_item_not_found_or_inactive', 'cross-tenant catalog IDs cannot be linked');

  await api('/api/inventory/movements', 'POST', { itemId: ingredient.id, delta: 700, unit: 'мл', reason: 'QA opening stock' }, ownerToken, 201);
  const before = (await api('/api/inventory', 'GET', undefined, ownerToken)).items.find((item) => item.id === ingredient.id);
  assert.equal(Number(before.onHand), 700);
  assert.equal(Number(before.cost), 0.5);
  const updated = await api(`/api/alcohol-catalog/${shared.id}`, 'PATCH', { description: 'Edited descriptive detail', abv: 41, bottleMl: 750 }, ownerToken, 200);
  assert.equal(updated.description, 'Edited descriptive detail');
  await api(`/api/alcohol-catalog/${shared.id}`, 'PATCH', { active: false }, ownerToken, 200);
  assert.equal((await api('/api/alcohol-catalog?status=archived', 'GET', undefined, managerToken)).items.some((item) => item.id === shared.id), true, 'archived organization item remains readable to its organization');
  const after = (await api('/api/inventory', 'GET', undefined, ownerToken)).items.find((item) => item.id === ingredient.id);
  assert.equal(after.alcoholCatalogItem.active, false, 'archived catalog link remains readable on linked inventory item');
  assert.equal(Number(after.onHand), Number(before.onHand), 'descriptive edit and archive do not change stock');
  assert.equal(Number(after.cost), Number(before.cost), 'descriptive edit and archive do not change ingredient cost');
  assert.equal((await api('/api/inventory/items', 'POST', { name: 'QA inactive link', department: 'bar', category: 'Без категории', unit: 'мл', alcoholCatalogItemId: shared.id }, ownerToken, 400)).error, 'alcohol_catalog_item_not_found_or_inactive', 'archived item cannot be freshly linked');
  const detached = await api(`/api/inventory/items/${legacy.id}`, 'PATCH', { alcoholCatalogItemId: null }, ownerToken, 200);
  assert.equal(detached.alcoholCatalogItemId, null, 'nullable link can be explicitly retained or cleared');

  console.log('ALCOHOL CATALOG API QA: PASS (authenticated CRUD/readback; roles; organization and venue visibility; tenant isolation; valid/invalid/inactive links; legacy nullable link; stock and cost unchanged by descriptive edits/archive)');
} finally {
  if (server?.pid && server.exitCode === null && server.signalCode === null) {
    const close = new Promise((resolve) => server.once('close', resolve));
    if (process.platform === 'win32') spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `taskkill /PID ${server.pid} /T /F`], { windowsHide: true, stdio: 'ignore' });
    else server.kill('SIGTERM');
    await close;
  }
  await exitWait?.catch(() => {});
  // Catalog rows are soft-archive-only by design. The allowlisted local QA runner
  // drops this freshly created database after the suite, so fixture cleanup is
  // owned by that runner and cannot touch an existing database's contents.
  await client.end().catch(() => {});
}
