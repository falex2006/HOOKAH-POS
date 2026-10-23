'use strict';

// Builds candidate-only, venue-local daily evidence for the team-fund mode.
// It binds immutable classified sale lines to the saved version, eligible
// roster, and approved attendance; it never writes payroll or POS ledgers.
const { createHash } = require('node:crypto');
const { resolveRoleParameters, employeeActiveOn } = require('./payroll-schemes');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = value => typeof value === 'string' && DATE.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))
  && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value);
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
const addDay = date => new Date(Date.parse(`${date}T00:00:00.000Z`) + 86400000).toISOString().slice(0, 10);
const daysBetween = (from, through) => {
  if (!validDate(from) || !validDate(through) || through < from) return [];
  const days = [];
  for (let day = from; day <= through && days.length <= 31; day = addDay(day)) days.push(day);
  return days.length <= 31 ? days : [];
};
const invalid = (name, reason, context = {}) => ({ schemaVersion: 1, status: 'incomplete', reasons: [reason],
  sourceWatermark: null, watermarkScope: name, ...context });
const teamConfigSignature = pool => canonical({ poolId: pool?.poolId, targetCents: pool?.targetCents,
  baseRateBps: pool?.baseRateBps, bonusRateBps: pool?.bonusRateBps, excessRatePolicy: pool?.excessRatePolicy,
  distributionPolicy: pool?.distributionPolicy, departments: Array.isArray(pool?.departments) ? [...pool.departments].sort() : [] });

const buildPayrollCalculatorSales = ({ currency, recognitionManifest, recognitionProjection, departmentAttribution, marginCostSource }) => {
  if (!recognitionProjection || !Array.isArray(recognitionProjection.saleLines)) return [];
  const costs = new Map((marginCostSource?.status === 'available' ? marginCostSource.rows : []).map(row => [row.saleLineEventId, row.costSnapshot]));
  const classified = new Map((departmentAttribution?.rows || []).map(row => [row.saleLineEventId, row]));
  const productFacts = new Map((recognitionManifest?.saleLines || []).map(row => [row.saleLineEventId, row.productFacts || {}]));
  return recognitionProjection.saleLines.map(line => {
    const productId = productFacts.get(line.id)?.productId || line.menuItemId || null;
    const classification = classified.get(line.id);
    return { id: line.id, employeeId: line.employeeId, date: line.date, currency,
      menuItemId: productId, department: classification?.departmentCode || 'unclassified',
      turnoverCents: line.netRevenueCents, commissionBaseCents: line.commissionBaseCents,
      sourceWatermark: recognitionManifest?.watermark || null,
      ...(costs.has(line.id) ? { costSnapshot: structuredClone(costs.get(line.id)) } : {}) };
  });
};

