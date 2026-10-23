import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { makeService } = require('../payroll-scheme-service.js');
const venueId = '11111111-1111-4111-8111-111111111111';
const ownerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const versionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const runId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const principal = { userId: ownerId, venueId };
const input = { schemeVersionId: versionId, periodFrom: '2026-10-01', periodTo: '2026-10-20',
  idempotencyKey: 'verified-service-contract' };
const engineVersion = 'payroll-verified-no-refund-v1';
const capabilityVersion = 'employee_attributed_merchandise_net_no_refund_v1';
// A substituted existing database row is sufficient for replay/control-flow
// checks. It is not source evidence, PostgreSQL trigger proof or a ready-run
// creation fixture; every unexpected collector/writer query fails this test.
const payload = JSON.stringify({ venueId, runId, schemeVersionId: versionId,
  period: { from: input.periodFrom, to: input.periodTo }, totalAmountCents: 1000 });
const checksum = createHash('sha256').update(payload).digest('hex');
const existingRun = { id: runId, scheme_version_id: versionId, period_from: input.periodFrom,
  period_to: input.periodTo, status: 'ready', engine_version: engineVersion, input_checksum: checksum };
const existingEvidence = { capability_version: capabilityVersion, evidence_payload: payload,
  evidence_sha256: checksum, total_amount_cents: '1000' };

