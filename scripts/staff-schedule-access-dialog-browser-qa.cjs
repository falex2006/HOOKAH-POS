'use strict';
// Actual JS/CSS component; synthetic GET-only access data. No rights writes or DB.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE_PATH || 'playwright');
const root = path.resolve(__dirname, '..'), dist = process.env.SCHEDULE_ACCESS_DIST === '1';
const out = path.join(root, 'tmp', 'schedule-access-dialog', dist ? 'dist' : 'source');
const access = { view: true, self: true, manage: true, grant: true, publish: false, canManageSettings: false, role: 'owner', timezone: 'Asia/Yekaterinburg', venueId: 'access-component' };
const users = [{ userId: 'view-user', name: 'Тестовый управляющий с правом просмотра', access: 'view', version: 1, canPublish: false, canManageSettings: false }, { userId: 'manage-user', name: 'Тестовый администратор', access: 'manage', version: 2, canPublish: true, canManageSettings: false }];
const html = '<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/management-theme.css"><link rel="stylesheet" href="/staff-schedule-ui.css"></head><body class="portal velora-theme"><main id="page-content" data-management-theme="mt" style="min-height:100vh;background:var(--ui-page);color:var(--ui-text-primary);padding:16px;box-sizing:border-box"></main></body></html>';
async function main() {
  fs.mkdirSync(out, { recursive: true });
  const assets = new Set(['style.css', 'management-theme.css', 'staff-schedule-ui.css', 'staff-schedule-ui.js']);
  const server = http.createServer((req, res) => {
    const name = new URL(req.url, 'http://localhost').pathname.slice(1);
    if (name === 'fixture') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end(html); }
    if (!assets.has(name)) { res.writeHead(404); return res.end(); }
    res.setHeader('Content-Type', name.endsWith('.css') ? 'text/css' : 'text/javascript'); fs.createReadStream(path.join(root, dist ? 'dist' : '', name)).pipe(res);
  });
  let browser; const issues = [], observations = [], errors = [];
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const base = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH });
    for (const width of [390, 1440]) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, locale: 'ru-RU', reducedMotion: 'reduce' }); page.setDefaultTimeout(7000); page.on('pageerror', error => errors.push(error.message));
      let mode = 'empty', reads = 0, pending = [], heldStarted, heldItems = [{ ...users[0], name: 'STALE RESPONSE' }];
      await page.route('**/api/staff/schedule**', async route => {
        assert.equal(route.request().method(), 'GET', 'this suite never changes rights');
        const pathname = new URL(route.request().url()).pathname;
        let status = 200, data;
        if (pathname.endsWith('/grants')) {
          reads++;
          if (mode === 'held') { const items = heldItems; await new Promise(resolve => { pending.push(resolve); heldStarted?.(); }); data = { items }; }
          else if (mode === 'error' || mode === 'denied') { status = mode === 'denied' ? 403 : 503; data = { error: mode === 'denied' ? 'schedule_forbidden' : 'schedule_unavailable' }; }
          else data = { items: mode === 'populated' ? users : [] };
        } else data = pathname.endsWith('/access') ? access : pathname.endsWith('/employees') ? { items: [] } : { items: [], actual: [], access };
        await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
      });
      await page.goto(base + '/fixture#staff-schedule'); await page.evaluate(() => localStorage.setItem('crm_session_token', 'component-only-not-a-session'));
      await page.addScriptTag({ url: base + '/staff-schedule-ui.js' }); await page.evaluate(() => window.mountStaffSchedule(document.querySelector('#page-content')));
      const opener = page.locator('[data-grants]');
      async function open() { if (!(await page.locator('.schedule-more').evaluate(node => node.open))) await page.locator('.schedule-more > summary').click(); await opener.click(); }
      async function settle() { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
      async function snapshot(state) {
        await settle();
        await page.locator('dialog[open]').evaluateAll(async nodes => {
          await Promise.all(nodes.flatMap(node => node.getAnimations({ subtree: true })).filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})));
        });
        assert.equal(await page.locator('dialog[open]').count(), 1, `${state} has one visible dialog`);
        assert.ok(await page.locator('dialog[open]').evaluate(node => Number(getComputedStyle(node).opacity) >= .99), `${state} dialog is fully visible before capture`);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `${state} page fits`);
        for (const box of await page.locator('dialog[open]').evaluateAll(nodes => nodes.map(node => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, overflow: node.scrollWidth > node.clientWidth + 1 }; }))) assert.ok(box.left >= -1 && box.right <= width + 1 && !box.overflow, `${state} dialog fits`);
        const screenshot = `${state}-${width}.png`; await page.screenshot({ path: path.join(out, screenshot) }); observations.push({ width, state, screenshot });
      }
      async function close() { await page.locator('dialog[open] [data-close]').click(); await page.locator('dialog[open]').waitFor({ state: 'detached' }); }
      mode = 'held'; const held = new Promise(resolve => { heldStarted = resolve; }); await open(); await held;
      if (!(await page.locator('dialog[open] [data-grant-list] [role=status]').count())) issues.push({ width, defect: 'No immediate loading dialog or close action while access GET waits' });
      await snapshot('loading');
      assert.equal(await page.locator('[data-grant-list] select, [data-grant-list] input').count(), 0, 'no permission controls before GET completes');
      await page.evaluate(() => document.querySelector('[data-grants]').click()); await settle();
      if (reads !== 1) issues.push({ width, defect: 'Repeated activation duplicates access GET' });
      mode = 'empty'; pending.splice(0).forEach(resolve => resolve()); heldStarted = null; await page.locator('dialog[open] [data-grant-list]').first().waitFor(); await settle();
      if (await page.locator('dialog[open]').count() !== 1) issues.push({ width, defect: 'Concurrent responses create duplicate access dialogs' });
      await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach(node => node.close())); await page.locator('dialog[open]').waitFor({ state: 'detached' });
      await open(); await page.locator('[data-grant-list]').filter({ hasText: 'Нет администраторов' }).waitFor(); await snapshot('empty'); await close();
      assert.equal(await opener.evaluate(node => node === document.activeElement), true, 'close restores opener focus');
      mode = 'populated'; await open(); await page.locator('[data-grant-list] fieldset').first().waitFor(); assert.equal(await page.locator('[data-grant-list] fieldset').count(), 2);
      assert.equal(await page.locator('[data-publish-user="view-user"]').isDisabled(), true); assert.equal(await page.locator('[data-settings-user="view-user"]').isDisabled(), true); await snapshot('populated'); await close();
      for (const failure of ['error', 'denied']) {
        mode = failure; await open(); await settle();
        const retry = page.locator('[data-grants-load-retry]');
        if (!(await retry.count())) issues.push({ width, defect: `${failure} has no in-dialog feedback/retry` });
        else { await retry.waitFor(); const feedback = await page.locator('[data-grant-list]').innerText(); assert.match(feedback, failure === 'denied' ? /Доступ отозван/ : /Сервис графика временно недоступен/); assert.doesNotMatch(feedback, /Нет администраторов/, 'failure is not rendered as successful empty data'); assert.equal(await page.locator('[data-grant-list] select, [data-grant-list] input').count(), 0); }
        await snapshot(failure); mode = 'empty';
        if (await retry.count() && failure === 'error') {
          heldItems = []; mode = 'held'; const before = reads, retried = new Promise(resolve => { heldStarted = resolve; });
          await retry.evaluate(node => { window.__previousRetry = node; }); await retry.click(); await retried;
          await page.evaluate(() => window.__previousRetry.click()); await settle(); assert.equal(reads, before + 1, 'concurrent retry remains one GET');
          mode = 'empty'; pending.splice(0).forEach(resolve => resolve()); heldStarted = null;
        } else if (await retry.count()) await retry.click(); else await open();
        await page.locator('[data-grant-list]').filter({ hasText: 'Нет администраторов' }).waitFor(); await close();
      }
      mode = 'held'; heldItems = [{ ...users[0], name: 'STALE RESPONSE' }]; const late = new Promise(resolve => { heldStarted = resolve; }); await open(); await late;
      if (await page.locator('dialog[open]').count()) {
        await close(); mode = 'empty'; await open(); await page.locator('[data-grant-list]').filter({ hasText: 'Нет администраторов' }).waitFor();
        pending.splice(0).forEach(resolve => resolve()); await settle();
        assert.equal(await page.locator('dialog[open]').count(), 1); assert.doesNotMatch(await page.locator('[data-grant-list]').innerText(), /STALE RESPONSE/); await snapshot('closed-loading-reopened'); await close();
      } else {
        issues.push({ width, defect: 'Access request cannot be cancelled/reopened while loading' }); mode = 'empty'; pending.splice(0).forEach(resolve => resolve()); await page.locator('dialog[open]').waitFor(); await close();
      }
      const beforeLeaving = reads;
      await page.evaluate(() => { const previous = document.querySelector('[data-grants]'); location.hash = '#different-component-route'; previous.click(); });
      await settle(); assert.equal(await page.locator('dialog[open]').count(), 0, 'stale opener cannot create a dialog after route leave'); assert.equal(reads, beforeLeaving);
      await page.close();
    }
    assert.deepEqual(errors, []); fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ scope: 'actual mounted module/CSS with synthetic GET-only API; not authorization or role mutation acceptance', dist, observations, issues, errors }, null, 2));
    if (issues.length && process.env.SCHEDULE_ACCESS_BASELINE !== '1') throw Error(`${issues.length} access dialog failures`);
    console.log(JSON.stringify({ status: issues.length ? 'BASELINE' : 'PASS', observations: observations.length, issues, out }));
  } finally { try { await browser?.close(); } finally { await new Promise(resolve => server.close(resolve)); } }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
