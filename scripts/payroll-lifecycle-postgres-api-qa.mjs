import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { canTransitionPayroll, calculatePayrollAmount, countInclusiveDays, isValidIsoDate } from '../payroll.js';

const databaseUrl = process.env.MIGRATIONS_PG_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('Set MIGRATIONS_PG_TEST_DATABASE_URL to an isolated PostgreSQL test database');
assert.match(new URL(databaseUrl).pathname, /(?:test|qa|scratch)/i,
  'refusing test writes unless the database name clearly identifies a test/QA/scratch database');

const require = createRequire(import.meta.url);
const { Client, Pool } = require('pg');
const setup = new Client({ connectionString: databaseUrl });
const pool = new Pool({ connectionString: databaseUrl, max: 4 });
const source = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const start = source.indexOf('const payrollEntryPath = pathname.match(');
const end = source.indexOf("if (pathname === '/api/inventory/auto-orders'", start);
assert.ok(start >= 0 && end > start, 'payroll entry API handlers are available');
const route = source.slice(start, end);
let venueId = null;
let userId = null;
let posUserId = null;
let legacyUserId = null;

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
  const paid = await callApi({ path: entryPath, method: 'PATCH', body: { action: 'pay', paymentDate: '2026-09-27',paymentAccountId:bankAccountId,paymentMethod:'bank_transfer' } });
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
  const legacyExpenseId=(await setup.query(`INSERT INTO expenses(venue_id,category,amount,expense_date,description,source) VALUES($1,'Зарплата',$2,'2026-09-27','Existing unassigned legacy payroll expense','payroll') RETURNING id`,[venueId,legacyDraft.data.amount])).rows[0].id;
  await setup.query('UPDATE payroll_entries SET expense_id=$1 WHERE venue_id=$2 AND id=$3',[legacyExpenseId,venueId,legacyDraft.data.id]);
  const legacyConflict=await callApi({path:legacyPath,method:'PATCH',body:{action:'pay',paymentDate:'2026-09-27',paymentAccountId:bankAccountId,paymentMethod:'bank_transfer'}});
  assert.equal(legacyConflict.status,409);
  assert.equal(legacyConflict.data.error,'payroll_expense_attribution_conflict');
  const legacyReadback=await callApi({path:legacyPath,query:'?from=2026-09-01&to=2026-10-31'});
  assert.equal(legacyReadback.data.status,'approved');
  assert.equal(legacyReadback.data.accountCoverage,'unknown_legacy');
  assert.equal((await setup.query('SELECT count(*)::int AS count FROM expenses WHERE venue_id=$1 AND source=\'payroll\'',[venueId])).rows[0].count,2,'legacy attribution conflict does not create another salary expense');

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

  console.log('PAYROLL POSTGRES API QA: PASS (real work logs → calculated draft → approve → overlap guard → one linked salary expense → cancel/list)');
} finally {
  await pool.end();
  if (setup._connected) {
    if (venueId) {
      await setup.query('DELETE FROM expenses WHERE venue_id=$1', [venueId]).catch(() => {});
      await setup.query('DELETE FROM payroll_entries WHERE venue_id=$1', [venueId]).catch(() => {});
      await setup.query('DELETE FROM staff_work_logs WHERE venue_id=$1', [venueId]).catch(() => {});
      await setup.query('DELETE FROM payroll_rules WHERE venue_id=$1', [venueId]).catch(() => {});
      if (posUserId) await setup.query('DELETE FROM users WHERE id=$1', [posUserId]).catch(() => {});
      if (legacyUserId) await setup.query('DELETE FROM users WHERE id=$1', [legacyUserId]).catch(() => {});
      await setup.query('DELETE FROM finance_accounts WHERE venue_id=$1 AND code IN (\'qa_payroll_bank\',\'qa_payroll_inactive\')', [venueId]).catch(() => {});
      if (userId) await setup.query('DELETE FROM users WHERE id=$1', [userId]).catch(() => {});
      await setup.query('DELETE FROM venues WHERE id=$1', [venueId]).catch(() => {});
    }
    await setup.end();
  }
}
