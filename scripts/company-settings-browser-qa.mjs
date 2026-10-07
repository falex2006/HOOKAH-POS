import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const packagePath = process.env.PLAYWRIGHT_PACKAGE_PATH;
if (!packagePath) throw new Error('Set PLAYWRIGHT_PACKAGE_PATH');
const { chromium } = createRequire(import.meta.url)(packagePath);
const child = spawn(process.execPath, ['server.js'], {
  cwd: fileURLToPath(new URL('../', import.meta.url)), windowsHide: true,
  env: { ...process.env, HOST: '127.0.0.1', PORT: '0', DATABASE_URL: '', AUTH_REQUIRED: 'false', DEMO_MODE: 'false', NODE_ENV: 'test' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stdout.on('data', (chunk) => { output += chunk; });
child.stderr.on('data', (chunk) => { output += chunk; });
let browser;
try {
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Company QA server did not start: ${output}`)), 15000);
    child.once('error', reject);
    child.stdout.on('data', () => {
      const match = output.match(/CRM running on http:\/\/localhost:(\d+)/);
      if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); }
    });
  });
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 375, height: 800 }, locale: 'ru-RU' });
  const exceptions = [];
  page.on('pageerror', (error) => exceptions.push(error.message));
  await page.goto(`${base}/login`, { waitUntil: 'networkidle' });
  await page.locator('#login-username').fill('admin');
  await page.locator('#login-password').fill('admin');
  await page.locator('#login-form button[type="submit"]').click();
  await page.waitForURL((url) => !url.pathname.includes('/login'));
  await page.goto(`${base}/admin#company`, { waitUntil: 'networkidle' });
  const form = page.locator('#company-form');
  await form.waitFor({ state: 'visible' });
  assert.equal(await page.locator('#company-timezone').inputValue(), 'Asia/Yekaterinburg');
  assert.equal(await page.locator('#company-timezone option').count(), 15);
  assert.match(await page.locator('#company-timezone').locator('xpath=..').locator('.custom-select-trigger').textContent(), /Свердловская/);
  await page.locator('#company-name').fill('QA Лаунж');
  await page.locator('#company-city').fill('Екатеринбург');
  await page.locator('#company-address').fill('Ленина, 1');
  await form.locator('[type="submit"]').click();
  await page.getByText('Данные компании сохранены').waitFor();
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(await page.locator('#company-name').inputValue(), 'QA Лаунж');
  assert.equal(await page.locator('#company-city').inputValue(), 'Екатеринбург');
  assert.equal(await page.locator('#company-address').inputValue(), 'Ленина, 1');
  await page.locator('#company-add-phone').click();
  await page.locator('#company-phone-list .company-phone-row').last().locator('input[type=tel]').fill('+7 (999) 123');
  await page.locator('#company-add-phone').click();
  assert.equal(await page.locator('#company-phone-list .company-phone-row').count(), 3);
  assert.equal(await page.locator('#company-phone-list .company-phone-row').nth(1).locator('input[type=tel]').inputValue(), '+7 (999) 123', 'adding a phone preserves unfinished draft');
  await page.locator('#company-phone-list .company-phone-row').first().locator('.staff-phone-row__remove').click();
  assert.equal(await page.locator('#company-phone-list .company-phone-row').first().locator('input[type=radio]').isChecked(), true, 'removing primary chooses remaining row');
  await page.reload({ waitUntil: 'networkidle' });
  await page.route('**/api/venue', (route) => route.request().method() === 'GET' ? route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"unavailable"}' }) : route.continue());
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByText('Не удалось загрузить данные заведения.').waitFor();
  assert.equal(await page.locator('#company-name').isDisabled(), true);
  assert.equal(await form.locator('[type="submit"]').isDisabled(), true);
  {
    const folder = fileURLToPath(new URL('../docs/ai-team/responsive-emulator/', import.meta.url));
    await mkdir(folder, { recursive: true });
    await page.locator('#company-message').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(folder, 'company-load-error-375.png') });
  }
  await page.unroute('**/api/venue');
  await page.getByRole('button', { name: 'Повторить загрузку' }).click();
  await page.waitForFunction(() => !document.querySelector('#company-name')?.disabled);
  assert.equal(await page.locator('#company-name').inputValue(), 'QA Лаунж');
  let releasePatch;
  const patchHeld = new Promise((resolve) => { releasePatch = resolve; });
  let patchStarted;
  const patchStartedPromise = new Promise((resolve) => { patchStarted = resolve; });
  await page.route('**/api/venue', async (route) => {
    if (route.request().method() !== 'PATCH') return route.continue();
    patchStarted();
    await patchHeld;
    return route.continue();
  });
  await page.locator('#company-city').fill('Тюмень QA');
  await form.locator('[type="submit"]').click();
  await patchStartedPromise;
  assert.equal(await page.locator('#company-name').isDisabled(), true);
  assert.equal(await page.locator('#company-timezone').locator('xpath=..').locator('.custom-select-trigger').isDisabled(), true);
  releasePatch();
  await page.getByText('Данные компании сохранены').waitFor();
  await page.unroute('**/api/venue');
  await page.route('**/api/venue', (route) => route.request().method() === 'PATCH' ? route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"unavailable"}' }) : route.continue());
  await page.locator('#company-city').fill('Екатеринбург QA');
  await form.locator('[type="submit"]').click();
  await page.getByText('Не удалось сохранить').waitFor();
  assert.equal(await page.locator('#company-city').isDisabled(), false);
  await page.unroute('**/api/venue');
  await form.locator('[type="submit"]').click();
  await page.getByText('Данные компании сохранены').waitFor();
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(await page.locator('#company-city').inputValue(), 'Екатеринбург QA');
  let releaseGet;
  const getHeld = new Promise((resolve) => { releaseGet = resolve; });
  await page.route('**/api/venue', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    await getHeld;
    return route.continue();
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#company-form').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#company-name').isDisabled(), true, 'delayed GET keeps fields locked');
  releaseGet();
  await page.waitForFunction(() => !document.querySelector('#company-name')?.disabled);
  assert.equal(await page.locator('#company-city').inputValue(), 'Екатеринбург QA');
  await page.unroute('**/api/venue');
  for (const width of [320, 375, 768, 1440]) {
    await page.setViewportSize({ width, height: 800 });
    await form.scrollIntoViewIfNeeded();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 1, `${width}px horizontal overflow: ${overflow}`);
    if (width === 320) {
      const folder = fileURLToPath(new URL('../docs/ai-team/responsive-emulator/', import.meta.url));
      await mkdir(folder, { recursive: true });
      await form.screenshot({ path: path.join(folder, 'company-filled-320.png') });
    }
  }
  await page.setViewportSize({ width: 375, height: 800 });
  const createdVenue = await page.evaluate(async () => {
    const response = await fetch('/api/network/venues', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'QA Вторая точка', city: 'Тюмень', address: 'QA адрес', timezone: 'Asia/Yekaterinburg' }) });
    return { status: response.status, body: await response.json() };
  });
  assert.equal(createdVenue.status, 201, JSON.stringify(createdVenue.body));
  const switchStatus = await page.evaluate(async (id) => (await fetch(`/api/network/venues/${id}/select`, { method: 'POST' })).status, createdVenue.body.id);
  assert.equal(switchStatus, 200);
  await page.locator('#company-name').fill('Не должно попасть во вторую точку');
  await form.locator('[type="submit"]').click();
  await page.getByText('Точка изменилась. Данные не сохранены для новой точки.').waitFor();
  await page.getByRole('button', { name: 'Загрузить актуальную карточку' }).click();
  await page.waitForFunction(() => document.querySelector('#company-name')?.value === 'QA Вторая точка');
  assert.equal(await page.locator('#company-name').isDisabled(), false);
  const secondVenue = await page.evaluate(async () => (await (await fetch('/api/venue')).json()));
  assert.equal(secondVenue.id, createdVenue.body.id);
  assert.equal(secondVenue.name, 'QA Вторая точка');
  assert.deepEqual(exceptions.filter((message) => !message.includes('ViewTransition opt-in disabled')), []);
  console.log('PASS company settings browser save/reload and 320/375/768/1440 widths');
} finally {
  await browser?.close();
  child.kill();
}
