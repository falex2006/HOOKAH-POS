import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { assertQaDatabaseIdentity, validateQaDatabaseUrl } from './postgres-qa-safety.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const databaseUrl = process.env.INVENTORY_RECEIVING_MOBILE_TEST_DATABASE_URL;
const target = validateQaDatabaseUrl(databaseUrl, 'INVENTORY_RECEIVING_MOBILE_TEST_DATABASE_URL');
assert.match(target.database, /^inventory_qa_[a-f0-9]{16}$/i, 'browser QA requires a runner-created random inventory database');
assert.equal(target.database, process.env.LOCAL_FULL_PG_OWNED_DATABASE, 'only the local regression runner may own this disposable database');
const playwrightPath = process.env.PLAYWRIGHT_PACKAGE_PATH;
if (!playwrightPath) throw new Error('local PostgreSQL runner must provide the configured Playwright package');
const { chromium } = createRequire(import.meta.url)(playwrightPath);
const { Client } = createRequire(import.meta.url)('pg');
const client = new Client({ connectionString: target.url.href, connectionTimeoutMillis: 5000 });
const organizationId = randomUUID();
const venueId = randomUUID();
const ownerId = randomUUID();
const managerId = randomUUID();
const bartenderId = randomUUID();
const foreignOrganizationId = randomUUID();
const foreignVenueId = randomUUID();
const foreignOwnerId = randomUUID();
const password = 'inventory-receiving-mobile-qa-password';
const managerLogin = `inventory-receiving-manager-${managerId}`;
const bartenderLogin = `inventory-receiving-bartender-${bartenderId}`;
const foreignLogin = `inventory-receiving-foreign-${foreignOwnerId}`;
const duplicateInvoiceNumber = `QA-DUP-${randomUUID()}`;
const screenshotDir = path.join(root, 'docs', 'ai-team', 'responsive-emulator');
const sizes = [
  { name: '320', width: 320, height: 568 },
  { name: '390', width: 390, height: 844 },
  { name: '717', width: 717, height: 1024 },
  { name: '768', width: 768, height: 1024 },
];
let server;
let serverOutput = '';
let browser;
let checks = 0;

function passwordHash() {
  const salt = randomBytes(16).toString('hex');
  return `scrypt$${salt}$${scryptSync(password, salt, 64).toString('hex')}`;
}

