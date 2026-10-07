import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const playwrightPath = process.env.PLAYWRIGHT_PACKAGE_PATH;
if (!playwrightPath) throw new Error('Set PLAYWRIGHT_PACKAGE_PATH');
const { chromium } = createRequire(import.meta.url)(playwrightPath);
const child = spawn(process.execPath, ['server.js'], {
  cwd: fileURLToPath(new URL('../', import.meta.url)), windowsHide: true,
  env: { ...process.env, HOST: '127.0.0.1', PORT: '0', DATABASE_URL: '', AUTH_REQUIRED: 'false', DEMO_MODE: 'false', NODE_ENV: 'test' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stdout.on('data', (chunk) => { output += chunk; });
child.stderr.on('data', (chunk) => { output += chunk; });
let browser;
try {
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Venue layout QA server did not start: ${output}`)), 15000);
    child.once('error', reject);
    child.stdout.on('data', () => { const match = output.match(/CRM running on http:\/\/localhost:(\d+)/); if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); } });
  });
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 375, height: 800 }, locale: 'ru-RU' });
  const exceptions = [];
  page.on('pageerror', (error) => exceptions.push(error.stack || error.message));
  await page.goto(`${base}/login`, { waitUntil: 'networkidle' });
  await page.locator('#login-username').fill('admin');
  await page.locator('#login-password').fill('admin');
  await page.locator('#login-form button[type="submit"]').click();
  await page.waitForURL((url) => !url.pathname.includes('/login'));
  const seeded = await page.evaluate(async () => { const floor = await (await fetch('/api/floor')).json(); const zone = await (await fetch('/api/floor/zones', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedVenueId: floor.venueId, name: 'QA зал' }) })).json(); const create = (name, minCapacity, maxCapacity) => fetch('/api/floor/tables', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedVenueId: floor.venueId, zoneId: zone.id, name, capacity: maxCapacity, minCapacity, maxCapacity }) }); const a = await create('Стол QA', 2, 6); const b = await create('Стол QA второй', 1, 3); return [a.status, b.status]; });
  assert.deepEqual(seeded, [201, 201]);
  let failFloor = true;
  let failReadOnce = false;
  let holdReadOnce = false;
  let releaseHeldRead;
  let heldReadStarted;
  await page.route('**/api/floor', (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    if (holdReadOnce) {
      holdReadOnce = false;
      heldReadStarted();
      return new Promise((resolve) => { releaseHeldRead = () => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"floor_unavailable"}' }).then(resolve); });
    }
    if (failFloor || failReadOnce) { failReadOnce = false; return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"floor_unavailable"}' }); }
    return route.continue();
  });
  await page.goto(`${base}/admin#venue-layout-settings`, { waitUntil: 'networkidle' });
  await page.locator('[data-venue-layout-retry]').waitFor();
  await page.locator('[data-floor-refresh]').waitFor();
  assert.equal(await page.locator('#floor-editor-count').textContent(), 'Ошибка загрузки');
  exceptions.length = 0;
  assert.equal(await page.locator('#new-floor-table').isDisabled(), true);
  assert.equal(await page.locator('#new-vip-room').isDisabled(), true);
  failFloor = false;
  await page.locator('[data-venue-layout-retry]').click();
  await page.locator('[data-venue-layout-retry]').waitFor({ state: 'hidden' });
  await page.locator('.venue-zone-card').first().waitFor();
  await page.locator('[data-floor-refresh]').click();
  await page.locator('[data-floor-table]').first().waitFor();
  await page.locator('[data-floor-refresh]').waitFor({ state: 'hidden' });
  const floorTable = page.locator('[data-floor-table]').first();
  let editorPatches = 0;
  page.on('request', (request) => { if (request.method() === 'PATCH' && /\/api\/floor\/tables\//.test(request.url())) editorPatches++; });
  await page.locator('[data-floor-drag]').first().click();
  assert.equal(editorPatches, 0, 'click without movement must not save position');
  const dragObject = page.locator('[data-floor-drag]').first();
  const beforeDrag = await dragObject.evaluate((el) => ({ x: Number.parseFloat(el.style.left), y: Number.parseFloat(el.style.top) }));
  const bounds = await dragObject.boundingBox();
  const dragSaved = page.waitForResponse((response) => response.request().method() === 'PATCH' && /\/api\/floor\/tables\//.test(response.url()));
  await page.mouse.move(bounds.x + 20, bounds.y + 20);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 43, bounds.y + 34, { steps: 3 });
  await page.mouse.up();
  assert.equal((await dragSaved).status(), 200);
  const afterDrag = await page.evaluate(async () => (await (await fetch('/api/floor')).json()).zones.flatMap((zone) => zone.tables)[0].layout);
  assert.equal(afterDrag.x, beforeDrag.x + 23);
  assert.equal(afterDrag.y, beforeDrag.y + 14);
  assert.equal(afterDrag.unit, 'px', 'editor writes explicit pixel geometry');
  assert.equal(Number(await floorTable.locator('[name="x"]').inputValue()), afterDrag.x, 'form x follows drag');
  assert.equal(Number(await floorTable.locator('[name="y"]').inputValue()), afterDrag.y, 'form y follows drag');
  await floorTable.locator('[name="name"]').fill('Стол QA обновлён');
  await floorTable.locator('[type="submit"]').click();
  await page.getByText('Стол QA обновлён').first().waitFor();
  const rangeAfterName = await page.evaluate(async () => (await (await fetch('/api/floor')).json()).zones.flatMap((zone) => zone.tables).find((table) => table.name === 'Стол QA обновлён'));
  assert.equal(rangeAfterName.minCapacity, 2, 'name edit must preserve lower capacity');
  assert.equal(rangeAfterName.maxCapacity, 6, 'name edit must preserve upper capacity');
  failReadOnce = true;
  await page.locator('[data-floor-table]').first().locator('[name="name"]').fill('Стол QA после сбоя чтения');
  await page.locator('[data-floor-table]').first().locator('[type="submit"]').click();
  await page.getByText('Параметры сохранены, но схема не обновилась. Повторите загрузку.').waitFor();
  assert.equal((await page.evaluate(async () => (await (await fetch('/api/floor')).json()).zones.flatMap((zone) => zone.tables)[0].name)), 'Стол QA после сбоя чтения', 'PATCH success is persisted despite failed GET');
  await page.locator('[data-floor-refresh]').click();
  await page.locator('[data-floor-refresh]').waitFor({ state: 'hidden' });
  await page.getByText('Стол QA после сбоя чтения').first().waitFor();
  const secondCard = page.locator('.floor-editor-card-disclosure').nth(1);
  await secondCard.locator('summary').click();
  await secondCard.locator('[name="name"]').fill('Черновик второго стола');
  await page.locator('[data-floor-block]').first().click();
  await page.locator('[data-floor-block]').first().getByText('Разблокировать').waitFor();
  assert.equal(await secondCard.locator('[name="name"]').inputValue(), 'Черновик второго стола', 'other table draft survives redraw');
  assert.equal(await secondCard.evaluate((el) => el.open), true, 'other table stays open');
  assert.equal((await page.evaluate(async () => (await (await fetch('/api/floor')).json()).zones.flatMap((zone) => zone.tables)[0].status)), 'blocked');
  await page.locator('[data-floor-block]').first().click();
  await page.locator('[data-floor-block]').first().getByText('Заблокировать').waitFor();
  const heldRead = new Promise((resolve) => { heldReadStarted = resolve; });
  holdReadOnce = true;
  await page.locator('[data-floor-block]').first().click();
  await heldRead;
  await page.locator('[data-floor-block]').nth(1).click();
  await page.locator('[data-floor-block]').nth(1).getByText('Разблокировать').waitFor();
  releaseHeldRead();
  await page.waitForTimeout(100);
  assert.equal(await page.locator('[data-floor-refresh]').isHidden(), true, 'superseded GET error must not stale current editor');
  failReadOnce = true;
  await page.locator('[data-floor-block]').first().click();
  await page.getByText('Статус изменён, но схема не обновилась. Повторите загрузку.').waitFor();
  assert.equal(await page.locator('[data-floor-block]').first().isDisabled(), true, 'stale editor blocks mutation');
  await page.locator('[data-floor-refresh]').click();
  await page.locator('[data-floor-refresh]').waitFor({ state: 'hidden' });
  assert.equal(await secondCard.locator('[name="name"]').inputValue(), 'Черновик второго стола', 'retry preserves other draft');
  await page.locator('[data-floor-block]').first().click();
  await page.locator('[data-floor-block]').first().getByText('Заблокировать').waitFor();
  assert.equal(await page.locator('#new-floor-table').isDisabled(), false);
  for (const width of [320, 375, 768, 1440]) {
    await page.setViewportSize({ width, height: 800 });
    const layout = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth > innerWidth + 1,
      gap: getComputedStyle(document.querySelector('#venue-zone-list')).gap,
      canvasTouch: getComputedStyle(document.querySelector('#floor-editor-canvas')).touchAction,
    }));
    assert.equal(layout.overflow, false, `layout overflows at ${width}px`);
    assert.notEqual(layout.gap, 'normal', `zone list has no gap at ${width}px`);
    assert.notEqual(layout.canvasTouch, 'none', `empty canvas traps touch scroll at ${width}px`);
  }
  await page.evaluate(() => document.querySelector('.portal').classList.add('light-theme'));
  const light = await page.evaluate(() => ({
    card: getComputedStyle(document.querySelector('.venue-zone-card')).backgroundColor,
    guide: getComputedStyle(document.querySelector('.venue-layout-guide')).backgroundColor,
  }));
  assert.notEqual(light.card, 'rgb(21, 24, 29)', 'light theme retains dark zone cards');
  assert.notEqual(light.guide, 'rgb(20, 23, 27)', 'light theme retains dark guide');
  assert.notEqual(await page.locator('.floor-editor-card-disclosure').first().evaluate((el) => getComputedStyle(el).backgroundColor), 'rgb(21, 24, 29)', 'light theme retains dark floor editor');
  const customZone = await page.evaluate(async () => {
    const floor = await (await fetch('/api/floor')).json();
    const zone = await (await fetch('/api/floor/zones', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedVenueId: floor.venueId, name: 'Крыша QA' }) })).json();
    const create = async (name) => (await (await fetch('/api/floor/tables', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedVenueId: floor.venueId, zoneId: zone.id, name, capacity: 4, minCapacity: 2, maxCapacity: 4 }) })).json());
    const table = await create('Крыша 1');
    const second = await create('Крыша 2');
    const legacy = await create('Крыша legacy');
    const move = (id, layout) => fetch(`/api/floor/tables/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedVenueId: floor.venueId, layout }) });
    await move(table.id, { unit: 'px', x: 4, y: 8, width: 160, height: 90, shape: 'circle', rotation: 15 });
    await move(second.id, { unit: 'px', x: 203, y: 137, width: 180, height: 100, shape: 'oval' });
    await move(legacy.id, { unit: 'grid', x: 5, y: 4, w: 3, h: 2 });
    return { zoneId: zone.id, tableId: table.id, secondTableId: second.id, legacyTableId: legacy.id };
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator(`[data-floor-zone-tab="${customZone.zoneId}"]`).waitFor();
  assert.equal(await page.locator(`[data-floor-drag="${customZone.legacyTableId}"]`).count(), 0, 'another zone must not overlap the selected editor canvas');
  await page.locator(`[data-floor-zone-tab="${customZone.zoneId}"]`).click();
  assert.equal(await page.locator('#floor-editor-canvas [data-floor-drag]').count(), 3, 'selected zone shows only its three tables');
  assert.equal(await page.locator(`[data-floor-zone-tab="${customZone.zoneId}"]`).getAttribute('aria-selected'), 'true');
  await page.locator(`[data-floor-drag="${customZone.legacyTableId}"]`).waitFor();
  assert.equal(await page.locator(`[data-floor-drag="${customZone.legacyTableId}"]`).evaluate((el) => el.style.left), '332px', 'editor maps legacy grid x to pixel stage');
  assert.equal(await page.locator(`[data-floor-drag="${customZone.legacyTableId}"]`).evaluate((el) => el.style.top), '147px', 'editor maps legacy grid y to pixel stage');
  const posContext = await browser.newContext({ storageState: await page.context().storageState(), viewport: { width: 375, height: 800 } });
  const posPage = await posContext.newPage();
  const posErrors = [];
  posPage.on('pageerror', (error) => posErrors.push(error.message));
  let failPosFloor = true;
  let holdPosReadOnce = false;
  let releasePosRead;
  let posReadStarted;
  await posPage.route('**/api/floor', (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    if (holdPosReadOnce) {
      holdPosReadOnce = false;
      posReadStarted();
      return new Promise((resolve) => { releasePosRead = () => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"floor_unavailable"}' }).then(resolve); });
    }
    return failPosFloor ? route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"floor_unavailable"}' }) : route.continue();
  });
  await posPage.goto(base, { waitUntil: 'networkidle' });
  await posPage.locator('[data-staff-floor-retry]').waitFor();
  assert.equal(await posPage.locator('.table').count(), 0, 'failed floor read must hide stale tables');
  assert.equal(await posPage.locator('.order').evaluate((el) => el.inert), true, 'order actions are unavailable without floor');
  failPosFloor = false;
  await posPage.locator('[data-staff-floor-retry]').click();
  await posPage.locator(`[data-zone-id="${customZone.zoneId}"]`).waitFor();
  await posPage.locator(`[data-zone-id="${customZone.zoneId}"]`).click();
  await posPage.locator(`[data-table="${customZone.tableId}"]`).waitFor();
  assert.equal(await posPage.locator(`[data-table="${customZone.legacyTableId}"]`).getAttribute('data-layout-x'), '332', 'legacy grid x remains mapped');
  assert.equal(await posPage.locator(`[data-table="${customZone.legacyTableId}"]`).getAttribute('data-layout-y'), '147', 'legacy grid y remains mapped');
  assert.equal(await posPage.locator('.order').evaluate((el) => el.inert), false, 'order actions recover after floor retry');
  assert.equal(await posPage.locator(`[data-zone-id="${customZone.zoneId}"]`).getAttribute('aria-selected'), 'true');
  assert.match(await posPage.locator(`[data-table="${customZone.tableId}"]`).innerText(), /2–4 гост/);
  await posPage.locator(`[data-table="${customZone.tableId}"]`).click();
  assert.match(await posPage.locator('.order h2').innerText(), /Крыша 1/);
  failPosFloor = true;
  await posPage.evaluate(() => window.dispatchEvent(new Event('focus')));
  await posPage.locator('[data-staff-floor-retry]').waitFor();
  assert.equal(await posPage.locator('.table').count(), 0, 'failed refresh must remove previous venue tables');
  assert.equal(await posPage.locator('.order').evaluate((el) => el.inert), true, 'failed refresh must lock stale order actions');
  assert.equal(await posPage.locator('#queue-list [data-queue-table]').count(), 0, 'failed refresh must clear stale order queue');
  failPosFloor = false;
  await posPage.locator('[data-staff-floor-retry]').click();
  await posPage.locator(`[data-zone-id="${customZone.zoneId}"]`).click();
  await posPage.locator(`[data-table="${customZone.tableId}"]`).waitFor();
  const posHeldRead = new Promise((resolve) => { posReadStarted = resolve; });
  holdPosReadOnce = true;
  await posPage.evaluate(() => window.dispatchEvent(new Event('focus')));
  await posHeldRead;
  assert.equal(await posPage.locator('.order').evaluate((el) => el.inert), true, 'pending floor refresh locks old order');
  await posPage.evaluate(() => window.dispatchEvent(new Event('focus')));
  await posPage.locator(`[data-table="${customZone.tableId}"]:not([disabled])`).waitFor();
  assert.equal(await posPage.locator('.order').evaluate((el) => el.inert), false, 'new floor releases order actions');
  releasePosRead();
  await posPage.waitForTimeout(100);
  assert.equal(await posPage.locator('[data-staff-floor-retry]').count(), 0, 'superseded POS GET error must not hide current floor');
  for (const width of [320, 375, 768, 1440]) {
    await posPage.setViewportSize({ width, height: 800 });
    assert.equal(await posPage.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `POS overflows at ${width}px`);
    assert.equal(await posPage.locator(`[data-table="${customZone.tableId}"]`).isVisible(), true, `POS custom table hidden at ${width}px`);
    const geometry = await posPage.evaluate((ids) => {
      const stage = document.querySelector('.tables .floor-map-stage');
      const a = document.querySelector(`[data-table="${ids.a}"]`);
      const b = document.querySelector(`[data-table="${ids.b}"]`);
      const stageRect = stage.getBoundingClientRect();
      const aRect = a.getBoundingClientRect();
      const bRect = b.getBoundingClientRect();
      return { sceneWidth: Number(stage.dataset.sceneWidth), sceneHeight: Number(stage.dataset.sceneHeight), sceneLeft: Number(stage.dataset.sceneLeft), sceneTop: Number(stage.dataset.sceneTop), position: getComputedStyle(a).position, radius: getComputedStyle(a).borderRadius, a: { x: parseFloat(getComputedStyle(a).left) / stageRect.width * Number(stage.dataset.sceneWidth), y: parseFloat(getComputedStyle(a).top) / stageRect.height * Number(stage.dataset.sceneHeight), width: parseFloat(getComputedStyle(a).width) / stageRect.width * Number(stage.dataset.sceneWidth) }, b: { x: parseFloat(getComputedStyle(b).left) / stageRect.width * Number(stage.dataset.sceneWidth), y: parseFloat(getComputedStyle(b).top) / stageRect.height * Number(stage.dataset.sceneHeight) } };
    }, { a: customZone.tableId, b: customZone.secondTableId });
    if (width >= 901) {
      assert.equal(geometry.position, 'absolute', 'wide POS uses a spatial map');
      assert.ok(Math.abs(geometry.a.x + geometry.sceneLeft - 4) < 2 && Math.abs(geometry.a.y + geometry.sceneTop - 8) < 2, 'first table keeps editor x/y after rotated-scene offset');
      assert.ok(Math.abs(geometry.a.width - 160) < 2, 'first table keeps editor width');
      assert.ok(Math.abs(geometry.b.x + geometry.sceneLeft - 203) < 2 && Math.abs(geometry.b.y + geometry.sceneTop - 137) < 2, 'second table keeps editor x/y after rotated-scene offset');
    } else {
      assert.equal(geometry.position, 'relative', 'compact POS uses readable cards');
      assert.equal(geometry.radius, '12px', 'compact table shape is neutral');
    }
  }
  const transferOrder = await posPage.evaluate(async (tableId) => {
    const send = async (url, body) => { const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: response.status, data: await response.json() }; };
    const shift = await send('/api/shifts', { openingCash: 0 });
    const product = await send('/api/products', { name: 'Transfer QA service', category: 'Услуги', price: 100, inventoryMode: 'non_stock' });
    const order = await send('/api/orders', { tableId });
    const item = await send(`/api/orders/${encodeURIComponent(order.data.id)}/items`, { productId: product.data.id, quantity: 1 });
    return { shift: shift.status, product: product.status, order: order.status, item: item.status, id: order.data.id };
  }, customZone.tableId);
  assert.deepEqual([transferOrder.shift, transferOrder.product, transferOrder.order, transferOrder.item], [201, 201, 201, 201], 'transfer fixture requires a persisted open order with an item');
  await posPage.reload({ waitUntil: 'networkidle' });
  await posPage.locator(`[data-zone-id="${customZone.zoneId}"]`).click();
  await posPage.locator(`[data-table="${customZone.tableId}"]`).click();
  await posPage.locator('#transfer-order:not([disabled])').click();
  const transferSelect = posPage.locator('#staff-action-form select[name="tableId"]');
  await transferSelect.waitFor();
  assert.equal(await transferSelect.locator(`option[value="${customZone.secondTableId}"]`).count(), 1, 'transfer offers exact persisted table ID');
  assert.equal(await transferSelect.locator(`option[value="${customZone.tableId}"]`).count(), 0, 'transfer excludes current table');
  await transferSelect.selectOption(customZone.secondTableId);
  const transferResponse = posPage.waitForResponse((response) => response.request().method() === 'POST' && response.url().endsWith(`/api/orders/${transferOrder.id}/transfer`));
  await posPage.locator('#staff-action-submit').click();
  assert.equal((await transferResponse).status(), 200, 'POS transfers order with exact table ID');
  const persistedTransfer = await posPage.evaluate(async (id) => (await (await fetch('/api/orders')).json()).items.find((order) => order.id === id), transferOrder.id);
  assert.equal(persistedTransfer.tableId, customZone.secondTableId, 'transfer survives API reread');
  const transferFloor = await posPage.evaluate(async () => (await (await fetch('/api/floor')).json()).zones.flatMap((zone) => zone.tables));
  assert.equal(transferFloor.find((table) => table.id === customZone.tableId).status, 'free', 'source table is released');
  assert.equal(transferFloor.find((table) => table.id === customZone.secondTableId).status, 'occupied', 'destination table is occupied');
  const missingTarget = await posPage.evaluate(async (id) => (await fetch(`/api/orders/${encodeURIComponent(id)}/transfer`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tableId: 'missing-table' }) })).status, transferOrder.id);
  assert.equal(missingTarget, 404, 'memory API refuses a target absent from the floor');
  await posPage.reload({ waitUntil: 'networkidle' });
  await posPage.locator(`[data-zone-id="${customZone.zoneId}"]`).click();
  await posPage.locator(`[data-table="${customZone.secondTableId}"]`).click();
  assert.match(await posPage.locator('.order h2').innerText(), /Крыша 2/, 'transferred order opens on destination after reload');
  await page.evaluate(async (tableId) => { const floor = await (await fetch('/api/floor')).json(); await fetch(`/api/floor/tables/${encodeURIComponent(tableId)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedVenueId: floor.venueId, status: 'blocked' }) }); }, customZone.tableId);
  await posPage.evaluate(() => window.dispatchEvent(new Event('focus')));
  await posPage.locator(`[data-table="${customZone.tableId}"]`).getByText('Закрыт').waitFor();
  await posPage.locator(`[data-table="${customZone.tableId}"][disabled]`).waitFor();
  assert.match(await posPage.locator(`[data-table="${customZone.tableId}"]`).innerText(), /Закрыт/);
  await posPage.locator('#transfer-order:not([disabled])').click();
  assert.equal(await posPage.locator(`#staff-action-form option[value="${customZone.tableId}"]`).count(), 0, 'blocked destination is absent from transfer choice');
  await posPage.locator('#staff-action-cancel').click();
  const blockedTarget = await posPage.evaluate(async ({ id, tableId }) => (await fetch(`/api/orders/${encodeURIComponent(id)}/transfer`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tableId }) })).status, { id: transferOrder.id, tableId: customZone.tableId });
  assert.equal(blockedTarget, 404, 'memory API refuses blocked destination');
  assert.deepEqual(posErrors, [], `POS browser exceptions: ${posErrors.join('; ')}`);
  const demoPosContext = await browser.newContext({ viewport: { width: 375, height: 800 } });
  await demoPosContext.addInitScript(() => {
    localStorage.setItem('crm_session_token', 'demo-static-floor-pos');
    localStorage.setItem('crm_session_user', JSON.stringify({ id: 'demo-floor-pos', name: 'Demo', role: 'admin' }));
    localStorage.setItem('territory_crm_demo_state', JSON.stringify({ networkCurrentId: 'demo-venue-b', floorZones: [{ id: 'demo-zone-a', name: 'Старый зал', tables: [{ id: 'demo-table-a', name: 'Старый стол', capacity: 2 }] }], floorByVenue: { 'demo-venue-b': { floorZones: [{ id: 'demo-zone-b', name: 'Новая точка', tables: [{ id: 'demo-table-b', name: 'Новый стол', capacity: 4 }] }] } } }));
  });
  const demoPosPage = await demoPosContext.newPage();
  await demoPosPage.goto(base, { waitUntil: 'networkidle' });
  await demoPosPage.locator('[data-zone-id="demo-zone-b"]').waitFor();
  assert.equal(await demoPosPage.locator('[data-zone-id="demo-zone-a"]').count(), 0, 'demo POS must isolate venue floors');
  assert.equal(await demoPosPage.locator('[data-table="demo-table-b"]').count(), 1);
  await demoPosContext.close();
  await page.locator('#new-floor-zone').click();
  await page.locator('#venue-zone-name').fill('Stale Floor Draft');
  const switched = await page.evaluate(async () => {
    const current = await (await fetch('/api/floor')).json();
    const created = await (await fetch('/api/network/venues', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'QA B', city: 'Тюмень', address: 'QA адрес' }) })).json();
    const status = (await fetch(`/api/network/venues/${created.id}/select`, { method: 'POST' })).status;
    return { currentId: current.venueId, newId: created.id, status };
  });
  assert.equal(switched.status, 200);
  await page.locator('[data-floor-block]').first().click();
  await page.locator('[data-floor-table]').first().waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#floor-editor').getAttribute('data-venue-id'), switched.newId, 'stale editor reloads selected venue');
  await page.locator('#venue-zone-form button[type="submit"]').click();
  await page.getByText('Точка изменилась. Закройте форму и откройте новую карточку зала.').waitFor();
  assert.equal(await page.locator('#venue-zone-form button[type="submit"]').isDisabled(), true);
  const floorB = await page.evaluate(async () => (await (await fetch('/api/floor')).json()));
  assert.equal(floorB.venueId, switched.newId);
  assert.equal(floorB.zones.some((zone) => zone.name === 'Stale Floor Draft' || zone.name === 'QA зал'), false);
  await page.locator('#cancel-venue-zone').click();
  await page.locator('#new-floor-zone').click();
  await page.locator('#venue-zone-name').fill('B Floor');
  await page.locator('#venue-zone-form button[type="submit"]').click();
  await page.getByText('Зал создан. Добавьте в него первый стол.').waitFor();
  assert.equal((await page.evaluate(async () => (await (await fetch('/api/floor')).json()))).zones.some((zone) => zone.name === 'B Floor'), true);
  await posPage.evaluate(() => window.dispatchEvent(new Event('focus')));
  await posPage.getByRole('tab', { name: 'B Floor' }).waitFor();
  assert.equal(await posPage.locator(`[data-zone-id="${customZone.zoneId}"]`).count(), 0, 'POS must drop old venue zones');
  assert.equal(await posPage.locator('.table').count(), 0, 'POS must drop old venue tables');
  await posContext.close();
  await page.evaluate(async (id) => fetch(`/api/network/venues/${id}/select`, { method: 'POST' }), switched.currentId);
  assert.equal((await page.evaluate(async () => (await (await fetch('/api/floor')).json()))).zones.some((zone) => zone.name === 'QA зал'), true);
  assert.deepEqual(exceptions, [], `browser exceptions: ${exceptions.join('; ')}`);
  const demoPage = await browser.newPage({ viewport: { width: 375, height: 800 }, locale: 'ru-RU' });
  await demoPage.addInitScript(() => { localStorage.setItem('crm_session_token', 'demo-static-admin-qa'); localStorage.setItem('crm_session_user', JSON.stringify({ id: 'demo-admin-qa', name: 'QA Admin', role: 'admin' })); });
  await demoPage.goto(`${base}/admin#venue-layout-settings`, { waitUntil: 'networkidle' });
  await demoPage.waitForFunction(() => Boolean(window.__crmApi));
  const staticResult = await demoPage.evaluate(async () => {
    const a = await window.__crmApi('/api/floor');
    const aZone = await window.__crmApi('/api/floor/zones', { method: 'POST', body: JSON.stringify({ expectedVenueId: a.venueId, name: 'Static A Zone' }) });
    const b = await window.__crmApi('/api/network/venues', { method: 'POST', body: JSON.stringify({ name: 'Static B', city: 'Тюмень', address: 'QA адрес' }) });
    await window.__crmApi(`/api/network/venues/${b.id}/select`, { method: 'POST' });
    const floorB = await window.__crmApi('/api/floor');
    let stale = '';
    try { await window.__crmApi('/api/floor/zones', { method: 'POST', body: JSON.stringify({ expectedVenueId: a.venueId, name: 'Wrong Static B Zone' }) }); } catch (error) { stale = error.payload?.error || error.message; }
    const bZone = await window.__crmApi('/api/floor/zones', { method: 'POST', body: JSON.stringify({ expectedVenueId: b.id, name: 'Static B Zone' }) });
    await window.__crmApi(`/api/network/venues/${a.venueId}/select`, { method: 'POST' });
    const floorA = await window.__crmApi('/api/floor');
    return { a: a.venueId, b: b.id, aZone: aZone.id, bZone: bZone.id, floorA, floorB, stale };
  });
  assert.equal(staticResult.floorB.venueId, staticResult.b);
  assert.equal(staticResult.floorB.zones.some((zone) => zone.id === staticResult.aZone), false);
  assert.equal(staticResult.stale, 'venue_context_changed');
  assert.equal(staticResult.floorA.zones.some((zone) => zone.id === staticResult.aZone), true);
  assert.equal(staticResult.floorA.zones.some((zone) => zone.id === staticResult.bZone), false);
  console.log('PASS admin floor editor and POS dynamic zones, retry, venue isolation, four widths and light theme');
} finally {
  await browser?.close();
  child.kill();
}
