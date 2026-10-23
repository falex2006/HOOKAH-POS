const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE_PATH || 'playwright');
const waitForGate = async current => {
  const deadline = Date.now() + 3000;
  while (!current()) { assert.ok(Date.now() < deadline, 'expected request reached its controlled response gate'); await new Promise(resolve => setTimeout(resolve, 10)); }
  return current();
};

(async () => {
  const root = path.resolve(__dirname, '..');
  const folder = path.join(root, 'tmp/inventory-deletion-requests-browser-qa');
  fs.mkdirSync(folder, { recursive: true });
  const server = spawn(process.execPath, ['server.js'], {
    cwd: root, windowsHide: true,
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', DATABASE_URL: '', AUTH_REQUIRED: 'true', DEMO_MODE: 'false', DEMO_OWNER_PASSWORD: 'demo', DEMO_STAFF_PASSWORD: 'demo', NODE_ENV: 'test', API_RATE_LIMIT: '10000' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let browser;
  try {
    const base = await new Promise((resolve, reject) => {
      let output = '';
      const timeout = setTimeout(() => reject(Error('QA server start timeout')), 15000);
      server.stdout.on('data', chunk => { output += chunk; const port = output.match(/CRM running on http:\/\/localhost:(\d+)/)?.[1]; if (port) { clearTimeout(timeout); resolve('http://127.0.0.1:' + port); } });
      server.stderr.on('data', () => {});
      server.once('error', error => { clearTimeout(timeout); reject(error); });
      server.once('exit', code => { clearTimeout(timeout); reject(Error('QA server exited ' + code)); });
    });
    const api = async (route, token, method = 'GET', data, expected = 200) => {
      const response = await fetch(base + route, { method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });
      const body = await response.json();
      assert.equal(response.status, expected, `${method} ${route}: ${body.error || ''}`);
      return body;
    };
    const login = username => api('/api/login', '', 'POST', { username, password: 'demo' });
    const owner = await login('owner');
    for (const username of ['qa_manager', 'qa_other_manager']) await api('/api/staff', owner.token, 'POST', { name: username, role: 'manager', login: username, password: 'demo', birthDate: '1990-01-01', permissionScopes: ['inventory_categories'] }, 201);
    await api('/api/staff', owner.token, 'POST', { name: 'qa_bartender', role: 'bartender', login: 'qa_bartender', password: 'demo', birthDate: '1990-01-01' }, 201);
    const manager = await login('qa_manager');
    const other = await login('qa_other_manager');
    const bartender = await login('qa_bartender');
    const department = await api('/api/inventory/departments', owner.token, 'POST', { code: 'qa-request', name: 'QA Цех' }, 201);
    const category = await api('/api/product-categories', owner.token, 'POST', { name: 'QA Архивная категория с длинным названием для проверки', department: department.id, subdepartmentId: null }, 201);
    await api('/api/product-categories/' + encodeURIComponent(category.id), owner.token, 'DELETE');
    const request = await api('/api/inventory/deletion-requests', manager.token, 'POST', { entityType: 'category', entityId: category.id }, 201);
    assert.equal((await api('/api/inventory/deletion-requests', manager.token)).items.length, 1);
    assert.equal((await api('/api/inventory/deletion-requests', other.token)).items.length, 0, 'another manager does not see the request');
    await api(`/api/inventory/deletion-requests/${request.id}/reject`, manager.token, 'POST', undefined, 403);
    await api('/api/inventory/deletion-requests', bartender.token, 'POST', { entityType: 'category', entityId: category.id }, 403);
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ru-RU' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base + '/login');
    await page.locator('#login-username').fill('owner');
    await page.locator('#login-password').fill('demo');
    await page.getByRole('button', { name: 'Войти в систему', exact: true }).click();
    await page.waitForURL(url => !url.pathname.includes('/login'));
    let failRead = true, readCount = 0, releaseRead, holdRead = false, displayRows = null;
    await page.route('**/api/inventory/deletion-requests', async route => {
      if (route.request().method() !== 'GET') return route.continue();
      readCount++;
      if (holdRead) await new Promise(resolve => { releaseRead = resolve; });
      if (failRead) return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"qa_temporary_unavailable"}' });
      if (displayRows) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: displayRows }) });
      return route.continue();
    });
    await page.goto(base + '/inventory?view=directories', { waitUntil: 'networkidle' });
    const section = page.locator('#inventory-deletion-requests');
    const retry = section.locator('[data-deletion-requests-retry]');
    assert.match(await section.innerText(), /Не удалось загрузить/);
    assert.ok((await retry.boundingBox()).height >= 44);
    await section.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(folder, 'error-390.png') });
    holdRead = true;
    const countBefore = readCount;
    await retry.click();
    await page.waitForFunction(() => document.querySelector('[data-deletion-requests-retry]')?.disabled);
    await retry.evaluate(button => button.click());
    assert.equal(readCount, countBefore + 1, 'disabled retry suppresses a duplicate GET');
    await waitForGate(() => releaseRead);
    releaseRead(); holdRead = false;
    await retry.locator('xpath=self::*[not(@disabled)]').waitFor();
    assert.equal(await page.evaluate(() => document.activeElement?.hasAttribute('data-deletion-requests-retry')), true, 'failed retry restores focus');
    failRead = false;
    await retry.click();
    const reject = section.locator('[data-request-decision="reject"]');
    const approve = section.locator('[data-request-decision="approve"]');
    await reject.waitFor();
    assert.match(await section.innerText(), /QA Цех/, 'request resolves its department code to the displayed name');
    assert.doesNotMatch(await section.innerText(), /qa-request/, 'raw department code is not shown');
    await page.waitForFunction(() => document.activeElement?.getAttribute('data-request-decision') === 'reject');
    assert.equal(await approve.evaluate(button => button.classList.contains('primary')), false, 'destructive approval is not an ordinary primary action');
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: width < 500 ? 844 : 1000 });
      await section.scrollIntoViewIfNeeded();
      const boxes = await section.locator('[data-request-decision]').evaluateAll(buttons => buttons.map(button => { const r = button.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, bottom: r.bottom }; }));
      assert.ok(boxes.every(box => box.height >= 44));
      if (width <= 760) { assert.ok(Math.abs(boxes[0].x - boxes[1].x) < 1); assert.ok(Math.abs(boxes[0].width - boxes[1].width) < 1); assert.ok(boxes[1].y - boxes[0].bottom >= 10); }
      else { assert.ok(Math.abs(boxes[0].y - boxes[1].y) < 1); assert.ok(boxes[0].x < boxes[1].x); }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'no horizontal document overflow at ' + width);
      if (width === 320) {
        const catalogBox = await page.locator('#open-products').boundingBox();
        const guideBox = await page.locator('.inventory-directory-guide').boundingBox();
        assert.equal(catalogBox.height, 44, 'catalog action keeps one line rather than splitting words');
        assert.equal(guideBox.height, 44, 'guide and catalog targets share height');
        assert.ok(Math.abs(catalogBox.width - guideBox.width) < 1);
      }
      await page.screenshot({ path: path.join(folder, 'owner-' + width + '.png') });
    }
    const managerContext = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'ru-RU' });
    const managerPage = await managerContext.newPage();
    managerPage.on('pageerror', error => errors.push(error.message));
    await managerPage.goto(base + '/login');
    await managerPage.locator('#login-username').fill('qa_manager');
    await managerPage.locator('#login-password').fill('demo');
    await managerPage.getByRole('button', { name: 'Войти в систему', exact: true }).click();
    await managerPage.waitForURL(url => !url.pathname.includes('/login'));
    await managerPage.goto(base + '/inventory?view=directories', { waitUntil: 'networkidle' });
    const managerSection = managerPage.locator('#inventory-deletion-requests');
    await managerSection.waitFor();
    assert.equal(await managerPage.locator('#inventory-header-actions').isVisible(), false, 'category manager does not receive a misleading read-only header');
    assert.equal(await managerPage.locator('#inventory-header-actions button').count(), 0, 'header does not grant new create actions');
    assert.match(await managerSection.innerText(), /QA Цех/);
    assert.equal(await managerSection.locator('[data-request-decision]').count(), 0, 'manager cannot decide deletion requests');
    assert.doesNotMatch(await managerPage.locator('#product-category-list').innerText(), /добавьте|создайте/i, 'empty category list does not suggest a forbidden create action');
    assert.doesNotMatch(await managerPage.locator('#inventory-subdepartment-list').innerText(), /можно добавить/i);
    await managerPage.locator('[data-inventory-directory-status="archived"]').click();
    const managedCategory = managerPage.locator('#product-category-list [data-request-type="category"]');
    await managerPage.locator('#product-category-list .directory-row-actions summary').first().click();
    assert.equal(await managedCategory.isVisible(), true, 'category lifecycle remains available to the category manager');
    for (const width of [320, 390, 768, 1440]) {
      await managerPage.setViewportSize({ width, height: width < 500 ? 844 : 1000 });
      const drawerToggle = managerPage.locator('.sidebar-mobile-toggle');
      if (await drawerToggle.isVisible() && await drawerToggle.getAttribute('aria-expanded') === 'true') await drawerToggle.click();
      const categoryMenu = managerPage.locator('#product-category-list .directory-row-actions').first();
      const categorySummary = categoryMenu.locator('summary');
      if (await categoryMenu.getAttribute('open') !== null) await categorySummary.click();
      await categorySummary.evaluate(node => node.scrollIntoView({ block: 'end' }));
      await categorySummary.click();
      await managerPage.waitForFunction(() => {
        const actions = document.querySelector('#product-category-list .directory-row-actions[open] .directory-action-list');
        if (!actions) return false;
        const rect = actions.getBoundingClientRect();
        const headerBottom = document.querySelector('.portal-header')?.getBoundingClientRect().bottom || 0;
        return rect.top >= Math.max(0, headerBottom) && rect.bottom <= innerHeight + 1 && [...actions.querySelectorAll('button')].every(button => {
          const box = button.getBoundingClientRect();
          return button.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
        });
      }, undefined, { timeout: 2500 });
      assert.equal(await categoryMenu.locator('button').evaluateAll(buttons => buttons.every(button => {
        const rect = button.getBoundingClientRect();
        return button.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
      })), true, 'every opened category action is immediately reachable at ' + width);
      assert.equal(await managerPage.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'manager directory fits width ' + width);
      if ([390, 1440].includes(width)) {
        await managerPage.screenshot({ path: path.join(folder, 'manager-actions-' + width + '.png') });
        await managerSection.scrollIntoViewIfNeeded();
        await managerPage.screenshot({ path: path.join(folder, 'manager-context-' + width + '.png') });
      }
      await categorySummary.focus();
      await managerPage.keyboard.press('Escape');
      assert.equal(await categoryMenu.getAttribute('open'), null, 'Escape closes category actions');
      assert.equal(await categorySummary.evaluate(node => document.activeElement === node), true, 'Escape retains action summary focus');
    }
    await managerPage.goto(base + '/inventory?view=stock', { waitUntil: 'networkidle' });
    assert.equal(await managerPage.locator('#inventory-header-actions').innerText(), 'Только просмотр', 'stock stays read-only for category manager');
    assert.equal(await managerPage.locator('#inventory-header-actions button').count(), 0);
    await managerPage.route(/\/api\/inventory\/departments\?status=all$/, route => route.fulfill({ status: 200, contentType: 'application/json', body: '{"items":[]}' }));
    await managerPage.goto(base + '/inventory?view=directories', { waitUntil: 'networkidle' });
    assert.match(await managerPage.locator('#inventory-department-list').innerText(), /Цехов пока нет/);
    assert.doesNotMatch(await managerPage.locator('#inventory-department-list').innerText(), /добавьте|создайте/i, 'empty read-only departments have no create instruction');
    await managerContext.close();
    let approvePosts = 0;
    page.on('request', req => { if (req.method() === 'POST' && req.url().endsWith('/approve')) approvePosts++; });
    page.once('dialog', dialog => dialog.dismiss());
    await approve.click();
    assert.equal(approvePosts, 0, 'cancelled confirmation does not delete');
    let releaseReject, rejectPosts = 0, failReject = true;
    await page.route(`**/api/inventory/deletion-requests/${request.id}/reject`, async route => {
      rejectPosts++;
      await new Promise(resolve => { releaseReject = resolve; });
      if (failReject) return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"qa_temporary_unavailable"}' });
      return route.continue();
    });
    await reject.click();
    assert.equal(await reject.isDisabled(), true);
    assert.equal(await approve.isDisabled(), true, 'opposite decision disabled while POST pending');
    await approve.evaluate(button => button.click());
    assert.equal(approvePosts, 0);
    await waitForGate(() => releaseReject);
    releaseReject();
    await reject.locator('xpath=self::*[not(@disabled)]').waitFor();
    assert.equal(await approve.isDisabled(), false);
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-request-decision')), 'reject');
    assert.equal((await api('/api/inventory/deletion-requests', owner.token)).items.length, 1, '503 leaves the real request pending');
    failReject = false; releaseReject = null;
    await reject.click();
    await waitForGate(() => releaseReject);
    releaseReject();
    await section.waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.activeElement?.id === 'inventory-category-search');
    assert.equal(rejectPosts, 2, 'one failed attempt and one successful retry');
    assert.equal((await api('/api/inventory/deletion-requests', owner.token)).items.length, 0);
    assert.equal((await api('/api/inventory/deletion-requests', manager.token)).items.length, 0);
    const categories = await api('/api/product-categories?status=all', owner.token);
    assert.equal(categories.items.find(item => item.id === category.id).active, false, 'reject preserves archived category');
    await page.reload({ waitUntil: 'networkidle' });
    assert.equal(await section.isVisible(), false, 'processed request stays absent after reload');
    assert.equal(approvePosts, 0, 'no irreversible API called');
    // Display-only GET snapshots exercise late/missing parents; these rows never submit a decision.
    displayRows = [request, { ...request, id: 'qa-unknown-parent', parentName: 'qa-missing-parent' }, { ...request, id: 'qa-department-row', entityType: 'department', parentName: null }];
    let releaseDepartments;
    await page.route(/\/api\/inventory\/departments\?status=all$/, async route => {
      await new Promise(resolve => { releaseDepartments = resolve; });
      await route.continue();
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await section.locator('[data-request-decision="reject"]').first().waitFor();
    await waitForGate(() => releaseDepartments);
    assert.doesNotMatch(await section.innerText(), /qa-request|qa-missing-parent|без родителя/, 'unresolved codes and parentless department noise stay hidden');
    assert.equal(await section.locator('[data-request-parent]').first().textContent(), '', 'parent name waits for the independent directory read');
    await section.locator('[data-request-decision="reject"]').first().focus();
    releaseDepartments();
    await page.waitForFunction(() => document.querySelector('#inventory-deletion-requests [data-request-parent]')?.textContent === ' · QA Цех');
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-request-key')), request.id, 'resolving a parent name does not replace the focused action');
    assert.equal(await section.locator('[data-deletion-request-id="qa-unknown-parent"] [data-request-parent]').textContent(), '', 'unknown parent has no technical fallback');
    assert.equal(await section.locator('[data-deletion-request-id="qa-department-row"] [data-request-parent]').count(), 0, 'department request has no meaningless parent label');
    assert.equal(approvePosts, 0, 'display-only synthetic rows never submit a decision');
    assert.deepEqual(errors, []);
    console.log('PASS: deletion-request read/decision error/retry/focus, rejection/readback, manager category header and stock read-only, parent names/late directory read/focus/unknown-parent, ACL, 320/390/768/1440 layout; no approve/delete');
  } finally { await browser?.close(); server.kill(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
