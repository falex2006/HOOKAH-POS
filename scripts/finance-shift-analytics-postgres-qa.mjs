import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const databaseUrl = process.env.MIGRATIONS_PG_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('Set MIGRATIONS_PG_TEST_DATABASE_URL to an isolated PostgreSQL QA database');
assert.match(new URL(databaseUrl).pathname, /(?:test|qa|scratch)/i,
  'refusing writes unless the database name clearly identifies test/QA/scratch');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { Client } = require('pg');
const { validateQaDatabaseUrl, assertQaDatabaseIdentity } = await import('./postgres-qa-safety.mjs');
const { database } = validateQaDatabaseUrl(databaseUrl, 'MIGRATIONS_PG_TEST_DATABASE_URL');
const client = new Client({ connectionString: databaseUrl });
const venueId = randomUUID();
const ownerId = randomUUID();
const guestId = randomUUID();
const reservationId = randomUUID();
const depositSourceEntryId = randomUUID();
const productOrderAmounts = [100, 100, 900];
const splitOrderId = randomUUID();
const productIds = [];
let server;
let serverExitPromise;
let output = '';
let baseUrl = '';

const request = async (route) => {
  const response = await fetch(`${baseUrl}${route}`);
  const payload = await response.json().catch(() => ({}));
  assert.equal(response.status, 200, `${route} responds successfully: ${JSON.stringify(payload)}`);
  return payload;
};

