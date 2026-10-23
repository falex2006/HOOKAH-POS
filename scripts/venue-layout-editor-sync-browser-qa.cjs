const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE_PATH || 'playwright');
const root = path.resolve(__dirname, '..');
const variant = process.env.QA_ASSET_VARIANT === 'dist' ? 'dist' : 'source';
const server = spawn(process.execPath, ['server.js'], { cwd: root, windowsHide: true,
  env: { ...process.env, HOST: '127.0.0.1', PORT: '0', DATABASE_URL: '', AUTH_REQUIRED: 'false', DEMO_MODE: 'false', NODE_ENV: 'test' },
  stdio: ['ignore', 'pipe', 'pipe'] });
let output = '', browser;
server.stdout.on('data', chunk => output += chunk);
server.stderr.on('data', chunk => output += chunk);
(async () => {
  try {
    const base = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Owned memory server startup timeout')), 15000);
      server.stdout.on('data', () => { const match = output.match(/CRM running on http:\/\/localhost:(\d+)/); if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); } });
      server.once('error', error => { clearTimeout(timer); reject(error); });
    });
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    if (variant === 'dist') for (const asset of ['portal.js', 'style.css']) {
      await page.route(new RegExp(`/${asset.replace('.', '\\.')}\\?`), route => route.fulfill({ body: fs.readFileSync(path.join(root, 'dist', asset)), contentType: asset.endsWith('.js') ? 'application/javascript' : 'text/css' }));
    }
    await page.goto(base + '/login');
    await page.locator('#login-username').fill('admin');
    await page.locator('#login-password').fill('admin');
    await page.locator('#login-form button[type=submit]').click();
    await page.waitForURL(url => url.pathname === '/admin');
    const ids = await page.evaluate(async () => {
      const send = async (url, body) => { const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); if (r.status !== 201) throw Error('Fixture creation failed'); return r.json(); };
      const floor = await (await fetch('/api/floor')).json();
      const zone = await send('/api/floor/zones', { expectedVenueId: floor.venueId, name: 'Sync QA zone' });
      const make = name => send('/api/floor/tables', { expectedVenueId: floor.venueId, zoneId: zone.id, name, capacity: 4, minCapacity: 2, maxCapacity: 4 });
      return { zone: zone.id, a: (await make('Sync QA A')).id, b: (await make('Sync QA B')).id };
    });
    await page.goto(base + '/admin#venue-layout-settings');
    const a = page.locator(`[data-floor-table="${ids.a}"]`);
    const b = page.locator(`[data-floor-table="${ids.b}"]`);
    await a.waitFor();
    const bDetails = b.locator('..');
    if (await bDetails.getAttribute('open') === null) await bDetails.locator('summary').click();
    await a.locator('[name=x]').fill('321');
    await b.locator('[name=name]').fill('Unsaved other table');
    await b.locator('[name=x]').fill('654');
    await a.locator('[name=x]').evaluate(el => el.dataset.syncQaIdentity = 'retained');
    await page.locator(`[data-room-edit="${ids.a}"]`).click();
    const dialog = page.locator('.venue-layout-editor');
    await dialog.locator('[name=name]').fill('Saved Sync A');
    await dialog.locator('[name=maxCapacity]').fill('6');
    await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
    await page.locator(`[data-floor-drag="${ids.a}"]`).getByText('Saved Sync A', { exact: true }).waitFor({ timeout: 3000 });
    assert.equal(await a.locator('[name=name]').inputValue(), 'Saved Sync A');
    assert.equal(await a.locator('[name=capacity]').inputValue(), '6');
    assert.equal(await a.locator('[name=x]').inputValue(), '321');
    assert.equal(await a.locator('[name=x]').getAttribute('data-sync-qa-identity'), 'retained');
    assert.equal(await b.locator('[name=name]').inputValue(), 'Unsaved other table');
    assert.equal(await b.locator('[name=x]').inputValue(), '654');
    assert.notEqual(await bDetails.getAttribute('open'), null);
    await page.evaluate(({ id }) => document.querySelector('#floor-editor').dispatchEvent(new CustomEvent('venue-layout-edited', { detail: { venueId: 'different-venue', kind: 'table', result: { id, name: 'Foreign metadata', capacity: 9 } } })), { id: ids.a });
    assert.equal(await a.locator('[name=name]').inputValue(), 'Saved Sync A', 'foreign venue notification ignored');
    let failListRead = true;
    await page.route(/\/api\/floor\?includeArchived=true$/, route => {
      if (failListRead) { failListRead = false; return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"qa_list_read_failed"}' }); }
      return route.continue();
    });
    await page.locator(`[data-room-edit="${ids.a}"]`).click();
    await dialog.locator('[name=name]').fill('Saved despite list error');
    await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
    await page.locator('[data-venue-layout-retry]').waitFor();
    assert.equal(await a.locator('[name=name]').inputValue(), 'Saved despite list error', 'committed response updates canvas independently of failed list GET');
    assert.equal(await a.locator('[name=x]').inputValue(), '321');
    assert.equal(await b.locator('[name=name]').inputValue(), 'Unsaved other table');
    await page.locator('[data-venue-layout-retry]').click();
    await page.locator(`[data-zone-edit="${ids.zone}"]`).waitFor();
    await page.locator(`[data-zone-edit="${ids.zone}"]`).click();
    await dialog.locator('[name=name]').fill('Saved Sync Zone');
    await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
    await page.locator(`[data-floor-zone-tab="${ids.zone}"]`).getByText('Saved Sync Zone', { exact: true }).waitFor({ timeout: 3000 });
    assert.match(await a.locator('..').locator('summary small').innerText(), /Saved Sync Zone.*6/);
    assert.equal(await a.locator('[name=x]').inputValue(), '321');
    assert.equal(await b.locator('[name=name]').inputValue(), 'Unsaved other table');
    let releaseOldRead;
    let readStarted;
    const oldReadStarted = new Promise(resolve => { readStarted = resolve; });
    await page.route(/\/api\/floor$/, async route => {
      const response = await route.fetch();
      readStarted();
      await new Promise(resolve => { releaseOldRead = resolve; });
      await route.fulfill({ response });
    }, { times: 1 });
    await page.locator(`[data-floor-block="${ids.b}"]`).click();
    await oldReadStarted;
    await page.locator(`[data-room-edit="${ids.a}"]`).click();
    await dialog.locator('[name=name]').fill('Concurrent Sync A');
    await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
    await page.locator(`[data-room-edit="${ids.a}"]`).waitFor();
    releaseOldRead();
    await page.locator(`[data-floor-block="${ids.b}"]`).getByText('Разблокировать', { exact: true }).waitFor();
    assert.equal(await a.locator('[name=name]').inputValue(), 'Concurrent Sync A', 'older upper GET retains latest committed name');
    assert.equal(await a.locator('[name=x]').inputValue(), '321');
    assert.equal(await b.locator('[name=name]').inputValue(), 'Unsaved other table');
    await page.reload();
    await page.locator(`[data-floor-drag="${ids.a}"]`).getByText('Concurrent Sync A', { exact: true }).waitFor();
    assert.equal(await a.locator('[name=capacity]').inputValue(), '6');
    let releaseInitialRead;
    let initialReadStarted;
    const initialStarted = new Promise(resolve => { initialReadStarted = resolve; });
    await page.route(/\/api\/floor$/, async route => {
      const response = await route.fetch();
      initialReadStarted();
      await new Promise(resolve => { releaseInitialRead = resolve; });
      await route.fulfill({ response });
    }, { times: 1 });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await initialStarted;
    await page.locator(`[data-room-edit="${ids.a}"]`).click();
    await dialog.locator('[name=name]').fill('Saved during first read');
    await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
    await page.locator(`[data-room-edit="${ids.a}"]`).waitFor();
    releaseInitialRead();
    await page.locator(`[data-floor-drag="${ids.a}"]`).getByText('Saved during first read', { exact: true }).waitFor();
    assert.deepEqual(errors, []);
    console.log(`VENUE EDITOR SYNC ${variant}: PASS (real memory PATCH/reload, retained geometry DOM/drafts, other-table drafts, zone rename, failed list GET/retry, foreign venue, concurrent status GET, delayed first read)`);
  } finally {
    await browser?.close();
    if (server.exitCode === null) server.kill();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
