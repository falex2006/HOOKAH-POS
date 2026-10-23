import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { makePayrollRefundAwareFixture, payrollRefundAwareModes } from './payroll-refund-aware-calculation-contract.mjs';

const require = createRequire(import.meta.url);
const { buildPayrollRefundAwareRunProvenance } = require('../payroll-refund-aware-provenance.js');
const { executeCalculatorReplay } = require('../payroll-calculator-replay.js');
const { buildPayrollRefundAwarePaidReviewAssessment: build } = require('../payroll-refund-aware-paid-review-assessment.js');
const clone = value => structuredClone(value);
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value instanceof Date ? JSON.stringify(Date.prototype.toISOString.call(value))
    : value && Object.getPrototypeOf(value) === Object.prototype ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
      : JSON.stringify(value);
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex');
const uuid = n => `bbbbbbbb-bbbb-4bbb-8bbb-${String(n).padStart(12, '0')}`;
const pass = (condition, label) => assert.ok(condition, label);
const paidProofs = (saved, provenanceSha256, calculation, incomingByEmployee = new Map()) => {
  const replay = executeCalculatorReplay(saved.calculatorReplay), dailyFixed = new Map();
  for (const day of calculation.engineResult.daily) for (const row of day.employees) {
    const fixed = Math.min(row.basePayCents, row.amountCents);
    dailyFixed.set(row.employeeId, (dailyFixed.get(row.employeeId) || 0) + fixed);
  }
  return calculation.engineResult.employees.map((employee, index) => {
    const incomingSettledCents = incomingByEmployee.get(employee.employeeId) || 0;
    return { entryId: uuid(800 + index), employeeId: employee.employeeId, runId: saved.runId,
      grossCents: employee.amountCents, netCents: employee.amountCents - incomingSettledCents,
      protectedFixedCents: dailyFixed.get(employee.employeeId) || 0, incomingSettledCents,
      evidenceHashes: { provenanceSha256, inputWatermark: saved.inputWatermark, closureWatermark: saved.closureWatermark,
        calculationWatermark: saved.calculationWatermark, snapshotInputWatermark: saved.snapshotInputWatermark,
        sourceEvidenceSha256: hash(saved.sourceEvidence), calculatorInputSha256: saved.calculatorReplay.inputSha256,
        calculatorResultSha256: replay.resultSha256, engineRevision: replay.engineRevision } };
  });
};
const savedFor = (mode, opts = {}, n = 1) => {
  const sourceArgs = makePayrollRefundAwareFixture(mode, { noRefunds: true, ...opts });
  sourceArgs.runId = uuid(n);
  const result = buildPayrollRefundAwareRunProvenance(sourceArgs);
  pass(result.status === 'verified_run_evidence', `${mode}: original provenance builds (${result.reasons})`);
  return { sourceArgs, result, saved: JSON.parse(result.provenance.evidence_payload), provenanceSha256: result.provenance.evidence_sha256 };
};

