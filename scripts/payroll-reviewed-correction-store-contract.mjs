// Service-seam contract only; this mock DB behavior is not PostgreSQL/source acceptance.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { runInThisContext } from 'node:vm';

const require = createRequire(import.meta.url);
const fence = require('../payroll-source-fence.js');
const policy = require('../payroll-reviewed-correction-policy.js');
const commandApi = require('../payroll-reviewed-correction-command.js');
const ids = {
  venue: '10000000-0000-4000-8000-000000000001', owner: '10000000-0000-4000-8000-000000000002',
  employee: '10000000-0000-4000-8000-000000000003', original: '10000000-0000-4000-8000-000000000004',
  target: '10000000-0000-4000-8000-000000000005', originalRun: '10000000-0000-4000-8000-000000000006',
  targetRun: '10000000-0000-4000-8000-000000000007', refund: '10000000-0000-4000-8000-000000000008',
  snapshotLine: '10000000-0000-4000-8000-000000000009', expense: '10000000-0000-4000-8000-000000000010',
  claim: '10000000-0000-4000-8000-000000000011'
};
const actor = { venueId: ids.venue, userId: ids.owner };
const sha = value => createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`
    : JSON.stringify(value);
const digest = value => sha(typeof value === 'string' ? value : canonical(value));
const errorCode = code => error => error?.code === `payroll_correction_${code}`;
function isolated(path, seams) {
  const filename = require.resolve(path), localRequire = createRequire(filename), module = { exports: {} };
  runInThisContext(`(function(require,module,exports,__filename,__dirname){
${readFileSync(filename, 'utf8')}
})`, { filename })(
    name => Object.hasOwn(seams, name) ? seams[name] : localRequire(name), module, module.exports, filename, dirname(filename));
  return module.exports;
}
const originalRow = { id: ids.original, venue_id: ids.venue, user_id: ids.employee, status: 'paid', amount: '30.00',
  calculation_run_id: ids.originalRun, calculation_provenance_sha256: 'a'.repeat(64), calculation_gross_cents: '3000',
  period_from: '2026-09-01', period_to: '2026-09-30', expense_id: ids.expense };
const targetRow = { id: ids.target, venue_id: ids.venue, user_id: ids.employee, status: 'draft', amount: '20.00',
  calculation_run_id: ids.targetRun, calculation_provenance_sha256: 'b'.repeat(64), calculation_gross_cents: '2000',
  period_from: '2026-10-01', period_to: '2026-10-31' };
const originalProof = { venueId: ids.venue, entryId: ids.original, employeeId: ids.employee, runId: ids.originalRun,
  origin: 'calculation_run', currency: 'RUB', evidenceHashes: { provenanceSha256: originalRow.calculation_provenance_sha256 },
  periodFrom: originalRow.period_from, periodTo: originalRow.period_to, entryStatus: 'paid', grossCents: 3000, netCents: 3000,
  protectedFixedCents: 2000, eligibleVariableCents: 1000,
  expense: { id: ids.expense, entryId: ids.original, venueId: ids.venue, source: 'payroll', amountCents: 3000 } };
const targetProof = { venueId: ids.venue, entryId: ids.target, employeeId: ids.employee, runId: ids.targetRun,
  origin: 'calculation_run', currency: 'RUB', evidenceHashes: { provenanceSha256: targetRow.calculation_provenance_sha256 },
  periodFrom: targetRow.period_from, periodTo: targetRow.period_to, entryStatus: 'draft', grossCents: 2000, netCents: 2000,
  protectedFixedCents: 1000, eligibleVariableCents: 1000, expense: null };
const payload = { schemaVersion: 1, policyVersion: 'saved-run-refund-review-v1', basis: 'saved_calculation_unposted',
  venueId: ids.venue, runId: ids.originalRun, currency: 'RUB', provenanceSha256: originalRow.calculation_provenance_sha256,
  sourceHash: 'c'.repeat(64), coverage: 'complete', impactCents: -500, reasons: [], officialReady: false, payoutEligible: false,
  lines: [{ refundLineEventId: ids.refund, sourceSnapshotLineId: ids.snapshotLine, employeeId: ids.employee,
    salaryImpactCents: -500, reasons: [] }] };
const assessment = { ...payload, assessmentHash: digest(payload) };
const command = (planHash, key = 'refund-correction-0001') => ({ operation: 'apply', originalEntryId: ids.original,
  targetEntryId: ids.target, expectedPlanHash: planHash, reason: 'reviewed refund', idempotencyKey: key });

function fixture(options = {}) {
  const calls = [], staged = [], committed = [], settings = { role: 'owner', ledger: [], ...options };
  let verifierCalls = 0, assessmentCalls = 0, freshnessCalls = 0;
  const entries = [originalRow, targetRow];
  const db = { async query(sql, values = []) {
    const text = sql.replace(/\s+/g, ' ').trim(); calls.push({ text, values });
    if (text.startsWith('SELECT pg_advisory_lock(')) return { rows: [] };
    if (text.startsWith('SELECT pg_advisory_unlock(')) return { rows: [{ unlocked: true }] };
    if (text === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ WRITE' || text === 'COMMIT' || text === 'ROLLBACK') {
      if (text === 'COMMIT') committed.push(...staged.splice(0));
      if (text === 'ROLLBACK') staged.length = 0;
      return { rows: [] };
    }
    if (text.startsWith('SELECT full_name FROM users')) {
      if (settings.ownerMissing) return { rows: [] };
      return { rows: [{ full_name: 'Owner Test' }] };
    }
    if (text.startsWith('SELECT request_hash,response_payload,response_hash FROM payroll_correction_requests')) {
      assert.equal(values[0], ids.venue);
      if (settings.requestKey) assert.equal(values[1], settings.requestKey);
      return { rows: settings.previous ? [settings.previous] : [] };
    }
    if (text.startsWith('SELECT *,period_from::text AS period_from,period_to::text AS period_to FROM payroll_entries')) {
      assert.match(text, /ORDER BY id FOR UPDATE$/);
      assert.equal(values[0], ids.venue);
      assert.deepEqual(values[1], [...values[1]].sort());
      assert.ok(values[1].includes(ids.original));
      assert.ok(values[1].every(value => [ids.original, ids.target].includes(value)));
      return { rows: settings.entryRows || entries.filter(row => values[1].includes(row.id)).sort((a, b) => a.id.localeCompare(b.id)) };
    }
    if (text.startsWith('SELECT id::text,calculation_run_id::text AS run_id')) {
      assert.deepEqual(values, [ids.venue, ids.employee, ids.originalRun, originalRow.period_to]);
      assert.match(text, /venue_id=\$1 AND user_id=\$2 AND status='draft'/);
      assert.match(text, /calculation_run_id<>\$3 AND period_from>\$4::date/);
      assert.match(text, /ORDER BY period_from,period_to,id LIMIT 201$/);
      return { rows: settings.targetRows || [] };
    }
    if (text.startsWith('SELECT id,venue_id,user_id,status,calculation_run_id,calculation_provenance_sha256')) {
      assert.deepEqual(values, [ids.venue, ids.target]);
      if (settings.missingTarget) return { rows: [] };
      return { rows: [{ id: ids.target, venue_id: ids.venue, user_id: ids.employee,
        status: settings.cancelStatus || 'draft', calculation_run_id: ids.targetRun,
        calculation_provenance_sha256: targetRow.calculation_provenance_sha256,
        calculation_gross_cents: '2000', period_from: targetRow.period_from, period_to: targetRow.period_to, net_cents: settings.cancelNet || '1500' }] };
    }
    if (text.startsWith('SELECT COALESCE(sum(LEAST(base_pay,final_amount)'))
      return { rows: [{ fixed: '1000', gross: '2000' }] };
    if (text.startsWith('SELECT e.id,e.sequence_no::text')) {
      assert.deepEqual(values, [ids.venue, ids.employee]);
      if (settings.oversizedLedger) return { rows: Array.from({ length: 100001 }, (_, i) => ({ sequence_no: '1' })) };
      return { rows: settings.ledgerRows || settings.ledger || [] };
    }
    if (text.startsWith('SELECT e.id,b.reason,b.created_by_name,b.created_at::text AS created_at')) {
      assert.equal(values[0], ids.venue); assert.equal(values[1], ids.employee);
      assert.match(text, /JOIN payroll_correction_batches b ON b.venue_id=e.venue_id AND b.id=e.batch_id/);
      assert.match(text, /e.id=ANY\(\$3::uuid\[\]\)/);
      return { rows: settings.historyMetadata || values[2].map(id => ({ id, reason: `Reason ${id}`,
        created_by_name: 'Owner Test', created_at: '2026-10-23 12:34:56.123456+00' })) };
    }
    if (text.startsWith('SELECT id,original_entry_id,source_snapshot_line_id,assessed_cents::text,original_expense_id')) {
      assert.deepEqual(values, [ids.venue, ids.refund, ids.employee]);
      return { rows: settings.claim ? [settings.claim] : [] };
    }
    if (text.startsWith('SELECT (COALESCE(max(target_sequence_no),0)+1)::text AS next')) return { rows: [{ next: '1' }] };
    const mutation = text.startsWith('INSERT INTO payroll_correction_claims') ? 'claim'
      : text.startsWith('INSERT INTO payroll_correction_batches') ? 'batch'
        : text.startsWith('INSERT INTO payroll_correction_events') ? 'event'
          : text.startsWith("UPDATE payroll_entries SET status='cancelled'") ? 'cancel-update'
            : text.startsWith('UPDATE payroll_entries') ? 'update'
            : text.startsWith('INSERT INTO payroll_correction_requests') ? 'journal' : null;
    if (mutation) {
      const item = { mutation, text, values };
      staged.push(item);
      if (settings.failAfter === mutation) throw new Error(`simulated_${mutation}_failure`);
      if (mutation === 'update' || mutation === 'cancel-update') return { rows: settings.targetChanged ? [] : [{ id: ids.target }] };
      if (mutation === 'event' && text.includes('reverses_event_id')) return { rows: settings.missingReleaseParent ? [] : [{ id: ids.claim }] };
      return { rows: [] };
    }
    assert.fail(`Unexpected SQL: ${text}`);
  } };
  const store = isolated('../payroll-reviewed-correction-store.js', {
    './payroll-calculation-entry-evidence': { async verifyPayrollCalculationEntryEvidence(_db, _actor, row, options) {
      verifierCalls++;
      if (options.purpose === 'historical_paid') {
        assert.equal(row.id, ids.original);
        if (settings.verifierFailure) throw settings.verifierFailure;
        return settings.originalProof || originalProof;
      }
      assert.equal(row.id, ids.target);
      assert.equal(options.purpose, 'current_transition');
      assert.deepEqual(await options.checkFreshness(db, actor, ids.targetRun), { status: 'current', runId: ids.targetRun });
      return settings.targetProof || targetProof;
    } },
    './payroll-refund-review-assessment': { async collectPayrollRefundReviewAssessment(_db, _actor, runId) {
      assessmentCalls++; assert.equal(runId, ids.originalRun); return structuredClone(settings.payload || payload);
    } },
    './payroll-refund-review-store': { async saveRefundReviewAssessment(_db, _actor, savedPayload, opts) {
      const expectedHash = digest(settings.payload || payload);
      assert.equal(digest(savedPayload), expectedHash);
      assert.match(opts.idempotencyKey, /^correction-assessment:/);
      staged.push({ mutation: 'assessment', payload: savedPayload });
      if (settings.failAfter === 'assessment') throw new Error('simulated_assessment_failure');
      return { latestAssessment: { id: ids.claim, assessmentHash: expectedHash } };
    } }
  });
  const checkFreshness = async () => { freshnessCalls++; return { status: 'current', runId: ids.targetRun }; };
  return { db, store, calls, staged, committed, settings, checkFreshness,
    counts: () => ({ verifierCalls, assessmentCalls, freshnessCalls }) };
}
async function withFence(f, fn, { rollbackOnError = true } = {}) {
  const release = await fence.beginPayrollVerifiedRunSourceTransaction(f.db, ids.venue);
  try {
    const result = await fn();
    await f.db.query('COMMIT');
    return result;
  } catch (error) {
    if (rollbackOnError) await f.db.query('ROLLBACK');
    throw error;
  } finally { await release(); }
}
const previewPlan = async f => withFence(f, () => f.store.previewReviewedCorrection(f.db, actor,
  { operation: 'apply', originalEntryId: ids.original, targetEntryId: ids.target }, f.checkFreshness));

// Preview establishes a plan with real command/policy modules and locked rows.
const planFixture = fixture();
const preview = await previewPlan(planFixture);
assert.equal(preview.applyCents, 500); assert.equal(preview.targetAfterCents, 1500);
assert.equal(preview.protectedFixedCents, 1000); assert.equal(planFixture.counts().freshnessCalls, 1);
assert.ok(planFixture.calls.some(call => call.text.startsWith('SELECT *,period_from::text AS period_from,period_to::text AS period_to FROM payroll_entries')
  && JSON.stringify(call.values[1]) === JSON.stringify([ids.original, ids.target].sort())));

// Current owner authorization happens before even an exact idempotency replay.
{
  const f = fixture({ ownerMissing: true, previous: { request_hash: 'x', response_payload: '{}', response_hash: digest('{}') } });
  await assert.rejects(withFence(f, () => f.store.applyReviewedCorrection(f.db, actor, command(preview.planHash), f.checkFreshness)), errorCode('owner_required'));
  assert.equal(f.counts().assessmentCalls, 0); assert.equal(f.counts().verifierCalls, 0);
  assert.ok(!f.calls.some(call => call.text.startsWith('SELECT request_hash')));
}
// Invalid fence fails before reading owner or idempotency journal.
{
  const f = fixture();
  await assert.rejects(f.store.applyReviewedCorrection(f.db, actor, command(preview.planHash), f.checkFreshness), errorCode('source_transaction_required'));
  assert.equal(f.calls.length, 0);
}
// Exact journal retry returns before source collection, assessment, freshness, or entry locks.
{
  const response = { schemaVersion: 1, batchId: ids.claim, operation: 'apply', planHash: preview.planHash, totalCents: 500,
    targetEntryId: ids.target, targetAfterCents: 1500, residualReviewCents: 0,
    officialReady: false, payoutEligible: false, replayed: false };
  const responsePayload = canonical(response), requestHash = commandApi.reviewedCorrectionRequestHash(
    { ...actor, name: 'Owner Test' }, command(preview.planHash));
  const f = fixture({ previous: { request_hash: requestHash, response_payload: responsePayload, response_hash: digest(responsePayload) } });
  const replay = await withFence(f, () => f.store.applyReviewedCorrection(f.db, actor, command(preview.planHash), f.checkFreshness));
  assert.equal(replay.replayed, true); assert.equal(replay.planHash, preview.planHash);
  assert.equal(f.counts().assessmentCalls, 0); assert.equal(f.counts().verifierCalls, 0);
  assert.ok(!f.calls.some(call => call.text.startsWith('SELECT *,period_from::text AS period_from,period_to::text AS period_to FROM payroll_entries')));
}
// Reusing a key with different intent is rejected before collecting source evidence.
{
  const response = { schemaVersion: 1, batchId: ids.claim, operation: 'apply', planHash: preview.planHash, totalCents: 500,
    targetEntryId: ids.target, targetAfterCents: 1500, residualReviewCents: 0,
    officialReady: false, payoutEligible: false, replayed: false };
  const text = canonical(response), requestHash = commandApi.reviewedCorrectionRequestHash({ ...actor, name: 'Owner Test' }, command(preview.planHash));
  const f = fixture({ previous: { request_hash: requestHash, response_payload: text, response_hash: digest(text) } });
  await assert.rejects(withFence(f, () => f.store.applyReviewedCorrection(f.db, actor,
    { ...command(preview.planHash), reason: 'different intent' }, f.checkFreshness)), errorCode('idempotency_conflict'));
  assert.equal(f.counts().assessmentCalls, 0); assert.equal(f.counts().verifierCalls, 0);
}
// A stale expected apply plan is rejected before assessment save, claim creation, or batch writes.
{
  const f = fixture();
  await assert.rejects(withFence(f, () => f.store.applyReviewedCorrection(f.db, actor, command('e'.repeat(64)), f.checkFreshness)), errorCode('plan_stale'));
  assert.equal(f.counts().assessmentCalls, 1); assert.equal(f.staged.length, 0); assert.equal(f.committed.length, 0);
}
// A full-ledger guard refuses before assessment save or writes.
{
  const f = fixture({ oversizedLedger: true });
  await assert.rejects(withFence(f, () => f.store.applyReviewedCorrection(f.db, actor, command(preview.planHash), f.checkFreshness)), errorCode('ledger_too_large'));
  assert.equal(f.counts().assessmentCalls, 1); assert.equal(f.staged.length, 0); assert.equal(f.committed.length, 0);
}
// Matching claim basis is reused; mismatched claim basis is rejected before batch creation.
{
  const f = fixture({ claim: { id: ids.claim, original_entry_id: ids.original, source_snapshot_line_id: ids.snapshotLine, assessed_cents: '500', original_expense_id: ids.expense } });
  const result = await withFence(f, () => f.store.applyReviewedCorrection(f.db, actor, command(preview.planHash), f.checkFreshness));
  assert.equal(result.totalCents, 500); assert.ok(!f.committed.some(item => item.mutation === 'claim'));
  assert.equal(f.committed.filter(item => item.mutation === 'event').length, 1);
}
{
  const f = fixture({ claim: { id: ids.claim, original_entry_id: ids.original, source_snapshot_line_id: ids.snapshotLine, assessed_cents: '499' } });
  await assert.rejects(withFence(f, () => f.store.applyReviewedCorrection(f.db, actor, command(preview.planHash), f.checkFreshness)), errorCode('claim_basis_mismatch'));
  assert.ok(!f.committed.some(item => item.mutation === 'batch'));
}
// Verify exact atomic command journal, one correction event, and one net amount update.
{
  const f = fixture();
  const result = await withFence(f, () => f.store.applyReviewedCorrection(f.db, actor, command(preview.planHash), f.checkFreshness));
  assert.equal(result.targetAfterCents, 1500); assert.equal(result.totalCents, 500);
  const claim = f.committed.find(item => item.mutation === 'claim');
  const batch = f.committed.find(item => item.mutation === 'batch');
  const event = f.committed.find(item => item.mutation === 'event');
  const update = f.committed.find(item => item.mutation === 'update');
  const journal = f.committed.find(item => item.mutation === 'journal');
  assert.ok(claim && batch && event && update && journal);
  assert.deepEqual(update.values, [ids.venue, ids.target, '15.00', '20.00']);
  assert.equal(event.values[5], 'apply'); assert.equal(event.values[6], 500); assert.equal(event.values[7], ids.target);
  assert.equal(batch.values[3], 'apply'); assert.equal(batch.values[5], ids.target);
  assert.equal(batch.values[13], 1); assert.equal(batch.values[14], 500);
  assert.equal(journal.values[1], 'refund-correction-0001');
  const mutations = f.committed.filter(item => ['claim', 'assessment', 'batch', 'event', 'update', 'journal'].includes(item.mutation));
  assert.deepEqual(mutations.map(item => item.mutation), ['assessment', 'claim', 'batch', 'event', 'update', 'journal']);
  assert.equal(f.counts().freshnessCalls, 1);
}
// Any late failure leaves no committed assessment, claim, batch, event, entry update, or journal after caller rollback.
for (const stage of ['assessment', 'claim', 'batch', 'event', 'update', 'journal']) {
  const f = fixture({ failAfter: stage });
  await assert.rejects(withFence(f, () => f.store.applyReviewedCorrection(f.db, actor, command(preview.planHash), f.checkFreshness)),
    error => error?.message === `simulated_${stage}_failure`);
  assert.equal(f.committed.length, 0, `${stage}: transaction rollback removed every staged write`);
  assert.equal(f.staged.length, 0, `${stage}: staged writes were cleared`);
  assert.ok(f.calls.some(call => call.text === 'ROLLBACK'));
  assert.ok(!f.calls.some(call => call.text === 'COMMIT'));
}
// A target CAS miss rolls back prior assessment/claim/batch/event writes.
{
  const f = fixture({ targetChanged: true });
  await assert.rejects(withFence(f, () => f.store.applyReviewedCorrection(f.db, actor, command(preview.planHash), f.checkFreshness)), errorCode('target_changed'));
  assert.equal(f.committed.length, 0); assert.ok(f.calls.some(call => call.text === 'ROLLBACK'));
}

const appA = '10000000-0000-4000-8000-000000000012';
const appB = '10000000-0000-4000-8000-000000000013';
const otherOriginal = '10000000-0000-4000-8000-000000000014';
const otherRefund = '10000000-0000-4000-8000-000000000015';
const releaseRows = (amountA = '300', amountB = '200') => [
  { id: appA, sequence_no: '1', kind: 'apply', amount_cents: amountA, target_entry_id: ids.target,
    reverses_event_id: null, venue_id: ids.venue, employee_id: ids.employee, currency: 'RUB',
    original_entry_id: ids.original, refund_line_event_id: ids.refund },
  { id: appB, sequence_no: '2', kind: 'apply', amount_cents: amountB, target_entry_id: ids.target,
    reverses_event_id: null, venue_id: ids.venue, employee_id: ids.employee, currency: 'RUB',
    original_entry_id: otherOriginal, refund_line_event_id: otherRefund }
];
const cancellationInput = (planHash, key = 'cancel-refund-0001') => ({ targetEntryId: ids.target,
  expectedPlanHash: planHash, reason: 'cancel reviewed correction', idempotencyKey: key });
const cancelPreview = async f => withFence(f, () => f.store.previewReviewedCorrectionCancellation(f.db, actor,
  cancellationInput('0'.repeat(64))));

// Cancellation accepts draft and approved entries, releases every linked application,
// including allocations from multiple historical originals, without a freshness callback.
for (const status of ['draft', 'approved']) {
  const f = fixture({ cancelStatus: status, ledgerRows: releaseRows() });
  const plan = await cancelPreview(f);
  assert.equal(plan.releaseCents, 500); assert.equal(plan.releases.length, 2);
  assert.deepEqual(new Set(plan.releases.map(line => line.originalEntryId)), new Set([ids.original, otherOriginal]));
  assert.equal(f.counts().freshnessCalls, 0);
  const result = await withFence(f, () => f.store.cancelReviewedCorrectionTarget(f.db, actor,
    cancellationInput(plan.planHash), undefined));
  assert.equal(result.operation, 'release'); assert.equal(result.totalCents, 500);
  assert.equal(f.committed.filter(item => item.mutation === 'event').length, 2);
  const cancelUpdate = f.committed.find(item => item.mutation === 'cancel-update');
  assert.ok(cancelUpdate); assert.doesNotMatch(cancelUpdate.text, /SET[^;]*amount\s*=/i);
  assert.deepEqual(cancelUpdate.values, [ids.venue, ids.target, ids.owner, 'cancel reviewed correction', null]);
  assert.ok(f.committed.find(item => item.mutation === 'batch').text.includes("'RUB','release'"));
}
// Lifecycle evidence is inserted after releases but before the one status update.
{
  const f = fixture({ ledgerRows: releaseRows() }), plan = await cancelPreview(f);
  const timestamp = '2026-10-23 14:25:10.123456+00';
  let called = false;
  await withFence(f, () => f.store.cancelReviewedCorrectionTarget(f.db, actor, cancellationInput(plan.planHash), {
    beforeCancel: async () => {
      assert.equal(f.staged.filter(item => item.mutation === 'event').length, 2);
      assert.ok(!f.staged.some(item => item.mutation === 'cancel-update'));
      called = true; return { created_at: timestamp };
    }
  }));
  assert.ok(called);
  assert.equal(f.committed.find(item => item.mutation === 'cancel-update').values[4], timestamp);
}
{
  const f = fixture({ ledgerRows: releaseRows() }), plan = await cancelPreview(f);
  await assert.rejects(withFence(f, () => f.store.cancelReviewedCorrectionTarget(f.db, actor, cancellationInput(plan.planHash), {
    beforeCancel: async () => { throw new Error('transition evidence failed'); }
  })), /transition evidence failed/);
  assert.equal(f.committed.length, 0); assert.equal(f.staged.length, 0);
}
// Paid entries cannot enter the cancellation release path.
{
  const f = fixture({ cancelStatus: 'paid', ledgerRows: releaseRows() });
  await assert.rejects(cancelPreview(f), errorCode('cancellation_target_invalid'));
  assert.equal(f.staged.length, 0); assert.equal(f.committed.length, 0);
}
// Cancellation plan changes are detected before persisting assessment, batch, release, or status.
{
  const f = fixture({ cancelNet: '1500', ledgerRows: releaseRows() });
  const oldPlan = await cancelPreview(f);
  f.settings.ledgerRows = releaseRows('200', '200'); f.settings.cancelNet = '1600';
  await assert.rejects(withFence(f, () => f.store.cancelReviewedCorrectionTarget(f.db, actor,
    cancellationInput(oldPlan.planHash), undefined)), errorCode('plan_stale'));
  assert.equal(f.committed.length, 0); assert.equal(f.staged.length, 0);
}
// Exact cancellation retry resolves from its journal before reading entry or ledger state.
{
  const key = 'cancel-refund-retry';
  const input = cancellationInput('d'.repeat(64), key), { idempotencyKey, ...intent } = input;
  const requestHash = digest(canonical({ schemaVersion: 1, operation: 'release', venueId: ids.venue, actorId: ids.owner, ...intent }));
  const response = { schemaVersion: 1, batchId: ids.claim, operation: 'release', planHash: input.expectedPlanHash,
    targetEntryId: ids.target, totalCents: 500, cancelledHistoricalCents: 1500,
    officialReady: false, payoutEligible: false, replayed: false };
  const responsePayload = canonical(response);
  const f = fixture({ requestKey: key, previous: { request_hash: requestHash, response_payload: responsePayload,
    response_hash: digest(responsePayload) }, ledgerRows: releaseRows() });
  const replay = await withFence(f, () => f.store.cancelReviewedCorrectionTarget(f.db, actor, input, undefined));
  assert.equal(replay.replayed, true);
  assert.ok(!f.calls.some(call => call.text.startsWith('SELECT id,venue_id,user_id,status,calculation_run_id')));
  assert.ok(!f.calls.some(call => call.text.startsWith('SELECT e.id,e.sequence_no::text')));
}
// A release that cannot find its immutable apply parent aborts the entire transaction.
{
  const f = fixture({ ledgerRows: releaseRows(), missingReleaseParent: true });
  const plan = await cancelPreview(f);
  await assert.rejects(withFence(f, () => f.store.cancelReviewedCorrectionTarget(f.db, actor,
    cancellationInput(plan.planHash), undefined)), errorCode('release_basis_changed'));
  assert.equal(f.committed.length, 0); assert.equal(f.staged.length, 0);
  assert.ok(f.calls.some(call => call.text === 'ROLLBACK'));
  assert.ok(!f.calls.some(call => call.text.startsWith("UPDATE payroll_entries SET status='cancelled'")));
}
// A cancellation CAS miss rolls back the release batch and events as well.
{
  const f = fixture({ ledgerRows: releaseRows(), targetChanged: true });
  const plan = await cancelPreview(f);
  await assert.rejects(withFence(f, () => f.store.cancelReviewedCorrectionTarget(f.db, actor,
    cancellationInput(plan.planHash), undefined)), errorCode('target_changed'));
  assert.equal(f.committed.length, 0); assert.equal(f.staged.length, 0);
}

// Context/waiver previews read the original and entire ledger; a candidate list
// never chooses a target or authorizes changing its money.
const contextRead = f => withFence(f, () => f.store.readReviewedCorrectionContext(f.db, actor, ids.original));
const candidateTarget = { id: ids.target, run_id: ids.targetRun, period_from: targetRow.period_from,
  period_to: targetRow.period_to, gross_cents: '2000', net_cents: '1700', employee_name_snapshot: 'Frozen Employee',
  calculation_scheme_name_snapshot: 'Frozen Scheme' };
{
  const f = fixture({ ledgerRows: releaseRows(), targetRows: [candidateTarget] });
  const result = await contextRead(f);
  assert.equal(result.remainingCents, 200);
  assert.equal(result.requiresExplicitTarget, true); assert.equal(Object.hasOwn(result, 'targetEntryId'), false);
  assert.deepEqual(result.targets, [{ id: ids.target, runId: ids.targetRun, periodFrom: targetRow.period_from,
    periodTo: targetRow.period_to, grossCents: 2000, amountCents: 1700, employeeName: 'Frozen Employee',
    schemeName: 'Frozen Scheme', status: 'draft', requiresFreshPreview: true }]);
  assert.equal(result.history.length, 1); assert.equal(result.history[0].id, appA);
  assert.equal(result.history[0].reason, `Reason ${appA}`);
  assert.equal(result.history[0].createdByName, 'Owner Test');
  assert.equal(result.history[0].createdAt, '2026-10-23 12:34:56.123456+00');
  assert.equal(result.history[0].amountCents, 300);
  assert.equal(result.assessmentHash, assessment.assessmentHash);
  assert.equal(result.sourceHash, assessment.sourceHash); assert.match(result.ledgerHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(f.counts(), { verifierCalls: 1, assessmentCalls: 1, freshnessCalls: 0 });
  assert.equal(f.committed.length, 0);
  assert.deepEqual(f.calls.find(call => call.text.startsWith('SELECT *,period_from::text AS period_from,period_to::text AS period_to FROM payroll_entries')).values, [ids.venue, [ids.original]]);
  assert.deepEqual(f.calls.find(call => call.text.startsWith('SELECT e.id,b.reason')).values[2], [appA]);
}
{
  const f = fixture(), result = await contextRead(f);
  assert.deepEqual(result.targets, []); assert.deepEqual(result.history, []); assert.equal(result.remainingCents, 500);
  assert.equal(f.committed.length, 0);
  assert.ok(!f.calls.some(call => call.text.startsWith('SELECT e.id,b.reason')));
  const waiver = await withFence(f, () => f.store.previewReviewedCorrection(f.db, actor,
    { operation: 'waive', originalEntryId: ids.original, targetEntryId: null }));
  assert.equal(waiver.waiveCents, 500); assert.equal(waiver.targetEntryId, null);
  assert.equal(f.counts().freshnessCalls, 0); assert.equal(f.committed.length, 0);
}
for (const operation of ['context', 'preview']) {
  const invoke = f => operation === 'context' ? f.store.readReviewedCorrectionContext(f.db, actor, ids.original)
    : f.store.previewReviewedCorrection(f.db, actor, { operation: 'waive', originalEntryId: ids.original, targetEntryId: null });
  const unfenced = fixture(); await assert.rejects(invoke(unfenced), errorCode('source_transaction_required'));
  assert.equal(unfenced.calls.length, 0);
  const unauthorized = fixture({ ownerMissing: true });
  await assert.rejects(withFence(unauthorized, () => invoke(unauthorized)), errorCode('owner_required'));
  assert.equal(unauthorized.counts().verifierCalls, 0); assert.equal(unauthorized.counts().assessmentCalls, 0);
}
for (const [options, code] of [
  [{ targetRows: Array(201).fill(candidateTarget) }, 'target_list_too_large'],
  [{ targetRows: [{ ...candidateTarget, net_cents: '2001' }] }, 'target_basis_invalid'],
  [{ targetRows: [{ ...candidateTarget, net_cents: '-1' }] }, 'stored_integer_invalid'],
  [{ targetRows: [{ ...candidateTarget, net_cents: '1.2' }] }, 'stored_integer_invalid'],
  [{ targetRows: [{ ...candidateTarget, gross_cents: '9007199254740992' }] }, 'stored_integer_invalid'],
  [{ oversizedLedger: true }, 'ledger_too_large'], [{ entryRows: [] }, 'entry_not_found'],
  [{ payload: { ...payload, coverage: 'incomplete' } }, 'assessment_required'],
  [{ ledgerRows: releaseRows(), historyMetadata: [] }, 'history_incomplete'],
  [{ ledgerRows: releaseRows(), historyMetadata: [{ id: appB, reason: 'wrong event', created_by_name: 'Owner', created_at: 'time' }] }, 'history_incomplete'],
  [{ ledgerRows: releaseRows(), historyMetadata: [{ id: appA, reason: null, created_by_name: 'Owner', created_at: 'time' }] }, 'history_incomplete']
]) {
  const f = fixture(options); await assert.rejects(contextRead(f), errorCode(code));
  assert.equal(f.committed.length, 0); assert.equal(f.staged.length, 0);
}
{
  const f = fixture(); await assert.rejects(f.store.readReviewedCorrectionContext(f.db, actor, 'invalid'), errorCode('identity_invalid'));
  assert.equal(f.calls.length, 0);
  await assert.rejects(f.store.previewReviewedCorrection(f.db, actor,
    { operation: 'waive', originalEntryId: ids.original, targetEntryId: null, amount: 1 }), errorCode('preview_invalid'));
  assert.equal(f.calls.length, 0);
}
// Zero authority is supplied only by the historical verifier seam. The real
// verifier/receipt tests live separately; these assertions cover store wiring.
const settlementId = '10000000-0000-4000-8000-000000000020';
const zeroProof = { ...structuredClone(originalProof), netCents: 0, protectedFixedCents: 0, eligibleVariableCents: 3000, expense: null,
  settlement: { kind: 'zero', transitionId: settlementId, venueId: ids.venue, entryId: ids.original, employeeId: ids.employee,
    runId: ids.originalRun, provenanceSha256: originalRow.calculation_provenance_sha256, grossCents: 3000, netCents: 0,
    protectedFixedCents: 0, incomingCorrectionCents: 3000, paymentDate: '2026-10-01', paidAt: '2026-10-01T12:00:00Z', paidBy: ids.owner } };
const incomingZero = { ...releaseRows()[1], target_entry_id: ids.original, amount_cents: '3000' };
const zeroOptions = { originalProof: zeroProof, ledgerRows: [incomingZero] };
{
  const f = fixture(zeroOptions), plan = await previewPlan(f);
  assert.equal(plan.policyVersion, 'owner-reviewed-variable-correction-v2');
  assert.equal(plan.originalExpenseId, null); assert.equal(plan.originalSettlementTransitionId, settlementId);
  const result = await withFence(f, () => f.store.applyReviewedCorrection(f.db, actor, command(plan.planHash), f.checkFreshness));
  assert.equal(result.totalCents, 500);
  const claim = f.committed.find(item => item.mutation === 'claim');
  assert.match(claim.text, /created_by_name,original_settlement_transition_id\)/);
  assert.equal(claim.values.length, 16); assert.equal(claim.values[5], null); assert.equal(claim.values[15], settlementId);
  const planBody = JSON.parse(f.committed.find(item => item.mutation === 'batch').values[11]);
  assert.equal(planBody.originalSettlementTransitionId, settlementId);
  assert.equal(planBody.originalPaidCents, 0);
  assert.equal(f.committed.filter(item => item.mutation === 'event').length, 1);
  assert.equal(f.committed.find(item => item.mutation === 'event').values[6], 500, 'incoming settlement3000 is never re-applied');
}
{
  const f = fixture(zeroOptions), result = await contextRead(f);
  assert.equal(result.original.settlement.transitionId, settlementId);
  assert.equal(result.original.expense, null); assert.equal(result.remainingCents, 500);
  assert.deepEqual(result.history, [], 'incoming correction is not an outgoing disposition of this source');
}
const zeroClaim = { id: ids.claim, original_entry_id: ids.original, source_snapshot_line_id: ids.snapshotLine,
  assessed_cents: '500', original_expense_id: null, original_settlement_transition_id: settlementId };
{
  const f = fixture({ ...zeroOptions, claim: zeroClaim }), plan = await previewPlan(f);
  await withFence(f, () => f.store.applyReviewedCorrection(f.db, actor, command(plan.planHash), f.checkFreshness));
  assert.ok(!f.committed.some(item => item.mutation === 'claim'));
  assert.equal(f.committed.filter(item => item.mutation === 'event').length, 1);
}
for (const patch of [{ original_settlement_transition_id: ids.expense }, { original_settlement_transition_id: null },
  { original_expense_id: ids.expense }, { original_entry_id: otherOriginal }, { assessed_cents: '499' }]) {
  const f = fixture({ ...zeroOptions, claim: { ...zeroClaim, ...patch } }), plan = await previewPlan(f);
  await assert.rejects(withFence(f, () => f.store.applyReviewedCorrection(f.db, actor, command(plan.planHash), f.checkFreshness)), errorCode('claim_basis_mismatch'));
  assert.equal(f.committed.length, 0);
}
for (const original_expense_id of [null, otherOriginal]) {
  const f = fixture({ claim: { ...zeroClaim, original_expense_id } });
  await assert.rejects(withFence(f, () => f.store.applyReviewedCorrection(f.db, actor, command(preview.planHash), f.checkFreshness)), errorCode('claim_basis_mismatch'));
  assert.equal(f.committed.length, 0);
}
{
  const f = fixture(); await withFence(f, () => f.store.applyReviewedCorrection(f.db, actor, command(preview.planHash), f.checkFreshness));
  const claim = f.committed.find(item => item.mutation === 'claim');
  assert.doesNotMatch(claim.text, /original_settlement_transition_id/); assert.equal(claim.values.length, 15);
  assert.equal(claim.values[5], ids.expense, 'positive v1 insert remains206-independent');
}
for (const mutate of [proof => { proof.settlement.entryId = ids.target; }, proof => { proof.settlement.transitionId = null; },
  proof => { proof.settlement.incomingCorrectionCents = 2999; }, proof => { proof.expense = originalProof.expense; }]) {
  const proof = structuredClone(zeroProof); mutate(proof);
  const f = fixture({ ...zeroOptions, originalProof: proof });
  await assert.rejects(previewPlan(f), /payroll_correction_(original_paid_basis_required|identity_invalid)/);
  assert.equal(f.committed.length, 0);
}
{
  const denied = Object.assign(new Error('invalid settlement receipt'), { code: 'payroll_entry_evidence_zero_settlement_invalid' });
  const f = fixture({ ...zeroOptions, verifierFailure: denied });
  await assert.rejects(previewPlan(f), error => error === denied);
  assert.equal(f.counts().assessmentCalls, 0); assert.equal(f.committed.length, 0);
}
console.log('PASS reviewed correction store contract: owner/fence, previews/context/history, explicit targets, zero and positive authority insert/reuse, exact retries, full ledger and rollback simulations');
