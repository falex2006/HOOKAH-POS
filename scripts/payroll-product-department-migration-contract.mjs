import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { validateQaDatabaseUrl, assertQaDatabaseIdentity } from './postgres-qa-safety.mjs';

const require = createRequire(import.meta.url), { Client } = require('pg');
const { mappingPayloadSha256, postgresJsonbText } = require('../payroll-product-department-source');
const root = fileURLToPath(new URL('../', import.meta.url));
const target = validateQaDatabaseUrl(process.env.MIGRATIONS_PG_TEST_DATABASE_URL);
assert.equal(process.env.MIGRATIONS_PG_TEST_DOCKER_CONTAINER, 'hookah-full-regression-qa-20261001');
assert.equal(target.database, 'hookah_local_qa');
const lock = JSON.parse(readFileSync(path.join(root, 'tmp/full-local-qa/pg-regression-runner.lock'), 'utf8'));
assert.equal(Number(lock.pid), process.ppid, 'the guarded disposable PostgreSQL runner must own this process');
const schema = `payroll_department_qa_${process.pid}_${Date.now()}`;
assert.match(schema, /^payroll_department_qa_\d+_\d+$/);
const db = new Client({ connectionString: target.url.href });
const id = () => randomUUID();
let created = false;
const expectError = async (action, code) => {
  try { await action(); assert.fail(`expected SQLSTATE ${code}`); }
  catch (error) {
    await db.query('ROLLBACK').catch(() => {});
    assert.equal(error.code, code, `expected SQLSTATE ${code}, got ${error.code}: ${error.message}`);
  }
};
const migrationPath = path.join(root, 'migrations/189_payroll_product_department_mapping_revisions.sql');
const migration = readFileSync(migrationPath, 'utf8');
const mappingRows = [
  { productId: id(), productName: 'Кофе', departmentCode: 'bar', departmentName: 'Бар', effectiveFrom: '2026-01-01', effectiveTo: null },
  { productId: id(), productName: 'Кальян', departmentCode: 'hookah', departmentName: 'Кальянная', effectiveFrom: '2026-01-01', effectiveTo: null }
];
const digestFor = async (rows, { allowInvalidRows = false } = {}) => {
  const jsonRows = JSON.stringify(rows.map(row => ({ product_id: row.productId, department_code: row.departmentCode,
    product_name_snapshot: row.productName, department_name_snapshot: row.departmentName, effective_from: row.effectiveFrom, effective_to: row.effectiveTo })));
  const result = await db.query(`SELECT COALESCE(jsonb_agg(jsonb_build_object(
  'productId',r.product_id::text,'productName',r.product_name_snapshot,'departmentCode',r.department_code,'departmentName',r.department_name_snapshot,
  'effectiveFrom',r.effective_from::text,'effectiveTo',r.effective_to::text
) ORDER BY r.product_id,r.effective_from,r.effective_to NULLS LAST,r.department_code,r.department_name_snapshot)::text,'[]') AS canonical_text,
encode(digest(convert_to(COALESCE(jsonb_agg(jsonb_build_object(
  'productId',r.product_id::text,'productName',r.product_name_snapshot,'departmentCode',r.department_code,'departmentName',r.department_name_snapshot,
  'effectiveFrom',r.effective_from::text,'effectiveTo',r.effective_to::text
) ORDER BY r.product_id,r.effective_from,r.effective_to NULLS LAST,r.department_code,r.department_name_snapshot)::text,'[]'),'UTF8'),'sha256'),'hex') AS digest
FROM jsonb_to_recordset($1::jsonb) AS r(product_id uuid,department_code text,product_name_snapshot text,department_name_snapshot text,effective_from date,effective_to date)`,
[jsonRows]);
  const expectedText = postgresJsonbText(rows.map(row => ({ productId: row.productId.toLowerCase(), productName: row.productName.trim(),
    departmentCode: row.departmentCode, departmentName: row.departmentName.trim(), effectiveFrom: row.effectiveFrom, effectiveTo: row.effectiveTo }))
    .sort((a, b) => a.productId.localeCompare(b.productId) || a.effectiveFrom.localeCompare(b.effectiveFrom)));
  if (!allowInvalidRows) {
    assert.equal(result.rows[0].canonical_text, expectedText, `SQL and JS JSONB text differ: SQL=${result.rows[0].canonical_text}; JS=${expectedText}`);
    assert.equal(result.rows[0].digest, mappingPayloadSha256(rows), 'SQL jsonb digest must match the pure payroll source adapter');
  }
  return result.rows[0].digest;
};
const headerInsert = async ({ venueId, ownerId, revisionNo, previousId, key, rows, effectiveFrom, retroactive = false, retroReason = null, digest }) => {
  const payload = digest ?? await digestFor(rows);
  await db.query('BEGIN');
  try {
  const result = await db.query(`INSERT INTO payroll_product_department_revisions
    (venue_id,revision_no,supersedes_revision_id,reason,idempotency_key,payload_sha256,mapping_count,effective_from,
     retroactive_attested,retroactive_reason,created_by,created_by_name)
    VALUES($1,$2,$3,'Confirm payroll product departments',$4,$5,$6,$7,$8,$9,$10,'forged display name') RETURNING id::text`,
  [venueId, revisionNo, previousId, key, payload, rows.length, effectiveFrom, retroactive, retroReason, ownerId]);
  for (const row of rows) await db.query(`INSERT INTO payroll_product_department_mappings
    (venue_id,revision_id,product_id,product_name_snapshot,department_code,department_name_snapshot,effective_from,effective_to)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [venueId, result.rows[0].id, row.productId, row.productName, row.departmentCode, row.departmentName, row.effectiveFrom, row.effectiveTo]);
  await db.query('COMMIT');
  return result.rows[0].id;
  } catch (error) { await db.query('ROLLBACK').catch(() => {}); throw error; }
};

try {
  await db.connect();
  const identity = (await db.query(`SELECT current_database() AS database,inet_server_addr()::text AS address,
    inet_server_port() AS port,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser`)).rows[0];
  assertQaDatabaseIdentity(identity, target.database, Number(target.url.port));
  await db.query(`CREATE SCHEMA "${schema}"`); created = true;
  await db.query(`SET search_path TO "${schema}",public`);
  await db.query(readFileSync(path.join(root, 'schema.sql'), 'utf8'));
  for (const name of readdirSync(path.join(root, 'migrations')).filter(name => /^\d{3}.*\.sql$/.test(name)).sort()) {
    await db.query(readFileSync(path.join(root, 'migrations', name), 'utf8'));
  }
  await db.query(migration);
  await db.query(migration);

  const venueId = id(), foreignVenueId = id();
  await db.query(`INSERT INTO venues(id,name,timezone) VALUES($1,'Payroll departments QA','Asia/Yekaterinburg'),($2,'Foreign payroll departments QA','UTC')`, [venueId, foreignVenueId]);
  const addUser = async (venue, role) => (await db.query(`INSERT INTO users(venue_id,full_name,login,role) VALUES($1,$2,$3,$4) RETURNING id::text`,
    [venue, `QA ${role}`, `department-${id()}`, role])).rows[0].id;
  const ownerId = await addUser(venueId, 'owner'), managerId = await addUser(venueId, 'manager'), foreignOwnerId = await addUser(foreignVenueId, 'owner');
  assert.equal(await digestFor([]), mappingPayloadSha256([]), 'empty full snapshots share a deterministic SQL/source digest');
  await digestFor(mappingRows);
  const ledgers = (await db.query(`SELECT (SELECT count(*)::int FROM payroll_entries) entries,(SELECT count(*)::int FROM expenses) expenses,
    (SELECT count(*)::int FROM payroll_calculation_runs) runs,(SELECT count(*)::int FROM products) products,
    (SELECT count(*)::int FROM orders) orders,(SELECT count(*)::int FROM payments) payments`)).rows[0];

  // The new revision switches tomorrow in the venue's timezone while retaining a historical interval.
  const localTomorrow = (await db.query(`SELECT ((transaction_timestamp() AT TIME ZONE 'Asia/Yekaterinburg')::date+1)::text AS day`)).rows[0].day;
  const historicalStart = '2025-01-01';
  const firstRows = mappingRows.map(row => ({ ...row, effectiveFrom: historicalStart }));
  const firstKey = `dept:${id()}`;
  const firstId = await headerInsert({ venueId, ownerId, revisionNo: 1, previousId: null, key: firstKey, rows: firstRows, effectiveFrom: localTomorrow });
  assert.equal((await db.query(`SELECT created_by_name FROM payroll_product_department_revisions WHERE id=$1`, [firstId])).rows[0].created_by_name, 'QA owner');
  // Discard/reset in a test schema is forbidden: retries are modeled by keeping the original full snapshot.
  const nextRows = [...firstRows, { productId: id(), productName: 'Новый товар', departmentCode: 'bar', departmentName: 'Бар', effectiveFrom: historicalStart, effectiveTo: null }];
  const secondId = await headerInsert({ venueId, ownerId, revisionNo: 2, previousId: firstId, key: `dept:${id()}`, rows: nextRows, effectiveFrom: localTomorrow });
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM payroll_product_department_mappings WHERE venue_id=$1 AND revision_id=$2`, [venueId, secondId])).rows[0].n, 3);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM payroll_product_department_mappings WHERE product_id=$1`, [firstRows[0].productId])).rows[0].n, 2,
    'historic rows are snapshot-only and product IDs have no catalog FK');

  await expectError(() => headerInsert({ venueId, ownerId: managerId, revisionNo: 3, previousId: secondId, key: `dept:${id()}`, rows: [], effectiveFrom: localTomorrow }), '42501');
  await expectError(() => headerInsert({ venueId, ownerId: foreignOwnerId, revisionNo: 3, previousId: secondId, key: `dept:${id()}`, rows: [], effectiveFrom: localTomorrow }), '42501');
  await expectError(() => headerInsert({ venueId: foreignVenueId, ownerId: foreignOwnerId, revisionNo: 2, previousId: null, key: `dept:${id()}`, rows: [], effectiveFrom: localTomorrow }), '23514');
  await expectError(() => headerInsert({ venueId, ownerId, revisionNo: 3, previousId: firstId, key: `dept:${id()}`, rows: [], effectiveFrom: localTomorrow }), '23514');
  await expectError(() => headerInsert({ venueId, ownerId, revisionNo: 3, previousId: secondId, key: `dept:${id()}`, rows: [], effectiveFrom: '2020-01-01' }), '23514');
  const twoDaysOut = (await db.query(`SELECT ((transaction_timestamp() AT TIME ZONE 'Asia/Yekaterinburg')::date+2)::text AS day`)).rows[0].day;
  await expectError(() => headerInsert({ venueId, ownerId, revisionNo: 3, previousId: secondId, key: `dept:${id()}`, rows: [], effectiveFrom: twoDaysOut }), '23514');
  await expectError(() => headerInsert({ venueId, ownerId, revisionNo: 3, previousId: secondId, key: `dept:${id()}`, rows: [], effectiveFrom: '2020-01-01', retroactive: true, retroReason: 'short' }), '23514');

  // Explicit retroactive correction is allowed, but only with a bounded reason and attestation.
  const retroId = await headerInsert({ venueId, ownerId, revisionNo: 3, previousId: secondId, key: `dept:${id()}`, rows: nextRows,
    effectiveFrom: '2020-01-01', retroactive: true, retroReason: 'Correct archived department assignment' });
  assert.ok(retroId);
  await expectError(() => headerInsert({ venueId, ownerId, revisionNo: 4, previousId: retroId, key: firstKey, rows: [], effectiveFrom: localTomorrow }), '23505');
  const committed = (await db.query(`SELECT count(*)::int AS n FROM payroll_product_department_revisions WHERE venue_id=$1`, [venueId])).rows[0].n;
  assert.equal(committed, 3);

  await expectError(() => db.query(`UPDATE payroll_product_department_revisions SET reason=reason WHERE id=$1`, [firstId]), '55000');
  await expectError(() => db.query(`DELETE FROM payroll_product_department_mappings WHERE revision_id=$1`, [firstId]), '55000');
  await expectError(() => db.query('TRUNCATE payroll_product_department_revisions CASCADE'), '55000');
  await expectError(() => db.query('TRUNCATE payroll_product_department_mappings'), '55000');
  await expectError(() => headerInsert({ venueId, ownerId, revisionNo: 4, previousId: retroId, key: `dept:${id()}`, rows: nextRows,
    effectiveFrom: localTomorrow, digest: '0'.repeat(64) }), '23514');
  const overlapRows = [
    { ...firstRows[0], effectiveFrom: '2026-01-01', effectiveTo: '2026-01-15' },
    { ...firstRows[0], effectiveFrom: '2026-01-15', effectiveTo: '2026-01-30' }
  ];
  const overlapDigest = await digestFor(overlapRows, { allowInvalidRows: true });
  await expectError(() => headerInsert({ venueId, ownerId, revisionNo: 4, previousId: retroId, key: `dept:${id()}`, rows: overlapRows, effectiveFrom: localTomorrow, digest: overlapDigest }), '23P01');
  await expectError(() => headerInsert({ venueId, ownerId, revisionNo: 4, previousId: retroId, key: `dept:${id()}`, rows: [], effectiveFrom: localTomorrow, digest: '0'.repeat(64) }), '23514');
  assert.deepEqual((await db.query(`SELECT (SELECT count(*)::int FROM payroll_entries) entries,(SELECT count(*)::int FROM expenses) expenses,
    (SELECT count(*)::int FROM payroll_calculation_runs) runs,(SELECT count(*)::int FROM products) products,
    (SELECT count(*)::int FROM orders) orders,(SELECT count(*)::int FROM payments) payments`)).rows[0], ledgers,
  'department mapping migration and writes do not change POS/catalog/payroll/expense ledgers');
  console.log('PAYROLL PRODUCT DEPARTMENT MIGRATION: PASS (replay x2, owner/tenant, revision chain, local boundary, retro attestation, full snapshots, historical product UUID, row count/digest, overlap, immutable, no protected writes)');
} finally {
  if (created) {
    await db.query(`DROP SCHEMA "${schema}" CASCADE`);
    assert.equal((await db.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [schema])).rows.length, 0);
  }
  await db.end();
}
