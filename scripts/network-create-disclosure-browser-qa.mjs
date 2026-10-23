import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const playwrightPath = process.env.PLAYWRIGHT_PACKAGE_PATH;
if (!playwrightPath) throw new Error('Set PLAYWRIGHT_PACKAGE_PATH');
const { chromium } = createRequire(import.meta.url)(playwrightPath);
const root = fileURLToPath(new URL('../', import.meta.url));
const ownerPassword = `qa-owner-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const child = spawn(process.execPath, ['server.js'], {
  cwd: root, windowsHide: true,
  env: { ...process.env, HOST: '127.0.0.1', PORT: '0', DATABASE_URL: '', AUTH_REQUIRED: 'true', DEMO_MODE: 'false', NODE_ENV: 'test', DEMO_OWNER_PASSWORD: ownerPassword },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stdout.on('data', chunk => { output += chunk; });
child.stderr.on('data', chunk => { output += chunk; });
const base = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`Network disclosure QA server did not start: ${output}`)), 15000);
  child.once('error', reject);
  child.stdout.on('data', () => {
    const match = output.match(/CRM running on http:\/\/localhost:(\d+)/);
    if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); }
  });
});
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: 'ru-RU' });
  const errors = [];
  const posts = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/network/venues') posts.push(request.url()); });
  await page.goto(`${base}/login`, { waitUntil: 'networkidle' });
  await page.locator('#login-username').fill('owner');
  await page.locator('#login-password').fill(ownerPassword);
  await page.locator('#login-form button[type="submit"]').click();
  await page.waitForURL(url => !url.pathname.includes('/login'));
  await page.goto(`${base}/network`, { waitUntil: 'networkidle' });
  await page.locator('#network-count').waitFor({ timeout: 15000 });
  await page.waitForFunction(() => document.querySelector('#network-list')?.getAttribute('aria-busy') !== 'true');
  const countText = await page.locator('#network-count').innerText();
  const add = page.locator('#network-add-toggle');
  const panel = page.locator('#network-create-panel');
  if (countText.startsWith('0 ')) {
    assert.equal(await panel.isVisible(), true, 'empty network starts in the create flow');
  } else {
    assert.equal(await panel.isVisible(), false, 'creation form stays out of the way for a populated network');
  }
  await page.screenshot({ path: 'tmp/network-create-disclosure/network-desktop-collapsed.png', fullPage: true });
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const geometry = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, doc: document.documentElement.scrollWidth, main: document.querySelector('#page-content').scrollWidth }));
    assert.ok(geometry.doc <= geometry.viewport && geometry.main <= geometry.viewport, `no horizontal overflow at ${width}px: ${JSON.stringify(geometry)}`);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  if (!(await panel.isVisible())) {
    await add.click();
    await page.locator('#network-name').waitFor({ state: 'visible' });
    assert.equal(await add.getAttribute('aria-expanded'), 'true');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'network-name', 'open action moves focus to first field');
    await page.screenshot({ path: 'tmp/network-create-disclosure/network-desktop-open.png', fullPage: true });
    assert.match(await page.locator('#network-create-panel').innerText(), /\* — обязательное поле/);
    const desktopActions = await page.locator('.network-form-actions .button').evaluateAll(elements => elements.map(element => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; }));
    assert.equal(desktopActions.length, 2);
    assert.ok(Math.abs(desktopActions[0].y - desktopActions[1].y) <= 1, `desktop create/cancel actions share a row: ${JSON.stringify(desktopActions)}`);
    assert.ok(Math.abs(desktopActions[0].height - desktopActions[1].height) <= 1, 'desktop create/cancel actions share a height');
    for (const width of [768, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      const geometry = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, doc: document.documentElement.scrollWidth, form: document.querySelector('#network-create-panel').scrollWidth }));
      assert.ok(geometry.doc <= geometry.viewport && geometry.form <= geometry.viewport, `open form no overflow at ${width}px: ${JSON.stringify(geometry)}`);
      await page.screenshot({ path: `tmp/network-create-disclosure/network-open-${width}.png`, fullPage: true });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    const timezoneTrigger = page.locator('#network-timezone').locator('xpath=..').locator('.custom-select-trigger');
    const timezoneTextBox = await timezoneTrigger.evaluate(element => ({ scrollHeight: element.scrollHeight, clientHeight: element.clientHeight }));
    assert.ok(timezoneTextBox.scrollHeight <= timezoneTextBox.clientHeight + 1, `long timezone label remains fully visible: ${JSON.stringify(timezoneTextBox)}`);
    await page.locator('#network-form button[type=submit]').scrollIntoViewIfNeeded();
    const mobileActions = await page.locator('.network-form-actions .button').evaluateAll(elements => elements.map(element => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; }));
    assert.ok(mobileActions[0].y < mobileActions[1].y, 'mobile primary submit precedes cancel vertically');
    assert.ok(Math.abs(mobileActions[0].x - mobileActions[1].x) <= 1, 'mobile actions share a left edge');
    assert.ok(Math.abs(mobileActions[0].width - mobileActions[1].width) <= 1, 'mobile actions share a width');
    assert.ok(mobileActions.every(box => box.height >= 42), 'mobile actions have consistent touch height');
    await page.screenshot({ path: 'tmp/network-create-disclosure/network-footer-390.png' });
    const labels = await page.locator('#network-form label').allInnerTexts();
    assert.match(labels[0], /Название[\s\S]*\*/); assert.match(labels[3], /Необязательно/);
    await page.locator('#network-name').fill('QA draft that will be cancelled');
    await page.locator('#network-create-cancel').click();
    assert.equal(await panel.isVisible(), false, 'cancel closes form');
    assert.equal(await page.locator('#network-name').inputValue(), '', 'cancel discards local draft');
    assert.equal(posts.length, 0, 'cancel never posts');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'network-add-toggle', 'cancel restores focus to trigger');
    await add.click();
    const name = `QA Network ${Date.now()}`;
    await page.locator('#network-name').fill(name);
    await page.locator('#network-city').fill('Тюмень');
    await page.locator('#network-address').fill('QA, 1');
    await page.locator('#network-phone').fill('+7 912 345-67-89');
    const draft = await page.locator('#network-form').evaluate(form => Object.fromEntries(
      [...form.querySelectorAll('input, select')].map(field => [field.id, field.value])
    ));
    let failOnce = true;
    await page.route('**/api/network/venues', async route => {
      if (route.request().method() !== 'POST' || !failOnce) return route.continue();
      failOnce = false;
      await new Promise(resolve => setTimeout(resolve, 250));
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'service_unavailable' }) });
    });
    await page.locator('#network-form').evaluate(form => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      document.querySelector('#network-add-toggle').click();
      document.querySelector('#network-create-cancel').click();
    });
    assert.equal(await panel.isVisible(), true, 'pending save cannot hide the form');
    assert.equal(await panel.getAttribute('aria-busy'), 'true', 'pending save is announced');
    assert.equal(await add.isDisabled(), true, 'pending save disables the form toggle');
    assert.equal(await page.locator('#network-create-cancel').isDisabled(), true, 'pending save disables cancel');
    await page.getByText('Не удалось добавить точку. Попробуйте ещё раз', { exact: true }).waitFor();
    assert.equal(posts.length, 1, 'rapid repeated submit sends one pending request');
    assert.equal(await panel.isVisible(), true, 'failed save keeps the form open');
    assert.deepEqual(await page.locator('#network-form').evaluate(form => Object.fromEntries(
      [...form.querySelectorAll('input, select')].map(field => [field.id, field.value])
    )), draft, 'failed save retains every field');
    assert.equal(await page.locator('#network-form button[type=submit]').isEnabled(), true, 'failed save allows retry');
    assert.equal(await add.isEnabled(), true, 'failed save restores the form toggle');
    assert.equal(await page.locator('#network-create-cancel').isEnabled(), true, 'failed save restores cancel');
    await page.locator('#network-message').scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'tmp/network-create-disclosure/network-error-390.png' });
    await page.unroute('**/api/network/venues');
    await page.locator('#network-form button[type=submit]').click();
    await page.getByText('Точка добавлена', { exact: true }).waitFor();
    assert.equal(await panel.isVisible(), false, 'success closes create form');
    assert.equal(posts.length, 2, 'one failed attempt and one successful retry');
    assert.equal(await page.locator('.network-row').filter({ hasText: name }).count(), 1, 'created venue appears once after readback');
    const saved = (await page.request.get(`${base}/api/network/venues`)).ok();
    assert.equal(saved, true, 'readback endpoint remains available');
    await add.click();
    await page.locator('#network-name').fill('Черновик третьей точки');
    await page.locator('#network-city').fill('Екатеринбург');
    await page.locator('#network-address').fill('Черновик, 3');
    await page.locator('#network-timezone').selectOption('Europe/Moscow');
    const switchingDraft = await page.locator('#network-form').evaluate(form => Object.fromEntries(
      [...form.querySelectorAll('input, select')].map(field => [field.id, field.value])
    ));
    await page.locator('.network-row').filter({ hasText: name }).locator('.network-select').click();
    await page.waitForFunction(selectedName => [...document.querySelectorAll('.network-row')].some(row =>
      row.textContent.includes(selectedName) && row.textContent.includes('Текущая точка')
    ), name);
    assert.equal(await panel.isVisible(), true, 'switching venue keeps the open create form');
    assert.deepEqual(await page.locator('#network-form').evaluate(form => Object.fromEntries(
      [...form.querySelectorAll('input, select')].map(field => [field.id, field.value])
    )), switchingDraft, 'switching venue preserves an explicitly selected timezone and all draft fields');
    await page.screenshot({ path: 'tmp/network-create-disclosure/network-draft-after-switch-390.png' });
    await page.locator('#network-create-cancel').click();
    assert.equal(posts.length, 2, 'switching and cancelling a draft never create another venue');
    let emptyListOnce = true;
    await page.route('**/api/network/venues', route => {
      if (route.request().method() === 'GET' && emptyListOnce) {
        emptyListOnce = false;
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [] }) });
      }
      return route.continue();
    });
    await page.goto(`${base}/network`, { waitUntil: 'networkidle' });
    const emptyPanel = page.locator('#network-create-panel');
    assert.equal(await emptyPanel.isVisible(), true, 'empty GET opens onboarding form');
    assert.match(await page.locator('#network-count').innerText(), /^0 точек$/);
    for (const width of [320, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      const geometry = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, doc: document.documentElement.scrollWidth, form: document.querySelector('#network-create-panel').scrollWidth }));
      assert.ok(geometry.doc <= geometry.viewport && geometry.form <= geometry.viewport, `empty onboarding has no overflow at ${width}px: ${JSON.stringify(geometry)}`);
      await page.screenshot({ path: `tmp/network-create-disclosure/network-empty-${width}.png` });
    }
    await page.locator('#network-name').fill('QA из пустого экрана');
    await page.locator('#network-city').fill('Тюмень');
    await page.locator('#network-address').fill('QA, 2');
    await page.locator('#network-form button[type=submit]').click();
    await page.getByText('Точка добавлена', { exact: true }).waitFor();
    assert.equal(await emptyPanel.isVisible(), false, 'onboarding form closes after a successful create');
    assert.equal(await page.locator('.network-row').filter({ hasText: 'QA из пустого экрана' }).count(), 1, 'created venue appears after real API readback');
    await page.unroute('**/api/network/venues');
  } else {
    await page.locator('#network-create-cancel').click();
    assert.equal(await panel.isVisible(), false);
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'PASS', initialCount: countText, widths: [320, 390, 768, 1440], createRequests: posts.length, pageErrors: errors, screenshots: 'tmp/network-create-disclosure/' }));
} finally {
  await browser?.close();
  child.kill();
}
