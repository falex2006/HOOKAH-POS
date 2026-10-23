'use strict';

// Pure allocation arithmetic over server-normalized, transaction-bound evidence.
// This is not authorization: the service must verify owner, source completeness,
// expense linkage, current assessment and ledger completeness under the fence.
const { createHash } = require('node:crypto');
const { normalizePayrollCorrectionLedgerEvent, samePayrollCorrectionSource } = require('./payroll-correction-ledger-source');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA = /^[a-f0-9]{64}$/;
const MAX = BigInt(Number.MAX_SAFE_INTEGER);
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}` : JSON.stringify(value);
const fail = code => { throw Object.assign(new Error(`payroll_correction_${code}`), { code: `payroll_correction_${code}`, status: 409 }); };
const id = value => { if (typeof value !== 'string' || !UUID.test(value)) fail('identity_invalid'); return value; };
const money = value => { if (!Number.isSafeInteger(value) || value < 0) fail('amount_invalid'); return BigInt(value); };
const normalizeLedgerEvent = (event, scope) => {
  try {
    return normalizePayrollCorrectionLedgerEvent(event, { venueId: scope.venueId, employeeId: scope.employeeId });
  } catch (error) {
    if (error.code === 'payroll_correction_ledger_identity_invalid') fail('identity_invalid');
    if (error.code === 'payroll_correction_ledger_amount_invalid'
        && Object.getOwnPropertyDescriptor(event, 'amountCents')?.value !== 0) fail('amount_invalid');
    if (error.code?.startsWith('payroll_correction_ledger_')) fail('ledger_invalid');
    throw error;
  }
};
const date = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)
      || !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) fail('period_invalid');
  return value;
};
const safe = value => { if (value < 0n || value > MAX) fail('total_overflow'); return Number(value); };
const entry = value => {
  if (!value || value.origin !== 'calculation_run' || value.currency !== 'RUB'
      || !SHA.test(value.provenanceSha256 || '')) fail('entry_basis_invalid');
  for (const key of ['id', 'venueId', 'employeeId', 'runId']) id(value[key]);
  if (date(value.periodFrom) > date(value.periodTo)) fail('period_invalid');
  const gross = money(value.grossCents), net = money(value.netCents);
  if (net > gross) fail('entry_basis_invalid');
  return { gross, net };
};
const prepareSource = ({ original, assessment, ledger }) => {
  const originalMoney = entry(original);
  if (original.status !== 'paid') fail('original_paid_basis_required');
  if (original.settlement !== undefined) {
    const settled = original.settlement;
    if (!settled || settled.kind !== 'zero' || original.expense !== null || originalMoney.net !== 0n
        || settled.venueId !== original.venueId || settled.entryId !== original.id || settled.employeeId !== original.employeeId
        || settled.runId !== original.runId || settled.provenanceSha256 !== original.provenanceSha256
        || money(settled.grossCents) !== originalMoney.gross || settled.netCents !== 0 || settled.protectedFixedCents !== 0
        || money(settled.incomingCorrectionCents) !== originalMoney.gross
        || typeof settled.paidAt !== 'string' || !Number.isFinite(Date.parse(settled.paidAt))) fail('original_paid_basis_required');
    id(settled.transitionId); id(settled.paidBy); date(settled.paymentDate);
  } else {
    if (!original.expense || original.expense.source !== 'payroll' || original.expense.venueId !== original.venueId
        || original.expense.entryId !== original.id || money(original.expense.amountCents) !== originalMoney.net) fail('original_paid_basis_required');
    id(original.expense.id);
  }
  if (!assessment || assessment.coverage !== 'complete' || assessment.venueId !== original.venueId
      || assessment.runId !== original.runId || assessment.provenanceSha256 !== original.provenanceSha256
      || !SHA.test(assessment.assessmentHash || '') || !SHA.test(assessment.sourceHash || '')
      || !Array.isArray(assessment.lines) || assessment.lines.length > 20000) fail('assessment_required');
  if (!Array.isArray(ledger) || ledger.length > 100000) fail('ledger_invalid');
  const sources = new Map();
  for (const line of assessment.lines) {
    if (line.employeeId !== original.employeeId) continue;
    const key = id(line.refundLineEventId);
    id(line.sourceSnapshotLineId);
    if (sources.has(key) || !Number.isSafeInteger(line.salaryImpactCents) || line.salaryImpactCents > 0
        || !Array.isArray(line.reasons) || line.reasons.length) fail('assessment_line_invalid');
    sources.set(key, { line, total: money(-line.salaryImpactCents), consumed: 0n });
  }
  const events = new Map(), releases = new Set(), sequences = new Set();
  // Resolve references independently of query order. Event IDs are immutable;
  // a cancellation releases a whole application exactly once, never a waiver.
  for (const inputEvent of ledger) {
    const event = normalizeLedgerEvent(inputEvent, original);
    if (events.has(event.id) || sequences.has(event.sequenceNo)) fail('ledger_invalid');
    // Foreign period claims share incoming target capacity. This legacy source
    // assessment can never dispose a period claim belonging to its own entry.
    if (event.sourceKind === 'period_v2' && event.originalEntryId === original.id) fail('source_basis_mismatch');
    if (sources.has(event.refundLineEventId) && event.originalEntryId !== original.id) fail('source_original_entry_mismatch');
    sequences.add(event.sequenceNo);
    events.set(event.id, event);
  }
  for (const event of [...events.values()].sort((a, b) => a.sequenceNo - b.sequenceNo)) {
    const cents = money(event.amountCents);
    let sign = 1n;
    if (event.kind === 'release') {
      const parent = events.get(id(event.reversesEventId));
      if (!parent || parent.kind !== 'apply' || parent.sequenceNo >= event.sequenceNo || releases.has(parent.id) || parent.amountCents !== event.amountCents
          || !samePayrollCorrectionSource(parent, event)
          || parent.targetEntryId !== event.targetEntryId) fail('release_invalid');
      releases.add(parent.id); sign = -1n;
    }
    if (event.originalEntryId === original.id) {
      const source = sources.get(event.refundLineEventId);
      if (!source) fail('source_disposition_missing_from_assessment');
      source.consumed += sign * cents;
      if (source.consumed < 0n || source.consumed > source.total) fail('source_overallocated');
    }
  }
  if (original.settlement) {
    let incoming = 0n;
    for (const event of [...events.values()].sort((a, b) => a.sequenceNo - b.sequenceNo)) {
      if (event.targetEntryId !== original.id) continue;
      if (event.originalEntryId === original.id || event.kind === 'waive') fail('original_settlement_ledger_invalid');
      incoming += (event.kind === 'release' ? -1n : 1n) * money(event.amountCents);
      if (incoming < 0n || incoming > originalMoney.gross) fail('original_settlement_ledger_invalid');
    }
    if (incoming !== originalMoney.gross) fail('original_settlement_ledger_invalid');
  }
  return { originalMoney, sources, events };
};
const ledgerHash = events => createHash('sha256').update(canonical([...events.values()].sort((a, b) => a.id.localeCompare(b.id)))).digest('hex');
const finish = plan => ({ ...plan, planHash: createHash('sha256').update(canonical(plan)).digest('hex') });
const sourceBasis = (original, assessment, originalMoney, events) => ({
  schemaVersion: 1, policyVersion: original.settlement ? 'owner-reviewed-variable-correction-v2' : 'owner-reviewed-variable-correction-v1',
  venueId: original.venueId, employeeId: original.employeeId, currency: 'RUB', originalEntryId: original.id,
  originalRunId: original.runId, originalProvenanceSha256: original.provenanceSha256,
  originalPeriod: { from: original.periodFrom, to: original.periodTo },
  originalExpenseId: original.expense?.id || null, originalPaidCents: safe(originalMoney.net),
  ...(original.settlement ? { originalSettlementTransitionId: original.settlement.transitionId } : {}),
  assessmentHash: assessment.assessmentHash, sourceHash: assessment.sourceHash, ledgerHash: ledgerHash(events)
});
const buildReviewedCorrectionPlan = ({ original, target, assessment, ledger }) => {
  const targetMoney = entry(target);
  if (target.status !== 'draft' || target.venueId !== original.venueId || target.employeeId !== original.employeeId
      || target.periodFrom <= original.periodTo || target.id === original.id || target.runId === original.runId) fail('target_draft_invalid');
  const fixed = money(target.protectedFixedCents), variable = money(target.eligibleVariableCents);
  if (fixed + variable !== targetMoney.gross || targetMoney.net < fixed) fail('target_variable_basis_invalid');
  const { originalMoney, sources, events } = prepareSource({ original, assessment, ledger });
  let targetUsed = 0n;
  for (const event of [...events.values()].sort((a, b) => a.sequenceNo - b.sequenceNo)) {
    if (event.targetEntryId === target.id) targetUsed += (event.kind === 'release' ? -1n : 1n) * money(event.amountCents);
    if (targetUsed < 0n || targetUsed > variable) fail('target_ledger_mismatch');
  }
  if (targetUsed < 0n || targetUsed > variable || targetMoney.gross - targetUsed !== targetMoney.net) fail('target_ledger_mismatch');
  let capacity = variable - targetUsed, remaining = 0n, apply = 0n;
  const allocations = [];
  for (const [sourceId, source] of [...sources].sort(([a], [b]) => a.localeCompare(b))) {
    if (source.consumed < 0n || source.consumed > source.total) fail('source_overallocated');
    const available = source.total - source.consumed;
    const selected = available < capacity ? available : capacity;
    capacity -= selected; apply += selected; remaining += available - selected;
    allocations.push({ refundLineEventId: sourceId, sourceSnapshotLineId: source.line.sourceSnapshotLineId,
      assessedCents: safe(source.total), alreadyDisposedCents: safe(source.consumed),
      applyCents: safe(selected), residualReviewCents: safe(available - selected) });
  }
  const plan = { ...sourceBasis(original, assessment, originalMoney, events),
    targetEntryId: target.id, targetRunId: target.runId, targetProvenanceSha256: target.provenanceSha256,
    targetPeriod: { from: target.periodFrom, to: target.periodTo },
    targetBeforeCents: safe(targetMoney.net), protectedFixedCents: safe(fixed),
    availableVariableCents: safe(variable - targetUsed), applyCents: safe(apply),
    targetAfterCents: safe(targetMoney.net - apply), residualReviewCents: safe(remaining), allocations,
    ownerDecisionRequired: true, officialReady: false, payoutEligible: false, persistence: 'none' };
  return finish(plan);
};

// A waiver consumes only the currently proven undisposed increment. It has no
// target entry and cannot depend on the existence/capacity of a later payroll.
const buildReviewedCorrectionWaiverPlan = ({ original, assessment, ledger }) => {
  const { originalMoney, sources, events } = prepareSource({ original, assessment, ledger });
  let waive = 0n;
  const allocations = [...sources].sort(([a], [b]) => a.localeCompare(b)).map(([sourceId, source]) => {
    const remaining = source.total - source.consumed; waive += remaining;
    return { refundLineEventId: sourceId, sourceSnapshotLineId: source.line.sourceSnapshotLineId,
      assessedCents: safe(source.total), alreadyDisposedCents: safe(source.consumed), waiveCents: safe(remaining) };
  });
  return finish({ ...sourceBasis(original, assessment, originalMoney, events), operation: 'waive',
    targetEntryId: null, waiveCents: safe(waive), allocations,
    ownerDecisionRequired: true, officialReady: false, payoutEligible: false, persistence: 'none' });
};

// The reader supplies all unreleased applications for this target under the
// same transaction locks. Paid entries cannot be cancelled. Released source
// amounts return to review; this plan never picks a replacement target.
const buildReviewedCorrectionReleasePlan = ({ target, applications }) => {
  const targetMoney = entry(target);
  if (!['draft', 'approved'].includes(target.status)) fail('cancellation_target_invalid');
  const fixed = money(target.protectedFixedCents), variable = money(target.eligibleVariableCents);
  if (fixed + variable !== targetMoney.gross || targetMoney.net < fixed) fail('target_variable_basis_invalid');
  if (!Array.isArray(applications) || applications.length > 100000) fail('ledger_invalid');
  const ids = new Set(), sequences = new Set();
  let released = 0n;
  const normalizedApplications = applications.map(event => normalizeLedgerEvent(event, target));
  const releases = normalizedApplications.map(event => {
    if (event.kind !== 'apply' || event.targetEntryId !== target.id || event.venueId !== target.venueId
        || event.employeeId !== target.employeeId || event.currency !== 'RUB' || event.reversesEventId !== null
        || event.originalEntryId === target.id || ids.has(event.id) || sequences.has(event.sequenceNo)
        || !Number.isSafeInteger(event.sequenceNo) || event.sequenceNo <= 0 || money(event.amountCents) === 0n) fail('ledger_invalid');
    ids.add(event.id); sequences.add(event.sequenceNo); released += money(event.amountCents);
    return { reversesEventId: event.id, originalEntryId: event.originalEntryId,
      refundLineEventId: event.refundLineEventId, amountCents: event.amountCents,
      ...(event.sourceKind === 'period_v2' ? { sourceKind: 'period_v2', cohortClaimId: event.cohortClaimId,
        cohortAssessmentId: event.cohortAssessmentId } : {}) };
  }).sort((a, b) => a.reversesEventId.localeCompare(b.reversesEventId));
  if (released > variable || targetMoney.gross - released !== targetMoney.net) fail('target_ledger_mismatch');
  return finish({ schemaVersion: 1, policyVersion: 'owner-reviewed-variable-correction-v1', operation: 'release',
    venueId: target.venueId, employeeId: target.employeeId, currency: 'RUB', targetEntryId: target.id,
    targetRunId: target.runId, targetProvenanceSha256: target.provenanceSha256,
    targetPeriod: { from: target.periodFrom, to: target.periodTo }, targetStatus: target.status,
    targetBeforeCents: safe(targetMoney.net), cancelledHistoricalCents: safe(targetMoney.net),
    protectedFixedCents: safe(fixed), releaseCents: safe(released), releases,
    ledgerHash: ledgerHash(new Map(normalizedApplications.map(event => [event.id, event]))),
    ownerDecisionRequired: true, officialReady: false, payoutEligible: false, persistence: 'none' });
};

module.exports = { buildReviewedCorrectionPlan, buildReviewedCorrectionWaiverPlan, buildReviewedCorrectionReleasePlan };
