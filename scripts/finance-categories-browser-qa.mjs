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
  const timer = setTimeout(() => reject(new Error(`Finance category QA server did not start: ${output}`)), 15000);
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
  await page.goto(`${base}/finance/categories`, { waitUntil: 'networkidle' });
  await page.locator('#new-finance-category').click();
  await page.locator('#finance-category-name').fill('QA browser rent');
  await page.locator('#finance-category-kind').selectOption('expense');
  await page.locator('#finance-category-form button[type="submit"]').click();
  const row = page.locator('.category-row').filter({ hasText: 'QA browser rent' });
  await row.waitFor();
  await page.locator('#new-finance-category').click();
  await page.locator('#finance-category-name').fill('QA browser rent');
  await page.locator('#finance-category-kind').selectOption('expense');
  await page.locator('#finance-category-form button[type="submit"]').click();
  await page.locator('#finance-category-message').getByText('Активная категория с таким названием уже есть').waitFor();
  assert.equal(await page.locator('#finance-category-name').inputValue(), 'QA browser rent', 'duplicate error keeps draft');
  await page.locator('#cancel-finance-category').click();

  let patchCount = 0;
  let releasePatch;
  const patchGate = new Promise((resolve) => { releasePatch = resolve; });
  let patchSeen;
  const patchRequest = new Promise((resolve) => { patchSeen = resolve; });
  await page.route('**/api/finance/categories/*', async (route) => {
    if (route.request().method() !== 'PATCH') return route.continue();
    patchCount++;
    if (patchCount === 1) { patchSeen(); await patchGate; return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'temporary_unavailable' }) }); }
    return route.continue();
  });
  await row.locator('.finance-category-edit').click();
  await page.locator('#finance-category-name').fill('QA browser rent revised');
  await page.locator('#finance-category-form button[type="submit"]').click();
  await patchRequest;
  assert.equal(await page.locator('#finance-category-name').isDisabled(), true, 'editor is locked during save');
  assert.equal(await page.locator('#cancel-finance-category').isDisabled(), true, 'cancel is locked during save');
  assert.equal(await page.locator('#new-finance-category').isDisabled(), true, 'new editor is locked during save');
  await page.locator('#finance-category-form').evaluate((form) => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  releasePatch();
  await page.locator('#finance-category-message').getByText('Не удалось сохранить категорию').waitFor();
  assert.equal(patchCount, 1, 'pending save does not send a second PATCH');
  assert.equal(await page.locator('#finance-category-name').inputValue(), 'QA browser rent revised', 'failed save keeps draft');
  assert.equal(await page.locator('#finance-category-name').isDisabled(), false, 'failed save unlocks editor');
  await page.locator('#finance-category-form button[type="submit"]').click();
  await page.locator('.category-row').filter({ hasText: 'QA browser rent revised' }).waitFor();
  assert.equal(patchCount, 2, 'one successful retry');

  const revised = page.locator('.category-row').filter({ hasText: 'QA browser rent revised' });
  await revised.locator('[data-category-status]').click();
  await page.locator('.action-modal.open .action-footer button[type="submit"]').click();
  await page.waitForFunction(() => !document.querySelector('.category-row')?.textContent?.includes('QA browser rent revised'));
  await page.locator('#finance-category-status').selectOption('all');
  const archived = page.locator('.category-row').filter({ hasText: 'QA browser rent revised' });
  await archived.waitFor();
  assert.match(await archived.textContent(), /В архиве/);
  await archived.locator('[data-category-status]').click();
  await page.waitForFunction(() => { const row = [...document.querySelectorAll('.category-row')].find((item) => item.textContent?.toLocaleLowerCase('ru-RU').includes('qa browser rent revised')); return row && !row.textContent.includes('В архиве'); });
  await page.reload({ waitUntil: 'networkidle' });
  await row.waitFor();
  assert.match(await row.textContent(), /QA Browser Rent Revised/i);
  for (const width of [320, 768, 1440]) {
    await page.setViewportSize({ width, height: 800 });
    assert.equal(await page.evaluate(() => { const main = document.querySelector('.portal-main'); const panel = document.querySelector('.finance-categories-panel'); return document.documentElement.scrollWidth > innerWidth + 1 || main.scrollWidth > main.clientWidth + 1 || panel.scrollWidth > panel.clientWidth + 1; }), false, `category page overflow at ${width}px`);
  }
  let phase = 'failure';
  let releaseOldRead;
  const oldReadGate = new Promise((resolve) => { releaseOldRead = resolve; });
  let oldReadSeen;
  const oldReadRequest = new Promise((resolve) => { oldReadSeen = resolve; });
  await page.route('**/api/finance/categories*', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    if (phase === 'failure') return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'temporary_unavailable' }) });
    const archived = new URL(route.request().url()).searchParams.get('includeArchived') === 'true';
    if (phase === 'race' && !archived) { oldReadSeen(); await oldReadGate; }
    const name = phase === 'recovery' ? 'RECOVERED CATEGORY' : archived ? 'LATEST CATEGORY' : 'STALE CATEGORY';
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [{ id: `qa-${name}`, name, kind: 'expense', active: true, operationCount: 0 }] }) });
  });
  await page.locator('#new-finance-category').click();
  await page.locator('#finance-category-name').fill('QA refresh failure');
  await page.locator('#finance-category-kind').selectOption('expense');
  await page.locator('#finance-category-form button[type="submit"]').click();
  await page.locator('[data-finance-category-retry]').waitFor();
  assert.match(await page.locator('#portal-notice').textContent(), /Категория сохранена, но список не обновился/);
  assert.equal(await page.locator('#portal-notice').getAttribute('data-kind'), 'error');
  phase = 'race';
  await page.locator('#finance-category-status').evaluate((select) => select.dispatchEvent(new Event('change', { bubbles: true })));
  await oldReadRequest;
  await page.locator('#finance-category-status').selectOption('all');
  await page.locator('#finance-category-list').getByText('LATEST CATEGORY').waitFor();
  releaseOldRead();
  await page.waitForTimeout(100);
  assert.doesNotMatch(await page.locator('#finance-category-list').textContent(), /STALE CATEGORY/, 'late active response cannot overwrite all-status filter');
  phase = 'failure';
  await page.locator('#finance-category-status').selectOption('active');
  await page.locator('[data-finance-category-retry]').waitFor();
  assert.equal(await page.locator('#finance-category-count').textContent(), '—', 'failed read clears stale count');
  assert.doesNotMatch(await page.locator('#finance-category-list').textContent(), /LATEST CATEGORY/, 'failed read clears stale rows');
  await page.locator('#finance-category-search').fill('irrelevant');
  assert.equal(await page.locator('[data-finance-category-retry]').count(), 1, 'search does not remove retry after failed read');
  await page.locator('#finance-category-search').fill('');
  phase = 'recovery';
  await page.locator('[data-finance-category-retry]').click();
  await page.locator('#finance-category-list').getByText('RECOVERED CATEGORY').waitFor();
  assert.deepEqual(exceptions.filter((message) => !message.includes('ViewTransition opt-in disabled')), []);
  console.log('FINANCE CATEGORIES BROWSER QA: PASS (create/duplicate/edit error retry/archive/restore/reload, stale GET/error retry, 3 widths)');
} finally {
  await browser?.close();
  child.kill();
  if (child.exitCode === null) await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 3000))]);
}
