const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE_PATH || 'playwright');
const root = path.resolve(__dirname, '..');
const password = randomBytes(20).toString('hex');
const variant = process.env.QA_ASSET_VARIANT === 'dist' ? 'dist' : 'source';
const server = spawn(process.execPath, ['server.js'], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, HOST: '127.0.0.1', PORT: '0', DATABASE_URL: '', AUTH_REQUIRED: 'true', DEMO_MODE: 'false', NODE_ENV: 'test', DEMO_OWNER_PASSWORD: password, DEMO_STAFF_PASSWORD: password } });
let output = '', browser;
server.stdout.on('data', c => output += c); server.stderr.on('data', c => output += c);
(async () => {
  try {
    const base = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Owned memory server startup timeout')), 15000);
      server.stdout.on('data', () => { const match = output.match(/CRM running on http:\/\/localhost:(\d+)/); if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); } });
      server.once('error', error => { clearTimeout(timer); reject(error); });
    });
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [], writes = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', req => { if (['POST', 'PATCH', 'DELETE'].includes(req.method()) && /\/api\/network\//.test(req.url())) writes.push({ method: req.method(), path: new URL(req.url()).pathname }); });
    if (variant === 'dist') for (const asset of ['portal.js', 'style.css']) await page.route(new RegExp(`/${asset.replace('.', '\\.')}\\?`), route => route.fulfill({ body: fs.readFileSync(path.join(root, 'dist', asset)), contentType: asset.endsWith('.js') ? 'application/javascript' : 'text/css' }));
    const login = async (target, name) => { await target.goto(base + '/login'); await target.locator('#login-username').fill(name); await target.locator('#login-password').fill(password); await target.locator('#login-form button[type=submit]').click(); await target.waitForURL(url => url.pathname !== '/login'); };
    await login(page, 'owner');
    await page.goto(base + '/network');
    await page.locator('#network-add-toggle').click();
    assert.equal(await page.locator('.network-form-actions button').first().innerText(), 'Отмена', 'cancel precedes primary in visual and keyboard order');
    await page.locator('#network-name').fill('Network QA B');
    await page.locator('#network-city').fill('QA City');
    await page.locator('#network-address').fill('QA address B');
    await page.locator('#network-form button[type=submit]').click();
    await page.getByText('2 точки', { exact: true }).waitFor();
    const items = await page.evaluate(async () => (await (await fetch('/api/network/venues')).json()).items);
    const a = items.find(item => item.isCurrent), b = items.find(item => item.name === 'Network QA B');
    assert.ok(a && b && a.id !== b.id);
    await page.locator('#network-add-toggle').click();
    await page.locator('#network-name').fill('Unsaved organization venue');
    await page.locator('#network-city').fill('Unsaved city');
    await page.locator('#network-address').fill('Unsaved address');
    await page.locator(`.network-select[data-venue="${b.id}"]`).click();
    await page.waitForFunction(id => window.__networkItems?.some(item => item.id === id && item.isCurrent), b.id);
    assert.equal(await page.locator('#network-name').inputValue(), 'Unsaved organization venue', 'organization create draft survives current venue switch');
    assert.equal(writes.filter(write => write.path === '/api/network/venues' && write.method === 'POST').length, 1, 'switch does not submit another venue');
    await page.locator('#network-create-cancel').click();
    await page.locator(`.network-edit[data-venue="${a.id}"]`).click();
    const editor = page.locator('.network-venue-editor');
    await editor.locator('[name=name]').fill('Unsaved existing venue');
    await editor.getByRole('button', { name: 'Отмена', exact: true }).click();
    assert.equal(writes.filter(write => write.method === 'PATCH').length, 0, 'cancel does not persist edit draft');
    await page.locator(`.network-select[data-venue="${a.id}"]`).click();
    await page.waitForFunction(id => window.__networkItems?.some(item => item.id === id && item.isCurrent), a.id);
    await page.locator(`.network-edit[data-venue="${b.id}"]`).click();
    assert.equal(await editor.locator('[name=name]').inputValue(), b.name, 'edit drafts are bound to their entity and current venue context');
    await editor.getByRole('button', { name: 'Отмена', exact: true }).click();
    let failSelect = true;
    await page.route(new RegExp(`/api/network/venues/${b.id}/select$`), route => {
      if (failSelect) { failSelect = false; return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"qa_switch_failed"}' }); }
      return route.continue();
    });
    await page.locator(`.network-select[data-venue="${b.id}"]`).click();
    await page.getByText('Не удалось выбрать точку', { exact: true }).waitFor();
    assert.equal((await page.evaluate(async () => (await (await fetch('/api/network/venues')).json()).items)).find(item => item.isCurrent).id, a.id, 'failed switch retains current venue');
    await page.locator(`.network-select[data-venue="${b.id}"]`).click();
    await page.waitForFunction(id => window.__networkItems?.some(item => item.id === id && item.isCurrent), b.id);
    await page.locator(`.network-edit[data-venue="${a.id}"]`).click();
    assert.equal(await editor.locator('[name=name]').inputValue(), 'Unsaved existing venue', 'organization edit draft stays attached to the same venue without persisting');
    await editor.getByRole('button', { name: 'Отмена', exact: true }).click();
    const staff = await browser.newPage(); await login(staff, 'staff');
    const denied = await staff.evaluate(async id => (await fetch(`/api/network/venues/${id}/select`, { method: 'POST' })).status, a.id);
    assert.equal(denied, 403, 'staff cannot select venue');
    assert.deepEqual(errors, []);
    console.log(`NETWORK SWITCH DRAFT ${variant}: PASS (owner create/switch/retry, organization draft retention, entity-bound edit draft retention, cancel without PATCH, staff403)`);
  } finally { await browser?.close(); if (server.exitCode === null) server.kill(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
