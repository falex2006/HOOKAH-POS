import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { MODE_FACTS, buildPayrollModeAvailability } = require('../payroll-mode-availability.js');
const { MODES } = require('../payroll-schemes.js');

const components = Object.fromEntries([
  'sourcePolicies', 'employeeEligibility', 'approvedAttendance', 'canonicalLinePricing', 'payrollSaleCredit', 'recognitionManifest',
  'recognizedLineRefunds', 'fullEmployeeNetRevenue', 'immutableDepartmentAttribution', 'departmentShiftAllocation',
  'teamMembershipAndWeights', 'marginCosts', 'employeeRoleCoverage'
].map(key => [key, { status: 'available', reasons: [] }]));
const attestations = Object.fromEntries([
  'venueDailyTurnover', 'closedMonthCoverage',
  'personalLineIdentity'
].map(key => [key, { status: 'available', reasons: [] }]));
const acknowledgedScheme = { payoutRiskAcknowledgement: { confirmed: true, policyCode: 'payroll-own-revenue-ceiling-v1',
  configDigest: 'a'.repeat(64), acknowledgedBy: 'owner-1', acknowledgedAt: '2026-10-01T12:00:00Z' }, payoutRiskAcknowledgementCurrent: true };

const modes = buildPayrollModeAvailability(components, attestations, acknowledgedScheme);
assert.deepEqual(Object.keys(modes).sort(), MODES.slice().sort());
for (const mode of MODES) {
  assert.equal(modes[mode].inputStatus, 'available');
  assert.equal(modes[mode].calculationStatus, 'unavailable');
  assert.equal(modes[mode].amount, null, 'availability evidence is not a calculation');
  assert.ok(modes[mode].requiredFacts.length > 0);
  assert.ok(modes[mode].facts.every(fact => fact.status === 'available'));
}

assert.ok(MODE_FACTS.progressive_daily.includes('venueDailyTurnover'));
assert.ok(MODE_FACTS.final_month_threshold.includes('closedMonthCoverage'));
assert.ok(MODE_FACTS.team_fund.includes('departmentShiftAllocation'));
assert.ok(MODE_FACTS.margin_target.includes('marginCosts'));
assert.ok(!MODE_FACTS.percent_only.includes('venueDailyTurnover'));

const gated = buildPayrollModeAvailability({ ...components,
  approvedAttendance: { status: 'incomplete', reasons: ['approval_stale'] },
  marginCosts: { status: 'unsupported', reasons: ['cost_snapshot_missing'] }
}, { ...attestations, venueDailyTurnover: { status: 'incomplete', reasons: ['turnover_gap'] } }, acknowledgedScheme);
assert.equal(gated.progressive_daily.inputStatus, 'incomplete');
assert.ok(gated.progressive_daily.reasons.includes('approval_stale'));
assert.ok(gated.progressive_daily.reasons.includes('turnover_gap'));
assert.equal(gated.margin_target.inputStatus, 'unsupported');
assert.ok(gated.margin_target.reasons.includes('cost_snapshot_missing'));
assert.equal(gated.percent_only.inputStatus, 'available');
assert.ok(!gated.percent_only.reasons.includes('turnover_gap'));
const incompleteRoleCoverage = buildPayrollModeAvailability({ ...components,
  employeeRoleCoverage: { status: 'incomplete', reasons: ['payroll_employee_role_coverage_assignment_gap'] }
}, attestations, acknowledgedScheme);
assert.equal(incompleteRoleCoverage.percent_only.inputStatus, 'incomplete',
  'every payroll mode is blocked when any active employee-day has no saved salary role');
assert.ok(incompleteRoleCoverage.percent_only.reasons.includes('payroll_employee_role_coverage_assignment_gap'));
const legacyRoleAttestationOnly = { ...components };
delete legacyRoleAttestationOnly.employeeRoleCoverage;
assert.equal(buildPayrollModeAvailability(legacyRoleAttestationOnly, attestations, acknowledgedScheme).percent_only.inputStatus,
  'unsupported', 'a free-standing attestation cannot substitute for computed role coverage');
