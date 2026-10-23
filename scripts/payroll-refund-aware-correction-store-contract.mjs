// Isolated service seam test; no PostgreSQL or real source-reader acceptance.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { runInThisContext } from 'node:vm';
import { makeRefundAwareCorrectionPolicyFixture } from './payroll-refund-aware-correction-policy-contract.mjs';
const require = createRequire(import.meta.url);
const fence = require('../payroll-source-fence');
const policy = require('../payroll-refund-aware-correction-policy');
const { reviewedCorrectionRequestHash } = require('../payroll-reviewed-correction-command');
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const digest = text => createHash('sha256').update(text).digest('hex');
const clone = value => structuredClone(value);
const id = n => `dddddddd-dddd-4ddd-8ddd-${String(n).padStart(12, '0')}`;
const fixtureInput = makeRefundAwareCorrectionPolicyFixture();
const toProof = entry => ({ ...entry, entryId: entry.id, entryStatus: entry.status,
  evidenceHashes: entry.evidenceHashes || { provenanceSha256: entry.provenanceSha256 }, expense: entry.expense || null });
const toRow = entry => ({ id: entry.id, venue_id: entry.venueId, user_id: entry.employeeId, status: entry.status,
  amount: (entry.netCents / 100).toFixed(2), calculation_run_id: entry.runId,
  calculation_provenance_sha256: entry.provenanceSha256, period_from: entry.periodFrom, period_to: entry.periodTo });