try {
  await client.connect();
  const identity = (await client.query(`SELECT current_database() AS database,inet_server_addr()::text AS address,
    inet_server_port() AS port,COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname=current_user),false) AS superuser`)).rows[0];
  assertQaDatabaseIdentity(identity, target.database, Number(target.url.port || 5432), 'inventory receiving browser QA target');

  await client.query('INSERT INTO organizations(id,name,slug,timezone) VALUES($1,$2,$3,$4),($5,$6,$7,$4)', [organizationId, 'Inventory receiving browser QA', `inventory-receiving-${organizationId}`, 'Asia/Yekaterinburg', foreignOrganizationId, 'Inventory receiving foreign QA', `inventory-receiving-foreign-${foreignOrganizationId}`]);
  await client.query("INSERT INTO organization_subscriptions(organization_id,status) VALUES($1,'trialing'),($2,'trialing')", [organizationId, foreignOrganizationId]);
  await client.query('INSERT INTO venues(id,organization_id,name,timezone) VALUES($1,$2,$3,$4),($5,$6,$7,$4)', [venueId, organizationId, 'Inventory receiving browser QA venue', 'Asia/Yekaterinburg', foreignVenueId, foreignOrganizationId, 'Inventory receiving foreign QA venue']);
  await client.query("INSERT INTO inventory_departments(venue_id,code,name) VALUES($1,'hookah','Кальянный цех'),($2,'hookah','Кальянный цех') ON CONFLICT(venue_id,code) DO UPDATE SET name=EXCLUDED.name", [venueId, foreignVenueId]);
  await client.query(`INSERT INTO users(id,organization_id,venue_id,full_name,login,password_hash,role,permission_scopes) VALUES
    ($1,$2,$3,'QA owner',$4,$5,'owner','[]'::jsonb),($6,$2,$3,'QA inventory reader',$7,$5,'manager','[]'::jsonb),($8,$2,$3,'QA no-inventory user',$9,$5,'bartender','[]'::jsonb),($10,$11,$12,'QA foreign owner',$13,$5,'owner','[]'::jsonb)`, [ownerId, organizationId, venueId, `inventory-receiving-owner-${venueId}`, passwordHash(), managerId, managerLogin, bartenderId, bartenderLogin, foreignOwnerId, foreignOrganizationId, foreignVenueId, foreignLogin]);
  await client.query("INSERT INTO organization_memberships(organization_id,user_id,membership_role,status) VALUES($1,$2,'owner','active'),($1,$3,'member','active'),($1,$4,'member','active'),($5,$6,'owner','active')", [organizationId, ownerId, managerId, bartenderId, foreignOrganizationId, foreignOwnerId]);

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
  const context = await browser.newContext({ viewport: { width: 320, height: 568 }, isMobile: true,
    hasTouch: true, deviceScaleFactor: 1, locale: 'ru-RU', reducedMotion: 'reduce' });
  const page = await context.newPage();
  const pageErrors = [];
  const productApiFailures = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('response', async response => {
    if (new URL(response.url()).pathname === '/api/products' && response.status() >= 400) {
      productApiFailures.push({ status: response.status(), body: (await response.text().catch(() => '')).slice(0, 300) });
    }
  });

  await page.goto(`${base}/login`, { waitUntil: 'networkidle' });
  await page.locator('#login-username').fill(`inventory-receiving-owner-${venueId}`);
  await page.locator('#login-password').fill(password);
  await page.locator('#login-form button[type="submit"]').click();
  await page.waitForURL(url => !url.pathname.includes('/login'), { timeout: 10000 });
  const token = await page.evaluate(() => localStorage.getItem('crm_session_token'));
  assert.ok(token, 'synthetic owner has an authenticated session without PIN setup'); checks++;

  const apiAs = async (route, method = 'GET', body, expected = 200, accessToken = token, accessOrganizationId = organizationId) => {
    const response = await context.request.fetch(`${base}${route}`, {
      method, data: body,
      headers: { Authorization: `Bearer ${accessToken}`, 'X-Organization-Id': accessOrganizationId },
    });
    const payload = await response.json();
    assert.equal(response.status(), expected, `${method} ${route}: ${JSON.stringify(payload)}`);
    checks++;
    return payload;
  };
  const api = (route, method = 'GET', body, expected = 200) => apiAs(route, method, body, expected);

  const category = await api('/api/product-categories', 'POST', {
    name: `QA receiving category ${venueId.slice(0, 8)}`, department: 'hookah',
  }, 201);
  const ingredient = await api('/api/inventory/items', 'POST', {
    name: `QA receiving tobacco ${venueId.slice(0, 8)}`, unit: 'г', purchaseUnit: 'пачка', packMultiplier: 100,
    itemType: 'ingredient', cost: 0, department: 'hookah', category: category.name, categoryId: category.id,
  }, 201);
  assert.ok(Array.isArray((await api('/api/products')).items), 'product catalog read API is available for the inventory shell'); checks++;

  await page.goto(`${base}/inventory?view=movements`, { waitUntil: 'networkidle' });
  await page.locator('#purchase-document-form').waitFor({ state: 'visible' });
  await page.locator('#purchase-lines .purchase-line').first().waitFor({ state: 'visible' });
  await page.locator('#portal-notice').waitFor({ state: 'detached', timeout: 6500 }).catch(() => {});
  assert.equal(await page.locator('#portal-notice').count(), 0, 'no stale page notice remains over the receiving controls'); checks++;
  assert.equal(new URL(page.url()).pathname, '/inventory');
  assert.equal(new URL(page.url()).searchParams.get('view'), 'movements'); checks += 2;

  const lineCount = () => page.locator('#purchase-lines .purchase-line').count();
  assert.equal(await lineCount(), 1, 'new receipt form starts with one editable line'); checks++;
  await page.locator('#purchase-add-line').click();
  assert.equal(await lineCount(), 2, 'receiving form adds a second line'); checks++;
  await page.locator('#purchase-lines .purchase-line').nth(1).locator('[data-purchase-remove]').click();
  assert.equal(await lineCount(), 1, 'receiving form removes the selected line'); checks++;

  const sizesEvidence = [];
  for (const size of sizes) {
    await page.setViewportSize({ width: size.width, height: size.height });
    await page.goto(`${base}/inventory`, { waitUntil: 'networkidle' });
    await page.locator('#inventory-header-actions [data-inventory-header-action="receipt"]').waitFor({ state: 'visible' });
    await page.locator('#portal-notice').waitFor({ state: 'detached', timeout: 6500 }).catch(() => {});
    assert.equal(await page.locator('#portal-notice').count(), 0, `${size.name}px starts without a blocking page notice`); checks++;
    assert.equal(new URL(page.url()).searchParams.has('view'), false, `${size.name}px starts on the stock view`); checks++;
    await page.locator('.portal-main').evaluate(main => main.scrollTo({ top: 0, behavior: 'instant' }));
    await page.locator('#inventory-header-actions [data-inventory-header-action="receipt"]').click();
    await page.waitForFunction(() => {
      const form = document.querySelector('#purchase-document-form');
      const header = document.querySelector('.portal-header');
      const formTop = form?.getBoundingClientRect().top;
      const headerBottom = header?.getBoundingClientRect().bottom;
      return form && header && formTop >= headerBottom + 11 && formTop <= headerBottom + 20;
    }, null, { timeout: 5000 });
    const receiptJump = await page.evaluate(() => {
      const header = document.querySelector('.portal-header').getBoundingClientRect();
      const form = document.querySelector('#purchase-document-form').getBoundingClientRect();
      const supplier = document.querySelector('#purchase-supplier');
      const input = supplier.getBoundingClientRect();
      const point = document.elementFromPoint(input.left + Math.min(input.width / 2, 30), input.top + input.height / 2);
      return { headerBottom: header.bottom, formTop: form.top, supplierTop: input.top, supplierVisible: point === supplier || supplier.contains(point), viewportHeight: innerHeight };
    });
    assert.ok(receiptJump.formTop >= receiptJump.headerBottom + 11, `${size.name}px receipt jump places the form below the sticky header: ${JSON.stringify(receiptJump)}`); checks++;
    assert.ok(receiptJump.supplierVisible, `${size.name}px supplier field is unobstructed after the receipt action: ${JSON.stringify(receiptJump)}`); checks++;
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'purchase-date', `${size.name}px receipt action keeps keyboard focus on the date field`); checks++;
    assert.equal(new URL(page.url()).pathname, '/inventory');
    assert.equal(new URL(page.url()).searchParams.get('view'), 'movements'); checks += 2;
    await page.waitForTimeout(50);
    const geometry = await page.evaluate(() => {
      const form = document.querySelector('#purchase-document-form');
      const controls = [...form.querySelectorAll('input,select,textarea,button')].filter(el => !el.hidden && getComputedStyle(el).display !== 'none');
      const bounds = controls.map(el => {
        const rect = el.getBoundingClientRect();
        return { id: el.id || el.getAttribute('data-purchase-field') || el.textContent.trim(), left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, height: rect.height };
      });
      return {
        width: innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        bodyWidth: document.body.scrollWidth,
        form: (() => { const r = form.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width }; })(),
        bounds,
      };
    });
    assert.ok(geometry.documentWidth <= size.width + 1, `${size.name}px inventory route has no document overflow: ${JSON.stringify(geometry)}`);
    assert.ok(geometry.bodyWidth <= size.width + 1, `${size.name}px inventory route has no body overflow: ${JSON.stringify(geometry)}`);
    assert.ok(geometry.form.left >= -1 && geometry.form.right <= size.width + 1, `${size.name}px receiving form stays in the viewport`);
    for (const control of geometry.bounds) {
      assert.ok(control.left >= -1 && control.right <= size.width + 1, `${size.name}px control ${control.id} stays in the viewport: ${JSON.stringify(control)}`);
    }
    for (const selector of ['#purchase-add-line', '#purchase-save']) {
      const box = await page.locator(selector).boundingBox();
      assert.ok(box && box.height >= 44, `${size.name}px ${selector} retains at least 44px touch height`);
    }
    await page.locator('#purchase-save').scrollIntoViewIfNeeded();
    const saveTarget = await page.locator('#purchase-save').evaluate(button => {
      const rect = button.getBoundingClientRect();
      return document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)?.closest('#purchase-save') === button;
    });
    assert.ok(saveTarget, `${size.name}px save action remains unobstructed when brought into view`);
    if (size.width <= 650) {
      const columns = await page.locator('.purchase-line').first().evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length);
      assert.equal(columns, 1, `${size.name}px purchase line uses one column`);
    } else {
      const columns = await page.locator('.purchase-line').first().evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length);
      assert.ok(columns >= 2, `${size.name}px purchase line uses the tablet two-column layout`);
    }
    await page.locator('#purchase-document-form').evaluate(form => form.scrollIntoView({ block: 'start', behavior: 'instant' }));
    await page.screenshot({ path: path.join(screenshotDir, `inventory-receiving-${size.name}.png`) });
    sizesEvidence.push(`${size.width}x${size.height}`);
    console.log(`/inventory?view=movements ${size.width}x${size.height}: no overflow; form controls inside viewport; line columns checked`);
  }

  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto(`${base}/inventory`, { waitUntil: 'networkidle' });
  await page.locator('#inventory-header-actions [data-inventory-header-action="item"]').waitFor({ state: 'visible' });
  await page.locator('#portal-notice').waitFor({ state: 'detached', timeout: 6500 }).catch(() => {});
  await page.locator('#inventory-header-actions [data-inventory-header-action="item"]').click();
  await page.locator('.inventory-item-editor-panel').waitFor({ state: 'visible', timeout: 5000 });
  await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(root, 'tmp', 'inventory-editor-320.png') });
  const itemEditorTarget = await page.evaluate(() => {
    const header = document.querySelector('.portal-header').getBoundingClientRect();
    const panel = document.querySelector('.inventory-item-editor-panel').getBoundingClientRect();
    const heading = document.querySelector('.inventory-item-editor-panel h2').getBoundingClientRect();
    const name = document.querySelector('#inventory-item-name');
    const field = name.getBoundingClientRect();
    const point = document.elementFromPoint(field.left + Math.min(field.width / 2, 30), field.top + field.height / 2);
    return { headerBottom: header.bottom, panelTop: panel.top, headingTop: heading.top, fieldTop: field.top, fieldVisible: point === name || name.contains(point) };
  });
  assert.ok(itemEditorTarget.panelTop >= itemEditorTarget.headerBottom + 11, `320px new-item panel starts below the sticky header: ${JSON.stringify(itemEditorTarget)}`); checks++;
  assert.ok(itemEditorTarget.headingTop >= itemEditorTarget.headerBottom + 11, `320px item editor heading is not covered by the sticky header: ${JSON.stringify(itemEditorTarget)}`); checks++;
  assert.ok(itemEditorTarget.fieldVisible, `320px first item field is unobstructed: ${JSON.stringify(itemEditorTarget)}`); checks++;
  await page.screenshot({ path: path.join(root, 'tmp', 'inventory-editor-320.png') });
  await page.locator('#inventory-header-actions [data-inventory-header-action="receipt"]').click();
  await page.locator('#purchase-document-form').waitFor({ state: 'visible', timeout: 5000 });
  assert.equal(new URL(page.url()).searchParams.get('view'), 'movements', '320px item editor returns to the receiving route'); checks++;

  await page.setViewportSize({ width: 320, height: 568 });
  await page.locator('#purchase-document-form').scrollIntoViewIfNeeded();
  await page.locator('#purchase-supplier').fill('Synthetic QA supplier');
  await page.locator('#purchase-number').fill(duplicateInvoiceNumber);
  await page.locator('#purchase-lines .purchase-line [data-purchase-field="ingredientId"]').selectOption(ingredient.id);
  const line = page.locator('#purchase-lines .purchase-line').first();
  await line.locator('[data-purchase-field="quantity"]').fill('1');
  await line.locator('[data-purchase-field="unit"]').fill('пачка');
  await line.locator('[data-purchase-field="unitCost"]').fill('120');
  assert.match(await page.locator('#purchase-total').textContent(), /120/, 'one pack produces a visible 120 RUB draft total'); checks++;
  await page.locator('#purchase-save').click();
  await page.locator('#purchase-message').filter({ hasText: 'Черновик сохранён. Остаток изменится после проведения.' }).waitFor({ state: 'visible', timeout: 10000 });
  const documents = await api('/api/inventory/purchase-documents');
  const savedDraft = documents.items.find(item => item.supplierName === 'Synthetic QA supplier' && item.status === 'draft');
  assert.ok(savedDraft, 'UI save persists a draft that is visible after a fresh API read'); checks++;
  assert.equal(savedDraft.lines.length, 1, 'saved draft has one editable purchase line'); checks++;
  const stock = await api('/api/inventory');
  assert.equal(Number(stock.items.find(item => item.id === ingredient.id)?.onHand), 0, 'saving a draft does not change stock'); checks++;
  const movements = await client.query("SELECT count(*)::int AS count FROM stock_movements WHERE venue_id=$1 AND ingredient_id=$2", [venueId, ingredient.id]);
  assert.equal(movements.rows[0].count, 0, 'database has no stock movement until receipt is posted'); checks++;

  let interceptedPurchaseListGets = 0;
  let purchaseDraftPostsDuringLoadFailure = 0;
  const countPurchaseDraftPost = request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/inventory/purchase-documents') purchaseDraftPostsDuringLoadFailure++;
  };
  page.on('request', countPurchaseDraftPost);
  await page.route('**/api/inventory/purchase-documents', async route => {
    if (route.request().method() === 'GET' && interceptedPurchaseListGets === 0) {
      interceptedPurchaseListGets++;
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'purchase_documents_unavailable' }) });
      return;
    }
    await route.continue();
  });
  const failedPurchaseListResponsePromise = page.waitForResponse(response => response.request().method() === 'GET' && new URL(response.url()).pathname === '/api/inventory/purchase-documents');
  await page.reload({ waitUntil: 'networkidle' });
  const failedPurchaseListResponse = await failedPurchaseListResponsePromise;
  assert.equal(failedPurchaseListResponse.status(), 503, 'browser receives the controlled purchase-list HTTP 503'); checks++;
  const failedPurchaseList = page.locator('#purchase-document-list');
  const failedPurchaseListMessage = page.locator('#purchase-filter-message');
  await failedPurchaseListMessage.getByText('Не удалось загрузить документы по выбранным фильтрам.', { exact: true }).waitFor({ state: 'visible' });
  assert.match(await failedPurchaseListMessage.getAttribute('class'), /error-message/, 'HTTP 503 is shown in the filter message as an error'); checks++;
  assert.equal(await failedPurchaseListMessage.getAttribute('role'), 'alert', 'HTTP 503 is announced as an alert to assistive technology'); checks++;
  assert.equal(interceptedPurchaseListGets, 1, 'exactly one purchase-list GET receives the controlled HTTP 503'); checks++;
  assert.equal(await failedPurchaseList.locator('.purchase-document-row').count(), 0, 'load failure does not render stale or empty document rows'); checks++;
  assert.equal(await failedPurchaseList.locator('.empty').count(), 0, 'load failure does not render a contradictory empty state'); checks++;
  assert.equal(purchaseDraftPostsDuringLoadFailure, 0, 'purchase-list load failure does not submit a create request'); checks++;
  await page.unroute('**/api/inventory/purchase-documents');
  const draftAfterListFailure = (await api('/api/inventory/purchase-documents')).items.find(item => item.id === savedDraft.id);
  assert.ok(draftAfterListFailure, 'fresh authenticated GET still returns the previously saved draft after the UI load failure'); checks++;
  assert.equal(draftAfterListFailure.status, 'draft'); checks++;
  assert.equal(draftAfterListFailure.supplierName, 'Synthetic QA supplier'); checks++;
  assert.equal(draftAfterListFailure.lines.length, 1); checks++;
  const persistedAfterListFailure = await client.query(`SELECT d.status,d.supplier_name,COUNT(l.id)::int AS lines
    FROM inventory_purchase_documents d LEFT JOIN inventory_purchase_document_lines l ON l.document_id=d.id
    WHERE d.id=$1 AND d.venue_id=$2 GROUP BY d.id`, [savedDraft.id, venueId]);
  assert.equal(persistedAfterListFailure.rowCount, 1, 'the original saved draft remains persisted in PostgreSQL'); checks++;
  assert.equal(persistedAfterListFailure.rows[0].status, 'draft'); checks++;
  assert.equal(persistedAfterListFailure.rows[0].supplier_name, 'Synthetic QA supplier'); checks++;
  assert.equal(persistedAfterListFailure.rows[0].lines, 1); checks++;
  assert.equal(Number((await api('/api/inventory')).items.find(item => item.id === ingredient.id)?.onHand), 0, 'failed list read does not change ingredient stock'); checks++;
  assert.equal((await client.query('SELECT count(*)::int AS count FROM stock_movements WHERE venue_id=$1 AND ingredient_id=$2', [venueId, ingredient.id])).rows[0].count, 0, 'failed list read does not create stock movements'); checks++;
  const retryListResponsePromise = page.waitForResponse(response => response.request().method() === 'GET' && new URL(response.url()).pathname === '/api/inventory/purchase-documents');
  await page.locator('#purchase-filter-apply').click();
  const retryListResponse = await retryListResponsePromise;
  assert.equal(retryListResponse.status(), 200, 'existing Show action retries the failed list load successfully'); checks++;
  const retriedDraftRow = page.locator('#purchase-document-list .purchase-document-row').filter({ hasText: 'Synthetic QA supplier' });
  await retriedDraftRow.waitFor({ state: 'visible' });
  assert.equal(await page.locator('#purchase-document-list .purchase-document-row').count(), 1, 'retry restores the saved draft without requiring a full page reload'); checks++;
  assert.equal(await failedPurchaseListMessage.textContent(), '', 'successful retry clears the previous error'); checks++;
  assert.equal(await failedPurchaseListMessage.getAttribute('role'), 'status', 'successful retry restores the polite status role'); checks++;
  page.off('request', countPurchaseDraftPost);
  await page.reload({ waitUntil: 'networkidle' });
  const restoredDraftRow = page.locator('.purchase-document-row').filter({ hasText: 'Synthetic QA supplier' });
  await restoredDraftRow.waitFor({ state: 'visible' });
  assert.equal(await page.locator('#purchase-document-list .purchase-document-row').count(), 1, 'reload without interception restores the saved draft list'); checks++;
  assert.equal(await restoredDraftRow.locator('.badge').innerText(), 'Черновик'); checks++;

  const inventoryReaderLogin = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Organization-Id': organizationId }, body: JSON.stringify({ username: managerLogin, password }) });
  assert.equal(inventoryReaderLogin.status, 200, 'inventory-read-only manager can authenticate'); checks++;
  const inventoryReaderToken = (await inventoryReaderLogin.json()).token;
  assert.ok((await apiAs('/api/inventory/purchase-documents', 'GET', undefined, 200, inventoryReaderToken)).items.some(item => item.id === savedDraft.id), 'inventory_read can list purchase drafts'); checks++;
  assert.equal((await apiAs(`/api/inventory/purchase-documents/${savedDraft.id}`, 'GET', undefined, 200, inventoryReaderToken)).id, savedDraft.id, 'inventory_read can read a purchase draft'); checks++;
  const updatePayload = { supplierName: 'Role denied update', lines: [{ ingredientId: ingredient.id, quantity: 1, unit: 'пачка', unitCost: 120 }] };
  const deniedCreate = await apiAs('/api/inventory/purchase-documents', 'POST', updatePayload, 403, inventoryReaderToken);
  assert.equal(deniedCreate.error, 'forbidden', 'inventory_read cannot create purchase drafts'); checks++;
  const deniedUpdate = await apiAs(`/api/inventory/purchase-documents/${savedDraft.id}`, 'PATCH', updatePayload, 403, inventoryReaderToken);
  assert.equal(deniedUpdate.error, 'forbidden', 'inventory_read cannot edit purchase drafts'); checks++;
  const deniedVoid = await apiAs(`/api/inventory/purchase-documents/${savedDraft.id}/void`, 'POST', undefined, 403, inventoryReaderToken);
  assert.equal(deniedVoid.error, 'forbidden', 'inventory_read cannot cancel purchase drafts'); checks++;

  const noInventoryLogin = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Organization-Id': organizationId }, body: JSON.stringify({ username: bartenderLogin, password }) });
  assert.equal(noInventoryLogin.status, 200, 'no-inventory bartender can authenticate'); checks++;
  const noInventoryToken = (await noInventoryLogin.json()).token;
  assert.equal((await apiAs('/api/inventory/purchase-documents', 'GET', undefined, 403, noInventoryToken)).error, 'forbidden', 'role without inventory permission cannot list drafts'); checks++;
  assert.equal((await apiAs(`/api/inventory/purchase-documents/${savedDraft.id}`, 'GET', undefined, 403, noInventoryToken)).error, 'forbidden', 'role without inventory permission cannot read draft details'); checks++;

  const foreignLoginResponse = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Organization-Id': foreignOrganizationId }, body: JSON.stringify({ username: foreignLogin, password }) });
  assert.equal(foreignLoginResponse.status, 200, 'foreign-tenant owner can authenticate in its own organization'); checks++;
  const foreignToken = (await foreignLoginResponse.json()).token;
  const foreignApi = (route, method = 'GET', body, expected = 200) => apiAs(route, method, body, expected, foreignToken, foreignOrganizationId);
  const foreignIngredient = await foreignApi('/api/inventory/items', 'POST', { name: 'Synthetic foreign ingredient', unit: 'г', itemType: 'ingredient', cost: 0, department: 'hookah' }, 201);
  const foreignDraft = await foreignApi('/api/inventory/purchase-documents', 'POST', { supplierName: 'Synthetic foreign supplier', lines: [{ ingredientId: foreignIngredient.id, quantity: 10, unit: 'г', unitCost: 5 }] }, 201);
  assert.ok(!(await api('/api/inventory/purchase-documents')).items.some(item => item.id === foreignDraft.id), 'purchase draft list does not expose another tenant document'); checks++;
  assert.equal((await api(`/api/inventory/purchase-documents/${foreignDraft.id}`, 'GET', undefined, 404)).error, 'purchase_document_not_found', 'foreign-tenant draft detail is indistinguishable from missing'); checks++;
  assert.equal((await api(`/api/inventory/purchase-documents/${foreignDraft.id}`, 'PATCH', updatePayload, 404)).error, 'purchase_document_not_found', 'foreign-tenant draft update is indistinguishable from missing'); checks++;
  assert.equal((await api(`/api/inventory/purchase-documents/${foreignDraft.id}/void`, 'POST', undefined, 404)).error, 'purchase_document_not_found', 'foreign-tenant draft cancellation is indistinguishable from missing'); checks++;
  assert.equal((await apiAs(`/api/inventory/purchase-documents/${savedDraft.id}`, 'GET', undefined, 404, foreignToken, foreignOrganizationId)).error, 'purchase_document_not_found', 'foreign tenant cannot read this tenant draft'); checks++;
  assert.equal((await apiAs(`/api/inventory/purchase-documents/${savedDraft.id}`, 'PATCH', updatePayload, 404, foreignToken, foreignOrganizationId)).error, 'purchase_document_not_found', 'foreign tenant cannot edit this tenant draft'); checks++;
  assert.equal((await apiAs(`/api/inventory/purchase-documents/${savedDraft.id}/void`, 'POST', undefined, 404, foreignToken, foreignOrganizationId)).error, 'purchase_document_not_found', 'foreign tenant cannot cancel this tenant draft'); checks++;
  assert.equal((await api('/api/inventory/purchase-documents/00000000-0000-4000-8000-000000000000', 'PATCH', updatePayload, 404)).error, 'purchase_document_not_found', 'PATCH uses 404 for a missing same-tenant draft'); checks++;
  const foreignState = await client.query('SELECT status FROM inventory_purchase_documents WHERE id=$1 AND venue_id=$2', [foreignDraft.id, foreignVenueId]);
  assert.equal(foreignState.rows[0]?.status, 'draft', 'cross-tenant denied update and cancel leave foreign draft unchanged'); checks++;

  const loginInBrowser = async (uiPage, login, label) => {
    await uiPage.goto(`${base}/login`, { waitUntil: 'networkidle' });
    await uiPage.locator('#login-username').fill(login);
    await uiPage.locator('#login-password').fill(password);
    await uiPage.locator('#login-form button[type="submit"]').click();
    await uiPage.waitForURL(url => !url.pathname.includes('/login'), { timeout: 10000 });
    assert.ok(await uiPage.evaluate(() => localStorage.getItem('crm_session_token')), `${label} authenticated through the normal password login UI`); checks++;
  };
  const readerUiContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true,
    hasTouch: true, deviceScaleFactor: 1, locale: 'ru-RU', reducedMotion: 'reduce' });
  const readerUi = await readerUiContext.newPage();
  readerUi.on('pageerror', error => pageErrors.push(error.message));
  await loginInBrowser(readerUi, managerLogin, 'inventory_read manager');
  await readerUi.goto(`${base}/inventory?view=movements`, { waitUntil: 'networkidle' });
  const readerDraft = readerUi.locator('.purchase-document-row').filter({ hasText: 'Synthetic QA supplier' });
  await readerDraft.waitFor({ state: 'visible' });
  assert.equal(await readerUi.locator('#purchase-document-list .purchase-document-row').count(), 1, 'inventory_read manager sees the permitted purchase history'); checks++;
  assert.equal(await readerUi.locator('#inventory-header-actions [data-inventory-header-action="receipt"]').count(), 0, 'inventory_read manager has no UI action to open receipt creation'); checks++;
  assert.equal(await readerUi.locator('#purchase-document-form, #purchase-add-line, #purchase-save').count(), 0, 'inventory_read manager cannot open or submit the receipt form'); checks++;
  assert.equal(await readerUi.locator('.inventory-purchase-panel').getByText('Для приёмки необходимы права управления складом.').count(), 1, 'read-only receipt guidance is shown in place of the editor'); checks++;
  assert.equal(await readerDraft.locator('[data-purchase-edit], [data-purchase-void]').count(), 0, 'inventory_read manager has no UI edit or cancel actions for the draft'); checks++;
  await readerUiContext.close();

  const foreignUiContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true,
    hasTouch: true, deviceScaleFactor: 1, locale: 'ru-RU', reducedMotion: 'reduce' });
  const foreignUi = await foreignUiContext.newPage();
  foreignUi.on('pageerror', error => pageErrors.push(error.message));
  await loginInBrowser(foreignUi, foreignLogin, 'foreign-tenant owner');
  await foreignUi.goto(`${base}/inventory?view=movements`, { waitUntil: 'networkidle' });
  const foreignOwnedRow = foreignUi.locator('.purchase-document-row').filter({ hasText: 'Synthetic foreign supplier' });
  await foreignOwnedRow.waitFor({ state: 'visible' });
  await foreignUi.reload({ waitUntil: 'networkidle' });
  await foreignUi.locator('.purchase-document-row').filter({ hasText: 'Synthetic foreign supplier' }).waitFor({ state: 'visible' });
  assert.equal(await foreignUi.locator('.purchase-document-row').filter({ hasText: 'Synthetic QA supplier' }).count(), 0, 'foreign-tenant owner does not see another tenant draft in the UI after reload'); checks++;
  assert.equal(await foreignUi.locator('.purchase-document-row').filter({ hasText: 'Synthetic foreign supplier' }).count(), 1, 'foreign-tenant owner still sees its own draft after reload'); checks++;
  await foreignUiContext.close();

  await page.goto(`${base}/inventory?view=movements`, { waitUntil: 'networkidle' });
  await page.locator('#purchase-document-form').waitFor({ state: 'visible' });
  await page.locator('#purchase-supplier').fill('Synthetic duplicate QA supplier');
  await page.locator('#purchase-number').fill(duplicateInvoiceNumber);
  await page.locator('#purchase-date').fill('2026-10-03');
  await page.locator('#purchase-note').fill('Duplicate document number retry fixture');
  const duplicateLine = page.locator('#purchase-lines .purchase-line').first();
  await duplicateLine.locator('[data-purchase-field="ingredientId"]').selectOption(ingredient.id);
  await duplicateLine.locator('[data-purchase-field="quantity"]').fill('1');
  await duplicateLine.locator('[data-purchase-field="unit"]').fill('пачка');
  await duplicateLine.locator('[data-purchase-field="unitCost"]').fill('75');
  const duplicateResponsePromise = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/inventory/purchase-documents');
  await page.locator('#purchase-save').click();
  const duplicateResponse = await duplicateResponsePromise;
  assert.equal(duplicateResponse.status(), 409, 'duplicate invoice number is rejected by the real API with HTTP 409'); checks++;
  const duplicateError = await duplicateResponse.json();
  assert.equal(duplicateError.error, 'purchase_document_create_failed'); checks++;
  assert.equal(duplicateError.detail, 'document_number_exists'); checks++;
  await page.locator('#purchase-message').filter({ hasText: 'Накладная с таким номером уже есть. Проверьте номер документа.' }).waitFor({ state: 'visible' });
  assert.match(await page.locator('#purchase-message').getAttribute('class'), /error-message/, 'duplicate response is shown as an error'); checks++;
  assert.deepEqual(await page.evaluate(() => ({
    values: ['#purchase-supplier', '#purchase-number', '#purchase-date', '#purchase-note'].map(selector => document.querySelector(selector).value),
    line: [...document.querySelector('#purchase-lines .purchase-line').querySelectorAll('[data-purchase-field]')].map(field => field.value),
    disabled: [...document.querySelectorAll('#purchase-document-form input, #purchase-document-form select, #purchase-document-form textarea, #purchase-document-form button')].filter(control => !control.disabled).length === 0,
  })), {
    values: ['Synthetic duplicate QA supplier', duplicateInvoiceNumber, '2026-10-03', 'Duplicate document number retry fixture'],
    line: [ingredient.id, '1', 'пачка', '75'],
    disabled: false,
  }, 'duplicate rejection preserves the form values and restores all controls'); checks++;
  const duplicateRejectedList = await api('/api/inventory/purchase-documents');
  assert.equal(duplicateRejectedList.items.filter(item => item.supplierName === 'Synthetic duplicate QA supplier').length, 0, 'rejected duplicate submission did not create an API document'); checks++;
  await page.locator('#purchase-number').fill(`${duplicateInvoiceNumber}-FIXED`);
  const retryResponsePromise = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/inventory/purchase-documents');
  await page.locator('#purchase-save').click();
  const retryResponse = await retryResponsePromise;
  assert.equal(retryResponse.status(), 201, 'correcting the invoice number retries and creates a draft'); checks++;
  const retryDraft = await retryResponse.json();
  assert.equal(retryDraft.documentNumber, `${duplicateInvoiceNumber}-FIXED`); checks++;
  assert.equal(retryDraft.supplierName, 'Synthetic duplicate QA supplier'); checks++;
  await page.locator('#purchase-message').filter({ hasText: 'Черновик сохранён. Остаток изменится после проведения.' }).waitFor({ state: 'visible' });
  const duplicateRetryReadback = await api('/api/inventory/purchase-documents');
  const numberReadback = duplicateRetryReadback.items.filter(item => [duplicateInvoiceNumber, `${duplicateInvoiceNumber}-FIXED`].includes(item.documentNumber));
  assert.deepEqual(numberReadback.map(item => [item.supplierName, item.documentNumber]).sort((left, right) => left[1].localeCompare(right[1])), [
    ['Synthetic QA supplier', duplicateInvoiceNumber], ['Synthetic duplicate QA supplier', `${duplicateInvoiceNumber}-FIXED`],
  ].sort((left, right) => left[1].localeCompare(right[1])), 'API readback contains only the original and corrected documents'); checks++;
  const duplicateRetryRows = await client.query(`SELECT supplier_name,document_number FROM inventory_purchase_documents
    WHERE venue_id=$1 AND document_number=ANY($2::text[]) ORDER BY document_number`, [venueId, [duplicateInvoiceNumber, `${duplicateInvoiceNumber}-FIXED`]]);
  assert.deepEqual(duplicateRetryRows.rows.map(row => [row.supplier_name, row.document_number]), [
    ['Synthetic QA supplier', duplicateInvoiceNumber], ['Synthetic duplicate QA supplier', `${duplicateInvoiceNumber}-FIXED`],
  ].sort((left, right) => left[1].localeCompare(right[1])), 'PostgreSQL contains exactly the original and corrected documents with no rejected duplicate row'); checks++;

  const invalidDateSupplier = 'Synthetic invalid-date QA supplier';
  const invalidDateDocumentNumber = `QA-INVALID-DATE-${randomUUID()}`;
  const validDraftReadback = (await api('/api/inventory/purchase-documents')).items.find(item => item.id === savedDraft.id);
  assert.equal(validDraftReadback?.status, 'draft', 'a valid synthetic draft exists before the invalid-date submission'); checks++;
  const invalidDateBaseline = await client.query(`SELECT
      (SELECT count(*)::int FROM stock_movements WHERE venue_id=$1 AND ingredient_id=$2) AS movements,
      COALESCE((SELECT SUM(CASE WHEN direction IN ('in','transfer','adjustment') THEN quantity WHEN direction IN ('out','waste') THEN -quantity ELSE 0 END)
        FROM stock_movements WHERE venue_id=$1 AND ingredient_id=$2),0)::numeric AS balance`, [venueId, ingredient.id]);
  const inventoryBeforeInvalidDate = await api('/api/inventory');
  assert.equal(Number(inventoryBeforeInvalidDate.items.find(item => item.id === ingredient.id)?.onHand), Number(invalidDateBaseline.rows[0].balance), 'inventory API and PostgreSQL agree before the invalid-date request'); checks++;

  await page.locator('#purchase-supplier').fill(invalidDateSupplier);
  await page.locator('#purchase-number').fill(invalidDateDocumentNumber);
  await page.locator('#purchase-date').evaluate(input => { input.type = 'text'; });
  await page.locator('#purchase-date').fill('2026-02-30');
  await page.locator('#purchase-note').fill('Backend date validation must reject this impossible date');
  const invalidDateLine = page.locator('#purchase-lines .purchase-line').first();
  await invalidDateLine.locator('[data-purchase-field="ingredientId"]').selectOption(ingredient.id);
  await invalidDateLine.locator('[data-purchase-field="quantity"]').fill('1');
  await invalidDateLine.locator('[data-purchase-field="unit"]').fill('пачка');
  await invalidDateLine.locator('[data-purchase-field="unitCost"]').fill('42');
  const invalidDateResponsePromise = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/inventory/purchase-documents');
  await page.locator('#purchase-save').click();
  const invalidDateResponse = await invalidDateResponsePromise;
  assert.equal(invalidDateResponse.status(), 400, 'real backend rejects the impossible optional document date'); checks++;
  const invalidDateError = await invalidDateResponse.json();
  assert.equal(invalidDateError.error, 'invalid_purchase_document'); checks++;
  assert.equal(invalidDateError.detail, 'invalid_purchase_document'); checks++;
  await page.locator('#purchase-message').filter({ hasText: 'Не удалось сохранить черновик поступления.' }).waitFor({ state: 'visible' });
  assert.match(await page.locator('#purchase-message').getAttribute('class'), /error-message/, 'backend validation failure is shown as a UI error'); checks++;
  assert.deepEqual(await page.evaluate(() => ({
    values: ['#purchase-supplier', '#purchase-number', '#purchase-date', '#purchase-note'].map(selector => document.querySelector(selector).value),
    line: [...document.querySelector('#purchase-lines .purchase-line').querySelectorAll('[data-purchase-field]')].map(field => field.value),
    disabled: [...document.querySelectorAll('#purchase-document-form input, #purchase-document-form select, #purchase-document-form textarea, #purchase-document-form button')].some(control => control.disabled),
  })), {
    values: [invalidDateSupplier, invalidDateDocumentNumber, '2026-02-30', 'Backend date validation must reject this impossible date'],
    line: [ingredient.id, '1', 'пачка', '42'],
    disabled: false,
  }, 'invalid-date rejection preserves every entered value and re-enables all form controls'); checks++;

  await mkdir(screenshotDir, { recursive: true });
  await page.locator('#portal-notice').waitFor({ state: 'detached', timeout: 6500 }).catch(() => {});
  for (const viewport of [{ name: '320', width: 320, height: 568 }, { name: '390', width: 390, height: 844 }]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.locator('#purchase-message').filter({ hasText: 'Не удалось сохранить черновик поступления.' }).waitFor({ state: 'visible' });
    await page.locator('#purchase-message').scrollIntoViewIfNeeded();
    const messageBox = await page.locator('#purchase-message').boundingBox();
    assert.ok(messageBox && messageBox.width > 0 && messageBox.x >= 0 && messageBox.x + messageBox.width <= viewport.width + 1, `${viewport.name}px backend error message stays inside the viewport: ${JSON.stringify(messageBox)}`); checks++;
    const errorStateLayout = await page.evaluate(() => ({
      viewportWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      messageText: document.querySelector('#purchase-message')?.textContent?.trim(),
      messageClass: document.querySelector('#purchase-message')?.className,
      dateValue: document.querySelector('#purchase-date')?.value,
    }));
    assert.ok(errorStateLayout.documentWidth <= viewport.width, `${viewport.name}px backend date error has no horizontal page overflow: ${JSON.stringify(errorStateLayout)}`); checks++;
    assert.match(errorStateLayout.messageClass, /error-message/, `${viewport.name}px backend date error remains visibly styled`); checks++;
    assert.equal(errorStateLayout.dateValue, '2026-02-30', `${viewport.name}px backend date error keeps the entered date`); checks++;
    await page.locator('#purchase-message').screenshot({ path: path.join(screenshotDir, `inventory-receiving-invalid-date-error-${viewport.name}.png`) });
    await page.locator('#purchase-date').screenshot({ path: path.join(screenshotDir, `inventory-receiving-invalid-date-value-${viewport.name}.png`) });
  }

  const invalidDateApiReadback = await api('/api/inventory/purchase-documents');
  assert.equal(invalidDateApiReadback.items.some(item => item.documentNumber === invalidDateDocumentNumber || item.supplierName === invalidDateSupplier), false, 'fresh authenticated GET contains no rejected invalid-date draft'); checks++;
  assert.equal(invalidDateApiReadback.items.find(item => item.id === savedDraft.id)?.status, 'draft', 'the pre-existing valid synthetic draft remains unchanged'); checks++;
  const invalidDatePgReadback = await client.query(`SELECT count(*)::int AS count FROM inventory_purchase_documents
    WHERE venue_id=$1 AND (document_number=$2 OR supplier_name=$3)`, [venueId, invalidDateDocumentNumber, invalidDateSupplier]);
  assert.equal(invalidDatePgReadback.rows[0].count, 0, 'PostgreSQL contains no document for the rejected date submission'); checks++;
  const invalidDateStockAfter = await api('/api/inventory');
  assert.equal(Number(invalidDateStockAfter.items.find(item => item.id === ingredient.id)?.onHand), Number(invalidDateBaseline.rows[0].balance), 'rejected date leaves API stock balance unchanged'); checks++;
  const invalidDateMovementAfter = await client.query(`SELECT count(*)::int AS movements,
      COALESCE(SUM(CASE WHEN direction IN ('in','transfer','adjustment') THEN quantity WHEN direction IN ('out','waste') THEN -quantity ELSE 0 END),0)::numeric AS balance
    FROM stock_movements WHERE venue_id=$1 AND ingredient_id=$2`, [venueId, ingredient.id]);
  assert.equal(invalidDateMovementAfter.rows[0].movements, invalidDateBaseline.rows[0].movements, 'rejected date creates no stock movements'); checks++;
  assert.equal(Number(invalidDateMovementAfter.rows[0].balance), Number(invalidDateBaseline.rows[0].balance), 'rejected date leaves PostgreSQL balance unchanged'); checks++;

  // Exercise editing a saved draft through the mobile UI; reload before reopening it.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(`[data-purchase-edit="${savedDraft.id}"]`).scrollIntoViewIfNeeded();
  await page.locator(`[data-purchase-edit="${savedDraft.id}"]`).click();
  await page.locator('#purchase-save').filter({ hasText: 'Сохранить изменения' }).waitFor({ state: 'visible' });
  assert.equal(await page.locator('#purchase-supplier').inputValue(), 'Synthetic QA supplier', 'edit action loads the saved supplier'); checks++;
  assert.equal(await page.locator('#purchase-lines .purchase-line').count(), 1, 'edit action loads the saved purchase line'); checks++;
  const editLine = page.locator('#purchase-lines .purchase-line').first();
  await page.locator('#purchase-supplier').fill('Synthetic QA supplier updated');
  await editLine.locator('[data-purchase-field="quantity"]').fill('2');
  await editLine.locator('[data-purchase-field="unitCost"]').fill('135');
  assert.match(await page.locator('#purchase-total').textContent(), /270/, 'edited quantity and price recalculate the draft total'); checks++;
  let failedDraftPatchCount = 0;
  const draftPatchPath = `/api/inventory/purchase-documents/${savedDraft.id}`;
  await page.route(`**${draftPatchPath}`, async route => {
    if (route.request().method() === 'PATCH' && new URL(route.request().url()).pathname === draftPatchPath && failedDraftPatchCount === 0) {
      failedDraftPatchCount++;
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'purchase_document_unavailable' }) });
      return;
    }
    await route.continue();
  });
  const failedPatchResponsePromise = page.waitForResponse(response => response.request().method() === 'PATCH' && new URL(response.url()).pathname === draftPatchPath);
  await page.locator('#purchase-save').click();
  const failedPatchResponse = await failedPatchResponsePromise;
  assert.equal(failedPatchResponse.status(), 503, 'browser receives a controlled HTTP 503 for draft PATCH'); checks++;
  assert.equal(failedDraftPatchCount, 1, 'only one saved-draft PATCH receives the controlled failure'); checks++;
  await page.locator('#purchase-message').filter({ hasText: 'Не удалось сохранить черновик поступления.' }).waitFor({ state: 'visible' });
  assert.match(await page.locator('#purchase-message').getAttribute('class'), /error-message/, 'draft PATCH failure is presented as a form error'); checks++;
  assert.equal(await page.locator('#purchase-supplier').inputValue(), 'Synthetic QA supplier updated', 'failed PATCH keeps the edited supplier in the form'); checks++;
  assert.equal(await editLine.locator('[data-purchase-field="quantity"]').inputValue(), '2', 'failed PATCH keeps the edited quantity in the form'); checks++;
  assert.equal(await editLine.locator('[data-purchase-field="unitCost"]').inputValue(), '135', 'failed PATCH keeps the edited price in the form'); checks++;
  assert.equal(await page.locator('#purchase-save').isEnabled(), true, 'failed PATCH releases the submit control for retry'); checks++;
  const draftAfterPatchFailure = (await api('/api/inventory/purchase-documents')).items.find(item => item.id === savedDraft.id);
  assert.ok(draftAfterPatchFailure, 'fresh API read still returns the original saved draft after failed PATCH'); checks++;
  assert.equal(draftAfterPatchFailure.status, 'draft', 'failed PATCH leaves the draft status unchanged'); checks++;
  assert.equal(draftAfterPatchFailure.supplierName, 'Synthetic QA supplier', 'failed PATCH does not persist the edited supplier'); checks++;
  assert.equal(Number(draftAfterPatchFailure.lines[0].quantity), 1, 'failed PATCH does not persist the edited quantity'); checks++;
  assert.equal(Number(draftAfterPatchFailure.lines[0].unitCost), 120, 'failed PATCH does not persist the edited price'); checks++;
  const failedPatchPersisted = await client.query(`SELECT d.status,d.supplier_name,l.quantity,l.unit_cost,l.stock_quantity,l.line_total
    FROM inventory_purchase_documents d JOIN inventory_purchase_document_lines l ON l.document_id=d.id AND l.venue_id=d.venue_id
    WHERE d.id=$1 AND d.venue_id=$2 AND l.ingredient_id=$3`, [savedDraft.id, venueId, ingredient.id]);
  assert.equal(failedPatchPersisted.rowCount, 1, 'the same-venue original draft line remains persisted after failed PATCH'); checks++;
  assert.equal(failedPatchPersisted.rows[0].status, 'draft'); checks++;
  assert.equal(failedPatchPersisted.rows[0].supplier_name, 'Synthetic QA supplier'); checks++;
  assert.equal(Number(failedPatchPersisted.rows[0].quantity), 1); checks++;
  assert.equal(Number(failedPatchPersisted.rows[0].unit_cost), 120); checks++;
  assert.equal(Number(failedPatchPersisted.rows[0].stock_quantity), 100); checks++;
  assert.equal(Number(failedPatchPersisted.rows[0].line_total), 120); checks++;
  const movementsAfterPatchFailure = await client.query('SELECT count(*)::int AS count FROM stock_movements WHERE venue_id=$1 AND ingredient_id=$2', [venueId, ingredient.id]);
  assert.equal(movementsAfterPatchFailure.rows[0].count, 0, 'failed PATCH creates no stock movement'); checks++;
  assert.equal(Number((await api('/api/inventory')).items.find(item => item.id === ingredient.id)?.onHand), 0, 'failed PATCH leaves on-hand stock unchanged'); checks++;
  await page.unroute(`**${draftPatchPath}`);
  const patchPromise = page.waitForResponse(response => response.request().method() === 'PATCH' && new URL(response.url()).pathname === `/api/inventory/purchase-documents/${savedDraft.id}`);
  await page.locator('#purchase-save').click();
  const patchResponse = await patchPromise;
  assert.equal(patchResponse.status(), 200, 'mobile UI saves the existing draft through PATCH'); checks++;
  const updatedDraft = await patchResponse.json();
  assert.equal(updatedDraft.id, savedDraft.id); checks++;
  assert.equal(updatedDraft.status, 'draft', 'editing preserves draft state'); checks++;
  assert.equal(updatedDraft.supplierName, 'Synthetic QA supplier updated'); checks++;
  assert.equal(Number(updatedDraft.lines[0].quantity), 2); checks++;
  assert.equal(Number(updatedDraft.lines[0].unitCost), 135); checks++;
  assert.equal(Number(updatedDraft.lines[0].stockQuantity), 200, 'edited two-pack quantity normalizes to 200g'); checks++;
  assert.equal(Number(updatedDraft.lines[0].lineTotal), 270); checks++;

  const refreshedDraft = (await api('/api/inventory/purchase-documents')).items.find(item => item.id === savedDraft.id);
  assert.ok(refreshedDraft, 'updated draft remains available after a fresh list read'); checks++;
  assert.equal(refreshedDraft.status, 'draft'); checks++;
  assert.equal(refreshedDraft.supplierName, 'Synthetic QA supplier updated'); checks++;
  assert.equal(Number(refreshedDraft.lines[0].quantity), 2); checks++;
  assert.equal(Number(refreshedDraft.lines[0].unitCost), 135); checks++;
  const persistedDraft = await client.query(`SELECT d.status,d.supplier_name,l.quantity,l.unit_cost,l.stock_quantity,l.line_total
    FROM inventory_purchase_documents d JOIN inventory_purchase_document_lines l ON l.document_id=d.id
    WHERE d.id=$1 AND d.venue_id=$2 AND l.ingredient_id=$3`, [savedDraft.id, venueId, ingredient.id]);
  assert.equal(persistedDraft.rowCount, 1, 'edited document and line are persisted in PostgreSQL'); checks++;
  assert.equal(persistedDraft.rows[0].status, 'draft'); checks++;
  assert.equal(persistedDraft.rows[0].supplier_name, 'Synthetic QA supplier updated'); checks++;
  assert.equal(Number(persistedDraft.rows[0].quantity), 2); checks++;
  assert.equal(Number(persistedDraft.rows[0].unit_cost), 135); checks++;
  assert.equal(Number(persistedDraft.rows[0].stock_quantity), 200); checks++;
  assert.equal(Number(persistedDraft.rows[0].line_total), 270); checks++;
  const movementsAfterEdit = await client.query("SELECT count(*)::int AS count FROM stock_movements WHERE venue_id=$1 AND ingredient_id=$2", [venueId, ingredient.id]);
  assert.equal(movementsAfterEdit.rows[0].count, 0, 'editing a draft still creates no stock movements'); checks++;
  const stockAfterEdit = await api('/api/inventory');
  assert.equal(Number(stockAfterEdit.items.find(item => item.id === ingredient.id)?.onHand), 0, 'editing a draft leaves on-hand unchanged'); checks++;

  assert.equal(new URL(page.url()).pathname, '/inventory');
  assert.equal(new URL(page.url()).searchParams.get('view'), 'movements'); checks += 2;
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(await page.evaluate(() => innerWidth), 390, 'draft can be reopened at a suitable mobile width'); checks++;
  const reopenButton = page.locator(`[data-purchase-edit="${savedDraft.id}"]`);
  await reopenButton.waitFor({ state: 'visible' });
  await reopenButton.scrollIntoViewIfNeeded();
  await reopenButton.click();
  await page.locator('#purchase-save').filter({ hasText: 'Сохранить изменения' }).waitFor({ state: 'visible' });
  assert.equal(await page.locator('#purchase-supplier').inputValue(), 'Synthetic QA supplier updated', 'reopened draft shows the updated supplier after reload'); checks++;
  const reopenedLine = page.locator('#purchase-lines .purchase-line').first();
  assert.equal(await reopenedLine.locator('[data-purchase-field="quantity"]').inputValue(), '2', 'reopened draft shows the saved quantity after reload'); checks++;
  assert.equal(await reopenedLine.locator('[data-purchase-field="unitCost"]').inputValue(), '135', 'reopened draft shows the saved price after reload'); checks++;
  const finalDraft = (await api('/api/inventory/purchase-documents')).items.find(item => item.id === savedDraft.id);
  assert.equal(finalDraft?.status, 'draft', 'draft remains unposted after reload and reopening'); checks++;
  assert.equal((await client.query("SELECT count(*)::int AS count FROM stock_movements WHERE venue_id=$1 AND ingredient_id=$2", [venueId, ingredient.id])).rows[0].count, 0, 'reopening an edited draft leaves stock movement history empty'); checks++;
  assert.equal(Number((await api('/api/inventory')).items.find(item => item.id === ingredient.id)?.onHand), 0, 'reopening an edited draft leaves stock balance unchanged'); checks++;

  // A second draft exercises the existing UI confirmation and void route only.
  const cancelSupplier = 'Synthetic QA cancellation supplier';
  await page.goto(`${base}/inventory?view=movements`, { waitUntil: 'networkidle' });
  await page.locator('#purchase-document-form').waitFor({ state: 'visible' });
  await page.locator('#purchase-supplier').fill(cancelSupplier);
  const cancelLine = page.locator('#purchase-lines .purchase-line').first();
  await cancelLine.locator('[data-purchase-field="ingredientId"]').selectOption(ingredient.id);
  await cancelLine.locator('[data-purchase-field="quantity"]').fill('1');
  await cancelLine.locator('[data-purchase-field="unit"]').fill('пачка');
  await cancelLine.locator('[data-purchase-field="unitCost"]').fill('75');
  const cancelCreatePromise = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/inventory/purchase-documents');
  await page.locator('#purchase-save').click();
  await page.locator('#purchase-message').filter({ hasText: 'Черновик сохранён. Остаток изменится после проведения.' }).waitFor({ state: 'visible', timeout: 10000 });
  const cancelCreateResponse = await cancelCreatePromise;
  assert.equal(cancelCreateResponse.status(), 201, 'mobile UI creates a separate draft for the cancel flow'); checks++;
  const cancellableDraft = await cancelCreateResponse.json();
  assert.equal(cancellableDraft.status, 'draft'); checks++;
  assert.equal(cancellableDraft.supplierName, cancelSupplier); checks++;
  assert.equal(Number(cancellableDraft.lines[0].lineTotal), 75); checks++;
  assert.equal(Number((await api('/api/inventory')).items.find(item => item.id === ingredient.id)?.onHand), 0, 'second draft has not changed the ingredient balance'); checks++;
  assert.equal((await client.query("SELECT count(*)::int AS count FROM stock_movements WHERE venue_id=$1 AND ingredient_id=$2", [venueId, ingredient.id])).rows[0].count, 0, 'second draft has not created stock movements'); checks++;

  const voidButton = page.locator(`[data-purchase-void="${cancellableDraft.id}"]`);
  await voidButton.waitFor({ state: 'visible' });
  await voidButton.scrollIntoViewIfNeeded();
  let declinedConfirmType = '';
  let declinedConfirmMessage = '';
  const declineConfirmationPromise = page.waitForEvent('dialog', { timeout: 5000 }).then(async dialog => {
    declinedConfirmType = dialog.type();
    declinedConfirmMessage = dialog.message();
    await dialog.dismiss();
  });
  const declinedVoidRequestPromise = page.waitForEvent('request', {
    predicate: request => request.method() === 'POST' && new URL(request.url()).pathname === `/api/inventory/purchase-documents/${cancellableDraft.id}/void`,
    timeout: 750,
  }).catch(error => {
    if (error.name === 'TimeoutError') return null;
    throw error;
  });
  await voidButton.click();
  await declineConfirmationPromise;
  assert.equal(declinedConfirmType, 'confirm', 'cancel action opens a native confirmation before the user declines it'); checks++;
  assert.equal(declinedConfirmMessage, 'Отменить этот черновик? Он останется в журнале как отменённый; складские остатки не изменятся.', 'declined confirmation explains draft cancellation'); checks++;
  assert.equal(await declinedVoidRequestPromise, null, 'declining the confirmation sends no void request'); checks++;
  assert.equal((await api('/api/inventory/purchase-documents')).items.find(item => item.id === cancellableDraft.id)?.status, 'draft', 'declining confirmation leaves the draft status unchanged'); checks++;
  const declinedDraftPersisted = await client.query('SELECT status FROM inventory_purchase_documents WHERE id=$1 AND venue_id=$2', [cancellableDraft.id, venueId]);
  assert.equal(declinedDraftPersisted.rows[0]?.status, 'draft', 'declining confirmation preserves draft status in PostgreSQL'); checks++;
  assert.equal(await voidButton.count(), 1, 'declined draft remains actionable in the UI'); checks++;
  assert.equal((await client.query("SELECT count(*)::int AS count FROM stock_movements WHERE venue_id=$1 AND ingredient_id=$2", [venueId, ingredient.id])).rows[0].count, 0, 'declining confirmation leaves stock movements empty'); checks++;
  assert.equal(Number((await api('/api/inventory')).items.find(item => item.id === ingredient.id)?.onHand), 0, 'declining confirmation leaves stock balance unchanged'); checks++;

  let confirmType = '';
  let confirmMessage = '';
  const confirmationPromise = page.waitForEvent('dialog', { timeout: 5000 }).then(async dialog => {
    confirmType = dialog.type();
    confirmMessage = dialog.message();
    await dialog.accept();
  });
  const voidResponsePromise = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/inventory/purchase-documents/${cancellableDraft.id}/void`);
  await voidButton.click();
  await confirmationPromise;
  assert.equal(confirmType, 'confirm', 'cancel action opens the native confirmation dialog'); checks++;
  assert.equal(confirmMessage, 'Отменить этот черновик? Он останется в журнале как отменённый; складские остатки не изменятся.', 'confirmation describes draft cancellation and unchanged stock'); checks++;
  const voidResponse = await voidResponsePromise;
  assert.equal(voidResponse.status(), 200, 'confirmed UI cancellation posts to the draft void route'); checks++;
  const voidedResponse = await voidResponse.json();
  assert.equal(voidedResponse.id, cancellableDraft.id); checks++;
  assert.equal(voidedResponse.status, 'voided', 'void route returns the cancelled status'); checks++;
  await page.locator('#portal-notice').filter({ hasText: 'Черновик отменён. Остатки не изменились.' }).waitFor({ state: 'visible' });
  const voidedRow = page.locator('.purchase-document-row').filter({ hasText: cancelSupplier });
  await voidedRow.locator('.badge').filter({ hasText: 'Отменён' }).waitFor({ state: 'visible' });
  assert.equal(await voidedRow.locator('.badge').textContent(), 'Отменён', 'refreshed UI history labels the document cancelled'); checks++;
  assert.equal(await voidedRow.locator('[data-purchase-edit], [data-purchase-post], [data-purchase-void]').count(), 0, 'cancelled document has no draft actions'); checks++;

  const voidedReadback = (await api('/api/inventory/purchase-documents')).items.find(item => item.id === cancellableDraft.id);
  assert.ok(voidedReadback, 'cancelled document remains in the API journal'); checks++;
  assert.equal(voidedReadback.status, 'voided'); checks++;
  assert.equal(voidedReadback.supplierName, cancelSupplier); checks++;
  assert.equal(voidedReadback.lines.length, 1, 'cancelled draft keeps its audit line'); checks++;
  const voidedPersisted = await client.query(`SELECT status,supplier_name FROM inventory_purchase_documents WHERE id=$1 AND venue_id=$2`, [cancellableDraft.id, venueId]);
  assert.equal(voidedPersisted.rowCount, 1); checks++;
  assert.equal(voidedPersisted.rows[0].status, 'voided'); checks++;
  assert.equal(voidedPersisted.rows[0].supplier_name, cancelSupplier); checks++;
  assert.equal((await client.query("SELECT count(*)::int AS count FROM stock_movements WHERE venue_id=$1 AND ingredient_id=$2", [venueId, ingredient.id])).rows[0].count, 0, 'cancelling a draft does not create stock movements'); checks++;
  assert.equal(Number((await api('/api/inventory')).items.find(item => item.id === ingredient.id)?.onHand), 0, 'cancelling a draft leaves on-hand unchanged'); checks++;
  await page.reload({ waitUntil: 'networkidle' });
  const persistedVoidedRow = page.locator('.purchase-document-row').filter({ hasText: cancelSupplier });
  await persistedVoidedRow.locator('.badge').filter({ hasText: 'Отменён' }).waitFor({ state: 'visible' });
  assert.equal(await persistedVoidedRow.locator('.badge').textContent(), 'Отменён', 'cancelled status persists in UI after reload'); checks++;
  assert.equal(await persistedVoidedRow.locator('[data-purchase-edit], [data-purchase-post], [data-purchase-void]').count(), 0, 'reloaded cancelled document remains non-actionable'); checks++;
  assert.equal((await client.query("SELECT count(*)::int AS count FROM stock_movements WHERE venue_id=$1 AND ingredient_id=$2", [venueId, ingredient.id])).rows[0].count, 0, 'reload after cancellation still has no stock movements'); checks++;
  assert.equal(Number((await api('/api/inventory')).items.find(item => item.id === ingredient.id)?.onHand), 0, 'reload after cancellation still has unchanged stock'); checks++;

  await page.setViewportSize({ width: 320, height: 568 });
  await page.locator('#purchase-save').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(screenshotDir, 'inventory-receiving-320-scrolled.png') });
  assert.deepEqual(pageErrors, [], `inventory receiving route has no browser page errors: ${JSON.stringify(pageErrors)}`); checks++;
  assert.deepEqual(productApiFailures, [], `inventory page product catalog reads succeed: ${JSON.stringify(productApiFailures)}`); checks++;
  console.log(`INVENTORY RECEIVING MOBILE POSTGRES BROWSER QA: PASS (${checks} checks; ${sizesEvidence.join(', ')}; draft create/edit/void/readback; stock unchanged; no PIN setup)`);
  await context.close();
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server && server.exitCode === null) {
    server.kill();
    await Promise.race([new Promise(resolve => server.once('exit', resolve)), delay(3000)]);
  }
  if (client._connected) await client.end();
}
