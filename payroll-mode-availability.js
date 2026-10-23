'use strict';

// Read-only source gate matrix for the seven payroll modes. This deliberately
// does not adapt partial evidence to the wage engine or imply a payable amount.
const { MODES } = require('./payroll-schemes');

const COMMON_FACTS = Object.freeze([
  'sourcePolicies', 'employeeEligibility', 'canonicalLinePricing', 'payrollSaleCredit', 'recognitionManifest',
  'recognizedLineRefunds', 'employeeRoleCoverage'
]);

const FACTS = Object.freeze({
  sourcePolicies: { component: 'sourcePolicies', missing: 'payroll_source_policy_not_confirmed' },
  employeeEligibility: { component: 'employeeEligibility', missing: 'payroll_employee_eligibility_history_unavailable' },
  approvedAttendance: { component: 'approvedAttendance', missing: 'payroll_approved_attendance_unavailable' },
  canonicalLinePricing: { component: 'canonicalLinePricing', missing: 'payroll_canonical_line_pricing_unavailable' },
  payrollSaleCredit: { component: 'payrollSaleCredit', missing: 'payroll_sale_credit_policy_unavailable' },
  recognitionManifest: { component: 'recognitionManifest', missing: 'payroll_recognition_manifest_unavailable' },
  recognizedLineRefunds: { component: 'recognizedLineRefunds', missing: 'payroll_recognized_line_refunds_unavailable' },
  fullEmployeeNetRevenue: { component: 'fullEmployeeNetRevenue', missing: 'payroll_full_employee_net_revenue_unavailable' },
  employeeRoleCoverage: { component: 'employeeRoleCoverage', missing: 'payroll_employee_role_coverage_unattested' },
  immutableDepartmentAttribution: { component: 'immutableDepartmentAttribution', missing: 'payroll_immutable_department_attribution_unavailable' },
  venueDailyTurnover: { missing: 'payroll_venue_daily_turnover_unavailable' },
  closedMonthCoverage: { missing: 'payroll_closed_month_coverage_unavailable' },
  departmentShiftAllocation: { component: 'departmentShiftAllocation', missing: 'payroll_department_shift_allocation_unavailable' },
  marginCosts: { component: 'marginCosts', missing: 'payroll_immutable_margin_costs_unavailable' },
  teamMembershipAndWeights: { component: 'teamMembershipAndWeights', missing: 'payroll_team_membership_and_weights_unavailable' }
});

const MODE_FACTS = Object.freeze({
  progressive_daily: [...COMMON_FACTS, 'venueDailyTurnover', 'approvedAttendance'],
  stable_percent: [...COMMON_FACTS, 'approvedAttendance'],
  percent_only: [...COMMON_FACTS],
  final_month_threshold: [...COMMON_FACTS, 'venueDailyTurnover', 'closedMonthCoverage', 'approvedAttendance'],
  personal_target: [...COMMON_FACTS, 'approvedAttendance'],
  team_fund: [...COMMON_FACTS, 'approvedAttendance', 'departmentShiftAllocation', 'teamMembershipAndWeights'],
  margin_target: [...COMMON_FACTS, 'approvedAttendance', 'departmentShiftAllocation', 'marginCosts']
});

const STATUS_ORDER = Object.freeze({ available: 0, incomplete: 1, unsupported: 2 });
const hasPositiveThreshold = value => value && typeof value === 'object' && !Array.isArray(value)
  && Object.values(value).some(amount => Number.isSafeInteger(amount) && amount > 0);
const hasPositiveEmployeeMilestone = overrides => overrides.some(row => row?.mode === 'override'
  && /^milestoneBonusesCents\.\d+$/.test(row.path || '') && Number.isSafeInteger(row.value) && row.value > 0);
const isModeOverride = row => row?.mode === 'override' && row.path === 'mode' && MODES.includes(row.value);

const validIsoDate = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
};
const overlaps = (row, period) => {
  if (!period || typeof period.from !== 'string' || typeof period.to !== 'string') return true;
  const from = row?.effectiveFrom ?? null;
  const to = row?.effectiveTo ?? null;
  // Invalid or absent dates fail closed by retaining the dependency.
  if ((from != null && !validIsoDate(from)) || (to != null && !validIsoDate(to))) return true;
  return (!to || to >= period.from) && (!from || from <= period.to);
};

const configuredModes = (baseMode, scheme, roleParameters, overrides) => new Set([
  baseMode,
  ...roleParameters.map(params => params.mode).filter(mode => MODES.includes(mode)),
  ...overrides.filter(isModeOverride).map(row => row.value)
]);

const hasConfiguredMilestones = (scheme, roleParameters, overrides, modes) => {
  const hasBonuses = roleParameters.some(params => hasPositiveThreshold(params.milestoneBonusesCents))
    || hasPositiveEmployeeMilestone(overrides);
  const hasEnablement = scheme.applyMilestones === true
    || roleParameters.some(params => params.applyMilestones === true
      || (params.applyMilestones === undefined && modes.has('progressive_daily')))
    || overrides.some(row => row?.mode === 'override' && row.path === 'applyMilestones' && row.value === true)
    || overrides.some(row => isModeOverride(row) && row.value === 'progressive_daily');
  return hasBonuses && hasEnablement;
};

const hasConfiguredVenueTurnoverDependency = (scheme, roleParameters, overrides, modes) => {
  const venueCap = roleParameters.some(params => params.cap?.basis === 'venue_day')
    || overrides.some(row => row?.mode === 'override' && row.path === 'cap.basis' && row.value === 'venue_day');
  return venueCap || modes.has('progressive_daily') || modes.has('final_month_threshold')
    || hasConfiguredMilestones(scheme, roleParameters, overrides, modes);
};

