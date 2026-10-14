'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { config, folder } = require('./staff-schedule-local-config.cjs');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE_PATH || 'playwright');
async function main() {
  const c = config(), f = JSON.parse(fs.readFileSync(path.join(folder, 'fixtures.json'), 'utf8'));
  const base = `http://127.0.0.1:${c.appPort}`;
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const login = await context.request.post(base + '/api/login', { data: { username: f.users[0].login, password: f.password } });
    assert.equal(login.status(), 200);
    const session = await login.json();
    await context.addInitScript(({ token, user }) => { localStorage.setItem('crm_session_token', token); localStorage.setItem('crm_session_user', JSON.stringify(user)); }, session);
    await page.goto(base + '/admin#staff-schedule');
    await page.locator('.schedule-heading h1').waitFor({ timeout: 20000 });
    await page.locator('[data-context]').filter({ hasText: 'Asia/Yekaterinburg' }).waitFor({state:'attached'});
    assert.equal(await page.locator('.schedule-tools').evaluate(el => el.open), true, 'Desktop filters initially open');
    assert.equal(await page.locator('[data-cancelled]').isChecked(), false, 'Cancelled entries excluded initially');
    assert.ok(await page.locator('a[href="/admin#staff-schedule"]:visible').count());
    await page.locator('[data-create]').click();
    await page.locator('dialog[open]').waitFor();
    await page.screenshot({ path: path.join(folder, 'editor-desktop.png'), fullPage: true });
    await page.locator('dialog [data-close]').click();
    await page.screenshot({ path: path.join(folder, 'calendar-desktop.png'), fullPage: true });
    for (const width of [375, 768]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(500); // Allow the existing shell breakpoint transition to finish before measuring.
      await page.reload();
      await page.locator('[data-context]').filter({ hasText: 'Asia/Yekaterinburg' }).waitFor({ state: 'attached' });
      assert.equal(await page.locator('.schedule-tools').evaluate(el => el.open), false, `Compact filters initially closed at ${width}`);
      await page.locator('.schedule-tools > summary').click();
      assert.equal(await page.locator('[data-person]').isVisible(), true, 'Native disclosure exposes employee filter');
      await page.locator('.schedule-tools > summary').click();
      console.log(JSON.stringify(await page.evaluate(() => ({ width: innerWidth, body: document.body.className, nodes: ['.portal-sidebar','.portal-main','#page-content'].map(selector => { const el = document.querySelector(selector), css = getComputedStyle(el), r = el.getBoundingClientRect(); return { selector,x:r.x,width:r.width,margin:css.marginLeft,transform:css.transform,position:css.position }; }) }))));
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `page overflow ${width}`);
      await page.screenshot({ path: path.join(folder, `calendar-${width}.png`), fullPage: true });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator('[data-grants]').click();
    await page.getByRole('heading', { name: 'Доступ к графику', exact: true }).waitFor();
    await page.locator('dialog [data-close]').click();
    assert.deepEqual(errors, []);
    await page.evaluate(()=>{location.hash='#staff';});
    await page.waitForFunction(()=>location.hash==='#staff'&&!document.body.classList.contains('schedule-route')&&document.querySelector('[data-admin-section-title]')?.textContent==='Персонал');
    await page.goBack();
    await page.locator('[data-context]').filter({hasText:'Asia/Yekaterinburg'}).waitFor({state:'attached'});
    assert.equal(await page.locator('[data-admin-section-title]').textContent(),'График сотрудников');
    await page.goForward();
    await page.waitForFunction(()=>location.hash==='#staff'&&!document.body.classList.contains('schedule-route'));
    assert.deepEqual(errors, []);
    console.log('SCHEDULE BROWSER: PASS direct route, menu, calendar, editor, grants dialog, 375/768 overflow; screenshots saved. Visual review and save E2E still separate.');
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
