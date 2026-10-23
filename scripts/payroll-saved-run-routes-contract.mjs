import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// Actual router with fake service. This proves HTTP dispatch/guards, not stored
// evidence integrity, database tenant isolation, or successful source collection.
const require = createRequire(import.meta.url);
const { handlePayrollSchemeRoute } = require('../payroll-scheme-routes.js');
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const userId = uuid(1), venueId = uuid(2), versionId = uuid(3);
const runId = uuid(4), employeeId = uuid(5), snapshotId = uuid(6);
const principal = { userId, venueId };
const base = '/api/payroll/calculation-runs';
const paths = [base, `${base}/${runId}`, `${base}/${runId}/employees/${employeeId}`, `${base}/${runId}/days/${snapshotId}/lines`];
const input = { schemeVersionId: versionId, periodFrom: '2026-10-01', periodTo: '2026-10-20', idempotencyKey: 'saved-run:route-contract' };
const ready = { status: 'ready', runId, amountCents: 1000, replayed: false, officialReady: false, payoutEligible: false, persistence: 'snapshots' };
const calls = [];
let outcome = ready, failure = null, bodyReads = 0;
const service = Object.fromEntries(['createVerifiedRun', 'listSavedRuns', 'getSavedRun', 'getSavedRunEmployee', 'getSavedRunLines', 'replaySavedRun', 'checkSavedRunFreshness'].map(name =>
  [name, async (...args) => { calls.push([name, ...args]); if (failure) throw failure; return outcome; }]));
const request = (method, url, overrides = {}) => ({
  method, url, user: { id: userId, venueId, role: 'owner' }, body: input,
  socket: { encrypted: true }, ...overrides,
  headers: { host: 'crm.example.test', origin: 'https://crm.example.test', 'sec-fetch-site': 'same-origin',
    'content-type': 'application/json', ...overrides.headers }
});
const dispatch = async (req, options = {}) => {
  const response = { status: null, body: null, headers: {} };
  const res = { setHeader: (key, value) => { response.headers[key] = value; } };
  const handled = await handlePayrollSchemeRoute({
    req, res, url: new URL(req.url, 'https://crm.example.test'),
    service: Object.hasOwn(options, 'service') ? options.service : service,
    readBody: options.readBody || (async request => { bodyReads++; return request.body; }),
    json: (_res, status, body) => { response.status = status; response.body = body; }
  });
  return { handled, ...response };
};
const rejected = async (req, status, code, options) => {
  const before = calls.length, reads = bodyReads;
  const result = await dispatch(req, options);
  assert.equal(result.handled, true);
  assert.equal(result.status, status, `${req.method} ${req.url}`);
  assert.deepEqual(result.body, { error: code });
  assert.equal(calls.length, before, 'rejected request must not invoke service');
  return { result, reads };
};

let result = await dispatch(request('POST', base));
assert.equal(result.status, 201);
assert.equal(result.body, ready);
assert.deepEqual(calls.at(-1), ['createVerifiedRun', principal, input]);
for (const [response, status] of [
  [{ ...ready, replayed: true }, 200],
  [{ status: 'blocked', reasons: ['source_missing'], replayed: false, officialReady: false, payoutEligible: false, persistence: 'none' }, 422]
]) {
  outcome = response;
  result = await dispatch(request('POST', base));
  assert.equal(result.status, status);
  assert.equal(result.body, response, 'router must preserve blocked and payout flags');
}
outcome = { items: [], nextCursor: null, officialReady: false, payoutEligible: false };
for (const [url, expected] of [
  [`${base}?schemeVersionId=${versionId}&limit=5&cursor=opaque`, ['listSavedRuns', principal, { schemeVersionId: versionId, limit: '5', cursor: 'opaque' }]],
  [`${paths[1]}?limit=7&cursor=next`, ['getSavedRun', principal, runId, { limit: '7', cursor: 'next' }]],
  [paths[2], ['getSavedRunEmployee', principal, runId, employeeId]],
  [`${paths[3]}?limit=9&cursor=line`, ['getSavedRunLines', principal, runId, snapshotId, { limit: '9', cursor: 'line' }]]
]) {
  const reads = bodyReads;
  result = await dispatch(request('GET', url));
  assert.equal(result.status, 200); assert.equal(result.body, outcome);
  assert.deepEqual(calls.at(-1), expected);
  assert.equal(bodyReads, reads, 'GET must not read body');
}
for (const path of [base, paths[1], paths[3]]) {
  await dispatch(request('GET', path));
  assert.deepEqual(calls.at(-1).at(-1), {}, 'optional query defaults to empty object');
}

