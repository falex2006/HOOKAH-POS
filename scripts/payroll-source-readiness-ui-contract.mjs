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
const keys = ['sourcePolicies','approvedAttendance','orderObservations','refundObservations','canonicalLinePricing','payrollSaleCredit','recognizedLineRefunds','fullEmployeeNetRevenue','marginCosts','departmentShiftAllocation'];
const payload = {schemaVersion:1, officialReady:false, period:{from:'2026-11-01',to:'2026-11-02',timezone:'<img src=x onerror=bad>'},
  components:Object.fromEntries(keys.map(key=>[key,{status:'unsupported',reasons:['<script>bad</script>']}]))};
payload.components.refundObservations.eventCount=null;
payload.components.orderObservations={status:'available',reasons:[],closedOrderCount:0};
const html=context.render(payload);
assert.match(html,/Официальный расчёт пока недоступен/);
assert.match(html,/Неизвестно — источник не подключён/);
assert.match(html,/нулевые значения не разрешают официальный расчёт/);
assert.match(html,/&lt;script&gt;/);
assert.doesNotMatch(html,/<script>|<img src=x/);
assert.throws(()=>context.render({...payload,officialReady:true}));
assert.throws(()=>context.render({...payload,components:{}}));
for (const status of ['constructor','__proto__']) assert.throws(()=>context.render({...payload,components:{...payload.components,sourcePolicies:{status,reasons:[]}}}));
for(const [from,to,expected] of [['2026-11-01','2026-11-30',true],['2026-11-02','2026-11-30',false],['2026-11-01','2026-12-01',false],['2026-02-01','2026-02-30',false],['2028-02-01','2028-02-29',true]]) assert.equal(context.valid(from,to),expected);
assert.match(ui,/readinessToken.*readinessLoading/);
assert.match(ui,/token===readinessToken.*selectedVersion\.versionId===versionId.*readinessFrom\.value===from.*readinessTo\.value===to/);
assert.match(ui,/\['edit','inspect'\]\.includes\(editorAction\?\.kind\)/);
assert.match(ui,/catch\(error\)\{if\(current\(\)\)readinessResult\.textContent/);
console.log('PAYROLL SOURCE READINESS UI: PASS (actual renderer escaping, unknown counts, strict period and saved selection/race guards)');
