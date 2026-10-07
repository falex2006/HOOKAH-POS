'use strict';

// Pure DTO mapping only. A successful mapping is not an official-run attestation:
// this helper cannot verify source coverage, ownership, attribution or watermarks.
// It neither reads source systems nor authorizes/persists runs.
// `key` and `snapshotKey` are transient adapter tokens, not database columns;
// a future transactional writer must resolve them to snapshot_id before INSERT.
const { normalizePayrollMilestoneEvidence } = require('./payroll-milestone-evidence');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const fail = (code) => { throw Object.assign(new TypeError(code), { code }); };
const validDate = (value) => {
  if (typeof value !== 'string' || !DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value;
};
const uuid = (value, code) => {
  if (typeof value !== 'string' || !UUID.test(value)) fail(code);
  return value.toLowerCase();
};
const centsToDecimal = (value, code) => {
  if (!Number.isSafeInteger(value) || value < 0) fail(code);
  const cents = BigInt(value);
  if (cents / 100n > 99999999999999n) fail('payroll_snapshot_decimal_overflow');
  return `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
};
const cleanText = (value, max, code) => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) fail(code);
  return value.trim();
};
const quantity = (value) => {
  const raw = String(value);
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,3})?$/.test(raw)) fail('payroll_snapshot_quantity_invalid');
  const [whole, fraction = ''] = raw.split('.');
  const thousandths = BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, '0'));
  if (thousandths <= 0n || thousandths > 99999999999999n) fail('payroll_snapshot_quantity_invalid');
  return `${whole}.${fraction.padEnd(3, '0')}`;
};

const mapPayrollSnapshotRows = (input) => {
  const { venueId, runId, result, employees, sourceLines } = input;
  const venue = uuid(venueId, 'payroll_snapshot_venue_id_invalid');
  const run = uuid(runId, 'payroll_snapshot_run_id_invalid');
  if (!result || result.status !== 'ready' || result.payoutEligible !== true || result.criticalErrors?.length
      || !Array.isArray(result.daily) || !Array.isArray(result.employees)
      || !validDate(result.periodFrom) || !validDate(result.periodTo) || result.periodTo < result.periodFrom) fail('payroll_snapshot_result_not_ready');
  // Tiered daily incentives cannot be represented by the current immutable
  // line schema's one scalar rate. Require its future typed schema explicitly.
  const attendance = Object.getOwnPropertyDescriptor(input, 'attendance');
  if (attendance && !Object.hasOwn(attendance, 'value')) fail('payroll_milestone_evidence_object_invalid');
  const milestoneEvidence = normalizePayrollMilestoneEvidence(result, attendance ? { attendance: attendance.value } : {});
  const typedModes = ['personal_target', 'team_fund', 'margin_target'];
  if (typedModes.includes(result.mode) || result.modes?.some((mode) => typedModes.includes(mode))
      || result.daily.some((day) => day.teamFunds?.length
        || day.employees?.some((row) => typedModes.includes(row.mode) || row.targetIncentive || row.marginIncentive || row.teamFundAllocation || row.teamFundCents)
        || day.lines?.some((line) => line.targetAllocation || line.marginAllocation || line.teamFundSource || line.costSnapshot))) fail('payroll_snapshot_incentive_schema_required');
  if (!Array.isArray(employees) || !Array.isArray(sourceLines)) fail('payroll_snapshot_sources_required');

  const employeeById = new Map();
  for (const employee of employees) {
    const id = uuid(employee?.id, 'payroll_snapshot_employee_id_invalid');
    if (employeeById.has(id)) fail('payroll_snapshot_employee_duplicate');
    employeeById.set(id, cleanText(employee.name || employee.fullName, 160, 'payroll_snapshot_employee_name_missing'));
  }
  if (milestoneEvidence !== undefined) for (const day of milestoneEvidence) for (const decision of day.milestoneDecisions) {
    const recipient = uuid(decision.employeeId, 'payroll_snapshot_employee_id_invalid');
    if (recipient !== decision.employeeId) fail('payroll_snapshot_employee_id_invalid');
    if (!employeeById.has(recipient)) fail('payroll_snapshot_employee_context_mismatch');
    cleanText(decision.roleId, 80, 'payroll_snapshot_employee_context_missing');
  }
  const lineById = new Map();
  const orderItems = new Set();
  for (const source of sourceLines) {
    const id = uuid(source?.id, 'payroll_snapshot_line_id_invalid');
    const orderId = uuid(source.orderId, 'payroll_snapshot_order_id_missing');
    const orderItemId = uuid(source.orderItemId, 'payroll_snapshot_order_item_id_missing');
    if (lineById.has(id) || orderItems.has(orderItemId)) fail('payroll_snapshot_line_duplicate');
    lineById.set(id, { source, orderId, orderItemId });
    orderItems.add(orderItemId);
  }

  const dailySnapshots = [];
  const snapshotLines = [];
  const employeeDate = new Map();
  const dailySnapshotByKey = new Map();
  const snapshotCommissionByKey = new Map();
  const snapshotRevenueByKey = new Map();
  const calculatedLineIds = new Set();
  const seenDates = new Set();
  const calculationEmployeeIds = new Set();
  for (const row of result.employees) {
    const id = uuid(row?.employeeId, 'payroll_snapshot_employee_id_invalid');
    if (calculationEmployeeIds.has(id) || !employeeById.has(id)) fail('payroll_snapshot_employee_context_mismatch');
    calculationEmployeeIds.add(id);
  }
  for (const day of result.daily) {
    if (!validDate(day?.date) || day.date < result.periodFrom || day.date > result.periodTo
        || seenDates.has(day.date) || !Array.isArray(day.employees) || !Array.isArray(day.lines)) fail('payroll_snapshot_daily_row_invalid');
    seenDates.add(day.date);
    for (const row of day.employees) {
      const employeeId = uuid(row?.employeeId, 'payroll_snapshot_employee_id_invalid');
      const employeeName = employeeById.get(employeeId);
      if (!employeeName || typeof row.roleId !== 'string' || !row.roleId.trim() || row.roleId.length > 80) fail('payroll_snapshot_employee_context_missing');
      const key = `${employeeId}|${day.date}`;
      if (!calculationEmployeeIds.has(employeeId)) fail('payroll_snapshot_employee_context_mismatch');
      if (employeeDate.has(key)) fail('payroll_snapshot_employee_date_duplicate');
      employeeDate.set(key, row.roleId);
      if (!Number.isSafeInteger(row.shifts) || row.shifts < 0) fail('payroll_snapshot_shift_count_invalid');
      const capAmount = row.capCents === null ? null : centsToDecimal(row.capCents, 'payroll_snapshot_money_invalid');
      const detail = row.shiftDetails;
      if (!Array.isArray(detail) || !row.departmentSalesCents || typeof row.departmentSalesCents !== 'object'
          || !row.departmentTurnoverCents || typeof row.departmentTurnoverCents !== 'object') fail('payroll_snapshot_explanation_invalid');
      centsToDecimal(row.personalRevenueCents, 'payroll_snapshot_money_invalid');
      for (const amount of [...Object.values(row.departmentSalesCents), ...Object.values(row.departmentTurnoverCents)]) centsToDecimal(amount, 'payroll_snapshot_money_invalid');
      const snapshot = {
        key, venue_id: venue, run_id: run, employee_id: employeeId, employee_name_snapshot: employeeName,
        role_key_snapshot: row.roleId, local_date: day.date, eligible_shift_count: row.shifts,
        venue_turnover: centsToDecimal(day.venueTurnoverCents, 'payroll_snapshot_money_invalid'),
        cumulative_venue_turnover: centsToDecimal(day.cumulativeVenueTurnoverCents, 'payroll_snapshot_money_invalid'),
        base_pay: centsToDecimal(row.basePayCents, 'payroll_snapshot_money_invalid'),
        commission_pay: centsToDecimal(row.commissionCents, 'payroll_snapshot_money_invalid'),
        milestone_bonus: centsToDecimal(row.milestoneBonusCents, 'payroll_snapshot_money_invalid'),
        item_adjustments: '0.00',
        amount_before_cap: centsToDecimal(row.amountBeforeCapCents, 'payroll_snapshot_money_invalid'),
        cap_amount: capAmount, cap_reduction: centsToDecimal(row.capReductionCents, 'payroll_snapshot_money_invalid'),
        final_amount: centsToDecimal(row.amountCents, 'payroll_snapshot_money_invalid'),
        explanation_json: { shiftDetails: detail, personalRevenueCents: row.personalRevenueCents, departmentSalesCents: row.departmentSalesCents, departmentTurnoverCents: row.departmentTurnoverCents }
      };
      if (milestoneEvidence !== undefined) snapshot.explanation_json.milestoneDecisions = structuredClone(
        milestoneEvidence.find(entry => entry.date === day.date).milestoneDecisions.filter(decision => decision.employeeId === employeeId));
      dailySnapshots.push(snapshot);
      dailySnapshotByKey.set(key, snapshot);
    }
    for (const calculated of day.lines) {
      const lineId = uuid(calculated?.lineId, 'payroll_snapshot_calculated_line_id_invalid');
      if (calculatedLineIds.has(lineId)) fail('payroll_snapshot_calculated_line_duplicate');
      calculatedLineIds.add(lineId);
      const entry = lineById.get(lineId);
      if (!entry) fail('payroll_snapshot_source_line_missing');
      const { source, orderId, orderItemId } = entry;
      const employeeId = uuid(source.employeeId, 'payroll_snapshot_employee_id_invalid');
      const menuItemId = uuid(source.menuItemId, 'payroll_snapshot_menu_item_id_missing');
      const employeeName = employeeById.get(employeeId);
      const itemRuleId = calculated.itemRuleId == null ? null : uuid(calculated.itemRuleId, 'payroll_snapshot_item_rule_id_invalid');
      if (!employeeName || !calculationEmployeeIds.has(employeeId) || calculated.employeeId !== employeeId || !employeeDate.has(`${employeeId}|${day.date}`)
          || employeeDate.get(`${employeeId}|${day.date}`) !== calculated.roleId || source.localDate !== day.date
          || calculated.roleId !== source.roleId || calculated.menuItemId !== menuItemId || calculated.department !== source.department) fail('payroll_snapshot_source_line_mismatch');
      const qty = quantity(source.quantity);
      if (!validDate(source.localDate) || typeof source.soldAt !== 'string'
          || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(source.soldAt)
          || !Number.isFinite(Date.parse(source.soldAt))) fail('payroll_snapshot_source_line_invalid');
      const gross = centsToDecimal(source.grossCents, 'payroll_snapshot_money_invalid');
      const discount = centsToDecimal(source.discountCents, 'payroll_snapshot_money_invalid');
      const refund = centsToDecimal(source.refundCents, 'payroll_snapshot_money_invalid');
      const net = centsToDecimal(source.commissionBaseCents, 'payroll_snapshot_money_invalid');
      if (source.commissionBaseCents !== calculated.commissionBaseCents
          || BigInt(source.grossCents) !== BigInt(source.discountCents) + BigInt(source.refundCents) + BigInt(source.commissionBaseCents)
          || source.turnoverCents !== calculated.turnoverCents || source.appliedRateBps !== calculated.appliedRateBps
          || source.commissionCents !== calculated.commissionCents || !Number.isInteger(calculated.appliedRateBps)
          || calculated.appliedRateBps < 0 || calculated.appliedRateBps > 20000) fail('payroll_snapshot_source_amount_mismatch');
      const key = `${employeeId}|${day.date}`;
      if (!dailySnapshotByKey.has(key)) fail('payroll_snapshot_daily_employee_missing');
      const commissionTotal = (snapshotCommissionByKey.get(key) || 0) + calculated.commissionCents;
      if (!Number.isSafeInteger(commissionTotal)) fail('payroll_snapshot_money_invalid');
      snapshotCommissionByKey.set(key, commissionTotal);
      const revenueTotal = (snapshotRevenueByKey.get(key) || 0) + source.turnoverCents;
      if (!Number.isSafeInteger(revenueTotal)) fail('payroll_snapshot_money_invalid');
      snapshotRevenueByKey.set(key, revenueTotal);
      snapshotLines.push({
        snapshotKey: key, venue_id: venue, run_id: run, order_id: orderId, order_item_id: orderItemId,
        employee_id: employeeId, employee_name_snapshot: employeeName, menu_item_id: menuItemId,
        menu_item_name_snapshot: cleanText(source.menuItemName, 160, 'payroll_snapshot_item_name_missing'),
        department_key: cleanText(source.department, 80, 'payroll_snapshot_department_missing'),
        sold_at: new Date(source.soldAt).toISOString(), local_date: day.date, quantity: qty,
        gross_amount: gross, discount_amount: discount, refund_amount: refund, commission_base_net: net,
        applied_rate_bps: calculated.appliedRateBps, item_rule_id: itemRuleId,
        commission_amount: centsToDecimal(calculated.commissionCents, 'payroll_snapshot_money_invalid')
      });
    }
    for (const row of day.employees) {
      const key = `${String(row.employeeId).toLowerCase()}|${day.date}`;
      if (dailySnapshotByKey.get(key)?.commission_pay !== centsToDecimal(snapshotCommissionByKey.get(key) || 0, 'payroll_snapshot_money_invalid')) {
        fail('payroll_snapshot_commission_reconciliation_failed');
      }
      if (row.personalRevenueCents !== (snapshotRevenueByKey.get(key) || 0)) fail('payroll_snapshot_revenue_reconciliation_failed');
    }
  }
  if (calculatedLineIds.size !== lineById.size || [...lineById.keys()].some((id) => !calculatedLineIds.has(id))) fail('payroll_snapshot_source_coverage_mismatch');
  // Transient evidence preserves rejected recipients without payout rows. A
  // future writer must add durable day storage before accepting this sidecar.
  return { dailySnapshots, snapshotLines,
    ...(milestoneEvidence !== undefined ? { milestoneEvidence: structuredClone(milestoneEvidence) } : {}) };
};

module.exports = { mapPayrollSnapshotRows };
