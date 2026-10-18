import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import shiftCloseContract from '../shift-close-contract.js';
import { PurchaseDocumentRepository } from '../db.js';
import { writePosOrderIncomeCategorySnapshot } from '../finance-income.js';

const databaseUrl = process.env.MIGRATIONS_PG_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('Set MIGRATIONS_PG_TEST_DATABASE_URL to an isolated PostgreSQL test database');
assert.match(new URL(databaseUrl).pathname, /(?:test|qa|scratch)/i,
  'refusing test writes unless the database name clearly identifies a test/QA/scratch database');

const require = createRequire(import.meta.url);
const { Client, Pool } = require('pg');
const { orderPricingSqlCtes } = require('../pos-order-pricing-sql');
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
const shiftCashSummaryStart = server.indexOf('async function getShiftCashSummary(');
const shiftCashSummaryEnd = server.indexOf('\n}', shiftCashSummaryStart) + 2;
const closeLedgerStart = server.indexOf('async function captureShiftCloseLedger(');
const closeLedgerEnd = server.indexOf('\n}', closeLedgerStart) + 2;
const moneyCentsStart = server.indexOf('const moneyCents =');
const moneyCentsEnd = server.indexOf('\n', moneyCentsStart);
const snapshotWriterStart = server.indexOf('async function writePosOrderPricingSnapshot(');
const snapshotWriterEnd = server.indexOf('\nconst pgOrderBalance', snapshotWriterStart);
assert.ok(shiftStart >= 0 && shiftEnd > shiftStart, 'shift open/close API handlers are available');
assert.ok(paymentStart >= 0 && paymentEnd > paymentStart, 'sale/payment API handler is available');
assert.ok(moneyCentsStart >= 0 && snapshotWriterStart > moneyCentsStart && snapshotWriterEnd > snapshotWriterStart,
  'current POS pricing snapshot writer and its money helper are available');
assert.ok(shiftCashSummaryStart >= 0 && shiftCashSummaryEnd > shiftCashSummaryStart,
  'cash preview and close use the current shared reconciliation summary');
assert.ok(closeLedgerStart >= 0 && closeLedgerEnd > closeLedgerStart && orderPricingSqlCtes.includes('canonical_totals AS'),
  'close snapshot can capture the closed sales and tender ledger');
const shiftRoute = server.slice(shiftStart, shiftEnd);
const paymentRoute = server.slice(paymentStart, paymentEnd);
const getShiftCashSummary = new Function(`${server.slice(shiftCashSummaryStart, shiftCashSummaryEnd)}\nreturn getShiftCashSummary;`)();
const captureShiftCloseLedger = new Function('orderPricingSqlCtes', `${server.slice(closeLedgerStart, closeLedgerEnd)}\nreturn captureShiftCloseLedger;`)(orderPricingSqlCtes);
const writePosOrderPricingSnapshot = new Function(
  `${server.slice(moneyCentsStart, moneyCentsEnd)}\n${server.slice(snapshotWriterStart, snapshotWriterEnd)}\nreturn writePosOrderPricingSnapshot;`,
)();
let venueId = null;
let otherVenueId = null;
let organizationId = null;
let userId = null;
let orderId = null;
let productId = null;
let guestId = null;
let shiftId = null;
let raceOrderId = null;
let raceProductId = null;
let unresolvedOrderId = null;
let unresolvedPaymentId = null;
const faultSuffix = String(process.pid).replace(/[^a-z0-9_]/gi, '_');
const snapshotFault = {
  table: 'shift_close_snapshots',
  trigger: `qa_${faultSuffix}_fail_snapshot_insert`,
  function: `qa_${faultSuffix}_fail_snapshot_insert_fn`,
  message: 'qa_injected_snapshot_insert_failure',
};
const auditFault = {
  table: 'audit_events',
  trigger: `qa_${faultSuffix}_fail_close_audit_insert`,
  function: `qa_${faultSuffix}_fail_close_audit_insert_fn`,
  message: 'qa_injected_close_audit_insert_failure',
};
const removeInsertFault = async (fault) => {
  await setup.query(`DROP TRIGGER IF EXISTS "${fault.trigger}" ON public."${fault.table}"`).catch(() => {});
  await setup.query(`DROP FUNCTION IF EXISTS public."${fault.function}"()`).catch(() => {});
};
const installInsertFault = async (fault, condition) => {
  assert.match(venueId, /^[0-9a-f-]{36}$/i, 'fault injection is scoped to the generated QA venue UUID');
  await setup.query(`CREATE FUNCTION public."${fault.function}"() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF ${condition} THEN RAISE EXCEPTION '${fault.message}' USING ERRCODE='P0001'; END IF;
      RETURN NEW;
    END;
  $$`);
  await setup.query(`CREATE TRIGGER "${fault.trigger}" BEFORE INSERT ON public."${fault.table}"
    FOR EACH ROW EXECUTE FUNCTION public."${fault.function}"()`);
};
const assertCloseRolledBack = async (label) => {
  const state = await setup.query('SELECT closed_at,closing_cash,expected_cash,cash_variance FROM shifts WHERE id=$1', [shiftId]);
  assert.equal(state.rows[0].closed_at, null, `${label}: the shift update rolled back`);
  assert.equal(state.rows[0].closing_cash, null, `${label}: the closing cash rolled back`);
  assert.equal(state.rows[0].expected_cash, null, `${label}: the expected cash rolled back`);
  assert.equal(state.rows[0].cash_variance, null, `${label}: the cash variance rolled back`);
  const snapshots = await setup.query('SELECT COUNT(*)::int AS count FROM shift_close_snapshots WHERE venue_id=$1 AND shift_id=$2', [venueId, shiftId]);
  assert.equal(snapshots.rows[0].count, 0, `${label}: no partial close snapshot remains`);
  const audit = await setup.query("SELECT COUNT(*)::int AS count FROM audit_events WHERE venue_id=$1 AND action='shift.closed' AND entity_type='shift' AND entity_id=$2", [venueId, shiftId]);
  assert.equal(audit.rows[0].count, 0, `${label}: no partial close audit event remains`);
};

