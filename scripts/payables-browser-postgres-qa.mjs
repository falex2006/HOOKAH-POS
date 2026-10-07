import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { validateQaDatabaseUrl, assertQaDatabaseIdentity } from './postgres-qa-safety.mjs';

const databaseUrl = process.env.MIGRATIONS_PG_TEST_DATABASE_URL;
const target = validateQaDatabaseUrl(databaseUrl, 'MIGRATIONS_PG_TEST_DATABASE_URL');
assert.equal(target.database, 'territory_qa');
const playwrightPath = process.env.PLAYWRIGHT_PACKAGE_PATH;
if (!playwrightPath) throw new Error('Set PLAYWRIGHT_PACKAGE_PATH');
const require = createRequire(import.meta.url);
const { Client, Pool } = require('pg');
const { PurchaseDocumentRepository } = require('../db.js');
const { chromium } = require(playwrightPath);
const db = new Client({ connectionString: databaseUrl });
const pool = new Pool({ connectionString: databaseUrl, max: 3 });
let venueId;
let browser;
let child;
try {
  await db.connect();
  const identity = (await db.query('SELECT current_database() AS database, inet_server_addr() AS address, inet_server_port() AS port, (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser')).rows[0];
  assertQaDatabaseIdentity(identity, target.database, Number(target.url.port), 'Payables browser QA database');
  venueId = (await db.query("INSERT INTO venues (name,timezone) VALUES ('Isolated payables browser QA','Asia/Yekaterinburg') RETURNING id")).rows[0].id;
  await db.query("INSERT INTO users (venue_id,full_name,login,role) VALUES ($1,'Payables browser admin',$2,'admin')", [venueId, `payables-browser-${process.pid}`]);
  const ingredientId = (await db.query("INSERT INTO ingredients (venue_id,name,unit,cost,is_marked,purchase_unit,pack_multiplier) VALUES ($1,'QA syrup','ml',0,true,'bottle',1000) RETURNING id", [venueId])).rows[0].id;
  const repo = new PurchaseDocumentRepository(pool);
  const today = new Date().toISOString().slice(0, 10);
  const draft = await repo.saveDraft({ venueId, supplierName: 'QA browser supplier', documentNumber: `B-${process.pid}`, documentDate: today, lines: [{ ingredientId, quantity: 2, unit: 'bottle', unitCost: 100 }] });
  await repo.post(venueId, draft.id, null);
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
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 375, height: 812 }, locale: 'ru-RU' });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${base}/login`, { waitUntil: 'networkidle' });
  await page.locator('#login-username').fill('admin');
  await page.locator('#login-password').fill('admin');
  await page.locator('#login-form button[type="submit"]').click();
  await page.waitForURL((url) => !url.pathname.includes('/login'));
  await page.goto(`${base}/finance`, { waitUntil: 'networkidle' });
  const row = page.locator('.payable-row').filter({ hasText: 'QA browser supplier' });
  await row.waitFor();
  assert.match(await row.textContent(), /Не оплачена/);
  assert.match(await row.textContent(), /200\s*₽/);
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
  console.log('PAYABLES BROWSER POSTGRES QA: PASS (file validation/persistence, 320px open form, partial/full UI payments with failed request retry → SQL/history/reload, 3 widths)');
} finally {
  await browser?.close();
  if (child) { child.kill(); if (child.exitCode === null) await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 3000))]); }
  await pool.end();
  if (db._connected) {
    try {
      if (venueId) {
        await db.query('BEGIN');
        try {
          await db.query('SET LOCAL session_replication_role = replica');
          for (const table of ['expenses', 'stock_movements', 'inventory_purchase_document_lines', 'inventory_purchase_documents', 'ingredients', 'audit_events', 'users']) await db.query(`DELETE FROM ${table} WHERE venue_id=$1`, [venueId]);
          await db.query("DELETE FROM venues WHERE id=$1 AND name='Isolated payables browser QA'", [venueId]);
          await db.query('COMMIT');
          assert.equal((await db.query('SELECT count(*)::int AS count FROM venues WHERE id=$1', [venueId])).rows[0].count, 0, 'QA venue removed');
        } catch (error) { await db.query('ROLLBACK').catch(() => {}); throw error; }
      }
    } finally { await db.end(); }
  }
}
