import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { runInThisContext } from 'node:vm';

const require = createRequire(import.meta.url);
const filename = require.resolve('../payroll-scheme-service.js');
const localRequire = createRequire(filename);
const { hasPayrollVerifiedWriteSnapshot } = require('../payroll-source-fence');
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const venueId = id(1), userId = id(2), runId = id(3), caseId = id(4);
const principal = { venueId, userId };
const createInput = { idempotencyKey: 'review-create-001' };
const decisionInput = { decision: 'hold_for_review', reason: 'Check the source facts',
  expectedAssessmentHash: 'a'.repeat(64), idempotencyKey: 'review-decision-001' };
const LOCK = 'SELECT pg_advisory_lock(hashtextextended($1,0))';
const UNLOCK = 'SELECT pg_advisory_unlock(hashtextextended($1,0)) AS unlocked';
const BEGIN = 'BEGIN ISOLATION LEVEL REPEATABLE READ READ WRITE';
const result = { caseId, runId, replayed: false, officialReady: false, payoutEligible: false };

// Execute the actual service module with module-local collector/store seams.
// Source-fence, transaction wrapper and DB owner authorization are real code.
// These checks establish sequencing and cleanup, not SQL persistence or source
// correctness; separate PostgreSQL/collector contracts cover those boundaries.
function fixture({ authorized = true, replay = null, failureAt, error = new Error('injected failure'),
  rollbackError, unlockError, unlocked = true } = {}) {
  const calls = [], releases = [];
  let connects = 0;
  const client = {
    async query(sql, params = []) {
      const text = sql.replace(/\s+/g, ' ').trim(); calls.push(text);
      if (text === LOCK || text === UNLOCK) {
        assert.deepEqual(params, [`payroll-official-source-v1:${venueId}`]);
        if (text === LOCK) return { rows: [] };
        if (unlockError) throw unlockError;
        return { rows: [{ unlocked }] };
      }
      if (text === BEGIN || text === 'COMMIT') {
        if (failureAt === text) throw error;
        return { rows: [] };
      }
      if (text === 'ROLLBACK') { if (rollbackError) throw rollbackError; return { rows: [] }; }
      if (text.startsWith('SELECT id, full_name AS name FROM users')) {
        assert.deepEqual(params, [userId, venueId]);
        assert.match(text, /role = 'owner' AND is_active = true AND deleted_at IS NULL FOR SHARE$/);
        return { rows: authorized ? [{ id: userId, name: 'Owner' }] : [] };
      }
      assert.fail(`Unexpected SQL through isolated service fixture: ${text}`);
    },
    release(error) { releases.push(error); }
  };
  const check = (name, db, actor) => {
    calls.push(name); assert.equal(db, client);
    assert.deepEqual(actor, { venueId, userId, name: 'Owner' });
    assert.equal(hasPayrollVerifiedWriteSnapshot(client, venueId), true);
    if (failureAt === name) throw error;
  };
  const store = {
    async readRefundReviewAssessmentReplay(db, actor, requestedRun, input) {
      check('assessmentReplay', db, actor); assert.equal(requestedRun, runId); assert.deepEqual(input, createInput); return replay;
    },
    async readRefundReviewDecisionReplay(db, actor, requestedCase, input) {
      check('decisionReplay', db, actor); assert.equal(requestedCase, caseId); assert.deepEqual(input, decisionInput); return replay;
    },
    async getRefundReview(db, actor, requestedCase) {
      check('getCase', db, actor); assert.equal(requestedCase, caseId); return { caseId, runId };
    },
    async saveRefundReviewAssessment(db, actor, assessment, input) {
      check('saveAssessment', db, actor); assert.deepEqual(assessment, { runId }); assert.deepEqual(input, createInput); return result;
    },
    async saveRefundReviewDecision(db, actor, requestedCase, assessment, input) {
      check('saveDecision', db, actor); assert.equal(requestedCase, caseId);
      assert.deepEqual(assessment, { runId }); assert.deepEqual(input, decisionInput); return result;
    }
  };
  const collector = async (db, actor, requestedRun) => {
    check('collect', db, actor); assert.equal(requestedRun, runId); return { runId };
  };
  const isolated = { exports: {} };
  const wrapper = runInThisContext(`(function(require,module,exports,__filename,__dirname){\n${readFileSync(filename, 'utf8')}\n})`, { filename });
  wrapper(name => name === './payroll-refund-review-store' ? store
    : name === './payroll-refund-review-assessment' ? { collectPayrollRefundReviewAssessment: collector }
      : localRequire(name), isolated, isolated.exports, filename, dirname(filename));
  const pool = { async connect() { connects++; return client; }, async query() { assert.fail('Dedicated client required'); } };
  const service = isolated.exports.makeService(pool);
  return { service, calls, releases, client, get connects() { return connects; } };
}
const inspect = (state, decision = false) => decision
  ? state.service.decideRefundReview(principal, caseId, decisionInput)
  : state.service.createRefundReview(principal, runId, createInput);
function releaseCheck(state, discard) {
  assert.deepEqual(state.releases, [discard]);
  assert.deepEqual(state.calls.slice(0, 2), [LOCK, BEGIN]);
  assert.equal(state.calls.filter(call => call === UNLOCK).length, 1, 'unlock attempted exactly once');
  assert.ok([UNLOCK, 'ROLLBACK'].includes(state.calls.at(-1)));
  assert.equal(hasPayrollVerifiedWriteSnapshot(state.client, venueId), false, 'private write capability must be revoked');
}

