import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { runInThisContext } from 'node:vm';

const require = createRequire(import.meta.url);
const fence = require('../payroll-source-fence.js');
const { calculatePayrollScheme } = require('../payroll-schemes.js');
const { buildCalculatorReplay } = require('../payroll-calculator-replay.js');
const ids = { venue: '10000000-0000-4000-8000-000000000001', owner: '10000000-0000-4000-8000-000000000002',
  run: '10000000-0000-4000-8000-000000000003', employee: '10000000-0000-4000-8000-000000000004',
  entry: '10000000-0000-4000-8000-000000000005', version: '10000000-0000-4000-8000-000000000006' };
const actor = { venueId: ids.venue, userId: ids.owner };
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().filter(key => value[key] !== undefined)
    .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const sha = value => createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex');
const clone = value => structuredClone(value);
const errorCode = code => error => error?.code === `payroll_entry_evidence_${code}`;
function isolated(path, seams) {
  const filename = require.resolve(path), localRequire = createRequire(filename), module = { exports: {} };
  runInThisContext(`(function(require,module,exports,__filename,__dirname){
${readFileSync(filename, 'utf8')}
})`, { filename })(
    name => Object.hasOwn(seams, name) ? seams[name] : localRequire(name), module, module.exports, filename, dirname(filename));
  return module.exports;
}

const input = {
  periodFrom: '2026-09-01', periodTo: '2026-09-01', monthClosed: false,
  coverage: { kind: 'month_to_date_complete', from: '2026-09-01', through: '2026-09-01', complete: true, watermark: 'sales' },
  attendanceCoverage: { kind: 'approved_attendance_complete', from: '2026-09-01', through: '2026-09-01', complete: true, watermark: 'attendance' },
  employees: [{ id: ids.employee }],
  roleAssignments: [{ employeeId: ids.employee, roleId: 'bartender', effectiveFrom: '2026-09-01', effectiveTo: '2026-09-30' }],
  attendance: [{ id: '10000000-0000-4000-8000-000000000007', employeeId: ids.employee, date: '2026-09-01', approved: true, workedMinutes: 480, plannedMinutes: 480 }],
  sales: [{ id: '10000000-0000-4000-8000-000000000008', date: '2026-09-01', employeeId: ids.employee, menuItemId: 'water', department: 'bar', turnoverCents: 10000, commissionBaseCents: 10000 }],
  sourceEvidence: { source: 'entry-evidence-contract' },
  scheme: { id: 'entry-evidence-scheme', versionId: ids.version, currency: 'RUB', mode: 'progressive_daily',
    roleParameters: { bartender: { perShiftCents: 1000, bracketRatesBps: { 0: 1000 } } }, employeeOverrides: [], itemRules: [], applyMilestones: false }
};
const result = calculatePayrollScheme(input);
assert.equal(result.status, 'ready');
assert.equal(result.daily[0].employees[0].basePayCents, 1000);
assert.equal(result.daily[0].employees[0].amountCents, 2000);
const replay = buildCalculatorReplay(input, result);
const evidence = {
  schemaVersion: 1, capabilityVersion: 'employee_attributed_merchandise_net_no_refund_v1',
  venueId: ids.venue, runId: ids.run, schemeVersionId: ids.version, period: { from: input.periodFrom, to: input.periodTo }, currency: 'RUB',
  venueTimezone: 'UTC', inputWatermark: 'a'.repeat(64), closureWatermark: 'b'.repeat(64),
  calculationWatermark: 'c'.repeat(64), snapshotInputWatermark: 'd'.repeat(64),
  schemeSnapshot: clone(input.scheme), sourceEvidence: clone(input.sourceEvidence), calculatorReplay: replay,
  totalAmountCents: 2000
};
const entry = { id: ids.entry, venue_id: ids.venue, user_id: ids.employee, status: 'draft', amount: '15.00', calculation_run_id: ids.run,
  calculation_provenance_sha256: sha(evidence), calculation_gross_cents: '2000', period_from: input.periodFrom,
  period_to: input.periodTo };

