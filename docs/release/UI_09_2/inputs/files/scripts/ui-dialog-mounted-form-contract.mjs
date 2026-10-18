import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Reuse the existing DOM mechanics fixture, execute the current shipped module.
// This is VM lifecycle coverage; browser geometry/focus and API persistence are separate QA.
const source = fs.readFileSync(new URL('../ui-dialog.js', import.meta.url), 'utf8');
const existing = fs.readFileSync(new URL('./ui-dialog-lifecycle-contract.mjs', import.meta.url), 'utf8');
const begin = existing.indexOf('const decode =');
const end = existing.indexOf('\nconst defaults =', begin);
assert.ok(begin > 0 && end > begin, 'shared fixture extraction boundaries exist');
const fixture = new Function('vm', 'source', `${existing.slice(begin, end)}; return fixture;`)(vm, source);
const plain = value => JSON.parse(JSON.stringify(value));
const submit = async h => { const event = h.form.dispatch('submit'); await Promise.all(event.results); };
let checks = 0;
const failures = [];
async function test(name, run) { try { await run(); checks++; } catch (error) { failures.push(`${name}: ${error.stack}`); } }

function mounted(options = {}) {
  const f = fixture(), host = new f.Node('div'); host.hidden = true; f.main.append(host);
  const form = new f.Node('form'); form.className = 'ui-modal-card ui-modal-form'; form.setAttribute('novalidate', '');
  form.innerHTML = '<header><h2 id="booking-title">Бронь</h2><p id="booking-description">Три шага</p><button type="button" data-ui-close>Закрыть</button></header><div class="ui-modal-body"><section data-step="0"><input id="booking-guest" name="guest" required value="Гость"></section><section data-step="1" hidden><input id="booking-date" name="date" required value="2026-11-01"></section><section data-step="2" hidden><textarea name="notes">Черновик</textarea><input name="locked" value="original" disabled></section></div><footer><button type="button" data-ui-cancel>Отмена</button><button type="submit">Сохранить</button></footer>';
  host.append(form);
  const defaults = { title: 'Бронь', fields: [], draftPolicy: 'preserve', pendingClosePolicy: 'block', returnFocus: f.trigger,
    initialFocus: current => current.elements.namedItem('guest'), mount: { form, host, titleId: 'booking-title', descriptionId: 'booking-description' }, validateMounted: () => true };
  return { ...f, form, host, reopen: extra => f.ui.open({ ...defaults, ...options, ...extra }) };
}
const listenerCount = (node, type) => node.listeners.get(type)?.size || 0;

