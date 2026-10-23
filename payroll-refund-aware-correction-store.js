'use strict';

// Private period-basis writer. Caller owns the source-fenced transaction and its
// commit/rollback. No public endpoint, finance expense, or transaction ownership.
const { createHash, randomUUID } = require('node:crypto');
const { hasPayrollVerifiedWriteSnapshot } = require('./payroll-source-fence');
const { verifyPayrollCalculationEntryEvidence } = require('./payroll-calculation-entry-evidence');
const { collectPayrollRefundAwarePaidReviewInTransaction } = require('./payroll-refund-aware-paid-review-source');
const { readReviewedCorrectionLedger } = require('./payroll-reviewed-correction-store');
const { normalizeReviewedCorrectionPreview, normalizeReviewedCorrectionCommand } = require('./payroll-reviewed-correction-command');
const { buildRefundAwareCorrectionPlan, buildRefundAwareCorrectionWaiverPlan,
  PAYROLL_REFUND_AWARE_CORRECTION_POLICY: POLICY } = require('./payroll-refund-aware-correction-policy');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA = /^[a-f0-9]{64}$/;
const fail = (suffix, status = 409) => { throw Object.assign(new Error(`payroll_refund_correction_${suffix}`), {
  code: `payroll_refund_correction_${suffix}`, status
}); };
const plain = value => Boolean(value && Object.getPrototypeOf(value) === Object.prototype
  && Reflect.ownKeys(value).every(key => typeof key === 'string')
  && Object.values(Object.getOwnPropertyDescriptors(value)).every(descriptor => Object.hasOwn(descriptor, 'value')));
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const digest = value => createHash('sha256').update(value).digest('hex');
const integer = value => {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value) || BigInt(value) > 999999999999n) fail('stored_integer_invalid');
  return Number(value);
};
const decimal = value => `${BigInt(value) / 100n}.${String(BigInt(value) % 100n).padStart(2, '0')}`;
const proofEntry = proof => ({ id: proof.entryId, venueId: proof.venueId, employeeId: proof.employeeId,
  runId: proof.runId, origin: proof.origin, currency: proof.currency, provenanceSha256: proof.evidenceHashes.provenanceSha256,
  periodFrom: proof.periodFrom, periodTo: proof.periodTo, status: proof.entryStatus, grossCents: proof.grossCents,
  netCents: proof.netCents, protectedFixedCents: proof.protectedFixedCents, eligibleVariableCents: proof.eligibleVariableCents,
  expense: proof.expense, evidenceHashes: proof.evidenceHashes, ...(proof.settlement ? { settlement: proof.settlement } : {}) });
