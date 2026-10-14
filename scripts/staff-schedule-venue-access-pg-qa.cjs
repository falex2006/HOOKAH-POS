'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { config, folder, options } = require('./staff-schedule-local-config.cjs');
const { resolveAccess } = require('../staff-schedule-access');
async function main() {
  const pool = new Pool(options(config()));
  const f = JSON.parse(fs.readFileSync(path.join(folder, 'fixtures.json'), 'utf8'));
  const db = await pool.connect();
  const legacy = () => randomUUID().replace(/^(........-....)-....-..../, '$1-0000-0000');
  const venue = legacy(), owner = legacy();
  try {
    await db.query('BEGIN');
    await db.query('INSERT INTO venues(id,organization_id,name,timezone) VALUES($1,$2,$3,$4)', [venue,f.organizations[0],'Transactional legacy UUID QA','Asia/Yekaterinburg']);
    await db.query("INSERT INTO users(id,venue_id,organization_id,full_name,login,role) VALUES($1,$2,$3,'Legacy UUID QA',$4,'owner')", [owner,venue,f.organizations[0],`${owner}@example.test`]);
    assert.equal((await resolveAccess(db,{userId:owner,venueId:venue},true)).grant,true);
    assert.equal((await resolveAccess(db,{userId:f.users[0].id,venueId:venue},true)).manage,true);
    assert.equal((await resolveAccess(db,{userId:owner,venueId:f.venues[0]},true)).manage,true);
    for (const userId of [f.users[1].id,f.users[2].id,f.users[4].id]) {
      await assert.rejects(resolveAccess(db,{userId,venueId:venue},true), e=>e.code==='schedule_forbidden');
    }
    await db.query('UPDATE venues SET is_active=false WHERE id=$1',[venue]);
    await assert.rejects(resolveAccess(db,{userId:owner,venueId:venue}), e=>e.code==='schedule_forbidden');
    console.log('SCHEDULE VENUE ACCESS PG: PASS legacy UUIDs, owner same-organization venue, foreign organization and non-owner denied, inactive venue denied; fixtures rolled back.');
  } finally { await db.query('ROLLBACK'); db.release(); await pool.end(); }
}
main().catch(error=>{ console.error(error.message); process.exitCode=1; });