const callShiftApi = async ({ path, method = 'POST', body = {}, role = 'owner', actorId = userId, venueDbId = venueId }) => {
  let response;
  const pathname = path;
  const result = await new Function('pathname','req','res','repositories','venueDbId','denyUnlessAny','body','json','recordAudit','shifts','isOperationalEmployee','hasPermission','getShiftCashSummary','shiftCloseContract','captureShiftCloseLedger','crypto',
    `${validShiftCashSource}\nreturn (async()=>{${shiftRoute}})();`)(
    pathname, { method, headers: {}, user: { id: actorId, name: 'Cash QA', role } }, {}, { pool, audit: { record: async () => {} } }, venueDbId,
    () => false, async () => body, (_res, status, data) => { response = { status, data }; return response; }, () => {}, [], () => false,
    (_req, permission) => (permission === 'finance_read' && ['owner','admin','manager','developer'].includes(role)) || (['floor','orders'].includes(permission) && role !== 'stranger'), getShiftCashSummary,
    shiftCloseContract, captureShiftCloseLedger, { createHash },
  );
  return response || result;
};

const callPaymentApi = async ({ path, method = 'POST', body = {} }) => {
  let response;
  const pathname = path;
  const result = await new Function('pathname','req','res','repositories','venueDbId','denyUnless','body','json','recordAudit','requireOpenShift','orders','scaleBatchRecipeIngredients','depleteRecipeForOrder','approvedDiscountTotal','orderTotal','validPaymentAmount','roundMoney','orderBalanceConflict','moneyCents','pgOrderPricing','accrueGuestOrderBonus','writePosOrderPricingSnapshot','writePosOrderIncomeCategorySnapshot',
    `return (async()=>{${paymentRoute}})();`)(
    pathname, { method, headers: {}, user: { id: userId, name: 'Cash QA', role: 'owner' } }, {}, { pool, audit: { record: async () => {} } }, venueId,
    () => false, async () => body, (_res, status, data) => { response = { status, data }; return response; }, () => {},
    async () => false, [], () => [], async () => ({ lines: [], totalCost: 0 }), () => 0, () => 0,
    (value) => Number.isFinite(value) && value > 0 && Math.abs(value * 100 - Math.round(value * 100)) < 1e-7,
    (value) => Math.round(Number(value) * 100) / 100,
    ({ due, paid }) => Math.round(Number(paid) * 100) > Math.round(Number(due) * 100),
    (value) => Math.round(Number(value) * 100),
    async (client, id, minimum = 0) => { const items = await client.query('SELECT oi.id AS "orderItemId",oi.product_id AS "productId",oi.quantity,oi.unit_price AS "unitPrice",oi.station,oi.sales_employee_id AS "sellerId",oi.sold_at::text AS "soldAt",p.name AS "productName",p.category,p.is_active AS "productActive" FROM order_items oi LEFT JOIN products p ON p.id=oi.product_id WHERE oi.order_id=$1 ORDER BY oi.id', [id]); const payments = await client.query("SELECT COALESCE(SUM(amount),0) AS amount FROM payments WHERE order_id=$1 AND status IN ('paid','partially_paid')", [id]); const lineAllocations = items.rows.map((item) => { const grossCents = Math.round(Number(item.quantity) * Number(item.unitPrice) * 100); return { orderItemId: item.orderItemId, grossCents, discountCents: 0, netCents: grossCents, eligibleForSelectedOffer: false }; }); const subtotal = lineAllocations.reduce((sum, line) => sum + line.grossCents, 0) / 100; const due = Math.max(subtotal, Number(minimum || 0)); return { subtotal, discount: 0, net: subtotal, due, paid: Number(payments.rows[0]?.amount || 0), minimumAdjustment: due - subtotal, source: 'none', groupDiscountAmount: null, groupDiscountGroupId: null, groupDiscountName: null, groupDiscountPercent: null, groupDiscountBase: null, offers: [], pricingInputs: {}, pricingLines: items.rows, lineAllocations, lineSnapshotStatus: 'complete' }; },
    async () => ({ base: 0, percent: 0, earned: 0, balance: null }),
    writePosOrderPricingSnapshot,writePosOrderIncomeCategorySnapshot,
  );
  return response || result;
};

