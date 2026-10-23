import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const ui = readFileSync(new URL('../payroll-scheme-ui.js', import.meta.url), 'utf8');
const portal = readFileSync(new URL('../portal.js', import.meta.url), 'utf8');
const start = ui.indexOf('    const savedEntryValid =');
const end = ui.indexOf('    const incentiveDetails =', start);
assert.ok(start > 0 && end > start);
const source = ui.slice(start, end);
const entry = { id: 'entry-1', userId: 'employee-1', origin: 'calculation_run', calculationRunId: 'run-1',
  status: 'draft', amountCents: 12500, currency: 'RUB', periodFrom: '2026-09-01', periodTo: '2026-09-30',
  employeeName: 'Сохранённое имя', schemeName: 'Сохранённая схема', allowedActions: ['cancel'],
  officialReady: false, payoutEligible: false };
const liveEntry = { ...entry, grossCents: 12500, amountCents: 11000, provenanceSha256: 'a'.repeat(64),
  transitionStateRequired: true, allowedActions: [] };
delete liveEntry.officialReady;
delete liveEntry.payoutEligible;
const fixture = () => {
  const store = new Map(), calls = [], events = [];
  const status = { textContent: '', isConnected: true };
  const cell = { dataset: { savedEntryEmployee: 'employee-1' }, innerHTML: '', isConnected: true };
  const button = { dataset: { savedEntryCreate: 'employee-1' }, disabled: false, closest: () => cell };
  const category = { value: '', isConnected: true };
  const detail = { dataset: { entriesLoaded: 'true', savedRunCapability: 'employee_attributed_merchandise_net_no_refund_v1' },
    querySelector: selector => selector === '[data-saved-entry-status]' ? status : selector === '[data-saved-entry-category]' ? category : null,
    querySelectorAll: selector => selector === '[data-saved-entry-employee]' ? [cell] : selector === '[data-saved-entry-create]' ? [button] : [] };
  const context = { detail, selectedRunId: 'run-1', identity: 'owner:venue', entriesToken: 0, pendingEntries: new Set(),
    alive: () => true, escapeHtml: value => String(value).replaceAll('<', '&lt;').replaceAll('"', '&quot;'),
    money: (cents, currency) => `${cents} ${currency}`, errorText: error => error.message,
    readinessReasonLabel: value => String(value), crypto: { randomUUID: () => 'stable-request-key' },
    sessionStorage: { getItem: key => store.get(key) || null, setItem: (key, value) => store.set(key, value), removeItem: key => store.delete(key) },
    CustomEvent: class { constructor(type) { this.type = type; } }, document: { dispatchEvent: event => events.push(event.type) },
    savedRequest: async (path, options) => { calls.push({ path, options }); return { schemaVersion: 1, entry }; } };
  const api = vm.runInNewContext(`${source}; ({ savedEntryValid, renderSavedEntry, loadRunEntries, createRunEntry })`, context);
  return { api, context, store, calls, events, status, cell, button, category, detail };
};

