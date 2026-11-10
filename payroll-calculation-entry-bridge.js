'use strict';

// Caller owns owner authorization and the source-fenced write transaction.
// A linked draft reserves a full settlement period, but does not authorize pay.
const { createHash } = require('node:crypto');
const { hasPayrollVerifiedWriteSnapshot } = require('./payroll-source-fence');
const { loadSavedRunEvidenceInTransaction } = require('./payroll-saved-run-reader');
const { executeCalculatorReplay, executePayrollH1FixedShiftsReplay } = require('./payroll-calculator-replay');
const { calculatePayrollH1FixedShifts } = require('./payroll-schemes');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[a-f0-9]{64}$/;
const MAX_ENTRY_CENTS = 999999999999n;
const H1_CAPABILITY = 'employee_attributed_h1_fixed_shifts_v1';
const fail = (code, status = 409) => { throw Object.assign(new Error(code), { code, status }); };
const digest = value => createHash('sha256').update(value).digest('hex');
const normalizedId = value => {
  if (typeof value !== 'string' || !UUID.test(value)) fail('invalid_payroll_entry_materialization_request', 400);
  return value.toLowerCase();
};
const normalizeEntryMaterialization = (runId, input) => {
  runId = normalizedId(runId);
  const keys = ['employeeId', 'financeCategoryId', 'idempotencyKey'];
  if (!input || Object.getPrototypeOf(input) !== Object.prototype || Reflect.ownKeys(input).length !== keys.length
      || keys.some(key => !Object.hasOwn(input, key))
      || Object.values(Object.getOwnPropertyDescriptors(input)).some(d => !Object.hasOwn(d, 'value'))
      || typeof input.idempotencyKey !== 'string' || !/^[A-Za-z0-9_.:-]{8,120}$/.test(input.idempotencyKey)) {
    fail('invalid_payroll_entry_materialization_request', 400);
  }
  return { runId, employeeId: normalizedId(input.employeeId),
    financeCategoryId: input.financeCategoryId === null ? null : normalizedId(input.financeCategoryId), idempotencyKey: input.idempotencyKey };
};
const amount = value => {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value) || BigInt(value) > MAX_ENTRY_CENTS) {
    fail('payroll_entry_calculation_amount_invalid');
  }
  return Number(value);
};
const fields = `id,user_id,status,calculation_run_id,calculation_provenance_sha256,
  calculation_gross_cents::text,period_from::text,period_to::text,employee_name_snapshot,
  calculation_scheme_name_snapshot,finance_category_id,(amount*100)::bigint::text AS net_cents,
  expense_id,payment_date::text,to_jsonb(payroll_entries)->>'payroll_half_kind' AS payroll_half_kind`;
// Migration202's immutable request receipt records the materialization basis.
// Preserve its shape and gross amount, including its historical gate fields.
// This receipt is not a live state or authorization response.
const materializationReceiptDto = row => ({ id: row.id, userId: row.user_id, status: row.status,
  origin: 'calculation_run', calculationRunId: row.calculation_run_id, provenanceSha256: row.calculation_provenance_sha256,
  amountCents: amount(row.calculation_gross_cents), periodFrom: row.period_from, periodTo: row.period_to, currency: 'RUB',
  employeeName: row.employee_name_snapshot, schemeName: row.calculation_scheme_name_snapshot,
  financeCategoryId: row.finance_category_id, allowedActions: row.status === 'draft' ? ['cancel'] : [],
  transitionBlockedReason: 'payroll_run_payout_not_enabled', officialReady: false, payoutEligible: false });
