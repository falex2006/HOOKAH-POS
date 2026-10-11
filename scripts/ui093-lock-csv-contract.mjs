import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Execute the actual registered save handler and startup GET; no backend,
// credentials, DOM library, persistent storage or copied product implementation.
const lockSource = readFileSync(new URL('../lock.js', import.meta.url), 'utf8');
const start = lockSource.indexOf('  let lockPreferenceGeneration = 0;');
const end = lockSource.indexOf("  ['pointerdown', 'keydown'", start);
assert.ok(start >= 0 && end > start, 'actual lock handler/startup GET must exist');
let checks = 0;
const check = (name, fn) => { fn(); checks += 1; console.log(`PASS: ${name}`); };
const flush = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); };
function harness(pin = '') {
  const nodes = new Map([
    ['#lock-pin-message', { textContent: '', className: '' }],
    ['#lock-new-pin', { value: pin }], ['#lock-new-pin-confirm', { value: pin }],
    ['#lock-timeout-select', { value: '30' }], ['#lock-pin-state', { textContent: 'Не настроен' }],
    ['.lock-settings-save', { disabled: false, addEventListener(event, callback) { assert.equal(event, 'click'); this.callback = callback; } }],
  ]);
  const requests = [], storage = [], timers = [], cleared = [];
  let scheduled = 0, closed = 0;
  const settingsDialog = { querySelector: selector => nodes.get(selector), close: () => { closed += 1; } };
  const context = vm.createContext({ settingsDialog, user: { id: 'fixture-staff', pinConfigured: false, preferences: { lockTimeoutMinutes: 15, other: 'keep' } },
    timeoutMinutes: 15, timeoutKey: 'fixture-timeout', timeoutOptions: [0, 1, 5, 10, 15, 30, 60], autoLockEnabled: false, timer: 'existing-timer',
    headers: () => ({}), clearTimeout: id => cleared.push(id), schedule: () => { scheduled += 1; },
    localStorage: { setItem: (key, value) => storage.push([key, value]) }, window: { setTimeout: (fn, delay) => timers.push({ fn, delay }) },
    fetch: (url, options = {}) => new Promise((resolve, reject) => requests.push({ url, options, resolve, reject })),
  });
  vm.runInContext(lockSource.slice(start, end), context, { filename: 'actual-lock-preferences.js' });
  const reply = (index, status, body = {}) => requests[index].resolve({ status, ok: status >= 200 && status < 300, json: async () => body });
  return { context, requests, nodes, storage, timers, cleared, reply,
    save: () => nodes.get('.lock-settings-save').callback(),
    snapshot: () => ({ timeout: context.timeoutMinutes, preference: context.user.preferences.lockTimeoutMinutes, other: context.user.preferences.other, scheduled, closed, writes: storage.length, clears: cleared.length, timers: timers.length, disabled: nodes.get('.lock-settings-save').disabled }),
  };
}
const initial = { timeout: 15, preference: 15, other: 'keep', scheduled: 0, closed: 0, writes: 0, clears: 0, timers: 0, disabled: false };
for (const status of [400, 401, 503]) {
  const h = harness(), saving = h.save();
  check(`preferences ${status}: request pending retains state and disables duplicate submit`, () => {
    assert.deepEqual(h.snapshot(), { ...initial, disabled: true });
    assert.equal(h.requests[1].options.method, 'PATCH');
    assert.equal(JSON.parse(h.requests[1].options.body).lockTimeoutMinutes, 30);
  });
  await h.save();
  assert.equal(h.requests.length, 2, 'startup GET plus single PATCH only');
  h.reply(1, status, { error: 'fixture_preferences_error' }); await saving;
  check(`preferences ${status}: no timeout/storage/schedule/close commit`, () => {
    assert.deepEqual(h.snapshot(), initial);
    assert.match(h.nodes.get('#lock-pin-message').textContent, /Не удалось сохранить настройки автоблокировки/);
    assert.equal(h.nodes.get('#lock-pin-message').className, 'lock-pin-message error');
  });
  h.reply(0, 200, { preferences: { lockTimeoutMinutes: 5 } }); await flush();
  check(`preferences ${status}: late startup GET cannot overwrite attempted save`, () => assert.deepEqual(h.snapshot(), initial));
}
{
  const h = harness(), saving = h.save(); h.requests[1].reject(new Error('fixture_network_failure')); await saving;
  check('network failure retains timeout/storage/schedule/dialog and enables retry', () => assert.deepEqual(h.snapshot(), initial));
}
{
  const h = harness(), saving = h.save();
  check('200 applies only after awaited preferences response', () => assert.deepEqual(h.snapshot(), { ...initial, disabled: true }));
  h.reply(1, 200, { preferences: { lockTimeoutMinutes: 30 } }); await saving;
  check('200 persists requested timeout, retained other preferences, and schedules close', () => {
    assert.deepEqual(h.snapshot(), { ...initial, timeout: 30, preference: 30, scheduled: 1, writes: 2, clears: 1, timers: 1 });
    assert.equal(h.storage[0][1], '30');
    assert.equal(JSON.parse(h.storage[1][1]).preferences.lockTimeoutMinutes, 30);
    assert.equal(h.timers[0].delay, 0);
    h.timers[0].fn(); assert.equal(h.snapshot().closed, 1);
  });
  h.reply(0, 200, { preferences: { lockTimeoutMinutes: 5 } }); await flush();
  check('late GET cannot roll back successful timeout', () => assert.equal(h.context.timeoutMinutes, 30));
}
{
  const h = harness('2468'), saving = h.save();
  assert.match(h.requests[1].url, /^\/api\/staff\/fixture-staff\/pin$/);
  h.reply(1, 200, { pinConfigured: true }); await flush();
  check('PIN success waits for preferences before timeout/storage/dialog commit', () => {
    assert.equal(h.requests.length, 3);
    assert.equal(h.context.user.pinConfigured, true); assert.equal(h.context.autoLockEnabled, true);
    assert.deepEqual(h.snapshot(), { ...initial, disabled: true });
    assert.equal(h.nodes.get('#lock-new-pin').value, ''); assert.equal(h.nodes.get('#lock-new-pin-confirm').value, '');
  });
  h.reply(2, 503, { error: 'fixture_preferences_error' }); await saving;
  check('PIN success plus preferences failure reports partial success with old timeout', () => {
    assert.deepEqual(h.snapshot(), initial);
    assert.equal(h.context.user.pinConfigured, true);
    assert.match(h.nodes.get('#lock-pin-message').textContent, /PIN сохранён\. Не удалось сохранить настройки автоблокировки/);
    assert.equal(h.nodes.get('#lock-pin-state').textContent, 'Настроен');
  });
  const retry = h.save(); assert.equal(h.requests.length, 4); assert.equal(h.requests[3].url, '/api/session/preferences');
  h.reply(3, 200); await retry;
  check('partial success retry saves preferences without resending cleared PIN', () => assert.equal(h.context.timeoutMinutes, 30));
}
{
  const h = harness('2468'), saving = h.save(); h.reply(1, 400, { error: 'staff_pin_key_required' }); await saving;
  check('failed PIN prevents preferences request and preserves unconfigured state', () => {
    assert.equal(h.requests.length, 2); assert.equal(h.context.user.pinConfigured, false);
    assert.deepEqual(h.snapshot(), initial);
    assert.equal(h.nodes.get('#lock-pin-message').textContent, 'Не настроено хранилище PIN');
  });
}
{
  const h = harness(); h.reply(0, 200, { preferences: { lockTimeoutMinutes: 5 } }); await flush();
  check('startup GET still applies before any save attempt', () => { assert.equal(h.context.timeoutMinutes, 5); assert.equal(h.snapshot().writes, 2); });
}
const portal = readFileSync(new URL('../portal.js', import.meta.url), 'utf8');
const csvStart = portal.indexOf('const auditCsvCell = (value) =>');
const csvEnd = portal.indexOf('; const csv = rows.map', csvStart);
assert.ok(csvStart >= 0 && csvEnd > csvStart, 'actual CSV cell function must exist');
assert.ok(portal.slice(csvEnd, csvEnd + 120).includes("row.map(auditCsvCell).join(';')"), 'actual exporter must use guarded cell helper');
const cell = vm.runInNewContext(portal.slice(csvStart, csvEnd) + '; auditCsvCell', {}, { filename: 'actual-audit-csv-cell.js' });
for (const text of ['=1+1', '+SUM(A1)', '-1', '@cmd', '\t=1', '\r\n+1', '  @x', '\u0000-1', '\u001f=1', '\u00a0=1']) {
  check(`CSV dangerous prefix neutralized ${JSON.stringify(text)}`, () => assert.equal(cell(text), '"\'' + text + '"'));
}
for (const [input, expected] of [['plain', '"plain"'], ['ordinary = text', '"ordinary = text"'], ['a"b', '"a""b"'], ['=a"b', '"\'=a""b"'], ['a;b', '"a;b"'], ['a\nb', '"a\nb"'], ['', '""'], [123, '"123"']]) {
  check(`CSV plain/quote preservation ${JSON.stringify(input)}`, () => assert.equal(cell(input), expected));
}
const syncSettingsSource = lockSource.match(/^  const syncSettings = .*;$/m)?.[0];
assert.ok(syncSettingsSource, 'actual settings sync must exist');
for (const enhanced of [true, false]) {
  const select = { value: '0' }, label = { textContent: 'Не блокировать автоматически' };
  let refreshed = 0;
  if (enhanced) select._customSelectRefresh = function () {
    refreshed += 1;
    label.textContent = this.value === '5' ? 'Через 5 мин' : 'Не блокировать автоматически';
  };
  const context = vm.createContext({ timeoutMinutes: 5, settingsDialog: { querySelector(selector) {
    assert.equal(selector, '#lock-timeout-select'); return select;
  } } });
  vm.runInContext(syncSettingsSource + '\nsyncSettings();', context, { filename: 'actual-lock-settings-sync.js' });
  check(`settings sync ${enhanced ? 'enhanced select refreshes visible label' : 'native select tolerates absent enhancement'}`, () => {
    assert.equal(select.value, '5');
    assert.equal(refreshed, enhanced ? 1 : 0);
    if (enhanced) assert.equal(label.textContent, 'Через 5 мин');
  });
}
console.log(`UI093 LOCK/CSV ACTUAL-SOURCE CONTRACT: PASS (${checks} checks)`);
