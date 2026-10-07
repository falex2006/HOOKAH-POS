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
const attendanceMigrationPath = path.join(root, 'migrations', '082_payroll_attendance_approvals.sql');
const attendanceMigration = fs.readFileSync(attendanceMigrationPath, 'utf8');
const personalTargetMigrationPath = path.join(root, 'migrations', '083_payroll_personal_target.sql');
const personalTargetMigration = fs.readFileSync(personalTargetMigrationPath, 'utf8');
const teamFundMigrationPath = path.join(root, 'migrations', '085_payroll_team_fund.sql');
const teamFundMigration = fs.readFileSync(teamFundMigrationPath, 'utf8');
const marginMigrationPath = path.join(root, 'migrations', '086_payroll_margin_target.sql');
const marginMigration = fs.readFileSync(marginMigrationPath, 'utf8');
assert.match(marginMigration, /personal_target','team_fund','margin_target/);
assert.match(marginMigration, /teamWeight\|lossPolicy\|itemRuleBasis/);
assert.doesNotMatch(marginMigration, /\b(?:INSERT|UPDATE|DELETE|TRUNCATE)\b/i);
assert.match(teamFundMigration, /personal_target','team_fund/);
assert.match(teamFundMigration, /excessRatePolicy\|teamWeight/);
assert.doesNotMatch(teamFundMigration, /\b(?:INSERT|UPDATE|DELETE|TRUNCATE)\b/i);
assert.match(personalTargetMigration, /DROP CONSTRAINT IF EXISTS payroll_scheme_versions_mode_check/);
assert.match(personalTargetMigration, /personal_target/);
assert.match(personalTargetMigration, /targetCents\|baseRateBps\|bonusRateBps\|excessRatePolicy/);
assert.doesNotMatch(personalTargetMigration, /\b(?:INSERT|UPDATE|DELETE|TRUNCATE)\b/i, '083 changes configuration checks without rewriting any facts or history');

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
for (const table of ['payroll_attendance_approvals', 'payroll_attendance_approval_shifts', 'payroll_attendance_approval_intervals']) {
  assert.match(attendanceMigration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`), `${table} is additive and replay-safe`);
  assert.match(attendanceMigration, new RegExp(`BEFORE UPDATE OR DELETE ON %I`), `${table} is append-only`);
}
assert.match(attendanceMigration, /BEFORE TRUNCATE ON %I/, 'attendance snapshots reject truncate');
assert.match(attendanceMigration, /FOREIGN KEY \(venue_id, approved_by\) REFERENCES users \(venue_id, id\)/,
  'approval author is tenant-bound');
assert.match(attendanceMigration, /date_trunc\('month', period_from::timestamp\) = date_trunc\('month', period_to::timestamp\)/,
  'attendance approval periods cannot cross calendar months');
assert.doesNotMatch(attendanceMigration, /\b(INSERT\s+INTO\s+payroll_entries|INSERT\s+INTO\s+expenses|UPDATE\s+staff_schedules|UPDATE\s+staff_work_logs)\b/i,
  'attendance approval never changes HR facts or creates a financial posting');

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
  const { makePayrollCalculationRunService, PayrollCalculationRunError } = require(path.join(root, 'payroll-calculation-run-service.js'));
  const { makePayrollAttendanceManifestService, PayrollAttendanceError } = require(path.join(root, 'payroll-attendance-manifest.js'));
  const client = new Client({ connectionString: databaseUrl });
  const schema = `payroll_migration_qa_${process.pid}_${Date.now()}`;
  const quotedSchema = `"${schema}"`;
  let transaction = false;
  let schemaCommitted = false;
  let releaseConcurrentInsertBarrier = null;
  const concurrentClients = new Set();
  const closingConcurrentClients = [];
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
    await runSql(path.join('migrations', '083_payroll_personal_target.sql'));
    await runSql(path.join('migrations', '083_payroll_personal_target.sql'));

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
    await runSql(path.join('migrations', '082_payroll_attendance_approvals.sql'));
    await runSql(path.join('migrations', '082_payroll_attendance_approvals.sql'));
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

    const order = (await client.query("INSERT INTO orders (venue_id,opened_by,status,closed_at,final_total_snapshot) VALUES ($1,$2,'closed','2026-11-01T12:00:00Z',1200) RETURNING id", [venueA, ownerA])).rows[0].id;
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
    const principalB = { venueId: venueB, userId: ownerB };
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
    const payoutRiskAcknowledgement = { confirmed: true, policyCode: 'payroll-own-revenue-ceiling-v1' };
    await assert.rejects(payrollService.listSchemes({ venueId: venueA, userId: staffA }),
      (error) => error instanceof PayrollSchemeServiceError && error.status === 403 && error.code === 'payroll_scheme_owner_only',
      'staff cannot read payroll configuration');
    await assert.rejects(payrollService.listSchemes({ venueId: venueB, userId: ownerA }),
      (error) => error instanceof PayrollSchemeServiceError && error.status === 403,
      'owner identity cannot be replayed against another venue');
    await assert.rejects(payrollService.createScheme({ venueId: venueA, userId: staffA }, { name: 'Forbidden', definition: draftDefinition }),
      (error) => error instanceof PayrollSchemeServiceError && error.status === 403,
      'staff cannot create or mutate payroll configuration');
    const schemeCountBeforeMissingRiskAcknowledgement = Number((await client.query('SELECT count(*) FROM payroll_schemes WHERE venue_id=$1', [venueA])).rows[0].count);
    await assert.rejects(payrollService.createScheme(principalA, { name: 'Missing acknowledgement', definition: draftDefinition }),
      (error) => error instanceof PayrollSchemeServiceError && error.status === 400 && error.code === 'payroll_risk_acknowledgement_required',
      'owner must explicitly acknowledge the non-waivable payout ceiling before saving any scheme version');
    assert.equal(Number((await client.query('SELECT count(*) FROM payroll_schemes WHERE venue_id=$1', [venueA])).rows[0].count), schemeCountBeforeMissingRiskAcknowledgement,
      'missing acknowledgement rolls back scheme parent creation atomically');
    const targetDefinition = {
      ...draftDefinition, mode: 'personal_target', applyMilestones: false, itemRules: [],
      roleParameters: { bartender: { perShiftCents: 0, targetCents: 10000, baseRateBps: 1600, bonusRateBps: 6500, excessRatePolicy: 'replace_base' } },
      employeeOverrides: [{ employeeId: staffOtherA, path: 'targetCents', mode: 'override', value: 0, effectiveFrom: '2026-11-01', effectiveTo: '2026-11-30' }]
    };
    await client.query(`ALTER TABLE payroll_scheme_versions DROP CONSTRAINT payroll_scheme_versions_mode_check;
      ALTER TABLE payroll_scheme_versions ADD CONSTRAINT payroll_scheme_versions_mode_check
      CHECK (mode IN ('progressive_daily','stable_percent','percent_only','final_month_threshold'))`);
    await assert.rejects(payrollService.createScheme(principalA, { name: 'Old schema personal target QA', definition: targetDefinition, payoutRiskAcknowledgement }),
      (error) => error.code === 'payroll_personal_target_schema_required' && error.status === 409);
    assert.equal(Number((await client.query('SELECT count(*) FROM payroll_schemes WHERE venue_id=$1', [venueA])).rows[0].count), schemeCountBeforeMissingRiskAcknowledgement,
      'old schema rejection rolls back target scheme parent and acknowledgement together');
    await runSql(path.join('migrations', '083_payroll_personal_target.sql'));
    const targetScheme = await payrollService.createScheme(principalA, { name: 'Daily personal target QA', definition: targetDefinition, payoutRiskAcknowledgement });
    const targetVersionId = targetScheme.versions[0].versionId;
    assert.equal((await payrollService.getVersion(principalA, targetVersionId)).roleParameters.bartender.targetCents, 10000);
    assert.equal((await payrollService.getVersion(principalA, targetVersionId)).employeeOverrides[0].value, 0);
    const targetInput = {
      periodFrom: '2026-11-01', periodTo: '2026-11-01', employees: [{ id: staffA }, { id: staffOtherA }], attendance: [],
      coverage: { kind: 'month_to_date_complete', from: '2026-11-01', through: '2026-11-01', complete: true, watermark: 'target-scenario' },
      attendanceCoverage: { kind: 'approved_attendance_complete', from: '2026-11-01', through: '2026-11-01', complete: true, watermark: 'target-attendance-scenario' },
      sales: [{ id: 'target-line', employeeId: staffA, date: '2026-11-01', department: 'bar', turnoverCents: 15000, commissionBaseCents: 15000 }]
    };
    const targetPreview = await payrollService.preview(principalA, targetVersionId, targetInput);
    assert.equal(targetPreview.result.status, 'ready');
    assert.equal(targetPreview.result.employees.find((row) => row.employeeId === staffA).commissionCents, 4850);
    assert.equal(targetPreview.result.daily[0].employees[0].targetIncentive.roundingPolicy, 'component_half_up_v1');
    assert.equal(targetPreview.result.daily[0].lines[0].appliedRateBps, null);
    const editedTarget = await payrollService.replaceDraftVersion(principalA, targetVersionId,
      { ...targetDefinition, roleParameters: { bartender: { ...targetDefinition.roleParameters.bartender, targetCents: 0 } } }, payoutRiskAcknowledgement);
    assert.notEqual(editedTarget.payoutRiskAcknowledgement.configDigest, targetScheme.versions[0].payoutRiskAcknowledgement.configDigest);
    assert.equal((await payrollService.preview(principalA, targetVersionId, targetInput)).result.employees.find((row) => row.employeeId === staffA).commissionCents, 9750);
    const targetHistory = await payrollService.listVersionRevisions(principalA, targetVersionId);
    assert.equal(targetHistory[1].snapshot.roleParameters.bartender.targetCents, 0, 'target edit survives immutable audit readback');
    assert.equal((await payrollService.activateVersion(principalA, targetVersionId)).status, 'active');
    await assert.rejects(payrollService.replaceDraftVersion(principalA, targetVersionId, targetDefinition, payoutRiskAcknowledgement),
      (error) => error.code === 'payroll_scheme_version_immutable');
    await assert.rejects(payrollService.getVersion(principalB, targetVersionId), (error) => error.status === 404);
    const teamFund = { poolId: 'bar-hookah', targetCents: 10000, baseRateBps: 1600, bonusRateBps: 4000,
      excessRatePolicy: 'replace_base', departments: ['bar', 'hookah'], distributionPolicy: 'configured_weights' };
    const teamDefinition = { ...targetDefinition, mode: 'team_fund',
      roleParameters: { bartender: { perShiftCents: 0, teamFund, teamWeight: 1 } },
      employeeOverrides: [{ employeeId: staffOtherA, path: 'teamWeight', mode: 'override', value: 2, effectiveFrom: '2026-11-01', effectiveTo: '2026-11-30' }] };
    const schemeCountBeforeTeamUpgrade = Number((await client.query('SELECT count(*) FROM payroll_schemes WHERE venue_id=$1', [venueA])).rows[0].count);
    await assert.rejects(payrollService.createScheme(principalA, { name: 'Old schema team fund QA', definition: teamDefinition, payoutRiskAcknowledgement }),
      (error) => error.code === 'payroll_personal_target_schema_required' && error.status === 409);
    assert.equal(Number((await client.query('SELECT count(*) FROM payroll_schemes WHERE venue_id=$1', [venueA])).rows[0].count), schemeCountBeforeTeamUpgrade);
    await runSql(path.join('migrations', '085_payroll_team_fund.sql'));
    await runSql(path.join('migrations', '085_payroll_team_fund.sql'));
    const teamScheme = await payrollService.createScheme(principalA, { name: 'Daily team fund QA', definition: teamDefinition, payoutRiskAcknowledgement });
    const teamVersionId = teamScheme.versions[0].versionId;
    const teamReadback = await payrollService.getVersion(principalA, teamVersionId);
    assert.deepEqual(teamReadback.roleParameters.bartender.teamFund, teamFund);
    assert.equal(teamReadback.employeeOverrides[0].value, 2);
    const teamPreview = await payrollService.preview(principalA, teamVersionId, targetInput);
    assert.equal(teamPreview.result.status, 'ready');
    assert.equal(teamPreview.result.daily[0].teamFunds[0].fundCents, 3600);
    assert.equal(teamPreview.result.employees.find((row) => row.employeeId === staffA).teamFundCents, 1200);
    assert.equal(teamPreview.result.employees.find((row) => row.employeeId === staffOtherA).teamFundCents, 2400);
    assert.equal(teamPreview.result.payoutEligible, false, 'attendance-independent share to zero-sale member preserves own-revenue conflict');
    assert.equal(teamPreview.result.employees.find((row) => row.employeeId === staffA).commissionCents, 0, 'pooled payout is not mislabelled as author commission');
    const teamEdited = await payrollService.replaceDraftVersion(principalA, teamVersionId,
      { ...teamDefinition, employeeOverrides: [{ ...teamDefinition.employeeOverrides[0], value: 0 }] }, payoutRiskAcknowledgement);
    assert.notEqual(teamEdited.payoutRiskAcknowledgement.configDigest, teamReadback.payoutRiskAcknowledgement.configDigest);
    assert.equal((await payrollService.preview(principalA, teamVersionId, targetInput)).result.employees.find((row) => row.employeeId === staffA).teamFundCents, 3600);
    assert.equal((await payrollService.listVersionRevisions(principalA, teamVersionId))[1].snapshot.employeeOverrides[0].value, 0);
    assert.equal((await payrollService.activateVersion(principalA, teamVersionId)).status, 'active');
    await assert.rejects(payrollService.getVersion(principalB, teamVersionId), (error) => error.status === 404);
    const marginDefinition = { ...targetDefinition, mode: 'margin_target',
      roleParameters: { bartender: { perShiftCents: 0, targetCents: 5000, baseRateBps: 1600, bonusRateBps: 4800,
        excessRatePolicy: 'replace_base', lossPolicy: 'offset_daily_losses', itemRuleBasis: 'net_revenue' } },
      employeeOverrides: ['lossPolicy', 'itemRuleBasis', 'excessRatePolicy'].map((path) => ({ employeeId: staffOtherA, path, mode: 'override',
        value: { lossPolicy: 'offset_daily_losses', itemRuleBasis: 'net_revenue', excessRatePolicy: 'replace_base' }[path], effectiveFrom: '2026-11-01', effectiveTo: '2026-11-30' })) };
    await assert.rejects(payrollService.createScheme(principalA, { name: 'Old schema margin QA', definition: marginDefinition, payoutRiskAcknowledgement }),
      (error) => error.code === 'payroll_personal_target_schema_required' && error.status === 409);
    await runSql(path.join('migrations', '086_payroll_margin_target.sql'));
    await runSql(path.join('migrations', '086_payroll_margin_target.sql'));
    const marginScheme = await payrollService.createScheme(principalA, { name: 'Daily margin QA', definition: marginDefinition, payoutRiskAcknowledgement });
    const marginVersionId = marginScheme.versions[0].versionId;
    const marginReadback = await payrollService.getVersion(principalA, marginVersionId);
    assert.equal(marginReadback.roleParameters.bartender.lossPolicy, 'offset_daily_losses');
    assert.equal(marginReadback.employeeOverrides.find((row) => row.path === 'lossPolicy').value, 'offset_daily_losses');
    assert.equal(marginReadback.employeeOverrides.find((row) => row.path === 'itemRuleBasis').value, 'net_revenue');
    assert.equal(marginReadback.employeeOverrides.find((row) => row.path === 'excessRatePolicy').value, 'replace_base');
    const marginInput = { ...targetInput, sales: [{ ...targetInput.sales[0], costSnapshot: { id: 'net-line-cost', version: 'cost-v1', currency: 'RUB', costCents: 5000 } }] };
    const marginPreview = await payrollService.preview(principalA, marginVersionId, marginInput);
    assert.equal(marginPreview.result.status, 'ready');
    assert.equal(marginPreview.result.employees.find((row) => row.employeeId === staffA).commissionCents, 3200);
    assert.equal(marginPreview.result.daily[0].employees[0].marginIncentive.payableMarginCents, 10000);
    assert.equal(marginPreview.result.daily[0].lines[0].costSnapshot.version, 'cost-v1');
    assert.equal((await payrollService.preview(principalA, marginVersionId, targetInput)).result.status, 'blocked', 'missing cost never falls back to current menu or zero');
    const marginEdited = await payrollService.replaceDraftVersion(principalA, marginVersionId,
      { ...marginDefinition, roleParameters: { bartender: { ...marginDefinition.roleParameters.bartender, targetCents: 0 } } }, payoutRiskAcknowledgement);
    assert.notEqual(marginEdited.payoutRiskAcknowledgement.configDigest, marginReadback.payoutRiskAcknowledgement.configDigest);
    assert.equal((await payrollService.preview(principalA, marginVersionId, marginInput)).result.employees.find((row) => row.employeeId === staffA).commissionCents, 4800);
    assert.equal((await payrollService.listVersionRevisions(principalA, marginVersionId))[1].snapshot.roleParameters.bartender.targetCents, 0);
    assert.equal((await payrollService.activateVersion(principalA, marginVersionId)).status, 'active');
    await assert.rejects(payrollService.getVersion(principalB, marginVersionId), (error) => error.status === 404);
    const createdScheme = await payrollService.createScheme(principalA, {
      name: 'Owner QA scheme', description: 'owner-only service contract', definition: draftDefinition,
      payoutRiskAcknowledgement,
      createdBy: ownerB, createdByName: 'Forged actor'
    });
    const createdVersion = createdScheme.versions[0];
    assert.equal(createdVersion.status, 'draft');
    assert.equal(createdVersion.payoutRiskAcknowledgement.policyCode, payoutRiskAcknowledgement.policyCode);
    assert.equal(createdVersion.payoutRiskAcknowledgement.acknowledgedBy, ownerA, 'acknowledgement actor is taken from owner session');
    assert.equal(createdVersion.payoutRiskAcknowledgement.configDigest.length, 64, 'acknowledgement binds a normalized configuration SHA-256 digest');
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
    assert.equal(createdHistory[0].snapshot.payoutRiskAcknowledgement.configDigest, createdVersion.payoutRiskAcknowledgement.configDigest,
      'append-only version revision preserves the exact acknowledgement and digest');
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
    const oldRiskAcknowledgementDigest = createdVersion.payoutRiskAcknowledgement.configDigest;
    const replaced = await payrollService.replaceDraftVersion(principalA, createdVersion.versionId, editedDefinition, payoutRiskAcknowledgement);
    assert.notEqual(replaced.payoutRiskAcknowledgement.configDigest, oldRiskAcknowledgementDigest,
      'editing draft config requires and records acknowledgement against its new canonical digest');
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
    const runService = makePayrollCalculationRunService(servicePool);
    const blockedRequest = {
      schemeVersionId: activeVersion.versionId,
      periodFrom: '2026-11-01',
      periodTo: '2026-11-14',
      idempotencyKey: 'blocked-run-november-001'
    };
    const payrollStateBeforeBlockedRun = (await client.query(`SELECT
      (SELECT count(*)::int FROM payroll_calculation_runs WHERE venue_id=$1) AS runs,
      (SELECT count(*)::int FROM payroll_daily_snapshots WHERE venue_id=$1) AS snapshots,
      (SELECT count(*)::int FROM payroll_daily_snapshot_lines WHERE venue_id=$1) AS lines,
      (SELECT count(*)::int FROM payroll_adjustments WHERE venue_id=$1) AS adjustments,
      (SELECT count(*)::int FROM payroll_entries WHERE venue_id=$1) AS entries,
      (SELECT count(*)::int FROM expenses WHERE venue_id=$1) AS expenses`, [venueA])).rows[0];
    const blockedServiceRun = await runService.createBlockedRun(principalA, blockedRequest);
    assert.deepEqual(Object.keys(runService), ['createBlockedRun'], 'the scoped service exposes no ready-run or lifecycle mutation operation');
    assert.equal(blockedServiceRun.status, 'blocked');
    assert.equal(blockedServiceRun.source_coverage, 'unknown');
    assert.equal(blockedServiceRun.commission_basis, 'unknown');
    assert.equal(blockedServiceRun.input_checksum, null);
    assert.match(blockedServiceRun.blocked_reason, /official_payroll_sources_unavailable/);
    assert.equal(blockedServiceRun.created_by, ownerA, 'blocked run audit actor comes from the authenticated venue owner');
    assert.ok(blockedServiceRun.venue_timezone && blockedServiceRun.currency === 'RUB', 'new blocked run snapshots source timezone and version currency');
    const retriedBlockedServiceRun = await runService.createBlockedRun(principalA, blockedRequest);
    assert.equal(retriedBlockedServiceRun.id, blockedServiceRun.id, 'same venue and idempotency key returns the original immutable blocked run');
    assert.deepEqual(retriedBlockedServiceRun, blockedServiceRun, 'idempotent retry returns the full original persisted metadata');
    // Same request identity must not replay a different writer's result.
    for (const [label, state, coverage, basis, checksum, engine, counter] of [
      ['ready', 'ready', 'complete', 'net_after_discounts_refunds', 'a'.repeat(64), 'payroll-schemes-v1', 0],
      ['engine', 'blocked', 'unknown', 'unknown', null, 'other-engine', 0],
      ['counter', 'blocked', 'unknown', 'unknown', null, 'payroll-schemes-v1', 1],
      ['checksum', 'blocked', 'unknown', 'unknown', 'b'.repeat(64), 'payroll-schemes-v1', 0],
      ['watermark', 'blocked', 'unknown', 'unknown', null, 'payroll-schemes-v1', 0]
    ]) {
      await client.query('SAVEPOINT incompatible_blocked_replay');
      const key = `blocked-replay-other-${label}`;
      const watermark = label === 'watermark' ? 'foreign-source-watermark' : `blocked-source-attempt-v1:${activeVersion.versionId}:${blockedRequest.periodFrom}:${blockedRequest.periodTo}:${key}`;
      await client.query(`INSERT INTO payroll_calculation_runs
        (venue_id,scheme_version_id,venue_timezone,currency,period_from,period_to,status,source_coverage,commission_basis,
         eligible_line_count,unattributed_line_count,missing_net_line_count,input_watermark,input_checksum,engine_version,
         blocked_reason,idempotency_key,created_by,created_by_name)
        VALUES ($1,$2,$3,'RUB',$4,$5,$6,$7,$8,$9,0,0,$10,$11,$12,$13,$14,$15,'Owner A')`,
      [venueA, activeVersion.versionId, blockedServiceRun.venue_timezone, blockedRequest.periodFrom, blockedRequest.periodTo,
        state, coverage, basis, counter, watermark, checksum, engine, state === 'blocked' ? 'Different writer' : null, key, ownerA]);
      await assert.rejects(runService.createBlockedRun(principalA, { ...blockedRequest, idempotencyKey: key }),
        (error) => error instanceof PayrollCalculationRunError && error.code === 'payroll_run_idempotency_conflict' && error.status === 409,
        `blocked operation rejects incompatible ${label} identity`);
      await client.query('ROLLBACK TO SAVEPOINT incompatible_blocked_replay');
      await client.query('RELEASE SAVEPOINT incompatible_blocked_replay');
    }
    const alternateScheme = await payrollService.createScheme(principalA, {
      name: 'Alternate QA scheme', description: 'same period, different scheme identity', definition: draftDefinition, payoutRiskAcknowledgement
    });
    const alternateVersion = await payrollService.activateVersion(principalA, alternateScheme.versions[0].versionId);
    await assert.rejects(runService.createBlockedRun(principalA, { ...blockedRequest, schemeVersionId: alternateVersion.versionId }),
      (error) => error instanceof PayrollCalculationRunError && error.status === 409 && error.code === 'payroll_run_idempotency_conflict',
      'idempotency key cannot be reused for a different active scheme version');
    await assert.rejects(runService.createBlockedRun(principalA, { ...blockedRequest, periodTo: '2026-11-15' }),
      (error) => error instanceof PayrollCalculationRunError && error.status === 409 && error.code === 'payroll_run_idempotency_conflict',
      'idempotency key cannot be reused for a different payroll period');
    await assert.rejects(runService.createBlockedRun({ venueId: venueA, userId: staffA }, blockedRequest),
      (error) => error instanceof PayrollCalculationRunError && error.status === 403,
      'staff cannot create payroll calculation runs');
    await assert.rejects(runService.createBlockedRun({ venueId: venueB, userId: ownerA }, blockedRequest),
      (error) => error instanceof PayrollCalculationRunError && error.status === 403,
      'owner identity cannot be replayed against another venue');
    await assert.rejects(runService.createBlockedRun(principalA, { ...blockedRequest, schemeVersionId: '00000000-0000-4000-8000-000000009999', idempotencyKey: 'blocked-run-missing-version' }),
      (error) => error instanceof PayrollCalculationRunError && error.status === 403,
      'unavailable and cross-tenant scheme versions fail closed');
    await assert.rejects(runService.createBlockedRun(principalA, { ...blockedRequest, periodFrom: '2026-11-31', idempotencyKey: 'blocked-run-invalid-date' }),
      (error) => error instanceof PayrollCalculationRunError && error.status === 400 && error.code === 'invalid_payroll_period_from',
      'invalid calendar dates are rejected before persistence');
    await assert.rejects(runService.createBlockedRun(principalA, { ...blockedRequest, periodFrom: '2026-11-15', idempotencyKey: 'blocked-run-reversed-date' }),
      (error) => error instanceof PayrollCalculationRunError && error.status === 400 && error.code === 'invalid_payroll_period',
      'reversed periods are rejected before persistence');
    await assert.rejects(runService.createBlockedRun(principalA, { ...blockedRequest, periodTo: '2026-12-01', idempotencyKey: 'blocked-run-cross-month' }),
      (error) => error instanceof PayrollCalculationRunError && error.status === 400 && error.code === 'payroll_run_must_fit_one_month',
      'cross-month requests are rejected before persistence');
    await assert.rejects(runService.createBlockedRun(principalA, { ...blockedRequest, idempotencyKey: 'bad' }),
      (error) => error instanceof PayrollCalculationRunError && error.status === 400 && error.code === 'invalid_payroll_run_idempotency_key',
      'short idempotency keys are rejected before persistence');
    await assert.rejects(runService.createBlockedRun({ venueId: venueA, userId: 'bad' }, blockedRequest),
      (error) => error instanceof PayrollCalculationRunError && error.status === 403,
      'invalid principals cannot create payroll runs');
    await expectSqlFailure(`INSERT INTO payroll_daily_snapshots
      (venue_id,run_id,employee_id,employee_name_snapshot,role_key_snapshot,local_date,amount_before_cap,final_amount)
      VALUES ($1,$2,$3,'Staff A','bartender','2026-11-01',0,0)`,
    [venueA, blockedServiceRun.id, staffA], '55000', 'blocked runs cannot own calculation snapshots');
    await expectSqlFailure('UPDATE payroll_calculation_runs SET blocked_reason=blocked_reason WHERE venue_id=$1 AND id=$2',
      [venueA, blockedServiceRun.id], '55000', 'blocked runs remain append-only');
    await expectSqlFailure('DELETE FROM payroll_calculation_runs WHERE venue_id=$1 AND id=$2',
      [venueA, blockedServiceRun.id], '55000', 'blocked runs cannot be deleted');
    const payrollStateAfterBlockedRun = (await client.query(`SELECT
      (SELECT count(*)::int FROM payroll_calculation_runs WHERE venue_id=$1) AS runs,
      (SELECT count(*)::int FROM payroll_daily_snapshots WHERE venue_id=$1) AS snapshots,
      (SELECT count(*)::int FROM payroll_daily_snapshot_lines WHERE venue_id=$1) AS lines,
      (SELECT count(*)::int FROM payroll_adjustments WHERE venue_id=$1) AS adjustments,
      (SELECT count(*)::int FROM payroll_entries WHERE venue_id=$1) AS entries,
      (SELECT count(*)::int FROM expenses WHERE venue_id=$1) AS expenses`, [venueA])).rows[0];
    assert.deepEqual(payrollStateAfterBlockedRun, {
      ...payrollStateBeforeBlockedRun,
      runs: payrollStateBeforeBlockedRun.runs + 1
    }, 'blocked run inserts exactly one header and has no snapshot, adjustment, payroll-entry, or expense side effects');
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
    const overlappingVersion = await payrollService.createVersion(principalA, createdScheme.id, draftDefinition, payoutRiskAcknowledgement);
    await client.query(`UPDATE payroll_scheme_versions SET config_json=jsonb_set(config_json,
      '{payoutRiskAcknowledgement,configDigest}',to_jsonb($3::text)) WHERE venue_id=$1 AND id=$2`,
    [venueA, overlappingVersion.versionId, '0'.repeat(64)]);
    await assert.rejects(payrollService.activateVersion(principalA, overlappingVersion.versionId),
      (error) => error instanceof PayrollSchemeServiceError && error.status === 409 && error.code === 'payroll_risk_acknowledgement_required',
      'activation refuses acknowledgement whose digest does not match the locked current configuration');
    assert.equal((await payrollService.getVersion(principalA, overlappingVersion.versionId)).status, 'draft',
      'stale acknowledgement never activates a version');
    await client.query(`UPDATE payroll_scheme_versions SET config_json=jsonb_set(config_json,
      '{payoutRiskAcknowledgement,configDigest}',to_jsonb($3::text)) WHERE venue_id=$1 AND id=$2`,
    [venueA, overlappingVersion.versionId, overlappingVersion.payoutRiskAcknowledgement.configDigest]);
    const foreignCurrencyVersion = await payrollService.createVersion(principalA, createdScheme.id, { ...draftDefinition, currency: 'USD' }, payoutRiskAcknowledgement);
    const foreignTenantScheme = await payrollService.createScheme(principalB, {
      name: 'Foreign tenant QA scheme',
      payoutRiskAcknowledgement,
      definition: { ...draftDefinition, roleAssignments: [], employeeOverrides: [], itemRules: [] }
    });
    await assert.rejects(runService.createBlockedRun(principalA, { ...blockedRequest, schemeVersionId: overlappingVersion.versionId, idempotencyKey: 'blocked-run-draft-version-001' }),
      (error) => error instanceof PayrollCalculationRunError && error.status === 403,
      'draft scheme versions cannot create calculation runs');
    const previewInput = {
      employees: [
        { id: staffA, activeFrom: '2026-11-01', activeTo: '2026-11-30' },
        { id: staffOtherA, activeFrom: '2026-11-01', activeTo: '2026-11-30' }
      ],
      periodFrom: '2026-11-01', periodTo: '2026-11-01',
      coverage: { kind: 'month_to_date_complete', from: '2026-11-01', through: '2026-11-01', complete: true, watermark: 'owner-scenario-v1' },
      attendanceCoverage: { kind: 'approved_attendance_complete', from: '2026-11-01', through: '2026-11-01', complete: true, watermark: 'owner-attendance-scenario-v1' },
      attendance: [{ id: 'scenario-shift', employeeId: staffA, date: '2026-11-01', approved: true, workedMinutes: 480, plannedMinutes: 480 }],
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
    const sourcedPreviewResult = await payrollService.previewWithVenueDailyTurnover(principalA, createdVersion.versionId, previewInput);
    assert.equal(sourcedPreviewResult.official, false);
    assert.equal(sourcedPreviewResult.persistence, 'none');
    assert.equal(sourcedPreviewResult.sourceVenueTurnover.previewOnly, true);
    assert.equal(sourcedPreviewResult.sourceVenueTurnover.venueDailyTurnover[0].turnoverCents, 120000,
      'source-backed scenario uses the locked final order total for venue caps and thresholds');
    assert.equal(sourcedPreviewResult.result.venueTurnoverBasis, 'venue_daily_manifest_scenario');
    assert.equal(sourcedPreviewResult.result.status, 'ready');
    assert.equal(sourcedPreviewResult.result.employees.find((row) => row.employeeId === staffA).commissionCents,
      previewResult.result.employees.find((row) => row.employeeId === staffA).commissionCents,
      'adding venue turnover source must not alter the line-level net commission result');
    assert.equal(sourcedPreviewResult.result.employees.find((row) => row.employeeId === staffA).commissionCents, 1100,
      'commission remains calculated from caller net base at 10% base rate plus 1% item rule');
    await assert.rejects(payrollService.preview(principalA, createdVersion.versionId, { ...previewInput, employees: Array(501).fill({ id: staffA }) }),
      (error) => error instanceof PayrollSchemeServiceError && error.status === 413 && error.code === 'preview_input_too_large',
      'oversized employee scenarios are rejected by the service before calculation');
    await assert.rejects(payrollService.compare(principalA, [overlappingVersion.versionId, createdVersion.versionId],
      { ...previewInput, sales: Array(20001).fill(previewInput.sales[0]) }, createdVersion.versionId),
    (error) => error instanceof PayrollSchemeServiceError && error.status === 413 && error.code === 'preview_input_too_large',
    'oversized sales comparisons are rejected by the service before calculation');
    await assert.rejects(payrollService.preview(principalA, createdVersion.versionId,
      { ...previewInput, attendance: Array(20001).fill({ id: 'too-many', employeeId: staffA, date: '2026-11-01', approved: true, workedMinutes: 1, plannedMinutes: 1 }) }),
    (error) => error instanceof PayrollSchemeServiceError && error.status === 413 && error.code === 'preview_input_too_large',
    'oversized attendance scenarios are rejected before calculation');
    await assert.rejects(payrollService.preview(principalA, createdVersion.versionId, {
      ...previewInput, venueDailyTurnover: Array(32).fill({ date: '2026-11-01', turnoverCents: 0 })
    }),
    (error) => error instanceof PayrollSchemeServiceError && error.status === 413 && error.code === 'preview_input_too_large',
    'venue turnover manifests are bounded to a single calendar month');
    await assert.rejects(payrollService.compare(principalA, ['not-a-uuid', createdVersion.versionId], previewInput, createdVersion.versionId),
      (error) => error instanceof PayrollSchemeServiceError && error.status === 400 && error.code === 'invalid_payroll_scheme_version_id',
      'malformed comparison version IDs are rejected as client errors before PostgreSQL casts them');
    await assert.rejects(payrollService.compare(principalA, [overlappingVersion.versionId, createdVersion.versionId], previewInput, 42),
      (error) => error instanceof PayrollSchemeServiceError && error.status === 400 && error.code === 'invalid_payroll_scheme_version_id',
      'malformed comparison baseline IDs are rejected as client errors before database access');
    await assert.rejects(payrollService.compare(principalA, [overlappingVersion.versionId, '00000000-0000-4000-8000-000000009998'],
      previewInput, overlappingVersion.versionId),
    (error) => error instanceof PayrollSchemeServiceError && error.status === 404 && error.code === 'payroll_scheme_version_not_found',
    'well-formed but absent comparison IDs retain the tenant-safe not-found response');
    await assert.rejects(payrollService.compare(principalA, [overlappingVersion.versionId, foreignTenantScheme.versions[0].versionId],
      previewInput, overlappingVersion.versionId),
    (error) => error instanceof PayrollSchemeServiceError && error.status === 404 && error.code === 'payroll_scheme_version_not_found',
    'cross-tenant comparison IDs are indistinguishable from absent IDs');
    const tooManyAssignments = { ...draftDefinition, roleAssignments: Array(15001).fill(draftDefinition.roleAssignments[0]) };
    await assert.rejects(payrollService.createVersion(principalA, createdScheme.id, tooManyAssignments, payoutRiskAcknowledgement),
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
    const overflowDefinition = {
      ...draftDefinition,
      roleParameters: { bartender: { perShiftCents: Number.MAX_SAFE_INTEGER, bracketRatesBps: { 0: 0 }, milestoneBonusesCents: { 5000000: 0 } } },
      employeeOverrides: [{ employeeId: staffOtherA, path: 'perShiftCents', mode: 'override', value: Number.MAX_SAFE_INTEGER,
        effectiveFrom: '2026-11-01', effectiveTo: '2026-11-30' }],
      itemRules: []
    };
    const zeroDefinition = {
      ...overflowDefinition,
      roleParameters: { bartender: { perShiftCents: 0, bracketRatesBps: { 0: 0 }, milestoneBonusesCents: { 5000000: 0 } } },
      employeeOverrides: []
    };
    const overflowScheme = await payrollService.createScheme(principalA, { name: 'Aggregate overflow QA', definition: overflowDefinition, payoutRiskAcknowledgement });
    const zeroScheme = await payrollService.createScheme(principalA, { name: 'Aggregate zero QA', definition: zeroDefinition, payoutRiskAcknowledgement });
    const overflowInput = {
      ...previewInput,
      venueDailyTurnover: [{ date: '2026-11-01', turnoverCents: 0 }],
      attendance: [...previewInput.attendance,
        { id: 'overflow-shift', employeeId: staffOtherA, date: '2026-11-01', approved: true, workedMinutes: 480, plannedMinutes: 480 }],
      sales: [
        { id: 'overflow-a', date: '2026-11-01', employeeId: staffA, menuItemId: productA, department: 'bar', turnoverCents: 0, commissionBaseCents: 0 },
        { id: 'overflow-b', date: '2026-11-01', employeeId: staffOtherA, menuItemId: productA, department: 'bar', turnoverCents: 0, commissionBaseCents: 0 }
      ]
    };
    const overflowComparison = await payrollService.compare(principalA,
      [zeroScheme.versions[0].versionId, overflowScheme.versions[0].versionId], overflowInput, overflowScheme.versions[0].versionId);
    const zeroAgainstOverflow = overflowComparison.comparisons.find((row) => row.versionId === zeroScheme.versions[0].versionId);
    const overflowBaseline = overflowComparison.comparisons.find((row) => row.versionId === overflowScheme.versions[0].versionId);
    assert.equal(zeroAgainstOverflow.deltaToBaselineCents, null, 'aggregate comparison delta below MIN_SAFE_INTEGER is not returned as an imprecise number');
    assert.equal(zeroAgainstOverflow.aggregateBlocker, 'amount_exceeds_safe_integer_cents', 'unsafe negative aggregate is explicitly blocked');
    assert.equal(overflowBaseline.totalCents, null, 'positive aggregate above MAX_SAFE_INTEGER is already blocked');
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
    await client.query('COMMIT');
    transaction = false;
    schemaCommitted = true;
    await client.query(`SET search_path TO ${quotedSchema}, public`);

    const addSchedule = async (userId, date, start, end) => client.query(`INSERT INTO staff_schedules
      (venue_id,user_id,work_date,planned_start,planned_end) VALUES ($1,$2,$3::date,$4::timestamptz,$5::timestamptz)` ,
    [venueA, userId, date, start, end]);
    await addSchedule(staffA, '2026-09-10', '2026-09-10T10:00:00Z', '2026-09-10T18:00:00Z');
    await addSchedule(staffOtherA, '2026-09-11', '2026-09-11T10:00:00Z', '2026-09-11T18:00:00Z');
    await client.query('UPDATE users SET deleted_at=now() WHERE venue_id=$1 AND id=$2', [venueA, staffOtherA]);
    const scheduleIds = (await client.query('SELECT id,user_id FROM staff_schedules WHERE venue_id=$1 ORDER BY work_date', [venueA])).rows;
    const scheduleIdA = scheduleIds.find((row) => row.user_id === staffA).id;
    const scheduleIdArchived = scheduleIds.find((row) => row.user_id === staffOtherA).id;
    await client.query(`INSERT INTO staff_work_logs (venue_id,user_id,started_at,ended_at,source)
      VALUES ($1,$2,'2026-09-10T10:00:00Z','2026-09-10T12:00:00Z','manual'),
             ($1,$2,'2026-09-10T11:00:00Z','2026-09-10T13:00:00Z','shift'),
             ($1,$3,'2026-09-11T10:00:00Z','2026-09-11T12:30:00Z','device')`, [venueA, staffA, staffOtherA]);
    await client.query(`INSERT INTO staff_schedules (venue_id,user_id,work_date,planned_start,planned_end)
      VALUES ($1,$2,'2026-09-10','2026-09-10T10:00:00Z','2026-09-10T18:00:00Z')`, [venueB, ownerB]);
    await client.query(`INSERT INTO staff_work_logs (venue_id,user_id,started_at,ended_at,source)
      VALUES ($1,$2,'2026-09-10T10:00:00Z','2026-09-10T16:00:00Z','manual')`, [venueB, ownerB]);
    const sideEffectCounts = async () => (await client.query(`SELECT
      (SELECT count(*)::int FROM payroll_entries WHERE venue_id=$1) AS payroll_entries,
      (SELECT count(*)::int FROM expenses WHERE venue_id=$1) AS expenses,
      (SELECT count(*)::int FROM shifts WHERE venue_id=$1) AS shifts,
      (SELECT count(*)::int FROM payments p JOIN orders o ON o.id=p.order_id WHERE o.venue_id=$1) AS payments,
      (SELECT count(*)::int FROM orders WHERE venue_id=$1) AS orders,
      (SELECT count(*)::int FROM guest_account_entries WHERE venue_id=$1) AS loyalty_entries`, [venueA])).rows[0];
    const attendanceSideEffectsBefore = await sideEffectCounts();
    const attendancePool = {
      async query(...args) {
        const connection = new Client({ connectionString: databaseUrl });
        await connection.connect();
        try {
          await connection.query(`SET search_path TO ${quotedSchema}, public`);
          return await connection.query(...args);
        } finally { await connection.end().catch(() => {}); }
      },
      async connect() {
        const connection = new Client({ connectionString: databaseUrl });
        await connection.connect();
        await connection.query(`SET search_path TO ${quotedSchema}, public`);
        return { query: (...args) => connection.query(...args), release: () => connection.end().catch(() => {}) };
      }
    };
    const attendanceService = makePayrollAttendanceManifestService(attendancePool);
    const attendancePrincipal = { userId: ownerA, venueId: venueA };
    const attendancePeriod = { periodFrom: '2026-09-01', periodTo: '2026-09-30' };
    const coverage = await attendanceService.readCoverage(attendancePrincipal, attendancePeriod);
    assert.equal(coverage.complete, true, 'valid scheduled work intervals produce complete attendance coverage');
    assert.equal(coverage.scheduleCount, 2, 'coverage includes historical shifts for archived staff');
    assert.equal(coverage.shifts.some((shift) => shift.employeeId === ownerB), false,
      'coverage excludes schedule and log rows owned by a different venue in the same database');
    assert.equal(coverage.shifts.find((shift) => shift.scheduleId === scheduleIdA).workedMinutes, 180,
      'overlapping work intervals merge deterministically without double-counting minutes');
    assert.equal(coverage.shifts.find((shift) => shift.scheduleId === scheduleIdArchived).workedMinutes, 150,
      'archived employees remain in historical attendance manifests');
    assert.equal(Object.hasOwn(coverage, 'source'), false, 'coverage response exposes the watermark, not a duplicate raw source manifest');
    const emptyCoverage = await attendanceService.readCoverage(attendancePrincipal, { periodFrom: '2026-08-01', periodTo: '2026-08-31' });
    assert.equal(emptyCoverage.complete, false, 'an empty schedule period cannot be silently approved as complete');
    assert.ok(emptyCoverage.reasons.includes('payroll_attendance_no_planned_shifts'), 'empty coverage has an explicit blocker');
    const approvalInput = { ...attendancePeriod, sourceWatermark: coverage.sourceWatermark, reason: 'QA timesheet reconciliation', idempotencyKey: 'payroll-attendance:qa-approval-01' };
    const approval = await attendanceService.approveCoverage(attendancePrincipal, approvalInput);
    assert.equal(approval.revision, 1, 'owner can persist first immutable attendance approval');
    const retriedApproval = await attendanceService.approveCoverage(attendancePrincipal, approvalInput);
    assert.equal(retriedApproval.approvalId, approval.approvalId, 'same idempotency key returns the original approval');
    const concurrentInput = { ...approvalInput, reason: 'Concurrent QA approval', idempotencyKey: 'payroll-attendance:qa-concurrent-01' };
    const concurrentApprovals = await Promise.all([
      attendanceService.approveCoverage(attendancePrincipal, concurrentInput),
      attendanceService.approveCoverage(attendancePrincipal, concurrentInput)
    ]);
    assert.equal(concurrentApprovals[0].approvalId, concurrentApprovals[1].approvalId,
      'concurrent same-key approval requests serialize to the same immutable revision');
    assert.equal(concurrentApprovals[0].revision, 2, 'a distinct explicit approval reason creates one new revision');
    const distinctConcurrent = await Promise.all([
      attendanceService.approveCoverage(attendancePrincipal, { ...approvalInput, reason: 'Concurrent QA approval A', idempotencyKey: 'payroll-attendance:qa-concurrent-A' }),
      attendanceService.approveCoverage(attendancePrincipal, { ...approvalInput, reason: 'Concurrent QA approval B', idempotencyKey: 'payroll-attendance:qa-concurrent-B' })
    ]);
    assert.deepEqual(distinctConcurrent.map((row) => row.revision).sort((a, b) => a - b), [3, 4],
      'concurrent distinct approvals for one period receive unique sequential revisions');
    const latestAttendanceApprovalId = distinctConcurrent.find((row) => row.revision === 4).approvalId;
    const attendancePreviewDefinition = {
      mode: 'progressive_daily', currency: 'RUB', effectiveFrom: '2026-09-01', effectiveTo: '2026-09-30',
      roleParameters: { bartender: { perShiftCents: 8000, bracketRatesBps: { 0: 0 } } },
      roleAssignments: [
        { employeeId: staffA, roleId: 'bartender', effectiveFrom: '2026-09-01', effectiveTo: '2026-09-30' },
        { employeeId: staffOtherA, roleId: 'bartender', effectiveFrom: '2026-09-01', effectiveTo: '2026-09-30' }
      ], employeeOverrides: [], itemRules: []
    };
    const attendancePreviewService = makeService(attendancePool);
    const attendanceScenarioScheme = await attendancePreviewService.createScheme(attendancePrincipal, {
      name: 'Approved attendance preview QA', definition: attendancePreviewDefinition, payoutRiskAcknowledgement
    });
    const attendanceScenarioVersionId = attendanceScenarioScheme.versions[0].versionId;
    const attendancePreviewInput = {
      periodFrom: '2026-09-01', periodTo: '2026-09-30',
      coverage: { kind: 'month_to_date_complete', from: '2026-09-01', through: '2026-09-30', complete: true, watermark: 'scenario-only' },
      attendanceCoverage: { kind: 'approved_attendance_complete', from: '2026-09-01', through: '2026-09-30', complete: true, watermark: 'forged-caller-value' },
      employees: [
        { id: staffA, name: 'Staff A', activeFrom: '2026-01-01' },
        { id: staffOtherA, name: 'Archived Staff A', activeFrom: '2026-01-01' }
      ],
      attendance: [{ id: 'caller-forged-shift', employeeId: staffA, date: '2026-09-10', approved: true, workedMinutes: 480, plannedMinutes: 480 }],
      sales: []
    };
    await assert.rejects(attendancePreviewService.previewWithApprovedAttendance(attendancePrincipal,
      attendanceScenarioVersionId, { ...attendancePreviewInput, periodFrom: '2026-09-31' }),
    (error) => error instanceof PayrollSchemeServiceError && error.status === 400
      && error.code === 'invalid_single_month_period',
    'approved-attendance preview rejects an impossible period start before reading sources');
    await assert.rejects(attendancePreviewService.previewWithApprovedAttendance(attendancePrincipal,
      attendanceScenarioVersionId, { ...attendancePreviewInput, periodFrom: '2026-09-20', periodTo: '2026-09-01' }),
    (error) => error instanceof PayrollSchemeServiceError && error.status === 400
      && error.code === 'invalid_single_month_period',
    'approved-attendance preview rejects a reversed calculation period');
    const attendanceSideEffectsForPreviewBefore = await sideEffectCounts();
    const approvedAttendancePreview = await attendancePreviewService.previewWithApprovedAttendance(
      attendancePrincipal, attendanceScenarioVersionId, attendancePreviewInput);
    assert.equal(approvedAttendancePreview.official, false, 'approved-attendance preview remains explicitly non-official');
    assert.equal(approvedAttendancePreview.persistence, 'none', 'approved-attendance preview never persists payroll');
    assert.equal(approvedAttendancePreview.sourceAttendanceApproval.approvalId, latestAttendanceApprovalId);
    assert.equal(approvedAttendancePreview.sourceAttendanceApproval.revision, 4);
    assert.equal(approvedAttendancePreview.result.status, 'ready', 'complete sales scenario plus current approved attendance calculates');
    assert.deepEqual(approvedAttendancePreview.result.employees.map((row) => row.employeeId).sort(), [staffA, staffOtherA].sort(),
      'approved snapshot includes both active and archived historical employees');
    const approvedShiftDetails = approvedAttendancePreview.result.daily.flatMap((day) => day.employees || [])
      .flatMap((employee) => employee.shiftDetails || []);
    assert.equal(approvedShiftDetails.length, 2, 'caller-supplied attendance is overwritten by both approved snapshot shifts');
    assert.deepEqual(approvedShiftDetails.map((shift) => shift.amountCents).sort((a, b) => a - b), [2500, 3000],
      'approved factual minutes, not caller attendance, determine prorated shift pay');
    assert.deepEqual(await sideEffectCounts(), attendanceSideEffectsForPreviewBefore,
      'approved-attendance preview creates no payroll, expense, shift, payment, order or loyalty side effects');
    await assert.rejects(attendanceService.approveCoverage({ userId: ownerB, venueId: venueB }, approvalInput),
      (error) => error instanceof PayrollAttendanceError && error.status === 409,
      'an owner from another venue cannot approve another venue snapshot');
    await assert.rejects(attendanceService.approveCoverage({ userId: staffA, venueId: venueA }, approvalInput),
      (error) => error instanceof PayrollAttendanceError && error.status === 403,
      'a non-owner cannot approve attendance even inside the correct venue');
    await assert.rejects(client.query('UPDATE payroll_attendance_approvals SET reason=reason WHERE venue_id=$1 AND id=$2', [venueA, approval.approvalId]),
      (error) => error.code === '55000', 'approval header rejects update');
    await assert.rejects(client.query('DELETE FROM payroll_attendance_approval_shifts WHERE venue_id=$1 AND approval_id=$2', [venueA, approval.approvalId]),
      (error) => error.code === '55000', 'approval shifts reject delete');
    await assert.rejects(client.query('TRUNCATE payroll_attendance_approval_intervals'),
      (error) => error.code === '55000', 'approval intervals reject truncate');
    await client.query(`INSERT INTO staff_work_logs (venue_id,user_id,started_at,ended_at,source)
      VALUES ($1,$2,'2026-09-20T10:00:00Z','2026-09-20T11:00:00Z','manual')`, [venueA, staffA]);
    const unmatchedCoverage = await attendanceService.readCoverage(attendancePrincipal, attendancePeriod);
    assert.equal(unmatchedCoverage.complete, false, 'a work interval without a planned shift blocks coverage');
    assert.ok(unmatchedCoverage.reasons.includes('payroll_attendance_work_interval_without_schedule'));
    await client.query("DELETE FROM staff_work_logs WHERE venue_id=$1 AND user_id=$2 AND started_at='2026-09-20T10:00:00Z'", [venueA, staffA]);
    await client.query(`INSERT INTO staff_work_logs (venue_id,user_id,started_at,source)
      VALUES ($1,$2,'2026-09-21T10:00:00Z','manual')`, [venueA, staffA]);
    const openCoverage = await attendanceService.readCoverage(attendancePrincipal, attendancePeriod);
    assert.equal(openCoverage.complete, false, 'an open work interval blocks coverage');
    assert.ok(openCoverage.reasons.includes('payroll_attendance_open_or_invalid_work_interval'));
    await client.query("DELETE FROM staff_work_logs WHERE venue_id=$1 AND user_id=$2 AND started_at='2026-09-21T10:00:00Z'", [venueA, staffA]);
    await client.query(`INSERT INTO staff_schedules (venue_id,user_id,work_date,planned_start,planned_end)
      VALUES ($1,$2,'2026-09-12','2026-09-12T10:00:00Z','2026-09-12T14:00:00Z'),
             ($1,$2,'2026-09-13','2026-09-13T11:00:00Z','2026-09-13T15:00:00Z')`, [venueA, staffA]);
    await client.query(`INSERT INTO staff_work_logs (venue_id,user_id,started_at,ended_at,source)
      VALUES ($1,$2,'2026-09-12T12:00:00Z','2026-09-13T12:00:00Z','manual')`, [venueA, staffA]);
    const ambiguousCoverage = await attendanceService.readCoverage(attendancePrincipal, attendancePeriod);
    assert.equal(ambiguousCoverage.complete, false, 'a work interval crossing multiple planned shifts blocks coverage');
    assert.ok(ambiguousCoverage.reasons.includes('payroll_attendance_work_interval_shift_ambiguous'));
    await client.query("DELETE FROM staff_work_logs WHERE venue_id=$1 AND user_id=$2 AND started_at='2026-09-12T12:00:00Z'", [venueA, staffA]);
    await client.query("DELETE FROM staff_schedules WHERE venue_id=$1 AND user_id=$2 AND work_date IN ('2026-09-12','2026-09-13')", [venueA, staffA]);
    await client.query("UPDATE staff_work_logs SET ended_at='2026-09-10T14:00:00Z' WHERE venue_id=$1 AND user_id=$2 AND started_at='2026-09-10T10:00:00Z'", [venueA, staffA]);
    const staleCoverage = await attendanceService.readCoverage(attendancePrincipal, attendancePeriod);
    assert.equal(staleCoverage.stale, true, 'source edits mark the current approval stale without editing its immutable snapshot');
    assert.equal(staleCoverage.currentApproval.approvalId, latestAttendanceApprovalId, 'old approved snapshot remains available after source change');
    const frozenShift = staleCoverage.currentApproval.shifts.find((shift) => shift.scheduleSourceId === scheduleIdA);
    assert.equal(frozenShift.workedMinutes, 180, 'previous approval retains its original worked minutes after HR source edits');
    assert.equal(frozenShift.intervals.length, 2, 'previous approval retains both original source interval snapshots after HR source edits');
    await assert.rejects(attendancePreviewService.previewWithApprovedAttendance(attendancePrincipal,
      attendanceScenarioVersionId, attendancePreviewInput),
    (error) => error instanceof PayrollSchemeServiceError && error.status === 409
      && error.code === 'payroll_preview_attendance_approval_stale',
    'source-backed scenario refuses a stale approval until a fresh approval is made');
    await assert.rejects(attendanceService.approveCoverage(attendancePrincipal, {
      ...concurrentInput, idempotencyKey: 'payroll-attendance:qa-stale-01'
    }), (error) => error instanceof PayrollAttendanceError && error.code === 'payroll_attendance_source_changed',
    'approval with an old watermark is rejected after source changes');
    const revisedApproval = await attendanceService.approveCoverage(attendancePrincipal, {
      ...attendancePeriod, sourceWatermark: staleCoverage.sourceWatermark, reason: 'QA corrected attendance', idempotencyKey: 'payroll-attendance:qa-revision-03'
    });
    assert.equal(revisedApproval.revision, 5, 'owner can append a fresh revision after correcting stale source data');
    const revisedPreview = await attendancePreviewService.previewWithApprovedAttendance(attendancePrincipal,
      attendanceScenarioVersionId, attendancePreviewInput);
    assert.equal(revisedPreview.sourceAttendanceApproval.revision, 5,
      'source-backed scenario accepts the newly approved current revision');
    assert.deepEqual(await sideEffectCounts(), attendanceSideEffectsBefore,
      'attendance reads/approvals leave payroll entries, every expense, shifts/cash, payments, orders and loyalty ledger unchanged');

    let insertWaiters = 0;
    const insertBarrier = new Promise((resolve) => { releaseConcurrentInsertBarrier = resolve; });
    const concurrentPool = {
      async connect() {
        const connection = new Client({ connectionString: databaseUrl });
        await connection.connect();
        concurrentClients.add(connection);
        await connection.query(`SET search_path TO ${quotedSchema}, public`);
        return {
          async query(sql, params) {
            if (/^\s*INSERT\s+INTO\s+payroll_calculation_runs\b/i.test(String(sql))) {
              insertWaiters += 1;
              if (insertWaiters === 2) releaseConcurrentInsertBarrier();
              await insertBarrier;
            }
            return connection.query(sql, params);
          },
          release() {
            const closing = connection.end().catch(() => {});
            concurrentClients.delete(connection);
            closingConcurrentClients.push(closing);
          }
        };
      }
    };
    const concurrentRunService = makePayrollCalculationRunService(concurrentPool);
    const concurrentRequest = { ...blockedRequest, idempotencyKey: 'blocked-run-concurrent-retry-001' };
    const concurrentRuns = await Promise.all([
      concurrentRunService.createBlockedRun(principalA, concurrentRequest),
      concurrentRunService.createBlockedRun(principalA, concurrentRequest)
    ]);
    assert.equal(insertWaiters, 2, 'both independent PostgreSQL sessions reach the insert before either can proceed');
    assert.equal(concurrentRuns[0].id, concurrentRuns[1].id, 'concurrent same-key requests return one persisted run');
    assert.deepEqual(concurrentRuns[0], concurrentRuns[1], 'concurrent retries return identical immutable run metadata');
    assert.equal((await client.query(`SELECT count(*)::int AS count FROM payroll_calculation_runs
      WHERE venue_id=$1 AND idempotency_key=$2`, [venueA, concurrentRequest.idempotencyKey])).rows[0].count, 1,
    'concurrent same-key requests persist exactly one payroll run');
    console.log('PAYROLL SCHEME MIGRATION CONTRACT: STATIC + POSTGRESQL PASS (replay, tenant FKs, owner-only schemes and blocked runs, sequential and concurrent idempotency, no financial side effects, immutable history, source gates and adjustment lineage; isolated schema cleanup)');
  } finally {
    if (releaseConcurrentInsertBarrier) releaseConcurrentInsertBarrier();
    if (transaction) await client.query('ROLLBACK').catch(() => {});
    await Promise.all([
      ...[...concurrentClients].map(async (connection) => {
        await connection.end().catch(() => {});
      }),
      ...closingConcurrentClients
    ]);
    if (schemaCommitted) {
      await client.query('DROP SCHEMA IF EXISTS ' + quotedSchema + ' CASCADE');
    }
    if (client._connected) await client.end();
  }
}
