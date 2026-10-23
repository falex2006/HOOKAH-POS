// Real private capability and source validators with fake SQL transport only.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { makePayrollRefundEconomicFacts, payrollRefundEconomicFixtureOptions as options } from './payroll-refund-economic-source-contract.mjs';
const require = createRequire(import.meta.url);
const fence = require('../payroll-source-fence');
const { readPayrollRecognitionEvidenceInTransaction: readRecognition, buildPayrollRecognitionManifest } = require('../payroll-recognition-manifest');
const { readPayrollRefundFrozenCostSourceInTransaction: readCost } = require('../payroll-refund-frozen-cost-source');
const { readPayrollRefundAwareSourceArgsInTransaction: readArgs } = require('../payroll-refund-aware-source');
const { verifyPayrollCalculationEntryEvidence: verifyEntry } = require('../payroll-calculation-entry-evidence');
const venueId = options.venueId, foreignVenue = 'bbbbbbbb-bbbb-4bbb-8bbb-000000000001';
const readBegin = fence.beginPayrollVerifiedReadSourceTransaction, writeBegin = fence.beginPayrollVerifiedRunSourceTransaction;
const lock = 'SELECT pg_advisory_lock(hashtextextended($1,0))';
const unlock = 'SELECT pg_advisory_unlock(hashtextextended($1,0)) AS unlocked';
const ro = 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', rw = 'BEGIN ISOLATION LEVEL REPEATABLE READ READ WRITE';
let checks = 0;
const eq = (a, b, label) => { assert.deepEqual(a, b, label); checks++; };
const rejected = async (promise, matcher) => { await assert.rejects(promise, matcher); checks++; };
function client(settings = {}) {
  const calls = [];
  const db = { async query(sql, values = []) {
    calls.push({ sql, values });
    if (sql === lock) { if (settings.lockError) throw settings.lockError; if (settings.waitLock) await settings.waitLock; }
    if (sql === ro || sql === rw) { if (settings.beginError) throw settings.beginError; if (settings.waitBegin) await settings.waitBegin; }
    if (sql === unlock) { if (settings.unlockError) throw settings.unlockError; return { rows: [{ unlocked: settings.unlocked !== false }] }; }
    if (sql.startsWith('SELECT u.id FROM users u')) return { rows: [] };
    assert.ok([lock, ro, rw, 'ROLLBACK', 'COMMIT'].includes(sql), `unexpected source read or write ${sql}`);
    return { rows: [] };
  } };
  return { db, calls, settings };
}
const absent = db => {
  eq(fence.hasPayrollVerifiedSourceSnapshot(db, venueId), false);
  eq(fence.hasPayrollVerifiedWriteSnapshot(db, venueId), false);
};
{
  const f = client(); absent(f.db);
  const release = await readBegin(f.db, venueId.toUpperCase());
  eq(f.calls.map(c => c.sql), [lock, ro]);
  eq(f.calls[0].values, [`payroll-official-source-v1:${venueId}`]);
  eq(fence.hasPayrollVerifiedSourceSnapshot(f.db, venueId), true);
  eq(fence.hasPayrollVerifiedWriteSnapshot(f.db, venueId), false);
  eq(fence.hasPayrollVerifiedSourceSnapshot(f.db, foreignVenue), false);
  eq(fence.hasPayrollVerifiedSourceSnapshot({ query: f.db.query }, venueId), false, 'client identity cannot be copied');
  const before = f.calls.length;
  for (const begin of [readBegin, writeBegin]) for (const venue of [venueId, foreignVenue])
    await rejected(begin(f.db, venue), /already_active/);
  eq(f.calls.length, before, 'active capability rejects nested reads/writes before SQL');
  await rejected(verifyEntry(f.db, { venueId }, {}, { purpose: 'current_transition' }), /source_transaction_required/);
  await rejected(async () => readRecognition(f.db, { ...options, venueId: foreignVenue }), /verified_write_snapshot_required/);
  eq(f.calls.length, before, 'RO capability cannot authorize monetary evidence or foreign venue sources');
  const costs = await readCost(f.db, { venueId });
  eq(costs.status, 'incomplete', 'RO capability accepted by read-only cost source, missing policy still blocked');
  eq(costs.reasons, ['payroll_refund_frozen_cost_explicit_v2_policy_required']);
  await rejected(readArgs(f.db, { venueId, userId: foreignVenue }, {}, options, {}), /authenticated_owner_required/);
  eq(f.calls.length, before + 1, 'source reader still performs real owner check');
  await f.db.query('COMMIT'); await release(); absent(f.db);
  const count = f.calls.length; await release(); eq(f.calls.length, count, 'successful release idempotent');
  const releaseAgain = await readBegin(f.db, venueId); await f.db.query('ROLLBACK'); await releaseAgain(); absent(f.db);
}
{
  const f = client(), release = await writeBegin(f.db, venueId);
  eq(fence.hasPayrollVerifiedSourceSnapshot(f.db, venueId), true);
  eq(fence.hasPayrollVerifiedWriteSnapshot(f.db, venueId), true);
  await rejected(readBegin(f.db, venueId), /already_active/);
  await f.db.query('ROLLBACK'); await release(); absent(f.db);
}
// Pending acquisition and pending BEGIN are exclusive too: neither must ever
// allow a second initializer to convert an RO transaction into RW on one client.
for (const first of [readBegin, writeBegin]) for (const second of [readBegin, writeBegin]) for (const stage of ['Lock', 'Begin']) {
  let unblock;
  const wait = new Promise(resolve => { unblock = resolve; }), f = client({ [`wait${stage}`]: wait });
  const started = first(f.db, venueId);
  if (stage === 'Begin') await Promise.resolve();
  absent(f.db);
  try {
    await rejected(second(f.db, foreignVenue), /already_active/);
    eq(f.calls.filter(c => c.sql === lock).length, 1, 'second initializer never acquires another lock');
    eq(f.calls.filter(c => c.sql === ro || c.sql === rw).every(c => c.sql === (first === readBegin ? ro : rw)), true);
  }
  finally { unblock(); const release = await started; await f.db.query('ROLLBACK'); await release(); }
  absent(f.db);
}
for (const begin of [readBegin, writeBegin]) for (const failure of ['lockError', 'beginError']) {
  const error = new Error(failure), f = client({ [failure]: error });
  await rejected(begin(f.db, venueId), actual => actual === error); absent(f.db);
  eq(f.calls.map(c => c.sql), failure === 'lockError' ? [lock] : [lock, begin === readBegin ? ro : rw, unlock]);
  delete f.settings[failure];
  const release = await begin(f.db, venueId); await f.db.query('ROLLBACK'); await release(); absent(f.db);
}
for (const begin of [readBegin, writeBegin]) for (const transport of [false, true]) {
  const error = new Error('unlock transport'), f = client();
  const release = await begin(f.db, venueId); await f.db.query('ROLLBACK');
  if (transport) f.settings.unlockError = error; else f.settings.unlocked = false;
  await rejected(release(), transport ? actual => actual === error : /lock_release_failed/);
  absent(f.db); // revocation must precede best-effort unlock, even on failure
  delete f.settings.unlockError; f.settings.unlocked = true; await release(); absent(f.db);
}
for (const begin of [readBegin, writeBegin]) {
  const f = client({ beginError: new Error('begin failed'), unlockError: new Error('cleanup failed') });
  await rejected(begin(f.db, venueId), error => error === f.settings.unlockError && error.discardPayrollConnection === true);
  absent(f.db);
}
for (const begin of [readBegin, writeBegin]) {
  const f = client(), oldRelease = await begin(f.db, venueId);
  await f.db.query('ROLLBACK'); await oldRelease();
  const currentRelease = await begin(f.db, venueId);
  try {
    const count = f.calls.length;
    await oldRelease();
    eq(f.calls.length, count, 'obsolete cleanup never releases the current lock');
    eq(fence.hasPayrollVerifiedSourceSnapshot(f.db, venueId), true, 'obsolete cleanup never revokes new source capability');
    eq(fence.hasPayrollVerifiedWriteSnapshot(f.db, venueId), begin === writeBegin);
  } finally { await f.db.query('ROLLBACK'); await currentRelease(); }
  absent(f.db);
}
await rejected(readBegin({}, venueId), /client_required/);
await rejected(readBegin(client().db, 'invalid'), /venue_id_invalid/);
// Detailed recognition facts are available under the RO capability. Reuse the
// established transport fixture while keeping all actual source validators.
const text = readFileSync(new URL('./payroll-refund-earnings-source-contract.mjs', import.meta.url), 'utf8');
const start = text.indexOf('function fakeDb('), end = text.indexOf('\nfor (const reader of', start);
assert.ok(start >= 0 && end > start);
const fakeDb = runInNewContext(`${text.slice(start, end)};fakeDb`, { assert, venueId, structuredClone });
{
  const facts = makePayrollRefundEconomicFacts(), f = fakeDb(facts), query = f.db.query;
  f.db.query = async (sql, values) => {
    const result = await query(sql, values);
    return sql === 'SHOW transaction_read_only' ? { rows: [{ transaction_read_only: 'on' }] } : result;
  };
  await rejected(async () => readRecognition(f.db, options), /verified_write_snapshot_required/);
  eq(f.queries.length, 0);
  const release = await readBegin(f.db, venueId);
  try {
    const result = await readRecognition(f.db, options);
    eq(result.manifest, buildPayrollRecognitionManifest(facts, options));
    eq(result.facts.refundEvents[0].recognized_local_date, '2026-11-05', 'late history retained under RO source access');
    eq(fence.hasPayrollVerifiedWriteSnapshot(f.db, venueId), false);
    eq(f.queries.some(q => /^(INSERT|UPDATE|DELETE|ALTER|CREATE|TRUNCATE)\b/.test(q.text)), false);
  } finally { await f.db.query('ROLLBACK'); await release(); }
  absent(f.db);
  const count = f.queries.length;
  await rejected(async () => readRecognition(f.db, options), /verified_write_snapshot_required/); eq(f.queries.length, count);
}
console.log(`payroll-source-read-capability-contract: PASS ${checks} checks (actual private capabilities/source validators; fake SQL, no PG)`);
