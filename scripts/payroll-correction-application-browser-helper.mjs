import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { insertCorrectionTargetPartialRefund } from './payroll-correction-target-source-fixture.mjs';
const require = createRequire(import.meta.url);
const { makeService } = require('../payroll-scheme-service');
const { beginPayrollSourceProducerTransaction } = require('../payroll-source-fence');

const select = async (page, selector, value) => {
  const input=page.locator(selector), wrapper=input.locator('..'), trigger=wrapper.locator('.custom-select-trigger');
  if(await trigger.count()){await trigger.click();await wrapper.locator(`[data-value="${value}"]`).click();}
  else await input.selectOption(value);
};

// Real source/calculator/proof/storage; no financial or source seams.
export async function verifyCorrectionApplication({page,pool,base,headers,ids,lifecycle,openSaved,correctionTarget}) {
  const actor={venueId:ids.venue,userId:ids.owner},service=makeService(pool);
  const previewUrl=`${base}/api/payroll/reviewed-corrections/preview`,writeUrl=`${base}/api/payroll/reviewed-corrections`;
  const makeTarget=async key=>{
    const run=await service.createVerifiedRun(actor,{schemeVersionId:correctionTarget.versionId,
      periodFrom:correctionTarget.nextPeriod.from,periodTo:correctionTarget.nextPeriod.to,idempotencyKey:`target-run-${key}`});
    assert.equal(run.status,'ready',JSON.stringify(run));assert.equal(run.amountCents,500);
    const made=await service.materializeCalculationEntry(actor,run.runId,{employeeId:ids.employee,financeCategoryId:null,idempotencyKey:`target-entry-${key}`});
    return {runId:run.runId,id:made.currentEntry.id};
  };
  const applied=[];
  let target;
  for(const phase of ['cancel','settle']){
    target=await makeTarget(phase);
    await openSaved();await page.locator(`[data-saved-run-open="${lifecycle.runId}"]`).click();
    await page.locator(`[data-correction-original] option[value="${lifecycle.entryId}"]`).waitFor({state:'attached'});
    await select(page,'[data-correction-original]',lifecycle.entryId);
    await page.locator(`[data-correction-target] option[value="${target.id}"]`).waitFor({state:'attached'});
    assert.equal(await page.locator('[data-correction-target]').inputValue(),'','target selection is explicit');
    await select(page,'[data-correction-target]',target.id);
    const previewPromise=page.waitForResponse(r=>r.url()===previewUrl);
    await page.locator('[data-correction-preview]').click();
    const previewResponse=await previewPromise;assert.equal(previewResponse.status(),200,await previewResponse.text());
    const plan=await previewResponse.json();
    assert.equal(plan.applyCents,500);assert.equal(plan.targetBeforeCents,500);assert.equal(plan.targetAfterCents,0);
    assert.equal(plan.residualReviewCents,500);assert.equal(plan.protectedFixedCents,0);
    if(phase==='cancel'){
      const snapshot=async()=>(await pool.query(`SELECT
        (SELECT count(*)::int FROM payroll_correction_claims WHERE venue_id=$1) claims,
        (SELECT count(*)::int FROM payroll_correction_batches WHERE venue_id=$1) batches,
        (SELECT count(*)::int FROM payroll_correction_events WHERE venue_id=$1) events,
        (SELECT count(*)::int FROM payroll_correction_requests WHERE venue_id=$1) requests,
        (SELECT amount::text FROM payroll_entries WHERE id=$2 AND venue_id=$1) amount`,[ids.venue,target.id])).rows[0];
      const before=await snapshot();
      for(const prefix of ['INSERT INTO payroll_correction_claims','INSERT INTO payroll_correction_batches',
        'INSERT INTO payroll_correction_events','UPDATE payroll_entries SET amount=','INSERT INTO payroll_correction_requests']){
        let injected=false;
        const faulty=makeService({query:(...args)=>pool.query(...args),connect:async()=>{
          const client=await pool.connect();return {query:async(sql,values)=>{
            const result=await client.query(sql,values);
            if(!injected&&String(sql).startsWith(prefix)){injected=true;await client.query('SELECT 1/0');}return result;
          },release:error=>client.release(error)};
        }});
        let failure;
        await assert.rejects(faulty.applyReviewedCorrection(actor,{operation:'apply',originalEntryId:lifecycle.entryId,targetEntryId:target.id,
          expectedPlanHash:plan.planHash,reason:'Injected rollback proof',idempotencyKey:'apply-fault-before-commit'}), error => {
          const payrollTag=String(error.message).match(/payroll_[a-z0-9_]+/i)?.[0] || 'non_payroll_sql_error';
          failure=`SQLSTATE ${error.code || 'unknown'} (${payrollTag})`;
          return true;
        });
        assert.equal(injected,true,`${prefix}: ${failure || 'injected failure not reached'}`);assert.deepEqual(await snapshot(),before,prefix);
      }
    }
    await page.locator('[data-correction-reason]').fill(`Explicit target ${phase}`);
    let command,receipt;
    await page.route(writeUrl,async route=>{
      command=route.request().postDataJSON();const response=await route.fetch();
      assert.equal(response.status(),201,await response.text());receipt=await response.json();await route.abort('failed');
    },{times:1});
    await page.locator('[data-correction-commit]').click();
    await page.locator('[data-saved-run-status]').filter({hasText:'Результат запроса не подтверждён'}).waitFor();
    assert.ok(receipt?.batchId);
    await openSaved();
    const retryPromise=page.waitForResponse(r=>r.url()===writeUrl);
    await page.locator(`[data-correction-retry="${lifecycle.entryId}"]`).click();
    const retry=await retryPromise;assert.equal(retry.status(),200,await retry.text());
    assert.deepEqual(retry.request().postDataJSON(),command);assert.equal((await retry.json()).batchId,receipt.batchId);
    await page.locator('[data-saved-run-status]').filter({hasText:'Текущая сумма: 0,00'}).waitFor();
    const actual=(await pool.query('SELECT status,amount::text,expense_id FROM payroll_entries WHERE venue_id=$1 AND id=$2',[ids.venue,target.id])).rows[0];
    assert.deepEqual(actual,{status:'draft',amount:'0.00',expense_id:null});
    applied.push({command,receipt,target:{...target}});
    if(phase==='cancel'){
      const state=await service.getCalculationEntryState(actor,target.id);
      await service.transitionCalculationEntry(actor,target.id,{action:'cancel',expectedStateHash:state.stateHash,
        idempotencyKey:'cancel-correction-target',paymentDate:null,paymentMethod:null,paymentAccountId:null,reason:'Release exact target allocation'});
      const historical=await service.applyReviewedCorrection(actor,command);
      assert.equal(historical.batchId,receipt.batchId);assert.equal(historical.replayed,true);
      const context=await service.getReviewedCorrectionContext(actor,lifecycle.entryId);
      assert.equal(context.remainingCents,1000);
      assert.deepEqual(context.history.map(e=>e.kind),['apply','release']);
      assert.equal((await pool.query('SELECT amount::text FROM payroll_entries WHERE id=$1',[target.id])).rows[0].amount,'0.00');
    }
  }
  let state=await service.getCalculationEntryState(actor,target.id);
  assert.equal(state.entry.grossCents,500);assert.equal(state.entry.amountCents,0);
  await service.transitionCalculationEntry(actor,target.id,{action:'approve',expectedStateHash:state.stateHash,
    idempotencyKey:'approve-fully-corrected-target',paymentDate:null,paymentMethod:null,paymentAccountId:null,reason:null});
  state=await service.getCalculationEntryState(actor,target.id);
  const paid=await service.transitionCalculationEntry(actor,target.id,{action:'pay',expectedStateHash:state.stateHash,
    idempotencyKey:'settle-fully-corrected-target',paymentDate:correctionTarget.nextPeriod.to,paymentMethod:null,paymentAccountId:null,reason:null});
  assert.equal(paid.entry.status,'paid');assert.equal(paid.entry.expenseId,null);assert.equal(paid.entry.amountCents,0);
  assert.equal((await pool.query('SELECT count(*)::int n FROM expenses WHERE venue_id=$1',[ids.venue])).rows[0].n,1);
  const before=await service.getReviewedCorrectionContext(actor,target.id);
  assert.equal(before.original.settlement.incomingCorrectionCents,500);assert.equal(before.remainingCents,0);
  console.log('PASS actual correction UI→API→DB→reload: explicit target, partial500/residual500, lost responses, cancel/release/exact replay, approve and zero settlement without extra expense');
  return {target,applied};
}

