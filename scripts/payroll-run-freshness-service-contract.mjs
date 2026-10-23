import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { runInThisContext } from 'node:vm';

const require = createRequire(import.meta.url);
const { makeService } = require('../payroll-scheme-service.js');
const { hasPayrollVerifiedSourceSnapshot, hasPayrollVerifiedWriteSnapshot } = require('../payroll-source-fence.js');
const servicePath = require.resolve('../payroll-scheme-service.js');
const serviceRequire = createRequire(servicePath);
const venueId = '11111111-1111-4111-8111-111111111111';
const ownerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const runId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const principal = { userId: ownerId, venueId };
const lock = 'SELECT pg_advisory_lock(hashtextextended($1,0))';
const unlock = 'SELECT pg_advisory_unlock(hashtextextended($1,0)) AS unlocked';
const begin = 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY';

// Module-local dependency seam only for callback success/failure. The service,
// withOwnerRead, DB-owner query and source-fence implementation remain actual
// product code. This is not collector, calculator or PostgreSQL evidence.
function serviceWithCallback(callback) {
  const isolated = { exports: {} };
  const wrapper = runInThisContext(`(function(require,module,exports,__filename,__dirname){\n${readFileSync(servicePath, 'utf8')}\n})`,
    { filename: servicePath });
  wrapper(name => name === './payroll-run-source-freshness'
    ? { checkPayrollRunSourceFreshnessInTransaction: callback } : serviceRequire(name),
  isolated, isolated.exports, servicePath, dirname(servicePath));
  return isolated.exports.makeService;
}

function fixture({ authorized = true, readError, beginError, commitError, rollbackError,
  unlockError, unlocked = true, callback } = {}) {
  const calls = [], releases = [];
  let callbackCalls = 0;
  const client = {
    async query(sql, params = []) {
      const text = sql.replace(/\s+/g, ' ').trim();
      calls.push({ text, params });
      if (text === lock || text === unlock) {
        assert.deepEqual(params, [`payroll-official-source-v1:${venueId}`]);
        if (text === lock) return { rows: [] };
        if (unlockError) throw unlockError;
        return { rows: [{ unlocked }] };
      }
      if (text === begin) { if (beginError) throw beginError; return { rows: [] }; }
      if (text === 'ROLLBACK') { if (rollbackError) throw rollbackError; return { rows: [] }; }
      if (text === 'COMMIT') { if (commitError) throw commitError; return { rows: [] }; }
      if (text.startsWith('SELECT id, full_name AS name FROM users')) {
        assert.deepEqual(params, [ownerId, venueId]);
        assert.match(text, /role = 'owner' AND is_active = true AND deleted_at IS NULL$/);
        return { rows: authorized ? [{ id: ownerId, name: 'Contract Owner' }] : [] };
      }
      if (text.startsWith('SELECT r.id,r.venue_id,r.scheme_version_id')) {
        assert.deepEqual(params, [venueId, runId, ['payroll-verified-no-refund-v1', 'payroll-verified-remaining-net-v2']]);
        assert.match(text, /WHERE r.venue_id=\$1 AND r.id=\$2 AND r.status='ready' AND r.engine_version=ANY\(\$3::text\[\]\)$/);
        if (readError) throw readError;
        return { rows: [] };
      }
      assert.fail(`Unexpected source read or write: ${text}`);
    },
    release(error) {
      assert.equal(hasPayrollVerifiedSourceSnapshot(client, venueId), false, 'private source capability cleared before pooling');
      assert.equal(hasPayrollVerifiedWriteSnapshot(client, venueId), false);
      releases.push(error);
    }
  };
  const pool = { async connect() { return client; }, async query() { assert.fail('Dedicated transaction client required'); } };
  const factory = callback ? serviceWithCallback(async (db, actor, requestedRunId, collector) => {
    callbackCalls++;
    assert.equal(db, client);
    assert.deepEqual(actor, { venueId, userId: ownerId, name: 'Contract Owner' });
    assert.equal(requestedRunId, runId);
    assert.equal(typeof collector, 'function');
    assert.equal(hasPayrollVerifiedSourceSnapshot(db, venueId), true, 'freshness callback has private read capability');
    assert.equal(hasPayrollVerifiedWriteSnapshot(db, venueId), false, 'freshness read must never acquire write capability');
    return callback();
  }) : makeService;
  return { service: factory(pool), calls, releases, get callbackCalls() { return callbackCalls; } };
}
const texts = state => state.calls.map(call => call.text);
function released(state, error, beginFailed = false) {
  assert.deepEqual(state.releases, [error], 'exactly one release, with discard error where required');
  assert.deepEqual(texts(state).slice(0, 2), [lock, begin], 'session fence must precede RR snapshot');
  if (beginFailed) assert.deepEqual(texts(state).slice(-2), [unlock, 'ROLLBACK'],
    'failed helper initialization releases lock before wrapper rolls back; source callback never ran');
  else assert.equal(texts(state).at(-1), unlock, 'unlock always attempted before returning the pooled client');
}
const inspect = state => state.service.checkSavedRunFreshness(principal, runId);

