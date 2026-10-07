import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const portal = readFileSync(new URL('../portal.js', import.meta.url), 'utf8');
const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const categoryMigration = readFileSync(new URL('../migrations/015_product_category_departments.sql', import.meta.url), 'utf8');
const categorySubdepartmentMigration = readFileSync(new URL('../migrations/048_product_category_subdepartments.sql', import.meta.url), 'utf8');

// Category API keeps the selected venue-specific department code end to end.
const postStart = server.indexOf("if (pathname === '/api/product-categories' && req.method === 'POST')");
const patchStart = server.indexOf("if (productCategoryPath && req.method === 'PATCH')", postStart);
const postRoute = server.slice(postStart, patchStart);
const patchEnd = server.indexOf("if (productCategoryPath && req.method === 'DELETE')", patchStart);
const patchRoute = server.slice(patchStart, patchEnd);
assert.ok(postStart >= 0 && patchStart > postStart && patchEnd > patchStart, 'category create and update routes must be discoverable');
for (const [name, route] of [['create', postRoute], ['update', patchRoute]]) {
  assert.match(route, /inventory_departments WHERE venue_id=\$1 AND code=\$2 AND is_active=true/, `${name} must validate a live department in the current venue`);
  assert.match(route, /\[venueDbId, department\]/, `${name} must validate the exact selected department code`);
  assert.doesNotMatch(route, /\['kitchen','bar','hookah','inventory'\]\.includes\(input\.department\) \? input\.department : 'inventory'/, `${name} must not rewrite custom departments to inventory`);
}
assert.match(postRoute, /\[venueDbId, name, department, subdepartmentId\]/, 'create must persist the exact department and optional subdepartment');
assert.match(patchRoute, /\[name, department, subdepartmentId, productCategoryPath\[1\], venueDbId\]/, 'update must persist the exact department and optional subdepartment');
const demoPostStart = portal.indexOf("if (path === '/api/product-categories' && method === 'POST')");
const demoPatchStart = portal.indexOf('const demoProductCategory =', demoPostStart);
const demoCategoryRoutes = portal.slice(demoPostStart, demoPatchStart);
const demoDeleteStart = portal.indexOf("if (demoProductCategory && method === 'DELETE')", demoPatchStart);
const demoCategoryUpdate = portal.slice(demoPatchStart, demoDeleteStart);
assert.ok(demoPostStart >= 0 && demoPatchStart > demoPostStart, 'demo category routes must be discoverable');
assert.ok(demoCategoryRoutes.includes("const department = String(input.department || 'inventory').trim()") && demoCategoryRoutes.includes('demoState.inventoryDepartments?.some') && demoCategoryRoutes.includes('name, department, active: true'),
  'demo create must validate against the current department directory and keep its identifier');
assert.ok(demoCategoryUpdate.includes("const department = String(input.department ?? category.department ?? 'inventory').trim()") && demoCategoryUpdate.includes('category.department = department'),
  'demo update must retain the selected department identifier');
assert.match(categoryMigration, /department text NOT NULL DEFAULT 'inventory'/,
  'base schema stores category department codes');
assert.match(categorySubdepartmentMigration, /subdepartment_id uuid/);
assert.match(categorySubdepartmentMigration, /product_categories_subdepartment_fk/,
  'category subdepartment links are protected by a same-venue and same-department foreign key');

