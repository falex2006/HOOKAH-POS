'use strict';

// Private owner-only atomic replacement for an unpaid refund-aware (v2) run.
// Caller owns the source-fenced transaction; this module checks that capability,
// owner authorization, stable locks, immutable cancellation/materialization and receipt.
const { createHash, randomUUID } = require('node:crypto');
const { hasPayrollVerifiedWriteSnapshot } = require('./payroll-source-fence');
const { loadSavedRunEvidenceInTransaction } = require('./payroll-saved-run-reader');
const { getPayrollCalculationEntryState, transitionPayrollCalculationEntry } = require('./payroll-calculation-entry-lifecycle');
const { materializeCalculationEntry } = require('./payroll-calculation-entry-bridge');
const { persistPayrollSnapshotBundleInTransaction } = require('./payroll-snapshot-persistence');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[a-f0-9]{64}$/i;
const V2_ENGINE = 'payroll-verified-remaining-net-v2';
const V2_CAPABILITY = 'employee_attributed_remaining_net_refund_v2';
const PREVIEW_RUN_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const MAX_CENTS = 999999999999;
const fail = (code, status = 409) => { throw Object.assign(new Error(`payroll_unpaid_supersession_${code}`),
  { code: `payroll_unpaid_supersession_${code}`, status }); };
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().filter(key => value[key] !== undefined)
    .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const digest = value => createHash('sha256').update(value).digest('hex');
const validId = (value, code = 'id_invalid') => {
  if (typeof value !== 'string' || !UUID.test(value)) fail(code, 400);
  return value.toLowerCase();
};
const plain = value => Boolean(value && Object.getPrototypeOf(value) === Object.prototype
  && Reflect.ownKeys(value).every(key => typeof key === 'string')
  && Object.values(Object.getOwnPropertyDescriptors(value)).every(descriptor => Object.hasOwn(descriptor, 'value')));
