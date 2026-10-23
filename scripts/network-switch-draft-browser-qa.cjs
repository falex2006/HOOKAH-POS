const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { randomBytes, randomUUID, scryptSync } = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE_PATH || 'playwright');
const root = path.resolve(__dirname, '..');
const password = randomBytes(20).toString('hex');
const variant = process.env.QA_ASSET_VARIANT === 'dist' ? 'dist' : 'source';
const pgUrl = process.env.NETWORK_SWITCH_QA_PG_URL || '';
let output = '', browser, server, serverClosed, db, venueId, ownerLogin = 'owner', staffLogin = 'staff';
(async () => {
  try {
    if (pgUrl) {
      await require('./local-full-pg-regression.cjs').verifyOwnerPinQaDatabaseUrl(pgUrl);
      const { Client } = require('pg'); db = new Client({ connectionString: pgUrl }); await db.connect();
      const organization = randomUUID(), owner = randomUUID(), staff = randomUUID(); venueId = randomUUID();
      ownerLogin = `network-owner-${owner}`; staffLogin = `network-staff-${staff}`;
      const salt = randomBytes(16).toString('hex'), hash = `scrypt$${salt}$${scryptSync(password, salt, 64).toString('hex')}`;
      await db.query('INSERT INTO organizations(id,name,slug,timezone) VALUES($1,$2,$3,$4)', [organization, 'Network disposable QA', `network-${organization}`, 'Asia/Yekaterinburg']);
      await db.query("INSERT INTO organization_subscriptions(organization_id,status,venues_limit) VALUES($1,'trialing',3)", [organization]);
      await db.query('INSERT INTO venues(id,organization_id,name,timezone) VALUES($1,$2,$3,$4)', [venueId, organization, 'Network QA A', 'Asia/Yekaterinburg']);
      await db.query("INSERT INTO users(id,organization_id,venue_id,full_name,login,password_hash,role,permission_scopes) VALUES($1,$2,$3,'Network owner',$4,$5,'owner','[]'::jsonb),($6,$2,$3,'Network staff',$7,$5,'bartender','[\"orders\"]'::jsonb)", [owner, organization, venueId, ownerLogin, hash, staff, staffLogin]);
      await db.query("INSERT INTO organization_memberships(organization_id,user_id,membership_role,status) VALUES($1,$2,'owner','active'),($1,$3,'member','active')", [organization, owner, staff]);
    }
    server = spawn(process.execPath, ['server.js'], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HOST: '127.0.0.1', PORT: '0', DATABASE_URL: pgUrl, ...(venueId ? { VENUE_ID: venueId } : {}), AUTH_REQUIRED: 'true', DEMO_MODE: 'false', NODE_ENV: 'test', DEMO_OWNER_PASSWORD: password, DEMO_STAFF_PASSWORD: password } });
    serverClosed = new Promise(resolve => server.once('close', resolve));
    server.stdout.on('data', c => output += c); server.stderr.on('data', c => output += c);
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
    if (variant === 'dist') for (const asset of ['portal.js', 'style.css', 'lock.js']) await page.route(new RegExp(`/${asset.replace('.', '\\.')}\\?`), route => route.fulfill({ body: fs.readFileSync(path.join(root, 'dist', asset)), contentType: asset.endsWith('.js') ? 'application/javascript' : 'text/css' }));
    const login = async (target, name) => { await target.goto(base + '/login'); await target.locator('#login-username').fill(name); await target.locator('#login-password').fill(password); await target.locator('#login-form button[type=submit]').click(); await target.waitForURL(url => url.pathname !== '/login'); };
    assert.equal((await (await fetch(base + '/api/health')).json()).database, pgUrl ? 'postgres' : 'memory');
    await login(page, ownerLogin);
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
    await page.locator('#network-format').fill('QA format');
    await page.locator('#network-phone').fill('+7 900 000 00 00');
    const phoneDraft = await page.locator('#network-phone').inputValue();
    await page.locator('#network-timezone').selectOption('Europe/Moscow');
    await page.locator(`.network-select[data-venue="${b.id}"]`).click();
    const current = async id => page.waitForFunction(id => window.__networkItems?.some(item => item.id === id && item.isCurrent) && window.__portalSessionVerified?.user?.venueId === id && !window.__portalSessionGate.blocked, id, { timeout: 5000 });
    await current(b.id);
    assert.equal(await page.locator('#network-name').inputValue(), 'Unsaved organization venue', 'organization create draft survives current venue switch');
    for (const [key, value] of Object.entries({ city: 'Unsaved city', address: 'Unsaved address', format: 'QA format', phone: phoneDraft, timezone: 'Europe/Moscow' })) assert.equal(await page.locator(`#network-${key}`).inputValue(), value, `restored ${key}`);
    assert.equal(await page.locator('#network-create-panel').isVisible(), true);
    assert.equal(await page.evaluate(() => sessionStorage.getItem('crm_network_create_transfer')), null, 'one-shot transfer consumed');
    assert.equal(writes.filter(write => write.path === '/api/network/venues' && write.method === 'POST').length, 1, 'switch does not submit another venue');
    await page.locator('#network-create-cancel').click();
    await page.locator(`.network-edit[data-venue="${a.id}"]`).click();
    const editor = page.locator('.network-venue-editor');
    await editor.locator('[name=name]').fill('Unsaved existing venue');
    await editor.getByRole('button', { name: 'Отмена', exact: true }).click();
    assert.equal(writes.filter(write => write.method === 'PATCH').length, 0, 'cancel does not persist edit draft');
    await page.locator(`.network-select[data-venue="${a.id}"]`).click();
    await current(a.id);
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
    await page.locator('#network-add-toggle').click();
    await page.locator('#network-name').fill('Recover after verification error');
    let failGate = true;
    await page.route('**/api/session', route => {
      if (failGate) { failGate = false; return route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }); }
      return route.continue();
    });
    await page.locator(`.network-select[data-venue="${b.id}"]`).click();
    await page.getByText('Не удалось проверить доступ. Проверьте подключение и повторите попытку.', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.__portalSessionGate.blocked), true, 'failed verification blocks old context');
    await page.getByRole('button', { name: 'Повторить', exact: true }).click();
    await current(b.id);
    assert.equal(await page.locator('#network-name').inputValue(), 'Recover after verification error');
    await page.locator('#network-create-cancel').click();
    await page.locator(`.network-edit[data-venue="${a.id}"]`).click();
    assert.equal(await editor.locator('[name=name]').inputValue(), a.name, 'old context edit draft is discarded by verified reload');
    await editor.getByRole('button', { name: 'Отмена', exact: true }).click();
    await page.locator('#network-add-toggle').click();
    await page.locator('#network-name').fill('Storage must preserve me');
    const beforeDeniedStorage = writes.length;
    await page.evaluate(() => {
      window.__qaStorageSet = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) { if (key === 'crm_network_create_transfer') throw Error('qa storage unavailable'); return window.__qaStorageSet.call(this, key, value); };
    });
    await page.locator(`.network-select[data-venue="${a.id}"]`).click();
    await page.getByText('Не удалось сохранить черновик. Переключение не выполнено; введённые данные остались в форме.', { exact: true }).waitFor();
    assert.equal(writes.length, beforeDeniedStorage, 'unavailable storage prevents selection POST');
    assert.equal(await page.locator('#network-name').inputValue(), 'Storage must preserve me');
    await page.evaluate(() => { Storage.prototype.setItem = window.__qaStorageSet; delete window.__qaStorageSet; });
    await page.locator('#network-add-toggle').click();
    await page.locator(`.network-select[data-venue="${a.id}"]`).click();
    await current(a.id);
    assert.equal(await page.locator('#network-create-panel').isVisible(), false, 'hidden draft remains hidden');
    assert.equal(await page.locator('#network-name').inputValue(), 'Storage must preserve me', 'hidden draft preserved');
    for (const bad of ['expired', 'wrong-identity', 'malformed']) {
      await page.evaluate(kind => {
        const user = window.__portalSessionVerified.user;
        sessionStorage.setItem('crm_network_create_transfer', JSON.stringify({ identity: kind === 'wrong-identity' ? 'other:organization' : `${user.id}:${user.organizationId}`, at: Date.now() - (kind === 'expired' ? 300001 : 0), open: true, timezoneTouched: false, values: kind === 'malformed' ? { name: 'Reject me' } : { name: 'Reject me', city: '', address: '', format: 'кальян-бар', phone: '', timezone: 'Europe/Moscow' } }));
      }, bad);
      await page.reload(); await current(a.id);
      assert.equal(await page.locator('#network-name').inputValue(), '', bad + ' draft rejected');
      assert.equal(await page.evaluate(() => sessionStorage.getItem('crm_network_create_transfer')), null);
    }
    await page.unroute('**/api/session');
    const oldSession = await page.evaluate(async () => (await fetch('/api/session')).json());
    let releaseOld, held = false;
    const holdOld = new Promise(resolve => { releaseOld = resolve; });
    await page.route('**/api/session', async route => {
      if (!held) { held = true; await holdOld; return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(oldSession) }); }
      return route.continue();
    });
    const checking = page.waitForRequest(request => new URL(request.url()).pathname === '/api/session');
    await page.evaluate(() => { window.__qaPendingRefresh = window.__portalSessionGate.refresh(); });
    await checking;
    const selected = page.waitForResponse(response => response.url().endsWith(`/api/network/venues/${b.id}/select`) && response.status() === 200);
    await page.locator(`.network-select[data-venue="${b.id}"]`).click();
    await selected; releaseOld(); await current(b.id);
    await page.evaluate(() => sessionStorage.setItem('crm_network_create_transfer', 'qa logout cleanup'));
    await page.locator('#logout').click(); await page.waitForURL(url => url.pathname === '/login');
    assert.equal(await page.evaluate(() => sessionStorage.getItem('crm_network_create_transfer')), null, 'logout clears transfer');
    const staff = await browser.newPage(); await login(staff, staffLogin);
    const denied = await staff.evaluate(async id => (await fetch(`/api/network/venues/${id}/select`, { method: 'POST' })).status, a.id);
    assert.equal(denied, 403, 'staff cannot select venue');
    assert.deepEqual(errors, []);
    console.log(`NETWORK VERIFIED SWITCH ${pgUrl ? 'postgres' : 'memory'} ${variant}: PASS (verified venue reload, all create fields and hidden draft, gate503/retry and stale in-flight check, storage failure prevents POST, invalid/expired transfer rejection, logout cleanup, cancel without PATCH, staff403)`);
  } finally {
    try { await browser?.close(); }
    finally {
      try {
        if (server && server.exitCode === null && server.signalCode === null) {
          server.kill(); let timer;
          try { await Promise.race([serverClosed, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Owned QA server did not stop')), 5000); })]); }
          finally { clearTimeout(timer); }
        }
      } finally { await db?.end(); }
    }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
