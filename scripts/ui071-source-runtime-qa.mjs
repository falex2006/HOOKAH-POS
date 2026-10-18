import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';

// Actual product closures and shared module, controlled DOM/API. No browser or database writes.
const root = new URL('../', import.meta.url);
const app = fs.readFileSync(new URL('app.js', root), 'utf8').replaceAll('\r\n', '\n');
const portal = fs.readFileSync(new URL('portal.js', root), 'utf8').replaceAll('\r\n', '\n');
const shared = fs.readFileSync(new URL('ui-dialog.js', root), 'utf8');
const mechanics = fs.readFileSync(new URL('scripts/ui-dialog-lifecycle-contract.mjs', root), 'utf8');
const startFixture = mechanics.indexOf('const decode ='), endFixture = mechanics.indexOf('\nconst defaults =', startFixture);
assert.ok(startFixture > 0 && endFixture > startFixture);
const baseFixture = new Function('vm', 'source', `${mechanics.slice(startFixture, endFixture)}; return fixture;`)(vm, shared);
function fixture() {
  const f = baseFixture(), setAttribute = f.Node.prototype.setAttribute;
  f.Node.prototype.setAttribute = function (name, value) {
    this.classList.toggle ||= (className, force) => { const add = force ?? !this.classList.contains(className); this.classList[add ? 'add' : 'remove'](className); return add; };
    return setAttribute.call(this, name, value);
  };
  return f;
}
const span = (source, start, end) => {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, `actual source boundaries ${start}`);
  return source.slice(a, b);
};
const payment = span(app, "const paymentModal=document.querySelector('#payment-modal')", "\ndocument.querySelectorAll('.chips button')");
const formatter = span(app, 'const staffStockErrorMessage=', "\ndocument.querySelector('.close')");
const tick = () => new Promise(resolve => setImmediate(resolve));
const result = (paid = 0, remaining = 500, extra = {}) => ({ due: 500, paid, remaining, items: [], ...extra });
const checks = [];
const check = async (name, run) => { try { await run(); checks.push({ name, status: 'PASS' }); } catch (error) { checks.push({ name, status: 'FAIL', error: error.stack }); } };
const listeners = (node, type) => node.listeners.get(type)?.size || 0;
async function dispatch(node, type, extra = {}) { const e = node.dispatch(type, extra); await Promise.all(e.results); return e.event; }

