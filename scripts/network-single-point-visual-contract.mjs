import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../portal.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');
const section = source.slice(source.indexOf('function renderNetwork()'), source.indexOf('function renderOrders()'));
assert.doesNotMatch(section, /<a class="button small" href="\/admin#settings">Настройки заведения<\/a><\/div><div class="content-grid">/,
  'network page must not duplicate the current venue settings link in the page title');
assert.match(section, /<a class="button small" href="\/admin#settings">Настройки заведения<\/a>/,
  'current venue card must retain its contextual settings link');
assert.match(section, /id="network-add-toggle"[^>]*aria-controls="network-create-panel"/, 'create form has an explicit disclosure trigger');
assert.match(section, /id="network-create-panel"[^>]*hidden/, 'create form starts collapsed before list data loads');
assert.match(section, /id="network-create-cancel"/, 'create form exposes a cancel action');
assert.match(section, /network-fields/, 'create fields use a dedicated responsive grid');
assert.match(css, /@media\(max-width:620px\)\{\s*#page-content\.ui-connected-pages \.network-row\{justify-content:flex-start\}\s*#page-content\.ui-connected-pages \.network-row>div:first-child\{flex:0 1 auto\}/,
  'mobile venue card must not retain the 280px desktop flex basis as empty vertical space');
const start = section.indexOf('  const draw = (items) =>');
const end = section.indexOf('\n  const networkList', start);
assert.ok(start >= 0 && end > start, 'network renderer must remain discoverable');
const nodes = new Map();
const node = (selector) => {
  if (!nodes.has(selector)) nodes.set(selector, { innerHTML: '', textContent: '' });
  return nodes.get(selector);
};
const makeDraw = () => {
  let networkHasLoaded = false; let formOpen = null;
  const setFormOpen = value => { formOpen = value; };
  const draw = new Function('document', 'window', 'pluralRu', 'esc', 'displayName', 'networkHasLoaded', 'setFormOpen', `${section.slice(start, end)}; return draw;`) (
    { querySelector: node }, { __networkItems: [] }, (count, one, few, many) => count === 1 ? one : count < 5 ? few : many,
    (value) => String(value), (value) => value, networkHasLoaded, setFormOpen,
  );
  return { draw, get formOpen() { return formOpen; } };
};
const point = { id: 'one', name: 'Территория', format: 'кальян-бар', city: 'Тюмень', address: 'ул. Пермаякова', isCurrent: true };
const populated = makeDraw();
populated.draw([point]);
assert.match(node('#network-count').textContent, /^1 точка$/);
assert.doesNotMatch(node('#network-list').innerHTML, /Текущая точка|Подготовлена/);
assert.match(node('#network-list').innerHTML, /Настройки заведения/);
assert.equal(populated.formOpen, false, 'populated network starts with create form closed');
const second = { ...point, id: 'two', name: 'Вторая точка', isCurrent: false };
populated.draw([point, second]);
assert.match(node('#network-list').innerHTML, /Текущая точка/);
assert.match(node('#network-list').innerHTML, /Подготовлена/);
const empty = makeDraw(); empty.draw([]); assert.equal(empty.formOpen, true, 'empty network opens creation as the first step');
console.log('NETWORK SINGLE-POINT VISUAL CONTRACT: PASS (single-point status is omitted; create form disclosure is responsive; empty state starts with onboarding; multi-point status is retained)');
