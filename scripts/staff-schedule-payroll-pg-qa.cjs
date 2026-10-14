'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { config, folder, options } = require('./staff-schedule-local-config.cjs');
const { save } = require('../staff-schedule-service');
const { makePayrollAttendanceManifestService } = require('../payroll-attendance-manifest');
async function main() {
  const c = config(), f = JSON.parse(fs.readFileSync(path.join(folder, 'fixtures.json'), 'utf8'));
  const pool = new Pool(options(c));
  const venue = randomUUID(), owner = randomUUID(), employee = randomUUID();
  const principal = { userId: owner, venueId: venue };
  try {
    await pool.query('INSERT INTO venues(id,organization_id,name,timezone) VALUES($1,$2,$3,$4)', [venue, f.organizations[0], 'Schedule payroll isolated QA', 'Asia/Yekaterinburg']);
    for (const [id, role] of [[owner,'owner'],[employee,'bartender']]) await pool.query('INSERT INTO users(id,venue_id,organization_id,full_name,login,role) VALUES($1,$2,$3,$4,$5,$6)', [id,venue,f.organizations[0],`QA ${role}`,`${id}@example.test`,role]);
    const entry = { userId: employee, workDate: '2026-11-10', plannedStart: '2026-11-10T10:00+05:00', plannedEnd: '2026-11-10T18:00+05:00', breakMinutes: 30, requestKey: randomUUID(), reason: 'QA' };
    const shift = await save(pool, principal, entry);
    await pool.query(`INSERT INTO staff_work_logs(venue_id,user_id,started_at,ended_at,source) VALUES($1,$2,$3,$4,'manual')`, [venue,employee,entry.plannedStart,'2026-11-10T17:00+05:00']);
    await save(pool, principal, { userId: employee, workDate: '2026-11-11', kind: 'vacation', requestKey: randomUUID(), reason: 'QA' });
    const payroll = makePayrollAttendanceManifestService(pool);
    const period = { periodFrom: '2026-11-01', periodTo: '2026-11-30' };
    const first = await payroll.readCoverage(principal, period);
    assert.equal(first.complete, true);
    assert.equal(first.scheduleCount, 1);
    assert.equal(first.shifts[0].plannedMinutes, 450);
    assert.equal(first.shifts[0].workedMinutes, 420);
    const approved = await payroll.approveCoverage(principal, { ...period, sourceWatermark: first.sourceWatermark, reason: 'Schedule integration QA', idempotencyKey: randomUUID() });
    await save(pool, principal, { ...entry, breakMinutes: 60, version: 1, requestKey: randomUUID() }, shift.id);
    const changed = await payroll.readCoverage(principal, period);
    assert.equal(changed.stale, true);
    assert.equal(changed.shifts[0].plannedMinutes, 420);
    assert.equal(changed.currentApproval.shifts[0].plannedMinutes, 450);
    assert.equal(changed.currentApproval.approvalId, approved.approvalId);
    await save(pool, principal, { status: 'cancelled', version: 2, reason: 'QA cancellation', requestKey: randomUUID() }, shift.id);
    const cancelled = await payroll.readCoverage(principal, period);
    assert.equal(cancelled.scheduleCount, 0);
    assert.equal(cancelled.currentApproval.shifts[0].plannedMinutes, 450);
    assert.equal(cancelled.stale, true);
    assert.equal(cancelled.complete, false); // Actual work cannot silently disappear with its cancelled plan.
    console.log('SCHEDULE PAYROLL PG: PASS breaks, absence exclusion, independent actuals, stale detection, immutable approval, cancellation leaves actual work requiring review.');
  } finally { await pool.end(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
