import assert from 'node:assert/strict';
import { randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import pg from 'pg';
import { assertQaDatabaseIdentity, validateQaDatabaseUrl } from './postgres-qa-safety.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const databaseUrl = process.env.INVENTORY_CROSSFLOW_PG_TEST_DATABASE_URL;
const target = validateQaDatabaseUrl(databaseUrl, 'INVENTORY_CROSSFLOW_PG_TEST_DATABASE_URL');
assert.match(target.database, /^inventory_qa_[a-f0-9]{16}$/i, 'acceptance #44 requires a random disposable inventory database');
assert.equal(target.database, process.env.LOCAL_FULL_PG_OWNED_DATABASE, 'only the local regression runner may own this database');
assert.equal(process.env.MIGRATIONS_PG_TEST_DOCKER_CONTAINER, 'hookah-full-regression-qa-20261001', 'only the declared disposable QA container may own this database');
const runnerLockPath = path.join(root, 'tmp', 'full-local-qa', 'pg-regression-runner.lock');
const runnerLock = JSON.parse(fs.readFileSync(runnerLockPath, 'utf8'));
assert.equal(Number(runnerLock.pid), process.ppid, 'the regression runner currently owns the database lock');
assert.match(runnerLock.id || '', /^[0-9a-f-]{36}$/i, 'the regression runner lock has a valid ownership ID');
const playwrightPath = process.env.PLAYWRIGHT_PACKAGE_PATH;
assert.ok(playwrightPath, 'Set PLAYWRIGHT_PACKAGE_PATH');
const { chromium } = createRequire(import.meta.url)(playwrightPath);
const db = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
const marker = randomBytes(4).toString('hex');
const ids = { organization: randomUUID(), venue: randomUUID(), owner: randomUUID(), shift: randomUUID() };
const ownerLogin = `qa44-owner-${marker}`;
const ownerPassword = `qa44-${randomUUID()}`;
const categoryName = `QA44 Кальянные смеси ${marker}`;
const ingredientNames = [`QA44 Табак Ягода ${marker}`, `QA44 Табак Мята ${marker}`];
const productNames = [`QA44 Ремикс Ягода ${marker}`, `QA44 Ремикс Мята ${marker}`];
let connected = false;
let server;
let serverExit;
let serverShutdownFailed = false;
let browser;
let context;
let page;
let passed = false;
let checks = 0;
let output = '';
const check = (condition, message) => { assert.ok(condition, message); checks++; };
const hash = (value) => {
  const salt = randomBytes(16).toString('hex');
  return `scrypt$${salt}$${scryptSync(value, salt, 64).toString('hex')}`;
};
const waitForServer = async () => {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const match = output.match(/CRM running on http:\/\/localhost:(\d+)/);
    if (match) return `http://127.0.0.1:${match[1]}`;
    if (server.exitCode !== null) throw new Error(`QA server exited before startup: ${output}`);
    await delay(50);
  }
  throw new Error(`QA server did not start within 20 seconds: ${output}`);
};
const balance = async (ingredientId) => Number((await db.query(`SELECT COALESCE(SUM(CASE WHEN direction IN ('in','transfer','adjustment') THEN quantity WHEN direction IN ('out','waste') THEN -quantity ELSE 0 END),0)::numeric AS balance FROM stock_movements WHERE venue_id=$1 AND ingredient_id=$2`, [ids.venue, ingredientId])).rows[0].balance);
const selectCustomOption = async (selectId, value) => {
  const wrapper = page.locator(`#${selectId}`).locator('xpath=..');
  await wrapper.locator('.custom-select-trigger').click();
  await wrapper.locator(`.custom-select-menu [data-value="${value}"]`).click();
};
const createIngredient = async (name, categoryId, { unit = 'г', purchaseUnit = 'пачка', packMultiplier = '100', minLevel = '0', cost = '0' } = {}) => {
  await page.locator('#inventory-header-actions [data-inventory-header-action="item"]').click();
  await page.locator('#inventory-item-form').waitFor({ state: 'visible' });
  await page.locator('#inventory-item-name').fill(name);
  await page.locator('#inventory-item-department').selectOption('hookah');
  await page.locator(`#inventory-item-category option[value="${categoryId}"]`).waitFor({ state: 'attached' });
  await page.locator('#inventory-item-category').selectOption(categoryId);
  await page.locator('#inventory-item-type').selectOption('ingredient');
  await page.locator('#inventory-item-unit').selectOption({ label: unit });
  await page.locator('#inventory-item-purchase-unit').fill(purchaseUnit);
  await page.locator('#inventory-item-pack').fill(packMultiplier);
  await page.locator('#inventory-item-cost').fill(cost);
  await page.locator('#inventory-item-min').fill(minLevel);
  const responsePromise = page.waitForResponse((response) => response.request().method() === 'POST' && response.url().endsWith('/api/inventory/items'));
  await page.locator('#inventory-item-form button[type="submit"]').click();
  const response = await responsePromise;
  assert.equal(response.status(), 201, 'inventory item is created from its visible form'); checks++;
  await page.locator('#inventory-header-actions [data-inventory-header-action="item"]').waitFor({ state: 'visible' });
  return (await response.json());
};
const createProduct = async (name) => {
  await page.goto(`${base}/inventory?view=products`, { waitUntil: 'networkidle' });
  await page.locator('#new-product').waitFor({ state: 'visible' });
  await page.locator('#new-product').click();
  await page.locator('#product-form').waitFor({ state: 'visible' });
  await page.locator('#product-name').fill(name);
  await page.locator('#product-category').fill('Кальяны');
  await page.locator('#product-price').fill('500');
  await page.locator('#product-inventory-mode').selectOption('tracked');
  const responsePromise = page.waitForResponse((response) => response.request().method() === 'POST' && response.url().endsWith('/api/products'));
  await page.locator('#save-product').click();
  const response = await responsePromise;
  assert.equal(response.status(), 201, 'tracked menu product is created from the catalog UI'); checks++;
  const product = await response.json();
  await page.locator(`#visual-catalog .visual-product[data-product-id="${product.id}"]`).waitFor({ state: 'visible' });
  return product;
};
const createRecipe = async (name, productId, ingredientId, quantity, { recipeType = 'sale', yieldQuantity = '1', yieldUnit = 'порция' } = {}) => {
  await page.goto(`${base}/inventory?view=recipes`, { waitUntil: 'networkidle' });
  await page.locator('#new-recipe').waitFor({ state: 'visible' });
  await page.locator('#new-recipe').click();
  await page.locator('#recipe-form').waitFor({ state: 'visible' });
  await page.locator('#recipe-name').fill(name);
  await page.locator('#recipe-category').fill('Кальяны');
  if (productId) {
    await page.locator(`#recipe-product option[value="${productId}"]`).waitFor({ state: 'attached' });
    await page.locator('#recipe-product').selectOption(productId);
  }
  await page.locator('#recipe-type').selectOption(recipeType);
  await page.locator('#recipe-yield-quantity').fill(yieldQuantity);
  await page.locator('#recipe-yield-unit').selectOption(yieldUnit);
  await page.locator('#recipe-portion-count').fill('1');
  await page.locator('#recipe-wizard-next').click();
  await page.locator(`#recipe-ingredient-select option[value="${ingredientId}"]`).waitFor({ state: 'attached' });
  await selectCustomOption('recipe-ingredient-select', ingredientId);
  await page.locator('#recipe-ingredient-quantity').fill(quantity);
  await page.locator('#recipe-add-ingredient').click();
  await page.locator('#recipe-wizard-next').click();
  await page.locator('#recipe-wizard-next').click();
  const saveResponse = page.waitForResponse((response) => response.request().method() === 'POST' && response.url().endsWith('/api/recipes'));
  await page.locator('#recipe-form button[type="submit"]').click();
  const response = await saveResponse;
  assert.equal(response.status(), 201, 'recipe wizard saves the linked card'); checks++;
  return response.json();
};