// Every operation authenticates and rejects non-owner or malformed principals.
for (const [method, path] of [['POST', base], ...paths.map(path => ['GET', path])]) {
  for (const [user, status, code] of [
    [null, 401, 'authentication_required'],
    [{ id: userId, venueId, role: 'manager' }, 403, 'payroll_scheme_owner_only'],
    [{ id: userId, venueId, role: 'employee' }, 403, 'payroll_scheme_owner_only'],
    [{ id: 'bad', venueId, role: 'owner' }, 403, 'payroll_scheme_owner_only'],
    [{ id: userId, venueId: 'bad', role: 'owner' }, 403, 'payroll_scheme_owner_only'],
    [{ id: userId, role: 'owner' }, 403, 'payroll_scheme_owner_only']
  ]) {
    const { reads } = await rejected(request(method, path, { user }), status, code);
    assert.equal(bodyReads, reads, 'auth guard precedes body parsing');
  }
}
// Body cannot replace session principal; strict body-key validation belongs to
// createVerifiedRun and is covered by its separate service contract.
const spoofedBody = { ...input, userId: uuid(11), venueId: uuid(12) };
await dispatch(request('POST', base, { body: spoofedBody }));
assert.deepEqual(calls.at(-1), ['createVerifiedRun', principal, spoofedBody]);
await dispatch(request('GET', base, { user: { id: uuid(21), venueId: uuid(22), role: 'owner', userId: userId } }));
assert.deepEqual(calls.at(-1), ['listSavedRuns', { userId: uuid(21), venueId: uuid(22) }, {}]);

for (const path of paths) {
  for (const key of ['venueId', 'userId', 'employeeId', 'includeEvidence', '__proto__', 'unknown']) {
    await rejected(request('GET', `${path}?${key}=x`), 400, 'invalid_payroll_saved_run_request');
  }
  for (const key of (path === base ? ['schemeVersionId', 'limit', 'cursor'] : path === paths[2] ? [] : ['limit', 'cursor'])) {
    await rejected(request('GET', `${path}?${key}=a&${key}=b`), 400, 'invalid_payroll_saved_run_request');
  }
}
await rejected(request('GET', `${base}?limit=1&%6cimit=2`), 400, 'invalid_payroll_saved_run_request');
await rejected(request('GET', `${paths[2]}?limit=1`), 400, 'invalid_payroll_saved_run_request');
for (const query of ['limit=1', `schemeVersionId=${versionId}`, 'cursor=x', 'venueId=x']) {
  const { reads } = await rejected(request('POST', `${base}?${query}`), 400, 'invalid_payroll_saved_run_request');
  assert.equal(bodyReads, reads, 'POST query rejected before body parsing');
}
for (const bad of ['bad', '%ZZ', '%2F', '00000000-0000-0000-0000-000000000000']) {
  for (const path of [`${base}/${bad}`, `${base}/${bad}/employees/${employeeId}`, `${base}/${runId}/employees/${bad}`, `${base}/${runId}/days/${bad}/lines`]) {
    await rejected(request('GET', path), 400, 'invalid_payroll_saved_run_request');
  }
}
await dispatch(request('GET', `${base}/${runId.replace(/^0/, '%30')}`));
assert.deepEqual(calls.at(-1), ['getSavedRun', principal, runId, {}], 'valid encoded identifier is decoded');
for (const path of [`${base}/`, `${paths[2]}/lines`, `${base}/${runId}/days/${snapshotId}`, `${paths[3]}/extra`]) {
  const before = calls.length;
  result = await dispatch(request('GET', path));
  assert.equal(result.handled, false); assert.equal(calls.length, before);
}
for (const path of paths) {
  for (const method of ['PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', ...(path === base ? [] : ['POST'])]) {
    const { result, reads } = await rejected(request(method, path), 405, 'method_not_allowed');
    assert.equal(result.headers.Allow, path === base ? 'GET, POST' : 'GET');
    assert.equal(bodyReads, reads);
  }
}
await rejected(request('GET', base), 503, 'payroll_scheme_database_required', { service: null });

