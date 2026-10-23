'use strict';

// Engine replay only. The caller still owns source attestation, authorization,
// storage and lifecycle. Never accept a browser payload as official evidence.
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { calculatePayrollScheme } = require('./payroll-schemes');
const ENCODING = 'canonical-json-safe-integers-v1';
const MAX_BYTES = 16 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;
class PayrollCalculatorReplayError extends Error {
  constructor(code) { super(`payroll_calculator_replay_${code}`); this.name = 'PayrollCalculatorReplayError';
    this.code = this.message; this.status = 409; }
}
const fail = code => { throw new PayrollCalculatorReplayError(code); };
const plain = value => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
const hash = text => createHash('sha256').update(text, 'utf8').digest('hex');
const freeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
// Deliberately independent of legacy source/result watermarks. Undefined object
// fields are omitted; undefined/sparse array entries and non-JSON types fail.
const normalize = input => {
  const active = new WeakSet();
  let bytes = 0, nodes = 0;
  const account = text => { bytes += Buffer.byteLength(text, 'utf8'); if (bytes > MAX_BYTES) fail('payload_too_large'); return text; };
  const walk = (value, depth) => {
    if (++nodes > 1000000 || depth > 64) fail('structure_limit_exceeded');
    if (value === null || typeof value === 'string' || typeof value === 'boolean') {
      return { value, text: account(JSON.stringify(value)) };
    }
    if (typeof value === 'number') {
      if (!Number.isSafeInteger(value)) fail('json_value_invalid');
      return { value: Object.is(value, -0) ? 0 : value, text: account(JSON.stringify(value)) };
    }
    if (!Array.isArray(value) && !plain(value)) fail('json_value_invalid');
    if (active.has(value)) fail('json_cycle');
    active.add(value);
    const keys = Reflect.ownKeys(value);
    if (keys.some(key => typeof key !== 'string')
        || Object.values(Object.getOwnPropertyDescriptors(value)).some(d => !Object.hasOwn(d, 'value'))) fail('json_value_invalid');
    let result;
    if (Array.isArray(value)) {
      if (keys.length !== value.length + 1 || keys.some(key => key !== 'length' && !/^(0|[1-9][0-9]*)$/.test(key))) fail('json_value_invalid');
      account('[]'); const entries = [];
      for (let i = 0; i < value.length; i++) {
        if (!Object.hasOwn(value, i)) fail('json_value_invalid');
        if (i) account(',');
        entries.push(walk(value[i], depth + 1));
      }
      result = { value: entries.map(entry => entry.value), text: `[${entries.map(entry => entry.text).join(',')}]` };
    } else {
      account('{}'); const object = {}, parts = [];
      for (const key of keys.sort()) {
        if (value[key] === undefined) continue;
        if (parts.length) account(',');
        const prefix = account(`${JSON.stringify(key)}:`), entry = walk(value[key], depth + 1);
        Object.defineProperty(object, key, { value: entry.value, enumerable: true, configurable: true, writable: true });
        parts.push(prefix + entry.text);
      }
      result = { value: object, text: `{${parts.join(',')}}` };
    }
    active.delete(value);
    return result;
  };
  return walk(input, 0);
};
const sourceManifest = freeze({
  schemaVersion: 1, encoding: ENCODING, sourceNormalization: 'utf8-bom-stripped-crlf-to-lf-v1',
  files: ['payroll-schemes.js', 'payroll-incentive-math.js'].sort().map(file => ({
    path: file, sha256: hash(readFileSync(path.join(__dirname, file), 'utf8').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n'))
  }))
});
// Capture once at module initialization, matching the process's loaded engine.
// Deploy/restart the process when changing either implementation file.
const ENGINE_REVISION = hash(normalize(sourceManifest).text);
const getCalculatorReplayEngineManifest = () => freeze({ engineRevision: ENGINE_REVISION, ...structuredClone(sourceManifest) });
const equal = (a, b) => normalize(a).text === normalize(b).text;
const dateValid = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const inputBounds = input => {
  if (!plain(input) || !plain(input.scheme) || !dateValid(input.periodFrom) || !dateValid(input.periodTo)
      || input.periodFrom > input.periodTo || input.periodFrom.slice(0, 7) !== input.periodTo.slice(0, 7)) fail('input_invalid');
  for (const [key, limit, required] of [['employees', 500, true], ['sales', 20000, true], ['attendance', 20000, false],
    ['roleAssignments', 15000, true], ['venueDailyTurnover', 31, false]]) {
    if (input[key] === undefined && !required) continue;
    if (!Array.isArray(input[key])) fail('input_invalid');
    if (input[key].length > limit) fail('input_limit_exceeded');
  }
  for (const key of ['employeeOverrides', 'itemRules']) {
    if (input.scheme[key] !== undefined && (!Array.isArray(input.scheme[key]) || input.scheme[key].length > 15000)) fail('input_limit_exceeded');
  }
};
const resultValid = (input, result) => {
  if (!plain(result) || result.status !== 'ready' || !Array.isArray(result.blockers) || result.blockers.length
      || !Array.isArray(result.criticalErrors) || result.criticalErrors.length || !Array.isArray(result.daily)
      || !Array.isArray(result.employees) || result.schemeId !== input.scheme.id
      || result.schemeVersionId !== input.scheme.versionId || result.mode !== input.scheme.mode
      || result.periodFrom !== input.periodFrom || result.periodTo !== input.periodTo
      || result.currency !== (input.scheme.currency || 'RUB')) fail('result_invalid');
};
const contextValid = (replay, context) => {
  if (!plain(context) || Reflect.ownKeys(context).some(key => !['schemeSnapshot', 'sourceEvidence', 'period', 'currency', 'result'].includes(key))
      || Object.values(Object.getOwnPropertyDescriptors(context)).some(d => !Object.hasOwn(d, 'value'))) fail('context_invalid');
  for (const [key, actual] of [['schemeSnapshot', replay.input.scheme], ['sourceEvidence', replay.input.sourceEvidence], ['result', replay.result]]) {
    if (Object.hasOwn(context, key) && !equal(context[key], actual)) fail('context_mismatch');
  }
  if (Object.hasOwn(context, 'currency') && context.currency !== replay.result.currency) fail('context_mismatch');
  if (Object.hasOwn(context, 'period') && (!plain(context.period) || context.period.from !== replay.input.periodFrom
      || context.period.to !== replay.input.periodTo)) fail('context_mismatch');
};
const inspect = (value, context = {}) => {
  if (value === undefined || value === null) return { replay: null,
    metadata: { state: 'not_recorded', saved: false, compatible: false, replayVerified: false, engineRevision: null, inputSha256: null, resultSha256: null } };
  const replay = normalize(value).value;
  const keys = ['schemaVersion', 'encoding', 'engineRevision', 'input', 'result', 'inputSha256', 'resultSha256'];
  if (!plain(replay) || Object.keys(replay).length !== keys.length || keys.some(key => !Object.hasOwn(replay, key))
      || replay.schemaVersion !== 1 || replay.encoding !== ENCODING
      || !HASH.test(replay.engineRevision || '') || !HASH.test(replay.inputSha256 || '') || !HASH.test(replay.resultSha256 || '')) fail('payload_invalid');
  if (hash(normalize(replay.input).text) !== replay.inputSha256 || hash(normalize(replay.result).text) !== replay.resultSha256) fail('checksum_mismatch');
  inputBounds(replay.input); resultValid(replay.input, replay.result); contextValid(replay, context);
  const compatible = replay.engineRevision === ENGINE_REVISION;
  return { replay, metadata: { state: compatible ? 'available' : 'engine_unavailable', saved: true, compatible,
    replayVerified: false, engineRevision: replay.engineRevision, inputSha256: replay.inputSha256, resultSha256: replay.resultSha256 } };
};
const validateCalculatorReplay = (replay, context = {}) => freeze(inspect(replay, context).metadata);
const calculate = input => {
  try { return calculatePayrollScheme(input); }
  catch (_) { fail('execution_failed'); }
};
const buildCalculatorReplay = (input, result) => {
  const normalizedInput = normalize(input), normalizedResult = normalize(result);
  inputBounds(normalizedInput.value); resultValid(normalizedInput.value, normalizedResult.value);
  const repeated = normalize(calculate(normalizedInput.value));
  if (repeated.text !== normalizedResult.text) fail('result_mismatch');
  const replay = { schemaVersion: 1, encoding: ENCODING, engineRevision: ENGINE_REVISION,
    input: normalizedInput.value, result: normalizedResult.value,
    inputSha256: hash(normalizedInput.text), resultSha256: hash(normalizedResult.text) };
  normalize(replay); // enforce a combined payload budget, including metadata
  return freeze(replay);
};
const executeCalculatorReplay = value => {
  const { replay, metadata } = inspect(value);
  if (!metadata.compatible) return freeze({ ...metadata, status: metadata.state, matched: false, result: null });
  const result = normalize(calculate(replay.input)), resultSha256 = hash(result.text);
  const matched = resultSha256 === replay.resultSha256;
  return freeze({ ...metadata, status: matched ? 'matched' : 'mismatch', matched, replayVerified: matched,
    result: result.value, expectedResultSha256: replay.resultSha256, resultSha256 });
};
module.exports = { PayrollCalculatorReplayError, buildCalculatorReplay, validateCalculatorReplay, executeCalculatorReplay,
  getCalculatorReplayEngineManifest };
