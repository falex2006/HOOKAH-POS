import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { mapPayrollSnapshotRows } = require('../payroll-snapshot-serializer.js');
const venueId = '00000000-0000-4000-8000-000000000001';
const runId = '00000000-0000-4000-8000-000000000002';
const employeeId = '00000000-0000-4000-8000-000000000003';
const orderId = '00000000-0000-4000-8000-000000000004';
const orderItemId = '00000000-0000-4000-8000-000000000005';
const menuItemId = '00000000-0000-4000-8000-000000000006';
const source = {
  id: orderItemId, orderId, orderItemId, employeeId, menuItemId, menuItemName: 'Чай',
  department: 'bar', roleId: 'bartender', localDate: '2026-09-01', soldAt: '2026-09-01T10:00:00+05:00',
  quantity: '1', grossCents: 10001, discountCents: 101, refundCents: 0, commissionBaseCents: 9900,
  turnoverCents: 10001, appliedRateBps: 1000, commissionCents: 990
};
const result = {
  status: 'ready', payoutEligible: true, criticalErrors: [], periodFrom: '2026-09-01', periodTo: '2026-09-01', employees: [{ employeeId }],
  daily: [{ date: '2026-09-01', venueTurnoverCents: 10001, cumulativeVenueTurnoverCents: 10001,
    employees: [{ employeeId, roleId: 'bartender', shifts: 1, shiftDetails: [{ workedMinutes: 480 }],
      personalRevenueCents: 10001, basePayCents: 1000, commissionCents: 990, milestoneBonusCents: 0, amountBeforeCapCents: 1990,
      capCents: null, capReductionCents: 0, amountCents: 1990, departmentSalesCents: { bar: 1990 }, departmentTurnoverCents: { bar: 10001 } }],
    lines: [{ lineId: orderItemId, employeeId, roleId: 'bartender', menuItemId, department: 'bar',
      commissionBaseCents: 9900, turnoverCents: 10001, appliedRateBps: 1000, commissionCents: 990, itemRuleId: null }]
  }]
};
const employees = [{ id: employeeId, name: 'Алексей' }];
const original = structuredClone(result);
const mapped = mapPayrollSnapshotRows({ venueId, runId, result, employees, sourceLines: [source] });
assert.deepEqual(result, original, 'serializer leaves calculation result unchanged');
assert.equal(mapped.dailySnapshots.length, 1);
assert.equal(mapped.dailySnapshots[0].final_amount, '19.90');
assert.equal(mapped.dailySnapshots[0].cap_amount, null);
assert.equal(mapped.dailySnapshots[0].item_adjustments, '0.00');
assert.equal(mapped.snapshotLines[0].gross_amount, '100.01');
assert.equal(mapped.snapshotLines[0].discount_amount, '1.01');
assert.equal(mapped.snapshotLines[0].commission_base_net, '99.00');
assert.equal(mapped.snapshotLines[0].quantity, '1.000');
assert.equal(mapped.snapshotLines[0].snapshotKey, mapped.dailySnapshots[0].key);
assert.ok(!Object.hasOwn(mapped.dailySnapshots[0], 'snapshot_key'));

const rejects = (args, code) => assert.throws(() => mapPayrollSnapshotRows(args), (error) => error.code === code);
const base = { venueId, runId, result, employees, sourceLines: [source] };
rejects({ ...base, result: { ...result, mode: 'margin_target' } }, 'payroll_snapshot_incentive_schema_required');
rejects({ ...base, result: { ...result, modes: ['stable_percent', 'margin_target'] } }, 'payroll_snapshot_incentive_schema_required');
rejects({ ...base, result: { ...result, daily: [{ ...result.daily[0], lines: [{ ...result.daily[0].lines[0], marginAllocation: {} }] }] } }, 'payroll_snapshot_incentive_schema_required');
rejects({ ...base, result: { ...result, mode: 'team_fund' } }, 'payroll_snapshot_incentive_schema_required');
rejects({ ...base, result: { ...result, modes: ['stable_percent', 'team_fund'] } }, 'payroll_snapshot_incentive_schema_required');
rejects({ ...base, result: { ...result, daily: [{ ...result.daily[0], teamFunds: [{ poolId: 'qa' }] }] } }, 'payroll_snapshot_incentive_schema_required');
rejects({ ...base, result: { ...result, daily: [{ ...result.daily[0], lines: [{ ...result.daily[0].lines[0], teamFundSource: {} }] }] } }, 'payroll_snapshot_incentive_schema_required');
rejects({ ...base, result: { ...result, mode: 'personal_target' } }, 'payroll_snapshot_incentive_schema_required');
rejects({ ...base, result: { ...result, modes: ['stable_percent', 'personal_target'] } }, 'payroll_snapshot_incentive_schema_required');
rejects({ ...base, result: { ...result, daily: [{ ...result.daily[0], lines: [{ ...result.daily[0].lines[0], appliedRateBps: null, targetAllocation: {} }] }] } }, 'payroll_snapshot_incentive_schema_required');
rejects({ ...base, result: { ...result, status: 'blocked' } }, 'payroll_snapshot_result_not_ready');
rejects({ ...base, result: { ...result, payoutEligible: false, criticalErrors: [{ code: 'employee_daily_pay_exceeds_personal_revenue' }] } }, 'payroll_snapshot_result_not_ready');
rejects({ ...base, sourceLines: [] }, 'payroll_snapshot_source_line_missing');
rejects({ ...base, sourceLines: [{ ...source, commissionBaseCents: 9901 }] }, 'payroll_snapshot_source_amount_mismatch');
rejects({ ...base, result: { ...result, daily: [{ ...result.daily[0], employees: [{ ...result.daily[0].employees[0], personalRevenueCents: 10000 }] }] } }, 'payroll_snapshot_revenue_reconciliation_failed');
rejects({ ...base, sourceLines: [{ ...source, employeeId: runId }] }, 'payroll_snapshot_source_line_mismatch');
rejects({ ...base, sourceLines: [{ ...source, quantity: '1.0001' }] }, 'payroll_snapshot_quantity_invalid');
rejects({ ...base, sourceLines: [{ ...source, quantity: '99999999999999.999' }] }, 'payroll_snapshot_quantity_invalid');
rejects({ ...base, sourceLines: [source, source] }, 'payroll_snapshot_line_duplicate');
rejects({ ...base, result: { ...result, daily: [{ ...result.daily[0], employees: [{ ...result.daily[0].employees[0], commissionCents: 989 }] }] } }, 'payroll_snapshot_commission_reconciliation_failed');
rejects({ ...base, result: { ...result, daily: [result.daily[0], result.daily[0]] } }, 'payroll_snapshot_daily_row_invalid');
rejects({ ...base, sourceLines: [{ ...source, soldAt: 'not-a-date' }] }, 'payroll_snapshot_source_line_invalid');
rejects({ ...base, sourceLines: [{ ...source, department: 'b'.repeat(81) }], result: { ...result, daily: [{ ...result.daily[0], lines: [{ ...result.daily[0].lines[0], department: 'b'.repeat(81) }] }] } }, 'payroll_snapshot_department_missing');

for (const metadata of [null, {}, 'invalid']) rejects({ ...base, result: { ...result,
  daily: [{ ...result.daily[0], milestoneDecisions: metadata }] } }, 'payroll_milestone_evidence_day_invalid');
console.log('PAYROLL SNAPSHOT SERIALIZER CONTRACT: PASS (lineage, cents, quantity precision, readiness and pure mapping)');
