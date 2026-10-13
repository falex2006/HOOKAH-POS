import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../pos-dispatch.js', import.meta.url), 'utf8');
const context = { window: {} };
vm.runInNewContext(source, context, { filename: 'pos-dispatch.js' });
const dispatch = context.window.HookahPosDispatch;
assert.ok(dispatch && Object.isFrozen(dispatch), 'browser dispatch contract is immutable');
const plain = value => JSON.parse(JSON.stringify(value));
let checks = 0;
const eq = (actual, expected, label) => { assert.deepEqual(plain(actual), expected, label); checks++; };

const items = [
  { id: 'bar-new', preparationStation: 'bar', preparationStatus: 'new' },
  { id: 'hookah-new', preparationStation: 'hookah', preparationStatus: 'new' },
  { id: 'unknown-new', preparationStation: null, preparationStatus: 'new' },
  { id: 'unknown-queued', preparationStation: null, preparationStatus: 'queued' },
  { id: 'bar-queued', preparationStation: 'bar', preparationStatus: 'queued' },
  { id: 'hookah-working', preparationStation: 'hookah', preparationStatus: 'in_progress' },
  { id: 'bar-ready', preparationStation: 'bar', preparationStatus: 'ready' },
];
const original = plain(items);
eq(dispatch.eligibleItems(items).map(item => item.id),
  ['bar-new', 'hookah-new', 'unknown-new', 'unknown-queued'],
  'assigned queued, in-progress and ready positions cannot be sent again');
assert.throws(() => dispatch.plan(items), /preparation_direction_required/,
  'unknown directions require an explicit choice before any request'); checks++;
assert.throws(() => dispatch.plan(items, { 'unknown-new': 'kitchen', 'unknown-queued': 'bar' }),
  /preparation_direction_required/, 'unrecognised directions are rejected'); checks++;
const groups = dispatch.plan(items, { 'unknown-new': 'hookah', 'unknown-queued': 'bar' });
eq(groups, [
  { station: 'bar', itemIds: ['bar-new', 'unknown-queued'] },
  { station: 'hookah', itemIds: ['hookah-new', 'unknown-new'] },
], 'mixed directions use declared groups with original item identities');
eq(items, original, 'planning never modifies the server snapshot');
eq(dispatch.plan([]), [], 'empty order has no dispatch operations');
eq(dispatch.plan([{ id: 'legacy', preparationStation: 'bar' }]),
  [{ station: 'bar', itemIds: ['legacy'] }], 'legacy item without a status remains new');

const posts = [], saved = [];
const success = await dispatch.send(groups, {
  isCurrent: () => true,
  post: async group => { posts.push(plain(group)); return { station: group.station, status: 'in_progress' }; },
  onSaved: payload => saved.push(plain(payload)),
});
eq(posts, plain(groups), 'both station requests are issued once in declared order');
eq(saved.map(payload => payload.station), ['bar', 'hookah'], 'only confirmed payloads update the UI');
eq(success.completed, [{ station: 'bar', count: 2 }, { station: 'hookah', count: 2 }],
  'success accounts for each confirmed station');
assert.equal(success.error, null); checks++;

const partialPosts = [], partialSaved = [], failure = new Error('station_unavailable');
const partial = await dispatch.send(groups, {
  isCurrent: () => true,
  post: async group => { partialPosts.push(group.station); if (group.station === 'hookah') throw failure; return { station: 'bar' }; },
  onSaved: payload => partialSaved.push(payload.station),
});
eq(partialPosts, ['bar', 'hookah'], 'a station failure is surfaced without another attempt');
eq(partialSaved, ['bar'], 'failed station never receives optimistic success');
eq(partial.completed, [{ station: 'bar', count: 2 }], 'partial result preserves the confirmed station');
assert.equal(partial.error, failure); checks++;

let allowed = true, guardedRequests = 0;
const guarded = await dispatch.send(groups, {
  isCurrent: () => allowed,
  post: async () => { guardedRequests++; return { status: 'in_progress' }; },
  onSaved: () => { allowed = false; },
});
assert.equal(guardedRequests, 1, 'context change after first success prevents the next station write'); checks++;
eq(guarded.completed, [{ station: 'bar', count: 2 }], 'first confirmed operation survives context loss');
assert.match(guarded.error.message, /permissions_changed/); checks++;

let invalidRequests = 0, invalidSaved = 0;
const invalid = await dispatch.send(groups, {
  isCurrent: () => false,
  post: async () => { invalidRequests++; },
  onSaved: () => { invalidSaved++; },
});
assert.equal(invalidRequests, 0, 'stale context prevents the first request'); checks++;
assert.equal(invalidSaved, 0); checks++;
eq(invalid.completed, [], 'stale context has no confirmed result');

let current = true, lateRequests = 0, lateSaved = 0;
const late = await dispatch.send(groups, {
  isCurrent: () => current,
  post: async () => { lateRequests++; current = false; return { status: 'in_progress' }; },
  onSaved: () => { lateSaved++; },
});
assert.equal(lateRequests, 1, 'context lost during a request prevents the next station'); checks++;
assert.equal(lateSaved, 0, 'late response never mutates another order, actor or venue'); checks++;
eq(late.completed, [], 'late response is not represented as success in the new context');
assert.match(late.error.message, /permissions_changed/); checks++;

// A retry must plan from a fresh server read. The failed hookah station still has
// new positions; the successful bar station is now queued and is excluded.
const reread = items.map(item => ['bar-new', 'unknown-queued'].includes(item.id)
  ? { ...item, preparationStation: 'bar', preparationStatus: 'queued' } : { ...item });
eq(dispatch.plan(reread, { 'unknown-new': 'hookah' }),
  [{ station: 'hookah', itemIds: ['hookah-new', 'unknown-new'] }],
  'retry includes only positions still new in the authoritative read');

console.log(`POS DISPATCH RUNTIME QA: PASS (${checks} checks; station choices, mixed order, confirmed success, partial failure, stale context, reread retry)`);
