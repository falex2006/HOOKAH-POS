'use strict';
// Real mounted schedule UI, GET-only synthetic fixture; no business writes or RBAC proof.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE_PATH || 'playwright');
const root = path.resolve(__dirname, '..'), dist = process.env.SCHEDULE_DEMAND_DIST === '1', baseline = process.env.SCHEDULE_DEMAND_BASELINE === '1';
const out = path.join(root, 'tmp/schedule-demand-loading', baseline ? 'baseline' : dist ? 'dist' : 'source');
const access = { view: true, self: true, manage: true, grant: true, canManageSettings: true, role: 'owner', timezone: 'Asia/Yekaterinburg', venueId: 'component-demand' };
const functions = [{ id: 'bar', name: 'Бар', active: true }, { id: 'inactive', name: 'Архив', active: false }];
const rules = [{ id: 'rule1', version: 1, functionId: 'bar', scope: 'weekly', weekday: 1, startTime: '10:00', endTime: '18:00', endDayOffset: 0, requiredCount: 2, active: true }];
const html = '<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/management-theme.css"><link rel="stylesheet" href="/staff-schedule-ui.css"></head><body class="portal velora-theme"><main id="page-content" data-management-theme="mt" style="min-height:100vh;background:var(--ui-page);color:var(--ui-text-primary);padding:16px;box-sizing:border-box"></main></body></html>';
async function main() {
  fs.mkdirSync(out, { recursive: true });
  const allowed = new Set(['style.css', 'management-theme.css', 'staff-schedule-ui.css', 'staff-schedule-ui.js']);
  const server = http.createServer((req, res) => { const name = new URL(req.url, 'http://localhost').pathname.slice(1); if (name === 'fixture') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end(html); } if (!allowed.has(name)) { res.writeHead(404); return res.end(); } res.setHeader('Content-Type', name.endsWith('.css') ? 'text/css' : 'text/javascript'); fs.createReadStream(path.join(root, dist ? 'dist' : '', name)).pipe(res); });
  let browser; const issues = [], observations = [], errors = [];
  const check = (value, message, width) => { if (!value) issues.push({ width, defect: message }); };
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const base = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH });
    for (const width of [390, 1440]) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, locale: 'ru-RU', reducedMotion: 'reduce' }); page.setDefaultTimeout(7000); page.on('pageerror', error => errors.push(error.message));
      let mode = 'empty', pending = [], heldStarted, functionReads = 0, ruleReads = 0;
      await page.route('**/api/staff/schedule**', async route => {
        assert.equal(route.request().method(), 'GET', 'no permission/business writes in this suite'); const pathname = new URL(route.request().url()).pathname; let data, status = 200;
        if (pathname.endsWith('/functions')) { functionReads++; if (mode === 'held') { await new Promise(resolve => { pending.push(resolve); heldStarted?.(); }); } if (mode === 'functions-error') { status = 503; data = { error: 'schedule_unavailable' }; } else data = { items: mode === 'no-functions' ? [] : functions }; }
        else if (pathname.endsWith('/demand-rules')) { ruleReads++; if (mode === 'held-rules') await new Promise(resolve => { pending.push(resolve); heldStarted?.(); }); if (mode === 'rules-error' || mode === 'denied') { status = mode === 'denied' ? 403 : 503; data = { error: mode === 'denied' ? 'schedule_forbidden' : 'schedule_unavailable' }; } else data = { items: mode === 'populated' ? rules : [] }; }
        else data = pathname.endsWith('/access') ? access : pathname.endsWith('/employees') ? { items: [] } : { items: [], actual: [], access };
        await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
      });
      await page.goto(base + '/fixture#staff-schedule'); await page.evaluate(() => localStorage.setItem('crm_session_token', 'component-only-not-a-session'));
      await page.addScriptTag({ url: base + '/staff-schedule-ui.js' }); await page.evaluate(() => window.mountStaffSchedule(document.querySelector('#page-content')));
      const opener = page.locator('[data-demand]'); await opener.waitFor({ state: 'attached' });
      async function open() { if (!(await page.locator('.schedule-more').evaluate(node => node.open))) await page.locator('.schedule-more > summary').click(); await opener.click(); }
      async function settle() { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
      async function snapshot(state) { await settle(); const dialogs = page.locator('dialog[open]'); await dialogs.evaluateAll(nodes => nodes.forEach(node => { node.scrollTop = 0; })); await dialogs.evaluateAll(async nodes => Promise.all(nodes.flatMap(node => node.getAnimations({ subtree: true })).filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})))); assert.equal(await dialogs.count(), 1); const box = await dialogs.evaluate(node => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, opacity: Number(getComputedStyle(node).opacity), overflow: node.scrollWidth > node.clientWidth + 1 }; }); assert.ok(box.opacity >= .99 && box.left >= -1 && box.right <= width + 1 && !box.overflow); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false); const screenshot = `${state}-${width}.png`; await page.screenshot({ path: path.join(out, screenshot) }); observations.push({ width, state, screenshot }); }
      async function close() { await page.locator('dialog[open] [data-close]').click(); await page.locator('dialog[open]').waitFor({ state: 'detached' }); }
      mode = 'held'; let held = new Promise(resolve => { heldStarted = resolve; }); await open(); await held;
      check(await page.locator('[data-demand-list] [role=status]').count() === 1, 'loading feedback absent', width);
      check(await page.locator('dialog [data-submit]').isDisabled(), 'save enabled before initial reads complete', width);
      check(await page.locator('dialog select[name=functionId]').isDisabled(), 'editor enabled before initial reads complete', width); await snapshot('loading');
      if (!baseline) await page.locator('dialog form').evaluate(form => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
      const beforeRepeat = functionReads; await page.evaluate(() => document.querySelector('[data-demand]').click()); await settle(); check(functionReads === beforeRepeat, 'duplicate activation repeats initial GET', width); check(await page.locator('dialog[open]').count() === 1, 'duplicate activation opens duplicate dialog', width);
      mode = 'empty'; pending.splice(0).forEach(resolve => resolve()); heldStarted = null; await page.waitForFunction(() => [...document.querySelectorAll('[data-demand-list]')].every(node => /Правила ещё/.test(node.textContent)));
      await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach(node => node.close())); await page.locator('dialog[open]').waitFor({ state: 'detached' });
      for (const state of ['empty', 'populated', 'functions-error', 'rules-error', 'denied']) {
        mode = state; await open();
        if (state === 'empty' || state === 'populated') {
          await page.locator('[data-demand-list]').filter({ hasText: state === 'empty' ? 'Правила ещё' : '2 чел.' }).waitFor(); assert.equal(await page.locator('select[name=functionId] option[value=inactive]').count(), 0); assert.equal(await page.locator('dialog [data-submit]').isEnabled(), true);
          if (state === 'populated') { await page.locator('[data-demand-edit]').click(); assert.equal(await page.locator('[name=requiredCount]').inputValue(), '2'); assert.equal(await page.locator('[name=functionId]').inputValue(), 'bar'); await page.locator('[data-demand-new]').click(); assert.equal(await page.locator('[name=requiredCount]').inputValue(), '1');
            for (const control of await page.locator('dialog fieldset input:not([type=hidden]), dialog fieldset select').all()) { if (!(await control.isVisible())) continue; await control.evaluate(node => node.scrollIntoView({ block: 'center' })); const box = await control.boundingBox(), footer = await page.locator('dialog form > .schedule-actions').boundingBox(); assert.ok(box && footer && box.y >= 0 && box.y + box.height <= footer.y + 1, 'every visible editor control is reachable above the sticky footer'); }
          }
        } else {
          await page.locator('dialog').filter({ hasText: state === 'denied' ? 'Доступ отозван' : 'Сервис графика временно недоступен' }).waitFor();
          check(await page.locator('dialog [data-submit]').isDisabled(), `${state}: save enabled after failed initial read`, width); check(await page.locator('dialog [data-demand-load-retry]').count() === 1, `${state}: no local retry`, width); check(await page.locator('[data-demand-list] [role=alert]').count() === 1, `${state}: no local alert`, width);
        }
        await snapshot(state);
        if (state === 'populated') { await page.locator('dialog').evaluate(node => { node.scrollTop = node.scrollHeight; }); await settle(); const footer = await page.locator('dialog form > .schedule-actions').boundingBox(); assert.ok(footer && footer.y >= 0 && footer.y + footer.height <= 901, 'footer stays reachable at end of long form'); await page.screenshot({ path: path.join(out, `populated-bottom-${width}.png`) }); }
        const retry = page.locator('[data-demand-load-retry]'); if (await retry.count()) {
          await page.locator('dialog form').evaluate(form => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
          mode = 'held'; const beforeRetry = functionReads, retried = new Promise(resolve => { heldStarted = resolve; }); await retry.evaluate(node => { window.__oldRetry = node; }); await retry.click(); await retried;
          await page.evaluate(() => window.__oldRetry.click()); await settle(); assert.equal(functionReads, beforeRetry + 1, 'retry is single-flight'); assert.equal(await page.locator('dialog [data-submit]').isDisabled(), true);
          mode = 'empty'; pending.splice(0).forEach(resolve => resolve()); heldStarted = null; await page.locator('[data-demand-list]').filter({ hasText: 'Правила ещё' }).waitFor(); assert.equal(await page.locator('dialog [data-submit]').isEnabled(), true);
        }
        await close();
      }
      if (!baseline) {
        mode = 'no-functions'; await open(); await page.locator('[data-demand-list]').filter({ hasText: 'Нет активных рабочих функций' }).waitFor(); assert.equal(await page.locator('dialog [data-submit]').isDisabled(), true); assert.equal(await page.locator('select[name=functionId]').isDisabled(), true); await page.locator('dialog form').evaluate(form => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))); await snapshot('no-functions'); await close();
      }
      mode = 'held'; held = new Promise(resolve => { heldStarted = resolve; }); await open(); await held; await close(); mode = 'empty'; await open(); await page.locator('[data-demand-list]').filter({ hasText: 'Правила ещё' }).waitFor(); const priorRuleReads = ruleReads; pending.splice(0).forEach(resolve => resolve()); await settle(); check(ruleReads === priorRuleReads, 'closed request continues demand-rule read', width); await snapshot('closed-loading-reopened'); await close();
      if (!baseline) {
        mode = 'held-rules'; const secondRead = new Promise(resolve => { heldStarted = resolve; }); await open(); await secondRead; assert.equal(await page.locator('select[name=functionId]').isDisabled(), true); assert.equal(await page.locator('select[name=functionId] option').count(), 0, 'functions are not applied before rules read succeeds'); await close();
        mode = 'empty'; await page.evaluate(() => window.mountStaffSchedule(document.querySelector('#page-content'))); await page.locator('[data-demand]').waitFor({ state: 'attached' }); await open(); await page.locator('[data-demand-list]').filter({ hasText: 'Правила ещё' }).waitFor(); pending.splice(0).forEach(resolve => resolve()); heldStarted = null; await settle(); assert.equal(await page.locator('dialog[open]').count(), 1); assert.equal(await page.locator('[data-demand-list] [role=alert]').count(), 0); await snapshot('closed-second-read-remounted'); await close();
      }
      const beforeLeave = functionReads; await page.evaluate(() => { location.hash = '#other'; document.querySelector('[data-demand]').click(); }); await settle(); check(await page.locator('dialog[open]').count() === 0 && functionReads === beforeLeave, 'stale opener opens after route leave', width); await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach(node => node.close())); await page.close();
    }
    assert.deepEqual(errors, []); fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ scope: 'GET-only component, explicit theme marker; no mutation/RBAC/PG acceptance', observations, issues, errors }, null, 2)); console.log(JSON.stringify({ status: issues.length ? 'BASELINE' : 'PASS', observations: observations.length, issues, out })); if (issues.length && !baseline) throw Error(`${issues.length} demand loading failures`);
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
