'use strict';

const crypto = require('node:crypto');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const METHODS = new Set(['cash', 'card', 'qr', 'bank_transfer', 'other']);
const MAX_CENTS = 999999999999;

function send(json, res, status, body) { json(res, status, body); return true; }
function isoDate(value) {
  const raw = String(value ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return false;
  const date = new Date(`${raw}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === raw;
}
function cents(value) {
  const text = String(value ?? '').trim();
  if (!/^(?:0|[1-9]\d{0,11})(?:\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  const result = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(result) && result > 0 && result <= MAX_CENTS ? result : null;
}
function money(centsValue) { return `${Math.floor(centsValue / 100)}.${String(centsValue % 100).padStart(2, '0')}`; }
function payloadHash(payload) { return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex'); }
function dateOnly(value) { return value instanceof Date && !Number.isNaN(value.getTime()) ? value.toISOString().slice(0, 10) : String(value ?? '').slice(0, 10); }
function matches(row, expenseId, payload, hash) {
  return row.expense_id === expenseId && row.request_sha256 === hash
    && Number(row.amount_cents) === payload.amountCents
    && dateOnly(row.refund_date) === payload.refundDate
    && row.payment_method === payload.paymentMethod
    && row.finance_account_id === payload.paymentAccountId
    && (row.document_reference || '') === payload.documentReference
    && row.reason === payload.reason;
}

const EXPENSE_SQL = `SELECT e.id,e.source,e.amount::text AS "grossPaid",e.expense_date::text AS "expenseDate",
  e.payment_method AS "sourcePaymentMethod",e.finance_account_id AS "sourceAccountId",e.finance_account_name_snapshot AS "sourceAccountName",
  e.category AS "sourceCategoryName",e.category_id AS "sourceCategoryId",e.counterparty_name AS "counterpartyName",
  e.purchase_document_id AS "purchaseDocumentId",
  EXISTS(SELECT 1 FROM finance_payable_payment_links l WHERE l.venue_id=e.venue_id AND l.expense_id=e.id) AS "payableLinked",
  (SELECT payable_id FROM finance_payable_payment_links l WHERE l.venue_id=e.venue_id AND l.expense_id=e.id) AS "payableId",
  (SELECT finance_payable_expense_allocation(e.venue_id,e.id,l.payable_id)::text FROM finance_payable_payment_links l WHERE l.venue_id=e.venue_id AND l.expense_id=e.id) AS "allocatedToOrigin",
  EXISTS(SELECT 1 FROM payroll_entries p WHERE p.venue_id=e.venue_id AND p.expense_id=e.id) AS "payrollLinked"
  FROM expenses e`;

async function readRefundState(client, venueId, expenseId) {
  const found = await client.query(`${EXPENSE_SQL} WHERE e.venue_id=$1 AND e.id=$2`, [venueId, expenseId]);
  const source = found.rows[0];
  if (!source) return null;
    const { rows } = await client.query(`SELECT id,amount::text AS amount,refund_date::text AS "refundDate",payment_method AS "paymentMethod",
      finance_account_id AS "paymentAccountId",finance_account_name_snapshot AS "paymentAccountNameSnapshot",shift_id AS "shiftId",
      document_reference AS "documentReference",reason,idempotency_key AS "idempotencyKey",created_by AS "createdBy",created_at AS "createdAt"
    FROM finance_expense_refunds WHERE venue_id=$1 AND expense_id=$2 ORDER BY refund_date,created_at,id`, [venueId, expenseId]);
  const grossCents = cents(source.grossPaid) || 0;
  const returnedCents = rows.reduce((sum, item) => sum + (cents(item.amount) || 0), 0);
  const eligible = ['manual', 'other'].includes(source.source) && !source.purchaseDocumentId && (!source.payableLinked || Boolean(source.payableId)) && !source.payrollLinked;
  return {
    expense: {
      id: source.id, source: source.source, payableId: source.payableId || null, expenseDate: String(source.expenseDate).slice(0, 10), grossPaid: source.grossPaid,
      paymentMethod: source.sourcePaymentMethod || null, paymentAccountId: source.sourceAccountId || null,
      paymentAccountNameSnapshot: source.sourceAccountName || null, categoryName: source.sourceCategoryName || null,
      categoryId: source.sourceCategoryId || null, counterpartyName: source.counterpartyName || null,
    },
    eligible,
    refunds: rows,
    totals: {
      grossPaid: money(grossCents), grossReturned: money(returnedCents), availableToReturn: money(Math.max(0, source.payableId ? (cents(source.allocatedToOrigin) || 0) : grossCents - returnedCents)),
    },
    pnlEffect: source.payableId ? 'separate_payable_recognition' : 'not_calculated',
  };
}

async function resolveReceiptAccount(client, { venueId, paymentAccountId, paymentMethod, refundDate }) {
  const localDate = await client.query("SELECT (now() AT TIME ZONE COALESCE(NULLIF(timezone,''),'Europe/Moscow'))::date::text AS today FROM venues WHERE id=$1", [venueId]);
  const today = String(localDate.rows[0]?.today || '');
  if (refundDate > today) return { error: 'finance_expense_refund_date_in_future', status: 409 };
  const { rows } = await client.query(`SELECT id,name,kind,active,allowed_payment_methods AS "allowedPaymentMethods"
    FROM finance_accounts WHERE venue_id=$1 AND id=$2 FOR UPDATE`, [venueId, paymentAccountId]);
  const account = rows[0];
  if (!account) return { error: 'finance_account_not_found', status: 404 };
  if (!account.active) return { error: 'finance_account_inactive', status: 409 };
  if (!(account.allowedPaymentMethods || []).includes(paymentMethod)) return { error: 'finance_payment_method_account_mismatch', status: 400 };
  if (account.kind !== 'pos_cashbox') return { account, shiftId: null };
  if (paymentMethod !== 'cash') return { error: 'finance_payment_method_account_mismatch', status: 400 };
  if (today !== refundDate) return { error: 'finance_pos_cash_payment_date_must_be_today', status: 409 };
  const shift = await client.query('SELECT id FROM shifts WHERE venue_id=$1 AND closed_at IS NULL FOR UPDATE', [venueId]);
  if (shift.rows.length !== 1) return { error: 'finance_payment_open_shift_required', status: 409 };
  return { account, shiftId: shift.rows[0].id };
}

async function handleFinanceExpenseRefundRoute({ req, res, url, pool, venueId, json, readBody, hasPermission, isOperationalEmployee, recordAudit }) {
  const match = url.pathname.match(/^\/api\/finance\/expenses\/([^/]+)\/refunds$/);
  if (!match) return false;
  if (!['GET', 'POST'].includes(req.method)) return send(json, res, 405, { error: 'method_not_allowed' });
  if ((!hasPermission('finance_read') && !hasPermission('finance')) || isOperationalEmployee?.(req)) return send(json, res, 403, { error: 'forbidden', permission: 'finance_read' });
  if (!UUID_RE.test(match[1]) || !UUID_RE.test(String(venueId || ''))) return send(json, res, 404, { error: 'finance_expense_not_found' });
  if (!pool) return send(json, res, 503, { error: 'finance_database_required' });
  if (req.method === 'POST' && !hasPermission('finance')) return send(json, res, 403, { error: 'forbidden', permission: 'finance' });
  const expenseId = match[1].toLowerCase();

  if (req.method === 'GET') {
    try {
      const detail = await readRefundState(pool, venueId, expenseId);
      return detail ? send(json, res, 200, detail) : send(json, res, 404, { error: 'finance_expense_not_found' });
    } catch (_) { return send(json, res, 503, { error: 'finance_expense_refunds_unavailable' }); }
  }

  const input = await readBody(req);
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !['amount', 'refundDate', 'paymentMethod', 'paymentAccountId', 'documentReference', 'reason', 'idempotencyKey'].includes(key))) return send(json, res, 400, { error: 'invalid_finance_expense_refund' });
  const amountCents = cents(input.amount);
  const refundDate = String(input.refundDate || '');
  const paymentMethod = String(input.paymentMethod || '');
  const paymentAccountId = String(input.paymentAccountId || '').toLowerCase();
  const documentReference = String(input.documentReference || '').trim();
  const reason = String(input.reason || '').trim();
  const idempotencyKey = String(input.idempotencyKey || '').toLowerCase();
  if (!amountCents || !isoDate(refundDate) || !METHODS.has(paymentMethod) || !UUID_RE.test(paymentAccountId)
    || reason.length < 3 || reason.length > 500 || documentReference.length > 160 || !UUID_RE.test(idempotencyKey)) return send(json, res, 400, { error: 'invalid_finance_expense_refund' });
  const actorId = String(req.user?.id || '').toLowerCase();
  if (!UUID_RE.test(actorId)) return send(json, res, 403, { error: 'finance_identity_required' });
  const payload = { amountCents, refundDate, paymentMethod, paymentAccountId, documentReference, reason };
  const requestSha256 = payloadHash({ expenseId, ...payload });
  const client = await pool.connect();
  let committed = false;
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`${venueId}:manual-expense-refund:${idempotencyKey}`]);
    const prior = await client.query(`SELECT r.*,r.refund_date::text AS refund_date,round(r.amount*100)::bigint AS amount_cents FROM finance_expense_refunds r
      WHERE r.venue_id=$1 AND r.idempotency_key=$2`, [venueId, idempotencyKey]);
    if (prior.rows[0]) {
      if (!matches(prior.rows[0], expenseId, payload, requestSha256)) { await client.query('ROLLBACK'); return send(json, res, 409, { error: 'finance_expense_refund_idempotency_conflict' }); }
      await client.query('COMMIT');
      const detail = await readRefundState(pool, venueId, expenseId);
      return send(json, res, 200, { ...detail, idempotent: true, createdRefundId: prior.rows[0].id });
    }

    const link=await client.query('SELECT payable_id FROM finance_payable_payment_links WHERE venue_id=$1 AND expense_id=$2',[venueId,expenseId]);
    if(link.rows[0]){
      const parent=await client.query('SELECT status FROM finance_payables WHERE venue_id=$1 AND id=$2 FOR UPDATE',[venueId,link.rows[0].payable_id]);
      if(parent.rows[0]?.status!=='approved'){await client.query('ROLLBACK');return send(json,res,409,{error:'finance_payable_not_approved'});}
    }
    const locked = await client.query(`${EXPENSE_SQL} WHERE e.venue_id=$1 AND e.id=$2 FOR UPDATE`, [venueId, expenseId]);
    const expense = locked.rows[0];
    if (!expense) { await client.query('ROLLBACK'); return send(json, res, 404, { error: 'finance_expense_not_found' }); }
    const eligible = ['manual', 'other'].includes(expense.source) && !expense.purchaseDocumentId && (!expense.payableLinked || Boolean(expense.payableId)) && !expense.payrollLinked;
    if (!eligible) { await client.query('ROLLBACK'); return send(json, res, 409, { error: 'finance_expense_refund_not_supported' }); }
    if (refundDate < String(expense.expenseDate).slice(0, 10)) { await client.query('ROLLBACK'); return send(json, res, 409, { error: 'finance_expense_refund_date_before_expense' }); }
    const returned = await client.query('SELECT COALESCE(SUM(amount),0)::numeric(14,2) AS amount FROM finance_expense_refunds WHERE venue_id=$1 AND expense_id=$2', [venueId, expenseId]);
    const availableCents = Math.max(0, expense.payableId ? (cents(expense.allocatedToOrigin) || 0) : (cents(expense.grossPaid) || 0) - (cents(returned.rows[0]?.amount) || 0));
    if (amountCents > availableCents) { await client.query('ROLLBACK'); return send(json, res, 409, { error: 'finance_expense_refund_exceeds_balance', availableToReturn: money(availableCents) }); }

    const resolved = await resolveReceiptAccount(client, { venueId, paymentAccountId, paymentMethod, refundDate });
    if (resolved.error) { await client.query('ROLLBACK'); return send(json, res, resolved.status, { error: resolved.error }); }
    const inserted = await client.query(`INSERT INTO finance_expense_refunds
      (venue_id,expense_id,amount,refund_date,payment_method,finance_account_id,finance_account_name_snapshot,shift_id,document_reference,reason,idempotency_key,request_sha256,created_by)
      VALUES($1,$2,$3::numeric/100,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
    [venueId, expenseId, amountCents, refundDate, paymentMethod, paymentAccountId, resolved.account.name, resolved.shiftId, documentReference || null, reason, idempotencyKey, requestSha256, actorId]);
    await client.query('COMMIT'); committed = true;
    const detail = await readRefundState(pool, venueId, expenseId);
    recordAudit?.(req, expense.payableId ? 'finance.payable_payment_refunded' : 'finance.manual_expense_refunded', 'finance_expense_refund', inserted.rows[0].id, null, { expenseId, amount: money(amountCents), refundDate, paymentMethod, paymentAccountId, shiftId: resolved.shiftId, reason, documentReference: documentReference || null, payableId: expense.payableId || null, pnlEffect: expense.payableId ? 'separate_payable_recognition' : 'not_calculated' });
    return send(json, res, 201, { ...detail, createdRefundId: inserted.rows[0].id });
  } catch (error) {
    if (!committed) await client.query('ROLLBACK').catch(() => {});
    if (error.code === '23505') {
      const prior = await pool.query('SELECT r.*,r.refund_date::text AS refund_date,round(r.amount*100)::bigint AS amount_cents FROM finance_expense_refunds r WHERE r.venue_id=$1 AND r.idempotency_key=$2', [venueId, idempotencyKey]).catch(() => ({ rows: [] }));
      if (prior.rows[0]) {
        if (!matches(prior.rows[0], expenseId, payload, requestSha256)) return send(json, res, 409, { error: 'finance_expense_refund_idempotency_conflict' });
        const detail = await readRefundState(pool, venueId, expenseId);
        return send(json, res, 200, { ...detail, idempotent: true, createdRefundId: prior.rows[0].id });
      }
    }
    const known = {
      finance_payable_not_approved: 'finance_payable_not_approved',
      finance_expense_refund_not_supported: 'finance_expense_refund_not_supported',
      finance_expense_refund_exceeds_balance: 'finance_expense_refund_exceeds_balance',
      finance_expense_refund_exceeds_allocation: 'finance_expense_refund_exceeds_allocation',
      finance_expense_refund_date_before_expense: 'finance_expense_refund_date_before_expense',
      finance_expense_refund_date_in_future: 'finance_expense_refund_date_in_future',
      finance_pos_cash_payment_date_must_be_today: 'finance_pos_cash_payment_date_must_be_today',
      finance_payment_open_shift_required: 'finance_payment_open_shift_required',
      finance_expense_refund_non_pos_shift_invalid: 'finance_expense_refund_non_pos_shift_invalid',
      finance_account_inactive: 'finance_account_inactive',
      finance_payment_method_account_mismatch: 'finance_payment_method_account_mismatch',
      finance_account_not_found: 'finance_account_not_found',
      finance_account_snapshot_mismatch: 'finance_account_snapshot_mismatch',
    };
    return send(json, res, error.code === '23514' ? 409 : 503, { error: known[error.message] || 'finance_expense_refund_failed' });
  } finally { client.release(); }
}

module.exports = { handleFinanceExpenseRefundRoute };
