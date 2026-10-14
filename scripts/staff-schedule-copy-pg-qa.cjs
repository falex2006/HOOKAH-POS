'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { config, folder, options } = require('./staff-schedule-local-config.cjs');
const { save } = require('../staff-schedule-service');
const copy = require('../staff-schedule-copy');
async function main() {
  const c = config(), f = JSON.parse(fs.readFileSync(path.join(folder, 'fixtures.json'), 'utf8'));
  const pool = new Pool(options(c)), employee = randomUUID();
  const actor = { userId:f.users[0].id, venueId:f.venues[0] };
  try {
    await pool.query(`INSERT INTO users(id,venue_id,organization_id,full_name,login,role) VALUES($1,$2,$3,'Copy QA',$4,'bartender')`, [employee,actor.venueId,f.organizations[0],`${employee}@example.test`]);
    const source = await save(pool,actor,{userId:employee,workDate:'2026-12-07',plannedStart:'2026-12-07T20:00+05:00',plannedEnd:'2026-12-08T04:00+05:00',requestKey:randomUUID(),reason:'QA'});
    const query = {sourceFrom:'2026-12-07',targetFrom:'2026-12-14',userIds:[employee]};
    const before = await copy.preview(pool,actor,query);
    assert.equal(before.items.length,1); assert.equal(before.items[0].conflict,null);
    assert.equal(copy.wall(before.items[0].plannedStart,'Asia/Yekaterinburg'),'2026-12-14T20:00');
    assert.equal(copy.wall(before.items[0].plannedEnd,'Asia/Yekaterinburg'),'2026-12-15T04:00');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM staff_schedules WHERE user_id=$1',[employee])).rows[0].n,1);
    const input={...query,fingerprint:before.fingerprint,sourceIds:[source.id],requestKey:randomUUID()};
    const result=await copy.apply(pool,actor,input);
    assert.equal(result.items.length,1);
    assert.equal((await copy.apply(pool,actor,input)).items[0].id,result.items[0].id);
    const conflict=await copy.preview(pool,actor,query); assert.equal(conflict.items[0].conflict,'schedule_overlap');
    await assert.rejects(()=>copy.apply(pool,actor,{...input,requestKey:randomUUID()}), e=>e.code==='schedule_copy_conflict');
    await save(pool,actor,{userId:employee,workDate:'2026-12-07',plannedStart:'2026-12-07T20:00+05:00',plannedEnd:'2026-12-08T04:00+05:00',note:'changed',version:1,requestKey:randomUUID(),reason:'QA'},source.id);
    await assert.rejects(()=>copy.apply(pool,actor,{...input,requestKey:randomUUID()}),e=>e.code==='schedule_copy_source_changed');
    const pastQuery = {...query,targetFrom:'2020-12-07'};
    const past = await copy.preview(pool,actor,pastQuery);
    const pastInput = {...pastQuery,fingerprint:past.fingerprint,sourceIds:[source.id],requestKey:randomUUID()};
    for (const reason of [undefined,'   ']) await assert.rejects(()=>copy.apply(pool,actor,{...pastInput,reason}),e=>e.code==='schedule_past_reason_required');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM staff_schedules WHERE user_id=$1 AND work_date < $2',[employee,'2021-01-01'])).rows[0].n,0);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM staff_schedule_requests WHERE request_key=$1',[pastInput.requestKey])).rows[0].n,0);
    const pastResult = await copy.apply(pool,actor,{...pastInput,reason:'Восстановление согласованного графика'});
    assert.equal((await pool.query('SELECT reason FROM staff_schedule_events WHERE schedule_id=$1',[pastResult.items[0].id])).rows[0].reason,'Восстановление согласованного графика');
    assert.equal((await copy.apply(pool,actor,{...pastInput,reason:'Восстановление согласованного графика'})).items[0].id,pastResult.items[0].id);
    assert.equal(copy.instant('2026-03-30T10:00','Europe/Berlin'),'2026-03-30T08:00:00Z');
    assert.throws(()=>copy.instant('2026-03-29T02:30','Europe/Berlin'));
    assert.throws(()=>copy.instant('2026-10-25T02:30','Europe/Berlin'));
    console.log('SCHEDULE COPY PG: PASS preview, overnight, replay, conflict, stale source, DST; past requires explicit reason, rejection leaves no rows/keys, reason audit and replay verified.');
  } finally {await pool.end();}
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
