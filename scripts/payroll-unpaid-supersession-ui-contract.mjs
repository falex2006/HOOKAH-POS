import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const ui = readFileSync(new URL('../payroll-scheme-ui.js',import.meta.url),'utf8');
const extract = (start,end) => { const a=ui.indexOf(start),b=ui.indexOf(end,a+start.length); assert.ok(a>=0&&b>a);return ui.slice(a,b); };
const create = vm.runInNewContext(extract('  const createUnpaidSupersessionController =','  // End unpaid supersession controller.')+';createUnpaidSupersessionController',{URLSearchParams});
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const sha='a'.repeat(64),runId=id(1),owner=id(2),venue=id(3),capability='employee_attributed_remaining_net_refund_v2';
const oldEntries=[4,5,6].map((n,i)=>({employeeId:id(n),entryId:id(n+10),status:i===2?'cancelled':'draft',
  grossCents:i===2?0:1000,amountCents:i===2?0:900,stateHash:sha,ledgerHash:sha,financeCategoryId:i===0?id(50):null}));
const employeeAmounts=oldEntries.map((row,i)=>({employeeId:row.employeeId,amountCents:[500,1200,0][i]}));
const preview={schemaVersion:1,originalRunId:runId,planHash:sha,monetaryWrites:false,payoutEligible:false,
  oldEntries, replacementAmounts:employeeAmounts,
  plan:{schemaVersion:1,originalRunId:runId,originalProvenanceSha256:sha,originalInputWatermark:sha,
    originalCapabilityVersion:capability,historicalSchemeSha256:sha,periodFrom:'2026-09-01',periodTo:'2026-09-30',currency:'RUB',
    replacementInputWatermark:sha,replacementCapabilityVersion:capability,employeeAmounts,oldEntries}};
const names=['<img src=x> Иван','Анна','Нулевая сумма'];
const page=n=>({runId,capabilityVersion:capability,period:{from:'2026-09-01',to:'2026-09-30'},
  employees:[{employeeId:oldEntries[n].employeeId,employeeName:names[n]}],nextCursor:n===2?null:`cursor-${n+1}`});
const receipt=()=>({schemaVersion:1,journalId:id(20),originalRunId:runId,replacementRunId:id(21),planHash:sha,replayed:false,
  entries:employeeAmounts.map((row,i)=>({...row,entryId:id(i+30),financeCategoryId:oldEntries[i].financeCategoryId}))});
