const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { randomUUID, randomBytes, scryptSync } = require('node:crypto');
const { Client } = require('pg');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE_PATH || 'playwright');

(async () => {
  const { validateQaDatabaseUrl, assertQaDatabaseIdentity } = await import('./postgres-qa-safety.mjs');
  const target = validateQaDatabaseUrl(process.env.AUTO_ORDER_SELECTION_TEST_DATABASE_URL, 'AUTO_ORDER_SELECTION_TEST_DATABASE_URL');
  assert.match(target.database, /^inventory_qa_[a-f0-9]{16}$/i);
  assert.equal(target.database, process.env.LOCAL_FULL_PG_OWNED_DATABASE, 'only the guarded runner may own this disposable database');
  const client = new Client({ connectionString: target.url.href, connectionTimeoutMillis: 5000 });
  const ids = { organization: randomUUID(), venue: randomUUID(), owner: randomUUID() };
  const ownerLogin = 'auto-order-owner-' + ids.owner;
  const readerLogin = 'auto_order_selection_reader';
  const useDist = process.env.AUTO_ORDER_SELECTION_USE_DIST === '1';
  const folder = path.resolve('tmp/auto-order-selection-browser-qa', useDist ? 'dist' : 'source');
  fs.mkdirSync(folder, { recursive: true });
  let server, browser;
  const gates = [];
  const deferred = () => {
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    gates.push(release);
    return { release, pending };
  };
  try {
    await client.connect();
    const identity = (await client.query(`SELECT current_database() AS database,inet_server_addr()::text AS address,inet_server_port() AS port,COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname=current_user),false) AS superuser`)).rows[0];
    assertQaDatabaseIdentity(identity, target.database, Number(target.url.port || 5432), 'auto-order selection QA');
    const salt = randomBytes(16).toString('hex');
    const passwordHash = `scrypt$${salt}$${scryptSync('demo', salt, 64).toString('hex')}`;
    await client.query('INSERT INTO organizations(id,name,slug,timezone) VALUES($1,$2,$3,$4)', [ids.organization, 'Auto-order selection QA', 'auto-order-selection-' + ids.organization, 'Asia/Yekaterinburg']);
    await client.query("INSERT INTO organization_subscriptions(organization_id,status) VALUES($1,'trialing')", [ids.organization]);
    await client.query('INSERT INTO venues(id,organization_id,name,timezone) VALUES($1,$2,$3,$4)', [ids.venue, ids.organization, 'Auto-order selection QA venue', 'Asia/Yekaterinburg']);
    await client.query("INSERT INTO inventory_departments(venue_id,code,name) VALUES($1,'bar','Бар') ON CONFLICT(venue_id,code) DO UPDATE SET name=EXCLUDED.name", [ids.venue]);
    await client.query("INSERT INTO users(id,organization_id,venue_id,full_name,login,password_hash,role,permission_scopes) VALUES($1,$2,$3,'QA owner',$4,$5,'owner','[]'::jsonb)", [ids.owner, ids.organization, ids.venue, ownerLogin, passwordHash]);
    await client.query("INSERT INTO organization_memberships(organization_id,user_id,membership_role,status) VALUES($1,$2,'owner','active')", [ids.organization, ids.owner]);
    server = spawn(process.execPath, ['server.js'], { windowsHide: true,
      env: { ...process.env, HOST: '127.0.0.1', PORT: '0', DATABASE_URL: target.url.href, VENUE_ID: ids.venue, AUTH_REQUIRED: 'true', DEMO_MODE: 'false', NODE_ENV: 'test', API_RATE_LIMIT: '10000' },
      stdio: ['ignore', 'pipe', 'pipe'] });
    const base = await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(Error('Auto-order QA startup timeout')), 15000);
      server.stdout.on('data', data => {
        output += data;
        const port = output.match(/CRM running on http:\/\/localhost:(\d+)/)?.[1];
        if (port) { clearTimeout(timer); resolve('http://127.0.0.1:' + port); }
      });
      server.once('error', error => { clearTimeout(timer); reject(error); });
      server.once('exit', code => { clearTimeout(timer); reject(Error('Auto-order QA server exited ' + code)); });
    });
    const api = async (route, token, method = 'GET', body, expected = 200) => {
      const response = await fetch(base + route, { method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      const data = await response.json();
      assert.equal(response.status, expected, route + ': ' + (data.error || ''));
      return data;
    };
    const ownerSession = await api('/api/login', '', 'POST', { username: ownerLogin, password: 'demo' });
    const category = await api('/api/product-categories', ownerSession.token, 'POST', { name: 'QA Запасы', department: 'bar' }, 201);
    const ingredients = [];
    for (const [name, unit, purchaseUnit, multiplier, minLevel] of [
      ['QA Лимон для заказа', 'г', 'упаковка', 100, 150],
      ['QA Сироп для заказа', 'мл', 'бутылка', 500, 750],
    ]) {
      ingredients.push(await api('/api/inventory/items', ownerSession.token, 'POST', {
        name, department: 'bar', category: category.name, categoryId: category.id, unit, purchaseUnit,
        packMultiplier: multiplier, minLevel, itemType: 'ingredient', cost: 0.01,
      }, 201));
    }
    assert.equal(ingredients.every(item => Number(item.onHand || 0) === 0), true, 'fresh low-stock items start at zero stock');
    // inventory_read is derived server-side from the assignable inventory_categories scope.
    await api('/api/staff', ownerSession.token, 'POST', { name: 'QA Только просмотр', role: 'manager', login: readerLogin, password: 'demo', birthDate: '1990-01-01', permissionScopes: ['inventory_categories'] }, 201);
    const beforeInventory = await api('/api/inventory', ownerSession.token);
    assert.equal(beforeInventory.lowStock.filter(item => ingredients.some(seed => seed.id === item.id)).length, 2);
    const beforeOrders = await client.query('SELECT count(*)::int AS count FROM inventory_auto_orders WHERE venue_id=$1', [ids.venue]);
    assert.equal(beforeOrders.rows[0].count, 0);
    browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
    const errors = [];
    const signIn = async (page, username) => {
      page.on('pageerror', error => errors.push(error.message));
      if (useDist) {
        await page.route(/\/portal\.js(?:\?|$)/, route => route.fulfill({ path: path.resolve(__dirname, '../dist/portal.js'), contentType: 'text/javascript' }));
        await page.route(/\/style\.css(?:\?|$)/, route => route.fulfill({ path: path.resolve(__dirname, '../dist/style.css'), contentType: 'text/css' }));
      }
      await page.goto(base + '/login');
      await page.locator('#login-username').fill(username);
      await page.locator('#login-password').fill('demo');
      await page.locator('#login-form button[type="submit"]').click();
      await page.waitForURL(url => !url.pathname.includes('/login'));
      await page.goto(base + '/inventory?view=auto-orders', { waitUntil: 'networkidle' });
    };
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ru-RU' });
    const page = await context.newPage();
    await signIn(page, ownerLogin);
    const search = page.locator('#auto-order-search');
    const summary = page.locator('#auto-order-selection-summary');
    const selectVisible = page.locator('#auto-order-select-visible');
    const clearSelection = page.locator('#auto-order-clear-selection');
    const message = page.locator('#auto-order-message');
    const submit = page.locator('#create-auto-order');
    const checkbox = id => page.locator(`[data-auto-order-item="${id}"]`);
    const quantity = id => page.locator(`[data-auto-order-quantity="${id}"]`);
    const row = id => checkbox(id).locator('xpath=ancestor::tr[1]');
    await checkbox(ingredients[0].id).waitFor({ state: 'attached' });
    assert.equal(await page.locator('[data-auto-order-item]').count(), 2, 'only the two synthetic items are recommended');
    assert.equal(await checkbox(ingredients[0].id).isChecked(), true, 'all recommended items start selected');
    assert.equal(await checkbox(ingredients[1].id).isChecked(), true);
    assert.match(await summary.innerText(), /2/, 'initial selected count is explicit');
    assert.equal(await submit.isDisabled(), false);
    await search.fill('Лимон');
    assert.equal(await row(ingredients[0].id).isVisible(), true);
    assert.equal(await row(ingredients[1].id).isVisible(), false);
    assert.equal(await checkbox(ingredients[1].id).isChecked(), true, 'filtering preserves hidden selection');
    assert.match(await summary.innerText(), /2/, 'total selection remains visible while filtered');
    assert.match(await summary.innerText(), /1/, 'hidden selected count is explicit');
    await clearSelection.click();
    assert.equal(await checkbox(ingredients[0].id).isChecked(), false);
    assert.equal(await checkbox(ingredients[1].id).isChecked(), false);
    assert.equal(await submit.isDisabled(), true, 'no selection disables creation');
    await selectVisible.click();
    assert.equal(await checkbox(ingredients[0].id).isChecked(), true);
    assert.equal(await checkbox(ingredients[1].id).isChecked(), false, 'bulk selection affects visible items only');
    await search.fill('');
    await selectVisible.click();
    assert.equal(await checkbox(ingredients[1].id).isChecked(), true, 'bulk select adds the newly visible item');
    await quantity(ingredients[0].id).fill('400');
    await quantity(ingredients[1].id).fill('0');
    await search.fill('Лимон');
    await submit.click();
    assert.equal(await search.inputValue(), '', 'invalid hidden line becomes visible');
    assert.equal(await row(ingredients[1].id).isVisible(), true);
    assert.equal(await quantity(ingredients[1].id).getAttribute('aria-invalid'), 'true');
    assert.equal(await quantity(ingredients[1].id).evaluate(node => document.activeElement === node), true, 'focus identifies the invalid quantity');
    await quantity(ingredients[1].id).fill('1000');
    assert.equal(await quantity(ingredients[1].id).getAttribute('aria-invalid'), null, 'correction clears stale validation');
    await quantity(ingredients[1].id).fill('0.0000001');
    await submit.click();
    assert.equal(await quantity(ingredients[1].id).getAttribute('aria-invalid'), 'true', 'quantity step is validated locally');
    await quantity(ingredients[1].id).fill('1000');
    assert.equal(await quantity(ingredients[1].id).getAttribute('aria-invalid'), null);
    const failureGate = deferred();
    let posts = 0, reads = 0, payload;
    await page.route('**/api/inventory/auto-orders', async route => {
      if (new URL(route.request().url()).pathname !== '/api/inventory/auto-orders') return route.continue();
      if (route.request().method() === 'GET') { reads++; return route.continue(); }
      if (route.request().method() !== 'POST') return route.continue();
      posts++; payload = route.request().postDataJSON();
      if (posts === 1) { await failureGate.pending; return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"auto_orders_unavailable"}' }); }
      return route.continue();
    });
    const attempted = page.waitForRequest(request => request.method() === 'POST' && new URL(request.url()).pathname === '/api/inventory/auto-orders');
    await submit.click();
    await attempted;
    assert.deepEqual(payload.items, [{ itemId: ingredients[0].id, quantity: 400 }, { itemId: ingredients[1].id, quantity: 1000 }]);
    await page.waitForFunction(() => document.querySelector('#create-auto-order')?.disabled);
    assert.equal(await selectVisible.isDisabled(), true, 'bulk select locks during creation');
    assert.equal(await clearSelection.isDisabled(), true, 'bulk clear locks during creation');
    assert.equal(await checkbox(ingredients[0].id).isDisabled(), true);
    assert.equal(await quantity(ingredients[1].id).isDisabled(), true);
    assert.equal(posts, 1, 'pending state cannot double-submit');
    failureGate.release();
    await page.waitForFunction(() => !document.querySelector('#create-auto-order')?.disabled);
    assert.equal(posts, 1, 'failed uncertain attempt is never repeated automatically');
    assert.equal(await checkbox(ingredients[0].id).isChecked(), true);
    assert.equal(await checkbox(ingredients[1].id).isChecked(), true);
    assert.equal(await quantity(ingredients[0].id).inputValue(), '400');
    assert.equal(await quantity(ingredients[1].id).inputValue(), '1000');
    assert.match(await message.innerText(), /проверьте.*журнал|журнал.*проверьте/i, 'uncertain outcome directs operator to journal');
    assert.ok(reads >= 1, 'journal is refreshed before retry is unlocked');
    for (const width of [320, 390, 520, 768, 1440]) {
      await page.setViewportSize({ width, height: 844 });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
      const geometry = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, action: document.querySelector('#create-auto-order')?.getBoundingClientRect().toJSON(), summary: document.querySelector('#auto-order-selection-summary')?.getBoundingClientRect().toJSON() }));
      assert.ok(geometry.document <= geometry.viewport + 1, `no horizontal page overflow at ${width}: ${JSON.stringify(geometry)}`);
      assert.ok(geometry.action?.width > 0 && geometry.summary?.width > 0, `selection controls visible at ${width}`);
      await page.screenshot({ path: path.join(folder, `error-${width}.png`), fullPage: true });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    const responsePromise = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/inventory/auto-orders');
    await submit.click();
    const response = await responsePromise;
    assert.equal(response.status(), 201, 'explicit retry creates the request');
    const created = await response.json();
    assert.equal(posts, 2);
    assert.equal(created.status, 'sent');
    await page.locator('.auto-order-request-row').first().waitFor({ state: 'visible' });
    await page.reload({ waitUntil: 'networkidle' });
    assert.equal(await page.locator('.auto-order-request-row').count(), 1, 'request remains in history after reload');
    const saved = (await api('/api/inventory/auto-orders', ownerSession.token)).requests;
    assert.equal(saved.length, 1);
    assert.equal(saved[0].id, created.id);
    const persisted = await client.query('SELECT status,lines FROM inventory_auto_orders WHERE id=$1 AND venue_id=$2', [created.id, ids.venue]);
    assert.equal(persisted.rowCount, 1);
    assert.equal(persisted.rows[0].status, 'sent');
    assert.deepEqual(persisted.rows[0].lines.map(line => [line.itemId, Number(line.quantity)]), [[ingredients[0].id, 400], [ingredients[1].id, 1000]]);
    const afterInventory = await api('/api/inventory', ownerSession.token);
    for (const item of ingredients) {
      const before = beforeInventory.items.find(entry => entry.id === item.id);
      const after = afterInventory.items.find(entry => entry.id === item.id);
      assert.equal(Number(after.onHand), Number(before.onHand), 'creating a request does not receive stock');
    }
    for (const width of [320, 390, 520, 768, 1440]) {
      await page.setViewportSize({ width, height: 844 });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `filled layout fits ${width}`);
      await page.screenshot({ path: path.join(folder, `filled-${width}.png`), fullPage: true });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('[data-auto-order-section="history"]').click();
    const cancelOrder = page.locator(`[data-auto-order-cancel="${created.id}"]`);
    const confirm = page.locator('.auto-order-confirm');
    const cancelConfirm = () => confirm.locator('[data-ui-cancel]');
    const submitConfirm = () => confirm.locator('[type="submit"]');
    const confirmMessage = () => confirm.locator('.ui-modal-message');
    let cancels = 0;
    const cancelGate = deferred();
    await page.route('**/api/inventory/auto-orders/' + created.id, async route => {
      if (route.request().method() !== 'PATCH') return route.continue();
      cancels++;
      assert.deepEqual(route.request().postDataJSON(), { status: 'cancelled' });
      if (cancels === 1) { await cancelGate.pending; return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"auto_orders_unavailable"}' }); }
      return route.continue();
    });
    await cancelOrder.click();
    await confirm.waitFor({ state: 'visible' });
    assert.match(await confirm.innerText(), /Отменить заявку\?/);
    assert.equal((await submitConfirm().innerText()).trim(), 'Отменить заявку');
    for (const width of [320, 390, 520, 768, 1440]) {
      const height = width < 600 ? 844 : 1000;
      await page.setViewportSize({ width, height });
      const boxes = await confirm.locator('.ui-modal-footer>button').evaluateAll(nodes => nodes.map(node => {
        const range = document.createRange(); range.selectNodeContents(node);
        return { ...node.getBoundingClientRect().toJSON(), lines: range.getClientRects().length };
      }));
      assert.equal(boxes.length, 2, `confirmation has two actions at ${width}`);
      assert.ok(boxes.every(box => box.height >= 44 && box.left >= 0 && box.right <= width && box.top >= 0 && box.bottom <= height && box.lines === 1), `confirmation actions fit ${width}`);
      assert.ok(Math.abs(boxes[0].width - boxes[1].width) < 1 && Math.abs(boxes[0].height - boxes[1].height) < 1, `confirmation actions align at ${width}`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `confirmation has no page overflow at ${width}`);
      if ([390, 1440].includes(width)) await page.screenshot({ path: path.join(folder, `cancel-confirm-${width}.png`) });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await cancelConfirm().click();
    await confirm.waitFor({ state: 'hidden' });
    assert.equal(cancels, 0, 'closing confirmation does not cancel the request');
    assert.equal(await cancelOrder.evaluate(node => document.activeElement === node && !node.disabled), true, 'closing restores enabled opener');
    assert.equal((await api('/api/inventory/auto-orders', ownerSession.token)).requests.find(entry => entry.id === created.id).status, 'sent');
    await cancelOrder.click();
    await submitConfirm().click();
    await page.waitForFunction(() => document.querySelector('.auto-order-confirm')?.getAttribute('aria-busy') === 'true');
    assert.equal(await cancelConfirm().isDisabled(), true);
    assert.equal(await confirm.locator('[data-ui-close]').isDisabled(), true);
    assert.equal(await cancelOrder.isDisabled(), true);
    await page.keyboard.press('Enter'); await page.keyboard.press('Escape'); await page.mouse.click(3, 3);
    assert.equal(await confirm.isVisible(), true);
    assert.equal(cancels, 1, 'pending confirmation cannot double-submit or close');
    cancelGate.release();
    await confirmMessage().waitFor({ state: 'visible' });
    assert.match(await confirmMessage().innerText(), /проверьте.*журнал|результат.*не подтверждён/i);
    assert.equal(await confirmMessage().evaluate(node => document.activeElement === node), true, 'failure focuses the inline result');
    assert.equal(await page.locator('#portal-notice[data-kind="error"]').count(), 0, 'failure is reported once in the confirmation');
    await page.screenshot({ path: path.join(folder, 'cancel-error-390.png') });
    await submitConfirm().click();
    await confirm.waitFor({ state: 'hidden' });
    assert.equal(cancels, 2, 'retry requires an explicit second action');
    assert.equal(await cancelOrder.count(), 0, 'cancelled request loses its cancellation action');
    assert.equal(await page.locator('#auto-order-history-list').evaluate(node => document.activeElement === node), true, 'removed opener returns focus to history');
    const cancelled = (await api('/api/inventory/auto-orders', ownerSession.token)).requests.find(entry => entry.id === created.id);
    assert.equal(cancelled.status, 'cancelled');
    const cancelledSql = await client.query('SELECT status,lines FROM inventory_auto_orders WHERE id=$1 AND venue_id=$2', [created.id, ids.venue]);
    assert.equal(cancelledSql.rows[0].status, 'cancelled');
    assert.deepEqual(cancelledSql.rows[0].lines, persisted.rows[0].lines, 'cancellation preserves request lines');
    const cancelledInventory = await api('/api/inventory', ownerSession.token);
    for (const item of ingredients) assert.equal(Number(cancelledInventory.items.find(entry => entry.id === item.id).onHand), 0, 'cancellation does not change stock');
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('[data-auto-order-section="history"]').click();
    assert.equal(await page.locator(`[data-auto-order-cancel="${created.id}"]`).count(), 0, 'cancelled state persists after reload');
    assert.match(await page.locator('#auto-order-history-list').innerText(), /Отменена/);
    const readerContext = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ru-RU' });
    const reader = await readerContext.newPage();
    await signIn(reader, readerLogin);
    assert.equal(await reader.locator('#create-auto-order,#auto-order-select-visible,#auto-order-clear-selection,[data-auto-order-item],[data-auto-order-quantity]').count(), 0, 'read-only role has no write controls');
    await reader.locator('#auto-order-list .auto-order-item-cell b').first().waitFor({ state: 'visible' });
    const readerNames = (await reader.locator('#auto-order-list .auto-order-item-cell b').allInnerTexts()).map(name => name.toLocaleLowerCase('ru-RU'));
    for (const item of ingredients) assert.ok(readerNames.includes(item.name.toLocaleLowerCase('ru-RU')), `read-only role sees ${item.name}`);
    const readerToken = await reader.evaluate(() => localStorage.getItem('crm_session_token'));
    await api('/api/inventory/auto-orders', readerToken, 'POST', { items: [{ itemId: ingredients[0].id, quantity: 100 }] }, 403);
    await api('/api/inventory/auto-orders/' + created.id, readerToken, 'PATCH', { status: 'cancelled' }, 403);
    assert.deepEqual(errors, []);
    console.log('PASS PostgreSQL auto-order selection ' + (useDist ? 'dist' : 'source') + ': search/selection/validation, create503/retry and cancel dialog503/retry, history/API/SQL/stock, reader403, 5 widths');
  } catch (error) {
    await browser?.contexts()[0]?.pages()[0]?.screenshot({ path: path.join(folder, 'failure.png') }).catch(() => {});
    throw error;
  } finally {
    gates.forEach(release => release());
    await browser?.close();
    if (server) {
      const stopped = server.exitCode === null && server.signalCode === null ? once(server, 'close') : Promise.resolve();
      server.kill(); await stopped;
    }
    await client.end();
  }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
