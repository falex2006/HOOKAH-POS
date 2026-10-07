import assert from 'node:assert/strict';
import { randomUUID, randomBytes, scryptSync } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { assertQaDatabaseIdentity, isDisposableLoopbackQaContainer, validateQaDatabaseUrl } from './postgres-qa-safety.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = validateQaDatabaseUrl(process.env.MIGRATIONS_PG_TEST_DATABASE_URL, 'MIGRATIONS_PG_TEST_DATABASE_URL');
assert.match(target.database, /^orders_qa_[a-f0-9]{16}$/i, 'subdepartment restore QA requires a runner-created random disposable database');
assert.equal(target.database, process.env.LOCAL_FULL_PG_OWNED_DATABASE, 'only the local regression runner may own this database');
assert.equal(process.env.MIGRATIONS_PG_TEST_DOCKER_CONTAINER, 'hookah-full-regression-qa-20261001', 'restore QA requires the exact disposable regression container');
const runnerConfig = JSON.parse(fs.readFileSync(path.join(root, 'tmp', 'full-local-qa', 'runtime.json'), 'utf8'));
assert.equal(target.url.hostname, '127.0.0.1', 'restore QA must use the regression loopback binding');
assert.equal(Number(target.url.port), runnerConfig.regressionPort, 'restore QA must use the declared disposable PostgreSQL port');
assert.equal(decodeURIComponent(target.url.username), runnerConfig.dbUser, 'restore QA must use the dedicated runner PostgreSQL role');
assert.equal(decodeURIComponent(target.url.password), runnerConfig.dbPassword, 'restore QA must use the private runner PostgreSQL credential');
const runnerLock = JSON.parse(fs.readFileSync(path.join(root, 'tmp', 'full-local-qa', 'pg-regression-runner.lock'), 'utf8'));
assert.equal(Number(runnerLock.pid), process.ppid, 'only the active local PG runner may start the restore suite');
assert.match(runnerLock.id || '', /^[0-9a-f-]{36}$/i, 'runner lock must have a valid owner id');

const db = new pg.Client({ connectionString: target.url.href, connectionTimeoutMillis: 5000 });
const ids = {
  orgA: randomUUID(), orgB: randomUUID(), venueA: randomUUID(), siblingVenue: randomUUID(), venueB: randomUUID(),
  owner: randomUUID(), writeManager: randomUUID(), categoryManager: randomUUID(), readManager: randomUUID(), bartender: randomUUID(), siblingOwner: randomUUID(), foreignOwner: randomUUID(),
  archived: randomUUID(), active: randomUUID(), inactiveParentChild: randomUUID(),
  inactiveSubdepartment: randomUUID(),
  archivedCategory: randomUUID(), activeCategory: randomUUID(), inactiveDepartmentCategory: randomUUID(), inactiveSubdepartmentCategory: randomUUID(),
  siblingCategory: randomUUID(), foreignCategory: randomUUID(), duplicateArchivedCategory: randomUUID(), duplicateActiveCategory: randomUUID(), inventoryPermissionCategory: randomUUID(),
};
const marker = randomUUID().slice(0, 8);
const password = `qa48-restore-${randomUUID()}`;
const loginPrefix = `qa48-subdept-restore-${marker}`;
const users = [
  { id: ids.owner, venue: ids.venueA, org: ids.orgA, role: 'owner', suffix: 'owner', scopes: [] },
  { id: ids.writeManager, venue: ids.venueA, org: ids.orgA, role: 'manager', suffix: 'write-manager', scopes: ['inventory'] },
  { id: ids.categoryManager, venue: ids.venueA, org: ids.orgA, role: 'manager', suffix: 'category-manager', scopes: ['inventory_categories'] },
  { id: ids.readManager, venue: ids.venueA, org: ids.orgA, role: 'manager', suffix: 'read-manager', scopes: ['inventory_read'] },
  { id: ids.bartender, venue: ids.venueA, org: ids.orgA, role: 'bartender', suffix: 'bartender', scopes: ['orders'] },
  { id: ids.siblingOwner, venue: ids.siblingVenue, org: ids.orgA, role: 'owner', suffix: 'sibling-owner', scopes: [] },
  { id: ids.foreignOwner, venue: ids.venueB, org: ids.orgB, role: 'owner', suffix: 'foreign-owner', scopes: [] },
].map((user) => ({ ...user, login: `${loginPrefix}-${user.suffix}` }));
const salt = randomBytes(16).toString('hex');
const passwordHash = `scrypt$${salt}$${scryptSync(password, salt, 64).toString('hex')}`;
let server, exitWait, output = '', base = '', checks = 0, passed = false;

