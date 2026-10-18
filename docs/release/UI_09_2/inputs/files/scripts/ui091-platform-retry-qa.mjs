import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../platform.js', import.meta.url), 'utf8');
assert.equal(source, readFileSync(new URL('../dist/platform.js', import.meta.url), 'utf8'));
const start = source.indexOf('  let loadGeneration = 0;');
const end = source.indexOf('  const deletionConfirmed', start);
assert.ok(start > 0 && end > start);
const nodes = new Map();
const state = { companies: [], companiesLoaded: true, loadError: null, health: 'ok' };
let reject = true;
const context = vm.createContext({ state, Date, Promise,
  $: selector => { if (!nodes.has(selector)) nodes.set(selector, { textContent: '', innerHTML: '' }); return nodes.get(selector); },
  api: async url => { if (reject && url === '/api/platform/organizations') throw new Error('synthetic_read_failure'); return url.endsWith('/organizations') ? { items: [{ id: 'isolated-fixture' }] } : { status: 'ok' }; },
  renderCompanies() {}, renderOnboarding() {}, renderPlans() {}, renderKpis() {}, renderHealth() {},
});
vm.runInContext(source.slice(start, end) + '\nthis.runLoad = load;', context);
await context.runLoad();
assert.equal(state.loadError, 'synthetic_read_failure');
context.$('#settings-result').textContent = 'Не удалось обновить: synthetic_read_failure';
reject = false;
await context.runLoad();
assert.equal(state.loadError, null);
assert.equal(state.health, 'ok');
assert.equal(state.companies.length, 1);
assert.equal(context.$('#settings-result').textContent, '');
assert.match(context.$('#platform-updated').textContent, /^Обновлено /);
console.log('UI091 platform retry PASS: actual load source clears stale settings error; mirror exact.');
