const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { randomUUID, randomBytes, scryptSync } = require('node:crypto');
const { Client } = require('pg');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE_PATH || 'playwright');

(async () => {
  const { validateQaDatabaseUrl, assertQaDatabaseIdentity } = await import('./postgres-qa-safety.mjs');
  const target = validateQaDatabaseUrl(process.env.PURCHASE_EDITOR_TEST_DATABASE_URL, 'PURCHASE_EDITOR_TEST_DATABASE_URL');
  assert.match(target.database, /^inventory_qa_[a-f0-9]{16}$/i);
  assert.equal(target.database, process.env.LOCAL_FULL_PG_OWNED_DATABASE, 'only the guarded runner may own this disposable database');
  const client = new Client({ connectionString: target.url.href, connectionTimeoutMillis: 5000 });
  const organizationId = randomUUID(), venueId = randomUUID(), ownerId = randomUUID();
  const ownerLogin = 'purchase-editor-owner-' + ownerId;
  const useDist = process.env.PURCHASE_EDITOR_USE_DIST === '1';
  const folder = path.resolve('tmp/purchase-editor-browser-qa', useDist ? 'dist' : 'source');
  fs.mkdirSync(folder, { recursive: true });
  let server, browser;
  const releases = [];
  const gate = () => {
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    releases.push(release);
    return { release, wait: async () => {
      let timer;
      try { await Promise.race([pending, new Promise(resolve => { timer = setTimeout(resolve, 10000); })]); }
      finally { clearTimeout(timer); }
    } };
  };
  try {
    await client.connect();
    const identity = (await client.query(`SELECT current_database() AS database,inet_server_addr()::text AS address,inet_server_port() AS port,COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname=current_user),false) AS superuser`)).rows[0];
    assertQaDatabaseIdentity(identity, target.database, Number(target.url.port || 5432), 'purchase editor QA');
    const salt = randomBytes(16).toString('hex');
    const passwordHash = `scrypt$${salt}$${scryptSync('demo', salt, 64).toString('hex')}`;
    await client.query('INSERT INTO organizations(id,name,slug,timezone) VALUES($1,$2,$3,$4)', [organizationId, 'Purchase editor QA', 'purchase-editor-' + organizationId, 'Asia/Yekaterinburg']);
    await client.query("INSERT INTO organization_subscriptions(organization_id,status) VALUES($1,'trialing')", [organizationId]);
    await client.query('INSERT INTO venues(id,organization_id,name,timezone) VALUES($1,$2,$3,$4)', [venueId, organizationId, 'Purchase editor QA venue', 'Asia/Yekaterinburg']);
    await client.query("INSERT INTO inventory_departments(venue_id,code,name) VALUES($1,'bar','Бар') ON CONFLICT(venue_id,code) DO UPDATE SET name=EXCLUDED.name", [venueId]);
    await client.query("INSERT INTO users(id,organization_id,venue_id,full_name,login,password_hash,role,permission_scopes) VALUES($1,$2,$3,'QA owner',$4,$5,'owner','[]'::jsonb)", [ownerId, organizationId, venueId, ownerLogin, passwordHash]);
    await client.query("INSERT INTO organization_memberships(organization_id,user_id,membership_role,status) VALUES($1,$2,'owner','active')", [organizationId, ownerId]);
    server = spawn(process.execPath, ['server.js'], { windowsHide: true,
      env: { ...process.env, HOST: '127.0.0.1', PORT: '0', DATABASE_URL: target.url.href, VENUE_ID: venueId, AUTH_REQUIRED: 'true', DEMO_MODE: 'false', NODE_ENV: 'test', API_RATE_LIMIT: '10000' },
      stdio: ['ignore', 'pipe', 'pipe'] });
    const base = await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(Error('Purchase QA startup timeout')), 15000);
      server.stdout.on('data', data => {
        output += data;
        const port = output.match(/CRM running on http:\/\/localhost:(\d+)/)?.[1];
        if (port) { clearTimeout(timer); resolve('http://127.0.0.1:' + port); }
      });
      server.once('error', error => { clearTimeout(timer); reject(error); });
      server.once('exit', code => { clearTimeout(timer); reject(Error('Purchase QA server exited ' + code)); });
    });
    const api = async (route, token, method = 'GET', body, expected = 200) => {
      const response = await fetch(base + route, { method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      const data = await response.json();
      assert.equal(response.status, expected, route + ': ' + (data.error || ''));
      return data;
    };
    const seed = await api('/api/login', '', 'POST', { username: ownerLogin, password: 'demo' });
    const category = await api('/api/product-categories', seed.token, 'POST', { name: 'QA Сырьё', department: 'bar' }, 201);
    const water = await api('/api/inventory/items', seed.token, 'POST', { name: 'QA Вода', department: 'bar', category: category.name, categoryId: category.id, unit: 'мл', purchaseUnit: 'бутылка', packMultiplier: 1000, itemType: 'ingredient', cost: 0.01 }, 201);
    const flour = await api('/api/inventory/items', seed.token, 'POST', { name: 'QA Мука', department: 'bar', category: category.name, categoryId: category.id, unit: 'г', purchaseUnit: 'кг', packMultiplier: 1000, itemType: 'ingredient', cost: 0.01 }, 201);
    const literalNumber = 'QA <em data-qa="purchase-number">001</em>';
    const literalSupplier = 'QA <em data-qa="purchase-supplier">Поставщик</em>';
    const literal = await api('/api/inventory/purchase-documents', seed.token, 'POST', { supplierName: literalSupplier, documentNumber: literalNumber, lines: [{ ingredientId: water.id, quantity: 1, unit: 'мл', unitCost: 1 }] }, 201);
    await api('/api/staff', seed.token, 'POST', { name: 'QA Справочники', role: 'manager', login: 'qa_purchase_reader', password: 'demo', birthDate: '1990-01-01', permissionScopes: ['inventory_categories'] }, 201);
    await api('/api/logout', seed.token, 'POST');
    browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: 'ru-RU' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const signIn = async (target, username) => {
      if (useDist) {
        await target.route(/\/portal\.js(?:\?|$)/, route => route.fulfill({ path: path.resolve(__dirname, '../dist/portal.js'), contentType: 'text/javascript' }));
        await target.route(/\/style\.css(?:\?|$)/, route => route.fulfill({ path: path.resolve(__dirname, '../dist/style.css'), contentType: 'text/css' }));
      }
      await target.goto(base + '/login');
      await target.locator('#login-username').fill(username);
      await target.locator('#login-password').fill('demo');
      await target.locator('#login-form button[type="submit"]').click();
      await target.waitForURL(url => !url.pathname.includes('/login'));
      await target.goto(base + '/inventory?view=movements', { waitUntil: 'networkidle' });
    };
    await signIn(page, ownerLogin);
    const token = await page.evaluate(() => localStorage.getItem('crm_session_token'));
    let purchaseWrites = 0;
    page.on('request', request => { if (['POST', 'PATCH'].includes(request.method()) && new URL(request.url()).pathname.startsWith('/api/inventory/purchase-documents')) purchaseWrites++; });
    const list = page.locator('#purchase-document-list');
    assert.equal(await list.locator('em[data-qa]').count(), 0, 'document number and supplier render as literal text, never saved HTML');
    assert.ok((await list.innerText()).includes(literalNumber));
    assert.ok((await list.innerText()).includes(literalSupplier));
    const dialog = page.locator('#purchase-document-dialog');
    const save = page.locator('#purchase-save');
    const receipt = page.locator('[data-inventory-header-action="receipt"]');
    const choose = async (row, id) => {
      const wrapper = page.locator(`[data-purchase-line="${row}"] [data-purchase-field="ingredientId"]`).locator('..');
      await wrapper.locator('.custom-select-trigger').click();
      await wrapper.locator(`[data-value="${id}"]`).click();
      assert.equal(await page.locator(`[data-purchase-line="${row}"] [data-purchase-field="quantity"]`).evaluate(node => document.activeElement === node), true, 'item choice advances to quantity');
    };
    await receipt.click();
    await save.click();
    assert.equal(await page.locator('#purchase-supplier').evaluate(node => document.activeElement === node), true);
    await page.locator('#purchase-supplier').fill('QA Новый поставщик');
    assert.equal(await page.locator('#purchase-message').innerText(), '', 'corrected supplier removes its obsolete validation message');
    await save.click();
    assert.equal(await page.locator('[data-purchase-line="0"] .custom-select-trigger').evaluate(node => document.activeElement === node), true, 'empty ingredient validation focuses the visible picker');
    assert.equal(await page.locator('[data-purchase-line="0"] .custom-select-trigger').getAttribute('aria-invalid'), 'true');
    await page.locator('[data-purchase-remove="0"]').click();
    assert.equal(await page.locator('#purchase-add-line').evaluate(node => document.activeElement === node), true, 'removing the final row returns to Add');
    await save.click();
    assert.equal(await page.locator('#purchase-add-line').evaluate(node => document.activeElement === node), true, 'empty composition validation identifies the next action');
    await page.locator('#purchase-add-line').click();
    assert.equal(await page.locator('#purchase-message').innerText(), '', 'adding a row clears the obsolete empty-composition prompt');
    assert.equal(await page.locator('[data-purchase-line="0"] .custom-select-trigger').evaluate(node => document.activeElement === node), true, 'Add focuses the new position');
    await choose(0, water.id);
    await page.locator('[data-purchase-line="0"] [data-purchase-field="quantity"]').fill('2');
    await page.locator('[data-purchase-line="0"] [data-purchase-field="unitCost"]').fill('50');
    await page.locator('#purchase-add-line').click();
    await choose(1, flour.id);
    await page.locator('[data-purchase-line="1"] [data-purchase-field="quantity"]').fill('3');
    await page.locator('[data-purchase-line="1"] [data-purchase-field="unitCost"]').fill('10');
    assert.match(await page.locator('#purchase-total').innerText(), /130/);
    await page.locator('[data-purchase-remove="1"]').click();
    assert.equal(await page.locator('[data-purchase-line="0"] .custom-select-trigger').evaluate(node => document.activeElement === node), true, 'remove focuses the neighboring position');
    assert.match(await page.locator('#purchase-total').innerText(), /100/);
    assert.match((await page.locator('[data-purchase-preview]').innerText()).replaceAll(/\s/g, ''), /2000мл/);
    await page.locator('#purchase-number').fill('QA-NEW');
    await page.locator('#purchase-note').fill('QA create draft');
    const quantity = page.locator('[data-purchase-field="quantity"]');
    const unit = page.locator('[data-purchase-field="unit"]');
    const cost = page.locator('[data-purchase-field="unitCost"]');
    const invalidCases = [[quantity, '0', '2'], [quantity, '-1', '2'], [quantity, '0.0000001', '2'], [unit, '', 'бутылка'], [cost, '', '50'], [cost, '-1', '50']];
    for (const [field, invalid, valid] of invalidCases) {
      await field.fill(invalid); await save.click();
      assert.equal(await field.evaluate(node => document.activeElement === node), true, 'first invalid field receives focus: ' + invalid);
      assert.equal(await field.getAttribute('aria-invalid'), 'true');
      await field.fill(valid);
      assert.equal(await field.getAttribute('aria-invalid'), null, 'editing clears the invalid marker');
      assert.equal(await page.locator('#purchase-message').innerText(), '', 'corrected field removes its obsolete validation prompt');
    }
    await page.locator('#purchase-date').fill('10000-01-01');
    await save.click();
    assert.equal(await page.locator('#purchase-date').evaluate(node => document.activeElement === node), true, 'unsupported date year is validated before a request');
    await page.locator('#purchase-date').fill('');
    assert.equal(purchaseWrites, 0, 'all invalid forms are rejected before network writes');
    const createGate = gate();
    let attempts = 0;
    await page.route('**/api/inventory/purchase-documents', async route => {
      if (route.request().method() !== 'POST') return route.continue();
      attempts++;
      if (attempts === 1) { await createGate.wait(); return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"qa_unavailable"}' }); }
      return route.continue();
    });
    const saveBox = await save.boundingBox();
    await save.click();
    await page.waitForFunction(() => document.querySelector('#purchase-save')?.disabled);
    assert.equal(await page.locator('#purchase-cancel').isDisabled(), true);
    assert.equal(await page.locator('#purchase-add-line').isDisabled(), true);
    assert.equal(await dialog.getByRole('button', { name: 'Закрыть', exact: true }).isDisabled(), true);
    await page.keyboard.press('Enter'); await page.keyboard.press('Escape'); await page.mouse.click(3, 3);
    await page.mouse.click(saveBox.x + saveBox.width / 2, saveBox.y + saveBox.height / 2);
    assert.equal(await dialog.isVisible(), true);
    assert.equal(attempts, 1);
    createGate.release();
    await page.waitForFunction(() => !document.querySelector('#purchase-save')?.disabled && document.querySelector('#purchase-message')?.textContent.includes('Не удалось'));
    assert.equal(await save.evaluate(node => document.activeElement === node), true, 'failed create returns focus to retry');
    assert.equal(await page.locator('#purchase-message').getAttribute('role'), 'alert');
    assert.equal(await page.locator('#purchase-note').inputValue(), 'QA create draft');
    await page.screenshot({ path: path.join(folder, 'create-error-390.png') });
    for (const width of [320, 390, 520, 768, 1440]) {
      await page.setViewportSize({ width, height: width < 600 ? 844 : 1000 });
      const geometry = await page.locator('#purchase-document-dialog .ui-modal-footer button').evaluateAll(nodes => nodes.map(node => {
        const range = document.createRange(); range.selectNodeContents(node);
        return { ...node.getBoundingClientRect().toJSON(), lines: range.getClientRects().length };
      }));
      assert.ok(geometry.every(button => button.height >= 44 && button.lines === 1), 'footer captions/targets at ' + width);
      assert.ok(Math.abs(geometry[0].width - geometry[1].width) < 1 && Math.abs(geometry[0].height - geometry[1].height) < 1, 'equal footer actions at ' + width);
      if (width <= 650) assert.ok(geometry[1].top - geometry[0].bottom >= 8 && geometry[1].top - geometry[0].bottom <= 16);
      else assert.ok(Math.abs(geometry[0].top - geometry[1].top) < 1);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.equal(await page.locator('#purchase-message').evaluate(node => {
        const rect = node.getBoundingClientRect(); return rect.top >= 0 && rect.bottom <= innerHeight;
      }), true, 'save error remains visible above the actions at ' + width);
      assert.equal(await page.locator('#purchase-add-line').evaluate(node => {
        const texts = [...node.childNodes].filter(child => child.nodeType === Node.TEXT_NODE && child.textContent.trim());
        return texts.length > 0 && texts.every(text => { const range = document.createRange(); range.selectNodeContents(text); return range.getClientRects().length === 1; });
      }), true, 'add-position caption remains on one line at ' + width);
      if ([390, 1440].includes(width)) await page.screenshot({ path: path.join(folder, 'filled-' + width + '.png') });
    }
    await save.click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(attempts, 2);
    await page.unroute('**/api/inventory/purchase-documents');
    const created = (await api('/api/inventory/purchase-documents', token)).items.find(doc => doc.documentNumber === 'QA-NEW');
    assert.ok(created);
    const stock = async () => Number((await api('/api/inventory', token)).items.find(item => item.id === water.id).onHand);
    assert.equal(await stock(), 0, 'draft save never changes stock');
    assert.equal((await api('/api/inventory/purchase-documents/' + created.id, token)).note, 'QA create draft');
    const edit = page.locator(`[data-purchase-edit="${created.id}"]`);
    await edit.click();
    await page.locator('#purchase-note').fill('QA edit preserved');
    let patchAttempts = 0;
    await page.route('**/api/inventory/purchase-documents/' + created.id, route => {
      if (route.request().method() !== 'PATCH') return route.continue();
      patchAttempts++;
      return patchAttempts === 1 ? route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"qa_unavailable"}' }) : route.continue();
    });
    await save.click();
    await page.waitForFunction(() => !document.querySelector('#purchase-save')?.disabled && document.querySelector('#purchase-message')?.textContent.includes('Не удалось'));
    assert.equal(await save.evaluate(node => document.activeElement === node), true);
    assert.equal(await page.locator('#purchase-note').inputValue(), 'QA edit preserved');
    await save.click(); await dialog.waitFor({ state: 'hidden' });
    assert.equal(patchAttempts, 2);
    await page.unroute('**/api/inventory/purchase-documents/' + created.id);
    await page.reload({ waitUntil: 'networkidle' });
    await edit.click();
    assert.equal(await page.locator('#purchase-note').inputValue(), 'QA edit preserved');
    await page.locator('#purchase-note').fill('QA cancel is not saved');
    await page.locator('#purchase-cancel').click();
    assert.equal((await api('/api/inventory/purchase-documents/' + created.id, token)).note, 'QA edit preserved');
    await receipt.click();
    assert.equal(await page.locator('#purchase-message').innerText(), '', 'new editor has no stale error or success');
    await page.locator('#purchase-cancel').click();
    await edit.click();
    const voidDraft = await api('/api/inventory/purchase-documents', token, 'POST', { supplierName: 'QA Void', documentNumber: 'QA-VOID', lines: [{ ingredientId: water.id, quantity: 1, unit: 'мл', unitCost: 1 }] }, 201);
    const staleVoidDraft = await api('/api/inventory/purchase-documents', token, 'POST', { supplierName: 'QA Stale Void', documentNumber: 'QA-STALE-VOID', lines: [{ ingredientId: water.id, quantity: 1, unit: 'мл', unitCost: 1 }] }, 201);
    const stalePostDraft = await api('/api/inventory/purchase-documents', token, 'POST', { supplierName: 'QA Stale Post', documentNumber: 'QA-STALE-POST', lines: [{ ingredientId: water.id, quantity: 1, unit: 'мл', unitCost: 1 }] }, 201);
    const actionContext = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ru-RU' });
    const actionPage = await actionContext.newPage();
    actionPage.on('pageerror', error => errors.push(error.message));
    await signIn(actionPage, ownerLogin);
    const confirm = actionPage.locator('.purchase-document-confirm');
    const post = actionPage.locator(`[data-purchase-post="${created.id}"]`);
    const cancelConfirm = () => confirm.locator('[data-ui-cancel]');
    const submitConfirm = () => confirm.locator('[type="submit"]');
    const confirmMessage = () => confirm.locator('.ui-modal-message');
    let postAttempts = 0;
    const postGate = gate();
    await actionPage.route('**/api/inventory/purchase-documents/' + created.id + '/post', async route => {
      postAttempts++;
      if (postAttempts === 1) { await postGate.wait(); return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"qa_unavailable"}' }); }
      return route.continue();
    });
    const checkConfirmLayout = async (name) => {
      for (const width of [320, 390, 520, 768, 1440]) {
        await actionPage.setViewportSize({ width, height: width < 600 ? 844 : 1000 });
        const boxes = await confirm.locator('.ui-modal-footer>button').evaluateAll(nodes => nodes.map(node => {
          const range = document.createRange(); range.selectNodeContents(node);
          return { ...node.getBoundingClientRect().toJSON(), lines: range.getClientRects().length };
        }));
        assert.equal(boxes.length, 2);
        assert.ok(boxes.every(box => box.height >= 44 && box.left >= 0 && box.right <= width && box.top >= 0 && box.bottom <= (width < 600 ? 844 : 1000) && box.lines === 1), name + ' visible action bounds at ' + width);
        assert.ok(Math.abs(boxes[0].width - boxes[1].width) < 1 && Math.abs(boxes[0].height - boxes[1].height) < 1, name + ' equal actions at ' + width);
        assert.ok(width <= 600 ? Math.abs(boxes[1].top - boxes[0].bottom - 12) < 1 : Math.abs(boxes[0].top - boxes[1].top) < 1, name + ' aligned footer at ' + width);
        assert.equal(await actionPage.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        assert.equal(await confirm.locator('.ui-modal-body').isVisible(), false, 'fieldless confirmation has no empty body band');
        if ([390, 1440].includes(width)) await actionPage.screenshot({ path: path.join(folder, name + '-' + width + '.png') });
      }
      await actionPage.setViewportSize({ width: 390, height: 844 });
    };
    await post.click(); await checkConfirmLayout('post-confirm');
    await cancelConfirm().click(); await confirm.waitFor({ state: 'hidden' });
    assert.equal(postAttempts, 0, 'cancel confirmation never posts');
    assert.equal(await post.evaluate(node => document.activeElement === node && !node.disabled), true, 'post cancel restores enabled original opener');
    await post.click(); await submitConfirm().click();
    await actionPage.waitForFunction(() => document.querySelector('.purchase-document-confirm')?.getAttribute('aria-busy') === 'true');
    assert.equal(await cancelConfirm().isDisabled(), true);
    assert.equal(await post.isDisabled(), true);
    await actionPage.keyboard.press('Enter'); await actionPage.keyboard.press('Escape'); await actionPage.mouse.click(3, 3);
    assert.equal(await confirm.isVisible(), true); assert.equal(postAttempts, 1);
    postGate.release();
    await confirmMessage().waitFor({ state: 'visible' });
    assert.equal(await confirmMessage().evaluate(node => document.activeElement === node), true);
    assert.match(await confirmMessage().innerText(), /Проверьте журнал/);
    assert.equal(await actionPage.locator('#portal-notice[data-kind="error"]').count(), 0, 'post error has one inline presentation');
    await actionPage.screenshot({ path: path.join(folder, 'post-error-390.png') });
    await submitConfirm().click(); await confirm.waitFor({ state: 'hidden' });
    assert.equal(postAttempts, 2); assert.equal(await stock(), 2000, 'UI post changes stock exactly once');
    assert.equal(await actionPage.locator('#purchase-document-list').evaluate(node => document.activeElement === node), true, 'removed opener returns to neutral journal, not another document action');
    assert.equal((await api('/api/inventory/purchase-documents/' + created.id, token)).status, 'posted');
    await actionPage.reload({ waitUntil: 'networkidle' });
    assert.equal(await actionPage.locator(`[data-purchase-post="${created.id}"]`).count(), 0, 'posted document remains posted after reload');
    let voidAttempts = 0;
    const voidGate = gate();
    await actionPage.route('**/api/inventory/purchase-documents/' + voidDraft.id + '/void', async route => {
      voidAttempts++;
      if (voidAttempts === 1) { await voidGate.wait(); return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"qa_unavailable"}' }); }
      return route.continue();
    });
    const voidButton = actionPage.locator(`[data-purchase-void="${voidDraft.id}"]`);
    await voidButton.click(); await checkConfirmLayout('void-confirm');
    assert.equal(await submitConfirm().evaluate(node => node.classList.contains('ui-button--danger') && !node.classList.contains('ui-button--primary') && getComputedStyle(node).backgroundImage.includes('linear-gradient')), true, 'only destructive confirmation uses danger gradient');
    await cancelConfirm().click(); await confirm.waitFor({ state: 'hidden' });
    assert.equal(voidAttempts, 0);
    assert.equal(await voidButton.evaluate(node => document.activeElement === node && !node.disabled), true);
    assert.equal((await api('/api/inventory/purchase-documents/' + voidDraft.id, token)).status, 'draft');
    await voidButton.click(); await submitConfirm().click();
    await actionPage.waitForFunction(() => document.querySelector('.purchase-document-confirm')?.getAttribute('aria-busy') === 'true');
    assert.equal(await cancelConfirm().isDisabled(), true);
    assert.equal(await confirm.locator('[data-ui-close]').isDisabled(), true);
    await actionPage.keyboard.press('Enter'); await actionPage.keyboard.press('Escape'); await actionPage.mouse.click(3, 3);
    assert.equal(await confirm.isVisible(), true); assert.equal(voidAttempts, 1);
    voidGate.release(); await confirmMessage().waitFor({ state: 'visible' });
    assert.match(await confirmMessage().innerText(), /Результат отмены не подтверждён/);
    assert.equal(await confirmMessage().evaluate(node => document.activeElement === node), true);
    assert.equal(await actionPage.locator('#portal-notice[data-kind="error"]').count(), 0);
    await actionPage.screenshot({ path: path.join(folder, 'void-error-390.png') });
    await submitConfirm().click(); await confirm.waitFor({ state: 'hidden' });
    assert.equal(voidAttempts, 2); assert.equal(await stock(), 2000, 'void never changes stock');
    assert.equal((await api('/api/inventory/purchase-documents/' + voidDraft.id, token)).status, 'voided');
    assert.equal(await actionPage.locator('#purchase-document-list').evaluate(node => document.activeElement === node), true);
    await actionPage.reload({ waitUntil: 'networkidle' });
    assert.equal(await actionPage.locator(`[data-purchase-void="${voidDraft.id}"]`).count(), 0);
    await actionPage.locator(`[data-purchase-void="${staleVoidDraft.id}"]`).click();
    await api('/api/inventory/purchase-documents/' + staleVoidDraft.id + '/void', token, 'POST', undefined, 200);
    let staleVoidAttempts = 0;
    actionPage.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/' + staleVoidDraft.id + '/void')) staleVoidAttempts++; });
    await submitConfirm().click(); await confirmMessage().waitFor({ state: 'visible' });
    assert.match(await confirmMessage().innerText(), /уже проведён или отменён/);
    await submitConfirm().click();
    assert.match(await confirmMessage().innerText(), /Закройте окно/);
    assert.equal(staleVoidAttempts, 1, 'stale conflict cannot send a blind second request');
    await cancelConfirm().click(); await confirm.waitFor({ state: 'hidden' });
    assert.equal(await stock(), 2000);
    await actionPage.locator(`[data-purchase-post="${stalePostDraft.id}"]`).click();
    await api('/api/inventory/purchase-documents/' + stalePostDraft.id + '/void', token, 'POST', undefined, 200);
    let stalePostAttempts = 0;
    actionPage.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/' + stalePostDraft.id + '/post')) stalePostAttempts++; });
    await submitConfirm().click(); await confirmMessage().waitFor({ state: 'visible' });
    assert.match(await confirmMessage().innerText(), /уже проведён или отменён/);
    await submitConfirm().click();
    assert.match(await confirmMessage().innerText(), /Закройте окно/);
    assert.equal(stalePostAttempts, 1, 'stale post conflict cannot send a blind second request');
    await cancelConfirm().click(); await confirm.waitFor({ state: 'hidden' });
    assert.equal(await stock(), 2000);
    assert.equal((await api('/api/inventory/purchase-documents/' + stalePostDraft.id, token)).status, 'voided');
    await actionContext.close();
    await page.locator('#purchase-note').fill('stale edit must fail');
    await save.click();
    await page.waitForFunction(() => !document.querySelector('#purchase-save')?.disabled && document.querySelector('#purchase-message')?.textContent.includes('уже проведён'));
    assert.equal(await stock(), 2000, 'stale edit never posts twice or changes stock');
    assert.equal(await save.evaluate(node => document.activeElement === node), true);
    await page.locator('#purchase-cancel').click();
    const listGate = gate(); let listReads = 0;
    await page.route('**/api/inventory/purchase-documents*', async route => {
      if (route.request().method() !== 'GET' || new URL(route.request().url()).pathname !== '/api/inventory/purchase-documents') return route.continue();
      listReads++;
      if (listReads === 1) { await listGate.wait(); return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"qa_unavailable"}' }); }
      return route.continue();
    });
    await page.locator('#purchase-filter-apply').click();
    await page.waitForFunction(() => document.querySelector('#purchase-document-list')?.getAttribute('aria-busy') === 'true');
    assert.equal(await list.locator('button:not(:disabled)').count(), 0, 'stale rows cannot be changed while journal is loading');
    listGate.release();
    await page.locator('[data-purchase-retry]').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#purchase-filter-message').getAttribute('role'), 'alert');
    await page.locator('[data-purchase-retry]').click();
    await page.waitForFunction(() => !document.querySelector('[data-purchase-retry]') && document.querySelector('#purchase-document-list')?.getAttribute('aria-busy') === 'false');
    assert.equal(await list.evaluate(node => node.contains(document.activeElement)), true, 'successful retry retains journal focus');
    await page.unroute('**/api/inventory/purchase-documents*');
    const oldReadGate = gate();
    await page.route('**/api/inventory/purchase-documents', async route => {
      if (route.request().method() !== 'GET') return route.continue();
      const response = await route.fetch(); await oldReadGate.wait(); await route.fulfill({ response });
    });
    await page.locator('#purchase-filter-apply').click();
    await page.waitForFunction(() => document.querySelector('#purchase-document-list')?.getAttribute('aria-busy') === 'true');
    await page.locator('#purchase-filter-from').fill('2026-10-23');
    await page.locator('#purchase-filter-to').fill('2026-10-01');
    await page.locator('#purchase-filter-apply').click();
    assert.match(await page.locator('#purchase-filter-message').innerText(), /Начало периода/);
    assert.equal(await list.locator('[data-purchase-edit],[data-purchase-post]').count(), 0, 'invalid period has no apparently current actions');
    const oldResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/inventory/purchase-documents' && response.request().method() === 'GET');
    oldReadGate.release(); await (await oldResponse).finished();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    assert.match(await page.locator('#purchase-filter-message').innerText(), /Начало периода/);
    assert.equal(await list.locator('[data-purchase-edit],[data-purchase-post]').count(), 0, 'late previous read cannot replace an invalid newer query');
    assert.equal(await list.getAttribute('aria-busy'), 'false');
    await page.unroute('**/api/inventory/purchase-documents');
    await page.locator('#purchase-filter-reset').click();
    await list.locator(`[data-purchase-edit="${literal.id}"]`).waitFor({ state: 'visible' });
    const readerContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const reader = await readerContext.newPage();
    reader.on('pageerror', error => errors.push(error.message));
    await signIn(reader, 'qa_purchase_reader');
    assert.equal(await reader.locator('#purchase-document-form,[data-purchase-edit],[data-purchase-post]').count(), 0);
    assert.equal(await reader.locator('#purchase-document-list em[data-qa]').count(), 0);
    assert.ok((await reader.locator('#purchase-document-list').innerText()).includes(literalNumber));
    const readerToken = await reader.evaluate(() => localStorage.getItem('crm_session_token'));
    await api('/api/inventory/purchase-documents', readerToken, 'POST', { supplierName: 'forbidden', lines: [] }, 403);
    await api('/api/inventory/purchase-documents/' + literal.id + '/post', readerToken, 'POST', undefined, 403);
    await api('/api/inventory/purchase-documents/' + literal.id + '/void', readerToken, 'POST', undefined, 403);
    const voidSql = (await client.query('SELECT status FROM inventory_purchase_documents WHERE id=$1 AND venue_id=$2', [voidDraft.id, venueId])).rows[0];
    assert.equal(voidSql.status, 'voided');
    assert.deepEqual(errors, []);
    const sql = (await client.query('SELECT status,note FROM inventory_purchase_documents WHERE id=$1 AND venue_id=$2', [created.id, venueId])).rows[0];
    assert.deepEqual(sql, { status: 'posted', note: 'QA edit preserved' });
    console.log('PASS PostgreSQL purchase editor ' + (useDist ? 'dist' : 'source') + ': literal markup, row focus/preview, create+edit503/retry/SQL/readback/cancel/stale409, post+void UI cancel/pending/503/retry/SQL/stock/focus+stale409, list503/retry/invalid range, reader403, footer320/390/520/768/1440');
  } catch (error) {
    const page = browser?.contexts()[0]?.pages()[0];
    await page?.screenshot({ path: path.join(folder, 'failure.png') }).catch(() => {});
    throw error;
  } finally {
    releases.forEach(release => release());
    await browser?.close();
    if (server) {
      const stopped = server.exitCode === null && server.signalCode === null ? once(server, 'close') : Promise.resolve();
      server.kill(); await stopped;
    }
    await client.end();
  }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
