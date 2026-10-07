import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../login.js', import.meta.url), 'utf8');

async function runLogin({ response, fetchError } = {}) {
  const listeners = new Map();
  const values = new Map();
  const storage = new Map();
  const redirects = [];
  const submit = { disabled: false, textContent: 'Войти в систему' };
  const setupSubmit = { disabled: false, textContent: 'Создать и войти' };
  const loginForm = {
    hidden: false,
    setAttribute() {},
    after(node) { values.set(`#${node.id}`, node); },
    addEventListener(name, handler) { listeners.set(`login:${name}`, handler); },
    querySelector(selector) { return selector === 'button[type="submit"]' ? submit : null; },
  };
  const setupForm = {
    hidden: true,
    addEventListener(name, handler) { listeners.set(`setup:${name}`, handler); },
    querySelector(selector) { return selector === 'button[type="submit"]' ? setupSubmit : null; },
  };
  const makeInput = (value = '') => ({ value, type: 'password', focus() {}, setAttribute() {}, addEventListener() {} });
  const loginMessage = { textContent: '' };
  const setupMessage = { textContent: '' };
  const body = { dataset: {} };
  values.set('#login-form', loginForm);
  values.set('#setup-form', setupForm);
  values.set('#setup-message', setupMessage);
  values.set('#login-message', loginMessage);
  values.set('#login-password', makeInput());
  values.set('#login-username', makeInput());
  values.set('#setup-password', makeInput());
  values.set('#setup-venue', makeInput());
  values.set('#setup-name', makeInput());
  values.set('#setup-city', makeInput());
  values.set('#setup-login', makeInput());
  values.set('#setup-timezone', makeInput());

  const localStorage = {
    getItem(key) { return storage.get(key) ?? null; },
    setItem(key, value) { storage.set(key, String(value)); },
    removeItem(key) { storage.delete(key); },
  };
  const window = {
    addEventListener() {},
    setTimeout() {},
    location: { replace(url) { redirects.push(url); } },
  };
  const location = { hash: '', replace(url) { redirects.push(url); } };
  const createNode = (tagName = 'div') => {
    const node = {
      tagName,
      className: '',
      hidden: false,
      innerHTML: '',
      textContent: '',
      value: '',
      dataset: {},
      setAttribute() {},
      focus() {},
      addEventListener() {},
      querySelector(selector) {
        if (selector === '#trusted-pin') return makeInput();
        if (selector === '#trusted-pin-message') return { textContent: '' };
        if (selector === '#trusted-pin-submit') return { disabled: false, addEventListener() {} };
        if (selector === '.trusted-pin-keypad' || selector === '#trusted-password-login') return { addEventListener() {} };
        if (selector === '[data-trusted-avatar]' || selector === '[data-trusted-user]') return { textContent: '' };
        return null;
      },
    };
    return node;
  };
  const fetch = async (url) => {
    if (url === '/api/public/venue-brand') return { ok: false };
    if (url === '/api/setup/status') return { ok: true, json: async () => ({ required: false }) };
    if (url === '/api/session') return { ok: false, status: 401, json: async () => ({ error: 'authentication_required' }) };
    if (url === '/api/login') {
      if (fetchError) throw fetchError;
      return { ok: response?.ok ?? false, json: async () => response?.body ?? {} };
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const document = {
    body,
    createElement: createNode,
    querySelector(selector) { return values.get(selector) ?? null; },
  };
  vm.runInNewContext(source, { document, window, location, localStorage, fetch, Promise, Date, URLSearchParams });

  const username = values.get('#login-username');
  const password = values.get('#login-password');
  username.value = 'admin';
  password.value = 'admin';
  await listeners.get('login:submit')({ preventDefault() {} });
  return { message: loginMessage.textContent, submit, storage, redirects };
}

const sessionLimit = await runLogin({ response: { ok: false, body: { error: 'session_limit_reached' } } });
assert.equal(sessionLimit.message, 'Учетная запись уже открыта на двух устройствах. Выйдите на одном из них и повторите вход.');
assert.equal(sessionLimit.redirects.length, 0, 'a server rejection must not redirect into a local identity');
assert.equal(sessionLimit.storage.has('crm_session_token'), false, 'a server rejection must not create a static token');
assert.equal(sessionLimit.submit.disabled, false, 'the user must be able to retry after dismissing a device session');

const invalidCredentials = await runLogin({ response: { ok: false, body: { error: 'invalid_credentials' } } });
assert.equal(invalidCredentials.message, 'Неверный логин или пароль');
assert.equal(invalidCredentials.storage.has('crm_session_token'), false);

const offlineDemo = await runLogin({ fetchError: new TypeError('Failed to fetch') });
assert.equal(offlineDemo.redirects[0], '/admin', 'legacy local demo credentials remain available only when the API cannot be reached');
assert.match(offlineDemo.storage.get('crm_session_token'), /^demo-static-admin-/);

console.log('LOGIN ERROR RUNTIME QA: PASS (HTTP 401/409 stay on login with an actionable message; local demo fallback is limited to network failure)');
