import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

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
  await page.route('**/api/finance/categories?*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [] }) }));
  const fixture = {
    venue: { id: 'venue-test', name: 'Тестовое заведение', timeZone: 'Asia/Yekaterinburg' },
    items: { cashAccountCoverage: [{ id: 'legacy-event', source: 'legacy', amount: '25.00' }] },
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
  await page.route('**/api/finance/unified-report?*', (route) => { requestedSearch = new URL(route.request().url()).searchParams.get('q'); return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fixture) }); });
  await page.goto(`${base}/finance/report`, { waitUntil: 'networkidle' });
  const message = page.locator('[data-unified-message]');
  await page.waitForFunction(() => document.querySelector('[data-unified-message]')?.textContent.includes('Признание POS-возвратов'));
  const warningText = await message.textContent();
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
  assert.deepEqual(exceptions, [], `browser errors: ${exceptions.join('; ')}`);
  console.log('FINANCE UNIFIED COVERAGE BROWSER QA: PASS (simultaneous warnings, payable document drilldown, truncation disclosure)');
} finally {
  await browser?.close();
  child.kill();
  if (child.exitCode === null) await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 3000))]);
}
