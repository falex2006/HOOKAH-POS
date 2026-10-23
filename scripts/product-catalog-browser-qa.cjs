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
  const folder = `tmp/product-catalog-browser-${Date.now()}`;
  fs.mkdirSync(folder, { recursive: true });
  try {
    const base = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error(output || 'Local test server did not start')), 15000);
      server.stdout.on('data', () => { const match = output.match(/CRM running on http:\/\/localhost:(\d+)/); if (match) { clearTimeout(timer); resolve('http://127.0.0.1:' + match[1]); } });
      server.once('exit', code => { clearTimeout(timer); reject(Error('Local test server exited ' + code)); });
    });
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'ru-RU' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => dialog.accept());
    await page.goto(base + '/login');
    await page.locator('#login-username').fill('admin');
    await page.locator('#login-password').fill('admin');
    await page.locator('#login-form button[type=submit]').click();
    await page.waitForURL(url => !url.pathname.includes('/login'));
    const products = [];
    for (let i = 0; i < 36; i++) {
      const category = i % 3 === 0 ? 'Бар' : i % 3 === 1 ? 'Кальяны' : 'Кухня';
      const preparationStation = i % 3 === 0 ? 'bar' : i % 3 === 1 ? 'hookah' : null;
      const item = { name: `QA Товар ${String(i + 1).padStart(2, '0')}`, category, price: (i + 1) * 50, inventoryMode: i % 4 === 0 ? 'non_stock' : 'tracked', preparationStation, aliases: i === 0 ? ['тестовый лимонад'] : [] };
      const response = await page.request.post(base + '/api/products', { data: item });
      assert.equal(response.status(), 201, await response.text()); products.push(await response.json());
    }
    await page.goto(base + '/inventory?view=products', { waitUntil: 'networkidle' });
    await page.locator('.product-list-row').first().waitFor();
    assert.equal(await page.locator('#visual-catalog .product-list-row').count(), 36, 'default wide list renders all products');
    assert.equal(await page.locator('#visual-catalog').getAttribute('data-view'), 'list');
    await page.screenshot({ path: `${folder}/product-catalog-list-1440.png`, fullPage: true });
    await page.evaluate(() => document.body.classList.add('light-theme'));
    await page.screenshot({ path: `${folder}/product-catalog-list-light-1440.png`, fullPage: true });
    await page.evaluate(() => document.body.classList.remove('light-theme'));

    await page.locator('#product-category-filter').selectOption({ label: 'Бар' });
    await page.locator('#product-preparation-filter').selectOption('bar');
    assert.equal(await page.locator('#visual-catalog .product-list-row').count(), 12, 'category and preparation filters intersect');
    await page.locator('#product-search').fill('тестовый лимонад');
    assert.equal(await page.locator('#visual-catalog .product-list-row').count(), 1, 'search combines with selected filters and aliases');
    await page.locator('#product-filter-reset').click();
    assert.equal(await page.locator('#visual-catalog .product-list-row').count(), 36, 'reset restores unfiltered rows');
    assert.equal(await page.locator('#product-category-filter').evaluate(node => node.parentElement.querySelector('.custom-select-trigger')?.textContent.trim()), 'Все категории', 'reset refreshes the visible category control');
    assert.equal(await page.locator('#product-preparation-filter').evaluate(node => node.parentElement.querySelector('.custom-select-trigger')?.textContent.trim()), 'Все направления', 'reset refreshes the visible preparation control');
    await page.locator('#product-sort').selectOption('price-desc');
    assert.match(await page.locator('#visual-catalog .product-list-row').first().innerText(), /QA Товар 36/);
    await page.locator('#product-sort').selectOption('name');

    for (const view of ['table', 'cards', 'list']) {
      await page.locator(`[data-product-view="${view}"]`).click();
      if (view === 'table') assert.equal(await page.locator('#visual-catalog .product-table tbody tr').count(), 36);
      else if (view === 'cards') assert.equal(await page.locator('#visual-catalog .product-tile').count(), 36);
      else assert.equal(await page.locator('#visual-catalog .product-list-row').count(), 36);
      if (view === 'cards') {
        assert.equal(await page.locator('.product-tile .visual-product-placeholder span').first().isVisible(), false, 'card placeholder does not visibly repeat the category');
        assert.match(await page.locator('.product-tile').first().innerText(), /Направление: Бар/, 'card distinguishes preparation from menu category');
      }
      await page.screenshot({ path: `${folder}/product-catalog-${view}-1440.png`, fullPage: true });
    }
    assert.equal(await page.locator('#visual-catalog .product-open').first().getAttribute('aria-label'), 'Открыть товар QA Товар 01');
    await page.locator('.product-list-row .product-open').first().focus();
    await page.keyboard.press('Enter');
    await page.locator('#product-detail-dialog[open]').waitFor();
    assert.match(await page.locator('#product-detail-body').innerText(), /Цена продажи|Категория меню/);
    await page.screenshot({ path: `${folder}/product-catalog-detail-1440.png`, fullPage: true });
    await page.keyboard.press('Escape');
    await page.locator('#product-detail-dialog[open]').waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Открыть товар QA Товар 01', 'Escape returns focus to the product opener');
    await page.locator('.product-list-row .product-open').first().click();
    await page.locator('#product-detail-edit').click();
    await page.locator('#product-form:not([hidden])').waitFor();
    assert.equal(await page.locator('#product-name').inputValue(), products[0].name, 'detail edit action opens the selected product');
    await page.locator('#cancel-product').click();
    assert.equal((await (await page.request.get(base + '/api/products')).json()).items[0].name, products[0].name, 'cancel leaves product unchanged');
    await page.locator(`[data-product="${products[0].id}"].product-edit`).click();
    await page.locator('#product-name').fill('QA Товар изменён через форму');
    await page.locator('#save-product').click();
    await page.waitForFunction(id => document.querySelector('#product-form')?.hidden === true, products[0].id);
    let readback = (await (await page.request.get(base + '/api/products')).json()).items.find(item => item.id === products[0].id);
    assert.equal(readback.name, 'QA Товар изменён через форму', 'edit save persists and closes after readback');
    const imageBuffer = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/mZcAAAAASUVORK5CYII=', 'base64');
    const photoProductId = products[0].id;
    assert.equal(await page.locator('.product-photo-action').count(), 0, 'photo replacement is kept inside the product editor, not repeated as a large row action');
    await page.locator(`[data-product="${photoProductId}"].product-edit`).click();
    await page.locator('#product-form:not([hidden])').waitFor();
    const photoButton = page.getByRole('button', { name: 'Загрузить фото', exact: true });
    assert.equal(await photoButton.count(), 1, 'editor has a named photo control');
    await photoButton.focus();
    assert.equal(await photoButton.evaluate(node => node === document.activeElement), true, 'photo control can receive keyboard focus');
    const keyboardFileChooser = page.waitForEvent('filechooser');
    await page.keyboard.press('Space');
    await (await keyboardFileChooser).setFiles({ name: 'qa.png', mimeType: 'image/png', buffer: imageBuffer });
    await page.waitForFunction(() => document.querySelector('#product-form')?.dataset.imageProcessing === '0' && Boolean(document.querySelector('#product-image-preview img')));
    assert.equal(await page.locator('#product-image-action-label').innerText(), 'Заменить фото', 'editor clarifies that an existing photo will be replaced');
    await page.locator('#save-product').click();
    await page.waitForFunction(() => document.querySelector('#product-form')?.hidden === true);
    readback = (await (await page.request.get(base + '/api/products')).json()).items.find(item => item.id === photoProductId);
    assert.ok(readback.imageUrl, 'photo replacement from the editor persists');
    const restored = await page.request.patch(base + `/api/products/${photoProductId}`, { data: { imageUrl: null } });
    assert.equal(restored.status(), 200);
    readback = (await (await page.request.get(base + '/api/products')).json()).items.find(item => item.id === products[0].id);
    assert.equal(readback.imageUrl, null, 'synthetic uploaded image is removed from memory fixture before exit');

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(base + '/inventory?view=products', { waitUntil: 'networkidle' });
    assert.equal(await page.locator('.product-catalog-view-switch').isVisible(), false, 'view switch is hidden on phone');
    assert.equal(await page.locator('#visual-catalog').getAttribute('data-view'), 'list', 'phone forces the single list view');
    assert.equal(await page.locator('#visual-catalog .product-list-row').count(), 36);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'phone page has no horizontal overflow');
    await page.locator('.product-list-row').first().evaluate(node => node.scrollIntoView({ block: 'center' }));
    await page.screenshot({ path: `${folder}/product-catalog-list-390.png` });
    await page.locator('.product-list-row .product-open').first().click();
    await page.locator('#product-detail-dialog[open]').waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'mobile detail dialog has no horizontal overflow');
    await page.screenshot({ path: `${folder}/product-catalog-detail-390.png` });
    await page.keyboard.press('Escape');
    await page.locator('.product-list-row .product-edit').first().click();
    await page.locator('#product-form:not([hidden])').waitFor();
    const actionBoxes = await page.locator('#save-product, #cancel-product, #delete-product').evaluateAll(nodes => nodes.map(node => { const rect = node.getBoundingClientRect(); return { height: rect.height, y: rect.y, visible: rect.height > 0 }; }));
    assert.equal(actionBoxes.filter(action => action.visible).length, 3, 'product edit shows save, cancel, and delete actions on mobile');
    assert.ok(Math.abs(actionBoxes[0].height - actionBoxes[1].height) <= 1 && Math.abs(actionBoxes[0].y - actionBoxes[1].y) <= 1, 'save and cancel buttons share a row and matching height on mobile');
    assert.ok(actionBoxes[2].y > actionBoxes[1].y + actionBoxes[1].height, 'delete action sits on a separate lower row on mobile');
    await page.screenshot({ path: `${folder}/product-catalog-editor-390.png`, fullPage: true });
    await page.locator('#cancel-product').evaluate(node => node.scrollIntoView({ block: 'center' }));
    await page.screenshot({ path: `${folder}/product-catalog-editor-actions-390.png` });
    await page.locator('#cancel-product').click();
    for (const width of [320, 600, 720, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `no horizontal overflow at ${width}px`);
      if (width <= 760) {
        assert.equal(await page.locator('#visual-catalog').getAttribute('data-view'), 'list', `list forced at ${width}px`);
        const hitArea = await page.locator('.product-list-row .product-edit').first().evaluate(node => { const rect = node.getBoundingClientRect(); const before = getComputedStyle(node, '::before'); const left = Math.abs(parseFloat(before.left) || 0); const top = Math.abs(parseFloat(before.top) || 0); return { width: rect.width + left * 2, height: rect.height + top * 2 }; });
        assert.ok(hitArea.width >= 40 && hitArea.height >= 40, `compact edit icon retains a practical touch target at ${width}px`);
      }
    }
    assert.deepEqual(errors, []);
    console.log('PASS product catalog browser QA:36 synthetic products, search/category/preparation intersection, reset/sort, list/table/cards, detail/edit/cancel, mobile 320/390/600/720/760 and desktop 768/1024/1440, zero page errors');
  } catch (error) {
    const page = browser?.contexts()[0]?.pages()[0];
    if (page) await page.screenshot({ path: `${folder}/failure.png`, fullPage: true }).catch(() => {});
    throw error;
  } finally { await browser?.close(); server.kill(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
