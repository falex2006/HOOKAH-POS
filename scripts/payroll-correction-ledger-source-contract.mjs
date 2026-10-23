import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { normalizePayrollCorrectionLedgerEvent: normalize, payrollCorrectionSourceIdentity: identity,
  samePayrollCorrectionSource: same, payrollCorrectionLedgerEventFromRow: fromRow } = require('../payroll-correction-ledger-source');
const { buildPayrollEntryTransitionState } = require('../payroll-calculation-entry-transition-command');
const id = n => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;
const scope = { venueId: id(1), employeeId: id(2) };
const legacyKeys = ['id', 'sequenceNo', 'venueId', 'employeeId', 'currency', 'originalEntryId', 'refundLineEventId',
  'kind', 'amountCents', 'targetEntryId', 'reversesEventId'];
const periodKeys = [...legacyKeys, 'sourceKind', 'cohortClaimId', 'cohortAssessmentId'];
const event = (patch = {}) => ({ id: id(3), sequenceNo: 1, ...scope, currency: 'RUB', originalEntryId: id(4),
  refundLineEventId: id(5), kind: 'apply', amountCents: 125, targetEntryId: id(6), reversesEventId: null, ...patch });
const period = (patch = {}) => event({ refundLineEventId: null, sourceKind: 'period_v2', cohortClaimId: id(7), cohortAssessmentId: id(8), ...patch });
const release = row => ({ ...row, id: id(9), sequenceNo: 2, kind: 'release', reversesEventId: row.id });
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const ledgerHash = events => hash([...events].sort((a, b) => a.id.localeCompare(b.id)));
let checks = 0;
const eq = (a, b, message) => { assert.deepEqual(a, b, message); checks++; };
const invalid = (value, context = scope) => {
  assert.throws(() => normalize(value, context), error => /^payroll_correction_ledger_/.test(error.code || '') && error.status === 409); checks++;
};
// Pinned pre-extension lifecycle output construction, independent of the new
// helper and its consumers. It intentionally contains no period/default fields.
const oldNormalized = row => ({
  id: row.id.toLowerCase(), sequenceNo: row.sequenceNo, venueId: row.venueId.toLowerCase(), employeeId: row.employeeId.toLowerCase(),
  currency: row.currency, originalEntryId: row.originalEntryId.toLowerCase(), refundLineEventId: row.refundLineEventId.toLowerCase(),
  kind: row.kind, amountCents: row.amountCents, targetEntryId: row.targetEntryId === null ? null : row.targetEntryId.toLowerCase(),
  reversesEventId: row.reversesEventId === null ? null : row.reversesEventId.toLowerCase()
});
const upperIds = row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key,
  typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value) ? value.toUpperCase() : value]));
const originals = [event(), event({ id: id(10), sequenceNo: 3, kind: 'waive', targetEntryId: null }), release(event())];
const previous = originals.map(oldNormalized), normalized = originals.map(row => normalize(upperIds(row), scope));
eq(normalized, previous);
eq(normalized.map(Object.keys), originals.map(() => legacyKeys));
eq(JSON.stringify(normalized), JSON.stringify(previous), 'legacy raw serialization property order also unchanged');
eq(ledgerHash(normalized), ledgerHash(previous), 'legacy sorted ledger canonical hash unchanged');
eq(ledgerHash(normalized), 'beee906bdcb864e741d8ace55bfc1616b0b1d81f62244865557d54b06157c0aa', 'pinned legacy ledger SHA256');
const entry = { id: id(6), ...scope, runId: id(30), origin: 'calculation_run', currency: 'RUB', provenanceSha256: 'a'.repeat(64),
  grossCents: 1000, netCents: 1000, status: 'draft', periodFrom: '2026-10-01', periodTo: '2026-10-31' };
