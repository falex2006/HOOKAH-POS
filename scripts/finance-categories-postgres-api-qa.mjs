import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';

const databaseUrl = process.env.MIGRATIONS_PG_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('Set MIGRATIONS_PG_TEST_DATABASE_URL to an isolated PostgreSQL QA database');
assert.match(new URL(databaseUrl).pathname, /(?:test|qa|scratch)/i, 'refusing test writes outside a clearly named QA database');

const require = createRequire(import.meta.url);
const { Client, Pool } = require('pg');
const { validateDataUrl: validatePurchasePaymentDocument } = require('../purchase-document-validation.js');
const setup = new Client({ connectionString: databaseUrl });
const pool = new Pool({ connectionString: databaseUrl, max: 4 });
const server = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const categoryStart = server.indexOf("if (pathname === '/api/finance/categories' && req.method === 'GET')");
const categoryEnd = server.indexOf("if (pathname === '/api/metrics')", categoryStart);
const expenseStart = server.indexOf("if (pathname === '/api/expenses' && req.method === 'GET')");
const expenseEnd = server.indexOf("if (pathname === '/api/payroll/rules' && req.method === 'POST')", expenseStart);
assert.ok(categoryStart >= 0 && categoryEnd > categoryStart, 'finance category API handlers are present');
assert.ok(expenseStart >= 0 && expenseEnd > expenseStart, 'finance expense API handlers are present');
const categoryRoute = server.slice(categoryStart, categoryEnd);
const expenseRoute = server.slice(expenseStart, expenseEnd);
const audit = [];

let venueId;
let otherVenueId;
const callApi = async ({ route, path, method = 'GET', body = {}, permissions = ['finance'], role = 'owner', venue = venueId, onCategoryValidationStarted }) => {
  let response;
  const url = new URL(`http://localhost${path}`);
  const pathname = url.pathname;
  const json = (_res, status, data) => { response = { status, data }; return response; };
  const hasPermission = (req, permission) => req.user?.permissions?.includes(permission) === true;
  const denyUnless = (req, res, permission) => {
    if (hasPermission(req, permission)) return false;
    json(res, 403, { error: 'forbidden', permission }); return true;
  };
  const denyUnlessAny = (req, res, required) => {
    if (required.some((permission) => hasPermission(req, permission))) return false;
    json(res, 403, { error: 'forbidden', permissions: required }); return true;
  };
  const requestPool = onCategoryValidationStarted ? {
    ...pool,
    connect: async () => {
      const client = await pool.connect();
      return {
        query: (sql, values) => {
          const pending = client.query(sql, values);
          if (String(sql).includes('SELECT name FROM finance_categories')) onCategoryValidationStarted();
          return pending;
        },
        release: (...args) => client.release(...args),
      };
    },
  } : pool;
  const repositories = { pool: requestPool };
  const routeToday = () => '2026-09-28';
  const isValidIsoDate = (value) => { const text = String(value || ''); const parsed = new Date(`${text}T00:00:00.000Z`); return /^\d{4}-\d{2}-\d{2}$/.test(text) && !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text; };
  const handler = new Function('pathname','url','req','res','repositories','venueDbId','denyUnlessAny','denyUnless','hasPermission','body','json','recordAudit','financeCategories','manualExpenses','isOperationalEmployee','today','validatePurchasePaymentDocument','isValidIsoDate',
    `return (async()=>{${route}})();`);
  await handler(pathname, url, { method, headers: {}, user: { id: null, name: 'QA finance', role, permissions } }, {}, repositories, venue,
    denyUnlessAny, denyUnless, hasPermission, async () => body, json,
    (_req, action, entityType, entityId, beforeData, afterData) => { audit.push({ action, entityType, entityId, beforeData, afterData }); },
    [], [], (req) => ['bartender','hookah_master','senior_bartender','senior_hookah_master','cleaner','security','technician','other_staff','staff'].includes(String(req.user?.role || '').toLowerCase()), routeToday, validatePurchasePaymentDocument, isValidIsoDate);
  return response;
};

