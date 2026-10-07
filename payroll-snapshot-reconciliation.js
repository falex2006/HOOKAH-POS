'use strict';

// Arithmetic evidence only. Success establishes neither source coverage nor
// tenant ownership and cannot authorize an official run or a payment.
const { allocateIncentiveFund, calculateTargetIncentive } = require('./payroll-incentive-math');
const { normalizePayrollMilestoneEvidence } = require('./payroll-milestone-evidence');
const MAX = BigInt(Number.MAX_SAFE_INTEGER);
const MODES = new Set(['progressive_daily', 'stable_percent', 'percent_only', 'final_month_threshold', 'personal_target', 'team_fund', 'margin_target']);
const FIELDS = ['shifts', 'personalRevenueCents', 'basePayCents', 'commissionCents', 'teamFundCents', 'milestoneBonusCents', 'amountBeforeCapCents', 'capReductionCents', 'amountCents'];
const fail = (suffix) => { throw Object.assign(new TypeError(`payroll_reconciliation_${suffix}`), { code: `payroll_reconciliation_${suffix}` }); };
const money = (value) => { if (!Number.isSafeInteger(value) || value < 0) fail('money_invalid'); return BigInt(value); };
const id = (value) => { if (typeof value !== 'string' || !value.trim() || value !== value.trim()) fail('id_invalid'); return value; };
const date = (value) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail('date_invalid');
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) fail('date_invalid');
  return value;
};
const sum = (rows, field) => rows.reduce((total, row) => total + money(row[field]), 0n);
const equal = (actual, expected, code) => { if (actual !== expected) fail(code); };
const rate = (value, max = 10000) => { if (!Number.isSafeInteger(value) || value < 0 || value > max) fail('rate_invalid'); return BigInt(value); };
const roundedRate = (basis, percentage) => (money(basis) * rate(percentage, 20000) + 5000n) / 10000n;
const allocated = (amount, weights) => {
  try { return new Map(allocateIncentiveFund(amount, weights).map((row) => [row.id, row.amountCents])); }
  catch (_) { fail('allocation_invalid'); }
};
const validateIncentiveFormula = (incentive) => {
  if (incentive.roundingPolicy !== 'component_half_up_v1') fail('rounding_policy_invalid');
  let expected;
  try { expected = calculateTargetIncentive({ basisCents: incentive.basisCents, targetCents: incentive.targetCents,
    baseRateBps: incentive.baseRateBps, bonusRateBps: incentive.bonusRateBps, excessRatePolicy: incentive.excessRatePolicy }); }
  catch (_) { fail('incentive_formula_invalid'); }
  for (const field of ['belowTargetCents', 'excessCents', 'baseBasisCents', 'baseCommissionCents', 'excessCommissionCents', 'commissionCents']) {
    equal(money(incentive[field]), BigInt(expected[field]), 'incentive_formula_mismatch');
  }
};
const reconcilePayrollSnapshotResult = (result, context = {}) => {
  if (!result || result.status !== 'ready' || result.payoutEligible !== true || !Array.isArray(result.blockers) || result.blockers.length
      || !Array.isArray(result.criticalErrors) || result.criticalErrors.length || !Array.isArray(result.daily) || !Array.isArray(result.employees)) fail('result_not_ready');
  const milestoneEvidence = normalizePayrollMilestoneEvidence(result, context);
  const from = date(result.periodFrom), through = date(result.periodTo);
  if (through < from || from.slice(0, 7) !== through.slice(0, 7)) fail('period_invalid');
  const periods = new Map(), accumulated = new Map(), seenDates = new Set(), lineIds = new Set(), shiftIds = new Set();
  for (const row of result.employees) {
    const key = id(row?.employeeId); if (periods.has(key)) fail('employee_duplicate');
    for (const field of FIELDS) money(row[field]);
    if (row.itemAdjustmentsCents !== undefined && money(row.itemAdjustmentsCents) !== 0n) fail('item_adjustment_unsupported');
    periods.set(key, row); accumulated.set(key, Object.fromEntries(FIELDS.map((field) => [field, 0n])));
  }
  for (const day of result.daily) {
    const current = date(day?.date);
    if (current < from || current > through || seenDates.has(current) || !Array.isArray(day.employees) || !Array.isArray(day.lines) || !Array.isArray(day.teamFunds)) fail('day_invalid');
    seenDates.add(current); money(day.venueTurnoverCents); money(day.cumulativeVenueTurnoverCents);
    const employees = new Map(), commissions = new Map(), revenues = new Map(), fundShares = new Map();
    for (const row of day.employees) {
      const key = id(row?.employeeId); if (!periods.has(key) || employees.has(key)) fail('day_employee_invalid');
      id(row.roleId);
      if (!MODES.has(row.mode)) fail('mode_invalid');
      if ((row.targetIncentive && row.mode !== 'personal_target') || (row.marginIncentive && row.mode !== 'margin_target')) fail('employee_incentive_mode_mismatch');
      for (const field of FIELDS) money(row[field]);
      if (row.itemAdjustmentsCents !== undefined && money(row.itemAdjustmentsCents) !== 0n) fail('item_adjustment_unsupported');
      equal(money(row.amountBeforeCapCents), money(row.basePayCents) + money(row.commissionCents) + money(row.teamFundCents) + money(row.milestoneBonusCents), 'components_mismatch');
      equal(money(row.amountBeforeCapCents), money(row.amountCents) + money(row.capReductionCents), 'cap_reduction_mismatch');
      if (row.capCents === null) equal(money(row.capReductionCents), 0n, 'uncapped_reduction');
      else {
        const cap = money(row.capCents), before = money(row.amountBeforeCapCents), bonus = money(row.milestoneBonusCents);
        // Both accepted milestone policies share before - reduction = final.
        const included = before > cap ? before - cap : 0n;
        const separate = before - bonus > cap ? before - bonus - cap : 0n;
        if (money(row.capReductionCents) !== included && money(row.capReductionCents) !== separate) fail('cap_policy_mismatch');
      }
      if (money(row.amountCents) > money(row.personalRevenueCents)) fail('revenue_ceiling');
      if (!Array.isArray(row.shiftDetails)) fail('shift_details_invalid');
      equal(money(row.shifts), BigInt(row.shiftDetails.length), 'shift_count_mismatch');
      for (const shift of row.shiftDetails) {
        const shiftId = id(shift?.shiftId); if (shiftIds.has(shiftId)) fail('shift_duplicate'); shiftIds.add(shiftId);
        const worked = money(shift.workedMinutes), planned = money(shift.plannedMinutes);
        if (planned === 0n) fail('shift_minutes_invalid'); money(shift.amountCents);
      }
      equal(sum(row.shiftDetails, 'amountCents'), money(row.basePayCents), 'shift_pay_mismatch');
      employees.set(key, row);
      for (const field of FIELDS) accumulated.get(key)[field] += money(row[field]);
    }
    for (const line of day.lines) {
      const lineId = id(line?.lineId); if (lineIds.has(lineId)) fail('line_duplicate'); lineIds.add(lineId);
      const key = id(line.employeeId); if (!employees.has(key) || line.roleId !== employees.get(key).roleId) fail('line_employee_mismatch');
      const commission = money(line.commissionCents), revenue = money(line.turnoverCents); money(line.commissionBaseCents);
      const mode = employees.get(key).mode;
      if (mode === 'team_fund' && !line.teamFundSource) fail('team_line_source_missing');
      if (mode === 'team_fund' && line.baseRateBps !== 0) fail('team_base_rate_invalid');
      if ((line.targetAllocation && mode !== 'personal_target') || (line.marginAllocation && mode !== 'margin_target') || (line.teamFundSource && mode !== 'team_fund')) fail('line_mode_mismatch');
      if (mode === 'margin_target') {
        if (!Number.isSafeInteger(line.signedMarginCents)) fail('signed_money_invalid');
        equal(money(line.commissionBaseCents) - money(line.costSnapshot?.costCents), BigInt(line.signedMarginCents), 'margin_cost_mismatch');
        if (line.marginCents !== undefined && line.marginCents !== line.signedMarginCents) fail('margin_alias_mismatch');
      }
      commissions.set(key, (commissions.get(key) || 0n) + commission); revenues.set(key, (revenues.get(key) || 0n) + revenue);
      const allocation = line.targetAllocation || line.marginAllocation;
      if (line.targetAllocation && line.marginAllocation) fail('line_incentive_conflict');
      if (allocation && (line.itemRuleMode === 'replace' || line.appliedRateBps !== null)) fail('typed_line_rate_invalid');
      if (allocation && line.baseRateBps !== null) fail('typed_line_rate_invalid');
      if (![null, undefined, 'replace', 'additive'].includes(line.itemRuleMode)) fail('item_rule_mode_invalid');
      const itemRate = Number(rate(line.itemRateBps));
      if (line.itemRuleMode == null && itemRate !== 0) fail('item_rule_rate_without_rule');
      if (allocation) {
        const addition = line.itemRuleMode === 'additive' ? roundedRate(line.commissionBaseCents, itemRate) : 0n;
        equal(money(allocation.additiveCommissionCents), addition, 'additive_rate_mismatch');
        if (allocation.roundingPolicy !== 'component_half_up_v1') fail('rounding_policy_invalid');
      } else {
        if (mode === 'personal_target' && line.itemRuleMode !== 'replace') fail('target_line_allocation_missing');
        if (mode === 'margin_target' && (line.itemRuleMode !== 'replace' || line.marginPoolExcluded !== true)) fail('margin_line_allocation_missing');
        const base = Number(rate(line.baseRateBps));
        const expectedRate = line.itemRuleMode === 'replace' ? itemRate : base + (line.itemRuleMode === 'additive' ? itemRate : 0);
        equal(rate(line.appliedRateBps, 20000), BigInt(expectedRate), 'scalar_rate_mismatch');
        equal(commission, roundedRate(line.commissionBaseCents, expectedRate), 'scalar_commission_mismatch');
      }
      if (allocation) equal(commission, money(allocation.baseCommissionCents) + money(allocation.excessCommissionCents) + money(allocation.additiveCommissionCents), 'line_incentive_mismatch');
    }
    const poolIds = new Set(), allocatedEmployees = new Set();
    for (const pool of day.teamFunds) {
      const poolId = id(pool?.poolId); if (poolIds.has(poolId) || pool.status === 'blocked' || !Array.isArray(pool.allocations) || !Array.isArray(pool.memberIds) || !Array.isArray(pool.sourceLineIds)) fail('pool_invalid'); poolIds.add(poolId);
      equal(money(pool.fundCents), money(pool.commissionCents), 'pool_total_mismatch');
      equal(money(pool.fundCents), money(pool.baseCommissionCents) + money(pool.excessCommissionCents), 'pool_components_mismatch');
      validateIncentiveFormula(pool);
      equal(sum(pool.allocations, 'amountCents'), money(pool.fundCents), 'pool_conservation');
      const members = new Set(pool.memberIds.map(id));
      if (members.size !== pool.memberIds.length || members.size !== pool.allocations.length) fail('pool_members_mismatch');
      const seen = new Set();
      for (const allocation of pool.allocations) {
        const key = id(allocation?.id); if (!members.has(key) || !employees.has(key) || employees.get(key).mode !== 'team_fund' || seen.has(key) || allocatedEmployees.has(key)) fail('pool_member_invalid');
        seen.add(key); allocatedEmployees.add(key); money(allocation.weight);
        fundShares.set(key, (fundShares.get(key) || 0n) + money(allocation.amountCents));
      }
      let expected;
      try { expected = allocateIncentiveFund(pool.fundCents, pool.allocations.map((row) => ({ id: row.id, weight: row.weight }))); }
      catch (_) { fail('pool_weights_invalid'); }
      const actual = new Map(pool.allocations.map((row) => [row.id, row.amountCents]));
      if (expected.some((row) => actual.get(row.id) !== row.amountCents)) fail('pool_distribution_mismatch');
      const sourceIds = new Set(pool.sourceLineIds.map(id));
      if (sourceIds.size !== pool.sourceLineIds.length) fail('pool_source_duplicate');
      const sources = day.lines.filter((line) => line.teamFundSource?.poolId === poolId && line.teamFundSource.included);
      if (sources.length !== sourceIds.size || sources.some((line) => !sourceIds.has(line.lineId) || !members.has(line.employeeId))) fail('pool_source_mismatch');
      for (const line of sources) equal(money(line.teamFundSource.basisCents), money(line.commissionBaseCents), 'pool_source_basis_mismatch');
      equal(sources.reduce((total, line) => total + money(line.teamFundSource.basisCents), 0n), money(pool.basisCents), 'pool_basis_mismatch');
      if (!Array.isArray(pool.departments) || !pool.departments.length || new Set(pool.departments).size !== pool.departments.length
          || !['approved_minutes', 'configured_weights'].includes(pool.distributionPolicy)) fail('pool_policy_invalid');
      if (pool.distributionPolicy === 'approved_minutes') for (const allocation of pool.allocations) {
        equal(money(allocation.weight), sum(employees.get(allocation.id).shiftDetails, 'workedMinutes'), 'pool_attendance_weight_mismatch');
      }
      for (const line of day.lines.filter((row) => row.teamFundSource?.poolId === poolId)) {
        if (!members.has(line.employeeId) || typeof line.teamFundSource.included !== 'boolean') fail('pool_line_member_mismatch');
        const eligible = pool.departments.includes(line.department) && line.itemRuleMode !== 'replace';
        if (line.teamFundSource.included !== eligible) fail('pool_line_eligibility_mismatch');
        if (!line.teamFundSource.included) equal(money(line.teamFundSource.basisCents), 0n, 'excluded_pool_basis');
      }
    }
    for (const line of day.lines) if (line.teamFundSource && !poolIds.has(line.teamFundSource.poolId)) fail('pool_source_orphan');
    for (const [key, row] of employees) {
      equal(money(row.commissionCents), commissions.get(key) || 0n, 'commission_mismatch');
      equal(money(row.personalRevenueCents), revenues.get(key) || 0n, 'revenue_mismatch');
      equal(money(row.teamFundCents), fundShares.get(key) || 0n, 'team_share_mismatch');
      if (row.mode === 'team_fund' && !allocatedEmployees.has(key)) fail('team_membership_missing');
      const incentive = row.mode === 'personal_target' ? row.targetIncentive : row.mode === 'margin_target' ? row.marginIncentive : null;
      if (['personal_target', 'margin_target'].includes(row.mode) && !incentive) fail('incentive_missing');
      if (incentive) {
        if (incentive.status === 'blocked' || incentive.roundingPolicy !== 'component_half_up_v1') fail('incentive_invalid');
        const lines = day.lines.filter((line) => line.employeeId === key && (row.mode === 'personal_target' ? line.targetAllocation : line.marginAllocation));
        const allocationKey = row.mode === 'personal_target' ? 'targetAllocation' : 'marginAllocation';
        if (row.mode === 'margin_target' && (incentive.lossPolicy !== 'offset_daily_losses' || incentive.itemRuleBasis !== 'net_revenue')) fail('margin_policy_invalid');
        equal(money(incentive.commissionCents), money(incentive.baseCommissionCents) + money(incentive.excessCommissionCents), 'incentive_components_mismatch');
        validateIncentiveFormula(incentive);
        for (const field of ['baseCommissionCents', 'excessCommissionCents', 'belowTargetCents', 'excessCents']) equal(lines.reduce((total, line) => total + money(line[allocationKey][field]), 0n), money(incentive[field]), 'incentive_allocation_mismatch');
        equal(money(incentive.basisCents), money(incentive.belowTargetCents) + money(incentive.excessCents), 'incentive_basis_mismatch');
        if (row.mode === 'personal_target') equal(sum(lines, 'commissionBaseCents'), money(incentive.basisCents), 'target_basis_mismatch');
        else {
          if (!Number.isSafeInteger(incentive.signedMarginCents)) fail('signed_money_invalid');
          let signed = 0n, positive = 0n;
          for (const line of lines) {
            if (!Number.isSafeInteger(line.signedMarginCents)) fail('signed_money_invalid');
            const margin = BigInt(line.signedMarginCents); signed += margin; if (margin > 0n) positive += margin;
            equal(money(line.commissionBaseCents) - money(line.costSnapshot?.costCents), margin, 'margin_cost_mismatch');
            const payable = money(line.marginAllocation.payableMarginCents);
            if (line.marginAllocation.payableBasisCents !== undefined) equal(money(line.marginAllocation.payableBasisCents), payable, 'margin_basis_alias_mismatch');
            if (payable > (margin > 0n ? margin : 0n)) fail('margin_allocation_exceeds_positive');
            equal(money(line.marginAllocation.lossOffsetCents), (margin > 0n ? margin : 0n) - payable, 'line_loss_offset_mismatch');
            equal(payable, money(line.marginAllocation.belowTargetCents) + money(line.marginAllocation.excessCents), 'line_margin_basis_mismatch');
          }
          if (signed > MAX || signed < -MAX || positive > MAX || positive - signed > MAX) fail('total_overflow');
          equal(BigInt(incentive.signedMarginCents), signed, 'signed_margin_mismatch');
          equal(money(incentive.positiveMarginCents), positive, 'positive_margin_mismatch');
          equal(money(incentive.lossCents), positive - signed, 'margin_loss_mismatch');
          equal(money(incentive.payableMarginCents), signed > 0n ? signed : 0n, 'payable_margin_mismatch');
          equal(money(incentive.basisCents), money(incentive.payableMarginCents), 'margin_basis_mismatch');
          equal(money(incentive.lossOffsetCents), positive - money(incentive.payableMarginCents), 'loss_offset_mismatch');
          equal(lines.reduce((total, line) => total + money(line.marginAllocation.payableMarginCents), 0n), money(incentive.payableMarginCents), 'margin_allocation_mismatch');
        }
        const weights = lines.map((line) => ({ id: line.lineId, weight: row.mode === 'personal_target' ? line.commissionBaseCents : Math.max(line.signedMarginCents, 0) }));
        const payable = row.mode === 'personal_target' ? new Map(weights.map((weight) => [weight.id, weight.weight])) : allocated(incentive.basisCents, weights);
        const below = allocated(incentive.belowTargetCents, lines.map((line) => ({ id: line.lineId, weight: payable.get(line.lineId) })));
        const base = allocated(incentive.baseCommissionCents, lines.map((line) => ({ id: line.lineId, weight: incentive.excessRatePolicy === 'add_to_base' ? payable.get(line.lineId) : below.get(line.lineId) })));
        const excess = allocated(incentive.excessCommissionCents, lines.map((line) => ({ id: line.lineId, weight: payable.get(line.lineId) - below.get(line.lineId) })));
        for (const line of lines) {
          const part = line[allocationKey], key = line.lineId;
          equal(money(part.belowTargetCents), BigInt(below.get(key)), 'line_distribution_mismatch');
          equal(money(part.excessCents), BigInt(payable.get(key) - below.get(key)), 'line_distribution_mismatch');
          equal(money(part.baseCommissionCents), BigInt(base.get(key)), 'line_distribution_mismatch');
          equal(money(part.excessCommissionCents), BigInt(excess.get(key)), 'line_distribution_mismatch');
          if (row.mode === 'margin_target') {
            equal(money(part.payableMarginCents), BigInt(payable.get(key)), 'line_distribution_mismatch');
            if (part.itemRuleBasis !== 'net_revenue' || line.marginPoolExcluded) fail('margin_policy_invalid');
          } else equal(money(part.belowTargetCents) + money(part.excessCents), money(line.commissionBaseCents), 'line_target_basis_mismatch');
        }
      }
    }
  }
  for (let current = new Date(`${from}T00:00:00Z`); current.toISOString().slice(0, 10) <= through; current.setUTCDate(current.getUTCDate() + 1)) {
    if (!seenDates.has(current.toISOString().slice(0, 10))) fail('day_coverage_missing');
  }
  for (const [key, row] of periods) for (const field of FIELDS) {
    const total = accumulated.get(key)[field]; if (total > MAX) fail('total_overflow');
    equal(money(row[field]), total, 'period_total_mismatch');
  }
  return { arithmeticValidated: true, dayCount: seenDates.size, employeeCount: periods.size, lineCount: lineIds.size,
    ...(milestoneEvidence !== undefined ? { milestoneEvidence } : {}) };
};
module.exports = { reconcilePayrollSnapshotResult };
