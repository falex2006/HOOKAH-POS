import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const adminPassword = process.env.DEMO_ADMIN_PASSWORD || 'admin';
const child = spawn(process.execPath, ['server.js'], {
  cwd: fileURLToPath(new URL('../', import.meta.url)),
  windowsHide: true,
  env: {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: '0',
    DATABASE_URL: '',
    AUTH_REQUIRED: 'true',
    DEMO_ADMIN_PASSWORD: adminPassword,
    DEMO_OWNER_PASSWORD: process.env.DEMO_OWNER_PASSWORD || 'demo',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let baseUrl = '';
let adminToken = '';
let ownerToken = '';
const createdStaffIds = [];

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

const expectStatus = (response, expected, label) => {
  assert.equal(response.status, expected, `${label}: expected HTTP ${expected}, got ${response.status} ${JSON.stringify(response.data)}`);
};

const startServer = () => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('isolated role matrix server did not start')), 15_000);
  child.once('error', (error) => { clearTimeout(timer); reject(error); });
  child.once('exit', () => { clearTimeout(timer); reject(new Error('isolated role matrix server exited before readiness')); });
  child.stdout.on('data', (chunk) => {
    const match = String(chunk).match(/CRM running on http:\/\/localhost:(\d+)/);
    if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); }
  });
});

