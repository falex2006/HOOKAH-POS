import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const playwrightPath = process.env.PLAYWRIGHT_PACKAGE_PATH;
if (!playwrightPath) throw new Error('Set PLAYWRIGHT_PACKAGE_PATH');
const { chromium } = createRequire(import.meta.url)(playwrightPath);
const databaseUrl = process.env.LOYALTY_QA_DATABASE_URL || '';
const postgresMode = Boolean(databaseUrl);
const screenshotDir = process.env.LOYALTY_QA_SCREENSHOT_DIR;
if (screenshotDir) await mkdir(screenshotDir, { recursive: true });
let postgresClient;
let qaDatabaseName;
if (postgresMode) {
  const parsed = new URL(databaseUrl);
  qaDatabaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  const { verifyLoyaltyQaDatabaseUrl } = createRequire(import.meta.url)('./local-full-pg-regression.cjs');
  assert.equal(await verifyLoyaltyQaDatabaseUrl(databaseUrl), qaDatabaseName, 'PostgreSQL browser QA target belongs to the verified disposable runner');
  const { Client } = createRequire(import.meta.url)('pg');
  postgresClient = new Client({ connectionString: databaseUrl });
  try {
    await postgresClient.connect();
    const identity = (await postgresClient.query('SELECT current_database() AS database,inet_server_addr()::text AS address,inet_server_port() AS port,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser')).rows[0];
    assert.equal(identity.database, qaDatabaseName, 'browser QA connects to its exact disposable database');
    const activeUsers = await postgresClient.query('SELECT COUNT(*)::int AS count FROM users WHERE is_active=true AND deleted_at IS NULL');
    assert.equal(activeUsers.rows[0].count, 0, 'first-run PostgreSQL database has no pre-seeded active user');
  } catch (error) {
    await postgresClient.end().catch(() => {});
    postgresClient = null;
    throw error;
  }
}
const capture = async (page, name, viewport, fullPage = true) => {
  if (!screenshotDir) return;
  await page.setViewportSize(viewport);
  const toggle = page.locator('.sidebar-mobile-toggle');
  if (await toggle.count() && await toggle.getAttribute('aria-expanded') === 'true') await toggle.click();
  await page.waitForFunction(() => {
    const sidebar = document.querySelector('.portal-sidebar');
    if (!sidebar || innerWidth > 900) return true;
    return sidebar.getBoundingClientRect().right <= 1;
  }, null, { timeout: 1000 }).catch(() => {});
  await page.screenshot({ path: join(screenshotDir, `${name}-${viewport.width}x${viewport.height}.png`), fullPage });
};
const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const ownerPassword = `qa-owner-${runId}`;
const staffPassword = 'qa-pass-123';
const logins = { manager: `ljm_${runId.replace(/\W/g, '')}`, bartender: `ljb_${runId.replace(/\W/g, '')}` };
const child = spawn(process.execPath, ['server.js'], {
  cwd: fileURLToPath(new URL('../', import.meta.url)), windowsHide: true,
  env: { ...process.env, HOST: '127.0.0.1', PORT: '0', DATABASE_URL: databaseUrl, VENUE_ID: 'venue-territory', AUTH_REQUIRED: 'true', FIRST_RUN_SETUP_ENABLED: String(postgresMode), DEMO_MODE: 'false', NODE_ENV: 'test', API_RATE_LIMIT: '5000', DEMO_OWNER_PASSWORD: postgresMode ? '' : ownerPassword, DEMO_ADMIN_PASSWORD: '', SAAS_OWNER_EMAIL: '', SAAS_OWNER_PASSWORD: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stdout.on('data', (chunk) => { output += chunk; });
child.stderr.on('data', (chunk) => { output += chunk; });
let base;
let browser;
try {
  base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Isolated loyalty QA server did not start: ${output}`)), 15000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.stdout.on('data', () => { const match = output.match(/CRM running on http:\/\/localhost:(\d+)/); if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); } });
  });
  if (postgresMode) {
    const healthResponse = await fetch(`${base}/api/health`);
    const health = await healthResponse.json();
    assert.equal(health.status, 'ok');
    assert.equal(health.database, 'postgres', 'child CRM server is connected to PostgreSQL');
    const setupStatusResponse = await fetch(`${base}/api/setup/status`);
    assert.deepEqual(await setupStatusResponse.json(), { required: true }, 'empty database requires first-run owner setup');
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
    const setupContext = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ru-RU' });
    try {
      const setupPage = await setupContext.newPage();
      const runLogin = `loyalty-${runId.replace(/[^a-z0-9]/gi, '')}@example.test`;
      await setupPage.goto(`${base}/login`, { waitUntil: 'domcontentloaded' });
      await setupPage.locator('#setup-form').waitFor({ state: 'visible' });
      await setupPage.locator('#setup-venue').fill(`Loyalty QA ${runId}`);
      await setupPage.locator('#setup-name').fill('Loyalty QA Owner');
      await setupPage.locator('#setup-city').fill('Екатеринбург');
      await setupPage.locator('#setup-login').fill(runLogin);
      await setupPage.locator('#setup-password').fill(ownerPassword);
      await setupPage.locator('#setup-timezone').selectOption('Asia/Yekaterinburg');
      await setupPage.locator('#setup-form button[type="submit"]').click();
      await setupPage.waitForURL('**/admin', { timeout: 15000 });
      const bootstrapped = await setupPage.evaluate(() => ({ token: localStorage.getItem('crm_session_token'), user: JSON.parse(localStorage.getItem('crm_session_user') || 'null') }));
      assert.ok(bootstrapped.token && !bootstrapped.token.startsWith('demo-static-'), 'first-run form establishes a real PostgreSQL-backed session');
      assert.equal(bootstrapped.user?.role, 'owner');
      const sessionResponse = await fetch(`${base}/api/session`, { headers: { Authorization: `Bearer ${bootstrapped.token}` } });
      const ownerSession = await sessionResponse.json();
      assert.equal(sessionResponse.status, 200, 'first-run UI session can be independently verified by the server');
      assert.equal(ownerSession.user?.role, 'owner');
      const completedStatus = await fetch(`${base}/api/setup/status`);
      assert.deepEqual(await completedStatus.json(), { required: false }, 'owner setup closes after creating the first tenant account');
      globalThis.loyaltyQaOwner = { login: runLogin, token: bootstrapped.token, user: ownerSession.user };
    } finally { await setupContext.close(); }
  }
  const call = async (path, method = 'GET', token, data) => {
    const response = await fetch(`${base}${path}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(data ? { 'Content-Type': 'application/json' } : {}) }, body: data ? JSON.stringify(data) : undefined });
    const body = await response.json();
    return { status: response.status, body };
  };
  const expect = (result, status, label) => { assert.equal(result.status, status, `${label}: ${JSON.stringify(result.body)}`); return result.body; };
  const admin = postgresMode ? { token: globalThis.loyaltyQaOwner.token } : expect(await call('/api/login', 'POST', null, { username: 'owner', password: ownerPassword }), 200, 'owner login');
  const ownerSession = postgresMode ? { user: globalThis.loyaltyQaOwner.user } : expect(await call('/api/session', 'GET', admin.token), 200, 'owner browser session');
  const venue = expect(await call('/api/network/venues', 'GET', admin.token), 200, 'current venue').items.find((item) => item.isCurrent);
  assert.ok(venue?.id, 'isolated current venue exists');
  for (const role of ['manager', 'bartender']) expect(await call('/api/staff', 'POST', admin.token, { name: `Loyalty QA ${role}`, login: logins[role], password: staffPassword, role, birthDate: '1990-01-01' }), 201, `${role} account`);
  browser ||= await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
  const groupName = `Loyalty QA group ${runId}`;
  const editedGroupName = `${groupName} UI edited`;
  const groupContext = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ru-RU' });
  await groupContext.addInitScript(({ token, user }) => { localStorage.setItem('crm_session_token', token); localStorage.setItem('crm_session_user', JSON.stringify(user)); }, { token: admin.token, user: ownerSession.user });
  let group;
  try {
    const page = await groupContext.newPage();
    await page.goto(`${base}/admin#loyalty`, { waitUntil: 'domcontentloaded' });
    await page.locator('#loyalty-form-visible').waitFor({ state: 'visible' });
    await page.locator('#loyalty-name').fill(groupName);
    await page.locator('#loyalty-discount').fill('10');
    await page.locator('#loyalty-bonus').fill('3');
    await page.locator('#loyalty-deposit').fill('500');
    const createGroupResponse = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/discount-groups');
    await page.locator('#loyalty-form-visible button[type="submit"]').click();
    assert.equal((await createGroupResponse).status(), 201, 'owner creates discount/bonus/deposit group through the UI');
    const createdGroups = expect(await call('/api/discount-groups', 'GET', admin.token), 200, 'owner rereads UI-created group').items;
    const createdGroup = createdGroups.find((entry) => entry.name === groupName);
    assert.ok(createdGroup?.id && createdGroup.active, 'UI-created group persists as active');
    assert.deepEqual([createdGroup.discountPercent, createdGroup.bonusPercent, createdGroup.depositMin], [10, 3, 500]);
    await page.locator(`[data-loyalty-edit="${createdGroup.id}"]`).click();
    await page.locator('#loyalty-name').fill(editedGroupName);
    const updateGroupResponse = page.waitForResponse((response) => response.request().method() === 'PATCH' && new URL(response.url()).pathname === `/api/discount-groups/${createdGroup.id}`);
    await page.locator('#loyalty-form-visible button[type="submit"]').click();
    assert.equal((await updateGroupResponse).status(), 200, 'owner edits discount group through the UI');
    group = expect(await call('/api/discount-groups', 'GET', admin.token), 200, 'owner rereads edited group').items.find((entry) => entry.id === createdGroup.id);
    assert.equal(group.name, editedGroupName);
    assert.deepEqual([group.discountPercent, group.bonusPercent, group.depositMin], [10, 3, 500], 'UI edit preserves the group financial rules');
  } finally { await groupContext.close(); }

  const product = expect(await call('/api/products', 'POST', admin.token, { name: `Loyalty QA product ${runId}`, category: 'Бар', price: 1000, inventoryMode: 'non_stock' }), 201, 'product');
  const zone = expect(await call('/api/floor/zones', 'POST', admin.token, { expectedVenueId: venue.id, name: `Loyalty QA zone ${runId}` }), 201, 'zone');
  const table = expect(await call('/api/floor/tables', 'POST', admin.token, { expectedVenueId: venue.id, zoneId: zone.id, name: `Loyalty QA table ${runId}`, capacity: 2 }), 201, 'table');
  const tenderTable = expect(await call('/api/floor/tables', 'POST', admin.token, { expectedVenueId: venue.id, zoneId: zone.id, name: `Loyalty QA tender table ${runId}`, capacity: 2 }), 201, 'tender table');
  const reservationTable = expect(await call('/api/floor/tables', 'POST', admin.token, { expectedVenueId: venue.id, zoneId: zone.id, name: `Loyalty QA booking table ${runId}`, capacity: 2 }), 201, 'reservation table');
  const shift = await call('/api/shifts', 'POST', admin.token, { openingCash: 0 });
  if (shift.status !== 201 && shift.body.error !== 'shift_already_open') expect(shift, 201, 'isolated shift');

  const guest = expect(await call('/api/clients', 'POST', admin.token, { name: `Loyalty QA guest ${runId}`, discountGroupId: group.id }), 201, 'guest');
  const bonusFixture = expect(await call(`/api/clients/${guest.id}/loyalty`, 'POST', admin.token, { delta: 40, reason: 'Synthetic isolated browser QA fixture', idempotencyKey: `lj-bonus-${runId}` }), 200, 'synthetic bonus fixture');
  assert.equal(bonusFixture.bonusBalance, 40, 'isolated guest starts with a ledger-backed bonus balance');
  const depositFixture = expect(await call(`/api/clients/${guest.id}/deposit-top-ups`, 'POST', admin.token, { amount: 50, method: 'card', reason: 'Synthetic isolated browser QA fixture', idempotencyKey: `lj-deposit-${runId}` }), 201, 'synthetic deposit fixture');
  assert.equal(depositFixture.depositBalance, 50, 'isolated guest starts with a ledger-backed cash balance');
  const now = Date.now();
  const campaign = expect(await call('/api/loyalty/promotions', 'POST', admin.token, {
    expectedVenueId: venue.id, name: `Loyalty QA campaign ${runId}`, description: 'Изолированная проверка',
    startsAt: new Date(now - 60000).toISOString(), endsAt: new Date(now + 3600000).toISOString(), timezone: 'Asia/Yekaterinburg',
    benefitKind: 'percent', benefitValue: 5, priority: 1, includeProductIds: [product.id], excludeProductIds: [], includeCategories: [], excludeCategories: [], status: 'draft',
  }), 201, 'campaign draft');
  const active = expect(await call(`/api/loyalty/promotions/${campaign.promotionId}`, 'PATCH', admin.token, { expectedVenueId: venue.id, expectedVersion: campaign.version, status: 'active' }), 200, 'campaign activation');
  const updatedCampaignName = `Loyalty QA campaign edited ${runId}`;
  const reservationDate = new Date(Date.now() + 48 * 3600000).toISOString().slice(0, 10);
  const reservation = expect(await call('/api/reservations', 'POST', admin.token, { clientId: guest.id, guestName: guest.name, date: reservationDate, time: '20:00', tableId: reservationTable.id, guests: 2, deposit: 500 }), 201, 'unpaid reservation');
  assert.equal(reservation.depositRequired, 500);
  assert.equal(reservation.verifiedDepositPaid, 0, 'reservation deposit requirement is not recorded as received money');
  let reservationReceiptId;
  let reservationOrder;
  const cashierLogin = expect(await call('/api/login', 'POST', null, { username: logins.bartender, password: staffPassword }), 200, 'cashier API login');
  const cashierToken = cashierLogin.token;
  const order = expect(await call('/api/orders', 'POST', cashierToken, { tableId: table.id }), 201, 'cashier opens order');
  const cashierFloor = expect(await call('/api/floor', 'GET', cashierToken), 200, 'cashier floor read');
  assert.ok(cashierFloor.zones.some((entry) => entry.tables.some((tableEntry) => tableEntry.id === table.id)), 'cashier floor is in the same venue as the order');
  const cashierOrderList = expect(await call('/api/orders', 'GET', cashierToken), 200, 'cashier order list');
  assert.ok(cashierOrderList.items.some((entry) => entry.id === order.id), 'cashier can list own open order');
  const tenderOrder = expect(await call('/api/orders', 'POST', cashierToken, { tableId: tenderTable.id }), 201, 'cashier opens isolated wallet tender order');
  expect(await call(`/api/orders/${tenderOrder.id}`, 'PATCH', cashierToken, { clientId: guest.id }), 200, 'cashier links wallet guest');
  expect(await call(`/api/orders/${tenderOrder.id}/items`, 'POST', cashierToken, { productId: product.id, quantity: 1 }), 201, 'cashier adds wallet tender item');
  assert.equal(expect(await call(`/api/orders/${tenderOrder.id}/summary`, 'GET', cashierToken), 200, 'wallet tender quote').due, 900);
  expect(await call(`/api/orders/${order.id}`, 'PATCH', cashierToken, { clientId: guest.id }), 200, 'cashier links guest');
  expect(await call(`/api/orders/${order.id}/items`, 'POST', cashierToken, { productId: product.id, quantity: 1 }), 201, 'cashier adds order item');
  const summary = expect(await call(`/api/orders/${order.id}/summary`, 'GET', cashierToken), 200, 'pricing summary');
  assert.equal(summary.groupDiscountPercent, 10, 'guest discount group is applied');
  assert.equal(summary.source, 'guest_group', 'best valid offer wins instead of stacking group and promotion discounts');
  assert.equal(summary.selectedPromotion, null, 'lower promotion does not stack with larger group discount');
  assert.equal(summary.offers.find((offer) => offer.promotionId === active.promotionId)?.reasonCode, 'better_offer_selected', 'eligible campaign is explained as lower than the group offer');
  assert.equal(summary.due, 900, '10% group discount wins over the 5% campaign');
  const managerToken = expect(await call('/api/login', 'POST', null, { username: logins.manager, password: staffPassword }), 200, 'manager browser API login').token;
  const managerSession = expect(await call('/api/session', 'GET', managerToken), 200, 'manager browser session');
  const cashierSession = expect(await call('/api/session', 'GET', cashierToken), 200, 'cashier browser session');

  browser ||= await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
  const ownerContext = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ru-RU', timezoneId: 'America/Los_Angeles' });
  await ownerContext.addInitScript(({ token, user }) => { localStorage.setItem('crm_session_token', token); localStorage.setItem('crm_session_user', JSON.stringify(user)); }, { token: admin.token, user: ownerSession.user });
  try {
    const page = await ownerContext.newPage();
    const pageErrors = [];
    const promotionWrites = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('request', (request) => { if (['POST', 'PATCH'].includes(request.method()) && /\/api\/loyalty\/promotions(?:\/[^/]+)?$/.test(new URL(request.url()).pathname)) promotionWrites.push(request); });
    await page.goto(`${base}/admin#loyalty`, { waitUntil: 'domcontentloaded' });
    await page.locator('#loyalty-form-visible').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#loyalty-form-visible').isVisible(), true, 'owner can see loyalty group editor');
    assert.equal(await page.locator('#promotion-new').isVisible(), true, 'owner can see campaign editor action');
    await page.waitForFunction(() => { const button = document.querySelector('#promotion-new'); return button && !button.disabled; }, null, { timeout: 10000 });
    await page.locator('#promotion-new').click();
    await page.locator('#promotion-form').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#promotion-timezone').inputValue(), 'Asia/Yekaterinburg', 'new campaign defaults to venue timezone even when the browser is in another timezone');
    const initialStart = await page.locator('#promotion-start').inputValue();
    assert.match(initialStart, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    for (const { width, height } of [{ width: 320, height: 740 }, { width: 390, height: 844 }, { width: 768, height: 1024 }, { width: 1440, height: 900 }, { width: 344, height: 882 }, { width: 717, height: 748 }]) {
      await page.setViewportSize({ width, height });
      const geometry = await page.evaluate(() => {
        const form = document.querySelector('#promotion-form'); const rect = form.getBoundingClientRect();
        const controls = [...form.querySelectorAll('input:not([type=hidden]),select,textarea')].filter((control) => control.getClientRects().length).map((control) => { const bounds = control.getBoundingClientRect(); return { id: control.id, left: bounds.left, right: bounds.right }; });
        const buttons = [...form.querySelectorAll('button')].map((button) => { const bounds = button.getBoundingClientRect(); return { text: button.innerText.trim(), height: bounds.height }; });
        return { scrollWidth: document.documentElement.scrollWidth, form: { left: rect.left, right: rect.right }, controls, buttons };
      });
      assert.ok(geometry.scrollWidth <= width + 1, `campaign form has no page overflow at ${width}px: ${JSON.stringify(geometry)}`);
      assert.ok(geometry.controls.every((control) => control.left >= geometry.form.left - 1 && control.right <= geometry.form.right + 1), `campaign controls fit their form at ${width}px: ${JSON.stringify(geometry)}`);
      await capture(page, width === 320 ? 'loyalty-campaign-editor-phone' : width === 1440 ? 'loyalty-campaign-editor-desktop' : `loyalty-campaign-editor-${width}`, { width, height });
    }
    if (screenshotDir) {
      await page.setViewportSize({ width: 320, height: 740 });
      await page.locator('#promotion-form').screenshot({ path: join(screenshotDir, 'loyalty-campaign-editor-form-320x740.png') });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#promotion-name').fill(`DST campaign ${runId}`);
    await page.locator('#promotion-value').fill('5');
    await page.locator('#promotion-categories').fill('Бар');
    await page.locator('#promotion-timezone').fill('America/New_York');
    await page.locator('#promotion-start').fill('2026-03-08T02:30');
    await page.locator('#promotion-end').fill('2026-03-08T04:30');
    assert.equal(await page.locator('#promotion-form').evaluate((form) => form.checkValidity()), true, 'DST gap scenario is valid at the native form level');
    const writesBeforeDstGap = promotionWrites.length;
    await page.locator('#promotion-form button[type="submit"]').click();
    assert.match(await page.locator('#promotion-message').innerText(), /часовой пояс и корректность локального времени/);
    assert.equal(promotionWrites.length, writesBeforeDstGap, 'nonexistent DST local time is rejected before a write');
    await page.locator('#promotion-start').fill('2026-11-01T01:30');
    await page.locator('#promotion-end').fill('2026-11-01T02:30');
    assert.equal(await page.locator('#promotion-form').evaluate((form) => form.checkValidity()), true, 'DST overlap scenario is valid at the native form level');
    await page.locator('#promotion-form button[type="submit"]').click();
    assert.match(await page.locator('#promotion-message').innerText(), /часовой пояс и корректность локального времени/);
    assert.equal(promotionWrites.length, writesBeforeDstGap, 'ambiguous DST local time is rejected before a write');
    await page.locator('#promotion-cancel').click();
    await page.locator(`[data-promotion-edit="${active.promotionId}"]`).click();
    await page.locator('#promotion-form').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#promotion-timezone').inputValue(), 'Asia/Yekaterinburg', 'existing campaign editor keeps its saved timezone');
    const savedLocalStart = await page.locator('#promotion-start').inputValue();
    const savedLocalEnd = await page.locator('#promotion-end').inputValue();
    await page.locator('#promotion-name').fill(updatedCampaignName);
    const campaignPatchRequest = page.waitForRequest((request) => request.method() === 'PATCH' && new URL(request.url()).pathname === `/api/loyalty/promotions/${active.promotionId}`);
    const campaignPatchResponse = page.waitForResponse((response) => response.request().method() === 'PATCH' && new URL(response.url()).pathname === `/api/loyalty/promotions/${active.promotionId}`);
    await page.locator('#promotion-form button[type="submit"]').click();
    const savedRequest = await campaignPatchRequest;
    const savedResponse = await campaignPatchResponse;
    const savedPayload = savedRequest.postDataJSON();
    assert.equal(savedPayload.timezone, 'Asia/Yekaterinburg');
    assert.equal(savedPayload.startsAt, new Date(`${savedLocalStart}:00+05:00`).toISOString(), 'venue-local campaign start is converted to the expected UTC instant');
    assert.equal(savedPayload.endsAt, new Date(`${savedLocalEnd}:00+05:00`).toISOString(), 'venue-local campaign end is converted to the expected UTC instant');
    assert.equal(savedResponse.status(), 200, 'owner can save an edited campaign through the UI');
    const updatedCampaigns = expect(await call('/api/loyalty/promotions?includeArchived=true', 'GET', admin.token), 200, 'owner rereads saved campaign');
    const updatedCampaign = updatedCampaigns.items.find((entry) => entry.promotionId === active.promotionId);
    assert.equal(updatedCampaign.name, updatedCampaignName);
    assert.equal(updatedCampaign.status, 'active');
    assert.ok(Number(updatedCampaign.version) > Number(active.version), 'campaign update appends a new immutable version');
    await capture(page, 'loyalty-admin-desktop', { width: 1440, height: 900 });
    await capture(page, 'loyalty-admin-phone', { width: 390, height: 844 });
    await capture(page, 'loyalty-admin-fold-cover', { width: 344, height: 882 });
    await capture(page, 'loyalty-admin-fold-inner', { width: 717, height: 748 });
    await page.goto(`${base}/clients`, { waitUntil: 'domcontentloaded' });
    await page.locator('.client-card').filter({ hasText: guest.name }).click();
    await page.locator('#client-history').waitFor({ state: 'visible' });
    await page.waitForFunction(() => /Операции по балансу/.test(document.querySelector('#client-history')?.textContent || ''), null, { timeout: 10000 });
    assert.equal(await page.locator('#client-bonus').getAttribute('readonly'), '', 'guest bonus balance is read-only');
    assert.equal(await page.locator('#client-deposit').getAttribute('readonly'), '', 'guest cash balance is read-only');
    assert.equal(await page.locator('#client-bonus').inputValue(), '40', 'owner sees current bonus wallet');
    assert.equal(await page.locator('#client-deposit').inputValue(), '50', 'owner sees current deposit wallet');
    const guestHistory = await page.locator('#client-history').innerText();
    assert.match(guestHistory, /Операции по балансу/);
    assert.match(guestHistory, /Synthetic isolated browser QA fixture/, 'guest history includes synthetic wallet movements');
    await capture(page, 'loyalty-guest-phone', { width: 390, height: 844 });
    await capture(page, 'loyalty-guest-fold-cover', { width: 344, height: 882 });
    await page.goto(`${base}/reservations`, { waitUntil: 'domcontentloaded' });
    await page.locator('#reservation-list-date').fill(reservationDate);
    const reservationRow = page.locator('#reservation-list .reservation-row').filter({ hasText: guest.name });
    await reservationRow.waitFor();
    assert.match(await reservationRow.innerText(), /Требуется 500\s*₽.*подтверждено 0\s*₽.*остаток 500\s*₽/);
    const reservationTender = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/reservations/${reservation.id}/deposit-receipts` && response.request().method() === 'POST');
    await reservationRow.locator('.reservation-prepayment').click();
    const reservationTenderModal = page.locator('.action-modal.open');
    await reservationTenderModal.waitFor();
    assert.match(await reservationTenderModal.innerText(), /Остаток требования:\s*500\s*₽/, 'reservation tender dialog shows the remaining requirement');
    await reservationTenderModal.locator('[name="amount"]').fill('500');
    await reservationTenderModal.locator('[name="method"]').selectOption('cash');
    await reservationTenderModal.locator('button[type="submit"]').click();
    const reservationTenderResponse = await reservationTender;
    assert.equal(reservationTenderResponse.status(), 201, `synthetic reservation receipt is accepted by the isolated ${postgresMode ? 'PostgreSQL' : 'memory'} QA server`);
    const reservationTenderResult = await reservationTenderResponse.json();
    reservationReceiptId = reservationTenderResult.id;
    assert.ok(reservationReceiptId, 'owner UI receipt response exposes the persisted receipt identifier');
    assert.equal(Number(reservationTenderResult.amount), 500);
    assert.equal(Number(reservationTenderResult.verifiedDepositPaid), 500);
    assert.equal(Number(reservationTenderResult.remaining), 0);
    await page.waitForFunction((name) => [...document.querySelectorAll('#reservation-list .reservation-row')].some((row) => row.innerText.includes(name) && /Требуется 500\s*₽.*подтверждено 500\s*₽.*остаток 0\s*₽/.test(row.innerText)), guest.name);
    await page.locator('#reservation-list .reservation-row').filter({ hasText: guest.name }).locator('[data-reservation-open-order]').click();
    await page.waitForURL((url) => url.pathname === '/' && new URLSearchParams(url.search).has('order'));
    const linkedReservation = expect(await call('/api/reservations', 'GET', admin.token), 200, 'owner rereads the UI-started reservation visit').items.find((entry) => entry.id === reservation.id);
    assert.ok(linkedReservation?.linkedOrderId, 'owner starts the reservation visit from its UI row');
    reservationOrder = expect(await call('/api/orders?scope=all', 'GET', admin.token), 200, 'owner rereads reservation order opened through UI').items.find((entry) => entry.id === linkedReservation.linkedOrderId);
    assert.ok(reservationOrder?.id, 'started order is listed after UI navigation');
    assert.equal(reservationOrder.reservationId, reservation.id);
    assert.equal(reservationOrder.guestId, guest.id);
    assert.deepEqual([reservationOrder.groupDiscountGroupId, reservationOrder.groupDiscountName, Number(reservationOrder.groupDiscountPercent)], [group.id, editedGroupName, 10], 'reservation order captures the active guest-group pricing snapshot on creation');
    await page.goto(`${base}/reservations`, { waitUntil: 'domcontentloaded' });
    await capture(page, 'loyalty-reservation-phone', { width: 390, height: 844 });
    await capture(page, 'loyalty-reservation-fold-cover', { width: 344, height: 882 });
    const responsiveRoutes = ['/admin#loyalty', '/clients', '/reservations', '/orders', '/', '/finance/report'];
    for (const route of responsiveRoutes) {
      await page.goto(`${base}${route}`, { waitUntil: 'domcontentloaded' });
      for (const { width, height } of [{ width: 320, height: 740 }, { width: 390, height: 844 }, { width: 768, height: 1024 }, { width: 1440, height: 900 }, { width: 344, height: 882 }, { width: 717, height: 748 }]) {
        await page.setViewportSize({ width, height });
        const layout = await page.evaluate(() => ({ document: document.documentElement.scrollWidth, viewport: innerWidth, main: document.querySelector('.portal-main')?.scrollWidth, client: document.querySelector('.portal-main')?.clientWidth }));
        assert.ok(layout.document <= width + 1 && (!layout.main || layout.main <= layout.client + 1), `${route} has horizontal overflow at ${width}px: ${JSON.stringify(layout)}`);
      }
    }
    assert.deepEqual(pageErrors.filter((message) => !message.includes('ViewTransition opt-in disabled')), [], 'owner guest and reservation browser pages have no runtime errors');
  } finally { await ownerContext.close(); }

  for (const role of ['manager', 'bartender']) {
    const context = await browser.newContext({ viewport: { width: role === 'bartender' ? 1440 : 390, height: 844 }, locale: 'ru-RU' });
    const token = role === 'manager' ? managerToken : cashierToken;
    const session = role === 'manager' ? managerSession : cashierSession;
    await context.addInitScript(({ sessionToken, user }) => { localStorage.setItem('crm_session_token', sessionToken); localStorage.setItem('crm_session_user', JSON.stringify(user)); }, { sessionToken: token, user: session.user });
    try {
      const page = await context.newPage();
      const pageErrors = [];
      const posResponses = [];
      const paymentWrites = [];
      page.on('pageerror', (error) => pageErrors.push(error.message));
      page.on('response', (response) => { if (/\/api\/(?:session|floor|orders)(?:\?|\/|$)/.test(new URL(response.url()).pathname)) posResponses.push(`${response.status()} ${response.request().method()} ${new URL(response.url()).pathname}`); });
      page.on('request', (request) => { if (request.method() === 'POST' && /\/api\/orders\/[^/]+\/payments$/.test(new URL(request.url()).pathname)) paymentWrites.push({ path: new URL(request.url()).pathname, ...(request.postData() ? JSON.parse(request.postData()) : {}) }); });
      assert.equal(session.user.role, role);
      const promotions = await call('/api/loyalty/promotions', 'GET', token);
      if (role === 'manager') {
        expect(promotions, 200, 'manager can read campaign');
        assert.ok(promotions.body.items.some((entry) => entry.promotionId === active.promotionId));
        expect(await call(`/api/loyalty/promotions/${active.promotionId}`, 'PATCH', token, { expectedVenueId: venue.id, expectedVersion: active.version, status: 'archived' }), 403, 'manager cannot change campaigns');
        await page.goto(`${base}/admin#loyalty`, { waitUntil: 'domcontentloaded' });
        await page.locator('#promotion-list').waitFor();
        await page.getByText(updatedCampaignName, { exact: false }).waitFor({ state: 'visible' });
        assert.match(await page.locator('#promotion-list').innerText(), new RegExp(updatedCampaignName));
        assert.equal(await page.locator('#promotion-new').isVisible(), false, 'manager cannot see campaign editor action');
        assert.equal(await page.locator('#promotion-form').isVisible(), false, 'manager campaign form stays hidden');
      } else {
        expect(promotions, 200, 'cashier can read campaign details used for checkout');
        assert.ok(promotions.body.items.some((entry) => entry.promotionId === active.promotionId));
        expect(await call(`/api/loyalty/promotions/${active.promotionId}`, 'PATCH', token, { expectedVenueId: venue.id, expectedVersion: active.version, status: 'archived' }), 403, 'cashier cannot change campaigns');
        const quote = await call(`/api/orders/${order.id}/summary`, 'GET', token);
        expect(quote, 200, 'cashier can read active sale quote');
        assert.equal(quote.body.due, 900);
        expect(await call(`/api/clients/${guest.id}/account-entries`, 'GET', token), 403, 'cashier cannot read guest financial ledger');
        await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
        const queueOrder = page.locator(`#queue-list [data-queue-order="${order.id}"]`);
        try { await queueOrder.waitFor({ state: 'visible', timeout: 10000 }); }
        catch (error) {
          const diagnostics = await page.evaluate(() => ({ url: location.href, token: Boolean(localStorage.getItem('crm_session_token')), header: document.querySelector('.staff-header-user')?.innerText, status: document.querySelector('#staff-session-status')?.innerText, floor: document.querySelector('#tables')?.innerText, zones: document.querySelector('.tabs')?.innerText, queue: document.querySelector('#queue-list')?.innerText, floorTables: document.querySelectorAll('.table').length, queueCards: document.querySelectorAll('#queue-list [data-queue-order]').length, splitButton: document.querySelector('#split-payment')?.outerHTML }));
          throw new Error(`${error.message}; POS diagnostics=${JSON.stringify({ ...diagnostics, responses: posResponses, pageErrors })}`);
        }
        await queueOrder.click();
        await page.locator('#split-payment:not([disabled])').waitFor({ state: 'visible' });
        await page.locator('#split-payment').click();
        await page.locator('#payment-modal.open').waitFor();
        await page.waitForFunction(() => /900\s*₽/.test(document.querySelector('#payment-due')?.textContent || ''), null, { timeout: 10000 });
        assert.match(await page.locator('#payment-due').innerText(), /900\s*₽/);
        const paymentExplanation = await page.locator('#payment-message').innerText();
        assert.match(paymentExplanation, /скидка/i, 'POS explains the winning guest-group discount');
        assert.match(paymentExplanation, /Акция.*не выбрано: есть более выгодное предложение/, 'POS explains why the lower campaign is not stacked');
        assert.equal(await page.locator('#payment-form button[type="submit"]').isEnabled(), true, 'payment form is ready');
        assert.equal(await page.locator('#payment-bonus-field').isVisible(), true, 'linked guest unlocks bonus tender');
        assert.equal(await page.locator('#payment-deposit-field').isVisible(), true, 'linked guest unlocks deposit tender');
        assert.equal(await page.locator('#payment-reservation-field').isVisible(), false, 'reservation tender row stays hidden when this order has no available receipt');
        assert.equal(await page.locator('#payment-bonus').getAttribute('max'), '40');
        assert.equal(await page.locator('#payment-deposit').getAttribute('max'), '50');
        await page.locator('#payment-close').click();
        assert.equal(paymentWrites.length, 0, 'opening/closing POS quote performs no payment mutation');

        await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
        const tenderQueueOrder = page.locator(`#queue-list [data-queue-order="${tenderOrder.id}"]`);
        await tenderQueueOrder.waitFor({ state: 'visible', timeout: 10000 });
        await tenderQueueOrder.click();
        await page.locator('#split-payment:not([disabled])').waitFor({ state: 'visible' });
        await page.locator('#split-payment').click();
        await page.locator('#payment-modal.open').waitFor();
        await page.waitForFunction(() => /40 бонусов.*50\s*₽/.test(document.querySelector('#payment-message')?.textContent || ''));
        assert.match(await page.locator('#payment-message').innerText(), /40 бонусов.*50\s*₽/, 'cashier sees current wallet balances in POS');
        assert.equal(await page.locator('#payment-message').evaluate((element) => element.tabIndex), 0, 'POS price explanation can receive keyboard focus');
        for (const [width, height] of [[320, 740], [390, 844], [768, 1024], [1440, 900], [344, 882], [717, 748]]) {
          await page.setViewportSize({ width, height });
          await page.locator('.payment-box').evaluate((box) => { box.scrollTop = 0; });
          const geometry = await page.evaluate(() => {
            const box = document.querySelector('.payment-box');
            const rect = box.getBoundingClientRect();
            const close = document.querySelector('#payment-close').getBoundingClientRect();
            const fieldsBox = document.querySelector('.payment-fields').getBoundingClientRect();
            const submit = document.querySelector('#payment-form button[type="submit"]').getBoundingClientRect();
            const fields = [...box.querySelectorAll('.payment-fields input, .payment-fields select')].filter((control) => !control.closest('label[hidden]')).map((control) => { const field = control.getBoundingClientRect(); return { id: control.id || control.name, left: field.left, right: field.right }; });
            return { width: innerWidth, height: innerHeight, bodyWidth: document.documentElement.scrollWidth, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, closeTop: close.top, closeBottom: close.bottom, closeWidth: close.width, closeHeight: close.height, fieldsBoxHeight: fieldsBox.height, submitTop: submit.top, submitBottom: submit.bottom, fields };
          });
          assert.ok(geometry.bodyWidth <= width + 1 && geometry.left >= -1 && geometry.right <= width + 1, `POS payment modal fits width ${width}: ${JSON.stringify(geometry)}`);
          assert.ok(geometry.closeTop >= 0 && geometry.closeBottom <= height, `POS modal close control is reachable at ${width}: ${JSON.stringify(geometry)}`);
          assert.ok(geometry.closeWidth >= 44 && geometry.closeHeight >= 44, `POS modal close control meets the 44px touch target at ${width}: ${JSON.stringify(geometry)}`);
          if (width <= 540) assert.ok(geometry.submitTop >= geometry.top - 1 && geometry.submitBottom <= geometry.bottom + 1, `POS save action stays visible while tender fields scroll at ${width}px: ${JSON.stringify(geometry)}`);
          const overflowingFields = geometry.fields.filter((field) => field.left < geometry.left || field.right > geometry.right);
          assert.deepEqual(overflowingFields, [], `POS tender fields fit inside the payment modal at ${width}px: ${JSON.stringify(geometry)}`);
          await capture(page, 'loyalty-pos-payment', { width, height }, false);
          await page.locator('#payment-form button[type="submit"]').scrollIntoViewIfNeeded();
          const submitGeometry = await page.locator('#payment-form button[type="submit"]').evaluate((button) => { const rect = button.getBoundingClientRect(); const box = document.querySelector('.payment-box').getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom, boxTop: box.top, boxBottom: box.bottom }; });
          assert.ok(submitGeometry.top >= submitGeometry.boxTop - 1 && submitGeometry.bottom <= submitGeometry.boxBottom + 1, `POS submit action is reachable at ${width}: ${JSON.stringify(submitGeometry)}`);
        }
        await page.setViewportSize({ width: 320, height: 740 });
        const tenderScrollCue = page.locator('.payment-scroll-cue');
        assert.match(await tenderScrollCue.innerText(), /\u041f\u0440\u043e\u043a\u0440\u0443\u0442\u0438\u0442\u0435 \u0441\u043f\u0438\u0441\u043e\u043a/, 'mobile POS exposes a scroll cue as readable content when guest tenders are available');
        assert.equal(await tenderScrollCue.getAttribute('role'), 'note', 'mobile POS scroll cue has a semantic note role');
        assert.notEqual(await tenderScrollCue.evaluate((element) => getComputedStyle(element).display), 'none', 'mobile POS scroll cue is visible when guest tenders are available');
        await page.locator('#payment-message').focus();
        assert.equal(await page.locator('#payment-message').evaluate((element) => element === document.activeElement), true, 'mobile price explanation is keyboard reachable');
        await page.locator('#payment-deposit').scrollIntoViewIfNeeded();
        assert.equal(await page.locator('#payment-form button[type="submit"]').isVisible(), true, 'POS save action remains visible when the final tender field is in view');
        await capture(page, 'loyalty-pos-payment-scroll-bottom', { width: 320, height: 740 }, false);
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.locator('#payment-bonus').fill('20');
        await page.locator('#payment-deposit').fill('50');
        await page.locator('#payment-cash').fill('830');
        assert.match(await page.locator('#payment-remaining').innerText(), /Остаток 0\s*₽/);
        await page.locator('#payment-form button[type="submit"]').click();
        await page.locator('#payment-modal.open').waitFor({ state: 'hidden' });
        assert.deepEqual(paymentWrites.map((entry) => [entry.path.includes(tenderOrder.id), entry.method]), [[true, 'cash'], [true, 'bonus'], [true, 'deposit']], 'only the wallet tender order creates three POS payment writes');
      }
      assert.deepEqual(pageErrors.filter((message) => !message.includes('ViewTransition opt-in disabled')), [], `${role} browser page errors`);
    } finally { await context.close(); }
  }
  const readbackContext = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ru-RU' });
  await readbackContext.addInitScript(({ token, user }) => { localStorage.setItem('crm_session_token', token); localStorage.setItem('crm_session_user', JSON.stringify(user)); }, { token: admin.token, user: ownerSession.user });
  try {
    const page = await readbackContext.newPage();
    await page.goto(`${base}/clients`, { waitUntil: 'domcontentloaded' });
    await page.locator('.client-card').filter({ hasText: guest.name }).click();
    await page.locator('#client-history').waitFor({ state: 'visible' });
    await page.waitForFunction(() => /Операции по балансу/.test(document.querySelector('#client-history')?.textContent || ''), null, { timeout: 10000 });
    assert.equal(await page.locator('#client-bonus').inputValue(), '46', 'owner browser shows bonus balance after POS tender reload');
    assert.equal(await page.locator('#client-deposit').inputValue(), '0', 'owner browser shows deposit balance after POS tender reload');
    const refreshedHistory = await page.locator('#client-history').innerText();
    assert.match(refreshedHistory, /Бонусы · -20/, 'owner browser history records bonus tender');
    assert.match(refreshedHistory, /Деньги гостя · -50/, 'owner browser history records deposit tender');
    await page.goto(`${base}/finance/report`, { waitUntil: 'domcontentloaded' });
    await page.locator('#loyalty-reconciliation-results').waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.querySelector('#loyalty-reconciliation-message')?.textContent?.startsWith('Период по часовому'));
    const reconciliation = await page.locator('#loyalty-reconciliation-results').innerText();
    assert.match(reconciliation, /Доступно бонусов сейчас/);
    assert.match(reconciliation, /Баланс 46 б\./, 'reconciliation reflects the current synthetic bonus ledger balance');
    assert.match(reconciliation, /Деньги на счетах гостей\s+0\s*₽/, 'reconciliation reflects the depleted guest deposit wallet');
    assert.match(reconciliation, /Начислено бонусов\s+26 б\./);
    assert.match(reconciliation, /Списано при оплате\s+20 б\./);
    assert.match(reconciliation, /Пополнено\s+50\s*₽/);
    assert.match(reconciliation, /Использовано в оплатах\s+50\s*₽/);
    if (!postgresMode) {
      assert.match(reconciliation, /Показатель недоступен в локальном preview/, 'unsupported memory-only reconciliation metrics are labelled unavailable');
      assert.match(reconciliation, /Локальный preview использует memory-хранилище/);
    } else {
      assert.doesNotMatch(reconciliation, /memory-хранилище/);
      assert.match(reconciliation, /Предоплата бронирований/, 'PostgreSQL reconciliation shows persisted reservation prepayment metrics');
    }
    await page.locator('#loyalty-reconciliation-results').scrollIntoViewIfNeeded();
    await capture(page, 'loyalty-reconciliation-desktop', { width: 1440, height: 900 });
    await capture(page, 'loyalty-reconciliation-phone', { width: 390, height: 844 });
    await capture(page, 'loyalty-reconciliation-fold-cover', { width: 344, height: 882 });
    await capture(page, 'loyalty-reconciliation-fold-inner', { width: 717, height: 748 });
  } finally { await readbackContext.close(); }
  const reread = expect(await call(`/api/orders/${order.id}/summary`, 'GET', cashierToken), 200, 're-read quote');
  assert.equal(reread.due, 900, 'quote remains stable after role UI visits');
  const closedTender = expect(await call(`/api/orders/${tenderOrder.id}/payments`, 'GET', cashierToken), 200, 'cashier rereads completed POS tender');
  assert.equal(closedTender.closed, true);
  assert.deepEqual(closedTender.items.map((entry) => entry.method), ['cash', 'bonus', 'deposit']);
  assert.equal(closedTender.items.reduce((sum, entry) => sum + Number(entry.amount), 0), 900);
  assert.equal(closedTender.guestAccount.bonusBalance, 46, 'bonus wallet reflects spending and order earning after full tender');
  assert.equal(closedTender.guestAccount.depositBalance, 0, 'deposit wallet is depleted by the POS tender');
  const ownerLedger = expect(await call(`/api/clients/${guest.id}/account-entries`, 'GET', admin.token), 200, 'owner rereads guest wallet ledger');
  assert.equal(ownerLedger.balances.bonus, 46);
  assert.equal(ownerLedger.balances.deposit, 0);
  assert.ok(ownerLedger.items.some((entry) => entry.sourceId === tenderOrder.id && entry.accountType === 'bonus' && Number(entry.amount) === -20));
  assert.ok(ownerLedger.items.some((entry) => entry.sourceId === tenderOrder.id && entry.accountType === 'deposit' && Number(entry.amount) === -50));
  assert.ok(output.includes('CRM running on http://localhost:'), 'child server started in isolated QA mode');
  if (postgresMode) {
    const persisted = await postgresClient.query(`SELECT g.loyalty_points AS bonus_wallet,g.deposit_balance AS deposit_wallet,
      COALESCE(SUM(e.amount) FILTER (WHERE e.account_type='bonus'),0) AS bonus_ledger,
      COALESCE(SUM(e.amount) FILTER (WHERE e.account_type='deposit'),0) AS deposit_ledger
      FROM guests g LEFT JOIN guest_account_entries e ON e.venue_id=g.venue_id AND e.guest_id=g.id
      WHERE g.id=$1 GROUP BY g.id`, [guest.id]);
    assert.equal(Number(persisted.rows[0]?.bonus_wallet), 46);
    assert.equal(Number(persisted.rows[0]?.deposit_wallet), 0);
    assert.equal(Number(persisted.rows[0]?.bonus_ledger), 46, 'independent PostgreSQL ledger reread matches the displayed bonus wallet');
    assert.equal(Number(persisted.rows[0]?.deposit_ledger), 0, 'independent PostgreSQL ledger reread matches the displayed deposit wallet');
  }

  expect(await call(`/api/orders/${reservationOrder.id}/items`, 'POST', admin.token, { productId: product.id, quantity: 1 }), 201, 'owner adds the synthetic product to the reservation order');
  const reservationOrderQuote = expect(await call(`/api/orders/${reservationOrder.id}/summary`, 'GET', admin.token), 200, 'reservation order quote');
  assert.deepEqual([reservationOrderQuote.source, reservationOrderQuote.groupDiscountPercent, reservationOrderQuote.due], ['guest_group', 10, 900], 'reservation group discount beats the competing 5% campaign');

  const allocationContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ru-RU' });
  await allocationContext.addInitScript(({ token, user }) => { localStorage.setItem('crm_session_token', token); localStorage.setItem('crm_session_user', JSON.stringify(user)); }, { token: managerToken, user: managerSession.user });
  try {
    const page = await allocationContext.newPage();
    const paymentWrites = [];
    page.on('request', (request) => { if (request.method() === 'POST' && new URL(request.url()).pathname === `/api/orders/${reservationOrder.id}/payments`) paymentWrites.push(request); });
    await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
    const queueOrder = page.locator(`#queue-list [data-queue-order="${reservationOrder.id}"]`);
    await queueOrder.waitFor({ state: 'visible', timeout: 10000 });
    await queueOrder.click();
    await page.locator('#split-payment:not([disabled])').waitFor({ state: 'visible' });
    await page.locator('#split-payment').click();
    await page.locator('#payment-modal.open').waitFor();
    await page.locator('#payment-reservation-field').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#payment-reservation-receipt').inputValue(), reservationReceiptId, 'manager POS selects the receipt for this reservation');
    assert.equal(await page.locator('#payment-reservation').getAttribute('max'), '500');
    await page.locator('#payment-reservation').fill('500');
    assert.match(await page.locator('#payment-remaining').innerText(), /Остаток 400\s*₽/);
    const allocationResponsePromise = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/orders/${reservationOrder.id}/payments`);
    await page.locator('#payment-form button[type="submit"]').click();
    const allocationResponse = await allocationResponsePromise;
    const allocationResult = await allocationResponse.json();
    assert.equal(allocationResponse.status(), 201, `manager applies prepayment through POS UI: ${JSON.stringify(allocationResult)}`);
    assert.equal(allocationResult.method, 'reservation');
    assert.equal(Number(allocationResult.amount), 500);
    assert.equal(Number(allocationResult.paid), 500);
    assert.equal(Number(allocationResult.remaining), 400);
    assert.equal(allocationResult.closed, false, 'partial prepayment does not close the order');
    assert.equal(JSON.parse(paymentWrites[0].postData()).method, 'reservation');
    assert.equal(JSON.parse(paymentWrites[0].postData()).receiptId, reservationReceiptId);

    await page.locator('#payment-modal.open').waitFor({ state: 'hidden' });
    await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
    await page.locator(`#queue-list [data-queue-order="${reservationOrder.id}"]`).waitFor({ state: 'visible', timeout: 10000 });
    await page.locator(`#queue-list [data-queue-order="${reservationOrder.id}"]`).click();
    await page.locator('#split-payment:not([disabled])').waitFor({ state: 'visible' });
    const reloadedPaymentStatePromise = page.waitForResponse((response) => response.request().method() === 'GET' && new URL(response.url()).pathname === `/api/orders/${reservationOrder.id}/payments`);
    await page.locator('#split-payment').click();
    await page.locator('#payment-modal.open').waitFor();
    const reloadedPaymentState = await (await reloadedPaymentStatePromise).json();
    assert.equal(Number(reloadedPaymentState.remaining), 400);
    assert.equal(reloadedPaymentState.reservationPrepaymentReceipts.length, 0, 'fully allocated receipt is no longer offered after reloading the order');
    await page.locator('#payment-reservation-field').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => /400\s*₽/.test(document.querySelector('#payment-due')?.textContent || ''));
    assert.match(await page.locator('#payment-due').innerText(), /400\s*₽/);
    await page.locator('#payment-cash').fill('400');
    assert.match(await page.locator('#payment-remaining').innerText(), /Остаток 0\s*₽/);
    const closingResponsePromise = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/orders/${reservationOrder.id}/payments`);
    await page.locator('#payment-form button[type="submit"]').click();
    const closingResponse = await closingResponsePromise;
    const closingResult = await closingResponse.json();
    assert.equal(closingResponse.status(), 201, `manager closes the linked order through POS UI: ${JSON.stringify(closingResult)}`);
    assert.equal(closingResult.method, 'cash');
    assert.equal(Number(closingResult.amount), 400);
    assert.equal(Number(closingResult.paid), 900);
    assert.equal(closingResult.closed, true);
    assert.deepEqual(paymentWrites.map((request) => JSON.parse(request.postData()).method), ['reservation', 'cash']);
  } finally { await allocationContext.close(); }

  const allocatedTender = expect(await call(`/api/orders/${reservationOrder.id}/payments`, 'GET', managerToken), 200, 'manager rereads reservation-linked tender');
  assert.equal(allocatedTender.closed, true);
  assert.equal(allocatedTender.reservationId, reservation.id);
  assert.deepEqual(allocatedTender.items.map((entry) => entry.method), ['reservation', 'cash']);
  assert.deepEqual(allocatedTender.items.map((entry) => Number(entry.amount)), [500, 400]);
  assert.equal(allocatedTender.reservationPrepaymentAvailable, 0, 'receipt has no remaining balance after UI allocation');
  const finalLedger = expect(await call(`/api/clients/${guest.id}/account-entries`, 'GET', admin.token), 200, 'owner rereads loyalty ledger after reservation order closes');
  assert.equal(finalLedger.balances.bonus, 73, 'linked reservation order earns its 27 bonuses after the existing 46-bonus baseline');
  assert.equal(finalLedger.balances.deposit, 0);
  const finalReconciliation = expect(await call('/api/loyalty/reconciliation', 'GET', admin.token), 200, 'owner rereads final loyalty and prepayment reconciliation');
  assert.equal(finalReconciliation.periodMovements.reservationPrepayment.collected, 500);
  assert.equal(finalReconciliation.periodMovements.reservationPrepayment.applied, 500);
  assert.equal(finalReconciliation.balances.reservationPrepayment.unapplied, 0);
  assert.equal(finalReconciliation.periodMovements.bonus.issued, 53);
  assert.equal(finalReconciliation.balances.bonus.wallet, 73);
  if (postgresMode) {
    const allocationRows = await postgresClient.query(`SELECT a.amount,a.receipt_id AS "receiptId",p.method,p.amount AS "paymentAmount",p.status AS "paymentStatus"
      FROM reservation_pre_payment_allocations a JOIN payments p ON p.id=a.payment_id AND p.order_id=a.order_id
      WHERE a.venue_id=(SELECT venue_id FROM reservations WHERE id=$1) AND a.reservation_id=$1 AND a.order_id=$2`, [reservation.id, reservationOrder.id]);
    assert.deepEqual(allocationRows.rows.map((entry) => [Number(entry.amount), entry.receiptId, entry.method, Number(entry.paymentAmount), entry.paymentStatus]), [[500, reservationReceiptId, 'reservation', 500, 'paid']], 'independent SQL confirms the receipt allocation and payment match');
    const finalPersisted = await postgresClient.query(`SELECT g.loyalty_points AS bonus_wallet,g.deposit_balance AS deposit_wallet,
      COALESCE(SUM(e.amount) FILTER (WHERE e.account_type='bonus'),0) AS bonus_ledger,
      COALESCE(SUM(e.amount) FILTER (WHERE e.account_type='deposit'),0) AS deposit_ledger
      FROM guests g LEFT JOIN guest_account_entries e ON e.venue_id=g.venue_id AND e.guest_id=g.id
      WHERE g.id=$1 GROUP BY g.id`, [guest.id]);
    assert.deepEqual([Number(finalPersisted.rows[0]?.bonus_wallet), Number(finalPersisted.rows[0]?.deposit_wallet), Number(finalPersisted.rows[0]?.bonus_ledger), Number(finalPersisted.rows[0]?.deposit_ledger)], [73, 0, 73, 0], 'final PostgreSQL wallets still equal independent append-only ledger totals');

    const refundDate = new Date(Date.now() + 72 * 3600000).toISOString().slice(0, 10);
    const refundReservation = expect(await call('/api/reservations', 'POST', admin.token, { clientId: guest.id, guestName: guest.name, date: refundDate, time: '20:00', tableId: reservationTable.id, guests: 2, deposit: 100 }), 201, 'separate synthetic reservation for refund UI retry');
    const refundContext = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ru-RU' });
    await refundContext.addInitScript(({ token, user }) => { localStorage.setItem('crm_session_token', token); localStorage.setItem('crm_session_user', JSON.stringify(user)); }, { token: admin.token, user: ownerSession.user });
    try {
      const page = await refundContext.newPage();
      let refundPath;
      await page.goto(`${base}/reservations`, { waitUntil: 'domcontentloaded' });
      await page.locator('#reservation-list-date').fill(refundDate);
      let refundRow = page.locator('#reservation-list .reservation-row').filter({ hasText: guest.name });
      await refundRow.waitFor({ state: 'visible' });
      assert.match(await refundRow.innerText(), /Требуется 100\s*₽.*подтверждено 0\s*₽.*остаток 100\s*₽/);
      const receiptResponsePromise = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/reservations/${refundReservation.id}/deposit-receipts`);
      await refundRow.locator('.reservation-prepayment').click();
      const receiptModal = page.locator('.action-modal.open');
      await receiptModal.waitFor();
      await receiptModal.locator('[name="amount"]').fill('100');
      await receiptModal.locator('[name="method"]').selectOption('card');
      await receiptModal.locator('button[type="submit"]').click();
      const receiptResponse = await receiptResponsePromise;
      assert.equal(receiptResponse.status(), 201, 'owner accepts an isolated synthetic card receipt through reservation UI');
      const refundReceipt = await receiptResponse.json();
      assert.equal(Number(refundReceipt.amount), 100);
      assert.equal(Number(refundReceipt.verifiedDepositPaid), 100);
      refundPath = `/api/reservations/${refundReservation.id}/deposit-receipts/${refundReceipt.id}/reversals`;
      const refundPosts = [];
      page.on('request', (request) => {
        if (request.method() === 'POST' && new URL(request.url()).pathname === refundPath) refundPosts.push(JSON.parse(request.postData() || '{}'));
      });
      const refundReason = `Loyalty QA receipt refund ${runId}`;
      let refundAttempts = 0;
      let committedRefund;
      let replayedRefund;
      await page.route(`**${refundPath}`, async (route) => {
        const response = await route.fetch();
        const body = await response.json();
        refundAttempts += 1;
        if (refundAttempts === 1) {
          assert.equal(response.status(), 201, `first isolated refund commits before the response is intentionally lost: ${JSON.stringify(body)}`);
          committedRefund = body;
          await route.abort('failed');
          return;
        }
        replayedRefund = body;
        await route.fulfill({ status: response.status(), contentType: 'application/json', body: JSON.stringify(body) });
      });
      const fillRefundModal = async () => {
        const modal = page.locator('.action-modal.open');
        await modal.waitFor();
        await modal.locator('[name="amount"]').fill('40');
        await modal.locator('[name="method"]').selectOption('card');
        await modal.locator('[name="reason"]').fill(refundReason);
        await modal.locator('button[type="submit"]').click();
      };
      refundRow = page.locator('#reservation-list .reservation-row').filter({ hasText: guest.name });
      const refundButtonSelector = `[data-reservation-receipt-refund][data-receipt-id="${refundReceipt.id}"]`;
      await refundRow.locator(refundButtonSelector).waitFor({ state: 'visible' });
      await refundRow.locator(refundButtonSelector).click();
      await fillRefundModal();
      await page.getByText('Ответ о возврате не получен', { exact: false }).waitFor({ state: 'visible' });
      await page.waitForFunction((selector) => { const button = document.querySelector(selector); return Boolean(button && !button.disabled); }, refundButtonSelector, { timeout: 5000 });
      assert.equal(refundPosts.length, 1, 'first refund request was sent once before the ambiguous response');
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.locator('#reservation-list-date').fill(refundDate);
      refundRow = page.locator('#reservation-list .reservation-row').filter({ hasText: guest.name });
      await refundRow.waitFor({ state: 'visible' });
      await page.waitForFunction(({ guestName }) => {
        const row = [...document.querySelectorAll('#reservation-list .reservation-row')].find((item) => item.innerText.includes(guestName));
        return row && /доступно 60\s*₽/.test(row.innerText) && /возвратов 1/.test(row.innerText);
      }, { guestName: guest.name }, { timeout: 10000 });
      const replayResponsePromise = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === refundPath);
      await refundRow.locator(refundButtonSelector).click();
      await fillRefundModal();
      const replayResponse = await replayResponsePromise;
      assert.equal(replayResponse.status(), 200, 'retry with the same key is recognized as an idempotent replay');
      const replayResponseBody = await replayResponse.json();
      assert.equal(replayResponseBody.idempotentReplay, true);
      assert.equal(refundAttempts, 2);
      assert.equal(refundPosts.length, 2);
      assert.ok(refundPosts[0].idempotencyKey);
      assert.equal(refundPosts[1].idempotencyKey, refundPosts[0].idempotencyKey, 'the UI reuses the same idempotency key after losing a committed response');
      assert.equal(await page.evaluate((key) => localStorage.getItem(key), `crm:pending-reservation-refund:${refundReservation.id}:${refundReceipt.id}`), null, 'successful replay clears the persisted pending-intent key');
      assert.deepEqual([Number(committedRefund.amount), committedRefund.method, committedRefund.reason, Number(committedRefund.cashImpact)], [40, 'card', refundReason, 0]);
      assert.equal(replayedRefund.idempotentReplay, true);
      await page.getByText('Возврат предоплаты записан', { exact: true }).waitFor({ state: 'visible' });
      await page.waitForFunction(({ guestName }) => {
        const row = [...document.querySelectorAll('#reservation-list .reservation-row')].find((item) => item.innerText.includes(guestName));
        return row && /доступно 60\s*₽/.test(row.innerText) && /возвратов 1/.test(row.innerText);
      }, { guestName: guest.name }, { timeout: 10000 });
      assert.equal(await page.locator(`#reservation-list .reservation-row ${refundButtonSelector}`).count(), 1, 'partial refund keeps the remaining receipt balance available');
      const reservationAfterRefund = expect(await call('/api/reservations', 'GET', admin.token), 200, 'owner rereads reservation after UI refund').items.find((item) => item.id === refundReservation.id);
      const receiptAfterRefund = reservationAfterRefund.prepaymentReceipts.find((item) => item.id === refundReceipt.id);
      assert.equal(Number(reservationAfterRefund.verifiedDepositPaid), 60);
      assert.deepEqual([Number(receiptAfterRefund.amount), Number(receiptAfterRefund.available), receiptAfterRefund.reversals.length], [100, 60, 1]);
      assert.deepEqual([Number(receiptAfterRefund.reversals[0].amount), receiptAfterRefund.reversals[0].method, receiptAfterRefund.reversals[0].reason, receiptAfterRefund.reversals[0].shiftId], [40, 'card', refundReason, refundReceipt.shiftId]);
      const refundRows = await postgresClient.query(`SELECT COUNT(r.id)::int AS reversal_count,COALESCE(SUM(r.amount),0) AS reversed,
          COUNT(DISTINCT r.idempotency_key)::int AS keys,MIN(r.payout_method) AS method,MIN(r.shift_id::text) AS "shiftId",
          MIN(rc.amount) AS original_receipt,MIN(rc.payment_method) AS receipt_method,
          (SELECT verified_deposit_paid FROM reservations WHERE id=$1) AS verified_balance
        FROM reservation_pre_payment_receipt_reversals r
        JOIN reservation_pre_payment_receipts rc ON rc.venue_id=r.venue_id AND rc.reservation_id=r.reservation_id AND rc.id=r.receipt_id
        WHERE r.venue_id=(SELECT venue_id FROM reservations WHERE id=$1) AND r.reservation_id=$1 AND r.receipt_id=$2`, [refundReservation.id, refundReceipt.id]);
      assert.deepEqual([refundRows.rows[0].reversal_count, Number(refundRows.rows[0].reversed), refundRows.rows[0].keys, refundRows.rows[0].method, refundRows.rows[0].shiftId, Number(refundRows.rows[0].original_receipt), refundRows.rows[0].receipt_method, Number(refundRows.rows[0].verified_balance)], [1, 40, 1, 'card', refundReceipt.shiftId, 100, 'card', 60], 'independent PostgreSQL join confirms the source receipt stayed at 100, one partial payout was recorded, and the verified balance is 60');
    } finally { await refundContext.close(); }
  }
  console.log(`LOYALTY JOURNEY BROWSER QA: PASS (isolated ${postgresMode ? 'PostgreSQL with real first-run setup' : 'memory'}; synthetic reservation prepayment intake UI${postgresMode ? ', refund UI lost-response idempotent replay' : ''}, manager read/403 write, cashier best-offer POS with bonus/deposit/cash tender, owner ledger/report reread, responsive routes; no external/live payments)`);
} finally {
  const cleanupErrors = [];
  try { await browser?.close(); } catch (error) { cleanupErrors.push(error); }
  try {
    child.kill();
    if (child.exitCode === null && child.signalCode === null) await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 3000))]);
    if (child.exitCode === null && child.signalCode === null) {
      if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      else spawnSync('kill', ['-TERM', String(child.pid)], { stdio: 'ignore' });
      await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 3000))]);
    }
    if (child.exitCode === null && child.signalCode === null) cleanupErrors.push(new Error('isolated CRM server did not exit before PostgreSQL test database cleanup'));
  } catch (error) { cleanupErrors.push(error); }
  try { await postgresClient?.end(); } catch (error) { cleanupErrors.push(error); }
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Loyalty QA cleanup failed');
}
