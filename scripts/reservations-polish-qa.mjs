import assert from 'node:assert/strict';
import { createReservationFixture, validDraft, settle, reservationSource, portal } from './ui042-reservation-fixture.mjs';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Exercises the production reservation code through the current shared-modal fixture.
// This is not a substitute for browser pixels, real focus behavior, or persisted API readback.
const f = createReservationFixture();
await f.context.openWizard(f.trigger);
const handle = f.context.getWindow();
const place = f.get('table');
let selectRefreshes = 0; let ruleOptions;
place.innerHTML = '<option value="table-8">Table 8</option>';
place._customSelectRefresh = () => { selectRefreshes++; };
place._reservationRulesRefresh = (options) => { ruleOptions = options; };
f.get('message').textContent = 'Old success'; f.get('message').className = 'form-message success-message';
f.context.reservations = [{ id: 'r2', guestName: 'Returning guest', guestId: 'client-2', phone: '+79990000002', date: '2026-11-01', time: '21:30', tableId: 'table-8', guests: 4, depositRequired: 700, notes: 'Existing note' }];
const editStart = reservationSource.indexOf('const editButton = event.target.closest');
const editEnd = reservationSource.indexOf('const retry = event.target.closest', editStart);
assert.ok(editStart >= 0 && editEnd > editStart, 'actual edit-row event handler exists');
const editButton = { dataset: { reservationEdit: 'r2' } };
f.context.event = { target: { closest: (selector) => selector === '[data-reservation-edit]' ? editButton : null } };
vm.runInContext('(function () {' + reservationSource.slice(editStart, editEnd) + '})()', f.context);
assert.equal(f.get('guest').value, 'Returning guest');
assert.equal(f.get('client-id').value, 'client-2');
assert.equal(place.value, 'table-8');
assert.equal(f.get('deposit').value, '700');
assert.equal(f.get('notes').value, 'Existing note');
assert.equal(selectRefreshes, 1, 'editing refreshes the enhanced place selector');
assert.equal(ruleOptions?.preserveDeposit, true, 'saved deposit is preserved while place rules refresh');
assert.equal(f.get('message').textContent, '', 'editing clears the previous result message');
assert.equal(f.get('message').className, 'form-message');

const ruleStart = reservationSource.indexOf('    const updatePlaceRules =');
const ruleEnd = reservationSource.indexOf('    select._reservationRulesRefresh', ruleStart);
assert.ok(ruleStart >= 0 && ruleEnd > ruleStart, 'actual place-rule updater exists');
const selectedPlace = { selectedOptions: [{ value: 'table-8', dataset: { minimum: '500', maxGuests: '8' } }] };
const deposit = { value: 700 }; const depositHint = {}; const guests = {}; const guestsHint = {};
const minimumStart = portal.indexOf('const reservationTableMinimumAtTime =');
const minimumEnd = portal.indexOf('\nconst renderReservationTableOptions', minimumStart);
assert.ok(minimumStart >= 0 && minimumEnd > minimumStart, 'actual time-based minimum helper exists');
const rules = vm.createContext({ select: selectedPlace, deposit, depositHint, guests, guestsHint, money: (value) => value + ' RUB', pluralRu: () => 'гостей', document: { querySelector: () => ({ value: '21:30' }) } });
vm.runInContext(portal.slice(minimumStart, minimumEnd) + '\n' + reservationSource.slice(ruleStart, ruleEnd) + '; globalThis.refresh = updatePlaceRules;', rules);
rules.refresh({ preserveDeposit: true });
assert.equal(deposit.value, 700, 'editing preserves a saved deposit above the new minimum');
assert.equal(guests.max, '8'); assert.match(guestsHint.textContent, /8/); assert.match(depositHint.textContent, /500/);
deposit.value = 100; rules.refresh({ preserveDeposit: true }); assert.equal(deposit.value, 100, 'stored amount stays visible even below the current minimum');
rules.refresh(); assert.equal(deposit.value, 500, 'a new booking applies the selected place minimum');

validDraft(f);
f.get('table').disabled = false;
f.get('guest').value = 'Returning guest';
f.get('next').click(); f.get('next').click();
const submit = f.get('form').querySelectorAll('button').find((button) => button.type === 'submit');
assert.equal(submit.textContent, 'Сохранить изменения');
assert.equal(f.get('step-label').textContent, 'Шаг 3 из 3 · Подтверждение');

handle.form.dispatch('submit');
await settle();
assert.equal(f.requests.length, 1);
assert.equal(f.requests[0].url, '/api/reservations/r2');
assert.equal(f.requests[0].options.method, 'PATCH');
const sent = JSON.parse(f.requests[0].options.body);
assert.equal(sent.guestName, 'Returning guest');
assert.equal(sent.tableId, 'table-1');
assert.equal(handle.pending, true);
assert.equal(handle.close(), false, 'pending PATCH cannot close the modal');

f.context.startNew();
assert.equal(f.get('form').dataset.editingId, 'r2', 'pending update cannot replace the draft');
assert.equal(f.requests.length, 1, 'pending action does not start another request');
f.pending[0].reject(new Error('write_failed'));
await settle();
assert.equal(handle.pending, false);
assert.equal(handle.element.isConnected, true, 'failed PATCH leaves the editor open');
assert.equal(f.get('form').dataset.editingId, 'r2');
assert.equal(f.get('guest').value, 'Returning guest');
assert.match(handle.element.querySelector('.ui-modal-message').textContent, /Не удалось сохранить бронь/);
assert.equal(submit.textContent, 'Сохранить изменения');

handle.form.dispatch('submit');
await settle();
assert.equal(f.requests.length, 2, 'retry is possible after a failed PATCH');
f.pending[1].resolve({ id: 'r2' });
const outcome = await handle.promise;
await settle();
assert.equal(outcome.reason, 'success');
assert.equal(f.notices.at(-1)[0], 'Изменения брони сохранены');
assert.equal(f.get('list-date').value, '2026-11-01');
assert.equal(f.get('filter').value, '');
assert.equal(f.get('form').dataset.editingId, undefined);

for (const id of ['reservation-guest', 'reservation-phone', 'reservation-date', 'reservation-time', 'reservation-table', 'reservation-guests', 'reservation-deposit', 'reservation-notes', 'reservation-filter', 'reservation-list-date', 'reservation-list']) {
  assert.match(reservationSource, new RegExp(`id="${id}"`), `current reservation markup includes ${id}`);
}
assert.match(reservationSource, /class="reservation-identity"/);
assert.match(reservationSource, /class="reservation-details"/);
assert.match(reservationSource, /data-reservation-edit/);
assert.match(reservationSource, /canRefundReservationPrepayment/);
const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');
assert(css.includes('body[data-page="reservations"] .reservations-workspace{grid-template-columns:minmax(0,1fr);min-height:0}'));
assert(css.includes('body[data-page="reservations"].light-theme .reservation-details>.button:not(.primary){background:#fff;border:1px solid #d6e1e6;color:#20313d;box-shadow:none'));
assert(css.includes('body[data-page="reservations"].light-theme .reservation-details>.badge.success{background:#e0f8ef;color:#176747;border:1px solid #9bcdb8'));
assert(css.includes('body[data-page="reservations"].light-theme :is(#reservation-date,#reservation-time,#reservation-list-date)::-webkit-calendar-picker-indicator{filter:none;opacity:.8}'));
console.log('PASS reservations polish: current shared modal, PATCH payload, pending guard, failed-save draft, retry/success, booking detail contract and scoped layout/theme selectors');
