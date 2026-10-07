import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const start = source.indexOf("if (orderPath && req.method === 'POST' && orderPath[2] === 'close')");
const end = source.indexOf("if (orderPath && req.method === 'POST' && orderPath[2] === 'split')", start);
assert.notEqual(start, -1, 'PostgreSQL order close route exists');
assert.notEqual(end, -1, 'transaction test can isolate the close route');
const closeRoute = source.slice(start, end);
const cardsStart = source.indexOf('LEFT JOIN LATERAL (', source.indexOf('async function depleteRecipeForOrder'));
const cardsEnd = source.indexOf(') rc ON true', cardsStart);
const recipeLookup = source.slice(cardsStart, cardsEnd);
assert.match(recipeLookup, /candidate\.product_id=oi\.product_id OR \(candidate\.product_id IS NULL AND lower\(btrim\(candidate\.name\)\)=lower\(btrim\(p\.name\)\)\)/, 'name fallback cannot select a card linked to another product and ignores accidental surrounding spaces');
assert.match(recipeLookup, /ORDER BY \(candidate\.product_id=oi\.product_id\) DESC/, 'exact product-linked cards take precedence over name fallback');

const at = (pattern, label) => {
  const match = closeRoute.match(pattern);
  assert.ok(match, `${label} is present in the close route`);
  return match.index;
};

