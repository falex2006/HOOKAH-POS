import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { validateQaDatabaseUrl, assertQaDatabaseIdentity } from './postgres-qa-safety.mjs';

const require = createRequire(import.meta.url), root = fileURLToPath(new URL('../', import.meta.url));
const target = validateQaDatabaseUrl(process.env.MIGRATIONS_PG_TEST_DATABASE_URL);
assert.match(process.env.LOCAL_FULL_PG_OWNED_DATABASE || '', /^orders_qa_[a-f0-9]{16}$/);
assert.equal(target.database, process.env.LOCAL_FULL_PG_OWNED_DATABASE);
await require('./local-full-pg-regression.cjs').verifyOwnerPinQaDatabaseUrl(target.url.href);
const lock = JSON.parse(await readFile(path.join(root, 'tmp/full-local-qa/pg-regression-runner.lock'), 'utf8'));
assert.equal(Number(lock.pid), process.ppid); assert.match(lock.id || '', /^[0-9a-f-]{36}$/i);
const { Client } = require('pg');
const { calculatePayrollScheme: calculate } = require('../payroll-schemes.js');
const { persistPayrollSnapshotBundleInTransaction: persist } = require('../payroll-snapshot-persistence.js');
const { mapPayrollTypedSnapshotRows: typedMap } = require('../payroll-typed-snapshot-serializer.js');
const { mapPayrollMilestoneStorageRows: milestoneMap } = require('../payroll-milestone-storage-serializer.js');
const db = new Client({ connectionString: target.url.href });
const artifacts = path.join(root, 'tmp/full-local-qa/payroll-snapshot-persistence-qa', `${Date.now()}-${process.pid}`);
const evidence = { status: 'RUNNING', scope: 'private storage over synthetic supplied evidence; no official source, API, accrual or payout acceptance', assertions: [] };
const ids = new Map(), id = n => { if (!ids.has(n)) ids.set(n, randomUUID()); return ids.get(n); };
const modes = ['stable_percent', 'personal_target', 'team_fund', 'margin_target'];
const tables = ['payroll_calculation_runs', 'payroll_daily_snapshots', 'payroll_team_fund_snapshots', 'payroll_daily_snapshot_lines',
  'payroll_team_fund_snapshot_allocations', 'payroll_milestone_day_snapshots', 'payroll_milestone_decision_snapshots'];
const versions = new Map(modes.map(mode => [mode, randomUUID()]));

