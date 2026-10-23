const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE_PATH || 'playwright');

(async () => {
  const useDist = process.env.RECIPE_WIZARD_USE_DIST === '1';
  const folder = path.resolve('tmp/recipe-wizard-focus-browser-qa', useDist ? 'dist' : 'source');
  fs.mkdirSync(folder, { recursive: true });
  const server = spawn(process.execPath, ['server.js'], {
    windowsHide: true,
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', DATABASE_URL: '', AUTH_REQUIRED: 'true', DEMO_MODE: 'false', DEMO_OWNER_PASSWORD: 'demo', DEMO_STAFF_PASSWORD: 'demo', NODE_ENV: 'test', API_RATE_LIMIT: '10000' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let browser;
  try {
    const base = await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(Error('Recipe QA startup timeout')), 15000);
      server.stdout.on('data', data => {
        output += data;
        const port = output.match(/CRM running on http:\/\/localhost:(\d+)/)?.[1];
        if (port) { clearTimeout(timer); resolve('http://127.0.0.1:' + port); }
      });
      server.once('error', error => { clearTimeout(timer); reject(error); });
      server.once('exit', code => { clearTimeout(timer); reject(Error('QA server exited ' + code)); });
    });
    const api = async (route, token, method = 'GET', body, expected = 200) => {
      const response = await fetch(base + route, { method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      const data = await response.json();
      assert.equal(response.status, expected, route + ': ' + (data.error || ''));
      return data;
    };
    const seed = await api('/api/login', '', 'POST', { username: 'owner', password: 'demo' });
    const ingredient = await api('/api/inventory/items', seed.token, 'POST', { name: 'QA Вода', department: 'bar', category: 'Вода', unit: 'мл', itemType: 'ingredient', minLevel: 0, cost: 0.01 }, 201);
    await api('/api/staff', seed.token, 'POST', { name: 'QA Просмотр склада', role: 'manager', login: 'qa_recipe_viewer', password: 'demo', birthDate: '1990-01-01', permissionScopes: ['inventory_categories'] }, 201);
    await api('/api/logout', seed.token, 'POST');
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: 'ru-RU' });
    const errors = [];
    let recipeWrites = 0;
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/recipes') && request.method() !== 'GET') recipeWrites++; });
    const signIn = async (target, username) => {
      if (useDist) {
        await target.route(/\/portal\.js(?:\?|$)/, route => route.fulfill({ path: path.resolve(__dirname, '../dist/portal.js'), contentType: 'text/javascript' }));
        await target.route(/\/style\.css(?:\?|$)/, route => route.fulfill({ path: path.resolve(__dirname, '../dist/style.css'), contentType: 'text/css' }));
      }
      await target.goto(base + '/login');
      await target.locator('#login-username').fill(username);
      await target.locator('#login-password').fill('demo');
      await target.getByRole('button', { name: 'Войти в систему', exact: true }).click();
      await target.waitForURL(url => !url.pathname.includes('/login'));
      await target.goto(base + '/inventory?view=recipes', { waitUntil: 'networkidle' });
    };
    await signIn(page, 'owner');
    await page.locator('#new-recipe').click();
    const form = page.locator('#recipe-form');
    assert.equal(await page.locator('#recipe-wizard-back').isVisible(), false, 'first step has no redundant Back action');
    assert.equal(await page.locator('#recipe-output-binding-field').isVisible(), false, 'sale recipe does not request a premix output position');
    await page.locator('#recipe-wizard-next').click();
    assert.equal(await page.locator('#recipe-name').evaluate(node => document.activeElement === node), true, 'missing name keeps focus on the invalid field');
    await page.locator('#recipe-name').fill('QA Проверка фокуса');
    await page.locator('#recipe-wizard-next').click();
    const pickerTrigger = page.locator('#recipe-ingredient-select').locator('..').locator('.custom-select-trigger');
    assert.equal(await pickerTrigger.evaluate(node => document.activeElement === node), true, 'Next brings the composition picker into the current keyboard flow');
    assert.equal(await page.locator('#recipe-ingredients').locator('..').isVisible(), false, 'legacy label and repeated composition hint remain hidden');
    const naming = {
      select: await pickerTrigger.getAttribute('aria-label'),
      quantityNamedExactly: await page.getByRole('textbox', { name: 'Количество на порцию', exact: true }).count(),
      noOuterLabel: await page.locator('.recipe-ingredient-picker').evaluate(node => node.closest('label') === null)
    };
    await page.locator('#recipe-wizard-next').click();
    assert.equal(await page.locator('[data-recipe-step="2"]').getAttribute('aria-selected'), 'true', 'empty composition cannot advance');
    assert.equal(await pickerTrigger.evaluate(node => document.activeElement === node), true, 'missing composition returns to its picker');
    await page.waitForFunction(id => [...document.querySelector('#recipe-ingredient-select').options].some(option => option.value === id), ingredient.id);
    await pickerTrigger.click();
    assert.equal(await pickerTrigger.getAttribute('aria-expanded'), 'true', 'ingredient picker opens after validation focus');
    await page.getByRole('option', { name: 'QA Вода · мл', exact: true }).click({ timeout: 3000 });
    await page.locator('#recipe-ingredient-quantity').fill('100 мл');
    await page.locator('#recipe-add-ingredient').click();
    assert.match(await page.locator('#recipe-linked-ingredients').innerText(), /QA Вода.*100 мл/);
    assert.equal((await page.locator('#recipe-ingredients').inputValue()).includes('[' + ingredient.id + ']'), true, 'stock identity remains in the draft payload');
    assert.equal((await page.locator('#recipe-linked-ingredients').innerText()).includes(ingredient.id), false, 'business composition does not expose the storage identifier');
    await page.locator('#recipe-wizard-next').click();
    assert.equal(await page.locator('#recipe-technology').evaluate(node => document.activeElement === node), true, 'Next focuses the first field of the preparation step');
    await page.locator('#recipe-technology').fill('QA технология без сохранения');
    await page.locator('#recipe-wizard-next').click();
    const reviewFocus = await page.evaluate(() => document.activeElement?.dataset.recipeStep || document.activeElement?.tagName);
    assert.deepEqual({ ...naming, reviewFocus }, { select: 'Складская позиция', quantityNamedExactly: 1, noOuterLabel: true, reviewFocus: '4' }, 'picker names are independent and the hidden Next transfers focus to the active review step');
    assert.match(await page.locator('#recipe-cost-summary').innerText(), /QA Вода/);
    assert.equal(await form.locator('.recipe-wizard-danger').evaluate(node => node.hidden), true, 'new recipe keeps the unused destructive section hidden');
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: width < 500 ? 844 : 1000 });
      const drawer = page.locator('.sidebar-mobile-toggle');
      if (await drawer.isVisible() && await drawer.getAttribute('aria-expanded') === 'true') await drawer.click();
      await page.locator('[data-recipe-step="2"]').click();
      const remove = page.locator('[data-recipe-remove="0"]');
      await remove.scrollIntoViewIfNeeded();
      assert.equal(await remove.evaluate(node => {
        const range = document.createRange(); range.selectNodeContents(node);
        return range.getClientRects().length;
      }), 1, 'remove label stays on one line at ' + width);
      assert.equal(await remove.evaluate(node => node.getBoundingClientRect().height >= 44), true, 'ingredient remove keeps a touch target at ' + width);
      if ([390, 1440].includes(width)) await page.screenshot({ path: path.join(folder, 'composition-' + width + '.png') });
      await page.locator('[data-recipe-step="3"]').click();
      await page.locator('#recipe-wizard-next').click();
      assert.equal(await page.evaluate(() => document.activeElement?.dataset.recipeStep), '4', 'review step receives focus at ' + width);
      assert.equal(await page.evaluate(() => !!document.activeElement?.getClientRects().length), true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      if ([390, 1440].includes(width)) await page.screenshot({ path: path.join(folder, 'review-' + width + '.png') });
    }
    await page.locator('[data-recipe-step="2"]').click();
    await page.locator('#recipe-wizard-back').click();
    assert.equal(await page.locator('#recipe-name').evaluate(node => document.activeElement === node), true, 'Back transfers focus to the first field of the first step');
    assert.equal(await page.locator('.recipe-ingredient-picker').isVisible(), false, 'picker belongs only to composition step');
    assert.equal(await page.locator('#recipe-name').inputValue(), 'QA Проверка фокуса');
    await page.locator('[data-recipe-step="2"]').click();
    assert.match(await page.locator('#recipe-linked-ingredients').innerText(), /100 мл/, 'back and forward preserve composition');
    await page.locator('#cancel-recipe').click();
    assert.equal(await form.isVisible(), false);
    assert.equal(await page.locator('#new-recipe').evaluate(node => document.activeElement === node), true, 'cancel returns focus to opener');
    await page.locator('#new-recipe').click();
    assert.equal(await page.locator('#recipe-name').inputValue(), '');
    assert.equal(await page.locator('#recipe-ingredients').inputValue(), '');
    await page.locator('#recipe-type').selectOption('premix');
    await page.locator('[data-recipe-step="1"]').click();
    assert.equal(await page.locator('#recipe-output-binding-field').isVisible(), true, 'premix keeps its output binding visible after step redraw');
    assert.equal(await page.locator('#recipe-product').locator('xpath=ancestor::label').isVisible(), false, 'premix does not display a sale product binding');
    await page.locator('#cancel-recipe').click();
    const viewerContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const viewer = await viewerContext.newPage();
    viewer.on('pageerror', error => errors.push(error.message));
    await signIn(viewer, 'qa_recipe_viewer');
    assert.equal(await viewer.locator('#new-recipe').count(), 0, 'read-only inventory role cannot create a recipe');
    assert.equal(await viewer.locator('#recipe-form').count(), 0, 'read-only route has no writable wizard');
    assert.equal(recipeWrites, 0, 'wizard inspection never saves or deletes a recipe');
    assert.deepEqual(errors, []);
    console.log('PASS recipe wizard (' + (useDist ? 'dist portal' : 'source portal') + '): independent picker names, step focus, validation, draft/cancel/opener, sale/premix/new action visibility, read-only role, 320/390/768/1440; no recipe writes');
  } catch (error) {
    const page = browser?.contexts()[0]?.pages()[0];
    if (page) {
      await page.screenshot({ path: path.join(folder, 'failure.png') }).catch(() => {});
      const state = await page.evaluate(() => ({ focus: document.activeElement?.outerHTML?.slice(0, 500), open: document.querySelector('#recipe-ingredient-select')?.closest('.custom-select')?.className, options: document.querySelector('#recipe-ingredient-select')?.options.length })).catch(() => ({}));
      fs.writeFileSync(path.join(folder, 'failure-state.json'), JSON.stringify(state));
    }
    throw error;
  } finally {
    await browser?.close();
    server.kill();
    if (server.exitCode === null) await Promise.race([once(server, 'exit'), new Promise(resolve => setTimeout(resolve, 3000))]);
  }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
