import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { calculatePayrollScheme } = require('../payroll-schemes.js');
const {
  PayrollCalculatorReplayError, buildCalculatorReplay, validateCalculatorReplay,
  executeCalculatorReplay, getCalculatorReplayEngineManifest
} = require('../payroll-calculator-replay.js');

// One paid shift and one commission-bearing sale: all three persisted detail
// levels (employee/day/line) have meaningful nonzero amounts to replay.
const fixture = () => ({
  periodFrom: '2026-09-01', periodTo: '2026-09-01', monthClosed: false,
  coverage: { kind: 'month_to_date_complete', from: '2026-09-01', through: '2026-09-01', complete: true, watermark: 'sales-1' },
  attendanceCoverage: { kind: 'approved_attendance_complete', from: '2026-09-01', through: '2026-09-01', complete: true, watermark: 'attendance-1' },
  employees: [{ id: 'a' }],
  roleAssignments: [{ employeeId: 'a', roleId: 'bartender', effectiveFrom: '2026-09-01', effectiveTo: '2026-09-30' }],
  attendance: [{ id: 'shift-a', employeeId: 'a', date: '2026-09-01', approved: true, workedMinutes: 480, plannedMinutes: 480 }],
  sales: [{ id: 'sale-a', date: '2026-09-01', employeeId: 'a', menuItemId: 'water', department: 'bar', turnoverCents: 10000, commissionBaseCents: 10000 }],
  sourceEvidence: { source: 'contract-fixture', coverageRevision: 7, lineIds: ['sale-a'] },
  scheme: { id: 'replay-scheme', versionId: 'replay-scheme-v1', currency: 'RUB', mode: 'progressive_daily',
    roleParameters: { bartender: { perShiftCents: 1000, bracketRatesBps: { 0: 1000 } } },
    employeeOverrides: [], itemRules: [], applyMilestones: false }
});
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value !== null && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value);
const sha256 = value => createHash('sha256').update(canonical(value), 'utf8').digest('hex');
const rejects = (fn, code, label) => assert.throws(fn, error => error instanceof PayrollCalculatorReplayError
  && error.code === `payroll_calculator_replay_${code}` && error.status === 409, label || code);
const assertFrozenTree = value => {
  if (!value || typeof value !== 'object') return;
  assert.ok(Object.isFrozen(value));
  Object.values(value).forEach(assertFrozenTree);
};

const input = fixture();
const result = calculatePayrollScheme(input);
assert.equal(result.status, 'ready');
assert.deepEqual(result.blockers, []);
assert.deepEqual(result.criticalErrors, []);
assert.equal(result.employees[0].amountCents, 2000);
assert.equal(result.daily[0].lines[0].commissionCents, 1000);
const replay = buildCalculatorReplay(input, result);
assert.deepEqual(replay.input, input, 'the entire calculation input, including source evidence, survives');
assert.deepEqual(replay.result, result, 'the complete detailed output survives');
assert.equal(replay.inputSha256, sha256(input));
assert.equal(replay.resultSha256, sha256(result));
assertFrozenTree(replay);
assert.notEqual(replay.input, input);
assert.notEqual(replay.input.scheme.roleParameters, input.scheme.roleParameters);
assert.notEqual(replay.result.daily[0], result.daily[0]);
input.sales[0].commissionBaseCents = 1;
result.employees[0].amountCents = 999;
assert.equal(replay.input.sales[0].commissionBaseCents, 10000, 'caller mutation cannot change saved input');
assert.equal(replay.result.employees[0].amountCents, 2000, 'caller mutation cannot change saved output');
assert.throws(() => { replay.input.sales[0].commissionBaseCents = 1; }, TypeError);

const stored = JSON.parse(JSON.stringify(replay));
const metadata = validateCalculatorReplay(stored, {
  schemeSnapshot: stored.input.scheme, sourceEvidence: stored.input.sourceEvidence,
  period: { from: '2026-09-01', to: '2026-09-01' }, currency: 'RUB', result: stored.result
});
assert.equal(metadata.state, 'available');
assert.equal(metadata.replayVerified, false, 'checksum validation alone does not claim execution');
assertFrozenTree(metadata);
const executed = executeCalculatorReplay(stored);
assert.equal(executed.status, 'matched');
assert.equal(executed.matched, true);
assert.equal(executed.replayVerified, true);
assert.deepEqual(executed.result, replay.result);
assert.equal(executed.resultSha256, replay.resultSha256);
assertFrozenTree(executed);
assert.equal(Object.isFrozen(stored), false, 'reading a caller envelope does not freeze its objects');

