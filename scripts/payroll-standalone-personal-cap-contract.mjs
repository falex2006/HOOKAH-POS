import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {calculatePayrollScheme:calculate,validatePersonalScalarAssignments:validate}=require('../payroll-schemes');
const {collectPersonalCapIncreases:collect}=require('../payroll-personal-cap-policy');
const employee='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const day='2026-10-01';
const definition=()=>({id:'s',versionId:'v',mode:'stable_percent',currency:'RUB',effectiveFrom:day,effectiveTo:day,
  roleParameters:{bar:{perShiftCents:10000,stableRateBps:1000}},
  roleAssignments:[{employeeId:employee,roleId:'bar',effectiveFrom:day,effectiveTo:day}],
  employeeOverrides:[{employeeId:employee,path:'cap.rateBps',mode:'override',value:2500,effectiveFrom:day,effectiveTo:day},
    {employeeId:employee,path:'cap.basis',mode:'override',value:'venue_day',effectiveFrom:day,effectiveTo:day}],itemRules:[]});
const input=scheme=>({scheme,roleAssignments:scheme.roleAssignments,periodFrom:day,periodTo:day,employees:[{id:employee}],
  attendance:[{id:'shift',employeeId:employee,date:day,approved:true,workedMinutes:60,plannedMinutes:60}],
  sales:[{id:'line',employeeId:employee,date:day,department:'bar',turnoverCents:20000,commissionBaseCents:20000}],
  coverage:{kind:'month_to_date_complete',from:day,through:day,complete:true,watermark:'scenario'},
  attendanceCoverage:{kind:'approved_attendance_complete',from:day,through:day,complete:true,watermark:'scenario'}});
const cases=[
 ['personal cap without role cap',()=>{const scheme=definition(),before=structuredClone(scheme);const r=calculate(input(scheme));assert.equal(r.status,'ready',JSON.stringify(r.blockers));assert.equal(r.employees[0].amountCents,5000);assert.equal(r.employees[0].capReductionCents,7000);assert.deepEqual(scheme,before);}],
 ['new restriction creates no higher-role acknowledgement',()=>assert.deepEqual(collect(definition()),[])],
 ['explicit zero is a real cap',()=>{const scheme=definition();scheme.employeeOverrides[0].value=0;const r=calculate(input(scheme));assert.equal(r.status,'ready',JSON.stringify(r.blockers));assert.equal(r.employees[0].amountCents,0);}],
 ['inherit both returns absence rather than zero',()=>{const scheme=definition();for(const row of scheme.employeeOverrides){row.mode='inherit';delete row.value;}const r=calculate(input(scheme));assert.equal(r.status,'ready');assert.equal(r.employees[0].amountCents,12000);assert.deepEqual(collect(scheme),[]);}],
 ['incomplete personal cap remains blocked',()=>{const scheme=definition();scheme.employeeOverrides[1].mode='inherit';delete scheme.employeeOverrides[1].value;assert.ok(calculate(input(scheme)).blockers.includes('invalid_personal_cap'));}],
 ['department cap uses explicit existing role department',()=>{const scheme=definition();scheme.roleParameters.bar.department='bar';scheme.employeeOverrides[1].value='employee_department_day';const r=calculate(input(scheme));assert.equal(r.status,'ready',JSON.stringify(r.blockers));assert.equal(r.employees[0].amountCents,5000);}],
 ['department cap without department remains blocked',()=>{const scheme=definition();scheme.employeeOverrides[1].value='employee_department_day';assert.ok(calculate(input(scheme)).blockers.includes('cap_department_required'));}],
 ['damaged existing role cap is not uncapped',()=>{const scheme=definition();scheme.roleParameters.bar.cap={};assert.throws(()=>collect(scheme));}],
 ['role change creates higher-cap audit only for capped role',()=>{const scheme=definition();scheme.effectiveTo='2026-10-02';scheme.roleParameters.capped={perShiftCents:10000,stableRateBps:1000,cap:{rateBps:2000,basis:'venue_day'}};
   scheme.roleAssignments.push({employeeId:employee,roleId:'capped',effectiveFrom:'2026-10-02',effectiveTo:'2026-10-02'});
   for(const row of scheme.employeeOverrides)row.effectiveTo='2026-10-02';
   assert.deepEqual(collect(scheme),[{employeeId:employee,roleId:'capped',path:'cap.rateBps',effectiveFrom:'2026-10-02',effectiveTo:'2026-10-02',roleRateBps:2000,personalRateBps:2500}]);}],
 ['personal cap with premium requires an explicit policy',()=>{const scheme=definition();scheme.roleParameters.bar.applyMilestones=true;scheme.roleParameters.bar.milestoneBonusesCents={20000:1000};assert.ok(calculate(input(scheme)).blockers.includes('milestone_cap_policy_required'));}],
 ['premium is included in the new personal cap',()=>{const scheme=definition();scheme.roleParameters.bar.applyMilestones=true;scheme.roleParameters.bar.milestoneBonusesCents={20000:1000};scheme.milestoneCapPolicy='included_in_cap';const r=calculate(input(scheme));assert.equal(r.status,'ready',JSON.stringify(r.blockers));assert.equal(r.employees[0].amountCents,5000);}],
 ['separate premium remains outside the new personal cap',()=>{const scheme=definition();scheme.roleParameters.bar.applyMilestones=true;scheme.roleParameters.bar.milestoneBonusesCents={20000:1000};scheme.milestoneCapPolicy='separate_from_shift_cap';const r=calculate(input(scheme));assert.equal(r.status,'ready',JSON.stringify(r.blockers));assert.equal(r.employees[0].amountCents,6000);}]
];
cases.push(
 ['basis only is incomplete',()=>{const scheme=definition();scheme.employeeOverrides.shift();assert.ok(validate(scheme,scheme.roleAssignments).includes('invalid_personal_cap'));}],
 ['expiry outside preview leaves incomplete cap',()=>{const scheme=definition();scheme.effectiveTo='2026-10-03';scheme.roleAssignments[0].effectiveTo=scheme.effectiveTo;scheme.employeeOverrides[0].effectiveTo=scheme.effectiveTo;
   assert.equal(calculate(input(scheme)).status,'ready');assert.ok(validate(scheme,scheme.roleAssignments).includes('invalid_personal_cap'));}],
 ['unequal starts reject incomplete first segment',()=>{const scheme=definition();scheme.effectiveTo='2026-10-03';scheme.roleAssignments[0].effectiveTo=scheme.effectiveTo;for(const row of scheme.employeeOverrides)row.effectiveTo=scheme.effectiveTo;scheme.employeeOverrides[1].effectiveFrom='2026-10-02';assert.ok(validate(scheme,scheme.roleAssignments).includes('invalid_personal_cap'));}],
 ['same expiry restores absent cap',()=>{const scheme=definition();scheme.effectiveTo='2026-10-03';scheme.roleAssignments[0].effectiveTo=scheme.effectiveTo;assert.deepEqual(validate(scheme,scheme.roleAssignments),[]);}]
);
const failures=[];
for(const [name,test] of cases){try{test();console.log('PASS '+name);}catch(error){failures.push(name);console.error('FAIL '+name+': '+error.message);}}
assert.deepEqual(failures,[],'standalone personal cap needs complete explicit leaves; scenario proof only');
console.log('PAYROLL STANDALONE PERSONAL CAP: PASS (no implicit zero baseline, independent cents, inherit, no mutation)');
