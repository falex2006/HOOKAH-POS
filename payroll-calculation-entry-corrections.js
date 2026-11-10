'use strict';

// Approval/payment must revalidate every active correction against its actual
// paid source and a fresh complete refund assessment in the same source fence.
// An older approval, cached preview or stored claim is not freshness authority.
const { createHash } = require('node:crypto');
const { samePayrollCorrectionSource } = require('./payroll-correction-ledger-source');
const { hasPayrollVerifiedWriteSnapshot, hasPayrollVerifiedReadSnapshot } = require('./payroll-source-fence');
const { verifyPayrollCalculationEntryEvidence } = require('./payroll-calculation-entry-evidence');
const { collectPayrollRefundReviewAssessment } = require('./payroll-refund-review-assessment');
const { buildReviewedCorrectionWaiverPlan } = require('./payroll-reviewed-correction-policy');
const { readReviewedCorrectionLedger } = require('./payroll-reviewed-correction-store');
const fail = code => { throw Object.assign(new Error(`payroll_entry_corrections_${code}`), { code: `payroll_entry_corrections_${code}`, status: 409 }); };
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}` : JSON.stringify(value);
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const freeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
async function verifyPayrollEntryCorrections(db, actor, proof) {
  if (!proof || proof.proofKind !== 'current_transition' || proof.venueId !== actor?.venueId
      || proof.freshness?.status !== 'current' || !['draft', 'approved'].includes(proof.entryStatus)
      || proof.currency !== 'RUB' || proof.origin !== 'calculation_run'
      || ['grossCents', 'netCents', 'protectedFixedCents', 'eligibleVariableCents'].some(key =>
        !Number.isSafeInteger(proof[key]) || proof[key] < 0 || proof[key] > 999999999999)
      || proof.protectedFixedCents + proof.eligibleVariableCents !== proof.grossCents
      || !hasPayrollVerifiedWriteSnapshot(db, actor.venueId)) fail('current_source_proof_required');
  const ledger = await readReviewedCorrectionLedger(db, actor, proof.employeeId);
  const active = new Map();
  let used = 0n;
  for (const event of ledger) {
    if (event.targetEntryId !== proof.entryId) continue;
    if (event.kind === 'apply') {
      if (active.has(event.id) || !Number.isSafeInteger(event.amountCents) || event.amountCents <= 0) fail('ledger_invalid');
      active.set(event.id, event); used += BigInt(event.amountCents);
    } else if (event.kind === 'release') {
      const parent = active.get(event.reversesEventId);
      if (!parent || parent.amountCents !== event.amountCents || parent.originalEntryId !== event.originalEntryId
          || !samePayrollCorrectionSource(parent, event)) fail('ledger_invalid');
      active.delete(parent.id); used -= BigInt(event.amountCents);
    } else fail('ledger_invalid');
    if (used < 0n || used > BigInt(proof.eligibleVariableCents)) fail('target_capacity_invalid');
  }
  if (BigInt(proof.grossCents) - used !== BigInt(proof.netCents)
      || proof.netCents < proof.protectedFixedCents) fail('target_net_mismatch');
  const originalIds = [...new Set([...active.values()].map(event => event.originalEntryId))].sort();
  const sources = [];
  if (originalIds.length) {
    const rows = (await db.query(`SELECT *,period_from::text AS period_from,period_to::text AS period_to
      FROM payroll_entries WHERE venue_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR SHARE`,
      [actor.venueId, originalIds])).rows;
    if (rows.length !== originalIds.length) fail('original_missing');
    for (const originalId of originalIds) {
      const row = rows.find(item => item.id === originalId);
      if (!row || row.user_id !== proof.employeeId || row.id === proof.entryId) fail('original_mismatch');
      if ([...active.values()].some(event => event.originalEntryId === originalId && event.sourceKind === 'period_v2')) {
        const { collectRefundAwareCorrectionContext } = require('./payroll-refund-aware-correction-store');
        const { buildRefundAwareCorrectionWaiverPlan } = require('./payroll-refund-aware-correction-policy');
        const context = await collectRefundAwareCorrectionContext(db, actor,
          { operation: 'waive', originalEntryId: originalId, targetEntryId: null });
        if (context.original.id !== originalId || context.original.employeeId !== proof.employeeId
            || context.original.periodTo >= proof.periodFrom) fail('original_period_invalid');
        // Validation only: recompute the complete current cohort and reject
        // dispositions above today's potential. This never creates a waiver.
        const assessed = buildRefundAwareCorrectionWaiverPlan(context);
        sources.push({ originalEntryId: originalId, originalProvenanceSha256: context.original.provenanceSha256,
          assessmentHash: assessed.assessmentHash, sourceHash: assessed.sourceHash });
        continue;
      }
      const originalProof = await verifyPayrollCalculationEntryEvidence(db, actor, row, { purpose: 'historical_paid' });
      const payload = await collectPayrollRefundReviewAssessment(db, actor, originalProof.runId);
      const original = { id: originalProof.entryId, venueId: originalProof.venueId, employeeId: originalProof.employeeId,
        runId: originalProof.runId, origin: originalProof.origin, currency: originalProof.currency,
        provenanceSha256: originalProof.evidenceHashes.provenanceSha256, periodFrom: originalProof.periodFrom,
        periodTo: originalProof.periodTo, status: originalProof.entryStatus, grossCents: originalProof.grossCents,
        netCents: originalProof.netCents, expense: originalProof.expense,
        ...(originalProof.settlement ? { settlement: originalProof.settlement } : {}) };
      if (original.periodTo >= proof.periodFrom) fail('original_period_invalid');
      const assessed = buildReviewedCorrectionWaiverPlan({ original, assessment: { ...payload, assessmentHash: hash(payload) }, ledger });
      // The plan here is validation only. Nothing is waived or automatically
      // applied, including newly discovered residual amounts from later returns.
      sources.push({ originalEntryId: original.id, originalProvenanceSha256: original.provenanceSha256,
        assessmentHash: assessed.assessmentHash, sourceHash: assessed.sourceHash });
    }
  }
  const result = { schemaVersion: 1, entryId: proof.entryId, venueId: proof.venueId, employeeId: proof.employeeId,
    netCents: proof.netCents, protectedFixedCents: proof.protectedFixedCents, appliedCents: Number(used),
    ledgerHash: hash([...ledger].sort((a, b) => a.id.localeCompare(b.id))),
    ...(['employee_attributed_remaining_net_refund_v2','employee_attributed_h1_fixed_shifts_v1','payroll-deferred-month-settlement-v1'].includes(proof.capabilityVersion)
      ? { ledgerCaptureSchemaVersion: 1, ledgerEventIds: ledger.map(event => event.id).sort() } : {}),
    activeApplicationIds: [...active.keys()].sort(), sources };
  return freeze({ ...result, correctionEvidenceHash: hash(result) });
}
// Verify the ledger captured by the immutable approval/payment receipt. Later
// journal events for another entry can legitimately exist for the employee.
async function verifyCapturedH1Corrections(db, actor, proof, capture, readOnly = false) {
  const verifiedSnapshot = readOnly ? hasPayrollVerifiedReadSnapshot : hasPayrollVerifiedWriteSnapshot;
  if (!verifiedSnapshot(db, actor.venueId) || proof.venueId !== actor.venueId
      || capture?.ledgerCaptureSchemaVersion !== 1 || capture.entryId !== proof.entryId
      || capture.employeeId !== proof.employeeId || capture.venueId !== proof.venueId
      || capture.netCents !== proof.netCents || capture.protectedFixedCents !== proof.protectedFixedCents
      || !Array.isArray(capture.ledgerEventIds) || !Array.isArray(capture.activeApplicationIds)) fail('capture_invalid');
  const {correctionEvidenceHash, ...basis} = capture;
  if (hash(basis) !== correctionEvidenceHash) fail('capture_invalid');
  const ids = new Set(capture.ledgerEventIds);
  if (ids.size !== capture.ledgerEventIds.length) fail('capture_invalid');
  const history = await readReviewedCorrectionLedger(db, actor, proof.employeeId, readOnly);
  const frozen = history.filter(event => ids.has(event.id));
  if (ids.size !== frozen.length || hash([...frozen].sort((a,b) => a.id.localeCompare(b.id))) !== capture.ledgerHash
      || history.some(event => event.targetEntryId === proof.entryId && !ids.has(event.id))) fail('capture_invalid');
  const applications = new Map();
  let applied = 0;
  for (const event of frozen.filter(row => row.targetEntryId === proof.entryId)) {
    if (!Number.isSafeInteger(event.amountCents) || event.amountCents <= 0) fail('capture_invalid');
    if (event.kind === 'apply' && !applications.has(event.id)) {
      applications.set(event.id, event);
      applied += event.amountCents;
    } else if (event.kind === 'release') {
      const original = applications.get(event.reversesEventId);
      if (!original || original.amountCents !== event.amountCents || original.originalEntryId !== event.originalEntryId
          || !samePayrollCorrectionSource(original, event)) fail('capture_invalid');
      applications.delete(original.id);
      applied -= event.amountCents;
    } else fail('capture_invalid');
    if (applied < 0 || applied > proof.eligibleVariableCents) fail('capture_invalid');
  }
  if (hash([...applications.keys()].sort()) !== hash(capture.activeApplicationIds)
      || applied !== capture.appliedCents || proof.grossCents - applied !== proof.netCents) fail('capture_invalid');
  return capture;
}
module.exports = { verifyPayrollEntryCorrections, verifyCapturedH1Corrections };
