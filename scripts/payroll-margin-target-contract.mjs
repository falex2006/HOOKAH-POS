import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { calculatePayrollScheme: calculate } = createRequire(import.meta.url)('../payroll-schemes.js');
const fixture = () => ({ scheme: { id: 's', versionId: 'v', currency: 'RUB', mode: 'margin_target', roleParameters: {
  bar: { perShiftCents: 0, targetCents: 10000, baseRateBps: 1600, bonusRateBps: 4800,
    excessRatePolicy: 'replace_base', lossPolicy: 'offset_daily_losses', itemRuleBasis: 'net_revenue' }
}, employeeOverrides: [], itemRules: [] }, periodFrom: '2026-10-01', periodTo: '2026-10-01', employees: [{ id: 'a' }],
roleAssignments: [{ employeeId: 'a', roleId: 'bar', effectiveFrom: '2026-10-01' }], attendance: [],
coverage: { kind: 'month_to_date_complete', from: '2026-10-01', through: '2026-10-01', complete: true, watermark: 'scenario' },
attendanceCoverage: { kind: 'approved_attendance_complete', from: '2026-10-01', through: '2026-10-01', complete: true, watermark: 'scenario' },
sales: [{ id: 'positive', employeeId: 'a', menuItemId: 'x', department: 'bar', date: '2026-10-01', turnoverCents: 20000, commissionBaseCents: 20000,
  costSnapshot: { id: 'cost', version: 'v1', currency: 'RUB', costCents: 5000 } },
{ id: 'loss', employeeId: 'a', menuItemId: 'y', department: 'bar', date: '2026-10-01', turnoverCents: 1000, commissionBaseCents: 1000,
  costSnapshot: { id: 'cost', version: 'v1', currency: 'RUB', costCents: 6000 } }] });
const amount = (input) => calculate(input).employees[0].commissionCents;
const result = calculate(fixture());
assert.equal(result.status, 'ready'); assert.equal(amount(fixture()), 1600);
const incentive = result.daily[0].employees[0].marginIncentive;
assert.equal(incentive.signedMarginCents, 10000); assert.equal(incentive.payableMarginCents, 10000);
assert.equal(incentive.lossOffsetCents, 5000);
assert.equal(result.daily[0].lines.find((line) => line.lineId === 'loss').marginAllocation.payableMarginCents, 0);
assert.equal(result.daily[0].lines.find((line) => line.lineId === 'positive').marginAllocation.lossOffsetCents, 5000);
assert.ok(result.daily[0].lines.every((line) => line.appliedRateBps === null));
assert.equal(result.daily[0].lines.reduce((sum, line) => sum + line.commissionCents, 0), 1600);
const shuffled = fixture(); shuffled.sales.reverse(); assert.deepEqual(calculate(shuffled), result);
const allLoss = fixture(); allLoss.sales.shift(); assert.equal(amount(allLoss), 0);
assert.equal(calculate(allLoss).daily[0].employees[0].marginIncentive.signedMarginCents, -5000);
for (const [change, code] of [[(row) => delete row.costSnapshot, 'margin_cost_snapshot_required'], [(row) => delete row.costSnapshot.version, 'invalid_margin_cost_snapshot'],
  [(row) => row.costSnapshot.currency = 'USD', 'margin_cost_currency_mismatch'], [(row) => row.costSnapshot.costCents = -1, 'invalid_margin_cost_snapshot']]) {
  const input = fixture(); change(input.sales[0]); assert.ok(calculate(input).blockers.includes(code));
}
const replacement = fixture(); replacement.scheme.itemRules = [{ menuItemId: 'y', roleId: 'bar', mode: 'replace', rateBps: 1000 }];
assert.equal(amount(replacement), 4100, 'replacement loss excluded, ordinary net revenue commission remains');
assert.equal(calculate(replacement).daily[0].employees[0].marginIncentive.signedMarginCents, 15000);
delete replacement.sales[1].costSnapshot; assert.equal(calculate(replacement).status, 'blocked', 'replacement still requires lineage');
const additive = fixture(); additive.scheme.itemRules = [{ menuItemId: 'y', employeeId: 'a', mode: 'additive', rateBps: 1000 }];
assert.equal(amount(additive), 1700, 'negative margin line still earns configured revenue addition');
const reset = fixture(); reset.periodTo = '2026-10-02'; reset.coverage.through = '2026-10-02'; reset.attendanceCoverage.through = '2026-10-02';
reset.sales.push(...reset.sales.map((row) => ({ ...row, id: `${row.id}2`, date: '2026-10-02' })));
assert.equal(amount(reset), 3200);
const split = fixture(); split.sales = [
  { ...split.sales[0], id: 'a', commissionBaseCents: 10000, turnoverCents: 10000, costSnapshot: { ...split.sales[0].costSnapshot, costCents: 2500 } },
  { ...split.sales[0], id: 'b', commissionBaseCents: 10000, turnoverCents: 10000, costSnapshot: { ...split.sales[0].costSnapshot, costCents: 2500 } }, split.sales[1]
];
assert.equal(amount(split), 1600); assert.equal(calculate(split).daily[0].lines.reduce((sum, line) => sum + line.commissionCents, 0), 1600);
const override = fixture(); override.scheme.employeeOverrides = [{ employeeId: 'a', path: 'targetCents', mode: 'override', value: 0 },
  { employeeId: 'a', path: 'lossPolicy', mode: 'override', value: 'offset_daily_losses' }, { employeeId: 'a', path: 'itemRuleBasis', mode: 'override', value: 'net_revenue' }];
