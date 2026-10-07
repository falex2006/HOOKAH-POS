import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const {calculatePayrollScheme:calculate,validateScheme}=createRequire(import.meta.url)('../payroll-schemes.js');
const fixture=()=>({scheme:{id:'s',versionId:'v',mode:'progressive_daily',roleParameters:{bar:{perShiftCents:0,bracketRatesBps:{0:1000}}},employeeOverrides:[],itemRules:[]},
  employees:[{id:'a'},{id:'b'}],roleAssignments:['a','b'].map(employeeId=>({employeeId,roleId:'bar',effectiveFrom:'2026-10-01'})),attendance:[],
  periodFrom:'2026-10-01',periodTo:'2026-10-02',coverage:{kind:'month_to_date_complete',from:'2026-10-01',through:'2026-10-02',complete:true,watermark:'scenario'},
  attendanceCoverage:{kind:'approved_attendance_complete',from:'2026-10-01',through:'2026-10-02',complete:true,watermark:'scenario'},
  sales:[{id:'l1',employeeId:'a',date:'2026-10-01',department:'bar',turnoverCents:10000,commissionBaseCents:10000},
    {id:'l2',employeeId:'b',date:'2026-10-02',department:'bar',turnoverCents:10000,commissionBaseCents:10000}]});
const leaf=(path,value,extra={})=>({employeeId:'a',path,mode:'override',value,...extra});
const input=fixture();input.scheme.employeeOverrides=[leaf('bracketRatesBps.5000',2000),leaf('milestoneBonusesCents.5000',300)];
const result=calculate(input);assert.equal(result.status,'ready',JSON.stringify(result.blockers));
assert.equal(result.employees.find(row=>row.employeeId==='a').commissionCents,2000);
assert.equal(result.employees.find(row=>row.employeeId==='a').milestoneBonusCents,300);
assert.equal(result.employees.find(row=>row.employeeId==='b').commissionCents,1000);
assert.deepEqual(calculate({...input,scheme:{...input.scheme,employeeOverrides:[...input.scheme.employeeOverrides].reverse()}}),result);
const zero=fixture();zero.scheme.employeeOverrides=[leaf('bracketRatesBps.5000',0),leaf('milestoneBonusesCents.5000',0)];
assert.equal(calculate(zero).employees.find(row=>row.employeeId==='a').amountCents,0);
const inherit=structuredClone(input);inherit.scheme.employeeOverrides=inherit.scheme.employeeOverrides.map(({value,...row})=>({...row,mode:'inherit'}));
assert.equal(calculate(inherit).employees.find(row=>row.employeeId==='a').amountCents,1000);
const late=fixture();late.scheme.employeeOverrides=[leaf('milestoneBonusesCents.5000',300,{effectiveFrom:'2026-10-02'})];
assert.equal(calculate(late).employees.find(row=>row.employeeId==='a').milestoneBonusCents,0,'no catch-up after threshold already crossed');
for(const path of ['milestoneBonusesCents.0','milestoneBonusesCents.9007199254740992','bracketRatesBps.9007199254740992']) {
 const bad=fixture();bad.scheme.employeeOverrides=[leaf(path,0)];assert.notEqual(calculate(bad).status,'ready',path);
}
for(const path of ['milestoneBonusesCents.05000','bracketRatesBps.05000']) {
 const bad=fixture();bad.scheme.employeeOverrides=[leaf(path,0)];assert.notEqual(calculate(bad).status,'ready','new noncanonical path');
}
const alias=fixture();alias.scheme.roleParameters.bar.milestoneBonusesCents={'05000':100};alias.scheme.employeeOverrides=[leaf('milestoneBonusesCents.5000',200)];
assert.notEqual(calculate(alias).status,'ready','personal alias must not double-count role threshold');
const legacy=fixture();legacy.scheme.roleParameters.bar.bracketRatesBps={'0':1000,'00':2000};
assert.equal(calculate(legacy).status,'ready','unmodified legacy bracket aliases preserve prior acceptance');
const existingLegacy=fixture();existingLegacy.scheme.roleParameters.bar.milestoneBonusesCents={'05000':100};existingLegacy.scheme.employeeOverrides=[leaf('milestoneBonusesCents.05000',0)];
assert.equal(calculate(existingLegacy).status,'ready','exact existing legacy key stays compatible');
const cap=fixture();cap.scheme.roleParameters.bar.cap={rateBps:3000,basis:'venue_day'};cap.scheme.employeeOverrides=[leaf('milestoneBonusesCents.5000',100)];
assert.ok(calculate(cap).blockers.includes('milestone_cap_policy_required'));
for(const policy of ['included_in_cap','separate_from_shift_cap']) {cap.scheme.milestoneCapPolicy=policy;assert.equal(calculate(cap).status,'ready');}
const personalScalar=fixture();personalScalar.scheme.employeeOverrides=[leaf('targetCents',0)];assert.equal(calculate(personalScalar).status,'ready','allowed unused personal scalar need not exist at role');
const missing=fixture();missing.scheme.employeeOverrides=[leaf('cap.rateBps',0)];assert.ok(calculate(missing).blockers.includes('invalid_personal_cap'),'a new personal cap requires both rate and basis');
assert.deepEqual(validateScheme(input.scheme),[]);
console.log('PAYROLL PERSONAL THRESHOLD: PASS (new leaves, independent employee, inherited siblings, zero/inherit, dates/no catchup, aliases and cap gates)');

