import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { assertQaDatabaseIdentity, validateQaDatabaseUrl } from './postgres-qa-safety.mjs';

const databaseUrl = process.env.MIGRATIONS_PG_TEST_DATABASE_URL;
const target = validateQaDatabaseUrl(databaseUrl, 'MIGRATIONS_PG_TEST_DATABASE_URL');
const { Pool } = createRequire(import.meta.url)('pg');
const { InventoryRepository } = createRequire(import.meta.url)('../db.js');
const { beginPayrollSourceProducerTransaction } = createRequire(import.meta.url)('../payroll-source-fence.js');
const client = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5000, max: 4 });
let venueId;
let otherVenueId;
const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const subdepartmentStart = source.indexOf("if (pathname === '/api/inventory/subdepartments' && req.method === 'POST') {");
const subdepartmentEnd = source.indexOf('const inventorySubdepartmentPath =', subdepartmentStart);
const departmentStart = source.indexOf('const inventoryDepartmentPath =', source.indexOf("if (pathname === '/api/inventory/departments' && req.method === 'POST')"));
const departmentEnd = source.indexOf("if (pathname === '/api/product-categories' && req.method === 'GET')", departmentStart);
const subdepartmentPathStart = source.indexOf('const inventorySubdepartmentPath =');
const subdepartmentDeleteStart = source.indexOf("if (inventorySubdepartmentPath && req.method === 'DELETE') {", subdepartmentPathStart);
const subdepartmentDeleteEnd = source.indexOf('\n  const recipeCostPath =', subdepartmentDeleteStart);
const subdepartmentPatchStart = source.indexOf("if (inventorySubdepartmentPath && req.method === 'PATCH') {", subdepartmentPathStart);
const subdepartmentPatchEnd = source.indexOf("if (inventorySubdepartmentPath && req.method === 'DELETE') {", subdepartmentPatchStart);
const productCategoryCreateStart = source.indexOf("if (pathname === '/api/product-categories' && req.method === 'POST') {");
const productCategoryCreateEnd = source.indexOf('const productCategoryPath =', productCategoryCreateStart);
const productCategoryPatchStart = source.indexOf("if (productCategoryPath && req.method === 'PATCH') {", productCategoryCreateEnd);
const productCategoryPatchEnd = source.indexOf("if (productCategoryPath && req.method === 'DELETE') {", productCategoryPatchStart);
assert.ok(subdepartmentStart >= 0 && subdepartmentEnd > subdepartmentStart, 'subdepartment route is available');
assert.ok(departmentStart >= 0 && departmentEnd > departmentStart, 'department route is available');
assert.ok(subdepartmentPatchStart >= 0 && subdepartmentPatchEnd > subdepartmentPatchStart, 'subdepartment update route is available');
assert.ok(subdepartmentDeleteStart >= 0 && subdepartmentDeleteEnd > subdepartmentDeleteStart, 'subdepartment archive route is available');
assert.ok(productCategoryCreateStart >= 0 && productCategoryCreateEnd > productCategoryCreateStart, 'product category create route is available');
assert.ok(productCategoryPatchStart >= 0 && productCategoryPatchEnd > productCategoryPatchStart, 'product category update route is available');
const inventoryItemStart = source.indexOf('const inventoryItemPath = pathname.match(');
const inventoryItemEnd = source.indexOf("if (inventoryItemPath && req.method === 'DELETE')", inventoryItemStart);
assert.ok(inventoryItemStart >= 0 && inventoryItemEnd > inventoryItemStart, 'inventory item create/update routes are available');
const callApi = async ({ route, pathname, method = 'POST', venue, input = {} }) => {
  let response;
  const json = (_res, status, data) => { response = { status, data }; return response; };
  const denyUnless = (req, res, permission) => { if (req.user?.permissions?.includes(permission)) return false; json(res, 403, { error: 'forbidden' }); return true; };
  const handler = new Function('pathname','req','res','url','repositories','venueDbId','denyUnless','body','json','recordAudit', `return (async()=>{${route}})();`);
  await handler(pathname, { method, user: { permissions: ['inventory'] } }, {}, new URL(`http://localhost${pathname}`), { pool: client }, venue, denyUnless, async () => input, json, () => {});
  return response;
};
const callInventoryItemApi = async ({ pathname, method = 'POST', venue, input = {} }) => {
  let response;
  const json = (_res, status, data) => { response = { status, data }; return response; };
  const denyUnless = (req, res, permission) => { if (req.user?.permissions?.includes(permission)) return false; json(res, 403, { error: 'forbidden' }); return true; };
  const handler = new Function('pathname','req','res','url','repositories','venueDbId','denyUnless','body','json','recordAudit','inventory','stockMovements','beginPayrollSourceProducerTransaction', `return (async()=>{${source.slice(inventoryItemStart, inventoryItemEnd)}})();`);
  await handler(pathname, { method, user: { permissions: ['inventory'] } }, {}, new URL(`http://localhost${pathname}`), { pool: client, inventory: new InventoryRepository(client) }, venue, denyUnless, async () => input, json, () => {}, [], [], beginPayrollSourceProducerTransaction);
  return response;
};
const subdepartmentRoute = source.slice(subdepartmentStart, subdepartmentEnd);
const departmentRoute = source.slice(departmentStart, departmentEnd);
const subdepartmentPatchRoute = `const inventorySubdepartmentPath = pathname.match(/^\\/api\\/inventory\\/subdepartments\\/([^/]+)$/);${source.slice(subdepartmentPatchStart, subdepartmentPatchEnd)}`;
const subdepartmentDeleteRoute = `const inventorySubdepartmentPath = pathname.match(/^\\/api\\/inventory\\/subdepartments\\/([^/]+)$/);${source.slice(subdepartmentDeleteStart, subdepartmentDeleteEnd)}`;
const productCategoryCreateRoute = source.slice(productCategoryCreateStart, productCategoryCreateEnd);
const productCategoryPatchRoute = `const productCategoryPath = pathname.match(/^\\/api\\/product-categories\\/([^/]+)$/);${source.slice(productCategoryPatchStart, productCategoryPatchEnd)}`;
try {
  const identity = (await client.query(`SELECT current_database() AS database, inet_server_addr()::text AS address,
    inet_server_port() AS port, COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname=current_user),false) AS superuser`)).rows[0];
  assertQaDatabaseIdentity(identity, target.database, Number(target.url.port || 5432));
  venueId = (await client.query("INSERT INTO venues (name,organization_id) VALUES ('New venue inventory departments QA','00000000-0000-0000-0000-000000000010') RETURNING id")).rows[0].id;
  const departments = (await client.query('SELECT code,name FROM inventory_departments WHERE venue_id=$1 ORDER BY sort_order', [venueId])).rows;
  assert.deepEqual(departments, [
    { code: 'kitchen', name: 'Кухня' },
    { code: 'bar', name: 'Бар' },
    { code: 'hookah', name: 'Кальяны' },
    { code: 'inventory', name: 'Хозяйственный склад' },
  ], 'every newly created venue receives the default inventory departments');
  otherVenueId = (await client.query("INSERT INTO venues (name,organization_id) VALUES ('Other venue inventory hierarchy QA','00000000-0000-0000-0000-000000000010') RETURNING id")).rows[0].id;
  const privateDepartment = 'private-subdep-qa';
  await client.query('INSERT INTO inventory_departments (venue_id,code,name) VALUES ($1,$2,$3)', [venueId, privateDepartment, 'Частный тестовый цех']);
  const foreignParent = await callApi({ route: subdepartmentRoute, pathname: '/api/inventory/subdepartments', venue: otherVenueId, input: { departmentCode: privateDepartment, name: 'Чужой подцех' } });
  assert.equal(foreignParent.status, 400);
  assert.equal(foreignParent.data.error, 'inventory_department_not_found', 'subdepartment cannot point into another venue');
  const createdSubdepartment = await callApi({ route: subdepartmentRoute, pathname: '/api/inventory/subdepartments', venue: venueId, input: { departmentCode: 'bar', name: `Подцех QA ${Date.now()}` } });
  assert.equal(createdSubdepartment.status, 201, JSON.stringify(createdSubdepartment));
  const duplicateSubdepartment = await callApi({ route: subdepartmentRoute, pathname: '/api/inventory/subdepartments', venue: venueId, input: { departmentCode: createdSubdepartment.data.departmentCode, name: createdSubdepartment.data.name } });
  assert.equal(duplicateSubdepartment.status, 409);
  assert.equal(duplicateSubdepartment.data.error, 'inventory_subdepartment_exists');
  const scopedCategory = await callApi({ route: productCategoryCreateRoute, pathname: '/api/product-categories', venue: venueId, input: { department: 'bar', subdepartmentId: createdSubdepartment.data.id, name: 'Категория подцеха QA' } });
  assert.equal(scopedCategory.status, 201, JSON.stringify(scopedCategory));
  assert.equal(scopedCategory.data.subdepartmentId, createdSubdepartment.data.id, 'category is durably attached to its selected subdepartment');
  const storedScopedCategory = await client.query('SELECT department,subdepartment_id FROM product_categories WHERE venue_id=$1 AND id=$2', [venueId, scopedCategory.data.id]);
  assert.equal(storedScopedCategory.rows[0].department, 'bar');
  assert.equal(storedScopedCategory.rows[0].subdepartment_id, createdSubdepartment.data.id);
  const subdepartmentArchiveWithCategory = await callApi({ route: subdepartmentDeleteRoute, pathname: `/api/inventory/subdepartments/${createdSubdepartment.data.id}`, method: 'DELETE', venue: venueId });
  assert.equal(subdepartmentArchiveWithCategory.status, 409, 'a subdepartment linked by an active category cannot be archived');
  assert.equal(subdepartmentArchiveWithCategory.data.error, 'inventory_subdepartment_in_use');
  const renamedScopedCategory = await callApi({ route: productCategoryPatchRoute, pathname: `/api/product-categories/${scopedCategory.data.id}`, method: 'PATCH', venue: venueId, input: { department: 'bar', subdepartmentId: createdSubdepartment.data.id, name: 'Категория подцеха переименована QA' } });
  assert.equal(renamedScopedCategory.status, 200, JSON.stringify(renamedScopedCategory));
  const categoryAssignedToSubdepartment = await client.query('SELECT subdepartment_id FROM product_categories WHERE venue_id=$1 AND id=$2', [venueId, scopedCategory.data.id]);
  assert.equal(categoryAssignedToSubdepartment.rows[0].subdepartment_id, createdSubdepartment.data.id, 'category editing retains the explicit subdepartment link');
  const [categoryRaceItem, categoryMove] = await Promise.all([
    callInventoryItemApi({ pathname: '/api/inventory/items', venue: venueId, input: { name: 'Товар на переносе категории QA', department: 'bar', subdepartment: createdSubdepartment.data.name, category: renamedScopedCategory.data.name, itemType: 'ingredient', unit: 'г', cost: 1, packMultiplier: 1 } }),
    callApi({ route: productCategoryPatchRoute, pathname: `/api/product-categories/${scopedCategory.data.id}`, method: 'PATCH', venue: venueId, input: { department: 'kitchen', subdepartmentId: '', name: renamedScopedCategory.data.name } }),
  ]);
  assert.equal(categoryMove.status, 200, JSON.stringify(categoryMove));
  assert.ok(categoryRaceItem.status === 201 || categoryRaceItem.status === 400, `category assignment must either serialize before move or fail after it: ${JSON.stringify(categoryRaceItem)}`);
  if (categoryRaceItem.status === 400) assert.equal(categoryRaceItem.data.error, 'inventory_category_department_mismatch', 'a moved category is rejected instead of stored under its old department');
  const categoryRaceStoredItem = await client.query('SELECT department,subdepartment,category FROM ingredients WHERE venue_id=$1 AND name=$2 AND is_marked=true', [venueId, 'Товар на переносе категории QA']);
  if (categoryRaceStoredItem.rows[0]) assert.equal(categoryRaceStoredItem.rows[0].department, 'kitchen', 'an item created before category move follows the category into its new department');
  const protectedDepartment = await callApi({ route: departmentRoute, pathname: `/api/inventory/departments/${createdSubdepartment.data.departmentCode}`, method: 'DELETE', venue: venueId });
  assert.equal(protectedDepartment.status, 409);
  assert.equal(protectedDepartment.data.error, 'inventory_department_in_use', 'a department with an active child cannot be archived');
  const remainsActive = await client.query('SELECT is_active FROM inventory_departments WHERE venue_id=$1 AND code=$2', [venueId, createdSubdepartment.data.departmentCode]);
  assert.equal(remainsActive.rows[0]?.is_active, true);
  const raceDepartment = 'race-subdepartment-qa';
  await client.query('INSERT INTO inventory_departments (venue_id,code,name) VALUES ($1,$2,$3)', [venueId, raceDepartment, 'Проверка конкурентного архива']);
  const [racingCreate, racingArchive] = await Promise.all([
    callApi({ route: subdepartmentRoute, pathname: '/api/inventory/subdepartments', venue: venueId, input: { departmentCode: raceDepartment, name: 'Конкурентный подцех' } }),
    callApi({ route: departmentRoute, pathname: `/api/inventory/departments/${raceDepartment}`, method: 'DELETE', venue: venueId }),
  ]);
  const raceState = (await client.query(`SELECT d.is_active AS "departmentActive", EXISTS(SELECT 1 FROM inventory_subdepartments s WHERE s.venue_id=d.venue_id AND s.department_code=d.code AND s.is_active=true) AS "hasActiveSubdepartment" FROM inventory_departments d WHERE d.venue_id=$1 AND d.code=$2`, [venueId, raceDepartment])).rows[0];
  assert.ok((racingCreate.status === 201 && racingArchive.status === 409) || (racingCreate.status === 400 && racingArchive.status === 200), `create/archive should produce one valid serialized outcome: ${JSON.stringify([racingCreate, racingArchive])}`);
  assert.equal(raceState.departmentActive === false && raceState.hasActiveSubdepartment === true, false, 'an active subdepartment cannot be left under an archived parent');
  const moveTarget = 'race-reparent-target-qa';
  await client.query('INSERT INTO inventory_departments (venue_id,code,name) VALUES ($1,$2,$3)', [venueId, moveTarget, 'Проверка переноса']);
  const movable = await callApi({ route: subdepartmentRoute, pathname: '/api/inventory/subdepartments', venue: venueId, input: { departmentCode: 'bar', name: 'Подцех для конкурентного переноса' } });
  assert.equal(movable.status, 201, JSON.stringify(movable));
  const [racingMove, racingTargetArchive] = await Promise.all([
    callApi({ route: subdepartmentPatchRoute, pathname: `/api/inventory/subdepartments/${movable.data.id}`, method: 'PATCH', venue: venueId, input: { departmentCode: moveTarget, name: movable.data.name } }),
    callApi({ route: departmentRoute, pathname: `/api/inventory/departments/${moveTarget}`, method: 'DELETE', venue: venueId }),
  ]);
  assert.ok((racingMove.status === 200 && racingTargetArchive.status === 409) || (racingMove.status === 400 && racingTargetArchive.status === 200), `reparent/archive should produce one valid serialized outcome: ${JSON.stringify([racingMove, racingTargetArchive])}`);
  const movedState = (await client.query(`SELECT d.is_active AS "departmentActive", EXISTS(SELECT 1 FROM inventory_subdepartments s WHERE s.venue_id=d.venue_id AND s.department_code=d.code AND s.is_active=true) AS "hasActiveSubdepartment" FROM inventory_departments d WHERE d.venue_id=$1 AND d.code=$2`, [venueId, moveTarget])).rows[0];
  assert.equal(movedState.departmentActive === false && movedState.hasActiveSubdepartment === true, false, 'moving a subdepartment cannot leave it under an archived parent');
  const categoryRaceDepartment = 'race-category-create-qa';
  await client.query('INSERT INTO inventory_departments (venue_id,code,name) VALUES ($1,$2,$3)', [venueId, categoryRaceDepartment, 'Проверка категории']);
  const [racingCategoryCreate, racingCategoryArchive] = await Promise.all([
    callApi({ route: productCategoryCreateRoute, pathname: '/api/product-categories', venue: venueId, input: { department: categoryRaceDepartment, name: 'Категория QA create' } }),
    callApi({ route: departmentRoute, pathname: `/api/inventory/departments/${categoryRaceDepartment}`, method: 'DELETE', venue: venueId }),
  ]);
  assert.ok((racingCategoryCreate.status === 201 && racingCategoryArchive.status === 409) || (racingCategoryCreate.status === 400 && racingCategoryArchive.status === 200), `category create/archive should serialize: ${JSON.stringify([racingCategoryCreate, racingCategoryArchive])}`);
  const categoryCreateState = (await client.query(`SELECT d.is_active AS "departmentActive", EXISTS(SELECT 1 FROM product_categories c WHERE c.venue_id=d.venue_id AND c.department=d.code AND c.is_active=true) AS "hasActiveCategory" FROM inventory_departments d WHERE d.venue_id=$1 AND d.code=$2`, [venueId, categoryRaceDepartment])).rows[0];
  assert.equal(categoryCreateState.departmentActive === false && categoryCreateState.hasActiveCategory === true, false, 'category creation cannot commit under an archived parent');
  const categoryMoveTarget = 'race-category-move-qa';
  await client.query('INSERT INTO inventory_departments (venue_id,code,name) VALUES ($1,$2,$3)', [venueId, categoryMoveTarget, 'Проверка переноса категории']);
  const movableCategory = await callApi({ route: productCategoryCreateRoute, pathname: '/api/product-categories', venue: venueId, input: { department: 'bar', name: 'Категория QA move' } });
  assert.equal(movableCategory.status, 201, JSON.stringify(movableCategory));
  const [racingCategoryMove, racingCategoryTargetArchive] = await Promise.all([
    callApi({ route: productCategoryPatchRoute, pathname: `/api/product-categories/${movableCategory.data.id}`, method: 'PATCH', venue: venueId, input: { department: categoryMoveTarget, name: movableCategory.data.name } }),
    callApi({ route: departmentRoute, pathname: `/api/inventory/departments/${categoryMoveTarget}`, method: 'DELETE', venue: venueId }),
  ]);
  assert.ok((racingCategoryMove.status === 200 && racingCategoryTargetArchive.status === 409) || (racingCategoryMove.status === 400 && racingCategoryTargetArchive.status === 200), `category reparent/archive should serialize: ${JSON.stringify([racingCategoryMove, racingCategoryTargetArchive])}`);
  const categoryMoveState = (await client.query(`SELECT d.is_active AS "departmentActive", EXISTS(SELECT 1 FROM product_categories c WHERE c.venue_id=d.venue_id AND c.department=d.code AND c.is_active=true) AS "hasActiveCategory" FROM inventory_departments d WHERE d.venue_id=$1 AND d.code=$2`, [venueId, categoryMoveTarget])).rows[0];
  assert.equal(categoryMoveState.departmentActive === false && categoryMoveState.hasActiveCategory === true, false, 'category reassignment cannot commit under an archived parent');
  const itemRaceSubdepartment = await callApi({ route: subdepartmentRoute, pathname: '/api/inventory/subdepartments', venue: venueId, input: { departmentCode: 'bar', name: 'Подцех для гонки товара' } });
  assert.equal(itemRaceSubdepartment.status, 201, JSON.stringify(itemRaceSubdepartment));
  const [racingItemCreate, racingItemArchive] = await Promise.all([
    callInventoryItemApi({ pathname: '/api/inventory/items', venue: venueId, input: { name: 'Товар конкурентный QA', department: 'bar', subdepartment: itemRaceSubdepartment.data.name, category: 'Без категории', itemType: 'ingredient', unit: 'г', cost: 1, packMultiplier: 1 } }),
    callApi({ route: subdepartmentDeleteRoute, pathname: `/api/inventory/subdepartments/${itemRaceSubdepartment.data.id}`, method: 'DELETE', venue: venueId }),
  ]);
  assert.ok((racingItemCreate.status === 201 && racingItemArchive.status === 409) || (racingItemCreate.status === 400 && racingItemArchive.status === 200), `item create/archive should serialize: ${JSON.stringify([racingItemCreate, racingItemArchive])}`);
  const itemRaceState = (await client.query(`SELECT s.is_active AS "subdepartmentActive", EXISTS(SELECT 1 FROM ingredients i WHERE i.venue_id=s.venue_id AND i.department=s.department_code AND i.subdepartment=s.name AND i.is_marked=true) AS "hasActiveItem" FROM inventory_subdepartments s WHERE s.venue_id=$1 AND s.id=$2`, [venueId, itemRaceSubdepartment.data.id])).rows[0];
  assert.equal(itemRaceState.subdepartmentActive === false && itemRaceState.hasActiveItem === true, false, 'item creation cannot commit under an archived subdepartment');
  const itemMoveSubdepartment = await callApi({ route: subdepartmentRoute, pathname: '/api/inventory/subdepartments', venue: venueId, input: { departmentCode: 'bar', name: 'Подцех для переноса товара' } });
  const itemToMove = await callInventoryItemApi({ pathname: '/api/inventory/items', venue: venueId, input: { name: 'Товар для переноса QA', department: 'bar', subdepartment: '', category: 'Без категории', itemType: 'ingredient', unit: 'г', cost: 1, packMultiplier: 1 } });
  assert.equal(itemToMove.status, 201, JSON.stringify(itemToMove));
  const [racingItemMove, racingMoveTargetArchive] = await Promise.all([
    callInventoryItemApi({ pathname: `/api/inventory/items/${itemToMove.data.id}`, method: 'PATCH', venue: venueId, input: { subdepartment: itemMoveSubdepartment.data.name } }),
    callApi({ route: subdepartmentDeleteRoute, pathname: `/api/inventory/subdepartments/${itemMoveSubdepartment.data.id}`, method: 'DELETE', venue: venueId }),
  ]);
  assert.ok((racingItemMove.status === 200 && racingMoveTargetArchive.status === 409) || (racingItemMove.status === 400 && racingMoveTargetArchive.status === 200), `item reparent/archive should serialize: ${JSON.stringify([racingItemMove, racingMoveTargetArchive])}`);
  const itemMoveState = (await client.query(`SELECT s.is_active AS "subdepartmentActive", EXISTS(SELECT 1 FROM ingredients i WHERE i.venue_id=s.venue_id AND i.department=s.department_code AND i.subdepartment=s.name AND i.is_marked=true) AS "hasActiveItem" FROM inventory_subdepartments s WHERE s.venue_id=$1 AND s.id=$2`, [venueId, itemMoveSubdepartment.data.id])).rows[0];
  assert.equal(itemMoveState.subdepartmentActive === false && itemMoveState.hasActiveItem === true, false, 'item reassignment cannot commit under an archived subdepartment');
  const legacyDirectItem = await callInventoryItemApi({ pathname: '/api/inventory/items', venue: venueId, input: { name: 'Прямая позиция цеха QA', department: privateDepartment, subdepartment: '', category: 'Без категории', itemType: 'ingredient', unit: 'шт', cost: 1, packMultiplier: 1 } });
  assert.equal(legacyDirectItem.status, 201, JSON.stringify(legacyDirectItem));
  const directDepartmentArchive = await callApi({ route: departmentRoute, pathname: `/api/inventory/departments/${privateDepartment}`, method: 'DELETE', venue: venueId });
  assert.equal(directDepartmentArchive.status, 409, 'a department containing a direct-to-department item cannot be archived');
  const directItemEdit = await callInventoryItemApi({ pathname: `/api/inventory/items/${legacyDirectItem.data.id}`, method: 'PATCH', venue: venueId, input: { cost: 2 } });
  assert.equal(directItemEdit.status, 200, 'non-hierarchy item fields remain editable in an active direct-to-department setup');
  const itemConcurrency = await callInventoryItemApi({ pathname: '/api/inventory/items', venue: venueId, input: { name: 'Параллельное изменение QA', department: 'bar', subdepartment: '', category: 'Без категории', itemType: 'ingredient', unit: 'г', cost: 1, packMultiplier: 1 } });
  assert.equal(itemConcurrency.status, 201, JSON.stringify(itemConcurrency));
  const [hierarchyPatch, namePatch] = await Promise.all([
    callInventoryItemApi({ pathname: `/api/inventory/items/${itemConcurrency.data.id}`, method: 'PATCH', venue: venueId, input: { department: 'kitchen', subdepartment: '', category: 'Без категории' } }),
    callInventoryItemApi({ pathname: `/api/inventory/items/${itemConcurrency.data.id}`, method: 'PATCH', venue: venueId, input: { name: 'Параллельное изменение переименовано QA' } }),
  ]);
  assert.ok([200,409].includes(namePatch.status), `concurrent name edit is either serialized or asks for retry: ${JSON.stringify(namePatch)}`);
  assert.equal(hierarchyPatch.status, 200, JSON.stringify(hierarchyPatch));
  const concurrentFinal = await client.query('SELECT department,subdepartment,category FROM ingredients WHERE venue_id=$1 AND id=$2', [venueId, itemConcurrency.data.id]);
  assert.deepEqual(concurrentFinal.rows[0], { department: 'kitchen', subdepartment: '', category: 'Без категории' }, 'concurrent item PATCH cannot combine fields validated against a stale hierarchy');
  console.log('INVENTORY HIERARCHY POSTGRES API QA: PASS (tenant isolation, shared hierarchy locks, duplicate handling, active-child protection, and category/subdepartment/item create/archive/reparent/update concurrency)');
} finally {
  const venueIds = [venueId, otherVenueId].filter(Boolean);
  if (venueIds.length) await client.query('DELETE FROM venues WHERE id=ANY($1::uuid[])', [venueIds]).catch(() => {});
  await client.end();
}
