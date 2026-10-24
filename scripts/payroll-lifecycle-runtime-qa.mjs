import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canTransitionPayroll, calculatePayrollAmount, countInclusiveDays, isValidIsoDate } from '../payroll.js';

const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const start = source.indexOf('const payrollEntryPath = pathname.match(');
const end = source.indexOf("if (pathname === '/api/inventory/auto-orders'", start);
assert.ok(start >= 0 && end > start, 'payroll API block exists and can be isolated');
const payrollBlock = source.slice(start, end);
const userId = '11111111-1111-4111-8111-111111111111';
const ruleId = '22222222-2222-4222-8222-222222222222';
const entryId = '33333333-3333-4333-8333-333333333333';
const paymentAccountId = '44444444-4444-4444-8444-444444444444';

const makeDb = ({ failExpenseInsert = false } = {}) => {
  const state = {
    entries: [], expenses: [], audits: [],
    user: { id: userId },
    financeAccount: { id: paymentAccountId, name: 'QA расчётный счёт', kind: 'bank', allowed_payment_methods: ['bank_transfer'], active: true },
    rule: { id: ruleId, name: 'Почасовая', rule_type: 'hourly', rate: '500', active: true },
    logs: [{ hours: 2, shifts: 1 }],
  };
  let nextEntryId = 3;
  let snapshot = null;
  const query = async (inputSql, params = []) => {
    const sql = inputSql.replace(/\s+/g, ' ').trim();
    if (sql === 'BEGIN') { snapshot = structuredClone(state); return { rows: [] }; }
    if (sql === 'COMMIT') { snapshot = null; return { rows: [] }; }
    if (sql === 'ROLLBACK') { if (snapshot) { Object.assign(state, snapshot); snapshot = null; } return { rows: [] }; }
    if (sql.startsWith('SELECT id FROM users')) return { rows: params[0] === userId ? [{ id: userId }] : [] };
    if (sql.startsWith('SELECT * FROM payroll_rules')) return { rows: params[0] === ruleId ? [{ ...state.rule }] : [] };
    if (sql.startsWith('WITH tz AS (SELECT COALESCE(NULLIF(v.timezone')) return { rows: state.logs };
    if (sql.startsWith('INSERT INTO payroll_entries')) {
      const existing = state.entries.find((row) => row.user_id === params[1] && row.rule_id === params[2] && row.period_from === params[3] && row.period_to === params[4]);
      if (existing) { if (existing.status !== 'draft') return { rows: [] }; existing.amount = String(params[5]); return { rows: [{ ...existing }] }; }
      const row = { id: `${String(nextEntryId++).padStart(8, '0')}-3333-4333-8333-333333333333`, venue_id: params[0], user_id: params[1], rule_id: params[2], period_from: params[3], period_to: params[4], amount: String(params[5]), status: 'draft', expense_id: null };
      state.entries.push(row); return { rows: [{ ...row }] };
    }
    if (sql.startsWith('SELECT pg_advisory_xact_lock(hashtext')) return { rows: [] };
    if (sql.startsWith('SELECT id,name,kind,allowed_payment_methods,active FROM finance_accounts')) return { rows: params[1] === paymentAccountId ? [{ ...state.financeAccount }] : [] };
    if (sql.startsWith('SELECT id FROM payroll_entries')) {
      const [venue, employee, ruleIdForCheck, exceptId, from, to] = params;
      const conflict = state.entries.find((row) => row.venue_id === venue && row.user_id === employee && row.rule_id === ruleIdForCheck && row.id !== exceptId && ['approved','paid'].includes(row.status) && row.period_from <= to && row.period_to >= from);
      return { rows: conflict ? [{ id: conflict.id }] : [] };
    }
    if (sql.startsWith('SELECT pe.id,pe.user_id AS')) return { rows: state.entries.map((row) => ({ id: row.id, userId: row.user_id, userName: 'Сотрудник', ruleId: row.rule_id, ruleName: 'Почасовая', ruleType: 'hourly', periodFrom: row.period_from, periodTo: row.period_to, amount: row.amount, status: row.status, paymentDate: row.payment_date || null, expenseId: row.expense_id || null, hours: '2' })) };
    if (sql.startsWith("SELECT *, to_char(period_from,'DD.MM.YYYY')")) return { rows: state.entries.filter((row) => row.id === params[0] && row.venue_id === params[1]).map((row) => ({ ...row, period_from_label: row.period_from.split('-').reverse().join('.'), period_to_label: row.period_to.split('-').reverse().join('.') })) };
    if (sql.startsWith("UPDATE payroll_entries SET status='approved'")) {
      const row = state.entries.find((item) => item.id === params[0] && item.venue_id === params[1]); if (!row) return { rows: [] };
      Object.assign(row, { status: 'approved', approved_by: params[2], approved_at: '2025-09-26T10:00:00.000Z' }); return { rows: [{ ...row }] };
    }
    if (sql.startsWith("UPDATE payroll_entries SET status='cancelled'")) {
      const row = state.entries.find((item) => item.id === params[0] && item.venue_id === params[1]); if (!row) return { rows: [] };
      Object.assign(row, { status: 'cancelled', cancelled_by: params[2], cancellation_reason: params[3], cancelled_at: '2025-09-26T10:00:00.000Z' }); return { rows: [{ ...row }] };
    }
    if (sql.startsWith("INSERT INTO expenses (venue_id,category,category_id,amount,expense_date,description,source,created_by,payment_method,finance_account_id,finance_account_name_snapshot,shift_id)")) {
      if (failExpenseInsert) throw new Error('simulated_expense_insert_failure');
      const row = { id: `expense-${state.expenses.length + 1}`, venue_id: params[0], category: 'Зарплата', amount: params[1], expense_date: params[2], description: params[3], source: 'payroll', payment_method: params[7], finance_account_id: params[8], finance_account_name_snapshot: params[9], shift_id: params[10] }; state.expenses.push(row); return { rows: [{ id: row.id }] };
    }
    if (sql.startsWith('UPDATE expenses SET category=')) {
      const row = state.expenses.find((item) => item.id === params[4] && item.venue_id === params[5]); if (!row) return { rows: [] };
      Object.assign(row, { category: 'Зарплата', amount: params[0], expense_date: params[1], description: params[2], source: 'payroll' }); return { rows: [{ id: row.id }] };
    }
    if (sql.startsWith("UPDATE payroll_entries SET status='paid'")) {
      const row = state.entries.find((item) => item.id === params[0] && item.venue_id === params[1]); if (!row) return { rows: [] };
      Object.assign(row, { status: 'paid', paid_by: params[2], payment_date: params[3], expense_id: params[4], paid_at: '2025-09-26T10:00:00.000Z' }); return { rows: [{ ...row }] };
    }
    throw new Error(`Unexpected payroll SQL: ${sql}`);
  };
  return { state, pool: { query, connect: async () => ({ query, release() {} }) } };
};

