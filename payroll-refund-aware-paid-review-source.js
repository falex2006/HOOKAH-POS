'use strict';

// Private source collector for read-only whole-period paid refund review.
// Caller owns the private owner/source-fenced transaction; this module grants
// no route, write, correction, expense, or payout authority.
const { createHash } = require('node:crypto');
const { payrollCorrectionLedgerEventFromRow, samePayrollCorrectionSource } = require('./payroll-correction-ledger-source');
const { hasPayrollVerifiedWriteSnapshot } = require('./payroll-source-fence');
const { loadSavedRunEvidenceInTransaction } = require('./payroll-saved-run-reader');
const { readPayrollRecognitionEvidenceInTransaction } = require('./payroll-recognition-manifest');
const { verifyPayrollCalculationEntryEvidence } = require('./payroll-calculation-entry-evidence');
const { buildPayrollRefundAwarePaidReviewAssessment } = require('./payroll-refund-aware-paid-review-assessment');
const { normalizePayrollSourcePolicies, PAYROLL_REMAINING_NET_EARNINGS_POLICY,
  PAYROLL_REFUND_ADJUSTED_VENUE_TURNOVER_POLICY, PAYROLL_FROZEN_SALE_DEPLETION_COST_PAYROLL_POLICY } = require('./payroll-source-policies');

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA = /^[a-f0-9]{64}$/i;
const CAPABILITY = 'employee_attributed_remaining_net_refund_v2';
const fail = (code, status = 409) => { throw Object.assign(new Error(`payroll_refund_aware_paid_review_${code}`), {
  code: `payroll_refund_aware_paid_review_${code}`, status }); };
const plain = value => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value instanceof Date ? JSON.stringify(Date.prototype.toISOString.call(value))
    : plain(value) ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
      : JSON.stringify(value);
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex');
const uuid = value => { if (typeof value !== 'string' || !UUID.test(value)) fail('identity_invalid', 400); return value.toLowerCase(); };
const cents = value => {
  const text = String(value);
  if (!/^(0|[1-9][0-9]*)$/.test(text) || BigInt(text) > 999999999999n) fail('settlement_amount_invalid');
  return BigInt(text);
};
const decimalCents = value => {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)\.[0-9]{2}$/.test(value)) fail('settlement_amount_invalid');
  const [units, fraction] = value.split('.');
  return BigInt(units) * 100n + BigInt(fraction);
};
const same = (a, b) => canonical(a) === canonical(b);

async function requireOwner(db, actor) {
  if (!db || typeof db.query !== 'function' || !actor || !UUID.test(actor.venueId || '')
      || !UUID.test(actor.userId || '') || !hasPayrollVerifiedWriteSnapshot(db, actor.venueId)) fail('source_transaction_required', 500);
  const owner = (await db.query(`SELECT id FROM users WHERE venue_id=$1 AND id=$2 AND role='owner'
    AND is_active=true AND deleted_at IS NULL FOR SHARE`, [actor.venueId, actor.userId])).rows[0];
  if (!owner) fail('owner_required', 403);
  return { venueId: actor.venueId.toLowerCase(), userId: actor.userId.toLowerCase() };
}

