import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const api = require('../payroll-calculation-entry-transition-command.js');
const ids = {
  venue: '10000000-0000-4000-8000-000000000001', owner: '10000000-0000-4000-8000-000000000002',
  employee: '10000000-0000-4000-8000-000000000003', entry: '10000000-0000-4000-8000-000000000004',
  run: '10000000-0000-4000-8000-000000000005', account: '10000000-0000-4000-8000-000000000006',
  refund: '10000000-0000-4000-8000-000000000007', original: '10000000-0000-4000-8000-000000000008',
  event: '10000000-0000-4000-8000-000000000009'
};
const actor = { venueId: ids.venue, userId: ids.owner };
const entry = (patch = {}) => ({ id: ids.entry, venueId: ids.venue, employeeId: ids.employee, runId: ids.run,
  origin: 'calculation_run', currency: 'RUB', provenanceSha256: 'a'.repeat(64), grossCents: 2500, netCents: 2500,
  status: 'draft', periodFrom: '2026-09-01', periodTo: '2026-09-30', ...patch });
const event = (patch = {}) => ({ id: ids.event, sequenceNo: 1, venueId: ids.venue, employeeId: ids.employee,
  currency: 'RUB', originalEntryId: ids.original, refundLineEventId: ids.refund, kind: 'apply', amountCents: 500,
  targetEntryId: ids.entry, reversesEventId: null, ...patch });
const state = (row = entry(), ledger = []) => api.buildPayrollEntryTransitionState(row, ledger);
const input = (action, expectedStateHash, patch = {}) => ({ action, expectedStateHash, idempotencyKey: 'transition-0001',
  paymentDate: action === 'pay' ? '2026-10-01' : null,
  paymentAccountId: action === 'pay' ? ids.account : null,
  paymentMethod: action === 'pay' ? 'bank_transfer' : null,
  reason: action === 'cancel' ? 'owner cancellation' : null, ...patch });
const code = name => error => error?.code === `payroll_entry_transition_${name}`;