{
  const f = fixture();
  assert.equal(f.api.savedEntryValid(entry, 'run-1'), true);
  for (const change of [{ calculationRunId: 'other' }, { officialReady: true }, { payoutEligible: true }, { amountCents: 1.2 }, { amountCents: -1 }, { currency: 'USD' }]) {
    assert.equal(f.api.savedEntryValid({ ...entry, ...change }, 'run-1'), false);
  }
  f.api.renderSavedEntry(f.cell, entry, 'run-1');
  assert.match(f.cell.innerHTML, /Черновик создан/);
  assert.doesNotMatch(f.cell.innerHTML, /data-saved-entry-create/);
  f.api.renderSavedEntry(f.cell, { ...entry, status: 'cancelled' }, 'run-1');
  assert.match(f.cell.innerHTML, /Черновик отменён/);
  assert.doesNotMatch(f.cell.innerHTML, /data-saved-entry-create/);
}
{
  const f = fixture();
  assert.equal(f.api.savedEntryValid(liveEntry, 'run-1'), true, 'live DTO needs no obsolete false readiness flags');
  for (const change of [{ grossCents: undefined }, { grossCents: -1 }, { grossCents: 1.5 }, { grossCents: 10000 },
    { grossCents: 1000000000000 }, { amountCents: -1 }, { amountCents: 13000 }, { provenanceSha256: 'invalid' },
    { transitionStateRequired: false }, { allowedActions: ['pay'] }]) {
    assert.equal(f.api.savedEntryValid({ ...liveEntry, ...change }, 'run-1'), false, JSON.stringify(change));
  }
  f.context.savedRequest = async () => ({ items: [liveEntry] });
  await f.api.loadRunEntries('run-1');
  assert.equal(f.detail.dataset.entriesLoaded, 'true');
  assert.match(f.cell.innerHTML, /Начислено: 12500 RUB.*Корректировки: 1500 RUB.*К выплате: 11000 RUB/s);
  f.context.savedRequest = async () => ({ schemaVersion: 1, entry, replayed: true,
    currentEntry: { ...liveEntry, status: 'paid' } });
  f.button.disabled = false;
  await f.api.createRunEntry(f.button);
  assert.match(f.cell.innerHTML, /Выплачено/);
  assert.match(f.cell.innerHTML, /К выплате: 11000 RUB/);
  assert.equal(f.store.size, 0);
}
{
  const f = fixture();
  f.context.savedRequest = async () => ({ schemaVersion: 1, entry, replayed: true, currentEntry: null });
  await f.api.createRunEntry(f.button);
  assert.match(f.status.textContent, /invalid_payroll_entry_response/);
  assert.equal(f.store.size, 1, 'invalid current state cannot silently fall back to the frozen creation receipt');
}
{
  const f = fixture();
  let attempts = 0;
  f.context.savedRequest = async (path, options) => {
    f.calls.push({ path, options });
    if (++attempts === 1) throw new Error('response_lost');
    return { schemaVersion: 1, entry, replayed: true, currentEntry: { ...entry, status: 'cancelled' } };
  };
  await f.api.createRunEntry(f.button);
  assert.equal(f.store.size, 1, 'lost response retains key');
  assert.equal(f.button.disabled, false, 'failed attempt may be retried');
  await f.api.createRunEntry(f.button);
  const first = JSON.parse(f.calls[0].options.body), second = JSON.parse(f.calls[1].options.body);
  assert.deepEqual(first, second, 'retry sends exact same request and key');
  assert.deepEqual(Object.keys(first).sort(), ['employeeId', 'financeCategoryId', 'idempotencyKey']);
  assert.equal(first.financeCategoryId, null);
  assert.equal(f.store.size, 0);
  assert.match(f.cell.innerHTML, /Черновик отменён/);
  assert.doesNotMatch(f.cell.innerHTML, /data-saved-entry-create/);
  assert.deepEqual(f.events, ['payroll-run-entry-created']);
}
{
  const f = fixture();
  f.category.value = 'category-1';
  await f.api.createRunEntry(f.button);
  assert.equal(JSON.parse(f.calls[0].options.body).financeCategoryId, 'category-1');
  assert.match(f.status.textContent, /Откройте реестр, проверьте сумму и доступные действия/);
}
{
  const f = fixture();
  f.context.sessionStorage.setItem = () => { throw new Error('storage_disabled'); };
  await f.api.createRunEntry(f.button);
  assert.equal(f.calls.length, 0, 'storage failure cannot send unsafe mutation');
  assert.match(f.status.textContent, /payroll_entry_retry_storage_unavailable/);
}
{
  const f = fixture();
  f.context.savedRequest = async () => ({ items: [entry] });
  await f.api.loadRunEntries('run-1');
  assert.match(f.cell.innerHTML, /Черновик создан/);
  f.context.savedRequest = async () => ({ items: [entry, entry] });
  await f.api.loadRunEntries('run-1');
  assert.equal(f.detail.dataset.entriesLoaded, 'false');
  assert.equal(f.button.disabled, true, 'ambiguous lookup keeps creation disabled');
}

