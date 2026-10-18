import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { assertQaDatabaseIdentity, validateQaDatabaseUrl } from './postgres-qa-safety.mjs';

const require = createRequire(import.meta.url);
const { Client } = require('pg');
const target = validateQaDatabaseUrl(process.env.MIGRATIONS_PG_TEST_DATABASE_URL);
const root = fileURLToPath(new URL('../', import.meta.url));
const migrationDir = path.join(root, 'migrations');
const migration115Path = path.join(migrationDir, '128_finance_pos_income_snapshot_integrity.sql');
const migration115 = readFileSync(migration115Path, 'utf8').replaceAll('\r', '');
const currentSchema = readFileSync(path.join(root, 'schema.sql'), 'utf8').replaceAll('\r', '');
assert.ok(currentSchema.trimEnd().endsWith(migration115.trimEnd()), 'fresh-install schema ends with migration 115');
const pre115Schema = currentSchema.slice(0, currentSchema.lastIndexOf(migration115));
assert.ok(pre115Schema.length > 0, 'pre-115 bootstrap schema is available');

const schemaName = `finance_income_upgrade_qa_${process.pid}_${Date.now()}`;
const replaySchemaName = `finance_migration_replay_qa_${process.pid}_${Date.now()}`;
const scopedUrl = new URL(target.url);
scopedUrl.searchParams.set('options', `-c search_path=${schemaName}`);
const admin = new Client({ connectionString: target.url.href });
let db;
let lockProbe;
let created = false;
let activeSchemaName = schemaName;

const insert = async (client, table, row) => {
  const fields = Object.keys(row);
  const values = fields.map((field) => {
    const value = row[field];
    return value && typeof value === 'object' && !Array.isArray(value) ? JSON.stringify(value) : value;
  });
  return (await client.query(
    `INSERT INTO ${table} (${fields.join(',')}) VALUES (${fields.map((_, index) => `$${index + 1}`).join(',')}) RETURNING id`,
    values,
  )).rows[0].id;
};

async function runMigrations(migrations, label) {
  await db.query('BEGIN');
  try {
    for (const file of migrations) await db.query(readFileSync(path.join(migrationDir, file), 'utf8'));
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {});
    error.message = `${label}: ${error.message}`;
    throw error;
  }
}

