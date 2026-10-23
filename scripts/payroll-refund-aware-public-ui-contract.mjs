import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {makeRefundAwareCorrectionPolicyFixture} from './payroll-refund-aware-correction-policy-contract.mjs';
import {payrollRefundAwareModes} from './payroll-refund-aware-calculation-contract.mjs';
const require=createRequire(import.meta.url);
const {buildRefundAwareCorrectionPlan:apply,buildRefundAwareCorrectionWaiverPlan:waive}=require('../payroll-refund-aware-correction-policy');
const {buildReviewedCorrectionPlan:legacyApply}=require('../payroll-reviewed-correction-policy');
const ui=readFileSync(new URL('../payroll-scheme-ui.js',import.meta.url),'utf8');
const extract=(start,end,from=0)=>{const a=ui.indexOf(start,from),b=ui.indexOf(end,a+start.length);assert.ok(a>=0&&b>a);return ui.slice(a,b);};
const create=vm.runInNewContext(extract('  const createReviewedCorrectionController =','  // End economic correction controller.')+';createReviewedCorrectionController');
const creationEndpoint=vm.runInNewContext(extract('  const savedRunCreationEndpoint =','  const createReviewedCorrectionController =')+';savedRunCreationEndpoint');
const id=n=>`dddddddd-dddd-4ddd-8ddd-${String(n).padStart(12,'0')}`,clone=v=>JSON.parse(JSON.stringify(v));
const policy='reviewed_period_variable_pay_only_v1';
const fixture=(mode='percent_only',incoming=0)=>{
  const input=makeRefundAwareCorrectionPolicyFixture(mode,incoming),plan=apply(input),waiver=waive({...input,target:null});
  const original=input.original,target=input.target,saved=new Map(),calls=[];let identity=`${id(90)}:${original.venueId}`,key=0;
  const context={schemaVersion:3,policyCode:policy,original,requiresExplicitTarget:true,officialReady:false,payoutEligible:false,
    remainingCents:waiver.waiveCents,currentPotentialCents:waiver.currentPotentialCents,highWaterAssessedCents:waiver.highWaterAssessedCents,
    positiveEntitlementInformationCents:waiver.positiveEntitlementInformationCents,positiveEntitlementAction:'none',
    assessmentHash:plan.assessmentHash,sourceHash:plan.sourceHash,ledgerHash:plan.ledgerHash,history:[],
    targets:[{id:target.id,runId:target.runId,periodFrom:target.periodFrom,periodTo:target.periodTo,grossCents:target.grossCents,
      amountCents:target.netCents,status:'draft',requiresFreshPreview:true,employeeName:'Employee',schemeName:'Scheme'}]};
  const receipt=(p=plan)=>({schemaVersion:3,policyCode:policy,batchId:id(91),operation:p.operation,planHash:p.planHash,
    targetEntryId:p.targetEntryId,totalCents:p.operation==='apply'?p.applyCents:p.waiveCents,
    targetAfterCents:p.operation==='apply'?p.targetAfterCents:null,residualReviewCents:p.operation==='apply'?p.residualReviewCents:0,
    officialReady:false,payoutEligible:false,replayed:false});
  const storage={getItem:k=>saved.get(k)??null,setItem:(k,v)=>saved.set(k,v),removeItem:k=>saved.delete(k),
    get length(){return saved.size;},key:n=>[...saved.keys()][n]};
  const f={input,original,target,plan,waiver,context,receipt,saved,calls,storage,setIdentity:v=>{identity=v;},
    request:async(path,options)=>options?.method==='POST'?(path.endsWith('/preview')?plan:receipt()):context};
  f.create=()=>create({request:async(...args)=>{calls.push(args);return f.request(...args);},storage:()=>storage,identity:()=>identity,makeKey:()=>`public-v2-key-${++key}`});
  f.api=f.create();return f;
};
for(const mode of payrollRefundAwareModes){
  const f=fixture(mode),intent={operation:'apply',originalEntryId:f.original.id,targetEntryId:f.target.id};
  assert.equal(f.api.planValid(f.plan,intent),true,mode);
  await f.api.context(f.original.id,'period_v2');assert.equal(f.calls.at(-1)[0],`/api/payroll/calculation-entries/${f.original.id}/refund-aware-corrections`);
  await f.api.preview(intent,'period_v2');assert.equal(f.calls.at(-1)[0],'/api/payroll/refund-aware-corrections/preview');
  assert.deepEqual(JSON.parse(f.calls.at(-1)[1].body),intent);
  f.api.begin(f.plan,'apply','Owner reviewed whole period');await f.api.retry(f.original.id);
  assert.equal(f.calls.at(-1)[0],'/api/payroll/refund-aware-corrections');assert.equal(f.saved.size,0);
  assert.equal(f.api.planValid(f.waiver,{...intent,operation:'waive',targetEntryId:null}),true);
  f.api.begin(f.waiver,'waive','Owner waives the balance');f.request=async()=>f.receipt(f.waiver);await f.api.retry(f.original.id);
}
{
  const f=fixture('percent_only',1000),intent={operation:'apply',originalEntryId:f.original.id,targetEntryId:f.target.id};
  assert.equal(f.plan.originalPaidCents,0);assert.equal(f.plan.currentPotentialCents,0);assert.equal(f.api.planValid(f.plan,intent),true);
  assert.throws(()=>f.api.begin(f.plan,'apply','No new debt allowed'),/nothing_to_dispose/);assert.equal(f.calls.length,0);
}
for(const change of [p=>p.policyCode='unknown',p=>p.schemaVersion=2,p=>p.basisKind='line',p=>p.currentPotentialCents++,
  p=>p.availableReviewCents++,p=>p.alreadyDisposedCents=1,p=>p.highWaterAssessedCents=0,p=>p.firstAssessedCents=999999999999,
  p=>p.positiveEntitlementAction='pay',p=>p.positiveEntitlementInformationCents=null,p=>p.claimHistoryWatermark='bad',
  p=>p.sourceAttested=true,p=>p.deltaApplicationEligible=true,p=>p.financialAction='apply',p=>p.payoutEligible=true,
  p=>p.allocations[0].refundLineEventId=id(1),p=>p.allocations[0].sourceSnapshotLineId=null,p=>p.allocations[0].claimId=id(1),
  p=>p.allocations[0].assessedCents++,p=>p.allocations[0].highWaterAssessedCents++,p=>p.allocations.push(p.allocations[0]),
  p=>p.allocations[0]=null,p=>p.applyCents++,p=>p.targetAfterCents=0,p=>p.availableVariableCents++,p=>p.targetRunId=p.originalRunId,
  p=>p.originalExpenseId=null,p=>p.originalPaidCents=0,p=>p.claimId='bad',p=>p.currentPotentialCents=1000000000000]){
  const f=fixture(),bad=clone(f.plan),intent={operation:'apply',originalEntryId:f.original.id,targetEntryId:f.target.id};change(bad);
  assert.equal(f.api.planValid(bad,intent),false);f.request=async()=>bad;
  await assert.rejects(f.api.preview(intent,'period_v2'),/response_invalid/);
}
for(const change of [p=>p.schemaVersion=1,p=>p.policyCode='unknown',p=>p.currentPotentialCents=-1,p=>p.remainingCents=1001,
  p=>p.highWaterAssessedCents=1000000000000,p=>p.positiveEntitlementAction='pay',p=>p.officialReady=true,
  p=>p.history=[{id:id(11),originalEntryId:p.original.id,employeeId:p.original.employeeId,kind:'apply',amountCents:1,
    sourceKind:'period_v2',refundLineEventId:id(12),cohortClaimId:id(13),cohortAssessmentId:id(14)}]]){
  const f=fixture(),bad=clone(f.context);change(bad);f.request=async()=>bad;
  await assert.rejects(f.api.context(f.original.id,'period_v2'),/response_invalid/);
}
{
  const f=fixture();f.api.begin(f.plan,'apply','Exact original request');
  const raw=[...f.saved.values()][0];f.request=async()=>{throw new Error('lost response');};
  await assert.rejects(f.api.retry(f.original.id),e=>e.correctionAttemptRetained===true);
  const first=f.calls.at(-1),reloaded=f.create();assert.equal(reloaded.listPending().length,1);
  f.request=async()=>({...f.receipt(),replayed:true});await reloaded.retry(f.original.id);
  assert.deepEqual(f.calls.at(-1),first,'v2 endpoint/body stay bound to persisted schema3 after reload');
  assert.deepEqual(Object.keys(JSON.parse(raw)),['command','plan'],'same pending representation, no mutable endpoint field');
}
{
  const f=fixture(),legacy=legacyApply({...f.input,assessment:{venueId:f.original.venueId,runId:f.original.runId,
    provenanceSha256:f.original.provenanceSha256,coverage:'complete',assessmentHash:'a'.repeat(64),sourceHash:'b'.repeat(64),
    lines:[{employeeId:f.original.employeeId,refundLineEventId:id(30),sourceSnapshotLineId:id(31),salaryImpactCents:-200,reasons:[]}]}});
  const intent={operation:'apply',originalEntryId:f.original.id,targetEntryId:f.target.id};
  f.request=async()=>legacy;await assert.rejects(f.api.preview(intent,'period_v2'),/response_invalid/);
  f.request=async()=>f.plan;await assert.rejects(f.api.preview(intent),/response_invalid/);
  f.api.begin(legacy,'apply','Legacy reason');const command={...intent,expectedPlanHash:legacy.planHash,reason:'Legacy reason',idempotencyKey:'public-v2-key-1'};
  assert.equal([...f.saved.values()][0],JSON.stringify({command,plan:legacy}),'legacy saved bytes unchanged');
  const reloaded=f.create();f.request=async()=>({...f.receipt({...legacy,operation:'apply'}),schemaVersion:1});
  await reloaded.retry(f.original.id);assert.equal(f.calls.at(-1)[0],'/api/payroll/reviewed-corrections');
  assert.equal(f.calls.at(-1)[1].body,JSON.stringify(command));
}
for(const [status,error,retained] of [[409,'payroll_refund_correction_plan_stale',false],
  [409,'payroll_refund_correction_current_potential_below_dispositions',false],
  [409,'payroll_refund_correction_idempotency_conflict',true],[409,'payroll_refund_correction_request_integrity_invalid',true],
  [503,'payroll_refund_correction_unavailable',true],[403,'payroll_scheme_owner_only',true]]){
  const f=fixture();f.api.begin(f.plan,'apply','Owner reason');f.request=async()=>{throw Object.assign(new Error(error),{status,data:{error}});};
  await assert.rejects(f.api.retry(f.original.id),e=>e.correctionAttemptRetained===retained);assert.equal(f.saved.size,retained?1:0);
}
for(const patch of [{schemaVersion:1},{policyCode:'unknown'},{officialReady:true},{payoutEligible:true},{totalCents:999},{targetAfterCents:0}]){
  const f=fixture();f.api.begin(f.plan,'apply','Owner reason');f.request=async()=>({...f.receipt(),...patch});
  await assert.rejects(f.api.retry(f.original.id),e=>e.correctionAttemptRetained===true);assert.equal(f.saved.size,1);
}
const v2Policy={schemaVersion:2,earnings:{refunds:'remaining_merchandise_original_sale_date_v1',
  venueTurnover:'canonical_total_less_merchandise_returns_v1',marginCost:'frozen_sale_depletion_cost_payroll_v1'}};
