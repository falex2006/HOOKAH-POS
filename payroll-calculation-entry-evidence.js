'use strict';

// Server-only proof for payroll-entry lifecycle transitions and reviewed
// corrections. Callers own authorization, transaction boundaries and writes.
// This module can only verify saved run evidence; it never posts money.
const { createHash } = require('node:crypto');
const { payrollCorrectionLedgerEventFromRow, samePayrollCorrectionSource } = require('./payroll-correction-ledger-source');
const { hasPayrollVerifiedWriteSnapshot } = require('./payroll-source-fence');
const { loadSavedRunEvidenceInTransaction } = require('./payroll-saved-run-reader');
const { executeCalculatorReplay, getCalculatorReplayEngineManifest } = require('./payroll-calculator-replay');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[a-f0-9]{64}$/;
const MAX_ENTRY_CENTS = 999999999999n; // numeric(12,2)
const PURPOSES = new Set(['current_transition', 'historical_paid']);
const fail = suffix => { throw Object.assign(new Error(`payroll_entry_evidence_${suffix}`), {
  code: `payroll_entry_evidence_${suffix}`, status: 409
}); };
const stable = value => Array.isArray(value) ? `[${value.map(stable).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().filter(key => value[key] !== undefined)
    .map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}` : JSON.stringify(value);
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : stable(value)).digest('hex');
const deepFreeze = value => {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
};
const uuid = value => {
  if (typeof value !== 'string' || !UUID.test(value)) fail('identity_invalid');
  return value.toLowerCase();
};
const date = value => {
  // PostgreSQL DATE is a calendar value. Callers must select it as text;
  // a driver Date has already acquired the host timezone and is ambiguous.
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)
      || !Number.isFinite(Date.parse(`${value}T00:00:00Z`))
      || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) fail('period_invalid');
  return value;
};
const cents = value => {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) fail('amount_invalid');
  const amount = BigInt(value);
  if (amount > MAX_ENTRY_CENTS) fail('amount_invalid');
  return amount;
};
const decimalCents = value => {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)\.[0-9]{2}$/.test(value)) fail('amount_invalid');
  const [whole, fraction] = value.split('.');
  return cents((BigInt(whole) * 100n + BigInt(fraction)).toString());
};
const fromRow = (row, snake, camel = snake) => row?.[snake] ?? row?.[camel];
const normalizedEntryIdentity = row => {
  if (!row || typeof row !== 'object' || Array.isArray(row)) fail('entry_invalid');
  return {
    id: uuid(fromRow(row, 'id')),
    venueId: uuid(fromRow(row, 'venue_id', 'venueId')),
    employeeId: uuid(fromRow(row, 'user_id', 'userId') ?? row.employeeId),
    runId: uuid(fromRow(row, 'calculation_run_id', 'calculationRunId')),
    provenanceSha256: fromRow(row, 'calculation_provenance_sha256', 'provenanceSha256'),
    grossCents: cents(String(fromRow(row, 'calculation_gross_cents', 'calculationGrossCents'))),
    netCents: decimalCents(String(fromRow(row, 'amount'))),
    periodFrom: date(fromRow(row, 'period_from', 'periodFrom')),
    periodTo: date(fromRow(row, 'period_to', 'periodTo')),
    status: fromRow(row, 'status')
  };
};
const verifyDailySnapshots = async (db, identity, replayResult) => {
  const rows = (await db.query(`SELECT venue_id::text AS venue_id,run_id::text AS run_id,
      employee_id::text AS employee_id,local_date::text AS local_date,
      (base_pay*100)::numeric(30,0)::text AS base_pay_cents,
      (final_amount*100)::numeric(30,0)::text AS final_amount_cents
    FROM payroll_daily_snapshots WHERE venue_id=$1 AND run_id=$2 AND employee_id=$3
    ORDER BY local_date,id`, [identity.venueId, identity.runId, identity.employeeId])).rows;
  if (!Array.isArray(rows) || !rows.length) fail('daily_snapshots_missing');

  const replayByDate = new Map();
  for (const day of replayResult.daily) {
    if (!day || typeof day.date !== 'string') fail('replay_daily_invalid');
    const matches = (Array.isArray(day.employees) ? day.employees : [])
      .filter(employee => employee?.employeeId === identity.employeeId);
    if (matches.length > 1) fail('replay_daily_duplicate');
    if (matches.length === 1) {
      if (replayByDate.has(day.date)) fail('replay_daily_duplicate');
      replayByDate.set(day.date, matches[0]);
    }
  }

  const seen = new Set();
  let gross = 0n, protectedFixed = 0n;
  for (const row of rows) {
    if (row.venue_id !== identity.venueId || row.run_id !== identity.runId || row.employee_id !== identity.employeeId) fail('snapshot_identity_mismatch');
    const localDate = date(row.local_date);
    if (localDate < identity.periodFrom || localDate > identity.periodTo || seen.has(localDate)) fail('snapshot_period_or_duplicate');
    seen.add(localDate);
    const dbBase = cents(row.base_pay_cents), dbGross = cents(row.final_amount_cents);
    const replayDay = replayByDate.get(localDate);
    if (!replayDay || !Number.isSafeInteger(replayDay.basePayCents) || replayDay.basePayCents < 0
        || !Number.isSafeInteger(replayDay.amountCents) || replayDay.amountCents < 0
        || BigInt(replayDay.basePayCents) !== dbBase || BigInt(replayDay.amountCents) !== dbGross) fail('daily_reconciliation_mismatch');
    // Caps can reduce total below the configured shift base. Such a day has no
    // unambiguous protected/variable split in the saved engine result.
    gross += dbGross;
    protectedFixed += dbBase < dbGross ? dbBase : dbGross;
  }
  if (seen.size !== replayByDate.size || [...replayByDate.keys()].some(day => !seen.has(day))) fail('daily_reconciliation_mismatch');
  const replayEmployees = replayResult.employees.filter(employee => employee?.employeeId === identity.employeeId);
  if (replayEmployees.length !== 1 || !Number.isSafeInteger(replayEmployees[0].amountCents)
      || replayEmployees[0].amountCents < 0 || BigInt(replayEmployees[0].amountCents) !== gross
      || gross > MAX_ENTRY_CENTS || protectedFixed > gross) fail('employee_reconciliation_mismatch');
  return { grossCents: gross, protectedFixedCents: protectedFixed, eligibleVariableCents: gross - protectedFixed };
};

