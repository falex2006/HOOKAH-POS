import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const fetchStart = source.indexOf('const staffFetchJson=async');
const fetchEnd = source.indexOf('\nconst staffRoleLabels=', fetchStart);
assert.ok(fetchStart >= 0 && fetchEnd > fetchStart, 'staffFetchJson must remain extractable');
const fetchSource = source.slice(fetchStart, fetchEnd);
const verifyStart = source.indexOf('const verifyStaffSession=()=>{');
const verifyEnd = source.indexOf('\nconst revalidateStaffSession=', verifyStart);
assert.ok(verifyStart >= 0 && verifyEnd > verifyStart, 'verifyStaffSession must remain extractable');
const verifySource = source.slice(verifyStart, verifyEnd);

const makeResponse = (status, payload) => ({
  ok: status >= 200 && status < 300,
  status,
  async json() { return payload; },
});

const runFetch = async ({ response, method = 'GET', delay = false }) => {
  let timerCallback;
  let cleared = false;
  let aborts = 0;
  let noticeText = '';
  const controller = { signal: {}, abort() { aborts += 1; } };
  const context = {
    staffAccessRevision: 0,
    AbortController: function AbortController() { return controller; },
    window: {
      setTimeout(callback) { timerCallback = callback; return 1; },
      clearTimeout() { cleared = true; },
    },
    localStorage: { getItem() { return 'server-token'; } },
    sessionHeaders() { return { Authorization: 'Bearer server-token' }; },
    notice(text) { noticeText = text; },
    fetch: async (_url, options) => {
      assert.equal(options.method, method === 'GET' ? undefined : method);
      if (delay) { timerCallback?.(); return new Promise(() => {}); }
      return response;
    },
  };
  vm.runInNewContext(`${fetchSource}; this.staffFetchJson=staffFetchJson;`, context);
  const promise = context.staffFetchJson('/api/session', method === 'GET' ? {} : { method });
  if (delay) {
    await Promise.resolve();
    assert.equal(aborts, method === 'GET' ? 1 : 0, 'only reads may be aborted by timeout');
    if (method !== 'GET') assert.match(noticeText, /не повторяйте/i);
    return { promise, cleared };
  }
  return { value: await promise, cleared, aborts };
};

const success = await runFetch({ response: makeResponse(200, { user: { id: 'roman', role: 'hookah_master' }, permissions: ['floor', 'orders'] }) });
assert.equal(success.value.user.id, 'roman');
assert.equal(success.cleared, true, 'successful session request clears its timer');

await assert.rejects(() => runFetch({ response: makeResponse(503, { error: 'temporary_unavailable' }) }), /temporary_unavailable/);
await assert.rejects(() => runFetch({ response: makeResponse(401, { error: 'unauthorized' }) }), /unauthorized/);

const readTimeout = await runFetch({ delay: true });
assert.equal(readTimeout.aborts, undefined, 'read timeout harness must return before unresolved promise');
const writeTimeout = await runFetch({ method: 'POST', delay: true });
assert.equal(writeTimeout.cleared, false, 'delayed mutation remains pending and is not retried');

