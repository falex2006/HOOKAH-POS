// Service-seam contract only; this mock DB behavior is not PostgreSQL/source acceptance.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { runInThisContext } from 'node:vm';

const require = createRequire(import.meta.url);
const fence = require('../payroll-source-fence.js');
const waiverPolicy = require('../payroll-reviewed-correction-policy.js');
const ids = {
  venue: '10000000-0000-4000-8000-000000000001', actor: '10000000-0000-4000-8000-000000000002',
  employee: '10000000-0000-4000-8000-000000000003', target: '10000000-0000-4000-8000-000000000004',
  targetRun: '10000000-0000-4000-8000-000000000005', originalA: '10000000-0000-4000-8000-000000000006',
  originalB: '10000000-0000-4000-8000-000000000007', originalRunA: '10000000-0000-4000-8000-000000000008',
  originalRunB: '10000000-0000-4000-8000-000000000009', refundA: '10000000-0000-4000-8000-000000000010',
  refundB: '10000000-0000-4000-8000-000000000011', lineA: '10000000-0000-4000-8000-000000000012',
  lineB: '10000000-0000-4000-8000-000000000013', appA: '10000000-0000-4000-8000-000000000014',
  appB: '10000000-0000-4000-8000-000000000015', releaseA: '10000000-0000-4000-8000-000000000016'
};
const actor = { venueId: ids.venue, userId: ids.actor };
const digest = value => createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex');
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`
    : JSON.stringify(value);
function isolated(path, seams) {
  const filename = require.resolve(path), localRequire = createRequire(filename), module = { exports: {} };
  runInThisContext(`(function(require,module,exports,__filename,__dirname){\n${readFileSync(filename, 'utf8')}\n})`, { filename })(
    name => Object.hasOwn(seams, name) ? seams[name] : localRequire(name), module, module.exports, filename, dirname(filename));
  return module.exports;
}
const proof = (patch = {}) => ({ proofKind: 'current_transition', venueId: ids.venue, entryId: ids.target,
  freshness: { status: 'current' },
  employeeId: ids.employee, runId: ids.targetRun, origin: 'calculation_run', currency: 'RUB',
  evidenceHashes: { provenanceSha256: 'a'.repeat(64) }, periodFrom: '2026-10-01', periodTo: '2026-10-31',
  entryStatus: 'draft', grossCents: 2000, netCents: 2000, protectedFixedCents: 1000, eligibleVariableCents: 1000, ...patch });
const originalProof = (id, runId, patch = {}) => ({ proofKind: 'historical_paid', venueId: ids.venue, entryId: id,
  employeeId: ids.employee, runId, origin: 'calculation_run', currency: 'RUB',
  evidenceHashes: { provenanceSha256: id === ids.originalA ? 'b'.repeat(64) : 'c'.repeat(64) },
  periodFrom: '2026-09-01', periodTo: '2026-09-30', entryStatus: 'paid', grossCents: 10000, netCents: 10000,
  expense: { id: id === ids.originalA ? ids.appA : ids.appB, entryId: id, venueId: ids.venue, source: 'payroll', amountCents: 10000 }, ...patch });
const originalRow = (id, runId, patch = {}) => ({ id, venue_id: ids.venue, user_id: ids.employee,
  calculation_run_id: runId, ...patch });
const app = (patch = {}) => ({ id: ids.appA, sequenceNo: 1, venueId: ids.venue, employeeId: ids.employee,
  currency: 'RUB', originalEntryId: ids.originalA, refundLineEventId: ids.refundA, kind: 'apply', amountCents: 500,
  targetEntryId: ids.target, reversesEventId: null, ...patch });
const release = (patch = {}) => ({ id: ids.releaseA, sequenceNo: 2, venueId: ids.venue, employeeId: ids.employee,
  currency: 'RUB', originalEntryId: ids.originalA, refundLineEventId: ids.refundA, kind: 'release', amountCents: 500,
  targetEntryId: ids.target, reversesEventId: ids.appA, ...patch });
const sourcePayload = (originalId, runId, refundId, lineId, impact = -500, patch = {}) => ({
  schemaVersion: 1, policyVersion: 'saved-run-refund-review-v1', basis: 'saved_calculation_unposted', venueId: ids.venue,
  runId, currency: 'RUB', provenanceSha256: originalId === ids.originalA ? 'b'.repeat(64) : 'c'.repeat(64),
  sourceHash: originalId === ids.originalA ? 'd'.repeat(64) : 'e'.repeat(64), coverage: 'complete', impactCents: impact,
  reasons: [], officialReady: false, payoutEligible: false,
  lines: [{ refundLineEventId: refundId, sourceSnapshotLineId: lineId, employeeId: ids.employee,
    salaryImpactCents: impact, reasons: [] }], ...patch
});
const err = code => error => error?.code === `payroll_entry_corrections_${code}`;

function fixture(options = {}) {
  const calls = [], writes = [], committed = [], originals = new Map([
    [ids.originalA, originalRow(ids.originalA, ids.originalRunA)], [ids.originalB, originalRow(ids.originalB, ids.originalRunB)]
  ]);
  const settings = { ledger: [], ...options };
  let proofCalls = 0, paidProofCalls = 0, assessmentCalls = 0;
  const db = { async query(sql, values = []) {
    const text = sql.replace(/\s+/g, ' ').trim(); calls.push({ text, values });
    if (text.startsWith('SELECT pg_advisory_lock(')) return { rows: [] };
    if (text.startsWith('SELECT pg_advisory_unlock(')) return { rows: [{ unlocked: true }] };
    if (text === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ WRITE' || text === 'COMMIT' || text === 'ROLLBACK') {
      if (text === 'COMMIT') committed.push(...writes.splice(0));
      if (text === 'ROLLBACK') writes.length = 0;
      return { rows: [] };
    }
    if (text.startsWith('SELECT *,period_from::text AS period_from,period_to::text AS period_to FROM payroll_entries WHERE venue_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR SHARE')) {
      assert.equal(values[0], ids.venue);
      assert.deepEqual(values[1], [...values[1]].sort());
      if (settings.missingOriginals) return { rows: [] };
      return { rows: values[1].map(id => originals.get(id)).filter(Boolean).map(row => ({ ...row,
        ...(settings.originalRowOverrides?.[row.id] || {}) })) };
    }
    assert.fail(`Unexpected DB call: ${text}`);
  } };
  const module = isolated('../payroll-calculation-entry-corrections.js', {
    './payroll-reviewed-correction-store': { async readReviewedCorrectionLedger(client, owner, employeeId) {
      assert.equal(client, db); assert.deepEqual(owner, actor); assert.equal(employeeId, ids.employee); return structuredClone(settings.ledger);
    } },
    './payroll-calculation-entry-evidence': { async verifyPayrollCalculationEntryEvidence(client, owner, row, options) {
      assert.equal(client, db); assert.deepEqual(owner, actor); proofCalls++;
      if (options.purpose === 'current_transition') return settings.targetProof || proof();
      assert.equal(options.purpose, 'historical_paid'); paidProofCalls++;
      if (settings.proofError) throw settings.proofError;
      return settings.originalProofs?.[row.id] || originalProof(row.id, row.calculation_run_id);
    } },
    './payroll-refund-review-assessment': { async collectPayrollRefundReviewAssessment(client, owner, runId) {
      assert.equal(client, db); assert.deepEqual(owner, actor); assessmentCalls++;
      return structuredClone(settings.assessments?.[runId] || sourcePayload(ids.originalA, runId, ids.refundA, ids.lineA));
    } }
  });
  return { db, module, calls, writes, committed, settings,
    counts: () => ({ proofCalls, paidProofCalls, assessmentCalls }) };
}
async function withFence(f, fn) {
  const releaseLock = await fence.beginPayrollVerifiedRunSourceTransaction(f.db, ids.venue);
  try { return await fn(); }
  finally { await f.db.query('COMMIT'); await releaseLock(); }
}

// No active applications require no historical source proof or refund collection.
{
  const f = fixture();
  const result = await withFence(f, () => f.module.verifyPayrollEntryCorrections(f.db, actor, proof()));
  assert.equal(result.appliedCents, 0); assert.deepEqual(result.activeApplicationIds, []); assert.deepEqual(result.sources, []);
  assert.equal(f.counts().paidProofCalls, 0); assert.equal(f.counts().assessmentCalls, 0);
  assert.ok(!f.calls.some(call => call.text.startsWith('SELECT *,period_from::text AS period_from,period_to::text AS period_to FROM payroll_entries')));
  assert.equal(f.writes.length, 0); assert.equal(f.committed.length, 0);
}
// A missing current proof or fence is refused before ledger or source collection.
{
  const f = fixture();
  await assert.rejects(f.module.verifyPayrollEntryCorrections(f.db, actor, proof()), err('current_source_proof_required'));
  assert.equal(f.counts().proofCalls, 0); assert.equal(f.calls.length, 0);
}
{
  const f = fixture();
  await assert.rejects(withFence(f, () => f.module.verifyPayrollEntryCorrections(f.db, actor, proof({ proofKind: 'historical_paid' }))), err('current_source_proof_required'));
  assert.equal(f.counts().paidProofCalls, 0); assert.equal(f.counts().assessmentCalls, 0);
}
// Reconciliation ties active applications to gross minus net and preserves protected fixed pay.
{
  const f = fixture({ ledger: [app({ amountCents: 400 })] });
  await assert.rejects(withFence(f, () => f.module.verifyPayrollEntryCorrections(f.db, actor, proof({ netCents: 1500 }))), err('target_net_mismatch'));
  assert.equal(f.counts().paidProofCalls, 0); assert.equal(f.counts().assessmentCalls, 0);
}
{
  const f = fixture({ ledger: [app({ amountCents: 1100 })], targetProof: proof({ netCents: 900 }) });
  await assert.rejects(withFence(f, () => f.module.verifyPayrollEntryCorrections(f.db, actor, f.settings.targetProof)), err('target_capacity_invalid'));
  assert.equal(f.counts().paidProofCalls, 0); assert.equal(f.counts().assessmentCalls, 0);
}
// A release must reverse the full exact active parent; partial or unknown releases fail closed.
for (const ledger of [[app(), release({ amountCents: 400 })], [release()]]) {
  const f = fixture({ ledger });
  await assert.rejects(withFence(f, () => f.module.verifyPayrollEntryCorrections(f.db, actor, proof())), err('ledger_invalid'));
  assert.equal(f.counts().paidProofCalls, 0); assert.equal(f.counts().assessmentCalls, 0);
}
{
  const f = fixture({ ledger: [app(), release()] });
  const result = await withFence(f, () => f.module.verifyPayrollEntryCorrections(f.db, actor, proof()));
  assert.equal(result.appliedCents, 0); assert.deepEqual(result.activeApplicationIds, []);
  assert.equal(f.counts().paidProofCalls, 0); assert.equal(f.counts().assessmentCalls, 0);
}
// Each active original is checked against its paid evidence and a fresh independent assessment.
{
  const f = fixture({ ledger: [app({ amountCents: 400 }), app({ id: ids.appB, sequenceNo: 2,
    originalEntryId: ids.originalB, refundLineEventId: ids.refundB, amountCents: 600 })],
    targetProof: proof({ grossCents: 3000, netCents: 2000, protectedFixedCents: 1000, eligibleVariableCents: 2000 }),
    assessments: {
      [ids.originalRunA]: sourcePayload(ids.originalA, ids.originalRunA, ids.refundA, ids.lineA, -500),
      [ids.originalRunB]: sourcePayload(ids.originalB, ids.originalRunB, ids.refundB, ids.lineB, -700)
    } });
  const result = await withFence(f, () => f.module.verifyPayrollEntryCorrections(f.db, actor, f.settings.targetProof));
  assert.equal(result.appliedCents, 1000); assert.deepEqual(result.activeApplicationIds, [ids.appA, ids.appB].sort());
  assert.deepEqual(result.sources.map(source => source.originalEntryId), [ids.originalA, ids.originalB].sort());
  assert.equal(f.counts().paidProofCalls, 2); assert.equal(f.counts().assessmentCalls, 2);
  const sourceQuery = f.calls.find(call => call.text.startsWith('SELECT *,period_from::text AS period_from,period_to::text AS period_to FROM payroll_entries'));
  assert.deepEqual(sourceQuery.values, [ids.venue, [ids.originalA, ids.originalB].sort()]);
  assert.equal(f.writes.length, 0); assert.equal(f.committed.length, 0);
}
// Incomplete, null-impact, or provenance-stale source assessments block approve/pay proof creation.
for (const badPayload of [
  sourcePayload(ids.originalA, ids.originalRunA, ids.refundA, ids.lineA, -500, { coverage: 'needs_review', impactCents: null, reasons: ['refund_coverage_incomplete'] }),
  sourcePayload(ids.originalA, ids.originalRunA, ids.refundA, ids.lineA, null),
  sourcePayload(ids.originalA, ids.originalRunA, ids.refundA, ids.lineA, -500, { provenanceSha256: 'f'.repeat(64) })
]) {
  const f = fixture({ ledger: [app()], assessments: { [ids.originalRunA]: badPayload } });
  await assert.rejects(withFence(f, () => f.module.verifyPayrollEntryCorrections(f.db, actor, proof({ netCents: 1500 }))),
    error => /^(payroll_entry_corrections_(assessment_required|assessment_line_invalid)|payroll_correction_(assessment_required|assessment_line_invalid))$/.test(error?.code || ''));
  assert.equal(f.writes.length, 0); assert.equal(f.committed.length, 0);
}
// Original period and employee identity must match the active correction source and precede the target period.
{
  const f = fixture({ ledger: [app()], originalProofs: { [ids.originalA]: originalProof(ids.originalA, ids.originalRunA,
    { periodTo: '2026-10-01' }) } });
  await assert.rejects(withFence(f, () => f.module.verifyPayrollEntryCorrections(f.db, actor, proof({ netCents: 1500 }))), err('original_period_invalid'));
}
{
  const f = fixture({ ledger: [app()], originalRowOverrides: { [ids.originalA]: { user_id: ids.actor } } });
  await assert.rejects(withFence(f, () => f.module.verifyPayrollEntryCorrections(f.db, actor, proof({ netCents: 1500 }))), err('original_mismatch'));
  assert.equal(f.counts().assessmentCalls, 0);
}
{
  const f = fixture({ ledger: [app()], missingOriginals: true });
  await assert.rejects(withFence(f, () => f.module.verifyPayrollEntryCorrections(f.db, actor, proof({ netCents: 1500 }))), err('original_missing'));
  assert.equal(f.counts().paidProofCalls, 0); assert.equal(f.counts().assessmentCalls, 0);
}
// A prior waiver can consume no more than the current assessed source amount.
{
  const waiver = app({ id: ids.releaseA, sequenceNo: 2, kind: 'waive', amountCents: 600, targetEntryId: null });
  const f = fixture({ ledger: [app(), waiver] });
  await assert.rejects(withFence(f, () => f.module.verifyPayrollEntryCorrections(f.db, actor, proof({ netCents: 1500 }))), error => error?.code === 'payroll_correction_source_overallocated');
  assert.equal(f.writes.length, 0); assert.equal(f.committed.length, 0);
}
// Newly discovered residual refund impact is validation evidence only; it creates neither another application nor a waiver.
{
  const f = fixture({ ledger: [app({ amountCents: 300 })], assessments: {
    [ids.originalRunA]: sourcePayload(ids.originalA, ids.originalRunA, ids.refundA, ids.lineA, -700)
  } });
  const result = await withFence(f, () => f.module.verifyPayrollEntryCorrections(f.db, actor,
    proof({ netCents: 1700 })));
  assert.equal(result.appliedCents, 300); assert.equal(result.sources.length, 1);
  assert.equal(Object.hasOwn(result.sources[0], 'waiveCents'), false);
  assert.equal(Object.hasOwn(result, 'events'), false);
  assert.equal(f.writes.length, 0); assert.equal(f.committed.length, 0);
  assert.ok(!f.calls.some(call => /\b(INSERT|UPDATE|DELETE)\b/i.test(call.text)));
}
for (const patch of [{ freshness: { status: 'stale' } }, { freshness: null }, { entryStatus: 'paid' },
  { currency: 'USD' }, { grossCents: '2000' }, { netCents: -1 }, { eligibleVariableCents: 1200 }]) {
  const f = fixture();
  await assert.rejects(withFence(f, () => f.module.verifyPayrollEntryCorrections(f.db, actor, proof(patch))), err('current_source_proof_required'));
  assert.equal(f.counts().proofCalls, 0);
}
{
  const f = fixture();
  const result = await withFence(f, () => f.module.verifyPayrollEntryCorrections(f.db, actor, proof()));
  assert.equal(Object.isFrozen(result), true); assert.equal(Object.isFrozen(result.sources), true);
  assert.equal(Object.isFrozen(result.activeApplicationIds), true);
}
{
  const events = [app(), release()];
  const f = fixture({ ledger: events });
  const legacy = await withFence(f, () => f.module.verifyPayrollEntryCorrections(f.db, actor, proof()));
  assert.equal(Object.hasOwn(legacy, 'ledgerEventIds'), false, 'legacy proof hash shape is unchanged');
  const captured = await withFence(f, () => f.module.verifyPayrollEntryCorrections(f.db, actor,
    proof({ capabilityVersion: 'employee_attributed_remaining_net_refund_v2' })));
  assert.equal(captured.ledgerCaptureSchemaVersion, 1);
  assert.deepEqual(captured.ledgerEventIds, events.map(event => event.id).sort());
  assert.equal(captured.ledgerHash, legacy.ledgerHash);
  assert.ok(Object.isFrozen(captured.ledgerEventIds));
  const { correctionEvidenceHash, ...body } = captured;
  assert.equal(correctionEvidenceHash, digest(body), 'capture IDs are inside immutable correction evidence hash');
}
console.log('PASS payroll calculation entry corrections contract: current source proof, active ledger replay, paid-source and fresh-assessment revalidation, captured v2 ledger IDs and no automatic disposition');
