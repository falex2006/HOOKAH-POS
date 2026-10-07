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
    const timer = setTimeout(() => reject(new Error(`Settings QA server did not start: ${output}`)), 15000);
    child.once('error', reject);
    child.stdout.on('data', () => {
      const match = output.match(/CRM running on http:\/\/localhost:(\d+)/);
      if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); }
    });
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
  const created = await page.evaluate(async () => {
    const response = await fetch('/api/staff', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'QA Управляющий настройками', role: 'manager', login: 'qa_settings_manager', password: 'qa1234', birthDate: '1995-04-10' }) });
    return { status: response.status, body: await response.json() };
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const managerPage = await browser.newPage({ viewport: { width: 375, height: 800 }, locale: 'ru-RU' });
  await managerPage.goto(`${base}/login`, { waitUntil: 'networkidle' });
  await managerPage.locator('#login-username').fill('qa_settings_manager');
  await managerPage.locator('#login-password').fill('qa1234');
  await managerPage.locator('#login-form button[type="submit"]').click();
  await managerPage.waitForURL((url) => !url.pathname.includes('/login'));
  await managerPage.goto(`${base}/admin#settings-dashboard-modules`, { waitUntil: 'networkidle' });
  await managerPage.locator('#settings-dashboard-modules').waitFor({ state: 'visible' });
  assert.equal(await managerPage.locator('[data-interface-toggle="delivery"]').count(), 0, 'manager cannot configure unavailable delivery');
  assert.equal(await managerPage.locator('[data-interface-toggle="integrations"]').count(), 0, 'manager cannot configure unavailable integrations');
  assert.equal(await managerPage.locator('.portal-sidebar a[href="/delivery"]').isHidden(), true);
  assert.equal(await managerPage.locator('.portal-sidebar a[href="/integrations"]').isHidden(), true);
  await managerPage.close();
  const invalidTheme = await page.evaluate(async () => (await fetch('/api/session/preferences', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ theme: 'purple' }) })).status);
  assert.equal(invalidTheme, 400);
  const invalidMenu = await page.evaluate(async () => (await fetch('/api/session/preferences', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ navigationVisibility: { staff: 'yes' } }) })).status);
  assert.equal(invalidMenu, 400);
  await page.goto(`${base}/admin#settings-dashboard-modules`, { waitUntil: 'networkidle' });
  const settings = page.locator('#settings-dashboard-modules');
  await settings.waitFor({ state: 'visible' });
  const changeAndRead = async (locator, checked, key) => {
    const responsePromise = page.waitForResponse((response) => response.url().endsWith('/api/session/preferences') && response.request().method() === 'PATCH' && response.request().postData()?.includes(`"${key}"`));
    await locator.setChecked(checked);
    const response = await responsePromise;
    assert.equal(response.status(), 200, `${key} PATCH status`);
    return (await response.json()).preferences;
  };
  const theme = settings.locator('[data-theme-toggle]');
  const initialTheme = await theme.isChecked();
  const themePreferences = await changeAndRead(theme, !initialTheme, 'theme');
  await page.waitForFunction((expected) => document.body.classList.contains('light-theme') === expected, !initialTheme);
  const serverPreferences = async () => page.evaluate(async () => (await (await fetch('/api/session/preferences', { credentials: 'include' })).json()).preferences);
  assert.equal(themePreferences.theme, initialTheme ? 'dark' : 'light', 'theme must persist on server');
  const moduleToggle = settings.locator('[data-dashboard-module-toggle="quick"]');
  assert.equal((await changeAndRead(moduleToggle, false, 'dashboardModules')).dashboardModules.quick, false);
  const financeToggle = settings.locator('[data-finance-metric-toggle="median"]');
  assert.equal((await changeAndRead(financeToggle, false, 'financeMetrics')).financeMetrics.median, false);
  const staffMenuToggle = settings.locator('[data-interface-toggle="staff"]');
  assert.equal((await changeAndRead(staffMenuToggle, false, 'navigationVisibility')).navigationVisibility.staff, false);
  const staffMenuLink = page.locator('.portal-sidebar a[href="/admin#staff"]');
  assert.equal(await staffMenuLink.isHidden(), true);
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(await theme.isChecked(), !initialTheme, 'theme survives reload');
  assert.equal(await moduleToggle.isChecked(), false);
  assert.equal(await financeToggle.isChecked(), false);
  assert.equal(await staffMenuToggle.isChecked(), false);
  await page.goto(`${base}/admin#staff`, { waitUntil: 'networkidle' });
  assert.equal(await staffMenuLink.isHidden(), true, 'menu preference survives dashboard hash navigation');
  await page.goto(`${base}/admin#settings-dashboard-modules`, { waitUntil: 'networkidle' });
  assert.equal(await staffMenuToggle.isChecked(), false);
  await page.setViewportSize({ width: 320, height: 800 });
  await settings.scrollIntoViewIfNeeded();
  {
    const folder = fileURLToPath(new URL('../docs/ai-team/responsive-emulator/', import.meta.url));
    await mkdir(folder, { recursive: true });
    await page.screenshot({ path: path.join(folder, 'interface-settings-page-320.png') });
  }
  await page.setViewportSize({ width: 375, height: 800 });
  const stalePreferences = await serverPreferences();
  let releaseReads;
  const readsHeld = new Promise((resolve) => { releaseReads = resolve; });
  await page.route('**/api/session/preferences', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    await readsHeld;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ preferences: stalePreferences }) });
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await settings.waitFor({ state: 'visible' });
  assert.equal((await changeAndRead(moduleToggle, true, 'dashboardModules')).dashboardModules.quick, true);
  releaseReads();
  await page.waitForTimeout(200);
  await page.unroute('**/api/session/preferences');
  assert.equal(await moduleToggle.isChecked(), true, 'late GET must not overwrite local change');
  await page.route('**/api/session/preferences', (route) => route.request().method() === 'PATCH' ? route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"preferences_save_failed"}' }) : route.continue());
  const failedChange = async (locator, checked, selector, restored) => {
    const responsePromise = page.waitForResponse((response) => response.url().endsWith('/api/session/preferences') && response.request().method() === 'PATCH');
    await locator.setChecked(checked);
    assert.equal((await responsePromise).status(), 503);
    await page.waitForFunction(({ selector, restored }) => document.querySelector(selector)?.checked === restored, { selector, restored });
  };
  await failedChange(financeToggle, true, '[data-finance-metric-toggle="median"]', false);
  await page.getByText('Не удалось сохранить выбор финансовых показателей. Повторите изменение.').waitFor();
  assert.equal((await serverPreferences()).financeMetrics.median, false, 'failed finance choice stays unchanged on server');
  await failedChange(moduleToggle, false, '[data-dashboard-module-toggle="quick"]', true);
  assert.equal((await serverPreferences()).dashboardModules.quick, true, 'failed dashboard choice stays unchanged on server');
  await failedChange(staffMenuToggle, true, '[data-interface-toggle="staff"]', false);
  assert.equal(await staffMenuLink.isHidden(), true, 'failed menu choice must keep the link hidden');
  await failedChange(theme, initialTheme, '[data-theme-toggle]', !initialTheme);
  assert.equal(await page.evaluate(() => document.body.classList.contains('light-theme')), !initialTheme, 'failed theme choice must restore appearance');
  const storedAfterFailure = await page.evaluate(() => ({ finance: Object.values(localStorage).filter((value) => value.includes('"median"')).some((value) => JSON.parse(value).median === false), theme: Object.keys(localStorage).filter((key) => key.includes('theme')).map((key) => localStorage.getItem(key)) }));
  assert.equal(storedAfterFailure.finance, true, 'failed finance choice must restore local cache');
  await page.unroute('**/api/session/preferences');
  assert.equal((await changeAndRead(financeToggle, true, 'financeMetrics')).financeMetrics.median, true);
  let financePatchCount = 0;
  await page.route('**/api/session/preferences', (route) => {
    if (route.request().method() !== 'PATCH' || !route.request().postData()?.includes('financeMetrics')) return route.continue();
    financePatchCount += 1;
    return financePatchCount === 2 ? route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"preferences_save_failed"}' }) : route.continue();
  });
  const firstQueuedPatch = page.waitForResponse((response) => response.url().endsWith('/api/session/preferences') && response.request().method() === 'PATCH' && response.status() === 200);
  const secondQueuedPatch = page.waitForResponse((response) => response.url().endsWith('/api/session/preferences') && response.request().method() === 'PATCH' && response.status() === 503);
  await financeToggle.setChecked(false);
  await financeToggle.setChecked(true);
  await firstQueuedPatch;
  await secondQueuedPatch;
  await page.waitForFunction(() => document.querySelector('[data-finance-metric-toggle="median"]')?.checked === false);
  assert.equal((await serverPreferences()).financeMetrics.median, false, 'failed later queued choice restores prior committed choice');
  await page.unroute('**/api/session/preferences');
  await page.route('**/api/session/preferences', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"preferences_unavailable"}' }));
  await financeToggle.setChecked(true);
  await page.getByText('Не удалось сохранить выбор финансовых показателей. Повторите изменение. Не удалось проверить состояние на сервере.').waitFor();
  assert.equal(await financeToggle.isChecked(), false, 'double 503 restores the last confirmed choice');
  await page.setViewportSize({ width: 320, height: 800 });
  await settings.scrollIntoViewIfNeeded();
  {
    const folder = fileURLToPath(new URL('../docs/ai-team/responsive-emulator/', import.meta.url));
    await mkdir(folder, { recursive: true });
    await page.screenshot({ path: path.join(folder, 'interface-settings-error-320.png') });
  }
  await page.setViewportSize({ width: 375, height: 800 });
  await page.unroute('**/api/session/preferences');
  assert.equal((await serverPreferences()).financeMetrics.median, false);
  await page.route('**/api/session/preferences', (route) => route.request().method() === 'GET' ? route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"preferences_unavailable"}' }) : route.continue());
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByText('Не удалось загрузить настройки с сервера. Показаны локальные значения; обновите страницу после восстановления связи.').waitFor();
  await page.unroute('**/api/session/preferences');
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(await financeToggle.isChecked(), false, 'settings recover from initial GET failure after reload');
  for (const width of [320, 375, 768, 1440]) {
    await page.setViewportSize({ width, height: 800 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    assert.ok(overflow <= 1, `${width}px overflow ${overflow}`);
    if (width === 320) {
      const folder = fileURLToPath(new URL('../docs/ai-team/responsive-emulator/', import.meta.url));
      await mkdir(folder, { recursive: true });
      assert.equal(await page.evaluate(() => innerWidth), 320);
      await settings.scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(folder, 'interface-settings-restored-320.png') });
    }
  }
  assert.deepEqual(errors.filter((message) => !message.includes('ViewTransition opt-in disabled')), []);
  console.log('PASS interface preferences theme/module persistence and 320/375/768/1440 widths');
} finally {
  await browser?.close();
  child.kill();
}
