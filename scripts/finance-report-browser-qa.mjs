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
  const timer = setTimeout(() => reject(new Error(`Finance report QA server did not start: ${output}`)), 15000);
  child.once('error', reject);
  child.stdout.on('data', () => { const match = output.match(/CRM running on http:\/\/localhost:(\d+)/); if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); } });
});
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 320, height: 700 }, locale: 'ru-RU' });
  const exceptions = [];
  page.on('pageerror', (error) => exceptions.push(error.message));
  await page.goto(`${base}/login`, { waitUntil: 'networkidle' });
  await page.locator('#login-username').fill('admin');
  await page.locator('#login-password').fill('admin');
  await page.locator('#login-form button[type="submit"]').click();
  await page.waitForURL((url) => !url.pathname.includes('/login'));
  let fail = false;
  let releaseOldRead;
  const oldReadGate = new Promise((resolve) => { releaseOldRead = resolve; });
  let oldReadSeen;
  const oldReadRequest = new Promise((resolve) => { oldReadSeen = resolve; });
  await page.route('**/api/finance/report?*', async (route) => {
    const url = new URL(route.request().url());
    const date = url.searchParams.get('date');
    const type = url.searchParams.get('type');
    if (date === '2026-09-27') { oldReadSeen(); await oldReadGate; }
    if (fail) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'temporary_unavailable' }) });
    const revenue = date === '2026-09-27' ? 99 : 1286459.73;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ reportNumber: 'QA-REPORT', generatedAt: '2026-09-30T09:30:00Z', revenue, checksCount: 12, paymentCount: 16, cash: 500000, card: 700000, qr: 86459.73, byPaymentMethod: { cash: 500000, card: 700000, qr: 86459.73 }, byStation: { 'Очень длинное название зоны с несколькими словами': revenue }, byStaff: type === 'waiter' ? { 'Сотрудник с очень длинным именем и фамилией': revenue } : {} }) });
  });
  await page.goto(`${base}/finance/report`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => /1\s*286\s*459/.test(document.querySelector('#report-revenue')?.textContent || ''));
  assert.match(await page.locator('#report-number').textContent(), /QA-REPORT/);
  assert.equal(await page.locator('.report-row').count(), 4, 'payment and station rows render');
  await page.locator('#report-date').fill('2026-09-29');
  assert.equal(await page.locator('#report-revenue').textContent(), '—', 'date edit clears previous KPI before submit');
  assert.equal(await page.locator('#report-number').textContent(), 'Отчёт ещё не сформирован');
  fail = true;
  await page.locator('#report-refresh').click();
  await page.locator('#report-message').getByText('Не удалось сформировать отчёт. Повторите попытку.').waitFor();
  assert.equal(await page.locator('#report-revenue').textContent(), '—', 'failed request cannot show stale revenue');
  assert.equal(await page.locator('.report-row').count(), 0, 'failed request clears old breakdown');
  fail = false;
  await page.locator('#report-refresh').click();
  await page.waitForFunction(() => /1\s*286\s*459/.test(document.querySelector('#report-revenue')?.textContent || ''));
  await page.locator('#report-type').selectOption('waiter');
  await page.locator('#report-secondary').getByText('Сотрудник с очень длинным именем и фамилией').waitFor();
  assert.equal(await page.locator('#report-secondary-title').textContent(), 'Выручка по сотрудникам');
  await page.locator('#report-date').fill('2026-09-27');
  await page.locator('#report-refresh').click();
  await oldReadRequest;
  await page.locator('#report-date').fill('2026-09-28');
  await page.locator('#report-refresh').click();
  await page.waitForFunction(() => /1\s*286\s*459/.test(document.querySelector('#report-revenue')?.textContent || ''));
  releaseOldRead();
  await page.waitForTimeout(100);
  assert.match(await page.locator('#report-revenue').textContent(), /1\s*286\s*459/, 'late old report cannot overwrite new date');
  const outputDir = path.resolve('docs/ai-team/responsive-emulator');
  await mkdir(outputDir, { recursive: true });
  for (const width of [320, 768, 1440]) {
    await page.setViewportSize({ width, height: 800 });
    assert.equal(await page.evaluate(() => { const main = document.querySelector('.portal-main'); const controls = document.querySelector('.report-controls'); const grid = document.querySelector('.report-grid'); return document.documentElement.scrollWidth > innerWidth + 1 || main.scrollWidth > main.clientWidth + 1 || controls.scrollWidth > controls.clientWidth + 1 || grid.scrollWidth > grid.clientWidth + 1; }), false, `filled report overflow at ${width}px`);
    if (width === 320) {
      assert.equal(await page.locator('#report-refresh').evaluate((button) => Math.abs(button.getBoundingClientRect().width - button.parentElement.getBoundingClientRect().width) <= 2), true, 'mobile report action fills control column');
      await page.locator('#portal-notice').waitFor({ state: 'detached' });
      await page.screenshot({ path: path.join(outputDir, 'finance-report-filled-320.png'), fullPage: true });
      await page.locator('.report-grid').screenshot({ path: path.join(outputDir, 'finance-report-breakdown-320.png') });
    }
  }
  assert.deepEqual(exceptions.filter((message) => !message.includes('ViewTransition opt-in disabled')), []);
  console.log('FINANCE REPORT BROWSER QA: PASS (date edit/error/retry, waiter switch, stale GET, filled 320/768/1440 widths)');
} finally {
  await browser?.close();
  child.kill();
  if (child.exitCode === null) await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 3000))]);
}
