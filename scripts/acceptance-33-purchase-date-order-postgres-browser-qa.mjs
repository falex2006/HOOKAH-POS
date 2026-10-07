import assert from 'node:assert/strict';
import { randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { assertQaDatabaseIdentity, validateQaDatabaseUrl } from './postgres-qa-safety.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const databaseUrl = process.env.ACCEPTANCE_33_PURCHASE_DATE_TEST_DATABASE_URL;
const target = validateQaDatabaseUrl(databaseUrl, 'ACCEPTANCE_33_PURCHASE_DATE_TEST_DATABASE_URL');
assert.match(target.database, /^inventory_qa_[a-f0-9]{16}$/i, 'acceptance #33 requires a runner-created random inventory database');
assert.equal(target.database, process.env.LOCAL_FULL_PG_OWNED_DATABASE, 'only the local regression runner may own this disposable database');
assert.equal(process.env.MIGRATIONS_PG_TEST_DOCKER_CONTAINER, 'hookah-full-regression-qa-20261001', 'acceptance #33 requires the declared disposable PostgreSQL container');
const runnerLockPath = path.join(root, 'tmp', 'full-local-qa', 'pg-regression-runner.lock');
const runnerLock = JSON.parse(fs.readFileSync(runnerLockPath, 'utf8'));
assert.equal(Number(runnerLock.pid), process.ppid, 'the regression runner currently owns the database lock');
assert.match(runnerLock.id || '', /^[0-9a-f-]{36}$/i, 'the regression runner lock has a valid ownership ID');
const playwrightPath = process.env.PLAYWRIGHT_PACKAGE_PATH;
assert.ok(playwrightPath, 'Set PLAYWRIGHT_PACKAGE_PATH');
const { chromium } = createRequire(import.meta.url)(playwrightPath);
const db = new pg.Client({ connectionString: target.url.href, connectionTimeoutMillis: 5000 });
const marker = randomBytes(4).toString('hex');
const ids = { organization: randomUUID(), venue: randomUUID(), owner: randomUUID() };
const ownerLogin = `qa33-owner-${marker}`;
const ownerPassword = `qa33-${randomUUID()}`;
const records = [
  { key: 'newest', supplierName: `QA33 New date ${marker}`, documentDate: '2026-09-28' },
  { key: 'posted', supplierName: `QA33 Posted date ${marker}`, documentDate: '2026-09-20' },
  { key: 'older', supplierName: `QA33 Older date ${marker}`, documentDate: '2026-09-05' },
  { key: 'unknown', supplierName: `QA33 Unknown date ${marker}`, documentDate: null },
];
let server;
let serverExit;
let serverOutput = '';
let connected = false;
let browser;
let context;
let page;
let checks = 0;

const hashPassword = () => {
  const salt = randomBytes(16).toString('hex');
  return `scrypt$${salt}$${scryptSync(ownerPassword, salt, 64).toString('hex')}`;
};
const assertCheck = (condition, message) => { assert.ok(condition, message); checks++; };
const isoDate = (value) => {
  if (value === null || value === undefined) return null;
  const raw = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Yekaterinburg', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(value)).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
};

try {
  await db.connect();
  connected = true;
  const identity = (await db.query(`SELECT current_database() AS database,inet_server_addr()::text AS address,
    inet_server_port() AS port,COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname=current_user),false) AS superuser`)).rows[0];
  assertQaDatabaseIdentity(identity, target.database, Number(target.url.port || 5432), 'acceptance #33 browser PostgreSQL target');

  await db.query('BEGIN');
  try {
    await db.query('INSERT INTO organizations(id,name,slug,timezone) VALUES($1,$2,$3,$4)', [ids.organization, 'QA33 receipt date ordering', `qa33-${ids.organization}`, 'Asia/Yekaterinburg']);
    await db.query("INSERT INTO organization_subscriptions(organization_id,status) VALUES($1,'trialing')", [ids.organization]);
    await db.query('INSERT INTO venues(id,organization_id,name,timezone) VALUES($1,$2,$3,$4)', [ids.venue, ids.organization, `QA33 Venue ${marker}`, 'Asia/Yekaterinburg']);
    await db.query("INSERT INTO inventory_purchase_reversal_policies(venue_id,version,mode,enabled) VALUES($1,1,'safe_full_unpaid_unused',true) ON CONFLICT(venue_id,version) DO NOTHING", [ids.venue]);
    await db.query("INSERT INTO inventory_departments(venue_id,code,name) VALUES($1,'hookah','Кальянный цех') ON CONFLICT(venue_id,code) DO NOTHING", [ids.venue]);
    await db.query('INSERT INTO users(id,organization_id,venue_id,full_name,login,password_hash,role,permission_scopes) VALUES($1,$2,$3,\'QA33 synthetic owner\',$4,$5,\'owner\',\'[]\'::jsonb)', [ids.owner, ids.organization, ids.venue, ownerLogin, hashPassword()]);
    await db.query("INSERT INTO organization_memberships(organization_id,user_id,membership_role,status) VALUES($1,$2,'owner','active')", [ids.organization, ids.owner]);
    await db.query('COMMIT');
  } catch (error) { await db.query('ROLLBACK'); throw error; }

  server = spawn(process.execPath, ['server.js'], {
    cwd: root,
    windowsHide: true,
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', DATABASE_URL: target.url.href, VENUE_ID: ids.venue,
      AUTH_REQUIRED: 'true', DEMO_MODE: 'false', NODE_ENV: 'test', API_RATE_LIMIT: '5000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverExit = new Promise(resolve => server.once('exit', resolve));
  server.stdout.setEncoding('utf8').on('data', chunk => { serverOutput += chunk; });
  server.stderr.setEncoding('utf8').on('data', chunk => { serverOutput += chunk; });
  let base;
  const startupDeadline = Date.now() + 20000;
  while (!base && Date.now() < startupDeadline) {
    const match = serverOutput.match(/CRM running on http:\/\/localhost:(\d+)/);
    if (match) base = `http://127.0.0.1:${match[1]}`;
    else if (server.exitCode !== null) throw new Error(`QA server exited before startup: ${serverOutput}`);
    else await delay(50);
  }
  assertCheck(Boolean(base), `QA server starts on a free localhost port: ${serverOutput}`);
  const health = await fetch(`${base}/api/health`);
  assert.equal(health.status, 200, 'isolated authenticated API server is healthy'); checks++;
  assert.equal((await health.json()).database, 'postgres', 'acceptance #33 is backed by PostgreSQL'); checks++;

  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'ru-RU', timezoneId: 'Asia/Yekaterinburg' });
  page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.stack || error.message));

  await page.goto(`${base}/login`, { waitUntil: 'networkidle' });
  await page.locator('#login-username').fill(ownerLogin);
  await page.locator('#login-password').fill(ownerPassword);
  await page.locator('#login-form button[type="submit"]').click();
  await page.waitForURL(url => url.pathname !== '/login');
  const token = await page.evaluate(() => localStorage.getItem('crm_session_token'));
  assertCheck(Boolean(token), 'synthetic owner uses password login; no demo PIN is configured');

  const api = async (route, method = 'GET', body, expectedStatus = 200) => {
    const response = await context.request.fetch(`${base}${route}`, {
      method,
      ...(body === undefined ? {} : { data: body }),
      headers: { Authorization: `Bearer ${token}`, 'X-Organization-Id': ids.organization },
    });
    const payload = await response.json();
    assert.equal(response.status(), expectedStatus, `${method} ${route}: ${JSON.stringify(payload)}`); checks++;
    return payload;
  };

  const category = await api('/api/product-categories', 'POST', { name: `QA33 Category ${marker}`, department: 'hookah' }, 201);
  const ingredient = await api('/api/inventory/items', 'POST', {
    name: `QA33 Ingredient ${marker}`, unit: 'г', purchaseUnit: 'пачка', packMultiplier: 100,
    itemType: 'ingredient', cost: 0, department: 'hookah', category: category.name, categoryId: category.id,
  }, 201);
  await page.goto(`${base}/inventory?view=movements`, { waitUntil: 'networkidle' });
  await page.locator('#purchase-document-form').waitFor({ state: 'visible' });
  const created = {};
  for (const record of records) {
    await page.locator('#purchase-supplier').fill(record.supplierName);
    await page.locator('#purchase-date').fill(record.documentDate || '');
    const line = page.locator('#purchase-lines .purchase-line').first();
    await line.locator('[data-purchase-field="ingredientId"]').selectOption(ingredient.id);
    await line.locator('[data-purchase-field="quantity"]').fill('1');
    await line.locator('[data-purchase-field="unit"]').fill('пачка');
    await line.locator('[data-purchase-field="unitCost"]').fill('100');
    const createResponsePromise = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/inventory/purchase-documents');
    await page.locator('#purchase-save').click();
    const createResponse = await createResponsePromise;
    assert.equal(createResponse.status(), 201, `${record.key} document is created from the authenticated UI`); checks++;
    const document = await createResponse.json();
    assert.equal(document.status, 'draft'); checks++;
    assert.equal(document.supplierName, record.supplierName); checks++;
    assert.equal(isoDate(document.documentDate), record.documentDate, `${record.key} API document date preserves its input`); checks++;
    created[record.key] = document;
    await page.locator('#purchase-message').filter({ hasText: 'Черновик сохранён. Остаток изменится после проведения.' }).waitFor({ state: 'visible', timeout: 10000 });
    if (record.key === 'posted') {
      const posted = await api(`/api/inventory/purchase-documents/${document.id}/post`, 'POST', undefined, 200);
      assert.equal(posted.document.id, document.id, 'posting returns the same synthetic receipt'); checks++;
      assert.equal(posted.document.status, 'posted', 'the dated test receipt is actually posted through the authenticated API'); checks++;
    }
  }

  const expectedIds = [created.newest.id, created.posted.id, created.older.id, created.unknown.id];
  const cleanList = await api('/api/inventory/purchase-documents');
  assert.deepEqual(cleanList.items.map(item => item.id), expectedIds, 'fresh API list sorts dates newest first and NULL last'); checks++;
  const draftFilter = await api('/api/inventory/purchase-documents?status=draft');
  const expectedDraftIds = [created.newest.id, created.older.id, created.unknown.id];
  assert.deepEqual(draftFilter.items.map(item => item.id), expectedDraftIds, 'draft status filter preserves date order and excludes the posted receipt'); checks++;
  assert.ok(draftFilter.items.every(item => item.status === 'draft'), 'draft status filter returns draft documents only'); checks++;
  const postedFilter = await api('/api/inventory/purchase-documents?status=posted');
  assert.deepEqual(postedFilter.items.map(item => item.id), [created.posted.id], 'posted status filter returns the actual posted receipt only'); checks++;
  assert.ok(postedFilter.items.every(item => item.status === 'posted'), 'posted status filter returns posted documents only'); checks++;
  const inclusiveRange = await api('/api/inventory/purchase-documents?documentDateFrom=2026-09-05&documentDateTo=2026-09-20&status=draft');
  assert.deepEqual(inclusiveRange.items.map(item => item.id), [created.older.id], 'inclusive invoice-date range combines independently with draft status and excludes undated documents'); checks++;
  const rangeWithUndated = await api('/api/inventory/purchase-documents?documentDateFrom=2026-09-05&documentDateTo=2026-09-20&status=draft&includeUndated=true');
  assert.deepEqual(rangeWithUndated.items.map(item => item.id), [created.older.id, created.unknown.id], 'explicit includeUndated adds SQL NULL documents to the in-range status-filtered result'); checks++;
  const endpointInclusive = await api('/api/inventory/purchase-documents?documentDateFrom=2026-09-20&documentDateTo=2026-09-20&status=posted');
  assert.deepEqual(endpointInclusive.items.map(item => item.id), [created.posted.id], 'single-day bounds include the exact endpoint and retain independent posted status'); checks++;
  for (const query of [
    '?documentDateFrom=2026-02-30', '?documentDateFrom=2026-09-20&documentDateTo=2026-09-05', '?includeUndated=yes', '?status=draft&status=posted',
  ]) { const rejected = await api(`/api/inventory/purchase-documents${query}`, 'GET', undefined, 400); assert.equal(rejected.error, 'invalid_purchase_filter', `invalid inventory filter is rejected: ${query}`); checks++; }

  const apiById = new Map(cleanList.items.map(item => [item.id, item]));
  for (const record of records) {
    const actual = apiById.get(created[record.key].id);
    assert.ok(actual, `${record.key} record appears in API readback`); checks++;
    assert.equal(isoDate(actual.documentDate), record.documentDate, `${record.key} API readback preserves date or NULL`); checks++;
    assert.ok(actual.recordedAt && Number.isFinite(Date.parse(actual.recordedAt)), `${record.key} has a separate valid recordedAt system timestamp`); checks++;
  }
  assert.equal(apiById.get(created.unknown.id).documentDate, null, 'unknown invoice date remains JSON null'); checks++;

  const databaseRows = await db.query(`SELECT id::text AS id,supplier_name,document_date::text AS document_date,recorded_at::text AS recorded_at,status
    FROM inventory_purchase_documents WHERE venue_id=$1 AND id=ANY($2::uuid[])
    ORDER BY document_date DESC NULLS LAST,recorded_at DESC`, [ids.venue, expectedIds]);
  assert.deepEqual(databaseRows.rows.map(row => row.id), expectedIds, 'PostgreSQL rows use document_date DESC NULLS LAST'); checks++;
  const dbById = new Map(databaseRows.rows.map(row => [row.id, row]));
  for (const record of records) {
    const apiRow = apiById.get(created[record.key].id);
    const dbRow = dbById.get(created[record.key].id);
    assert.ok(dbRow, `${record.key} row persists in PostgreSQL`); checks++;
    assert.equal(dbRow.document_date, record.documentDate, `${record.key} PostgreSQL invoice date matches the requested value`); checks++;
    assert.equal(dbRow.status, record.key === 'posted' ? 'posted' : 'draft', `${record.key} status is persisted in PostgreSQL`); checks++;
    assert.equal(Date.parse(apiRow.recordedAt), Date.parse(dbRow.recorded_at), `${record.key} API recordedAt is the independent PostgreSQL system timestamp`); checks++;
  }
  const unknownDbRow = dbById.get(created.unknown.id);
  assert.equal(unknownDbRow.document_date, null, 'unknown invoice date is SQL NULL'); checks++;
  assert.ok(unknownDbRow.recorded_at, 'unknown-date draft still stores recorded_at'); checks++;

  await page.reload({ waitUntil: 'networkidle' });
  const rowSuppliers = await page.locator('.purchase-document-row').evaluateAll(rows => rows.map(row => row.querySelector('.purchase-document-main b')?.textContent.trim()));
  assert.deepEqual(rowSuppliers, records.map(record => record.supplierName), 'reloaded UI displays documents in API date order with NULL last'); checks++;
  const unknownRow = page.locator('.purchase-document-row').filter({ hasText: records.find(record => record.key === 'unknown').supplierName });
  const unknownDetails = await unknownRow.locator('.purchase-document-main small').textContent();
  assert.match(unknownDetails, /^Дата накладной не указана\s*·/, 'UI explicitly labels a NULL invoice date as unspecified'); checks++;
  assert.doesNotMatch(unknownDetails, /\d{1,2}\.\d{1,2}\.\d{4}|\d{4}-\d{2}-\d{2}/, 'UI does not substitute a visible date for NULL documentDate'); checks++;
  await page.locator('#purchase-filter-from').fill('2026-09-05');
  await page.locator('#purchase-filter-to').fill('2026-09-20');
  await page.locator('#purchase-filter-status').selectOption('draft');
  const inventoryFilterResponse = page.waitForResponse(response => response.request().method() === 'GET' && new URL(response.url()).pathname === '/api/inventory/purchase-documents' && new URL(response.url()).searchParams.get('documentDateFrom') === '2026-09-05');
  await page.locator('#purchase-filter-apply').click(); const filteredInventoryResponse = await inventoryFilterResponse;
  const filteredInventoryPayload = await filteredInventoryResponse.json();
  assert.deepEqual(filteredInventoryPayload.items.map(item => item.id), [created.older.id], `inventory filter request returns matching records: ${filteredInventoryResponse.url()}`); checks++;
  assert.deepEqual(await page.locator('.purchase-document-row').evaluateAll(rows => rows.map(row => row.querySelector('.purchase-document-main b')?.textContent.trim())), [records.find(record => record.key === 'older').supplierName], 'inventory UI applies inclusive date and status filters together'); checks++;
  await page.locator('#purchase-filter-undated').check();
  const inventoryUndatedResponse = page.waitForResponse(response => response.request().method() === 'GET' && new URL(response.url()).pathname === '/api/inventory/purchase-documents' && new URL(response.url()).searchParams.get('includeUndated') === 'true');
  await page.locator('#purchase-filter-apply').click(); await inventoryUndatedResponse;
  assert.deepEqual(await page.locator('.purchase-document-row').evaluateAll(rows => rows.map(row => row.querySelector('.purchase-document-main b')?.textContent.trim())), [records.find(record => record.key === 'older').supplierName, records.find(record => record.key === 'unknown').supplierName], 'inventory UI exposes undated records only when explicitly selected alongside a range'); checks++;
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(await page.locator('#purchase-filter-from').inputValue(), '2026-09-05', 'inventory list filter persists across reload'); checks++;
  assert.equal(await page.locator('#purchase-filter-undated').isChecked(), true, 'undated selection persists across reload'); checks++;
  assert.equal(await page.locator('.purchase-document-row').count(), 2, 'reload repeats the same filtered inventory result'); checks++;
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 800 });
    const filterMetrics = await page.evaluate(() => { const controls = document.querySelector('.purchase-document-filters'); return { document: [document.documentElement.scrollWidth, innerWidth], controls: [controls.scrollWidth, controls.clientWidth] }; });
    const filterOverflow = filterMetrics.document[0] > filterMetrics.document[1] + 1 || filterMetrics.controls[0] > filterMetrics.controls[1] + 1;
    assert.equal(filterOverflow, false, `purchase filters fit ${width}px viewport without horizontal page/toolbar overflow: ${JSON.stringify(filterMetrics)}`); checks++;
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  const inventoryResetResponse = page.waitForResponse(response => response.request().method() === 'GET' && new URL(response.url()).pathname === '/api/inventory/purchase-documents' && !new URL(response.url()).searchParams.has('documentDateFrom'));
  await page.locator('#purchase-filter-reset').click(); await inventoryResetResponse;
  assert.equal(await page.locator('#purchase-filter-from').inputValue(), '', 'reset clears purchase date range'); checks++;
  assert.equal(await page.locator('.purchase-document-row').count(), 4, 'reset restores all dated and undated purchase documents'); checks++;
  let releaseSlowPurchaseFilter; let slowPurchaseFetchReady; let slowPurchaseFilterFinished;
  const slowPurchaseFilterGate = new Promise(resolve => { releaseSlowPurchaseFilter = resolve; });
  const slowPurchaseFilterReady = new Promise(resolve => { slowPurchaseFetchReady = resolve; });
  const slowPurchaseFilterDone = new Promise(resolve => { slowPurchaseFilterFinished = resolve; });
  await page.route('**/api/inventory/purchase-documents?*', async route => {
    const routeUrl = new URL(route.request().url());
    if (route.request().method() === 'GET' && routeUrl.searchParams.get('documentDateFrom') === '2026-09-05') {
      const response = await route.fetch(); slowPurchaseFetchReady(); await slowPurchaseFilterGate; await route.fulfill({ response }); slowPurchaseFilterFinished();
    } else await route.continue();
  });
  await page.locator('#purchase-filter-from').fill('2026-09-05'); await page.locator('#purchase-filter-to').fill('2026-09-20'); await page.locator('#purchase-filter-status').selectOption('draft');
  await page.locator('#purchase-filter-apply').click(); await slowPurchaseFilterReady;
  await page.locator('#purchase-filter-from').fill('2026-09-28'); await page.locator('#purchase-filter-to').fill('2026-09-28');
  const newerPurchaseFilterResponse = page.waitForResponse(response => response.request().method() === 'GET' && new URL(response.url()).pathname === '/api/inventory/purchase-documents' && new URL(response.url()).searchParams.get('documentDateFrom') === '2026-09-28');
  await page.locator('#purchase-filter-apply').click(); await newerPurchaseFilterResponse;
  assert.deepEqual(await page.locator('.purchase-document-row').evaluateAll(rows => rows.map(row => row.querySelector('.purchase-document-main b')?.textContent.trim())), [records.find(record => record.key === 'newest').supplierName], 'latest-applied purchase filter becomes visible before delayed response'); checks++;
  releaseSlowPurchaseFilter(); await slowPurchaseFilterDone;
  assert.deepEqual(await page.locator('.purchase-document-row').evaluateAll(rows => rows.map(row => row.querySelector('.purchase-document-main b')?.textContent.trim())), [records.find(record => record.key === 'newest').supplierName], 'late stale purchase-filter response cannot overwrite latest results'); checks++;
  await page.unroute('**/api/inventory/purchase-documents?*');
  assert.deepEqual(pageErrors, [], `browser has no page errors: ${JSON.stringify(pageErrors)}`); checks++;
  console.log(`ACCEPTANCE #33 PURCHASE DATE ORDER BROWSER QA: PASS (${checks} assertions; authenticated UI POST → inclusive date/status filters → explicit undated inclusion → API/PG order and filter reload/reset; documentDate remains distinct from recordedAt)`);
} finally {
  if (context) await context.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
  if (server && server.exitCode === null && server.signalCode === null) {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else server.kill('SIGTERM');
    await Promise.race([serverExit, delay(4000)]);
  }
  if (connected) await db.end().catch(() => {});
}
