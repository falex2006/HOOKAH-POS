import assert from 'node:assert/strict';

const baseUrl = new URL(process.argv[2] || 'https://212.192.0.58');
const token = String(process.env.ALPHASAT_ADAPTER_TOKEN || '');
const expectedOrganizationId = String(process.env.ALPHASAT_EXPECTED_ORGANIZATION_ID || '');

assert.equal(baseUrl.protocol, 'https:', 'Adapter acceptance requires HTTPS');
assert.ok(token, 'Set ALPHASAT_ADAPTER_TOKEN without printing it');
assert.match(expectedOrganizationId, /^[0-9a-f-]{36}$/i, 'Set the expected organization UUID');

const request = async (path, { method = 'GET', authorization = true, cookie = false, rawAuthorization } = {}) => {
  const headers = { Accept: 'application/json' };
  if (authorization) headers.Authorization = rawAuthorization || `Bearer ${token}`;
  if (cookie) headers.Cookie = `crm_session=${token}`;
  const response = await fetch(new URL(path, baseUrl), {
    method,
    redirect: 'manual',
    headers,
    signal: AbortSignal.timeout(7000),
  });
  assert.equal(response.status >= 300 && response.status < 400, false, `${method} ${path} must not redirect`);
  return response;
};

const unauthenticated = await request('/api/alphasat/v1/status', { authorization: false });
assert.equal(unauthenticated.status, 401, 'Status route must require machine authentication');
assert.equal(unauthenticated.headers.get('cache-control'), 'no-store');
assert.match(unauthenticated.headers.get('x-request-id') || '', /^[0-9a-f-]{36}$/i);
const preflight = await request('/api/alphasat/v1/status', { method: 'OPTIONS', authorization: false });
assert.equal(preflight.status, 204, 'Adapter preflight must be handled without session auth');
assert.equal(preflight.headers.get('cache-control'), 'no-store');
assert.equal(preflight.headers.get('access-control-allow-methods'), 'GET, OPTIONS', 'Preflight must not advertise write methods');
assert.match(preflight.headers.get('x-request-id') || '', /^[0-9a-f-]{36}$/i);
const cookieOnly = await request('/api/alphasat/v1/status', { authorization: false, cookie: true });
assert.equal(cookieOnly.status, 401, 'Browser cookies must not authenticate machine requests');
const malformedToken = await request('/api/alphasat/v1/status', { rawAuthorization: 'Bearer invalid' });
assert.equal(malformedToken.status, 401, 'Malformed bearer tokens must fail closed');

for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
  const wrongMethod = await request('/api/alphasat/v1/status', { method });
  assert.equal(wrongMethod.status, 405, `Adapter must reject ${method}`);
}

const statusResponse = await request('/api/alphasat/v1/status');
assert.equal(statusResponse.status, 200, 'Machine credential must be accepted');
assert.equal(statusResponse.headers.get('cache-control'), 'no-store');
const status = await statusResponse.json();
assert.equal(status.product_code, 'hookah-pos');
assert.equal(status.contract_version, '1.0');
assert.match(status.installation_id, /^[0-9a-f-]{36}$/i);
assert.equal(status.state, 'ready');
assert.ok(Array.isArray(status.capabilities) && status.capabilities.includes('organizations.list') && status.capabilities.includes('organizations.read'));

const listResponse = await request('/api/alphasat/v1/organizations');
assert.equal(listResponse.status, 200);
const list = await listResponse.json();
assert.equal(list.items.length, 1, 'Credential must be scoped to one approved organization');
assert.equal(list.items[0].id, expectedOrganizationId, 'Only the explicitly approved organization must be visible');
assert.ok(['active', 'suspended'].includes(list.items[0].state));
for (const forbiddenField of ['slug', 'plan', 'city', 'owners', 'venues', 'seats', 'login', 'contact', 'address']) {
  assert.equal(forbiddenField in list.items[0], false, `Adapter must not expose ${forbiddenField}`);
}

const organizationResponse = await request(`/api/alphasat/v1/organizations/${expectedOrganizationId}`);
assert.equal(organizationResponse.status, 200);
const organization = await organizationResponse.json();
assert.equal(organization.id, expectedOrganizationId);
assert.equal(organization.name, list.items[0].name);

const otherOrganizationResponse = await request('/api/alphasat/v1/organizations/00000000-0000-0000-0000-000000000099');
assert.equal(otherOrganizationResponse.status, 404, 'Credential must not read any other organization');

for (const [label, value] of [
  ['revoked', process.env.ALPHASAT_REVOKED_ADAPTER_TOKEN],
  ['expired', process.env.ALPHASAT_EXPIRED_ADAPTER_TOKEN],
].filter(([, value]) => value)) {
  const rejected = await fetch(new URL('/api/alphasat/v1/status', baseUrl), {
    redirect: 'manual',
    headers: { Authorization: `Bearer ${value}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(7000),
  });
  assert.equal(rejected.status, 401, `${label} credentials must fail closed`);
}

process.stdout.write('AlphaSat read-only adapter acceptance passed.\n');
