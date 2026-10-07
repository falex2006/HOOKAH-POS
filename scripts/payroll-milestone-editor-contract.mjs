import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../payroll-scheme-ui.js',import.meta.url),'utf8');
const start=source.indexOf('  const EDITOR_MODES ='),end=source.indexOf('  const venueLocalToday =',start);
assert.ok(start>0&&end>start);
const context={structuredClone};vm.createContext(context);
vm.runInContext(source.slice(start,end)+'\nglobalThis.helpers={editorApply,editorApplyMilestoneEligibility,editorOverrideValue,editorInheritedParameter,editorInheritedCaption};',context);
const {editorApply:apply,editorApplyMilestoneEligibility:applyScheme,editorOverrideValue:value,editorInheritedParameter:inherited,editorInheritedCaption:caption}=context.helpers;
const definition={mode:'stable_percent',effectiveFrom:'2026-10-01',effectiveTo:'2026-10-31',roleParameters:{bar:{stableRateBps:1000,perShiftCents:0}},
 roleAssignments:[{employeeId:'employee',roleId:'bar',effectiveFrom:'2026-10-01',effectiveTo:'2026-10-31'}],employeeOverrides:[]};
const item={employeeId:'employee',path:'milestoneEligibility',mode:'inherit',effectiveFrom:'2026-10-02'};
assert.equal(inherited(definition,item).value,'all_active','omission inherits the exact legacy eligibility rule');
const scheme={...structuredClone(definition),milestoneEligibility:'worked_on_threshold_day'};
const original=structuredClone(scheme),omitted=applyScheme(scheme,'');
assert.equal(Object.hasOwn(omitted,'milestoneEligibility'),false,'blank scheme control preserves omission');
assert.deepEqual(scheme,original,'scheme editor never mutates its input');
assert.notEqual(omitted.roleParameters,scheme.roleParameters,'scheme edit is detached');
for(const policy of ['all_active','worked_on_threshold_day'])assert.equal(applyScheme(definition,policy).milestoneEligibility,policy);
for(const invalid of ['guess',null,false,0]){
 assert.throws(()=>applyScheme(definition,invalid));
 assert.throws(()=>apply(definition,[{role:'bar',path:'milestoneEligibility',type:'text',text:invalid}],[]));
}
assert.equal(inherited(scheme,item).value,'worked_on_threshold_day');assert.equal(inherited(scheme,item).origin,'scheme');
const role=structuredClone(scheme);role.roleParameters.bar.milestoneEligibility='all_active';
assert.equal(inherited(role,item).value,'all_active');assert.equal(inherited(role,item).origin,'role');
for(const policy of ['all_active','worked_on_threshold_day']){
 assert.equal(value('milestoneEligibility',policy),policy);
 const edit={index:null,employeeId:'employee',path:'milestoneEligibility',mode:'override',text:policy,effectiveFrom:'2026-10-02',effectiveTo:'2026-10-14'};
 const before=structuredClone(scheme),changed=apply(scheme,[],[edit]);assert.deepEqual(scheme,before);
 assert.equal(changed.employeeOverrides[0].value,policy);assert.equal(changed.employeeOverrides[0].effectiveTo,'2026-10-14');
 const reset=apply(changed,[],[{...edit,index:0,mode:'inherit',text:''}]);assert.equal(reset.employeeOverrides[0].mode,'inherit');assert.equal(Object.hasOwn(reset.employeeOverrides[0],'value'),false);
}
for(const text of ['worked','false','null','0',''])assert.throws(()=>value('milestoneEligibility',text));
const edited=inherited(role,item,[{role:'bar',path:'milestoneEligibility',type:'text',text:''}]);assert.equal(edited.value,'worked_on_threshold_day');assert.equal(edited.origin,'scheme');
assert.match(caption(role,item),/активн/i);assert.match(caption(scheme,item),/работ|отработ/i);assert.match(caption(scheme,item),/схема/);
assert.match(source,/data-grid-scheme-milestone-eligibility/,'typed scheme control must exist');
console.log('PAYROLL MILESTONE EDITOR: PASS (scheme/role/default inheritance, dated personal override/inherit, strict enum and detached edits)');
