import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

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
    const timer = setTimeout(() => reject(new Error(`Session QA server did not start: ${output}`)), 15000);
    child.once('error', reject);
    child.stdout.on('data', () => {
      const match = output.match(/CRM running on http:\/\/localhost:(\d+)/);
      if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); }
    });
  });
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 375, height: 800 }, locale: 'ru-RU' });
  await page.goto(`${base}/login`, { waitUntil: 'networkidle' });
  await page.locator('#login-username').fill('admin');
  await page.locator('#login-password').fill('admin');
  await page.locator('#login-form button[type="submit"]').click();
  await page.waitForURL((url) => !url.pathname.includes('/login'));
  await page.goto(`${base}/admin#settings-dashboard-modules`, { waitUntil: 'networkidle' });
  await page.locator('#settings-dashboard-modules').waitFor({ state: 'visible' });
  let requestCount = 0;
  page.on('request', (request) => { if (request.url().endsWith('/api/session/preferences') && request.method() === 'PATCH') requestCount++; });
  let releaseFirst;
  const firstHeld = new Promise((resolve) => { releaseFirst = resolve; });
  let firstStarted;
  const firstStartedPromise = new Promise((resolve) => { firstStarted = resolve; });
  await page.route('**/api/session/preferences', async (route) => {
    if (route.request().method() !== 'PATCH') return route.continue();
    firstStarted();
    await firstHeld;
    return route.continue();
  });
  await page.locator('[data-theme-toggle]').setChecked(true);
  await firstStartedPromise;
  await page.locator('[data-dashboard-module-toggle="quick"]').setChecked(false);
  await page.evaluate(() => localStorage.setItem('crm_session_token', 'qa-replacement-session'));
  releaseFirst();
  await page.waitForTimeout(300);
  assert.equal(requestCount, 1, 'queued old-user preference must not dispatch with replacement session');
  assert.equal(await page.getByText('Не удалось сохранить блоки главной. Повторите изменение.').count(), 0, 'old-user failure must not show a notice in a replacement session');
  console.log('PASS queued preference rejected after session switch');
} finally {
  await browser?.close();
  child.kill();
}
