'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveAttendanceAccess } = require('../staff-attendance-access');
const principal = { userId: '10000000-0000-4000-8000-000000000001', venueId: '20000000-0000-4000-8000-000000000001' };
const db = row => ({ query: async () => ({ rows: row ? [row] : [] }) });
test('owner controls policy and grants, sibling venue is not personal clock-in', async () => {
  const access = await resolveAttendanceAccess(db({ role: 'owner', homeVenueId: 'sibling' }), principal);
  assert.equal(access.grant, true);
  assert.equal(access.managePolicy, true);
  assert.equal(access.approve, true);
  assert.equal(access.closeSessions, true);
  assert.equal(access.self, false);
});
test('manager needs each independent grant and cannot delegate', async () => {
  const row = { role: 'manager', homeVenueId: principal.venueId, managePolicy: false, approve: true };
  const access = await resolveAttendanceAccess(db(row), principal);
  assert.equal(access.self, true);
  assert.equal(access.approve, true);
  assert.equal(access.managePolicy, false);
  assert.equal(access.grant, false);
  assert.equal(access.closeSessions, false);
});
test('staff cannot gain management capabilities from stale privileged grants', async () => {
  const access = await resolveAttendanceAccess(db({ role: 'bartender', homeVenueId: principal.venueId, managePolicy: true, approve: true, closeSessions: true }), principal);
  assert.equal(access.self, true);
  assert.equal(access.approve, false);
  assert.equal(access.managePolicy, false);
  assert.equal(access.closeSessions, false);
});

test('closeSessions is independent and only explicitly delegated to admin/manager', async () => {
  for (const role of ['admin','manager']) {
    const access = await resolveAttendanceAccess(db({role,homeVenueId:principal.venueId,closeSessions:true}),principal);
    assert.equal(access.closeSessions,true);
    assert.equal(access.approve,false);
    assert.equal(access.managePolicy,false);
    assert.equal(access.grant,false);
    assert.equal((await resolveAttendanceAccess(db({role,closeSessions:'true'}),principal)).closeSessions,false);
  }
});
test('unresolved account and invalid principal denied', async () => {
  await assert.rejects(resolveAttendanceAccess(db(null), principal), error => error.status === 403);
  await assert.rejects(resolveAttendanceAccess(db(null), {}), error => error.status === 403);
});
