import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { handlePayrollSchemeRoute } = require('../payroll-scheme-routes');
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', venueId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const principal = { userId: id, venueId }, calls = [];
let replayed = false, blocked = false;
const service = Object.fromEntries(['createRefundAwareRun', 'createVerifiedRun', 'getRefundAwareCorrectionContext',
  'previewRefundAwareCorrection', 'applyRefundAwareCorrection', 'getReviewedCorrectionContext', 'previewReviewedCorrection',
  'applyReviewedCorrection'].map(name => [name, async (...args) => {
    calls.push([name, ...args]); return { status: blocked ? 'blocked' : 'ready', replayed };
  }]));
const create = { schemeVersionId: id, periodFrom: '2026-09-01', periodTo: '2026-09-30', idempotencyKey: 'refund-run:contract' };
const preview = { operation: 'apply', originalEntryId: id, targetEntryId: venueId };
const commit = { ...preview, expectedPlanHash: 'a'.repeat(64), reason: 'Владелец проверил весь период', idempotencyKey: 'refund-correction:contract' };
const routes = [
  ['/api/payroll/refund-aware-calculation-runs', 'POST', create, 'createRefundAwareRun', 201],
  [`/api/payroll/calculation-entries/${id}/refund-aware-corrections`, 'GET', null, 'getRefundAwareCorrectionContext', 200],
  ['/api/payroll/refund-aware-corrections/preview', 'POST', preview, 'previewRefundAwareCorrection', 200],
  ['/api/payroll/refund-aware-corrections', 'POST', commit, 'applyRefundAwareCorrection', 201]
];
async function dispatch(path, method, body, changes = {}) {
  const req = { method, user: { id, venueId, role: 'owner' }, headers: { host: 'local.test', origin: 'https://local.test',
    'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }, socket: { encrypted: true }, ...changes };
  const res = { setHeader(key, value) { this[key] = value; } };
  const handled = await handlePayrollSchemeRoute({ req, res, service, url: new URL(path, 'https://local.test'),
    readBody: async () => body, json: (_, status, data) => Object.assign(res, { status, data }) });
  return { handled, ...res };
}
for (const [path, method, body, name, status] of routes) {
  assert.equal((await dispatch(path, method, body)).status, status);
  assert.deepEqual(calls.at(-1), [name, principal, body || id]);
  const count = calls.length;
  assert.equal((await dispatch(path, method, body, { user: null })).status, 401);
  for (const role of ['manager', 'bartender', 'admin']) assert.equal((await dispatch(path, method, body, { user: { id, venueId, role } })).status, 403);
  for (const verb of ['GET', 'POST', 'PUT', 'DELETE'].filter(verb => verb !== method)) assert.equal((await dispatch(path, verb, body)).status, 405);
  assert.equal((await dispatch(`${path}?venueId=${venueId}`, method, body)).status, 400);
  if (method === 'POST') {
    assert.equal((await dispatch(path, method, body, { headers: { host: 'local.test', origin: 'https://foreign.test', 'content-type': 'application/json' } })).status, 403);
    for (const invalid of [[], null, {}, { ...body, sourceBundle: {} }, { ...body, claimId: id }]) assert.equal((await dispatch(path, method, invalid)).status, 400);
  }
  assert.equal(calls.length, count, 'rejected requests cannot reach monetary/source service');
}
replayed = true;
assert.equal((await dispatch(routes[0][0], 'POST', create)).status, 200);
assert.equal((await dispatch(routes[3][0], 'POST', commit)).status, 200);
blocked = true;
assert.equal((await dispatch(routes[0][0], 'POST', create)).status, 422);
blocked = false;
await dispatch('/api/payroll/calculation-runs', 'POST', create);
assert.equal(calls.at(-1)[0], 'createVerifiedRun');
await dispatch(`/api/payroll/calculation-entries/${id}/corrections`, 'GET', null);
assert.equal(calls.at(-1)[0], 'getReviewedCorrectionContext');
await dispatch('/api/payroll/reviewed-corrections/preview', 'POST', preview);
assert.equal(calls.at(-1)[0], 'previewReviewedCorrection');
await dispatch('/api/payroll/reviewed-corrections', 'POST', commit);
assert.equal(calls.at(-1)[0], 'applyReviewedCorrection');
console.log('PASS explicit refund-aware routes: exact bodies, owner/tenant input/CSRF/method boundaries, blocked/replay status and legacy service isolation');
