import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../portal.js', import.meta.url), 'utf8');
const snippet = source.slice(source.indexOf('const API_READ_TIMEOUT_MS'), source.indexOf('window.__crmApi = api;') + 'window.__crmApi = api;'.length);
const state = new Map([['crm_session_token', 'current'], ['crm_session_user', '{}']]);
const timers = new Map();
let nextTimer = 1;
const window = { location: { href: '/inventory' } };
vm.runInNewContext(snippet, {
  window, AbortController, staticDemo: () => false, authHeaders: () => ({}),
  disposeNotificationObserver: () => {},
  localStorage: { getItem: k => state.get(k), removeItem: k => state.delete(k) },
  setTimeout: (fn, ms) => { assert.equal(ms, 20000); const id = nextTimer++; timers.set(id, fn); return id; },
  clearTimeout: id => timers.delete(id),
});
const expire = () => { for (const fn of [...timers.values()]) fn(); };
const ok = payload => ({ ok: true, status: 200, json: async () => payload });
const tokenRetained = () => { assert.equal(state.get('crm_session_token'), 'current'); assert.equal(window.location.href, '/inventory'); assert.equal(timers.size, 0); };
let calls = 0;
let signal;
let resolveStalled;
window.fetch = (_, options) => { calls++; signal = options.signal; return new Promise(resolve => { resolveStalled = resolve; }); };
const stalled = window.__crmApi('/api/inventory');
expire();
await assert.rejects(stalled, error => error.code === 'read_timeout');
assert.equal(signal.aborted, true);
tokenRetained();
// A transport which returns a late 401 after cancellation cannot log out a recovered session.
resolveStalled({ status: 401 });
await new Promise(resolve => setImmediate(resolve));
tokenRetained();
assert.equal(calls, 1, 'No automatic retries');
window.fetch = async () => ok({ recovered: true });
assert.deepEqual(await window.__crmApi('/api/inventory'), { recovered: true });
tokenRetained();
let bodyStarted;
const bodyReady = new Promise(resolve => { bodyStarted = resolve; });
window.fetch = async (_, options) => { signal = options.signal; return { ok: true, status: 200, json: () => { bodyStarted(); return new Promise(() => {}); } }; };
const bodyStalled = window.__crmApi('/api/inventory');
await bodyReady;
expire();
await assert.rejects(bodyStalled, error => error.code === 'read_timeout');
assert.equal(signal.aborted, true);
tokenRetained();
const caller = new AbortController();
let removed = 0;
const remove = caller.signal.removeEventListener.bind(caller.signal);
caller.signal.removeEventListener = (...args) => { removed++; remove(...args); };
window.fetch = () => new Promise(() => {});
const cancelled = window.__crmApi('/api/inventory', { signal: caller.signal });
const reason = new Error('caller cancelled');
caller.abort(reason);
await assert.rejects(cancelled, error => error === reason);
assert.equal(removed, 1);
tokenRetained();
const prior = new AbortController(); prior.abort(reason);
window.fetch = () => { throw new Error('pre-aborted read must not fetch'); };
await assert.rejects(window.__crmApi('/api/inventory', { signal: prior.signal }), error => error === reason);
tokenRetained();
for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
  const mutationSignal = new AbortController().signal;
  window.fetch = async (_, options) => { assert.equal(options.signal, mutationSignal); assert.equal(options.method, method); assert.equal(timers.size, 0); return ok({ saved: true }); };
  assert.deepEqual(await window.__crmApi('/api/items', { method, signal: mutationSignal }), { saved: true });
}
let finish;
window.fetch = () => new Promise(resolve => { finish = resolve; });
const stale = window.__crmApi('/api/inventory');
state.set('crm_session_token', 'new-session');
finish({ status: 401 });
await assert.rejects(stale, /session_access_changed/);
assert.equal(state.get('crm_session_token'), 'new-session');
assert.equal(window.location.href, '/inventory');
assert.equal(timers.size, 0);
window.fetch = async () => ({ status: 401 });
await assert.rejects(window.__crmApi('/api/inventory'), error => error.status === 401);
assert.equal(state.has('crm_session_token'), false);
assert.equal(window.location.href, '/login');
assert.equal(timers.size, 0);
console.log('PASS: bounded GET fetch/body, cancellation cleanup, recovery, late/stale 401, current 401, mutations unchanged');

const logoutStart = source.indexOf("document.querySelector('#logout')?.addEventListener");
const logoutEnd = source.indexOf("const page =", logoutStart);
assert.ok(logoutStart >= 0 && logoutEnd > logoutStart);
for (const staleResponse of [true, false]) {
  let handler;
  let completeLogout;
  let broadcasts = 0;
  let themesCleared = 0;
  const storage = new Map([['crm_session_token', 'old'], ['crm_session_user', '{}']]);
  const button = { disabled: false };
  const navigation = [];
  vm.runInNewContext(source.slice(logoutStart, logoutEnd), {
    document: { querySelector: selector => selector === '#logout' ? { addEventListener: (_, callback) => { handler = callback; } } : null },
    window: { HOOKAH_MANAGEMENT_THEME: { clear: () => { themesCleared++; } }, __broadcastSessionEnd: () => { broadcasts++; }, location: { replace: path => navigation.push(path) } },
    localStorage: { getItem: key => storage.get(key), removeItem: key => storage.delete(key) },
    authHeaders: () => ({ Authorization: `Bearer ${storage.get('crm_session_token')}` }),
    fetch: (_, options) => { assert.equal(options.headers.Authorization, 'Bearer old'); return new Promise(resolve => { completeLogout = resolve; }); },
  });
  const pendingLogout = handler({ currentTarget: button });
  if (staleResponse) storage.set('crm_session_token', 'new');
  completeLogout({ ok: true, status: 200 });
  await pendingLogout;
  if (staleResponse) {
    assert.equal(storage.get('crm_session_token'), 'new');
    assert.equal(storage.get('crm_session_user'), '{}');
    assert.equal(broadcasts, 0);
    assert.equal(themesCleared, 0);
    assert.deepEqual(navigation, []);
    assert.equal(button.disabled, false);
  } else {
    assert.equal(storage.has('crm_session_token'), false);
    assert.equal(broadcasts, 1);
    assert.equal(themesCleared, 1);
    assert.deepEqual(navigation, ['/login']);
  }
}
console.log('PASS: explicit logout clears only the session which initiated it');
