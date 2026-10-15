'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { config, folder, options } = require('./staff-schedule-local-config.cjs');
const { saveBatch } = require('../staff-schedule-service');
async function main() {
  const c = config(), f = JSON.parse(fs.readFileSync(path.join(folder, 'fixtures.json'), 'utf8'));
  const pool = new Pool(options(c)), employee = randomUUID();
  const principal = { userId: f.users[0].id, venueId: f.venues[0] };
  try {
    await pool.query(`INSERT INTO users(id,venue_id,organization_id,full_name,login,role) VALUES($1,$2,$3,'Batch QA',$4,'bartender')`, [employee, principal.venueId, f.organizations[0], `${employee}@example.test`]);
    const item = { userId: employee, workDate: '2026-12-21', plannedStart: '2026-12-21T10:00+05:00', plannedEnd: '2026-12-21T18:00+05:00', reason: 'QA', requestKey: randomUUID() };
    const input = { requestKey: randomUUID(), items: [item, { ...item, requestKey: randomUUID() }] };
    await assert.rejects(() => saveBatch(pool, principal, {...input,items:input.items.map(item=>({...item,confirmWarnings:true}))}), e => e.code === 'schedule_overlap');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM staff_schedules WHERE user_id=$1', [employee])).rows[0].n, 0);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM staff_schedule_requests WHERE request_key=ANY($1::uuid[])', [[input.requestKey,...input.items.map(i => i.requestKey)]])).rows[0].n, 0);
    input.items[1] = { ...input.items[1], workDate: '2026-12-22', plannedStart: '2026-12-22T10:00+05:00', plannedEnd: '2026-12-22T18:00+05:00' };
    input.items=input.items.map(item=>({...item,confirmWarnings:true}));
    const result = await saveBatch(pool, principal, input);
    assert.equal(result.items.length, 2);
    const replay = await saveBatch(pool, principal, input);
    assert.deepEqual(replay.items.map(x => x.id), result.items.map(x => x.id));
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM staff_schedules WHERE user_id=$1', [employee])).rows[0].n, 2);
    console.log('SCHEDULE BATCH PG: PASS entire conflicting batch rolled back including request keys; valid batch persisted atomically; replay has no duplicates.');
  } finally { await pool.end(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
