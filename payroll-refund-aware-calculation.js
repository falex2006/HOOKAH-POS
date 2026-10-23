'use strict';

// Initial version2 calculation from independently verified source families.
// Pure validation is not DB authority or permission to post/pay a result.
const { createHash } = require('node:crypto');
const { normalizePayrollSourcePolicies } = require('./payroll-source-policies');
const { calculatePayrollScheme, employeeActiveOn } = require('./payroll-schemes');
const { buildPayrollModeAvailability } = require('./payroll-mode-availability');
const { buildEligibleEmployees } = require('./payroll-employment-eligibility');
const { buildPayrollEmployeeRoleCoverage } = require('./payroll-employee-role-coverage');
const { buildPayrollProductDepartmentSource } = require('./payroll-product-department-source');
const { buildPayrollTeamFundSource } = require('./payroll-team-fund-source');
const { validateCalculatorInputRows, validateEmploymentEligibilityEvidence,
  validateEmploymentEligibilityEmployeeBindings } = require('./payroll-calculation-input-contract');
const { buildPayrollRefundEconomicSource } = require('./payroll-refund-economic-source');
const { buildPayrollRefundFrozenCostSource } = require('./payroll-refund-frozen-cost-source');
const CAPABILITY = 'employee_attributed_remaining_net_refund_v2';
const SHA = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().filter(key => value[key] !== undefined)
    .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const frozen = value => { if (value && typeof value === 'object' && !Object.isFrozen(value)) {
  Object.values(value).forEach(frozen); Object.freeze(value); } return value; };
const copy = value => structuredClone(value);
const datesFor = period => {
  const days = [];
  for (let date = period.from; date <= period.to && days.length < 32;
    date = new Date(Date.parse(`${date}T00:00:00Z`) + 86400000).toISOString().slice(0, 10)) days.push(date);
  return days;
};