const renderStart = portal.indexOf('      register.innerHTML = rows.map((item) => {');
const renderEnd = portal.indexOf("      }).join('');", renderStart);
assert.ok(renderStart >= 0 && renderEnd > renderStart);
const renderer = portal.slice(renderStart, renderEnd + "      }).join('');".length);
const renderRegister = (item, { owner = true, state = null, pending = null } = {}) => {
  const register = {};
  const context = { register, rows: [item], entryStatuses: { draft: ['Черновик', 'warning'], approved: ['Утверждено', 'success'], cancelled: ['Отменено', 'muted'] },
    formatRuDate: value => value, esc: value => String(value ?? ''), displayName: value => value, money: value => value,
    financeAccountItems: [{ id: 'bank', name: 'Банк', kind: 'bank', allowedPaymentMethods: ['bank_transfer'] }],
    linkedPayrollStates: new Map(state ? [[item.id, state]] : []), linkedPayrollPending: () => pending,
    linkedPayrollMessages: new Map(), linkedPayrollAlive: () => owner,
    linkedPayrollActionNames: { approve: 'Утверждение', pay: 'Выплата', cancel: 'Отмена' },
    payrollPendingEntries: new Set(), todayDate: '2026-10-23' };
  const actionsStart = portal.indexOf('    const renderLinkedPayrollActions =');
  const actionsEnd = portal.indexOf('    const filterOptions =', actionsStart);
  assert.ok(actionsStart > 0 && actionsEnd > actionsStart);
  vm.runInNewContext(portal.slice(actionsStart, actionsEnd) + '\n' + renderer, context);
  return register.innerHTML;
};
for (const status of ['draft', 'approved', 'cancelled']) {
  const html = renderRegister({ ...entry, status, hours: null, amount: 125 });
  assert.doesNotMatch(html, /data-payroll-action="(?:approve|pay)"|Отработано:/);
  assert.match(html, /Сохранённое имя.*Сохранённая схема/s);
  assert.equal(html.includes('data-payroll-linked-check'), status !== 'cancelled');
  assert.equal(html.includes('data-payroll-cancel-open'), false, 'linked mutations require an on-demand state read');
}
assert.match(renderRegister({ id: 'legacy', status: 'draft', hours: 8, amount: 125 }), /data-payroll-action="approve"/);
assert.match(renderRegister({ id: 'legacy', status: 'approved', hours: 8, amount: 125 }), /data-payroll-action="pay"/);
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const linkedEntry = { ...entry, id: id(1), userId: id(2), calculationRunId: id(3), provenanceSha256: 'a'.repeat(64),
  amountCents: 12000, grossCents: 12500, amount: 120, status: 'draft' };
const linkedState = (status = 'draft', patch = {}) => ({ schemaVersion: 1, entry: { ...linkedEntry, status }, stateHash: 'b'.repeat(64),
  allowedActions: status === 'draft' ? ['approve', 'cancel'] : status === 'approved' ? ['pay', 'cancel'] : [], sourceStatus: 'current', ...patch });
assert.match(renderRegister(linkedEntry, { state: linkedState() }), /data-payroll-action="approve"/);
assert.match(renderRegister(linkedEntry, { state: linkedState() }), /Начислено: 125.*Корректировки: 5.*К выплате: 120/s);
assert.doesNotMatch(renderRegister(linkedEntry, { owner: false, state: linkedState() }), /data-payroll-(?:action|linked-check|cancel-open)=/);
assert.match(renderRegister(linkedEntry, { owner: false }), /доступны владельцу/);
const blocked = linkedState('approved', { sourceStatus: 'blocked', allowedActions: ['cancel'] });
const blockedHtml = renderRegister({ ...linkedEntry, status: 'approved' }, { state: blocked });
assert.match(blockedHtml, /data-payroll-cancel-open/);
assert.doesNotMatch(blockedHtml, /data-payroll-action="(?:approve|pay)"/);
assert.match(blockedHtml, /заблокированы/);
const zeroState = linkedState('approved'); zeroState.entry.amountCents = 0;
const zeroHtml = renderRegister({ ...linkedEntry, status: 'approved', amount: 0 }, { state: zeroState });
assert.match(zeroHtml, /data-payroll-payment-date/);
assert.match(zeroHtml, /Завершить без выплаты/);
assert.doesNotMatch(zeroHtml, /data-payroll-payment-account|data-payroll-payment-method/);
const pendingHtml = renderRegister({ ...linkedEntry, status: 'paid' }, { pending: { payload: { action: 'pay' } } });
assert.match(pendingHtml, /data-payroll-linked-retry/);
assert.doesNotMatch(pendingHtml, /data-payroll-action=|data-payroll-cancel-open/);

