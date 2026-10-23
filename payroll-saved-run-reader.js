'use strict';

// Caller owns owner authorization and one repeatable-read transaction on db.
// Reads persisted explanations. Explicit replay uses only saved engine inputs;
// neither reading nor replaying revisits current sources or posts money.
const { createHash } = require('node:crypto');
const { validateCalculatorReplay, executeCalculatorReplay } = require('./payroll-calculator-replay');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{64}$/;
const ENGINE = 'payroll-verified-no-refund-v1';
const CAPABILITY = 'employee_attributed_merchandise_net_no_refund_v1';
const REFUND_ENGINE = 'payroll-verified-remaining-net-v2';
const REFUND_CAPABILITY = 'employee_attributed_remaining_net_refund_v2';
const ENGINES = Object.freeze([ENGINE, REFUND_ENGINE]);
const MAX = BigInt(Number.MAX_SAFE_INTEGER);
class PayrollSavedRunReadError extends Error {
  constructor(code, status = 400) { super(code); this.name = 'PayrollSavedRunReadError'; this.code = code; this.status = status; }
}
const fail = (code, status) => { throw new PayrollSavedRunReadError(`payroll_saved_run_${code}`, status); };
const integrity = () => fail('evidence_invalid', 409);
const object = value => Boolean(value && Object.getPrototypeOf(value) === Object.prototype);
const id = value => { if (typeof value !== 'string' || !UUID.test(value)) fail('invalid_id'); return value.toLowerCase(); };
const client = (db, venueId) => { if (!db || typeof db.query !== 'function') throw new TypeError('payroll_saved_run_client_required'); return id(venueId); };
const integer = value => {
  if (!/^(0|[1-9][0-9]*)$/.test(String(value))) integrity();
  const number = BigInt(value); if (number > MAX) integrity(); return Number(number);
};
const cents = (value, signed = false) => {
  if (typeof value !== 'string' || !(signed ? /^-?(0|[1-9][0-9]*)\.[0-9]{2}$/ : /^(0|[1-9][0-9]*)\.[0-9]{2}$/).test(value)) integrity();
  const negative = value.startsWith('-'), parts = value.replace(/^-/, '').split('.');
  const amount = (BigInt(parts[0]) * 100n + BigInt(parts[1])) * (negative ? -1n : 1n);
  if (amount > MAX || amount < -MAX) integrity(); return Number(amount);
};
const copyObject = value => { if (!object(value)) integrity(); return structuredClone(value); };
const timestamp = field => `to_char(${field} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const queryShape = (query, extra = []) => {
  if (!object(query) || Reflect.ownKeys(query).some(key => !['limit', 'cursor', ...extra].includes(key))
      || Object.values(Object.getOwnPropertyDescriptors(query)).some(d => !Object.hasOwn(d, 'value'))) fail('invalid_query');
};
const queryOptions = (query, scope, extra = []) => {
  queryShape(query, extra);
  if (query.limit !== undefined && !['string', 'number'].includes(typeof query.limit)) fail('invalid_limit');
  const raw = query.limit === undefined ? '25' : String(query.limit);
  if (!/^[1-9][0-9]{0,2}$/.test(raw) || Number(raw) > 100) fail('invalid_limit');
  let cursor = null;
  if (query.cursor !== undefined) {
    if (typeof query.cursor !== 'string' || !/^[A-Za-z0-9_-]{1,1400}$/.test(query.cursor)) fail('invalid_cursor');
    try {
      const decoded = Buffer.from(query.cursor, 'base64url');
      if (decoded.toString('base64url') !== query.cursor) fail('invalid_cursor');
      cursor = JSON.parse(decoded.toString('utf8'));
    } catch (_) { fail('invalid_cursor'); }
    if (!object(cursor) || Object.keys(cursor).sort().join(',') !== 'after,scope' || cursor.scope !== scope
        || !Array.isArray(cursor.after)) fail('invalid_cursor');
  }
  return { limit: Number(raw), after: cursor?.after || null };
};
const encode = (scope, after) => Buffer.from(JSON.stringify({ scope, after })).toString('base64url');
const uuidAfter = after => {
  if (after && (after.length !== 1 || typeof after[0] !== 'string' || !UUID.test(after[0]))) fail('invalid_cursor');
  return after?.[0] || null;
};
const page = (rows, limit, scope, position, map) => ({
  items: rows.slice(0, limit).map(map),
  nextCursor: rows.length > limit ? encode(scope, position(rows[limit - 1])) : null
});
const HEADER = `SELECT r.id,r.venue_id,r.scheme_version_id,r.period_from::text,r.period_to::text,
  r.status,r.source_coverage,r.commission_basis,r.unattributed_line_count,r.missing_net_line_count,
  r.eligible_line_count,r.input_watermark,r.input_checksum,r.engine_version,r.blocked_reason,
  r.created_by_name,${timestamp('r.created_at')} AS created_at,r.venue_timezone,r.currency,
  p.schema_version AS provenance_schema_version,p.capability_version,p.evidence_payload,p.evidence_sha256,p.total_amount_cents::text,
  (SELECT COALESCE(sum(d.final_amount),0)::numeric::text FROM payroll_daily_snapshots d
    WHERE d.venue_id=r.venue_id AND d.run_id=r.id) AS snapshot_total,
  (SELECT count(*)::text FROM payroll_daily_snapshot_lines l
    WHERE l.venue_id=r.venue_id AND l.run_id=r.id) AS snapshot_line_count
  FROM payroll_calculation_runs r LEFT JOIN payroll_run_provenance p ON p.venue_id=r.venue_id AND p.run_id=r.id`;
const verifiedHeader = (row, venueId) => {
  const refundAware = row.engine_version === REFUND_ENGINE;
  const schemaVersion = refundAware ? 2 : 1, capability = refundAware ? REFUND_CAPABILITY : CAPABILITY;
  if (row.venue_id !== venueId || row.status !== 'ready' || !ENGINES.includes(row.engine_version)
      || row.source_coverage !== 'complete' || row.commission_basis !== 'net_after_discounts_refunds'
      || row.unattributed_line_count !== 0 || row.missing_net_line_count !== 0 || row.blocked_reason !== null
      || row.provenance_schema_version !== schemaVersion || row.capability_version !== capability
      || typeof row.evidence_payload !== 'string' || !SHA.test(row.input_checksum || '')
      || row.evidence_sha256 !== row.input_checksum
      || createHash('sha256').update(row.evidence_payload).digest('hex') !== row.input_checksum) integrity();
  let evidence;
  try { evidence = JSON.parse(row.evidence_payload); } catch (_) { integrity(); }
  const total = integer(row.total_amount_cents);
  // Numeric aggregate of an empty set may be returned as "0", unlike numeric(16,2) columns.
  const dailyTotal = cents(row.snapshot_total === '0' ? '0.00' : row.snapshot_total);
  if (!object(evidence) || evidence.schemaVersion !== schemaVersion || evidence.capabilityVersion !== capability
      || evidence.venueId !== venueId || evidence.runId !== row.id || evidence.schemeVersionId !== row.scheme_version_id
      || evidence.period?.from !== row.period_from || evidence.period?.to !== row.period_to
      || evidence.currency !== row.currency || evidence.venueTimezone !== row.venue_timezone
      || evidence.inputWatermark !== row.input_watermark || !SHA.test(evidence.inputWatermark || '')
      || !SHA.test(evidence.calculationWatermark || '') || !SHA.test(evidence.snapshotInputWatermark || '')
      || !SHA.test(evidence.closureWatermark || '') || !object(evidence.sourceEvidence)
      || !object(evidence.schemeSnapshot) || evidence.schemeSnapshot.versionId !== row.scheme_version_id
      || evidence.schemeSnapshot.currency !== row.currency || evidence.totalAmountCents !== total
      || dailyTotal !== total || integer(row.snapshot_line_count) !== row.eligible_line_count) integrity();
  let replay;
  try {
    if (Object.hasOwn(evidence, 'calculatorReplay') && !evidence.calculatorReplay) integrity();
    replay = validateCalculatorReplay(evidence.calculatorReplay, { schemeSnapshot: evidence.schemeSnapshot,
      sourceEvidence: evidence.sourceEvidence, period: evidence.period, currency: evidence.currency });
    if (replay.saved) {
      const amounts = evidence.calculatorReplay.result.employees.map(employee => integer(employee.amountCents));
      if (amounts.reduce((sum, amount) => sum + BigInt(amount), 0n) !== BigInt(total)) integrity();
    }
    if (refundAware) {
      // Version2 sources and typed quantity sidecars must reconstruct exactly.
      // This remains a read-only integrity check, never source/payout authority.
      const { rebuildPayrollRefundAwareRunProvenance } = require('./payroll-refund-aware-provenance');
      const rebuilt = rebuildPayrollRefundAwareRunProvenance(evidence);
      if (rebuilt.provenance.evidence_payload !== row.evidence_payload
          || rebuilt.provenance.evidence_sha256 !== row.evidence_sha256) integrity();
    }
  } catch (_) { integrity(); }
  const scheme = evidence.schemeSnapshot;
  return { header: { schemaVersion: 1, state: 'saved', runId: row.id,
    scheme: { id: scheme.id, versionId: row.scheme_version_id, versionNo: scheme.versionNo, name: scheme.name, mode: scheme.mode },
    period: { from: row.period_from, to: row.period_to }, currency: row.currency, venueTimezone: row.venue_timezone,
    amountCents: total, createdAt: row.created_at, createdByName: row.created_by_name,
    capabilityVersion: capability, officialReady: false, payoutEligible: false, persistence: 'snapshots',
    replayAvailable: replay.compatible, replay }, evidence };
};
const load = async (db, venueId, runId) => {
  const row = (await db.query(`${HEADER} WHERE r.venue_id=$1 AND r.id=$2 AND r.status='ready' AND r.engine_version=ANY($3::text[])`,
    [venueId, runId, ENGINES])).rows[0];
  if (!row) fail('not_found', 404);
  return verifiedHeader(row, venueId);
};
const listSavedRuns = async (db, venueId, query = {}) => {
  venueId = client(db, venueId);
  queryShape(query, ['schemeVersionId']);
  const versionId = query?.schemeVersionId === undefined ? null : id(query.schemeVersionId);
  const scope = `runs:${venueId}:${versionId || '*'}`;
  const { limit, after } = queryOptions(query, scope, ['schemeVersionId']);
  if (after && (after.length !== 2 || typeof after[0] !== 'string'
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(after[0]) || !Number.isFinite(Date.parse(after[0]))
      || new Date(after[0]).toISOString().slice(0, 19) !== after[0].slice(0, 19)
      || typeof after[1] !== 'string' || !UUID.test(after[1]))) fail('invalid_cursor');
  const rows = (await db.query(`${HEADER} WHERE r.venue_id=$1 AND r.status='ready' AND r.engine_version=ANY($2::text[])
    AND ($3::uuid IS NULL OR r.scheme_version_id=$3)
    AND ($4::timestamptz IS NULL OR (r.created_at,r.id)<($4::timestamptz,$5::uuid))
    ORDER BY r.created_at DESC,r.id DESC LIMIT $6`,
  [venueId, ENGINES, versionId, after?.[0] || null, after?.[1] || null, limit + 1])).rows;
  return { schemaVersion: 1, ...page(rows, limit, scope, row => [row.created_at, row.id], row => verifiedHeader(row, venueId).header) };
};
const getSavedRun = async (db, venueId, runId, query = {}) => {
  venueId = client(db, venueId); runId = id(runId);
  const scope = `employees:${venueId}:${runId}`, { limit, after } = queryOptions(query, scope);
  const employeeAfter = uuidAfter(after);
  const { header, evidence } = await load(db, venueId, runId);
  const rows = (await db.query(`SELECT employee_id,
    (array_agg(employee_name_snapshot ORDER BY local_date DESC,id DESC))[1] AS employee_name,
    sum(final_amount)::text AS amount,count(*)::text AS day_count FROM payroll_daily_snapshots
    WHERE venue_id=$1 AND run_id=$2 AND ($3::uuid IS NULL OR employee_id>$3)
    GROUP BY employee_id ORDER BY employee_id LIMIT $4`, [venueId, runId, employeeAfter, limit + 1])).rows;
  const employees = page(rows, limit, scope, row => [row.employee_id], row => ({
    employeeId: row.employee_id, employeeName: row.employee_name, amountCents: cents(row.amount), dayCount: integer(row.day_count)
  }));
  return { ...header, schemeSnapshot: copyObject(evidence.schemeSnapshot), employees: employees.items, nextCursor: employees.nextCursor };
};
const dayDto = row => {
  const money = { venueTurnoverCents: 'venue_turnover', cumulativeVenueTurnoverCents: 'cumulative_venue_turnover',
    basePayCents: 'base_pay', commissionCents: 'commission_pay', teamFundCents: 'team_fund_pay', milestoneBonusCents: 'milestone_bonus',
    itemAdjustmentsCents: 'item_adjustments', amountBeforeCapCents: 'amount_before_cap', capReductionCents: 'cap_reduction',
    amountCents: 'final_amount' };
  return { snapshotId: row.id, employeeId: row.employee_id, employeeName: row.employee_name_snapshot,
    localDate: row.local_date, roleId: row.role_key_snapshot, mode: row.calculation_kind,
    shifts: integer(row.eligible_shift_count), ...Object.fromEntries(Object.entries(money).map(([key, field]) => [key, cents(row[field])])),
    capCents: row.cap_amount === null ? null : cents(row.cap_amount),
    incentive: copyObject(row.incentive_json), explanation: copyObject(row.explanation_json) };
};
const getSavedRunEmployee = async (db, venueId, runId, employeeId) => {
  venueId = client(db, venueId); runId = id(runId); employeeId = id(employeeId);
  const { header } = await load(db, venueId, runId);
  const rows = (await db.query(`SELECT d.*,d.local_date::text AS local_date FROM payroll_daily_snapshots d
    WHERE d.venue_id=$1 AND d.run_id=$2 AND d.employee_id=$3 ORDER BY d.local_date,d.id LIMIT 32`,
  [venueId, runId, employeeId])).rows;
  if (!rows.length) fail('employee_not_found', 404);
  if (rows.length > 31 || rows.some(row => row.venue_id !== venueId || row.run_id !== runId || row.employee_id !== employeeId
      || row.local_date < header.period.from || row.local_date > header.period.to)) integrity();
  const days = rows.map(dayDto), total = days.reduce((sum, day) => sum + BigInt(day.amountCents), 0n);
  return { schemaVersion: 1, state: 'saved', runId, currency: header.currency, employeeId,
    employeeName: days.at(-1).employeeName, amountCents: integer(total.toString()), days,
    officialReady: false, payoutEligible: false, persistence: 'snapshots' };
};
const lineDto = row => ({
  lineId: row.id, snapshotId: row.snapshot_id, orderId: row.order_id, orderItemId: row.order_item_id,
  employeeId: row.employee_id, employeeName: row.employee_name_snapshot, menuItemId: row.menu_item_id,
  menuItemName: row.menu_item_name_snapshot, department: row.department_key, localDate: row.local_date, soldAt: row.sold_at,
  quantity: row.quantity, grossCents: cents(row.gross_amount), discountCents: cents(row.discount_amount),
  refundCents: cents(row.refund_amount), commissionBaseCents: cents(row.commission_base_net),
  appliedRateBps: row.applied_rate_bps, itemRuleId: row.item_rule_id, commissionCents: cents(row.commission_amount),
  mode: row.calculation_kind, commissionKind: row.commission_kind, incentive: copyObject(row.incentive_json),
  costSnapshot: row.cost_snapshot_json === null ? null : copyObject(row.cost_snapshot_json),
  netCostCents: row.net_cost_amount === null ? null : cents(row.net_cost_amount),
  signedMarginCents: row.signed_margin_amount === null ? null : cents(row.signed_margin_amount, true),
  teamPoolSnapshotId: row.team_pool_snapshot_id, poolIncluded: row.pool_included,
  poolBasisCents: row.pool_basis_amount === null ? null : cents(row.pool_basis_amount), poolExclusionReason: row.pool_exclusion_reason
});
const getSavedRunLines = async (db, venueId, runId, snapshotId, query = {}) => {
  venueId = client(db, venueId); runId = id(runId); snapshotId = id(snapshotId);
  const scope = `lines:${venueId}:${runId}:${snapshotId}`, { limit, after } = queryOptions(query, scope);
  const lineAfter = uuidAfter(after), { header } = await load(db, venueId, runId);
  const day = (await db.query(`SELECT id,employee_id,local_date::text FROM payroll_daily_snapshots
    WHERE venue_id=$1 AND run_id=$2 AND id=$3`, [venueId, runId, snapshotId])).rows[0];
  if (!day) fail('day_not_found', 404);
  const rows = (await db.query(`SELECT l.*,l.local_date::text AS local_date,${timestamp('l.sold_at')} AS sold_at
    FROM payroll_daily_snapshot_lines l WHERE l.venue_id=$1 AND l.run_id=$2 AND l.snapshot_id=$3
    AND ($4::uuid IS NULL OR l.id>$4) ORDER BY l.id LIMIT $5`, [venueId, runId, snapshotId, lineAfter, limit + 1])).rows;
  if (rows.some(row => row.venue_id !== venueId || row.run_id !== runId || row.snapshot_id !== snapshotId
      || row.employee_id !== day.employee_id || row.local_date !== day.local_date)) integrity();
  return { schemaVersion: 1, state: 'saved', runId, snapshotId, employeeId: day.employee_id,
    localDate: day.local_date, currency: header.currency,
    ...page(rows, limit, scope, row => [row.id], lineDto), officialReady: false, payoutEligible: false, persistence: 'snapshots' };
};

const replaySavedRun = async (db, venueId, runId) => {
  venueId = client(db, venueId); runId = id(runId);
  const { header, evidence } = await load(db, venueId, runId);
  let result;
  try { result = executeCalculatorReplay(evidence.calculatorReplay); }
  catch (_) { integrity(); }
  // Return verification metadata, never the complete employee/source payload.
  const { result: ignored, ...verification } = result;
  return { schemaVersion: 1, runId, amountCents: header.amountCents, verification,
    officialReady: false, payoutEligible: false, persistence: 'none' };
};

// Server-only evidence access for current-source checks in the caller's existing
// transaction. Routes must never serialize the returned raw evidence.
const loadSavedRunEvidenceInTransaction = (db, venueId, runId) => load(db, client(db, venueId), id(runId));

module.exports = { PayrollSavedRunReadError, listSavedRuns, getSavedRun, getSavedRunEmployee, getSavedRunLines, replaySavedRun,
  loadSavedRunEvidenceInTransaction };
