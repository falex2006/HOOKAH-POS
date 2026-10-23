// Route contract for the owner-only calculation entry lifecycle endpoints.
// The router is real; service calls are recorded mocks. This is not DB acceptance.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { handlePayrollSchemeRoute } = require('../payroll-scheme-routes.js');
const ownerId = '10000000-0000-4000-8000-000000000001';
const venueId = '10000000-0000-4000-8000-000000000002';
const entryId = '10000000-0000-4000-8000-000000000003';
const principal = { userId: ownerId, venueId };
const calls = [];
const service = {
  async getCalculationEntryState(...args) { calls.push(['state', ...args]); return { sourceStatus: 'current', allowedActions: ['approve'] }; },
  async transitionCalculationEntry(...args) { calls.push(['transition', ...args]); return { action: args[2].action, replayed: false }; }
};
const responseFor = () => {
  const response = { status: null, body: null, headers: {}, setHeader(name, value) { this.headers[name] = value; } };
  return { response, json: (_res, status, body) => { response.status = status; response.body = body; } };
};
const requestFor = (method, pathname, patch = {}) => ({ method, url: pathname,
  user: { id: ownerId, venueId, role: 'owner' },
  headers: { host: 'crm.test', origin: 'https://crm.test', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', ...patch.headers },
  socket: { encrypted: true }, body: patch.body });
const dispatch = async (req, selectedService = service, bodyReader = async request => request.body || {}) => {
  const { response, json } = responseFor();
  const handled = await handlePayrollSchemeRoute({ req, res: response, url: new URL(req.url, 'https://crm.test'),
    service: selectedService, readBody: bodyReader, json });
  return { handled, ...response };
};
const command = { action: 'approve', expectedStateHash: 'a'.repeat(64), idempotencyKey: 'lifecycle-route-01',
  paymentDate: null, paymentAccountId: null, paymentMethod: null, reason: null };

let result = await dispatch(requestFor('GET', `/api/payroll/calculation-entries/${entryId}/state`));
assert.equal(result.handled, true); assert.equal(result.status, 200);
assert.deepEqual(calls.at(-1), ['state', principal, entryId]);

result = await dispatch(requestFor('POST', `/api/payroll/calculation-entries/${entryId}/transition`, { body: command }));
assert.equal(result.status, 200); assert.deepEqual(calls.at(-1), ['transition', principal, entryId, command]);

const priorCalls = calls.length;
result = await dispatch(requestFor('GET', `/api/payroll/calculation-entries/${entryId}/state?venueId=${venueId}`));
assert.equal(result.status, 400); assert.equal(calls.length, priorCalls, 'query parameters are rejected before service access');
result = await dispatch(requestFor('GET', '/api/payroll/calculation-entries/nope/state'));
assert.equal(result.status, 400); assert.equal(calls.length, priorCalls, 'malformed entry ids are rejected before service access');
result = await dispatch(requestFor('POST', `/api/payroll/calculation-entries/${entryId}/transition`, { headers: { origin: 'https://evil.test' }, body: command }));
assert.equal(result.status, 403); assert.equal(calls.length, priorCalls, 'CSRF origin is checked before transition service access');
result = await dispatch(requestFor('PUT', `/api/payroll/calculation-entries/${entryId}/transition`, { body: command }));
assert.equal(result.status, 405); assert.equal(result.headers.Allow, 'POST');
result = await dispatch(requestFor('POST', `/api/payroll/calculation-entries/${entryId}/transition`, { headers: { 'content-type': 'text/plain' }, body: command }));
assert.equal(result.status, 415); assert.equal(result.body.error, 'json_content_type_required');
result = await dispatch({ ...requestFor('GET', `/api/payroll/calculation-entries/${entryId}/state`), user: { id: ownerId, venueId, role: 'manager' } });
assert.equal(result.status, 403); assert.equal(calls.length, priorCalls, 'non-owners cannot access lifecycle service');
result = await dispatch(requestFor('POST', `/api/payroll/calculation-entries/${entryId}/transition`, { body: { ...command, extra: true } }));
assert.equal(result.status, 400); assert.equal(calls.length, priorCalls, 'unknown command properties are rejected');
const getterBody = Object.defineProperties({}, { ...Object.fromEntries(Object.entries(command).map(([key, value]) => [key, { enumerable: true, get: () => value }])) });
result = await dispatch(requestFor('POST', `/api/payroll/calculation-entries/${entryId}/transition`, { body: getterBody }));
assert.equal(result.status, 400); assert.equal(calls.length, priorCalls, 'accessor-backed command properties are rejected');
result = await dispatch(requestFor('GET', `/api/payroll/calculation-entries/${entryId}/state`), {
  ...service, async getCalculationEntryState() { throw new Error('private database detail'); }
});
assert.equal(result.status, 503); assert.deepEqual(result.body, { error: 'payroll_entry_lifecycle_unavailable' });

const { makeService } = require('../payroll-scheme-service.js');
const serviceSurface = makeService({ query: async () => ({ rows: [] }), connect: async () => { throw new Error('not invoked in route contract'); } });
assert.equal(typeof serviceSurface.getCalculationEntryState, 'function');
assert.equal(typeof serviceSurface.transitionCalculationEntry, 'function');

// Exercise the actual service transaction/error mapping without PostgreSQL:
// real fence + owner lookup + rollback, with the lifecycle DB call faulted at its seam.
const lifecycle = require('../payroll-calculation-entry-lifecycle.js');
const originalTransition = lifecycle.transitionPayrollCalculationEntry;
const transactionCalls = [];
const dbFailurePool = { async query() { return { rows: [] }; }, async connect() {
  return { async query(sql) {
    const text = String(sql).replace(/\s+/g, ' ').trim(); transactionCalls.push(text);
    if (text.startsWith('SELECT pg_advisory_lock(')) return { rows: [] };
    if (text.startsWith('SELECT pg_advisory_unlock(')) return { rows: [{ unlocked: true }] };
    if (text === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ WRITE' || text === 'ROLLBACK' || text === 'COMMIT') return { rows: [] };
    if (text.startsWith('SELECT id, full_name AS name FROM users')) return { rows: [{ id: ownerId, name: 'Owner Test' }] };
    assert.fail(`Unexpected service SQL in mapping seam: ${text}`);
  }, release(error) { transactionCalls.push(error ? `release:${error.code}` : 'release'); } };
} };
try {
  for (const pgCode of ['23514', '23503', '55000']) {
    lifecycle.transitionPayrollCalculationEntry = async () => {
      throw Object.assign(new Error('private database detail'), { code: pgCode });
    };
    const realService = makeService(dbFailurePool);
    result = await dispatch(requestFor('POST', `/api/payroll/calculation-entries/${entryId}/transition`, { body: command }), realService);
    assert.equal(result.status, 409, `${pgCode} is a rejected lifecycle transaction`);
    assert.deepEqual(result.body, { error: 'payroll_entry_lifecycle_rejected' });
    assert.ok(transactionCalls.includes('ROLLBACK'), `${pgCode} rolls back the fenced transaction`);
    assert.ok(transactionCalls.includes('SELECT pg_advisory_unlock(hashtextextended($1,0)) AS unlocked'), `${pgCode} releases the fence`);
  }
} finally { lifecycle.transitionPayrollCalculationEntry = originalTransition; }
console.log('PASS payroll calculation entry lifecycle routes contract: owner, CSRF, strict path/query/body, service wiring, sanitized failure');
