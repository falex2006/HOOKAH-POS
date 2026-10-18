import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertQaDatabaseIdentity, validateQaDatabaseUrl } from './postgres-qa-safety.mjs';

const require = createRequire(import.meta.url);
const { Client, Pool } = require('pg');
const { handleFinanceExpenseRefundRoute } = require('../finance-expense-refunds.js');
const { handleFinancePayableRecognitionRoute } = require('../finance-payable-recognition.js');
const { handleFinancePayableRoute } = require('../finance-payables.js');
const { handleFinancePayableOffsetRoute } = require('../finance-payable-offsets.js');
const { handleFinanceUnifiedReport } = require('../finance-unified-report.js');
const target = validateQaDatabaseUrl(process.env.MIGRATIONS_PG_TEST_DATABASE_URL);
const root = fileURLToPath(new URL('../', import.meta.url));
const schemaName = `finance_expense_refunds_qa_${process.pid}_${Date.now()}`;
const scopedUrl = new URL(target.url);
scopedUrl.searchParams.set('options', `-c search_path=${schemaName}`);
const admin = new Client({ connectionString: target.url.href });
let pool;
let created = false;

async function insert(client, table, row) {
  const fields = Object.keys(row); const values = fields.map((field) => row[field]);
  return (await client.query(`INSERT INTO ${table} (${fields.join(',')}) VALUES (${fields.map((_, index) => `$${index + 1}`).join(',')}) RETURNING id`, values)).rows[0].id;
}
async function call({ method = 'POST', expenseId, venueId, userId, body = {}, permissions = ['finance'] }) {
  const result = {};
  const handled = await handleFinanceExpenseRefundRoute({
    req: { method, user: { id: userId, role: 'owner' } }, res: result,
    url: new URL(`/api/finance/expenses/${expenseId}/refunds`, 'http://localhost'), pool, venueId,
    json: (_res, status, payload) => Object.assign(result, { status, payload }),
    readBody: async () => body, hasPermission: (permission) => permissions.includes(permission),
    isOperationalEmployee: () => false, recordAudit: () => {},
  });
  assert.equal(handled, true);
  return result;
}

