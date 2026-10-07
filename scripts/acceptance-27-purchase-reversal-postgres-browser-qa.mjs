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
const target = validateQaDatabaseUrl(process.env.MIGRATIONS_PG_TEST_DATABASE_URL, 'MIGRATIONS_PG_TEST_DATABASE_URL');
assert.match(target.database, /^inventory_qa_[a-f0-9]{16}$/i);
assert.equal(target.database, process.env.LOCAL_FULL_PG_OWNED_DATABASE);
assert.equal(process.env.MIGRATIONS_PG_TEST_DOCKER_CONTAINER, 'hookah-full-regression-qa-20261001');
const lock = JSON.parse(fs.readFileSync(path.join(root, 'tmp', 'full-local-qa', 'pg-regression-runner.lock'), 'utf8'));
assert.equal(Number(lock.pid), process.ppid);
assert.match(lock.id || '', /^[0-9a-f-]{36}$/i);
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_PACKAGE_PATH);
const db = new pg.Client({ connectionString: target.url.href, connectionTimeoutMillis: 5000 });
const marker = randomBytes(4).toString('hex');
const ids = { organization: randomUUID(), venue: randomUUID(), owner: randomUUID() };
const login = `qa27-ui-${marker}`, password = `qa27-${randomUUID()}`;
const hashPassword = () => { const salt = randomBytes(16).toString('hex'); return `scrypt$${salt}$${scryptSync(password, salt, 64).toString('hex')}`; };
let connected = false, server, serverExit, output = '', browser, context, page, assertions = 0;
const check = (value, message) => { assert.ok(value, message); assertions++; };
try {
  await db.connect(); connected = true;
  const identity = (await db.query('SELECT current_database() AS database,inet_server_addr()::text AS address,inet_server_port() AS port,COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname=current_user),false) AS superuser')).rows[0];
  assertQaDatabaseIdentity(identity, target.database, Number(target.url.port || 5432), 'acceptance #27 authenticated browser PostgreSQL');
  await db.query('BEGIN');
  try {
    await db.query('INSERT INTO organizations(id,name,slug,timezone) VALUES($1,$2,$3,$4)', [ids.organization, 'QA27 browser reversal', `qa27-${ids.organization}`, 'Asia/Yekaterinburg']);
    await db.query("INSERT INTO organization_subscriptions(organization_id,status) VALUES($1,'trialing')", [ids.organization]);
    await db.query('INSERT INTO venues(id,organization_id,name,timezone) VALUES($1,$2,$3,$4)', [ids.venue, ids.organization, `QA27 Browser ${marker}`, 'Asia/Yekaterinburg']);
    await db.query("INSERT INTO inventory_purchase_reversal_policies(venue_id,version,mode,enabled) VALUES($1,1,'safe_full_unpaid_unused',true) ON CONFLICT(venue_id,version) DO NOTHING", [ids.venue]);
    await db.query("INSERT INTO inventory_departments(venue_id,code,name) VALUES($1,'bar','Бар') ON CONFLICT(venue_id,code) DO NOTHING", [ids.venue]);
    await db.query("INSERT INTO users(id,organization_id,venue_id,full_name,login,password_hash,role,permission_scopes) VALUES($1,$2,$3,'QA27 synthetic owner',$4,$5,'owner','[\"inventory\",\"finance\",\"settings\"]'::jsonb)", [ids.owner, ids.organization, ids.venue, login, hashPassword()]);
    await db.query("INSERT INTO organization_memberships(organization_id,user_id,membership_role,status) VALUES($1,$2,'owner','active')", [ids.organization, ids.owner]);
    await db.query("INSERT INTO shifts(venue_id,opened_by,opening_cash) VALUES($1,$2,0)", [ids.venue,ids.owner]);
    await db.query('COMMIT');
  } catch (error) { await db.query('ROLLBACK'); throw error; }

  server = spawn(process.execPath, ['server.js'], { cwd: root, windowsHide: true,
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', DATABASE_URL: target.url.href, VENUE_ID: ids.venue, AUTH_REQUIRED: 'true', DEMO_MODE: 'false', NODE_ENV: 'test', API_RATE_LIMIT: '5000' },
    stdio: ['ignore', 'pipe', 'pipe'] });
  serverExit = new Promise(resolve => server.once('exit', resolve));
  server.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; }); server.stderr.setEncoding('utf8').on('data', chunk => { output += chunk; });
  let base; const deadline = Date.now() + 20000;
  while (!base && Date.now() < deadline) { const match = output.match(/CRM running on http:\/\/localhost:(\d+)/); if (match) base = `http://127.0.0.1:${match[1]}`; else if (server.exitCode !== null) throw new Error(`QA server exited: ${output}`); else await delay(50); }
  check(Boolean(base), `isolated server starts: ${output}`);
  const health = await fetch(`${base}/api/health`); assert.equal(health.status, 200); assertions++;
  assert.equal((await health.json()).database, 'postgres'); assertions++;

  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'ru-RU', timezoneId: 'Asia/Yekaterinburg', acceptDownloads: false });
  page = await context.newPage();
  const pageErrors = []; page.on('pageerror', error => pageErrors.push(error.stack || error.message));
  await page.goto(`${base}/login`, { waitUntil: 'networkidle' });
  await page.locator('#login-username').fill(login); await page.locator('#login-password').fill(password);
  await page.locator('#login-form button[type="submit"]').click(); await page.waitForURL(url => url.pathname !== '/login');
  const token = await page.evaluate(() => localStorage.getItem('crm_session_token'));
  check(Boolean(token), 'owner authenticates through browser password login');
  const sessionUser = await page.evaluate(() => JSON.parse(localStorage.getItem('crm_session_user') || '{}'));
  check((sessionUser.permissionScopes || []).includes('inventory') && (sessionUser.permissionScopes || []).includes('finance'), `browser session includes the dual-authorization scopes: ${JSON.stringify(sessionUser)}`);
  const api = async (route, method = 'GET', body, expectedStatus = 200) => {
    const response = await context.request.fetch(`${base}${route}`, { method, ...(body === undefined ? {} : { data: body }), headers: { Authorization: `Bearer ${token}`, 'X-Organization-Id': ids.organization } });
    const payload = await response.json().catch(() => ({}));
    assert.equal(response.status(), expectedStatus, `${method} ${route}: ${JSON.stringify(payload)}`); assertions++;
    return payload;
  };

  await page.goto(`${base}/admin#company`, { waitUntil: 'networkidle' });
  const policyToggle = page.locator('#purchase-reversal-enabled'); await policyToggle.waitFor({ state: 'visible' });
  const uiPolicy = await api('/api/venue/purchase-reversal-policy');
  check(uiPolicy.enabled === true && uiPolicy.version === 1, `UI owner reads its venue's initial rule: ${JSON.stringify(uiPolicy)}`);
  check(await policyToggle.isChecked(), 'new venue loads safe reversal policy enabled');
  const reversalPolicyCopy = await page.locator('.purchase-reversal-settings').innerText();
  check(reversalPolicyCopy.includes('ручной расход не подтверждает оплату конкретного прихода'), 'settings clarify that supplier payments must use the linked receipt payable flow');
  // Keep the venue policy enabled for this primary browser happy path. The
  // API acceptance separately proves prospective versioning after a change.

  const category = await api('/api/product-categories', 'POST', { name: `QA27 Category ${marker}`, department: 'bar' }, 201);
  const ingredient = await api('/api/inventory/items', 'POST', { name: `QA27 Tobacco ${marker}`, unit: 'г', purchaseUnit: 'пачка', packMultiplier: 100, itemType: 'ingredient', cost: 20, department: 'bar', category: category.name, categoryId: category.id }, 201);
  await page.goto(`${base}/inventory?view=movements`, { waitUntil: 'networkidle' });
  await page.locator('#purchase-document-form').waitFor({ state: 'visible' });
  const supplier = `QA27 Supplier ${marker}`, number = `QA27-${marker}`;
  await page.locator('#purchase-supplier').fill(supplier); await page.locator('#purchase-number').fill(number);
  const line = page.locator('#purchase-lines .purchase-line').first();
  await line.locator('[data-purchase-field="ingredientId"]').selectOption(ingredient.id);
  await line.locator('[data-purchase-field="quantity"]').fill('1');
  await line.locator('[data-purchase-field="unit"]').fill('пачка');
  await line.locator('[data-purchase-field="unitCost"]').fill('80');
  const createResponsePromise = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/inventory/purchase-documents');
  await page.locator('#purchase-save').click(); const createResponse = await createResponsePromise;
  assert.equal(createResponse.status(), 201); assertions++;
  const draft = await createResponse.json(); assert.equal(draft.status, 'draft'); assertions++;
  const row = page.locator('.purchase-document-row').filter({ hasText: supplier }); await row.waitFor({ state: 'visible' });
  page.once('dialog', dialog => dialog.accept());
  const postResponsePromise = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/inventory/purchase-documents/${draft.id}/post`);
  await row.locator('[data-purchase-post]').click(); const postResponse = await postResponsePromise;
  assert.equal(postResponse.status(), 200); assertions++;
  const posted = await postResponse.json();
  check(posted.document.status === 'posted', `UI posts the receipt: ${JSON.stringify(posted.document)}`);
  await page.getByText('Поступление проведено: остаток и стоимость обновлены', { exact: true }).waitFor({ state: 'visible' });
  await row.waitFor({ state: 'visible' });
  const refreshedRow = page.locator('.purchase-document-row').filter({ hasText: supplier }); await refreshedRow.waitFor({ state: 'visible' });
  await refreshedRow.locator('[data-purchase-reverse]').waitFor({ state: 'visible', timeout: 3000 }).catch(async () => {
    const latest = await api('/api/inventory/purchase-documents');
    throw new Error(`UI did not offer reversal: ${JSON.stringify({ permissions: await page.evaluate(() => ({ inventory: window.portalPermissions.has('inventory'), finance: window.portalPermissions.has('finance') })), doc: latest.items.find(item => item.id === draft.id), row: await refreshedRow.innerText().catch(() => null) })}`);
  });
  page.on('dialog', dialog => dialog.accept('Duplicate supplier receipt'));
  const reverseResponsePromise = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/inventory/purchase-documents/${draft.id}/reverse`);
  await refreshedRow.locator('[data-purchase-reverse]').click(); const reverseResponse = await reverseResponsePromise;
  const reversed = await reverseResponse.json();
  assert.equal(reverseResponse.status(), 200, `browser reversal succeeds: ${JSON.stringify(reversed)}`); assertions++;
  check(reversed.idempotent === false && reversed.reversal.policyVersion === 1, 'browser submits reason and completes reversal under posting-time policy');
  await page.getByText('Приход сторнирован. Исходный документ и история себестоимости сохранены.', { exact: true }).waitFor({ state: 'visible' });
  await refreshedRow.getByText('Сторнирован', { exact: true }).waitFor({ state: 'visible' });
  assert.equal((await api('/api/inventory')).items.find(item => item.id === ingredient.id).onHand, 0); assertions++;
  const persisted = await api('/api/inventory/purchase-documents');
  const persistedDoc = persisted.items.find(item => item.id === draft.id);
  check(persistedDoc.status === 'posted' && persistedDoc.reversal.id === reversed.reversal.id, 'reloadable API keeps source receipt posted and adds reversal lineage');
  assert.deepEqual(pageErrors, [], `browser page has no uncaught errors: ${JSON.stringify(pageErrors)}`); assertions++;
  console.log(`ACCEPTANCE #27 PURCHASE REVERSAL BROWSER QA: PASS (${assertions} assertions; authenticated setting → UI draft → post → reverse → API/UI persistence; temporary PostgreSQL only)`);
} finally {
  if (context) await context.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
  if (server && server.exitCode === null && server.signalCode === null) {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else server.kill('SIGTERM');
    await Promise.race([serverExit, delay(5000)]);
  }
  if (connected) await db.end().catch(() => {});
}
