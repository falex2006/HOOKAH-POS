const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE_PATH || 'playwright');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

(async () => {
  const server = spawn(process.execPath, ['server.js'], {
    windowsHide: true,
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', DATABASE_URL: '', API_RATE_LIMIT: '10000', AUTH_REQUIRED: 'false', DEMO_MODE: 'false', NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  server.stdout.on('data', (chunk) => { output += chunk; });
  server.stderr.on('data', (chunk) => { output += chunk; });
  let browser;
  try {
    const base = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Local test server did not start: ${output}`)), 15000);
      server.once('error', reject);
      server.stdout.on('data', () => {
        const match = output.match(/CRM running on http:\/\/localhost:(\d+)/);
        if (match) { clearTimeout(timeout); resolve(`http://127.0.0.1:${match[1]}`); }
      });
    });
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'ru-RU' });
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    const login = async (username, password) => {
      const response = await page.request.post(`${base}/api/login`, { data: { username, password } });
      assert.equal(response.status(), 200, await response.text());
      return (await response.json()).token;
    };
    const ownerToken = await login('admin', 'admin');
    const managerLogin = `view_qa_${Date.now()}`;
    const managerPassword = 'ViewQa1234';
    const created = await page.request.post(`${base}/api/staff`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
      data: { name: 'QA управляющий вида каталога', login: managerLogin, password: managerPassword, role: 'manager', birthDate: '1990-01-01', phoneNumbers: [{number: '+79990000000', primary: true}], telegram: '@qa_staff' },
    });
    assert.equal(created.status(), 201, await created.text());
    const managerToken = await login(managerLogin, managerPassword);
    const preferences = async (token, method = 'GET', data) => {
      const response = await page.request.fetch(`${base}/api/session/preferences`, {
        method, headers: { Authorization: `Bearer ${token}`, ...(data ? { 'Content-Type': 'application/json' } : {}) }, ...(data ? { data } : {}),
      });
      const body = await response.json();
      return { status: response.status(), body };
    };
    assert.equal((await preferences(ownerToken, 'PATCH', { staffDirectory: { view: 'list', cardScale: 4 } })).status, 200);
    assert.deepEqual((await preferences(ownerToken)).body.preferences.staffDirectory, { view: 'list', cardScale: 4 });
    assert.equal((await preferences(managerToken)).body.preferences.staffDirectory, undefined, 'new account must not inherit owner layout preference');
    assert.equal((await preferences(managerToken, 'PATCH', { staffDirectory: { view: 'table' } })).status, 200);
    assert.deepEqual((await preferences(managerToken)).body.preferences.staffDirectory, { view: 'table' });
    assert.deepEqual((await preferences(ownerToken)).body.preferences.staffDirectory, { view: 'list', cardScale: 4 }, 'manager preference must not overwrite owner preference');
    assert.equal((await preferences(ownerToken, 'PATCH', { staffDirectory: { view: 'cards', cardScale: 5 } })).status, 400, 'scale must be bounded');

    await page.goto(`${base}/login`);
    await page.locator('#login-username').fill('admin');
    await page.locator('#login-password').fill('admin');
    await page.locator('#login-form button[type=submit]').click();
    await page.waitForURL((url) => !url.pathname.includes('/login'));
    await page.goto(`${base}/admin#staff`, { waitUntil: 'networkidle' });
    const views = page.locator('[data-staff-view]');
    await views.nth(1).waitFor();
    assert.ok(await page.locator('.staff-edit').count() > 0, 'profile action must be available in the directory');
    assert.ok(await page.locator('.staff-delete').count() > 0, 'block action must remain available for manageable staff');
    await views.filter({ hasText: 'Таблица' }).click();
    assert.equal(await page.locator('#staff-list').getAttribute('data-view'), 'table');
    assert.ok(await page.locator('.staff-directory-table .staff-edit').count() > 0, 'table must retain profile actions');
    assert.ok(await page.locator('.staff-directory-table .staff-delete').count() > 0, 'table must retain block actions');
    await page.locator('.staff-directory-table thead th').nth(2).waitFor();
    await page.locator('#staff-search').fill('нет такого сотрудника');
    await page.getByText('По текущему поиску и фильтрам сотрудников нет').waitFor();
    await page.locator('#staff-search').fill('');
    await page.locator('[data-staff-view="cards"]').click();
    await page.waitForFunction(() => document.querySelector('#staff-list')?.dataset.view === 'cards');
    assert.ok(await page.locator('.staff-card .staff-edit').count() > 0, 'cards must retain profile actions');
    await page.locator('[data-staff-scale="4"]').click();
    await page.waitForFunction(() => document.querySelector('#staff-list')?.dataset.cardScale === '4');
    await page.reload({ waitUntil: 'networkidle' });
    assert.equal(await page.locator('#staff-list').getAttribute('data-view'), 'cards', 'last selected view must persist on reload');
    assert.equal(await page.locator('#staff-list').getAttribute('data-card-scale'), '4', 'card scale must persist on reload');
    fs.mkdirSync('tmp/staff-views', { recursive: true });
    for (const width of [390, 620, 768, 1440, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      await page.locator('#staff-list').waitFor();
      const layout = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, page: document.documentElement.scrollWidth }));
      assert.ok(layout.page <= layout.viewport + 1, `page must not scroll horizontally at ${width}px: ${JSON.stringify(layout)}`);
      for (const view of ['cards', 'list', 'table']) {
        await page.locator(`[data-staff-view="${view}"]`).click();
        await page.waitForTimeout(300);
        const bounds = await page.locator('[data-staff-view]').evaluateAll(nodes => nodes.map(n => n.getBoundingClientRect().height));
        assert.equal(new Set(bounds).size, 1, 'view buttons equal heights');
        if (view !== 'cards') {
          const avatar = await page.locator('#staff-list .staff-card-avatar').first().boundingBox();
          assert.ok(avatar.width <= 60, 'card scale must not leak into list/table');
        }
        const icons = await page.locator('.staff-table-contacts svg').evaluateAll(nodes => nodes.map(n => n.getBoundingClientRect().width));
        if (view === 'table') assert.ok(icons.length > 0, 'contact icon fixture present');
        assert.ok(icons.every(width => width <= 24), 'contact icons bounded');
        if ([390,1920].includes(width)) await page.screenshot({ path: path.resolve(`tmp/staff-views/${view}-${width}.png`) });
      }
      if (width <= 620) {
        await page.locator('[data-staff-view="table"]').click();
        await page.locator('.staff-directory-table tbody .staff-table-row').first().waitFor({ timeout: 1000 }).catch(() => {});
        const tableDisplay = await page.locator('.staff-directory-table').evaluate((node) => getComputedStyle(node).display);
        assert.equal(tableDisplay, 'table', 'table retains columns with local scrolling on narrow screens');
        assert.equal(await page.locator('.staff-table-scroll').evaluate(n => getComputedStyle(n).overflowX), 'auto');
        assert.equal(await page.locator('.staff-table-person .staff-card-owner').first().evaluate(n => getComputedStyle(n).position), 'static', 'crown stays inside owner row');
      }
    }
    assert.deepEqual(pageErrors, [], `unexpected browser errors: ${pageErrors.join('; ')}`);
    console.log('PASS staff directory cards/list/table, presets and per-account preference isolation; responsive widths 390/620/768/1440');
  } finally {
    if (browser) await browser.close();
    server.kill();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
