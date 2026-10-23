import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

if (!process.env.PLAYWRIGHT_PACKAGE_PATH) throw new Error('Set PLAYWRIGHT_PACKAGE_PATH');
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_PACKAGE_PATH);
const root = fileURLToPath(new URL('../', import.meta.url));
const password = `qa-lock-${Date.now()}`;
const child = spawn(process.execPath, ['server.js'], {
  cwd: root, windowsHide: true,
  env: { ...process.env, HOST: '127.0.0.1', PORT: '0', DATABASE_URL: '', AUTH_REQUIRED: 'true', DEMO_MODE: 'false', NODE_ENV: 'test', DEMO_OWNER_PASSWORD: password },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stdout.on('data', chunk => { output += chunk; });
child.stderr.on('data', chunk => { output += chunk; });
const base = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`Lock QA server did not start: ${output}`)), 15000);
  child.once('error', reject);
  child.stdout.on('data', () => {
    const match = output.match(/CRM running on http:\/\/localhost:(\d+)/);
    if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); }
  });
});
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: 'ru-RU' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${base}/login`, { waitUntil: 'networkidle' });
  await page.locator('#login-username').fill('owner');
  await page.locator('#login-password').fill(password);
  await page.locator('#login-form button[type=submit]').click();
  await page.waitForURL(url => url.pathname !== '/login');
  await page.goto(`${base}/admin#lock-security`, { waitUntil: 'networkidle' });
  await page.locator('#lock-settings-button').click();
  const dialog = page.locator('.lock-settings-dialog');
  await dialog.waitFor({ state: 'visible' });
  await dialog.locator('#lock-timeout-select').selectOption('15');
  let attempts = 0;
  await page.route('**/api/session/preferences', async route => {
    if (route.request().method() !== 'PATCH' || !Object.hasOwn(JSON.parse(route.request().postData() || '{}'), 'lockTimeoutMinutes')) return route.continue();
    attempts += 1;
    if (attempts !== 1) return route.continue();
    await new Promise(resolve => setTimeout(resolve, 400));
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'temporary_unavailable' }) });
  });
  await dialog.locator('.lock-settings-save').click();
  assert.equal(await dialog.locator('.lock-settings-save').isDisabled(), true, 'pending save disables duplicate submit');
  await dialog.locator('.lock-settings-close').evaluate(button => button.click());
  await page.keyboard.press('Escape');
  assert.equal(await dialog.isVisible(), true, 'pending save cannot hide the result behind a closed dialog');
  await dialog.locator('#lock-timeout-message').getByText('Не удалось сохранить настройки автоблокировки').waitFor();
  assert.equal(await dialog.locator('#lock-pin-message').innerText(), '', 'timeout error appears beside timeout settings');
  assert.equal(await dialog.locator('#lock-timeout-select').inputValue(), '15', 'failed save retains selected timeout');
  assert.equal(await dialog.locator('.lock-settings-save').isEnabled(), true, 'failed save allows retry');
  assert.equal(await dialog.locator('.lock-settings-close').isEnabled(), true, 'failed save restores close');
  await dialog.screenshot({ path: 'tmp/lock-settings-error-390.png' });
  await dialog.locator('.lock-settings-save').click();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(attempts, 2, 'one failed request and one successful retry');
  const token = await page.evaluate(() => localStorage.getItem('crm_session_token'));
  const originalUser = await page.evaluate(() => localStorage.getItem('crm_session_user'));
  const saved = await page.request.get(`${base}/api/session/preferences`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(saved.status(), 200);
  assert.equal((await saved.json()).preferences.lockTimeoutMinutes, 15, 'retry persists timeout');
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('#lock-settings-button').click();
  assert.equal(await page.locator('#lock-timeout-select').inputValue(), '15', 'saved timeout survives reload');
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const geometry = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, doc: document.documentElement.scrollWidth, dialog: document.querySelector('.lock-settings-dialog').getBoundingClientRect().toJSON() }));
    assert.ok(geometry.doc <= geometry.viewport && geometry.dialog.x >= -1 && geometry.dialog.right <= width + 1, `dialog fits ${width}px: ${JSON.stringify(geometry)}`);
  }
  await dialog.locator('.lock-settings-close').click();
  await page.locator('#lock-settings-button').click();
  await dialog.locator('#lock-new-pin').fill('1234');
  await dialog.locator('#lock-new-pin-confirm').fill('1234');
  await dialog.locator('.lock-settings-close').click();
  await page.locator('#lock-settings-button').click();
  assert.equal(await dialog.locator('#lock-new-pin').inputValue(), '', 'closing clears the unsaved PIN');
  assert.equal(await dialog.locator('#lock-new-pin-confirm').inputValue(), '', 'closing clears PIN confirmation');
  await dialog.locator('#lock-timeout-select').selectOption('30');
  let releaseLateResponse;
  const lateResponse = new Promise(resolve => { releaseLateResponse = resolve; });
  await page.route('**/api/session/preferences', async route => {
    if (route.request().method() !== 'PATCH') return route.continue();
    await lateResponse;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ preferences: { lockTimeoutMinutes: 30 } }) });
  });
  const lateRequest = page.waitForRequest(request => request.method() === 'PATCH' && request.url().endsWith('/api/session/preferences'));
  await dialog.locator('.lock-settings-save').click();
  await lateRequest;
  const replacement = JSON.stringify({ id: 'qa-other-account', organizationId: 'qa-other-org', venueId: 'qa-other-venue', role: 'owner' });
  await page.evaluate(nextUser => { localStorage.setItem('crm_session_token', 'qa-other-token'); localStorage.setItem('crm_session_user', nextUser); }, replacement);
  releaseLateResponse();
  await page.waitForFunction(() => !document.querySelector('.lock-settings-save')?.disabled);
  assert.equal(await page.evaluate(() => localStorage.getItem('crm_session_user')), replacement, 'late response does not restore the previous account');
  assert.equal(await dialog.isVisible(), true, 'stale response does not close a dialog belonging to a changed session');
  await page.unroute('**/api/session/preferences');
  await page.evaluate(({ ownerToken, ownerUser }) => { localStorage.setItem('crm_session_token', ownerToken); localStorage.setItem('crm_session_user', ownerUser); }, { ownerToken: token, ownerUser: originalUser });
  let releaseInitialRead;
  const initialRead = new Promise(resolve => { releaseInitialRead = resolve; });
  await page.route('**/api/session/preferences', async route => {
    if (route.request().method() !== 'GET') return route.continue();
    await initialRead;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ preferences: { lockTimeoutMinutes: 5 } }) });
  });
  const pendingRead = page.waitForRequest(request => request.method() === 'GET' && request.url().endsWith('/api/session/preferences'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await pendingRead;
  await page.evaluate(nextUser => { localStorage.setItem('crm_session_token', 'qa-other-token'); localStorage.setItem('crm_session_user', nextUser); }, replacement);
  releaseInitialRead();
  await page.waitForTimeout(150);
  assert.equal(await page.evaluate(() => localStorage.getItem('crm_session_user')), replacement, 'late initial GET does not restore the previous account');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'PASS', role: 'owner', widths: [320, 390, 1440], attempts, pageErrors: errors }));
} finally {
  await browser?.close();
  child.kill();
}
