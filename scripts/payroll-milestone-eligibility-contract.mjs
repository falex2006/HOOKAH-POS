import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const {calculatePayrollScheme:calculate,validateScheme}=createRequire(import.meta.url)('../payroll-schemes.js');
const fixture=()=>({scheme:{id:'s',versionId:'v',mode:'stable_percent',applyMilestones:true,roleParameters:{bar:{perShiftCents:0,stableRateBps:0,milestoneBonusesCents:{10000:100,15000:200}}}},
 periodFrom:'2026-10-01',periodTo:'2026-10-03',employees:[{id:'a'},{id:'b'}],roleAssignments:[{employeeId:'a',roleId:'bar',effectiveFrom:'2026-10-01'},{employeeId:'b',roleId:'bar',effectiveFrom:'2026-10-01'}],
 attendance:[{id:'shift-a',employeeId:'a',date:'2026-10-01',approved:true,workedMinutes:60,plannedMinutes:60},{id:'shift-b',employeeId:'b',date:'2026-10-02',approved:true,workedMinutes:60,plannedMinutes:60}],
 sales:[{id:'sale-a',employeeId:'a',date:'2026-10-01',department:'bar',turnoverCents:10000,commissionBaseCents:10000},{id:'sale-b',employeeId:'b',date:'2026-10-01',department:'bar',turnoverCents:10000,commissionBaseCents:10000}],
 coverage:{kind:'month_to_date_complete',from:'2026-10-01',through:'2026-10-03',complete:true,watermark:'scenario'},attendanceCoverage:{kind:'approved_attendance_complete',from:'2026-10-01',through:'2026-10-03',complete:true,watermark:'scenario'}});
