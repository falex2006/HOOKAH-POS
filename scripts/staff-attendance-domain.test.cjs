'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { evaluate, policy, reason } = require('../staff-attendance-domain');
const shift = { id: 'morning', userId: 'employee', kind: 'shift', status: 'planned', plannedStart: '2026-10-15T10:00:00+05:00', plannedEnd: '2026-10-15T18:00:00+05:00' };
const check = (time, mode = 'approval', shifts = [shift], extra = {}) => evaluate({ settings: { mode, preparationMinutes: 30 }, userId: 'employee', now: `2026-10-15T${time}+05:00`, shifts, ...extra });
test('default preserves unrestricted admission, not cash or payroll authority', () => {
  assert.deepEqual(policy(), { mode: 'free', preparationMinutes: 0 });
  assert.equal(check('09:00:00', 'free').decision, 'allow');
});
test('preparation boundary inclusive; plan unchanged; no mutation', () => {
  const before = JSON.stringify(shift);
  assert.equal(check('09:29:59').decision, 'approval_required');
  const result = check('09:30:00');
  assert.equal(result.basis, 'preparation');
  assert.equal(result.plannedStart, '2026-10-15T05:00:00.000Z');
  assert.equal(result.lateMinutes, 0);
  assert.equal(JSON.stringify(shift), before);
});
test('late arrival is admitted until end; end is exclusive', () => {
  assert.equal(check('10:15:00').lateMinutes, 15);
  assert.equal(check('17:59:59').decision, 'allow');
  assert.equal(check('18:00:00').decision, 'approval_required');
});
test('warning requires reason; approval never silently admits', () => {
  assert.equal(check('09:00:00', 'warn').decision, 'reason_required');
  assert.equal(check('09:00:00').decision, 'approval_required');
  assert.throws(() => reason('  '));
  assert.equal(reason(' Замена коллеги '), 'Замена коллеги');
});
test('draft/cancelled/absence/open shifts cannot authorize work', () => {
  for (const replacement of [{ status: 'draft' }, { status: 'cancelled' }, { kind: 'sick' }, { kind: 'day_off' }, { kind: 'open_shift', userId: null }]) {
    assert.equal(check('11:00:00', 'approval', [{ ...shift, ...replacement }]).decision, 'approval_required');
  }
});
test('overnight and month transition use absolute instants', () => {
  const result = evaluate({ settings: policy(), userId: 'employee', now: '2026-11-01T02:00:00+05:00', shifts: [{ ...shift, plannedStart: '2026-10-31T22:00:00+05:00', plannedEnd: '2026-11-01T06:00:00+05:00' }] });
  assert.equal(result.basis, 'scheduled');
});
test('published per-shift override supports zero and overrides venue', () => {
  assert.equal(check('09:30:00', 'approval', [{ ...shift, preparationMinutes: 0 }]).decision, 'approval_required');
  assert.equal(check('09:00:00', 'approval', [{ ...shift, preparationMinutes: 60 }]).basis, 'preparation');
});
test('split shifts do not authorize the gap; running shift takes priority', () => {
  const later = { ...shift, id: 'later', plannedStart: '2026-10-15T18:15:00+05:00', plannedEnd: '2026-10-15T23:00:00+05:00' };
  assert.equal(check('17:50:00', 'approval', [later, shift]).scheduleId, shift.id);
  assert.equal(check('13:00:00', 'approval', [{ ...shift, plannedEnd: '2026-10-15T12:00:00+05:00' }, later]).decision, 'approval_required');
});
test('unavailable schedule is never treated as unscheduled', () => {
  for (const mode of ['free', 'warn', 'approval']) assert.throws(() => check('10:00:00', mode, [], { scheduleAvailable: false }), error => error.status === 503);
});
test('invalid config and ambiguous local timestamps rejected', () => {
  for (const minutes of [-1, 241, 0.5, '30', null]) assert.throws(() => policy({ mode: 'free', preparationMinutes: minutes }));
  assert.throws(() => policy({ mode: 'strict', preparationMinutes: 0 }));
  assert.throws(() => check('10:00:00', 'free', [{ ...shift, plannedStart: '2026-10-15T10:00:00' }]));
});
test('another employee shift never authorizes this employee', () => {
  assert.equal(check('10:00:00', 'approval', [{ ...shift, userId: 'colleague' }]).decision, 'approval_required');
  assert.throws(() => check('10:00:00', 'free', [], { userId: null }));
});
test('calendar rollover and invalid wall clock input rejected', () => {
  for (const now of ['2026-02-30T10:00:00Z', '2026-10-15T24:00:00Z', '2026-10-15T10:00:00+14:30', '2026-10-15T10:00:60Z']) {
    assert.throws(() => check('10:00:00', 'free', [], { now }));
  }
});
