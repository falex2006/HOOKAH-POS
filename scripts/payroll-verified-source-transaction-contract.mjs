import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { acquirePayrollSourceSnapshotLock, beginPayrollVerifiedRunSourceTransaction,
  hasPayrollVerifiedWriteSnapshot } = require('../payroll-source-fence.js');
const { readPayrollRecognitionManifestInTransaction } = require('../payroll-recognition-manifest.js');
const { loadLatestProductDepartmentMappingInTransaction } = require('../payroll-product-department-source.js');
const venueId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const otherVenueId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const options = { venueId, from: '2026-10-01', to: '2026-10-20', currency: 'RUB' };
const lockSql = 'SELECT pg_advisory_lock(hashtextextended($1,0))';
const unlockSql = 'SELECT pg_advisory_unlock(hashtextextended($1,0)) AS unlocked';
const beginSql = 'BEGIN ISOLATION LEVEL REPEATABLE READ READ WRITE';

// The helper requires a fresh idle dedicated client. Existing read transactions
// below are substitutes used only to exercise readers' isolation guards.
// No database/source data or lock serialization is proven by this fake DB.
function clientFixture({ readOnly = 'off', isolation = 'repeatable read',
  beginError = null, unlockError = null, unlocked = true } = {}) {
  const calls = [], settings = { readOnly, isolation };
  const db = { async query(sql, params = []) {
    const text = sql.replace(/\s+/g, ' ').trim();
    calls.push({ text, params });
    if (text === lockSql || text === unlockSql) {
      assert.deepEqual(params, [`payroll-official-source-v1:${venueId}`]);
      if (text === unlockSql) {
        assert.equal(hasPayrollVerifiedWriteSnapshot(db, venueId), false,
          'write capability must be revoked before even attempting session unlock');
        if (unlockError) throw unlockError;
        return { rows: [{ unlocked }] };
      }
      return { rows: [] };
    }
    if (text === beginSql) {
      assert.equal(hasPayrollVerifiedWriteSnapshot(db, venueId), false, 'BEGIN must finish before registration');
      if (beginError) throw beginError;
      settings.readOnly = 'off'; settings.isolation = 'repeatable read';
      return { rows: [] };
    }
    if (text === 'SHOW transaction_isolation') return { rows: [{ transaction_isolation: settings.isolation }] };
    if (text === 'SHOW transaction_read_only') return { rows: [{ transaction_read_only: settings.readOnly }] };
    if (/^(?:SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT) payroll_manifest_[a-f0-9]+$/.test(text)) return { rows: [] };
    if (text.startsWith('WITH required AS (') && text.includes('AS missing_count')) return { rows: [{ missing_count: 1 }] };
    if (text.startsWith("SELECT to_regclass('payroll_product_department_revisions')")) {
      return { rows: [{ revisions: false, mappings: false }] };
    }
    assert.fail(`Unexpected source SQL in transaction-capability contract: ${text}`);
  } };
  return { db, settings, calls };
}

async function readersReject(db, requestedVenue = venueId) {
  await assert.rejects(() => readPayrollRecognitionManifestInTransaction(db, { ...options, venueId: requestedVenue }),
    error => error.code === 'payroll_recognition_manifest_repeatable_read_read_only_required');
  await assert.rejects(() => loadLatestProductDepartmentMappingInTransaction(db, requestedVenue),
    error => error.code === 'payroll_department_mapping_repeatable_read_required');
}
async function readersReachSchema(db) {
  const manifest = await readPayrollRecognitionManifestInTransaction(db, options);
  assert.equal(manifest.status, 'unsupported', 'manifest reader passed isolation guard and inspected schema');
  assert.equal(manifest.officialReady, false);
  const mapping = await loadLatestProductDepartmentMappingInTransaction(db, venueId);
  assert.equal(mapping.component.status, 'unsupported', 'mapping reader passed isolation guard and inspected schema');
  assert.deepEqual(mapping.component.reasons, ['payroll_product_department_mapping_schema_missing']);
  assert.equal(mapping.revision, null);
}

{
  const state = clientFixture();
  assert.equal(hasPayrollVerifiedWriteSnapshot(state.db, venueId), false);
  await readersReject(state.db);
  assert.equal(state.calls.filter(call => call.text.includes('to_regclass')).length, 0,
    'unfenced read-write readers reject before source/schema inspection');
}

{
  const state = clientFixture();
  const release = await acquirePayrollSourceSnapshotLock(state.db, venueId);
  assert.equal(hasPayrollVerifiedWriteSnapshot(state.db, venueId), false, 'generic advisory lock is not a write capability');
  await readersReject(state.db);
  await release();
}

