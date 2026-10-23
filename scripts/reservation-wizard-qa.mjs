import assert from 'node:assert/strict';
import { createReservationFixture, validDraft, settle } from './ui042-reservation-fixture.mjs';

// Runs the current wizard and shared modal against a lightweight DOM fixture.
// Browser focus/pixels and API persistence are verified separately.
const f = createReservationFixture();
assert.equal(await f.context.openWizard(f.trigger), true, 'new booking opens through shared UI');
let handle = f.context.getWindow();
const panels = f.get('form').querySelectorAll('[data-reservation-step]');
const next = f.get('next');

f.get('guest').value = '   ';
next.click();
assert.equal(panels[0].hidden, false, 'empty guest stays on the first step');
assert.match(f.get('message').textContent, /имя/i);

f.get('guest').value = 'Guest';
f.get('guest').dispatch('input');
assert.equal(f.get('message').textContent, '', 'correcting the guest name clears its stale validation message immediately');
assert.equal(panels[0].hidden, false, 'editing the guest never advances the wizard automatically');
next.click();
assert.equal(panels[1].hidden, false, 'valid guest advances to visit details');
f.get('table').disabled = true;
next.click();
assert.equal(panels[1].hidden, false, 'unavailable place blocks progression');
assert.match(f.get('message').textContent, /место|загруз/i);
f.get('guest').value = 'Another Guest';
f.get('guest').dispatch('input');
assert.match(f.get('message').textContent, /место|загруз/i, 'guest edits do not clear an unrelated place error');

validDraft(f);
f.get('guest').value = 'Guest';
f.get('table').disabled = false;
next.click();
assert.equal(panels[2].hidden, false, 'valid visit advances to confirmation');
assert.match(f.get('review').textContent, /Guest/);
assert.match(f.get('review').textContent, /2026-11-01/);

assert.equal(handle.close(), true, 'unfinished wizard can be closed before submission');
assert.equal(handle.element.isConnected, false);
assert.equal(await f.context.openWizard(f.trigger), true, 'reopening resumes the existing draft');
handle = f.context.getWindow();
assert.equal(panels[2].hidden, false, 'reopened draft remains on the confirmation step');

f.get('guest').value = '';
handle.form.dispatch('submit');
await settle();
assert.equal(handle.pending, false, 'invalid draft never enters pending state');
assert.equal(f.requests.length, 0, 'invalid draft does not call the API');
assert.equal(panels[0].hidden, false, 'final validation reveals the earlier invalid step');

f.get('guest').value = 'Guest';
next.click(); next.click();
handle.form.dispatch('submit');
await settle();
assert.equal(f.requests.length, 1);
assert.equal(f.requests[0].url, '/api/reservations');
assert.equal(f.requests[0].options.method, 'POST');
assert.equal(handle.pending, true, 'save locks the modal while the request is pending');
assert.equal(handle.close(), false, 'pending request cannot close the modal');
assert.equal(f.get('back').disabled, true, 'pending request disables Back');
f.get('back').click();
assert.equal(panels[2].hidden, false, 'Back cannot move away from confirmation while saving');

f.pending[0].reject(new Error('offline'));
await settle();
assert.equal(handle.pending, false);
assert.equal(handle.element.isConnected, true, 'failed save keeps the wizard open');
assert.equal(f.get('guest').value, 'Guest', 'failed save preserves the entered draft');
assert.match(handle.element.querySelector('.ui-modal-message').textContent, /сохранить/i);

handle.form.dispatch('submit');
await settle();
assert.equal(f.requests.length, 2, 'retry starts a new request after failure');
f.pending[1].resolve({ id: 'reservation-qa' });
const outcome = await handle.promise;
await settle();
assert.equal(outcome.reason, 'success');
assert.equal(f.notices.at(-1)[0], 'Бронь подтверждена');
assert.equal(f.get('list-date').value, '2026-11-01');
assert.equal(f.get('filter').value, '');
console.log('RESERVATION WIZARD QA: PASS (current shared modal, validation, unavailable place, review, pending close guard, failed-save draft, retry and POST success)');
