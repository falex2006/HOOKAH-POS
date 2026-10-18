import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Actual shipped sources, fake DOM/native modality and controlled responses.
// This proves lifecycle contracts, not browser top-layer pixels or live authentication.
const root = new URL('../', import.meta.url);
const shared = fs.readFileSync(new URL('ui-dialog.js', root), 'utf8');
const lockSource = fs.readFileSync(new URL('lock.js', root), 'utf8');
const harness = fs.readFileSync(new URL('scripts/ui-dialog-lifecycle-contract.mjs', root), 'utf8');
const factory = harness.slice(harness.indexOf('function fixture() {'), harness.indexOf('\nconst defaults ='));
const decode = value => String(value).replace(/&(amp|lt|gt|quot|#39);/g, (_, key) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[key]);
const user = { id: 'qa-owner', organizationId: 'qa-org', venueId: 'qa-venue', role: 'owner', name: 'QA Owner', pinConfigured: true, preferences: { lockTimeoutMinutes: 1 } };
const settle = async () => { for (let n = 0; n < 18; n++) await Promise.resolve(); };
const response = (status, payload) => ({ ok: status >= 200 && status < 300, status, json: async () => payload });

async function fixture(options = {}) {
  const f = vm.runInNewContext(`${factory}\nfixture()`, { vm, source: shared, decode });
  f.lock.remove(); f.settings.remove();
  const window = new f.Node('window');
  Object.assign(window, f.context.window); f.context.window = window;
  const storage = new Map([['crm_session_token', 'qa-token'], ['crm_session_user', JSON.stringify({ ...user, ...options.user })]]);
  const localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)), removeItem: key => storage.delete(key) };
  const requests = [], redirects = [], frames = [], top = [];
  f.Node.prototype.appendChild = function(node) { this.append(node); return node; };
  f.Node.prototype.prepend = function(node) { node.remove(); node.parentNode = this; this.children.unshift(node); };
  Object.defineProperty(f.Node.prototype, 'open', { configurable: true, get() { return this.hasAttribute('open'); } });
  f.Node.prototype.showModal = function() { assert.equal(this.tagName, 'DIALOG'); assert.equal(this.open, false); this.setAttribute('open', ''); top.push(this); };
  // Native close events are queued; synchronous delivery invents reentrant promotion.
  f.Node.prototype.close = function() { if (!this.open) return; this.removeAttribute('open'); const index = top.indexOf(this); if (index >= 0) top.splice(index, 1); queueMicrotask(() => this.dispatch('close')); };
  f.Node.prototype.focus = function() {
    if (!this.isConnected || this.disabled || this.closest('[hidden],[inert]')) return;
    if (top.length && !top.at(-1).contains(this)) return;
    f.document.activeElement = this;
    const event = window.dispatch('focusin', { target: this }).event;
    if (!event.stopped) f.document.dispatch('focusin', { target: this });
  };
  f.Node.prototype.dispatchEvent = function(event) { return this.dispatch(event.type, event); };
  const host = new f.Node('div'); host.className = 'header-right'; f.document.body.append(host);
  const fetch = (url, init = {}) => {
    if (url === '/api/session/preferences') return Promise.resolve(response(200, { preferences: { lockTimeoutMinutes: 1 } }));
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    requests.push({ url, init, resolve: (status, payload) => resolve(response(status, payload)), reject });
    return promise;
  };
  Object.assign(f.context, { localStorage, fetch, location: { replace: url => redirects.push(url) }, requestAnimationFrame: callback => frames.push(callback), Event: class { constructor(type) { this.type = type; } }, Date, JSON, encodeURIComponent });
  window.setTimeout = f.context.setTimeout;
  vm.runInContext(lockSource, f.context, { filename: 'lock.js' });
  await settle();
  const overlay = f.document.querySelector('dialog.screen-lock-overlay');
  const pin = overlay.querySelector('#screen-lock-pin');
  const settings = f.document.querySelector('dialog.lock-settings-dialog');
  const flush = () => { f.flush(); while (frames.length) frames.shift()(); };
  const lock = async () => { f.document.querySelector('#lock-screen-button').dispatch('click'); await settle(); flush(); };
  const enter = value => { pin.value = value; pin.dispatch('input'); };
  const signal = (key, value) => { if (value === null) storage.delete(key); else storage.set(key, value); window.dispatch('storage', { key, newValue: value }); };
  return { ...f, window, storage, localStorage, requests, redirects, top, overlay, pin, settings, flush, lock, enter, signal, locked: () => f.document.body.classList.contains('screen-locked'), runFrames: flush };
}