function fixture(options = {}) {
  const calls = [];
  const settings = { status: 'draft', freshness: 'current', dailyGross: '2000', dailyBase: '1000', ...options };
  const currentEntry = { ...entry, status: settings.status, calculation_gross_cents: settings.entryGross || entry.calculation_gross_cents,
    paid_at: settings.status === 'paid' ? new Date('2026-09-03T00:00:00Z') : null,
    paid_by: settings.status === 'paid' ? ids.owner : null, expense_id: settings.status === 'paid' ? ids.entry : null,
    linked_expense_id: settings.status === 'paid' ? ids.entry : null,
    expense_venue_id: settings.status === 'paid' ? (settings.expenseVenue || ids.venue) : null,
    expense_source: settings.status === 'paid' ? (settings.expenseSource || 'payroll') : null,
    amount: settings.entryAmount || entry.amount,
    expense_amount: settings.status === 'paid' ? (settings.expenseAmount || entry.amount) : null };
  let savedEvidence = evidence, zeroReceipt = null;
  const incomingId = '10000000-0000-4000-8000-000000000031';
  const incoming = [{ id: incomingId, sequence_no: '1', venue_id: ids.venue, employee_id: ids.employee, currency: 'RUB',
    claim_id: '10000000-0000-4000-8000-000000000032', kind: 'apply', amount_cents: '10000', target_entry_id: ids.entry,
    reverses_event_id: null, original_entry_id: '10000000-0000-4000-8000-000000000033', refund_line_event_id: '10000000-0000-4000-8000-000000000034' }];
  if (settings.zero) {
    const zeroInput = clone(input);
    zeroInput.scheme.roleParameters.bartender.perShiftCents = 0;
    zeroInput.sales[0].commissionBaseCents = zeroInput.sales[0].turnoverCents = settings.zeroGross ? 0 : 100000;
    const zeroResult = calculatePayrollScheme(zeroInput), gross = settings.zeroGross ? 0 : 10000;
    savedEvidence = { ...clone(evidence), calculatorReplay: buildCalculatorReplay(zeroInput, zeroResult), totalAmountCents: gross, schemeSnapshot: clone(zeroInput.scheme) };
    if (settings.v2Capture) savedEvidence.capabilityVersion = 'employee_attributed_remaining_net_refund_v2';
    settings.dailyGross = String(gross); settings.dailyBase = '0';
    Object.assign(currentEntry, { status: 'paid', amount: '0.00', calculation_gross_cents: String(gross), calculation_provenance_sha256: sha(savedEvidence),
      paid_at: '2026-09-03 00:00:00+00', paid_by: ids.owner, payment_date: '2026-09-03', expense_id: null, linked_expense_id: null });
    const correctionBody = { schemaVersion: 1, entryId: ids.entry, venueId: ids.venue, employeeId: ids.employee,
      netCents: 0, protectedFixedCents: 0, appliedCents: gross, ledgerHash: 'e'.repeat(64),
      activeApplicationIds: settings.zeroGross ? [] : [incomingId], sources: [] };
    if (settings.v2Capture) {
      const { payrollCorrectionLedgerEventFromRow } = require('../payroll-correction-ledger-source');
      Object.assign(correctionBody, { ledgerCaptureSchemaVersion: 1, ledgerEventIds: settings.zeroGross ? [] : [incomingId],
        ledgerHash: sha(settings.zeroGross ? [] : incoming.map(payrollCorrectionLedgerEventFromRow)) });
    }
    const proof = { schemaVersion: 1, proofKind: 'current_transition', entryStatus: 'approved', venueId: ids.venue, entryId: ids.entry,
      ...(settings.v2Capture ? { capabilityVersion: savedEvidence.capabilityVersion } : {}),
      employeeId: ids.employee, runId: ids.run, currency: 'RUB', origin: 'calculation_run', periodFrom: input.periodFrom, periodTo: input.periodTo,
      evidenceHashes: { provenanceSha256: currentEntry.calculation_provenance_sha256 }, grossCents: gross, netCents: 0, protectedFixedCents: 0,
      eligibleVariableCents: gross, freshness: { status: 'current', checkedAt: '2026-09-03T00:00:00Z' },
      corrections: { ...correctionBody, correctionEvidenceHash: sha(correctionBody) }, ...settings.zeroProofPatch };
    const payload = canonical(proof);
    zeroReceipt = { id: '10000000-0000-4000-8000-000000000030', venue_id: ids.venue, entry_id: ids.entry,
      employee_id: ids.employee, calculation_run_id: ids.run, provenance_sha256: currentEntry.calculation_provenance_sha256,
      action: 'pay', from_status: 'approved', to_status: 'paid', settlement_kind: 'zero', gross_cents: String(gross), net_cents: '0', protected_fixed_cents: '0',
      created_at: currentEntry.paid_at, created_by: ids.owner, payment_date: currentEntry.payment_date, request_journaled: true,
      expense_id: null, finance_account_id: null, finance_account_name_snapshot: null, payment_method: null, shift_id: null,
      source_proof_payload: payload, source_proof_sha256: sha(payload), ledger_hash: correctionBody.ledgerHash, ...settings.receiptPatch };
    if (settings.zeroGross) incoming.length = 0;
  }
  const db = { async query(sql, values = []) {
    const text = sql.replace(/\s+/g, ' ').trim(); calls.push(text);
    if (text.startsWith('SELECT pg_advisory_lock(') || text === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ WRITE'
        || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [] };
    if (text.startsWith('SELECT pg_advisory_unlock(')) return { rows: [{ unlocked: true }] };
    if (text.startsWith('SELECT t.*,t.gross_cents::text')) {
      assert.deepEqual(values, [ids.venue, ids.entry]); return { rows: settings.receiptMissing ? [] : [zeroReceipt] };
    }
    if (text.startsWith('SELECT e.id,e.sequence_no::text')) {
      assert.deepEqual(values, [ids.venue, settings.v2Capture ? ids.employee : ids.entry]); return { rows: settings.incoming || incoming };
    }
    if (text.startsWith('SELECT pe.id::text')) {
      assert.deepEqual(values, [ids.venue, ids.entry]); return { rows: [{ ...currentEntry }] };
    }
    if (text.startsWith('SELECT venue_id::text AS venue_id,run_id::text AS run_id')) {
      assert.deepEqual(values, [ids.venue, ids.run, ids.employee]);
      if (settings.noSnapshots) return { rows: [] };
      return { rows: [{ venue_id: ids.venue, run_id: ids.run, employee_id: ids.employee, local_date: '2026-09-01',
        base_pay_cents: settings.dailyBase, final_amount_cents: settings.dailyGross }] };
    }
    assert.fail(`Unexpected SQL: ${text}`);
  } };
  const savedReader = { async loadSavedRunEvidenceInTransaction(client, venueId, runId) {
    assert.equal(client, db); assert.equal(venueId, ids.venue); assert.equal(runId, ids.run);
    return { header: { runId, currency: 'RUB', period: { from: input.periodFrom, to: input.periodTo } }, evidence: clone(savedEvidence) };
  } };
  const verifier = isolated('../payroll-calculation-entry-evidence.js', { './payroll-saved-run-reader': savedReader });
  return { db, verifier, settings, calls, currentEntry, zeroReceipt, incoming };
}
const withFence = async (f, fn) => {
  const release = await fence.beginPayrollVerifiedRunSourceTransaction(f.db, ids.venue);
  try { return await fn(); } finally { await f.db.query('COMMIT'); await release(); }
};