function fixture(mode = 'stable_percent', milestone = false) {
  const role = { perShiftCents: 0, stableRateBps: 1000, targetCents: 10000, baseRateBps: 1600,
    bonusRateBps: 4800, excessRatePolicy: 'replace_base' };
  if (mode === 'margin_target') Object.assign(role, { lossPolicy: 'offset_daily_losses', itemRuleBasis: 'net_revenue' });
  if (mode === 'team_fund') Object.assign(role, { teamWeight: 1, teamFund: { poolId: 'bar', targetCents: 10000, baseRateBps: 1600,
    bonusRateBps: 4800, excessRatePolicy: 'replace_base', departments: ['bar'], distributionPolicy: 'configured_weights' } });
  if (milestone) role.milestoneBonusesCents = { 10000: 100 };
  const attendance = milestone ? [{ id: id(7), employeeId: id(3), date: '2026-10-01', approved: true, workedMinutes: 60, plannedMinutes: 60 }] : [];
  const roster = milestone ? [3, 8] : [3], runId = randomUUID();
  const costSnapshot = { id: 'cost-synthetic', version: 'v1', currency: 'RUB', costCents: 5000 };
  const scenario = { scheme: { id: id(12), versionId: versions.get(mode), currency: 'RUB', mode, applyMilestones: milestone,
    ...(milestone ? { milestoneEligibility: 'worked_on_threshold_day' } : {}), roleParameters: { bar: role } },
    periodFrom: '2026-10-01', periodTo: milestone ? '2026-10-02' : '2026-10-01', employees: roster.map(n => ({ id: id(n) })), attendance,
    roleAssignments: roster.map(n => ({ employeeId: id(n), roleId: 'bar', effectiveFrom: '2026-10-01' })),
    coverage: { kind: 'month_to_date_complete', from: '2026-10-01', through: milestone ? '2026-10-02' : '2026-10-01', complete: true, watermark: 'synthetic' },
    attendanceCoverage: { kind: 'approved_attendance_complete', from: '2026-10-01', through: milestone ? '2026-10-02' : '2026-10-01', complete: true, watermark: 'a'.repeat(64) },
    sales: [{ id: id(5), employeeId: id(3), menuItemId: id(6), department: 'bar', date: '2026-10-01', commissionBaseCents: 20000, turnoverCents: 20000,
      ...(mode === 'margin_target' ? { costSnapshot } : {}) }] };
  const input = { venueId: id(1), runId, venueTimezone: 'UTC', attendance,
    employees: roster.map(n => ({ id: id(n), name: n === 3 ? 'Employee' : 'Rejected recipient' })), result: calculate(scenario),
    sourceLines: [{ id: id(5), orderId: id(4), orderItemId: id(5), employeeId: id(3), menuItemId: id(6), menuItemName: 'Tea', department: 'bar', roleId: 'bar',
      localDate: '2026-10-01', soldAt: '2026-10-01T12:00:00Z', quantity: '1', grossCents: 20100, discountCents: 100, refundCents: 0,
      commissionBaseCents: 20000, turnoverCents: 20000, ...(mode === 'margin_target' ? { costSnapshot: structuredClone(costSnapshot) } : {}) }] };
  if (milestone) Object.assign(input, { attendanceApprovalId: id(10), attendanceCoverage: scenario.attendanceCoverage,
    sourceAttendanceApproval: { approvalId: id(10), periodFrom: '2026-10-01', periodTo: '2026-10-02', timezone: 'UTC', venueId: id(1), sourceWatermark: 'a'.repeat(64) } });
  assert.equal(input.result.status, 'ready', JSON.stringify(input.result.blockers));
  const run = { id: runId, venue_id: id(1), scheme_version_id: versions.get(mode), period_from: input.result.periodFrom, period_to: input.result.periodTo,
    status: 'ready', source_coverage: 'complete', commission_basis: 'net_after_discounts_refunds', eligible_line_count: 1,
    unattributed_line_count: 0, missing_net_line_count: 0, input_watermark: 'synthetic-not-official', input_checksum: 'a'.repeat(64),
    engine_version: 'synthetic-qa', idempotency_key: runId, created_by: id(11), created_by_name: 'Owner', venue_timezone: 'UTC', currency: 'RUB',
    milestone_evidence_version: milestone ? 1 : 0 };
  return { run, input };
}