const buildPayrollTeamFundSource = ({ venueId, scheme, period, currency, employees, roleAssignments, sales,
  attendance, attendanceCoverage, departmentAttribution, employmentEligibility }) => {
  const context = { venueId, schemeVersionId: scheme?.versionId || null, currency: currency || scheme?.currency || null,
    period: period && { from: period.from, to: period.to }, timezone: period?.timezone || null };
  const days = daysBetween(period?.from, period?.to);
  const reasons = new Set();
  if (!UUID.test(String(venueId || '')) || !scheme?.versionId || !scheme?.currency || !days.length
      || !Array.isArray(employees) || !Array.isArray(roleAssignments) || !Array.isArray(sales)
      || !Array.isArray(attendance)) reasons.add('payroll_team_fund_source_context_invalid');
  if (departmentAttribution?.status !== 'available' || departmentAttribution?.coverage?.complete !== true
      || departmentAttribution?.coverage?.venueId !== venueId
      || departmentAttribution?.coverage?.period?.from !== period?.from
      || departmentAttribution?.coverage?.period?.to !== period?.to
      || !SHA256.test(departmentAttribution?.coverage?.recognitionWatermark || '')
      || !UUID.test(String(departmentAttribution?.coverage?.mappingRevisionId || ''))
      || !SHA256.test(departmentAttribution?.sourceWatermark || '')) reasons.add('payroll_team_fund_department_attribution_incomplete');
  if ((sales || []).some(row => row?.sourceWatermark !== departmentAttribution?.coverage?.recognitionWatermark)) {
    reasons.add('payroll_team_fund_department_recognition_binding_mismatch');
  }
  if (!attendanceCoverage || attendanceCoverage.kind !== 'approved_attendance_complete'
      || attendanceCoverage.from !== `${period?.from?.slice(0, 7)}-01`
      || attendanceCoverage.through < period?.to || attendanceCoverage.complete !== true
      || !SHA256.test(attendanceCoverage.watermark || '')) reasons.add('payroll_team_fund_attendance_coverage_incomplete');
  if (!employmentEligibility?.revision?.id || !SHA256.test(employmentEligibility?.revision?.sourceWatermark || '')) {
    reasons.add('payroll_team_fund_employment_eligibility_incomplete');
  }

  const mappedLines = new Map();
  for (const row of departmentAttribution?.rows || []) {
    const id = String(row?.saleLineEventId || '').toLowerCase();
    if (!UUID.test(id) || mappedLines.has(id)) reasons.add('payroll_team_fund_department_line_identity_invalid');
    else mappedLines.set(id, row);
  }
  const saleById = new Map();
  const allocationLines = [];
  for (const row of sales || []) {
    const id = String(row?.id || '').toLowerCase();
    const mapping = mappedLines.get(id);
    if (!UUID.test(id) || saleById.has(id) || !row.employeeId || !UUID.test(String(row.employeeId))
        || !validDate(row.date) || row.date < period.from || row.date > period.to
        || row.currency !== (currency || scheme.currency) || !Number.isSafeInteger(row.turnoverCents) || row.turnoverCents < 0
        || !Number.isSafeInteger(row.commissionBaseCents) || row.commissionBaseCents < 0
        || row.sourceWatermark !== departmentAttribution?.coverage?.recognitionWatermark
        || !mapping || mapping.employeeId !== row.employeeId || mapping.recognizedLocalDate !== row.date
        || mapping.departmentCode !== row.department || !/^[a-z][a-z0-9_-]{0,63}$/.test(String(row.department || ''))
        || row.department === 'unclassified') {
      reasons.add('payroll_team_fund_department_sale_binding_invalid');
      continue;
    }
    saleById.set(id, row);
    allocationLines.push({ saleLineId: id, employeeId: row.employeeId, date: row.date,
      departmentCode: row.department, turnoverCents: row.turnoverCents, commissionBaseCents: row.commissionBaseCents });
  }
  if (mappedLines.size !== saleById.size || [...mappedLines.keys()].some(id => !saleById.has(id))) {
    reasons.add('payroll_team_fund_department_sale_coverage_mismatch');
  }
  allocationLines.sort((a, b) => a.date.localeCompare(b.date) || a.departmentCode.localeCompare(b.departmentCode)
    || a.employeeId.localeCompare(b.employeeId) || a.saleLineId.localeCompare(b.saleLineId));
  const allocationGroups = new Map();
  for (const line of allocationLines) {
    const key = `${line.date}|${line.departmentCode}|${line.employeeId}`;
    if (!allocationGroups.has(key)) allocationGroups.set(key, { date: line.date, departmentCode: line.departmentCode,
      employeeId: line.employeeId, turnoverCents: 0n, commissionBaseCents: 0n, saleLineIds: [] });
    const group = allocationGroups.get(key);
    group.turnoverCents += BigInt(line.turnoverCents);
    group.commissionBaseCents += BigInt(line.commissionBaseCents);
    group.saleLineIds.push(line.saleLineId);
  }
  const dailyDepartmentSales = [...allocationGroups.values()].map(row => {
    if (row.turnoverCents > BigInt(Number.MAX_SAFE_INTEGER) || row.commissionBaseCents > BigInt(Number.MAX_SAFE_INTEGER)) {
      reasons.add('payroll_team_fund_department_total_overflow');
    }
    return { date: row.date, departmentCode: row.departmentCode, employeeId: row.employeeId,
      turnoverCents: Number(row.turnoverCents), commissionBaseCents: Number(row.commissionBaseCents),
      saleLineIds: row.saleLineIds.sort() };
  }).sort((a, b) => a.date.localeCompare(b.date) || a.departmentCode.localeCompare(b.departmentCode) || a.employeeId.localeCompare(b.employeeId));

  const attendanceByEmployeeDay = new Map();
  const seenShiftIds = new Set();
  for (const row of attendance || []) {
    if (!UUID.test(String(row?.id || '')) || seenShiftIds.has(row.id) || !UUID.test(String(row?.employeeId || ''))
        || !validDate(row?.date) || row.date < period.from || row.date > period.to || row.approved !== true
        || !Number.isSafeInteger(row.workedMinutes) || row.workedMinutes < 0
        || !Number.isSafeInteger(row.plannedMinutes) || row.plannedMinutes <= 0 || row.workedMinutes > row.plannedMinutes) {
      reasons.add('payroll_team_fund_attendance_row_invalid');
      continue;
    }
    seenShiftIds.add(row.id);
    const key = `${row.date}|${row.employeeId}`;
    const list = attendanceByEmployeeDay.get(key) || [];
    list.push({ id: row.id, workedMinutes: row.workedMinutes, plannedMinutes: row.plannedMinutes });
    attendanceByEmployeeDay.set(key, list);
  }

  const memberGroups = new Map();
  for (const date of days) {
    const active = (employees || []).filter(row => UUID.test(String(row?.id || '')) && employeeActiveOn(row, date));
    for (const employee of active) {
      const matchingAssignments = (roleAssignments || []).filter(row => row?.employeeId === employee.id
        && row.effectiveFrom <= date && (!row.effectiveTo || row.effectiveTo >= date));
      if (matchingAssignments.length !== 1) {
        reasons.add(matchingAssignments.length ? 'payroll_team_fund_role_assignment_overlap' : 'payroll_team_fund_role_assignment_gap');
        continue;
      }
      const assignment = matchingAssignments[0];
      const params = resolveRoleParameters(scheme, employee.id, assignment.roleId, date);
      if (params?.mode !== 'team_fund') continue;
      const pool = params.teamFund;
      if (!pool || !Array.isArray(pool.departments) || !pool.departments.length
          || pool.departments.some(department => !/^[a-z][a-z0-9_-]{0,63}$/.test(department) || department === 'unclassified')
          || !['approved_minutes', 'configured_weights'].includes(pool.distributionPolicy)) {
        reasons.add('payroll_team_fund_configuration_invalid');
        continue;
      }
      const attendanceRows = attendanceByEmployeeDay.get(`${date}|${employee.id}`) || [];
      const configuredWeightValid = Number.isSafeInteger(params.teamWeight) && params.teamWeight >= 0;
      if (pool.distributionPolicy === 'configured_weights' && !configuredWeightValid) {
        reasons.add('payroll_team_fund_weight_invalid');
      }
      const weight = pool.distributionPolicy === 'approved_minutes'
        ? attendanceRows.reduce((sum, row) => sum + BigInt(row.workedMinutes), 0n)
        : BigInt(configuredWeightValid ? params.teamWeight : 0);
      if (weight > BigInt(Number.MAX_SAFE_INTEGER) || weight < 0n) reasons.add('payroll_team_fund_weight_invalid');
      const key = `${date}|${pool.poolId}`;
      if (!memberGroups.has(key)) memberGroups.set(key, { date, poolId: pool.poolId, distributionPolicy: pool.distributionPolicy,
        configSignature: teamConfigSignature(pool), departments: [...pool.departments].sort(), members: [] });
      const group = memberGroups.get(key);
      if (group.configSignature !== teamConfigSignature(pool) || group.distributionPolicy !== pool.distributionPolicy) {
        reasons.add('payroll_team_fund_shared_pool_config_mismatch');
      }
      group.members.push({ employeeId: employee.id, roleId: assignment.roleId, weight: Number(weight),
        inclusionReason: 'active_employment_and_effective_team_fund_assignment',
        attendanceShiftIds: attendanceRows.map(row => row.id).sort() });
    }
  }
  for (const group of memberGroups.values()) {
    group.members.sort((a, b) => a.employeeId.localeCompare(b.employeeId));
    if (new Set(group.members.map(row => row.employeeId)).size !== group.members.length) reasons.add('payroll_team_fund_member_duplicate');
  }
  const pools = [...memberGroups.values()].sort((a, b) => a.date.localeCompare(b.date) || a.poolId.localeCompare(b.poolId));
  const common = { ...context, zeroRefundCandidateRequired: true,
    recognitionWatermark: departmentAttribution?.coverage?.recognitionWatermark || null,
    departmentWatermark: departmentAttribution?.sourceWatermark || null,
    attendanceWatermark: attendanceCoverage?.watermark || null,
    employmentEligibilityRevisionId: employmentEligibility?.revision?.id || null,
    employmentEligibilityWatermark: employmentEligibility?.revision?.sourceWatermark || null };
  const status = reasons.size ? 'incomplete' : 'available';
  const departmentShiftAllocation = { schemaVersion: 1, status, reasons: [...reasons].sort(), ...common,
    coverage: { complete: status === 'available', from: period.from, through: period.to,
      saleLineCount: allocationLines.length, allocatedSaleLineCount: allocationLines.length },
    lines: allocationLines, dailyDepartmentSales,
    sourceWatermark: digest({ schemaVersion: 1, kind: 'department_shift_allocation_daily_candidate', common,
      coverage: { saleLineCount: allocationLines.length }, lines: allocationLines, dailyDepartmentSales }),
    watermarkScope: 'payroll_candidate_daily_department_sales_allocation' };
  const teamMembershipAndWeights = { schemaVersion: 1, status, reasons: [...reasons].sort(), ...common,
    coverage: { complete: status === 'available', from: period.from, through: period.to,
      activeEmployeeDays: days.reduce((sum, date) => sum + (employees || []).filter(row => employeeActiveOn(row, date)).length, 0),
      poolDayCount: pools.length, memberCount: pools.reduce((sum, pool) => sum + pool.members.length, 0) },
    pools, sourceWatermark: digest({ schemaVersion: 1, kind: 'team_membership_and_weights_candidate', common, pools }),
    watermarkScope: 'payroll_candidate_team_membership_and_weights' };
  return { schemaVersion: 1, status, reasons: [...reasons].sort(), departmentShiftAllocation,
    teamMembershipAndWeights, calculatorSales: structuredClone(sales || []), sourceWatermark: digest({ departmentShiftAllocation: departmentShiftAllocation.sourceWatermark,
      teamMembershipAndWeights: teamMembershipAndWeights.sourceWatermark }) };
};

module.exports = { buildPayrollCalculatorSales, buildPayrollTeamFundSource };
