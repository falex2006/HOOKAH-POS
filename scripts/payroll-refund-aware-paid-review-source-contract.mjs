import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url), root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && Object.getPrototypeOf(value) === Object.prototype ? `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`
    : JSON.stringify(value);
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex');
const uuid = () => randomUUID();
const ids = { venue: uuid(), owner: uuid(), run: uuid(), employee: uuid(), entry: uuid(), expense: uuid(), claim: uuid(),
  original: uuid(), refundLine: uuid(), event: uuid(), transition: uuid() };
const evidence = { schemaVersion: 2, capabilityVersion: 'employee_attributed_remaining_net_refund_v2', venueId: ids.venue,
  runId: ids.run, currency: 'RUB', period: { from: '2026-10-01', to: '2026-10-31' },
  schemeSnapshot: { sourcePolicies: { schemaVersion: 2 } } };
const provenanceSha256 = hash(evidence);
const header = { runId: ids.run, capabilityVersion: evidence.capabilityVersion };
const entry = { id: ids.entry, venue_id: ids.venue, user_id: ids.employee, status: 'paid', calculation_run_id: ids.run,
  calculation_provenance_sha256: provenanceSha256, calculation_gross_cents: '1000', amount: '7.00',
  period_from: '2026-10-01', period_to: '2026-10-31', paid_at: '2026-11-01T10:00:00.000000Z', paid_by: ids.owner,
  payment_date: '2026-11-01', expense_id: ids.expense };
const ledgerEvent = { id: ids.event, sequence_no: '1', venue_id: ids.venue, employee_id: ids.employee, claim_id: ids.claim,
  kind: 'apply', amount_cents: '300', target_entry_id: ids.entry, reverses_event_id: null, currency: 'RUB',
  original_entry_id: ids.original, refund_line_event_id: ids.refundLine, existed_at_settlement: true };
const normalizedLedger = [{ id: ids.event, sequenceNo: 1, venueId: ids.venue, employeeId: ids.employee,
  currency: 'RUB', originalEntryId: ids.original, refundLineEventId: ids.refundLine, kind: 'apply', amountCents: 300,
  targetEntryId: ids.entry, reversesEventId: null }];
const correctionBody = { entryId: ids.entry, venueId: ids.venue, employeeId: ids.employee, netCents: 700,
  protectedFixedCents: 400, appliedCents: 300, ledgerHash: hash(normalizedLedger),
  ledgerCaptureSchemaVersion: 1, ledgerEventIds: [ids.event], activeApplicationIds: [ids.event], sources: [] };
const correction = { ...correctionBody, correctionEvidenceHash: hash(correctionBody) };
const sourceProof = { schemaVersion: 1, proofKind: 'current_transition', entryStatus: 'approved', venueId: ids.venue,
  capabilityVersion: evidence.capabilityVersion, periodFrom: entry.period_from, periodTo: entry.period_to, eligibleVariableCents: 600,
  entryId: ids.entry, employeeId: ids.employee, runId: ids.run, grossCents: 1000, netCents: 700,
  protectedFixedCents: 400, origin: 'calculation_run', currency: 'RUB', evidenceHashes: {},
  freshness: { status: 'current' }, corrections: correction };
const sourceProofPayload = canonical(sourceProof);
const transition = { id: ids.transition, venue_id: ids.venue, entry_id: ids.entry, employee_id: ids.employee,
  calculation_run_id: ids.run, from_status: 'approved', to_status: 'paid', action: 'pay', settlement_kind: 'positive_expense',
  gross_cents: '1000', net_cents: '700', protected_fixed_cents: '400', created_by: ids.owner,
  expense_id: ids.expense, source_proof_payload: sourceProofPayload, source_proof_sha256: hash(sourceProofPayload),
  payment_date: entry.payment_date, created_at: entry.paid_at, request_journaled: true,
  provenance_sha256: provenanceSha256, ledger_hash: correction.ledgerHash };

