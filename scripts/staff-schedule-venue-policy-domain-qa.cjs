'use strict';

const assert = require('node:assert/strict');
const { evaluateVenuePolicy } = require('../staff-schedule-venue-policy');

const userId = '11111111-1111-4111-8111-111111111111';
const scheduleId = '22222222-2222-4222-8222-222222222222';
const venueId = '33333333-3333-4333-8333-333333333333';
const start = '2036-01-13T11:00:00.000Z'; // Sunday 16:00 in Yekaterinburg
const end = '2036-01-13T20:00:00.000Z'; // Monday 01:00

function database(row) {
  return {
    async query(sql) {
      if (sql.includes('FROM staff_schedule_venue_policies')) return { rows: [{
        maxWeeklyMinutes: 30, minimumRestMinutes: null, maximumConsecutiveDays: null,
        businessHoursEnabled: false, version: 1
      }] };
      if (sql.includes('FROM staff_schedule_venue_business_intervals')) return { rows: [] };
      if (sql.includes("entity_type='venue_policy'")) return { rows: [{ version: 1 }] };
      if (sql.includes('FROM staff_schedules')) return { rows: [] };
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  };
}

async function run() {
  const base = { id: scheduleId, userId, workDate: '2036-01-13', kind: 'shift', plannedStart: start, plannedEnd: end };
  const unknown = await evaluateVenuePolicy(database(), venueId, 'Asia/Yekaterinburg',
    [{ ...base, breakMinutes: 60, breakIntervals: [] }]);
  assert.equal(unknown.warnings.filter(item => item.code === 'schedule_weekly_break_unknown').length, 2);
  assert.deepEqual(unknown.warnings.filter(item => item.code === 'schedule_max_weekly_minutes').map(item => item.weekStart).sort(),
    ['2036-01-07', '2036-01-14']);

  const placed = await evaluateVenuePolicy(database(), venueId, 'Asia/Yekaterinburg',
    [{ ...base, breakMinutes: 60, breakIntervals: [{ start: '2036-01-13T19:00:00.000Z', end: '2036-01-13T20:00:00.000Z' }] }]);
  assert.equal(placed.warnings.some(item => item.code === 'schedule_weekly_break_unknown'), false);
  assert.deepEqual(placed.warnings.filter(item => item.code === 'schedule_max_weekly_minutes').map(item => item.weekStart), ['2036-01-07']);
  console.log('VENUE POLICY DOMAIN PASS: placed breaks are charged to their actual local week; unplaced cross-week breaks are disclosed and do not create false precision.');
}

run().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
