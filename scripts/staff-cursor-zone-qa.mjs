import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const app = fs.readFileSync('app.js', 'utf8');
const css = fs.readFileSync('style.css', 'utf8');
const html = fs.readFileSync('index.html', 'utf8');
for (const file of ['app.js', 'style.css', 'index.html']) {
  assert.equal(fs.readFileSync(`dist/${file}`, 'utf8'), fs.readFileSync(file, 'utf8'), `${file}: published copy matches`);
}
assert.match(html, /<section class="tabs"[^>]*\bhidden\b[^>]*>/, 'loading tablist starts hidden');
assert.match(css, /\.staff-theme main>\.tabs\[hidden\]\s*\{\s*display:none!important\s*\}/, 'hidden tablist overrides flex display and removes its box');

const noop = () => {};
const attributes = new Map();
const tabs = { hidden: false, innerHTML: '', setAttribute: (key, value) => attributes.set(key, value), removeAttribute: (key) => attributes.delete(key), replaceChildren() { this.innerHTML = ''; } };
const context = vm.createContext({
  floorReady: false, floorDensityToolbar: { hidden: true }, catalogRequestRevision: 0,
  catalogRequest: null, catalogRequestContext: '', catalogLoaded: false, products: [], catalogState: '',
  ordersRequestRevision: 0, document: { querySelector: () => null }, floorVenueId: '',
  selectedZoneId: '', serverZones: [], clearTableMinimums: noop, tableMinimums: {}, floorTabs: tabs,
  tables: { classList: { remove: noop }, dataset: {}, innerHTML: '', setAttribute: (key, value) => attributes.set(key, value), removeAttribute: (key) => attributes.delete(key) }, currentOrder: null, openOrders: [],
  drawOrder: noop, drawQueue: noop, loadOrders: noop, catalog: null, loadProducts: noop,
  escapeFloorText: String, renderedZone: null,
});
context.renderZone = (zone) => { context.renderedZone = zone.id; };
const functionSource = (name) => {
  const start = app.indexOf(`const ${name}=`);
  assert.ok(start >= 0, `${name} exists`);
  const end = app.indexOf('\n};', start);
  assert.ok(end > start, `${name} has expected function boundary`);
  return app.slice(start, end + 3);
};
vm.runInContext(`${functionSource('showFloorUnavailable')}\n${functionSource('applyFloorPayload')}`, context);
const apply = (zones) => { context.payload = { venueId: 'venue-a', zones }; vm.runInContext('applyFloorPayload(payload)', context); };
const zone = (id) => ({ id, name: id, tables: [] });
apply([zone('main')]);
assert.equal(tabs.hidden, true, 'one zone hides tabs');
assert.equal(context.renderedZone, 'main', 'hidden tabs still render the only zone');
apply([zone('main'), zone('terrace')]);
assert.equal(tabs.hidden, false, 'a second zone restores tabs');
assert.equal(attributes.get('aria-hidden'), 'false');
assert.match(tabs.innerHTML, /data-zone-id="terrace"/, 'second zone remains selectable');
context.selectedZoneId = 'terrace';
apply([zone('main'), zone('terrace')]);
assert.equal(context.renderedZone, 'terrace', 'refresh retains selected zone');
vm.runInContext("showFloorUnavailable('Unavailable')", context);
assert.equal(tabs.hidden, true, 'load failure hides previously visible row');
assert.equal(attributes.get('aria-hidden'), 'true');
assert.equal(tabs.innerHTML, '');
apply([zone('main'), zone('terrace')]);
assert.equal(tabs.hidden, false, 'retry restores multiple zones');
apply([]);
assert.equal(tabs.hidden, true, 'empty floor hides tabs');
assert.match(context.tables.innerHTML, /queue-empty/, 'empty floor retains empty state');

const roleToggle = app.match(/document\.body\.classList\.toggle\('staff-red-cursor',([^;]+)\);/);
assert.ok(roleToggle, 'cursor class comes from current staff session');
const enabledFor = new Function('actor', `return ${roleToggle[1]};`);
for (const role of ['bartender', 'hookah_master', 'owner', 'admin', 'waiter', 'manager', undefined]) {
  assert.equal(enabledFor({ role }), ['bartender', 'hookah_master'].includes(role), `cursor scope: ${role}`);
}
assert.match(app, /classList\.remove\('staff-red-cursor'\)/, 'session cleanup clears cursor class');
const arrow = css.match(/--staff-cursor-arrow:url\("data:image\/svg\+xml,([^"\n]+)"\)\s+(\d+)\s+(\d+),auto/);
assert.ok(arrow, 'arrow retains native fallback and explicit hotspot');
const svg = decodeURIComponent(arrow[1]);
const width = Number(svg.match(/width="(\d+)"/)[1]);
const height = Number(svg.match(/height="(\d+)"/)[1]);
assert.ok(Number(arrow[2]) < width && Number(arrow[3]) < height, 'hotspot lies within cursor');
assert.match(svg, /feGaussianBlur/, 'cursor has soft glow');
assert.match(svg, /stroke="#ff304c"[^>]*filter="url\(#glow\)"/, 'glow is red');
assert.match(svg, /fill="#251016"[^>]*stroke="#fff1f3"[^>]*stroke-linejoin="round"/, 'dark arrow has rounded light outline');
const cursorScope = css.match(/@media \(hover:hover\) and \(pointer:fine\)\{([\s\S]*?)\n\}/)?.[1];
assert.ok(cursorScope, 'custom cursors remain limited to fine pointers with hover');
for (const [state, fallback, hotspot] of [
  ['arrow', 'auto', [10, 9]], ['hand', 'pointer', [20, 9]], ['text', 'text', [24, 24]],
  ['grab', 'grab', [24, 24]], ['not-allowed', 'not-allowed', [24, 24]], ['wait', 'wait', [24, 24]],
]) {
  const token = cursorScope.match(new RegExp(`--staff-cursor-${state}:url\\("data:image/svg\\+xml,([^"\\n]+)"\\)\\s+(\\d+)\\s+(\\d+),${fallback}(?:;|})`));
  assert.ok(token, `${state}: SVG, explicit hotspot and semantic fallback`);
  const decoded = decodeURIComponent(token[1]);
  assert.deepEqual([Number(token[2]), Number(token[3])], hotspot, `${state}: hotspot matches visible symbol`);
  assert.match(decoded, /width="48" height="48" viewBox="0 0 48 48"/, `${state}: consistent cursor canvas`);
  assert.match(decoded, /feGaussianBlur/, `${state}: soft glow`);
  assert.match(decoded, /stroke="#ff304c"[^>]*filter="url\(#glow\)"/, `${state}: red glow`);
  assert.match(decoded, /fill="#251016"[^>]*stroke="#fff1f3"[^>]*stroke-linejoin="round"/, `${state}: dark symbol and rounded light outline`);
  assert.match(cursorScope, new RegExp(`cursor:var\\(--staff-cursor-${state}\\)!important`), `${state}: selector uses token`);
}
for (const rule of css.matchAll(/([^{}]+)\{([^{}]*cursor:var\(--staff-cursor-[^{}]+)\}/g)) {
  assert.ok(rule[1].trim().startsWith('body.staff-red-cursor'), 'cursor rule begins with the operational role scope');
  assert.ok(cursorScope.includes(rule[0]), 'custom cursor declarations stay within the staff media block');
}
console.log('Staff cursor/zone QA passed: transitions, role scope, SVG contract, hidden layout rule and source/dist sync.');
