import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../portal.js', import.meta.url), 'utf8');
const start = source.indexOf('  const reservationDialog =');
const end = source.indexOf('  const loadTables =', start);
assert.ok(start > 0 && end > start);
const nodes = new Map();
const node = (id) => ({ id, value: '', disabled: false, hidden: false, dataset: {}, textContent: '', events: {}, isConnected: true,
  classList: { contains: () => false }, selectedOptions: [{ textContent: 'Table 1' }],
  addEventListener(type, callback) { this.events[type] = callback; },
  focus() { focused = id; }, setCustomValidity(message) { this.validationMessage = message; },
  checkValidity() { return this.disabled || (!this.validationMessage && !this.invalid); },
  reportValidity() { reported = id; }, click() { this.events.click?.({ target: this }); },
});
let focused; let reported;
for (const id of ['dialog', 'form', 'guest', 'phone', 'date', 'time', 'table', 'guests', 'deposit', 'notes', 'step-label', 'back', 'next', 'review', 'message', 'close', 'retry-tables']) nodes.set('#reservation-' + id, node(id));
const get = (id) => nodes.get('#reservation-' + id);
const panels = [['guest', 'phone'], ['date', 'time', 'table', 'guests'], ['deposit', 'notes']].map((ids, index) => ({ hidden: index !== 0, dataset: { reservationStep: String(index) }, querySelectorAll: () => ids.map(get), ids }));
const submit = node('submit'); const form = get('form'); const dialog = get('dialog');
form.querySelectorAll = () => panels;
form.querySelector = (selector) => selector.includes('submit') ? submit : selector.endsWith(' input') ? get(panels[Number(selector.match(/"(\d)"/)[1])].ids[0]) : panels[Number(selector.match(/"(\d)"/)[1])];
dialog.open = false; dialog.showModal = () => { dialog.open = true; }; dialog.close = () => { dialog.open = false; dialog.events.close(); };
dialog.querySelector = () => null; dialog.getBoundingClientRect = () => ({ left: 10, right: 100, top: 10, bottom: 100 });
const opener = node('opener');
const context = vm.createContext({ document: { querySelector: (id) => nodes.get(id), activeElement: opener }, formatRuDate: (date) => date });
vm.runInContext(source.slice(start, end) + '\nglobalThis.openWizard = openReservationDialog; globalThis.closeWizard = closeReservationDialog; globalThis.validateStep = validateReservationStep; globalThis.showStep = showReservationStep;', context);
context.openWizard(opener); assert.equal(dialog.open, true); assert.equal(focused, 'guest');
get('guest').value = '   '; get('next').click(); assert.equal(panels[0].hidden, false); assert.equal(reported, 'guest'); assert.match(get('message').textContent, /имя/);
get('guest').value = 'Guest'; get('next').click(); assert.equal(panels[1].hidden, false); assert.equal(get('back').hidden, false);
get('table').disabled = true; get('next').click(); assert.equal(panels[1].hidden, false); assert.equal(focused, 'retry-tables');
get('table').disabled = false; get('table').value = 'table-1'; get('table').selectedOptions[0].disabled = true; assert.equal(context.validateStep(1), false);
get('table').selectedOptions[0].disabled = false; vm.runInContext('reservationTablesLoading = true', context); assert.equal(context.validateStep(1), false, 'in-flight floor refresh blocks progression'); vm.runInContext('reservationTablesLoading = false', context);
get('table').selectedOptions[0].disabled = false; get('date').value = '2026-11-01'; get('time').value = '21:00'; get('guests').value = '2'; get('next').click();
assert.equal(panels[2].hidden, false); assert.equal(submit.hidden, false); assert.match(get('review').textContent, /Guest.*Без телефона/); assert.match(get('review').textContent, /2026-11-01/);
get('guest').invalid = true; assert.equal(context.validateStep(0), false); assert.equal(panels[0].hidden, false, 'final validation reveals invalid earlier step'); get('guest').invalid = false;
context.showStep(2); form.dataset.submitting = '1'; context.closeWizard(); assert.equal(dialog.open, true); get('back').click(); assert.equal(panels[2].hidden, false, 'pending request blocks back');
let prevented = false; dialog.events.cancel({ preventDefault() { prevented = true; } }); assert.equal(prevented, true); assert.equal(dialog.open, true, 'pending request blocks Escape');
form.dataset.submitting = '0'; dialog.events.cancel({ preventDefault() {} }); assert.equal(dialog.open, false); assert.equal(focused, 'opener');
context.openWizard(opener); assert.equal(panels[2].hidden, false, 'reopening resumes draft step');
let collapsed = false; const trigger = { setAttribute: (_key, value) => { collapsed = value === 'false'; }, focus() {} };
dialog.querySelector = () => ({ classList: { remove() {} }, querySelector: () => trigger });
dialog.events.keydown({ key: 'Escape', preventDefault() {}, stopPropagation() {} }); assert.equal(collapsed, true); assert.equal(dialog.open, true, 'Escape closes select before dialog');
dialog.querySelector = () => null;
dialog.events.pointerdown({ target: dialog, clientX: 20, clientY: 20 }); dialog.events.click({ target: dialog }); assert.equal(dialog.open, true, 'dialog padding click does not close');
dialog.events.pointerdown({ target: dialog, clientX: 0, clientY: 0 }); dialog.events.click({ target: dialog }); assert.equal(dialog.open, false, 'outside backdrop click closes');
assert.match(source, /id="reservation-form"[^>]*novalidate/, 'wizard owns hidden-step validation');
const requestedOpenLine = source.split(/\r?\n/).find((line) => line.includes("if (reservationParams.get('tableId')"));
assert.ok(requestedOpenLine, 'deep-link opening has an explicit query guard');
for (const [query, shouldOpen] of [
  ['tableId=t1', true], ['reservationId=r1', false], ['tableId=t1&reservationId=r1', false],
  ['tableId=t1&action=seat', false], ['action=seat', false], ['', false],
]) {
  let openedCount = 0;
  const queryContext = vm.createContext({ reservationParams: new URLSearchParams(query), requestedTableApplied: false, openReservationDialog() { openedCount++; }, document: { querySelector: () => opener } });
  vm.runInContext(requestedOpenLine, queryContext);
  assert.equal(openedCount, Number(shouldOpen), `deep link ${query || '(empty)'} opens only new booking intent`);
  vm.runInContext(requestedOpenLine, queryContext);
  assert.equal(openedCount, Number(shouldOpen), 'floor refresh does not reopen an already applied deep link');
}
assert.doesNotMatch(source.slice(source.indexOf('function renderReservations()'), source.indexOf("if (page === 'dashboard' && location.hash === '#loyalty')")), /form\.scrollIntoView/, 'new and edit never scroll page to the form');
console.log('RESERVATION WIZARD QA: PASS (step validation, unavailable place, hidden invalid fields, draft reopen, pending guards, Escape, backdrop, focus return)');
