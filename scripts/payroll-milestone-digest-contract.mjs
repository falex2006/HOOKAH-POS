import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
const source=readFileSync(new URL('../payroll-scheme-service.js',import.meta.url),'utf8');
const start=source.indexOf('const canonicalJson ='),end=source.indexOf('const personalCapExceptions =',start);
assert(start>=0&&end>start);
const digest=vm.runInNewContext(source.slice(start,end)+'\npayoutConfigurationDigest;', {createHash,fail:code=>{throw new TypeError(code);}});
// Frozen independent legacy payload: optional scheme eligibility did not exist.
const canonical=value=>Array.isArray(value)?`[${value.map(canonical).join(',')}]`:value&&typeof value==='object'
 ?`{${Object.keys(value).sort().filter(k=>value[k]!==undefined).map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')}}`:JSON.stringify(value);
const legacy=d=>{
 const sort=rows=>rows.map(canonical).sort().map(JSON.parse);
 const config={mode:d.mode,currency:d.currency,effectiveFrom:d.effectiveFrom,effectiveTo:d.effectiveTo,roleParameters:d.roleParameters,
  applyMilestones:d.applyMilestones,milestoneCapPolicy:d.milestoneCapPolicy,sourcePolicies:d.sourcePolicies,
  roleAssignments:sort(d.roleAssignments.map(r=>({employeeId:String(r.employeeId).toLowerCase(),roleId:r.roleId,effectiveFrom:r.effectiveFrom,effectiveTo:r.effectiveTo||null}))),
  employeeOverrides:sort(d.employeeOverrides.map(r=>({employeeId:String(r.employeeId).toLowerCase(),path:r.path,mode:r.mode,value:r.mode==='override'?r.value:undefined,effectiveFrom:r.effectiveFrom??d.effectiveFrom,effectiveTo:r.effectiveTo??d.effectiveTo}))),
  itemRules:sort(d.itemRules.map(r=>({menuItemId:String(r.menuItemId).toLowerCase(),roleId:r.roleId||null,employeeId:r.employeeId?String(r.employeeId).toLowerCase():null,mode:r.mode,rateBps:r.rateBps,priority:r.priority??0})))};
 return createHash('sha256').update(canonical(config)).digest('hex');
};
const a='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',b='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const fixture=()=>({mode:'stable_percent',currency:'RUB',effectiveFrom:'2026-10-01',effectiveTo:'2026-10-31',applyMilestones:false,
 roleParameters:{bar:{perShiftCents:0,stableRateBps:1000}},roleAssignments:[{employeeId:a,roleId:'bar',effectiveFrom:'2026-10-01'},{employeeId:b,roleId:'bar',effectiveFrom:'2026-10-01'}],
 employeeOverrides:[{employeeId:a,path:'applyMilestones',mode:'override',value:false},{employeeId:b,path:'stableRateBps',mode:'inherit'}],itemRules:[{menuItemId:a,employeeId:b,mode:'additive',rateBps:0}]});
const tests=[
 ['legacy omission exact digest',()=>{for(const d of [fixture(),{...fixture(),milestoneEligibility:undefined}])assert.equal(digest(d),legacy(d));}],
 ['scheme eligibility changes digest',()=>{const d=fixture(),all={...d,milestoneEligibility:'all_active'},worked={...d,milestoneEligibility:'worked_on_threshold_day'};assert.notEqual(digest(all),digest(d));assert.notEqual(digest(worked),digest(d));assert.notEqual(digest(all),digest(worked));}],
 ['permutations and full UUID normalization',()=>{const d=fixture(),x=structuredClone(d);x.roleAssignments.reverse();x.employeeOverrides.reverse();for(const r of [...x.roleAssignments,...x.employeeOverrides])r.employeeId=r.employeeId.toUpperCase();x.itemRules[0].menuItemId=a.toUpperCase();x.itemRules[0].employeeId=b.toUpperCase();assert.equal(digest(x),digest(d));}],
 ['explicit windows equivalent defaults',()=>{const d=fixture(),x=structuredClone(d);for(const r of x.employeeOverrides){r.effectiveFrom=d.effectiveFrom;r.effectiveTo=d.effectiveTo;}assert.equal(digest(x),digest(d));x.employeeOverrides[0].effectiveTo='2026-10-30';assert.notEqual(digest(x),digest(d));}],
 ['inherit ignores stale value, false stays explicit',()=>{const d=fixture(),x=structuredClone(d);x.employeeOverrides[1].value=999;assert.equal(digest(x),digest(d));x.employeeOverrides[0].value=true;assert.notEqual(digest(x),digest(d));}],
 ['role and personal eligibility already hashed',()=>{const d=fixture(),r=structuredClone(d),p=structuredClone(d);r.roleParameters.bar.milestoneEligibility='all_active';p.employeeOverrides.push({employeeId:a,path:'milestoneEligibility',mode:'override',value:'all_active'});assert.notEqual(digest(r),digest(d));assert.notEqual(digest(p),digest(d));p.employeeOverrides.at(-1).effectiveFrom='2026-10-02';assert.notEqual(digest(p),digest({...d,employeeOverrides:[...d.employeeOverrides,{employeeId:a,path:'milestoneEligibility',mode:'override',value:'all_active'}]}));}],
 ['no input mutation',()=>{const d={...fixture(),milestoneEligibility:'worked_on_threshold_day'},before=structuredClone(d);digest(d);assert.deepEqual(d,before);}],
 ['configuration requires storage capability',()=>{const from=source.indexOf('const requireMilestoneConfigurationSchema ='),to=source.indexOf('const assertOwner =',from),guard=source.slice(from,to);assert.match(guard,/definition\.milestoneEligibility === undefined/);assert.match(guard,/params\.milestoneEligibility !== undefined/);assert.match(guard,/row\.path === 'milestoneEligibility'/);assert.match(guard,/to_regclass\('payroll_milestone_day_snapshots'\)/);assert.match(guard,/fail\('payroll_milestone_eligibility_schema_required', 409\)/);}]
];
const failed=[];for(const [name,test]of tests){try{test();console.log('PASS '+name);}catch(e){failed.push(name);console.error('FAIL '+name+': '+e.message);}}
assert.deepEqual(failed,[],'optional eligibility digest must be distinct and pre089 configuration rejected');
console.log('PAYROLL MILESTONE DIGEST: PASS (legacy compatibility, optional payload and storage capability gate)');
