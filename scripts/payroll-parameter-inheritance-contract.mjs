import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {calculatePayrollScheme:calculate}=createRequire(import.meta.url)('../payroll-schemes.js');
const date=n=>`2026-10-0${n}`;
const fixture=(mode,params,next=params)=>({scheme:{id:'s',versionId:'v',currency:'RUB',mode,
 roleParameters:{r:structuredClone(params),next:structuredClone(next)},employeeOverrides:[],itemRules:[]},
 periodFrom:date(1),periodTo:date(4),employees:[{id:'a'},{id:'b'}],
 roleAssignments:[{employeeId:'a',roleId:'r',effectiveFrom:date(1),effectiveTo:date(3)},
 {employeeId:'a',roleId:'next',effectiveFrom:date(4)},{employeeId:'b',roleId:'r',effectiveFrom:date(1)}],
 attendance:[1,2,3,4].flatMap(n=>['a','b'].map(employeeId=>({id:`shift-${employeeId}-${n}`,employeeId,date:date(n),approved:true,workedMinutes:60,plannedMinutes:60}))),
 sales:[1,2,3,4].flatMap(n=>['a','b'].map(employeeId=>({id:`line-${employeeId}-${n}`,employeeId,date:date(n),menuItemId:'x',department:'bar',turnoverCents:20000,commissionBaseCents:20000,
 costSnapshot:{id:'cost',version:'v1',currency:'RUB',costCents:5000}}))),
 coverage:{kind:'month_to_date_complete',from:date(1),through:date(4),complete:true,watermark:'scenario'},
 attendanceCoverage:{kind:'approved_attendance_complete',from:date(1),through:date(4),complete:true,watermark:'scenario'}});
