'use strict';

// Fenced-transaction writer. Migration203 reconciles actual entry.amount;
// migration205 supplies the immutable approval, settlement and cancellation path.
const { createHash, randomUUID } = require('node:crypto');
const { payrollCorrectionLedgerEventFromRow } = require('./payroll-correction-ledger-source');
const { hasPayrollVerifiedWriteSnapshot } = require('./payroll-source-fence');
const { verifyPayrollCalculationEntryEvidence } = require('./payroll-calculation-entry-evidence');
const { collectPayrollRefundReviewAssessment } = require('./payroll-refund-review-assessment');
const { saveRefundReviewAssessment } = require('./payroll-refund-review-store');
const { buildReviewedCorrectionPlan, buildReviewedCorrectionWaiverPlan, buildReviewedCorrectionReleasePlan } = require('./payroll-reviewed-correction-policy');
const { normalizeReviewedCorrectionCommand, normalizeReviewedCorrectionPreview, reviewedCorrectionRequestHash, buildReviewedCorrectionCommand } = require('./payroll-reviewed-correction-command');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const fail = (code, status = 409) => { throw Object.assign(new Error(`payroll_correction_${code}`), { code: `payroll_correction_${code}`, status }); };
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}` : JSON.stringify(value);
const digest = value => createHash('sha256').update(value).digest('hex');
const integer = value => {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value))) fail('stored_integer_invalid');
  return Number(value);
};
const decimal = cents => `${BigInt(cents) / 100n}.${String(BigInt(cents) % 100n).padStart(2, '0')}`;
const proofEntry = proof => ({ id: proof.entryId, venueId: proof.venueId, employeeId: proof.employeeId,
  runId: proof.runId, origin: proof.origin, currency: proof.currency, provenanceSha256: proof.evidenceHashes.provenanceSha256,
  periodFrom: proof.periodFrom, periodTo: proof.periodTo, status: proof.entryStatus, grossCents: proof.grossCents,
  netCents: proof.netCents, protectedFixedCents: proof.protectedFixedCents, eligibleVariableCents: proof.eligibleVariableCents,
  expense: proof.expense, ...(proof.settlement ? { settlement: proof.settlement } : {}) });
async function requireOwner(db, actor) {
  if (!actor || typeof actor.venueId !== 'string' || !UUID.test(actor.venueId)
      || typeof actor.userId !== 'string' || !UUID.test(actor.userId)
      || !hasPayrollVerifiedWriteSnapshot(db, actor.venueId)) fail('source_transaction_required');
  const owner = (await db.query("SELECT full_name FROM users WHERE venue_id=$1 AND id=$2 AND role='owner' AND is_active=true AND deleted_at IS NULL FOR SHARE",
    [actor.venueId, actor.userId])).rows[0];
  if (!owner) fail('owner_required', 403);
  return { venueId: actor.venueId, userId: actor.userId, name: owner.full_name };
}
async function readReviewedCorrectionLedger(db, actor, employeeId) {
  if (!hasPayrollVerifiedWriteSnapshot(db, actor.venueId) || typeof employeeId !== 'string' || !UUID.test(employeeId)) fail('source_transaction_required');
  // The extra row detects an oversized history. Never allocate using a prefix.
  const rows = (await db.query(`SELECT e.id,e.sequence_no::text,e.kind,e.amount_cents::text,e.target_entry_id,e.reverses_event_id,
      e.venue_id,e.employee_id,c.currency,c.original_entry_id,c.refund_line_event_id,e.claim_id,
      to_jsonb(c)->>'source_kind' AS source_kind,
      CASE WHEN e.kind='release' THEN to_jsonb(pb)->>'cohort_assessment_id'
        ELSE to_jsonb(b)->>'cohort_assessment_id' END AS cohort_assessment_id
    FROM payroll_correction_events e JOIN payroll_correction_claims c ON c.venue_id=e.venue_id AND c.id=e.claim_id
    JOIN payroll_correction_batches b ON b.venue_id=e.venue_id AND b.id=e.batch_id
    LEFT JOIN payroll_correction_events pe ON pe.venue_id=e.venue_id AND pe.id=e.reverses_event_id
    LEFT JOIN payroll_correction_batches pb ON pb.venue_id=pe.venue_id AND pb.id=pe.batch_id
    WHERE e.venue_id=$1 AND e.employee_id=$2 ORDER BY e.sequence_no LIMIT 100001`, [actor.venueId, employeeId])).rows;
  if (rows.length > 100000) fail('ledger_too_large');
  return rows.map(payrollCorrectionLedgerEventFromRow);
}
async function collectContext(db, actor, command, checkFreshness) {
  const ids = [command.originalEntryId, command.targetEntryId].filter(Boolean).sort();
  const rows = (await db.query(`SELECT *,period_from::text AS period_from,period_to::text AS period_to
    FROM payroll_entries WHERE venue_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE`, [actor.venueId, ids])).rows;
  const originalRow = rows.find(row => row.id === command.originalEntryId), targetRow = rows.find(row => row.id === command.targetEntryId);
  if (!originalRow || (command.operation === 'apply' && !targetRow)) fail('entry_not_found', 404);
  const originalProof = await verifyPayrollCalculationEntryEvidence(db, actor, originalRow, { purpose: 'historical_paid' });
  const targetProof = command.operation === 'apply'
    ? await verifyPayrollCalculationEntryEvidence(db, actor, targetRow, { purpose: 'current_transition', checkFreshness }) : null;
  const payload = await collectPayrollRefundReviewAssessment(db, actor, originalRow.calculation_run_id);
  const assessment = { ...payload, assessmentHash: digest(canonical(payload)) };
  const ledger = await readReviewedCorrectionLedger(db, actor, originalRow.user_id);
  return { original: proofEntry(originalProof), target: targetProof ? proofEntry(targetProof) : undefined, assessment, ledger, payload };
}
async function previewReviewedCorrection(db, actor, input, checkFreshness) {
  const command = normalizeReviewedCorrectionPreview(input);
  actor = await requireOwner(db, actor);
  const context = await collectContext(db, actor, command, checkFreshness);
  return command.operation === 'apply' ? buildReviewedCorrectionPlan(context) : buildReviewedCorrectionWaiverPlan(context);
}
async function readReviewedCorrectionContext(db, actor, originalEntryId) {
  if (typeof originalEntryId !== 'string' || !UUID.test(originalEntryId)) fail('identity_invalid', 400);
  actor = await requireOwner(db, actor);
  const context = await collectContext(db, actor, { operation: 'waive', originalEntryId, targetEntryId: null });
  const waiver = buildReviewedCorrectionWaiverPlan(context);
  const rows = (await db.query(`SELECT id::text,calculation_run_id::text AS run_id,
      period_from::text,period_to::text,calculation_gross_cents::text AS gross_cents,
      (amount*100)::bigint::text AS net_cents,employee_name_snapshot,calculation_scheme_name_snapshot
    FROM payroll_entries WHERE venue_id=$1 AND user_id=$2 AND status='draft'
      AND calculation_run_id IS NOT NULL AND calculation_run_id<>$3 AND period_from>$4::date
    ORDER BY period_from,period_to,id LIMIT 201`,
  [actor.venueId, context.original.employeeId, context.original.runId, context.original.periodTo])).rows;
  if (rows.length > 200) fail('target_list_too_large');
  const targets = rows.map(row => {
    const grossCents = integer(row.gross_cents), amountCents = integer(row.net_cents);
    if (amountCents > grossCents) fail('target_basis_invalid');
    return { id: row.id, runId: row.run_id, periodFrom: row.period_from, periodTo: row.period_to,
      employeeName: row.employee_name_snapshot, schemeName: row.calculation_scheme_name_snapshot, grossCents, amountCents,
      status: 'draft', requiresFreshPreview: true };
  });
  const history = context.ledger.filter(event => event.originalEntryId === originalEntryId);
  const metadata = history.length ? (await db.query(`SELECT e.id,b.reason,b.created_by_name,b.created_at::text AS created_at
    FROM payroll_correction_events e JOIN payroll_correction_batches b ON b.venue_id=e.venue_id AND b.id=e.batch_id
    WHERE e.venue_id=$1 AND e.employee_id=$2 AND e.id=ANY($3::uuid[])`,
  [actor.venueId, context.original.employeeId, history.map(event => event.id)])).rows : [];
  if (metadata.length !== history.length || new Set(metadata.map(row => row.id)).size !== history.length) fail('history_incomplete');
  const metadataById = new Map(metadata.map(row => [row.id, row]));
  return { schemaVersion: 1, original: context.original, targets,
    history: history.map(event => {
      const row = metadataById.get(event.id);
      if (!row || typeof row.reason !== 'string' || typeof row.created_by_name !== 'string' || typeof row.created_at !== 'string') fail('history_incomplete');
      return { ...event, reason: row.reason, createdByName: row.created_by_name, createdAt: row.created_at };
    }),
    remainingCents: waiver.waiveCents, assessmentHash: waiver.assessmentHash,
    sourceHash: waiver.sourceHash, ledgerHash: waiver.ledgerHash, requiresExplicitTarget: true };
}
async function applyReviewedCorrection(db, actor, input, checkFreshness) {
  const command = normalizeReviewedCorrectionCommand(input);
  actor = await requireOwner(db, actor);
  const requestHash = reviewedCorrectionRequestHash(actor, command);
  const previous = (await db.query(`SELECT request_hash,response_payload,response_hash FROM payroll_correction_requests
    WHERE venue_id=$1 AND idempotency_key=$2`, [actor.venueId, command.idempotencyKey])).rows[0];
  if (previous) {
    if (previous.request_hash !== requestHash) fail('idempotency_conflict');
    if (typeof previous.response_payload !== 'string' || digest(previous.response_payload) !== previous.response_hash) fail('request_integrity_invalid');
    let result;
    try { result = JSON.parse(previous.response_payload); } catch (_) { fail('request_integrity_invalid'); }
    return { ...result, replayed: true };
  }
  const context = await collectContext(db, actor, command, checkFreshness);
  const prepared = buildReviewedCorrectionCommand(actor, command, context);
  // A fresh complete assessment is saved in this same transaction. Earlier
  // review-only decisions are never interpreted as economic waivers.
  const review = await saveRefundReviewAssessment(db, actor, context.payload, { idempotencyKey: `correction-assessment:${randomUUID()}` });
  if (review.latestAssessment.assessmentHash !== prepared.plan.assessmentHash) fail('assessment_changed');
  const assessmentId = review.latestAssessment.id, claims = new Map();
  const zeroAuthority = prepared.plan.originalSettlementTransitionId || null;
  for (const event of prepared.events) {
    const allocation = prepared.plan.allocations.find(line => line.refundLineEventId === event.refundLineEventId);
    let claim = (await db.query(`SELECT id,original_entry_id,source_snapshot_line_id,assessed_cents::text,original_expense_id${zeroAuthority ? ',original_settlement_transition_id' : ''} FROM payroll_correction_claims
      WHERE venue_id=$1 AND refund_line_event_id=$2 AND employee_id=$3 FOR UPDATE`, [actor.venueId, event.refundLineEventId, prepared.plan.employeeId])).rows[0];
    if (claim && (claim.original_entry_id !== command.originalEntryId || claim.source_snapshot_line_id !== event.sourceSnapshotLineId
        || integer(claim.assessed_cents) !== allocation.assessedCents
        || claim.original_expense_id !== prepared.plan.originalExpenseId
        || (zeroAuthority && claim.original_settlement_transition_id !== zeroAuthority))) fail('claim_basis_mismatch');
    if (!claim) {
      const claimId = randomUUID();
      await db.query(`INSERT INTO payroll_correction_claims(id,venue_id,employee_id,currency,original_entry_id,original_run_id,
        original_expense_id,original_provenance_sha256,refund_line_event_id,source_snapshot_line_id,
        assessment_id,assessment_hash,source_hash,assessed_cents,created_by,created_by_name${zeroAuthority ? ',original_settlement_transition_id' : ''})
        VALUES($1,$2,$3,'RUB',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15${zeroAuthority ? ',$16' : ''})`,
      [claimId, actor.venueId, prepared.plan.employeeId, command.originalEntryId, prepared.plan.originalRunId,
        prepared.plan.originalExpenseId, prepared.plan.originalProvenanceSha256, event.refundLineEventId, event.sourceSnapshotLineId,
        assessmentId, prepared.plan.assessmentHash, prepared.plan.sourceHash, allocation.assessedCents, actor.userId, actor.name,
        ...(zeroAuthority ? [zeroAuthority] : [])]);
      claim = { id: claimId };
    }
    claims.set(event.refundLineEventId, claim.id);
  }
  const { planHash, ...body } = prepared.plan, planPayload = canonical(body);
  if (digest(planPayload) !== planHash) fail('plan_integrity_invalid');
  const isApply = command.operation === 'apply';
  const targetSequence = isApply ? integer((await db.query(`SELECT (COALESCE(max(target_sequence_no),0)+1)::text AS next
    FROM payroll_correction_batches WHERE venue_id=$1 AND target_entry_id=$2`, [actor.venueId, command.targetEntryId])).rows[0].next) : null;
  const batchId = randomUUID(), totalCents = isApply ? prepared.plan.applyCents : prepared.plan.waiveCents;
  await db.query(`INSERT INTO payroll_correction_batches(id,venue_id,employee_id,currency,operation,original_entry_id,target_entry_id,
    target_sequence_no,assessment_id,assessment_hash,source_hash,ledger_hash,plan_payload,plan_hash,event_count,total_cents,
    target_before_cents,target_after_cents,protected_fixed_cents,reason,created_by,created_by_name)
    VALUES($1,$2,$3,'RUB',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
  [batchId, actor.venueId, prepared.plan.employeeId, command.operation, command.originalEntryId, command.targetEntryId,
    targetSequence, assessmentId, prepared.plan.assessmentHash, prepared.plan.sourceHash, prepared.plan.ledgerHash,
    planPayload, planHash, prepared.events.length, totalCents,
    isApply ? prepared.plan.targetBeforeCents : null, isApply ? prepared.plan.targetAfterCents : null,
    isApply ? prepared.plan.protectedFixedCents : null, command.reason, actor.userId, actor.name]);
  for (const event of prepared.events) {
    const claimId = claims.get(event.refundLineEventId);
    await db.query(`INSERT INTO payroll_correction_events(id,venue_id,employee_id,claim_id,batch_id,claim_sequence_no,kind,amount_cents,target_entry_id)
      SELECT $1,$2,$3,$4,$5,COALESCE(max(claim_sequence_no),0)+1,$6,$7,$8 FROM payroll_correction_events WHERE venue_id=$2 AND claim_id=$4`,
    [randomUUID(), actor.venueId, prepared.plan.employeeId, claimId, batchId, command.operation, event.amountCents, command.targetEntryId]);
  }
  if (isApply) {
    const updated = await db.query(`UPDATE payroll_entries SET amount=$3::numeric WHERE venue_id=$1 AND id=$2 AND status='draft'
      AND amount=$4::numeric RETURNING id`, [actor.venueId, command.targetEntryId, decimal(prepared.plan.targetAfterCents), decimal(prepared.plan.targetBeforeCents)]);
    if (updated.rows.length !== 1) fail('target_changed');
  }
  const result = { schemaVersion: 1, batchId, operation: command.operation, planHash, totalCents,
    targetEntryId: command.targetEntryId, targetAfterCents: isApply ? prepared.plan.targetAfterCents : null,
    residualReviewCents: isApply ? prepared.plan.residualReviewCents : 0,
    officialReady: false, payoutEligible: false, replayed: false };
  const response = canonical(result);
  await db.query(`INSERT INTO payroll_correction_requests(venue_id,idempotency_key,request_hash,batch_id,created_by,response_payload,response_hash)
    VALUES($1,$2,$3,$4,$5,$6,$7)`, [actor.venueId, command.idempotencyKey, requestHash, batchId, actor.userId, response, digest(response)]);
  return result;
}
const cancellationInput = input => {
  const keys = ['targetEntryId', 'expectedPlanHash', 'reason', 'idempotencyKey'];
  if (!input || Object.getPrototypeOf(input) !== Object.prototype || Reflect.ownKeys(input).length !== keys.length
      || keys.some(key => !Object.hasOwn(input, key))
      || Object.values(Object.getOwnPropertyDescriptors(input)).some(d => !Object.hasOwn(d, 'value'))
      || typeof input.targetEntryId !== 'string' || !UUID.test(input.targetEntryId)
      || typeof input.expectedPlanHash !== 'string' || !/^[a-f0-9]{64}$/.test(input.expectedPlanHash)
      || typeof input.reason !== 'string' || input.reason.trim().length < 3 || input.reason.length > 500
      || typeof input.idempotencyKey !== 'string' || !/^[A-Za-z0-9_.:-]{8,120}$/.test(input.idempotencyKey)) fail('cancellation_input_invalid', 400);
  return { targetEntryId: input.targetEntryId, expectedPlanHash: input.expectedPlanHash, reason: input.reason.trim(), idempotencyKey: input.idempotencyKey };
};
async function cancellationPlan(db, actor, targetEntryId) {
  const row = (await db.query(`SELECT id,venue_id,user_id,status,calculation_run_id,calculation_provenance_sha256,
      calculation_gross_cents::text,period_from::text,period_to::text,(amount*100)::bigint::text AS net_cents
    FROM payroll_entries WHERE venue_id=$1 AND id=$2 AND calculation_run_id IS NOT NULL FOR UPDATE`, [actor.venueId, targetEntryId])).rows[0];
  if (!row) fail('entry_not_found', 404);
  const totals = (await db.query(`SELECT COALESCE(sum(LEAST(base_pay,final_amount)*100),0)::bigint::text AS fixed,
      COALESCE(sum(final_amount*100),0)::bigint::text AS gross
    FROM payroll_daily_snapshots WHERE venue_id=$1 AND run_id=$2 AND employee_id=$3`, [actor.venueId, row.calculation_run_id, row.user_id])).rows[0];
  const gross = integer(totals.gross), fixed = integer(totals.fixed);
  if (gross !== integer(row.calculation_gross_cents) || fixed > gross) fail('target_variable_basis_invalid');
  const ledger = await readReviewedCorrectionLedger(db, actor, row.user_id);
  const released = new Set(ledger.filter(event => event.kind === 'release').map(event => event.reversesEventId));
  const applications = ledger.filter(event => event.kind === 'apply' && event.targetEntryId === targetEntryId && !released.has(event.id));
  return buildReviewedCorrectionReleasePlan({ target: { id: row.id, venueId: row.venue_id, employeeId: row.user_id,
    status: row.status, runId: row.calculation_run_id, origin: 'calculation_run', currency: 'RUB',
    provenanceSha256: row.calculation_provenance_sha256, periodFrom: row.period_from, periodTo: row.period_to,
    grossCents: gross, netCents: integer(row.net_cents), protectedFixedCents: fixed, eligibleVariableCents: gross - fixed }, applications });
}
async function previewReviewedCorrectionCancellation(db, actor, input) {
  const request = cancellationInput(input);
  actor = await requireOwner(db, actor);
  // Cancellation need not wait for current sources or compatible engine code:
  // no payout is authorized and immutable stored allocations are reversed fully.
  return cancellationPlan(db, actor, request.targetEntryId);
}
async function cancelReviewedCorrectionTarget(db, actor, input, { beforeCancel } = {}) {
  if (beforeCancel !== undefined && typeof beforeCancel !== 'function') fail('cancellation_callback_invalid');
  const request = cancellationInput(input);
  actor = await requireOwner(db, actor);
  const { idempotencyKey, ...intent } = request;
  const requestHash = digest(canonical({ schemaVersion: 1, operation: 'release', venueId: actor.venueId, actorId: actor.userId, ...intent }));
  const previous = (await db.query(`SELECT request_hash,response_payload,response_hash FROM payroll_correction_requests
    WHERE venue_id=$1 AND idempotency_key=$2`, [actor.venueId, idempotencyKey])).rows[0];
  if (previous) {
    if (previous.request_hash !== requestHash) fail('idempotency_conflict');
    if (typeof previous.response_payload !== 'string' || digest(previous.response_payload) !== previous.response_hash) fail('request_integrity_invalid');
    let result;
    try { result = JSON.parse(previous.response_payload); } catch (_) { fail('request_integrity_invalid'); }
    return { ...result, replayed: true };
  }
  const plan = await cancellationPlan(db, actor, request.targetEntryId);
  if (plan.planHash !== request.expectedPlanHash) fail('plan_stale');
  if (!plan.releases.length) fail('nothing_to_release'); // Caller uses ordinary lifecycle cancellation in this case.
  const { planHash, ...planBody } = plan, planPayload = canonical(planBody);
  if (digest(planPayload) !== planHash) fail('plan_integrity_invalid');
  const sequence = integer((await db.query(`SELECT (COALESCE(max(target_sequence_no),0)+1)::text AS next
    FROM payroll_correction_batches WHERE venue_id=$1 AND target_entry_id=$2`, [actor.venueId, request.targetEntryId])).rows[0].next);
  const batchId = randomUUID();
  await db.query(`INSERT INTO payroll_correction_batches(id,venue_id,employee_id,currency,operation,original_entry_id,target_entry_id,
    target_sequence_no,assessment_id,assessment_hash,source_hash,ledger_hash,plan_payload,plan_hash,event_count,total_cents,
    target_before_cents,target_after_cents,protected_fixed_cents,reason,created_by,created_by_name)
    VALUES($1,$2,$3,'RUB','release',NULL,$4,$5,NULL,NULL,NULL,$6,$7,$8,$9,$10,$11,$11,$12,$13,$14,$15)`,
  [batchId, actor.venueId, plan.employeeId, request.targetEntryId, sequence, plan.ledgerHash, planPayload, planHash,
    plan.releases.length, plan.releaseCents, plan.cancelledHistoricalCents, plan.protectedFixedCents, request.reason, actor.userId, actor.name]);
  for (const release of plan.releases) {
    const inserted = await db.query(`INSERT INTO payroll_correction_events(id,venue_id,employee_id,claim_id,batch_id,claim_sequence_no,
        kind,amount_cents,target_entry_id,reverses_event_id)
      SELECT $1,a.venue_id,a.employee_id,a.claim_id,$2,
        (SELECT COALESCE(max(e.claim_sequence_no),0)+1 FROM payroll_correction_events e WHERE e.venue_id=a.venue_id AND e.claim_id=a.claim_id),
        'release',a.amount_cents,a.target_entry_id,a.id
      FROM payroll_correction_events a WHERE a.venue_id=$3 AND a.id=$4 AND a.kind='apply' AND a.target_entry_id=$5 RETURNING id`,
    [randomUUID(), batchId, actor.venueId, release.reversesEventId, request.targetEntryId]);
    if (inserted.rows.length !== 1) fail('release_basis_changed');
  }
  // The entry lifecycle inserts its immutable transition before this one status
  // update. Its exact PostgreSQL timestamp preserves microseconds.
  const transition = beforeCancel ? await beforeCancel(plan) : null;
  const updated = await db.query(`UPDATE payroll_entries SET status='cancelled',cancelled_at=COALESCE($5::timestamptz,now()),cancelled_by=$3,cancellation_reason=$4
    WHERE venue_id=$1 AND id=$2 AND status IN ('draft','approved') RETURNING id`,
  [actor.venueId, request.targetEntryId, actor.userId, request.reason, transition?.created_at || null]);
  if (updated.rows.length !== 1) fail('target_changed');
  const result = { schemaVersion: 1, batchId, operation: 'release', planHash, targetEntryId: request.targetEntryId,
    totalCents: plan.releaseCents, cancelledHistoricalCents: plan.cancelledHistoricalCents,
    officialReady: false, payoutEligible: false, replayed: false };
  const response = canonical(result);
  await db.query(`INSERT INTO payroll_correction_requests(venue_id,idempotency_key,request_hash,batch_id,created_by,response_payload,response_hash)
    VALUES($1,$2,$3,$4,$5,$6,$7)`, [actor.venueId, idempotencyKey, requestHash, batchId, actor.userId, response, digest(response)]);
  return result;
}
module.exports = { readReviewedCorrectionLedger, readReviewedCorrectionContext, previewReviewedCorrection, applyReviewedCorrection,
  previewReviewedCorrectionCancellation, cancelReviewedCorrectionTarget };