try {
  await admin.connect();
  const identity = (await admin.query(`
    SELECT current_database() AS database,inet_server_addr() AS address,inet_server_port() AS port,
      (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser
  `)).rows[0];
  assertQaDatabaseIdentity(identity, target.database, Number(target.url.port));
  await admin.query(`CREATE SCHEMA ${schemaName}`);
  created = true;
  await admin.query(`SET search_path TO ${schemaName}`);
  await admin.query(pre115Schema);
  db = new Client({ connectionString: scopedUrl.href });
  await db.connect();

  assert.equal((await db.query(`SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema=current_schema() AND table_name='pos_order_income_category_snapshots'
      AND column_name='venue_timezone_snapshot'
  ) AS present`)).rows[0].present, false, 'baseline represents a pre-115 database');

  lockProbe = new Client({ connectionString: scopedUrl.href });
  await lockProbe.connect();
  let blockedInsert;
  let observedMigrationLock = false;
  try {
    await db.query('BEGIN');
    await db.query('LOCK TABLE pos_order_income_category_snapshots IN ACCESS EXCLUSIVE MODE');
    const probePid = (await lockProbe.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    blockedInsert = lockProbe.query(`INSERT INTO pos_order_income_category_snapshots
      (venue_id,order_id,pricing_snapshot_id,closed_at,venue_date,recognized_total_minor,unmapped_minor,status)
      VALUES(gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),now(),CURRENT_DATE,0,0,'building')`)
      .then((result) => ({ result }), (error) => ({ error }));
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const activity = (await admin.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1', [probePid])).rows[0];
      if (activity?.wait_event_type === 'Lock') { observedMigrationLock = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  } finally {
    await db.query('ROLLBACK').catch(() => {});
  }
  const blockedOutcome = await blockedInsert;
  await lockProbe.end();
  lockProbe = null;
  assert.equal(observedMigrationLock, true, 'snapshot inserts wait while migration holds the preflight table lock');
  assert.equal(blockedOutcome.error?.code, '23503', 'blocked insert resumes only after lock release and then hits normal FK validation');

  // Preserve a completed legacy snapshot through the additive upgrade. Its
  // saved local date is evidence; the former timezone cannot be guessed.
  const organizationId = await insert(db, 'organizations', { name: 'Legacy upgrade QA', slug: schemaName });
  const venueId = await insert(db, 'venues', { name: 'Legacy upgrade QA', organization_id: organizationId, timezone: 'Asia/Yekaterinburg' });
  const ownerId = await insert(db, 'users', { venue_id: venueId, full_name: 'Upgrade QA', login: `${schemaName}-owner`, role: 'owner' });
  const closedAt = '2026-10-17T22:30:00Z';
  await db.query('BEGIN');
  const orderId = await insert(db, 'orders', {
    venue_id: venueId, opened_by: ownerId, status: 'closed', closed_at: closedAt,
    pricing_version: 1, pricing_locked_at: closedAt,
    subtotal_snapshot: '1.00', discount_total_snapshot: '0.00',
    minimum_adjustment_snapshot: '0.00', final_total_snapshot: '1.00',
  });
  const productId = await insert(db, 'products', {
    venue_id: venueId, name: 'Legacy upgrade item', category: 'legacy', sale_price: '1.00', inventory_mode: 'non_stock',
  });
  const orderItemId = await insert(db, 'order_items', {
    order_id: orderId, product_id: productId, quantity: '1.000', unit_price: '1.00', station: 'bar',
  });
  const pricingSnapshotId = await insert(db, 'pos_order_pricing_snapshots', {
    venue_id: venueId, order_id: orderId, sold_at: closedAt, transaction_at: closedAt,
    subtotal_minor: 100, discount_minor: 0, minimum_adjustment_minor: 0, final_total_minor: 100,
    discount_source: 'none', winner_source_ids: [], eligible_item_ids: [], winner_terms: {}, frozen_terms: { allocationPolicy: 'upgrade-qa' },
  });
  await insert(db, 'pos_order_pricing_snapshot_lines', {
    venue_id: venueId, snapshot_id: pricingSnapshotId, order_id: orderId, order_item_id: orderItemId,
    seller_id: null, sold_at: null, quantity: '1.000', unit_price: '1.00',
    gross_minor: 100, discount_minor: 0, net_minor: 100, eligible: false,
    product_facts: { productId, productName: 'Legacy upgrade item', category: 'legacy', station: 'bar', productActive: true },
  });
  const snapshotId = await insert(db, 'pos_order_income_category_snapshots', {
    venue_id: venueId, order_id: orderId, pricing_snapshot_id: pricingSnapshotId,
    closed_at: closedAt, venue_date: '2026-10-18', recognized_total_minor: 100, unmapped_minor: 100, status: 'building',
  });
  await db.query('COMMIT');

  // Migration 104 allowed interrupted writers to leave building rows behind.
  // Migration 115 must stop before changing the schema until the source facts
  // have been reconciled and the old row has safely reached a terminal state.
  await db.query('BEGIN');
  await assert.rejects(() => db.query(migration115), /finance_pos_income_snapshot_legacy_building_rows_require_repair/);
  await db.query('ROLLBACK');
  assert.equal((await db.query(`SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema=current_schema() AND table_name='pos_order_income_category_snapshots'
      AND column_name='venue_timezone_snapshot'
  ) AS present`)).rows[0].present, false, 'failed migration leaves the pre-115 schema intact');

  await db.query('BEGIN');
  await insert(db, 'pos_order_income_category_allocations', {
    venue_id: venueId, income_snapshot_id: snapshotId, order_id: orderId,
    allocation_kind: 'item', order_item_id: orderItemId, source_key: 'legacy',
    source_station_snapshot: 'bar', source_menu_category: 'legacy', source_product_name: 'Legacy upgrade item',
    mapping_id: null, category_id: null, category_name_snapshot: 'Не распределено', amount_minor: 100,
  });
  await db.query("UPDATE pos_order_income_category_snapshots SET status='unmapped' WHERE id=$1", [snapshotId]);
  await db.query('COMMIT');

  await db.query(migration115);
  const upgraded = (await db.query(`SELECT status,venue_date::text,venue_timezone_snapshot
    FROM pos_order_income_category_snapshots WHERE venue_id=$1 AND id=$2`, [venueId, snapshotId])).rows[0];
  assert.deepEqual(upgraded, { status: 'unmapped', venue_date: '2026-10-18', venue_timezone_snapshot: null },
    'existing snapshot remains intact and unknown historical timezone is not fabricated');

  await db.query(migration115);
  const replayed = (await db.query(`SELECT status,venue_date::text,venue_timezone_snapshot
    FROM pos_order_income_category_snapshots WHERE venue_id=$1 AND id=$2`, [venueId, snapshotId])).rows[0];
  assert.deepEqual(replayed, upgraded, 'replaying migration 115 preserves the legacy row exactly');

  await db.end();
  db = null;
  await admin.query('SET search_path TO public');
  await admin.query(`DROP SCHEMA ${schemaName} CASCADE`);
  created = false;
  activeSchemaName = replaySchemaName;
  await admin.query(`CREATE SCHEMA ${replaySchemaName}`);
  created = true;
  await admin.query(`SET search_path TO ${replaySchemaName}`);
  await admin.query(pre115Schema);
  const replayUrl = new URL(target.url);
  replayUrl.searchParams.set('options', `-c search_path=${replaySchemaName}`);
  db = new Client({ connectionString: replayUrl.href });
  await db.connect();
  const migrations = readdirSync(migrationDir).filter((file) => file.endsWith('.sql')).sort();
  await runMigrations(migrations, 'first complete migration pass');
  await runMigrations(migrations, 'replay migration pass');
  console.log(`FINANCE POS INCOME MIGRATION UPGRADE POSTGRES: PASS (incomplete legacy rows block 115 until reconciled; terminal snapshot preserved with unknown timezone; ${migrations.length} migrations applied twice over a clean pre-115 schema)`);
} finally {
  await lockProbe?.end();
  await db?.end();
  if (created) {
    await admin.query('ROLLBACK').catch(() => {});
    await admin.query('SET search_path TO public').catch(() => {});
    await admin.query(`DROP SCHEMA ${activeSchemaName} CASCADE`);
    assert.equal((await admin.query('SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname=$1) present', [activeSchemaName])).rows[0].present, false);
  }
  await admin.end();
}
