'use strict';

// Pure plans over independently verified paid proofs and complete mixed ledgers.
// Hash checks bind data, not database authenticity or owner authorization.
// A future fenced writer must establish both before persisting any disposition.
const { createHash } = require('node:crypto');
const POLICY = 'reviewed_period_variable_pay_only_v1';
const ASSESSMENT_POLICY = 'payroll_refund_aware_paid_review_v1';
const ASSESSMENT_KEYS = ('schemaVersion policyCode status officialReady payoutEligible sourceAttested persistence deltaApplicationEligible '
  + 'financialAction positiveEntitlementAction venueId runId currency period schemeVersionId originalProvenanceSha256 originalInputWatermark '
  + 'currentInputWatermark counterfactualModelWatermark sourceCohortSha256 refundHistoryPolicy mode baselineAmountCents counterfactualAmountCents '
  + 'employeeDeltas dailyDeltas totals paidReviews summary deltaSemantics protectedFixedSemantics capAndLossFloorSemantics sourceFactChangeSemantics assessmentWatermark').split(' ');
const REVIEW_KEYS = ('entryId employeeId runId grossCents netCents originalProtectedFixedCents incomingSettledCents paidProofWatermark '
  + 'candidateGrossCents originalNetAfterIncomingCents candidateAfterIncomingCents protectedFloorCents potentialReductionReviewCents '
  + 'positiveEntitlementInformationCents signedCounterfactualDeltaCents incomingSettledTreatment fixedPayTreatment settlementEffect').split(' ');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA = /^[a-f0-9]{64}$/;
