import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url),{calculatePayrollScheme:calculate}=require('../payroll-schemes.js');
const {normalizePayrollMilestoneEvidence:normalize}=require('../payroll-milestone-evidence.js');
const fixture=()=>({scheme:{id:'s',versionId:'v',mode:'stable_percent',applyMilestones:true,milestoneEligibility:'worked_on_threshold_day',roleParameters:{bar:{perShiftCents:0,stableRateBps:0,milestoneBonusesCents:{10000:100,15000:200}}}},
 periodFrom:'2026-10-01',periodTo:'2026-10-02',employees:[{id:'a'},{id:'b'},{id:'c'}],roleAssignments:['a','b','c'].map(employeeId=>({employeeId,roleId:'bar',effectiveFrom:'2026-10-01'})),
 attendance:[{id:'shift-a',employeeId:'a',date:'2026-10-01',approved:true,workedMinutes:60,plannedMinutes:60}],
 sales:['a','b'].map(employeeId=>({id:`sale-${employeeId}`,employeeId,date:'2026-10-01',department:'bar',turnoverCents:10000,commissionBaseCents:10000})),
 coverage:{kind:'month_to_date_complete',from:'2026-10-01',through:'2026-10-02',complete:true,watermark:'scenario'},attendanceCoverage:{kind:'approved_attendance_complete',from:'2026-10-01',through:'2026-10-02',complete:true,watermark:'scenario'}});
const input=fixture(),result=calculate(input),context={attendance:input.attendance};assert.equal(result.status,'ready');
const normalized=normalize(result,context);assert.equal(normalized[0].milestoneDecisions.length,6);
assert.ok(!result.daily[0].employees.some(row=>row.employeeId==='c'),'rejected decision may have no payout row');
const original=structuredClone(result);normalized[0].milestoneDecisions[0].qualifyingShiftIds.push('tamper');assert.deepEqual(result,original,'normalized result detached');
const reject=(change,expected)=>{const changed=structuredClone(result);change(changed);assert.throws(()=>normalize(changed,context),error=>error.code===`payroll_milestone_evidence_${expected}`);};
reject(r=>r.daily[0].milestoneDecisions[0].eligible=false,'eligibility_gate_mismatch');
reject(r=>r.daily[0].milestoneDecisions[0].reason='disabled','reason_mismatch');
reject(r=>r.daily[0].milestoneDecisions[0].thresholdCents=30000,'crossing_invalid');
reject(r=>r.daily[0].milestoneDecisions[0].previousTurnoverCents=1,'previous_turnover_mismatch');
reject(r=>r.daily[0].milestoneDecisions[0].cumulativeTurnoverCents=1,'cumulative_turnover_mismatch');
reject(r=>r.daily[0].milestoneDecisions[0].approvedWorkedMinutes=61,'worked_minutes_mismatch');
reject(r=>r.daily[0].milestoneDecisions[0].qualifyingShiftIds=['forged'],'attendance_set_mismatch');
reject(r=>r.daily[0].milestoneDecisions[0].qualifyingShiftIds=['shift-a','shift-a'],'qualifying_shifts_invalid');
reject(r=>r.daily[0].milestoneDecisions[0].awardedAmountCents=99,'award_mismatch');
reject(r=>r.daily[0].milestoneDecisions.push(structuredClone(r.daily[0].milestoneDecisions[0])),'decision_duplicate');
reject(r=>r.daily[0].milestoneDecisions[0].date='2026-02-30','date_invalid');
reject(r=>r.daily[0].milestoneDecisions[0].employeeId={id:'a'},'id_invalid');
reject(r=>r.daily[0].milestoneDecisions[0].applyMilestones=1,'boolean_invalid');
reject(r=>r.daily[0].milestoneDecisions[0].eligibility=null,'eligibility_invalid');
reject(r=>r.daily[0].milestoneDecisions[0].extra=true,'decision_shape_invalid');
reject(r=>delete r.daily[1].milestoneDecisions,'day_invalid');
reject(r=>r.daily[0].employees.find(row=>row.employeeId==='a').milestoneBonusCents=301,'daily_bonus_mismatch');
reject(r=>r.daily[0].employees.find(row=>row.employeeId==='a').shiftDetails[0].workedMinutes=61,'wage_attendance_mismatch');
reject(r=>{for(const decision of r.daily[0].milestoneDecisions.filter(row=>row.employeeId==='a')){decision.declaredBonusCents=Number.MAX_SAFE_INTEGER;decision.awardedAmountCents=Number.MAX_SAFE_INTEGER;}},'sum_overflow');
reject(r=>r.employees.find(row=>row.employeeId==='a').milestoneBonusCents=301,'period_bonus_mismatch');
reject(r=>r.daily[1].cumulativeVenueTurnoverCents++,'turnover_continuity');
// Coherent monetary tamper: changing the declared work gate and all payouts
// cannot conceal a missing approved positive shift in the separate context.
reject(r=>{for(const decision of r.daily[0].milestoneDecisions.filter(row=>row.employeeId==='b')){decision.eligible=true;decision.reason='eligible';decision.awardedAmountCents=decision.declaredBonusCents;decision.approvedWorkedMinutes=60;decision.qualifyingShiftIds=['shift-a'];}
 r.daily[0].employees.find(row=>row.employeeId==='b').milestoneBonusCents=300;r.employees.find(row=>row.employeeId==='b').milestoneBonusCents=300;},'attendance_set_mismatch');
assert.throws(()=>normalize(result),error=>error.code==='payroll_milestone_evidence_attendance_context_required');
const percent=fixture();percent.scheme.mode='percent_only';delete percent.scheme.roleParameters.bar.perShiftCents;const percentResult=calculate(percent);
assert.equal(normalize(percentResult,{attendance:percent.attendance})[0].milestoneDecisions[0].approvedWorkedMinutes,60);
assert.throws(()=>normalize(percentResult),error=>error.code==='payroll_milestone_evidence_attendance_context_required');
const fallback=fixture();fallback.employees=fallback.employees.slice(0,2);fallback.roleAssignments=fallback.roleAssignments.slice(0,2);
assert.ok(normalize(calculate(fallback)),'ordinary wage shifts provide declared arithmetic evidence when every decision has a payout row');
const all=fixture();all.scheme.milestoneEligibility='all_active';all.employees=all.employees.slice(0,2);all.roleAssignments=all.roleAssignments.slice(0,2);assert.equal(normalize(calculate(all),{attendance:all.attendance})[0].milestoneDecisions.find(row=>row.employeeId==='b').awardedAmountCents,100);
const legacy=fixture();delete legacy.scheme.milestoneEligibility;assert.equal(normalize(calculate(legacy)),undefined);
const first=fixture();first.periodFrom='2026-10-02';first.sales[0].date='2026-10-02';first.attendance[0].date='2026-10-02';
assert.equal(normalize(calculate(first),{attendance:first.attendance})[0].milestoneDecisions[0].previousTurnoverCents,10000,'first prior cumulative is declared and arithmetic checked, not independently attested');
const nullContext={attendance:null};assert.throws(()=>normalize(result,nullContext),error=>error.code==='payroll_milestone_evidence_attendance_invalid');
const getter=structuredClone(result);Object.defineProperty(getter.daily[0].milestoneDecisions[0],'employeeId',{get(){throw new Error('getter must not execute');},enumerable:true});assert.throws(()=>normalize(getter,context),error=>error.code==='payroll_milestone_evidence_object_invalid');
console.log('PAYROLL MILESTONE EVIDENCE: PASS (exact typed replay, independent attendance, rejected recipients, coherent tampering, legacy and detachment)');
