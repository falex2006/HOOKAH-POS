'use strict';
const assert=require('node:assert/strict');
const {actualTotals}=require('../staff-schedule-service');
const log=(user,start,end)=>({user_id:user,started_at:start,ended_at:end});
const rows=actualTotals([
  log('a','2026-10-01T20:00Z','2026-10-02T00:00Z'),
  log('a','2026-10-01T21:00Z','2026-10-02T01:00Z'),
  log('a','2026-10-02T01:00Z','2026-10-02T02:00Z'),
  log('a','2026-10-02T03:00Z',null),
  log('b','2026-10-02T03:00Z','2026-10-02T04:00Z'),
  log('b','2026-10-02T04:00Z','2026-10-02T03:00Z')
]);
assert.deepEqual(rows,[{userId:'a',minutes:360,openIntervals:1,invalidIntervals:0},{userId:'b',minutes:60,openIntervals:0,invalidIntervals:1}]);
assert.deepEqual(actualTotals([]),[]);
console.log('SCHEDULE ACTUAL TOTALS: PASS union overlap/adjacency, overnight, separate employees, open/invalid counts, empty.');