const run=input=>{const result=calculate(input);assert.equal(result.status,'ready',JSON.stringify(result.blockers));return result;};
const rows=(result,id='a')=>result.daily.map(day=>day.employees.find(row=>row.employeeId===id));
let cases=0;
const leaf=(name,input,path,value,field,expected,zero)=>{
 const baseline=run(input),before=structuredClone(input);
 input.scheme.employeeOverrides=[{employeeId:'a',path,mode:'override',value,effectiveFrom:date(2),effectiveTo:date(2)}];
 const actual=run(input);assert.equal(rows(actual)[1][field],expected,name);
 assert.deepEqual(rows(actual,'b'),rows(baseline,'b'),name+' other employee');
 for(const n of [0,2,3])assert.deepEqual(rows(actual)[n],rows(baseline)[n],name+' outside inclusive window/current role');
 for(const key of ['basePayCents','commissionCents','milestoneBonusCents','teamFundCents'])if(key!==field)assert.equal(rows(actual)[1][key],rows(baseline)[1][key],name+' sibling '+key);
 input.scheme.employeeOverrides[0].mode='inherit';delete input.scheme.employeeOverrides[0].value;
 assert.deepEqual(run(input),baseline,name+' explicit inherit');
 if(zero!==undefined){input.scheme.employeeOverrides[0].mode='override';input.scheme.employeeOverrides[0].value=zero.value;
  assert.equal(rows(run(input))[1][field],zero.expected,name+' zero/false');}
 assert.deepEqual({...input,scheme:{...input.scheme,employeeOverrides:[]}},before,name+' input preservation');cases++;
};
const stable={perShiftCents:100,stableRateBps:1000};
leaf('wage',fixture('stable_percent',stable,{...stable,perShiftCents:300}),'perShiftCents',200,'basePayCents',200,{value:0,expected:0});
leaf('stable rate',fixture('stable_percent',stable,{...stable,stableRateBps:3000}),'stableRateBps',2000,'commissionCents',4000,{value:0,expected:0});
leaf('percent-only rate',fixture('percent_only',stable,{...stable,stableRateBps:3000}),'stableRateBps',2000,'commissionCents',4000,{value:0,expected:0});
const progressive={perShiftCents:100,bracketRatesBps:{0:1000,30000:2000}};
leaf('bracket',fixture('progressive_daily',progressive,{...progressive,bracketRatesBps:{0:1000,30000:3000}}),'bracketRatesBps.30000',2500,'commissionCents',5000,{value:0,expected:0});
const final=fixture('final_month_threshold',progressive);final.periodTo='2026-10-31';final.monthClosed=true;final.coverage={...final.coverage,kind:'month_closed_complete',through:'2026-10-31'};final.attendanceCoverage.through='2026-10-31';
leaf('final-month bracket',final,'bracketRatesBps.30000',2500,'commissionCents',5000,{value:0,expected:0});
const target={perShiftCents:100,targetCents:10000,baseRateBps:1000,bonusRateBps:3000,excessRatePolicy:'replace_base'};
for(const mode of ['personal_target','margin_target']){
 const p=mode==='margin_target'?{...target,lossPolicy:'offset_daily_losses',itemRuleBasis:'net_revenue'}:target;
 const margin=mode==='margin_target';
 leaf(mode+' target',fixture(mode,p,{...p,targetCents:5000}),'targetCents',5000,'commissionCents',margin?3500:5000,{value:0,expected:margin?4500:6000});
 leaf(mode+' base',fixture(mode,p,{...p,baseRateBps:2000}),'baseRateBps',2000,'commissionCents',margin?3500:5000,{value:0,expected:margin?1500:3000});
 leaf(mode+' bonus',fixture(mode,p,{...p,bonusRateBps:4000}),'bonusRateBps',4000,'commissionCents',margin?3000:5000,{value:0,expected:1000});
 leaf(mode+' excess',fixture(mode,p,{...p,excessRatePolicy:'add_to_base'}),'excessRatePolicy','add_to_base','commissionCents',margin?3000:5000);
 if(margin)for(const [path,value] of [['lossPolicy','offset_daily_losses'],['itemRuleBasis','net_revenue']])leaf(path,fixture(mode,p),path,value,'commissionCents',2500);
}
const capped={...stable,cap:{rateBps:1000,basis:'venue_day',department:'bar'}};
leaf('cap rate',fixture('stable_percent',capped,{...capped,cap:{...capped.cap,rateBps:2000}}),'cap.rateBps',100,'amountCents',400,{value:0,expected:0});
leaf('cap basis',fixture('stable_percent',capped),'cap.basis','employee_department_day','amountCents',2000);
const bonus={...progressive,milestoneBonusesCents:{80000:100},applyMilestones:true};
leaf('bonus',fixture('progressive_daily',bonus),'milestoneBonusesCents.80000',200,'milestoneBonusCents',200,{value:0,expected:0});
leaf('milestone flag',fixture('progressive_daily',bonus),'applyMilestones',false,'milestoneBonusCents',0,{value:false,expected:0});
// Pool weights deliberately affect peers: verify the complete independently known distribution.
const team={perShiftCents:100,teamWeight:1,teamFund:{poolId:'p',targetCents:10000,baseRateBps:1000,bonusRateBps:1000,excessRatePolicy:'replace_base',departments:['bar'],distributionPolicy:'configured_weights'}};
const ti=fixture('team_fund',team,{...team,teamWeight:3});
for(const [value,shares] of [[3,[3000,1000]],[0,[0,4000]]]){
 ti.scheme.employeeOverrides=[{employeeId:'a',path:'teamWeight',mode:'override',value,effectiveFrom:date(2),effectiveTo:date(2)}];
 const r=run(ti);assert.deepEqual(r.daily[1].employees.map(row=>row.teamFundCents),shares);
 assert.deepEqual(r.daily[0].employees.map(row=>row.teamFundCents),[2000,2000]);
 assert.deepEqual(r.daily[2].employees.map(row=>row.teamFundCents),[2000,2000]);
 assert.deepEqual(r.daily[3].employees.map(row=>row.teamFundCents),[3000,1000]);
}
ti.scheme.employeeOverrides[0].mode='inherit';delete ti.scheme.employeeOverrides[0].value;assert.deepEqual(run(ti).daily[1].employees.map(row=>row.teamFundCents),[2000,2000]);cases++;
// Mode and milestone flag are separately inherited parameters, preserving the established role default.
for(const [roleMode,personalMode,expected] of [['stable_percent','progressive_daily',0],['progressive_daily','stable_percent',100]]){
 const p={perShiftCents:100,stableRateBps:1000,bracketRatesBps:{0:1000},milestoneBonusesCents:{80000:100}};
 const input=fixture(roleMode,p);input.scheme.employeeOverrides=[{employeeId:'a',path:'mode',mode:'override',value:personalMode}];
 assert.equal(rows(run(input))[1].milestoneBonusCents,expected);
 input.scheme.employeeOverrides.push({employeeId:'a',path:'applyMilestones',mode:'override',value:expected===0});
 assert.equal(rows(run(input))[1].milestoneBonusCents,expected===0?100:0);cases++;
}
const unsupported=fixture('stable_percent',capped);unsupported.scheme.employeeOverrides=[{employeeId:'a',path:'cap.department',mode:'override',value:'kitchen'}];
assert.equal(calculate(unsupported).status,'blocked');
const across=fixture('stable_percent',stable,{perShiftCents:300,stableRateBps:3000});
across.scheme.employeeOverrides=[{employeeId:'a',path:'stableRateBps',mode:'override',value:2000,effectiveFrom:date(2),effectiveTo:date(4)}];
assert.deepEqual(rows(run(across)).map(row=>[row.basePayCents,row.commissionCents]),[[100,2000],[100,4000],[100,4000],[300,4000]]);
across.scheme.employeeOverrides[0].mode='inherit';delete across.scheme.employeeOverrides[0].value;
assert.deepEqual(rows(run(across)).map(row=>row.commissionCents),[2000,2000,2000,6000]);cases++;
console.log(`PAYROLL PARAMETER INHERITANCE: PASS (${cases} independent leaf/mode cases; scenario math only, no official source or persistence proof)`);
