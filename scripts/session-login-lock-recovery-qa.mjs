import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const login = fs.readFileSync(new URL('../login.js', import.meta.url), 'utf8');
const lock = fs.readFileSync(new URL('../lock.js', import.meta.url), 'utf8');
// Loading /login in a sibling tab (including a stale redirect) preserves the
// current shared identity. Exercise bootstrap, before any user form action.
const storage = new Map([['crm_session_token', 'new-session'], ['crm_session_user', '{"id":"new-user"}']]);
vm.runInNewContext(login.slice(0, login.indexOf('const setupForm')), {
  document: { querySelector() { return null; } },
  localStorage: { removeItem(key) { storage.delete(key); } },
});
assert.equal(storage.get('crm_session_token'), 'new-session');
assert.equal(storage.get('crm_session_user'), '{"id":"new-user"}');

const unlockSource = lock.slice(lock.indexOf('  const unlock = async'), lock.indexOf("  pinInput.addEventListener('input'"));
let timerCallback;
let released = 0, redirected = 0, calls = 0, cleared = 0;
let responseMode = 'stall';
let current = true;
const context = {
  locked: true, unlockRequest: null, lockEpoch: 1,
  pinInput: { value: '1234' }, currentSession: () => current,
  redirectToLogin: () => { redirected++; }, headers: () => ({}),
  AbortController, setTimeout(fn) { timerCallback = fn; return 1; }, clearTimeout() { cleared++; },
  fetch(_url, options) {
    calls++;
    if (responseMode === 'stall') return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    if (responseMode === 'body-stall') return Promise.resolve({ ok: true, json: () => new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))) });
    return Promise.resolve({ ok: responseMode === 'success', status: 401, json: async () => responseMode === 'success' ? { user: { id: 'owner' } } : { error: responseMode } });
  },
  identity: user => user.id, activeIdentity: 'owner',
  localStorage: { setItem() {} }, lockStateKey: 'lock',
  releaseLock() { released++; }, setMessage(message) { context.message = message; },
};
vm.createContext(context);
vm.runInContext(`${unlockSource}\nthis.unlock = unlock;`, context);
for (const mode of ['stall', 'body-stall']) {
  responseMode = mode; context.pinInput.value = '1234';
  const pending = context.unlock();
  await Promise.resolve();
  const before = calls; await context.unlock();
  assert.equal(calls, before, 'no concurrent PIN submission');
  timerCallback(); await pending;
  assert.equal(context.unlockRequest, null, 'timeout allows deliberate retry');
  assert.equal(released, 0, 'timeout never unlocks');
  assert.equal(redirected, 0, 'transport failure never logs out');
  assert.match(context.message, /повторите/);
}
responseMode = 'invalid_pin'; context.pinInput.value = '1234'; await context.unlock();
assert.equal(redirected, 0, 'wrong PIN keeps session');
assert.match(context.message, /Неверный/);
responseMode = 'success'; context.pinInput.value = '1234'; await context.unlock();
assert.equal(released, 1, 'retry with valid PIN unlocks');
responseMode = 'authentication_required'; context.pinInput.value = '1234'; await context.unlock();
assert.equal(redirected, 1, 'real expiry still redirects');
assert.equal(cleared, 5, 'every request clears its timer');

const logoutSource = lock.slice(lock.indexOf('  const logout = async'), lock.indexOf('  const icon ='));
let resolveLogout;
let removed = 0, broadcast = 0;
Object.assign(context, {
  overlay: { querySelector: () => ({ disabled: false }) },
  localStorage: { getItem: () => 'token', removeItem() { removed++; } },
  window: { __broadcastSessionEnd() { broadcast++; } }, location: { replace() { redirected++; } },
  fetch: () => new Promise(resolve => { resolveLogout = resolve; }),
});
vm.runInContext(`${logoutSource}\nthis.logout = logout;`, context);
current = true; const pendingLogout = context.logout();
current = false; resolveLogout({ ok: true }); await pendingLogout;
assert.equal(removed, 0, 'stale logout cannot erase replacement session');
assert.equal(broadcast, 0, 'stale logout cannot broadcast replacement logout');
const app = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const appLogout = app.split('\n').find(line => line.startsWith("document.addEventListener('click', async") && line.includes("closest('#logout')"));
assert.ok(appLogout, 'staff logout handler found');
let staffLogout;
let storedToken = 'old-token';
let staffRemoved = 0;
const staffContext = {
  document: { addEventListener(_event, handler) { staffLogout = handler; } },
  localStorage: { getItem() { return storedToken; }, removeItem() { staffRemoved++; } },
  fetch: () => new Promise(resolve => { resolveLogout = resolve; }),
  window: { location: { replace() {} }, __broadcastSessionEnd() { broadcast++; } },
  staffNotificationCenter: { dispose() {} }, notice() {}, sessionHeaders: () => ({}),
};
vm.runInNewContext(appLogout, staffContext);
const staffPending = staffLogout({ target: { closest: () => ({ disabled: false }) } });
storedToken = 'replacement-token'; resolveLogout({ ok: true }); await staffPending;
assert.equal(staffRemoved, 0, 'staff stale logout preserves replacement account');
assert.equal(broadcast, 0, 'staff stale logout does not broadcast');
const normalLogout = staffLogout({ target: { closest: () => ({ disabled: false }) } });
resolveLogout({ ok: true }); await normalLogout;
assert.equal(staffRemoved, 3, 'explicit current staff logout clears session and workspace');
assert.equal(broadcast, 1, 'explicit current logout still propagates');
console.log('SESSION LOGIN/LOCK RECOVERY QA: PASS (passive login, PIN transport/body timeout, retry, expiry, stale logout)');
