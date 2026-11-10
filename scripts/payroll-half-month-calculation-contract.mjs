import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { makePayrollRefundAwareFixture, payrollRefundAwareModes } from './payroll-refund-aware-calculation-contract.mjs';

const require = createRequire(import.meta.url);
const { buildPayrollHalfMonthCalculation: build, verifyPayrollHalfMonthCalculationCandidate: verify } =
  require('../payroll-half-month-calculation');
const { buildPayrollRecognitionManifest } = require('../payroll-recognition-manifest');
const clone = value => structuredClone(value);
let checks = 0;
const eq = (actual, expected, label) => { assert.deepEqual(actual, expected, label); checks++; };
const check = (value, label) => { assert.ok(value, label); checks++; };
const month = '2026-10';

// Use the actual producer fixture, move its immutable sale to the second half,
// and rebuild its recognition manifest with the canonical producer.
function secondHalfFixture(mode = 'progressive_daily', noRefunds = false) {
  const args = makePayrollRefundAwareFixture(mode, { noRefunds, modify(source) {
    const facts = source.recognitionEvidence.facts;
    const soldAt = '2026-10-16T09:00:00.000000Z', recognizedAt = '2026-10-16T10:00:00.000000Z';
    facts.saleEvents[0].recognized_at = facts.saleEvents[0].source_closed_at = recognizedAt;
    facts.saleEvents[0].recognized_local_date = '2026-10-16';
    facts.saleLines[0].sold_at = soldAt;
    facts.saleLines[0].attribution_captured_at = recognizedAt;
    facts.orders[0].closed_at = recognizedAt;
    facts.orders[0].pricing_locked_at = soldAt;
    facts.pricingHeaders[0].transaction_at = soldAt;
    facts.pricingLines[0].sold_at = soldAt;
    source.recognitionEvidence.manifest = buildPayrollRecognitionManifest(facts,
      { venueId: source.venueId, currency: source.scheme.currency, from: '2026-10-01', to: '2026-10-31' });
    for (const row of source.approvedAttendanceSource.attendance) row.date = '2026-10-16';
    if (mode === 'progressive_daily') source.scheme.roleParameters.bar.bracketRatesBps = { 0: 1000, 9000: 2000 };
  } });
  return args;
}

for (const mode of payrollRefundAwareModes) {
  const args = secondHalfFixture(mode);
  const before = clone(args), candidate = build(args);
  eq(args, before, `${mode}: source args immutable`);
  if (mode === 'final_month_threshold') {
    eq(candidate.status, 'blocked');
    check(candidate.reasons.includes('payroll_half_month_final_month_threshold_requires_advance_policy'));
    eq([candidate.officialReady, candidate.payoutEligible, candidate.settlementAuthorized, candidate.persistence],
      [false, false, false, 'none']);
    continue;
  }
  eq(candidate.status, 'second_half_forecast', `${mode}: ${candidate.reasons}`);
  eq([candidate.earningPeriod, candidate.basisPeriod], [
    { from: '2026-10-15', to: '2026-10-31' }, { from: '2026-10-01', to: '2026-10-31' }
  ]);
  eq([candidate.officialReady, candidate.payoutEligible, candidate.sourceAttested, candidate.persistence,
    candidate.candidateOnly, candidate.settlementAuthorized, candidate.milestoneClaimRequired],
  [false, false, false, 'none', true, false, true]);
  check(candidate.input.sales.every(row => row.date >= '2026-10-15' && row.date <= '2026-10-31'), `${mode}: sales sliced`);
  eq([candidate.input.coverage.from, candidate.input.coverage.through], ['2026-10-01', '2026-10-31']);
  eq(candidate.input.venueDailyTurnover.length, 31, `${mode}: full monthly turnover context retained`);
  check(candidate.input.personalRevenueSource.daily.every(row => row.date >= '2026-10-15'), `${mode}: personal revenue sliced`);
  if (candidate.input.attendanceCoverage) eq(candidate.input.attendanceCoverage.from, '2026-10-01', `${mode}: approved attendance coverage retained`);
  check(candidate.engineResult.daily.every(row => row.date >= '2026-10-15'), `${mode}: no first-half output`);
  check(verify(candidate, args), `${mode}: independent source rebuild matches`);
  eq(candidate.sourceWatermarks.recognition, candidate.input.sourceEvidence.recognitionManifest.sourceWatermark, `${mode}: recognition hash is actual manifest identity`);
  const altered = clone(candidate);
  altered.input.periodFrom = '2026-10-14';
  check(!verify(altered, args), `${mode}: earning-window tamper rejected`);
}

