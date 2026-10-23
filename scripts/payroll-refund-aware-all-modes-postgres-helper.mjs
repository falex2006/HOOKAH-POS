import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { seedUnpaidSupersessionFixture } from './payroll-unpaid-supersession-fixture.mjs';
import { payrollRefundAwareModes, makePayrollRefundAwareFixture } from './payroll-refund-aware-calculation-contract.mjs';
import { settleAllModeOriginal, verifyAllModePaidAssessment } from './payroll-refund-aware-all-modes-paid-helper.mjs';
import { createRefundAwareComparisonProbe } from './payroll-refund-aware-comparison-postgres-helper.mjs';
const require = createRequire(import.meta.url);
const { beginPayrollSourceProducerTransaction } = require('../payroll-source-fence');
const { rebuildPayrollRefundAwareRunProvenance } = require('../payroll-refund-aware-provenance');
const CAPABILITY = 'employee_attributed_remaining_net_refund_v2';

// No standalone runner, server, connection URL or trigger bypass. Parent owns
// the disposable database. These are real-source initial calculations and
// persisted replays, followed by real settlements and read-only paid reviews.
export async function verifyRefundAwareAllModesSources({ pool, target, sourcePolicies, period: requestedPeriod } = {}) {
  const results = [];
  for (const mode of payrollRefundAwareModes) results.push(await verifyModeSources({pool,target,sourcePolicies,period:requestedPeriod,mode}));
  return {status:'passed',scope:'actual_source_saved_replay_and_paid_whole_period_assessment',modes:payrollRefundAwareModes,
    stages:['initial','partial','full'],runCount:results.reduce((sum,row)=>sum+row.runCount,0),
    paidEntryCount:results.length*2,paidAssessmentCoverage:true,correctionApplicationCoverage:false,
    comparisonOutputCount:results.reduce((sum,row)=>sum+(row.comparison?.outputs||0),0),
    costCase:'actual_non_stock_known_zero',results};
}

