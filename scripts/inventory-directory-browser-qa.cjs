const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE_PATH || 'playwright');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const assert = require('node:assert/strict');

(async () => {
  const server = spawn(process.execPath, ['server.js'], { windowsHide: true, env: { ...process.env, HOST: '127.0.0.1', PORT: '0', DATABASE_URL: '', API_RATE_LIMIT: '10000', AUTH_REQUIRED: 'false', DEMO_MODE: 'false', NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  server.stdout.on('data', data => output += data);
  server.stderr.on('data', data => output += data);
  let browser;
  try {
    const base = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error(output || 'Local server did not start')), 15000);
      server.stdout.on('data', () => { const match = output.match(/CRM running on http:\/\/localhost:(\d+)/); if (match) { clearTimeout(timer); resolve('http://127.0.0.1:' + match[1]); } });
      server.once('exit', code => { clearTimeout(timer); reject(Error('Local server exited ' + code)); });
    });
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, locale: 'ru-RU' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => dialog.accept());
    await page.goto(base + '/login');
    await page.locator('#login-username').fill('admin');
    await page.locator('#login-password').fill('admin');
    await page.locator('#login-form button[type=submit]').click();
    await page.waitForURL(url => !url.pathname.includes('/login'));
    const post = async (path, data) => { const response = await page.request.post(base + path, { data }); assert.equal(response.status(), 201, await response.text()); return response.json(); };
    const assertDialogActionLayout = async (formSelector, expectedLabels, width) => {
      const buttons = page.locator(`${formSelector} .toolbar-row > button:visible`);
      assert.deepEqual(await buttons.allTextContents(), expectedLabels, `dialog action order at ${width}px`);
      const boxes = await buttons.evaluateAll(nodes => nodes.map(node => {
        const rect = node.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      }));
      assert.equal(boxes.length, 2);
      if (width > 560) {
        assert.ok(boxes[0].x < boxes[1].x, `cancel precedes primary visually at ${width}px`);
        assert.ok(Math.abs(boxes[0].y - boxes[1].y) <= 1, `dialog actions share a row at ${width}px`);
      } else {
        assert.ok(Math.abs(boxes[0].x - boxes[1].x) <= 1, `mobile dialog actions align at ${width}px`);
        assert.ok(Math.abs(boxes[0].width - boxes[1].width) <= 1, `mobile dialog actions share a width at ${width}px`);
        assert.ok(boxes[0].y < boxes[1].y, `mobile cancel precedes primary vertically at ${width}px`);
      }
      assert.ok(boxes.every(box => box.height >= 44), `dialog action targets are at least 44px at ${width}px`);
    };
    const department = await post('/api/inventory/departments', { code: 'qa-directory', name: 'QA Цех' });
    const other = await post('/api/inventory/departments', { code: 'qa-other', name: 'QA Другой цех' });
    const sub = await post('/api/inventory/subdepartments', { departmentCode: department.id, name: 'QA Подцех' });
    const direct = await post('/api/product-categories', { department: department.id, name: 'QA Без подцеха', subdepartmentId: null });
    const nested = await post('/api/product-categories', { department: department.id, name: 'QA В подцехе', subdepartmentId: sub.id });
    await post('/api/product-categories', { department: other.id, name: 'QA Другая категория', subdepartmentId: null });
    await page.goto(base + '/inventory?view=directories', { waitUntil: 'networkidle' });
    const categoryRows = page.locator('#product-category-list .category-row');
    for (const [open, select, field, cancel] of [
      ['#new-product-category', '#product-category-department', '#product-category-name', '#cancel-product-category'],
      ['#new-inventory-subdepartment', '#inventory-subdepartment-department', '#inventory-subdepartment-name', '#cancel-inventory-subdepartment']
    ]) {
      await page.locator(open).click();
      assert.equal(await page.locator(select).inputValue(), '', 'all-departments view requires an explicit parent');
      await page.locator(field).fill('QA must choose parent');
      assert.equal(await page.locator(select).evaluate(node => node.validity.valueMissing), true, 'parent is mandatory');
      const form = page.locator(select).locator('xpath=ancestor::form');
      await form.locator('button[type="submit"]').click();
      assert.equal(await form.locator('.form-message').innerText(), 'Выберите цех перед сохранением.');
      assert.equal(await form.isVisible(), true, 'missing parent keeps the editor open');
      await page.locator(cancel).click();
    }
    await page.locator(`[data-inventory-department="${department.id}"]`).first().click();
    await page.locator('[data-directory-subdepartment="*"]').click();
    assert.equal(await categoryRows.count(), 2, 'all subdepartments includes whole-department categories');
    await page.locator('[data-directory-subdepartment=""]').click();
    assert.equal(await categoryRows.count(), 1);
    assert.ok((await categoryRows.innerText()).toLocaleLowerCase().includes(direct.name.toLocaleLowerCase()));
    await page.locator(`[data-directory-subdepartment="${sub.id}"]`).click();
    assert.equal(await categoryRows.count(), 1);
    assert.ok((await categoryRows.innerText()).toLocaleLowerCase().includes(nested.name.toLocaleLowerCase()));
    await page.locator('#inventory-category-search').fill('Не существует');
    assert.equal(await categoryRows.count(), 0, 'search empty result');
    await page.locator('#inventory-category-search').fill('');
    await page.locator('#new-product-category').click();
    assert.equal(await page.locator('#product-category-department').inputValue(), department.id);
    assert.equal(await page.locator('#product-category-subdepartment').inputValue(), sub.id);
    await page.locator('#product-category-name').fill('QA Создана через форму');
    await page.locator('#product-category-form button[type=submit]').click();
    await page.locator('dialog.directory-editor-modal[open]').waitFor({ state: 'hidden' });
    const readCategories = async () => (await (await page.request.get(base + '/api/product-categories?status=all')).json()).items;
    const created = (await readCategories()).find(item => item.name === 'QA Создана через форму');
    assert.ok(created, 'UI create persisted in API');
    const edit = page.locator(`.product-category-edit[data-category="${created.id}"]`);
    const openActions = async action => { const details = action.locator('xpath=ancestor::details'); if (await details.count() && !(await details.getAttribute('open') !== null)) await details.locator('summary').click(); };
    await openActions(edit); await edit.click();
    await page.locator('#product-category-name').fill('QA Отменённое имя');
    await page.locator('#cancel-product-category').click();
    assert.equal((await readCategories()).find(item => item.id === created.id).name, created.name, 'cancel does not save');
    await openActions(edit); await edit.click();
    await page.locator('#product-category-name').fill('QA Переименована');
    await page.locator('#product-category-form button[type=submit]').click();
    await page.locator('dialog.directory-editor-modal[open]').waitFor({ state: 'hidden' });
    assert.equal((await readCategories()).find(item => item.id === created.id).name, 'QA Переименована');
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator(`[data-inventory-department="${department.id}"]`).first().click();
    await page.locator(`[data-directory-subdepartment="${sub.id}"]`).click();
    const archive = page.locator(`[data-archive-type="category"][data-archive-id="${created.id}"]`);
    await openActions(archive); await archive.click();
    await page.locator('[data-inventory-directory-status="archived"]').click();
    const restore = page.locator(`[data-restore-type="category"][data-restore-id="${created.id}"]`);
    await restore.waitFor({ state: 'attached' }); await openActions(restore); await restore.click();
    await page.locator('[data-inventory-directory-status="active"]').click();
    await page.waitForFunction(id => !!document.querySelector(`.product-category-edit[data-category="${id}"]`), created.id);
    assert.equal((await readCategories()).find(item => item.id === created.id).active, true);
    // A dense real API fixture reproduces the long-directory layout, in one batch.
    for (let index = 1; index <= 40; index++) await post('/api/product-categories', { department: department.id, name: `QA Много категорий ${String(index).padStart(2, '0')}`, subdepartmentId: sub.id });
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator(`[data-inventory-department="${department.id}"]`).click();
    await page.locator(`[data-directory-subdepartment="${sub.id}"]`).click();
    assert.equal(await categoryRows.count(), 42, 'dense fixture loaded');
    fs.mkdirSync('tmp/inventory-directory-visual', { recursive: true });
    for (const width of [1920, 1366, 1281, 1280, 1101, 1024, 814, 761, 760, 720, 390, 320]) {
      await page.setViewportSize({ width, height: width < 500 ? 844 : 1000 });
      if (width < 500) {
        const menu = page.locator('.sidebar-mobile-toggle');
        if (await menu.getAttribute('aria-expanded') === 'true') await menu.click();
        assert.equal(await menu.getAttribute('aria-expanded'), 'false', 'mobile drawer closed');
        await page.locator(`[data-inventory-department="${other.id}"]`).click();
        await page.locator('[data-directory-subdepartment=""]').click();
        assert.equal(await categoryRows.count(), 1, 'mobile whole-department navigation');
        await page.locator(`[data-inventory-department="${department.id}"]`).click();
        await page.locator(`[data-directory-subdepartment="${sub.id}"]`).click();
        assert.equal(await categoryRows.count(), 42, 'mobile subdepartment navigation');
      }
      const rowAlignment = await page.locator('#inventory-department-list .category-row').evaluateAll(rows => rows.map(row => {
        const button = row.querySelector('.directory-select');
        const action = row.querySelector('summary');
        if (!button || !action) return true;
        const b = button.getBoundingClientRect(), a = action.getBoundingClientRect();
        return getComputedStyle(button).textAlign === 'left' && a.left >= b.right - 1 && a.top < b.bottom;
      }));
      assert.ok(rowAlignment.every(Boolean), 'department names align left and actions stay beside each row at ' + width);
      const categoryList = page.locator('#product-category-list');
      const scroll = await categoryList.evaluate(node => ({ scrollHeight: node.scrollHeight, clientHeight: node.clientHeight, overflowY: getComputedStyle(node).overflowY }));
      if (width <= 760) {
        assert.ok(scroll.clientHeight >= scroll.scrollHeight, 'mobile category list expands with the page instead of nesting a scroll area at ' + width);
        assert.equal(scroll.overflowY, 'visible', 'mobile category list does not create an inner scrollbar at ' + width);
      } else {
        assert.ok(scroll.scrollHeight > scroll.clientHeight, 'dense desktop category list scrolls locally at ' + width);
        assert.ok(scroll.clientHeight <= 520, 'desktop category list remains bounded at ' + width);
        assert.equal(scroll.overflowY, 'auto');
      }
      const mainHeight = await page.locator('.portal-main').evaluate(node => node.scrollHeight);
      if (width > 760) assert.ok(mainHeight < (width <= 1280 ? 2400 : 1300), 'desktop page does not grow with 40 categories at ' + width);
      const lastEdit = categoryRows.last().locator('.product-category-edit');
      await openActions(lastEdit);
      await page.waitForFunction(() => {
        const actions = document.querySelector('#product-category-list .directory-row-actions[open] .directory-action-list');
        if (!actions) return false;
        const rect = actions.getBoundingClientRect();
        const headerBottom = document.querySelector('.portal-header')?.getBoundingClientRect().bottom || 0;
        return rect.top >= Math.max(0, headerBottom) && rect.bottom <= innerHeight + 1 && [...actions.querySelectorAll('button')].every(button => {
          const box = button.getBoundingClientRect();
          return button.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
        });
      }, undefined, { timeout: 2500 });
      assert.equal(await lastEdit.evaluate(node => { const box = node.getBoundingClientRect(); return node.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)); }), true, 'last row action not clipped at ' + width);
      await page.screenshot({ path: `tmp/inventory-directory-visual/last-action-${width}.png`, fullPage: true });
      await lastEdit.click();
      await page.locator('#product-category-name').waitFor({ state: 'visible' });
      await page.locator('#cancel-product-category').click();
      await categoryList.evaluate(node => node.scrollTop = 0);
      await page.evaluate(() => { document.querySelectorAll('.portal-main,.portal-content').forEach(node => node.scrollTop = 0); window.scrollTo(0, 0); });
      console.log(JSON.stringify({ width, firstDepartmentRowY: await page.locator('#inventory-department-list').evaluate(node => node.getBoundingClientRect().top) }));
      await page.screenshot({ path: `tmp/inventory-directory-visual/${width}.png`, fullPage: true });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'page overflow at ' + width);
      await page.locator('#new-product-category').click();
      await page.locator('#product-category-name').waitFor({ state: 'visible' });
      await assertDialogActionLayout('#product-category-form', ['Отмена', 'Сохранить'], width);
      assert.equal(await page.locator('#product-category-department').inputValue(), department.id, 'modal department remains selected at ' + width);
      assert.equal(await page.locator('#product-category-subdepartment').inputValue(), sub.id);
      await page.screenshot({ path: `tmp/inventory-directory-visual/modal-${width}.png`, fullPage: true });
      assert.equal(await page.locator('#product-category-department').inputValue(), department.id, 'modal department survives asynchronous refresh at ' + width);
      assert.equal(await page.locator('#product-category-department').locator('xpath=..').locator('.custom-select-trigger').innerText(), department.name, 'visible department matches selected value');
      const modal = await page.locator('dialog.directory-editor-modal[open]').boundingBox();
      assert.ok(modal.x >= 0 && modal.x + modal.width <= width + 1, 'modal inside viewport');
      await page.locator('#cancel-product-category').click();
      await page.locator('#new-inventory-department').click();
      await page.locator('#inventory-department-name').waitFor({ state: 'visible' });
      await assertDialogActionLayout('.department-editor:has(#inventory-department-name)', ['Отмена', 'Сохранить цех'], width);
      await page.locator('#cancel-inventory-department').click();
      await page.locator('#new-inventory-subdepartment').click();
      await page.locator('#inventory-subdepartment-name').waitFor({ state: 'visible' });
      await assertDialogActionLayout('.department-editor:has(#inventory-subdepartment-name)', ['Отмена', 'Сохранить подцех'], width);
      await page.locator('#cancel-inventory-subdepartment').click();
    }
    assert.deepEqual(errors, [], 'browser runtime errors');
    console.log('PASS inventory directory cascade, search, create/edit/cancel, API persistence, archive/restore, responsive');
  } catch (error) {
    const page = browser?.contexts()[0]?.pages()[0];
    if (page) { fs.mkdirSync('tmp/inventory-directory-visual', { recursive: true }); await page.screenshot({ path: 'tmp/inventory-directory-visual/failure.png', fullPage: true }).catch(() => {}); }
    throw error;
  } finally { await browser?.close(); server.kill(); }
})().catch(error => { console.error(error); process.exitCode = 1; });


