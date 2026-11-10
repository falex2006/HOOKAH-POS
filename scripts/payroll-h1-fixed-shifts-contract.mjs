import assert from 'node:assert/strict';
import payroll from '../payroll-schemes.js';
import { randomUUID } from 'node:crypto';
import { buildPayrollH1FixedShiftsRunProvenance } from '../payroll-h1-fixed-shifts-provenance.js';
import { buildPayrollRecognitionManifest } from '../payroll-recognition-manifest.js';
import { makePayrollRefundAwareFixture } from './payroll-refund-aware-calculation-contract.mjs';
import { payrollRefundEconomicFixtureOptions } from './payroll-refund-economic-source-contract.mjs';

const {calculatePayrollScheme, calculatePayrollH1FixedShifts} = payroll;
const from = '2026-09-01', to = '2026-09-14', end = '2026-09-30';
const monthly = { mode:'final_month_threshold', perShiftCents:10001, bracketRatesBps:{0:500,20000:1500} };
const scheme = {id:'scheme',versionId:'v1',currency:'RUB',mode:'progressive_daily',
  roleParameters:{ bar:monthly, floor:{mode:'stable_percent',perShiftCents:0,stableRateBps:1000} },
  employeeOverrides:[], itemRules:[{id:'bonus',menuItemId:'soda',roleId:'bar',mode:'additive',rateBps:2000}]};
const sale = (id, employeeId, date, amount) => ({id, employeeId, date, menuItemId:'soda', department:'bar', turnoverCents:amount, commissionBaseCents:amount});
const inputs = (early) => ({
  scheme, periodFrom:from, periodTo:to, monthClosed:false,
  coverage:{kind:'month_to_date_complete',from,through:to,complete:true,watermark:'sales'},
  attendanceCoverage:{kind:'approved_attendance_complete',from,through:to,complete:true,watermark:'times'},
  employees:[{id:'a'},{id:'b'}],
  roleAssignments:['a','b'].map((employeeId,i)=>({employeeId,roleId:i?'floor':'bar',effectiveFrom:from,effectiveTo:end})),
  attendance:[{id:'shift',employeeId:'a',date:from,approved:true,workedMinutes:240,plannedMinutes:480}],
  sales:[sale('1','a',from,early?30000:10000),sale('2','b',from,8000)]
});
const pay = (r,id) => r.employees.find(e=>e.employeeId===id).amountCents;
for (const early of [false,true]) {
  const input=inputs(early);
  const first=calculatePayrollH1FixedShifts(input);
  assert.equal(first.status,'ready',JSON.stringify(first.blockers));
  assert.equal(pay(first,'a'),5001,'half shift rounds once; no monthly or product commission');
  assert.equal(pay(first,'b'),800,'ordinary rate of the other role is already known');
  assert.ok(calculatePayrollScheme(input).blockers.includes('closed_month_required'));
  const closed={...input,periodTo:end,monthClosed:true,
    coverage:{...input.coverage,kind:'month_closed_complete',through:end},
    attendanceCoverage:{...input.attendanceCoverage,through:end},sales:[...input.sales,sale('3','a',end,20000)]};
  const full=calculatePayrollScheme(closed);
  assert.equal(full.status,'ready',JSON.stringify(full.blockers));
  const remainder=pay(full,'a')-pay(first,'a');
  assert.equal(remainder,(early?50000:30000)*0.35,'final commission includes both halves of the month');
  assert.ok(calculatePayrollH1FixedShifts(closed).blockers.includes('payroll_h1_period_required'));
}
const base=inputs(true);
assert.ok(calculatePayrollH1FixedShifts({...base,periodTo:'2026-09-13'}).blockers.includes('payroll_h1_period_required'));
assert.ok(calculatePayrollH1FixedShifts({...base,attendanceCoverage:null}).blockers.includes('attendance_coverage_manifest_required'));
const capped=calculatePayrollH1FixedShifts({...base,scheme:{...scheme,roleParameters:{...scheme.roleParameters,
  bar:{...monthly,cap:{basis:'employee_department_day',department:'bar',rateBps:1000}}}}});
