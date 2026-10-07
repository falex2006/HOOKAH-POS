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
  const timer = setTimeout(() => reject(new Error(`Integrations QA server did not start: ${output}`)), 15000);
  child.once('error', reject);
  child.stdout.on('data', () => { const match = output.match(/CRM running on http:\/\/localhost:(\d+)/); if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); } });
});
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 320, height: 700 }, locale: 'ru-RU' });
  const exceptions = [];
  page.on('pageerror', (error) => exceptions.push(error.message));
  await page.goto(`${base}/login`, { waitUntil: 'networkidle' });
  await page.locator('#login-username').fill('admin');
  await page.locator('#login-password').fill('admin');
  await page.locator('#login-form button[type="submit"]').click();
  await page.waitForURL((url) => !url.pathname.includes('/login'));
  const liveResponse = await page.evaluate(async () => {
    const response = await fetch('/api/integrations');
    return { status: response.status, body: await response.json() };
  });
  assert.equal(liveResponse.status, 200);
  assert.equal(liveResponse.body.telegram.enabled, false);
  let mode = 'disabled';
  await page.route('**/api/integrations', (route) => route.fulfill(mode === 'error'
    ? { status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'temporary_unavailable' }) }
    : { status: 200, contentType: 'application/json', body: JSON.stringify({ telegram: { enabled: mode === 'enabled' } }) }));
  const outputDir = path.resolve('docs/ai-team/responsive-emulator');
  await mkdir(outputDir, { recursive: true });
  for (const [scenario, status, note] of [
    ['disabled', 'В разработке', 'Настройка Telegram-бота пока недоступна.'],
    ['enabled', 'Подключено', 'Telegram-бот подключён и готов отправлять настроенные уведомления.'],
    ['error', 'Статус недоступен', 'Не удалось проверить состояние Telegram.'],
  ]) {
    mode = scenario;
    await page.goto(`${base}/integrations`, { waitUntil: 'networkidle' });
    await page.locator('#telegram-integration-status').getByText(status).waitFor();
    assert.equal(await page.locator('#telegram-integration-status').getAttribute('role'), 'status');
    assert.equal(await page.locator('#telegram-integration-status').getAttribute('aria-live'), 'polite');
    assert.equal(await page.locator('#telegram-integration-note').textContent(), note);
    assert.equal(await page.locator('.integrations-panel form,.integrations-panel button,.integrations-panel a').count(), 0, 'unavailable Telegram setup has no misleading action');
    for (const width of [320, 375, 768, 1440]) {
      await page.setViewportSize({ width, height: 800 });
      assert.equal(await page.locator('.integration-card').evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' ').length), 2, `integration card has two occupied columns at ${width}px`);
      assert.equal(await page.evaluate(() => { const main = document.querySelector('.portal-main'); const panel = document.querySelector('.integrations-panel'); return document.documentElement.scrollWidth > innerWidth + 1 || main.scrollWidth > main.clientWidth + 1 || panel.scrollWidth > panel.clientWidth + 1; }), false, `integration ${scenario} overflow at ${width}px`);
      if (width === 320 && scenario !== 'enabled') {
        await page.waitForTimeout(350);
        await page.locator('.integrations-panel').screenshot({ path: path.join(outputDir, `integrations-${scenario}-320.png`) });
      }
    }
  }
  assert.deepEqual(exceptions.filter((message) => !message.includes('ViewTransition opt-in disabled')), []);
  console.log('INTEGRATIONS BROWSER QA: PASS (planned/connected/error states, honest actions, 320/375/768/1440 widths)');
} finally {
  await browser?.close();
  child.kill();
  if (child.exitCode === null) await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 3000))]);
}