const legacy=calculate(fixture());assert.equal(legacy.status,'ready');assert.equal(legacy.employees.find(row=>row.employeeId==='b').milestoneBonusCents,300);
assert.ok(legacy.daily.every(day=>!Object.hasOwn(day,'milestoneDecisions')),'omitted setting leaves legacy shape');
const explicit=fixture();explicit.scheme.milestoneEligibility='all_active';
const explicitResult=calculate(explicit);const stripped=structuredClone(explicitResult);stripped.daily.forEach(day=>delete day.milestoneDecisions);assert.deepEqual(stripped,legacy);
const worked=fixture();worked.scheme.milestoneEligibility='worked_on_threshold_day';const result=calculate(worked);
assert.equal(result.status,'ready');assert.equal(result.employees.find(row=>row.employeeId==='a').milestoneBonusCents,300);
assert.equal(result.employees.find(row=>row.employeeId==='b').milestoneBonusCents,0);
assert.equal(result.daily[0].milestoneDecisions.length,4);assert.equal(result.daily[1].milestoneDecisions.length,0,'no catch-up on next worked day');
assert.deepEqual(result.daily[0].milestoneDecisions[0].qualifyingShiftIds,['shift-a']);
assert.equal(result.daily[0].milestoneDecisions.find(row=>row.employeeId==='b').reason,'no_approved_positive_work_on_threshold_day');
const role=structuredClone(worked);role.scheme.roleParameters.bar.milestoneEligibility='all_active';assert.equal(calculate(role).employees.find(row=>row.employeeId==='b').milestoneBonusCents,300);
role.scheme.employeeOverrides=[{employeeId:'b',path:'milestoneEligibility',mode:'override',value:'worked_on_threshold_day'}];assert.equal(calculate(role).employees.find(row=>row.employeeId==='b').milestoneBonusCents,0);
role.scheme.employeeOverrides[0].mode='inherit';delete role.scheme.employeeOverrides[0].value;assert.equal(calculate(role).employees.find(row=>row.employeeId==='b').milestoneBonusCents,300);
const zero=structuredClone(worked);zero.attendance[0].workedMinutes=0;assert.equal(calculate(zero).employees.find(row=>row.employeeId==='a').milestoneBonusCents,0);
const off=structuredClone(worked);off.scheme.applyMilestones=false;assert.equal(calculate(off).daily[0].milestoneDecisions[0].reason,'milestones_disabled');
for (const bonuses of [{ '9007199254740992': 100 }, { '10000': 100, '010000': 200 }, { '1e4': 100 }]) {
  const badBonus = structuredClone(worked); badBonus.scheme.roleParameters.bar.milestoneBonusesCents = bonuses;
  assert.ok(validateScheme(badBonus.scheme).includes('invalid_milestone_bonuses'));
  assert.equal(calculate(badBonus).status, 'blocked');
}
const roleOff=structuredClone(worked);roleOff.scheme.applyMilestones=true;roleOff.scheme.roleParameters.bar.applyMilestones=false;
assert.equal(calculate(roleOff).employees.find(row=>row.employeeId==='a').milestoneBonusCents,0,'explicit role false overrides scheme true');
roleOff.scheme.employeeOverrides=[{employeeId:'a',path:'applyMilestones',mode:'override',value:true}];
assert.equal(calculate(roleOff).employees.find(row=>row.employeeId==='a').milestoneBonusCents,300,'personal true overrides role false');
roleOff.scheme.employeeOverrides[0].mode='inherit';delete roleOff.scheme.employeeOverrides[0].value;
assert.equal(calculate(roleOff).employees.find(row=>row.employeeId==='a').milestoneBonusCents,0,'personal inheritance uses explicit role false');
delete roleOff.scheme.roleParameters.bar.applyMilestones;
assert.equal(calculate(roleOff).employees.find(row=>row.employeeId==='a').milestoneBonusCents,300,'cleared role setting inherits scheme true');
const cappedSwitch = structuredClone(worked);
cappedSwitch.scheme.applyMilestones = false;
cappedSwitch.scheme.roleParameters.bar.applyMilestones = true;
cappedSwitch.scheme.roleParameters.bar.cap = { rateBps: 3000, basis: 'venue_day' };
delete cappedSwitch.scheme.milestoneCapPolicy;
assert.ok(validateScheme(cappedSwitch.scheme).includes('milestone_cap_policy_required'), 'role true outranks scheme false for cap policy');
cappedSwitch.scheme.applyMilestones = true; cappedSwitch.scheme.roleParameters.bar.applyMilestones = false;
assert.ok(!validateScheme(cappedSwitch.scheme).includes('milestone_cap_policy_required'), 'disabled role does not require unused milestone cap policy');
cappedSwitch.scheme.employeeOverrides = [{ employeeId: 'a', path: 'applyMilestones', mode: 'override', value: true }];
assert.ok(calculate(cappedSwitch).blockers.includes('milestone_cap_policy_required'), 'personal dated activation requires explicit cap policy before calculation');
cappedSwitch.scheme.milestoneCapPolicy = 'included_in_cap';
assert.equal(calculate(cappedSwitch).status, 'ready');
const percent=structuredClone(worked);percent.scheme.mode='percent_only';delete percent.scheme.roleParameters.bar.perShiftCents;
assert.equal(calculate(percent).employees.find(row=>row.employeeId==='a').milestoneBonusCents,300,'percent-only uses attendance even though base wages have no shifts');
const noSales=structuredClone(worked);noSales.sales=noSales.sales.filter(row=>row.employeeId!=='a');const noSalesResult=calculate(noSales);
assert.equal(noSalesResult.daily[0].milestoneDecisions.find(row=>row.employeeId==='a').awardedAmountCents,100,'approved work earns milestone independent of sales; existing revenue guard still applies');
assert.equal(noSalesResult.payoutEligible,false);
const dated=structuredClone(role);dated.scheme.employeeOverrides=[{employeeId:'b',path:'milestoneEligibility',mode:'override',value:'worked_on_threshold_day',effectiveFrom:'2026-10-02'}];
assert.equal(calculate(dated).employees.find(row=>row.employeeId==='b').milestoneBonusCents,300,'later policy override never changes prior crossing');
const inactive=structuredClone(worked);inactive.employees.push({id:'c',activeFrom:'2026-10-02'});inactive.roleAssignments.push({employeeId:'c',roleId:'bar',effectiveFrom:'2026-10-01'});
assert.equal(calculate(inactive).daily[0].milestoneDecisions.find(row=>row.employeeId==='c').reason,'employee_inactive');
const later=structuredClone(worked);later.periodFrom='2026-10-02';assert.ok(calculate(later).daily.every(day=>day.milestoneDecisions.length===0),'crossing before requested period never repeated');
for(const bad of [null,'worked',false,{},1]){const input=fixture();input.scheme.milestoneEligibility=bad;assert.ok(validateScheme(input.scheme).includes('invalid_milestone_eligibility'));
 delete input.scheme.milestoneEligibility;input.scheme.roleParameters.bar.milestoneEligibility=bad;assert.equal(calculate(input).status,'blocked');
 delete input.scheme.roleParameters.bar.milestoneEligibility;input.scheme.employeeOverrides=[{employeeId:'a',path:'milestoneEligibility',mode:'override',value:bad}];assert.ok(validateScheme(input.scheme).includes('invalid_employee_override_value'));}
for(const policy of ['included_in_cap','separate_from_shift_cap']){const input=structuredClone(worked);input.scheme.milestoneCapPolicy=policy;input.scheme.roleParameters.bar.cap={basis:'employee_department_day',department:'bar',rateBps:1};
 const row=calculate(input).daily[0].employees.find(row=>row.employeeId==='a');assert.equal(row.amountCents,policy==='included_in_cap'?1:300);assert.equal(row.milestoneBonusCents,300);}
const guard=structuredClone(worked);guard.scheme.roleParameters.bar.milestoneBonusesCents={10000:20000};assert.equal(calculate(guard).payoutEligible,false,'own revenue ceiling unchanged');
const shuffled=structuredClone(worked);shuffled.employees.reverse();shuffled.sales.reverse();shuffled.attendance.reverse();assert.deepEqual(calculate(shuffled),result);
console.log('PAYROLL MILESTONE ELIGIBILITY: PASS (legacy parity, precedence, approved work, no catchup, explanation, caps and ceiling)');