const originalAuthRequired = process.env.AUTH_REQUIRED;
process.env.AUTH_REQUIRED = 'true';
let setupConnected = false;
try {
  await setup.connect();
  setupConnected = true;
  venueId = (await setup.query("INSERT INTO venues (name) VALUES ('Finance categories QA') RETURNING id")).rows[0].id;
  otherVenueId = (await setup.query("INSERT INTO venues (name) VALUES ('Finance category tenant QA') RETURNING id")).rows[0].id;
  const financeAccountId = (await setup.query("INSERT INTO finance_accounts (venue_id,code,name,kind,allowed_payment_methods) VALUES ($1,'qa_bank','QA bank','bank',ARRAY['card']) RETURNING id", [venueId])).rows[0].id;

  const created = await callApi({ route: categoryRoute, path: '/api/finance/categories', method: 'POST', body: { name: 'Коммунальные расходы', kind: 'expense' } });
  assert.equal(created.status, 201, JSON.stringify(created));
  const categoryId = created.data.id;
  const correctionCategory = await callApi({ route: categoryRoute, path: '/api/finance/categories', method: 'POST', body: { name: 'Альтернативный расход', kind: 'expense' } });
  assert.equal(correctionCategory.status, 201, JSON.stringify(correctionCategory));
  assert.equal(created.data.kind, 'expense');
  assert.equal((await callApi({ route: categoryRoute, path: '/api/finance/categories', method: 'POST', body: { name: 'коммунальные расходы', kind: 'expense' } })).status, 409,
    'active category names are case-insensitively unique per venue and type');
  assert.equal((await callApi({ route: categoryRoute, path: '/api/finance/categories?includeArchived=true', permissions: ['finance_read'] })).status, 403,
    'view-only finance users cannot inspect the archived category catalog');
  assert.equal((await callApi({ route: categoryRoute, path: '/api/finance/categories', permissions: ['finance_read'], role: 'bartender' })).status, 403,
    'operational staff cannot inspect the finance category directory');
  assert.equal((await callApi({ route: categoryRoute, path: '/api/finance/categories', permissions: ['finance_read'], role: 'manager' })).status, 200,
    'read-only finance managers can inspect the category reference');

  const expense = await callApi({ route: expenseRoute, path: '/api/expenses', method: 'POST', body: {
    categoryId, amount: '1750.50', expenseDate: '2026-09-28', description: 'QA-generated expense', source: 'manual', paymentAccountId: financeAccountId, paymentMethod: 'card', idempotencyKey: '22000000-0000-4000-8000-000000000001',
  } });
  assert.equal(expense.status, 201, JSON.stringify(expense));
  assert.equal(expense.data.category, 'Коммунальные расходы');
  assert.equal(expense.data.category_id, categoryId);
  const secondExpense = await callApi({ route: expenseRoute, path: '/api/expenses', method: 'POST', body: {
    categoryId, amount: '88.00', expenseDate: '2026-09-28', description: 'Second QA expense', source: 'manual', paymentAccountId: financeAccountId, paymentMethod: 'card', idempotencyKey: '22000000-0000-4000-8000-000000000002',
  } });
  assert.equal(secondExpense.status, 201, JSON.stringify(secondExpense));
  const firstPage = await callApi({ route: expenseRoute, path: '/api/expenses?from=2026-09-28&to=2026-09-28&limit=1&offset=0' });
  const secondPage = await callApi({ route: expenseRoute, path: '/api/expenses?from=2026-09-28&to=2026-09-28&limit=1&offset=1' });
  assert.equal(firstPage.data.totalCount, 2, 'paged expense reads include the total matching count');
  assert.equal(firstPage.data.items.length, 1);
  assert.equal(secondPage.data.items.length, 1);
  assert.notEqual(firstPage.data.items[0].id, secondPage.data.items[0].id, 'offset returns the next expense without duplicates');
  assert.equal((await callApi({ route: expenseRoute, path: '/api/expenses?from=2026-09-29&to=2026-09-29&limit=20' })).data.totalCount, 0,
    'date filters return no older expenses outside the requested period');
  assert.equal((await callApi({ route: expenseRoute, path: '/api/expenses?limit=0' })).status, 400,
    'invalid pagination is rejected explicitly');
  assert.equal((await callApi({ route: expenseRoute, path: '/api/expenses?offset=1' })).status, 400,
    'offset cannot be silently ignored without an explicit page size');
  const invalidAssignment = await callApi({ route: expenseRoute, path: '/api/expenses', method: 'POST', body: { categoryId: '00000000-0000-4000-8000-000000000001', amount: '10.00', expenseDate: '2026-09-28', paymentAccountId: financeAccountId, paymentMethod: 'card', idempotencyKey: '22000000-0000-4000-8000-000000000003' } });
  assert.equal(invalidAssignment.status, 400, 'expenses cannot select an unknown or inactive category');

  const correctionUserId = (await setup.query("INSERT INTO users (venue_id,full_name,login,role) VALUES ($1,'QA correction owner',$2,'owner') RETURNING id", [venueId, `category-correction-${process.pid}`])).rows[0].id;
  await setup.query(`INSERT INTO finance_expense_corrections
    (venue_id,expense_id,sequence,expected_version,before_snapshot,after_snapshot,amount_delta,reason,idempotency_key,request_sha256,response_json,created_by)
    VALUES ($1,$2,1,0,$3::jsonb,$4::jsonb,0,'Исправлена статья','category-correction-${process.pid}',repeat('b',64),'{}'::jsonb,$5)`, [
    venueId, expense.data.id,
    JSON.stringify({ amount:'1750.50',categoryId,categoryName:'Коммунальные расходы',counterpartyName:null,description:'QA-generated expense',documentUrl:null }),
    JSON.stringify({ amount:'1750.50',categoryId:correctionCategory.data.id,categoryName:'Альтернативный расход',counterpartyName:null,description:'QA-generated expense',documentUrl:null }), correctionUserId,
  ]);
  assert.equal((await callApi({ route: categoryRoute, path: `/api/finance/categories/${correctionCategory.data.id}`, method: 'PATCH', body: { kind: 'income' } })).status, 409,
    'an expense category referenced only by a correction snapshot cannot change direction');
  const correctionUsage = await callApi({ route: categoryRoute, path: '/api/finance/categories' });
  assert.equal(correctionUsage.data.items.find((item) => item.id === correctionCategory.data.id).expenseCorrectionCount, 1,
    'category usage exposes references retained in correction history');
  const correctionRename = await callApi({ route: categoryRoute, path: `/api/finance/categories/${correctionCategory.data.id}`, method: 'PATCH', body: { name: 'Исправленная альтернатива' } });
  assert.equal(correctionRename.status, 200, 'correction-only categories remain editable by name');
  const correctionArchive = await callApi({ route: categoryRoute, path: `/api/finance/categories/${correctionCategory.data.id}`, method: 'PATCH', body: { active: false } });
  assert.equal(correctionArchive.status, 200, 'correction-only categories remain archivable without losing their history');
  assert.equal((await callApi({ route: categoryRoute, path: `/api/finance/categories/${correctionCategory.data.id}`, method: 'PATCH', body: { active: true } })).status, 200,
    'correction-only categories can be restored');
  assert.equal((await callApi({ route: categoryRoute, path: `/api/finance/categories/${correctionCategory.data.id}`, method: 'PATCH', body: { active: false } })).status, 200,
    'correction-only categories can be archived again after restore');

  const withUsage = await callApi({ route: categoryRoute, path: '/api/finance/categories' });
  assert.equal(withUsage.data.items.find((item) => item.id === categoryId).operationCount, 2);
  assert.equal(withUsage.data.items.find((item) => item.id === categoryId).recurringRuleCount, 0,
    'category usage exposes recurring rules as a separate source count');
  const renamed = await callApi({ route: categoryRoute, path: `/api/finance/categories/${categoryId}`, method: 'PATCH', body: { name: 'Коммунальные услуги' } });
  assert.equal(renamed.status, 200);
  const historicalExpense = await setup.query('SELECT category,category_id AS "categoryId" FROM expenses WHERE id=$1 AND venue_id=$2', [expense.data.id, venueId]);
  assert.equal(historicalExpense.rows[0].category, 'Коммунальные расходы', 'renaming a category preserves the historical label copied into the expense');
  assert.equal(historicalExpense.rows[0].categoryId, categoryId);
  assert.equal((await callApi({ route: categoryRoute, path: `/api/finance/categories/${categoryId}`, method: 'PATCH', body: { kind: 'income' } })).status, 409,
    'a category linked to expenses cannot change into an income category');

  const archived = await callApi({ route: categoryRoute, path: `/api/finance/categories/${categoryId}`, method: 'PATCH', body: { active: false } });
  assert.equal(archived.status, 200);
  assert.equal(archived.data.active, false);
  assert.deepEqual((await callApi({ route: categoryRoute, path: '/api/finance/categories' })).data.items, [], 'archived categories are omitted from expense assignment');
  const archivedList = await callApi({ route: categoryRoute, path: '/api/finance/categories?includeArchived=true' });
  assert.equal(archivedList.data.items.find((item) => item.id === categoryId).operationCount, 2, 'archive preserves and exposes historical operation count');
  assert.equal((await callApi({ route: expenseRoute, path: '/api/expenses', method: 'POST', body: { categoryId, amount: 10, expenseDate: '2026-09-28' } })).status, 400,
    'archived categories cannot be assigned to new expenses');
  assert.equal((await callApi({ route: categoryRoute, path: `/api/finance/categories/${categoryId}`, venue: otherVenueId, method: 'PATCH', body: { active: true } })).status, 404,
    'another venue cannot restore this category');
  const restored = await callApi({ route: categoryRoute, path: `/api/finance/categories/${categoryId}`, method: 'PATCH', body: { active: true } });
  assert.equal(restored.status, 200);
  assert.equal(restored.data.active, true);
  assert.equal((await callApi({ route: categoryRoute, path: '/api/finance/categories' })).data.items.length, 1);

  // Hold the category row lock, let expense creation reach SELECT ... FOR UPDATE,
  // then archive it before releasing the lock. The expense must be rejected.
  const raceClient = await pool.connect();
  try {
    await raceClient.query('BEGIN');
    await raceClient.query('SELECT id FROM finance_categories WHERE id=$1 AND venue_id=$2 FOR UPDATE', [categoryId, venueId]);
    let signalArchiveValidation;
    const archiveValidationStarted = new Promise((resolve) => { signalArchiveValidation = resolve; });
    const archiveRace = callApi({ route: expenseRoute, path: '/api/expenses', method: 'POST', body: { categoryId, amount: '27.00', expenseDate: '2026-09-28', paymentAccountId: financeAccountId, paymentMethod: 'card', idempotencyKey: '22000000-0000-4000-8000-000000000004' }, onCategoryValidationStarted: signalArchiveValidation });
    let archiveBarrierTimer;
    await Promise.race([archiveValidationStarted, new Promise((_, reject) => { archiveBarrierTimer = setTimeout(() => reject(new Error('Timed out waiting for the category validation query dispatch')), 5000); })]).finally(() => clearTimeout(archiveBarrierTimer));
    let archiveSettled = false; archiveRace.then(() => { archiveSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(archiveSettled, false, 'expense request remains blocked while the category row lock is held');
    await raceClient.query('UPDATE finance_categories SET active=false WHERE id=$1 AND venue_id=$2', [categoryId, venueId]);
    await raceClient.query('COMMIT');
    const rejectedRace = await archiveRace;
    assert.equal(rejectedRace.status, 400, 'archiving a category wins over a concurrent new expense');
    const afterRejectedRace = await setup.query('SELECT COUNT(*)::int AS count FROM expenses WHERE venue_id=$1 AND category_id=$2', [venueId, categoryId]);
    assert.equal(afterRejectedRace.rows[0].count, 2, 'rejected race does not insert an expense');
  } finally {
    await raceClient.query('ROLLBACK').catch(() => {});
    raceClient.release();
  }
  await callApi({ route: categoryRoute, path: `/api/finance/categories/${categoryId}`, method: 'PATCH', body: { active: true } });

  // Renaming while an expense waits must snapshot the committed, new name.
  const renameClient = await pool.connect();
  try {
    await renameClient.query('BEGIN');
    await renameClient.query('SELECT id FROM finance_categories WHERE id=$1 AND venue_id=$2 FOR UPDATE', [categoryId, venueId]);
    let signalRenameValidation;
    const renameValidationStarted = new Promise((resolve) => { signalRenameValidation = resolve; });
    const renameRace = callApi({ route: expenseRoute, path: '/api/expenses', method: 'POST', body: { categoryId, amount: '31.00', expenseDate: '2026-09-28', paymentAccountId: financeAccountId, paymentMethod: 'card', idempotencyKey: '22000000-0000-4000-8000-000000000005' }, onCategoryValidationStarted: signalRenameValidation });
    let renameBarrierTimer;
    await Promise.race([renameValidationStarted, new Promise((_, reject) => { renameBarrierTimer = setTimeout(() => reject(new Error('Timed out waiting for the category validation query dispatch')), 5000); })]).finally(() => clearTimeout(renameBarrierTimer));
    let renameSettled = false; renameRace.then(() => { renameSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(renameSettled, false, 'expense request remains blocked while the category row lock is held');
    await renameClient.query("UPDATE finance_categories SET name='Коммунальные услуги HQ' WHERE id=$1 AND venue_id=$2", [categoryId, venueId]);
    await renameClient.query('COMMIT');
    const acceptedRace = await renameRace;
    assert.equal(acceptedRace.status, 201, JSON.stringify(acceptedRace));
    assert.equal(acceptedRace.data.category, 'Коммунальные услуги HQ', 'concurrent expense uses committed category name');
  } finally {
    await renameClient.query('ROLLBACK').catch(() => {});
    renameClient.release();
  }

  const legacy = await setup.query("INSERT INTO expenses (venue_id,category,amount,expense_date,source) VALUES ($1,'Старая категория',5,'2026-09-28','other') RETURNING category_id", [venueId]);
  assert.equal(legacy.rows[0].category_id, null, 'legacy and non-catalog expense rows remain valid without guessing category links');
  assert.ok(audit.some((event) => event.entityType === 'finance_category' && event.action === 'finance_category.created'));
  console.log('FINANCE CATEGORIES POSTGRES API QA: PASS (durable CRUD, paged/date-filtered expenses, expense linkage/history, operation counts, archive/restore, concurrent archive/rename, role and venue isolation)');
} finally {
  if (originalAuthRequired === undefined) delete process.env.AUTH_REQUIRED;
  else process.env.AUTH_REQUIRED = originalAuthRequired;
  if (setupConnected) await setup.query('DELETE FROM venues WHERE id = ANY($1::uuid[])', [[venueId, otherVenueId].filter(Boolean)]).catch(() => {});
  await setup.end();
  await pool.end();
}
