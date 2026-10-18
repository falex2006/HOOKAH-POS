import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const helper = source.match(/function orderCardPreparationState\(order\)\s*\{[\s\S]*?\n\}/)?.[0];
assert.ok(helper, 'order card status aggregator exists');
const context = {};
vm.createContext(context);
vm.runInContext(`${helper}\nthis.aggregate=orderCardPreparationState;`, context);
const aggregate = context.aggregate;

assert.equal(aggregate({ id: 'o', status: 'in_progress', items: [{ preparationStatus: 'queued' }] }), 'queued', 'dispatched work has its own state');
assert.equal(aggregate({ id: 'o', status: 'in_progress', items: [{ preparationStatus: 'in_progress' }] }), 'in_progress', 'active work is in progress');
assert.equal(aggregate({ id: 'o', status: 'ready', items: [{ preparationStatus: 'ready' }, { preparationStatus: 'ready' }] }), 'ready', 'all lines ready means order ready');
assert.equal(aggregate({ id: 'o', status: 'in_progress', items: [{ preparationStatus: 'ready' }, { preparationStatus: 'new' }] }), 'in_progress', 'adding a new line clears completed state');
assert.equal(aggregate({ id: 'o', status: 'open', items: [{ preparationStatus: 'new' }] }), 'open', 'not-dispatched order remains open');
assert.equal(aggregate({ id: 'o', status: 'closed', items: [{ preparationStatus: 'queued' }] }), 'closed', 'financial closure is not replaced by execution state');
assert.equal(aggregate(null), 'open', 'empty card has no execution state');

assert.match(source, /queued:'Отдан в работу',in_progress:'В процессе',ready:'Готово'/, 'card exposes the three requested labels');
console.log('ORDER CARD PREPARATION STATUS QA: PASS (queued, in progress, ready, new line, closed order, empty card)');
