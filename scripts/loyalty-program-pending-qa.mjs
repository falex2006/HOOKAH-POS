import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const portal = readFileSync(new URL('../portal.js', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const pendingStart = portal.indexOf('  const setLoyaltyPending = (pending) => {');
const pendingEnd = portal.indexOf('  const clear = () =>', pendingStart);
const handlerStart = portal.indexOf("  loyaltyForm.addEventListener('submit', async (event) => {");
const handlerEnd = portal.indexOf('\n  load();\n}', handlerStart);
assert.ok(pendingStart >= 0 && pendingEnd > pendingStart && handlerStart >= 0 && handlerEnd > handlerStart);
const genericSubmitStart = portal.indexOf("document.addEventListener('submit', (event) => {");
const genericSubmitEnd = portal.indexOf('\n', genericSubmitStart);
assert.ok(genericSubmitStart >= 0 && genericSubmitEnd > genericSubmitStart, 'generic submit handler exists');
assert.match(portal.slice(genericSubmitStart, genericSubmitEnd), /\[[^\]]*'loyalty-form-visible'[^\]]*\]\.includes\(form\.id\)[^;]*return;/, 'generic six-second submit timer excludes the owned form even when other owned forms are added');
assert.match(portal, /if \(loyaltyForm\.dataset\.submitting === '1'\) list\.querySelectorAll\('button'\)/, 'redrawn list stays disabled while saving');
assert.match(portal, /document\.querySelector\('#loyalty-program-list'\)\.addEventListener\('click', async \(event\) => \{[\s\S]{0,240}if \(loyaltyForm\.dataset\.submitting === '1'\) return;/, 'delegated list actions reject clicks while saving');

const submit = { disabled: false, textContent: 'Сохранить программу' };
const inputs = [
  { value: '' },
  { value: 'QA программа' },
  { value: '5' },
  { value: '10' },
  { value: '100' },
];
let handler;
const form = {
  dataset: {},
  querySelectorAll: () => [...inputs, submit],
  addEventListener: (type, listener) => { assert.equal(type, 'submit'); handler = listener; },
};
const listButtons = [{ disabled: false }, { disabled: false }];
const auxiliary = {
  '#loyalty-new': { disabled: false },
  '#loyalty-clear': { disabled: false },
  '#loyalty-program-filter': { disabled: false },
};
const message = { textContent: '', className: '' };
const nodes = {
  '#loyalty-id': inputs[0],
  '#loyalty-name': inputs[1],
  '#loyalty-discount': inputs[2],
  '#loyalty-bonus': inputs[3],
  '#loyalty-deposit': inputs[4],
  '#loyalty-message': message,
  ...auxiliary,
};
const document = {
  querySelector: (selector) => nodes[selector],
  querySelectorAll: (selector) => selector === '[data-loyalty-edit], [data-loyalty-toggle]' ? listButtons : [],
};
const requests = [];
const api = (path, options) => new Promise((resolve, reject) => requests.push({ path, options, resolve, reject }));
let clearCount = 0;
let loadCount = 0;
const clear = () => { clearCount += 1; };
const load = async () => { loadCount += 1; };
const portalNotice = () => {};
const bindManagementNotice = () => portalNotice;
new Function('document', 'loyaltyForm', 'loyaltySubmit', 'api', 'clear', 'load', 'portalNotice', 'bindManagementNotice',
  `${portal.slice(pendingStart, pendingEnd)}\n${portal.slice(handlerStart, handlerEnd)}`
)(document, form, submit, api, clear, load, portalNotice, bindManagementNotice);

const send = () => handler({ preventDefault() {} });
const settle = () => new Promise((resolve) => setImmediate(resolve));

send();
send();
assert.equal(requests.length, 1, 'two submits while pending send one POST');
assert.equal(requests[0].path, '/api/discount-groups');
assert.deepEqual(JSON.parse(requests[0].options.body), { name: 'QA программа', discountPercent: 5, bonusPercent: 10, depositMin: 100 });
assert.equal(form.dataset.submitting, '1');
assert.equal(submit.disabled, true);
assert.equal(submit.textContent, 'Сохранение…');
assert.ok([...Object.values(auxiliary), ...listButtons].every((node) => node.disabled));
requests[0].reject(Object.assign(new Error('conflict'), { payload: { error: 'discount_group_name_exists' } }));
await settle();
assert.equal(form.dataset.submitting, '0');
assert.equal(clearCount, 0, 'failure preserves draft');
assert.match(message.textContent, /уже существует/);
assert.ok([...Object.values(auxiliary), ...listButtons, submit].every((node) => !node.disabled));

inputs[1].value = 'QA программа 2';
send();
assert.equal(requests.length, 2, 'retry sends exactly one new request');
requests[1].resolve({ id: 'group-1' });
await settle();
assert.equal(clearCount, 1);
assert.equal(loadCount, 1);
assert.equal(form.dataset.submitting, '0');
assert.match(message.textContent, /сохранена/);

console.log('LOYALTY PROGRAM PENDING QA: PASS (single submit, draft on error, retry, refresh)');
