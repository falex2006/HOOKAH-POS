import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migrationPath = path.join(root, 'migrations', '077_payroll_scheme_snapshots.sql');
const migration = fs.readFileSync(migrationPath, 'utf8');
const draftEditsPath = path.join(root, 'migrations', '078_payroll_draft_configuration_edits.sql');
const draftEditsMigration = fs.readFileSync(draftEditsPath, 'utf8');
const revisionsPath = path.join(root, 'migrations', '079_payroll_scheme_revision_audit.sql');
const revisionsMigration = fs.readFileSync(revisionsPath, 'utf8');
const runMetadataPath = path.join(root, 'migrations', '081_payroll_run_metadata.sql');
const runMetadataMigration = fs.readFileSync(runMetadataPath, 'utf8');

for (const table of [
  'payroll_schemes', 'payroll_scheme_versions', 'payroll_role_assignments',
  'payroll_employee_overrides', 'payroll_item_commission_rules',
  'payroll_calculation_runs', 'payroll_daily_snapshots',
  'payroll_daily_snapshot_lines', 'payroll_adjustments', 'payroll_adjustment_applications'
]) assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`), `${table} is additive/replay-safe`);

assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS users_venue_id_id_uq/);
assert.match(migration, /FOREIGN KEY \(venue_id, scheme_version_id\)/);
assert.match(migration, /FOREIGN KEY \(venue_id, employee_id\)/);
assert.match(migration, /FOREIGN KEY \(venue_id, created_by\)/);
assert.match(migration, /UNIQUE \(venue_id, idempotency_key\)/);
assert.match(migration, /UNIQUE \(venue_id, run_id, order_item_id\)/);
assert.match(migration, /UNIQUE \(venue_id, source_kind, source_key, source_allocation_key\)/);
assert.match(migration, /net_after_discounts_refunds/);
assert.match(migration, /unattributed_line_count = 0 AND missing_net_line_count = 0/);
assert.match(migration, /payroll calculation history is append-only/);
assert.match(migration, /children are writable only while draft/);
assert.match(migration, /effective windows overlap/);
assert.match(migration, /adjustment applications exceed source amount/);
assert.doesNotMatch(migration, /\b(DROP\s+TABLE|TRUNCATE\s+TABLE|DELETE\s+FROM\s+payroll_entries|UPDATE\s+payroll_entries|INSERT\s+INTO\s+expenses)\b/i,
  '077 must not mutate the existing payroll or expense lifecycle');
assert.match(draftEditsMigration, /OLD\.status = 'draft' AND NEW\.status = 'draft'/,
  '078 permits editing only while a scheme version remains in draft');
assert.match(draftEditsMigration, /payroll scheme version configuration is immutable; create a new version/,
  '078 preserves active scheme-version immutability');
assert.match(draftEditsMigration, /payroll_guard_draft_child_mutation/,
  '078 permits child configuration replacement only while the version is still draft');
assert.match(revisionsMigration, /CREATE TABLE IF NOT EXISTS payroll_scheme_version_revisions/,
  '079 adds a replay-safe scheme revision journal');
assert.match(revisionsMigration, /BEFORE UPDATE OR DELETE ON payroll_scheme_version_revisions/,
  '079 keeps revision audit append-only');
assert.match(runMetadataMigration, /ADD COLUMN IF NOT EXISTS venue_timezone text/,
  '081 adds a nullable run-local timezone snapshot without a guessed default');
assert.match(runMetadataMigration, /ADD COLUMN IF NOT EXISTS currency char\(3\)/,
  '081 adds a nullable ISO currency snapshot without a guessed default');
assert.match(runMetadataMigration, /FOR SHARE OF v,sv/,
  '081 validates both source settings under a transaction lock');
assert.match(runMetadataMigration, /pg_catalog\.pg_timezone_names/,
  '081 validates timezone snapshots against the database timezone catalog');
assert.match(runMetadataMigration, /NEW\.currency IS DISTINCT FROM configured_currency/,
  '081 binds the run currency snapshot to the exact scheme version');
assert.doesNotMatch(runMetadataMigration, /\b(UPDATE\s+payroll_calculation_runs|DELETE\s+FROM\s+payroll_calculation_runs|INSERT\s+INTO\s+payroll_entries|INSERT\s+INTO\s+expenses)\b/i,
  '081 does not backfill run metadata or enter the payroll payout lifecycle');

if (process.env.PAYROLL_MIGRATION_STATIC_ONLY === '1') {
  console.log('PAYROLL SCHEME MIGRATION CONTRACT: STATIC PASS (PostgreSQL runtime explicitly skipped)');
} else {
  const databaseUrl = process.env.MIGRATIONS_PG_TEST_DATABASE_URL;
  if (!databaseUrl) throw new Error('Set MIGRATIONS_PG_TEST_DATABASE_URL or explicitly set PAYROLL_MIGRATION_STATIC_ONLY=1');
  const parsed = new URL(databaseUrl);
  assert.match(parsed.pathname, /(?:test|qa|scratch)/i,
    'refusing test writes unless database name clearly identifies a test/QA/scratch database');

  const require = createRequire(import.meta.url);
  const { Client } = require('pg');
  const { makeService, PayrollSchemeServiceError } = require(path.join(root, 'payroll-scheme-service.js'));
  const client = new Client({ connectionString: databaseUrl });
  const schema = `payroll_migration_qa_${process.pid}_${Date.now()}`;
  const quotedSchema = `"${schema}"`;
  let transaction = false;
  let savepointIndex = 0;
  const expectSqlFailure = async (query, params, code, label) => {
    const savepoint = `payroll_expected_failure_${savepointIndex++}`;
    await client.query(`SAVEPOINT ${savepoint}`);
    await assert.rejects(client.query(query, params), (error) => error.code === code, label);
    await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    await client.query(`RELEASE SAVEPOINT ${savepoint}`);
  };
  const runSql = async (filename) => client.query(fs.readFileSync(path.join(root, filename), 'utf8'));

  try {
    await client.connect();
    await client.query('BEGIN');
    transaction = true;
    await client.query(`CREATE SCHEMA ${quotedSchema}`);
    await client.query(`SET LOCAL search_path TO ${quotedSchema}, public`);
    await runSql('schema.sql');
    const migrations = fs.readdirSync(path.join(root, 'migrations'))
      .filter((file) => file.endsWith('.sql') && Number(file.slice(0, 3)) <= 79)
      .sort();
    for (const file of migrations) await runSql(path.join('migrations', file));
    await runSql(path.join('migrations', '077_payroll_scheme_snapshots.sql'));
    await runSql(path.join('migrations', '078_payroll_draft_configuration_edits.sql'));
    await runSql(path.join('migrations', '079_payroll_scheme_revision_audit.sql'));

    const venueA = (await client.query("INSERT INTO venues (name) VALUES ('Payroll QA A') RETURNING id")).rows[0].id;
    const venueB = (await client.query("INSERT INTO venues (name) VALUES ('Payroll QA B') RETURNING id")).rows[0].id;
    const makeUser = async (venueId, role, label) => (await client.query(
      'INSERT INTO users (venue_id,full_name,login,role) VALUES ($1,$2,$3,$4) RETURNING id',
      [venueId, label, `payroll-qa-${process.pid}-${label}-${Date.now()}`, role],
    )).rows[0].id;
    const ownerA = await makeUser(venueA, 'owner', 'owner-a');
    const staffA = await makeUser(venueA, 'bartender', 'staff-a');
    const staffOtherA = await makeUser(venueA, 'hookah_master', 'staff-other-a');
    const ownerB = await makeUser(venueB, 'owner', 'owner-b');
    const legacyRule = (await client.query("INSERT INTO payroll_rules (venue_id,name,rule_type,rate) VALUES ($1,'Legacy QA','per_shift',100) RETURNING id", [venueA])).rows[0].id;
    const legacyEntry = (await client.query("INSERT INTO payroll_entries (venue_id,user_id,rule_id,period_from,period_to,amount,status) VALUES ($1,$2,$3,'2026-08-01','2026-08-15',1500,'draft') RETURNING id,amount,status", [venueA, staffA, legacyRule])).rows[0];
    const legacyExpense = (await client.query("INSERT INTO expenses (venue_id,category,amount,expense_date,source) VALUES ($1,'purchase',99,'2026-08-01','purchase') RETURNING id,amount,source", [venueA])).rows[0];
    const productA = (await client.query("INSERT INTO products (venue_id,name,category,sale_price) VALUES ($1,'Payroll item A','bar',100) RETURNING id", [venueA])).rows[0].id;
    const productB = (await client.query("INSERT INTO products (venue_id,name,category,sale_price) VALUES ($1,'Payroll item B','bar',100) RETURNING id", [venueB])).rows[0].id;

    const schemeA = (await client.query("INSERT INTO payroll_schemes (venue_id,name,created_by,created_by_name) VALUES ($1,'QA scheme',$2,'Owner A') RETURNING id", [venueA, ownerA])).rows[0].id;
    const versionA = (await client.query(`INSERT INTO payroll_scheme_versions
      (venue_id,scheme_id,version_no,mode,effective_from,config_json,created_by,created_by_name)
      VALUES ($1,$2,1,'progressive_daily','2026-09-01','{"brackets":[]}',$3,'Owner A') RETURNING id`, [venueA, schemeA, ownerA])).rows[0].id;
    const assignmentA = await client.query(`INSERT INTO payroll_role_assignments
      (venue_id,scheme_version_id,employee_id,role_key,effective_from,created_by,created_by_name)
      VALUES ($1,$2,$3,'bartender','2026-09-01',$4,'Owner A') RETURNING id`, [venueA, versionA, staffA, ownerA]);
    const overrideA = await client.query(`INSERT INTO payroll_employee_overrides
      (venue_id,scheme_version_id,employee_id,parameter_path,override_mode,value_json,effective_from,created_by,created_by_name)
      VALUES ($1,$2,$3,'milestoneBonusesCents.30000000','override','0','2026-09-01',$4,'Owner A') RETURNING id`, [venueA, versionA, staffA, ownerA]);
    await expectSqlFailure(`INSERT INTO payroll_employee_overrides
      (venue_id,scheme_version_id,employee_id,parameter_path,override_mode,value_json,effective_from,created_by,created_by_name)
      VALUES ($1,$2,$3,'milestoneBonusesCents.30000000','override','500','2026-09-10',$4,'Owner A')`, [venueA, versionA, staffA, ownerA], '23P01',
    'parameter overrides cannot have overlapping effective windows');
    await expectSqlFailure(`INSERT INTO payroll_role_assignments
      (venue_id,scheme_version_id,employee_id,role_key,effective_from,created_by,created_by_name)
      VALUES ($1,$2,$3,'hookah','2026-09-10',$4,'Owner A')`, [venueA, versionA, staffA, ownerA], '23P01',
    'employee role assignments cannot have overlapping effective windows');
    const itemRuleA = (await client.query(`INSERT INTO payroll_item_commission_rules
      (venue_id,scheme_version_id,product_id,role_key,rule_mode,rate_bps,created_by,created_by_name)
      VALUES ($1,$2,$3,'bartender','replace',1000,$4,'Owner A') RETURNING id`, [venueA, versionA, productA, ownerA])).rows[0].id;
    assert.ok(assignmentA.rows[0].id && overrideA.rows[0].id && itemRuleA);
    await expectSqlFailure(`INSERT INTO payroll_item_commission_rules
      (venue_id,scheme_version_id,product_id,role_key,rule_mode,rate_bps,created_by,created_by_name)
      VALUES ($1,$2,$3,'bartender','replace',1000,$4,'Owner A')`, [venueA, versionA, productB, ownerA], '23503',
    'cross-venue menu product cannot enter payroll configuration');
    await expectSqlFailure(`INSERT INTO payroll_role_assignments
      (venue_id,scheme_version_id,employee_id,role_key,effective_from,created_by,created_by_name)
      VALUES ($1,$2,$3,'bartender','2026-09-01',$4,'Owner A')`, [venueA, versionA, ownerB, ownerA], '23503',
    'cross-venue employee cannot be assigned');

    await client.query(`UPDATE payroll_scheme_versions
      SET status='active',status_changed_by=$2,status_changed_by_name='Owner A',status_changed_at=now()
      WHERE venue_id=$1 AND id=$3`, [venueA, ownerA, versionA]);
    assert.equal((await client.query("SELECT count(*)::int AS count FROM payroll_scheme_versions WHERE venue_id=$1 AND scheme_id=$2 AND status='active'", [venueA, schemeA])).rows[0].count, 1,
      'first scheme version activation is persisted');
    assert.equal((await client.query("SELECT count(*)::int AS count FROM payroll_scheme_versions WHERE venue_id=$1 AND scheme_id=$2 AND status='active' AND effective_from <= '2026-09-30'::date AND COALESCE(effective_to,'infinity'::date) >= '2026-09-10'::date", [venueA, schemeA])).rows[0].count, 1,
      'fixture has a known active version overlapping the second version window');

    const legacyRun = (await client.query(`INSERT INTO payroll_calculation_runs
      (venue_id,scheme_version_id,period_from,period_to,status,source_coverage,commission_basis,eligible_line_count,
       unattributed_line_count,missing_net_line_count,input_watermark,engine_version,blocked_reason,idempotency_key,created_by,created_by_name)
      VALUES ($1,$2,'2026-09-01','2026-09-14','blocked','unknown','unknown',0,0,0,
       'pre-metadata-run','payroll-schemes-v1','Legacy fixture predates immutable run metadata','legacy-metadata-run',$3,'Owner A') RETURNING id`,
    [venueA, versionA, ownerA])).rows[0].id;
    await runSql(path.join('migrations', '081_payroll_run_metadata.sql'));
    await runSql(path.join('migrations', '081_payroll_run_metadata.sql'));
    assert.deepEqual((await client.query('SELECT venue_timezone,currency FROM payroll_calculation_runs WHERE venue_id=$1 AND id=$2', [venueA, legacyRun])).rows[0],
      { venue_timezone: null, currency: null }, 'legacy run metadata stays explicitly unknown without a guessed backfill');
    const venueTimezone = (await client.query('SELECT timezone FROM venues WHERE id=$1', [venueA])).rows[0].timezone;
    assert.ok(venueTimezone, 'test venue provides a source timezone for new run metadata');

    const overlapVersion = (await client.query(`INSERT INTO payroll_scheme_versions
      (venue_id,scheme_id,version_no,mode,effective_from,config_json,created_by,created_by_name)
      VALUES ($1,$2,2,'progressive_daily','2026-09-10','{"brackets":[]}',$3,'Owner A') RETURNING id`, [venueA, schemeA, ownerA])).rows[0].id;
    await expectSqlFailure(`UPDATE payroll_scheme_versions
      SET status='active',status_changed_by=$2,status_changed_by_name='Owner A',status_changed_at=now()
      WHERE venue_id=$1 AND id=$3`, [venueA, ownerA, overlapVersion], '23P01',
    'active version windows cannot overlap');

    await client.query(`UPDATE payroll_scheme_versions
      SET status='retired',effective_to='2026-09-14',status_changed_by=$2,status_changed_by_name='Owner A',status_changed_at=now()
      WHERE venue_id=$1 AND id=$3`, [venueA, ownerA, versionA]);
    const nextVersion = (await client.query(`INSERT INTO payroll_scheme_versions
      (venue_id,scheme_id,version_no,mode,effective_from,config_json,created_by,created_by_name)
      VALUES ($1,$2,3,'progressive_daily','2026-09-15','{"brackets":[]}',$3,'Owner A') RETURNING id`, [venueA, schemeA, ownerA])).rows[0].id;
    await client.query(`INSERT INTO payroll_role_assignments
      (venue_id,scheme_version_id,employee_id,role_key,effective_from,created_by,created_by_name)
      VALUES ($1,$2,$3,'bartender','2026-09-15',$4,'Owner A')`, [venueA, nextVersion, staffA, ownerA]);
    await client.query(`UPDATE payroll_scheme_versions
      SET status='active',status_changed_by=$2,status_changed_by_name='Owner A',status_changed_at=now()
      WHERE venue_id=$1 AND id=$3`, [venueA, ownerA, nextVersion]);
    await expectSqlFailure(`INSERT INTO payroll_role_assignments
      (venue_id,scheme_version_id,employee_id,role_key,effective_from,created_by,created_by_name)
      VALUES ($1,$2,$3,'bartender','2026-09-01',$4,'Owner A')`, [venueA, versionA, staffA, ownerA], '55000',
    'active version configuration is frozen');
    await expectSqlFailure("UPDATE payroll_scheme_versions SET config_json='{}'::jsonb WHERE venue_id=$1 AND id=$2", [venueA, versionA], '55000',
      'active version parameters cannot be rewritten');

    const order = (await client.query("INSERT INTO orders (venue_id,opened_by,status) VALUES ($1,$2,'closed') RETURNING id", [venueA, ownerA])).rows[0].id;
    const orderItem = (await client.query('INSERT INTO order_items (order_id,product_id,quantity,unit_price,status) VALUES ($1,$2,1,100,\'ready\') RETURNING id', [order, productA])).rows[0].id;
    const run = (await client.query(`INSERT INTO payroll_calculation_runs
      (venue_id,scheme_version_id,venue_timezone,currency,period_from,period_to,status,source_coverage,commission_basis,eligible_line_count,
       unattributed_line_count,missing_net_line_count,input_watermark,input_checksum,engine_version,idempotency_key,created_by,created_by_name)
      VALUES ($1,$2,$3,'RUB','2026-09-01','2026-09-14','ready','complete','net_after_discounts_refunds',1,0,0,
       'qa-watermark','${'a'.repeat(64)}','payroll-schemes-v1','run-a',$4,'Owner A') RETURNING id`, [venueA, versionA, venueTimezone, ownerA])).rows[0].id;
    assert.deepEqual((await client.query('SELECT venue_timezone,currency FROM payroll_calculation_runs WHERE venue_id=$1 AND id=$2', [venueA, run])).rows[0],
      { venue_timezone: venueTimezone, currency: 'RUB' }, 'new run persists immutable venue timezone and scheme currency snapshots');
    await expectSqlFailure(`INSERT INTO payroll_calculation_runs
      (venue_id,scheme_version_id,period_from,period_to,status,source_coverage,commission_basis,eligible_line_count,
       unattributed_line_count,missing_net_line_count,input_watermark,input_checksum,engine_version,idempotency_key,created_by,created_by_name)
      VALUES ($1,$2,'2026-09-01','2026-09-14','blocked','unknown','unknown',0,0,0,
       'missing-metadata','${'e'.repeat(64)}','payroll-schemes-v1','run-no-metadata',$3,'Owner A')`, [venueA, versionA, ownerA], '23514',
    'new runs cannot omit immutable timezone and currency snapshots');
    await expectSqlFailure(`INSERT INTO payroll_calculation_runs
      (venue_id,scheme_version_id,venue_timezone,currency,period_from,period_to,status,source_coverage,commission_basis,eligible_line_count,
       unattributed_line_count,missing_net_line_count,input_watermark,engine_version,blocked_reason,idempotency_key,created_by,created_by_name)
      VALUES ($1,$2,'Not/A_Timezone','RUB','2026-09-01','2026-09-14','blocked','unknown','unknown',0,0,0,
       'invalid-zone','payroll-schemes-v1','Fixture','run-invalid-zone',$3,'Owner A')`, [venueA, versionA, ownerA], '23514',
    'new runs reject timezone values that are absent from the IANA timezone catalog');
    await expectSqlFailure(`INSERT INTO payroll_calculation_runs
      (venue_id,scheme_version_id,venue_timezone,currency,period_from,period_to,status,source_coverage,commission_basis,eligible_line_count,
       unattributed_line_count,missing_net_line_count,input_watermark,engine_version,blocked_reason,idempotency_key,created_by,created_by_name)
      VALUES ($1,$2,'Asia/Yekaterinburg','RUB','2026-09-01','2026-09-14','blocked','unknown','unknown',0,0,0,
       'mismatched-zone','payroll-schemes-v1','Fixture','run-mismatched-zone',$3,'Owner A')`, [venueA, versionA, ownerA], '23514',
    'new runs cannot snapshot a timezone that differs from their venue');
    await expectSqlFailure(`INSERT INTO payroll_calculation_runs
      (venue_id,scheme_version_id,venue_timezone,currency,period_from,period_to,status,source_coverage,commission_basis,eligible_line_count,
       unattributed_line_count,missing_net_line_count,input_watermark,engine_version,blocked_reason,idempotency_key,created_by,created_by_name)
      VALUES ($1,$2,$3,'USD','2026-09-01','2026-09-14','blocked','unknown','unknown',0,0,0,
       'mismatched-currency','payroll-schemes-v1','Fixture','run-mismatched-currency',$4,'Owner A')`,
    [venueA, versionA, venueTimezone, ownerA], '23514', 'new runs cannot snapshot a currency that differs from their scheme version');
    await expectSqlFailure(`INSERT INTO payroll_calculation_runs
      (venue_id,scheme_version_id,venue_timezone,currency,period_from,period_to,status,source_coverage,commission_basis,eligible_line_count,
       unattributed_line_count,missing_net_line_count,input_watermark,input_checksum,engine_version,idempotency_key,created_by,created_by_name)
      VALUES ($1,$2,$3,'RUB','2026-09-01','2026-09-14','ready','incomplete','unknown',1,1,1,
       'qa-watermark',NULL,'payroll-schemes-v1','run-invalid',$4,'Owner A')`, [venueA, versionA, venueTimezone, ownerA], '23514',
    'a run with missing actor/net proof cannot be marked ready');
    await expectSqlFailure(`INSERT INTO payroll_calculation_runs
      (venue_id,scheme_version_id,venue_timezone,currency,period_from,period_to,status,source_coverage,commission_basis,eligible_line_count,
       unattributed_line_count,missing_net_line_count,input_watermark,input_checksum,engine_version,idempotency_key,created_by,created_by_name)
      VALUES ($1,$2,$3,'RUB','2026-09-01','2026-09-14','ready','complete','net_after_discounts_refunds',1,0,0,
       'qa-watermark','${'b'.repeat(64)}','payroll-schemes-v1','run-a',$4,'Owner A')`, [venueA, versionA, venueTimezone, ownerA], '23505',
    'run idempotency key is venue-unique');

    const snapshot = (await client.query(`INSERT INTO payroll_daily_snapshots
      (venue_id,run_id,employee_id,employee_name_snapshot,role_key_snapshot,local_date,eligible_shift_count,
       venue_turnover,cumulative_venue_turnover,base_pay,commission_pay,milestone_bonus,item_adjustments,
       amount_before_cap,cap_amount,cap_reduction,final_amount)
      VALUES ($1,$2,$3,'Staff A','bartender','2026-09-01',1,100,100,10,10,0,0,20,30,0,20) RETURNING id`,
    [venueA, run, staffA])).rows[0].id;
    const line = (await client.query(`INSERT INTO payroll_daily_snapshot_lines
      (venue_id,run_id,snapshot_id,order_id,order_item_id,employee_id,employee_name_snapshot,
       menu_item_id,menu_item_name_snapshot,department_key,sold_at,local_date,quantity,gross_amount,
       discount_amount,refund_amount,commission_base_net,applied_rate_bps,item_rule_id,commission_amount)
      VALUES ($1,$2,$3,$4,$5,$6,'Staff A',$7,'Payroll item A','bar','2026-09-01T12:00:00Z',
       '2026-09-01',1,100,10,0,90,1000,$8,9) RETURNING id`,
    [venueA, run, snapshot, order, orderItem, staffA, productA, itemRuleA])).rows[0].id;
    await expectSqlFailure(`INSERT INTO payroll_daily_snapshot_lines
      (venue_id,run_id,snapshot_id,order_id,order_item_id,employee_id,employee_name_snapshot,
       menu_item_id,menu_item_name_snapshot,department_key,sold_at,local_date,quantity,gross_amount,
       discount_amount,refund_amount,commission_base_net,applied_rate_bps,commission_amount)
      VALUES ($1,$2,$3,$4,$5,$6,'Staff A',$7,'Payroll item A','bar','2026-09-01T12:00:00Z',
       '2026-09-01',1,100,0,0,100,1000,10)`,
    [venueA, run, snapshot, order, orderItem, staffA, productA], '23505', 'one source line cannot be snapshotted twice in a run');
    await expectSqlFailure("UPDATE payroll_daily_snapshots SET final_amount=final_amount WHERE venue_id=$1 AND id=$2", [venueA, snapshot], '55000',
      'daily snapshots reject even no-op updates');
    await expectSqlFailure('DELETE FROM payroll_daily_snapshot_lines WHERE venue_id=$1 AND id=$2', [venueA, line], '55000',
      'snapshot lines reject delete');
    const blockedRun = (await client.query(`INSERT INTO payroll_calculation_runs
      (venue_id,scheme_version_id,venue_timezone,currency,period_from,period_to,status,source_coverage,commission_basis,eligible_line_count,
       unattributed_line_count,missing_net_line_count,input_watermark,engine_version,blocked_reason,idempotency_key,created_by,created_by_name)
      VALUES ($1,$2,$3,'RUB','2026-09-15','2026-09-30','blocked','incomplete','unknown',1,1,1,'incomplete-watermark',
       'payroll-schemes-v1','missing line attribution and net amount','blocked-run',$4,'Owner A') RETURNING id`,
    [venueA, nextVersion, venueTimezone, ownerA])).rows[0].id;
    await expectSqlFailure(`INSERT INTO payroll_daily_snapshots
      (venue_id,run_id,employee_id,employee_name_snapshot,role_key_snapshot,local_date,amount_before_cap,final_amount)
      VALUES ($1,$2,$3,'Staff A','bartender','2026-09-15',0,0)`, [venueA, blockedRun, staffA], '55000',
    'blocked source run cannot produce a snapshot');

    const adjustment = (await client.query(`INSERT INTO payroll_adjustments
      (venue_id,source_snapshot_line_id,employee_id,source_kind,source_key,source_allocation_key,amount_delta,
       reason,idempotency_key,created_by,created_by_name)
      VALUES ($1,$2,$3,'refund','refund-source-1','allocation-1',-9,'Late refund after closed run',
       'adj-1',$4,'Owner A') RETURNING id`, [venueA, line, staffA, ownerA])).rows[0].id;
    await expectSqlFailure(`INSERT INTO payroll_adjustments
      (venue_id,source_snapshot_line_id,employee_id,source_kind,source_key,source_allocation_key,amount_delta,
       reason,idempotency_key,created_by,created_by_name)
      VALUES ($1,$2,$3,'refund','refund-source-wrong-employee','allocation-1',-1,'Wrong employee attribution',
       'adj-wrong-employee',$4,'Owner A')`, [venueA, line, staffOtherA, ownerA], '23514',
    'refund adjustment employee must match the original sale line');
    await expectSqlFailure(`INSERT INTO payroll_adjustments
      (venue_id,source_snapshot_line_id,employee_id,source_kind,source_key,source_allocation_key,amount_delta,
       reason,idempotency_key,created_by,created_by_name)
      VALUES ($1,$2,$3,'refund','refund-source-positive','allocation-1',1,'Refund cannot increase commission',
       'adj-positive-refund',$4,'Owner A')`, [venueA, line, staffA, ownerA], '23514',
    'refund and void adjustment amounts are always negative');
    await expectSqlFailure(`INSERT INTO payroll_adjustments
      (venue_id,source_snapshot_line_id,employee_id,source_kind,source_key,source_allocation_key,amount_delta,
       reason,idempotency_key,created_by,created_by_name)
      VALUES ($1,$2,$3,'refund','refund-source-2','allocation-2',-0.01,'Refund exceeds source line commission',
       'adj-over-line-cap',$4,'Owner A')`, [venueA, line, staffA, ownerA], '23514',
    'refund/void adjustments cannot cumulatively exceed original line commission');
    const targetRun = (await client.query(`INSERT INTO payroll_calculation_runs
      (venue_id,scheme_version_id,venue_timezone,currency,period_from,period_to,status,source_coverage,commission_basis,eligible_line_count,
       unattributed_line_count,missing_net_line_count,input_watermark,input_checksum,engine_version,idempotency_key,created_by,created_by_name)
      VALUES ($1,$2,$3,'RUB','2026-10-01','2026-10-14','ready','complete','net_after_discounts_refunds',0,0,0,
       'target-watermark','${'c'.repeat(64)}','payroll-schemes-v1','target-run',$4,'Owner A') RETURNING id`, [venueA, nextVersion, venueTimezone, ownerA])).rows[0].id;
    await client.query(`INSERT INTO payroll_daily_snapshots
      (venue_id,run_id,employee_id,employee_name_snapshot,role_key_snapshot,local_date,amount_before_cap,final_amount)
      VALUES ($1,$2,$3,'Staff A','bartender','2026-10-01',0,0)`, [venueA, targetRun, staffA]);
    await expectSqlFailure(`INSERT INTO payroll_adjustment_applications
      (venue_id,adjustment_id,target_run_id,applied_amount,created_by,created_by_name)
      VALUES ($1,$2,$3,1,$4,'Owner A')`, [venueA, adjustment, run, ownerA], '23514',
    'late adjustment cannot be applied to the closed source period');
    await client.query(`INSERT INTO payroll_adjustment_applications
      (venue_id,adjustment_id,target_run_id,applied_amount,created_by,created_by_name)
      VALUES ($1,$2,$3,4,$4,'Owner A')`, [venueA, adjustment, targetRun, ownerA]);
    await expectSqlFailure(`INSERT INTO payroll_adjustment_applications
      (venue_id,adjustment_id,target_run_id,applied_amount,created_by,created_by_name)
      VALUES ($1,$2,$3,4,$4,'Owner A')`, [venueA, adjustment, targetRun, ownerA], '23505',
    'one adjustment is applied only once per target run');
    const targetRun2 = (await client.query(`INSERT INTO payroll_calculation_runs
      (venue_id,scheme_version_id,venue_timezone,currency,period_from,period_to,status,source_coverage,commission_basis,eligible_line_count,
       unattributed_line_count,missing_net_line_count,input_watermark,input_checksum,engine_version,idempotency_key,created_by,created_by_name)
      VALUES ($1,$2,$3,'RUB','2026-10-15','2026-10-31','ready','complete','net_after_discounts_refunds',0,0,0,
       'target-watermark-2','${'d'.repeat(64)}','payroll-schemes-v1','target-run-2',$4,'Owner A') RETURNING id`, [venueA, nextVersion, venueTimezone, ownerA])).rows[0].id;
    await client.query(`INSERT INTO payroll_daily_snapshots
      (venue_id,run_id,employee_id,employee_name_snapshot,role_key_snapshot,local_date,amount_before_cap,final_amount)
      VALUES ($1,$2,$3,'Staff A','bartender','2026-10-15',0,0)`, [venueA, targetRun2, staffA]);
    await expectSqlFailure(`INSERT INTO payroll_adjustment_applications
      (venue_id,adjustment_id,target_run_id,applied_amount,created_by,created_by_name)
      VALUES ($1,$2,$3,6,$4,'Owner A')`, [venueA, adjustment, targetRun2, ownerA], '23514',
    'cumulative adjustment applications cannot exceed refund source amount');

    assert.deepEqual((await client.query('SELECT id,amount,status FROM payroll_entries WHERE id=$1', [legacyEntry.id])).rows[0], legacyEntry,
      'migration and isolated writes leave existing payroll lifecycle entry unchanged');
    assert.deepEqual((await client.query('SELECT id,amount,source FROM expenses WHERE id=$1', [legacyExpense.id])).rows[0], legacyExpense,
      'calculation snapshots and adjustments do not create or change expenses');
    assert.equal((await client.query('SELECT count(*)::int AS count FROM expenses WHERE venue_id=$1 AND source=\'payroll\'', [venueA])).rows[0].count, 0,
      'no payroll expense is generated before existing payout lifecycle');

    let serviceSavepointId = 0;
    const servicePool = {
      query: (...args) => client.query(...args),
      async connect() {
        const savepoint = `payroll_service_${++serviceSavepointId}`;
        return {
          async query(sql, params) {
            const command = String(sql).trim().toUpperCase();
            if (command.startsWith('BEGIN')) return client.query(`SAVEPOINT ${savepoint}`);
            if (command === 'COMMIT') return client.query(`RELEASE SAVEPOINT ${savepoint}`);
            if (command === 'ROLLBACK') {
              await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
              return client.query(`RELEASE SAVEPOINT ${savepoint}`);
            }
            return client.query(sql, params);
          },
          release() {}
        };
      }
    };
    const payrollService = makeService(servicePool);
    const principalA = { venueId: venueA, userId: ownerA };
    const draftDefinition = {
      mode: 'progressive_daily', currency: 'RUB', effectiveFrom: '2026-11-01', effectiveTo: '2026-11-30',
      roleParameters: { bartender: { perShiftCents: 10000, bracketRatesBps: { 0: 1000 }, milestoneBonusesCents: { 5000000: 0 } } },
      applyMilestones: true, milestoneCapPolicy: 'separate_from_shift_cap',
      roleAssignments: [
        { employeeId: staffA, roleId: 'bartender', effectiveFrom: '2026-11-01', effectiveTo: '2026-11-30' },
        { employeeId: staffOtherA, roleId: 'bartender', effectiveFrom: '2026-11-01', effectiveTo: '2026-11-30' }
      ],
      employeeOverrides: [{ employeeId: staffOtherA, path: 'perShiftCents', mode: 'override', value: 0, effectiveFrom: '2026-11-01', effectiveTo: '2026-11-30' }],
      itemRules: [{ menuItemId: productA, roleId: 'bartender', mode: 'additive', rateBps: 100, priority: 5 }]
    };
    await assert.rejects(payrollService.listSchemes({ venueId: venueA, userId: staffA }),
      (error) => error instanceof PayrollSchemeServiceError && error.status === 403 && error.code === 'payroll_scheme_owner_only',
      'staff cannot read payroll configuration');
    await assert.rejects(payrollService.listSchemes({ venueId: venueB, userId: ownerA }),
      (error) => error instanceof PayrollSchemeServiceError && error.status === 403,
      'owner identity cannot be replayed against another venue');
    await assert.rejects(payrollService.createScheme({ venueId: venueA, userId: staffA }, { name: 'Forbidden', definition: draftDefinition }),
      (error) => error instanceof PayrollSchemeServiceError && error.status === 403,
      'staff cannot create or mutate payroll configuration');
    const createdScheme = await payrollService.createScheme(principalA, {
      name: 'Owner QA scheme', description: 'owner-only service contract', definition: draftDefinition,
      createdBy: ownerB, createdByName: 'Forged actor'
    });
    const createdVersion = createdScheme.versions[0];
    assert.equal(createdVersion.status, 'draft');
    assert.equal(createdVersion.roleParameters.bartender.perShiftCents, 10000);
    assert.equal(createdVersion.employeeOverrides[0].value, 0, 'explicit zero override survives readback');
    assert.ok(createdVersion.roleAssignments.some((row) => row.employeeId === staffA));
    assert.equal(createdVersion.itemRules[0].menuItemId, productA);
    assert.equal((await client.query('SELECT created_by FROM payroll_schemes WHERE venue_id=$1 AND id=$2', [venueA, createdScheme.id])).rows[0].created_by, ownerA,
      'audit actor is sourced from the authenticated owner record, not request fields');
    const createdHistory = await payrollService.listVersionRevisions(principalA, createdVersion.versionId);
    assert.equal(createdHistory.length, 1);
    assert.equal(createdHistory[0].changeKind, 'created');
    assert.equal(createdHistory[0].changedBy, ownerA);
    assert.equal(createdHistory[0].changedByName, 'owner-a', 'revision author name comes from the active owner row');
    await expectSqlFailure(`INSERT INTO payroll_scheme_version_revisions
      (venue_id,scheme_version_id,revision_no,change_kind,config_snapshot_json,changed_by,changed_by_name)
      VALUES ($1,$2,2,'edited','{}'::jsonb,$3,'Forged actor')`, [venueA, createdVersion.versionId, staffA], '42501',
    'revision inserts require an active owner actor');
    await expectSqlFailure(`INSERT INTO payroll_scheme_version_revisions
      (venue_id,scheme_version_id,revision_no,change_kind,config_snapshot_json,changed_by,changed_by_name)
      VALUES ($1,$2,3,'edited','{}'::jsonb,$3,'owner-a')`, [venueA, createdVersion.versionId, ownerA], '23514',
    'revision sequence cannot be skipped');
    await expectSqlFailure(`UPDATE payroll_scheme_versions SET effective_to='2026-11-15'
      WHERE venue_id=$1 AND id=$2`, [venueA, createdVersion.versionId], '23514',
    'draft window cannot exclude existing role assignments or overrides');
    const editedDefinition = {
      ...draftDefinition,
      effectiveTo: '2026-11-15',
      roleParameters: { bartender: { perShiftCents: 12000, bracketRatesBps: { 0: 1000 }, milestoneBonusesCents: { 5000000: 0 } } }
    };
    editedDefinition.roleAssignments = draftDefinition.roleAssignments.map((row) => ({ ...row, effectiveTo: '2026-11-15' }));
    editedDefinition.employeeOverrides = draftDefinition.employeeOverrides.map((row) => ({ ...row, effectiveTo: '2026-11-15' }));
    const replaced = await payrollService.replaceDraftVersion(principalA, createdVersion.versionId, editedDefinition);
    assert.equal(replaced.roleParameters.bartender.perShiftCents, 12000);
    assert.equal(replaced.effectiveTo, '2026-11-15');
    assert.equal(replaced.itemRules.length, 1, 'draft child configuration is atomically replaced');
    const editedHistory = await payrollService.listVersionRevisions(principalA, createdVersion.versionId);
    assert.equal(editedHistory.length, 2);
    assert.equal(editedHistory[1].changeKind, 'edited');
    assert.equal(editedHistory[1].snapshot.roleParameters.bartender.perShiftCents, 12000);
    await assert.rejects(payrollService.getVersion({ venueId: venueB, userId: ownerB }, createdVersion.versionId),
      (error) => error instanceof PayrollSchemeServiceError && error.status === 404 && error.code === 'payroll_scheme_version_not_found',
      'same-role owner of another venue cannot read this version');
    const activeVersion = await payrollService.activateVersion(principalA, createdVersion.versionId);
    assert.equal(activeVersion.status, 'active');
    const activeHistory = await payrollService.listVersionRevisions(principalA, createdVersion.versionId);
    assert.equal(activeHistory.length, 3);
    assert.equal(activeHistory[2].changeKind, 'activated');
    await assert.rejects(payrollService.listVersionRevisions({ venueId: venueB, userId: ownerB }, createdVersion.versionId),
      (error) => error instanceof PayrollSchemeServiceError && error.status === 404,
      'revision journal is tenant-scoped');
    await expectSqlFailure('DELETE FROM payroll_scheme_version_revisions WHERE venue_id=$1 AND scheme_version_id=$2',
      [venueA, createdVersion.versionId], '55000', 'scheme audit revisions cannot be deleted');
    await expectSqlFailure('TRUNCATE payroll_scheme_version_revisions', [], '55000', 'scheme audit revisions cannot be truncated');
    await expectSqlFailure('DELETE FROM payroll_item_commission_rules WHERE venue_id=$1 AND id=$2', [venueA, activeVersion.itemRules[0].id], '55000',
      'active version item commission rules remain immutable');
    await assert.rejects(payrollService.replaceDraftVersion(principalA, createdVersion.versionId, draftDefinition),
      (error) => error instanceof PayrollSchemeServiceError && error.status === 409 && error.code === 'payroll_scheme_version_immutable',
      'active scheme configuration cannot be rewritten');
    const overlappingVersion = await payrollService.createVersion(principalA, createdScheme.id, draftDefinition);
    const foreignCurrencyVersion = await payrollService.createVersion(principalA, createdScheme.id, { ...draftDefinition, currency: 'USD' });
    const previewInput = {
      employees: [
        { id: staffA, activeFrom: '2026-11-01', activeTo: '2026-11-30' },
        { id: staffOtherA, activeFrom: '2026-11-01', activeTo: '2026-11-30' }
      ],
      periodFrom: '2026-11-01', periodTo: '2026-11-01',
      coverage: { kind: 'month_to_date_complete', from: '2026-11-01', through: '2026-11-01', complete: true, watermark: 'owner-scenario-v1' },
      sales: [{ id: 'scenario-line', date: '2026-11-01', employeeId: staffA, menuItemId: productA,
        department: 'bar', turnoverCents: 10000, commissionBaseCents: 10000 }]
    };
    const payrollStateBeforePreview = await client.query(`SELECT
      (SELECT count(*)::int FROM payroll_calculation_runs WHERE venue_id=$1) AS runs,
      (SELECT count(*)::int FROM payroll_daily_snapshots WHERE venue_id=$1) AS snapshots,
      (SELECT count(*)::int FROM payroll_entries WHERE venue_id=$1) AS entries,
      (SELECT count(*)::int FROM expenses WHERE venue_id=$1 AND source='payroll') AS expenses`, [venueA]);
    const previewResult = await payrollService.preview(principalA, createdVersion.versionId, previewInput);
    assert.equal(previewResult.official, false);
    assert.equal(previewResult.persistence, 'none');
    assert.equal(previewResult.result.status, 'ready');
    assert.equal(previewResult.result.employees.find((row) => row.employeeId === staffA).amountCents, 13100);
    await assert.rejects(payrollService.preview(principalA, createdVersion.versionId, { ...previewInput, employees: Array(501).fill({ id: staffA }) }),
      (error) => error instanceof PayrollSchemeServiceError && error.status === 413 && error.code === 'preview_input_too_large',
      'oversized employee scenarios are rejected by the service before calculation');
    await assert.rejects(payrollService.compare(principalA, [overlappingVersion.versionId, createdVersion.versionId],
      { ...previewInput, sales: Array(20001).fill(previewInput.sales[0]) }, createdVersion.versionId),
    (error) => error instanceof PayrollSchemeServiceError && error.status === 413 && error.code === 'preview_input_too_large',
    'oversized sales comparisons are rejected by the service before calculation');
    const tooManyAssignments = { ...draftDefinition, roleAssignments: Array(15001).fill(draftDefinition.roleAssignments[0]) };
    await assert.rejects(payrollService.createVersion(principalA, createdScheme.id, tooManyAssignments),
      (error) => error instanceof PayrollSchemeServiceError && error.status === 413 && error.code === 'scheme_definition_too_large',
      'oversized combined scheme child rows are rejected before writes');
    const comparison = await payrollService.compare(principalA, [overlappingVersion.versionId, createdVersion.versionId], previewInput, createdVersion.versionId);
    const baselineComparison = comparison.comparisons.find((row) => row.versionId === createdVersion.versionId);
    const draftComparison = comparison.comparisons.find((row) => row.versionId === overlappingVersion.versionId);
    assert.equal(comparison.official, false);
    assert.equal(baselineComparison.totalCents, 13100);
    assert.equal(baselineComparison.deltaToBaselineCents, 0);
    assert.equal(draftComparison.totalCents, 11100);
    assert.equal(draftComparison.deltaToBaselineCents, -2000);
    await assert.rejects(payrollService.compare(principalA, [createdVersion.versionId, foreignCurrencyVersion.versionId], previewInput, createdVersion.versionId),
      (error) => error instanceof PayrollSchemeServiceError && error.status === 400 && error.code === 'comparison_currency_mismatch',
      'comparison rejects schemes with different currencies instead of adding unlike cents');
    const payrollStateAfterPreview = await client.query(`SELECT
      (SELECT count(*)::int FROM payroll_calculation_runs WHERE venue_id=$1) AS runs,
      (SELECT count(*)::int FROM payroll_daily_snapshots WHERE venue_id=$1) AS snapshots,
      (SELECT count(*)::int FROM payroll_entries WHERE venue_id=$1) AS entries,
      (SELECT count(*)::int FROM expenses WHERE venue_id=$1 AND source='payroll') AS expenses`, [venueA]);
    assert.deepEqual(payrollStateAfterPreview.rows[0], payrollStateBeforePreview.rows[0],
      'scenario preview and comparison do not persist runs, payroll entries, or expenses');
    await assert.rejects(payrollService.activateVersion(principalA, overlappingVersion.versionId),
      (error) => error instanceof PayrollSchemeServiceError && error.status === 409 && error.code === 'payroll_scheme_effective_window_conflict',
      'database overlap guard is preserved at service activation');
    assert.ok((await payrollService.listSchemes(principalA)).some((row) => row.id === createdScheme.id), 'owner can read persisted schemes after mutation');
    console.log('PAYROLL SCHEME MIGRATION CONTRACT: STATIC + POSTGRESQL PASS (replay, tenant FKs, owner-only version CRUD, draft edits, immutable activation, revision audit, non-persisted scenarios, source gates and adjustment lineage; rollback isolated schema)');
  } finally {
    if (transaction) await client.query('ROLLBACK').catch(() => {});
    if (client._connected) await client.end();
  }
}
