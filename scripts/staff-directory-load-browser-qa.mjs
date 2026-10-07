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
let browser;
try {
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Staff QA server did not start: ${output}`)), 15000);
    child.once('error', reject);
    child.stdout.on('data', () => { const match = output.match(/CRM running on http:\/\/localhost:(\d+)/); if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); } });
  });
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 375, height: 800 }, locale: 'ru-RU' });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${base}/login`, { waitUntil: 'networkidle' });
  await page.locator('#login-username').fill('admin');
  await page.locator('#login-password').fill('admin');
  await page.locator('#login-form button[type="submit"]').click();
  await page.waitForURL((url) => !url.pathname.includes('/login'));
  let mode = 'error';
  let postCount = 0;
  let delayedRoute;
  let delayedSeen;
  let resolveDelayedSeen;
  let delayedPost;
  let postSeen;
  let resolvePostSeen;
  let raceGetCount = 0;
  await page.route('**/api/staff', (route) => {
    if (route.request().method() === 'POST') { ++postCount; if (mode === 'mutation-race') { delayedPost = route; resolvePostSeen(); return; } return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 'qa-created' }) }); }
    if (['race', 'mutation-race'].includes(mode) && ++raceGetCount === 1) { delayedRoute = route; resolveDelayedSeen(); return; }
    return route.fulfill(['error', 'post-get-error'].includes(mode)
      ? { status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'temporary_unavailable' }) }
      : { status: 200, contentType: 'application/json', body: JSON.stringify({ items: [{ id: 'qa-staff', name: mode === 'race' ? 'Свежий сотрудник' : mode === 'mutation-race' ? 'Сотрудник после сохранения' : 'Тестовый сотрудник', role: 'manager', active: true }] }) });
  });
  await page.goto(`${base}/admin#staff`, { waitUntil: 'networkidle' });
  await page.locator('#staff-list [role="alert"] .staff-list-retry').waitFor();
  const screenshotDir = path.resolve('docs/ai-team/responsive-emulator');
  await mkdir(screenshotDir, { recursive: true });
  await page.setViewportSize({ width: 320, height: 800 });
  await page.waitForTimeout(5500);
  await page.locator('#staff').screenshot({ path: path.join(screenshotDir, 'staff-load-error-320.png') });
  assert.equal(await page.locator('#staff-list .staff-card').count(), 0);
  assert.equal(await page.locator('[data-metric="staffActive"]').textContent(), '—');
  mode = 'success';
  await page.locator('.staff-list-retry').click();
  await page.locator('#staff-list .staff-card').getByText('Тестовый сотрудник').waitFor();
  assert.equal(await page.locator('#staff-list .staff-card').count(), 1);
  assert.equal(await page.locator('#staff-list .staff-list-retry').count(), 0);
  mode = 'post-get-error';
  await page.locator('.staff-add-button').click();
  await page.locator('#staff-name').fill('Новый сотрудник');
  await page.locator('#staff-birth-date').fill('2000-01-01');
  await page.locator('#staff-role').selectOption('cleaner');
  await page.locator('#staff-form button[type="submit"]').click();
  await page.locator('#staff-list .staff-list-retry').waitFor();
  assert.equal(postCount, 1);
  assert.equal(await page.locator('#staff-message').textContent(), 'Сотрудник создан');
  assert.equal(await page.locator('#staff-list .staff-card').count(), 0);
  mode = 'success';
  await page.locator('.staff-list-retry').click();
  await page.locator('#staff-list .staff-card').getByText('Тестовый сотрудник').waitFor();
  for (const width of [320, 375, 768, 1440]) {
    await page.setViewportSize({ width, height: 800 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1 || document.querySelector('.portal-main').scrollWidth > document.querySelector('.portal-main').clientWidth + 1), false, `staff directory overflow at ${width}px`);
    if (width === 320) { await page.waitForTimeout(5500); await page.locator('#staff').screenshot({ path: path.join(screenshotDir, 'staff-filled-320.png') }); }
  }
  mode = 'race';
  delayedSeen = new Promise((resolve) => { resolveDelayedSeen = resolve; });
  await page.evaluate(() => { void window.__refreshStaffList(); });
  await delayedSeen;
  await page.evaluate(() => { void window.__refreshStaffList(); });
  await page.locator('#staff-list .staff-card').getByText('Свежий сотрудник').waitFor();
  await delayedRoute.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [{ id: 'qa-old', name: 'Устаревший сотрудник', role: 'bartender', active: true }] }) });
  await page.waitForTimeout(100);
  assert.equal(await page.locator('#staff-list').getByText('Устаревший сотрудник').count(), 0);
  assert.equal(await page.locator('#staff-list').getByText('Свежий сотрудник').count(), 1);
  mode = 'mutation-race';
  raceGetCount = 0;
  delayedSeen = new Promise((resolve) => { resolveDelayedSeen = resolve; });
  postSeen = new Promise((resolve) => { resolvePostSeen = resolve; });
  await page.evaluate(() => { void window.__refreshStaffList(); });
  await delayedSeen;
  await page.locator('.staff-add-button').click();
  await page.locator('#staff-name').fill('Сотрудник во время запроса');
  await page.locator('#staff-birth-date').fill('2000-01-01');
  await page.locator('#staff-role').selectOption('cleaner');
  await page.locator('#staff-form button[type="submit"]').click();
  await postSeen;
  await delayedRoute.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [{ id: 'qa-old', name: 'Устаревший сотрудник', role: 'bartender', active: true }] }) });
  await page.waitForTimeout(100);
  assert.equal(await page.locator('#staff-list').getByText('Устаревший сотрудник').count(), 0, 'pre-mutation GET cannot paint during POST');
  await delayedPost.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 'qa-created-two' }) });
  await page.locator('#staff-list').getByText('Сотрудник после сохранения').waitFor();
  assert.equal(postCount, 2);
  await page.setViewportSize({ width: 320, height: 800 });
  await page.locator('.staff-add-button').click();
  assert.equal(await page.locator('.staff-drawer-panel').evaluate((node) => node.scrollWidth > node.clientWidth + 1), false, 'open staff drawer fits 320px');
  assert.equal(await page.locator('#staff-name').evaluate((node) => document.activeElement === node), true, 'drawer focuses name');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.staff-drawer').getAttribute('aria-hidden'), 'true');
  assert.equal(await page.locator('.staff-add-button').evaluate((node) => document.activeElement === node), true, 'closing drawer restores focus');
  await page.locator('.staff-add-button').click();
  await page.evaluate(() => { const NativeReader = window.FileReader; window.FileReader = class extends NativeReader { readAsDataURL(file) { setTimeout(() => super.readAsDataURL(file), 500); } }; });
  await page.locator('#staff-photo').setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==', 'base64') });
  assert.equal(await page.locator('#staff-form button[type="submit"]').isDisabled(), true, 'submit waits for selected photo');
  await page.waitForFunction(() => !document.querySelector('#staff-form button[type="submit"]').disabled);
  assert.equal(await page.locator('#staff-form').getAttribute('data-photo').then((value) => value.startsWith('data:image/png')), true);
  await page.locator('#staff-form button[type="submit"]').focus();
  await page.keyboard.press('Tab');
  assert.equal(await page.locator('.staff-drawer-close').evaluate((node) => document.activeElement === node), true, 'Tab wraps inside drawer');
  await page.locator('.staff-drawer-panel').screenshot({ path: path.join(screenshotDir, 'staff-form-open-320.png') });
  await page.locator('.staff-drawer-close').click();
  assert.deepEqual(errors.filter((message) => !message.includes('ViewTransition opt-in disabled')), []);
  console.log('STAFF DIRECTORY LOAD BROWSER QA: PASS (GET failure/retry, POST/GET boundary, 320/375/768/1440, read races, drawer focus and photo pending)');
} finally {
  await browser?.close();
  child.kill();
  if (child.exitCode === null) await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 3000))]);
}
