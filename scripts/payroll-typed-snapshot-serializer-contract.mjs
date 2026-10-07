import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { calculatePayrollScheme } = require('../payroll-schemes.js');
const { mapPayrollTypedSnapshotRows: map } = require('../payroll-typed-snapshot-serializer.js');
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const employeeId = id(3), lineId = id(5), menuItemId = id(6);
const fixture = (mode, costCents = 5000) => {
  const role = { perShiftCents: 0, targetCents: 10000, baseRateBps: 1600, bonusRateBps: 4800, excessRatePolicy: 'replace_base' };
  if (mode === 'margin_target') Object.assign(role, { lossPolicy: 'offset_daily_losses', itemRuleBasis: 'net_revenue' });
  if (mode === 'team_fund') role.teamFund = { poolId: 'bar', targetCents: 10000, baseRateBps: 1600, bonusRateBps: 4800, excessRatePolicy: 'replace_base', departments: ['bar'], distributionPolicy: 'configured_weights' };
  if (mode === 'team_fund') role.teamWeight = 1;
  const costSnapshot = { id: 'cost-immutable', version: 'v1', currency: 'RUB', costCents };
  const input = { scheme: { id: 'scheme', versionId: 'version', currency: 'RUB', mode, roleParameters: { bartender: role } },
    periodFrom: '2026-10-01', periodTo: '2026-10-01', employees: [{ id: employeeId }], attendance: [],
    roleAssignments: [{ employeeId, roleId: 'bartender', effectiveFrom: '2026-10-01' }],
    coverage: { kind: 'month_to_date_complete', from: '2026-10-01', through: '2026-10-01', complete: true, watermark: 'scenario' },
    attendanceCoverage: { kind: 'approved_attendance_complete', from: '2026-10-01', through: '2026-10-01', complete: true, watermark: 'scenario' },
    sales: [{ id: lineId, employeeId, menuItemId, department: 'bar', date: '2026-10-01', commissionBaseCents: 20000, turnoverCents: 20000,
      ...(mode === 'margin_target' ? { costSnapshot } : {}) }] };
  return { venueId: id(1), runId: id(2), venueTimezone: 'Asia/Yekaterinburg', employees: [{ id: employeeId, name: 'Алексей' }],
    scenarioInput: input, result: calculatePayrollScheme(input), sourceLines: [{ id: lineId, orderId: id(4), orderItemId: lineId, employeeId, menuItemId, menuItemName: 'Чай',
      department: 'bar', roleId: 'bartender', localDate: '2026-10-01', soldAt: '2026-09-30T20:00:00Z', quantity: '1',
      grossCents: 20100, discountCents: 100, refundCents: 0, commissionBaseCents: 20000, turnoverCents: 20000,
      ...(mode === 'margin_target' ? { costSnapshot: structuredClone(costSnapshot) } : {}) }] };
};
for (const mode of ['personal_target', 'team_fund', 'margin_target']) {
  const data = fixture(mode), before = structuredClone(data);
  const dto = map(data);
  assert.deepEqual(data, before, 'mapping never changes input');
  assert.equal(dto.dailySnapshots[0].snapshot_schema_version, 2);
  assert.equal(dto.dailySnapshots[0].calculation_kind, mode);
  assert.equal(dto.snapshotLines[0].commission_base_net, '200.00');
  assert.equal(dto.snapshotLines[0].snapshotKey, dto.dailySnapshots[0].key);
  assert.equal(dto.snapshotLines[0].sold_at, '2026-09-30T20:00:00.000Z');
  if (mode === 'team_fund') {
    assert.equal(dto.snapshotLines[0].commission_kind, 'team_source');
    assert.equal(dto.fundAllocations[0].poolKey, dto.fundSnapshots[0].key);
    assert.equal(dto.snapshotLines[0].teamPoolKey, dto.fundSnapshots[0].key);
    assert.equal(dto.fundAllocations[0].allocated_amount, dto.dailySnapshots[0].team_fund_pay);
    assert.equal(dto.fundSnapshots[0].fund_amount, '64.00');
  } else {
    assert.equal(dto.snapshotLines[0].applied_rate_bps, null, 'typed rate is never fabricated');
    assert.equal(dto.fundSnapshots.length, 0);
    assert.equal(dto.snapshotLines[0].commission_kind, mode);
  }
  if (mode === 'margin_target') {
    assert.equal(dto.snapshotLines[0].net_cost_amount, '50.00');
    assert.equal(dto.snapshotLines[0].signed_margin_amount, '150.00');
    assert.equal(dto.snapshotLines[0].cost_snapshot_json.id, 'cost-immutable');
  }
  dto.dailySnapshots[0].explanation_json.shiftDetails.push({ invented: true });
  dto.dailySnapshots[0].incentive_json.basisCents = 1;
  assert.deepEqual(data, before, 'output evidence is detached');
  const bad = structuredClone(data); bad.result.daily[0].employees[0].departmentSalesCents.bar++;
  assert.throws(() => map(bad), (error) => error.code === 'payroll_typed_snapshot_departments_mismatch');
  const blocked = structuredClone(data); blocked.result.status = 'blocked';
  assert.throws(() => map(blocked), (error) => error.code === 'payroll_reconciliation_result_not_ready');
}
const irrelevant = fixture('personal_target');
for (const mode of ['personal_target', 'margin_target']) for (const badRate of [{ bad: true }, [], undefined, '0', 0]) {
  const data = fixture(mode); data.result.daily[0].lines[0].baseRateBps = badRate;
  assert.throws(() => map(data), (error) => error.code === 'payroll_reconciliation_typed_line_rate_invalid');
}
irrelevant.result.daily[0].employees[0].targetIncentive.lossPolicy = { nested: 'input' };
irrelevant.result.daily[0].lines[0].targetAllocation.payableBasisCents = { nested: 'input' };
const irrelevantDto = map(irrelevant);
assert.equal(Object.hasOwn(irrelevantDto.dailySnapshots[0].incentive_json, 'lossPolicy'), false);
assert.equal(Object.hasOwn(irrelevantDto.snapshotLines[0].incentive_json, 'payableBasisCents'), false);
irrelevantDto.dailySnapshots[0].incentive_json.lossPolicy = { nested: 'output' };
assert.equal(irrelevant.result.daily[0].employees[0].targetIncentive.lossPolicy.nested, 'input');
const invalidBasis = fixture('personal_target'); invalidBasis.result.venueTurnoverBasis = { injected: true };
assert.throws(() => map(invalidBasis), (error) => error.code === 'payroll_typed_snapshot_turnover_basis_invalid');
const invalidPool = fixture('team_fund'); invalidPool.result.daily[0].teamFunds[0].basis = { injected: true };
assert.throws(() => map(invalidPool), (error) => error.code === 'payroll_typed_snapshot_pool_evidence_invalid');
const invalidReason = fixture('team_fund'); invalidReason.result.daily[0].lines[0].teamFundSource.exclusionReason = { injected: true };
assert.throws(() => map(invalidReason), (error) => error.code === 'payroll_typed_snapshot_pool_exclusion_invalid');
const loss = map(fixture('margin_target', 30000));
assert.equal(loss.snapshotLines[0].signed_margin_amount, '-100.00');
assert.equal(loss.snapshotLines[0].net_cost_amount, '300.00');
assert.equal(loss.dailySnapshots[0].commission_pay, '0.00');
const mixed = fixture('personal_target');
const secondEmployee = id(8), secondLine = id(9);
mixed.scenarioInput.employees.push({ id: secondEmployee });
mixed.scenarioInput.scheme.roleParameters.other = { mode: 'percent_only', stableRateBps: 500 };
mixed.scenarioInput.roleAssignments.push({ employeeId: secondEmployee, roleId: 'other', effectiveFrom: '2026-10-01' });
mixed.scenarioInput.sales.push({ id: secondLine, employeeId: secondEmployee, menuItemId, department: 'bar', date: '2026-10-01', commissionBaseCents: 10000, turnoverCents: 10000 });
mixed.result = calculatePayrollScheme(mixed.scenarioInput);
mixed.employees.push({ id: secondEmployee, name: 'Второй сотрудник' });
mixed.sourceLines.push({ ...mixed.sourceLines[0], id: secondLine, orderItemId: secondLine, employeeId: secondEmployee, roleId: 'other',
  grossCents: 10000, discountCents: 0, commissionBaseCents: 10000, turnoverCents: 10000 });
const mixedDto = map(mixed);
assert.equal(mixedDto.dailySnapshots.length, 2);
assert.equal(mixedDto.snapshotLines.find((line) => line.employee_id === secondEmployee).commission_kind, 'scalar');
assert.equal(mixedDto.snapshotLines.find((line) => line.employee_id === secondEmployee).applied_rate_bps, 500);
console.log('PAYROLL TYPED SNAPSHOT SERIALIZER CONTRACT: PASS (typed detached DTOs, signed losses, hostile metadata, transient links and source/arithmetic gates)');
