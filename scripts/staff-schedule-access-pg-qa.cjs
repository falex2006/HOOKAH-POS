'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const { config, folder, options } = require('./staff-schedule-local-config.cjs');
const { resolveAccess, setGrant } = require('../staff-schedule-access');
async function main() {
  const c = config();
  const f = JSON.parse(fs.readFileSync(path.join(folder, 'fixtures.json'), 'utf8'));
  const pool = new Pool(options(c));
  const actor = index => ({ userId: f.users[index].id, venueId: f.venues[f.users[index].tenant] });
  const owner = actor(0), manager = actor(2), otherOwner = actor(4);
  try {
    const scopesBefore = (await pool.query('SELECT permission_scopes FROM users WHERE id=$1', [manager.userId])).rows[0].permission_scopes;
    const current = (await pool.query('SELECT version FROM staff_schedule_grants WHERE venue_id=$1 AND user_id=$2', [manager.venueId, manager.userId])).rows[0];
    let revision = current?.version || 0;
    const write = access => setGrant(pool, owner, { userId: manager.userId, access, version: revision });
    const reset = await write('none'); revision = reset.version;
    assert.equal((await resolveAccess(pool, manager)).view, false);
    await assert.rejects(() => setGrant(pool, manager, { userId: manager.userId, access: 'manage', version: revision }), e => e.status === 403);
    await assert.rejects(() => setGrant(pool, otherOwner, { userId: manager.userId, access: 'manage', version: revision }), e => e.status === 404);
    const view = await write('view'); revision = view.version;
    assert.equal((await resolveAccess(pool, manager)).view, true);
    assert.equal((await resolveAccess(pool, manager)).manage, false);
    const concurrent = await Promise.allSettled([write('manage'), write('none')]);
    assert.equal(concurrent.filter(x => x.status === 'fulfilled').length, 1);
    assert.equal(concurrent.find(x => x.status === 'rejected').reason.status, 409);
    revision++;
    const manage = await write('manage'); revision = manage.version;
    assert.equal((await resolveAccess(pool, manager)).manage, true);
    assert.equal((await resolveAccess(pool, manager)).grant, false);
    const revoke = await write('none'); revision = revoke.version;
    assert.equal((await resolveAccess(pool, manager)).view, false);
    assert.deepEqual((await pool.query('SELECT permission_scopes FROM users WHERE id=$1', [manager.userId])).rows[0].permission_scopes, scopesBefore);
    const history = await pool.query('SELECT access,version FROM staff_schedule_grant_events WHERE venue_id=$1 AND user_id=$2 ORDER BY id DESC LIMIT 1', [manager.venueId, manager.userId]);
    assert.deepEqual(history.rows[0], { access: 'none', version: revision });
    console.log('SCHEDULE ACCESS POSTGRES: PASS owner grant/view/manage/revoke, self-escalation denied, foreign tenant denied, concurrent stale update rejected, scopes preserved, transactional history readback.');
  } finally { await pool.end(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
