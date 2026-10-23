import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { beginPayrollVerifiedRunSourceTransaction } = require('../payroll-source-fence');
const { collectPayrollRefundAwarePaidReviewInTransaction } = require('../payroll-refund-aware-paid-review-source');
const { readPayrollRecognitionEvidenceInTransaction } = require('../payroll-recognition-manifest');
const { verifyPayrollCalculationEntryEvidence } = require('../payroll-calculation-entry-evidence');
const { buildPayrollRefundAwareRunProvenance } = require('../payroll-refund-aware-provenance');
const { buildPayrollRefundAwarePaidReviewAssessment } = require('../payroll-refund-aware-paid-review-assessment');
const CAPABILITY = 'employee_attributed_remaining_net_refund_v2';
const hash = value => createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value==='object' ? `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value);
const fields = ['basePayCents','commissionCents','teamFundCents','milestoneBonusCents','capReductionCents','amountCents'];
const totals = row => ({...Object.fromEntries(fields.map(key=>[key,row?.[key] ?? 0])),
  variableBeforeCapCents:(row?.commissionCents ?? 0)+(row?.teamFundCents ?? 0)+(row?.milestoneBonusCents ?? 0)});

async function requireOwnedDatabase(pool) {
  const name = (await pool.query('SELECT current_database() AS name')).rows[0].name;
  assert.match(name,/^orders_qa_[a-f0-9]{16}$/); assert.equal(name,process.env.LOCAL_FULL_PG_OWNED_DATABASE);
}
async function monetarySnapshot(pool,venueId) {
  const result = {};
  for (const table of ['payroll_entries','expenses','payroll_calculation_entry_transitions',
    'payroll_calculation_entry_transition_requests','payroll_correction_claims','payroll_correction_batches',
    'payroll_correction_events','payroll_correction_requests','payroll_refund_aware_paid_assessments']) {
    result[table] = (await pool.query(`SELECT count(*)::int AS count,
      encode(sha256(convert_to(COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text,'UTF8')),'hex') AS hash
      FROM ${table} t WHERE venue_id=$1`,[venueId])).rows[0];
  }
  return result;
}

// Explicitly pays the two genuine source-backed entries, once each. No fake
// paid DTO or manually inserted expense/transition is accepted by this helper.
export async function settleAllModeOriginal({pool,fixture,run,mode,expectedAmounts}) {
  await requireOwnedDatabase(pool);
  const {service,owner,ids,period} = fixture, employeeIds = [ids.employee,ids.zeroEmployee];
  const entries = [], payCommands = [];
  for (const [index,employeeId] of employeeIds.entries()) {
    const entry = (await service.materializeCalculationEntry(owner,run.runId,
      {employeeId,financeCategoryId:null,idempotencyKey:`all7-entry-${employeeId}`})).entry;
    entries.push(entry);
    for (const action of ['approve','pay']) {
      const state = await service.getCalculationEntryState(owner,entry.id);
      const command = {action,expectedStateHash:state.stateHash,idempotencyKey:`all7-${action}-${employeeId}`,
        reason:null,paymentDate:action==='pay'?period.to:null,paymentMethod:action==='pay'?'card':null,
        paymentAccountId:action==='pay'?ids.account:null};
      const result = await service.transitionCalculationEntry(owner,entry.id,command);
      assert.equal(result.entry.status,action==='pay'?'paid':'approved');
      if (action==='pay') payCommands.push({entryId:entry.id,command});
    }
    const row = (await pool.query('SELECT status,(amount*100)::bigint::text AS cents,expense_id FROM payroll_entries WHERE venue_id=$1 AND id=$2',
      [ids.venue,entry.id])).rows[0];
    assert.equal(row.status,'paid'); assert.equal(Number(row.cents),expectedAmounts[index]); assert.ok(row.expense_id);
  }
  const settled = await monetarySnapshot(pool,ids.venue);
  assert.equal(settled.payroll_entries.count,2); assert.equal(settled.expenses.count,2);
  assert.equal(settled.payroll_calculation_entry_transitions.count,4);
  assert.equal(settled.payroll_calculation_entry_transition_requests.count,4);
  for (const table of ['payroll_correction_claims','payroll_correction_batches','payroll_correction_events',
    'payroll_correction_requests','payroll_refund_aware_paid_assessments']) assert.equal(settled[table].count,0);
  for (const {entryId,command} of payCommands) {
    const retry = await service.transitionCalculationEntry(owner,entryId,command);
    assert.equal(retry.replayed,true); assert.equal(retry.entry.status,'paid');
  }
  assert.deepEqual(await monetarySnapshot(pool,ids.venue),settled,'payment retries create no second expense or receipt');
  const receipts = (await pool.query(`SELECT entry_id,source_proof_payload,source_proof_sha256,ledger_hash,
    gross_cents::text,net_cents::text,settlement_kind FROM payroll_calculation_entry_transitions
    WHERE venue_id=$1 AND calculation_run_id=$2 AND action='pay' ORDER BY entry_id`,[ids.venue,run.runId])).rows;
  assert.equal(receipts.length,2);
  for (const receipt of receipts) {
    assert.equal(receipt.settlement_kind,'positive_expense'); assert.equal(receipt.gross_cents,receipt.net_cents);
    assert.equal(hash(receipt.source_proof_payload),receipt.source_proof_sha256);
    const proof = JSON.parse(receipt.source_proof_payload), correction = proof.corrections;
    assert.equal(proof.capabilityVersion,CAPABILITY); assert.equal(proof.entryId,receipt.entry_id);
    assert.equal(correction.ledgerCaptureSchemaVersion,1); assert.deepEqual(correction.ledgerEventIds,[]);
    assert.deepEqual(correction.activeApplicationIds,[]); assert.equal(correction.appliedCents,0);
    assert.equal(correction.ledgerHash,hash('[]')); assert.equal(receipt.ledger_hash,hash('[]'));
    const {correctionEvidenceHash,...body}=correction;
    assert.equal(correctionEvidenceHash,hash(canonical(body)));
  }
  const saved = (await pool.query('SELECT evidence_payload,evidence_sha256 FROM payroll_run_provenance WHERE venue_id=$1 AND run_id=$2',
    [ids.venue,run.runId])).rows[0];
  assert.equal(hash(saved.evidence_payload),saved.evidence_sha256);
  return {mode,run,entries,employeeIds,expectedAmounts,saved,settled,payCommands};
}

// Rebuild the frozen original with current immutable refund evidence in one
// real source fence. This is assessment only: every original financial row and
// every claim/event/receipt count must remain exactly unchanged.
export async function verifyAllModePaidAssessment({pool,fixture,paid,expectedAmounts,stage}) {
  await requireOwnedDatabase(pool);
  const {owner,ids,period,service}=fixture;
  assert.deepEqual(await monetarySnapshot(pool,ids.venue),paid.settled);
  const db = await pool.connect(); let release;
  try {
    release = await beginPayrollVerifiedRunSourceTransaction(db,ids.venue);
    const collected = await collectPayrollRefundAwarePaidReviewInTransaction(db,owner,paid.run.runId);
    assert.equal(collected.sourceCollection,'verified_private_paid_entry_rows');
    const assessment=collected.assessment;
    assert.equal(assessment.status,'paid_review_assessed'); assert.equal(assessment.financialAction,'none');
    assert.equal(assessment.persistence,'none'); assert.equal(assessment.paidReviews.length,2);
    const savedEvidence=JSON.parse(paid.saved.evidence_payload), frozen=savedEvidence.sourceBundle;
    const recognitionEvidence=await readPayrollRecognitionEvidenceInTransaction(db,
      {venueId:ids.venue,currency:'RUB',from:period.from,to:period.to});
    const closure=(await db.query(`SELECT transaction_timestamp()::text AS "transactionTimestamp",
      (transaction_timestamp() AT TIME ZONE timezone)::date::text AS "venueLocalDate",timezone FROM venues WHERE id=$1`,[ids.venue])).rows[0];
    const periodClosure={schemaVersion:1,venueId:ids.venue,period,...closure};
    const pure = buildPayrollRefundAwareRunProvenance({venueId:ids.venue,runId:paid.run.runId,
      scheme:structuredClone(savedEvidence.schemeSnapshot),period,periodClosure,recognitionEvidence,
      employmentEligibility:structuredClone(frozen.employmentEligibility),approvedAttendanceSource:structuredClone(frozen.approvedAttendanceSource),
      departmentMapping:structuredClone(frozen.departmentMapping),costEvidenceByOrder:structuredClone(frozen.costEvidenceByOrder)});
    assert.equal(pure.status,'verified_run_evidence',`${paid.mode}/${stage} saved counterfactual rebuild`);
    const current=pure.prepared.verifiedCalculation.engineResult, baseline=savedEvidence.calculatorReplay.result;
    const paidEntries=[];
    for (const [index,employeeId] of paid.employeeIds.entries()) {
      const original=baseline.employees.find(row=>row.employeeId===employeeId), candidate=current.employees.find(row=>row.employeeId===employeeId);
      assert.equal(candidate.amountCents,expectedAmounts[index]);
      const delta=assessment.employeeDeltas.find(row=>row.employeeId===employeeId);
      assert.deepEqual(delta.baseline,totals(original)); assert.deepEqual(delta.current,totals(candidate));
      for (const key of Object.keys(totals(original))) assert.equal(delta.delta[key],totals(candidate)[key]-totals(original)[key]);
      const review=assessment.paidReviews.find(row=>row.employeeId===employeeId);
      assert.equal(review.incomingSettledCents,0); assert.equal(review.originalProtectedFixedCents,0);
      assert.equal(review.grossCents,paid.expectedAmounts[index]); assert.equal(review.netCents,paid.expectedAmounts[index]);
      assert.equal(review.candidateGrossCents,expectedAmounts[index]);
      assert.equal(review.potentialReductionReviewCents,paid.expectedAmounts[index]-expectedAmounts[index]);
      assert.equal(review.signedCounterfactualDeltaCents,expectedAmounts[index]-paid.expectedAmounts[index]);
      assert.equal(review.positiveEntitlementInformationCents,0);
      assert.equal(review.settlementEffect,'assessment_only_no_claim_or_payment');
      const row=(await db.query('SELECT *,period_from::text AS period_from,period_to::text AS period_to FROM payroll_entries WHERE venue_id=$1 AND id=$2',
        [ids.venue,paid.entries[index].id])).rows[0];
      const proof=await verifyPayrollCalculationEntryEvidence(db,owner,row,{purpose:'historical_paid'});
      paidEntries.push({entryId:proof.entryId,employeeId:proof.employeeId,runId:proof.runId,grossCents:proof.grossCents,
        netCents:proof.netCents,protectedFixedCents:proof.protectedFixedCents,incomingSettledCents:0,evidenceHashes:proof.evidenceHashes});
      for (const day of current.daily) {
        const oldDay=baseline.daily.find(value=>value.date===day.date), dayDelta=assessment.dailyDeltas.find(value=>value.date===day.date&&value.employeeId===employeeId);
        const oldAmounts=totals(oldDay.employees.find(value=>value.employeeId===employeeId)), newAmounts=totals(day.employees.find(value=>value.employeeId===employeeId));
        assert.deepEqual(dayDelta.baseline,oldAmounts); assert.deepEqual(dayDelta.current,newAmounts);
        for (const key of Object.keys(oldAmounts)) assert.equal(dayDelta.delta[key],newAmounts[key]-oldAmounts[key]);
      }
    }
    const pureAssessment=buildPayrollRefundAwarePaidReviewAssessment({savedEvidence,provenanceSha256:paid.saved.evidence_sha256,
      currentRecognitionEvidence:recognitionEvidence,periodClosure,paidEntries});
    assert.deepEqual(assessment,pureAssessment,'actual paid collector and independent source/proof inputs produce exact pure assessment');
    assert.equal(assessment.summary.potentialReductionReviewCents,paid.expectedAmounts.reduce((a,b)=>a+b,0)-expectedAmounts.reduce((a,b)=>a+b,0));
    assert.equal(assessment.summary.crossEmployeeOffsetApplied,false); assert.equal(assessment.summary.negativeClaimsCreated,false);
    if (stage==='partial' && ['team_fund','progressive_daily','final_month_threshold'].includes(paid.mode))
      assert.ok(assessment.paidReviews.find(row=>row.employeeId===ids.zeroEmployee).potentialReductionReviewCents>0,
        'paid colleague delta is reviewed even though only the other employee merchandise was returned');
    await db.query('ROLLBACK');
  } catch(error) { await db.query('ROLLBACK').catch(()=>{}); throw error; }
  finally { try { if(release) await release(); } finally { db.release(); } }
  assert.deepEqual(await monetarySnapshot(pool,ids.venue),paid.settled);
  assert.deepEqual((await pool.query('SELECT evidence_payload,evidence_sha256 FROM payroll_run_provenance WHERE venue_id=$1 AND run_id=$2',
    [ids.venue,paid.run.runId])).rows[0],paid.saved);
  // Idempotency receipts remain authoritative after later returns make the
  // original source stale. Repeating payment still cannot create an expense.
  for (const {entryId,command} of paid.payCommands) assert.equal((await service.transitionCalculationEntry(owner,entryId,command)).replayed,true);
  assert.deepEqual(await monetarySnapshot(pool,ids.venue),paid.settled);
  return {status:'passed',mode:paid.mode,stage,paidEntryCount:2};
}
