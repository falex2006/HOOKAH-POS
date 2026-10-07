import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const playwrightPath = process.env.PLAYWRIGHT_PACKAGE_PATH;
if (!playwrightPath) throw new Error('Set PLAYWRIGHT_PACKAGE_PATH to the installed Playwright package directory');
const { chromium } = createRequire(import.meta.url)(playwrightPath);
let qaServer;
let base = process.env.CRM_QA_URL || '';
if (!base) {
  let output = '';
  qaServer = spawn(process.execPath, ['server.js'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), windowsHide: true,
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', DATABASE_URL: '', AUTH_REQUIRED: 'false', DEMO_MODE: 'false', NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  qaServer.stdout.on('data', (chunk) => { output += chunk; });
  qaServer.stderr.on('data', (chunk) => { output += chunk; });
  base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Responsive QA server did not start: ${output}`)), 15000);
    qaServer.once('error', reject);
    qaServer.stdout.on('data', () => {
      const match = output.match(/CRM running on http:\/\/localhost:(\d+)/);
      if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); }
    });
  });
}
const outputDir = path.resolve('docs/ai-team/responsive-emulator');
await mkdir(outputDir, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
const context = await browser.newContext({ viewport: { width: 320, height: 568 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1, locale: 'ru-RU' });
const page = await context.newPage();
const failures = [];
try {
  await page.goto(`${base}/login`, { waitUntil: 'networkidle' });
  await page.locator('#login-username').fill('admin');
  await page.locator('#login-password').fill('admin');
  await page.locator('#login-form button[type="submit"]').click();
  try { await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 10000 }); }
  catch (error) { throw new Error(`QA login failed: ${await page.locator('#login-message').textContent()}, url=${page.url()}`, { cause: error }); }
  const api = async (route, method, data, expected = 201) => {
    const response = await context.request.fetch(`${base}${route}`, { method, data });
    const payload = await response.json();
    assert.equal(response.status(), expected, `${method} ${route}: ${JSON.stringify(payload)}`);
    return payload;
  };
  const currentShift = await api('/api/shifts', 'GET', undefined, 200);
  if (!currentShift.current) await api('/api/shifts', 'POST', { openingCash: 0 });
  const floor = await api('/api/floor', 'GET', undefined, 200);
  const zone = floor.zones?.[0] || await api('/api/floor/zones', 'POST', { expectedVenueId: floor.venueId, name: 'Зал Responsive QA' });
  const table = await api('/api/floor/tables', 'POST', { expectedVenueId: floor.venueId, zoneId: zone.id, name: 'Стол Responsive QA', capacity: 2 });
  const product = await api('/api/products', 'POST', { name: 'Responsive QA service', category: 'Услуги', price: 100, inventoryMode: 'non_stock' });
  const order = await api('/api/orders', 'POST', { tableId: table.id });
  await api(`/api/orders/${order.id}/items`, 'POST', { productId: product.id, quantity: 2 });
  await api(`/api/orders/${order.id}/payments`, 'POST', { amount: 50, method: 'cash' });
  const sizes = [
    ['mobile-320', 320, 568], ['mobile-360', 360, 800], ['mobile-375', 375, 812],
    ['mobile-390', 390, 844], ['mobile-412', 412, 915], ['mobile-430', 430, 932],
    ['mobile-480', 480, 800], ['mobile-650', 650, 800], ['tablet-651', 651, 800],
    ['fold-main-768', 768, 1024], ['tablet-820', 820, 1180], ['tablet-1024', 1024, 1366],
    ['laptop-1280', 1280, 720], ['laptop-1366', 1366, 768], ['laptop-1440', 1440, 900],
    ['desktop-1920', 1920, 1080], ['qhd-2560', 2560, 1440], ['ultrawide-3440', 3440, 1440], ['4k-3840', 3840, 2160],
  ];
  for (const route of ['/admin', '/orders', '/']) {
    await page.goto(`${base}${route}`, { waitUntil: 'networkidle' });
    const slug = route === '/' ? 'pos' : route.slice(1);
    if (slug === 'pos') {
      await page.locator(`.table[data-table="${table.id}"]`).click();
      assert.match(await page.locator('#order-total').textContent(), /200/, 'filled POS order shows its total');
    }
    for (const [label, width, height] of sizes) {
      await page.setViewportSize({ width, height });
      if (slug !== 'pos' && width <= 900) {
        await page.waitForFunction(() => {
          const sidebar = document.querySelector('.portal-sidebar');
          return !sidebar || sidebar.classList.contains('is-expanded') || sidebar.getBoundingClientRect().right <= 1;
        }, null, { timeout: 1500 });
      }
      const result = await page.evaluate(() => ({
        path: location.pathname,
        width: innerWidth,
        height: innerHeight,
        documentWidth: document.documentElement.scrollWidth,
        bodyWidth: document.body.scrollWidth,
        title: document.title,
      }));
      if (result.path === '/login' || result.documentWidth > width + 1 || result.bodyWidth > width + 1) failures.push({ route, label, ...result });
      if (slug === 'pos' && width <= 420) {
        const title = await page.locator('main > header > div:first-child > b').evaluate((node) => ({
          text: node.textContent?.trim(), whiteSpace: getComputedStyle(node).whiteSpace,
          width: node.clientWidth, scrollWidth: node.scrollWidth,
          height: node.clientHeight, scrollHeight: node.scrollHeight,
        }));
        if (title.whiteSpace !== 'normal' || title.scrollWidth > title.width + 1 || title.scrollHeight > title.height + 3) failures.push({ route, label, title });
      }
      if (['mobile-320', 'fold-main-768', 'desktop-1920', 'qhd-2560'].includes(label)) {
        await page.screenshot({ path: path.join(outputDir, `${slug}-${label}.png`), fullPage: false });
      }
      console.log(`${slug} ${label}: ${result.width}x${result.height}, document=${result.documentWidth}, body=${result.bodyWidth}, path=${result.path}`);
    }
    for (let width = 320; width <= 1024; width += 17) {
      await page.setViewportSize({ width, height: 800 });
      const measured = await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth));
      if (measured > width + 1) failures.push({ route, label: `continuous-${width}`, documentWidth: measured, width });
    }
  }
  await page.goto(`${base}/`, { waitUntil: 'networkidle' });
  await page.locator(`.table[data-table="${table.id}"]`).click();
  await page.setViewportSize({ width: 320, height: 568 });
  await page.locator('#split-payment').click();
  assert.equal(await page.locator('#payment-modal').isVisible(), true, 'payment dialog opens for partially paid order');
  await page.waitForFunction(() => /150/.test(document.querySelector('#payment-remaining')?.textContent || ''), null, { timeout: 5000 });
  assert.match(await page.locator('#payment-remaining').textContent(), /150/, 'payment dialog shows remaining 150');
  const paymentGeometry = await page.locator('#payment-form').evaluate((form) => {
    const rect = form.getBoundingClientRect();
    const close = form.querySelector('#payment-close').getBoundingClientRect();
    const submit = form.querySelector('button[type="submit"]').getBoundingClientRect();
    const topmost = document.elementFromPoint(close.left + close.width / 2, close.top + close.height / 2);
    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
      clientHeight: form.clientHeight, scrollHeight: form.scrollHeight,
      closeTopmost: form.contains(topmost), submitTop: submit.top, submitBottom: submit.bottom };
  });
  assert.ok(paymentGeometry.left >= 0 && paymentGeometry.right <= 320 && paymentGeometry.top >= 0 && paymentGeometry.bottom <= 568,
    `payment dialog fits viewport: ${JSON.stringify(paymentGeometry)}`);
  assert.equal(paymentGeometry.closeTopmost, true, 'payment close control is above sidebar and header');
  assert.ok(paymentGeometry.scrollHeight > paymentGeometry.clientHeight, 'short phone can scroll all payment fields and submit');
  await page.screenshot({ path: path.join(outputDir, 'pos-payment-mobile-320.png'), fullPage: false });
  await page.locator('#payment-form button[type="submit"]').scrollIntoViewIfNeeded();
  assert.equal(await page.locator('#payment-form button[type="submit"]').isVisible(), true, 'payment submit remains reachable');
  await page.screenshot({ path: path.join(outputDir, 'pos-payment-mobile-320-scrolled.png'), fullPage: false });
  await page.setViewportSize({ width: 768, height: 1024 });
  assert.match(await page.locator('#payment-remaining').textContent(), /150/, 'Fold expand preserves payment balance');
  await page.screenshot({ path: path.join(outputDir, 'pos-payment-fold-main-768.png'), fullPage: false });
  await page.setViewportSize({ width: 320, height: 568 });
  assert.match(await page.locator('#payment-remaining').textContent(), /150/, 'Fold collapse preserves payment balance');
  await page.goto(`${base}/admin`, { waitUntil: 'networkidle' });
  await page.setViewportSize({ width: 375, height: 812 });
  const dateField = page.locator('input[type="date"]:visible').first();
  assert.equal(await dateField.count(), 1, 'dashboard exposes a date field for Fold state preservation');
  await dateField.fill('2026-09-29');
  await page.setViewportSize({ width: 768, height: 1024 });
  assert.equal(await dateField.inputValue(), '2026-09-29', 'Fold expand preserves selected date');
  await page.setViewportSize({ width: 375, height: 812 });
  assert.equal(await dateField.inputValue(), '2026-09-29', 'Fold collapse preserves selected date');
  const drawerToggle = page.locator('.sidebar-mobile-toggle');
  await drawerToggle.tap();
  assert.equal(await drawerToggle.getAttribute('aria-expanded'), 'true', 'touch opens mobile drawer');
  await page.setViewportSize({ width: 1024, height: 768 });
  assert.equal(await drawerToggle.getAttribute('aria-expanded'), 'false', 'drawer closes when unfolding across its breakpoint');
  await page.setViewportSize({ width: 375, height: 812 });
  assert.equal(await dateField.inputValue(), '2026-09-29', 'return to cover preserves selected date');
  assert.deepEqual(failures, [], `Responsive failures: ${JSON.stringify(failures)}`);
  console.log(`RESPONSIVE EMULATOR QA: PASS (touch drawer, state transition, ${sizes.length} viewports, 3 routes)`);
} finally {
  await context.request.post(`${base}/api/logout`).catch(() => {});
  await browser.close();
  qaServer?.kill();
}