for (const key of ['period_from', 'period_to']) {
  const f = fixture();
  await assert.rejects(withFence(f, () => f.verifier.verifyPayrollCalculationEntryEvidence(f.db, actor,
    { ...entry, [key]: new Date('2026-09-01T00:00:00+05:00') },
    { purpose: 'current_transition', checkFreshness: async () => { assert.fail('ambiguous date must fail before freshness'); } })),
  errorCode('period_invalid'));
}

{
  const f = fixture();
  const proof = await withFence(f, () => f.verifier.verifyPayrollCalculationEntryEvidence(f.db, actor, entry, {
    purpose: 'current_transition', checkFreshness: async (db, owner, runId) => {
      assert.equal(db, f.db); assert.equal(owner, actor); assert.equal(runId, ids.run);
      return { status: f.settings.freshness, runId, checkedAt: '2026-09-02T00:00:00Z' };
    }
  }));
  assert.equal(proof.proofKind, 'current_transition');
  assert.equal(proof.grossCents, 2000); assert.equal(proof.netCents, 1500);
  assert.equal(proof.protectedFixedCents, 1000); assert.equal(proof.eligibleVariableCents, 1000);
  assert.equal(proof.evidenceHashes.provenanceSha256, entry.calculation_provenance_sha256);
  assert.equal(proof.freshness.status, 'current');
  assert.ok(Object.isFrozen(proof) && Object.isFrozen(proof.evidenceHashes) && Object.isFrozen(proof.period));
  assert.ok(!f.calls.some(sql => /\b(INSERT|UPDATE|DELETE)\b/i.test(sql)));
}

{
  const f = fixture({ status: 'paid' });
  const paidEntry = { ...entry, status: 'paid' };
  const proof = await withFence(f, () => f.verifier.verifyPayrollCalculationEntryEvidence(f.db, actor, paidEntry, { purpose: 'historical_paid' }));
  assert.equal(proof.proofKind, 'historical_paid'); assert.equal(proof.freshness, null);
  assert.equal(proof.grossCents, 2000); assert.equal(proof.netCents, 1500);
  assert.equal(proof.expense.amountCents, 1500); assert.equal(proof.eligibleVariableCents, 1000);
  assert.equal(Object.hasOwn(proof, 'settlement'), false, 'positive v1 proof shape unchanged');
}

