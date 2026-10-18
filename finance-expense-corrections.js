'use strict';

const crypto = require('node:crypto');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MONEY_RE = /^\d+(?:\.\d{1,2})?$/;
const MAX_AMOUNT = 9999999999.99;
const SNAPSHOT_KEYS = ['amount', 'categoryId', 'categoryName', 'counterpartyName', 'description', 'documentUrl'];
const EXPENSE_SELECT = `SELECT e.id,e.venue_id AS "venueId",e.category AS "categoryName",e.category_id AS "categoryId",
  e.amount::text AS amount,e.expense_date::text AS "expenseDate",e.description,e.counterparty_name AS "counterpartyName",
  e.document_url AS "documentUrl",e.source,e.purchase_document_id AS "purchaseDocumentId",
  e.finance_account_id AS "paymentAccountId",e.finance_account_name_snapshot AS "paymentAccountNameSnapshot",
  e.payment_method AS "paymentMethod",e.shift_id AS "shiftId",
  EXISTS(SELECT 1 FROM finance_payable_payment_links l WHERE l.venue_id=e.venue_id AND l.expense_id=e.id) AS "payableLinked",
  EXISTS(SELECT 1 FROM payroll_entries pe WHERE pe.venue_id=e.venue_id AND pe.expense_id=e.id) AS "payrollLinked"
  FROM expenses e`;

