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
  env: { ...process.env, HOST: '127.0.0.1', PORT: '0', DATABASE_URL: '', AUTH_REQUIRED: 'false', DEMO_MODE: 'false', NODE_ENV: 'test' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stdout.on('data', (chunk) => { output += chunk; });
child.stderr.on('data', (chunk) => { output += chunk; });
const base = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`Delivery QA server did not start: ${output}`)), 15000);
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
  await page.goto(`${base}/delivery`, { waitUntil: 'networkidle' });
  await page.locator('#delivery-name').fill('QA delivery guest');
  await page.locator('#delivery-phone').fill('+7 1');
  await page.locator('#delivery-address').fill('Длинная улица, дом 12, квартира 345');
  await page.locator('#delivery-total').fill('1286459.73');
  await page.locator('#delivery-payment').selectOption('card');
  await page.locator('#delivery-comment').fill('Длинный комментарий для проверки переноса на маленьком экране');
  await page.locator('#delivery-form button[type="submit"]').click();
  await page.locator('#delivery-message').getByText('Проверьте телефон').waitFor();
  assert.equal(await page.locator('#delivery-name').inputValue(), 'QA delivery guest', 'failed create retains form');
  await page.locator('#delivery-phone').fill('+7 999 123-45-67');
  let postCount = 0;
  let failNextGet = false;
  let releaseFailedPost;
  const failedPostGate = new Promise((resolve) => { releaseFailedPost = resolve; });
  let failedPostSeen;
  const failedPostRequest = new Promise((resolve) => { failedPostSeen = resolve; });
  await page.route('**/api/deliveries', async (route) => {
    if (route.request().method() === 'GET' && failNextGet) { failNextGet = false; return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'temporary_unavailable' }) }); }
    if (route.request().method() !== 'POST') return route.continue();
    postCount++;
    if (postCount === 1) { failedPostSeen(); await failedPostGate; return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'temporary_unavailable' }) }); }
    return route.continue();
  });
  await page.locator('#delivery-form button[type="submit"]').click();
  await failedPostRequest;
  assert.equal(await page.locator('#delivery-address').isDisabled(), true, 'delivery draft is locked during POST');
  await page.locator('#delivery-form').evaluate((form) => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  releaseFailedPost();
  await page.locator('#delivery-message').getByText('Не удалось создать доставку. Попробуйте ещё раз').waitFor();
  assert.equal(postCount, 1, 'pending create sends one POST');
  assert.equal(await page.locator('#delivery-address').inputValue(), 'Длинная улица, дом 12, квартира 345', 'failed create keeps address');
  assert.equal(await page.locator('#delivery-address').isDisabled(), false, 'failed create unlocks draft');
  failNextGet = true;
  await page.locator('#delivery-form button[type="submit"]').click();
  await page.locator('#delivery-message').getByText('Доставка создана, но список не обновился. Повторите загрузку.').waitFor();
  assert.equal(postCount, 2, 'retry saves one delivery');
  await page.locator('[data-delivery-retry]').click();
  const row = page.locator('.delivery-row').filter({ hasText: 'QA delivery guest' });
  await row.waitFor();
  assert.match(await row.textContent(), /1\s*286\s*459/);
  assert.match(await row.textContent(), /Карта/, 'saved payment method is visible in queue');
  await page.reload({ waitUntil: 'networkidle' });
  await row.waitFor();
  assert.match(await row.textContent(), /Карта/);
  await page.locator('#delivery-filter').selectOption('cancelled');
  assert.equal(await page.locator('.delivery-row').count(), 0, 'status filter produces empty state');
  await page.locator('#delivery-filter').selectOption('new');
  await row.waitFor();

  let patchCount = 0;
  let releaseFirstPatch;
  const patchGate = new Promise((resolve) => { releaseFirstPatch = resolve; });
  let firstPatchSeen;
  const firstPatchRequest = new Promise((resolve) => { firstPatchSeen = resolve; });
  await page.route('**/api/deliveries/*', async (route) => {
    if (route.request().method() !== 'PATCH') return route.continue();
    patchCount++;
    if (patchCount === 1) { firstPatchSeen(); await patchGate; }
    return route.continue();
  });
  await row.locator('[data-delivery-status]').selectOption('confirmed');
  await firstPatchRequest;
  await page.locator('#delivery-filter').selectOption('');
  assert.equal(await row.locator('[data-delivery-status]').isDisabled(), true, 'status stays locked after filter redraw');
  await row.locator('[data-delivery-status]').evaluate((select) => { select.value = 'delivered'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  releaseFirstPatch();
  await page.waitForFunction(() => document.querySelector('.delivery-row [data-delivery-status]')?.value === 'confirmed');
  assert.equal(patchCount, 1, 'redraw during pending status sends one PATCH');
  for (const [status, label] of [['in_delivery', 'У курьера'], ['delivered', 'Доставлена'], ['cancelled', 'Отменена']]) {
    await row.locator('[data-delivery-status]').selectOption(status);
    await page.waitForFunction((expected) => document.querySelector('.delivery-row .badge')?.textContent === expected, label);
  }
  await page.reload({ waitUntil: 'networkidle' });
  await row.waitFor();
  assert.match(await row.textContent(), /Отменена/);
  for (const width of [320, 768, 1440]) {
    await page.setViewportSize({ width, height: 800 });
    assert.equal(await page.evaluate(() => { const main = document.querySelector('.portal-main'); const row = document.querySelector('.delivery-row'); return document.documentElement.scrollWidth > innerWidth + 1 || main.scrollWidth > main.clientWidth + 1 || row.scrollWidth > row.clientWidth + 1; }), false, `delivery overflow at ${width}px`);
    if (width === 320) { const outputDir = path.resolve('docs/ai-team/responsive-emulator'); await mkdir(outputDir, { recursive: true }); await row.screenshot({ path: path.join(outputDir, 'delivery-filled-row-320.png') }); }
  }
  assert.deepEqual(exceptions.filter((message) => !message.includes('ViewTransition opt-in disabled')), []);
  console.log('DELIVERY BROWSER QA: PASS (create/error/reload/filter, pending status redraw, status lifecycle, 3 widths)');
} finally {
  await browser?.close();
  child.kill();
  if (child.exitCode === null) await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 3000))]);
}
