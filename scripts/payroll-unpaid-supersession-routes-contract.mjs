import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { handlePayrollSchemeRoute } = require('../payroll-scheme-routes');
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const venueId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const prefix = `/api/payroll/calculation-runs/${id}/supersession`;
const command = { expectedPlanHash: 'a'.repeat(64), reason: 'Владелец подтвердил пересчёт', idempotencyKey: 'supersession:route-contract' };
const calls = [];
let replayed = false, failure = null;
const service = {
  async previewUnpaidRunSupersession(...args) { calls.push(['preview', ...args]); if (failure) throw failure; return { planHash: command.expectedPlanHash }; },
  async commitUnpaidRunSupersession(...args) { calls.push(['commit', ...args]); if (failure) throw failure; return { replacementRunId: id, replayed }; }
};
async function dispatch(path, body = {}, changes = {}) {
  const req = { method: 'POST', user: { id, venueId, role: 'owner' }, body,
    headers: { host: 'local.test', origin: 'https://local.test', 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    socket: { encrypted: true }, ...changes };
  const res = { setHeader(key, value) { this[key] = value; } };
  const handled = await handlePayrollSchemeRoute({ req, res, url: new URL(path, 'https://local.test'), service,
    readBody: async () => body, json: (_, status, data) => Object.assign(res, { status, data }) });
  return { handled, ...res };
}
assert.equal((await dispatch(`${prefix}/preview`)).status, 200);
assert.deepEqual(calls.at(-1), ['preview', { userId: id, venueId }, id]);
assert.equal((await dispatch(prefix, command)).status, 201);
assert.deepEqual(calls.at(-1), ['commit', { userId: id, venueId }, id, command]);
replayed = true;
assert.equal((await dispatch(prefix, command)).status, 200);
const before = calls.length;
for (const route of [prefix, `${prefix}/preview`]) {
  for (const method of ['GET', 'PUT', 'PATCH', 'DELETE']) assert.equal((await dispatch(route, {}, { method })).status, 405);
  assert.equal((await dispatch(route, {}, { user: null })).status, 401);
  for (const role of ['manager', 'staff', 'accountant']) assert.equal((await dispatch(route, {}, { user: { id, venueId, role } })).status, 403);
  assert.equal((await dispatch(`${route}?venueId=${venueId}`)).status, 400);
  assert.equal((await dispatch(route.replace(id, 'bad-id'))).status, 400);
  assert.equal((await dispatch(route, {}, { headers: { host: 'local.test', origin: 'https://foreign.test', 'content-type': 'application/json' } })).status, 403);
}
for (const body of [[], null, { unexpected: true }, { expectedPlanHash: command.expectedPlanHash }]) {
  assert.equal((await dispatch(prefix, body)).status, 400);
}
assert.equal((await dispatch(`${prefix}/preview`, command)).status, 400);
assert.equal((await dispatch(prefix, { ...command, venueId })).status, 400);
assert.equal(calls.length, before, 'rejected requests never reach service');
failure = Object.assign(new Error('private diagnostics'), { code: 'payroll_unpaid_supersession_plan_stale', status: 409 });
assert.deepEqual((await dispatch(prefix, command)).data, { error: failure.code });
failure = new Error('private database diagnostics');
assert.deepEqual((await dispatch(prefix, command)).data, { error: 'payroll_scheme_unavailable' });
console.log('PASS unpaid supersession routes: owner, same-origin, exact bodies, receipt status, query/method rejection and safe errors');
