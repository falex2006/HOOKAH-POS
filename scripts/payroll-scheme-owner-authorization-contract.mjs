import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// Pure orchestration contract. No SQL execution, lock scheduling or PostgreSQL
// predicate semantics are proved by this deliberately narrow fake client.
const require = createRequire(import.meta.url);
const { makeService } = require('../payroll-scheme-service.js');
const { handlePayrollSchemeRoute } = require('../payroll-scheme-routes.js');
const userId = '00000000-0000-4000-8000-000000000001';
const venueId = '00000000-0000-4000-8000-000000000002';
const target = '00000000-0000-4000-8000-000000000003';
const foreign = '00000000-0000-4000-8000-000000000004';
const principal = { userId, venueId };
const user = { id: userId, venueId, role: 'owner' };
const input = { name: 'Authorization boundary', definition: {}, userId: foreign, venueId: foreign, role: 'owner' };
const cases = [
  ['create', 'POST', '/api/payroll/schemes', s => s.createScheme(principal, input)],
  ['version', 'POST', `/api/payroll/schemes/${target}/versions`, s => s.createVersion(principal, target, {})],
  ['edit', 'PUT', `/api/payroll/versions/${target}`, s => s.replaceDraftVersion(principal, target, {})],
  ['activate', 'POST', `/api/payroll/versions/${target}/activate`, s => s.activateVersion(principal, target)]
];
let count = 0;
async function check(label, fn) { await fn(); count++; }
function fixture({ authorized = false, rollbackFailure = false, ownerFailure = false, faultCode = 'TEST_BUSINESS_FAULT' } = {}) {
  const state = { authorized, queries: [], releases: 0, releaseErrors: [], connects: 0, business: 0 };
  const fault = Object.assign(new Error('bounded business fault'), { code: faultCode });
  const rollbackError = new Error('rollback transport failed');
  const client = {
    async query(sql, params) {
      const text = sql.replace(/\s+/g, ' ').trim();
      state.queries.push({ text, params });
      if (text === 'BEGIN') return { rows: [] };
      if (text === 'ROLLBACK') {
        if (rollbackFailure) throw rollbackError;
        return { rows: [] };
      }
      assert.notEqual(text, 'COMMIT', 'no rejected or bounded-fault attempt may commit');
      if (text.startsWith('SELECT id, full_name AS name FROM users')) {
        assert.equal(text, "SELECT id, full_name AS name FROM users WHERE id = $1 AND venue_id = $2 AND role = 'owner' AND is_active = true AND deleted_at IS NULL FOR SHARE");
        assert.deepEqual(params, [userId, venueId], 'authenticated principal, never body identity');
        if (ownerFailure) throw fault;
        return { rows: state.authorized ? [{ id: userId, name: 'Database owner' }] : [] };
      }
      state.business++;
      // Stop at the first real business SQL. Do not emulate configuration storage.
      assert.ok(params.includes(venueId), 'first business operation remains venue scoped');
      throw fault;
    },
    release(error) { state.releases++; state.releaseErrors.push(error); }
  };
  const service = makeService({ query() { assert.fail('configuration must use its transaction client'); },
    async connect() { state.connects++; return client; } });
  return { state, service, fault, rollbackError };
}
async function route(entry, service, actor = user) {
  let result;
  const req = { method: entry[1], user: actor, body: input,
    headers: { host: 'fixture.invalid', origin: 'https://fixture.invalid', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
    socket: { encrypted: true } };
  assert.equal(await handlePayrollSchemeRoute({ req, res: { setHeader() {} },
    url: new URL(entry[2], 'https://fixture.invalid'), service,
    readBody: async () => input, json: (_res, status, body) => { result = { status, body }; } }), true);
  return result;
}
function cleanup(state, attempts = 1, releaseError = undefined) {
  assert.equal(state.connects, attempts);
  assert.equal(state.releases, attempts);
  assert.equal(state.queries.filter(q => q.text === 'BEGIN').length, attempts);
  assert.equal(state.queries.filter(q => q.text === 'ROLLBACK').length, attempts);
  assert.equal(state.queries.some(q => q.text === 'COMMIT'), false);
  assert.deepEqual(state.releaseErrors, Array(attempts).fill(releaseError), 'clean rollback returns a healthy client; failed rollback evicts it');
}
for (const entry of cases) {
  for (const [label, actor, status] of [
    ['anonymous', undefined, 401],
    ...['manager', 'employee', 'platform_owner'].map(role => [role, { ...user, role }, 403]),
    ['bad user', { ...user, id: 'bad' }, 403],
    ['bad venue', { ...user, venueId: 'bad' }, 403],
    ['missing venue', { id: userId, role: 'owner' }, 403]
  ]) await check(`${entry[0]} route ${label}`, async () => {
    const f = fixture();
    // Explicit null avoids the helper's default authenticated actor.
    const result = await route(entry, f.service, actor ?? null);
    assert.equal(result.status, status);
    assert.equal(result.body.error, status === 401 ? 'authentication_required' : 'payroll_scheme_owner_only');
    assert.equal(f.state.connects, 0, 'route must deny before service opens a connection');
  });
  // These labels represent possible empty DB lookup outcomes, not an SQL engine
  // simulation. The query assertion above separately freezes required predicates.
  for (const reason of ['revoked', 'inactive', 'deleted', 'foreign venue']) {
    await check(`${entry[0]} DB empty: ${reason}`, async () => {
      const f = fixture();
      const result = await route(entry, f.service);
      assert.equal(result.status, 403);
      assert.equal(result.body.error, 'payroll_scheme_owner_only');
      assert.equal(f.state.business, 0);
      cleanup(f.state);
    });
  }
  await check(`${entry[0]} authorized boundary then revoked on same service`, async () => {
    const f = fixture({ authorized: true });
    await assert.rejects(entry[3](f.service), error => error === f.fault);
    assert.equal(f.state.business, 1, 'valid DB owner reaches bounded business SQL');
    f.state.authorized = false;
    await assert.rejects(entry[3](f.service), error => error.code === 'payroll_scheme_owner_only' && error.status === 403);
    assert.equal(f.state.business, 1, 'next call must not reuse prior owner authorization');
    assert.equal(f.state.queries.filter(q => q.text.includes('FROM users')).length, 2);
    cleanup(f.state, 2);
  });
  await check(`${entry[0]} owner lookup transport error cleanup`, async () => {
    const f = fixture({ ownerFailure: true });
    await assert.rejects(entry[3](f.service), error => error === f.fault);
    assert.equal(f.state.business, 0);
    cleanup(f.state);
  });
  await check(`${entry[0]} rollback failure preserves denial and releases`, async () => {
    const f = fixture({ rollbackFailure: true });
    await assert.rejects(entry[3](f.service), error => error.code === 'payroll_scheme_owner_only' && error.status === 403);
    cleanup(f.state, 1, f.rollbackError);
  });
  await check(`${entry[0]} rollback failure preserves business error and evicts`, async () => {
    const f = fixture({ authorized: true, rollbackFailure: true });
    await assert.rejects(entry[3](f.service), error => error === f.fault);
    assert.equal(f.state.business, 1);
    cleanup(f.state, 1, f.rollbackError);
  });
  await check(`${entry[0]} SQLSTATE conflict mapping survives failed rollback`, async () => {
    const f = fixture({ authorized: true, rollbackFailure: true, faultCode: '23505' });
    await assert.rejects(entry[3](f.service), error => error.code === 'payroll_scheme_conflict' && error.status === 409);
    assert.equal(f.state.business, 1);
    cleanup(f.state, 1, f.rollbackError);
  });
}
console.log(`PASS ${count} payroll scheme owner authorization cases (pure router/service fake-client; no PostgreSQL or successful configuration commit proof)`);
