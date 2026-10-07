import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const playwrightPath = process.env.PLAYWRIGHT_PACKAGE_PATH;
if (!playwrightPath) throw new Error('Set PLAYWRIGHT_PACKAGE_PATH');
const { chromium } = createRequire(import.meta.url)(playwrightPath);
const root = fileURLToPath(new URL('../', import.meta.url));
const shots = path.join(root, 'qa-artifacts', 'dashboard-stage66');
const server = spawn(process.execPath, ['server.js'], { cwd: root, windowsHide: true,
  env: { ...process.env, HOST: '127.0.0.1', PORT: '0', DATABASE_URL: '', AUTH_REQUIRED: 'false', DEMO_MODE: 'false', NODE_ENV: 'test', API_RATE_LIMIT: '10000' }, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '', browser;
server.stdout.on('data', (chunk) => { output += chunk; });
server.stderr.on('data', (chunk) => { output += chunk; });
try {
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Dashboard QA server did not start: ${output}`)), 15000);
    server.once('error', reject);
    server.stdout.on('data', () => { const match = output.match(/CRM running on http:\/\/localhost:(\d+)/); if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); } });
  });
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 375, height: 812 }, locale: 'ru-RU' });
  const errors = [];
  page.on('pageerror', (error) => { if (error.message !== 'Transition was aborted because of invalid state. ViewTransition opt-in disabled') errors.push(error.message); });
  await page.goto(`${base}/login`, { waitUntil: 'networkidle' });
  await page.locator('#login-username').fill('admin');
  await page.locator('#login-password').fill('admin');
  await page.locator('#login-form button[type="submit"]').click();
  await page.waitForURL((url) => !url.pathname.includes('/login'));
  const api = async (route, method = 'GET', data, expected = 200) => {
    const response = await page.evaluate(async ({ route, method, data }) => {
      const token = localStorage.getItem('crm_session_token');
      const result = await fetch(route, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });
      return { status: result.status, body: await result.json() };
    }, { route, method, data });
    assert.equal(response.status, expected, `${method} ${route}: ${JSON.stringify(response.body)}`);
    return response.body;
  };
  const shiftRead = await api('/api/shifts');
  if (!shiftRead.current) await api('/api/shifts', 'POST', { openingCash: 0 }, 201);
  const floor = await api('/api/floor');
  const zone = floor.zones?.[0] || await api('/api/floor/zones', 'POST', { expectedVenueId: floor.venueId, name: 'QA зал главной' }, 201);
  const table = await api('/api/floor/tables', 'POST', { expectedVenueId: floor.venueId, zoneId: zone.id, name: 'QA стол главной', capacity: 2 }, 201);
  const product = await api('/api/products', 'POST', { name: 'QA услуга главной', category: 'Услуги', price: 100, inventoryMode: 'non_stock' }, 201);
  const order = await api('/api/orders', 'POST', { tableId: table.id }, 201);
  await api(`/api/orders/${order.id}/items`, 'POST', { productId: product.id, quantity: 2 }, 201);
  await api(`/api/orders/${order.id}/payments`, 'POST', { amount: 200, method: 'cash' }, 201);
  const savedShift = await api('/api/dashboard/shift-kpis');
  assert.equal(Number(savedShift.totals.revenue), 200, 'saved payment appears in shift summary');
  assert.equal(Number(savedShift.totals.closedOrders), 1, 'closed order appears in shift summary');
  await page.goto(`${base}/admin`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => /200/.test(document.querySelector('#dashboard-shift-kpis')?.textContent || ''));
  assert.match(await page.locator('#dashboard-shift-kpis').innerText(), /200/);
  assert.match(await page.locator('#dashboard-shift-kpis').innerText(), /Закрыто заказов\s*1/);
  assert.equal(await page.locator('#dashboard-shift-select').isDisabled(), true, 'one shift has no redundant selector');
  assert.equal(await page.locator('#dashboard-shift-select').inputValue(), '', 'one-shift day remains a day total without an explicit shift filter');
  for (const [name, width, height] of [['phone-320',320,568],['phone-375',375,812],['fold-cover-673',673,900],['fold-main-902',902,900],['tablet-1024',1024,900],['desktop-1440',1440,900],['wide-1920',1920,1080]]) {
    await page.setViewportSize({ width, height });
    const measured = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, body: document.body.scrollWidth, cards: [...document.querySelectorAll('#dashboard-shift-kpis .dashboard-shift-stat')].map((node) => { const box = node.getBoundingClientRect(); return { left: box.left, right: box.right, width: box.width }; }) }));
    assert.ok(measured.page <= width + 1 && measured.body <= width + 1, `${name} has no horizontal overflow: ${JSON.stringify(measured)}`);
    assert.ok(measured.cards.length >= 3 && measured.cards.every((card) => card.left >= -1 && card.right <= width + 1), `${name} shows all shift cards: ${JSON.stringify(measured)}`);
    if (['phone-320','fold-cover-673','desktop-1440'].includes(name)) { await mkdir(shots, { recursive: true }); await page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: true }); }
    if (name === 'phone-320') { await page.locator('#dashboard-shift-kpis').scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(shots, 'phone-320-shift-cards.png') }); await page.locator('.quick-actions').scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(shots, 'phone-320-quick-actions.png') }); }
  }
  await page.setViewportSize({ width: 375, height: 812 });
  const firstShift = (await api('/api/shifts')).current;
  assert.ok(firstShift?.id, 'paid order belongs to the active shift');
  await api(`/api/shifts/${encodeURIComponent(firstShift.id)}/close`, 'POST', { closingCash: 200, checklistConfirmed: true });
  const secondShift = await api('/api/shifts', 'POST', { openingCash: 0 }, 201);
  const multi = await api(`/api/dashboard/shift-kpis?date=${savedShift.date}`);
  assert.equal(multi.shifts.length, 2, 'both shifts appear on the selected day');
  assert.equal(Number(multi.totals.revenue), 200, 'day total includes the paid first shift');
  assert.equal((await api(`/api/dashboard/shift-kpis?date=${savedShift.date}&shiftId=unknown`, 'GET', undefined, 404)).error, 'shift_not_found_for_date', 'unknown memory shift is rejected');
  await page.goto(`${base}/admin`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.querySelector('#dashboard-shift-select')?.options.length === 3);
  assert.equal(await page.locator('#dashboard-shift-select').isDisabled(), false, 'two shifts enable the selector');
  assert.match(await page.locator('#dashboard-shift-context').innerText(), /всем сменам/);
  await page.locator('#dashboard-insights').evaluate((node) => node.scrollIntoView({ block: 'center' }));
  await page.locator('#dashboard-insights').screenshot({ path: path.join(shots, 'two-shifts-all-375.png') });
  await page.locator('#dashboard-shift-select').selectOption(firstShift.id);
  await page.waitForFunction((id) => document.querySelector('#dashboard-shift-select')?.value === id && /200/.test(document.querySelector('#dashboard-shift-kpis')?.textContent || ''), firstShift.id);
  assert.match(await page.locator('#dashboard-shift-context').innerText(), /—/);
  await page.locator('#dashboard-shift-select').selectOption(secondShift.id);
  await page.waitForFunction((id) => document.querySelector('#dashboard-shift-select')?.value === id && /0\s*₽/.test(document.querySelector('#dashboard-shift-kpis')?.textContent || ''), secondShift.id);
  assert.equal(Number((await api(`/api/dashboard/shift-kpis?date=${savedShift.date}&shiftId=${encodeURIComponent(secondShift.id)}`)).totals.revenue), 0);
  await page.locator('#dashboard-shift-select').selectOption('');
  await page.waitForFunction(() => /Итог по всем сменам/.test(document.querySelector('#dashboard-shift-context')?.textContent || '') && /200/.test(document.querySelector('#dashboard-shift-kpis')?.textContent || ''));
  const date = page.locator('#dashboard-shift-date');
  const staleShift = await api(`/api/dashboard/shift-kpis?date=${savedShift.date}&shiftId=${encodeURIComponent(firstShift.id)}`);
  let releaseOldShift, oldShiftSeen;
  const oldShiftRequest = new Promise((resolve) => { oldShiftSeen = resolve; });
  await page.route('**/api/dashboard/shift-kpis*', (route) => {
    if (route.request().url().includes(`shiftId=${encodeURIComponent(firstShift.id)}`) && !releaseOldShift) { releaseOldShift = route; oldShiftSeen(); return; }
    return route.continue();
  });
  await page.locator('#dashboard-shift-select').selectOption(firstShift.id);
  await oldShiftRequest;
  await date.fill('2000-01-01');
  await date.dispatchEvent('change');
  await page.locator('.dashboard-shift-empty').waitFor();
  assert.match(await page.locator('#dashboard-shift-context').innerText(), /смен не было/);
  await releaseOldShift.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(staleShift) });
  await page.waitForTimeout(100);
  assert.equal(await date.inputValue(), '2000-01-01', 'late shift response does not change selected date');
  assert.equal(await page.locator('.dashboard-shift-empty').isVisible(), true, 'late shift response does not replace empty day');
  await page.unroute('**/api/dashboard/shift-kpis*');
  await page.locator('.dashboard-shift-empty__action').click();
  assert.equal(await date.evaluate((node) => document.activeElement === node), true, 'empty-state action focuses date');
  await page.route('**/api/dashboard/shift-kpis*', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"unavailable"}' }));
  await date.fill(savedShift.date);
  await date.dispatchEvent('change');
  await page.locator('.dashboard-shift-error').waitFor();
  assert.equal(await page.locator('#dashboard-shift-select').isDisabled(), true, 'failed read disables stale shift choice');
  await page.unroute('**/api/dashboard/shift-kpis*');
  await page.locator('.dashboard-shift-retry').click();
  await page.waitForFunction(() => /200/.test(document.querySelector('#dashboard-shift-kpis')?.textContent || ''));
  assert.match(await page.locator('#dashboard-shift-kpis').innerText(), /200/, 'retry restores saved shift figures');
  const quickLinks = ['/reservations','/inventory','/finance','/finance/report'];
  assert.deepEqual(await page.locator('.quick-actions a').evaluateAll((nodes) => nodes.map((node) => new URL(node.href).pathname)), quickLinks);
  for (const route of quickLinks) { await page.locator(`.quick-actions a[href="${route}"]`).click(); await page.waitForURL((url) => url.pathname === route); await page.goto(`${base}/admin`, { waitUntil: 'networkidle' }); }
  await page.goto(`${base}/admin#settings-dashboard-modules`, { waitUntil: 'networkidle' });
  const shiftToggle = page.locator('[data-dashboard-module-toggle="shift"]');
  await shiftToggle.waitFor();
  const disabledSaved = page.waitForResponse((response) => response.url().includes('/api/session/preferences') && response.request().method() === 'PATCH');
  await shiftToggle.uncheck();
  assert.equal((await disabledSaved).status(), 200, 'disabling shift module persists');
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(await shiftToggle.isChecked(), false, 'shift module preference is disabled');
  await page.goto(`${base}/admin#shift-control`, { waitUntil: 'networkidle' });
  assert.equal(await page.locator('#shift-control').isVisible(), true, 'direct shift link shows a disabled dashboard module');
  assert.match(await page.locator('main').innerText(), /Контроль смены/);
  await page.goto(`${base}/admin#settings-dashboard-modules`, { waitUntil: 'networkidle' });
  const enabledSaved = page.waitForResponse((response) => response.url().includes('/api/session/preferences') && response.request().method() === 'PATCH');
  await page.locator('[data-dashboard-module-toggle="shift"]').check();
  assert.equal((await enabledSaved).status(), 200, 'restoring shift module persists');
  await page.goto(`${base}/admin`, { waitUntil: 'networkidle' });
  await page.route('**/api/finance/summary*', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"unavailable"}' }));
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.querySelector('#dash-pending-detail')?.textContent?.includes('недоступны'));
  assert.equal(await page.locator('#dash-revenue').innerText(), '—', 'failed finance read does not display false zero revenue');
  assert.equal(await page.locator('#dash-pending-revenue').innerText(), '—', 'failed finance read does not display pending value');
  assert.equal(await page.locator('[data-dashboard-revenue]').getAttribute('aria-label'), 'Повторить загрузку финансов');
  await page.locator('[data-dashboard-revenue]').evaluate((node) => node.scrollIntoView({ block: 'center' }));
  await page.locator('[data-dashboard-revenue]').screenshot({ path: path.join(shots, 'finance-error-375.png') });
  await page.unroute('**/api/finance/summary*');
  await page.locator('[data-dashboard-revenue]').click();
  await page.waitForFunction(() => document.querySelector('#dash-revenue')?.textContent?.includes('200'));
  assert.equal(await page.locator('[data-dashboard-revenue]').getAttribute('aria-label'), 'Открыть финансы');
  await page.route('**/api/finance/summary*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"date":"2026-09-30","revenue":12,"employeeView":true}' }));
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.querySelector('#dash-revenue')?.textContent?.includes('12'));
  assert.equal(await page.locator('#dash-pending-revenue').innerText(), '—', 'restricted finance response does not invent pending zero');
  assert.equal(await page.locator('#dash-pending-detail').innerText(), 'Доступно руководителю');
  await page.unroute('**/api/finance/summary*');
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.querySelector('#dash-revenue')?.textContent?.includes('200'));
  await page.evaluate(() => {
    document.querySelector('#dash-revenue').textContent = '1 286 459,73 ₽';
    document.querySelector('#dash-pending-revenue').textContent = '99 999,99 ₽';
    document.querySelector('[data-metric="openOrders"]').textContent = '1 000 000';
    document.querySelector('[data-metric="reservationsToday"]').textContent = '99 999';
    document.querySelector('[data-metric="lowStock"]').textContent = '−1 286 459,73';
  });
  for (const [name, width] of [['stress-280', 280], ['phone-320', 320], ['phone-375', 375], ['phone-420', 420], ['fold-cover-673', 673], ['fold-main-902', 902], ['tablet-1024', 1024], ['desktop-1440', 1440], ['desktop-1920', 1920], ['qhd-2560', 2560], ['ultrawide-3440', 3440]]) {
    await page.setViewportSize({ width, height: 900 });
    const bounds = await page.locator('.dashboard-kpi-grid').evaluate((grid) => ({ grid: grid.getBoundingClientRect().toJSON(), values: [...grid.querySelectorAll('strong')].map((node) => { const range = document.createRange(); range.selectNodeContents(node); return { text: node.textContent, rect: range.getBoundingClientRect().toJSON(), card: node.closest('.kpi').getBoundingClientRect().toJSON() }; }) }));
    assert.ok(bounds.values.every(({ rect, card }) => rect.right <= card.right - 8 && rect.left >= card.left + 8), `${name} extreme KPI values remain fully visible inside cards: ${JSON.stringify(bounds)}`);
    const revenueLayout = await page.locator('.dashboard-revenue-card').evaluate((card) => { const amount = card.querySelector('#dash-revenue'); const revenue = document.createRange(); revenue.selectNodeContents(amount); const pending = card.querySelector('.dashboard-revenue-pending').getBoundingClientRect(); const value = revenue.getBoundingClientRect(); return { revenue: value.toJSON(), lines: revenue.getClientRects().length, pending: pending.toJSON(), card: card.getBoundingClientRect().toJSON() }; });
    assert.ok(revenueLayout.revenue.bottom <= revenueLayout.pending.top || revenueLayout.revenue.right <= revenueLayout.pending.left - 4, `${name} revenue and pending values do not overlap: ${JSON.stringify(revenueLayout)}`);
    assert.equal(revenueLayout.lines, 1, `${name} revenue amount and currency stay on one line: ${JSON.stringify(revenueLayout)}`);
    if (['phone-420', 'fold-main-902', 'desktop-1440', 'qhd-2560'].includes(name)) { await page.locator('.dashboard-kpi-grid').evaluate((node) => node.scrollIntoView({ block: 'center' })); await page.locator('.dashboard-kpi-grid').screenshot({ path: path.join(shots, `${name}-extreme-kpis.png`) }); }
  }
  let releaseStale, firstFinanceSeen;
  const staleSeen = new Promise((resolve) => { firstFinanceSeen = resolve; });
  let financeLoads = 0;
  await page.route('**/api/finance/summary*', (route) => {
    financeLoads += 1;
    if (financeLoads === 1) { releaseStale = route; firstFinanceSeen(); return; }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"revenue":123,"pendingRevenue":0,"pendingOrders":0}' });
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await staleSeen;
  await page.evaluate(() => renderDashboard());
  await page.waitForFunction(() => document.querySelector('#dash-revenue')?.textContent?.includes('123'));
  await releaseStale.fulfill({ status: 200, contentType: 'application/json', body: '{"revenue":9999,"pendingRevenue":9999,"pendingOrders":9}' });
  await page.waitForTimeout(100);
  assert.match(await page.locator('#dash-revenue').innerText(), /123/, 'stale response from replaced dashboard does not overwrite current value');
  await page.unroute('**/api/finance/summary*');
  await page.locator('[data-kpi-route="/"]').focus();
  await page.keyboard.press('Enter');
  await page.waitForURL((url) => url.pathname === '/');
  assert.deepEqual(errors, [], `Dashboard browser errors: ${errors.join('; ')}`);
  console.log('DASHBOARD FILLED BROWSER QA: PASS (multiple shift/day totals, shift date race and error/retry, finance error/retry/restricted/stale, 7 standard and 11 extreme widths, quick links, hidden-module deep link, keyboard KPI)');
} finally {
  await browser?.close();
  if (server.exitCode === null && server.signalCode === null) server.kill();
}