let passed = 0;
const failures = [];
async function test(name, run) { try { await run(); passed++; } catch (error) { failures.push(`${name}: ${error.stack}`); } }

await test('source and dist exact parity', () => {
  assert.equal(fs.readFileSync(new URL('dist/lock.js', root), 'utf8'), lockSource);
  assert.equal(fs.readFileSync(new URL('dist/ui-dialog.js', root), 'utf8'), shared);
});
await test('native automatic lock preserves settings draft and becomes top modal', async () => {
  const f = await fixture(); f.context.window.__openLockSettings();
  const draft = f.settings.querySelector('#lock-new-pin'); draft.value = '1234'; draft.focus();
  [...f.timers.values()].find(timer => timer.duration === 60000).callback(); await settle(); f.flush();
  assert.equal(f.locked(), true); assert.equal(f.overlay.dataset.reason, 'auto'); assert.equal(f.top.at(-1), f.overlay);
  assert.equal(f.document.activeElement, f.pin); assert.equal(f.settings.open, true); assert.equal(draft.value, '1234');
  assert.equal(f.overlay.dispatch('cancel').event.defaultPrevented, true);
  f.overlay.close(); f.flush(); assert.equal(f.overlay.open, true); assert.equal(f.top.at(-1), f.overlay);
});
await test('late native modal is repromoted without closing lower drafts', async () => {
  const f = await fixture(); await f.lock(); const late = new f.Node('dialog'), input = new f.Node('input');
  input.value = 'late draft'; late.append(input); f.document.body.append(late); late.showModal(); input.focus(); f.flush();
  assert.equal(f.top.at(-1), f.overlay); assert.equal(f.document.activeElement, f.pin); assert.equal(late.open, true); assert.equal(input.value, 'late draft');
});
await test('capture guards background work, Escape and bidirectional Tab', async () => {
  const f = await fixture(); await f.lock();
  for (const type of ['pointerdown', 'mousedown', 'touchstart', 'click', 'submit']) {
    const event = f.window.dispatch(type, { target: f.trigger }).event; assert.equal(event.defaultPrevented, true, type); assert.equal(event.stopped, true, type);
  }
  assert.equal(f.window.dispatch('keydown', { target: f.pin, key: 'Escape' }).event.defaultPrevented, true);
  f.window.dispatch('keydown', { target: f.pin, key: 'Tab', shiftKey: true }); assert.equal(f.document.activeElement.id, 'screen-lock-exit');
  f.window.dispatch('keydown', { target: f.document.activeElement, key: 'Tab' }); assert.equal(f.document.activeElement, f.pin);
  // Capture receives an attempted external focus even when native focus is blocked.
  const focus = f.window.dispatch('focusin', { target: f.trigger }).event; assert.equal(focus.stopped, true); assert.equal(f.document.activeElement, f.pin);
});
await test('normalization, pending duplicate guard and native focus restoration', async () => {
  const f = await fixture(); f.settings.showModal(); const draft = f.settings.querySelector('#lock-new-pin'); draft.value = '7788'; draft.focus(); await f.lock();
  f.enter('a1x2'); assert.equal(f.pin.value, '12'); assert.equal(f.requests.length, 0);
  f.enter('12345'); f.enter('9999'); assert.equal(f.requests.length, 1); assert.deepEqual(JSON.parse(f.requests[0].init.body), { pin: '1234' });
  assert.equal(f.requests[0].init.headers.Authorization, 'Bearer qa-token'); assert.equal(f.locked(), true);
  f.requests[0].resolve(200, { user }); await settle(); f.flush();
  assert.equal(f.locked(), false); assert.equal(f.overlay.open, false); assert.equal(f.document.activeElement, draft); assert.equal(draft.value, '7788'); assert.equal(f.document.body.style.overflow, 'scroll');
});
for (const [status, error, expected] of [[401, 'invalid_pin', 'Неверный PIN'], [429, 'too_many_pin_attempts', 'Слишком много'], [503, 'unlock_unavailable', 'Не удалось']]) {
  await test(`failed ${status}/${error} retains modal and permits retry`, async () => {
    const f = await fixture(); await f.lock(); f.enter('1111'); f.requests[0].resolve(status, { error, retryAfter: 60 }); await settle(); f.flush();
    assert.equal(f.locked(), true); assert.equal(f.overlay.open, true); assert.equal(f.pin.value, ''); assert.equal(f.redirects.length, 0);
    assert.ok(f.overlay.querySelector('#screen-lock-message').textContent.includes(expected));
    f.enter('2222'); assert.equal(f.requests.length, 2); f.requests[1].resolve(200, { user }); await settle(); f.flush(); assert.equal(f.locked(), false);
  });
}
await test('authenticated expiry 401 redirects without unlocking', async () => {
  const f = await fixture(); await f.lock(); f.enter('1234'); f.requests[0].resolve(401, { error: 'authentication_required' }); await settle(); f.flush();
  assert.deepEqual(f.redirects, ['/login']); assert.equal(f.locked(), true); assert.equal(f.overlay.open, true);
});
await test('replaced local session before PIN sends no verification request', async () => {
  const f = await fixture(); await f.lock(); f.storage.set('crm_session_token', 'replacement'); f.enter('1234');
  assert.equal(f.requests.length, 0); assert.deepEqual(f.redirects, ['/login']); assert.equal(f.locked(), true);
});
await test('no configured PIN refreshes live session and opens settings without trapping', async () => {
  const f = await fixture({ user: { pinConfigured: false } }); f.document.querySelector('#lock-screen-button').dispatch('click');
  assert.equal(f.requests[0].url, '/api/session'); assert.equal(f.overlay.open, false);
  f.requests[0].resolve(200, { user: { ...user, pinConfigured: false } }); await settle(); f.flush();
  assert.equal(f.locked(), false); assert.equal(f.settings.open, true); assert.equal(f.document.body.style.overflow, 'scroll');
});
for (const change of ['token', 'venue', 'role', 'response-identity']) await test(`stale ${change} success cannot release lock`, async () => {
  const f = await fixture(); await f.lock(); f.enter('1234');
  if (change === 'token') f.storage.set('crm_session_token', 'replacement');
  else if (change !== 'response-identity') f.storage.set('crm_session_user', JSON.stringify({ ...user, [change === 'venue' ? 'venueId' : 'role']: 'replacement' }));
  f.requests[0].resolve(200, { user: change === 'response-identity' ? { ...user, venueId: 'foreign' } : user }); await settle(); f.flush();
  assert.deepEqual(f.redirects, ['/login']); assert.equal(f.locked(), true); assert.equal(f.overlay.open, true); assert.equal(f.storage.get('crm_screen_locked_user_qa-owner'), 'locked');
});
await test('cross-tab unlock requires live session and exact current signal', async () => {
  const f = await fixture(); await f.lock(); const key = 'crm_screen_locked_user_qa-owner';
  f.signal(key, null); assert.equal(f.requests.length, 0); assert.equal(f.locked(), true);
  f.signal(key, 'unlocked:1'); assert.equal(f.requests[0].url, '/api/session');
  f.signal(key, 'locked'); f.requests[0].resolve(200, { user }); await settle(); f.flush(); assert.equal(f.locked(), true);
  f.signal(key, 'unlocked:2'); f.requests[1].resolve(200, { user }); await settle(); f.flush(); assert.equal(f.locked(), false);
});
await test('cross-tab invalid session cannot release lock', async () => {
  const f = await fixture(); await f.lock(); f.signal('crm_screen_locked_user_qa-owner', 'unlocked:1');
  f.requests[0].resolve(401, { error: 'authentication_required' }); await settle(); assert.deepEqual(f.redirects, ['/login']); assert.equal(f.locked(), true);
});
for (const result of ['foreign-identity', 'network']) await test(`cross-tab ${result} remains locked`, async () => {
  const f = await fixture(); await f.lock(); f.signal('crm_screen_locked_user_qa-owner', 'unlocked:1');
  if (result === 'network') f.requests[0].reject(Error('offline')); else f.requests[0].resolve(200, { user: { ...user, venueId: 'foreign' } });
  await settle(); f.flush(); assert.equal(f.locked(), true); assert.equal(f.overlay.open, true); assert.equal(f.redirects.length, 0);
});
for (const status of [200, 401]) await test(`old PIN ${status} result cannot affect a newer lock epoch`, async () => {
  const f = await fixture(); await f.lock(); f.enter('1234');
  f.signal('crm_screen_locked_user_qa-owner', 'unlocked:verified'); f.requests[1].resolve(200, { user }); await settle(); f.flush(); assert.equal(f.locked(), false);
  await f.lock(); f.pin.value = '12';
  f.requests[0].resolve(status, status === 200 ? { user } : { error: 'authentication_required' }); await settle(); f.flush();
  assert.equal(f.locked(), true); assert.equal(f.overlay.open, true); assert.equal(f.pin.value, '12'); assert.equal(f.redirects.length, 0); assert.equal(f.overlay.querySelector('#screen-lock-message').textContent, '');
});
await test('old sibling GET cannot release later lock even with matching stored signal', async () => {
  const f = await fixture(); await f.lock(); const key = 'crm_screen_locked_user_qa-owner';
  f.signal(key, 'unlocked:old'); f.enter('1234'); f.requests[1].resolve(200, { user }); await settle(); f.flush(); assert.equal(f.locked(), false);
  await f.lock(); f.storage.set(key, 'unlocked:old'); // Exact signal equality alone is insufficient.
  f.requests[0].resolve(200, { user }); await settle(); f.flush(); assert.equal(f.locked(), true); assert.equal(f.overlay.open, true);
});
await test('cross-tab logout and token replacement redirect', async () => {
  for (const event of ['logout', 'token']) { const f = await fixture(); await f.lock();
    if (event === 'logout') f.signal('crm_session_event', JSON.stringify({ action: 'logout', userId: user.id })); else f.signal('crm_session_token', 'other');
    assert.deepEqual(f.redirects, ['/login']); assert.equal(f.locked(), true);
  }
});
await test('shared scroll lease survives context close during PIN and restores base last', async () => {
  const f = await fixture(); let current = true; const h = f.ui.open({ title: 'Draft', isCurrent: () => current, draftPolicy: 'preserve', pendingClosePolicy: 'block', fields: [{ name: 'name', label: 'Name', value: 'draft' }] });
  await f.lock(); assert.equal(h.element.inert, true); assert.equal(f.document.body.style.overflow, 'hidden');
  current = false; h.refresh(); assert.equal(h.element.isConnected, false); assert.equal(f.document.body.style.overflow, 'hidden');
  f.enter('1234'); f.requests[0].resolve(200, { user }); await settle(); f.flush(); assert.equal(f.document.body.style.overflow, 'scroll'); assert.equal(f.document.activeElement, f.heading);
});
await test('unlock while shared draft exists retains its scroll lease', async () => {
  const f = await fixture(); const h = f.ui.open({ title: 'Draft', draftPolicy: 'preserve', pendingClosePolicy: 'block', fields: [{ name: 'name', label: 'Name', value: 'draft' }] });
  await f.lock(); f.enter('1234'); f.requests[0].resolve(200, { user }); await settle(); f.flush();
  assert.equal(f.locked(), false); assert.equal(f.document.body.style.overflow, 'hidden'); assert.equal(h.form.elements.namedItem('name').value, 'draft'); assert.equal(h.element.inert, false);
  h.close(); assert.equal(f.document.body.style.overflow, 'scroll');
});

if (failures.length) { console.error(failures.join('\n\n')); process.exitCode = 1; }
console.log(`UI043 actual-source lock lifecycle: ${passed} PASS, ${failures.length} FAIL (VM mechanics only)`);