let base = '';
try {
  await db.connect(); connected = true;
  const identity = (await db.query(`SELECT current_database() AS database,inet_server_addr()::text AS address,inet_server_port() AS port,COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname=current_user),false) AS superuser`)).rows[0];
  assertQaDatabaseIdentity(identity, target.database, Number(target.url.port || 5432), 'acceptance #44 browser PostgreSQL QA');

  await db.query('BEGIN');
  try {
    await db.query('INSERT INTO organizations(id,name,slug,timezone) VALUES($1,$2,$3,$4)', [ids.organization, 'QA44 inventory crossflow', `qa44-${ids.organization}`, 'Asia/Yekaterinburg']);
    await db.query("INSERT INTO organization_subscriptions(organization_id,status) VALUES($1,'trialing')", [ids.organization]);
    await db.query('INSERT INTO venues(id,organization_id,name,timezone) VALUES($1,$2,$3,$4)', [ids.venue, ids.organization, `QA44 Venue ${marker}`, 'Asia/Yekaterinburg']);
    await db.query(`INSERT INTO users(id,organization_id,venue_id,full_name,login,password_hash,role,permission_scopes)
      VALUES($1,$2,$3,'QA44 synthetic owner',$4,$5,'owner','[]'::jsonb)`, [ids.owner, ids.organization, ids.venue, ownerLogin, hash(ownerPassword)]);
    await db.query("INSERT INTO organization_memberships(organization_id,user_id,membership_role,status) VALUES($1,$2,'owner','active')", [ids.organization, ids.owner]);
    await db.query("INSERT INTO inventory_departments(venue_id,code,name) VALUES($1,'hookah','Кальяны') ON CONFLICT(venue_id,code) DO NOTHING", [ids.venue]);
    await db.query('INSERT INTO shifts(id,venue_id,opened_by,opening_cash) VALUES($1,$2,$3,0)', [ids.shift, ids.venue, ids.owner]);
    await db.query('COMMIT');
  } catch (error) { await db.query('ROLLBACK'); throw error; }

  server = spawn(process.execPath, ['server.js'], {
    cwd: root, windowsHide: true,
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', DATABASE_URL: target.url.href, VENUE_ID: ids.venue, AUTH_REQUIRED: 'true', DEMO_MODE: 'false', NODE_ENV: 'test', API_RATE_LIMIT: '5000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverExit = new Promise((resolve) => server.once('exit', resolve));
  server.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
  server.stderr.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
  base = await waitForServer();
  const health = await fetch(`${base}/api/health`);
  assert.equal(health.status, 200, 'QA server is healthy'); checks++;
  assert.equal((await health.json()).database, 'postgres', 'browser flow is backed by PostgreSQL'); checks++;

  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ru-RU' });
  page = await context.newPage();
  const pageErrors = [];
  const apiFailures = [];
  let captureApiFailures = false;
  page.on('pageerror', (error) => { if (error.message !== 'Transition was aborted because of invalid state. ViewTransition opt-in disabled') pageErrors.push(error.stack || error.message); });
  page.on('response', (response) => {
    if (captureApiFailures && new URL(response.url()).pathname.startsWith('/api/') && response.status() >= 400) apiFailures.push({ status: response.status(), url: new URL(response.url()).pathname });
  });
  await page.goto(`${base}/login`, { waitUntil: 'networkidle' });
  await page.locator('#login-username').fill(ownerLogin);
  await page.locator('#login-password').fill(ownerPassword);
  captureApiFailures = true;
  await page.locator('#login-form button[type="submit"]').click();
  await page.waitForURL((url) => url.pathname !== '/login');
  check(Boolean(await page.evaluate(() => localStorage.getItem('crm_session_token'))), 'owner password UI login establishes a real session; no PIN is configured');

  await page.goto(`${base}/inventory?view=directories`, { waitUntil: 'networkidle' });
  await page.locator('#inventory-header-actions [data-inventory-header-action="category"]').waitFor({ state: 'visible' });
  await page.locator('#inventory-header-actions [data-inventory-header-action="category"]').click();
  await page.locator('#product-category-form').waitFor({ state: 'visible' });
  await page.locator('#product-category-name').fill(categoryName);
  await page.locator('#product-category-department').selectOption('hookah');
  const categoryResponsePromise = page.waitForResponse((response) => response.request().method() === 'POST' && response.url().endsWith('/api/product-categories'));
  await page.locator('#product-category-form button[type="submit"]').click();
  const categoryResponse = await categoryResponsePromise;
  assert.equal(categoryResponse.status(), 201, 'category is created from the inventory directory UI'); checks++;
  const category = await categoryResponse.json();
  const categoryReadback = await page.evaluate(async () => {
    const response = await fetch('/api/product-categories', { headers: { Authorization: `Bearer ${localStorage.getItem('crm_session_token')}` } });
    return { status: response.status, body: await response.json() };
  });
  assert.equal(categoryReadback.status, 200); checks++;
  assert.ok(categoryReadback.body.items.some((item) => item.id === category.id && item.department === 'hookah'), 'fresh category readback returns the saved hookah category'); checks++;

  const directoryReadback = await page.evaluate(async () => {
    const headers = { Authorization: `Bearer ${localStorage.getItem('crm_session_token')}` };
    const [departments, subdepartments] = await Promise.all([
      fetch('/api/inventory/departments', { headers }), fetch('/api/inventory/subdepartments?status=all', { headers }),
    ]);
    return { departmentsStatus: departments.status, departments: await departments.json(), subdepartmentsStatus: subdepartments.status, subdepartments: await subdepartments.json() };
  });
  assert.equal(directoryReadback.departmentsStatus, 200); checks++;
  assert.equal(directoryReadback.subdepartmentsStatus, 200); checks++;
  const barDepartment = directoryReadback.departments.items.find((item) => item.code === 'bar' && item.active);
  assert.ok(barDepartment, 'synthetic venue has the active seeded Бар parent department'); checks++;
  const hierarchyBaseline = await db.query(`SELECT
      (SELECT count(*)::int FROM inventory_subdepartments WHERE venue_id=$1) AS subdepartments,
      (SELECT count(*)::int FROM product_categories WHERE venue_id=$1) AS categories,
      (SELECT count(*)::int FROM stock_movements WHERE venue_id=$1) AS movements,
      (SELECT count(*)::int FROM order_costs WHERE venue_id=$1) AS cogs_rows,
      COALESCE((SELECT sum(cost) FROM order_costs WHERE venue_id=$1),0)::numeric AS cogs_total`, [ids.venue]);
  const syntheticSubdepartmentName = `QA44 Бар напитки ${marker}`;
  await page.locator('#inventory-header-actions [data-inventory-header-action="subdepartment"]').click();
  const subdepartmentForm = page.locator('#inventory-subdepartment-list + form.department-editor');
  await subdepartmentForm.waitFor({ state: 'visible' });
  await page.locator('#inventory-subdepartment-department').selectOption('bar');
  await page.locator('#inventory-subdepartment-name').fill(syntheticSubdepartmentName);
  const subdepartmentResponsePromise = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/inventory/subdepartments');
  await subdepartmentForm.locator('button[type="submit"]').click();
  const subdepartmentResponse = await subdepartmentResponsePromise;
  assert.equal(subdepartmentResponse.status(), 201, 'directory UI creates a subdepartment under Бар'); checks++;
  assert.deepEqual(subdepartmentResponse.request().postDataJSON(), { name: syntheticSubdepartmentName, departmentCode: 'bar' }); checks++;
  const subdepartment = await subdepartmentResponse.json();
  assert.deepEqual({ departmentCode: subdepartment.departmentCode, name: subdepartment.name, active: subdepartment.active }, { departmentCode: 'bar', name: syntheticSubdepartmentName, active: true }); checks++;

  const syntheticSubdepartmentCategoryName = `QA44 Бар категория ${marker}`;
  await page.locator('#inventory-header-actions [data-inventory-header-action="category"]').click();
  await page.locator('#product-category-form').waitFor({ state: 'visible' });
  await page.locator('#product-category-name').fill(syntheticSubdepartmentCategoryName);
  await page.locator('#product-category-department').selectOption('bar');
  await page.locator(`#product-category-subdepartment option[value="${subdepartment.id}"]`).waitFor({ state: 'attached' });
  await page.locator('#product-category-subdepartment').selectOption(subdepartment.id);
  const subdepartmentCategoryResponsePromise = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/product-categories');
  await page.locator('#product-category-form button[type="submit"]').click();
  const subdepartmentCategoryResponse = await subdepartmentCategoryResponsePromise;
  assert.equal(subdepartmentCategoryResponse.status(), 201, 'directory UI creates a category linked to the selected subdepartment'); checks++;
  assert.deepEqual(subdepartmentCategoryResponse.request().postDataJSON(), { name: syntheticSubdepartmentCategoryName, department: 'bar', subdepartmentId: subdepartment.id }); checks++;
  const subdepartmentCategory = await subdepartmentCategoryResponse.json();
  assert.deepEqual({ name: subdepartmentCategory.name, department: subdepartmentCategory.department, subdepartmentId: subdepartmentCategory.subdepartmentId, subdepartmentName: subdepartmentCategory.subdepartmentName, active: subdepartmentCategory.active }, {
    name: syntheticSubdepartmentCategoryName, department: 'bar', subdepartmentId: subdepartment.id, subdepartmentName: syntheticSubdepartmentName, active: true,
  }); checks++;

  await page.reload({ waitUntil: 'networkidle' });
  const reloadedDepartment = page.locator('#inventory-department-list .category-row').filter({ hasText: 'Бар' });
  await reloadedDepartment.waitFor({ state: 'visible' });
  assert.match(await reloadedDepartment.innerText(), /Бар/, 'full reload still shows the parent department'); checks++;
  const reloadedSubdepartment = page.locator('#inventory-subdepartment-list .category-row').filter({ hasText: syntheticSubdepartmentName });
  await reloadedSubdepartment.waitFor({ state: 'visible' });
  assert.match(await reloadedSubdepartment.innerText(), /Цех:\s*Бар/, 'full reload shows the subdepartment under Бар'); checks++;
  const reloadedSubdepartmentCategory = page.locator('#product-category-list .category-row').filter({ hasText: syntheticSubdepartmentCategoryName });
  await reloadedSubdepartmentCategory.waitFor({ state: 'visible' });
  const reloadedHierarchyText = await reloadedSubdepartmentCategory.innerText();
  assert.ok(reloadedHierarchyText.toLocaleLowerCase('ru-RU').includes(`Бар → ${syntheticSubdepartmentName}`.toLocaleLowerCase('ru-RU')), `full reload shows the category under Бар → its subdepartment: ${JSON.stringify(reloadedHierarchyText)}`); checks++;
  const hierarchyApiReadback = await page.evaluate(async () => {
    const headers = { Authorization: `Bearer ${localStorage.getItem('crm_session_token')}` };
    const [departments, subdepartments, categories] = await Promise.all([
      fetch('/api/inventory/departments', { headers }), fetch('/api/inventory/subdepartments?status=all', { headers }), fetch('/api/product-categories?status=all', { headers }),
    ]);
    return { departmentsStatus: departments.status, departments: await departments.json(), subdepartmentsStatus: subdepartments.status, subdepartments: await subdepartments.json(), categoriesStatus: categories.status, categories: await categories.json() };
  });
  assert.deepEqual([hierarchyApiReadback.departmentsStatus, hierarchyApiReadback.subdepartmentsStatus, hierarchyApiReadback.categoriesStatus], [200, 200, 200]); checks++;
  assert.ok(hierarchyApiReadback.departments.items.some((item) => item.code === 'bar' && item.name === 'Бар' && item.active), 'fresh department API still returns the active Бар parent'); checks++;
  assert.ok(hierarchyApiReadback.subdepartments.items.some((item) => item.id === subdepartment.id && item.departmentCode === 'bar' && item.name === syntheticSubdepartmentName && item.active), 'fresh subdepartment API returns its saved parent and name'); checks++;
  assert.ok(hierarchyApiReadback.categories.items.some((item) => item.id === subdepartmentCategory.id && item.department === 'bar' && item.subdepartmentId === subdepartment.id && item.subdepartmentName === syntheticSubdepartmentName && item.active), 'fresh category API returns the full saved hierarchy'); checks++;
  const hierarchyPersisted = await db.query(`SELECT d.code AS department_code,d.name AS department_name,d.is_active AS department_active,
      sd.id AS subdepartment_id,sd.name AS subdepartment_name,sd.department_code AS subdepartment_department_code,sd.is_active AS subdepartment_active,
      c.id AS category_id,c.name AS category_name,c.department AS category_department,c.subdepartment_id AS category_subdepartment_id,c.is_active AS category_active
    FROM inventory_departments d
    JOIN inventory_subdepartments sd ON sd.venue_id=d.venue_id AND sd.department_code=d.code
    JOIN product_categories c ON c.venue_id=sd.venue_id AND c.subdepartment_id=sd.id
    WHERE d.venue_id=$1 AND d.code='bar' AND sd.id=$2 AND c.id=$3`, [ids.venue, subdepartment.id, subdepartmentCategory.id]);
  assert.equal(hierarchyPersisted.rowCount, 1, 'exact hierarchy links persist together in the synthetic venue'); checks++;
  assert.deepEqual(hierarchyPersisted.rows[0], {
    department_code: 'bar', department_name: 'Бар', department_active: true,
    subdepartment_id: subdepartment.id, subdepartment_name: syntheticSubdepartmentName, subdepartment_department_code: 'bar', subdepartment_active: true,
    category_id: subdepartmentCategory.id, category_name: syntheticSubdepartmentCategoryName, category_department: 'bar', category_subdepartment_id: subdepartment.id, category_active: true,
  }); checks++;
  const hierarchyAfter = await db.query(`SELECT
      (SELECT count(*)::int FROM inventory_subdepartments WHERE venue_id=$1) AS subdepartments,
      (SELECT count(*)::int FROM product_categories WHERE venue_id=$1) AS categories,
      (SELECT count(*)::int FROM stock_movements WHERE venue_id=$1) AS movements,
      (SELECT count(*)::int FROM order_costs WHERE venue_id=$1) AS cogs_rows,
      COALESCE((SELECT sum(cost) FROM order_costs WHERE venue_id=$1),0)::numeric AS cogs_total`, [ids.venue]);
  assert.equal(Number(hierarchyAfter.rows[0].subdepartments), Number(hierarchyBaseline.rows[0].subdepartments) + 1); checks++;
  assert.equal(Number(hierarchyAfter.rows[0].categories), Number(hierarchyBaseline.rows[0].categories) + 1); checks++;
  assert.equal(Number(hierarchyAfter.rows[0].movements), Number(hierarchyBaseline.rows[0].movements), 'directory creation does not create stock movements'); checks++;
  assert.equal(Number(hierarchyAfter.rows[0].cogs_rows), Number(hierarchyBaseline.rows[0].cogs_rows)); checks++;
  assert.equal(Number(hierarchyAfter.rows[0].cogs_total), Number(hierarchyBaseline.rows[0].cogs_total)); checks++;

  const renamedSubdepartmentCategoryName = `QA44 Бар категория обновлена ${marker}`;
  await reloadedSubdepartmentCategory.locator('.product-category-edit').click();
  await page.locator('#product-category-form').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#product-category-id').inputValue(), subdepartmentCategory.id, 'category editor reopens the synthetic linked category'); checks++;
  assert.equal(await page.locator('#product-category-name').inputValue(), syntheticSubdepartmentCategoryName, 'category edit form prefills the existing name'); checks++;
  assert.equal(await page.locator('#product-category-department').inputValue(), 'bar', 'category edit form prefills its parent department'); checks++;
  assert.equal(await page.locator('#product-category-subdepartment').inputValue(), subdepartment.id, 'category edit form prefills its linked subdepartment'); checks++;
  await page.locator('#product-category-name').fill(renamedSubdepartmentCategoryName);
  const categoryEditResponsePromise = page.waitForResponse((response) => response.request().method() === 'PATCH' && new URL(response.url()).pathname === `/api/product-categories/${subdepartmentCategory.id}`);
  await page.locator('#product-category-form button[type="submit"]').click();
  const categoryEditResponse = await categoryEditResponsePromise;
  assert.equal(categoryEditResponse.status(), 200, 'editing the linked category sends a successful PATCH'); checks++;
  assert.deepEqual(categoryEditResponse.request().postDataJSON(), { name: renamedSubdepartmentCategoryName, department: 'bar', subdepartmentId: subdepartment.id }); checks++;
  const categoryEditBody = await categoryEditResponse.json();
  assert.deepEqual({ name: categoryEditBody.name, department: categoryEditBody.department, subdepartmentId: categoryEditBody.subdepartmentId, subdepartmentName: categoryEditBody.subdepartmentName, active: categoryEditBody.active }, {
    name: renamedSubdepartmentCategoryName, department: 'bar', subdepartmentId: subdepartment.id, subdepartmentName: syntheticSubdepartmentName, active: true,
  }); checks++;
  const renamedCategoryRow = page.locator('#product-category-list .category-row').filter({ hasText: renamedSubdepartmentCategoryName });
  await renamedCategoryRow.waitFor({ state: 'visible' });
  assert.ok((await renamedCategoryRow.innerText()).toLocaleLowerCase('ru-RU').includes(`бар → ${syntheticSubdepartmentName}`.toLocaleLowerCase('ru-RU')), 'updated category still displays its department and subdepartment'); checks++;
  await page.reload({ waitUntil: 'networkidle' });
  const reloadedRenamedCategoryRow = page.locator('#product-category-list .category-row').filter({ hasText: renamedSubdepartmentCategoryName });
  await reloadedRenamedCategoryRow.waitFor({ state: 'visible' });
  assert.ok((await reloadedRenamedCategoryRow.innerText()).toLocaleLowerCase('ru-RU').includes(`бар → ${syntheticSubdepartmentName}`.toLocaleLowerCase('ru-RU')), 'full reload preserves the edited category hierarchy'); checks++;
  const editedHierarchyCategories = await page.evaluate(async () => {
    const response = await fetch('/api/product-categories?status=all', { headers: { Authorization: `Bearer ${localStorage.getItem('crm_session_token')}` } });
    return { status: response.status, body: await response.json() };
  });
  assert.equal(editedHierarchyCategories.status, 200); checks++;
  assert.ok(editedHierarchyCategories.body.items.some((item) => item.id === subdepartmentCategory.id && item.name === renamedSubdepartmentCategoryName && item.department === 'bar' && item.subdepartmentId === subdepartment.id && item.subdepartmentName === syntheticSubdepartmentName && item.active), 'fresh category API preserves its edited name and saved hierarchy'); checks++;
  const editedCategoryPg = await db.query('SELECT name,department,subdepartment_id::text AS subdepartment_id,is_active FROM product_categories WHERE id=$1 AND venue_id=$2', [subdepartmentCategory.id, ids.venue]);
  assert.deepEqual(editedCategoryPg.rows, [{ name: renamedSubdepartmentCategoryName, department: 'bar', subdepartment_id: subdepartment.id, is_active: true }], 'PostgreSQL preserves the renamed category and subdepartment relation'); checks++;
  const hierarchyAfterEdit = await db.query(`SELECT
      (SELECT count(*)::int FROM inventory_subdepartments WHERE venue_id=$1) AS subdepartments,
      (SELECT count(*)::int FROM product_categories WHERE venue_id=$1) AS categories,
      (SELECT count(*)::int FROM stock_movements WHERE venue_id=$1) AS movements,
      (SELECT count(*)::int FROM order_costs WHERE venue_id=$1) AS cogs_rows,
      COALESCE((SELECT sum(cost) FROM order_costs WHERE venue_id=$1),0)::numeric AS cogs_total`, [ids.venue]);
  assert.deepEqual(hierarchyAfterEdit.rows[0], hierarchyAfter.rows[0], 'renaming a directory category does not change inventory, movements or COGS'); checks++;

  const servedPortalHandler = await page.evaluate(async () => fetch('/portal.js?rev=454').then((response) => response.text()));
  assert.match(servedPortalHandler, /await loadSubdepartments\(\); await loadProductCategories\(\);/, 'the browser receives the current dependent-directory refresh handler'); checks++;
  await page.locator('[data-inventory-department=""]').click();
  const subdepartmentEditRow = page.locator('#inventory-subdepartment-list .category-row').filter({ hasText: syntheticSubdepartmentName });
  await subdepartmentEditRow.locator('.subdepartment-edit').click();
  await subdepartmentForm.waitFor({ state: 'visible' });
  assert.equal(await page.locator('#inventory-subdepartment-name').inputValue(), syntheticSubdepartmentName, 'subdepartment editor prefills the existing name'); checks++;
  assert.equal(await page.locator('#inventory-subdepartment-department').inputValue(), 'bar', 'subdepartment editor prefills its current parent department'); checks++;
  await page.locator('#inventory-subdepartment-department').selectOption('hookah');
  const subdepartmentRefreshResponsePromise = page.waitForResponse((response) => response.request().method() === 'GET' && new URL(response.url()).pathname === '/api/inventory/subdepartments' && new URL(response.url()).searchParams.get('status') === 'all', { timeout: 5000 });
  const categoryRefreshResponsePromise = page.waitForResponse((response) => response.request().method() === 'GET' && new URL(response.url()).pathname === '/api/product-categories' && new URL(response.url()).searchParams.get('status') === 'all', { timeout: 5000 });
  const reparentResponsePromise = page.waitForResponse((response) => response.request().method() === 'PATCH' && new URL(response.url()).pathname === `/api/inventory/subdepartments/${subdepartment.id}`);
  await subdepartmentForm.locator('button[type="submit"]').click();
  const reparentResponse = await reparentResponsePromise;
  assert.equal(reparentResponse.status(), 200, 'subdepartment UI reparent sends a successful PATCH'); checks++;
  assert.deepEqual(reparentResponse.request().postDataJSON(), { name: syntheticSubdepartmentName, departmentCode: 'hookah' }, 'subdepartment PATCH keeps its name and changes only the selected parent'); checks++;
  assert.deepEqual(await reparentResponse.json().then(({ departmentCode, name, active }) => ({ departmentCode, name, active })), { departmentCode: 'hookah', name: syntheticSubdepartmentName, active: true }); checks++;
  const refreshedSubdepartmentResponse = await subdepartmentRefreshResponsePromise;
  assert.equal(refreshedSubdepartmentResponse.status(), 200, 'UI refreshes the subdepartment list after PATCH'); checks++;
  const refreshedSubdepartmentPayload = await refreshedSubdepartmentResponse.json();
  assert.ok(refreshedSubdepartmentPayload.items.some((item) => item.id === subdepartment.id && item.departmentCode === 'hookah'), 'subdepartment refresh reads the committed new parent'); checks++;
  const refreshedCategoryResponse = await categoryRefreshResponsePromise;
  assert.equal(refreshedCategoryResponse.status(), 200, 'UI refreshes linked categories after PATCH'); checks++;
  const refreshedCategoryPayload = await refreshedCategoryResponse.json();
  assert.ok(refreshedCategoryPayload.items.some((item) => item.id === subdepartmentCategory.id && item.department === 'hookah'), 'category refresh reads the committed linked parent'); checks++;
  const immediatelyMovedSubdepartment = page.locator('#inventory-subdepartment-list .category-row').filter({ hasText: syntheticSubdepartmentName }).filter({ hasText: /Цех:\s*Кальяны/ });
  await immediatelyMovedSubdepartment.waitFor({ state: 'visible' });
  assert.match(await immediatelyMovedSubdepartment.innerText(), /Цех:\s*Кальяны/, 'subdepartment parent label refreshes immediately after PATCH'); checks++;
  const immediatelyMovedCategory = page.locator('#product-category-list .category-row').filter({ hasText: renamedSubdepartmentCategoryName }).filter({ hasText: /Кальяны\s*→/i });
  await immediatelyMovedCategory.waitFor({ state: 'visible' });
  const immediatelyMovedCategoryText = await immediatelyMovedCategory.innerText();
  assert.ok(immediatelyMovedCategoryText.toLocaleLowerCase('ru-RU').includes(`кальяны → ${syntheticSubdepartmentName}`.toLocaleLowerCase('ru-RU')), `linked category breadcrumb refreshes immediately after PATCH: ${JSON.stringify(immediatelyMovedCategoryText)}`); checks++;
  const movedHierarchyApi = await page.evaluate(async () => {
    const headers = { Authorization: `Bearer ${localStorage.getItem('crm_session_token')}` };
    const [subdepartments, categories] = await Promise.all([
      fetch('/api/inventory/subdepartments?status=all', { headers }), fetch('/api/product-categories?status=all', { headers }),
    ]);
    return { subdepartmentsStatus: subdepartments.status, subdepartments: await subdepartments.json(), categoriesStatus: categories.status, categories: await categories.json() };
  });
  assert.deepEqual([movedHierarchyApi.subdepartmentsStatus, movedHierarchyApi.categoriesStatus], [200, 200]); checks++;
  assert.ok(movedHierarchyApi.subdepartments.items.some((item) => item.id === subdepartment.id && item.departmentCode === 'hookah' && item.name === syntheticSubdepartmentName && item.active), 'fresh subdepartment API readback returns the new parent'); checks++;
  assert.ok(movedHierarchyApi.categories.items.some((item) => item.id === subdepartmentCategory.id && item.name === renamedSubdepartmentCategoryName && item.department === 'hookah' && item.subdepartmentId === subdepartment.id && item.subdepartmentName === syntheticSubdepartmentName && item.active), 'fresh category API readback returns the linked category under the new parent'); checks++;
  const movedHierarchyPg = await db.query(`SELECT d.code AS department_code,d.name AS department_name,sd.id AS subdepartment_id,sd.name AS subdepartment_name,sd.department_code AS subdepartment_department_code,
      c.id AS category_id,c.name AS category_name,c.department AS category_department,c.subdepartment_id AS category_subdepartment_id
    FROM inventory_departments d
    JOIN inventory_subdepartments sd ON sd.venue_id=d.venue_id AND sd.department_code=d.code
    JOIN product_categories c ON c.venue_id=sd.venue_id AND c.subdepartment_id=sd.id
    WHERE d.venue_id=$1 AND d.code='hookah' AND sd.id=$2 AND c.id=$3`, [ids.venue, subdepartment.id, subdepartmentCategory.id]);
  assert.deepEqual(movedHierarchyPg.rows, [{
    department_code: 'hookah', department_name: 'Кальяны', subdepartment_id: subdepartment.id, subdepartment_name: syntheticSubdepartmentName, subdepartment_department_code: 'hookah',
    category_id: subdepartmentCategory.id, category_name: renamedSubdepartmentCategoryName, category_department: 'hookah', category_subdepartment_id: subdepartment.id,
  }], 'PostgreSQL preserves the reparented subdepartment and linked category relationship'); checks++;
  const hierarchyAfterReparent = await db.query(`SELECT
      (SELECT count(*)::int FROM inventory_subdepartments WHERE venue_id=$1) AS subdepartments,
      (SELECT count(*)::int FROM product_categories WHERE venue_id=$1) AS categories,
      (SELECT count(*)::int FROM stock_movements WHERE venue_id=$1) AS movements,
      (SELECT count(*)::int FROM order_costs WHERE venue_id=$1) AS cogs_rows,
      COALESCE((SELECT sum(cost) FROM order_costs WHERE venue_id=$1),0)::numeric AS cogs_total`, [ids.venue]);
  assert.deepEqual(hierarchyAfterReparent.rows[0], hierarchyAfterEdit.rows[0], 'reparenting directory metadata does not change inventory, stock movements or COGS'); checks++;
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('[data-inventory-department=""]').click();
  const reloadedMovedSubdepartment = page.locator('#inventory-subdepartment-list .category-row').filter({ hasText: syntheticSubdepartmentName });
  await reloadedMovedSubdepartment.waitFor({ state: 'visible' });
  assert.match(await reloadedMovedSubdepartment.innerText(), /Цех:\s*Кальяны/, 'full reload preserves the new subdepartment parent'); checks++;
  const reloadedMovedCategory = page.locator('#product-category-list .category-row').filter({ hasText: renamedSubdepartmentCategoryName });
  await reloadedMovedCategory.waitFor({ state: 'visible' });
  const reloadedMovedCategoryText = await reloadedMovedCategory.innerText();
  assert.ok(reloadedMovedCategoryText.toLocaleLowerCase('ru-RU').includes(`кальяны → ${syntheticSubdepartmentName}`.toLocaleLowerCase('ru-RU')), `full reload preserves the linked category under the new parent: ${JSON.stringify(reloadedMovedCategoryText)}`); checks++;

  await page.goto(`${base}/inventory?view=stock`, { waitUntil: 'networkidle' });
  const ingredients = [];
  ingredients.push(await createIngredient(ingredientNames[0], category.id));
  ingredients.push(await createIngredient(ingredientNames[1], category.id));
  const itemRows = await db.query('SELECT id,name,category_id,unit,purchase_unit,pack_multiplier FROM ingredients WHERE venue_id=$1 AND id=ANY($2::uuid[]) ORDER BY name', [ids.venue, ingredients.map((item) => item.id)]);
  assert.equal(itemRows.rowCount, 2, 'both UI-created ingredient rows belong to the one synthetic venue'); checks++;
  for (const item of itemRows.rows) {
    assert.equal(item.category_id, category.id); checks++;
    assert.equal(item.unit, 'г'); checks++;
    assert.equal(item.purchase_unit, 'пачка'); checks++;
    assert.equal(Number(item.pack_multiplier), 100); checks++;
  }

  const editableItemName = `QA44 Редактирование ${marker}`;
  const renamedItemName = `QA44 Позиция обновлена ${marker}`;
  const editableItem = await createIngredient(editableItemName, category.id);
  const editBaseline = await db.query(`SELECT i.name,i.min_stock,i.cost,
      COALESCE((SELECT SUM(CASE WHEN sm.direction IN ('in','transfer','adjustment') THEN sm.quantity WHEN sm.direction IN ('out','waste') THEN -sm.quantity ELSE 0 END) FROM stock_movements sm WHERE sm.venue_id=i.venue_id AND sm.ingredient_id=i.id),0)::numeric AS on_hand,
      COALESCE((SELECT json_agg(json_build_object('id',sm.id,'direction',sm.direction,'quantity',sm.quantity,'reason',sm.reason,'orderId',sm.order_id) ORDER BY sm.id) FROM stock_movements sm WHERE sm.venue_id=i.venue_id AND sm.ingredient_id=i.id),'[]'::json) AS movements,
      (SELECT count(*)::int FROM order_costs c WHERE c.venue_id=i.venue_id) AS cogs_rows,
      COALESCE((SELECT sum(c.cost) FROM order_costs c WHERE c.venue_id=i.venue_id),0)::numeric AS cogs_total
    FROM ingredients i WHERE i.id=$1 AND i.venue_id=$2 AND i.is_marked=true`, [editableItem.id, ids.venue]);
  assert.equal(editBaseline.rowCount, 1, 'editable test item belongs to the synthetic venue'); checks++;
  assert.equal(editBaseline.rows[0].name, editableItemName); checks++;
  assert.equal(Number(editBaseline.rows[0].min_stock), 0); checks++;
  assert.equal(Number(editBaseline.rows[0].on_hand), 0); checks++;
  assert.deepEqual(editBaseline.rows[0].movements, [], 'editable item starts without stock movements'); checks++;
  const itemEditRow = page.locator('#inventory-rows tr').filter({ hasText: editableItemName });
  await itemEditRow.waitFor({ state: 'visible' });
  await itemEditRow.locator('.inventory-item-edit').click();
  await page.locator('#inventory-item-form').waitFor({ state: 'visible' });
  assert.equal(await page.locator('.inventory-item-editor-panel h2').innerText(), 'Редактирование позиции'); checks++;
  assert.equal(await page.locator('#inventory-item-form').getAttribute('data-item-id'), editableItem.id); checks++;
  assert.equal(await page.locator('#inventory-item-name').inputValue(), editableItemName); checks++;
  await page.locator('#inventory-item-name').fill(renamedItemName);
  const editResponsePromise = page.waitForResponse((response) => response.request().method() === 'PATCH' && new URL(response.url()).pathname === `/api/inventory/items/${editableItem.id}`);
  await page.locator('#inventory-item-form button[type="submit"]').click();
  const editResponse = await editResponsePromise;
  assert.equal(editResponse.status(), 200, 'editing the item form sends a successful PATCH'); checks++;
  assert.equal(editResponse.request().postDataJSON().name, renamedItemName, 'PATCH carries the edited name'); checks++;
  assert.equal((await editResponse.json()).name, renamedItemName, 'PATCH response returns the saved name'); checks++;
  await page.locator('#inventory-item-form').waitFor({ state: 'hidden' });
  const renamedItemRow = page.locator('#inventory-rows tr').filter({ hasText: renamedItemName });
  await renamedItemRow.waitFor({ state: 'visible' });
  assert.equal(await renamedItemRow.locator('.inventory-item-edit').count(), 1, 'reloaded stock list contains the renamed item'); checks++;
  const inventoryEditReadback = await page.evaluate(async () => {
    const response = await fetch('/api/inventory', { headers: { Authorization: `Bearer ${localStorage.getItem('crm_session_token')}` } });
    return { status: response.status, body: await response.json() };
  });
  assert.equal(inventoryEditReadback.status, 200); checks++;
  const editedApiItem = inventoryEditReadback.body.items.find((item) => item.id === editableItem.id);
  assert.ok(editedApiItem, 'fresh inventory API readback contains the edited item'); checks++;
  assert.equal(editedApiItem.name, renamedItemName); checks++;
  const editPersisted = await db.query(`SELECT name,min_stock,cost,
      COALESCE((SELECT SUM(CASE WHEN sm.direction IN ('in','transfer','adjustment') THEN sm.quantity WHEN sm.direction IN ('out','waste') THEN -sm.quantity ELSE 0 END) FROM stock_movements sm WHERE sm.venue_id=i.venue_id AND sm.ingredient_id=i.id),0)::numeric AS on_hand,
      COALESCE((SELECT json_agg(json_build_object('id',sm.id,'direction',sm.direction,'quantity',sm.quantity,'reason',sm.reason,'orderId',sm.order_id) ORDER BY sm.id) FROM stock_movements sm WHERE sm.venue_id=i.venue_id AND sm.ingredient_id=i.id),'[]'::json) AS movements,
      (SELECT count(*)::int FROM order_costs c WHERE c.venue_id=i.venue_id) AS cogs_rows,
      COALESCE((SELECT sum(c.cost) FROM order_costs c WHERE c.venue_id=i.venue_id),0)::numeric AS cogs_total
    FROM ingredients i WHERE i.id=$1 AND i.venue_id=$2 AND i.is_marked=true`, [editableItem.id, ids.venue]);
  assert.equal(editPersisted.rowCount, 1, 'edited item remains persisted in its synthetic venue'); checks++;
  assert.equal(editPersisted.rows[0].name, renamedItemName); checks++;
  assert.equal(Number(editPersisted.rows[0].min_stock), Number(editBaseline.rows[0].min_stock)); checks++;
  assert.equal(Number(editPersisted.rows[0].on_hand), Number(editBaseline.rows[0].on_hand)); checks++;
  assert.deepEqual(editPersisted.rows[0].movements, editBaseline.rows[0].movements, 'editing item metadata creates or alters no stock movement'); checks++;
  assert.equal(Number(editPersisted.rows[0].cost), Number(editBaseline.rows[0].cost)); checks++;
  assert.equal(editPersisted.rows[0].cogs_rows, editBaseline.rows[0].cogs_rows); checks++;
  assert.equal(Number(editPersisted.rows[0].cogs_total), Number(editBaseline.rows[0].cogs_total)); checks++;
  await page.reload({ waitUntil: 'networkidle' });
  const reloadedEditedItemRow = page.locator('#inventory-rows tr').filter({ hasText: renamedItemName });
  await reloadedEditedItemRow.waitFor({ state: 'visible' });
  assert.equal(await reloadedEditedItemRow.locator('.inventory-item-edit').count(), 1, 'full browser reload still shows the saved item name'); checks++;
  await reloadedEditedItemRow.locator('.inventory-item-edit').click();
  await page.locator('#inventory-item-form').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#inventory-item-name').inputValue(), renamedItemName, 'reopened edit form is prefilled from the saved item'); checks++;
  await page.locator('#cancel-inventory-item').click();
  await page.locator('#inventory-item-form').waitFor({ state: 'hidden' });

  const autoOrderIngredient = await createIngredient(`QA44 Автозаказ ${marker}`, category.id, {
    unit: 'мл', purchaseUnit: 'мл', packMultiplier: '1', minLevel: '1',
  });
  assert.equal(Number(autoOrderIngredient.onHand || 0), 0, 'synthetic auto-order ingredient starts with zero stock'); checks++;
  const autoOrderBaseline = await db.query(`SELECT
      (SELECT count(*)::int FROM inventory_auto_orders WHERE venue_id=$1) AS orders,
      (SELECT count(*)::int FROM stock_movements WHERE venue_id=$1 AND ingredient_id=$2) AS movements,
      (SELECT count(*)::int FROM inventory_purchase_document_lines WHERE venue_id=$1 AND ingredient_id=$2) AS receipt_lines`,
  [ids.venue, autoOrderIngredient.id]);
  assert.equal(autoOrderBaseline.rows[0].orders, 0, 'synthetic venue starts without auto-orders'); checks++;
  assert.equal(autoOrderBaseline.rows[0].movements, 0, 'synthetic auto-order ingredient starts without stock movements'); checks++;
  assert.equal(autoOrderBaseline.rows[0].receipt_lines, 0, 'synthetic auto-order ingredient starts without receipt lines'); checks++;

  await page.goto(`${base}/inventory?view=auto-orders`, { waitUntil: 'networkidle' });
  const autoOrderCheckboxes = page.locator('[data-auto-order-item]');
  await autoOrderCheckboxes.first().waitFor({ state: 'visible' });
  assert.equal(await autoOrderCheckboxes.count(), 1, 'only the synthetic low-stock ingredient is recommended'); checks++;
  assert.equal(await autoOrderCheckboxes.first().getAttribute('data-auto-order-item'), autoOrderIngredient.id); checks++;
  await page.locator(`[data-auto-order-quantity="${autoOrderIngredient.id}"]`).fill('750');
  const createAutoOrderResponsePromise = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/inventory/auto-orders');
  await page.locator('#create-auto-order').click();
  const createAutoOrderResponse = await createAutoOrderResponsePromise;
  assert.equal(createAutoOrderResponse.status(), 201, 'UI sends the auto-order creation request'); checks++;
  const createAutoOrderPayload = createAutoOrderResponse.request().postDataJSON();
  assert.deepEqual(createAutoOrderPayload.items, [{ itemId: autoOrderIngredient.id, quantity: 750 }], 'UI submits exactly one 750 ml line'); checks++;
  const createdAutoOrder = await createAutoOrderResponse.json();
  assert.equal(createdAutoOrder.status, 'sent'); checks++;
  assert.equal(createdAutoOrder.lines.length, 1); checks++;
  assert.equal(createdAutoOrder.lines[0].itemId, autoOrderIngredient.id); checks++;
  assert.equal(Number(createdAutoOrder.lines[0].quantity), 750); checks++;
  await page.locator('#portal-notice').filter({ hasText: 'Заявка создана и доступна в разделе пополнения запасов' }).waitFor({ state: 'visible' });

  await page.reload({ waitUntil: 'networkidle' });
  const autoOrderRows = page.locator('.auto-order-request-row');
  await autoOrderRows.first().waitFor({ state: 'visible' });
  assert.equal(await autoOrderRows.count(), 1, 'reload displays exactly one saved auto-order in the synthetic venue'); checks++;
  assert.match(await autoOrderRows.first().locator('.badge').innerText(), /Отправлена управляющему/, 'reloaded UI shows the sent status'); checks++;
  const sentAutoOrdersReadback = await page.evaluate(async () => {
    const response = await fetch('/api/inventory/auto-orders', { headers: { Authorization: `Bearer ${localStorage.getItem('crm_session_token')}` } });
    return { status: response.status, body: await response.json() };
  });
  assert.equal(sentAutoOrdersReadback.status, 200); checks++;
  const sentAutoOrders = sentAutoOrdersReadback.body.requests.filter((request) => request.lines.some((line) => line.itemId === autoOrderIngredient.id));
  assert.equal(sentAutoOrders.length, 1, 'fresh API readback returns exactly one request for the synthetic ingredient'); checks++;
  assert.equal(sentAutoOrders[0].id, createdAutoOrder.id); checks++;
  assert.equal(sentAutoOrders[0].status, 'sent'); checks++;
  assert.equal(Number(sentAutoOrders[0].lines[0].quantity), 750); checks++;
  const sentAutoOrderPg = await db.query('SELECT status,lines FROM inventory_auto_orders WHERE id=$1 AND venue_id=$2', [createdAutoOrder.id, ids.venue]);
  assert.equal(sentAutoOrderPg.rowCount, 1, 'created auto-order is persisted in the synthetic venue'); checks++;
  assert.equal(sentAutoOrderPg.rows[0].status, 'sent'); checks++;
  assert.equal(sentAutoOrderPg.rows[0].lines.length, 1); checks++;
  assert.equal(sentAutoOrderPg.rows[0].lines[0].itemId, autoOrderIngredient.id); checks++;
  assert.equal(Number(sentAutoOrderPg.rows[0].lines[0].quantity), 750); checks++;

  let autoOrderConfirmType = '';
  let autoOrderConfirmMessage = '';
  const autoOrderConfirmationPromise = page.waitForEvent('dialog').then(async (dialog) => {
    autoOrderConfirmType = dialog.type();
    autoOrderConfirmMessage = dialog.message();
    await dialog.accept();
  });
  const cancelAutoOrderResponsePromise = page.waitForResponse((response) => response.request().method() === 'PATCH' && new URL(response.url()).pathname === `/api/inventory/auto-orders/${createdAutoOrder.id}`);
  await page.locator(`[data-auto-order-cancel="${createdAutoOrder.id}"]`).click();
  await autoOrderConfirmationPromise;
  assert.equal(autoOrderConfirmType, 'confirm', 'UI asks for confirmation before cancelling the auto-order'); checks++;
  assert.equal(autoOrderConfirmMessage, 'Отменить заявку на пополнение? Уже проведённые поступления сохранятся.', 'confirmation identifies the auto-order cancellation'); checks++;
  const cancelAutoOrderResponse = await cancelAutoOrderResponsePromise;
  assert.equal(cancelAutoOrderResponse.status(), 200, 'confirmed UI cancellation reaches the auto-order API'); checks++;
  const cancelledAutoOrderResponse = await cancelAutoOrderResponse.json();
  assert.equal(cancelledAutoOrderResponse.status, 'cancelled'); checks++;
  await page.locator('#portal-notice').filter({ hasText: 'Заявка отменена' }).waitFor({ state: 'visible' });
  await autoOrderRows.first().locator('.badge').filter({ hasText: 'Отменена' }).waitFor({ state: 'visible' });

  const cancelledAutoOrdersReadback = await page.evaluate(async () => {
    const response = await fetch('/api/inventory/auto-orders', { headers: { Authorization: `Bearer ${localStorage.getItem('crm_session_token')}` } });
    return { status: response.status, body: await response.json() };
  });
  assert.equal(cancelledAutoOrdersReadback.status, 200); checks++;
  const cancelledAutoOrders = cancelledAutoOrdersReadback.body.requests.filter((request) => request.lines.some((line) => line.itemId === autoOrderIngredient.id));
  assert.equal(cancelledAutoOrders.length, 1); checks++;
  assert.equal(cancelledAutoOrders[0].id, createdAutoOrder.id); checks++;
  assert.equal(cancelledAutoOrders[0].status, 'cancelled'); checks++;
  assert.equal(Number(cancelledAutoOrders[0].lines[0].quantity), 750); checks++;
  const cancelledAutoOrderPg = await db.query('SELECT status,lines FROM inventory_auto_orders WHERE id=$1 AND venue_id=$2', [createdAutoOrder.id, ids.venue]);
  assert.equal(cancelledAutoOrderPg.rowCount, 1); checks++;
  assert.equal(cancelledAutoOrderPg.rows[0].status, 'cancelled'); checks++;
  assert.equal(Number(cancelledAutoOrderPg.rows[0].lines[0].quantity), 750); checks++;

  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(await page.locator('.auto-order-request-row').count(), 1, 'cancelled request remains the only history row after another reload'); checks++;
  await page.locator('.auto-order-request-row .badge').filter({ hasText: 'Отменена' }).waitFor({ state: 'visible' });
  const finalAutoOrderFacts = await db.query(`SELECT
      (SELECT count(*)::int FROM inventory_purchase_documents WHERE venue_id=$1 AND source_auto_order_id=$2) AS linked_documents,
      (SELECT count(*)::int FROM inventory_purchase_document_lines WHERE venue_id=$1 AND ingredient_id=$3) AS receipt_lines,
      (SELECT count(*)::int FROM stock_movements WHERE venue_id=$1 AND ingredient_id=$3) AS movements,
      (SELECT COALESCE(SUM(CASE WHEN direction IN ('in','transfer','adjustment') THEN quantity WHEN direction IN ('out','waste') THEN -quantity ELSE 0 END),0)::numeric FROM stock_movements WHERE venue_id=$1 AND ingredient_id=$3) AS balance`,
  [ids.venue, createdAutoOrder.id, autoOrderIngredient.id]);
  assert.equal(finalAutoOrderFacts.rows[0].linked_documents, 0, 'cancelling an auto-order creates no receipt document'); checks++;
  assert.equal(finalAutoOrderFacts.rows[0].receipt_lines, autoOrderBaseline.rows[0].receipt_lines, 'cancelling an auto-order creates no receipt lines'); checks++;
  assert.equal(finalAutoOrderFacts.rows[0].movements, autoOrderBaseline.rows[0].movements, 'cancelling an auto-order creates no stock movements'); checks++;
  assert.equal(Number(finalAutoOrderFacts.rows[0].balance), 0, 'auto-order cancellation leaves PostgreSQL stock balance at zero'); checks++;
  const finalInventoryReadback = await page.evaluate(async (ingredientId) => {
    const response = await fetch('/api/inventory', { headers: { Authorization: `Bearer ${localStorage.getItem('crm_session_token')}` } });
    const body = await response.json();
    return { status: response.status, item: body.items.find((entry) => entry.id === ingredientId) };
  }, autoOrderIngredient.id);
  assert.equal(finalInventoryReadback.status, 200); checks++;
  assert.equal(Number(finalInventoryReadback.item?.onHand), 0, 'inventory API still reports zero stock after cancellation'); checks++;

  await page.goto(`${base}/inventory?view=movements`, { waitUntil: 'networkidle' });
  await page.locator('#purchase-document-form').waitFor({ state: 'visible' });
  await page.locator('#purchase-supplier').fill('Synthetic QA supplier');
  await page.locator('#purchase-number').fill(`QA44-${marker}`);
  const purchaseLines = page.locator('#purchase-lines .purchase-line');
  await purchaseLines.first().locator('[data-purchase-field="ingredientId"]').selectOption(ingredients[0].id);
  await purchaseLines.first().locator('[data-purchase-field="quantity"]').fill('1');
  await purchaseLines.first().locator('[data-purchase-field="unit"]').fill('пачка');
  await purchaseLines.first().locator('[data-purchase-field="unitCost"]').fill('120');
  await page.locator('#purchase-add-line').click();
  const secondLine = page.locator('#purchase-lines .purchase-line').nth(1);
  await secondLine.locator('[data-purchase-field="ingredientId"]').selectOption(ingredients[1].id);
  await secondLine.locator('[data-purchase-field="quantity"]').fill('1');
  await secondLine.locator('[data-purchase-field="unit"]').fill('пачка');
  await secondLine.locator('[data-purchase-field="unitCost"]').fill('120');
  const saveDraftPromise = page.waitForResponse((response) => response.request().method() === 'POST' && response.url().endsWith('/api/inventory/purchase-documents'));
  await page.locator('#purchase-save').click();
  const saveDraft = await saveDraftPromise;
  assert.equal(saveDraft.status(), 201, 'receiving UI saves a draft document'); checks++;
  const purchase = await saveDraft.json();
  const beforePost = await db.query('SELECT status,(SELECT count(*)::int FROM stock_movements m WHERE m.venue_id=$2 AND m.ingredient_id=ANY($3::uuid[])) AS movements FROM inventory_purchase_documents WHERE id=$1 AND venue_id=$2', [purchase.id, ids.venue, ingredients.map((item) => item.id)]);
  assert.equal(beforePost.rows[0]?.status, 'draft'); checks++;
  assert.equal(beforePost.rows[0]?.movements, 0, 'draft has not written inventory movements'); checks++;
  page.once('dialog', (dialog) => dialog.accept());
  const postPromise = page.waitForResponse((response) => response.request().method() === 'POST' && response.url().endsWith(`/api/inventory/purchase-documents/${purchase.id}/post`));
  await page.locator(`[data-purchase-post="${purchase.id}"]`).click();
  assert.equal((await postPromise).status(), 200, 'inventory UI posts the saved receipt'); checks++;
  const inbound = await db.query(`SELECT d.status AS document_status,l.venue_id AS line_venue_id,l.ingredient_id,l.stock_quantity,l.unit_cost,l.receipt_unit_cost,l.source_movement_id,m.venue_id AS movement_venue_id,m.ingredient_id AS movement_ingredient_id,m.direction,m.quantity
    FROM inventory_purchase_document_lines l JOIN inventory_purchase_documents d ON d.id=l.document_id
    JOIN stock_movements m ON m.id=l.source_movement_id
    WHERE d.id=$1 AND d.venue_id=$2 ORDER BY l.ingredient_id`, [purchase.id, ids.venue]);
  assert.equal(inbound.rowCount, 2, 'each receipt line links to one source ledger movement'); checks++;
  for (const item of inbound.rows) {
    assert.equal(item.document_status, 'posted'); checks++;
    assert.equal(item.line_venue_id, ids.venue); checks++;
    assert.equal(item.movement_venue_id, item.line_venue_id); checks++;
    assert.equal(item.movement_ingredient_id, item.ingredient_id); checks++;
    assert.equal(item.direction, 'in'); checks++;
    assert.equal(Number(item.stock_quantity), 100); checks++;
    assert.equal(Number(item.quantity), 100); checks++;
    assert.equal(Number(item.unit_cost), 120, 'receipt stores the entered price per pack'); checks++;
    assert.equal(Number(item.receipt_unit_cost), 1.2, 'receipt stores the normalized base-unit cost'); checks++;
  }
  assert.deepEqual(await Promise.all(ingredients.map((item) => balance(item.id))), [100, 100], 'each received ingredient has 100g on hand'); checks++;

  await page.goto(`${base}/inventory?view=stock`, { waitUntil: 'networkidle' });
  const premixComponent = await createIngredient(`QA44 Премикс компонент ${marker}`, category.id, {
    unit: 'мл', purchaseUnit: 'мл', packMultiplier: '1', cost: '0.10',
  });
  const premixOutput = await createIngredient(`QA44 Премикс результат ${marker}`, category.id, {
    unit: 'мл', purchaseUnit: 'мл', packMultiplier: '1',
  });
  assert.equal(Number(premixComponent.cost), 0.1, 'synthetic component fixture is created with the unit cost used by the batch estimate'); checks++;
  const premixComponentCostPg = await db.query('SELECT cost FROM ingredients WHERE id=$1 AND venue_id=$2', [premixComponent.id, ids.venue]);
  assert.equal(Number(premixComponentCostPg.rows[0]?.cost), 0.1, 'PostgreSQL confirms the component unit cost before production'); checks++;
  const sessionToken = await page.evaluate(() => localStorage.getItem('crm_session_token'));
  const seedMovement = await page.evaluate(async ({ itemId, token }) => {
    const response = await fetch('/api/inventory/movements', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ itemId, delta: 400, unit: 'мл', reason: 'QA44 synthetic premix opening stock' }),
    });
    return { status: response.status, body: await response.json() };
  }, { itemId: premixComponent.id, token: sessionToken });
  assert.equal(seedMovement.status, 201, 'isolated synthetic component receives its opening stock through the real inventory API'); checks++;
  assert.equal(Number(seedMovement.body.onHandAfter), 400); checks++;
  assert.equal(await balance(premixComponent.id), 400); checks++;
  assert.equal(await balance(premixOutput.id), 0, 'synthetic premix output starts at zero stock'); checks++;

  const premixRecipe = await createRecipe(`QA44 Премикс партия ${marker}`, null, premixComponent.id, '250 мл', {
    recipeType: 'premix', yieldQuantity: '500', yieldUnit: 'мл',
  });
  const premixRecipeRow = await db.query('SELECT id,name,recipe_type,yield_quantity,yield_unit,ingredients FROM inventory_recipe_cards WHERE venue_id=$1 AND id=$2', [ids.venue, premixRecipe.id]);
  assert.equal(premixRecipeRow.rowCount, 1, 'separate synthetic premix recipe is persisted for the batch fixture'); checks++;
  assert.equal(premixRecipeRow.rows[0].recipe_type, 'premix'); checks++;
  assert.equal(Number(premixRecipeRow.rows[0].yield_quantity), 500); checks++;
  assert.equal(premixRecipeRow.rows[0].yield_unit, 'мл'); checks++;
  assert.equal(premixRecipeRow.rows[0].ingredients.length, 1); checks++;
  assert.equal(premixRecipeRow.rows[0].ingredients[0].ingredientId, premixComponent.id); checks++;
  assert.equal(premixRecipeRow.rows[0].ingredients[0].quantity, '250 мл'); checks++;

  await page.goto(`${base}/inventory?view=premixes`, { waitUntil: 'networkidle' });
  await page.locator(`#premix-recipe option[value="${premixRecipe.id}"]`).waitFor({ state: 'attached' });
  await page.locator(`#premix-output option[value="${premixOutput.id}"]`).waitFor({ state: 'attached' });
  await page.locator('#premix-recipe').selectOption(premixRecipe.id);
  await page.locator('#premix-output').selectOption(premixOutput.id);
  await page.locator('#premix-multiplier').fill('1.5');
  const premixMovementBaseline = await db.query(`SELECT id,ingredient_id,direction,quantity,reason FROM stock_movements
    WHERE venue_id=$1 AND ingredient_id=ANY($2::uuid[]) ORDER BY created_at,id`, [ids.venue, [premixComponent.id, premixOutput.id]]);
  assert.equal(premixMovementBaseline.rows.length, 1, 'baseline contains only the component opening movement'); checks++;
  const producePremixResponsePromise = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/inventory/premixes/produce');
  await page.locator('#premix-submit').click();
  const producePremixResponse = await producePremixResponsePromise;
  assert.equal(producePremixResponse.status(), 201, 'visible premix production form posts a successful batch'); checks++;
  assert.deepEqual(producePremixResponse.request().postDataJSON(), {
    recipeId: premixRecipe.id, outputItemId: premixOutput.id, multiplier: 1.5,
  }, 'production form submits a 1.5 batch multiplier'); checks++;
  const producedPremix = await producePremixResponse.json();
  assert.equal(producedPremix.recipeId, premixRecipe.id); checks++;
  assert.equal(producedPremix.outputItemId, premixOutput.id); checks++;
  assert.equal(Number(producedPremix.plannedOutputQuantity), 750); checks++;
  assert.equal(Number(producedPremix.outputQuantity), 750); checks++;
  assert.equal(Number(producedPremix.totalCost), 37.5); checks++;
  assert.equal(Number(producedPremix.batchUnitCost), 0.05); checks++;
  const premixSuccessMessage = page.locator('#premix-message');
  await premixSuccessMessage.filter({ hasText: 'Партия приготовлена:' }).waitFor({ state: 'visible' });
  assert.match(await premixSuccessMessage.innerText(), /^Партия приготовлена:\s*750(?:\.0+)?\s*мл$/, 'success message reports the scaled 750 ml output despite decimal scale in the API response'); checks++;
  const producedBatchRow = page.locator(`#premix-batches .premix-batch-row[data-premix-batch="${producedPremix.id}"]`);
  await producedBatchRow.waitFor({ state: 'visible' });
  assert.match(await producedBatchRow.innerText(), /Факт:\s*750 мл\s*·\s*план:\s*750 мл/); checks++;
  assert.match(await producedBatchRow.innerText(), /Остаток:\s*750 мл/); checks++;
  assert.match(await producedBatchRow.innerText(), /37[,.]5/, 'batch history shows the multiplier-scaled cost estimate with the localized decimal separator'); checks++;

  const restrictedLogin = `qa44-hookah-${marker}`;
  const restrictedPassword = `qa44-hookah-${randomUUID()}`;
  const restrictedUser = await db.query(`INSERT INTO users(id,organization_id,venue_id,full_name,login,password_hash,role,permission_scopes)
    VALUES($1,$2,$3,'QA44 synthetic hookah worker',$4,$5,'hookah_master','[]'::jsonb) RETURNING id`,
  [randomUUID(), ids.organization, ids.venue, restrictedLogin, hash(restrictedPassword)]);
  await db.query("INSERT INTO organization_memberships(organization_id,user_id,membership_role,status) VALUES($1,$2,'member','active')",
    [ids.organization, restrictedUser.rows[0].id]);
  const restrictedLoginResponse = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Organization-Id': ids.organization },
    body: JSON.stringify({ username: restrictedLogin, password: restrictedPassword }),
  });
  assert.equal(restrictedLoginResponse.status, 200, 'synthetic hookah worker can authenticate for role-boundary checks'); checks++;
  const restrictedSession = await restrictedLoginResponse.json();
  assert.ok(!restrictedSession.permissions.includes('inventory') && !restrictedSession.permissions.includes('inventory_read'),
    'hookah worker has neither inventory read nor write permission'); checks++;
  const restrictedHeaders = { Authorization: `Bearer ${restrictedSession.token}`, 'X-Organization-Id': ids.organization, 'Content-Type': 'application/json' };
  const premixReadDenied = await fetch(`${base}/api/inventory/premixes`, { headers: restrictedHeaders });
  assert.equal(premixReadDenied.status, 403, 'hookah worker cannot read premix batch history'); checks++;
  const premixProduceDenied = await fetch(`${base}/api/inventory/premixes/produce`, {
    method: 'POST', headers: restrictedHeaders,
    body: JSON.stringify({ recipeId: premixRecipe.id, outputItemId: premixOutput.id, multiplier: 1 }),
  });
  assert.equal(premixProduceDenied.status, 403, 'hookah worker cannot produce a premix batch'); checks++;
  const premixAdjustDenied = await fetch(`${base}/api/inventory/premixes/${producedPremix.id}/count`, {
    method: 'POST', headers: restrictedHeaders,
    body: JSON.stringify({ actualQuantity: 700, reason: 'QA forbidden adjustment' }),
  });
  assert.equal(premixAdjustDenied.status, 403, 'hookah worker cannot adjust a premix batch'); checks++;
  const readerLogin = `qa44-inventory-reader-${marker}`;
  const readerPassword = `qa44-reader-${randomUUID()}`;
  const readerPin = '4482';
  const readerUser = await db.query(`INSERT INTO users(id,organization_id,venue_id,full_name,login,password_hash,pin_hash,pin_updated_at,role,permission_scopes)
    VALUES($1,$2,$3,'QA44 synthetic inventory reader',$4,$5,$6,now(),'manager','["inventory_read"]'::jsonb) RETURNING id`,
  [randomUUID(), ids.organization, ids.venue, readerLogin, hash(readerPassword), hash(readerPin)]);
  await db.query("INSERT INTO organization_memberships(organization_id,user_id,membership_role,status) VALUES($1,$2,'member','active')",
    [ids.organization, readerUser.rows[0].id]);
  const readerLoginResponse = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Organization-Id': ids.organization },
    body: JSON.stringify({ username: readerLogin, password: readerPassword }),
  });
  assert.equal(readerLoginResponse.status, 200, 'synthetic inventory reader can authenticate'); checks++;
  const readerSession = await readerLoginResponse.json();
  assert.ok(readerSession.permissions.includes('inventory_read') && !readerSession.permissions.includes('inventory'),
    'manager has premix read permission without inventory write permission'); checks++;
  const readerHeaders = { Authorization: `Bearer ${readerSession.token}`, 'X-Organization-Id': ids.organization, 'Content-Type': 'application/json' };
  assert.ok(!readerSession.permissions.includes('inventory_categories'),
    'inventory_read-only manager has no category lifecycle permission'); checks++;
  const readerDirectorySnapshot = await db.query(`SELECT
      COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'name',name,'department_code',department_code,'active',is_active) ORDER BY id) FROM inventory_subdepartments WHERE venue_id=$1),'[]'::jsonb) AS subdepartments,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'name',name,'department',department,'subdepartment_id',subdepartment_id,'active',is_active) ORDER BY id) FROM product_categories WHERE venue_id=$1),'[]'::jsonb) AS categories,
      (SELECT count(*)::int FROM stock_movements WHERE venue_id=$1) AS movements,
      (SELECT count(*)::int FROM order_costs WHERE venue_id=$1) AS cogs_rows,
      COALESCE((SELECT sum(cost) FROM order_costs WHERE venue_id=$1),0)::numeric AS cogs_total`, [ids.venue]);
  const readerDirectoryContext = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ru-RU', reducedMotion: 'reduce' });
  const readerDirectoryPage = await readerDirectoryContext.newPage();
  const readerDirectoryErrors = [];
  const readerDirectoryApiFailures = [];
  const readerDirectoryHttpFailures = [];
  const readerDirectoryMutations = [];
  let captureReaderDirectoryApi = false;
  readerDirectoryPage.on('pageerror', (error) => { if (captureReaderDirectoryApi) readerDirectoryErrors.push(error.stack || error.message); });
  readerDirectoryPage.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/') && new URL(request.url()).pathname !== '/api/login' && !['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
      readerDirectoryMutations.push({ method: request.method(), path: new URL(request.url()).pathname });
    }
  });
  readerDirectoryPage.on('response', (response) => {
    if (captureReaderDirectoryApi && response.status() >= 400) {
      readerDirectoryHttpFailures.push({ status: response.status(), path: new URL(response.url()).pathname });
    }
    if (captureReaderDirectoryApi && new URL(response.url()).pathname.startsWith('/api/') && response.status() >= 400) {
      readerDirectoryApiFailures.push({ status: response.status(), path: new URL(response.url()).pathname });
    }
  });
  readerDirectoryPage.on('console', (message) => { if (captureReaderDirectoryApi && message.type() === 'error') readerDirectoryErrors.push(`console: ${message.text()}`); });
  readerDirectoryPage.on('requestfailed', (request) => {
    if (captureReaderDirectoryApi) readerDirectoryErrors.push(`request failed: ${request.method()} ${new URL(request.url()).pathname}`);
  });
  await readerDirectoryPage.goto(`${base}/login`, { waitUntil: 'networkidle' });
  await readerDirectoryPage.locator('#login-username').fill(readerLogin);
  await readerDirectoryPage.locator('#login-password').fill(readerPassword);
  await readerDirectoryPage.locator('#login-form button[type="submit"]').click();
  await readerDirectoryPage.waitForURL((url) => url.pathname !== '/login');
  assert.ok(await readerDirectoryPage.evaluate(() => localStorage.getItem('crm_session_token')),
    'inventory_read-only manager authenticates through the normal browser login'); checks++;
  const readerBrowserSession = await readerDirectoryPage.evaluate(async () => {
    const token = localStorage.getItem('crm_session_token');
    const response = await fetch('/api/session', { headers: { Authorization: `Bearer ${token}` } });
    return { status: response.status, body: await response.json() };
  });
  assert.equal(readerBrowserSession.status, 200,
    `inventory_read manager browser session remains authenticated after password login: ${JSON.stringify(readerBrowserSession)}`); checks++;
  assert.equal(readerBrowserSession.body.user.id, readerUser.rows[0].id, 'browser session identity matches the synthetic reader'); checks++;
  await readerDirectoryPage.evaluate((session) => {
    localStorage.setItem('crm_session_token', session.token);
    localStorage.setItem('crm_session_user', JSON.stringify(session.user));
  }, readerSession);
  captureReaderDirectoryApi = true;
  await readerDirectoryPage.goto(`${base}/inventory?view=directories`, { waitUntil: 'networkidle' });
  if (await readerDirectoryPage.locator('.screen-lock-overlay[aria-hidden="false"]').count()) {
    const unlockResponse = readerDirectoryPage.waitForResponse((response) => new URL(response.url()).pathname === '/api/session/unlock' && response.request().method() === 'POST');
    await readerDirectoryPage.locator('#screen-lock-pin').fill(readerPin);
    assert.equal((await unlockResponse).status(), 200, 'read-only manager unlocks the same browser session with the configured PIN'); checks++;
    await readerDirectoryPage.waitForFunction(() => document.querySelector('.screen-lock-overlay')?.getAttribute('aria-hidden') === 'true' && !document.body.classList.contains('screen-locked'));
  }
  const readerDirectoryRoute = await readerDirectoryPage.evaluate(() => ({
    url: location.href,
    title: document.title,
    directoryListPresent: Boolean(document.querySelector('#inventory-subdepartment-list')),
    body: document.body.innerText.slice(0, 1200),
  }));
  assert.ok(readerDirectoryRoute.directoryListPresent,
    `inventory_read manager opens the directory view: ${JSON.stringify({ ...readerDirectoryRoute, scriptErrors: readerDirectoryErrors, apiFailures: readerDirectoryApiFailures })}`); checks++;
  const readerSubdepartmentRow = readerDirectoryPage.locator('#inventory-subdepartment-list .category-row').filter({ hasText: syntheticSubdepartmentName });
  const readerCategoryRow = readerDirectoryPage.locator('#product-category-list .category-row').filter({ hasText: renamedSubdepartmentCategoryName });
  const readerSubdepartmentText = await readerDirectoryPage.locator('#inventory-subdepartment-list').innerText();
  const readerCategoryText = await readerDirectoryPage.locator('#product-category-list').innerText();
  assert.ok(readerSubdepartmentText.toLocaleLowerCase('ru-RU').includes(syntheticSubdepartmentName.toLocaleLowerCase('ru-RU')),
    `inventory_read manager can inspect the reparented subdepartment in directories: ${readerSubdepartmentText}`); checks++;
  assert.ok(readerCategoryText.toLocaleLowerCase('ru-RU').includes(renamedSubdepartmentCategoryName.toLocaleLowerCase('ru-RU')),
    `inventory_read manager can inspect the reparented category in directories: ${readerCategoryText}`); checks++;
  assert.match(await readerSubdepartmentRow.innerText(), /Цех:\s*Кальяны/, 'inventory_read manager can inspect the reparented subdepartment under the correct department'); checks++;
  assert.ok((await readerCategoryRow.innerText()).toLocaleLowerCase('ru-RU').includes(`Кальяны → ${syntheticSubdepartmentName}`.toLocaleLowerCase('ru-RU')),
    'inventory_read manager can inspect the reparented category hierarchy'); checks++;
  assert.equal(await readerDirectoryPage.locator('#inventory-header-actions [data-inventory-header-action]').count(), 0,
    'inventory_read manager has no create actions in the directory header'); checks++;
  assert.equal(await readerDirectoryPage.locator('#product-category-form').isVisible(), false,
    'inventory_read manager cannot open the hidden category editor'); checks++;
  assert.equal(await readerDirectoryPage.locator('#inventory-subdepartment-list + form.department-editor').isVisible(), false,
    'inventory_read manager cannot open the hidden subdepartment editor'); checks++;
  assert.equal(await readerDirectoryPage.locator('#inventory-department-list .department-edit, #inventory-department-list [data-archive-type], #inventory-department-list [data-restore-type], #inventory-department-list [data-delete-type], #inventory-department-list [data-request-type], #inventory-subdepartment-list .subdepartment-edit, #inventory-subdepartment-list [data-archive-type], #inventory-subdepartment-list [data-restore-type], #inventory-subdepartment-list [data-delete-type], #inventory-subdepartment-list [data-request-type], #product-category-list .product-category-edit, #product-category-list [data-archive-type], #product-category-list [data-restore-type], #product-category-list [data-delete-type], #product-category-list [data-request-type]').count(), 0,
    'inventory_read manager has no edit, archive, restore, permanent-delete, or delete-request actions in directory rows'); checks++;
  assert.deepEqual(readerDirectoryMutations, [], 'read-only directory navigation sends no API write requests'); checks++;
  assert.deepEqual(readerDirectoryApiFailures, [], 'read-only directory loads return successful API responses'); checks++;
  assert.deepEqual(readerDirectoryHttpFailures, [], 'read-only directory path has no failed HTTP resources'); checks++;
  assert.deepEqual(readerDirectoryErrors, [], 'read-only directory browser path has no page errors'); checks++;
  await readerDirectoryContext.close();
  const readerDirectorySnapshotAfter = await db.query(`SELECT
      COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'name',name,'department_code',department_code,'active',is_active) ORDER BY id) FROM inventory_subdepartments WHERE venue_id=$1),'[]'::jsonb) AS subdepartments,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'name',name,'department',department,'subdepartment_id',subdepartment_id,'active',is_active) ORDER BY id) FROM product_categories WHERE venue_id=$1),'[]'::jsonb) AS categories,
      (SELECT count(*)::int FROM stock_movements WHERE venue_id=$1) AS movements,
      (SELECT count(*)::int FROM order_costs WHERE venue_id=$1) AS cogs_rows,
      COALESCE((SELECT sum(cost) FROM order_costs WHERE venue_id=$1),0)::numeric AS cogs_total`, [ids.venue]);
  assert.deepEqual(readerDirectorySnapshotAfter.rows[0], readerDirectorySnapshot.rows[0],
    'read-only directory browser visit leaves hierarchy, stock movements, and COGS unchanged'); checks++;
  const ownerSessionToken = await page.evaluate(() => localStorage.getItem('crm_session_token'));
  const roleAutoOrderCreateResponse = await fetch(`${base}/api/inventory/auto-orders`, {
    method: 'POST', headers: { Authorization: `Bearer ${ownerSessionToken}`, 'X-Organization-Id': ids.organization, 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: [{ itemId: autoOrderIngredient.id, quantity: 100 }] }),
  });
  assert.equal(roleAutoOrderCreateResponse.status, 201, 'owner prepares a live synthetic request for role-boundary checks'); checks++;
  const roleAutoOrder = await roleAutoOrderCreateResponse.json();
  assert.equal(roleAutoOrder.status, 'sent', 'role-boundary fixture is cancellable before authorization checks'); checks++;
  const foreignOrganizationId = randomUUID();
  const foreignVenueId = randomUUID();
  const foreignOwnerId = randomUUID();
  const foreignLogin = `qa44-foreign-owner-${marker}`;
  const foreignPassword = `qa44-${randomUUID()}`;
  await db.query('INSERT INTO organizations(id,name,slug,timezone) VALUES($1,$2,$3,$4)', [foreignOrganizationId, 'QA44 auto-order isolation', `qa44-foreign-${foreignOrganizationId}`, 'Asia/Yekaterinburg']);
  await db.query("INSERT INTO organization_subscriptions(organization_id,status) VALUES($1,'trialing')", [foreignOrganizationId]);
  await db.query('INSERT INTO venues(id,organization_id,name,timezone) VALUES($1,$2,$3,$4)', [foreignVenueId, foreignOrganizationId, `QA44 foreign venue ${marker}`, 'Asia/Yekaterinburg']);
  await db.query(`INSERT INTO users(id,organization_id,venue_id,full_name,login,password_hash,role,permission_scopes)
    VALUES($1,$2,$3,'QA44 foreign synthetic owner',$4,$5,'owner','[]'::jsonb)`, [foreignOwnerId, foreignOrganizationId, foreignVenueId, foreignLogin, hash(foreignPassword)]);
  await db.query("INSERT INTO organization_memberships(organization_id,user_id,membership_role,status) VALUES($1,$2,'owner','active')", [foreignOrganizationId, foreignOwnerId]);
  const foreignLoginResponse = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Organization-Id': foreignOrganizationId },
    body: JSON.stringify({ username: foreignLogin, password: foreignPassword }),
  });
  assert.equal(foreignLoginResponse.status, 200, 'synthetic owner of a second organization can authenticate'); checks++;
  const foreignSession = await foreignLoginResponse.json();
  const foreignHeaders = { Authorization: `Bearer ${foreignSession.token}`, 'X-Organization-Id': foreignOrganizationId, 'Content-Type': 'application/json' };
  assert.equal(foreignSession.user.venueId, foreignVenueId, 'foreign session is bound to its own venue'); checks++;
  const autoOrderBeforeRoleDenials = await db.query(`SELECT
      (SELECT count(*)::int FROM inventory_auto_orders WHERE venue_id=$1) AS count,
      (SELECT status FROM inventory_auto_orders WHERE id=$2 AND venue_id=$1) AS status,
      (SELECT lines FROM inventory_auto_orders WHERE id=$2 AND venue_id=$1) AS lines,
      (SELECT updated_at FROM inventory_auto_orders WHERE id=$2 AND venue_id=$1) AS "updatedAt"`, [ids.venue, roleAutoOrder.id]);
  assert.equal(autoOrderBeforeRoleDenials.rows[0].count, 2, 'role check starts with the two expected synthetic requests'); checks++;
  assert.equal(autoOrderBeforeRoleDenials.rows[0].status, 'sent'); checks++;
  const foreignAutoOrdersResponse = await fetch(`${base}/api/inventory/auto-orders`, { headers: foreignHeaders });
  assert.equal(foreignAutoOrdersResponse.status, 200, 'foreign owner can read its own auto-order page'); checks++;
  const foreignAutoOrders = await foreignAutoOrdersResponse.json();
  assert.ok(!foreignAutoOrders.items.some((item) => item.id === autoOrderIngredient.id), 'foreign venue recommendations exclude the first venue ingredient'); checks++;
  assert.ok(!foreignAutoOrders.requests.some((request) => request.id === roleAutoOrder.id), 'foreign venue history excludes the first venue auto-order'); checks++;
  const foreignAutoOrderCancel = await fetch(`${base}/api/inventory/auto-orders/${roleAutoOrder.id}`, {
    method: 'PATCH', headers: foreignHeaders, body: JSON.stringify({ status: 'cancelled' }),
  });
  assert.equal(foreignAutoOrderCancel.status, 404, 'foreign owner cannot address another venue auto-order'); checks++;
  assert.equal((await foreignAutoOrderCancel.json()).error, 'auto_order_not_found', 'foreign auto-order mutation uses the canonical not-found response'); checks++;
  const foreignAutoOrderCreate = await fetch(`${base}/api/inventory/auto-orders`, {
    method: 'POST', headers: foreignHeaders,
    body: JSON.stringify({ items: [{ itemId: autoOrderIngredient.id, quantity: 100 }] }),
  });
  assert.equal(foreignAutoOrderCreate.status, 400, 'foreign owner cannot create a request using another venue ingredient'); checks++;
  assert.equal((await foreignAutoOrderCreate.json()).error, 'auto_order_item_not_found'); checks++;
  const foreignAutoOrderCount = await db.query('SELECT count(*)::int AS count FROM inventory_auto_orders WHERE venue_id=$1', [foreignVenueId]);
  assert.equal(foreignAutoOrderCount.rows[0].count, 0, 'foreign auto-order attempts create no request in the second venue'); checks++;
  const siblingVenueId = randomUUID();
  const siblingOwnerId = randomUUID();
  const siblingLogin = `qa44-sibling-owner-${marker}`;
  const siblingPassword = `qa44-${randomUUID()}`;
  await db.query('INSERT INTO venues(id,organization_id,name,timezone) VALUES($1,$2,$3,$4)', [siblingVenueId, ids.organization, `QA44 sibling venue ${marker}`, 'Asia/Yekaterinburg']);
  await db.query(`INSERT INTO users(id,organization_id,venue_id,full_name,login,password_hash,role,permission_scopes)
    VALUES($1,$2,$3,'QA44 sibling synthetic owner',$4,$5,'owner','[]'::jsonb)`, [siblingOwnerId, ids.organization, siblingVenueId, siblingLogin, hash(siblingPassword)]);
  await db.query("INSERT INTO organization_memberships(organization_id,user_id,membership_role,status) VALUES($1,$2,'owner','active')", [ids.organization, siblingOwnerId]);
  const siblingLoginResponse = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Organization-Id': ids.organization },
    body: JSON.stringify({ username: siblingLogin, password: siblingPassword }),
  });
  assert.equal(siblingLoginResponse.status, 200, 'synthetic owner of a sibling venue can authenticate'); checks++;
  const siblingSession = await siblingLoginResponse.json();
  assert.equal(siblingSession.user.organizationId, ids.organization, 'sibling session remains in the shared organization'); checks++;
  assert.equal(siblingSession.user.venueId, siblingVenueId, 'sibling session is bound to the second venue'); checks++;
  const siblingHeaders = { Authorization: `Bearer ${siblingSession.token}`, 'X-Organization-Id': ids.organization, 'Content-Type': 'application/json' };
  const categoryManagerLogin = `qa44-category-manager-${marker}`;
  const categoryManagerPassword = `qa44-${randomUUID()}`;
  const categoryManagerId = randomUUID();
  await db.query(`INSERT INTO users(id,organization_id,venue_id,full_name,login,password_hash,role,permission_scopes)
    VALUES($1,$2,$3,'QA44 synthetic category manager',$4,$5,'manager','["inventory_categories","inventory_read"]'::jsonb)`,
  [categoryManagerId, ids.organization, ids.venue, categoryManagerLogin, hash(categoryManagerPassword)]);
  await db.query("INSERT INTO organization_memberships(organization_id,user_id,membership_role,status) VALUES($1,$2,'member','active')",
    [ids.organization, categoryManagerId]);
  const categoryManagerLoginResponse = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Organization-Id': ids.organization },
    body: JSON.stringify({ username: categoryManagerLogin, password: categoryManagerPassword }),
  });
  assert.equal(categoryManagerLoginResponse.status, 200, 'synthetic category manager can authenticate for deletion workflow'); checks++;
  const categoryManagerSession = await categoryManagerLoginResponse.json();
  assert.ok(categoryManagerSession.permissions.includes('inventory_categories') && categoryManagerSession.permissions.includes('inventory_read') && !categoryManagerSession.permissions.includes('inventory'),
    'category manager can read/request category changes without broad inventory write permission'); checks++;
  const categoryManagerHeaders = { Authorization: `Bearer ${categoryManagerSession.token}`, 'X-Organization-Id': ids.organization, 'Content-Type': 'application/json' };
  const ownerHeaders = { Authorization: `Bearer ${ownerSessionToken}`, 'X-Organization-Id': ids.organization, 'Content-Type': 'application/json' };
  const deletionCategoryCreate = await fetch(`${base}/api/product-categories`, {
    method: 'POST', headers: ownerHeaders,
    body: JSON.stringify({ name: `QA44 deletion request ${marker}`, department: 'hookah' }),
  });
  assert.equal(deletionCategoryCreate.status, 201, 'owner creates an unused synthetic category for deletion workflow'); checks++;
  const deletionCategory = await deletionCategoryCreate.json();
  const deletionCategoryArchive = await fetch(`${base}/api/product-categories/${deletionCategory.id}`, {
    method: 'DELETE', headers: categoryManagerHeaders,
  });
  assert.equal(deletionCategoryArchive.status, 200, 'category-only manager can archive an unused category before requesting permanent deletion'); checks++;
  assert.equal((await deletionCategoryArchive.json()).active, false); checks++;
  const categoryDeletionRequestResponse = await fetch(`${base}/api/inventory/deletion-requests`, {
    method: 'POST', headers: categoryManagerHeaders,
    body: JSON.stringify({ entityType: 'category', entityId: deletionCategory.id, reason: `QA44 owner review ${marker}` }),
  });
  assert.equal(categoryDeletionRequestResponse.status, 201, 'category manager can request owner approval for its archived category'); checks++;
  const categoryDeletionRequest = await categoryDeletionRequestResponse.json();
  assert.equal(categoryDeletionRequest.status, 'pending'); checks++;
  assert.equal(categoryDeletionRequest.entityId, deletionCategory.id); checks++;
  assert.equal(categoryDeletionRequest.reason, `QA44 owner review ${marker}`); checks++;
  const duplicateCategoryDeletionRequest = await fetch(`${base}/api/inventory/deletion-requests`, {
    method: 'POST', headers: categoryManagerHeaders,
    body: JSON.stringify({ entityType: 'category', entityId: deletionCategory.id, reason: 'duplicate QA request' }),
  });
  assert.equal(duplicateCategoryDeletionRequest.status, 409, 'a second pending deletion request for the same entity is rejected'); checks++;
  assert.equal((await duplicateCategoryDeletionRequest.json()).error, 'inventory_deletion_request_pending'); checks++;
  const managerPendingRequests = await fetch(`${base}/api/inventory/deletion-requests`, { headers: categoryManagerHeaders });
  assert.equal(managerPendingRequests.status, 200, 'category manager can reload its own pending deletion request'); checks++;
  assert.ok((await managerPendingRequests.json()).items.some((request) => request.id === categoryDeletionRequest.id), 'manager request reload contains the created request'); checks++;
  const otherManagerPendingRequests = await fetch(`${base}/api/inventory/deletion-requests`, { headers: readerHeaders });
  assert.equal(otherManagerPendingRequests.status, 200, 'another read-only manager can query its request list'); checks++;
  assert.ok(!(await otherManagerPendingRequests.json()).items.some((request) => request.id === categoryDeletionRequest.id), 'request list hides another manager’s pending request'); checks++;
  const ownerPendingRequests = await fetch(`${base}/api/inventory/deletion-requests`, { headers: ownerHeaders });
  assert.equal(ownerPendingRequests.status, 200, 'owner can inspect pending deletion requests in its venue'); checks++;
  assert.ok((await ownerPendingRequests.json()).items.some((request) => request.id === categoryDeletionRequest.id), 'owner sees the synthetic category request'); checks++;
  for (const [label, headers] of [['foreign organization', foreignHeaders], ['sibling venue', siblingHeaders]]) {
    const crossVenueRequestList = await fetch(`${base}/api/inventory/deletion-requests`, { headers });
    assert.equal(crossVenueRequestList.status, 200, `${label} owner can inspect its own pending request list`); checks++;
    assert.ok(!(await crossVenueRequestList.json()).items.some((request) => request.id === categoryDeletionRequest.id), `${label} request list excludes the source venue request`); checks++;
    const crossVenueDecision = await fetch(`${base}/api/inventory/deletion-requests/${categoryDeletionRequest.id}/approve`, { method: 'POST', headers });
    assert.equal(crossVenueDecision.status, 404, `${label} owner cannot approve a request from another venue`); checks++;
    assert.equal((await crossVenueDecision.json()).error, 'inventory_deletion_request_not_found'); checks++;
    const crossVenuePermanentDelete = await fetch(`${base}/api/inventory/permanent-deletions`, {
      method: 'POST', headers,
      body: JSON.stringify({ entityType: 'category', entityId: deletionCategory.id }),
    });
    assert.equal(crossVenuePermanentDelete.status, 409, `${label} owner cannot permanently delete an archived category from another venue`); checks++;
    assert.equal((await crossVenuePermanentDelete.json()).error, 'inventory_archived_entry_not_found'); checks++;
  }
  const categoryAndRequestBeforeOwnerDelete = await db.query(`SELECT
      (SELECT is_active FROM product_categories WHERE id=$1 AND venue_id=$2) AS category_active,
      (SELECT status FROM inventory_deletion_requests WHERE id=$3 AND venue_id=$2) AS request_status,
      (SELECT count(*)::int FROM inventory_deletion_requests WHERE venue_id=$2 AND entity_type='category' AND entity_id=$1::text) AS request_count`,
  [deletionCategory.id, ids.venue, categoryDeletionRequest.id]);
  assert.deepEqual(categoryAndRequestBeforeOwnerDelete.rows[0], { category_active: false, request_status: 'pending', request_count: 1 }, 'foreign and sibling attempts preserve the archived category and single pending request'); checks++;
  const readerRequestDenied = await fetch(`${base}/api/inventory/deletion-requests`, { headers: restrictedHeaders });
  assert.equal(readerRequestDenied.status, 403, 'role without inventory read scope cannot inspect deletion requests'); checks++;
  const readOnlyRequestCreateDenied = await fetch(`${base}/api/inventory/deletion-requests`, {
    method: 'POST', headers: readerHeaders,
    body: JSON.stringify({ entityType: 'category', entityId: deletionCategory.id, reason: 'forbidden QA request' }),
  });
  assert.equal(readOnlyRequestCreateDenied.status, 403, 'inventory_read manager cannot create a deletion request'); checks++;
  const categoryManagerDecisionDenied = await fetch(`${base}/api/inventory/deletion-requests/${categoryDeletionRequest.id}/approve`, {
    method: 'POST', headers: categoryManagerHeaders,
  });
  assert.equal(categoryManagerDecisionDenied.status, 403, 'category manager cannot decide its own permanent deletion request'); checks++;
  const categoryManagerDirectDeleteDenied = await fetch(`${base}/api/inventory/permanent-deletions`, {
    method: 'POST', headers: categoryManagerHeaders,
    body: JSON.stringify({ entityType: 'category', entityId: deletionCategory.id }),
  });
  assert.equal(categoryManagerDirectDeleteDenied.status, 403, 'category manager cannot bypass owner approval with direct permanent deletion'); checks++;
  const ownerPermanentDelete = await fetch(`${base}/api/inventory/permanent-deletions`, {
    method: 'POST', headers: ownerHeaders,
    body: JSON.stringify({ entityType: 'category', entityId: deletionCategory.id }),
  });
  assert.equal(ownerPermanentDelete.status, 200, 'owner can permanently delete its archived unused category'); checks++;
  assert.equal((await ownerPermanentDelete.json()).deleted, true); checks++;
  const deletedCategoryAndRequest = await db.query(`SELECT
      EXISTS(SELECT 1 FROM product_categories WHERE id=$1 AND venue_id=$2) AS category_exists,
      status,decided_by,decided_by_name,decided_at
    FROM inventory_deletion_requests WHERE id=$3 AND venue_id=$2`, [deletionCategory.id, ids.venue, categoryDeletionRequest.id]);
  assert.equal(deletedCategoryAndRequest.rowCount, 1, 'owner decision preserves an auditable request row'); checks++;
  assert.equal(deletedCategoryAndRequest.rows[0].category_exists, false, 'owner deletion removes only the archived category in its venue'); checks++;
  assert.equal(deletedCategoryAndRequest.rows[0].status, 'rejected', 'direct owner deletion closes the now-obsolete pending approval as rejected'); checks++;
  assert.equal(deletedCategoryAndRequest.rows[0].decided_by, ids.owner); checks++;
  assert.equal(deletedCategoryAndRequest.rows[0].decided_by_name, 'QA44 synthetic owner'); checks++;
  assert.ok(deletedCategoryAndRequest.rows[0].decided_at, 'direct owner deletion stores the request decision timestamp'); checks++;
  const ownerPendingAfterDelete = await fetch(`${base}/api/inventory/deletion-requests`, { headers: ownerHeaders });
  assert.equal(ownerPendingAfterDelete.status, 200); checks++;
  assert.ok(!(await ownerPendingAfterDelete.json()).items.some((request) => request.id === categoryDeletionRequest.id), 'closed request disappears from the owner pending list after reload'); checks++;
  const repeatedRequestDecision = await fetch(`${base}/api/inventory/deletion-requests/${categoryDeletionRequest.id}/approve`, { method: 'POST', headers: ownerHeaders });
  assert.equal(repeatedRequestDecision.status, 404, 'closed deletion request cannot be approved later'); checks++;
  assert.equal((await repeatedRequestDecision.json()).error, 'inventory_deletion_request_not_found'); checks++;
  const approvedCategoryCreate = await fetch(`${base}/api/product-categories`, {
    method: 'POST', headers: ownerHeaders,
    body: JSON.stringify({ name: `QA44 approved deletion ${marker}`, department: 'hookah' }),
  });
  assert.equal(approvedCategoryCreate.status, 201, 'owner creates a second unused category for approval-path control'); checks++;
  const approvedCategory = await approvedCategoryCreate.json();
  const approvedCategoryArchive = await fetch(`${base}/api/product-categories/${approvedCategory.id}`, {
    method: 'DELETE', headers: categoryManagerHeaders,
  });
  assert.equal(approvedCategoryArchive.status, 200, 'category manager archives the approval-path fixture'); checks++;
  const approvedCategoryRequestResponse = await fetch(`${base}/api/inventory/deletion-requests`, {
    method: 'POST', headers: categoryManagerHeaders,
    body: JSON.stringify({ entityType: 'category', entityId: approvedCategory.id, reason: 'QA44 approval endpoint control' }),
  });
  assert.equal(approvedCategoryRequestResponse.status, 201, 'category manager creates the approval-path request'); checks++;
  const approvedCategoryRequest = await approvedCategoryRequestResponse.json();
  const approveCategoryRequestResponse = await fetch(`${base}/api/inventory/deletion-requests/${approvedCategoryRequest.id}/approve`, {
    method: 'POST', headers: ownerHeaders,
  });
  assert.equal(approveCategoryRequestResponse.status, 200, 'owner approves and completes the pending category deletion request'); checks++;
  const approvedCategoryRequestBody = await approveCategoryRequestResponse.json();
  assert.equal(approvedCategoryRequestBody.status, 'approved'); checks++;
  assert.equal(approvedCategoryRequestBody.entityId, approvedCategory.id); checks++;
  const approvedCategoryReadback = await db.query(`SELECT
      EXISTS(SELECT 1 FROM product_categories WHERE id=$1 AND venue_id=$2) AS category_exists,
      status,decided_by,decided_by_name,decided_at
    FROM inventory_deletion_requests WHERE id=$3 AND venue_id=$2`, [approvedCategory.id, ids.venue, approvedCategoryRequest.id]);
  assert.equal(approvedCategoryReadback.rowCount, 1, 'approved request remains available for PostgreSQL audit readback'); checks++;
  assert.equal(approvedCategoryReadback.rows[0].category_exists, false, 'approved request removes the archived category in its own venue'); checks++;
  assert.equal(approvedCategoryReadback.rows[0].status, 'approved'); checks++;
  assert.equal(approvedCategoryReadback.rows[0].decided_by, ids.owner); checks++;
  assert.equal(approvedCategoryReadback.rows[0].decided_by_name, 'QA44 synthetic owner'); checks++;
  assert.ok(approvedCategoryReadback.rows[0].decided_at, 'approved request stores decision timestamp'); checks++;
  const repeatApprovedCategoryDecision = await fetch(`${base}/api/inventory/deletion-requests/${approvedCategoryRequest.id}/approve`, {
    method: 'POST', headers: ownerHeaders,
  });
  assert.equal(repeatApprovedCategoryDecision.status, 404, 'already approved deletion request cannot be applied twice'); checks++;
  assert.equal((await repeatApprovedCategoryDecision.json()).error, 'inventory_deletion_request_not_found'); checks++;
  const siblingAutoOrdersResponse = await fetch(`${base}/api/inventory/auto-orders`, { headers: siblingHeaders });
  assert.equal(siblingAutoOrdersResponse.status, 200, 'sibling venue owner can read its own auto-order page'); checks++;
  const siblingAutoOrders = await siblingAutoOrdersResponse.json();
  assert.ok(!siblingAutoOrders.items.some((item) => item.id === autoOrderIngredient.id), 'sibling venue recommendations exclude the first venue ingredient'); checks++;
  assert.ok(!siblingAutoOrders.requests.some((request) => request.id === roleAutoOrder.id), 'sibling venue history excludes the first venue auto-order'); checks++;
  const siblingAutoOrderCancel = await fetch(`${base}/api/inventory/auto-orders/${roleAutoOrder.id}`, {
    method: 'PATCH', headers: siblingHeaders, body: JSON.stringify({ status: 'cancelled' }),
  });
  assert.equal(siblingAutoOrderCancel.status, 404, 'sibling venue owner cannot address another venue auto-order'); checks++;
  assert.equal((await siblingAutoOrderCancel.json()).error, 'auto_order_not_found', 'sibling venue mutation uses the canonical not-found response'); checks++;
  const siblingAutoOrderCreate = await fetch(`${base}/api/inventory/auto-orders`, {
    method: 'POST', headers: siblingHeaders,
    body: JSON.stringify({ items: [{ itemId: autoOrderIngredient.id, quantity: 100 }] }),
  });
  assert.equal(siblingAutoOrderCreate.status, 400, 'sibling venue owner cannot create a request using another venue ingredient'); checks++;
  assert.equal((await siblingAutoOrderCreate.json()).error, 'auto_order_item_not_found'); checks++;
  const siblingAutoOrderCount = await db.query('SELECT count(*)::int AS count FROM inventory_auto_orders WHERE venue_id=$1', [siblingVenueId]);
  assert.equal(siblingAutoOrderCount.rows[0].count, 0, 'sibling venue attempts create no auto-order'); checks++;
  const inventoryFactsBeforeRoleChecks = await db.query(`SELECT
      (SELECT count(*)::int FROM ingredients WHERE venue_id=$1) AS primaryItems,
      (SELECT count(*)::int FROM ingredients WHERE venue_id=$2) AS foreignItems,
      (SELECT count(*)::int FROM ingredients WHERE venue_id=$3) AS siblingItems,
      (SELECT name FROM ingredients WHERE id=$4 AND venue_id=$1) AS sourceName,
      (SELECT is_marked FROM ingredients WHERE id=$4 AND venue_id=$1) AS sourceIsMarked,
      (SELECT min_stock FROM ingredients WHERE id=$4 AND venue_id=$1) AS sourceMinimum,
      (SELECT count(*)::int FROM stock_movements WHERE venue_id=$1 AND ingredient_id=$4) AS sourceMovements,
      (SELECT COALESCE(SUM(CASE WHEN direction IN ('in','transfer','adjustment') THEN quantity WHEN direction IN ('out','waste') THEN -quantity ELSE 0 END),0)::numeric FROM stock_movements WHERE venue_id=$1 AND ingredient_id=$4) AS sourceBalance,
      (SELECT count(*)::int FROM stock_movements WHERE venue_id=$2) AS foreignMovements,
      (SELECT count(*)::int FROM stock_movements WHERE venue_id=$3) AS siblingMovements`,
  [ids.venue, foreignVenueId, siblingVenueId, autoOrderIngredient.id]);
  const readerInventoryResponse = await fetch(`${base}/api/inventory`, { headers: readerHeaders });
  assert.equal(readerInventoryResponse.status, 200, 'inventory_read manager can inspect the venue stock directory'); checks++;
  const readerInventory = await readerInventoryResponse.json();
  assert.ok(readerInventory.items.some((item) => item.id === autoOrderIngredient.id), 'read-only inventory directory includes its own low-stock item'); checks++;
  assert.ok(readerInventory.lowStock.some((item) => item.id === autoOrderIngredient.id), 'read-only inventory directory includes its own low-stock recommendation'); checks++;
  assert.ok(readerInventory.movements.some((movement) => movement.itemId === premixComponent.id), 'read-only inventory directory includes movements from its own venue'); checks++;
  const restrictedInventoryResponse = await fetch(`${base}/api/inventory`, { headers: restrictedHeaders });
  assert.equal(restrictedInventoryResponse.status, 403, 'role without inventory scopes cannot read the stock directory'); checks++;
  for (const [label, headers] of [['inventory_read manager', readerHeaders], ['role without inventory scopes', restrictedHeaders]]) {
    const deniedItemCreate = await fetch(`${base}/api/inventory/items`, {
      method: 'POST', headers,
      body: JSON.stringify({ name: `QA denied item ${label} ${marker}`, unit: 'мл', itemType: 'ingredient', cost: 0, department: 'hookah', category: 'Без категории' }),
    });
    assert.equal(deniedItemCreate.status, 403, `${label} cannot create an inventory item`); checks++;
    const deniedItemUpdate = await fetch(`${base}/api/inventory/items/${autoOrderIngredient.id}`, {
      method: 'PATCH', headers, body: JSON.stringify({ name: `QA denied rename ${label} ${marker}` }),
    });
    assert.equal(deniedItemUpdate.status, 403, `${label} cannot rename an inventory item`); checks++;
    const deniedItemArchive = await fetch(`${base}/api/inventory/items/${autoOrderIngredient.id}`, { method: 'DELETE', headers });
    assert.equal(deniedItemArchive.status, 403, `${label} cannot archive an inventory item`); checks++;
    const deniedMovement = await fetch(`${base}/api/inventory/movements`, {
      method: 'POST', headers,
      body: JSON.stringify({ itemId: autoOrderIngredient.id, delta: 1, unit: 'мл', reason: 'QA denied movement' }),
    });
    assert.equal(deniedMovement.status, 403, `${label} cannot adjust inventory through movements`); checks++;
  }
  for (const [label, headers] of [['foreign organization', foreignHeaders], ['sibling venue', siblingHeaders]]) {
    const scopedInventoryResponse = await fetch(`${base}/api/inventory`, { headers });
    assert.equal(scopedInventoryResponse.status, 200, `${label} owner can read the scoped stock directory`); checks++;
    const scopedInventory = await scopedInventoryResponse.json();
    assert.ok(!scopedInventory.items.some((item) => item.id === autoOrderIngredient.id), `${label} stock directory excludes the first venue ingredient`); checks++;
    assert.ok(!scopedInventory.lowStock.some((item) => item.id === autoOrderIngredient.id), `${label} low-stock list excludes the first venue ingredient`); checks++;
    assert.ok(!scopedInventory.movements.some((movement) => movement.itemId === premixComponent.id), `${label} stock directory excludes movements from the first venue`); checks++;
    const foreignItemUpdate = await fetch(`${base}/api/inventory/items/${autoOrderIngredient.id}`, {
      method: 'PATCH', headers, body: JSON.stringify({ name: `QA cross-venue rename ${marker}` }),
    });
    assert.equal(foreignItemUpdate.status, 404, `${label} cannot update the first venue ingredient`); checks++;
    assert.equal((await foreignItemUpdate.json()).error, 'inventory_item_not_found', `${label} update uses canonical not-found response`); checks++;
    const foreignItemArchive = await fetch(`${base}/api/inventory/items/${autoOrderIngredient.id}`, { method: 'DELETE', headers });
    assert.equal(foreignItemArchive.status, 404, `${label} cannot archive the first venue ingredient`); checks++;
    assert.equal((await foreignItemArchive.json()).error, 'inventory_item_not_found', `${label} archive uses canonical not-found response`); checks++;
    const foreignMovement = await fetch(`${base}/api/inventory/movements`, {
      method: 'POST', headers,
      body: JSON.stringify({ itemId: autoOrderIngredient.id, delta: 1, unit: 'мл', reason: 'QA cross-venue movement' }),
    });
    assert.equal(foreignMovement.status, 400, `${label} cannot move stock using another venue item`); checks++;
    assert.equal((await foreignMovement.json()).error, 'invalid_movement_unit', `${label} movement does not resolve the foreign item in its venue`); checks++;
  }
  const inventoryFactsAfterRoleChecks = await db.query(`SELECT
      (SELECT count(*)::int FROM ingredients WHERE venue_id=$1) AS primaryItems,
      (SELECT count(*)::int FROM ingredients WHERE venue_id=$2) AS foreignItems,
      (SELECT count(*)::int FROM ingredients WHERE venue_id=$3) AS siblingItems,
      (SELECT name FROM ingredients WHERE id=$4 AND venue_id=$1) AS sourceName,
      (SELECT is_marked FROM ingredients WHERE id=$4 AND venue_id=$1) AS sourceIsMarked,
      (SELECT min_stock FROM ingredients WHERE id=$4 AND venue_id=$1) AS sourceMinimum,
      (SELECT count(*)::int FROM stock_movements WHERE venue_id=$1 AND ingredient_id=$4) AS sourceMovements,
      (SELECT COALESCE(SUM(CASE WHEN direction IN ('in','transfer','adjustment') THEN quantity WHEN direction IN ('out','waste') THEN -quantity ELSE 0 END),0)::numeric FROM stock_movements WHERE venue_id=$1 AND ingredient_id=$4) AS sourceBalance,
      (SELECT count(*)::int FROM stock_movements WHERE venue_id=$2) AS foreignMovements,
      (SELECT count(*)::int FROM stock_movements WHERE venue_id=$3) AS siblingMovements`,
  [ids.venue, foreignVenueId, siblingVenueId, autoOrderIngredient.id]);
  assert.deepEqual(inventoryFactsAfterRoleChecks.rows, inventoryFactsBeforeRoleChecks.rows, 'denied item and movement actions preserve all venue counts, low-stock source fields, and stock balance'); checks++;
  const foreignVenueInventoryCount = await db.query('SELECT count(*)::int AS count FROM ingredients WHERE venue_id=$1', [foreignVenueId]);
  const siblingVenueInventoryCount = await db.query('SELECT count(*)::int AS count FROM ingredients WHERE venue_id=$1', [siblingVenueId]);
  assert.equal(foreignVenueInventoryCount.rows[0].count, 0, 'foreign item and movement attempts create no stock item'); checks++;
  assert.equal(siblingVenueInventoryCount.rows[0].count, 0, 'sibling item and movement attempts create no stock item'); checks++;
  const tenantBoundCreatedItems = [];
  for (const [label, headers, venueId] of [
    ['foreign organization', foreignHeaders, foreignVenueId],
    ['sibling venue', siblingHeaders, siblingVenueId],
  ]) {
    const scopedCreateResponse = await fetch(`${base}/api/inventory/items`, {
      method: 'POST', headers,
      body: JSON.stringify({ name: `QA ${label} scoped item ${marker}`, unit: 'мл', itemType: 'ingredient', cost: 0, minLevel: 1, department: 'hookah', category: 'Без категории' }),
    });
    assert.equal(scopedCreateResponse.status, 201, `${label} owner can create an item in its own venue`); checks++;
    const scopedCreatedItem = await scopedCreateResponse.json();
    tenantBoundCreatedItems.push({ id: scopedCreatedItem.id, venueId });
    const scopedReadResponse = await fetch(`${base}/api/inventory`, { headers });
    assert.equal(scopedReadResponse.status, 200, `${label} owner can reload its venue inventory`); checks++;
    const scopedRead = await scopedReadResponse.json();
    assert.ok(scopedRead.items.some((item) => item.id === scopedCreatedItem.id), `${label} owner sees its newly created item`); checks++;
    assert.ok(scopedRead.lowStock.some((item) => item.id === scopedCreatedItem.id), `${label} owner sees its newly created low-stock item`); checks++;
    assert.ok(!scopedRead.items.some((item) => item.id === autoOrderIngredient.id), `${label} inventory still excludes the source venue item`); checks++;
  }
  for (const createdItem of tenantBoundCreatedItems) {
    const createdItemVenue = await db.query('SELECT venue_id FROM ingredients WHERE id=$1', [createdItem.id]);
    assert.equal(createdItemVenue.rowCount, 1, 'authorized item creation persists exactly one inventory row'); checks++;
    assert.equal(createdItemVenue.rows[0]?.venue_id, createdItem.venueId, 'authorized item creation is bound to the authenticated session venue'); checks++;
    assert.notEqual(createdItemVenue.rows[0]?.venue_id, ids.venue, 'authorized tenant item creation cannot write into the source venue'); checks++;
  }
  const supplySourceBeforeDenials = await db.query(`SELECT i.id,i.venue_id,i.cost,
      COALESCE(SUM(CASE WHEN m.direction IN ('in','transfer','adjustment') THEN m.quantity WHEN m.direction IN ('out','waste') THEN -m.quantity ELSE 0 END),0)::numeric AS balance,
      count(m.id)::int AS movement_count
    FROM ingredients i LEFT JOIN stock_movements m ON m.ingredient_id=i.id AND m.venue_id=i.venue_id
    WHERE i.id=$1 AND i.venue_id=$2 GROUP BY i.id`, [autoOrderIngredient.id, ids.venue]);
  const supplyDestinationsBeforeDenials = await db.query(`SELECT i.id,i.venue_id,i.cost,
      COALESCE(SUM(CASE WHEN m.direction IN ('in','transfer','adjustment') THEN m.quantity WHEN m.direction IN ('out','waste') THEN -m.quantity ELSE 0 END),0)::numeric AS balance,
      count(m.id)::int AS movement_count
    FROM ingredients i LEFT JOIN stock_movements m ON m.ingredient_id=i.id AND m.venue_id=i.venue_id
    WHERE i.id=ANY($1::uuid[]) GROUP BY i.id ORDER BY i.id`, [tenantBoundCreatedItems.map((item) => item.id)]);
  assert.equal(supplySourceBeforeDenials.rowCount, 1, 'supply boundary source fixture exists in the authenticated venue'); checks++;
  assert.equal(supplyDestinationsBeforeDenials.rowCount, tenantBoundCreatedItems.length, 'both destination supply fixtures exist before boundary attempts'); checks++;
  const validDeniedSupplyPayload = { itemId: autoOrderIngredient.id, quantity: 1, unit: 'мл', unitCost: 1 };
  for (const [label, headers] of [['inventory_read manager', readerHeaders], ['role without inventory scopes', restrictedHeaders]]) {
    const deniedSupply = await fetch(`${base}/api/inventory/supplies`, {
      method: 'POST', headers, body: JSON.stringify(validDeniedSupplyPayload),
    });
    assert.equal(deniedSupply.status, 403, `${label} cannot receive inventory supplies`); checks++;
    assert.equal((await deniedSupply.json()).permission, 'inventory', `${label} supply denial names the required write permission`); checks++;
  }
  for (const [label, headers] of [['foreign organization', foreignHeaders], ['sibling venue', siblingHeaders]]) {
    const crossVenueSupply = await fetch(`${base}/api/inventory/supplies`, {
      method: 'POST', headers, body: JSON.stringify(validDeniedSupplyPayload),
    });
    assert.equal(crossVenueSupply.status, 400, `${label} cannot receive a supply against the source-venue item`); checks++;
    assert.equal((await crossVenueSupply.json()).error, 'invalid_supply_unit', `${label} source item is unresolved by its venue-scoped inventory`); checks++;
  }
  const supplySourceAfterDenials = await db.query(`SELECT i.id,i.venue_id,i.cost,
      COALESCE(SUM(CASE WHEN m.direction IN ('in','transfer','adjustment') THEN m.quantity WHEN m.direction IN ('out','waste') THEN -m.quantity ELSE 0 END),0)::numeric AS balance,
      count(m.id)::int AS movement_count
    FROM ingredients i LEFT JOIN stock_movements m ON m.ingredient_id=i.id AND m.venue_id=i.venue_id
    WHERE i.id=$1 AND i.venue_id=$2 GROUP BY i.id`, [autoOrderIngredient.id, ids.venue]);
  const supplyDestinationsAfterDenials = await db.query(`SELECT i.id,i.venue_id,i.cost,
      COALESCE(SUM(CASE WHEN m.direction IN ('in','transfer','adjustment') THEN m.quantity WHEN m.direction IN ('out','waste') THEN -m.quantity ELSE 0 END),0)::numeric AS balance,
      count(m.id)::int AS movement_count
    FROM ingredients i LEFT JOIN stock_movements m ON m.ingredient_id=i.id AND m.venue_id=i.venue_id
    WHERE i.id=ANY($1::uuid[]) GROUP BY i.id ORDER BY i.id`, [tenantBoundCreatedItems.map((item) => item.id)]);
  assert.deepEqual(supplySourceAfterDenials.rows, supplySourceBeforeDenials.rows, 'role and cross-venue supply denials preserve source balance, cost, and movement count'); checks++;
  assert.deepEqual(supplyDestinationsAfterDenials.rows, supplyDestinationsBeforeDenials.rows, 'cross-venue supply denials preserve destination balances, costs, and movement counts'); checks++;
  for (const [label, headers, scopedItem] of [
    ['foreign organization', foreignHeaders, tenantBoundCreatedItems.find((item) => item.venueId === foreignVenueId)],
    ['sibling venue', siblingHeaders, tenantBoundCreatedItems.find((item) => item.venueId === siblingVenueId)],
  ]) {
    const openingMovementResponse = await fetch(`${base}/api/inventory/movements`, {
      method: 'POST', headers,
      body: JSON.stringify({ itemId: scopedItem.id, delta: 5, unit: 'мл', reason: `QA ${label} opening stock ${marker}` }),
    });
    assert.equal(openingMovementResponse.status, 201, `${label} owner can seed its own opening stock`); checks++;
    const openingMovement = await openingMovementResponse.json();
    assert.equal(Number(openingMovement.delta), 5); checks++;
    const openingMovementPg = await db.query(`SELECT m.venue_id,m.ingredient_id,m.direction,m.quantity,i.cost
      FROM stock_movements m JOIN ingredients i ON i.id=m.ingredient_id AND i.venue_id=m.venue_id
      WHERE m.id=$1 AND m.venue_id=$2 AND m.ingredient_id=$3`, [openingMovement.id, scopedItem.venueId, scopedItem.id]);
    assert.equal(openingMovementPg.rowCount, 1, `${label} opening stock movement persists under its venue`); checks++;
    assert.equal(openingMovementPg.rows[0].direction, 'in'); checks++;
    assert.equal(Number(openingMovementPg.rows[0].quantity), 5); checks++;
    await db.query('UPDATE ingredients SET cost=$1 WHERE id=$2 AND venue_id=$3', [2, scopedItem.id, scopedItem.venueId]);
    const receiveResponse = await fetch(`${base}/api/inventory/supplies`, {
      method: 'POST', headers,
      body: JSON.stringify({ itemId: scopedItem.id, quantity: 2, unit: 'л', unitCost: 120, supplier: `QA ${label} supplier ${marker}` }),
    });
    assert.equal(receiveResponse.status, 201, `${label} owner can receive supplies for its own item`); checks++;
    const received = await receiveResponse.json();
    assert.equal(received.itemId, scopedItem.id); checks++;
    assert.equal(received.direction, 'in'); checks++;
    assert.equal(Number(received.delta), 2000); checks++;
    assert.equal(received.sourceUnit, 'л'); checks++;
    assert.equal(received.unit, 'мл'); checks++;
    assert.equal(Number(received.onHandBefore), 5); checks++;
    assert.equal(Number(received.onHandAfter), 2005); checks++;
    assert.equal(Number(received.weightedCost), 0.1247); checks++;
    const receivedMovement = await db.query(`SELECT m.id,m.venue_id,m.ingredient_id,m.direction,m.quantity,i.cost,
        COALESCE((SELECT SUM(CASE WHEN movement.direction IN ('in','transfer','adjustment') THEN movement.quantity WHEN movement.direction IN ('out','waste') THEN -movement.quantity ELSE 0 END)
          FROM stock_movements movement WHERE movement.venue_id=m.venue_id AND movement.ingredient_id=m.ingredient_id),0)::numeric AS balance
      FROM stock_movements m JOIN ingredients i ON i.id=m.ingredient_id AND i.venue_id=m.venue_id
      WHERE m.id=$1 AND m.venue_id=$2 AND m.ingredient_id=$3`, [received.id, scopedItem.venueId, scopedItem.id]);
    assert.equal(receivedMovement.rowCount, 1, `${label} supply creates one movement joined to its own venue item`); checks++;
    assert.equal(receivedMovement.rows[0].direction, 'in'); checks++;
    assert.equal(Number(receivedMovement.rows[0].quantity), 2000); checks++;
    assert.equal(Number(receivedMovement.rows[0].balance), 2005); checks++;
    assert.equal(Number(receivedMovement.rows[0].cost), 0.1247); checks++;
    const ownInventoryResponse = await fetch(`${base}/api/inventory`, { headers });
    assert.equal(ownInventoryResponse.status, 200, `${label} owner can reload inventory after receiving supplies`); checks++;
    const ownInventory = await ownInventoryResponse.json();
    const reloadedItem = ownInventory.items.find((item) => item.id === scopedItem.id);
    assert.ok(reloadedItem, `${label} inventory reload contains its supplied item`); checks++;
    assert.equal(Number(reloadedItem.onHand), 2005); checks++;
    assert.equal(Number(reloadedItem.cost), 0.1247); checks++;
    assert.ok(ownInventory.movements.some((movement) => movement.id === received.id), `${label} movement history reload contains the received supply`); checks++;
  }
  const readerAutoOrdersResponse = await fetch(`${base}/api/inventory/auto-orders`, { headers: readerHeaders });
  assert.equal(readerAutoOrdersResponse.status, 200, 'inventory_read manager can inspect auto-order recommendations and history'); checks++;
  const readerAutoOrders = await readerAutoOrdersResponse.json();
  const readerAutoOrder = readerAutoOrders.requests.find((request) => request.id === roleAutoOrder.id);
  assert.ok(readerAutoOrder, 'inventory_read manager can read the synthetic auto-order history row'); checks++;
  assert.equal(readerAutoOrder.status, 'sent', 'read-only history returns the active saved status'); checks++;
  const readerAutoOrderCreateDenied = await fetch(`${base}/api/inventory/auto-orders`, {
    method: 'POST', headers: readerHeaders,
    body: JSON.stringify({ items: [{ itemId: autoOrderIngredient.id, quantity: 100 }] }),
  });
  assert.equal(readerAutoOrderCreateDenied.status, 403, 'inventory_read manager cannot create an auto-order'); checks++;
  const readerAutoOrderCancelDenied = await fetch(`${base}/api/inventory/auto-orders/${roleAutoOrder.id}`, {
    method: 'PATCH', headers: readerHeaders, body: JSON.stringify({ status: 'cancelled' }),
  });
  assert.equal(readerAutoOrderCancelDenied.status, 403, 'inventory_read manager cannot cancel an auto-order'); checks++;
  const restrictedAutoOrdersDenied = await fetch(`${base}/api/inventory/auto-orders`, { headers: restrictedHeaders });
  assert.equal(restrictedAutoOrdersDenied.status, 403, 'role without inventory scopes cannot read auto-orders'); checks++;
  const restrictedAutoOrderCreateDenied = await fetch(`${base}/api/inventory/auto-orders`, {
    method: 'POST', headers: restrictedHeaders,
    body: JSON.stringify({ items: [{ itemId: autoOrderIngredient.id, quantity: 100 }] }),
  });
  assert.equal(restrictedAutoOrderCreateDenied.status, 403, 'role without inventory scopes cannot create an auto-order'); checks++;
  const restrictedAutoOrderCancelDenied = await fetch(`${base}/api/inventory/auto-orders/${roleAutoOrder.id}`, {
    method: 'PATCH', headers: restrictedHeaders, body: JSON.stringify({ status: 'cancelled' }),
  });
  assert.equal(restrictedAutoOrderCancelDenied.status, 403, 'role without inventory scopes cannot cancel an auto-order'); checks++;
  const autoOrderAfterRoleDenials = await db.query(`SELECT
      (SELECT count(*)::int FROM inventory_auto_orders WHERE venue_id=$1) AS count,
      (SELECT status FROM inventory_auto_orders WHERE id=$2 AND venue_id=$1) AS status,
      (SELECT lines FROM inventory_auto_orders WHERE id=$2 AND venue_id=$1) AS lines,
      (SELECT updated_at FROM inventory_auto_orders WHERE id=$2 AND venue_id=$1) AS "updatedAt"`, [ids.venue, roleAutoOrder.id]);
  assert.deepEqual(autoOrderAfterRoleDenials.rows, autoOrderBeforeRoleDenials.rows, 'denied auto-order writes preserve the active request, updated timestamp, and venue total'); checks++;
  const premixHistoryReadable = await fetch(`${base}/api/inventory/premixes`, { headers: readerHeaders });
  assert.equal(premixHistoryReadable.status, 200, 'inventory_read manager can inspect premix history'); checks++;
  const premixReaderHistory = await premixHistoryReadable.json();
  assert.ok(premixReaderHistory.items.some((batch) => batch.id === producedPremix.id), 'read-only premix history includes the produced synthetic batch'); checks++;
  const premixReaderProduceDenied = await fetch(`${base}/api/inventory/premixes/produce`, {
    method: 'POST', headers: readerHeaders,
    body: JSON.stringify({ recipeId: premixRecipe.id, outputItemId: premixOutput.id, multiplier: 1 }),
  });
  assert.equal(premixReaderProduceDenied.status, 403, 'inventory_read manager cannot produce a premix batch'); checks++;
  const premixReaderAdjustDenied = await fetch(`${base}/api/inventory/premixes/${producedPremix.id}/count`, {
    method: 'POST', headers: readerHeaders,
    body: JSON.stringify({ actualQuantity: 700, reason: 'QA forbidden reader adjustment' }),
  });
  assert.equal(premixReaderAdjustDenied.status, 403, 'inventory_read manager cannot adjust a premix batch'); checks++;

  await page.reload({ waitUntil: 'networkidle' });
  const reloadedPremixRow = page.locator(`#premix-batches .premix-batch-row[data-premix-batch="${producedPremix.id}"]`);
  await reloadedPremixRow.waitFor({ state: 'visible' });
  assert.match(await reloadedPremixRow.innerText(), /Факт:\s*750 мл\s*·\s*план:\s*750 мл/); checks++;
  assert.match(await reloadedPremixRow.innerText(), /Остаток:\s*750 мл/); checks++;
  const premixHistoryReadback = await page.evaluate(async () => {
    const response = await fetch('/api/inventory/premixes', { headers: { Authorization: `Bearer ${localStorage.getItem('crm_session_token')}` } });
    return { status: response.status, body: await response.json() };
  });
  assert.equal(premixHistoryReadback.status, 200); checks++;
  const matchingPremixBatches = premixHistoryReadback.body.items.filter((batch) => batch.id === producedPremix.id);
  assert.equal(matchingPremixBatches.length, 1, 'fresh API history contains exactly one persisted synthetic batch'); checks++;
  assert.equal(Number(matchingPremixBatches[0].outputQuantity), 750); checks++;
  assert.equal(Number(matchingPremixBatches[0].plannedOutputQuantity), 750); checks++;
  assert.equal(Number(matchingPremixBatches[0].remainingQuantity), 750); checks++;
  assert.equal(Number(matchingPremixBatches[0].totalCost), 37.5); checks++;

  const premixBatchPg = await db.query(`SELECT b.venue_id,b.recipe_id,b.output_ingredient_id,b.output_quantity,b.planned_output_quantity,
      b.output_unit,b.total_cost,b.ingredients,b.output_movement_id,b.status,i.cost AS output_cost
    FROM inventory_premix_batches b JOIN ingredients i ON i.id=b.output_ingredient_id AND i.venue_id=b.venue_id
    WHERE b.id=$1 AND b.venue_id=$2`, [producedPremix.id, ids.venue]);
  assert.equal(premixBatchPg.rowCount, 1, 'produced batch and output cost persist in the synthetic venue'); checks++;
  assert.equal(premixBatchPg.rows[0].recipe_id, premixRecipe.id); checks++;
  assert.equal(premixBatchPg.rows[0].output_ingredient_id, premixOutput.id); checks++;
  assert.equal(Number(premixBatchPg.rows[0].planned_output_quantity), 750); checks++;
  assert.equal(Number(premixBatchPg.rows[0].output_quantity), 750); checks++;
  assert.equal(premixBatchPg.rows[0].output_unit, 'мл'); checks++;
  assert.equal(Number(premixBatchPg.rows[0].total_cost), 37.5); checks++;
  assert.equal(premixBatchPg.rows[0].status, 'produced'); checks++;
  assert.equal(premixBatchPg.rows[0].ingredients.length, 1); checks++;
  assert.equal(premixBatchPg.rows[0].ingredients[0].ingredientId, premixComponent.id); checks++;
  assert.equal(Number(premixBatchPg.rows[0].ingredients[0].quantity), 375); checks++;
  assert.equal(premixBatchPg.rows[0].ingredients[0].unit, 'мл'); checks++;
  assert.equal(Number(premixBatchPg.rows[0].output_cost), 0.05); checks++;
  const premixMovements = await db.query(`SELECT id,ingredient_id,direction,quantity,reason FROM stock_movements
    WHERE venue_id=$1 AND ingredient_id=ANY($2::uuid[]) AND id<>ALL($3::uuid[]) ORDER BY created_at,id`,
  [ids.venue, [premixComponent.id, premixOutput.id], premixMovementBaseline.rows.map((row) => row.id)]);
  assert.equal(premixMovements.rowCount, 2, 'production appends exactly one component debit and one output credit'); checks++;
  const componentDebit = premixMovements.rows.find((movement) => movement.ingredient_id === premixComponent.id);
  const outputCredit = premixMovements.rows.find((movement) => movement.ingredient_id === premixOutput.id);
  assert.ok(componentDebit); checks++;
  assert.equal(componentDebit.direction, 'out'); checks++;
  assert.equal(Number(componentDebit.quantity), 375); checks++;
  assert.equal(componentDebit.reason, `Приготовление премикса «${premixRecipe.name}»`); checks++;
  assert.ok(outputCredit); checks++;
  assert.equal(outputCredit.direction, 'in'); checks++;
  assert.equal(Number(outputCredit.quantity), 750); checks++;
  assert.equal(outputCredit.reason, `Выход премикса «${premixRecipe.name}»`); checks++;
  assert.equal(premixBatchPg.rows[0].output_movement_id, outputCredit.id); checks++;
  assert.equal(await balance(premixComponent.id), 25, '1.5 multiplier consumes 375 ml and leaves 25 ml of component stock'); checks++;
  assert.equal(await balance(premixOutput.id), 750, '1.5 multiplier credits 750 ml to the separate output stock'); checks++;
  const premixInventoryReadback = await page.evaluate(async (itemIds) => {
    const response = await fetch('/api/inventory', { headers: { Authorization: `Bearer ${localStorage.getItem('crm_session_token')}` } });
    const body = await response.json();
    return { status: response.status, items: body.items.filter((item) => itemIds.includes(item.id)) };
  }, [premixComponent.id, premixOutput.id]);
  assert.equal(premixInventoryReadback.status, 200); checks++;
  const premixInventoryById = new Map(premixInventoryReadback.items.map((item) => [item.id, item]));
  assert.equal(Number(premixInventoryById.get(premixComponent.id)?.onHand), 25); checks++;
  assert.equal(Number(premixInventoryById.get(premixOutput.id)?.onHand), 750); checks++;
  assert.equal(Number(premixInventoryById.get(premixOutput.id)?.cost), 0.05); checks++;

  const premixCountReason = 'QA пересчёт остатка партии';
  const premixWasteReason = 'QA списание порчи партии';
  const batchRow = page.locator(`#premix-batches .premix-batch-row[data-premix-batch="${producedPremix.id}"]`);
  await batchRow.locator('[data-premix-count]').fill('730');
  let countPromptType = '';
  let countPromptMessage = '';
  const countPromptPromise = page.waitForEvent('dialog').then(async (dialog) => {
    countPromptType = dialog.type();
    countPromptMessage = dialog.message();
    await dialog.accept(premixCountReason);
  });
  const countResponsePromise = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/inventory/premixes/${producedPremix.id}/count`);
  await batchRow.locator('[data-premix-action="count"]').click();
  await countPromptPromise;
  assert.equal(countPromptType, 'prompt', 'count action asks the operator for an adjustment reason'); checks++;
  assert.equal(countPromptMessage, 'Причина сверки остатка', 'count action identifies its reason prompt'); checks++;
  const countResponse = await countResponsePromise;
  assert.equal(countResponse.status(), 200, 'UI count action reaches the real API and succeeds'); checks++;
  assert.deepEqual(countResponse.request().postDataJSON(), { reason: premixCountReason, actualQuantity: 730 }, 'count action submits the entered 730 ml and reason'); checks++;
  const countResult = await countResponse.json();
  assert.equal(countResult.id, producedPremix.id); checks++;
  assert.equal(Number(countResult.remainingQuantity), 730); checks++;
  const countedBatchRow = page.locator(`#premix-batches .premix-batch-row[data-premix-batch="${producedPremix.id}"]`);
  await page.waitForFunction(({ batchId, expected }) => {
    const row = document.querySelector(`[data-premix-batch="${batchId}"]`);
    return row?.innerText.includes(expected);
  }, { batchId: producedPremix.id, expected: 'Остаток: 730 мл' });
  assert.match(await countedBatchRow.innerText(), /Остаток:\s*730 мл/); checks++;
  const countHistory = await page.evaluate(async () => {
    const response = await fetch('/api/inventory/premixes', { headers: { Authorization: `Bearer ${localStorage.getItem('crm_session_token')}` } });
    return { status: response.status, body: await response.json() };
  });
  assert.equal(countHistory.status, 200); checks++;
  assert.equal(Number(countHistory.body.items.find((batch) => batch.id === producedPremix.id)?.remainingQuantity), 730); checks++;
  const countPg = await db.query(`SELECT m.id,m.ingredient_id,m.direction,m.quantity,m.reason,lm.movement_type,lm.quantity_delta,lm.reason AS lot_reason
    FROM stock_movements m JOIN inventory_premix_batch_movements lm ON lm.stock_movement_id=m.id
    WHERE m.venue_id=$1 AND lm.venue_id=$1 AND lm.batch_id=$2`, [ids.venue, producedPremix.id]);
  assert.equal(countPg.rowCount, 1, 'count operation creates exactly one batch adjustment movement'); checks++;
  assert.equal(countPg.rows[0].ingredient_id, premixOutput.id); checks++;
  assert.equal(countPg.rows[0].direction, 'out'); checks++;
  assert.equal(Number(countPg.rows[0].quantity), 20); checks++;
  assert.equal(countPg.rows[0].reason, premixCountReason); checks++;
  assert.equal(countPg.rows[0].movement_type, 'adjustment'); checks++;
  assert.equal(Number(countPg.rows[0].quantity_delta), -20); checks++;
  assert.equal(countPg.rows[0].lot_reason, premixCountReason); checks++;
  assert.equal(await balance(premixComponent.id), 25, 'count does not change the component balance'); checks++;
  assert.equal(await balance(premixOutput.id), 730, 'count reduces output stock to the counted 730 ml'); checks++;

  await countedBatchRow.locator('[data-premix-waste]').fill('10');
  let wastePromptType = '';
  let wastePromptMessage = '';
  const wastePromptPromise = page.waitForEvent('dialog').then(async (dialog) => {
    wastePromptType = dialog.type();
    wastePromptMessage = dialog.message();
    await dialog.accept(premixWasteReason);
  });
  const wasteResponsePromise = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/inventory/premixes/${producedPremix.id}/waste`);
  await countedBatchRow.locator('[data-premix-action="waste"]').click();
  await wastePromptPromise;
  assert.equal(wastePromptType, 'prompt', 'waste action asks the operator for a spoilage reason'); checks++;
  assert.equal(wastePromptMessage, 'Причина списания порчи', 'waste action identifies its reason prompt'); checks++;
  const wasteResponse = await wasteResponsePromise;
  assert.equal(wasteResponse.status(), 200, 'UI waste action reaches the real API and succeeds'); checks++;
  assert.deepEqual(wasteResponse.request().postDataJSON(), { reason: premixWasteReason, quantity: 10 }, 'waste action submits 10 ml and its reason'); checks++;
  const wasteResult = await wasteResponse.json();
  assert.equal(wasteResult.id, producedPremix.id); checks++;
  assert.equal(Number(wasteResult.remainingQuantity), 720); checks++;
  const wastedBatchRow = page.locator(`#premix-batches .premix-batch-row[data-premix-batch="${producedPremix.id}"]`);
  await page.waitForFunction(({ batchId, expected }) => {
    const row = document.querySelector(`[data-premix-batch="${batchId}"]`);
    return row?.innerText.includes(expected);
  }, { batchId: producedPremix.id, expected: 'Остаток: 720 мл' });
  assert.match(await wastedBatchRow.innerText(), /Остаток:\s*720 мл/); checks++;
  const wasteHistory = await page.evaluate(async () => {
    const response = await fetch('/api/inventory/premixes', { headers: { Authorization: `Bearer ${localStorage.getItem('crm_session_token')}` } });
    return { status: response.status, body: await response.json() };
  });
  assert.equal(wasteHistory.status, 200); checks++;
  assert.equal(Number(wasteHistory.body.items.find((batch) => batch.id === producedPremix.id)?.remainingQuantity), 720); checks++;
  const batchActionsPg = await db.query(`SELECT m.id,m.ingredient_id,m.direction,m.quantity,m.reason,lm.movement_type,lm.quantity_delta,lm.reason AS lot_reason
    FROM stock_movements m JOIN inventory_premix_batch_movements lm ON lm.stock_movement_id=m.id
    WHERE m.venue_id=$1 AND lm.venue_id=$1 AND lm.batch_id=$2 ORDER BY lm.created_at,lm.id`, [ids.venue, producedPremix.id]);
  assert.equal(batchActionsPg.rowCount, 2, 'count and waste have exactly two batch-linked movements'); checks++;
  const wastePg = batchActionsPg.rows.find((movement) => movement.movement_type === 'waste');
  assert.ok(wastePg); checks++;
  assert.equal(wastePg.ingredient_id, premixOutput.id); checks++;
  assert.equal(wastePg.direction, 'waste'); checks++;
  assert.equal(Number(wastePg.quantity), 10); checks++;
  assert.equal(wastePg.reason, premixWasteReason); checks++;
  assert.equal(Number(wastePg.quantity_delta), -10); checks++;
  assert.equal(wastePg.lot_reason, premixWasteReason); checks++;
  assert.equal(await balance(premixComponent.id), 25, 'waste does not change the component balance'); checks++;
  assert.equal(await balance(premixOutput.id), 720, 'waste leaves 720 ml in output stock'); checks++;
  const finalPremixInventory = await page.evaluate(async (itemIds) => {
    const response = await fetch('/api/inventory', { headers: { Authorization: `Bearer ${localStorage.getItem('crm_session_token')}` } });
    const body = await response.json();
    return { status: response.status, items: body.items.filter((item) => itemIds.includes(item.id)) };
  }, [premixComponent.id, premixOutput.id]);
  assert.equal(finalPremixInventory.status, 200); checks++;
  const finalPremixInventoryById = new Map(finalPremixInventory.items.map((item) => [item.id, item]));
  assert.equal(Number(finalPremixInventoryById.get(premixComponent.id)?.onHand), 25); checks++;
  assert.equal(Number(finalPremixInventoryById.get(premixOutput.id)?.onHand), 720); checks++;

  const voidButton = wastedBatchRow.locator('[data-premix-action="void"]');
  assert.equal(await voidButton.isDisabled(), true, 'void action is disabled after count and waste lot movements'); checks++;
  assert.match(await voidButton.getAttribute('title'), /после складских операций нельзя отменить/, 'disabled void control explains the stock-activity restriction'); checks++;
  let voidPostObserved = false;
  const observeVoidPost = (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === `/api/inventory/premixes/${producedPremix.id}/void`) voidPostObserved = true;
  };
  page.on('request', observeVoidPost);
  await voidButton.click({ force: true });
  await page.waitForTimeout(100);
  page.off('request', observeVoidPost);
  assert.equal(voidPostObserved, false, 'attempting to click the disabled void control sends no API request'); checks++;

  const products = [];
  products.push(await createProduct(productNames[0]));
  products.push(await createProduct(productNames[1]));
  const recipes = [];
  recipes.push(await createRecipe(`QA44 Ремикс Ягода ${marker}`, products[0].id, ingredients[0].id, '18 г'));
  recipes.push(await createRecipe(`QA44 Ремикс Мята ${marker}`, products[1].id, ingredients[1].id, '18 г'));
  for (let index = 0; index < 2; index++) {
    const row = (await db.query('SELECT id,product_id,ingredients,recipe_type FROM inventory_recipe_cards WHERE venue_id=$1 AND id=$2', [ids.venue, recipes[index].id])).rows[0];
    assert.ok(row, `remix ${index + 1} persisted`); checks++;
    assert.equal(row.product_id, products[index].id); checks++;
    assert.equal(row.recipe_type, 'sale'); checks++;
    assert.equal(row.ingredients.length, 1); checks++;
    assert.equal(row.ingredients[0].ingredientId, ingredients[index].id); checks++;
    assert.equal(row.ingredients[0].quantity, '18 г'); checks++;
  }
  const recipeIds = recipes.map((recipe) => recipe.id);
  const recipeFactsBeforeRoleChecks = await db.query(`SELECT
      (SELECT count(*)::int FROM inventory_recipe_cards WHERE venue_id=$1) AS primaryCount,
      (SELECT count(*)::int FROM inventory_recipe_cards WHERE venue_id=$2) AS foreignCount,
      (SELECT count(*)::int FROM inventory_recipe_cards WHERE venue_id=$3) AS siblingCount`,
  [ids.venue, foreignVenueId, siblingVenueId]);
  const sourceRecipeRowsBeforeRoleChecks = await db.query(`SELECT id,venue_id,product_id,name,category,ingredients,technology,serve,
      yield_quantity,yield_unit,portion_count,recipe_type,active,created_at,updated_at
    FROM inventory_recipe_cards WHERE venue_id=$1 AND id=ANY($2::uuid[]) ORDER BY id`, [ids.venue, recipeIds]);
  assert.equal(sourceRecipeRowsBeforeRoleChecks.rowCount, recipeIds.length, 'role-boundary snapshot contains both source recipes'); checks++;
  const sourceRecipeIngredientFactsBeforeRoleChecks = await db.query(`SELECT ingredient_id,count(*)::int AS movement_count,
      COALESCE(SUM(CASE WHEN direction IN ('in','transfer','adjustment') THEN quantity WHEN direction IN ('out','waste') THEN -quantity ELSE 0 END),0)::numeric AS balance
    FROM stock_movements WHERE venue_id=$1 AND ingredient_id=ANY($2::uuid[]) GROUP BY ingredient_id ORDER BY ingredient_id`,
  [ids.venue, [ingredients[0].id, ingredients[1].id]]);
  const readerRecipesResponse = await fetch(`${base}/api/recipes`, { headers: readerHeaders });
  assert.equal(readerRecipesResponse.status, 200, 'inventory_read manager can read recipe cards'); checks++;
  const readerRecipes = await readerRecipesResponse.json();
  for (const recipeId of recipeIds) {
    assert.ok(readerRecipes.items.some((recipe) => recipe.id === recipeId), 'inventory_read manager sees each recipe in its venue'); checks++;
  }
  const readerRecipeCost = await fetch(`${base}/api/recipes/${recipes[0].id}/cost`, { headers: readerHeaders });
  assert.equal(readerRecipeCost.status, 200, 'inventory_read manager can read recipe costing'); checks++;
  assert.equal((await readerRecipeCost.json()).recipeId, recipes[0].id, 'recipe costing is scoped to the readable source recipe'); checks++;
  const deniedRecipePayload = {
    name: `QA denied recipe ${marker}`, category: 'Кальяны',
    ingredients: [{ ingredientId: ingredients[0].id, name: ingredients[0].name, quantity: '18 г' }],
    yieldQuantity: 1, yieldUnit: 'порция', portionCount: 1,
  };
  for (const [label, headers] of [['inventory_read manager', readerHeaders], ['role without inventory scopes', restrictedHeaders]]) {
    const deniedRecipeList = await fetch(`${base}/api/recipes`, { headers });
    assert.equal(deniedRecipeList.status, label === 'inventory_read manager' ? 200 : 403, `${label} recipe list access follows inventory_read`); checks++;
    if (label === 'inventory_read manager') {
      const visibleRecipes = await deniedRecipeList.json();
      assert.ok(visibleRecipes.items.some((recipe) => recipe.id === recipes[0].id), 'read-only manager recipe list includes its own fixture'); checks++;
    }
    const deniedRecipeCost = await fetch(`${base}/api/recipes/${recipes[0].id}/cost`, { headers });
    assert.equal(deniedRecipeCost.status, label === 'inventory_read manager' ? 200 : 403, `${label} recipe costing follows inventory_read`); checks++;
    for (const [method, url, body] of [
      ['POST', `${base}/api/recipes`, deniedRecipePayload],
      ['PATCH', `${base}/api/recipes/${recipes[0].id}`, { name: `QA denied rename ${marker}` }],
      ['DELETE', `${base}/api/recipes/${recipes[0].id}`, undefined],
    ]) {
      const deniedMutation = await fetch(url, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
      assert.equal(deniedMutation.status, 403, `${label} cannot ${method} recipe cards`); checks++;
    }
  }
  for (const [label, headers, scopedIngredient] of [
    ['foreign organization', foreignHeaders, tenantBoundCreatedItems.find((item) => item.venueId === foreignVenueId)],
    ['sibling venue', siblingHeaders, tenantBoundCreatedItems.find((item) => item.venueId === siblingVenueId)],
  ]) {
    const scopedRecipesResponse = await fetch(`${base}/api/recipes`, { headers });
    assert.equal(scopedRecipesResponse.status, 200, `${label} owner can read its own recipe directory`); checks++;
    const scopedRecipes = await scopedRecipesResponse.json();
    for (const recipeId of recipeIds) {
      assert.ok(!scopedRecipes.items.some((recipe) => recipe.id === recipeId), `${label} recipe directory excludes the source recipe`); checks++;
    }
    const scopedRecipeCost = await fetch(`${base}/api/recipes/${recipes[0].id}/cost`, { headers });
    assert.equal(scopedRecipeCost.status, 404, `${label} cannot read source recipe costing`); checks++;
    assert.equal((await scopedRecipeCost.json()).error, 'recipe_not_found', `${label} source cost lookup uses canonical not-found`); checks++;
    for (const [method, body] of [['PATCH', { name: `QA cross-venue recipe rename ${marker}` }], ['DELETE', undefined]]) {
      const scopedMutation = await fetch(`${base}/api/recipes/${recipes[0].id}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
      assert.equal(scopedMutation.status, 404, `${label} cannot ${method} the source recipe`); checks++;
      assert.equal((await scopedMutation.json()).error, 'recipe_not_found', `${label} recipe ${method} uses canonical not-found`); checks++;
    }
    const foreignIngredientRecipe = await fetch(`${base}/api/recipes`, {
      method: 'POST', headers,
      body: JSON.stringify({ ...deniedRecipePayload, name: `QA ${label} foreign ingredient ${marker}` }),
    });
    assert.equal(foreignIngredientRecipe.status, 400, `${label} cannot create a recipe using a source-venue ingredient`); checks++;
    assert.equal((await foreignIngredientRecipe.json()).error, 'recipe_ingredient_not_found', `${label} source ingredient is not resolvable in its venue`); checks++;
    const foreignProductRecipe = await fetch(`${base}/api/recipes`, {
      method: 'POST', headers,
      body: JSON.stringify({
        ...deniedRecipePayload, name: `QA ${label} foreign product ${marker}`, productId: products[0].id,
        ingredients: [{ ingredientId: scopedIngredient.id, quantity: '1 мл' }],
      }),
    });
    assert.equal(foreignProductRecipe.status, 400, `${label} cannot bind a recipe to a source-venue product`); checks++;
    assert.equal((await foreignProductRecipe.json()).error, 'recipe_product_not_found', `${label} source product is not resolvable in its venue`); checks++;
  }
  const recipeFactsAfterRoleChecks = await db.query(`SELECT
      (SELECT count(*)::int FROM inventory_recipe_cards WHERE venue_id=$1) AS primaryCount,
      (SELECT count(*)::int FROM inventory_recipe_cards WHERE venue_id=$2) AS foreignCount,
      (SELECT count(*)::int FROM inventory_recipe_cards WHERE venue_id=$3) AS siblingCount`,
  [ids.venue, foreignVenueId, siblingVenueId]);
  const sourceRecipeRowsAfterRoleChecks = await db.query(`SELECT id,venue_id,product_id,name,category,ingredients,technology,serve,
      yield_quantity,yield_unit,portion_count,recipe_type,active,created_at,updated_at
    FROM inventory_recipe_cards WHERE venue_id=$1 AND id=ANY($2::uuid[]) ORDER BY id`, [ids.venue, recipeIds]);
  assert.deepEqual(recipeFactsAfterRoleChecks.rows, recipeFactsBeforeRoleChecks.rows, 'denied recipe writes create no source, foreign or sibling cards'); checks++;
  assert.deepEqual(sourceRecipeRowsAfterRoleChecks.rows, sourceRecipeRowsBeforeRoleChecks.rows, 'denied recipe writes preserve source cards and updated_at'); checks++;
  const sourceRecipeIngredientFactsAfterRoleChecks = await db.query(`SELECT ingredient_id,count(*)::int AS movement_count,
      COALESCE(SUM(CASE WHEN direction IN ('in','transfer','adjustment') THEN quantity WHEN direction IN ('out','waste') THEN -quantity ELSE 0 END),0)::numeric AS balance
    FROM stock_movements WHERE venue_id=$1 AND ingredient_id=ANY($2::uuid[]) GROUP BY ingredient_id ORDER BY ingredient_id`,
  [ids.venue, [ingredients[0].id, ingredients[1].id]]);
  assert.deepEqual(sourceRecipeIngredientFactsAfterRoleChecks.rows, sourceRecipeIngredientFactsBeforeRoleChecks.rows, 'rejected cross-venue recipe creates leave source inventory ledger unchanged'); checks++;
  for (const [label, headers, scopedIngredient] of [
    ['foreign organization', foreignHeaders, tenantBoundCreatedItems.find((item) => item.venueId === foreignVenueId)],
    ['sibling venue', siblingHeaders, tenantBoundCreatedItems.find((item) => item.venueId === siblingVenueId)],
  ]) {
    const ownRecipeCreate = await fetch(`${base}/api/recipes`, {
      method: 'POST', headers,
      body: JSON.stringify({
        name: `QA ${label} own recipe ${marker}`, category: 'Кальяны', recipeType: 'premix',
        ingredients: [{ ingredientId: scopedIngredient.id, name: scopedIngredient.name, quantity: '1 мл' }],
        yieldQuantity: 1, yieldUnit: 'мл', portionCount: 1,
      }),
    });
    assert.equal(ownRecipeCreate.status, 201, `${label} owner can create a recipe from its own inventory`); checks++;
    const ownRecipe = await ownRecipeCreate.json();
    const ownRecipePg = await db.query('SELECT venue_id FROM inventory_recipe_cards WHERE id=$1', [ownRecipe.id]);
    assert.equal(ownRecipePg.rowCount, 1, `${label} recipe persists exactly once`); checks++;
    assert.equal(ownRecipePg.rows[0].venue_id, scopedIngredient.venueId, `${label} recipe persists in its own venue`); checks++;
    const ownRecipesResponse = await fetch(`${base}/api/recipes`, { headers });
    assert.equal(ownRecipesResponse.status, 200, `${label} owner can reload its recipes`); checks++;
    const ownRecipes = await ownRecipesResponse.json();
    assert.ok(ownRecipes.items.some((recipe) => recipe.id === ownRecipe.id), `${label} recipe list includes its own card`); checks++;
    for (const sourceRecipeId of recipeIds) {
      assert.ok(!ownRecipes.items.some((recipe) => recipe.id === sourceRecipeId), `${label} recipe list continues to exclude the source card`); checks++;
    }
  }
  const costPreview = await page.evaluate(async (recipeId) => {
    const response = await fetch(`/api/recipes/${recipeId}/cost`, { headers: { Authorization: `Bearer ${localStorage.getItem('crm_session_token')}` } });
    return { status: response.status, body: await response.json() };
  }, recipes[0].id);
  assert.equal(costPreview.status, 200); checks++;
  assert.equal(Number(costPreview.body.totalCost), 21.6, '18g at 1.20 RUB/g previews 21.60 RUB cost'); checks++;

  await page.goto(`${base}/admin#venue-layout-settings`, { waitUntil: 'networkidle' });
  await page.locator('#new-floor-zone').waitFor({ state: 'visible' });
  await page.locator('#new-floor-zone').click();
  await page.locator('#venue-zone-name').fill(`QA44 Зал ${marker}`);
  const zonePromise = page.waitForResponse((response) => response.request().method() === 'POST' && response.url().endsWith('/api/floor/zones'));
  await page.locator('#venue-zone-form button[type="submit"]').click();
  const zoneResponse = await zonePromise;
  assert.equal(zoneResponse.status(), 201, 'UI creates the synthetic hall'); checks++;
  const zone = await zoneResponse.json();
  await page.locator('#venue-room-form').waitFor({ state: 'visible' });
  await page.locator('#venue-room-name').fill(`QA44 Стол ${marker}`);
  await page.locator('#venue-room-min-capacity').fill('2');
  await page.locator('#venue-room-max-capacity').fill('2');
  const tablePromise = page.waitForResponse((response) => response.request().method() === 'POST' && response.url().endsWith('/api/floor/tables'));
  await page.locator('#venue-room-submit').click();
  const tableResponse = await tablePromise;
  assert.equal(tableResponse.status(), 201, 'UI creates a table in the same synthetic hall'); checks++;
  const table = await tableResponse.json();

  await page.goto(base, { waitUntil: 'networkidle' });
  await page.locator(`[data-zone-id="${zone.id}"]`).waitFor();
  await page.locator(`[data-zone-id="${zone.id}"]`).click();
  await page.locator(`[data-table="${table.id}"]`).click();
  const orderCreatePromise = page.waitForResponse((response) => response.request().method() === 'POST' && response.url().endsWith('/api/orders'));
  await page.locator('.order > .primary').click();
  await page.locator(`[data-name="${productNames[0]}"]`).waitFor({ state: 'visible' });
  const orderItemPromise = page.waitForResponse((response) => response.request().method() === 'POST' && /\/api\/orders\/[0-9a-f-]+\/items$/.test(response.url()));
  await page.locator(`[data-name="${productNames[0]}"]`).click();
  const orderResponse = await orderCreatePromise;
  assert.equal(orderResponse.status(), 201, 'POS UI opens an order for the synthetic table'); checks++;
  const order = await orderResponse.json();
  assert.equal(order.tableId, table.id); checks++;
  assert.equal((await orderItemPromise).status(), 201, 'POS UI adds the UI-created tracked remix'); checks++;
  const screenshotDir = path.join(root, 'tmp', 'full-local-qa');
  fs.mkdirSync(screenshotDir, { recursive: true });
  await page.screenshot({ path: path.join(screenshotDir, 'acceptance-44-pos-order.png'), fullPage: true });
  await page.locator('#split-payment:not([disabled])').click();
  await page.locator('#payment-cash').fill('500');
  const paymentPromise = page.waitForResponse((response) => response.request().method() === 'POST' && response.url().endsWith(`/api/orders/${order.id}/payments`));
  await page.locator('#payment-form [type="submit"]').click();
  const payment = await paymentPromise;
  assert.equal(payment.status(), 201, 'POS UI takes full synthetic cash payment'); checks++;
  assert.equal((await payment.json()).closed, true, 'full payment closes the sale'); checks++;

  const persisted = (await db.query(`SELECT o.status,o.table_id,
      (SELECT count(*)::int FROM order_items oi WHERE oi.order_id=o.id) AS item_rows,
      (SELECT oi.product_id FROM order_items oi WHERE oi.order_id=o.id) AS sold_product_id,
      (SELECT oi.quantity FROM order_items oi WHERE oi.order_id=o.id) AS sold_quantity,
      (SELECT oi.unit_price FROM order_items oi WHERE oi.order_id=o.id) AS sold_unit_price,
      (SELECT count(*)::int FROM payments p WHERE p.order_id=o.id AND p.status='paid') AS paid_rows,
      (SELECT count(*)::int FROM order_costs c WHERE c.order_id=o.id) AS cost_rows,
      (SELECT c.cost FROM order_costs c WHERE c.order_id=o.id) AS cogs,
      (SELECT count(*)::int FROM stock_movements m WHERE m.order_id=o.id AND m.ingredient_id=$2 AND m.direction='out') AS debit_rows,
      (SELECT COALESCE(SUM(m.quantity),0)::numeric FROM stock_movements m WHERE m.order_id=o.id AND m.ingredient_id=$2 AND m.direction='out') AS debit_quantity,
      (SELECT count(*)::int FROM stock_movements m WHERE m.order_id=o.id AND m.direction='out') AS order_debit_rows,
      (SELECT COALESCE(SUM(m.quantity),0)::numeric FROM stock_movements m WHERE m.order_id=o.id AND m.direction='out') AS order_debit_quantity
    FROM orders o WHERE o.id=$1 AND o.venue_id=$3`, [order.id, ingredients[0].id, ids.venue])).rows[0];
  assert.ok(persisted); checks++;
  assert.equal(persisted.status, 'closed'); checks++;
  assert.equal(persisted.table_id, table.id); checks++;
  assert.equal(persisted.item_rows, 1); checks++;
  assert.equal(persisted.sold_product_id, products[0].id, 'the closed order contains the sold berry remix product'); checks++;
  assert.equal(Number(persisted.sold_quantity), 1); checks++;
  assert.equal(Number(persisted.sold_unit_price), 500); checks++;
  assert.equal(persisted.paid_rows, 1); checks++;
  assert.equal(persisted.cost_rows, 1); checks++;
  assert.equal(persisted.cogs, '21.60'); checks++;
  assert.equal(persisted.debit_rows, 1); checks++;
  assert.equal(Number(persisted.debit_quantity), 18); checks++;
  assert.equal(persisted.order_debit_rows, 1); checks++;
  assert.equal(Number(persisted.order_debit_quantity), 18); checks++;
  assert.deepEqual(await Promise.all(ingredients.map((item) => balance(item.id))), [82, 100], 'sale consumes exactly 18g of the selected remix ingredient'); checks++;
  await page.goto(`${base}/inventory?view=recipes`, { waitUntil: 'networkidle' });
  await page.locator(`#recipe-grid [data-recipe-edit="${recipes[0].id}"]`).waitFor({ state: 'visible' });
  await page.locator(`#recipe-grid [data-recipe-edit="${recipes[1].id}"]`).waitFor({ state: 'visible' });
  await page.locator('#portal-notice').waitFor({ state: 'detached', timeout: 7000 }).catch(() => {});
  assert.equal(await page.locator('#portal-notice').count(), 0, 'final remix catalogue has no stale blocking toast'); checks++;
  await page.screenshot({ path: path.join(screenshotDir, 'acceptance-44-inventory-crossflow.png'), fullPage: true });
  assert.deepEqual(pageErrors, [], `browser journey has no page errors: ${JSON.stringify(pageErrors)}`); checks++;
  assert.deepEqual(apiFailures, [], `authenticated UI has no failed API responses: ${JSON.stringify(apiFailures)}`); checks++;
  passed = true;
} finally {
  if (context) await context.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
  if (server && server.exitCode === null && server.signalCode === null) {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else server.kill('SIGTERM');
    await Promise.race([serverExit, delay(10000)]);
    if (server.exitCode === null && server.signalCode === null) {
      if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      else server.kill('SIGKILL');
      await Promise.race([serverExit, delay(5000)]);
    }
    serverShutdownFailed = server.exitCode === null && server.signalCode === null;
  }
  if (connected) await db.end().catch(() => {});
  if (serverShutdownFailed) throw new Error('owned QA server did not exit before runner database cleanup');
}
if (passed) console.log(`ACCEPTANCE #44 INVENTORY CROSSFLOW BROWSER QA: PASS (${checks} assertions; UI category → 3 ingredients → auto-order create/reload/cancel → draft/post receipt → 2 linked remixes → POS sale → exact stock and COGS; isolated runner database)`);