const cappedPercent = buildPayrollModeAvailability(components,
  { ...attestations, venueDailyTurnover: { status: 'incomplete', reasons: ['turnover_gap'] } },
  { ...acknowledgedScheme, mode: 'stable_percent', roleParameters: { bartender: { cap: { basis: 'venue_day', rateBps: 500 } } } });
assert.equal(cappedPercent.stable_percent.inputStatus, 'incomplete', 'venue-day cap adds a turnover dependency to a normally independent mode');
assert.ok(cappedPercent.stable_percent.requiredFacts.includes('venueDailyTurnover'));
const milestonePercent = buildPayrollModeAvailability(components,
  { ...attestations, venueDailyTurnover: { status: 'incomplete', reasons: ['turnover_gap'] } },
  { ...acknowledgedScheme, mode: 'stable_percent', applyMilestones: false, roleParameters: {
    bartender: { applyMilestones: true, milestoneBonusesCents: { '100000': 500 } }
  } });
assert.equal(milestonePercent.stable_percent.inputStatus, 'incomplete', 'role milestone override requires venue turnover');
const inheritedMilestoneOverride = buildPayrollModeAvailability(components,
  { ...attestations, venueDailyTurnover: { status: 'unsupported', reasons: ['turnover_not_ready'] } },
  { ...acknowledgedScheme, mode: 'stable_percent', roleParameters: { bartender: { applyMilestones: true } }, employeeOverrides: [
    { employeeId: 'employee-1', path: 'milestoneBonusesCents.100000', mode: 'override', value: 500 }
  ] });
assert.equal(inheritedMilestoneOverride.stable_percent.inputStatus, 'unsupported',
  'employee milestone override inherits the role enablement and requires venue turnover');
const schemeInheritedMilestoneOverride = buildPayrollModeAvailability(components,
  { ...attestations, venueDailyTurnover: { status: 'incomplete', reasons: ['turnover_gap'] } },
  { ...acknowledgedScheme, mode: 'stable_percent', applyMilestones: true, employeeOverrides: [
    { employeeId: 'employee-1', path: 'milestoneBonusesCents.100000', mode: 'override', value: 500 }
  ] });
assert.equal(schemeInheritedMilestoneOverride.stable_percent.inputStatus, 'incomplete',
  'employee milestone override also inherits scheme-level milestone enablement');
