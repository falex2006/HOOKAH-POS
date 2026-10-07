import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { validateQaDatabaseUrl } from './postgres-qa-safety.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = validateQaDatabaseUrl(process.env.MIGRATIONS_PG_TEST_DATABASE_URL, 'inventory category/tobacco migration QA URL');
assert.match(target.database, /^inventory_qa_[a-f0-9]+$/i, 'only this runner-owned disposable QA database is allowed');
const client = new pg.Client({ connectionString: target.url.href });
let checks = 0;
async function expectSqlFailure(sql, values, code) {
  await client.query('SAVEPOINT expected_failure');
  try {
    await client.query(sql, values);
    assert.fail(`expected SQLSTATE ${code}`);
  } catch (error) { assert.equal(error.code, code); }
  await client.query('ROLLBACK TO SAVEPOINT expected_failure');
  await client.query('RELEASE SAVEPOINT expected_failure');
  checks++;
}
try {
  await client.connect();
  const migration = fs.readFileSync(path.join(root, 'migrations/095_inventory_categories_tobacco.sql'), 'utf8');
  const fixtureVenue = randomUUID(); const fixtureOrg = randomUUID();
  await client.query('BEGIN');
  await client.query('INSERT INTO organizations(id,name,slug) VALUES($1,$2,$3)', [fixtureOrg, 'Inventory category QA', `inventory-qa-${fixtureOrg}`]);
  await client.query('INSERT INTO venues(id,name,organization_id) VALUES($1,$2,$3)', [fixtureVenue, 'Inventory category QA', fixtureOrg]);
  const exactCategory = (await client.query("INSERT INTO product_categories(venue_id,name,department) VALUES($1,'Legacy Exact','bar') RETURNING id", [fixtureVenue])).rows[0].id;
  const ambiguousActive = randomUUID(); const ambiguousArchived = randomUUID();
  await client.query("INSERT INTO product_categories(id,venue_id,name,department,is_active) VALUES($1,$2,'Legacy Ambiguous','bar',true),($3,$2,'legacy ambiguous','bar',false)", [ambiguousActive, fixtureVenue, ambiguousArchived]);
  const legacyIds = [randomUUID(), randomUUID(), randomUUID()];
  for (const [id, category] of [[legacyIds[0], 'Legacy Exact'], [legacyIds[1], 'Legacy Ambiguous'], [legacyIds[2], 'Legacy Missing']]) {
    await client.query('INSERT INTO ingredients(id,venue_id,organization_id,name,department,category,unit,is_marked) VALUES($1,$2,$3,$4,\'bar\',$5,\'шт\',true)', [id, fixtureVenue, fixtureOrg, `Legacy ${id}`, category]);
  }
  await client.query(migration);
  await client.query(migration); // Replay must preserve seed state and user edits.
  const backfill = await client.query('SELECT id,category,category_id AS "categoryId" FROM ingredients WHERE id=ANY($1::uuid[]) ORDER BY id', [legacyIds]);
  const exactRow = backfill.rows.find((row) => row.id === legacyIds[0]);
  const ambiguousRow = backfill.rows.find((row) => row.id === legacyIds[1]);
  const unmatchedRow = backfill.rows.find((row) => row.id === legacyIds[2]);
  assert.equal(exactRow.categoryId, exactCategory); assert.equal(exactRow.category, 'Legacy Exact'); checks++;
  assert.equal(ambiguousRow.categoryId, null); assert.equal(ambiguousRow.category, 'Legacy Ambiguous'); checks++;
  assert.equal(unmatchedRow.categoryId, null); assert.equal(unmatchedRow.category, 'Legacy Missing'); checks++;
  let { rows } = await client.query('SELECT seed_key,category_id FROM inventory_category_seed_state WHERE venue_id=$1 ORDER BY seed_key', [fixtureVenue]);
  assert.equal(rows.length, 11); checks++;
  await client.query('SELECT ensure_inventory_category_defaults($1)', [fixtureVenue]);
  assert.equal((await client.query('SELECT count(*)::int AS count FROM product_categories WHERE venue_id=$1', [fixtureVenue])).rows[0].count, 14); checks++;
  const renamed = rows.find((row) => row.seed_key === 'hookah.tobacco');
  await client.query('UPDATE product_categories SET name=$1 WHERE venue_id=$2 AND id=$3', ['Табак переименованный', fixtureVenue, renamed.category_id]);
  await client.query('SELECT ensure_inventory_category_defaults($1)', [fixtureVenue]);
  assert.equal((await client.query('SELECT name FROM product_categories WHERE venue_id=$1 AND id=$2', [fixtureVenue, renamed.category_id])).rows[0].name, 'Табак переименованный'); checks++;
  const archived = rows.find((row) => row.seed_key === 'hookah.coal');
  await client.query('UPDATE product_categories SET is_active=false WHERE venue_id=$1 AND id=$2', [fixtureVenue, archived.category_id]);
  await client.query('SELECT ensure_inventory_category_defaults($1)', [fixtureVenue]);
  assert.equal((await client.query('SELECT is_active FROM product_categories WHERE venue_id=$1 AND id=$2', [fixtureVenue, archived.category_id])).rows[0].is_active, false); checks++;
  const deleted = rows.find((row) => row.seed_key === 'hookah.flasks');
  await client.query('DELETE FROM product_categories WHERE venue_id=$1 AND id=$2', [fixtureVenue, deleted.category_id]);
  await client.query('SELECT ensure_inventory_category_defaults($1)', [fixtureVenue]);
  assert.equal((await client.query('SELECT category_id FROM inventory_category_seed_state WHERE venue_id=$1 AND seed_key=$2', [fixtureVenue, 'hookah.flasks'])).rows[0].category_id, null); checks++;
  assert.equal((await client.query('SELECT count(*)::int AS count FROM product_categories WHERE venue_id=$1', [fixtureVenue])).rows[0].count, 13); checks++;
  const barCategory = rows.find((row) => row.seed_key === 'bar.water');
  const ingredientId = randomUUID();
  await client.query(`INSERT INTO ingredients(id,venue_id,organization_id,name,department,category,category_id,unit,purchase_unit,pack_multiplier,cost,is_marked)
    VALUES($1,$2,$3,'Тестовый табак','bar','Вода',$4,'г','пачка',100,1.2,true)`, [ingredientId, fixtureVenue, fixtureOrg, barCategory.category_id]);
  const persisted = await client.query('SELECT category_id,unit,purchase_unit,pack_multiplier,cost FROM ingredients WHERE id=$1', [ingredientId]);
  assert.equal(persisted.rows[0].category_id, barCategory.category_id); assert.equal(persisted.rows[0].unit, 'г'); assert.equal(persisted.rows[0].purchase_unit, 'пачка'); assert.equal(Number(persisted.rows[0].pack_multiplier), 100); assert.equal(Number(persisted.rows[0].cost), 1.2); checks++;
  const foreignVenue = randomUUID();
  await client.query('INSERT INTO venues(id,name,organization_id) VALUES($1,$2,$3)', [foreignVenue, 'Foreign inventory QA', fixtureOrg]);
  await expectSqlFailure(`INSERT INTO ingredients(venue_id,organization_id,name,department,category,category_id,unit)
    VALUES($1,$2,'Foreign category attempt','bar','Вода',$3,'шт')`, [foreignVenue, fixtureOrg, barCategory.category_id], '23503');
  const tobaccoId = randomUUID();
  await client.query(`INSERT INTO tobacco_catalog_items(id,organization_id,scope,venue_id,brand,flavor,product_type,package_grams,strength)
    VALUES($1,$2,'venue',$3,'QA Brand','QA Mint','tobacco',100,'средняя')`, [tobaccoId, fixtureOrg, fixtureVenue]);
  await client.query('UPDATE ingredients SET tobacco_catalog_item_id=$1 WHERE id=$2', [tobaccoId, ingredientId]);
  assert.equal((await client.query('SELECT tc.strength FROM ingredients i JOIN tobacco_catalog_items tc ON tc.id=i.tobacco_catalog_item_id WHERE i.id=$1', [ingredientId])).rows[0].strength, 'средняя'); checks++;
  const foreignIngredient = (await client.query("INSERT INTO ingredients(venue_id,organization_id,name,department,category,unit) VALUES($1,$2,'Foreign tobacco link','bar','QA','шт') RETURNING id", [foreignVenue, fixtureOrg])).rows[0].id;
  await expectSqlFailure('UPDATE ingredients SET tobacco_catalog_item_id=$1 WHERE id=$2', [tobaccoId, foreignIngredient], '23514');
  await client.query('ROLLBACK');
  process.stdout.write(`INVENTORY CATEGORY/Tobacco MIGRATION QA: PASS (${checks} checks; fixture transaction rolled back)\n`);
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  throw error;
} finally { await client.end(); }
