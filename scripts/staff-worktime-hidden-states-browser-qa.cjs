'use strict';
// Actual production modules and CSS in a fresh browser, synthetic read-only API.
// Component evidence only: no portal auth override, application server, DB or VPS.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE_PATH || 'playwright');
const root = path.resolve(__dirname, '..');
const artifacts = path.join(root, 'tmp', 'staff-worktime-hidden-states');
const access = { view: true, self: true, manage: true, grant: false, publish: false,
  canManageSettings: false, role: 'owner', timezone: 'Asia/Yekaterinburg', venueId: 'component-fixture' };
const employee = { id: 'fixture-employee', name: 'Тестовый сотрудник', role: 'manager', active: true };
const attendance = { access: { self: true, managePolicy: true, approve: true, grant: true, closeSessions: true },
  settings: { mode: 'free', preparationMinutes: 0, version: 1 }, timezone: 'Asia/Yekaterinburg',
  serverNow: '2035-01-15T10:00:00Z', requests: [], sessions: [], grants: [], admission: { decision: 'allowed' } };
// Explicit component theme root; this does not exercise the portal theme resolver.
const html = '<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/management-theme.css"><link rel="stylesheet" href="/staff-schedule-ui.css"><link rel="stylesheet" href="/staff-attendance-ui.css"></head><body class="portal velora-theme"><main id="page-content" data-management-theme="mt" style="min-height:100vh;background:var(--ui-page);color:var(--ui-text-primary);padding:16px;box-sizing:border-box"></main></body></html>';

