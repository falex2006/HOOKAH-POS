import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const app = read('app.js'), css = read('style.css');
const start = app.indexOf('function tableElapsedLabel('), end = app.indexOf('function loadOrders()', start);
assert.ok(start > 0 && end > start, 'elapsed helpers remain extractable');
const now = Date.parse('2026-10-09T12:00:00Z');
class FixedDate extends Date { static now() { return now; } }
const intervals = [], events = {};
const card = (table, status) => ({
  dataset: { table, status }, children: [], label: `Стол ${table}: ${status}`,
  querySelector(selector) { assert.equal(selector, '.table-elapsed'); return this.children[0] || null; },
  append(node) { node.parent = this; this.children.push(node); },
  getAttribute(name) { assert.equal(name, 'aria-label'); return this.label; },
  setAttribute(name, value) { assert.equal(name, 'aria-label'); this.label = value; },
});
const occupied = card('table-1', 'occupied'), waiting = card('table-2', 'awaiting_payment'), free = card('table-3', 'free');
const cards = [occupied, waiting, free];
const context = vm.createContext({
  Date: FixedDate, floorReady: true, allowed: true, openOrders: [],
  staticStaffDemo: () => false,
  staffCanWork: () => context.allowed,
  normalizeTableId: (value) => String(value ?? '').replace(/^table-/, ''),
  tables: { querySelectorAll(selector) { assert.equal(selector, '.table'); return cards; } },
  window: { setInterval(callback, delay) { intervals.push({ callback, delay }); } },
  document: {
    visibilityState: 'visible',
    addEventListener: (name, callback) => { events[name] = callback; },
    createElement(tag) { assert.equal(tag, 'span'); return { remove() { this.parent.children.splice(this.parent.children.indexOf(this), 1); } }; },
  },
});
vm.runInContext(`${app.slice(start, end)}\nglobalThis.subject = { tableElapsedLabel, updateTableElapsedTimes };`, context);
const { tableElapsedLabel: label, updateTableElapsedTimes: update } = context.subject;
assert.equal(label({ createdAt: '2026-10-09T11:59:30Z' }), '00:00');
assert.equal(label({ createdAt: '2026-10-09T11:01:00Z' }), '00:59');
assert.equal(label({ createdAt: '2026-10-09T10:59:00Z' }), '01:01');
assert.equal(label({ createdAt: '2026-10-08T10:00:00Z' }), '26:00');
assert.equal(label({ createdAt: '2026-10-09T17:00:00+05:00' }), '00:00', 'parse saved timezone offset');
assert.equal(label({ createdAt: '2026-10-09T13:00:00Z' }), '00:00', 'clock skew never yields negative elapsed');
assert.equal(label({ createdAt: 'invalid' }), '—:—');
assert.equal(label({ updatedAt: '2026-10-09T11:00:00Z' }), '—:—', 'updates cannot invent an opening');
assert.equal(label({ openedAt: '2026-10-09T10:00:00Z', createdAt: '2026-10-09T11:00:00Z' }), '02:00');
context.openOrders = [
  { tableId: '1', status: 'open', createdAt: '2026-10-09T11:00:00Z' },
  { tableId: 'table-1', status: 'in_progress', createdAt: '2026-10-09T10:00:00Z' },
  { tableId: 'table-1', status: 'closed', createdAt: '2026-10-08T10:00:00Z' },
  { tableId: 'table-1', status: 'cancelled', createdAt: '2026-10-07T10:00:00Z' },
  { tableId: 'table-2', status: 'open', createdAt: 'invalid' },
  { tableId: 'table-3', status: 'open', createdAt: '2026-10-09T09:00:00Z' },
];
update();
assert.equal(occupied.children[0].textContent, '02:00', 'earliest active saved opening wins');
assert.equal(waiting.children[0].textContent, '—:—');
assert.equal(free.children.length, 0, 'free table never gets a timer');
assert.match(occupied.label, /Время за столом 02 часов 00 минут/);
assert.equal(label({createdAt:'2026-10-05T08:00:00Z'}), '100:00', 'hours never wrap after 24h or 99h');
const timer = occupied.children[0], aria = occupied.label;
update(); assert.equal(occupied.children.length, 1); assert.equal(occupied.children[0], timer, 'timer node is reused'); assert.equal(occupied.label, aria, 'accessible label does not accumulate');
assert.equal(context.openOrders[0].createdAt, '2026-10-09T11:00:00Z', 'rendering never sorts source orders in place');
context.allowed = false; timer.textContent = 'unchanged'; update(); assert.equal(timer.textContent, 'unchanged');
context.allowed = true; context.floorReady = false; update(); assert.equal(timer.textContent, 'unchanged');
context.floorReady = true;
assert.equal(intervals.length, 1); assert.equal(intervals[0].delay, 30000);
context.document.visibilityState = 'hidden'; intervals[0].callback(); assert.equal(timer.textContent, 'unchanged');
context.document.visibilityState = 'visible'; events.visibilitychange(); assert.equal(timer.textContent, '02:00');
occupied.dataset.status = 'free'; update(); assert.equal(occupied.children.length, 0); assert.equal(occupied.label, 'Стол table-1: occupied'); assert.equal(occupied.dataset.elapsedBaseLabel, undefined);
const renderStart = app.indexOf('const renderZone='), renderEnd = app.indexOf('const showFloorUnavailable=', renderStart);
assert.match(app.slice(renderStart, renderEnd), /updateTableElapsedTimes\(\);\s*updateFloorMapMode\(\);/, 'timers are included before layout fitting');
assert.match(app.slice(end, renderStart), /openOrders=availableOrders\.filter[\s\S]*?updateTableElapsedTimes\(\);/, 'loaded orders immediately update timers');
assert.doesNotMatch(app, /'new-order'|'add-position'/, 'duplicate context actions and forwarding are gone');
assert.match(read('index.html'), /<span data-primary-label>Добавить позицию<\/span>/, 'bottom primary remains');
assert.match(css, /\.staff-theme \.table\.free em::before\{[^}]*background:currentColor/);
assert.match(css, /\.table>\.table-elapsed\{transform:rotate\(var\(--table-counter-rotation,0deg\)\)/);
assert.match(css, /compact-map[^\n]*\.table>\.table-elapsed\{transform:none\}/);
for (const file of ['app.js', 'style.css']) assert.equal(read(file), read(`dist/${file}`), `${file}: published parity`);
console.log('STAFF TABLE ELAPSED QA: PASS (saved opening, boundaries/timezone, earliest active order, unavailable state, access/visibility, node reuse, labels, layout hooks, primary action, published parity)');
