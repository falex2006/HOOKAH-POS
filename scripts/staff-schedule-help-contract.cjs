'use strict';
// Unit/static contract, NOT browser proof. No HTTP, database or file writes.
// Runs the extracted production search block against a deliberately small model.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const shared = fs.readFileSync(path.join(root, 'help-content.js'), 'utf8');
const articles = JSON.parse(shared.match(/const articles = (.*);/)[1]);
const source = fs.readFileSync(path.join(root, 'staff-schedule-ui.js'), 'utf8').replace('${guide.html}', articles.find(article => article.id === 'staff-schedule').html);
const css = fs.readFileSync(path.join(root, 'staff-schedule-ui.css'), 'utf8');
function between(start, end) {
  const a = source.indexOf(start);
  assert.ok(a >= 0, `Missing extraction start: ${start}`);
  const b = source.indexOf(end, a + start.length);
  assert.ok(b > a, `Missing extraction end: ${end}`);
  return source.slice(a, b);
}
const help = between('    helpButton.onclick = async () => {', '    const commandbar =');
const search = between('      const helpSearch =', '      const previous = document.activeElement;');
const sections = [...help.matchAll(/<section>([\s\S]*?)<\/section>/g)].map(m => m[1]);
let checks = 0;
function check(name, run) { run(); checks++; console.log(`PASS ${name}`); }
function control() {
  return { value: '', hidden: false, textContent: '', focused: false, handlers: {},
    addEventListener(type, fn) { assert.equal(this.handlers[type], undefined); this.handlers[type] = fn; },
    focus() { this.focused = true; } };
}
function model(texts = sections.map(html => html.replace(/<[^>]*>/g, ' ')), titles = sections.map(html => /<h3>(.*?)<\/h3>/.exec(html)[1])) {
  const topics = texts.map((textContent, i) => ({ textContent, open: i === 0, hidden: false,
    querySelector(selector) { assert.equal(selector, 'summary'); return { textContent: titles[i] || textContent }; } }));
  const order = [...topics];
  const content = { append(topic) {
    assert.ok(topics.includes(topic), 'Only help topics may be reordered');
    order.splice(order.indexOf(topic), 1); order.push(topic);
  } };
  const input = control(), clear = control(), status = control();
  const controls = { '[data-help-search]': input, '[data-help-clear]': clear, '[data-help-status]': status, '.schedule-help-content': content };
  const node = {
    querySelector(selector) { assert.ok(Object.hasOwn(controls, selector), `Unexpected scope: ${selector}`); return controls[selector]; },
    querySelectorAll(selector) { assert.equal(selector, '.schedule-help-content > details'); return topics; }
  };
  const context = vm.createContext({ node }); // No document, fetch, API or storage capabilities.
  vm.runInContext(search, context, { timeout: 1000 });
  function inputValue(value) { input.value = value; vm.runInContext('filterHelp()', context, { timeout: 1000 }); }
  return { topics, order, input, clear, status, inputValue };
}
check('15 topics, labelled search, live status and explicit hidden CSS', () => {
  assert.equal(sections.length, 15);
  assert.ok(sections.every(s => /<h3>.+<\/h3>/.test(s)));
  assert.match(help, /data-help-search aria-label="Найти в справке"/);
  assert.match(help, /data-help-status role="status" aria-live="polite"/);
  assert.match(css, /\.schedule-help-topic\[hidden\]\s*\{\s*display\s*:\s*none\s*\}/);
});
check('initial state and input listener; search is topic-local and has no API mutation hooks', () => {
  const m = model();
  assert.equal(typeof m.input.handlers.input, 'function');
  assert.equal(m.clear.hidden, true);
  assert.equal(m.topics.filter(t => t.open).length, 1);
  assert.ok(m.topics.every(t => !t.hidden));
  assert.match(m.status.textContent, /Все темы: 15/);
  assert.doesNotMatch(help, /\b(?:api|fetch|XMLHttpRequest|sendBeacon)\s*\(|\b(?:localStorage|sessionStorage|location)\s*\.|\b(?:load|draw)\s*\(/);
});
check('case, whitespace, ё/е normalization and AND-token filtering across topic text', () => {
  const m = model(['Ёлка\n УТРЕННЯЯ смена', 'Елка вечерняя смена', 'Утренняя работа']);
  m.input.value = '  ЕЛКА \n утренняя  ';
  m.input.handlers.input();
  assert.deepEqual(m.topics.map(t => [t.hidden, t.open]), [[false, true], [true, false], [true, false]]);
  m.inputValue('ёлка');
  assert.equal(m.topics.filter(t => !t.hidden).length, 2);
  assert.equal(m.clear.hidden, false);
});
check('no results and markup-like input are plain text, clear restores and focuses', () => {
  const m = model();
  m.inputValue('<img onerror=anything>');
  assert.ok(m.topics.every(t => t.hidden && !t.open));
  assert.match(m.status.textContent, /Темы не найдены/);
  m.clear.handlers.click();
  assert.equal(m.input.value, '');
  assert.equal(m.input.focused, true);
  assert.equal(m.clear.hidden, true);
  assert.ok(m.topics.every(t => !t.hidden));
  assert.deepEqual(m.topics.map(t => t.open), m.topics.map((_, i) => i === 0));
});
check('multiple queries restore original expansion; next search takes a fresh snapshot', () => {
  const m = model(['один', 'два', 'три']);
  m.topics[0].open = false; m.topics[2].open = true;
  m.inputValue('один'); m.inputValue('два'); m.inputValue('нет'); m.inputValue(' \n ');
  assert.deepEqual(m.topics.map(t => t.open), [false, false, true]);
  m.topics[1].open = true;
  m.inputValue('три'); m.clear.handlers.click(); m.inputValue('');
  assert.deepEqual(m.topics.map(t => t.open), [false, true, true]);
});
check('real guide has discoverable core scenarios', () => {
  const m = model();
  for (const query of ['2/2', 'больничный', 'свободная смена', 'публикации', 'перерыв', 'конфликт', 'копировать неделю']) {
    m.inputValue(query);
    assert.ok(m.topics.some(t => !t.hidden), `Missing searchable scenario: ${query}`);
  }
});
check('title token ranking is stable; clear restores original order and expansion', () => {
  const m = model(['больничный замена текст', 'больничный замена текст', 'больничный замена текст', 'больничный замена текст'],
    ['Доступность', 'Больничный', 'Больничный и замена', 'Больничный второй']);
  m.topics[3].open = true;
  m.inputValue('больничный замена');
  assert.deepEqual(m.order.map(t => m.topics.indexOf(t)), [2, 1, 3, 0]);
  m.inputValue('больничный');
  assert.deepEqual(m.order.map(t => m.topics.indexOf(t)), [1, 2, 3, 0], 'ties use original, not previous ranked order');
  m.clear.handlers.click();
  assert.deepEqual(m.order, m.topics);
  assert.deepEqual(m.topics.map(t => t.open), [true, false, false, true]);
  assert.equal(m.input.focused, true);
});
check('real illness topic ranks before incidental availability mentions', () => {
  const m = model(); m.inputValue('больничный');
  assert.match(m.order.find(t => !t.hidden).querySelector('summary').textContent, /Больничный и замена/);
  m.inputValue('2/2');
  assert.equal(m.topics.filter(t => !t.hidden).length, 1);
  m.clear.handlers.click(); assert.deepEqual(m.order, m.topics);
});
console.log(`PASS ${checks} help unit/static contracts (no browser/HTTP/DB proof).`);
