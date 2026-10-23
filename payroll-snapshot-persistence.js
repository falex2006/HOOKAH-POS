'use strict';

// Private storage primitive. The caller owns source authorization, owner/tenant
// checks, the complete transaction, idempotency and retries. Supplied calculation
// evidence is not proof of source authority. No HTTP route calls this helper.
const { randomUUID } = require('node:crypto');
const { mapPayrollTypedSnapshotRows } = require('./payroll-typed-snapshot-serializer');
const { mapPayrollMilestoneStorageRows } = require('./payroll-milestone-storage-serializer');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const fail = suffix => { const code = `payroll_snapshot_persistence_${suffix}`; throw Object.assign(new TypeError(code), { code }); };
const plain = value => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail('object_invalid');
  for (const key of Reflect.ownKeys(value)) if (typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key)
      || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value')) fail('object_invalid');
};
const uuid = value => { if (typeof value !== 'string' || !UUID.test(value)) fail('uuid_invalid'); return value; };
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const text = (value, max) => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= max;
const columns = text => Object.freeze(text.split(' '));
const COLUMNS = Object.freeze({
  payroll_calculation_runs: columns('id venue_id scheme_version_id period_from period_to status source_coverage commission_basis eligible_line_count unattributed_line_count missing_net_line_count input_watermark input_checksum engine_version blocked_reason idempotency_key supersedes_run_id recalculation_reason created_by created_by_name venue_timezone currency milestone_evidence_version'),
  payroll_daily_snapshots: columns('id venue_id run_id employee_id employee_name_snapshot role_key_snapshot local_date snapshot_schema_version calculation_kind eligible_shift_count venue_turnover cumulative_venue_turnover base_pay commission_pay team_fund_pay milestone_bonus item_adjustments amount_before_cap cap_amount cap_reduction final_amount incentive_json explanation_json'),
  payroll_team_fund_snapshots: columns('id venue_id run_id local_date pool_key departments_json distribution_policy basis_amount target_amount below_target_amount excess_amount base_basis_amount base_rate_bps bonus_rate_bps excess_rate_policy base_commission excess_commission fund_amount rounding_policy evidence_json'),
  payroll_daily_snapshot_lines: columns('id venue_id run_id snapshot_id order_id order_item_id employee_id employee_name_snapshot menu_item_id menu_item_name_snapshot department_key sold_at local_date quantity gross_amount discount_amount refund_amount commission_base_net applied_rate_bps item_rule_id commission_amount snapshot_schema_version calculation_kind commission_kind incentive_json cost_snapshot_json net_cost_amount signed_margin_amount team_pool_snapshot_id pool_included pool_basis_amount pool_exclusion_reason'),
  payroll_team_fund_snapshot_allocations: columns('id venue_id run_id local_date pool_snapshot_id snapshot_id employee_id weight allocated_amount allocation_policy'),
  payroll_milestone_day_snapshots: columns('id venue_id run_id local_date attendance_approval_id previous_venue_turnover cumulative_venue_turnover decision_count awarded_total'),
  payroll_milestone_decision_snapshots: columns('id venue_id run_id day_snapshot_id local_date employee_id employee_name_snapshot role_key_snapshot threshold_amount declared_bonus eligibility apply_milestones employee_active eligible reason approved_worked_minutes awarded_amount qualifying_shift_ids')
});
const CONSTRAINTS = Object.freeze([
  ['payroll_daily_snapshots', 'payroll_daily_snapshots_typed_totals'],
  ['payroll_daily_snapshot_lines', 'payroll_daily_snapshot_lines_typed_totals'],
  ['payroll_team_fund_snapshots', 'payroll_team_fund_snapshots_typed_totals'],
  ['payroll_team_fund_snapshot_allocations', 'payroll_team_fund_snapshot_allocations_typed_totals'],
  ['payroll_calculation_runs', 'payroll_calculation_runs_milestone_totals'],
  ['payroll_daily_snapshots', 'payroll_daily_snapshots_milestone_totals'],
  ['payroll_milestone_day_snapshots', 'payroll_milestone_day_snapshots_milestone_totals'],
  ['payroll_milestone_decision_snapshots', 'payroll_milestone_decision_snapshots_milestone_totals']
]);
const quoteIdentifier = value => `"${String(value).replaceAll('"', '""')}"`;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