assert.equal(amount(override), 4800);
override.scheme.employeeOverrides[1].value = 'clamp_lines'; assert.equal(calculate(override).status, 'blocked');
const mixed = fixture(); mixed.employees.push({ id: 'b' }); mixed.roleAssignments.push({ employeeId: 'b', roleId: 'other', effectiveFrom: '2026-10-01' });
mixed.scheme.roleParameters.other = { mode: 'percent_only', stableRateBps: 1000 };
mixed.sales.push({ id: 'other', employeeId: 'b', menuItemId: 'z', department: 'bar', date: '2026-10-01', commissionBaseCents: 1000, turnoverCents: 1000 });
assert.equal(calculate(mixed).employees[1].commissionCents, 100, 'other modes need no margin cost snapshot');
const guard = fixture(); for (const row of guard.sales) row.turnoverCents = 0;
assert.equal(calculate(guard).payoutEligible, false);
const overflow = fixture(); overflow.sales = [0, 1].map((index) => ({ ...overflow.sales[0], id: `huge${index}`, commissionBaseCents: Number.MAX_SAFE_INTEGER,
  turnoverCents: 0, costSnapshot: { ...overflow.sales[0].costSnapshot, costCents: 0 } }));
assert.ok(calculate(overflow).blockers.includes('amount_exceeds_safe_integer_cents'));
const lossOverflow = fixture(); lossOverflow.sales = [0, 1].map((index) => ({ ...lossOverflow.sales[0], id: `loss${index}`, commissionBaseCents: 0,
  turnoverCents: 0, costSnapshot: { ...lossOverflow.sales[0].costSnapshot, costCents: Number.MAX_SAFE_INTEGER } }));
assert.ok(calculate(lossOverflow).blockers.includes('amount_exceeds_safe_integer_cents'));
const cancelledOverflow = fixture(); cancelledOverflow.sales = [...overflow.sales, ...lossOverflow.sales];
assert.ok(calculate(cancelledOverflow).blockers.includes('amount_exceeds_safe_integer_cents'), 'safe signed net does not hide unsafe explanation components');
const emptyAttendance = fixture(); emptyAttendance.sales = [];
emptyAttendance.attendance = [{ id: 'shift', employeeId: 'a', date: '2026-10-01', approved: true, workedMinutes: 60, plannedMinutes: 60 }];
assert.equal(calculate(emptyAttendance).daily[0].employees[0].marginIncentive.payableMarginCents, 0);
const modeOverride = fixture(); modeOverride.scheme.mode = 'stable_percent'; modeOverride.scheme.roleParameters.bar.stableRateBps = 1000;
modeOverride.scheme.employeeOverrides = [{ employeeId: 'a', path: 'mode', mode: 'override', value: 'margin_target' }];
assert.equal(amount(modeOverride), 1600);
delete modeOverride.scheme.roleParameters.bar.lossPolicy;
assert.ok(calculate(modeOverride).blockers.includes('invalid_margin_loss_policy'));
const cap = fixture(); cap.scheme.roleParameters.bar.cap = { basis: 'venue_day', rateBps: 100 };
assert.equal(calculate(cap).employees[0].amountCents, 210);
console.log('PAYROLL MARGIN TARGET CONTRACT: PASS');
