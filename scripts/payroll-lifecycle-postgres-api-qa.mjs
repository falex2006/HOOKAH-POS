import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { validateQaDatabaseUrl, assertQaDatabaseIdentity } from './postgres-qa-safety.mjs';
import { canTransitionPayroll, calculatePayrollAmount, countInclusiveDays, isValidIsoDate } from '../payroll.js';

const databaseUrl = process.env.MIGRATIONS_PG_TEST_DATABASE_URL;
const target = validateQaDatabaseUrl(databaseUrl);
const nonce = randomBytes(12).toString('hex');
const schema = 'payroll_api_' + nonce;
const appRole = 'payroll_role_' + nonce;
const password = randomBytes(24).toString('hex');
const runtimeUrl = new URL(target.url);
runtimeUrl.username = appRole;
runtimeUrl.password = password;
runtimeUrl.searchParams.set('options', '-c search_path=' + schema + ',public');
let created = false;

const require = createRequire(import.meta.url);
const { Client, Pool } = require('pg');
const setup = new Client({ connectionString: databaseUrl });
const pool = new Pool({ connectionString: runtimeUrl.href, max: 4 });
const source = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const start = source.indexOf('const payrollEntryPath = pathname.match(');
const end = source.indexOf("if (pathname === '/api/inventory/auto-orders'", start);
assert.ok(start >= 0 && end > start, 'payroll entry API handlers are available');
const route = source.slice(start, end);
let venueId = null;
let userId = null;
let posUserId = null;
let legacyUserId = null;
let nullRuleUserId = null;

const callApi = async ({ path = '/api/payroll/entries', method = 'GET', body = {}, query = '' }) => {
  let response;
  const pathname = path;
  const result = await new Function('pathname','req','res','url','repositories','venueDbId','denyUnless','body','json','recordAudit','today','isValidIsoDate','countInclusiveDays','calculatePayrollAmount','canTransitionPayroll',
    `return (async()=>{${route}})();`)(
    pathname, { method, user: { id: userId, name: 'Payroll QA' } }, {}, new URL(`http://local${path}${query}`),
    { pool }, venueId, () => false, async () => body,
    (_res, status, data) => { response = { status, data }; return response; }, () => {}, () => '2026-09-27',
    isValidIsoDate, countInclusiveDays, calculatePayrollAmount, canTransitionPayroll,
  );
  return response || result;
};

