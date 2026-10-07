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
    const category = await post('/api/product-categories', { name: 'QA remaining category', department: 'hookah' });
    const items = [];
    for (let i = 1; i <= 40; i++) items.push(await post('/api/inventory/items', { name: `QA Stock ${String(i).padStart(2, '0')}`, department: 'hookah', category: category.name, unit: 'шт', itemType: 'ingredient', minLevel: 5, cost: 10 }));
    const folder = 'tmp/inventory-remaining-visual'; fs.mkdirSync(folder, { recursive: true });
    const choose = async (selector, value) => { const wrapper = page.locator(selector).locator('xpath=..'); await wrapper.locator('.custom-select-trigger').click(); await wrapper.locator(`[data-value="${value}"]`).click(); };
    const closeMenu = async () => { const menu = page.locator('.sidebar-mobile-toggle'); if (await menu.isVisible() && await menu.getAttribute('aria-expanded') === 'true') await menu.click(); };
    const bounded = async selector => { const box = await page.locator(selector).evaluate(node => ({ height: node.clientHeight, total: node.scrollHeight })); assert.ok(box.total > box.height && box.height <= 650, 'bounded dense list ' + selector); };
    for (const width of [1920, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      await page.goto(base + '/inventory?view=stock', { waitUntil: 'networkidle' }); await closeMenu();
      await page.locator('#inventory-search').fill('QA Stock 40');
      assert.equal(await page.locator('#inventory-rows tr').count(), 1);
      await choose('#inventory-department-filter', 'hookah');
      await page.locator('#inventory-search').fill('QA Stock');
      assert.equal(await page.locator('#inventory-rows tr').count(), 40);
      await bounded('.inventory-stock-panel>.table-wrap');
      await page.screenshot({ path: `${folder}/stock-${width}.png`, fullPage: true });
      await page.locator(`.inventory-item-edit[data-item="${items[39].id}"]`).click();
      await page.locator('#inventory-item-name').fill('Not saved');
      await page.screenshot({ path: `${folder}/stock-editor-${width}.png`, fullPage: true });
      await page.locator('#cancel-inventory-item').click();
      const read = await (await page.request.get(base + '/api/inventory')).json();
      assert.equal(read.items.find(item => item.id === items[39].id).name, items[39].name, 'stock edit cancelled');
      await page.goto(base + '/inventory?view=auto-orders', { waitUntil: 'networkidle' }); await closeMenu();
      await bounded('.auto-order-table-wrap');
      const quantity = page.locator(`[data-auto-order-quantity="${items[0].id}"]`);
      const selected = page.locator(`[data-auto-order-item="${items[0].id}"]`);
      await quantity.fill('17'); await selected.uncheck();
      await page.locator('[data-auto-order-section="history"]').click();
      await page.screenshot({ path: `${folder}/auto-history-${width}.png`, fullPage: true });
      await page.locator('[data-auto-order-section="recommendations"]').click();
      assert.equal(await quantity.inputValue(), '17'); assert.equal(await selected.isChecked(), false);
      await page.screenshot({ path: `${folder}/auto-orders-${width}.png`, fullPage: true });
      await page.goto(base + '/inventory?view=premixes', { waitUntil: 'networkidle' }); await closeMenu();
      assert.equal(await page.locator('#premix-form').isVisible(), false, 'no prerequisites: form hidden');
      assert.equal(await page.locator('#premix-submit').isDisabled(), true);
      assert.equal(await page.locator('#premix-empty-guidance').isVisible(), true);
      await page.screenshot({ path: `${folder}/premix-empty-${width}.png`, fullPage: true });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'page width');
    }
    const recipe = await post('/api/recipes', { name: 'QA Premix recipe', recipeType: 'premix', yieldQuantity: 1, yieldUnit: 'шт', portionCount: 1, ingredients: [{ ingredientId: items[0].id, quantity: 1, unit: 'шт' }] });
    for (const width of [1920, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      await page.goto(base + '/inventory?view=premixes', { waitUntil: 'networkidle' }); await closeMenu();
      await page.locator('#premix-production > summary').click();
      assert.equal(await page.locator('#premix-form').isVisible(), true, 'ready form shown');
      assert.equal(await page.locator('#premix-submit').isDisabled(), false);
      await choose('#premix-recipe', recipe.id);
      await choose('#premix-output', items[1].id);
      await page.screenshot({ path: `${folder}/premix-ready-${width}.png`, fullPage: true });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    }
    assert.deepEqual(errors, []);
    console.log('PASS remaining inventory:40 items,stock search/filter/cancel,bounded recommendations,selection persistence,premix empty+ready,1920/390');
  } catch (error) {
    const page = browser?.contexts()[0]?.pages()[0];
    if (page) { fs.mkdirSync('tmp/inventory-remaining-visual', { recursive: true }); await page.screenshot({ path: 'tmp/inventory-remaining-visual/failure.png', fullPage: true }).catch(() => {}); }
    throw error;
  } finally { await browser?.close(); server.kill(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

