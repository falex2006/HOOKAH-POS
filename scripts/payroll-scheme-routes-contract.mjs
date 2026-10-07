import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { handlePayrollSchemeRoute, sameOriginMutation } = require('../payroll-scheme-routes.js');
const { makeService: makePayrollSchemeService } = require('../payroll-scheme-service.js');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const id = '00000000-0000-4000-8000-000000000001';
const venueId = '00000000-0000-4000-8000-000000000002';
const versionId = '00000000-0000-4000-8000-000000000003';

const responseFor = () => {
  const response = { status: null, body: null };
  return { response, json: (_res, status, body) => { response.status = status; response.body = body; } };
};
const requestFor = (method, pathname, overrides = {}) => ({
  method,
  user: { id, venueId, role: 'owner' },
  headers: { host: 'crm.example.test', origin: 'https://crm.example.test', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', ...(method === 'GET' ? {} : {}), ...overrides.headers },
  socket: { encrypted: true },
  url: pathname
});
const bodyReader = async (req) => req.body || {};

const calls = [];
const scheme = { id, name: 'Flexible', description: '', versions: [{ id: versionId, versionNo: 1, status: 'draft' }] };
const service = {
  listSchemes: async (principal) => { calls.push(['listSchemes', principal]); return [scheme]; },
  getVersion: async (principal, target) => { calls.push(['getVersion', principal, target]); return { ...scheme, versionId: target, status: 'draft' }; },
  listVersionRevisions: async (principal, target) => { calls.push(['listVersionRevisions', principal, target]); return []; },
  createScheme: async (principal, input) => { calls.push(['createScheme', principal, input]); return { ...scheme, ...input }; },
  createVersion: async (principal, target, definition) => { calls.push(['createVersion', principal, target, definition]); return { ...scheme, schemeId: target, versionId, ...definition }; },
  replaceDraftVersion: async (principal, target, definition) => { calls.push(['replaceDraftVersion', principal, target, definition]); return { ...scheme, versionId: target, ...definition }; },
  activateVersion: async (principal, target) => { calls.push(['activateVersion', principal, target]); return { ...scheme, versionId: target, status: 'active' }; },
  preview: async (principal, target, input) => { calls.push(['preview', principal, target, input]); return { official: false, persistence: 'none', scenario: true, result: { status: 'ready' } }; },
  compare: async (principal, ids, input, baseline) => { calls.push(['compare', principal, ids, input, baseline]); return { official: false, persistence: 'none', scenario: true, comparisons: [] }; }
};
const dispatch = async (req, { selectedService = service, body = bodyReader } = {}) => {
  const { response, json } = responseFor();
  const handled = await handlePayrollSchemeRoute({ req, res: response, url: new URL(req.url, 'https://crm.example.test'), service: selectedService, readBody: body, json });
  return { handled, ...response };
};

let result = await dispatch(requestFor('GET', '/api/payroll/schemes'));
assert.equal(result.handled, true);
assert.equal(result.status, 200);
assert.deepEqual(result.body.items, [scheme]);
assert.deepEqual(calls.at(-1), ['listSchemes', { userId: id, venueId }]);

const spoofed = { name: 'Draft', venueId: 'forged-venue', userId: 'forged-user', definition: { mode: 'progressive_daily' } };
result = await dispatch({ ...requestFor('POST', '/api/payroll/schemes'), body: spoofed });
assert.equal(result.status, 201);
assert.deepEqual(calls.at(-1), ['createScheme', { userId: id, venueId }, spoofed]);

result = await dispatch(requestFor('GET', `/api/payroll/schemes/${id}/versions`));
assert.equal(result.status, 200);
assert.deepEqual(result.body.items, scheme.versions);

result = await dispatch(requestFor('GET', `/api/payroll/versions/${versionId}`));
assert.equal(result.status, 200);
assert.deepEqual(calls.at(-1), ['getVersion', { userId: id, venueId }, versionId]);

result = await dispatch(requestFor('GET', `/api/payroll/versions/${versionId}/revisions`));
assert.equal(result.status, 200);
assert.deepEqual(result.body.items, []);

for (const path of ['/api/payroll/schemes', `/api/payroll/versions/${versionId}`]) {
  result = await dispatch({ ...requestFor('GET', path), user: { id, venueId, role: 'manager' } });
  assert.equal(result.handled, true);
  assert.equal(result.status, 403, `non-owners cannot inspect scheme data at ${path}`);
  assert.equal(result.body.error, 'payroll_scheme_owner_only');
}

const definition = { effectiveFrom: '2026-10-01', roleParameters: { bartender: {} } };
result = await dispatch({ ...requestFor('POST', `/api/payroll/schemes/${id}/versions`), body: { definition } });
assert.equal(result.status, 201);
assert.deepEqual(calls.at(-1), ['createVersion', { userId: id, venueId }, id, definition]);

result = await dispatch({ ...requestFor('PUT', `/api/payroll/versions/${versionId}`), body: { definition } });
assert.equal(result.status, 200);
assert.deepEqual(calls.at(-1), ['replaceDraftVersion', { userId: id, venueId }, versionId, definition]);

result = await dispatch(requestFor('POST', `/api/payroll/versions/${versionId}/activate`));
assert.equal(result.status, 200);
assert.equal(calls.at(-1)[0], 'activateVersion');

const previewInput = { periodFrom: '2026-10-01', periodTo: '2026-10-01', employees: [], sales: [] };
result = await dispatch({ ...requestFor('POST', `/api/payroll/versions/${versionId}/preview`), body: { previewInput } });
assert.equal(result.status, 200);
assert.deepEqual(calls.at(-1), ['preview', { userId: id, venueId }, versionId, previewInput]);
assert.equal(result.body.official, false);
assert.equal(result.body.persistence, 'none');

result = await dispatch({ ...requestFor('POST', '/api/payroll/compare'), body: { versionIds: [versionId, id], baselineVersionId: versionId, previewInput } });
assert.equal(result.status, 200);
assert.equal(calls.at(-1)[0], 'compare');
assert.deepEqual(calls.at(-1).slice(1), [{ userId: id, venueId }, [versionId, id], previewInput, versionId]);
const rejectingPool = {
  query: async () => { throw new Error('malformed comparison IDs must be rejected before DB access'); },
  connect: async () => { throw new Error('malformed comparison IDs must be rejected before DB access'); }
};
const validatingService = makePayrollSchemeService(rejectingPool);
result = await dispatch({ ...requestFor('POST', '/api/payroll/compare'), body: {
  versionIds: ['not-a-uuid', id], baselineVersionId: id, previewInput
} }, { selectedService: validatingService });
assert.equal(result.status, 400, 'malformed comparison version IDs are client errors');
assert.equal(result.body.error, 'invalid_payroll_scheme_version_id');
result = await dispatch({ ...requestFor('POST', '/api/payroll/compare'), body: {
  versionIds: [versionId, id], baselineVersionId: 42, previewInput
} }, { selectedService: validatingService });
assert.equal(result.status, 400, 'malformed comparison baseline IDs are client errors');
assert.equal(result.body.error, 'invalid_payroll_scheme_version_id');
result = await dispatch({ ...requestFor('POST', '/api/payroll/compare'), body: { versionIds: [versionId, id], baselineVersionId: versionId, previewInput } }, {
  selectedService: { ...service, compare: async () => { throw Object.assign(new Error('comparison_currency_mismatch'), { status: 400, code: 'comparison_currency_mismatch' }); } }
});
assert.equal(result.status, 400, 'mixed currency comparisons return a client error');
assert.equal(result.body.error, 'comparison_currency_mismatch');

result = await dispatch({ ...requestFor('GET', '/api/payroll/schemes'), user: null });
assert.equal(result.status, 401);
assert.equal(result.body.error, 'authentication_required');

result = await dispatch({ ...requestFor('GET', '/api/payroll/schemes'), user: { id, venueId: 'bad', role: 'owner' } });
assert.equal(result.status, 403);

result = await dispatch(requestFor('GET', '/api/payroll/schemes'), { selectedService: null });
assert.equal(result.status, 503);
assert.equal(result.body.error, 'payroll_scheme_database_required');

result = await dispatch(requestFor('GET', `/api/payroll/versions/not-a-uuid`));
assert.equal(result.status, 400);

let bodyRead = false;
result = await dispatch({ ...requestFor('POST', '/api/payroll/schemes'), headers: { ...requestFor('POST', '/').headers, origin: 'https://evil.example.test' }, body: spoofed }, { body: async () => { bodyRead = true; return spoofed; } });
assert.equal(result.status, 403);
assert.equal(result.body.error, 'same_origin_required');
assert.equal(bodyRead, false);

result = await dispatch({ ...requestFor('POST', '/api/payroll/schemes'), headers: { ...requestFor('POST', '/').headers, 'content-type': 'text/plain' }, body: spoofed });
assert.equal(result.status, 415);

result = await dispatch({ ...requestFor('POST', '/api/payroll/schemes'), body: [] });
assert.equal(result.status, 400);

result = await dispatch(requestFor('POST', '/api/payroll/schemes'), {
  body: async () => { throw Object.assign(new Error('secret database text'), { code: 'internal_failure' }); }
});
assert.equal(result.status, 400);
assert.equal(result.body.error, 'invalid_json_body');
assert.equal(JSON.stringify(result.body).includes('secret'), false);

result = await dispatch(requestFor('GET', '/api/payroll/rules'));
assert.equal(result.handled, false, 'legacy payroll endpoints remain outside the scheme route adapter');

assert.equal(sameOriginMutation(requestFor('POST', '/api/payroll/schemes')), true);
assert.equal(sameOriginMutation(requestFor('POST', '/api/payroll/schemes', { headers: { origin: 'https://evil.example.test' } })), false);
assert.equal(sameOriginMutation(requestFor('POST', '/api/payroll/schemes', { headers: { authorization: 'Bearer test', origin: '' } })), true);

const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const routeSource = fs.readFileSync(path.join(root, 'payroll-scheme-routes.js'), 'utf8');
assert.match(server, /makePayrollSchemeService\(repositories\.pool\)/, 'service is created only with the PostgreSQL pool');
assert.match(server, /await handlePayrollSchemeRoute\(\{ req, res, url, service: payrollSchemeService, readBody: body, json \}\)/, 'raw HTTP router mounts the isolated scheme adapter');
assert.match(server, /await handlePayrollSchemeRoute[\s\S]*?if \(pathname === '\/api\/payroll\/rules'/, 'new scheme endpoints dispatch before the legacy payroll routes');
assert.match(routeSource, /sameOriginMutation\(req\)/, 'scheme writes include CSRF origin validation');
assert.match(routeSource, /req\.user\.role !== 'owner'/, 'scheme API rejects non-owners before calling the service');
assert.doesNotMatch(routeSource, /payroll_entries|expenses/, 'scheme routes never create payroll entries or expenses');

console.log('PAYROLL SCHEME ROUTES CONTRACT: PASS (owner session boundary, CSRF, CRUD, revisions, scenario, compare and legacy isolation)');
