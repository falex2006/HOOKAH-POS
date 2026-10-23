'use strict';

// These entry points own BEGIN so the fence is the first transactional
// statement. Never replace them with a raw BEGIN followed by unrelated reads.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const keyForVenue = (venueId) => {
  if (typeof venueId !== 'string' || !UUID.test(venueId)) throw new TypeError('payroll_source_fence_venue_id_invalid');
  return `payroll-official-source-v1:${venueId.toLowerCase()}`;
};
const assertClient = (db) => {
  if (!db || typeof db.query !== 'function') throw new TypeError('payroll_source_fence_client_required');
};
const beginPayrollSourceProducerTransaction = async (db, venueId) => {
  assertClient(db);
  const key = keyForVenue(venueId);
  await db.query('BEGIN');
  await db.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))', [key]);
};
const beginPayrollSourceConsumerTransaction = async (db, venueId) => {
  assertClient(db);
  const key = keyForVenue(venueId);
  // READ COMMITTED is required: after waiting for producers, the next source
  // read receives a new snapshot that includes their committed changes.
  await db.query('BEGIN ISOLATION LEVEL READ COMMITTED');
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [key]);
};
// A repeatable-read consumer must acquire a session lock before BEGIN. Taking
// an xact lock as the first SELECT would establish the RR snapshot before a
// wait, so later source reads could still see stale facts. The caller must
// release this lock before returning the pooled client.
const acquirePayrollSourceSnapshotLock = async (db, venueId) => {
  assertClient(db);
  const key = keyForVenue(venueId);
  await db.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [key]);
  let released = false;
  return async () => {
    if (released) return;
    const result = await db.query('SELECT pg_advisory_unlock(hashtextextended($1,0)) AS unlocked', [key]);
    if (result.rows?.[0]?.unlocked !== true) throw new Error('payroll_source_snapshot_lock_release_failed');
    released = true;
  };
};
// Private write-capability registration. Only this entry point can grant it;
// callers must supply a newly borrowed idle client and retain the returned
// cleanup through COMMIT/ROLLBACK. A generic held advisory lock is insufficient.
const verifiedWriteSnapshots = new WeakMap();
const verifiedReadSnapshots = new WeakMap();
const pendingVerifiedSnapshots = new WeakSet();
const hasPayrollVerifiedWriteSnapshot = (db, venueId) =>
  verifiedWriteSnapshots.get(db) === keyForVenue(venueId);
const hasPayrollVerifiedSourceSnapshot = (db, venueId) =>
  hasPayrollVerifiedWriteSnapshot(db, venueId) || verifiedReadSnapshots.get(db) === keyForVenue(venueId);
// A read capability exposes source evidence only. It never authorizes snapshot
// persistence or money transitions, which still require the write capability.
const beginPayrollVerifiedReadSourceTransaction = async (db, venueId) => {
  assertClient(db);
  if (verifiedWriteSnapshots.has(db) || verifiedReadSnapshots.has(db) || pendingVerifiedSnapshots.has(db)) throw new Error('payroll_verified_source_transaction_already_active');
  const key = keyForVenue(venueId);
  pendingVerifiedSnapshots.add(db);
  let release;
  try {
    release = await acquirePayrollSourceSnapshotLock(db, venueId);
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    verifiedReadSnapshots.set(db, key);
  } catch (error) {
    try { if (release) await release(); }
    catch (cleanupError) { cleanupError.discardPayrollConnection = true; throw cleanupError; }
    throw error;
  } finally { pendingVerifiedSnapshots.delete(db); }
  let revoked = false;
  return async () => {
    if (!revoked) { verifiedReadSnapshots.delete(db); revoked = true; }
    await release();
  };
};
const beginPayrollVerifiedRunSourceTransaction = async (db, venueId) => {
  assertClient(db);
  if (verifiedWriteSnapshots.has(db) || verifiedReadSnapshots.has(db) || pendingVerifiedSnapshots.has(db)) throw new Error('payroll_verified_source_transaction_already_active');
  const key = keyForVenue(venueId);
  pendingVerifiedSnapshots.add(db);
  let release;
  try {
    release = await acquirePayrollSourceSnapshotLock(db, venueId);
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ WRITE');
    verifiedWriteSnapshots.set(db, key);
  } catch (error) {
    try { if (release) await release(); }
    catch (cleanupError) { cleanupError.discardPayrollConnection = true; throw cleanupError; }
    throw error;
  } finally { pendingVerifiedSnapshots.delete(db); }
  let revoked = false;
  return async () => {
    if (!revoked) { verifiedWriteSnapshots.delete(db); revoked = true; }
    await release();
  };
};
module.exports = { beginPayrollSourceProducerTransaction, beginPayrollSourceConsumerTransaction,
  acquirePayrollSourceSnapshotLock, beginPayrollVerifiedRunSourceTransaction, hasPayrollVerifiedWriteSnapshot,
  beginPayrollVerifiedReadSourceTransaction, hasPayrollVerifiedSourceSnapshot };