const fixture=()=>{
  const saved=new Map(),calls=[];let identity=`${owner}:${venue}`,counter=0;
  const storage={getItem:key=>saved.get(key)??null,setItem:(key,value)=>saved.set(key,value),removeItem:key=>saved.delete(key),
    get length(){return saved.size;},key:n=>[...saved.keys()][n]};
  const f={saved,calls,storage,setIdentity:value=>{identity=value;},request:async path=>path.endsWith('/preview')?preview:
    path.endsWith('/supersession')?receipt():page(path.includes('cursor-2')?2:path.includes('cursor-1')?1:0)};
  f.create=()=>create({request:async(...args)=>{calls.push(args);return f.request(...args);},storage:()=>storage,
    identity:()=>identity,makeKey:()=>`supersession-ui-${++counter}`});
  f.api=f.create();return f;
};
const clone=value=>JSON.parse(JSON.stringify(value));
{
  const f=fixture(); assert.equal(f.calls.length,0);assert.equal(f.api.listPending().length,0);
  const result=await f.api.preview(runId);
  assert.deepEqual(clone(result.preview),preview);assert.deepEqual(Object.values(result.names),names);
  assert.equal(f.calls.length,4,'preview plus all three immutable employee pages');
  assert.equal(f.calls[0][0],`/api/payroll/calculation-runs/${runId}/supersession/preview`);
  assert.deepEqual(clone(f.calls[0][1]),{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
  assert.ok(f.calls.slice(1).every(row=>row[1]===undefined));
  assert.equal(f.saved.size,0,'preview creates no pending financial command');
}
for(const change of [p=>p.schemaVersion=2,p=>p.originalRunId=id(90),p=>p.planHash='bad',p=>p.monetaryWrites=true,p=>p.payoutEligible=true,
  p=>p.plan.originalRunId=id(90),p=>p.plan.originalCapabilityVersion='legacy',p=>p.plan.replacementCapabilityVersion='legacy',
  p=>p.plan.periodFrom='2026-09-02',p=>p.plan.periodTo='2026-10-01',p=>p.plan.periodTo='2026-09-31',p=>p.plan.currency='USD',
  p=>p.plan.originalProvenanceSha256=null,p=>p.oldEntries.pop(),p=>p.replacementAmounts.pop(),p=>p.plan.oldEntries[0].status='approved',
  p=>p.plan.oldEntries[0].status='paid',p=>p.plan.oldEntries[0].amountCents=1001,p=>p.plan.oldEntries[0].financeCategoryId='bad',
  p=>p.plan.oldEntries[0].stateHash=null,p=>p.plan.oldEntries[1].entryId=p.plan.oldEntries[0].entryId,
  p=>p.plan.employeeAmounts[0].amountCents=-1,p=>p.plan.employeeAmounts[0].amountCents=0.1,
  p=>p.plan.employeeAmounts[0].amountCents=1000000000000,p=>p.plan.employeeAmounts[0].employeeId=id(99),
  p=>p.oldEntries[0].amountCents=899,p=>p.replacementAmounts[0].amountCents=499,p=>p.plan.oldEntries[0]=null]){
  const f=fixture(),bad=clone(preview);change(bad);assert.equal(f.api.planValid(bad,runId),false);
  f.request=async()=>bad;await assert.rejects(f.api.preview(runId),e=>e.code==='payroll_unpaid_supersession_ui_response_invalid');
  assert.equal(f.calls.length,1);
}
for(const change of [p=>p.runId=id(99),p=>p.capabilityVersion='legacy',p=>p.period.to='2026-09-29',p=>p.employees=[],
  p=>p.employees[0].employeeId=id(99),p=>p.employees[0].employeeName='',p=>p.nextCursor=undefined,p=>p.nextCursor=12]){
  const f=fixture();f.request=async path=>{if(path.endsWith('/preview'))return preview;const p=page(0);change(p);return p;};
  await assert.rejects(f.api.preview(runId),e=>e.code==='payroll_unpaid_supersession_ui_response_invalid');
}
{
  const f=fixture();f.request=async path=>path.endsWith('/preview')?preview:page(0);
  await assert.rejects(f.api.preview(runId),/response_invalid/);assert.equal(f.calls.length,3,'repeated employee/cursor never loops');
}
{
  const f=fixture();assert.throws(()=>f.api.begin(preview,'Reviewed reason',false),/confirmation_required/);
  for(const reason of ['',null,'  x ', 'x'.repeat(501)])assert.throws(()=>f.api.begin(preview,reason,true),/reason_required/);
  assert.equal(f.calls.length,0);assert.equal(f.saved.size,0);
  f.api.begin(preview,'  Owner reviewed full cohort  ',true);const raw=[...f.saved.values()][0];
  assert.throws(()=>f.api.begin(preview,'Another reason',true),/retry_required/);
  await assert.rejects(f.api.preview(runId),/retry_required/);assert.equal([...f.saved.values()][0],raw);
  f.request=async()=>{throw new Error('response lost after commit');};
  await assert.rejects(f.api.retry(runId),e=>e.supersessionAttemptRetained===true);
  const body=f.calls.at(-1)[1].body,reloaded=f.create();assert.equal(reloaded.listPending().length,1);
  assert.equal(f.calls.length,1,'reload/controller creation does not autoPOST');
  f.request=async()=>({...receipt(),replayed:true});assert.equal((await reloaded.retry(runId)).replayed,true);
  assert.equal(f.calls.at(-1)[1].body,body);assert.equal(f.saved.size,0);
  assert.deepEqual(Object.keys(JSON.parse(body)),['expectedPlanHash','reason','idempotencyKey']);
  assert.equal(JSON.parse(body).reason,'Owner reviewed full cohort');
  assert.equal(f.calls.at(-1)[0],`/api/payroll/calculation-runs/${runId}/supersession`);
}
for(const [status,error,retained] of [[500,'unavailable',true],[503,'unavailable',true],[401,'authentication_required',true],
  [403,'payroll_scheme_owner_only',true],[409,'payroll_unpaid_supersession_idempotency_conflict',true],
  [409,'payroll_unpaid_supersession_receipt_integrity_invalid',true],[409,'payroll_unpaid_supersession_run_already_superseded',true],
  [409,'payroll_unpaid_supersession_plan_stale',false],[409,'payroll_unpaid_supersession_original_entry_cohort_mismatch',false],
  [409,'payroll_unpaid_supersession_original_entries_not_unpaid_drafts',false],[400,'payroll_unpaid_supersession_request_invalid',false],
  [404,'unknown_route',true]]){
  const f=fixture();f.api.begin(preview,'Reviewed reason',true);
  f.request=async()=>{throw Object.assign(new Error(error),{status,data:{error}});};
  await assert.rejects(f.api.retry(runId),e=>e.supersessionAttemptRetained===retained);assert.equal(f.saved.size,retained?1:0);
}
for(const change of [r=>r.schemaVersion=2,r=>r.originalRunId=id(99),r=>r.replacementRunId=runId,r=>r.journalId='bad',
  r=>r.planHash='b'.repeat(64),r=>r.replayed=null,r=>r.entries.pop(),r=>r.entries[0].amountCents++,
  r=>r.entries[0].financeCategoryId=null,r=>r.entries[0].employeeId=id(99),r=>r.entries[1].entryId=r.entries[0].entryId,
  r=>r.entries[0].entryId=oldEntries[0].entryId,r=>r.entries[0].entryId=oldEntries[1].entryId,r=>r.entries[0]=null]){
  const f=fixture();f.api.begin(preview,'Reviewed reason',true);const bad=receipt();change(bad);f.request=async()=>bad;
  await assert.rejects(f.api.retry(runId),e=>e.code==='payroll_unpaid_supersession_ui_response_invalid'&&e.supersessionAttemptRetained===true);
  assert.equal(f.saved.size,1);
}
{
  const f=fixture();f.storage.setItem=()=>{};
  assert.throws(()=>f.api.begin(preview,'Reviewed reason',true),/storage_unavailable/);assert.equal(f.calls.length,0);
}
{
  const f=fixture();f.api.begin(preview,'Reviewed reason',true);f.storage.removeItem=()=>{throw new Error('denied');};
  assert.equal((await f.api.retry(runId)).retryPending,true);assert.equal(f.saved.size,1);
}
for(const change of [()=>'{invalid',raw=>{const a=JSON.parse(raw);a.command.extra=1;return JSON.stringify(a);},
  raw=>{const a=JSON.parse(raw);a.command.expectedPlanHash='b'.repeat(64);return JSON.stringify(a);}]){
  const f=fixture();f.api.begin(preview,'Reviewed reason',true);const key=[...f.saved.keys()][0];f.saved.set(key,change(f.saved.get(key)));
  assert.throws(()=>f.api.listPending(),/storage_invalid/);await assert.rejects(f.api.retry(runId));assert.equal(f.calls.length,0);
}
{
  const f=fixture();f.api.begin(preview,'Reviewed reason',true);f.setIdentity(`${id(99)}:${venue}`);
  await assert.rejects(f.api.retry(runId),/owner_required/);assert.equal(f.calls.length,0);assert.equal(f.create().listPending().length,0);
}
for(const operation of ['preview','retry']){
  const f=fixture();if(operation==='retry')f.api.begin(preview,'Reviewed reason',true);
  let finish;f.request=()=>new Promise(resolve=>{finish=resolve;});const running=f.api[operation](runId);
  f.setIdentity('');finish(operation==='preview'?preview:receipt());await assert.rejects(running,/owner_required/);
  if(operation==='retry')assert.equal(f.saved.size,1,'session loss retains unconfirmed intent');
}

// Real mounted render/send handlers, including XSS and stale-response guards.
const actions=extract('    const supersessionAllowed =','    // End mounted unpaid supersession actions.');
const domFixture=()=>{
  const controls=new Map(),calls=[],node=()=>({innerHTML:'',textContent:'',isConnected:true,disabled:false});
  const box=node(),pending=node(),message=node(),button=node();
  controls.set('[data-supersession-content]',box);controls.set('[data-supersession-message]',message);
  controls.set('[data-supersession-commit]',button);controls.set('[data-supersession-reason]',{value:'Owner reviewed'});
  controls.set('[data-supersession-confirm]',{checked:true});
  let pendingAttempt=null;
  const controller={preview:async()=>({preview,names:Object.fromEntries(oldEntries.map((r,i)=>[r.employeeId,names[i]]))}),
    begin:(...args)=>{calls.push(['begin',...args]);pendingAttempt={preview,command:{}};},pending:()=>pendingAttempt,
    listPending:()=>pendingAttempt?[pendingAttempt]:[],retry:async()=>{pendingAttempt=null;return receipt();}};
  const context=vm.createContext({detail:{dataset:{savedRunCapability:capability},querySelector:key=>controls.get(key)},
    section:{querySelector:()=>pending},selectedRunId:runId,detailToken:1,supersessionPlan:null,supersessionReadToken:0,
    supersessionBusy:new Set(),supersessionController:controller,status:node(),alive:()=>true,
    escapeHtml:value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;'),
    money:value=>`${value} RUB`,table:(caption,headers,rows)=>`<table><caption>${caption}</caption><thead>${headers.join('|')}</thead>${rows}</table>`,
    openRun:async id=>calls.push(['open',id])});
  vm.runInContext(actions+';globalThis.previewUI=previewSupersession;globalThis.sendUI=sendSupersession;globalThis.pendingUI=renderSupersessionPending;',context);
  return {context,box,pending,message,button,controls,calls,controller};
};
{
  const f=domFixture();await f.context.previewUI(f.button);
  assert.match(f.box.innerHTML,/Все сотрудники: 3/);assert.match(f.box.innerHTML,/&lt;img src=x&gt;/);
  assert.doesNotMatch(f.box.innerHTML,/<img|<script/);assert.equal((f.box.innerHTML.match(/<tr>/g)||[]).length,3);
  assert.match(f.box.innerHTML,/0 RUB/);assert.match(f.box.innerHTML,/1200 RUB/);assert.match(f.box.innerHTML,/Отменено/);
  assert.match(f.box.innerHTML,/data-supersession-reason minlength="3" maxlength="500"/);
  assert.match(f.box.innerHTML,/data-supersession-confirm/);assert.equal(f.calls.length,0,'preview never begins a commit');
  await f.context.sendUI(runId,true);assert.equal(f.calls[0][0],'begin');assert.equal(f.calls[0][3],true);
  assert.deepEqual(f.calls.at(-1),['open',id(21)]);assert.equal(f.context.supersessionBusy.size,0);
  assert.match(f.context.status.innerHTML,/Прежняя доступна в истории/);
}
for(const capability of ['employee_attributed_merchandise_net_no_refund_v1','unknown','']){
  const f=domFixture();f.context.detail.dataset.savedRunCapability=capability;
  f.controller.preview=async()=>{throw new Error('must not call');};await f.context.previewUI(f.button);
  await f.context.sendUI(runId,true);assert.equal(f.calls.length,0);assert.equal(f.box.textContent,'');
}
for(const error of ['original_entry_cohort_mismatch','original_entries_not_unpaid_drafts','replacement_employee_cohort_mismatch']){
  const f=domFixture();f.controller.preview=async()=>{throw Object.assign(new Error('failure'),{data:{error:`payroll_unpaid_supersession_${error}`}});};
  await f.context.previewUI(f.button);assert.match(f.box.textContent,/полной|утверждённое|Состав/);
  assert.equal(f.context.supersessionPlan,null);assert.equal(f.calls.length,0);
}
for(const rejected of [false,true]){
  const f=domFixture();let finish,reject;f.controller.preview=()=>new Promise((resolve,no)=>{finish=resolve;reject=no;});
  const running=f.context.previewUI(f.button);f.context.selectedRunId=id(99);f.context.supersessionReadToken++;f.box.innerHTML='new view';
  if(rejected)reject(new Error('late'));else finish({preview,names:{}});await running;
  assert.equal(f.box.innerHTML,'new view');assert.equal(f.context.supersessionPlan,null);
}
for(const retained of [true,false]){
  const f=domFixture();await f.context.previewUI(f.button);
  f.controller.retry=async()=>{if(!retained)f.controller.pending=()=>null;throw Object.assign(new Error('failed'),{
    data:{error:'payroll_unpaid_supersession_plan_stale'},supersessionAttemptRetained:retained});};
  await f.context.sendUI(runId,true);assert.equal(f.calls.some(row=>row[0]==='open'),false);
  assert.match(f.context.status.textContent,retained?/Восстановить результат/:/Данные изменились/);
  assert.equal(f.context.supersessionBusy.size,0);
  if(retained){assert.equal(f.button.disabled,true);assert.match(f.pending.innerHTML,/data-supersession-retry/);}
  else assert.equal(f.context.supersessionPlan,null);
}
{
  const f=domFixture();await f.context.previewUI(f.button);let finish;
  f.controller.retry=()=>new Promise(resolve=>{finish=resolve;});const running=f.context.sendUI(runId,true);
  f.context.selectedRunId=id(99);f.context.detailToken++;f.message.textContent='new employee view';finish(receipt());await running;
  assert.equal(f.calls.some(row=>row[0]==='open'),false,'late commit does not navigate away from another selected run');
  assert.equal(f.message.textContent,'new employee view');assert.match(f.context.status.innerHTML,/data-saved-run-open/);
}
assert.match(ui,/storage:\(\)=>sessionStorage,[\s\S]*identity:\(\)=>alive\(\)\?identity:''/);
assert.match(ui,/data-supersession-pending[\s\S]*data-saved-run-detail/);
assert.match(ui,/button\.dataset\.supersessionRetry\) void sendSupersession\(button\.dataset\.supersessionRetry\)/);
console.log('PASS unpaid supersession UI: complete paginated cohort, explicit reason/confirmation, strict DTOs, exact session retry, owner isolation, stale response guards; VM only, no PG/browser');