assert.equal(capped.status,'ready',JSON.stringify(capped.blockers));
assert.equal(pay(capped,'a'),3000,'the same daily cap applies to fixed shift money');
const personal = calculatePayrollH1FixedShifts({...base,scheme:{
  ...scheme,roleParameters:{...scheme.roleParameters,bar:{...monthly,mode:'stable_percent',stableRateBps:1000}},
  employeeOverrides:[{employeeId:'a',path:'mode',mode:'override',value:'final_month_threshold',effectiveFrom:from,effectiveTo:to}]
}});
assert.equal(personal.status,'ready',JSON.stringify(personal.blockers));
assert.equal(pay(personal,'a'),5001,'dated personal terms defer the commission on this shift');
const milestone = calculatePayrollH1FixedShifts({...base,scheme:{...scheme,roleParameters:{
  ...scheme.roleParameters,bar:{...monthly,applyMilestones:true,milestoneBonusesCents:{20000:750}}
}}});
assert.equal(milestone.status,'ready',JSON.stringify(milestone.blockers));
assert.equal(pay(milestone,'a'),5001,'crossing the bonus threshold before day 14 does not pay out the monthly bonus early');
for (const mode of ['stable_percent', 'progressive_daily']) {
  const withMonthlyBonus = {
    ...base, scheme: { ...scheme, itemRules: [], roleParameters: { ...scheme.roleParameters,
      bar: { ...monthly, mode, stableRateBps: 1000, bracketRatesBps: {0:1000},
        applyMilestones: true, milestoneBonusesCents: {20000:750} }
    }}
  };
  const interim = calculatePayrollH1FixedShifts(withMonthlyBonus);
  assert.equal(interim.status, 'ready', JSON.stringify(interim.blockers));
  assert.equal(pay(interim, 'a'), 8001, 'daily commission and fixed shift remain available');
  const final = calculatePayrollScheme({...withMonthlyBonus, periodTo:end, monthClosed:true,
    coverage:{...base.coverage,kind:'month_closed_complete',through:end},
    attendanceCoverage:{...base.attendanceCoverage,through:end}});
  assert.equal(final.status, 'ready', JSON.stringify(final.blockers));
  assert.equal(pay(final, 'a') - pay(interim, 'a'), 750, 'month-end reconciliation includes the milestone once');
}
// On September 10 this employee switches from a known 10% rate to a month-end rate.
const switched = {
  ...base,
  scheme: {
    ...scheme, itemRules: [],
    roleParameters: { ...scheme.roleParameters, bar: { ...monthly, mode: 'stable_percent', stableRateBps: 1000 } },
    employeeOverrides: [{ employeeId: 'a', path: 'mode', mode: 'override', value: 'final_month_threshold',
      effectiveFrom: '2026-09-10', effectiveTo: end }]
  },
  sales: [sale('before', 'a', '2026-09-09', 30000), sale('after', 'a', '2026-09-10', 20000)],
  attendance: ['2026-09-09', '2026-09-10'].map(date => ({
    id: 'shift-' + date, employeeId: 'a', date, approved: true, workedMinutes: 480, plannedMinutes: 480
  }))
};
const firstAfterSwitch = calculatePayrollH1FixedShifts(switched);
assert.equal(firstAfterSwitch.status, 'ready', JSON.stringify(firstAfterSwitch.blockers));
assert.equal(pay(firstAfterSwitch, 'a'), 23002, 'two fixed shifts plus the earned 10% for September 9');
const monthAfterSwitch = calculatePayrollScheme({
  ...switched, periodTo: end, monthClosed: true,
  coverage: { ...switched.coverage, kind: 'month_closed_complete', through: end },
  attendanceCoverage: { ...switched.attendanceCoverage, through: end }
});
assert.equal(monthAfterSwitch.status, 'ready', JSON.stringify(monthAfterSwitch.blockers));
assert.equal(pay(monthAfterSwitch, 'a') - pay(firstAfterSwitch, 'a'), 3000,
  'only the deferred 15% on the sale after the switch remains');
const unsupported = calculatePayrollH1FixedShifts({...base,sales:[]});
assert.ok(unsupported.criticalErrors.some(e=>e.code==='employee_daily_pay_exceeds_personal_revenue'));
// In Yekaterinburg, the 15th begins at 19:00 UTC on the 14th.
const midMonth = makePayrollRefundAwareFixture('final_month_threshold', { noRefunds: true });
midMonth.runId = randomUUID();
midMonth.scheme.roleParameters.bar.perShiftCents = 1000;
midMonth.period.to = '2026-10-14';
midMonth.periodClosure.period = { ...midMonth.period };
midMonth.approvedAttendanceSource.attendanceCoverage.through = midMonth.period.to;
Object.assign(midMonth.approvedAttendanceSource.sourceAttendanceApproval, {
  periodTo: midMonth.period.to, approvedAt: '2026-10-14T18:59:00.000Z'
});
midMonth.recognitionEvidence.manifest = buildPayrollRecognitionManifest(midMonth.recognitionEvidence.facts,
  { ...payrollRefundEconomicFixtureOptions, to: midMonth.period.to });
Object.assign(midMonth.periodClosure, { transactionTimestamp: '2026-10-14T18:59:59Z', venueLocalDate: '2026-10-14' });
assert.equal(buildPayrollH1FixedShiftsRunProvenance(midMonth).status, 'blocked');
Object.assign(midMonth.periodClosure, { transactionTimestamp: '2026-10-14T19:00:00Z', venueLocalDate: '2026-10-15' });
const availableOnFifteenth = buildPayrollH1FixedShiftsRunProvenance(midMonth);
assert.equal(availableOnFifteenth.status, 'verified_h1_fixed_shifts_evidence');
assert.equal(availableOnFifteenth.provenance.total_amount_cents, 1000);
console.log('PASS H1 shifts, early/late monthly threshold, dated roles, product commission deferral, cap, evidence and closed-month residual');