const prepare = ({ run, input }) => {
  plain(run); plain(input);
  for (const key of Object.keys(run)) if (!COLUMNS.payroll_calculation_runs.includes(key)) fail('run_field_unknown');
  for (const field of ['id', 'venue_id', 'scheme_version_id', 'created_by']) uuid(run[field]);
  if (run.recalculation_reason != null && (!text(run.recalculation_reason, 1000) || run.recalculation_reason.length < 3)) fail('recalculation_reason_invalid');
  if (run.supersedes_run_id != null) { uuid(run.supersedes_run_id); if (run.recalculation_reason == null) fail('recalculation_reason_invalid'); }
  if (!validDate(run.period_from) || !validDate(run.period_to) || run.period_to < run.period_from || run.period_from.slice(0, 7) !== run.period_to.slice(0, 7)) fail('period_invalid');
  if (run.status !== 'ready' || run.source_coverage !== 'complete' || run.commission_basis !== 'net_after_discounts_refunds'
      || run.unattributed_line_count !== 0 || run.missing_net_line_count !== 0 || run.blocked_reason != null
      || !Number.isSafeInteger(run.eligible_line_count) || run.eligible_line_count < 0 || run.eligible_line_count > 2147483647) fail('run_not_ready');
  if (!/^[0-9a-f]{64}$/.test(run.input_checksum || '') || !text(run.input_watermark, 500) || !text(run.engine_version, 120)
      || !text(run.idempotency_key, 160) || !text(run.created_by_name, 160)) fail('run_metadata_invalid');
  if (run.id !== input.runId || run.venue_id !== input.venueId || run.venue_timezone !== input.venueTimezone
      || run.scheme_version_id !== input.result?.schemeVersionId || run.currency !== input.result?.currency
      || run.period_from !== input.result?.periodFrom || run.period_to !== input.result?.periodTo) fail('run_context_mismatch');

  // Rebuild DTOs from the validated calculation. Never accept caller-mutated SQL
  // rows, silently omit a sidecar, or invent scalar rates for typed incentives.
  const snapshots = mapPayrollTypedSnapshotRows(input);
  const milestones = mapPayrollMilestoneStorageRows(input);
  if (run.milestone_evidence_version !== undefined && run.milestone_evidence_version !== milestones.milestoneEvidenceVersion) fail('milestone_version_mismatch');
  if (run.eligible_line_count !== snapshots.snapshotLines.length) fail('line_count_mismatch');
  const header = { ...run, blocked_reason: null, milestone_evidence_version: milestones.milestoneEvidenceVersion };
  const rows = Object.fromEntries(Object.keys(COLUMNS).map(table => [table, []]));
  rows.payroll_calculation_runs.push(header);
  const dayMap = new Map(), fundMap = new Map(), milestoneMap = new Map();
  const checkContext = row => {
    if (row.venue_id !== run.venue_id || row.run_id !== run.id || !validDate(row.local_date)
        || row.local_date < run.period_from || row.local_date > run.period_to) fail('row_context_mismatch');
  };
  const addParent = (sourceRows, table, map, keyOf) => {
    for (const source of sourceRows.slice().sort((a, b) => compare(a.key, b.key))) {
      checkContext(source);
      if (source.key !== keyOf(source) || map.has(source.key)) fail('parent_key_invalid');
      const { key, ...data } = source;
      const row = { id: randomUUID(), ...data };
      map.set(key, row); rows[table].push(row);
    }
  };
  addParent(snapshots.dailySnapshots, 'payroll_daily_snapshots', dayMap, row => `${uuid(row.employee_id)}|${row.local_date}`);
  addParent(snapshots.fundSnapshots, 'payroll_team_fund_snapshots', fundMap, row => `${row.local_date}|${row.pool_key}`);
  addParent(milestones.daySnapshots, 'payroll_milestone_day_snapshots', milestoneMap, row => `${run.id}|${row.local_date}`);
  const dailyParent = row => {
    const parent = dayMap.get(row.snapshotKey);
    if (!parent || parent.employee_id !== row.employee_id || parent.local_date !== row.local_date) fail('daily_parent_missing');
    return parent.id;
  };
  const fundParent = (row, key) => {
    const parent = fundMap.get(key);
    if (!parent || parent.local_date !== row.local_date) fail('fund_parent_missing');
    return parent.id;
  };
  const seenItems = new Set(), seenAllocations = new Set(), seenDecisions = new Set();
  for (const source of snapshots.snapshotLines.slice().sort((a, b) => compare(a.order_item_id, b.order_item_id))) {
    checkContext(source);
    if (seenItems.has(uuid(source.order_item_id))) fail('duplicate_item');
    seenItems.add(source.order_item_id);
    const { snapshotKey, teamPoolKey, ...data } = source;
    rows.payroll_daily_snapshot_lines.push({ id: randomUUID(), ...data, snapshot_id: dailyParent(source),
      team_pool_snapshot_id: teamPoolKey === undefined ? null : fundParent(source, teamPoolKey) });
  }
  for (const source of snapshots.fundAllocations.slice().sort((a, b) => compare(`${a.poolKey}|${a.employee_id}`, `${b.poolKey}|${b.employee_id}`))) {
    checkContext(source); const key = `${source.local_date}|${uuid(source.employee_id)}`;
    if (seenAllocations.has(key)) fail('duplicate_allocation'); seenAllocations.add(key);
    const { snapshotKey, poolKey, ...data } = source;
    rows.payroll_team_fund_snapshot_allocations.push({ id: randomUUID(), ...data, snapshot_id: dailyParent(source), pool_snapshot_id: fundParent(source, poolKey) });
  }
  for (const source of milestones.decisionSnapshots.slice().sort((a, b) => compare(`${a.dayKey}|${a.employee_id}|${a.threshold_amount}`, `${b.dayKey}|${b.employee_id}|${b.threshold_amount}`))) {
    checkContext(source); const key = `${source.local_date}|${uuid(source.employee_id)}|${source.threshold_amount}`;
    if (seenDecisions.has(key)) fail('duplicate_decision'); seenDecisions.add(key);
    const parent = milestoneMap.get(source.dayKey);
    if (!parent || parent.local_date !== source.local_date) fail('milestone_parent_missing');
    const { dayKey, ...data } = source;
    rows.payroll_milestone_decision_snapshots.push({ id: randomUUID(), ...data, day_snapshot_id: parent.id });
  }
  // Fail before any INSERT if a mapper's contract changes; never silently lose
  // evidence due to an outdated persistence column list.
  for (const [table, records] of Object.entries(rows)) for (const row of records) {
    plain(row);
    for (const key of Object.keys(row)) if (!COLUMNS[table].includes(key)) fail('row_field_unknown');
    for (const key of COLUMNS[table]) if (Object.hasOwn(row, key) && row[key] === undefined) fail('row_value_undefined');
  }
  return rows;
};

