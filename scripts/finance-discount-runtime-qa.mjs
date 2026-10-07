import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const playwrightPath = process.env.PLAYWRIGHT_PACKAGE_PATH;
if (!playwrightPath) throw new Error('Set PLAYWRIGHT_PACKAGE_PATH');
const { chromium } = createRequire(import.meta.url)(playwrightPath);
const child = spawn(process.execPath, ['server.js'], {
  cwd: fileURLToPath(new URL('../', import.meta.url)), windowsHide: true,
  env: { ...process.env, HOST: '127.0.0.1', PORT: '0', DATABASE_URL: '', AUTH_REQUIRED: 'false', DEMO_MODE: 'true', NODE_ENV: 'test' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stdout.on('data', (chunk) => { output += chunk; });
child.stderr.on('data', (chunk) => { output += chunk; });
const base = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`QA server did not start: ${output}`)), 15000);
  child.once('error', reject);
  child.stdout.on('data', () => { const match = output.match(/CRM running on http:\/\/localhost:(\d+)/); if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); } });
});
let browser;
try {
  const api = async (path, method = 'GET', data, expected = 200) => {
    const response = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });
    const payload = await response.json();
    assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(payload)}`);
    return payload;
  };
  await api('/api/shifts', 'POST', { openingCash: 0 }, 201);
  const product = await api('/api/products', 'POST', { name: 'Discount UI QA service', category: 'Услуги', price: 100, inventoryMode: 'non_stock' }, 201);
  const expenseCategory = await api('/api/finance/categories', 'POST', { name: 'QA operating costs', kind: 'expense' }, 201);
  const closedOrder = await api('/api/orders', 'POST', { tableId: 'finance-chart-qa' }, 201);
  await api(`/api/orders/${closedOrder.id}/items`, 'POST', { productId: product.id, quantity: 1 }, 201);
  await api(`/api/orders/${closedOrder.id}/close`, 'POST', { paymentMethod: 'cash' }, 200);
  const financeSummary = await api('/api/finance/summary');
  assert.equal(financeSummary.revenue, 100, 'closed QA payment appears in the finance summary before UI assertions');
  await api('/api/analytics?days=all');
  const order = await api('/api/orders', 'POST', { tableId: 'discount-ui-qa' }, 201);
  await api(`/api/orders/${order.id}/items`, 'POST', { productId: product.id, quantity: 1 }, 201);
  const first = await api(`/api/orders/${order.id}/discount-requests`, 'POST', { type: 'percent', value: 10, reason: 'UI QA approve' }, 201);
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 320, height: 640 }, locale: 'ru-RU' });
  const exceptions = [];
  page.on('pageerror', (error) => exceptions.push(error.message));
  await page.goto(`${base}/login`, { waitUntil: 'networkidle' });
  await page.locator('#login-username').fill('admin');
  await page.locator('#login-password').fill('admin');
  await page.locator('#login-form button[type="submit"]').click();
  await page.waitForURL((url) => !url.pathname.includes('/login'));
  let unavailableShiftRequests = 0;
  await page.route('**/api/shifts', (route) => { unavailableShiftRequests++; return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'shift_status_unavailable' }) }); });
  await page.goto(`${base}/finance#discounts`, { waitUntil: 'networkidle' });
  const section = page.locator('#discounts');
  await section.locator('.discount-row').first().waitFor();
  await page.waitForFunction(() => { const top = document.querySelector('#discounts')?.getBoundingClientRect().top; return Number.isFinite(top) && top >= 0 && top < innerHeight; });
  assert.match(await page.locator('#finance-revenue').textContent(), /100/, 'finance summary remains visible when shift status is unavailable');
  assert.equal((await page.locator('#cash-register-status').textContent()).trim(), 'Состояние смены недоступно');
  assert.ok(unavailableShiftRequests > 0, 'finance UI exercised the unavailable-shift response');
  assert.equal(await page.locator('.cash-register-panel').evaluate((node) => node.classList.contains('is-open') || node.classList.contains('is-closed')), false, 'unavailable shift state is not shown as open or closed');
  assert.equal((await page.locator('#cash-register-opening').textContent()).trim(), 'Недоступно');
  for (const [view, selector] of [['bars', '.finance-bars-view'], ['table', '.finance-data-table'], ['line', '.finance-line-chart']]) {
    await page.locator(`[data-finance-chart-view="${view}"]`).click();
    assert.equal(await page.locator(`[data-finance-chart-view="${view}"]`).getAttribute('aria-pressed'), 'true');
    await page.locator(`#finance-chart ${selector}`).waitFor();
  }
  for (const metric of ['orders', 'average_median', 'profit', 'expenses', 'revenue']) {
    await page.locator('#finance-chart-metric').selectOption(metric);
    assert.equal(await page.locator('#finance-chart-metric').inputValue(), metric);
    assert.ok((await page.locator('#finance-chart').textContent()).trim().length > 0);
  }
  for (const period of ['7', '30', '365', 'all']) await page.locator('#finance-chart-period').selectOption(period);
  for (const [view, selector] of [['bars', '.payment-bars'], ['line', '.payment-line'], ['table', '.payment-table'], ['donut', '.payment-donut']]) {
    await page.locator(`[data-payment-view="${view}"]`).click();
    assert.equal(await page.locator(`[data-payment-view="${view}"]`).getAttribute('aria-pressed'), 'true');
    await page.locator(`#payment-list ${selector}`).waitFor();
  }
  assert.match(await section.textContent(), /UI QA approve/);
  assert.equal(await section.locator('#finance-discounts').textContent(), '1');
  await section.locator(`.discount-approve[data-discount="${first.id}"]`).click();
  await page.waitForFunction((id) => document.querySelector(`[data-discount="${id}"]`) === null, first.id);
  assert.match(await section.locator('#discount-message').textContent(), /Скидка одобрена/);
  assert.equal((await api('/api/discount-requests')).items.find((item) => item.id === first.id).status, 'approved');
  const reject = await api(`/api/orders/${order.id}/discount-requests`, 'POST', { type: 'percent', value: 5, reason: 'UI QA reject' }, 201);
  await section.locator('#discount-reload').click();
  await section.locator(`.discount-reject[data-discount="${reject.id}"]`).click();
  await page.waitForFunction((id) => document.querySelector(`[data-discount="${id}"]`) === null, reject.id);
  assert.equal((await api('/api/discount-requests')).items.find((item) => item.id === reject.id).status, 'rejected');
  const paidOrder = await api('/api/orders', 'POST', { tableId: 'discount-ui-paid-qa' }, 201);
  await api(`/api/orders/${paidOrder.id}/items`, 'POST', { productId: product.id, quantity: 1 }, 201);
  await api(`/api/orders/${paidOrder.id}/payments`, 'POST', { amount: 90, method: 'cash' }, 201);
  const conflict = await api(`/api/orders/${paidOrder.id}/discount-requests`, 'POST', { type: 'percent', value: 50, reason: `UI QA conflict ${'ОченьДлиннаяПричинаБезПробелов'.repeat(5)}` }, 201);
  await section.locator('#discount-reload').click();
  await section.locator(`.discount-approve[data-discount="${conflict.id}"]`).click();
  await page.waitForFunction(() => document.querySelector('#discount-message')?.textContent?.includes('Цена заказа уже зафиксирована после первого платежа'), null, { timeout: 5000 });
  assert.match(await section.locator('#discount-message').textContent(), /Цена заказа уже зафиксирована после первого платежа/);
  assert.equal((await api('/api/discount-requests')).items.find((item) => item.id === conflict.id).status, 'requested');
  await page.locator('#expense-category').selectOption(expenseCategory.id);
  await page.locator('#expense-amount').fill('12.50');
  await page.locator('#expense-date').fill(new Date().toISOString().slice(0, 10));
  await page.locator('#expense-description').fill('QA browser expense');
  await page.locator('#expense-form button[type="submit"]').click();
  await page.waitForFunction(() => document.querySelector('#expense-list')?.textContent?.includes('QA browser expense'), null, { timeout: 5000 }).catch(async (error) => { throw new Error(`${error.message}; notice=${await page.locator('.portal-notice').allTextContents()}; date=${await page.locator('#expense-date').inputValue()}; list=${await page.locator('#expense-list').textContent()}; api=${JSON.stringify(await api('/api/expenses?limit=20'))}`); });
  const recordedExpenses = await api('/api/expenses?limit=20');
  assert.ok(recordedExpenses.items.some((item) => item.description === 'QA browser expense' && Number(item.amount) === 12.5), 'expense form persists through API');
  await page.waitForFunction(() => document.querySelector('#expense-form button[type="submit"]')?.disabled === false, null, { timeout: 3000 });
  assert.equal(await page.locator('#expense-form button[type="submit"]').textContent(), 'Добавить расход', 'expense button unlocks on completion without fixed delay');
  await page.setViewportSize({ width: 375, height: 812 });
  await page.locator('#expense-category').selectOption(expenseCategory.id);
  await page.locator('#expense-amount').fill('37.25');
  await page.locator('#expense-description').fill('Fold draft stays here');
  await page.locator('#expenses-filter-from').fill('2026-08-01');
  await page.locator('#finance-chart-period').selectOption('30');
  await page.locator('[data-finance-chart-view="table"]').click();
  await page.evaluate(() => { window.__financeDraftField = document.querySelector('#expense-description'); });
  for (const [width, height, label] of [[375, 812, 'cover'], [768, 1024, 'main'], [375, 812, 'cover-return']]) {
    await page.setViewportSize({ width, height });
    assert.equal(await page.evaluate(() => window.__financeDraftField?.isConnected && window.__financeDraftField === document.querySelector('#expense-description')), true, `${label} keeps the same form without reload`);
    assert.equal(await page.locator('#expense-amount').inputValue(), '37.25', `${label} preserves amount`);
    assert.equal(await page.locator('#expense-description').inputValue(), 'Fold draft stays here', `${label} preserves description`);
    assert.equal(await page.locator('#expenses-filter-from').inputValue(), '2026-08-01', `${label} preserves filter`);
    assert.equal(await page.locator('#finance-chart-period').inputValue(), '30', `${label} preserves chart period`);
    assert.equal(await page.locator('[data-finance-chart-view="table"]').getAttribute('aria-pressed'), 'true', `${label} preserves chart view`);
    assert.equal(await page.evaluate(() => { const main = document.querySelector('.portal-main'); return document.documentElement.scrollWidth > innerWidth + 1 || main.scrollWidth > main.clientWidth + 1; }), false, `${label} has no horizontal overflow`);
    if (label !== 'cover-return') {
      const outputDir = path.resolve(process.env.FINANCE_QA_SCREENSHOT_DIR || 'docs/ai-team/responsive-emulator');
      await mkdir(outputDir, { recursive: true });
      await page.locator('#expense-form').screenshot({ path: path.join(outputDir, `finance-fold-draft-${label}.png`) });
    }
  }
  await page.setViewportSize({ width: 375, height: 420 });
  await page.locator('#expense-description').focus();
  await page.locator('#expense-form button[type="submit"]').scrollIntoViewIfNeeded();
  const submitGeometry = await page.locator('#expense-form button[type="submit"]').evaluate((button) => ({ top: button.getBoundingClientRect().top, bottom: button.getBoundingClientRect().bottom, viewport: innerHeight }));
  assert.ok(submitGeometry.top >= 0 && submitGeometry.bottom <= submitGeometry.viewport, `reduced-height viewport can reach expense submit: ${JSON.stringify(submitGeometry)}`);
  assert.equal(await page.locator('#expense-description').inputValue(), 'Fold draft stays here', 'reduced-height viewport retains draft');
  await page.setViewportSize({ width: 375, height: 812 });
  await page.locator('.sidebar-mobile-toggle').click();
  assert.equal(await page.locator('.sidebar-mobile-toggle').getAttribute('aria-expanded'), 'true', 'cover drawer opens');
  assert.equal(await page.locator('.portal-main').evaluate((main) => main.inert), true, 'open drawer prevents background interaction');
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.waitForFunction(() => document.querySelector('.sidebar-mobile-toggle')?.getAttribute('aria-expanded') === 'false');
  assert.equal(await page.locator('.portal-main').evaluate((main) => main.inert), false, 'unfold beyond drawer breakpoint restores workspace');
  await page.setViewportSize({ width: 375, height: 812 });
  assert.equal(await page.locator('#expense-description').inputValue(), 'Fold draft stays here', 'drawer transition keeps expense draft');
  await page.locator('#expense-form').evaluate((form) => form.reset());
  let expenseMutations = 0;
  let uploadedExpenseDocument = '';
  let expenseRequestSeen;
  const firstExpenseRequest = new Promise((resolve) => { expenseRequestSeen = resolve; });
  let releaseExpenseFailure;
  const expenseFailureGate = new Promise((resolve) => { releaseExpenseFailure = resolve; });
  await page.route('**/api/expenses', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    expenseMutations++;
    if (expenseMutations === 1) { expenseRequestSeen(); await expenseFailureGate; return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'qa_save_failed' }) }); }
    if (expenseMutations === 3) uploadedExpenseDocument = route.request().postDataJSON()?.documentUrl || '';
    return route.continue();
  });
  await page.locator('#expense-category').selectOption(expenseCategory.id);
  await page.locator('#expense-amount').fill('18.75');
  await page.locator('#expense-date').fill(new Date().toISOString().slice(0, 10));
  await page.locator('#expense-description').fill('QA retry expense');
  await page.locator('#expense-form button[type="submit"]').click();
  await page.waitForFunction(() => document.querySelector('#expense-form')?.dataset.submitting === '1');
  await page.locator('#expense-form').evaluate((form) => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  await firstExpenseRequest;
  assert.equal(expenseMutations, 1, 'duplicate submit while pending sends one expense request');
  releaseExpenseFailure();
  await page.waitForFunction(() => document.querySelector('#expense-form button[type="submit"]')?.disabled === false);
  assert.equal(await page.locator('#expense-description').inputValue(), 'QA retry expense', 'failed expense keeps draft');
  await page.locator('#expense-form button[type="submit"]').click();
  await page.waitForFunction(() => document.querySelector('#expense-list')?.textContent?.includes('QA retry expense'));
  assert.equal(expenseMutations, 2, 'retry sends exactly one additional request');
  assert.equal((await api('/api/expenses?limit=20')).items.filter((item) => item.description === 'QA retry expense').length, 1, 'retry persists one expense');
  await page.waitForFunction(() => document.querySelector('#expense-form button[type="submit"]')?.disabled === false);
  await page.locator('#expense-category').selectOption(expenseCategory.id);
  await page.locator('#expense-amount').fill('2.50');
  await page.locator('#expense-date').fill(new Date().toISOString().slice(0, 10));
  await page.locator('#expense-description').fill('QA file expense');
  await page.locator('#expense-document').setInputFiles({ name: 'receipt.png', mimeType: 'image/png', buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]) });
  await page.locator('#expense-form button[type="submit"]').click();
  await page.waitForFunction(() => document.querySelector('#expense-list')?.textContent?.includes('QA file expense'));
  assert.match(uploadedExpenseDocument, /^data:image\/png;base64,/, 'file reaches expense API as data URL');
  await page.waitForFunction(() => document.querySelector('#expense-form button[type="submit"]')?.disabled === false);
  for (const width of [320, 375, 430, 768, 1024, 1440, 2560]) {
    await page.setViewportSize({ width, height: 800 });
    assert.equal(await section.locator('.discount-row').count() > 0, true);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
    assert.equal(overflow, false, `finance viewport ${width} has horizontal overflow`);
    const controls = await section.locator('#discount-reload, .discount-approve, .discount-reject').evaluateAll((items) => items.map((item) => ({ text: item.textContent.trim(), height: item.getBoundingClientRect().height })));
    assert.ok(controls.every((control) => control.height >= 44), `discount controls meet 44px touch height at ${width}: ${JSON.stringify(controls)}`);
    if ([320, 768, 1440].includes(width)) {
      const outputDir = path.resolve('docs/ai-team/responsive-emulator');
      await mkdir(outputDir, { recursive: true });
      await page.evaluate(() => { document.querySelector('.portal-main').scrollTop = 0; });
      await page.screenshot({ path: path.join(outputDir, `finance-top-${width}.png`) });
      await page.evaluate(() => { const main = document.querySelector('.portal-main'); main.scrollTop += document.querySelector('#discounts').getBoundingClientRect().top - 100; });
      await page.screenshot({ path: path.join(outputDir, `finance-discounts-${width}.png`) });
      await page.evaluate(() => { const main = document.querySelector('.portal-main'); main.scrollTop = main.scrollHeight; });
      await page.screenshot({ path: path.join(outputDir, `finance-bottom-${width}.png`) });
    }
  }
  let failSummary = false;
  await page.route('**/api/finance/summary?*', (route) => route.fulfill(failSummary
    ? { status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'qa_unavailable' }) }
    : { status: 200, contentType: 'application/json', body: JSON.stringify({ revenue: 100, pendingRevenue: 0, closedOrders: 1, pendingOrders: 0, paymentCount: 4, currentShiftOrders: 1, currentShiftAverageCheck: 100, byPaymentMethod: { cash: 25, card: 25, qr: 25, other: 25 } }) }));
  const chartDays = Array.from({ length: 365 }, (_, index) => ({ date: new Date(Date.UTC(2025, 8, 1 + index)).toISOString().slice(0, 10), revenue: index + 1, orders: 1, averageCheck: index + 1, medianCheck: index + 1, expenses: 0, netProfit: index + 1 }));
  await page.route('**/api/analytics?days=all', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ days: chartDays, totalRevenue: 66795, totalExpenses: 0, netProfit: 66795, avgTablesPerDay: 1, byStation: {} }) }));
  await page.locator('#finance-date').fill('2026-09-01');
  await page.locator('#finance-date').dispatchEvent('change');
  assert.match(await page.locator('#finance-revenue-label').textContent(), /01\.09\.2026/, 'daily revenue label follows selected date');
  await page.locator('[data-payment-view="table"]').click();
  await page.waitForFunction(() => document.querySelectorAll('.payment-table-row').length === 4);
  await page.locator('[data-payment-view="line"]').click();
  const lineGeometry = await page.locator('.payment-line svg').evaluate((svg) => ({ width: svg.viewBox.baseVal.width, circles: [...svg.querySelectorAll('circle')].map((circle) => Number(circle.getAttribute('cx'))) }));
  assert.equal(lineGeometry.circles.length, 4);
  assert.ok(lineGeometry.circles.every((x) => x + 4 <= lineGeometry.width), `all four payment methods fit the line SVG: ${JSON.stringify(lineGeometry)}`);
  await page.locator('#finance-chart-metric').selectOption('revenue');
  await page.locator('#finance-chart-period').selectOption('365');
  await page.locator('[data-finance-chart-view="bars"]').click();
  const bars = page.locator('.finance-bars-view');
  assert.equal(await bars.locator('.finance-bars-item').count(), 365);
  const barScroll = await bars.evaluate((node) => ({ width: node.clientWidth, full: node.scrollWidth }));
  assert.ok(barScroll.full > barScroll.width, '365 bars have their own horizontal scroll instead of clipping');
  assert.equal(await bars.evaluate((node) => { node.scrollLeft = node.scrollWidth; return node.lastElementChild.getBoundingClientRect().right <= node.getBoundingClientRect().right + 1; }), true, 'last annual bar is reachable');
  failSummary = true;
  await page.locator('#finance-date').fill('2026-08-31');
  await page.locator('#finance-date').dispatchEvent('change');
  await page.waitForFunction(() => document.querySelector('#payment-list')?.textContent?.includes('Не удалось загрузить'));
  assert.equal(await page.locator('#finance-orders').textContent(), '—', 'failed refresh clears old order count');
  assert.equal(await page.locator('#finance-total-turnover').textContent(), '—', 'failed refresh clears old business result');
  assert.equal(await page.locator('[data-payment-view="table"]').isDisabled(), true, 'failed refresh disables views backed by old payments');
  await page.locator('[data-payment-view="table"]').evaluate((button) => button.click());
  assert.match(await page.locator('#payment-list').textContent(), /Не удалось загрузить/, 'view toggle cannot restore stale payments');
  failSummary = false;
  await page.locator('#finance-date').fill('2026-08-30');
  await page.locator('#finance-date').dispatchEvent('change');
  await page.waitForFunction(() => document.querySelector('[data-payment-view="table"]')?.disabled === false);
  let releaseOldExpenses;
  const oldExpenseGate = new Promise((resolve) => { releaseOldExpenses = resolve; });
  let oldExpenseStarted;
  const oldExpenseRequest = new Promise((resolve) => { oldExpenseStarted = resolve; });
  let oldExpenseServed;
  const oldExpenseDone = new Promise((resolve) => { oldExpenseServed = resolve; });
  await page.route('**/api/expenses?*', async (route) => {
    const old = new URL(route.request().url()).searchParams.get('from') === '2026-09-01';
    if (old) { oldExpenseStarted(); await oldExpenseGate; }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [{ category: old ? 'OLD QA CATEGORY' : 'NEW QA CATEGORY', amount: 10, expenseDate: '2026-09-01' }], totalCount: 1 }) });
    if (old) oldExpenseServed();
  });
  await page.locator('#expenses-filter-from').fill('2026-09-01');
  await page.locator('#expenses-filter-apply').click();
  await oldExpenseRequest;
  await page.locator('#expenses-filter-reset').click();
  await page.waitForFunction(() => document.querySelector('#expense-list')?.textContent?.includes('NEW QA CATEGORY'));
  releaseOldExpenses();
  await oldExpenseDone;
  assert.match(await page.locator('#expense-list').textContent(), /NEW QA CATEGORY/);
  assert.doesNotMatch(await page.locator('#expense-list').textContent(), /OLD QA CATEGORY/, 'late expense response cannot replace current filter');
  let payableLoads = 0;
  await page.route('**/api/finance/purchase-payables', (route) => {
    payableLoads++;
    return route.fulfill(payableLoads === 1
      ? { status: 200, contentType: 'application/json', body: JSON.stringify({ items: [{ id: 'qa-payable', supplierName: 'QA supplier', documentNumber: 'QA-1', documentDate: '2026-09-01', totalCost: 100, totalPaid: 0, balanceDue: 100, paymentStatus: 'unpaid' }] }) }
      : { status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'qa_unavailable' }) });
  });
  await page.route('**/api/finance/purchase-payables/qa-payable/payments', (route) => route.fulfill({ status: 201, contentType: 'application/json', body: '{}' }));
  await page.goto(`${base}/finance`, { waitUntil: 'networkidle' });
  await page.locator('.payable-row').first().waitFor();
  await page.locator('.payable-payment-editor summary').first().click();
  await page.locator('.payable-payment-form button[type="submit"]').first().click();
  await page.waitForFunction(() => document.querySelector('#payables-list')?.textContent?.includes('Не удалось загрузить расчёты'));
  await page.locator('#payables-search').fill('QA supplier');
  assert.match(await page.locator('#payables-list').textContent(), /Не удалось загрузить расчёты/, 'filters cannot restore stale supplier balances');
  assert.equal(await page.locator('#payables-count').textContent(), '—');
  let payrollStatus = 'draft';
  let payrollPatches = 0;
  let releasePayrollPatch;
  const payrollPatchGate = new Promise((resolve) => { releasePayrollPatch = resolve; });
  await page.route('**/api/payroll/entries?*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [{ id: 'qa-payroll-entry', userId: 'qa-user', userName: 'QA employee', ruleId: 'qa-rule', ruleName: 'QA hourly', periodFrom: '2026-09-01', periodTo: '2026-09-30', amount: 1000, hours: 2, status: payrollStatus }] }) }));
  await page.route('**/api/payroll/entries/qa-payroll-entry', async (route) => { payrollPatches++; await payrollPatchGate; payrollStatus = 'approved'; await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: payrollStatus }) }); });
  await page.goto(`${base}/finance`, { waitUntil: 'networkidle' });
  await page.locator('[data-payroll-action="approve"]').click();
  await page.waitForFunction(() => document.querySelector('[data-payroll-action="approve"]')?.disabled === true);
  assert.equal(await page.locator('[data-payroll-cancel-open]').isDisabled(), true, 'conflicting payroll action is disabled during approval');
  await page.locator('[data-payroll-cancel-open]').evaluate((button) => button.click());
  assert.equal(await page.locator('[data-payroll-cancel-editor]').isHidden(), true, 'pending payroll action cannot open cancellation');
  assert.equal(payrollPatches, 1, 'one payroll mutation sent while pending');
  releasePayrollPatch();
  await page.waitForFunction(() => document.querySelector('[data-payroll-action="pay"]') !== null);
  assert.deepEqual(exceptions, [], 'no uncaught browser exceptions');
  console.log('FINANCE INTERACTIONS RUNTIME QA: PASS (discounts, charts, 365-day scroll, expense/payroll races, Fold draft/drawer, reduced height, 7 widths)');
} finally {
  await browser?.close();
  child.kill();
  if (child.exitCode === null) await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 3000))]);
}