for (const [options, purpose, extra, code] of [
  [{ freshness: 'stale' }, 'current_transition', { checkFreshness: async (_db, _actor, runId) => ({ status: 'stale', runId }) }, 'source_not_current'],
  [{ freshness: 'current' }, 'current_transition', { checkFreshness: null }, 'freshness_callback_required'],
  [{ status: 'draft' }, 'historical_paid', {}, 'historical_paid_entry_required'],
  [{ status: 'paid', expenseAmount: '19.99' }, 'historical_paid', {}, 'paid_expense_amount_mismatch'],
  [{ status: 'paid', expenseVenue: '10000000-0000-4000-8000-000000000099' }, 'historical_paid', {}, 'historical_paid_entry_required'],
  [{ dailyGross: '1999' }, 'current_transition', { checkFreshness: async (_db, _actor, runId) => ({ status: 'current', runId }) }, 'daily_reconciliation_mismatch'],
  [{ dailyBase: '2500' }, 'current_transition', { checkFreshness: async (_db, _actor, runId) => ({ status: 'current', runId }) }, 'daily_reconciliation_mismatch'],
  [{ noSnapshots: true }, 'current_transition', { checkFreshness: async (_db, _actor, runId) => ({ status: 'current', runId }) }, 'daily_snapshots_missing'],
  [{ entryGross: '2001' }, 'current_transition', { checkFreshness: async (_db, _actor, runId) => ({ status: 'current', runId }) }, 'entry_row_mismatch']
]) {
  const f = fixture(options), current = { ...entry, ...(options.status ? { status: options.status } : {}) };
  await withFence(f, () => assert.rejects(f.verifier.verifyPayrollCalculationEntryEvidence(f.db, actor, current,
    { purpose, ...extra }), errorCode(code)));
}

{
  const f = fixture();
  await assert.rejects(f.verifier.verifyPayrollCalculationEntryEvidence(f.db, actor, entry,
    { purpose: 'current_transition', checkFreshness: async () => ({ status: 'current', runId: ids.run }) }), errorCode('source_transaction_required'));
}
for (const purpose of ['official', 'candidate_preview', 'historical', null]) {
  const f = fixture();
  await assert.rejects(f.verifier.verifyPayrollCalculationEntryEvidence(f.db, actor, entry,
    { purpose }), errorCode('purpose_invalid'));
}

