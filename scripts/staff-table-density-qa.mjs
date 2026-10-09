import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const app = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const start = app.indexOf('let floorDensityKey=');
const end = app.indexOf('const updateFloorMapMode=', start);
assert.ok(start > 0 && end > start, 'density helpers remain extractable');
const storage = new Map();
let blockedStorage = false;
const context = vm.createContext({
  staffSessionVerified: true, staffFloorActorId: 'staff:one', floorVenueId: 'venue:one',
  localStorage: {
    getItem(key) { if (blockedStorage) throw new Error('storage unavailable'); return storage.get(key) ?? null; },
    setItem(key, value) { if (blockedStorage) throw new Error('storage unavailable'); storage.set(key, value); },
  },
});
vm.runInContext(`${app.slice(start, end)}\nglobalThis.subject={calculateFloorDensity,loadFloorDensity,saveFloorDensity,get state(){return floorDensity;},get key(){return floorDensityKey;},set state(value){floorDensity=value;}};`, context);
const subject = context.subject;
const calculate = subject.calculateFloorDensity;
const occupiedHeight = (result, count) => {
  const rows = Math.ceil(count / result.columns);
  return rows * result.tileHeight + (rows - 1) * 10;
};
const laptop = calculate(630, 520, 10, 'fit', 100);
assert.equal(laptop.columns, 3);
assert.ok(laptop.tileHeight >= 118);
assert.ok(occupiedHeight(laptop, 10) <= 520);
assert.equal(laptop.overflows, false);
const shorterLaptop = calculate(630, 480, 10, 'fit', 100);
assert.equal(shorterLaptop.columns, 3);
assert.equal(shorterLaptop.overflows, true, 'insufficient height is reported, never hidden by shrinking below readable minimum');
for (const [width, height] of [[1000, 780], [1250, 820], [790, 480]]) {
  const result = calculate(width, height, 10, 'fit', 100);
  assert.equal(result.overflows, false);
  assert.ok(occupiedHeight(result, 10) <= height);
}
for (const width of [320, 630, 1000, 1250]) {
  let previous;
  for (let scale = 70; scale <= 130; scale += 5) {
    const result = calculate(width, 520, 10, 'manual', scale);
    assert.ok(result.tileHeight >= 118);
    assert.ok(Number.isInteger(result.columns) && result.columns >= 1 && result.columns <= 10);
    assert.equal(result.overflows, occupiedHeight(result, 10) > 520);
    if (previous) {
      assert.ok(result.columns <= previous.columns, 'larger size cannot increase column count');
      assert.ok(result.tileHeight >= previous.tileHeight, 'larger size cannot shrink tile height');
    }
    previous = result;
  }
}
const largeHall = calculate(630, 520, 100, 'fit', 100);
assert.equal(largeHall.overflows, true);
assert.equal(largeHall.tileHeight, 118);
assert.equal(calculate(170, 520, 1, 'fit', 100).columns, 1, 'narrow viewport retains one accessible card');
subject.loadFloorDensity();
const userOneKey = subject.key;
assert.match(userOneKey, /staff%3Aone:venue%3Aone$/);
subject.state = { mode: 'manual', scale: 85 };
subject.saveFloorDensity();
context.staffFloorActorId = 'staff:two';
subject.loadFloorDensity();
assert.equal(subject.state.mode, 'fit', 'another user starts with default');
context.staffFloorActorId = 'staff:one';
context.floorVenueId = 'venue:two';
subject.loadFloorDensity();
assert.equal(subject.state.mode, 'fit', 'another venue starts with default');
context.floorVenueId = 'venue:one';
subject.loadFloorDensity();
assert.equal(subject.state.scale, 85, 'returning to original scope restores saved preference');
for (const raw of ['{broken', 'null', '{"mode":"manual","scale":999}', '{"mode":"manual","scale":"85"}', '{"mode":"unknown","scale":85}']) {
  context.floorVenueId = `invalid:${raw}`;
  const key = `hookah_floor_density_v1:${encodeURIComponent(context.staffFloorActorId)}:${encodeURIComponent(context.floorVenueId)}`;
  storage.set(key, raw);
  subject.loadFloorDensity();
  assert.equal(subject.state.mode, 'fit');
  assert.equal(subject.state.scale, 100);
}
blockedStorage = true;
context.floorVenueId = 'blocked-storage';
assert.doesNotThrow(() => subject.loadFloorDensity());
assert.doesNotThrow(() => subject.saveFloorDensity());
context.staffSessionVerified = false;
subject.loadFloorDensity();
assert.equal(subject.key, '', 'unverified identity never obtains a preference storage key');
assert.equal(subject.state.mode, 'fit');
console.log('PASS: floor density sizing, readable overflow, slider sizes and scoped resilient preferences');