const runCategoryRoute = async (source, { method, department, name, id }) => {
  const calls = [];
  let response = null;
  let category = { id: id || 'qa-category', name: 'Старая категория', department: 'inventory', active: true };
  const executeQuery = async (sql, params = []) => {
    calls.push({ sql, params });
    if (sql.startsWith('SELECT 1 FROM inventory_departments')) return { rows: [{ exists: true }] };
    if (sql.startsWith('INSERT INTO product_categories')) return { rows: [{ id: 'qa-category', name: params[1], department: params[2], subdepartmentId: params[3], active: true }] };
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
    if (sql.startsWith('SELECT id,name,department,subdepartment_id')) return { rows: [{ ...category }] };
    if (sql.startsWith('UPDATE product_categories')) { category = { ...category, id: params[3], name: params[0], department: params[1], subdepartmentId: params[2] }; return { rows: [{ ...category }] }; }
    if (sql.startsWith('UPDATE ingredients SET category=')) return { rows: [] };
    throw new Error(`Unexpected category SQL: ${sql}`);
  };
  const pool = {
    query: executeQuery,
    connect: async () => ({ query: executeQuery, release() {} }),
  };
  const execute = new Function('req', 'res', 'pathname', 'productCategoryPath', 'repositories', 'venueDbId', 'denyUnless', 'body', 'json', 'recordAudit', 'productCategories', 'inventorySubdepartments', `return (async () => { ${source} })();`);
  await execute({ method }, {}, method === 'POST' ? '/api/product-categories' : `/api/product-categories/${id}`, id ? [`/api/product-categories/${id}`, id] : null,
    { pool }, 'venue-qa', () => false, async () => ({ name, department, subdepartmentId: null }), (_res, status, payload) => { response = { status, payload }; return response; }, () => {}, [], []);
  return { calls, response };
};
const customDepartment = 'qa-bar-special-17';
const createdCategory = await runCategoryRoute(postRoute, { method: 'POST', department: customDepartment, name: 'QA custom category' });
assert.equal(createdCategory.response.status, 201);
assert.equal(createdCategory.response.payload.department, customDepartment);
assert.deepEqual(createdCategory.calls.filter((call) => call.params.length).map((call) => call.params), [['venue-qa', customDepartment], ['venue-qa', 'QA custom category', customDepartment, null]]);
const updatedCategory = await runCategoryRoute(patchRoute, { method: 'PATCH', id: '11111111-1111-4111-8111-111111111111', department: customDepartment, name: 'QA custom category updated' });
assert.equal(updatedCategory.response.status, 200);
assert.equal(updatedCategory.response.payload.department, customDepartment);
assert.deepEqual(updatedCategory.calls.filter((call) => call.params.length).map((call) => call.params), [
  ['venue-qa', customDepartment],
  ['11111111-1111-4111-8111-111111111111', 'venue-qa'],
  ['QA custom category updated', customDepartment, null, '11111111-1111-4111-8111-111111111111', 'venue-qa'],
  ['QA custom category updated', customDepartment, null, null, 'inventory', 'venue-qa', '11111111-1111-4111-8111-111111111111'],
]);
assert.ok(updatedCategory.calls.findIndex((call) => call.sql === 'BEGIN') < updatedCategory.calls.findIndex((call) => call.sql.startsWith('UPDATE ingredients SET category=')), 'category rename and stock reference propagation use the same transaction');
assert.ok(updatedCategory.calls.findIndex((call) => call.sql === 'COMMIT') > updatedCategory.calls.findIndex((call) => call.sql.startsWith('UPDATE ingredients SET category=')), 'transaction commits after stock reference propagation');