const hasAttendanceBasedMilestones = (scheme, roleParameters, overrides, modes) => hasConfiguredMilestones(scheme, roleParameters, overrides, modes)
  && (scheme.milestoneEligibility === 'worked_on_threshold_day'
    || roleParameters.some(params => params.milestoneEligibility === 'worked_on_threshold_day')
    || overrides.some(row => row?.mode === 'override' && row.path === 'milestoneEligibility'
      && row.value === 'worked_on_threshold_day'));

const hasDepartmentDependency = (modes, roleParameters, overrides) => [...modes].some(mode => ['team_fund', 'margin_target'].includes(mode))
  || roleParameters.some(params => params.cap?.basis === 'employee_department_day')
  || overrides.some(row => row?.mode === 'override' && row.path === 'cap.basis' && row.value === 'employee_department_day');

const evaluateFact = (factName, components, attestations) => {
  const definition = FACTS[factName];
  if (!definition) throw new TypeError('payroll_mode_availability_fact_unknown');
  const component = definition.component ? components?.[definition.component] : attestations?.[factName];
  if (!component) return { fact: factName, status: 'unsupported', reasons: [definition.missing] };
  if (!['available', 'incomplete', 'unsupported'].includes(component.status)) {
    return { fact: factName, status: 'incomplete', reasons: [definition.missing] };
  }
  const reasons = Array.isArray(component.reasons) ? component.reasons.filter(reason => typeof reason === 'string' && reason.trim()) : [];
  if (component.status !== 'available' && !reasons.length) reasons.push(definition.missing);
  return { fact: factName, status: component.status, reasons: [...new Set(reasons)].sort() };
};

const buildPayrollModeAvailability = (components, attestations = {}, scheme, period) => {
  if (!components || typeof components !== 'object' || Array.isArray(components)) {
    throw new TypeError('payroll_mode_availability_components_required');
  }
  if (!attestations || typeof attestations !== 'object' || Array.isArray(attestations)) {
    throw new TypeError('payroll_mode_availability_attestations_invalid');
  }
  if (!scheme || typeof scheme !== 'object' || Array.isArray(scheme)) {
    throw new TypeError('payroll_mode_availability_scheme_required');
  }
  const assignments = Array.isArray(scheme.roleAssignments) ? scheme.roleAssignments : [];
  const activeRoleIds = new Set(assignments.filter(row => overlaps(row, period)).map(row => row.roleId));
  const allRoleParameters = Object.entries(scheme.roleParameters || {}).filter(([, value]) => value && typeof value === 'object' && !Array.isArray(value));
  const roleParameters = assignments.length
    ? allRoleParameters.filter(([roleId]) => activeRoleIds.has(roleId)).map(([, value]) => value)
    : allRoleParameters.map(([, value]) => value);
  const overrides = (Array.isArray(scheme.employeeOverrides) ? scheme.employeeOverrides : []).filter(row => overlaps(row, period));
  const acknowledgement = scheme.payoutRiskAcknowledgement;
  const hasAcknowledgement = acknowledgement?.confirmed === true
    && acknowledgement?.policyCode === 'payroll-own-revenue-ceiling-v1'
    && /^[a-f0-9]{64}$/.test(acknowledgement?.configDigest || '')
    && Boolean(acknowledgement?.acknowledgedBy && acknowledgement?.acknowledgedAt)
    && scheme.payoutRiskAcknowledgementCurrent === true;
  const hasEmployeeRevenueCeiling = hasAcknowledgement;
  const configurationStatus = hasAcknowledgement ? 'available' : 'incomplete';
  const configurationReasons = hasAcknowledgement ? [] : ['payroll_payout_risk_acknowledgement_unavailable'];

  return Object.fromEntries(MODES.map(mode => {
    const requiredFacts = MODE_FACTS[mode].slice();
    const modesInScope = configuredModes(mode, scheme, roleParameters, overrides);
    if ([...modesInScope].some(configuredMode => configuredMode !== 'percent_only')
        || hasAttendanceBasedMilestones(scheme, roleParameters, overrides, modesInScope)) requiredFacts.push('approvedAttendance');
    if (hasDepartmentDependency(modesInScope, roleParameters, overrides)) requiredFacts.push('immutableDepartmentAttribution');
    if (hasEmployeeRevenueCeiling) requiredFacts.push('fullEmployeeNetRevenue');
    if (modesInScope.has('final_month_threshold')) requiredFacts.push('closedMonthCoverage');
    if (modesInScope.has('team_fund')) requiredFacts.push('departmentShiftAllocation', 'teamMembershipAndWeights');
    if (modesInScope.has('margin_target')) requiredFacts.push('departmentShiftAllocation', 'marginCosts');
    if (hasConfiguredVenueTurnoverDependency(scheme, roleParameters, overrides, modesInScope)) requiredFacts.push('venueDailyTurnover');
    const uniqueRequiredFacts = [...new Set(requiredFacts)];
    const facts = uniqueRequiredFacts.map(fact => evaluateFact(fact, components, attestations));
    const inputStatus = facts.reduce((status, fact) =>
      STATUS_ORDER[fact.status] > STATUS_ORDER[status] ? fact.status : status, 'available');
    const sourceReasons = [...new Set(facts.flatMap(fact => fact.reasons))].sort();
    return [mode, {
      status: 'unavailable',
      calculationStatus: 'unavailable',
      inputStatus,
      configurationStatus,
      configurationReasons,
      amount: null,
      requiredFacts: uniqueRequiredFacts,
      facts,
      reasons: [...new Set([...sourceReasons, ...configurationReasons, 'payroll_official_run_not_available'])].sort()
    }];
  }));
};

module.exports = { COMMON_FACTS, MODE_FACTS, buildPayrollModeAvailability };
