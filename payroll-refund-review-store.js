'use strict';

// Caller owns authenticated owner authorization, pre-BEGIN source fence, and one
// repeatable-read read/write transaction. This journal never posts money.
const { createHash, randomUUID } = require('node:crypto');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{64}$/;
const POLICY = 'saved-run-refund-review-v1';
const BASIS = 'saved_calculation_unposted';
const DECISIONS = new Set(['hold_for_review', 'close_without_payroll_change', 'acknowledge_no_effect']);
class PayrollRefundReviewStoreError extends Error {
  constructor(code, status = 400) { super(`payroll_refund_review_${code}`); this.code = this.message; this.status = status; }
}
const fail = (code, status) => { throw new PayrollRefundReviewStoreError(code, status); };
const object = value => Boolean(value && Object.getPrototypeOf(value) === Object.prototype);
const id = value => { if (typeof value !== 'string' || !UUID.test(value)) fail('invalid_id'); return value.toLowerCase(); };
const hash = value => createHash('sha256').update(value).digest('hex');
const canonical = value => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (!object(value) || Reflect.ownKeys(value).some(key => typeof key !== 'string')
    || Object.values(Object.getOwnPropertyDescriptors(value)).some(d => !Object.hasOwn(d, 'value'))) fail('invalid_payload');
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
};
const actorContext = (db, actor) => {
  if (!db || typeof db.query !== 'function') throw new TypeError('payroll_refund_review_client_required');
  if (!object(actor) || typeof actor.name !== 'string' || actor.name.length > 500) fail('invalid_actor');
  return { venueId: id(actor.venueId), userId: id(actor.userId), name: actor.name };
};
const key = value => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{8,120}$/.test(value)) fail('invalid_idempotency_key');
  return value;
};
const sha = value => { if (typeof value !== 'string' || !SHA.test(value)) fail('invalid_hash'); return value; };
const optionsShape = (value, allowed) => {
  if (!object(value) || Reflect.ownKeys(value).some(k => !allowed.includes(k))
    || Object.values(Object.getOwnPropertyDescriptors(value)).some(d => !Object.hasOwn(d, 'value'))) fail('invalid_options');
};
const assessmentOptions = options => { optionsShape(options, ['idempotencyKey']); return { idempotencyKey: key(options.idempotencyKey) }; };
const decisionOptions = options => {
  optionsShape(options, ['decision', 'reason', 'expectedAssessmentHash', 'idempotencyKey']);
  if (!DECISIONS.has(options.decision) || typeof options.reason !== 'string'
    || options.reason.length > 2000 || !options.reason.trim()) fail('invalid_decision');
  return { decision: options.decision, reason: options.reason, expectedAssessmentHash: sha(options.expectedAssessmentHash), idempotencyKey: key(options.idempotencyKey) };
};
const validatePayload = (payload, actor) => {
  if (!object(payload) || payload.schemaVersion !== 1 || payload.policyVersion !== POLICY || payload.basis !== BASIS
    || payload.venueId !== actor.venueId || id(payload.runId) !== payload.runId || payload.currency !== 'RUB'
    || !SHA.test(payload.provenanceSha256 || '') || !SHA.test(payload.sourceHash || '')
    || !['complete', 'needs_review'].includes(payload.coverage)
    || !(payload.impactCents === null || Number.isSafeInteger(payload.impactCents))
    || (payload.coverage === 'needs_review' && payload.impactCents !== null)
    || !Array.isArray(payload.reasons) || !Array.isArray(payload.lines) || payload.lines.length > 20000
    || payload.officialReady !== false || payload.payoutEligible !== false) fail('invalid_payload');
  if ((payload.coverage === 'complete' && (payload.impactCents === null || payload.reasons.length))
    || (payload.coverage === 'needs_review' && !payload.reasons.length)) fail('invalid_payload');
  const text = canonical(payload);
  if (Buffer.byteLength(text) > 4194304) fail('payload_too_large');
  return { text, assessmentHash: hash(text) };
};
const timestamp = value => value instanceof Date ? value.toISOString() : value;
const amount = value => {
  if (value === null) return null;
  if (!/^-?(0|[1-9][0-9]*)$/.test(String(value)) || !Number.isSafeInteger(Number(value))) fail('evidence_invalid', 409);
  return Number(value);
};
const assessmentDto = row => ({ id: row.id, assessmentHash: row.assessment_hash, sourceHash: row.source_hash,
  coverage: row.coverage, impactCents: amount(row.impact_cents), createdAt: timestamp(row.created_at), createdByName: row.created_by_name });
