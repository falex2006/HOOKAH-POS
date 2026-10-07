import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { calculatePayrollScheme: calculate } = createRequire(import.meta.url)('../payroll-schemes.js');
const fixture = () => ({
  scheme:{id:'s',versionId:'v',mode:'stable_percent',roleParameters:{
    stable:{perShiftCents:0,stableRateBps:1000},
    target:{mode:'personal_target',perShiftCents:0,targetCents:10000,baseRateBps:1000,bonusRateBps:2000,excessRatePolicy:'replace_base'}
  },employeeOverrides:[{employeeId:'a',path:'targetCents',mode:'override',value:0,effectiveFrom:'2026-10-02',effectiveTo:'2026-10-02'}],itemRules:[]},
  periodFrom:'2026-10-01',periodTo:'2026-10-02',employees:[{id:'a'}],
  roleAssignments:[{employeeId:'a',roleId:'stable',effectiveFrom:'2026-10-01',effectiveTo:'2026-10-01'},
    {employeeId:'a',roleId:'target',effectiveFrom:'2026-10-02',effectiveTo:'2026-10-02'}],attendance:[],
  coverage:{kind:'month_to_date_complete',from:'2026-10-01',through:'2026-10-02',complete:true,watermark:'scenario'},
  attendanceCoverage:{kind:'approved_attendance_complete',from:'2026-10-01',through:'2026-10-02',complete:true,watermark:'scenario'},
  sales:[1,2].map(day=>({id:`line-${day}`,employeeId:'a',date:`2026-10-0${day}`,department:'bar',turnoverCents:10000,commissionBaseCents:10000}))
});
const result=calculate(fixture());
assert.equal(result.status,'ready',JSON.stringify(result.blockers));
assert.equal(result.employees[0].commissionCents,3000,'stable inherited 10% then dated personal target zero uses 20%');
const wrongWindow=fixture(); wrongWindow.scheme.employeeOverrides[0].effectiveFrom='2026-10-01';
assert.equal(calculate(wrongWindow).status,'ready','explicit typed target leaf may exist personally before a target role starts');
assert.equal(calculate(wrongWindow).employees[0].commissionCents,3000,'unused target leaf does not change stable day mathematics');
const outside=fixture(); outside.scheme.employeeOverrides[0].effectiveFrom='2026-11-01'; outside.scheme.employeeOverrides[0].effectiveTo='2026-11-02';
assert.equal(calculate(outside).status,'ready','future override is not applied to present roles');
const historical=fixture(); historical.roleAssignments.unshift({employeeId:'a',roleId:'stable',effectiveFrom:'2026-09-01',effectiveTo:'2026-09-30'});
assert.equal(calculate(historical).status,'ready','historical assignment does not invalidate later personal override');
console.log('PAYROLL DATED OVERRIDE ROLE: PASS (role change, zero, applicable missing path, future and historical windows)');