const percentWithoutShiftSource = buildPayrollModeAvailability({ ...components,
  approvedAttendance: { status: 'unsupported', reasons: ['attendance_unavailable'] }
}, attestations, acknowledgedScheme);
assert.equal(percentWithoutShiftSource.percent_only.inputStatus, 'available', 'percent-only without attendance-based milestones has no shift-wage dependency');
assert.ok(!percentWithoutShiftSource.percent_only.requiredFacts.includes('approvedAttendance'));
const percentWithAttendanceMilestone = buildPayrollModeAvailability(components, attestations, {
  ...acknowledgedScheme, mode: 'percent_only', applyMilestones: true, milestoneEligibility: 'worked_on_threshold_day',
  roleParameters: { bartender: { milestoneBonusesCents: { '100000': 500 } } }
});
assert.ok(percentWithAttendanceMilestone.percent_only.requiredFacts.includes('approvedAttendance'));
const departmentCapped = buildPayrollModeAvailability(components, attestations, {
  ...acknowledgedScheme, mode: 'stable_percent', roleParameters: { bartender: { cap: { basis: 'employee_department_day', department: 'bar', rateBps: 500 } } }
});
assert.ok(departmentCapped.stable_percent.requiredFacts.includes('immutableDepartmentAttribution'));
const netRevenueOnlyForAcknowledgedCeiling = buildPayrollModeAvailability({ ...components,
  fullEmployeeNetRevenue: { status: 'unsupported', reasons: ['net_revenue_unavailable'] }
}, attestations, acknowledgedScheme);
assert.equal(netRevenueOnlyForAcknowledgedCeiling.percent_only.inputStatus, 'unsupported');
const noCeiling = buildPayrollModeAvailability({ ...components,
  fullEmployeeNetRevenue: { status: 'unsupported', reasons: ['net_revenue_unavailable'] }
}, attestations, { payoutRiskAcknowledgement: null });
assert.equal(noCeiling.percent_only.inputStatus, 'available', 'net revenue is not a source prerequisite when no personal-revenue ceiling is acknowledged');
assert.equal(noCeiling.percent_only.configurationStatus, 'incomplete', 'missing owner confirmation remains a separate configuration gate');
assert.ok(!noCeiling.percent_only.requiredFacts.includes('fullEmployeeNetRevenue'));
const invalidAcknowledgement = buildPayrollModeAvailability({ ...components,
  fullEmployeeNetRevenue: { status: 'unsupported', reasons: ['net_revenue_unavailable'] }
}, attestations, { payoutRiskAcknowledgement: { confirmed: true, policyCode: 'payroll-own-revenue-ceiling-v1' } });
assert.equal(invalidAcknowledgement.percent_only.inputStatus, 'available', 'unpersisted acknowledgement metadata cannot enable a revenue ceiling');
assert.equal(invalidAcknowledgement.percent_only.configurationStatus, 'incomplete');
const datedOverride = buildPayrollModeAvailability({ ...components,
  approvedAttendance: { status: 'unsupported', reasons: ['attendance_unavailable'] },
  venueDailyTurnover: { status: 'unsupported', reasons: ['turnover_unavailable'] }
}, attestations, { ...acknowledgedScheme, mode: 'percent_only', employeeOverrides: [
  { employeeId: 'employee-1', path: 'mode', mode: 'override', value: 'progressive_daily', effectiveFrom: '2026-01-01', effectiveTo: '2026-01-31' }
] }, { from: '2026-02-01', to: '2026-02-28' });
assert.equal(datedOverride.percent_only.inputStatus, 'available', 'out-of-period mode overrides do not add source dependencies');
assert.ok(!datedOverride.percent_only.requiredFacts.includes('venueDailyTurnover'));
const inPeriodModeOverride = buildPayrollModeAvailability({ ...components,
  approvedAttendance: { status: 'unsupported', reasons: ['attendance_unavailable'] },
  venueDailyTurnover: { status: 'unsupported', reasons: ['turnover_unavailable'] }
}, attestations, { ...acknowledgedScheme, mode: 'percent_only', employeeOverrides: [
  { employeeId: 'employee-1', path: 'mode', mode: 'override', value: 'progressive_daily', effectiveFrom: '2026-02-01', effectiveTo: '2026-02-28' }
] }, { from: '2026-02-01', to: '2026-02-28' });
assert.equal(inPeriodModeOverride.percent_only.inputStatus, 'unsupported', 'in-period mode overrides add their source dependencies');
assert.ok(inPeriodModeOverride.percent_only.requiredFacts.includes('venueDailyTurnover'));
const malformedDatedOverride = buildPayrollModeAvailability(components,
  { ...attestations, venueDailyTurnover: { status: 'unsupported', reasons: ['turnover_unavailable'] } },
  { ...acknowledgedScheme, mode: 'percent_only', employeeOverrides: [
  { employeeId: 'employee-1', path: 'mode', mode: 'override', value: 'progressive_daily', effectiveFrom: '2026-02-31', effectiveTo: '2026-02-31' }
] }, { from: '2026-02-01', to: '2026-02-28' });
assert.equal(malformedDatedOverride.percent_only.inputStatus, 'unsupported', 'malformed dates retain dependencies fail-closed');
assert.throws(() => buildPayrollModeAvailability(null, {}, {}), /payroll_mode_availability_components_required/);
assert.throws(() => buildPayrollModeAvailability(components, null, {}), /payroll_mode_availability_attestations_invalid/);
assert.throws(() => buildPayrollModeAvailability(components, {}), /payroll_mode_availability_scheme_required/);

console.log('PASS payroll-mode-availability-contract');
