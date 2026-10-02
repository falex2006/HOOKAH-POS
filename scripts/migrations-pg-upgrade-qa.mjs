import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const databaseUrl = process.env.MIGRATIONS_PG_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('Set MIGRATIONS_PG_TEST_DATABASE_URL to an isolated PostgreSQL test database');
const parsed = new URL(databaseUrl);
assert.match(parsed.pathname, /(?:test|qa|scratch)/i,
  'refusing test writes unless the database name clearly identifies a test/QA/scratch database');

const require = createRequire(import.meta.url);
const { Client } = require('pg');
const client = new Client({ connectionString: databaseUrl });
const schema = `migration_upgrade_qa_${process.pid}_${Date.now()}`;
const quotedSchema = `"${schema}"`;
let transaction = false;

try {
  await client.connect();
  await client.query('BEGIN');
  transaction = true;
  await client.query(`CREATE SCHEMA ${quotedSchema}`);
  await client.query(`SET LOCAL search_path TO ${quotedSchema}, public`);
  await client.query(fs.readFileSync(path.join(root, 'schema.sql'), 'utf8'));
  await client.query('CREATE TABLE unrelated_constraint_name_collision (id integer)');
  await client.query('ALTER TABLE unrelated_constraint_name_collision ADD CONSTRAINT product_categories_subdepartment_fk CHECK (id IS NULL OR id > 0)');

  const migrations = fs.readdirSync(path.join(root, 'migrations'))
    .filter((file) => file.endsWith('.sql') && Number(file.slice(0, 3)) <= 76)
    .sort();
  for (const file of migrations) {
    await client.query(fs.readFileSync(path.join(root, 'migrations', file), 'utf8'));
  }

  // Restore the warehouse numeric scales that a real pre-055 database had.
  await client.query('ALTER TABLE stock_movements ALTER COLUMN quantity TYPE numeric(12,3)');
  await client.query('ALTER TABLE recipe_items ALTER COLUMN quantity TYPE numeric(12,3)');
  await client.query('ALTER TABLE ingredients ALTER COLUMN pack_multiplier TYPE numeric(12,3), ALTER COLUMN min_stock TYPE numeric(12,3)');
  await client.query('ALTER TABLE inventory_premix_batches ALTER COLUMN output_quantity TYPE numeric(12,3)');
  await client.query('ALTER TABLE inventory_purchase_document_lines ALTER COLUMN quantity TYPE numeric(14,3), ALTER COLUMN pack_multiplier TYPE numeric(14,6), ALTER COLUMN stock_quantity TYPE numeric(14,6)');

  // schema.sql describes a fresh install and includes the current product mode;
  // remove it here to model a real pre-049 database before loading legacy rows.
  await client.query('ALTER TABLE products DROP COLUMN IF EXISTS inventory_mode');

  const venue = (await client.query("INSERT INTO venues (name) VALUES ('Legacy migration QA') RETURNING id")).rows[0].id;
  const user = (await client.query(
    "INSERT INTO users (venue_id,full_name,login,role) VALUES ($1,'Legacy QA','legacy-qa-' || gen_random_uuid()::text,'owner') RETURNING id", [venue],
  )).rows[0].id;
  const openShift = (await client.query(
    'INSERT INTO shifts (venue_id,opened_by,opening_cash) VALUES ($1,$2,100) RETURNING id', [venue, user],
  )).rows[0].id;
  const closedShift = (await client.query(
    'INSERT INTO shifts (venue_id,opened_by,closed_at,opening_cash,closing_cash) VALUES ($1,$2,now(),100,125) RETURNING id', [venue, user],
  )).rows[0].id;
  const order = (await client.query(
    'INSERT INTO orders (venue_id,opened_by,closed_at,status) VALUES ($1,$2,now(),\'closed\') RETURNING id', [venue, user],
  )).rows[0].id;
  const oldPayment = (await client.query(
    "INSERT INTO payments (order_id,method,amount,status) VALUES ($1,'cash',25,'paid') RETURNING id", [order],
  )).rows[0].id;
  const rule = (await client.query(
    "INSERT INTO payroll_rules (venue_id,name,rule_type,rate) VALUES ($1,'Legacy hourly','hourly',100) RETURNING id", [venue],
  )).rows[0].id;
  const legacyPayrollIds = (await client.query(
    "INSERT INTO payroll_entries (venue_id,user_id,rule_id,period_from,period_to,amount,status) VALUES ($1,$2,$3,'2026-08-01','2026-08-15',1500,'draft'),($1,$2,$3,'2026-08-16','2026-08-31',1600,'approved') RETURNING id,status,amount",
    [venue, user, rule],
  )).rows;
  const oldExpense = (await client.query(
    "INSERT INTO expenses (venue_id,category,amount,expense_date,source) VALUES ($1,'purchase',250,'2026-08-02','purchase') RETURNING id", [venue],
  )).rows[0].id;
  const oldDocument = (await client.query(
    "INSERT INTO inventory_purchase_documents (venue_id,supplier_name,document_number,document_date,status) VALUES ($1,'Legacy supplier','LEGACY-1','2026-08-01','posted') RETURNING id", [venue],
  )).rows[0].id;
  const linkedProduct = (await client.query("INSERT INTO products (venue_id,name,category) VALUES ($1,'Legacy linked card','bar') RETURNING id", [venue])).rows[0].id;
  const unboundProduct = (await client.query("INSERT INTO products (venue_id,name,category) VALUES ($1,'Legacy unbound card','bar') RETURNING id", [venue])).rows[0].id;
  const legacyRecipeProduct = (await client.query("INSERT INTO products (venue_id,name,category) VALUES ($1,'Legacy recipe table','bar') RETURNING id", [venue])).rows[0].id;
  const emptyLegacyRecipeProduct = (await client.query("INSERT INTO products (venue_id,name,category) VALUES ($1,'Legacy empty recipe','bar') RETURNING id", [venue])).rows[0].id;
  const duplicateGenericA = (await client.query("INSERT INTO products (venue_id,name,category) VALUES ($1,'Legacy duplicate generic','bar') RETURNING id", [venue])).rows[0].id;
  const duplicateGenericB = (await client.query("INSERT INTO products (venue_id,name,category) VALUES ($1,'Legacy duplicate generic','bar') RETURNING id", [venue])).rows[0].id;
  const duplicateDirectProduct = (await client.query("INSERT INTO products (venue_id,name,category) VALUES ($1,'Legacy duplicate direct','bar') RETURNING id", [venue])).rows[0].id;
  const reviewProduct = (await client.query("INSERT INTO products (venue_id,name,category) VALUES ($1,'Legacy unclassified','bar') RETURNING id", [venue])).rows[0].id;
  const recipeIngredient = (await client.query("INSERT INTO ingredients (venue_id,name,unit) VALUES ($1,'Legacy recipe QA ingredient','мл') RETURNING id,name", [venue])).rows[0];
  const validCardIngredients = JSON.stringify([{ ingredientId: recipeIngredient.id, name: recipeIngredient.name, quantity: '1 мл', unit: 'мл' }]);
  await client.query("INSERT INTO inventory_recipe_cards (venue_id,product_id,name,ingredients,recipe_type) VALUES ($1,$2,'Legacy linked card',$3::jsonb,'sale'),($1,NULL,'Legacy unbound card',$3::jsonb,'sale'),($1,NULL,'Legacy duplicate generic',$3::jsonb,'sale'),($1,$4,'Legacy duplicate direct',$3::jsonb,'sale'),($1,$4,'Legacy duplicate direct second',$3::jsonb,'sale')", [venue, linkedProduct, validCardIngredients, duplicateDirectProduct]);
  await client.query('INSERT INTO recipes (product_id) VALUES ($1)', [legacyRecipeProduct]);
  await client.query('INSERT INTO recipe_items (product_id,ingredient_id,quantity) VALUES ($1,$2,1)', [legacyRecipeProduct, recipeIngredient.id]);
  await client.query('INSERT INTO recipes (product_id) VALUES ($1)', [emptyLegacyRecipeProduct]);
  const certainSubdepartment = (await client.query("INSERT INTO inventory_subdepartments (venue_id,department_code,name) VALUES ($1,'bar','Certain legacy subdepartment') RETURNING id", [venue])).rows[0].id;
  await client.query("INSERT INTO product_categories (venue_id,name,department) VALUES ($1,'Certain legacy category','bar')", [venue]);
  await client.query("INSERT INTO ingredients (venue_id,name,category,department,subdepartment,unit,cost,is_marked) VALUES ($1,'Certain legacy item 1','Certain legacy category','bar','Certain legacy subdepartment','ml',0,true),($1,'Certain legacy item 2','Certain legacy category','bar','Certain legacy subdepartment','ml',0,true)", [venue]);
  await client.query("INSERT INTO inventory_subdepartments (venue_id,department_code,name) VALUES ($1,'bar','Ambiguous legacy subdepartment')", [venue]);
  await client.query("INSERT INTO product_categories (venue_id,name,department) VALUES ($1,'Ambiguous legacy category','bar')", [venue]);
  await client.query("INSERT INTO ingredients (venue_id,name,category,department,subdepartment,unit,cost,is_marked) VALUES ($1,'Ambiguous legacy item 1','Ambiguous legacy category','bar','Certain legacy subdepartment','ml',0,true),($1,'Ambiguous legacy item 2','Ambiguous legacy category','bar','Ambiguous legacy subdepartment','ml',0,true)", [venue]);

  const latest = fs.readdirSync(path.join(root, 'migrations'))
    .filter((file) => file.endsWith('.sql') && Number(file.slice(0, 3)) >= 39)
    .sort();
  // These synthetic legacy rows model already-committed data from earlier app versions.
  // Flush any deferrable fixture checks before running DDL migrations in this transaction.
  await client.query('SET CONSTRAINTS ALL IMMEDIATE');
  for (const file of latest) {
    await client.query(fs.readFileSync(path.join(root, 'migrations', file), 'utf8'));
  }

  const precisionColumns = await client.query(`SELECT table_name,column_name,numeric_precision,numeric_scale
    FROM information_schema.columns
    WHERE table_schema=$1 AND (table_name,column_name) IN (
      ('stock_movements','quantity'),('recipe_items','quantity'),('ingredients','pack_multiplier'),
      ('ingredients','min_stock'),('inventory_premix_batches','output_quantity'),
      ('inventory_purchase_document_lines','quantity'),('inventory_purchase_document_lines','pack_multiplier'),
      ('inventory_purchase_document_lines','stock_quantity'))`, [schema]);
  assert.equal(precisionColumns.rowCount, 8, 'upgrade schema contains every six-decimal stock quantity column');
  const precisionByColumn = new Map(precisionColumns.rows.map((column) => [`${column.table_name}.${column.column_name}`, column]));
  for (const column of precisionColumns.rows.filter((entry) => entry.table_name !== 'inventory_purchase_document_lines' || entry.column_name !== 'quantity')) {
    assert.equal(Number(column.numeric_precision), 15, `${column.table_name}.${column.column_name} keeps its previous integer range`);
    assert.equal(Number(column.numeric_scale), 6, `${column.table_name}.${column.column_name} retains six decimal places`);
  }
  assert.equal(Number(precisionByColumn.get('inventory_purchase_document_lines.quantity')?.numeric_precision), 17,
    'purchase line quantity keeps all 11 previous integer digits and gains six decimal places');
  assert.equal(Number(precisionByColumn.get('inventory_purchase_document_lines.quantity')?.numeric_scale), 6);
  assert.equal((await client.query('UPDATE recipe_items SET quantity=0.0006 WHERE product_id=$1 AND ingredient_id=$2 RETURNING quantity', [legacyRecipeProduct, recipeIngredient.id])).rows[0].quantity, '0.000600',
    'legacy recipe quantities accept and preserve six decimal places after upgrade');

  const payment = await client.query('SELECT shift_id FROM payments WHERE id=$1', [oldPayment]);
  assert.equal(payment.rows[0].shift_id, null, '039 preserves unknown historical shift attribution rather than guessing');
  assert.equal((await client.query('SELECT id FROM shifts WHERE id=$1 AND closed_at IS NULL', [openShift])).rowCount, 1);
  assert.equal((await client.query('SELECT id FROM shifts WHERE id=$1 AND closed_at IS NOT NULL', [closedShift])).rowCount, 1);
  const payrollAfter = (await client.query('SELECT id,status,amount FROM payroll_entries ORDER BY period_from')).rows;
  assert.deepEqual(payrollAfter, legacyPayrollIds, '040 preserves legacy payroll status and amount');
  assert.equal((await client.query('SELECT id FROM expenses WHERE id=$1 AND source=\'purchase\'', [oldExpense])).rowCount, 1);
  assert.equal((await client.query('SELECT category_id FROM expenses WHERE id=$1', [oldExpense])).rows[0].category_id, null,
    '044 preserves legacy expense category labels rather than guessing category identities');
  assert.equal((await client.query('SELECT id FROM inventory_purchase_documents WHERE id=$1 AND status=\'posted\'', [oldDocument])).rowCount, 1);
  assert.equal((await client.query('SELECT subdepartment_id FROM product_categories WHERE venue_id=$1 AND name=\'Certain legacy category\'', [venue])).rows[0].subdepartment_id, certainSubdepartment,
    'migration 048 backfills a legacy category only where all of its items agree on one subdepartment');
  assert.equal((await client.query('SELECT subdepartment_id FROM product_categories WHERE venue_id=$1 AND name=\'Ambiguous legacy category\'', [venue])).rows[0].subdepartment_id, null,
    'migration 048 leaves ambiguous legacy category assignments untouched');
  assert.equal((await client.query("SELECT COUNT(*)::int AS count FROM pg_constraint WHERE conname='product_categories_subdepartment_fk' AND conrelid='product_categories'::regclass")).rows[0].count, 1,
    'migration 048 creates its category FK even when another table has a constraint with the same name');
  const undatedDocument = (await client.query("INSERT INTO inventory_purchase_documents (venue_id,supplier_name,status) VALUES ($1,'Undated legacy supplier','draft') RETURNING document_date,recorded_at", [venue])).rows[0];
  assert.equal(undatedDocument.document_date, null, 'migration 047 permits a true NULL supplier document date');
  assert.ok(undatedDocument.recorded_at, 'the system receipt timestamp remains independent of an unknown supplier date');
  const productModes = await client.query('SELECT id,inventory_mode FROM products WHERE id=ANY($1::uuid[])', [[linkedProduct,unboundProduct,legacyRecipeProduct,emptyLegacyRecipeProduct,duplicateGenericA,duplicateGenericB,duplicateDirectProduct,reviewProduct]]);
  const modeById = new Map(productModes.rows.map((row) => [row.id, row.inventory_mode]));
  assert.equal(modeById.get(linkedProduct), 'tracked', '049 classifies a product with a directly bound sale card as tracked');
  assert.equal(modeById.get(unboundProduct), 'tracked', '049 classifies one unique unbound legacy card by exact name');
  assert.equal(modeById.get(legacyRecipeProduct), 'tracked', '049 preserves a legacy recipe with a valid same-venue component as tracked');
  assert.equal(modeById.get(emptyLegacyRecipeProduct), 'needs_review', '049 does not treat an empty legacy recipe header as usable stock accounting');
  assert.equal(modeById.get(duplicateGenericA), 'needs_review', '049 leaves one unbound card ambiguous when same-name products exist');
  assert.equal(modeById.get(duplicateGenericB), 'needs_review', '049 leaves every duplicate-name product ambiguous');
  assert.equal(modeById.get(duplicateDirectProduct), 'needs_review', '049 leaves products with multiple active direct cards for review');
  assert.equal(modeById.get(reviewProduct), 'needs_review', '049 never guesses that an unlinked legacy product is a service');

  for (const file of latest) {
    await client.query(fs.readFileSync(path.join(root, 'migrations', file), 'utf8'));
  }
  assert.deepEqual((await client.query('SELECT id,status,amount FROM payroll_entries ORDER BY period_from')).rows,
    legacyPayrollIds, 'replaying latest migrations preserves legacy payroll');

  const loyaltyVenue = (await client.query("INSERT INTO venues (name) VALUES ('Loyalty immutability QA') RETURNING id")).rows[0].id;
  const siblingVenue = (await client.query("INSERT INTO venues (name) VALUES ('Loyalty immutability survivor QA') RETURNING id")).rows[0].id;
  const loyaltyUser = (await client.query(
    "INSERT INTO users (venue_id,full_name,login,role) VALUES ($1,'Loyalty immutable QA','loyalty-immutable-' || gen_random_uuid(),'owner') RETURNING id", [loyaltyVenue],
  )).rows[0].id;
  const loyaltyProduct = (await client.query(
    "INSERT INTO products (venue_id,name,category,sale_price) VALUES ($1,'Loyalty immutable QA product','qa',10) RETURNING id", [loyaltyVenue],
  )).rows[0].id;
  const promotionId = (await client.query(
    `INSERT INTO loyalty_promotions (venue_id,version,name,status,starts_at,ends_at,timezone,benefit_kind,benefit_value,created_by)
     VALUES ($1,1,'Immutable QA campaign','draft','2030-01-01T00:00:00Z','2030-01-02T00:00:00Z','UTC','percent',10,$2) RETURNING promotion_id`, [loyaltyVenue, loyaltyUser],
  )).rows[0].promotion_id;
  const settingId = (await client.query(
    'INSERT INTO loyalty_program_settings (venue_id,version,created_by) VALUES ($1,1,$2) RETURNING id', [loyaltyVenue, loyaltyUser],
  )).rows[0].id;
  const scopeId = (await client.query(
    `INSERT INTO loyalty_promotion_scopes (venue_id,promotion_id,version,scope_kind,product_id)
     VALUES ($1,$2,1,'include_product',$3) RETURNING id`, [loyaltyVenue, promotionId, loyaltyProduct],
  )).rows[0].id;
  const snapshotOrderId = (await client.query(
    `INSERT INTO orders (venue_id,opened_by,status,selected_promotion_id,selected_promotion_version,
       selected_promotion_name,selected_promotion_benefit_kind,selected_promotion_benefit_value,
       selected_promotion_basis,selected_promotion_amount,effective_discount_source)
     VALUES ($1,$2,'open',$3,1,'Immutable QA campaign','percent',10,100,10,'promotion') RETURNING id`,
    [loyaltyVenue, loyaltyUser, promotionId],
  )).rows[0].id;
  await client.query(
    `INSERT INTO loyalty_promotions (venue_id,promotion_id,version,name,status,starts_at,ends_at,timezone,benefit_kind,benefit_value)
     VALUES ($1,$2,2,'Immutable QA campaign v2','draft','2030-01-01T00:00:00Z','2030-01-02T00:00:00Z','UTC','percent',12)`,
    [loyaltyVenue, promotionId],
  );
  const historicSnapshot = await client.query(`SELECT o.selected_promotion_version,p.name,p.benefit_value
    FROM orders o JOIN loyalty_promotions p
      ON p.venue_id=o.venue_id AND p.promotion_id=o.selected_promotion_id AND p.version=o.selected_promotion_version
    WHERE o.id=$1`, [snapshotOrderId]);
  assert.deepEqual(historicSnapshot.rows.map((row) => [row.selected_promotion_version,row.name,Number(row.benefit_value)]),
    [[1,'Immutable QA campaign',10]], 'order snapshot continues to resolve its exact promotion version after a newer version is added');
  const orderPromotionFk = (await client.query(`SELECT condeferrable,confdeltype
    FROM pg_constraint WHERE conrelid='orders'::regclass AND conname='orders_selected_promotion_version_fk'`)).rows[0];
  assert.deepEqual(orderPromotionFk, { condeferrable: false, confdeltype: 'r' },
    'order snapshot retains its immediate promotion-version RESTRICT reference');
  await client.query('INSERT INTO loyalty_program_settings (venue_id,version) VALUES ($1,1)', [siblingVenue]);

  let expectedFailureIndex = 0;
  const assertSqlFailure = async (query, params, expectedCode, label) => {
    const savepoint = `loyalty_expected_failure_${expectedFailureIndex++}`;
    await client.query(`SAVEPOINT ${savepoint}`);
    await assert.rejects(client.query(query, params), (error) => error.code === expectedCode, label);
    await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    await client.query(`RELEASE SAVEPOINT ${savepoint}`);
  };
  await client.query('SAVEPOINT loyalty_temp_venues_shadow');
  // The actual fixture venue must NOT exist in the shadow relation: the old
  // unqualified lookup would then incorrectly treat its DELETE as a cascade.
  await client.query('CREATE TEMP TABLE venues (id uuid)');
  await assertSqlFailure('DELETE FROM loyalty_program_settings WHERE id=$1', [settingId], '55000',
    'temporary venues table cannot shadow the owning venue check');
  await client.query('ROLLBACK TO SAVEPOINT loyalty_temp_venues_shadow');
  await client.query('RELEASE SAVEPOINT loyalty_temp_venues_shadow');

  for (const [query, params, label] of [
    ['UPDATE loyalty_program_settings SET max_redemption_percent=max_redemption_percent WHERE id=$1', [settingId], 'settings no-op UPDATE'],
    ['DELETE FROM loyalty_program_settings WHERE id=$1', [settingId], 'direct settings DELETE'],
    ['UPDATE loyalty_promotions SET name=name WHERE venue_id=$1 AND promotion_id=$2 AND version=1', [loyaltyVenue, promotionId], 'promotion no-op UPDATE'],
    ['DELETE FROM loyalty_promotions WHERE venue_id=$1 AND promotion_id=$2 AND version=1', [loyaltyVenue, promotionId], 'direct promotion DELETE'],
    ['UPDATE loyalty_promotion_scopes SET scope_kind=scope_kind WHERE id=$1', [scopeId], 'scope no-op UPDATE'],
    ['DELETE FROM loyalty_promotion_scopes WHERE id=$1', [scopeId], 'direct scope DELETE'],
  ]) {
    await assertSqlFailure(query, params, '55000', `${label} is rejected by the database guard`);
  }
  await client.query('UPDATE users SET deleted_at=now() WHERE id=$1', [loyaltyUser]);
  await assertSqlFailure('DELETE FROM users WHERE id=$1', [loyaltyUser], '23503',
    'hard deletion preserves immutable creator attribution');

  const scopeProductFk = (await client.query(`SELECT condeferrable,condeferred,confdeltype
    FROM pg_constraint WHERE conrelid='loyalty_promotion_scopes'::regclass
      AND conname='loyalty_promotion_scopes_venue_id_product_id_fkey'`)).rows[0];
  assert.deepEqual(scopeProductFk, { condeferrable: true, condeferred: true, confdeltype: 'a' },
    'product scope FK remains tenant-scoped and deferred NO ACTION');
  await client.query('SAVEPOINT loyalty_scope_fk_check');
  await client.query('SET CONSTRAINTS loyalty_promotion_scopes_venue_id_product_id_fkey IMMEDIATE');
  await assertSqlFailure('DELETE FROM products WHERE id=$1', [loyaltyProduct], '23503',
    'standalone deletion of a scoped product remains blocked');
  await client.query('ROLLBACK TO SAVEPOINT loyalty_scope_fk_check');
  await client.query('RELEASE SAVEPOINT loyalty_scope_fk_check');

  await client.query('SAVEPOINT loyalty_venue_cascade');
  await client.query('SET CONSTRAINTS loyalty_promotion_scopes_venue_id_product_id_fkey DEFERRED');
  await client.query('UPDATE users SET venue_id=NULL WHERE id=$1', [loyaltyUser]);
  await client.query('DELETE FROM orders WHERE id=$1', [snapshotOrderId]);
  await client.query('DELETE FROM products WHERE id=$1', [loyaltyProduct]);
  await client.query('DELETE FROM venues WHERE id=$1', [loyaltyVenue]);
  await client.query('SET CONSTRAINTS loyalty_promotion_scopes_venue_id_product_id_fkey IMMEDIATE');
  await client.query('RELEASE SAVEPOINT loyalty_venue_cascade');
  assert.equal((await client.query('SELECT count(*)::int AS count FROM loyalty_program_settings WHERE id=$1', [settingId])).rows[0].count,
    0, 'venue cascade removes settings with immutable triggers enabled');
  assert.equal((await client.query('SELECT count(*)::int AS count FROM loyalty_promotions WHERE venue_id=$1', [loyaltyVenue])).rows[0].count,
    0, 'venue cascade removes promotion history with immutable triggers enabled');
  assert.equal((await client.query('SELECT count(*)::int AS count FROM loyalty_promotion_scopes WHERE id=$1', [scopeId])).rows[0].count,
    0, 'venue cascade removes promotion scopes with immutable triggers enabled');
  assert.equal((await client.query('SELECT count(*)::int AS count FROM loyalty_program_settings WHERE venue_id=$1', [siblingVenue])).rows[0].count,
    1, 'venue cascade leaves sibling venue settings untouched');
  assert.equal((await client.query('DELETE FROM users WHERE id=$1 RETURNING id', [loyaltyUser])).rowCount,
    1, 'creator can be hard-deleted after the venue-owned history has been purged');
  assert.equal((await client.query(`SELECT count(*)::int AS count FROM pg_trigger t
    JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=current_schema()
      AND t.tgname IN ('loyalty_program_settings_immutable','loyalty_promotions_immutable','loyalty_promotion_scopes_immutable')
      AND t.tgenabled='O'`)).rows[0].count, 3, 'all immutable-history triggers remain enabled after QA cascade');
  assert.equal((await client.query("SELECT to_regprocedure('reject_loyalty_promotion_history_mutation()') IS NULL AS dropped")).rows[0].dropped,
    true, 'the replaced pre-076 trigger function is removed');

  console.log(`MIGRATIONS PG UPGRADE QA: PASS (${migrations.length} baseline migrations + ${latest.length} new migrations; legacy records preserved; six-decimal warehouse and recipe quantities verified; 076 immutability, actor retention and venue cascade verified; latest migrations replayed; schema rolled back)`);
} finally {
  if (transaction) await client.query('ROLLBACK').catch(() => {});
  if (client._connected) await client.end();
}