// A zero settlement has no cash expense. Its authority is the immutable205
// pay transition and the exact incoming applications settled by that receipt.
// Later outgoing claims legitimately change the employee ledger; never compare
// the receipt's historical whole-ledger hash with today's whole ledger.
const verifyZeroSettlement = async (db, identity, current, totals, capabilityVersion) => {
  if (identity.netCents !== 0n || current.expense_id !== null || current.linked_expense_id !== null
      || !current.payment_date || totals.protectedFixedCents !== 0n) fail('zero_settlement_invalid');
  const rows = (await db.query(`SELECT t.*,t.gross_cents::text AS gross_cents,t.net_cents::text AS net_cents,
      t.protected_fixed_cents::text AS protected_fixed_cents,t.created_at::text AS created_at,
      t.payment_date::text AS payment_date,
      EXISTS(SELECT 1 FROM payroll_calculation_entry_transition_requests q
        WHERE q.venue_id=t.venue_id AND q.transition_id=t.id AND q.created_by=t.created_by) AS request_journaled
    FROM payroll_calculation_entry_transitions t WHERE t.venue_id=$1 AND t.entry_id=$2 AND t.action='pay' FOR SHARE OF t`,
  [identity.venueId, identity.id])).rows;
  if (rows.length !== 1) fail('zero_settlement_required');
  const receipt = rows[0];
  if (!receipt || !UUID.test(receipt.id || '') || receipt.venue_id !== identity.venueId || receipt.entry_id !== identity.id
      || receipt.employee_id !== identity.employeeId || receipt.calculation_run_id !== identity.runId
      || receipt.provenance_sha256 !== identity.provenanceSha256 || receipt.action !== 'pay'
      || receipt.from_status !== 'approved' || receipt.to_status !== 'paid' || receipt.settlement_kind !== 'zero'
      || cents(receipt.gross_cents) !== totals.grossCents || cents(receipt.net_cents) !== 0n
      || cents(receipt.protected_fixed_cents) !== totals.protectedFixedCents
      || receipt.created_at !== current.paid_at || receipt.created_by !== current.paid_by
      || receipt.payment_date !== current.payment_date || receipt.request_journaled !== true
      || ['expense_id', 'finance_account_id', 'finance_account_name_snapshot', 'payment_method', 'shift_id'].some(key => receipt[key] !== null)
      || typeof receipt.source_proof_payload !== 'string' || hash(receipt.source_proof_payload) !== receipt.source_proof_sha256) fail('zero_settlement_invalid');
  let settled;
  try { settled = JSON.parse(receipt.source_proof_payload); } catch (_) { fail('zero_settlement_invalid'); }
  if (settled?.schemaVersion !== 1 || settled.proofKind !== 'current_transition' || settled.entryStatus !== 'approved'
      || settled.venueId !== identity.venueId || settled.entryId !== identity.id || settled.employeeId !== identity.employeeId
      || settled.runId !== identity.runId || settled.currency !== 'RUB' || settled.origin !== 'calculation_run'
      || settled.periodFrom !== identity.periodFrom || settled.periodTo !== identity.periodTo
      || settled.evidenceHashes?.provenanceSha256 !== identity.provenanceSha256
      || settled.grossCents !== Number(totals.grossCents) || settled.netCents !== 0 || settled.protectedFixedCents !== 0
      || settled.eligibleVariableCents !== Number(totals.eligibleVariableCents) || settled.freshness?.status !== 'current'
      || settled.corrections?.entryId !== identity.id || settled.corrections.venueId !== identity.venueId
      || settled.corrections.employeeId !== identity.employeeId || settled.corrections.netCents !== 0
      || settled.corrections.protectedFixedCents !== 0 || settled.corrections.appliedCents !== Number(totals.grossCents)
      || settled.corrections.ledgerHash !== receipt.ledger_hash || !Array.isArray(settled.corrections.activeApplicationIds)) fail('zero_settlement_invalid');
  const { correctionEvidenceHash, ...correctionBody } = settled.corrections;
  if (typeof correctionEvidenceHash !== 'string' || hash(correctionBody) !== correctionEvidenceHash) fail('zero_settlement_invalid');
  const captured = capabilityVersion === 'employee_attributed_remaining_net_refund_v2';
  const allEvents = (await db.query(`SELECT e.id,e.sequence_no::text,e.venue_id,e.employee_id,e.claim_id,e.kind,
      e.amount_cents::text,e.target_entry_id,e.reverses_event_id,c.original_entry_id,c.refund_line_event_id,c.currency,
      to_jsonb(c)->>'source_kind' AS source_kind,
      CASE WHEN e.kind='release' THEN to_jsonb(pb)->>'cohort_assessment_id'
        ELSE to_jsonb(b)->>'cohort_assessment_id' END AS cohort_assessment_id
    FROM payroll_correction_events e JOIN payroll_correction_claims c ON c.venue_id=e.venue_id AND c.id=e.claim_id
    JOIN payroll_correction_batches b ON b.venue_id=e.venue_id AND b.id=e.batch_id
    LEFT JOIN payroll_correction_events pe ON pe.venue_id=e.venue_id AND pe.id=e.reverses_event_id
    LEFT JOIN payroll_correction_batches pb ON pb.venue_id=pe.venue_id AND pb.id=pe.batch_id
    WHERE e.venue_id=$1 AND e.${captured ? 'employee_id' : 'target_entry_id'}=$2 ORDER BY e.sequence_no LIMIT 100001`,
  [identity.venueId, captured ? identity.employeeId : identity.id])).rows;
  if (allEvents.length > 100000) fail('zero_settlement_ledger_invalid');
  if (captured) {
    const ids = settled.corrections.ledgerEventIds;
    if (settled.capabilityVersion !== capabilityVersion || settled.corrections.ledgerCaptureSchemaVersion !== 1
        || !Array.isArray(ids) || ids.length > 100000 || ids.some(id => typeof id !== 'string' || !UUID.test(id))
        || new Set(ids).size !== ids.length || JSON.stringify(ids) !== JSON.stringify([...ids].sort())) fail('zero_settlement_ledger_invalid');
    const set = new Set(ids), history = [];
    for (const event of allEvents) {
      let normalized;
      try { normalized = payrollCorrectionLedgerEventFromRow(event); } catch (_) { fail('zero_settlement_ledger_invalid'); }
      if (normalized.venueId !== identity.venueId || normalized.employeeId !== identity.employeeId) fail('zero_settlement_ledger_invalid');
      if (set.has(event.id)) history.push(normalized);
      else if (event.target_entry_id === identity.id) fail('zero_settlement_ledger_invalid');
    }
    if (history.length !== set.size || new Set(history.map(event => event.id)).size !== set.size
        || hash(history.sort((a, b) => a.id.localeCompare(b.id))) !== receipt.ledger_hash) fail('zero_settlement_ledger_invalid');
  }
  const events = captured ? allEvents.filter(event => event.target_entry_id === identity.id) : allEvents;
  const seen = new Set(), active = new Map();
  let previousSequence = 0n, applied = 0n;
  for (const event of events) {
    let normalized;
    try { normalized = payrollCorrectionLedgerEventFromRow(event); } catch (_) { fail('zero_settlement_ledger_invalid'); }
    const amount = cents(event.amount_cents);
    if (typeof event.sequence_no !== 'string' || !/^[1-9][0-9]*$/.test(event.sequence_no)
        || BigInt(event.sequence_no) > BigInt(Number.MAX_SAFE_INTEGER)) fail('zero_settlement_ledger_invalid');
    const sequence = BigInt(event.sequence_no);
    if (!UUID.test(event.id || '') || !UUID.test(event.claim_id || '') || !UUID.test(event.original_entry_id || '')
        || event.original_entry_id === identity.id
        || seen.has(event.id) || sequence <= previousSequence || amount === 0n
        || event.venue_id !== identity.venueId || event.employee_id !== identity.employeeId || event.target_entry_id !== identity.id) fail('zero_settlement_ledger_invalid');
    seen.add(event.id); previousSequence = sequence;
    if (event.kind === 'apply' && event.reverses_event_id === null) { active.set(event.id, event); applied += amount; }
    else if (event.kind === 'release') {
      const parent = active.get(event.reverses_event_id);
      if (!parent || parent.claim_id !== event.claim_id || parent.original_entry_id !== event.original_entry_id
          || !samePayrollCorrectionSource(payrollCorrectionLedgerEventFromRow(parent), normalized)
          || parent.amount_cents !== event.amount_cents) fail('zero_settlement_ledger_invalid');
      active.delete(parent.id); applied -= amount;
    } else fail('zero_settlement_ledger_invalid');
    if (applied < 0n || applied > totals.grossCents) fail('zero_settlement_ledger_invalid');
  }
  if (applied !== totals.grossCents || canonicalIds(active.keys()) !== canonicalIds(settled.corrections.activeApplicationIds)) fail('zero_settlement_ledger_invalid');
  return { kind: 'zero', transitionId: receipt.id, venueId: identity.venueId, entryId: identity.id,
    employeeId: identity.employeeId, runId: identity.runId, provenanceSha256: identity.provenanceSha256,
    grossCents: Number(totals.grossCents), netCents: 0, protectedFixedCents: 0, incomingCorrectionCents: Number(applied),
    paymentDate: receipt.payment_date, paidAt: receipt.created_at, paidBy: receipt.created_by };
};
const canonicalIds = values => {
  const ids = [...values];
  if (ids.some(value => typeof value !== 'string' || !UUID.test(value)) || new Set(ids).size !== ids.length) fail('zero_settlement_ledger_invalid');
  return JSON.stringify(ids.sort());
};

