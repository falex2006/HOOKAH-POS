import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const {calculatePayrollScheme:calculate,CALCULATOR_INPUT_CAPABILITIES:capabilities}=createRequire(import.meta.url)('../payroll-schemes');
const fixture=()=>({scheme:{id:'s',versionId:'v',currency:'RUB',mode:'stable_percent',roleParameters:{bar:{perShiftCents:0,stableRateBps:1000}},employeeOverrides:[],itemRules:[]},
 periodFrom:'2026-10-01',periodTo:'2026-10-02',employees:[{id:'a'}],roleAssignments:[{employeeId:'a',roleId:'bar',effectiveFrom:'2026-10-01'}],attendance:[],
 coverage:{kind:'month_to_date_complete',from:'2026-10-01',through:'2026-10-02',complete:true,watermark:'scenario'},
 attendanceCoverage:{kind:'approved_attendance_complete',from:'2026-10-01',through:'2026-10-02',complete:true,watermark:'scenario'},
 sales:[{id:'sale',employeeId:'a',menuItemId:'p',department:'bar',date:'2026-10-01',turnoverCents:10000,commissionBaseCents:5000}],
 personalRevenueSource:{schemaVersion:1,policyCode:'employee_attributed_merchandise_net_v1',currency:'RUB',period:{from:'2026-10-01',to:'2026-10-02'},sourceWatermark:'a'.repeat(64),coverage:{complete:true},daily:[{employeeId:'a',date:'2026-10-01',netRevenueCents:10000}]}});
const input=fixture(),result=calculate(input);assert.equal(result.status,'ready');assert.equal(result.employees[0].personalRevenueCents,10000);assert.equal(result.employees[0].amountCents,500);
const legacy=fixture();delete legacy.personalRevenueSource;assert.deepEqual(calculate(legacy),result,'explicit input preserves correct legacy scenario amounts');
const reject=mutate=>{const v=fixture();mutate(v);assert.equal(calculate(v).status,'blocked','invalid explicit source must never fallback');};
reject(v=>v.personalRevenueSource=null);reject(v=>v.personalRevenueSource.status='incomplete');reject(v=>v.personalRevenueSource.coverage.complete=false);
reject(v=>v.personalRevenueSource.currency='USD');reject(v=>v.personalRevenueSource.period.to='2026-10-03');
reject(v=>v.personalRevenueSource.sourceWatermark='bad');reject(v=>v.personalRevenueSource.policyCode='other');
reject(v=>v.personalRevenueSource.daily[0].netRevenueCents=9999);reject(v=>v.personalRevenueSource.daily=[]);
reject(v=>v.personalRevenueSource.daily.push({...v.personalRevenueSource.daily[0]}));
reject(v=>v.personalRevenueSource.daily[0].employeeId='unknown');reject(v=>v.personalRevenueSource.daily[0].date='2026-02-30');
reject(v=>v.personalRevenueSource.daily[0].date='2026-10-03');reject(v=>v.employees[0].activeFrom='2026-10-02');
for(const value of [-1,0.5,Number.MAX_SAFE_INTEGER+1,'10000',NaN])reject(v=>v.personalRevenueSource.daily[0].netRevenueCents=value);
const overflow=fixture();overflow.sales[0].turnoverCents=Number.MAX_SAFE_INTEGER;overflow.sales.push({...overflow.sales[0],id:'second'});overflow.personalRevenueSource.daily[0].netRevenueCents=Number.MAX_SAFE_INTEGER;assert.equal(calculate(overflow).status,'blocked');
const frozen=fixture();const deepFreeze=x=>{if(x&&typeof x==='object'){Object.values(x).forEach(deepFreeze);Object.freeze(x);}return x;};assert.deepEqual(calculate(deepFreeze(frozen)),result);
const zeros=fixture();zeros.personalRevenueSource.daily.push({employeeId:'a',date:'2026-10-02',netRevenueCents:0});assert.deepEqual(calculate(zeros),result);
const empty=fixture();empty.sales=[];empty.personalRevenueSource.daily=[];assert.equal(calculate(empty).status,'ready');
const fixed=fixture();fixed.scheme.roleParameters.bar.perShiftCents=11000;fixed.attendance=[{id:'shift',employeeId:'a',date:'2026-10-01',approved:true,workedMinutes:480,plannedMinutes:480}];
const capped=calculate(fixed);assert.equal(capped.payoutEligible,false);assert.ok(capped.criticalErrors.some(x=>x.code==='employee_daily_pay_exceeds_personal_revenue'));assert.equal(capped.employees[0].amountCents,11500,'fixed pay is not silently cut');
const milestone=fixture();milestone.scheme.mode='progressive_daily';milestone.scheme.brackets=[0,10000];milestone.scheme.milestoneThresholds=[10000];milestone.scheme.applyMilestones=true;milestone.scheme.roleParameters.bar={perShiftCents:0,bracketRatesBps:{0:0,10000:0},milestoneBonusesCents:{10000:11000}};
const bonus=calculate(milestone);assert.equal(bonus.status,'ready',JSON.stringify(bonus.blockers));assert.equal(bonus.payoutEligible,false);assert.ok(bonus.criticalErrors.some(x=>x.code==='employee_daily_pay_exceeds_personal_revenue'));
assert.equal(capabilities.explicitNoRefundEmployeeNetRevenue,true);assert.equal(capabilities.fullEmployeeNetRevenue,false);assert.equal(capabilities.signedRefundAdjustments,false);
console.log('PASS payroll-personal-revenue-input-contract');