const decisionDto = row => ({ id: row.id, assessmentId: row.assessment_id, assessmentHash: row.assessment_hash,
  decision: row.decision, reason: row.reason, createdAt: timestamp(row.created_at), createdByName: row.created_by_name });
const statusFor = decision => !decision ? 'needs_review' : decision.decision;
const META = 'id,assessment_hash,source_hash,coverage,impact_cents::text,created_at,created_by_name';
const readPayload = row => {
  if (!row || typeof row.payload !== 'string' || hash(row.payload) !== row.assessment_hash) fail('evidence_invalid', 409);
  try { return JSON.parse(row.payload); } catch (_) { fail('evidence_invalid', 409); }
};

async function getRefundReview(db, actor, caseId) {
  actor = actorContext(db, actor); caseId = id(caseId);
  const parent = (await db.query('SELECT id,run_id,created_at,created_by_name FROM payroll_refund_review_cases WHERE venue_id=$1 AND id=$2', [actor.venueId, caseId])).rows[0];
  if (!parent) fail('not_found', 404);
  const assessments = (await db.query(`SELECT ${META} FROM payroll_refund_review_assessments WHERE venue_id=$1 AND case_id=$2 ORDER BY sequence_no DESC LIMIT 101`, [actor.venueId, caseId])).rows;
  if (!assessments.length) fail('evidence_invalid', 409);
  const decisions = (await db.query('SELECT id,assessment_id,assessment_hash,decision,reason,created_at,created_by_name FROM payroll_refund_review_decisions WHERE venue_id=$1 AND case_id=$2 ORDER BY sequence_no DESC LIMIT 101', [actor.venueId, caseId])).rows;
  const latest = assessments[0];
  const payload = readPayload((await db.query('SELECT payload,assessment_hash FROM payroll_refund_review_assessments WHERE venue_id=$1 AND id=$2', [actor.venueId, latest.id])).rows[0]);
  return { schemaVersion: 1, caseId: parent.id, runId: parent.run_id, basis: BASIS,
    status: statusFor(decisions.find(row => row.assessment_id === latest.id)), createdAt: timestamp(parent.created_at), createdByName: parent.created_by_name,
    latestAssessment: { ...assessmentDto(latest), payload }, assessments: assessments.slice(0, 100).map(assessmentDto),
    decisions: decisions.slice(0, 100).map(decisionDto), historyTruncated: { assessments: assessments.length > 100, decisions: decisions.length > 100 },
    officialReady: false, payoutEligible: false, replayed: false };
}