assert.equal(creationEndpoint({sourcePolicies:v2Policy}),'/api/payroll/refund-aware-calculation-runs');
for(const sourcePolicies of [undefined,{schemaVersion:1}])assert.equal(creationEndpoint({sourcePolicies}),'/api/payroll/calculation-runs');
for(const value of [null,[],{sourcePolicies:null},{sourcePolicies:{schemaVersion:99}},{sourcePolicies:{schemaVersion:2}},
  {sourcePolicies:{...v2Policy,earnings:{...v2Policy.earnings,marginCost:'restore_actual_cogs'}}}])assert.throws(()=>creationEndpoint(value),/source_policy_unsupported/);

// Execute actual submit handler: immutable version determines endpoint and
// endpoint-specific retry key; no extra source payload can enter the command.
const submitSource=extract("    form.addEventListener('submit'","    section.addEventListener('click'",ui.indexOf('  const mountSavedRuns ='));
const creationFixture=(policyVersion=2,saved=new Map())=>{
  let handler;const calls=[],form={elements:[{disabled:false}],addEventListener:(_,fn)=>{handler=fn;}};
  const selected={versionId:id(40),status:'active',...(policyVersion===0?{}:{sourcePolicies:policyVersion===1?{schemaVersion:1}:v2Policy})};
  const f={calls,saved,selected,request:async(path)=>path.startsWith('/api/payroll/versions/')?selected:
    {status:'ready',runId:id(41),persistence:'snapshots',replayed:false,amountCents:1000,
      capabilityVersion:'employee_attributed_remaining_net_refund_v2',officialReady:false,payoutEligible:false}};
  const context=vm.createContext({form,identity:'owner:venue',storagePrefix:'payroll-saved-intent:v1:owner:venue:',
    version:{value:id(40)},from:{value:'2026-09-01'},to:{value:'2026-09-30'},alive:()=>true,saving:false,loaded:true,
    sourceReadinessPeriodValid:()=>true,venueLocalToday:()=> '2026-10-01',status:{textContent:'',innerHTML:''},detailToken:1,
    savedRunCreationEndpoint:creationEndpoint,sessionStorage:{getItem:k=>saved.get(k)??null,setItem:(k,v)=>saved.set(k,v),removeItem:k=>saved.delete(k)},
    crypto:{randomUUID:()=>id(42)},savedRequest:async(...args)=>{calls.push(args);return f.request(...args);},
    loadList:async()=>calls.push(['list']),openRun:async run=>calls.push(['open',run]),errorText:e=>e.message,
    escapeHtml:String,readinessReasonLabel:String});
  vm.runInContext(submitSource,context);f.context=context;f.submit=()=>handler({preventDefault(){}});return f;
};
for(const version of [0,1,2]){
  const f=creationFixture(version);await f.submit();
  assert.equal(f.calls[0][0],`/api/payroll/versions/${id(40)}`);
  assert.equal(f.calls[1][0],version===2?'/api/payroll/refund-aware-calculation-runs':'/api/payroll/calculation-runs');
  assert.deepEqual(JSON.parse(f.calls[1][1].body),{schemeVersionId:id(40),periodFrom:'2026-09-01',periodTo:'2026-09-30',idempotencyKey:id(42)});
  assert.equal(f.saved.size,0);assert.equal(f.context.saving,false);assert.equal(f.context.form.elements[0].disabled,false);
}
for(const version of [1,2]){
  const f=creationFixture(version);f.request=async path=>{if(path.startsWith('/api/payroll/versions/'))return f.selected;throw new Error('lost response');};
  await f.submit();const first=f.calls[1],key=[...f.saved.keys()][0];
  assert.ok(key.startsWith(version===1?'payroll-saved-intent:v1:owner:venue:':'payroll-saved-intent:refund-aware-v2:owner:venue:'));
  const reloaded=creationFixture(version,f.saved);await reloaded.submit();assert.deepEqual(clone(reloaded.calls[1]),clone(first));assert.equal(f.saved.size,0);
}
for(const patch of [{runId:'bad'},{capabilityVersion:'employee_attributed_net_v1'},{amountCents:-1},
  {amountCents:1000000000000},{replayed:null},{officialReady:true},{payoutEligible:true}]) {
  const f=creationFixture(), normal=f.request;
  f.request=async path=>path.startsWith('/api/payroll/versions/')?normal(path):({...await normal(path),...patch});
  await f.submit(); assert.equal(f.saved.size,1,'invalid v2 creation receipt retains exact retry intent');
  assert.equal(f.calls.some(call=>call[0]==='open'),false); assert.match(f.context.status.textContent,/invalid_response/);
}
for(const change of [f=>f.selected.versionId=id(99),f=>f.selected.status='draft',f=>f.selected.sourcePolicies={schemaVersion:99}]){
  const f=creationFixture();change(f);await f.submit();assert.equal(f.calls.length,1,'unverified policy never POSTs');assert.equal(f.saved.size,0);
}
{
  const f=creationFixture();f.context.sessionStorage.setItem=()=>{};await f.submit();assert.equal(f.calls.length,1);assert.match(f.context.status.textContent,/ключ повторного запроса/);
}
{
  const f=creationFixture();let finish;f.request=()=>new Promise(resolve=>{finish=resolve;});const first=f.submit();await f.submit();assert.equal(f.calls.length,1);
  f.context.alive=()=>false;finish(f.selected);await first;assert.equal(f.calls.length,1,'session change during version read blocks creation');
}
assert.match(ui,/data\.schemaVersion===3\?'period_v2':'line_v1'/);
assert.match(ui,/нулевой остаток не превращаются в дополнительный долг/);
assert.match(ui,/Сумма к выплате не опускается ниже защищённой фиксированной части/);
assert.match(ui,/savedRunLegacyReviewAllowed\(runId\)/);
console.log('PASS public refund-aware UI: all7 real period plans, strict schema3/net floor, exact mixed-model pending retry, known policy creation dispatch, preserved legacy bytes, unknown closed; VM only');
