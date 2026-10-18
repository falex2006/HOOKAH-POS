import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { handleFinanceExpenseCorrectionRoute } = require('../finance-expense-corrections.js');

const venueId = '11111111-1111-4111-8111-111111111111';
const expenseId = '22222222-2222-4222-8222-222222222222';
const actorId = '33333333-3333-4333-8333-333333333333';
const categoryId = '44444444-4444-4444-8444-444444444444';
const key = '55555555-5555-4555-8555-555555555555';

function expense(overrides = {}) {
  return {
    id: expenseId,
    venueId,
    categoryName: 'Аренда',
    categoryId: '66666666-6666-4666-8666-666666666666',
    amount: '1000.00',
    expenseDate: '2026-10-01',
    description: 'Октябрь',
    counterpartyName: 'Арендодатель',
    documentUrl: null,
    source: 'manual',
    purchaseDocumentId: null,
    paymentAccountId: null,
    paymentAccountNameSnapshot: 'Расчётный счёт',
    paymentMethod: 'bank_transfer',
    shiftId: null,
    payableLinked: false,
    payrollLinked: false,
    ...overrides,
  };
}

class FakePool {
  constructor(row = expense()) { this.row = row; this.corrections = []; this.audit = []; this.expenseUpdates = 0; }
  async query(sql, values = []) {
    if (sql.includes('FROM expenses e WHERE')) return { rows: [this.row] };
    if (sql.includes('FROM finance_expense_corrections WHERE')) return { rows: this.corrections.filter((item) => item.venue_id === values[0] && item.expense_id === values[1]).sort((a, b) => a.sequence - b.sequence) };
    throw new Error(`unexpected pool query: ${sql}`);
  }
  async connect() {
    const pool = this;
    return {
      async query(sql, values = []) {
        if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] };
        if (sql.includes('FROM expenses e WHERE') && sql.includes('FOR UPDATE')) return { rows: pool.row.venueId === values[0] && pool.row.id === values[1] ? [pool.row] : [] };
        if (sql.includes('SELECT id,request_sha256,response_json FROM finance_expense_corrections')) {
          return { rows: pool.corrections.filter((item) => item.venue_id === values[0] && item.expense_id === values[1] && item.idempotency_key === values[2]) };
        }
        if (sql.includes('SELECT id,sequence,idempotency_key,reason,before_snapshot,after_snapshot,amount_delta::text AS amount_delta')) {
          return { rows: pool.corrections.filter((item) => item.venue_id === values[0] && item.expense_id === values[1]).sort((a, b) => a.sequence - b.sequence) };
        }
        if (sql.includes('FROM finance_categories')) return { rows: [{ id: values[1], name: 'Коммунальные расходы' }] };
        if (sql.includes('INSERT INTO finance_expense_corrections')) {
          const row = { id: values[0], venue_id: values[1], expense_id: values[2], sequence: values[3], expected_version: values[4],
            idempotency_key: values[5], request_sha256: values[6], before_snapshot: JSON.parse(values[7]), after_snapshot: JSON.parse(values[8]),
            amount_delta: values[9], reason: values[10], created_by: values[11], created_at: values[12], response_json: JSON.parse(values[13]) };
          pool.corrections.push(row);
          return { rows: [] };
        }
        if (sql.includes('UPDATE expenses')) { pool.expenseUpdates += 1; throw new Error('expense journal must remain immutable'); }
        throw new Error(`unexpected client query: ${sql}`);
      },
      release() {},
    };
  }
}

async function call(pool, { method = 'POST', path = `/api/finance/expenses/${expenseId}/corrections`, body = {}, permissions = ['finance'], role = 'owner', id = actorId } = {}) {
  let result;
  const req = { method, user: { id, role } };
  const res = {};
  const handled = await handleFinanceExpenseCorrectionRoute({
    req, res, url: new URL(`http://local${path}`), pool, venueId,
    json: (_res, status, payload) => { result = { status, payload }; },
    readBody: async () => body,
    hasPermission: (permission) => permissions.includes(permission),
    isOperationalEmployee: (request) => ['bartender', 'hookah_master', 'senior_bartender', 'senior_hookah_master', 'cleaner', 'security', 'technician', 'other_staff'].includes(request.user.role),
    recordAudit: (_req, action) => pool.audit.push(action),
  });
  assert.equal(handled, true);
  return result;
}

const pool = new FakePool();
const payload = { expectedVersion: 0, changes: { amount: '1250.50', categoryId }, reason: 'Уточнена сумма и статья', idempotencyKey: key };
const created = await call(pool, { body: payload });
assert.equal(created.status, 201);
assert.equal(created.payload.expenseId, expenseId);
assert.equal(created.payload.correctionVersion, 1);
assert.equal(created.payload.corrections[0].idempotencyKey, key);
assert.equal(created.payload.original.amount, '1000.00');
assert.equal(created.payload.effective.amount, '1250.50');
assert.equal(created.payload.effective.categoryName, 'Коммунальные расходы');
assert.equal(created.payload.corrections[0].amountDelta, '250.50');
assert.equal(created.payload.canCorrect, true);
assert.deepEqual(pool.audit, ['finance.expense_corrected']);
assert.equal(pool.expenseUpdates, 0);

const replay = await call(pool, { body: payload });
assert.equal(replay.status, 200);
assert.deepEqual(replay.payload, created.payload);
assert.equal(pool.corrections.length, 1);
assert.equal(pool.audit.length, 1);

const keyConflict = await call(pool, { body: { ...payload, changes: { amount: '1251.00' } } });
assert.equal(keyConflict.status, 409);
assert.equal(keyConflict.payload.error, 'finance_expense_correction_idempotency_conflict');

const stale = await call(pool, { body: { ...payload, idempotencyKey: '88888888-8888-4888-8888-888888888888' } });
assert.equal(stale.status, 409);
assert.equal(stale.payload.currentVersion, 1);

const reduced = await call(pool, { body: { expectedVersion: 1, changes: { amount: '900.00' }, reason: 'Скорректирована переплата', idempotencyKey: '99999999-9999-4999-8999-999999999999' } });
assert.equal(reduced.status, 201);
assert.equal(reduced.payload.corrections[1].amountDelta, '-350.50');
assert.equal(reduced.payload.effective.amount, '900.00');

const read = await call(pool, { method: 'GET', path: `/api/finance/expenses/${expenseId}`, permissions: ['finance_read'] });
assert.equal(read.status, 200);
assert.equal(read.payload.effective.amount, '900.00');
assert.equal(read.payload.effective.categoryId, categoryId);
assert.equal(read.payload.corrections.length, 2);

const denied = await call(pool, { method: 'POST', permissions: ['finance_read'], body: payload });
assert.equal(denied.status, 403);
const operational = await call(pool, { method: 'GET', permissions: ['finance_read'], role: 'bartender' });
assert.equal(operational.status, 403);
const linked = await call(new FakePool(expense({ payableLinked: true })), { body: payload });
assert.equal(linked.status, 409);
assert.equal(linked.payload.error, 'finance_expense_correction_not_supported');

console.log('finance expense correction contract passed');
