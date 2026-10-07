import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const root = new URL('..', import.meta.url);
const standardTtl = 12 * 60 * 60;
const trustedTtl = 30 * 24 * 60 * 60;

async function runServer() {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: '0',
      AUTH_REQUIRED: 'true',
      DEMO_MODE: 'true',
      DATABASE_URL: '',
      DEMO_OWNER_PASSWORD: 'demo',
      DEMO_ADMIN_PASSWORD: 'admin',
      DEMO_STAFF_PASSWORD: 'demo',
      DEMO_STAFF_PIN: '1234',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    const match = output.match(/CRM running on http:\/\/localhost:(\d+)/);
    if (match) return { child, baseUrl: `http://127.0.0.1:${match[1]}` };
    if (child.exitCode !== null) throw new Error(`CRM exited early: ${output}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  child.kill();
  throw new Error(`CRM did not start: ${output}`);
}

async function request(baseUrl, path, { method = 'GET', cookie = '', body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, payload, cookies: response.headers.getSetCookie() };
}

const cookieJar = (cookies) => cookies.map((cookie) => cookie.split(';', 1)[0]).join('; ');

async function login(baseUrl, username, password, trustDevice) {
  const result = await request(baseUrl, '/api/login', {
    method: 'POST',
    body: { username, password, trustDevice },
  });
  assert.equal(result.status, 200, `${username} login failed: ${JSON.stringify(result.payload)}`);
  return { ...result.payload, cookie: cookieJar(result.cookies), rawCookies: result.cookies };
}

const { child, baseUrl } = await runServer();
try {
  const owner = await login(baseUrl, 'owner', 'demo', true);
  assert.equal(owner.expiresIn, trustedTtl, 'owner trusted device receives the long session');

  const createAdmin = await request(baseUrl, '/api/staff', {
    method: 'POST',
    cookie: owner.cookie,
    body: {
      name: 'Trusted QA Admin',
      role: 'admin',
      login: 'trusted_admin',
      password: 'admin-pass',
      birthDate: '1990-01-01',
    },
  });
  assert.equal(createAdmin.status, 201, `admin creation failed: ${JSON.stringify(createAdmin.payload)}`);
  const adminId = createAdmin.payload.id;
  const pinUpdate = await request(baseUrl, `/api/staff/${adminId}/pin`, { method: 'PATCH', cookie: owner.cookie, body: { pin: '2468' } });
  assert.equal(pinUpdate.status, 200, 'owner sets admin PIN');

  const normalAdmin = await login(baseUrl, 'trusted_admin', 'admin-pass', false);
  assert.equal(normalAdmin.expiresIn, standardTtl, 'admin without trustDevice receives the standard session');
  assert.equal(normalAdmin.trustedDevice, false);
  const normalRestored = await request(baseUrl, '/api/session', { cookie: normalAdmin.cookie });
  assert.equal(normalRestored.status, 200, 'normal admin cookie can read the existing session');
  assert.equal(normalRestored.payload.trustedDevice, false, 'normal admin session is not marked as a trusted device');
  const normalPinReturn = await request(baseUrl, '/api/session/pin-return', { method: 'POST', cookie: normalAdmin.cookie, body: { pin: '2468' } });
  assert.equal(normalPinReturn.status, 403, 'normal admin session cannot use trusted PIN return');
  assert.equal(normalPinReturn.payload.error, 'pin_return_requires_trusted_device');

  const admin = await login(baseUrl, 'trusted_admin', 'admin-pass', true);
  assert.equal(admin.expiresIn, trustedTtl, 'admin trusted device receives the long session');
  assert.equal(admin.trustedDevice, true);
  assert.ok(admin.rawCookies.some((cookie) => cookie.includes(`Max-Age=${trustedTtl}`)), 'trusted session cookie uses the long max-age');

  const restored = await request(baseUrl, '/api/session', { cookie: admin.cookie });
  assert.equal(restored.status, 200, 'trusted cookie can read the existing session');
  assert.equal(restored.payload.token, undefined, 'session restore must not expose the bearer token before PIN return');
  assert.equal(restored.payload.trustedDevice, true, 'trusted admin session is explicitly marked for PIN return');
  assert.equal(restored.payload.user.role, 'admin');
  assert.equal(restored.payload.user.pinConfigured, true);

  const wrongPin = await request(baseUrl, '/api/session/pin-return', { method: 'POST', cookie: admin.cookie, body: { pin: '1111' } });
  assert.equal(wrongPin.status, 401, 'wrong admin PIN cannot restore the session');
  const rightPin = await request(baseUrl, '/api/session/pin-return', { method: 'POST', cookie: admin.cookie, body: { pin: '2468' } });
  assert.equal(rightPin.status, 200, 'right admin PIN restores the trusted session');
  assert.equal(rightPin.payload.token, admin.token);
  assert.equal(rightPin.payload.user.role, 'admin');

  const logout = await request(baseUrl, '/api/logout', { method: 'POST', cookie: admin.cookie });
  assert.equal(logout.status, 200, 'logout ends the trusted server session');
  const afterLogoutPin = await request(baseUrl, '/api/session/pin-return', { method: 'POST', cookie: admin.cookie, body: { pin: '2468' } });
  assert.equal(afterLogoutPin.status, 401, 'PIN return must not recreate an ended or expired server session');

  const staff = await login(baseUrl, 'staff', 'demo', true);
  assert.equal(staff.expiresIn, standardTtl, 'staff remains on the shorter working session even when trustDevice is sent');
  assert.equal(staff.trustedDevice, false);
  const staffPinReturn = await request(baseUrl, '/api/session/pin-return', { method: 'POST', cookie: staff.cookie, body: { pin: '1234' } });
  assert.equal(staffPinReturn.status, 403, 'staff cannot use admin trusted PIN return');

  console.log('TRUSTED PIN RETURN RUNTIME QA: PASS');
} finally {
  child.kill();
}
