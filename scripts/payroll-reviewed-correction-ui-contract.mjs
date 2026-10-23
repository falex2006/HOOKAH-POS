import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const {buildReviewedCorrectionPlan,buildReviewedCorrectionWaiverPlan}=require('../payroll-reviewed-correction-policy');
const ui=readFileSync(new URL('../payroll-scheme-ui.js',import.meta.url),'utf8');
const extract=(start,end)=>{const a=ui.indexOf(start),b=ui.indexOf(end,a+start.length);assert.ok(a>=0&&b>a);return ui.slice(a,b);};
const create=vm.runInNewContext(extract('  const createReviewedCorrectionController =','  // End economic correction controller.')+'; createReviewedCorrectionController');
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const sha='a'.repeat(64),venueId=id(1),employeeId=id(2),ownerId=id(3);
const base=(n,month)=>({id:id(n),runId:id(n+100),venueId,employeeId,origin:'calculation_run',currency:'RUB',provenanceSha256:sha,
  periodFrom:`2026-${month}-01`,periodTo:`2026-${month}-30`,grossCents:1000,netCents:1000});
const original={...base(4,'09'),status:'paid',expense:{id:id(9),entryId:id(4),venueId,source:'payroll',amountCents:1000}};
const target={...base(5,'10'),status:'draft',protectedFixedCents:700,eligibleVariableCents:300};
const assessment={venueId,runId:original.runId,provenanceSha256:sha,assessmentHash:sha,sourceHash:sha,coverage:'complete',
  lines:[10,11].map(n=>({employeeId,refundLineEventId:id(n),sourceSnapshotLineId:id(n+100),salaryImpactCents:-200,reasons:[]}))};
const plan=buildReviewedCorrectionPlan({original,target,assessment,ledger:[]});
const waiver=buildReviewedCorrectionWaiverPlan({original,assessment,ledger:[]});
const zeroOriginal={...original,netCents:0,expense:null,settlement:{kind:'zero',transitionId:id(90),venueId,entryId:original.id,
  employeeId,runId:original.runId,provenanceSha256:sha,grossCents:1000,netCents:0,protectedFixedCents:0,incomingCorrectionCents:1000,
  paidAt:'2026-10-01T12:00:00Z',paymentDate:'2026-10-01',paidBy:ownerId}};
const incoming={id:id(91),sequenceNo:1,venueId,employeeId,currency:'RUB',originalEntryId:id(92),refundLineEventId:id(93),
  kind:'apply',amountCents:1000,targetEntryId:original.id,reversesEventId:null};
const zeroPlan=buildReviewedCorrectionPlan({original:zeroOriginal,target,assessment,ledger:[incoming]});
const zeroWaiver=buildReviewedCorrectionWaiverPlan({original:zeroOriginal,assessment,ledger:[incoming]});
const preview={operation:'apply',originalEntryId:original.id,targetEntryId:target.id};
const context={schemaVersion:1,original,requiresExplicitTarget:true,remainingCents:400,assessmentHash:sha,sourceHash:sha,ledgerHash:sha,
  targets:[{id:target.id,runId:target.runId,periodFrom:target.periodFrom,periodTo:target.periodTo,employeeName:'<img src=x>',schemeName:'<script>x</script>',
    grossCents:1000,amountCents:1000,status:'draft',requiresFreshPreview:true}],history:[]};
const success=(p=plan,operation='apply')=>({schemaVersion:1,batchId:id(15),operation,planHash:p.planHash,targetEntryId:p.targetEntryId,
  totalCents:operation==='apply'?p.applyCents:p.waiveCents,targetAfterCents:operation==='apply'?p.targetAfterCents:null,
  residualReviewCents:operation==='apply'?p.residualReviewCents:0,replayed:false});