const reordered = fixture();
reordered.sourceEvidence = { lineIds: ['sale-a'], coverageRevision: 7, source: 'contract-fixture', omitted: undefined, negativeZero: -0 };
const normalized = buildCalculatorReplay(reordered, calculatePayrollScheme(reordered));
assert.equal(Object.hasOwn(normalized.input.sourceEvidence, 'omitted'), false);
assert.equal(Object.is(normalized.input.sourceEvidence.negativeZero, -0), false);
const plainZero = fixture();
plainZero.sourceEvidence = { source: 'contract-fixture', negativeZero: 0, coverageRevision: 7, lineIds: ['sale-a'] };
assert.equal(normalized.inputSha256, buildCalculatorReplay(plainZero, calculatePayrollScheme(plainZero)).inputSha256,
  'object order, omitted undefined fields and negative zero have one deterministic encoding');
const safeBounds = fixture();
safeBounds.sourceEvidence = JSON.parse('{"maximum":9007199254740991,"minimum":-9007199254740991,"__proto__":{"replayPolluted":true}}');
const safeReplay = buildCalculatorReplay(safeBounds, calculatePayrollScheme(safeBounds));
assert.equal(safeReplay.input.sourceEvidence.maximum, Number.MAX_SAFE_INTEGER);
assert.equal(safeReplay.input.sourceEvidence.minimum, Number.MIN_SAFE_INTEGER);
assert.equal(Object.hasOwn(safeReplay.input.sourceEvidence, '__proto__'), true, 'JSON property is retained as data');
assert.equal(Object.getPrototypeOf(safeReplay.input.sourceEvidence), Object.prototype);
assert.equal({}.replayPolluted, undefined, 'JSON normalization cannot mutate object prototypes');
assert.equal(executeCalculatorReplay(JSON.parse(JSON.stringify(safeReplay))).matched, true);

for (const field of ['input', 'result']) {
  const tampered = structuredClone(replay);
  if (field === 'input') tampered.input.sales[0].commissionBaseCents = 10001;
  else tampered.result.employees[0].amountCents = 2001;
  rejects(() => validateCalculatorReplay(tampered), 'checksum_mismatch', `${field} tampering is rejected before replay`);
  rejects(() => executeCalculatorReplay(tampered), 'checksum_mismatch');
}
const forgedResult = structuredClone(replay);
forgedResult.result.employees[0].amountCents = 2001;
forgedResult.resultSha256 = sha256(forgedResult.result);
assert.equal(validateCalculatorReplay(forgedResult).replayVerified, false);
assert.equal(executeCalculatorReplay(forgedResult).status, 'mismatch', 'recomputed checksum is insufficient to forge an engine result');
assert.equal(executeCalculatorReplay(forgedResult).replayVerified, false);
rejects(() => buildCalculatorReplay(fixture(), forgedResult.result), 'result_mismatch');
const wrongShape = structuredClone(replay);
wrongShape.result.currency = 'USD';
wrongShape.resultSha256 = sha256(wrongShape.result);
rejects(() => validateCalculatorReplay(wrongShape), 'result_invalid');
rejects(() => buildCalculatorReplay(fixture(), { ...replay.result, blockers: ['missing_source'] }), 'result_invalid');
for (const modify of [value => { value.unexpected = true; }, value => { delete value.encoding; },
  value => { value.schemaVersion = 2; }, value => { value.engineRevision = 'not-a-hash'; }]) {
  const invalid = structuredClone(replay); modify(invalid);
  rejects(() => validateCalculatorReplay(invalid), 'payload_invalid');
}

const unavailable = structuredClone(replay);
unavailable.engineRevision = replay.engineRevision === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64);
assert.equal(validateCalculatorReplay(unavailable).state, 'engine_unavailable');
const unavailableResult = executeCalculatorReplay(unavailable);
assert.equal(unavailableResult.compatible, false);
assert.equal(unavailableResult.status, 'engine_unavailable');
assert.equal(unavailableResult.replayVerified, false);
assert.equal(unavailableResult.result, null, 'a different engine is never silently substituted');
for (const missing of [undefined, null]) {
  assert.equal(validateCalculatorReplay(missing).state, 'not_recorded');
  assert.equal(validateCalculatorReplay(missing).saved, false);
  assert.equal(executeCalculatorReplay(missing).status, 'not_recorded');
  assert.equal(executeCalculatorReplay(missing).result, null);
}
const manifest = getCalculatorReplayEngineManifest();
assert.equal(manifest.engineRevision, replay.engineRevision);
assert.deepEqual(manifest.files.map(file => file.path), ['payroll-incentive-math.js', 'payroll-schemes.js']);
assertFrozenTree(manifest);