// Normalization is closed-shape and does not invoke getters or accept coercion.
{
  const current = state();
  const normalized = api.normalizePayrollEntryTransitionCommand(ids.entry, input('approve', current.stateHash));
  assert.deepEqual(normalized, { entryId: ids.entry, action: 'approve', expectedStateHash: current.stateHash,
    idempotencyKey: 'transition-0001', paymentDate: null, paymentAccountId: null, paymentMethod: null, reason: null });
  for (const bad of [null, [], { ...input('approve', current.stateHash), extra: true },
    { ...input('approve', current.stateHash), paymentMethod: 'cash' }]) {
    assert.throws(() => api.normalizePayrollEntryTransitionCommand(ids.entry, bad));
  }
  let accessed = false;
  const getter = { ...input('approve', current.stateHash) };
  Object.defineProperty(getter, 'action', { enumerable: true, get() { accessed = true; return 'approve'; } });
  assert.throws(() => api.normalizePayrollEntryTransitionCommand(ids.entry, getter)); assert.equal(accessed, false);
  assert.throws(() => api.normalizePayrollEntryTransitionCommand({}, input('approve', current.stateHash)), code('identity_invalid'));
  assert.throws(() => api.normalizePayrollEntryTransitionCommand(ids.entry, input('approve', 'bad')), code('command_invalid'));
  assert.throws(() => api.normalizePayrollEntryTransitionCommand(ids.entry, input('pay', current.stateHash, { paymentDate: null })), code('payment_date_invalid'));
  assert.throws(() => api.normalizePayrollEntryTransitionCommand(ids.entry, input('pay', current.stateHash,
    { paymentDate: '2026-02-30' })), code('payment_date_invalid'));
  assert.throws(() => api.normalizePayrollEntryTransitionCommand(ids.entry, input('cancel', current.stateHash,
    { reason: 'no' })), code('action_fields_invalid'));
}
// Entry and complete correction-ledger state are canonicalized, bounded, and bound to all identity/value fields.
{
  const first = state(entry(), [event()]);
  assert.equal(first.ledgerHash, state(entry(), [event()]).ledgerHash);
  assert.notEqual(first.ledgerHash, state(entry(), [event({ amountCents: 501 })]).ledgerHash);
  assert.notEqual(first.stateHash, state(entry({ netCents: 2400 }), [event()]).stateHash);
  assert.notEqual(first.stateHash, state(entry({ status: 'approved' }), [event()]).stateHash);
  assert.notEqual(first.stateHash, state(entry({ provenanceSha256: 'b'.repeat(64) }), [event()]).stateHash);
  assert.notEqual(first.stateHash, state(entry(), []).stateHash);
  assert.equal(state(entry(), [event({ sequenceNo: 2 }), event({ id: '10000000-0000-4000-8000-000000000010', sequenceNo: 1 })]).ledgerHash,
    state(entry(), [event({ id: '10000000-0000-4000-8000-000000000010', sequenceNo: 1 }), event({ sequenceNo: 2 })]).ledgerHash);
  assert.deepEqual(state().allowedActions, ['approve', 'cancel']);
  assert.throws(() => state(entry({ origin: 'legacy' }), []), code('entry_basis_invalid'));
  assert.throws(() => state(entry({ grossCents: '2500' }), []), code('amount_invalid'));
  assert.throws(() => state(entry({ grossCents: 1000000000000 }), []), code('amount_invalid'));
  assert.throws(() => state(entry({ netCents: 2501 }), []), code('entry_basis_invalid'));
  assert.throws(() => state(entry(), [event({ employeeId: ids.owner })]), code('ledger_invalid'));
  assert.throws(() => state(entry(), [event({ sequenceNo: Number.MAX_SAFE_INTEGER + 1 })]), code('ledger_invalid'));
  assert.throws(() => state(entry(), Array.from({ length: 100001 }, (_, i) => event({
    id: `10000000-0000-4000-8000-${String(i + 100).padStart(12, '0')}`, sequenceNo: i + 1
  }))), code('ledger_invalid'));
}
// Expected-state binding and legal status transitions are enforced before a request hash is returned.
{
  const legacy = state(entry(), [event()]);
  assert.equal(legacy.ledgerHash, 'a03c44e0f8630ef5142726f93ebed0c8eedab3d8833ea41ebc1da4e713aa1df3');
  assert.equal(legacy.stateHash, '0f6f297a04cec4c5d459870214ccc310dff7e9f14660a7a28f086a0a1d0f6311');
  const period = event({ id: '10000000-0000-4000-8000-000000000010', sequenceNo: 2,
    sourceKind: 'period_v2', refundLineEventId: null, cohortClaimId: ids.refund, cohortAssessmentId: ids.run });
  const ledger = [event(), period], before = structuredClone(ledger);
  const mixed = state(entry(), ledger);
  assert.deepEqual(state(entry(), [...ledger].reverse()), mixed);
  assert.deepEqual(ledger, before);
  assert.notEqual(mixed.ledgerHash, legacy.ledgerHash);
  assert.notEqual(mixed.stateHash, state(entry(), [event(), { ...period, cohortAssessmentId: ids.owner }]).stateHash);
  assert.notEqual(mixed.stateHash, state(entry(), [event(), { ...period, cohortClaimId: ids.owner }]).stateHash);
  for (const patch of [{ sequenceNo: 1 }, { id: ids.event }, { venueId: ids.owner }, { employeeId: ids.owner }]) {
    assert.throws(() => state(entry(), [event(), { ...period, ...patch }]), code('ledger_invalid'));
  }
  for (const bad of [null, { ...period, sourceKind: 'line_v1' }, { ...period, refundLineEventId: ids.refund },
    { ...period, extra: true }, { ...event(), sourceKind: null }, { ...period, [Symbol('extra')]: true },
    { ...period, amountCents: 0 }]) {
    assert.throws(() => state(entry(), [bad]), e => code('ledger_invalid')(e) && e.status === 409);
  }
  for (const amountCents of [-1, 0.1, '10', null, 1000000000000]) {
    assert.throws(() => state(entry(), [{ ...period, amountCents }]), e => code('amount_invalid')(e) && e.status === 400);
  }
  assert.throws(() => state(entry(), [{ ...period, cohortClaimId: null }]), e => code('identity_invalid')(e) && e.status === 400);
  let accessed = false;
  const getter = { ...period };
  Object.defineProperty(getter, 'amountCents', { enumerable: true, get() { accessed = true; return 100; } });
  assert.throws(() => state(entry(), [getter]), code('ledger_invalid')); assert.equal(accessed, false);
  const upper = { ...period, cohortClaimId: 'ABCDEFAB-1234-4000-8000-123456ABCDEF' };
  assert.deepEqual(state(entry(), [upper]), state(entry(), [{ ...upper, cohortClaimId: upper.cohortClaimId.toLowerCase() }]));
  const waived = { ...period, kind: 'waive', targetEntryId: null };
  const released = { ...period, kind: 'release', reversesEventId: ids.event };
  assert.match(state(entry(), [waived]).ledgerHash, /^[a-f0-9]{64}$/);
  assert.match(state(entry(), [released]).ledgerHash, /^[a-f0-9]{64}$/);
}
{
  let current = state(entry());
  const approve = api.buildPayrollEntryTransitionCommand(actor, ids.entry, input('approve', current.stateHash), entry(), []);
  assert.equal(approve.command.action, 'approve'); assert.match(approve.requestHash, /^[a-f0-9]{64}$/);
  assert.throws(() => api.buildPayrollEntryTransitionCommand(actor, ids.entry, input('approve', 'f'.repeat(64)), entry(), []), code('state_stale'));
  assert.throws(() => api.buildPayrollEntryTransitionCommand(actor, ids.entry, input('pay', current.stateHash), entry(), []), code('transition_invalid'));
  const approved = entry({ status: 'approved' }), approvedState = state(approved);
  assert.equal(api.buildPayrollEntryTransitionCommand(actor, ids.entry, input('pay', approvedState.stateHash), approved, []).command.action, 'pay');
  assert.equal(api.buildPayrollEntryTransitionCommand(actor, ids.entry, input('cancel', approvedState.stateHash), approved, []).command.action, 'cancel');
  for (const status of ['paid', 'cancelled']) {
    const row = entry({ status }), s = state(row);
    assert.deepEqual(s.allowedActions, []);
    assert.throws(() => api.buildPayrollEntryTransitionCommand(actor, ids.entry, input('cancel', s.stateHash), row, []), code('transition_invalid'));
  }
  assert.throws(() => api.buildPayrollEntryTransitionCommand(actor, ids.original, input('approve', current.stateHash), entry(), []), code('entry_identity_mismatch'));
  assert.throws(() => api.buildPayrollEntryTransitionCommand(actor, ids.entry, input('approve', current.stateHash), entry(), [event()]), code('state_stale'));
}
// Payment method/account pair rules apply to positive and zero payable amounts.
{
  const positive = entry({ status: 'approved' }), positiveState = state(positive);
  const valid = api.buildPayrollEntryTransitionCommand(actor, ids.entry, input('pay', positiveState.stateHash), positive, []);
  assert.equal(valid.command.paymentAccountId, ids.account); assert.equal(valid.command.paymentMethod, 'bank_transfer');
  for (const patch of [
    { paymentAccountId: null, paymentMethod: 'cash' },
    { paymentAccountId: ids.account, paymentMethod: null },
    { paymentAccountId: ids.account, paymentMethod: 'crypto' }
  ]) assert.throws(() => api.buildPayrollEntryTransitionCommand(actor, ids.entry,
    input('pay', positiveState.stateHash, patch), positive, []));
  const zero = entry({ status: 'approved', grossCents: 0, netCents: 0 }), zeroState = state(zero);
  const zeroPay = api.buildPayrollEntryTransitionCommand(actor, ids.entry,
    input('pay', zeroState.stateHash, { paymentAccountId: null, paymentMethod: null }), zero, []);
  assert.equal(zeroPay.command.paymentAccountId, null); assert.equal(zeroPay.command.paymentMethod, null);
  assert.throws(() => api.buildPayrollEntryTransitionCommand(actor, ids.entry,
    input('pay', zeroState.stateHash), zero, []), code('payment_details_invalid'));
}
// Request hashes bind actor and every transition field except the retry key.
{
  const row = entry(), s = state(row), one = input('approve', s.stateHash);
  const first = api.buildPayrollEntryTransitionCommand(actor, ids.entry, one, row, []);
  const retryKeyChanged = api.buildPayrollEntryTransitionCommand(actor, ids.entry,
    { ...one, idempotencyKey: 'transition-0002' }, row, []);
  assert.equal(first.requestHash, retryKeyChanged.requestHash);
  for (const changed of [
    { action: 'cancel', reason: 'cancel this', paymentDate: null, paymentAccountId: null, paymentMethod: null },
    { expectedStateHash: 'b'.repeat(64) }
  ]) {
    const candidate = { ...one, ...changed };
    assert.notEqual(api.payrollEntryTransitionRequestHash(actor, api.normalizePayrollEntryTransitionCommand(ids.entry, candidate)), first.requestHash);
  }
  assert.notEqual(api.payrollEntryTransitionRequestHash({ ...actor, userId: ids.employee }, first.command), first.requestHash);
  assert.notEqual(api.payrollEntryTransitionRequestHash({ ...actor, venueId: ids.employee }, first.command), first.requestHash);
}
assert.throws(() => api.normalizePayrollEntryTransitionCommand(ids.entry, input('approve', [state().stateHash])), code('command_invalid'));
assert.throws(() => state(entry({ provenanceSha256: ['a'.repeat(64)] })), code('entry_basis_invalid'));
assert.throws(() => state(entry({ status: ['draft'] })), code('entry_basis_invalid'));
assert.throws(() => api.buildPayrollEntryTransitionCommand({ ...actor, venueId: ids.account }, ids.entry,
  input('approve', state().stateHash), entry(), []), code('entry_identity_mismatch'));
assert.equal(Object.isFrozen(state().entry), true);
assert.equal(Object.isFrozen(api.buildPayrollEntryTransitionCommand(actor, ids.entry,
  input('approve', state().stateHash), entry(), []).command), true);
console.log('PASS payroll entry transition command contract: strict inputs, full state/ledger binding, legal transitions, payment semantics, owner request hash');
