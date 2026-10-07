import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const adminPassword = process.env.DEMO_ADMIN_PASSWORD || 'admin';
const ownerPassword = process.env.DEMO_OWNER_PASSWORD || 'demo';
const accounts = [];
let child = null;
let baseUrl = String(process.argv[2] || '').replace(/\/$/, '');
if (!baseUrl) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  child = spawn(process.execPath, ['server.js'], { cwd: root, windowsHide: true, env: { ...process.env, HOST: '127.0.0.1', PORT: '0', DATABASE_URL: '', AUTH_REQUIRED: 'true', DEMO_ADMIN_PASSWORD: adminPassword, DEMO_OWNER_PASSWORD: ownerPassword }, stdio: ['ignore', 'pipe', 'pipe'] });
  baseUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('isolated finance RBAC server did not start')), 15000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('isolated finance RBAC server exited before readiness')); });
    child.stdout.on('data', (chunk) => { const match = String(chunk).match(/CRM running on http:\/\/localhost:(\d+)/); if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); } });
  });
}

const request = async (path, { method = 'GET', token, body } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  return { status: response.status, data };
};

const login = async (username, password) => {
  const response = await request('/api/login', { method: 'POST', body: { username, password } });
  assert.equal(response.status, 200, `login should succeed for ${username}`);
  return response.data.token;
};

const expectStatus = (response, status, label) => {
  assert.equal(response.status, status, `${label} must return HTTP ${status}, got ${response.status}`);
};

const adminToken = await login('admin', adminPassword);
const ownerToken = await login('owner', ownerPassword);
const createAccount = async (role, loginName) => {
  const created = await request('/api/staff', {
    method: 'POST',
    token: ownerToken,
    body: { name: `Finance access QA ${role}`, login: loginName, password: 'qa-pass-123', role, birthDate: '1990-01-01', employmentStartedAt: '2020-01-01' },
  });
  expectStatus(created, 201, `create ${role} test account`);
  accounts.push(created.data);
  return login(loginName, 'qa-pass-123');
};

try {
  const bartenderToken = await createAccount('bartender', `qa_bartender_${suffix}`);
  const managerToken = await createAccount('manager', `qa_manager_${suffix}`);

  for (const [role, token] of [['bartender', bartenderToken]]) {
    expectStatus(await request('/api/expenses', { token }), 403, `${role} expense list`);
    expectStatus(await request('/api/payroll/rules', { token }), 403, `${role} payroll rules`);
  }
  expectStatus(await request('/api/expenses', { token: managerToken }), 200, 'finance_read manager expense list');
  expectStatus(await request('/api/payroll/rules', { token: managerToken }), 403, 'finance_read manager payroll rules');
  expectStatus(await request('/api/finance/purchase-payables', { token: bartenderToken }), 403, 'operational employee supplier payable summary');
  expectStatus(await request('/api/finance/purchase-payables', { token: managerToken }), 503, 'finance_read manager supplier payable summary passes RBAC before unavailable isolated repository');
  const paymentHistoryPath = '/api/finance/purchase-payables/11111111-1111-4111-8111-111111111111/payments';
  expectStatus(await request(paymentHistoryPath, { token: bartenderToken }), 403, 'operational employee supplier payment history');
  expectStatus(await request(paymentHistoryPath, { token: managerToken }), 503, 'finance_read manager payment history passes RBAC before unavailable isolated repository');
  expectStatus(await request(paymentHistoryPath, { token: adminToken }), 503, 'finance admin payment history passes RBAC before unavailable isolated repository');
  for (const [role, token] of [['admin', adminToken], ['owner', ownerToken]]) {
    expectStatus(await request('/api/expenses', { token }), 200, `${role} expense list`);
    expectStatus(await request('/api/payroll/rules', { token }), 200, `${role} payroll rules`);
  }
  console.log('FINANCE RBAC RUNTIME QA: PASS (operational employees denied financial detail and payment history; finance_read manager gets view-only payables/history; payroll rules remain finance-only)');
} finally {
  for (const account of accounts) {
    if (account?.id) await request(`/api/staff/${encodeURIComponent(account.id)}`, { method: 'DELETE', token: adminToken });
  }
  if (child) { child.kill(); await once(child, 'exit').catch(() => {}); }
}
