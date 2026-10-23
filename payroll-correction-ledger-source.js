'use strict';

// Shared source identity for the single correction ledger. Validation does not
// authorize a claim, establish history completeness or perform financial work.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_CENTS = 999999999999; // Match existing lifecycle numeric(12,2) bounds.
const LEGACY_KEYS = Object.freeze(['id', 'sequenceNo', 'venueId', 'employeeId', 'currency', 'originalEntryId',
  'refundLineEventId', 'kind', 'amountCents', 'targetEntryId', 'reversesEventId']);
const PERIOD_KEYS = Object.freeze([...LEGACY_KEYS, 'sourceKind', 'cohortClaimId', 'cohortAssessmentId']);
const fail = suffix => {
  const code = `payroll_correction_ledger_${suffix}`;
  throw Object.assign(new TypeError(code), { code, status: 409 });
};
const ownDataObject = value => Boolean(value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype
  && Reflect.ownKeys(value).every(key => typeof key === 'string')
  && Object.values(Object.getOwnPropertyDescriptors(value)).every(descriptor => Object.hasOwn(descriptor, 'value')));
const id = value => {
  if (typeof value !== 'string' || !UUID.test(value)) fail('identity_invalid');
  return value.toLowerCase();
};

function normalizePayrollCorrectionLedgerEvent(event, scope = {}) {
  // Inspect descriptors before reading any event/scope property: getter payloads
  // are rejected without evaluating caller-controlled accessors.
  if (!ownDataObject(event)) fail('event_invalid');
  if (!ownDataObject(scope) || Reflect.ownKeys(scope).some(key => !['venueId', 'employeeId'].includes(key))) fail('scope_invalid');
  const expectedVenue = Object.hasOwn(scope, 'venueId') ? id(scope.venueId) : null;
  const expectedEmployee = Object.hasOwn(scope, 'employeeId') ? id(scope.employeeId) : null;
  const period = Object.hasOwn(event, 'sourceKind');
  const keys = period ? PERIOD_KEYS : LEGACY_KEYS;
  if (Reflect.ownKeys(event).length !== keys.length || keys.some(key => !Object.hasOwn(event, key))
      || period && (event.sourceKind !== 'period_v2' || event.refundLineEventId !== null)) fail('event_invalid');
  if (!Number.isSafeInteger(event.amountCents) || event.amountCents <= 0 || event.amountCents > MAX_CENTS) fail('amount_invalid');
  // Preserve the exact legacy property insertion order and values. Never add a
  // default discriminator or null period fields to an old event/hash payload.
  const normalized = {
    id: id(event.id), sequenceNo: event.sequenceNo, venueId: id(event.venueId), employeeId: id(event.employeeId),
    currency: event.currency, originalEntryId: id(event.originalEntryId), refundLineEventId: period ? null : id(event.refundLineEventId),
    kind: event.kind, amountCents: event.amountCents,
    targetEntryId: event.targetEntryId === null ? null : id(event.targetEntryId),
    reversesEventId: event.reversesEventId === null ? null : id(event.reversesEventId),
    ...(period ? { sourceKind: 'period_v2', cohortClaimId: id(event.cohortClaimId), cohortAssessmentId: id(event.cohortAssessmentId) } : {})
  };
  if (!Number.isSafeInteger(normalized.sequenceNo) || normalized.sequenceNo <= 0 || normalized.currency !== 'RUB'
      || !['apply', 'waive', 'release'].includes(normalized.kind)
      || (normalized.kind === 'waive' ? normalized.targetEntryId !== null : normalized.targetEntryId === null)
      || (normalized.kind === 'release' ? normalized.reversesEventId === null : normalized.reversesEventId !== null)) fail('event_invalid');
  if (expectedVenue !== null && normalized.venueId !== expectedVenue
      || expectedEmployee !== null && normalized.employeeId !== expectedEmployee) fail('scope_mismatch');
  return normalized;
}

const sourceIdentity = event => [event.sourceKind || 'line_v1', event.venueId, event.employeeId,
  event.originalEntryId, event.sourceKind === 'period_v2' ? event.cohortClaimId : event.refundLineEventId].join(':');

// Stable source/claim identity across cumulative period assessments. Different
// assessments may authorize new applications against the same immutable claim.
function payrollCorrectionSourceIdentity(event) {
  return sourceIdentity(normalizePayrollCorrectionLedgerEvent(event));
}

// Exact source basis for matching a release with its parent application. The
// caller must additionally compare amount, target, parent ID, kind and sequence.
function samePayrollCorrectionSource(left, right) {
  const a = normalizePayrollCorrectionLedgerEvent(left), b = normalizePayrollCorrectionLedgerEvent(right);
  return sourceIdentity(a) === sourceIdentity(b)
    && (a.sourceKind !== 'period_v2' || a.cohortAssessmentId === b.cohortAssessmentId);
}

function payrollCorrectionLedgerEventFromRow(row) {
  if (!ownDataObject(row) || typeof row.sequence_no !== 'string' || !/^[1-9][0-9]*$/.test(row.sequence_no)
      || typeof row.amount_cents !== 'string' || !/^[1-9][0-9]*$/.test(row.amount_cents)
      || row.source_kind != null && !['line_v1', 'period_v2'].includes(row.source_kind)) fail('event_invalid');
  return normalizePayrollCorrectionLedgerEvent({ id: row.id, sequenceNo: Number(row.sequence_no),
    venueId: row.venue_id, employeeId: row.employee_id, currency: row.currency,
    originalEntryId: row.original_entry_id, refundLineEventId: row.refund_line_event_id,
    kind: row.kind, amountCents: Number(row.amount_cents), targetEntryId: row.target_entry_id,
    reversesEventId: row.reverses_event_id,
    ...(row.source_kind === 'period_v2' ? { sourceKind: 'period_v2', cohortClaimId: row.claim_id,
      cohortAssessmentId: row.cohort_assessment_id } : {}) });
}

module.exports = { normalizePayrollCorrectionLedgerEvent, payrollCorrectionSourceIdentity, samePayrollCorrectionSource,
  payrollCorrectionLedgerEventFromRow };
