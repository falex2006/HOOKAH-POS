import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { buildPayrollEmployeeRoleCoverage } = require('../payroll-employee-role-coverage.js');

const venueId = '11111111-1111-4111-8111-111111111111';
const employeeId = '22222222-2222-4222-8222-222222222222';
const inactiveEmployeeId = '33333333-3333-4333-8333-333333333333';
const scheme = { id: '44444444-4444-4444-8444-444444444444', versionId: '55555555-5555-4555-8555-555555555555',
  currency: 'RUB', effectiveFrom: '2026-10-01', effectiveTo: null, roleParameters: { bartender: {}, server: {} },
  roleAssignments: [
    { employeeId, roleId: 'bartender', effectiveFrom: '2026-10-01', effectiveTo: '2026-10-03' },
    { employeeId, roleId: 'bartender', effectiveFrom: '2026-10-06', effectiveTo: null },
    { employeeId: inactiveEmployeeId, roleId: 'server', effectiveFrom: '2026-09-01', effectiveTo: '2026-09-30' }
  ] };
const period = { from: '2026-10-01', to: '2026-10-31' };
const eligibilitySource = { component: { status: 'available', sourceWatermark: 'a'.repeat(64) },
  revision: { id: '66666666-6666-4666-8666-666666666666', revisionNo: 1, sourceWatermark: 'a'.repeat(64) } };
eligibilitySource.component.revisionId = eligibilitySource.revision.id;
eligibilitySource.component.revisionNo = eligibilitySource.revision.revisionNo;
const employees = [{ id: employeeId, activeIntervals: [
  { from: '2026-10-01', to: '2026-10-03' }, { from: '2026-10-06', to: '2026-10-31' }
] }];

const complete = buildPayrollEmployeeRoleCoverage({ venueId, scheme, period, eligibilitySource, employees });
assert.equal(complete.status, 'available', 'closed date boundaries and rehire gap are evaluated only on active days');
assert.equal(complete.activeEmployeeCount, 1);
assert.equal(complete.activeEmployeeDayCount, 29);
assert.equal(complete.coveredEmployeeDayCount, 29);
assert.match(complete.sourceWatermark, /^[a-f0-9]{64}$/);
assert.equal(JSON.stringify(complete).includes(employeeId), false, 'readiness does not expose employee identity');
assert.equal(JSON.stringify(complete).includes('2026-10-06'), false, 'readiness does not expose interval details');

const gapScheme = structuredClone(scheme);
gapScheme.roleAssignments = gapScheme.roleAssignments.filter(row => row.effectiveFrom !== '2026-10-06');
const gap = buildPayrollEmployeeRoleCoverage({ venueId, scheme: gapScheme, period, eligibilitySource, employees });
assert.equal(gap.status, 'incomplete');
assert.ok(gap.reasons.includes('payroll_employee_role_coverage_assignment_gap'));

const overlapScheme = structuredClone(scheme);
overlapScheme.roleAssignments.push({ employeeId, roleId: 'server', effectiveFrom: '2026-10-03', effectiveTo: '2026-10-06' });
const overlap = buildPayrollEmployeeRoleCoverage({ venueId, scheme: overlapScheme, period, eligibilitySource, employees });
assert.equal(overlap.status, 'incomplete');
assert.ok(overlap.reasons.includes('payroll_employee_role_coverage_assignment_overlap'));

const adjacentScheme = structuredClone(scheme);
adjacentScheme.roleAssignments = [
  { employeeId, roleId: 'bartender', effectiveFrom: '2026-10-01', effectiveTo: '2026-10-15' },
  { employeeId, roleId: 'server', effectiveFrom: '2026-10-16', effectiveTo: null }
];
const adjacent = buildPayrollEmployeeRoleCoverage({ venueId, scheme: adjacentScheme, period, eligibilitySource,
  employees: [{ id: employeeId, activeIntervals: [{ from: '2026-10-01', to: '2026-10-31' }] }] });