function isolated(seams) {
  const filename = require.resolve('../payroll-refund-aware-correction-store'), localRequire = createRequire(filename), module = { exports: {} };
  runInThisContext(`(function(require,module,exports,__filename,__dirname){\n${readFileSync(filename, 'utf8')}\n})`, { filename })(
    name => Object.hasOwn(seams, name) ? seams[name] : localRequire(name), module, module.exports, filename, dirname(filename));
  return module.exports;
}
function fixture(options = {}) {
  const input = clone(fixtureInput), actor = { venueId: input.original.venueId, userId: id(1) }, calls = [];
  const settings = { ...options };
  let state = { histories: [], claims: [], batches: [], ledger: [], receipts: [], targetNet: input.target.netCents }, snapshot;
  let proofCalls = 0, sourceCalls = 0;
  const db = { async query(sql, values = []) {
    const text = sql.replace(/\s+/g, ' ').trim(); calls.push({ text, values });
    if (text.startsWith('SELECT pg_advisory_lock(')) return { rows: [] };
    if (text.startsWith('SELECT pg_advisory_unlock(')) return { rows: [{ unlocked: true }] };
    if (text === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ WRITE') { snapshot = clone(state); return { rows: [] }; }
    if (text === 'ROLLBACK') { if (snapshot) state = snapshot; snapshot = null; return { rows: [] }; }
    if (text === 'COMMIT') { snapshot = null; return { rows: [] }; }
    if (text.startsWith('SELECT full_name FROM users')) {
      assert.deepEqual(values, [actor.venueId, actor.userId]); return { rows: settings.ownerMissing ? [] : [{ full_name: 'Fixture Owner' }] };
    }
    if (text.startsWith('SELECT request_hash,response_payload,response_hash')) {
      assert.equal(values[0], actor.venueId); assert.match(text, /FOR UPDATE$/);
      return { rows: settings.prior ? [settings.prior] : state.receipts.filter(row => row.idempotency_key === values[1]) };
    }
    if (text.startsWith('SELECT *,period_from::text')) {
      assert.match(text, /ORDER BY id FOR UPDATE$/); assert.equal(values[0], actor.venueId);
      assert.deepEqual(values[1], [...values[1]].sort());
      return { rows: settings.missingEntries ? [] : [toRow(input.original), toRow({ ...input.target, netCents: state.targetNet })].filter(row => values[1].includes(row.id)) };
    }
    if (text.startsWith('SELECT id,engine_version,input_checksum')) {
      assert.deepEqual(values, [actor.venueId, input.original.runId]); assert.match(text, /FOR UPDATE$/);
      return { rows: [{ id: input.original.runId, engine_version: settings.v1 ? 'payroll-verified-no-refund-v1' : 'payroll-verified-remaining-net-v2', input_checksum: input.original.provenanceSha256 }] };
    }
    if (text.startsWith('SELECT c.id FROM payroll_correction_claims')) {
      assert.deepEqual(values, [actor.venueId, input.original.runId]); assert.ok(!text.includes('employee_id='), 'basis exclusion covers every employee of the run');
      return { rows: settings.mixed ? [{ id: id(99) }] : [] };
    }
    if (text.startsWith('SELECT id,venue_id,run_id,provenance_sha256')) {
      assert.equal(values[0], actor.venueId); assert.equal(values[1], input.original.runId);
      if (text.includes('ORDER BY created_at,id LIMIT 1001')) return { rows: settings.histories || state.histories };
      assert.match(text, /assessment_hash=\$3 LIMIT 2$/);
      return { rows: state.histories.filter(row => row.assessment_hash === values[2]) };
    }
    if (text.startsWith('SELECT id,original_entry_id,original_run_id')) {
      assert.deepEqual(values, [actor.venueId, input.original.id, input.original.employeeId]);
      assert.match(text, /source_kind='period_v2' ORDER BY id LIMIT 2 FOR UPDATE$/);
      return { rows: settings.claims || state.claims };
    }
    if (text.startsWith('SELECT (COALESCE(max(target_sequence_no)')) return { rows: [{ next: String(state.batches.filter(row => row.target_entry_id === values[1]).length + 1) }] };
    if (text.startsWith('SELECT id::text,calculation_run_id::text')) {
      assert.deepEqual(values, [actor.venueId, input.original.employeeId, input.original.runId, input.original.periodTo]);
      return { rows: settings.targets || [{ id: input.target.id, run_id: input.target.runId, period_from: input.target.periodFrom,
        period_to: input.target.periodTo, gross_cents: String(input.target.grossCents), net_cents: String(state.targetNet),
        employee_name_snapshot: 'Employee', calculation_scheme_name_snapshot: 'Scheme' }] };
    }
    if (text.startsWith('SELECT e.id,b.reason')) return { rows: state.ledger.filter(event => values[2].includes(event.id))
      .map(event => ({ id: event.id, reason: 'Owner reviewed return', created_by_name: 'Fixture Owner', created_at: '2026-12-01T00:00:00Z' })) };
    let table;
    if (text.startsWith('INSERT INTO payroll_refund_aware_paid_assessments')) {
      table = 'payroll_refund_aware_paid_assessments';
      const [rowId, venue_id, run_id, provenance_sha256, assessment_hash, source_hash, payload] = values;
      assert.equal(digest(payload), assessment_hash); assert.ok(!Object.hasOwn(JSON.parse(payload), 'assessmentWatermark'));
      state.histories.push({ id: rowId, venue_id, run_id, provenance_sha256, assessment_hash, source_hash, payload });
    } else if (text.startsWith('INSERT INTO payroll_correction_claims')) {
      table = 'payroll_correction_claims';
      const [rowId, venue_id, employee_id, original_entry_id, original_run_id, original_expense_id, original_settlement_transition_id,
        original_provenance_sha256, assessment_hash, source_hash, assessed_cents, created_by, created_by_name, cohort_assessment_id] = values;
      assert.match(text, /NULL,NULL,NULL/); assert.match(text, /'period_v2'/);
      state.claims.push({ id: rowId, venue_id, employee_id, original_entry_id, original_run_id, original_expense_id, original_settlement_transition_id,
        original_provenance_sha256, assessment_hash, source_hash, assessed_cents: String(assessed_cents), created_by, created_by_name, cohort_assessment_id,
        refund_line_event_id: null, source_snapshot_line_id: null, assessment_id: null });
    } else if (text.startsWith('INSERT INTO payroll_correction_batches')) {
      table = 'payroll_correction_batches';
      const [rowId, venue_id, employee_id, operation, original_entry_id, target_entry_id, target_sequence_no, cohort_assessment_id,
        assessment_hash, source_hash, ledger_hash, plan_payload, plan_hash, total_cents] = values;
      assert.equal(digest(plan_payload), plan_hash); assert.ok(!text.includes('source_kind')); assert.match(text, /event_count/);
      state.batches.push({ id: rowId, venue_id, employee_id, operation, original_entry_id, target_entry_id, target_sequence_no,
        cohort_assessment_id, assessment_hash, source_hash, ledger_hash, plan_payload, plan_hash, total_cents });
    } else if (text.startsWith('INSERT INTO payroll_correction_events')) {
      table = 'payroll_correction_events';
      assert.ok(!text.includes('cohort_assessment_id') && !text.includes('source_kind'));
      const [rowId, venueId, employeeId, claimId, batchId, kind, amountCents, targetEntryId] = values;
      const batch = state.batches.find(row => row.id === batchId), claim = state.claims.find(row => row.id === claimId);
      state.ledger.push({ id: rowId, sequenceNo: state.ledger.length + 1, venueId, employeeId, currency: 'RUB', originalEntryId: claim.original_entry_id,
        refundLineEventId: null, sourceKind: 'period_v2', cohortClaimId: claimId, cohortAssessmentId: batch.cohort_assessment_id,
        kind, amountCents, targetEntryId, reversesEventId: null });
    } else if (text.startsWith('UPDATE payroll_entries SET amount=')) {
      table = 'payroll_entries'; assert.match(text, /status='draft'/); assert.match(text, /AND amount=\$4::numeric RETURNING id$/);
      assert.equal(values[3], (state.targetNet / 100).toFixed(2));
      if (settings.targetChanged) return { rows: [] };
      state.targetNet = Math.round(Number(values[2]) * 100);
    } else if (text.startsWith('INSERT INTO payroll_correction_requests')) {
      table = 'payroll_correction_requests';
      const [venue_id, idempotency_key, request_hash, batch_id, created_by, response_payload, response_hash] = values;
      assert.equal(digest(response_payload), response_hash);
      state.receipts.push({ venue_id, idempotency_key, request_hash, batch_id, created_by, response_payload, response_hash });
    } else throw new Error(`Unexpected mock query: ${text.slice(0, 80)}`);
    if (settings.failAfter === table) throw Object.assign(new Error('Injected after write'), { code: 'injected' });
    return { rows: table === 'payroll_entries' ? [{ id: input.target.id }] : [] };
  } };
  const api = isolated({
    './payroll-calculation-entry-evidence': { verifyPayrollCalculationEntryEvidence: async (client, who, row, options) => {
      proofCalls++; assert.equal(client, db); assert.equal(who.venueId, actor.venueId);
      if (settings.proofFailure) throw Object.assign(new Error('Invalid proof'), { code: 'proof_invalid' });
      if (row.id === input.original.id) { assert.equal(options.purpose, 'historical_paid'); return toProof(input.original); }
      assert.equal(options.purpose, 'current_transition'); assert.equal(typeof options.checkFreshness, 'function');
      return toProof({ ...input.target, netCents: state.targetNet });
    } },
    './payroll-refund-aware-paid-review-source': { collectPayrollRefundAwarePaidReviewInTransaction: async (client, who, runId) => {
      sourceCalls++; assert.equal(client, db); assert.equal(runId, input.original.runId);
      if (settings.sourceFailure) throw Object.assign(new Error('Incomplete source'), { code: 'source_invalid' });
      return { assessment: settings.assessment || input.assessment, sourceCollection: 'verified_private_paid_entry_rows' };
    } },
    './payroll-reviewed-correction-store': { readReviewedCorrectionLedger: async (client, who, employeeId) => {
      assert.equal(client, db); assert.equal(employeeId, input.original.employeeId); return settings.ledger || state.ledger;
    } }
  });
  const fenced = async (action, commit = false) => {
    const release = await fence.beginPayrollVerifiedRunSourceTransaction(db, actor.venueId);
    try { const result = await action(); await db.query(commit ? 'COMMIT' : 'ROLLBACK'); return result; }
    catch (error) { await db.query('ROLLBACK'); throw error; }
    finally { await release(); }
  };
  const previewInput = operation => ({ operation, originalEntryId: input.original.id, targetEntryId: operation === 'apply' ? input.target.id : null });
  const preview = (operation = 'apply') => fenced(() => api.previewRefundAwareCorrection(db, actor, previewInput(operation), async () => ({ status: 'current' })));
  const command = (plan, key = 'period-correction-contract') => ({ ...previewInput(plan.operation), expectedPlanHash: plan.planHash,
    reason: 'Owner reviewed return', idempotencyKey: key });
  const apply = (inputCommand, commit = false) => fenced(() => api.applyRefundAwareCorrection(db, actor, inputCommand, async () => ({ status: 'current' })), commit);
  return { api, db, actor, input, calls, settings, fenced, previewInput, preview, command, apply,
    state: () => clone(state), counts: () => ({ proofCalls, sourceCalls }) };
}
let checks = 0;
const ok = (condition, label) => { assert.ok(condition, label); checks++; };
const eq = (a, b, label) => { assert.deepEqual(a, b, label); checks++; };
const rejected = async (action, code) => { await assert.rejects(action, error => String(error.code).includes(code)); checks++; };
{
  const f = fixture();
  await rejected(() => f.api.previewRefundAwareCorrection(f.db, f.actor, f.previewInput('apply')), 'source_transaction_required');
  const before = f.state(), preview = await f.preview(); eq(f.state(), before); eq(preview.applyCents, 250);
  eq(preview, policy.buildRefundAwareCorrectionPlan(f.input), 'actual pure policy is used');
  ok(!f.calls.some(call => /^(INSERT|UPDATE|DELETE)/.test(call.text)), 'preview writes nothing');
  const context = await f.fenced(() => f.api.collectRefundAwareCorrectionContext(f.db, f.actor, f.previewInput('apply'), async () => ({ status: 'current' })));
  eq(context.original.evidenceHashes, f.input.original.evidenceHashes); eq(context.claim, null);
  const result = await f.apply(f.command(preview), true), state = f.state();
  eq(result.schemaVersion, 3); eq(result.totalCents, 250); eq(state.targetNet, 750);
  eq(state.histories.length, 1); eq(state.claims.length, 1); eq(state.batches.length, 1); eq(state.ledger.length, 1); eq(state.receipts.length, 1);
  eq(JSON.parse(state.batches[0].plan_payload).claimId, null, 'first plan intent keeps null claim ID after claim creation');
  eq(state.claims[0].assessed_cents, '250'); eq(state.ledger[0].sourceKind, 'period_v2'); eq(state.ledger[0].refundLineEventId, null);
  ok(state.receipts[0].request_hash !== reviewedCorrectionRequestHash(f.actor, f.command(preview)), 'schema3 request domain cannot collide with legacy');
  const sourceBefore = f.counts(); f.settings.sourceFailure = true;
  const replay = await f.apply(f.command(preview)); eq(replay, { ...result, replayed: true }); eq(f.counts(), sourceBefore);
  eq(f.state(), state, 'lost-response retry needs no current source or ledger recomputation');
  await rejected(() => f.apply({ ...f.command(preview), reason: 'Different reason' }), 'idempotency_conflict');
  f.settings.sourceFailure = false;
  const after = await f.preview('waive'); eq(after.waiveCents, 0); eq(after.firstAssessedCents, 250);
  await rejected(() => f.apply(f.command(after, 'nothing-left-contract')), 'nothing_to_dispose');
  const ui = await f.fenced(() => f.api.readRefundAwareCorrectionContext(f.db, f.actor, f.input.original.id));
  eq(ui.history.length, 1); eq(ui.targets.length, 1); eq(ui.remainingCents, 0); ok(!Object.hasOwn(ui, 'assessment'));
}
{
  const f = fixture(), plan = await f.preview('waive'), result = await f.apply(f.command(plan), true);
  eq(result.operation, 'waive'); eq(result.targetEntryId, null); eq(result.targetAfterCents, null);
  eq(f.state().targetNet, 1000); eq(f.state().ledger[0].kind, 'waive');
  ok(!f.calls.some(call => call.text.startsWith('UPDATE payroll_entries')), 'waiver never changes a target');
}
{
  const f = fixture(), first = await f.preview(); await f.apply(f.command(first), true);
  const initialClaim = clone(f.state().claims[0]);
  const full = makeRefundAwareCorrectionPolicyFixture('progressive_daily', 0, { fullReturn: true });
  eq(full.original.provenanceSha256, f.input.original.provenanceSha256);
  f.settings.assessment = full.assessment;
  const next = await f.preview(); eq(next.currentPotentialCents, 1000); eq(next.applyCents, 50); eq(next.residualReviewCents, 700);
  eq(next.firstAssessedCents, 250); eq(next.highWaterAssessedCents, 1000);
  await f.apply(f.command(next, 'later-return-apply'), true);
  eq(f.state().claims, [initialClaim], 'later cumulative assessment reuses the immutable first claim');
  eq(f.state().histories.length, 2); eq(f.state().targetNet, 700); eq(f.state().ledger.length, 2);
  ok(f.state().ledger[0].cohortAssessmentId !== f.state().ledger[1].cohortAssessmentId, 'each event binds its actual current assessment');
  const last = await f.preview('waive'); eq(last.waiveCents, 700);
  await f.apply(f.command(last, 'later-return-waive'), true);
  eq(f.state().histories.length, 2, 'same current assessment is reused exactly'); eq(f.state().claims, [initialClaim]);
  eq(f.state().ledger.length, 3); eq(f.state().targetNet, 700);
  f.settings.assessment = f.input.assessment;
  const before = f.state(); await rejected(() => f.preview(), 'current_potential_below_dispositions'); eq(f.state(), before);
}
for (const table of ['payroll_refund_aware_paid_assessments', 'payroll_correction_claims', 'payroll_correction_batches',
  'payroll_correction_events', 'payroll_entries', 'payroll_correction_requests']) {
  const f = fixture(), plan = await f.preview(), before = f.state(); f.settings.failAfter = table;
  await rejected(() => f.apply(f.command(plan)), 'injected'); eq(f.state(), before, `${table}: caller rollback restores all staged writes`);
}
for (const [option, code] of [['ownerMissing', 'owner_required'], ['missingEntries', 'entry_not_found'], ['v1', 'original_run_not_v2'],
  ['mixed', 'mixed_original_basis'], ['proofFailure', 'proof_invalid'], ['sourceFailure', 'source_invalid']]) {
  const f = fixture({ [option]: true }); await rejected(() => f.preview(), code);
  ok(!f.calls.some(call => /^(INSERT|UPDATE)/.test(call.text)));
}
{
  const f = fixture(), plan = await f.preview(), before = f.state();
  await rejected(() => f.apply({ ...f.command(plan), expectedPlanHash: '0'.repeat(64) }), 'plan_stale'); eq(f.state(), before);
  f.settings.targetChanged = true; await rejected(() => f.apply(f.command(plan)), 'target_changed'); eq(f.state(), before);
}
{
  const f = fixture(), plan = await f.preview(); await f.apply(f.command(plan), true);
  const history = f.state().histories[0];
  f.settings.histories = Array.from({ length: 1001 }, () => history); await rejected(() => f.preview(), 'assessment_history_too_large');
  f.settings.histories = [{ ...history, payload: '{}' }]; await rejected(() => f.preview(), 'assessment_history_invalid');
  f.settings.histories = [{ ...history, provenance_sha256: 'f'.repeat(64) }]; await rejected(() => f.preview(), 'assessment_history_invalid');
  delete f.settings.histories; f.settings.claims = [{ ...f.state().claims[0], assessed_cents: '251' }]; await rejected(() => f.preview(), 'claim_basis_mismatch');
  f.settings.claims = [{ ...f.state().claims[0], original_expense_id: id(99) }]; await rejected(() => f.preview(), 'claim_basis_mismatch');
  delete f.settings.claims;
  f.settings.prior = { ...f.state().receipts[0], response_hash: 'f'.repeat(64) }; await rejected(() => f.apply(f.command(plan)), 'request_integrity_invalid');
  f.settings.prior = { ...f.state().receipts[0], request_hash: reviewedCorrectionRequestHash(f.actor, f.command(plan)) };
  await rejected(() => f.apply(f.command(plan)), 'idempotency_conflict');
}
const source = readFileSync(require.resolve('../payroll-refund-aware-correction-store'), 'utf8');
ok(!/db\.query\(['"`](?:BEGIN|COMMIT|ROLLBACK)/.test(source), 'store never owns transaction boundaries');
ok(!/(?:INSERT INTO|UPDATE|DELETE FROM)\s+(?:expenses|finance_accounts|finance_transactions)\b/.test(source), 'no finance writes');
ok(!source.includes('UPDATE payroll_correction_claims'), 'first claim basis is immutable');
console.log(`PASS refund-aware correction store: ${checks} assertions (mock seam, no PostgreSQL)`);
