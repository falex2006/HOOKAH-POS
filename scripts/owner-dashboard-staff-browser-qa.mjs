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
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: 'ru-RU' });
  const errors = [], staffGets = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/staff' && request.method() === 'GET') staffGets.push(request.url()); });
  await page.goto(`${base}/login`, { waitUntil: 'networkidle' });
  await page.locator('#login-username').fill('owner');
  await page.locator('#login-password').fill('demo');
  await page.locator('#login-form button[type="submit"]').click();
  await page.waitForURL(url => !url.pathname.includes('/login'));
  await page.evaluate(async () => {
    const token = localStorage.getItem('crm_session_token');
    const response = await fetch('/api/session/preferences', { method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ dashboardModules: { staff: false } }) });
    if (!response.ok) throw new Error('Could not save legacy staff preference');
  });
  staffGets.length = 0;
  await page.goto(`${base}/admin`, { waitUntil: 'networkidle' });
  assert.equal(await page.locator('#staff').count(), 0, 'home must not build the staff panel');
  assert.equal(staffGets.length, 0, 'home must not request staff');
  assert.equal(await page.evaluate(() => typeof window.__refreshStaffList), 'undefined');
  const shots = path.resolve('tmp/owner-dashboard-qa');
  await mkdir(shots, { recursive: true });
  await page.screenshot({ path: path.join(shots, 'owner-home-desktop.png'), fullPage: true });
  await page.goto(`${base}/admin#staff`, { waitUntil: 'networkidle' });
  await page.locator('#staff').waitFor({ state: 'visible' });
  assert.ok(staffGets.length > 0, 'directory must still load staff');
  assert.equal(await page.locator('#staff [data-dashboard-module]').count(), 0);
  await page.locator('.staff-add-button').click();
  await page.locator('#staff-form').waitFor({ state: 'visible' });
  await page.locator('button[data-staff-drawer-close]').click();
  await page.locator('#staff-form').waitFor({ state: 'hidden' });
  await page.screenshot({ path: path.join(shots, 'owner-staff-desktop.png'), fullPage: true });
  await page.evaluate(() => { window.location.hash = '#permissions'; });
  await page.waitForLoadState('networkidle');
  await page.locator('[data-custom-role-create]').waitFor({ state: 'visible' });
  await page.evaluate(() => { window.location.hash = '#settings-dashboard-modules'; });
  await page.locator('#settings-dashboard-modules').waitFor({ state: 'visible' });
  await page.waitForLoadState('networkidle');
  assert.equal(await page.locator('[data-dashboard-module-toggle="staff"]').count(), 0);
  assert.equal(await page.locator('[data-interface-toggle="staff"]').count(), 1, 'staff navigation setting must remain');
  staffGets.length = 0;
  await page.evaluate(() => { window.location.hash = ''; });
  await page.locator('#staff').waitFor({ state: 'hidden' });
  await page.locator('.page-title h1').getByText('Обзор заведения', { exact: true }).waitFor();
  await page.waitForLoadState('networkidle');
  assert.equal(await page.locator('#staff').count(), 0);
  assert.equal(staffGets.length, 0);
  assert.deepEqual(errors, []);
  console.log('OWNER DASHBOARD STAFF DESKTOP QA: PASS (no home roster/GET; legacy preference; directory form; permissions; hash return; no JS errors)');
} finally {
  await browser?.close();
  child.kill();
}
