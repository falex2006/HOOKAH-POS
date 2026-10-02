import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';

const databaseUrl = process.env.MIGRATIONS_PG_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('Set MIGRATIONS_PG_TEST_DATABASE_URL to an isolated PostgreSQL test database');
assert.match(new URL(databaseUrl).pathname, /(?:test|qa|scratch)/i,
  'refusing test writes unless the database name clearly identifies a test/QA/scratch database');

const require = createRequire(import.meta.url);
const { Client, Pool } = require('pg');
const setup = new Client({ connectionString: databaseUrl });
const pool = new Pool({ connectionString: databaseUrl, max: 4 });
const server = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const validShiftCashStart = server.indexOf('const validCashAmount =');
const validShiftCashEnd = server.indexOf('\n};', validShiftCashStart) + 3;
const validShiftCashSource = server.slice(validShiftCashStart, validShiftCashEnd);
const shiftStart = server.indexOf("if (pathname === '/api/shifts' && req.method === 'GET')");
const shiftEnd = server.indexOf("if (pathname === '/api/venue' && req.method === 'GET')", shiftStart);
const paymentStart = server.indexOf('const paymentPath = pathname.match(');
const paymentEnd = server.indexOf('const orderPath = pathname.match(', paymentStart);
assert.ok(shiftStart >= 0 && shiftEnd > shiftStart, 'shift open/close API handlers are available');
assert.ok(paymentStart >= 0 && paymentEnd > paymentStart, 'sale/payment API handler is available');
const shiftRoute = server.slice(shiftStart, shiftEnd);
const paymentRoute = server.slice(paymentStart, paymentEnd);
let venueId = null;
let userId = null;
let orderId = null;
let productId = null;
let guestId = null;

const callShiftApi = async ({ path, method = 'POST', body = {}, role = 'owner' }) => {
  let response;
  const pathname = path;
  const result = await new Function('pathname','req','res','repositories','venueDbId','denyUnlessAny','body','json','recordAudit','shifts','isOperationalEmployee','hasPermission',
    `${validShiftCashSource}\nreturn (async()=>{${shiftRoute}})();`)(
    pathname, { method, headers: {}, user: { id: userId, name: 'Cash QA', role } }, {}, { pool, audit: { record: async () => {} } }, venueId,
    () => false, async () => body, (_res, status, data) => { response = { status, data }; return response; }, () => {}, [], () => false,
    (_req, permission) => permission === 'finance_read' && ['owner','admin','manager','developer'].includes(role),
  );
  return response || result;
};

const callPaymentApi = async ({ path, method = 'POST', body = {} }) => {
  let response;
  const pathname = path;
  const result = await new Function('pathname','req','res','repositories','venueDbId','denyUnless','body','json','recordAudit','requireOpenShift','orders','scaleBatchRecipeIngredients','depleteRecipeForOrder','approvedDiscountTotal','orderTotal','validPaymentAmount','roundMoney','orderBalanceConflict','moneyCents','pgOrderPricing','accrueGuestOrderBonus',
    `return (async()=>{${paymentRoute}})();`)(
    pathname, { method, headers: {}, user: { id: userId, name: 'Cash QA', role: 'owner' } }, {}, { pool, audit: { record: async () => {} } }, venueId,
    () => false, async () => body, (_res, status, data) => { response = { status, data }; return response; }, () => {},
    async () => false, [], () => [], async () => ({ lines: [], totalCost: 0 }), () => 0, () => 0,
    (value) => Number.isFinite(value) && value > 0 && Math.abs(value * 100 - Math.round(value * 100)) < 1e-7,
    (value) => Math.round(Number(value) * 100) / 100,
    ({ due, paid }) => Math.round(Number(paid) * 100) > Math.round(Number(due) * 100),
    (value) => Math.round(Number(value) * 100),
    async (client, id, minimum = 0) => { const items = await client.query('SELECT quantity,unit_price FROM order_items WHERE order_id=$1', [id]); const payments = await client.query("SELECT COALESCE(SUM(amount),0) AS amount FROM payments WHERE order_id=$1 AND status IN ('paid','partially_paid')", [id]); const subtotal = items.rows.reduce((sum, item) => sum + Number(item.quantity) * Number(item.unit_price), 0); const due = Math.max(subtotal, Number(minimum || 0)); return { subtotal, discount: 0, net: subtotal, due, paid: Number(payments.rows[0]?.amount || 0), minimumAdjustment: due - subtotal, source: 'none', groupDiscountAmount: null, groupDiscountGroupId: null, groupDiscountName: null, groupDiscountPercent: null, groupDiscountBase: null }; },
    async () => ({ base: 0, percent: 0, earned: 0, balance: null }),
  );
  return response || result;
};

