import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { calculatePayrollScheme } = require('../payroll-schemes.js');
const { validatePayrollSnapshotEvidence: validate } = require('../payroll-snapshot-evidence.js');
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const employeeId = id(3), lineId = id(5), menuItemId = id(6);
const fixture = (mode, eligibility) => {
  const role = { perShiftCents: 0, targetCents: 10000, baseRateBps: 1600, bonusRateBps: 4800, excessRatePolicy: 'replace_base' };
  if (eligibility !== undefined) role.milestoneEligibility = eligibility;
  if (mode === 'margin_target') Object.assign(role, { lossPolicy: 'offset_daily_losses', itemRuleBasis: 'net_revenue' });
  if (mode === 'team_fund') role.teamFund = { poolId: 'bar', targetCents: 10000, baseRateBps: 1600, bonusRateBps: 4800, excessRatePolicy: 'replace_base', departments: ['bar'], distributionPolicy: 'configured_weights' };
  if (mode === 'team_fund') role.teamWeight = 1;
  const costSnapshot = { id: 'cost-immutable', version: 'v1', currency: 'RUB', costCents: 5000 };
  const input = { scheme: { id: 'scheme', versionId: 'version', currency: 'RUB', mode, roleParameters: { bartender: role } },
    periodFrom: '2026-10-01', periodTo: '2026-10-01', employees: [{ id: employeeId }], attendance: [],
    roleAssignments: [{ employeeId, roleId: 'bartender', effectiveFrom: '2026-10-01' }],
    coverage: { kind: 'month_to_date_complete', from: '2026-10-01', through: '2026-10-01', complete: true, watermark: 'scenario' },
    attendanceCoverage: { kind: 'approved_attendance_complete', from: '2026-10-01', through: '2026-10-01', complete: true, watermark: 'scenario' },
    sales: [{ id: lineId, employeeId, menuItemId, department: 'bar', date: '2026-10-01', commissionBaseCents: 20000, turnoverCents: 20000,
      ...(mode === 'margin_target' ? { costSnapshot } : {}) }] };
  return { venueId: id(1), runId: id(2), venueTimezone: 'Asia/Yekaterinburg', employees: [{ id: employeeId, name: 'Алексей' }],
    result: calculatePayrollScheme(input), sourceLines: [{ id: lineId, orderId: id(4), orderItemId: lineId, employeeId, menuItemId, menuItemName: 'Чай',
      department: 'bar', roleId: 'bartender', localDate: '2026-10-01', soldAt: '2026-09-30T20:00:00Z', quantity: '1',
      grossCents: 20100, discountCents: 100, refundCents: 0, commissionBaseCents: 20000, turnoverCents: 20000,
      ...(mode === 'margin_target' ? { costSnapshot: structuredClone(costSnapshot) } : {}) }] };
};
for (const mode of ['personal_target', 'team_fund', 'margin_target']) {
  const data = fixture(mode), before = structuredClone(data);
  assert.equal(validate(data).sourceById.get(lineId).commissionBaseNet, '200.00');
  assert.deepEqual(data, before);
  for (const eligibility of ['all_active', 'worked_on_threshold_day']) {
    const staged = fixture(mode, eligibility);
    assert.ok(Array.isArray(staged.result.daily[0].milestoneDecisions));
    assert.deepEqual(validate(staged).milestoneEvidence, [{ date: '2026-10-01', milestoneDecisions: [] }]);
  }
  for (const metadata of [null, {}, 'invalid']) {
    const unsupported = structuredClone(data); unsupported.result.daily[0].milestoneDecisions = metadata;
    assert.throws(() => validate(unsupported), (error) => error.code === 'payroll_milestone_evidence_day_invalid');
  }
  const arithmetic = structuredClone(data); arithmetic.result.employees[0].amountCents++;
  assert.throws(() => validate(arithmetic), (error) => error.code.startsWith('payroll_reconciliation_'));
  const lineage = structuredClone(data); lineage.sourceLines[0].employeeId = id(99);
  assert.throws(() => validate(lineage), (error) => error.code.startsWith('payroll_source_'));
  const unsafe = structuredClone(data); unsafe.result.payoutEligible = false;
  assert.throws(() => validate(unsafe), (error) => error.code === 'payroll_reconciliation_result_not_ready');
}
// A coherent mixed-case calculator result can pick a different residual-cent
// winner than lowercase SQL UUID ordering. Reject it rather than rewrite IDs.
const mixedIds = ['BBBBBBBB-0000-4000-8000-000000000003', 'aaaaaaaa-0000-4000-8000-000000000004'];
const mixedLines = [id(21), id(22)];
const mixedPool = { poolId: 'mixed', targetCents: 10000, baseRateBps: 1, bonusRateBps: 0, excessRatePolicy: 'replace_base',
  departments: ['bar'], distributionPolicy: 'configured_weights' };
const mixedInput = { scheme: { id: 's', versionId: 'v', currency: 'RUB', mode: 'team_fund', roleParameters: {
  bar: { perShiftCents: 0, teamWeight: 1, teamFund: mixedPool } } },
  periodFrom: '2026-10-01', periodTo: '2026-10-01', employees: mixedIds.map((id) => ({ id })), attendance: [],
  roleAssignments: mixedIds.map((employeeId) => ({ employeeId, roleId: 'bar', effectiveFrom: '2026-10-01' })),
  coverage: { kind: 'month_to_date_complete', from: '2026-10-01', through: '2026-10-01', complete: true, watermark: 'scenario' },
  attendanceCoverage: { kind: 'approved_attendance_complete', from: '2026-10-01', through: '2026-10-01', complete: true, watermark: 'scenario' },
  sales: mixedIds.map((employeeId, index) => ({ id: mixedLines[index], employeeId, menuItemId, department: 'bar', date: '2026-10-01',
    commissionBaseCents: 5000, turnoverCents: 5000 })) };
const mixedData = { venueId: id(1), runId: id(2), venueTimezone: 'UTC', result: calculatePayrollScheme(mixedInput),
  employees: mixedIds.map((id) => ({ id, name: 'Employee' })), sourceLines: mixedIds.map((employeeId, index) => ({ id: mixedLines[index],
    orderId: id(4), orderItemId: mixedLines[index], employeeId, menuItemId, menuItemName: 'Tea', department: 'bar', roleId: 'bar',
    localDate: '2026-10-01', soldAt: '2026-10-01T12:00:00Z', quantity: '1', grossCents: 5000, discountCents: 0, refundCents: 0,
    commissionBaseCents: 5000, turnoverCents: 5000 })) };
assert.equal(mixedData.result.payoutEligible, true);
assert.equal(mixedData.result.daily[0].teamFunds[0].allocations.find((row) => row.id === mixedIds[0]).amountCents, 1);
assert.throws(() => validate(mixedData), (error) => error.code === 'payroll_source_calculated_uuid_noncanonical');
console.log('PAYROLL SNAPSHOT EVIDENCE CONTRACT: PASS (typed calculators, canonical allocation IDs, arithmetic and lineage gates)');
