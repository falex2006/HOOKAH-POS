import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const ui=readFileSync(new URL('../payroll-scheme-ui.js',import.meta.url),'utf8');
const start=ui.indexOf('  const renderRefundAwareSourcedComparison ='),end=ui.indexOf('  const renderSourcedComparison =',start);
assert.ok(start>0&&end>start);
const context=vm.createContext({escapeHtml:value=>String(value??'').replaceAll('<','&lt;').replaceAll('>','&gt;'),money:value=>`${value} коп.`,readinessReasonLabel:value=>value});
vm.runInContext(ui.slice(start,end)+';globalThis.render=renderRefundAwareSourcedComparison;',context);
const hash='a'.repeat(64),period={from:'2026-09-01',to:'2026-09-30',timezone:'UTC'};
const row=(id,amount)=>({versionId:id,schemeId:'scheme-'+id,name:'<script>bad</script>',versionNo:1,mode:'percent_only',policyFamily:'refund_aware_v2',status:'ready',reasons:[],amountCents:amount,inputWatermark:hash,sourceWatermarks:{recognitionManifest:hash},employees:[{employeeId:'e1',amountCents:amount},{employeeId:'e2',amountCents:0}],candidateEvidence:{schemaVersion:2,venueId:'venue',schemeVersionId:id,currency:'RUB',period,sharedSourceWatermark:hash,amountCents:amount,inputWatermark:hash,calculationWatermark:hash,officialReady:false,payoutEligible:false,persistence:'none'},deltaCents:amount-100,employeeDeltas:[{employeeId:'e1',status:'comparable',amountCents:amount,baselineAmountCents:100,deltaCents:amount-100},{employeeId:'e2',status:'comparable',amountCents:0,baselineAmountCents:0,deltaCents:0}]});
const payload={schemaVersion:2,comparisonKind:'sourced_candidate_v2',candidateOnly:true,nonPayable:true,nonAccrual:true,officialReady:false,payoutEligible:false,persistence:'none',venueId:'venue',currency:'RUB',period,baselineVersionId:'v1',sharedSourceWatermark:hash,results:[row('v1',100),row('v2',50)]};
const rendered=context.render(payload);assert.match(rendered,/-50 коп/);assert.match(rendered,/По сотрудникам: 2/);assert.match(rendered,/до входящих корректировок/);assert.doesNotMatch(rendered,/<script>/);
let checks=4;
for(const mutate of [p=>p.results[1].amountCents=51,p=>p.results[1].deltaCents=1,p=>p.sharedSourceWatermark='bad',p=>p.results[1].candidateEvidence.venueId='foreign',p=>p.results[1].candidateEvidence.schemeVersionId='other',p=>p.results[1].candidateEvidence.period={...period,to:'2026-09-29'},p=>p.results[1].candidateEvidence.sharedSourceWatermark='b'.repeat(64),p=>p.results[1].candidateEvidence.calculationWatermark=null,p=>p.results[1].candidateEvidence.officialReady=true,p=>p.results[1].employees.push({...p.results[1].employees[0]}),p=>p.results[1].employeeDeltas[0].deltaCents=999,p=>p.results[1].policyFamily='legacy_v1',p=>p.results[1].status='unknown',p=>p.results[1].employees[0].amountCents=-1,p=>p.baselineVersionId='missing',p=>p.results.push(p.results[1]),p=>p.period.from='2026-02-31']){const test=structuredClone(payload);mutate(test);assert.throws(()=>context.render(test));checks++;}
const blocked=structuredClone(payload);Object.assign(blocked.results[0],{status:'blocked',amountCents:null,candidateEvidence:null,employees:[],employeeDeltas:null,deltaCents:null,reasons:['missing source']});blocked.results[1].employeeDeltas=null;blocked.results[1].deltaCents=null;assert.match(context.render(blocked),/50 коп/);checks++;
const mixed=structuredClone(payload);mixed.results[1].policyFamily='legacy_v1';mixed.results[1].candidateEvidence.schemaVersion=1;mixed.results[1].deltaCents=null;mixed.results[1].employeeDeltas=null;assert.match(context.render(mixed),/Исходная политика/);checks++;
const missing=structuredClone(payload);missing.results[1].employees.pop();Object.assign(missing.results[1].employeeDeltas[1],{status:'identity_uncovered',amountCents:null,baselineAmountCents:0,deltaCents:null});assert.match(context.render(missing),/e2 · Нет данных в одной из схем/);checks++;
assert.match(context.render(payload,[{id:'e1',name:'Анна'}]),/Анна/);checks++;
// Exercise the actual delegated handler, including its finally block. A custom
// select owns its focus: bubbling trigger/option clicks must not rebuild the
// native select and destroy the option that the portal just focused.
const handlerStart=ui.indexOf("    panel.addEventListener('click', async (event) => {");
const handlerEnd=ui.indexOf("    editor.addEventListener('submit'",handlerStart);
assert.ok(handlerStart>0&&handlerEnd>handlerStart);
let delegated,refreshes=0,rebuilds=0;
const workspaces=[],notifications=[];
const handlerContext=vm.createContext({pending:false,
  panel:{addEventListener:(type,handler)=>{assert.equal(type,'click');delegated=handler;}},
  refreshReadiness:()=>refreshes++,rebuildGrid:()=>rebuilds++,
  selectWorkspace:(name,options)=>workspaces.push({name,focus:options.focus}),
  notify:message=>notifications.push(message),payrollSaveErrorLabels:{},sourcePreviewErrorLabels:{},
  approvedAttendancePreviewErrorLabels:{},attendanceErrorLabels:{}});
vm.runInContext(ui.slice(handlerStart,handlerEnd),handlerContext);
assert.equal(typeof delegated,'function');
const button=(selector,dataset={})=>({dataset,matches:query=>query.split(',').some(value=>value.trim()===selector)});
const eventFor=control=>({target:{closest:selector=>{assert.equal(selector,'button');return control;}}});
for(const selector of ['.custom-select-trigger','.custom-select-option','[data-source-comparison-run]']) {
  const activeOption={connected:true},menu={open:true};
  // Spy on the destructive refresh side effect while using the real handler.
  handlerContext.refreshReadiness=()=>{refreshes++;activeOption.connected=false;menu.open=false;};
  await delegated(eventFor(button(selector)));
  assert.equal(activeOption.connected,true,`${selector} must retain the focused option`);
  assert.equal(menu.open,true,`${selector} must retain custom-select ownership`);
  assert.equal(refreshes,0,`${selector} is not a delegated scheme action`);
  checks++;
}
handlerContext.refreshReadiness=()=>refreshes++;
await delegated(eventFor(button('[data-scheme-workspace]',{schemeWorkspace:'checks'})));
assert.deepEqual(workspaces,[{name:'checks',focus:true}]);assert.equal(refreshes,1);checks++;
await delegated(eventFor(button('[data-scheme-grid-rebuild]')));
assert.equal(rebuilds,1);assert.equal(refreshes,2);checks++;
handlerContext.pending=true;
await delegated(eventFor(button('[data-scheme-grid-rebuild]')));
assert.equal(rebuilds,1);assert.equal(refreshes,2);checks++;
await delegated(eventFor(null));assert.equal(refreshes,2);assert.deepEqual(notifications,[]);checks++;
console.log(`PASS refund-aware sourced comparison UI: ${checks} validation/render cases`);
