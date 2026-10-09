import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { normalizeTableMinimumSchedule, tableMinimumWindowActive, tableMinimumWindowActiveAtClock, tableMinimumForTime, tableMinimumForClock } = require('../table-minimum-schedule.js');
const table = { minimumOrderTotal: 2500, minimumOrderStartTime: '18:00', minimumOrderEndTime: '09:00' };
const at = (iso, timezone = 'Asia/Yekaterinburg') => tableMinimumWindowActive(table, timezone, new Date(iso));

assert.deepEqual(normalizeTableMinimumSchedule('18:00', '09:00'), { minimumOrderStartTime: '18:00', minimumOrderEndTime: '09:00' });
assert.equal(normalizeTableMinimumSchedule('18:00', null), null, 'schedule requires both times');
assert.equal(normalizeTableMinimumSchedule('18:00', '18:00'), null, 'zero-length window is rejected');
assert.equal(normalizeTableMinimumSchedule('25:00', '09:00'), null, 'invalid clock time is rejected');
assert.equal(normalizeTableMinimumSchedule('18:00garbage', '09:00'), null, 'trailing data in a clock value is rejected');
assert.equal(at('2026-10-01T12:59:00.000Z'), false, 'minimum is off at 17:59 venue-local time');
assert.equal(at('2026-10-01T13:00:00.000Z'), true, 'minimum turns on at 18:00 venue-local time');
assert.equal(at('2026-10-02T03:59:00.000Z'), true, 'overnight minimum stays on through 08:59');
assert.equal(at('2026-10-02T04:00:00.000Z'), false, 'minimum turns off at 09:00');
assert.equal(tableMinimumForTime(table, 'Asia/Yekaterinburg', new Date('2026-10-01T13:00:00.000Z')), 2500);
assert.equal(tableMinimumForTime(table, 'Asia/Yekaterinburg', new Date('2026-10-01T12:59:00.000Z')), 0);
assert.equal(tableMinimumForClock(table, '17:59'), 0, 'future booking before the window has no minimum deposit');
assert.equal(tableMinimumForClock(table, '18:00'), 2500, 'future booking at the window start requires the minimum');
assert.equal(tableMinimumForClock(table, '08:59'), 2500, 'future booking in the morning still requires the minimum');
assert.equal(tableMinimumForClock(table, '09:00'), 0, 'future booking at 09:00 has no minimum deposit');
assert.equal(tableMinimumWindowActiveAtClock(table, '09:00'), false);
assert.equal(tableMinimumWindowActiveAtClock(table, '09:00garbage'), false, 'trailing data in a clock value is rejected');
assert.equal(tableMinimumForTime({ minimumOrderTotal: 1500 }, 'Asia/Yekaterinburg', new Date('2026-10-01T12:59:00.000Z')), 1500, 'legacy unscheduled minimum remains always active');
assert.equal(tableMinimumWindowActive(table, 'Europe/Moscow', new Date('2026-10-01T13:00:00.000Z')), false, 'window uses venue timezone');
const portal = await (await import('node:fs/promises')).readFile(new URL('../portal.js', import.meta.url), 'utf8');
assert.match(portal, /reservationTableMinimumAtTime\(/, 'reservation form derives minimum from booking clock');
assert.match(portal, /reservationTime\.addEventListener\('input', refreshMinimum\)/, 'reservation time edits refresh deposit rules');

console.log('Table minimum schedule QA passed (21 assertions).');
