import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

// Owned loopback server with memory state only. Never accepts an external URL
// or database, and never prints generated credentials or authentication tokens.
const secret = () => randomBytes(24).toString('hex');
const adminPassword = secret(), staffPassword = secret();
const child = spawn(process.execPath, ['server.js'], {
  cwd: fileURLToPath(new URL('../', import.meta.url)), windowsHide: true,
  env: { ...process.env, HOST: '127.0.0.1', PORT: '0', DATABASE_URL: '', AUTH_REQUIRED: 'true', DEMO_MODE: 'false', NODE_ENV: 'test', COOKIE_SECURE: 'false', FIRST_RUN_SETUP_ENABLED: 'false', DEMO_ADMIN_PASSWORD: adminPassword, DEMO_STAFF_PASSWORD: staffPassword, DEMO_OWNER_PASSWORD: '', DEMO_STAFF_PIN: '', SAAS_OWNER_PASSWORD: '', STAFF_PASSPORT_KEY: secret() },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let cases = 0;
child.stderr.on('data', () => {});
try {
  const base = await new Promise((resolve, reject) => {
    let startup = '';
    const timer = setTimeout(() => reject(new Error('Owned company API server startup timeout')), 15000);
    const fail = () => { clearTimeout(timer); reject(new Error('Owned company API server could not start')); };
    child.once('error', fail); child.once('exit', fail);
    child.stdout.on('data', (chunk) => {
      startup = (startup + chunk).slice(-2000);
      const match = startup.match(/CRM running on http:\/\/localhost:(\d+)/);
      if (!match) return;
      clearTimeout(timer); child.removeListener('error', fail); child.removeListener('exit', fail);
      resolve(`http://127.0.0.1:${match[1]}`);
    });
  });
  const request = async (path, method = 'GET', input, token) => {
    assert.ok(path.startsWith('/api/') && !path.includes('://'));
    const response = await fetch(`${base}${path}`, {
      method, signal: AbortSignal.timeout(8000),
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(input === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
    return { status: response.status, body: await response.json() };
  };
  const expectStatus = (result, status, label) => { assert.equal(result.status, status, label); cases++; return result.body; };
  expectStatus(await request('/api/venue'), 401, 'anonymous company read denied');
  expectStatus(await request('/api/venue', 'PATCH', { name: 'Unauthorized' }), 401, 'anonymous company write denied');
  const login = expectStatus(await request('/api/login', 'POST', { username: 'admin', password: adminPassword }), 200, 'owned admin login');
  assert.ok(typeof login.token === 'string' && login.token.length > 0, 'admin token issued');
  const token = login.token;
  const get = async () => expectStatus(await request('/api/venue', 'GET', undefined, token), 200, 'company GET');
  const initial = await get(); assert.ok(initial.id, 'company identity available');
  const id = initial.id;
  const patch = (input) => request('/api/venue', 'PATCH', { expectedVenueId: id, ...input }, token);
  expectStatus(await request('/api/venue', 'PATCH', { name: 'No precondition' }, token), 428, 'identity precondition required');
  expectStatus(await patch({ expectedVenueId: 'qa-unrelated-venue', name: 'Wrong venue' }), 409, 'stale company context rejected');
  for (const [input, label] of [
    [{ name: '   ' }, 'blank name'], [{ city: '   ' }, 'blank city'], [{ address: '   ' }, 'blank address'],
    [{ name: 'x'.repeat(121) }, 'long name'], [{ timezone: 'Mars/Olympus' }, 'invalid timezone'],
    [{ logoUrl: 'data:image/svg+xml;base64,PHN2Zy8+' }, 'unsupported logo type'],
    [{ logoUrl: 'https://qa.invalid/logo.png' }, 'remote logo rejected'],
    [{ phoneNumbers: [{ number: '123', primary: true }] }, 'invalid phone'],
    [{ phoneNumbers: [{ number: '+7 (999) 100-00-01', primary: false }] }, 'missing primary'],
    [{ phoneNumbers: [{ number: '+7 (999) 100-00-01', primary: true }, { number: '+7 (999) 100-00-02', primary: true }] }, 'multiple primary'],
    [{ phoneNumbers: Array.from({ length: 6 }, (_, index) => ({ number: `+7 (999) 100-00-0${index}`, primary: index === 0 })) }, 'too many phones'],
  ]) expectStatus(await patch(input), 400, label);
  assert.equal((await get()).name, initial.name, 'invalid writes leave identity unchanged');
  const floorBefore = expectStatus(await request('/api/floor', 'GET', undefined, token), 200, 'floor before identity save');
  const phones = [{ label: 'Рабочий', number: '+7 (999) 100-00-01', primary: true }, { label: 'Резервный', number: '+7 (999) 100-00-02', primary: false }];
  const logo = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
  expectStatus(await patch({ name: 'Company API QA', city: 'QA City', address: 'QA Address', format: 'QA Format', timezone: 'UTC', phone: phones[0].number, phoneNumbers: phones, logoUrl: logo }), 200, 'save identity, arbitrary IANA, contacts and logo');
  const saved = await get();
  assert.equal(saved.name, 'Company API QA'); assert.equal(saved.timezone, 'UTC'); assert.equal(saved.logoUrl, logo); assert.deepEqual(saved.phoneNumbers, phones);
  assert.deepEqual(saved.vipRoomMinimums, initial.vipRoomMinimums, 'company identity save omits and preserves legacy VIP values');
  assert.deepEqual(expectStatus(await request('/api/floor', 'GET', undefined, token), 200, 'floor after identity save'), floorBefore, 'company identity save does not edit actual seating/deposits');
  expectStatus(await patch({ name: 'Company API QA Renamed', timezone: saved.timezone }), 200, 'unrelated save retains nonlisted timezone');
  assert.equal((await get()).logoUrl, logo, 'omitted logo stays saved');
  expectStatus(await patch({ logoUrl: null }), 200, 'explicit logo removal');
  assert.equal((await get()).logoUrl, null, 'logo removal persists on read');
  expectStatus(await patch({ phone: '', phoneNumbers: [] }), 200, 'clear all company phones');
  const cleared = await get(); assert.equal(cleared.phone, ''); assert.deepEqual(cleared.phoneNumbers, []);
  const staff = expectStatus(await request('/api/login', 'POST', { username: 'staff', password: staffPassword }), 200, 'owned staff login');
  expectStatus(await request('/api/venue', 'PATCH', { expectedVenueId: id, name: 'Staff mutation' }, staff.token), 403, 'operational staff cannot change company identity');
  assert.equal((await get()).name, 'Company API QA Renamed', 'denied staff write did not mutate company');
  console.log(`COMPANY PAGE API QA: PASS (${cases} HTTP assertions; auth, validation, venue precondition, timezone, logo, phones, unchanged deposits; isolated memory server)`);
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    const closed = once(child, 'exit'); child.kill();
    let timer;
    try { await Promise.race([closed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Owned company API server cleanup timed out')), 5000); })]); }
    finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
  }
}
