'use strict';

// Caller owns owner authorization and the source-fenced write transaction.
// A linked draft reserves a full settlement period, but does not authorize pay.
const { createHash } = require('node:crypto');
const { hasPayrollVerifiedWriteSnapshot } = require('./payroll-source-fence');
const { loadSavedRunEvidenceInTransaction } = require('./payroll-saved-run-reader');
const { executeCalculatorReplay } = require('./payroll-calculator-replay');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[a-f0-9]{64}$/;
const MAX_ENTRY_CENTS = 999999999999n;
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
  expense_id,payment_date::text`;
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
  return { id: row.id, userId: row.user_id, status: row.status,
    origin: 'calculation_run', calculationRunId: row.calculation_run_id, provenanceSha256: row.calculation_provenance_sha256,
    grossCents, amountCents, periodFrom: row.period_from, periodTo: row.period_to, currency: 'RUB',
    employeeName: row.employee_name_snapshot, schemeName: row.calculation_scheme_name_snapshot,
    financeCategoryId: row.finance_category_id, expenseId: row.expense_id || null, paymentDate: row.payment_date || null,
    transitionStateRequired: true, allowedActions: [] };
};
const readEntry = async (db, venueId, entryId) => {
  const row = (await db.query(`SELECT ${fields} FROM payroll_entries WHERE venue_id=$1 AND id=$2 AND calculation_run_id IS NOT NULL`,
    [venueId, entryId])).rows[0];
  if (!row) fail('payroll_entry_calculation_link_invalid');
  return currentEntryDto(row);
};
const requestHash = (actor, request) => digest(JSON.stringify({ venueId: actor.venueId, userId: actor.userId,
  runId: request.runId, employeeId: request.employeeId, financeCategoryId: request.financeCategoryId }));
const listCalculationEntries = async (db, actor, runId) => {
  runId = normalizedId(runId);
  // Preserve tenant-safe not-found behavior even when a run has no entries.
  await loadSavedRunEvidenceInTransaction(db, actor.venueId, runId);
  const rows = (await db.query(`SELECT ${fields} FROM payroll_entries WHERE venue_id=$1 AND calculation_run_id=$2 ORDER BY user_id`,
    [actor.venueId, runId])).rows;
  return { schemaVersion: 1, items: rows.map(currentEntryDto) };
};
const materializeCalculationEntry = async (db, actor, request, checkFreshness) => {
  if (!hasPayrollVerifiedWriteSnapshot(db, actor.venueId)) fail('payroll_entry_source_transaction_required');
  const hash = requestHash(actor, request);
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
    // Return the exact historical outcome and separately expose the current
    // amount/status. A lost-response retry performs no lifecycle transition.
    return { ...result, replayed: true, currentEntry };
  }
  const existing = (await db.query(`SELECT ${fields} FROM payroll_entries
    WHERE venue_id=$1 AND calculation_run_id=$2 AND user_id=$3`, [actor.venueId, request.runId, request.employeeId])).rows[0];
  let entry, currentEntry;
  if (existing) {
    if (existing.finance_category_id !== request.financeCategoryId) fail('payroll_entry_existing_category_conflict');
    entry = materializationReceiptDto(existing);
    currentEntry = currentEntryDto(existing);
  } else {
    const { header, evidence } = await loadSavedRunEvidenceInTransaction(db, actor.venueId, request.runId);
    let replay;
    try { replay = executeCalculatorReplay(evidence.calculatorReplay); } catch (_) { fail('payroll_entry_replay_required'); }
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
       materialized_at,employee_name_snapshot,calculation_scheme_name_snapshot)
      VALUES ($1,$2,NULL,$3,$4,$5,'draft',$6,$7,$8,$9,$10,$11,transaction_timestamp(),$12,$13) RETURNING ${fields}`,
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
  // Live fields are deliberately outside the immutable202 response payload.
  return { ...result, currentEntry };
};

module.exports = { normalizeEntryMaterialization, listCalculationEntries, materializeCalculationEntry };
