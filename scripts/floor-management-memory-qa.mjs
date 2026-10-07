import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const child = spawn(process.execPath, ['server.js'], {
  cwd: new URL('../', import.meta.url),
  windowsHide: true,
  env: { ...process.env, HOST: '127.0.0.1', PORT: '0', DATABASE_URL: '', CRM_DATABASE_URL: '', AUTH_REQUIRED: 'false', DEMO_MODE: 'false', NODE_ENV: 'test', API_RATE_LIMIT: '10000' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stdout.on('data', (chunk) => { output += chunk; });
child.stderr.on('data', (chunk) => { output += chunk; });
const started = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`Memory QA server did not start: ${output}`)), 15000);
  child.once('error', (error) => { clearTimeout(timer); reject(error); });
  child.stdout.on('data', () => {
    const match = output.match(/CRM running on http:\/\/localhost:(\d+)/);
    if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); }
  });
});

try {
  const base = await started;
  const request = async (path, method = 'GET', body) => {
    const response = await fetch(`${base}${path}`, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
  const floor = await request('/api/floor');
  assert.equal(floor.status, 200);
  const expectedVenueId = floor.body.venueId;
  const zone = await request('/api/floor/zones', 'POST', { expectedVenueId, name: 'Memory history QA' });
  assert.equal(zone.status, 201, JSON.stringify(zone.body));
  const table = await request('/api/floor/tables', 'POST', { expectedVenueId, zoneId: zone.body.id, name: 'Reserved memory table', capacity: 4 });
  assert.equal(table.status, 201, JSON.stringify(table.body));
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Yekaterinburg', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const reservation = await request('/api/reservations', 'POST', { guestName: 'Memory QA guest', date: today, time: '20:00', tableId: table.body.id, guests: 2, deposit: 0 });
  assert.equal(reservation.status, 201, JSON.stringify(reservation.body));
  const reservedState = await request('/api/floor');
  assert.equal(reservedState.body.zones.find((entry) => entry.id === zone.body.id).tables.find((entry) => entry.id === table.body.id).status, 'reserved');
  const blocked = await request(`/api/floor/tables/${table.body.id}`, 'PATCH', { expectedVenueId, status: 'blocked' });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error, 'table_has_live_activity');
  const afterBlockReject = await request('/api/floor');
  assert.equal(afterBlockReject.body.zones.find((entry) => entry.id === zone.body.id).tables.find((entry) => entry.id === table.body.id).status, 'reserved');
  const cancelled = await request(`/api/reservations/${encodeURIComponent(reservation.body.id)}/cancel`, 'POST', {});
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  const historicalDelete = await request(`/api/floor/tables/${table.body.id}`, 'DELETE', { expectedVenueId });
  assert.equal(historicalDelete.status, 409);
  assert.equal(historicalDelete.body.error, 'table_has_history');
  const afterDeleteReject = await request('/api/floor');
  assert.ok(afterDeleteReject.body.zones.find((entry) => entry.id === zone.body.id).tables.some((entry) => entry.id === table.body.id), 'cancelled reservation history retains its table');
  console.log('FLOOR MANAGEMENT MEMORY QA: PASS (confirmed reservation status guard and cancelled-history retention)');
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill();
    await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(5000).then(() => { throw new Error('Memory QA server did not stop'); })]);
  }
}