try {
  await admin.connect();
  const identity = (await admin.query(`SELECT current_database() AS database,inet_server_addr() AS address,inet_server_port() AS port,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser`)).rows[0];
  assertQaDatabaseIdentity(identity, target.database, Number(target.url.port));
  await admin.query(`CREATE SCHEMA ${schemaName}`); created = true;
  await admin.query(`SET search_path TO ${schemaName}`);
  await admin.query(readFileSync(path.join(root, 'schema.sql'), 'utf8'));
  const migration = readFileSync(path.join(root, 'migrations/136_finance_manual_expense_refunds.sql'), 'utf8');
  await admin.query(migration); await admin.query(migration);
  const payableRefundMigration=readFileSync(path.join(root,'migrations/141_finance_payable_payment_refunds.sql'),'utf8');
  await admin.query(payableRefundMigration);await admin.query(payableRefundMigration);
  const offsetMigration=readFileSync(path.join(root,'migrations/142_finance_payable_offsets.sql'),'utf8');
  await admin.query(offsetMigration);await admin.query(offsetMigration);
  pool = new Pool({ connectionString: scopedUrl.href, max: 6 });

  const venueId = await insert(admin, 'venues', { name: 'Finance refund QA', timezone: 'Asia/Yekaterinburg' });
  const userId = await insert(admin, 'users', { venue_id: venueId, full_name: 'QA owner', login: `${schemaName}-owner`, role: 'owner' });
  const categoryId = await insert(admin, 'finance_categories', { venue_id: venueId, name: 'Аренда', kind: 'expense' });
  const bankId = await insert(admin, 'finance_accounts', { venue_id: venueId, code: 'qa_bank', name: 'QA банк', kind: 'bank', allowed_payment_methods: ['bank_transfer'], created_by: userId });
  const expenseId = await insert(admin, 'expenses', { venue_id: venueId, category: 'Аренда', category_id: categoryId, amount: '100.00', expense_date: '2026-10-01', description: 'Октябрь', source: 'manual', counterparty_name: 'Арендодатель', created_by: userId, payment_method: 'bank_transfer', finance_account_id: bankId, finance_account_name_snapshot: 'QA банк' });
  const otherVenue = await insert(admin, 'venues', { name: 'Other finance refund QA' });
  const today = (await admin.query("SELECT (now() AT TIME ZONE 'Asia/Yekaterinburg')::date::text AS date")).rows[0].date;
  const key = () => crypto.randomUUID();
  const request = (amount, idempotencyKey, account = bankId, method = 'bank_transfer', date = today) => ({ amount, refundDate: date, paymentMethod: method, paymentAccountId: account, documentReference: 'акт возврата', reason: 'Возврат переплаты', idempotencyKey });

  const firstKey = key();
  let result = await call({ expenseId, venueId, userId, permissions: ['finance_read'], body: request('25.50', firstKey) });
  assert.equal(result.status, 403, 'finance_read cannot create a refund');
  result = await call({ expenseId, venueId, userId, body: request('25.50', firstKey) });
  assert.equal(result.status, 201, JSON.stringify(result.payload));
  assert.equal(result.payload.totals.availableToReturn, '74.50');
  assert.equal(result.payload.pnlEffect, 'not_calculated');
  const persisted = (await admin.query('SELECT expense_id,amount::text,refund_date::text,payment_method,finance_account_id,document_reference,reason,idempotency_key,request_sha256 FROM finance_expense_refunds WHERE venue_id=$1 AND idempotency_key=$2', [venueId, firstKey])).rows[0];
  const expectedHash = crypto.createHash('sha256').update(JSON.stringify({ expenseId, amountCents: 2550, refundDate: today, paymentMethod: 'bank_transfer', paymentAccountId: bankId, documentReference: 'акт возврата', reason: 'Возврат переплаты' })).digest('hex');
  const replay = await call({ expenseId, venueId, userId, body: request('25.50', firstKey) });
  assert.equal(replay.status, 200, `exact idempotent replay returns the committed receipt: ${JSON.stringify({ persisted, expectedHash, expenseId, bankId, today })}`);
  assert.equal((await call({ expenseId, venueId, userId, body: request('26.00', firstKey) })).status, 409, 'same key with changed amount conflicts');

  const races = await Promise.all([
    call({ expenseId, venueId, userId, body: request('50.00', key()) }),
    call({ expenseId, venueId, userId, body: request('50.00', key()) }),
  ]);
  assert.deepEqual(races.map((item) => item.status).sort(), [201, 409], 'expense row lock prevents concurrent over-refund');
  const totals = (await call({ method: 'GET', expenseId, venueId, userId, permissions: ['finance_read'] })).payload.totals;
  assert.equal(totals.grossReturned, '75.50'); assert.equal(totals.availableToReturn, '24.50');
  assert.equal((await call({ method: 'GET', expenseId, venueId: otherVenue, userId, permissions: ['finance_read'] })).status, 404, 'cross-venue history is hidden');
  await assert.rejects(() => admin.query('UPDATE finance_expense_refunds SET reason=$1 WHERE venue_id=$2', ['rewrite', venueId]), /finance_expense_refunds_append_only/);
  await assert.rejects(() => admin.query('DELETE FROM finance_expense_refunds WHERE venue_id=$1', [venueId]), /finance_expense_refunds_append_only/);
  await assert.rejects(() => admin.query(`INSERT INTO finance_expense_refunds(venue_id,expense_id,amount,refund_date,payment_method,finance_account_id,finance_account_name_snapshot,document_reference,reason,idempotency_key,request_sha256,created_by)
    VALUES($1,$2,1,$3,'bank_transfer',$4,'Forged account name',NULL,'Проверка триггера',$5,repeat('a',64),$6)`, [venueId, expenseId, today, bankId, key(), userId]), (error) => error.code === '23514' && /finance_account_snapshot_mismatch/.test(error.message), 'database validates the account name snapshot, including direct SQL inserts');

  const posExpenseId = await insert(admin, 'expenses', { venue_id: venueId, category: 'Аренда', category_id: categoryId, amount: '20.00', expense_date: '2026-10-01', description: 'Залог', source: 'other', created_by: userId });
  const posAccount = (await admin.query("SELECT id,name FROM finance_accounts WHERE venue_id=$1 AND kind='pos_cashbox' AND active", [venueId])).rows[0];
  const shiftId = await insert(admin, 'shifts', { venue_id: venueId, opened_by: userId, opening_cash: '0' });
  const cashRefund = await call({ expenseId: posExpenseId, venueId, userId, body: request('5.00', key(), posAccount.id, 'cash') });
  assert.equal(cashRefund.status, 201, JSON.stringify(cashRefund.payload));
  assert.equal(cashRefund.payload.refunds[0].paymentAccountNameSnapshot, posAccount.name);
  assert.equal(cashRefund.payload.refunds[0].shiftId, shiftId, 'POS cash receipt is bound to exactly the open shift');
  const server = readFileSync(path.join(root, 'server.js'), 'utf8');
  assert.ok(server.includes("'manual_expense_refund',r.id,NULL,'receipt'") && server.includes("COALESCE(SUM(r.amount),0) FROM finance_expense_refunds r WHERE r.venue_id=$1 AND r.shift_id=$2"), 'POS refund feeds expected cash and the immutable close ledger');

  // Contractual refunds reuse the same ledger and reopen the payment capacity.
  const payableId = await insert(admin, 'finance_payables', { venue_id: venueId, category_id: categoryId, category_name_snapshot: 'Аренда', title: 'Возврат оплаты договора', period_from: today, period_to: today, due_date: today, total_amount: '100.00', status: 'approved', created_by: userId });
  async function linkedPayment(amount) {
    const id = await insert(admin, 'expenses', { venue_id: venueId, category: 'Аренда', category_id: categoryId, amount, expense_date: today, source: 'manual', created_by: userId, payment_method: 'bank_transfer', finance_account_id: bankId, finance_account_name_snapshot: 'QA банк' });
    await insert(admin, 'finance_payable_payment_links', { venue_id: venueId, payable_id: payableId, expense_id: id, applied_amount: amount, idempotency_key: key(), created_by: userId });
    return id;
  }
  async function recognitionCall(suffix, body) {
    const result = {};
    await handleFinancePayableRecognitionRoute({ req: { method: 'POST', user: { id: userId, role: 'owner' } }, res: result,
      url: new URL(`/api/finance/payables/${payableId}/recognitions${suffix}`, 'http://localhost'), pool, venueId,
      json: (_res,status,payload) => Object.assign(result,{status,payload}), readBody: async () => body,
      hasPermission: () => true, recordAudit: () => {} });
    return result;
  }
  const recognized = await recognitionCall('', { recognitionDate: today, idempotencyKey: key(), documentReference: 'Акт аренды' });
  assert.equal(recognized.status, 201, JSON.stringify(recognized.payload));
  const paidExpense = await linkedPayment('100.00');
  await assert.rejects(() => admin.query("UPDATE finance_payables SET status='cancelled' WHERE id=$1", [payableId]), /finance_payable_has_payments/);
  const contractRefundKey = key();
  const contractRefund = await call({ expenseId: paidExpense, venueId, userId, body: request('30.00', contractRefundKey) });
  assert.equal(contractRefund.status, 201, JSON.stringify(contractRefund.payload));
  assert.equal(contractRefund.payload.pnlEffect, 'separate_payable_recognition');
  assert.equal((await admin.query('SELECT payable_id FROM finance_expense_refunds WHERE idempotency_key=$1', [contractRefundKey])).rows[0].payable_id, payableId);
  const repaidExpense = await linkedPayment('30.00');
  const contractRaces = await Promise.all([20,20].map(amount => call({ expenseId: repaidExpense, venueId, userId, body: request(String(amount), key()) })));
  assert.deepEqual(contractRaces.map(item => item.status).sort(), [201,409]);
  assert.equal((await call({ expenseId: repaidExpense, venueId, userId, body: request('10.00', key()) })).status, 201);
  await assert.rejects(() => admin.query("UPDATE finance_payables SET status='cancelled' WHERE id=$1", [payableId]), /finance_payable_has_payments/);
  assert.equal((await call({ expenseId: paidExpense, venueId, userId, body: request('70.00', key()) })).status, 201);
  await assert.rejects(() => admin.query("UPDATE finance_payables SET status='cancelled' WHERE id=$1", [payableId]), /finance_payable_has_recognition/, 'cash return must not silently reverse the recognized expense');
  const partialReversal = await recognitionCall(`/${recognized.payload.id}/reversals`, { amount: '40.00', reversalDate: today, reason: 'Частичное сторно акта', idempotencyKey: key() });
  assert.equal(partialReversal.status, 201, JSON.stringify(partialReversal.payload));
  await assert.rejects(() => admin.query("UPDATE finance_payables SET status='cancelled' WHERE id=$1", [payableId]), /finance_payable_has_recognition/);
  const finalReversal = await recognitionCall(`/${recognized.payload.id}/reversals`, { amount: '60.00', reversalDate: today, reason: 'Окончательное сторно акта', idempotencyKey: key() });
  assert.equal(finalReversal.status, 201, JSON.stringify(finalReversal.payload));
  await admin.query("UPDATE finance_payables SET status='cancelled' WHERE id=$1", [payableId]);
  assert.equal((await call({ expenseId: paidExpense, venueId, userId, body: request('30.00', contractRefundKey) })).status, 200, 'exact retry remains readable after cancellation');
  assert.equal((await admin.query('SELECT SUM(applied_amount)::text AS total FROM finance_payable_payment_links WHERE payable_id=$1', [payableId])).rows[0].total, '130.00', 'gross historical payments are preserved');
  assert.equal((await admin.query('SELECT SUM(amount)::text AS total FROM finance_expense_refunds WHERE payable_id=$1', [payableId])).rows[0].total, '130.00');

  const offsetDoc = async (title, amount) => insert(admin,'finance_payables',{venue_id:venueId,category_id:categoryId,category_name_snapshot:'Аренда',title,period_from:today,period_to:today,due_date:today,total_amount:amount,status:'approved',created_by:userId});
  const offsetSource = await offsetDoc('Offset source','60.00');
  const offsetTarget = await offsetDoc('Offset target','65.00');
  const offsetThird = await offsetDoc('Offset third','50.00');
  const offsetExpense = await insert(admin,'expenses',{venue_id:venueId,category:'Аренда',category_id:categoryId,amount:'60.00',expense_date:today,source:'manual',created_by:userId,payment_method:'bank_transfer',finance_account_id:bankId,finance_account_name_snapshot:'QA банк'});
  await insert(admin,'finance_payable_payment_links',{venue_id:venueId,payable_id:offsetSource,expense_id:offsetExpense,applied_amount:'60.00',idempotency_key:key(),created_by:userId});
  const offset = (client,source,destination,amount,reversal=null,payment=offsetExpense) => insert(client,'finance_payable_offsets',{venue_id:venueId,expense_id:payment,source_payable_id:source,destination_payable_id:destination,amount,offset_date:today,reason:'Explicit settlement agreement',reversal_of_id:reversal,idempotency_key:key(),request_sha256:'a'.repeat(64),created_by:userId});
  const offsetId = await offset(admin,offsetSource,offsetTarget,'20.00');
  const chainId = await offset(admin,offsetTarget,offsetThird,'10.00');
  await assert.rejects(()=>offset(admin,offsetTarget,offsetSource,'20.00',offsetId),/finance_payable_offset_exceeds_allocation/);
  await offset(admin,offsetThird,offsetTarget,'10.00',chainId);
  await offset(admin,offsetTarget,offsetSource,'20.00',offsetId);
  await assert.rejects(()=>offset(admin,offsetTarget,offsetSource,'0.01',offsetId),/finance_payable_offset_reversal_exceeds_balance/);
  const offsetRaces = await Promise.allSettled([offset(pool,offsetSource,offsetTarget,'40.00'),offset(pool,offsetSource,offsetTarget,'40.00')]);
  assert.equal(offsetRaces.filter(r=>r.status==='fulfilled').length,1,'concurrent offsets cannot reuse the same payment allocation');
  assert.match(offsetRaces.find(r=>r.status==='rejected').reason.message,/finance_payable_offset_exceeds_allocation/);
  const allocation = (await admin.query('SELECT finance_payable_expense_allocation($1,$2,$3)::text AS source,finance_payable_settled_amount($1,$4)::text AS destination',[venueId,offsetExpense,offsetSource,offsetTarget])).rows[0];
  assert.deepEqual(allocation,{source:'20.00',destination:'40.00'});
  assert.equal((await call({method:'GET',expenseId:offsetExpense,venueId,userId})).payload.totals.availableToReturn,'20.00','UI refund readback excludes money allocated to other obligations');
  const overRefund = await call({expenseId:offsetExpense,venueId,userId,body:request('20.01',key())});
  assert.equal(overRefund.status,409,JSON.stringify(overRefund.payload));
  assert.equal((await call({expenseId:offsetExpense,venueId,userId,body:request('20.00',key())})).status,201);
  await admin.query("UPDATE finance_payables SET status='cancelled' WHERE id=$1",[offsetSource]);
  await assert.rejects(()=>admin.query("UPDATE finance_payables SET status='cancelled' WHERE id=$1",[offsetTarget]),/finance_payable_has_payments/);
  await offset(admin,offsetTarget,offsetThird,'10.00');
  await assert.rejects(()=>admin.query('UPDATE finance_payable_offsets SET reason=$1 WHERE id=$2',['rewrite',offsetId]),/finance_payable_offsets_append_only/);
  await assert.rejects(()=>admin.query('DELETE FROM finance_payable_offsets WHERE id=$1',[offsetId]),/finance_payable_offsets_append_only/);
  const conserved=(await admin.query('SELECT finance_payable_settled_amount($1,$2)+finance_payable_settled_amount($1,$3)+finance_payable_settled_amount($1,$4) AS total',[venueId,offsetSource,offsetTarget,offsetThird])).rows[0];
  assert.equal(Number(conserved.total),40,'60 cash paid minus 20 returned equals all remaining allocations');
  assert.equal((await admin.query('SELECT amount::text FROM expenses WHERE id=$1',[offsetExpense])).rows[0].amount,'60.00');

  const mixedSource=await offsetDoc('Refund offset race','20.00');
  const mixedExpense=await insert(admin,'expenses',{venue_id:venueId,category:'Аренда',category_id:categoryId,amount:'20.00',expense_date:today,source:'manual',created_by:userId,payment_method:'bank_transfer',finance_account_id:bankId,finance_account_name_snapshot:'QA банк'});
  await insert(admin,'finance_payable_payment_links',{venue_id:venueId,payable_id:mixedSource,expense_id:mixedExpense,applied_amount:'20.00',idempotency_key:key(),created_by:userId});
  const mixedRace=await Promise.all([
    offset(pool,mixedSource,offsetThird,'15.00',null,mixedExpense).then(()=>201,error=>{assert.equal(error.code,'23514');return 409;}),
    call({expenseId:mixedExpense,venueId,userId,body:request('15.00',key())}).then(result=>result.status),
  ]);
  assert.deepEqual(mixedRace.sort(),[201,409],'cash refund and non-cash offset serialize on the same original payment');
  const remaining=(await admin.query('SELECT finance_payable_expense_allocation($1,$2,$3)::text AS amount',[venueId,mixedExpense,mixedSource])).rows[0];
  assert.equal(remaining.amount,'5.00');

  async function domainCall(handler,path,method='GET',body={}) {
    const result={};
    await handler({req:{method,user:{id:userId,role:'owner'}},res:result,url:new URL(path,'http://localhost'),pool,venueId,
      json:(_res,status,payload)=>Object.assign(result,{status,payload}),readBody:async()=>body,hasPermission:()=>true,recordAudit:()=>{}});
    return result;
  }
  const list=await domainCall(handleFinancePayableRoute,`/api/finance/payables?from=${today}&to=${today}`);
  assert.equal(list.status,200,JSON.stringify(list.payload));
  const targetState=list.payload.items.find(item=>item.id===offsetTarget);
  assert.equal(Number(targetState.paidAmount),0);
  assert.equal(Number(targetState.netPaidAmount),0);
  assert.equal(Number(targetState.settledAmount),30);
  assert.equal(Number(targetState.balanceDue),35);
  assert.equal(targetState.paymentStatus,'partially_paid');
  const report=await domainCall(handleFinanceUnifiedReport,`/api/finance/unified-report?from=${today}&to=${today}&source=obligation`);
  assert.equal(report.status,200,JSON.stringify(report.payload));
  const reportedTarget=report.payload.items.obligations.find(item=>item.id===offsetTarget);
  assert.equal(Number(reportedTarget.balanceDue),35);
  assert.equal(Number(reportedTarget.settledAmount),30);
  const payTarget=amount=>domainCall(handleFinancePayableRoute,`/api/finance/payables/${offsetTarget}/payments`,'POST',{amount,paymentDate:today,paymentMethod:'bank_transfer',paymentAccountId:bankId,idempotencyKey:key()});
  assert.equal((await payTarget('35.01')).status,409);
  const finalPayment=await payTarget('35.00');
  assert.equal(finalPayment.status,201,JSON.stringify(finalPayment.payload));
  assert.equal(finalPayment.payload.paidAmount,'35.00','direct payments remain distinct from incoming allocations');
  assert.equal(finalPayment.payload.netPaidAmount,'35.00');
  assert.equal(finalPayment.payload.settledAmount,'65.00');
  assert.equal(finalPayment.payload.balanceDue,'0.00');

  const apiSource=await offsetDoc('API source','30.00');
  const apiTarget=await offsetDoc('API target','40.00');
  const apiExpense=await insert(admin,'expenses',{venue_id:venueId,category:'Аренда',category_id:categoryId,amount:'30.00',expense_date:today,source:'manual',created_by:userId,payment_method:'bank_transfer',finance_account_id:bankId,finance_account_name_snapshot:'QA банк'});
  await insert(admin,'finance_payable_payment_links',{venue_id:venueId,payable_id:apiSource,expense_id:apiExpense,applied_amount:'30.00',idempotency_key:key(),created_by:userId});
  const offsetPath=`/api/finance/payables/${apiSource}/offsets`;
  const offsetPayload={expenseId:apiExpense,destinationPayableId:apiTarget,amount:'20.00',offsetDate:today,reason:'Explicit agreement via API',idempotencyKey:key()};
  const postOffset=payload=>domainCall(handleFinancePayableOffsetRoute,offsetPath,'POST',payload);
  const apiRace=await Promise.all([postOffset(offsetPayload),postOffset(offsetPayload)]);
  assert.deepEqual(apiRace.map(r=>r.status).sort(),[200,201]);
  assert.equal(apiRace[0].payload.id,apiRace[1].payload.id);
  assert.equal((await postOffset({...offsetPayload,amount:'20.01'})).status,409);
  const offsetHistory=await domainCall(handleFinancePayableOffsetRoute,offsetPath);
  assert.equal(offsetHistory.status,200,JSON.stringify(offsetHistory.payload));
  assert.equal(offsetHistory.payload.items.length,1);
  assert.equal(offsetHistory.payload.allocations[0].availableAmount,'10.00');
  const targetHistory=await domainCall(handleFinancePayableOffsetRoute,`/api/finance/payables/${apiTarget}/offsets`);
  assert.equal(targetHistory.payload.allocations[0].expenseId,apiExpense);
  assert.equal(targetHistory.payload.allocations[0].availableAmount,'20.00');
  const reversePath=`${offsetPath}/${apiRace[0].payload.id}/reversals`;
  const reversePayload={amount:'20.00',offsetDate:today,reason:'Reverse agreement',idempotencyKey:key()};
  assert.equal((await domainCall(handleFinancePayableOffsetRoute,reversePath,'POST',reversePayload)).status,201);
  assert.equal((await domainCall(handleFinancePayableOffsetRoute,reversePath,'POST',reversePayload)).status,200);
  assert.equal((await domainCall(handleFinancePayableOffsetRoute,reversePath,'POST',{...reversePayload,amount:'0.01',idempotencyKey:key()})).status,409);
  await admin.query("UPDATE finance_payables SET status='cancelled' WHERE id=$1",[apiTarget]);
  assert.equal((await postOffset(offsetPayload)).status,200,'original exact retry survives later cancellation of target');
  for(const check of [{venue:otherVenue,permissions:['finance'],method:'GET',expected:404},{venue:venueId,permissions:['finance_read'],method:'POST',expected:403}]) {
    const result={};
    await handleFinancePayableOffsetRoute({req:{method:check.method,user:{id:userId,role:'owner'}},res:result,url:new URL(offsetPath,'http://localhost'),pool,venueId:check.venue,json:(_res,status,payload)=>Object.assign(result,{status,payload}),readBody:async()=>offsetPayload,hasPermission:p=>check.permissions.includes(p)});
    assert.equal(result.status,check.expected);
  }

  const advanceGuest=await insert(admin,'guests',{venue_id:venueId,full_name:'QA advance report guest'});
  const advanceBooking=await insert(admin,'reservations',{venue_id:venueId,guest_id:advanceGuest,starts_at:new Date().toISOString(),deposit_paid:'200.00',verified_deposit_paid:'200.00'});
  await insert(admin,'reservations',{venue_id:venueId,guest_id:advanceGuest,starts_at:new Date().toISOString(),deposit_paid:'77.00'});
  const receiptBase={venue_id:venueId,shift_id:shiftId,reason:'QA advance report',actor_id:userId};
  const depositReceipt=await insert(admin,'guest_deposit_receipts',{...receiptBase,guest_id:advanceGuest,amount:'100.00',payment_method:'cash',idempotency_key:key()});
  const depositEntry=await insert(admin,'guest_account_entries',{venue_id:venueId,guest_id:advanceGuest,account_type:'deposit',amount:'100.00',reason:'QA advance report',source_type:'deposit_top_up',source_id:depositReceipt,source_key:key(),actor_id:userId});
  await insert(admin,'guest_account_reversals',{...receiptBase,guest_id:advanceGuest,source_entry_id:depositEntry,account_type:'deposit',amount:'25.00',payout_method:'cash',idempotency_key:key()});
  await insert(admin,'guest_account_reversals',{...receiptBase,guest_id:advanceGuest,source_entry_id:depositEntry,account_type:'deposit',amount:'10.00',payout_method:'wallet',idempotency_key:key()});
  await insert(admin,'guest_account_entries',{venue_id:venueId,guest_id:advanceGuest,account_type:'deposit',amount:'-20.00',reason:'QA advance report internal application',source_type:'order',source_key:key(),actor_id:userId});
  const bookingReceipt=await insert(admin,'reservation_pre_payment_receipts',{...receiptBase,reservation_id:advanceBooking,amount:'200.00',payment_method:'card',idempotency_key:key()});
  await insert(admin,'reservation_pre_payment_receipt_reversals',{...receiptBase,reservation_id:advanceBooking,receipt_id:bookingReceipt,amount:'50.00',payout_method:'card',idempotency_key:key()});
  const advanceReport=await domainCall(handleFinanceUnifiedReport,`/api/finance/unified-report?from=${today}&to=${today}&source=guest_advance&q=${advanceGuest}&categoryId=${categoryId}`);
  assert.equal(advanceReport.status,200,JSON.stringify(advanceReport.payload));
  const advances=advanceReport.payload.items.guestAdvanceCashEvents;
  assert.equal(advances.length,4,'wallet application/reversal and legacy deposit field are not cash events');
  assert.equal(advances.reduce((sum,item)=>sum+Number(item.signedCashFlowAmount),0),225);
  assert.ok(advances.every(item=>item.financeAccountId===null&&item.accountCoverage==='not_recorded'&&item.pnlEffect==='none'));
  assert.equal(advanceReport.payload.coverage.guestAdvances.eventCount,4);
  assert.equal(advanceReport.payload.coverage.guestAdvances.categoryFilterApplied,false);
  assert.equal(advanceReport.payload.coverage.cashAccounts.status,'incomplete');
  const outside=await domainCall(handleFinanceUnifiedReport,`/api/finance/unified-report?from=2000-01-01&to=2000-01-01&source=guest_advance&q=${advanceGuest}`);
  assert.equal(outside.payload.items.guestAdvanceCashEvents.length,0);

  const original = (await admin.query('SELECT amount::text,expense_date::text FROM expenses WHERE venue_id=$1 AND id=$2', [venueId, expenseId])).rows[0];
  assert.deepEqual(original, { amount: '100.00', expense_date: '2026-10-01' }, 'refund does not rewrite the original expense');
  console.log('FINANCE EXPENSE REFUNDS POSTGRES QA: PASS (migration replay, partial and concurrent cap, idempotency, append-only DB guard, account snapshot, tenant isolation, POS shift receipt, unchanged source expense, payable repayment and cancellation with separate recognition reversals)');
} finally {
  await pool?.end();
  if (created) await admin.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => {});
  await admin.end().catch(() => {});
}
