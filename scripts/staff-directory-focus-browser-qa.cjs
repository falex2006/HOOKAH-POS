'use strict';
// Actual local memory server and portal. Cosmetic/interaction proof, not PG/RBAC.
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE_PATH || 'playwright');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const out = 'tmp/staff-directory-focus';
(async () => {
  const server = spawn(process.execPath, ['server.js'], { windowsHide: true, env: { ...process.env, HOST: '127.0.0.1', PORT: '0', DATABASE_URL: '', AUTH_REQUIRED: 'false', DEMO_MODE: 'false', NODE_ENV: 'test', API_RATE_LIMIT: '10000' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', browser;
  server.stdout.on('data', chunk => { output += chunk; }); server.stderr.on('data', chunk => { output += chunk; });
  const observations = [], issues = [], errors = [];
  try {
    fs.mkdirSync(out, { recursive: true });
    const base = await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('Local memory server startup timeout')), 15000); server.once('error', reject); server.stdout.on('data', () => { const match = output.match(/CRM running on http:\/\/localhost:(\d+)/); if (match) { clearTimeout(timer); resolve('http://127.0.0.1:' + match[1]); } }); });
    browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'ru-RU', reducedMotion: 'reduce' });
    page.setDefaultTimeout(8000); page.on('pageerror', error => errors.push(error.message));
    await page.goto(base + '/login'); await page.locator('#login-username').fill('admin'); await page.locator('#login-password').fill('admin'); await page.locator('#login-form button[type=submit]').click(); await page.waitForURL(url => url.pathname !== '/login');
    const created = await page.request.post(base + '/api/staff', { data: { name: 'QA Focus One', login: 'qa_focus_one', password: 'FocusQa123', role: 'manager', birthDate: '1995-01-01', phoneNumbers: [{ number: '+79990000001', primary: true }] } });
    assert.equal(created.status(), 201, await created.text());
    await page.goto(base + '/admin#staff', { waitUntil: 'networkidle' }); await page.locator('#staff-search').waitFor();
    const search = page.locator('#staff-search'), views = page.locator('#staff .staff-view-switch > button');
    const rows = page.locator('#staff-list .staff-card:visible, #staff-list .staff-directory-row:visible, #staff-list .staff-table-row:visible');
    async function metrics(locator) { return locator.evaluate(node => { const s = getComputedStyle(node), r = node.getBoundingClientRect(); return { shadow: s.boxShadow, outline: s.outlineStyle, outlineWidth: s.outlineWidth, outlineColor: s.outlineColor, outlineOffset: s.outlineOffset, borderWidth: s.borderTopWidth, borderColor: s.borderTopColor, background: s.backgroundColor, focusVisible: node.matches(':focus-visible'), x: r.x, y: r.y, width: r.width, height: r.height }; }); }
    async function capture(name) { await page.screenshot({ path: `${out}/${name}.png` }); }
    for (const view of ['cards', 'list', 'table']) {
      await page.setViewportSize({ width: 1440, height: 1000 });
      const selected = page.locator(`[data-staff-view="${view}"]`); await selected.click();
      await selected.evaluate(async node => { void node.offsetWidth; await Promise.all(node.getAnimations().map(animation => animation.finished.catch(() => {}))); });
      assert.equal(await page.locator('#staff-list').getAttribute('data-view'), view);
      assert.equal(await page.locator('.staff-view-switch > button[aria-pressed=true]').count(), 1);
      const before = await metrics(selected);
      if (before.shadow !== 'none' || before.borderWidth !== '0px') issues.push(`${view}: selected view has an inner border/ring`);
      const groupBackground = await page.locator('.staff-view-switch').evaluate(node => getComputedStyle(node).backgroundColor);
      if (before.background === groupBackground || before.background === 'rgba(0, 0, 0, 0)') issues.push(`${view}: selected fill is indistinguishable from its group`);
      const selectedContrast = await selected.evaluate(node => {
        const context = document.createElement('canvas').getContext('2d');
        const luminance = color => { context.fillStyle = color; context.fillRect(0, 0, 1, 1); const rgb = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).map(v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }); return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722; };
        const a = luminance(getComputedStyle(node).backgroundColor), b = luminance(getComputedStyle(node.parentElement).backgroundColor);
        return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
      });
      if (selectedContrast < 1.3) issues.push(`${view}: selected tone lost against group background`);
      const geometry = await views.evaluateAll(nodes => nodes.map(node => ({ w: node.getBoundingClientRect().width, h: node.getBoundingClientRect().height })));
      assert.ok(geometry.every(g => Math.abs(g.w - geometry[0].w) < 1 && Math.abs(g.h - geometry[0].h) < 1), 'equal segmented geometry');
      await selected.focus(); await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
      const keyboardButton = await metrics(selected); assert.equal(keyboardButton.focusVisible, true, 'view button keeps keyboard focus');
      assert.ok(parseFloat(keyboardButton.outlineWidth) > 0 && keyboardButton.outline !== 'none', 'keyboard indicator remains visible');
      await capture(`${view}-keyboard-button-1440`);
      await search.click(); const pointer = await metrics(search);
      if (pointer.shadow !== 'none' || pointer.outline !== 'none' && parseFloat(pointer.outlineOffset) > 0) issues.push(`${view}: pointer search retains an outside halo`);
      await capture(`${view}-pointer-search-1440`);
      await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab'); const keyboardSearch = await metrics(search);
      assert.equal(keyboardSearch.focusVisible, true); assert.ok(parseFloat(keyboardSearch.outlineWidth) > 0 || keyboardSearch.borderColor !== before.borderColor, 'keyboard search remains visually indicated');
      assert.ok(Math.abs(pointer.width - keyboardSearch.width) < 0.1 && Math.abs(pointer.height - keyboardSearch.height) < 0.1, 'focus causes no geometry jump');
      await capture(`${view}-keyboard-search-1440`);
      await search.fill('QA Focus One'); assert.equal(await rows.count(), 1, 'search returns selected employee');
      await search.fill('NoStaffMatchesThisQuery'); assert.equal(await rows.count(), 0, 'search empty result'); await search.fill(''); assert.ok(await rows.count() >= 1);
      await page.setViewportSize({ width: 390, height: 900 }); await page.waitForFunction(() => document.querySelector('#staff-list')?.dataset.view === 'list');
      assert.equal(await page.locator('.staff-directory-view-controls').isVisible(), false, 'one mobile list without a view switch');
      await search.click(); const mobilePointer = await metrics(search); if (mobilePointer.shadow !== 'none') issues.push(`${view}: mobile search halo`);
      await capture(`${view}-preference-mobile-list-390`);
      await search.fill('QA Focus One'); assert.equal(await rows.count(), 1); await search.fill('');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'mobile page fits');
      observations.push({ view, selected: before, selectedContrast, keyboardButton, pointer, keyboardSearch, mobilePointer });
    }
    assert.deepEqual(errors, []);
    fs.writeFileSync(`${out}/report.json`, JSON.stringify({ base: '17d93081', scope: 'local memory portal, three desktop views and forced mobile list, pointer/keyboard/search; not PG/RBAC', observations, issues, errors }, null, 2));
    if (issues.length && process.env.STAFF_FOCUS_BASELINE !== '1') throw Error(issues.join('; '));
    console.log(JSON.stringify({ status: issues.length ? 'BASELINE' : 'PASS', views: 3, widths: [1440, 390], issues, out }));
  } finally { try { await browser?.close(); } finally { server.kill(); } }
})().catch(error => { console.error(error); process.exitCode = 1; });
