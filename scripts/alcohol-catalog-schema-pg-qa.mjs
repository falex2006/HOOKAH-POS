import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const databaseUrl = process.env.MIGRATIONS_PG_TEST_DATABASE_URL;
if (!databaseUrl) {
  console.log('ALCOHOL CATALOG PG QA: SKIP (MIGRATIONS_PG_TEST_DATABASE_URL is not set)');
  process.exit(0);
}
assert.match(new URL(databaseUrl).pathname, /(?:test|qa|scratch)/i,
  'refusing test writes unless the database name clearly identifies a test/QA/scratch database');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { Client } = require('pg');
const client = new Client({ connectionString: databaseUrl });
const schemaName = `alcohol_catalog_qa_${process.pid}_${Date.now()}`;
const qSchema = `"${schemaName}"`;

const rejects = async (sql, values, code, label) => {
  await client.query('SAVEPOINT alcohol_expected_rejection');
  let caught = null;
  try { await client.query(sql, values); } catch (error) { caught = error; }
  await client.query('ROLLBACK TO SAVEPOINT alcohol_expected_rejection');
  await client.query('RELEASE SAVEPOINT alcohol_expected_rejection');
  assert.ok(caught, `${label}: query should fail`);
  assert.equal(caught.code, code, label);
};

try {
  await client.connect();
  await client.query('BEGIN');
  await client.query(`CREATE SCHEMA ${qSchema}`);
  await client.query(`SET LOCAL search_path TO ${qSchema}, public`);
  await client.query(fs.readFileSync(path.join(root, 'schema.sql'), 'utf8'));

  // Replay the currently shipped upgrades in an isolated schema, then model a
  // pre-094 database by removing only the catalog-specific structures.
  // These eight constraints are deliberately re-created by their owning
  // migrations and are therefore removed from the fresh-schema snapshot first.
  await client.query(`
    ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_loyalty_redemption_snapshot_check;
    ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_effective_discount_source_check;
    ALTER TABLE payroll_daily_snapshots DROP CONSTRAINT IF EXISTS payroll_daily_snapshots_typed_check;
    ALTER TABLE payroll_daily_snapshot_lines DROP CONSTRAINT IF EXISTS payroll_daily_snapshot_lines_typed_check;
    ALTER TABLE payroll_daily_snapshot_lines DROP CONSTRAINT IF EXISTS payroll_snapshot_line_team_pool_fk;
    ALTER TABLE payroll_calculation_runs DROP CONSTRAINT IF EXISTS payroll_runs_milestone_version_check;
    ALTER TABLE payroll_employee_overrides DROP CONSTRAINT IF EXISTS payroll_employee_overrides_parameter_path_check;
    ALTER TABLE order_refunds DROP CONSTRAINT IF EXISTS order_refunds_item_attribution_status_check;
  `);
  const migrations = fs.readdirSync(path.join(root, 'migrations'))
    .filter((name) => /^\d{3}_.*\.sql$/.test(name) && Number(name.slice(0, 3)) <= 93)
    .sort();
  assert.ok(migrations.length > 0, 'existing migrations 001-093 must be present');
  for (const name of migrations) {
    await client.query(fs.readFileSync(path.join(root, 'migrations', name), 'utf8'));
  }

  await client.query(`
    DROP TRIGGER IF EXISTS ingredients_alcohol_catalog_link_guard ON ingredients;
    DROP TRIGGER IF EXISTS alcohol_catalog_items_identity_guard ON alcohol_catalog_items;
    DROP FUNCTION IF EXISTS guard_ingredient_alcohol_catalog_link();
    DROP FUNCTION IF EXISTS guard_alcohol_catalog_item_identity();
    ALTER TABLE ingredients DROP CONSTRAINT IF EXISTS ingredients_alcohol_catalog_org_fk;
    ALTER TABLE ingredients DROP CONSTRAINT IF EXISTS ingredients_venue_organization_fk;
    ALTER TABLE ingredients DROP COLUMN IF EXISTS alcohol_catalog_item_id;
    ALTER TABLE ingredients DROP COLUMN IF EXISTS organization_id;
    DROP TABLE alcohol_catalog_items;
  `);

  const orgA = (await client.query("INSERT INTO organizations (name,slug) VALUES ('Alcohol QA A','alcohol-qa-a') RETURNING id")).rows[0].id;
  const orgB = (await client.query("INSERT INTO organizations (name,slug) VALUES ('Alcohol QA B','alcohol-qa-b') RETURNING id")).rows[0].id;
  const venue = async (org, name) => (await client.query(
    'INSERT INTO venues (name,organization_id) VALUES ($1,$2) RETURNING id', [name,org])).rows[0].id;
  const venueA1 = await venue(orgA, 'Alcohol QA A1');
  const venueA2 = await venue(orgA, 'Alcohol QA A2');
  const venueB = await venue(orgB, 'Alcohol QA B');
  const legacyIngredient = (await client.query(
    "INSERT INTO ingredients (venue_id,name,unit) VALUES ($1,'Legacy spirit','ml') RETURNING id", [venueA1])).rows[0].id;

  const unassignedVenue = (await client.query("INSERT INTO venues (name) VALUES ('Alcohol QA no organization') RETURNING id")).rows[0].id;
  await client.query("INSERT INTO ingredients (venue_id,name,unit) VALUES ($1,'Unassigned legacy','ml')", [unassignedVenue]);
  await client.query('SAVEPOINT alcohol_missing_org_migration');
  let missingOrgError = null;
  try {
    await client.query(fs.readFileSync(path.join(root, 'migrations', '094_alcohol_catalog.sql'), 'utf8'));
  } catch (error) { missingOrgError = error; }
  assert.ok(missingOrgError, 'migration must fail when an ingredient venue has no organization');
  assert.match(missingOrgError.message, /every ingredient venue must have an organization_id/,
    'migration explains how legacy organization backfill failed');
  await client.query('ROLLBACK TO SAVEPOINT alcohol_missing_org_migration');
  await client.query('RELEASE SAVEPOINT alcohol_missing_org_migration');
  await client.query("DELETE FROM ingredients WHERE venue_id=$1", [unassignedVenue]);
  await client.query('DELETE FROM venues WHERE id=$1', [unassignedVenue]);

  await client.query(fs.readFileSync(path.join(root, 'migrations', '094_alcohol_catalog.sql'), 'utf8'));
  const migratedLegacy = (await client.query(
    'SELECT organization_id,alcohol_catalog_item_id FROM ingredients WHERE id=$1', [legacyIngredient])).rows[0];
  assert.equal(migratedLegacy.organization_id, orgA, 'legacy ingredient organization is backfilled from its venue');
  assert.equal(migratedLegacy.alcohol_catalog_item_id, null, 'legacy ingredient remains unlinked');

  const sharedItem = (await client.query(`INSERT INTO alcohol_catalog_items
    (organization_id,brand,name,spirit_type,abv,bottle_ml)
    VALUES ($1,'QA Brand','Shared whiskey','whisky',40,700) RETURNING id`, [orgA])).rows[0].id;
  const localItem = (await client.query(`INSERT INTO alcohol_catalog_items
    (organization_id,scope,venue_id,brand,name,spirit_type)
    VALUES ($1,'venue',$2,'QA Local','Local gin','gin') RETURNING id`, [orgA,venueA1])).rows[0].id;
  const foreignItem = (await client.query(`INSERT INTO alcohol_catalog_items
    (organization_id,brand,name,spirit_type)
    VALUES ($1,'QA Foreign','Foreign vodka','vodka') RETURNING id`, [orgB])).rows[0].id;

  const sharedLinked = (await client.query(`INSERT INTO ingredients
    (venue_id,name,unit,alcohol_catalog_item_id) VALUES ($1,'Shared stock','ml',$2) RETURNING organization_id`, [venueA2,sharedItem])).rows[0];
  assert.equal(sharedLinked.organization_id, orgA, 'organization catalog item is shared across organization venues');
  const localLinked = (await client.query(`INSERT INTO ingredients
    (venue_id,name,unit,alcohol_catalog_item_id) VALUES ($1,'Local stock','ml',$2) RETURNING id`, [venueA1,localItem])).rows[0].id;
  await rejects(`INSERT INTO ingredients (venue_id,name,unit,alcohol_catalog_item_id)
    VALUES ($1,'Wrong organization','ml',$2)`, [venueA1,foreignItem], '23514', 'cross-organization item rejected');
  await rejects(`INSERT INTO ingredients (venue_id,name,unit,alcohol_catalog_item_id)
    VALUES ($1,'Wrong local venue','ml',$2)`, [venueA2,localItem], '23514', 'venue-local item rejected at another venue');
  await rejects('UPDATE ingredients SET venue_id=$1 WHERE id=$2', [venueA2,localLinked], '23514', 'linked ingredient venue reassignment rejected');
  await rejects('UPDATE alcohol_catalog_items SET venue_id=$1 WHERE id=$2', [venueA2,localItem], '23514', 'catalog scope identity is immutable');

  await client.query("UPDATE alcohol_catalog_items SET is_active=false WHERE id=$1", [sharedItem]);
  const archivedLink = (await client.query(`SELECT i.alcohol_catalog_item_id,c.is_active,c.archived_at
    FROM ingredients i JOIN alcohol_catalog_items c ON c.id=i.alcohol_catalog_item_id WHERE i.venue_id=$1 AND i.name='Shared stock'`, [venueA2])).rows[0];
  assert.equal(archivedLink.alcohol_catalog_item_id, sharedItem, 'archive preserves existing ingredient link');
  assert.equal(archivedLink.is_active, false, 'catalog item can be soft archived');
  assert.ok(archivedLink.archived_at, 'archive timestamp is captured automatically');
  await rejects('UPDATE ingredients SET alcohol_catalog_item_id=$1 WHERE id=$2', [sharedItem,legacyIngredient], '23514', 'archived item cannot be newly linked');
  await client.query("UPDATE ingredients SET name='Archived link remains readable' WHERE venue_id=$1 AND name='Shared stock'", [venueA2]);
  assert.equal((await client.query('SELECT alcohol_catalog_item_id FROM ingredients WHERE venue_id=$1 AND name=$2', [venueA2,'Archived link remains readable'])).rows[0].alcohol_catalog_item_id,
    sharedItem, 'existing archived catalog link remains readable during ingredient updates');
  await rejects('DELETE FROM alcohol_catalog_items WHERE id=$1', [sharedItem], '55000', 'catalog hard delete rejected');
  await rejects('DELETE FROM alcohol_catalog_items WHERE id=$1', [localItem], '55000', 'unlinked catalog hard delete rejected');

  console.log(`ALCOHOL CATALOG PG QA: PASS (migration 001-093 replay, legacy backfill, org/venue scope, reassignment, archive, nullable links)`);
} finally {
  await client.query('ROLLBACK').catch(() => {});
  await client.end().catch(() => {});
}