const runVerify = async ({ outcome, retry = false, concurrent = false }) => {
  const values = new Map([
    ['crm_session_token', 'roman-token'],
    ['crm_session_user', JSON.stringify({ id: 'maria', name: 'Мария', role: 'owner' })],
  ]);
  const applied = []; const redirects = []; const floor = []; const products = []; const shifts = [];
  let requestCount = 0; let resolveDeferred;
  const status = { hidden: true, textContent: '', innerHTML: '', setAttribute() {} };
  const navs = [{ hidden: false, removeAttribute() {} }, { hidden: false, removeAttribute() {} }];
  const document = {
    querySelector(selector) { return selector === '#staff-session-status' ? status : null; },
    querySelectorAll(selector) { return selector.includes('.portal-sidebar') ? navs : []; },
  };
  const fetchImpl = async () => {
    requestCount += 1;
    if (outcome === 'deferred') return new Promise((resolve) => { resolveDeferred = resolve; });
    if (outcome === '401') { const error = new Error('unauthorized'); error.status = 401; throw error; }
    if (outcome === '503') { const error = new Error('temporary_unavailable'); error.status = 503; throw error; }
    if (outcome === 'malformed') return makeResponse(200, { broken: true });
    return makeResponse(200, { user: { id: 'roman', name: 'Печеников Роман Андреевич', role: 'hookah_master' }, permissions: ['floor', 'orders'] });
  };
  const context = {
    staffAccessRevision: 0, staffSessionSignature: '', staffShiftReadable: true, staffShiftManageable: true, staffSessionPermissions: new Set(),
    clearStaffAccessState() {}, clearPreparationQueue(){},loadPreparationQueue(){},applyStaffWorkAccess() {}, staffCanWork: () => true, applyStaffHeader() {},
    AbortController: function AbortController() { return { signal: {}, abort() {} }; },
    window: { setTimeout: () => 1, clearTimeout: () => {}, location: { replace: (url) => redirects.push(url) } },
    localStorage: { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: (key) => values.delete(key) },
    sessionHeaders: () => ({ Authorization: 'Bearer roman-token' }), fetch: fetchImpl, mountStaffExtensions: () => {},
    document, applyStaffSession: (session) => applied.push(session), refreshFloor: () => floor.push(1), loadProducts: () => products.push(1), refreshShift: () => shifts.push(1),
    showFloorUnavailable: (text) => { status.innerHTML = text; }, notice() {},
  };
  const instrumentedVerify = verifySource.replace("}).catch((error)=>{", "}).catch((error)=>{ globalThis.__verifyError=String(error?.stack||error);");
  vm.runInNewContext(`let staffSessionRequest=null; let staffSessionVerified=false; ${fetchSource}; ${instrumentedVerify}; this.verifyStaffSession=verifyStaffSession;`, context);
  const first = context.verifyStaffSession();
  const second = concurrent ? context.verifyStaffSession() : null;
  if (concurrent) assert.equal(first, second, 'concurrent verification must coalesce');
  if (outcome === 'deferred') resolveDeferred({ user: { id: 'roman', name: 'Печеников Роман Андреевич', role: 'hookah_master' }, permissions: ['floor'] });
  const result = await first;
  if (retry) { const retried = context.verifyStaffSession(); await retried; }
  return { result, values, applied, redirects, floor, products, shifts, status, requestCount, error: context.__verifyError };
};

const verified = await runVerify({ outcome: '200', concurrent: true });
assert.equal(verified.result, true); assert.equal(verified.requestCount, 1); assert.equal(verified.applied[0].user.name, 'Печеников Роман Андреевич');
assert.doesNotMatch(verified.values.get('crm_session_user'), /Мария/); assert.equal(verified.floor.length, 1);
const unauthorized = await runVerify({ outcome: '401' });
assert.equal(unauthorized.result, false); assert.deepEqual(unauthorized.redirects, ['/login']); assert.equal(unauthorized.values.has('crm_session_token'), false);
for (const outcome of ['503', 'malformed']) {
  const failed = await runVerify({ outcome });
  assert.equal(failed.result, false); assert.equal(failed.applied.length, 0); assert.equal(failed.floor.length, 0); assert.equal(failed.status.hidden, false);
}
const recovered = await runVerify({ outcome: '200', retry: true });
assert.equal(recovered.result, true); assert.equal(recovered.requestCount, 2, 'retry should perform a fresh session check');

assert.match(source, /if\(changed\)applyStaffSession\(session\);[\s\S]*?applyStaffWorkAccess\(\)/, 'server permissions must be applied before revealing work controls');
assert.match(source, /if\(error\.status===401\)\{localStorage\.removeItem\('crm_session_token'\);localStorage\.removeItem\('crm_session_user'\)/, '401 must clear cached identity');
assert.match(source, /showFloorUnavailable\(error\?\.name==='AbortError'\?'Схема зала отвечает слишком долго'/, 'floor timeout must expose retryable error state');
assert.match(source, /if\(retry\)\{if\(staffSessionVerified\)refreshFloor\(\);else verifyStaffSession\(\);return;\}/, 'floor failure must expose retry path');
assert.match(source, /const readOnly=\['GET','HEAD'\]/, 'mutations must be distinguished from reads');
assert.match(source, /Сервер ещё сохраняет действие\. Дождитесь результата; не повторяйте его/, 'delayed mutations must warn against duplicate submission');
console.log('STAFF SESSION RECOVERY RUNTIME QA: PASS (server session authority, 401 cleanup, 503/malformed rejection, read timeout abort, mutation timeout no retry, floor retry and duplicate-write guard)');
