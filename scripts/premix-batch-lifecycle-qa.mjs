import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { allocatePremixBatchConsumption } = require('../db.js');
const migration = fs.readFileSync(new URL('../migrations/056_premix_batch_lifecycle.sql', import.meta.url), 'utf8');
const server = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const portal = fs.readFileSync(new URL('../portal.js', import.meta.url), 'utf8');
assert.match(migration, /planned_output_quantity/);
assert.match(migration, /expires_at/);
assert.match(migration, /inventory_premix_batch_movements/);
assert.match(migration, /premix_batch_movement_immutable_guard/);
assert.match(server, /produced_by AS "producedById"/);
assert.match(server, /remainingQuantity/);
assert.match(server, /premixAction = pathname\.match/);
assert.match(server, /batch\.status === 'voided' \? 0/);
assert.match(server, /if \(!restoredRows\.length\) throw new Error\('premix_ingredient_not_found'\)/);
assert.match(portal, /demoPremixRemaining = \(batch\) => \(batch\.status \|\| 'produced'\) === 'voided' \? 0/);
assert.match(portal, /Приготовил:/);
assert.match(portal, /data-premix-action="count"/);

const makeClient = (lots) => {
  const writes = [];
  return {
    writes,
    async query(sql, values) {
      if (/SELECT b\.id, b\.output_quantity/.test(sql)) return { rows: lots };
      if (/INSERT INTO inventory_premix_batch_movements/.test(sql)) { writes.push({ sql, values }); return { rows: [] }; }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
};
const lot = (id, output, expiry, createdAt, delta = 0) => ({ id, output_quantity: output, allocated_delta: delta, expires_at: expiry, expired: Boolean(expiry && new Date(expiry).getTime() <= Date.now()), created_at: createdAt });
const relativeDate = (days) => new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

const fifo = makeClient([
  lot('earlier-expiry', 5, relativeDate(1), '2026-09-30T11:00:00.000Z'),
  lot('later-expiry', 5, relativeDate(5), '2026-09-30T10:00:00.000Z'),
]);
await allocatePremixBatchConsumption(fifo, { venueId: 'venue', ingredientId: 'item', stockMovementId: 'movement', quantity: 7, onHandBefore: 10, reason: 'Продажа' });
assert.deepEqual(fifo.writes.map((write) => [write.values[1], Number(write.values[3])]), [['earlier-expiry', -5], ['later-expiry', -2]], 'uses soonest expiry first and splits across lots');

const legacy = makeClient([lot('tracked', 5, relativeDate(1), '2026-09-30T11:00:00.000Z')]);
await allocatePremixBatchConsumption(legacy, { venueId: 'venue', ingredientId: 'item', stockMovementId: 'movement', quantity: 4, onHandBefore: 8, reason: 'Списание' });
assert.equal(legacy.writes.length, 1);
assert.equal(Number(legacy.writes[0].values[3]), -1, 'unallocated legacy balance is consumed before tracked lots');

const expired = makeClient([lot('expired', 3, relativeDate(-1), '2026-09-20T11:00:00.000Z')]);
await assert.rejects(() => allocatePremixBatchConsumption(expired, { venueId: 'venue', ingredientId: 'item', stockMovementId: 'movement', quantity: 1, onHandBefore: 3, reason: 'Продажа' }), /expired_premix_stock/);
assert.equal(expired.writes.length, 0, 'expired lot issue is rejected without a partial allocation');

console.log('PREMIX BATCH LIFECYCLE QA: PASS (FEFO/FIFO allocation, legacy stock compatibility, expired-lot rejection, migration/API/UI contracts)');