function paymentFixture() {
  const f = fixture();
  const originalMatches = f.Node.prototype.matches;
  f.Node.prototype.matches = function (selector) { return originalMatches.call(this, selector.replace(/\[([\w-]+)=([^"'\]\s]+)\]/g, '[$1="$2"]')); };
  f.Node.prototype.replaceChildren = function (...nodes) { this.textContent = ''; this.append(...nodes); };
  Object.defineProperty(f.Node.prototype, 'options', { configurable: true, get() { return this.children; } });
  f.main.innerHTML = `<button id="split-payment" type="button">Оплата</button><div id="payment-modal" class="payment-modal"><form id="payment-form" class="payment-box"><header class="modal-head"><h2 id="payment-title">Оплата заказа</h2><button id="payment-close" data-ui-close type="button">Закрыть</button></header><div class="payment-summary"><p id="payment-due"></p><p id="payment-remaining"></p></div><div class="payment-fields">${['cash','card','qr','bonus','deposit','reservation'].map(name => `<label id="payment-${name}-field"><input id="payment-${name}" name="${name}" type="number" value="0"></label>`).join('')}<select id="payment-reservation-receipt" name="receipt"><option value="">Нет</option></select></div><p id="payment-message"></p><button id="payment-submit" type="submit">Принять оплату</button></form></div>`;
  const requests = [], notices = [], pricing = [];
  Object.assign(f.context, { crypto: { randomUUID: crypto.randomUUID }, CSS: { escape: value => value },
    apiJson: (path, options) => new Promise((resolve, reject) => requests.push({ path, options, resolve, reject })),
    notice: message => notices.push(message), orderHeaders: () => ({}), sessionHeaders: () => ({ Authorization: 'Bearer test-session-token' }),
    refreshOrderPricingSummary: async (order, state) => pricing.push({ id: order?.id, state }),
    staffCanWork: () => true, escapeFloorText: value => value,
    pluralRu: (_n, one) => one,
    localStorage: { getItem: () => 'test-session-token' }, loadSharedUI: async () => f.ui,
  });
  f.context.window.crypto = f.context.crypto;
  vm.runInContext(`let currentOrder={id:'order-a',status:'open',items:[{unitPrice:500,quantity:1}]};
    let floorVenueId='venue-a',staffAccessRevision=1,staffSessionVerified=true,staffSessionPermissions=new Set(['orders']),openOrders=[currentOrder],orderLoads=0,floorLoads=0;
    const drawQueue=()=>{},drawOrder=()=>{},loadOrders=async()=>{orderLoads++;},refreshFloor=async()=>{floorLoads++;};
    ${formatter}\n${payment}\n
    globalThis.runtime={setOrder:value=>{currentOrder=value;},setVenue:value=>{floorVenueId=value;staffAccessRevision++;},setPermission:value=>{staffSessionPermissions=value?new Set(['orders']):new Set();},presentation:()=>paymentPresentation,
      state:()=>({currentOrder,paymentState,paymentLoadRevision,pending:[...paymentPostsPending],keys:[...paymentAttemptKeys],reconciliations:typeof paymentReconciliations==='undefined'?[]:[...paymentReconciliations],orderLoads,floorLoads})};`, f.context, { filename: 'app.js:payment actual closure' });
  const q = selector => f.document.querySelector(selector);
  return { ...f, requests, notices, pricing, q, runtime: f.context.runtime,
    open: () => dispatch(q('#split-payment'), 'click'), submit: () => dispatch(q('#payment-form'), 'submit'),
    isOpen: () => q('#payment-modal').classList.contains('open') || Boolean(f.document.querySelector('.ui-modal')),
  };
}
async function ready(f) { const p = f.open(); await tick(); assert.equal(f.requests.length, 1); f.requests[0].resolve(result()); await p; }
await check('payment deferred shared module two rapid opens creates one shell adapter and cleans up', async () => {
  const f = paymentFixture(); let resolveUI, adapters = 0; const loading = new Promise(resolve => { resolveUI = resolve; });
  f.context.loadSharedUI = () => loading;
  const first = f.open(), second = f.open(); assert.equal(f.requests.length, 0);
  resolveUI({ ...f.ui, critical: options => { adapters++; return f.ui.critical(options); } }); await tick();
  assert.equal(adapters, 1); assert.equal(f.q('#payment-form').querySelectorAll('.ui-modal-body').length, 1);
  assert.equal(f.q('#payment-form').querySelectorAll('.ui-modal-footer').length, 1);
  assert.equal(f.q('#payment-modal').querySelectorAll('.ui-critical-pending').length, 1); assert.equal(f.observers.size, 1);
  assert.equal(f.requests.length, 2); f.requests[1].resolve(result(200, 300)); await second; f.requests[0].resolve(result(0, 500)); await first;
  assert.equal(f.runtime.state().paymentState.remaining, 300, 'older open cannot overwrite later authoritative balance');
  f.runtime.presentation().close(); f.runtime.presentation().destroy();
  assert.equal(f.observers.size, 0); assert.equal(listeners(f.document, 'keydown'), 0); assert.equal(listeners(f.q('#payment-modal'), 'cancel'), 0);
  assert.equal(f.q('#payment-form').querySelectorAll('.ui-critical-pending').length, 0);
});
await check('payment authoritative loading and overpayment rejection', async () => {
  const f = paymentFixture(), opening = f.open(); await tick(); assert.equal(f.q('#payment-submit').disabled, true);
  f.requests[0].resolve(result(200, 300)); await opening;
  f.q('#payment-cash').value = '400'; await f.submit(); assert.equal(f.requests.length, 1);
  assert.match(f.q('#payment-message').textContent, /больше остатка/); assert.equal(f.runtime.state().paymentState.paid, 200);
});
await check('payment mixed partial failure reconciles and retry retains failed intent only', async () => {
  const f = paymentFixture(); await ready(f); f.q('#payment-cash').value = '200'; f.q('#payment-card').value = '300';
  const paying = f.submit(); assert.equal(f.requests[1].options.method, 'POST');
  f.requests[1].resolve(result(200, 300)); await tick();
  assert.equal(f.q('#payment-cash').value, '0'); const failedKey = JSON.parse(f.requests[2].options.body).idempotencyKey;
  f.requests[2].reject({ payload: { error: 'open_shift_required' } }); await tick();
  assert.equal(f.requests[3].options?.method, undefined); assert.match(f.requests[3].path, /order-a/);
  f.requests[3].resolve(result(200, 300)); await paying;
  assert.equal(f.q('#payment-card').value, '0'); assert.equal(f.runtime.state().paymentState.remaining, 300);
  f.q('#payment-card').value = '300'; const retry = f.submit();
  assert.equal(JSON.parse(f.requests[4].options.body).idempotencyKey, failedKey);
  assert.equal(JSON.parse(f.requests[4].options.body).method, 'card');
  f.requests[4].resolve(result(500, 0, { closed: true })); await retry;
  assert.equal(f.requests.filter(r => r.options?.method === 'POST' && JSON.parse(r.options.body).method === 'cash').length, 1);
});
await check('payment slow POST blocks duplicate close Escape and backdrop', async () => {
  const f = paymentFixture(); await ready(f); f.q('#payment-cash').value = '100'; const pending = f.submit();
  await f.submit(); assert.equal(f.requests.length, 2);
  await dispatch(f.q('#payment-close'), 'click'); f.document.dispatch('keydown', { key: 'Escape' });
  const shell = f.document.querySelector('.ui-modal') || f.q('#payment-modal');
  shell.dispatch('pointerdown'); shell.dispatch('pointerup'); shell.dispatch('click');
  assert.equal(f.isOpen(), true); assert.equal(f.q('#payment-cash').disabled, true);
  f.requests[1].resolve(result(100, 400)); await pending;
  assert.equal(f.runtime.state().pending.length, 0);
});
await check('payment stale successful first mixed entry never posts second into new order', async () => {
  const f = paymentFixture(); await ready(f); f.q('#payment-cash').value = '200'; f.q('#payment-card').value = '300'; const p = f.submit();
  f.runtime.setOrder({ id: 'order-b', items: [{ quantity: 1, unitPrice: 500 }] });
  f.requests[1].resolve(result(200, 300)); await p;
  assert.equal(f.requests.filter(r => r.options?.method === 'POST').length, 1);
  assert.equal(f.runtime.state().currentOrder.id, 'order-b'); assert.equal(f.runtime.state().currentOrder.paid, undefined);
});
await check('payment venue change defers reconciliation then original venue reopen reads before POST', async () => {
  const f = paymentFixture(); await ready(f); f.q('#payment-cash').value = '200'; f.q('#payment-card').value = '300'; const p = f.submit();
  f.requests[1].resolve(result(200, 300)); await tick();
  f.runtime.setVenue('venue-b'); f.runtime.setOrder({ id: 'order-b', items: [] });
  f.requests[2].reject({ payload: { error: 'forbidden' } }); await tick();
  await p; assert.equal(f.requests.length, 3, 'do not send original read to mutable new venue');
  assert.equal(f.runtime.state().reconciliations[0]?.[0], 'venue-a:order-a');
  assert.equal(f.runtime.state().currentOrder.id, 'order-b'); assert.equal(f.runtime.state().currentOrder.paid, undefined);
  f.runtime.setVenue('venue-a'); f.runtime.setOrder({ id: 'order-a', items: [{ quantity: 1, unitPrice: 500 }] });
  const reopened = f.open(); await tick(); assert.match(f.requests[3].path, /order-a/); assert.equal(f.requests[3].options?.method, undefined);
  await f.submit(); assert.equal(f.requests.length, 4, 'reopen read must settle before any retry');
  f.requests[3].resolve(result(200, 300)); await reopened;
  assert.equal(f.runtime.state().paymentState.remaining, 300); assert.equal(f.runtime.state().reconciliations.length, 0);
  f.q('#payment-card').value = '300'; const retry = f.submit();
  assert.equal(JSON.parse(f.requests[4].options.body).idempotencyKey, JSON.parse(f.requests[2].options.body).idempotencyKey);
  f.requests[4].resolve(result(500, 0, { closed: true })); await retry;
});
await check('payment same venue changed order failure reconciles captured origin only', async () => {
  const f = paymentFixture(); await ready(f); f.q('#payment-cash').value = '200'; f.q('#payment-card').value = '300'; const original = f.runtime.state().currentOrder, p = f.submit();
  f.requests[1].resolve(result(200, 300)); await tick(); f.runtime.setOrder({ id: 'order-b', items: [] });
  f.requests[2].reject(new Error('offline')); await tick(); assert.match(f.requests[3].path, /order-a/);
  f.requests[3].resolve(result(200, 300)); await p;
  assert.equal(original.paid, 200); assert.equal(original.remaining, 300); assert.equal(f.runtime.state().currentOrder.paid, undefined);
  assert.equal(f.runtime.state().reconciliations.length, 0);
});
await check('payment permission loss before submission sends no POST', async () => {
  const f = paymentFixture(); await ready(f); f.q('#payment-cash').value = '100'; f.runtime.setPermission(false);
  await f.submit(); assert.equal(f.requests.length, 1);
});
await check('payment permission loss pending first mixed success starts no stale reads or second POST', async () => {
  const f = paymentFixture(); await ready(f); const pricingBefore = f.pricing.length;
  f.q('#payment-cash').value = '200'; f.q('#payment-card').value = '300'; const p = f.submit();
  f.runtime.setPermission(false); f.requests[1].resolve(result(200, 300)); await p;
  assert.equal(f.requests.length, 2); assert.equal(f.pricing.length, pricingBefore, 'no pricing read after orders permission revoked');
  assert.equal(f.runtime.state().reconciliations[0]?.[0], 'venue-a:order-a');
});
await check('payment reconcile failure disables submit until authoritative reopen', async () => {
  const f = paymentFixture(); await ready(f); f.q('#payment-cash').value = '100'; const p = f.submit();
  f.requests[1].reject({ payload: { error: 'forbidden' } }); await tick(); f.requests[2].reject(new Error('offline')); await p;
  assert.equal(f.q('#payment-submit').disabled, true); assert.equal(f.runtime.state().paymentState, null);
  await f.submit(); assert.equal(f.requests.length, 3);
});

const refundSource = span(portal, '  const paymentMethodLabel = (method) =>', '  const total = (order) => {');
function refundFixture() {
  const f = fixture(), requests = [], notices = [], storage = new Map(); let permitted = true, identity = 'owner|venue-a';
  const matches = f.Node.prototype.matches;
  f.Node.prototype.matches = function (selector) { return matches.call(this, selector.replace(/\[([\w-]+)=([^"'\]\s]+)\]/g, '[$1="$2"]')); };
  const setAttribute = f.Node.prototype.setAttribute;
  f.Node.prototype.setAttribute = function (name, value) { setAttribute.call(this, name, value); if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(value); };
  f.Node.prototype.before = function (node) { const parent = this.parentNode, index = parent.children.indexOf(this); node.remove(); parent.children.splice(index, 0, node); node.parentNode = parent; };
  f.Node.prototype.replaceChildren = function (...nodes) { this.textContent = ''; this.append(...nodes); };
  f.Node.prototype.showModal = function () { this.open = true; this.setAttribute('open', ''); };
  f.Node.prototype.close = function () { this.open = false; this.removeAttribute('open'); this.dispatch('close'); };
  const localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)), removeItem: key => storage.delete(key) };
  Object.assign(f.context, { crypto: { randomUUID: crypto.randomUUID }, CSS: { escape: value => value }, localStorage,
    api: (path, options) => new Promise((resolve, reject) => requests.push({ path, options, resolve, reject })),
    portalNotice: message => notices.push(message), portalEditorIdentity: () => identity, hasPortalPermission: () => permitted,
    portalCriticalContext: () => identity, loadSharedUI: async () => f.ui, styleCriticalControls: () => {},
    portalUser: { role: 'owner', id: 'owner-a', venueId: 'venue-a' }, target: f.main,
    esc: value => value, money: value => String(value), formatRuDate: value => value, displayOrderId: value => value,
  });
  vm.runInContext(`const canReadOrderRefunds=true,canCreateOrderRefunds=true;\n${refundSource}\n
    globalThis.refundRuntime={open:renderRefundOrder,close:closeRefundDialog,
      state:()=>({activeRefundOrder,activeRefundGeneration}),dialog:refundDialog};`, f.context, { filename: 'portal.js:refund actual closure' });
  return { ...f, requests, notices, storage, runtime: f.context.refundRuntime,
    setContext: value => { identity = value; f.context.portalUser.venueId = value.split('|').at(-1); }, setPermission: value => permitted = value,
  };
}
const refundOrder = id => ({ id, status: 'closed', tableName: 'Тестовый стол' });
const paymentId = '00000000-0000-4000-8000-000000000001';
async function readyRefund(f, id = 'order-a') {
  const offset = f.requests.length, p = f.runtime.open(refundOrder(id));
  await tick();
  f.requests[offset].resolve({ items: [{ id: paymentId, method: 'cash', status: 'paid', amount: 500 }] });
  f.requests[offset + 1].resolve({ items: [], returnableItems: [], lineSnapshotStatus: 'missing' }); await p;
  return f.runtime.dialog.querySelector('[data-order-refund-form]');
}
await check('refund native cancel cleanup prevents stale load and clears active order', async () => {
  const f = refundFixture(), p = f.runtime.open(refundOrder('order-a')); await tick(); const before = f.runtime.state().activeRefundGeneration;
  const e = f.runtime.dialog.dispatch('cancel').event;
  if (!e.defaultPrevented) f.runtime.dialog.close();
  assert.equal(f.runtime.state().activeRefundOrder, null);
  assert.ok(f.runtime.state().activeRefundGeneration > before);
  f.requests[0].resolve({ items: [] }); f.requests[1].resolve({ items: [] }); await p;
  assert.equal(f.runtime.dialog.open, false);
});
await check('refund close reopen ignores stale earlier read', async () => {
  const f = refundFixture(), first = f.runtime.open(refundOrder('order-a')); await tick(); f.runtime.close();
  const second = f.runtime.open(refundOrder('order-b')); await tick();
  f.requests[2].resolve({ items: [] }); f.requests[3].resolve({ items: [] }); await second;
  f.requests[0].resolve({ items: [{ method: 'cash', amount: 999, status: 'paid' }] }); f.requests[1].resolve({ items: [] }); await first;
  assert.equal(f.runtime.state().activeRefundOrder.id, 'order-b');
  assert.ok(!f.runtime.dialog.textContent.includes('999'));
  assert.equal(listeners(f.runtime.dialog, 'cancel'), 1);
});
await check('refund pending POST blocks duplicate submit cancel and close', async () => {
  const f = refundFixture(), form = await readyRefund(f);
  form.querySelector('[data-refund-source]').value = '100.00'; form.querySelector('textarea[name="reason"]').value = 'Проверка возврата';
  form.dispatch('input'); const first = dispatch(form, 'submit');
  assert.equal(f.requests[2].options.method, 'POST'); const saved = JSON.parse(f.requests[2].options.body);
  assert.equal(saved.amount, '100.00'); assert.ok(saved.idempotencyKey);
  form.dispatch('submit'); assert.equal(f.requests.filter(r => r.options?.method === 'POST').length, 1);
  const e = f.runtime.dialog.dispatch('cancel').event; if (!e.defaultPrevented) f.runtime.dialog.close();
  f.runtime.close(); assert.equal(f.runtime.dialog.open, true);
  f.requests[2].reject(new Error('offline')); await first;
  assert.equal(f.storage.size, 1, 'ambiguous intent retained for safe retry');
  assert.equal(f.runtime.dialog.querySelector('[data-refund-footer] [type="submit"]').disabled, false, 'settled ambiguous error keeps retry CTA available');
});
await check('refund ambiguous retry reuses exact persisted intent and rereads after success', async () => {
  const f = refundFixture(), form = await readyRefund(f);
  form.querySelector('[data-refund-source]').value = '100.00'; form.querySelector('textarea[name="reason"]').value = 'Проверка повтора';
  form.dispatch('input'); const first = dispatch(form, 'submit'); const payload = f.requests[2].options.body;
  f.requests[2].reject(new Error('offline')); await first;
  assert.equal(f.runtime.dialog.querySelector('[data-refund-footer] [type="submit"]').disabled, false);
  const retry = dispatch(form, 'submit'); assert.equal(f.requests[3].options.body, payload);
  f.requests[3].resolve({ idempotentReplay: true }); await tick();
  assert.match(f.requests[4].path, /order-a/); assert.match(f.requests[5].path, /order-a/);
  f.requests[4].resolve({ items: [] }); f.requests[5].resolve({ items: [{ amount: 100, reason: 'Проверка повтора' }] }); await retry;
  assert.equal(f.storage.size, 0); assert.match(f.runtime.dialog.textContent, /Проверка повтора/);
});
await check('refund context changed pending success clears intent but cannot reopen old entity', async () => {
  const f = refundFixture(), form = await readyRefund(f);
  form.querySelector('[data-refund-source]').value = '100.00'; form.querySelector('textarea[name="reason"]').value = 'Проверка контекста'; form.dispatch('input');
  const p = dispatch(form, 'submit'); f.setContext('owner|venue-b'); f.flush();
  assert.equal(f.runtime.dialog.open, true, 'inflight result retained until settlement');
  f.requests[2].resolve({}); await p;
  assert.equal(f.requests.length, 3, 'old venue readback must not use new venue'); assert.equal(f.runtime.dialog.open, false);
  assert.equal(f.runtime.state().activeRefundOrder, null); assert.equal(f.storage.size, 0);
});
await check('refund permission loss before submission sends no financial POST', async () => {
  const f = refundFixture(), form = await readyRefund(f);
  form.querySelector('[data-refund-source]').value = '100.00'; form.querySelector('textarea[name="reason"]').value = 'Проверка права'; form.dispatch('input');
  f.setPermission(false); await dispatch(form, 'submit'); assert.equal(f.requests.length, 2);
});

function criticalFixture() {
  const f = fixture(); let pending = false, context = 'venue-a'; const closed = [];
  f.Node.prototype.showModal = function () { this.open = true; this.setAttribute('open', ''); };
  f.Node.prototype.close = function () { this.open = false; this.removeAttribute('open'); this.dispatch('close'); };
  const dialog = new f.Node('dialog'); dialog.innerHTML = '<header><h2 id="critical-title">Операция</h2><button data-ui-close type="button">Закрыть</button></header><div class="ui-modal-body"><input name="amount" value="100"><input name="blocked" value="original" disabled></div><footer><button data-ui-cancel type="button">Отмена</button><button type="submit">Провести</button></footer>';
  f.document.body.append(dialog);
  const create = () => f.ui.critical({ element: dialog, titleId: 'critical-title', body: dialog.querySelector('.ui-modal-body'), context: () => context,
    isPending: () => pending, initialFocus: () => dialog.querySelector('input'), onClose: reason => closed.push(reason) });
  const h = create(); return { ...f, dialog, h, closed, create, pending: value => { pending = value; h.refresh(); }, context: value => { context = value; h.refresh(); } };
}
await check('critical primitive native cancel restores lease focus and cleanup once', () => {
  const f = criticalFixture(); f.h.open(); assert.equal(f.main.inert, true); assert.equal(f.document.body.style.overflow, 'hidden');
  const e = f.dialog.dispatch('cancel').event; assert.equal(e.defaultPrevented, true);
  assert.equal(f.dialog.open, false); assert.equal(f.closed.length, 1); assert.equal(f.main.inert, false);
  assert.equal(f.document.body.style.overflow, 'scroll'); assert.equal(f.document.activeElement, f.trigger); f.h.destroy();
});
await check('critical primitive pending blocks all close routes and restores original disabled', () => {
  const f = criticalFixture(); f.h.open(); f.pending(true);
  assert.equal(f.h.close(), false); assert.equal(f.dialog.querySelector('[name="amount"]').disabled, true);
  assert.equal(f.dialog.dispatch('cancel').event.defaultPrevented, true);
  f.document.dispatch('keydown', { key: 'Escape' }); f.dialog.dispatch('pointerdown'); f.dialog.dispatch('pointerup'); f.dialog.dispatch('click');
  assert.equal(f.dialog.open, true); assert.equal(f.closed.length, 0);
  f.pending(false); assert.equal(f.dialog.querySelector('[name="amount"]').disabled, false);
  assert.equal(f.dialog.querySelector('[name="blocked"]').disabled, true); f.h.close(); f.h.destroy();
});
await check('critical primitive unexpected native close while pending reopens without cleanup', () => {
  const f = criticalFixture(); f.h.open(); f.pending(true); f.dialog.close();
  assert.equal(f.dialog.open, true); assert.equal(f.closed.length, 0); assert.equal(f.main.inert, true);
  f.pending(false); f.h.close(); assert.equal(f.closed.length, 1); f.h.destroy();
});
await check('critical primitive keyboard Tab trap and select Escape consume first', () => {
  const f = criticalFixture(); f.h.open();
  const buttons = f.dialog.querySelectorAll('button'); const first = buttons[0], last = buttons.at(-1);
  last.focus(); const e = f.document.dispatch('keydown', { key: 'Tab' }).event;
  assert.equal(e.defaultPrevented, true); assert.equal(f.document.activeElement, first);
  f.document.dispatch('keydown', { key: 'Tab', shiftKey: true }); assert.equal(f.document.activeElement, last);
  const select = new f.Node('div'); select.className = 'custom-select is-open'; const trigger = new f.Node('button'); trigger.className = 'custom-select-trigger'; select.append(trigger); f.dialog.querySelector('.ui-modal-body').append(select);
  f.document.dispatch('keydown', { key: 'Escape' }); assert.equal(f.dialog.open, true); assert.equal(select.classList.contains('is-open'), false);
  f.document.dispatch('keydown', { key: 'Escape' }); assert.equal(f.dialog.open, false); f.h.destroy();
});
await check('critical primitive context change waits for pending then closes', () => {
  const f = criticalFixture(); f.h.open(); f.pending(true); f.context('venue-b'); assert.equal(f.dialog.open, true);
  assert.equal(f.dialog.classList.contains('ui-critical-context-lost'), true); assert.equal(f.dialog.querySelector('.ui-critical-pending').hidden, false);
  f.pending(false); assert.equal(f.dialog.open, false); assert.equal(f.closed.length, 1); f.h.destroy();
});
await check('shared confirmation observer context lost pending conceals draft and retains result', async () => {
  const f = fixture(); let context = 'venue-a', resolve; const h = f.ui.open({ title: 'Подтверждение', fields: [{ name: 'reason', label: 'Причина', value: 'Частные данные' }], draftPolicy: 'preserve', pendingClosePolicy: 'block', context: () => context, onSubmit: () => new Promise(done => { resolve = done; }) });
  const p = dispatch(h.form, 'submit'); context = 'venue-b'; f.flush();
  assert.equal(h.element.classList.contains('ui-critical-context-lost'), true); assert.equal(h.element.querySelector('[data-ui-pending]').hidden, false);
  assert.equal(h.pending, true); assert.equal(h.element.isConnected, true);
  resolve({ operation: 'accepted' }); await p; assert.equal((await h.promise).reason, 'context-changed'); assert.equal(h.element.isConnected, false);
});
await check('critical primitive repeated bind destroy does not retain per-element listeners', () => {
  const f = criticalFixture(); f.h.destroy();
  const types = ['cancel','close','pointerdown','pointerup','click'];
  for (const type of types) assert.equal(listeners(f.dialog, type), 0, `destroy removes ${type} listener`);
  const h = f.create(); h.open(); h.close(); h.destroy();
  assert.equal(f.observers.size, 0); assert.equal(listeners(f.document, 'keydown'), 0);
});

const criticalAction = span(portal, 'const portalCriticalAction = async', 'const styleCriticalControls =');
const purchaseHandlerStart = portal.lastIndexOf("  document.querySelector('#purchase-document-list')?.addEventListener('click', async", portal.indexOf('    const editButton = event.target.closest(\'[data-purchase-edit]\')'));
const purchaseHandlerEnd = portal.lastIndexOf("  document.querySelector('#purchase-document-list')?.addEventListener('click', async", portal.indexOf("    const button = event.target.closest('[data-purchase-void]')"));
assert.ok(purchaseHandlerStart > 0 && purchaseHandlerEnd > purchaseHandlerStart);
const purchaseHandlers = portal.slice(purchaseHandlerStart, purchaseHandlerEnd);
const guestHandler = span(portal, '  let guestAccountActionPending = false;', "  depositTopUpForm.addEventListener('submit'");
const movementStart = portal.indexOf("  document.querySelector('#movement-form')?.addEventListener('submit'");
assert.ok(movementStart > 0);
const movementHandler = portal.slice(movementStart, portal.indexOf('\n', movementStart));

function financeFixture(kind) {
  const f = fixture(), requests = [], notices = [], storage = new Map(); let permitted = true, identity = 'owner|venue-a', loads = 0;
  const matches = f.Node.prototype.matches, setAttr = f.Node.prototype.setAttribute;
  f.Node.prototype.matches = function (selector) { return matches.call(this, selector.replace(/\[([\w-]+)=([^"'\]\s]+)\]/g, '[$1="$2"]')); };
  f.Node.prototype.setAttribute = function (name, value) { setAttr.call(this, name, value); if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(value); };
  f.Node.prototype.reset = function () { this.resetCount = (this.resetCount || 0) + 1; };
  f.Node.prototype.showModal = function () { this.open = true; this.setAttribute('open', ''); };
  f.Node.prototype.close = function () { this.open = false; this.removeAttribute('open'); this.dispatch('close'); };
  f.main.innerHTML = `<div id="purchase-document-list"><button data-purchase-post="draft-a" type="button">Провести</button><button data-purchase-reverse="posted-a" type="button">Сторно</button></div><input id="client-id" value="guest-a"><input id="clients-search"><div id="client-history"><button data-account-reverse="entry-a" data-account-max="100" data-account-type="deposit" data-account-sign="1" type="button">Сторно баланса</button></div><dialog id="inventory-movement-dialog"><div class="ui-modal-card"><header><h2 id="movement-title">Склад</h2><button data-journal-close type="button">Закрыть</button></header><form id="movement-form"><div class="ui-modal-body"><input id="movement-direction" value="out"><input id="movement-item" value="item-a"><input id="movement-delta" value="2"><input id="movement-unit" value="шт"><input id="movement-reason" value="Проверка"><input id="movement-locked" disabled></div><footer><button id="movement-cancel" type="button">Отмена</button><button type="submit">Сохранить операцию</button></footer><p id="movement-message"></p></form></div></dialog>`;
  Object.assign(f.context, { crypto: { randomUUID: crypto.randomUUID }, CSS: { escape: value => value },
    sessionStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    portalCriticalContext: () => identity, hasPortalPermission: () => permitted, loadSharedUI: async () => f.ui,
    target: f.main, portalUser: { role: 'owner', venueId: 'venue-a' }, money: value => String(value),
    api: (path, options) => new Promise((resolve, reject) => requests.push({ path, options, resolve, reject })),
    portalNotice: message => notices.push(message),
    loadPurchaseDocuments: async () => { loads++; return true; }, loadAutoOrders: async () => { loads++; return true; }, load: async () => { loads++; return true; },
    fill: () => { loads++; }, draw: () => { loads++; },
  }); f.context.window.crypto = f.context.crypto;
  vm.runInContext(`${criticalAction}\nlet purchaseActionPending=false;
    const setPurchasePending=value=>{purchaseActionPending=value;};
    const canReversePurchaseDocuments=true;
    const purchaseDocuments=[{id:'draft-a',status:'draft',totalCost:100,supplierName:'Поставщик'},{id:'posted-a',status:'posted',reversalPolicyEnabled:true}];
    const clients=[{id:'guest-a',depositBalance:100,bonusBalance:0}];
    const movementEditors=new Map(); const closeMovementEditor=()=>movementEditors.get('movement')?.shell?.close();
    ${kind === 'purchase' ? purchaseHandlers : kind === 'guest' ? guestHandler : movementHandler}
    globalThis.financeRuntime={state:()=>({purchaseActionPending,clients}),setGuest:id=>{document.querySelector('#client-id').value=id;},movementEditors};`, f.context);
  const q = selector => f.document.querySelector(selector);
  if (kind === 'movement') {
    const shell = f.ui.critical({ element: q('#inventory-movement-dialog'), card: q('.ui-modal-card'), body: q('.ui-modal-body'), titleId: 'movement-title',
      context: () => identity, isPending: () => q('#movement-form').dataset.submitting === '1' });
    f.context.financeRuntime.movementEditors.set('movement', { shell }); shell.open();
  }
  return { ...f, requests, notices, storage, q, runtime: f.context.financeRuntime, loads: () => loads,
    setContext: value => { identity = value; }, setPermission: value => { permitted = value; },
    click: selector => { const button = q(selector); return dispatch(button.parentNode, 'click', { target: button }); },
    dialogForm: () => q('.ui-modal-form'),
  };
}
await check('purchase posting cancel sends nothing and releases domain pending', async () => {
  const f = financeFixture('purchase'), click = f.click('[data-purchase-post]'); await tick();
  assert.equal(f.runtime.state().purchaseActionPending, true); assert.equal(f.requests.length, 0);
  f.document.dispatch('keydown', { key: 'Escape' }); await click;
  assert.equal(f.requests.length, 0); assert.equal(f.runtime.state().purchaseActionPending, false);
});
await check('purchase posting pending blocks double submit Escape and readbacks after success', async () => {
  const f = financeFixture('purchase'), click = f.click('[data-purchase-post]'); await tick(); const form = f.dialogForm(), post = dispatch(form, 'submit');
  assert.match(f.requests[0].path, /draft-a\/post/); await dispatch(form, 'submit'); f.document.dispatch('keydown', { key: 'Escape' });
  assert.equal(f.requests.length, 1); assert.ok(f.dialogForm());
  f.requests[0].resolve({}); await post; await click;
  assert.equal(f.loads(), 3); assert.equal(f.runtime.state().purchaseActionPending, false);
});
await check('purchase posting permission loss confirmation sends no POST', async () => {
  const f = financeFixture('purchase'), click = f.click('[data-purchase-post]'); await tick(); f.setPermission(false);
  await dispatch(f.dialogForm(), 'submit'); await click; assert.equal(f.requests.length, 0);
});
await check('purchase reversal bounds and ambiguous retry reuse original key', async () => {
  const f = financeFixture('purchase'), click = f.click('[data-purchase-reverse]'); await tick(); const form = f.dialogForm();
  form.elements.namedItem('reason').value = 'ab'; await dispatch(form, 'submit'); assert.equal(f.requests.length, 0);
  form.elements.namedItem('reason').value = 'Проверка сторно'; const first = dispatch(form, 'submit');
  const original = JSON.parse(f.requests[0].options.body); assert.equal(original.reason, 'Проверка сторно'); f.requests[0].reject(new Error('offline')); await first;
  const retry = dispatch(form, 'submit'); assert.equal(JSON.parse(f.requests[1].options.body).idempotencyKey, original.idempotencyKey);
  f.requests[1].resolve({ idempotent: true }); await retry; await click; assert.equal(f.storage.size, 0); assert.equal(f.loads(), 3);
});
await check('purchase reversal changed venue pending does not read or paint new context', async () => {
  const f = financeFixture('purchase'), click = f.click('[data-purchase-reverse]'); await tick(); const form = f.dialogForm();
  form.elements.namedItem('reason').value = 'Контекст сторно'; const p = dispatch(form, 'submit'); f.setContext('owner|venue-b');
  f.requests[0].resolve({}); await p; await click; assert.equal(f.loads(), 0); assert.equal(f.notices.length, 0); assert.equal(f.q('.ui-modal'), null);
});
async function guestConfirm(f) {
  const click = f.click('[data-account-reverse]'); await tick(); const form = f.dialogForm();
  form.elements.namedItem('reason').value = 'Проверка баланса'; await dispatch(form, 'submit'); await tick();
  return { click, form: f.dialogForm() };
}
await check('guest reversal two confirmations retry key and one pending operation', async () => {
  const f = financeFixture('guest'), { click, form } = await guestConfirm(f); assert.equal(f.requests.length, 0);
  const first = dispatch(form, 'submit'); await dispatch(form, 'submit'); assert.equal(f.requests.length, 1);
  f.document.dispatch('keydown', { key: 'Escape' }); assert.ok(f.dialogForm()); const payload = f.requests[0].options.body;
  f.requests[0].reject(new Error('offline')); await first;
  const retry = dispatch(form, 'submit'); assert.equal(f.requests[1].options.body, payload);
  f.requests[1].resolve({ balances: { bonus: 0, deposit: 0 } }); await retry; await click; assert.equal(f.runtime.state().clients[0].depositBalance, 0); assert.equal(f.loads(), 2);
});
await check('guest reversal selection changed before final submit cannot write old guest', async () => {
  const f = financeFixture('guest'), { click, form } = await guestConfirm(f); f.runtime.setGuest('guest-b');
  await dispatch(form, 'submit'); await click; assert.equal(f.requests.length, 0);
});
await check('guest reversal loss of external payout right cannot send financial POST', async () => {
  const f = financeFixture('guest'), { click, form } = await guestConfirm(f); f.setPermission(false);
  await dispatch(form, 'submit'); await click; assert.equal(f.requests.length, 0);
});
await check('guest reversal late success selected guest changed cannot fill new guest', async () => {
  const f = financeFixture('guest'), { click, form } = await guestConfirm(f); const p = dispatch(form, 'submit');
  f.runtime.setGuest('guest-b'); f.requests[0].resolve({ balances: { deposit: 0 } }); await p; await click;
  assert.equal(f.loads(), 0); assert.equal(f.notices.length, 0); assert.equal(f.runtime.state().clients[0].depositBalance, 100);
});
await check('movement pending blocks duplicate close and preserves error draft', async () => {
  const f = financeFixture('movement'), form = f.q('#movement-form'); await dispatch(form, 'submit'); await dispatch(form, 'submit');
  assert.equal(f.requests.length, 1); assert.equal(JSON.parse(f.requests[0].options.body).delta, -2);
  f.document.dispatch('keydown', { key: 'Escape' }); f.q('#inventory-movement-dialog').dispatch('cancel'); assert.equal(f.q('#inventory-movement-dialog').open, true);
  f.requests[0].reject({ payload: { error: 'insufficient_stock' } }); await tick();
  assert.match(f.q('#movement-message').textContent, /Недостаточно/); assert.equal(f.q('#movement-reason').value, 'Проверка');
  assert.equal(form.dataset.submitting, '0'); assert.equal(form.querySelector('[type="submit"]').disabled, false); assert.equal(f.q('#movement-locked').disabled, true);
});
await check('movement late success changed venue cannot reset draft or refresh new context', async () => {
  const f = financeFixture('movement'), form = f.q('#movement-form'); await dispatch(form, 'submit'); f.setContext('owner|venue-b');
  f.requests[0].resolve({}); await tick(); assert.equal(form.resetCount, undefined); assert.equal(f.loads(), 0); assert.equal(f.notices.length, 0);
});
await check('movement success resets once reads stock and autoorders then closes', async () => {
  const f = financeFixture('movement'), form = f.q('#movement-form'); await dispatch(form, 'submit'); f.requests[0].resolve({}); await tick();
  assert.equal(form.resetCount, 1); assert.equal(f.loads(), 2); assert.equal(f.q('#inventory-movement-dialog').open, false); assert.equal(form.dataset.submitting, '0');
});
await check('movement revoked permission before submit sends no operation', async () => {
  const f = financeFixture('movement'); f.setPermission(false); await dispatch(f.q('#movement-form'), 'submit'); assert.equal(f.requests.length, 0);
});

const report = { package: 'UI-07.1', generatedAt: new Date().toISOString(), kind: 'actual-source DOM/API stub frontend QA; not browser/PG',
  sha256: Object.fromEntries(['app.js', 'portal.js', 'ui-dialog.js'].map(name => [name, crypto.createHash('sha256').update(fs.readFileSync(new URL(name, root))).digest('hex')])),
  passed: checks.filter(c => c.status === 'PASS').length, failed: checks.filter(c => c.status === 'FAIL').length, checks };
fs.mkdirSync(new URL('tmp/ui071/', root), { recursive: true });
fs.writeFileSync(new URL('tmp/ui071/source-runtime-qa.json', root), JSON.stringify(report, null, 2));
for (const item of checks) console.log(`${item.status} ${item.name}${item.error ? '\n' + item.error : ''}`);
console.log(`UI071 source QA: ${report.passed} PASS / ${report.failed} FAIL`);
if (report.failed) process.exitCode = 1;