for (const headers of [
  { origin: '' }, { origin: 'https://evil.example.test' }, { origin: 'http://crm.example.test' },
  { origin: 'malformed' }, { 'sec-fetch-site': 'cross-site' }, { host: '' }
]) {
  const { reads } = await rejected(request('POST', base, { headers }), 403, 'same_origin_required');
  assert.equal(bodyReads, reads, 'CSRF guard precedes body parsing');
}
for (const contentType of ['', 'text/plain', 'application/x-www-form-urlencoded']) {
  const { reads } = await rejected(request('POST', base, { headers: { 'content-type': contentType } }), 415, 'json_content_type_required');
  assert.equal(bodyReads, reads);
}
outcome = ready;
result = await dispatch(request('POST', base, { headers: { 'content-type': 'Application/JSON; charset=utf-8' } }));
assert.equal(result.status, 201);
result = await dispatch(request('POST', base, { headers: { authorization: 'Bearer authenticated-upstream', origin: '', 'sec-fetch-site': '' } }));
assert.equal(result.status, 201, 'existing upstream-authenticated bearer contract remains supported');
for (const body of [null, [], 'text', 5, false]) {
  await rejected(request('POST', base, { body }), 400, 'invalid_json_body');
}
for (const [error, status, code] of [
  [new SyntaxError('private parse details'), 400, 'invalid_json_body'],
  [Object.assign(new Error('private payload details'), { code: 'payload_too_large' }), 413, 'payload_too_large'],
  [new Error('private read details'), 400, 'invalid_json_body']
]) {
  await rejected(request('POST', base), status, code, { readBody: async () => { throw error; } });
}
// Service errors carry only validated public codes, never SQL/evidence details.
for (const [error, status, code] of [
  [Object.assign(new Error('private evidence mismatch'), { status: 409, code: 'payroll_saved_run_evidence_invalid' }), 409, 'payroll_saved_run_evidence_invalid'],
  [Object.assign(new Error('cross-tenant existence'), { status: 404, code: 'payroll_saved_run_not_found' }), 404, 'payroll_saved_run_not_found'],
  [Object.assign(new Error('DB owner revoked'), { status: 403, code: 'payroll_scheme_owner_only' }), 403, 'payroll_scheme_owner_only'],
  [Object.assign(new Error('private SQL'), { status: 500, code: 'SQL ERROR: secret' }), 503, 'payroll_scheme_unavailable'],
  [new Error('private connection details'), 503, 'payroll_scheme_unavailable']
]) {
  failure = error;
  for (const [method, path] of [['POST', base], ...paths.map(path => ['GET', path])]) {
    result = await dispatch(request(method, path));
    assert.equal(result.status, status);
    assert.deepEqual(result.body, { error: code });
  }
}
failure = null;
const replayPath = `${base}/${runId}/replay`;
result = await dispatch(request('POST', replayPath, { body: {} }));
assert.equal(result.status, 200);
assert.deepEqual(calls.at(-1), ['replaySavedRun', principal, runId]);
await rejected(request('POST', replayPath, { body: { input: {} } }), 400, 'invalid_payroll_saved_run_request');
await rejected(request('POST', `${replayPath}?limit=1`, { body: {} }), 400, 'invalid_payroll_saved_run_request');
await rejected(request('POST', `${base}/bad/replay`, { body: {} }), 400, 'invalid_payroll_saved_run_request');
await rejected(request('POST', replayPath, { user: null, body: {} }), 401, 'authentication_required');
await rejected(request('POST', replayPath, { user: { id: userId, venueId, role: 'manager' }, body: {} }), 403, 'payroll_scheme_owner_only');
await rejected(request('POST', replayPath, { headers: { origin: 'https://other.example' }, body: {} }), 403, 'same_origin_required');
for (const method of ['GET', 'PUT', 'DELETE']) {
  const { result: denied } = await rejected(request(method, replayPath), 405, 'method_not_allowed');
  assert.equal(denied.headers.Allow, 'POST');
}
const freshnessPath = `${base}/${runId}/freshness`;
for (const status of ['current', 'stale', 'blocked']) {
  outcome = { status, officialReady: false, payoutEligible: false, persistence: 'none' };
  result = await dispatch(request('POST', freshnessPath, { body: {} }));
  assert.equal(result.status, 200); assert.equal(result.body, outcome);
  assert.deepEqual(calls.at(-1), ['checkSavedRunFreshness', principal, runId]);
}
await rejected(request('POST', freshnessPath, { body: { sourceChanged: false } }), 400, 'invalid_payroll_saved_run_request');
await rejected(request('POST', `${freshnessPath}?venueId=${venueId}`, { body: {} }), 400, 'invalid_payroll_saved_run_request');
await rejected(request('POST', `${base}/bad/freshness`, { body: {} }), 400, 'invalid_payroll_saved_run_request');
await rejected(request('POST', freshnessPath, { user: null, body: {} }), 401, 'authentication_required');
await rejected(request('POST', freshnessPath, { user: { id: userId, venueId, role: 'manager' }, body: {} }), 403, 'payroll_scheme_owner_only');
await rejected(request('POST', freshnessPath, { headers: { origin: 'https://other.example' }, body: {} }), 403, 'same_origin_required');
await rejected(request('POST', freshnessPath, { headers: { 'content-type': 'text/plain' }, body: {} }), 415, 'json_content_type_required');
for (const method of ['GET', 'PUT', 'PATCH', 'DELETE']) {
  const { result: denied } = await rejected(request(method, freshnessPath), 405, 'method_not_allowed');
  assert.equal(denied.headers.Allow, 'POST');
}
console.log('PASS payroll saved-run routes: actual handler, source freshness and replay, owner/session tenant, JSON/CSRF, strict query/UUID guards and public errors (fake service only).');
