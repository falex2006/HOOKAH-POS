import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { validatePayrollSnapshotSourceContext: validate } = require('../payroll-snapshot-source-context.js');
const { calculatePayrollScheme } = require('../payroll-schemes.js');
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const employeeId = id(3), menuItemId = id(6), lineId = id(5);
const source = { id: lineId, orderId: id(4), orderItemId: lineId, employeeId, menuItemId, menuItemName: 'Чай', department: 'bar', roleId: 'bartender',
  localDate: '2026-10-01', soldAt: '2026-09-30T20:00:00Z', quantity: '1.25', grossCents: 15100, discountCents: 100, refundCents: 0,
  commissionBaseCents: 15000, turnoverCents: 15000 };
const input = { scheme: { id: 's', versionId: 'v', currency: 'RUB', mode: 'personal_target', roleParameters: { bartender: {
  perShiftCents: 0, targetCents: 10000, baseRateBps: 1600, bonusRateBps: 6500, excessRatePolicy: 'replace_base' } } },
  periodFrom: '2026-10-01', periodTo: '2026-10-01', employees: [{ id: employeeId }], attendance: [],
  roleAssignments: [{ employeeId, roleId: 'bartender', effectiveFrom: '2026-10-01' }],
  coverage: { kind: 'month_to_date_complete', from: '2026-10-01', through: '2026-10-01', complete: true, watermark: 'scenario' },
  attendanceCoverage: { kind: 'approved_attendance_complete', from: '2026-10-01', through: '2026-10-01', complete: true, watermark: 'scenario' },
  sales: [{ id: lineId, employeeId, menuItemId, department: 'bar', date: '2026-10-01', commissionBaseCents: 15000, turnoverCents: 15000 }] };
const fixture = () => ({ venueId: id(1), runId: id(2), venueTimezone: 'Asia/Yekaterinburg', employees: [{ id: employeeId, name: 'Алексей' }],
  sourceLines: [structuredClone(source)], result: calculatePayrollScheme(structuredClone(input)) });