function buildPayrollRefundAwareCalculation({ venueId, scheme, period, periodClosure, recognitionEvidence,
  employmentEligibility, approvedAttendanceSource = null, departmentMapping = null, costEvidenceByOrder = null } = {}) {
  const reasons = new Set();
  const blocked = () => frozen({ schemaVersion: 2, capabilityVersion: CAPABILITY, status: 'blocked',
    officialReady: false, payoutEligible: false, sourceAttested: false, persistence: 'none',
    reasons: [...reasons].sort(), input: null, engineResult: null, amountCents: null });
  const add = (code) => reasons.add(code);
  if (!UUID.test(venueId || '') || !UUID.test(scheme?.versionId || '') || scheme?.currency !== 'RUB'
      || !validDate(period?.from) || !validDate(period?.to) || period.from > period.to
      || period.from !== `${period.from.slice(0, 7)}-01` || period.from.slice(0, 7) !== period.to.slice(0, 7)) {
    add('payroll_refund_aware_context_invalid'); return blocked();
  }
  let policies;
  try { policies = normalizePayrollSourcePolicies(scheme.sourcePolicies); } catch (_) { /* fail closed below */ }
  if (policies?.schemaVersion !== 2 || canonical(policies) !== canonical(scheme.sourcePolicies)) {
    add('payroll_refund_aware_explicit_policy_required'); return blocked();
  }
  const mode = buildPayrollModeAvailability({}, {}, scheme, period)[scheme.mode];
  if (!mode || mode.configurationStatus !== 'available') {
    (mode?.configurationReasons || ['payroll_refund_aware_mode_invalid']).forEach(add); return blocked();
  }
  const required = mode.requiredFacts, timezone = periodClosure?.timezone;
  let closed = false;
  try {
    const closureDate = new Intl.DateTimeFormat('en-CA', { timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(periodClosure.transactionTimestamp));
    closed = periodClosure.schemaVersion === 1 && periodClosure.venueId === venueId
      && periodClosure.period?.from === period.from && periodClosure.period?.to === period.to
      && typeof timezone === 'string' && timezone.length > 0 && validDate(periodClosure.venueLocalDate)
      && closureDate === periodClosure.venueLocalDate && closureDate > period.to;
  } catch (_) { /* missing source closure cannot authorize closed-period input */ }
  if (!closed) { add('payroll_calculation_period_not_closed'); return blocked(); }
  let economics;
  try { economics = buildPayrollRefundEconomicSource(recognitionEvidence,
    { venueId, currency: scheme.currency, from: period.from, to: period.to }); }
  catch (error) { add(error.code || 'payroll_refund_aware_economic_source_invalid'); return blocked(); }
  const projection = economics.projection, manifest = recognitionEvidence.manifest;
  const eligibilityComponent = employmentEligibility?.component;
  validateEmploymentEligibilityEvidence(employmentEligibility, eligibilityComponent, venueId).forEach(add);
  if (eligibilityComponent?.status !== 'available') add('payroll_refund_aware_eligibility_unavailable');
  if (reasons.size) return blocked();
  const employees = buildEligibleEmployees(employmentEligibility.periods.map(({ employeeId, effectiveFrom, effectiveTo }) =>
    ({ employeeId, effectiveFrom, effectiveTo })), period.from, period.to);
  if (employees.length > 500) { add('payroll_refund_aware_roster_limit'); return blocked(); }
  const roleCoverage = buildPayrollEmployeeRoleCoverage({ venueId, scheme, period, eligibilitySource: employmentEligibility, employees });
  if (roleCoverage.status !== 'available') roleCoverage.reasons.forEach(add);
  let department = null;
  if (required.includes('immutableDepartmentAttribution')) {
    if (!departmentMapping?.revision || !Array.isArray(departmentMapping.mappings)) add('payroll_refund_aware_department_source_missing');
    else {
      try { department = buildPayrollProductDepartmentSource({ venueId, period, timezone, recognitionManifest: manifest,
        revision: departmentMapping.revision, mappings: departmentMapping.mappings }); }
      catch (error) { add(error.code || 'payroll_refund_aware_department_source_invalid'); }
      if (department && department.status !== 'available') department.reasons.forEach(add);
    }
  }
  let costs = null;
  if (required.includes('marginCosts')) {
    costs = buildPayrollRefundFrozenCostSource({ venueId, currency: scheme.currency, period, sourcePolicies: policies,
      projection, evidenceByOrder: costEvidenceByOrder });
    if (costs.status !== 'available') (costs.reasons || ['payroll_refund_aware_cost_source_invalid']).forEach(add);
  } else if (costEvidenceByOrder !== null) add('payroll_refund_aware_unexpected_cost_evidence');
  const days = datesFor(period), monthEnd = new Date(Date.UTC(Number(period.from.slice(0, 4)), Number(period.from.slice(5, 7)), 0)).toISOString().slice(0, 10);
  const fullMonth = required.includes('closedMonthCoverage');
  if (fullMonth && period.to !== monthEnd) add('payroll_refund_aware_full_month_required');
  if (reasons.size) return blocked();
  const departments = new Map((department?.rows || []).map(row => [row.saleLineEventId, row.departmentCode]));
  const costByLine = new Map((costs?.rows || []).map(row => [row.saleLineEventId, row.costSnapshot]));
  const input = { periodFrom: period.from, periodTo: period.to, scheme: copy(scheme), employees,
    roleAssignments: copy(scheme.roleAssignments || []), employmentEligibilityRevisionId: employmentEligibility.revision.id,
    coverage: { kind: fullMonth ? 'month_closed_complete' : 'month_to_date_complete', from: period.from,
      through: period.to, complete: true, watermark: hash({ capability: CAPABILITY, economics: economics.sourceWatermark,
        department: department?.sourceWatermark || null, costs: costs?.sourceWatermark || null }) },
    ...(fullMonth ? { monthClosed: true } : {}),
    sales: projection.saleLines.filter(line => line.inEarningPeriod).map(line => ({ id: line.saleLineEventId,
      employeeId: line.sellerId, date: line.recognizedLocalDate, currency: scheme.currency, menuItemId: line.productFacts.productId,
      department: departments.get(line.saleLineEventId) || 'unclassified', turnoverCents: line.remainingNetCents,
      commissionBaseCents: line.remainingNetCents, sourceWatermark: manifest.watermark,
      economicSourceWatermark: economics.sourceWatermark,
      ...(costByLine.has(line.saleLineEventId) ? { costSnapshot: copy(costByLine.get(line.saleLineEventId)) } : {}) })) };
  const components = { recognitionManifest: { sourceWatermark: manifest.watermark } };
  if (required.includes('approvedAttendance')) {
    const source = approvedAttendanceSource, approval = source?.sourceAttendanceApproval;
    if (!source || !Array.isArray(source.attendance) || source.attendance.length > 20000
        || !UUID.test(approval?.approvalId || '') || !Number.isSafeInteger(approval?.revision) || approval.revision < 1
        || !SHA.test(approval.sourceWatermark || '') || approval.periodFrom !== period.from || approval.periodTo !== period.to
        || source.attendanceCoverage?.watermark !== approval.sourceWatermark
        || typeof approval.approvedByName !== 'string' || !approval.approvedByName.trim()
        || typeof approval.approvedAt !== 'string' || !Number.isFinite(Date.parse(approval.approvedAt))) {
      add('payroll_refund_aware_approved_attendance_required');
    } else {
      input.attendance = copy(source.attendance); input.attendanceCoverage = copy(source.attendanceCoverage);
      components.approvedAttendance = { sourceWatermark: approval.sourceWatermark };
    }
  }
  if (required.includes('venueDailyTurnover')) {
    input.venueDailyTurnover = copy(economics.remainingDaily);
    input.venueDailyTurnoverCoverage = { from: period.from, through: period.to, complete: true,
      venueId, currency: scheme.currency, period: copy(period), venueTimezone: timezone, sourceWatermark: economics.sourceWatermark,
      watermarkScope: 'frozen_sale_date_remaining_canonical_turnover_v2', refundsIncluded: true,
      amountBasis: policies.earnings.venueTurnover };
  }
  const revenue = new Map();
  for (const line of input.sales) { const key = `${line.employeeId}/${line.date}`;
    revenue.set(key, (revenue.get(key) || 0n) + BigInt(line.commissionBaseCents)); }
  if ([...revenue.values()].some(value => value > BigInt(Number.MAX_SAFE_INTEGER))) add('payroll_refund_aware_revenue_overflow');
  if (reasons.size) return blocked();
  const revenueFacts = { schemaVersion: 1, policyCode: 'employee_attributed_merchandise_net_v1', currency: scheme.currency,
    period: copy(period), coverage: { complete: true }, daily: days.flatMap(date => employees.filter(employee => employeeActiveOn(employee, date))
      .map(employee => ({ employeeId: employee.id, date, netRevenueCents: Number(revenue.get(`${employee.id}/${date}`) || 0n) }))) };
  input.personalRevenueSource = { ...revenueFacts, status: 'available', economicBasis: policies.earnings.refunds,
    sourceWatermark: hash({ capability: CAPABILITY, economics: economics.sourceWatermark, revenueFacts }) };
  validateEmploymentEligibilityEmployeeBindings(employmentEligibility, input, period).forEach(add);
  validateCalculatorInputRows(input, scheme, period, components, required).forEach(add);
  let team = null;
  if (required.includes('departmentShiftAllocation') || required.includes('teamMembershipAndWeights')) {
    const structuralTeam = buildPayrollTeamFundSource({ venueId, scheme, period: { ...period, timezone }, currency: scheme.currency, employees,
      roleAssignments: input.roleAssignments, sales: input.sales, attendance: input.attendance, attendanceCoverage: input.attendanceCoverage,
      departmentAttribution: department, employmentEligibility });
    // Reuse the membership/allocation checks, then bind their rows to the new
    // remaining-net economics. The old candidate's no-refund marker is not a
    // truthful description of these sources and must not leave this adapter.
    const remainingComponent = (key) => {
      const { sourceWatermark: structuralWatermark, watermarkScope, zeroRefundCandidateRequired, ...rows } = structuralTeam[key];
      const payload = { ...rows, schemaVersion: 2, policyCode: CAPABILITY, economicSourceWatermark: economics.sourceWatermark,
        sourceAttested: false, watermarkScope: `payroll_remaining_net_${key}_v2` };
      return { ...payload, sourceWatermark: hash(payload) };
    };
    const teamPayload = { schemaVersion: 2, status: structuralTeam.status, reasons: structuralTeam.reasons,
      departmentShiftAllocation: remainingComponent('departmentShiftAllocation'),
      teamMembershipAndWeights: remainingComponent('teamMembershipAndWeights'), calculatorSales: copy(input.sales) };
    team = { ...teamPayload, sourceWatermark: hash(teamPayload) };
    for (const key of ['departmentShiftAllocation', 'teamMembershipAndWeights']) {
      if (required.includes(key) && team[key]?.status !== 'available') (team[key]?.reasons || ['payroll_refund_aware_team_source_invalid']).forEach(add);
    }
  }
  if (reasons.size) return blocked();
  input.sourceEvidence = { capabilityVersion: CAPABILITY, recognitionManifest: { sourceWatermark: manifest.watermark },
    remainingMerchandise: { sourceWatermark: economics.sourceWatermark, projectionWatermark: projection.projectionWatermark },
    employmentEligibility: { sourceWatermark: employmentEligibility.revision.sourceWatermark },
    roleCoverage: { sourceWatermark: roleCoverage.sourceWatermark },
    approvedAttendance: approvedAttendanceSource && required.includes('approvedAttendance') ? copy(approvedAttendanceSource.sourceAttendanceApproval) : null,
    department: department ? { sourceWatermark: department.sourceWatermark } : null,
    frozenDepletionCost: costs ? { sourceWatermark: costs.sourceWatermark, accountingScope: 'payroll_incentive_only' } : null,
    team: team ? { departmentShiftAllocation: team.departmentShiftAllocation.sourceWatermark,
      teamMembershipAndWeights: team.teamMembershipAndWeights.sourceWatermark } : null };
  let result;
  try { result = calculatePayrollScheme(input); } catch (_) { add('payroll_refund_aware_engine_error'); return blocked(); }
  if (result.status !== 'ready' || result.blockers?.length || result.criticalErrors?.length) {
    (result.blockers || []).forEach(add); (result.criticalErrors || []).forEach(row => add(row.code));
    add('payroll_refund_aware_engine_not_ready'); return blocked();
  }
  let total = 0n;
  for (const row of result.employees) {
    if (!Number.isSafeInteger(row.amountCents) || row.amountCents < 0) add('payroll_refund_aware_amount_invalid');
    else total += BigInt(row.amountCents);
  }
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) add('payroll_refund_aware_amount_overflow');
  if (reasons.size) return blocked();
  const payload = { schemaVersion: 2, capabilityVersion: CAPABILITY, status: 'refund_aware_calculated', officialReady: false,
    payoutEligible: false, sourceAttested: false, persistence: 'none', reasons: [], venueId, schemeVersionId: scheme.versionId,
    period: copy(period), currency: scheme.currency, requiredFacts: required, amountCents: Number(total), input, engineResult: result,
    economics, department, costs, team, periodClosure: copy(periodClosure), inputWatermark: hash(input), closureWatermark: hash(periodClosure) };
  return frozen({ ...payload, calculationWatermark: hash(payload) });
}

module.exports = { buildPayrollRefundAwareCalculation, PAYROLL_REFUND_AWARE_CAPABILITY: CAPABILITY };
