'use strict';

const { createHash } = require('node:crypto');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const isDate = value => typeof value === 'string' && DATE.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))
  && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
const canonicalJson = value => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort()
    .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
};
const digest = value => createHash('sha256').update(canonicalJson(value)).digest('hex');
const nextDate = value => new Date(Date.parse(`${value}T00:00:00.000Z`) + 86400000).toISOString().slice(0, 10);

const buildPayrollEmployeeRoleCoverage = ({ venueId, scheme, period, eligibilitySource, employees }) => {
  const reasons = new Set();
  const validContext = UUID.test(String(venueId || '')) && scheme && typeof scheme === 'object'
    && UUID.test(String(scheme.id || '')) && UUID.test(String(scheme.versionId || '')) && typeof scheme.currency === 'string'
    && period && isDate(period.from) && isDate(period.to) && period.from <= period.to;
  if (!validContext) reasons.add('payroll_employee_role_coverage_context_invalid');

  const revision = eligibilitySource?.revision;
  const eligibilityAvailable = eligibilitySource?.component?.status === 'available'
    && revision && UUID.test(String(revision.id || '')) && /^[a-f0-9]{64}$/.test(String(revision.sourceWatermark || ''))
    && revision.sourceWatermark === eligibilitySource.component.sourceWatermark
    && revision.id === eligibilitySource.component.revisionId
    && revision.revisionNo === eligibilitySource.component.revisionNo
    && Array.isArray(employees);
  if (!eligibilityAvailable) reasons.add('payroll_employee_role_coverage_eligibility_unavailable');

  const employeeRows = Array.isArray(employees) ? employees : [];
  const assignmentRows = Array.isArray(scheme?.roleAssignments) ? scheme.roleAssignments : [];
  const roleParameters = scheme?.roleParameters && typeof scheme.roleParameters === 'object'
    && !Array.isArray(scheme.roleParameters) ? scheme.roleParameters : {};
  if (!Array.isArray(scheme?.roleAssignments)) reasons.add('payroll_employee_role_coverage_assignments_invalid');

  const employeeById = new Map();
  for (const employee of employeeRows) {
    const id = String(employee?.id || '').toLowerCase();
    if (!UUID.test(id) || employeeById.has(id) || !Array.isArray(employee.activeIntervals)
        || employee.activeIntervals.some((interval, index) => !interval || !isDate(interval.from) || !isDate(interval.to)
          || interval.to < interval.from || (index > 0 && employee.activeIntervals[index - 1].to >= interval.from))) {
      reasons.add('payroll_employee_role_coverage_roster_invalid');
      continue;
    }
    employeeById.set(id, employee);
  }

  const activeEmployees = new Set();
  const assignmentsByEmployee = new Map();
  for (const assignment of assignmentRows) {
    const employeeId = String(assignment?.employeeId || '').toLowerCase();
    if (!UUID.test(employeeId) || typeof assignment.roleId !== 'string' || !assignment.roleId.trim()
        || !isDate(assignment.effectiveFrom)
        || (assignment.effectiveTo !== undefined && assignment.effectiveTo !== null && !isDate(assignment.effectiveTo))
        || (assignment.effectiveTo && assignment.effectiveTo < assignment.effectiveFrom)) {
      reasons.add('payroll_employee_role_coverage_assignment_invalid');
      continue;
    }
    if (!Object.hasOwn(roleParameters, assignment.roleId)) {
      reasons.add('payroll_employee_role_coverage_role_unconfigured');
      continue;
    }
    const list = assignmentsByEmployee.get(employeeId) || [];
    list.push(assignment);
    assignmentsByEmployee.set(employeeId, list);
  }

  let activeEmployeeDayCount = 0;
  let coveredEmployeeDayCount = 0;
  const schemeFrom = isDate(scheme?.effectiveFrom) ? scheme.effectiveFrom : null;
  const schemeTo = scheme?.effectiveTo == null ? null : (isDate(scheme.effectiveTo) ? scheme.effectiveTo : null);
  if (schemeFrom === null || (scheme?.effectiveTo != null && schemeTo === null)) {
    reasons.add('payroll_employee_role_coverage_scheme_window_invalid');
  }

  for (const [employeeId, employee] of employeeById) {
    const rows = assignmentsByEmployee.get(employeeId) || [];
    for (const interval of employee.activeIntervals) {
      const from = interval.from < period?.from ? period.from : interval.from;
      const through = interval.to > period?.to ? period.to : interval.to;
      if (from > through) continue;
      activeEmployees.add(employeeId);
      for (let date = from; date <= through; date = nextDate(date)) {
        activeEmployeeDayCount += 1;
        if (schemeFrom === null || date < schemeFrom || (schemeTo && date > schemeTo)) {
          reasons.add('payroll_employee_role_coverage_scheme_window_not_covering_active_day');
        }
        const matches = rows.filter(row => row.effectiveFrom <= date && (!row.effectiveTo || row.effectiveTo >= date));
        if (matches.length === 0) reasons.add('payroll_employee_role_coverage_assignment_gap');
        else if (matches.length > 1) reasons.add('payroll_employee_role_coverage_assignment_overlap');
        else coveredEmployeeDayCount += 1;
      }
    }
  }

  if (!validContext || !eligibilityAvailable) {
    return { status: 'incomplete', reasons: [...reasons].sort(), sourceWatermark: null,
      watermarkScope: 'saved_scheme_and_owner_eligibility_period_role_coverage', activeEmployeeCount: activeEmployees.size,
      activeEmployeeDayCount, coveredEmployeeDayCount };
  }

  const payload = { schemaVersion: 1, algorithmVersion: 1, venueId, currency: scheme.currency,
    schemeId: scheme.id, schemeVersionId: scheme.versionId, schemeEffectiveFrom: scheme.effectiveFrom,
    schemeEffectiveTo: scheme.effectiveTo ?? null, period: { from: period.from, to: period.to },
    eligibilityRevisionId: revision.id, eligibilitySourceWatermark: eligibilitySource.component.sourceWatermark,
    configuredRoleIds: Object.keys(roleParameters).sort(),
    employees: employeeRows, roleAssignments: assignmentRows };
  return { status: reasons.size ? 'incomplete' : 'available', reasons: [...reasons].sort(), sourceWatermark: digest(payload),
    watermarkScope: 'saved_scheme_and_owner_eligibility_period_role_coverage', activeEmployeeCount: activeEmployees.size,
    activeEmployeeDayCount, coveredEmployeeDayCount };
};

module.exports = { buildPayrollEmployeeRoleCoverage };