{
  const refundedArgs = secondHalfFixture('progressive_daily');
  const refunded = build(refundedArgs);
  const noRefundArgs = secondHalfFixture('progressive_daily', true);
  const noRefund = build(noRefundArgs);
  eq(refunded.status, 'second_half_forecast');
  eq(noRefund.status, 'second_half_forecast');
  eq(refunded.input.venueDailyTurnover.find(row => row.date === '2026-10-16').turnoverCents, 8200,
    'late refund adjusts original sale-date turnover inside monthly basis');
  eq(noRefund.input.venueDailyTurnover.find(row => row.date === '2026-10-16').turnoverCents, 10700,
    'no-refund case retains canonical turnover');
  check(refunded.parentCalculationWatermark !== noRefund.parentCalculationWatermark,
    'full-month source hash binds refund history');
  const daily = refunded.engineResult.daily.find(row => row.date === '2026-10-16');
  check(daily, 'second-half sale produces an earning-day row');
  check(daily.lines[0].appliedRateBps === 1000,
    'progressive rate uses cumulative monthly turnover rather than resetting on the 15th');
  check(refunded.engineResult.daily.every(row => row.date !== '2026-10-10'), 'first-half sale is not paid again');
}

{
  const args = secondHalfFixture('percent_only');
  const candidate = build(args);
  const changed = clone(args);
  changed.recognitionEvidence.facts.saleEvents[0].recognized_local_date = '2026-10-15';
  changed.recognitionEvidence.manifest = buildPayrollRecognitionManifest(changed.recognitionEvidence.facts,
    { venueId: changed.venueId, currency: changed.scheme.currency, from: '2026-10-01', to: '2026-10-31' });
  const changedCandidate = build(changed);
  eq(candidate.status, 'second_half_forecast');
  check(changedCandidate.status === 'blocked' || changedCandidate.parentCalculationWatermark !== candidate.parentCalculationWatermark,
    'changed source context cannot reuse the prior monthly calculation hash');
}

{
  const args = secondHalfFixture('progressive_daily');
  args.period = { from: '2026-10-15', to: '2026-10-31' };
  const candidate = build(args);
  eq(candidate.status, 'blocked', 'adapter refuses a half-period masquerading as monthly source context');
  eq(candidate.settlementAuthorized, false);
  const nullCandidate = build(null);
  eq(nullCandidate.status, 'blocked', 'null input is fail-closed');
  eq(nullCandidate.settlementAuthorized, false, 'even blocked input cannot imply settlement authority');
}

