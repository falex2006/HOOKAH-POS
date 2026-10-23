'use strict';

// Owner lifecycle for immutable calculation-linked entries. The service owns a
// fresh source-fenced write transaction; all effects commit or roll back once.
const { createHash, randomUUID } = require('node:crypto');
const { hasPayrollVerifiedWriteSnapshot } = require('./payroll-source-fence');
const { verifyPayrollCalculationEntryEvidence } = require('./payroll-calculation-entry-evidence');
const { verifyPayrollEntryCorrections } = require('./payroll-calculation-entry-corrections');
const { readReviewedCorrectionLedger, previewReviewedCorrectionCancellation, cancelReviewedCorrectionTarget } = require('./payroll-reviewed-correction-store');
const { normalizePayrollEntryTransitionCommand, buildPayrollEntryTransitionState,
  payrollEntryTransitionRequestHash, buildPayrollEntryTransitionCommand } = require('./payroll-calculation-entry-transition-command');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const fail = (code, status = 409) => { throw Object.assign(new Error(`payroll_entry_lifecycle_${code}`), { code: `payroll_entry_lifecycle_${code}`, status }); };
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}` : JSON.stringify(value);
const digest = value => createHash('sha256').update(value).digest('hex');
const integer = value => {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value) || BigInt(value) > 999999999999n) fail('amount_invalid');
  return Number(value);
};
async function owner(db, actor) {
  if (!actor || typeof actor.venueId !== 'string' || !UUID.test(actor.venueId)
      || typeof actor.userId !== 'string' || !UUID.test(actor.userId)
      || !hasPayrollVerifiedWriteSnapshot(db, actor.venueId)) fail('source_transaction_required');
  const row = (await db.query("SELECT full_name FROM users WHERE venue_id=$1 AND id=$2 AND role='owner' AND is_active=true AND deleted_at IS NULL FOR SHARE",
    [actor.venueId, actor.userId])).rows[0];
  if (!row) fail('owner_required', 403);
  return { venueId: actor.venueId, userId: actor.userId, name: row.full_name };
}
async function readEntry(db, actor, entryId, lock = true) {
  if (typeof entryId !== 'string' || !UUID.test(entryId)) fail('id_invalid', 400);
  const row = (await db.query(`SELECT pe.*,pe.period_from::text AS period_from,pe.period_to::text AS period_to,pe.payment_date::text AS payment_date,
      pe.amount::text AS amount,(pe.amount*100)::bigint::text AS net_cents,pe.calculation_gross_cents::text AS calculation_gross_cents
    FROM payroll_entries pe WHERE pe.venue_id=$1 AND pe.id=$2 AND pe.calculation_run_id IS NOT NULL${lock ? ' FOR UPDATE' : ''}`,
    [actor.venueId, entryId])).rows[0];
  if (!row) fail('not_found', 404);
  return row;
}
const normalized = row => ({ id: row.id, venueId: row.venue_id, employeeId: row.user_id, runId: row.calculation_run_id,
  origin: 'calculation_run', currency: 'RUB', provenanceSha256: row.calculation_provenance_sha256,
  periodFrom: row.period_from, periodTo: row.period_to, status: row.status,
  grossCents: integer(row.calculation_gross_cents), netCents: integer(row.net_cents) });
const dto = row => ({ id: row.id, userId: row.user_id, status: row.status, calculationRunId: row.calculation_run_id,
  provenanceSha256: row.calculation_provenance_sha256,
  grossCents: integer(row.calculation_gross_cents), amountCents: integer(row.net_cents), currency: 'RUB',
  periodFrom: row.period_from, periodTo: row.period_to, expenseId: row.expense_id || null,
  employeeName: row.employee_name_snapshot, schemeName: row.calculation_scheme_name_snapshot,
  financeCategoryId: row.finance_category_id, paymentDate: row.payment_date instanceof Date ? row.payment_date.toISOString().slice(0, 10) : row.payment_date || null });
async function freshProof(db, actor, row, checkFreshness, expectedLedgerHash) {
  const proof = await verifyPayrollCalculationEntryEvidence(db, actor, row, { purpose: 'current_transition', checkFreshness });
  const corrections = await verifyPayrollEntryCorrections(db, actor, proof);
  if (corrections.ledgerHash !== expectedLedgerHash) fail('ledger_changed');
  return { ...proof, corrections };
}
async function getPayrollCalculationEntryState(db, actor, entryId, checkFreshness) {
  actor = await owner(db, actor);
  const row = await readEntry(db, actor, entryId), entry = normalized(row);
  const ledger = await readReviewedCorrectionLedger(db, actor, entry.employeeId);
  const state = buildPayrollEntryTransitionState(entry, ledger);
  let allowedActions = [...state.allowedActions], sourceStatus = 'not_required', blockedReason = null;
  if (allowedActions.some(action => action === 'approve' || action === 'pay')) {
    try { await freshProof(db, actor, row, checkFreshness, state.ledgerHash); sourceStatus = 'current'; }
    catch (error) {
      if (typeof error?.code !== 'string' || !/^payroll_[a-z0-9_]+$/.test(error.code)) throw error;
      sourceStatus = 'blocked'; blockedReason = error.code; allowedActions = allowedActions.filter(action => action === 'cancel');
    }
  }
  return { schemaVersion: 1, entry: dto(row), stateHash: state.stateHash, ledgerHash: state.ledgerHash,
    allowedActions, sourceStatus, blockedReason, validity: 'rechecked_on_transition' };
}
async function paymentDetails(db, actor, command, row) {
  if (integer(row.net_cents) === 0) return { kind: 'zero', expenseId: null, account: null, shiftId: null };
  const account = (await db.query(`SELECT id,name,kind,allowed_payment_methods,active FROM finance_accounts
    WHERE venue_id=$1 AND id=$2 FOR UPDATE`, [actor.venueId, command.paymentAccountId])).rows[0];
  if (!account) fail('account_not_found', 404);
  if (!account.active) fail('account_inactive');
  if (!Array.isArray(account.allowed_payment_methods) || !account.allowed_payment_methods.includes(command.paymentMethod)
      || (account.kind === 'pos_cashbox' && command.paymentMethod !== 'cash')) fail('payment_method_account_mismatch', 400);
  let shiftId = null;
  if (account.kind === 'pos_cashbox') {
    const date = (await db.query(`SELECT (now() AT TIME ZONE COALESCE(NULLIF(v.timezone,''),NULLIF(o.timezone,''),'Asia/Yekaterinburg'))::date::text AS date
      FROM venues v LEFT JOIN organizations o ON o.id=v.organization_id WHERE v.id=$1`, [actor.venueId])).rows[0]?.date;
    if (date !== command.paymentDate) fail('cash_payment_date_must_be_today');
    const shifts = (await db.query('SELECT id FROM shifts WHERE venue_id=$1 AND closed_at IS NULL ORDER BY opened_at DESC FOR UPDATE', [actor.venueId])).rows;
    if (shifts.length !== 1) fail('open_shift_required');
    shiftId = shifts[0].id;
  }
  const label = value => value.split('-').reverse().join('.');
  const description = `Выплата зарплаты за ${label(row.period_from)} — ${label(row.period_to)}`;
  // Always create a fresh expense. Never adopt/update any existing expense.
  const expense = (await db.query(`INSERT INTO expenses(venue_id,category,category_id,amount,expense_date,description,source,created_by,
      payment_method,finance_account_id,finance_account_name_snapshot,shift_id,payroll_calculation_entry_id)
    VALUES($1,$2,$3,$4::numeric,$5,$6,'payroll',$7,$8,$9,$10,$11,$12) RETURNING id`,
  [actor.venueId, row.finance_category_name_snapshot || 'Зарплата', row.finance_category_id, row.amount, command.paymentDate,
    description, actor.userId, command.paymentMethod, account.id, account.name, shiftId, row.id])).rows[0];
  if (!expense) fail('expense_creation_failed');
  return { kind: 'positive_expense', expenseId: expense.id, account, shiftId };
}
async function transitionPayrollCalculationEntry(db, actor, entryId, input, checkFreshness) {
  const command = normalizePayrollEntryTransitionCommand(entryId, input);
  entryId = command.entryId;
  actor = await owner(db, actor);
  const requestHash = payrollEntryTransitionRequestHash(actor, command);
  const old = (await db.query(`SELECT request_hash,response_payload,response_hash FROM payroll_calculation_entry_transition_requests
    WHERE venue_id=$1 AND idempotency_key=$2`, [actor.venueId, command.idempotencyKey])).rows[0];
  if (old) {
    if (old.request_hash !== requestHash) fail('idempotency_conflict');
    if (typeof old.response_payload !== 'string' || digest(old.response_payload) !== old.response_hash) fail('request_integrity_invalid');
    let response;
    try { response = JSON.parse(old.response_payload); } catch (_) { fail('request_integrity_invalid'); }
    return { ...response, replayed: true, currentEntry: dto(await readEntry(db, actor, entryId, false)) };
  }
  const row = await readEntry(db, actor, entryId), entry = normalized(row);
  const ledger = await readReviewedCorrectionLedger(db, actor, entry.employeeId);
  const prepared = buildPayrollEntryTransitionCommand(actor, entryId, input, entry, ledger);
  let proof = null, fixed = null, settlement = null;
  if (command.action !== 'cancel') {
    if (row.expense_id) fail('unexpected_existing_expense');
    proof = await freshProof(db, actor, row, checkFreshness, prepared.state.ledgerHash);
    fixed = proof.protectedFixedCents;
    if (command.action === 'pay') settlement = await paymentDetails(db, actor, command, row);
  } else {
    const totals = (await db.query(`SELECT COALESCE(sum(LEAST(base_pay,final_amount)*100),0)::bigint::text AS fixed,
      COALESCE(sum(final_amount*100),0)::bigint::text AS gross FROM payroll_daily_snapshots
      WHERE venue_id=$1 AND run_id=$2 AND employee_id=$3`, [actor.venueId, entry.runId, entry.employeeId])).rows[0];
    if (integer(totals.gross) !== entry.grossCents) fail('snapshot_amount_mismatch');
    fixed = integer(totals.fixed);
  }
  const toStatus = { approve: 'approved', pay: 'paid', cancel: 'cancelled' }[command.action];
  const payload = proof ? canonical(proof) : null;
  const insertTransition = async () => (await db.query(`INSERT INTO payroll_calculation_entry_transitions
    (id,venue_id,entry_id,action,from_status,to_status,employee_id,calculation_run_id,provenance_sha256,gross_cents,net_cents,
      protected_fixed_cents,ledger_hash,source_proof_payload,source_proof_sha256,settlement_kind,expense_id,payment_date,payment_method,
      finance_account_id,finance_account_name_snapshot,shift_id,reason,created_by,created_by_name)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
    RETURNING id,created_at::text AS created_at`,
  [randomUUID(), actor.venueId, entry.id, command.action, entry.status, toStatus, entry.employeeId, entry.runId, entry.provenanceSha256,
    entry.grossCents, entry.netCents, fixed, prepared.state.ledgerHash, payload, payload ? digest(payload) : null,
    settlement?.kind || null, settlement?.expenseId || null, command.paymentDate, command.paymentMethod,
    settlement?.account?.id || null, settlement?.account?.name || null, settlement?.shiftId || null,
    command.reason, actor.userId, actor.name])).rows[0];
  let transition;
  if (command.action === 'cancel') {
    const releaseInput = { targetEntryId: entry.id, expectedPlanHash: '0'.repeat(64), reason: command.reason,
      idempotencyKey: `entry-cancel:${requestHash}` };
    const release = await previewReviewedCorrectionCancellation(db, actor, releaseInput);
    if (release.releaseCents > 0) {
      await cancelReviewedCorrectionTarget(db, actor, { ...releaseInput, expectedPlanHash: release.planHash }, {
        beforeCancel: async () => { transition = await insertTransition(); return transition; }
      });
    } else {
      transition = await insertTransition();
      await db.query(`UPDATE payroll_entries SET status='cancelled',cancelled_at=$3::timestamptz,cancelled_by=$4,cancellation_reason=$5
        WHERE venue_id=$1 AND id=$2`, [actor.venueId, entry.id, transition.created_at, actor.userId, command.reason]);
    }
  } else {
    transition = await insertTransition();
    if (command.action === 'approve') await db.query(`UPDATE payroll_entries SET status='approved',approved_at=$3::timestamptz,approved_by=$4
      WHERE venue_id=$1 AND id=$2`, [actor.venueId, entry.id, transition.created_at, actor.userId]);
    else await db.query(`UPDATE payroll_entries SET status='paid',paid_at=$3::timestamptz,paid_by=$4,payment_date=$5,expense_id=$6
      WHERE venue_id=$1 AND id=$2`, [actor.venueId, entry.id, transition.created_at, actor.userId, command.paymentDate, settlement.expenseId]);
  }
  if (!transition?.id) fail('transition_missing');
  const result = { schemaVersion: 1, transitionId: transition.id, action: command.action, entry: dto(await readEntry(db, actor, entryId)), replayed: false };
  const response = canonical(result);
  await db.query(`INSERT INTO payroll_calculation_entry_transition_requests
    (id,venue_id,idempotency_key,request_hash,transition_id,created_by,response_payload,response_hash)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [randomUUID(), actor.venueId, command.idempotencyKey, requestHash, transition.id, actor.userId, response, digest(response)]);
  return result;
}
module.exports = { getPayrollCalculationEntryState, transitionPayrollCalculationEntry };
