import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { calculatePayrollScheme: calculate } = require('../payroll-schemes');
const { mapPayrollSnapshotRows: legacy } = require('../payroll-snapshot-serializer');
const { mapPayrollTypedSnapshotRows: typed } = require('../payroll-typed-snapshot-serializer');
const id = n => `00000000-0000-4000-8000-${(n === 8 ? 'a' : String(n)).padStart(12, '0')}`;
for (const mode of ['stable_percent', 'percent_only', 'personal_target', 'team_fund', 'margin_target']) {
  const role = { perShiftCents: 0, stableRateBps: 0, targetCents: 10000, baseRateBps: 0, bonusRateBps: 0,
    excessRatePolicy: 'replace_base', milestoneBonusesCents: { 10000: 100 },
    ...(mode === 'margin_target' ? { lossPolicy: 'offset_daily_losses', itemRuleBasis: 'net_revenue' } : {}),
    ...(mode === 'team_fund' ? { teamWeight: 1, teamFund: { poolId: 'bar', targetCents: 10000, baseRateBps: 0,
      bonusRateBps: 0, excessRatePolicy: 'replace_base', departments: ['bar'], distributionPolicy: 'configured_weights' } } : {}) };
  const attendance = [{ id: id(7), employeeId: id(3), date: '2026-10-01', approved: true, workedMinutes: 60, plannedMinutes: 60 }];
  const costSnapshot = { id: 'cost', version: 'v1', currency: 'RUB', costCents: 100 };
  const input = { scheme: { id: 's', versionId: 'v', currency: 'RUB', mode, applyMilestones: true,
      milestoneEligibility: 'worked_on_threshold_day', roleParameters: { bar: role } },
    periodFrom: '2026-10-01', periodTo: '2026-10-01', employees: [{ id: id(3) }, { id: id(8) }], attendance,
    roleAssignments: [3, 8].map(n => ({ employeeId: id(n), roleId: 'bar', effectiveFrom: '2026-10-01' })),
    coverage: { kind: 'month_to_date_complete', from: '2026-10-01', through: '2026-10-01', complete: true, watermark: 'scenario' },
    attendanceCoverage: { kind: 'approved_attendance_complete', from: '2026-10-01', through: '2026-10-01', complete: true, watermark: 'scenario' },
    sales: [{ id: id(5), employeeId: id(3), menuItemId: id(6), date: '2026-10-01', department: 'bar',
      turnoverCents: 20000, commissionBaseCents: 20000, ...(mode === 'margin_target' ? { costSnapshot } : {}) }] };
  const data = { venueId: id(1), runId: id(2), venueTimezone: 'UTC', attendance,
    employees: [{ id: id(3), name: 'Worked' }, { id: id(8), name: 'No work' }], result: calculate(input),
    sourceLines: [{ id: id(5), orderId: id(4), orderItemId: id(5), employeeId: id(3), menuItemId: id(6), menuItemName: 'Tea',
      roleId: 'bar', department: 'bar', localDate: '2026-10-01', soldAt: '2026-10-01T12:00:00Z', quantity: '1',
      grossCents: 20000, discountCents: 0, refundCents: 0, commissionBaseCents: 20000, turnoverCents: 20000,
      appliedRateBps: 0, commissionCents: 0, ...(mode === 'margin_target' ? { costSnapshot } : {}) }] };
  assert.equal(data.result.status, 'ready');
  const map = ['stable_percent', 'percent_only'].includes(mode) ? legacy : typed;
  const before = structuredClone(data), dto = map(data);
  assert.equal(dto.milestoneEvidence[0].milestoneDecisions.length, 2);
  const rejected = dto.milestoneEvidence[0].milestoneDecisions.find(d => d.employeeId === id(8));
  assert.equal(rejected.awardedAmountCents, 0);
  assert.equal(rejected.eligible, false);
  const paid = dto.dailySnapshots.find(row => row.employee_id === id(3));
  assert.equal(paid.explanation_json.milestoneDecisions[0].awardedAmountCents, 100);
  paid.explanation_json.milestoneDecisions[0].qualifyingShiftIds.push('mutation');
  assert.equal(dto.milestoneEvidence[0].milestoneDecisions.find(d => d.employeeId === id(3)).qualifyingShiftIds.length, 1);
  dto.milestoneEvidence[0].milestoneDecisions[0].reason = 'mutation';
  assert.deepEqual(data, before);
  const missing = structuredClone(data); missing.employees.pop();
  assert.throws(() => map(missing), error => /employee_context_mismatch/.test(error.code));
  const forged = structuredClone(data); forged.result.daily[0].milestoneDecisions[0].qualifyingShiftIds = [id(99)];
  assert.throws(() => map(forged), error => error.code === 'payroll_milestone_evidence_attendance_set_mismatch');
  const mixedCase = structuredClone(data);
  const upperRejected = structuredClone(mixedCase.result.daily[0].milestoneDecisions.find(d => d.employeeId === id(8)));
  upperRejected.employeeId = upperRejected.employeeId.toUpperCase();
  mixedCase.result.daily[0].milestoneDecisions.push(upperRejected);
  assert.throws(() => map(mixedCase), error => ['payroll_snapshot_employee_id_invalid', 'payroll_source_milestone_employee_context_mismatch'].includes(error.code));
  const old = structuredClone(input); delete old.scheme.milestoneEligibility; old.scheme.applyMilestones = false;
  const oldDto = map({ ...data, result: calculate(old) });
  assert.equal(Object.hasOwn(oldDto, 'milestoneEvidence'), false);
  assert.ok(oldDto.dailySnapshots.every(row => !Object.hasOwn(row.explanation_json, 'milestoneDecisions')));
}
console.log('PAYROLL MILESTONE SNAPSHOT: PASS (five modes, rejected recipients, attendance, roster, detached sidecar and legacy omission)');
