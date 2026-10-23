import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const store = require('../payroll-refund-review-store');
const venueId = '11111111-1111-4111-8111-111111111111', userId = '22222222-2222-4222-8222-222222222222';
const runId = '33333333-3333-4333-8333-333333333333';
const actor = { venueId, userId, name: 'Owner' };
const sourceLine = { sourceSnapshotLineId: runId, sourceSnapshotId: runId, employeeId: userId, orderId: runId, orderItemId: runId,
  originalSaleEventId: runId, originalSaleLineEventId: runId, pricingSnapshotId: runId, pricingLineId: runId,
  refundId: runId, refundEventId: runId, refundItemId: runId, refundLineEventId: runId, salaryImpactCents: -10 };
const payload = { schemaVersion: 1, policyVersion: 'saved-run-refund-review-v1', basis: 'saved_calculation_unposted',
  runId, venueId, currency: 'RUB', provenanceSha256: 'a'.repeat(64), sourceHash: 'b'.repeat(64), coverage: 'complete',
  impactCents: -10, reasons: [], lines: [sourceLine], officialReady: false, payoutEligible: false };
// Behavioral store contract; actual PostgreSQL trigger/constraint evidence belongs
// to the isolated integration suite. This fake never claims DB enforcement.
function database() {
  const state = { cases: [], assessments: [], decisions: [], requests: [], statements: [] };
  const clock = () => '2026-10-23T00:00:00.000Z';
  const db = { state, async query(sql, values) {
    state.statements.push(sql); const [venue, target] = values || [];
    const table = /FROM (payroll_refund_review_\w+)/.exec(sql)?.[1];
    if (sql.startsWith('INSERT INTO payroll_refund_review_cases')) {
      const [id, venue_id, run_id, created_by, created_by_name] = values;
      if (!state.cases.some(r => r.venue_id === venue_id && r.run_id === run_id)) state.cases.push({ id, venue_id, run_id, created_by, created_by_name, created_at: clock() });
      return { rows: [] };
    }
    if (sql.startsWith('INSERT INTO payroll_refund_review_assessments')) {
      const [id, venue_id, case_id, run_id, source_hash, assessment_hash, body, coverage, impact_cents, created_by, created_by_name] = values;
      state.assessments.push({ id, venue_id, case_id, run_id, source_hash, assessment_hash, payload: body, coverage, impact_cents: impact_cents === null ? null : String(impact_cents), created_by, created_by_name, created_at: clock() });
      return { rows: [] };
    }
    if (sql.startsWith('INSERT INTO payroll_refund_review_decisions')) {
      const [id, venue_id, case_id, assessment_id, assessment_hash, decision, reason, created_by, created_by_name] = values;
      state.decisions.push({ id, venue_id, case_id, assessment_id, assessment_hash, decision, reason, created_by, created_by_name, created_at: clock() });
      return { rows: [] };
    }
    if (sql.startsWith('INSERT INTO payroll_refund_review_requests')) {
      const [venue_id, idempotency_key, request_kind, request_hash, case_id, assessment_id, assessment_hash, decision_id, response_payload, response_hash, created_by] = values;
      state.requests.push({ venue_id, idempotency_key, request_kind, request_hash, case_id, assessment_id, assessment_hash, decision_id, response_payload, response_hash, created_by });
      return { rows: [] };
    }
    if (table === 'payroll_refund_review_requests') return { rows: state.requests.filter(r => r.venue_id === venue && r.idempotency_key === target) };
    if (table === 'payroll_refund_review_cases' && sql.includes('JOIN LATERAL')) {
      const rows = state.cases.filter(r => r.venue_id === venue && (!values[1] || r.run_id === values[1]) && (!values[2] || r.id > values[2])).sort((a, b) => a.id.localeCompare(b.id)).slice(0, values[3]).map(c => {
        const a = state.assessments.findLast(r => r.case_id === c.id);
        const d = state.decisions.findLast(r => r.assessment_id === a.id);
        return { ...a, case_id: c.id, run_id: c.run_id, case_created_at: c.created_at, case_created_by_name: c.created_by_name, decision: d?.decision };
      }); return { rows };
    }
    if (table === 'payroll_refund_review_cases') return { rows: state.cases.filter(r => r.venue_id === venue && (sql.includes('run_id=$2') ? r.run_id === target : r.id === target)) };
    if (table === 'payroll_refund_review_assessments') {
      let rows = state.assessments.filter(r => r.venue_id === venue && (sql.includes('AND id=$2') ? r.id === target : r.case_id === target));
      if (sql.includes('source_hash=$3')) rows = rows.filter(r => r.source_hash === values[2]);
      if (sql.includes('ORDER BY')) rows = rows.toReversed();
      if (sql.includes('LIMIT 101')) rows = rows.slice(0, 101); else if (sql.includes('LIMIT 1')) rows = rows.slice(0, 1);
      return { rows };
    }
    if (table === 'payroll_refund_review_decisions') {
      let rows = state.decisions.filter(r => r.venue_id === venue && (sql.includes('assessment_id=$2') ? r.assessment_id === target : r.case_id === target));
      if (sql.includes("decision<>'hold_for_review'")) rows = rows.filter(r => r.decision !== 'hold_for_review');
      if (sql.includes('ORDER BY')) rows = rows.toReversed();
      return { rows: rows.slice(0, sql.includes('LIMIT 101') ? 101 : 1) };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  } };
  return db;
}
const db = database();
const first = await store.saveRefundReviewAssessment(db, actor, payload, { idempotencyKey: 'assessment-1' });
assert.equal(first.latestAssessment.payload.impactCents, -10);
assert.equal(first.status, 'needs_review');
assert.equal(first.replayed, false);
assert.equal(db.state.cases.length, 1);
assert.equal(db.state.assessments.length, 1);
assert.deepEqual(await store.readRefundReviewAssessmentReplay(db, actor, runId, { idempotencyKey: 'assessment-1' }), { ...first, replayed: true });
const same = await store.saveRefundReviewAssessment(db, actor, payload, { idempotencyKey: 'assessment-2' });
assert.equal(same.latestAssessment.id, first.latestAssessment.id);
assert.equal(db.state.assessments.length, 1);
await assert.rejects(store.saveRefundReviewAssessment(db, actor, { ...payload, impactCents: -11, lines: [{ ...sourceLine, salaryImpactCents: -11 }] }, { idempotencyKey: 'assessment-3' }), { code: 'payroll_refund_review_non_deterministic_assessment', status: 409 });
const opts = { decision: 'hold_for_review', reason: 'Need review', expectedAssessmentHash: first.latestAssessment.assessmentHash, idempotencyKey: 'decision-1' };
const hold = await store.saveRefundReviewDecision(db, actor, first.caseId, payload, opts);
assert.equal(hold.status, 'hold_for_review');
assert.equal(hold.decisions[0].reason, opts.reason);
const closed = await store.saveRefundReviewDecision(db, actor, first.caseId, payload, { ...opts, decision: 'close_without_payroll_change', idempotencyKey: 'decision-2' });
assert.equal(closed.status, 'close_without_payroll_change');
await assert.rejects(store.saveRefundReviewDecision(db, actor, first.caseId, payload, { ...opts, idempotencyKey: 'decision-3' }), { code: 'payroll_refund_review_already_decided' });
const changed = { ...payload, sourceHash: 'c'.repeat(64), impactCents: -20, lines: [{ ...sourceLine, salaryImpactCents: -20 }] };
const next = await store.saveRefundReviewAssessment(db, actor, changed, { idempotencyKey: 'assessment-4' });
assert.equal(next.status, 'needs_review');
assert.equal(next.assessments.length, 2);
assert.equal(next.decisions.length, 2);
await assert.rejects(store.saveRefundReviewDecision(db, actor, first.caseId, changed, { ...opts, idempotencyKey: 'decision-4' }), { code: 'payroll_refund_review_stale_assessment' });
// Lost response replay survives newer source/assessment and terminal decision.
assert.deepEqual(await store.readRefundReviewDecisionReplay(db, actor, first.caseId, opts), { ...hold, replayed: true });
assert.deepEqual(await store.saveRefundReviewDecision(db, actor, first.caseId, changed, opts), { ...hold, replayed: true });
assert.deepEqual(await store.saveRefundReviewAssessment(db, actor, changed, { idempotencyKey: 'assessment-1' }), { ...first, replayed: true });
await assert.rejects(store.readRefundReviewDecisionReplay(db, actor, first.caseId, { ...opts, reason: 'Changed reason' }), { code: 'payroll_refund_review_idempotency_conflict' });
await assert.rejects(store.readRefundReviewDecisionReplay(db, { ...actor, userId: runId }, first.caseId, opts), { code: 'payroll_refund_review_idempotency_conflict' });
assert.equal(await store.readRefundReviewDecisionReplay(db, { ...actor, venueId: runId }, first.caseId, opts), null);
await assert.rejects(store.getRefundReview(db, { ...actor, venueId: runId }, first.caseId), { code: 'payroll_refund_review_not_found', status: 404 });
await assert.rejects(store.saveRefundReviewDecision(db, actor, first.caseId, changed, { ...opts, decision: 'acknowledge_no_effect', expectedAssessmentHash: next.latestAssessment.assessmentHash, idempotencyKey: 'decision-5' }), { code: 'payroll_refund_review_zero_effect_unproven' });
const zero = { ...payload, sourceHash: 'd'.repeat(64), impactCents: 0, lines: [] };
const zeroReview = await store.saveRefundReviewAssessment(db, actor, zero, { idempotencyKey: 'assessment-5' });
const ack = await store.saveRefundReviewDecision(db, actor, first.caseId, zero, { ...opts, decision: 'acknowledge_no_effect', expectedAssessmentHash: zeroReview.latestAssessment.assessmentHash, idempotencyKey: 'decision-6' });
assert.equal(ack.status, 'acknowledge_no_effect');
assert.equal(ack.officialReady, false);
assert.equal(ack.payoutEligible, false);
const unknown = { ...payload, sourceHash: 'e'.repeat(64), coverage: 'needs_review', impactCents: null, reasons: ['unsupported_mode'], lines: [{ ...sourceLine, salaryImpactCents: null }] };
const unknownReview = await store.saveRefundReviewAssessment(db, actor, unknown, { idempotencyKey: 'assessment-6' });
assert.equal(unknownReview.latestAssessment.impactCents, null);
const list = await store.listRefundReviews(db, actor, { runId, limit: '1' });
assert.equal(list.items.length, 1); assert.equal(list.items[0].caseId, first.caseId);
assert.equal(list.items[0].latestAssessment.impactCents, null);
assert.equal(list.nextCursor, null);
assert.equal(Object.hasOwn(list.items[0].latestAssessment, 'payload'), false);
assert.deepEqual((await store.listRefundReviews(db, actor, { runId: userId })).items, []);
await assert.rejects(store.listRefundReviews(db, actor, { limit: 101 }), { code: 'payroll_refund_review_invalid_limit' });
await assert.rejects(store.saveRefundReviewAssessment(db, actor, { ...payload, payoutEligible: true }, { idempotencyKey: 'bad-flags' }), { code: 'payroll_refund_review_invalid_payload' });
await assert.rejects(store.saveRefundReviewAssessment(db, actor, { ...unknown, impactCents: 0 }, { idempotencyKey: 'bad-unknown' }), { code: 'payroll_refund_review_invalid_payload' });
assert.equal(db.state.statements.some(sql => /\b(?:UPDATE|DELETE|TRUNCATE)\s+(?:payroll_entries|expenses|payroll_adjustments)\b/i.test(sql)), false);
const migration = readFileSync(new URL('../migrations/201_payroll_refund_review_proposals.sql', import.meta.url), 'utf8');
assert.match(migration, /BEFORE UPDATE OR DELETE/);
assert.match(migration, /BEFORE TRUNCATE/);
assert.match(migration, /sha256\(convert_to\(payload/);
assert.match(migration, /FOREIGN KEY\(venue_id,case_id,assessment_id,assessment_hash\)/);
assert.match(migration, /payroll_refund_review_one_terminal_decision/);
assert.doesNotMatch(migration, /(?:INSERT INTO|UPDATE|DELETE FROM|ALTER TABLE)\s+(?:payroll_entries|expenses|payroll_adjustments|pos_payroll_)/i);
console.log('PASS payroll refund review store contract (behavioral fake; no PostgreSQL claim)');