// Execute the actual auto-order renderer against a minimal DOM to prove that
// failed initial loads do not masquerade as a successful empty result.
const drawStart = portal.indexOf('const drawAutoOrders = () => {');
const drawEnd = portal.indexOf('\n  const loadAutoOrders', drawStart);
assert.ok(drawStart >= 0 && drawEnd > drawStart, 'auto-order renderer must be discoverable');
const drawSource = portal.slice(drawStart, drawEnd);
const render = (state) => {
  const nodes = {
    '#auto-order-list': { innerHTML: '', querySelectorAll: () => [], querySelector: () => null },
    '#auto-order-low-count': { textContent: '', className: '' },
    '#auto-order-history-list': { innerHTML: '', querySelectorAll: () => [] },
    '#create-auto-order': { disabled: false, title: '' },
  };
  const document = { querySelector: (selector) => nodes[selector] || null };
  const pluralRu = (count, one, few, many) => count === 1 ? one : count > 1 && count < 5 ? few : many;
  const money = (value) => `${Number(value || 0)} ₽`;
  const esc = (value) => String(value ?? '');
  const displayName = (value) => String(value ?? '');
  const autoOrderStatus = {};
  const execute = new Function('autoOrderState', 'document', 'nodes', 'canWriteInventory', 'pluralRu', 'money', 'esc', 'displayName', 'autoOrderStatus', 'autoOrderCreatePending', 'autoOrderCancelPending', 'openAutoOrderReceipt', 'loadAutoOrders', `${drawSource}; drawAutoOrders(); return { nodes, state: autoOrderState };`);
  return execute(state, document, nodes, true, pluralRu, money, esc, displayName, autoOrderStatus, false, new Set(), () => {}, () => {}).nodes;
};

const failedInitial = render({ items: [], requests: [], error: true, hasLoaded: false });
assert.equal(failedInitial['#auto-order-low-count'].textContent, 'Ошибка загрузки');
assert.equal(failedInitial['#auto-order-low-count'].className, 'badge danger');
assert.match(failedInitial['#auto-order-list'].innerHTML, /Состояние остатков неизвестно/);
assert.match(failedInitial['#auto-order-list'].innerHTML, /data-auto-order-retry/);
assert.doesNotMatch(failedInitial['#auto-order-list'].innerHTML, /Пополнение пока не требуется/);
assert.equal(failedInitial['#create-auto-order'].disabled, true, 'initial failure cannot create a request with no loaded recommendation data');

const failedRefresh = render({ items: [{ id: 'x', name: 'Тест', department: 'Бар', category: 'Сиропы', onHand: 1, minLevel: 2, orderQuantity: 1, targetLevel: 3, packMultiplier: 1, unit: 'шт', estimate: 10 }], requests: [], error: true, hasLoaded: true });
assert.match(failedRefresh['#auto-order-list'].innerHTML, /данные последней успешной загрузки/);
assert.equal(failedRefresh['#create-auto-order'].disabled, true, 'a refresh failure blocks sending until recommendations are refreshed');
assert.match(failedRefresh['#create-auto-order'].title, /повторите загрузку рекомендаций/);

// Inventory failures need a real recovery action; test the same markup factory
// used by the request catch handler and the delegated click wiring.
const inventoryErrorStart = portal.indexOf('const inventoryLoadErrorMarkup = () => ');
const inventoryErrorEnd = portal.indexOf(';', inventoryErrorStart);
assert.ok(inventoryErrorStart >= 0 && inventoryErrorEnd > inventoryErrorStart, 'inventory load error markup factory must exist');
const inventoryErrorMarkup = new Function(`return (${portal.slice(inventoryErrorStart + 'const inventoryLoadErrorMarkup = () => '.length, inventoryErrorEnd)});`)();
assert.match(inventoryErrorMarkup, /role="alert"/);
assert.match(inventoryErrorMarkup, /Не удалось загрузить склад/);
assert.match(inventoryErrorMarkup, /data-inventory-retry/);
assert.match(portal, /const retry = event\.target\.closest\('\[data-inventory-retry\]'\); if \(retry\) \{ retry\.disabled = true; retry\.textContent = 'Загружаем…'; load\(\); return; \}/,
  'the inventory error retry button must disable during retry and invoke the same load function');
assert.match(portal, /\.catch\(\(\) => \{ inventoryLoadState = 'error'; refreshInventoryContext\(\); document\.querySelector\('#inventory-rows'\)\.innerHTML = inventoryLoadErrorMarkup\(\);/,
  'inventory request errors must render the actionable error state');

console.log('INVENTORY CRITICAL STATE QA: PASS (custom department round-trip; auto-order error states; inventory error retry state)');
