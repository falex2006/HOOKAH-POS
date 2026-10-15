'use strict';
// Pure unit contracts only; no browser, database or filesystem writes.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalize } = require('../staff-schedule-domain');
const pattern = require('../staff-schedule-pattern');
const series = require('../staff-schedule-series-domain');
const userId = '10000000-0000-4000-8000-000000000001';
const day = '2035-01-01', timezone = 'UTC';
const slot = { kind: 'shift', startTime: '10:00', endTime: '18:00' };
const recurrence = { type: 'weekdays', weekdays: [1,2,3,4,5,6,7] };
const entry = { userId, workDate: day, plannedStart: `${day}T10:00Z`, plannedEnd: `${day}T18:00Z` };
test('normalize preserves omitted/null/zero/positive as distinct inputs', () => {
  assert.equal(Object.hasOwn(normalize(entry, timezone), 'preparationMinutes'), false);
  for (const preparationMinutes of [null, 0, 30, 240]) {
    assert.equal(normalize({ ...entry, preparationMinutes }, timezone).preparationMinutes, preparationMinutes);
  }
});
test('invalid preparation and absence overrides are rejected', () => {
  for (const preparationMinutes of [-1, 241, 1.5, '30', false, {}, []]) {
    assert.throws(() => normalize({ ...entry, preparationMinutes }, timezone), { code: 'schedule_preparation_invalid' });
    assert.throws(() => pattern.definition({ pattern: recurrence, slots: [{ ...slot, preparationMinutes }] }), { code: 'schedule_preparation_invalid' });
  }
  assert.throws(() => normalize({ userId, workDate: day, kind: 'sick', preparationMinutes: 0 }, timezone), { code: 'schedule_absence_preparation_forbidden' });
  assert.throws(() => pattern.definition({ pattern: recurrence, slots: [{ kind: 'sick', preparationMinutes: 30 }] }), { code: 'schedule_absence_preparation_forbidden' });
});
test('legacy slot byte shape stays unchanged when field omitted', () => {
  assert.deepEqual(pattern.definition({ pattern: recurrence, slots: [slot] }).slots[0], {
    ...slot, endDayOffset: 0, breakMinutes: 0, note: '', functionId: null
  });
});
test('legacy, selected and team templates expand frozen optional values', () => {
  for (const preparationMinutes of [null, 0, 45]) {
    const definition = { pattern: recurrence, slots: [{ ...slot, preparationMinutes }] };
    for (const variant of [definition, { ...definition, schemaVersion: 2, mode: 'selected' }, {
      schemaVersion: 2, mode: 'team', pattern: recurrence, members: [{ userId, slots: definition.slots }]
    }]) {
      const source = structuredClone(variant);
      const before = JSON.stringify(source);
      const result = pattern.expand({ from: day, to: day, userIds: [userId], definition: source }, timezone);
      assert.equal(result[0].payload.preparationMinutes, preparationMinutes);
      assert.equal(JSON.stringify(source), before);
      source.schemaVersion === 2 && source.mode === 'team'
        ? source.members[0].slots[0].preparationMinutes = 60 : source.slots[0].preparationMinutes = 60;
      assert.equal(result[0].payload.preparationMinutes, preparationMinutes);
    }
  }
});
test('series recurrence and replace exception preserve zero and null', () => {
  const input = { name: 'QA', userId, anchorDate: day, untilDate: '2035-01-03',
    recurrence: { pattern: recurrence, slots: [{ ...slot, preparationMinutes: 30 }] } };
  const normalized = series.normalizeSeries(input, timezone);
  const occurrenceKey = normalized.recurrence.slotKeys[0];
  for (const preparationMinutes of [null, 0, 90]) {
    const changed = series.normalizeSeries({ ...input, recurrence: normalized.recurrence,
      exceptions: [{ occurrenceDate: day, occurrenceKey, kind: 'replace', slot: { ...slot, preparationMinutes } }] }, timezone);
    const rows = series.expandSeries(changed, day, '2035-01-02', timezone);
    assert.equal(rows[0].payload.preparationMinutes, preparationMinutes);
    assert.equal(rows[1].payload.preparationMinutes, 30);
  }
});
test('template edits preserve omitted overrides without guessing reordered slots', () => {
  const previous={pattern:recurrence,slots:[{...slot,preparationMinutes:0},{...slot,startTime:'19:00',endTime:'22:00',preparationMinutes:45}]};
  const changed={pattern:recurrence,slots:[{...slot,startTime:'19:00',endTime:'22:00',note:'moved first'}, {...slot,note:'moved second'}]};
  assert.deepEqual(pattern.definition(changed,previous).slots.map(s=>s.preparationMinutes),[45,0]);
  assert.throws(()=>pattern.definition({pattern:recurrence,slots:[slot,{...slot,startTime:'20:00',endTime:'23:00'}]},previous),{code:'schedule_preparation_slot_ambiguous'});
  assert.equal(pattern.definition({pattern:recurrence,slots:[{...slot,startTime:'11:00',preparationMinutes:null}]},previous).slots[0].preparationMinutes,null);
  assert.equal(pattern.definition({pattern:recurrence,slots:[{...slot,startTime:'11:00'}]},{pattern:recurrence,slots:[{...slot,preparationMinutes:0}]}).slots[0].preparationMinutes,0);
});
