import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { handlePayrollSchemeRoute } = require('../payroll-scheme-routes');
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const principal = { userId: uuid(1), venueId: uuid(2) }, runId = uuid(3), caseId = uuid(4);
const paths = [`/api/payroll/calculation-runs/${runId}/refund-reviews`, '/api/payroll/refund-reviews',
  `/api/payroll/refund-reviews/${caseId}`, `/api/payroll/refund-reviews/${caseId}/decisions`];
const bodies = [{ idempotencyKey: 'review-route-contract' }, null, null,
  { decision: 'hold_for_review', reason: 'Review needed', expectedAssessmentHash: 'a'.repeat(64), idempotencyKey: 'decision-route-contract' }];
const methods = ['POST', 'GET', 'GET', 'POST'];
const names = ['createRefundReview', 'listRefundReviews', 'getRefundReview', 'decideRefundReview'];
const calls = [];
let replayed = false, failure = null;
const service = Object.fromEntries(names.map(name => [name, async (...args) => {
  calls.push([name, ...args]); if (failure) throw failure; return { caseId, replayed, officialReady: false, payoutEligible: false };
}]));
const invoke = async (index, options = {}) => {
  const req = { method: methods[index], user: { id: principal.userId, venueId: principal.venueId, role: 'owner' },
    headers: { host: 'test.local', origin: 'https://test.local', 'content-type': 'application/json' }, socket: { encrypted: true }, ...options };
  const result = { headers: {}, reads: 0 };
  result.handled = await handlePayrollSchemeRoute({ req, res: { setHeader: (k,v) => { result.headers[k] = v; } },
    url: new URL(options.path || paths[index], 'https://test.local'), service,
    readBody: async () => { result.reads++; return Object.hasOwn(options, 'body') ? options.body : bodies[index]; },
    json: (_,status,body) => Object.assign(result, { status, body }) });
  return result;
};
for (let i = 0; i < 4; i++) {
  const response = await invoke(i);
  assert.equal(response.handled, true); assert.equal(response.status, methods[i] === 'POST' ? 201 : 200);
  assert.equal(calls.at(-1)[0], names[i]); assert.deepEqual(calls.at(-1)[1], principal);
  for (const user of [null, { id: principal.userId, venueId: principal.venueId, role: 'manager' }]) {
    const before = calls.length, denied = await invoke(i, { user });
    assert.equal(denied.status, user ? 403 : 401); assert.equal(denied.reads, 0); assert.equal(calls.length, before);
  }
  for (const method of ['PUT', 'DELETE', 'PATCH', methods[i] === 'GET' ? 'POST' : 'GET']) {
    const response = await invoke(i, { method });
    assert.equal(response.status, 405); assert.equal(response.headers.Allow, methods[i]);
  }
  assert.equal((await invoke(i, { path: paths[i] + '?venueId=forged' })).status, 400);
}
await invoke(1, { path: `${paths[1]}?runId=${runId}&limit=5&cursor=opaque` });
assert.deepEqual(calls.at(-1), ['listRefundReviews', principal, { runId, limit: '5', cursor: 'opaque' }]);
assert.equal((await invoke(1, { path: paths[1] + '?limit=1&limit=2' })).status, 400);
for (const index of [0,3]) {
  assert.equal((await invoke(index, { headers: { host: 'test.local', origin: 'https://evil.test', 'content-type': 'application/json' } })).status, 403);
  assert.equal((await invoke(index, { headers: { authorization: 'Bearer session', 'content-type': 'text/plain' } })).status, 415);
  for (const body of [null, [], {}, { ...bodies[index], amountCents: -100 }, { ...bodies[index], venueId: uuid(9) }]) {
    const before = calls.length;
    assert.equal((await invoke(index, { body })).status, 400); assert.equal(calls.length, before);
  }
  replayed = true; assert.equal((await invoke(index)).status, 200); replayed = false;
}
for (const index of [0,2,3]) assert.equal((await invoke(index, { path: paths[index].replace(index === 0 ? runId : caseId, 'bad') })).status, 400);
failure = Object.assign(new Error('private SQL'), { status: 409, code: 'payroll_refund_review_stale', detail: 'secret' });
assert.deepEqual((await invoke(3)).body, { error: 'payroll_refund_review_stale' });
failure = new Error('private SQL');
assert.deepEqual((await invoke(3)).body, { error: 'payroll_scheme_unavailable' });
console.log('PASS payroll-refund-review-routes-contract: real router dispatch and guards; mocked service, no DB proof');
