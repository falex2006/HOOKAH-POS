import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { validateQaDatabaseUrl, assertQaDatabaseIdentity } from './postgres-qa-safety.mjs';

const databaseUrl = process.env.MIGRATIONS_PG_TEST_DATABASE_URL;
const target = validateQaDatabaseUrl(databaseUrl, 'MIGRATIONS_PG_TEST_DATABASE_URL');
const playwrightPath = process.env.PLAYWRIGHT_PACKAGE_PATH;
if (!playwrightPath) throw new Error('Set PLAYWRIGHT_PACKAGE_PATH');
const require = createRequire(import.meta.url);
const { Client } = require('pg');
const { chromium } = require(playwrightPath);
const db = new Client({ connectionString: databaseUrl });
const ids = { organization: randomUUID(), venue: randomUUID(), otherVenue: randomUUID(), tenantOrder: randomUUID(), bartender: randomUUID(), hookah: randomUUID(), manager: randomUUID(), admin: randomUUID(), owner: randomUUID(), otherVenueBartender: randomUUID(), shiftRaceOrder: randomUUID(), foreignShift: randomUUID(), zone: randomUUID(), table: randomUUID(), freeTable: randomUUID(), blockedTable: randomUUID(), reservedTable: randomUUID(), farTable: randomUUID(), edgeLeft: randomUUID(), edgeRight: randomUUID(), edgeTop: randomUUID(), edgeBottom: randomUUID(), product: randomUUID(), fractionalProduct: randomUUID(), stockProduct: randomUUID(), tobaccoProduct: randomUUID(), htmlProduct: randomUUID(), order: randomUUID(), failedSnapshotOrder: randomUUID(), htmlOrder: randomUUID(), splitOrder: randomUUID(), raceOrder: randomUUID(), snapshotOrder: randomUUID(), replayOrder: randomUUID(), directCloseOrder: randomUUID(), concurrentSnapshotOrder: randomUUID(), integrityOrder: randomUUID(), moveTargetOrder: randomUUID(), legacySnapshotOrder: randomUUID(), fractionalOrder: randomUUID(), fractionalItemA: randomUUID(), fractionalItemB: randomUUID(), fractionalPromotion: randomUUID(), stockIngredient: randomUUID(), tobaccoIngredient: randomUUID(), stockMovement: randomUUID(), purchaseDocument: randomUUID(), splitItemA: randomUUID(), splitItemB: randomUUID(), guest: randomUUID(), htmlGuest: randomUUID() };
const screenshotDir = fileURLToPath(new URL('../qa-artifacts/pos-stage55/', import.meta.url));
const qaPassword = `qa-${randomUUID()}`;
const salt = randomBytes(16).toString('hex');
const passwordHash = `scrypt$${salt}$${scryptSync(qaPassword, salt, 64).toString('hex')}`;
const bartenderLogin = `pos-bartender-${ids.venue}`;
const managerLogin = `pos-manager-${ids.venue}`;
const adminLogin = `pos-admin-${ids.venue}`;
const hookahLogin = `pos-hookah-${ids.venue}`;
const ownerLogin = `pos-owner-${ids.venue}`;
const otherVenueBartenderLogin = `pos-bartender-${ids.otherVenue}`;
let browser, server, serverExit, connected = false, fixtureCreated = false, passed = false, serverOutput = "";