const run = async (db, { path = '/api/payroll/entries', method = 'GET', payload = {}, query = '' } = {}) => {
  let response;
  const pathname = path;
  const result = await new Function('pathname','req','res','url','repositories','venueDbId','denyUnless','body','json','recordAudit','today','isValidIsoDate','countInclusiveDays','calculatePayrollAmount','canTransitionPayroll', `return (async()=>{${payrollBlock}})();`)(
    pathname, { method, user: { id: userId, name: 'Владелец' } }, {}, new URL(`http://local${path}${query}`), { pool: db.pool }, 'venue-test', () => false, async () => payload,
    (_res,status,data) => { response = { status, data }; return response; }, (_req,action,_entity,id,before,after) => db.state.audits.push({ action,id,before,after }), () => '2025-09-26', isValidIsoDate, countInclusiveDays, calculatePayrollAmount, canTransitionPayroll,
  );
  return response || result;
};

const db = makeDb();
const created = await run(db, { method: 'POST', payload: { userId, ruleId, periodFrom: '2025-09-01', periodTo: '2025-09-30', amount: 999999 } });
assert.equal(created.status, 201);
const firstEntryId = created.data.id;
assert.equal(Number(created.data.amount), 1000, 'hourly payroll is calculated from time logs rather than caller-supplied amount');
assert.equal(created.data.status, 'draft');
assert.equal(db.state.expenses.length, 0, 'draft creation does not create cash expense');
assert.equal((await run(db, { method: 'POST', payload: { userId, ruleId, periodFrom: '2025-09-01', periodTo: '2025-09-30' } })).status, 201);
assert.equal(db.state.entries.length, 1, 'updating a draft is idempotent for the same employee, rule, and period');