let fence = true, saved = { header, evidence }, recognition = { manifest: { watermark: 'a'.repeat(64) }, facts: {} };
let entries = [entry], ownerPresent = true, assessmentInput = null, ledgerEvents = [ledgerEvent];
const cache = (name, exports) => { const file = require.resolve(path.join(root, name)); require.cache[file] = { id: file, filename: file, loaded: true, exports }; };
cache('payroll-source-fence.js', { hasPayrollVerifiedWriteSnapshot: () => fence });
cache('payroll-saved-run-reader.js', { async loadSavedRunEvidenceInTransaction() { return structuredClone(saved); } });
cache('payroll-recognition-manifest.js', { async readPayrollRecognitionEvidenceInTransaction(_db, options) {
  assert.deepEqual(options, { venueId: ids.venue, currency: 'RUB', from: '2026-10-01', to: '2026-10-31' });
  return structuredClone(recognition);
} });
cache('payroll-source-policies.js', { PAYROLL_REMAINING_NET_EARNINGS_POLICY: 'remaining_merchandise_original_sale_date_v1',
  PAYROLL_REFUND_ADJUSTED_VENUE_TURNOVER_POLICY: 'canonical_total_less_merchandise_returns_v1',
  PAYROLL_FROZEN_SALE_DEPLETION_COST_PAYROLL_POLICY: 'frozen_sale_depletion_cost_payroll_v1',
  normalizePayrollSourcePolicies(value) { return { ...value,
    earnings: { refunds: 'remaining_merchandise_original_sale_date_v1',
      venueTurnover: 'canonical_total_less_merchandise_returns_v1', marginCost: 'frozen_sale_depletion_cost_payroll_v1' } }; } });
cache('payroll-calculation-entry-evidence.js', { async verifyPayrollCalculationEntryEvidence(_db, actor, row, opts) {
  assert.equal(opts.purpose, 'historical_paid'); assert.equal(actor.venueId, ids.venue); assert.equal(row.id, ids.entry);
  return { proofKind: 'historical_paid', entryId: ids.entry, employeeId: ids.employee, runId: ids.run,
    grossCents: 1000, netCents: 700, protectedFixedCents: 400, eligibleVariableCents: 600,
    periodFrom: entry.period_from, periodTo: entry.period_to, evidenceHashes: {}, settlement: null };
} });
cache('payroll-refund-aware-paid-review-assessment.js', { buildPayrollRefundAwarePaidReviewAssessment(input) {
  assessmentInput = structuredClone(input);
  return Object.freeze({ schemaVersion: 1, status: 'paid_review_assessed', officialReady: false, payoutEligible: false,
    deltaApplicationEligible: false, persistence: 'none', financialAction: 'none', paidReviews: [], assessmentWatermark: 'a'.repeat(64) });
} });
const api = require(path.join(root, 'payroll-refund-aware-paid-review-source.js'));
const queryLog = [];
const db = { async query(sql, params) {
  queryLog.push(sql);
  if (/FROM users/.test(sql)) return { rows: ownerPresent ? [{ id: ids.owner }] : [] };
  if (/FROM venues/.test(sql)) return { rows: [{ transactionTimestamp: '2026-11-02T00:00:00Z', venueLocalDate: '2026-11-02', timezone: 'Asia/Yekaterinburg' }] };
  if (/FROM payroll_entries/.test(sql)) {
    assert.match(sql, /status='paid'/); assert.match(sql, /FOR SHARE OF pe/);
    assert.deepEqual(params, [ids.venue, ids.run]); return { rows: entries.map(row => structuredClone(row)) };
  }
  if (/FROM payroll_calculation_entry_transitions/.test(sql)) return { rows: [structuredClone(transition)] };
  if (/FROM payroll_correction_events/.test(sql)) return { rows: structuredClone(ledgerEvents) };
  throw new Error(`unexpected query: ${sql}`);
} };
const actor = { venueId: ids.venue, userId: ids.owner };

entries = [];
await assert.rejects(api.collectPayrollRefundAwarePaidReviewInTransaction(db, actor, ids.run), /no_verified_paid_entries/);
fence = false;
await assert.rejects(api.collectPayrollRefundAwarePaidReviewInTransaction(db, actor, ids.run), /source_transaction_required/);
fence = true; entries = [entry]; ownerPresent = false;
await assert.rejects(api.collectPayrollRefundAwarePaidReviewInTransaction(db, actor, ids.run), /owner_required/);
ownerPresent = true;
const result = await api.collectPayrollRefundAwarePaidReviewInTransaction(db, actor, ids.run);
assert.equal(result.assessment.status, 'paid_review_assessed');
assert.equal(Object.keys(result.assessment).includes('sourceCollection'), false);
assert.equal(result.assessment.officialReady, false); assert.equal(result.assessment.payoutEligible, false);
assert.equal(result.assessment.deltaApplicationEligible, false); assert.equal(result.assessment.persistence, 'none');
assert.equal(result.sourceCollection, 'verified_private_paid_entry_rows');
assert.equal(result.assessment.assessmentWatermark, 'a'.repeat(64));
assert.equal(assessmentInput.paidEntries.length, 1); assert.equal(assessmentInput.paidEntries[0].incomingSettledCents, 300);
assert.deepEqual(assessmentInput.paidEntries[0].evidenceHashes, {});
assert.equal(assessmentInput.periodClosure.timezone, 'Asia/Yekaterinburg');
assert(queryLog.some(sql => /FOR SHARE OF pe/.test(sql)) && queryLog.some(sql => /payroll_calculation_entry_transitions/.test(sql))
  && queryLog.some(sql => /payroll_correction_events/.test(sql)), 'paid entry, immutable payment receipt and incoming ledger are read under locks');
