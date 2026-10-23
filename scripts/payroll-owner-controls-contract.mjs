import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../payroll-scheme-ui.js', import.meta.url), 'utf8');
assert.equal(fs.readFileSync(new URL('../dist/payroll-scheme-ui.js', import.meta.url), 'utf8'), source);
const context = vm.createContext({ structuredClone });
const start = source.indexOf('  const escapeHtml ='), end = source.indexOf('  const venueLocalToday =', start);
vm.runInContext(source.slice(start, end) + '\nglobalThis.h={editorEmployeeOptions,editorDepartmentOptions,editorParameterOptions,editorOptionsHtml,editorStatusLabel,editorRoleLabel,editorApply,editorInheritedCaption,editorOverrideValue};', context);
const h = context.h, plain = value => structuredClone(value);
const staff = [
  { id:'one', name:'Анна', login:'anna.one', role:'bartender', active:true },
  { id:'two', name:'Анна', login:'anna.two', role:'hookah_master', active:false },
  { id:'three', name:'<script>x</script>', role:'custom_role', active:true }
];
const definition = { mode:'stable_percent', effectiveFrom:'2026-10-01', roleParameters:{ bartender:{
  perShiftCents:10000, stableRateBps:1000, department:'old-key', cap:{rateBps:3000, basis:'employee_department_day'},
  bracketRatesBps:{0:1000,100000:1500}, milestoneBonusesCents:{250000:5000}
} }, roleAssignments:[{employeeId:'deleted',roleId:'bartender',effectiveFrom:'2026-10-01'}], employeeOverrides:[], itemRules:[] };
const before = structuredClone({staff,definition});
const employeeOptions = plain(h.editorEmployeeOptions(staff, definition, 'historic'));
assert.deepEqual(employeeOptions.map(row=>row.value), ['one','two','three','deleted','historic']);
assert.match(employeeOptions[0].label, /Анна.*anna.one.*Бармен/);
assert.match(employeeOptions[1].label, /Анна.*anna.two.*Кальянный мастер.*неактивен/);
assert.match(employeeOptions[3].label, /вне справочника.*deleted/);
assert.deepEqual(plain(h.editorEmployeeOptions([], definition, 'historic')).map(row=>row.value), ['deleted','historic'], 'lookup failure preserves identities');
assert.deepEqual({staff,definition}, before, 'labels never mutate source data');
const html = h.editorOptionsHtml(employeeOptions, 'two', 'Выберите сотрудника');
assert.match(html, /value="two" selected/);
assert.ok(!html.includes('<script>'));
assert.match(html, /&lt;script&gt;/);

const departments = [ {code:'bar',name:'Бар',active:true}, {id:'hookah',name:'Кальянная',active:false},
  {code:' bar',name:'Некорректный'}, {code:'bar',name:'Повтор'}, {code:'😀'.repeat(80),name:'Длинный ключ'} ];
