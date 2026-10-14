'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { config, folder, options } = require('./staff-schedule-local-config.cjs');
async function main() {
  const c = config(), f = JSON.parse(fs.readFileSync(path.join(folder, 'fixtures.json'), 'utf8'));
  const base = `http://127.0.0.1:${c.appPort}`, prefix = '/api/staff/schedule';
  const pool = new Pool(options(c));
  const employee = randomUUID();
  try {
    await pool.query(`INSERT INTO users(id,venue_id,organization_id,full_name,login,role) VALUES($1,$2,$3,'HTTP QA employee',$4,'bartender')`, [employee, f.venues[0], f.organizations[0], `${employee}@example.test`]);
    const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: f.users[0].login, password: f.password }) });
    assert.equal(login.status, 200);
    const session = await login.json();
    const cookie = login.headers.getSetCookie().find(x => x.startsWith('crm_session=')).split(';')[0];
    async function request(route, method = 'GET', input, headers = { Authorization: `Bearer ${session.token}` }) {
      const res = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: input === undefined ? undefined : JSON.stringify(input) });
      return { status: res.status, value: await res.json() };
    }
    const input = { userId: employee, workDate: '2026-12-15', plannedStart: '2026-12-15T20:00+05:00', plannedEnd: '2026-12-16T04:00+05:00', breakMinutes: 30, requestKey: randomUUID(), reason: 'HTTP QA' };
    assert.equal((await request(prefix)).status,200,'Default venue date GET');
    assert.equal((await request(prefix+'?from=2026-12-15')).status,200,'Default to=from');
    assert.equal((await request(prefix,'POST',{...input,requestKey:undefined})).value.error,'schedule_request_key_required');
    assert.equal((await request(prefix,'POST',{...input,version:1})).value.error,'schedule_create_version_forbidden');
    assert.equal((await request(prefix, 'POST', input, { Cookie: cookie, Origin: 'https://untrusted.example' })).status, 403);
    const created = await request(prefix, 'POST', input, { Cookie: cookie, Origin: base });
    assert.equal(created.status, 201, JSON.stringify(created.value));
    const id = created.value.id;
    assert.equal(created.value.venue_id,f.venues[0]);
    assert.equal(created.value.created_by,f.users[0].id);
    assert.ok(created.value.created_at);
    assert.equal(created.value.note,'');
    const legacy=(await pool.query("INSERT INTO staff_schedules(venue_id,user_id,work_date,note) VALUES($1,$2,'2026-12-18',NULL) RETURNING id",[f.venues[0],employee])).rows[0];
    assert.equal((await request(`${prefix}/${legacy.id}`)).value.note,null);
    assert.equal((await request(`${prefix}/${id}`)).value.id,id);
    assert.equal((await request(prefix, 'POST', input)).value.id, id);
    assert.equal((await request(prefix, 'POST', { ...input, requestKey: randomUUID() })).status, 409);
    const edited = await request(`${prefix}/${id}`, 'PATCH', { ...input, note: 'Updated via HTTP', version: 1, requestKey: randomUUID() });
    assert.equal(edited.status, 200);
    assert.equal(edited.value.version, 2);
    assert.equal((await request(`${prefix}/${id}`, 'PATCH', { ...input, version: 1, requestKey: randomUUID() })).status, 409);
    const read = await request(`${prefix}?from=2026-12-15&to=2026-12-16`);
    assert.equal(read.status, 200);
    assert.equal(read.value.items.find(x => x.id === id).note, 'Updated via HTTP');
    assert.equal((await request(`${prefix}?from=bad&to=2026-12-16`)).status, 400);
    const cancelled = await request(`${prefix}/${id}`, 'PATCH', { status: 'cancelled', version: 2, reason: 'HTTP cancellation', requestKey: randomUUID() });
    assert.equal(cancelled.status, 200);
    const persisted = await pool.query('SELECT status,version FROM staff_schedules WHERE id=$1', [id]);
    assert.deepEqual(persisted.rows[0], { status: 'cancelled', version: 3 });
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM staff_schedule_events WHERE schedule_id=$1', [id])).rows[0].n, 3);
    console.log('SCHEDULE HTTP CRUD: PASS cookie-origin guards, create/replay/overlap, edit/stale, GET/readback, invalid range, cancellation and DB history.');
  } finally { await pool.end(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
