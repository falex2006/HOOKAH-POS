'use strict';

const { validatePayrollSnapshotEvidence } = require('./payroll-snapshot-evidence');
const fail = (code) => { throw Object.assign(new TypeError(code), { code }); };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const uuid = (value) => {
  if (typeof value !== 'string' || !UUID.test(value)) fail('payroll_typed_snapshot_uuid_invalid');
  return value.toLowerCase();
};
const decimal = (value, signed = false) => {
  if (!Number.isSafeInteger(value) || (!signed && value < 0)) fail('payroll_typed_snapshot_money_invalid');
  const raw = BigInt(value), amount = raw < 0n ? -raw : raw;
  if (amount > 9999999999999999n) fail('payroll_typed_snapshot_decimal_overflow');
  return `${raw < 0n ? '-' : ''}${amount / 100n}.${String(amount % 100n).padStart(2, '0')}`;
};
const pick = (source, fields) => Object.fromEntries(fields.filter((field) => source[field] !== undefined).map((field) => {
  const value = source[field];
  if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) fail('payroll_typed_snapshot_evidence_type_invalid');
  return [field, value];
}));
const INCENTIVE_FIELDS = ['basisCents', 'targetCents', 'baseRateBps', 'bonusRateBps', 'excessRatePolicy', 'roundingPolicy', 'belowTargetCents', 'excessCents', 'baseBasisCents', 'baseCommissionCents', 'excessCommissionCents', 'commissionCents', 'signedMarginCents', 'payableMarginCents', 'positiveMarginCents', 'lossCents', 'lossOffsetCents', 'lossPolicy', 'itemRuleBasis'];
const ALLOCATION_FIELDS = ['belowTargetCents', 'excessCents', 'baseCommissionCents', 'excessCommissionCents', 'additiveCommissionCents', 'roundingPolicy', 'payableBasisCents', 'payableMarginCents', 'lossOffsetCents', 'itemRuleBasis'];
const TARGET_FIELDS = INCENTIVE_FIELDS.slice(0, 12);
const TARGET_ALLOCATION_FIELDS = ALLOCATION_FIELDS.slice(0, 6);
const dayKey = (employee, date) => `${uuid(employee)}|${date}`;
const poolKey = (date, pool) => `${date}|${pool}`;