async function verifyPositiveSettlement(db, actor, row, proof) {
  const rows = (await db.query(`SELECT t.*,t.id::text AS id,t.venue_id::text AS venue_id,t.entry_id::text AS entry_id,
      t.employee_id::text AS employee_id,t.calculation_run_id::text AS calculation_run_id,
      t.gross_cents::text AS gross_cents,t.net_cents::text AS net_cents,t.protected_fixed_cents::text AS protected_fixed_cents,
      t.created_by::text AS created_by,t.expense_id::text AS expense_id,t.source_proof_payload,t.source_proof_sha256,
      t.payment_date::text AS payment_date,
      EXISTS(SELECT 1 FROM payroll_calculation_entry_transition_requests q
        WHERE q.venue_id=t.venue_id AND q.transition_id=t.id AND q.created_by=t.created_by) AS request_journaled,
      to_char(t.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
    FROM payroll_calculation_entry_transitions t WHERE t.venue_id=$1 AND t.entry_id=$2 AND t.action='pay' FOR SHARE`,
  [actor.venueId, row.id])).rows;
  if (rows.length !== 1) fail('paid_transition_missing');
  const receipt = rows[0];
  if (receipt.action !== 'pay' || receipt.request_journaled !== true || receipt.to_status !== 'paid'
      || receipt.from_status !== 'approved' || receipt.settlement_kind !== 'positive_expense'
      || receipt.provenance_sha256 !== row.calculation_provenance_sha256
      || receipt.venue_id !== actor.venueId || receipt.entry_id !== row.id || receipt.employee_id !== row.user_id
      || receipt.calculation_run_id !== row.calculation_run_id || receipt.created_by !== row.paid_by
      || receipt.created_at !== row.paid_at
      || cents(receipt.gross_cents) !== BigInt(proof.grossCents) || cents(receipt.net_cents) !== BigInt(proof.netCents)
      || cents(receipt.protected_fixed_cents) !== BigInt(proof.protectedFixedCents)
      || receipt.payment_date !== row.payment_date || receipt.expense_id !== row.expense_id || typeof receipt.source_proof_payload !== 'string'
      || hash(receipt.source_proof_payload) !== receipt.source_proof_sha256) fail('paid_transition_invalid');
  let paidProof;
  try { paidProof = JSON.parse(receipt.source_proof_payload); } catch (_) { fail('paid_transition_invalid'); }
  const correction = paidProof?.corrections;
  if (paidProof?.schemaVersion !== 1 || paidProof.proofKind !== 'current_transition'
      || paidProof.capabilityVersion !== CAPABILITY
      || paidProof.entryStatus !== 'approved' || paidProof.entryId !== row.id || paidProof.employeeId !== row.user_id
      || paidProof.runId !== row.calculation_run_id || paidProof.venueId !== actor.venueId
      || paidProof.origin !== 'calculation_run' || paidProof.currency !== 'RUB'
      || paidProof.grossCents !== proof.grossCents || paidProof.netCents !== proof.netCents
      || paidProof.protectedFixedCents !== proof.protectedFixedCents
      || paidProof.periodFrom !== proof.periodFrom || paidProof.periodTo !== proof.periodTo
      || paidProof.eligibleVariableCents !== proof.eligibleVariableCents
      || !same(paidProof.evidenceHashes, proof.evidenceHashes)
      || paidProof.freshness?.status !== 'current' || !plain(correction)
      || correction.entryId !== row.id || correction.employeeId !== row.user_id || correction.venueId !== actor.venueId
      || correction.netCents !== proof.netCents || correction.protectedFixedCents !== proof.protectedFixedCents
      || correction.appliedCents !== proof.grossCents - proof.netCents || !Array.isArray(correction.activeApplicationIds)
      || !SHA.test(correction.ledgerHash || '') || correction.ledgerHash !== receipt.ledger_hash
      || !SHA.test(correction.correctionEvidenceHash || '')) fail('paid_transition_proof_invalid');
  const { correctionEvidenceHash, ...correctionBody } = correction;
  if (hash(correctionBody) !== correctionEvidenceHash) fail('paid_transition_proof_invalid');

  const events = (await db.query(`SELECT e.id::text,e.sequence_no::text,e.venue_id::text,e.employee_id::text,e.claim_id::text,
      e.kind,e.amount_cents::text,e.target_entry_id::text,e.reverses_event_id::text,c.currency,
      c.original_entry_id::text,c.refund_line_event_id::text,
      to_jsonb(c)->>'source_kind' AS source_kind,
      CASE WHEN e.kind='release' THEN to_jsonb(pb)->>'cohort_assessment_id'
        ELSE to_jsonb(b)->>'cohort_assessment_id' END AS cohort_assessment_id
    FROM payroll_correction_events e JOIN payroll_correction_claims c ON c.venue_id=e.venue_id AND c.id=e.claim_id
    JOIN payroll_correction_batches b ON b.venue_id=e.venue_id AND b.id=e.batch_id
    LEFT JOIN payroll_correction_events pe ON pe.venue_id=e.venue_id AND pe.id=e.reverses_event_id
    LEFT JOIN payroll_correction_batches pb ON pb.venue_id=pe.venue_id AND pb.id=pe.batch_id
    WHERE e.venue_id=$1 AND e.employee_id=$2 ORDER BY e.sequence_no LIMIT 100001`, [actor.venueId, row.user_id])).rows;
  if (events.length > 100000) fail('settlement_ledger_too_large');
  if (correction.ledgerCaptureSchemaVersion !== 1 || !Array.isArray(correction.ledgerEventIds)
      || correction.ledgerEventIds.length > 100000 || correction.ledgerEventIds.some(id => typeof id !== 'string' || !UUID.test(id))
      || new Set(correction.ledgerEventIds).size !== correction.ledgerEventIds.length
      || !same(correction.ledgerEventIds, [...correction.ledgerEventIds].sort())) fail('settlement_capture_invalid');
  const capturedIds = new Set(correction.ledgerEventIds);
  const ledger = [], active = new Map(); let last = 0n, applied = 0n;
  for (const event of events) {
    let normalized;
    try { normalized = payrollCorrectionLedgerEventFromRow(event); } catch (_) { fail('settlement_ledger_invalid'); }
    const amount = BigInt(normalized.amountCents), seq = BigInt(normalized.sequenceNo);
    if (!UUID.test(event.id || '') || !UUID.test(event.claim_id || '') || !UUID.test(event.original_entry_id || '')
        || event.venue_id !== actor.venueId || event.employee_id !== row.user_id
        || event.currency !== 'RUB' || !/^[1-9][0-9]*$/.test(event.sequence_no || '')
        || seq > BigInt(Number.MAX_SAFE_INTEGER) || seq <= last || amount === 0n) fail('settlement_ledger_invalid');
    last = seq;
    // The immutable settlement proof captures exact event IDs. Neither equal
    // timestamps nor delayed commits may enlarge this historical set.
    if (!capturedIds.has(event.id)) {
      if (event.target_entry_id === row.id) fail('settlement_ledger_changed_after_payment');
      continue;
    }
    ledger.push(normalized);
    if (event.target_entry_id !== row.id) continue;
    if (event.kind === 'apply' && event.reverses_event_id === null) {
      if (active.has(event.id)) fail('settlement_ledger_invalid');
      active.set(event.id, event); applied += amount;
    } else if (event.kind === 'release') {
      const parent = active.get(event.reverses_event_id);
      if (!parent || parent.amount_cents !== event.amount_cents || parent.claim_id !== event.claim_id
          || !samePayrollCorrectionSource(payrollCorrectionLedgerEventFromRow(parent), normalized)) fail('settlement_ledger_invalid');
      active.delete(parent.id); applied -= amount;
    } else if (event.target_entry_id === row.id) fail('settlement_ledger_invalid');
  }
  const activeIds = [...active.keys()].sort();
  if (ledger.length !== capturedIds.size || applied !== BigInt(proof.grossCents) - BigInt(proof.netCents)
      || correction.appliedCents !== Number(applied) || !same(activeIds, [...correction.activeApplicationIds].sort())
      || hash(ledger.sort((a, b) => a.id.localeCompare(b.id))) !== correction.ledgerHash) fail('settlement_ledger_mismatch');
  return Number(applied);
}