try {
  await setup.connect();
  const identity = (await setup.query(`SELECT current_database() AS database, inet_server_addr()::text AS address,
    inet_server_port() AS port,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser`)).rows[0];
  assertQaDatabaseIdentity(identity, target.database, Number(target.url.port || 5432));
  // Paid rows are immutable. Remove the isolated fixture schema as a unit.
  await setup.query('BEGIN');
  await setup.query(`CREATE SCHEMA ${schema}`);
  await setup.query(`SET search_path TO ${schema}, public`);
  await setup.query(fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const dir = new URL('../migrations/', import.meta.url);
  for (const file of fs.readdirSync(dir).filter(file => file.endsWith('.sql')).sort()) {
    await setup.query(fs.readFileSync(new URL(file, dir), 'utf8'));
  }
  await setup.query(`CREATE ROLE ${appRole} LOGIN PASSWORD '${password}'`);
  await setup.query(`GRANT USAGE ON SCHEMA ${schema} TO ${appRole}`);
  await setup.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO ${appRole}`);
  await setup.query(`GRANT INSERT, UPDATE ON payroll_entries TO ${appRole}`);
  await setup.query(`GRANT INSERT ON expenses TO ${appRole}`);
  await setup.query(`GRANT UPDATE(id) ON finance_accounts, shifts, users TO ${appRole}`);
  await setup.query('COMMIT');
  created = true;
  const runtime = (await pool.query(`SELECT current_user, current_schema(),
    has_any_column_privilege(current_user,'expenses','UPDATE') AS can_update_expenses`)).rows[0];
  assert.deepEqual(runtime, {current_user:appRole,current_schema:schema,can_update_expenses:false});
  venueId = (await setup.query("INSERT INTO venues (name,timezone) VALUES ('Isolated payroll API QA','Asia/Yekaterinburg') RETURNING id")).rows[0].id;
  userId = (await setup.query(`INSERT INTO users (venue_id,full_name,login,role)
    VALUES ($1,'Payroll QA','payroll-qa-${process.pid}','bartender') RETURNING id`, [venueId])).rows[0].id;
  const ruleId = (await setup.query(`INSERT INTO payroll_rules (venue_id,name,rule_type,rate)
    VALUES ($1,'QA hourly','hourly',500) RETURNING id`, [venueId])).rows[0].id;
  const cashboxId=(await setup.query("SELECT id FROM finance_accounts WHERE venue_id=$1 AND kind='pos_cashbox' AND active=true",[venueId])).rows[0].id;
  const bankAccountId=(await setup.query("INSERT INTO finance_accounts (venue_id,code,name,kind,allowed_payment_methods) VALUES ($1,'qa_payroll_bank','QA bank','bank',ARRAY['bank_transfer']::text[]) RETURNING id",[venueId])).rows[0].id;
  const inactiveAccountId=(await setup.query("INSERT INTO finance_accounts (venue_id,code,name,kind,allowed_payment_methods,active) VALUES ($1,'qa_payroll_inactive','QA inactive','bank',ARRAY['bank_transfer']::text[],false) RETURNING id",[venueId])).rows[0].id;
  await setup.query(`INSERT INTO staff_work_logs (venue_id,user_id,started_at,ended_at,source)
    VALUES ($1,$2,'2026-09-21T05:00:00Z','2026-09-21T13:00:00Z','manual')`, [venueId, userId]);

  const createPayload = { userId, ruleId, periodFrom: '2026-09-01', periodTo: '2026-09-30', amount: 999999 };
  const draft = await callApi({ method: 'POST', body: createPayload });
  assert.equal(draft.status, 201);
  assert.equal(draft.data.status, 'draft');
  assert.equal(draft.data.hours, 8);
  assert.equal(draft.data.amount, 4000, 'payroll uses actual work logs and ignores caller-supplied amount');
  const retriedDraft = await callApi({ method: 'POST', body: createPayload });
  assert.equal(retriedDraft.status, 201);
  assert.equal(retriedDraft.data.id, draft.data.id, 'repeating the same draft request updates one row');

  const entryPath = `/api/payroll/entries/${draft.data.id}`;
  const approved = await callApi({ path: entryPath, method: 'PATCH', body: { action: 'approve' } });
  assert.equal(approved.status, 200);
  assert.equal(approved.data.status, 'approved');
  const overlappingDraft = await callApi({ method: 'POST', body: { userId, ruleId, periodFrom: '2026-09-15', periodTo: '2026-10-15' } });
  assert.equal(overlappingDraft.status, 201);
  const overlapAttempt = await callApi({ path: `/api/payroll/entries/${overlappingDraft.data.id}`, method: 'PATCH', body: { action: 'approve' } });
  assert.equal(overlapAttempt.status, 409);
  assert.equal(overlapAttempt.data.error, 'payroll_period_overlap');

  const missingAccount=await callApi({path:entryPath,method:'PATCH',body:{action:'pay',paymentDate:'2026-09-27',paymentMethod:'bank_transfer'}});
  assert.equal(missingAccount.status,400);
  assert.equal(missingAccount.data.error,'finance_payment_account_required');
  const inactiveAccount=await callApi({path:entryPath,method:'PATCH',body:{action:'pay',paymentDate:'2026-09-27',paymentMethod:'bank_transfer',paymentAccountId:inactiveAccountId}});
  assert.equal(inactiveAccount.status,409);
  assert.equal(inactiveAccount.data.error,'finance_account_inactive');
  const wrongMethod=await callApi({path:entryPath,method:'PATCH',body:{action:'pay',paymentDate:'2026-09-27',paymentMethod:'cash',paymentAccountId:bankAccountId}});
  assert.equal(wrongMethod.status,400);
  assert.equal(wrongMethod.data.error,'finance_payment_method_account_mismatch');
  const payRequest = { path: entryPath, method: 'PATCH', body: {
    action: 'pay', paymentDate: '2026-09-27', paymentAccountId: bankAccountId, paymentMethod: 'bank_transfer'
  } };
  const attempts = await Promise.all([callApi(payRequest), callApi(payRequest)]);
  assert.deepEqual(attempts.map(item => item.status).sort(), [200, 409], 'only one simultaneous payment succeeds');
  const paid = attempts.find(item => item.status === 200);
  assert.equal(paid.status, 200);
  assert.equal(paid.data.status, 'paid');
  assert.ok(paid.data.expense_id, 'payment links the payroll entry to its cashflow expense');
  const replay = await callApi({ path: entryPath, method: 'PATCH', body: { action: 'pay', paymentDate: '2026-09-27',paymentAccountId:bankAccountId,paymentMethod:'bank_transfer' } });
  assert.equal(replay.status, 409, 'paid entries cannot create a second salary expense');
  const expense = await setup.query("SELECT id,amount,source,expense_date,description,payment_method,finance_account_id,finance_account_name_snapshot,shift_id FROM expenses WHERE venue_id=$1 AND source='payroll'", [venueId]);
  assert.equal(expense.rowCount, 1);
  assert.equal(Number(expense.rows[0].amount), 4000);
  assert.equal(expense.rows[0].source, 'payroll');
  assert.equal(expense.rows[0].payment_method,'bank_transfer');
  assert.equal(expense.rows[0].finance_account_id,bankAccountId);
  assert.equal(expense.rows[0].finance_account_name_snapshot,'QA bank');
  assert.equal(expense.rows[0].shift_id,null,'bank payout does not attach to a POS shift');
  assert.equal(expense.rows[0].description, 'Выплата зарплаты за 01.09.2026 — 30.09.2026', 'payroll period uses full Russian calendar dates rather than JavaScript Date text');
  assert.equal((await setup.query('SELECT expense_id,status FROM payroll_entries WHERE id=$1', [draft.data.id])).rows[0].expense_id, expense.rows[0].id);
  const readback=await callApi({path:entryPath,query:'?from=2026-09-01&to=2026-10-31'});
  assert.equal(readback.status,200);
  assert.equal(readback.data.paymentAccountId,bankAccountId);
  assert.equal(readback.data.paymentAccountNameSnapshot,'QA bank');
  assert.equal(readback.data.paymentMethod,'bank_transfer');
  assert.equal(readback.data.shiftId,null);
  assert.equal(readback.data.accountCoverage,'assigned');

  legacyUserId=(await setup.query(`INSERT INTO users (venue_id,full_name,login,role) VALUES ($1,'Payroll legacy QA','payroll-legacy-qa-${process.pid}','bartender') RETURNING id`,[venueId])).rows[0].id;
  await setup.query(`INSERT INTO staff_work_logs (venue_id,user_id,started_at,ended_at,source) VALUES ($1,$2,'2026-09-22T05:00:00Z','2026-09-22T13:00:00Z','manual')`,[venueId,legacyUserId]);
  const legacyDraft=await callApi({method:'POST',body:{userId:legacyUserId,ruleId,periodFrom:'2026-09-01',periodTo:'2026-09-30'}});
  assert.equal(legacyDraft.status,201);
  const legacyPath=`/api/payroll/entries/${legacyDraft.data.id}`;
  assert.equal((await callApi({path:legacyPath,method:'PATCH',body:{action:'approve'}})).status,200);
  const legacyExpenseId = (await setup.query(
    "INSERT INTO expenses(venue_id,category,amount,expense_date,description,source) VALUES($1,'QA',$2,'2026-09-27','Independent expense','manual') RETURNING id",
    [venueId, legacyDraft.data.amount])).rows[0].id;
  await assert.rejects(
    setup.query('UPDATE payroll_entries SET expense_id=$1 WHERE venue_id=$2 AND id=$3', [legacyExpenseId, venueId, legacyDraft.data.id]),
    error => error.code === '23514' && error.message.includes('payroll_expense_reconciliation_required'),
    'an existing cash event cannot be adopted by a new payroll entry');
  const legacyReadback = await callApi({path:legacyPath,query:'?from=2026-09-01&to=2026-10-31'});
  assert.equal(legacyReadback.data.status, 'approved');
  assert.equal((await setup.query('SELECT expense_id FROM payroll_entries WHERE venue_id=$1 AND id=$2',
    [venueId, legacyDraft.data.id])).rows[0].expense_id, null);
  assert.deepEqual((await setup.query('SELECT source,description FROM expenses WHERE venue_id=$1 AND id=$2',
    [venueId, legacyExpenseId])).rows[0], {source:'manual',description:'Independent expense'});
  const settlement = await setup.query('SELECT payroll_settlement_entry_id FROM expenses WHERE id=$1', [paid.data.expense_id]);
  assert.equal(settlement.rows[0].payroll_settlement_entry_id, draft.data.id);
  await assert.rejects(setup.query('UPDATE expenses SET description=$2 WHERE id=$1', [paid.data.expense_id, 'Modified']),
    error => error.code === '55000', 'a paid expense retains its original description');
  await assert.rejects(setup.query('UPDATE payroll_entries SET expense_id=NULL WHERE id=$1', [draft.data.id]),
    error => error.code === '55000', 'a paid payroll entry cannot lose its expense');
  await assert.rejects(setup.query('DELETE FROM payroll_entries WHERE id=$1', [draft.data.id]),
    error => error.code === '55000', 'a paid payroll entry remains available for reconciliation');

  posUserId=(await setup.query(`INSERT INTO users (venue_id,full_name,login,role) VALUES ($1,'Payroll POS QA','payroll-pos-qa-${process.pid}','bartender') RETURNING id`,[venueId])).rows[0].id;
  await setup.query(`INSERT INTO staff_work_logs (venue_id,user_id,started_at,ended_at,source) VALUES ($1,$2,'2026-08-21T05:00:00Z','2026-08-21T13:00:00Z','manual')`,[venueId,posUserId]);
  const posDraft=await callApi({method:'POST',body:{userId:posUserId,ruleId,periodFrom:'2026-08-01',periodTo:'2026-08-31'}});
  assert.equal(posDraft.status,201);
  const posPath=`/api/payroll/entries/${posDraft.data.id}`;
  assert.equal((await callApi({path:posPath,method:'PATCH',body:{action:'approve'}})).status,200);
  const venueToday=(await setup.query('SELECT (now() AT TIME ZONE timezone)::date::text AS date FROM venues WHERE id=$1',[venueId])).rows[0].date;
  const wrongPosDate=await callApi({path:posPath,method:'PATCH',body:{action:'pay',paymentDate:'2026-09-27',paymentAccountId:cashboxId,paymentMethod:'cash'}});
  assert.equal(wrongPosDate.status,409);
  assert.equal(wrongPosDate.data.error,'finance_pos_cash_payment_date_must_be_today');
  const noShift=await callApi({path:posPath,method:'PATCH',body:{action:'pay',paymentDate:venueToday,paymentAccountId:cashboxId,paymentMethod:'cash'}});
  assert.equal(noShift.status,409);
  assert.equal(noShift.data.error,'finance_payment_open_shift_required');
  const shiftId=(await setup.query('INSERT INTO shifts (venue_id,opened_by,opening_cash) VALUES ($1,$2,0) RETURNING id',[venueId,userId])).rows[0].id;
  const posPaid=await callApi({path:posPath,method:'PATCH',body:{action:'pay',paymentDate:venueToday,paymentAccountId:cashboxId,paymentMethod:'cash'}});
  assert.equal(posPaid.status,200);
  const posExpense=(await setup.query("SELECT payment_method,finance_account_id,finance_account_name_snapshot,shift_id FROM expenses WHERE venue_id=$1 AND id=$2",[venueId,posPaid.data.expense_id])).rows[0];
  assert.equal(posExpense.payment_method,'cash');
  assert.equal(posExpense.finance_account_id,cashboxId);
  assert.equal(posExpense.finance_account_name_snapshot,'Основная касса');
  assert.equal(posExpense.shift_id,shiftId,'POS payroll payout joins the exact open shift ledger');

  const cancelled = await callApi({ path: `/api/payroll/entries/${overlappingDraft.data.id}`, method: 'PATCH', body: { action: 'cancel', reason: 'QA draft cancellation' } });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.data.status, 'cancelled');
  const listing = await callApi({ query: '?from=2026-09-01&to=2026-10-31' });
  assert.equal(listing.status, 200);
  assert.deepEqual(listing.data.items.map((item) => item.status).sort(), ['approved','cancelled','paid']);

  nullRuleUserId = (await setup.query(`INSERT INTO users(venue_id,full_name,login,role)
    VALUES($1,'NULL rule QA',$2,'bartender') RETURNING id`,[venueId,'null-rule-qa-'+process.pid])).rows[0].id;
  const nullEntries = (await setup.query(`INSERT INTO payroll_entries(venue_id,user_id,rule_id,period_from,period_to,amount,status)
    VALUES($1,$2,NULL,'2026-06-01','2026-06-15',100,'draft'),
      ($1,$2,NULL,'2026-06-15','2026-06-30',100,'draft') RETURNING id`,[venueId,nullRuleUserId])).rows;
  const approvals = await Promise.all(nullEntries.map(entry=>callApi({path: '/api/payroll/entries/'+entry.id,
    method:'PATCH',body:{action:'approve'}})));
  assert.deepEqual(approvals.map(result=>result.status).sort(),[200,409], 'concurrent NULL-rule inclusive-boundary approval admits only one');
  assert.equal(approvals.find(result=>result.status===409).data.error,'payroll_period_overlap');
  const winner = nullEntries[approvals.findIndex(result=>result.status===200)].id;
  const loser = nullEntries[approvals.findIndex(result=>result.status===409)].id;
  assert.deepEqual((await setup.query('SELECT status FROM payroll_entries WHERE id=ANY($1::uuid[]) ORDER BY status',[nullEntries.map(row=>row.id)])).rows.map(row=>row.status),['approved','draft']);
  // Model already-existing approved legacy overlap. This fixture mutation is
  // intentional: pay must reject it independently of the approval endpoint.
  await setup.query("UPDATE payroll_entries SET status='approved',approved_at=now(),approved_by=$2 WHERE id=$1",[loser,userId]);
  const expenseCount = async () => Number((await setup.query('SELECT count(*) AS n FROM expenses WHERE venue_id=$1',[venueId])).rows[0].n);
  const expensesBefore = await expenseCount();
  const rejectedPay = await callApi({path:'/api/payroll/entries/'+loser,method:'PATCH',
    body:{action:'pay',paymentDate:'2026-09-27',paymentMethod:'bank_transfer',paymentAccountId:bankAccountId}});
  assert.equal(rejectedPay.status,409); assert.equal(rejectedPay.data.error,'payroll_period_overlap');
  assert.equal(rejectedPay.data.conflictingEntryId,winner);
  assert.equal(await expenseCount(),expensesBefore,'NULL-rule pay conflict creates no expense');
  assert.deepEqual((await setup.query('SELECT status,expense_id FROM payroll_entries WHERE id=$1',[loser])).rows[0],{status:'approved',expense_id:null});

  // Legacy fixed monthly pay: settle adjacent halves and reload the two cash events.
  const monthlyRule = (await setup.query(`INSERT INTO payroll_rules(venue_id,name,rule_type,rate)
    VALUES ($1,'Half-month kopeck QA','monthly',100.01) RETURNING id`, [venueId])).rows[0].id;
  const halves = [
    { from: '2025-02-01', to: '2025-02-14', paymentDate: '2025-02-15', amount: 50.01 },
    { from: '2025-02-15', to: '2025-02-28', paymentDate: '2025-03-01', amount: 50 }
  ];
  for (const half of halves) {
    const created = await callApi({method:'POST', body:{userId, ruleId:monthlyRule, periodFrom:half.from, periodTo:half.to}});
    assert.equal(created.status, 201);
    assert.equal(created.data.amount, half.amount);
    const path = '/api/payroll/entries/' + created.data.id;
    assert.equal((await callApi({path,method:'PATCH',body:{action:'approve'}})).status, 200);
    const body = {action:'pay',paymentDate:half.paymentDate,paymentMethod:'bank_transfer',paymentAccountId:bankAccountId};
    assert.equal((await callApi({path,method:'PATCH',body})).status, 200);
    assert.equal((await callApi({path,method:'PATCH',body})).status, 409);
  }
  const monthlyCash = await setup.query(`SELECT COUNT(*)::int AS n,SUM(x.amount)::text AS total
    FROM payroll_entries e JOIN expenses x ON x.id=e.expense_id AND x.venue_id=e.venue_id AND x.payroll_settlement_entry_id=e.id
    WHERE e.venue_id=$1 AND e.rule_id=$2 AND e.status='paid'`, [venueId, monthlyRule]);
  assert.deepEqual(monthlyCash.rows[0], { n:2, total:'100.01' });

  console.log('PAYROLL POSTGRES API QA: PASS (real work logs → calculated draft → approve → overlap guard → one linked salary expense → cancel/list)');
} finally {
  await pool.end();
  try {
    if (created) {
      await setup.query(`DROP SCHEMA ${schema} CASCADE`);
      await setup.query(`DROP ROLE ${appRole}`);
    }
  } finally { await setup.end(); }
}
