import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const playwrightPath = process.env.PLAYWRIGHT_PACKAGE_PATH;
if (!playwrightPath) throw new Error('Set PLAYWRIGHT_PACKAGE_PATH');
const { chromium } = createRequire(import.meta.url)(playwrightPath);
const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const loginFor = (role) => `f_${role}_${Date.now().toString(36)}`;
const adminPassword = `qa-admin-${unique}`;
const ownerPassword = `qa-owner-${unique}`;
const staffPassword = 'qa-pass-123';
const child = spawn(process.execPath, ['server.js'], {
  cwd: fileURLToPath(new URL('../', import.meta.url)), windowsHide: true,
  env: { ...process.env, HOST: '127.0.0.1', PORT: '0', DATABASE_URL: '', AUTH_REQUIRED: 'true', DEMO_MODE: 'false', NODE_ENV: 'test', DEMO_ADMIN_PASSWORD: adminPassword, DEMO_OWNER_PASSWORD: ownerPassword },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stdout.on('data', (chunk) => { output += chunk; });
child.stderr.on('data', (chunk) => { output += chunk; });
const base = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`Finance role QA server did not start: ${output}`)), 15000);
  child.once('error', reject);
  child.stdout.on('data', () => { const match = output.match(/CRM running on http:\/\/localhost:(\d+)/); if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); } });
});
let browser;
try {
  const request = async (path, method = 'GET', token, body) => {
    const response = await fetch(`${base}${path}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, data: await response.json() };
  };
  const admin = await request('/api/login', 'POST', null, { username: 'admin', password: adminPassword });
  assert.equal(admin.status, 200);
  const owner = await request('/api/login', 'POST', null, { username: 'owner', password: ownerPassword });
  assert.equal(owner.status, 200);
  const logins = new Map();
  for (const role of ['bartender', 'manager']) {
    const login = loginFor(role);
    logins.set(role, login);
    const created = await request('/api/staff', 'POST', role === 'manager' ? owner.data.token : admin.data.token, { name: `Finance QA ${role}`, login, password: staffPassword, role, birthDate: '1990-01-01' });
    assert.equal(created.status, 201, `${role} account created: ${JSON.stringify(created.data)}`);
  }
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
  for (const role of ['bartender', 'manager']) {
    const context = await browser.newContext({ viewport: { width: 320, height: 800 }, locale: 'ru-RU' });
    try {
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(`${base}/login`, { waitUntil: 'networkidle' });
      await page.locator('#login-username').fill(logins.get(role));
      await page.locator('#login-password').fill(staffPassword);
      await page.locator('#login-form button[type="submit"]').click();
      await page.waitForURL((url) => !url.pathname.includes('/login'));
      const roleToken = await page.evaluate(() => localStorage.getItem('crm_session_token'));
      assert.ok(roleToken, `${role} has a browser session`);
      const authHeaders = { Authorization: `Bearer ${roleToken}` };
      const session = await page.request.get(`${base}/api/session`, { headers: authHeaders });
      assert.equal((await session.json()).user.role, role, 'API probes use the intended role');
      if (role === 'manager') {
        // A cached profile can retain a personal grant superseded by server role settings.
        await page.evaluate(() => {
          const user = JSON.parse(localStorage.getItem('crm_session_user'));
          user.permissionScopes = ['finance'];
          localStorage.setItem('crm_session_user', JSON.stringify(user));
        });
        await page.route('**/api/finance/purchase-payables*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [{ id: 'role-qa-payable', supplierName: 'QA supplier', documentNumber: 'QA-1', documentDate: '2026-09-01', totalCost: 100, totalPaid: 0, balanceDue: 100, paymentStatus: 'unpaid' }] }) }));
        await page.route('**/api/discount-requests*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [{ id: 'role-qa-discount', orderId: 'role-qa-order', type: 'percent', value: 10, reason: 'QA permission check', status: 'requested', requestedBy: 'QA' }] }) }));
      }
      await page.goto(`${base}/finance`, { waitUntil: 'networkidle' });
      await page.locator('#finance-revenue').waitFor();
      assert.equal(await page.locator('#payroll-create-toggle').count(), 0, `${role} cannot open payroll editor`);
      assert.equal(await page.locator('#payroll-register').count(), 0, `${role} cannot see payroll register`);
      assert.equal(await page.locator('#expense-form').count(), 0, `${role} cannot submit expenses`);
      if (role === 'bartender') {
        assert.equal(await page.locator('#expense-list, #finance-orders, #finance-chart, #payables-list').count(), 0, 'employee sees only own turnover');
        assert.match(await page.locator('.employee-turnover-panel').textContent(), /Оборот заказов, открытых вами/);
      } else {
        assert.match(await page.locator('#expense-list').textContent(), /финансовым ролям/);
        await page.locator('summary').filter({ hasText: 'Поставщики · расчёты по накладным' }).click();
        await page.locator('summary').filter({ hasText: 'Скидки · заявки' }).click();
        await page.locator('.payable-row').first().waitFor();
        await page.locator('.discount-row').first().waitFor();
        assert.match(await page.locator('#payables-list').textContent(), /QA supplier/);
        assert.match(await page.locator('#discount-list').textContent(), /QA permission check/);
        assert.equal(await page.locator('.payable-payment-form, .discount-approve, .discount-reject').count(), 0, 'manager has read-only finance actions');
      }
      const summary = await page.request.get(`${base}/api/finance/summary?date=2026-09-30`, { headers: authHeaders });
      assert.equal(summary.status(), 200, `${role} retains finance_read summary`);
      if (role === 'bartender') assert.deepEqual(Object.keys(await summary.json()).sort(), ['date', 'employeeView', 'revenue'], 'employee summary omits venue financial details');
      const report = await page.request.get(`${base}/api/finance/report?date=2026-09-30&type=waiter`, { headers: authHeaders });
      assert.equal(report.status(), 200, `${role} can read the finance report according to its view permission`);
      const reportData = await report.json();
      if (role === 'bartender') {
        assert.equal(reportData.employeeView, true, 'operational employee receives the restricted personal report');
        assert.equal(reportData.type, 'x', 'operational employee cannot request the staff breakdown report');
        assert.deepEqual(Object.keys(reportData).sort(), ['checksCount', 'date', 'employeeView', 'generatedAt', 'reportNumber', 'revenue', 'type'].sort(), 'employee report omits venue ledger details and staff breakdown');
      } else {
        assert.equal(reportData.type, 'waiter', 'finance_read manager can request the attributed staff report');
        assert.ok(reportData.sales && reportData.receipts && reportData.payouts, 'manager report exposes separated financial ledgers');
        assert.equal(reportData.staffAttribution, 'order_opener', 'manager response discloses current report attribution');
      }
      for (const [path, method, data] of [
        ['/api/payroll/entries', 'GET'],
        ['/api/payroll/entries', 'POST', { userId: 'x', ruleId: 'x', periodFrom: '2026-09-01', periodTo: '2026-09-30' }],
        ['/api/finance/categories', 'GET'],
        ['/api/expenses', 'POST', { category: 'QA', amount: 1 }],
        ['/api/finance/purchase-payables/role-qa-payable/payments', 'POST', { amount: 1, paymentDate: '2026-09-30', paymentMethod: 'cash' }],
        ['/api/discount-requests/role-qa-discount/approve', 'POST', {}],
      ]) {
        const response = await page.request.fetch(`${base}${path}`, { method, data, headers: authHeaders });
        assert.equal(response.status(), 403, `${role} ${method} ${path} is denied`);
      }
      if (role === 'bartender') {
        assert.equal((await page.request.get(`${base}/api/finance/purchase-payables`, { headers: authHeaders })).status(), 403, 'employee cannot read supplier balances');
        assert.equal((await page.request.get(`${base}/api/finance/purchase-payables?documentDateFrom=2026-09-01&paymentStatus=unpaid`, { headers: authHeaders })).status(), 403, 'employee cannot use filtered supplier-balance endpoint');
      }
      for (const width of [320, 768, 1440]) {
        await page.setViewportSize({ width, height: 800 });
        assert.equal(await page.evaluate(() => { const main = document.querySelector('.portal-main'); return document.documentElement.scrollWidth > innerWidth + 1 || main.scrollWidth > main.clientWidth + 1; }), false, `${role} finance overflow at ${width}px`);
      }
      assert.deepEqual(errors.filter((message) => !message.includes('ViewTransition opt-in disabled')), [], `${role} page errors`);
    } finally { await context.close(); }
  }
  console.log('FINANCE ROLE BROWSER QA: PASS (bartender/manager UI restrictions, finance_read, 403 mutations, 3 widths)');
} finally {
  await browser?.close();
  child.kill();
  if (child.exitCode === null) await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 3000))]);
}