await test('mount preserves form identity, semantics and domain handlers', () => {
  const f = mounted(); let changes = 0; const handler = () => changes++; f.form.addEventListener('change', handler);
  const h = f.reopen(); assert.equal(h.form, f.form); assert.equal(h.element.getAttribute('aria-labelledby'), 'booking-title');
  assert.equal(h.element.getAttribute('aria-describedby'), 'booking-description'); assert.equal(f.document.activeElement, f.form.elements.namedItem('guest'));
  assert.equal(f.host.contains(f.form), false); assert.equal(f.main.inert, true); assert.equal(f.document.body.style.overflow, 'hidden');
  f.form.dispatch('change'); h.close(); assert.equal(changes, 1); assert.equal(listenerCount(f.form, 'change'), 1);
  assert.equal(f.host.contains(f.form), true); assert.equal(f.main.inert, false); assert.equal(f.document.body.style.overflow, 'scroll');
  assert.equal(f.document.activeElement, f.trigger);
});
await test('repeated close reopen removes transient nodes and listeners', async () => {
  const f = mounted(); let calls = 0; let closes = 0;
  for (let i = 0; i < 6; i++) {
    const h = f.reopen({ onSubmit: () => { calls++; }, onClose: () => closes++ });
    assert.equal(listenerCount(f.form, 'submit'), 1); assert.equal(listenerCount(f.form, 'input'), 1); assert.equal(listenerCount(f.form, 'invalid'), 1);
    for (const selector of ['.ui-modal-message', '[data-ui-pending]', '[data-ui-discard]']) assert.equal(f.form.querySelectorAll(selector).length, 1);
    await submit(h); assert.equal((await h.promise).reason, 'success');
    for (const selector of ['.ui-modal-message', '[data-ui-pending]', '[data-ui-discard]']) assert.equal(f.form.querySelectorAll(selector).length, 0);
    for (const type of ['submit', 'input', 'change', 'invalid']) assert.equal(listenerCount(f.form, type), 0);
    for (const selector of ['[data-ui-close]', '[data-ui-cancel]']) assert.equal(listenerCount(f.form.querySelector(selector), 'click'), 0);
    assert.equal(f.observers.size, 0); assert.equal(listenerCount(f.document, 'keydown'), 0); assert.equal(listenerCount(f.document, 'focusin'), 0);
  }
  assert.equal(calls, 6); assert.equal(closes, 6);
});
await test('cancel retains DOM input and hidden step state on reopen', async () => {
  const f = mounted(); const h = f.reopen(); const guest = f.form.elements.namedItem('guest'); guest.value = 'Изменённый гость';
  const first = f.form.querySelector('[data-step="0"]'), third = f.form.querySelector('[data-step="2"]'); first.hidden = true; third.hidden = false;
  h.close(); assert.equal((await h.promise).reason, 'cancel'); const next = f.reopen();
  assert.equal(next.form, f.form); assert.equal(guest.value, 'Изменённый гость'); assert.equal(first.hidden, true); assert.equal(third.hidden, false); next.close();
});
await test('domain validation reveals hidden earlier step before request', async () => {
  const f = mounted(); let calls = 0; const guest = f.form.elements.namedItem('guest'), first = f.form.querySelector('[data-step="0"]'); guest.value = ''; first.hidden = true;
  const h = f.reopen({ validateMounted: form => { assert.equal(form, f.form); if (!guest.value.trim()) { first.hidden = false; guest.focus(); return false; } return true; }, onSubmit: () => calls++ });
  await submit(h); assert.equal(calls, 0); assert.equal(h.pending, false); assert.equal(first.hidden, false); assert.equal(f.document.activeElement, guest);
  guest.value = 'Гость'; await submit(h); assert.equal(calls, 1); assert.equal((await h.promise).reason, 'success');
});
await test('mounted domain validation bypasses generic hidden-step check', async () => {
  const f = mounted(); let validations = 0; let calls = 0; f.form.checkValidity = () => { throw Error('generic validation must not own wizard'); };
  const h = f.reopen({ validateMounted: () => { validations++; return true; }, onSubmit: () => calls++ }); await submit(h);
  assert.equal(validations, 1); assert.equal(calls, 1); assert.equal((await h.promise).reason, 'success');
});
await test('missing domain validation never sends mounted form', async () => {
  const f = mounted(); let calls = 0; const h = f.reopen({ validateMounted: undefined, onSubmit: () => calls++ }); await submit(h);
  assert.equal(calls, 0); assert.equal(h.pending, false); h.close();
});
await test('pending blocks duplicate submit, close, Escape and backdrop', async () => {
  const f = mounted(); let resolve, calls = 0; const transitions = [];
  const h = f.reopen({ onPending: value => transitions.push(value), onSubmit: () => { calls++; return new Promise(done => resolve = done); } });
  const first = submit(h); assert.equal(h.pending, true); assert.equal(f.form.getAttribute('aria-busy'), 'true');
  assert.equal(f.form.querySelector('[data-ui-close]').disabled, true); assert.equal(h.close(), false);
  f.document.dispatch('keydown', { key: 'Escape' }); h.element.dispatch('pointerdown'); h.element.dispatch('pointerup'); h.element.dispatch('click');
  await submit(h); assert.equal(calls, 1); assert.equal(h.element.isConnected, true);
  resolve({ saved: true }); await first; assert.deepEqual(transitions, [true, false]); assert.equal((await h.promise).reason, 'success');
});
await test('error retains input and pending restores original disabled states', async () => {
  const f = mounted(); const locked = f.form.elements.namedItem('locked'); let calls = 0;
  const h = f.reopen({ onSubmit: () => { if (++calls === 1) throw Error('offline'); return 'saved'; }, errorMessage: () => 'Нет связи' });
  f.form.elements.namedItem('guest').value = 'Не потерять'; await submit(h);
  assert.equal(h.pending, false); assert.equal(locked.disabled, true); assert.equal(f.form.elements.namedItem('guest').disabled, false);
  assert.equal(f.form.elements.namedItem('guest').value, 'Не потерять'); assert.equal(h.element.querySelector('.ui-modal-message').textContent, 'Нет связи');
  assert.equal(h.element.querySelector('.ui-modal-message').hidden, false); await submit(h);
  assert.equal(calls, 2); assert.deepEqual(plain(await h.promise), { reason: 'success', values: { guest: 'Не потерять', date: '2026-11-01', notes: 'Черновик' }, result: 'saved' });
  assert.equal(locked.disabled, true);
});
await test('onPending sees controls after disabling and restoring', async () => {
  const f = mounted(); const guest = f.form.elements.namedItem('guest'), locked = f.form.elements.namedItem('locked'); const transitions = [];
  const h = f.reopen({ onPending: value => { assert.equal(guest.disabled, value); assert.equal(locked.disabled, true); transitions.push(value); }, onSubmit: async () => { throw Error('offline'); } });
  await submit(h); assert.deepEqual(transitions, [true, false]); h.close();
});
await test('context mismatch before submit sends no request and strips returned draft', async () => {
  const f = mounted(); let context = 'user|venueA|role'; let calls = 0, close;
  const h = f.reopen({ context: () => context, onSubmit: () => calls++, onClose: result => close = result }); context = 'user|venueB|role'; await submit(h);
  assert.equal(calls, 0); assert.equal((await h.promise).reason, 'context-changed'); assert.equal(close.values, null); assert.equal(f.host.contains(f.form), true);
});
await test('stale pending response cannot claim current success', async () => {
  const f = mounted(); let context = 'A', resolve; const h = f.reopen({ context: () => context, onSubmit: () => new Promise(done => resolve = done) });
  const pending = submit(h); context = 'B'; h.refresh(); assert.equal(h.pending, true); assert.equal(h.element.isConnected, true);
  resolve('stored in previous context'); await pending; assert.equal((await h.promise).reason, 'context-changed');
  assert.equal(f.form.elements.namedItem('guest').disabled, false); assert.equal(f.host.contains(f.form), true);
});
await test('stale pending error does not report a current error', async () => {
  const f = mounted(); let current = true, reject, close;
  const h = f.reopen({ isCurrent: () => current, onSubmit: () => new Promise((_, bad) => reject = bad), onClose: value => close = value });
  const pending = submit(h); current = false; reject(Error('old context offline')); await pending;
  assert.equal((await h.promise).reason, 'context-changed'); assert.equal(close.values, null); assert.equal(f.form.querySelector('.ui-modal-message'), null);
  assert.equal(f.form.elements.namedItem('guest').disabled, false); assert.equal(f.host.contains(f.form), true);
});
await test('close and cancel handlers work after reopening without stale callbacks', async () => {
  const f = mounted(); let closeCount = 0;
  const first = f.reopen({ onClose: () => closeCount++ }); f.form.querySelector('[data-ui-close]').dispatch('click');
  assert.equal((await first.promise).reason, 'close-button'); const second = f.reopen({ onClose: () => closeCount++ });
  f.form.querySelector('[data-ui-cancel]').dispatch('click'); assert.equal((await second.promise).reason, 'cancel'); assert.equal(closeCount, 2);
});
await test('custom dropdown Escape runs before mounted close', () => {
  const f = mounted(), h = f.reopen(), dropdown = new f.Node('div'), trigger = new f.Node('button'); dropdown.className = 'custom-select is-open'; trigger.className = 'custom-select-trigger'; trigger.setAttribute('type', 'button');
  dropdown.append(trigger); f.form.querySelector('.ui-modal-body').append(dropdown); f.document.dispatch('keydown', { key: 'Escape' });
  assert.equal(dropdown.classList.contains('is-open'), false); assert.equal(h.element.isConnected, true); assert.equal(f.document.activeElement, trigger);
  f.document.dispatch('keydown', { key: 'Escape' }); assert.equal(h.element.isConnected, false);
});
await test('mounted close uses accessible fallback after opener is removed', () => {
  const f = mounted(), h = f.reopen({ fallbackFocus: () => f.heading }); f.trigger.remove(); h.close(); assert.equal(f.document.activeElement, f.heading);
});
await test('malformed mount fails without moving domain form or acquiring background', () => {
  const f = mounted(); assert.throws(() => f.reopen({ mount: { form: f.form, host: null } }), /Mounted form/);
  assert.equal(f.host.contains(f.form), true); assert.equal(f.main.inert, false); assert.equal(f.document.body.style.overflow, 'scroll');
  const h = f.reopen(); h.close();
});

if (failures.length) { console.error(failures.join('\n\n')); process.exitCode = 1; }
else console.log(`UI-04.2 mounted actual-source lifecycle PASS (${checks} checks; VM DOM, browser/API proof separate).`);
