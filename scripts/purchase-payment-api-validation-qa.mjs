import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import validation from '../purchase-document-validation.js';

const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const start = source.indexOf("const purchasePaymentPath = pathname.match(");
const end = source.indexOf("if (pathname === '/api/expenses' && req.method === 'GET')", start);
assert.ok(start >= 0 && end > start, 'supplier payment route block exists');
const route = source.slice(start, end);
const documentId = '33333333-3333-4333-8333-333333333333';
const pdfUrl = `data:application/pdf;base64,${Buffer.from('%PDF-1.7\n').toString('base64')}`;

const call = async (documentUrl, paymentAccountId = '44444444-4444-4444-8444-444444444444') => {
  const calls = { saves: [], audits: [] };
  const pathname = `/api/finance/purchase-payables/${documentId}/payments`;
  const req = { method: 'POST', headers: {}, user: { id: '11111111-1111-4111-8111-111111111111' } };
  const result = await new Function(
    'pathname', 'req', 'res', 'repositories', 'venueDbId', 'denyUnless', 'denyUnlessAny',
    'isOperationalEmployee', 'body', 'json', 'recordAudit', 'isValidIsoDate', 'validatePurchasePaymentDocument',
    `return (async()=>{${route}})();`
  )(
    pathname, req, {},
    { purchaseDocuments: { async addPayment(input) { calls.saves.push(input); return { idempotent: false, expenseId: 'expense-1', amount: input.amount, paymentDate: input.paymentDate, paymentMethod: input.paymentMethod, totalPaid: input.amount, balanceDue: 0 }; } } },
    '22222222-2222-4222-8222-222222222222', () => false, () => false, () => false,
    async () => ({ amount: 250, paymentDate: '2026-09-27', paymentMethod: 'bank_transfer', paymentAccountId, idempotencyKey: 'purchase-key-001', documentUrl }),
    (_res, status, data) => ({ status, data }),
    (_req, action, _type, _id, _before, after) => calls.audits.push({ action, after }),
    (value) => /^\d{4}-\d{2}-\d{2}$/.test(value), validation.validateDataUrl
  );
  return { result, calls };
};

for (const badDocument of [
  'https://example.invalid/receipt.pdf',
  'data:image/svg+xml;base64,PHN2Zz4=',
  `data:application/pdf;base64,${Buffer.from([137,80,78,71,13,10,26,10]).toString('base64')}`,
  'data:application/pdf;base64,SGVsbG8=',
]) {
  const { result, calls } = await call(badDocument);
  assert.equal(result.status, 400, 'invalid document is rejected by the actual API route');
  assert.equal(result.data.error, 'invalid_purchase_payment_document');
  assert.equal(calls.saves.length, 0, 'invalid evidence must not create a payment or expense');
  assert.equal(calls.audits.length, 0, 'invalid evidence must not be audited as a completed payment');
}

const accepted = await call(pdfUrl);
assert.equal(accepted.result.status, 201);
assert.equal(accepted.calls.saves.length, 1);
assert.equal(accepted.calls.saves[0].documentUrl, pdfUrl);
assert.equal(accepted.calls.audits.length, 1);

const optional = await call('');
assert.equal(optional.result.status, 201, 'supporting document remains optional');
assert.equal(optional.calls.saves.length, 1);

const missingAccount = await call('', '');
assert.equal(missingAccount.result.status, 400, 'account is required before repository write');
assert.equal(missingAccount.result.data.error, 'finance_payment_account_required');
assert.equal(missingAccount.calls.saves.length, 0);

console.log('PURCHASE PAYMENT API DOCUMENT VALIDATION QA: PASS (invalid evidence blocked before write; valid and optional evidence accepted)');
