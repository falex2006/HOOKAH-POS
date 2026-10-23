import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { beginPayrollSourceProducerTransaction } from '../payroll-source-fence.js';

const venueId = 'D2F97125-7C90-4A19-8D59-2E2FE4D139C7';
const calls = [];
await beginPayrollSourceProducerTransaction({
  async query(sql, values) { calls.push({ sql, values }); return { rows: [] }; },
}, venueId);
assert.deepEqual(calls.map(call => call.sql), [
  'BEGIN',
  'SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))',
]);
assert.equal(calls[1].values[0], `payroll-official-source-v1:${venueId.toLowerCase()}`);
await assert.rejects(beginPayrollSourceProducerTransaction({ query: async () => ({ rows: [] }) }, 'bad-id'), /payroll_source_fence_venue_id_invalid/);

const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const database = readFileSync(new URL('../db.js', import.meta.url), 'utf8');
for (const [label, start, end] of [
  ['inventory item creation', 'const withInventoryHierarchyTransaction =', "if (pathname === '/api/inventory/items'"],
  ['inventory item update', 'if (inventoryItemPath && req.method === \'PATCH\')', 'if (inventoryItemPath && req.method === \'DELETE\')'],
  ['recipe creation', "if (pathname === '/api/recipes' && req.method === 'POST')", 'const recipeProfile ='],
  ['recipe update', "if (recipeProfile && req.method === 'PATCH')", 'const storedRecipe ='],
  ['recipe archive', 'if (recipeProfile && req.method === \'DELETE\')', 'const index = recipes.findIndex((item) => item.id === recipeProfile[1])'],
  ['premix stock action', 'const premixAction =', 'const orderRefundsPath ='],
  ['premix production', "if (pathname === '/api/inventory/premixes/produce' && req.method === 'POST')", 'const recipe = recipes.find((item) => item.id === recipeId'],
  ['order cancellation/writeoff', 'const orderDelete =', 'if (await handleOrderPreparation'],
  ['order refund', 'const orderRefundsPath =', "if (pathname === '/api/pos/payment-accounts'"],
  ['payment/automatic close', 'const paymentPath =', 'const orderPath ='],
  ['explicit order close', "if (orderPath && req.method === 'POST' && orderPath[2] === 'close')", "if (orderPath && req.method === 'POST' && orderPath[2] === 'split')"],
]) {
  const from = server.indexOf(start); const to = server.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `${label}: source range exists`);
  assert.match(server.slice(from, to), /beginPayrollSourceProducerTransaction\(client, venueDbId\)/, `${label}: takes source fence before reading source data`);
}
for (const method of ['move(input)', 'receive(input)', 'post(venueId, id, actorId)', 'reverse(input)']) {
  const from = database.indexOf(`async ${method}`);
  assert.ok(from >= 0, `${method}: repository method exists`);
  const end = database.indexOf('\n  async ', from + 8);
  assert.match(database.slice(from, end < 0 ? database.length : end), /beginPayrollSourceProducerTransaction\(client,/, `${method}: takes source fence before reading source data`);
}
console.log('PASS payroll source fence producer contract');
