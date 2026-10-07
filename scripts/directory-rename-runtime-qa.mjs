import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const isolate = (startMarker, endMarker, label) => {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `${label} route can be isolated`);
  return source.slice(start, end);
};
const categoryRoute = isolate(
  'if (productCategoryPath && req.method === \'PATCH\') {',
  'if (productCategoryPath && req.method === \'DELETE\') {',
  'product category PATCH',
);
const subdepartmentRoute = isolate(
  'if (inventorySubdepartmentPath && req.method === \'PATCH\') {',
  'if (inventorySubdepartmentPath && req.method === \'DELETE\') {',
  'inventory subdepartment PATCH',
);

function createDatabase({ categoryConflict = false, subdepartmentConflict = false } = {}) {
  const state = {
    category: { id: '11111111-1111-4111-8111-111111111111', name: 'Сиропы', department: 'bar', subdepartmentId: null, active: true },
    subdepartment: { id: 'sub-1', name: 'Холодный цех', departmentCode: 'kitchen', active: true },
    ingredients: [
      { venueId: 'venue-a', name: 'Сироп маракуйя', categoryId: '11111111-1111-4111-8111-111111111111', category: 'Сиропы', department: 'bar', subdepartment: 'Барная зона', isMarked: true },
      { venueId: 'venue-a', name: 'Сироп старого цеха', categoryId: 'cat-kitchen', category: 'Сиропы', department: 'kitchen', subdepartment: 'Холодный цех', isMarked: true },
      { venueId: 'venue-b', name: 'Другой филиал', categoryId: 'cat-venue-b', category: 'Сиропы', department: 'bar', subdepartment: 'Холодный цех', isMarked: true },
      { venueId: 'venue-a', name: 'Архивная позиция', categoryId: '11111111-1111-4111-8111-111111111111', category: 'Сиропы', department: 'bar', subdepartment: 'Холодный цех', isMarked: false },
    ],
    calls: [],
    audits: [],
  };
  let snapshot;
  const query = async (sql, params = []) => {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    state.calls.push({ sql: normalized, params });
    if (normalized === 'BEGIN') { snapshot = structuredClone(state); return { rows: [] }; }
    if (normalized === 'COMMIT') { snapshot = null; return { rows: [] }; }
    if (normalized === 'ROLLBACK') {
      if (snapshot) {
        state.category = snapshot.category;
        state.subdepartment = snapshot.subdepartment;
        state.ingredients = snapshot.ingredients;
      }
      snapshot = null;
      return { rows: [] };
    }
    if (normalized.startsWith('SELECT 1 FROM inventory_departments')) return { rows: [{ '?column?': 1 }] };
    if (normalized.startsWith('SELECT id,name,department,subdepartment_id')) return { rows: [{ ...state.category }] };
    if (normalized.startsWith('UPDATE product_categories SET name=')) {
      if (categoryConflict) throw Object.assign(new Error('unique category conflict'), { code: '23505' });
      state.category = { ...state.category, name: params[0], department: params[1], subdepartmentId: params[2] };
      return { rows: [{ ...state.category }] };
    }
    if (normalized.startsWith('UPDATE ingredients SET category=')) {
      for (const item of state.ingredients) if (item.venueId === params[5] && item.categoryId === params[6] && item.isMarked) {
        item.category = params[0]; item.department = params[1];
      }
      return { rows: [] };
    }
    if (normalized.startsWith('SELECT id,department_code AS "departmentCode",name FROM inventory_subdepartments')) return { rows: [{ ...state.subdepartment }] };
    if (normalized.startsWith('UPDATE inventory_subdepartments SET name=')) {
      if (subdepartmentConflict) throw Object.assign(new Error('unique subdepartment conflict'), { code: '23505' });
      state.subdepartment = { ...state.subdepartment, name: params[0], departmentCode: params[1] };
      return { rows: [{ ...state.subdepartment, active: true }] };
    }
    if (normalized.startsWith('UPDATE ingredients SET subdepartment=')) {
      for (const item of state.ingredients) if (item.venueId === params[2] && item.subdepartment === params[3] && item.department === params[4] && item.isMarked) {
        item.subdepartment = params[0]; item.department = params[1];
      }
      return { rows: [] };
    }
    throw new Error(`Unexpected SQL: ${normalized}`);
  };
  return { state, pool: { query, connect: async () => ({ query, release() {} }) } };
}

