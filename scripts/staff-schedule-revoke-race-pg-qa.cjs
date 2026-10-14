'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { config, folder, options } = require('./staff-schedule-local-config.cjs');
const { setGrant } = require('../staff-schedule-access');
const { save } = require('../staff-schedule-service');
async function main() {
  const c = config(), f = JSON.parse(fs.readFileSync(path.join(folder, 'fixtures.json'), 'utf8'));
  const pool = new Pool({ ...options(c), max: 5, statement_timeout: 10000 });
  const owner = { userId: f.users[0].id, venueId: f.venues[0] };
  const manager = { userId: randomUUID(), venueId: owner.venueId };
  async function blocked(pid) {
    const until = Date.now() + 5000;
    while (Date.now() < until) {
      const result = await pool.query('SELECT cardinality(pg_blocking_pids($1)) AS count', [pid]);
      if (result.rows[0].count > 0) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('Expected actual PostgreSQL lock wait not observed');
  }
  try {
    await pool.query(`INSERT INTO users(id,venue_id,organization_id,full_name,login,role) VALUES($1,$2,$3,'Race QA manager',$4,'manager')`, [manager.userId,manager.venueId,f.organizations[0],`${manager.userId}@example.test`]);
    await setGrant(pool, owner, { userId: manager.userId, access: 'manage', version: 0 });
    const revoke = await pool.connect(), writer = await pool.connect();
    const entry = { userId: manager.userId, workDate: '2026-12-12', plannedStart: '2026-12-12T10:00+05:00', plannedEnd: '2026-12-12T18:00+05:00', reason: 'QA', requestKey: randomUUID() };
    try {
      await revoke.query('BEGIN');
      await revoke.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [manager.userId]);
      await revoke.query("UPDATE staff_schedule_grants SET access='none',version=version+1 WHERE venue_id=$1 AND user_id=$2", [manager.venueId,manager.userId]);
      const writerPid = (await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const pending = save({ connect: async () => ({ query: writer.query.bind(writer), release() {} }) }, manager, entry).then(value => ({ value }), error => ({ error }));
      await blocked(writerPid);
      await revoke.query('COMMIT');
      assert.equal((await pending).error?.code, 'schedule_forbidden');
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM staff_schedules WHERE user_id=$1', [manager.userId])).rows[0].n, 0);
    } finally { await revoke.query('ROLLBACK'); revoke.release(); writer.release(); }
    await setGrant(pool, owner, { userId: manager.userId, access: 'manage', version: 2 });
    const saving = await pool.connect(), revoking = await pool.connect();
    let entered;
    const held = new Promise(resolve => { entered = resolve; });
    let release;
    const barrier = new Promise(resolve => { release = resolve; });
    const wrapped = { connect: async () => ({
      async query(sql, args) {
        const result = await saving.query(sql, args);
        if (String(sql).includes('SELECT u.role, v.timezone')) { entered(); await barrier; }
        return result;
      }, release() {}
    }) };
    try {
      const pending = save(wrapped, manager, { ...entry, requestKey: randomUUID() });
      await held;
      const pid = (await revoking.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const revoked = setGrant({ connect: async () => ({ query: revoking.query.bind(revoking), release() {} }) }, owner,
        { userId: manager.userId, access: 'none', version: 3 });
      await blocked(pid);
      release();
      assert.ok((await pending).id);
      await revoked;
      await assert.rejects(() => save(pool, manager, { ...entry, requestKey: randomUUID() }), error => error.code === 'schedule_forbidden');
    } finally { release(); saving.release(); revoking.release(); }
    console.log('SCHEDULE REVOKE RACE: PASS both real lock orders; revoke-first denies pending write; write-first commits before revoke and subsequent writes denied.');
  } finally { await pool.end(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
