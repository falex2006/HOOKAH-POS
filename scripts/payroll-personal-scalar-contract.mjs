import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { calculatePayrollScheme: calculate, validatePersonalScalarAssignments } = createRequire(import.meta.url)('../payroll-schemes.js');
const date = n => `2026-10-0${n}`;
const fixture = (mode, params) => ({
  scheme: { id:'s', versionId:'v', currency:'RUB', mode,
    roleParameters:{r:structuredClone(params)}, employeeOverrides:[], itemRules:[] },
  periodFrom:date(1), periodTo:date(3), employees:[{id:'a'},{id:'b'}],
  roleAssignments:['a','b'].map(employeeId => ({employeeId,roleId:'r',effectiveFrom:date(1)})),
  attendance:[1,2,3].flatMap(n => ['a','b'].map(employeeId => ({id:`shift-${employeeId}-${n}`,employeeId,date:date(n),approved:true,workedMinutes:60,plannedMinutes:60}))),
  sales:[1,2,3].flatMap(n => ['a','b'].map(employeeId => ({id:`line-${employeeId}-${n}`,employeeId,date:date(n),menuItemId:'x',department:'bar',turnoverCents:20000,commissionBaseCents:20000,
    costSnapshot:{id:`cost-${employeeId}-${n}`,version:'v1',currency:'RUB',costCents:5000}}))),
  coverage:{kind:'month_to_date_complete',from:date(1),through:date(3),complete:true,watermark:'scenario'},
  attendanceCoverage:{kind:'approved_attendance_complete',from:date(1),through:date(3),complete:true,watermark:'scenario'}
});
const ready = input => {const r=calculate(input);assert.equal(r.status,'ready',JSON.stringify(r.blockers));return r;};
const employeeDay = (r,n,id='a') => r.daily[n-1].employees.find(row=>row.employeeId===id);
const cases = [];
const check = (name, mode, params, leaves, expected, zeroExpected) => cases.push([name, () => {
  const input=fixture(mode,params), baseline=ready(input), baseRole=structuredClone(input.scheme.roleParameters);
  input.scheme.employeeOverrides=Object.entries(leaves).map(([path,value])=>({employeeId:'a',path,mode:'override',value,effectiveFrom:date(2),effectiveTo:date(2)}));
  const frozen=structuredClone(input), result=ready(input);
  const row=employeeDay(result,2);
  assert.deepEqual([row.basePayCents,row.commissionCents,row.amountCents],expected,'independent cents expectation');
  for(const n of [1,3])assert.deepEqual(employeeDay(result,n),employeeDay(baseline,n),'inclusive personal window');
  for(const n of [1,2,3])assert.deepEqual(employeeDay(result,n,'b'),employeeDay(baseline,n,'b'),'other employee unaffected');
  assert.deepEqual(input,frozen,'calculator does not mutate any input');
  assert.deepEqual(input.scheme.roleParameters,baseRole,'missing personal leaves never materialize in role');
  input.scheme.employeeOverrides.reverse();assert.deepEqual(ready(input),result,'override order independence');
  if(zeroExpected){for(const item of input.scheme.employeeOverrides)if(typeof item.value==='number')item.value=0;
    const z=employeeDay(ready(input),2);assert.deepEqual([z.basePayCents,z.commissionCents,z.amountCents],zeroExpected,'explicit zero is not absence');}
  for(const item of input.scheme.employeeOverrides){item.mode='inherit';delete item.value;}
  assert.deepEqual(ready(input),baseline,'inherit restores original mode and absent role leaves');
}]);
check('stable → complete personal target', 'stable_percent',{perShiftCents:0,stableRateBps:1000},
  {mode:'personal_target',targetCents:10000,baseRateBps:1000,bonusRateBps:2000,excessRatePolicy:'replace_base'},[0,3000,3000],[0,0,0]);
check('percent-only → stable with new wage', 'percent_only',{stableRateBps:1000},
  {mode:'stable_percent',perShiftCents:500,stableRateBps:2000},[500,4000,4500],[0,0,0]);
check('progressive → stable with missing rate', 'progressive_daily',{perShiftCents:100,bracketRatesBps:{0:1000},applyMilestones:false},
  {mode:'stable_percent',stableRateBps:2000},[100,4000,4100],[100,0,100]);
check('stable → complete margin target', 'stable_percent',{perShiftCents:0,stableRateBps:1000},
  {mode:'margin_target',targetCents:10000,baseRateBps:1000,bonusRateBps:2000,excessRatePolicy:'replace_base',lossPolicy:'offset_daily_losses',itemRuleBasis:'net_revenue'},[0,2000,2000],[0,0,0]);
cases.push(['inherit missing leaf leaves required mode incomplete',()=>{
  const input=fixture('stable_percent',{perShiftCents:0,stableRateBps:1000});
  input.scheme.employeeOverrides=Object.entries({mode:'personal_target',targetCents:10000,baseRateBps:1000,bonusRateBps:2000,excessRatePolicy:'replace_base'})
    .map(([path,value])=>({employeeId:'a',path,mode:'override',value,effectiveFrom:date(2),effectiveTo:date(2)}));
  ready(input);
  const item=input.scheme.employeeOverrides.find(row=>row.path==='targetCents');item.mode='inherit';delete item.value;
  const result=calculate(input);assert.equal(result.status,'blocked');assert.ok(result.blockers.includes('invalid_targetCents'));
}]);
const failures=[];
const dated=fixture('stable_percent',{perShiftCents:0,stableRateBps:1000});
dated.scheme.employeeOverrides=Object.entries({mode:'personal_target',targetCents:0,baseRateBps:0,bonusRateBps:0,excessRatePolicy:'replace_base'})
  .map(([path,value])=>({employeeId:'a',path,mode:'override',value,effectiveFrom:date(2),effectiveTo:date(3)}));
assert.deepEqual(validatePersonalScalarAssignments(dated.scheme,dated.roleAssignments),[],'complete effective mode across segment boundaries');
dated.scheme.employeeOverrides.find(row=>row.path==='targetCents').effectiveTo=date(2);
assert.ok(validatePersonalScalarAssignments(dated.scheme,dated.roleAssignments).includes('invalid_targetCents'),'inclusive leaf end exposes incomplete next segment even outside preview');
dated.scheme.employeeOverrides.find(row=>row.path==='targetCents').effectiveTo=date(3);
dated.scheme.roleParameters.next={mode:'personal_target',perShiftCents:0,targetCents:10000,baseRateBps:1000,bonusRateBps:2000,excessRatePolicy:'replace_base'};
dated.roleAssignments=[{employeeId:'a',roleId:'r',effectiveFrom:date(1),effectiveTo:date(2)},{employeeId:'a',roleId:'next',effectiveFrom:date(3)},dated.roleAssignments[1]];
assert.deepEqual(validatePersonalScalarAssignments(dated.scheme,dated.roleAssignments),[],'personal zero survives role change');
for(const [name,test] of cases){try{test();console.log(`PASS ${name}`);}catch(error){failures.push(name);console.error(`FAIL ${name}: ${error.message}`);}}
assert.deepEqual(failures,[], 'personal scalar creation must work; scenario arithmetic only, no official source or persistence proof');
console.log(`PAYROLL PERSONAL SCALAR: PASS (${cases.length} scenarios; missing-role leaves, dated zero/inherit and no mutation)`);
