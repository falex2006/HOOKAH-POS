import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { validateQaDatabaseUrl, assertQaDatabaseIdentity } from './postgres-qa-safety.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sql = fs.readFileSync(path.join(root, 'migrations/087_payroll_typed_incentive_snapshots.sql'), 'utf8');
for (const name of ['payroll_team_fund_snapshots', 'payroll_team_fund_snapshot_allocations']) assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${name}`));
assert.match(sql, /DEFERRABLE INITIALLY DEFERRED/); assert.match(sql, /BEFORE TRUNCATE/);
assert.doesNotMatch(sql, /(?:INSERT INTO|UPDATE|DELETE FROM)\s+(?:orders|payments|payroll_entries|expenses)\b/i);
if (process.env.PAYROLL_MIGRATION_STATIC_ONLY === '1') {
  console.log('PAYROLL TYPED SNAPSHOT MIGRATION: STATIC PASS');
} else {
  const databaseUrl = process.env.MIGRATIONS_PG_TEST_DATABASE_URL;
  const target = validateQaDatabaseUrl(databaseUrl, 'MIGRATIONS_PG_TEST_DATABASE_URL');
  assert.ok(['territory_qa', 'hookah_local_qa'].includes(target.database), 'this fixture only targets a named dedicated local QA database');
  const { Client } = createRequire(import.meta.url)('pg');
  const { calculatePayrollScheme } = createRequire(import.meta.url)('../payroll-schemes.js');
  const { mapPayrollTypedSnapshotRows } = createRequire(import.meta.url)('../payroll-typed-snapshot-serializer.js');
  const client = new Client({ connectionString: databaseUrl });
  const schema = `payroll_typed_qa_${process.pid}_${Date.now()}`;
  let sequence = 0;
  const insert = async (table, values) => {
    const keys = Object.keys(values);
    return (await client.query(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`, keys.map((key) => Array.isArray(values[key]) && key.endsWith('_json') ? JSON.stringify(values[key]) : values[key]))).rows[0];
  };
  const reject = async (action, code) => {
    const savepoint = `typed_failure_${sequence++}`; await client.query(`SAVEPOINT ${savepoint}`);
    try { await assert.rejects(action(), (error) => error.code === code); }
    finally { await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`); await client.query(`RELEASE SAVEPOINT ${savepoint}`); }
  };
  const flush = async () => { await client.query('SET CONSTRAINTS ALL IMMEDIATE'); await client.query('SET CONSTRAINTS ALL DEFERRED'); };
  try {
    await client.connect();
    const identity = (await client.query('SELECT current_database() AS database, inet_server_addr() AS address, inet_server_port() AS port, (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser')).rows[0];
    assertQaDatabaseIdentity(identity, target.database, Number(target.url.port), 'Payroll typed snapshot QA database');
    assert.match(schema, /^payroll_typed_qa_\d+_\d+$/);
    await client.query('BEGIN');
    await client.query(`CREATE SCHEMA "${schema}"`); await client.query(`SET LOCAL search_path TO "${schema}",public`);
    await client.query(fs.readFileSync(path.join(root, 'schema.sql'), 'utf8'));
    for (const filename of fs.readdirSync(path.join(root, 'migrations')).filter((file) => file.endsWith('.sql') && Number(file.slice(0, 3)) <= 86).sort()) await client.query(fs.readFileSync(path.join(root, 'migrations', filename), 'utf8'));
    const venue = await insert('venues', { name: 'Typed snapshot QA' }), foreignVenue = await insert('venues', { name: 'Typed foreign QA' });
    const owner = await insert('users', { venue_id: venue.id, full_name: 'Owner', login: `typed-owner-${schema}`, role: 'owner' });
    const employee = await insert('users', { venue_id: venue.id, full_name: 'Employee', login: `typed-staff-${schema}`, role: 'bartender' });
    const employeeNoSales = await insert('users', { venue_id: venue.id, full_name: 'No sales', login: `typed-no-sales-${schema}`, role: 'bartender' });
    const foreignEmployee = await insert('users', { venue_id: foreignVenue.id, full_name: 'Foreign', login: `typed-other-${schema}`, role: 'bartender' });
    const product = await insert('products', { venue_id: venue.id, name: 'Typed item', category: 'bar', sale_price: 100 });
    const order = await insert('orders', { venue_id: venue.id, opened_by: owner.id, status: 'closed', closed_at: '2026-10-01T12:00:00Z', final_total_snapshot: 100 });
    const scheme = await insert('payroll_schemes', { venue_id: venue.id, name: 'Typed QA', created_by: owner.id, created_by_name: 'Owner' });
    const version = await insert('payroll_scheme_versions', { venue_id: venue.id, scheme_id: scheme.id, version_no: 1, mode: 'stable_percent', effective_from: '2026-10-01', created_by: owner.id, created_by_name: 'Owner' });
    await client.query("UPDATE payroll_scheme_versions SET status='active',status_changed_by=$1,status_changed_by_name='Owner',status_changed_at=now() WHERE id=$2", [owner.id, version.id]);
    const runValues = { venue_id: venue.id, scheme_version_id: version.id, venue_timezone: venue.timezone, currency: 'RUB', period_from: '2026-10-01', period_to: '2026-10-31', status: 'ready', source_coverage: 'complete', commission_basis: 'net_after_discounts_refunds', eligible_line_count: 1,
      unattributed_line_count: 0, missing_net_line_count: 0, input_watermark: 'qa', input_checksum: 'a'.repeat(64), engine_version: 'qa', idempotency_key: 'typed-qa', created_by: owner.id, created_by_name: 'Owner' };
    const run = await insert('payroll_calculation_runs', runValues);
    const dayValues = (date, kind = null) => ({ venue_id: venue.id, run_id: run.id, employee_id: employee.id, employee_name_snapshot: 'Employee', role_key_snapshot: 'bar', local_date: date,
      base_pay: '0.00', commission_pay: '10.00', milestone_bonus: '0.00', item_adjustments: '0.00', amount_before_cap: '10.00', cap_amount: null, cap_reduction: '0.00', final_amount: '10.00',
      ...(kind ? { snapshot_schema_version: 2, calculation_kind: kind, team_fund_pay: '0.00', incentive_json: kind === 'team_fund' ? {} : { roundingPolicy: 'component_half_up_v1' } } : {}) });
    const lineValues = async (snapshot, kind = null) => {
      const item = await insert('order_items', { order_id: order.id, product_id: product.id, quantity: 1, unit_price: 100, status: 'ready' });
      return { venue_id: venue.id, run_id: run.id, snapshot_id: snapshot.id, order_id: order.id, order_item_id: item.id, employee_id: employee.id, employee_name_snapshot: 'Employee', menu_item_id: product.id, menu_item_name_snapshot: 'Typed item', department_key: 'bar', sold_at: '2026-10-01T12:00:00Z', local_date: snapshot.local_date,
        quantity: '1.000', gross_amount: '100.00', discount_amount: '0.00', refund_amount: '0.00', commission_base_net: '100.00', applied_rate_bps: 1000, commission_amount: '10.00',
        ...(kind ? { snapshot_schema_version: 2, calculation_kind: kind, commission_kind: kind, applied_rate_bps: null, incentive_json: { roundingPolicy: 'component_half_up_v1' } } : {}) };
    };
    const legacy = await insert('payroll_daily_snapshots', dayValues('2026-10-01'));
    const legacyLine = await insert('payroll_daily_snapshot_lines', await lineValues(legacy));
    await client.query(sql); await client.query(sql);
    const legacyRead = (await client.query('SELECT snapshot_schema_version,calculation_kind,team_fund_pay,incentive_json FROM payroll_daily_snapshots WHERE id=$1', [legacy.id])).rows[0];
    assert.deepEqual(legacyRead, { snapshot_schema_version: 1, calculation_kind: 'legacy', team_fund_pay: '0.00', incentive_json: {} });
    assert.equal((await client.query('SELECT applied_rate_bps FROM payroll_daily_snapshot_lines WHERE id=$1', [legacyLine.id])).rows[0].applied_rate_bps, 1000);
    const personal = await insert('payroll_daily_snapshots', dayValues('2026-10-02', 'personal_target'));
    const personalLine = await insert('payroll_daily_snapshot_lines', await lineValues(personal, 'personal_target'));
    const margin = await insert('payroll_daily_snapshots', dayValues('2026-10-03', 'margin_target'));
    const marginValues = { ...await lineValues(margin, 'margin_target'), cost_snapshot_json: { id: 'immutable-cost', version: 'v1', currency: 'RUB', costCents: 12000 }, net_cost_amount: '120.00', signed_margin_amount: '-20.00' };
    const marginLine = await insert('payroll_daily_snapshot_lines', marginValues);
    await flush();
    for (const cost of [{ ...marginValues.cost_snapshot_json, id: 12 }, { ...marginValues.cost_snapshot_json, version: {} },
      { ...marginValues.cost_snapshot_json, currency: 123 }, { ...marginValues.cost_snapshot_json, costCents: 12001 },
      { ...marginValues.cost_snapshot_json, costCents: '12000' }, { ...marginValues.cost_snapshot_json, costCents: -1 }]) {
      await reject(() => insert('payroll_daily_snapshot_lines', { ...marginValues, cost_snapshot_json: cost }), '23514');
    }
    await reject(() => insert('payroll_daily_snapshot_lines', { ...marginValues, cost_snapshot_json: { ...marginValues.cost_snapshot_json, currency: 'USD' } }), '23514');
    await reject(() => insert('payroll_daily_snapshots', { ...dayValues('2026-10-05', 'personal_target'), employee_id: foreignEmployee.id }), '23503');
    await reject(() => insert('payroll_daily_snapshot_lines', { ...marginValues, order_item_id: personalLine.order_item_id, signed_margin_amount: '1.00' }), '23514');
    await reject(() => insert('payroll_daily_snapshots', { ...dayValues('2026-10-05', 'personal_target'), final_amount: '11.00' }), '23514');
    await reject(async () => insert('payroll_daily_snapshot_lines', { ...await lineValues(personal, 'personal_target'), applied_rate_bps: 1000 }), '23514');
    await reject(() => client.query('UPDATE payroll_daily_snapshots SET team_fund_pay=1 WHERE id=$1', [personal.id]), '55000');
    await reject(() => client.query('DELETE FROM payroll_daily_snapshot_lines WHERE id=$1', [marginLine.id]), '55000');
    await reject(() => client.query('TRUNCATE payroll_daily_snapshot_lines CASCADE'), '55000');
    const poolValues = { venue_id: venue.id, run_id: run.id, local_date: '2026-10-04', pool_key: 'bar', departments_json: ['bar'], distribution_policy: 'configured_weights', basis_amount: '100.00', target_amount: '100.00', below_target_amount: '100.00', excess_amount: '0.00', base_basis_amount: '100.00', base_rate_bps: 1000, bonus_rate_bps: 4000, excess_rate_policy: 'replace_base', base_commission: '10.00', excess_commission: '0.00', fund_amount: '10.00', rounding_policy: 'component_half_up_v1', evidence_json: { memberIds: [employee.id], sourceLineIds: [] } };
    const makeTeamBatch = async (date, share = '10.00', memberIds = [employee.id], { distributionPolicy = 'configured_weights', weight = 1, shiftDetails } = {}) => {
      const pool = await insert('payroll_team_fund_snapshots', { ...poolValues, local_date: date, distribution_policy: distributionPolicy, evidence_json: { ...poolValues.evidence_json, memberIds } });
      const day = await insert('payroll_daily_snapshots', { ...dayValues(date, 'team_fund'), commission_pay: '0.00', team_fund_pay: share, amount_before_cap: share, final_amount: share,
        ...(shiftDetails ? { eligible_shift_count: shiftDetails.length, explanation_json: { shiftDetails } } : {}) });
      const line = await insert('payroll_daily_snapshot_lines', { ...await lineValues(day), snapshot_schema_version: 2, calculation_kind: 'team_fund', commission_kind: 'team_source', applied_rate_bps: 0, commission_amount: '0.00', team_pool_snapshot_id: pool.id, pool_included: true, pool_basis_amount: '100.00' });
      const allocation = await insert('payroll_team_fund_snapshot_allocations', { venue_id: venue.id, run_id: run.id, local_date: date, pool_snapshot_id: pool.id, snapshot_id: day.id, employee_id: employee.id, weight, allocated_amount: share, allocation_policy: 'largest_remainder_code_unit_v1' });
      return { pool, day, line, allocation };
    };
    const team = await makeTeamBatch('2026-10-04'); await flush();
    await reject(async () => { await makeTeamBatch('2026-10-09', '10.00', [employee.id, employeeNoSales.id]); await flush(); }, '23514');
    const makeTwoMemberBatch = async (date, firstShare, secondShare, { firstWeight = 1, secondWeight = 1, fundAmount = '1.00' } = {}) => {
      const pennyFund = fundAmount === '0.01';
      const pool = await insert('payroll_team_fund_snapshots', { ...poolValues, local_date: date,
        base_rate_bps: pennyFund ? 1 : 100, base_commission: fundAmount, fund_amount: fundAmount, evidence_json: { memberIds: [employee.id, employeeNoSales.id], sourceLineIds: [] } });
      const first = await insert('payroll_daily_snapshots', { ...dayValues(date, 'team_fund'), commission_pay: '0.00', team_fund_pay: firstShare, amount_before_cap: firstShare, final_amount: firstShare });
      const second = await insert('payroll_daily_snapshots', { ...dayValues(date, 'team_fund'), employee_id: employeeNoSales.id, employee_name_snapshot: 'No sales', commission_pay: '0.00', team_fund_pay: secondShare, amount_before_cap: secondShare, final_amount: secondShare });
      const sourceBasis = '100.00';
      await insert('payroll_daily_snapshot_lines', { ...await lineValues(first), snapshot_schema_version: 2, calculation_kind: 'team_fund', commission_kind: 'team_source', applied_rate_bps: 0, commission_amount: '0.00', team_pool_snapshot_id: pool.id, pool_included: true, pool_basis_amount: sourceBasis });
      const allocation = (snapshot, employeeId, weight, amount) => insert('payroll_team_fund_snapshot_allocations', { venue_id: venue.id, run_id: run.id, local_date: date, pool_snapshot_id: pool.id, snapshot_id: snapshot.id, employee_id: employeeId, weight, allocated_amount: amount, allocation_policy: 'largest_remainder_code_unit_v1' });
      await allocation(first, employee.id, firstWeight, firstShare); await allocation(second, employeeNoSales.id, secondWeight, secondShare);
    };
    await makeTwoMemberBatch('2026-10-10', '0.50', '0.50'); await flush();
    await makeTwoMemberBatch('2026-10-15', '0.25', '0.75', { firstWeight: 1, secondWeight: 3 }); await flush();
    await reject(async () => { await makeTwoMemberBatch('2026-10-16', '0.50', '0.50', { firstWeight: 1, secondWeight: 3 }); await flush(); }, '23514');
    const attendanceOptions = { distributionPolicy: 'approved_minutes', weight: 90, shiftDetails: [{ shiftId: 'frozen-shift', workedMinutes: 90, plannedMinutes: 60, amountCents: 0 }] };
    await makeTeamBatch('2026-10-17', '10.00', [employee.id], attendanceOptions); await flush();
    await reject(async () => { await makeTeamBatch('2026-10-18', '10.00', [employee.id], { ...attendanceOptions, weight: 60 }); await flush(); }, '23514');
    await reject(async () => { await makeTeamBatch('2026-10-19', '10.00', [employee.id], { distributionPolicy: 'approved_minutes' }); await flush(); }, '23514');
    await reject(async () => { await makeTeamBatch('2026-10-20', '10.00', [employee.id], { ...attendanceOptions, shiftDetails: [{ ...attendanceOptions.shiftDetails[0], workedMinutes: '90' }] }); await flush(); }, '23514');
    await reject(async () => { await makeTeamBatch('2026-10-21', '10.00', [employee.id], { ...attendanceOptions, weight: 180, shiftDetails: [attendanceOptions.shiftDetails[0], attendanceOptions.shiftDetails[0]] }); await flush(); }, '23514');
    await makeTwoMemberBatch('2026-10-22', '0.01', '0.00', { firstWeight: Number.MAX_SAFE_INTEGER, secondWeight: Number.MAX_SAFE_INTEGER - 1, fundAmount: '0.01' }); await flush();
    await reject(async () => { await makeTwoMemberBatch('2026-10-11', '0.99', '0.01'); await flush(); }, '23514');
    const centToFirst = employee.id.toLowerCase() < employeeNoSales.id.toLowerCase();
    await makeTwoMemberBatch('2026-10-12', centToFirst ? '0.01' : '0.00', centToFirst ? '0.00' : '0.01', { fundAmount: '0.01' }); await flush();
    await reject(async () => { await makeTwoMemberBatch('2026-10-13', centToFirst ? '0.00' : '0.01', centToFirst ? '0.01' : '0.00', { fundAmount: '0.01' }); await flush(); }, '23514');
    await reject(async () => {
      const outsiderPool = await insert('payroll_team_fund_snapshots', { ...poolValues, local_date: '2026-10-14', evidence_json: { memberIds: [employee.id], sourceLineIds: [] } });
      const outsiderDay = await insert('payroll_daily_snapshots', { ...dayValues('2026-10-14', 'team_fund'), employee_id: employeeNoSales.id, employee_name_snapshot: 'No sales', commission_pay: '0.00', team_fund_pay: '10.00', amount_before_cap: '10.00', final_amount: '10.00' });
      await insert('payroll_daily_snapshot_lines', { ...await lineValues(outsiderDay), snapshot_schema_version: 2, calculation_kind: 'team_fund', commission_kind: 'team_source', applied_rate_bps: 0, commission_amount: '0.00', team_pool_snapshot_id: outsiderPool.id, pool_included: true, pool_basis_amount: '100.00' });
      await insert('payroll_team_fund_snapshot_allocations', { venue_id: venue.id, run_id: run.id, local_date: '2026-10-14', pool_snapshot_id: outsiderPool.id, snapshot_id: outsiderDay.id, employee_id: employeeNoSales.id, weight: 1, allocated_amount: '10.00', allocation_policy: 'largest_remainder_code_unit_v1' });
      await flush();
    }, '23514');
    for (const departments of [[1], [{}], ['bar','bar'], [' bar'], ['']]) {
      await reject(() => insert('payroll_team_fund_snapshots', { ...poolValues, local_date: '2026-10-06', departments_json: departments }), '23514');
    }
    await reject(async () => { await insert('payroll_team_fund_snapshots', { ...poolValues, local_date: '2026-10-06' }); await flush(); }, '23514');
    await reject(async () => { await insert('payroll_daily_snapshots', dayValues('2026-10-06', 'personal_target')); await flush(); }, '23514');
    await reject(async () => insert('payroll_daily_snapshot_lines', { ...await lineValues(legacy), applied_rate_bps: null }), '23514');
    await reject(async () => insert('payroll_daily_snapshot_lines', { ...await lineValues(team.day), snapshot_schema_version: 2, calculation_kind: 'team_fund', commission_kind: 'team_source',
      team_pool_snapshot_id: team.pool.id, pool_included: false, pool_basis_amount: '0.00', pool_exclusion_reason: null }), '23514');
    await reject(async () => {
      const hiddenPool = await insert('payroll_team_fund_snapshots', { ...poolValues, local_date: '2026-10-06', basis_amount: '0.00', below_target_amount: '0.00', base_basis_amount: '0.00', base_commission: '0.00', fund_amount: '0.00' });
      const hiddenDay = await insert('payroll_daily_snapshots', { ...dayValues('2026-10-06', 'team_fund'), commission_pay: '0.00', amount_before_cap: '0.00', final_amount: '0.00' });
      await insert('payroll_daily_snapshot_lines', { ...await lineValues(hiddenDay), snapshot_schema_version: 2, calculation_kind: 'team_fund', commission_kind: 'team_source', applied_rate_bps: 0, commission_amount: '0.00',
        team_pool_snapshot_id: hiddenPool.id, pool_included: false, pool_basis_amount: '0.00', pool_exclusion_reason: 'department_outside_pool' });
      await insert('payroll_team_fund_snapshot_allocations', { venue_id: venue.id, run_id: run.id, local_date: '2026-10-06', pool_snapshot_id: hiddenPool.id, snapshot_id: hiddenDay.id, employee_id: employee.id, weight: 1, allocated_amount: '0.00', allocation_policy: 'largest_remainder_code_unit_v1' });
      await flush();
    }, '23514');
    await reject(async () => { await makeTeamBatch('2026-10-06', '9.00'); await flush(); }, '23514');
    assert.equal((await client.query("SELECT count(*)::int AS count FROM payroll_team_fund_snapshots WHERE local_date='2026-10-06'")).rows[0].count, 0, 'failed deferred batch rolled back');
    await reject(() => client.query('UPDATE payroll_team_fund_snapshots SET pool_key=pool_key WHERE id=$1', [team.pool.id]), '55000');
    await reject(() => client.query('DELETE FROM payroll_team_fund_snapshot_allocations WHERE id=$1', [team.allocation.id]), '55000');
    await reject(() => client.query('TRUNCATE payroll_team_fund_snapshot_allocations'), '55000');
    const cap = await insert('payroll_daily_snapshots', { ...dayValues('2026-10-07', 'stable_percent'), commission_pay: '0.00', base_pay: '1.00', milestone_bonus: '2.00', amount_before_cap: '3.00', cap_amount: '0.50', cap_reduction: '0.50', final_amount: '2.50', incentive_json: {} });
    await flush(); assert.equal(cap.final_amount, '2.50', 'separate milestone can exceed shift cap');
    const blocked = await insert('payroll_calculation_runs', { ...runValues, status: 'blocked', source_coverage: 'unknown', commission_basis: 'unknown', input_checksum: null, blocked_reason: 'unknown upstream', idempotency_key: 'typed-blocked' });
    await reject(() => insert('payroll_team_fund_snapshots', { ...poolValues, run_id: blocked.id }), '55000');
    const { id: allocationId, ...foreignAllocation } = team.allocation;
    await reject(() => insert('payroll_team_fund_snapshot_allocations', { ...foreignAllocation, venue_id: foreignVenue.id }), '23514');
    // Actual calculator -> evidence -> DTO -> isolated SQL roundtrip. This is a
    // fixture writer, not a production run endpoint or source attestation.
    for (const mode of ['personal_target', 'margin_target', 'team_fund']) {
      const date = '2026-10-08';
      const typedRun = await insert('payroll_calculation_runs', { ...runValues, period_from: date, period_to: date, idempotency_key: `mapper-${mode}` });
      const item = await insert('order_items', { order_id: order.id, product_id: product.id, quantity: 1, unit_price: 200, status: 'ready' });
      const role = { perShiftCents: 0, targetCents: 10000, baseRateBps: 1600, bonusRateBps: 4800, excessRatePolicy: 'replace_base' };
      const costSnapshot = { id: 'cost-net-total', version: 'v1', currency: 'RUB', costCents: 5000 };
      if (mode==='margin_target') Object.assign(role, { lossPolicy: 'offset_daily_losses', itemRuleBasis: 'net_revenue' });
      if (mode==='team_fund') Object.assign(role, { teamWeight: 1, teamFund: { poolId: 'bar', departments: ['bar'], distributionPolicy: 'configured_weights', targetCents: 10000, baseRateBps: 1600, bonusRateBps: 4800, excessRatePolicy: 'replace_base' } });
      const lossItem = mode==='margin_target' ? await insert('order_items', { order_id: order.id, product_id: product.id, quantity: 1, unit_price: 10, status: 'ready' }) : null;
      const lossCost = { ...costSnapshot, costCents: 6000 };
      const calculated = calculatePayrollScheme({ scheme: { id: scheme.id, versionId: version.id, currency: 'RUB', mode, roleParameters: { bar: role } },
        periodFrom: date, periodTo: date, employees: [{ id: employee.id }], roleAssignments: [{ employeeId: employee.id, roleId: 'bar', effectiveFrom: '2026-10-01' }], attendance: [],
        coverage: { kind: 'month_to_date_complete', from: '2026-10-01', through: date, complete: true, watermark: 'fixture' },
        attendanceCoverage: { kind: 'approved_attendance_complete', from: '2026-10-01', through: date, complete: true, watermark: 'fixture' },
        sales: [{ id: item.id, employeeId: employee.id, menuItemId: product.id, department: 'bar', date, turnoverCents: 20000, commissionBaseCents: 20000, ...(mode==='margin_target' ? { costSnapshot } : {}) },
          ...(lossItem ? [{ id: lossItem.id, employeeId: employee.id, menuItemId: product.id, department: 'bar', date, turnoverCents: 1000, commissionBaseCents: 1000, costSnapshot: lossCost }] : [])] });
      const dto = mapPayrollTypedSnapshotRows({ venueId: venue.id, runId: typedRun.id, venueTimezone: venue.timezone,
        result: calculated, employees: [{ id: employee.id, name: 'Employee' }], sourceLines: [{ id: item.id, orderId: order.id, orderItemId: item.id, employeeId: employee.id, menuItemId: product.id, menuItemName: 'Typed item',
          roleId: 'bar', department: 'bar', localDate: date, soldAt: `${date}T12:00:00Z`, quantity: '1', grossCents: 20000, discountCents: 0, refundCents: 0, commissionBaseCents: 20000, turnoverCents: 20000, ...(mode==='margin_target' ? { costSnapshot } : {}) },
          ...(lossItem ? [{ id: lossItem.id, orderId: order.id, orderItemId: lossItem.id, employeeId: employee.id, menuItemId: product.id, menuItemName: 'Loss item', roleId: 'bar', department: 'bar', localDate: date,
            soldAt: `${date}T12:00:00Z`, quantity: '1', grossCents: 1000, discountCents: 0, refundCents: 0, commissionBaseCents: 1000, turnoverCents: 1000, costSnapshot: lossCost }] : [])] });
      const dayIds = new Map(), poolIds = new Map();
      for (const { key, ...row } of dto.dailySnapshots) dayIds.set(key, (await insert('payroll_daily_snapshots', row)).id);
      for (const { key, ...row } of dto.fundSnapshots) poolIds.set(key, (await insert('payroll_team_fund_snapshots', row)).id);
      for (const { snapshotKey, teamPoolKey, ...row } of dto.snapshotLines) await insert('payroll_daily_snapshot_lines', { ...row, snapshot_id: dayIds.get(snapshotKey), ...(teamPoolKey ? { team_pool_snapshot_id: poolIds.get(teamPoolKey) } : {}) });
      for (const { snapshotKey, poolKey, ...row } of dto.fundAllocations) await insert('payroll_team_fund_snapshot_allocations', { ...row, snapshot_id: dayIds.get(snapshotKey), pool_snapshot_id: poolIds.get(poolKey) });
      await flush();
      const persisted = (await client.query('SELECT snapshot_schema_version,calculation_kind,commission_pay,team_fund_pay,incentive_json FROM payroll_daily_snapshots WHERE run_id=$1', [typedRun.id])).rows[0];
      assert.equal(persisted.snapshot_schema_version, 2); assert.equal(persisted.calculation_kind, mode);
      assert.deepEqual(persisted.incentive_json, dto.dailySnapshots[0].incentive_json);
      assert.equal(persisted.commission_pay, dto.dailySnapshots[0].commission_pay); assert.equal(persisted.team_fund_pay, dto.dailySnapshots[0].team_fund_pay);
      if (lossItem) assert.equal((await client.query('SELECT signed_margin_amount FROM payroll_daily_snapshot_lines WHERE run_id=$1 AND order_item_id=$2', [typedRun.id,lossItem.id])).rows[0].signed_margin_amount, '-50.00');
    }
    await client.query(sql); await flush();
    console.log('PAYROLL TYPED SNAPSHOT MIGRATION: PASS (isolated PG replay, legacy, typed modes, tenant, immutable history and deferred conservation)');
  } finally { await client.query('ROLLBACK').catch(() => {}); await client.end(); }
}
