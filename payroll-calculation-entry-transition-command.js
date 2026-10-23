'use strict';

// Pure lifecycle intent validation and state binding. Callers own authorization,
// fenced source verification, transactions and all database writes.
const { createHash } = require('node:crypto');
const { normalizePayrollCorrectionLedgerEvent } = require('./payroll-correction-ledger-source');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[a-f0-9]{64}$/i;
const MAX_CENTS = 999999999999; // numeric(12,2)
const METHODS = new Set(['cash', 'card', 'bank_transfer', 'other']);
const ACTIONS = Object.freeze({ draft: Object.freeze(['approve', 'cancel']), approved: Object.freeze(['pay', 'cancel']),
  paid: Object.freeze([]), cancelled: Object.freeze([]) });
const fail = (code, status = 400) => {
  throw Object.assign(new Error(`payroll_entry_transition_${code}`), { code: `payroll_entry_transition_${code}`, status });
};
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value);
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex');
const id = value => {
  if (typeof value !== 'string' || !UUID.test(value)) fail('identity_invalid');
  return value.toLowerCase();
};
const date = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)
      || !Number.isFinite(Date.parse(`${value}T00:00:00Z`))
      || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) fail('payment_date_invalid');
  return value;
};
const money = value => {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_CENTS) fail('amount_invalid');
  return value;
};
const ownDataObject = value => Boolean(value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype
  && Reflect.ownKeys(value).every(key => typeof key === 'string')
  && Object.values(Object.getOwnPropertyDescriptors(value)).every(descriptor => Object.hasOwn(descriptor, 'value')));
