import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertQaDatabaseIdentity, validateQaDatabaseUrl } from './postgres-qa-safety.mjs';

const require = createRequire(import.meta.url);
const { Client, Pool } = require('pg');
const { handleFinanceExpenseCorrectionRoute } = require('../finance-expense-corrections.js');
const target = validateQaDatabaseUrl(process.env.MIGRATIONS_PG_TEST_DATABASE_URL);
const root = fileURLToPath(new URL('../', import.meta.url));
const schemaName = `finance_expense_corrections_qa_${process.pid}_${Date.now()}`;
const scopedUrl = new URL(target.url);
scopedUrl.searchParams.set('options', `-c search_path=${schemaName}`);
const admin = new Client({ connectionString: target.url.href });
let pool;
let created = false;

async function insert(client, table, row) {
  const fields = Object.keys(row);
  const values = fields.map((field) => row[field]);
  return (await client.query(`INSERT INTO ${table} (${fields.join(',')}) VALUES (${fields.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`, values)).rows[0].id;
}

async function call({ method, pathname, body = {}, venueId, userId, permissions = ['finance'] }) {
  const result = {};
  const handled = await handleFinanceExpenseCorrectionRoute({
    req: { method, user: { id: userId, role: 'owner' } }, res: result,
    url: new URL(pathname, 'http://localhost'), pool, venueId,
    json: (_res, status, payload) => Object.assign(result, { status, payload }),
    readBody: async () => body,
    hasPermission: (permission) => permissions.includes(permission),
    isOperationalEmployee: () => false,
    recordAudit: () => {},
  });
  assert.equal(handled, true);
  return result;
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
  const migration = readFileSync(path.join(root, 'migrations/131_finance_expense_corrections.sql'), 'utf8');
  await admin.query(migration);
  await admin.query(migration);
  const categoryMigration = readFileSync(path.join(root, 'migrations/133_finance_expense_correction_category_refs.sql'), 'utf8');
  await admin.query(categoryMigration);
  await admin.query(categoryMigration);
  pool = new Pool({ connectionString: scopedUrl.href, max: 4 });

  const venueId = await insert(admin, 'venues', { name: 'Finance correction QA' });
  const userId = await insert(admin, 'users', { venue_id: venueId, full_name: 'QA owner', login: `${schemaName}-owner`, role: 'owner' });
  const categoryId = await insert(admin, 'finance_categories', { venue_id: venueId, name: 'Аренда', kind: 'expense' });
  const nextCategoryId = await insert(admin, 'finance_categories', { venue_id: venueId, name: 'Коммунальные расходы', kind: 'expense' });
  const thirdCategoryId = await insert(admin, 'finance_categories', { venue_id: venueId, name: 'Содержание помещения', kind: 'expense' });
  const incomeCategoryId = await insert(admin, 'finance_categories', { venue_id: venueId, name: 'Продажи', kind: 'income' });
  const unusedCategoryId = await insert(admin, 'finance_categories', { venue_id: venueId, name: 'Неиспользуемая статья', kind: 'expense' });
  const expenseId = await insert(admin, 'expenses', {
    venue_id: venueId, category: 'Аренда', category_id: categoryId, amount: '1000.00', expense_date: '2026-10-01',
    description: 'Октябрь', source: 'manual', counterparty_name: 'Арендодатель', document_url: null, created_by: userId,
  });
  const otherVenue = await insert(admin, 'venues', { name: 'Other venue QA' });

  const key = '12000000-0000-4000-8000-000000000001';
  const body = { expectedVersion: 0, changes: { amount: '1250.50', categoryId: nextCategoryId }, reason: 'Уточнена сумма аренды', idempotencyKey: key };
  const createdResult = await call({ method: 'POST', pathname: `/api/finance/expenses/${expenseId}/corrections`, body, venueId, userId });
  assert.equal(createdResult.status, 201, JSON.stringify(createdResult.payload));
  assert.equal(createdResult.payload.effective.amount, '1250.50');
  assert.equal(createdResult.payload.corrections[0].amountDelta, '250.50');
  assert.equal(createdResult.payload.corrections[0].idempotencyKey, key);
  let categoryRefs = await admin.query('SELECT before_category_id,after_category_id FROM finance_expense_corrections WHERE venue_id=$1 AND expense_id=$2', [venueId, expenseId]);
  assert.deepEqual(categoryRefs.rows[0], { before_category_id: categoryId, after_category_id: nextCategoryId }, 'stored category references match immutable correction snapshots');
  const replay = await call({ method: 'POST', pathname: `/api/finance/expenses/${expenseId}/corrections`, body, venueId, userId });
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.payload, createdResult.payload);
  const secondCorrection = await call({ method: 'POST', pathname: `/api/finance/expenses/${expenseId}/corrections`, body: {
    expectedVersion: 1, changes: { amount: '1250.50', categoryId: thirdCategoryId }, reason: 'Уточнена статья расхода', idempotencyKey: '12000000-0000-4000-8000-000000000002',
  }, venueId, userId });
  assert.equal(secondCorrection.status, 201, JSON.stringify(secondCorrection.payload));
  categoryRefs = await admin.query('SELECT before_category_id,after_category_id FROM finance_expense_corrections WHERE venue_id=$1 AND expense_id=$2 ORDER BY sequence', [venueId, expenseId]);
  assert.deepEqual(categoryRefs.rows, [
    { before_category_id: categoryId, after_category_id: nextCategoryId },
    { before_category_id: nextCategoryId, after_category_id: thirdCategoryId },
  ], 'A to B to C retains category B in the intermediate correction history');
  const read = await call({ method: 'GET', pathname: `/api/finance/expenses/${expenseId}`, venueId, userId, permissions: ['finance_read'] });
  assert.equal(read.status, 200);
  assert.equal(read.payload.corrections.length, 2);
  const crossVenue = await call({ method: 'GET', pathname: `/api/finance/expenses/${expenseId}`, venueId: otherVenue, userId, permissions: ['finance_read'] });
  assert.equal(crossVenue.status, 404);

  const original = (await admin.query('SELECT amount::text,category_id,description FROM expenses WHERE venue_id=$1 AND id=$2', [venueId, expenseId])).rows[0];
  assert.deepEqual(original, { amount: '1000.00', category_id: categoryId, description: 'Октябрь' });
  const count = Number((await admin.query('SELECT count(*)::int AS count FROM finance_expense_corrections WHERE venue_id=$1 AND expense_id=$2', [venueId, expenseId])).rows[0].count);
  assert.equal(count, 2);
  await assert.rejects(() => admin.query('UPDATE finance_expense_corrections SET reason=$1 WHERE venue_id=$2 AND expense_id=$3', ['rewrite', venueId, expenseId]), /finance_expense_corrections_append_only/);
  await assert.rejects(() => admin.query('DELETE FROM finance_expense_corrections WHERE venue_id=$1 AND expense_id=$2', [venueId, expenseId]), /finance_expense_corrections_append_only/);
  await assert.rejects(() => admin.query("UPDATE finance_categories SET kind='income' WHERE venue_id=$1 AND id=$2", [venueId, nextCategoryId]), (error) => error.code === '55000' && /finance_category_source_kind_immutable/.test(error.message), 'direct SQL cannot change direction for an intermediate historical category');
  await assert.rejects(() => admin.query(`INSERT INTO finance_expense_corrections
    (venue_id,expense_id,sequence,expected_version,before_snapshot,after_snapshot,amount_delta,reason,idempotency_key,request_sha256,response_json,created_by)
    VALUES ($1,$2,3,2,$3::jsonb,$4::jsonb,0,'Неверная статья','12000000-0000-4000-8000-000000000003',repeat('a',64),'{}'::jsonb,$5)`, [
    venueId, expenseId,
    JSON.stringify({ amount:'1250.50',categoryId:thirdCategoryId,categoryName:'Содержание помещения',counterpartyName:'Арендодатель',description:'Октябрь',documentUrl:null }),
    JSON.stringify({ amount:'1250.50',categoryId:incomeCategoryId,categoryName:'Продажи',counterpartyName:'Арендодатель',description:'Октябрь',documentUrl:null }), userId,
  ]), (error) => error.code === '23514' && /finance_expense_correction_category_invalid/.test(error.message), 'direct inserts cannot attach an income category to an expense correction');
  await admin.query("UPDATE finance_categories SET name='Коммунальные услуги',active=false WHERE venue_id=$1 AND id=$2", [venueId, nextCategoryId]);
  assert.deepEqual((await admin.query('SELECT name,kind,active FROM finance_categories WHERE venue_id=$1 AND id=$2', [venueId, nextCategoryId])).rows[0], { name: 'Коммунальные услуги', kind: 'expense', active: false }, 'historically referenced categories may be renamed and archived');
  await admin.query("UPDATE finance_categories SET kind='income' WHERE venue_id=$1 AND id=$2", [venueId, unusedCategoryId]);
  console.log('FINANCE EXPENSE CORRECTIONS POSTGRES QA: PASS (migration replay, A-to-B-to-C category history, direct direction guard, invalid income ref rejection, idempotent replay, tenant boundary, immutable source and append-only journal)');
} finally {
  await pool?.end();
  if (created) await admin.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => {});
  await admin.end().catch(() => {});
}
