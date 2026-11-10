'use strict';

// DB-owned reservation and entry binding for the H2 half-month settlement.
// The migration adds exact FKs/uniqueness and deferred checks; these routines
// run only inside the owner's source-fenced transaction.
const { createHash } = require('node:crypto');
const {loadSavedRunEvidenceInTransaction} = require('./payroll-saved-run-reader');
const {verifyPayrollDeferredMonthEvidence} = require('./payroll-deferred-month-evidence');
const { hasPayrollVerifiedWriteSnapshot } = require('./payroll-source-fence');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[a-f0-9]{64}$/;
const fail = suffix => { throw Object.assign(new Error(`payroll_h2_claim_${suffix}`), {
  code: `payroll_h2_claim_${suffix}`, status: 409
}); };
const digest = payload => createHash('sha256').update(payload,'utf8').digest('hex');
const id = value => { if (typeof value !== 'string' || !UUID.test(value)) fail('identity_invalid'); return value.toLowerCase(); };
const minor = value => { if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) fail('amount_invalid'); return value; };

async function readH2ClaimForEntryInTransaction(db, actor, entry) {
  if (!db || typeof db.query !== 'function' || !hasPayrollVerifiedWriteSnapshot(db, actor?.venueId)) fail('source_transaction_required');
  const rows = (await db.query(`SELECT c.id::text AS claim_id,c.venue_id::text,c.employee_id::text,c.month_from::text,c.monthly_run_id::text,
      c.h1_claim_id::text,c.h1_origin,c.zero_base_payload,c.zero_base_sha256,c.h2_run_id::text,c.h2_entry_id::text,
      c.evidence_sha256,c.created_by::text,p.evidence_payload,s.claim_id::text AS active_claim_id,
      h1.entry_id::text AS h1_entry_id,h1.run_id::text AS h1_run_id
    FROM payroll_h2_settlement_claims c JOIN payroll_run_provenance p
      ON p.venue_id=c.venue_id AND p.run_id=c.h2_run_id
    LEFT JOIN payroll_h2_claim_slots s ON s.venue_id=c.venue_id AND s.employee_id=c.employee_id
      AND s.month_from=c.month_from AND s.claim_id=c.id
    LEFT JOIN payroll_half_month_claims h1 ON h1.venue_id=c.venue_id AND h1.id=c.h1_claim_id
    WHERE c.venue_id=$1 AND c.h2_run_id=$2 AND c.employee_id=$3 AND c.h2_entry_id=$4 FOR UPDATE OF c`,
  [actor.venueId,id(entry.runId),id(entry.employeeId),id(entry.id)])).rows;
  if (rows.length !== 1) fail('entry_claim_missing');
  const row = rows[0], month = String(row.month_from).slice(0, 7);
  if (row.venue_id !== actor.venueId || row.employee_id !== entry.employeeId || row.h2_run_id !== entry.runId
      || row.h2_entry_id !== entry.id || row.evidence_sha256 !== entry.provenanceSha256
      || row.monthly_run_id === row.h2_run_id
      || entry.periodFrom !== `${month}-15` || entry.periodTo < entry.periodFrom || entry.periodTo.slice(0, 7) !== month
      || !SHA.test(row.evidence_sha256||'')) fail('entry_claim_mismatch');
  let settlement; try { settlement=JSON.parse(row.evidence_payload); } catch (_) { fail('entry_evidence_invalid'); }
  if (digest(row.evidence_payload)!==row.evidence_sha256 || settlement.monthlyRunId!==row.monthly_run_id
      || settlement.h2RunId!==row.h2_run_id || settlement.employeeId!==row.employee_id
      || settlement.periodFrom!==entry.periodFrom || settlement.periodTo!==entry.periodTo
      || minor(settlement.monthlyGrossMinor)-minor(settlement.h1GrossAccruedMinor)!==minor(settlement.h2GrossAccruedMinor)
      || minor(settlement.h2GrossAccruedMinor)!==entry.grossCents
      || (row.h1_origin==='official_claim' && (!row.h1_claim_id||row.h1_entry_id!==settlement.h1Binding?.h1EntryId
        || row.h1_run_id!==settlement.h1Binding?.h1RunId))
      || (row.h1_origin==='verified_zero_base' && (!row.zero_base_payload||!SHA.test(row.zero_base_sha256||'')
        || digest(row.zero_base_payload)!==row.zero_base_sha256))) fail('entry_evidence_binding_mismatch');
  return Object.freeze({ month, monthlyRunId:row.monthly_run_id,h1ClaimId:row.h1_claim_id,
    h1EntryId:row.h1_entry_id,h1RunId:row.h1_run_id,h2RunId:row.h2_run_id,h2EntryId:row.h2_entry_id,
    monthlyGrossMinor:Number(settlement.monthlyGrossMinor),h1GrossMinor:Number(settlement.h1GrossAccruedMinor),
    h2GrossMinor:Number(settlement.h2GrossAccruedMinor),h1Origin:row.h1_origin,
    h1ZeroBaseEvidencePayload:row.zero_base_payload,h1ZeroBaseEvidenceSha256:row.zero_base_sha256,
    active:row.active_claim_id===row.claim_id,economicEvidenceSha256:settlement.economicEvidenceSha256,
    settlementEvidence:structuredClone(settlement),settlementPayload:row.evidence_payload,provenanceSha256:row.evidence_sha256});
}

async function readH2CancellationBasis(db,actor,entry) {
  const claim = await readH2ClaimForEntryInTransaction(db,actor,entry);
  const monthly = await loadSavedRunEvidenceInTransaction(db,actor.venueId,claim.monthlyRunId);
  const saved = verifyPayrollDeferredMonthEvidence(claim.settlementPayload,monthly.evidence);
  if (!claim.active || !saved.valid || saved.evidenceSha256 !== entry.provenanceSha256) fail('cancellation_basis_invalid');
  return {gross:String(claim.h2GrossMinor),fixed:String(claim.settlementEvidence.h2ProtectedFixedMinor)};
}

module.exports = {readH2ClaimForEntryInTransaction,readH2CancellationBasis};
