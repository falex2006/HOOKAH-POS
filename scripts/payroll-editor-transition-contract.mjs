import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../payroll-scheme-ui.js', import.meta.url), 'utf8');
const helperStart = source.indexOf('  const payrollEditorStateChanged =');
const helperEnd = source.indexOf('  let venueTimezone =', helperStart);
assert(helperStart >= 0 && helperEnd > helperStart, 'transition helpers are present');
const helperContext = {};
vm.runInNewContext(source.slice(helperStart, helperEnd), helperContext);
const changed = vm.runInNewContext('payrollEditorStateChanged', helperContext);
const makeGate = vm.runInNewContext('createPayrollEditorTransitionGate', helperContext);

const baseline = { definition: '{"rate":10}', gridDirty: false, sourcePolicy: 'default', acknowledged: false };
assert.equal(changed(baseline, { ...baseline }), false, 'unchanged editor state is clean');
for (const field of Object.keys(baseline)) {
  assert.equal(changed(baseline, { ...baseline, [field]: field === 'gridDirty' ? true : 'changed' }), true,
    `${field} changes mark the editor dirty`);
}
assert.equal(changed(null, baseline), false, 'no editor baseline is clean');

let decisions = 0;
const rejectGate = makeGate(async () => { decisions += 1; return false; });
assert.equal(await rejectGate.begin(true), null, 'declining discard cancels replacement');
assert.equal(decisions, 1);
assert.equal(await rejectGate.begin(false), 2, 'the next transition receives a monotonic token');

let resolveConfirm;
const pendingGate = makeGate(() => new Promise((resolve) => { resolveConfirm = resolve; }));
const staleConfirmation = pendingGate.begin(true);
const newerTransition = await pendingGate.begin(false);
resolveConfirm(true);
assert.equal(await staleConfirmation, null, 'a late confirmation cannot supersede a newer intent');
assert.equal(pendingGate.isCurrent(newerTransition), true);

const raceGate = makeGate(async () => true);
let resolveA;
let resolveB;
const loadA = new Promise((resolve) => { resolveA = resolve; });
const loadB = new Promise((resolve) => { resolveB = resolve; });
const tokenA = await raceGate.begin(false);
const requestA = loadA.then((value) => { if (raceGate.isCurrent(tokenA)) return value; return null; });
const tokenB = await raceGate.begin(false);
const requestB = loadB.then((value) => { if (raceGate.isCurrent(tokenB)) return value; return null; });
resolveB('version-B');
assert.equal(await requestB, 'version-B');
resolveA('version-A');
assert.equal(await requestA, null, 'the late A response is discarded after B was selected');

// Execute the production transitions, not a second implementation of their
// guards. Only DOM controls, HTTP requests and confirmation UI are substituted.
const extract = (startText, endText) => {
  const start = source.indexOf(startText);
  const end = source.indexOf(endText, start);
  assert(start >= 0 && end > start, `production section exists: ${startText.trim()}`);
  return source.slice(start, end);
};
const editorHelpers = extract('    const editorStateSnapshot =', '    const renderList =');
const openVersionSource = extract('    const openVersion = async', '    const showEditor = async');
const cancelMatch = source.match(/if \(button\.matches\('\[data-scheme-editor-cancel\]'\)\) \{ ([^\n]+?) return; \}/);
assert(cancelMatch, 'explicit cancel handler is present');
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const makeEditorHarness = (decide = async () => false) => {
  const requests = new Map(), controls = new Map(), confirmations = [], notifications = [];
  const field = (value = '') => ({ value, checked: false, disabled: false });
  const context = {
    nameField: field('Original draft'), descriptionField: field('Draft description'),
    definitionField: field('{"rate":10}'), payoutRiskAcknowledgementField: field(),
    personalCapField: field(), gridDirty: false, sourcePolicyDirty: false,
    rawGridFields: () => [], rawGridOverrides: () => [], sourcePolicyControls: () => ({}),
    editorAction: { kind: 'edit', versionId: 'original' }, editorBaseline: null,
    selectedVersion: { versionId: 'original' }, editor: { hidden: false },
    previewBox: { hidden: true }, previewInput: field('{}'), previewResult: { hidden: true },
    payoutRiskAcknowledgementLabel: { hidden: false },
    panel: { querySelector(selector) {
      if (!controls.has(selector)) controls.set(selector, {});
      return controls.get(selector);
    } },
    portalConfirm: async (...args) => { confirmations.push(args); return decide(...args); },
    request: (url) => {
      const pendingRequest = requests.get(url);
      assert(pendingRequest, `expected HTTP request: ${url}`);
      pendingRequest.started.resolve();
      return pendingRequest.response.promise;
    },
    // Serialization is immaterial to transition ordering, while assigning the
    // loaded definition remains the real openVersion implementation.
    definitionFromVersion: version => ({ rate: version.rate }),
    editorStatusLabel: status => status,
    invalidateReadiness() {}, rebuildGrid() {}, refreshReadiness() {}, selectWorkspace() {},
    notify: (...args) => notifications.push(args)
  };
  vm.createContext(context);
  vm.runInContext(source.slice(helperStart, helperEnd) + editorHelpers + openVersionSource
    + `\neditorBaseline = editorStateSnapshot();\n`
    + `globalThis.transitions = { openVersion, allowLoadedEditorReplacement, `
    + `cancel: () => { ${cancelMatch[1]} } };`, context);
  return {
    context, confirmations, notifications, ...context.transitions,
    queue(versionId) {
      const queued = { started: deferred(), response: deferred() };
      requests.set(`/api/payroll/versions/${encodeURIComponent(versionId)}`, queued);
      return queued;
    }
  };
};
const loadedVersion = (id, rate = 25) => ({ versionId: id, name: `Version ${id}`, versionNo: 2, status: 'draft', rate });