assert.equal(adjacent.status, 'available', 'adjacent role change boundaries are inclusive and non-overlapping');

const unconfiguredScheme = structuredClone(scheme);
unconfiguredScheme.roleAssignments[0].roleId = 'missing';
const unconfigured = buildPayrollEmployeeRoleCoverage({ venueId, scheme: unconfiguredScheme, period, eligibilitySource, employees });
assert.equal(unconfigured.status, 'incomplete');
assert.ok(unconfigured.reasons.includes('payroll_employee_role_coverage_role_unconfigured'));

const outsideSchemeWindow = structuredClone(scheme);
outsideSchemeWindow.effectiveTo = '2026-10-15';
const outsideWindow = buildPayrollEmployeeRoleCoverage({ venueId, scheme: outsideSchemeWindow, period, eligibilitySource,
  employees: [{ id: employeeId, activeIntervals: [{ from: '2026-10-01', to: '2026-10-31' }] }] });
assert.equal(outsideWindow.status, 'incomplete');
assert.ok(outsideWindow.reasons.includes('payroll_employee_role_coverage_scheme_window_not_covering_active_day'));

const emptyRoster = buildPayrollEmployeeRoleCoverage({ venueId, scheme: { ...scheme, roleAssignments: [] }, period,
  eligibilitySource, employees: [] });
assert.equal(emptyRoster.status, 'available', 'valid owner revision makes an intentionally empty active roster explicit');
assert.equal(emptyRoster.activeEmployeeDayCount, 0);
const missingRevision = buildPayrollEmployeeRoleCoverage({ venueId, scheme, period, eligibilitySource: { component: { status: 'incomplete' } }, employees: [] });
assert.equal(missingRevision.status, 'incomplete', 'missing eligibility evidence cannot masquerade as an empty roster');
assert.ok(missingRevision.reasons.includes('payroll_employee_role_coverage_eligibility_unavailable'));

const changedRevision = buildPayrollEmployeeRoleCoverage({ venueId, scheme, period,
  eligibilitySource: { ...eligibilitySource, revision: { ...eligibilitySource.revision, id: '77777777-7777-4777-8777-777777777777' },
    component: { ...eligibilitySource.component, revisionId: '77777777-7777-4777-8777-777777777777' } }, employees });
assert.notEqual(changedRevision.sourceWatermark, complete.sourceWatermark, 'watermark binds owner eligibility revision');
const mismatchedEligibility = buildPayrollEmployeeRoleCoverage({ venueId, scheme, period,
  eligibilitySource: { ...eligibilitySource, component: { ...eligibilitySource.component, sourceWatermark: 'b'.repeat(64) } }, employees });
assert.equal(mismatchedEligibility.status, 'incomplete', 'revision and readiness must reference the same eligibility watermark');
assert.ok(mismatchedEligibility.reasons.includes('payroll_employee_role_coverage_eligibility_unavailable'));
const malformedDormantAssignment = buildPayrollEmployeeRoleCoverage({ venueId,
  scheme: { ...scheme, roleAssignments: [...scheme.roleAssignments,
    { employeeId: 'not-a-uuid', roleId: 'server', effectiveFrom: '2025-01-01', effectiveTo: null }] },
  period, eligibilitySource, employees });
assert.equal(malformedDormantAssignment.status, 'incomplete',
  'invalid saved assignments cannot be hidden merely because they do not overlap this roster');
assert.ok(malformedDormantAssignment.reasons.includes('payroll_employee_role_coverage_assignment_invalid'));
const changedPeriod = buildPayrollEmployeeRoleCoverage({ venueId, scheme, period: { from: '2026-10-01', to: '2026-10-30' },
  eligibilitySource, employees });
assert.notEqual(changedPeriod.sourceWatermark, complete.sourceWatermark, 'watermark binds exact period');

console.log('PASS payroll-employee-role-coverage-contract');