const departmentOptions = plain(h.editorDepartmentOptions(departments, 'old-key'));
assert.deepEqual(departmentOptions.map(row=>row.value), ['bar','hookah','😀'.repeat(80),'old-key']);
assert.match(departmentOptions[1].label, /Кальянная.*в архиве/);
assert.match(departmentOptions.at(-1).label, /Сохранённый цех/);
assert.equal(h.editorDepartmentOptions([], '0')[0].value, '0');
assert.equal(h.editorOverrideValue('department', '0'), '0');
assert.throws(()=>h.editorOverrideValue('cap.department', ' bar'));
assert.throws(()=>h.editorOverrideValue('cap.department', '😀'.repeat(81)));
const parameters = plain(h.editorParameterOptions(definition, 'legacy.unknown'));
for (const path of ['department','cap.department','bracketRatesBps.0','bracketRatesBps.100000','milestoneBonusesCents.250000','legacy.unknown']) assert.ok(parameters.some(row=>row.value===path), path);
assert.ok(!parameters.some(row=>row.value==='teamFund.poolId'));
assert.equal(parameters.find(row=>row.value==='cap.department').label, 'Цех лимита (приоритетный)');
assert.match(parameters.find(row=>row.value==='bracketRatesBps.100000').label, /1000.00/);
const personal = { index:null,employeeId:'deleted',path:'cap.department',mode:'override',text:'old-key',effectiveFrom:'2026-10-02',effectiveTo:'2026-10-14' };
const changed = h.editorApply(definition, [], [personal]);
assert.equal(changed.employeeOverrides[0].value, 'old-key');
assert.equal(changed.employeeOverrides[0].employeeId, 'deleted');
const inherited = h.editorApply(changed, [], [{...personal,index:0,mode:'inherit',text:''}]);
assert.equal(inherited.employeeOverrides[0].mode, 'inherit');
assert.ok(!Object.hasOwn(inherited.employeeOverrides[0], 'value'));
assert.throws(()=>h.editorApply(definition, [], [{...personal,path:'legacy.unknown'}]), 'displaying legacy paths never bypasses save validation');
assert.match(h.editorInheritedCaption(definition, personal), /роль: Бармен/);
assert.equal(h.editorStatusLabel('retired'), 'Заменена новой версией');
assert.equal(h.editorStatusLabel('ready'), 'Сценарий рассчитан');
assert.equal(h.editorStatusLabel('blocked'), 'Расчёт заблокирован');
assert.equal(h.editorStatusLabel('future_state'), 'future_state');
assert.equal(h.editorRoleLabel('custom_role'), 'custom_role');
assert.match(source, /if \(sessionUser.role !== 'owner'\) return/);
assert.match(source, /Promise.allSettled\(\[request\('\/api\/staff'\), request\('\/api\/inventory\/departments\?status=all'\)\]\)/);
assert.match(source, /Only refresh labels\/options: never rebuild a dirty editor/);
assert.match(source, /Вернуть к значению роли для этого периода/);
assert.match(source, /<select data-grid-employee>/);
assert.match(source, /<select data-grid-override-path>/);
assert.match(source, /disclosure\(previewInput.closest\('label'\),'Данные пробного сценария — JSON'\)/);
// Exercise the actual asynchronous lookup callback with dirty, unsaved selections.
const lookupStart = source.indexOf("    Promise.allSettled([request('/api/staff')");
const lookupEnd = source.indexOf('    refreshAttendance();', lookupStart);
assert.ok(lookupStart > 0 && lookupEnd > lookupStart);
const employeeControl = { value:'historic', innerHTML:'', _customSelectRefresh() {} };
const departmentControl = { value:'old-key', innerHTML:'', hasAttribute:()=>true, _customSelectRefresh() {} };
let captionRefreshes = 0;
Object.assign(context, { gridSource:definition, gridDirty:true, lookupMessage:{textContent:''},
  grid:{querySelectorAll(selector){ return selector === '[data-grid-employee]' ? [employeeControl] : [departmentControl]; }},
  refreshInheritedCaptions(){captionRefreshes++;}, request:async()=>{throw new Error('forbidden');}
});
await vm.runInContext(source.slice(lookupStart,lookupEnd),context);
assert.equal(context.gridDirty,true);
assert.equal(employeeControl.value,'historic');
assert.match(employeeControl.innerHTML,/value="historic" selected/);
assert.match(departmentControl.innerHTML,/value="old-key" selected/);
assert.match(context.lookupMessage.textContent,/сотрудников недоступен.*цехов недоступен/);
assert.equal(captionRefreshes,1);
context.request=async url=>({items:url==='/api/staff'?[null,...staff]:[null,...departments]});
await vm.runInContext(source.slice(lookupStart,lookupEnd),context);
assert.equal(employeeControl.value,'historic');
assert.equal(departmentControl.value,'old-key');
assert.equal(context.gridDirty,true);
assert.match(employeeControl.innerHTML,/Анна.*anna.one/);
assert.match(departmentControl.innerHTML,/Кальянная/);
assert.ok(!context.lookupMessage.textContent.includes('недоступен'));
assert.equal(captionRefreshes,2);
console.log('PASS payroll owner controls: exact identities, duplicate/inactive/missing staff, catalog fallback, dynamic/legacy paths, inheritance, strict keys, Russian labels, escaping and published parity');