const original = fixture(), copy = structuredClone(original);
const context = validate(original);
assert.deepEqual(original, copy, 'no input mutation');
assert.equal(context.sourceById.get(lineId).quantity, '1.250');
assert.equal(context.sourceById.get(lineId).commissionBaseNet, '150.00');
assert.equal(context.sourceById.get(lineId).soldAt, '2026-09-30T20:00:00.000Z');
assert.equal(original.result.daily[0].lines[0].appliedRateBps, null, 'typed null rate accepted without POS payroll output fields');
const rejects = (mutate, code) => { const data = fixture(); mutate(data); assert.throws(() => validate(data), (e) => e.code === code); };
rejects((d) => d.venueTimezone = '', 'payroll_source_timezone_required');
rejects((d) => d.venueTimezone = 'Imaginary/Zone', 'payroll_source_timezone_invalid');
rejects((d) => d.venueTimezone = 'UTC', 'payroll_source_local_date_mismatch');
rejects((d) => d.sourceLines[0].soldAt = '2026-02-30T12:00:00Z', 'payroll_source_date_invalid');
rejects((d) => d.sourceLines[0].soldAt = '2026-09-30T24:00:00Z', 'payroll_source_timestamp_invalid');
rejects((d) => d.sourceLines[0].soldAt = '2026-10-01T10:00:00', 'payroll_source_timestamp_invalid');
rejects((d) => d.sourceLines[0].venueId = id(20), 'payroll_source_venue_mismatch');
rejects((d) => d.employees.push(d.employees[0]), 'payroll_source_employee_duplicate');
rejects((d) => d.sourceLines.push(d.sourceLines[0]), 'payroll_source_line_duplicate');
rejects((d) => d.result.daily[0].lines.push(d.result.daily[0].lines[0]), 'payroll_source_calculated_line_duplicate');
rejects((d) => d.sourceLines[0].roleId = 'other', 'payroll_source_line_context_mismatch');
rejects((d) => d.sourceLines[0].menuItemId = id(10), 'payroll_source_line_context_mismatch');
rejects((d) => d.sourceLines[0].department = 'hookah', 'payroll_source_line_context_mismatch');
rejects((d) => d.sourceLines[0].grossCents += 1, 'payroll_source_net_reconciliation_failed');
rejects((d) => d.sourceLines[0].turnoverCents += 1, 'payroll_source_line_amount_mismatch');
rejects((d) => d.sourceLines[0].grossCents = Number.MAX_SAFE_INTEGER + 1, 'payroll_source_money_invalid');
rejects((d) => d.sourceLines[0].quantity = '0', 'payroll_source_quantity_invalid');
rejects((d) => d.sourceLines[0].quantity = '1.0001', 'payroll_source_quantity_invalid');
rejects((d) => d.sourceLines = [], 'payroll_source_line_context_mismatch');
rejects((d) => d.result.daily[0].lines = [], 'payroll_source_line_coverage_mismatch');
rejects((d) => { d.result.periodTo = '2026-10-02'; }, 'payroll_source_date_coverage_mismatch');
rejects((d) => d.result.periodTo = '2099-01-01', 'payroll_source_period_invalid');
rejects((d) => d.result.currency = 'rub', 'payroll_source_currency_invalid');
rejects((d) => delete d.result.daily[0].employees[0].mode, 'payroll_source_mode_invalid');
rejects((d) => d.result.modes = [], 'payroll_source_mode_invalid');
rejects((d) => delete d.result.daily[0].lines[0].targetAllocation, 'payroll_source_calculated_rate_invalid');
const marginInput = structuredClone(input);
marginInput.scheme.mode = 'margin_target';
Object.assign(marginInput.scheme.roleParameters.bartender, { lossPolicy: 'offset_daily_losses', itemRuleBasis: 'net_revenue' });
marginInput.sales[0].costSnapshot = { id: 'cost', version: 'v1', currency: 'RUB', costCents: 5000 };
const margin = fixture(); margin.result = calculatePayrollScheme(marginInput); margin.sourceLines[0].costSnapshot = structuredClone(marginInput.sales[0].costSnapshot);
assert.equal(validate(margin).sourceById.get(lineId).costSnapshot.costCents, 5000);
delete margin.sourceLines[0].costSnapshot;
assert.throws(() => validate(margin), (e) => e.code === 'payroll_source_cost_snapshot_required');
margin.sourceLines[0].costSnapshot = { ...marginInput.sales[0].costSnapshot, version: 'v2' };
assert.throws(() => validate(margin), (e) => e.code === 'payroll_source_cost_snapshot_mismatch');
const extraOutputs = fixture(); Object.assign(extraOutputs.sourceLines[0], { appliedRateBps: 99999, commissionCents: -1 });
validate(extraOutputs); // POS cannot prescribe payroll rate or commission.
const uppercaseCalculated = 'ABCDEF01-0000-4000-8000-000000000003';
for (const mutate of [
  (d) => d.result.employees[0].employeeId = uppercaseCalculated,
  (d) => d.result.daily[0].employees[0].employeeId = uppercaseCalculated,
  (d) => d.result.daily[0].lines[0].lineId = uppercaseCalculated,
  (d) => d.result.daily[0].lines[0].employeeId = uppercaseCalculated,
  (d) => d.result.daily[0].teamFunds = [{ memberIds: [uppercaseCalculated], allocations: [], sourceLineIds: [] }],
  (d) => d.result.daily[0].teamFunds = [{ memberIds: [], allocations: [{ id: uppercaseCalculated }], sourceLineIds: [] }],
  (d) => d.result.daily[0].teamFunds = [{ memberIds: [], allocations: [], sourceLineIds: [uppercaseCalculated] }]
]) rejects(mutate, 'payroll_source_calculated_uuid_noncanonical');
const rawUppercase = fixture();
const lowerEmployee = uppercaseCalculated.toLowerCase();
// Raw source identifiers may be normalized when calculator output is canonical.
rawUppercase.result = JSON.parse(JSON.stringify(rawUppercase.result).replaceAll(employeeId, lowerEmployee));
rawUppercase.employees[0].id = uppercaseCalculated; rawUppercase.sourceLines[0].employeeId = uppercaseCalculated;
assert.equal(validate(rawUppercase).sourceById.get(lineId).employeeId, lowerEmployee);
console.log('PAYROLL SNAPSHOT SOURCE CONTEXT CONTRACT: PASS (typed lineage, explicit timezone, source coverage and pure canonicalization)');