const MAX = 999999999999n;
const fail = code => { throw Object.assign(new Error(`payroll_refund_correction_${code}`), {
  code: `payroll_refund_correction_${code}`, status: 409
}); };
const plain = value => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : plain(value) ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex');
const freeze = value => { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const exact = (value, keys) => plain(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const inspect = input => {
  const active = new WeakSet(); let nodes = 0;
  const visit = (value, depth) => {
    if (++nodes > 2000000 || depth > 64) fail('structure_limit');
    if (value === null || typeof value === 'boolean') return;
    if (typeof value === 'string') { if (value.length > 1048576) fail('structure_limit'); return; }
    if (typeof value === 'number') { if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER || Object.is(value, -0)) fail('json_invalid'); return; }
    if ((!plain(value) && !Array.isArray(value)) || active.has(value)) fail('json_invalid');
    const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(value);
    if (keys.some(key => typeof key !== 'string') || Object.values(descriptors).some(descriptor => !Object.hasOwn(descriptor, 'value'))) fail('json_invalid');
    if (Array.isArray(value) && (keys.length !== value.length + 1 || keys.some(key => key !== 'length' && !/^(0|[1-9][0-9]*)$/.test(key)))) fail('json_invalid');
    active.add(value);
    for (const key of keys) if (key !== 'length' || !Array.isArray(value)) visit(descriptors[key].value, depth + 1);
    active.delete(value);
  };
  visit(input, 0);
  if (Buffer.byteLength(canonical(input), 'utf8') > 40 * 1024 * 1024) fail('structure_limit');
};
const id = value => { if (typeof value !== 'string' || !UUID.test(value)) fail('identity_invalid'); return value; };
const money = value => { if (!Number.isSafeInteger(value) || value < 0 || BigInt(value) > MAX) fail('amount_invalid'); return BigInt(value); };
const safe = value => { if (value < 0n || value > MAX) fail('total_overflow'); return Number(value); };
const date = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00Z`))
      || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) fail('period_invalid');
  return value;
};
const entry = value => {
  if (!plain(value) || value.origin !== 'calculation_run' || value.currency !== 'RUB' || !SHA.test(value.provenanceSha256 || '')) fail('entry_basis_invalid');
  for (const key of ['id', 'venueId', 'employeeId', 'runId']) id(value[key]);
  if (date(value.periodFrom) > date(value.periodTo) || value.periodFrom.slice(0, 7) !== value.periodTo.slice(0, 7)) fail('period_invalid');
  const gross = money(value.grossCents), net = money(value.netCents), fixed = money(value.protectedFixedCents), variable = money(value.eligibleVariableCents);
  if (net > gross || net < fixed || fixed + variable !== gross) fail('entry_basis_invalid');
  return { gross, net, fixed, variable };
};
const paidOriginal = original => {
  const amounts = entry(original);
  if (original.status !== 'paid') fail('original_paid_basis_required');
  if (original.settlement !== undefined) {
    const settled = original.settlement;
    if (!plain(settled) || settled.kind !== 'zero' || original.expense !== null || amounts.net !== 0n || amounts.fixed !== 0n
        || settled.venueId !== original.venueId || settled.entryId !== original.id || settled.employeeId !== original.employeeId
        || settled.runId !== original.runId || settled.provenanceSha256 !== original.provenanceSha256
        || money(settled.grossCents) !== amounts.gross || settled.netCents !== 0 || settled.protectedFixedCents !== 0
        || money(settled.incomingCorrectionCents) !== amounts.gross || typeof settled.paidAt !== 'string' || !Number.isFinite(Date.parse(settled.paidAt))) fail('original_paid_basis_required');
    id(settled.transitionId); id(settled.paidBy); date(settled.paymentDate);
  } else {
    const expense = original.expense;
    if (!plain(expense) || expense.source !== 'payroll' || expense.venueId !== original.venueId || expense.entryId !== original.id
        || amounts.net <= 0n || money(expense.amountCents) !== amounts.net) fail('original_paid_basis_required');
    id(expense.id);
  }
  return amounts;
};
const assessmentReview = (assessment, original, amounts) => {
  if (!exact(assessment, ASSESSMENT_KEYS) || assessment.schemaVersion !== 1 || assessment.policyCode !== ASSESSMENT_POLICY || assessment.status !== 'paid_review_assessed'
      || assessment.venueId !== original.venueId || assessment.runId !== original.runId || assessment.currency !== 'RUB'
      || assessment.originalProvenanceSha256 !== original.provenanceSha256
      || assessment.period?.from !== original.periodFrom || assessment.period?.to !== original.periodTo
      || assessment.officialReady !== false || assessment.payoutEligible !== false || assessment.sourceAttested !== false
      || assessment.deltaApplicationEligible !== false || assessment.persistence !== 'none' || assessment.financialAction !== 'none'
      || assessment.positiveEntitlementAction !== 'none' || !Array.isArray(assessment.paidReviews) || assessment.paidReviews.length > 500
      || !assessment.paidReviews.every(plain) || !SHA.test(assessment.counterfactualModelWatermark || '')
      || !SHA.test(assessment.assessmentWatermark || '') || !SHA.test(assessment.sourceCohortSha256 || '')
      || !SHA.test(assessment.currentInputWatermark || '') || !SHA.test(assessment.originalInputWatermark || '')) fail('assessment_required');
  const { assessmentWatermark, ...payload } = assessment;
  if (hash(payload) !== assessmentWatermark) fail('assessment_hash_invalid');
  const matches = assessment.paidReviews.filter(row => row.entryId === original.id || row.employeeId === original.employeeId);
  if (matches.length !== 1) fail('assessment_entry_mismatch');
  const review = matches[0];
  if (!exact(review, REVIEW_KEYS) || review.entryId !== original.id || review.employeeId !== original.employeeId || review.runId !== original.runId
      || money(review.grossCents) !== amounts.gross || money(review.netCents) !== amounts.net
      || money(review.originalProtectedFixedCents) !== amounts.fixed || money(review.protectedFloorCents) !== amounts.fixed
      || money(review.incomingSettledCents) !== amounts.gross - amounts.net || money(review.originalNetAfterIncomingCents) !== amounts.net
      || !SHA.test(review.paidProofWatermark || '') || review.incomingSettledTreatment !== 'deducted_once_from_baseline_and_candidate'
      || review.fixedPayTreatment !== 'original_paid_protected_fixed_amount_is_floor' || review.settlementEffect !== 'assessment_only_no_claim_or_payment') fail('assessment_entry_mismatch');
  const candidate = money(review.candidateGrossCents), afterIncoming = candidate - (amounts.gross - amounts.net);
  const floor = afterIncoming > amounts.fixed ? afterIncoming : amounts.fixed;
  const potential = amounts.net > floor ? amounts.net - floor : 0n;
  const positive = afterIncoming > amounts.net ? afterIncoming - amounts.net : 0n;
  if (!Number.isSafeInteger(review.candidateAfterIncomingCents) || BigInt(review.candidateAfterIncomingCents) !== afterIncoming
      || !Number.isSafeInteger(review.signedCounterfactualDeltaCents) || BigInt(review.signedCounterfactualDeltaCents) !== candidate - amounts.gross
      || money(review.potentialReductionReviewCents) !== potential || money(review.positiveEntitlementInformationCents) !== positive) fail('assessment_arithmetic_invalid');
  if (original.evidenceHashes !== undefined) {
    if (!plain(original.evidenceHashes) || original.evidenceHashes.provenanceSha256 !== original.provenanceSha256
        || hash({ entryId: original.id, employeeId: original.employeeId, runId: original.runId, grossCents: original.grossCents,
          netCents: original.netCents, protectedFixedCents: original.protectedFixedCents,
          incomingSettledCents: safe(amounts.gross - amounts.net), evidenceHashes: original.evidenceHashes }) !== review.paidProofWatermark) fail('paid_proof_hash_mismatch');
  }
  return { review, potential };
};

// Ledger normalization is shared with the independently owned mixed-ledger reader.
const normalizeLedger = (ledger, original) => {
  const { normalizePayrollCorrectionLedgerEvent, samePayrollCorrectionSource } = require('./payroll-correction-ledger-source');
  if (!Array.isArray(ledger) || ledger.length > 100000) fail('ledger_invalid');
  const byId = new Map(), sequences = new Set(), released = new Set(), claimOriginals = new Map(), originalClaims = new Map();
  for (const raw of ledger) {
    const event = normalizePayrollCorrectionLedgerEvent(raw, { venueId: original.venueId, employeeId: original.employeeId });
    if (byId.has(event.id) || sequences.has(event.sequenceNo)) fail('ledger_invalid');
    if (event.sourceKind === 'period_v2') {
      if ((claimOriginals.has(event.cohortClaimId) && claimOriginals.get(event.cohortClaimId) !== event.originalEntryId)
          || (originalClaims.has(event.originalEntryId) && originalClaims.get(event.originalEntryId) !== event.cohortClaimId)) fail('claim_ledger_mismatch');
      claimOriginals.set(event.cohortClaimId, event.originalEntryId); originalClaims.set(event.originalEntryId, event.cohortClaimId);
    }
    byId.set(event.id, event); sequences.add(event.sequenceNo);
  }
  const events = [...byId.values()].sort((a, b) => a.sequenceNo - b.sequenceNo);
  for (const event of events) if (event.kind === 'release') {
    const parent = byId.get(event.reversesEventId);
    if (!parent || parent.kind !== 'apply' || parent.sequenceNo >= event.sequenceNo || released.has(parent.id)
        || parent.amountCents !== event.amountCents || parent.targetEntryId !== event.targetEntryId
        || !samePayrollCorrectionSource(parent, event)) fail('release_invalid');
    released.add(parent.id);
  }
  return { events, ledgerHash: hash([...events].sort((a, b) => a.id.localeCompare(b.id))) };
};
const prepare = input => {
  inspect(input);
  if (!plain(input) || Object.keys(input).some(key => !['original', 'target', 'assessment', 'ledger', 'claimHistory', 'claim'].includes(key))
      || !['original', 'assessment', 'ledger'].every(key => Object.hasOwn(input, key))) fail('input_invalid');
  const { original, assessment, ledger } = input, amounts = paidOriginal(original);
  const current = assessmentReview(assessment, original, amounts);
  const history = input.claimHistory === undefined ? [] : input.claimHistory;
  if (!Array.isArray(history) || history.length > 1000) fail('claim_history_invalid');
  let highWater = current.potential;
  const seen = new Set();
  for (const prior of history) {
    const checked = assessmentReview(prior, original, amounts);
    if (seen.has(prior.assessmentWatermark)) fail('claim_history_duplicate');
    seen.add(prior.assessmentWatermark);
    if (checked.potential > highWater) highWater = checked.potential;
  }
  const claim = input.claim ?? null;
  if (claim !== null && (!exact(claim, ['id', 'firstAssessedCents']) || !UUID.test(claim.id || '') || money(claim.firstAssessedCents) > amounts.net - amounts.fixed)) fail('claim_invalid');
  const firstAssessed = claim ? money(claim.firstAssessedCents) : current.potential;
  if (firstAssessed > highWater) highWater = firstAssessed;
  const normalized = normalizeLedger(ledger, original), events = normalized.events;
  let consumed = 0n, incoming = 0n;
  for (const event of events) {
    const sign = event.kind === 'release' ? -1n : 1n;
    if (claim && event.sourceKind === 'period_v2' && event.cohortClaimId === claim.id && event.originalEntryId !== original.id) fail('claim_ledger_mismatch');
    if (event.originalEntryId === original.id) {
      // The complete run-level exclusivity check belongs to the future SQL
      // writer. This employee ledger proves exclusivity for this paid entry.
      if (event.sourceKind !== 'period_v2') fail('mixed_original_basis');
      if (!claim || event.cohortClaimId !== claim.id) fail('claim_ledger_mismatch');
      consumed += sign * money(event.amountCents);
    }
    if (event.targetEntryId === original.id) {
      if (event.originalEntryId === original.id || event.kind === 'waive') fail('original_settlement_ledger_invalid');
      incoming += sign * money(event.amountCents);
    }
  }
  if (incoming < 0n || incoming !== amounts.gross - amounts.net) fail('original_settlement_ledger_invalid');
  if (consumed < 0n) fail('ledger_invalid');
  if (consumed > current.potential) fail('current_potential_below_dispositions');
  return { original, assessment, amounts, current, claim, firstAssessed, highWater, consumed,
    available: current.potential - consumed, events, ledgerHash: normalized.ledgerHash,
    historyWatermark: hash([...history.map(prior => prior.assessmentWatermark)].sort()) };
};
const basis = context => ({ schemaVersion: 3, policyCode: POLICY, basisKind: 'period_variable',
  venueId: context.original.venueId, employeeId: context.original.employeeId, currency: 'RUB',
  originalEntryId: context.original.id, originalRunId: context.original.runId,
  originalProvenanceSha256: context.original.provenanceSha256,
  originalPeriod: { from: context.original.periodFrom, to: context.original.periodTo },
  originalExpenseId: context.original.expense?.id || null, originalPaidCents: safe(context.amounts.net),
  ...(context.original.settlement ? { originalSettlementTransitionId: context.original.settlement.transitionId } : {}),
  claimId: context.claim?.id || null, firstAssessedCents: safe(context.firstAssessed),
  currentPotentialCents: safe(context.current.potential), highWaterAssessedCents: safe(context.highWater),
  alreadyDisposedCents: safe(context.consumed), availableReviewCents: safe(context.available),
  assessmentHash: context.assessment.assessmentWatermark, sourceHash: context.assessment.sourceCohortSha256,
  ledgerHash: context.ledgerHash, claimHistoryWatermark: context.historyWatermark,
  positiveEntitlementInformationCents: context.current.review.positiveEntitlementInformationCents,
  positiveEntitlementAction: 'none' });
const allocation = context => ({ basisKind: 'period_variable', claimId: context.claim?.id || null,
  assessedCents: safe(context.current.potential), firstAssessedCents: safe(context.firstAssessed),
  highWaterAssessedCents: safe(context.highWater), alreadyDisposedCents: safe(context.consumed) });
const finish = plan => {
  const result = { ...plan, ownerDecisionRequired: true, officialReady: false, payoutEligible: false,
    sourceAttested: false, deltaApplicationEligible: false, financialAction: 'none', persistence: 'none' };
  return freeze({ ...result, planHash: hash(result) });
};
function buildRefundAwareCorrectionPlan(input) {
  const context = prepare(input), target = input.target, amounts = entry(target), { original } = context;
  if (target.status !== 'draft' || target.venueId !== original.venueId || target.employeeId !== original.employeeId
      || target.periodFrom <= original.periodTo || target.id === original.id || target.runId === original.runId) fail('target_draft_invalid');
  let incoming = 0n;
  for (const event of context.events) if (event.targetEntryId === target.id) {
    if (event.originalEntryId === target.id || event.kind === 'waive') fail('target_ledger_mismatch');
    incoming += (event.kind === 'release' ? -1n : 1n) * money(event.amountCents);
  }
  if (incoming < 0n || incoming > amounts.variable || amounts.gross - incoming !== amounts.net) fail('target_ledger_mismatch');
  const capacity = amounts.net - amounts.fixed, selected = context.available < capacity ? context.available : capacity;
  return finish({ ...basis(context), operation: 'apply', targetEntryId: target.id, targetRunId: target.runId,
    targetProvenanceSha256: target.provenanceSha256, targetPeriod: { from: target.periodFrom, to: target.periodTo },
    targetBeforeCents: safe(amounts.net), protectedFixedCents: safe(amounts.fixed), availableVariableCents: safe(capacity),
    applyCents: safe(selected), targetAfterCents: safe(amounts.net - selected), residualReviewCents: safe(context.available - selected),
    allocations: [{ ...allocation(context), applyCents: safe(selected), residualReviewCents: safe(context.available - selected) }] });
}
function buildRefundAwareCorrectionWaiverPlan(input) {
  const context = prepare(input);
  if (input.target !== undefined && input.target !== null) fail('waiver_target_forbidden');
  return finish({ ...basis(context), operation: 'waive', targetEntryId: null, waiveCents: safe(context.available),
    allocations: [{ ...allocation(context), waiveCents: safe(context.available) }] });
}
module.exports = { buildRefundAwareCorrectionPlan, buildRefundAwareCorrectionWaiverPlan,
  PAYROLL_REFUND_AWARE_CORRECTION_POLICY: POLICY };