const fixture=()=>{
  const saved=new Map(),calls=[];let identity=`${ownerId}:${venueId}`,counter=0;
  const storage={getItem:key=>saved.get(key)??null,setItem:(key,value)=>saved.set(key,value),removeItem:key=>saved.delete(key),
    get length(){return saved.size;},key:index=>[...saved.keys()][index]};
  const f={saved,calls,storage,setIdentity:value=>{identity=value;},request:async(path)=>path.endsWith('/preview')?plan:path.endsWith('/corrections')?context:success()};
  f.create=()=>create({request:async(...args)=>{calls.push(args);return f.request(...args);},storage:()=>storage,identity:()=>identity,makeKey:()=>`ui-correction-key-${++counter}`});
  f.api=f.create();return f;
};
{
  const f=fixture();assert.deepEqual(JSON.parse(JSON.stringify(await f.api.context(original.id))),context);
  await f.api.preview(preview);assert.deepEqual(JSON.parse(f.calls.at(-1)[1].body),preview);
  for(const patch of [{targetEntryId:''},{targetEntryId:null},{operation:'waive'},{originalEntryId:[]},{amountCents:1}])
    await assert.rejects(f.api.preview({...preview,...patch}),e=>e.code==='payroll_correction_ui_target_required');
  assert.equal(f.calls.length,2);
}
for(const change of [p=>p.applyCents++,p=>p.targetAfterCents=699,p=>p.residualReviewCents++,p=>p.targetPeriod.from='2026-09-30',
  p=>p.venueId=id(99),p=>p.allocations.push(p.allocations[0]),p=>p.allocations[0]=null,p=>p.officialReady=true,
  p=>p.targetRunId=original.runId,p=>p.allocations[0].alreadyDisposedCents=999]){
  const f=fixture(),bad=structuredClone(plan);change(bad);assert.equal(f.api.planValid(bad,preview),false);
  f.request=async()=>bad;await assert.rejects(f.api.preview(preview),e=>e.code==='payroll_correction_ui_response_invalid');
}
for(const change of [p=>p.original.status='draft',p=>p.original.venueId=id(99),p=>p.targets[0].periodFrom='2026-09-30',
  p=>p.targets[0].amountCents=1001,p=>p.targets[0].requiresFreshPreview=false,p=>p.targets[0]=null,p=>p.history=[null],p=>p.remainingCents=null]){
  const f=fixture(),bad=structuredClone(context);change(bad);f.request=async()=>bad;
  await assert.rejects(f.api.context(original.id),e=>e.code==='payroll_correction_ui_response_invalid');
}
{
  const f=fixture();assert.throws(()=>f.api.begin(plan,'apply','x'),e=>e.code==='payroll_correction_ui_reason_required');
  f.api.begin(plan,'apply','Reviewed reason');const raw=[...f.saved.values()][0];
  assert.throws(()=>f.api.begin(waiver,'waive','Different decision'),e=>e.code==='payroll_correction_ui_retry_required');
  await assert.rejects(f.api.preview(preview),e=>e.code==='payroll_correction_ui_retry_required');assert.equal([...f.saved.values()][0],raw);
  f.request=async()=>{throw new Error('lost response');};await assert.rejects(f.api.retry(original.id),e=>e.correctionAttemptRetained===true);
  const first=f.calls.at(-1)[1].body,reloaded=f.create();assert.equal(reloaded.listPending().length,1);
  f.request=async()=>({...success(),replayed:true});assert.equal((await reloaded.retry(original.id)).replayed,true);
  assert.equal(f.calls.at(-1)[1].body,first);assert.equal(f.saved.size,0);
  assert.deepEqual(Object.keys(JSON.parse(first)).sort(),['expectedPlanHash','idempotencyKey','operation','originalEntryId','reason','targetEntryId']);
}
{
  const f=fixture();f.api.begin(waiver,'waive','Waive confirmed remainder');f.request=async()=>success(waiver,'waive');
  assert.equal((await f.api.retry(original.id)).totalCents,400);assert.equal(JSON.parse(f.calls[0][1].body).targetEntryId,null);
}
for(const [p,operation] of [[zeroPlan,'apply'],[zeroWaiver,'waive']]){
  const f=fixture(),input={operation,originalEntryId:original.id,targetEntryId:p.targetEntryId};
  assert.equal(p.policyVersion,'owner-reviewed-variable-correction-v2');assert.equal(f.api.planValid(p,input),true);
  f.request=async()=>p;await f.api.preview(input);f.api.begin(p,operation,'Reviewed zero settlement');
  const reloaded=f.create();assert.equal(reloaded.listPending().length,1);
  f.request=async()=>({...success(p,operation),replayed:true});await reloaded.retry(original.id);assert.equal(f.saved.size,0);
  for(const patch of [{originalExpenseId:id(8)},{originalPaidCents:1},{originalSettlementTransitionId:null},{policyVersion:'unknown'}])
    assert.equal(f.api.planValid({...p,...patch},input),false);
}
assert.equal(fixture().api.planValid({...plan,originalExpenseId:null},preview),false);
for(const [status,code,retained] of [[500,'payroll_correction_unavailable',true],[503,'payroll_correction_unavailable',true],
  [401,'authentication_required',true],[403,'payroll_scheme_owner_only',true],[404,'ambiguous_route',true],
  [409,'payroll_correction_idempotency_conflict',true],[409,'payroll_correction_request_integrity_invalid',true],
  [409,'payroll_correction_plan_stale',false],[409,'payroll_entry_evidence_source_not_current',false],
  [409,'payroll_refund_review_source_coverage_incomplete',false],[404,'payroll_correction_entry_not_found',false]]){
  const f=fixture();f.api.begin(plan,'apply','Reviewed reason');
  f.request=async()=>{throw Object.assign(new Error(code),{status,data:{error:code}});};
  await assert.rejects(f.api.retry(original.id),e=>e.correctionAttemptRetained===retained);assert.equal(f.saved.size,retained?1:0);
}
for(const patch of [{operation:'waive'},{targetEntryId:id(77)},{planHash:'b'.repeat(64)},{totalCents:301},
  {targetAfterCents:701},{residualReviewCents:101},{batchId:'bad'},{replayed:null}]){
  const f=fixture();f.api.begin(plan,'apply','Reviewed reason');f.request=async()=>({...success(),...patch});
  await assert.rejects(f.api.retry(original.id),e=>e.correctionAttemptRetained===true);assert.equal(f.saved.size,1);
}
{
  const f=fixture();f.storage.setItem=()=>{};assert.throws(()=>f.api.begin(plan,'apply','Reviewed reason'),e=>e.code==='payroll_correction_ui_storage_unavailable');assert.equal(f.calls.length,0);
}
{
  const f=fixture();f.api.begin(plan,'apply','Reviewed reason');f.saved.set([...f.saved.keys()][0],'{invalid');
  assert.throws(()=>f.api.listPending(),e=>e.code==='payroll_correction_ui_storage_invalid');
  await assert.rejects(f.api.retry(original.id));assert.equal(f.calls.length,0);
}
{
  const f=fixture();f.api.begin(plan,'apply','Reviewed reason');f.storage.removeItem=()=>{throw new Error('denied');};f.request=async()=>success();
  assert.equal((await f.api.retry(original.id)).retryPending,true);assert.equal(f.saved.size,1);
}
{
  const f=fixture();f.api.begin(plan,'apply','Reviewed reason');f.setIdentity(`${id(77)}:${venueId}`);
  await assert.rejects(f.api.retry(original.id));assert.equal(f.calls.length,0);assert.equal(f.create().listPending().length,0);
}
{
  const f=fixture();let finish;f.request=()=>new Promise(resolve=>{finish=resolve;});const pending=f.api.preview(preview);
  f.setIdentity('');finish(plan);await assert.rejects(pending,e=>e.code==='payroll_correction_ui_owner_required');
}