const login = async (page, base, username) => {
  await page.goto(`${base}/login`, { waitUntil: 'networkidle' });
  await page.locator('#login-username').fill(username);
  await page.locator('#login-password').fill(qaPassword);
  await page.locator('#login-form button[type="submit"]').click();
  await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 8000 }).catch(async (error) => { const response = await browserPost(page, '/api/login', { username, password: qaPassword }); throw new Error('QA login did not navigate for ' + username + ': ' + JSON.stringify(response) + '; ' + error.message + '; server output: ' + serverOutput.slice(-4000)); });
};
const browserApi = (page, route) => page.evaluate(async (path) => {
  const token = localStorage.getItem('crm_session_token');
  const response = await fetch(path, { headers: { Authorization: `Bearer ${token}` } });
  return { status: response.status, body: await response.json() };
}, route);
const browserPost = (page, route, payload) => page.evaluate(async ({ path, data }) => {
  const token = localStorage.getItem('crm_session_token');
  const response = await fetch(path, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  return { status: response.status, body: await response.json() };
}, { path: route, data: payload });
const browserPatch = (page, route, payload) => page.evaluate(async ({ path, data }) => {
  const token = localStorage.getItem('crm_session_token');
  const response = await fetch(path, { method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  return { status: response.status, body: await response.json() };
}, { path: route, data: payload });
const browserRequest = (page, route, method, payload) => page.evaluate(async ({ path, method: requestMethod, data }) => {
  const token = localStorage.getItem('crm_session_token');
  const response = await fetch(path, { method: requestMethod, headers: { Authorization: `Bearer ${token}`, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  return { status: response.status, body: await response.json() };
}, { path: route, method, data: payload });
const waitForShiftLockWaiters = async (minimum) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    const count = Number((await db.query("SELECT count(*) AS count FROM pg_stat_activity WHERE datname=current_database() AND state='active' AND wait_event_type='Lock' AND query ILIKE '%FROM shifts%' ")).rows[0].count);
    if (count >= minimum) return count;
    await delay(40);
  }
  return 0;
};
const selectCustomOption = async (page, selectId, value) => {
  const wrapper = page.locator(`#${selectId}`).locator('xpath=..');
  await wrapper.locator('.custom-select-trigger').click();
  await wrapper.locator(`.custom-select-menu [data-value="${value}"]`).click();
};

try {
  await db.connect(); connected = true;
  assert.equal((await db.query("SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema=current_schema() AND table_name IN ('pos_order_pricing_snapshots','pos_order_pricing_snapshot_lines')")).rows[0].count,2,'fresh schema plus ordered migration 090 installs both canonical snapshot tables');
  const identity = (await db.query(`SELECT current_database() AS database, inet_server_addr()::text AS address, inet_server_port() AS port,
    (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser`)).rows[0];
  assertQaDatabaseIdentity(identity, target.database, Number(target.url.port || 5432), 'POS role payment browser QA database');
  await db.query('BEGIN');
  try {
    await db.query("INSERT INTO organizations (id,name,slug) VALUES ($1,'Isolated POS role payment QA',$2)", [ids.organization, `pos-role-${ids.organization}`]);
    await db.query("INSERT INTO organization_subscriptions (organization_id,status) VALUES ($1,'active')", [ids.organization]);
    await db.query("INSERT INTO venues (id,organization_id,name,timezone) VALUES ($1,$2,'Isolated POS role payment QA','Asia/Yekaterinburg')", [ids.venue, ids.organization]);
    await db.query("INSERT INTO venues (id,organization_id,name,timezone) VALUES ($1,$2,'Isolated POS other tenant QA','Asia/Yekaterinburg')", [ids.otherVenue, ids.organization]);
    await db.query("INSERT INTO users (id,organization_id,venue_id,full_name,login,password_hash,role) VALUES ($1,$5,$4,'QA Bartender',$7,$10,'bartender'),($2,$5,$4,'QA Manager',$8,$10,'manager'),($3,$5,$4,'QA Admin',$9,$10,'admin'),($6,$5,$4,'QA Hookah Master',$11,$10,'hookah_master'),($12,$5,$4,'QA Owner',$13,$10,'owner'),($14,$5,$15,'QA Other Venue Bartender',$16,$10,'bartender')", [ids.bartender, ids.manager, ids.admin, ids.venue, ids.organization, ids.hookah, bartenderLogin, managerLogin, adminLogin, passwordHash, hookahLogin, ids.owner, ownerLogin, ids.otherVenueBartender, ids.otherVenue, otherVenueBartenderLogin]);
    await db.query("INSERT INTO organization_memberships (organization_id,user_id,membership_role,status) VALUES ($1,$2,'member','active'),($1,$3,'member','active'),($1,$4,'member','active'),($1,$5,'member','active'),($1,$6,'owner','active'),($1,$7,'member','active')", [ids.organization, ids.bartender, ids.manager, ids.admin, ids.hookah, ids.owner, ids.otherVenueBartender]);
    await db.query("INSERT INTO shifts (id,venue_id,opened_by,opening_cash) VALUES ($1,$2,$3,0)", [ids.foreignShift, ids.otherVenue, ids.otherVenueBartender]);
    await db.query("INSERT INTO zones (id,venue_id,name) VALUES ($1,$2,'QA расчётный зал')", [ids.zone, ids.venue]);
    await db.query("INSERT INTO tables (id,zone_id,name,status,layout) VALUES ($1,$5,'QA стол оплаты','occupied',$6::jsonb),($2,$5,'QA & свободный','free',$7::jsonb),($3,$5,'QA закрытый','blocked',$8::jsonb),($4,$5,'QA бронь','reserved',$9::jsonb)",
      [ids.table, ids.freeTable, ids.blockedTable, ids.reservedTable, ids.zone, JSON.stringify({ unit: 'px', x: 10, y: 10, width: 170, height: 95 }), JSON.stringify({ unit: 'px', x: 220, y: 10, width: 170, height: 95 }), JSON.stringify({ unit: 'px', x: 10, y: 150, width: 170, height: 95 }), JSON.stringify({ unit: 'px', x: 220, y: 150, width: 170, height: 95 })]);
    await db.query("INSERT INTO tables (id,zone_id,name,status,layout) VALUES ($1,$2,'QA дальний стол','free',$3::jsonb)", [ids.farTable, ids.zone, JSON.stringify({ unit: 'px', x: 800, y: 10, width: 170, height: 95 })]);
    await db.query("INSERT INTO tables (id,zone_id,name,status,layout) VALUES ($1,$5,'QA левый край','free',$6::jsonb),($2,$5,'QA правый край','free',$7::jsonb),($3,$5,'QA верхний край','free',$8::jsonb),($4,$5,'QA нижний край','free',$9::jsonb)", [ids.edgeLeft, ids.edgeRight, ids.edgeTop, ids.edgeBottom, ids.zone, JSON.stringify({ unit: 'px', x: 0, y: 320, width: 170, height: 95, rotation: 45 }), JSON.stringify({ unit: 'px', x: 800, y: 350, width: 170, height: 95, rotation: 45 }), JSON.stringify({ unit: 'px', x: 500, y: 0, width: 170, height: 95, rotation: 45 }), JSON.stringify({ unit: 'px', x: 400, y: 520, width: 170, height: 95, rotation: 45 })]);
    await db.query("INSERT INTO products (id,venue_id,name,category,sale_price,inventory_mode) VALUES ($1,$2,'QA услуга оплаты с длинным названием для проверки строки заказа','Услуги',500,'non_stock')", [ids.product, ids.venue]);
    await db.query("INSERT INTO products (id,venue_id,name,category,sale_price,inventory_mode) VALUES ($1,$2,'QA fractional snapshot item','Bar',0.01,'non_stock')", [ids.fractionalProduct, ids.venue]);
    await db.query("INSERT INTO ingredients (id,venue_id,name,category,unit,cost,department,purchase_unit,pack_multiplier) VALUES ($1,$3,'QA POS syrup','Сиропы','мл',0,'bar','л',1000),($2,$3,'QA hookah tobacco','Табак','г',0,'hookah','пачка',100)", [ids.stockIngredient, ids.tobaccoIngredient, ids.venue]);
    await db.query("UPDATE ingredients SET is_marked=true WHERE id=ANY($1::uuid[])", [[ids.stockIngredient, ids.tobaccoIngredient]]);
    await db.query("INSERT INTO product_categories (venue_id,name,department) VALUES ($1,'QA UI inventory category','bar')", [ids.venue]);
    await db.query("INSERT INTO products (id,venue_id,name,category,sale_price,inventory_mode) VALUES ($1,$3,'QA tracked syrup drink','Бар',250,'tracked'),($2,$3,'QA tracked hookah bowl','Кальян',500,'tracked')", [ids.stockProduct, ids.tobaccoProduct, ids.venue]);
    await db.query("INSERT INTO inventory_recipe_cards (venue_id,product_id,name,ingredients,yield_quantity,yield_unit,portion_count,recipe_type) VALUES ($1,$2,'QA syrup drink',$4::jsonb,1,'порция',1,'sale'),($1,$3,'QA hookah bowl',$5::jsonb,1,'порция',1,'sale')", [ids.venue, ids.stockProduct, ids.tobaccoProduct, JSON.stringify([{ ingredientId: ids.stockIngredient, name: 'QA POS syrup', quantity: '25 мл' }]), JSON.stringify([{ ingredientId: ids.tobaccoIngredient, name: 'QA hookah tobacco', quantity: '18 г' }])]);
    await db.query("INSERT INTO stock_movements (id,venue_id,ingredient_id,direction,quantity,reason,created_by) VALUES ($1,$3,$4,'in',1000,'QA opening syrup stock',$5),($2,$3,$6,'in',100,'QA opening tobacco stock',$5)", [ids.stockMovement, randomUUID(), ids.venue, ids.stockIngredient, ids.manager, ids.tobaccoIngredient]);
    await db.query("INSERT INTO guests (id,venue_id,full_name) VALUES ($1,$2,'QA <img src=x data-qa-unsafe>')", [ids.htmlGuest, ids.venue]);
    await db.query("INSERT INTO orders (id,venue_id,table_id,opened_by,status) VALUES ($1,$2,$3,$4,'open')", [ids.order, ids.venue, ids.table, ids.bartender]);
    await db.query("INSERT INTO orders (id,venue_id,opened_by,status) VALUES ($1,$2,$3,'cancelled')", [ids.moveTargetOrder, ids.venue, ids.bartender]);
    await db.query("INSERT INTO order_items (order_id,product_id,quantity,unit_price,station,sales_employee_id,sold_at) VALUES ($1,$2,1,500,'bar',$3,now())", [ids.order, ids.product, ids.bartender]);
    await db.query('COMMIT'); fixtureCreated = true;
  } catch (error) { await db.query('ROLLBACK'); throw error; }

  server = spawn(process.execPath, ['server.js'], { cwd: fileURLToPath(new URL('../', import.meta.url)), windowsHide: true,
    env: { ...process.env, DATABASE_URL: databaseUrl, VENUE_ID: ids.venue, AUTH_REQUIRED: 'true', COOKIE_SECURE: 'false', DEMO_MODE: 'false', NODE_ENV: 'test', HOST: '127.0.0.1', PORT: '0', API_RATE_LIMIT: '5000' }, stdio: ['ignore', 'pipe', 'pipe'] });
  serverExit = new Promise((resolve) => server.once('exit', resolve));
  let output = '';
  server.stdout.on('data', (chunk) => { output += chunk; serverOutput += chunk; });
  server.stderr.on('data', (chunk) => { output += chunk; serverOutput += chunk; });
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`POS role payment QA server did not start: ${output}`)), 20000);
    server.once('error', reject);
    server.stdout.on('data', () => { const match = output.match(/CRM running on http:\/\/localhost:(\d+)/); if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); } });
  });
  assert.equal((await (await fetch(`${base}/api/health`)).json()).database, 'postgres');
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  const bartender = await browser.newPage({ viewport: { width: 375, height: 812 }, locale: 'ru-RU' });
  const inventoryManager = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: 'ru-RU' });
  const managerRolePage = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: 'ru-RU' });
  const owner = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: 'ru-RU' });
  const otherVenueBartender = await browser.newPage({ viewport: { width: 375, height: 812 }, locale: 'ru-RU' });
  const hookah = await browser.newPage({ viewport: { width: 375, height: 812 }, locale: 'ru-RU' });
  const errors = [];
  for (const page of [bartender, inventoryManager, managerRolePage, owner, otherVenueBartender, hookah]) page.on('pageerror', (error) => { if (error.message !== 'Transition was aborted because of invalid state. ViewTransition opt-in disabled') errors.push(error.message); });
  await login(bartender, base, bartenderLogin);
  await bartender.goto(base, { waitUntil: 'networkidle' });
  await login(managerRolePage, base, managerLogin);
  await login(owner, base, ownerLogin);
  await login(otherVenueBartender, base, otherVenueBartenderLogin);
  await bartender.locator('#shift-toggle[data-shift-state="closed"]').waitFor();
  const beforeOpening = await browserApi(bartender, '/api/shifts');
  assert.equal(beforeOpening.status, 200);
  assert.equal(beforeOpening.body.current, null, 'the browser starts with no pre-seeded shift');
  assert.equal((await db.query('SELECT count(*)::int AS count FROM shifts WHERE venue_id=$1 AND closed_at IS NULL',[ids.venue])).rows[0].count,0,'venue A has no open shift');
  assert.equal((await db.query('SELECT count(*)::int AS count FROM shifts WHERE venue_id=$1 AND closed_at IS NULL',[ids.otherVenue])).rows[0].count,1,'venue B has an open shift that must not unlock venue A');
  const noShiftItemId = (await db.query('SELECT id FROM order_items WHERE order_id=$1 ORDER BY id LIMIT 1', [ids.order])).rows[0].id;
  const beforeNoShiftWrites = (await db.query(`SELECT
    (SELECT count(*) FROM orders WHERE venue_id=$1) AS orders,
    (SELECT count(*) FROM guests WHERE venue_id=$1) AS guests,
    (SELECT count(*) FROM audit_events WHERE venue_id=$1) AS audits,
    (SELECT count(*) FROM order_items WHERE order_id=$2) AS items,
    (SELECT count(*) FROM payments p JOIN orders o ON o.id=p.order_id WHERE o.venue_id=$1) AS payments,
    (SELECT COALESCE(jsonb_agg(jsonb_build_object('id',id,'quantity',quantity,'station',station) ORDER BY id),'[]'::jsonb) FROM order_items WHERE order_id=$2) AS item_snapshot,
    (SELECT COALESCE(jsonb_agg(jsonb_build_object('id',p.id,'amount',p.amount,'method',p.method,'status',p.status,'shiftId',p.shift_id) ORDER BY p.id),'[]'::jsonb) FROM payments p JOIN orders o ON o.id=p.order_id WHERE o.venue_id=$1) AS payment_snapshot,
    (SELECT notes FROM orders WHERE id=$2 AND venue_id=$1) AS order_notes,
    (SELECT status FROM orders WHERE id=$2 AND venue_id=$1) AS order_status,
    (SELECT guest_id FROM orders WHERE id=$2 AND venue_id=$1) AS order_guest_id,
    (SELECT status FROM tables WHERE id=$3) AS table_status`, [ids.venue, ids.order, ids.table])).rows[0];
  const noShiftCreateOrder = await browserPost(bartender, '/api/orders', { tableId: ids.freeTable });
  assert.equal(noShiftCreateOrder.status, 409);
  assert.equal(noShiftCreateOrder.body.error, 'active_shift_required', 'staff cannot create an order before opening a shift');
  const noShiftOrderEdit = await browserPatch(bartender, `/api/orders/${ids.order}`, { notes: 'must not persist without a shift' });
  assert.equal(noShiftOrderEdit.status, 409);
  assert.equal(noShiftOrderEdit.body.error, 'active_shift_required', 'staff cannot edit guest/order metadata before opening a shift');
  const guardedOrderMutations = [
    ['POST', '/api/orders', { tableId: ids.freeTable }, 'active_shift_required'],
    ['PATCH', `/api/orders/${ids.order}`, { guestName: 'must not persist without a shift', phone: '+79990000109', notes: 'must not persist without a shift' }, 'active_shift_required'],
    ['DELETE', `/api/orders/${ids.order}`, { comment: 'no-shift QA', writeoff: false }, 'active_shift_required'],
    ['POST', `/api/orders/${ids.order}/status`, { status: 'ready' }, 'active_shift_required'],
    ['POST', `/api/orders/${ids.order}/transfer`, { tableId: ids.freeTable }, 'active_shift_required'],
    ['POST', `/api/orders/${ids.order}/items`, { productId: ids.product, quantity: 1, station: 'bar' }, 'active_shift_required'],
    ['PATCH', `/api/orders/${ids.order}/items/${noShiftItemId}`, { quantity: 2 }, 'active_shift_required'],
    ['DELETE', `/api/orders/${ids.order}/items/${noShiftItemId}`, undefined, 'active_shift_required'],
    ['POST', `/api/orders/${ids.order}/close`, { paymentMethod: 'cash' }, 'active_shift_required'],
    ['POST', `/api/orders/${ids.order}/split`, { itemIds: [noShiftItemId] }, 'active_shift_required'],
    ['POST', `/api/orders/${ids.order}/discount-requests`, { type: 'percent', value: 10, reason: 'no-shift QA' }, 'active_shift_required'],
    ['POST', `/api/orders/${ids.order}/payments`, { method: 'cash', amount: 1 }, 'open_shift_required'],
  ];
  for (const [method, path, payload, expectedError] of guardedOrderMutations) {
    const response = await browserRequest(bartender, path, method, payload);
    assert.equal(response.status, 409, `${method} ${path} is blocked without an open shift: ${JSON.stringify(response.body)}`);
    assert.equal(response.body.error, expectedError, `${method} ${path} returns the documented shift-required code`);
  }
  for (const [method, path, payload, expectedError] of guardedOrderMutations) {
    const response = await browserRequest(managerRolePage, path, method, payload);
    assert.equal(response.status, 409, `manager ${method} ${path} is blocked without an own-venue shift: ${JSON.stringify(response.body)}`);
    assert.equal(response.body.error, expectedError, `manager ${method} ${path} returns the documented shift-required code`);
  }
  const ownerNoShiftProbes = [
    ['POST','/api/orders',{tableId:'missing-table'}],
    ['PATCH',`/api/orders/${ids.order}`,{clientId:randomUUID(),notes:'must roll back'}],
    ['DELETE',`/api/orders/${ids.order}`,{comment:'',writeoff:false}],
    ['POST',`/api/orders/${ids.order}/status`,{status:'unsupported'}],
    ['POST',`/api/orders/${ids.order}/transfer`,{tableId:'missing-table'}],
    ['POST',`/api/orders/${ids.order}/items`,{productId:randomUUID(),quantity:1}],
    ['PATCH',`/api/orders/${ids.order}/items/${randomUUID()}`,{quantity:2}],
    ['DELETE',`/api/orders/${ids.order}/items/${randomUUID()}`],
    ['POST',`/api/orders/${ids.order}/close`,{paymentMethod:'unsupported'}],
    ['POST',`/api/orders/${ids.order}/split`,{itemIds:[]}],
    ['POST',`/api/orders/${ids.order}/discount-requests`,{type:'unsupported',value:0,reason:''}],
    ['POST',`/api/orders/${ids.order}/payments`,{method:'unsupported',amount:0}],
  ];
  for (const [method,path,payload] of ownerNoShiftProbes) {
    const response = await browserRequest(owner,path,method,payload);
    assert.ok(response.status >= 400 && response.status < 500 && ![401,403].includes(response.status),`owner ${method} ${path} reaches an endpoint validation response without auth/permission/shift denial: ${JSON.stringify(response)}`);
    assert.notEqual(response.body.error,'active_shift_required',`owner ${method} ${path} is exempt from the operational shift gate: ${JSON.stringify(response.body)}`);
  }
  const afterNoShiftWrites = (await db.query(`SELECT
    (SELECT count(*) FROM orders WHERE venue_id=$1) AS orders,
    (SELECT count(*) FROM guests WHERE venue_id=$1) AS guests,
    (SELECT count(*) FROM audit_events WHERE venue_id=$1) AS audits,
    (SELECT count(*) FROM order_items WHERE order_id=$2) AS items,
    (SELECT count(*) FROM payments p JOIN orders o ON o.id=p.order_id WHERE o.venue_id=$1) AS payments,
    (SELECT COALESCE(jsonb_agg(jsonb_build_object('id',id,'quantity',quantity,'station',station) ORDER BY id),'[]'::jsonb) FROM order_items WHERE order_id=$2) AS item_snapshot,
    (SELECT COALESCE(jsonb_agg(jsonb_build_object('id',p.id,'amount',p.amount,'method',p.method,'status',p.status,'shiftId',p.shift_id) ORDER BY p.id),'[]'::jsonb) FROM payments p JOIN orders o ON o.id=p.order_id WHERE o.venue_id=$1) AS payment_snapshot,
    (SELECT notes FROM orders WHERE id=$2 AND venue_id=$1) AS order_notes,
    (SELECT status FROM orders WHERE id=$2 AND venue_id=$1) AS order_status,
    (SELECT guest_id FROM orders WHERE id=$2 AND venue_id=$1) AS order_guest_id,
    (SELECT status FROM tables WHERE id=$3) AS table_status`, [ids.venue, ids.order, ids.table])).rows[0];
  assert.equal(Number(afterNoShiftWrites.orders), Number(beforeNoShiftWrites.orders), 'blocked order creation has no database side effect');
  assert.equal(Number(afterNoShiftWrites.guests), Number(beforeNoShiftWrites.guests), 'blocked order edit does not create a guest');
  assert.equal(Number(afterNoShiftWrites.audits), Number(beforeNoShiftWrites.audits), 'blocked writes create no audit events');
  assert.equal(Number(afterNoShiftWrites.items), Number(beforeNoShiftWrites.items), 'blocked item writes leave order lines unchanged');
  assert.equal(Number(afterNoShiftWrites.payments), Number(beforeNoShiftWrites.payments), 'blocked payment creates no tender');
  assert.deepEqual(afterNoShiftWrites.item_snapshot, beforeNoShiftWrites.item_snapshot, 'blocked item writes preserve line identity, quantity, and station');
  assert.deepEqual(afterNoShiftWrites.payment_snapshot, beforeNoShiftWrites.payment_snapshot, 'blocked payment leaves all tenders unchanged');
  assert.equal(afterNoShiftWrites.order_notes, beforeNoShiftWrites.order_notes, 'blocked order edit leaves order metadata unchanged');
  assert.equal(afterNoShiftWrites.order_status, beforeNoShiftWrites.order_status, 'blocked status and close attempts leave the order open');
  assert.equal(afterNoShiftWrites.order_guest_id, beforeNoShiftWrites.order_guest_id, 'blocked metadata edits leave the guest link unchanged');
  assert.equal(afterNoShiftWrites.table_status, beforeNoShiftWrites.table_status, 'blocked order mutations leave table state unchanged');
  const ownerNoShiftEdit = await browserPatch(owner, `/api/orders/${ids.order}`, { notes: 'QA owner without shift' });
  assert.equal(ownerNoShiftEdit.status,200,'owner with orders permission keeps the established shift-gate exemption');
  assert.equal((await browserPatch(owner, `/api/orders/${ids.order}`, { notes: beforeNoShiftWrites.order_notes || '' })).status,200,'owner restores the no-shift matrix fixture');
  await bartender.locator('#shift-toggle').click();
  await bartender.locator('#staff-action-modal.open').waitFor();
  assert.match(await bartender.locator('#staff-action-description').innerText(), /стартовый остаток в кассе/i,
    'the real staff open dialog explains the opening cash amount');
  await bartender.locator('input[name="openingCash"]').fill('137.25');
  const shiftOpenResponse = bartender.waitForResponse((response) => response.request().method() === 'POST' && response.url().endsWith('/api/shifts'));
  await bartender.locator('#staff-action-submit').click();
  const shiftOpen = await shiftOpenResponse;
  assert.equal(shiftOpen.status(),201,`the staff dialog opens a shift through the real API: ${await shiftOpen.text()}`);
  const openedShift = await shiftOpen.json();
  ids.shift = openedShift.id;
  assert.equal(Number(openedShift.openingCash),137.25);
  await bartender.locator('#staff-notice').filter({ hasText: 'Смена открыта' }).waitFor();
  const persistedOpening = (await db.query('SELECT opened_by,opening_cash,closed_at FROM shifts WHERE id=$1 AND venue_id=$2',[ids.shift,ids.venue])).rows[0];
  assert.ok(persistedOpening, 'opening cash is persisted for the venue shift');
  assert.equal(persistedOpening.opened_by,ids.bartender, 'the opening is attributed to the signed-in staff member');
  assert.equal(Number(persistedOpening.opening_cash),137.25);
  assert.equal(persistedOpening.closed_at,null);
  const withShiftEdit = await browserPatch(bartender, `/api/orders/${ids.order}`, { notes: 'QA edit with an active shift' });
  assert.equal(withShiftEdit.status,200,'the same staff metadata edit is allowed during an active shift');
  assert.equal((await db.query('SELECT notes FROM orders WHERE id=$1',[ids.order])).rows[0].notes,'QA edit with an active shift');
  const restoreOrderNotes = await browserPatch(bartender, `/api/orders/${ids.order}`, { notes: beforeNoShiftWrites.order_notes || '' });
  assert.equal(restoreOrderNotes.status,200,'the active-shift fixture restores its original order notes');
  const managerWithShiftEdit = await browserPatch(managerRolePage, `/api/orders/${ids.order}`, { notes: 'QA manager edit with venue shift' });
  assert.equal(managerWithShiftEdit.status,200,'manager can edit order metadata with a same-venue open shift');
  assert.equal((await browserPatch(managerRolePage, `/api/orders/${ids.order}`, { notes: beforeNoShiftWrites.order_notes || '' })).status,200,'manager restores the same-venue positive-control fixture');
  assert.equal((await browserPatch(owner, `/api/orders/${ids.order}`, { notes: 'QA owner with venue shift' })).status,200,'owner edit remains available with a same-venue open shift');
  assert.equal((await browserPatch(owner, `/api/orders/${ids.order}`, { notes: beforeNoShiftWrites.order_notes || '' })).status,200,'owner restores the same-venue positive-control fixture');
  await db.query("INSERT INTO orders(id,venue_id,opened_by,status) VALUES($1,$2,$3,'open')",[ids.shiftRaceOrder,ids.otherVenue,ids.otherVenueBartender]);
  const gateDb = new Client({ connectionString: databaseUrl });
  await gateDb.connect();
  try {
    await gateDb.query('BEGIN');
    await gateDb.query('SELECT id FROM shifts WHERE id=$1 AND venue_id=$2 FOR UPDATE',[ids.foreignShift,ids.otherVenue]);
    const closeFirst = browserPost(otherVenueBartender,`/api/shifts/${ids.foreignShift}/close`,{ checklist:{version:1,items:{ordersReviewed:true,cashCounted:true,inventoryReviewed:true,externalFiscalReportsHandled:true}}, closingCash:0 });
    assert.ok(await waitForShiftLockWaiters(1),'shift-close API waits on the held PostgreSQL shift row');
    const editAfterClose = browserPatch(otherVenueBartender,`/api/orders/${ids.shiftRaceOrder}`,{ guestName:'Must roll back', phone:'+79990000111', notes:'must not commit after close' });
    assert.ok(await waitForShiftLockWaiters(2),'PATCH and close are both queued on the same shift serialization row');
    await gateDb.query('COMMIT');
    const [closedFirstResponse, rejectedEdit] = await Promise.all([closeFirst,editAfterClose]);
    assert.equal(closedFirstResponse.status,200,`closeShift wins the queued race: ${JSON.stringify(closedFirstResponse.body)}`);
    assert.deepEqual([rejectedEdit.status,rejectedEdit.body.error],[409,'active_shift_required'],'PATCH queued behind closeShift observes the closed shift and rejects');
    const afterRejectedRace = (await db.query(`SELECT o.notes,o.guest_id,
      (SELECT count(*) FROM guests WHERE venue_id=$2 AND phone='+79990000111') AS guest_count,
      (SELECT count(*) FROM audit_events WHERE entity_id=$1) AS audit_count,
      (SELECT closed_at FROM shifts WHERE id=$3 AND venue_id=$2) AS shift_closed_at
      FROM orders o WHERE o.id=$1 AND o.venue_id=$2`,[ids.shiftRaceOrder,ids.otherVenue,ids.foreignShift])).rows[0];
    assert.deepEqual([afterRejectedRace.notes,afterRejectedRace.guest_id,Number(afterRejectedRace.guest_count),Number(afterRejectedRace.audit_count)],[null,null,0,0],'a PATCH rejected after shift close leaves order, guest table and audit untouched');
    assert.ok(afterRejectedRace.shift_closed_at,'the close-first race persisted the shift close before the rejected edit completed');
  } finally { await gateDb.query('ROLLBACK').catch(()=>{}); await gateDb.end(); }
  const reopenedForeign = await browserPost(otherVenueBartender,'/api/shifts',{ openingCash:0 });
  assert.equal(reopenedForeign.status,201,'venue B opens a fresh shift for the edit-first race');
  const gateEditDb = new Client({ connectionString: databaseUrl });
  await gateEditDb.connect();
  try {
    await gateEditDb.query('BEGIN');
    await gateEditDb.query('SELECT id FROM shifts WHERE id=$1 AND venue_id=$2 FOR UPDATE',[reopenedForeign.body.id,ids.otherVenue]);
    const editFirst = browserPatch(otherVenueBartender,`/api/orders/${ids.shiftRaceOrder}`,{ guestName:'Serialized before close', phone:'+79990000112', notes:'committed before close' });
    assert.ok(await waitForShiftLockWaiters(1),'edit-first PATCH waits on the held PostgreSQL shift row');
    const closeAfterEdit = browserPost(otherVenueBartender,`/api/shifts/${reopenedForeign.body.id}/close`,{ checklist:{version:1,items:{ordersReviewed:true,cashCounted:true,inventoryReviewed:true,externalFiscalReportsHandled:true}}, closingCash:0 });
    assert.ok(await waitForShiftLockWaiters(2),'closeShift queues behind the edit-first PATCH on the same shift row');
    await gateEditDb.query('COMMIT');
    const [editedFirstResponse, closedAfterEdit] = await Promise.all([editFirst,closeAfterEdit]);
    assert.equal(editedFirstResponse.status,200,`PATCH commits before shift close: ${JSON.stringify(editedFirstResponse.body)}`);
    assert.equal(closedAfterEdit.status,200,`closeShift commits after PATCH: ${JSON.stringify(closedAfterEdit.body)}`);
    const serialized = (await db.query(`SELECT o.notes,o.guest_id,s.closed_at,
      (SELECT count(*) FROM guests WHERE venue_id=$2 AND phone='+79990000112') AS guest_count
      FROM orders o JOIN shifts s ON s.venue_id=o.venue_id AND s.id=$3 WHERE o.id=$1 AND o.venue_id=$2`,[ids.shiftRaceOrder,ids.otherVenue,reopenedForeign.body.id])).rows[0];
    assert.deepEqual([serialized.notes,serialized.guest_id,Number(serialized.guest_count)],["committed before close",editedFirstResponse.body.guestId,1],'edit-first race commits its complete guest association before closeShift');
    assert.ok(serialized.closed_at,'the edit-first shift is closed after the serialized PATCH');
  } finally { await gateEditDb.query('ROLLBACK').catch(()=>{}); await gateEditDb.end(); }
  await bartender.locator('#shift-toggle[data-shift-state="open"]').waitFor();
  const openingShiftPreview = await browserApi(bartender, '/api/shifts');
  assert.equal(openingShiftPreview.status, 200);
  assert.equal(Number(openingShiftPreview.body.current.expectedCash), 137.25, 'the current shift preview reads back the persisted opening float');
  await bartender.locator('#shift-toggle').click();
  await bartender.locator('#staff-action-modal.open').waitFor();
  assert.match(await bartender.locator('#staff-action-description').innerText(), /Ожидаемая наличность по данным системы: 137,25 ₽/,
    'the real staff close dialog shows expected cash before collecting the actual amount');
  await bartender.locator('#staff-action-cancel').click();
  await login(inventoryManager, base, adminLogin);
  await inventoryManager.goto(`${base}/inventory?view=movements`, { waitUntil: 'networkidle' });
  await inventoryManager.locator('[data-inventory-header-action="receipt"]').click();
  await inventoryManager.locator('#purchase-document-dialog[open] #purchase-document-form').waitFor();
  await inventoryManager.locator('#purchase-supplier').fill('QA UI supplier');
  await inventoryManager.locator('#purchase-number').fill(`QA-${ids.purchaseDocument.slice(0, 8)}`);
  const purchaseLine = inventoryManager.locator('.purchase-line').first();
  await purchaseLine.locator('[data-purchase-field="ingredientId"]').selectOption(ids.stockIngredient);
  await purchaseLine.locator('[data-purchase-field="quantity"]').fill('0.5');
  await purchaseLine.locator('[data-purchase-field="unit"]').fill('л');
  await purchaseLine.locator('[data-purchase-field="unitCost"]').fill('40');
  const stockBeforeReceipt = Number((await db.query("SELECT COALESCE(SUM(CASE WHEN direction IN ('in','transfer','adjustment') THEN quantity ELSE -quantity END),0)::numeric AS balance FROM stock_movements WHERE venue_id=$1 AND ingredient_id=$2", [ids.venue, ids.stockIngredient])).rows[0].balance);
  const saveDraft = inventoryManager.waitForResponse((response) => response.request().method() === 'POST' && response.url().endsWith('/api/inventory/purchase-documents'));
  await inventoryManager.locator('#purchase-save').click();
  assert.equal((await saveDraft).status(), 201, 'manager UI saves purchase document draft');
  assert.equal(Number((await db.query("SELECT COALESCE(SUM(CASE WHEN direction IN ('in','transfer','adjustment') THEN quantity ELSE -quantity END),0)::numeric AS balance FROM stock_movements WHERE venue_id=$1 AND ingredient_id=$2", [ids.venue, ids.stockIngredient])).rows[0].balance), stockBeforeReceipt, 'purchase draft does not change stock');
  const documentId = await inventoryManager.locator('[data-purchase-post]').first().getAttribute('data-purchase-post');
  assert.ok(documentId, 'saved draft appears in purchase document list');
  inventoryManager.once('dialog', (dialog) => dialog.accept());
  const postReceipt = inventoryManager.waitForResponse((response) => response.request().method() === 'POST' && response.url().endsWith(`/api/inventory/purchase-documents/${documentId}/post`));
  await inventoryManager.locator(`[data-purchase-post="${documentId}"]`).click();
  assert.equal((await postReceipt).status(), 200, 'manager UI posts receipt through warehouse API');
  const postedBalance = Number((await db.query("SELECT COALESCE(SUM(CASE WHEN direction IN ('in','transfer','adjustment') THEN quantity ELSE -quantity END),0)::numeric AS balance FROM stock_movements WHERE venue_id=$1 AND ingredient_id=$2", [ids.venue, ids.stockIngredient])).rows[0].balance);
  assert.equal(postedBalance, stockBeforeReceipt + 500, '500 ml receipt adds exact converted stock quantity');
  const postReplay = await browserPost(inventoryManager, `/api/inventory/purchase-documents/${documentId}/post`, {});
  assert.equal(postReplay.status, 409, 'reposting a posted receipt is rejected');
  assert.equal(Number((await db.query("SELECT count(*) FROM stock_movements WHERE venue_id=$1 AND ingredient_id=$2 AND direction='in'", [ids.venue, ids.stockIngredient])).rows[0].count), 2, 'receipt replay creates no duplicate ledger movement');
  await inventoryManager.locator('[data-inventory-header-action="adjustment"]').click();
  await inventoryManager.locator('#inventory-movement-dialog[open] #movement-item').waitFor();
  await inventoryManager.locator('#movement-item').selectOption(ids.stockIngredient);
  await inventoryManager.locator('#movement-direction').selectOption('out');
  await inventoryManager.locator('#movement-delta').fill('50');
  await inventoryManager.locator('#movement-unit').selectOption('мл');
  await inventoryManager.locator('#movement-reason').fill('QA UI ручное списание');
  const manualOut = inventoryManager.waitForResponse((response) => response.request().method() === 'POST' && response.url().endsWith('/api/inventory/movements'));
  await inventoryManager.locator('#movement-form button[type="submit"]').click();
  assert.equal((await manualOut).status(), 201, 'manager UI saves a manual warehouse write-off');
  await inventoryManager.locator('#inventory-movement-dialog[open]').waitFor({ state: 'hidden' });
  const manualOutBalance = Number((await db.query("SELECT COALESCE(SUM(CASE WHEN direction IN ('in','transfer','adjustment') THEN quantity ELSE -quantity END),0)::numeric AS balance FROM stock_movements WHERE venue_id=$1 AND ingredient_id=$2", [ids.venue, ids.stockIngredient])).rows[0].balance);
  assert.equal(manualOutBalance, postedBalance - 50, 'manual UI write-off stores exact 50 ml debit');
  await inventoryManager.locator('[data-inventory-header-action="adjustment"]').click();
  await inventoryManager.locator('#inventory-movement-dialog[open] #movement-item').waitFor();
  await inventoryManager.locator('#movement-item').selectOption(ids.stockIngredient);
  await inventoryManager.locator('#movement-direction').selectOption('out');
  await inventoryManager.locator('#movement-delta').fill('2000');
  await inventoryManager.locator('#movement-unit').selectOption('мл');
  await inventoryManager.locator('#movement-reason').fill('QA UI расход сверх остатка');
  const rejectedManualOut = inventoryManager.waitForResponse((response) => response.request().method() === 'POST' && response.url().endsWith('/api/inventory/movements'));
  await inventoryManager.locator('#movement-form button[type="submit"]').click();
  assert.equal((await rejectedManualOut).status(), 409, 'manual UI write-off above stock is rejected');
  await inventoryManager.locator('#movement-message').getByText('Недостаточно остатка для расхода').waitFor();
  assert.equal(Number((await db.query("SELECT COALESCE(SUM(CASE WHEN direction IN ('in','transfer','adjustment') THEN quantity ELSE -quantity END),0)::numeric AS balance FROM stock_movements WHERE venue_id=$1 AND ingredient_id=$2", [ids.venue, ids.stockIngredient])).rows[0].balance), manualOutBalance, 'rejected UI write-off creates no stock movement');
  await inventoryManager.goto(`${base}/inventory?view=stock`, { waitUntil: 'networkidle' });
  const stockRow = inventoryManager.locator('#inventory-rows tr').filter({ hasText: 'QA POS syrup' });
  await stockRow.waitFor();
  assert.match(await stockRow.innerText(), /1450\s*мл/, 'stock UI shows the 1,450 ml balance after receipt and manual write-off');
  const uiRecipeProduct = await browserPost(inventoryManager, '/api/products', { name: 'QA UI recipe product', category: 'Бар', price: 100, inventoryMode: 'tracked' });
  assert.equal(uiRecipeProduct.status, 201, 'recipe UI fixture product is created through the product API');
  await inventoryManager.goto(`${base}/inventory?view=recipes`, { waitUntil: 'networkidle' });
  await inventoryManager.locator('#new-recipe').click();
  await inventoryManager.locator('#recipe-form').waitFor({ state: 'visible' });
  await inventoryManager.locator('#recipe-name').fill(`QA UI recipe ${ids.venue.slice(0, 8)}`);
  await inventoryManager.locator('#recipe-category').fill('Бар');
  await inventoryManager.locator('#recipe-product').selectOption(uiRecipeProduct.body.id);
  await inventoryManager.locator('#recipe-yield-quantity').fill('1');
  await inventoryManager.locator('#recipe-yield-unit').selectOption('порция');
  await inventoryManager.locator('#recipe-portion-count').fill('1');
  await inventoryManager.locator('#recipe-wizard-next').click();
  await inventoryManager.locator(`#recipe-ingredient-select option[value="${ids.stockIngredient}"]`).waitFor({ state: 'attached' });
  await selectCustomOption(inventoryManager, 'recipe-ingredient-select', ids.stockIngredient);
  await inventoryManager.locator('#recipe-ingredient-quantity').fill('25 мл');
  await inventoryManager.locator('#recipe-add-ingredient').click();
  await selectCustomOption(inventoryManager, 'recipe-ingredient-select', ids.tobaccoIngredient);
  await inventoryManager.locator('#recipe-ingredient-quantity').fill('18 г');
  await inventoryManager.locator('#recipe-add-ingredient').click();
  await inventoryManager.locator('#recipe-wizard-next').click();
  await inventoryManager.locator('#recipe-wizard-next').click();
  const recipeCreateResponse = inventoryManager.waitForResponse((response) => response.request().method() === 'POST' && response.url().endsWith('/api/recipes'));
  await inventoryManager.locator('#recipe-form button[type="submit"]').click();
  const recipeCreate = await recipeCreateResponse;
  assert.equal(recipeCreate.status(), 201, 'recipe wizard creates a card through the API');
  const createdRecipe = await recipeCreate.json();
  const persistedRecipe = await db.query('SELECT id,product_id,ingredients FROM inventory_recipe_cards WHERE venue_id=$1 AND id=$2', [ids.venue, createdRecipe.id]);
  assert.equal(persistedRecipe.rowCount, 1, 'UI-created recipe is persisted');
  assert.equal(persistedRecipe.rows[0].product_id, uiRecipeProduct.body.id, 'UI recipe remains bound to its product');
  assert.equal(persistedRecipe.rows[0].ingredients.length, 2, 'UI recipe persists two linked ingredient lines');
  assert.equal(persistedRecipe.rows[0].ingredients.find((line) => line.ingredientId === ids.stockIngredient)?.quantity, '25 мл', 'UI recipe persists the syrup link and quantity');
  assert.equal(persistedRecipe.rows[0].ingredients.find((line) => line.ingredientId === ids.tobaccoIngredient)?.quantity, '18 г', 'UI recipe persists the tobacco link and quantity');
  await inventoryManager.locator(`[data-recipe-edit="${createdRecipe.id}"]`).click();
  await inventoryManager.locator('#recipe-form').waitFor({ state: 'visible' });
  await inventoryManager.locator('#recipe-wizard-next').click();
  await inventoryManager.locator('#recipe-linked-ingredients').waitFor({ state: 'visible' });
  const linkedIngredients = inventoryManager.locator('#recipe-linked-ingredients');
  await linkedIngredients.getByText(/QA POS syrup/i).waitFor();
  assert.equal(await linkedIngredients.locator('[data-recipe-remove]').count(), 2, 'recipe edit wizard restores both linked ingredients into its visible picker');
  await linkedIngredients.locator('[data-recipe-remove="0"]').click();
  assert.equal(await linkedIngredients.locator('[data-recipe-remove]').count(), 1, 'recipe edit removes the selected ingredient through the UI');
  await selectCustomOption(inventoryManager, 'recipe-ingredient-select', ids.stockIngredient);
  await inventoryManager.locator('#recipe-ingredient-quantity').fill('20 мл');
  await inventoryManager.locator('#recipe-add-ingredient').click();
  assert.equal(await linkedIngredients.locator('[data-recipe-remove]').count(), 2, 'recipe edit adds the replacement ingredient through the UI');
  await inventoryManager.locator('#recipe-wizard-next').click();
  await inventoryManager.locator('#recipe-wizard-next').click();
  const recipeEditResponse = inventoryManager.waitForResponse((response) => response.request().method() === 'PATCH' && response.url().endsWith(`/api/recipes/${createdRecipe.id}`));
  await inventoryManager.locator('#recipe-form button[type="submit"]').click();
  assert.equal((await recipeEditResponse).status(), 200, 'recipe wizard edits an existing card');
  await inventoryManager.reload({ waitUntil: 'networkidle' });
  const savedRecipeCard = inventoryManager.locator(`[data-recipe-card="${createdRecipe.id}"]`);
  await savedRecipeCard.waitFor();
  const savedRecipeText = await savedRecipeCard.textContent();
  assert.match(savedRecipeText, /20 мл/, 'edited recipe card shows the syrup quantity');
  assert.match(savedRecipeText, /18 г/, 'edited recipe card shows the tobacco quantity');
  const editedRecipe = (await db.query('SELECT ingredients FROM inventory_recipe_cards WHERE venue_id=$1 AND id=$2', [ids.venue, createdRecipe.id])).rows[0];
  assert.equal(editedRecipe.ingredients.find((line) => line.ingredientId === ids.stockIngredient)?.quantity, '20 мл', 'edited syrup quantity persists after reload');
  assert.equal(editedRecipe.ingredients.find((line) => line.ingredientId === ids.tobaccoIngredient)?.quantity, '18 г', 'editing the syrup preserves the tobacco recipe line');
  const invalidRecipe = await browserPatch(inventoryManager, `/api/recipes/${createdRecipe.id}`, { ingredients: [{ ingredientId: randomUUID(), name: 'Missing', quantity: '1 мл' }] });
  assert.ok([400, 409].includes(invalidRecipe.status), 'invalid ingredient id is rejected by the server');
  const recipeAfterInvalidPatch = (await db.query('SELECT ingredients FROM inventory_recipe_cards WHERE venue_id=$1 AND id=$2', [ids.venue, createdRecipe.id])).rows[0].ingredients;
  assert.equal(recipeAfterInvalidPatch.find((line) => line.ingredientId === ids.stockIngredient)?.quantity, '20 мл', 'invalid replacement does not alter the persisted syrup line');
  assert.equal(recipeAfterInvalidPatch.find((line) => line.ingredientId === ids.tobaccoIngredient)?.quantity, '18 г', 'invalid replacement preserves the other persisted recipe line');
  await bartender.locator(`[data-zone-id="${ids.zone}"]`).evaluate((tab) => tab.click());
  await bartender.locator(`[data-table="${ids.freeTable}"]`).click();
  const orderCreate = await browserPost(bartender, '/api/orders', { tableId: ids.freeTable, minimumOrderTotal: 0 });
  assert.equal(orderCreate.status, 201, 'the bartender can open a floor order: ' + JSON.stringify(orderCreate.body));
  const attributionOrder = orderCreate.body;
  const attributedWrite = await browserPost(bartender, `/api/orders/${attributionOrder.id}/items`, { productId: ids.stockProduct, quantity: 1 });
  assert.equal(attributedWrite.status, 201, 'POS adds a separately attributed seeded-recipe item through the authenticated PostgreSQL route');
  const attributedItem = attributedWrite.body;
  assert.equal(attributedItem.salesEmployeeId, ids.bartender, 'the server attributes the item to the authenticated bartender');
  assert.equal(attributedItem.salesEmployeeName, 'QA Bartender');
  assert.ok(Number.isFinite(Date.parse(attributedItem.soldAt)), 'the server returns a persisted sale timestamp');
  await bartender.reload({ waitUntil: 'networkidle' });
  await bartender.locator(`[data-queue-order="${attributionOrder.id}"]`).evaluate((button) => button.click());
  const attributedRow = bartender.locator(`.order-item-row[data-item-id="${attributedItem.id}"]`);
  await attributedRow.waitFor();
  assert.match(await attributedRow.locator('.order-item-attribution').innerText(), /QA Bartender/);
  assert.equal(await attributedRow.evaluate((row) => getComputedStyle(row).display), 'flex', 'floor order row retains its responsive layout after adding attribution');
  assert.match(await bartender.locator(`.order-item-row[data-item-id="${attributedItem.id}"] .order-item-attribution`).innerText(), /QA Bartender/, 'reload shows the persisted item attribution');
  const plusResponse = bartender.waitForResponse((response) => response.request().method() === 'POST' && response.url().endsWith(`/api/orders/${attributionOrder.id}/items`));
  await attributedRow.locator('.qty-plus').click();
  const plusResponseResult = await plusResponse;
  assert.equal(plusResponseResult.status(), 201, 'POS UI +1 creates a separate attributed line through POST');
  const plusItem = await plusResponseResult.json();
  await bartender.locator(`.order-item-row[data-item-id="${plusItem.id}"]`).waitFor();
  assert.notEqual(plusItem.id, attributedItem.id, 'UI +1 returns a distinct order item id');
  assert.equal(plusItem.productId, ids.stockProduct, 'UI +1 repeats the same seeded product');
  assert.equal(plusItem.salesEmployeeId, ids.bartender, 'UI +1 uses the authenticated seller');
  assert.ok(Number.isFinite(Date.parse(plusItem.soldAt)), 'UI +1 returns a database sale timestamp');
  const recipeWrite = await browserPost(bartender, `/api/orders/${attributionOrder.id}/items`, { productId: uiRecipeProduct.body.id, quantity: 1 });
  assert.equal(recipeWrite.status, 201, 'POS adds the UI-created recipe product as a separate attributed line through POST');
  const uiRecipeLineItem = recipeWrite.body;
  assert.notEqual(uiRecipeLineItem.id, attributedItem.id, 'UI recipe product sale has a distinct order item id');
  assert.equal(uiRecipeLineItem.salesEmployeeId, ids.bartender, 'UI recipe product line uses the authenticated seller');
  assert.ok(Number.isFinite(Date.parse(uiRecipeLineItem.soldAt)), 'UI recipe product line has a database sale timestamp');
  const lineState = await db.query('SELECT id,product_id,quantity,sales_employee_id,sold_at FROM order_items WHERE order_id=$1 AND id=ANY($2::uuid[]) ORDER BY id', [attributionOrder.id, [attributedItem.id, plusItem.id, uiRecipeLineItem.id]]);
  const uiRecipeLine = lineState.rows.find((row) => row.id === uiRecipeLineItem.id);
  assert.equal(uiRecipeLine.product_id, uiRecipeProduct.body.id, 'sold line is bound to the UI-created recipe product');
  assert.equal(uiRecipeLine.sales_employee_id, ids.bartender, 'UI-created recipe product retains its POS seller');
  assert.ok(uiRecipeLine.sold_at, 'UI-created recipe product retains its POS sale timestamp');
  assert.equal(lineState.rowCount, 3, 'POS preserves original, UI +1 and UI-created recipe product sale lines in PostgreSQL');
  assert.deepEqual(lineState.rows.map((row) => Number(row.quantity)).sort((left, right) => left - right), [1, 1, 1]);
  assert.ok(lineState.rows.every((row) => row.sales_employee_id === ids.bartender && row.sold_at), 'all persisted lines retain seller and timestamp');
  await bartender.reload({ waitUntil: 'networkidle' });
  await bartender.locator(`[data-queue-order="${attributionOrder.id}"]`).evaluate((button) => button.click());
  await bartender.locator(`.order-item-row[data-item-id="${uiRecipeLineItem.id}"]`).waitFor();
  await bartender.locator('#catalog').waitFor({ state: 'hidden' });
  const bartenderClose = bartender.waitForResponse((response) => response.request().method() === 'POST' && /\/api\/orders\/[0-9a-f-]+\/close$/.test(response.url()));
  await bartender.locator('.close:not([disabled])').click();
  await bartender.locator('#staff-action-submit').click();
  const bartenderCloseResponse=await bartenderClose;
  assert.equal(bartenderCloseResponse.status(), 200, `bartender POS closes the tracked sale through the warehouse-aware endpoint: ${await bartenderCloseResponse.text()}`);
  const bartenderDebit = await db.query("SELECT order_id FROM stock_movements WHERE venue_id=$1 AND ingredient_id=$2 AND direction='out' ORDER BY created_at DESC LIMIT 1", [ids.venue, ids.stockIngredient]);
  assert.equal(bartenderDebit.rowCount, 1, 'bartender POS close exposes the latest syrup recipe debit');
  const bartenderOrderId = bartenderDebit.rows[0].order_id;
  const bartenderBalance = Number((await db.query("SELECT COALESCE(SUM(CASE WHEN direction IN ('in','transfer','adjustment') THEN quantity ELSE -quantity END),0)::numeric AS balance FROM stock_movements WHERE venue_id=$1 AND ingredient_id=$2", [ids.venue, ids.stockIngredient])).rows[0].balance);
  assert.equal(bartenderBalance, manualOutBalance - 70, 'two seeded 25 ml recipe lines from the original and UI +1 sales plus the UI-edited 20 ml recipe all deplete on sale');
  const bartenderLinkedDebit = (await db.query("SELECT count(*)::int AS count,COALESCE(SUM(quantity),0)::numeric AS quantity FROM stock_movements WHERE venue_id=$1 AND ingredient_id=$2 AND direction='out' AND order_id=$3", [ids.venue, ids.stockIngredient, bartenderOrderId])).rows[0];
  assert.equal(bartenderLinkedDebit.count, 1, 'warehouse aggregates linked syrup depletion per order');
  assert.equal(Number(bartenderLinkedDebit.quantity), 70, 'aggregated syrup depletion preserves all three sold recipe lines');
  const bartenderDebits = await db.query("SELECT count(*)::int AS count FROM stock_movements WHERE venue_id=$1 AND ingredient_id=$2 AND direction='out' AND order_id=$3", [ids.venue, ids.stockIngredient, bartenderOrderId]);
  assert.equal(bartenderDebits.rows[0].count, 1, 'bartender sale writes one stock debit linked to its order');
  const bartenderTobaccoBalance = Number((await db.query("SELECT COALESCE(SUM(CASE WHEN direction IN ('in','transfer','adjustment') THEN quantity ELSE -quantity END),0)::numeric AS balance FROM stock_movements WHERE venue_id=$1 AND ingredient_id=$2", [ids.venue, ids.tobaccoIngredient])).rows[0].balance);
  assert.equal(bartenderTobaccoBalance, 82, 'UI-created bar recipe also consumes its linked 18 g tobacco line on sale');
  const bartenderTobaccoDebit = (await db.query("SELECT count(*)::int AS count,COALESCE(SUM(quantity),0)::numeric AS quantity FROM stock_movements WHERE venue_id=$1 AND ingredient_id=$2 AND direction='out' AND order_id=$3", [ids.venue, ids.tobaccoIngredient, bartenderOrderId])).rows[0];
  assert.equal(bartenderTobaccoDebit.count, 1, 'UI-created sale writes one tobacco debit linked to its order');
  assert.equal(Number(bartenderTobaccoDebit.quantity), 18, 'the UI-created recipe tobacco debit is linked to its sale order');
  await bartender.reload({ waitUntil: 'networkidle' });
  assert.equal(Number((await db.query("SELECT COALESCE(SUM(CASE WHEN direction IN ('in','transfer','adjustment') THEN quantity ELSE -quantity END),0)::numeric AS balance FROM stock_movements WHERE venue_id=$1 AND ingredient_id=$2", [ids.venue, ids.stockIngredient])).rows[0].balance), bartenderBalance, 'reload does not repeat the sale debit');
  await login(hookah, base, hookahLogin);
  assert.equal((await browserApi(hookah, '/api/inventory')).status, 403, 'hookah master cannot read inventory');
  assert.equal((await browserPost(hookah, '/api/inventory/purchase-documents', { supplierName: 'Forbidden', lines: [] })).status, 403, 'hookah master cannot create warehouse receipts');
  await hookah.goto(base, { waitUntil: 'networkidle' });
  await hookah.locator(`[data-zone-id="${ids.zone}"]`).click();
  await hookah.locator(`[data-table="${ids.freeTable}"]`).click();
  await hookah.locator('.order > .primary').click();
  await hookah.locator(`[data-name="QA tracked hookah bowl"]`).click();
  await hookah.locator('#catalog').waitFor({ state: 'hidden' });
  const hookahClose = hookah.waitForResponse((response) => response.request().method() === 'POST' && /\/api\/orders\/[0-9a-f-]+\/close$/.test(response.url()));
  await hookah.locator('.close:not([disabled])').click();
  await hookah.locator('#staff-action-submit').click();
  assert.equal((await hookahClose).status(), 200, 'hookah master POS closes the tracked sale through the warehouse-aware endpoint');
  const hookahDebit = await db.query("SELECT order_id FROM stock_movements WHERE venue_id=$1 AND ingredient_id=$2 AND direction='out' ORDER BY created_at DESC LIMIT 1", [ids.venue, ids.tobaccoIngredient]);
  assert.equal(hookahDebit.rowCount, 1, 'hookah POS close writes one tobacco recipe debit');
  const hookahOrderId = hookahDebit.rows[0].order_id;
  const hookahBalance = Number((await db.query("SELECT COALESCE(SUM(CASE WHEN direction IN ('in','transfer','adjustment') THEN quantity ELSE -quantity END),0)::numeric AS balance FROM stock_movements WHERE venue_id=$1 AND ingredient_id=$2", [ids.venue, ids.tobaccoIngredient])).rows[0].balance);
  assert.equal(hookahBalance, bartenderTobaccoBalance - 18, 'hookah master POS close consumes its 18 g bowl recipe after the UI-created recipe sale');
  assert.equal(hookahBalance, 64, 'UI-created recipe and hookah bowl each consume one exact 18 g tobacco line');
  assert.equal(Number((await db.query("SELECT count(*) FROM stock_movements WHERE venue_id=$1 AND ingredient_id=$2 AND direction='out' AND order_id=$3", [ids.venue, ids.tobaccoIngredient, hookahOrderId])).rows[0].count), 1, 'hookah sale writes one stock debit linked to its order');
  await hookah.reload({ waitUntil: 'networkidle' });
  assert.equal(Number((await db.query("SELECT COALESCE(SUM(CASE WHEN direction IN ('in','transfer','adjustment') THEN quantity ELSE -quantity END),0)::numeric AS balance FROM stock_movements WHERE venue_id=$1 AND ingredient_id=$2", [ids.venue, ids.tobaccoIngredient])).rows[0].balance), hookahBalance, 'hookah sale remains single after reload');
  const floorRead = await browserApi(bartender, '/api/floor');
  assert.equal(floorRead.status, 200, `bartender floor read: ${JSON.stringify(floorRead.body)}`);
  assert.ok(floorRead.body.zones.some((zone) => zone.id === ids.zone), 'bartender sees QA zone');
  await bartender.locator(`[data-zone-id="${ids.zone}"]`).evaluate((tab) => tab.click());
  await bartender.locator(`[data-table="${ids.table}"]`).evaluate((table) => table.click());
  await bartender.locator('#order-guest:not([disabled])').click();
  assert.equal(await bartender.locator('#staff-action-fields img').count(), 0, 'saved guest name is text, not modal HTML');
  assert.match(await bartender.locator(`#staff-action-fields option[value="${ids.htmlGuest}"]`).innerText(), /<img src=x data-qa-unsafe>/, 'guest label preserves visible text');
  await bartender.locator('#staff-action-cancel').click();
  const bartenderOrderMore = bartender.locator('.order-more');
  if (await bartenderOrderMore.count()) await bartenderOrderMore.locator('summary').click();
  await bartender.locator('#transfer-order:not([disabled])').click();
  assert.match(await bartender.locator(`#staff-action-fields option[value="${ids.freeTable}"]`).innerText(), /QA & свободный/, 'transfer label keeps ampersand readable');
  await bartender.locator('#staff-action-cancel').click();
  await mkdir(screenshotDir, { recursive: true });
  await bartender.locator('#staff-notice.show').waitFor({ state: 'hidden', timeout: 5000 });
  await bartender.waitForTimeout(400);
  for (const [label, width, height] of [['phone-320', 320, 568], ['phone-375', 375, 812], ['fold-cover-673', 673, 900], ['fold-main-902', 902, 900], ['tablet-1100', 1100, 900], ['tablet-1101', 1101, 900], ['laptop-1200', 1200, 900], ['laptop-1201', 1201, 900], ['laptop-1440', 1440, 900], ['wide-1850', 1850, 900], ['wide-1851', 1851, 900], ['desktop-1920', 1920, 1080], ['qhd-2560', 2560, 1440]]) {
    await bartender.setViewportSize({ width, height });
    await bartender.evaluate(() => { document.querySelector('main').scrollTop = 0; });
    const layout = await bartender.evaluate(() => {
      const floor = document.querySelector('#tables');
      const order = document.querySelector('.order');
      const stage = floor.querySelector('.floor-map-stage').getBoundingClientRect();
      const far = floor.querySelector('.table[data-layout-x="800"]').getBoundingClientRect();
      const tabs = document.querySelector('main>.tabs').getBoundingClientRect();
      const zoneButton = document.querySelector('main>.tabs button').getBoundingClientRect();
      const clippedLabels = [...floor.querySelectorAll('.table')].filter((table) => {
        const box = table.getBoundingClientRect();
        return [...table.children].some((child) => { const label = child.getBoundingClientRect(); return label.top < box.top + 3 || label.bottom > box.bottom - 3; });
      }).map((table) => table.getAttribute('aria-label'));
      const edgeBounds = [...floor.querySelectorAll('.table')].filter((table) => ['QA левый край', 'QA правый край', 'QA верхний край', 'QA нижний край'].some((name) => table.getAttribute('aria-label')?.startsWith(name))).map((table) => {
        const box = table.getBoundingClientRect();
        const container = floor.getBoundingClientRect();
        return { id: table.dataset.table, left: box.left - container.left, top: box.top - container.top, right: container.right - box.right, bottom: container.bottom - box.bottom, width: box.width, height: box.height };
      });
      return { documentWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth, title: document.querySelector('main > header b')?.textContent?.trim(), tableCount: floor.querySelectorAll('.table').length, orderTotal: document.querySelector('#order-total')?.textContent?.trim(), tablePosition: getComputedStyle(floor.querySelector('.table')).position, compactMap: floor.classList.contains('compact-map'), clippedLabels, edgeBounds, floorBottom: floor.getBoundingClientRect().bottom, orderTop: order.getBoundingClientRect().top, tabsBottom: tabs.bottom, zoneTop: zoneButton.top, zoneBottom: zoneButton.bottom, zoneHeight: zoneButton.height, farRight: far.right, stageRight: stage.right };
    });
    await bartender.screenshot({ path: path.join(screenshotDir, `pos-${label}.png`), fullPage: true });
    assert.ok(layout.documentWidth <= width + 1 && layout.bodyWidth <= width + 1, `${label} horizontal overflow: ${JSON.stringify(layout)}`);
    assert.equal(layout.tableCount, 9, `${label} keeps all table states`);
    assert.match(layout.orderTotal, /500/, `${label} keeps filled order total`);
    assert.ok(layout.zoneTop >= 0 && layout.zoneBottom <= layout.tabsBottom + 1 && layout.zoneHeight >= 44, `${label} zone tab is fully visible and touchable: ${JSON.stringify(layout)}`);
    assert.equal(layout.tablePosition, width <= 1100 || layout.compactMap ? 'relative' : 'absolute', `${label} uses the expected list/map mode`);
    assert.equal(layout.clippedLabels.length, 0, `${label} keeps table name, state and capacity inside each card: ${JSON.stringify(layout)}`);
    assert.equal(layout.edgeBounds.length, 4, `${label} includes all rotated edge tables`);
    assert.ok(layout.edgeBounds.every((edge) => edge.left >= -1 && edge.top >= -1 && edge.right >= -1 && edge.bottom >= -1 && edge.width >= 44 && edge.height >= 44), `${label} keeps all rotated edge tables visible and touchable: ${JSON.stringify(layout.edgeBounds)}`);
    if (width > 1100 && !layout.compactMap) assert.ok(layout.farRight <= layout.stageRight + 1, `${label} keeps far-right table within the scaled map: ${JSON.stringify(layout)}`);
    if (width === 1920 && !layout.compactMap) {
      for (const name of ['QA левый край', 'QA правый край', 'QA верхний край', 'QA нижний край']) {
        const table = bartender.locator(`#tables .table[aria-label^="${name}"]`);
        await table.scrollIntoViewIfNeeded();
        assert.equal(await table.evaluate((button) => { const rect = button.getBoundingClientRect(); const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2); return button === hit || button.contains(hit); }), true, `${label} rotated ${name} accepts a center touch`);
      }
    }
    if (['phone-320', 'fold-cover-673', 'fold-main-902'].includes(label)) {
      await bartender.locator('#split-payment').scrollIntoViewIfNeeded();
      await bartender.screenshot({ path: path.join(screenshotDir, `pos-order-${label}.png`), fullPage: false });
    }
  }
  await db.query("INSERT INTO tables (id,zone_id,name,status,layout) VALUES ($1,$4,'QA малый слева','free',$5::jsonb),($2,$4,'QA малый справа','free',$6::jsonb),($3,$4,'QA малый снизу','free',$7::jsonb)", [randomUUID(), randomUUID(), randomUUID(), ids.zone, JSON.stringify({ unit: 'px', x: 0, y: 350, width: 40, height: 40, rotation: 45 }), JSON.stringify({ unit: 'px', x: 960, y: 350, width: 40, height: 40, rotation: 45 }), JSON.stringify({ unit: 'px', x: 400, y: 520, width: 40, height: 40, rotation: 45 })]);
  for (const width of [1201, 1920]) {
    await bartender.setViewportSize({ width, height: 900 });
    await bartender.reload({ waitUntil: 'networkidle' });
    await bartender.locator(`[data-zone-id="${ids.zone}"]`).evaluate((tab) => tab.click());
    assert.equal(await bartender.locator('#tables').evaluate((floor) => floor.classList.contains('compact-map')), true, `${width} uses readable cards for tiny floor objects`);
    for (const name of ['QA малый слева', 'QA малый справа', 'QA малый снизу']) {
      const table = bartender.locator(`#tables .table[aria-label^="${name}"]`);
      await table.scrollIntoViewIfNeeded();
      assert.equal(await table.evaluate((button) => { const rect = button.getBoundingClientRect(); const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2); return button === hit || button.contains(hit); }), true, `${width} tiny card ${name} is directly touchable`);
      assert.equal(await table.locator('strong').isVisible(), true, `${width} tiny card ${name} shows its name`);
    }
    await bartender.screenshot({ path: path.join(screenshotDir, `pos-tiny-cards-${width}.png`), fullPage: true });
  }
  await bartender.setViewportSize({ width: 320, height: 568 });
  await bartender.locator(`[data-table="${ids.table}"]`).evaluate((table) => table.click());
  const phoneOrderMore = bartender.locator('.order-more');
  if (await phoneOrderMore.count()) await phoneOrderMore.locator('summary').click();
  await bartender.locator('#split-payment:not([disabled])').evaluate((button) => button.click());
  await bartender.locator('#payment-form [type="submit"]:not([disabled])').waitFor();
  assert.match(await bartender.locator('#payment-due').innerText(), /500/);
  await bartender.screenshot({ path: path.join(screenshotDir, 'payment-phone-320.png'), fullPage: false });
  await bartender.locator('#payment-form [type="submit"]').scrollIntoViewIfNeeded();
  assert.equal(await bartender.locator('#payment-form [type="submit"]').isVisible(), true, 'payment submit is reachable on short phone');
  await bartender.screenshot({ path: path.join(screenshotDir, 'payment-phone-320-scrolled.png'), fullPage: false });
  await bartender.setViewportSize({ width: 673, height: 900 });
  assert.match(await bartender.locator('#payment-due').innerText(), /500/, 'Fold width change preserves payment state');
  await bartender.screenshot({ path: path.join(screenshotDir, 'payment-fold-cover-673.png'), fullPage: false });
  await bartender.locator('#payment-cash').fill('200');
  const firstPost = bartender.waitForResponse((response) => response.request().method() === 'POST' && response.url().endsWith(`/api/orders/${ids.order}/payments`));
  await bartender.locator('#payment-form [type="submit"]').click();
  assert.equal((await firstPost).status(), 201);
  const partial = await browserApi(bartender, `/api/orders/${ids.order}/payments`);
  assert.deepEqual([partial.status, Number(partial.body.due), Number(partial.body.paid), Number(partial.body.remaining)], [200, 500, 200, 300]);
  assert.equal((await db.query('SELECT status FROM orders WHERE id=$1', [ids.order])).rows[0].status, 'open');
  const firstSnapshot = (await db.query('SELECT * FROM pos_order_pricing_snapshots WHERE venue_id=$1 AND order_id=$2', [ids.venue,ids.order])).rows[0];
  assert.ok(firstSnapshot, 'first successful tender creates the canonical snapshot before commit');
  assert.deepEqual([firstSnapshot.currency_code,Number(firstSnapshot.currency_scale),Number(firstSnapshot.subtotal_minor),Number(firstSnapshot.discount_minor),Number(firstSnapshot.final_total_minor)], ['RUB',2,50000,0,50000]);
  const firstSnapshotLines = await db.query("SELECT *,product_facts->>'station' AS station FROM pos_order_pricing_snapshot_lines WHERE venue_id=$1 AND order_id=$2", [ids.venue,ids.order]);
  assert.equal(firstSnapshotLines.rowCount,1,'first tender snapshots every source order item');
  assert.equal(firstSnapshotLines.rows[0].seller_id,ids.bartender,'snapshot freezes the POS seller id');
  assert.equal(firstSnapshotLines.rows[0].station,'bar','snapshot preserves immutable station facts');
  assert.equal((await browserApi(bartender, `/api/orders/${ids.order}/payments`)).body.lineSnapshotStatus,'complete','pricing reader reloads canonical evidence');
  const firstOrderReload=(await browserApi(bartender,'/api/orders')).body.items.find((entry)=>entry.id===ids.order);
  assert.equal(firstOrderReload?.lineSnapshotStatus,'complete','open-order reload exposes canonical snapshot status');
  assert.deepEqual([firstOrderReload?.items?.[0]?.name,firstOrderReload?.items?.[0]?.unitPrice,firstOrderReload?.items?.[0]?.salesEmployeeId,firstOrderReload?.items?.[0]?.station,firstOrderReload?.items?.[0]?.grossMinor],['QA услуга оплаты с длинным названием для проверки строки заказа',500,ids.bartender, 'bar',50000],'open-order reload returns the same frozen product, seller and line-price facts');
  await assert.rejects(db.query('UPDATE order_items SET quantity=quantity+1 WHERE order_id=$1',[ids.order]),(error)=>error.code==='55000','post-snapshot line update is rejected');
  await assert.rejects(db.query('INSERT INTO order_items(order_id,product_id,quantity,unit_price,station) VALUES($1,$2,1,1,\'bar\')',[ids.order,ids.product]),(error)=>error.code==='55000','post-snapshot item insert is rejected');
  await assert.rejects(db.query('UPDATE order_items SET order_id=$2 WHERE order_id=$1',[ids.order,ids.moveTargetOrder]),(error)=>error.code==='55000','moving a source line out of its locked snapshot is rejected');
  await assert.rejects(db.query(`INSERT INTO pos_order_pricing_snapshot_lines(venue_id,snapshot_id,order_id,order_item_id,seller_id,sold_at,quantity,unit_price,gross_minor,discount_minor,net_minor,eligible,product_facts)
    SELECT venue_id,snapshot_id,order_id,order_item_id,seller_id,sold_at,quantity,unit_price,gross_minor,discount_minor,net_minor,eligible,product_facts FROM pos_order_pricing_snapshot_lines WHERE snapshot_id=$1`,[firstSnapshot.id]),(error)=>error.code==='23505','duplicate source item ids cannot enter a snapshot');
  const manager = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: 'ru-RU' });
  await login(manager, base, managerLogin);
  const closedSalesRevenue = Number((await db.query("SELECT COALESCE(SUM(p.amount),0) AS revenue FROM orders o JOIN payments p ON p.order_id=o.id WHERE o.venue_id=$1 AND o.status='closed' AND p.status IN ('paid','partially_paid')", [ids.venue])).rows[0].revenue);
  const closedSalesMethods = Object.fromEntries((await db.query("SELECT p.method,COALESCE(SUM(p.amount),0) AS amount FROM orders o JOIN payments p ON p.order_id=o.id WHERE o.venue_id=$1 AND o.status='closed' AND p.status IN ('paid','partially_paid') GROUP BY p.method", [ids.venue])).rows.map((row) => [row.method, Number(row.amount)]));
  const pendingFinance = await browserApi(manager, '/api/finance/summary');
  assert.equal(pendingFinance.status, 200);
  assert.equal(Number(pendingFinance.body.revenue), closedSalesRevenue, 'partial payment on an open order does not change closed-order revenue');
  assert.equal(Number(pendingFinance.body.pendingRevenue), 300, 'manager sees only unpaid balance as pending');

  await db.query("INSERT INTO orders (id,venue_id,opened_by,status) VALUES ($1,$2,$3,'open')", [ids.failedSnapshotOrder, ids.venue, ids.bartender]);
  await db.query("INSERT INTO order_items (order_id,product_id,quantity,unit_price,station,sales_employee_id,sold_at) VALUES ($1,$2,1,500,'bar',$3,now())", [ids.failedSnapshotOrder, ids.product, ids.bartender]);
  const failedTender=await browserPost(bartender,`/api/orders/${ids.failedSnapshotOrder}/payments`,{amount:501,method:'cash'});
  assert.equal(failedTender.status,409,'an overpayment fails before snapshot write');
  assert.equal(Number((await db.query('SELECT count(*) FROM pos_order_pricing_snapshots WHERE venue_id=$1 AND order_id=$2',[ids.venue,ids.failedSnapshotOrder])).rows[0].count),0,'failed tender transaction leaves no pricing snapshot');
  assert.equal(Number((await db.query('SELECT count(*) FROM payments WHERE order_id=$1',[ids.failedSnapshotOrder])).rows[0].count),0,'failed tender transaction leaves no payment');
  await db.query("UPDATE orders SET status='cancelled' WHERE id=$1",[ids.failedSnapshotOrder]);

  await bartender.reload({ waitUntil: 'networkidle' });
  await bartender.locator(`[data-zone-id="${ids.zone}"]`).evaluate((tab) => tab.click());
  await bartender.locator(`[data-table="${ids.table}"]`).evaluate((table) => table.click());
  await bartender.locator('#split-payment:not([disabled])').evaluate((button) => button.click());
  await bartender.locator('#payment-form [type="submit"]:not([disabled])').waitFor();
  assert.match(await bartender.locator('#payment-due').innerText(), /300/);
  assert.match(await bartender.locator('#payment-message').innerText(), /200.*500/);
  await bartender.locator('#payment-card').fill('301');
  await bartender.locator('#payment-form [type="submit"]').click();
  assert.match(await bartender.locator('#payment-message').innerText(), /больше остатка/);
  assert.equal(Number((await db.query('SELECT count(*) AS count FROM payments WHERE order_id=$1', [ids.order])).rows[0].count), 1, 'overpay input did not create a payment');
  await bartender.locator('#payment-card').fill('300');
  const finalPost = bartender.waitForResponse((response) => response.request().method() === 'POST' && response.url().endsWith(`/api/orders/${ids.order}/payments`));
  await bartender.locator('#payment-form [type="submit"]').click();
  const finalResponse = await finalPost;
  assert.equal(finalResponse.status(), 201);
  assert.equal((await finalResponse.json()).closed, true);
  const settled = await browserApi(bartender, `/api/orders/${ids.order}/payments`);
  assert.deepEqual([Number(settled.body.due), Number(settled.body.paid), Number(settled.body.remaining)], [500, 500, 0]);
  const payments = (await db.query('SELECT method,amount,status,shift_id FROM payments WHERE order_id=$1 ORDER BY created_at,id', [ids.order])).rows;
  assert.equal(payments.length, 2);
  assert.deepEqual(Object.fromEntries(payments.map((payment) => [payment.method, Number(payment.amount)])), { cash: 200, card: 300 });
  assert.ok(payments.every((payment) => payment.status === 'paid' && payment.shift_id));
  const order = (await db.query('SELECT status,closed_in_shift_id FROM orders WHERE id=$1', [ids.order])).rows[0];
  assert.equal(order.status, 'closed');
  assert.ok(order.closed_in_shift_id);
  await bartender.reload({ waitUntil: 'networkidle' });
  await bartender.locator(`[data-zone-id="${ids.zone}"]`).evaluate((tab) => tab.click());
  assert.match(await bartender.locator(`[data-table="${ids.table}"]`).innerText(), /Свободен/);
  const bartenderFinance = await browserApi(bartender, '/api/finance/summary');
  assert.equal(bartenderFinance.status, 200);
  assert.deepEqual(Object.keys(bartenderFinance.body).sort(), ['date', 'employeeView', 'revenue'].sort());

  const managerFinance = await browserApi(manager, '/api/finance/summary');
  assert.equal(managerFinance.status, 200);
  assert.equal(managerFinance.body.employeeView, undefined);
  assert.equal(Number(managerFinance.body.revenue), closedSalesRevenue + 500);
  assert.equal(Number(managerFinance.body.closedOrders), 3);
  assert.equal(Number(managerFinance.body.paymentCount), 4);
  const expectedPaymentMethods = { ...closedSalesMethods, cash: (closedSalesMethods.cash || 0) + 200, card: (closedSalesMethods.card || 0) + 300 };
  assert.deepEqual(managerFinance.body.byPaymentMethod, expectedPaymentMethods);
  await manager.goto(`${base}/finance/report`, { waitUntil: 'networkidle' });
  await manager.locator('#report-revenue').waitFor({ state: 'visible' });
  const parseMoney = async (selector) => Number((await manager.locator(selector).innerText()).replace(/[^\d,-]/g, '').replace(',', '.'));
  assert.equal(await parseMoney('#report-revenue'), closedSalesRevenue + 500);
  assert.equal(await parseMoney('#report-cash'), expectedPaymentMethods.cash);
  assert.equal(await parseMoney('#report-digital'), (expectedPaymentMethods.card || 0) + (expectedPaymentMethods.qr || 0));
  const reportPaymentsText = await manager.locator('#report-payments').innerText();
  for (const [method, label] of [['cash', 'Наличные'], ['card', 'Карта'], ['qr', 'QR']]) {
    const amount = expectedPaymentMethods[method];
    if (amount) assert.match(reportPaymentsText, new RegExp(`${label}.*${String(amount).replace(/\B(?=(\d{3})+(?!\d))/g, '[\\s\\u00a0]*')}`, 's'));
  }
  await db.query("INSERT INTO guests (id,venue_id,full_name,phone) VALUES ($1,$2,'QA гость разделения','+79990000001')", [ids.guest, ids.venue]);
  await db.query("INSERT INTO orders (id,venue_id,table_id,guest_id,notes,opened_by,status) VALUES ($1,$2,$3,$4,'QA заметка разделения',$5,'open')", [ids.splitOrder, ids.venue, ids.table, ids.guest, ids.bartender]);
  await db.query("INSERT INTO order_items (id,order_id,product_id,quantity,unit_price,station) VALUES ($1,$3,$4,1,500,'bar'),($2,$3,$4,1,500,'bar')", [ids.splitItemA, ids.splitItemB, ids.splitOrder, ids.product]);
  await db.query("UPDATE tables SET status='occupied' WHERE id=$1", [ids.table]);
  const beforeSplitCount = Number((await db.query('SELECT count(*) AS count FROM orders WHERE venue_id=$1', [ids.venue])).rows[0].count);
  assert.equal((await browserPost(bartender, `/api/orders/${ids.splitOrder}/split`, { itemIds: [ids.splitItemA, randomUUID()] })).status, 409, 'mixed valid/foreign item IDs are rejected atomically');
  assert.equal((await browserPost(bartender, `/api/orders/${ids.splitOrder}/split`, { itemIds: [ids.splitItemA, ids.splitItemA] })).status, 400, 'duplicate item IDs are rejected');
  assert.equal((await browserPost(bartender, `/api/orders/${ids.splitOrder}/split`, { itemIds: [ids.splitItemA, 'a'.repeat(36)] })).status, 400, 'malformed UUID is rejected before SQL');
  assert.equal((await browserPost(bartender, `/api/orders/${ids.splitOrder}/split`, { itemIds: [ids.splitItemA, ids.splitItemB] })).status, 409, 'moving every item is rejected');
  assert.equal(Number((await db.query('SELECT count(*) AS count FROM orders WHERE venue_id=$1', [ids.venue])).rows[0].count), beforeSplitCount, 'invalid splits create no order');
  await bartender.setViewportSize({ width: 375, height: 812 });
  await bartender.reload({ waitUntil: 'networkidle' });
  await bartender.locator(`[data-zone-id="${ids.zone}"]`).evaluate((tab) => tab.click());
  await bartender.locator(`[data-table="${ids.table}"]`).evaluate((table) => table.click());
  await bartender.locator('#split-order:not([disabled])').evaluate((button) => button.click());
  await bartender.locator('#staff-action-fields [name="items"]').fill('1, abc');
  await bartender.locator('#staff-action-submit').click();
  assert.equal(Number((await db.query('SELECT count(*) AS count FROM orders WHERE venue_id=$1', [ids.venue])).rows[0].count), beforeSplitCount, 'mixed valid/invalid UI indexes create no order');
  await bartender.locator('#split-order:not([disabled])').evaluate((button) => button.click());
  await bartender.locator('#staff-action-fields [name="items"]').fill('1');
  await bartender.evaluate((tableId) => document.querySelector(`[data-table="${tableId}"]`).click(), ids.freeTable);
  await bartender.locator('#staff-action-submit').click();
  assert.equal(Number((await db.query('SELECT count(*) AS count FROM orders WHERE venue_id=$1', [ids.venue])).rows[0].count), beforeSplitCount, 'switching tables during the dialog cannot split another order');
  await bartender.locator(`[data-table="${ids.table}"]`).evaluate((table) => table.click());
  await bartender.locator('#split-order:not([disabled])').evaluate((button) => button.click());
  await bartender.locator('#staff-action-fields [name="items"]').fill('1');
  const splitPost = bartender.waitForResponse((response) => response.request().method() === 'POST' && response.url().endsWith(`/api/orders/${ids.splitOrder}/split`));
  await bartender.locator('#staff-action-submit').click();
  const splitResponse = await splitPost;
  assert.equal(splitResponse.status(), 201, 'bartender split saves through real API');
  const splitTarget = await splitResponse.json();
  assert.equal(splitTarget.guestId, ids.guest, 'split response keeps guest');
  assert.equal(splitTarget.notes, 'QA заметка разделения', 'split response keeps notes');
  const splitRows = (await db.query('SELECT id,guest_id,notes FROM orders WHERE id=ANY($1::uuid[]) ORDER BY created_at', [[ids.splitOrder, splitTarget.id]])).rows;
  assert.equal(splitRows.length, 2, 'split creates exactly one second open order');
  assert.ok(splitRows.every((row) => row.guest_id === ids.guest && row.notes === 'QA заметка разделения'), 'source and target persist guest and notes');
  const splitItems = (await db.query('SELECT order_id,count(*)::int AS count FROM order_items WHERE order_id IN ($1,$2) GROUP BY order_id', [ids.splitOrder, splitTarget.id])).rows;
  assert.deepEqual(Object.fromEntries(splitItems.map((row) => [row.order_id, row.count])), { [ids.splitOrder]: 1, [splitTarget.id]: 1 });
  await bartender.reload({ waitUntil: 'networkidle' });
  const splitRead = await browserApi(bartender, '/api/orders');
  assert.equal(splitRead.status, 200);
  assert.ok((splitRead.body.items || []).some((entry) => entry.id === splitTarget.id && entry.guestName === 'QA гость разделения'), 'split target guest survives reload');
  await bartender.locator(`[data-queue-order="${ids.splitOrder}"]`).evaluate((button) => button.click());
  await bartender.locator('#order-notes:not([disabled])').click();
  await bartender.locator('#staff-action-fields [name="notes"]').fill('Нельзя перенести в другой заказ');
  await bartender.evaluate((id) => document.querySelector(`[data-queue-order="${id}"]`).click(), splitTarget.id);
  await bartender.locator('#staff-action-submit').click();
  assert.match(await bartender.locator('#staff-notice').innerText(), /Заказ изменился/, 'stale note is rejected after selection changes');
  assert.deepEqual((await db.query('SELECT notes FROM orders WHERE id IN ($1,$2) ORDER BY id', [ids.splitOrder, splitTarget.id])).rows.map((row) => row.notes), ['QA заметка разделения', 'QA заметка разделения'], 'stale note changes neither order');
  await bartender.locator(`[data-queue-order="${ids.splitOrder}"]`).evaluate((button) => button.click());
  await bartender.locator('#order-guest:not([disabled])').click();
  await bartender.locator('#staff-action-fields [name="clientId"]').waitFor();
  assert.equal(await bartender.locator('#staff-action-fields [name="clientId"]').count(), 1, 'guest action has one modal form');
  assert.equal(await bartender.locator('#staff-action-fields [name="guests"]').count(), 0, 'unsupported guest count is not offered');
  await bartender.locator('#staff-action-fields [name="clientId"]').selectOption(ids.htmlGuest);
  await bartender.evaluate((id) => document.querySelector(`[data-queue-order="${id}"]`).click(), splitTarget.id);
  await bartender.locator('#staff-action-submit').click();
  assert.match(await bartender.locator('#staff-notice').innerText(), /Заказ изменился/, 'stale guest binding is rejected');
  assert.deepEqual((await db.query('SELECT guest_id FROM orders WHERE id IN ($1,$2) ORDER BY id', [ids.splitOrder, splitTarget.id])).rows.map((row) => row.guest_id), [ids.guest, ids.guest], 'stale guest binding changes neither order');
  await bartender.locator(`[data-queue-order="${ids.splitOrder}"]`).evaluate((button) => button.click());
  await bartender.locator('#order-notes:not([disabled])').click();
  await bartender.locator('#staff-action-fields [name="notes"]').fill('QA заметка сохранена');
  const notesPatch = bartender.waitForResponse((response) => response.request().method() === 'PATCH' && response.url().endsWith(`/api/orders/${ids.splitOrder}`));
  await bartender.locator('#staff-action-submit').click();
  assert.equal((await notesPatch).status(), 200, 'current note saves once');
  await bartender.locator('#order-guest:not([disabled])').click();
  await bartender.locator('#staff-action-fields [name="clientId"]').selectOption(ids.htmlGuest);
  const guestPatch = bartender.waitForResponse((response) => response.request().method() === 'PATCH' && response.url().endsWith(`/api/orders/${ids.splitOrder}`));
  await bartender.locator('#staff-action-submit').click();
  assert.equal((await guestPatch).status(), 200, 'current guest saves once');
  await bartender.reload({ waitUntil: 'networkidle' });
  const savedContext = (await browserApi(bartender, '/api/orders')).body.items || [];
  assert.equal(savedContext.find((order) => order.id === ids.splitOrder)?.guestId, ids.htmlGuest, 'guest survives reload on source order');
  assert.equal(savedContext.find((order) => order.id === ids.splitOrder)?.notes, 'QA заметка сохранена', 'note survives reload on source order');
  assert.equal(savedContext.find((order) => order.id === splitTarget.id)?.guestId, ids.guest, 'other guest remains unchanged');
  assert.equal(savedContext.find((order) => order.id === splitTarget.id)?.notes, 'QA заметка разделения', 'other note remains unchanged');
  const sourceItemId = (await db.query('SELECT id FROM order_items WHERE order_id=$1', [ids.splitOrder])).rows[0].id;
  const targetItemId = (await db.query('SELECT id FROM order_items WHERE order_id=$1', [splitTarget.id])).rows[0].id;
  await db.query('UPDATE order_items SET quantity=2 WHERE id=$1', [sourceItemId]);
  await bartender.reload({ waitUntil: 'networkidle' });
  for (const quantity of [1.5, 1000]) assert.equal((await browserPatch(bartender, `/api/orders/${ids.splitOrder}/items/${sourceItemId}`, { quantity })).status, 400, `invalid quantity ${quantity} is rejected`);
  await bartender.locator(`[data-queue-order="${ids.splitOrder}"]`).evaluate((button) => button.click());
  let releaseItemPatch;
  const itemPatchGate = new Promise((resolve) => { releaseItemPatch = resolve; });
  let itemPatchStarted;
  const itemPatchStartedPromise = new Promise((resolve) => { itemPatchStarted = resolve; });
  await bartender.route(`**/api/orders/${ids.splitOrder}/items/${sourceItemId}`, async (route) => { const response = await route.fetch(); itemPatchStarted(); await itemPatchGate; await route.fulfill({ response }); });
  const itemPatchResponse = bartender.waitForResponse((response) => response.request().method() === 'PATCH' && response.url().endsWith(`/api/orders/${ids.splitOrder}/items/${sourceItemId}`));
  await bartender.locator(`.qty-minus[data-item="${sourceItemId}"]`).click();
  await itemPatchStartedPromise;
  await bartender.evaluate((id) => document.querySelector(`[data-queue-order="${id}"]`).click(), splitTarget.id);
  releaseItemPatch();
  assert.equal((await itemPatchResponse).status(), 200, 'quantity PATCH returns for source after selection change');
  await bartender.unroute(`**/api/orders/${ids.splitOrder}/items/${sourceItemId}`);
  assert.equal(await bartender.evaluate(() => currentOrder?.id), splitTarget.id, 'late item PATCH keeps the selected target order');
  assert.equal(Number((await db.query('SELECT quantity FROM order_items WHERE id=$1', [sourceItemId])).rows[0].quantity), 1, 'source quantity persisted');
  assert.equal(Number((await db.query('SELECT quantity FROM order_items WHERE id=$1', [targetItemId])).rows[0].quantity), 1, 'other quantity unchanged');
  const removableItemId = randomUUID();
  await db.query("INSERT INTO order_items (id,order_id,product_id,quantity,unit_price,station) VALUES ($1,$2,$3,1,500,'bar')", [removableItemId, ids.splitOrder, ids.product]);
  await bartender.reload({ waitUntil: 'networkidle' });
  await bartender.locator(`[data-queue-order="${ids.splitOrder}"]`).evaluate((button) => button.click());
  let releaseItemDelete;
  const itemDeleteGate = new Promise((resolve) => { releaseItemDelete = resolve; });
  let itemDeleteStarted;
  const itemDeleteStartedPromise = new Promise((resolve) => { itemDeleteStarted = resolve; });
  await bartender.route(`**/api/orders/${ids.splitOrder}/items/${removableItemId}`, async (route) => { const response = await route.fetch(); itemDeleteStarted(); await itemDeleteGate; await route.fulfill({ response }); });
  const itemDeleteResponse = bartender.waitForResponse((response) => response.request().method() === 'DELETE' && response.url().endsWith(`/api/orders/${ids.splitOrder}/items/${removableItemId}`));
  await bartender.locator(`.qty-minus[data-item="${removableItemId}"]`).click();
  await itemDeleteStartedPromise;
  await bartender.evaluate((id) => document.querySelector(`[data-queue-order="${id}"]`).click(), splitTarget.id);
  releaseItemDelete();
  assert.equal((await itemDeleteResponse).status(), 200, 'item DELETE returns for source after selection change');
  await bartender.unroute(`**/api/orders/${ids.splitOrder}/items/${removableItemId}`);
  assert.equal(await bartender.evaluate(() => currentOrder?.id), splitTarget.id, 'late item DELETE keeps selected order');
  assert.equal(await bartender.evaluate(() => currentOrder?.items?.length), 1, 'late item DELETE keeps selected item list');
  assert.equal(Number((await db.query('SELECT count(*) AS count FROM order_items WHERE id=$1', [removableItemId])).rows[0].count), 0, 'source extra item deleted');
  assert.equal(Number((await db.query('SELECT count(*) AS count FROM order_items WHERE order_id=$1', [splitTarget.id])).rows[0].count), 1, 'other item list unchanged');
  assert.equal(Number((await db.query('SELECT quantity FROM order_items WHERE id=$1', [sourceItemId])).rows[0].quantity), 1, 'source quantity returns to its original finance-test baseline');
  await bartender.locator(`[data-queue-order="${ids.splitOrder}"]`).evaluate((button) => button.click());
  await bartender.locator('#order-delete:not([disabled])').evaluate((button) => button.click());
  await bartender.locator('#staff-action-fields [name="comment"]').fill('Нельзя удалить другой заказ');
  await bartender.evaluate((id) => document.querySelector(`[data-queue-order="${id}"]`).click(), splitTarget.id);
  await bartender.locator('#staff-action-submit').click();
  assert.match(await bartender.locator('#staff-notice').innerText(), /Заказ изменился/, 'stale delete dialog is rejected');
  assert.deepEqual((await db.query('SELECT status FROM orders WHERE id IN ($1,$2) ORDER BY id', [ids.splitOrder, splitTarget.id])).rows.map((row) => row.status), ['open', 'open'], 'stale delete changes neither order');
  await bartender.locator(`[data-zone-id="${ids.zone}"]`).evaluate((tab) => tab.click());
  await bartender.locator(`[data-table="${ids.table}"]`).evaluate((table) => table.click());
  await bartender.locator('#discount-request:not([disabled])').evaluate((button) => button.click());
  await bartender.locator('#staff-action-fields [name="value"]').fill('10');
  await bartender.evaluate((tableId) => document.querySelector(`[data-table="${tableId}"]`).click(), ids.freeTable);
  await bartender.locator('#staff-action-submit').click();
  assert.equal(Number((await db.query('SELECT count(*) AS count FROM discounts d JOIN orders o ON o.id=d.order_id WHERE o.venue_id=$1', [ids.venue])).rows[0].count), 0, 'switching tables during discount dialog creates no request');
  assert.equal((await browserPost(bartender, `/api/orders/${ids.order}/discount-requests`, { type: 'percent', value: 10, reason: 'closed order' })).status, 409, 'closed order rejects a new discount');
  await bartender.locator(`[data-table="${ids.table}"]`).evaluate((table) => table.click());
  await bartender.locator('#discount-request:not([disabled])').evaluate((button) => button.click());
  await bartender.locator('#staff-action-fields [name="value"]').fill('10');
  await bartender.locator('#staff-action-fields [name="reason"]').fill('QA согласование скидки');
  const discountPost = bartender.waitForResponse((response) => response.request().method() === 'POST' && /\/api\/orders\/[^/]+\/discount-requests$/.test(response.url()));
  await bartender.locator('#staff-action-submit').click();
  const discountResponse = await discountPost;
  assert.equal(discountResponse.status(), 201, 'bartender requests discount from POS');
  const requestedDiscount = await discountResponse.json();
  assert.ok([ids.splitOrder, splitTarget.id].includes(requestedDiscount.orderId));
  assert.equal((await db.query('SELECT status,reason FROM discounts WHERE id=$1', [requestedDiscount.id])).rows[0].reason, 'QA согласование скидки');
  await manager.goto(`${base}/finance`, { waitUntil: 'networkidle' });
  await manager.locator('#discount-list').getByText('QA согласование скидки').waitFor({ state: 'attached' });
  assert.equal(await manager.locator(`.discount-approve[data-discount="${requestedDiscount.id}"]`).count(), 0, 'manager sees discount but cannot decide');
  assert.equal((await browserPost(manager, `/api/discount-requests/${requestedDiscount.id}/approve`, {})).status, 403, 'manager decision API is denied');
  const admin = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: 'ru-RU' });
  await login(admin, base, adminLogin);
  await admin.goto(`${base}/finance`, { waitUntil: 'networkidle' });
  await admin.locator(`.discount-approve[data-discount="${requestedDiscount.id}"]`).evaluate((button) => button.click());
  await admin.locator('#discount-message').getByText(/Скидка одобрена/).waitFor();
  const approved = (await db.query('SELECT status,approved_by FROM discounts WHERE id=$1', [requestedDiscount.id])).rows[0];
  assert.deepEqual(approved, { status: 'approved', approved_by: ids.admin });
  const discountedPayment = await browserApi(bartender, `/api/orders/${requestedDiscount.orderId}/payments`);
  assert.deepEqual([discountedPayment.status, Number(discountedPayment.body.due)], [200, 450], 'approved 10% discount persists in amount due');
  await bartender.reload({ waitUntil: 'networkidle' });
  await bartender.locator(`[data-queue-order="${requestedDiscount.orderId}"]`).evaluate((button) => button.click());
  await bartender.locator('#split-payment:not([disabled])').evaluate((button) => button.click());
  await bartender.waitForFunction(() => /450/.test(document.querySelector('#payment-due')?.textContent || ''));
  assert.match(await bartender.locator('#payment-due').innerText(), /450/, 'POS shows approved amount after reload');
  await bartender.locator('#payment-close').click();
  const otherOrderId = requestedDiscount.orderId === ids.splitOrder ? splitTarget.id : ids.splitOrder;
  const concurrentRequests = await Promise.all([browserPost(bartender, `/api/orders/${otherOrderId}/discount-requests`, { type: 'percent', value: 5, reason: 'QA parallel A' }), browserPost(bartender, `/api/orders/${otherOrderId}/discount-requests`, { type: 'percent', value: 6, reason: 'QA parallel B' })]);
  assert.deepEqual(concurrentRequests.map((entry) => entry.status).sort(), [201, 409], 'parallel requests create one pending discount');
  assert.equal(Number((await db.query("SELECT count(*) AS count FROM discounts WHERE order_id=$1 AND status='requested'", [otherOrderId])).rows[0].count), 1);
  const pendingFinanceSummary = await browserApi(manager, '/api/finance/summary');
  const pendingOrderState = await db.query("SELECT o.status,COALESCE((SELECT SUM(i.unit_price*i.quantity) FROM order_items i WHERE i.order_id=o.id),0)::numeric AS gross,COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.order_id=o.id AND p.status IN ('paid','partially_paid')),0)::numeric AS paid,COALESCE((SELECT SUM(d.value) FROM discounts d WHERE d.order_id=o.id AND d.status='approved'),0)::numeric AS approved_discount FROM orders o WHERE o.venue_id=$1 AND o.status IN ('open','in_progress','ready')", [ids.venue]);
  assert.equal(Number(pendingFinanceSummary.body.pendingRevenue), 950, `manager pending revenue reflects approved discount; active order evidence ${JSON.stringify(pendingOrderState.rows)}`);
  await bartender.locator(`[data-queue-order="${ids.splitOrder}"]`).evaluate((button) => button.click());
  let releaseStatus;
  const statusGate = new Promise((resolve) => { releaseStatus = resolve; });
  let statusStarted;
  const statusStartedPromise = new Promise((resolve) => { statusStarted = resolve; });
  await bartender.route(`**/api/orders/${ids.splitOrder}/status`, async (route) => { const response = await route.fetch(); statusStarted(); await statusGate; await route.fulfill({ response }); });
  await bartender.locator('.actions button').first().click();
  await statusStartedPromise;
  await bartender.evaluate((id) => document.querySelector(`[data-queue-order="${id}"]`).click(), splitTarget.id);
  const statusResponse = bartender.waitForResponse((response) => response.url().endsWith(`/api/orders/${ids.splitOrder}/status`));
  const floorAfterStatus = bartender.waitForResponse((response) => response.request().method() === 'GET' && response.url().endsWith('/api/floor'));
  releaseStatus();
  assert.equal((await statusResponse).status(), 200, 'status response reaches POS after selection change');
  await floorAfterStatus;
  await bartender.unroute(`**/api/orders/${ids.splitOrder}/status`);
  assert.equal((await db.query('SELECT status FROM orders WHERE id=$1', [ids.splitOrder])).rows[0].status, 'in_progress', 'status persisted on source order');
  assert.equal((await db.query('SELECT status FROM orders WHERE id=$1', [splitTarget.id])).rows[0].status, 'open', 'other order status is unchanged');
  assert.equal(await bartender.evaluate(() => currentOrder?.id), splitTarget.id, 'late status response keeps the new selection');
  assert.equal(await bartender.evaluate(() => currentOrder?.status), 'open', 'late status response does not corrupt selected order in memory');
  await bartender.waitForFunction(() => floorReady && !document.querySelector('.order')?.inert);
  await bartender.locator(`[data-queue-order="${ids.splitOrder}"]`).evaluate((button) => button.click());
  await bartender.locator('.close:not([disabled])').click();
  await bartender.evaluate((id) => document.querySelector(`[data-queue-order="${id}"]`).click(), splitTarget.id);
  await bartender.locator('#staff-action-submit').click();
  assert.match(await bartender.locator('#staff-notice').innerText(), /Заказ изменился/, 'close dialog rejects stale selection');
  assert.equal((await db.query('SELECT status FROM orders WHERE id=$1', [ids.splitOrder])).rows[0].status, 'in_progress', 'stale close leaves source order open');
  assert.equal((await db.query('SELECT status FROM orders WHERE id=$1', [splitTarget.id])).rows[0].status, 'open', 'stale close leaves other order open');
  await bartender.locator(`[data-queue-order="${ids.splitOrder}"]`).evaluate((button) => button.click());
  await bartender.locator('.close:not([disabled])').click();
  let releaseClose;
  const closeGate = new Promise((resolve) => { releaseClose = resolve; });
  let closeStarted;
  const closeStartedPromise = new Promise((resolve) => { closeStarted = resolve; });
  await bartender.route(`**/api/orders/${ids.splitOrder}/close`, async (route) => { const response = await route.fetch(); closeStarted(); await closeGate; await route.fulfill({ response }); });
  const closeResponse = bartender.waitForResponse((response) => response.request().method() === 'POST' && response.url().endsWith(`/api/orders/${ids.splitOrder}/close`));
  await bartender.locator('#staff-action-submit').click();
  await closeStartedPromise;
  await bartender.evaluate((id) => document.querySelector(`[data-queue-order="${id}"]`).click(), splitTarget.id);
  releaseClose();
  assert.equal((await closeResponse).status(), 200, 'close submits the captured order');
  await bartender.unroute(`**/api/orders/${ids.splitOrder}/close`);
  await bartender.waitForFunction((id) => !document.querySelector(`[data-queue-order="${id}"]`), ids.splitOrder);
  assert.equal(await bartender.evaluate(() => currentOrder?.id), splitTarget.id, 'late close response keeps the new selection');
  assert.equal((await db.query('SELECT status FROM orders WHERE id=$1', [ids.splitOrder])).rows[0].status, 'closed', 'source order closed');
  assert.equal((await db.query('SELECT status FROM orders WHERE id=$1', [splitTarget.id])).rows[0].status, 'open', 'other order remains open');
  await bartender.reload({ waitUntil: 'networkidle' });
  const afterCloseRead = (await browserApi(bartender, '/api/orders?scope=all')).body.items || [];
  assert.equal(afterCloseRead.find((order) => order.id === ids.splitOrder)?.status, 'closed', 'close survives reload');
  assert.equal(afterCloseRead.find((order) => order.id === splitTarget.id)?.status, 'open', 'other order survives reload');
  await bartender.locator(`[data-queue-order="${splitTarget.id}"]`).evaluate((button) => button.click());
  await bartender.locator('#order-delete:not([disabled])').click();
  await bartender.locator('#staff-action-fields [name="comment"]').fill('QA отмена ошибочного заказа');
  await bartender.locator('#staff-action-fields [name="writeoff"]').selectOption('false');
  const deleteResponse = bartender.waitForResponse((response) => response.request().method() === 'DELETE' && response.url().endsWith(`/api/orders/${splitTarget.id}`));
  await bartender.locator('#staff-action-submit').click();
  assert.equal((await deleteResponse).status(), 200, 'current order deletion saves through API');
  assert.equal((await db.query('SELECT status FROM orders WHERE id=$1', [splitTarget.id])).rows[0].status, 'cancelled', 'deleted order is preserved as cancelled in database');
  await bartender.reload({ waitUntil: 'networkidle' });
  const afterDeleteRead = (await browserApi(bartender, '/api/orders?scope=all')).body.items || [];
  assert.equal(afterDeleteRead.find((order) => order.id === splitTarget.id)?.status, 'cancelled', 'deletion survives reload');
  await db.query("INSERT INTO orders (id,venue_id,table_id,opened_by,status) VALUES ($1,$2,$3,$4,'open')", [ids.raceOrder, ids.venue, ids.freeTable, ids.bartender]);
  await db.query("INSERT INTO order_items (order_id,product_id,quantity,unit_price,station) VALUES ($1,$2,1,500,'bar')", [ids.raceOrder, ids.product]);
  const missingClient = await browserPatch(bartender, `/api/orders/${ids.raceOrder}`, { clientId: randomUUID(), notes: 'must rollback' });
  assert.deepEqual([missingClient.status, missingClient.body.error], [404, 'client_not_found'], 'missing guest rejects combined edit');
  assert.equal((await db.query('SELECT notes FROM orders WHERE id=$1', [ids.raceOrder])).rows[0].notes, null, 'rejected edit leaves notes unchanged');
  const combinedEdit = await browserPatch(bartender, `/api/orders/${ids.raceOrder}`, { guestName: 'QA combined guest', phone: '+79990000002', notes: 'QA before race' });
  assert.equal(combinedEdit.status, 200, 'guest and note save atomically');
  assert.equal(combinedEdit.body.notes, 'QA before race');
  assert.equal(combinedEdit.body.guestName, 'QA combined guest');
  const lockDb = new Client({ connectionString: databaseUrl });
  await lockDb.connect();
  let lockActive = false;
  try {
    await lockDb.query('BEGIN'); lockActive = true;
    await lockDb.query('SELECT id FROM orders WHERE id=$1 FOR UPDATE', [ids.raceOrder]);
    const closingRace = browserPost(bartender, `/api/orders/${ids.raceOrder}/close`, { paymentMethod: 'cash' });
    const editingRace = browserPatch(bartender, `/api/orders/${ids.raceOrder}`, { guestName: 'QA race guest', phone: '+79990000003', notes: 'QA race note' });
    let blockedRequests = 0;
    for (let attempt = 0; attempt < 40; attempt++) {
      blockedRequests = Number((await db.query("SELECT count(*) AS count FROM pg_stat_activity WHERE datname=current_database() AND state='active' AND wait_event_type='Lock'")).rows[0].count);
      if (blockedRequests >= 2) break;
      await delay(50);
    }
    assert.ok(blockedRequests >= 2, 'close and edit both wait on the locked order before release');
    await lockDb.query('COMMIT'); lockActive = false;
    const [closedRace, editedRace] = await Promise.all([closingRace, editingRace]);
    assert.equal(closedRace.status, 200, `concurrent close succeeds: ${JSON.stringify(closedRace.body)}`);
    assert.ok([200, 409].includes(editedRace.status), `concurrent edit has a serialized outcome: ${JSON.stringify(editedRace)}`);
    if (editedRace.status === 409) assert.equal(editedRace.body.error, 'order_not_editable');
    const raceState = (await db.query('SELECT status,notes,guest_id FROM orders WHERE id=$1', [ids.raceOrder])).rows[0];
    assert.equal(raceState.status, 'closed', 'race order closes exactly once');
    assert.equal(raceState.notes, editedRace.status === 200 ? 'QA race note' : 'QA before race', 'notes match serialized edit result');
    assert.equal(Number((await db.query("SELECT count(*) AS count FROM guests WHERE venue_id=$1 AND phone='+79990000003'", [ids.venue])).rows[0].count), editedRace.status === 200 ? 1 : 0, 'rejected edit creates no guest');
  } finally { if (lockActive) await lockDb.query('ROLLBACK').catch(() => {}); await lockDb.end(); }
  await db.query("INSERT INTO products (id,venue_id,name,category,sale_price,inventory_mode) VALUES ($1,$2,'QA <img src=x data-qa-product>','Услуги',100,'non_stock')", [ids.htmlProduct, ids.venue]);
  await db.query("INSERT INTO orders (id,venue_id,table_id,opened_by,status) VALUES ($1,$2,$3,$4,'open')", [ids.htmlOrder, ids.venue, ids.freeTable, ids.bartender]);
  await db.query("INSERT INTO order_items (order_id,product_id,quantity,unit_price,station) VALUES ($1,$2,1,100,'bar')", [ids.htmlOrder, ids.htmlProduct]);
  await bartender.reload({ waitUntil: 'networkidle' });
  await bartender.locator(`[data-queue-order="${ids.htmlOrder}"]`).evaluate((button) => button.click());
  assert.equal(await bartender.locator('.order .items img').count(), 0, 'stored product name creates no HTML image in order');
  assert.match(await bartender.locator('.order .items .order-item-row span').first().innerText(), /<img src=x data-qa-product>/i, 'stored product markup is shown as text');

  const addOrder = async (orderId, productId=ids.product) => {
    await db.query("INSERT INTO orders(id,venue_id,opened_by,status) VALUES($1,$2,$3,'open')",[orderId,ids.venue,ids.bartender]);
    await db.query("INSERT INTO order_items(order_id,product_id,quantity,unit_price,station) VALUES($1,$2,1,500,'bar')",[orderId,productId]);
  };
  await addOrder(ids.replayOrder);
  const replayKey=`snapshot-replay-${randomUUID()}`;
  const replayPayload={amount:100,method:'cash',idempotencyKey:replayKey};
  assert.equal((await browserPost(bartender,`/api/orders/${ids.replayOrder}/payments`,replayPayload)).status,201,'first tender starts the immutable snapshot transaction');
  const replayResponse=await browserPost(bartender,`/api/orders/${ids.replayOrder}/payments`,replayPayload);
  assert.equal(replayResponse.status,200,'idempotent payment replay succeeds');
  assert.equal(replayResponse.body.idempotentReplay,true);
  assert.equal(Number((await db.query('SELECT count(*) FROM payments WHERE order_id=$1',[ids.replayOrder])).rows[0].count),1,'payment replay creates no duplicate tender');
  assert.equal(Number((await db.query('SELECT count(*) FROM pos_order_pricing_snapshots WHERE venue_id=$1 AND order_id=$2',[ids.venue,ids.replayOrder])).rows[0].count),1,'payment replay preserves one snapshot');

  await addOrder(ids.directCloseOrder);
  const directClose=await browserPost(bartender,`/api/orders/${ids.directCloseOrder}/close`,{paymentMethod:'cash'});
  assert.equal(directClose.status,200,`direct close creates a canonical snapshot: ${JSON.stringify(directClose.body)}`);
  assert.equal(Number((await db.query('SELECT count(*) FROM pos_order_pricing_snapshot_lines WHERE venue_id=$1 AND order_id=$2',[ids.venue,ids.directCloseOrder])).rows[0].count),1,'direct close writes the complete source line set');

  await addOrder(ids.concurrentSnapshotOrder);
  const concurrentTender=browserPost(bartender,`/api/orders/${ids.concurrentSnapshotOrder}/payments`,{amount:500,method:'cash',idempotencyKey:`race-${randomUUID()}`});
  const concurrentClose=browserPost(bartender,`/api/orders/${ids.concurrentSnapshotOrder}/close`,{paymentMethod:'cash'});
  const [tenderRace,closeRace]=await Promise.all([concurrentTender,concurrentClose]);
  assert.ok([201,409].includes(tenderRace.status),`concurrent first tender has a serialized result: ${JSON.stringify(tenderRace.body)}`);
  assert.ok([200,409].includes(closeRace.status),`concurrent direct close has a serialized result: ${JSON.stringify(closeRace.body)}`);
  assert.ok(tenderRace.status===201||closeRace.status===200,'one concurrent transaction closes the order');
  assert.equal(Number((await db.query('SELECT count(*) FROM pos_order_pricing_snapshots WHERE venue_id=$1 AND order_id=$2',[ids.venue,ids.concurrentSnapshotOrder])).rows[0].count),1,'payment-versus-close creates exactly one header');
  assert.equal(Number((await db.query('SELECT count(*) FROM pos_order_pricing_snapshot_lines WHERE venue_id=$1 AND order_id=$2',[ids.venue,ids.concurrentSnapshotOrder])).rows[0].count),1,'payment-versus-close creates exactly one line set');

  await db.query("INSERT INTO orders(id,venue_id,opened_by,status) VALUES($1,$2,$3,'open')",[ids.fractionalOrder,ids.venue,ids.bartender]);
  await db.query("INSERT INTO order_items(id,order_id,product_id,quantity,unit_price,station) VALUES($1,$3,$4,0.5,0.01,'bar'),($2,$3,$4,0.5,0.01,'bar')",[ids.fractionalItemA,ids.fractionalItemB,ids.fractionalOrder,ids.fractionalProduct]);
  await db.query(`INSERT INTO loyalty_promotions(venue_id,promotion_id,version,name,status,starts_at,ends_at,timezone,benefit_kind,benefit_value,priority,created_by)
    VALUES($1,$2,1,'QA one-cent promo','active',now()-interval '1 day',now()+interval '1 day','Asia/Yekaterinburg','percent',100,100,$3)`,[ids.venue,ids.fractionalPromotion,ids.manager]);
  await db.query("INSERT INTO loyalty_promotion_scopes(venue_id,promotion_id,version,scope_kind,product_id) VALUES($1,$2,1,'include_product',$3)",[ids.venue,ids.fractionalPromotion,ids.fractionalProduct]);
  const fractionalClose=await browserPost(bartender,`/api/orders/${ids.fractionalOrder}/close`,{paymentMethod:'cash'});
  assert.equal(fractionalClose.status,200,`fractional promo close succeeds: ${JSON.stringify(fractionalClose.body)}`);
  const fractionalSnapshot=(await db.query('SELECT * FROM pos_order_pricing_snapshots WHERE venue_id=$1 AND order_id=$2',[ids.venue,ids.fractionalOrder])).rows[0];
  assert.deepEqual([fractionalSnapshot.currency_code,Number(fractionalSnapshot.currency_scale),Number(fractionalSnapshot.subtotal_minor),Number(fractionalSnapshot.discount_minor),Number(fractionalSnapshot.final_total_minor),fractionalSnapshot.discount_source,fractionalSnapshot.winner_source_id],['RUB',2,1,1,0,'promotion',ids.fractionalPromotion]);
  const fractionalLines=(await db.query('SELECT order_item_id,gross_minor,discount_minor,net_minor,eligible FROM pos_order_pricing_snapshot_lines WHERE snapshot_id=$1 ORDER BY order_item_id',[fractionalSnapshot.id])).rows;
  assert.equal(fractionalLines.length,2,'fractional snapshot includes both half-quantity source items');
  const sortedFractionalIds=[ids.fractionalItemA,ids.fractionalItemB].sort();
  assert.deepEqual(fractionalLines.map((line)=>line.order_item_id),sortedFractionalIds,'fractional source IDs are stable and ordered');
  assert.deepEqual(fractionalLines.map((line)=>[Number(line.gross_minor),Number(line.discount_minor),Number(line.net_minor)]),[[1,1,0],[0,0,0]],'fractional penny gross and full promotion discount go to the lower item ID');
  assert.ok(fractionalLines.every((line)=>line.eligible),'both product lines are frozen as promotion-eligible');
  assert.deepEqual(fractionalSnapshot.eligible_item_ids,sortedFractionalIds,'header stores the sorted selected eligible item IDs');

  await addOrder(ids.integrityOrder);
  const integritySource=(await db.query('SELECT oi.id,o.venue_id,oi.product_id,oi.quantity,oi.unit_price,oi.sales_employee_id,oi.sold_at,oi.station,p.name,p.category,p.is_active FROM order_items oi JOIN orders o ON o.id=oi.order_id JOIN products p ON p.id=oi.product_id WHERE oi.order_id=$1',[ids.integrityOrder])).rows[0];
  await db.query('BEGIN');
  let mismatchedSourceFailed=false;
  try {
    const integrityHeader=(await db.query(`INSERT INTO pos_order_pricing_snapshots(venue_id,order_id,sold_at,subtotal_minor,discount_minor,minimum_adjustment_minor,final_total_minor,discount_source)
      VALUES($1,$2,now(),50000,0,0,50000,'none') RETURNING id`,[ids.venue,ids.integrityOrder])).rows[0];
    await db.query(`INSERT INTO pos_order_pricing_snapshot_lines(venue_id,snapshot_id,order_id,order_item_id,seller_id,sold_at,quantity,unit_price,gross_minor,discount_minor,net_minor,eligible,product_facts)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,50000,0,50000,false,$9::jsonb)`,[ids.venue,integrityHeader.id,ids.integrityOrder,integritySource.id,integritySource.sales_employee_id,integritySource.sold_at,Number(integritySource.quantity)+1,integritySource.unit_price,JSON.stringify({productId:integritySource.product_id,productName:integritySource.name,category:integritySource.category,station:integritySource.station,productActive:integritySource.is_active})]);
    await db.query('COMMIT');
  } catch(error) { mismatchedSourceFailed=error.code==='23514'; await db.query('ROLLBACK').catch(()=>{}); }
  assert.equal(mismatchedSourceFailed,true,'snapshot line insert rejects source quantity facts that disagree with order_items');
  await db.query('BEGIN');
  let headerOnlyFailed=false;
  try {
    await db.query(`INSERT INTO pos_order_pricing_snapshots(venue_id,order_id,sold_at,subtotal_minor,discount_minor,minimum_adjustment_minor,final_total_minor,discount_source)
      VALUES($1,$2,now(),50000,0,0,50000,'none')`,[ids.venue,ids.integrityOrder]);
    await db.query('COMMIT');
  } catch(error) { headerOnlyFailed=error.code==='23514'; await db.query('ROLLBACK').catch(()=>{}); }
  assert.equal(headerOnlyFailed,true,'deferred header integrity check rejects a header without all source lines');

  await db.query("INSERT INTO orders(id,venue_id,opened_by,status,pricing_locked_at,pricing_version,subtotal_snapshot,discount_total_snapshot,minimum_adjustment_snapshot,final_total_snapshot,closed_at) VALUES($1,$2,$3,'closed',now(),1,500,0,0,500,now())",[ids.legacySnapshotOrder,ids.venue,ids.bartender]);
  await db.query("INSERT INTO order_items(order_id,product_id,quantity,unit_price,station) VALUES($1,$2,1,500,'bar')",[ids.legacySnapshotOrder,ids.product]);
  const legacyView=(await browserApi(bartender,'/api/orders?scope=all')).body.items.find((entry)=>entry.id===ids.legacySnapshotOrder);
  assert.equal(legacyView?.lineSnapshotStatus,'unknown','legacy locked order remains explicitly unknown');
  assert.equal(legacyView?.items?.[0]?.pricingSnapshotStatus,'unknown','legacy rows do not receive fabricated line snapshots');
  const financeDate=(await db.query("SELECT (now() AT TIME ZONE 'Asia/Yekaterinburg')::date::text AS date")).rows[0].date;
  const financeSnapshotRead=await browserApi(manager,`/api/finance/summary?date=${financeDate}`);
  assert.equal(financeSnapshotRead.status,200,'finance summary is available after canonical snapshot writes');
  const expectedFinance=(await db.query(`SELECT COALESCE(SUM(COALESCE(s.subtotal_minor/100.0,o.subtotal_snapshot)),0) AS gross,
    COALESCE(SUM(COALESCE(s.discount_minor/100.0,o.discount_total_snapshot)),0) AS discounts,
    COALESCE(SUM(COALESCE(s.final_total_minor/100.0,o.final_total_snapshot)),0) AS net,
    count(*) FILTER(WHERE s.id IS NULL)::int AS unknown_count
    FROM orders o LEFT JOIN pos_order_pricing_snapshots s ON s.venue_id=o.venue_id AND s.order_id=o.id
    WHERE o.venue_id=$1 AND o.status='closed' AND o.closed_at >= ($2::date::timestamp AT TIME ZONE 'Asia/Yekaterinburg') AND o.closed_at < (($2::date+1)::timestamp AT TIME ZONE 'Asia/Yekaterinburg')`,[ids.venue,financeDate])).rows[0];
  assert.deepEqual([Number(financeSnapshotRead.body.sales.gross),Number(financeSnapshotRead.body.sales.discounts),Number(financeSnapshotRead.body.sales.net),Number(financeSnapshotRead.body.sales.unsnapshottedOrders)],[Number(expectedFinance.gross),Number(expectedFinance.discounts),Number(expectedFinance.net),Number(expectedFinance.unknown_count)],'finance totals prefer canonical snapshots and retain frozen legacy order-level totals while exposing unknown lines');
  await db.query("INSERT INTO orders(id,venue_id,opened_by,status) VALUES($1,$2,$3,'open')",[ids.tenantOrder,ids.otherVenue,ids.manager]);
  assert.equal((await browserApi(bartender,`/api/orders/${ids.tenantOrder}/payments`)).status,404,'another venue order is not readable through this venue session');
  await assert.rejects(db.query(`INSERT INTO pos_order_pricing_snapshot_lines(venue_id,snapshot_id,order_id,order_item_id,quantity,unit_price,gross_minor,discount_minor,net_minor)
    SELECT $1,id,$2,$3,1,0,0,0,0 FROM pos_order_pricing_snapshots WHERE order_id=$4`,[ids.otherVenue,ids.tenantOrder,randomUUID(),ids.directCloseOrder]),(error)=>error.code==='23514'||error.code==='23503','source and composite constraints reject cross-tenant snapshot evidence');

  const closePreview = await browserApi(bartender, '/api/shifts');
  assert.equal(closePreview.status, 200);
  const shiftExpected = Number(closePreview.body.current.expectedCash);
  assert.ok(Number.isFinite(shiftExpected), `the final shift has a usable cash preview: ${JSON.stringify(closePreview.body.current)}`);
  await bartender.locator('#shift-toggle').click();
  await bartender.locator('#staff-action-modal.open').waitFor();
  const expectedLabel = new Intl.NumberFormat('ru-RU',{minimumFractionDigits:2,maximumFractionDigits:2}).format(shiftExpected);
  assert.ok((await bartender.locator('#staff-action-description').innerText()).includes(`${expectedLabel} ₽`),
    'the close modal refreshes and displays the current expected amount after POS operations');
  await bartender.locator('input[name="closingCash"]').fill(String(shiftExpected));
  const closeChecklist = bartender.locator('#staff-action-fields input[type="checkbox"]');
  assert.equal(await closeChecklist.count(), 4, 'the staff dialog shows every required shift-close attestation');
  assert.deepEqual(await closeChecklist.evaluateAll((inputs) => inputs.map((input) => ({ name: input.name, required: input.required, checked: input.checked }))), [
    { name: 'ordersReviewed', required: true, checked: false },
    { name: 'cashCounted', required: true, checked: false },
    { name: 'inventoryReviewed', required: true, checked: false },
    { name: 'externalFiscalReportsHandled', required: true, checked: false },
  ], 'the dialog starts with a separate required, unchecked attestation for each item');
  await bartender.locator('#staff-action-submit').click();
  await bartender.locator('#staff-action-modal.open').waitFor();
  for (const input of await closeChecklist.all()) await input.check();
  const shiftCloseResponse = bartender.waitForResponse((response) => response.request().method() === 'POST' && response.url().endsWith(`/api/shifts/${ids.shift}/close`));
  await bartender.locator('#staff-action-submit').click();
  const shiftClose = await shiftCloseResponse;
  assert.equal(shiftClose.status(),200,`the staff dialog closes the shift through the real API: ${await shiftClose.text()}`);
  await bartender.locator('#staff-notice').filter({ hasText: 'Смена закрыта. Ожидалось:' }).waitFor();
  assert.match(await bartender.locator('#staff-notice').innerText(), /фактически:.*разница: \+?0,00 ₽/,
    'the real staff UI reports the persisted expected, counted, and variance amounts');
  const closedShift = (await db.query('SELECT closed_at,expected_cash,closing_cash,cash_variance FROM shifts WHERE id=$1',[ids.shift])).rows[0];
  assert.ok(closedShift.closed_at);
  assert.equal(Number(closedShift.expected_cash),shiftExpected,'the cash preview matches the final locked ledger reconciliation');
  assert.equal(Number(closedShift.closing_cash),shiftExpected);
  assert.equal(Number(closedShift.cash_variance),0);

  assert.deepEqual(errors, [], `warehouse/POS browser exceptions: ${errors.join('; ')}`);
  passed = true;
} finally {
  await browser?.close();
  if (server && server.exitCode === null && server.signalCode === null) server.kill();
  if (serverExit && server?.exitCode === null && server?.signalCode === null) await Promise.race([serverExit, delay(3000)]);
  // This suite runs only in a runner-created disposable database. Keep production-style immutable
  // ledger rows intact here; the owning regression runner drops the whole isolated database on exit.
  if (connected) await db.end();
}
if (passed) console.log('POS ROLE PAYMENT POSTGRES BROWSER QA: PASS (opening cash entered and read back in staff UI, payment, cash preview/close, persisted variance, immutable line pricing snapshot, concurrency, replay, tenant isolation, legacy unknown, disposable database teardown)');
