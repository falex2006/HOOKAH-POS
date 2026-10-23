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
  const timer = setTimeout(() => reject(new Error(`Coverage QA server did not start: ${output}`)), 15000);
  child.once('error', reject);
  child.stdout.on('data', () => { const match = output.match(/CRM running on http:\/\/localhost:(\d+)/); if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); } });
});
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: 'ru-RU' });
  const exceptions = [];
  page.on('pageerror', (error) => exceptions.push(error.message));
  await page.goto(`${base}/login`, { waitUntil: 'networkidle' });
  await page.locator('#login-username').fill('admin');
  await page.locator('#login-password').fill('admin');
  await page.locator('#login-form button[type="submit"]').click();
  await page.waitForURL((url) => !url.pathname.includes('/login'));
  await page.route('**/api/finance/report-venues*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [{ id: 'venue-test', name: 'Тестовое заведение', timeZone: 'Asia/Yekaterinburg', isCurrent: true }] }) }));
  await page.route('**/api/finance/categories?*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [{ id: 'category-test', name: 'Закупки для бара', type: 'expense', active: true }] }) }));
  const fixture = {
    venue: { id: 'venue-test', name: 'Тестовое заведение', timeZone: 'Asia/Yekaterinburg' },
    items: {
      cashAccountCoverage: [{ id: 'legacy-event', source: 'legacy', amount: '25.00' }],
      cashOutflows: [{ id: '11111111-1111-4111-8111-111111111111', purchaseDocumentId: '22222222-2222-4222-8222-222222222222', source: 'purchase', categoryName: 'Закупки для бара', counterpartyName: 'Поставщик с длинным названием', paymentAccountNameSnapshot: 'Расчётный счёт', amount: '1286459.73', eventDate: '2026-10-22' }],
    },
    coverage: {
      payrollAccruals: 'finance_permission_required',
      payableRecognition: {
        status: 'incomplete', unrecognizedCount: 2, unrecognizedAmount: '1900.00',
        items: [{ payableId: 'payable-1', title: '<img src=x onerror=alert(1)> Аренда помещения', counterpartyName: 'ООО Дом', servicePeriodFrom: '2026-10-01', servicePeriodTo: '2026-10-31', categoryName: 'Аренда', unrecognizedAmount: '1900.00' }],
      },
      posIncomeClassification: { status: 'incomplete', unclassifiedRevenueCount: 3, unclassifiedRevenueAmount: '1250.00' },
      cashAccounts: { status: 'incomplete', unassignedLegacyCount: 1, unassignedLegacyAmount: '25.00' },
      manualExpenseRefunds: { status: 'incomplete', count: 4, amount: '99.50', dateBasis: 'actual_refund_date', pnlEffect: 'not_calculated' },
      refundRecognition: 'not_connected',
      possiblyTruncatedSections: ['payableRecognitionCoverage'],
    },
  };
  let requestedSearch = null;
  let submittedFilters = null;
  let sourceFailure = true;
  let sourceReads = 0;
  await page.route('**/api/finance/source-documents/purchase/*', route => {
    sourceReads += 1;
    assert.equal(new URL(route.request().url()).searchParams.get('venueId'), 'venue-test');
    return route.fulfill({ status: sourceFailure ? 404 : 200, contentType: 'application/json', body: JSON.stringify(sourceFailure ? { error: 'not_found' } : {
      venue: { id: 'venue-test' }, document: { id: '22222222-2222-4222-8222-222222222222', supplierName: 'Поставщик с длинным названием', documentNumber: 'QA-22', documentDate: '2026-10-22', status: 'posted', totalCost: 1286459.73, lines: [{ ingredientName: 'Ингредиент с длинным названием для проверки переноса', quantity: 12, unit: 'шт.', unitCost: 250 }] },
    }) });
  });
  await page.route('**/api/finance/unified-report?*', (route) => { requestedSearch = new URL(route.request().url()).searchParams.get('q'); return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fixture) }); });
  await page.route('**/api/finance/unified-report/snapshots', route => {
    assert.equal(route.request().method(), 'POST');
    const filters = route.request().postDataJSON();
    submittedFilters = filters;
    requestedSearch = filters.q || null;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fixture) });
  });
  await page.goto(`${base}/finance/report`, { waitUntil: 'networkidle' });
  const message = page.locator('[data-unified-message]');
  await page.waitForFunction(() => document.querySelector('[data-unified-message]')?.textContent.includes('Признание POS-возвратов')).catch(async error => { throw new Error(`${error.message}; message=${await message.textContent()}; pageErrors=${exceptions.join('; ')}`); });
  const warningText = await message.textContent();
  assert.doesNotMatch(warningText, /payableRecognitionCoverage/, 'coverage warning uses human section names');
  assert.match(warningText, /Утверждено без признания/);
  for (const warning of ['Не признано договорных расходов', 'Возвраты ручных расходов', 'Начисления и выплаты зарплаты скрыты', 'POS без статьи классификации', 'Без счёта отмечено', 'Признание POS-возвратов', 'не более 500 строк']) assert.ok(warningText.includes(warning), `simultaneous coverage warning is visible: ${warning}; received: ${warningText}`);
  assert.match(warningText, /Возвраты ручных расходов:\s*4\s+на\s+99[,.]5(?:0)?/, 'manual refund warning includes its count and amount');
  const coverage = page.locator('[data-coverage="payable-recognition"]');
  assert.equal(await coverage.count(), 1, 'approved but unrecognized obligations appear as an expandable coverage group');
  await coverage.locator('summary').click();
  await coverage.getByText('Аренда помещения', { exact: false }).waitFor();
  await coverage.getByText('ООО Дом', { exact: false }).waitFor();
  await coverage.getByText('2026-10-01', { exact: false }).waitFor();
  await coverage.getByText('Аренда', { exact: false }).waitFor();
  await coverage.getByText('Показаны первые 500 документов', { exact: false }).waitFor();
  assert.equal(await coverage.locator('img').count(), 0, 'untrusted payable title is rendered as text, not executable markup');
  await page.locator('[data-unified-q]').fill('аренда');
  await page.locator('[data-unified-load]').click();
  await page.waitForFunction(() => document.querySelector('[data-unified-message]')?.textContent.includes('Признание POS-возвратов'));
  assert.equal(requestedSearch, 'аренда', 'document search is passed to the report API');
  const expenseGroup = page.locator('.report-source-group').filter({ has: page.locator('[data-report-source="purchase"]') });
  await expenseGroup.locator('summary').click();
  const opener = expenseGroup.locator('[data-report-source="purchase"]');
  await opener.click();
  await page.getByText('Исходный документ не найден в выбранном заведении.', { exact: true }).waitFor();
  assert.equal(await opener.isEnabled(), true, 'failed source read allows retry');
  sourceFailure = false;
  const outputDir = path.resolve(process.env.QA_OUTPUT_DIR || 'tmp/finance-unified-visual');
  await mkdir(outputDir, { recursive: true });
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    await expenseGroup.screenshot({ path: path.join(outputDir, `expense-row-${width}.png`) });
    const rowBounds = await expenseGroup.evaluate(node => { const r=node.getBoundingClientRect(); return {left:r.left,right:r.right,width:innerWidth,scrollWidth:document.documentElement.scrollWidth}; });
    assert.ok(rowBounds.left>=0 && rowBounds.right<=width+1 && rowBounds.scrollWidth<=width+1, `report rows fit ${width}: ${JSON.stringify(rowBounds)}`);
    if(width===320) await page.screenshot({ path: path.join(outputDir, 'expense-row-page-320.png') });
    await opener.click();
    const dialog = page.getByRole('dialog').filter({ hasText: 'Исходная закупка' });
    await dialog.waitFor({ state: 'visible' });
    assert.equal(await page.getByText('Исходный документ не найден в выбранном заведении.', { exact: true }).count(), 0, 'retry clears its old source error');
    assert.equal(await dialog.locator('details').getAttribute('open'), null, 'technical identifiers start collapsed');
    await dialog.locator('summary').click();
    await dialog.getByText('Документ: 22222222-2222-4222-8222-222222222222', { exact: true }).waitFor();
    const bounds = await dialog.evaluate(node => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, width: innerWidth, overflow: node.scrollWidth > node.clientWidth + 1 }; });
    assert.ok(bounds.left >= -1 && bounds.right <= bounds.width + 1 && !bounds.overflow, `source dialog fits ${width}: ${JSON.stringify(bounds)}`);
    await dialog.screenshot({ path: path.join(outputDir, `purchase-source-${width}.png`) });
    await dialog.locator('[type="submit"]').click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(await opener.isEnabled(), true);
    assert.equal(await opener.evaluate(node => document.activeElement === node), true, `closing source returns focus to its action; active=${await page.evaluate(() => document.activeElement?.outerHTML.slice(0,250))}`);
  }
  assert.equal(sourceReads, 5, 'one failed request and four successful source views');
  await page.locator('[data-unified-from]').fill('2026-11-01');
  await page.locator('[data-unified-to]').fill('2026-10-01');
  await page.locator('[data-unified-load]').click();
  await page.getByText('Укажите корректный период.', { exact: true }).waitFor();
  assert.equal(await page.locator('[data-unified-results] .report-row').count(), 0, 'invalid period must not leave stale amounts visible');
  assert.equal(await page.locator('[data-unified-from]').getAttribute('aria-invalid'), 'true');
  await page.locator('[data-unified-from]').fill('2026-10-01');
  await page.locator('[data-unified-to]').fill('2026-10-31');
  await page.locator('[data-unified-load]').click();
  await expenseGroup.waitFor();
  assert.equal(await page.locator('[data-unified-from]').getAttribute('aria-invalid'), null);
  await page.setViewportSize({ width: 320, height: 844 });
  for (const [selector, option] of [['[data-unified-source]', 'Денежные расходы'], ['[data-unified-category]', 'Закупки для бара'], ['[data-unified-status]', 'Оплачено']]) {
    const label = page.locator('#financial-sources label').filter({ has: page.locator(selector) });
    await label.locator('.custom-select-trigger').click();
    const menu = label.locator('.custom-select-menu');
    await menu.waitFor({ state: 'visible' });
    assert.equal(await menu.evaluate(node => { const r=node.getBoundingClientRect(); return r.left>=0 && r.right<=innerWidth+1; }), true, `${selector} menu fits phone`);
    if (selector === '[data-unified-source]') await menu.screenshot({ path: path.join(outputDir, 'source-filter-320.png') });
    await menu.getByRole('option', { name: new RegExp('^' + option) }).click();
  }
  await page.locator('[data-unified-load]').click();
  await expenseGroup.waitFor();
  assert.deepEqual({ source: submittedFilters.source, categoryId: submittedFilters.categoryId, status: submittedFilters.status }, { source: 'cash_out', categoryId: 'category-test', status: 'paid' });
  assert.deepEqual(exceptions, [], `browser errors: ${exceptions.join('; ')}`);
  console.log('FINANCE UNIFIED COVERAGE BROWSER QA: PASS (warnings, search, purchase 404/retry/dialog at 320/390/768/1440, invalid dates and recovery)');
} finally {
  await browser?.close();
  child.kill();
  if (child.exitCode === null) await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 3000))]);
}