async function listRefundReviews(db, actor, query = {}) {
  actor = actorContext(db, actor); optionsShape(query, ['limit', 'cursor', 'runId']);
  const limitText = query.limit === undefined ? '25' : String(query.limit);
  if (!['string', 'number', 'undefined'].includes(typeof query.limit) || !/^[1-9][0-9]{0,2}$/.test(limitText) || Number(limitText) > 100) fail('invalid_limit');
  const limit = Number(limitText), runId = query.runId === undefined ? null : id(query.runId);
  const scope = `refund-reviews:${actor.venueId}:${runId || '*'}`;
  let cursor = null;
  if (query.cursor !== undefined) {
    if (typeof query.cursor !== 'string' || !/^[A-Za-z0-9_-]{1,1000}$/.test(query.cursor)) fail('invalid_cursor');
    let parsed;
    try { const buffer = Buffer.from(query.cursor, 'base64url'); if (buffer.toString('base64url') !== query.cursor) fail('invalid_cursor'); parsed = JSON.parse(buffer.toString('utf8')); } catch (_) { fail('invalid_cursor'); }
    if (!object(parsed) || Object.keys(parsed).sort().join(',') !== 'after,scope' || parsed.scope !== scope) fail('invalid_cursor');
    cursor = id(parsed.after);
  }
  const rows = (await db.query(`SELECT c.id AS case_id,c.run_id,c.created_at AS case_created_at,c.created_by_name AS case_created_by_name,
      a.id,a.assessment_hash,a.source_hash,a.coverage,a.impact_cents::text,a.created_at,a.created_by_name,d.decision
    FROM payroll_refund_review_cases c
    JOIN LATERAL (SELECT * FROM payroll_refund_review_assessments a WHERE a.venue_id=c.venue_id AND a.case_id=c.id ORDER BY a.sequence_no DESC LIMIT 1) a ON true
    LEFT JOIN LATERAL (SELECT decision FROM payroll_refund_review_decisions d WHERE d.venue_id=c.venue_id AND d.assessment_id=a.id ORDER BY d.sequence_no DESC LIMIT 1) d ON true
    WHERE c.venue_id=$1 AND ($2::uuid IS NULL OR c.run_id=$2) AND ($3::uuid IS NULL OR c.id>$3)
    ORDER BY c.id LIMIT $4`, [actor.venueId, runId, cursor, limit + 1])).rows;
  return { items: rows.slice(0, limit).map(row => ({ caseId: row.case_id, runId: row.run_id, basis: BASIS,
    createdAt: timestamp(row.case_created_at), createdByName: row.case_created_by_name, status: row.decision || 'needs_review',
    latestAssessment: assessmentDto(row), officialReady: false, payoutEligible: false })),
  nextCursor: rows.length > limit ? Buffer.from(JSON.stringify({ scope, after: rows[limit - 1].case_id })).toString('base64url') : null };
}

const requestHash = (actor, kind, targetId, options) => hash(canonical({ actorId: actor.userId, kind, targetId,
  ...(kind === 'decision' ? { decision: options.decision, reason: options.reason, expectedAssessmentHash: options.expectedAssessmentHash } : {}) }));
async function readReplay(db, actor, kind, targetId, options) {
  const row = (await db.query('SELECT request_kind,request_hash,response_payload,response_hash FROM payroll_refund_review_requests WHERE venue_id=$1 AND idempotency_key=$2', [actor.venueId, options.idempotencyKey])).rows[0];
  if (!row) return null;
  if (row.request_kind !== kind || row.request_hash !== requestHash(actor, kind, targetId, options)) fail('idempotency_conflict', 409);
  if (typeof row.response_payload !== 'string' || hash(row.response_payload) !== row.response_hash) fail('evidence_invalid', 409);
  let response; try { response = JSON.parse(row.response_payload); } catch (_) { fail('evidence_invalid', 409); }
  return { ...response, replayed: true };
}
async function readRefundReviewAssessmentReplay(db, actor, runId, options) {
  actor = actorContext(db, actor); return readReplay(db, actor, 'assessment', id(runId), assessmentOptions(options));
}
async function readRefundReviewDecisionReplay(db, actor, caseId, options) {
  actor = actorContext(db, actor); return readReplay(db, actor, 'decision', id(caseId), decisionOptions(options));
}
async function recordRequest(db, actor, kind, targetId, options, response, decisionId = null) {
  const text = canonical(response);
  if (Buffer.byteLength(text) > 8388608) fail('response_too_large');
  await db.query(`INSERT INTO payroll_refund_review_requests
    (venue_id,idempotency_key,request_kind,request_hash,case_id,assessment_id,assessment_hash,decision_id,response_payload,response_hash,created_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [actor.venueId, options.idempotencyKey, kind, requestHash(actor, kind, targetId, options),
    response.caseId, response.latestAssessment.id, response.latestAssessment.assessmentHash, decisionId, text, hash(text), actor.userId]);
  return response;
}

async function saveRefundReviewAssessment(db, actor, payload, options) {
  actor = actorContext(db, actor); options = assessmentOptions(options);
  const replay = await readReplay(db, actor, 'assessment', id(payload?.runId), options);
  if (replay) return replay;
  const validated = validatePayload(payload, actor);
  await db.query(`INSERT INTO payroll_refund_review_cases(id,venue_id,run_id,created_by,created_by_name)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT(venue_id,run_id) DO NOTHING`, [randomUUID(), actor.venueId, payload.runId, actor.userId, actor.name]);
  const parent = (await db.query('SELECT id FROM payroll_refund_review_cases WHERE venue_id=$1 AND run_id=$2 FOR UPDATE', [actor.venueId, payload.runId])).rows[0];
  if (!parent) fail('concurrent_change', 409);
  const prior = (await db.query('SELECT id,assessment_hash FROM payroll_refund_review_assessments WHERE venue_id=$1 AND case_id=$2 AND source_hash=$3', [actor.venueId, parent.id, payload.sourceHash])).rows[0];
  if (prior && prior.assessment_hash !== validated.assessmentHash) fail('non_deterministic_assessment', 409);
  if (!prior) await db.query(`INSERT INTO payroll_refund_review_assessments
    (id,venue_id,case_id,run_id,source_hash,assessment_hash,payload,coverage,impact_cents,created_by,created_by_name)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [randomUUID(), actor.venueId, parent.id, payload.runId, payload.sourceHash, validated.assessmentHash,
    validated.text, payload.coverage, payload.impactCents, actor.userId, actor.name]);
  const response = await getRefundReview(db, actor, parent.id);
  if (response.latestAssessment.assessmentHash !== validated.assessmentHash) fail('source_history_regressed', 409);
  return recordRequest(db, actor, 'assessment', payload.runId, options, response);
}