for (const decision of [false, true]) {
  {
    const state = fixture();
    assert.equal(await inspect(state, decision), result);
    assert.deepEqual(state.calls.slice(3), decision
      ? ['decisionReplay', 'getCase', 'collect', 'saveDecision', 'COMMIT', UNLOCK]
      : ['assessmentReplay', 'collect', 'saveAssessment', 'COMMIT', UNLOCK]);
    releaseCheck(state);
  }
  {
    const replay = { ...result, replayed: true }, state = fixture({ replay, failureAt: 'collect' });
    assert.equal(await inspect(state, decision), replay);
    assert.deepEqual(state.calls.slice(3), [decision ? 'decisionReplay' : 'assessmentReplay', 'COMMIT', UNLOCK],
      'lost response replay must not recollect changed sources or write again');
    releaseCheck(state);
  }
  {
    const state = fixture({ authorized: false });
    await assert.rejects(inspect(state, decision), error => error.code === 'payroll_scheme_owner_only' && error.status === 403);
    assert.deepEqual(state.calls.slice(3), ['ROLLBACK', UNLOCK], 'denial precedes replay, reads, collection and writes');
    releaseCheck(state);
  }
}
for (const malformed of [null, {}, { userId, venueId: 'bad' }, { userId: 'bad', venueId },
  Object.create(principal), Object.defineProperty({ venueId }, 'userId', { enumerable: true, get() { assert.fail('principal getter executed'); } })]) {
  const state = fixture();
  await assert.rejects(state.service.createRefundReview(malformed, runId, createInput), error => error.code === 'authenticated_owner_required');
  assert.equal(state.connects, 0);
}
for (const input of [null, [], {}, { ...createInput, amount: 100 }, { idempotencyKey: 'short' },
  { ...createInput, [Symbol('extra')]: true }, Object.create(createInput),
  Object.defineProperty({}, 'idempotencyKey', { enumerable: true, get() { assert.fail('request getter executed'); } })]) {
  const state = fixture();
  await assert.rejects(state.service.createRefundReview(principal, runId, input), error => error.code === 'invalid_payroll_refund_review_request');
  assert.equal(state.connects, 0);
}
for (const input of [{ ...decisionInput, decision: 'deduct' }, { ...decisionInput, reason: 'x' },
  { ...decisionInput, expectedAssessmentHash: 'bad' }, { ...decisionInput, employeeId: userId },
  { ...decisionInput, idempotencyKey: '' }]) {
  const state = fixture();
  await assert.rejects(state.service.decideRefundReview(principal, caseId, input), error => error.code === 'invalid_payroll_refund_review_request');
  assert.equal(state.connects, 0);
}
{
  const state = fixture();
  await assert.rejects(state.service.createRefundReview(principal, 'bad', createInput), error => error.code === 'invalid_payroll_refund_review_request');
  assert.equal(state.connects, 0);
}
for (const failureAt of [BEGIN, 'assessmentReplay', 'collect', 'saveAssessment', 'COMMIT', 'getCase', 'saveDecision']) {
  const error = Object.assign(new Error('source changed'), { code: 'payroll_refund_review_assessment_stale', status: 409 });
  const state = fixture({ failureAt, error });
  await assert.rejects(inspect(state, ['getCase', 'saveDecision'].includes(failureAt)), actual => actual === error);
  if (failureAt === BEGIN) assert.deepEqual(state.calls.slice(-2), [UNLOCK, 'ROLLBACK'], 'BEGIN failure releases helper-owned fence before wrapper rollback');
  else assert.equal(state.calls.at(-2), 'ROLLBACK');
  releaseCheck(state);
}
{
  const rollbackError = new Error('rollback transport failed'), state = fixture({ failureAt: 'collect', rollbackError });
  await assert.rejects(inspect(state), /injected failure/);
  releaseCheck(state, rollbackError);
}
for (const failureAt of [undefined, BEGIN, 'collect']) {
  const unlockError = new Error('unlock transport failed'), state = fixture({ failureAt, unlockError });
  await assert.rejects(inspect(state), error => error === unlockError);
  releaseCheck(state, unlockError);
}
{
  const state = fixture({ unlocked: false }); let caught;
  await assert.rejects(inspect(state), error => { caught = error; return error.message === 'payroll_source_snapshot_lock_release_failed'; });
  releaseCheck(state, caught);
}
for (const [code, mapped] of [['40001', 'payroll_refund_review_retry_required'], ['40P01', 'payroll_refund_review_retry_required'],
  ['23505', 'payroll_refund_review_conflict'], ['42P01', 'payroll_refund_review_schema_required']]) {
  const state = fixture({ failureAt: 'saveAssessment', error: Object.assign(new Error('db failure'), { code }) });
  await assert.rejects(inspect(state), error => error.code === mapped && error.status === 409);
  releaseCheck(state);
}
console.log('PASS payroll-refund-review-service-contract: real owner/source-fence wrapper, strict requests, replay ordering and transaction cleanup; collector/store seams, no PostgreSQL proof');