// Execute the actual mounted context/preview renderers with a small DOM seam.
const mountSource=extract('    const loadCorrectionContext =','    const sendCorrection =');
const domFixture=()=>{
  const controls=new Map();const node=()=>({innerHTML:'',textContent:'',isConnected:true,querySelector:selector=>controls.get(selector)});
  const box=node(),result=node();controls.set('[data-correction-original]',{value:original.id});
  controls.set('[data-correction-operation]',{value:'apply'});controls.set('[data-correction-target]',{value:target.id});
  controls.set('[data-correction-preview]',{disabled:false});controls.set('[data-correction-context]',box);controls.set('[data-correction-plan]',result);
  const f={box,result,controls};const scope={detail:{querySelector:selector=>controls.get(selector)},selectedRunId:original.runId,
    correctionReadToken:0,correctionContext:null,correctionPlan:null,alive:()=>true,savedRunLifecycleAllowed:()=>true,
    correctionController:{context:async()=>context,preview:async()=>plan,pending:()=>null},
    renderCorrectionPending:()=>{},correctionError:e=>e.message,money:value=>`${value} RUB`,
    escapeHtml:value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;')};
  f.scope=vm.createContext(scope);vm.runInContext(mountSource+'; globalThis.load=loadCorrectionContext;globalThis.preview=previewCorrection;',f.scope);
  return f;
};
{
  const f=domFixture();await f.scope.load(original.id);
  assert.match(f.box.innerHTML,/Выберите черновик явно/);assert.match(f.box.innerHTML,/value=""/);
  assert.match(f.box.innerHTML,/&lt;img src=x&gt;/);assert.doesNotMatch(f.box.innerHTML,/<img|<script/);
  await f.scope.preview();assert.match(f.result.innerHTML,/фиксированная часть: 700 RUB/);assert.match(f.result.innerHTML,/после действия: <strong>700 RUB/);
  assert.match(f.result.innerHTML,/отдельного решения: 100 RUB/);assert.match(f.result.innerHTML,/data-correction-reason minlength="3" maxlength="2000"/);
  f.controls.get('[data-correction-operation]').value='waive';f.scope.correctionController.preview=async()=>waiver;
  await f.scope.preview();assert.match(f.result.innerHTML,/400 RUB/);assert.match(f.result.innerHTML,/отмена другого начисления его не отменяет/);
}
for(const phase of ['context','preview'])for(const fail of [false,true]){
  const f=domFixture();if(phase==='preview')await f.scope.load(original.id);
  let finish,reject;f.scope.correctionController[phase]=()=>new Promise((resolve,no)=>{finish=resolve;reject=no;});
  const pending=phase==='context'?f.scope.load(original.id):f.scope.preview();
  f.scope.selectedRunId=id(90);f.scope.correctionReadToken++;f.box.innerHTML='new view';f.result.innerHTML='new plan';
  if(fail)reject(new Error('late'));else finish(phase==='context'?context:plan);await pending;
  assert.equal(f.box.innerHTML,'new view');assert.equal(f.result.innerHTML,'new plan');
}
{
  const f=domFixture();await f.scope.load(original.id);f.scope.correctionController.preview=async()=>{throw new Error('nonlinear unsupported');};
  await f.scope.preview();assert.equal(f.scope.correctionPlan,null);assert.match(f.result.textContent,/nonlinear unsupported/);
}
{
  const f=domFixture();f.scope.correctionController.context=async()=>({...context,history:[{kind:'waive',amountCents:200,
    reason:'<script>reason</script>',createdByName:'<img src=x>',createdAt:'2026-10-01',targetEntryId:null}]});
  await f.scope.load(original.id);assert.match(f.box.innerHTML,/&lt;script&gt;reason/);assert.doesNotMatch(f.box.innerHTML,/<script|<img/);
  assert.match(f.box.innerHTML,/Отказ от удержания: 200 RUB/);
}
// Actual send handler must re-read current target DTO, never show replay's old
// targetAfterCents as current. This seam also distinguishes commit from readback failure.
const sendSource=extract('    const sendCorrection =','    const today = venueLocalToday()');
const sendFixture=()=>{
  const calls=[],events=[],status={textContent:''},message={isConnected:true,textContent:''},button={disabled:false,isConnected:true};
  const controls=new Map([['[data-correction-message]',message],['[data-correction-commit]',button],
    ['[data-correction-reason]',{value:'Reviewed reason'}],['[data-correction-original]',{value:original.id}]]);
  const attempt={plan,command:{...preview,expectedPlanHash:plan.planHash,idempotencyKey:'ui-send-request',reason:'Reviewed reason'}};
  const scope={status,detail:{querySelector:selector=>controls.get(selector)},alive:()=>true,savedRunLifecycleAllowed:()=>true,correctionBusy:new Set(),
    correctionPlan:{plan,operation:'apply'},correctionContext:context,selectedRunId:original.runId,
    correctionController:{begin:(...args)=>calls.push(['begin',...args]),pending:()=>attempt,
      retry:async()=>({...success(),originalRunId:original.runId,originalEntryId:original.id,retryPending:false})},
    renderCorrectionPending:()=>calls.push(['renderPending']),correctionError:error=>error.message,
    money:value=>`${value} RUB`,savedEntryValid:entry=>Boolean(entry?.id),
    savedRequest:async path=>{calls.push(['readback',path]);return {items:[{id:target.id,userId:employeeId,status:'cancelled',amountCents:850}]};},
    loadCorrectionContext:async entry=>calls.push(['context',entry]),invalidateCorrectionPlan:()=>calls.push(['invalidated']),
    document:{dispatchEvent:event=>events.push(event.type)},CustomEvent:class{constructor(type){this.type=type;}}};
  const sandbox=vm.createContext(scope);vm.runInContext(sendSource+';globalThis.send=sendCorrection;',sandbox);
  return {scope:sandbox,calls,events,status,message,button,controls};
};
{
  const f=sendFixture();await f.scope.send(original.id,true);
  assert.equal(f.calls[0][0],'begin');assert.ok(f.calls.some(row=>row[0]==='readback'&&row[1].includes(target.runId)));
  assert.match(f.status.textContent,/отменено.*850 RUB/);assert.doesNotMatch(f.status.textContent,/700 RUB/);
  assert.ok(f.calls.some(row=>row[0]==='context'));assert.deepEqual(f.events,['payroll-run-entry-created']);
  assert.equal(f.scope.correctionBusy.size,0);
}
{
  const f=sendFixture();f.scope.savedRequest=async()=>{throw new Error('offline readback');};await f.scope.send(original.id);
  assert.match(f.status.textContent,/Решение записано, но актуальную сумму/);assert.doesNotMatch(f.status.textContent,/Результат запроса не подтверждён/);
}
{
  const f=sendFixture();f.scope.savedRequest=async()=>({items:[{id:target.id,userId:id(99),status:'draft',amountCents:1}]});
  await f.scope.send(original.id);assert.match(f.status.textContent,/Решение записано, но актуальную сумму/);assert.doesNotMatch(f.status.textContent,/1 RUB/);
}
{
  const f=sendFixture();f.scope.correctionController.retry=async()=>{throw Object.assign(new Error('lost'),{correctionAttemptRetained:true});};
  await f.scope.send(original.id);assert.match(f.status.textContent,/Восстановить результат/);assert.equal(f.calls.some(row=>row[0]==='readback'),false);
}
{
  const f=sendFixture();f.scope.correctionPlan={plan:{...plan,originalEntryId:id(95)},operation:'apply'};
  f.scope.correctionController.retry=async()=>{throw Object.assign(new Error('stale'),{correctionAttemptRetained:false});};
  await f.scope.send(original.id);assert.equal(f.calls.some(row=>row[0]==='invalidated'),false,'retry of another entry cannot clear selected plan');
}
for(const mode of ['success','retained','rejected']){
  const f=sendFixture();f.scope.correctionPlan={plan:{...plan,originalEntryId:id(95)},operation:'apply'};
  f.controls.get('[data-correction-original]').value=id(95);f.scope.selectedRunId=id(96);f.message.textContent='B ready';
  const bPlan=f.scope.correctionPlan;
  if(mode!=='success')f.scope.correctionController.retry=async()=>{throw Object.assign(new Error(mode),{correctionAttemptRetained:mode==='retained'});};
  await f.scope.send(original.id);
  assert.equal(f.button.disabled,false,`recovering A must not disable B on ${mode}`);
  assert.equal(f.message.textContent,'B ready');assert.equal(f.scope.correctionPlan,bPlan);
  assert.equal(f.scope.correctionBusy.size,0);assert.equal(f.calls.some(row=>row[0]==='invalidated'),false);
}
{
  const f=sendFixture();let pending=true;
  f.scope.correctionController.pending=()=>pending?{plan,command:preview}:null;
  f.scope.correctionController.retry=async()=>{pending=false;throw new Error('confirmed pre-write rejection');};
  await f.scope.send(original.id);assert.equal(f.button.disabled,false,'current commit recovers after a failed request with no persisted attempt');
  assert.equal(f.scope.correctionBusy.size,0);
}
{
  const f=sendFixture();f.scope.correctionController.retry=async()=>{throw Object.assign(new Error('uncertain'),{correctionAttemptRetained:true});};
  await f.scope.send(original.id);assert.equal(f.button.disabled,true,'ambiguous request retains recovery-only control');
  assert.equal(f.scope.correctionBusy.size,0);
}
{
  const f=sendFixture();let finish;
  f.scope.correctionController.retry=()=>new Promise(resolve=>{finish=resolve;});const sending=f.scope.send(original.id);
  const newButton={isConnected:true,disabled:false},newMessage={isConnected:true,textContent:'B ready'};
  f.controls.set('[data-correction-commit]',newButton);f.controls.set('[data-correction-message]',newMessage);
  f.controls.get('[data-correction-original]').value=id(95);f.scope.selectedRunId=id(96);
  f.scope.correctionPlan={plan:{...plan,originalEntryId:id(95)},operation:'apply'};
  finish({...success(),originalRunId:original.runId,originalEntryId:original.id,retryPending:false});await sending;
  assert.equal(newButton.disabled,false);assert.equal(newMessage.textContent,'B ready');
}
assert.match(ui,/data-correction-pending[\s\S]*data-saved-run-detail/,'recovery is outside selected-run detail');
assert.match(ui,/savedRequest\(`\/api\/payroll\/calculation-runs\/\$\{encodeURIComponent\(attempt\.plan\.targetRunId\)\}\/entries`\)/,'confirmed result reloads live target');
assert.match(ui,/entry\.userId!==attempt\.plan\.employeeId/,'live readback binds the target employee');
assert.match(ui,/sessionUser\.role !== 'owner'/);
console.log('PASS reviewed correction UI: real policy plans, strict context/preview/result validation, explicit target, protected fixed/waive totals, exact persistent retry/reload, owner scope, storage failures, escaped actual renderer, stale async guards and live readback');
