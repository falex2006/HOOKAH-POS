import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const ui = readFileSync(new URL('../payroll-scheme-ui.js', import.meta.url), 'utf8');
const extract = (start, end) => {
  const first = ui.indexOf(start), last = ui.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first);
  return ui.slice(first, last);
};
const context = vm.createContext({});
vm.runInContext(extract('  const escapeHtml =', '  const venueLocalToday =') +
  extract('  const readinessLabels =', '  const mount =') +
  '\nglobalThis.render=renderSourceReadiness; globalThis.valid=sourceReadinessPeriodValid;', context);
const keys = ['sourcePolicies','approvedAttendance','orderObservations','refundObservations','canonicalLinePricing','payrollSaleCredit','recognitionManifest','recognizedLineRefunds','fullEmployeeNetRevenue','marginCosts','departmentShiftAllocation'];
const payload = {schemaVersion:1, officialReady:false, period:{from:'2026-11-01',to:'2026-11-02',timezone:'<img src=x onerror=bad>'},
  components:Object.fromEntries(keys.map(key=>[key,{status:'unsupported',reasons:['<script>bad</script>']}]))};
payload.components.refundObservations.eventCount=null;
payload.components.recognitionManifest={status:'available',reasons:[],recognizedSaleEventCount:2,recognizedSaleLineCount:3,
  recognizedRefundEventCount:1,recognizedRefundLineCount:1,sourceWatermark:'a'.repeat(64),watermarkScope:'immutable_events'};
payload.components.orderObservations={status:'available',reasons:[],closedOrderCount:0};
const html=context.render(payload);
const card = (markup, key) => {
  const result = markup.match(new RegExp(`<section data-source-readiness-component="${key}"[^>]*>[\\s\\S]*?<\\/section>`));
  assert.ok(result, `readiness card ${key} is present`);
  return result[0];
};
assert.match(html,/Официальный расчёт пока недоступен/);
assert.match(card(html, 'refundObservations'), /Возвратов, зарегистрированных за период: <strong>Неизвестно<\/strong>/);
assert.doesNotMatch(card(html, 'refundObservations'), /<strong>0<\/strong>|data-source-readiness-status="available"/);
assert.match(card(html, 'orderObservations'), /Закрытых заказов за период: <strong>0<\/strong>/, 'a confirmed zero is distinct from an unknown metric');
assert.match(html,/Нулевые значения.*не разрешают официальный расчёт/);
assert.match(html,/Признанных строк продажи: <strong>3<\/strong>/);
assert.match(html,/Признанных строк возврата: <strong>1<\/strong>/);
assert.doesNotMatch(html,/orderItemId|saleLineEventId/,'line-level identifiers stay inside the read manifest, not in the readiness summary');
assert.match(html,/&lt;img src=x onerror=bad&gt;/, 'external period context is escaped');
assert.match(html,/Источник требует проверки\. Проверьте данные или обратитесь к администратору\./);
assert.doesNotMatch(html,/&lt;script&gt;/, 'unknown reason text is translated to a safe owner-facing message');
assert.doesNotMatch(html,/<script>|<img src=x/);
for (const bad of [null, {}, {...payload,schemaVersion:2}, {...payload,officialReady:true}, {...payload,officialReady:null},
  {...payload,components:null}, {...payload,components:[]}, {...payload,components:'available'}]) assert.throws(()=>context.render(bad));
const missing = context.render({...payload,components:{}});
assert.match(missing,/Доступно: 0/);
assert.match(card(missing,'sourcePolicies'),/data-source-readiness-kind="missing".*Источник не получен/s);
assert.doesNotMatch(missing,/data-source-readiness-status="available"|<strong>0<\/strong>/);
for (const item of [null, [], 'available', {status:'constructor'}, {status:'__proto__'}, {status:'future_ready'}, {status:null}]) {
  const invalid = context.render({...payload,components:{...payload.components,sourcePolicies:item}});
  assert.match(card(invalid, 'sourcePolicies'), /Данные не распознаны — нужна проверка/);
  assert.doesNotMatch(card(invalid, 'sourcePolicies'), /data-source-readiness-status="available"|<strong>0<\/strong>/);
  assert.match(invalid,/Официальный расчёт пока недоступен/);
}
const future = context.render({...payload,components:{...payload.components,
  ['<img src=x onerror=bad>']:{status:'available',eventCount:0,reasons:['<script>bad</script>']}}});
