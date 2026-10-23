import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { makePayrollRefundAwareFixture, payrollRefundAwareModes } from './payroll-refund-aware-calculation-contract.mjs';
const require = createRequire(import.meta.url);
const { buildRefundAwareCorrectionPlan: apply, buildRefundAwareCorrectionWaiverPlan: waive } = require('../payroll-refund-aware-correction-policy');
const { buildPayrollRefundAwareRunProvenance } = require('../payroll-refund-aware-provenance');
const { buildPayrollRefundAwarePaidReviewAssessment } = require('../payroll-refund-aware-paid-review-assessment');
const { executeCalculatorReplay } = require('../payroll-calculator-replay');
const id = n => `cccccccc-cccc-4ccc-8ccc-${String(n).padStart(12, '0')}`;
const clone = value => structuredClone(value);
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const rehash = assessment => { const { assessmentWatermark, ...payload } = assessment; assessment.assessmentWatermark = hash(payload); return assessment; };

export function makeRefundAwareCorrectionPolicyFixture(mode = 'progressive_daily', incoming = 0, currentOptions = {}) {
  const source = makePayrollRefundAwareFixture(mode, { noRefunds: true }); source.runId = id(1);
  const built = buildPayrollRefundAwareRunProvenance(source), saved = JSON.parse(built.provenance.evidence_payload);
  assert.equal(built.status, 'verified_run_evidence');
  const result = built.prepared.verifiedCalculation.engineResult, replay = executeCalculatorReplay(saved.calculatorReplay);
  const member = result.employees[0], fixed = result.daily.reduce((sum, day) => {
    const row = day.employees.find(employee => employee.employeeId === member.employeeId);
    return sum + (row ? Math.min(row.basePayCents, row.amountCents) : 0);
  }, 0);
  const evidenceHashes = { provenanceSha256: built.provenance.evidence_sha256, inputWatermark: saved.inputWatermark,
    closureWatermark: saved.closureWatermark, calculationWatermark: saved.calculationWatermark,
    snapshotInputWatermark: saved.snapshotInputWatermark, sourceEvidenceSha256: hash(saved.sourceEvidence),
    calculatorInputSha256: saved.calculatorReplay.inputSha256, calculatorResultSha256: replay.resultSha256, engineRevision: replay.engineRevision };
  const proof = { entryId: id(2), employeeId: member.employeeId, runId: saved.runId, grossCents: member.amountCents,
    netCents: member.amountCents - incoming, protectedFixedCents: fixed, incomingSettledCents: incoming, evidenceHashes };
  const current = makePayrollRefundAwareFixture(mode, currentOptions);
  const assessment = buildPayrollRefundAwarePaidReviewAssessment({ savedEvidence: saved, provenanceSha256: built.provenance.evidence_sha256,
    currentRecognitionEvidence: current.recognitionEvidence, periodClosure: current.periodClosure, paidEntries: [proof] });
  const original = { id: proof.entryId, venueId: saved.venueId, employeeId: member.employeeId, runId: saved.runId,
    origin: 'calculation_run', currency: 'RUB', provenanceSha256: evidenceHashes.provenanceSha256,
    periodFrom: saved.period.from, periodTo: saved.period.to, status: 'paid', grossCents: proof.grossCents, netCents: proof.netCents,
    protectedFixedCents: fixed, eligibleVariableCents: proof.grossCents - fixed, evidenceHashes,
    expense: proof.netCents > 0 ? { id: id(3), entryId: proof.entryId, venueId: saved.venueId, source: 'payroll', amountCents: proof.netCents } : null };
  if (!proof.netCents) original.settlement = { kind: 'zero', venueId: saved.venueId, entryId: original.id,
    employeeId: original.employeeId, runId: original.runId, provenanceSha256: original.provenanceSha256,
    grossCents: original.grossCents, netCents: 0, protectedFixedCents: 0, incomingCorrectionCents: incoming,
    transitionId: id(4), paidBy: id(5), paidAt: '2026-09-01T10:00:00.000Z', paymentDate: '2026-09-01' };
  const target = { id: id(6), venueId: original.venueId, employeeId: original.employeeId, runId: id(7), origin: 'calculation_run', currency: 'RUB',
    provenanceSha256: 'a'.repeat(64), periodFrom: '2027-01-01', periodTo: '2027-01-31', status: 'draft',
    grossCents: 1000, netCents: 1000, protectedFixedCents: 700, eligibleVariableCents: 300 };
  const ledger = incoming ? [legacyEvent(original, 10, 'apply', incoming, id(8), original.id)] : [];
  return clone({ original, target, assessment, ledger, claimHistory: [] });
}
const legacyEvent = (original, n, kind, amountCents, originalEntryId = original.id, targetEntryId = id(6)) => ({ id: id(n), sequenceNo: n,
  venueId: original.venueId, employeeId: original.employeeId, currency: 'RUB', originalEntryId,
  refundLineEventId: id(100 + n), kind, amountCents, targetEntryId: kind === 'waive' ? null : targetEntryId, reversesEventId: null });
