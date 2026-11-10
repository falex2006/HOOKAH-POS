'use strict';
// Read the H1 claim, creation receipt, transitions and expense in a source-fenced OWNER
// transaction. This observes H1 but never authorizes H2 or any payout.
const { createHash } = require('node:crypto');
const { hasPayrollVerifiedWriteSnapshot, hasPayrollVerifiedReadSnapshot } = require('./payroll-source-fence');
const { verifyPayrollCalculationEntryEvidence } = require('./payroll-calculation-entry-evidence');
const { verifyCapturedH1Corrections } = require('./payroll-calculation-entry-corrections');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
const fail = suffix => { throw Object.assign(new Error(`payroll_h1_state_${suffix}`), { code:`payroll_h1_state_${suffix}`,status:409 }); };
const validId = s => typeof s === 'string' && UUID.test(s);
const cents = x => { if(typeof x !== 'string' || !/^(0|[1-9][0-9]*)$/.test(x) || BigInt(x)>BigInt(Number.MAX_SAFE_INTEGER)) fail('amount_invalid'); return Number(x); };
const record = x => x && Object.getPrototypeOf(x) === Object.prototype && Reflect.ownKeys(x).every(k => typeof k === 'string' && Object.hasOwn(Object.getOwnPropertyDescriptor(x,k),'value'));
function requestShape(input) {
  if(!record(input) || Reflect.ownKeys(input).sort().join(',') !== 'employeeId,month' || !validId(input.employeeId)
      || typeof input.month!=='string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(input.month) || input.month.startsWith('0000')) fail('request_invalid');
  return { employeeId:input.employeeId,from:`${input.month}-01`,to:`${input.month}-14` };
}
function receipt(row, action, claim) {
  if(!row || row.action!==action || row.venue_id!==claim.venue_id || row.entry_id!==claim.entry_id
      || row.employee_id!==claim.employee_id || row.calculation_run_id!==claim.run_id
      || row.provenance_sha256!==claim.provenance_sha256 || !validId(row.transition_id) || !validId(row.created_by) || row.request_actor!==row.created_by
      || row.to_status!==(action==='approve'?'approved':action==='pay'?'paid':'cancelled')
      || (action==='approve' && row.from_status!=='draft') || (action==='pay' && row.from_status!=='approved')
      || typeof row.response_payload!=='string' || !SHA.test(row.response_hash||'')
      || createHash('sha256').update(row.response_payload,'utf8').digest('hex')!==row.response_hash) fail('receipt_invalid');
  let p; try { p=JSON.parse(row.response_payload); } catch { fail('receipt_invalid'); }
  const expectedStatus=action==='approve'?'approved':action==='pay'?'paid':'cancelled';
  if(!record(p) || p.schemaVersion!==1 || p.replayed!==false || p.action!==action || p.transitionId!==row.transition_id
      || !record(p.entry) || p.entry.id!==claim.entry_id || p.entry.userId!==claim.employee_id
      || p.entry.calculationRunId!==claim.run_id || p.entry.provenanceSha256!==claim.provenance_sha256
      || p.entry.periodFrom!==claim.period_from || p.entry.periodTo!==claim.period_to || p.entry.status!==expectedStatus
      || p.entry.currency!=='RUB' || p.entry.grossCents!==cents(row.gross_cents) || p.entry.amountCents!==cents(row.net_cents)
      || (action==='pay' && (p.entry.expenseId!==row.expense_id || p.entry.paymentDate!==row.payment_date))) fail('receipt_invalid');
  if(typeof row.source_proof_payload!=='string' || !SHA.test(row.source_proof_sha256||'') || !SHA.test(row.ledger_hash||'')
      || createHash('sha256').update(row.source_proof_payload,'utf8').digest('hex')!==row.source_proof_sha256) fail('transition_proof_invalid');
  let proof; try { proof=JSON.parse(row.source_proof_payload); } catch { fail('transition_proof_invalid'); }
  if(!record(proof)||proof.proofKind!=='current_transition'||proof.venueId!==claim.venue_id||proof.entryId!==claim.entry_id
      ||proof.employeeId!==claim.employee_id||proof.runId!==claim.run_id||proof.entryStatus!==row.from_status
      ||proof.periodFrom!==claim.period_from||proof.periodTo!==claim.period_to||proof.grossCents!==cents(row.gross_cents)
      ||proof.netCents!==cents(row.net_cents)||proof.evidenceHashes?.provenanceSha256!==claim.provenance_sha256
      ||proof.corrections?.ledgerHash!==row.ledger_hash || proof.corrections?.netCents!==proof.netCents
      ||!Number.isSafeInteger(proof.corrections?.appliedCents) || proof.corrections.appliedCents<0
      ||proof.grossCents-proof.corrections.appliedCents!==proof.netCents) fail('transition_proof_invalid');
  return {payload:p,corrections:proof.corrections,netMinor:cents(row.net_cents),grossMinor:cents(row.gross_cents),ledgerHash:row.ledger_hash};
}
async function readH1StateInTransaction(db, actor, input, {checkFreshness, readOnly = false}={}) {
  const verifiedSnapshot = readOnly ? hasPayrollVerifiedReadSnapshot : hasPayrollVerifiedWriteSnapshot;
  const q=requestShape(input);
  if(!db || typeof db.query!=='function' || !record(actor) || !validId(actor.venueId) || !validId(actor.userId)
      || !verifiedSnapshot(db,actor.venueId)) fail('source_transaction_required');
  const own=(await db.query(`SELECT id FROM users WHERE venue_id=$1 AND id=$2 AND role='owner' AND is_active=true AND deleted_at IS NULL${readOnly ? '' : ' FOR SHARE'}`,[actor.venueId,actor.userId])).rows;
  if(own.length!==1 || own[0].id!==actor.userId) fail('owner_required');
  const rows=(await db.query(`SELECT c.id AS claim_id,c.venue_id,c.employee_id,c.month_from::text AS month_from,
    c.period_from::text AS period_from,c.period_to::text AS period_to,c.run_id,c.entry_id,c.provenance_sha256,c.created_by,
    e.status,e.payroll_half_kind,e.payroll_h1_insert_xid::text AS payroll_h1_insert_xid,e.amount::text AS amount,
    (e.amount*100)::bigint::text AS net_cents,e.calculation_gross_cents::text AS calculation_gross_cents,
    e.calculation_run_id,e.calculation_provenance_sha256,e.user_id,e.venue_id AS entry_venue_id,e.id,
    e.period_from::text AS entry_period_from,e.period_to::text AS entry_period_to,e.paid_by,e.paid_at,
    e.payment_date::text AS payment_date,e.expense_id,e.finance_category_id,e.finance_category_name_snapshot,e.materialized_by
    FROM payroll_h1_claim_slots s JOIN payroll_half_month_claims c ON c.venue_id=s.venue_id AND c.employee_id=s.employee_id AND c.month_from=s.month_from AND c.id=s.claim_id
    JOIN payroll_entries e ON e.venue_id=c.venue_id AND e.id=c.entry_id
    WHERE s.venue_id=$1 AND s.employee_id=$2 AND s.month_from=$3::date ${readOnly ? '' : 'FOR UPDATE OF s,e'}`,[actor.venueId,q.employeeId,q.from])).rows;
  if(rows.length!==1) fail(rows.length?'claim_ambiguous':'claim_missing');
  const c=rows[0];
  if(!validId(c.claim_id)||!validId(c.entry_id)||!validId(c.run_id)||c.venue_id!==actor.venueId||c.entry_venue_id!==actor.venueId
      ||c.employee_id!==q.employeeId||c.user_id!==q.employeeId||c.id!==c.entry_id||c.month_from!==q.from
      ||c.period_from!==q.from||c.period_to!==q.to||c.entry_period_from!==q.from||c.entry_period_to!==q.to
      ||c.calculation_run_id!==c.run_id||c.payroll_half_kind!=='h1'||!/^\d+$/.test(c.payroll_h1_insert_xid||'')
      ||!SHA.test(c.provenance_sha256||'')||c.calculation_provenance_sha256!==c.provenance_sha256 || c.materialized_by!==c.created_by) fail('claim_binding_invalid');
  const conflicts=(await db.query(`SELECT id FROM payroll_entries WHERE venue_id=$1 AND user_id=$2 AND id<>$3
    AND status IN ('draft','approved','paid') AND period_from<=$5::date AND period_to>=$4::date LIMIT 1`,
    [actor.venueId,q.employeeId,c.entry_id,q.from,q.to])).rows;
  if(conflicts.length) fail('overlap_requires_review');
  const creation=(await db.query(`SELECT created_by,response_payload,response_sha256 FROM payroll_calculation_entry_requests
    WHERE venue_id=$1 AND entry_id=$2 AND (response_payload::jsonb)->>'existing'='false' LIMIT 2`,[actor.venueId,c.entry_id])).rows;
  if(creation.length!==1 || creation[0].created_by!==c.created_by || typeof creation[0].response_payload!=='string'
      || !SHA.test(creation[0].response_sha256||'')
      || createHash('sha256').update(creation[0].response_payload,'utf8').digest('hex')!==creation[0].response_sha256) fail('materialization_receipt_invalid');
  let initial; try { initial=JSON.parse(creation[0].response_payload); } catch { fail('materialization_receipt_invalid'); }
  if(!record(initial) || initial.schemaVersion!==1 || initial.existing!==false || initial.replayed!==false || !record(initial.entry)
      || initial.entry.id!==c.entry_id || initial.entry.userId!==c.employee_id || initial.entry.status!=='draft'
      || initial.entry.origin!=='calculation_run' || initial.entry.calculationRunId!==c.run_id
      || initial.entry.provenanceSha256!==c.provenance_sha256 || initial.entry.periodFrom!==q.from || initial.entry.periodTo!==q.to
      || initial.entry.currency!=='RUB' || initial.entry.amountCents!==cents(c.calculation_gross_cents)) fail('materialization_receipt_invalid');
  if(c.status==='cancelled') fail('cancelled_requires_review');
  if(c.status==='draft') return Object.freeze({status:'draft_pending',venueId:actor.venueId,employeeId:q.employeeId,month:q.from.slice(0,7),currency:'RUB',runId:c.run_id,period:Object.freeze({from:q.from,to:q.to}),claimId:c.claim_id,entryId:c.entry_id,
    grossAccruedMinor:null,netDueMinor:null,paidMinor:null,appliedCorrectionMinor:null,usableForH2:false,officialReady:false,payoutEligible:false,sourceAttested:false,ledgerAttested:false,persistence:'none'});
  if(!['approved','paid'].includes(c.status)) fail('status_invalid');
  const payload=(await db.query(`SELECT t.id AS transition_id,t.venue_id,t.entry_id,t.employee_id,t.calculation_run_id,
    t.provenance_sha256,t.action,t.from_status,t.to_status,t.gross_cents::text AS gross_cents,t.net_cents::text AS net_cents,t.ledger_hash,t.source_proof_payload,t.source_proof_sha256,t.settlement_kind,t.expense_id,t.payment_date::text AS payment_date,
    t.payment_method,t.finance_account_id,t.finance_account_name_snapshot,t.shift_id,t.created_by,t.created_at,
    x.response_payload,x.response_hash,x.created_by AS request_actor,e.id AS expense_row_id,e.venue_id AS expense_venue_id,e.source AS expense_source,
    (e.amount*100)::bigint::text AS expense_cents,e.expense_date::text AS expense_date,e.created_by AS expense_created_by,
    e.category_id AS expense_category_id,e.category AS expense_category,e.payment_method AS expense_payment_method,e.finance_account_id AS expense_account_id,
    e.finance_account_name_snapshot AS expense_account_name,e.shift_id AS expense_shift_id,e.payroll_calculation_entry_id AS expense_entry_id,e.payroll_settlement_entry_id AS expense_witness_entry_id
    FROM payroll_calculation_entry_transitions t LEFT JOIN payroll_calculation_entry_transition_requests x
      ON x.venue_id=t.venue_id AND x.transition_id=t.id
    LEFT JOIN expenses e ON e.venue_id=t.venue_id AND e.id=t.expense_id
    WHERE t.venue_id=$1 AND t.entry_id=$2 ORDER BY t.action,x.id`,[actor.venueId,c.entry_id])).rows;
  const approves=payload.filter(x=>x.action==='approve'), pays=payload.filter(x=>x.action==='pay');
  if(approves.length!==1 || (c.status==='paid'?pays.length!==1:pays.length!==0) || payload.some(x=>!['approve','pay'].includes(x.action))) fail('transition_history_invalid');
  const approval=receipt(approves[0],'approve',c);
  if(c.status==='approved' && (c.expense_id!==null || c.paid_at!==null || c.paid_by!==null || c.payment_date!==null)) fail('payment_mismatch');
  const proof=await verifyPayrollCalculationEntryEvidence(db,actor,c,{purpose:c.status==='paid'?'historical_paid':'current_transition',checkFreshness,readOnly});
  const corrections=await verifyCapturedH1Corrections(db,actor,proof,approval.corrections,readOnly);
  if(!corrections || !SHA.test(corrections.ledgerHash||'') || !Number.isSafeInteger(proof.netCents)
      || !Number.isSafeInteger(proof.grossCents) || !Number.isSafeInteger(corrections.appliedCents)
      || corrections.appliedCents<0 || proof.grossCents!==cents(c.calculation_gross_cents)
      || proof.grossCents-corrections.appliedCents!==proof.netCents || proof.netCents!==cents(c.net_cents)
      || corrections.netCents!==proof.netCents || approval.grossMinor!==proof.grossCents
      || approval.ledgerHash!==corrections.ledgerHash || approval.netMinor!==proof.netCents) fail('correction_evidence_invalid');
  let paidMinor=0;
  if(c.status==='paid') {
    const t=pays[0], observed=receipt(t,'pay',c); paidMinor=observed.netMinor;
    const settlementCorrections=await verifyCapturedH1Corrections(db,actor,proof,observed.corrections,readOnly);
    if(settlementCorrections.appliedCents!==corrections.appliedCents || paidMinor!==proof.netCents || observed.grossMinor!==proof.grossCents  || t.created_by!==c.paid_by || t.payment_date!==c.payment_date
        || t.expense_id!==c.expense_id || !c.paid_at || !t.created_at || new Date(c.paid_at).getTime()!==new Date(t.created_at).getTime()) fail('payment_mismatch');
    if(t.settlement_kind==='zero') { if(paidMinor!==0 || c.expense_id!==null || t.expense_row_id!==null || t.payment_method!==null
        ||t.finance_account_id!==null || t.finance_account_name_snapshot!==null || t.shift_id!==null) fail('payment_mismatch'); }
    else if(t.settlement_kind==='positive_expense') {
      if(paidMinor<=0 || !validId(t.expense_id) || !validId(t.finance_account_id)
          || !['cash','card','bank_transfer','other'].includes(t.payment_method)
          || typeof t.finance_account_name_snapshot!=='string' || !t.finance_account_name_snapshot.trim()
          || t.expense_row_id!==t.expense_id || t.expense_venue_id!==actor.venueId
          ||t.expense_source!=='payroll'||cents(t.expense_cents)!==paidMinor||t.expense_date!==t.payment_date
          ||t.expense_created_by!==t.created_by||t.expense_category_id!==c.finance_category_id
          ||t.expense_category!==(c.finance_category_name_snapshot||'Зарплата')||t.expense_payment_method!==t.payment_method||t.expense_account_id!==t.finance_account_id
          ||t.expense_account_name!==t.finance_account_name_snapshot||t.expense_shift_id!==t.shift_id||t.expense_entry_id!==c.entry_id||t.expense_witness_entry_id!==c.entry_id) fail('payment_mismatch');
    } else fail('payment_mismatch');
  }
  return Object.freeze({status:c.status,venueId:actor.venueId,employeeId:q.employeeId,month:q.from.slice(0,7),currency:'RUB',claimId:c.claim_id,entryId:c.entry_id,runId:c.run_id,period:Object.freeze({from:q.from,to:q.to}),
    grossAccruedMinor:proof.grossCents,protectedFixedMinor:proof.protectedFixedCents,netDueMinor:proof.netCents,paidMinor,appliedCorrectionMinor:corrections.appliedCents,ledgerHash:corrections.ledgerHash,usableForH2:true,officialReady:false,payoutEligible:false,sourceAttested:false,ledgerAttested:false,persistence:'none'});
}
module.exports={readH1StateInTransaction};