{
  const state = fixture({ authorized: false });
  await assert.rejects(inspect(state), error => error.code === 'payroll_scheme_owner_only' && error.status === 403);
  assert.equal(state.calls.length, 5);
  assert.equal(texts(state).at(-2), 'ROLLBACK');
  released(state);
}
{
  const state = fixture();
  await assert.rejects(inspect(state), error => error.code === 'payroll_saved_run_not_found' && error.status === 404);
  assert.equal(state.calls.length, 6, 'missing run must not enter source collection');
  assert.equal(texts(state).at(-2), 'ROLLBACK');
  released(state);
}
{
  const readError = new Error('injected saved header query failure'), state = fixture({ readError });
  await assert.rejects(inspect(state), error => error === readError);
  assert.equal(texts(state).at(-2), 'ROLLBACK');
  released(state);
}
{
  const result = { status: 'current', officialReady: false, payoutEligible: false, persistence: 'none' };
  const state = fixture({ callback: () => result });
  assert.equal(await inspect(state), result, 'service returns callback metadata unchanged');
  assert.equal(state.callbackCalls, 1);
  assert.equal(texts(state).at(-2), 'COMMIT');
  assert.ok(!texts(state).includes('ROLLBACK'));
  released(state);
}
for (const failure of ['callback', 'begin', 'commit']) {
  const error = new Error(`injected ${failure} failure`);
  const state = fixture({ callback: () => { if (failure === 'callback') throw error; return {}; },
    beginError: failure === 'begin' ? error : undefined, commitError: failure === 'commit' ? error : undefined });
  await assert.rejects(inspect(state), actual => actual === error);
  assert.equal(state.callbackCalls, failure === 'begin' ? 0 : 1);
  if (failure === 'begin') {
    assert.deepEqual(texts(state), [lock, begin, unlock, 'ROLLBACK']);
    released(state, undefined, true);
  } else {
    assert.equal(texts(state).at(-2), 'ROLLBACK');
    released(state);
  }
}
{
  const readError = new Error('read failed'), rollbackError = new Error('rollback failed');
  const state = fixture({ readError, rollbackError });
  await assert.rejects(inspect(state), error => error === readError);
  released(state, rollbackError);
}
for (const transportFailure of [false, true]) {
  const unlockError = transportFailure ? new Error('unlock transport failed') : undefined;
  const state = fixture({ callback: () => ({}), unlocked: false, unlockError });
  let caught;
  await assert.rejects(inspect(state), error => {
    caught = error;
    return transportFailure ? error === unlockError : error.message === 'payroll_source_snapshot_lock_release_failed';
  });
  assert.equal(texts(state).at(-2), 'COMMIT');
  released(state, caught);
}
for (const transportFailure of [false, true]) {
  const beginError = new Error('BEGIN failed before source collection');
  const unlockError = transportFailure ? new Error('BEGIN cleanup unlock failed') : undefined;
  const state = fixture({ beginError, unlockError, unlocked: false, callback: () => assert.fail('callback after failed BEGIN') });
  let caught;
  await assert.rejects(inspect(state), error => {
    caught = error;
    return error.discardPayrollConnection === true && (transportFailure ? error === unlockError
      : error.message === 'payroll_source_snapshot_lock_release_failed');
  });
  assert.equal(state.callbackCalls, 0);
  assert.deepEqual(texts(state), [lock, begin, unlock, 'ROLLBACK']);
  released(state, caught, true);
}
{
  const rollbackError = new Error('rollback failed'), unlockError = new Error('unlock failed');
  const state = fixture({ authorized: false, rollbackError, unlockError });
  await assert.rejects(inspect(state), error => error === unlockError);
  assert.equal(texts(state).at(-2), 'ROLLBACK');
  released(state, unlockError);
}

console.log('PASS payroll-run-freshness-service-contract: actual source fence/owner/read failure plus isolated callback transaction cleanup; no source or PostgreSQL proof');