export async function verifyZeroSourceOwnReturn({pool,ids,correctionTarget,settledTarget}) {
  const db=await pool.connect();
  try{
    await beginPayrollSourceProducerTransaction(db,ids.venue);
    const shift=(await db.query('SELECT id FROM shifts WHERE venue_id=$1 AND closed_at IS NULL ORDER BY opened_at,id LIMIT 1',[ids.venue])).rows[0];
    await insertCorrectionTargetPartialRefund(db,{ids,target:correctionTarget,shiftId:shift.id});
    await db.query('COMMIT');
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
  const service=makeService(pool),actor={venueId:ids.venue,userId:ids.owner};
  const context=await service.getReviewedCorrectionContext(actor,settledTarget.id);
  assert.equal(context.original.netCents,0);assert.equal(context.original.grossCents,500);
  assert.equal(context.original.expense,null);assert.equal(context.original.settlement.incomingCorrectionCents,500);
  assert.equal(context.remainingCents,100,'own twenty-ruble return at5% creates100cents, incoming500 is not repeated');
  const plan=await service.previewReviewedCorrection(actor,{operation:'waive',originalEntryId:settledTarget.id,targetEntryId:null});
  assert.equal(plan.policyVersion,'owner-reviewed-variable-correction-v2');assert.equal(plan.waiveCents,100);
  const command={operation:'waive',originalEntryId:settledTarget.id,targetEntryId:null,expectedPlanHash:plan.planHash,
    reason:'Own return only after zero settlement',idempotencyKey:'zero-settled-own-return'};
  const receipt=await service.applyReviewedCorrection(actor,command);
  assert.equal(receipt.totalCents,100);assert.equal((await service.applyReviewedCorrection(actor,command)).batchId,receipt.batchId);
  const claim=(await pool.query('SELECT original_expense_id,original_settlement_transition_id FROM payroll_correction_claims WHERE venue_id=$1 AND original_entry_id=$2',[ids.venue,settledTarget.id])).rows;
  assert.equal(claim.length,1);assert.equal(claim[0].original_expense_id,null);
  assert.equal(claim[0].original_settlement_transition_id,context.original.settlement.transitionId);
  assert.equal((await pool.query('SELECT count(*)::int n FROM expenses WHERE venue_id=$1',[ids.venue])).rows[0].n,1);
  console.log('PASS actual zero-paid source→own return→v2 correction: incoming500 retained, own100 only, immutable settlement/no fabricated expense');
}
