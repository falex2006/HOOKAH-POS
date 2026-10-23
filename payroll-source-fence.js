'use strict';

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
  await db.query('BEGIN ISOLATION LEVEL READ COMMITTED');
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [key]);
};
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
module.exports = { beginPayrollSourceProducerTransaction, beginPayrollSourceConsumerTransaction, acquirePayrollSourceSnapshotLock };