async function verifyModeSources({ pool, target, sourcePolicies, period: requestedPeriod, mode: selectedMode }) {
  const context = (await pool.query(`SELECT current_database() AS name,
    (date_trunc('month',pg_catalog.transaction_timestamp() AT TIME ZONE 'UTC')-interval '1 month')::date::text AS previous_from,
    (date_trunc('month',pg_catalog.transaction_timestamp() AT TIME ZONE 'UTC')-interval '1 day')::date::text AS previous_to,
    (pg_catalog.transaction_timestamp() AT TIME ZONE 'UTC')::date::text AS today`)).rows[0];
  assert.match(context.name,/^orders_qa_[a-f0-9]{16}$/);
  assert.equal(context.name,process.env.LOCAL_FULL_PG_OWNED_DATABASE);
  const period = requestedPeriod || {from:context.previous_from,to:context.previous_to};
  assert.match(period.from,/^\d{4}-\d{2}-01$/);
  const monthEnd = new Date(Date.UTC(Number(period.from.slice(0,4)),Number(period.from.slice(5,7)),0)).toISOString().slice(0,10);
  assert.equal(period.to,monthEnd,'all seven modes require a complete month fixture');
  assert.ok(period.to < context.today,'the real UTC clock must have closed the entire month');
  const fixture = await seedUnpaidSupersessionFixture({pool,period,sourcePolicies,
    withCostEvidence:true,withSecondPositiveSale:true});
  const {ids,owner,service} = fixture;
  const employees = [ids.employee,ids.zeroEmployee];
  const source = await pool.connect();
  try {
    await beginPayrollSourceProducerTransaction(source,ids.venue);
    for (const employeeId of employees) {
      await source.query(`INSERT INTO staff_schedules(venue_id,user_id,work_date,planned_start,planned_end,created_by)
        VALUES($1,$2,$3::date,($3::date::text||'T09:00:00Z')::timestamptz,($3::date::text||'T17:00:00Z')::timestamptz,$4)`,
      [ids.venue,employeeId,period.from,ids.owner]);
      await source.query(`INSERT INTO staff_work_logs(venue_id,user_id,started_at,ended_at,source)
        VALUES($1,$2,($3::date::text||'T09:00:00Z')::timestamptz,($3::date::text||'T17:00:00Z')::timestamptz,'manual')`,
      [ids.venue,employeeId,period.from]);
    }
    await source.query('COMMIT');
  } catch(error) { await source.query('ROLLBACK').catch(()=>{}); throw error; }
  finally { source.release(); }
  const attendancePeriod = {periodFrom:period.from,periodTo:period.to};
  const attendance = await service.readAttendanceCoverage(owner,attendancePeriod);
  assert.equal(attendance.complete,true,JSON.stringify(attendance.reasons));
  await service.approveAttendanceCoverage(owner,{...attendancePeriod,sourceWatermark:attendance.sourceWatermark,
    reason:'Owner approves actual all-mode source fixture attendance',idempotencyKey:'all-modes-attendance'});
  await service.writeProductDepartmentRevision(owner,{expectedRevisionId:null,idempotencyKey:'all-modes-department',
    reason:'Owner confirms historical department for seven-mode comparison',effectiveFrom:period.from,
    retroactiveReason:'Actual fixture products belonged to bar during the entire closed month',
    ownerAttestation:{confirmed:true,action:'retroactive_payroll_product_department_mapping'},
    mappings:[{productId:ids.product,productName:'Historical tea',departmentCode:'bar',departmentName:'Бар',
      effectiveFrom:period.from,effectiveTo:period.to}]},true);

  const cost = (await pool.query('SELECT payload,watermark FROM pos_sale_cost_evidence WHERE venue_id=$1 AND order_id=$2',
    [ids.venue,ids.order])).rows[0];
  assert.equal(cost.payload.status,'complete'); assert.equal(cost.payload.totalCostMinor,0);
  assert.equal(cost.payload.scope,'sale_depletion_cost');
  assert.equal(cost.payload.valuationMethod,'ingredient_cost_at_depletion_v1');
  assert.equal(cost.payload.capture.status,'captured'); assert.equal(cost.payload.capture.lines.length,2);
  assert.ok(cost.payload.capture.lines.every(line=>line.inventoryMode==='non_stock'));
  assert.deepEqual(cost.payload.capture.components,[]); assert.deepEqual(cost.payload.capture.movements,[]);
  const frozenCost = JSON.stringify(cost);
  const financialState = async () => (await pool.query(`SELECT
    (SELECT count(*)::int FROM payroll_entries WHERE venue_id=$1) AS entries,
    (SELECT count(*)::int FROM expenses WHERE venue_id=$1) AS expenses,
    (SELECT count(*)::int FROM payroll_correction_events WHERE venue_id=$1) AS corrections,
    (SELECT count(*)::int FROM payroll_calculation_entry_transitions WHERE venue_id=$1) AS transitions`,[ids.venue])).rows[0];
  let beforeMoney = await financialState();
  assert.deepEqual(beforeMoney,{entries:0,expenses:0,corrections:0,transitions:0});
  const versions = new Map();
  const compareHere = selectedMode === payrollRefundAwareModes[0];
  const comparisonVersions = new Map();
  for (const mode of compareHere ? payrollRefundAwareModes : [selectedMode]) {
    // Reuse only ordinary configuration from the pure suite. Every source atom,
    // approval, economic input, typed snapshot and provenance comes from DB.
    const params = structuredClone(makePayrollRefundAwareFixture(mode).scheme.roleParameters.bar);
    params.bracketRatesBps = {0:1000,18000:2000};
    const version = (await service.createScheme(owner,{name:`Actual source ${mode}`,
      payoutRiskAcknowledgement:{confirmed:true,policyCode:'payroll-own-revenue-ceiling-v1'},
      definition:{mode,currency:'RUB',effectiveFrom:period.from,effectiveTo:period.to,applyMilestones:false,
        roleParameters:{bar:params},roleAssignments:employees.map(employeeId=>({employeeId,roleId:'bar',
          effectiveFrom:period.from,effectiveTo:period.to})),employeeOverrides:[],itemRules:[],sourcePolicies}})).versions[0];
    await service.activateVersion(owner,version.versionId);
    if (mode === selectedMode) versions.set(mode,version.versionId);
    comparisonVersions.set(mode,version.versionId);
  }
  let legacyComparisonVersionId = null;
  const legacyComparisonVersions = new Map();
  if (compareHere) {
    const legacyPolicies = structuredClone(sourcePolicies);
    delete legacyPolicies.earnings; legacyPolicies.schemaVersion = 1;
    for (const mode of ['percent_only','margin_target','team_fund']) {
    const legacyParams = structuredClone(makePayrollRefundAwareFixture(mode).scheme.roleParameters.bar);
    legacyParams.bracketRatesBps = {0:1000,18000:2000};
    const legacyVersion = (await service.createScheme(owner,{name:`Legacy source ${mode} comparison control`,
      payoutRiskAcknowledgement:{confirmed:true,policyCode:'payroll-own-revenue-ceiling-v1'},
      definition:{mode,currency:'RUB',effectiveFrom:period.from,effectiveTo:period.to,applyMilestones:false,
        roleParameters:{bar:legacyParams},roleAssignments:employees.map(employeeId=>({employeeId,roleId:'bar',
          effectiveFrom:period.from,effectiveTo:period.to})),employeeOverrides:[],itemRules:[],sourcePolicies:legacyPolicies}})).versions[0];
    await service.activateVersion(owner,legacyVersion.versionId);
    legacyComparisonVersions.set(mode,legacyVersion.versionId);
    if (mode === 'percent_only') legacyComparisonVersionId = legacyVersion.versionId;
    }
  }
  const runs = [], original = new Map(), initialAmounts = new Map();
  const expectedByMode = (mode,stage) => {
    if (stage==='full') return [0,0];
    if (['progressive_daily','final_month_threshold'].includes(mode)) return stage==='initial'?[2000,2000]:[500,1000];
    if (['stable_percent','percent_only'].includes(mode)) return stage==='initial'?[1000,1000]:[500,1000];
    if (mode==='team_fund') return stage==='initial'?[2425,2425]:[1800,1800];
    return stage==='initial'?[2350,2350]:[1100,2350]; // personal and known-zero-cost margin
  };
  const comparison = compareHere ? await createRefundAwareComparisonProbe({pool,target,fixture,period,
    versions:comparisonVersions,legacyVersionId:legacyComparisonVersionId,legacyVersions:legacyComparisonVersions,expectedByMode}) : null;
  try {
  const verifyStage = async stage => {
    for (const [mode,schemeVersionId] of versions) {
      const expected = expectedByMode(mode,stage);
      const calculation = await service.prepareRefundAwareCalculation(owner,schemeVersionId,attendancePeriod);
      assert.equal(calculation.status,'refund_aware_calculated',`${mode}/${stage}: ${JSON.stringify(calculation.reasons)}`);
      assert.equal(calculation.amountCents,expected[0]+expected[1],`${mode}/${stage} total`);
      const actual = employees.map(employeeId=>calculation.engineResult.employees.find(row=>row.employeeId===employeeId)?.amountCents);
      assert.deepEqual(actual,expected,`${mode}/${stage} employee amounts`);
      assert.equal(calculation.input.sales.length,2);
      assert.deepEqual(employees.map(employeeId=>calculation.input.sales.find(row=>row.employeeId===employeeId).turnoverCents),
        stage==='initial'?[10000,10000]:stage==='partial'?[5000,10000]:[0,0]);
      if (mode==='margin_target') {
        assert.ok(calculation.input.sales.every(line=>line.costSnapshot.costCents===0));
        assert.ok(calculation.input.sales.every(line=>line.costSnapshot.version===cost.watermark));
      }
      if (stage==='initial') initialAmounts.set(mode,actual);
      if (stage==='partial' && ['team_fund','progressive_daily','final_month_threshold'].includes(mode))
        assert.ok(actual[1]<initialAmounts.get(mode)[1],'unchanged colleague sale is recalculated after the first employee return');
      const request = {schemeVersionId,...attendancePeriod,idempotencyKey:`all-modes-${mode}-${stage}`};
      const run = await service.createRefundAwareRun(owner,request);
      assert.equal(run.status,'ready',`${mode}/${stage}: ${JSON.stringify(run.reasons)}`);
      assert.equal(run.amountCents,expected[0]+expected[1]); assert.equal(run.capabilityVersion,CAPABILITY);
      assert.equal(run.replayed,false);
      const saved = (await pool.query('SELECT evidence_payload,evidence_sha256 FROM payroll_run_provenance WHERE venue_id=$1 AND run_id=$2',
        [ids.venue,run.runId])).rows[0];
      const evidence = JSON.parse(saved.evidence_payload);
      assert.equal(evidence.schemaVersion,2); assert.equal(evidence.capabilityVersion,CAPABILITY);
      const rebuilt = rebuildPayrollRefundAwareRunProvenance(evidence);
      assert.equal(rebuilt.provenance.evidence_sha256,saved.evidence_sha256);
      assert.equal(rebuilt.provenance.total_amount_cents,run.amountCents);
      assert.equal(rebuilt.prepared.snapshotInput.sourceLines.length,2);
      assert.ok(rebuilt.prepared.snapshotInput.sourceLines.every(line=>line.quantity==='1.000'),
        'original quantity stays frozen while refund value changes');
      assert.deepEqual(rebuilt.prepared.snapshotInput.sourceLines.map(line=>line.refundCents).sort((a,b)=>a-b),
        stage==='initial'?[0,0]:stage==='partial'?[0,5000]:[10000,10000]);
      const repeated = await service.createRefundAwareRun(owner,request);
      assert.equal(repeated.runId,run.runId); assert.equal(repeated.replayed,true);
      assert.equal((await service.replaySavedRun(owner,run.runId)).verification.status,'matched');
      assert.equal((await service.getSavedRun(owner,run.runId)).amountCents,run.amountCents);
      assert.equal((await service.checkSavedRunFreshness(owner,run.runId)).status,'current');
      if (stage==='initial') original.set(mode,{run,request,saved});
      runs.push({mode,stage,runId:run.runId,amountCents:run.amountCents});
    }
    assert.deepEqual(await financialState(),beforeMoney,'initial calculation never posts entries, expenses or corrections');
    assert.equal(JSON.stringify((await pool.query('SELECT payload,watermark FROM pos_sale_cost_evidence WHERE venue_id=$1 AND order_id=$2',
      [ids.venue,ids.order])).rows[0]),frozenCost,'returns never rewrite original depletion evidence');
  };
  await verifyStage('initial');
  if (comparison) await comparison.verifyStage('initial');
  const originalRun = original.get(selectedMode);
  const paid = await settleAllModeOriginal({pool,fixture,run:originalRun.run,mode:selectedMode,
    expectedAmounts:expectedByMode(selectedMode,'initial')});
  beforeMoney = await financialState();
  assert.deepEqual(beforeMoney,{entries:2,expenses:2,corrections:0,transitions:4});
  await verifyAllModePaidAssessment({pool,fixture,paid,expectedAmounts:expectedByMode(selectedMode,'initial'),stage:'initial'});
  await fixture.refund('0.5','all-modes-first-half-return');
  await verifyStage('partial');
  if (comparison) await comparison.verifyStage('partial');
  await verifyAllModePaidAssessment({pool,fixture,paid,expectedAmounts:expectedByMode(selectedMode,'partial'),stage:'partial'});
  await fixture.refund('0.5','all-modes-first-rest-return');
  const refundClient = await pool.connect();
  try {
    await beginPayrollSourceProducerTransaction(refundClient,ids.venue);
    const shiftId = (await refundClient.query('SELECT id FROM shifts WHERE venue_id=$1 AND closed_at IS NULL FOR UPDATE',[ids.venue])).rows[0].id;
    const refundId = (await refundClient.query(`INSERT INTO order_refunds(venue_id,order_id,shift_id,amount,reason,idempotency_key,actor_id,item_attribution_status)
      VALUES($1,$2,$3,0.50,'All-mode second employee complete return','all-modes-second-full-return',$4,'complete') RETURNING id`,
    [ids.venue,ids.order,shiftId,ids.owner])).rows[0].id;
    await refundClient.query(`INSERT INTO order_refund_tenders(venue_id,refund_id,order_id,source_payment_id,amount,payout_method,finance_account_id,finance_account_name_snapshot)
      VALUES($1,$2,$3,$4,0.50,'card',$5,'Freshness QA bank')`,[ids.venue,refundId,ids.order,ids.payment,ids.account]);
    await refundClient.query(`INSERT INTO order_refund_items(venue_id,refund_id,order_id,snapshot_id,order_item_id,returned_quantity,returned_item_value_minor)
      VALUES($1,$2,$3,$4,$5,1,NULL)`,[ids.venue,refundId,ids.order,ids.pricing,ids.zeroItem]);
    await refundClient.query('COMMIT');
  } catch(error) { await refundClient.query('ROLLBACK').catch(()=>{}); throw error; }
  finally { refundClient.release(); }
  await verifyStage('full');
  if (comparison) await comparison.verifyStage('full');
  await verifyAllModePaidAssessment({pool,fixture,paid,expectedAmounts:expectedByMode(selectedMode,'full'),stage:'full'});
  for (const [mode,{run,request,saved}] of original) {
    assert.deepEqual((await pool.query('SELECT evidence_payload,evidence_sha256 FROM payroll_run_provenance WHERE venue_id=$1 AND run_id=$2',
      [ids.venue,run.runId])).rows[0],saved,`${mode}: historical provenance remains byte exact`);
    const retry = await service.createRefundAwareRun(owner,request);
    assert.equal(retry.runId,run.runId); assert.equal(retry.amountCents,run.amountCents); assert.equal(retry.replayed,true);
    assert.equal((await service.replaySavedRun(owner,run.runId)).verification.status,'matched');
    assert.equal((await service.checkSavedRunFreshness(owner,run.runId)).status,'stale');
  }
  assert.deepEqual(await financialState(),beforeMoney);
  return {status:'passed',scope:'actual_source_initial_calculation_and_paid_assessment',mode:selectedMode,
    stages:['initial','partial','full'],runCount:runs.length,runs,venueId:ids.venue,
    comparison: comparison ? comparison.summary() : null,
    costCase:'actual_non_stock_known_zero',paidAssessmentCoverage:true,correctionApplicationCoverage:false};
  } finally { if (comparison) await comparison.close(); }
}