async function main() {
  fs.mkdirSync(artifacts, { recursive: true });
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/fixture') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); return; }
    const file = path.resolve(root, '.' + decodeURIComponent(pathname));
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream');
    fs.createReadStream(file).pipe(res);
  });
  let browser;
  const observations = [], defects = [], errors = [], methods = [];
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH });
    for (const width of [390, 1440]) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, locale: 'ru-RU', reducedMotion: 'reduce' });
      const page = await context.newPage();
      page.setDefaultTimeout(7000);
      page.on('pageerror', error => errors.push(error.message));
      let scenario = 'ok', releaseRead = null, readHeld = null, accessReads = 0;
      await page.route('**/api/staff/**', async route => {
        const request = route.request(), pathname = new URL(request.url()).pathname;
        if (pathname.endsWith('/access')) accessReads++;
        methods.push(request.method());
        assert.equal(request.method(), 'GET', 'cancel/reopen audit must not send mutations');
        if (scenario === 'loading' || scenario === 'access-held' && pathname.endsWith('/access') || scenario === 'employees-held' && pathname.endsWith('/employees')) {
          await new Promise(resolve => { releaseRead = resolve; readHeld?.(); });
        }
        let status = 200, data;
        if (pathname.includes('/attendance/')) {
          data = structuredClone(attendance);
          if (scenario === 'denied') data.access = { self: false };
          if (scenario === 'error') { status = 503; data = { error: 'temporarily_unavailable' }; }
        } else if (scenario === 'access-denied') { status = 403; data = { error: 'schedule_forbidden' }; }
        else if (scenario === 'employees-error' && pathname.endsWith('/employees')) { status = 503; data = { error: 'schedule_unavailable' }; }
        else if (scenario === 'list-error' && pathname === '/api/staff/schedule') { status = 503; data = { error: 'schedule_unavailable' }; }
        else data = pathname.endsWith('/access') ? access : pathname.endsWith('/employees') ? { items: [employee] } : { items: [], actual: [], access };
        await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
      });
      async function snapshot(name) {
        const geometry = await page.evaluate(() => ({ documentOverflow: document.documentElement.scrollWidth > innerWidth + 1,
          dialogs: [...document.querySelectorAll('dialog[open]')].map(node => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, overflow: node.scrollWidth > node.clientWidth + 1 }; }) }));
        assert.equal(geometry.documentOverflow, false, `${name} document fits ${width}`);
        geometry.dialogs.forEach(d => assert.ok(d.left >= -1 && d.right <= width + 1 && !d.overflow, `${name} dialog fits ${width}`));
        const screenshot = `${name}-${width}.png`;
        await page.screenshot({ path: path.join(artifacts, screenshot) });
        observations.push({ width, state: name, screenshot, geometry });
      }
      async function mountSchedule() {
        await page.goto(base + '/fixture#staff-schedule');
        await page.evaluate(() => localStorage.setItem('crm_session_token', 'component-fixture-not-a-real-session'));
        await page.addScriptTag({ url: base + '/staff-schedule-ui.js' });
        await page.evaluate(() => { window.__mount = window.mountStaffSchedule(document.querySelector('#page-content')); });
      }
      scenario = 'loading'; await mountSchedule();
      await page.locator('[role="status"]').waitFor(); await snapshot('schedule-loading');
      scenario = 'ok'; releaseRead(); await page.evaluate(() => window.__mount);
      await page.locator('[data-view-mode="list"]').click();
      await page.locator('[data-status]').filter({ hasText: 'нет записей' }).waitFor(); await snapshot('schedule-empty-list');
      const wrappedTabs = await page.locator('[data-view-mode]').evaluateAll(nodes => nodes.filter(node => {
        const range = document.createRange(); range.selectNodeContents(node);
        const lines = new Set([...range.getClientRects()].map(rect => Math.round(rect.top)));
        return lines.size > 1;
      }).map(node => node.textContent));
      if (wrappedTabs.length) defects.push({ width, state: 'view-tabs', defect: 'Short view labels wrap inside words', labels: wrappedTabs });
      await page.locator('[data-create]').click(); await page.locator('dialog[open]').waitFor();
      const changed = page.locator('dialog[open] textarea').first();
      if (!(await changed.isVisible())) await changed.locator('xpath=ancestor::details[1]').locator(':scope > summary').click();
      await changed.fill('Несохранённое пояснение');
      await page.locator('dialog[open] [data-close]').click();
      await page.locator('[data-keep-editing]').waitFor(); await snapshot('schedule-discard-guard');
      await page.locator('[data-discard-changes]').scrollIntoViewIfNeeded();
      assert.equal(await page.locator('[data-discard-changes]').isVisible(), true, 'second discard action is reachable by dialog scrolling');
      await snapshot('schedule-discard-actions');
      await page.locator('[data-keep-editing]').click(); assert.equal(await changed.inputValue(), 'Несохранённое пояснение');
      await page.locator('dialog[open] [data-close]').click(); await page.locator('[data-discard-changes]').click();
      await page.locator('dialog[open]').waitFor({ state: 'detached' });
      await page.locator('[data-create]').click(); await page.locator('dialog[open]').waitFor();
      assert.equal(await page.locator('dialog[open] textarea').first().inputValue(), '');
      await snapshot('schedule-reopened'); await page.locator('dialog[open] [data-close]').click();

      scenario = 'list-error'; await page.locator('[data-next]').click();
      await page.locator('[data-schedule-load-retry]').waitFor();
      assert.match(await page.locator('[data-status]').innerText(), /Сервис графика временно недоступен/);
      assert.doesNotMatch(await page.locator('[data-status]').innerText(), /schedule_unavailable|temporarily_unavailable/);
      assert.equal(await page.locator('[data-create]').isDisabled(), true);
      assert.equal(await page.locator('[data-grid]').innerText(), '', 'failed list clears stale data');
      await snapshot('schedule-list-error');
      const retry = page.locator('[data-schedule-load-retry]');
      if (!(await retry.count()) || !(await retry.isVisible())) defects.push({ width, state: 'list-error', defect: 'No visible retry beside load error; refresh is hidden in collapsed More menu' });
      scenario = 'employees-held';
      const beforeRetry = accessReads, retryHeld = new Promise(resolve => { readHeld = resolve; });
      const retryRect = await retry.boundingBox();
      if (await retry.count() && await retry.isVisible()) await retry.click();
      else { await page.locator('.schedule-more > summary').click(); await page.locator('[data-refresh]').click(); }
      await retryHeld;
      if (retryRect) await page.mouse.click(retryRect.x + retryRect.width / 2, retryRect.y + retryRect.height / 2);
      assert.equal(accessReads - beforeRetry, 1, 'repeated pointer click during pending retry does not initialize twice');
      scenario = 'ok'; releaseRead(); readHeld = null;
      await page.locator('[data-create]:enabled').waitFor();
      scenario = 'employees-error'; await mountSchedule();
      await page.locator('[data-schedule-load-retry]').waitFor(); await snapshot('schedule-employees-error');
      if (!(await retry.count()) || !(await retry.isVisible())) defects.push({ width, state: 'employees-error', defect: 'No visible initialization retry beside error' });
      scenario = 'ok';
      if (await retry.count() && await retry.isVisible()) await retry.click();
      else { await page.locator('.schedule-more > summary').click(); await page.locator('[data-refresh]').click(); }
      await page.locator('[data-create]:enabled').waitFor();
      assert.equal(await retry.isVisible(), false, 'successful retry clears initialization error action');
      scenario = 'access-denied'; await mountSchedule();
      await page.locator('[role="alert"]').waitFor(); assert.equal(await page.locator('[data-create]').count(), 0); await snapshot('schedule-denied');
      scenario = 'ok'; await page.locator('[data-schedule-access-retry]').click(); await page.locator('[data-create]:enabled').waitFor();
      for (const heldStage of ['access-held', 'employees-held']) {
        scenario = heldStage;
        const held = new Promise(resolve => { readHeld = resolve; });
        await page.evaluate(() => { window.__oldMount = window.mountStaffSchedule(document.querySelector('#page-content')); });
        await held; scenario = 'ok';
        await page.evaluate(() => window.mountStaffSchedule(document.querySelector('#page-content')));
        await page.locator('[data-create]:enabled').waitFor();
        const survivor = heldStage === 'access-held' ? '.schedule-heading' : '[data-person] option';
        await page.locator(survivor).first().evaluate(node => node.dataset.qaNewMount = 'true');
        releaseRead(); await page.evaluate(() => window.__oldMount);
        if (!(await page.locator('[data-qa-new-mount]').count())) defects.push({ width, state: heldStage, defect: 'Old mount overwrites current UI after same-target remount' });
        readHeld = null;
      }

      async function mountAttendance(kind = 'management') {
        await page.goto(base + '/fixture#staff-attendance');
        await page.addScriptTag({ url: base + '/staff-attendance-ui.js' });
        await page.evaluate(kind => {
          window.__view = window.HOOKAH_ATTENDANCE[kind === 'self' ? 'mountSelf' : 'mountManagement'](document.querySelector('#page-content'), { api: async (url, options) => {
            const response = await fetch(url, options), data = await response.json();
            if (!response.ok) throw Object.assign(new Error(data.error), { status: response.status, payload: data });
            return data;
          } });
        }, kind);
      }
      scenario = 'loading'; await mountAttendance(); await page.locator('.attendance-loading').waitFor(); await snapshot('attendance-loading');
      scenario = 'ok'; releaseRead(); await page.locator('[data-attendance-tab="settings"]').waitFor(); await snapshot('attendance-empty');
      await page.locator('[data-attendance-tab="settings"]').click();
      const minutes = page.locator('form[data-attendance-policy] [name="preparationMinutes"]'); await minutes.fill('45');
      await page.locator('[data-attendance-refresh]').click(); await page.locator('[data-attendance-discard-draft]').waitFor();
      assert.equal(await minutes.inputValue(), '45'); await snapshot('attendance-draft-guard');
      page.once('dialog', d => d.dismiss()); await page.locator('[data-attendance-discard-draft]').click(); assert.equal(await minutes.inputValue(), '45');
      page.once('dialog', d => d.accept()); await page.locator('[data-attendance-discard-draft]').click();
      await page.waitForFunction(() => document.querySelector('[name="preparationMinutes"]')?.value === '0');
      await snapshot('attendance-draft-discarded');
      scenario = 'error'; await page.locator('[data-attendance-refresh]').click(); await page.locator('[data-attendance-retry]').waitFor();
      assert.equal(await page.locator('.attendance-empty').getAttribute('role'), 'alert', 'GET failure must be announced as an error');
      await snapshot('attendance-error');
      scenario = 'ok'; await page.locator('[data-attendance-retry]').click(); await page.locator('[data-attendance-tab="settings"]').waitFor();
      scenario = 'denied'; await mountAttendance(); await page.getByRole('heading', { name: 'Нет доступа к управлению выходами' }).waitFor(); await snapshot('attendance-management-denied');
      await mountAttendance('self'); await page.getByRole('heading', { name: 'Личный учёт недоступен' }).waitFor(); await snapshot('attendance-self-denied');
      scenario = 'ok'; await mountAttendance('self'); await page.locator('[data-attendance-start]').waitFor(); await snapshot('attendance-self-empty');
      await page.evaluate(() => { window.__view.dispose(); document.querySelector('#page-content').replaceChildren(); });
      assert.equal(await page.locator('.attendance-page').count(), 0);
      await mountAttendance('self'); await page.locator('[data-attendance-start]').waitFor(); assert.equal(await page.locator('.attendance-page').count(), 1); await snapshot('attendance-self-reopened');
      await context.close();
    }
    assert.deepEqual(errors, [], 'no browser JS errors');
    const report = { baseCommit: '17d93081', scope: 'synthetic component UI/CSS; not real auth/API/DB or full shell acceptance', observations, defects, apiMethods: [...new Set(methods)], errors };
    fs.writeFileSync(path.join(artifacts, 'report.json'), JSON.stringify(report, null, 2));
    if (defects.length && process.env.WORKTIME_AUDIT_BASELINE !== '1') throw Error(`${defects.length} visible-retry failures; see ${artifacts}/report.json`);
    console.log(JSON.stringify({ observations: observations.length, defects, artifacts, status: defects.length ? 'BASELINE: reproduced defect' : 'PASS' }));
  } finally { try { await browser?.close(); } finally { await new Promise(resolve => server.close(resolve)); } }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
