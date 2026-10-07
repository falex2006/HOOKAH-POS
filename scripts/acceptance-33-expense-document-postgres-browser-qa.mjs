import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { validateQaDatabaseUrl, assertQaDatabaseIdentity } from './postgres-qa-safety.mjs';

const databaseUrl = process.env.MIGRATIONS_PG_TEST_DATABASE_URL;
const target = validateQaDatabaseUrl(databaseUrl, 'MIGRATIONS_PG_TEST_DATABASE_URL');
assert.equal(target.database, process.env.LOCAL_FULL_PG_OWNED_DATABASE, 'only the runner-owned disposable database is accepted');
assert.equal(process.env.MIGRATIONS_PG_TEST_DOCKER_CONTAINER, 'hookah-full-regression-qa-20261001', 'only the local disposable QA container is accepted');
const playwrightPath = process.env.PLAYWRIGHT_PACKAGE_PATH;
if (!playwrightPath) throw new Error('Set PLAYWRIGHT_PACKAGE_PATH');
const require = createRequire(import.meta.url);
const { Client, Pool } = require('pg');
const { chromium } = require(playwrightPath);
const db = new Client({ connectionString: databaseUrl });
const pool = new Pool({ connectionString: databaseUrl, max: 3 });
let venueId;
const ids = { organization: randomUUID(), venue: randomUUID(), otherVenue: randomUUID(), owner: randomUUID(), manager: randomUUID(), otherOwner: randomUUID(), foreignOrganization: randomUUID(), foreignVenue: randomUUID(), foreignOwner: randomUUID() };
const ownerLogin = `expense-owner-${ids.venue}`;
const managerLogin = `expense-manager-${ids.venue}`;
const otherOwnerLogin = `expense-owner-${ids.otherVenue}`;
const foreignOwnerLogin = `expense-owner-${ids.foreignVenue}`;
const qaPassword = `qa-${randomUUID()}`;
const salt = randomBytes(16).toString('hex');
const passwordHash = `scrypt$${salt}$${scryptSync(qaPassword, salt, 64).toString('hex')}`;
let browser;
let child;

const pngCrc32 = (buffer) => {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
};
const pngChunk = (type, data) => {
  const typeBytes = Buffer.from(type);
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(pngCrc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, crc]);
};