const api = async (route, method = 'GET', body, token = '', expected = 200) => {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  assert.equal(response.status, expected, `${method} ${route}: ${JSON.stringify(payload)}`);
  checks++;
  return payload;
};
const login = async (suffix) => (await api('/api/login', 'POST', { username: `${loginPrefix}-${suffix}`, password }, '', 200)).token;
const readSubdepartment = async (id) => {
  const { rows } = await db.query('SELECT id,venue_id AS "venueId",department_code AS "departmentCode",name,is_active AS active FROM inventory_subdepartments WHERE id=$1', [id]);
  checks++;
  return rows[0] || null;
};
const readCategory = async (id) => {
  const { rows } = await db.query('SELECT id,venue_id AS "venueId",name,department,subdepartment_id AS "subdepartmentId",is_active AS active FROM product_categories WHERE id=$1', [id]);
  checks++;
  return rows[0] || null;
};
const restoreUrl = (id) => `/api/inventory/subdepartments/${encodeURIComponent(id)}/restore`;
const restoreCategoryUrl = (id) => `/api/product-categories/${encodeURIComponent(id)}/restore`;

try {
  await db.connect();
  const identity = (await db.query(`SELECT current_database() AS database,inet_server_addr()::text AS address,inet_server_port() AS port,COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname=current_user),false) AS superuser`)).rows[0];
  const inspected = spawnSync('docker', ['inspect', process.env.MIGRATIONS_PG_TEST_DOCKER_CONTAINER], { encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024 });
  assert.equal(inspected.status, 0, 'verified disposable PostgreSQL runner container must be inspectable');
  const [container] = JSON.parse(inspected.stdout);
  assert.equal(container?.Name, '/hookah-full-regression-qa-20261001', 'fixtures must target the exact owned QA container');
  assert.ok(isDisposableLoopbackQaContainer(container, String(identity.address), Number(identity.port), Number(target.url.port)), 'restore fixtures require direct connection to the disposable loopback runner');
  assertQaDatabaseIdentity(identity, target.database, Number(target.url.port), 'Inventory subdepartment restore QA');
  checks++;

  await db.query('BEGIN');
  try {
    await db.query('INSERT INTO organizations(id,name,slug,timezone) VALUES($1,$2,$3,$5),($4,$6,$7,$5)', [ids.orgA, 'QA48 Subdepartment Restore A', `qa48-subdept-${ids.orgA}`, ids.orgB, 'Asia/Yekaterinburg', 'QA48 Subdepartment Restore B', `qa48-subdept-${ids.orgB}`]);
    await db.query("INSERT INTO organization_subscriptions(organization_id,status) VALUES($1,'trialing'),($2,'trialing')", [ids.orgA, ids.orgB]);
    await db.query('INSERT INTO venues(id,organization_id,name,timezone) VALUES($1,$4,$5,$8),($2,$4,$6,$8),($3,$7,$9,$8)', [ids.venueA, ids.siblingVenue, ids.venueB, ids.orgA, 'QA48 Restore venue A', 'QA48 Restore sibling venue', ids.orgB, 'Asia/Yekaterinburg', 'QA48 Restore foreign venue']);
    for (const user of users) {
      await db.query('INSERT INTO users(id,organization_id,venue_id,full_name,login,password_hash,role,permission_scopes) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)', [user.id, user.org, user.venue, `QA48 Restore ${user.suffix}`, user.login, passwordHash, user.role, JSON.stringify(user.scopes)]);
      await db.query("INSERT INTO organization_memberships(organization_id,user_id,membership_role,status) VALUES($1,$2,$3,'active')", [user.org, user.id, user.role === 'owner' ? 'owner' : 'member']);
    }
    await db.query(`INSERT INTO inventory_departments(venue_id,code,name,is_active) VALUES
      ($1,'qa48-active','QA48 active parent',true),($1,'qa48-reparent','QA48 reparent target',true),($1,'qa48-inactive','QA48 inactive parent',false),
      ($2,'qa48-active','QA48 sibling parent',true),($3,'qa48-active','QA48 foreign parent',true)`, [ids.venueA, ids.siblingVenue, ids.venueB]);
    await db.query(`INSERT INTO inventory_subdepartments(id,venue_id,department_code,name,is_active) VALUES
      ($1,$4,'qa48-active','QA48 archived child',false),
      ($2,$4,'qa48-active','QA48 already active child',true),
      ($3,$4,'qa48-inactive','QA48 child under archived parent',false),
      ($5,$6,'qa48-active','QA48 sibling archived child',false),
      ($7,$8,'qa48-active','QA48 foreign archived child',false)`, [ids.archived, ids.active, ids.inactiveParentChild, ids.venueA, randomUUID(), ids.siblingVenue, randomUUID(), ids.venueB]);
    await db.query(`INSERT INTO inventory_subdepartments(id,venue_id,department_code,name,is_active) VALUES($1,$2,'qa48-active','QA48 inactive category parent',false)`, [ids.inactiveSubdepartment, ids.venueA]);
    await db.query(`INSERT INTO product_categories(id,venue_id,name,department,subdepartment_id,is_active) VALUES
      ($1,$2,'QA48 archived category','qa48-active',NULL,false),
      ($3,$2,'QA48 active category','qa48-active',NULL,true),
      ($4,$2,'QA48 inactive department category','qa48-inactive',NULL,false),
      ($5,$2,'QA48 inactive subdepartment category','qa48-active',$6,false),
      ($7,$8,'QA48 sibling archived category','qa48-active',NULL,false),
      ($9,$10,'QA48 foreign archived category','qa48-active',NULL,false),
      ($11,$2,$12,'qa48-active',NULL,false),
      ($13,$2,$14,'qa48-active',NULL,true),
      ($15,$2,'QA48 inventory permission category','qa48-active',NULL,false)`, [
      ids.archivedCategory, ids.venueA, ids.activeCategory, ids.inactiveDepartmentCategory,
      ids.inactiveSubdepartmentCategory, ids.inactiveSubdepartment, ids.siblingCategory, ids.siblingVenue,
      ids.foreignCategory, ids.venueB, ids.duplicateArchivedCategory, `QA48 case restore ${marker}`,
      ids.duplicateActiveCategory, `qa48 CASE restore ${marker}`, ids.inventoryPermissionCategory,
    ]);
    await db.query('COMMIT');
  } catch (error) { await db.query('ROLLBACK'); throw error; }

  server = spawn(process.execPath, ['server.js'], {
    cwd: root, windowsHide: true,
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', DATABASE_URL: target.url.href, VENUE_ID: ids.venueA, AUTH_REQUIRED: 'true', COOKIE_SECURE: 'false', DEMO_MODE: 'false', NODE_ENV: 'test', API_RATE_LIMIT: '5000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  exitWait = new Promise((resolve) => server.once('exit', resolve));
  server.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
  server.stderr.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
  const deadline = Date.now() + 20000;
  while (!base && Date.now() < deadline) {
    const match = output.match(/CRM running on http:\/\/localhost:(\d+)/);
    if (match) base = `http://127.0.0.1:${match[1]}`;
    else if (server.exitCode !== null) throw new Error(`QA server exited before startup: ${output}`);
    else await delay(50);
  }
  assert.ok(base, 'authenticated PostgreSQL QA server started');
  assert.equal((await api('/api/health')).database, 'postgres'); checks++;

  const ownerToken = await login('owner');
  const writeToken = await login('write-manager');
  const readToken = await login('read-manager');
  const bartenderToken = await login('bartender');
  const categoryToken = await login('category-manager');
  const siblingToken = await login('sibling-owner');
  const foreignToken = await login('foreign-owner');

  const baseline = await readSubdepartment(ids.archived);
  assert.deepEqual(baseline, { id: ids.archived, venueId: ids.venueA, departmentCode: 'qa48-active', name: 'QA48 archived child', active: false });
  const auditCount = async (action, id) => Number((await db.query('SELECT count(*)::int AS count FROM audit_events WHERE venue_id=$1 AND action=$2 AND entity_type=$3 AND entity_id=$4', [ids.venueA, action, 'inventory_subdepartment', id])).rows[0].count);
  const auditCountForName = async (action, name) => Number((await db.query('SELECT count(*)::int AS count FROM audit_events WHERE venue_id=$1 AND action=$2 AND entity_type=$3 AND after_data->>\'name\'=$4', [ids.venueA, action, 'inventory_subdepartment', name])).rows[0].count);
  const waitForAuditCount = async (action, id, expected) => {
    const deadline = Date.now() + 2000;
    let count = await auditCount(action, id);
    while (count !== expected && Date.now() < deadline) { await delay(20); count = await auditCount(action, id); }
    return count;
  };
  assert.equal(await auditCount('inventory.subdepartment_restored', ids.archived), 0, 'fixture has no prior restore audit'); checks++;

  await api(restoreUrl(ids.archived), 'POST', undefined, '', 401);
  await api(restoreUrl(ids.archived), 'POST', undefined, readToken, 403);
  await api(restoreUrl(ids.archived), 'POST', undefined, bartenderToken, 403);
  await api(restoreUrl(ids.archived), 'POST', undefined, siblingToken, 404);
  await api(restoreUrl(ids.archived), 'POST', undefined, foreignToken, 404);
  await api(restoreUrl('not-a-uuid'), 'POST', undefined, ownerToken, 400);
  await api(restoreUrl(randomUUID()), 'POST', undefined, ownerToken, 404);
  await api(restoreUrl(ids.active), 'POST', undefined, ownerToken, 404);
  await api(restoreUrl(ids.inactiveParentChild), 'POST', undefined, ownerToken, 409);
  assert.deepEqual(await readSubdepartment(ids.archived), baseline, 'authorization, venue, ID and inactive-parent failures leave the target row unchanged');
  assert.equal(await auditCount('inventory.subdepartment_restored', ids.archived), 0, 'failed attempts emit no restored audit event'); checks++;
  assert.equal((await readSubdepartment(ids.inactiveParentChild))?.active, false, 'inactive-parent failure preserves the archived child'); checks++;

  const restored = await api(restoreUrl(ids.archived), 'POST', undefined, writeToken, 200);
  assert.deepEqual(restored, { id: ids.archived, departmentCode: 'qa48-active', name: 'QA48 archived child', active: true }); checks++;
  assert.deepEqual(await readSubdepartment(ids.archived), { id: ids.archived, venueId: ids.venueA, departmentCode: 'qa48-active', name: 'QA48 archived child', active: true });
  const activeRead = await api('/api/inventory/subdepartments?status=active', 'GET', undefined, readToken, 200);
  assert.ok(activeRead.items.some((item) => item.id === ids.archived && item.name === 'QA48 archived child'), 'restored item appears in same-venue active list'); checks++;
  const archivedRead = await api('/api/inventory/subdepartments?status=archived', 'GET', undefined, readToken, 200);
  assert.equal(archivedRead.items.some((item) => item.id === ids.archived), false, 'restored item leaves same-venue archived list'); checks++;
  assert.equal(await waitForAuditCount('inventory.subdepartment_restored', ids.archived, 1), 1, 'successful restore writes exactly one audit event'); checks++;
  await api(restoreUrl(ids.archived), 'POST', undefined, ownerToken, 404);
  assert.equal(await waitForAuditCount('inventory.subdepartment_restored', ids.archived, 1), 1, 'repeat restore does not create a second audit event'); checks++;

  const categoryAuditCount = async (id) => Number((await db.query('SELECT count(*)::int AS count FROM audit_events WHERE venue_id=$1 AND action=$2 AND entity_type=$3 AND entity_id=$4', [ids.venueA, 'product_category.restored', 'product_category', id])).rows[0].count);
  const waitForCategoryAudit = async (id) => {
    const deadline = Date.now() + 2000;
    let rows = [];
    while (!rows.length && Date.now() < deadline) {
      rows = (await db.query('SELECT actor_id AS "actorId",action,entity_type AS "entityType",entity_id AS "entityId",before_data AS "beforeData",after_data AS "afterData" FROM audit_events WHERE venue_id=$1 AND action=$2 AND entity_type=$3 AND entity_id=$4', [ids.venueA, 'product_category.restored', 'product_category', id])).rows;
      if (!rows.length) await delay(20);
    }
    return rows;
  };
  const archivedCategoryBefore = await readCategory(ids.archivedCategory);
  assert.deepEqual(archivedCategoryBefore, { id: ids.archivedCategory, venueId: ids.venueA, name: 'QA48 archived category', department: 'qa48-active', subdepartmentId: null, active: false });
  assert.equal(await categoryAuditCount(ids.archivedCategory), 0, 'category restore fixture starts without restore audit'); checks++;

  await api(restoreCategoryUrl(ids.archivedCategory), 'POST', undefined, '', 401);
  await api(restoreCategoryUrl(ids.archivedCategory), 'POST', undefined, readToken, 403);
  await api(restoreCategoryUrl(ids.archivedCategory), 'POST', undefined, bartenderToken, 403);
  await api(restoreCategoryUrl(ids.archivedCategory), 'POST', undefined, siblingToken, 404);
  await api(restoreCategoryUrl(ids.archivedCategory), 'POST', undefined, foreignToken, 404);
  await api(restoreCategoryUrl('not-a-uuid'), 'POST', undefined, ownerToken, 400);
  await api(restoreCategoryUrl(randomUUID()), 'POST', undefined, ownerToken, 404);
  await api(restoreCategoryUrl(ids.activeCategory), 'POST', undefined, ownerToken, 404);
  const inactiveDepartmentRestore = await api(restoreCategoryUrl(ids.inactiveDepartmentCategory), 'POST', undefined, ownerToken, 409);
  assert.equal(inactiveDepartmentRestore.error, 'inventory_category_parent_inactive'); checks++;
  const inactiveSubdepartmentRestore = await api(restoreCategoryUrl(ids.inactiveSubdepartmentCategory), 'POST', undefined, ownerToken, 409);
  assert.equal(inactiveSubdepartmentRestore.error, 'inventory_category_parent_inactive'); checks++;
  const duplicateRestore = await api(restoreCategoryUrl(ids.duplicateArchivedCategory), 'POST', undefined, ownerToken, 409);
  assert.equal(duplicateRestore.error, 'product_category_exists'); checks++;
  assert.deepEqual(await readCategory(ids.archivedCategory), archivedCategoryBefore, 'auth, tenant, malformed, already-active and failed-parent/conflict cases preserve the target category');
  assert.equal((await readCategory(ids.inactiveDepartmentCategory))?.active, false, 'inactive department rejection leaves category archived'); checks++;
  assert.equal((await readCategory(ids.inactiveSubdepartmentCategory))?.active, false, 'inactive subdepartment rejection leaves category archived'); checks++;
  assert.equal((await readCategory(ids.duplicateArchivedCategory))?.active, false, 'active-name uniqueness rejection leaves category archived'); checks++;
  assert.equal((await readCategory(ids.duplicateActiveCategory))?.active, true, 'unique-name rejection preserves the pre-existing active category'); checks++;
  assert.equal((await readCategory(ids.siblingCategory))?.active, false, 'sibling venue category remains unchanged'); checks++;
  assert.equal((await readCategory(ids.foreignCategory))?.active, false, 'foreign tenant category remains unchanged'); checks++;
  assert.equal(await categoryAuditCount(ids.archivedCategory), 0, 'denied and failed category restores emit no success audit'); checks++;
  assert.equal(await categoryAuditCount(ids.inactiveDepartmentCategory), 0); checks++;
  assert.equal(await categoryAuditCount(ids.inactiveSubdepartmentCategory), 0); checks++;
  assert.equal(await categoryAuditCount(ids.duplicateArchivedCategory), 0); checks++;
  assert.equal(await categoryAuditCount(ids.siblingCategory), 0, 'cross-venue category restore does not write a local audit event'); checks++;
  assert.equal(await categoryAuditCount(ids.foreignCategory), 0, 'cross-tenant category restore does not write a local audit event'); checks++;

  const restoredCategory = await api(restoreCategoryUrl(ids.archivedCategory), 'POST', undefined, categoryToken, 200);
  assert.deepEqual(restoredCategory, { id: ids.archivedCategory, name: 'QA48 archived category', department: 'qa48-active', subdepartmentId: null, active: true }); checks++;
  assert.deepEqual(await readCategory(ids.archivedCategory), { ...archivedCategoryBefore, active: true });
  const activeCategories = await api('/api/product-categories?status=active', 'GET', undefined, readToken, 200);
  assert.ok(activeCategories.items.some((item) => item.id === ids.archivedCategory && item.active === true), 'restored category appears in fresh active list'); checks++;
  const archivedCategories = await api('/api/product-categories?status=archived', 'GET', undefined, readToken, 200);
  assert.equal(archivedCategories.items.some((item) => item.id === ids.archivedCategory), false, 'restored category leaves fresh archived list'); checks++;
  const restoreEvents = await waitForCategoryAudit(ids.archivedCategory);
  assert.equal(restoreEvents.length, 1, 'successful category restore writes exactly one event'); checks++;
  assert.deepEqual(restoreEvents[0], { actorId: ids.categoryManager, action: 'product_category.restored', entityType: 'product_category', entityId: ids.archivedCategory, beforeData: { active: false }, afterData: restoredCategory }); checks++;
  await api(restoreCategoryUrl(ids.archivedCategory), 'POST', undefined, ownerToken, 404);
  assert.equal(await categoryAuditCount(ids.archivedCategory), 1, 'repeat category restore does not add another audit event'); checks++;
  const inventoryPermissionRestore = await api(restoreCategoryUrl(ids.inventoryPermissionCategory), 'POST', undefined, writeToken, 200);
  assert.equal(inventoryPermissionRestore.active, true, 'inventory permission can also restore categories'); checks++;
  assert.equal((await readCategory(ids.inventoryPermissionCategory))?.active, true, 'inventory-scoped restore persists in PostgreSQL'); checks++;
  const inventoryPermissionEvents = await waitForCategoryAudit(ids.inventoryPermissionCategory);
  assert.equal(inventoryPermissionEvents.length, 1, 'inventory-scoped category restore is audited once'); checks++;
  assert.equal(inventoryPermissionEvents[0].actorId, ids.writeManager, 'inventory-scoped restore audit records its manager actor'); checks++;

  const subdepartmentUrl = (id) => `/api/inventory/subdepartments/${encodeURIComponent(id)}`;
  const subdepartmentCreate = { departmentCode: 'qa48-active', name: `QA48 lifecycle ${marker}` };
  const noSessionCreate = await api('/api/inventory/subdepartments', 'POST', subdepartmentCreate, '', 401);
  assert.ok(noSessionCreate.error, 'subdepartment creation requires an authenticated session'); checks++;
  for (const [label, token] of [['inventory_read manager', readToken], ['bartender', bartenderToken]]) {
    const deniedCreate = await api('/api/inventory/subdepartments', 'POST', subdepartmentCreate, token, 403);
    const deniedPatch = await api(subdepartmentUrl(ids.archived), 'PATCH', { departmentCode: 'qa48-active', name: `Denied ${label}` }, token, 403);
    const deniedDelete = await api(subdepartmentUrl(ids.archived), 'DELETE', undefined, token, 403);
    assert.equal(deniedCreate.error, 'forbidden'); assert.equal(deniedPatch.error, 'forbidden'); assert.equal(deniedDelete.error, 'forbidden'); checks++;
  }
  assert.equal(await auditCountForName('inventory.subdepartment_created', subdepartmentCreate.name), 0, 'denied creation attempts do not emit creation audit for the attempted child'); checks++;
  const missingParent = await api('/api/inventory/subdepartments', 'POST', { ...subdepartmentCreate, departmentCode: 'qa48-missing' }, writeToken, 400);
  assert.equal(missingParent.error, 'inventory_department_not_found'); checks++;
  const inactiveParent = await api('/api/inventory/subdepartments', 'POST', { ...subdepartmentCreate, departmentCode: 'qa48-inactive' }, writeToken, 400);
  assert.equal(inactiveParent.error, 'inventory_department_not_found'); checks++;

  const created = await api('/api/inventory/subdepartments', 'POST', subdepartmentCreate, writeToken, 201);
  assert.deepEqual({ departmentCode: created.departmentCode, name: created.name, active: created.active }, { ...subdepartmentCreate, active: true }); checks++;
  const createdRow = await readSubdepartment(created.id);
  assert.deepEqual(createdRow, { id: created.id, venueId: ids.venueA, ...subdepartmentCreate, active: true });
  const createdAudit = await waitForAuditCount('inventory.subdepartment_created', created.id, 1);
  assert.equal(createdAudit, 1, 'successful creation writes exactly one audit event'); checks++;
  const duplicateCreate = await api('/api/inventory/subdepartments', 'POST', subdepartmentCreate, writeToken, 409);
  assert.equal(duplicateCreate.error, 'inventory_subdepartment_exists'); checks++;

  const categoryId = randomUUID(), ingredientId = randomUUID();
  const categoryName = `QA48 linked category ${marker}`;
  await db.query('INSERT INTO product_categories(id,venue_id,name,department,subdepartment_id) VALUES($1,$2,$3,$4,$5)', [categoryId, ids.venueA, categoryName, created.departmentCode, created.id]);
  await db.query(`INSERT INTO ingredients(id,venue_id,organization_id,name,department,subdepartment,category,category_id,unit,is_marked)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,'мл',true)`, [ingredientId, ids.venueA, ids.orgA, `QA48 linked item ${marker}`, created.departmentCode, created.name, categoryName, categoryId]);
  const readLinkedCategory = async () => (await db.query('SELECT department,subdepartment_id AS "subdepartmentId" FROM product_categories WHERE venue_id=$1 AND id=$2', [ids.venueA, categoryId])).rows[0];
  const readLinkedIngredient = async () => (await db.query('SELECT department,subdepartment,category,category_id AS "categoryId" FROM ingredients WHERE venue_id=$1 AND id=$2', [ids.venueA, ingredientId])).rows[0];
  const beforeCategory = await readLinkedCategory(); checks++;
  const beforeIngredient = await readLinkedIngredient(); checks++;
  assert.deepEqual(beforeCategory, { department: 'qa48-active', subdepartmentId: created.id });
  assert.deepEqual(beforeIngredient, { department: 'qa48-active', subdepartment: created.name, category: categoryName, categoryId });

  const lifecycleBaseline = await readSubdepartment(created.id);
  await api(subdepartmentUrl(created.id), 'PATCH', { departmentCode: 'qa48-active', name: `Denied writer boundary ${marker}` }, '', 401);
  for (const [label, token] of [['inventory_read manager', readToken], ['bartender', bartenderToken]]) {
    await api(subdepartmentUrl(created.id), 'PATCH', { departmentCode: 'qa48-active', name: `Denied ${label}` }, token, 403);
    await api(subdepartmentUrl(created.id), 'DELETE', undefined, token, 403);
  }
  for (const [label, token] of [['sibling venue owner', siblingToken], ['foreign organization owner', foreignToken]]) {
    const hiddenPatch = await api(subdepartmentUrl(created.id), 'PATCH', { departmentCode: 'qa48-active', name: `Hidden ${label}` }, token, 404);
    const hiddenDelete = await api(subdepartmentUrl(created.id), 'DELETE', undefined, token, 404);
    assert.equal(hiddenPatch.error, 'inventory_subdepartment_not_found'); assert.equal(hiddenDelete.error, 'inventory_subdepartment_not_found'); checks++;
    const scopedList = await api('/api/inventory/subdepartments?status=all', 'GET', undefined, token);
    assert.equal(scopedList.items.some((item) => item.id === created.id), false, `${label} cannot see this venue's child in list results`); checks++;
  }
  assert.deepEqual(await readSubdepartment(created.id), lifecycleBaseline, 'unauthorized and cross-venue writes leave the source child unchanged');
  assert.deepEqual(await readLinkedCategory(), beforeCategory, 'unauthorized and cross-venue writes leave linked category unchanged');
  assert.deepEqual(await readLinkedIngredient(), beforeIngredient, 'unauthorized and cross-venue writes leave linked item unchanged');
  assert.equal(await auditCount('inventory.subdepartment_updated', created.id), 0, 'denied updates emit no audit event'); checks++;
  assert.equal(await auditCount('inventory.subdepartment_archived', created.id), 0, 'denied archives emit no audit event'); checks++;

  const renamedName = `QA48 renamed ${marker}`;
  const renamed = await api(subdepartmentUrl(created.id), 'PATCH', { departmentCode: 'qa48-active', name: renamedName }, writeToken, 200);
  assert.deepEqual({ departmentCode: renamed.departmentCode, name: renamed.name, active: renamed.active }, { departmentCode: 'qa48-active', name: renamedName, active: true }); checks++;
  const moved = await api(subdepartmentUrl(created.id), 'PATCH', { departmentCode: 'qa48-reparent', name: renamedName }, writeToken, 200);
  assert.deepEqual({ departmentCode: moved.departmentCode, name: moved.name, active: moved.active }, { departmentCode: 'qa48-reparent', name: renamedName, active: true }); checks++;
  assert.deepEqual(await readSubdepartment(created.id), { id: created.id, venueId: ids.venueA, departmentCode: 'qa48-reparent', name: renamedName, active: true });
  assert.deepEqual(await readLinkedCategory(), { department: 'qa48-reparent', subdepartmentId: created.id }, 'reparent updates the linked category department'); checks++;
  assert.deepEqual(await readLinkedIngredient(), { department: 'qa48-reparent', subdepartment: renamedName, category: categoryName, categoryId }, 'rename and reparent update the linked stock item'); checks++;
  const hierarchyList = await api('/api/inventory/subdepartments?status=active', 'GET', undefined, readToken);
  assert.ok(hierarchyList.items.some((item) => item.id === created.id && item.departmentCode === 'qa48-reparent' && item.name === renamedName), 'renamed and moved child appears after a fresh same-venue GET'); checks++;
  const invalidMove = await api(subdepartmentUrl(created.id), 'PATCH', { departmentCode: 'qa48-inactive', name: renamedName }, writeToken, 400);
  assert.equal(invalidMove.error, 'inventory_department_not_found'); checks++;
  assert.deepEqual(await readSubdepartment(created.id), { id: created.id, venueId: ids.venueA, departmentCode: 'qa48-reparent', name: renamedName, active: true }, 'invalid-parent patch preserves the prior child state');
  assert.equal(await waitForAuditCount('inventory.subdepartment_updated', created.id, 2), 2, 'successful rename and reparent each write one audit event'); checks++;

  const usedArchive = await api(subdepartmentUrl(created.id), 'DELETE', undefined, writeToken, 409);
  assert.equal(usedArchive.error, 'inventory_subdepartment_in_use'); checks++;
  assert.deepEqual(await readSubdepartment(created.id), { id: created.id, venueId: ids.venueA, departmentCode: 'qa48-reparent', name: renamedName, active: true }, 'used child remains active after archive rejection');
  assert.equal(await auditCount('inventory.subdepartment_archived', created.id), 0, 'rejected archive does not emit archive audit'); checks++;

  const emptySubdepartment = await api('/api/inventory/subdepartments', 'POST', { departmentCode: 'qa48-active', name: `QA48 empty archive ${marker}` }, writeToken, 201);
  assert.equal(await waitForAuditCount('inventory.subdepartment_created', emptySubdepartment.id, 1), 1, 'empty archive fixture creation is audited once'); checks++;
  const archivedSubdepartment = await api(subdepartmentUrl(emptySubdepartment.id), 'DELETE', undefined, writeToken, 200);
  assert.equal(archivedSubdepartment.active, false); checks++;
  assert.deepEqual(await readSubdepartment(emptySubdepartment.id), { id: emptySubdepartment.id, venueId: ids.venueA, departmentCode: 'qa48-active', name: `QA48 empty archive ${marker}`, active: false });
  const activeSubdepartments = await api('/api/inventory/subdepartments?status=active', 'GET', undefined, readToken);
  const archivedSubdepartments = await api('/api/inventory/subdepartments?status=archived', 'GET', undefined, readToken);
  assert.equal(activeSubdepartments.items.some((item) => item.id === emptySubdepartment.id), false, 'archived child leaves the active list after reload'); checks++;
  assert.equal(archivedSubdepartments.items.some((item) => item.id === emptySubdepartment.id && item.active === false), true, 'archived child appears in the archived list after reload'); checks++;
  assert.equal(await waitForAuditCount('inventory.subdepartment_archived', emptySubdepartment.id, 1), 1, 'successful archive writes exactly one audit event'); checks++;
  await api(subdepartmentUrl(emptySubdepartment.id), 'DELETE', undefined, ownerToken, 404);
  assert.equal(await waitForAuditCount('inventory.subdepartment_archived', emptySubdepartment.id, 1), 1, 'repeated archive does not write another audit event'); checks++;
  passed = true;
} finally {
  if (server?.pid && server.exitCode === null && server.signalCode === null) {
    if (process.platform === 'win32') spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `taskkill /PID ${server.pid} /T /F`], { windowsHide: true, stdio: 'ignore' });
    else server.kill('SIGTERM');
    await exitWait;
  }
  if (db._connected) await db.end();
}

if (passed) console.log(`ACCEPTANCE #48 INVENTORY HIERARCHY POSTGRES QA: PASS (${checks} authenticated API/PG checks; subdepartment lifecycle and product-category restore, roles/tenant isolation, parent/uniqueness guards, audit and rejection side effects)`);
