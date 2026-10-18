import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { calculatePayrollScheme: calculate } = require('../payroll-schemes.js');
const { persistPayrollSnapshotBundleInTransaction: persist } = require('../payroll-snapshot-persistence.js');
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const tables = ['payroll_calculation_runs', 'payroll_daily_snapshots', 'payroll_team_fund_snapshots',
  'payroll_daily_snapshot_lines', 'payroll_team_fund_snapshot_allocations',
  'payroll_milestone_day_snapshots', 'payroll_milestone_decision_snapshots'];
const constraints = [
  ...['payroll_daily_snapshots', 'payroll_daily_snapshot_lines', 'payroll_team_fund_snapshots', 'payroll_team_fund_snapshot_allocations'].map(t => `${t}_typed_totals`),
  ...['payroll_calculation_runs', 'payroll_daily_snapshots', 'payroll_milestone_day_snapshots', 'payroll_milestone_decision_snapshots'].map(t => `${t}_milestone_totals`)
];

// Actual calculator + supplied-evidence mapper inputs. Synthetic values convey
// no producer attestation; this contract checks persistence mechanics only.
function fixture(mode = 'stable_percent', milestone = false) {
  const role = { perShiftCents: 0, stableRateBps: 1000, targetCents: 10000, baseRateBps: 1600,
    bonusRateBps: 4800, excessRatePolicy: 'replace_base' };
  if (mode === 'margin_target') Object.assign(role, { lossPolicy: 'offset_daily_losses', itemRuleBasis: 'net_revenue' });
  if (mode === 'team_fund') Object.assign(role, { teamWeight: 1, teamFund: { poolId: 'bar', targetCents: 10000,
    baseRateBps: 1600, bonusRateBps: 4800, excessRatePolicy: 'replace_base', departments: ['bar'], distributionPolicy: 'configured_weights' } });
  if (milestone) role.milestoneBonusesCents = { 10000: 100 };
  const roster = milestone ? [3, 8] : [3];
  const attendance = milestone ? [{ id: id(7), employeeId: id(3), date: '2026-10-01', approved: true, workedMinutes: 60, plannedMinutes: 60 }] : [];
  const costSnapshot = { id: 'cost-synthetic', version: 'v1', currency: 'RUB', costCents: 5000 };
  const scenario = { scheme: { id: id(12), versionId: id(13), currency: 'RUB', mode, applyMilestones: milestone,
    ...(milestone ? { milestoneEligibility: 'worked_on_threshold_day' } : {}), roleParameters: { bar: role } },
    periodFrom: '2026-10-01', periodTo: '2026-10-01', employees: roster.map(n => ({ id: id(n) })), attendance,
    roleAssignments: roster.map(n => ({ employeeId: id(n), roleId: 'bar', effectiveFrom: '2026-10-01' })),
    coverage: { kind: 'month_to_date_complete', from: '2026-10-01', through: '2026-10-01', complete: true, watermark: 'synthetic' },
    attendanceCoverage: { kind: 'approved_attendance_complete', from: '2026-10-01', through: '2026-10-01', complete: true, watermark: 'attendance-synthetic' },
    sales: [{ id: id(5), employeeId: id(3), menuItemId: id(6), department: 'bar', date: '2026-10-01', commissionBaseCents: 20000,
      turnoverCents: 20000, ...(mode === 'margin_target' ? { costSnapshot } : {}) }] };
  const input = { venueId: id(1), runId: id(2), venueTimezone: 'UTC', attendance,
    employees: roster.map(n => ({ id: id(n), name: n === 3 ? "Employee ' ; --" : 'Rejected recipient' })),
    result: calculate(scenario), sourceLines: [{ id: id(5), orderId: id(4), orderItemId: id(5), employeeId: id(3), menuItemId: id(6),
      menuItemName: "Tea ' ; --", department: 'bar', roleId: 'bar', localDate: '2026-10-01', soldAt: '2026-10-01T12:00:00Z',
      quantity: '1', grossCents: 20100, discountCents: 100, refundCents: 0, commissionBaseCents: 20000, turnoverCents: 20000,
      ...(mode === 'margin_target' ? { costSnapshot: structuredClone(costSnapshot) } : {}) }] };
  if (milestone) Object.assign(input, { attendanceApprovalId: id(10), attendanceCoverage: scenario.attendanceCoverage,
    sourceAttendanceApproval: { approvalId: id(10), periodFrom: '2026-10-01', periodTo: '2026-10-01', timezone: 'UTC',
      venueId: id(1), sourceWatermark: 'attendance-synthetic' } });
  assert.equal(input.result.status, 'ready', JSON.stringify(input.result.blockers));
  const run = { id: id(2), venue_id: id(1), scheme_version_id: id(13), period_from: '2026-10-01', period_to: '2026-10-01',
    status: 'ready', source_coverage: 'complete', commission_basis: 'net_after_discounts_refunds', eligible_line_count: 1,
    unattributed_line_count: 0, missing_net_line_count: 0, input_watermark: 'synthetic-not-official', input_checksum: 'a'.repeat(64),
    engine_version: 'synthetic-qa', idempotency_key: 'synthetic-key', created_by: id(11), created_by_name: 'Owner',
    venue_timezone: 'UTC', currency: 'RUB', milestone_evidence_version: milestone ? 1 : 0 };
  return { run, input };
}