try {
  await setup.connect();
  venueId = (await setup.query("INSERT INTO venues (name,timezone) VALUES ('Isolated shift cash E2E QA','Asia/Yekaterinburg') RETURNING id")).rows[0].id;
  userId = (await setup.query(`INSERT INTO users (venue_id,full_name,login,role)
    VALUES ($1,'Cash QA','shift-cash-qa-${process.pid}','owner') RETURNING id`, [venueId])).rows[0].id;
  productId = (await setup.query("INSERT INTO products (venue_id,name,category,sale_price) VALUES ($1,'QA order','bar',300) RETURNING id", [venueId])).rows[0].id;
  orderId = (await setup.query("INSERT INTO orders (venue_id,opened_by,status) VALUES ($1,$2,'open') RETURNING id", [venueId, userId])).rows[0].id;
  await setup.query('INSERT INTO order_items (order_id,product_id,quantity,unit_price) VALUES ($1,$2,1,300)', [orderId, productId]);

  const opened = await callShiftApi({ path: '/api/shifts', body: { openingCash: 1000 } });
  assert.equal(opened.status, 201);
  assert.equal(Number(opened.data.openingCash), 1000, 'opening float is persisted through the shift API');
  const shiftId = opened.data.id;
  const openingRead = await callShiftApi({ path: '/api/shifts', method: 'GET' });
  assert.equal(openingRead.status, 200);
  assert.equal(openingRead.data.current.id, shiftId, 'shift list rereads the newly opened shift from PostgreSQL');
  assert.equal(openingRead.data.current.openedByName, 'Cash QA', 'management sees who opened the current shift');
  const staffOpeningRead = await callShiftApi({ path: '/api/shifts', method: 'GET', role: 'bartender' });
  assert.equal(staffOpeningRead.data.current.id, shiftId, 'operational staff can still see whether a shift is open');
  assert.equal(Object.hasOwn(staffOpeningRead.data.current, 'openedByName'), false, 'operational staff do not receive the manager-only opener identity');

  const missingChecklist = await callShiftApi({ path: `/api/shifts/${shiftId}/close`, body: { closingCash: 1250 } });
  assert.equal(missingChecklist.status, 400);
  assert.equal(missingChecklist.data.error, 'shift_checklist_required');
  assert.equal((await setup.query('SELECT closed_at FROM shifts WHERE id=$1', [shiftId])).rows[0].closed_at, null,
    'a failed checklist validation does not change the open shift');

  const payment = await callPaymentApi({ path: `/api/orders/${orderId}/payments`, body: { amount: 300, method: 'cash' } });
  assert.equal(payment.status, 201, JSON.stringify(payment));
  assert.equal(payment.data.closed, true, 'full payment closes the sale');
  assert.equal(payment.data.shiftId, shiftId, 'payment API attributes cash to the active shift');
  const persistedOrder = await setup.query('SELECT status,closed_in_shift_id FROM orders WHERE id=$1', [orderId]);
  assert.equal(persistedOrder.rows[0].status, 'closed');
  assert.equal(persistedOrder.rows[0].closed_in_shift_id, shiftId);
  const persistedPayment = await setup.query('SELECT method,amount,status,shift_id FROM payments WHERE order_id=$1', [orderId]);
  assert.equal(persistedPayment.rowCount, 1);
  assert.equal(Number(persistedPayment.rows[0].amount), 300);
  assert.equal(persistedPayment.rows[0].shift_id, shiftId);

  guestId = (await setup.query("INSERT INTO guests (venue_id,full_name) VALUES ($1,'Refund cash QA guest') RETURNING id", [venueId])).rows[0].id;
  const cashRefundSource = (await setup.query("INSERT INTO guest_account_entries (venue_id,guest_id,account_type,amount,reason,source_type,source_key) VALUES ($1,$2,'deposit',30,'QA original deposit','deposit_top_up','shift-qa-cash-source') RETURNING id", [venueId, guestId])).rows[0].id;
  const nonCashRefundSource = (await setup.query("INSERT INTO guest_account_entries (venue_id,guest_id,account_type,amount,reason,source_type,source_key) VALUES ($1,$2,'deposit',10,'QA card deposit','deposit_top_up','shift-qa-card-source') RETURNING id", [venueId, guestId])).rows[0].id;
  await setup.query("INSERT INTO guest_account_reversals (venue_id,guest_id,source_entry_id,shift_id,account_type,amount,payout_method,reason,idempotency_key,actor_id) VALUES ($1,$2,$3,$4,'deposit',30,'cash','QA cash payout','shift-qa-cash-reversal',$5),($1,$2,$6,$4,'deposit',10,'card','QA card return','shift-qa-card-reversal',$5)", [venueId, guestId, cashRefundSource, shiftId, userId, nonCashRefundSource]);

  const closed = await callShiftApi({ path: `/api/shifts/${shiftId}/close`, body: { closingCash: 1250, checklistConfirmed: true } });
  assert.equal(closed.status, 200);
  assert.equal(Number(closed.data.openingCash), 1000);
  assert.equal(Number(closed.data.expectedCash), 1270, 'expected cash subtracts a cash refund from the actual payout shift, while a card refund does not change cash');
  assert.equal(Number(closed.data.closingCash), 1250);
  assert.equal(Number(closed.data.cashVariance), -20, 'cash shortage is persisted as actual minus cash after the refund outflow');

  const finalShift = await setup.query('SELECT closed_at,opening_cash,expected_cash,closing_cash,cash_variance FROM shifts WHERE id=$1', [shiftId]);
  assert.ok(finalShift.rows[0].closed_at);
  assert.equal(Number(finalShift.rows[0].expected_cash), 1270);
  assert.equal(Number(finalShift.rows[0].cash_variance), -20);
  const repeatClose = await callShiftApi({ path: `/api/shifts/${shiftId}/close`, body: { closingCash: 1250, checklistConfirmed: true } });
  assert.equal(repeatClose.status, 404, 'a closed shift cannot be reconciled or closed a second time');

  console.log('SHIFT CASH POSTGRES E2E QA: PASS (opening float→sale/payment API→shift attribution→expected cash→required checklist→actual cash/variance→closed read; invalid checklist and repeated close rejected)');
} finally {
  await pool.end();
  if (setup._connected) {
    if (venueId) {
      await setup.query('DELETE FROM guest_account_reversals WHERE venue_id=$1', [venueId]).catch(() => {});
      await setup.query('DELETE FROM guest_account_entries WHERE venue_id=$1', [venueId]).catch(() => {});
      await setup.query('DELETE FROM guests WHERE venue_id=$1', [venueId]).catch(() => {});
      await setup.query('DELETE FROM payments WHERE order_id IN (SELECT id FROM orders WHERE venue_id=$1)', [venueId]).catch(() => {});
      await setup.query('DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE venue_id=$1)', [venueId]).catch(() => {});
      await setup.query('DELETE FROM orders WHERE venue_id=$1', [venueId]).catch(() => {});
      await setup.query('DELETE FROM shifts WHERE venue_id=$1', [venueId]).catch(() => {});
      if (productId) await setup.query('DELETE FROM products WHERE id=$1', [productId]).catch(() => {});
      if (userId) await setup.query('DELETE FROM users WHERE id=$1', [userId]).catch(() => {});
      await setup.query('DELETE FROM venues WHERE id=$1', [venueId]).catch(() => {});
    }
    await setup.end();
  }
}
