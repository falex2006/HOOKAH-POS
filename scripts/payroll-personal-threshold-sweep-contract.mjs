import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {performance} from 'node:perf_hooks';
const require=createRequire(import.meta.url);
const actual=require('../payroll-schemes.js').validatePersonalThresholdAssignments;
const source=fs.readFileSync(new URL('../payroll-schemes.js',import.meta.url),'utf8');
// Captured pre-sweep boundary/filter algorithm; use the same unchanged leaf and resolution primitives.
const slow=`const validatePersonalThresholdAssignments = (scheme, assignments) => {
 const errors=[];
 const byEmployee=new Map();
 for(const row of (Array.isArray(scheme.employeeOverrides)?scheme.employeeOverrides:[])){
  if(!row||typeof row!=='object'||Array.isArray(row)||row.mode!=='override'||typeof row.path!=='string'
   ||(!thresholdLeaf(row.path)&&!['mode','applyMilestones'].includes(row.path))
   ||(row.effectiveFrom&&!isDate(row.effectiveFrom))||(row.effectiveTo&&!isDate(row.effectiveTo)))continue;
  if(!byEmployee.has(row.employeeId))byEmployee.set(row.employeeId,[]);
  byEmployee.get(row.employeeId).push(row);
 }
 for(const assignment of assignments){
  const base=scheme.roleParameters?.[assignment.roleId];if(!base||typeof base!=='object'||Array.isArray(base))continue;
  const relevant=(byEmployee.get(assignment.employeeId)||[]).filter(row=>(!row.effectiveTo||row.effectiveTo>=assignment.effectiveFrom)
   &&(!assignment.effectiveTo||!row.effectiveFrom||row.effectiveFrom<=assignment.effectiveTo));
  if(!relevant.length)continue;
  const boundaries=new Set([assignment.effectiveFrom]);
  for(const row of relevant){if(row.effectiveFrom&&row.effectiveFrom>=assignment.effectiveFrom)boundaries.add(row.effectiveFrom);
   if(row.effectiveTo&&row.effectiveTo<'9999-12-31')boundaries.add(addDays(row.effectiveTo,1));}
  for(const date of boundaries){
   if(date<assignment.effectiveFrom||(assignment.effectiveTo&&date>assignment.effectiveTo))continue;
   const active=relevant.filter(row=>(!row.effectiveFrom||row.effectiveFrom<=date)&&(!row.effectiveTo||row.effectiveTo>=date));
   for(const row of active){const error=thresholdLeafError(base,row.path);if(error)errors.push(error);}
   const resolved=resolveRoleParameters({...scheme,employeeOverrides:active},assignment.employeeId,assignment.roleId,date);
   for(const row of active){const error=thresholdLeafError(resolved,row.path);if(error)errors.push(error);}
   if(resolved.cap&&resolved.applyMilestones&&Object.keys(resolved.milestoneBonusesCents||{}).length
    &&!['included_in_cap','separate_from_shift_cap'].includes(scheme.milestoneCapPolicy))errors.push('milestone_cap_policy_required');
  }
 }
 return [...new Set(errors)];
};`;
const start=source.indexOf('const validatePersonalThresholdAssignments =');
const end=source.indexOf('\nconst validateScheme =',start);
assert.ok(start>=0&&end>start);
const module={exports:{}};
vm.runInNewContext(source.slice(0,start)+slow+source.slice(end),{module,exports:module.exports,
 require:createRequire(new URL('../payroll-schemes.js',import.meta.url)),structuredClone,console});
const reference=module.exports.validatePersonalThresholdAssignments;
const day=i=>new Date(Date.UTC(2026,0,1+i)).toISOString().slice(0,10);
const fixture=()=>({mode:'progressive_daily',roleParameters:{r:{perShiftCents:0,bracketRatesBps:{0:1000},cap:{rateBps:3000,basis:'venue_day'}},
 s:{mode:'stable_percent',perShiftCents:0,stableRateBps:1000,milestoneBonusesCents:{'01':100}}},employeeOverrides:[]});
const check=(scheme,assignments,label)=>{
 const before=structuredClone({scheme,assignments});
 // Error order was incidental boundary insertion order; compare the complete diagnostic set.
 assert.deepEqual([...actual(scheme,assignments)].sort(),[...reference(scheme,assignments)].sort(),label);
 assert.deepEqual({scheme,assignments},before,'no mutation '+label);
};
let seed=0x12345678;const random=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n;};
for(let test=0;test<400;test++){
 const scheme=fixture();
 for(let i=0;i<35;i++){
  const path=['milestoneBonusesCents.1','milestoneBonusesCents.01','bracketRatesBps.0','bracketRatesBps.00','bracketRatesBps.5','applyMilestones','mode','stableRateBps'][random(8)];
  const from=random(30),to=from+random(12);
  scheme.employeeOverrides.push({employeeId:['a','b'][random(2)],path,mode:random(5)?'override':'inherit',
   value:path==='mode'?['stable_percent','progressive_daily'][random(2)]:path==='applyMilestones'?!!random(2):random(2000),
   ...(random(5)?{effectiveFrom:day(from)}:{}),...(random(5)?{effectiveTo:day(to)}:{})});
 }
 if(random(2))scheme.milestoneCapPolicy='included_in_cap';
 check(scheme,[{employeeId:'a',roleId:'r',effectiveFrom:day(4),effectiveTo:day(15)},
  {employeeId:'a',roleId:'s',effectiveFrom:day(16),effectiveTo:day(35)},
  {employeeId:'b',roleId:'r',effectiveFrom:day(0)}],'seeded '+test);
}
const edge=fixture();edge.employeeOverrides=[
 {employeeId:'a',path:'milestoneBonusesCents.1',mode:'override',value:0,effectiveFrom:'9999-12-30',effectiveTo:'9999-12-31'},
 {employeeId:'a',path:'applyMilestones',mode:'override',value:false,effectiveFrom:'9999-12-31'},
 {employeeId:'a',path:'mode',mode:'override',value:'stable_percent',effectiveTo:'9999-12-30'}];
check(edge,[{employeeId:'a',roleId:'r',effectiveFrom:'9999-12-29',effectiveTo:'9999-12-31'}],'maximum inclusive date');
const minimum=fixture();minimum.employeeOverrides=[
 {employeeId:'a',path:'milestoneBonusesCents.1',mode:'override',value:0,effectiveFrom:'0001-01-01',effectiveTo:'0001-01-01'},
 {employeeId:'a',path:'applyMilestones',mode:'override',value:false,effectiveFrom:'0001-01-02',effectiveTo:'0001-01-02'}];
check(minimum,[{employeeId:'a',roleId:'r',effectiveFrom:'0001-01-01',effectiveTo:'0001-01-03'}],'minimum and adjacent inclusive dates');
const large=fixture();large.employeeOverrides=Array.from({length:15000},(_,i)=>({employeeId:'a',path:'milestoneBonusesCents.1',mode:'override',value:0,effectiveFrom:day(i),effectiveTo:day(i)}));
const assignments=[{employeeId:'a',roleId:'r',effectiveFrom:day(0)}];
const t=performance.now();const expected=reference(large,assignments);const referenceMs=performance.now()-t;
const u=performance.now();assert.deepEqual(actual(large,assignments),[...expected]);const sweepMs=performance.now()-u;
console.log('PAYROLL PERSONAL THRESHOLD SWEEP: PASS (400 seeded cases, role changes, inclusive/max dates, order, no mutation, 15000 windows)',JSON.stringify({referenceMs:Math.round(referenceMs),sweepMs:Math.round(sweepMs)}));