try {
  await client.connect();
  const identity = await client.query(`SELECT current_database() AS database,
    inet_server_addr()::text AS address, inet_server_port() AS port,
    (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser`);
  assertQaDatabaseIdentity(identity.rows[0], database, Number(new URL(databaseUrl).port || 5432),
    'Finance shift/analytics QA database');
  await client.query("INSERT INTO venues (id,name,timezone) VALUES ($1,'Finance shift/median QA','Asia/Yekaterinburg')", [venueId]);
  await client.query("INSERT INTO users (id,venue_id,full_name,login,role) VALUES ($1::uuid,$2::uuid,'Finance QA','finance-shift-qa-' || $1::text,'owner')", [ownerId, venueId]);
  await client.query("INSERT INTO guests (id,venue_id,phone,full_name) VALUES ($1,$2,'+79990000001','Finance ledger QA guest')", [guestId, venueId]);
  await client.query("INSERT INTO reservations (id,venue_id,guest_id,starts_at,ends_at,status) VALUES ($1,$2,$3,now()+INTERVAL '1 day',now()+INTERVAL '2 days','new')", [reservationId, venueId, guestId]);
  const shiftA = (await client.query(`INSERT INTO shifts (venue_id,opened_by,opened_at,closed_at,opening_cash)
    VALUES ($1,$2,now()-INTERVAL '2 hours',now()-INTERVAL '30 minutes',0) RETURNING id`, [venueId, ownerId])).rows[0].id;
  const shiftB = (await client.query(`INSERT INTO shifts (venue_id,opened_by,opened_at,opening_cash)
    VALUES ($1,$2,now()-INTERVAL '20 minutes',0) RETURNING id`, [venueId, ownerId])).rows[0].id;

  const barProductId = randomUUID(); const hookahProductId = randomUUID(); productIds.push(barProductId, hookahProductId);
  await client.query(`INSERT INTO products (id,venue_id,name,category,sale_price)
    VALUES ($1,$3,'QA лимонад','bar',200),($2,$3,'QA кальян','hookah',300)`, [barProductId, hookahProductId, venueId]);

  for (const amount of productOrderAmounts) {
    const orderId = randomUUID();
    await client.query(`INSERT INTO orders (id,venue_id,opened_by,status,closed_at,closed_in_shift_id)
      VALUES ($1,$2,$3,'closed',now(),$4)`, [orderId, venueId, ownerId, shiftA]);
    await client.query(`INSERT INTO payments (order_id,method,amount,status,shift_id)
      VALUES ($1,'cash',$2,'paid',$3)`, [orderId, amount, shiftA]);
    await client.query(`INSERT INTO order_items (order_id,product_id,quantity,unit_price,station)
      VALUES ($1,$2,1,$3,'bar')`, [orderId, barProductId, amount]);
  }

  await client.query(`INSERT INTO orders (id,venue_id,opened_by,status,closed_at,closed_in_shift_id)
    VALUES ($1,$2,$3,'closed',now(),$4)`, [splitOrderId, venueId, ownerId, shiftB]);
  await client.query(`INSERT INTO payments (order_id,method,amount,status,shift_id)
    VALUES ($1,'cash',100,'partially_paid',$2),($1,'cash',200,'paid',$3)`, [splitOrderId, shiftA, shiftB]);
  await client.query(`INSERT INTO order_items (order_id,product_id,quantity,unit_price,station)
    VALUES ($1,$2,1,200,'bar'),($1,$3,1,300,'hookah')`, [splitOrderId, barProductId, hookahProductId]);
  await client.query(`INSERT INTO discounts (order_id,requested_by,approved_by,type,value,reason,status)
    VALUES ($1,$2,$2,'fixed',200,'Finance report allocation QA','approved')`, [splitOrderId, ownerId]);

  server = spawn(process.execPath, ['server.js'], {
    cwd: root,
    windowsHide: true,
    env: {
      ...process.env,
      HOST: '127.0.0.1', PORT: '0', DATABASE_URL: databaseUrl, VENUE_ID: venueId,
      AUTH_REQUIRED: 'false', COOKIE_SECURE: 'false', NODE_ENV: 'test', API_RATE_LIMIT: '5000',
      PGOPTIONS: '-c timezone=UTC',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverExitPromise = new Promise((resolve) => server.once('exit', resolve));
  server.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
  server.stderr.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
  const until = Date.now() + 20000;
  while (!baseUrl && Date.now() < until) {
    const match = output.match(/CRM running on http:\/\/localhost:(\d+)/);
    if (match) baseUrl = `http://127.0.0.1:${match[1]}`;
    else if (server.exitCode !== null) throw new Error(`isolated PostgreSQL API failed to start: ${output}`);
    else await delay(50);
  }
  assert.ok(baseUrl, `isolated PostgreSQL API starts: ${output}`);

  const summary = await request('/api/finance/summary');
  assert.equal(summary.currentShiftOrders, 1, 'the current-shift denominator is tied to closed_in_shift_id');
  assert.equal(summary.currentShiftAverageCheck, 300,
    'the average check for an order closed in shift B includes both payments made across shifts');

  const analytics = await request('/api/analytics?days=7');
  assert.equal(analytics.totalRevenue, 1400, 'period turnover includes every paid payment exactly once');
  assert.equal(analytics.averageCheck, 350, 'average check remains the arithmetic mean');
  assert.equal(analytics.medianCheck, 200, 'the period median is calculated from the four individual checks');
  const businessToday = analytics.days.find((day) => day.orders === 4);
  assert.ok(businessToday, 'the fixture orders are grouped under the venue-local business date');
  assert.equal(businessToday.medianCheck, 200, 'daily median is calculated from individual orders too');
  assert.equal(analytics.byStation.bar.revenue, 1220, 'undiscounted bar sales plus the approved discount allocation reconcile');
  assert.equal(analytics.byStation.hookah.revenue, 180, 'the approved fixed discount is allocated proportionally to the hookah line');
  assert.equal(Object.values(analytics.byStation).reduce((sum, row) => sum + row.revenue, 0), 1400,
    'station breakdown reconciles exactly to all collected revenue');
  const staff = analytics.staffSales.find((row) => row.name === 'Finance QA');
  assert.equal(staff.revenue, 1400, 'staff total equals actual collected revenue for the period');
  assert.equal(staff.items.reduce((sum, row) => sum + row.revenue, 0), 1400,
    'employee product lines allocate the discounted amount and reconcile to collected revenue');
  const mixedTenderOrderId = randomUUID();
  await client.query(`INSERT INTO orders (id,venue_id,opened_by,status,closed_at,closed_in_shift_id,pricing_version,subtotal_snapshot,discount_total_snapshot,minimum_adjustment_snapshot,final_total_snapshot)
    VALUES ($1,$2,$3,'closed',now(),$4,1,900,0,0,900)`, [mixedTenderOrderId, venueId, ownerId, shiftB]);
  await client.query(`INSERT INTO payments (order_id,method,amount,status,created_at)
    VALUES ($1,'cash',300,'paid',now()-INTERVAL '1 day'),($1,'bonus',600,'paid',now())`, [mixedTenderOrderId]);
  await client.query(`INSERT INTO order_items (order_id,product_id,quantity,unit_price,station)
    VALUES ($1,$2,1,900,'bar')`, [mixedTenderOrderId, barProductId]);
  const report = await request('/api/finance/report?type=waiter');
  assert.equal(report.revenue, 2300, 'daily report revenue is the recognized value of closed sales');
  assert.equal(report.sales.net, 2300, 'recognized sales are derived from order snapshots or the persisted legacy fallback');
  assert.equal(report.sales.orders, 5, 'sales count is based on closed orders');
  assert.equal(report.receipts.total, 1400, 'receipt ledger excludes non-cash loyalty tender and uses payment event time');
  assert.equal(report.receipts.byMethod.cash, 1400, 'receipt methods contain actual monetary payments');
  assert.equal(report.receipts.bySource.order_payment, 1400, 'receipt sources identify order payments');
  assert.equal(report.staffAttribution, 'order_opener', 'the report names its current employee attribution source explicitly');
  assert.equal(report.byStation.bar, 2120);
  assert.equal(report.byStation.hookah, 180);
  assert.equal(report.byStaff['Finance QA'], 2300, 'waiter breakdown matches recognized sales');

  const priorDate = new Date(`${new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Yekaterinburg',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date())}T00:00:00Z`);
  priorDate.setUTCDate(priorDate.getUTCDate()-1);
  const priorDateKey = priorDate.toISOString().slice(0,10);
  const priorDayReport = await request(`/api/finance/report?date=${priorDateKey}&type=x`);
  assert.equal(priorDayReport.sales.net, 0, 'a payment from the prior day does not move the sale away from its close date');
  assert.equal(priorDayReport.receipts.total, 300, 'cash receipt is reported on its actual event date independently from sale date');

  // A 100%-discounted closed check has no payment row. The report must derive
  // its zero total from persisted order items and the approved discount rather
  // than treating a missing payment as gross revenue.
  const zeroOrderId = randomUUID(); const zeroProductId = randomUUID(); productIds.push(zeroProductId);
  await client.query(`INSERT INTO products (id,venue_id,name,category,sale_price)
    VALUES ($1,$2,'QA zero-paid check','bar',500)`, [zeroProductId, venueId]);
  await client.query(`INSERT INTO orders (id,venue_id,opened_by,status,closed_at,closed_in_shift_id)
    VALUES ($1,$2,$3,'closed',now(),$4)`, [zeroOrderId, venueId, ownerId, shiftA]);
  await client.query(`INSERT INTO order_items (order_id,product_id,quantity,unit_price,station)
    VALUES ($1,$2,1,500,'bar')`, [zeroOrderId, zeroProductId]);
  await client.query(`INSERT INTO discounts (order_id,requested_by,approved_by,type,value,reason,status)
    VALUES ($1,$2,$2,'percent',100,'Finance zero-total regression QA','approved')`, [zeroOrderId, ownerId]);
  const zeroTotalReport = await request('/api/finance/report?type=waiter');
  assert.equal(zeroTotalReport.revenue, 2300, 'the fully discounted zero-total order contributes no recognized sales');
  assert.equal(zeroTotalReport.sales.net, 2300, 'recognized sales include the snapshot-backed order exactly once');
  assert.equal(zeroTotalReport.receipts.total, 1400, 'zero-total and loyalty tender do not create cash receipts');
  assert.equal(zeroTotalReport.byStaff['Finance QA'], 2300, 'the sales breakdown reconciles to recognized sales');
  assert.equal(zeroTotalReport.byStation.bar, 2120, 'station sales allocate the snapshot-backed order while excluding bonus tender');
  assert.equal(zeroTotalReport.byStation.hookah, 180);
  const zeroTotalSummary = await request('/api/finance/summary');
  assert.equal(zeroTotalSummary.revenue, 2300, 'finance summary total uses recognized closed sales like the detailed report');
  assert.equal(zeroTotalSummary.sales.net, zeroTotalReport.sales.net, 'summary and report reconcile their close-date sales on the same fixture');
  assert.equal(zeroTotalSummary.receipts.total, zeroTotalReport.receipts.total, 'summary and report reconcile event-date cash receipts on the same fixture');
  assert.equal(zeroTotalSummary.receipts.coverage, 'postgres_order_payments_and_guest_receipts', 'summary discloses receipt source coverage');

  await client.query(`INSERT INTO guest_deposit_receipts (venue_id,guest_id,shift_id,amount,payment_method,reason,idempotency_key,actor_id)
    VALUES ($1,$2,$3,100,'qr','Finance QA guest top-up','finance-ledger-topup-001',$4)`, [venueId, guestId, shiftB, ownerId]);
  await client.query(`INSERT INTO guest_account_entries (id,venue_id,guest_id,account_type,amount,reason,source_type,source_key,actor_id)
    VALUES ($1,$2,$3,'deposit',100,'Finance QA guest top-up','deposit_top_up','finance-ledger-topup-entry-001',$4)`, [depositSourceEntryId, venueId, guestId, ownerId]);
  await client.query(`INSERT INTO guest_account_reversals (venue_id,guest_id,source_entry_id,shift_id,account_type,amount,payout_method,reason,idempotency_key,actor_id)
    VALUES ($1,$2,$3,$4,'deposit',30,'cash','Finance QA deposit refund','finance-ledger-deposit-refund-001',$5)`, [venueId, guestId, depositSourceEntryId, shiftB, ownerId]);
  await client.query(`INSERT INTO reservation_pre_payment_receipts (venue_id,reservation_id,shift_id,amount,payment_method,reason,idempotency_key,actor_id,created_at)
    VALUES ($1,$2,$3,200,'card','Finance QA reservation prepayment','finance-ledger-prepay-001',$4,((timezone('Asia/Yekaterinburg',now())::date-1)::timestamp+time '12:00') AT TIME ZONE 'Asia/Yekaterinburg') RETURNING id`, [venueId, reservationId, shiftA, ownerId]).then(async ({ rows }) => {
      await client.query(`INSERT INTO reservation_pre_payment_receipt_reversals (venue_id,reservation_id,receipt_id,shift_id,amount,payout_method,reason,idempotency_key,actor_id)
        VALUES ($1,$2,$3,$4,50,'card','Finance QA prepayment refund','finance-ledger-prepay-refund-001',$5)`, [venueId, reservationId, rows[0].id, shiftB, ownerId]);
    });
  const ledgerToday = await request('/api/finance/report?type=x');
  assert.equal(ledgerToday.receipts.total, 1500, 'event-date receipts include POS cash plus actual guest-account top-ups');
  assert.equal(ledgerToday.receipts.bySource.guest_account_top_up, 100);
  assert.equal(ledgerToday.receipts.byMethod.qr, 100);
  assert.equal(ledgerToday.payouts.total, 80, 'event-date payouts include guest deposit and reservation prepayment refunds');
  assert.equal(ledgerToday.payouts.bySource.guest_account_refund, 30);
  assert.equal(ledgerToday.payouts.bySource.reservation_prepayment_refund, 50);
  assert.equal(ledgerToday.payouts.byMethod.cash, 30);
  assert.equal(ledgerToday.payouts.byMethod.card, 50);
  const ledgerSummary = await request('/api/finance/summary');
  assert.equal(ledgerSummary.revenue, ledgerToday.sales.net, 'summary sales stay aligned after liability receipts and refunds are added');
  assert.equal(ledgerSummary.receipts.total, ledgerToday.receipts.total, 'summary receipt total matches all event-date sources');
  assert.equal(ledgerSummary.receipts.bySource.guest_account_top_up, 100);
  assert.equal(ledgerSummary.receipts.bySource.reservation_prepayment, undefined, 'prior-date reservation prepayment does not leak into today\'s summary');
  assert.equal(ledgerSummary.payouts.total, ledgerToday.payouts.total, 'summary payouts match both supported refund journals');
  const priorLedgerDay = await request(`/api/finance/report?date=${priorDateKey}&type=x`);
  assert.equal(priorLedgerDay.receipts.bySource.reservation_prepayment, 200, 'reservation prepayment uses its own event date');

  console.log('FINANCE SHIFT/ANALYTICS POSTGRES QA: PASS (sale snapshots vs event-date cash receipts, bonus tender exclusion, legacy fallbacks, shift attribution, medians, station allocation, zero-total discount)');
} catch (error) {
  console.error('FINANCE SHIFT/ANALYTICS POSTGRES QA failed before cleanup:', error);
  throw error;
} finally {
  if (server && server.exitCode === null && server.signalCode === null) server.kill();
  if (serverExitPromise && server?.exitCode === null && server?.signalCode === null) await serverExitPromise;
  if (client._connected) {
    try {
      await client.query('DELETE FROM reservation_pre_payment_receipt_reversals WHERE venue_id=$1', [venueId]);
      await client.query('DELETE FROM reservation_pre_payment_receipts WHERE venue_id=$1', [venueId]);
      await client.query('DELETE FROM guest_account_reversals WHERE venue_id=$1', [venueId]);
      await client.query('DELETE FROM guest_account_entries WHERE venue_id=$1', [venueId]);
      await client.query('DELETE FROM guest_deposit_receipts WHERE venue_id=$1', [venueId]);
      await client.query('DELETE FROM reservations WHERE venue_id=$1', [venueId]);
      await client.query('DELETE FROM guests WHERE venue_id=$1', [venueId]);
      await client.query('DELETE FROM payments WHERE order_id IN (SELECT id FROM orders WHERE venue_id=$1)', [venueId]);
      await client.query('DELETE FROM discounts WHERE order_id IN (SELECT id FROM orders WHERE venue_id=$1)', [venueId]);
      await client.query('DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE venue_id=$1)', [venueId]);
      await client.query('DELETE FROM orders WHERE venue_id=$1', [venueId]);
      if (productIds.length) await client.query('DELETE FROM products WHERE id=ANY($1::uuid[])', [productIds]);
      await client.query('DELETE FROM shifts WHERE venue_id=$1', [venueId]);
      await client.query('DELETE FROM users WHERE venue_id=$1', [venueId]);
      await client.query('DELETE FROM audit_events WHERE venue_id=$1', [venueId]);
      const deletedVenue = await client.query('DELETE FROM venues WHERE id=$1 RETURNING id', [venueId]);
      assert.equal(deletedVenue.rowCount, 1, 'finance report QA venue is fully removed');
    } finally { await client.end(); }
  }
}
