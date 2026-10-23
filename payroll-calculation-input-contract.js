'use strict';

const { buildPayrollMarginCostSource } = require('./payroll-margin-cost-source');

// Validates the server-owned source bundle before it can be adapted to the
// calculator. It is intentionally pure and never infers missing source rows.
const { buildPayrollModeAvailability } = require('./payroll-mode-availability');
const { CALCULATOR_INPUT_CAPABILITIES, isDepartmentKey } = require('./payroll-schemes');
const { eligibilityPayloadSha256, eligibilitySourceWatermark, normalizeEligibilityPeriods, buildEligibleEmployees } = require('./payroll-employment-eligibility');
const { buildPayrollRecognitionPreview } = require('./payroll-recognition-preview');
const { buildPayrollFullEmployeeNetRevenueSource } = require('./payroll-full-employee-net-revenue-source');
const { buildPayrollCalculatorSales, buildPayrollTeamFundSource } = require('./payroll-team-fund-source');
const { createHash } = require('node:crypto');
const { buildPayrollPersonalRevenueSource } = require('./payroll-personal-revenue-source');
const { manifestHasCompleteNoRefundHistory } = require('./payroll-no-refund-coverage');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const NO_REFUND_INPUT_CAPABILITY = 'employee_attributed_merchandise_net_no_refund_v1';
const uuidKey = value => String(value || '').toLowerCase();
const REQUIRED_COLLECTIONS = ['employees', 'roleAssignments', 'sales'];
const FACT_COMPONENT = Object.freeze({
  sourcePolicies: null,
  employeeEligibility: 'employeeEligibility',
  approvedAttendance: 'approvedAttendance',
  canonicalLinePricing: 'canonicalLinePricing',
  payrollSaleCredit: 'payrollSaleCredit',
  recognitionManifest: 'recognitionManifest',
  recognizedLineRefunds: 'recognizedLineRefunds',
  fullEmployeeNetRevenue: 'fullEmployeeNetRevenue',
  employeeRoleCoverage: 'employeeRoleCoverage',
  immutableDepartmentAttribution: 'immutableDepartmentAttribution',
  venueDailyTurnover: 'venueDailyTurnover',
  closedMonthCoverage: 'closedMonthCoverage',
  departmentShiftAllocation: 'departmentShiftAllocation',
  marginCosts: 'marginCosts',
  teamMembershipAndWeights: 'teamMembershipAndWeights'
});

