import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertQaDatabaseIdentity, validateQaDatabaseUrl } from './postgres-qa-safety.mjs';

const require = createRequire(import.meta.url);
const { Client, Pool } = require('pg');
const { handleFinanceExpenseDraftRoute } = require('../finance-expense-drafts');
const { isValidIsoDate } = require('../payroll');
const { validateDataUrl } = require('../purchase-document-validation');
const target = validateQaDatabaseUrl(process.env.MIGRATIONS_PG_TEST_DATABASE_URL);
const root = fileURLToPath(new URL('../', import.meta.url));
const schemaName = `finance_expense_drafts_qa_${process.pid}_${Date.now()}`;
const scopedUrl = new URL(target.url);
scopedUrl.searchParams.set('options', `-c search_path=${schemaName}`);
const admin = new Client({ connectionString: target.url.href });
let db;
let pool;
let created = false;

async function insert(client, table, row) {
  const fields = Object.keys(row);
  const values = fields.map((field) => row[field]);
  return (await client.query(
    `INSERT INTO ${table} (${fields.join(',')}) VALUES (${fields.map((_, index) => `$${index + 1}`).join(',')}) RETURNING id`,
    values,
  )).rows[0].id;
}

async function callRoute({ method, pathname, body = {}, venueId, userId, permissions = ['finance'], operational = false }) {
  const res = { statusCode: null, body: null };
  const handled = await handleFinanceExpenseDraftRoute({
    req: { method, user: { id: userId, venueId } },
    res,
    url: new URL(pathname, 'http://localhost'),
    pool,
    venueId,
    json: (_res, status, value) => { res.statusCode = status; res.body = value; },
    readBody: async () => body,
    hasPermission: (permission) => permissions.includes(permission),
    isOperationalEmployee: () => operational,
    recordAudit: () => {},
    isValidIsoDate,
    validateDocument: validateDataUrl,
  });
  assert.equal(handled, true, `route should handle ${method} ${pathname}`);
  return res;
}

