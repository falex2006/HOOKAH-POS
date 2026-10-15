'use strict';
// Bounded unit/static contract. No browser, DOM implementation, HTTP, DB or writes.
// Executes extracted production methods against small control models; static hooks
// deliberately fail closed when source structure changes and need review.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const ui = fs.readFileSync(path.join(root, 'staff-schedule-ui.js'), 'utf8');
const planning = fs.readFileSync(path.join(root, 'staff-schedule-planning-ui.js'), 'utf8');
let checks = 0;
function between(source, start, end) {
  const a = source.indexOf(start);
  assert.ok(a >= 0, `Missing extraction start: ${start}`);
  const b = source.indexOf(end, a + start.length);
  assert.ok(b > a, `Missing extraction end: ${end}`);
  return source.slice(a, b);
}
const pendingMethod = between(ui, '        pending(value) {', '\n        error(text)')
  .trim().replace(/,$/, '');
function control(disabled = false) {
  return { disabled, isConnected: true, refreshes: [],
    _customSelectRefresh() { this.refreshes.push(this.disabled); } };
}
function model(controls) {
  const node = { querySelectorAll: () => controls, contains: c => controls.includes(c) };
  const d = vm.runInNewContext(`let busy=false; let disabledBeforePending=new Map();
    ({${pendingMethod}})`, { node }, { timeout: 1000 });
  d.error = () => {};
  return d;
}
async function check(name, run) {
  await run(); checks++; console.log(`PASS ${name}`);
}
async function main() {
  await check('semantic disabled and enabled submit restored; custom selects refreshed', () => {
    const submit = control(), readonly = control(true), d = model([submit, readonly]);
    d.pending(true);
    assert.equal(submit.disabled, true); assert.equal(readonly.disabled, true);
    d.pending(false);
    assert.equal(submit.disabled, false); assert.equal(readonly.disabled, true);
    assert.deepEqual(submit.refreshes, [true, false]);
    assert.deepEqual(readonly.refreshes, [true, true]);
  });
  await check('repeated true preserves original snapshot; repeated false is harmless', () => {
    const submit = control(), d = model([submit]);
    d.pending(true); d.pending(true); d.pending(false); d.pending(false);
    assert.equal(submit.disabled, false);
    submit.disabled = true; d.pending(true); d.pending(false);
    assert.equal(submit.disabled, true, 'next cycle must use a fresh snapshot');
  });
  await check('replacement/new controls retain renderer disabled state', () => {
    const removed = control(), controls = [removed], d = model(controls);
    d.pending(true);
    removed.isConnected = false;
    const enabled = control(), forbidden = control(true);
    controls.splice(0, 1, enabled, forbidden);
    d.pending(false);
    assert.equal(enabled.disabled, false); assert.equal(forbidden.disabled, true);
    assert.equal(removed.disabled, true, 'detached controls are not restored');
    assert.deepEqual(forbidden.refreshes, []);
  });
  // Run the actual caller bodies together with the extracted pending method.
  const functionsCaller = between(planning, '      save.onclick=async()=>{',
    "      d.node.querySelector('[data-add-availability-rule]')");
  const availabilityCaller = between(planning, '      saveAvailability.onclick=async()=>{',
    "      d.node.querySelector('[data-add-function]')");
  for (const kind of ['functions', 'availability']) {
    for (const fail of [true, false]) {
      await check(`${kind} caller: ${fail ? 'failure permits retry' : 'success disables clean save'}`, async () => {
        const save = control(), saveAvailability = control(), protectedControl = control(true);
        const d = model([save, saveAvailability, protectedControl]);
        let calls = 0;
        const context = {
          save, saveAvailability, d, employeeState: { userId: 'employee', version: 1 },
          availabilityState: { userId: 'employee', version: 1 },
          assignments: { querySelectorAll: () => [], querySelector: () => ({ value: '' }) },
          rulesNode: { querySelectorAll: () => [] }, exceptionsNode: { querySelectorAll: () => [] },
          crypto: { randomUUID: () => 'unit-request-key' },
          api: async () => { calls++; if (fail) throw new Error('synthetic failure'); return { userId: 'employee', version: 2 }; },
          loadEmployee: async () => { save.disabled = true; },
          renderAvailability: () => { saveAvailability.disabled = true; }
        };
        vm.runInNewContext(kind === 'functions' ? functionsCaller : availabilityCaller,
          context, { timeout: 1000 });
        const button = kind === 'functions' ? save : saveAvailability;
        await button.onclick();
        assert.equal(calls, 1); assert.equal(button.disabled, !fail);
        assert.equal(protectedControl.disabled, true);
        if (fail) { await button.onclick(); assert.equal(calls, 2); assert.equal(button.disabled, false); }
      });
    }
  }
  await check('planning structural removals dispatch dirty/idempotency events', () => {
    const markSource = between(planning, '    const markFormDirty=', '\n    function submit');
    const events = [], form = { dispatchEvent: e => events.push([e.type, e.bubbles]) };
    class ModelEvent { constructor(type, options) { this.type = type; Object.assign(this, options); } }
    const context = { form, Event: ModelEvent };
    vm.runInNewContext(markSource + '\nmarkFormDirty(form);', context, { timeout: 1000 });
    assert.deepEqual(events, [['input', true], ['change', true]]);
    const operation = between(planning, '    async function editOperation(', '    function cancelOperation(');
    assert.match(operation, /\[data-remove-break\]'\)\.onclick=\(\)=>\{row\.remove\(\);markFormDirty\(form\);\}/);
    const series = between(planning, '        function editSeries(', '        d.node.querySelector(\'[data-series-create]\')');
    assert.match(series, /\[data-ex-remove\]'\)\.onclick=\(\)=>\{card\.remove\(\);markFormDirty\(form\);\}/);
    assert.match(ui, /node\.addEventListener\('input', \(\) => \{ dirty=true; \}\)/);
    const submit = between(planning, '    function submit(', '    async function reloadHome(');
    assert.match(submit, /addEventListener\('input',\(\)=>\{key=crypto\.randomUUID\(\);\}\)/);
  });
  await check('series disabled slot types are read directly, FormData precedes pending', () => {
    const submit = between(planning, '    function submit(', '    async function reloadHome(');
    assert.ok(submit.indexOf('new FormData(form)') < submit.indexOf('d.pending(true)'));
    const readSlots = between(planning, '    function readSlots(', '    function readDefinition(');
    assert.match(readSlots, /querySelector\('\[data-slot-kind\]'\)\.value/);
    const pattern = between(planning, '    function bindPattern(', '    function readPattern(');
    assert.match(pattern, /lockSlotStructure/);
    assert.match(pattern, /\[data-slot-kind\],\[data-remove-slot\]/);
    const series = between(planning, '        function editSeries(', '        d.node.querySelector(\'[data-series-create]\')');
    assert.match(series, /bindPattern\(form,functions,!!item\)/);
    assert.match(series, /person\.active\|\|person\.id===item\?\.userId/);
  });
  console.log(`UI LIFECYCLE UNIT/STATIC CONTRACT: PASS (${checks} checks). Not browser, HTTP, PostgreSQL or full lifecycle acceptance.`);
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