{
  const state = clientFixture();
  const release = await beginPayrollVerifiedRunSourceTransaction(state.db, venueId.toUpperCase());
  assert.deepEqual(state.calls.map(call => call.text), [lockSql, beginSql]);
  assert.equal(hasPayrollVerifiedWriteSnapshot(state.db, venueId), true);
  assert.equal(hasPayrollVerifiedWriteSnapshot(state.db, venueId.toUpperCase()), true);
  await readersReachSchema(state.db);
  assert.equal(hasPayrollVerifiedWriteSnapshot(state.db, venueId), true,
    'reader-local savepoint release does not revoke its outer transaction capability');
  await readersReject(state.db, otherVenueId);
  assert.equal(hasPayrollVerifiedWriteSnapshot(state.db, otherVenueId), false);
  const otherClient = clientFixture();
  await readersReject(otherClient.db);
  const sameQueryDifferentIdentity = { query: (...args) => state.db.query(...args) };
  await readersReject(sameQueryDifferentIdentity);
  assert.equal(hasPayrollVerifiedWriteSnapshot(sameQueryDifferentIdentity, venueId), false,
    'a bound query function cannot transfer capability to another client object');
  const callsBeforeDuplicate = state.calls.length;
  await assert.rejects(() => beginPayrollVerifiedRunSourceTransaction(state.db, venueId),
    /payroll_verified_source_transaction_already_active/);
  assert.equal(state.calls.length, callsBeforeDuplicate, 'duplicate BEGIN does not acquire another session-lock count');
  state.settings.isolation = 'read committed';
  await readersReject(state.db);
  state.settings.isolation = 'repeatable read';
  state.settings.readOnly = 'unknown';
  await readersReject(state.db);
  state.settings.readOnly = 'off';
  await release();
  assert.equal(hasPayrollVerifiedWriteSnapshot(state.db, venueId), false);
  await readersReject(state.db);
  await release();
  assert.equal(state.calls.filter(call => call.text === unlockSql).length, 1, 'successful cleanup is idempotent');
}

for (const transportFailure of [false, true]) {
  const unlockError = transportFailure ? new Error('injected session unlock transport failure') : null;
  const state = clientFixture({ unlocked: false, unlockError });
  const release = await beginPayrollVerifiedRunSourceTransaction(state.db, venueId);
  await readersReachSchema(state.db);
  await assert.rejects(release, error => transportFailure
    ? error === unlockError : error.message === 'payroll_source_snapshot_lock_release_failed');
  assert.equal(hasPayrollVerifiedWriteSnapshot(state.db, venueId), false);
  await readersReject(state.db);
}

{
  const state = clientFixture({ readOnly: 'on' });
  await readersReachSchema(state.db);
  assert.equal(hasPayrollVerifiedWriteSnapshot(state.db, venueId), false,
    'legacy repeatable-read/read-only readers need no new write capability');
  assert.equal(state.calls.filter(call => [lockSql, beginSql, unlockSql].includes(call.text)).length, 0);
  state.settings.isolation = 'read committed';
  await readersReject(state.db);
}

{
  const beginError = new Error('injected BEGIN failure');
  const state = clientFixture({ beginError });
  await assert.rejects(() => beginPayrollVerifiedRunSourceTransaction(state.db, venueId), error => error === beginError);
  assert.deepEqual(state.calls.map(call => call.text), [lockSql, beginSql, unlockSql]);
  assert.equal(hasPayrollVerifiedWriteSnapshot(state.db, venueId), false);
  assert.equal(beginError.discardPayrollConnection, undefined, 'successful helper cleanup leaves outer rollback to caller');
  await readersReject(state.db);
}

for (const transportFailure of [false, true]) {
  const beginError = new Error('injected BEGIN failure');
  const unlockError = transportFailure ? new Error('injected BEGIN-cleanup unlock failure') : null;
  const state = clientFixture({ beginError, unlocked: false, unlockError });
  await assert.rejects(() => beginPayrollVerifiedRunSourceTransaction(state.db, venueId), error => {
    assert.equal(error.discardPayrollConnection, true, 'caller must discard a client whose setup cleanup could not unlock');
    return transportFailure ? error === unlockError : error.message === 'payroll_source_snapshot_lock_release_failed';
  });
  assert.deepEqual(state.calls.map(call => call.text), [lockSql, beginSql, unlockSql]);
  assert.equal(hasPayrollVerifiedWriteSnapshot(state.db, venueId), false);
  await readersReject(state.db);
}

console.log('PASS payroll-verified-source-transaction-contract: actual helper/readers, scoped RW capability and cleanup, RO compatibility (fake DB; no PostgreSQL proof)');
