import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const section = (from, to) => {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start);
  assert.notEqual(start, -1, `route marker exists: ${from}`);
  assert.notEqual(end, -1, `route boundary exists: ${to}`);
  return source.slice(start, end);
};

const addItem = section("if (itemMatch && req.method === 'POST')", 'const itemAction = pathname.match');
const editItem = section("if (itemAction && (req.method === 'PATCH' || req.method === 'DELETE'))", 'const orderRefundsPath = pathname.match');
const statusRoute = section("if (orderAction && req.method === 'POST')", 'const itemMatch = pathname.match');

for (const [name, route] of [['POST order item', addItem], ['PATCH/DELETE order item', editItem]]) {
  assert.match(route, /repositories\.pool\.connect\(\)/, `${name} checks out a transaction client`);
  assert.match(route, /await client\.query\('BEGIN'\)/, `${name} starts a transaction`);
  assert.match(route, /SELECT id,status(?:,[^']+)? FROM orders WHERE id=\$1 AND venue_id=\$2 FOR UPDATE/, `${name} serializes against close by locking its order`);
  assert.match(route, /!\['open', 'in_progress', 'ready'\]\.includes\(orderRows\[0\]\.status\)/, `${name} rechecks editability while holding the lock`);
  assert.match(route, /await client\.query\('COMMIT'\)/, `${name} commits its item change under the order lock`);
  assert.match(route, /ROLLBACK[\s\S]*?finally\s*\{[\s\S]*?client\??\.release\(\)/, `${name} rolls back errors and always releases the client`);
  assert.doesNotMatch(route, /repositories\.pool\.query\(/, `${name} does not perform out-of-transaction DB queries`);
}
assert.match(addItem, /INSERT INTO order_items/, 'POST still inserts new lines');
assert.doesNotMatch(addItem, /UPDATE order_items SET quantity=/, 'POST creates an immutable attribution event rather than merging into an existing line');
assert.match(addItem, /sales_employee_id,sold_at/, 'POST persists the session employee and server timestamp');
assert.match(addItem, /sales_attribution_server_managed/, 'POST rejects client supplied attribution fields');
assert.match(addItem, /sales_employee_session_required/, 'POST requires an authenticated employee identity');
assert.match(addItem, /'order\.item_added'/, 'POST audits each attribution event as an added item');
assert.match(editItem, /DELETE FROM order_items/, 'DELETE still removes a line');
assert.match(editItem, /UPDATE order_items SET quantity=/, 'PATCH still changes line quantity');
assert.match(editItem, /quantity_increase_requires_new_line/, 'PATCH increase requires a new attributed line');
assert.match(statusRoute, /input\.status === 'closed'[\s\S]*?order_close_requires_payment/, 'direct status close is rejected in favor of the paid close route');
assert.match(statusRoute, /const allowed = \['open', 'in_progress', 'ready', 'closed', 'cancelled'\]/, 'other established status values remain supported');
assert.match(statusRoute, /if \(!validOrderTransition\(currentRows\[0\]\.status, input\.status\)\)/, 'non-close status transitions retain existing validation');

console.log('ORDER ITEM CLOSE GUARD QA: source contracts passed');
