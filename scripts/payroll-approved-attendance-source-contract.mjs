import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { validateQaDatabaseUrl, assertQaDatabaseIdentity } from './postgres-qa-safety.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { Client } = require('pg');
const { makePayrollAttendanceManifestService } = require('../payroll-attendance-manifest.js');
const { makeService } = require('../payroll-scheme-service.js');
const target = validateQaDatabaseUrl(process.env.MIGRATIONS_PG_TEST_DATABASE_URL);
assert.ok(['hookah_local_qa', 'territory_qa'].includes(target.database));
const client = new Client({ connectionString: target.url.href });
const schema = `payroll_attendance_source_qa_${process.pid}_${Date.now()}`;
assert.match(schema, /^payroll_attendance_source_qa_\d+_\d+$/);
const service = makePayrollAttendanceManifestService({ connect: async () => { throw new Error('reader must reuse caller connection'); } });
const insert = async (table, data) => {
  const keys = Object.keys(data);
  return (await client.query(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i+1}`).join(',')}) RETURNING *`, Object.values(data))).rows[0];
};
const reject = (action, code) => assert.rejects(action, error => error.code === code);
try {
  await client.connect();
  const identity = (await client.query('SELECT current_database() AS database,inet_server_addr() AS address,inet_server_port() AS port,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser')).rows[0];
  assertQaDatabaseIdentity(identity, target.database, Number(target.url.port));
  await reject(() => service.loadVerifiedApprovedAttendanceSourceInTransaction(client, {}, {}), 'payroll_attendance_consistent_transaction_required');
  await client.query('SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL REPEATABLE READ');
  await reject(() => service.loadVerifiedApprovedAttendanceSourceInTransaction(client, {}, {}), 'payroll_attendance_transaction_required');
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  await client.query(`CREATE SCHEMA "${schema}"`);
  await client.query(`SET LOCAL search_path TO "${schema}",public`);
  await client.query(fs.readFileSync(path.join(root, 'schema.sql'), 'utf8'));
  for (const name of fs.readdirSync(path.join(root, 'migrations')).filter(name => name.endsWith('.sql') && Number(name.slice(0,3)) <= 82).sort()) await client.query(fs.readFileSync(path.join(root,'migrations',name),'utf8'));
  for (const number of [101, 102, 103, 104]) {
    const name = fs.readdirSync(path.join(root, 'migrations')).find(file => file.startsWith(`${number}_`) && file.endsWith('.sql'));
    assert.ok(name, `required attendance QA migration ${number} exists`);
    await client.query(fs.readFileSync(path.join(root, 'migrations', name), 'utf8'));
  }
  const venue = await insert('venues', { name: 'Attendance source QA' });
  const owner = await insert('users', { venue_id: venue.id, full_name: 'Owner', login: schema, role: 'owner' });
  const employee = await insert('users', { venue_id: venue.id, full_name: 'Employee', login: `${schema}-employee`, role: 'bartender' });
  const scheduledFunction = await insert('staff_schedule_functions', { venue_id: venue.id, name: 'Бар', created_by: owner.id });
  const principal = { venueId: venue.id, userId: owner.id };
  const period = { periodFrom: '2026-10-01', periodTo: '2026-10-03' };
  await reject(() => service.readCoverageInTransaction(client, principal, period), 'payroll_attendance_function_context_schema_required');
  const functionMigration = fs.readFileSync(path.join(root, 'migrations', '191_payroll_attendance_function_context.sql'), 'utf8');
  // A real pre-175 snapshot must survive the upgrade without inferred context.
  await client.query('SAVEPOINT historical_approval_upgrade');
  const legacyPeriod = { periodFrom: '2026-09-01', periodTo: '2026-09-01' };
  const legacySchedule = await insert('staff_schedules', { venue_id: venue.id, user_id: employee.id,
    work_date: '2026-09-01', planned_start: '2026-09-01T10:00:00Z', planned_end: '2026-09-01T18:00:00Z' });
  const legacyTimezone = venue.timezone || 'Asia/Yekaterinburg';
  const legacySource = { venueId: venue.id, timezone: legacyTimezone, period: legacyPeriod,
    schedules: [{ scheduleId: legacySchedule.id, employeeId: employee.id, employeeName: employee.full_name,
      workDate: '2026-09-01', plannedStart: '2026-09-01T10:00:00.000Z', plannedEnd: '2026-09-01T18:00:00.000Z' }], logs: [] };
  const legacyHeader = await insert('payroll_attendance_approvals', { venue_id: venue.id,
    period_from: legacyPeriod.periodFrom, period_to: legacyPeriod.periodTo, revision: 1,
    venue_timezone: legacyTimezone, reason: 'Pre-175 approval fixture',
    source_watermark: createHash('sha256').update(JSON.stringify(legacySource)).digest('hex'),
    source_schedule_count: 1, source_log_count: 0, shift_count: 1, approved_by: owner.id,
    approved_by_name: owner.full_name, idempotency_key: `${schema}-pre175` });
  const legacyShift = await insert('payroll_attendance_approval_shifts', { venue_id: venue.id,
    approval_id: legacyHeader.id, schedule_source_id: legacySchedule.id, employee_id: employee.id,
    employee_name_snapshot: employee.full_name, work_date: '2026-09-01',
    planned_start: legacySchedule.planned_start, planned_end: legacySchedule.planned_end,
    planned_minutes: 480, worked_minutes: 0, source_interval_count: 0 });
  await client.query(functionMigration); await client.query(functionMigration);
  const upgradedHeader = (await client.query('SELECT * FROM payroll_attendance_approvals WHERE id=$1', [legacyHeader.id])).rows[0];
  const upgradedShift = (await client.query('SELECT * FROM payroll_attendance_approval_shifts WHERE id=$1', [legacyShift.id])).rows[0];
  const { scheduled_function_id_snapshot, scheduled_function_name_snapshot, ...unchangedShift } = upgradedShift;
  assert.deepEqual(upgradedHeader, legacyHeader);
  assert.deepEqual(unchangedShift, legacyShift);
  assert.equal(scheduled_function_id_snapshot, null);
  assert.equal(scheduled_function_name_snapshot, null);
  const upgradedCoverage = await service.readCoverageInTransaction(client, principal, legacyPeriod);
  assert.equal(upgradedCoverage.complete, true);
  assert.equal(upgradedCoverage.stale, true);
  assert.equal(upgradedCoverage.currentApproval.approvalId, legacyHeader.id);
  await reject(() => service.loadVerifiedApprovedAttendanceSourceInTransaction(client, principal, legacyPeriod), 'payroll_attendance_approval_stale');
  await client.query('ROLLBACK TO SAVEPOINT historical_approval_upgrade');
  await client.query('RELEASE SAVEPOINT historical_approval_upgrade');
  await client.query(functionMigration); await client.query(functionMigration);
  await insert('staff_schedules', { venue_id: venue.id, user_id: employee.id, function_id: scheduledFunction.id,
    work_date: '2026-10-02', planned_start: '2026-10-02T10:00:00Z', planned_end: '2026-10-02T18:00:00Z' });
  await insert('staff_work_logs', { venue_id: venue.id, user_id: employee.id, started_at: '2026-10-02T10:00:00Z', ended_at: '2026-10-02T12:00:00Z', source: 'manual' });
  const manifest = await service.readCoverageInTransaction(client, principal, period);
  assert.equal(manifest.complete, true);
  assert.equal(manifest.shifts[0].scheduledFunctionId, scheduledFunction.id);
  assert.equal(manifest.shifts[0].scheduledFunctionName, 'Бар');
  await reject(() => service.loadVerifiedApprovedAttendanceSourceInTransaction(client, principal, period), 'payroll_attendance_approval_required');
  // Real payroll-owned approval rows over the live source; all writes are QA fixtures.
  const freeze = async (revision, overrides = {}) => {
    const header = await insert('payroll_attendance_approvals', { venue_id: venue.id, period_from: period.periodFrom, period_to: period.periodTo, revision,
      venue_timezone: manifest.timezone, reason: 'QA owner approval', source_watermark: manifest.sourceWatermark,
      source_schedule_count: manifest.scheduleCount, source_log_count: manifest.logCount, shift_count: manifest.shifts.length,
      approved_by: owner.id, approved_by_name: 'Owner', idempotency_key: `${schema}-${revision}`, ...overrides.header });
    for (const source of manifest.shifts) {
      const row = await insert('payroll_attendance_approval_shifts', { venue_id: venue.id, approval_id: header.id, schedule_source_id: source.scheduleId,
        employee_id: source.employeeId, employee_name_snapshot: source.employeeName, work_date: source.workDate,
      scheduled_function_id_snapshot: source.scheduledFunctionId, scheduled_function_name_snapshot: source.scheduledFunctionName,
        planned_start: source.plannedStart, planned_end: source.plannedEnd, planned_minutes: source.plannedMinutes,
        worked_minutes: source.workedMinutes, source_interval_count: source.sourceIntervals.length, ...overrides.shift });
      for (const interval of source.sourceIntervals) await insert('payroll_attendance_approval_intervals', { venue_id: venue.id, approval_id: header.id, shift_id: row.id,
        source_work_log_id: interval.id, employee_id: interval.employeeId, started_at: interval.startedAt, ended_at: interval.endedAt, source: interval.source, ...overrides.interval });
    }
    return header;
  };
  const header = await freeze(1);
  for (const shift of [{ scheduled_function_name_snapshot: null }, { scheduled_function_id_snapshot: null }]) {
    await client.query('SAVEPOINT invalid_function_pair');
    await reject(() => freeze(2, { shift }), '23514');
    await client.query('ROLLBACK TO SAVEPOINT invalid_function_pair'); await client.query('RELEASE SAVEPOINT invalid_function_pair');
  }
  let wrapperSequence = 0;
  const servicePool = { query: (...args) => client.query(...args), async connect() {
    const point = `preview_wrapper_${wrapperSequence++}`;
    return { async query(sql, args) {
      if (/^BEGIN\b/i.test(sql)) return client.query(`SAVEPOINT ${point}`);
      if (/^COMMIT\b/i.test(sql)) return client.query(`RELEASE SAVEPOINT ${point}`);
      if (/^ROLLBACK$/i.test(sql)) { await client.query(`ROLLBACK TO SAVEPOINT ${point}`); return client.query(`RELEASE SAVEPOINT ${point}`); }
      return client.query(sql, args);
    }, release() {} };
  } };
  const payroll = makeService(servicePool);
  const created = await payroll.createScheme(principal, { name: 'Verified source preview',
    payoutRiskAcknowledgement: { confirmed: true, policyCode: 'payroll-own-revenue-ceiling-v1' },
    definition: { mode: 'stable_percent', currency: 'RUB', effectiveFrom: period.periodFrom,
      roleParameters: { bar: { perShiftCents: 4800, stableRateBps: 1000 } },
      roleAssignments: [{ employeeId: employee.id, roleId: 'bar', effectiveFrom: period.periodFrom }] } });
  const previewInput = { ...period, employees: [{ id: employee.id }], sales: [],
    attendance: [{ id: 'forged', employeeId: employee.id, date: '2026-10-02', approved: true, plannedMinutes: 1, workedMinutes: 1 }],
    attendanceCoverage: { watermark: 'forged', complete: true },
    coverage: { kind: 'month_to_date_complete', from: period.periodFrom, through: period.periodTo, complete: true, watermark: 'scenario' } };
  const preview = await payroll.previewWithApprovedAttendance(principal, created.versions[0].versionId, previewInput);
  assert.equal(preview.official, false); assert.equal(preview.persistence, 'none');
  assert.equal(preview.sourceAttendanceApproval.approvalId, header.id);
  assert.equal(preview.attendanceContext[0].scheduledFunctionName, 'Бар');
  assert.equal(preview.attendanceContext[0].scheduledFunctionId, scheduledFunction.id);
  const details = preview.result.daily.flatMap(day => day.employees.flatMap(row => row.shiftDetails));
  assert.equal(details.length, 1); assert.equal(details[0].workedMinutes, 120); assert.notEqual(details[0].shiftId, 'forged');
  const result = await service.loadVerifiedApprovedAttendanceSourceInTransaction(client, principal, period);
  assert.equal(result.attendance[0].workedMinutes, 120);
  assert.equal(result.attendanceCoverage.watermark, manifest.sourceWatermark);
  assert.equal(result.sourceAttendanceApproval.approvalId, header.id);
  assert.deepEqual(result.attendanceContext.map(row => ({ id: row.scheduledFunctionId, name: row.scheduledFunctionName })),
    [{ id: scheduledFunction.id, name: 'Бар' }]);
  assert.equal(result.official, undefined);
  result.attendance[0].workedMinutes = 0;
  assert.equal((await service.loadVerifiedApprovedAttendanceSourceInTransaction(client, principal, period)).attendance[0].workedMinutes, 120);
  for (const overrides of [{ header: { shift_count: 2 } }, { shift: { worked_minutes: 121 } },
    { shift: { scheduled_function_name_snapshot: 'Чужая функция' } }, { interval: { source: 'device' } }]) {
    await client.query('SAVEPOINT hostile'); await freeze(2, overrides);
    await reject(() => service.loadVerifiedApprovedAttendanceSourceInTransaction(client, principal, period), 'payroll_attendance_snapshot_invalid');
    await reject(() => payroll.previewWithApprovedAttendance(principal, created.versions[0].versionId, previewInput), 'payroll_attendance_snapshot_invalid');
    await client.query('ROLLBACK TO SAVEPOINT hostile'); await client.query('RELEASE SAVEPOINT hostile');
  }
  await client.query('SAVEPOINT stale_function');
  const changedFunction = await insert('staff_schedule_functions', { venue_id: venue.id, name: 'Кальянная', created_by: owner.id });
  await client.query('UPDATE staff_schedules SET function_id=$1 WHERE venue_id=$2', [changedFunction.id, venue.id]);
  await reject(() => service.loadVerifiedApprovedAttendanceSourceInTransaction(client, principal, period), 'payroll_attendance_approval_stale');
  await client.query('ROLLBACK TO SAVEPOINT stale_function'); await client.query('RELEASE SAVEPOINT stale_function');
  await client.query('SAVEPOINT stale_function_name');
  await client.query("UPDATE staff_schedule_functions SET name='Новая функция' WHERE id=$1", [scheduledFunction.id]);
  await reject(() => service.loadVerifiedApprovedAttendanceSourceInTransaction(client, principal, period), 'payroll_attendance_approval_stale');
  await client.query('ROLLBACK TO SAVEPOINT stale_function_name'); await client.query('RELEASE SAVEPOINT stale_function_name');
  await client.query('SAVEPOINT immutable_function');
  await reject(() => client.query("UPDATE payroll_attendance_approval_shifts SET scheduled_function_name_snapshot='Изменено' WHERE approval_id=$1", [header.id]), '55000');
  await client.query('ROLLBACK TO SAVEPOINT immutable_function'); await client.query('RELEASE SAVEPOINT immutable_function');
  await client.query('SAVEPOINT stale');
  await client.query("UPDATE staff_work_logs SET ended_at='2026-10-02T13:00:00Z' WHERE venue_id=$1", [venue.id]);
  await reject(() => service.loadVerifiedApprovedAttendanceSourceInTransaction(client, principal, period), 'payroll_attendance_approval_stale');
  await reject(() => payroll.previewWithApprovedAttendance(principal, created.versions[0].versionId, previewInput), 'payroll_preview_attendance_approval_stale');
  await client.query('ROLLBACK TO SAVEPOINT stale'); await client.query('RELEASE SAVEPOINT stale');
  await reject(() => service.loadVerifiedApprovedAttendanceSourceInTransaction(client, { venueId: venue.id, userId: employee.id }, period), 'payroll_attendance_owner_or_venue_unavailable');
  await reject(() => service.loadVerifiedApprovedAttendanceSourceInTransaction(client, principal, { ...period, periodFrom: '2026-10-02' }), 'payroll_attendance_month_to_date_required');
  await client.query('SAVEPOINT incomplete');
  await insert('staff_work_logs', { venue_id: venue.id, user_id: employee.id, started_at: '2026-10-03T10:00:00Z', source: 'manual' });
  await reject(() => service.loadVerifiedApprovedAttendanceSourceInTransaction(client, principal, period), 'payroll_attendance_source_incomplete');
  await client.query('ROLLBACK TO SAVEPOINT incomplete');
  const emptyPeriod = { periodFrom: '2026-11-01', periodTo: '2026-11-03' };
  await client.query('SAVEPOINT unassigned_function');
  const unassignedEmployee = await insert('users', { venue_id: venue.id, full_name: 'Unassigned function employee', login: `${schema}-unassigned`, role: 'bartender' });
  await insert('staff_schedules', { venue_id: venue.id, user_id: unassignedEmployee.id, function_id: null,
    work_date: '2026-11-02', planned_start: '2026-11-02T10:00:00Z', planned_end: '2026-11-02T18:00:00Z' });
  await insert('staff_work_logs', { venue_id: venue.id, user_id: unassignedEmployee.id, started_at: '2026-11-02T10:00:00Z',
    ended_at: '2026-11-02T11:00:00Z', source: 'manual' });
  const unassignedManifest = await service.readCoverageInTransaction(client, principal, emptyPeriod);
  assert.equal(unassignedManifest.complete, true);
  assert.equal(unassignedManifest.shifts[0].scheduledFunctionId, null);
  assert.equal(unassignedManifest.shifts[0].scheduledFunctionName, null);
  await client.query('ROLLBACK TO SAVEPOINT unassigned_function'); await client.query('RELEASE SAVEPOINT unassigned_function');
  const emptyManifest = await service.readCoverageInTransaction(client, principal, emptyPeriod);
  await insert('payroll_attendance_approvals', { venue_id: venue.id, period_from: emptyPeriod.periodFrom, period_to: emptyPeriod.periodTo,
    revision: 1, venue_timezone: emptyManifest.timezone, reason: 'Explicit empty approval', source_watermark: emptyManifest.sourceWatermark,
    source_schedule_count: 0, source_log_count: 0, shift_count: 0, approved_by: owner.id, approved_by_name: 'Owner', idempotency_key: `${schema}-empty` });
  assert.equal(emptyManifest.complete, false, 'existing source contract requires planned shifts');
  await reject(() => service.loadVerifiedApprovedAttendanceSourceInTransaction(client, principal, emptyPeriod), 'payroll_attendance_source_incomplete');
  const foreignVenue = await insert('venues', { name: 'Foreign attendance QA' });
  await reject(() => service.loadVerifiedApprovedAttendanceSourceInTransaction(client, { venueId: foreignVenue.id, userId: owner.id }, period), 'payroll_attendance_owner_or_venue_unavailable');
  const effects = (await client.query('SELECT (SELECT count(*) FROM payroll_calculation_runs)::int AS runs,(SELECT count(*) FROM payroll_entries)::int AS entries,(SELECT count(*) FROM expenses)::int AS expenses')).rows[0];
  assert.deepEqual(effects, { runs: 0, entries: 0, expenses: 0 });
  console.log('PAYROLL APPROVED ATTENDANCE SOURCE: PASS (isolated PG, transaction gate, frozen lineage, stale/incomplete/hostile data, no financial writes)');
} finally { await client.query('ROLLBACK').catch(() => {}); await client.end(); }
