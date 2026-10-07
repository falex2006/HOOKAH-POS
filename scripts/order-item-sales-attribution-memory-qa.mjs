import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const child = spawn(process.execPath, ['server.js'], {
  cwd: fileURLToPath(new URL('../', import.meta.url)), windowsHide: true,
  env: { ...process.env, HOST: '127.0.0.1', PORT: '0', DATABASE_URL: '', AUTH_REQUIRED: 'false', DEMO_MODE: 'true', NODE_ENV: 'test' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stdout.on('data', (chunk) => { output += chunk; });
child.stderr.on('data', (chunk) => { output += chunk; });
const base = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`QA server did not start: ${output}`)), 15000);
  child.once('error', reject);
  child.stdout.on('data', () => {
    const match = output.match(/CRM running on http:\/\/localhost:(\d+)/);
    if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); }
  });
});

async function call(path, method = 'GET', body, token, expected = 200) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(data)}`);
  return data;
}

try {
  assert.equal((await call('/api/health')).database, 'memory');
  const session = await call('/api/login', 'POST', { username: 'staff', password: 'demo' }, null, 200);
  const token = session.token;
  assert.match(session.user.id, /^[0-9a-f-]{36}$/i, 'demo session uses the employee identity');
  const admin = await call('/api/login', 'POST', { username: 'admin', password: 'admin' }, null, 200);
  const product = await call('/api/products', 'POST', { name: 'QA POS attribution service', category: 'Услуги', price: 100, inventoryMode: 'non_stock' }, admin.token, 201);
  const order = await call('/api/orders', 'POST', { tableId: `pos-attribution-${Date.now()}` }, token, 201);
  const first = await call(`/api/orders/${order.id}/items`, 'POST', { productId: product.id, quantity: 1 }, token, 201);
  assert.equal(first.salesEmployeeId, session.user.id);
  assert.ok(Number.isFinite(Date.parse(first.soldAt)), 'server returned a sale timestamp');
  assert.equal(new Date(first.soldAt).toISOString(), first.soldAt, 'timestamp is returned as UTC ISO');
  assert.equal((await call(`/api/orders/${order.id}/items`, 'POST', { productId: product.id, quantity: 1, salesEmployeeId: 'forged', soldAt: '2000-01-01T00:00:00.000Z' }, token, 400)).error, 'sales_attribution_server_managed');
  const second = await call(`/api/orders/${order.id}/items`, 'POST', { productId: product.id, quantity: 1 }, token, 201);
  assert.notEqual(second.id, first.id, 'repeat sale creates an independent row');
  const increased = await call(`/api/orders/${order.id}/items/${first.id}`, 'PATCH', { quantity: 2 }, token, 409);
  assert.equal(increased.error, 'quantity_increase_requires_new_line');
  const changed = await call(`/api/orders/${order.id}/items/${first.id}`, 'PATCH', { quantity: 0 }, token, 400);
  assert.equal(changed.error, 'quantity_must_be_positive');
  const reduced = await call(`/api/orders/${order.id}/items/${first.id}`, 'PATCH', { quantity: 1 }, token, 200);
  assert.equal(reduced.salesEmployeeId, first.salesEmployeeId, 'quantity reduction preserves the original seller');
  assert.equal(reduced.soldAt, first.soldAt, 'quantity reduction preserves the original sale time');
  const loaded = (await call('/api/orders', 'GET', undefined, token)).items.find((entry) => entry.id === order.id);
  const items = loaded.items.filter((item) => item.productId === product.id);
  assert.equal(items.length, 2, 'reload contains both sale events');
  assert.deepEqual(items.map((item) => item.id).sort(), [first.id, second.id].sort());
  for (const item of items) assert.equal(item.salesEmployeeId, session.user.id, 'reload retains seller identity');
  console.log('ORDER ITEM SALES ATTRIBUTION MEMORY QA: PASS (session actor, spoof rejection, separate repeat sale, increase rejection, reduction preservation, reload)');
} finally {
  child.kill('SIGTERM');
}