/**
 * Verify a persisted calculation-linked payroll entry inside its caller's
 * private source-fenced transaction. `purpose` is deliberately closed to two
 * proof kinds: current transitions require fresh sources; historical basis
 * requires a paid entry with its matching payroll expense or immutable zero settlement.
 */
const verifyPayrollCalculationEntryEvidence = async (db, actor, entryRow, { purpose, checkFreshness } = {}) => {
  if (!PURPOSES.has(purpose)) fail('purpose_invalid');
  const venueId = uuid(actor?.venueId);
  if (!db || typeof db.query !== 'function' || !hasPayrollVerifiedWriteSnapshot(db, venueId)) fail('source_transaction_required');
  const expected = normalizedEntryIdentity(entryRow);
  if (expected.venueId !== venueId || !SHA.test(expected.provenanceSha256 || '')
      || expected.periodTo < expected.periodFrom || expected.periodFrom.slice(0, 7) !== expected.periodTo.slice(0, 7)) fail('entry_context_invalid');

  const current = (await db.query(`SELECT pe.id::text,pe.venue_id::text AS venue_id,pe.user_id::text AS user_id,
      pe.status,pe.calculation_run_id::text AS calculation_run_id,pe.calculation_provenance_sha256,
      pe.calculation_gross_cents::text AS calculation_gross_cents,pe.amount::text AS amount,pe.period_from::text AS period_from,
      pe.period_to::text AS period_to,pe.paid_at::text AS paid_at,pe.payment_date::text AS payment_date,pe.paid_by::text AS paid_by,pe.expense_id::text AS expense_id,
      e.id::text AS linked_expense_id,e.venue_id::text AS expense_venue_id,e.source AS expense_source,e.amount::text AS expense_amount
    FROM payroll_entries pe LEFT JOIN expenses e ON e.venue_id=pe.venue_id AND e.id=pe.expense_id
    WHERE pe.venue_id=$1 AND pe.id=$2 AND pe.calculation_run_id IS NOT NULL FOR SHARE OF pe`, [venueId, expected.id])).rows[0];
  if (!current) fail('entry_not_found');
  const persisted = normalizedEntryIdentity(current);
  if (persisted.id !== expected.id || persisted.venueId !== expected.venueId
      || persisted.employeeId !== expected.employeeId || persisted.runId !== expected.runId
      || persisted.provenanceSha256 !== expected.provenanceSha256 || persisted.grossCents !== expected.grossCents
      || persisted.netCents !== expected.netCents
      || persisted.periodFrom !== expected.periodFrom || persisted.periodTo !== expected.periodTo
      || persisted.status !== expected.status) fail('entry_row_mismatch');
  if (purpose === 'current_transition') {
    if (!['draft', 'approved'].includes(persisted.status)) fail('current_transition_status_invalid');
    if (typeof checkFreshness !== 'function') fail('freshness_callback_required');
  } else if (persisted.status !== 'paid' || !current.paid_at || !current.paid_by
      || (persisted.netCents !== 0n || current.expense_id !== null) && (!current.expense_id
        || current.linked_expense_id !== current.expense_id || current.expense_venue_id !== venueId || current.expense_source !== 'payroll')) {
    fail('historical_paid_entry_required');
  }

  let saved;
  try { saved = await loadSavedRunEvidenceInTransaction(db, venueId, expected.runId); }
  catch (_) { fail('saved_run_evidence_invalid'); }
  const { header, evidence } = saved;
  if (header.runId !== expected.runId || header.currency !== 'RUB'
      || header.period?.from !== expected.periodFrom || header.period?.to !== expected.periodTo
      || evidence.venueId !== venueId || evidence.runId !== expected.runId
      || evidence.currency !== 'RUB' || evidence.period?.from !== expected.periodFrom
      || evidence.period?.to !== expected.periodTo || !evidence.calculatorReplay
      || hash(evidence) !== expected.provenanceSha256) fail('run_provenance_or_context_mismatch');

  let replay;
  try { replay = executeCalculatorReplay(evidence.calculatorReplay); }
  catch (_) { fail('calculator_replay_invalid'); }
  if (!replay.matched || !replay.replayVerified || replay.status !== 'matched' || !replay.result) fail('calculator_replay_unverified');
  const totals = await verifyDailySnapshots(db, { ...expected, venueId }, replay.result);
  if (totals.grossCents !== BigInt(expected.grossCents)) fail('entry_gross_mismatch');
  if (expected.netCents > totals.grossCents) fail('entry_net_exceeds_gross');
  const zeroSettlement = purpose === 'historical_paid' && expected.netCents === 0n && current.expense_id === null;
  const settlement = zeroSettlement ? await verifyZeroSettlement(db, persisted, current, totals, evidence.capabilityVersion) : null;
  if (purpose === 'historical_paid' && !zeroSettlement && decimalCents(current.expense_amount) !== expected.netCents) {
    fail('paid_expense_amount_mismatch');
  }

  let freshness = null;
  if (purpose === 'current_transition') {
    let checked;
    try { checked = await checkFreshness(db, actor, expected.runId); }
    catch (_) { fail('source_freshness_unavailable'); }
    if (checked?.status !== 'current' || checked?.runId !== expected.runId) fail('source_not_current');
    freshness = { status: 'current', checkedAt: checked.checkedAt || null };
  }
  const engine = getCalculatorReplayEngineManifest();
  const sourceEvidence = evidence.sourceEvidence;
  const proof = {
    schemaVersion: 1,
    ...(evidence.capabilityVersion === 'employee_attributed_remaining_net_refund_v2'
      ? { capabilityVersion: evidence.capabilityVersion } : {}),
    proofKind: purpose,
    venueId,
    entryId: expected.id,
    employeeId: expected.employeeId,
    runId: expected.runId,
    entryStatus: persisted.status,
    origin: 'calculation_run',
    currency: 'RUB',
    period: { from: expected.periodFrom, to: expected.periodTo },
    periodFrom: expected.periodFrom,
    periodTo: expected.periodTo,
    grossCents: Number(totals.grossCents),
    netCents: Number(expected.netCents),
    protectedFixedCents: Number(totals.protectedFixedCents),
    eligibleVariableCents: Number(totals.eligibleVariableCents),
    evidenceHashes: {
      provenanceSha256: expected.provenanceSha256,
      inputWatermark: evidence.inputWatermark,
      closureWatermark: evidence.closureWatermark,
      calculationWatermark: evidence.calculationWatermark,
      snapshotInputWatermark: evidence.snapshotInputWatermark,
      sourceEvidenceSha256: hash(sourceEvidence),
      calculatorInputSha256: evidence.calculatorReplay.inputSha256,
      calculatorResultSha256: replay.resultSha256,
      engineRevision: engine.engineRevision
    },
    expense: purpose === 'historical_paid' && !zeroSettlement ? {
      id: current.expense_id, entryId: expected.id, venueId,
      source: current.expense_source, amountCents: Number(expected.netCents)
    } : null,
    freshness,
    ...(settlement ? { settlement } : {})
  };
  return deepFreeze(proof);
};

module.exports = { verifyPayrollCalculationEntryEvidence };