// Actual DOM-independent retry controller with browser storage and transport seams.
const controllerStart = portal.indexOf('  const createPayrollLinkedController =');
const controllerEnd = portal.indexOf('  // End calculation-entry retry contract.', controllerStart);
assert.ok(controllerStart > 0 && controllerEnd > controllerStart);
const createController = vm.runInNewContext(portal.slice(controllerStart, controllerEnd) + '; createPayrollLinkedController');
const controllerFixture = () => {
  const saved = new Map(), calls = [];
  let identity = 'venue:owner', next = 1;
  const storage = { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value),
    removeItem: key => saved.delete(key), get length() { return saved.size; }, key: index => [...saved.keys()][index] ?? null };
  const f = { saved, calls, storage, setIdentity: value => { identity = value; },
    request: async (path, options) => options ? { schemaVersion: 1, transitionId: id(4), action: 'approve', replayed: false,
      entry: { ...linkedEntry, status: 'approved' } } : linkedState() };
  f.create = () => createController({ request: async (...args) => { calls.push(args); return f.request(...args); },
    storage: () => storage, identity: () => identity, makeKey: () => `payroll-ui-key-${next++}` });
  f.controller = f.create();
  return f;
};
const approvePayload = { action: 'approve', expectedStateHash: 'b'.repeat(64), paymentDate: null, paymentAccountId: null, paymentMethod: null, reason: null };
{
  const f = controllerFixture();
  await f.controller.check(id(1));
  assert.equal(f.calls[0][0], `/api/payroll/calculation-entries/${id(1)}/state`);
  f.controller.begin(linkedEntry, approvePayload);
  assert.equal(f.saved.size, 1);
  await assert.rejects(f.controller.check(id(1)), error => error.code === 'payroll_ui_retry_required');
  f.request = async () => { throw new Error('lost_response'); };
  await assert.rejects(f.controller.retry(id(1)), error => error.payrollAttemptRetained === true);
  const first = f.calls.at(-1);
  assert.equal(first[1].method, 'POST'); assert.match(first[0], /\/transition$/);
  const reloaded = f.create();
  assert.equal(reloaded.listPending().length, 1, 'pending is discoverable outside current date filter after reload');
  f.request = async () => ({ schemaVersion: 1, transitionId: id(4), action: 'approve', replayed: true,
    entry: { ...linkedEntry, status: 'approved' }, currentEntry: { ...linkedEntry, status: 'paid' } });
  const replay = await reloaded.retry(id(1));
  assert.equal(f.calls.at(-1)[1].body, first[1].body, 'lost-response retry preserves exact serialized payload and key');
  assert.equal(replay.currentEntry.status, 'paid'); assert.equal(f.saved.size, 0);
  assert.deepEqual(Object.keys(JSON.parse(first[1].body)).sort(), ['action', 'expectedStateHash', 'idempotencyKey', 'paymentAccountId', 'paymentDate', 'paymentMethod', 'reason']);
}
for (const status of [401, 403, 404, 408, 429, 500, 503]) {
  const f = controllerFixture(); f.controller.begin(linkedEntry, approvePayload);
  f.request = async () => { throw Object.assign(new Error('uncertain'), { status, payload: { error: 'payroll_entry_lifecycle_owner_required' } }); };
  await assert.rejects(f.controller.retry(id(1)));
  assert.equal(f.saved.size, 1, `HTTP ${status} keeps exact recovery request`);
}
{
  const f = controllerFixture(); f.controller.begin(linkedEntry, approvePayload);
  f.request = async () => { throw Object.assign(new Error('entry_missing'), { status: 404,
    payload: { error: 'payroll_entry_lifecycle_not_found' } }); };
  await assert.rejects(f.controller.retry(id(1)), error => error.payrollAttemptRetained === false);
  assert.equal(f.saved.size, 0, 'definitive lifecycle POST not-found releases a request that cannot have committed');
}
for (const code of ['payroll_entry_transition_state_stale', 'payroll_entry_evidence_source_not_current', 'payroll_lifecycle_account_invalid']) {
  const f = controllerFixture(); f.controller.begin(linkedEntry, approvePayload);
  f.request = async () => { throw Object.assign(new Error(code), { status: 409, payload: { error: code } }); };
  await assert.rejects(f.controller.retry(id(1)), error => error.payrollAttemptRetained === false);
  assert.equal(f.saved.size, 0);
}
for (const code of ['payroll_entry_lifecycle_idempotency_conflict', 'payroll_entry_lifecycle_request_integrity_invalid']) {
  const f = controllerFixture(); f.controller.begin(linkedEntry, approvePayload);
  f.request = async () => { throw Object.assign(new Error(code), { status: 409, payload: { error: code } }); };
  await assert.rejects(f.controller.retry(id(1))); assert.equal(f.saved.size, 1);
}
{
  const f = controllerFixture();
  f.storage.setItem = () => { throw new Error('denied'); };
  assert.throws(() => f.controller.begin(linkedEntry, approvePayload), error => error.code === 'payroll_ui_retry_storage_unavailable');
  assert.equal(f.calls.length, 0);
}
{
  const f = controllerFixture(); f.controller.begin(linkedEntry, approvePayload);
  f.saved.set([...f.saved.keys()][0], '{bad');
  assert.throws(() => f.controller.begin(linkedEntry, approvePayload), error => error.code === 'payroll_ui_retry_storage_invalid');
  await assert.rejects(f.controller.retry(id(1))); assert.equal(f.calls.length, 0);
}
{
  const f = controllerFixture(); f.controller.begin(linkedEntry, approvePayload);
  f.request = async () => ({});
  await assert.rejects(f.controller.retry(id(1))); assert.equal(f.saved.size, 1, 'malformed HTTP success is not confirmation');
}
{
  const f = controllerFixture(); f.controller.begin(linkedEntry, approvePayload);
  f.storage.removeItem = () => { throw new Error('denied'); };
  const result = await f.controller.retry(id(1)); assert.equal(result.retryPending, true); assert.equal(f.saved.size, 1);
}
{
  const f = controllerFixture(); f.controller.begin(linkedEntry, approvePayload); f.setIdentity('venue:another-owner');
  await assert.rejects(f.controller.retry(id(1))); assert.equal(f.calls.length, 0);
  assert.equal(f.create().listPending().length, 0, 'pending operations never cross user/venue identities');
}
{
  const f = controllerFixture(); f.request = async () => linkedState('approved', { sourceStatus: 'blocked', allowedActions: ['pay', 'cancel'] });
  assert.equal((await f.controller.check(id(1))).allowedActions.join(','), 'cancel', 'blocked sources cannot render a pay action');
}
{
  const f = controllerFixture();
  let finish;
  f.request = () => new Promise(resolve => { finish = resolve; });
  const read = f.controller.check(id(1)); f.setIdentity(''); finish(linkedState());
  await assert.rejects(read, error => error.code === 'payroll_ui_owner_required');
}

