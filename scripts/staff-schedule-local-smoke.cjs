'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { config, folder } = require('./staff-schedule-local-config.cjs');
async function main() {
  const c = config();
  const fixtures = JSON.parse(fs.readFileSync(path.join(folder, 'fixtures.json'), 'utf8'));
  const base = `http://127.0.0.1:${c.appPort}`;
  const health = await fetch(`${base}/api/health`).then(r => r.json());
  assert.equal(health.database, 'postgres');
  assert.equal(health.status, 'ok');
  const unauthorized = await fetch(`${base}/api/staff/schedule?from=2026-10-12&to=2026-10-18`);
  assert.equal(unauthorized.status, 401);
  for (const user of fixtures.users) {
    const response = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: user.login, password: fixtures.password }) });
    const session = await response.json();
    assert.equal(response.status, 200, `Login ${user.role}: ${session.error || ''}`);
    assert.equal(session.user.id, user.id);
    assert.equal(session.user.venueId, fixtures.venues[user.tenant]);
    const schedule = await fetch(`${base}/api/staff/schedule?from=2026-10-12&to=2026-10-18`, { headers: { Authorization: `Bearer ${session.token}` } });
    const access = await fetch(`${base}/api/staff/schedule/access`, { headers: { Authorization: `Bearer ${session.token}` } }).then(r => r.json());
    assert.equal(schedule.status, access.view ? 200 : 403, `Schedule read ${user.role}`);
    console.log(`BASELINE ${user.role}/tenant${user.tenant}: login and schedule read verified`);
  }
  console.log('SCHEDULE RUNTIME SMOKE: PASS; access matches current grants. Dedicated grant/revoke suite is separate.');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