assert(queryLog.every(sql => /^\s*SELECT\b/i.test(sql)), 'collector is strictly read-only');

const originalHash = correction.ledgerHash;
for (const patch of [{ capabilityVersion: undefined }, { periodFrom: '2026-09-01' }, { periodTo: '2026-11-01' }, { eligibleVariableCents: 601 }]) {
  const changed = { ...sourceProof, ...patch };
  if (changed.capabilityVersion === undefined) delete changed.capabilityVersion;
  transition.source_proof_payload = canonical(changed); transition.source_proof_sha256 = hash(transition.source_proof_payload);
  await assert.rejects(api.collectPayrollRefundAwarePaidReviewInTransaction(db, actor, ids.run), /paid_transition_proof_invalid/);
}
transition.source_proof_payload = canonical(sourceProof); transition.source_proof_sha256 = hash(transition.source_proof_payload);
// Later dispositions from this paid source do not rewrite its old settlement.
const outgoing = { ...ledgerEvent, id: uuid(), sequence_no: '2', original_entry_id: ids.entry,
  target_entry_id: uuid(), existed_at_settlement: false };
ledgerEvents.push(outgoing);
await api.collectPayrollRefundAwarePaidReviewInTransaction(db, actor, ids.run);
// A timestamp equal to pay or earlier due to a delayed commit is irrelevant:
// only the receipt's immutable captured event IDs define its historic ledger.
for (const created_at of [entry.paid_at, '2026-10-01T00:00:00.000000Z']) {
  outgoing.created_at = created_at; outgoing.existed_at_settlement = true;
  await api.collectPayrollRefundAwarePaidReviewInTransaction(db, actor, ids.run);
}
outgoing.target_entry_id = ids.entry;
await assert.rejects(api.collectPayrollRefundAwarePaidReviewInTransaction(db, actor, ids.run), /settlement_ledger_changed_after_payment/);
ledgerEvents = [ledgerEvent];
for (const patch of [{ request_journaled: false }, { provenance_sha256: 'f'.repeat(64) }, { action: 'approve' }]) {
  const saved = { ...transition }; Object.assign(transition, patch);
  await assert.rejects(api.collectPayrollRefundAwarePaidReviewInTransaction(db, actor, ids.run), /paid_transition_invalid/);
  Object.assign(transition, saved);
}
correction.ledgerHash = 'f'.repeat(64);
correction.correctionEvidenceHash = hash(Object.fromEntries(Object.entries(correction).filter(([key]) => key !== 'correctionEvidenceHash')));
sourceProof.corrections = correction;
transition.source_proof_payload = canonical(sourceProof); transition.source_proof_sha256 = hash(transition.source_proof_payload);
transition.ledger_hash = correction.ledgerHash;
await assert.rejects(api.collectPayrollRefundAwarePaidReviewInTransaction(db, actor, ids.run), /settlement_ledger_mismatch/);
assert.equal(originalHash, hash(normalizedLedger));

// The historical ledger receipt binds an incoming period correction exactly.
const cohortAssessmentId = uuid();
Object.assign(ledgerEvent, { source_kind: 'period_v2', refund_line_event_id: null, cohort_assessment_id: cohortAssessmentId });
correction.ledgerHash = hash([{ ...normalizedLedger[0], refundLineEventId: null,
  sourceKind: 'period_v2', cohortClaimId: ids.claim, cohortAssessmentId }]);
correction.correctionEvidenceHash = hash(Object.fromEntries(Object.entries(correction).filter(([key]) => key !== 'correctionEvidenceHash')));
transition.ledger_hash = correction.ledgerHash;
transition.source_proof_payload = canonical(sourceProof); transition.source_proof_sha256 = hash(transition.source_proof_payload);
await api.collectPayrollRefundAwarePaidReviewInTransaction(db, actor, ids.run);
ledgerEvent.cohort_assessment_id = uuid();
await assert.rejects(api.collectPayrollRefundAwarePaidReviewInTransaction(db, actor, ids.run), /settlement_ledger_mismatch/);
ledgerEvent.cohort_assessment_id = null;
await assert.rejects(api.collectPayrollRefundAwarePaidReviewInTransaction(db, actor, ids.run), /settlement_ledger_invalid/);

console.log('payroll refund-aware paid review source contract: PASS (owner/fence, paid proof, positive settlement ledger, read-only assessment)');