const normalizePayrollEntryTransitionCommand = (entryId, input) => {
  const keys = ['action', 'expectedStateHash', 'idempotencyKey', 'paymentDate', 'paymentAccountId', 'paymentMethod', 'reason'];
  if (!UUID.test(typeof entryId === 'string' ? entryId : '')) fail('identity_invalid');
  if (!ownDataObject(input) || Reflect.ownKeys(input).length !== keys.length || keys.some(key => !Object.hasOwn(input, key))) fail('command_shape_invalid');
  if (!['approve', 'pay', 'cancel'].includes(input.action) || typeof input.expectedStateHash !== 'string' || !SHA.test(input.expectedStateHash)
      || typeof input.idempotencyKey !== 'string' || !/^[A-Za-z0-9_.:-]{8,120}$/.test(input.idempotencyKey)) fail('command_invalid');
  let paymentDate = null, paymentAccountId = null, paymentMethod = null, reason = null;
  if (input.action === 'approve') {
    if (input.paymentDate !== null || input.paymentAccountId !== null || input.paymentMethod !== null || input.reason !== null) fail('action_fields_invalid');
  } else if (input.action === 'cancel') {
    if (input.paymentDate !== null || input.paymentAccountId !== null || input.paymentMethod !== null
        || typeof input.reason !== 'string' || input.reason.trim().length < 3 || input.reason.length > 500) fail('action_fields_invalid');
    reason = input.reason.trim();
  } else {
    paymentDate = date(input.paymentDate);
    if (input.reason !== null) fail('action_fields_invalid');
    if (input.paymentAccountId === null && input.paymentMethod === null) {
      paymentAccountId = null; paymentMethod = null;
    } else {
      paymentAccountId = id(input.paymentAccountId);
      if (!METHODS.has(input.paymentMethod)) fail('payment_method_invalid');
      paymentMethod = input.paymentMethod;
    }
  }
  return { entryId: entryId.toLowerCase(), action: input.action, expectedStateHash: input.expectedStateHash.toLowerCase(),
    idempotencyKey: input.idempotencyKey, paymentDate, paymentAccountId, paymentMethod, reason };
};
const normalizeEntry = entry => {
  if (!ownDataObject(entry) || entry.origin !== 'calculation_run' || entry.currency !== 'RUB'
      || typeof entry.provenanceSha256 !== 'string' || !SHA.test(entry.provenanceSha256)
      || typeof entry.status !== 'string') fail('entry_basis_invalid', 409);
  const normalized = {
    id: id(entry.id), venueId: id(entry.venueId), employeeId: id(entry.employeeId), runId: id(entry.runId),
    provenanceSha256: entry.provenanceSha256.toLowerCase(), grossCents: money(entry.grossCents), netCents: money(entry.netCents),
    status: entry.status, periodFrom: date(entry.periodFrom), periodTo: date(entry.periodTo)
  };
  if (normalized.periodFrom > normalized.periodTo || normalized.periodFrom.slice(0, 7) !== normalized.periodTo.slice(0, 7)
      || normalized.netCents > normalized.grossCents || !Object.hasOwn(ACTIONS, normalized.status)) fail('entry_basis_invalid', 409);
  return normalized;
};
const normalizeLedgerEvent = (event, entry) => {
  try {
    return normalizePayrollCorrectionLedgerEvent(event, { venueId: entry.venueId, employeeId: entry.employeeId });
  } catch (error) {
    // Retain the lifecycle API's established error namespace/status. A zero
    // amount historically passed money() and failed the ledger rule instead.
    if (error.code === 'payroll_correction_ledger_identity_invalid') fail('identity_invalid');
    if (error.code === 'payroll_correction_ledger_amount_invalid'
        && Object.getOwnPropertyDescriptor(event, 'amountCents')?.value !== 0) fail('amount_invalid');
    if (error.code?.startsWith('payroll_correction_ledger_')) fail('ledger_invalid', 409);
    throw error;
  }
};
const buildPayrollEntryTransitionState = (entryInput, ledgerInput) => {
  const entry = normalizeEntry(entryInput);
  if (!Array.isArray(ledgerInput) || ledgerInput.length > 100000) fail('ledger_invalid', 409);
  const ledger = ledgerInput.map(event => normalizeLedgerEvent(event, entry))
    .sort((a, b) => a.sequenceNo - b.sequenceNo || a.id.localeCompare(b.id));
  const eventIds = new Set(), sequences = new Set();
  for (const event of ledger) {
    if (eventIds.has(event.id) || sequences.has(event.sequenceNo)) fail('ledger_invalid', 409);
    eventIds.add(event.id); sequences.add(event.sequenceNo);
  }
  const state = { schemaVersion: 1, entry: Object.freeze(entry), ledgerHash: hash([...ledger].sort((a, b) => a.id.localeCompare(b.id))) };
  return Object.freeze({ ...state, allowedActions: ACTIONS[entry.status], stateHash: hash(state) });
};
const payrollEntryTransitionRequestHash = (actor, commandInput) => {
  const keys = ['entryId', 'action', 'expectedStateHash', 'idempotencyKey', 'paymentDate', 'paymentAccountId', 'paymentMethod', 'reason'];
  if (!ownDataObject(actor) || !ownDataObject(commandInput) || Reflect.ownKeys(commandInput).length !== keys.length
      || keys.some(key => !Object.hasOwn(commandInput, key))) fail('command_shape_invalid');
  const command = normalizePayrollEntryTransitionCommand(commandInput.entryId, {
    action: commandInput.action, expectedStateHash: commandInput.expectedStateHash,
    idempotencyKey: commandInput.idempotencyKey, paymentDate: commandInput.paymentDate,
    paymentAccountId: commandInput.paymentAccountId, paymentMethod: commandInput.paymentMethod, reason: commandInput.reason
  });
  const venueId = id(actor.venueId), actorId = id(actor.userId);
  const { idempotencyKey, ...intent } = command;
  return hash({ schemaVersion: 1, venueId, actorId, ...intent });
};
const buildPayrollEntryTransitionCommand = (actor, entryId, input, entryInput, ledgerInput) => {
  const command = normalizePayrollEntryTransitionCommand(entryId, input);
  const state = buildPayrollEntryTransitionState(entryInput, ledgerInput);
  if (!ownDataObject(actor) || id(actor.venueId) !== state.entry.venueId) fail('entry_identity_mismatch', 409);
  if (state.entry.id !== command.entryId) fail('entry_identity_mismatch', 409);
  if (state.stateHash !== command.expectedStateHash) fail('state_stale', 409);
  if (!state.allowedActions.includes(command.action)) fail('transition_invalid', 409);
  if (command.action === 'pay') {
    const hasAccount = command.paymentAccountId !== null, hasMethod = command.paymentMethod !== null;
    if (hasAccount !== hasMethod || (state.entry.netCents > 0 && !hasAccount)
        || (state.entry.netCents === 0 && hasAccount)) fail('payment_details_invalid', 409);
  }
  const requestHash = payrollEntryTransitionRequestHash(actor, command);
  return Object.freeze({ command: Object.freeze(command), state, requestHash });
};

module.exports = { normalizePayrollEntryTransitionCommand, buildPayrollEntryTransitionState,
  payrollEntryTransitionRequestHash, buildPayrollEntryTransitionCommand };