const state = async () => {
  const result = {};
  for (const table of tables) result[table] = (await db.query(`SELECT * FROM ${table} WHERE venue_id=$1 ORDER BY id`, [id(1)])).rows;
  return result;
};
const ledgerCounts = async () => (await db.query('SELECT (SELECT count(*)::int FROM payroll_entries) AS entries,(SELECT count(*)::int FROM expenses) AS expenses')).rows[0];
const insert = async (table, row) => {
  // All callers below use fixed test-owned tables and static object keys.
  const fields = Object.keys(row);
  return db.query(`INSERT INTO ${table} (${fields.join(',')}) VALUES (${fields.map((_, i) => `$${i + 1}`).join(',')})`, fields.map(k => row[k]));
};
async function commitBundle(bundle) {
  await db.query('BEGIN');
  try { const result = await persist(db, bundle); await db.query('COMMIT'); return result; }
  catch (error) { await db.query('ROLLBACK'); throw error; }
}
async function failureThenCommit(bundle, connection, expectedCode) {
  const before = await state(); await db.query('BEGIN');
  try {
    await assert.rejects(() => persist(connection, bundle), error => expectedCode instanceof RegExp ? expectedCode.test(error.code) : error.code === expectedCode);
    assert.deepEqual(await state(), before, 'helper restored bundle before caller transaction ends');
    await db.query('COMMIT');
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  assert.deepEqual(await state(), before, 'catch then COMMIT cannot retain an orphan header or children');
}
async function readback(bundle, output) {
  const typed = typedMap(bundle.input), milestone = milestoneMap(bundle.input);
  const expected = { payroll_daily_snapshots: typed.dailySnapshots, payroll_daily_snapshot_lines: typed.snapshotLines,
    payroll_team_fund_snapshots: typed.fundSnapshots, payroll_team_fund_snapshot_allocations: typed.fundAllocations,
    payroll_milestone_day_snapshots: milestone.daySnapshots, payroll_milestone_decision_snapshots: milestone.decisionSnapshots };
  const all = {};
  for (const table of tables) {
    const key = table === 'payroll_calculation_runs' ? 'id' : 'run_id';
    all[table] = (await db.query(`SELECT *${table === 'payroll_calculation_runs' ? ',period_from::text AS period_from,period_to::text AS period_to' : ',local_date::text AS local_date'} FROM ${table} WHERE venue_id=$1 AND ${key}=$2 ORDER BY id`, [id(1), bundle.run.id])).rows;
    assert.equal(all[table].length, output.counts[table]);
  }
  for (const [field, value] of Object.entries(bundle.run)) assert.deepEqual(all.payroll_calculation_runs[0][field], value, `run.${field}`);
  const transient = new Set(['key', 'snapshotKey', 'teamPoolKey', 'poolKey', 'dayKey']);
  for (const [table, records] of Object.entries(expected)) {
    assert.equal(all[table].length, records.length);
    for (const row of records) {
      const stored = all[table].find(candidate => candidate.local_date === row.local_date
        && (row.employee_id === undefined || candidate.employee_id === row.employee_id)
        && (row.order_item_id === undefined || candidate.order_item_id === row.order_item_id)
        && (row.pool_key === undefined || candidate.pool_key === row.pool_key)
        && (row.threshold_amount === undefined || candidate.threshold_amount === row.threshold_amount));
      assert.ok(stored, `readback ${table}`);
      for (const [field, value] of Object.entries(row)) if (!transient.has(field)) {
        const actual = stored[field] instanceof Date ? stored[field].toISOString() : stored[field];
        assert.deepEqual(actual, value, `${table}.${field}`);
      }
    }
  }
  const daily = all.payroll_daily_snapshots, funds = all.payroll_team_fund_snapshots;
  for (const line of all.payroll_daily_snapshot_lines) {
    assert.equal(daily.find(r => r.id === line.snapshot_id)?.employee_id, line.employee_id);
    if (line.team_pool_snapshot_id) assert.ok(funds.some(r => r.id === line.team_pool_snapshot_id));
  }
  for (const allocation of all.payroll_team_fund_snapshot_allocations) {
    assert.equal(daily.find(r => r.id === allocation.snapshot_id)?.employee_id, allocation.employee_id);
    assert.ok(funds.some(r => r.id === allocation.pool_snapshot_id));
  }
  for (const decision of all.payroll_milestone_decision_snapshots) assert.ok(all.payroll_milestone_day_snapshots.some(r => r.id === decision.day_snapshot_id && r.local_date === decision.local_date));
  assert.equal(output.runId, bundle.run.id);
  return all;
}

try {
  await mkdir(artifacts, { recursive: true }); await db.connect();
  const identity = (await db.query('SELECT current_database() AS database,inet_server_addr() AS address,inet_server_port() AS port,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser')).rows[0];
  assertQaDatabaseIdentity(identity, target.database, Number(target.url.port), 'Payroll snapshot persistence QA');
  const beforeLedgers = await ledgerCounts();
  await insert('organizations', { id: id(90), name: 'Snapshot persistence QA', slug: `payroll-storage-${process.pid}`, timezone: 'UTC' });
  await insert('venues', { id: id(1), organization_id: id(90), name: 'Snapshot persistence QA', timezone: 'UTC' });
  for (const n of [3, 8, 11]) await insert('users', { id: id(n), organization_id: id(90), venue_id: id(1), full_name: n === 11 ? 'Owner' : n === 3 ? 'Employee' : 'Rejected recipient',
    login: `payroll-storage-${process.pid}-${n}`, role: n === 11 ? 'owner' : 'bartender' });
  await insert('products', { id: id(6), venue_id: id(1), name: 'Tea', category: 'bar', sale_price: 201 });
  // Open POS fixtures satisfy item provenance FK only. They are deliberately not
  // closed/recognized and do not claim producer144 or complete revenue evidence.
  await insert('orders', { id: id(4), venue_id: id(1), status: 'open', opened_by: id(11) });
  await insert('order_items', { id: id(5), order_id: id(4), product_id: id(6), quantity: 1, unit_price: 201, sales_employee_id: id(3), sold_at: '2026-10-01T12:00:00Z' });
  for (const mode of modes) {
    const scheme = randomUUID();
    await insert('payroll_schemes', { id: scheme, venue_id: id(1), name: `Synthetic ${mode}`, created_by: id(11), created_by_name: 'Owner' });
    await insert('payroll_scheme_versions', { id: versions.get(mode), venue_id: id(1), scheme_id: scheme, version_no: 1, mode,
      effective_from: '2026-10-01', effective_to: '2026-10-31', created_by: id(11), created_by_name: 'Owner' });
    await db.query("UPDATE payroll_scheme_versions SET status='active',status_changed_by=$1,status_changed_by_name='Owner',status_changed_at=now() WHERE id=$2", [id(11), versions.get(mode)]);
  }
  await insert('payroll_attendance_approvals', { id: id(10), venue_id: id(1), period_from: '2026-10-01', period_to: '2026-10-02', revision: 1,
    venue_timezone: 'UTC', reason: 'Synthetic storage QA', source_watermark: 'a'.repeat(64), source_schedule_count: 1, source_log_count: 1, shift_count: 1,
    approved_by: id(11), approved_by_name: 'Owner', idempotency_key: 'synthetic-attendance' });
  await insert('payroll_attendance_approval_shifts', { id: id(7), venue_id: id(1), approval_id: id(10), schedule_source_id: id(19), employee_id: id(3),
    employee_name_snapshot: 'Employee', work_date: '2026-10-01', planned_start: '2026-10-01T10:00Z', planned_end: '2026-10-01T11:00Z',
    planned_minutes: 60, worked_minutes: 60, source_interval_count: 1 });

  const committed = [];
  for (const mode of modes) {
    const bundle = fixture(mode), before = structuredClone(bundle), result = await commitBundle(bundle), stored = await readback(bundle, result);
    assert.deepEqual(bundle, before);
    assert.equal(stored.payroll_daily_snapshots[0].final_amount, { stable_percent: '20.00', personal_target: '64.00', team_fund: '64.00', margin_target: '40.00' }[mode]);
    assert.equal(stored.payroll_daily_snapshots[0].snapshot_schema_version, 2);
    assert.equal(stored.payroll_calculation_runs[0].milestone_evidence_version, 0);
    committed.push(bundle);
  }
  const milestoneBundle = fixture('stable_percent', true), milestoneRows = await readback(milestoneBundle, await commitBundle(milestoneBundle));
  assert.equal(milestoneRows.payroll_milestone_day_snapshots.length, 2);
  assert.equal(milestoneRows.payroll_milestone_day_snapshots.find(r => r.local_date === '2026-10-02').decision_count, 0);
  const rejection = milestoneRows.payroll_milestone_decision_snapshots.find(r => r.employee_id === id(8));
  assert.equal(rejection.eligible, false); assert.equal(rejection.awarded_amount, '0.00');
  assert.equal(milestoneRows.payroll_daily_snapshots.find(r => r.employee_id === id(3) && r.local_date === '2026-10-01').final_amount, '21.00');
  evidence.assertions.push('Real committed v2 scalar/personal-target/team-fund/margin rows, independent 20/64/64/40 money oracles, complete DTO readback and UUID links; milestone21, rejected recipient and empty next day preserved');

  for (const table of tables) {
    let injected = false;
    const wrapped = { query: async (sql, values) => {
      const result = await db.query(sql, values);
      if (!injected && new RegExp(`^INSERT INTO ${table}\\s`, 'i').test(sql)) { injected = true; await db.query('SELECT 1/0'); }
      return result;
    } };
    await failureThenCommit(fixture(table.includes('milestone') ? 'stable_percent' : 'team_fund', table.includes('milestone')), wrapped, '22012');
    assert.equal(injected, true, table);
  }
  await failureThenCommit(fixture(), { query: async (sql, values) => {
    if (/^SET CONSTRAINTS.*IMMEDIATE$/s.test(sql)) await db.query('SELECT 1/0');
    return db.query(sql, values);
  } }, '22012');
  // Alter only the actual INSERT parameters to create a valid individual line
  // whose aggregate contradicts daily commission. PostgreSQL deferred totals,
  // rather than a mock or JS validation, must reject the complete transaction.
  let reachedDeferred = false;
  await failureThenCommit(fixture(), { query: async (sql, values) => {
    if (/^INSERT INTO payroll_daily_snapshot_lines\s/.test(sql)) {
      const fields = sql.match(/\(([^)]+)\)/)[1].split(','), changed = values.slice();
      changed[fields.indexOf('commission_amount')] = '20.01'; values = changed;
    }
    if (/^SET CONSTRAINTS.*IMMEDIATE$/s.test(sql)) reachedDeferred = true;
    return db.query(sql, values);
  } }, '23514');
  assert.equal(reachedDeferred, true);
  let skippedDecision = false;
  await failureThenCommit(fixture('stable_percent', true), { query: async (sql, values) => {
    if (!skippedDecision && /^INSERT INTO payroll_milestone_decision_snapshots\s/.test(sql)) {
      skippedDecision = true;
      const fields = sql.match(/\(([^)]+)\)/)[1].split(',');
      return { rowCount: 1, rows: [{ id: values[fields.indexOf('id')] }] };
    }
    return db.query(sql, values);
  } }, '23514');
  assert.equal(skippedDecision, true, 'real milestone deferred totals catch a missing decision despite apparent INSERT acknowledgement');
  const wrongOrder = fixture(); wrongOrder.input.sourceLines[0].orderId = randomUUID();
  await failureThenCommit(wrongOrder, db, '23503');
  evidence.assertions.push('Actual SQL failure after every table family and at constraint flush restores all rows; real deferred commission mismatch23514; caller catches errors then COMMIT leaves no partial run');

  const beforeRollback = await state(); await db.query('BEGIN');
  await persist(db, fixture('team_fund')); await db.query('ROLLBACK'); assert.deepEqual(await state(), beforeRollback);
  await assert.rejects(() => persist(db, fixture()), error => error.code === '25P01'); assert.deepEqual(await state(), beforeRollback);
  await failureThenCommit(committed[0], db, '23505');
  evidence.assertions.push('Caller ROLLBACK removes successful helper bundle; no explicit transaction rejects25P01; existing run23505 appends nothing');

  const triggerName = 'payroll_daily_snapshots_typed_totals';
  const triggerState = async () => (await db.query('SELECT tgname,tgenabled,tgdeferrable,tginitdeferred FROM pg_trigger WHERE tgrelid=to_regclass($1) AND tgname=$2', ['payroll_daily_snapshots', triggerName])).rows;
  const triggerBefore = await triggerState(), rowsBeforeDdl = await state();
  for (const ddl of [`ALTER TABLE payroll_daily_snapshots DISABLE TRIGGER ${triggerName}`, `DROP TRIGGER ${triggerName} ON payroll_daily_snapshots`]) {
    await db.query('BEGIN');
    try { await db.query(ddl); await assert.rejects(() => persist(db, fixture()), error => error.code === 'payroll_snapshot_persistence_schema_required'); assert.deepEqual(await state(), rowsBeforeDdl); }
    finally { await db.query('ROLLBACK'); }
    assert.deepEqual(await triggerState(), triggerBefore); assert.deepEqual(await state(), rowsBeforeDdl);
  }
  for (const table of ['payroll_calculation_runs', 'payroll_daily_snapshots']) {
    await db.query('BEGIN');
    try { await assert.rejects(() => db.query(`UPDATE ${table} SET ${table === 'payroll_calculation_runs' ? 'engine_version=engine_version' : 'final_amount=final_amount'} WHERE venue_id=$1`, [id(1)]), error => error.code === '55000'); }
    finally { await db.query('ROLLBACK'); }
  }
  assert.deepEqual(await state(), rowsBeforeDdl);
  assert.deepEqual(await ledgerCounts(), beforeLedgers);
  evidence.assertions.push('Missing/disabled deferred trigger fails schema gate before writes; rollback restores catalog; committed histories immutable; payroll entries and expenses unchanged');
  evidence.status = 'PASS'; console.log('PAYROLL SNAPSHOT PERSISTENCE POSTGRES QA: PASS (synthetic storage only; no source authority or payout claim)');
} catch (error) {
  evidence.status = 'FAIL'; evidence.errorCode = error.code || error.name;
  throw error;
} finally {
  try { await mkdir(artifacts, { recursive: true }); await writeFile(path.join(artifacts, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`); }
  finally { await db.end(); }
}