try {
  await setup.connect();
  venueId = (await setup.query("INSERT INTO venues (name,timezone) VALUES ('Isolated shift cash E2E QA','Asia/Yekaterinburg') RETURNING id")).rows[0].id;
  otherVenueId = (await setup.query("INSERT INTO venues (name,timezone) VALUES ('Isolated shift cash foreign venue QA','Asia/Yekaterinburg') RETURNING id")).rows[0].id;
  organizationId=(await setup.query("INSERT INTO organizations(name,slug) VALUES('Shift cash E2E QA',$1) RETURNING id",[`shift-cash-qa-${process.pid}`])).rows[0].id;
  await setup.query('UPDATE venues SET organization_id=$1 WHERE id=$2',[organizationId,venueId]);
  userId = (await setup.query(`INSERT INTO users (venue_id,full_name,login,role)
    VALUES ($1,'Cash QA','shift-cash-qa-${process.pid}','owner') RETURNING id`, [venueId])).rows[0].id;
  productId = (await setup.query("INSERT INTO products (venue_id,name,category,sale_price) VALUES ($1,'QA order','bar',300) RETURNING id", [venueId])).rows[0].id;
  orderId = (await setup.query("INSERT INTO orders (venue_id,opened_by,status) VALUES ($1,$2,'open') RETURNING id", [venueId, userId])).rows[0].id;
  await setup.query('INSERT INTO order_items (order_id,product_id,quantity,unit_price) VALUES ($1,$2,1,300)', [orderId, productId]);

  const opened = await callShiftApi({ path: '/api/shifts', body: { openingCash: 1000 } });
  assert.equal(opened.status, 201);
  assert.equal(Number(opened.data.openingCash), 1000, 'opening float is persisted through the shift API');
  shiftId = opened.data.id;
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

  unresolvedOrderId = (await setup.query("INSERT INTO orders (venue_id,opened_by,status,closed_at) VALUES ($1,$2,'closed',now()) RETURNING id", [venueId, userId])).rows[0].id;
  await setup.query('ALTER TABLE payments DISABLE TRIGGER payments_finance_account_guard');
  try { unresolvedPaymentId = (await setup.query("INSERT INTO payments (order_id,method,amount,status,shift_id,created_at) VALUES ($1,'cash',40,'paid',NULL,now()) RETURNING id", [unresolvedOrderId])).rows[0].id; }
  finally { await setup.query('ALTER TABLE payments ENABLE TRIGGER payments_finance_account_guard'); }
  const unresolvedPreview = await callShiftApi({ path: '/api/shifts', method: 'GET' });
  assert.equal(unresolvedPreview.data.current.expectedCash, null, 'an unattributed legacy cash payment makes the provisional expected total unavailable');
  assert.equal(unresolvedPreview.data.current.unresolvedLegacyCashCount, 1);
  assert.equal(unresolvedPreview.data.current.unresolvedLegacyCashAmount, 40);
  const blockedClose = await callShiftApi({ path: `/api/shifts/${shiftId}/close`, body: { closingCash: 1040, checklist: { version: 1, items: { ordersReviewed: true, cashCounted: true, inventoryReviewed: true, externalFiscalReportsHandled: true } } } });
  assert.equal(blockedClose.status, 409);
  assert.equal(blockedClose.data.error, 'shift_cash_attribution_unresolved', 'the same legacy-cash evidence blocks authoritative close');
  assert.equal((await setup.query('SELECT closed_at FROM shifts WHERE id=$1', [shiftId])).rows[0].closed_at, null);
  await setup.query('DELETE FROM payments WHERE id=$1', [unresolvedPaymentId]); unresolvedPaymentId = null;
  await setup.query('DELETE FROM orders WHERE id=$1', [unresolvedOrderId]); unresolvedOrderId = null;

  const posCashbox=(await setup.query("SELECT id,name FROM finance_accounts WHERE venue_id=$1 AND code='main_cashbox' AND active=true",[venueId])).rows[0];
  const fundingReceiptDocumentId=(await setup.query(`INSERT INTO finance_funding_documents(venue_id,document_type,counterparty_name,basis,idempotency_key,request_sha256,created_by) VALUES($1,'owner_contribution','QA owner','shift cash receipt',$2,repeat('a',64),$3) RETURNING id`,[venueId,randomUUID(),userId])).rows[0].id;
  const fundingReceiptEventId=(await setup.query(`INSERT INTO finance_funding_events(venue_id,document_id,event_type,amount,event_date,finance_account_id,finance_account_name_snapshot,payment_method,shift_id,idempotency_key,request_sha256,created_by) VALUES($1,$2,'owner_contribution_received',50,(now() AT TIME ZONE 'Asia/Yekaterinburg')::date,$3,$4,'cash',$5,$6,repeat('b',64),$7) RETURNING id`,[venueId,fundingReceiptDocumentId,posCashbox.id,posCashbox.name,shiftId,randomUUID(),userId])).rows[0].id;
  const fundingBank=(await setup.query("INSERT INTO finance_accounts(venue_id,code,name,kind,allowed_payment_methods,created_by) VALUES($1,$2,'QA funding bank','bank',ARRAY['bank_transfer']::text[],$3) RETURNING id,name",[venueId,`funding_bank_${process.pid}`,userId])).rows[0];
  const posToBankTransferId=(await setup.query(`INSERT INTO finance_account_transfers(venue_id,amount,transfer_date,from_account_id,from_account_name_snapshot,to_account_id,to_account_name_snapshot,shift_id,note,idempotency_key,request_sha256,created_by) VALUES($1,20,(now() AT TIME ZONE 'Asia/Yekaterinburg')::date,$2,$3,$4,$5,$6,'Move POS cash to bank',$7,repeat('a',64),$8) RETURNING id`,[venueId,posCashbox.id,posCashbox.name,fundingBank.id,fundingBank.name,shiftId,randomUUID(),userId])).rows[0].id;
  const loanDocumentId=(await setup.query(`INSERT INTO finance_funding_documents(venue_id,document_type,counterparty_name,basis,principal_limit,idempotency_key,request_sha256,created_by) VALUES($1,'loan','QA lender','shift cash repayment',10,$2,repeat('c',64),$3) RETURNING id`,[venueId,randomUUID(),userId])).rows[0].id;
  await setup.query(`INSERT INTO finance_funding_events(venue_id,document_id,event_type,amount,event_date,finance_account_id,finance_account_name_snapshot,payment_method,idempotency_key,request_sha256,created_by) VALUES($1,$2,'loan_principal_received',10,(now() AT TIME ZONE 'Asia/Yekaterinburg')::date,$3,$4,'bank_transfer',$5,repeat('d',64),$6)`,[venueId,loanDocumentId,fundingBank.id,fundingBank.name,randomUUID(),userId]);
  const fundingRepaymentEventId=(await setup.query(`INSERT INTO finance_funding_events(venue_id,document_id,event_type,amount,event_date,finance_account_id,finance_account_name_snapshot,payment_method,shift_id,idempotency_key,request_sha256,created_by) VALUES($1,$2,'loan_principal_repaid',5,(now() AT TIME ZONE 'Asia/Yekaterinburg')::date,$3,$4,'cash',$5,$6,repeat('e',64),$7) RETURNING id`,[venueId,loanDocumentId,posCashbox.id,posCashbox.name,shiftId,randomUUID(),userId])).rows[0].id;
  const payment = await callPaymentApi({ path: `/api/orders/${orderId}/payments`, body: { amount: 300, method: 'cash',paymentAccountId:posCashbox.id,idempotencyKey:'shift-e2e-pos-cash-001' } });
  assert.equal(payment.status, 201, JSON.stringify(payment));
  assert.equal(payment.data.closed, true, 'full payment closes the sale');
  assert.equal(payment.data.shiftId, shiftId, 'payment API attributes cash to the active shift');
  const persistedOrder = await setup.query('SELECT status,closed_in_shift_id FROM orders WHERE id=$1', [orderId]);
  assert.equal(persistedOrder.rows[0].status, 'closed');
  assert.equal(persistedOrder.rows[0].closed_in_shift_id, shiftId);
  const persistedPayment = await setup.query('SELECT method,amount,status,shift_id,finance_account_id,finance_account_name_snapshot FROM payments WHERE order_id=$1', [orderId]);
  assert.equal(persistedPayment.rowCount, 1);
  assert.equal(Number(persistedPayment.rows[0].amount), 300);
  assert.equal(persistedPayment.rows[0].shift_id, shiftId);
  assert.equal(persistedPayment.rows[0].finance_account_id,posCashbox.id);
  assert.equal(persistedPayment.rows[0].finance_account_name_snapshot,'Основная касса');
  const pricingSnapshot = await setup.query(`SELECT s.subtotal_minor,s.discount_minor,s.final_total_minor,l.gross_minor,l.net_minor
    FROM pos_order_pricing_snapshots s JOIN pos_order_pricing_snapshot_lines l ON l.snapshot_id=s.id
    WHERE s.venue_id=$1 AND s.order_id=$2`, [venueId, orderId]);
  assert.equal(pricingSnapshot.rowCount, 1, 'the current payment path writes one canonical pricing line before cash reconciliation');
  assert.equal(Number(pricingSnapshot.rows[0].subtotal_minor), 30000);
  assert.equal(Number(pricingSnapshot.rows[0].gross_minor), 30000);
  assert.equal(Number(pricingSnapshot.rows[0].net_minor), 30000);

  guestId = (await setup.query("INSERT INTO guests (venue_id,full_name) VALUES ($1,'Refund cash QA guest') RETURNING id", [venueId])).rows[0].id;
  const cashRefundSource = (await setup.query("INSERT INTO guest_account_entries (venue_id,guest_id,account_type,amount,reason,source_type,source_key) VALUES ($1,$2,'deposit',30,'QA original deposit','deposit_top_up','shift-qa-cash-source') RETURNING id", [venueId, guestId])).rows[0].id;
  const nonCashRefundSource = (await setup.query("INSERT INTO guest_account_entries (venue_id,guest_id,account_type,amount,reason,source_type,source_key) VALUES ($1,$2,'deposit',10,'QA card deposit','deposit_top_up','shift-qa-card-source') RETURNING id", [venueId, guestId])).rows[0].id;
  await setup.query("INSERT INTO guest_account_reversals (venue_id,guest_id,source_entry_id,shift_id,account_type,amount,payout_method,reason,idempotency_key,actor_id) VALUES ($1,$2,$3,$4,'deposit',30,'cash','QA cash payout','shift-qa-cash-reversal',$5),($1,$2,$6,$4,'deposit',10,'card','QA card return','shift-qa-card-reversal',$5)", [venueId, guestId, cashRefundSource, shiftId, userId, nonCashRefundSource]);

  const financeCategoryId=(await setup.query("INSERT INTO finance_categories(venue_id,name,kind) VALUES($1,'QA shift payable','expense') RETURNING id",[venueId])).rows[0].id;
  const payableId=(await setup.query(`INSERT INTO finance_payables(venue_id,category_id,category_name_snapshot,title,period_from,period_to,due_date,total_amount,status,created_by,approved_by,approved_at) VALUES($1,$2,'QA shift payable','QA shift rent payout',current_date,current_date,current_date,20,'approved',$3,$3,now()) RETURNING id`,[venueId,financeCategoryId,userId])).rows[0].id;
  const payableExpenseId=(await setup.query(`INSERT INTO expenses(venue_id,category,category_id,amount,expense_date,description,source,created_by,idempotency_key,payment_method,finance_account_id,finance_account_name_snapshot,shift_id) VALUES($1,'QA shift payable',$2,20,(now() AT TIME ZONE 'Asia/Yekaterinburg')::date,'QA shift rent payout','manual',$3,'shift-qa-payable-cash','cash',$4,$5,$6) RETURNING id`,[venueId,financeCategoryId,userId,posCashbox.id,posCashbox.name,shiftId])).rows[0].id;
  await setup.query(`INSERT INTO finance_payable_payment_links(venue_id,payable_id,expense_id,applied_amount,idempotency_key,created_by) VALUES($1,$2,$3,20,'shift-qa-payable-cash',$4)`,[venueId,payableId,payableExpenseId,userId]);
  const manualExpenseId=(await setup.query(`INSERT INTO expenses(venue_id,category,category_id,amount,expense_date,description,source,created_by,idempotency_key,payment_method,finance_account_id,finance_account_name_snapshot,shift_id) VALUES($1,'QA shift payable',$2,25,(now() AT TIME ZONE 'Asia/Yekaterinburg')::date,'QA direct manual POS cash expense','manual',$3,'shift-qa-manual-cash','cash',$4,$5,$6) RETURNING id`,[venueId,financeCategoryId,userId,posCashbox.id,posCashbox.name,shiftId])).rows[0].id;
  const purchaseRepository=new PurchaseDocumentRepository(pool);
  const purchaseIngredientId=(await setup.query("INSERT INTO ingredients(venue_id,name,unit,cost,is_marked,purchase_unit,pack_multiplier) VALUES($1,'QA cash purchase ingredient','unit',0,true,'unit',1) RETURNING id",[venueId])).rows[0].id;
  const purchaseToday=(await setup.query("SELECT (now() AT TIME ZONE 'Asia/Yekaterinburg')::date::text AS date")).rows[0].date;
  const purchaseDraft=await purchaseRepository.saveDraft({venueId,supplierName:'QA cash purchase supplier',documentNumber:`QA-CASH-${process.pid}`,documentDate:purchaseToday,lines:[{ingredientId:purchaseIngredientId,quantity:1,unit:'unit',unitCost:7}]});
  const postedPurchase=await purchaseRepository.post(venueId,purchaseDraft.id,userId);
  const purchasePayment=await purchaseRepository.addPayment({id:purchaseDraft.id,venueId,amount:7,paymentDate:purchaseToday,paymentMethod:'cash',paymentAccountId:posCashbox.id,documentUrl:'',idempotencyKey:`shift-qa-purchase-${process.pid}`,createdBy:userId});
  assert.equal(purchasePayment.shiftId,shiftId,'purchase cashbox payment is assigned to the active shift');
  const purchaseExpenseId=purchasePayment.expenseId;
  const incomeCategoryId=(await setup.query("INSERT INTO finance_categories(venue_id,name,kind) VALUES($1,'QA shift other income','income') RETURNING id",[venueId])).rows[0].id;
  const incomeDocumentId=(await setup.query(`INSERT INTO finance_other_income_documents(venue_id,category_id,category_name_snapshot,title,recognition_date,total_amount,idempotency_key,status,created_by) VALUES($1,$2,'QA shift other income','QA shift income receipt',(now() AT TIME ZONE 'Asia/Yekaterinburg')::date,10,'shift-qa-other-income','draft',$3) RETURNING id`,[venueId,incomeCategoryId,userId])).rows[0].id;
  await setup.query("UPDATE finance_other_income_documents SET status='posted',posted_by=$2,posted_at=now() WHERE venue_id=$1 AND id=$3",[venueId,userId,incomeDocumentId]);
  const otherIncomeReceiptId=(await setup.query(`INSERT INTO finance_other_income_receipts(venue_id,document_id,amount,receipt_date,payment_method,finance_account_id,finance_account_name_snapshot,shift_id,note,idempotency_key,created_by) VALUES($1,$2,10,(now() AT TIME ZONE 'Asia/Yekaterinburg')::date,'cash',$3,$4,$5,'QA POS cash income','shift-qa-other-income-receipt',$6) RETURNING id`,[venueId,incomeDocumentId,posCashbox.id,posCashbox.name,shiftId,userId])).rows[0].id;
  const otherIncomeRefundId=(await setup.query(`INSERT INTO finance_other_income_refunds(venue_id,document_id,receipt_id,amount,refund_date,payout_method,finance_account_id,finance_account_name_snapshot,shift_id,reason,idempotency_key,created_by) VALUES($1,$2,$3,2,(now() AT TIME ZONE 'Asia/Yekaterinburg')::date,'cash',$4,$5,$6,'QA cash income refund','shift-qa-other-income-refund',$7) RETURNING id`,[venueId,incomeDocumentId,otherIncomeReceiptId,posCashbox.id,posCashbox.name,shiftId,userId])).rows[0].id;

  const preview = await callShiftApi({ path: '/api/shifts', method: 'GET' });
  assert.equal(preview.data.current.expectedCash, 1251, 'shift preview includes internal cash transfer (-20), owner contribution (+50), and principal repayment (-5) alongside other POS events');
  assert.equal(preview.data.current.unresolvedLegacyCashCount, 0);
  assert.ok(preview.data.current.cashPreviewAt, 'preview exposes when its provisional total was calculated');
  const staffPreview = await callShiftApi({ path: '/api/shifts', method: 'GET', role: 'bartender' });
  assert.equal(staffPreview.data.current.expectedCash, 1251, 'operational staff receive expected cash after transfer and funding events are included');

  const rollbackChecklist = { version: 1, items: { ordersReviewed: true, cashCounted: true, inventoryReviewed: true, externalFiscalReportsHandled: true } };
  await installInsertFault(snapshotFault, `NEW.venue_id='${venueId}'::uuid`);
  const snapshotFailure = await callShiftApi({ path: `/api/shifts/${shiftId}/close`, body: { closingCash: 1250, checklist: rollbackChecklist } });
  assert.equal(snapshotFailure.status, 409);
  assert.equal(snapshotFailure.data.error, 'shift_close_failed');
  assert.match(snapshotFailure.data.detail, new RegExp(snapshotFault.message));
  await removeInsertFault(snapshotFault);
  await assertCloseRolledBack('snapshot insert failure');

  await installInsertFault(auditFault, `NEW.venue_id='${venueId}'::uuid AND NEW.action='shift.closed' AND NEW.entity_id='${shiftId}'::uuid`);
  const auditFailure = await callShiftApi({ path: `/api/shifts/${shiftId}/close`, body: { closingCash: 1250, checklist: rollbackChecklist } });
  assert.equal(auditFailure.status, 409);
  assert.equal(auditFailure.data.error, 'shift_close_failed');
  assert.match(auditFailure.data.detail, new RegExp(auditFault.message));
  await removeInsertFault(auditFault);
  await assertCloseRolledBack('close audit insert failure');

  raceProductId = (await setup.query("INSERT INTO products (venue_id,name,category,sale_price) VALUES ($1,'QA concurrent cash order','bar',25) RETURNING id", [venueId])).rows[0].id;
  raceOrderId = (await setup.query("INSERT INTO orders (venue_id,opened_by,status) VALUES ($1,$2,'open') RETURNING id", [venueId, userId])).rows[0].id;
  await setup.query('INSERT INTO order_items (order_id,product_id,quantity,unit_price) VALUES ($1,$2,1,25)', [raceOrderId, raceProductId]);
  const paymentRace = callPaymentApi({ path: `/api/orders/${raceOrderId}/payments`, body: { amount: 25, method: 'cash',paymentAccountId:posCashbox.id,idempotencyKey:'shift-e2e-racing-cash-001' } });
  const fundingRace = pool.query(`INSERT INTO finance_funding_events(venue_id,document_id,event_type,amount,event_date,finance_account_id,finance_account_name_snapshot,payment_method,shift_id,idempotency_key,request_sha256,created_by) VALUES($1,$2,'owner_contribution_received',7,(now() AT TIME ZONE 'Asia/Yekaterinburg')::date,$3,$4,'cash',$5,$6,repeat('f',64),$7) RETURNING id`,[venueId,fundingReceiptDocumentId,posCashbox.id,posCashbox.name,shiftId,randomUUID(),userId]).then(({rows})=>({status:201,id:rows[0].id}),error=>({status:409,error:error.message}));
  const transferRace = pool.query(`INSERT INTO finance_account_transfers(venue_id,amount,transfer_date,from_account_id,from_account_name_snapshot,to_account_id,to_account_name_snapshot,shift_id,note,idempotency_key,request_sha256,created_by) VALUES($1,11,(now() AT TIME ZONE 'Asia/Yekaterinburg')::date,$2,$3,$4,$5,$6,'Racing POS cash transfer',$7,repeat('c',64),$8) RETURNING id`,[venueId,posCashbox.id,posCashbox.name,fundingBank.id,fundingBank.name,shiftId,randomUUID(),userId]).then(({rows})=>({status:201,id:rows[0].id}),error=>({status:409,error:error.message}));
  const closeRace = callShiftApi({ path: `/api/shifts/${shiftId}/close`, body: { closingCash: 1250, checklist: { version: 1, items: { ordersReviewed: true, cashCounted: true, inventoryReviewed: true, externalFiscalReportsHandled: true } } } });
  const [racingPayment, racingFunding, racingTransfer, racingClose] = await Promise.all([paymentRace, fundingRace, transferRace, closeRace]);
  assert.equal(racingClose.status, 200, `the serialized shift close succeeds: ${JSON.stringify(racingClose)}`);
  assert.ok(racingPayment.status === 201 || racingPayment.status === 409, `the racing payment has one serialized outcome: ${JSON.stringify(racingPayment)}`);
  assert.ok(racingFunding.status===201||racingFunding.status===409,`the funding-vs-close race has one serialized outcome: ${JSON.stringify(racingFunding)}`);
  assert.ok(racingTransfer.status===201||racingTransfer.status===409,`the transfer-vs-close race has one serialized outcome: ${JSON.stringify(racingTransfer)}`);
  const raceCash = 1251+(racingPayment.status===201?25:0)+(racingFunding.status===201?7:0)-(racingTransfer.status===201?11:0);
  if (racingPayment.status === 201) assert.equal(racingPayment.data.shiftId, shiftId, 'a payment that wins the shift lock is attributed to the closing shift');
  else assert.equal(racingPayment.data.error, 'open_shift_required', 'a payment that loses the shift lock cannot post to the closed shift');
  if(racingFunding.status===409)assert.match(racingFunding.error,/finance_payment_open_shift_required|finance_funding_document_not_open/,'a funding event that loses the shift lock cannot post to the closed shift');
  if(racingTransfer.status===409)assert.match(racingTransfer.error,/finance_transfer_open_shift_required|finance_account_transfer/,'a transfer that loses the shift lock cannot post to the closed shift');
  assert.equal(Number(racingClose.data.expectedCash), raceCash, 'the locked close includes a winning cash payment exactly once');

  const finalShift = await setup.query('SELECT closed_at,opening_cash,expected_cash,closing_cash,cash_variance FROM shifts WHERE id=$1', [shiftId]);
  assert.ok(finalShift.rows[0].closed_at);
  assert.equal(Number(finalShift.rows[0].opening_cash), 1000);
  assert.equal(Number(finalShift.rows[0].expected_cash), raceCash);
  assert.equal(Number(finalShift.rows[0].closing_cash), 1250);
  assert.equal(Number(finalShift.rows[0].cash_variance), 1250 - raceCash, 'cash variance is reconciled to the serialized expected total');
  const snapshotResult = await setup.query('SELECT id::text AS id,snapshot_payload AS payload,snapshot_sha256 AS sha256,closed_by::text AS closed_by FROM shift_close_snapshots WHERE venue_id=$1 AND shift_id=$2', [venueId, shiftId]);
  assert.equal(snapshotResult.rowCount, 1, 'the close transaction persists exactly one snapshot for the shift');
  const snapshot = snapshotResult.rows[0];
  assert.equal(snapshot.payload.fiscalDocument, false, 'internal snapshot is explicitly not a fiscal Z report');
  assert.equal(snapshot.payload.cashReconciliation.expectedCash, raceCash);
  assert.equal(snapshot.payload.cashReconciliation.actualCash, 1250);
  assert.equal(snapshot.payload.checklist.items.length, 4);
  assert.ok(snapshot.payload.checklist.items.every((item) => item.checked && item.checkedBy === userId && item.checkedAt));
  assert.equal(snapshot.sha256, createHash('sha256').update(shiftCloseContract.stableJsonStringify(snapshot.payload)).digest('hex'),
    'stored digest verifies against a stable canonical serialization after the jsonb readback');
  assert.ok(snapshot.payload.ledger.payouts.some((event) => event.source === 'payable_cash_payment' && event.eventId === payableExpenseId && Number(event.amount) === 20),'close snapshot includes the linked rent cash payout exactly once');
  assert.equal(snapshot.payload.ledger.payouts.filter((event) => event.source === 'cash_expense' && event.eventId === manualExpenseId && Number(event.amount) === 25).length,1,'close snapshot includes the direct manual POS cash expense exactly once');
  assert.equal(snapshot.payload.ledger.payouts.filter((event) => event.source === 'cash_expense' && event.eventId === purchaseExpenseId && Number(event.amount) === 7).length,1,'close snapshot includes the attributed purchase cash payment exactly once');
  assert.equal(snapshot.payload.ledger.receipts.filter((event) => event.source === 'other_income_receipt' && event.eventId === otherIncomeReceiptId && Number(event.amount) === 10).length,1,'close snapshot includes POS cash receipt for other income exactly once');
  assert.equal(snapshot.payload.ledger.payouts.filter((event) => event.source === 'other_income_refund' && event.eventId === otherIncomeRefundId && Number(event.amount) === 2).length,1,'close snapshot includes its cash refund as a separate payout exactly once');
  assert.equal(snapshot.payload.ledger.receipts.filter((event) => event.source === 'owner_contribution' && event.eventId === fundingReceiptEventId && Number(event.amount) === 50).length,1,'close snapshot includes the owner contribution exactly once');
  assert.equal(snapshot.payload.ledger.payouts.filter((event) => event.source === 'loan_principal_repaid' && event.eventId === fundingRepaymentEventId && Number(event.amount) === 5).length,1,'close snapshot includes principal repayment exactly once');
  assert.equal(snapshot.payload.ledger.payouts.filter((event) => event.source === 'internal_transfer' && Number(event.amount) === 20).length,1,'close snapshot includes the POS cash transfer leg exactly once');
  assert.equal(snapshot.payload.ledger.receipts.filter((event) => event.source === 'owner_contribution' && event.eventId === racingFunding.id).length,racingFunding.status===201?1:0,'funding event that wins the close lock is snapshotted once; a losing event is absent');
  assert.equal(snapshot.payload.ledger.payouts.filter((event) => event.source === 'internal_transfer' && Number(event.amount) === 11).length,racingTransfer.status===201?1:0,'transfer that wins the close lock is snapshotted once; a losing transfer is absent');
  assert.ok(snapshot.payload.ledger.receipts.some((event) => event.source === 'order_payment' && Number(event.amount) === 300),
    'close snapshot captures the cash payment ledger');
  const snapshotRead = await callShiftApi({ path: `/api/shifts/${shiftId}/close-snapshot`, method: 'GET' });
  assert.equal(snapshotRead.status, 200);
  assert.equal(snapshotRead.data.sha256, snapshot.sha256);
  assert.deepEqual(snapshotRead.data.payload, snapshot.payload);
  const otherEmployeeRead = await callShiftApi({ path: `/api/shifts/${shiftId}/close-snapshot`, method: 'GET', role: 'bartender', actorId: '99999999-9999-4999-8999-999999999999' });
  assert.equal(otherEmployeeRead.status, 403, 'a worker who did not close this shift cannot read another employee’s snapshot');
  const foreignVenueSnapshot = await callShiftApi({ path: `/api/shifts/${shiftId}/close-snapshot`, method: 'GET', venueDbId: otherVenueId });
  assert.equal(foreignVenueSnapshot.status, 404, 'a venue cannot read another venue’s snapshot');
  const missingSnapshot = await callShiftApi({ path: `/api/shifts/${'00000000-0000-4000-8000-000000000001'}/close-snapshot`, method: 'GET' });
  assert.equal(missingSnapshot.status, 404);
  await assert.rejects(pool.query('UPDATE shift_close_snapshots SET snapshot_payload=snapshot_payload WHERE id=$1', [snapshot.id]),
    (error) => error.code === '55000', 'the immutable trigger rejects snapshot updates');
  await assert.rejects(pool.query('DELETE FROM shift_close_snapshots WHERE id=$1', [snapshot.id]),
    (error) => error.code === '55000', 'the immutable trigger rejects snapshot deletion');
  const repeatClose = await callShiftApi({ path: `/api/shifts/${shiftId}/close`, body: { closingCash: 1250, checklist: { version: 1, items: { ordersReviewed: true, cashCounted: true, inventoryReviewed: true, externalFiscalReportsHandled: true } } } });
  assert.equal(repeatClose.status, 404, 'a closed shift cannot be reconciled or closed a second time');

  console.log('SHIFT CASH POSTGRES E2E QA: PASS (opening float, cash preview, legacy-cash block, funding receipt/repayment reconciliation, payment/funding-vs-close races, immutable close snapshot/digest/readback, checklist, actual cash/variance)');
} finally {
  if (setup._connected) {
    await removeInsertFault(snapshotFault);
    await removeInsertFault(auditFault);
  }
  await pool.end();
  if (setup._connected) {
    if (venueId) {
      await setup.query('DELETE FROM finance_payable_payment_links WHERE venue_id=$1',[venueId]).catch(()=>{});
      await setup.query('DELETE FROM finance_other_income_refunds WHERE venue_id=$1',[venueId]).catch(()=>{});
      await setup.query('DELETE FROM finance_other_income_receipts WHERE venue_id=$1',[venueId]).catch(()=>{});
      await setup.query('DELETE FROM finance_other_income_documents WHERE venue_id=$1',[venueId]).catch(()=>{});
      await setup.query('ALTER TABLE finance_funding_events DISABLE TRIGGER USER').catch(()=>{});
      await setup.query('ALTER TABLE finance_funding_documents DISABLE TRIGGER USER').catch(()=>{});
      await setup.query('DELETE FROM finance_funding_events WHERE venue_id=$1',[venueId]).catch(()=>{});
      await setup.query('DELETE FROM finance_funding_documents WHERE venue_id=$1',[venueId]).catch(()=>{});
      await setup.query('ALTER TABLE finance_funding_events ENABLE TRIGGER USER').catch(()=>{});
      await setup.query('ALTER TABLE finance_funding_documents ENABLE TRIGGER USER').catch(()=>{});
      await setup.query('DELETE FROM expenses WHERE venue_id=$1',[venueId]).catch(()=>{});
      await setup.query('DELETE FROM finance_payable_lines WHERE venue_id=$1',[venueId]).catch(()=>{});
      await setup.query('DELETE FROM finance_payables WHERE venue_id=$1',[venueId]).catch(()=>{});
      await setup.query('DELETE FROM finance_categories WHERE venue_id=$1',[venueId]).catch(()=>{});
      await setup.query('DELETE FROM finance_accounts WHERE venue_id=$1',[venueId]).catch(()=>{});
      await setup.query('DELETE FROM guest_account_reversals WHERE venue_id=$1', [venueId]).catch(() => {});
      await setup.query('DELETE FROM guest_account_entries WHERE venue_id=$1', [venueId]).catch(() => {});
      await setup.query('DELETE FROM guests WHERE venue_id=$1', [venueId]).catch(() => {});
      await setup.query('DELETE FROM payments WHERE order_id IN (SELECT id FROM orders WHERE venue_id=$1)', [venueId]).catch(() => {});
      if (unresolvedPaymentId) await setup.query('DELETE FROM payments WHERE id=$1', [unresolvedPaymentId]).catch(() => {});
      await setup.query('DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE venue_id=$1)', [venueId]).catch(() => {});
      await setup.query('DELETE FROM orders WHERE venue_id=$1', [venueId]).catch(() => {});
      await setup.query('DELETE FROM shifts WHERE venue_id=$1', [venueId]).catch(() => {});
      if (productId || raceProductId) await setup.query('DELETE FROM products WHERE id=ANY($1::uuid[])', [[productId, raceProductId].filter(Boolean)]).catch(() => {});
      if (userId) await setup.query('DELETE FROM users WHERE id=$1', [userId]).catch(() => {});
      await setup.query('DELETE FROM venues WHERE id=$1', [venueId]).catch(() => {});
      if (otherVenueId) await setup.query('DELETE FROM venues WHERE id=$1', [otherVenueId]).catch(() => {});
    }
    if(organizationId) await setup.query('DELETE FROM organizations WHERE id=$1',[organizationId]).catch(()=>{});
    await setup.end();
  }
}