async function saveRefundReviewDecision(db, actor, caseId, payload, options) {
  actor = actorContext(db, actor); caseId = id(caseId); options = decisionOptions(options);
  const replay = await readReplay(db, actor, 'decision', caseId, options);
  if (replay) return replay;
  const validated = validatePayload(payload, actor);
  const parent = (await db.query('SELECT id,run_id FROM payroll_refund_review_cases WHERE venue_id=$1 AND id=$2 FOR UPDATE', [actor.venueId, caseId])).rows[0];
  if (!parent) fail('not_found', 404);
  if (parent.run_id !== payload.runId) fail('stale_assessment', 409);
  const latest = (await db.query(`SELECT ${META} FROM payroll_refund_review_assessments WHERE venue_id=$1 AND case_id=$2 ORDER BY sequence_no DESC LIMIT 1`, [actor.venueId, caseId])).rows[0];
  if (!latest || latest.assessment_hash !== options.expectedAssessmentHash || latest.assessment_hash !== validated.assessmentHash
    || latest.source_hash !== payload.sourceHash) fail('stale_assessment', 409);
  const terminal = (await db.query("SELECT id FROM payroll_refund_review_decisions WHERE venue_id=$1 AND assessment_id=$2 AND decision<>'hold_for_review' LIMIT 1", [actor.venueId, latest.id])).rows[0];
  if (terminal) fail('already_decided', 409);
  if (options.decision === 'acknowledge_no_effect' && (payload.coverage !== 'complete' || payload.impactCents !== 0)) fail('zero_effect_unproven', 409);
  const decisionId = randomUUID();
  await db.query(`INSERT INTO payroll_refund_review_decisions
    (id,venue_id,case_id,assessment_id,assessment_hash,decision,reason,created_by,created_by_name)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [decisionId, actor.venueId, caseId, latest.id, latest.assessment_hash, options.decision, options.reason, actor.userId, actor.name]);
  return recordRequest(db, actor, 'decision', caseId, options, await getRefundReview(db, actor, caseId), decisionId);
}

module.exports = { PayrollRefundReviewStoreError, saveRefundReviewAssessment, listRefundReviews, getRefundReview,
  saveRefundReviewDecision, readRefundReviewAssessmentReplay, readRefundReviewDecisionReplay };
