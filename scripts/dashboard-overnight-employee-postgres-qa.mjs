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
const root = fileURLToPath(new URL('../', import.meta.url));
const shots = path.join(root, 'qa-artifacts', 'dashboard-stage71');
const ids = { organization: randomUUID(), venue: randomUUID(), employee: randomUUID(), other: randomUUID(), manager: randomUUID(), fullAdmin: randomUUID(), limitedAdmin: randomUUID(), settingsAdmin: randomUUID(), reservationsAdmin: randomUUID(), inventoryAdmin: randomUUID(), financeInventoryAdmin: randomUUID(), ordersAdmin: randomUUID(), shift: randomUUID(), order: randomUUID(), otherOrder: randomUUID(), autoOrder: randomUUID(), deletedAudit: randomUUID() };
const password = `qa-${randomUUID()}`;
const salt = randomBytes(16).toString('hex');
const passwordHash = `scrypt$${salt}$${scryptSync(password, salt, 64).toString('hex')}`;
const login = `overnight-employee-${ids.venue}`;
let server, serverExit, browser, connected = false, fixtureCreated = false, output = '', base = '';

const read = async (route, token) => {
  const response = await fetch(`${base}${route}`, { headers: { Authorization: `Bearer ${token}` } });
  const body = await response.json().catch(() => ({}));
  assert.equal(response.status, 200, `${route}: ${JSON.stringify(body)}`);
  return body;
};

