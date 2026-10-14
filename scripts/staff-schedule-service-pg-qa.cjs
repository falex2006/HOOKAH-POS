'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { config, folder, options } = require('./staff-schedule-local-config.cjs');
const service = require('../staff-schedule-service');
async function main() {
  const c = config(), f = JSON.parse(fs.readFileSync(path.join(folder, 'fixtures.json'), 'utf8'));
  const pool = new Pool(options(c));
  const principal = { userId: f.users[0].id, venueId: f.venues[0] };
  // Each run uses its own synthetic employee, preserving earlier history and unrelated fixtures.
  const employee = randomUUID();
  try {
    await pool.query(`INSERT INTO users(id,venue_id,organization_id,full_name,login,role) VALUES($1,$2,$3,'Schedule service QA',$4,'bartender')`, [employee, f.venues[0], f.organizations[0], `service-${employee}@example.test`]);
    const entry = { userId: employee, workDate: '2026-11-10', kind: 'shift', plannedStart: '2026-11-10T20:00+05:00', plannedEnd: '2026-11-11T04:00+05:00', breakMinutes: 30, reason: 'synthetic QA', requestKey: randomUUID() };
    const created = await service.save(pool, principal, entry);
    assert.equal(created.version, 1);
    assert.equal((await service.save(pool, principal, entry)).id, created.id);
    await assert.rejects(() => service.save(pool, principal, { ...entry, note: 'changed' }), e => e.code === 'schedule_request_conflict');
    await assert.rejects(() => service.save(pool, principal, { ...entry, requestKey: randomUUID() }), e => e.code === 'schedule_overlap');
    const adjacent = await service.save(pool, principal, { ...entry, plannedStart: '2026-11-10T12:00+05:00', plannedEnd: entry.plannedStart, requestKey: randomUUID() });
    assert.notEqual(adjacent.id, created.id);
    const edit = { ...entry, version: 1, note: 'edited', requestKey: randomUUID() };
    const outcomes = await Promise.allSettled([service.save(pool, principal, edit, created.id), service.save(pool, principal, { ...edit, requestKey: randomUUID() }, created.id)]);
    assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 1);
    assert.equal(outcomes.find(x => x.status === 'rejected').reason.code, 'schedule_version_conflict');
    const cancelled = await service.save(pool, principal, { status: 'cancelled', version: 2, reason: 'QA cancellation', requestKey: randomUUID() }, created.id);
    assert.equal(cancelled.status, 'cancelled');
    await assert.rejects(() => service.save(pool, principal, { userId: employee, workDate: entry.workDate, kind: 'vacation', reason: 'QA', requestKey: randomUUID() }), e => e.code === 'schedule_overlap');
    const read = await service.list(pool, principal, entry.workDate, '2026-11-11');
    assert.ok(read.items.some(x => x.id === created.id && x.status === 'cancelled'));
    const events = await pool.query('SELECT count(*)::int AS count FROM staff_schedule_events WHERE schedule_id=$1', [created.id]);
    assert.equal(events.rows[0].count, 3);
    const foreign = { userId: f.users[4].id, venueId: f.venues[1] };
    await assert.rejects(() => service.save(pool, foreign, { ...edit, requestKey: randomUUID() }, created.id), e => e.status === 404);
    console.log('SCHEDULE SERVICE PG: PASS create/replay, key conflict, overlap, adjacent multi-shift, concurrent version conflict, soft cancel/history, absence conflict, tenant denial, readback.');
  } finally { await pool.end(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
