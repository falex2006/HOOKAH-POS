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
    const timer = setTimeout(() => reject(new Error(`Sidebar QA server did not start: ${output}`)), 15000);
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
  const inventoryToggle = page.locator('[data-interface-toggle="inventory"]');
  const responsePromise = page.waitForResponse((response) => response.url().endsWith('/api/session/preferences') && response.request().method() === 'PATCH' && response.request().postData()?.includes('navigationVisibility'));
  await inventoryToggle.setChecked(false);
  const response = await responsePromise;
  assert.equal(response.status(), 200);
  assert.equal((await response.json()).preferences.navigationVisibility.inventory, false);
  assert.equal(await page.locator('.portal-sidebar [data-nav-group="inventory"]').isHidden(), true);
  const moduleResponsePromise = page.waitForResponse((item) => item.url().endsWith('/api/session/preferences') && item.request().method() === 'PATCH' && item.request().postData()?.includes('dashboardModules'));
  await page.locator('[data-dashboard-module-toggle="quick"]').setChecked(false);
  assert.equal((await (await moduleResponsePromise).json()).preferences.dashboardModules.quick, false);
  await page.goto(`${base}/admin`, { waitUntil: 'networkidle' });
  assert.equal(await page.locator('[data-dashboard-module="quick"]').first().isHidden(), true, 'saved preference hides dashboard module');
  await page.goto(`${base}/inventory?view=stock`, { waitUntil: 'networkidle' });
  assert.equal(await page.locator('.portal-sidebar [data-nav-group="inventory"]').isHidden(), true, 'stock route preserves hidden inventory group');
  await page.goto(`${base}/inventory?view=products`, { waitUntil: 'networkidle' });
  assert.equal(await page.locator('.portal-sidebar [data-nav-group="inventory"]').isHidden(), true, 'products route preserves hidden inventory group');
  await page.evaluate(() => { history.pushState({}, '', '/inventory?view=stock'); window.dispatchEvent(new PopStateEvent('popstate')); });
  await page.waitForURL((url) => url.searchParams.get('view') === 'stock');
  assert.equal(await page.locator('.portal-sidebar [data-nav-group="inventory"]').isHidden(), true, 'in-page inventory view change preserves hidden group');
  console.log('PASS interface sidebar preference across stock/products routes');
} finally {
  await browser?.close();
  child.kill();
}
