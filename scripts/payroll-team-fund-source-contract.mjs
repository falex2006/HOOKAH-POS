import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
const require = createRequire(import.meta.url);
const { buildPayrollTeamFundSource } = require('../payroll-team-fund-source.js');

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const venueId = '11111111-1111-4111-8111-111111111111';
const employeeA = '22222222-2222-4222-8222-222222222222';
const employeeB = '33333333-3333-4333-8333-333333333333';
const roleId = 'bartender';
const period = { from: '2026-10-01', to: '2026-10-31', timezone: 'Asia/Yekaterinburg' };
const revisionId = '44444444-4444-4444-8444-444444444444';
const saleLineId = '55555555-5555-4555-8555-555555555555';
const shiftId = '66666666-6666-4666-8666-666666666666';
const sourceWatermark = 'a'.repeat(64);
const scheme = { id: '77777777-7777-4777-8777-777777777777', versionId: '88888888-8888-4888-8888-888888888888',
  currency: 'RUB', mode: 'team_fund', roleParameters: { [roleId]: { mode: 'team_fund', perShiftCents: 0,
    teamFund: { poolId: 'house', targetCents: 0, baseRateBps: 1000, bonusRateBps: 0,
      excessRatePolicy: 'replace_base', distributionPolicy: 'approved_minutes', departments: ['drinks'] } } },
  roleAssignments: [employeeA, employeeB].map(employeeId => ({ employeeId, roleId,
    effectiveFrom: period.from, effectiveTo: null })) };
const employees = [employeeA, employeeB].map(id => ({ id, activeIntervals: [{ from: period.from, to: period.to }] }));
const roleAssignments = structuredClone(scheme.roleAssignments);
const sales = [{ id: saleLineId, employeeId: employeeA, date: '2026-10-10', currency: 'RUB', menuItemId: '99999999-9999-4999-8999-999999999999',
  department: 'drinks', turnoverCents: 12500, commissionBaseCents: 12500, sourceWatermark }];
const attendance = [{ id: shiftId, employeeId: employeeA, date: '2026-10-10', approved: true, workedMinutes: 180, plannedMinutes: 240 }];
const attendanceCoverage = { kind: 'approved_attendance_complete', from: period.from, through: period.to,
  complete: true, watermark: 'b'.repeat(64) };
const departmentAttribution = { schemaVersion: 1, status: 'available', reasons: [], sourceWatermark: 'c'.repeat(64),
  watermarkScope: 'payroll_owner_attested_product_department_classification',
  coverage: { venueId, period: { from: period.from, to: period.to }, timezone: period.timezone, complete: true,
    mappingRevisionId: revisionId, recognitionWatermark: sourceWatermark },
  rows: [{ saleLineEventId: saleLineId, employeeId: employeeA, recognizedLocalDate: '2026-10-10', departmentCode: 'drinks' }] };
const employmentEligibility = { revision: { id: revisionId, sourceWatermark: 'd'.repeat(64) } };
const build = (overrides = {}) => buildPayrollTeamFundSource({ venueId, scheme, period, currency: 'RUB', employees,
  roleAssignments, sales, attendance, attendanceCoverage, departmentAttribution, employmentEligibility, ...overrides });

const evidence = build();
assert.equal(evidence.status, 'available', evidence.reasons.join(', '));
assert.equal(evidence.departmentShiftAllocation.coverage.saleLineCount, 1);
assert.deepEqual(evidence.departmentShiftAllocation.dailyDepartmentSales[0], {
  date: '2026-10-10', departmentCode: 'drinks', employeeId: employeeA,
  turnoverCents: 12500, commissionBaseCents: 12500, saleLineIds: [saleLineId]
});
const saleDayPool = evidence.teamMembershipAndWeights.pools.find(row => row.date === '2026-10-10');
assert.equal(saleDayPool.members.length, 2,
  'the complete active eligible roster includes the no-sales member');
assert.deepEqual(saleDayPool.members.map(row => [row.employeeId, row.weight]), [
  [employeeA, 180], [employeeB, 0]
]);
assert.equal(build({ sales: [...sales].reverse(), attendance: [...attendance].reverse(), employees: [...employees].reverse() }).sourceWatermark,
  evidence.sourceWatermark, 'derived evidence fingerprint is independent of source row ordering');
assert.equal(build({ departmentAttribution: { ...departmentAttribution, rows: [] } }).status, 'incomplete',
  'missing department classification blocks rather than assigning a default bucket');
assert.equal(build({ sales: sales.map(row => ({ ...row, department: 'food' })) }).status, 'incomplete',
  'classifier and calculator input must bind to the same department');
assert.equal(build({ attendanceCoverage: { ...attendanceCoverage, complete: false } }).status, 'incomplete');
assert.equal(build({ roleAssignments: roleAssignments.slice(0, 1) }).status, 'incomplete',
  'an active eligible employee with a missing effective role blocks pool membership evidence');

const configuredScheme = structuredClone(scheme);
configuredScheme.roleParameters[roleId].teamFund.distributionPolicy = 'configured_weights';
configuredScheme.roleParameters[roleId].teamWeight = 25;
const configured = build({ scheme: configuredScheme });
assert.equal(configured.status, 'available');
assert.deepEqual(configured.teamMembershipAndWeights.pools.find(row => row.date === '2026-10-10').members.map(row => row.weight), [25, 25]);
configuredScheme.roleParameters[roleId].teamWeight = 0;
const zeroWeight = build({ scheme: configuredScheme });
assert.equal(zeroWeight.teamMembershipAndWeights.pools.find(row => row.date === '2026-10-10').members[0].weight, 0,
  'an explicit configured zero remains a real weight, not missing data');
console.log('PASS payroll-team-fund-source-contract');