const request = input => {
  if (!plain(input) || Reflect.ownKeys(input).length !== 3
      || !['expectedPlanHash', 'reason', 'idempotencyKey'].every(key => Object.hasOwn(input, key))
      || typeof input.expectedPlanHash !== 'string' || !SHA.test(input.expectedPlanHash)
      || typeof input.reason !== 'string' || input.reason.trim().length < 3 || input.reason.length > 500
      || typeof input.idempotencyKey !== 'string' || !/^[A-Za-z0-9_.:-]{8,120}$/.test(input.idempotencyKey)) {
    fail('request_invalid', 400);
  }
  return { expectedPlanHash: input.expectedPlanHash.toLowerCase(), reason: input.reason.trim(), idempotencyKey: input.idempotencyKey };
};
async function authorizeOwner(db, actor) {
  if (!plain(actor) || !UUID.test(actor.venueId || '') || !UUID.test(actor.userId || '')) fail('identity_invalid', 400);
  if (!hasPayrollVerifiedWriteSnapshot(db, actor.venueId)) fail('source_transaction_required', 500);
  const row = (await db.query(`SELECT full_name FROM users WHERE venue_id=$1 AND id=$2
    AND role='owner' AND is_active=true AND deleted_at IS NULL FOR SHARE`, [actor.venueId, actor.userId])).rows[0];
  if (!row) fail('owner_required', 403);
  return { venueId: actor.venueId.toLowerCase(), userId: actor.userId.toLowerCase(), name: row.full_name };
}
const replayEmployees = evidence => {
  const employees = (evidence?.calculatorReplay || evidence)?.result?.employees;
  if (!Array.isArray(employees) || !employees.length) fail('employee_cohort_invalid');
  const result = employees.map(employee => {
    if (!plain(employee)) fail('employee_cohort_invalid');
    const employeeId = validId(employee.employeeId, 'employee_cohort_invalid');
    if (!Number.isSafeInteger(employee.amountCents) || employee.amountCents < 0 || employee.amountCents > MAX_CENTS) fail('amount_invalid');
    return { employeeId, amountCents: employee.amountCents };
  }).sort((a, b) => a.employeeId.localeCompare(b.employeeId));
  if (new Set(result.map(x => x.employeeId)).size !== result.length) fail('employee_cohort_invalid');
  return result;
};
const evidenceInfo = (saved, raw) => {
  const evidence = saved.evidence, header = saved.header;
  const payload = evidence?.sourceEvidence;
  const scheme = evidence?.schemeSnapshot;
  if (!plain(evidence) || !plain(scheme) || !plain(payload)
      || raw.engine_version !== V2_ENGINE || header.capabilityVersion !== V2_CAPABILITY
      || evidence.capabilityVersion !== V2_CAPABILITY
      || !SHA.test(raw.input_checksum || '') || !SHA.test(raw.input_watermark || '')
      || evidence.schemeSnapshot.versionId !== raw.scheme_version_id) fail('original_run_not_v2');
  return { employees: replayEmployees(evidence), schemeHash: digest(canonical(scheme)),
    provenanceSha256: raw.input_checksum.toLowerCase(), inputWatermark: raw.input_watermark.toLowerCase(),
    capabilityVersion: evidence.capabilityVersion, evidence, header };
};
async function lockedOriginal(db, actor, runId) {
  const saved = await loadSavedRunEvidenceInTransaction(db, actor.venueId, runId);
  const row = (await db.query(`SELECT id,venue_id,scheme_version_id,period_from::text,period_to::text,currency,venue_timezone,
      engine_version,input_watermark,input_checksum,supersedes_run_id,status
    FROM payroll_calculation_runs WHERE venue_id=$1 AND id=$2 FOR UPDATE`, [actor.venueId, runId])).rows[0];
  if (!row || row.status !== 'ready') fail('original_run_invalid');
  const info = evidenceInfo(saved, row);
  const entries = (await db.query(`SELECT id,user_id,status,calculation_gross_cents::text,
      (amount*100)::bigint::text AS net_cents,finance_category_id,calculation_provenance_sha256
    FROM payroll_entries WHERE venue_id=$1 AND calculation_run_id=$2 ORDER BY user_id,id FOR UPDATE`,
  [actor.venueId, runId])).rows;
  if (entries.length !== info.employees.length) fail('original_entry_cohort_mismatch');
  const expectedIds = info.employees.map(x => x.employeeId), actualIds = entries.map(x => x.user_id.toLowerCase());
  if (new Set(actualIds).size !== actualIds.length || canonical(expectedIds) !== canonical(actualIds)) fail('original_entry_cohort_mismatch');
  const oldEntries = [];
  for (const rowEntry of entries) {
    if (!['draft', 'cancelled'].includes(rowEntry.status) || rowEntry.calculation_provenance_sha256 !== info.provenanceSha256) {
      fail('original_entries_not_unpaid_drafts');
    }
    const state = await getPayrollCalculationEntryState(db, actor, rowEntry.id, async () => ({ status: 'blocked' }));
    if (state.entry.status !== rowEntry.status || !SHA.test(state.stateHash) || !SHA.test(state.ledgerHash)) fail('entry_state_invalid');
    oldEntries.push({ employeeId: rowEntry.user_id.toLowerCase(), entryId: rowEntry.id.toLowerCase(), status: rowEntry.status,
      stateHash: state.stateHash, ledgerHash: state.ledgerHash, grossCents: state.entry.grossCents,
      amountCents: state.entry.amountCents, financeCategoryId: rowEntry.finance_category_id || null });
  }
  // A run may be replaced only once, and a replacement itself is terminal for this workflow.
  const prior = (await db.query(`SELECT id FROM payroll_run_supersession_requests
    WHERE venue_id=$1 AND original_run_id=$2`, [actor.venueId, runId])).rows[0];
  if (prior) fail('run_already_superseded');
  return { saved, row, info, entries, oldEntries };
}
const validateReplacement = (replacement, original, runId) => {
  if (!plain(replacement) || !plain(replacement.run) || !plain(replacement.input) || !plain(replacement.provenance)) fail('replacement_invalid');
  const run = replacement.run, input = replacement.input, provenance = replacement.provenance;
  if (run.engine_version !== V2_ENGINE || run.supersedes_run_id !== original.row.id
      || run.venue_id !== original.row.venue_id || run.scheme_version_id !== original.row.scheme_version_id
      || run.period_from !== original.row.period_from || run.period_to !== original.row.period_to
      || run.currency !== original.row.currency || run.venue_timezone !== original.row.venue_timezone
      || run.id !== runId || run.status !== 'ready'
      || !SHA.test(run.input_watermark || '') || !SHA.test(run.input_checksum || '')
      || provenance.capability_version !== V2_CAPABILITY || provenance.schema_version !== 2
      || provenance.run_id !== runId || provenance.venue_id !== run.venue_id) fail('replacement_invalid');
  let persistedEvidence;
  try { persistedEvidence = JSON.parse(provenance.evidence_payload); } catch (_) { fail('replacement_invalid'); }
  if (!plain(persistedEvidence) || persistedEvidence.capabilityVersion !== V2_CAPABILITY
      || persistedEvidence.inputWatermark !== run.input_watermark
      || digest(canonical(persistedEvidence.schemeSnapshot)) !== original.info.schemeHash
      || digest(provenance.evidence_payload) !== provenance.evidence_sha256
      || provenance.evidence_sha256 !== run.input_checksum) fail('replacement_provenance_invalid');
  const candidateEmployees = replayEmployees(persistedEvidence.calculatorReplay);
  const oldIds = original.info.employees.map(x => x.employeeId), newIds = candidateEmployees.map(x => x.employeeId);
  if (canonical(oldIds) !== canonical(newIds)) fail('replacement_employee_cohort_mismatch');
  const snapshotInputWatermark = persistedEvidence.snapshotInputWatermark;
  if (!SHA.test(snapshotInputWatermark || '')) fail('replacement_provenance_invalid');
  return { run, input, provenance, candidateEmployees, snapshotInputWatermark };
};
async function buildPlan(db, actor, runId, callbacks, original, replacementRunId) {
  if (!plain(callbacks) || typeof callbacks.buildReplacement !== 'function' || typeof callbacks.checkFreshness !== 'function') fail('callbacks_invalid', 500);
  const preparedRaw = await callbacks.buildReplacement(db, actor, original.saved, replacementRunId);
  const candidate = validateReplacement(preparedRaw, original, replacementRunId);
  const planPayload = canonical({ schemaVersion: 1, originalRunId: runId,
    originalProvenanceSha256: original.info.provenanceSha256, originalInputWatermark: original.info.inputWatermark,
    originalCapabilityVersion: original.info.capabilityVersion, historicalSchemeSha256: original.info.schemeHash,
    periodFrom: original.row.period_from, periodTo: original.row.period_to, currency: original.row.currency,
    replacementInputWatermark: candidate.run.input_watermark,
    replacementCapabilityVersion: V2_CAPABILITY, employeeAmounts: candidate.candidateEmployees,
    oldEntries: original.oldEntries });
  const planHash = digest(planPayload);
  return { candidate, planPayload, planHash };
}
async function previewUnpaidRunSupersession(db, actor, runId, callbacks) {
  runId = validId(runId);
  // Caller owns the fenced transaction. This method only reads and plans.
  actor = await authorizeOwner(db, actor);
  const original = await lockedOriginal(db, actor, runId);
  const plan = await buildPlan(db, actor, runId, callbacks, original, PREVIEW_RUN_ID);
  return { schemaVersion: 1, originalRunId: runId, planHash: plan.planHash,
    plan: JSON.parse(plan.planPayload), replacementAmounts: plan.candidate.candidateEmployees,
    oldEntries: original.oldEntries, monetaryWrites: false, payoutEligible: false };
}
const normalizeReceipt = row => {
  if (!row || typeof row.request_hash !== 'string' || !SHA.test(row.request_hash)
      || typeof row.plan_hash !== 'string' || !SHA.test(row.plan_hash)
      || typeof row.plan_payload !== 'string' || digest(row.plan_payload) !== row.plan_hash
      || typeof row.response_payload !== 'string' || digest(row.response_payload) !== row.response_sha256) fail('receipt_integrity_invalid');
  let plan, response;
  try { plan = JSON.parse(row.plan_payload); response = JSON.parse(row.response_payload); } catch (_) { fail('receipt_integrity_invalid'); }
  if (!plain(plan) || !plain(response) || response.journalId !== row.id
      || response.originalRunId !== row.original_run_id || response.replacementRunId !== row.replacement_run_id
      || response.planHash !== row.plan_hash) fail('receipt_integrity_invalid');
  if (!Array.isArray(plan.employeeAmounts) || !Array.isArray(plan.oldEntries) || !Array.isArray(response.entries)
      || response.entries.length !== plan.employeeAmounts.length) fail('receipt_integrity_invalid');
  const oldByEmployee = new Map(plan.oldEntries.map(item => [item.employeeId, item]));
  const seen = new Set();
  for (let index = 0; index < response.entries.length; index++) {
    const entry = response.entries[index], expected = plan.employeeAmounts[index], old = oldByEmployee.get(expected?.employeeId);
    if (!plain(entry) || !plain(expected) || !old || seen.has(entry.employeeId)
        || entry.employeeId !== expected.employeeId || entry.amountCents !== expected.amountCents
        || entry.financeCategoryId !== old.financeCategoryId || !UUID.test(entry.entryId || '')) fail('receipt_integrity_invalid');
    seen.add(entry.employeeId);
  }
  return response;
};
async function commitUnpaidRunSupersession(db, actor, runId, input, callbacks) {
  runId = validId(runId); const command = request(input);
    actor = await authorizeOwner(db, actor);
    const requestHash = digest(canonical({ schemaVersion: 1, venueId: actor.venueId, actorId: actor.userId,
      originalRunId: runId, expectedPlanHash: command.expectedPlanHash, reason: command.reason }));
    // Exact receipt lookup precedes current run/entry state checks so lost-response retries replay.
    const prior = (await db.query(`SELECT id,original_run_id,replacement_run_id,idempotency_key,request_hash,plan_hash,
        plan_payload,response_payload,response_sha256,created_by
      FROM payroll_run_supersession_requests WHERE venue_id=$1 AND idempotency_key=$2 FOR UPDATE`,
    [actor.venueId, command.idempotencyKey])).rows[0];
    if (prior) {
      if (prior.request_hash !== requestHash || prior.created_by !== actor.userId || prior.original_run_id !== runId) fail('idempotency_conflict');
      const receipt = normalizeReceipt(prior);
      return { ...receipt, replayed: true };
    }
    const original = await lockedOriginal(db, actor, runId);
    const replacementRunId = randomUUID();
    const plan = await buildPlan(db, actor, runId, callbacks, original, replacementRunId);
    if (plan.planHash !== command.expectedPlanHash) fail('plan_stale');
    plan.candidate.run = { ...plan.candidate.run, recalculation_reason: command.reason };
    const entryResults = [];
    for (const old of original.oldEntries) {
      if (old.status === 'cancelled') continue;
      const transition = await transitionPayrollCalculationEntry(db, actor, old.entryId, {
        action: 'cancel', expectedStateHash: old.stateHash,
        idempotencyKey: `supersession-cancel:${digest(`${runId}:${old.employeeId}:${command.idempotencyKey}`).slice(0, 48)}`,
        paymentDate: null, paymentAccountId: null, paymentMethod: null, reason: command.reason
      }, callbacks.checkFreshness);
      if (transition.action !== 'cancel' || transition.entry.status !== 'cancelled') fail('old_entry_cancel_failed');
    }
    await persistPayrollSnapshotBundleInTransaction(db, { run: plan.candidate.run,
      input: plan.candidate.input, provenance: plan.candidate.provenance });
    for (const employee of plan.candidate.candidateEmployees) {
      const old = original.oldEntries.find(item => item.employeeId === employee.employeeId);
      const key = `supersession:${digest(`${requestHash}:${employee.employeeId}`).slice(0, 56)}`;
      const materialized = await materializeCalculationEntry(db, actor, { runId: replacementRunId,
        employeeId: employee.employeeId, financeCategoryId: old.financeCategoryId, idempotencyKey: key }, callbacks.checkFreshness);
      if (materialized.currentEntry?.status !== 'draft' || materialized.currentEntry.amountCents !== employee.amountCents
          || materialized.currentEntry.financeCategoryId !== old.financeCategoryId) fail('replacement_entry_invalid');
      entryResults.push({ employeeId: employee.employeeId, entryId: materialized.currentEntry.id,
        amountCents: employee.amountCents, financeCategoryId: old.financeCategoryId });
    }
    const journalId = randomUUID();
    const response = { schemaVersion: 1, journalId, originalRunId: runId, replacementRunId,
      planHash: plan.planHash, entries: entryResults, replayed: false };
    const responsePayload = canonical(response);
    await db.query(`INSERT INTO payroll_run_supersession_requests
      (id,venue_id,original_run_id,replacement_run_id,idempotency_key,request_hash,plan_hash,plan_payload,
       response_payload,response_sha256,created_by,created_by_name,reason)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [journalId, actor.venueId, runId, replacementRunId, command.idempotencyKey, requestHash, plan.planHash,
      plan.planPayload, responsePayload, digest(responsePayload), actor.userId, actor.name, command.reason]);
    return response;
}

module.exports = { previewUnpaidRunSupersession, commitUnpaidRunSupersession };