for (const consent of [false, true]) {
  const harness = makeEditorHarness(async () => consent);
  const queued = harness.queue('late-edit');
  const opening = harness.openVersion('late-edit');
  await queued.started.promise;
  assert.equal(harness.confirmations.length, 0, 'clean editor needs no initial confirmation');
  harness.context.definitionField.value = '{"rate":77}';
  queued.response.resolve(loadedVersion('late-edit'));
  assert.equal(await opening, consent, `late edit replacement follows ${consent ? 'acceptance' : 'decline'}`);
  assert.equal(harness.confirmations.length, 1, 'an edit during HTTP loading requires confirmation after loading');
  assert.equal(harness.context.definitionField.value,
    consent ? JSON.stringify({ rate: 25 }, null, 2) : '{"rate":77}',
    'declining preserves the new edit; accepting loads the requested version');
  assert.equal(harness.context.selectedVersion.versionId, consent ? 'late-edit' : 'original');
  assert.equal(harness.notifications.length, consent ? 1 : 0, 'cancelled replacement publishes no success');
}

{
  const harness = makeEditorHarness();
  const old = harness.queue('A'), latest = harness.queue('B');
  const openingA = harness.openVersion('A');
  await old.started.promise;
  const openingB = harness.openVersion('B');
  await latest.started.promise;
  latest.response.resolve(loadedVersion('B'));
  assert.equal(await openingB, true);
  const messagesAfterB = JSON.stringify(harness.notifications);
  old.response.reject(new Error('stale_A_network_error'));
  assert.equal(await openingA, false, 'obsolete HTTP failure is swallowed before the outer UI catch');
  assert.equal(harness.context.selectedVersion.versionId, 'B');
  assert.equal(harness.context.nameField.value, 'Version B');
  assert.equal(JSON.stringify(harness.notifications), messagesAfterB, 'obsolete failure cannot replace the latest success');
}

{
  const harness = makeEditorHarness();
  const queued = harness.queue('current-error');
  const opening = harness.openVersion('current-error');
  await queued.started.promise;
  queued.response.reject(new Error('current_network_error'));
  await assert.rejects(opening, /current_network_error/, 'a current failure remains visible to the outer UI handler');
}

for (const failRequest of [false, true]) {
  const harness = makeEditorHarness();
  const queued = harness.queue('cancelled');
  const opening = harness.openVersion('cancelled');
  await queued.started.promise;
  harness.cancel();
  if (failRequest) queued.response.reject(new Error('cancelled_network_error'));
  else queued.response.resolve(loadedVersion('cancelled'));
  assert.equal(await opening, false, 'explicit cancel invalidates both successful and failed pending requests');
  assert.equal(harness.context.editor.hidden, true);
  assert.equal(harness.context.selectedVersion, null);
  assert.equal(harness.context.editorAction, null);
  assert.equal(harness.context.editorBaseline, null);
  assert.equal(harness.notifications.length, 0, 'cancelled request does not reopen or notify');
}

{
  const decision = deferred(), confirming = deferred();
  const harness = makeEditorHarness(() => { confirming.resolve(); return decision.promise; });
  const queued = harness.queue('cancel-confirmation');
  const opening = harness.openVersion('cancel-confirmation');
  await queued.started.promise;
  harness.context.definitionField.value = '{"rate":99}';
  queued.response.resolve(loadedVersion('cancel-confirmation'));
  await confirming.promise;
  harness.cancel();
  decision.resolve(true);
  assert.equal(await opening, false, 'cancel also invalidates a pending post-load discard confirmation');
  assert.equal(harness.context.definitionField.value, '{"rate":99}');
  assert.equal(harness.context.editor.hidden, true);
  assert.equal(harness.context.selectedVersion, null);
}

assert.match(source, /const editorHasUnsavedChanges = \(\) => Boolean\(editorAction[\s\S]*?editorStateSnapshot\(\)\)/);
assert.match(source, /const openVersion = async \(versionId, transitionToken = null\) => \{[\s\S]*?await request\([\s\S]*?if \(!editorTransition\.isCurrent\(token\)\) return false;/);
assert.match(source, /if \(button\.matches\('\[data-scheme-new-version\]'\)\) \{[\s\S]*?await beginEditorTransition\(\)[\s\S]*?await request\([\s\S]*?if \(!editorTransition\.isCurrent\(transitionToken\)\) return;/);
assert.match(source, /data-scheme-workspace[\s\S]*?selectWorkspace\(button\.dataset\.schemeWorkspace/);
console.log('PASS payroll editor transition contract: dirty fields, actual openVersion late-edit decline/accept, stale HTTP failure, current error, cancel invalidation, and hide-only workspace navigation');
