import assert from 'node:assert/strict';
import { PurchaseDocumentRepository } from '../db.js';

class FakePool {
  constructor() {
    this.documents = new Map([
      ['posted-doc', { id: 'posted-doc', venueId: 'venue-a', supplierName: 'Поставщик', documentNumber: 'П-1', status: 'posted', totalCost: 1000 }],
      ['cash-doc', { id: 'cash-doc', venueId: 'venue-a', supplierName: 'Поставщик', documentNumber: 'П-3', status: 'posted', totalCost: 100 }],
      ['draft-doc', { id: 'draft-doc', venueId: 'venue-a', supplierName: 'Поставщик', documentNumber: 'П-2', status: 'draft', totalCost: 100 }],
      ['other-venue-doc', { id: 'other-venue-doc', venueId: 'venue-b', supplierName: 'Другой', status: 'posted', totalCost: 500 }],
    ]);
    this.expenses = [];
    this.accounts = new Map([
      ['bank-account', { id: 'bank-account', name: 'Банк', kind: 'bank', allowed_payment_methods: ['bank_transfer','card','other'], active: true }],
      ['pos-account', { id: 'pos-account', name: 'Касса смены', kind: 'pos_cashbox', allowed_payment_methods: ['cash'], active: true }],
    ]);
    this.openShifts = [{ id: 'shift-1' }];
  }
  async query(sql, params = []) {
    if (sql.includes('SELECT id FROM inventory_purchase_documents WHERE id=$1 AND venue_id=$2')) {
      const row = this.documents.get(String(params[0]));
      return { rows: row && row.venueId === params[1] && row.status === 'posted' ? [{ id: row.id }] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes('FROM expenses e') && sql.includes('e.purchase_document_id=$2')) {
      const rows = this.expenses.filter((expense) => expense.venueId === params[0] && expense.purchaseDocumentId === params[1])
        .map((expense) => ({ id: expense.id, amount: expense.amount, paymentDate: expense.expenseDate, paymentMethod: expense.paymentMethod, documentUrl: expense.documentUrl, paymentAccountId: expense.paymentAccountId, paymentAccountNameSnapshot: expense.paymentAccountNameSnapshot, shiftId: expense.shiftId, accountCoverage: expense.paymentAccountId ? 'assigned' : 'unknown_legacy' }));
      return { rows, rowCount: rows.length };
    }
    throw new Error(`Unexpected SQL in fake purchase payment QA: ${sql}`);
  }
  async connect() {
    return { query: async (sql, params = []) => {
      if (/^\s*(BEGIN|COMMIT|ROLLBACK)\b/i.test(sql)) return { rows: [], rowCount: 0 };
      if (sql.includes('FROM inventory_purchase_documents WHERE id=$1 AND venue_id=$2 FOR UPDATE')) {
        const row = this.documents.get(String(params[0]));
        return { rows: row && row.venueId === params[1] ? [{ id: row.id, supplierName: row.supplierName, documentNumber: row.documentNumber, status: row.status }] : [], rowCount: row?.venueId === params[1] ? 1 : 0 };
      }
      if (sql.includes('FROM expenses WHERE venue_id=$1 AND idempotency_key=$2 FOR UPDATE')) {
        const row = this.expenses.find((expense) => expense.venueId === params[0] && expense.idempotencyKey === params[1]);
        return { rows: row ? [{ id: row.id, purchaseDocumentId: row.purchaseDocumentId, amount: row.amount, expenseDate: row.expenseDate, paymentMethod: row.paymentMethod, documentUrl: row.documentUrl, paymentAccountId: row.paymentAccountId }] : [], rowCount: row ? 1 : 0 };
      }
      if (sql.includes('FROM finance_accounts WHERE venue_id=$1 AND id=$2 FOR UPDATE')) return { rows: this.accounts.has(params[1]) ? [this.accounts.get(params[1])] : [], rowCount: this.accounts.has(params[1]) ? 1 : 0 };
      if (sql.includes('AT TIME ZONE timezone')) return { rows: [{ date: '2026-09-27' }], rowCount: 1 };
      if (sql.includes('FROM shifts WHERE venue_id=$1 AND closed_at IS NULL FOR UPDATE')) return { rows: this.openShifts, rowCount: this.openShifts.length };
      if (sql.includes('SELECT COALESCE((SELECT SUM(line_total)')) {
        const doc = this.documents.get(String(params[0]));
        const totalPaid = this.expenses.filter((expense) => expense.venueId === params[1] && expense.purchaseDocumentId === params[0]).reduce((sum, expense) => sum + expense.amount, 0);
        return { rows: [{ totalCost: doc?.totalCost || 0, totalPaid }], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO expenses')) {
        const [venueId, amount, expenseDate, description, documentUrl, createdBy, purchaseDocumentId, idempotencyKey, paymentMethod,,, paymentAccountId, paymentAccountNameSnapshot, shiftId] = params;
        const row = { id: `expense-${this.expenses.length + 1}`, venueId, amount: Number(amount), expenseDate, description, documentUrl, createdBy, purchaseDocumentId, idempotencyKey, paymentMethod, paymentAccountId, paymentAccountNameSnapshot, shiftId };
        this.expenses.push(row);
        return { rows: [{ id: row.id }], rowCount: 1 };
      }
      throw new Error(`Unexpected SQL in fake purchase payment QA: ${sql}`);
    }, release() {} };
  }
}

const pool = new FakePool();
const repo = new PurchaseDocumentRepository(pool);
const base = { id: 'posted-doc', venueId: 'venue-a', paymentDate: '2026-09-27', paymentMethod: 'bank_transfer', paymentAccountId: 'bank-account', documentUrl: '', createdBy: null };
const evidence = 'data:application/pdf;base64,SGVsbG8=';
const first = await repo.addPayment({ ...base, documentUrl: evidence, amount: 250, idempotencyKey: 'payment-key-0001' });
assert.equal(first.totalPaid, 250);
assert.equal(first.balanceDue, 750);
assert.equal(first.idempotent, false);
const retry = await repo.addPayment({ ...base, documentUrl: evidence, amount: 250, idempotencyKey: 'payment-key-0001' });
assert.equal(retry.idempotent, true);
assert.equal(pool.expenses.length, 1, 'an identical retry must not create a duplicate cash movement');
await assert.rejects(repo.addPayment({ ...base, paymentAccountId: 'pos-account', idempotencyKey: 'payment-key-0001' }), /purchase_payment_idempotency_conflict/);
await assert.rejects(repo.addPayment({ ...base, amount: 200, idempotencyKey: 'payment-key-0001' }), /purchase_payment_idempotency_conflict/);
await assert.rejects(repo.addPayment({ ...base, amount: 751, idempotencyKey: 'payment-key-0002' }), /purchase_payment_exceeds_balance/);
assert.equal(pool.expenses.length, 1, 'an overpayment must not write an expense');
const final = await repo.addPayment({ ...base, amount: 750, idempotencyKey: 'payment-key-0003' });
assert.equal(final.totalPaid, 1000);
assert.equal(final.balanceDue, 0);
const history = await repo.listPayments('venue-a', 'posted-doc');
assert.equal(history.length, 2, 'history includes each payment, not just the invoice total');
assert.deepEqual(history.map((payment) => payment.amount), [250, 750]);
assert.equal(history[0].paymentMethod, 'bank_transfer');
assert.equal(history[0].paymentDate, '2026-09-27');
assert.equal(history[0].documentUrl, evidence, 'payment evidence stays attached to its individual settlement');
assert.equal(history[0].paymentAccountId, 'bank-account');
assert.equal(history[0].paymentAccountNameSnapshot, 'Банк');
assert.equal(history[0].shiftId, null, 'external bank payments do not affect POS shifts');
assert.equal(history[0].accountCoverage, 'assigned');
assert.equal(await repo.listPayments('venue-a', 'draft-doc'), null, 'draft invoices cannot expose payable payment history');
assert.equal(await repo.listPayments('venue-b', 'posted-doc'), null, 'invoice history is tenant scoped');
await assert.rejects(repo.addPayment({ ...base, amount: 0.01, idempotencyKey: 'payment-key-0004' }), /purchase_payment_exceeds_balance/);
await assert.rejects(repo.addPayment({ ...base, id: 'draft-doc', amount: 1, idempotencyKey: 'payment-key-0005' }), /purchase_document_not_posted/);
await assert.rejects(repo.addPayment({ ...base, id: 'other-venue-doc', amount: 1, idempotencyKey: 'payment-key-0006' }), /purchase_document_not_found/);
await assert.rejects(repo.addPayment({ ...base, paymentAccountId: 'missing-account', amount: 1, idempotencyKey: 'payment-key-0007' }), /finance_account_not_found/);
await assert.rejects(repo.addPayment({ ...base, paymentAccountId: 'pos-account', paymentMethod: 'bank_transfer', amount: 1, idempotencyKey: 'payment-key-0008' }), /finance_payment_method_account_mismatch/);
const cash = await repo.addPayment({ ...base, id: 'cash-doc', paymentAccountId: 'pos-account', paymentMethod: 'cash', amount: 1, idempotencyKey: 'payment-key-0009' });
assert.equal(cash.shiftId, 'shift-1', 'POS cash purchase payments bind to the open shift');
pool.openShifts = [];
await assert.rejects(repo.addPayment({ ...base, id: 'cash-doc', paymentAccountId: 'pos-account', paymentMethod: 'cash', amount: 1, idempotencyKey: 'payment-key-0010' }), /finance_payment_open_shift_required/);
console.log('PURCHASE PAYMENT REPOSITORY RUNTIME QA: PASS (partial settlement, idempotency, conflict, overpayment, status, payment history, tenant scope)');