async function requireOwner(db, actor) {
  if (!db || typeof db.query !== 'function' || !plain(actor) || typeof actor.venueId !== 'string' || typeof actor.userId !== 'string'
      || !UUID.test(actor.venueId) || !UUID.test(actor.userId)
      || !hasPayrollVerifiedWriteSnapshot(db, actor.venueId)) fail('source_transaction_required');
  const row = (await db.query("SELECT full_name FROM users WHERE venue_id=$1 AND id=$2 AND role='owner' AND is_active=true AND deleted_at IS NULL FOR SHARE",
    [actor.venueId, actor.userId])).rows[0];
  if (!row) fail('owner_required', 403);
  return { venueId: actor.venueId, userId: actor.userId, name: row.full_name };
}
const checkedAssessmentRow = (row, original) => {
  if (!row || !UUID.test(row.id || '') || row.venue_id !== original.venueId || row.run_id !== original.runId
      || row.provenance_sha256 !== original.provenanceSha256 || typeof row.payload !== 'string' || row.payload.length > 40 * 1024 * 1024
      || !SHA.test(row.assessment_hash || '') || !SHA.test(row.source_hash || '') || digest(row.payload) !== row.assessment_hash) fail('assessment_history_invalid');
  let payload;
  try { payload = JSON.parse(row.payload); } catch (_) { fail('assessment_history_invalid'); }
  if (!plain(payload) || Object.hasOwn(payload, 'assessmentWatermark') || canonical(payload) !== row.payload
      || payload.venueId !== original.venueId || payload.runId !== original.runId || payload.originalProvenanceSha256 !== original.provenanceSha256
      || payload.sourceCohortSha256 !== row.source_hash || !Array.isArray(payload.paidReviews)) fail('assessment_history_invalid');
  return { ...payload, assessmentWatermark: row.assessment_hash };
};
async function collectContext(db, actor, command, checkFreshness) {
  const ids = [...new Set([command.originalEntryId, command.targetEntryId].filter(Boolean))].sort();
  const rows = (await db.query(`SELECT *,period_from::text AS period_from,period_to::text AS period_to
    FROM payroll_entries WHERE venue_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE`, [actor.venueId, ids])).rows;
  const originalRow = rows.find(row => row.id === command.originalEntryId), targetRow = rows.find(row => row.id === command.targetEntryId);
  if (!originalRow || (command.operation === 'apply' && !targetRow)) fail('entry_not_found', 404);
  const run = (await db.query(`SELECT id,engine_version,input_checksum FROM payroll_calculation_runs
    WHERE venue_id=$1 AND id=$2 FOR UPDATE`, [actor.venueId, originalRow.calculation_run_id])).rows[0];
  if (!run || run.engine_version !== 'payroll-verified-remaining-net-v2' || run.input_checksum !== originalRow.calculation_provenance_sha256) fail('original_run_not_v2');
  // Lock the entire immutable original run before checking every employee's
  // claims. An employee-scoped ledger alone cannot prove basis exclusivity.
  const mixed = (await db.query(`SELECT c.id FROM payroll_correction_claims c JOIN payroll_entries e
    ON e.venue_id=c.venue_id AND e.id=c.original_entry_id
    WHERE c.venue_id=$1 AND e.calculation_run_id=$2 AND c.source_kind='line_v1' LIMIT 1`,
  [actor.venueId, run.id])).rows;
  if (mixed.length) fail('mixed_original_basis');
  const originalProof = await verifyPayrollCalculationEntryEvidence(db, actor, originalRow, { purpose: 'historical_paid' });
  const targetProof = command.operation === 'apply'
    ? await verifyPayrollCalculationEntryEvidence(db, actor, targetRow, { purpose: 'current_transition', checkFreshness }) : null;
  const original = proofEntry(originalProof);
  const collected = await collectPayrollRefundAwarePaidReviewInTransaction(db, actor, original.runId);
  if (!plain(collected) || Object.keys(collected).sort().join(',') !== 'assessment,sourceCollection'
      || collected.sourceCollection !== 'verified_private_paid_entry_rows' || !plain(collected.assessment)) fail('assessment_collection_invalid');
  const historyRows = (await db.query(`SELECT id,venue_id,run_id,provenance_sha256,assessment_hash,source_hash,payload
    FROM payroll_refund_aware_paid_assessments WHERE venue_id=$1 AND run_id=$2 AND provenance_sha256=$3
    ORDER BY created_at,id LIMIT 1001`, [actor.venueId, original.runId, original.provenanceSha256])).rows;
  if (historyRows.length > 1000) fail('assessment_history_too_large');
  const historyById = new Map(), historyByHash = new Map();
  for (const row of historyRows) {
    const assessment = checkedAssessmentRow(row, original);
    if (historyById.has(row.id)) fail('assessment_history_invalid');
    historyById.set(row.id, assessment);
    const matches = assessment.paidReviews.filter(review => review?.entryId === original.id || review?.employeeId === original.employeeId);
    if (matches.length) {
      if (matches.length !== 1 || matches[0].entryId !== original.id || matches[0].employeeId !== original.employeeId) fail('assessment_history_invalid');
      historyByHash.set(assessment.assessmentWatermark, assessment);
    }
  }
  const claims = (await db.query(`SELECT id,original_entry_id,original_run_id,employee_id,original_provenance_sha256,
      original_expense_id,original_settlement_transition_id,assessed_cents::text,cohort_assessment_id,assessment_hash,source_hash,
      refund_line_event_id,source_snapshot_line_id,assessment_id
    FROM payroll_correction_claims WHERE venue_id=$1 AND original_entry_id=$2 AND employee_id=$3 AND source_kind='period_v2'
    ORDER BY id LIMIT 2 FOR UPDATE`, [actor.venueId, original.id, original.employeeId])).rows;
  if (claims.length > 1) fail('claim_basis_mismatch');
  let claim = null;
  if (claims.length) {
    const row = claims[0], first = historyById.get(row.cohort_assessment_id);
    const review = first?.paidReviews.find(item => item.entryId === original.id && item.employeeId === original.employeeId);
    if (!UUID.test(row.id || '') || row.original_run_id !== original.runId || row.original_provenance_sha256 !== original.provenanceSha256
        || row.original_entry_id !== original.id || row.employee_id !== original.employeeId
        || row.original_expense_id !== (original.expense?.id || null)
        || row.original_settlement_transition_id !== (original.settlement?.transitionId || null)
        || row.refund_line_event_id !== null || row.source_snapshot_line_id !== null || row.assessment_id !== null
        || !first || first.assessmentWatermark !== row.assessment_hash || first.sourceCohortSha256 !== row.source_hash
        || !review || integer(row.assessed_cents) !== review.potentialReductionReviewCents) fail('claim_basis_mismatch');
    claim = { id: row.id, firstAssessedCents: integer(row.assessed_cents) };
  }
  const ledger = await readReviewedCorrectionLedger(db, actor, original.employeeId);
  return { original, ...(targetProof ? { target: proofEntry(targetProof) } : {}), assessment: collected.assessment,
    ledger, claimHistory: [...historyByHash.values()], claim };
}
async function collectRefundAwareCorrectionContext(db, actor, input, checkFreshness) {
  const command = normalizeReviewedCorrectionPreview(input);
  actor = await requireOwner(db, actor);
  return collectContext(db, actor, command, checkFreshness);
}
const planFor = (operation, context) => operation === 'apply' ? buildRefundAwareCorrectionPlan(context) : buildRefundAwareCorrectionWaiverPlan(context);
async function previewRefundAwareCorrection(db, actor, input, checkFreshness) {
  const command = normalizeReviewedCorrectionPreview(input);
  return planFor(command.operation, await collectRefundAwareCorrectionContext(db, actor, command, checkFreshness));
}
async function readRefundAwareCorrectionContext(db, actor, originalEntryId) {
  const context = await collectRefundAwareCorrectionContext(db, actor, { operation: 'waive', originalEntryId, targetEntryId: null });
  const plan = buildRefundAwareCorrectionWaiverPlan(context), original = context.original;
  const rows = (await db.query(`SELECT id::text,calculation_run_id::text AS run_id,period_from::text,period_to::text,
      calculation_gross_cents::text AS gross_cents,(amount*100)::bigint::text AS net_cents,employee_name_snapshot,calculation_scheme_name_snapshot
    FROM payroll_entries WHERE venue_id=$1 AND user_id=$2 AND status='draft' AND calculation_run_id IS NOT NULL
      AND calculation_run_id<>$3 AND period_from>$4::date ORDER BY period_from,period_to,id LIMIT 201`,
  [original.venueId, original.employeeId, original.runId, original.periodTo])).rows;
  if (rows.length > 200) fail('target_list_too_large');
  const targets = rows.map(row => {
    const grossCents = integer(row.gross_cents), amountCents = integer(row.net_cents);
    if (amountCents > grossCents) fail('target_basis_invalid');
    return { id: row.id, runId: row.run_id, periodFrom: row.period_from, periodTo: row.period_to, grossCents, amountCents,
      employeeName: row.employee_name_snapshot, schemeName: row.calculation_scheme_name_snapshot, status: 'draft', requiresFreshPreview: true };
  });
  const history = context.ledger.filter(event => event.originalEntryId === original.id);
  const metadata = history.length ? (await db.query(`SELECT e.id,b.reason,b.created_by_name,b.created_at::text AS created_at
    FROM payroll_correction_events e JOIN payroll_correction_batches b ON b.venue_id=e.venue_id AND b.id=e.batch_id
    WHERE e.venue_id=$1 AND e.employee_id=$2 AND e.id=ANY($3::uuid[])`, [original.venueId, original.employeeId, history.map(event => event.id)])).rows : [];
  if (metadata.length !== history.length || new Set(metadata.map(row => row.id)).size !== history.length) fail('history_incomplete');
  const byId = new Map(metadata.map(row => [row.id, row]));
  return { schemaVersion: 3, policyCode: POLICY, original, targets, history: history.map(event => {
    const row = byId.get(event.id);
    if (!row || typeof row.reason !== 'string' || typeof row.created_by_name !== 'string' || typeof row.created_at !== 'string') fail('history_incomplete');
    return { ...event, reason: row.reason, createdByName: row.created_by_name, createdAt: row.created_at };
  }), remainingCents: plan.waiveCents, currentPotentialCents: plan.currentPotentialCents, highWaterAssessedCents: plan.highWaterAssessedCents,
  positiveEntitlementInformationCents: plan.positiveEntitlementInformationCents, positiveEntitlementAction: 'none',
  assessmentHash: plan.assessmentHash, sourceHash: plan.sourceHash, ledgerHash: plan.ledgerHash,
  requiresExplicitTarget: true, officialReady: false, payoutEligible: false };
}
const requestHashFor = (actor, command) => {
  const { idempotencyKey, ...intent } = command;
  return digest(canonical({ schemaVersion: 3, policyCode: POLICY, venueId: actor.venueId, actorId: actor.userId, ...intent }));
};
const replayReceipt = (row, actor, command, requestHash) => {
  if (row.request_hash !== requestHash || row.created_by !== actor.userId) fail('idempotency_conflict');
  if (typeof row.response_payload !== 'string' || digest(row.response_payload) !== row.response_hash) fail('request_integrity_invalid');
  let response;
  try { response = JSON.parse(row.response_payload); } catch (_) { fail('request_integrity_invalid'); }
  const keys = ['schemaVersion', 'policyCode', 'batchId', 'operation', 'planHash', 'totalCents', 'targetEntryId', 'targetAfterCents',
    'residualReviewCents', 'officialReady', 'payoutEligible', 'replayed'];
  if (!plain(response) || Object.keys(response).length !== keys.length || keys.some(key => !Object.hasOwn(response, key))
      || canonical(response) !== row.response_payload || response.schemaVersion !== 3 || response.policyCode !== POLICY || response.batchId !== row.batch_id
      || !UUID.test(response.batchId || '') || response.operation !== command.operation || response.targetEntryId !== command.targetEntryId
      || response.planHash !== command.expectedPlanHash || response.officialReady !== false || response.payoutEligible !== false
      || response.replayed !== false || !Number.isSafeInteger(response.totalCents) || response.totalCents <= 0 || response.totalCents > 999999999999
      || !Number.isSafeInteger(response.residualReviewCents) || response.residualReviewCents < 0 || response.residualReviewCents > 999999999999
      || (command.operation === 'waive' ? response.targetAfterCents !== null || response.residualReviewCents !== 0
        : !Number.isSafeInteger(response.targetAfterCents) || response.targetAfterCents < 0 || response.targetAfterCents > 999999999999)) fail('request_integrity_invalid');
  return { ...response, replayed: true };
};
async function saveAssessment(db, actor, context) {
  const { assessmentWatermark, ...body } = context.assessment, payload = canonical(body);
  if (digest(payload) !== assessmentWatermark) fail('assessment_hash_invalid');
  const rows = (await db.query(`SELECT id,venue_id,run_id,provenance_sha256,assessment_hash,source_hash,payload
    FROM payroll_refund_aware_paid_assessments WHERE venue_id=$1 AND run_id=$2 AND assessment_hash=$3 LIMIT 2`,
  [actor.venueId, context.original.runId, assessmentWatermark])).rows;
  if (rows.length > 1) fail('assessment_history_invalid');
  if (rows.length) {
    checkedAssessmentRow(rows[0], context.original);
    if (rows[0].payload !== payload) fail('assessment_history_invalid');
    return rows[0].id;
  }
  const id = randomUUID();
  await db.query(`INSERT INTO payroll_refund_aware_paid_assessments
    (id,venue_id,run_id,provenance_sha256,assessment_hash,source_hash,payload,created_by,created_by_name)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [id, actor.venueId, context.original.runId, context.original.provenanceSha256,
    assessmentWatermark, context.assessment.sourceCohortSha256, payload, actor.userId, actor.name]);
  return id;
}
async function applyRefundAwareCorrection(db, actor, input, checkFreshness) {
  const command = normalizeReviewedCorrectionCommand(input);
  actor = await requireOwner(db, actor);
  const requestHash = requestHashFor(actor, command);
  const previous = (await db.query(`SELECT request_hash,response_payload,response_hash,batch_id,created_by FROM payroll_correction_requests
    WHERE venue_id=$1 AND idempotency_key=$2 FOR UPDATE`, [actor.venueId, command.idempotencyKey])).rows[0];
  // Lost-response replay must not depend on today's returns, draft status, or
  // current capacity, which may have legitimately changed since this receipt.
  if (previous) return replayReceipt(previous, actor, command, requestHash);
  const context = await collectContext(db, actor, command, checkFreshness), plan = planFor(command.operation, context);
  if (plan.planHash !== command.expectedPlanHash) fail('plan_stale');
  const isApply = command.operation === 'apply', total = isApply ? plan.applyCents : plan.waiveCents;
  if (total === 0) fail('nothing_to_dispose');
  const { planHash, ...planBody } = plan, planPayload = canonical(planBody);
  if (digest(planPayload) !== planHash) fail('plan_integrity_invalid');
  const assessmentId = await saveAssessment(db, actor, context);
  let claimId = context.claim?.id || null;
  if (!claimId) {
    claimId = randomUUID();
    await db.query(`INSERT INTO payroll_correction_claims
      (id,venue_id,employee_id,currency,original_entry_id,original_run_id,original_expense_id,original_settlement_transition_id,
       original_provenance_sha256,refund_line_event_id,source_snapshot_line_id,assessment_id,assessment_hash,source_hash,assessed_cents,
       created_by,created_by_name,source_kind,cohort_assessment_id)
      VALUES($1,$2,$3,'RUB',$4,$5,$6,$7,$8,NULL,NULL,NULL,$9,$10,$11,$12,$13,'period_v2',$14)`,
    [claimId, actor.venueId, plan.employeeId, plan.originalEntryId, plan.originalRunId, plan.originalExpenseId,
      plan.originalSettlementTransitionId || null, plan.originalProvenanceSha256, plan.assessmentHash, plan.sourceHash,
      plan.firstAssessedCents, actor.userId, actor.name, assessmentId]);
  }
  const targetSequence = isApply ? integer((await db.query(`SELECT (COALESCE(max(target_sequence_no),0)+1)::text AS next
    FROM payroll_correction_batches WHERE venue_id=$1 AND target_entry_id=$2`, [actor.venueId, command.targetEntryId])).rows[0]?.next) : null;
  const batchId = randomUUID();
  await db.query(`INSERT INTO payroll_correction_batches
    (id,venue_id,employee_id,currency,operation,original_entry_id,target_entry_id,target_sequence_no,assessment_id,cohort_assessment_id,
     assessment_hash,source_hash,ledger_hash,plan_payload,plan_hash,event_count,total_cents,target_before_cents,target_after_cents,
     protected_fixed_cents,reason,created_by,created_by_name)
    VALUES($1,$2,$3,'RUB',$4,$5,$6,$7,NULL,$8,$9,$10,$11,$12,$13,1,$14,$15,$16,$17,$18,$19,$20)`,
  [batchId, actor.venueId, plan.employeeId, command.operation, command.originalEntryId, command.targetEntryId,
    targetSequence, assessmentId, plan.assessmentHash, plan.sourceHash, plan.ledgerHash, planPayload, planHash, total,
    isApply ? plan.targetBeforeCents : null, isApply ? plan.targetAfterCents : null, isApply ? plan.protectedFixedCents : null,
    command.reason, actor.userId, actor.name]);
  await db.query(`INSERT INTO payroll_correction_events
    (id,venue_id,employee_id,claim_id,batch_id,claim_sequence_no,kind,amount_cents,target_entry_id)
    SELECT $1,$2,$3,$4,$5,COALESCE(max(claim_sequence_no),0)+1,$6,$7,$8
    FROM payroll_correction_events WHERE venue_id=$2 AND claim_id=$4`,
  [randomUUID(), actor.venueId, plan.employeeId, claimId, batchId, command.operation, total, command.targetEntryId]);
  if (isApply) {
    const updated = await db.query(`UPDATE payroll_entries SET amount=$3::numeric WHERE venue_id=$1 AND id=$2 AND status='draft'
      AND amount=$4::numeric RETURNING id`, [actor.venueId, command.targetEntryId, decimal(plan.targetAfterCents), decimal(plan.targetBeforeCents)]);
    if (updated.rows.length !== 1) fail('target_changed');
  }
  const result = { schemaVersion: 3, policyCode: POLICY, batchId, operation: command.operation, planHash, totalCents: total,
    targetEntryId: command.targetEntryId, targetAfterCents: isApply ? plan.targetAfterCents : null,
    residualReviewCents: isApply ? plan.residualReviewCents : 0, officialReady: false, payoutEligible: false, replayed: false };
  const response = canonical(result);
  await db.query(`INSERT INTO payroll_correction_requests
    (venue_id,idempotency_key,request_hash,batch_id,created_by,response_payload,response_hash)
    VALUES($1,$2,$3,$4,$5,$6,$7)`, [actor.venueId, command.idempotencyKey, requestHash, batchId, actor.userId, response, digest(response)]);
  return result;
}
module.exports = { previewRefundAwareCorrection, readRefundAwareCorrectionContext, applyRefundAwareCorrection,
  collectRefundAwareCorrectionContext };