const entryPath = `/api/payroll/entries/${firstEntryId}`;
assert.equal((await run(db, { path: entryPath, method: 'PATCH', payload: { action: 'approve' } })).status, 200);
assert.equal(db.state.entries[0].status, 'approved');
assert.equal(db.state.expenses.length, 0, 'approval accrues payroll cost but does not create a cash movement');
assert.equal((await run(db, { path: entryPath, method: 'PATCH', payload: { action: 'pay', paymentDate: '2025-09-26', paymentAccountId, paymentMethod: 'bank_transfer' } })).status, 200);
assert.equal(db.state.entries[0].status, 'paid');
assert.equal(db.state.expenses.length, 1, 'payment creates exactly one linked cash expense');
assert.equal(db.state.entries[0].expense_id, db.state.expenses[0].id);
assert.equal(db.state.expenses[0].description, 'Выплата зарплаты за 01.09.2025 — 30.09.2025');
assert.equal((await run(db, { path: entryPath, method: 'PATCH', payload: { action: 'pay', paymentDate: '2025-09-26', paymentAccountId, paymentMethod: 'bank_transfer' } })).status, 409);
assert.equal(db.state.expenses.length, 1, 'repeated payment cannot duplicate cash expense');
const listed = await run(db, { query: '?from=2025-09-01&to=2025-09-30' });
assert.equal(listed.status, 200);
assert.equal(listed.data.items[0].status, 'paid');

const overlapDb = makeDb();
const originalPeriod = await run(overlapDb, { method: 'POST', payload: { userId, ruleId, periodFrom: '2025-09-01', periodTo: '2025-09-30' } });
const overlappingPeriod = await run(overlapDb, { method: 'POST', payload: { userId, ruleId, periodFrom: '2025-09-15', periodTo: '2025-10-15' } });
const disjointPeriod = await run(overlapDb, { method: 'POST', payload: { userId, ruleId, periodFrom: '2025-10-01', periodTo: '2025-10-31' } });
assert.notEqual(originalPeriod.data.id, overlappingPeriod.data.id);
assert.notEqual(overlappingPeriod.data.id, disjointPeriod.data.id);
assert.equal((await run(overlapDb, { path: `/api/payroll/entries/${originalPeriod.data.id}`, method: 'PATCH', payload: { action: 'approve' } })).status, 200);
const rejectedOverlap = await run(overlapDb, { path: `/api/payroll/entries/${overlappingPeriod.data.id}`, method: 'PATCH', payload: { action: 'approve' } });
assert.equal(rejectedOverlap.status, 409);
assert.equal(rejectedOverlap.data.error, 'payroll_period_overlap');
assert.equal(overlapDb.state.entries.find((row) => row.id === overlappingPeriod.data.id).status, 'draft', 'overlap remains an editable draft');
// Simulate legacy/directly-created state that bypassed approval validation.
overlapDb.state.entries.find((row) => row.id === overlappingPeriod.data.id).status = 'approved';
const blockedLegacyPayout = await run(overlapDb, { path: `/api/payroll/entries/${originalPeriod.data.id}`, method: 'PATCH', payload: { action: 'pay', paymentDate: '2025-09-30', paymentAccountId, paymentMethod: 'bank_transfer' } });
assert.equal(blockedLegacyPayout.status, 409, 'payout repeats the overlap check for legacy approved rows');
assert.equal(blockedLegacyPayout.data.error, 'payroll_period_overlap');
assert.equal(overlapDb.state.expenses.length, 0, 'overlap rejection does not create a cash expense');
overlapDb.state.entries.find((row) => row.id === overlappingPeriod.data.id).status = 'cancelled';
assert.equal((await run(overlapDb, { path: `/api/payroll/entries/${disjointPeriod.data.id}`, method: 'PATCH', payload: { action: 'approve' } })).status, 200, 'non-overlapping payroll periods can still be approved');

const cancelDb = makeDb();
await run(cancelDb, { method: 'POST', payload: { userId, ruleId, periodFrom: '2025-10-01', periodTo: '2025-10-31' } });
assert.equal((await run(cancelDb, { path: entryPath, method: 'PATCH', payload: { action: 'cancel', reason: 'Начисление создано ошибочно' } })).status, 200);
assert.equal(cancelDb.state.entries[0].status, 'cancelled');
assert.equal(cancelDb.state.expenses.length, 0, 'cancellation creates no cash expense');

const rollbackDb = makeDb({ failExpenseInsert: true });
await run(rollbackDb, { method: 'POST', payload: { userId, ruleId, periodFrom: '2025-11-01', periodTo: '2025-11-30' } });
await run(rollbackDb, { path: entryPath, method: 'PATCH', payload: { action: 'approve' } });
const failedPayment = await run(rollbackDb, { path: entryPath, method: 'PATCH', payload: { action: 'pay', paymentDate: '2025-11-30', paymentAccountId, paymentMethod: 'bank_transfer' } });
assert.equal(failedPayment.status, 409);
assert.equal(rollbackDb.state.entries[0].status, 'approved', 'failed cash-expense insert rolls back the payroll status transition');
assert.equal(rollbackDb.state.expenses.length, 0);

console.log('PAYROLL LIFECYCLE RUNTIME QA: PASS (actual route handlers with transactional PostgreSQL mock; calculation, draft, approve, pay, cancel, idempotence, listing and rollback)');