const begin = at(/await client\.query\('BEGIN'\)/, 'transaction begins');
const lock = at(/SELECT id,status,table_id AS "tableId",guest_id AS "guestId",vip_minimum AS "minimumOrderTotal" FROM orders WHERE id=\$1 AND venue_id=\$2 FOR UPDATE/, 'order row is locked');
const shiftLock = at(/SELECT id FROM shifts WHERE venue_id=\$1 AND closed_at IS NULL[\s\S]*?FOR UPDATE/, 'active shift is locked');
const depletion = at(/depleteRecipeForOrder\(repositories\.pool, orderPath\[1\], venueDbId, req\.user\?\.id, client\)/, 'depletion uses the active transaction client');
const close = at(/UPDATE orders SET status=\$1,closed_at=now\(\)/, 'order closes transactionally');
const loyalty = at(/accrueGuestOrderBonus\(client,[\s\S]*?eligibleBase: Math\.max\(0, net - Number\(redeemedRows\.rows\[0\]\?\.amount \|\| 0\)\)/, 'loyalty accrual excludes both VIP uplift and bonus-redeemed amounts');
const orderCost = at(/INSERT INTO order_costs \(venue_id,order_id,cost\)/, 'COGS snapshot is inserted transactionally');
const payment = at(/INSERT INTO payments \(order_id,method,amount,status,shift_id\)/, 'payment is inserted transactionally and assigned to the active shift');
const table = at(/UPDATE tables t SET status=CASE/, 'table release is transactional');
const commit = at(/await client\.query\('COMMIT'\)/, 'transaction commits');
const audit = at(/recordAudit\(req, 'order\.closed'/, 'audit event is emitted');

assert.ok(begin < lock && lock < shiftLock && shiftLock < depletion, 'order and active shift locks are acquired before stock depletion');
assert.ok(depletion < loyalty && loyalty < close && close < orderCost && orderCost < payment && payment < table && table < commit, 'stock depletion, bonus ledger/snapshot, close, and payment occur before commit');
assert.ok(commit < audit, 'audit is emitted only after successful commit');
assert.match(closeRoute, /\['closed', 'cancelled'\]\.includes\(persisted\.status\)[\s\S]*?ROLLBACK[\s\S]*?json\(res, 409, \{ error: 'order_already_final' \}\)/, 'already-final orders roll back and retain the existing conflict response');
assert.match(closeRoute, /ROLLBACK[\s\S]*?error\.message === 'insufficient_recipe_stock'[\s\S]*?error: 'insufficient_recipe_stock'/, 'insufficient stock rolls back and retains its response contract');
assert.match(closeRoute, /SELECT id,status,[^\n]+FOR UPDATE/, 'concurrent closes serialize on the order row');
assert.match(closeRoute, /finally\s*\{\s*client\?\.release\(\);\s*\}/, 'transaction client is always released');
assert.doesNotMatch(closeRoute, /repositories\.pool\.query\(/, 'route does not escape the transaction with pool-level queries');

const paymentStart = source.indexOf("if (paymentPath && (req.method === 'GET' || req.method === 'POST'))");
const paymentEnd = source.indexOf('const orderPath = pathname.match(', paymentStart);
assert.notEqual(paymentStart, -1, 'payments API exists');
assert.notEqual(paymentEnd, -1, 'test can isolate payments API');
const paymentRoute = source.slice(paymentStart, paymentEnd);
const paymentPost = paymentRoute.slice(paymentRoute.indexOf('const input = allocationInput || await body(req)') >= 0 ? paymentRoute.indexOf('const input = allocationInput || await body(req)') : paymentRoute.indexOf('const input = await body(req)'));
const paymentAt = (pattern, label) => {
  const match = paymentPost.match(pattern);
  assert.ok(match, `${label} is present in the payments route`);
  return match.index;
};
const paymentBegin = paymentAt(/await client\.query\('BEGIN'\)/, 'payment transaction begins');
const paymentLock = paymentAt(/SELECT id,status,table_id AS "tableId",guest_id AS "guestId",reservation_id AS "reservationId",vip_minimum AS "minimumOrderTotal" FROM orders WHERE id=\$1 AND venue_id=\$2 FOR UPDATE/, 'payment locks the order row');
const activeShift = paymentAt(/requireOpenShift|SELECT id FROM shifts WHERE venue_id=\$1 AND closed_at IS NULL[\s\S]*?FOR UPDATE/, 'active shift is required inside the payment transaction');
const paymentInsert = paymentAt(/INSERT INTO payments \(order_id,method,amount,status,shift_id,idempotency_key\)/, 'payment insert records the tender, shift attribution and idempotency key transactionally');
const paymentDepletion = paymentAt(/depleteRecipeForOrder\(repositories\.pool, paymentPath\[1\], venueDbId, req\.user\?\.id, client\)/, 'final payment depletion uses transaction client');
const paymentClose = paymentAt(/UPDATE orders SET status=\\'closed\\',closed_at=now\(\)/, 'final payment closes order transactionally');
const paymentLoyalty = paymentAt(/accrueGuestOrderBonus\(client,[\s\S]*?eligibleBase: Math\.max\(0, net - Number\(redeemedRows\.rows\[0\]\?\.amount \|\| 0\)\)/, 'final payment accrual excludes VIP uplift and bonus-redeemed amounts');
const paymentCost = paymentAt(/INSERT INTO order_costs \(venue_id,order_id,cost\)/, 'final payment records COGS transactionally');
const paymentTable = paymentAt(/UPDATE tables t SET status=CASE/, 'final payment releases table transactionally');
const paymentCommit = paymentPost.lastIndexOf("await client.query('COMMIT')");
assert.ok(paymentCommit >= 0, 'payment transaction commit is present');
const paymentAudit = paymentAt(/recordAudit\(req, 'order\.payment_added'/, 'payment audit emits after transaction');
assert.ok(paymentBegin < paymentLock && paymentLock < activeShift && activeShift < paymentInsert && paymentInsert < paymentCommit, 'payment is serialized, shift-attributed, and persisted in its transaction');
assert.ok(paymentInsert < paymentDepletion && paymentDepletion < paymentLoyalty && paymentLoyalty < paymentClose && paymentClose < paymentCost && paymentCost < paymentTable, 'final payment, depletion, bonus, close, COGS, and table release are atomic');
assert.ok(paymentCommit < paymentAudit, 'payment audit follows a successful commit');
assert.match(paymentRoute, /if \(closed\) \{[\s\S]*?depleteRecipeForOrder/, 'partial payments do not trigger stock depletion');
assert.match(paymentRoute, /ROLLBACK[\s\S]*?error\.message === 'insufficient_recipe_stock'[\s\S]*?error: 'insufficient_recipe_stock'/, 'insufficient stock rolls back final payment and retains response contract');
assert.match(paymentRoute, /ROLLBACK[\s\S]*?error: 'payment_exceeds_due'/, 'overpayment rolls back and retains response contract');
assert.match(paymentRoute, /persisted\.status === 'closed' \|\| persisted\.status === 'cancelled'[\s\S]*?ROLLBACK[\s\S]*?order_already_final/, 'finalized orders reject concurrent payment/close');
assert.doesNotMatch(paymentPost, /repositories\.pool\.query\(/, 'payment POST has no out-of-transaction database queries');

const actionStart = source.indexOf("const orderAction = pathname.match(/", 0);
const actionEnd = source.indexOf("const order = orders.find((entry) => entry.id === orderAction[1])", actionStart);
assert.ok(actionStart >= 0 && actionEnd > actionStart, 'order status/transfer action routes exist');
const actionRoute = source.slice(actionStart, actionEnd);
const statusStart = actionRoute.indexOf("if (orderAction[2] === 'status')");
const transferStart = actionRoute.indexOf("if (typeof input.tableId !== 'string'", statusStart);
assert.ok(statusStart >= 0 && transferStart > statusStart, 'status and transfer actions can be reviewed separately');
const statusRoute = actionRoute.slice(statusStart, transferStart);
const statusLock = statusRoute.indexOf('FROM orders WHERE id=$1 AND venue_id=$2 FOR UPDATE');
const statusUpdate = statusRoute.indexOf('AND status=$4 RETURNING id,status');
const statusCommit = statusRoute.indexOf("await client.query('COMMIT')");
const statusAudit = statusRoute.indexOf("recordAudit(req, 'order.status_changed'");
assert.ok(statusLock >= 0 && statusLock < statusUpdate && statusUpdate < statusCommit && statusCommit < statusAudit, 'status transition locks and updates atomically before audit');
assert.doesNotMatch(statusRoute, /repositories\.pool\.query\(/, 'status transition never escapes its transaction');
const transferRoute = actionRoute.slice(transferStart);
assert.match(transferRoute, /FROM orders WHERE id=\$1 AND venue_id=\$2 FOR UPDATE/, 'transfer locks the order shared with payment/close');
assert.match(transferRoute, /JOIN zones z ON z\.id=t\.zone_id WHERE t\.id=\$1 AND z\.venue_id=\$2 AND t\.status <> 'blocked' FOR UPDATE OF t/, 'transfer target must be an available table in this venue');
assert.match(transferRoute, /AND status=\$4 RETURNING id,status,table_id/, 'transfer uses a compare-and-set status guard');

const orderRepository = readFileSync(new URL('../db.js', import.meta.url), 'utf8');
assert.match(orderRepository, /SELECT t\.id,t\.min_order_total FROM tables t JOIN zones z ON z\.id=t\.zone_id WHERE t\.id=\$1 AND z\.venue_id=\$2 AND t\.status <> 'blocked' FOR UPDATE OF t/, 'order creation validates/locks its table and reads the server-owned minimum in the order venue');
assert.match(orderRepository, /const vipMinimum = Math\.max\(Number\(input\.vipMinimum \|\| 0\), tableMinimum\)/, 'client input cannot lower the table minimum');

console.log('ORDER/PAYMENT TRANSACTION QA: assertions passed');