const persistPayrollSnapshotBundleInTransaction = async (db, bundle) => {
  if (!db || typeof db.query !== 'function') fail('connection_required');
  plain(bundle);
  if (Object.keys(bundle).some(key => !['run', 'input'].includes(key))) fail('bundle_field_unknown');
  const rows = prepare(bundle);
  const savepoint = `payroll_bundle_${randomUUID().replaceAll('-', '')}`;
  // SAVEPOINT fails before writes if called outside an explicit transaction.
  // The caller must supply a dedicated connection, never pool.query.
  await db.query(`SAVEPOINT ${savepoint}`);
  try {
    const available = await db.query(`SELECT expected.table_name, expected.constraint_name, ns.nspname AS schema_name
      FROM (VALUES ${CONSTRAINTS.map(([table, name]) => `('${table}','${name}')`).join(',')}) expected(table_name,constraint_name)
      JOIN pg_class rel ON rel.oid=to_regclass(expected.table_name)
      JOIN pg_namespace ns ON ns.oid=rel.relnamespace
      JOIN pg_trigger t ON t.tgrelid=rel.oid AND t.tgname=expected.constraint_name
      JOIN pg_constraint c ON c.oid=t.tgconstraint AND c.conname=expected.constraint_name
      WHERE t.tgdeferrable AND t.tginitdeferred AND t.tgenabled IN ('O','A') AND c.condeferrable AND c.convalidated`);
    const qualifiedConstraints = new Map(available.rows.map(row => [`${row.table_name}\0${row.constraint_name}`, row]));
    if (qualifiedConstraints.size !== CONSTRAINTS.length || CONSTRAINTS.some(([table, name]) => !qualifiedConstraints.has(`${table}\0${name}`))) fail('schema_required');
    const constraintNames = CONSTRAINTS.map(([table, name]) => {
      const schema = qualifiedConstraints.get(`${table}\0${name}`).schema_name;
      if (typeof schema !== 'string' || schema.length === 0) fail('schema_required');
      return `${quoteIdentifier(schema)}.${quoteIdentifier(name)}`;
    }).join(',');
    await db.query(`SET CONSTRAINTS ${constraintNames} DEFERRED`);
    const counts = {};
    for (const [table, records] of Object.entries(rows)) {
      counts[table] = 0;
      for (const row of records) {
        const fields = COLUMNS[table].filter(key => Object.hasOwn(row, key));
        const values = fields.map(key => key.endsWith('_json') && row[key] !== null ? JSON.stringify(row[key]) : row[key]);
        const inserted = await db.query(`INSERT INTO ${table} (${fields.join(',')}) VALUES (${fields.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`, values);
        if (inserted.rowCount !== 1 || inserted.rows[0]?.id !== row.id) fail('insert_count_mismatch');
        counts[table]++;
      }
    }
    // Do not flush unrelated POS/Finance deferred producer triggers with ALL.
    await db.query(`SET CONSTRAINTS ${constraintNames} IMMEDIATE`);
    await db.query(`RELEASE SAVEPOINT ${savepoint}`);
    return { runId: rows.payroll_calculation_runs[0].id, counts };
  } catch (error) {
    // No partial ready header even if the caller catches a JavaScript error and
    // later commits its transaction. Cleanup failure propagates; caller rolls back.
    await db.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    await db.query(`RELEASE SAVEPOINT ${savepoint}`);
    throw error;
  }
};

module.exports = { persistPayrollSnapshotBundleInTransaction };
