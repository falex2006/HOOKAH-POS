import assert from 'node:assert/strict';
import net from 'node:net';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const playwrightPath = process.env.PLAYWRIGHT_PACKAGE_PATH;
if (!playwrightPath) throw new Error('Set PLAYWRIGHT_PACKAGE_PATH');
const { chromium } = createRequire(import.meta.url)(playwrightPath);
const reservePort = async () => { const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const { port } = server.address(); await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); return port; };
const port = await reservePort(); const baseUrl = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['server.js'], { cwd: fileURLToPath(new URL('../', import.meta.url)), windowsHide: true, env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DATABASE_URL: '', AUTH_REQUIRED: 'true', DEMO_OWNER_PASSWORD: 'demo', API_RATE_LIMIT: '5000' }, stdio: ['ignore', 'pipe', 'pipe'] });
let output = ''; child.stdout.on('data', (chunk) => { output += chunk.toString(); }); child.stderr.on('data', (chunk) => { output += chunk.toString(); });
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' });
try {
  if (!output.includes('CRM running on')) await new Promise((resolve, reject) => { const timeout = setTimeout(() => reject(new Error(`CRM startup timed out: ${output}`)), 10_000); const ready = (chunk) => { if (String(chunk).includes('CRM running on')) { clearTimeout(timeout); child.stdout.off('data', ready); resolve(); } }; child.stdout.on('data', ready); child.once('error', reject); child.once('exit', (code) => reject(new Error(`CRM exited (${code}): ${output}`))); });
  const loginResponse = await fetch(`${baseUrl}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: 'demo' }) });
  assert.equal(loginResponse.status, 200); const session = await loginResponse.json();
  const shiftResponse = await fetch(`${baseUrl}/api/shifts`, { method: 'POST', headers: { Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ openingCash: 0 }) });
  assert.equal(shiftResponse.status, 201, 'open an isolated QA shift before creating orders');
  const shift = await shiftResponse.json();
  const readShift = await fetch(`${baseUrl}/api/notifications/${encodeURIComponent(`shift_opened:${shift.id}`)}/read`, { method: 'PUT', headers: { Authorization: `Bearer ${session.token}` } });
  assert.equal(readShift.status, 200, 'keep the setup shift outside the unread order count');
  const headers = { Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json' };
  const floorResponse = await fetch(`${baseUrl}/api/floor`, { headers });
  assert.equal(floorResponse.status, 200); const floor = await floorResponse.json();
  let zone = floor.zones?.[0];
  if (!zone) { const zoneResponse = await fetch(`${baseUrl}/api/floor/zones`, { method: 'POST', headers, body: JSON.stringify({ expectedVenueId: floor.venueId, name: 'Notification QA hall' }) }); assert.equal(zoneResponse.status, 201); zone = await zoneResponse.json(); }
  for (const suffix of ['one', 'two']) {
    const tableResponse = await fetch(`${baseUrl}/api/floor/tables`, { method: 'POST', headers, body: JSON.stringify({ expectedVenueId: floor.venueId, zoneId: zone.id, name: `Notification QA ${suffix}`, capacity: 2 }) });
    assert.equal(tableResponse.status, 201); const table = await tableResponse.json();
    const created = await fetch(`${baseUrl}/api/orders`, { method: 'POST', headers, body: JSON.stringify({ tableId: table.id }) });
    if (created.status !== 201) throw new Error(`Notification QA order creation ${created.status}: ${await created.text()}`); const order = await created.json();
  const deleted = await fetch(`${baseUrl}/api/orders/${encodeURIComponent(order.id)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ comment: 'Notification browser QA', writeoff: false }) }); assert.equal(deleted.status, 200);
  }
  const emptyAdminCreate = await fetch(`${baseUrl}/api/staff`, { method: 'POST', headers: { Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Notification Empty Inbox QA', role: 'admin', login: `notification_empty_${Date.now()}`, password: 'demo', birthDate: '1990-01-01', permissionScopes: ['inventory'] }) });
  assert.equal(emptyAdminCreate.status, 201);
  const emptyAdminLogin = await fetch(`${baseUrl}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: (await emptyAdminCreate.json()).login, password: 'demo' }) });
  assert.equal(emptyAdminLogin.status, 200); const emptyAdmin = await emptyAdminLogin.json();
  const restrictedCreate = await fetch(`${baseUrl}/api/staff`, { method: 'POST', headers: { Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Notification Restricted QA', role: 'bartender', login: `qa_bart_${Date.now()}`, password: 'demo', birthDate: '1990-01-01' }) });
  if (restrictedCreate.status !== 201) throw new Error(`Restricted staff fixture ${restrictedCreate.status}: ${await restrictedCreate.text()}`);
  const restrictedLogin = await fetch(`${baseUrl}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: (await restrictedCreate.json()).login, password: 'demo' }) });
  assert.equal(restrictedLogin.status, 200); const restrictedAdmin = await restrictedLogin.json();
  const scopedAdmins = {};
  for (const scope of ['orders', 'finance']) {
    const created = await fetch(`${baseUrl}/api/staff`, { method: 'POST', headers, body: JSON.stringify({ name: `Notification ${scope} QA`, role: 'admin', login: `qa_${scope}_${Date.now()}`, password: 'demo', birthDate: '1990-01-01', permissionScopes: [scope] }) });
    assert.equal(created.status, 201, `${scope} notification fixture`);
    const login = await fetch(`${baseUrl}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: (await created.json()).login, password: 'demo' }) });
    assert.equal(login.status, 200); scopedAdmins[scope] = await login.json();
  }
  const roleSessions = [];
  for (const [index, role] of ['admin', 'manager', 'developer', 'senior_bartender', 'hookah_master', 'senior_hookah_master'].entries()) {
    const created = await fetch(`${baseUrl}/api/staff`, { method: 'POST', headers, body: JSON.stringify({ name: `Notification ${role} QA`, role, login: `qa_nt_${index}_${Date.now().toString(36)}`, password: 'demo', birthDate: '1990-01-01' }) });
    assert.equal(created.status, 201, `${role} notification fixture`);
    const login = await fetch(`${baseUrl}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: (await created.json()).login, password: 'demo' }) });
    assert.equal(login.status, 200, `${role} notification login`);
    roleSessions.push([role, await login.json()]);
  }
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  await context.addInitScript(({ token, user }) => { localStorage.setItem('crm_session_token', token); localStorage.setItem('crm_session_user', JSON.stringify(user)); }, { token: session.token, user: session.user });
  const page = await context.newPage(); await page.goto(`${baseUrl}/admin`, { waitUntil: 'domcontentloaded' });
  const bell = page.locator('#notification-bell'); await bell.waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('#notification-count')?.textContent === '2');
  assert.equal(await bell.getAttribute('aria-label'), 'Уведомления, непрочитанных: 2', 'bell exposes unread count as its accessible name');
  for (const route of ['/admin', '/orders', '/clients', '/reservations', '/delivery', '/inventory', '/finance', '/finance/report', '/finance/categories', '/integrations', '/network']) {
    await page.goto(`${baseUrl}${route}`, { waitUntil: 'domcontentloaded' });
    const routeBell = page.locator('#notification-bell'); await routeBell.waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.querySelector('#notification-count')?.textContent === '2');
    await routeBell.click(); await page.locator('#notification-panel').waitFor({ state: 'visible' });
    await page.locator('.notification-item').first().waitFor();
    assert.equal(await page.locator('.notification-item').count(), 3, `persistent inbox is reachable from ${route}`);
    await page.keyboard.press('Escape');
  }
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.goto(`${baseUrl}/admin#notifications`, { waitUntil: 'domcontentloaded' });
    await page.locator('.notification-page-content .notification-item').first().waitFor();
    assert.equal(await page.locator('.notification-page-content .notification-item').count(), 3);
    await page.locator('.notification-page [data-notification-filter="unread"]').click();
    await page.waitForFunction(() => document.querySelectorAll('.notification-page-content .notification-item').length === 2);
    await page.locator('.notification-page [data-notification-filter="all"]').click();
    await page.waitForFunction(() => document.querySelectorAll('.notification-page-content .notification-item').length === 3);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `inline notification center fits ${width}px`);
    await page.locator('#notification-bell').click();
    await page.waitForFunction(() => document.querySelectorAll('#notification-panel-content .notification-item').length === 3);
    await page.keyboard.press('Escape');
  }
  let failInlineRefresh = true;
  await page.route('**/api/notifications**', async (route) => {
    if (failInlineRefresh && route.request().method() === 'GET') {
      failInlineRefresh = false;
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'notifications_unavailable' }) });
    } else await route.continue();
  });
  await page.locator('.notification-page [data-notification-filter="unread"]').click();
  await page.locator('.notification-page .notification-inline-error').waitFor();
  await page.locator('.notification-page .notification-inline-error button').click();
  await page.waitForFunction(() => document.querySelectorAll('.notification-page-content .notification-item').length === 2);
  await page.unroute('**/api/notifications**');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${baseUrl}/admin`, { waitUntil: 'domcontentloaded' });
  await page.locator('#notification-bell').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('#notification-count')?.textContent === '2');
  let shouldFailNotificationSource = true;
  await page.route('**/api/notifications**', async (route) => {
    if (shouldFailNotificationSource && route.request().method() === 'GET') {
      shouldFailNotificationSource = false;
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'notifications_unavailable' }) });
    } else await route.continue();
  });
  await bell.click();
  await page.locator('.notification-inline-error').waitFor();
  assert.match(await page.locator('.notification-inline-error').innerText(), /Не удалось обновить/);
  await page.locator('.notification-inline-error button').click();
  await page.locator('.notification-item').first().waitFor();
  await page.unroute('**/api/notifications**');
  await page.keyboard.press('Escape');
  for (const width of [1440, 768, 375]) {
    await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
    await bell.click();
    const panel = page.locator('#notification-panel'); await panel.waitFor({ state: 'visible' });
    await page.locator('.notification-item').first().waitFor();
    assert.equal(await bell.getAttribute('aria-expanded'), 'true');
    assert.equal(await page.locator('#notification-panel-title').textContent(), 'Уведомления');
    assert.equal(await page.locator('.notification-item').count(), 3);
    const bounds = await page.locator('.notification-panel-card').boundingBox();
    assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width + 1, `tray fits viewport width ${width}`);
    assert.equal(await panel.getAttribute('aria-modal'), width <= 768 ? 'true' : 'false');
    if (width <= 768) {
      const tray = await panel.boundingBox();
      assert.ok(tray && tray.x === 0 && tray.y === 0 && tray.width === width, `tray fills viewport at ${width}px`);
      assert.equal(await page.evaluate(() => getComputedStyle(document.body).overflow), 'hidden', `background scroll is locked at ${width}px`);
      const visibleControls = page.locator('#notification-panel button:not(:disabled):not([hidden]), #notification-panel a[href]');
      const firstControl = visibleControls.first(); const lastControl = visibleControls.last();
      await lastControl.focus(); await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement), await firstControl.evaluate((node) => node), `focus wraps inside modal tray at ${width}px`);
    }
    assert.equal(await page.locator('.notification-panel-card').evaluate((node) => getComputedStyle(node).animationName), 'none', 'reduced motion disables tray animations');
    if (width === 1440) await page.screenshot({ path: `${process.env.TEMP || process.env.TMP || '.'}/notifications-center-desktop.png` });
    if (width === 375) await page.screenshot({ path: `${process.env.TEMP || process.env.TMP || '.'}/notifications-center-mobile.png` });
    await page.keyboard.press('Escape');
    assert.equal(await panel.isHidden(), true); assert.equal(await page.evaluate(() => document.activeElement?.id), 'notification-bell');
  }
  await page.setViewportSize({ width: 375, height: 812 });
  await bell.click(); await page.locator('.notification-item').first().waitFor();
  const secondPage = await context.newPage(); await secondPage.goto(`${baseUrl}/admin`, { waitUntil: 'domcontentloaded' });
  await secondPage.waitForFunction(() => document.querySelector('#notification-count')?.textContent === '2');
  const firstNotificationLink = page.locator('.notification-open-link').first();
  assert.match(await firstNotificationLink.getAttribute('href'), /\/orders(?:\?|$)/, 'deleted-order notification links to the order journal');
  await Promise.all([page.waitForURL(/\/orders(?:\?|$)/), firstNotificationLink.click()]);
  const targetApi = await page.evaluate(async (token) => (await fetch('/api/orders', { headers: { Authorization: `Bearer ${token}` } })).status, session.token);
  assert.equal(targetApi, 200, 'notification navigation reaches the orders route and its permission-checked API');
  await page.waitForFunction(() => document.querySelector('#notification-count')?.textContent === '1');
  await secondPage.waitForFunction(() => document.querySelector('#notification-count')?.textContent === '1');
  await page.goto(`${baseUrl}/admin`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('#notification-count')?.textContent === '1');
  await page.locator('#notification-bell').click();
  await page.locator('.notification-item.is-unread').waitFor();
  await page.locator('.notification-read-all').click();
  await page.waitForFunction(() => document.querySelector('#notification-count')?.hidden === true);
  await secondPage.waitForFunction(() => document.querySelector('#notification-count')?.hidden === true);
  await page.locator('[data-notification-filter="unread"]').click();
  assert.match(await page.locator('#notification-panel-content').innerText(), /Непрочитанных уведомлений нет/);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('#notification-count')?.hidden === true);
  await page.locator('#notification-bell').click();
  await page.locator('#notification-panel').waitFor({ state: 'visible' });
  await page.locator('.notification-item').first().waitFor();
  assert.equal(await page.locator('.notification-item.is-unread').count(), 0, 'read-all state persists after reload');
  assert.equal(await page.locator('#notification-count').isHidden(), true, 'read state persists after reload');
  const emptyContext = await browser.newContext({ viewport: { width: 375, height: 812 }, reducedMotion: 'reduce' });
  await emptyContext.addInitScript(({ token, user }) => { localStorage.setItem('crm_session_token', token); localStorage.setItem('crm_session_user', JSON.stringify(user)); }, { token: emptyAdmin.token, user: emptyAdmin.user });
  const emptyPage = await emptyContext.newPage(); await emptyPage.goto(`${baseUrl}/admin`, { waitUntil: 'domcontentloaded' });
  const emptyBell = emptyPage.locator('#notification-bell'); await emptyBell.waitFor({ state: 'visible' });
  await emptyPage.waitForFunction(() => document.querySelector('#notification-count')?.hidden === true);
  assert.equal(await emptyBell.getAttribute('aria-label'), 'Уведомления', 'empty inbox keeps a useful accessible bell name');
  await emptyBell.focus(); await emptyPage.keyboard.press('Enter');
  await emptyPage.locator('.notification-state-empty').waitFor();
  assert.match(await emptyPage.locator('.notification-state-empty').innerText(), /Пока нет уведомлений/);
  await emptyPage.keyboard.press('Escape');
  assert.equal(await emptyPage.evaluate(() => document.activeElement?.id), 'notification-bell', 'keyboard-open empty tray restores focus');
  await emptyPage.goto(`${baseUrl}/admin#notifications`, { waitUntil: 'domcontentloaded' });
  await emptyPage.locator('.notification-page .notification-state-empty').waitFor();
  assert.match(await emptyPage.locator('.notification-page-content').innerText(), /Пока нет уведомлений/);
  const restrictedContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await restrictedContext.addInitScript(({ token, user }) => { localStorage.setItem('crm_session_token', token); localStorage.setItem('crm_session_user', JSON.stringify(user)); }, { token: restrictedAdmin.token, user: restrictedAdmin.user });
  const restrictedPage = await restrictedContext.newPage(); await restrictedPage.goto(`${baseUrl}/admin#notifications`, { waitUntil: 'domcontentloaded' });
  await restrictedPage.locator('.notification-page-content').waitFor();
  assert.equal(await restrictedPage.locator('#notification-bell').isHidden(), true);
  assert.match(await restrictedPage.locator('.notification-page-content').innerText(), /недоступны для текущего профиля/);
  assert.equal((await fetch(`${baseUrl}/api/notifications`, { headers: { Authorization: `Bearer ${restrictedAdmin.token}` } })).status, 403);
  await restrictedContext.close();
  for (const [scope, expectedType, expectedCount] of [['orders', 'order_deleted', 2], ['finance', 'shift_opened', 1]]) {
    const scoped = scopedAdmins[scope];
    const feedResponse = await fetch(`${baseUrl}/api/notifications`, { headers: { Authorization: `Bearer ${scoped.token}` } });
    assert.equal(feedResponse.status, 200, `${scope} can read its notification feed`);
    const feed = await feedResponse.json();
    assert.equal(feed.items.length, expectedCount, `${scope} sees only its permitted events`);
    assert.ok(feed.items.every((item) => item.type === expectedType), `${scope} feed contains no other module's events`);
    const scopedContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await scopedContext.addInitScript(({ token, user }) => { localStorage.setItem('crm_session_token', token); localStorage.setItem('crm_session_user', JSON.stringify(user)); }, { token: scoped.token, user: scoped.user });
    const scopedPage = await scopedContext.newPage(); await scopedPage.goto(`${baseUrl}/${scope === 'orders' ? 'orders' : 'finance'}`, { waitUntil: 'domcontentloaded' });
    await scopedPage.locator('#notification-bell').waitFor({ state: 'visible' });
    await scopedPage.locator('#notification-bell').click();
    await scopedPage.waitForFunction((count) => document.querySelectorAll('#notification-panel-content .notification-item').length === count, expectedCount);
    assert.equal(await scopedPage.locator('#notification-panel-content .notification-item').count(), expectedCount);
    await scopedContext.close();
  }
  let roleIndex = 0;
  for (const [role, actor] of roleSessions) {
    const expectedTypes = ['admin', 'manager'].includes(role) ? ['order_deleted', 'order_deleted', 'shift_opened'] : role === 'developer' ? ['shift_opened'] : [];
    const feedResponse = await fetch(`${baseUrl}/api/notifications`, { headers: { Authorization: `Bearer ${actor.token}` } });
    assert.equal(feedResponse.status, expectedTypes.length ? 200 : 403, `${role} feed permission`);
    if (expectedTypes.length) {
      const feed = await feedResponse.json();
      assert.deepEqual(feed.items.map(item => item.type).sort(), expectedTypes.sort(), `${role} sees only allowed notification types`);
    }
    const roleContext = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce', extraHTTPHeaders: { 'X-Forwarded-For': `127.0.2.${++roleIndex}` } });
    await roleContext.addInitScript(({ token, user }) => { localStorage.setItem('crm_session_token', token); localStorage.setItem('crm_session_user', JSON.stringify(user)); }, { token: actor.token, user: actor.user });
    const rolePage = await roleContext.newPage(); const roleErrors = []; rolePage.on('pageerror', error => roleErrors.push(error.message));
    await rolePage.goto(`${baseUrl}/admin#notifications`, { waitUntil: 'domcontentloaded' });
    try { await rolePage.locator('.notification-page-content').waitFor({ timeout: 5000 }); }
    catch (error) { throw new Error(`${role} inline notifications missing at ${rolePage.url()}: ${(await rolePage.locator('body').innerText()).slice(0, 350)}`, { cause: error }); }
    if (expectedTypes.length) {
      await rolePage.waitForFunction(count => document.querySelectorAll('.notification-page-content .notification-item').length === count, expectedTypes.length);
      assert.equal(await rolePage.locator('#notification-bell').isVisible(), true, `${role} bell visible`);
      assert.equal(await rolePage.locator('.notification-page-content .notification-item').count(), expectedTypes.length, `${role} inline list count`);
    } else {
      assert.equal(await rolePage.locator('#notification-bell').isHidden(), true, `${role} bell hidden`);
      assert.match(await rolePage.locator('.notification-page-content').innerText(), /недоступны для текущего профиля/, `${role} sees permission explanation`);
    }
    assert.equal(await rolePage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${role} notification page fits 390px`);
    assert.deepEqual(roleErrors, [], `${role} notification browser errors`);
    await roleContext.close();
  }
  const demoContext = await browser.newContext({ viewport: { width: 390, height: 844 }, extraHTTPHeaders: { 'X-Forwarded-For': '127.0.3.1' } });
  await demoContext.addInitScript(() => {
    if (localStorage.getItem('crm_session_token') === 'demo-static-notification-qa') return;
    localStorage.setItem('crm_session_token', 'demo-static-notification-qa');
    localStorage.setItem('crm_session_user', JSON.stringify({ id: 'demo-owner', name: 'QA Owner', role: 'owner' }));
    localStorage.setItem('territory_crm_demo_reset_v1', '1');
    localStorage.setItem('territory_crm_demo_state', JSON.stringify({
      shift: { id: 'demo-shift-new', venueId: 'demo-venue-territory', openedAt: '2026-10-22T10:00:00Z', closedAt: null },
      networkVenues: [{ id: 'demo-venue-other', name: 'Other QA venue', status: 'active' }],
      audit: [
        { action: 'shift.opened', entityId: 'demo-shift-old', venueId: 'demo-venue-territory', createdAt: '2026-10-20T10:00:00Z' },
        { action: 'shift.closed', entityId: 'demo-shift-old', venueId: 'demo-venue-territory', createdAt: '2026-10-20T20:00:00Z' },
        { action: 'shift.opened', entityId: 'demo-shift-new', venueId: 'demo-venue-territory', createdAt: '2026-10-22T10:00:00Z' },
        { action: 'shift.opened', entityId: 'demo-shift-other', venueId: 'demo-venue-other', createdAt: '2026-10-21T10:00:00Z' },
      ],
    }));
  });
  const demoPage = await demoContext.newPage(); await demoPage.goto(`${baseUrl}/admin#notifications`, { waitUntil: 'domcontentloaded' });
  try { await demoPage.waitForFunction(() => document.querySelectorAll('.notification-page-content .notification-item').length === 3, undefined, { timeout: 10000 }); }
  catch (error) { throw new Error(`demo notification count: ${await demoPage.locator('.notification-page-content .notification-item').count()}, URL ${demoPage.url()}, body ${(await demoPage.locator('body').innerText()).slice(0, 400)}`, { cause: error }); }
  assert.match(await demoPage.locator('.notification-page-content').innerText(), /Смена закрыта/, 'older closed shift remains visible after a new shift opens');
  await demoPage.evaluate(() => { const state = JSON.parse(localStorage.getItem('territory_crm_demo_state')); state.networkCurrentId = 'demo-venue-other'; localStorage.setItem('territory_crm_demo_state', JSON.stringify(state)); });
  await demoPage.reload({ waitUntil: 'domcontentloaded' });
  await demoPage.waitForFunction(() => document.querySelectorAll('.notification-page-content .notification-item').length === 1);
  assert.equal(await demoPage.locator('.notification-page-content .notification-item').count(), 1, 'other venue does not receive default venue shifts');
  await demoPage.evaluate(() => { const state = JSON.parse(localStorage.getItem('territory_crm_demo_state')); state.networkCurrentId = 'demo-venue-territory'; delete state.shift.venueId; state.audit.push({ action: 'shift.closed', entityId: 'demo-shift-new', createdAt: '2026-10-22T20:00:00Z' }); localStorage.setItem('territory_crm_demo_state', JSON.stringify(state)); });
  await demoPage.reload({ waitUntil: 'domcontentloaded' });
  await demoPage.waitForFunction(() => document.querySelectorAll('.notification-page-content .notification-item').length === 3);
  assert.equal(await demoPage.locator('.notification-page-content .notification-item').count(), 3, 'ambiguous legacy shift is not assigned to the default venue when another venue exists');
  await demoPage.evaluate(() => localStorage.setItem('crm_session_user', JSON.stringify({ id: 'demo-bartender', name: 'QA Bartender', role: 'bartender' })));
  await demoPage.reload({ waitUntil: 'domcontentloaded' });
  await demoPage.locator('.notification-page-content').waitFor();
  assert.match(await demoPage.locator('.notification-page-content').innerText(), /недоступны для текущего профиля/, 'operational demo role renders its restricted notification page without a dashboard crash');
  await demoContext.close();
  await emptyContext.close();
  await context.close();
  console.log('NOTIFICATIONS BROWSER QA: 503/retry, desktop/tablet/mobile geometry, eight login roles and scoped admins, reduced motion, accessible name, focus trap/Escape, single/read-all, reload, unread filter, and cross-tab sync passed');
} finally { await browser.close(); child.kill('SIGTERM'); }