eq(buildPayrollEntryTransitionState(entry, originals).ledgerHash, ledgerHash(normalized), 'existing lifecycle hash agrees without any consumer changes');
eq(ledgerHash(normalized.slice().reverse()), ledgerHash(previous));
for (const make of [event, period]) {
  for (const kind of ['apply', 'waive', 'release']) {
    const input = make({ kind, targetEntryId: kind === 'waive' ? null : id(6), reversesEventId: kind === 'release' ? id(20) : null });
    const before = structuredClone(input), result = normalize(input, scope);
    eq(result, input); eq(input, before); eq(result === input, false, 'normalization returns independent object');
    eq(Object.keys(result), make === event ? legacyKeys : periodKeys);
    eq(normalize(upperIds(input), { venueId: scope.venueId.toUpperCase(), employeeId: scope.employeeId.toUpperCase() }), result);
    eq(normalize(input), result); eq(normalize(input, {}), result);
    eq(normalize(input, { venueId: scope.venueId }), result); eq(normalize(input, { employeeId: scope.employeeId }), result);
    eq(identity(input), identity(upperIds(input))); eq(same(input, upperIds(input)), true);
  }
  for (const key of make === event ? legacyKeys : periodKeys) {
    const row = make(); delete row[key]; invalid(row);
    let touched = false;
    const accessor = make(); Object.defineProperty(accessor, key, { enumerable: true, get() { touched = true; throw new Error('must not evaluate'); } });
    invalid(accessor); eq(touched, false);
  }
  for (const patch of [{ extra: true }, { currency: 'USD' }, { kind: 'unknown' }, { kind: null },
    { sequenceNo: 0 }, { sequenceNo: -1 }, { sequenceNo: 1.5 }, { sequenceNo: '1' }, { sequenceNo: Number.MAX_SAFE_INTEGER + 1 },
    { amountCents: 0 }, { amountCents: -0 }, { amountCents: -1 }, { amountCents: 1.5 }, { amountCents: '1' },
    { amountCents: NaN }, { amountCents: Infinity }, { amountCents: 1000000000000 }, { amountCents: Number.MAX_SAFE_INTEGER },
    { kind: 'apply', targetEntryId: null }, { kind: 'apply', reversesEventId: id(20) },
    { kind: 'waive', targetEntryId: id(6) }, { kind: 'waive', targetEntryId: null, reversesEventId: id(20) },
    { kind: 'release', reversesEventId: null }, { kind: 'release', targetEntryId: null, reversesEventId: id(20) },
    { id: null }, { originalEntryId: null }, { targetEntryId: 'not-a-uuid' }, { venueId: 1 }, { employeeId: {} }]) invalid(make(patch));
  eq(normalize(make({ amountCents: 999999999999, sequenceNo: Number.MAX_SAFE_INTEGER })).amountCents, 999999999999);
  eq(normalize(make({ amountCents: 1 })).amountCents, 1);
  for (const key of ['id', 'venueId', 'employeeId', 'originalEntryId', 'targetEntryId', ...(make === event ? ['refundLineEventId'] : ['cohortClaimId', 'cohortAssessmentId'])]) {
    invalid(make({ [key]: '00000000-0000-0000-0000-000000000000' }));
    invalid(make({ [key]: 'aaaaaaaa-aaaa-4aaa-7aaa-000000000001' }));
  }
  invalid(make({ venueId: id(70) })); invalid(make({ employeeId: id(71) }));
  const symbol = make(); symbol[Symbol('extra')] = true; invalid(symbol);
  const inherited = Object.assign(Object.create({ extra: true }), make()); invalid(inherited);
  const extraHidden = make(); Object.defineProperty(extraHidden, 'extra', { value: 1, enumerable: false }); invalid(extraHidden);
  // Data descriptors need not be enumerable: the historical validator accepted
  // them and normalization always emits ordinary enumerable output properties.
  const hiddenKnown = make(); Object.defineProperty(hiddenKnown, 'kind', { value: 'apply', enumerable: false });
  eq(normalize(hiddenKnown, scope), make());
}
for (const value of [null, undefined, [], 'event', 1, false, new Date(), Object.create(null)]) invalid(value);
for (const context of [null, [], 'scope', { venueId: null }, { employeeId: undefined }, { other: scope.venueId }]) invalid(event(), context);
let scopeGetter = false;
invalid(event(), { get venueId() { scopeGetter = true; return scope.venueId; } }); eq(scopeGetter, false);
for (const patch of [
  { sourceKind: 'line_v1' }, { sourceKind: null }, { sourceKind: undefined },
  { cohortClaimId: null }, { cohortAssessmentId: null }, { refundLineEventId: id(5) }
]) invalid(period(patch));
invalid(event({ sourceKind: 'period_v2' }));
invalid(event({ cohortClaimId: id(7), cohortAssessmentId: id(8) }));
invalid(event({ refundLineEventId: null }));
{
  const first = period(), later = period({ cohortAssessmentId: id(88) }), restored = release(first);
  eq(identity(first), identity(later), 'cumulative assessments share stable claim identity');
  eq(same(first, later), false, 'different assessment cannot masquerade as parent release basis');
  eq(same(first, restored), true); eq(same(restored, first), true);
  eq(same(first, { ...restored, cohortAssessmentId: later.cohortAssessmentId }), false);
  eq(same(first, period({ originalEntryId: id(44) })), false);
  eq(same(first, period({ cohortClaimId: id(77) })), false);
  eq(same(first, period({ venueId: id(11) })), false);
  eq(same(first, period({ employeeId: id(22) })), false);
  eq(same(event(), release(event())), true);
  eq(same(event(), event({ refundLineEventId: id(55) })), false);
  eq(same(event(), event({ originalEntryId: id(44) })), false);
  eq(same(first, event({ refundLineEventId: first.cohortClaimId })), false, 'source namespaces never collide');
  eq(identity(first) === identity(event({ refundLineEventId: first.cohortClaimId })), false);
  const changedEvent = period({ id: id(31), sequenceNo: 9, kind: 'waive', targetEntryId: null, amountCents: 200 });
  eq(same(first, changedEvent), true, 'source match intentionally leaves monetary/action matching to caller');
  eq(identity(first), identity(changedEvent));
  assert.throws(() => identity({ ...first, extra: true })); checks++;
  assert.throws(() => same(first, { ...first, cohortAssessmentId: null })); checks++;
}
{
  const mixed = [event(), period({ id: id(11), sequenceNo: 4 }), release(event()),
    period({ id: id(12), sequenceNo: 5, kind: 'waive', targetEntryId: null }),
    { ...release(period({ id: id(11), sequenceNo: 4 })), id: id(13), sequenceNo: 6 }];
  const before = structuredClone(mixed), result = mixed.map(row => normalize(row, scope));
  eq(result, mixed); eq(mixed, before);
  eq(result.map(row => Object.keys(row).length), [11, 14, 11, 14, 14]);
  eq(ledgerHash(result), ledgerHash(result.slice().reverse()), 'caller retains canonical ID sorting for a mixed ledger');
  eq(same(result[1], result[4]), true);
  eq(new Set(result.map(identity)).size, 2, 'one stable source per original claim, not per application');
}
{
  const sqlRow = item => ({ id: item.id, sequence_no: String(item.sequenceNo), venue_id: item.venueId,
    employee_id: item.employeeId, currency: item.currency, original_entry_id: item.originalEntryId,
    refund_line_event_id: item.refundLineEventId, kind: item.kind, amount_cents: String(item.amountCents),
    target_entry_id: item.targetEntryId, reverses_event_id: item.reversesEventId,
    ...(item.sourceKind ? { source_kind: item.sourceKind, claim_id: item.cohortClaimId,
      cohort_assessment_id: item.cohortAssessmentId } : {}) });
  eq(fromRow(sqlRow(event())), event());
  eq(fromRow({ ...sqlRow(event()), source_kind: 'line_v1' }), event());
  eq(fromRow(sqlRow(period())), period());
  eq(fromRow(sqlRow(release(period()))), release(period()));
  for (const patch of [{ sequence_no: '01' }, { amount_cents: '1.5' }, { source_kind: 'other' },
    { source_kind: 'period_v2' }, { amount_cents: '9007199254740993' }]) {
    assert.throws(() => fromRow({ ...sqlRow(event()), ...patch })); checks++;
  }
}
console.log(`payroll-correction-ledger-source-contract: PASS ${checks} checks (strict legacy11/period14, release basis, frozen legacy hashes; pure, no PG)`);