assert.match(card(future,'additional-1'),/Новый источник — требуется проверка/);
assert.doesNotMatch(card(future,'additional-1'),/data-source-readiness-status="available"|<strong>0<\/strong>|<img|<script/);
assert.match(future,/Доступно: 2/, 'an unrecognized future component cannot inflate the ready count');
for (const value of [undefined, '0', '<img src=x onerror=bad>', {}, NaN]) {
  const invalidMetric = context.render({...payload,components:{...payload.components,
    refundObservations:{status:'unsupported',eventCount:value,reasons:[]}}});
  assert.doesNotMatch(card(invalidMetric,'refundObservations'),/<strong>0<\/strong>|<img|Возвратов, зарегистрированных за период:/,
    'malformed metrics cannot be coerced into zero or injected markup');
}
for(const [from,to,expected] of [['2026-11-01','2026-11-30',true],['2026-11-02','2026-11-30',false],['2026-11-01','2026-12-01',false],['2026-02-01','2026-02-30',false],['2028-02-01','2028-02-29',true]]) assert.equal(context.valid(from,to),expected);
assert.match(ui,/readinessToken.*readinessLoading/);
assert.match(ui,/token===readinessToken.*selectedVersion\.versionId===versionId.*readinessFrom\.value===from.*readinessTo\.value===to/);
assert.match(ui,/\['edit','inspect'\]\.includes\(editorAction\?\.kind\)/);
assert.match(ui,/catch\(error\)\{if\(current\(\)\)readinessResult\.textContent/);

// Execute the actual async controller: stale success and errors must not replace
// a later version/period selection, and unrelated payloads must fail closed.
const controllerFixture = () => {
  let finish, reject;
  const calls = [];
  const result = { _html: '', _text: '', get innerHTML() { return this._html; },
    set innerHTML(value) { this._html = value; this._text = ''; },
    get textContent() { return this._text; }, set textContent(value) { this._text = value; this._html = ''; } };
  const state = { selectedVersion:{versionId:'version-1'}, editorAction:{kind:'inspect'},
    readinessFrom:{value:'2026-11-01'}, readinessTo:{value:'2026-11-02'}, readinessToken:0,
    readinessLoading:false, readinessResult:result, refreshReadiness:()=>{},
    sourceReadinessPeriodValid:context.valid, renderSourceReadiness:context.render, URLSearchParams,
    request:path=>{calls.push(path);return new Promise((resolve,rejectPromise)=>{finish=resolve;reject=rejectPromise;});} };
  state.invalidateReadiness=()=>{state.readinessToken++;state.readinessLoading=false;result.innerHTML='selection reset';};
  const sandbox=vm.createContext(state);
  vm.runInContext(extract('    const readinessSavedSelection=', '    const selectedComparisonVersions=')+
    extract('    const runReadiness=', "    readinessRun.addEventListener('click',runReadiness);")+
    '\nglobalThis.run=runReadiness;', sandbox);
  return {state,result,calls,run:()=>sandbox.run(),finish:value=>finish(value),reject:error=>reject(error)};
};
const response=()=>({...payload,versionId:'version-1'});
{
  const f=controllerFixture(); const pending=f.run();
  assert.equal(f.state.readinessLoading,true);
  assert.match(f.calls[0],/versions\/version-1\/source-readiness\?from=2026-11-01&to=2026-11-02/);
  f.finish(response());await pending;
  assert.match(f.result.innerHTML,/Официальный расчёт пока недоступен/);
  assert.equal(f.state.readinessLoading,false);
}
for (const change of [f=>{f.state.selectedVersion={versionId:'version-2'};},
  f=>{f.state.readinessFrom.value='2026-12-01';}, f=>{f.state.readinessTo.value='2026-11-03';},
  f=>{f.state.editorAction={kind:'create'};}, f=>{f.state.readinessToken++;}]) {
  for (const failure of [false,true]) {
    const f=controllerFixture();const pending=f.run();change(f);f.result.innerHTML='new selection';
    if(failure)f.reject(new Error('late failure'));else f.finish(response());
    await pending;assert.equal(f.result.innerHTML,'new selection','late responses cannot overwrite current selection');
  }
}
for (const bad of [{...response(),versionId:'other'}, {...response(),period:{...payload.period,to:'2026-11-03'}},
  {...response(),officialReady:true}, {...response(),components:[]}]) {
  const f=controllerFixture();const pending=f.run();f.finish(bad);await pending;
  assert.match(f.result.textContent,/Не удалось проверить источники:/);
  assert.equal(f.result.innerHTML,'');assert.equal(f.state.readinessLoading,false);
}
for (const change of [f=>{f.state.editorAction={kind:'create'};}, f=>{f.state.selectedVersion=null;},
  f=>{f.state.readinessLoading=true;},f=>{f.state.readinessFrom.value='2026-11-02';}]) {
  const f=controllerFixture();change(f);await f.run();assert.equal(f.calls.length,0);
}
console.log('PAYROLL SOURCE READINESS UI: PASS (actual renderer unknown/missing/invalid metrics, fail-closed payloads, escaping, strict period and executed saved selection/race guards)');
