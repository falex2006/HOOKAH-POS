'use strict';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const METHOD_SET = new Set(['cash', 'card', 'bank_transfer', 'other']);
const SOURCE_SET = new Set(['manual', 'other']);

function respond(json, res, status, body) {
  json(res, status, body);
  return true;
}

function cleanNullableText(value, limit) {
  const cleaned = String(value ?? '').trim();
  return cleaned ? cleaned.slice(0, limit) : null;
}

function normalizePayload(input, isValidIsoDate, validateDocument) {
  const categoryId = String(input.categoryId || '').toLowerCase();
  const paymentAccountId = String(input.paymentAccountId || '').toLowerCase();
  const paymentMethod = String(input.paymentMethod || '');
  const source = String(input.source || 'manual');
  const rawAmount = String(input.amount ?? '').trim();
  const expenseDate = String(input.expenseDate || '');
  const amount = Number(rawAmount);
  const documentUrl = String(input.documentUrl || '');

  if (!UUID_RE.test(categoryId) || !UUID_RE.test(paymentAccountId)
    || !METHOD_SET.has(paymentMethod) || !SOURCE_SET.has(source)
    || !/^\d+(?:\.\d{1,2})?$/.test(rawAmount) || !Number.isFinite(amount)
    || amount <= 0 || amount > 9999999999.99 || !isValidIsoDate(expenseDate)) {
    return { error: 'invalid_expense_draft' };
  }
  const validation = validateDocument(documentUrl);
  if (!validation.valid) return { error: validation.error };

  return {
    payload: {
      categoryId,
      amount: amount.toFixed(2),
      expenseDate,
      counterpartyName: cleanNullableText(input.counterpartyName, 160),
      description: cleanNullableText(input.description, 1000),
      documentUrl: documentUrl || null,
      source,
      paymentAccountId,
      paymentMethod,
    },
  };
}

const DRAFT_SELECT = `SELECT d.id,d.venue_id AS "venueId",d.created_by AS "createdBy",d.updated_by AS "updatedBy",
  d.category_id AS "categoryId",d.category_name_snapshot AS "categoryName",d.amount::text,
  d.expense_date::text AS "expenseDate",d.counterparty_name AS "counterpartyName",d.description,d.document_url AS "documentUrl",
  d.source,d.finance_account_id AS "paymentAccountId",d.finance_account_name_snapshot AS "paymentAccountNameSnapshot",
  d.payment_method AS "paymentMethod",d.status,d.version,d.expense_id AS "expenseId",d.posted_at AS "postedAt",
  d.posted_by AS "postedBy",d.post_idempotency_key AS "postIdempotencyKey",d.posted_version AS "postedVersion",
  d.created_at AS "createdAt",d.updated_at AS "updatedAt"
  FROM finance_expense_drafts d`;

function samePayload(row, payload) {
  const source = row.create_payload || row;
  return String(source.categoryId || source.category_id).toLowerCase() === payload.categoryId
    && Math.round(Number(source.amount) * 100) === Math.round(Number(payload.amount) * 100)
    && String(source.expenseDate || source.expense_date_iso || source.expense_date).slice(0, 10) === payload.expenseDate
    && (source.counterpartyName ?? source.counterparty_name ?? null) === payload.counterpartyName
    && (source.description || null) === payload.description
    && (source.documentUrl ?? source.document_url ?? null) === payload.documentUrl
    && source.source === payload.source
    && String(source.paymentAccountId || source.finance_account_id).toLowerCase() === payload.paymentAccountId
    && String(source.paymentMethod || source.payment_method) === payload.paymentMethod;
}

