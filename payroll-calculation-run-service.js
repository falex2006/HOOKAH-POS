'use strict';

// Persists an owner-requested calculation attempt while required primary
// sources are unavailable. This service is intentionally unable to create a
// ready run or any snapshots, payroll entries, or expenses.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{8,120}$/;
const BLOCKED_REASON = [
  'official_payroll_sources_unavailable',
  'Order-line sales attribution, line-level net after discounts and refunds, and approved attendance are not currently available from a verified payroll source adapter.'
].join(': ');
const BLOCKED_WATERMARK_PREFIX = 'blocked-source-attempt-v1:';

class PayrollCalculationRunError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.name = 'PayrollCalculationRunError';
    this.code = code;
    this.status = status;
  }
}

const fail = (code, status) => { throw new PayrollCalculationRunError(code, status); };

const parseDate = (value, code) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail(code, 400);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) fail(code, 400);
  return value;
};

const normalizeRequest = (input) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('payroll_run_input_required', 400);
  const schemeVersionId = String(input.schemeVersionId || '').toLowerCase();
  if (!UUID.test(schemeVersionId)) fail('invalid_payroll_scheme_version_id', 400);
  const periodFrom = parseDate(input.periodFrom, 'invalid_payroll_period_from');
  const periodTo = parseDate(input.periodTo, 'invalid_payroll_period_to');
  if (periodTo < periodFrom) fail('invalid_payroll_period', 400);
  if (periodFrom.slice(0, 7) !== periodTo.slice(0, 7)) fail('payroll_run_must_fit_one_month', 400);
  const idempotencyKey = String(input.idempotencyKey || '');
  if (!IDEMPOTENCY_KEY.test(idempotencyKey)) fail('invalid_payroll_run_idempotency_key', 400);
  return { schemeVersionId, periodFrom, periodTo, idempotencyKey };
};

const assertOwnerAndLoadSourceMetadata = async (db, principal, request) => {
  if (!principal || !UUID.test(String(principal.userId || '')) || !UUID.test(String(principal.venueId || ''))) {
    fail('payroll_run_owner_required', 403);
  }
  const result = await db.query(`SELECT u.id AS actor_id,NULLIF(btrim(u.full_name),'') AS actor_name,
      v.timezone AS venue_timezone,sv.currency AS currency,sv.status AS version_status,
      sv.effective_from::text AS effective_from,sv.effective_to::text AS effective_to
    FROM users u
    JOIN venues v ON v.id=u.venue_id
    JOIN payroll_scheme_versions sv ON sv.venue_id=v.id
    WHERE u.id=$1 AND v.id=$2 AND sv.id=$3
      AND u.role='owner' AND u.is_active=true AND u.deleted_at IS NULL
      AND sv.status IN ('active','retired')
    FOR SHARE OF u,v,sv`, [principal.userId, principal.venueId, request.schemeVersionId]);
  const row = result.rows[0];
  if (!row || !row.actor_name) fail('payroll_run_owner_or_version_unavailable', 403);
  if (request.periodFrom < row.effective_from || (row.effective_to && request.periodTo > row.effective_to)) {
    fail('payroll_run_outside_scheme_version', 409);
  }
  return row;
};

const makeService = (pool) => {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('payroll_calculation_run_pool_required');

  const createBlockedRun = async (principal, input = {}) => {
    const request = normalizeRequest(input);
    const client = await pool.connect();
    try {
      // The source metadata row locks keep the version/venue stable. READ
      // COMMITTED also lets a retry observe a concurrent idempotent insert.
      await client.query('BEGIN');
      const sourceMetadata = await assertOwnerAndLoadSourceMetadata(client, principal, request);
      const inputWatermark = `${BLOCKED_WATERMARK_PREFIX}${request.schemeVersionId}:${request.periodFrom}:${request.periodTo}:${request.idempotencyKey}`;
      const inserted = await client.query(`INSERT INTO payroll_calculation_runs
        (venue_id,scheme_version_id,period_from,period_to,status,source_coverage,commission_basis,
         eligible_line_count,unattributed_line_count,missing_net_line_count,input_watermark,input_checksum,
         engine_version,blocked_reason,idempotency_key,created_by,created_by_name,venue_timezone,currency)
        VALUES ($1,$2,$3,$4,'blocked','unknown','unknown',0,0,0,$5,NULL,'payroll-schemes-v1',$6,$7,$8,$9,$10,$11)
        ON CONFLICT (venue_id,idempotency_key) DO NOTHING
        RETURNING id,venue_id,scheme_version_id,period_from::text,period_to::text,status,
          source_coverage,commission_basis,eligible_line_count,unattributed_line_count,
          missing_net_line_count,input_watermark,input_checksum,engine_version,blocked_reason,
          idempotency_key,created_by,created_by_name,venue_timezone,currency,created_at`, [
        principal.venueId, request.schemeVersionId, request.periodFrom, request.periodTo,
        inputWatermark, BLOCKED_REASON, request.idempotencyKey, sourceMetadata.actor_id,
        sourceMetadata.actor_name, sourceMetadata.venue_timezone, sourceMetadata.currency
      ]);
      let run = inserted.rows[0];
      if (!run) {
        const existing = await client.query(`SELECT id,venue_id,scheme_version_id,period_from::text,period_to::text,status,
            source_coverage,commission_basis,eligible_line_count,unattributed_line_count,
            missing_net_line_count,input_watermark,input_checksum,engine_version,blocked_reason,
            idempotency_key,created_by,created_by_name,venue_timezone,currency,created_at
          FROM payroll_calculation_runs WHERE venue_id=$1 AND idempotency_key=$2 FOR SHARE`,
        [principal.venueId, request.idempotencyKey]);
        run = existing.rows[0];
        if (!run) fail('payroll_run_idempotency_conflict', 409);
        if (run.scheme_version_id !== request.schemeVersionId
            || run.period_from !== request.periodFrom || run.period_to !== request.periodTo
            || run.status !== 'blocked' || run.source_coverage !== 'unknown' || run.commission_basis !== 'unknown'
            || run.input_watermark !== inputWatermark || run.input_checksum !== null
            || run.engine_version !== 'payroll-schemes-v1' || run.currency !== sourceMetadata.currency
            || run.eligible_line_count !== 0 || run.unattributed_line_count !== 0 || run.missing_net_line_count !== 0) {
          fail('payroll_run_idempotency_conflict', 409);
        }
      }
      await client.query('COMMIT');
      return run;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (error instanceof PayrollCalculationRunError) throw error;
      if (error?.code === '23514') fail('payroll_run_configuration_rejected', 409);
      if (error?.code === '23P01') fail('payroll_run_effective_window_conflict', 409);
      if (error?.code === '23503') fail('payroll_run_reference_invalid', 409);
      if (error?.code === '55000') fail('payroll_run_source_not_ready', 409);
      throw Object.assign(new Error('payroll_run_unavailable'), { code: 'payroll_run_unavailable', status: 503 });
    } finally {
      client.release();
    }
  };

  return { createBlockedRun };
};

module.exports = { makePayrollCalculationRunService: makeService, PayrollCalculationRunError };
