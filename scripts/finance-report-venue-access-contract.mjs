import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require=createRequire(import.meta.url);
const here=path.dirname(fileURLToPath(import.meta.url));
const {createFinanceReportVenueAccess}=require(path.join(here,'../finance-report-venue-access.js'));
const {createPermissionResolver}=require(path.join(here,'../effective-permissions.js'));
const permissions=createPermissionResolver({
  rolePermissions:{owner:['finance','finance_read'],manager:['finance_read'],bartender:['finance_read']},
  scopedPermissionMap:{finance:['finance','finance_read'],finance_read:['finance_read']},
  normalizePermissionScopes:(value)=>[...new Set((Array.isArray(value)?value:[]).filter((scope)=>['finance','finance_read'].includes(scope)))]
});
let calls=0;let params;
const rows=[
  {id:'11111111-1111-4111-8111-111111111111',name:'Home',timeZone:'Asia/Yekaterinburg',role:'manager',permissionScopes:[],customRoleActive:false,rolePermissionScopes:['finance_read'],rolePermissionOverrideActive:true},
  {id:'22222222-2222-4222-8222-222222222222',name:'Denied',timeZone:'Europe/Moscow',role:'manager',permissionScopes:[],customRoleActive:false,rolePermissionScopes:[],rolePermissionOverrideActive:true},
  {id:'33333333-3333-4333-8333-333333333333',name:'Custom',timeZone:'Europe/Moscow',role:'manager',permissionScopes:[],customRoleId:'role-custom',customRoleActive:true,customRolePermissionScopes:['finance_read'],rolePermissionScopes:['finance_read'],rolePermissionOverrideActive:true},
  {id:'44444444-4444-4444-8444-444444444444',name:'Operational',timeZone:'Europe/Moscow',role:'bartender',permissionScopes:[],rolePermissionScopes:['finance_read'],rolePermissionOverrideActive:true}
];
const access=createFinanceReportVenueAccess({pool:{query:async(sql,values)=>{calls++;params=values;assert.match(sql,/v\.organization_id=\$1 AND v\.is_active=true/);assert.match(sql,/m\.status='active'/);assert.match(sql,/v\.id=\$3/);return{rows:values[2]?rows.filter((row)=>row.id===values[2]):rows};}},resolvePermissions:(user)=>permissions(user).permissions});
const user={id:'staff-1',organizationId:'org-1',venueId:'11111111-1111-4111-8111-111111111111',role:'manager'};
const allowed=await access({user});
assert.deepEqual(allowed.map((venue)=>venue.id),['11111111-1111-4111-8111-111111111111','33333333-3333-4333-8333-333333333333']);
assert.equal(allowed[0].isCurrent,true);assert.equal(allowed[0].permissions.includes('finance_read'),true);
const selected=await access({user,selectedVenueId:'33333333-3333-4333-8333-333333333333'});assert.deepEqual(selected.map((venue)=>venue.id),['33333333-3333-4333-8333-333333333333']);
const before=calls;assert.deepEqual(await access({user,selectedVenueId:'not-a-uuid'}),[]);assert.equal(calls,before,'malformed venue ids do not reach SQL');
assert.deepEqual(params,['org-1','staff-1','33333333-3333-4333-8333-333333333333'],'tenant and actor scopes come from authenticated user, selected venue is only a parameter');
const server=fs.readFileSync(path.join(here,'../server.js'),'utf8');
assert.ok(server.includes('resolveVenues: (request, selectedVenueId) => listFinanceReportVenues')&&server.includes('const selected = selectable.find((item) => String(item.id) === String(selectedVenueId))'),'report and category routes resolve user-selected venues through the server-side access policy');
console.log('FINANCE REPORT VENUE ACCESS CONTRACT: PASS (target role policy, custom venue role, system ceiling, operational-role denial, tenant-scoped query)');