async function collectPayrollRefundAwarePaidReviewInTransaction(db, actor, runId) {
  actor = await requireOwner(db, actor); runId = uuid(runId);
  const { header, evidence: savedEvidence } = await loadSavedRunEvidenceInTransaction(db, actor.venueId, runId);
  if (header.runId !== runId || header.capabilityVersion !== CAPABILITY || savedEvidence.schemaVersion !== 2
      || savedEvidence.capabilityVersion !== CAPABILITY || savedEvidence.venueId !== actor.venueId || savedEvidence.runId !== runId) fail('refund_v2_run_required');
  let policy;
  try { policy = normalizePayrollSourcePolicies(savedEvidence.schemeSnapshot?.sourcePolicies); } catch (_) { fail('refund_v2_run_required'); }
  if (policy?.schemaVersion !== 2 || policy.earnings?.refunds !== PAYROLL_REMAINING_NET_EARNINGS_POLICY
      || policy.earnings?.venueTurnover !== PAYROLL_REFUND_ADJUSTED_VENUE_TURNOVER_POLICY
      || policy.earnings?.marginCost !== PAYROLL_FROZEN_SALE_DEPLETION_COST_PAYROLL_POLICY) fail('refund_v2_run_required');
  const closure = (await db.query(`SELECT transaction_timestamp()::text AS "transactionTimestamp",
      (transaction_timestamp() AT TIME ZONE timezone)::date::text AS "venueLocalDate",timezone
    FROM venues WHERE id=$1 FOR SHARE`, [actor.venueId])).rows[0];
  if (!closure || typeof closure.timezone !== 'string' || !closure.timezone) fail('venue_timezone_missing');
  const currentRecognitionEvidence = await readPayrollRecognitionEvidenceInTransaction(db, { venueId: actor.venueId,
    currency: savedEvidence.currency, from: savedEvidence.period.from, to: savedEvidence.period.to });
  const rows = (await db.query(`SELECT pe.id::text AS id,pe.venue_id::text AS venue_id,pe.user_id::text AS user_id,
      pe.status,pe.calculation_run_id::text AS calculation_run_id,pe.calculation_provenance_sha256,
      pe.calculation_gross_cents::text AS calculation_gross_cents,pe.amount::text AS amount,
      pe.period_from::text AS period_from,pe.period_to::text AS period_to,
      to_char(pe.paid_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS paid_at,pe.paid_by::text AS paid_by,
      pe.payment_date::text AS payment_date,pe.expense_id::text AS expense_id
    FROM payroll_entries pe WHERE pe.venue_id=$1 AND pe.calculation_run_id=$2 AND pe.status='paid'
    ORDER BY pe.user_id,pe.id FOR SHARE OF pe`, [actor.venueId, runId])).rows;
  if (!rows.length) fail('no_verified_paid_entries');
  const paidEntries = [], seen = new Set(), provenanceSha256 = hash(savedEvidence);
  if (provenanceSha256 !== rows[0].calculation_provenance_sha256) fail('entry_provenance_mismatch');
  for (const row of rows) {
    const employeeId = uuid(row.user_id);
    if (seen.has(employeeId) || row.venue_id !== actor.venueId || row.calculation_run_id !== runId
        || row.calculation_provenance_sha256 !== provenanceSha256 || row.period_from !== savedEvidence.period.from
        || row.period_to !== savedEvidence.period.to || row.status !== 'paid') fail('paid_entry_cohort_invalid');
    seen.add(employeeId);
    const proof = await verifyPayrollCalculationEntryEvidence(db, actor, row, { purpose: 'historical_paid' });
    const incomingSettledCents = proof.settlement
      ? proof.settlement.incomingCorrectionCents
      : await verifyPositiveSettlement(db, actor, row, proof);
    if (incomingSettledCents !== proof.grossCents - proof.netCents) fail('settlement_net_mismatch');
    paidEntries.push({ entryId: proof.entryId, employeeId: proof.employeeId, runId: proof.runId,
      grossCents: proof.grossCents, netCents: proof.netCents, protectedFixedCents: proof.protectedFixedCents,
      incomingSettledCents, evidenceHashes: proof.evidenceHashes });
  }
  const assessment = buildPayrollRefundAwarePaidReviewAssessment({ savedEvidence, provenanceSha256,
    currentRecognitionEvidence, periodClosure: { schemaVersion: 1, venueId: actor.venueId, period: savedEvidence.period, ...closure }, paidEntries });
  return { assessment, sourceCollection: 'verified_private_paid_entry_rows' };
}

module.exports = { collectPayrollRefundAwarePaidReviewInTransaction };