for (const [index, mode] of payrollRefundAwareModes.entries()) {
  const original = savedFor(mode, {}, index + 1), currentArgs = makePayrollRefundAwareFixture(mode);
  const paidEntries = paidProofs(original.saved, original.provenanceSha256, original.result.prepared.verifiedCalculation);
  const before = clone(currentArgs.recognitionEvidence);
  const result = build({ savedEvidence: original.saved, provenanceSha256: original.provenanceSha256,
    currentRecognitionEvidence: currentArgs.recognitionEvidence, periodClosure: currentArgs.periodClosure, paidEntries });
  pass(result.status === 'paid_review_assessed', `${mode}: partial refund assessment`);
  pass(result.officialReady === false && result.payoutEligible === false && result.deltaApplicationEligible === false
    && result.persistence === 'none' && result.financialAction === 'none', `${mode}: no authority`);
  pass(result.paidReviews.length === paidEntries.length, `${mode}: each paid employee reviewed`);
  pass(result.dailyDeltas.length === 31 * result.employeeDeltas.length, `${mode}: full period and employee coverage`);
  assert.deepEqual(currentArgs.recognitionEvidence, before, `${mode}: input unchanged`);
  pass(Object.isFrozen(result) && Object.isFrozen(result.paidReviews), `${mode}: immutable output`);
  pass(result.assessmentWatermark === build({ savedEvidence: original.saved, provenanceSha256: original.provenanceSha256,
    currentRecognitionEvidence: currentArgs.recognitionEvidence, periodClosure: currentArgs.periodClosure, paidEntries }).assessmentWatermark,
  `${mode}: deterministic hash`);
  const laterClosure = clone(currentArgs.periodClosure);
  laterClosure.transactionTimestamp = '2026-11-06T00:00:01.000000Z';
  const sameFactsLater = build({ savedEvidence: original.saved, provenanceSha256: original.provenanceSha256,
    currentRecognitionEvidence: currentArgs.recognitionEvidence, periodClosure: laterClosure, paidEntries });
  pass(sameFactsLater.assessmentWatermark === result.assessmentWatermark,
    `${mode}: transaction clock does not change the stable comparison plan`);

  if (mode === 'progressive_daily') pass(result.paidReviews[0].potentialReductionReviewCents === 250,
    'partial refund is assessed against protected paid variable only');
  const full = makePayrollRefundAwareFixture(mode, { fullReturn: true });
  const fullResult = build({ savedEvidence: original.saved, provenanceSha256: original.provenanceSha256,
    currentRecognitionEvidence: full.recognitionEvidence, periodClosure: full.periodClosure, paidEntries });
  pass(fullResult.status === 'paid_review_assessed' && fullResult.currentInputWatermark !== result.currentInputWatermark,
    `${mode}: full return is a distinct whole-period assessment`);

  const noRefund = makePayrollRefundAwareFixture(mode, { noRefunds: true });
  const unchanged = build({ savedEvidence: original.saved, provenanceSha256: original.provenanceSha256,
    currentRecognitionEvidence: noRefund.recognitionEvidence, periodClosure: noRefund.periodClosure, paidEntries });
  pass(unchanged.totals.delta.amountCents === 0, `${mode}: unchanged source has zero delta`);
  pass(result.sourceCohortSha256 !== unchanged.sourceCohortSha256,
    `${mode}: source cohort watermark binds current refund identities`);
}

{
  const original = savedFor('team_fund', { twoEmployees: true }, 20), current = makePayrollRefundAwareFixture('team_fund', { twoEmployees: true });
  const proofs = paidProofs(original.saved, original.provenanceSha256, original.result.prepared.verifiedCalculation);
  const partial = build({ savedEvidence: original.saved, provenanceSha256: original.provenanceSha256,
    currentRecognitionEvidence: current.recognitionEvidence, periodClosure: current.periodClosure, paidEntries: proofs });
  pass(partial.employeeDeltas.length === 2 && partial.dailyDeltas.length === 62, 'team fund preserves every employee/day delta');
  pass(partial.summary.crossEmployeeOffsetApplied === false && partial.summary.negativeClaimsCreated === false,
    'team deltas cannot offset another employee or create debt');
  const subset = build({ savedEvidence: original.saved, provenanceSha256: original.provenanceSha256,
    currentRecognitionEvidence: current.recognitionEvidence, periodClosure: current.periodClosure, paidEntries: proofs.slice(0, 1) });
  pass(subset.employeeDeltas.length === 2 && subset.paidReviews.length === 1 && subset.summary.unpaidOrUnprovedEmployeeCount === 1,
    'comparison remains whole-cohort when only one entry is paid');
}

{
  const original = savedFor('progressive_daily', {}, 30), current = makePayrollRefundAwareFixture('progressive_daily');
  const calculation = original.result.prepared.verifiedCalculation;
  const employee = calculation.engineResult.employees[0];
  const proofs = paidProofs(original.saved, original.provenanceSha256, calculation, new Map([[employee.employeeId, employee.amountCents]]));
  const result = build({ savedEvidence: original.saved, provenanceSha256: original.provenanceSha256,
    currentRecognitionEvidence: current.recognitionEvidence, periodClosure: current.periodClosure, paidEntries: proofs });
  pass(result.paidReviews[0].netCents === 0 && result.paidReviews[0].incomingSettledTreatment === 'deducted_once_from_baseline_and_candidate'
    && result.paidReviews[0].potentialReductionReviewCents === 0, 'incoming full settlement is consumed once and creates no negative claim');
}

