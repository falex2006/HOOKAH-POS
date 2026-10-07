import assert from 'node:assert/strict';
import { randomBytes, scryptSync } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { validateQaDatabaseUrl, assertQaDatabaseIdentity } from './postgres-qa-safety.mjs';

const databaseUrl = process.env.MIGRATIONS_PG_TEST_DATABASE_URL;
const target = validateQaDatabaseUrl(databaseUrl, 'MIGRATIONS_PG_TEST_DATABASE_URL');
const ownedDatabase = process.env.LOCAL_FULL_PG_OWNED_DATABASE;
assert.match(ownedDatabase || '', /^payables_qa_[a-f0-9]{16}$/i, 'Payables browser QA requires a random runner-owned database marker');
assert.equal(target.database, ownedDatabase, 'Payables browser QA URL must match its runner-owned database marker');
assert.equal(process.env.MIGRATIONS_PG_TEST_DOCKER_CONTAINER, 'hookah-full-regression-qa-20261001', 'Payables browser QA requires the owned disposable PostgreSQL container');
const runnerLockPath = path.resolve('tmp/full-local-qa/pg-regression-runner.lock');
const runnerLock = JSON.parse(await readFile(runnerLockPath, 'utf8'));
assert.equal(Number(runnerLock.pid), process.ppid, 'the regression runner must own the disposable database lock');
assert.match(runnerLock.id || '', /^[0-9a-f-]{36}$/i, 'the regression runner lock must carry a valid ownership ID');
const playwrightPath = process.env.PLAYWRIGHT_PACKAGE_PATH;
if (!playwrightPath) throw new Error('Set PLAYWRIGHT_PACKAGE_PATH');
const require = createRequire(import.meta.url);
const { Client, Pool } = require('pg');
const { PurchaseDocumentRepository } = require('../db.js');
const { chromium } = require(playwrightPath);
const db = new Client({ connectionString: databaseUrl });
const pool = new Pool({ connectionString: databaseUrl, max: 3 });
let organizationId;
let venueId;
let browser;
let child;
const login = `payables-browser-${process.pid}`;
const password = `payables-${process.pid}-qa-password`;
const passwordHash = () => {
  const salt = randomBytes(16).toString('hex');
  return `scrypt$${salt}$${scryptSync(password, salt, 64).toString('hex')}`;
};
const isoVenueDate = (value) => {
  if (value === null || value === undefined) return null;
  const raw = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Yekaterinburg', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(value)).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
};
try {
  await db.connect();
  const identity = (await db.query('SELECT current_database() AS database, inet_server_addr() AS address, inet_server_port() AS port, (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser')).rows[0];
  assertQaDatabaseIdentity(identity, target.database, Number(target.url.port), 'Payables browser QA database');
  organizationId = (await db.query("INSERT INTO organizations (name,slug,timezone) VALUES ('Isolated payables browser QA',$1,'Asia/Yekaterinburg') RETURNING id", [`payables-browser-${process.pid}`])).rows[0].id;
  await db.query("INSERT INTO organization_subscriptions (organization_id,status) VALUES ($1,'trialing')", [organizationId]);
  venueId = (await db.query("INSERT INTO venues (organization_id,name,timezone) VALUES ($1,'Isolated payables browser QA','Asia/Yekaterinburg') RETURNING id", [organizationId])).rows[0].id;
  const userId = (await db.query("INSERT INTO users (organization_id,venue_id,full_name,login,password_hash,role) VALUES ($1,$2,'Payables browser admin',$3,$4,'admin') RETURNING id", [organizationId, venueId, login, passwordHash()])).rows[0].id;
  await db.query("INSERT INTO organization_memberships (organization_id,user_id,membership_role,status) VALUES ($1,$2,'admin','active')", [organizationId, userId]);
  const ingredientId = (await db.query("INSERT INTO ingredients (venue_id,name,unit,cost,is_marked,purchase_unit,pack_multiplier) VALUES ($1,'QA syrup','ml',0,true,'bottle',1000) RETURNING id", [venueId])).rows[0].id;
  const repo = new PurchaseDocumentRepository(pool);
  const today = new Date().toISOString().slice(0, 10);
  const latestDocumentDate = '2026-09-28';
  const olderDocumentDate = '2026-09-05';
  const draft = await repo.saveDraft({ venueId, supplierName: 'QA browser supplier', documentNumber: `B-${process.pid}`, documentDate: latestDocumentDate, lines: [{ ingredientId, quantity: 2, unit: 'bottle', unitCost: 100 }] });
  await repo.post(venueId, draft.id, null);
  const olderDraft = await repo.saveDraft({ venueId, supplierName: 'QA older dated supplier', documentNumber: `O-${process.pid}`, documentDate: olderDocumentDate, lines: [{ ingredientId, quantity: 1, unit: 'bottle', unitCost: 100 }] });
  await repo.post(venueId, olderDraft.id, null);
  const undatedDraft = await repo.saveDraft({ venueId, supplierName: 'QA undated supplier', documentNumber: `N-${process.pid}`, documentDate: null, lines: [{ ingredientId, quantity: 1, unit: 'bottle', unitCost: 100 }] });
  await repo.post(venueId, undatedDraft.id, null);
  child = spawn(process.execPath, ['server.js'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), windowsHide: true,
    env: { ...process.env, DATABASE_URL: databaseUrl, VENUE_ID: venueId, AUTH_REQUIRED: 'false', DEMO_MODE: 'false', NODE_ENV: 'test', HOST: '127.0.0.1', PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Payables QA server did not start: ${output}`)), 15000);
    child.once('error', reject);
    child.stdout.on('data', () => { const match = output.match(/CRM running on http:\/\/localhost:(\d+)/); if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); } });
  });
  assert.equal((await (await fetch(`${base}/api/health`)).json()).database, 'postgres');
  const browserExecutable = process.env.CHROME_PATH || process.env.PLAYWRIGHT_EXECUTABLE_PATH;
  browser = await chromium.launch({ headless: true, ...(browserExecutable ? { executablePath: browserExecutable } : {}) });
  const page = await browser.newPage({ viewport: { width: 375, height: 812 }, locale: 'ru-RU' });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${base}/login`, { waitUntil: 'networkidle' });
  await page.locator('#login-username').fill(login);
  await page.locator('#login-password').fill(password);
  await page.locator('#login-form button[type="submit"]').click();
  await page.waitForURL((url) => !url.pathname.includes('/login'));
  await page.goto(`${base}/finance`, { waitUntil: 'networkidle' });
  const row = page.locator('.payable-row').filter({ hasText: 'QA browser supplier' });
  await row.waitFor();
  const expectedSupplierOrder = ['QA browser supplier', 'QA older dated supplier', 'QA undated supplier'];
  const payablesApi = await page.evaluate(async () => {
    const response = await fetch('/api/finance/purchase-payables');
    return { status: response.status, body: await response.json() };
  });
  assert.equal(payablesApi.status, 200, 'finance payables list is readable in the authenticated browser session');
  assert.deepEqual(payablesApi.body.items.map((item) => item.supplierName), expectedSupplierOrder, 'payables API orders document dates descending and NULL last');
  assert.deepEqual(payablesApi.body.items.map((item) => isoVenueDate(item.documentDate)), [latestDocumentDate, olderDocumentDate, null], 'payables API preserves both invoice dates and NULL in the venue timezone');
  const boundedPayables = await page.evaluate(async () => { const response = await fetch('/api/finance/purchase-payables?documentDateFrom=2026-09-05&documentDateTo=2026-09-28&paymentStatus=unpaid'); return { status: response.status, body: await response.json() }; });
  assert.equal(boundedPayables.status, 200, 'payables API accepts independent inclusive invoice-date and payment-status filters');
  assert.deepEqual(boundedPayables.body.items.map((item) => item.supplierName), expectedSupplierOrder.slice(0, 2), 'payables date range includes both endpoints and excludes undated docs by default');
  assert.ok(boundedPayables.body.items.every((item) => item.paymentStatus === 'unpaid'), 'derived payment status filter is applied server-side');
  const boundedIncludingUndated = await page.evaluate(async () => { const response = await fetch('/api/finance/purchase-payables?documentDateFrom=2026-09-05&documentDateTo=2026-09-28&includeUndated=true'); return { status: response.status, body: await response.json() }; });
  assert.equal(boundedIncludingUndated.status, 200);
  assert.deepEqual(boundedIncludingUndated.body.items.map((item) => item.supplierName), expectedSupplierOrder, 'explicit undated option unions NULL invoice dates with the inclusive payable range');
  for (const query of ['?documentDateFrom=2026-02-30', '?documentDateFrom=2026-09-28&documentDateTo=2026-09-05', '?paymentStatus=unknown', '?includeUndated=1']) {
    const rejected = await page.evaluate(async (value) => { const response = await fetch(`/api/finance/purchase-payables${value}`); return { status: response.status, body: await response.json() }; }, query);
    assert.equal(rejected.status, 400, `invalid payables filter is rejected: ${query}`);
    assert.equal(rejected.body.error, 'invalid_payables_filter');
  }
  const databaseOrder = await db.query(`SELECT supplier_name AS "supplierName",document_date AS "documentDate"
    FROM inventory_purchase_documents WHERE venue_id=$1 AND status='posted'
    ORDER BY document_date DESC NULLS LAST,recorded_at DESC`, [venueId]);
  assert.deepEqual(databaseOrder.rows.map((item) => item.supplierName), expectedSupplierOrder, 'independent PostgreSQL ordering matches the payables contract');
  assert.equal(databaseOrder.rows[2].documentDate, null, 'undated posted payable remains NULL in PostgreSQL');
  const visibleSupplierOrder = await page.locator('.payable-row').evaluateAll((rows) => rows.map((item) => item.querySelector('.payable-supplier b')?.textContent?.trim()));
  assert.deepEqual(visibleSupplierOrder, expectedSupplierOrder, 'finance UI shows dated payables newest-first and the undated row last');
  const undatedRow = page.locator('.payable-row').filter({ hasText: 'QA undated supplier' });
  assert.match(await undatedRow.textContent(), /Дата накладной не указана/, 'finance UI labels the missing invoice date without inventing one');
  await page.reload({ waitUntil: 'networkidle' });
  await row.waitFor();
  assert.deepEqual(await page.locator('.payable-row').evaluateAll((rows) => rows.map((item) => item.querySelector('.payable-supplier b')?.textContent?.trim())), expectedSupplierOrder, 'payables order survives browser reload');
  assert.match(await row.textContent(), /Не оплачена/);
  assert.match(await row.textContent(), /200\s*₽/);
  await page.locator('#payables-date-from').fill('2026-09-05');
  await page.locator('#payables-date-to').fill('2026-09-28');
  const boundedUiResponse = page.waitForResponse(response => response.request().method() === 'GET' && new URL(response.url()).pathname === '/api/finance/purchase-payables' && new URL(response.url()).searchParams.has('documentDateFrom'));
  await page.locator('#payables-filter-apply').click(); await boundedUiResponse;
  assert.deepEqual(await page.locator('.payable-row').evaluateAll((rows) => rows.map((item) => item.querySelector('.payable-supplier b')?.textContent?.trim())), expectedSupplierOrder.slice(0, 2), 'payables UI applies inclusive invoice date range');
  assert.equal(await page.locator('#payables-count').textContent(), '2', 'payables summary count matches filtered results');
  await page.locator('#payables-include-undated').check();
  const includeUndatedUiResponse = page.waitForResponse(response => response.request().method() === 'GET' && new URL(response.url()).pathname === '/api/finance/purchase-payables' && new URL(response.url()).searchParams.get('includeUndated') === 'true');
  await page.locator('#payables-filter-apply').click(); await includeUndatedUiResponse;
  assert.equal(await page.locator('.payable-row').count(), 3, 'payables UI includes undated invoice only after explicit selection');
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(await page.locator('#payables-date-from').inputValue(), '2026-09-05', 'payables date range persists through reload');
  assert.equal(await page.locator('#payables-include-undated').isChecked(), true, 'payables undated selection persists through reload');
  assert.equal(await page.locator('.payable-row').count(), 3, 'reloaded payables repeat the filtered result');
  await page.locator('#payables-filter-reset').click();
  await row.waitFor();
  assert.equal(await page.locator('.payable-row').count(), 3, 'payables reset restores all posted documents');
  let releaseFirstPayment;
  const firstPaymentGate = new Promise((resolve) => { releaseFirstPayment = resolve; });
  let firstPaymentSeen;
  const firstPaymentRequest = new Promise((resolve) => { firstPaymentSeen = resolve; });
  let releaseFailedPayment;
  const failedPaymentGate = new Promise((resolve) => { releaseFailedPayment = resolve; });
  let failedPaymentSeen;
  const failedPaymentRequest = new Promise((resolve) => { failedPaymentSeen = resolve; });
  let paymentPosts = 0;
  await page.route(`**/api/finance/purchase-payables/${draft.id}/payments`, async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    paymentPosts++;
    if (paymentPosts === 1) { firstPaymentSeen(); await firstPaymentGate; }
    if (paymentPosts === 2) { failedPaymentSeen(); await failedPaymentGate; return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'temporary_unavailable' }) }); }
    return route.continue();
  });
  await row.locator('.payable-payment-editor summary').click();
  await row.locator('input[name="amount"]').fill('75');
  await row.locator('input[name="paymentDate"]').fill(today);
  await row.locator('select[name="paymentMethod"]').selectOption('bank_transfer');
  const documentInput = row.locator('input[name="document"]');
  await documentInput.setInputFiles({ name: 'unsupported.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg/>') });
  assert.match(await row.locator('.payable-payment-message').textContent(), /Поддерживаются только PNG, JPEG, WebP и PDF/);
  assert.equal(await documentInput.evaluate((input) => input.files.length), 0, 'unsupported attachment is cleared');
  await documentInput.setInputFiles({ name: 'invalid.png', mimeType: 'image/png', buffer: Buffer.from('invalid image content') });
  await row.locator('.payable-payment-form button[type="submit"]').click();
  await row.locator('.payable-payment-message').getByText('Файл не похож на PNG, JPEG, WebP или PDF. Выберите корректный документ.').waitFor();
  assert.equal(paymentPosts, 0, 'bad file signature does not reach payment API');
  assert.equal(await row.locator('input[name="amount"]').isDisabled(), false, 'form unlocks after invalid file');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==', 'base64');
  await documentInput.setInputFiles({ name: 'receipt.png', mimeType: 'image/png', buffer: png });
  await page.setViewportSize({ width: 320, height: 700 });
  const openFormMetrics = await page.evaluate(() => Object.fromEntries(['html', '.portal-main', '.finance-payables-panel', '.payable-payment-editor', '.payable-payment-form', '.payable-payment-form label', '.payable-payment-form input[type="file"]', '.payable-payment-form input[type="number"]', '.form-row'].map((selector) => { const element = selector === 'html' ? document.documentElement : document.querySelector(selector); return [selector, element ? { scroll: element.scrollWidth, client: element.clientWidth, rect: Math.round(element.getBoundingClientRect().width) } : null]; })));
  assert.equal(openFormMetrics.html.scroll > 321 || openFormMetrics['.portal-main'].scroll > openFormMetrics['.portal-main'].client + 1 || openFormMetrics['.finance-payables-panel'].scroll > openFormMetrics['.finance-payables-panel'].client + 1 || openFormMetrics['.payable-payment-form'].scroll > openFormMetrics['.payable-payment-form'].client + 1 || openFormMetrics['.payable-payment-form input[type="file"]'].rect > openFormMetrics['.payable-payment-form label'].rect + 1, false, `open payment form fits 320px: ${JSON.stringify(openFormMetrics)}`);
  const outputDir = path.resolve('docs/ai-team/responsive-emulator');
  await mkdir(outputDir, { recursive: true });
  await page.locator('.finance-payables-panel').screenshot({ path: path.join(outputDir, 'payables-file-form-320.png') });
  assert.equal(await row.locator('input[name="amount"]').inputValue(), '75', 'draft survives viewport change');
  await page.setViewportSize({ width: 375, height: 812 });
  await row.locator('.payable-payment-form button[type="submit"]').click();
  await firstPaymentRequest;
  assert.equal(await page.locator('#payables-search').isDisabled(), true, 'filter locks during supplier payment');
  await page.locator('#payables-search').evaluate((input) => { input.value = 'QA browser'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  const pendingEditorCount = await row.locator('.payable-payment-editor').count();
  const pendingButtonDisabled = await row.locator('.payable-payment-form button[type="submit"]').isDisabled();
  assert.equal(await row.locator('input[name="amount"]').isDisabled(), true, 'payment values are locked during request');
  await row.locator('.payable-payment-form').evaluate((form) => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  releaseFirstPayment();
  assert.equal(pendingEditorCount, 1, 'pending payment editor is preserved during attempted filter redraw');
  assert.equal(pendingButtonDisabled, true, 'pending payment cannot be submitted again');
  await page.waitForFunction(() => document.querySelector('.payable-row')?.textContent?.includes('Частично оплачена'));
  assert.equal(paymentPosts, 1, 'one payment request before partial settlement');
  const partial = (await db.query("SELECT count(*)::int AS count,COALESCE(SUM(amount),0)::numeric AS total FROM expenses WHERE venue_id=$1 AND purchase_document_id=$2 AND source='purchase'", [venueId, draft.id])).rows[0];
  assert.equal(partial.count, 1);
  assert.equal(Number(partial.total), 75);
  const storedDocument = (await db.query("SELECT document_url FROM expenses WHERE venue_id=$1 AND purchase_document_id=$2 AND source='purchase'", [venueId, draft.id])).rows[0].document_url;
  assert.equal(storedDocument, `data:image/png;base64,${png.toString('base64')}`, 'receipt file reaches PostgreSQL');
  assert.match(await row.textContent(), /125\s*₽/);
  await row.locator('.payable-payment-history summary').click();
  await row.locator('.payable-payment-history-item').first().waitFor();
  assert.match(await row.locator('.payable-payment-history-list').textContent(), /75\s*₽/);
  assert.equal(await row.locator('.payable-payment-history-list a').getAttribute('href'), storedDocument, 'saved receipt is available in payment history');
  await row.locator('.payable-payment-editor summary').click();
  await row.locator('input[name="amount"]').fill('125');
  await row.locator('input[name="paymentDate"]').fill(today);
  await row.locator('select[name="paymentMethod"]').selectOption('cash');
  await row.locator('input[name="document"]').setInputFiles({ name: 'receipt.png', mimeType: 'image/png', buffer: png });
  await row.locator('.payable-payment-form button[type="submit"]').click();
  await failedPaymentRequest;
  assert.equal(await row.locator('input[name="amount"]').isDisabled(), true, 'retry values stay locked while request is pending');
  assert.equal(await row.locator('select[name="paymentMethod"]').isDisabled(), true, 'payment method stays locked while request is pending');
  releaseFailedPayment();
  await row.locator('.payable-payment-message').getByText('Не удалось сохранить оплату. Проверьте данные и повторите.').waitFor();
  assert.equal(await row.locator('input[name="amount"]').isDisabled(), false, 'amount is restored after failed request');
  assert.equal(await row.locator('input[name="amount"]').inputValue(), '125', 'retry keeps original amount');
  assert.equal(await row.locator('select[name="paymentMethod"]').inputValue(), 'cash', 'retry keeps original method');
  assert.equal(await row.locator('input[name="document"]').evaluate((input) => input.files?.[0]?.name), 'receipt.png', 'retry keeps selected file');
  await row.locator('.payable-payment-form button[type="submit"]').click();
  await page.waitForFunction(() => document.querySelector('.payable-row')?.textContent?.includes('Оплачена'));
  assert.equal(paymentPosts, 3, 'failed payment is retried only once');
  const settled = (await db.query("SELECT count(*)::int AS count,COALESCE(SUM(amount),0)::numeric AS total FROM expenses WHERE venue_id=$1 AND purchase_document_id=$2 AND source='purchase'", [venueId, draft.id])).rows[0];
  assert.equal(settled.count, 2);
  assert.equal(Number(settled.total), 200);
  const attachedPayments = (await db.query("SELECT count(*)::int AS count FROM expenses WHERE venue_id=$1 AND purchase_document_id=$2 AND source='purchase' AND document_url=$3", [venueId, draft.id, storedDocument])).rows[0].count;
  assert.equal(attachedPayments, 2, 'both payments persist their selected attachment');
  assert.equal(await row.locator('.payable-payment-editor').count(), 0, 'fully paid receipt no longer exposes payment form');
  for (const width of [320, 768, 1440]) {
    await page.setViewportSize({ width, height: 800 });
    assert.equal(await page.evaluate(() => { const main = document.querySelector('.portal-main'); const panel = document.querySelector('.finance-payables-panel'); return document.documentElement.scrollWidth > innerWidth + 1 || main.scrollWidth > main.clientWidth + 1 || panel.scrollWidth > panel.clientWidth + 1; }), false, `payable overflow at ${width}px`);
    if ([320, 768].includes(width)) {
      await page.locator('.finance-payables-panel').screenshot({ path: path.join(outputDir, `payables-paid-${width}.png`) });
    }
  }
  await page.reload({ waitUntil: 'networkidle' });
  await row.waitFor();
  assert.match(await row.textContent(), /Оплачена/);
  await page.locator('#payables-status').selectOption('paid');
  assert.equal(await page.locator('.payable-row').count(), 1);
  assert.deepEqual(errors.filter((message) => !message.includes('ViewTransition opt-in disabled')), []);
  console.log('PAYABLES BROWSER POSTGRES QA: PASS (inclusive invoice-date/payment-status filters, explicit undated inclusion and reload/reset; file validation/persistence; partial/full UI payments with failed request retry; responsive widths)');
} finally {
  await browser?.close();
  if (child) { child.kill(); if (child.exitCode === null) await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 3000))]); }
  await pool.end();
  if (db._connected) {
    try {
      if (organizationId) {
        await db.query('BEGIN');
        try {
          await db.query('SET LOCAL session_replication_role = replica');
          if (venueId) {
            for (const table of ['expenses', 'stock_movements', 'inventory_purchase_document_lines', 'inventory_purchase_documents', 'ingredients', 'audit_events', 'users']) await db.query(`DELETE FROM ${table} WHERE venue_id=$1`, [venueId]);
            await db.query("DELETE FROM venues WHERE id=$1 AND organization_id=$2 AND name='Isolated payables browser QA'", [venueId, organizationId]);
          }
          await db.query("DELETE FROM organization_memberships WHERE organization_id=$1", [organizationId]);
          await db.query("DELETE FROM organization_subscriptions WHERE organization_id=$1", [organizationId]);
          await db.query("DELETE FROM organizations WHERE id=$1 AND slug=$2", [organizationId, `payables-browser-${process.pid}`]);
          await db.query('COMMIT');
          if (venueId) assert.equal((await db.query('SELECT count(*)::int AS count FROM venues WHERE id=$1', [venueId])).rows[0].count, 0, 'QA venue removed');
          assert.equal((await db.query('SELECT count(*)::int AS count FROM organizations WHERE id=$1', [organizationId])).rows[0].count, 0, 'QA organization removed');
        } catch (error) { await db.query('ROLLBACK').catch(() => {}); throw error; }
      }
    } finally { await db.end(); }
  }
}