const currentEntryDto = row => {
  const grossCents = amount(row.calculation_gross_cents), amountCents = amount(row.net_cents);
  if (amountCents > grossCents) fail('payroll_entry_calculation_amount_invalid');
  const result = { id: row.id, userId: row.user_id, status: row.status,
    origin: 'calculation_run', calculationRunId: row.calculation_run_id, provenanceSha256: row.calculation_provenance_sha256,
    grossCents, amountCents, periodFrom: row.period_from, periodTo: row.period_to, currency: 'RUB',
    employeeName: row.employee_name_snapshot, schemeName: row.calculation_scheme_name_snapshot,
    financeCategoryId: row.finance_category_id, expenseId: row.expense_id || null, paymentDate: row.payment_date || null,
    transitionStateRequired: true, allowedActions: [] };
  if (row.payroll_half_kind === 'h1') result.halfKind = 'h1';
  if (row.monthly_run_id) { result.halfKind = 'h2'; result.monthlyRunId = row.monthly_run_id; }
  return result;
};
// The settlement migration is additive. Keep the base relation unaliased so
// its whole-row projection works on both the old and the upgraded schema.
const entryReadFields = async db => {
  const { rows } = await db.query("SELECT to_regclass('payroll_half_month_settlement_slots') IS NOT NULL AS has_h2_slots");
  if (!rows[0]?.has_h2_slots) return fields;
  return fields + `,(SELECT s.monthly_run_id::text FROM payroll_half_month_settlement_slots s
    WHERE s.venue_id=payroll_entries.venue_id AND s.h2_entry_id=payroll_entries.id) AS monthly_run_id`;
};
const readEntry = async (db, venueId, entryId) => {
  const row = (await db.query(`SELECT ${await entryReadFields(db)} FROM payroll_entries
    WHERE venue_id=$1 AND id=$2 AND calculation_run_id IS NOT NULL`,
    [venueId, entryId])).rows[0];
  if (!row) fail('payroll_entry_calculation_link_invalid');
  return currentEntryDto(row);
};
const isFirstHalfPeriod = period => typeof period?.from === 'string' && /^\d{4}-\d{2}-01$/.test(period.from)
  && period.to === new Date(Date.parse(`${period.from}T00:00:00.000Z`) + 13 * 86400000).toISOString().slice(0, 10);
const GENERIC_H1_SAFE_CAPABILITIES = new Set([
  'employee_attributed_merchandise_net_no_refund_v1',
  'employee_attributed_remaining_net_refund_v2'
]);
const assertGenericH1Safe = (header, evidence, employeeId) => {
  if (!isFirstHalfPeriod(header.period)) return;
  if (!GENERIC_H1_SAFE_CAPABILITIES.has(header.capabilityVersion)) fail('payroll_h1_run_route_required');
  let replay, h1Result;
  try {
    replay = executeCalculatorReplay(evidence.calculatorReplay);
    if (!replay.matched || !replay.replayVerified || !replay.result) fail('payroll_h1_component_check_unavailable');
    h1Result = calculatePayrollH1FixedShifts(replay.replay.input);
  } catch (_) { fail('payroll_h1_component_check_unavailable'); }
  if (h1Result.status !== 'ready' || h1Result.blockers?.length || h1Result.criticalErrors?.length) fail('payroll_h1_component_check_unavailable');
  const standardRows = replay.result.employees.filter(row => row.employeeId === employeeId);
  const h1Rows = h1Result.employees.filter(row => row.employeeId === employeeId);
  const monthlyThresholdMode = replay.result.daily.some(day => (day.employees || []).some(row => row.employeeId === employeeId
    && row.mode === 'final_month_threshold'));
  if (standardRows.length !== 1 || h1Rows.length !== 1 || monthlyThresholdMode
      || standardRows[0].milestoneBonusCents > 0 || h1Rows[0].milestoneBonusCents !== 0
      || standardRows[0].amountCents !== h1Rows[0].amountCents) fail('payroll_h1_deferred_month_component_required');
};
const requestHash = (actor, request, halfKind = null) => digest(JSON.stringify({ venueId: actor.venueId, userId: actor.userId,
  runId: request.runId, employeeId: request.employeeId, financeCategoryId: request.financeCategoryId,
  ...(halfKind ? { halfKind } : {}) }));