try {
  await db.connect(); connected = true;
  const identity = (await db.query(`SELECT current_database() AS database, inet_server_addr()::text AS address,
    inet_server_port() AS port, (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser`)).rows[0];
  assertQaDatabaseIdentity(identity, target.database, Number(target.url.port || 5432), 'Dashboard overnight employee QA database');
  await db.query('BEGIN');
  try {
    await db.query("INSERT INTO organizations (id,name,slug) VALUES ($1,'Overnight dashboard QA',$2)", [ids.organization, `overnight-dashboard-${ids.organization}`]);
    await db.query("INSERT INTO venues (id,organization_id,name,timezone) VALUES ($1,$2,'Overnight dashboard QA','Asia/Yekaterinburg')", [ids.venue, ids.organization]);
    await db.query("INSERT INTO users (id,organization_id,venue_id,full_name,login,password_hash,role) VALUES ($1,$4,$5,'QA Bartender',$6,$9,'bartender'),($2,$4,$5,'QA Other',$7,$9,'bartender'),($3,$4,$5,'QA Manager',$8,$9,'manager')",
      [ids.employee, ids.other, ids.manager, ids.organization, ids.venue, login, `overnight-other-${ids.venue}`, `overnight-manager-${ids.venue}`, passwordHash]);
    await db.query("INSERT INTO users (id,organization_id,venue_id,full_name,login,password_hash,role,permission_scopes) VALUES ($1,$2,$3,'QA Limited Admin',$4,$5,'admin',$6::jsonb)", [ids.limitedAdmin, ids.organization, ids.venue, `overnight-limited-admin-${ids.venue}`, passwordHash, '["finance"]']);
    await db.query("INSERT INTO users (id,organization_id,venue_id,full_name,login,password_hash,role,permission_scopes) VALUES ($1,$2,$3,'QA Settings Admin',$4,$5,'admin',$6::jsonb),($7,$2,$3,'QA Reservations Admin',$8,$5,'admin',$9::jsonb)", [ids.settingsAdmin, ids.organization, ids.venue, `overnight-settings-admin-${ids.venue}`, passwordHash, '["settings"]', ids.reservationsAdmin, `overnight-reservations-admin-${ids.venue}`, '["reservations"]']);
    await db.query("INSERT INTO users (id,organization_id,venue_id,full_name,login,password_hash,role,permission_scopes) VALUES ($1,$2,$3,'QA Inventory Admin',$4,$5,'admin',$6::jsonb),($7,$2,$3,'QA Finance Inventory Admin',$8,$5,'admin',$9::jsonb)", [ids.inventoryAdmin, ids.organization, ids.venue, `overnight-inventory-admin-${ids.venue}`, passwordHash, '["inventory"]', ids.financeInventoryAdmin, `overnight-finance-inventory-admin-${ids.venue}`, '["finance","inventory"]']);
    await db.query("INSERT INTO users (id,organization_id,venue_id,full_name,login,password_hash,role,permission_scopes) VALUES ($1,$2,$3,'QA Orders Admin',$4,$5,'admin','[\"orders\"]'::jsonb)", [ids.ordersAdmin, ids.organization, ids.venue, `overnight-orders-admin-${ids.venue}`, passwordHash]);
    await db.query("INSERT INTO users (id,organization_id,venue_id,full_name,login,password_hash,role,permission_scopes) VALUES ($1,$2,$3,'QA Full Admin',$4,$5,'admin','[]'::jsonb)", [ids.fullAdmin, ids.organization, ids.venue, `overnight-full-admin-${ids.venue}`, passwordHash]);
    await db.query("INSERT INTO organization_memberships (organization_id,user_id,membership_role,status) VALUES ($1,$2,'member','active'),($1,$3,'member','active'),($1,$4,'member','active'),($1,$5,'member','active'),($1,$6,'member','active'),($1,$7,'member','active'),($1,$8,'member','active'),($1,$9,'member','active'),($1,$10,'member','active'),($1,$11,'member','active')", [ids.organization, ids.employee, ids.other, ids.manager, ids.limitedAdmin, ids.settingsAdmin, ids.reservationsAdmin, ids.inventoryAdmin, ids.financeInventoryAdmin, ids.fullAdmin, ids.ordersAdmin]);
    await db.query("INSERT INTO shifts (id,venue_id,opened_by,opened_at,opening_cash) VALUES ($1,$2,$3,(date_trunc('day',now() AT TIME ZONE 'Asia/Yekaterinburg')-interval '1 hour') AT TIME ZONE 'Asia/Yekaterinburg',0)", [ids.shift, ids.venue, ids.manager]);
    await db.query("INSERT INTO orders (id,venue_id,opened_by,status,closed_at,closed_in_shift_id) VALUES ($1,$3,$4,'closed',now(),$5),($2,$3,$6,'closed',now(),$5)", [ids.order, ids.otherOrder, ids.venue, ids.employee, ids.shift, ids.other]);
    await db.query("INSERT INTO payments (order_id,method,amount,status,shift_id,created_at) VALUES ($1,'cash',40,'paid',$3,(date_trunc('day',now() AT TIME ZONE 'Asia/Yekaterinburg')-interval '30 minutes') AT TIME ZONE 'Asia/Yekaterinburg'),($1,'card',60,'paid',$3,now()),($2,'cash',70,'paid',$3,now())", [ids.order, ids.otherOrder, ids.shift]);
    await db.query("INSERT INTO inventory_auto_orders (id,venue_id,status,total_estimate,requested_by) VALUES ($1,$2,'sent',123,$3)", [ids.autoOrder, ids.venue, ids.manager]);
    await db.query("INSERT INTO audit_events (id,venue_id,actor_id,action,entity_type,entity_id,after_data) VALUES ($1,$2,$3,'order.deleted','order',$4,$5::jsonb)", [ids.deletedAudit, ids.venue, ids.manager, ids.otherOrder, JSON.stringify({ totalCost: 456, deletedItems: [{ name: 'QA', unitCost: 456 }], comment: 'QA delete' })]);
    await db.query('COMMIT'); fixtureCreated = true;
  } catch (error) { await db.query('ROLLBACK'); throw error; }

  server = spawn(process.execPath, ['server.js'], { cwd: root, windowsHide: true,
    env: { ...process.env, DATABASE_URL: databaseUrl, VENUE_ID: ids.venue, AUTH_REQUIRED: 'true', COOKIE_SECURE: 'false', DEMO_MODE: 'false', NODE_ENV: 'test', HOST: '127.0.0.1', PORT: '0', API_RATE_LIMIT: '5000' }, stdio: ['ignore', 'pipe', 'pipe'] });
  serverExit = new Promise((resolve) => server.once('exit', resolve));
  server.stdout.on('data', (chunk) => { output += chunk; });
  server.stderr.on('data', (chunk) => { output += chunk; });
  const deadline = Date.now() + 20000;
  while (!base && Date.now() < deadline) {
    const match = output.match(/CRM running on http:\/\/localhost:(\d+)/);
    if (match) base = `http://127.0.0.1:${match[1]}`;
    else if (server.exitCode !== null) throw new Error(`QA server exited: ${output}`);
    else await delay(50);
  }
  assert.ok(base, `QA server started: ${output}`);
  const authResponse = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: login, password }) });
  const auth = await authResponse.json();
  assert.equal(authResponse.status, 200, JSON.stringify(auth));
  const employeeNotifications = await fetch(`${base}/api/notifications`, { headers: { Authorization: `Bearer ${auth.token}` } });
  assert.equal(employeeNotifications.status, 403, 'operational employee cannot read manager notifications');
  const scopedTokens = new Map();
  for (const scopeCase of [
    { login: `overnight-limited-admin-${ids.venue}`, finance: true, inventory: false },
    { login: `overnight-settings-admin-${ids.venue}`, finance: false, inventory: false },
    { login: `overnight-reservations-admin-${ids.venue}`, finance: false, inventory: false },
    { login: `overnight-inventory-admin-${ids.venue}`, finance: false, inventory: true },
    { login: `overnight-finance-inventory-admin-${ids.venue}`, finance: true, inventory: true },
    { login: `overnight-orders-admin-${ids.venue}`, finance: false, inventory: false },
    { login: `overnight-full-admin-${ids.venue}`, finance: true, inventory: true },
    { login: `overnight-manager-${ids.venue}`, finance: true, inventory: true },
  ]) {
    const loginResult = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: scopeCase.login, password }) });
    const roleAuth = await loginResult.json();
    assert.equal(loginResult.status, 200, `${scopeCase.login}: ${JSON.stringify(roleAuth)}`);
    scopedTokens.set(scopeCase.login, roleAuth.token);
    assert.equal(roleAuth.permissions.includes('finance_read'), scopeCase.finance, `${scopeCase.login} login finance_read matches its scope`);
    assert.equal(roleAuth.permissions.includes('inventory_read'), scopeCase.inventory, `${scopeCase.login} login inventory_read matches its scope`);
    const session = await read('/api/session', roleAuth.token);
    assert.equal(session.permissions.includes('finance_read'), scopeCase.finance, `${scopeCase.login} finance_read matches its scope`);
    assert.equal(session.permissions.includes('inventory_read'), scopeCase.inventory, `${scopeCase.login} inventory_read matches its scope`);
    const canManageShift = session.permissions.includes('floor') || session.permissions.includes('orders');
    const shiftResponse = await fetch(`${base}/api/shifts`, { headers: { Authorization: `Bearer ${roleAuth.token}` } });
    assert.equal(shiftResponse.status, scopeCase.finance || canManageShift ? 200 : 403, `${scopeCase.login} shift history respects scope`);
    if (shiftResponse.status === 200) {
      const shiftData = await shiftResponse.json();
      assert.equal(Boolean(shiftData.current), true, `${scopeCase.login} sees current shift`);
      assert.equal(Object.hasOwn(shiftData.current, 'expectedCash'), scopeCase.finance, `${scopeCase.login} reconciliation requires finance read`);
      if (!scopeCase.finance) {
        assert.equal(shiftData.items.length, 1, `${scopeCase.login} sees only the active POS shift`);
        assert.deepEqual(Object.keys(shiftData.current).sort(), ['closedAt', 'id', 'openedAt', 'openingCash'], `${scopeCase.login} sees only operational cash start, without history or reconciliation`);
      }
    }
    if (!canManageShift) {
      const shiftWrite = await fetch(`${base}/api/shifts`, { method: 'POST', headers: { Authorization: `Bearer ${roleAuth.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ openingCash: 100 }) });
      assert.equal(shiftWrite.status, 403, `${scopeCase.login} cannot open cash shift without orders scope`);
    }
    const visibleMetrics = await read('/api/metrics', roleAuth.token);
    const metricPermissions = {
      openOrders: 'orders', pendingOrders: 'orders', closedOrders: 'orders',
      pendingRevenue: 'finance_read', discountRequests: 'finance_read',
      staffActive: 'staff_view', reservationsToday: 'reservations', lowStock: 'inventory_read'
    };
    for (const [field, permission] of Object.entries(metricPermissions)) {
      const allowed = session.permissions.includes(permission) || (field === 'staffActive' && session.permissions.includes('staff'));
      assert.equal(Object.hasOwn(visibleMetrics, field), allowed, `${scopeCase.login} metrics.${field} respects ${permission}`);
    }
    const notificationResponse = await fetch(`${base}/api/notifications`, { headers: { Authorization: `Bearer ${roleAuth.token}` } });
    const canReadNotifications = ['staff_view', 'staff', 'inventory_read', 'orders'].some((permission) => session.permissions.includes(permission));
    assert.equal(notificationResponse.status, canReadNotifications ? 200 : 403, `${scopeCase.login} notifications gate respects scope`);
    if (canReadNotifications) {
      const notificationData = await notificationResponse.json();
      const types = notificationData.items.map((item) => item.type);
      assert.equal(types.includes('inventory_auto_order'), scopeCase.inventory, `${scopeCase.login} inventory notification respects scope`);
      assert.equal(types.includes('order_deleted'), session.permissions.includes('orders'), `${scopeCase.login} deleted-order notification respects scope`);
      const deleted = notificationData.items.find((item) => item.type === 'order_deleted');
      if (deleted) {
        const canReadCosts = scopeCase.finance || scopeCase.inventory;
        assert.equal(Object.hasOwn(deleted, 'totalCost'), canReadCosts, `${scopeCase.login} deletion cost respects scope`);
        assert.equal(Object.hasOwn(deleted, 'deletedItems'), canReadCosts, `${scopeCase.login} deletion item cost respects scope`);
      }
    }
    for (const [route, expected] of [
      ['/api/finance/summary', scopeCase.finance], ['/api/analytics', scopeCase.finance], ['/api/expenses', scopeCase.finance],
      ['/api/inventory', scopeCase.inventory], ['/api/inventory/auto-orders', scopeCase.inventory],
    ]) {
      const response = await fetch(`${base}${route}`, { headers: { Authorization: `Bearer ${roleAuth.token}` } });
      assert.equal(response.status, expected ? 200 : 403, `${scopeCase.login} ${route} respects direct API permission`);
    }
  }
  const fullAdminToken = scopedTokens.get(`overnight-full-admin-${ids.venue}`);
  await db.query("UPDATE users SET permission_scopes='[\"settings\"]'::jsonb WHERE id=$1", [ids.fullAdmin]);
  const narrowedSession = await read('/api/session', fullAdminToken);
  assert.equal(narrowedSession.permissions.includes('finance_read'), false, 'existing admin session immediately loses revoked finance read');
  assert.equal(narrowedSession.permissions.includes('inventory_read'), false, 'existing admin session immediately loses revoked inventory read');
  const revokedFinance = await fetch(`${base}/api/finance/summary`, { headers: { Authorization: `Bearer ${fullAdminToken}` } });
  assert.equal(revokedFinance.status, 403, 'old token cannot retain a revoked read permission');
  await db.query("UPDATE users SET permission_scopes='[]'::jsonb WHERE id=$1", [ids.fullAdmin]);
  const restoredSession = await read('/api/session', fullAdminToken);
  assert.equal(restoredSession.permissions.includes('finance_read'), true, 'full admin access returns after scope reset');
  const restoredFinance = await fetch(`${base}/api/finance/summary`, { headers: { Authorization: `Bearer ${fullAdminToken}` } });
  assert.equal(restoredFinance.status, 200, 'old token regains an authorized finance read after scope reset');
  const today = await read('/api/dashboard/shift-kpis', auth.token);
  assert.equal(today.employeeView, true);
  assert.equal(Number(today.totals.revenue), 60, 'employee today includes post-midnight payment from prior-day shift');
  assert.equal(Number(today.totals.paymentCount), 1, 'prior-day payment and colleague payment are excluded');
  assert.equal(Number(today.totals.closedOrders), 1, 'own order closed today is counted');
  assert.equal(Number(today.totals.cashless), 60);
  assert.deepEqual(today.shifts, [{ id: 'employee-today' }], 'employee sees no shift identity or reconciliation metadata');
  const financeToday = await read('/api/finance/summary', auth.token);
  assert.equal(Number(financeToday.revenue), 60, 'employee finance headline uses own payments made today');
  assert.equal(financeToday.employeeView, true);
  assert.equal(financeToday.byPaymentMethod, undefined, 'employee receives no venue-wide payment breakdown');
  const tampered = await read(`/api/dashboard/shift-kpis?date=1999-01-01&shiftId=${ids.shift}`, auth.token);
  assert.equal(Number(tampered.totals.revenue), 60, 'employee cannot alter current-day scope');
  assert.deepEqual(tampered.shifts, [{ id: 'employee-today' }]);

  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 375, height: 812 }, locale: 'ru-RU' });
  const auditReads = [];
  const staffReads = [];
  page.on('request', (request) => { if (new URL(request.url()).pathname === '/api/audit') auditReads.push(request.url()); });
  page.on('request', (request) => { if (new URL(request.url()).pathname === '/api/staff') staffReads.push(request.url()); });
  await page.goto(`${base}/login`, { waitUntil: 'networkidle' });
  await page.locator('#login-username').fill(login);
  await page.locator('#login-password').fill(password);
  await page.locator('#login-form button[type="submit"]').click();
  await page.waitForURL((url) => !url.pathname.includes('/login'));
  await page.goto(`${base}/admin`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => /60/.test(document.querySelector('#dashboard-shift-kpis')?.textContent || ''));
  assert.match(await page.locator('#dashboard-shift-kpis').innerText(), /60\s*₽/);
  assert.equal(await page.locator('#dash-revenue').innerText(), '60 ₽', 'dashboard finance headline matches today payments');
  assert.equal(await page.locator('.dashboard-revenue-main > span').innerText(), 'Ваши оплаты сегодня');
  assert.equal(await page.locator('.dashboard-revenue-main > small').innerText(), 'Платежи по вашим заказам сегодня');
  assert.match(await page.locator('#dashboard-shift-context').innerText(), /Ваши показатели за сегодня/);
  assert.equal(await page.locator('#dashboard-shift-date').isDisabled(), true);
  assert.equal(await page.locator('#dashboard-shift-select').isDisabled(), true);
  assert.equal(await page.locator('[data-kpi-route="/reservations"]').count(), 0, 'employee has no inaccessible reservation KPI');
  assert.equal(await page.locator('[data-kpi-route="/inventory"]').count(), 0, 'employee has no inaccessible inventory KPI');
  assert.equal(await page.locator('.quick-actions a[href="/reservations"], .quick-actions a[href="/inventory"]').count(), 0, 'employee quick actions contain only available routes');
  assert.equal(await page.locator('.quick-actions a[href="/finance"], .quick-actions a[href="/finance/report"]').count(), 2, 'employee retains permitted finance routes');
  assert.equal(await page.locator('.dashboard-page-actions a[href="/admin#settings"]').count(), 0, 'employee has no inaccessible settings action');
  assert.deepEqual(auditReads, [], 'employee dashboard does not request administrator audit journal');
  assert.deepEqual(staffReads, [], 'employee dashboard does not request restricted staff directory');
  assert.equal(await page.locator('#audit').count(), 0, 'administrator audit panel is absent for employee');
  assert.equal(await page.locator('#staff').count(), 0, 'restricted staff panel is absent for employee');
  assert.equal(await page.getByText('Не удалось загрузить журнал аудита').count(), 0, 'employee sees no expected permission-error toast');
  assert.equal(await page.getByText('Не удалось обновить список сотрудников').count(), 0, 'employee sees no expected staff permission-error toast');
  await mkdir(shots, { recursive: true });
  for (const width of [375, 902, 1440]) {
    await page.setViewportSize({ width, height: 812 });
    await page.locator('#dashboard-insights').evaluate((node) => node.scrollIntoView({ block: 'center' }));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false, `${width} px dashboard has no horizontal page overflow`);
    assert.match(await page.locator('#dashboard-shift-kpis').innerText(), /60\s*₽/, `${width} px dashboard retains today's revenue`);
    if (width === 1440) assert.equal(await page.locator('.dashboard-kpi-grid').evaluate((grid) => {
      const last = grid.lastElementChild?.getBoundingClientRect();
      return Boolean(last && Math.abs(last.right - grid.getBoundingClientRect().right) <= 2);
    }), true, 'permitted KPI cards fill the desktop row');
    await page.locator('#dashboard-insights').screenshot({ path: path.join(shots, `employee-overnight-${width}.png`) });
    await page.locator('.dashboard-kpi-grid').screenshot({ path: path.join(shots, `employee-kpis-${width}.png`) });
    await page.locator('[data-dashboard-module="quick"]').screenshot({ path: path.join(shots, `employee-actions-${width}.png`) });
  }
  await page.goto(`${base}/admin#staff`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => location.hash === '');
  assert.equal(new URL(page.url()).hash, '', 'forbidden direct staff link returns to dashboard');
  assert.equal(await page.locator('#staff').count(), 0);
  assert.deepEqual(staffReads, [], 'direct staff link sends no restricted directory request');
  for (const roleCase of [
    { login: `overnight-manager-${ids.venue}`, revenue: 1, orders: 1, reservations: 1, inventory: 1, settings: 1, quick: 4, insights: 1, audit: 1, shift: 1 },
    { login: `overnight-limited-admin-${ids.venue}`, revenue: 1, orders: 0, reservations: 0, inventory: 0, settings: 0, quick: 2, insights: 1, audit: 0, shift: 1 },
    { login: `overnight-settings-admin-${ids.venue}`, revenue: 0, orders: 0, reservations: 0, inventory: 0, settings: 1, quick: 0, insights: 0, audit: 1, shift: 0 },
    { login: `overnight-reservations-admin-${ids.venue}`, revenue: 0, orders: 0, reservations: 1, inventory: 0, settings: 0, quick: 1, insights: 0, audit: 0, shift: 0 },
    { login: `overnight-orders-admin-${ids.venue}`, revenue: 0, orders: 1, reservations: 0, inventory: 0, settings: 0, quick: 1, insights: 0, audit: 0, shift: 1 },
  ]) {
    const rolePage = await browser.newPage({ viewport: { width: 902, height: 812 }, locale: 'ru-RU' });
    const roleRequests = [];
    rolePage.on('request', (request) => roleRequests.push(new URL(request.url()).pathname));
    await rolePage.goto(`${base}/login`, { waitUntil: 'networkidle' });
    await rolePage.locator('#login-username').fill(roleCase.login);
    await rolePage.locator('#login-password').fill(password);
    await rolePage.locator('#login-form button[type="submit"]').click();
    await rolePage.waitForURL((url) => !url.pathname.includes('/login'));
    await rolePage.goto(`${base}/admin`, { waitUntil: 'networkidle' });
    assert.equal(await rolePage.locator('[data-dashboard-revenue]').count(), roleCase.revenue);
    assert.equal(await rolePage.locator('[data-kpi-route="/"]').count(), roleCase.orders);
    assert.equal(await rolePage.locator('[data-kpi-route="/reservations"]').count(), roleCase.reservations, `${roleCase.login} reservation KPI matches permission`);
    assert.equal(await rolePage.locator('[data-kpi-route="/inventory"]').count(), roleCase.inventory, `${roleCase.login} inventory KPI matches permission`);
    assert.equal(await rolePage.locator('.quick-actions a[href="/reservations"]').count(), roleCase.reservations);
    assert.equal(await rolePage.locator('.quick-actions a[href="/inventory"]').count(), roleCase.inventory);
    assert.equal(await rolePage.locator('.dashboard-page-actions a[href="/admin#settings"]').count(), roleCase.settings);
    assert.equal(await rolePage.locator('.quick-actions a').count(), roleCase.quick);
    assert.equal(await rolePage.locator('#dashboard-insights').count(), roleCase.insights);
    assert.equal(await rolePage.locator('#audit').count(), roleCase.audit);
    assert.equal(await rolePage.locator('#shift-control').count(), roleCase.shift, `${roleCase.login} shift panel matches permission`);
    if (!roleCase.shift) assert.equal(roleRequests.filter((pathname) => pathname === '/api/shifts').length, 0, 'role without shift permission sends no shift request');
    if (roleCase.login === `overnight-limited-admin-${ids.venue}`) assert.equal(await rolePage.locator('#shift-actions button').count(), 0, 'finance-only admin reads shift but cannot change it');
    const expectedNotificationRoutes = [roleCase.revenue ? '/api/discount-requests' : null, roleCase.inventory ? '/api/inventory/auto-orders' : null, roleCase.orders || roleCase.inventory ? '/api/notifications' : null].filter(Boolean);
    for (const notificationRoute of ['/api/discount-requests', '/api/inventory/auto-orders', '/api/notifications']) {
      if (!expectedNotificationRoutes.includes(notificationRoute)) assert.equal(roleRequests.filter((pathname) => pathname === notificationRoute).length, 0, `${roleCase.login} does not request forbidden ${notificationRoute}`);
    }
    if (!expectedNotificationRoutes.length) assert.equal(await rolePage.locator('#notification-bell').isHidden(), true, `${roleCase.login} has no inactive notification bell`);
    if (!roleCase.revenue) assert.equal(roleRequests.filter((pathname) => pathname === '/api/finance/summary').length, 0, 'finance-less role sends no summary request');
    if (!roleCase.insights) assert.equal(roleRequests.filter((pathname) => pathname === '/api/dashboard/shift-kpis').length, 0, 'finance-less role sends no shift KPI request');
    if (!roleCase.audit) assert.equal(roleRequests.filter((pathname) => pathname === '/api/audit').length, 0, 'restricted role sends no audit request');
    for (const width of [375, 902, 1440]) {
      await rolePage.setViewportSize({ width, height: 812 });
      assert.equal(await rolePage.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `${roleCase.login} dashboard fits ${width} px`);
    }
    if (roleCase.login === `overnight-manager-${ids.venue}`) {
      await rolePage.goto(`${base}/finance`, { waitUntil: 'networkidle' });
      assert.equal(await rolePage.locator('[data-kpi-route="/"]').count(), 1, 'manager retains order navigation from finance');
      assert.equal(await rolePage.locator('[data-kpi-route="/"]').getAttribute('tabindex'), '0');
    }
    if (roleCase.login === `overnight-limited-admin-${ids.venue}`) {
      await rolePage.goto(`${base}/finance`, { waitUntil: 'networkidle' });
      assert.equal(await rolePage.locator('[data-kpi-route="/"]').count(), 0, 'finance-only admin sees no inaccessible order KPI');
      const orderCard = rolePage.locator('#finance-orders').locator('xpath=..');
      assert.equal(await orderCard.count(), 1, 'orders total remains available as read-only finance information');
      assert.equal(await orderCard.getAttribute('role'), null, 'read-only finance orders KPI is not a button');
      assert.equal(await orderCard.getAttribute('tabindex'), null, 'read-only finance orders KPI is skipped in keyboard navigation');
    }
    if (roleCase.login === `overnight-settings-admin-${ids.venue}`) {
      await rolePage.goto(`${base}/reservations`, { waitUntil: 'domcontentloaded' });
      await rolePage.waitForURL((url) => url.pathname === '/admin', { timeout: 5000 });
      assert.equal(new URL(rolePage.url()).pathname, '/admin', 'forbidden route returns to accessible dashboard');
      await rolePage.goto(`${base}/finance`, { waitUntil: 'domcontentloaded' });
      await rolePage.waitForURL((url) => url.pathname === '/admin', { timeout: 5000 });
      assert.equal(new URL(rolePage.url()).pathname, '/admin', 'forbidden finance route does not redirect-loop');
    }
    await rolePage.close();
  }
  console.log('DASHBOARD/SCOPED ROLES POSTGRES QA: PASS (venue-local employee day, finance/inventory API scope matrix, role navigation, 375/902/1440 px, cleanup)');
} finally {
  await browser?.close();
  if (server && server.exitCode === null && server.signalCode === null) server.kill();
  if (serverExit && server?.exitCode === null && server?.signalCode === null) await Promise.race([serverExit, delay(3000)]);
  if (connected) {
    if (fixtureCreated) {
      await db.query('BEGIN');
      try {
        await db.query('DELETE FROM auth_sessions WHERE user_id IN ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [ids.employee, ids.other, ids.manager, ids.limitedAdmin, ids.settingsAdmin, ids.reservationsAdmin, ids.inventoryAdmin, ids.financeInventoryAdmin, ids.fullAdmin, ids.ordersAdmin]);
        await db.query('DELETE FROM audit_events WHERE venue_id=$1', [ids.venue]);
        await db.query('DELETE FROM inventory_auto_orders WHERE venue_id=$1', [ids.venue]);
        await db.query('DELETE FROM payments WHERE order_id IN (SELECT id FROM orders WHERE venue_id=$1)', [ids.venue]);
        await db.query('DELETE FROM orders WHERE venue_id=$1', [ids.venue]);
        await db.query('DELETE FROM shifts WHERE venue_id=$1', [ids.venue]);
        await db.query('DELETE FROM organization_memberships WHERE organization_id=$1', [ids.organization]);
        await db.query('DELETE FROM users WHERE venue_id=$1', [ids.venue]);
        await db.query('DELETE FROM venues WHERE id=$1', [ids.venue]);
        await db.query('DELETE FROM organizations WHERE id=$1', [ids.organization]);
        await db.query('COMMIT');
      } catch (error) { await db.query('ROLLBACK'); throw error; }
      assert.equal(Number((await db.query('SELECT count(*) AS count FROM venues WHERE id=$1', [ids.venue])).rows[0].count), 0, 'QA venue removed');
    }
    await db.end();
  }
}