// Real engine replay with zero cash because incoming corrections settled all gross.
for (const zeroGross of [false, true]) {
  const f = fixture({ zero: true, zeroGross });
  const proof = await withFence(f, () => f.verifier.verifyPayrollCalculationEntryEvidence(f.db, actor, f.currentEntry, { purpose: 'historical_paid' }));
  assert.equal(proof.expense, null); assert.equal(proof.settlement.kind, 'zero');
  assert.equal(proof.settlement.incomingCorrectionCents, zeroGross ? 0 : 10000);
  assert.ok(Object.isFrozen(proof.settlement));
  assert.equal(proof.settlement.transitionId, f.zeroReceipt.id);
}
for (const [options, code] of [
  [{ receiptMissing: true }, 'zero_settlement_required'],
  ...[{ entry_id: ids.run }, { venue_id: ids.run }, { employee_id: ids.run }, { calculation_run_id: ids.entry },
    { provenance_sha256: '0'.repeat(64) }, { gross_cents: '9999' }, { net_cents: '1' }, { protected_fixed_cents: '1' },
    { from_status: 'draft' }, { to_status: 'approved' }, { settlement_kind: 'positive_expense' },
    { created_by: ids.employee }, { created_at: '2026-09-03 00:00:01+00' }, { payment_date: '2026-09-04' },
    { request_journaled: false }, { expense_id: ids.entry }, { finance_account_id: ids.entry }, { finance_account_name_snapshot: 'bank' },
    { payment_method: 'cash' }, { shift_id: ids.entry }, { source_proof_sha256: '0'.repeat(64) }]
    .map(receiptPatch => [{ receiptPatch }, 'zero_settlement_invalid']),
  [{ zeroProofPatch: { employeeId: ids.run } }, 'zero_settlement_invalid'],
  [{ zeroProofPatch: { freshness: { status: 'stale' } } }, 'zero_settlement_invalid'],
  [{ zeroProofPatch: { eligibleVariableCents: 9999 } }, 'zero_settlement_invalid'],
  [{ incoming: [] }, 'zero_settlement_ledger_invalid']
]) {
  const f = fixture({ zero: true, ...options });
  await withFence(f, () => assert.rejects(f.verifier.verifyPayrollCalculationEntryEvidence(f.db, actor, f.currentEntry,
    { purpose: 'historical_paid' }), errorCode(code)));
}
for (const mutate of [
  p => { p.corrections.correctionEvidenceHash = '0'.repeat(64); },
  p => { p.corrections.activeApplicationIds = [ids.run]; const { correctionEvidenceHash, ...body } = p.corrections; p.corrections.correctionEvidenceHash = sha(body); }
]) {
  const f = fixture({ zero: true }), payload = JSON.parse(f.zeroReceipt.source_proof_payload); mutate(payload);
  f.zeroReceipt.source_proof_payload = canonical(payload); f.zeroReceipt.source_proof_sha256 = sha(f.zeroReceipt.source_proof_payload);
  await withFence(f, () => assert.rejects(f.verifier.verifyPayrollCalculationEntryEvidence(f.db, actor, f.currentEntry,
    { purpose: 'historical_paid' }), /payroll_entry_evidence_zero_settlement_(invalid|ledger_invalid)/));
}
for (const alter of [
  rows => { rows[0].amount_cents = '9999'; }, rows => { rows[0].employee_id = ids.owner; },
  rows => { rows[0].original_entry_id = ids.entry; }, rows => { rows[0].target_entry_id = ids.run; },
  rows => { rows.push({ ...rows[0] }); }, rows => { rows[0].kind = 'release'; rows[0].reverses_event_id = ids.run; },
  rows => { rows[0].kind = 'waive'; }
]) {
  const f = fixture({ zero: true }); alter(f.incoming);
  await withFence(f, () => assert.rejects(f.verifier.verifyPayrollCalculationEntryEvidence(f.db, actor, f.currentEntry,
    { purpose: 'historical_paid' }), errorCode('zero_settlement_ledger_invalid')));
}

// The same immutable zero settlement accepts a real period claim identity;
// no fabricated refund-line UUID is needed or accepted alongside that identity.
for (const malformed of [false, 'missing-assessment', 'fake-line', 'unknown-kind']) {
  const f = fixture({ zero: true });
  Object.assign(f.incoming[0], { source_kind: 'period_v2', refund_line_event_id: null,
    cohort_assessment_id: ids.run });
  if (malformed === 'missing-assessment') f.incoming[0].cohort_assessment_id = null;
  if (malformed === 'fake-line') f.incoming[0].refund_line_event_id = ids.run;
  if (malformed === 'unknown-kind') f.incoming[0].source_kind = 'period_v3';
  const verify = () => f.verifier.verifyPayrollCalculationEntryEvidence(f.db, actor, f.currentEntry, { purpose: 'historical_paid' });
  if (malformed) await withFence(f, () => assert.rejects(verify(), errorCode('zero_settlement_ledger_invalid')));
  else assert.equal((await withFence(f, verify)).settlement.incomingCorrectionCents, 10000);
}

for (const zeroGross of [false, true]) {
  const f = fixture({ zero: true, zeroGross, v2Capture: true });
  const verify = () => f.verifier.verifyPayrollCalculationEntryEvidence(f.db, actor, f.currentEntry, { purpose: 'historical_paid' });
  assert.equal((await withFence(f, verify)).settlement.incomingCorrectionCents, zeroGross ? 0 : 10000);
  const later = { id: ids.owner, sequence_no: '2', venue_id: ids.venue, employee_id: ids.employee, currency: 'RUB',
    claim_id: ids.version, kind: 'waive', amount_cents: '1', target_entry_id: null, reverses_event_id: null,
    original_entry_id: ids.entry, refund_line_event_id: ids.version, created_at: '2026-09-03 00:00:00+00' };
  f.incoming.push(later);
  await withFence(f, verify);
  later.kind = 'apply'; later.target_entry_id = ids.entry;
  await withFence(f, () => assert.rejects(verify(), errorCode('zero_settlement_ledger_invalid')));
  f.incoming.pop();
  if (!zeroGross) {
    f.incoming[0].id = ids.owner;
    await withFence(f, () => assert.rejects(verify(), errorCode('zero_settlement_ledger_invalid')));
  }
}

console.log('PASS payroll calculation entry evidence: current and historical proof kinds, real replay, immutable snapshots, freshness, fence, fixed/variable reconciliation, zero settlement receipt and mixed incoming correction authority');
