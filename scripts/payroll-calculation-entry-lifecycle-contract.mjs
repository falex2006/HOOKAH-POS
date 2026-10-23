// Service-seam contract only; the mock database is not PostgreSQL acceptance.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { runInThisContext } from 'node:vm';

const require = createRequire(import.meta.url);
const fence = require('../payroll-source-fence.js');
const transitionCommand = require('../payroll-calculation-entry-transition-command.js');
const transitionCreatedAt = '2026-10-23T12:34:56.789Z';
const ids = { venue: '10000000-0000-4000-8000-000000000001', owner: '10000000-0000-4000-8000-000000000002',
  employee: '10000000-0000-4000-8000-000000000003', entry: '10000000-0000-4000-8000-000000000004',
  run: '10000000-0000-4000-8000-000000000005', account: '10000000-0000-4000-8000-000000000006',
  expense: '10000000-0000-4000-8000-000000000007', transition: '10000000-0000-4000-8000-000000000008',
  shift: '10000000-0000-4000-8000-000000000009', correctionBatch: '10000000-0000-4000-8000-000000000010' };
const actor = { venueId: ids.venue, userId: ids.owner };
const sha = value => createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`
    : JSON.stringify(value);
const errorCode = code => error => error?.code === `payroll_entry_lifecycle_${code}`;
function isolated(path, seams) {
  const filename = require.resolve(path), localRequire = createRequire(filename), module = { exports: {} };
  runInThisContext(`(function(require,module,exports,__filename,__dirname){\n${readFileSync(filename, 'utf8')}\n})`, { filename })(
    name => Object.hasOwn(seams, name) ? seams[name] : localRequire(name), module, module.exports, filename, dirname(filename));
  return module.exports;
}
const baseRow = (patch = {}) => ({ id: ids.entry, venue_id: ids.venue, user_id: ids.employee, status: 'draft',
  calculation_run_id: ids.run, calculation_provenance_sha256: 'a'.repeat(64), calculation_gross_cents: '2000',
  period_from: '2026-10-01', period_to: '2026-10-31', amount: '20.00', net_cents: '2000', expense_id: null,
  employee_name_snapshot: 'Employee Test', calculation_scheme_name_snapshot: 'Payroll scheme',
  finance_category_id: '10000000-0000-4000-8000-000000000011', finance_category_name_snapshot: 'Зарплата',
  finance_account_id: null, finance_account_name_snapshot: null, payment_date: null, ...patch });
const sourceProof = (row, patch = {}) => ({ proofKind: 'current_transition', venueId: ids.venue, entryId: row.id,
  employeeId: row.user_id, runId: row.calculation_run_id, origin: 'calculation_run', currency: 'RUB',
  evidenceHashes: { provenanceSha256: row.calculation_provenance_sha256 }, periodFrom: row.period_from,
  periodTo: row.period_to, entryStatus: row.status, grossCents: Number(row.calculation_gross_cents),
  netCents: Number(row.net_cents), protectedFixedCents: 1000, eligibleVariableCents: Number(row.calculation_gross_cents) - 1000,
  ...patch });
const commandInput = (action, stateHash, patch = {}) => ({ action, expectedStateHash: stateHash,
  idempotencyKey: 'entry-transition-01', paymentDate: action === 'pay' ? '2026-10-23' : null,
  paymentAccountId: action === 'pay' ? ids.account : null, paymentMethod: action === 'pay' ? 'bank_transfer' : null,
  reason: action === 'cancel' ? 'owner requested cancellation' : null, ...patch });
const rowEntry = row => ({ id: row.id, venueId: row.venue_id, employeeId: row.user_id, runId: row.calculation_run_id,
  origin: 'calculation_run', currency: 'RUB', provenanceSha256: row.calculation_provenance_sha256,
  periodFrom: row.period_from, periodTo: row.period_to, status: row.status,
  grossCents: Number(row.calculation_gross_cents), netCents: Number(row.net_cents) });

function fixture(options = {}) {
  const calls = [], staged = [], committed = [], order = [];
  const row = baseRow(options.row);
  const initialRow = structuredClone(row);
  const settings = { owner: true, ledger: [], account: { id: ids.account, name: 'Расчетный счет', kind: 'bank',
    allowed_payment_methods: ['bank_transfer'], active: true }, ...options };
  let proofCalls = 0, correctionCalls = 0, freshnessCalls = 0, cancellationPreviewCalls = 0, cancellationStoreCalls = 0;
  let transitionNumber = 0;
  const db = { async query(sql, values = []) {
    const text = sql.replace(/\s+/g, ' ').trim(); calls.push({ text, values });
    if (text.startsWith('SELECT pg_advisory_lock(')) return { rows: [] };
    if (text.startsWith('SELECT pg_advisory_unlock(')) return { rows: [{ unlocked: true }] };
    if (text === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ WRITE' || text === 'COMMIT' || text === 'ROLLBACK') {
      if (text === 'COMMIT') committed.push(...staged.splice(0));
      if (text === 'ROLLBACK') { staged.length = 0; Object.assign(row, structuredClone(initialRow)); }
      return { rows: [] };
    }
    if (text.startsWith('SELECT full_name FROM users')) {
      order.push('owner'); assert.deepEqual(values, [ids.venue, ids.owner]);
      return { rows: settings.owner ? [{ full_name: 'Owner Test' }] : [] };
    }
    if (text.startsWith('SELECT request_hash,response_payload,response_hash FROM payroll_calculation_entry_transition_requests')) {
      order.push('journal_read'); assert.deepEqual(values, [ids.venue, settings.requestKey || 'entry-transition-01']);
      return { rows: settings.previous ? [settings.previous] : [] };
    }
    if (text.startsWith('SELECT pe.*')) {
      order.push('entry_read'); assert.equal(values[0], ids.venue); assert.equal(values[1], ids.entry);
      return { rows: [{ ...row }] };
    }
    if (text.startsWith('SELECT id,name,kind,allowed_payment_methods,active FROM finance_accounts')) {
      order.push('account_read'); assert.deepEqual(values, [ids.venue, ids.account]);
      return { rows: settings.account ? [{ ...settings.account }] : [] };
    }
    if (text.startsWith('SELECT (now() AT TIME ZONE')) {
      order.push('cash_date'); assert.deepEqual(values, [ids.venue]); return { rows: [{ date: settings.cashDate || '2026-10-23' }] };
    }
    if (text.startsWith('SELECT id FROM shifts WHERE venue_id=$1 AND closed_at IS NULL')) {
      order.push('shift_read'); assert.deepEqual(values, [ids.venue]);
      return { rows: settings.shifts === undefined ? [{ id: ids.shift }] : settings.shifts };
    }
    if (text.startsWith('SELECT COALESCE(sum(LEAST(base_pay,final_amount)')) {
      order.push('snapshot_totals'); assert.deepEqual(values, [ids.venue, ids.run, ids.employee]);
      return { rows: [{ fixed: '1000', gross: row.calculation_gross_cents }] };
    }
    const mutation = text.startsWith('INSERT INTO expenses') ? 'expense'
      : text.startsWith('INSERT INTO payroll_calculation_entry_transitions') ? 'transition'
        : text.startsWith("UPDATE payroll_entries SET status='cancelled'") ? 'release_update'
          : text.startsWith('UPDATE payroll_entries SET status=') ? 'entry_update'
            : text.startsWith('INSERT INTO payroll_calculation_entry_transition_requests') ? 'journal_write'
              : text.startsWith('INSERT INTO payroll_correction_batches') ? 'release_batch'
                : text.startsWith('INSERT INTO payroll_correction_events') ? 'release_event'
                  : text.startsWith('INSERT INTO payroll_correction_requests') ? 'release_journal' : null;
    if (mutation) {
      order.push(mutation); const item = { mutation, text, values }; staged.push(item);
      if (settings.failAfter === mutation) throw new Error(`injected_${mutation}`);
      if (mutation === 'expense') return { rows: [{ id: settings.expenseId || ids.expense }] };
      if (mutation === 'transition') {
        transitionNumber++;
        return { rows: [{ id: ids.transition, created_at: transitionCreatedAt }] };
      }
      if (mutation === 'entry_update') {
        if (text.includes("SET status='approved'")) row.status = 'approved';
        if (text.includes("SET status='paid'")) { row.status = 'paid'; row.expense_id = values[5]; row.payment_date = values[4]; }
        if (text.includes("SET status='cancelled'")) row.status = 'cancelled';
        return { rows: [] };
      }
      if (mutation === 'release_update') { row.status = 'cancelled'; return { rows: [{ id: ids.entry }] }; }
      if (mutation === 'release_event') return { rows: [{ id: ids.transition }] };
      return { rows: [] };
    }
    assert.fail(`Unexpected SQL: ${text}`);
  } };
  const module = isolated('../payroll-calculation-entry-lifecycle.js', {
    './payroll-calculation-entry-evidence': { async verifyPayrollCalculationEntryEvidence(client, owner, current, opts) {
      proofCalls++; assert.equal(client, db); assert.equal(owner.venueId, ids.venue);
      assert.equal(opts.purpose, 'current_transition');
      if (settings.proofError) throw settings.proofError;
      if (typeof opts.checkFreshness === 'function') {
        freshnessCalls++;
        const result = await opts.checkFreshness(db, owner, current.calculation_run_id);
        if (settings.freshnessError) throw settings.freshnessError;
        assert.deepEqual(result, { status: 'current', runId: ids.run });
      }
      return sourceProof(current, settings.proofPatch);
    } },
    './payroll-calculation-entry-corrections': { async verifyPayrollEntryCorrections(client, owner, proof) {
      correctionCalls++; assert.equal(client, db); assert.equal(owner.venueId, ids.venue);
      if (settings.correctionError) throw settings.correctionError;
      return { ledgerHash: settings.ledgerHash || transitionCommand.buildPayrollEntryTransitionState(rowEntry(row), settings.ledger).ledgerHash,
        appliedCents: 0, activeApplicationIds: [] };
    } },
    './payroll-reviewed-correction-store': {
      async readReviewedCorrectionLedger(client, owner, employeeId) {
        assert.equal(client, db); assert.equal(owner.venueId, ids.venue); assert.equal(employeeId, ids.employee);
        return structuredClone(settings.ledger);
      },
      async previewReviewedCorrectionCancellation(client, owner, input) {
        cancellationPreviewCalls++; assert.equal(client, db); assert.equal(owner.venueId, ids.venue);
        assert.equal(input.targetEntryId, ids.entry); return settings.releasePlan || { releaseCents: 0, planHash: 'b'.repeat(64) };
      },
      async cancelReviewedCorrectionTarget(client, owner, input, options) {
        cancellationStoreCalls++; assert.equal(client, db); assert.equal(owner.venueId, ids.venue);
        order.push('release_store_start'); assert.equal(typeof options.beforeCancel, 'function');
        await db.query('INSERT INTO payroll_correction_batches(id,operation) VALUES($1,\'release\')', [ids.correctionBatch]);
        await db.query('INSERT INTO payroll_correction_events(id,kind) VALUES($1,\'release\')', [ids.transition]);
        const transition = await options.beforeCancel(); order.push('release_callback_complete');
        assert.equal(transition.id, ids.transition);
        await db.query("UPDATE payroll_entries SET status='cancelled' WHERE venue_id=$1 AND id=$2", [ids.venue, ids.entry]);
        await db.query('INSERT INTO payroll_correction_requests(id) VALUES($1)', [ids.correctionBatch]);
        return { operation: 'release', replayed: false };
      }
    }
  });
  const freshness = async (_db, _owner, runId) => ({ status: settings.freshness || 'current', runId });
  return { db, module, row, settings, calls, staged, committed, order, freshness,
    counts: () => ({ proofCalls, correctionCalls, freshnessCalls, cancellationPreviewCalls, cancellationStoreCalls }) };
}
async function withFence(f, fn) {
  const releaseLock = await fence.beginPayrollVerifiedRunSourceTransaction(f.db, ids.venue);
  try { const result = await fn(); await f.db.query('COMMIT'); return result; }
  catch (error) { await f.db.query('ROLLBACK'); throw error; }
  finally { await releaseLock(); }
}
const stateFor = f => transitionCommand.buildPayrollEntryTransitionState(rowEntry(f.row), f.settings.ledger);

// Current proof failure leaves only explicit cancellation available on the owner state view.
{
  const f = fixture({ correctionError: Object.assign(new Error('blocked source'), { code: 'payroll_entry_corrections_assessment_required' }) });
  const state = await withFence(f, () => f.module.getPayrollCalculationEntryState(f.db, actor, ids.entry, f.freshness));
  assert.equal(state.sourceStatus, 'blocked'); assert.equal(state.blockedReason, 'payroll_entry_corrections_assessment_required');
  assert.deepEqual(state.allowedActions, ['cancel']); assert.equal(state.validity, 'rechecked_on_transition');
}
// Strict owner authorization precedes idempotency journal lookup.
{
  const f = fixture({ owner: false, previous: { request_hash: 'x', response_payload: '{}', response_hash: sha('{}') } });
  await assert.rejects(withFence(f, () => f.module.transitionPayrollCalculationEntry(f.db, actor, ids.entry,
    commandInput('approve', stateFor(f).stateHash), f.freshness)), errorCode('owner_required'));
  assert.ok(!f.order.includes('journal_read')); assert.equal(f.counts().proofCalls, 0);
}
// Exact retry reads owner and journal, then returns the current entry without source/account/freshness work.
{
  const f = fixture(), command = commandInput('pay', stateFor(f).stateHash);
  const response = { schemaVersion: 1, transitionId: ids.transition, action: 'pay', entry: { status: 'paid', amountCents: 2000 }, replayed: false };
  const responsePayload = canonical(response);
  const requestHash = transitionCommand.payrollEntryTransitionRequestHash({ ...actor, name: 'Owner Test' },
    transitionCommand.normalizePayrollEntryTransitionCommand(ids.entry, command));
  f.settings.previous = { request_hash: requestHash, response_payload: responsePayload, response_hash: sha(responsePayload) };
  const result = await withFence(f, () => f.module.transitionPayrollCalculationEntry(f.db, actor, ids.entry, command, f.freshness));
  assert.equal(result.replayed, true); assert.ok(f.order.indexOf('owner') < f.order.indexOf('journal_read'));
  assert.equal(f.counts().proofCalls, 0); assert.equal(f.counts().correctionCalls, 0); assert.equal(f.counts().freshnessCalls, 0);
  assert.ok(!f.order.includes('account_read')); assert.ok(!f.order.includes('expense'));
}
// Expected state is bound before freshness, account lookup, or side effects.
{
  const f = fixture(), stale = commandInput('approve', 'f'.repeat(64));
  await assert.rejects(withFence(f, () => f.module.transitionPayrollCalculationEntry(f.db, actor, ids.entry, stale, f.freshness)),
    error => error?.code === 'payroll_entry_transition_state_stale');
  assert.equal(f.counts().proofCalls, 0); assert.equal(f.counts().correctionCalls, 0);
  assert.equal(f.staged.length, 0); assert.ok(!f.order.includes('account_read'));
}
// Approve uses fresh source proof, writes a transition and status, and creates no expense.
{
  const f = fixture(), command = commandInput('approve', stateFor(f).stateHash);
  const result = await withFence(f, () => f.module.transitionPayrollCalculationEntry(f.db, actor, ids.entry, command, f.freshness));
  assert.equal(result.entry.status, 'approved'); assert.equal(f.counts().proofCalls, 1); assert.equal(f.counts().correctionCalls, 1);
  assert.equal(f.counts().freshnessCalls, 1); assert.ok(!f.committed.some(item => item.mutation === 'expense'));
  assert.ok(f.committed.some(item => item.mutation === 'transition'));
  assert.ok(f.committed.some(item => item.mutation === 'entry_update'));
}
// Positive payment creates a fresh expense, then one transition, status update, and idempotency response.
{
  const f = fixture({ row: { status: 'approved' } }), command = commandInput('pay', stateFor(f).stateHash);
  const result = await withFence(f, () => f.module.transitionPayrollCalculationEntry(f.db, actor, ids.entry, command, f.freshness));
  assert.equal(result.entry.status, 'paid');
  const expense = f.committed.find(item => item.mutation === 'expense');
  assert.ok(expense); assert.equal(expense.values[0], ids.venue); assert.equal(expense.values[3], '20.00');
  assert.equal(expense.values[6], ids.owner); assert.equal(expense.values[7], 'bank_transfer');
  assert.ok(f.committed.some(item => item.mutation === 'transition'));
  assert.ok(f.committed.some(item => item.mutation === 'entry_update'));
  assert.ok(f.committed.some(item => item.mutation === 'journal_write'));
  assert.equal(f.committed.filter(item => item.mutation === 'expense').length, 1);
}
// Zero final pay creates a zero settlement and never requests cash/account data or an expense.
{
  const f = fixture({ row: { status: 'approved', amount: '0.00', net_cents: '0' }, proofPatch: { netCents: 0 } });
  const command = commandInput('pay', stateFor(f).stateHash, { paymentAccountId: null, paymentMethod: null });
  const result = await withFence(f, () => f.module.transitionPayrollCalculationEntry(f.db, actor, ids.entry, command, f.freshness));
  assert.ok(result.entry); assert.ok(!f.order.includes('account_read')); assert.ok(!f.committed.some(item => item.mutation === 'expense'));
  const transition = f.committed.find(item => item.mutation === 'transition');
  assert.equal(transition.values[15], 'zero'); assert.equal(transition.values[16], null);
}
// Existing expense references are rejected; the lifecycle never adopts or updates one.
{
  const f = fixture({ row: { status: 'approved', expense_id: ids.expense } }), command = commandInput('pay', stateFor(f).stateHash);
  await assert.rejects(withFence(f, () => f.module.transitionPayrollCalculationEntry(f.db, actor, ids.entry, command, f.freshness)),
    errorCode('unexpected_existing_expense'));
  assert.ok(!f.order.includes('account_read')); assert.ok(!f.staged.some(item => item.mutation === 'expense'));
}
// Finance account validation blocks inactive accounts and disallowed/mismatched methods before money writes.
for (const [account, expected] of [
  [{ id: ids.account, name: 'Inactive', kind: 'bank', allowed_payment_methods: ['bank_transfer'], active: false }, 'account_inactive'],
  [{ id: ids.account, name: 'Cash only', kind: 'bank', allowed_payment_methods: ['cash'], active: true }, 'payment_method_account_mismatch'],
  [{ id: ids.account, name: 'Cashbox', kind: 'pos_cashbox', allowed_payment_methods: ['cash'], active: true }, 'payment_method_account_mismatch']
]) {
  const f = fixture({ row: { status: 'approved' }, account }), command = commandInput('pay', stateFor(f).stateHash);
  await assert.rejects(withFence(f, () => f.module.transitionPayrollCalculationEntry(f.db, actor, ids.entry, command, f.freshness)),
    errorCode(expected));
  assert.ok(!f.staged.some(item => item.mutation === 'expense' || item.mutation === 'transition'));
}
// POS cash requires today's business date and exactly one open shift.
for (const [options, expected] of [
  [{ cashDate: '2026-10-22' }, 'cash_payment_date_must_be_today'],
  [{ shifts: [] }, 'open_shift_required'],
  [{ shifts: [{ id: ids.shift }, { id: ids.correctionBatch }] }, 'open_shift_required']
]) {
  const f = fixture({ row: { status: 'approved' }, account: { id: ids.account, name: 'Cashbox', kind: 'pos_cashbox',
    allowed_payment_methods: ['cash'], active: true }, ...options });
  const command = commandInput('pay', stateFor(f).stateHash, { paymentMethod: 'cash' });
  await assert.rejects(withFence(f, () => f.module.transitionPayrollCalculationEntry(f.db, actor, ids.entry, command, f.freshness)), errorCode(expected));
  if (expected === 'cash_payment_date_must_be_today') assert.ok(!f.order.includes('shift_read'));
  assert.ok(!f.staged.some(item => item.mutation === 'expense' || item.mutation === 'transition'));
}
{
  const f = fixture({ row: { status: 'approved' }, account: { id: ids.account, name: 'Cashbox', kind: 'pos_cashbox',
    allowed_payment_methods: ['cash'], active: true } });
  const command = commandInput('pay', stateFor(f).stateHash, { paymentMethod: 'cash' });
  const result = await withFence(f, () => f.module.transitionPayrollCalculationEntry(f.db, actor, ids.entry, command, f.freshness));
  const expense = f.committed.find(item => item.mutation === 'expense');
  assert.ok(expense); assert.equal(expense.values[7], 'cash'); assert.equal(expense.values[10], ids.shift);
  assert.ok(result.entry);
}
// Cancellation without active applications inserts the transition before its exact timestamp status update.
{
  const f = fixture(), command = commandInput('cancel', stateFor(f).stateHash);
  const result = await withFence(f, () => f.module.transitionPayrollCalculationEntry(f.db, actor, ids.entry, command, f.freshness));
  assert.ok(result.entry); assert.equal(f.counts().proofCalls, 0); assert.equal(f.counts().cancellationPreviewCalls, 1);
  assert.equal(f.counts().cancellationStoreCalls, 0);
  const transition = f.committed.find(item => item.mutation === 'transition');
  const update = f.committed.find(item => item.text.includes("SET status='cancelled'"));
  assert.ok(transition && update); assert.equal(update.values[2], transitionCreatedAt);
  assert.ok(f.order.indexOf('transition') < f.order.findIndex(value => value === 'release_update'));
}
// 203 writes the release batch/events first, invokes beforeCancel for the lifecycle transition, then updates the target and journals.
{
  const f = fixture({ releasePlan: { releaseCents: 500, planHash: 'c'.repeat(64) } }), command = commandInput('cancel', stateFor(f).stateHash);
  const result = await withFence(f, () => f.module.transitionPayrollCalculationEntry(f.db, actor, ids.entry, command, f.freshness));
  assert.ok(result.entry); assert.equal(f.counts().cancellationStoreCalls, 1);
  assert.ok(f.order.indexOf('release_batch') < f.order.indexOf('release_event'));
  assert.ok(f.order.indexOf('release_event') < f.order.indexOf('transition'));
  assert.ok(f.order.indexOf('transition') < f.order.indexOf('release_update'));
  assert.ok(f.order.indexOf('release_event') < f.order.indexOf('release_update'));
  assert.ok(f.order.indexOf('release_update') < f.order.indexOf('journal_write'));
}
// Injected failures after every lifecycle write stage are rolled back by the caller transaction.
for (const [action, settings, stage] of [
  ['pay', { row: { status: 'approved' } }, 'expense'],
  ['pay', { row: { status: 'approved' } }, 'transition'],
  ['approve', {}, 'entry_update'],
  ['approve', {}, 'journal_write'],
  ['cancel', { releasePlan: { releaseCents: 500, planHash: 'c'.repeat(64) } }, 'transition'],
  ['cancel', { releasePlan: { releaseCents: 500, planHash: 'c'.repeat(64) } }, 'release_batch'],
  ['cancel', { releasePlan: { releaseCents: 500, planHash: 'c'.repeat(64) } }, 'release_event'],
  ['cancel', { releasePlan: { releaseCents: 500, planHash: 'c'.repeat(64) } }, 'release_update'],
  ['cancel', { releasePlan: { releaseCents: 500, planHash: 'c'.repeat(64) } }, 'release_journal']
]) {
  const f = fixture({ ...settings, failAfter: stage });
  const command = commandInput(action, stateFor(f).stateHash);
  await assert.rejects(withFence(f, () => f.module.transitionPayrollCalculationEntry(f.db, actor, ids.entry, command, f.freshness)),
    error => error?.message === `injected_${stage}`);
  assert.equal(f.committed.length, 0, `${stage} leaked committed data`); assert.equal(f.staged.length, 0, `${stage} retained staged data`);
  assert.ok(f.calls.some(call => call.text === 'ROLLBACK'));
}
console.log('PASS payroll calculation entry lifecycle contract: owner/retry order, fresh state, approve/pay/cancel, settlement, POS cash, 203 release callback, rollback');