async function runRoute(route, { db, kind, body }) {
  let response;
  const isCategory = kind === 'category';
  const result = await new Function(
    'req', 'res', 'pathname', 'productCategoryPath', 'inventorySubdepartmentPath',
    'repositories', 'venueDbId', 'denyUnless', 'body', 'json', 'recordAudit', 'productCategories', 'inventorySubdepartments',
    `return (async () => { ${route} })();`,
  )(
    { method: 'PATCH' }, {},
    isCategory ? `/api/product-categories/${db.state.category.id}` : `/api/inventory/subdepartments/${db.state.subdepartment.id}`,
    isCategory ? ['', db.state.category.id] : null,
    isCategory ? null : ['', db.state.subdepartment.id],
    { pool: db.pool }, 'venue-a', () => false, async () => body,
    (_res, status, payload) => { response = { status, payload }; return response; },
    (_req, action, entity, id, before, after) => db.state.audits.push({ action, entity, id, before, after }), [], [],
  );
  return response || result;
}

const categoryDb = createDatabase();
const categoryResponse = await runRoute(categoryRoute, { db: categoryDb, kind: 'category', body: { name: 'Сиропы и пюре', department: 'bar' } });
assert.equal(categoryResponse.status, 200);
assert.equal(categoryDb.state.category.name, 'Сиропы и пюре');
assert.equal(categoryDb.state.ingredients[0].category, 'Сиропы и пюре', 'same venue, department and active ingredient follow category rename');
assert.equal(categoryDb.state.ingredients[1].category, 'Сиропы', 'same name in a different department is outside category scope');
assert.equal(categoryDb.state.ingredients[2].category, 'Сиропы', 'another venue is outside category scope');
assert.equal(categoryDb.state.ingredients[3].category, 'Сиропы', 'archived items are not rewritten');
assert.ok(categoryDb.state.calls.findIndex((call) => call.sql === 'BEGIN') < categoryDb.state.calls.findIndex((call) => call.sql.startsWith('UPDATE ingredients SET category=')));
assert.ok(categoryDb.state.calls.findIndex((call) => call.sql === 'COMMIT') > categoryDb.state.calls.findIndex((call) => call.sql.startsWith('UPDATE ingredients SET category=')));
assert.equal(categoryDb.state.audits.length, 1, 'audit is written only after category and stock update commit');

const subdepartmentDb = createDatabase();
const subdepartmentResponse = await runRoute(subdepartmentRoute, { db: subdepartmentDb, kind: 'subdepartment', body: { name: 'Горячий цех', departmentCode: 'kitchen' } });
assert.equal(subdepartmentResponse.status, 200);
assert.equal(subdepartmentDb.state.subdepartment.name, 'Горячий цех');
assert.equal(subdepartmentDb.state.ingredients[1].subdepartment, 'Горячий цех', 'matching venue and department positions follow subdepartment rename');
assert.equal(subdepartmentDb.state.ingredients[0].subdepartment, 'Барная зона', 'same venue but another department is outside subdepartment scope');
assert.equal(subdepartmentDb.state.ingredients[2].subdepartment, 'Холодный цех', 'another venue is outside subdepartment scope');
assert.equal(subdepartmentDb.state.ingredients[3].subdepartment, 'Холодный цех', 'archived items are not rewritten');
assert.ok(subdepartmentDb.state.calls.findIndex((call) => call.sql === 'BEGIN') < subdepartmentDb.state.calls.findIndex((call) => call.sql.startsWith('UPDATE ingredients SET subdepartment=')));
assert.ok(subdepartmentDb.state.calls.findIndex((call) => call.sql === 'COMMIT') > subdepartmentDb.state.calls.findIndex((call) => call.sql.startsWith('UPDATE ingredients SET subdepartment=')));
assert.equal(subdepartmentDb.state.audits.length, 1, 'audit is written only after subdepartment and stock update commit');

for (const [kind, route, options, categoryKey] of [
  ['category', categoryRoute, { categoryConflict: true }, 'category'],
  ['subdepartment', subdepartmentRoute, { subdepartmentConflict: true }, 'subdepartment'],
]) {
  const db = createDatabase(options);
  const before = structuredClone(db.state);
  const body = kind === 'category' ? { name: 'Conflict', department: 'bar' } : { name: 'Conflict', departmentCode: 'kitchen' };
  const response = await runRoute(route, { db, kind, body });
  assert.equal(response.status, 409, `${kind} uniqueness collision returns conflict`);
  assert.equal(response.payload.error, kind === 'category' ? 'product_category_exists' : 'inventory_subdepartment_exists');
  assert.deepEqual(db.state[categoryKey], before[categoryKey], `${kind} row rolls back on collision`);
  assert.deepEqual(db.state.ingredients, before.ingredients, `${kind} stock references roll back on collision`);
  assert.ok(db.state.calls.some((call) => call.sql === 'ROLLBACK'), `${kind} transaction rolls back on collision`);
  assert.equal(db.state.audits.length, 0, `${kind} failed update is not audited as successful`);
}

console.log('DIRECTORY RENAME RUNTIME QA: PASS (category/subdepartment references migrate transactionally; venue/scope/archive boundaries and rollback verified with mocked PostgreSQL client)');
