'use strict';
const assert = require('node:assert/strict');
const d = require('../staff-schedule-domain');
const shift = { userId: '10000000-0000-4000-8000-000000000001', workDate: '2026-10-13', plannedStart: '2026-10-13T20:00+05:00', plannedEnd: '2026-10-14T04:00+05:00', breakMinutes: 30 };
let checks = 0;
const reject = (input, code) => { assert.throws(() => d.normalize(input, 'Asia/Yekaterinburg'), error => error.code === code); checks++; };
const valid = d.normalize(shift, 'Asia/Yekaterinburg');
assert.equal((Date.parse(valid.plannedEnd) - Date.parse(valid.plannedStart)) / 60000 - valid.breakMinutes, 450); checks++;
reject({ ...shift, workDate: '2026-02-30' }, 'schedule_date_invalid');
reject({ ...shift, plannedStart: '2026-10-13T24:00+05:00' }, 'schedule_time_invalid');
reject({ ...shift, plannedStart: '2026-10-13T20:00' }, 'schedule_time_invalid');
reject({ ...shift, plannedEnd: shift.plannedStart }, 'schedule_duration_invalid');
reject({ ...shift, plannedEnd: '2026-10-15T04:00+05:00' }, 'schedule_duration_invalid');
reject({ ...shift, breakMinutes: 480 }, 'schedule_break_invalid');
reject({ ...shift, breakMinutes: '30' }, 'schedule_break_invalid');
reject({ ...shift, workDate: '2026-10-14' }, 'schedule_start_date_mismatch');
reject({ ...shift, kind: 'sick' }, 'schedule_absence_time_forbidden');
reject({ ...shift, note: 'x'.repeat(501) }, 'schedule_note_invalid');
assert.equal(d.normalize({ userId: shift.userId, workDate: shift.workDate, kind: 'vacation' }, 'Asia/Yekaterinburg').plannedStart, null); checks++;
for (const role of ['owner', 'admin', 'manager', 'bartender', 'developer', 'platform_owner']) {
  for (const grant of [null, 'view', 'manage']) {
    const actual = d.capabilities(role, grant);
    const eligible = ['admin', 'manager'].includes(role);
    assert.equal(actual.view, role === 'owner' || (eligible && grant !== null));
    assert.equal(actual.manage, role === 'owner' || (eligible && grant === 'manage'));
    assert.equal(actual.grant, role === 'owner'); checks++;
  }
}
assert.throws(() => d.range('2026-10-14', '2026-10-13')); checks++;
assert.throws(() => d.range('2026-01-01', '2026-12-31')); checks++;
assert.throws(() => d.version(0)); checks++;
assert.equal(d.version(1), 1); checks++;
console.log(`SCHEDULE DOMAIN: PASS (${checks} cases; not API or PostgreSQL acceptance)`);