// Detached DTOs for schema v2 only. Keys resolve to database UUIDs in a future
// atomic writer; they are not INSERT columns. This mapper attests no source and
// never authorizes, reads or writes an official payroll run.
const mapPayrollTypedSnapshotRows = (input) => {
  const context = validatePayrollSnapshotEvidence(input);
  const { result } = input;
  if (!['venue_daily_manifest_scenario', 'sales_line_sum_scenario'].includes(result.venueTurnoverBasis)) fail('payroll_typed_snapshot_turnover_basis_invalid');
  const { venueId, runId, employeeById, sourceById } = context;
  const dailySnapshots = [], snapshotLines = [], fundSnapshots = [], fundAllocations = [];
  for (const day of result.daily) {
    const modes = new Map(day.employees.map((row) => [uuid(row.employeeId), row.mode]));
    for (const row of day.employees) {
      const employeeId = uuid(row.employeeId), lines = day.lines.filter((line) => uuid(line.employeeId) === employeeId);
      const departments = (field, lineField) => {
        const source = row[field];
        if (!source || typeof source !== 'object' || Array.isArray(source)) fail('payroll_typed_snapshot_departments_invalid');
        const expected = new Map();
        for (const line of lines) expected.set(line.department, (expected.get(line.department) || 0n) + BigInt(line[lineField]));
        if (Object.keys(source).length !== expected.size) fail('payroll_typed_snapshot_departments_mismatch');
        for (const [key, amount] of expected) if (!Number.isSafeInteger(source[key]) || BigInt(source[key]) !== amount) fail('payroll_typed_snapshot_departments_mismatch');
        return Object.fromEntries([...expected].map(([key, amount]) => [key, Number(amount)]));
      };
      const incentive = row.mode === 'personal_target' ? row.targetIncentive : row.mode === 'margin_target' ? row.marginIncentive : null;
      dailySnapshots.push({ key: dayKey(employeeId, day.date), venue_id: venueId, run_id: runId, employee_id: employeeId,
        employee_name_snapshot: employeeById.get(employeeId).name, role_key_snapshot: row.roleId, local_date: day.date,
        snapshot_schema_version: 2, calculation_kind: row.mode, eligible_shift_count: row.shifts,
        venue_turnover: decimal(day.venueTurnoverCents), cumulative_venue_turnover: decimal(day.cumulativeVenueTurnoverCents),
        base_pay: decimal(row.basePayCents), commission_pay: decimal(row.commissionCents), team_fund_pay: decimal(row.teamFundCents),
        milestone_bonus: decimal(row.milestoneBonusCents), item_adjustments: '0.00', amount_before_cap: decimal(row.amountBeforeCapCents),
        cap_amount: row.capCents === null ? null : decimal(row.capCents), cap_reduction: decimal(row.capReductionCents), final_amount: decimal(row.amountCents),
        incentive_json: incentive ? pick(incentive, row.mode === 'personal_target' ? TARGET_FIELDS : INCENTIVE_FIELDS) : {},
        explanation_json: { shiftDetails: row.shiftDetails.map((shift) => pick(shift, ['shiftId', 'workedMinutes', 'plannedMinutes', 'amountCents'])),
          personalRevenueCents: row.personalRevenueCents, departmentSalesCents: departments('departmentSalesCents', 'commissionBaseCents'),
          departmentTurnoverCents: departments('departmentTurnoverCents', 'turnoverCents'), venueTimezone: context.venueTimezone,
          venueTurnoverBasis: result.venueTurnoverBasis } });
      if (context.milestoneEvidence !== undefined) dailySnapshots.at(-1).explanation_json.milestoneDecisions = structuredClone(
        context.milestoneEvidence.find(entry => entry.date === day.date).milestoneDecisions.filter(decision => decision.employeeId === employeeId));
    }
    for (const line of day.lines) {
      const source = sourceById.get(uuid(line.lineId)), mode = modes.get(source.employeeId);
      const kind = line.targetAllocation ? 'personal_target' : line.marginAllocation ? 'margin_target' : line.teamFundSource ? 'team_source' : 'scalar';
      const allocation = line.targetAllocation || line.marginAllocation;
      const cost = mode === 'margin_target' ? source.costSnapshot : null;
      const exclusion = line.teamFundSource && !line.teamFundSource.included ? line.itemRuleMode === 'replace' ? 'item_replacement' : 'department_outside_pool' : null;
      if (line.teamFundSource && line.teamFundSource.exclusionReason !== exclusion) fail('payroll_typed_snapshot_pool_exclusion_invalid');
      snapshotLines.push({ snapshotKey: dayKey(source.employeeId, day.date), venue_id: venueId, run_id: runId,
        order_id: source.orderId, order_item_id: source.orderItemId, employee_id: source.employeeId, employee_name_snapshot: source.employeeName,
        menu_item_id: source.menuItemId, menu_item_name_snapshot: source.menuItemName, department_key: source.department,
        sold_at: source.soldAt, local_date: day.date, quantity: source.quantity, gross_amount: source.grossAmount,
        discount_amount: source.discountAmount, refund_amount: source.refundAmount, commission_base_net: source.commissionBaseNet,
        applied_rate_bps: line.appliedRateBps, item_rule_id: line.itemRuleId == null ? null : uuid(line.itemRuleId), commission_amount: decimal(line.commissionCents),
        snapshot_schema_version: 2, calculation_kind: mode, commission_kind: kind,
        incentive_json: { ...(allocation ? pick(allocation, kind === 'personal_target' ? TARGET_ALLOCATION_FIELDS : ALLOCATION_FIELDS) : {}),
          ...pick(line, ['baseRateBps', 'itemRateBps']), itemRuleMode: line.itemRuleMode ?? null,
          ...(mode === 'margin_target' ? { marginPoolExcluded: line.marginPoolExcluded === true } : {}) },
        cost_snapshot_json: cost ? { ...cost } : null, net_cost_amount: cost ? decimal(cost.costCents) : null,
        signed_margin_amount: cost ? decimal(line.signedMarginCents, true) : null,
        ...(line.teamFundSource ? { teamPoolKey: poolKey(day.date, line.teamFundSource.poolId) } : {}),
        pool_included: line.teamFundSource?.included ?? null, pool_basis_amount: line.teamFundSource ? decimal(line.teamFundSource.basisCents) : null,
        pool_exclusion_reason: exclusion });
    }
    for (const pool of day.teamFunds) {
      const key = poolKey(day.date, pool.poolId);
      if (pool.poolId.length > 160 || pool.basis !== 'member_department_commission_base_scenario' || pool.departments.some((entry) => typeof entry !== 'string' || !entry.trim() || entry !== entry.trim() || entry.length > 80)) fail('payroll_typed_snapshot_pool_evidence_invalid');
      fundSnapshots.push({ key, venue_id: venueId, run_id: runId, local_date: day.date, pool_key: pool.poolId,
        departments_json: pool.departments.slice(), distribution_policy: pool.distributionPolicy,
        basis_amount: decimal(pool.basisCents), target_amount: decimal(pool.targetCents), below_target_amount: decimal(pool.belowTargetCents),
        excess_amount: decimal(pool.excessCents), base_basis_amount: decimal(pool.baseBasisCents), base_rate_bps: pool.baseRateBps,
        bonus_rate_bps: pool.bonusRateBps, excess_rate_policy: pool.excessRatePolicy, base_commission: decimal(pool.baseCommissionCents),
        excess_commission: decimal(pool.excessCommissionCents), fund_amount: decimal(pool.fundCents), rounding_policy: pool.roundingPolicy,
        evidence_json: { memberIds: pool.memberIds.map(uuid), sourceLineIds: pool.sourceLineIds.map(uuid), basis: pool.basis, venueTimezone: context.venueTimezone } });
      for (const allocation of pool.allocations) fundAllocations.push({ poolKey: key, snapshotKey: dayKey(allocation.id, day.date),
        venue_id: venueId, run_id: runId, local_date: day.date, employee_id: uuid(allocation.id), weight: String(allocation.weight),
        allocated_amount: decimal(allocation.amountCents), allocation_policy: 'largest_remainder_code_unit_v1' });
    }
  }
  // Sidecar includes rejected recipients without a daily payout row. A future
  // writer must persist it durably and must never silently discard it.
  return { dailySnapshots, snapshotLines, fundSnapshots, fundAllocations,
    ...(context.milestoneEvidence !== undefined ? { milestoneEvidence: structuredClone(context.milestoneEvidence) } : {}) };
};

module.exports = { mapPayrollTypedSnapshotRows };
