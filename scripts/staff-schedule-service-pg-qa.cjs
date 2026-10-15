'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { config, folder, options } = require('./staff-schedule-local-config.cjs');
const service = require('../staff-schedule-service');
const {capturePolicy}=require('./staff-schedule-policy-fixture.cjs');
async function main() {
  const c = config(), f = JSON.parse(fs.readFileSync(path.join(folder, 'fixtures.json'), 'utf8'));
  const pool = new Pool(options(c));
  const principal = { userId: f.users[0].id, venueId: f.venues[0] },restorePolicy=await capturePolicy(pool,f.venues[0]);
  // Each run uses its own synthetic employee, preserving earlier history and unrelated fixtures.
  const employee = randomUUID();
  try {
    await pool.query(`INSERT INTO users(id,venue_id,organization_id,full_name,login,role) VALUES($1,$2,$3,'Schedule service QA',$4,'bartender')`, [employee, f.venues[0], f.organizations[0], `service-${employee}@example.test`]);
    await pool.query(`INSERT INTO staff_schedule_venue_policies(venue_id,max_weekly_minutes,created_by,updated_by)
      VALUES($1,1,$2,$2) ON CONFLICT(venue_id) DO UPDATE SET max_weekly_minutes=1,version=staff_schedule_venue_policies.version+1,updated_by=EXCLUDED.updated_by,updated_at=now()`,[f.venues[0],principal.userId]);
    const functionId=randomUUID(),functionName=`Archived qualification ${functionId.slice(0,8)}`;
    await pool.query('INSERT INTO staff_schedule_functions(id,venue_id,name,created_by) VALUES($1,$2,$3,$4)',[functionId,f.venues[0],functionName,principal.userId]);
    await pool.query('INSERT INTO staff_schedule_employee_functions(venue_id,user_id,function_id,created_by) VALUES($1,$2,$3,$4)',[f.venues[0],employee,functionId,principal.userId]);
    const qualifiedEntry={userId:employee,workDate:'2026-11-20',kind:'shift',plannedStart:'2026-11-20T10:00+05:00',plannedEnd:'2026-11-20T18:00+05:00',breakMinutes:0,functionId,reason:'synthetic qualification QA',requestKey:randomUUID()};
    const qualified=await service.save(pool,principal,{...qualifiedEntry,confirmWarnings:true});
    await pool.query('UPDATE staff_schedule_employee_functions SET active=false WHERE venue_id=$1 AND user_id=$2 AND function_id=$3',[f.venues[0],employee,functionId]);
    const preserved=await service.save(pool,principal,{...qualifiedEntry,version:1,note:'Edited after qualification removal',requestKey:randomUUID(),confirmWarnings:true},qualified.id);
    assert.equal(preserved.functionId,functionId);
    assert.equal((await service.get(pool,principal,qualified.id)).functionName,functionName);
    await assert.rejects(()=>service.save(pool,principal,{...qualifiedEntry,workDate:'2026-11-25',plannedStart:'2026-11-25T10:00+05:00',plannedEnd:'2026-11-25T18:00+05:00',requestKey:randomUUID()}),e=>e.code==='schedule_employee_function_required');
    const entry = { userId: employee, workDate: '2026-11-10', kind: 'shift', plannedStart: '2026-11-10T20:00+05:00', plannedEnd: '2026-11-11T04:00+05:00', breakMinutes: 30, reason: 'synthetic QA', requestKey: randomUUID() };
    const created = await service.save(pool, principal, {...entry,confirmWarnings:true});
    assert.equal(created.version, 1);
    const evidence=(await pool.query('SELECT after_data FROM staff_schedule_events WHERE schedule_id=$1 ORDER BY id DESC LIMIT 1',[created.id])).rows[0].after_data.warningConfirmation;
    assert.ok(evidence?.requestKey===entry.requestKey&&evidence.action==='create'&&evidence.actorId===principal.userId&&evidence.policyFingerprint&&evidence.availabilityFingerprint&&evidence.warningFingerprint&&evidence.reason==='synthetic QA');
    assert.equal((await service.save(pool, principal, {...entry,confirmWarnings:true})).id, created.id);
    await assert.rejects(() => service.save(pool, principal, { ...entry, note: 'changed' }), e => e.code === 'schedule_request_conflict');
    await assert.rejects(() => service.save(pool, principal, { ...entry, requestKey: randomUUID() }), e => e.code === 'schedule_overlap');
    const adjacent = await service.save(pool, principal, { ...entry, plannedStart: '2026-11-10T12:00+05:00', plannedEnd: entry.plannedStart, requestKey: randomUUID(),confirmWarnings:true });
    assert.notEqual(adjacent.id, created.id);
    const edit = { ...entry, version: 1, note: 'edited', requestKey: randomUUID(),confirmWarnings:true };
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
    console.log('SCHEDULE SERVICE PG: PASS create/replay, key conflict, overlap, adjacent multi-shift, concurrent version conflict, soft cancel/history, absence conflict, tenant denial, readback; unchanged archived qualification survives edits, new assignment remains denied.');
  } finally { await restorePolicy();await pool.end(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