async function validateReferences(client, venueId, payload) {
  const category = await client.query(
    "SELECT id,name FROM finance_categories WHERE venue_id=$1 AND id=$2 AND active=true AND kind='expense' FOR SHARE",
    [venueId, payload.categoryId],
  );
  if (!category.rows[0]) return { error: 'invalid_finance_category' };

  const account = await client.query(
    'SELECT id,name,kind,allowed_payment_methods,active FROM finance_accounts WHERE venue_id=$1 AND id=$2 FOR SHARE',
    [venueId, payload.paymentAccountId],
  );
  if (!account.rows[0]) return { error: 'finance_account_not_found' };
  if (!account.rows[0].active) return { error: 'finance_account_inactive' };
  if (!account.rows[0].allowed_payment_methods.includes(payload.paymentMethod)) {
    return { error: 'finance_payment_method_account_mismatch' };
  }
  return { category: category.rows[0], account: account.rows[0] };
}

async function handleFinanceExpenseDraftRoute({ req, res, url, pool, venueId, json, readBody, hasPermission, isOperationalEmployee, recordAudit, isValidIsoDate, validateDocument }) {
  const base = '/api/finance/expense-drafts';
  if (url.pathname !== base && !url.pathname.startsWith(`${base}/`)) return false;
  if (!['GET', 'POST', 'PATCH'].includes(req.method)) return respond(json, res, 405, { error: 'method_not_allowed' });
  const canRead = hasPermission('finance') || hasPermission('finance_read');
  if (!canRead) return respond(json, res, 403, { error: 'forbidden', permission: 'finance_read' });
  if (isOperationalEmployee?.(req)) return respond(json, res, 403, { error: 'forbidden', permission: 'finance_read' });
  if (!pool) return respond(json, res, 503, { error: 'finance_expense_drafts_require_database' });

  const relative = url.pathname.slice(base.length).replace(/^\/+/, '');
  const parts = relative ? relative.split('/') : [];
  const id = parts[0] || '';
  const action = parts[1] || '';
  if ((parts.length && !UUID_RE.test(id)) || parts.length > 2 || (action && !['post', 'cancel'].includes(action))) {
    return respond(json, res, 400, { error: 'invalid_expense_draft_path' });
  }

  if (req.method === 'GET') {
    if (parts.length > 1) return respond(json, res, 404, { error: 'expense_draft_not_found' });
    const status = String(url.searchParams.get('status') || 'draft');
    if (!['draft', 'posted', 'cancelled', 'all'].includes(status)) return respond(json, res, 400, { error: 'invalid_expense_draft_status' });
    const rawLimit = Number(url.searchParams.get('limit') || 100);
    if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 100) return respond(json, res, 400, { error: 'invalid_expense_draft_pagination' });
    try {
      const values = [venueId, status, id || null, rawLimit];
      const { rows } = await pool.query(`${DRAFT_SELECT} WHERE d.venue_id=$1 AND ($2::text='all' OR d.status=$2)
        AND ($3::uuid IS NULL OR d.id=$3) ORDER BY CASE WHEN d.status='draft' THEN 0 ELSE 1 END,d.updated_at DESC,d.id LIMIT $4`, values);
      const count = await pool.query(`SELECT COUNT(*)::int AS total FROM finance_expense_drafts d
        WHERE d.venue_id=$1 AND ($2::text='all' OR d.status=$2) AND ($3::uuid IS NULL OR d.id=$3)`, values.slice(0, 3));
      return respond(json, res, 200, { items: rows, totalCount: Number(count.rows[0]?.total || 0), limit: rawLimit });
    } catch (_) {
      return respond(json, res, 503, { error: 'finance_expense_drafts_unavailable' });
    }
  }

  if (!hasPermission('finance')) return respond(json, res, 403, { error: 'forbidden', permission: 'finance' });
  const actorId = String(req.user?.id || '').toLowerCase();
  if (!UUID_RE.test(actorId) || !UUID_RE.test(String(venueId || ''))) return respond(json, res, 403, { error: 'finance_identity_required' });

  if (req.method === 'POST' && !id) {
    if (action) return respond(json, res, 400, { error: 'invalid_expense_draft_path' });
    const input = await readBody(req);
    const normalized = normalizePayload(input, isValidIsoDate, validateDocument);
    if (normalized.error) return respond(json, res, 400, { error: normalized.error });
    const payload = normalized.payload;
    const createKey = String(input.idempotencyKey || '').toLowerCase();
    if (!/^[0-9a-f-]{36}$/i.test(createKey)) return respond(json, res, 400, { error: 'expense_draft_idempotency_key_required' });
    const client = await pool.connect();
    let saved = null;
    let idempotent = false;
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`${venueId}:expense-draft:${actorId}:${createKey}`]);
      const prior = await client.query('SELECT *,expense_date::text AS expense_date_iso FROM finance_expense_drafts WHERE venue_id=$1 AND created_by=$2 AND create_idempotency_key=$3 FOR UPDATE', [venueId, actorId, createKey]);
      if (prior.rows[0]) {
        if (!samePayload(prior.rows[0], payload)) {
          await client.query('ROLLBACK');
          return respond(json, res, 409, { error: 'expense_draft_idempotency_conflict' });
        }
        const current = await client.query(`${DRAFT_SELECT} WHERE d.venue_id=$1 AND d.id=$2`, [venueId, prior.rows[0].id]);
        saved = current.rows[0];
        idempotent = true;
      } else {
        const references = await validateReferences(client, venueId, payload);
        if (references.error) {
          await client.query('ROLLBACK');
          const status = references.error === 'finance_account_not_found' ? 404 : references.error === 'finance_account_inactive' ? 409 : 400;
          return respond(json, res, status, { error: references.error });
        }
        const inserted = await client.query(`INSERT INTO finance_expense_drafts
          (venue_id,created_by,updated_by,category_id,category_name_snapshot,amount,expense_date,counterparty_name,description,document_url,source,finance_account_id,finance_account_name_snapshot,payment_method,create_payload,create_idempotency_key)
          VALUES ($1,$2,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15) RETURNING id`,
        [venueId, actorId, payload.categoryId, references.category.name, payload.amount, payload.expenseDate, payload.counterpartyName,
          payload.description, payload.documentUrl, payload.source, payload.paymentAccountId, references.account.name, payload.paymentMethod, JSON.stringify(payload), createKey]);
        const current = await client.query(`${DRAFT_SELECT} WHERE d.venue_id=$1 AND d.id=$2`, [venueId, inserted.rows[0].id]);
        saved = current.rows[0];
      }
      await client.query('COMMIT');
      if (!idempotent) { try { recordAudit?.(req, 'finance.expense_draft_created', 'finance_expense_draft', saved.id, null, saved); } catch (_) {} }
      return respond(json, res, idempotent ? 200 : 201, { item: saved, idempotent });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      return respond(json, res, error.code === '23505' ? 409 : 503, { error: error.code === '23505' ? 'expense_draft_idempotency_conflict' : 'expense_draft_save_failed' });
    } finally {
      client.release();
    }
  }

  if (!id || !['PATCH', 'POST'].includes(req.method)) return respond(json, res, 405, { error: 'method_not_allowed' });
  if (req.method === 'PATCH' && action) return respond(json, res, 405, { error: 'method_not_allowed' });
  if (req.method === 'POST' && !['post', 'cancel'].includes(action)) return respond(json, res, 405, { error: 'method_not_allowed' });

  const input = await readBody(req);
  const client = await pool.connect();
  let before = null;
  let after = null;
  let expense = null;
  let idempotent = false;
  try {
    await client.query('BEGIN');
    const locked = await client.query('SELECT *,expense_date::text AS expense_date_iso FROM finance_expense_drafts WHERE venue_id=$1 AND id=$2 FOR UPDATE', [venueId, id]);
    before = locked.rows[0];
    if (!before) {
      await client.query('ROLLBACK');
      return respond(json, res, 404, { error: 'expense_draft_not_found' });
    }

    if (req.method === 'PATCH') {
      const expectedVersion = Number(input.expectedVersion);
      if (before.status !== 'draft') {
        await client.query('ROLLBACK');
        return respond(json, res, 409, { error: 'expense_draft_immutable', status: before.status });
      }
      if (!Number.isInteger(expectedVersion) || expectedVersion !== before.version) {
        await client.query('ROLLBACK');
        return respond(json, res, 409, { error: 'expense_draft_version_conflict', currentVersion: before.version });
      }
      const normalized = normalizePayload(input, isValidIsoDate, validateDocument);
      if (normalized.error) {
        await client.query('ROLLBACK');
        return respond(json, res, 400, { error: normalized.error });
      }
      const payload = normalized.payload;
      const references = await validateReferences(client, venueId, payload);
      if (references.error) {
        await client.query('ROLLBACK');
        const status = references.error === 'finance_account_not_found' ? 404 : references.error === 'finance_account_inactive' ? 409 : 400;
        return respond(json, res, status, { error: references.error });
      }
      await client.query(`UPDATE finance_expense_drafts SET category_id=$3,category_name_snapshot=$4,amount=$5,expense_date=$6,counterparty_name=$7,
        description=$8,document_url=$9,source=$10,finance_account_id=$11,finance_account_name_snapshot=$12,payment_method=$13,
        version=version+1,updated_by=$14,updated_at=now() WHERE venue_id=$1 AND id=$2`,
      [venueId, id, payload.categoryId, references.category.name, payload.amount, payload.expenseDate, payload.counterpartyName,
        payload.description, payload.documentUrl, payload.source, payload.paymentAccountId, references.account.name, payload.paymentMethod, actorId]);
    } else if (action === 'cancel') {
      if (before.status !== 'draft') {
        await client.query('ROLLBACK');
        return respond(json, res, 409, { error: 'expense_draft_immutable', status: before.status });
      }
      const expectedVersion = Number(input.expectedVersion);
      if (!Number.isInteger(expectedVersion) || expectedVersion !== before.version) {
        await client.query('ROLLBACK');
        return respond(json, res, 409, { error: 'expense_draft_version_conflict', currentVersion: before.version });
      }
      await client.query("UPDATE finance_expense_drafts SET status='cancelled',cancelled_at=now(),cancelled_by=$3,updated_by=$3,updated_at=now() WHERE venue_id=$1 AND id=$2", [venueId, id, actorId]);
    } else {
      const expectedVersion = Number(input.expectedVersion);
      const postKey = String(input.idempotencyKey || '').toLowerCase();
      if (!/^[0-9a-f-]{36}$/i.test(postKey)) {
        await client.query('ROLLBACK');
        return respond(json, res, 400, { error: 'expense_post_idempotency_key_required' });
      }
      if (before.status === 'posted') {
        if (before.post_idempotency_key === postKey && Number(before.posted_version) === expectedVersion) {
          const result = await client.query('SELECT * FROM expenses WHERE venue_id=$1 AND id=$2', [venueId, before.expense_id]);
          expense = result.rows[0] || null;
          if (!expense) throw new Error('posted_expense_link_missing');
          idempotent = true;
        } else {
          await client.query('ROLLBACK');
          return respond(json, res, 409, { error: 'expense_draft_immutable', status: before.status });
        }
      } else {
        if (before.status !== 'draft') {
          await client.query('ROLLBACK');
          return respond(json, res, 409, { error: 'expense_draft_immutable', status: before.status });
        }
        if (!Number.isInteger(expectedVersion) || expectedVersion !== before.version) {
          await client.query('ROLLBACK');
          return respond(json, res, 409, { error: 'expense_draft_version_conflict', currentVersion: before.version });
        }
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`${venueId}:expense:${postKey}`]);
        const priorExpense = await client.query('SELECT id FROM expenses WHERE venue_id=$1 AND idempotency_key=$2 FOR UPDATE', [venueId, postKey]);
        if (priorExpense.rows[0]) {
          await client.query('ROLLBACK');
          return respond(json, res, 409, { error: 'expense_post_idempotency_conflict' });
        }
        const payload = {
          categoryId: String(before.category_id).toLowerCase(),
          paymentAccountId: String(before.finance_account_id).toLowerCase(),
          paymentMethod: before.payment_method,
          expenseDate: String(before.expense_date_iso).slice(0, 10),
        };
        const references = await validateReferences(client, venueId, payload);
        if (references.error) {
          await client.query('ROLLBACK');
          const status = references.error === 'finance_account_not_found' ? 404 : references.error === 'finance_account_inactive' ? 409 : 400;
          return respond(json, res, status, { error: references.error });
        }
        let shiftId = null;
        if (references.account.kind === 'pos_cashbox') {
          if (before.payment_method !== 'cash') {
            await client.query('ROLLBACK');
            return respond(json, res, 400, { error: 'finance_payment_method_account_mismatch' });
          }
          const dateResult = await client.query('SELECT (now() AT TIME ZONE timezone)::date::text AS date FROM venues WHERE id=$1 FOR SHARE', [venueId]);
          if (String(dateResult.rows[0]?.date || '') !== payload.expenseDate) {
            await client.query('ROLLBACK');
            return respond(json, res, 409, { error: 'finance_pos_cash_payment_date_must_be_today' });
          }
          const shift = await client.query('SELECT id FROM shifts WHERE venue_id=$1 AND closed_at IS NULL FOR UPDATE', [venueId]);
          if (shift.rows.length !== 1) {
            await client.query('ROLLBACK');
            return respond(json, res, 409, { error: 'finance_payment_open_shift_required' });
          }
          shiftId = shift.rows[0].id;
        }
        const inserted = await client.query(`INSERT INTO expenses
          (venue_id,category,category_id,amount,expense_date,counterparty_name,description,source,document_url,created_by,idempotency_key,payment_method,finance_account_id,finance_account_name_snapshot,shift_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
        [venueId, references.category.name, before.category_id, before.amount, payload.expenseDate, before.counterparty_name,
          before.description, before.source, before.document_url, actorId, postKey, before.payment_method, before.finance_account_id, references.account.name, shiftId]);
        expense = inserted.rows[0];
        await client.query(`UPDATE finance_expense_drafts SET status='posted',expense_id=$3,category_name_snapshot=$7,
          finance_account_name_snapshot=$8,posted_at=now(),posted_by=$4,post_idempotency_key=$5,posted_version=$6,
          updated_by=$4,updated_at=now() WHERE venue_id=$1 AND id=$2`,
        [venueId, id, expense.id, actorId, postKey, expectedVersion, references.category.name, references.account.name]);
      }
    }

    const current = await client.query(`${DRAFT_SELECT} WHERE d.venue_id=$1 AND d.id=$2`, [venueId, id]);
    after = current.rows[0];
    await client.query('COMMIT');
    const auditAction = req.method === 'PATCH' ? 'finance.expense_draft_updated' : action === 'cancel' ? 'finance.expense_draft_cancelled' : 'finance.expense_posted';
    if (!idempotent) { try { recordAudit?.(req, auditAction, 'finance_expense_draft', id, before, after); } catch (_) {} }
    return respond(json, res, idempotent ? 200 : action === 'post' ? 201 : 200, { item: after, ...(action === 'post' ? { expense, idempotent } : {}) });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error.code === '23505') return respond(json, res, 409, { error: 'expense_post_idempotency_conflict' });
    if (error.code === '23503') return respond(json, res, 409, { error: 'expense_draft_reference_invalid' });
    return respond(json, res, 503, { error: 'finance_expense_draft_operation_failed' });
  } finally {
    client.release();
  }
}

module.exports = { handleFinanceExpenseDraftRoute };
