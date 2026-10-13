// GET-only check of pointer selection versus keyboard focus in the task-owned local preview.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE_PATH);
const manifest = JSON.parse(fs.readFileSync('tmp/full-local-qa/pos-workspace-private.json', 'utf8'));
assert.equal(path.resolve(manifest.root), path.resolve('.'));
assert.equal(manifest.ownerTag, 'pos-employee-workspace-20261011');
assert.equal(manifest.state, 'ready');
assert.match(manifest.base, /^http:\/\/127\.0\.0\.1:\d+$/);
const expectedHref = fs.readFileSync('index.html', 'utf8').match(/href="([^"]*pos-workspace\.css\?rev=[^"]+)"/)[1];
const dir = path.resolve('docs/design/POS_EMPLOYEE_WORKSPACE_2026-10-11/evidence/selection-softening');
fs.mkdirSync(dir, { recursive: true });
const errors = [], writes = [], results = [];
let browser;
async function style(locator) {
  return locator.evaluate(node => {
    const s = getComputedStyle(node), r = node.getBoundingClientRect();
    return { outlineWidth: s.outlineWidth, outlineStyle: s.outlineStyle, outlineColor: s.outlineColor,
      outlineOffset: s.outlineOffset, borderWidth: s.borderTopWidth, borderColor: s.borderTopColor,
      background: s.backgroundColor, shadow: s.boxShadow, focused: node.matches(':focus-visible'),
      selected: node.getAttribute('aria-pressed'), rect: [r.x, r.y, r.width, r.height] };
  });
}
async function run() {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  for (const theme of ['dark', 'light']) {
    const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
    page.on('pageerror', e => errors.push(e.message));
    page.on('request', r => { if (r.url().includes('/api/') && !['GET', 'HEAD'].includes(r.method())) writes.push(r.method()); });
    await page.addInitScript(actor => {
      localStorage.setItem('crm_session_token', actor.token);
      localStorage.setItem('crm_session_user', JSON.stringify(actor.user));
    }, manifest.actors.bartender);
    await page.goto(manifest.base);
    await page.waitForFunction(() => document.querySelector('#tables')?.dataset.dataState === 'ready');
    await page.evaluate(theme => document.body.classList.toggle('light-theme', theme === 'light'), theme);
    assert.equal(await page.locator('link[href*="pos-workspace.css"]').getAttribute('href'), expectedHref);
    // Opening the first order changes the workspace columns; measure within the established panel.
    await page.locator('.table.free').first().click();
    await page.waitForFunction(() => document.querySelector('.order')?.dataset.posState === 'empty');
    const table = page.locator('.table').filter({ has: page.locator('.table-order-total') }).first();
    const before = await style(table);
    await page.locator('.table.free').first().click();
    await table.click();
    await page.waitForFunction(() => document.querySelector('.order-pricing-summary')?.textContent.includes('Оплачено'));
    await table.evaluate(async node => { await Promise.all(node.getAnimations().map(a => a.finished.catch(() => {}))); });
    const pointer = await style(table);
    assert.equal(pointer.selected, 'true');
    assert.equal(pointer.focused, false);
    assert.equal(pointer.outlineWidth, '0px');
    assert.equal(pointer.outlineStyle, 'none');
    assert.equal(pointer.borderWidth, '1px');
    assert.equal(pointer.shadow, 'none');
    assert.notEqual(pointer.background, before.background);
    assert.deepEqual(pointer.rect, before.rect, 'selection preserves card geometry');
    assert.equal(await page.locator('.table.sel').count(), 1);
    await page.screenshot({ path: path.join(dir, theme + '-pointer.png') });
    await table.press('ArrowRight');
    const keyboard = await style(page.locator('.table.sel'));
    assert.equal(keyboard.focused, true);
    assert.equal(keyboard.outlineWidth, '3px');
    assert.equal(keyboard.outlineStyle, 'dashed');
    assert.equal(keyboard.outlineOffset, '5px');
    assert.equal(keyboard.borderWidth, '1px');
    assert.equal(keyboard.outlineColor, pointer.borderColor);
    await page.screenshot({ path: path.join(dir, theme + '-keyboard.png') });
    // Chrome may retain focus-visible when re-clicking the already keyboard-focused node.
    // Move pointer focus to another table before checking a fresh pointer selection.
    await page.locator('.table.free').first().click();
    await table.click();
    await table.evaluate(async node => { await Promise.all(node.getAnimations().map(a => a.finished.catch(() => {}))); });
    const repeated = await style(table);
    assert.equal(repeated.outlineWidth, '0px', 'pointer click after keyboard removes outer focus ring');
    assert.equal(repeated.selected, 'true');
    assert.equal(await page.locator('.table.sel').count(), 1);
    results.push({ theme, before, pointer, keyboard, repeated });
    await page.close();
  }
  assert.deepEqual(errors, []); assert.deepEqual(writes, []);
  fs.writeFileSync(path.join(dir, 'qa.json'), JSON.stringify({ createdAt: new Date().toISOString(),
    environment: 'Chrome headless; task-owned loopback; GET-only; isolated storage', results, errors, writes }, null, 2));
  console.log('PASS: thin single pointer border, subtle tint, unchanged geometry, separate keyboard focus and repeated selection in both themes; 0 writes/errors');
}
run().catch(e => { console.error(e.stack); process.exitCode = 1; }).finally(async () => { await browser?.close(); });