function send(json, res, status, body) {
  json(res, status, body);
  return true;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function requestHash(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function toCents(value) {
  const text = String(value ?? '').trim();
  if (!MONEY_RE.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(cents) ? cents : null;
}

function moneyText(cents) {
  const absolute = Math.abs(cents);
  return `${cents < 0 ? '-' : ''}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, '0')}`;
}

function snapshot(row, amount = row.amount, categoryId = row.categoryId, categoryName = row.categoryName) {
  const value = {
    amount: String(amount),
    categoryId: categoryId ? String(categoryId).toLowerCase() : null,
    categoryName: categoryName == null ? null : String(categoryName),
    counterpartyName: row.counterpartyName == null ? null : String(row.counterpartyName),
    description: row.description == null ? null : String(row.description),
    documentUrl: row.documentUrl == null ? null : String(row.documentUrl),
  };
  return Object.fromEntries(SNAPSHOT_KEYS.map((key) => [key, value[key]]));
}

function decodeSnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return Object.fromEntries(SNAPSHOT_KEYS.map((key) => [key, value[key] ?? null]));
}

function detailResponse(expense, correctionRows) {
  const initial = snapshot(expense);
  const corrections = correctionRows.map((row) => ({
    id: row.id,
    sequence: Number(row.sequence),
    idempotencyKey: row.idempotency_key,
    reason: row.reason,
    before: decodeSnapshot(row.before_snapshot),
    after: decodeSnapshot(row.after_snapshot),
    amountDelta: String(row.amount_delta),
    createdBy: row.created_by,
    createdAt: row.created_at,
  }));
  const effective = corrections.length ? corrections[corrections.length - 1].after : initial;
  const canCorrect = ['manual', 'other'].includes(expense.source)
    && !expense.purchaseDocumentId && !expense.payableLinked && !expense.payrollLinked;
  return {
    expenseId: expense.id,
    canCorrect,
    correctionVersion: corrections.length,
    original: {
      id: expense.id,
      amount: initial.amount,
      categoryId: initial.categoryId,
      categoryName: initial.categoryName,
      expenseDate: expense.expenseDate,
      paymentAccountNameSnapshot: expense.paymentAccountNameSnapshot ?? null,
      paymentMethod: expense.paymentMethod ?? null,
      shiftId: expense.shiftId ?? null,
      source: expense.source,
    },
    effective,
    corrections,
  };
}

async function readDetail(client, venueId, id) {
  const found = await client.query(`${EXPENSE_SELECT} WHERE e.venue_id=$1 AND e.id=$2`, [venueId, id]);
  const expense = found.rows[0];
  if (!expense) return null;
  const corrections = await client.query(`SELECT id,sequence,idempotency_key,reason,before_snapshot,after_snapshot,amount_delta::text AS amount_delta,
    created_by,created_at FROM finance_expense_corrections WHERE venue_id=$1 AND expense_id=$2 ORDER BY sequence,id`, [venueId, id]);
  return detailResponse(expense, corrections.rows);
}

function normalizeCorrection(input) {
  const expectedVersion = input?.expectedVersion;
  const reason = String(input?.reason ?? '').trim();
  const idempotencyKey = String(input?.idempotencyKey ?? '').toLowerCase();
  const changes = input?.changes;
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0 || !changes || typeof changes !== 'object' || Array.isArray(changes)) {
    return { error: 'invalid_expense_correction' };
  }
  const keys = Object.keys(changes);
  if (!keys.length || keys.some((key) => !['amount', 'categoryId'].includes(key))) return { error: 'invalid_expense_correction_changes' };
  if (reason.length < 3 || reason.length > 500) return { error: 'invalid_expense_correction_reason' };
  if (!UUID_RE.test(idempotencyKey)) return { error: 'expense_correction_idempotency_key_required' };

  const normalized = {};
  if (Object.hasOwn(changes, 'amount')) {
    const cents = toCents(changes.amount);
    if (cents === null || cents < 1 || cents > MAX_AMOUNT * 100) return { error: 'invalid_expense_correction_amount' };
    normalized.amount = moneyText(cents);
  }
  if (Object.hasOwn(changes, 'categoryId')) {
    const categoryId = String(changes.categoryId ?? '').toLowerCase();
    if (!UUID_RE.test(categoryId)) return { error: 'invalid_expense_correction_category' };
    normalized.categoryId = categoryId;
  }
  return { payload: { expectedVersion, changes: normalized, reason, idempotencyKey } };
}

async function handleFinanceExpenseCorrectionRoute({ req, res, url, pool, venueId, json, readBody, hasPermission, isOperationalEmployee, recordAudit }) {
  const match = url.pathname.match(/^\/api\/finance\/expenses\/([^/]+)(?:\/(corrections))?$/);
  if (!match) return false;
  if (!['GET', 'POST'].includes(req.method)) return send(json, res, 405, { error: 'method_not_allowed' });
  if (!hasPermission('finance_read') && !hasPermission('finance')) return send(json, res, 403, { error: 'forbidden', permission: 'finance_read' });
  if (isOperationalEmployee?.(req)) return send(json, res, 403, { error: 'forbidden', permission: 'finance_read' });
  if (req.method === 'GET' && match[2]) return send(json, res, 405, { error: 'method_not_allowed' });
  if (req.method === 'POST' && !match[2]) return send(json, res, 405, { error: 'method_not_allowed' });
  if (!UUID_RE.test(match[1]) || !UUID_RE.test(String(venueId || ''))) return send(json, res, 404, { error: 'finance_expense_not_found' });
  if (!pool) return send(json, res, 503, { error: 'finance_expense_corrections_require_database' });
  if (req.method === 'POST' && !hasPermission('finance')) return send(json, res, 403, { error: 'forbidden', permission: 'finance' });

  const expenseId = match[1].toLowerCase();
  if (req.method === 'GET') {
    try {
      const detail = await readDetail(pool, venueId, expenseId);
      return detail ? send(json, res, 200, detail) : send(json, res, 404, { error: 'finance_expense_not_found' });
    } catch (_) {
      return send(json, res, 503, { error: 'finance_expense_detail_unavailable' });
    }
  }

  const input = await readBody(req);
  const normalized = normalizeCorrection(input);
  if (normalized.error) return send(json, res, 400, { error: normalized.error });
  const payload = normalized.payload;
  const actorId = String(req.user?.id || '').toLowerCase();
  if (!UUID_RE.test(actorId)) return send(json, res, 403, { error: 'finance_identity_required' });
  const hash = requestHash({ expectedVersion: payload.expectedVersion, changes: payload.changes, reason: payload.reason });
  const client = await pool.connect();
  let commitAttempted = false;
  let beforeData = null;
  let afterData = null;
  try {
    await client.query('BEGIN');
    const locked = await client.query(`${EXPENSE_SELECT} WHERE e.venue_id=$1 AND e.id=$2 FOR UPDATE`, [venueId, expenseId]);
    const expense = locked.rows[0];
    if (!expense) {
      await client.query('ROLLBACK');
      return send(json, res, 404, { error: 'finance_expense_not_found' });
    }
    const eligible = ['manual', 'other'].includes(expense.source)
      && !expense.purchaseDocumentId && !expense.payableLinked && !expense.payrollLinked;
    if (!eligible) {
      await client.query('ROLLBACK');
      return send(json, res, 409, { error: 'finance_expense_correction_not_supported' });
    }

    const prior = await client.query(`SELECT id,request_sha256,response_json FROM finance_expense_corrections
      WHERE venue_id=$1 AND expense_id=$2 AND idempotency_key=$3`, [venueId, expenseId, payload.idempotencyKey]);
    if (prior.rows[0]) {
      if (prior.rows[0].request_sha256 !== hash) {
        await client.query('ROLLBACK');
        return send(json, res, 409, { error: 'finance_expense_correction_idempotency_conflict' });
      }
      commitAttempted = true;
      await client.query('COMMIT');
      const response = prior.rows[0].response_json;
      return send(json, res, 200, typeof response === 'string' ? JSON.parse(response) : response);
    }

    const corrections = await client.query(`SELECT id,sequence,idempotency_key,reason,before_snapshot,after_snapshot,amount_delta::text AS amount_delta,
      created_by,created_at FROM finance_expense_corrections WHERE venue_id=$1 AND expense_id=$2 ORDER BY sequence,id`, [venueId, expenseId]);
    const currentVersion = corrections.rows.length;
    if (payload.expectedVersion !== currentVersion) {
      await client.query('ROLLBACK');
      return send(json, res, 409, { error: 'finance_expense_correction_version_conflict', currentVersion });
    }
    const before = currentVersion ? decodeSnapshot(corrections.rows[currentVersion - 1].after_snapshot) : snapshot(expense);
    let categoryId = before.categoryId;
    let categoryName = before.categoryName;
    if (Object.hasOwn(payload.changes, 'categoryId')) {
      const categoryResult = await client.query(`SELECT id,name FROM finance_categories
        WHERE venue_id=$1 AND id=$2 AND active=true AND kind='expense' FOR SHARE`, [venueId, payload.changes.categoryId]);
      if (!categoryResult.rows[0]) {
        await client.query('ROLLBACK');
        return send(json, res, 400, { error: 'invalid_finance_category' });
      }
      categoryId = String(categoryResult.rows[0].id).toLowerCase();
      categoryName = categoryResult.rows[0].name;
    }
    const amount = Object.hasOwn(payload.changes, 'amount') ? payload.changes.amount : before.amount;
    const after = snapshot(expense, amount, categoryId, categoryName);
    if (canonicalJson(before) === canonicalJson(after)) {
      await client.query('ROLLBACK');
      return send(json, res, 400, { error: 'finance_expense_correction_no_change' });
    }
    const amountDelta = toCents(after.amount) - toCents(before.amount);
    const sequence = currentVersion + 1;
    const correctionId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    beforeData = before;
    afterData = after;
    const history = [...corrections.rows, {
      id: correctionId,
      sequence,
      idempotency_key: payload.idempotencyKey,
      reason: payload.reason,
      before_snapshot: before,
      after_snapshot: after,
      amount_delta: moneyText(amountDelta),
      created_by: actorId,
      created_at: createdAt,
    }];
    const response = detailResponse(expense, history);
    await client.query(`INSERT INTO finance_expense_corrections
      (id,venue_id,expense_id,sequence,expected_version,idempotency_key,request_sha256,before_snapshot,after_snapshot,amount_delta,reason,created_by,created_at,response_json)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12,$13::timestamptz,$14::jsonb)`,
    [correctionId, venueId, expenseId, sequence, payload.expectedVersion, payload.idempotencyKey, hash, JSON.stringify(before), JSON.stringify(after),
      moneyText(amountDelta), payload.reason, actorId, createdAt, JSON.stringify(response)]);
    commitAttempted = true;
    await client.query('COMMIT');
    try { recordAudit?.(req, 'finance.expense_corrected', 'expense', expenseId, beforeData, afterData); } catch (_) {}
    return send(json, res, 201, response);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (commitAttempted) return send(json, res, 503, { error: 'finance_create_result_unknown', idempotencyKey: payload.idempotencyKey });
    if (error.code === '23505') return send(json, res, 409, { error: 'finance_expense_correction_idempotency_conflict' });
    if (error.code === '23503') return send(json, res, 409, { error: 'finance_expense_correction_reference_invalid' });
    return send(json, res, 503, { error: 'finance_expense_correction_failed' });
  } finally {
    client.release();
  }
}

module.exports = { handleFinanceExpenseCorrectionRoute };