function fakeClient({ failTable, failConstraints = false, transaction = true, missingConstraint = false } = {}) {
  const calls = [], inserted = [], durable = [];
  let savepoint = false;
  return { calls, inserted, durable,
    async query(sql, values = []) {
      assert.equal(typeof sql, 'string');
      calls.push({ sql, values: structuredClone(values) });
      assert.doesNotMatch(sql, /\b(?:BEGIN|COMMIT|UPSERT|TRUNCATE|DELETE|UPDATE)\b/i, 'caller owns outer transaction; writer is insert-only');
      assert.doesNotMatch(sql, /\b(?:payroll_entries|expenses)\b/i);
      assert.doesNotMatch(sql, /ON\s+CONFLICT/i, 'idempotency belongs to caller');
      assert.doesNotMatch(sql, /SET\s+CONSTRAINTS\s+ALL/i, 'never flush producer constraints');
      if (/^\s*SAVEPOINT\b/i.test(sql)) {
        if (!transaction) throw Object.assign(new Error('no transaction'), { code: '25P01' });
        savepoint = true; return { rows: [], rowCount: 0 };
      }
      if (/^\s*ROLLBACK TO\b/i.test(sql)) { assert.ok(savepoint); durable.length = 0; return { rows: [], rowCount: 0 }; }
      if (/^\s*RELEASE\b/i.test(sql)) { assert.ok(savepoint); savepoint = false; return { rows: [], rowCount: 0 }; }
      if (/pg_trigger/.test(sql)) {
        const names = missingConstraint ? constraints.slice(1) : constraints;
        return { rows: names.map(name => ({ name, tgname: name, constraint_name: name, schema_name: 'public', nspname: 'public' })), rowCount: names.length };
      }
      if (/SET\s+CONSTRAINTS/i.test(sql)) {
        for (const name of constraints) assert.ok(sql.includes(name), `explicit constraint ${name}`);
        if (/IMMEDIATE/i.test(sql) && failConstraints) throw Object.assign(new Error('injected deferred constraint failure'), { code: '23514' });
        return { rows: [], rowCount: 0 };
      }
      const match = sql.match(/^\s*INSERT\s+INTO\s+(?:"?[a-z_]+"?\.)?"?([a-z_]+)"?\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i);
      assert.ok(match, `unexpected SQL: ${sql}`);
      assert.ok(savepoint, 'all writes enclosed in savepoint');
      const table = match[1]; assert.ok(tables.includes(table), table);
      const columns = match[2].split(',').map(s => s.trim().replaceAll('"', ''));
      assert.equal(new Set(columns).size, columns.length);
      assert.equal(columns.length, values.length);
      assert.doesNotMatch(sql, /Employee|Rejected recipient|Tea|synthetic-key/, 'values must be parameters');
      assert.doesNotMatch(match[2], /\b(?:key|snapshotKey|teamPoolKey|poolKey|dayKey)\b/);
      const row = Object.fromEntries(columns.map((key, index) => [key, values[index]]));
      const record = { table, row }; inserted.push(record);
      if (failTable === table) throw Object.assign(new Error(`injected ${table}`), { code: 'XX001' });
      durable.push(record);
      return { rows: [{ ...row }], rowCount: 1 };
    }
  };
}