const listCalculationEntries = async (db, actor, runId) => {
  runId = normalizedId(runId);
  // Preserve tenant-safe not-found behavior even when a run has no entries.
  await loadSavedRunEvidenceInTransaction(db, actor.venueId, runId, { allowHalfMonth: true });
  const rows = (await db.query(`SELECT ${await entryReadFields(db)} FROM payroll_entries
    WHERE venue_id=$1 AND calculation_run_id=$2 ORDER BY user_id`,
    [actor.venueId, runId])).rows;
  return { schemaVersion: 1, items: rows.map(currentEntryDto) };
};
const materializeEntry = async (db, actor, request, checkFreshness, halfKind = null, { allowHalfMonth = false } = {}) => {
  if (!hasPayrollVerifiedWriteSnapshot(db, actor.venueId)) fail('payroll_entry_source_transaction_required');
  const hash = requestHash(actor, request, halfKind);
  const previous = (await db.query(`SELECT request_hash,response_payload,response_sha256,entry_id FROM payroll_calculation_entry_requests
    WHERE venue_id=$1 AND idempotency_key=$2`, [actor.venueId, request.idempotencyKey])).rows[0];
  if (previous) {
    if (previous.request_hash !== hash) fail('payroll_entry_idempotency_conflict');
    if (typeof previous.response_payload !== 'string' || digest(previous.response_payload) !== previous.response_sha256) fail('payroll_entry_request_integrity_invalid');
    let result;
    try { result = JSON.parse(previous.response_payload); } catch (_) { fail('payroll_entry_request_integrity_invalid'); }
    const currentEntry = await readEntry(db, actor.venueId, previous.entry_id);
    if (result.entry?.id !== currentEntry.id || currentEntry.calculationRunId !== request.runId
        || currentEntry.userId !== request.employeeId) fail('payroll_entry_request_integrity_invalid');
    if (halfKind === 'h1') {
      const claim = (await db.query(`SELECT entry_id FROM payroll_half_month_claims
        WHERE venue_id=$1 AND employee_id=$2 AND month_from=$3::date AND run_id=$4 AND entry_id=$5
          AND provenance_sha256=$6`, [actor.venueId, request.employeeId, request.h1MonthFrom, request.runId,
        currentEntry.id, currentEntry.provenanceSha256])).rows[0];
      if (!claim || currentEntry.periodFrom !== request.h1MonthFrom
          || currentEntry.periodTo !== request.h1PeriodTo) fail('payroll_h1_existing_entry_unbound');
    }
    // Return the exact historical outcome and separately expose the current
    // amount/status. A lost-response retry performs no lifecycle transition.
    return { ...result, replayed: true, currentEntry };
  }
  const existing = (await db.query(`SELECT ${await entryReadFields(db)} FROM payroll_entries
    WHERE venue_id=$1 AND calculation_run_id=$2 AND user_id=$3`, [actor.venueId, request.runId, request.employeeId])).rows[0];
  const saved = await loadSavedRunEvidenceInTransaction(db, actor.venueId, request.runId, { allowHalfMonth });
  if (saved.header.capabilityVersion === H1_CAPABILITY && halfKind !== 'h1') fail('payroll_h1_entry_route_required');
  if (halfKind === 'h1' && saved.header.capabilityVersion !== H1_CAPABILITY) fail('payroll_h1_verified_run_required');
  if (!halfKind) assertGenericH1Safe(saved.header, saved.evidence, request.employeeId);
  let entry, currentEntry;
  if (existing) {
    if (halfKind === 'h1') {
      const claim = (await db.query(`SELECT entry_id FROM payroll_half_month_claims
        WHERE venue_id=$1 AND employee_id=$2 AND month_from=$3::date AND run_id=$4 AND entry_id=$5`,
      [actor.venueId, request.employeeId, request.h1MonthFrom, request.runId, existing.id])).rows[0];
      if (!claim || existing.period_from !== request.h1MonthFrom || existing.period_to !== request.h1PeriodTo) {
        fail('payroll_h1_existing_entry_unbound');
      }
    }
    if (existing.finance_category_id !== request.financeCategoryId) fail('payroll_entry_existing_category_conflict');
    entry = materializationReceiptDto(existing);
    currentEntry = currentEntryDto(existing);
  } else {
    const { header, evidence } = saved;
    let replay;
    try { replay = halfKind === 'h1' ? executePayrollH1FixedShiftsReplay(evidence.calculatorReplay)
      : executeCalculatorReplay(evidence.calculatorReplay); } catch (_) { fail('payroll_entry_replay_required'); }
    if (!replay.matched || !replay.replayVerified || header.currency !== 'RUB') fail('payroll_entry_replay_required');
    const employees = replay.result.employees.filter(employee => employee.employeeId === request.employeeId);
    if (employees.length !== 1) fail('payroll_entry_employee_not_in_calculation');
    const employee = employees[0];
    if (!Number.isSafeInteger(employee.amountCents) || employee.amountCents < 0
        || BigInt(employee.amountCents) > MAX_ENTRY_CENTS) fail('payroll_entry_calculation_amount_invalid');
    const source = (await db.query(`SELECT sum(d.final_amount*100)::bigint::text AS cents,
      (array_agg(d.employee_name_snapshot ORDER BY d.local_date DESC,d.id DESC))[1] AS employee_name,
      p.evidence_sha256 FROM payroll_daily_snapshots d JOIN payroll_run_provenance p ON p.venue_id=d.venue_id AND p.run_id=d.run_id
      WHERE d.venue_id=$1 AND d.run_id=$2 AND d.employee_id=$3 GROUP BY p.evidence_sha256`,
    [actor.venueId, request.runId, request.employeeId])).rows[0];
    if (!source || amount(source.cents) !== employee.amountCents || !SHA.test(source.evidence_sha256 || '')) fail('payroll_entry_calculation_basis_invalid');
    const freshness = await checkFreshness(db, actor, request.runId);
    if (freshness.status !== 'current') fail('payroll_entry_calculation_sources_changed');
    const cents = BigInt(employee.amountCents), decimal = `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
    const row = (await db.query(`INSERT INTO payroll_entries
      (venue_id,user_id,rule_id,period_from,period_to,amount,status,finance_category_id,
       calculation_run_id,calculation_provenance_sha256,calculation_gross_cents,materialized_by,materialized_by_name,
       materialized_at,employee_name_snapshot,calculation_scheme_name_snapshot${halfKind === 'h1' ? ',payroll_half_kind' : ''})
      VALUES ($1,$2,NULL,$3,$4,$5,'draft',$6,$7,$8,$9,$10,$11,transaction_timestamp(),$12,$13${halfKind === 'h1' ? ",'h1'" : ''}) RETURNING ${fields}`,
    [actor.venueId, request.employeeId, header.period.from, header.period.to, decimal, request.financeCategoryId,
      request.runId, source.evidence_sha256, employee.amountCents, actor.userId, actor.name, source.employee_name, header.scheme.name])).rows[0];
    entry = materializationReceiptDto(row);
    currentEntry = currentEntryDto(row);
  }
  const result = { schemaVersion: 1, entry, replayed: false, existing: Boolean(existing) };
  const payload = JSON.stringify(result);
  await db.query(`INSERT INTO payroll_calculation_entry_requests
    (venue_id,idempotency_key,request_hash,created_by,entry_id,response_payload,response_sha256)
    VALUES ($1,$2,$3,$4,$5,$6,$7)`, [actor.venueId, request.idempotencyKey, hash, actor.userId, entry.id, payload, digest(payload)]);
  if (halfKind === 'h1' && !existing) {
    await db.query(`INSERT INTO payroll_half_month_claims
      (venue_id,employee_id,month_from,period_from,period_to,run_id,entry_id,provenance_sha256,created_by)
      VALUES($1,$2,$3::date,$3::date,$4::date,$5,$6,$7,$8)`, [actor.venueId, request.employeeId,
      request.h1MonthFrom, request.h1PeriodTo, request.runId, entry.id, currentEntry.provenanceSha256, actor.userId]);
  }
  // Live fields are deliberately outside the immutable202 response payload.
  return { ...result, currentEntry };
};

const materializeCalculationEntry = (db, actor, request, checkFreshness, options = {}) =>
  materializeEntry(db, actor, request, checkFreshness, null, options);

const materializeH1Entry = (db, actor, request, checkFreshness) =>
  materializeEntry(db, actor, request, checkFreshness, 'h1');

module.exports = { normalizeEntryMaterialization, listCalculationEntries, materializeCalculationEntry, materializeH1Entry };