{
  const original = savedFor('progressive_daily', {}, 40), current = makePayrollRefundAwareFixture('progressive_daily');
  const proofs = paidProofs(original.saved, original.provenanceSha256, original.result.prepared.verifiedCalculation);
  const badSale = clone(current.recognitionEvidence); badSale.facts.saleLines[0].net_minor = '9999';
  assert.throws(() => build({ savedEvidence: original.saved, provenanceSha256: original.provenanceSha256,
    currentRecognitionEvidence: badSale, periodClosure: current.periodClosure, paidEntries: proofs }), /original_sale_facts_changed/);
  const withRefund = savedFor('progressive_daily', { noRefunds: false }, 41);
  const withRefundProofs = paidProofs(withRefund.saved, withRefund.provenanceSha256, withRefund.result.prepared.verifiedCalculation);
  const refundBase = makePayrollRefundAwareFixture('progressive_daily');
  const removedRefund = clone(refundBase.recognitionEvidence); removedRefund.facts.refundLines = [];
  assert.throws(() => build({ savedEvidence: withRefund.saved, provenanceSha256: withRefund.provenanceSha256,
    currentRecognitionEvidence: removedRefund, periodClosure: refundBase.periodClosure, paidEntries: withRefundProofs }), /refund_history_rewritten/);
  const badPaid = clone(proofs); badPaid[0].netCents--;
  assert.throws(() => build({ savedEvidence: original.saved, provenanceSha256: original.provenanceSha256,
    currentRecognitionEvidence: current.recognitionEvidence, periodClosure: current.periodClosure, paidEntries: badPaid }), /paid_entry_amount_binding_mismatch/);
  const fixedArgs = makePayrollRefundAwareFixture('progressive_daily', { noRefunds: true });
  fixedArgs.scheme.roleParameters.bar.perShiftCents = 100;
  fixedArgs.runId = uuid(42);
  const fixedOriginal = buildPayrollRefundAwareRunProvenance(fixedArgs);
  pass(fixedOriginal.status === 'verified_run_evidence', 'fixed-pay fixture builds');
  const fixedSaved = JSON.parse(fixedOriginal.provenance.evidence_payload);
  const fixedProofs = paidProofs(fixedSaved, fixedOriginal.provenance.evidence_sha256, fixedOriginal.prepared.verifiedCalculation);
  const malformedNet = clone(fixedProofs);
  malformedNet[0].netCents = malformedNet[0].protectedFixedCents - 1;
  malformedNet[0].incomingSettledCents = malformedNet[0].grossCents - malformedNet[0].netCents;
  const fixedCurrent = makePayrollRefundAwareFixture('progressive_daily');
  assert.throws(() => build({ savedEvidence: fixedSaved, provenanceSha256: fixedOriginal.provenance.evidence_sha256,
    currentRecognitionEvidence: fixedCurrent.recognitionEvidence, periodClosure: fixedCurrent.periodClosure, paidEntries: malformedNet }),
  /paid_entry_amount_binding_mismatch/);
  const badHash = clone(proofs); badHash[0].evidenceHashes.inputWatermark = 'f'.repeat(64);
  assert.throws(() => build({ savedEvidence: original.saved, provenanceSha256: original.provenanceSha256,
    currentRecognitionEvidence: current.recognitionEvidence, periodClosure: current.periodClosure, paidEntries: badHash }), /paid_entry_evidence_hash_mismatch/);
}

{
  const original = savedFor('progressive_daily', {}, 50), current = makePayrollRefundAwareFixture('progressive_daily');
  const oversized = clone(original.saved);
  oversized.sourceBundle.recognitionEvidence.payload = `{"padding":"${'x'.repeat(1_100_000)}"}`;
  oversized.sourceBundleWatermark = hash(oversized.sourceBundle);
  const oversizedHash = hash(oversized);
  const proofs = paidProofs(original.saved, original.provenanceSha256, original.result.prepared.verifiedCalculation);
  assert.throws(() => build({ savedEvidence: oversized, provenanceSha256: oversizedHash,
    currentRecognitionEvidence: current.recognitionEvidence, periodClosure: current.periodClosure, paidEntries: proofs }),
  /saved_provenance_rebuild_failed/);
  const ordinaryLargeString = clone(original.saved);
  ordinaryLargeString.unrelated = 'x'.repeat(1_100_000);
  assert.throws(() => build({ savedEvidence: ordinaryLargeString, provenanceSha256: hash(ordinaryLargeString),
    currentRecognitionEvidence: current.recognitionEvidence, periodClosure: current.periodClosure, paidEntries: proofs }), /structure_limit/);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`payroll-refund-aware-paid-review-assessment: PASS (${payrollRefundAwareModes.length} modes, append-only sources, paid cohort, no monetary writes)`);
}
