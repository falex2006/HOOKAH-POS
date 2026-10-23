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
      server.stdout.on('data', () => { const match = output.match(/CRM running on http:\/\/localhost:(\d+)/); if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); } });
      server.once('exit', code => { clearTimeout(timer); reject(Error(`Local server exited ${code}`)); });
    });
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, locale: 'ru-RU' });
    const errors = [];
    const mutations = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (['POST', 'PATCH', 'DELETE'].includes(request.method()) && /catalog/.test(request.url())) mutations.push(request.method() + ' ' + new URL(request.url()).pathname); });
    await page.goto(base + '/login');
    await page.locator('#login-username').fill('admin');
    await page.locator('#login-password').fill('admin');
    await page.locator('#login-form button[type=submit]').click();
    await page.waitForURL(url => !url.pathname.includes('/login'));
    const outputDir = 'tmp/inventory-catalog-disclosure';
    fs.mkdirSync(outputDir, { recursive: true });

    const checkViewport = async (width, height, screenshotName) => {
      await page.setViewportSize({ width, height });
      await page.goto(base + '/inventory?view=directories', { waitUntil: 'networkidle' });
      const panels = page.locator('details.directory-secondary-catalog');
      assert.equal(await panels.count(), 2, 'exactly two secondary catalogs');
      const hiddenForms = page.locator('.product-editor[hidden]');
      for (let i = 0; i < await hiddenForms.count(); i++) {
        const form = hiddenForms.nth(i);
        assert.equal(await form.isVisible(), false, `hidden editor is not visible at ${width}px`);
        const style = await form.evaluate(node => getComputedStyle(node).display);
        assert.equal(style, 'none', `hidden editor computed display at ${width}px`);
      }
      for (const [name, formId, addId, cancelId, saveId] of [
        ['Каталог табаков', '#tobacco-catalog-form', '#tobacco-catalog-add', '#tobacco-catalog-cancel', '#tobacco-catalog-save'],
        ['Каталог крепкого алкоголя', '#alcohol-catalog-form', '#alcohol-catalog-add', '#alcohol-catalog-cancel', '#alcohol-catalog-save'],
      ]) {
        const details = panels.filter({ hasText: name });
        const summary = details.locator('summary');
        assert.equal(await details.evaluate(node => node.open), false, `${name} starts collapsed`);
        await summary.click();
        assert.equal(await details.evaluate(node => node.open), true, `${name} opens with its single disclosure`);
        assert.equal(await details.locator('button', { hasText: /Показать каталог|Свернуть каталог/ }).count(), 0, `${name} has no nested disclosure`);
        const form = page.locator(formId);
        assert.equal(await form.isVisible(), false, `${name} editor waits for explicit Add`);
        await page.locator(addId).click();
        assert.equal(await form.isVisible(), true, `${name} editor opens from Add`);
        const formBox = await form.boundingBox();
        const panelBox = await details.boundingBox();
        assert.ok(formBox.width >= panelBox.width - 8, `${name} editor spans the available panel width`);
        const columns = await form.locator(':scope > .form-grid').evaluate(node => getComputedStyle(node).gridTemplateColumns.split(' ').length);
        assert.equal(columns, width <= 680 ? 1 : 2, `${name} field grid at ${width}px`);
        const buttons = form.locator(':scope > .toolbar-row > button');
        assert.deepEqual(await buttons.allTextContents(), ['Отмена', 'Сохранить карточку'], `${name} action order`);
        const boxes = await buttons.evaluateAll(nodes => nodes.map(node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; }));
        assert.ok(boxes.every(box => box.height >= 44), `${name} buttons meet minimum target height`);
        if (width <= 680) {
          assert.ok(boxes[0].y < boxes[1].y, `${name} mobile cancel precedes save`);
          assert.ok(Math.abs(boxes[0].width - boxes[1].width) < 1, `${name} mobile buttons have equal width`);
        } else {
          assert.ok(boxes[0].x < boxes[1].x && Math.abs(boxes[0].y - boxes[1].y) < 1, `${name} desktop actions share a right-aligned row`);
        }
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width, `no horizontal overflow at ${width}px`);
        await page.screenshot({ path: `${outputDir}/${screenshotName}-${formId.slice(1)}.png`, fullPage: true });
        await page.locator(cancelId).click();
        assert.equal(await form.isVisible(), false, `${name} Cancel hides and resets editor`);
        await summary.click();
        assert.equal(await details.evaluate(node => node.open), false, `${name} disclosure closes`);
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width, `page remains within ${width}px after close`);
    };

    await checkViewport(1280, 800, 'desktop');
    await checkViewport(390, 844, 'mobile');
    assert.deepEqual(mutations, [], 'expand, add, and cancel perform no catalog mutations');
    assert.deepEqual(errors, [], 'no page errors');
    console.log('PASS inventory catalog disclosure, hidden forms, layout, action order, mobile sizing, cancel, no unintended API writes (1280px, 390px)');
  } catch (error) {
    console.error(output);
    throw error;
  } finally {
    if (browser) await browser.close();
    server.kill();
  }
})();
