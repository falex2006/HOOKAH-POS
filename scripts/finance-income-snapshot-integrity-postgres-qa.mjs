import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertQaDatabaseIdentity, validateQaDatabaseUrl } from './postgres-qa-safety.mjs';

const require = createRequire(import.meta.url);
const { Client, Pool } = require('pg');
const { handleFinanceIncomeRoute, writePosOrderIncomeCategorySnapshot } = require('../finance-income');
const target = validateQaDatabaseUrl(process.env.MIGRATIONS_PG_TEST_DATABASE_URL);
const root = fileURLToPath(new URL('../', import.meta.url));
const schemaName = `finance_income_integrity_qa_${process.pid}_${Date.now()}`;
const scopedUrl = new URL(target.url);
scopedUrl.searchParams.set('options', `-c search_path=${schemaName}`);
const admin = new Client({ connectionString: target.url.href });
let db;
let reportPool;
let created = false;

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

const rollback = async (client) => client.query('ROLLBACK').catch(() => {});

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
  await admin.query(readFileSync(path.join(root, 'schema.sql'), 'utf8'));
  db = new Client({ connectionString: scopedUrl.href });
  await db.connect();

  const organizationId = await insert(db, 'organizations', { name: 'Income integrity QA', slug: schemaName });
  const venueId = await insert(db, 'venues', { name: 'Income integrity QA', organization_id: organizationId, timezone: 'Asia/Yekaterinburg' });
  const ownerId = await insert(db, 'users', { venue_id: venueId, full_name: 'Finance QA', login: `${schemaName}-owner`, role: 'owner' });

  const createSource = async ({ lines, minimum = 0, closedAt = '2026-10-17T12:00:00Z' }) => {
    await db.query('BEGIN');
    try {
      const net = lines.reduce((sum, line) => sum + line.amount, 0);
      const gross = lines.reduce((sum, line) => sum + (line.gross ?? line.amount), 0);
      const discount = gross - net;
      const finalTotal = net + minimum;
      const orderId = await insert(db, 'orders', {
        venue_id: venueId, opened_by: ownerId, status: 'closed', closed_at: closedAt,
        pricing_version: 1, pricing_locked_at: closedAt,
        subtotal_snapshot: (gross / 100).toFixed(2), discount_total_snapshot: (discount / 100).toFixed(2),
        minimum_adjustment_snapshot: (minimum / 100).toFixed(2), final_total_snapshot: (finalTotal / 100).toFixed(2),
      });
      const itemIds = [];
      const productFacts = [];
      for (const [index, line] of lines.entries()) {
        const productId = await insert(db, 'products', {
          venue_id: venueId, name: line.name || `QA product ${index + 1}`,
          category: line.category, sale_price: ((line.gross ?? line.amount) / 100).toFixed(2), inventory_mode: 'non_stock',
        });
        const itemId = await insert(db, 'order_items', {
          order_id: orderId, product_id: productId, quantity: '1.000',
          unit_price: ((line.gross ?? line.amount) / 100).toFixed(2), station: line.station || 'bar',
        });
        itemIds.push(itemId);
        productFacts.push({
          productId, productName: line.name || `QA product ${index + 1}`,
          category: line.category, station: line.station || 'bar', productActive: true,
        });
      }
      const eligibleItemIds = itemIds.filter((_, index) => (lines[index].gross ?? lines[index].amount) > lines[index].amount).sort();
      const pricingSnapshotId = await insert(db, 'pos_order_pricing_snapshots', {
        venue_id: venueId, order_id: orderId, sold_at: closedAt, transaction_at: closedAt,
        subtotal_minor: gross, discount_minor: discount, minimum_adjustment_minor: minimum,
        final_total_minor: finalTotal, discount_source: discount > 0 ? 'manual' : 'none', winner_source_ids: [],
        eligible_item_ids: eligibleItemIds, winner_terms: {}, frozen_terms: { allocationPolicy: 'qa' },
      });
      for (const [index, line] of lines.entries()) {
        await insert(db, 'pos_order_pricing_snapshot_lines', {
          venue_id: venueId, snapshot_id: pricingSnapshotId, order_id: orderId,
          order_item_id: itemIds[index], seller_id: null, sold_at: null,
          quantity: '1.000', unit_price: ((line.gross ?? line.amount) / 100).toFixed(2),
          gross_minor: line.gross ?? line.amount, discount_minor: (line.gross ?? line.amount) - line.amount, net_minor: line.amount,
          eligible: (line.gross ?? line.amount) > line.amount, product_facts: productFacts[index],
        });
      }
      const venueTimezone = (await db.query(`SELECT COALESCE(NULLIF(v.timezone,''),NULLIF(org.timezone,''),'Asia/Yekaterinburg') AS timezone
        FROM venues v LEFT JOIN organizations org ON org.id=v.organization_id WHERE v.id=$1`, [venueId])).rows[0].timezone;
      const venueDate = (await db.query('SELECT ($1::timestamptz AT TIME ZONE $2)::date::text AS date', [closedAt, venueTimezone])).rows[0].date;
      await db.query('COMMIT');
      return { orderId, pricingSnapshotId, itemIds, lines, minimum, finalTotal, venueId, closedAt, venueTimezone, venueDate };
    } catch (error) {
      await rollback(db);
      throw error;
    }
  };

  const createIncomeHeader = async (source, status = 'building', unmapped = 0, overrides = {}) => insert(db, 'pos_order_income_category_snapshots', {
    venue_id: source.venueId, order_id: source.orderId, pricing_snapshot_id: source.pricingSnapshotId,
    closed_at: overrides.closedAt || source.closedAt, venue_date: overrides.venueDate || source.venueDate,
    venue_timezone_snapshot: overrides.venueTimezone || source.venueTimezone,
    recognized_total_minor: source.finalTotal, unmapped_minor: unmapped, status,
  });

  const insertItemAllocation = async (snapshotId, source, index, { amount, sourceKey, mapped = false } = {}) => {
    const line = source.lines[index];
    const normalizedKey = sourceKey ?? line.category;
    const category = mapped ? mappedCategories.get(normalizedKey) : null;
    await insert(db, 'pos_order_income_category_allocations', {
      venue_id: source.venueId, income_snapshot_id: snapshotId, order_id: source.orderId,
      allocation_kind: 'item', order_item_id: source.itemIds[index], source_key: normalizedKey,
      source_station_snapshot: line.station || 'bar', source_menu_category: line.category,
      source_product_name: line.name || `QA product ${index + 1}`,
      mapping_id: category?.mappingId || null, category_id: category?.categoryId || null,
      category_name_snapshot: category?.name || 'Не распределено', amount_minor: amount ?? line.amount,
    });
  };

  const createMapping = async (sourceKey, name) => {
    const categoryId = await insert(db, 'finance_categories', { venue_id: venueId, name, kind: 'income' });
    const mappingId = await insert(db, 'finance_income_category_mappings', {
      venue_id: venueId, source_key: sourceKey, category_id: categoryId,
      category_name_snapshot: name, effective_from: '2026-10-01', revision: 1,
      supersedes_mapping_id: null, created_by: ownerId,
    });
    return { categoryId, mappingId, name };
  };

  const mappedCategories = new Map();
  mappedCategories.set('bar', await createMapping('bar', 'Продажи бара'));
  mappedCategories.set('@minimum-adjustment', await createMapping('@minimum-adjustment', 'Минимальный чек'));

  const expenseCategoryId = await insert(db, 'finance_categories', { venue_id: venueId, name: 'Не доходная статья', kind: 'expense' });
  await assert.rejects(() => insert(db, 'finance_income_category_mappings', {
    venue_id: venueId, source_key: 'invalid-expense-source', category_id: expenseCategoryId,
    category_name_snapshot: 'Не доходная статья', effective_from: '2026-10-01', revision: 1,
    supersedes_mapping_id: null, created_by: ownerId,
  }), /finance_income_mapping_requires_active_income_category/);
  const forgedNameCategoryId = await insert(db, 'finance_categories', { venue_id: venueId, name: 'Каноническая статья', kind: 'income' });
  await assert.rejects(() => insert(db, 'finance_income_category_mappings', {
    venue_id: venueId, source_key: 'forged-name-source', category_id: forgedNameCategoryId,
    category_name_snapshot: 'Подменённое название', effective_from: '2026-10-01', revision: 1,
    supersedes_mapping_id: null, created_by: ownerId,
  }), /finance_income_mapping_category_name_mismatch/);
  await assert.rejects(() => db.query("UPDATE finance_categories SET kind='expense' WHERE id=$1", [mappedCategories.get('bar').categoryId]),
    /finance_category_source_kind_immutable/);

  // Exercise the real close-path writer, including its venue-row lock and the
  // persisted timezone snapshot used to keep historical local dates stable.
  const apiWriterSource = await createSource({
    lines: [{ amount: 100, gross: 125, category: 'bar' }], minimum: 25, closedAt: '2026-10-17T22:30:00Z',
  });
  await db.query('BEGIN');
  let apiWriterSnapshotId;
  try {
    apiWriterSnapshotId = await writePosOrderIncomeCategorySnapshot(db, { venueId, orderId: apiWriterSource.orderId });
    await db.query('COMMIT');
  } catch (error) {
    await rollback(db);
    throw error;
  }
  const apiWriterSnapshot = (await db.query(`SELECT status,recognized_total_minor,venue_date::text,venue_timezone_snapshot
    FROM pos_order_income_category_snapshots WHERE id=$1`, [apiWriterSnapshotId])).rows[0];
  assert.deepEqual(apiWriterSnapshot, {
    status: 'complete', recognized_total_minor: '125', venue_date: '2026-10-18', venue_timezone_snapshot: 'Asia/Yekaterinburg',
  }, 'actual close writer stores discounted recognition and frozen venue-local date context');

  // The report must keep using the saved local close date after the venue's
  // current timezone changes and would derive a different date from closed_at.
  await db.query("UPDATE venues SET timezone='UTC' WHERE id=$1", [venueId]);
  let timezoneChangedReport;
  reportPool = new Pool({ connectionString: scopedUrl.href, max: 2 });
  await handleFinanceIncomeRoute({
    req: { method: 'GET', user: { id: ownerId, role: 'owner' } },
    url: new URL('/api/finance/income-category-report?from=2026-10-18&to=2026-10-18', 'http://local'),
    pool: reportPool, venueId, hasPermission: () => true,
    json: (_res, status, body) => { timezoneChangedReport = { status, body }; return body; },
  });
  assert.equal(timezoneChangedReport.status, 200, 'income report remains available after a venue timezone change');
  const savedDateBarTotal = timezoneChangedReport.body.items.find((row) => row.categoryName === 'Продажи бара')?.amountMinor;
  const savedDateMinimumTotal = timezoneChangedReport.body.items.find((row) => row.categoryName === 'Минимальный чек')?.amountMinor;
  assert.equal(savedDateBarTotal, '100', 'report keeps the POS sale on its frozen venue-local date');
  assert.equal(savedDateMinimumTotal, '25', 'minimum adjustment remains on the same frozen venue-local date');
  await reportPool.end();
  reportPool = null;
  await db.query("UPDATE venues SET timezone='Asia/Yekaterinburg' WHERE id=$1", [venueId]);

  // A mapping may remain for historical rows after archival, but direct SQL
  // cannot use it to seal a new POS income snapshot.
  const archivedCategory = await createMapping('archived-source', 'Архивная статья');
  mappedCategories.set('archived-source', archivedCategory);
  await db.query('UPDATE finance_categories SET active=false WHERE id=$1', [archivedCategory.categoryId]);
  const archivedSource = await createSource({ lines: [{ amount: 100, category: 'archived-source' }] });
  await db.query('BEGIN');
  const archivedSnapshotId = await createIncomeHeader(archivedSource);
  await insertItemAllocation(archivedSnapshotId, archivedSource, 0, { mapped: true, sourceKey: 'archived-source' });
  await db.query("UPDATE pos_order_income_category_snapshots SET status='complete',unmapped_minor=0 WHERE id=$1", [archivedSnapshotId]);
  await assert.rejects(() => db.query('COMMIT'), /pos_order_income_category_snapshot_requires_active_income_category/);
  await rollback(db);

  const supplementarySourceKey = '😀'.repeat(251);
  const unicodeSource = await createSource({ lines: [{ amount: 100, category: supplementarySourceKey }] });
  await db.query('BEGIN');
  let unicodeSnapshotId;
  try {
    unicodeSnapshotId = await writePosOrderIncomeCategorySnapshot(db, { venueId, orderId: unicodeSource.orderId });
    await db.query('COMMIT');
  } catch (error) {
    await rollback(db);
    throw error;
  }
  const unicodeAllocation = (await db.query(`SELECT a.source_key,h.status,h.unmapped_minor
    FROM pos_order_income_category_allocations a
    JOIN pos_order_income_category_snapshots h ON h.venue_id=a.venue_id AND h.id=a.income_snapshot_id
    WHERE a.venue_id=$1 AND a.income_snapshot_id=$2 AND a.allocation_kind='item'`, [venueId, unicodeSnapshotId])).rows[0];
  assert.deepEqual(unicodeAllocation, { source_key: supplementarySourceKey, status: 'unmapped', unmapped_minor: '100' },
    'supplementary Unicode labels remain aligned with PostgreSQL character-length checks');

  // Terminal rows may only be reached from a building header.
  const directTerminalSource = await createSource({ lines: [{ amount: 100, category: 'bar' }] });
  await db.query('BEGIN');
  await assert.rejects(
    () => createIncomeHeader(directTerminalSource, 'complete', 0),
    /pos_order_income_snapshot_must_start_building/,
  );
  await rollback(db);

  // The commit-time validator must reject a header left in its intermediate state.
  const unfinishedSource = await createSource({ lines: [{ amount: 100, category: 'bar' }] });
  await db.query('BEGIN');
  await createIncomeHeader(unfinishedSource);
  await assert.rejects(() => db.query('COMMIT'), /pos_order_income_category_snapshot_not_terminal/);
  await rollback(db);
  assert.equal((await db.query('SELECT COUNT(*)::int AS count FROM pos_order_income_category_snapshots WHERE order_id=$1', [unfinishedSource.orderId])).rows[0].count, 0,
    'a failed commit leaves no partial income snapshot');

  // The snapshot date and timezone are tied to the immutable order close; no
  // writer can shift recognized revenue into a different reporting day.
  const boundarySource = await createSource({ lines: [{ amount: 100, category: 'unmapped-special' }], closedAt: '2026-10-17T22:30:00Z' });
  assert.equal(boundarySource.venueDate, '2026-10-18', 'fixture crosses the venue-local midnight boundary');
  await db.query('BEGIN');
  const forgedDateId = await createIncomeHeader(boundarySource, 'building', 0, { venueDate: '2026-10-17' });
  await insertItemAllocation(forgedDateId, boundarySource, 0);
  await db.query("UPDATE pos_order_income_category_snapshots SET status='unmapped',unmapped_minor=100 WHERE id=$1", [forgedDateId]);
  await assert.rejects(() => db.query('COMMIT'), /pos_order_income_category_snapshot_date_mismatch/);
  await rollback(db);

  await db.query('BEGIN');
  const forgedTimezoneId = await createIncomeHeader(boundarySource, 'building', 0, { venueTimezone: 'UTC' });
  await insertItemAllocation(forgedTimezoneId, boundarySource, 0);
  await db.query("UPDATE pos_order_income_category_snapshots SET status='unmapped',unmapped_minor=100 WHERE id=$1", [forgedTimezoneId]);
  await assert.rejects(() => db.query('COMMIT'), /pos_order_income_category_snapshot_date_mismatch/);
  await rollback(db);

  // Complete writer-shaped transaction: each net line, plus the separate minimum adjustment.
  const originalBarMapping = mappedCategories.get('bar');
  const completeSource = await createSource({ lines: [{ amount: 100, gross: 125, category: 'bar' }, { amount: 200, gross: 250, category: 'bar' }], minimum: 50 });
  await db.query('BEGIN');
  const completeId = await createIncomeHeader(completeSource);
  await insertItemAllocation(completeId, completeSource, 0, { mapped: true });
  await insertItemAllocation(completeId, completeSource, 1, { mapped: true });
  const adjustmentMapping = mappedCategories.get('@minimum-adjustment');
  await insert(db, 'pos_order_income_category_allocations', {
    venue_id: venueId, income_snapshot_id: completeId, order_id: completeSource.orderId,
    allocation_kind: 'minimum_adjustment', source_key: '@minimum-adjustment',
    source_station_snapshot: '', source_menu_category: '', source_product_name: '',
    mapping_id: adjustmentMapping.mappingId, category_id: adjustmentMapping.categoryId,
    category_name_snapshot: adjustmentMapping.name, amount_minor: 50,
  });
  await db.query("UPDATE pos_order_income_category_snapshots SET status='complete',unmapped_minor=0 WHERE id=$1", [completeId]);
  await db.query('COMMIT');
  assert.deepEqual((await db.query('SELECT status,recognized_total_minor,unmapped_minor FROM pos_order_income_category_snapshots WHERE id=$1', [completeId])).rows[0],
    { status: 'complete', recognized_total_minor: '350', unmapped_minor: '0' });
  const frozenNetLines = await db.query(`
    SELECT a.amount_minor,l.gross_minor,l.discount_minor,l.net_minor
    FROM pos_order_income_category_allocations a
    JOIN pos_order_income_category_snapshots h ON h.venue_id=a.venue_id AND h.id=a.income_snapshot_id
    JOIN pos_order_pricing_snapshot_lines l ON l.venue_id=h.venue_id AND l.snapshot_id=h.pricing_snapshot_id
      AND l.order_item_id=a.order_item_id
    WHERE a.venue_id=$1 AND a.income_snapshot_id=$2 AND a.allocation_kind='item'
    ORDER BY l.net_minor
  `, [venueId, completeId]);
  assert.deepEqual(frozenNetLines.rows.map((row) => [row.amount_minor, row.gross_minor, row.discount_minor, row.net_minor]),
    [['100', '125', '25', '100'], ['200', '250', '50', '200']], 'recognized item allocations use net after discount, never gross');

  // A correction affects later orders while the already sealed order keeps its original mapping identity.
  const revisedCategory = await insert(db, 'finance_categories', { venue_id: venueId, name: 'Продажи бара, версия 2', kind: 'income' });
  const revisedMappingId = await insert(db, 'finance_income_category_mappings', {
    venue_id: venueId, source_key: 'bar', category_id: revisedCategory,
    category_name_snapshot: 'Продажи бара, версия 2', effective_from: '2026-10-01', revision: 2,
    supersedes_mapping_id: originalBarMapping.mappingId, created_by: ownerId,
  });
  const latestBarMapping = (await db.query(`
    SELECT id,category_id,category_name_snapshot FROM finance_income_category_mappings
    WHERE venue_id=$1 AND source_key='bar' AND effective_from<='2026-10-17'
    ORDER BY effective_from DESC,revision DESC,id DESC LIMIT 1
  `, [venueId])).rows[0];
  assert.equal(latestBarMapping.id, revisedMappingId, 'future closes resolve to the newest effective mapping revision');
  mappedCategories.set('bar', { mappingId: latestBarMapping.id, categoryId: latestBarMapping.category_id, name: latestBarMapping.category_name_snapshot });
  const revisedSource = await createSource({ lines: [{ amount: 90, category: 'bar' }] });
  await db.query('BEGIN');
  const revisedSnapshotId = await createIncomeHeader(revisedSource);
  await insertItemAllocation(revisedSnapshotId, revisedSource, 0, { mapped: true });
  await db.query("UPDATE pos_order_income_category_snapshots SET status='complete',unmapped_minor=0 WHERE id=$1", [revisedSnapshotId]);
  await db.query('COMMIT');
  const oldAndNewMappingIds = await db.query(`
    SELECT income_snapshot_id,mapping_id,category_name_snapshot FROM pos_order_income_category_allocations
    WHERE venue_id=$1 AND allocation_kind='item' AND income_snapshot_id=ANY($2::uuid[])
  `, [venueId, [completeId, revisedSnapshotId]]);
  const historicalAllocation = oldAndNewMappingIds.rows.find((row) => row.income_snapshot_id === completeId);
  const futureAllocation = oldAndNewMappingIds.rows.find((row) => row.income_snapshot_id === revisedSnapshotId);
  assert.equal(historicalAllocation.mapping_id, originalBarMapping.mappingId, 'mapping correction does not rewrite sealed history');
  assert.equal(historicalAllocation.category_name_snapshot, originalBarMapping.name);
  assert.equal(futureAllocation.mapping_id, revisedMappingId);
  assert.equal(futureAllocation.category_name_snapshot, 'Продажи бара, версия 2');

  // A valid unmapped line remains recognized revenue, while its unmapped amount is explicit.
  const unmappedSource = await createSource({ lines: [{ amount: 125, category: 'unmapped-special' }] });
  await db.query('BEGIN');
  const unmappedId = await createIncomeHeader(unmappedSource);
  await insertItemAllocation(unmappedId, unmappedSource, 0);
  await db.query("UPDATE pos_order_income_category_snapshots SET status='unmapped',unmapped_minor=125 WHERE id=$1", [unmappedId]);
  await db.query('COMMIT');
  assert.equal((await db.query('SELECT status FROM pos_order_income_category_snapshots WHERE id=$1', [unmappedId])).rows[0].status, 'unmapped');

  // Same count and total are insufficient: commit must detect shifted values per item.
  const shiftedSource = await createSource({ lines: [{ amount: 100, category: 'bar' }, { amount: 200, category: 'bar' }], minimum: 50 });
  await db.query('BEGIN');
  const shiftedId = await createIncomeHeader(shiftedSource);
  await insertItemAllocation(shiftedId, shiftedSource, 0, { amount: 150 });
  await insertItemAllocation(shiftedId, shiftedSource, 1, { amount: 150 });
  await insert(db, 'pos_order_income_category_allocations', {
    venue_id: venueId, income_snapshot_id: shiftedId, order_id: shiftedSource.orderId,
    allocation_kind: 'minimum_adjustment', source_key: '@minimum-adjustment',
    source_station_snapshot: '', source_menu_category: '', source_product_name: '',
    category_name_snapshot: 'Не распределено', amount_minor: 50,
  });
  await db.query("UPDATE pos_order_income_category_snapshots SET status='unmapped',unmapped_minor=350 WHERE id=$1", [shiftedId]);
  await assert.rejects(() => db.query('COMMIT'), /pos_order_income_category_item_allocation_mismatch/);
  await rollback(db);

  // A correct amount with a falsified source key must also fail at commit.
  const wrongKeySource = await createSource({ lines: [{ amount: 100, category: 'bar' }] });
  await db.query('BEGIN');
  const wrongKeyId = await createIncomeHeader(wrongKeySource);
  await insertItemAllocation(wrongKeyId, wrongKeySource, 0, { sourceKey: 'forged-category' });
  await db.query("UPDATE pos_order_income_category_snapshots SET status='unmapped',unmapped_minor=100 WHERE id=$1", [wrongKeyId]);
  await assert.rejects(() => db.query('COMMIT'), /pos_order_income_category_item_allocation_mismatch/);
  await rollback(db);

  // Positive minimum adjustments require a matching allocation; zero adjustments forbid one.
  const missingAdjustmentSource = await createSource({ lines: [{ amount: 100, category: 'bar' }], minimum: 50 });
  await db.query('BEGIN');
  const missingAdjustmentId = await createIncomeHeader(missingAdjustmentSource);
  await insertItemAllocation(missingAdjustmentId, missingAdjustmentSource, 0);
  await assert.rejects(
    () => db.query("UPDATE pos_order_income_category_snapshots SET status='unmapped',unmapped_minor=100 WHERE id=$1", [missingAdjustmentId]),
    /pos_order_income_category_snapshot_reconciliation_failed/,
  );
  await rollback(db);

  const noAdjustmentSource = await createSource({ lines: [{ amount: 100, category: 'bar' }] });
  await db.query('BEGIN');
  const extraAdjustmentId = await createIncomeHeader(noAdjustmentSource);
  await insertItemAllocation(extraAdjustmentId, noAdjustmentSource, 0);
  await insert(db, 'pos_order_income_category_allocations', {
    venue_id: venueId, income_snapshot_id: extraAdjustmentId, order_id: noAdjustmentSource.orderId,
    allocation_kind: 'minimum_adjustment', source_key: '@minimum-adjustment',
    source_station_snapshot: '', source_menu_category: '', source_product_name: '',
    category_name_snapshot: 'Не распределено', amount_minor: 0,
  });
  await assert.rejects(
    () => db.query("UPDATE pos_order_income_category_snapshots SET status='unmapped',unmapped_minor=100 WHERE id=$1", [extraAdjustmentId]),
    /pos_order_income_category_snapshot_reconciliation_failed/,
  );
  await rollback(db);

  console.log('FINANCE POS INCOME SNAPSHOT INTEGRITY POSTGRES: PASS (terminal insert blocked, building commit rejected, exact item/category facts, minimum adjustment, complete/unmapped, failed commits rolled back)');
} finally {
  await reportPool?.end();
  await db?.end();
  if (created) {
    await admin.query('ROLLBACK').catch(() => {});
    await admin.query('SET search_path TO public').catch(() => {});
    await admin.query(`DROP SCHEMA ${schemaName} CASCADE`);
    assert.equal((await admin.query('SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname=$1) present', [schemaName])).rows[0].present, false);
  }
  await admin.end();
}