{
  const {buildPayrollDeferredMonthSettlement: settle} = require('../payroll-half-month-calculation');
  const args = makePayrollRefundAwareFixture('final_month_threshold', {noRefunds: true, twoEmployees: true});
  const facts = args.recognitionEvidence.facts;
  const soldAt = '2026-10-16T09:00:00.000000Z', closedAt = '2026-10-16T10:00:00.000000Z';
  Object.assign(facts.saleEvents[1], {recognized_at: closedAt, source_closed_at: closedAt, recognized_local_date: '2026-10-16'});
  Object.assign(facts.saleLines[1], {sold_at: soldAt, attribution_captured_at: closedAt});
  Object.assign(facts.orders[1], {closed_at: closedAt, pricing_locked_at: soldAt});
  facts.pricingHeaders[1].transaction_at = soldAt;
  facts.pricingLines[1].sold_at = soldAt;
  args.recognitionEvidence.manifest = buildPayrollRecognitionManifest(facts,
    {venueId: args.venueId, currency: 'RUB', ...args.period});
  args.approvedAttendanceSource.attendance[1].date = '2026-10-16';
  args.scheme.roleParameters.bar.perShiftCents = 100;
  const employeeId = args.approvedAttendanceSource.attendance[0].employeeId;
  const ids = [1,2,3].map(n => '00000000-0000-4000-8000-00000000000'+n);
  const advance = {venueId: args.venueId, employeeId, currency:'RUB', month, period:{from:month+'-01',to:month+'-14'},
    runId:ids[0],entryId:ids[1],claimId:ids[2],status:'paid',usableForH2:true,
    ledgerHash:'f'.repeat(64),grossAccruedMinor:100,appliedCorrectionMinor:20,netDueMinor:80,paidMinor:80};
  const result = settle(args,[advance],employeeId);
  check(result.evidenceSha256, JSON.stringify(result.reasons));
  const [employee] = result.employees;
  eq(employee.h1CreditMinor,100);
  const earned = employee.earnedDays.find(row => row.date === month+'-10');
  eq([earned.fixedMinor, earned.commissionMinor, employee.h2GrossMinor], [100,2000,2000],
    'sale on the 10th earns the rate reached on the 16th; only fixed gross is credited to H1');
  eq(result.evidenceSha256,settle(args,[advance],employeeId).evidenceSha256);
  const approved = settle(args,[{...advance,status:'approved',paidMinor:0}],employeeId);
  eq(approved.economicEvidenceSha256,result.economicEvidenceSha256,'pay H1 after drafting H2 keeps the economic proof');
  check(approved.evidenceSha256 !== result.evidenceSha256,'payment observation remains separately auditable');
  const newClaim = settle(args,[{...advance,claimId:ids[0]}],employeeId);
  check(newClaim.economicEvidenceSha256 !== result.economicEvidenceSha256,'replaced H1 invalidates prior economic proof');
  check(settle(args,[{...advance,ledgerHash:'e'.repeat(64)}],employeeId).economicEvidenceSha256 !== result.economicEvidenceSha256);
  const {buildPayrollDeferredMonthEvidence: buildEvidence,verifyPayrollDeferredMonthEvidence: verifyEvidence}
    = require('../payroll-deferred-month-evidence');
  const monthlyRunId = '00000000-0000-4000-8000-000000000010';
  const h2RunId = '00000000-0000-4000-8000-000000000011';
  const monthRun = require('../payroll-refund-aware-provenance').buildPayrollRefundAwareRunProvenance({...args,runId:monthlyRunId});
  const monthly = JSON.parse(monthRun.provenance.evidence_payload);
  const fixedPaid = {...advance,protectedFixedMinor:100,netDueMinor:100,paidMinor:100,appliedCorrectionMinor:0};
  const fixedApproved = {...fixedPaid,status:'approved',paidMinor:0};
  const context = {venueId:args.venueId,employeeId,month,monthlyRunId,h2RunId,h1State:fixedApproved};
  const document = buildEvidence(monthly,settle(args,[fixedApproved],employeeId),context);
  eq([document.monthlyProtectedFixedMinor, document.h1ProtectedFixedMinor, document.h2ProtectedFixedMinor,
    document.h2EligibleVariableMinor], [100,100,0,2000]);
  eq(document.monthlyEvidenceSha256, monthRun.provenance.evidence_sha256);
  eq(document.h2GrossAccruedMinor, 2000);
  eq(verifyEvidence(document.payload,monthly).liveH1Verified,false);
  eq(verifyEvidence(document.payload,monthly,fixedPaid).valid,true,'approval followed by payment keeps the document valid');
  eq(verifyEvidence(document.payload,monthly,{...fixedPaid,claimId:ids[0]}).valid,false);
  eq(verifyEvidence(document.payload,monthly,{...fixedPaid,status:'cancelled'}).valid,false);
  eq(verifyEvidence(document.payload.replace('"h2GrossAccruedMinor":2000','"h2GrossAccruedMinor":2001'),monthly).valid,false);
  eq(verifyEvidence(document.payload,{...monthly,venueId:ids[1]}).valid,false);
  const secondEmployee = args.approvedAttendanceSource.attendance[1].employeeId;
  const zero = {...fixedApproved,employeeId:secondEmployee,status:'zero_base',zeroBase:true,
    protectedFixedMinor:0,netDueMinor:0,grossAccruedMinor:0,claimId:null,entryId:null,runId:null};
  const daily = require('../payroll-refund-aware-calculation').buildPayrollRefundAwareCalculation(args).engineResult.daily;
  const canonical = v => Array.isArray(v) ? '['+v.map(canonical).join(',')+']' : v && typeof v === 'object'
    ? '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}' : JSON.stringify(v);
  const digest = v => require('node:crypto').createHash('sha256').update(canonical(v)).digest('hex');
  zero.zeroBaseEvidence = {schemaVersion:1,venueId:args.venueId,employeeId:secondEmployee,month,period:zero.period,
    monthlyRunId,monthlySourceSha256:digest(monthly),snapshotRowCount:daily.filter(d=>d.date<=zero.period.to &&
      d.employees.some(e=>e.employeeId===secondEmployee)).length,grossMinor:0,activeOverlapCount:0};
  zero.zeroBaseEvidenceSha256 = digest(zero.zeroBaseEvidence);
  const zeroContext = {...context,employeeId:secondEmployee,h1State:zero};
  const zeroDoc = buildEvidence(monthly,settle(args,[zero],secondEmployee),zeroContext);
  const secondEmployeeGross = daily.flatMap(day => day.employees)
    .filter(row => row.employeeId === secondEmployee).reduce((total, row) => total + row.amountCents, 0);
  check(secondEmployeeGross > 0);
  eq(zeroDoc.h1GrossAccruedMinor, 0);
  eq(zeroDoc.h2GrossAccruedMinor, secondEmployeeGross, 'all wages earned after the 14th remain due');
  eq(verifyEvidence(zeroDoc.payload,monthly,zero).liveH1Verified,true);
  const forged = {...zero,zeroBaseEvidence:{...zero.zeroBaseEvidence,snapshotRowCount:999}};
  forged.zeroBaseEvidenceSha256 = digest(forged.zeroBaseEvidence);
  assert.throws(()=>buildEvidence(monthly,settle(args,[forged],secondEmployee),{...zeroContext,h1State:forged}),
    {code:'payroll_h2_evidence_zero_base_unproven'});
  checks++;
  const early = clone(args);
  early.scheme.roleParameters.bar.bracketRatesBps = {0: 1000, 9000: 2000};
  const earlyResult = settle(early,[advance],employeeId);
  eq(earlyResult.employees[0].h2GrossMinor,2000,'crossing by the 10th still defers commission until the month closes');
  check(earlyResult.evidenceSha256 !== result.evidenceSha256,'scheme change alters monthly proof');
  const beforeReturn = clone(args);
  beforeReturn.scheme.roleParameters.bar.bracketRatesBps = {0:1000,20000:2000};
  const beforeSettlement = settle(beforeReturn,[advance],employeeId);
  eq(beforeSettlement.employees[0].h2GrossMinor,2000);
  const afterReturn = clone(beforeReturn);
  const returnFacts = makePayrollRefundAwareFixture('final_month_threshold',{twoEmployees:true}).recognitionEvidence.facts;
  for (const name of ['refundEvents','refundLines','refundHeaders','relatedRefundHeaders','relatedRefundItems','refundItems','refundTenders','candidateRefunds']) {
    afterReturn.recognitionEvidence.facts[name] = returnFacts[name];
  }
  afterReturn.recognitionEvidence.manifest = buildPayrollRecognitionManifest(afterReturn.recognitionEvidence.facts,
    {venueId:afterReturn.venueId,currency:'RUB',...afterReturn.period});
  const afterSettlement = settle(afterReturn,[advance],employeeId);
  check(afterSettlement.evidenceSha256,JSON.stringify(afterSettlement.reasons));
  eq(afterSettlement.employees[0].h2GrossMinor,750,'refund lowers the closed-month tier and the original line base before H2');
  eq(afterSettlement.employees[0].h1CreditMinor,100,'original H1 gross remains credited once');
  check(afterSettlement.economicEvidenceSha256 !== beforeSettlement.economicEvidenceSha256,'changed sale facts invalidate previous H2 evidence');
  const personal = clone(args);
  personal.scheme.mode = 'stable_percent';
  personal.scheme.employeeOverrides = [{employeeId,path:'mode',mode:'override',value:'final_month_threshold',
    effectiveFrom:'2026-10-08',effectiveTo:'2026-10-12'}];
  const personalParent = require('../payroll-refund-aware-calculation').buildPayrollRefundAwareCalculation(personal);
  const {payrollMonthHasDeferredPay} = require('../payroll-half-month-calculation');
  eq(payrollMonthHasDeferredPay(personalParent.engineResult,employeeId), true,'effective personal terms on the sale date');
  eq(payrollMonthHasDeferredPay(personalParent.engineResult,args.approvedAttendanceSource.attendance[1].employeeId), false);
  eq(settle(personal,[advance],employeeId).employees[0].h2GrossMinor,2000);
  const bonus = clone(args);
  bonus.scheme.mode = 'stable_percent';
  bonus.scheme.roleParameters.bar.applyMilestones = true;
  bonus.scheme.roleParameters.bar.milestoneEligibility = 'worked_on_threshold_day';
  bonus.scheme.roleParameters.bar.milestoneBonusesCents = {9000:750};
  const earnedAdvance = {...advance,grossAccruedMinor:1100,netDueMinor:1080,paidMinor:1080};
  const bonusResult = settle(bonus,[earnedAdvance],employeeId);
  const bonusParent = require('../payroll-refund-aware-calculation').buildPayrollRefundAwareCalculation(bonus);
  check(bonusResult.evidenceSha256, JSON.stringify({reasons:bonusParent.reasons,errors:bonusParent.engineResult?.criticalErrors,employees:bonusParent.engineResult?.employees}));
  eq(bonusResult.employees[0].h2GrossMinor,750,'monthly milestone is paid once after daily commissions and shifts were accrued in H1');
  const open = clone(args);
  open.periodClosure.status = 'month_to_date_closed';
  open.period = {from:month+'-01',to:month+'-14'};
  check(!settle(open,[advance],employeeId).evidenceSha256,'partial month cannot release the commission');
  check(settle(args,[{...advance,usableForH2:false}],employeeId).reasons.includes('payroll_half_month_h1_not_usable'));
}

console.log(`payroll-half-month-calculation-contract: ok (${checks} checks; actual v2 source fixture, no DB)`);
