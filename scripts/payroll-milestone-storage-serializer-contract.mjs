import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url), {calculatePayrollScheme:calculate}=require('../payroll-schemes.js');
const {mapPayrollMilestoneStorageRows:map}=require('../payroll-milestone-storage-serializer.js');
const id=n=>`aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12,'0')}`;
const fixture=(mode='stable_percent')=>{
 const role={perShiftCents:0,stableRateBps:1000,targetCents:10000,baseRateBps:1600,bonusRateBps:4800,excessRatePolicy:'replace_base',milestoneBonusesCents:{10000:100}};
 if(mode==='margin_target')Object.assign(role,{lossPolicy:'offset_daily_losses',itemRuleBasis:'net_revenue'});
 if(mode==='team_fund')Object.assign(role,{teamWeight:1,teamFund:{poolId:'bar',departments:['bar'],distributionPolicy:'configured_weights',targetCents:10000,baseRateBps:1600,bonusRateBps:4800,excessRatePolicy:'replace_base'}});
 const attendance=[{id:id(9),employeeId:id(3),date:'2026-10-01',approved:true,workedMinutes:60,plannedMinutes:60}];
 const costSnapshot={id:'net-cost',version:'v1',currency:'RUB',costCents:5000};
 const scenario={scheme:{id:'s',versionId:'v',currency:'RUB',mode,applyMilestones:true,milestoneEligibility:'worked_on_threshold_day',roleParameters:{bar:role}},periodFrom:'2026-10-01',periodTo:'2026-10-02',employees:[{id:id(3)},{id:id(8)}],attendance,
  roleAssignments:[3,8].map(n=>({employeeId:id(n),roleId:'bar',effectiveFrom:'2026-10-01'})),sales:[{id:id(5),employeeId:id(3),menuItemId:id(6),department:'bar',date:'2026-10-01',turnoverCents:20000,commissionBaseCents:20000,...(mode==='margin_target'?{costSnapshot}:{})}],
  coverage:{kind:'month_to_date_complete',from:'2026-10-01',through:'2026-10-02',complete:true,watermark:'scenario'},attendanceCoverage:{kind:'approved_attendance_complete',from:'2026-10-01',through:'2026-10-02',complete:true,watermark:'scenario'}};
 // Attendance-only recipient c is deliberately absent from financial output.
 if(mode==='team_fund')scenario.scheme.employeeOverrides=[{employeeId:id(8),path:'teamWeight',mode:'override',value:0}];
 return {scenario,venueId:id(1),runId:id(2),venueTimezone:'Asia/Yekaterinburg',employees:[{id:id(3),name:'A'},{id:id(8),name:'Rejected'}],attendance,
  attendanceApprovalId:id(10),sourceAttendanceApproval:{approvalId:id(10),revision:1,sourceWatermark:'a'.repeat(64),approvedByName:'Owner',approvedAt:'2026-10-03T12:00:00.000Z',periodFrom:'2026-10-01',periodTo:'2026-10-02'},
  result:calculate(scenario),sourceLines:[{id:id(5),orderId:id(4),orderItemId:id(5),employeeId:id(3),menuItemId:id(6),menuItemName:'Tea',department:'bar',roleId:'bar',localDate:'2026-10-01',soldAt:'2026-10-01T12:00:00Z',quantity:'1',grossCents:20000,discountCents:0,refundCents:0,commissionBaseCents:20000,turnoverCents:20000,...(mode==='margin_target'?{costSnapshot}:{})}]};
};
for(const mode of ['stable_percent','percent_only','personal_target','margin_target','team_fund']){
 const input=fixture(mode),before=structuredClone(input),dto=map(input);assert.deepEqual(input,before);
 assert.equal(dto.milestoneEvidenceVersion,1);assert.equal(dto.daySnapshots.length,2);assert.equal(dto.decisionSnapshots.length,2);
 assert.equal(dto.daySnapshots[1].decision_count,0);assert.equal(dto.daySnapshots[1].awarded_total,'0.00');assert.equal(dto.daySnapshots[1].previous_venue_turnover,'200.00');
 const rejected=dto.decisionSnapshots.find(row=>row.employee_id===id(8));assert.equal(rejected.awarded_amount,'0.00');assert.equal(rejected.employee_name_snapshot,'Rejected');assert.equal(rejected.day_snapshot_id,undefined);
 const award=dto.decisionSnapshots.find(row=>row.employee_id===id(3));assert.equal(award.awarded_amount,'1.00');assert.deepEqual(award.qualifying_shift_ids,[id(9)]);
 assert.equal(award.dayKey,dto.daySnapshots[0].key);assert.equal(dto.daySnapshots[0].attendance_approval_id,id(10));
 award.qualifying_shift_ids.push(id(99));assert.deepEqual(input,before,'DTO array detached');
}
const data=fixture();assert.equal(data.result.daily[0].employees.some(row=>row.employeeId===id(8)),false,'rejected recipient needs no fake employee snapshot');
const reject=(mutate,code)=>{const input=structuredClone(data);mutate(input);assert.throws(()=>map(input),error=>code?error.code===code:typeof error.code==='string');};
reject(input=>input.sourceAttendanceApproval.approvalId=id(11),'payroll_milestone_storage_approval_identity_mismatch');
reject(input=>delete input.attendanceApprovalId,'payroll_milestone_storage_uuid_invalid');
reject(input=>input.sourceAttendanceApproval.periodFrom='2026-10-02','payroll_milestone_storage_approval_period_mismatch');
reject(input=>input.sourceAttendanceApproval.periodTo='2026-10-01','payroll_milestone_storage_approval_period_mismatch');
reject(input=>input.sourceAttendanceApproval.timezone='UTC','payroll_milestone_storage_approval_timezone_mismatch');
reject(input=>input.sourceAttendanceApproval.venueId=id(20),'payroll_milestone_storage_approval_venue_mismatch');
reject(input=>input.attendanceCoverage={kind:'approved_attendance_complete',complete:true,from:'2026-10-01',through:'2026-10-02',watermark:'forged'},'payroll_milestone_storage_approval_coverage_mismatch');
reject(input=>input.sourceAttendanceApproval.periodTo='2026-02-30','payroll_milestone_storage_date_invalid');
reject(input=>input.employees=input.employees.slice(0,1),'payroll_source_employee_context_mismatch');
reject(input=>input.result.daily[0].milestoneDecisions.find(row=>row.employeeId===id(8)).employeeId=id(8).toUpperCase(),'payroll_source_milestone_employee_context_mismatch');
reject(input=>{input.attendance[0].id=id(9).toUpperCase();input.result.daily[0].employees[0].shiftDetails[0].shiftId=id(9).toUpperCase();input.result.daily[0].milestoneDecisions[0].qualifyingShiftIds=[id(9).toUpperCase()];},'payroll_milestone_storage_uuid_invalid');
reject(input=>{input.attendance[0].plannedMinutes=1441;input.result.daily[0].employees[0].shiftDetails[0].plannedMinutes=1441;},'payroll_milestone_storage_attendance_minutes_invalid');
reject(input=>input.result.daily[0].milestoneDecisions[0].awardedAmountCents=101,'payroll_milestone_evidence_award_mismatch');
reject(input=>delete input.attendance);
const legacy=fixture();delete legacy.scenario.scheme.milestoneEligibility;legacy.result=calculate(legacy.scenario); // all_active legacy needs revenue for both employees
legacy.scenario.employees=legacy.scenario.employees.slice(0,1);legacy.scenario.roleAssignments=legacy.scenario.roleAssignments.slice(0,1);legacy.result=calculate(legacy.scenario);
assert.deepEqual(map(legacy),{milestoneEvidenceVersion:0,daySnapshots:[],decisionSnapshots:[]});
const mixed=fixture('personal_target');mixed.scenario.scheme.roleParameters.scalar={perShiftCents:0,stableRateBps:0,mode:'stable_percent',milestoneBonusesCents:{10000:100}};
mixed.scenario.roleAssignments[1].roleId='scalar';mixed.result=calculate(mixed.scenario);assert.equal(map(mixed).decisionSnapshots.find(row=>row.employee_id===id(8)).role_key_snapshot,'scalar');
const coverage=fixture();coverage.attendanceCoverage={kind:'approved_attendance_complete',complete:true,from:'2026-10-01',through:'2026-10-02',watermark:coverage.sourceAttendanceApproval.sourceWatermark};assert.equal(map(coverage).milestoneEvidenceVersion,1);
console.log('PAYROLL MILESTONE STORAGE SERIALIZER: PASS (five modes, empty days, no-payout recipients, lineage, canonical IDs, legacy and detached DTO)');