// A late state response must not reinstall actions after a register reload.
{
  let finish;
  const context = { linkedPayrollAlive: () => true, payrollPendingEntries: new Set(), payrollRequestId: 1,
    linkedPayrollMessages: new Map(), linkedPayrollStates: new Map(), payrollItems: [linkedEntry], drawPayroll: () => {},
    linkedPayroll: { check: () => new Promise(resolve => { finish = resolve; }) }, linkedPayrollError: error => error.message };
  const from = portal.indexOf('    const checkLinkedPayroll =');
  const to = portal.indexOf('    const sendLinkedPayroll =', from);
  const check = vm.runInNewContext(portal.slice(from, to) + '; checkLinkedPayroll', context);
  const read = check(id(1)); context.payrollRequestId = 2; finish(linkedState()); await read;
  assert.equal(context.linkedPayrollStates.size, 0); assert.equal(context.payrollItems[0].status, 'draft');
}
assert.match(portal, /if \(entry\.origin === 'calculation_run' \|\| entry\.calculationRunId\) \{\s*await handleLinkedPayrollAction\(entry, action, button\);\s*return;/,
  'linked handler always returns before generic legacy PATCH');
console.log('PASS calculation-entry UI: saved-run helpers, owner/source-gated lifecycle render, zero settlement, exact persistent retry, lost response/reload, storage failures, stale response and legacy isolation');