try {
  await admin.connect();
  const identity = (await admin.query(`SELECT current_database() AS database,inet_server_addr() AS address,
    inet_server_port() AS port,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser`)).rows[0];
  assertQaDatabaseIdentity(identity, target.database, Number(target.url.port));
  await admin.query(`CREATE SCHEMA ${schemaName}`);
  created = true;
  await admin.query(`SET search_path TO ${schemaName}`);
  await admin.query(readFileSync(path.join(root, 'schema.sql'), 'utf8'));
  const migration116 = readFileSync(path.join(root, 'migrations/116_finance_expense_drafts.sql'), 'utf8');
  await admin.query(migration116);
  await admin.query(migration116);
  db = new Client({ connectionString: scopedUrl.href });
  await db.connect();
  pool = new Pool({ connectionString: scopedUrl.href, max: 4 });

  const organizationId = await insert(db, 'organizations', { name: 'Expense draft QA', slug: schemaName });
  const venueId = await insert(db, 'venues', { name: 'Expense draft QA', organization_id: organizationId, timezone: 'Asia/Yekaterinburg' });
  const secondVenueId = await insert(db, 'venues', { name: 'Other venue QA', organization_id: organizationId, timezone: 'Asia/Yekaterinburg' });
  const ownerId = await insert(db, 'users', { venue_id: venueId, full_name: 'Finance QA', login: `${schemaName}-owner`, role: 'owner' });
  const secondOwnerId = await insert(db, 'users', { venue_id: secondVenueId, full_name: 'Other QA', login: `${schemaName}-other`, role: 'owner' });
  const categoryId = await insert(db, 'finance_categories', { venue_id: venueId, name: 'Аренда', kind: 'expense' });
  const secondCategoryId = await insert(db, 'finance_categories', { venue_id: secondVenueId, name: 'Аренда', kind: 'expense' });
  const accountId = await insert(db, 'finance_accounts', {
    venue_id: venueId, code: 'qa_bank', name: 'QA Bank', kind: 'bank', allowed_payment_methods: ['bank_transfer'],
  });
  const today = (await db.query("SELECT (now() AT TIME ZONE 'Asia/Yekaterinburg')::date::text AS date")).rows[0].date;
  const createKey = '10000000-0000-4000-8000-000000000001';
  const createBody = {
    categoryId, amount: '20000.00', expenseDate: today, counterpartyName: 'Арендодатель',
    description: 'Аренда зала', source: 'manual', paymentAccountId: accountId,
    paymentMethod: 'bank_transfer', documentUrl: '', idempotencyKey: createKey,
  };

  const createdDraft = await callRoute({ method: 'POST', pathname: '/api/finance/expense-drafts', body: createBody, venueId, userId: ownerId });
  assert.equal(createdDraft.statusCode, 201, JSON.stringify(createdDraft.body));
  assert.equal(createdDraft.body.item.status, 'draft');
  assert.equal(createdDraft.body.item.version, 1);
  const replayDraft = await callRoute({ method: 'POST', pathname: '/api/finance/expense-drafts', body: createBody, venueId, userId: ownerId });
  assert.equal(replayDraft.statusCode, 200);
  assert.equal(replayDraft.body.item.id, createdDraft.body.item.id);
  assert.equal(replayDraft.body.idempotent, true);
  const alteredCreate = await callRoute({ method: 'POST', pathname: '/api/finance/expense-drafts', body: { ...createBody, amount: '21000.00' }, venueId, userId: ownerId });
  assert.equal(alteredCreate.statusCode, 409);
  assert.equal(alteredCreate.body.error, 'expense_draft_idempotency_conflict');

  const readOnly = await callRoute({ method: 'GET', pathname: '/api/finance/expense-drafts?status=draft', venueId, userId: ownerId, permissions: ['finance_read'] });
  assert.equal(readOnly.statusCode, 200);
  assert.equal(readOnly.body.items.length, 1);
  const readForeign = await callRoute({ method: 'GET', pathname: '/api/finance/expense-drafts?status=draft', venueId: secondVenueId, userId: secondOwnerId, permissions: ['finance_read'] });
  assert.equal(readForeign.body.items.length, 0);
  const operationalRead = await callRoute({ method: 'GET', pathname: '/api/finance/expense-drafts?status=draft', venueId, userId: ownerId, permissions: ['finance_read'], operational: true });
  assert.equal(operationalRead.statusCode, 403);
  const writeReadOnly = await callRoute({ method: 'POST', pathname: '/api/finance/expense-drafts', body: createBody, venueId, userId: ownerId, permissions: ['finance_read'] });
  assert.equal(writeReadOnly.statusCode, 403);
  assert.equal((await db.query('SELECT COUNT(*)::int AS count FROM expenses WHERE venue_id=$1', [venueId])).rows[0].count, 0,
    'saving a draft does not create a cash/P&L expense');

  const staleEdit = await callRoute({ method: 'PATCH', pathname: `/api/finance/expense-drafts/${createdDraft.body.item.id}`, body: { ...createBody, expectedVersion: 0 }, venueId, userId: ownerId });
  assert.equal(staleEdit.statusCode, 409);
  assert.equal(staleEdit.body.error, 'expense_draft_version_conflict');
  const updated = await callRoute({
    method: 'PATCH', pathname: `/api/finance/expense-drafts/${createdDraft.body.item.id}`,
    body: { ...createBody, amount: '21000.00', expectedVersion: 1 }, venueId, userId: ownerId,
  });
  assert.equal(updated.statusCode, 200);
  assert.equal(updated.body.item.version, 2);
  assert.equal(updated.body.item.counterpartyName, 'Арендодатель');
  const createReplayAfterEdit = await callRoute({ method: 'POST', pathname: '/api/finance/expense-drafts', body: createBody, venueId, userId: ownerId });
  assert.equal(createReplayAfterEdit.statusCode, 200);
  assert.equal(createReplayAfterEdit.body.item.id, createdDraft.body.item.id);
  assert.equal(createReplayAfterEdit.body.item.version, 2);
  assert.equal(createReplayAfterEdit.body.idempotent, true);
  const staleReplay = await callRoute({
    method: 'PATCH', pathname: `/api/finance/expense-drafts/${createdDraft.body.item.id}`,
    body: { ...createBody, expectedVersion: 1 }, venueId, userId: ownerId,
  });
  assert.equal(staleReplay.body.error, 'expense_draft_version_conflict');

  await db.query("UPDATE finance_categories SET name='Аренда помещения' WHERE venue_id=$1 AND id=$2", [venueId, categoryId]);
  await db.query("UPDATE finance_accounts SET name='QA Bank Renamed' WHERE venue_id=$1 AND id=$2", [venueId, accountId]);

  const postBody = { expectedVersion: 2, idempotencyKey: '20000000-0000-4000-8000-000000000001' };
  const posted = await callRoute({ method: 'POST', pathname: `/api/finance/expense-drafts/${createdDraft.body.item.id}/post`, body: postBody, venueId, userId: ownerId });
  assert.equal(posted.statusCode, 201, JSON.stringify(posted.body));
  assert.equal(posted.body.item.status, 'posted');
  assert.equal(posted.body.item.categoryName, 'Аренда помещения');
  assert.equal(posted.body.item.paymentAccountNameSnapshot, 'QA Bank Renamed');
  assert.equal(posted.body.expense.amount, '21000.00');
  assert.equal(posted.body.expense.counterparty_name, 'Арендодатель');
  const postedReadback = await callRoute({ method: 'GET', pathname: `/api/finance/expense-drafts/${createdDraft.body.item.id}?status=all`, venueId, userId: ownerId, permissions: ['finance_read'] });
  assert.equal(postedReadback.body.items[0].postIdempotencyKey, postBody.idempotencyKey);
  assert.equal(postedReadback.body.items[0].postedVersion, 2);
  const postedReplay = await callRoute({ method: 'POST', pathname: `/api/finance/expense-drafts/${createdDraft.body.item.id}/post`, body: postBody, venueId, userId: ownerId });
  assert.equal(postedReplay.statusCode, 200);
  assert.equal(postedReplay.body.idempotent, true);
  assert.equal(postedReplay.body.expense.id, posted.body.expense.id);
  const changedPostKey = await callRoute({ method: 'POST', pathname: `/api/finance/expense-drafts/${createdDraft.body.item.id}/post`, body: { ...postBody, idempotencyKey: '20000000-0000-4000-8000-000000000002' }, venueId, userId: ownerId });
  assert.equal(changedPostKey.statusCode, 409);
  assert.equal((await db.query('SELECT COUNT(*)::int AS count FROM expenses WHERE venue_id=$1', [venueId])).rows[0].count, 1,
    'exact posting replay produces one expense row');

  await assert.rejects(db.query('UPDATE expenses SET amount=1 WHERE venue_id=$1 AND id=$2', [venueId, posted.body.expense.id]),
    /posted_finance_expense_immutable/);
  await assert.rejects(db.query('DELETE FROM expenses WHERE venue_id=$1 AND id=$2', [venueId, posted.body.expense.id]),
    /posted_finance_expense_immutable/);
  await assert.rejects(db.query("UPDATE finance_categories SET kind='income' WHERE venue_id=$1 AND id=$2", [venueId, categoryId]),
    /finance_category_source_kind_immutable/);

  const cancelDraft = await callRoute({ method: 'POST', pathname: '/api/finance/expense-drafts', body: { ...createBody, amount: '900.00', idempotencyKey: '10000000-0000-4000-8000-000000000002' }, venueId, userId: ownerId });
  const cancelled = await callRoute({ method: 'POST', pathname: `/api/finance/expense-drafts/${cancelDraft.body.item.id}/cancel`, body: { expectedVersion: 1 }, venueId, userId: ownerId });
  assert.equal(cancelled.statusCode, 200);
  assert.equal(cancelled.body.item.status, 'cancelled');
  assert.equal((await db.query('SELECT COUNT(*)::int AS count FROM expenses WHERE venue_id=$1', [venueId])).rows[0].count, 1,
    'cancelling a draft creates no expense row');

  const archiveCategoryId = await insert(db, 'finance_categories', { venue_id: venueId, name: 'Временная аренда', kind: 'expense' });
  const archiveDraft = await callRoute({ method: 'POST', pathname: '/api/finance/expense-drafts', body: {
    ...createBody, categoryId: archiveCategoryId, amount: '300.00', idempotencyKey: '10000000-0000-4000-8000-000000000006',
  }, venueId, userId: ownerId });
  assert.equal(archiveDraft.statusCode, 201);
  await db.query('UPDATE finance_categories SET active=false WHERE venue_id=$1 AND id=$2', [venueId, archiveCategoryId]);
  const archivedCategoryPost = await callRoute({ method: 'POST', pathname: `/api/finance/expense-drafts/${archiveDraft.body.item.id}/post`, body: {
    expectedVersion: 1, idempotencyKey: '20000000-0000-4000-8000-000000000006',
  }, venueId, userId: ownerId });
  assert.equal(archivedCategoryPost.statusCode, 400);
  assert.equal(archivedCategoryPost.body.error, 'invalid_finance_category');

  const legacyExpenseId = await insert(db, 'expenses', {
    venue_id: venueId, category: 'Аренда', category_id: categoryId, amount: '500.00', expense_date: today,
    source: 'manual', created_by: ownerId, idempotency_key: 'legacy-expense-qa-001', payment_method: 'bank_transfer',
    finance_account_id: accountId, finance_account_name_snapshot: 'QA Bank',
  });
  await assert.rejects(db.query('UPDATE expenses SET description=\'edited\' WHERE venue_id=$1 AND id=$2', [venueId, legacyExpenseId]),
    /posted_finance_expense_immutable/);
  await assert.rejects(db.query('DELETE FROM expenses WHERE venue_id=$1 AND id=$2', [venueId, legacyExpenseId]),
    /posted_finance_expense_immutable/);
  await db.query(`INSERT INTO payroll_entries (venue_id,user_id,period_from,period_to,amount,expense_id,status,finance_category_id,finance_category_name_snapshot)
    VALUES ($1,$2,'2026-10-01','2026-10-31',500,$3,'approved',$4,'Аренда помещения')`, [venueId, ownerId, legacyExpenseId, categoryId]);
  await db.query(`UPDATE expenses SET category='Аренда помещения',category_id=$3,amount=500,expense_date=$4,
    description='Выплата зарплаты за 01.10.2026 — 31.10.2026',source='payroll',created_by=$5 WHERE venue_id=$1 AND id=$2`,
  [venueId, legacyExpenseId, categoryId, today, ownerId]);

  const forgedDraft = await callRoute({ method: 'POST', pathname: '/api/finance/expense-drafts', body: {
    ...createBody, amount: '750.00', idempotencyKey: '10000000-0000-4000-8000-000000000003',
  }, venueId, userId: ownerId });
  assert.equal(forgedDraft.statusCode, 201);
  await assert.rejects(db.query(`UPDATE finance_expense_drafts SET status='posted',expense_id=$3,posted_at=now(),
    posted_by=$4,post_idempotency_key='forged-post-key-001',posted_version=1 WHERE venue_id=$1 AND id=$2`,
  [venueId, forgedDraft.body.item.id, legacyExpenseId, ownerId]), /finance_expense_draft_post_expense_mismatch/);

  const foreignAccount = await insert(db, 'finance_accounts', {
    venue_id: secondVenueId, code: 'foreign_bank', name: 'Foreign Bank', kind: 'bank', allowed_payment_methods: ['bank_transfer'],
  });
  const foreignReference = await callRoute({ method: 'POST', pathname: '/api/finance/expense-drafts', body: { ...createBody, categoryId: secondCategoryId, paymentAccountId: foreignAccount, idempotencyKey: '10000000-0000-4000-8000-000000000005' }, venueId, userId: ownerId });
  assert.equal(foreignReference.statusCode, 400);
  assert.equal(foreignReference.body.error, 'invalid_finance_category');

  const posAccountId = (await db.query("SELECT id FROM finance_accounts WHERE venue_id=$1 AND kind='pos_cashbox' AND active=true", [venueId])).rows[0].id;
  const posDraft = await callRoute({ method: 'POST', pathname: '/api/finance/expense-drafts', body: { ...createBody, amount: '500.00', expenseDate: today, paymentAccountId: posAccountId, paymentMethod: 'cash', idempotencyKey: '10000000-0000-4000-8000-000000000004' }, venueId, userId: ownerId });
  const posPostBody = { expectedVersion: 1, idempotencyKey: '20000000-0000-4000-8000-000000000004' };
  const noShift = await callRoute({ method: 'POST', pathname: `/api/finance/expense-drafts/${posDraft.body.item.id}/post`, body: posPostBody, venueId, userId: ownerId });
  assert.equal(noShift.statusCode, 409);
  assert.equal(noShift.body.error, 'finance_payment_open_shift_required');
  const shiftId = await insert(db, 'shifts', { venue_id: venueId, opened_by: ownerId, opening_cash: '0.00' });
  const posPosted = await callRoute({ method: 'POST', pathname: `/api/finance/expense-drafts/${posDraft.body.item.id}/post`, body: posPostBody, venueId, userId: ownerId });
  assert.equal(posPosted.statusCode, 201);
  assert.equal(posPosted.body.expense.shift_id, shiftId);

  console.log('FINANCE EXPENSE DRAFTS POSTGRES QA: PASS (draft persistence, versioning, permissions, tenant scope, idempotency, one posted expense, POS shift)');
} finally {
  await pool?.end().catch(() => {});
  await db?.end().catch(() => {});
  if (created) await admin.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => {});
  await admin.end().catch(() => {});
}
