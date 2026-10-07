import { readFileSync, existsSync } from 'node:fs';

const portal = readFileSync(new URL('../portal.js', import.meta.url), 'utf8');
const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const migrations = [
  '018_inventory_departments.sql',
  '023_inventory_subdepartments.sql',
  '026_inventory_subdepartments_catalog.sql',
];
for (const file of migrations) {
  if (!existsSync(new URL(`../migrations/${file}`, import.meta.url))) throw new Error(`missing migration: ${file}`);
}
if (!portal.includes("id=\"inventory-item-subdepartment\"")) throw new Error('inventory item form has no subdepartment selector');
if (!portal.includes("querySelector('#inventory-item-subdepartment')") || !portal.includes('String(item.departmentCode) === department')) throw new Error('subdepartment options are not populated for the selected department');
if (!portal.includes('Подцех — где именно хранится?') || !portal.includes('Категория — что за похожие позиции?') || !portal.includes('Бар → Сиропы → Фруктовые сиропы')) throw new Error('inventory directory must explain the hierarchy and show a complete example');
if (!portal.includes('Без подцеха') || !portal.includes('Выберите созданный подцех')) throw new Error('inventory item form does not clarify that subdepartment is optional and directory-backed');
if (!portal.includes('id="inventory-subdepartment-section"')) throw new Error('subdepartment directory section is missing from the hierarchy view');
if (!portal.includes("document.querySelector('#inventory-subdepartment-list'); subdepartmentList.after(subdepartmentTools)")) throw new Error('subdepartment editor is not placed beside its directory');
if (!portal.includes("document.querySelector('#inventory-department-list').after(departmentTools)")) throw new Error('department editor is not placed beside its directory');
if (!portal.includes('data-subdepartment-retry') || !portal.includes('data-category-retry')) throw new Error('directory load errors need visible retry controls');
if (!portal.includes('target.insertBefore(categoryPanel, tobaccoCatalogPanel)')) throw new Error('primary warehouse hierarchy must appear before the secondary tobacco directory');
if (!portal.includes(' → весь цех') || !portal.includes(' · группа позиций') || !portal.includes('Активная категория')) throw new Error('category rows must show their hierarchy, purpose and status');
for (const status of ['status=all', 'inventoryDirectoryStatus', 'data-inventory-directory-status="archived"', 'Восстановить', 'Удалить навсегда', 'Запросить удаление']) if (!portal.includes(status)) throw new Error(`inventory directory lifecycle UI is missing ${status}`);
for (const route of ["url.searchParams.get('status')", 'inventoryDepartmentRestore', 'productCategoryRestore', 'inventorySubdepartmentRestore', '/api/inventory/deletion-requests', '/api/inventory/permanent-deletions', 'inventory_deletion_owner_required']) if (!server.includes(route)) throw new Error(`inventory archive/restore/delete API is missing ${route}`);
for (const contract of ["portalUser.role === 'owner'", "portalUser.role === 'manager'", 'window.confirm(`Владелец подтверждает окончательное удаление', 'requestDelete && !window.confirm', 'FOR UPDATE', "status='rejected'"]) {
  if (!portal.includes(contract) && !server.includes(contract)) throw new Error(`inventory deletion approval contract is missing ${contract}`);
}
if (!portal.includes('data-archive-type') || !portal.includes('data-restore-type') || !portal.includes('product-category-edit')) throw new Error('directory archive/restore actions are missing for authorized staff');
if (!portal.includes('syncInventoryHierarchyOptions')) throw new Error('inventory hierarchy option sync is missing');
for (const contract of ["'inventory_categories'", "inventory_categories: ['inventory_categories', 'inventory_read']", "inventory_categories: 'Справочник категорий склада'", "entityType === 'category' && canManageCategoryLifecycle", "archive && !(entityType === 'category' && canManageCategoryLifecycle)"]) {
  if (!server.includes(contract) && !portal.includes(contract)) throw new Error(`owner-configurable category lifecycle permission is missing ${contract}`);
}
if (!server.includes("&& entityType !== 'category') return json(res, 403, { error: 'inventory_category_permission_only' });")) throw new Error('category-only scope must not authorize department/subdepartment deletion requests');
if (!server.includes("if (req.user?.role !== 'owner') return json(res, 403, { error: 'inventory_deletion_owner_required' })")) throw new Error('final category deletion must remain owner-only');
if (!portal.includes("const subdepartmentSelect = document.querySelector('#inventory-subdepartment-department')") || !portal.includes('subdepartmentSelect.innerHTML = options')) throw new Error('subdepartment department options do not refresh when the department directory changes');
if (!portal.includes('if (departmentSelect && selectedDepartment && [...departmentSelect.options].some((option) => option.value === selectedDepartment)) departmentSelect.value = selectedDepartment')) throw new Error('new category form does not inherit the currently selected department');
if (!portal.includes('Выберите подцех из справочника выбранного цеха')) throw new Error('inventory hierarchy UX validation is missing');
if (!server.includes('validateInventoryHierarchy')) throw new Error('inventory hierarchy API validation is missing');
if (!server.includes("inventory_department_not_found") || !server.includes("inventory_subdepartment_not_found")) throw new Error('inventory hierarchy error contract is missing');
if (!portal.includes("path === '/api/inventory/auto-orders' && method === 'GET'")) throw new Error('demo auto-order recommendations endpoint is missing');
if (!portal.includes("path === '/api/inventory/auto-orders' && method === 'POST'")) throw new Error('demo auto-order creation endpoint is missing');
if (!portal.includes("const demoAutoOrderPath = path.match(/^\\/api\\/inventory\\/auto-orders\\/([^/]+)$/)")) throw new Error('demo auto-order status endpoint is missing');
console.log('INVENTORY HIERARCHY CONTRACT: PASS');