const isDate = value => {
  if (typeof value !== 'string' || !DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
};
const unique = values => [...new Set(values)].sort();
const stable = value => {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
};
const fingerprint = value => createHash('sha256').update(stable(value)).digest('hex');
const blocked = (selectedMode, requiredFacts, reasons) => ({
  schemaVersion: 1, status: 'blocked', selectedMode, requiredFacts,
  reasons: unique(reasons), calculatorInput: null, inputWatermark: null
});
const sameRoleAssignment = (left, right) => uuidKey(left?.employeeId) === uuidKey(right?.employeeId) && left?.roleId === right?.roleId
  && left?.effectiveFrom === right?.effectiveFrom && (left?.effectiveTo ?? null) === (right?.effectiveTo ?? null);
const employeeIsActiveOn = (employee, date) => Array.isArray(employee?.activeIntervals)
  ? employee.activeIntervals.some(interval => interval?.from <= date && interval?.to >= date)
  : (!(employee?.activeFrom && date < employee.activeFrom) && !(employee?.activeTo && date > employee.activeTo));
const validateCalculatorInputRows = (input, scheme, period, components, requiredFacts) => {
  const reasons = [];
  const attendanceRequired = requiredFacts.includes('approvedAttendance');
  const employees = input?.employees;
  const assignments = input?.roleAssignments;
  const attendance = input?.attendance;
  const sales = input?.sales;
  const monthStart = `${period.from.slice(0, 7)}-01`;
  const monthEnd = new Date(Date.UTC(Number(period.from.slice(0, 4)), Number(period.from.slice(5, 7)), 0)).toISOString().slice(0, 10);
  const coverage = input?.coverage;
  if (!coverage || !['month_to_date_complete', 'month_closed_complete'].includes(coverage.kind)
      || coverage.from !== monthStart || !isDate(coverage.through) || coverage.through < period.to
      || coverage.complete !== true || !SHA256.test(coverage.watermark || '')) {
    reasons.push('payroll_calculation_sales_coverage_manifest_invalid');
  }
  if (coverage?.kind === 'month_to_date_complete' && coverage.through !== period.to) {
    reasons.push('payroll_calculation_sales_coverage_boundary_mismatch');
  }
  if (coverage?.kind === 'month_closed_complete' && (input?.monthClosed !== true || coverage.through !== monthEnd)) {
    reasons.push('payroll_calculation_sales_closed_month_mismatch');
  }
  const employeeById = new Map();
  if (Array.isArray(employees)) {
    for (const employee of employees) {
      if (!employee || typeof employee !== 'object' || Array.isArray(employee) || !UUID.test(String(employee.id || ''))
          || employeeById.has(String(employee.id || '').toLowerCase())
          || (employee.activeFrom !== undefined && !isDate(employee.activeFrom))
          || (employee.activeTo !== undefined && employee.activeTo !== null && !isDate(employee.activeTo))
          || (employee.activeFrom && employee.activeTo && employee.activeTo < employee.activeFrom)
          || (employee.activeIntervals !== undefined && (!Array.isArray(employee.activeIntervals)
            || employee.activeIntervals.some((interval, index) => !interval || !isDate(interval.from) || !isDate(interval.to)
              || interval.to < interval.from || (index > 0 && employee.activeIntervals[index - 1].to >= interval.from))))) {
        reasons.push('payroll_calculation_employee_row_invalid');
        continue;
      }
      employeeById.set(uuidKey(employee.id), employee);
    }
  }
  const assignmentRows = [];
  if (Array.isArray(assignments)) {
    const expected = Array.isArray(scheme.roleAssignments) ? scheme.roleAssignments : [];
    if (assignments.length !== expected.length || assignments.some((row, index) => !sameRoleAssignment(row, expected[index]))) {
      reasons.push('payroll_calculation_role_assignments_scheme_mismatch');
    }
    for (const row of assignments) {
      if (!row || typeof row !== 'object' || Array.isArray(row) || !UUID.test(String(row.employeeId || ''))
          || typeof row.roleId !== 'string' || !row.roleId.trim()
          || !Object.hasOwn(scheme.roleParameters || {}, row.roleId) || !isDate(row.effectiveFrom)
          || (row.effectiveTo !== undefined && row.effectiveTo !== null && !isDate(row.effectiveTo))
          || (row.effectiveTo && row.effectiveTo < row.effectiveFrom)) {
        reasons.push('payroll_calculation_role_assignment_row_invalid');
        continue;
      }
      assignmentRows.push(row);
    }
    // Assignment overlaps are period-relevant only when they collide with an
    // active employee-day below. Keep the full saved list bound to the scheme,
    // but dormant or historical overlaps must not block another payroll period.
    for (const [employeeId, employee] of employeeById) {
      const windows = Array.isArray(employee.activeIntervals) ? employee.activeIntervals
        : [{ from: employee.activeFrom && employee.activeFrom > period.from ? employee.activeFrom : period.from,
          to: employee.activeTo && employee.activeTo < period.to ? employee.activeTo : period.to }];
      for (const window of windows) {
        const activeFrom = window.from > period.from ? window.from : period.from;
        const activeTo = window.to < period.to ? window.to : period.to;
        for (let date = activeFrom, iterations = 0; date <= activeTo && iterations < 32; date = new Date(Date.parse(`${date}T00:00:00.000Z`) + 86400000).toISOString().slice(0, 10), iterations += 1) {
          const matches = assignmentRows.filter(row => row.employeeId.toLowerCase() === employeeId && row.effectiveFrom <= date
            && (!row.effectiveTo || row.effectiveTo >= date));
          if (matches.length !== 1) reasons.push(matches.length ? 'payroll_calculation_role_assignment_overlap' : 'payroll_calculation_role_assignment_gap');
        }
      }
    }
  }
  if (attendanceRequired && !Array.isArray(attendance)) reasons.push('payroll_calculation_attendance_collection_missing');
  if (Array.isArray(attendance)) {
    const coverage = input.attendanceCoverage;
    if (attendanceRequired && (!coverage || coverage.kind !== 'approved_attendance_complete' || coverage.from !== monthStart
        || !isDate(coverage.through) || coverage.through < period.to || coverage.complete !== true
        || !SHA256.test(coverage.watermark || ''))) {
      reasons.push('payroll_calculation_attendance_coverage_manifest_invalid');
    }
    if (attendanceRequired && coverage?.watermark !== components?.approvedAttendance?.sourceWatermark) {
      reasons.push('payroll_calculation_attendance_coverage_watermark_mismatch');
    }
    const ids = new Set();
    for (const row of attendance) {
      if (!row || typeof row !== 'object' || Array.isArray(row) || !UUID.test(String(row.id || '')) || ids.has(uuidKey(row.id))
          || !UUID.test(String(row.employeeId || '')) || !employeeById.has(uuidKey(row.employeeId))
          || !isDate(row.date) || row.date < period.from || row.date > period.to || row.approved !== true
          || !Number.isSafeInteger(row.workedMinutes) || row.workedMinutes < 0
          || !Number.isSafeInteger(row.plannedMinutes) || row.plannedMinutes <= 0 || row.workedMinutes > row.plannedMinutes) {
        reasons.push('payroll_calculation_attendance_row_invalid');
        continue;
      }
      ids.add(uuidKey(row.id));
      const employee = employeeById.get(uuidKey(row.employeeId));
      if (!employeeIsActiveOn(employee, row.date)) {
        reasons.push('payroll_calculation_attendance_outside_employee_active_period');
      }
      const roleMatches = assignmentRows.filter(assignment => uuidKey(assignment.employeeId) === uuidKey(row.employeeId) && assignment.effectiveFrom <= row.date
        && (!assignment.effectiveTo || assignment.effectiveTo >= row.date));
      if (roleMatches.length !== 1) reasons.push(roleMatches.length ? 'payroll_calculation_role_assignment_overlap' : 'payroll_calculation_attendance_role_uncovered');
    }
  }
  if (Array.isArray(sales)) {
    const ids = new Set();
    for (const row of sales) {
      if (!row || typeof row !== 'object' || Array.isArray(row) || !UUID.test(String(row.id || '')) || ids.has(uuidKey(row.id))
          || !isDate(row.date) || row.date < period.from || row.date > period.to || row.currency !== scheme.currency
          || row.sourceWatermark !== components?.recognitionManifest?.sourceWatermark
          || !isDepartmentKey(row.department) || !Number.isSafeInteger(row.turnoverCents) || row.turnoverCents < 0
          || !Number.isSafeInteger(row.commissionBaseCents) || row.commissionBaseCents < 0
          || (row.employeeId !== null && !UUID.test(String(row.employeeId || '')))
          || (row.employeeId && !employeeById.has(uuidKey(row.employeeId)))) {
        reasons.push('payroll_calculation_sale_row_invalid');
        continue;
      }
      ids.add(uuidKey(row.id));
      if (!row.employeeId && row.turnoverCents > 0) reasons.push('payroll_calculation_sale_employee_unattributed');
      if ((Array.isArray(scheme.itemRules) ? scheme.itemRules : []).length > 0 && !UUID.test(String(row.menuItemId || ''))) {
        reasons.push('payroll_calculation_sale_item_identity_missing');
      }
      if (row.employeeId) {
        const employee = employeeById.get(uuidKey(row.employeeId));
        if (!employeeIsActiveOn(employee, row.date)) {
          reasons.push('payroll_calculation_sale_outside_employee_active_period');
        }
        const roleMatches = assignmentRows.filter(assignment => uuidKey(assignment.employeeId) === uuidKey(row.employeeId) && assignment.effectiveFrom <= row.date
          && (!assignment.effectiveTo || assignment.effectiveTo >= row.date));
        if (roleMatches.length !== 1) reasons.push(roleMatches.length ? 'payroll_calculation_role_assignment_overlap' : 'payroll_calculation_sale_role_uncovered');
      }
    }
  }
  return unique(reasons);
};

const validateEmploymentEligibilityEvidence = (evidence, component, venueId) => {
  const reasons = [];
  const revision = evidence?.revision;
  const periods = evidence?.periods;
  if (!revision || !UUID.test(String(revision.id || '')) || !Number.isSafeInteger(revision.revisionNo)
      || revision.revisionNo < 1 || !Number.isSafeInteger(revision.periodCount) || revision.periodCount < 0
      || typeof revision.reason !== 'string' || revision.reason.trim().length < 8
      || typeof revision.idempotency_key !== 'string' || !revision.idempotency_key.trim()
      || !SHA256.test(revision.payload_sha256 || '') || !SHA256.test(revision.sourceWatermark || '')
      || !Array.isArray(periods) || periods.length !== revision.periodCount) {
    return ['payroll_calculation_employee_eligibility_source_invalid'];
  }
  try {
    const normalized = normalizeEligibilityPeriods(periods.map(row => ({ employeeId: row.employeeId,
      effectiveFrom: row.effectiveFrom, effectiveTo: row.effectiveTo })));
    if (eligibilityPayloadSha256(normalized, revision.reason, revision.supersedes_revision_id ?? revision.supersedesRevisionId ?? null) !== revision.payload_sha256) {
      reasons.push('payroll_calculation_employee_eligibility_payload_mismatch');
    }
    if (periods.some(row => typeof row.employeeName !== 'string' || !row.employeeName.trim() || row.employeeName.length > 160)) {
      reasons.push('payroll_calculation_employee_eligibility_identity_invalid');
    }
    if (eligibilitySourceWatermark(venueId, revision, periods) !== revision.sourceWatermark
        || revision.sourceWatermark !== component?.sourceWatermark
        || revision.id !== component?.revisionId || revision.revisionNo !== component?.revisionNo
        || revision.periodCount !== component?.periodCount) {
      reasons.push('payroll_calculation_employee_eligibility_watermark_mismatch');
    }
  } catch (error) {
    reasons.push(error.message === 'payroll_employment_periods_overlap'
      ? 'payroll_calculation_employee_eligibility_periods_overlap' : 'payroll_calculation_employee_eligibility_period_invalid');
  }
  return unique(reasons);
};

const validateEmploymentEligibilityEmployeeBindings = (evidence, input, period) => {
  const reasons = [];
  const revisionId = evidence?.revision?.id;
  if (!revisionId || input?.employmentEligibilityRevisionId !== revisionId) {
    reasons.push('payroll_calculation_employee_eligibility_revision_mismatch');
  }
  let expected;
  try { expected = buildEligibleEmployees((evidence?.periods || []).map(({ employeeId, effectiveFrom, effectiveTo }) =>
    ({ employeeId, effectiveFrom, effectiveTo })), period.from, period.to); }
  catch { return [...reasons, 'payroll_calculation_employee_eligibility_period_invalid']; }
  const actual = input?.employees;
  if (!Array.isArray(actual)) return [...reasons, 'payroll_calculation_employees_collection_missing'];
  if (actual.length !== expected.length) reasons.push('payroll_calculation_employee_eligibility_roster_mismatch');
  const byId = new Map();
  for (const employee of actual) {
    if (!employee || typeof employee !== 'object' || Array.isArray(employee) || !UUID.test(String(employee.id || '')) || byId.has(uuidKey(employee.id))) {
      reasons.push('payroll_calculation_employee_eligibility_roster_mismatch');
      continue;
    }
    byId.set(employee.id.toLowerCase(), employee);
  }
  for (const expectedEmployee of expected) {
    const employee = byId.get(expectedEmployee.id);
    if (!employee) {
      reasons.push('payroll_calculation_employee_eligibility_roster_mismatch');
      continue;
    }
    if (employee.activeIntervals !== undefined) {
      const intervalsMatch = Array.isArray(employee.activeIntervals) && employee.activeIntervals.length === expectedEmployee.activeIntervals.length
        && employee.activeIntervals.every((interval, index) => interval?.from === expectedEmployee.activeIntervals[index].from
          && interval?.to === expectedEmployee.activeIntervals[index].to);
      if (!intervalsMatch || employee.activeFrom !== undefined || employee.activeTo !== undefined) {
        reasons.push('payroll_calculation_employee_eligibility_period_mismatch');
      }
    } else if (expectedEmployee.activeIntervals.length !== 1
        || employee.activeFrom !== expectedEmployee.activeIntervals[0]?.from
        || employee.activeTo !== expectedEmployee.activeIntervals[0]?.to) {
      reasons.push('payroll_calculation_employee_eligibility_period_mismatch');
    }
  }
  return unique(reasons);
};

const validateVenueDailyTurnoverCoverage = (calculatorInput, sourceBundle, component, venueId, scheme, period) => {
  const reasons = [];
  const rows = calculatorInput?.venueDailyTurnover;
  const coverage = calculatorInput?.venueDailyTurnoverCoverage;
  const source = sourceBundle?.venueDailyTurnover;
  const expectedFrom = `${period.from.slice(0, 7)}-01`;
  const dayCount = Math.floor((Date.parse(`${period.to}T00:00:00.000Z`) - Date.parse(`${expectedFrom}T00:00:00.000Z`)) / 86400000) + 1;
  if (!Array.isArray(rows) || !coverage || typeof coverage !== 'object' || Array.isArray(coverage)) {
    return ['payroll_calculation_venueDailyTurnover_coverage_missing'];
  }
  if (coverage.from !== expectedFrom || coverage.through !== period.to || coverage.complete !== true
      || coverage.venueId !== venueId || coverage.currency !== scheme.currency
      || coverage.period?.from !== period.from || coverage.period?.to !== period.to
      || typeof coverage.venueTimezone !== 'string' || !coverage.venueTimezone
      || coverage.sourceWatermark !== component?.sourceWatermark
      || coverage.watermarkScope !== component?.watermarkScope
      || coverage.amountBasis !== 'finance_recognized_closed_order_total_pre_refund' || coverage.refundsIncluded !== false) {
    reasons.push('payroll_calculation_venueDailyTurnover_coverage_context_mismatch');
  }
  try { new Intl.DateTimeFormat('en-US', { timeZone: coverage.venueTimezone }); }
  catch { reasons.push('payroll_calculation_venueDailyTurnover_timezone_invalid'); }
  if (!Array.isArray(rows) || rows.length !== dayCount || rows.some((row, index) => {
    const date = new Date(Date.parse(`${expectedFrom}T00:00:00.000Z`) + index * 86400000).toISOString().slice(0, 10);
    return !row || typeof row !== 'object' || Array.isArray(row) || row.date !== date
      || !Number.isSafeInteger(row.turnoverCents) || row.turnoverCents < 0;
  })) reasons.push('payroll_calculation_venueDailyTurnover_rows_incomplete');
  if (!source || source.sourceWatermark !== component?.sourceWatermark
      || source.from !== coverage.from || source.through !== coverage.through
      || source.venueTimezone !== coverage.venueTimezone || source.amountBasis !== coverage.amountBasis
      || source.refundsIncluded !== false || stable(source.venueDailyTurnover) !== stable(rows)) {
    reasons.push('payroll_calculation_venueDailyTurnover_source_binding_mismatch');
  }
  return unique(reasons);
};

const buildPayrollCalculationInputContract = ({ venueId, scheme, period, readiness, attestations = {}, sourceBundle = null,
  purpose = 'official', periodClosure = null }) => {
  if (!UUID.test(String(venueId || '')) || !scheme || !UUID.test(String(scheme.versionId || ''))
      || typeof scheme.currency !== 'string' || !scheme.currency.trim() || !period
      || !isDate(period.from) || !isDate(period.to) || period.from > period.to
      || period.from.slice(0, 7) !== period.to.slice(0, 7) || !readiness || !scheme.mode
      || readiness.versionId !== scheme.versionId || readiness.period?.from !== period.from || readiness.period?.to !== period.to) {
    throw new TypeError('payroll_calculation_input_evidence_required');
  }
  const availability = buildPayrollModeAvailability(readiness.components, attestations, scheme, period)[scheme.mode];
  const requiredFacts = availability.requiredFacts;
  if (!['official', 'candidate_preview', 'official_no_refund_input'].includes(purpose)) throw new TypeError('payroll_calculation_input_purpose_invalid');
  // Version2 opts into a different economic basis. It must use its own source
  // capability, never inherit approval from this legacy no-refund adapter.
  if (scheme.sourcePolicies?.schemaVersion === 2) return blocked(scheme.mode, requiredFacts,
    ['payroll_refund_policy_requires_versioned_input']);
  const noRefundPurpose = purpose === 'official_no_refund_input';
  const proofPurpose = purpose === 'candidate_preview' || noRefundPurpose;
  const reasons = [];
  if (['official', 'official_no_refund_input'].includes(purpose) && requiredFacts.includes('marginCosts')) reasons.push('payroll_margin_cost_candidate_evidence_not_official');
  if (['official', 'official_no_refund_input'].includes(purpose) && requiredFacts.includes('teamMembershipAndWeights')) {
    reasons.push('payroll_team_fund_candidate_evidence_not_official');
  }
  if (availability.inputStatus !== 'available') {
    for (const fact of availability.facts.filter(row => row.status !== 'available')) reasons.push(...fact.reasons);
  }
  if (availability.configurationStatus !== 'available') reasons.push(...availability.configurationReasons);
  if (!sourceBundle) reasons.push('payroll_calculation_source_bundle_unavailable');
  const candidate = sourceBundle?.recognizedLineProjection;
  const manifest = sourceBundle?.recognitionManifest;
  const refundComponent = readiness.components?.recognizedLineRefunds;
  const bundleRefundComponent = sourceBundle?.components?.recognizedLineRefunds;
  const noRefundCoverageProof = proofPurpose
    && manifest?.status === 'available' && Array.isArray(manifest.refundEvents) && manifest.refundEvents.length === 0
    && manifestHasCompleteNoRefundHistory(manifest)
    && candidate?.sourceStatus === 'available' && Array.isArray(candidate.refundAdjustments) && candidate.refundAdjustments.length === 0
    && refundComponent?.status === 'available' && bundleRefundComponent?.status === 'available'
    && candidate.projectionWatermark === refundComponent.sourceWatermark
    && candidate.projectionWatermark === bundleRefundComponent.sourceWatermark
    && candidate.sourceWatermark === manifest.watermark;
  const noRefundProof = noRefundCoverageProof;
  if (purpose === 'candidate_preview' && !noRefundCoverageProof) reasons.push('payroll_candidate_no_refund_coverage_not_proven');
  if (noRefundPurpose && !noRefundCoverageProof) reasons.push('payroll_official_no_refund_coverage_not_proven');
  if (!CALCULATOR_INPUT_CAPABILITIES.signedRefundAdjustments && !noRefundProof) {
    reasons.push('payroll_calculator_signed_refund_input_missing');
  }
  if (!CALCULATOR_INPUT_CAPABILITIES.historicalEmploymentIntervals) reasons.push('payroll_calculator_historical_employment_interval_input_missing');
  // Scenario previews may use the fully verified series as a display/readiness
  // dependency, but do not feed it to the wage engine. Official input remains
  // blocked until the calculator itself can consume that evidence.
  if (purpose === 'official' && requiredFacts.includes('fullEmployeeNetRevenue') && !CALCULATOR_INPUT_CAPABILITIES.fullEmployeeNetRevenue) {
    reasons.push('payroll_calculator_full_employee_net_revenue_input_missing');
  }
  if (noRefundPurpose && !CALCULATOR_INPUT_CAPABILITIES.explicitNoRefundEmployeeNetRevenue) {
    reasons.push('payroll_calculator_explicit_no_refund_employee_net_revenue_input_missing');
  }
  if (noRefundPurpose) {
    const closure = periodClosure;
    const timezone = readiness.period?.timezone;
    let closed = false;
    if (closure?.schemaVersion === 1 && closure.venueId === venueId
        && closure.period?.from === period.from && closure.period?.to === period.to
        && closure.timezone === timezone && typeof timezone === 'string' && timezone.trim()
        && typeof closure.transactionTimestamp === 'string' && !Number.isNaN(Date.parse(closure.transactionTimestamp))
        && isDate(closure.venueLocalDate)) {
      try {
        const localDate = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' })
          .format(new Date(closure.transactionTimestamp));
        closed = localDate === closure.venueLocalDate && localDate > period.to;
      } catch (_) { closed = false; }
    }
    if (!closed) reasons.push('payroll_calculation_period_not_closed');
  }
  if (!sourceBundle) return blocked(scheme.mode, requiredFacts, reasons);

  if (sourceBundle.schemaVersion !== 1 || sourceBundle.venueId !== venueId
      || sourceBundle.schemeVersionId !== scheme.versionId || sourceBundle.currency !== scheme.currency
      || sourceBundle.period?.from !== period.from || sourceBundle.period?.to !== period.to
      || sourceBundle.readinessWatermark !== fingerprint(readiness.components)) {
    reasons.push('payroll_calculation_source_bundle_context_mismatch');
  }
  const components = sourceBundle.components;
  if (!components || typeof components !== 'object' || Array.isArray(components)) {
    reasons.push('payroll_calculation_source_components_missing');
  }
  for (const fact of requiredFacts) {
    if (fact === 'sourcePolicies') continue;
    const key = FACT_COMPONENT[fact];
    const component = key ? components?.[key] : null;
    const expected = key ? (readiness.components?.[key] || attestations?.[fact]) : null;
    if (!component || component.status !== 'available' || !SHA256.test(component.sourceWatermark || '')
        || typeof component.watermarkScope !== 'string' || !component.watermarkScope.trim()
        || component.venueId !== venueId || component.currency !== scheme.currency
        || component.period?.from !== period.from || component.period?.to !== period.to) {
      reasons.push(`payroll_calculation_${fact}_evidence_incomplete`);
    }
    if (!expected || expected.status !== 'available' || component?.sourceWatermark !== expected.sourceWatermark
        || component?.watermarkScope !== expected.watermarkScope) {
      reasons.push(`payroll_calculation_${fact}_readiness_binding_mismatch`);
    }
  }
  const recognizedCandidate = sourceBundle.recognizedLineProjection;
  const recognizedManifest = sourceBundle.recognitionManifest;
  if (!recognizedCandidate || recognizedCandidate.schemaVersion !== 1 || !recognizedManifest
      || recognizedCandidate.venueId !== venueId || recognizedCandidate.currency !== scheme.currency
      || recognizedCandidate.period?.from !== period.from || recognizedCandidate.period?.to !== period.to
      || recognizedCandidate.sourceWatermark !== recognizedManifest.watermark
      || recognizedCandidate.sourceWatermark !== readiness.components?.recognitionManifest?.sourceWatermark
      || recognizedCandidate.projectionWatermark !== readiness.components?.recognizedLineRefunds?.sourceWatermark
      || recognizedCandidate.sourceStatus !== readiness.components?.recognizedLineRefunds?.status
      || !Array.isArray(recognizedCandidate.saleLines) || !Array.isArray(recognizedCandidate.refundAdjustments)) {
    reasons.push('payroll_calculation_recognized_line_projection_binding_mismatch');
  } else {
    const expectedProjection = buildPayrollRecognitionPreview(recognizedManifest, scheme.sourcePolicies);
    if (recognizedManifest.venueId !== venueId || recognizedManifest.currency !== scheme.currency
        || recognizedManifest.period?.from !== period.from || recognizedManifest.period?.to !== period.to
        || (expectedProjection.projectionWatermark || null) !== (recognizedCandidate.projectionWatermark || null)
        || expectedProjection.sourceStatus !== recognizedCandidate.sourceStatus
        || stable(expectedProjection.sourceReasons) !== stable(recognizedCandidate.sourceReasons)
        || stable(expectedProjection.saleLines) !== stable(recognizedCandidate.saleLines)
        || stable(expectedProjection.refundAdjustments) !== stable(recognizedCandidate.refundAdjustments)
      || (proofPurpose && (expectedProjection.sourceStatus !== 'available'
          || expectedProjection.refundAdjustments.length !== 0 || recognizedManifest.refundEvents.length !== 0))) {
      reasons.push('payroll_calculation_recognized_line_projection_content_mismatch');
    }
    const manifestComponent = components?.recognitionManifest;
    const refundComponent = components?.recognizedLineRefunds;
    if (!manifestComponent || manifestComponent.sourceWatermark !== manifest.watermark
        || manifestComponent.watermarkScope !== readiness.components?.recognitionManifest?.watermarkScope
        || !refundComponent || refundComponent.sourceWatermark !== candidate.projectionWatermark
        || refundComponent.watermarkScope !== readiness.components?.recognizedLineRefunds?.watermarkScope) {
      reasons.push('payroll_calculation_recognized_line_component_binding_mismatch');
    }
    const fullNet = sourceBundle.fullEmployeeNetRevenue;
    const fullNetReadiness = readiness.components?.fullEmployeeNetRevenue;
    const fullNetComponent = components?.fullEmployeeNetRevenue;
    const expectedFullNet = buildPayrollFullEmployeeNetRevenueSource(manifest, scheme.sourcePolicies);
    if (!fullNet || !fullNetReadiness || !fullNetComponent
        || fullNet.venueId !== venueId || fullNet.currency !== scheme.currency
        || fullNet.period?.from !== period.from || fullNet.period?.to !== period.to
        || fullNet.status !== fullNetReadiness.status || fullNet.status !== fullNetComponent.status
        || fullNet.sourceWatermark !== fullNetReadiness.sourceWatermark
        || fullNet.sourceWatermark !== fullNetComponent.sourceWatermark
        || fullNet.watermarkScope !== fullNetReadiness.watermarkScope
        || fullNet.watermarkScope !== fullNetComponent.watermarkScope
        || stable(fullNet) !== stable(expectedFullNet)) {
      reasons.push('payroll_calculation_full_employee_net_revenue_binding_mismatch');
    }
  }
  if (requiredFacts.includes('employeeEligibility')) {
    reasons.push(...validateEmploymentEligibilityEvidence(sourceBundle.employmentEligibility, components?.employeeEligibility, venueId));
    if (sourceBundle.calculatorInput) reasons.push(...validateEmploymentEligibilityEmployeeBindings(
      sourceBundle.employmentEligibility, sourceBundle.calculatorInput, period));
  }
  for (const name of REQUIRED_COLLECTIONS) {
    if (!Array.isArray(sourceBundle.calculatorInput?.[name])) reasons.push(`payroll_calculation_${name}_collection_missing`);
  }
  if (requiredFacts.includes('approvedAttendance') && !Array.isArray(sourceBundle.calculatorInput?.attendance)) {
    reasons.push('payroll_calculation_attendance_collection_missing');
  }
  if (requiredFacts.includes('venueDailyTurnover') && !Array.isArray(sourceBundle.calculatorInput?.venueDailyTurnover)) {
    reasons.push('payroll_calculation_venueDailyTurnover_collection_missing');
  }
  if (requiredFacts.includes('venueDailyTurnover')) reasons.push(...validateVenueDailyTurnoverCoverage(
    sourceBundle.calculatorInput, sourceBundle, components?.venueDailyTurnover, venueId, scheme, period));
  const calculatorInput = sourceBundle.calculatorInput;
  if (noRefundPurpose || calculatorInput?.personalRevenueSource !== undefined) {
    const expectedRevenue = buildPayrollPersonalRevenueSource({ venueId, currency: scheme.currency, period,
      recognitionManifest: sourceBundle.recognitionManifest, sourcePolicies: scheme.sourcePolicies,
      fullEmployeeNetRevenue: sourceBundle.fullEmployeeNetRevenue,
      orderRevenueReconciliation: sourceBundle.orderRevenueReconciliation });
    if (expectedRevenue.status !== 'available' || stable(calculatorInput?.personalRevenueSource) !== stable(expectedRevenue)) {
      reasons.push('payroll_calculation_personal_revenue_source_binding_mismatch', ...expectedRevenue.reasons);
    }
  }
  let expectedMarginCostSource = null;
  if (requiredFacts.includes('marginCosts')) {
    expectedMarginCostSource = buildPayrollMarginCostSource({ venueId, currency: scheme.currency, period,
      recognitionManifest: sourceBundle.recognitionManifest, evidenceByOrder: sourceBundle.marginCostEvidenceByOrder });
    if (expectedMarginCostSource.status !== 'available' || stable(sourceBundle.marginCostSource) !== stable(expectedMarginCostSource)
        || [components?.marginCosts, readiness.components?.marginCosts].some(row => !row
          || row.status !== expectedMarginCostSource.status || stable(row.reasons) !== stable(expectedMarginCostSource.reasons)
          || row.sourceWatermark !== expectedMarginCostSource.sourceWatermark || row.watermarkScope !== expectedMarginCostSource.watermarkScope
          || row.venueId !== venueId || row.currency !== scheme.currency || row.period?.from !== period.from || row.period?.to !== period.to)) {
      reasons.push('payroll_calculation_margin_cost_source_binding_mismatch');
    }
  }
  const expectedSaleRows = buildPayrollCalculatorSales({ currency: scheme.currency,
    recognitionManifest: sourceBundle.recognitionManifest, recognitionProjection: sourceBundle.recognizedLineProjection,
    departmentAttribution: sourceBundle.departmentAttribution, marginCostSource: expectedMarginCostSource });
  if (!Array.isArray(calculatorInput?.sales) || stable(calculatorInput.sales) !== stable(expectedSaleRows)) {
    reasons.push('payroll_calculation_sale_rows_source_binding_mismatch');
  }
  if (requiredFacts.includes('immutableDepartmentAttribution')) {
    const department = sourceBundle.departmentAttribution;
    const component = components?.immutableDepartmentAttribution;
    const ready = readiness.components?.immutableDepartmentAttribution;
    if (!department || department.status !== 'available' || department.sourceWatermark !== component?.sourceWatermark
        || department.sourceWatermark !== ready?.sourceWatermark || department.watermarkScope !== component?.watermarkScope
        || department.coverage?.venueId !== venueId || department.coverage?.period?.from !== period.from
        || department.coverage?.period?.to !== period.to || department.coverage?.complete !== true) {
      reasons.push('payroll_calculation_department_attribution_source_binding_mismatch');
    }
  }
  if (requiredFacts.includes('departmentShiftAllocation') || requiredFacts.includes('teamMembershipAndWeights')) {
    const expectedTeamFundEvidence = buildPayrollTeamFundSource({ venueId, scheme,
      period: { ...period, timezone: sourceBundle.departmentAttribution?.coverage?.timezone || readiness.period?.timezone || null },
      currency: scheme.currency, employees: calculatorInput?.employees,
      roleAssignments: calculatorInput?.roleAssignments, sales: calculatorInput?.sales,
      attendance: calculatorInput?.attendance, attendanceCoverage: calculatorInput?.attendanceCoverage,
      departmentAttribution: sourceBundle.departmentAttribution, employmentEligibility: sourceBundle.employmentEligibility });
    if (!sourceBundle.teamFundEvidence || stable(sourceBundle.teamFundEvidence) !== stable(expectedTeamFundEvidence)) {
      reasons.push('payroll_calculation_team_fund_evidence_binding_mismatch');
    }
    for (const key of ['departmentShiftAllocation', 'teamMembershipAndWeights']) {
      const expected = expectedTeamFundEvidence[key], component = components?.[key], ready = readiness.components?.[key];
      if (!expected || !component || !ready || component.status !== expected.status || ready.status !== expected.status
          || component.sourceWatermark !== expected.sourceWatermark || ready.sourceWatermark !== expected.sourceWatermark
          || component.watermarkScope !== expected.watermarkScope || ready.watermarkScope !== expected.watermarkScope) {
        reasons.push(`payroll_calculation_${key}_binding_mismatch`);
      }
      if (expected?.status !== 'available') reasons.push(...(expected?.reasons || [`payroll_calculation_${key}_evidence_incomplete`]));
    }
  }
  if (calculatorInput && (calculatorInput.periodFrom !== period.from || calculatorInput.periodTo !== period.to
      || !calculatorInput.coverage || calculatorInput.coverage.from !== `${period.from.slice(0, 7)}-01`
      || calculatorInput.coverage.through < period.to || calculatorInput.coverage.complete !== true
      || (requiredFacts.includes('approvedAttendance') && (!calculatorInput.attendanceCoverage
        || calculatorInput.attendanceCoverage.from !== `${period.from.slice(0, 7)}-01`
        || calculatorInput.attendanceCoverage.through < period.to || calculatorInput.attendanceCoverage.complete !== true)))) {
    reasons.push('payroll_calculation_input_coverage_incomplete');
  }
  if (calculatorInput) reasons.push(...validateCalculatorInputRows(calculatorInput, scheme, period, components, requiredFacts));
  if (Object.hasOwn(calculatorInput || {}, 'refundAdjustments')
      && (!['candidate_preview', 'official_no_refund_input'].includes(purpose)
        || !Array.isArray(calculatorInput.refundAdjustments) || calculatorInput.refundAdjustments.length > 0)) {
    reasons.push('payroll_calculator_signed_refund_input_missing');
  }
  if (!SHA256.test(sourceBundle.inputWatermark || '')) reasons.push('payroll_calculation_input_watermark_invalid');
  const watermarkPayload = structuredClone(sourceBundle);
  delete watermarkPayload.inputWatermark;
  if (SHA256.test(sourceBundle.inputWatermark || '') && sourceBundle.inputWatermark !== fingerprint(watermarkPayload)) {
    reasons.push('payroll_calculation_input_watermark_mismatch');
  }
  if (reasons.length) return blocked(scheme.mode, requiredFacts, reasons);

  const input = structuredClone(calculatorInput);
  input.scheme = structuredClone(scheme);
  input.sourceEvidence = Object.fromEntries(requiredFacts.filter(fact => fact !== 'sourcePolicies').map(fact => {
    const component = components[FACT_COMPONENT[fact]];
    return [fact, { sourceWatermark: component.sourceWatermark, watermarkScope: component.watermarkScope }];
  }));
  return {
    schemaVersion: 1, status: purpose === 'candidate_preview' ? 'candidate_only'
      : noRefundPurpose ? 'verified_no_refund_input' : 'available',
    candidateOnly: purpose === 'candidate_preview', officialReady: false, payoutEligible: false, persistence: 'none',
    ...(noRefundPurpose ? { capabilityVersion: NO_REFUND_INPUT_CAPABILITY, closureWatermark: fingerprint({ periodClosure, inputWatermark: sourceBundle.inputWatermark }) } : {}),
    selectedMode: scheme.mode, requiredFacts,
    reasons: [], calculatorInput: input,
    inputWatermark: sourceBundle.inputWatermark || null
  };
};

// Shared structural checks do not grant the legacy no-refund capability.
module.exports = { buildPayrollCalculationInputContract, NO_REFUND_INPUT_CAPABILITY,
  validateCalculatorInputRows, validateEmploymentEligibilityEvidence, validateEmploymentEligibilityEmployeeBindings };