const periodEvent = (original, n, kind, amountCents, overrides = {}) => ({ ...legacyEvent(original, n, kind, amountCents),
  refundLineEventId: null, sourceKind: 'period_v2', cohortClaimId: id(20), cohortAssessmentId: id(30), ...overrides });
// Synthetic arithmetic variants retain the real assessment shape. They are not
// source-attested assessments: production callers must use the actual collector.
const potential = (assessment, cents, positive = 0) => {
  const out = clone(assessment), row = out.paidReviews[0];
  row.candidateGrossCents = row.grossCents - cents + positive;
  row.candidateAfterIncomingCents = row.candidateGrossCents - row.incomingSettledCents;
  row.potentialReductionReviewCents = cents; row.positiveEntitlementInformationCents = positive;
  row.signedCounterfactualDeltaCents = positive - cents;
  out.summary.potentialReductionReviewCents = cents; out.summary.positiveEntitlementInformationCents = positive;
  out.currentInputWatermark = hash({ cents, positive }); return rehash(out);
};

export function verifyRefundAwareCorrectionPolicyContract() {
  let checks = 0;
  const eq = (actual, expected, label) => { assert.deepEqual(actual, expected, label); checks++; };
  const ok = (value, label) => { assert.ok(value, label); checks++; };
  const rejects = (input, fragment, fn = apply) => { assert.throws(() => fn(input), error => String(error.code).includes(fragment)); checks++; };
  for (const mode of payrollRefundAwareModes) {
    const input = makeRefundAwareCorrectionPolicyFixture(mode), before = clone(input), output = apply(input);
    eq(output.schemaVersion, 3); eq(output.policyCode, 'reviewed_period_variable_pay_only_v1');
    eq(output.currentPotentialCents, input.assessment.paidReviews[0].potentialReductionReviewCents);
    eq(output.applyCents, Math.min(output.currentPotentialCents, 300));
    eq(output.targetAfterCents, 1000 - output.applyCents); eq(output.allocations.length, 1);
    eq(output.allocations[0].basisKind, 'period_variable');
    ok(!Object.hasOwn(output.allocations[0], 'refundLineEventId'), 'no fabricated refund line identity');
    eq(input, before, 'pure calculation leaves all inputs unchanged');
    ok(Object.isFrozen(output) && Object.isFrozen(output.allocations[0]));
    const { planHash, ...payload } = output; eq(planHash, hash(payload));
    for (const flag of ['officialReady', 'payoutEligible', 'sourceAttested', 'deltaApplicationEligible']) eq(output[flag], false);
    eq(output.financialAction, 'none'); eq(output.persistence, 'none');
    const { target, ...waiverInput } = input; eq(waive(waiverInput).waiveCents, output.currentPotentialCents);
  }
  const base = makeRefundAwareCorrectionPolicyFixture(), cloneBase = () => clone(base);
  eq(base.original.grossCents, 1000, 'arithmetic fixture baseline');
  const full = cloneBase(); full.assessment = potential(base.assessment, 600);
  const plan = apply(full); eq(plan.applyCents, 300); eq(plan.residualReviewCents, 300); eq(plan.targetAfterCents, 700);
  const partial = clone(full); partial.claim = { id: id(20), firstAssessedCents: 250 };
  partial.ledger = [periodEvent(partial.original, 40, 'apply', 100)]; partial.target.netCents = 900;
  eq(apply(partial).applyCents, 200); eq(apply(partial).residualReviewCents, 300); eq(apply(partial).firstAssessedCents, 250);
  eq(apply(partial).highWaterAssessedCents, 600, 'later assessments do not mutate first claim amount');
  partial.ledger.push(periodEvent(partial.original, 41, 'waive', 200, { cohortAssessmentId: id(31) }));
  eq(apply(partial).alreadyDisposedCents, 300, 'all assessments of one stable claim consume the same balance');
  eq(apply(partial).applyCents, 200); eq(apply(partial).residualReviewCents, 100);
  const unordered = clone(partial); unordered.ledger.reverse(); eq(apply(unordered), apply(partial), 'ledger order is immaterial');
  const lower = cloneBase(); lower.assessment = potential(base.assessment, 100);
  lower.claimHistory = [full.assessment, base.assessment]; lower.claim = { id: id(20), firstAssessedCents: 250 };
  eq(apply(lower).highWaterAssessedCents, 600); eq(apply(lower).applyCents, 100, 'audit high-water is not spendable');
  lower.ledger = [periodEvent(lower.original, 42, 'waive', 101)]; rejects(lower, 'current_potential_below_dispositions');
  const released = cloneBase(); released.assessment = potential(base.assessment, 100); released.claim = { id: id(20), firstAssessedCents: 250 };
  const parent = periodEvent(released.original, 44, 'apply', 250, { targetEntryId: id(90) });
  released.ledger = [{ ...parent, id: id(45), sequenceNo: 45, kind: 'release', reversesEventId: parent.id }, parent];
  eq(apply(released).applyCents, 100, 'exact release restores only the currently confirmed amount');
  const waived = clone(partial); delete waived.target;
  eq(waive(waived).waiveCents, 300); eq(waive(waived).targetEntryId, null);
  const other = clone(full); other.target.netCents = 850;
  other.ledger = [legacyEvent(other.original, 50, 'apply', 100, id(91)), periodEvent(other.original, 51, 'apply', 50,
    { originalEntryId: id(92), cohortClaimId: id(93) })];
  eq(apply(other).applyCents, 150, 'both legacy and period incoming allocations reduce target capacity');
  const fixedOnly = cloneBase(); fixedOnly.target.protectedFixedCents = 1000; fixedOnly.target.eligibleVariableCents = 0;
  eq(apply(fixedOnly).applyCents, 0); eq(apply(fixedOnly).targetAfterCents, 1000);
  const positive = cloneBase(); positive.assessment = potential(base.assessment, 0, 100);
  eq(apply(positive).applyCents, 0); eq(apply(positive).positiveEntitlementInformationCents, 100); eq(apply(positive).positiveEntitlementAction, 'none');
  const incoming = makeRefundAwareCorrectionPolicyFixture('progressive_daily', 500);
  eq(apply(incoming).currentPotentialCents, 250, 'prior incoming is deducted once from both baseline and candidate');
  const zero = makeRefundAwareCorrectionPolicyFixture('progressive_daily', 1000);
  eq(apply(zero).currentPotentialCents, 0); eq(apply(zero).applyCents, 0, 'zero settled net cannot create an additional deduction');
  eq(apply(zero).originalExpenseId, null); eq(apply(zero).originalSettlementTransitionId, zero.original.settlement.transitionId);
  const zeroMissing = clone(zero); zeroMissing.ledger = []; rejects(zeroMissing, 'original_settlement_ledger_invalid');
  const noClaim = clone(partial); delete noClaim.claim; rejects(noClaim, 'claim_ledger_mismatch');
  const wrongClaim = clone(partial); wrongClaim.claim.id = id(99); rejects(wrongClaim, 'claim_ledger_mismatch');
  const sharedClaim = clone(partial); sharedClaim.ledger.push(periodEvent(sharedClaim.original, 49, 'waive', 1, { originalEntryId: id(99) }));
  rejects(sharedClaim, 'claim_ledger_mismatch');
  const twoClaims = clone(partial); twoClaims.ledger.push(periodEvent(twoClaims.original, 49, 'waive', 1, { cohortClaimId: id(99) }));
  rejects(twoClaims, 'claim_ledger_mismatch');
  const wrongFirst = clone(incoming); wrongFirst.claim = { id: id(20), firstAssessedCents: 501 }; rejects(wrongFirst, 'claim_invalid');
  const wrapperAnnotation = cloneBase(); wrapperAnnotation.assessment.sourceCollection = 'verified_private_paid_entry_rows'; rejects(wrapperAnnotation, 'assessment_required');
  const historyOrder = cloneBase(); historyOrder.claimHistory = [potential(base.assessment, 100), full.assessment];
  const historyReverse = clone(historyOrder); historyReverse.claimHistory.reverse(); eq(apply(historyOrder), apply(historyReverse), 'history order cannot change plan');
  const mixed = cloneBase(); mixed.ledger = [legacyEvent(mixed.original, 60, 'waive', 1)]; rejects(mixed, 'mixed_original_basis');
  for (const mutate of [v => { v.assessment.paidReviews[0].potentialReductionReviewCents++; },
    v => { v.assessment.period.from = '2026-01-01'; }, v => { v.assessment.originalProvenanceSha256 = 'f'.repeat(64); },
    v => { v.assessment.paidReviews[0].entryId = id(99); }, v => { v.assessment.paidReviews.push(clone(v.assessment.paidReviews[0])); }]) {
    const bad = cloneBase(); mutate(bad); rejects(bad, 'assessment'); rehash(bad.assessment); rejects(bad, 'assessment');
  }
  const wrongProof = cloneBase(); wrongProof.original.evidenceHashes.inputWatermark = 'f'.repeat(64); rejects(wrongProof, 'paid_proof_hash_mismatch');
  const brokenHistory = cloneBase(); brokenHistory.claimHistory = [full.assessment]; brokenHistory.claimHistory[0].paidReviews[0].grossCents++;
  rejects(brokenHistory, 'assessment_hash_invalid');
  const foreignHistory = cloneBase(); foreignHistory.claimHistory = [clone(full.assessment)]; foreignHistory.claimHistory[0].originalProvenanceSha256 = 'f'.repeat(64);
  rehash(foreignHistory.claimHistory[0]); rejects(foreignHistory, 'assessment_required');
  const duplicates = cloneBase(); duplicates.claimHistory = [base.assessment, base.assessment]; rejects(duplicates, 'claim_history_duplicate');
  for (const mutate of [v => { v.target.status = 'approved'; }, v => { v.target.employeeId = id(99); }, v => { v.target.venueId = id(99); },
    v => { v.target.periodFrom = v.original.periodTo; v.target.periodTo = v.original.periodTo; }]) {
    const bad = cloneBase(); mutate(bad); rejects(bad, 'target_draft_invalid');
  }
  const invalidDate = cloneBase(); invalidDate.target.periodTo = '2027-02-30'; rejects(invalidDate, 'period_invalid');
  const floorBreak = cloneBase(); floorBreak.target.netCents = 699; rejects(floorBreak, 'entry_basis_invalid');
  const missingIncoming = clone(other); missingIncoming.ledger = []; rejects(missingIncoming, 'target_ledger_mismatch');
  for (const mutate of [v => { v.original.status = 'draft'; }, v => { v.original.expense.venueId = id(99); }, v => { v.original.expense.amountCents--; }]) {
    const bad = cloneBase(); mutate(bad); rejects(bad, 'original_paid_basis_required');
  }
  for (const mutate of [v => { v.ledger[0].amountCents--; }, v => { v.ledger[0].cohortAssessmentId = id(99); },
    v => { v.ledger[0].targetEntryId = id(99); }, v => { v.ledger[0].sequenceNo = 43; }]) {
    const bad = clone(released); mutate(bad); rejects(bad, 'release_invalid');
  }
  const doubleRelease = clone(released); doubleRelease.ledger.push({ ...doubleRelease.ledger[0], id: id(46), sequenceNo: 46 }); rejects(doubleRelease, 'release_invalid');
  const duplicateEvent = clone(released); duplicateEvent.ledger.push(clone(duplicateEvent.ledger[0])); rejects(duplicateEvent, 'ledger_invalid');
  const foreignEvent = clone(other); foreignEvent.ledger[0].employeeId = id(99); rejects(foreignEvent, 'scope_mismatch');
  const badAmount = clone(other); badAmount.ledger[0].amountCents = Number.MAX_SAFE_INTEGER; rejects(badAmount, 'amount_invalid');
  const nan = cloneBase(); nan.target.netCents = NaN; rejects(nan, 'json_invalid');
  const bigint = cloneBase(); bigint.target.netCents = 1n; rejects(bigint, 'json_invalid');
  const dateObject = cloneBase(); dateObject.target.periodFrom = new Date(); rejects(dateObject, 'json_invalid');
  const cycle = cloneBase(); cycle.self = cycle; rejects(cycle, 'json_invalid');
  let accessed = false; const getter = cloneBase(); Object.defineProperty(getter.assessment, 'fake', { enumerable: true, get() { accessed = true; return 1; } });
  rejects(getter, 'json_invalid'); eq(accessed, false, 'getters never execute');
  const symbol = cloneBase(); symbol[Symbol('hidden')] = true; rejects(symbol, 'json_invalid');
  const sparse = cloneBase(); sparse.ledger = new Array(1); rejects(sparse, 'json_invalid');
  const extras = cloneBase(); extras.unexpected = true; rejects(extras, 'input_invalid');
  rejects(base, 'waiver_target_forbidden', waive);
  const noTarget = cloneBase(); delete noTarget.target; rejects(noTarget, 'entry_basis_invalid');
  return checks;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`PASS refund-aware correction policy: ${verifyRefundAwareCorrectionPolicyContract()} assertions; no database authority`);
}
