import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const start = app.indexOf('let products=staticStaffDemo()?demoProducts:[];');
const end = app.indexOf('function recalc()', start);
assert.ok(start >= 0 && end > start, 'catalog state, loader, and refresh events are available');
const source = app.slice(start, end);

const listeners = { document: new Map(), window: new Map(), elements: new Map() };
const intervalCalls = [];
const requests = [];
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const element = () => ({
  value: '',
  innerHTML: '',
  attributes: new Map(),
  handlers: new Map(),
  addEventListener(type, callback) { this.handlers.set(type, callback); },
  setAttribute(name, value) { this.attributes.set(name, value); },
  classList: {
    values: new Set(),
    add(value) { this.values.add(value); },
    remove(value) { this.values.delete(value); },
    contains(value) { return this.values.has(value); },
  },
});
const catalog = element();
const grid = element();
const search = element();
const primary = element();
const close = element();
const document = {
  visibilityState: 'visible',
  addEventListener(type, callback) { listeners.document.set(type, callback); },
  querySelector(selector) { return selector === '.primary' ? primary : selector === '#catalog-close' ? close : null; },
};
const window = {
  addEventListener(type, callback) { listeners.window.set(type, callback); },
  setInterval(callback, delay) { intervalCalls.push({ callback, delay }); return intervalCalls.length; },
};
const staffFetchJson = (url, options) => {
  const pending = deferred();
  requests.push({ url, options, ...pending });
  return pending.promise;
};
const escapeFloorText = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const displayProductName = value => String(value ?? '').trim();
const staffIcon = () => '<svg></svg>';
const createRuntime = new Function('deps', `
  let floorVenueId='venue-a', staffAccessRevision=4, floorReady=true;
  const {catalog,grid,search,document,window,primary,close,listeners,intervalCalls,staticStaffDemo,demoProducts,staffCanWork,staffFetchJson,escapeFloorText,displayProductName,staffIcon}=deps;
  ${source}
  return {
    state:()=>({products,catalogState,catalogLoaded,catalogOpen:catalog.classList.contains('open')}),
    loadProducts,
    open:()=>primary.handlers.get('click')(),
    close:()=>close.handlers.get('click')(),
    focus:()=>listeners.window.get('focus')(),
    visibility:()=>listeners.document.get('visibilitychange')(),
    tick:()=>intervalCalls[0].callback(),
    setVenue:value=>{floorVenueId=value;},
    setAccess:value=>{staffAccessRevision=value;},
    draw,
  };
`);
const runtime = createRuntime({ catalog, grid, search, document, window, primary, close, listeners, intervalCalls, staticStaffDemo: () => false, demoProducts: [], staffCanWork: () => true, staffFetchJson, escapeFloorText, displayProductName, staffIcon });
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
const resolveProducts = (index, items, venueId) => requests[index].resolve({ items, ...(venueId ? { venueId } : {}) });
const item = (name, price, id) => ({ name, price, id, aliases: [], imageUrl: null });
const assertRequest = (index, venueId) => {
  assert.equal(requests[index].url, `/api/products?expectedVenueId=${encodeURIComponent(venueId)}`);
  assert.equal(requests[index].options.cache, 'no-store');
};

assert.equal(intervalCalls.length, 1, 'one bounded refresh timer is registered');
assert.equal(intervalCalls[0].delay, 60000, 'refresh interval is 60 seconds');

runtime.open();
assertRequest(0, 'venue-a');
runtime.focus();
runtime.visibility();
runtime.tick();
assert.equal(requests.length, 1, 'open/focus/visibility/timer triggers share one in-flight GET');
resolveProducts(0, [item('QA Сироп', 200, 'syrup')]);
await flush();
assert.equal(runtime.state().catalogState, 'ready');
assert.match(grid.innerHTML, /200/);

search.value = 'QA';
runtime.close();
runtime.focus();
runtime.tick();
assert.equal(requests.length, 1, 'closed catalog does not fetch on focus or interval');
runtime.open();
assertRequest(1, 'venue-a');
assert.equal(search.value, 'QA', 'opening refresh preserves the active search text');
resolveProducts(1, [item('QA Сироп', 275, 'syrup'), item('QA Новый напиток', 100, 'new')]);
await flush();
assert.match(grid.innerHTML, /275/);
assert.match(grid.innerHTML, /QA Новый напиток/);
runtime.tick();
assertRequest(2, 'venue-a');
resolveProducts(2, [item('QA Сироп', 275, 'syrup'), item('QA Новый напиток', 100, 'new')]);
await flush();

document.visibilityState = 'hidden';
runtime.focus();
runtime.tick();
assert.equal(requests.length, 3, 'hidden tab does not fetch on focus or interval');
document.visibilityState = 'visible';
runtime.visibility();
assertRequest(3, 'venue-a');
requests[3].reject(new Error('network_down'));
await flush();
assert.equal(runtime.state().catalogState, 'error');
assert.match(grid.innerHTML, /устарел/);
assert.doesNotMatch(grid.innerHTML, /class="product"/, 'stale product buttons are unavailable after refresh failure');
const retry = runtime.loadProducts();
assertRequest(4, 'venue-a');
resolveProducts(4, [item('QA Сироп', 275, 'syrup')]);
await retry;
assert.equal(runtime.state().catalogState, 'ready', 'a successful retry restores the catalog');

const oldVenueRequest = runtime.loadProducts();
assertRequest(5, 'venue-a');
runtime.setVenue('venue-b');
const newVenueRequest = runtime.loadProducts();
assertRequest(6, 'venue-b');
resolveProducts(6, [item('QA Точка Б', 500, 'venue-b-product')], 'venue-b');
await newVenueRequest;
resolveProducts(5, [item('QA Старая точка', 1, 'venue-a-product')], 'venue-a');
await oldVenueRequest;
assert.equal(runtime.state().products[0][0], 'QA Точка Б', 'late response from the prior venue is ignored');

const oldAccessRequest = runtime.loadProducts();
assertRequest(7, 'venue-b');
runtime.setAccess(5);
const newAccessRequest = runtime.loadProducts();
assertRequest(8, 'venue-b');
resolveProducts(8, [item('QA Текущая сессия', 600, 'current')], 'venue-b');
await newAccessRequest;
resolveProducts(7, [item('QA Старая сессия', 1, 'old')], 'venue-b');
await oldAccessRequest;
assert.equal(runtime.state().products[0][0], 'QA Текущая сессия', 'late response from prior access revision is ignored');

const closedRequest = runtime.loadProducts();
assertRequest(9, 'venue-b');
runtime.close();
resolveProducts(9, [item('QA После закрытия', 1, 'closed')], 'venue-b');
await closedRequest;
assert.equal(runtime.state().products[0][0], 'QA Текущая сессия', 'closing the catalog invalidates its pending response');

console.log('STAFF CATALOG REFRESH RUNTIME QA: PASS (reopen, visible-only 60s refresh, single-flight, no-store, venue/access/sequence races, fail-closed retry)');