try {
  baseUrl = await startServer();
  expectStatus(await request('/api/inventory'), 401, 'unauthenticated inventory read');

  const adminLogin = await request('/api/login', { method: 'POST', body: { username: 'admin', password: adminPassword } });
  expectStatus(adminLogin, 200, 'admin login');
  adminToken = adminLogin.data.token;
  const ownerLogin = await request('/api/login', { method: 'POST', body: { username: 'owner', password: process.env.DEMO_OWNER_PASSWORD || 'demo' } });
  expectStatus(ownerLogin, 200, 'owner login');
  ownerToken = ownerLogin.data.token;

  const createAccount = async (role, login, permissionScopes) => {
    const created = await request('/api/staff', {
      method: 'POST', token: ownerToken,
      body: { name: `Role matrix ${role}`, login, password: 'qa-pass-123', role, birthDate: '1990-01-01', ...(permissionScopes ? { permissionScopes } : {}) },
    });
    expectStatus(created, 201, `admin creates ${role}`);
    createdStaffIds.push(created.data.id);
    const authenticated = await request('/api/login', { method: 'POST', body: { username: login, password: 'qa-pass-123' } });
    expectStatus(authenticated, 200, `${role} login`);
    return { token: authenticated.data.token, user: authenticated.data.user };
  };

  const bartender = await createAccount('bartender', `qa_bartender_${suffix}`);
  const manager = await createAccount('manager', `qa_manager_${suffix}`);

  // Read route matrix follows the actual sidebar destinations plus their data APIs.
  const reads = [
    ['/api/orders', 200, 200],
    ['/api/floor', 200, 200],
    ['/api/reservations', 403, 200],
    ['/api/clients', 200, 200],
    ['/api/inventory', 403, 200],
    ['/api/finance/summary', 200, 200],
    ['/api/metrics', 200, 200],
    ['/api/shifts', 200, 200],
    ['/api/staff', 403, 200],
    ['/api/tasks', 200, 200],
  ];
  for (const [path, bartenderStatus, managerStatus] of reads) {
    expectStatus(await request(path, { token: bartender.token }), bartenderStatus, `bartender GET ${path}`);
    expectStatus(await request(path, { token: manager.token }), managerStatus, `manager GET ${path}`);
  }

  const bartenderFinance = await request('/api/finance/summary', { token: bartender.token });
  assert.equal(bartenderFinance.data.employeeView, true, 'operational employee gets the limited finance view');
  assert.deepEqual(Object.keys(bartenderFinance.data).sort(), ['date', 'employeeView', 'revenue'].sort(), 'employee finance payload contains turnover only');
  const employeeMetrics = await request('/api/metrics', { token: bartender.token });
  assert.equal(employeeMetrics.data.employeeView, true);
  assert.ok(Object.keys(employeeMetrics.data).every((key) => ['employeeView', 'openOrders', 'pendingOrders'].includes(key)), 'employee metrics exclude venue financial, stock and staffing indicators');
  for (const key of ['pendingRevenue', 'closedOrders', 'discountRequests', 'staffActive', 'reservationsToday', 'lowStock']) assert.ok(!(key in employeeMetrics.data), `employee metrics omit ${key}`);
  const managerMetrics = await request('/api/metrics', { token: manager.token });
  assert.ok('pendingRevenue' in managerMetrics.data && 'staffActive' in managerMetrics.data, 'manager retains management indicators');

  const oldShift = await request('/api/shifts', { method: 'POST', token: adminToken, body: { openingCash: 50 } });
  expectStatus(oldShift, 201, 'admin opens historical test shift');
  expectStatus(await request(`/api/shifts/${encodeURIComponent(oldShift.data.id)}/close`, { method: 'POST', token: adminToken, body: { closingCash: 60, checklist: { version: 1, items: { ordersReviewed: true, cashCounted: true, inventoryReviewed: true, externalFiscalReportsHandled: true } } } }), 200, 'admin closes historical test shift');
  const currentShift = await request('/api/shifts', { method: 'POST', token: adminToken, body: { openingCash: 25 } });
  expectStatus(currentShift, 201, 'admin opens current test shift');
  const employeeShifts = await request('/api/shifts', { token: bartender.token });
  assert.deepEqual(employeeShifts.data.items.map((shift) => shift.id), [currentShift.data.id], 'employee sees only current open shift');
  assert.deepEqual(Object.keys(employeeShifts.data.current).sort(), ['closedAt', 'id', 'openedAt', 'openingCash'].sort(), 'employee shift omits reconciliation fields');
  const managerShifts = await request('/api/shifts', { token: manager.token });
  assert.ok(managerShifts.data.items.some((shift) => shift.id === oldShift.data.id && 'cashVariance' in shift), 'manager retains historical cash reconciliation');
  const managerSession = await request('/api/session', { token: manager.token });
  assert.ok(managerSession.data.permissions.includes('inventory_read'));
  assert.ok(managerSession.data.permissions.includes('finance_read'));
  assert.ok(!managerSession.data.permissions.includes('inventory'));
  assert.ok(!managerSession.data.permissions.includes('finance'));

  const categoryManager = await createAccount('manager', `qa_cat_mgr_${suffix}`, ['inventory_categories']);
  const categoryManagerSession = await request('/api/session', { token: categoryManager.token });
  assert.ok(categoryManagerSession.data.permissions.includes('inventory_categories'), 'owner assigned the narrow category lifecycle permission');
  assert.ok(categoryManagerSession.data.permissions.includes('inventory_read'), 'category lifecycle scope retains the manager directory read access');
  assert.ok(!categoryManagerSession.data.permissions.includes('inventory'), 'category lifecycle scope does not grant broad inventory writes');
  const lifecycleCategory = await request('/api/product-categories', { method: 'POST', token: adminToken, body: { name: `QA category lifecycle ${suffix}`, department: 'inventory' } });
  expectStatus(lifecycleCategory, 201, 'admin creates category lifecycle fixture');
  expectStatus(await request(`/api/product-categories/${encodeURIComponent(lifecycleCategory.data.id)}`, { method: 'DELETE', token: manager.token }), 403, 'manager without the configured scope cannot archive a category');
  expectStatus(await request(`/api/product-categories/${encodeURIComponent(lifecycleCategory.data.id)}`, { method: 'DELETE', token: categoryManager.token }), 200, 'category manager archives without broad inventory access');
  expectStatus(await request(`/api/product-categories/${encodeURIComponent(lifecycleCategory.data.id)}/restore`, { method: 'POST', token: categoryManager.token }), 200, 'category manager restores an archived category');
  expectStatus(await request(`/api/product-categories/${encodeURIComponent(lifecycleCategory.data.id)}`, { method: 'DELETE', token: categoryManager.token }), 200, 'category manager re-archives the category');
  expectStatus(await request('/api/inventory/deletion-requests', { method: 'POST', token: categoryManager.token, body: { entityType: 'category', entityId: lifecycleCategory.data.id } }), 201, 'category manager requests owner approval');
  expectStatus(await request('/api/inventory/deletion-requests', { method: 'POST', token: categoryManager.token, body: { entityType: 'department', entityId: 'inventory' } }), 403, 'category-only scope cannot request department deletion');
  expectStatus(await request('/api/product-categories', { method: 'POST', token: categoryManager.token, body: { name: `QA forbidden category ${suffix}`, department: 'inventory' } }), 403, 'category-only scope cannot create or edit categories');
  expectStatus(await request(`/api/product-categories/${encodeURIComponent(lifecycleCategory.data.id)}`, { method: 'PATCH', token: categoryManager.token, body: { name: `QA forbidden rename ${suffix}`, department: 'inventory' } }), 403, 'category-only scope cannot rename or move categories');
  expectStatus(await request('/api/inventory/items', { method: 'POST', token: categoryManager.token, body: { name: `QA forbidden stock ${suffix}`, unit: 'шт', itemType: 'ingredient', cost: 1 } }), 403, 'category-only scope cannot mutate stock');
  const pendingCategoryRequest = await request('/api/inventory/deletion-requests', { token: ownerToken });
  const categoryRequest = pendingCategoryRequest.data.items.find((item) => item.entityId === lifecycleCategory.data.id);
  assert.ok(categoryRequest, 'owner sees the category deletion request');
  expectStatus(await request(`/api/inventory/deletion-requests/${encodeURIComponent(categoryRequest.id)}/approve`, { method: 'POST', token: categoryManager.token }), 403, 'category manager cannot approve final deletion');
  expectStatus(await request(`/api/inventory/deletion-requests/${encodeURIComponent(categoryRequest.id)}/approve`, { method: 'POST', token: ownerToken }), 200, 'owner confirms final deletion');

  const premixSource = await request('/api/inventory/items', { method: 'POST', token: adminToken, body: { name: `QA role premix source ${suffix}`, unit: 'мл', itemType: 'ingredient', cost: 0.1 } });
  const premixOutput = await request('/api/inventory/items', { method: 'POST', token: adminToken, body: { name: `QA role premix output ${suffix}`, unit: 'мл', itemType: 'ingredient', cost: 0 } });
  expectStatus(premixSource, 201, 'admin creates premix source');
  expectStatus(premixOutput, 201, 'admin creates premix output');
  expectStatus(await request('/api/inventory/movements', { method: 'POST', token: adminToken, body: { itemId: premixSource.data.id, delta: 500, unit: 'мл', reason: 'Role matrix premix fixture' } }), 201, 'admin stocks premix source');
  const premixRecipe = await request('/api/recipes', { method: 'POST', token: adminToken, body: { name: `QA role premix recipe ${suffix}`, recipeType: 'premix', yieldQuantity: 500, yieldUnit: 'мл', portionCount: 1, ingredients: [{ ingredientId: premixSource.data.id, name: premixSource.data.name, quantity: '250 мл' }] } });
  expectStatus(premixRecipe, 201, 'admin creates premix recipe');
  const producedPremix = await request('/api/inventory/premixes/produce', { method: 'POST', token: adminToken, body: { recipeId: premixRecipe.data.id, outputItemId: premixOutput.data.id, multiplier: 1 } });
  expectStatus(producedPremix, 201, 'admin produces premix');
  const managerPremixes = await request('/api/inventory/premixes', { token: manager.token });
  expectStatus(managerPremixes, 200, 'manager reads premix batches');
  assert.equal(managerPremixes.data.items.find((batch) => batch.id === producedPremix.data.id)?.recipeName, premixRecipe.data.name, 'manager history shows a readable recipe name after authenticated reread');
  expectStatus(await request('/api/inventory/premixes', { token: bartender.token }), 403, 'bartender cannot read premix history');
  expectStatus(await request('/api/inventory/premixes/produce', { method: 'POST', token: manager.token, body: { recipeId: premixRecipe.data.id, outputItemId: premixOutput.data.id, multiplier: 1 } }), 403, 'manager cannot produce a premix');

  // A visible/guessable URL or forged body must not bypass server-side checks.
  const forbiddenWrites = [
    ['/api/inventory/items', 'POST', { name: 'Forbidden QA item', unit: 'шт', itemType: 'ingredient', cost: 1 }],
    ['/api/expenses', 'POST', { amount: 1, category: 'QA', description: 'Forbidden write' }],
    ['/api/staff', 'POST', { name: 'Forbidden QA staff', login: `qa_denied_${suffix}`, password: 'qa-pass-123', role: 'bartender', birthDate: '1990-01-01' }],
    ['/api/venue', 'PATCH', { name: 'Forbidden venue rename' }],
  ];
  for (const [path, method, body] of forbiddenWrites) {
    expectStatus(await request(path, { method, token: bartender.token, body }), 403, `bartender ${method} ${path}`);
  }
  expectStatus(await request('/api/venue', { method: 'PATCH', token: manager.token, body: { name: 'Manager rename attempt' } }), 403,
    'manager settings scope cannot change venue identity');

  // Managers can assign a task; its assignee can change status but not rewrite its content.
  const task = await request('/api/tasks', {
    method: 'POST', token: manager.token,
    body: { title: `Role matrix task ${suffix}`, description: 'QA task', priority: 'normal', assigneeId: bartender.user.id },
  });
  expectStatus(task, 201, 'manager creates and assigns task');
  const employeeTasks = await request('/api/tasks', { token: bartender.token });
  assert.ok(employeeTasks.data.items.some((item) => item.id === task.data.id), 'assignee can read their task');
  expectStatus(await request(`/api/tasks/${encodeURIComponent(task.data.id)}`, {
    method: 'PATCH', token: bartender.token, body: { title: 'Unauthorized rewrite' },
  }), 403, 'assignee cannot edit manager-owned task fields');
  const completed = await request(`/api/tasks/${encodeURIComponent(task.data.id)}`, {
    method: 'PATCH', token: bartender.token, body: { status: 'done' },
  });
  expectStatus(completed, 200, 'assignee marks task done');
  assert.equal(completed.data.status, 'done');
  const reread = await request('/api/tasks', { token: manager.token });
  assert.equal(reread.data.items.find((item) => item.id === task.data.id)?.status, 'done', 'task status persists and is visible to manager');

  // A valid 100% discount closes a check with finalTotal=0 and no payment
  // records. Finance fallback paths must preserve that explicit zero.
  const freeProduct = await request('/api/products', {
    method: 'POST', token: adminToken,
    body: { name: `QA free check ${suffix}`, category: 'bar', price: 500, inventoryMode: 'non_stock' },
  });
  expectStatus(freeProduct, 201, 'admin creates zero-total regression product');
  const venue = await request('/api/venue', { token: adminToken });
  expectStatus(venue, 200, 'admin reads venue for zero-total regression floor fixture');
  const freeZone = await request('/api/floor/zones', {
    method: 'POST', token: adminToken,
    body: { expectedVenueId: venue.data.id, name: `QA zero-total ${suffix}` },
  });
  expectStatus(freeZone, 201, 'admin creates zero-total regression zone');
  const freeTable = await request('/api/floor/tables', {
    method: 'POST', token: adminToken,
    body: { expectedVenueId: venue.data.id, zoneId: freeZone.data.id, name: `QA free table ${suffix}`, capacity: 2 },
  });
  expectStatus(freeTable, 201, 'admin creates zero-total regression table');
  const freeOrder = await request('/api/orders', {
    method: 'POST', token: adminToken,
    body: { tableId: freeTable.data.id },
  });
  expectStatus(freeOrder, 201, 'admin opens zero-total regression order');
  expectStatus(await request(`/api/orders/${encodeURIComponent(freeOrder.data.id)}/items`, {
    method: 'POST', token: adminToken, body: { productId: freeProduct.data.id, quantity: 1 },
  }), 201, 'admin adds item to zero-total regression order');
  const discountRequest = await request(`/api/orders/${encodeURIComponent(freeOrder.data.id)}/discount-requests`, {
    method: 'POST', token: adminToken,
    body: { type: 'percent', value: 100, reason: 'QA approved complimentary order' },
  });
  expectStatus(discountRequest, 201, 'admin requests full discount');
  expectStatus(await request(`/api/discount-requests/${encodeURIComponent(discountRequest.data.id)}/approve`, {
    method: 'POST', token: adminToken, body: {},
  }), 200, 'admin approves full discount');
  const freeClose = await request(`/api/orders/${encodeURIComponent(freeOrder.data.id)}/close`, {
    method: 'POST', token: adminToken, body: { paymentMethod: 'cash' },
  });
  expectStatus(freeClose, 200, 'admin closes fully discounted order');
  assert.equal(freeClose.data.finalTotal, 0, 'fully discounted order stores explicit zero final total');
  assert.deepEqual(freeClose.data.payments, [], 'zero balance does not create a fake payment');
  const freeSummary = await request('/api/finance/summary', { token: adminToken });
  assert.equal(freeSummary.data.revenue, 0, 'memory finance summary does not replace zero with gross order total');
  const freeReport = await request('/api/finance/report?type=waiter', { token: adminToken });
  assert.equal(freeReport.data.revenue, 0, 'memory finance report does not replace zero with gross order total');
  assert.equal(freeReport.data.byStaff.Administrator || 0, 0, 'waiter report does not attribute gross revenue to zero-total order');

  console.log('ROLE API MATRIX RUNTIME QA: PASS (manager category scope, archive/restore/request/owner-approval lifecycle, scope isolation, unauthenticated denial, role route matrix, employee finance, task lifecycle and zero-total finance regression)');
} finally {
  if (baseUrl && adminToken) {
    for (const id of createdStaffIds) {
      await request(`/api/staff/${encodeURIComponent(id)}`, { method: 'DELETE', token: adminToken }).catch(() => {});
    }
  }
  child.kill();
  await once(child, 'exit').catch(() => {});
}