function checkStored(db, fixtureData, mode, milestone) {
  const rows = table => db.durable.filter(r => r.table === table).map(r => r.row);
  assert.equal(rows(tables[0]).length, 1);
  const daily = rows(tables[1]), lines = rows(tables[3]);
  assert.equal(lines.length, 1); assert.ok(daily.length > 0);
  for (const row of daily) { assert.equal(row.snapshot_schema_version, 2); assert.equal(row.calculation_kind, mode); }
  const parent = daily.find(row => row.id === lines[0].snapshot_id);
  assert.ok(parent); assert.equal(parent.employee_id, lines[0].employee_id); assert.equal(parent.local_date, lines[0].local_date);
  assert.equal(lines[0].commission_base_net, '200.00');
  assert.equal(lines[0].snapshot_schema_version, 2);
  assert.equal(parent.final_amount, mode === 'stable_percent' ? milestone ? '21.00' : '20.00' : mode === 'personal_target' ? '64.00' : mode === 'margin_target' ? '40.00' : '64.00');
  for (const { row } of db.durable) {
    assert.match(row.id, /^[0-9a-f-]{36}$/i); assert.equal(row.venue_id, fixtureData.run.venue_id);
    if (row.run_id !== undefined) assert.equal(row.run_id, fixtureData.run.id);
  }
  assert.equal(new Set(db.durable.map(r => r.row.id)).size, db.durable.length, 'distinct IDs for every persisted row');
  if (mode === 'team_fund') {
    const pool = rows(tables[2])[0], allocation = rows(tables[4])[0];
    assert.equal(pool.fund_amount, '64.00'); assert.equal(lines[0].team_pool_snapshot_id, pool.id);
    assert.equal(allocation.pool_snapshot_id, pool.id); assert.equal(allocation.snapshot_id, parent.id);
    assert.equal(allocation.allocated_amount, '64.00');
  } else { assert.equal(rows(tables[2]).length, 0); assert.equal(rows(tables[4]).length, 0); }
  if (milestone) {
    const day = rows(tables[5])[0], decisions = rows(tables[6]);
    assert.equal(day.attendance_approval_id, id(10)); assert.equal(decisions.length, 2);
    assert.ok(decisions.every(r => r.day_snapshot_id === day.id));
    assert.equal(decisions.find(r => r.employee_id === id(8)).awarded_amount, '0.00');
    assert.equal(decisions.find(r => r.employee_id === id(8)).eligible, false);
  }
  const lastInsert = db.calls.findLastIndex(c => /^\s*INSERT/i.test(c.sql));
  const flush = db.calls.findIndex(c => /SET\s+CONSTRAINTS.*IMMEDIATE/is.test(c.sql));
  assert.ok(flush > lastInsert, 'all dependent rows precede forced constraints');
  assert.match(db.calls.at(-1).sql, /^\s*RELEASE/i);
}

for (const [mode, milestone] of [['stable_percent', false], ['personal_target', false], ['team_fund', false], ['margin_target', false], ['stable_percent', true]]) {
  const data = fixture(mode, milestone), before = structuredClone(data), db = fakeClient();
  await persist(db, data); checkStored(db, data, mode, milestone);
  assert.deepEqual(data, before, 'writer must not mutate supplied evidence/header');
}

// Every table family can fail after earlier writes. The helper removes its own
// partial bundle even when the caller catches the error and keeps its transaction.
for (const failTable of tables) {
  const db = fakeClient({ failTable }), data = fixture(failTable.includes('milestone') ? 'stable_percent' : 'team_fund', failTable.includes('milestone'));
  await assert.rejects(() => persist(db, data), error => error.code === 'XX001');
  assert.equal(db.durable.length, 0); assert.ok(db.calls.some(c => /^\s*ROLLBACK TO/i.test(c.sql)));
}
for (const options of [{ failConstraints: true }, { transaction: false }, { missingConstraint: true }]) {
  const db = fakeClient(options); await assert.rejects(() => persist(db, fixture()));
  assert.equal(db.durable.length, 0);
  if (!options.failConstraints) assert.equal(db.inserted.length, 0);
}
const invalid = [
  data => { data.run.venue_id = id(90); }, data => { data.run.id = id(90); },
  data => { data.run.scheme_version_id = id(90); }, data => { data.run.currency = 'USD'; },
  data => { data.run.venue_timezone = 'Asia/Yekaterinburg'; }, data => { data.run.period_to = '2026-10-02'; },
  data => { data.run.status = 'blocked'; }, data => { data.input.employees.push(structuredClone(data.input.employees[0])); },
  data => { data.input.sourceLines.push(structuredClone(data.input.sourceLines[0])); },
  data => { data.input.result.daily[0].employees[0].amountCents++; }
];
for (const mutate of invalid) {
  const data = fixture(), db = fakeClient(); mutate(data);
  await assert.rejects(() => persist(db, data));
  assert.equal(db.inserted.length, 0, 'invalid context/evidence rejected before first write');
}
{
  const data = fixture(), db = fakeClient(), originalId = data.run.id, query = db.query.bind(db);
  db.query = async (sql, values) => {
    if (sql.startsWith('SAVEPOINT ')) { data.run.id = id(99); data.input.sourceLines[0].menuItemName = 'Mutated after preparation'; }
    return query(sql, values);
  };
  const receipt = await persist(db, data);
  assert.equal(receipt.runId, originalId, 'receipt identifies the prepared run even when caller later changes input');
  assert.equal(db.durable.find(row => row.table === 'payroll_calculation_runs').row.id, originalId);
  assert.notEqual(db.durable.find(row => row.table === 'payroll_daily_snapshot_lines').row.menu_item_name_snapshot, 'Mutated after preparation');
}
console.log('PAYROLL SNAPSHOT PERSISTENCE CONTRACT: PASS (pure fake-client only; typed mappings, scoped constraints, parameterized writes, atomic savepoint rollback and immutable input; no source authority or PostgreSQL proof)');