try {
  await db.connect();
  const identity = (await db.query('SELECT current_database() AS database, inet_server_addr() AS address, inet_server_port() AS port, (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser')).rows[0];
  assertQaDatabaseIdentity(identity, target.database, Number(target.url.port), 'Operating expense document QA database');
  venueId = ids.venue;
  await db.query('BEGIN');
  try {
    await db.query("INSERT INTO organizations (id,name,slug) VALUES ($1,'Isolated operating expense document QA',$2),($3,'Foreign organization expense document QA',$4)", [ids.organization, `expense-document-${ids.organization}`, ids.foreignOrganization, `expense-document-${ids.foreignOrganization}`]);
    await db.query("INSERT INTO organization_subscriptions (organization_id,status) VALUES ($1,'active'),($2,'active')", [ids.organization, ids.foreignOrganization]);
    await db.query("INSERT INTO venues (id,organization_id,name,timezone) VALUES ($1,$2,'Isolated operating expense document QA','Asia/Yekaterinburg'),($3,$2,'Isolated expense document other venue QA','Asia/Yekaterinburg'),($4,$5,'Foreign organization expense document QA','Asia/Yekaterinburg')", [ids.venue, ids.organization, ids.otherVenue, ids.foreignVenue, ids.foreignOrganization]);
    await db.query("INSERT INTO users (id,organization_id,venue_id,full_name,login,password_hash,role) VALUES ($1,$4,$5,'QA expense owner',$7,$9,'owner'),($2,$4,$5,'QA finance reader',$8,$9,'manager'),($3,$4,$6,'QA foreign venue owner',$10,$9,'owner'),($11,$12,$13,'QA foreign organization owner',$14,$9,'owner')", [ids.owner, ids.manager, ids.otherOwner, ids.organization, ids.venue, ids.otherVenue, ownerLogin, managerLogin, passwordHash, otherOwnerLogin, ids.foreignOwner, ids.foreignOrganization, ids.foreignVenue, foreignOwnerLogin]);
    await db.query("INSERT INTO organization_memberships (organization_id,user_id,membership_role,status) VALUES ($1,$2,'owner','active'),($1,$3,'member','active'),($1,$4,'member','active')", [ids.organization, ids.owner, ids.manager, ids.otherOwner]);
    await db.query("INSERT INTO organization_memberships (organization_id,user_id,membership_role,status) VALUES ($1,$2,'owner','active')", [ids.foreignOrganization, ids.foreignOwner]);
    await db.query("INSERT INTO finance_categories (venue_id,name,kind) VALUES ($1,'QA operating documents','expense'),($2,'QA foreign operating documents','expense'),($3,'QA foreign organization documents','expense')", [ids.venue, ids.otherVenue, ids.foreignVenue]);
    await db.query("INSERT INTO expenses (venue_id,category,amount,expense_date,description,source) VALUES ($1,'QA foreign operating documents',7.25,CURRENT_DATE,'Foreign tenant expense','manual')", [ids.otherVenue]);
    await db.query("INSERT INTO expenses (venue_id,category,amount,expense_date,description,source) VALUES ($1,'QA foreign organization documents',8.5,CURRENT_DATE,'Foreign organization expense','manual')", [ids.foreignVenue]);
    await db.query('COMMIT');
  } catch (error) { await db.query('ROLLBACK').catch(() => {}); throw error; }
  const categoryId = (await db.query("SELECT id FROM finance_categories WHERE venue_id=$1 AND name='QA operating documents'", [venueId])).rows[0].id;
  const foreignCategoryId = (await db.query("SELECT id FROM finance_categories WHERE venue_id=$1 AND name='QA foreign operating documents'", [ids.otherVenue])).rows[0].id;
  const foreignOrganizationCategoryId = (await db.query("SELECT id FROM finance_categories WHERE venue_id=$1 AND name='QA foreign organization documents'", [ids.foreignVenue])).rows[0].id;
  const foreignOrganizationExpenseId = (await db.query("SELECT id FROM expenses WHERE venue_id=$1 AND description='Foreign organization expense'", [ids.foreignVenue])).rows[0].id;
  child = spawn(process.execPath, ['server.js'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), windowsHide: true,
    env: { ...process.env, DATABASE_URL: databaseUrl, AUTH_REQUIRED: 'true', DEMO_MODE: 'false', NODE_ENV: 'test', HOST: '127.0.0.1', PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Expense document QA server did not start: ${output}`)), 15000);
    child.once('error', reject);
    child.stdout.on('data', () => { const match = output.match(/CRM running on http:\/\/localhost:(\d+)/); if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); } });
  });
  assert.equal((await (await fetch(`${base}/api/health`)).json()).database, 'postgres');
  const browserExecutable = process.env.PLAYWRIGHT_EXECUTABLE_PATH || process.env.CHROME_PATH;
  browser = await chromium.launch({ headless: true, ...(browserExecutable ? { executablePath: browserExecutable } : {}) });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ru-RU' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${base}/login`, { waitUntil: 'networkidle' });
  await page.locator('#login-username').fill(ownerLogin);
  await page.locator('#login-password').fill(qaPassword);
  await page.locator('#login-form button[type="submit"]').click();
  await page.waitForURL((url) => !url.pathname.includes('/login'));
  await page.goto(`${base}/finance`, { waitUntil: 'networkidle' });
  await page.locator('#expense-category option').filter({ hasText: 'QA operating documents' }).waitFor({ state: 'attached' });

  let postCount = 0;
  let requestSeen;
  const firstRequest = new Promise((resolve) => { requestSeen = resolve; });
  let releaseFailure;
  const failureGate = new Promise((resolve) => { releaseFailure = resolve; });
  await page.route('**/api/expenses', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    postCount++;
    if (postCount === 1) { requestSeen(); await failureGate; return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'temporary_unavailable' }) }); }
    return route.continue();
  });

  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==', 'base64');
  const textChunk = pngChunk('tEXt', Buffer.concat([Buffer.from('Comment\0'), Buffer.alloc(700, 81)]));
  const largePng = Buffer.concat([png.subarray(0, png.length - 12), textChunk, png.subarray(png.length - 12)]);
  const largeDataUrl = `data:image/png;base64,${largePng.toString('base64')}`;
  assert.ok(largeDataUrl.length > 500, 'document fixture exceeds the previous truncation boundary');
  const today = new Date().toISOString().slice(0, 10);
  await page.locator('#expense-category').selectOption(categoryId);
  await page.locator('#expense-amount').fill('38.45');
  await page.locator('#expense-date').fill(today);
  await page.locator('#expense-counterparty').fill('QA поставщик');
  await page.locator('#expense-description').fill('Чек после временной ошибки');
  const fileInput = page.locator('#expense-document');
  await fileInput.setInputFiles({ name: 'expense-receipt.png', mimeType: 'image/png', buffer: largePng });
  await page.locator('#expense-form button[type="submit"]').click();
  await page.waitForFunction(() => document.querySelector('#expense-form')?.dataset.submitting === '1');
  await page.locator('#expense-form').evaluate((form) => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  await firstRequest;
  assert.equal(postCount, 1, 'submitting the same expense twice sends only one request');
  assert.equal(await page.locator('#expense-amount').isDisabled(), true, 'expense fields are locked while request is pending');
  releaseFailure();
  await page.locator('.portal-notice').filter({ hasText: 'Не удалось сохранить расход' }).waitFor();
  assert.equal(await page.locator('#expense-form button[type="submit"]').isDisabled(), false, 'failed request unlocks the expense form');
  assert.equal(await page.locator('#expense-amount').inputValue(), '38.45', 'failed save preserves amount');
  assert.equal(await page.locator('#expense-counterparty').inputValue(), 'QA поставщик', 'failed save preserves counterparty');
  assert.equal(await page.locator('#expense-description').inputValue(), 'Чек после временной ошибки', 'failed save preserves description');
  assert.equal(await fileInput.evaluate((input) => input.files?.[0]?.name), 'expense-receipt.png', 'failed save preserves selected evidence file');
  await page.locator('#expense-form button[type="submit"]').click();
  await page.waitForFunction(() => document.querySelector('#expense-list')?.textContent?.includes('Чек после временной ошибки'));
  assert.equal(postCount, 2, 'retry sends one additional request');

  const saved = (await db.query("SELECT id,venue_id,category_id,amount,expense_date::text AS expense_date,description,source,document_url,purchase_document_id FROM expenses WHERE venue_id=$1 AND category_id=$2 AND source='manual'", [venueId, categoryId])).rows;
  assert.equal(saved.length, 1, 'retry creates exactly one persisted operating expense');
  assert.equal(Number(saved[0].amount), 38.45);
  assert.equal(saved[0].venue_id, venueId, 'expense is scoped to the authenticated venue');
  assert.equal(saved[0].expense_date, today);
  assert.equal(saved[0].purchase_document_id, null, 'manual operating expense is not misclassified as a purchase payment');
  assert.equal(saved[0].description, 'QA поставщик · Чек после временной ошибки');
  assert.equal(saved[0].document_url, largeDataUrl, 'full document is stored without truncation in PostgreSQL');
  const expenseId = saved[0].id;
  const row = page.locator('.payment-row').filter({ hasText: 'Чек после временной ошибки' });
  const link = row.getByRole('link', { name: 'Открыть документ' });
  assert.equal(await link.getAttribute('href'), saved[0].document_url, 'expense row exposes the persisted evidence document');
  const documentPage = await context.newPage();
  await documentPage.goto(saved[0].document_url);
  await documentPage.locator('img').waitFor();
  assert.equal(await documentPage.locator('img').evaluate((image) => image.naturalWidth), 1, 'evidence link opens the stored image');
  await documentPage.close();

  await page.reload({ waitUntil: 'networkidle' });
  const reloadedRow = page.locator('.payment-row').filter({ hasText: 'Чек после временной ошибки' });
  await reloadedRow.waitFor();
  assert.equal(await reloadedRow.getByRole('link', { name: 'Открыть документ' }).getAttribute('href'), saved[0].document_url, 'document remains openable after UI reload');
  const browserApi = (route, method = 'GET', body) => page.evaluate(async ({ route, method, body }) => {
    const token = localStorage.getItem('crm_session_token');
    const response = await fetch(route, { method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  }, { route, method, body });
  const readback = await browserApi(`/api/expenses?from=${today}&to=${today}&limit=100`);
  assert.equal(readback.status, 200, 'finance owner can read persisted expenses from PostgreSQL API');
  assert.ok(readback.body.items.some((item) => item.id === expenseId && item.documentUrl === largeDataUrl), 'finance owner API can read back the exact document and row');
  assert.ok(readback.body.items.every((item) => item.description !== 'Foreign tenant expense'), 'venue-scoped expense list excludes another venue');
  const foreignCategoryPost = await browserApi('/api/expenses', 'POST', { categoryId: foreignCategoryId, amount: 1, expenseDate: today, source: 'manual' });
  assert.equal(foreignCategoryPost.status, 400, 'a finance user cannot attach a category from another venue');

  const maxFileBytes = 1_400_000;
  const maxJpeg = Buffer.alloc(maxFileBytes, 65);
  Buffer.from([0xff, 0xd8, 0xff]).copy(maxJpeg);
  const maxDocumentUrl = `data:image/jpeg;base64,${maxJpeg.toString('base64')}`;
  assert.ok(Buffer.byteLength(JSON.stringify({ categoryId, amount: 1, expenseDate: today, source: 'manual', description: 'QA exact maximum document', documentUrl: maxDocumentUrl })) < 2 * 1024 * 1024,
    'the exact-max document request fits the current HTTP body cap');
  const maxUpload = await page.evaluate(async (payload) => {
    const response = await fetch('/api/expenses', { method: 'POST', headers: { Authorization: `Bearer ${localStorage.getItem('crm_session_token')}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const body = await response.json();
    return { status: response.status, id: body.id, error: body.error };
  }, { categoryId, amount: 1, expenseDate: today, source: 'manual', description: 'QA exact maximum document', documentUrl: maxDocumentUrl });
  assert.equal(maxUpload.status, 201, 'the API accepts a correctly signed document at the exact 1.4 MB limit');
  const maxSaved = (await db.query("SELECT id,document_url FROM expenses WHERE id=$1 AND venue_id=$2", [maxUpload.id, venueId])).rows[0];
  assert.ok(maxSaved, 'exact-max API upload is persisted in the authenticated venue');
  assert.equal(Buffer.from(maxSaved.document_url.slice(maxSaved.document_url.indexOf(',') + 1), 'base64').length, maxFileBytes, 'PostgreSQL readback retains the exact maximum decoded file size');
  assert.equal(maxSaved.document_url, maxDocumentUrl, 'PostgreSQL readback retains the exact maximum data URL');

  const oversizedJpeg = Buffer.alloc(maxFileBytes + 1, 66);
  Buffer.from([0xff, 0xd8, 0xff]).copy(oversizedJpeg);
  const oversizedDocumentUrl = `data:image/jpeg;base64,${oversizedJpeg.toString('base64')}`;
  assert.ok(Buffer.byteLength(JSON.stringify({ categoryId, amount: 1, expenseDate: today, source: 'manual', description: 'QA oversized document', documentUrl: oversizedDocumentUrl })) < 2 * 1024 * 1024,
    'the just-over-limit document request still reaches the validator within the current HTTP body cap');
  const oversizedUpload = await page.evaluate(async (payload) => {
    const response = await fetch('/api/expenses', { method: 'POST', headers: { Authorization: `Bearer ${localStorage.getItem('crm_session_token')}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const body = await response.json().catch(() => ({}));
    return { status: response.status, error: body.error };
  }, { categoryId, amount: 1, expenseDate: today, source: 'manual', description: 'QA oversized document', documentUrl: oversizedDocumentUrl });
  assert.deepEqual(oversizedUpload, { status: 400, error: 'purchase_payment_document_too_large' }, 'the API rejects a document one byte above the 1.4 MB limit');
  assert.equal((await db.query("SELECT count(*)::int AS count FROM expenses WHERE venue_id=$1 AND description='QA oversized document'", [venueId])).rows[0].count, 0, 'the over-limit upload creates no expense row');

  const managerContext = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ru-RU' });
  const managerPage = await managerContext.newPage();
  await managerPage.goto(`${base}/login`, { waitUntil: 'networkidle' });
  await managerPage.locator('#login-username').fill(managerLogin);
  await managerPage.locator('#login-password').fill(qaPassword);
  await managerPage.locator('#login-form button[type="submit"]').click();
  await managerPage.waitForURL((url) => !url.pathname.includes('/login'));
  await managerPage.goto(`${base}/finance`, { waitUntil: 'networkidle' });
  await managerPage.getByText('Подробный журнал расходов доступен финансовым ролям').waitFor();
  assert.equal(await managerPage.locator('#expense-form').count(), 0, 'finance_read manager can view documents but has no expense write form');
  const managerApi = await managerPage.evaluate(async ({ expenseId, today }) => {
    const token = localStorage.getItem('crm_session_token');
    const read = await fetch(`/api/expenses?from=${today}&to=${today}&limit=100`, { headers: { Authorization: `Bearer ${token}` } });
    const write = await fetch('/api/expenses', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ category: 'Denied', amount: 1, expenseDate: today, source: 'manual' }) });
    return { readStatus: read.status, items: (await read.json()).items, writeStatus: write.status, writeBody: await write.json() };
  }, { expenseId, today });
  assert.equal(managerApi.readStatus, 200, 'finance_read manager can read expense history through its permitted API');
  assert.ok(managerApi.items.some((item) => item.id === expenseId), 'finance_read manager sees the own-venue expense');
  assert.equal(managerApi.writeStatus, 403, 'finance_read cannot create expenses');
  await managerContext.close();

  const foreignContext = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ru-RU' });
  const foreignPage = await foreignContext.newPage();
  await foreignPage.goto(`${base}/login`, { waitUntil: 'networkidle' });
  await foreignPage.locator('#login-username').fill(foreignOwnerLogin);
  await foreignPage.locator('#login-password').fill(qaPassword);
  await foreignPage.locator('#login-form button[type="submit"]').click();
  await foreignPage.waitForURL((url) => !url.pathname.includes('/login'));
  const foreignRead = await foreignPage.evaluate(async (today) => {
    const token = localStorage.getItem('crm_session_token');
    const response = await fetch(`/api/expenses?from=${today}&to=${today}&limit=100`, { headers: { Authorization: `Bearer ${token}` } });
    return { status: response.status, items: (await response.json()).items };
  }, today);
  assert.equal(foreignRead.status, 200, 'the foreign organization owner can read its own expense list');
  assert.ok(foreignRead.items.some((item) => item.id === foreignOrganizationExpenseId), 'the foreign organization owner sees its own seeded expense');
  assert.ok(foreignRead.items.every((item) => item.id !== expenseId && item.id !== maxUpload.id), 'the foreign organization cannot read expenses from the first organization');
  assert.ok(foreignRead.items.every((item) => item.description !== 'Чек после временной ошибки' && item.description !== 'QA exact maximum document'), 'the foreign organization cannot read document metadata from the first organization');
  const foreignApi = (route, method = 'GET', body) => foreignPage.evaluate(async ({ route, method, body }) => {
    const token = localStorage.getItem('crm_session_token');
    const response = await fetch(route, { method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  }, { route, method, body });
  const foreignOwnWrite = await foreignApi('/api/expenses', 'POST', { categoryId: foreignOrganizationCategoryId, amount: 2.75, expenseDate: today, source: 'manual', description: 'Foreign organization own expense' });
  assert.equal(foreignOwnWrite.status, 201, 'the foreign organization can write against its own finance category');
  const foreignOwnExpense = (await db.query("SELECT id,venue_id,category_id FROM expenses WHERE id=$1", [foreignOwnWrite.body.id])).rows[0];
  assert.deepEqual(foreignOwnExpense, { id: foreignOwnWrite.body.id, venue_id: ids.foreignVenue, category_id: foreignOrganizationCategoryId }, 'foreign owner write stays within its own venue and category');
  const foreignCategoryAttempt = await foreignApi('/api/expenses', 'POST', { categoryId, amount: 1, expenseDate: today, source: 'manual', description: 'Cross organization category attempt' });
  assert.equal(foreignCategoryAttempt.status, 400, 'the foreign organization cannot attach a category from another organization');
  assert.equal(foreignCategoryAttempt.body.error, 'invalid_finance_category');
  assert.equal((await db.query("SELECT count(*)::int AS count FROM expenses WHERE venue_id=$1 AND description='Cross organization category attempt'", [ids.foreignVenue])).rows[0].count, 0, 'cross-organization category rejection creates no foreign expense');
  assert.ok(foreignOrganizationCategoryId, 'the separate organization fixture owns an independent finance category');
  await foreignContext.close();
  const storedAgain = (await db.query('SELECT id,document_url FROM expenses WHERE id=$1 AND venue_id=$2', [expenseId, venueId])).rows[0];
  assert.equal(storedAgain.document_url, saved[0].document_url);
  assert.deepEqual(errors.filter((message) => !message.includes('ViewTransition opt-in disabled')), []);
  console.log('ACCEPTANCE #33 EXPENSE DOCUMENT POSTGRES BROWSER QA: PASS (authenticated finance UI upload/retry/open, exact 1.4 MB and over-limit API boundary, finance_read API read-only, venue and cross-organization isolation, PostgreSQL readback/reload)');
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
          await db.query('DELETE FROM auth_sessions WHERE user_id=ANY($1::uuid[])', [[ids.owner, ids.manager, ids.otherOwner, ids.foreignOwner]]);
          await db.query('DELETE FROM expenses WHERE venue_id=ANY($1::uuid[])', [[venueId, ids.otherVenue, ids.foreignVenue]]);
          await db.query('DELETE FROM finance_categories WHERE venue_id=ANY($1::uuid[])', [[venueId, ids.otherVenue, ids.foreignVenue]]);
          await db.query('DELETE FROM audit_events WHERE venue_id=ANY($1::uuid[])', [[venueId, ids.otherVenue, ids.foreignVenue]]);
          await db.query('DELETE FROM organization_memberships WHERE organization_id=$1', [ids.organization]);
          await db.query('DELETE FROM organization_memberships WHERE organization_id=$1', [ids.foreignOrganization]);
          await db.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [[ids.owner, ids.manager, ids.otherOwner, ids.foreignOwner]]);
          await db.query("DELETE FROM venues WHERE id=ANY($1::uuid[])", [[venueId, ids.otherVenue, ids.foreignVenue]]);
          await db.query('DELETE FROM organization_subscriptions WHERE organization_id=$1', [ids.organization]);
          await db.query('DELETE FROM organization_subscriptions WHERE organization_id=$1', [ids.foreignOrganization]);
          await db.query('DELETE FROM organizations WHERE id=$1', [ids.organization]);
          await db.query('DELETE FROM organizations WHERE id=$1', [ids.foreignOrganization]);
          await db.query('COMMIT');
          assert.equal((await db.query('SELECT count(*)::int AS count FROM venues WHERE id=$1', [venueId])).rows[0].count, 0, 'QA venue removed');
        } catch (error) { await db.query('ROLLBACK').catch(() => {}); throw error; }
      }
    } finally { await db.end(); }
  }
}
