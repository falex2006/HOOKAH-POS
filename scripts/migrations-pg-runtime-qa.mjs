import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const databaseUrl = process.env.MIGRATIONS_PG_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('Set MIGRATIONS_PG_TEST_DATABASE_URL to an isolated PostgreSQL test database');
const parsed = new URL(databaseUrl);
assert.match(parsed.pathname, /(?:test|qa|scratch)/i,
  'refusing test writes unless the database name clearly identifies a test/QA/scratch database');

const require = createRequire(import.meta.url);
const { Client } = require('pg');
const client = new Client({ connectionString: databaseUrl });
let transaction = false;

async function expectSqlState(promise, sqlState, message) {
  await assert.rejects(promise, (error) => error.code === sqlState, message);
  await client.query('ROLLBACK TO SAVEPOINT expected_failure');
  await client.query('RELEASE SAVEPOINT expected_failure');
}

try {
  await client.connect();
  await client.query('BEGIN');
  transaction = true;

  const venueA = (await client.query("INSERT INTO venues (name) VALUES ('Migration QA A') RETURNING id")).rows[0].id;
  const venueB = (await client.query("INSERT INTO venues (name) VALUES ('Migration QA B') RETURNING id")).rows[0].id;
  const userA = (await client.query(
    "INSERT INTO users (venue_id,full_name,login,role) VALUES ($1,'Migration QA','migration-qa-' || gen_random_uuid()::text,'owner') RETURNING id", [venueA],
  )).rows[0].id;
  const userB = (await client.query(
    "INSERT INTO users (venue_id,full_name,login,role) VALUES ($1,'Migration QA','migration-qa-' || gen_random_uuid()::text,'owner') RETURNING id", [venueB],
  )).rows[0].id;

  const shiftA = (await client.query(
    'INSERT INTO shifts (venue_id,opened_by,opening_cash) VALUES ($1,$2,100) RETURNING id', [venueA, userA],
  )).rows[0].id;
  const shiftB = (await client.query(
    'INSERT INTO shifts (venue_id,opened_by,opening_cash) VALUES ($1,$2,50) RETURNING id', [venueB, userB],
  )).rows[0].id;
  const cashAccountA = (await client.query(
    "SELECT id,name FROM finance_accounts WHERE venue_id=$1 AND code='main_cashbox' AND active", [venueA],
  )).rows[0];
  assert.ok(cashAccountA, 'finance account migration seeds the venue POS cashbox');
  const cardAccountA = (await client.query(
    "INSERT INTO finance_accounts (venue_id,code,name,kind,allowed_payment_methods,created_by) VALUES ($1,'migration_qa_card','Migration QA card account','bank',ARRAY['card']::text[],$2) RETURNING id,name",
    [venueA, userA],
  )).rows[0];

  await client.query('SAVEPOINT expected_failure');
  await expectSqlState(
    client.query('INSERT INTO shifts (venue_id,opened_by) VALUES ($1,$2)', [venueA, userA]),
    '23505', '041 allows only one open shift per venue',
  );

  const orderA = (await client.query(
    'INSERT INTO orders (venue_id,opened_by) VALUES ($1,$2) RETURNING id', [venueA, userA],
  )).rows[0].id;
  await client.query(
    "INSERT INTO payments (order_id,method,amount,status,shift_id,finance_account_id,finance_account_name_snapshot) VALUES ($1,'cash',25,'paid',$2,$3,$4)",
    [orderA, shiftA, cashAccountA.id, cashAccountA.name],
  );
  const attributed = await client.query('SELECT COUNT(*)::int AS count FROM payments WHERE order_id=$1 AND shift_id=$2', [orderA, shiftA]);
  assert.equal(attributed.rows[0].count, 1, '039 stores a payment against its same-venue shift');
  await client.query(
    "INSERT INTO payments (order_id,method,amount,status,finance_account_id,finance_account_name_snapshot) VALUES ($1,'card',5,'paid',$2,$3)",
    [orderA, cardAccountA.id, cardAccountA.name],
  );
  await client.query('SAVEPOINT expected_failure');
  await expectSqlState(
    client.query("INSERT INTO payments (order_id,method,amount,status,shift_id) VALUES ($1,'cash',5,'paid',$2)", [orderA, shiftB]),
    '23514', '039 rejects cross-venue payment/shift attribution',
  );

  const documentId = (await client.query(
    "INSERT INTO inventory_purchase_documents (venue_id,supplier_name,status) VALUES ($1,'Migration QA supplier','draft') RETURNING id", [venueA],
  )).rows[0].id;
  await client.query("UPDATE inventory_purchase_documents SET status='posted' WHERE id=$1", [documentId]);
  const expenseId = (await client.query(
    "INSERT INTO expenses (venue_id,category,amount,expense_date,source,purchase_document_id,idempotency_key,payment_method) VALUES ($1,'Закупка',25,CURRENT_DATE,'purchase',$2,'qa-idem-a','cash') RETURNING id",
    [venueA, documentId],
  )).rows[0].id;
  assert.ok(expenseId, '042 links a purchase payment expense to a posted document');

  await client.query('SAVEPOINT expected_failure');
  await expectSqlState(
    client.query("INSERT INTO expenses (venue_id,category,amount,expense_date,source,purchase_document_id) VALUES ($1,'Закупка',5,CURRENT_DATE,'purchase',$2)", [venueB, documentId]),
    'P0001', '042 rejects a purchase document from another venue',
  );
  await client.query('SAVEPOINT expected_failure');
  await expectSqlState(
    client.query("INSERT INTO expenses (venue_id,category,amount,expense_date,source,purchase_document_id) VALUES ($1,'Прочее',5,CURRENT_DATE,'other',$2)", [venueA, documentId]),
    'P0001', '042 enforces purchase source for linked receipt expenses',
  );
  await client.query('SAVEPOINT expected_failure');
  await expectSqlState(
    client.query("INSERT INTO expenses (venue_id,category,amount,expense_date,source,purchase_document_id,idempotency_key) VALUES ($1,'Закупка',25,CURRENT_DATE,'purchase',$2,'qa-idem-a')", [venueA, documentId]),
    '23505', '042 enforces one expense per venue/idempotency key',
  );
  await client.query('SAVEPOINT expected_failure');
  await expectSqlState(
    client.query("UPDATE inventory_purchase_documents SET status='voided' WHERE id=$1", [documentId]),
    '23514', 'posted purchase documents cannot be voided without a reversal flow',
  );

  console.log('MIGRATIONS PG RUNTIME QA: PASS (039 payment attribution and tenant guard; 041 one open shift; 042 posted-document link, tenant/source guards and idempotency; all data rolled back)');
} finally {
  if (transaction) await client.query('ROLLBACK').catch(() => {});
  if (client._connected) await client.end();
}
