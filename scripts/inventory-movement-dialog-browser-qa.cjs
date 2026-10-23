const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE_PATH || 'playwright');

(async () => {
  const useDist = process.env.MOVEMENT_DIALOG_USE_DIST === '1';
  const folder = path.resolve('tmp/inventory-movement-dialog-browser-qa', useDist ? 'dist' : 'source');
  fs.mkdirSync(folder, { recursive: true });
  const server = spawn(process.execPath, ['server.js'], {
    windowsHide: true,
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', DATABASE_URL: '', AUTH_REQUIRED: 'true', DEMO_MODE: 'false', DEMO_OWNER_PASSWORD: 'demo', DEMO_STAFF_PASSWORD: 'demo', NODE_ENV: 'test', API_RATE_LIMIT: '10000' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let browser, releasePending;
  try {
    const base = await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(Error('Movement QA startup timeout')), 15000);
      server.stdout.on('data', data => {
        output += data;
        const port = output.match(/CRM running on http:\/\/localhost:(\d+)/)?.[1];
        if (port) { clearTimeout(timer); resolve('http://127.0.0.1:' + port); }
      });
      server.once('error', error => { clearTimeout(timer); reject(error); });
      server.once('exit', code => { clearTimeout(timer); reject(Error('Movement QA server exited ' + code)); });
    });
    const api = async (route, token, method = 'GET', body, expected = 200) => {
      const response = await fetch(base + route, { method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      const data = await response.json();
      assert.equal(response.status, expected, route + ': ' + (data.error || ''));
      return data;
    };
    const seed = await api('/api/login', '', 'POST', { username: 'owner', password: 'demo' });
    const item = await api('/api/inventory/items', seed.token, 'POST', { name: 'QA Вода для операции', department: 'bar', category: 'Вода', unit: 'мл', itemType: 'ingredient', minLevel: 0, cost: 0.01 }, 201);
    await api('/api/inventory/movements', seed.token, 'POST', { itemId: item.id, delta: 20, unit: 'мл', reason: 'QA seed' }, 201);
    await api('/api/staff', seed.token, 'POST', { name: 'QA Только справочники', role: 'manager', login: 'qa_movement_reader', password: 'demo', birthDate: '1990-01-01', permissionScopes: ['inventory_categories'] }, 201);
    await api('/api/logout', seed.token, 'POST');
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: 'ru-RU' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const signIn = async (target, username) => {
      if (useDist) {
        await target.route(/\/portal\.js(?:\?|$)/, route => route.fulfill({ path: path.resolve(__dirname, '../dist/portal.js'), contentType: 'text/javascript' }));
        await target.route(/\/style\.css(?:\?|$)/, route => route.fulfill({ path: path.resolve(__dirname, '../dist/style.css'), contentType: 'text/css' }));
      }
      await target.goto(base + '/login');
      await target.locator('#login-username').fill(username);
      await target.locator('#login-password').fill('demo');
      await target.locator('#login-form button[type="submit"]').click();
      await target.waitForURL(url => !url.pathname.includes('/login'));
      await target.goto(base + '/inventory?view=movements', { waitUntil: 'networkidle' });
    };
    await signIn(page, 'owner');
    const token = await page.evaluate(() => localStorage.getItem('crm_session_token'));
    const opener = page.locator('[data-inventory-header-action="adjustment"]');
    const dialog = page.locator('#inventory-movement-dialog');
    const submit = page.locator('#movement-form button[type="submit"]');
    const originalOpener = await opener.elementHandle();
    const choose = async (selector, value) => {
      const wrapper = page.locator(selector).locator('..');
      await wrapper.locator('.custom-select-trigger').click();
      await wrapper.locator('[data-value="' + value + '"]').click();
    };
    await opener.click();
    await choose('#movement-item', item.id);
    await choose('#movement-direction', 'out');
    await page.locator('#movement-delta').fill('3');
    await page.locator('#movement-reason').fill('QA ошибка и повтор');
    const pending = new Promise(resolve => { releasePending = resolve; });
    let started, attempts = 0;
    const intercepted = new Promise(resolve => { started = resolve; });
    await page.route('**/api/inventory/movements', async route => {
      if (route.request().method() !== 'POST') return route.continue();
      attempts++;
      if (attempts === 1) {
        started();
        await Promise.race([pending, new Promise(resolve => setTimeout(resolve, 15000))]);
        return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'qa_unavailable' }) });
      }
      return route.continue();
    });
    const submitBox = await submit.boundingBox();
    await submit.click();
    await Promise.race([intercepted, new Promise((_, reject) => setTimeout(() => reject(Error('Movement POST did not start')), 5000))]);
    assert.equal(await submit.isDisabled(), true);
    assert.equal(await page.locator('#movement-cancel').isDisabled(), true);
    assert.equal(await dialog.getByRole('button', { name: 'Закрыть', exact: true }).isDisabled(), true);
    assert.equal(await page.locator('#movement-delta').isDisabled(), true);
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');
    await page.mouse.click(5, 5);
    await page.mouse.click(submitBox.x + submitBox.width / 2, submitBox.y + submitBox.height / 2);
    assert.equal(await dialog.isVisible(), true, 'pending movement cannot be dismissed');
    assert.equal(attempts, 1, 'pending action sends one request');
    releasePending();
    await page.waitForFunction(() => document.querySelector('#movement-form')?.dataset.submitting === '0');
    assert.match(await page.locator('#movement-message').innerText(), /Не удалось сохранить операцию/);
    const failureState = {
      role: await page.locator('#movement-message').getAttribute('role'),
      retryFocused: await submit.evaluate(node => document.activeElement === node)
    };
    assert.deepEqual(failureState, { role: 'alert', retryFocused: true }, 'save failure is announced and retry has visible keyboard focus');
    assert.equal(await page.locator('#movement-delta').inputValue(), '3');
    assert.equal(await page.locator('#movement-reason').inputValue(), 'QA ошибка и повтор');
    await page.screenshot({ path: path.join(folder, 'error-390.png') });
    for (const width of [320, 390, 520, 768, 1440]) {
      await page.setViewportSize({ width, height: width < 600 ? 844 : 1000 });
      await page.locator('#movement-item').locator('..').locator('.custom-select-trigger').click();
      const option = page.locator('#movement-item').locator('..').locator('[role="option"][data-value="' + item.id + '"]');
      await option.waitFor({ state: 'visible', timeout: 3000 });
      await page.keyboard.press('Escape');
      assert.equal(await dialog.isVisible(), true, 'first Escape only closes select at ' + width);
      const bounds = await dialog.boundingBox();
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1, 'modal fits at ' + width);
      const layout = await page.locator('.inventory-movement-editor-actions').evaluate(node => {
        const buttons = [...node.querySelectorAll('button')].map(button => button.getBoundingClientRect().toJSON());
        return { buttons, gap: buttons[1].top - buttons[0].bottom };
      });
      assert.ok(layout.buttons.every(button => button.height >= 44), 'touch targets at ' + width);
      assert.ok(Math.abs(layout.buttons[0].height - layout.buttons[1].height) < 1 && Math.abs(layout.buttons[0].width - layout.buttons[1].width) < 1, 'equal action geometry at ' + width);
      assert.deepEqual(await page.locator('.inventory-movement-editor-actions button').evaluateAll(nodes => nodes.map(node => {
        const range = document.createRange(); range.selectNodeContents(node); return range.getClientRects().length;
      })), [1, 1], 'action captions stay on one line at ' + width);
      if (width <= 650) {
        assert.ok(Math.abs(layout.buttons[0].width - layout.buttons[1].width) < 1, 'equal mobile action widths at ' + width);
        assert.ok(layout.gap >= 8 && layout.gap <= 16, 'consistent stacked action gap at ' + width);
      } else assert.ok(Math.abs(layout.buttons[0].top - layout.buttons[1].top) < 1, 'desktop footer on one line at ' + width);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.equal(await page.locator('#movement-message').evaluate(node => {
        const rect = node.getBoundingClientRect(); return rect.top >= 0 && rect.bottom <= innerHeight;
      }), true, 'movement failure stays visible above the footer at ' + width);
      if ([390, 1440].includes(width)) await page.screenshot({ path: path.join(folder, 'dialog-' + width + '.png') });
    }
    await submit.click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(attempts, 2, 'one explicit retry');
    await page.waitForFunction(() => document.activeElement?.dataset.inventoryHeaderAction === 'adjustment', null, { timeout: 5000 });
    const stock = async () => Number((await api('/api/inventory', token)).items.find(entry => entry.id === item.id).onHand);
    assert.equal(await stock(), 17, 'only successful retry changes stock');
    assert.equal(await originalOpener.evaluate(node => node.isConnected && document.activeElement === node), true, 'stock/context refresh preserves the original opener node and focus');
    await page.reload({ waitUntil: 'networkidle' });
    assert.equal(await stock(), 17);
    await page.locator('[data-movement-journal="operations"]').click();
    assert.match(await page.locator('#movement-history-list').innerText(), /QA ошибка и повтор/);
    await page.unroute('**/api/inventory/movements');
    await opener.click();
    await choose('#movement-item', item.id);
    await choose('#movement-unit', 'шт');
    await page.locator('#movement-delta').fill('1');
    await submit.click();
    await page.waitForFunction(() => document.querySelector('#movement-form')?.dataset.submitting === '0');
    assert.match(await page.locator('#movement-message').innerText(), /единицу.*количество/i, 'actual invalid_movement_unit has an actionable explanation');
    assert.equal(await stock(), 17);
    await page.locator('#movement-cancel').click();
    await page.waitForFunction(() => document.activeElement?.dataset.inventoryHeaderAction === 'adjustment');
    await page.locator('.portal-sidebar a[href="/inventory?view=stock"]').click();
    await page.locator('[data-inventory-header-action="item"]').waitFor({ state: 'visible' });
    assert.equal(await page.locator('[data-inventory-header-action="adjustment"]').count(), 0, 'view switch replaces the action contract');
    await page.locator('.portal-sidebar a[href="/inventory?view=movements"]').click();
    await opener.waitFor({ state: 'visible' });
    assert.deepEqual(await page.locator('#inventory-header-actions [data-inventory-header-action]').evaluateAll(nodes => nodes.map(node => node.dataset.inventoryHeaderAction)), ['receipt', 'adjustment']);
    await opener.click();
    assert.equal(await page.locator('#inventory-movement-dialog[open]').count(), 1, 'one delegated action opens one editor after view switches');
    await page.locator('#movement-cancel').click();
    const readerContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const reader = await readerContext.newPage();
    reader.on('pageerror', error => errors.push(error.message));
    await signIn(reader, 'qa_movement_reader');
    assert.equal(await reader.locator('[data-inventory-header-action="adjustment"]').count(), 0, 'read-only role has no write action');
    assert.equal(await reader.locator('#movement-form').count(), 0, 'read-only role has no writable form');
    const readerToken = await reader.evaluate(() => localStorage.getItem('crm_session_token'));
    await api('/api/inventory/movements', readerToken, 'POST', { itemId: item.id, delta: -1, unit: 'мл' }, 403);
    assert.equal(await stock(), 17);
    assert.deepEqual(errors, []);
    console.log('PASS movement dialog ' + (useDist ? 'dist' : 'source') + ': pending/503/draft/focus/retry/readback/reload, invalid-unit error, reader403, popup/footer 320/390/520/768/1440');
  } catch (error) {
    const page = browser?.contexts()[0]?.pages()[0];
    await page?.screenshot({ path: path.join(folder, 'failure.png') }).catch(() => {});
    throw error;
  } finally {
    releasePending?.();
    await browser?.close();
    server.kill();
    if (server.exitCode === null) await Promise.race([once(server, 'exit'), new Promise(resolve => setTimeout(resolve, 3000))]);
  }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
