import assert from 'node:assert/strict';
import payroll from '../payroll-schemes.js';

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
const unsupported = calculatePayrollH1FixedShifts({...base,sales:[]});
assert.ok(unsupported.criticalErrors.some(e=>e.code==='employee_daily_pay_exceeds_personal_revenue'));
console.log('PASS H1 shifts, early/late monthly threshold, dated roles, product commission deferral, cap, evidence and closed-month residual');
