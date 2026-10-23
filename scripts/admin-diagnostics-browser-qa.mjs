import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

if (!process.env.PLAYWRIGHT_PACKAGE_PATH) throw new Error('Set PLAYWRIGHT_PACKAGE_PATH');
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_PACKAGE_PATH);
const root = fileURLToPath(new URL('../', import.meta.url));
const password = `qa-diagnostics-${Date.now()}`;
const child = spawn(process.execPath, ['server.js'], {
  cwd: root, windowsHide: true,
  env: { ...process.env, HOST: '127.0.0.1', PORT: '0', DATABASE_URL: '', AUTH_REQUIRED: 'true', DEMO_MODE: 'false', NODE_ENV: 'test', DEMO_OWNER_PASSWORD: password },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stdout.on('data', chunk => { output += chunk; });
child.stderr.on('data', chunk => { output += chunk; });
const base = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`Diagnostics QA server did not start: ${output}`)), 15000);
  child.once('error', reject);
  child.stdout.on('data', () => {
    const match = output.match(/CRM running on http:\/\/localhost:(\d+)/);
    if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); }
  });
});
let browser;
try {
  const request = async (path, token, method = 'GET', body, expected = 200) => {
    const response = await fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json();
    assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(data)}`);
    return data;
  };
  const owner = await request('/api/login', '', 'POST', { username: 'owner', password });
  const sessions = [['owner', owner]];
  const staffPassword = 'Qa123456!';
  for (const role of ['admin', 'developer', 'manager']) {
    const username = `diag_${role}_${Date.now().toString(36)}`;
    await request('/api/staff', owner.token, 'POST', { name: `QA ${role}`, role, login: username, password: staffPassword, birthDate: '1990-01-01' }, 201);
    sessions.push([role, await request('/api/login', '', 'POST', { username, password: staffPassword })]);
  }
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
  const results = [];
  for (const [role, session] of sessions) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ru-RU', reducedMotion: 'reduce' });
    await context.addInitScript(({ token, user }) => { localStorage.setItem('crm_session_token', token); localStorage.setItem('crm_session_user', JSON.stringify(user)); }, { token: session.token, user: session.user });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let mode = 'planned';
    let releaseFirst;
    const firstGate = new Promise(resolve => { releaseFirst = resolve; });
    let reads = 0;
    if (role === 'owner') await page.route('**/api/integrations', async route => {
      if (route.request().method() !== 'GET') return route.continue();
      reads += 1;
      if (reads === 1) await firstGate;
      if (mode === 'error') return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'temporary_unavailable' }) });
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ telegram: { enabled: mode === 'connected', status: mode } }) });
    });
    await page.goto(`${base}/admin#diagnostics`, { waitUntil: 'domcontentloaded' });
    if (role === 'manager') {
      await page.waitForFunction(() => document.documentElement.dataset.portalAccess === 'denied' || document.querySelector('#portal-session-guard')?.getClientRects().length);
      assert.equal(await page.locator('#diagnostics').count(), 0, 'manager without diagnostics permission has no panel');
    } else {
      const panel = page.locator('#diagnostics');
      await panel.waitFor({ state: 'visible' });
      if (role === 'owner') {
        await panel.getByText('Проверка состояния…').waitFor();
        assert.equal(await panel.locator('#diagnostics-list').getAttribute('aria-busy'), 'true');
        assert.equal(await panel.locator('[data-diagnostics-retry]').isDisabled(), true);
        releaseFirst();
      }
      await panel.getByText('Telegram', { exact: true }).waitFor();
      await panel.getByText('В подготовке').waitFor();
      assert.equal(await panel.locator('.audit-icon.is-pending').count(), 1, `${role} planned state stays neutral`);
      if (role === 'owner') {
        for (const width of [320, 390, 1440]) {
          await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
          const bounds = await page.evaluate(() => {
            const panel = document.querySelector('#diagnostics').getBoundingClientRect();
            const row = document.querySelector('#diagnostics .audit-row').getBoundingClientRect();
            return { doc: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth, panelLeft: panel.left, panelRight: panel.right, rowRight: row.right };
          });
          assert.ok(bounds.doc <= bounds.viewport && bounds.panelLeft >= -1 && bounds.panelRight <= width + 1 && bounds.rowRight <= bounds.panelRight + 1, `diagnostics fits ${width}px: ${JSON.stringify(bounds)}`);
          await page.screenshot({ path: `tmp/diagnostics-planned-${width}.png` });
        }
        await page.setViewportSize({ width: 390, height: 844 });
        mode = 'error';
        await panel.locator('[data-diagnostics-retry]').click();
        await panel.getByText('Не удалось загрузить состояние интеграций. Повторите загрузку.').waitFor();
        assert.equal(await panel.locator('[data-diagnostics-retry]').isEnabled(), true);
        await page.screenshot({ path: 'tmp/diagnostics-error-390.png' });
        mode = 'connected';
        await panel.locator('[data-diagnostics-retry]').click();
        await panel.getByText('Подключено').waitFor();
        assert.equal(await panel.locator('.audit-icon.is-connected').count(), 1);
        assert.equal(reads, 3, 'initial load, failed refresh and successful retry make three reads');
        await page.screenshot({ path: 'tmp/diagnostics-connected-390.png' });
      }
    }
    assert.deepEqual(errors, [], `${role} page errors`);
    results.push(role);
    await context.close();
  }
  console.log(JSON.stringify({ result: 'PASS', roles: results, ownerWidths: [320, 390, 1440], pageErrors: [] }));
} finally {
  await browser?.close();
  child.kill();
}
