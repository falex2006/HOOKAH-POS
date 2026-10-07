import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const databaseUrl = process.env.MIGRATIONS_PG_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('Set MIGRATIONS_PG_TEST_DATABASE_URL to an isolated PostgreSQL test database');
assert.match(new URL(databaseUrl).pathname, /(?:test|qa|scratch)/i,
  'refusing test writes unless the database name clearly identifies a test/QA/scratch database');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { Client } = require('pg');
const client = new Client({ connectionString: databaseUrl });
const schemaName = `order_item_sales_qa_${process.pid}_${Date.now()}`;
const schema = `"${schemaName}"`;

const rejects = async (sql, values, code, label) => {
  await client.query('SAVEPOINT attribution_expected_rejection');
  let caught = null;
  try { await client.query(sql, values); } catch (error) { caught = error; }
  await client.query('ROLLBACK TO SAVEPOINT attribution_expected_rejection');
  await client.query('RELEASE SAVEPOINT attribution_expected_rejection');
  assert.ok(caught, `${label}: query should fail`);
  assert.equal(caught.code, code, label);
};

try {
  await client.connect();
  await client.query('BEGIN');
  await client.query(`CREATE SCHEMA ${schema}`);
  await client.query(`SET LOCAL search_path TO ${schema}, public`);
  await client.query(fs.readFileSync(path.join(root, 'schema.sql'), 'utf8'));

  // Model an existing pre-084 database, then exercise the actual upgrade migration.
  await client.query('DROP TRIGGER order_items_sales_attribution_validate ON order_items');
  await client.query('ALTER TABLE order_items DROP COLUMN sales_employee_id CASCADE, DROP COLUMN sold_at CASCADE');
  await client.query(fs.readFileSync(path.join(root, 'migrations', '084_order_item_sales_attribution.sql'), 'utf8'));

  const venue = (await client.query("INSERT INTO venues (name) VALUES ('POS attribution QA') RETURNING id")).rows[0].id;
  const otherVenue = (await client.query("INSERT INTO venues (name) VALUES ('POS attribution other venue QA') RETURNING id")).rows[0].id;
  const employee = (await client.query("INSERT INTO users (venue_id,full_name,login,role) VALUES ($1,'Active QA','pos-active-'||gen_random_uuid(),'bartender') RETURNING id", [venue])).rows[0].id;
  const inactive = (await client.query("INSERT INTO users (venue_id,full_name,login,role,is_active) VALUES ($1,'Inactive QA','pos-inactive-'||gen_random_uuid(),'bartender',false) RETURNING id", [venue])).rows[0].id;
  const foreignEmployee = (await client.query("INSERT INTO users (venue_id,full_name,login,role) VALUES ($1,'Other QA','pos-other-'||gen_random_uuid(),'bartender') RETURNING id", [otherVenue])).rows[0].id;
  const opener = (await client.query("INSERT INTO users (venue_id,full_name,login,role) VALUES ($1,'Opener QA','pos-opener-'||gen_random_uuid(),'owner') RETURNING id", [venue])).rows[0].id;
  const order = (await client.query("INSERT INTO orders (venue_id,opened_by,status) VALUES ($1,$2,'open') RETURNING id", [venue, opener])).rows[0].id;
  const product = (await client.query("INSERT INTO products (venue_id,name,category) VALUES ($1,'Attribution QA','qa') RETURNING id", [venue])).rows[0].id;
  const legacy = (await client.query('INSERT INTO order_items (order_id,product_id,quantity,unit_price) VALUES ($1,$2,1,10) RETURNING id,sales_employee_id,sold_at', [order, product])).rows[0];
  assert.equal(legacy.sales_employee_id, null, 'legacy rows keep unknown employee attribution');
  assert.equal(legacy.sold_at, null, 'legacy rows keep unknown sale time');
  const attributed = (await client.query("INSERT INTO order_items (order_id,product_id,quantity,unit_price,sales_employee_id,sold_at) VALUES ($1,$2,1,10,$3,now()) RETURNING id,sales_employee_id,sold_at", [order, product, employee])).rows[0];
  assert.equal(attributed.sales_employee_id, employee, 'active same-venue employee is accepted');
  assert.ok(attributed.sold_at, 'sale time is persisted');
  await rejects('INSERT INTO order_items (order_id,product_id,quantity,unit_price,sales_employee_id,sold_at) VALUES ($1,$2,1,10,$3,now())', [order, product, foreignEmployee], '23514', 'cross-venue employees are rejected');
  await rejects('INSERT INTO order_items (order_id,product_id,quantity,unit_price,sales_employee_id,sold_at) VALUES ($1,$2,1,10,$3,now())', [order, product, inactive], '23514', 'inactive employees are rejected');
  await rejects('INSERT INTO order_items (order_id,product_id,quantity,unit_price,sales_employee_id,sold_at) VALUES ($1,$2,1,10,$3,NULL)', [order, product, employee], '23514', 'attribution requires both employee and time');
  await rejects('DELETE FROM users WHERE id=$1', [employee], '23503', 'attributed employee cannot be deleted');
  console.log('ORDER ITEM SALES ATTRIBUTION PG QA: PASS (migration upgrade, legacy NULLs, venue/active validation, paired fields, RESTRICT)');
} finally {
  await client.query('ROLLBACK').catch(() => {});
  await client.end().catch(() => {});
}