function fixture({ authorized = true, rollbackError = null, unlockError = null, unlocked = true,
  run = existingRun, evidence = existingEvidence } = {}) {
  const calls = [], releases = [];
  let connects = 0;
  const client = {
    async query(sql, params = []) {
      const text = sql.replace(/\s+/g, ' ').trim();
      calls.push({ text, params });
      if (text === 'SELECT pg_advisory_lock(hashtextextended($1,0))') {
        assert.deepEqual(params, [`payroll-official-source-v1:${venueId}`]);
        return { rows: [], rowCount: 1 };
      }
      if (text === 'SELECT pg_advisory_unlock(hashtextextended($1,0)) AS unlocked') {
        assert.deepEqual(params, [`payroll-official-source-v1:${venueId}`]);
        if (unlockError) throw unlockError;
        return { rows: [{ unlocked }], rowCount: 1 };
      }
      if (text === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ WRITE') return { rows: [] };
      if (text === 'ROLLBACK') {
        if (rollbackError) throw rollbackError;
        return { rows: [] };
      }
      if (text === 'COMMIT') return { rows: [] };
      if (text.startsWith('SELECT id, full_name AS name FROM users')) {
        assert.deepEqual(params, [ownerId, venueId]);
        assert.match(text, /role = 'owner' AND is_active = true AND deleted_at IS NULL FOR SHARE$/);
        return { rows: authorized ? [{ id: ownerId, name: 'Contract Owner' }] : [] };
      }
      if (text === 'SELECT id,timezone FROM venues WHERE id=$1 FOR SHARE') {
        assert.deepEqual(params, [venueId]);
        return { rows: [{ id: venueId, timezone: 'UTC' }] };
      }
      if (text.startsWith('SELECT status,effective_from::text,effective_to::text FROM payroll_scheme_versions')) {
        assert.deepEqual(params, [venueId, versionId]);
        assert.match(text, /FOR SHARE$/);
        return { rows: [{ status: 'active', effective_from: '2026-10-01', effective_to: null }] };
      }
      if (text.startsWith('SELECT id,scheme_version_id,period_from::text,period_to::text, status,engine_version,input_checksum')) {
        assert.deepEqual(params, [venueId, input.idempotencyKey]);
        assert.match(text, /WHERE venue_id=\$1 AND idempotency_key=\$2 FOR SHARE$/);
        return { rows: run ? [{ ...run }] : [] };
      }
      if (text.startsWith('SELECT capability_version,evidence_payload,evidence_sha256,total_amount_cents FROM payroll_run_provenance')) {
        assert.deepEqual(params, [venueId, runId]);
        return { rows: evidence ? [{ ...evidence }] : [] };
      }
      assert.fail(`Unexpected source collection or write in replay/denial fixture: ${text}`);
    },
    release(error) { releases.push(error); }
  };
  const pool = {
    async connect() { connects += 1; return client; },
    async query() { assert.fail('service must use its dedicated transaction client'); }
  };
  return { service: makeService(pool), calls, releases, get connects() { return connects; } };
}
const codeIs = code => error => error?.code === code;
const assertOneRelease = (state, error = undefined) => {
  assert.equal(state.releases.length, 1, 'pooled client is released exactly once');
  assert.equal(state.releases[0], error);
};
const positions = state => state.calls.map(call => call.text);

{
  const badPayload = JSON.stringify({ ...JSON.parse(payload), calculatorReplay: {} });
  const badHash = createHash('sha256').update(badPayload).digest('hex');
  const state = fixture({ run: { ...existingRun, input_checksum: badHash },
    evidence: { ...existingEvidence, evidence_payload: badPayload, evidence_sha256: badHash } });
  await assert.rejects(state.service.createVerifiedRun(principal, input), codeIs('payroll_run_evidence_invalid'));
  assert.ok(positions(state).includes('ROLLBACK'));
  assertOneRelease(state);
}

for (const invalid of [
  null, [], { ...input, clientResult: {} }, { ...input, schemeVersionId: 'invalid' },
  { ...input, idempotencyKey: 'short' }, { ...input, idempotencyKey: 'bad key with spaces' },
  { ...input, idempotencyKey: 'x'.repeat(121) },
  Object.assign(Object.create({ inherited: true }), input),
  { ...input, [Symbol('extra')]: true },
  Object.defineProperty({ ...input }, 'periodFrom', { enumerable: true,
    get() { assert.fail('request getter must not execute'); } })
]) {
  const state = fixture();
  await assert.rejects(() => state.service.createVerifiedRun(principal, invalid), codeIs('invalid_payroll_verified_run_request'));
  assert.equal(state.connects, 0, 'invalid request is rejected before pool.connect');
  assert.equal(state.releases.length, 0);
}
for (const invalidPrincipal of [null, {}, { ...principal, userId: 'not-a-uuid' }, { ...principal, venueId: 'not-a-uuid' }]) {
  const state = fixture();
  await assert.rejects(() => state.service.createVerifiedRun(invalidPrincipal, input), codeIs('authenticated_owner_required'));
  assert.equal(state.connects, 0, 'malformed principal is rejected before pool.connect');
}
for (const period of [
  { periodFrom: '2026-10-11', periodTo: '2026-10-20' },
  { periodFrom: '2026-10-01', periodTo: '2026-11-01' },
  { periodFrom: '2026-02-01', periodTo: '2026-02-30' }
]) {
  const state = fixture();
  await assert.rejects(() => state.service.createVerifiedRun(principal, { ...input, ...period }),
    codeIs('invalid_payroll_source_readiness_period'));
  assert.equal(state.connects, 0, 'existing month-from-01 collector boundary is retained before connecting');
}

{
  const state = fixture({ authorized: false });
  await assert.rejects(() => state.service.createVerifiedRun(principal, input),
    error => error.code === 'payroll_scheme_owner_only' && error.status === 403);
  assertOneRelease(state);
  assert.deepEqual(positions(state).slice(-2), [
    'ROLLBACK', 'SELECT pg_advisory_unlock(hashtextextended($1,0)) AS unlocked'
  ]);
  assert.equal(state.calls.filter(call => /FROM payroll_/.test(call.text)).length, 0,
    'owner denial precedes scheme/run/source reads');
  assert.ok(!positions(state).includes('COMMIT'));
}

{
  const rollbackError = new Error('injected rollback cleanup failure');
  const state = fixture({ authorized: false, rollbackError });
  await assert.rejects(() => state.service.createVerifiedRun(principal, input), codeIs('payroll_scheme_owner_only'));
  assertOneRelease(state, rollbackError);
  assert.match(positions(state).at(-1), /^SELECT pg_advisory_unlock/,
    'unlock is attempted even when rollback fails');
}

for (const transportFailure of [false, true]) {
  const unlockError = transportFailure ? new Error('injected unlock transport failure') : null;
  const state = fixture({ unlocked: false, unlockError });
  let observed;
  await assert.rejects(() => state.service.createVerifiedRun(principal, input), error => {
    observed = error;
    return transportFailure ? error === unlockError : error.message === 'payroll_source_snapshot_lock_release_failed';
  });
  assertOneRelease(state, observed);
  assert.equal(positions(state).at(-2), 'COMMIT', 'replay committed before unlock failure; outcome must not be retried as a new key');
}

{
  const rollbackError = new Error('injected rollback failure');
  const unlockError = new Error('injected unlock failure');
  const state = fixture({ authorized: false, rollbackError, unlockError });
  await assert.rejects(() => state.service.createVerifiedRun(principal, input), error => error === unlockError);
  assertOneRelease(state, unlockError);
}

{
  const state = fixture();
  const replay = await state.service.createVerifiedRun(
    { userId: ownerId.toUpperCase(), venueId: venueId.toUpperCase() },
    { ...input, schemeVersionId: versionId.toUpperCase() });
  assert.deepEqual(replay, { status: 'ready', runId, amountCents: 1000, capabilityVersion,
    replayed: true, officialReady: false, payoutEligible: false, persistence: 'snapshots' });
  assertOneRelease(state);
  assert.equal(state.connects, 1);
  assert.deepEqual(positions(state).slice(0, 2), [
    'SELECT pg_advisory_lock(hashtextextended($1,0))',
    'BEGIN ISOLATION LEVEL REPEATABLE READ READ WRITE'
  ], 'source fence is acquired before the repeatable-read transaction establishes a snapshot');
  assert.ok(!positions(state).includes('ROLLBACK'));
  assert.deepEqual(positions(state).slice(-2), [
    'COMMIT', 'SELECT pg_advisory_unlock(hashtextextended($1,0)) AS unlocked'
  ]);
  assert.equal(state.calls.filter(call => call.text.includes('FROM payroll_run_provenance')).length, 1);
}

for (const changes of [
  { scheme_version_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' },
  { period_from: '2026-10-02' }, { period_to: '2026-10-21' },
  { status: 'blocked' }, { engine_version: 'another-engine' }
]) {
  const state = fixture({ run: { ...existingRun, ...changes } });
  await assert.rejects(() => state.service.createVerifiedRun(principal, input),
    error => error.code === 'payroll_run_idempotency_conflict' && error.status === 409);
  assertOneRelease(state);
  assert.equal(state.calls.filter(call => call.text.includes('FROM payroll_run_provenance')).length, 0);
  assert.ok(positions(state).includes('ROLLBACK'));
}

for (const evidence of [
  null, { ...existingEvidence, evidence_sha256: '0'.repeat(64) },
  { ...existingEvidence, evidence_payload: `${payload} ` },
  { ...existingEvidence, capability_version: 'other-capability' },
  { ...existingEvidence, total_amount_cents: '9007199254740992' }
]) {
  const state = fixture({ evidence });
  await assert.rejects(() => state.service.createVerifiedRun(principal, input),
    error => error.code === 'payroll_run_evidence_invalid' && error.status === 409);
  assertOneRelease(state);
  assert.ok(positions(state).includes('ROLLBACK'));
}

console.log('PASS payroll-verified-run-service-contract: validation, owner denial, cleanup, replay and conflict (fake DB; no ready-source or PostgreSQL proof)');
