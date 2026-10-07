(async () => {
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { randomBytes, randomUUID, scryptSync } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { createRequire } = require('node:module');
const path = require('node:path');
const { mkdir } = require('node:fs/promises');
const { assertQaDatabaseIdentity, validateQaDatabaseUrl } = await import('./postgres-qa-safety.mjs');

const root = path.resolve(__dirname, '..');
const databaseUrl = process.env.INVENTORY_MOVEMENTS_TEST_DATABASE_URL;
const target = validateQaDatabaseUrl(databaseUrl, 'INVENTORY_MOVEMENTS_TEST_DATABASE_URL');
assert.match(target.database, /^inventory_qa_[a-f0-9]{16}$/i, 'browser QA requires a runner-created random inventory database');
assert.equal(target.database, process.env.LOCAL_FULL_PG_OWNED_DATABASE, 'only the local regression runner may own this disposable database');
const playwrightPath = process.env.PLAYWRIGHT_PACKAGE_PATH;
if (!playwrightPath) throw new Error('local PostgreSQL runner must provide the configured Playwright package');
const { chromium } = createRequire(__filename)(playwrightPath);
const { Client } = createRequire(__filename)('pg');
const client = new Client({ connectionString: target.url.href, connectionTimeoutMillis: 5000 });
const organizationId = randomUUID();
const venueId = randomUUID();
const ownerId = randomUUID();
const managerId = randomUUID();
const bartenderId = randomUUID();
const foreignOrganizationId = randomUUID();
const foreignVenueId = randomUUID();
const foreignOwnerId = randomUUID();
const password = 'inventory-movements-mobile-qa-password';
const managerLogin = `inventory-movements-manager-${managerId}`;
const bartenderLogin = `inventory-movements-bartender-${bartenderId}`;
const foreignLogin = `inventory-movements-foreign-${foreignOwnerId}`;
const screenshotDir = path.join(root, 'tmp', 'inventory-movements-visual');
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
  assertQaDatabaseIdentity(identity, target.database, Number(target.url.port || 5432), 'inventory movements browser QA target');

  await client.query('INSERT INTO organizations(id,name,slug,timezone) VALUES($1,$2,$3,$4),($5,$6,$7,$4)', [organizationId, 'Inventory movements browser QA', `inventory-movements-${organizationId}`, 'Asia/Yekaterinburg', foreignOrganizationId, 'Inventory movements foreign QA', `inventory-movements-foreign-${foreignOrganizationId}`]);
  await client.query("INSERT INTO organization_subscriptions(organization_id,status) VALUES($1,'trialing'),($2,'trialing')", [organizationId, foreignOrganizationId]);
  await client.query('INSERT INTO venues(id,organization_id,name,timezone) VALUES($1,$2,$3,$4),($5,$6,$7,$4)', [venueId, organizationId, 'Inventory movements browser QA venue', 'Asia/Yekaterinburg', foreignVenueId, foreignOrganizationId, 'Inventory movements foreign QA venue']);
  await client.query("INSERT INTO inventory_departments(venue_id,code,name) VALUES($1,'hookah','Кальянный цех'),($2,'hookah','Кальянный цех') ON CONFLICT(venue_id,code) DO UPDATE SET name=EXCLUDED.name", [venueId, foreignVenueId]);
  await client.query(`INSERT INTO users(id,organization_id,venue_id,full_name,login,password_hash,role,permission_scopes) VALUES
    ($1,$2,$3,'QA owner',$4,$5,'owner','[]'::jsonb),($6,$2,$3,'QA inventory reader',$7,$5,'manager','[]'::jsonb),($8,$2,$3,'QA no-inventory user',$9,$5,'bartender','[]'::jsonb),($10,$11,$12,'QA foreign owner',$13,$5,'owner','[]'::jsonb)`, [ownerId, organizationId, venueId, `inventory-movements-owner-${venueId}`, passwordHash(), managerId, managerLogin, bartenderId, bartenderLogin, foreignOwnerId, foreignOrganizationId, foreignVenueId, foreignLogin]);
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
  const context = await browser.newContext({ viewport: { width: 1920, height: 1000 }, isMobile: false,
    hasTouch: true, deviceScaleFactor: 1, locale: 'ru-RU', reducedMotion: 'reduce' });
  const page = await context.newPage();
  const caughtBrowserErrors = new Set();
  const debug = await context.newCDPSession(page);
  await debug.send('Debugger.enable');
  await debug.send('Debugger.setPauseOnExceptions', { state: 'all' });
  debug.on('Debugger.paused', async event => {
    if (event.reason === 'exception' || event.reason === 'promiseRejection') caughtBrowserErrors.add(String(event.data?.description || event.data?.value || 'caught browser exception').slice(0, 600));
    await debug.send('Debugger.resume').catch(() => {});
  });
  const pageErrors = [];
  const productApiFailures = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('response', async response => {
    if (new URL(response.url()).pathname === '/api/products' && response.status() >= 400) {
      productApiFailures.push({ status: response.status(), body: (await response.text().catch(() => '')).slice(0, 300) });
    }
  });

  await page.goto(`${base}/login`, { waitUntil: 'networkidle' });
  await page.locator('#login-username').fill(`inventory-movements-owner-${venueId}`);
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

  await mkdir(screenshotDir, { recursive: true });
  page.on('dialog', dialog => dialog.accept('QA reversal'));
  const category = await api('/api/product-categories', 'POST', { name: 'QA movement category', department: 'hookah' }, 201);
  const item = await api('/api/inventory/items', 'POST', { name: 'QA movement item', unit: 'шт', itemType: 'ingredient', cost: 0, department: 'hookah', category: category.name, categoryId: category.id }, 201);
  const draftData = { supplierName: 'QA supplier', documentNumber: 'QA-UI', documentDate: '', note: '', lines: [{ ingredientId: item.id, quantity: 10, unit: 'шт', unitCost: 20 }] };
  for (let i = 1; i <= 35; i++) await api('/api/inventory/purchase-documents', 'POST', { ...draftData, documentNumber: 'QA-DENSE-' + i }, 201);
  const stock = async () => Number((await api('/api/inventory')).items.find(entry => entry.id === item.id).onHand);
  assert.equal(await stock(), 0, 'drafts do not change stock');
  await page.goto(base + '/inventory?view=movements', { waitUntil: 'networkidle' });
  await page.locator('.purchase-document-row').first().waitFor();
  assert.equal(await page.locator('#purchase-document-form').isVisible(), false, 'journal opens before receipt editor');
  const receipt = () => page.locator('[data-inventory-header-action="receipt"]').click();
  const choose = async (selector, value) => { const native = page.locator(selector); const wrapper = native.locator('xpath=..'); await wrapper.locator('.custom-select-trigger').click(); await wrapper.locator(`[data-value="${value}"]`).click(); };
  await receipt();
  await page.locator('#purchase-supplier').fill('QA UI supplier');
  await page.locator('#purchase-number').fill('QA-UI');
  await choose('[data-purchase-field="ingredientId"]', item.id);
  await page.locator('[data-purchase-field="quantity"]').fill('10');
  await page.locator('[data-purchase-field="unit"]').fill('шт');
  await page.locator('[data-purchase-field="unitCost"]').fill('20');
  let releaseSave;
  let saveStarted;
  const saveGate = new Promise(resolve => { releaseSave = resolve; });
  const saveIntercepted = new Promise(resolve => { saveStarted = resolve; });
  await page.route('**/api/inventory/purchase-documents', async route => {
    if (route.request().method() === 'POST') { saveStarted(); await saveGate; }
    await route.continue();
  });
  await page.locator('#purchase-save').click();
  await saveIntercepted;
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#purchase-document-dialog').isVisible(), true, 'Escape cannot close pending save');
  await page.mouse.click(5, 5);
  assert.equal(await page.locator('#purchase-document-dialog').isVisible(), true, 'backdrop cannot close pending save');
  assert.equal(await page.locator('#purchase-cancel').isDisabled(), true, 'cancel disabled while saving');
  releaseSave();
  await page.locator('#purchase-document-dialog').waitFor({ state: 'hidden' });
  await page.unroute('**/api/inventory/purchase-documents');
  const document = (await api('/api/inventory/purchase-documents')).items.find(entry => entry.documentNumber === 'QA-UI');
  assert.ok(document, 'UI draft persisted');
  await page.locator(`[data-purchase-edit="${document.id}"]`).click();
  await page.locator('#purchase-note').fill('cancelled change');
  await page.locator('#purchase-cancel').click();
  assert.equal((await api('/api/inventory/purchase-documents/' + document.id)).note || '', '', 'cancel leaves draft unchanged');
  await page.locator(`[data-purchase-edit="${document.id}"]`).click();
  await page.locator('#purchase-note').fill('saved edit');
  await page.locator('#purchase-save').click();
  await page.locator('#purchase-document-dialog').waitFor({ state: 'hidden' });
  assert.equal((await api('/api/inventory/purchase-documents/' + document.id)).note, 'saved edit');
  await page.locator(`[data-purchase-post="${document.id}"]`).click();
  await page.waitForFunction(id => !document.querySelector(`[data-purchase-post="${id}"]`), document.id);
  assert.equal(await stock(), 10, 'posted receipt adds quantity once');
  await page.locator('[data-inventory-header-action="adjustment"]').click();
  await choose('#movement-item', item.id);
  await choose('#movement-direction', 'out');
  await page.locator('#movement-delta').fill('2');
  await page.locator('#movement-reason').fill('QA writeoff');
  await page.locator('#movement-form button[type=submit]').click();
  await page.locator('#inventory-movement-dialog').waitFor({ state: 'hidden' });
  assert.equal(await stock(), 8, 'writeoff subtracts quantity');
  const balance = await client.query("SELECT SUM(CASE WHEN direction IN ('in','transfer','adjustment') THEN quantity ELSE -quantity END)::numeric AS balance FROM stock_movements WHERE venue_id=$1 AND ingredient_id=$2", [venueId, item.id]);
  assert.equal(Number(balance.rows[0].balance), 8, 'database movement balance matches API');
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(await stock(), 8, 'stock survives reload');
  for (const width of [1920, 1366, 390]) {
    await page.setViewportSize({ width, height: width < 500 ? 844 : 1000 });
    const menu = page.locator('.sidebar-mobile-toggle');
    if (width < 500 && await menu.getAttribute('aria-expanded') === 'true') await menu.click();
    await page.locator('[data-movement-journal="documents"]').click();
    const bounds = await page.locator('#purchase-document-list').evaluate(node => ({ height: node.clientHeight, total: node.scrollHeight, overflow: getComputedStyle(node).overflowY }));
    assert.ok(bounds.total > bounds.height && bounds.height <= 650, 'dense documents bounded at ' + width);
    assert.ok(['auto', 'scroll'].includes(bounds.overflow));
    await page.evaluate(() => { document.querySelector('.portal-main').scrollTop = 0; });
    await page.screenshot({ path: path.join(screenshotDir, `documents-${width}.png`), fullPage: true });
    const lastEdit = page.locator('#purchase-document-list [data-purchase-edit]').last();
    await lastEdit.click();
    await page.locator('#purchase-document-dialog').waitFor({ state: 'visible' });
    assert.ok(await page.locator('#purchase-number').inputValue(), 'last document opens through bounded journal');
    await page.locator('#purchase-cancel').click();
    await receipt();
    await page.screenshot({ path: path.join(screenshotDir, `receipt-${width}.png`), fullPage: true });
    const modal = await page.locator('#purchase-document-dialog').boundingBox();
    assert.ok(modal.x >= 0 && modal.x + modal.width <= width + 1, 'receipt modal fits');
    await page.locator('#purchase-cancel').click();
    await page.locator('[data-movement-journal="operations"]').click();
    await page.locator('#movement-history-list .movement-row').first().waitFor();
    assert.ok((await page.locator('#movement-history-list').innerText()).includes('QA writeoff'));
    await page.screenshot({ path: path.join(screenshotDir, `operations-${width}.png`), fullPage: true });
    await page.locator('[data-inventory-header-action="adjustment"]').click();
    await page.screenshot({ path: path.join(screenshotDir, `writeoff-${width}.png`), fullPage: true });
    await page.locator('#movement-cancel').click();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'no overflow ' + width);
  }
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(productApiFailures, []);
  if (caughtBrowserErrors.size) console.log('Caught browser diagnostics: ' + JSON.stringify([...caughtBrowserErrors]));
  for (const role of [{ login: managerLogin, foreign: false }, { login: foreignLogin, foreign: true }]) {
    const roleContext = await browser.newContext();
    const rolePage = await roleContext.newPage();
    await rolePage.goto(base + '/login');
    await rolePage.locator('#login-username').fill(role.login);
    await rolePage.locator('#login-password').fill(password);
    await rolePage.locator('#login-form button[type=submit]').click();
    await rolePage.waitForURL(url => !url.pathname.includes('/login'));
    const roleToken = await rolePage.evaluate(() => localStorage.getItem('crm_session_token'));
    const headers = { Authorization: `Bearer ${roleToken}`, 'X-Organization-Id': role.foreign ? foreignOrganizationId : organizationId };
    const read = await roleContext.request.get(base + '/api/inventory/purchase-documents', { headers });
    assert.equal(read.status(), 200);
    assert.equal((await read.json()).items.some(entry => entry.id === document.id), !role.foreign, 'tenant-scoped journal read');
    if (!role.foreign) {
      await rolePage.goto(base + '/inventory?view=movements', { waitUntil: 'networkidle' });
      assert.equal(await rolePage.locator('[data-inventory-header-action="receipt"]').count(), 0, 'reader has no receipt action');
      const denied = await roleContext.request.post(base + '/api/inventory/purchase-documents', { headers, data: draftData });
      assert.equal(denied.status(), 403, 'reader cannot create documents');
    }
    await roleContext.close();
  }
  console.log('PASS movements PostgreSQL UI:35 drafts,bounded journal,create/edit/cancel/post,writeoff,stock SQL+API,reload,desktop/mobile');
} catch (error) {
  const currentPage = browser?.contexts()[0]?.pages()[0];
  if (currentPage) await currentPage.screenshot({ path: path.join(screenshotDir, 'failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally {
  await browser?.close();
  if (server) { const stopped = server.exitCode === null ? new Promise(resolve => server.once('close', resolve)) : Promise.resolve(); server.kill(); await stopped; }
  await client.end();
}
})().catch(error => { console.error(error); process.exitCode = 1; });