for (const context of [{ sourceEvidence: { ...replay.input.sourceEvidence, coverageRevision: 8 } },
  { schemeSnapshot: { ...replay.input.scheme, versionId: 'another-version' } }, { currency: 'USD' },
  { period: { from: '2026-09-01', to: '2026-09-02' } }, { result: forgedResult.result }]) {
  rejects(() => validateCalculatorReplay(replay, context), 'context_mismatch');
}
for (const context of [{ sourceWatermark: 'unrecognized-binding' }, { sourceManifest: {} }, [], null,
  { [Symbol('unknown')]: true }, Object.defineProperty({}, 'sourceEvidence', { get() { throw new Error('must not invoke'); } })]) {
  rejects(() => validateCalculatorReplay(replay, context), 'context_invalid', 'unknown or executable context cannot masquerade as an evidence binding');
}

for (const invalid of [NaN, Infinity, -Infinity, 1.1, Number.MAX_SAFE_INTEGER + 1, 1n, new Date(), /x/, new Map(),
  Object.create(null), () => true, Symbol('value'), [undefined], new Array(1)]) {
  const badInput = fixture(); badInput.sourceEvidence.invalid = invalid;
  rejects(() => buildCalculatorReplay(badInput, replay.result), 'json_value_invalid');
}
for (const evidence of [Object.defineProperty({}, 'getter', { enumerable: true, get() { throw new Error('must not execute'); } }),
  { [Symbol('key')]: 'value' }, Object.assign([], { extra: true })]) {
  const badInput = fixture(); badInput.sourceEvidence = evidence;
  rejects(() => buildCalculatorReplay(badInput, replay.result), 'json_value_invalid');
}
const cycle = fixture(); cycle.sourceEvidence.self = cycle.sourceEvidence;
rejects(() => buildCalculatorReplay(cycle, replay.result), 'json_cycle');
const deep = fixture(); let cursor = deep.sourceEvidence;
for (let i = 0; i < 65; i++) { cursor.child = {}; cursor = cursor.child; }
rejects(() => buildCalculatorReplay(deep, replay.result), 'structure_limit_exceeded');
const oversized = fixture(); oversized.sourceEvidence.note = 'я'.repeat(8 * 1024 * 1024);
rejects(() => buildCalculatorReplay(oversized, replay.result), 'payload_too_large', 'payload bound counts UTF-8 bytes');

for (const [from, to] of [['2026-02-30', '2026-02-30'], ['2026-09-02', '2026-09-01'],
  ['2026-09-30', '2026-10-01'], ['2026-9-01', '2026-09-01'], ['2026-09-01T00:00:00Z', '2026-09-01']]) {
  const badInput = fixture(); badInput.periodFrom = from; badInput.periodTo = to;
  rejects(() => buildCalculatorReplay(badInput, replay.result), 'input_invalid');
}
for (const [key, limit] of [['employees', 500], ['sales', 20000], ['attendance', 20000],
  ['roleAssignments', 15000], ['venueDailyTurnover', 31]]) {
  const badInput = fixture(); badInput[key] = Array.from({ length: limit + 1 }, () => ({}));
  rejects(() => buildCalculatorReplay(badInput, replay.result), 'input_limit_exceeded', `${key} bounded before engine execution`);
}
for (const key of ['employees', 'sales', 'roleAssignments']) {
  const badInput = fixture(); delete badInput[key];
  rejects(() => buildCalculatorReplay(badInput, replay.result), 'input_invalid');
}
for (const key of ['employeeOverrides', 'itemRules']) {
  const badInput = fixture(); badInput.scheme[key] = Array.from({ length: 15001 }, () => ({}));
  rejects(() => buildCalculatorReplay(badInput, replay.result), 'input_limit_exceeded');
}
console.log('PASS payroll-calculator-replay: full nonzero replay, immutable copies, tampering, incompatible/legacy engines, evidence bindings, safe JSON and bounds');
