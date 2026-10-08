import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../app.js',import.meta.url),'utf8');
const adminRule=source.match(/const canOpenStaffAdmin=.*?;/)?.[0];assert.ok(adminRule);
const adminContext={};vm.runInNewContext(adminRule+'this.allowed=canOpenStaffAdmin;',adminContext);
assert.equal(adminContext.allowed(new Set(['orders','floor','bar_tasks'])),false,'orders-only bartender stays work desktop');
for(const permission of ['staff','staff_view','settings','diagnostics','tasks_manage','loyalty'])assert.equal(adminContext.allowed(new Set([permission])),true,'explicit admin section grant exposes link: '+permission);
const start=source.indexOf('const clearStaffAccessState=()=>{');
const end=source.indexOf("document.addEventListener('click',(event)=>{if(event.target.closest('[data-staff-session-retry]'))",start);
assert.ok(start>0&&end>start);
const nodes=new Map();const node=()=>({hidden:false,inert:false,textContent:'',innerHTML:'',classList:{remove(){}},setAttribute(){},removeAttribute(){}});
const status=node(),workspace=node(),nav=node(),order=node(),shift=node();
nodes.set('#staff-session-status',status);nodes.set('#shift-toggle',shift);
let calls=0,refreshes=0,loads=0,applies=0,clears=0;
let payload={user:{id:'staff',venueId:'a'},permissions:['orders','floor']};
let error=null,pending=null,token='real-token';
const events={},intervals=[];
const context={Promise,Set,JSON,Array,Error,clearPreparationQueue(){},loadPreparationQueue(){},
 document:{visibilityState:'visible',querySelector:s=>nodes.get(s),querySelectorAll:s=>s.includes('.portal-sidebar')?[nav]:s.includes('.workspace')?[workspace,order]:[],addEventListener:(type,fn)=>events[type]=fn},
 window:{addEventListener:(type,fn)=>events[type]=fn,setInterval:(fn,ms)=>intervals.push({fn,ms}),location:{replace(){}}},
 localStorage:{getItem:()=>token,setItem(){},removeItem(){}},
 staticStaffDemo:()=>false,staffFetchJson:async()=>{calls++;if(pending)return pending;if(error)throw error;return payload;},
 applyStaffSession:s=>{applies++;context.staffSessionPermissions=new Set(s.permissions);context.staffShiftReadable=s.permissions.includes('orders');},
 applyStaffHeader(){},mountStaffExtensions(){},refreshFloor:()=>refreshes++,loadProducts:()=>loads++,refreshShift(){},
 draw(){},showFloorUnavailable:()=>clears++,catalog:node(),
 staffSessionVerified:false,staffSessionRequest:null,staffAccessRevision:0,staffSessionSignature:'',staffSessionPermissions:new Set(),staffShiftReadable:false,staffShiftManageable:false,staffNotificationCenter:null,
 floorRequestRevision:0,floorRefreshPending:null,shiftRefreshPending:null,ordersRequestRevision:0,orderPricingRevision:0,paymentLoadRevision:0,paymentState:{},products:['old'],catalogState:'ready',currentShift:{},
};
context.staffCanWork=()=>context.staffSessionVerified&&context.staffSessionPermissions.has('orders')&&context.staffSessionPermissions.has('floor');
vm.createContext(context);vm.runInContext(source.slice(start,end)+'\nthis.verify=verifyStaffSession;',context);
assert.equal(intervals[0].ms,30000);
await context.verify();assert.equal(context.staffSessionVerified,true);assert.equal(workspace.hidden,false);assert.equal(refreshes,1);assert.equal(loads,1);
await context.verify();assert.equal(applies,1,'unchanged sessions do not reinstall handlers');assert.equal(refreshes,1,'poll does not reload data');
payload={user:{id:'staff',venueId:'a'},permissions:[]};await context.verify();assert.equal(workspace.hidden,true);assert.equal(order.inert,true);assert.equal(context.paymentState,null);assert.deepEqual([...context.products],[]);assert.equal(context.staffSessionPermissions.size,0);assert.equal(refreshes,1);
payload={user:{id:'staff',venueId:'a'},permissions:['orders','floor']};await context.verify();assert.equal(workspace.hidden,false);assert.equal(refreshes,2);
error=new Error('network');await context.verify();assert.equal(context.staffSessionVerified,false);assert.equal(context.staffSessionPermissions.size,0);assert.equal(nav.hidden,true);assert.equal(order.inert,true);assert.equal(status.hidden,false);
error=null;await context.verify();assert.equal(context.staffSessionVerified,true);assert.equal(refreshes,3);
let resolve;pending=new Promise(r=>resolve=r);const before=calls;const one=context.verify(),two=context.verify();assert.equal(one,two,'single flight');assert.equal(calls,before+1);resolve(payload);await one;pending=null;
const priorApplies=applies;payload={...payload,user:{...payload.user,role:'manager'}};await context.verify();assert.equal(applies,priorApplies+1,'same permissions with changed role refreshes role-dependent presentation');
pending=new Promise((_resolve,reject)=>resolve=reject);const stale=context.verify();token='new-real-token';resolve(Object.assign(new Error('old401'),{status:401}));await stale;pending=null;assert.equal(context.staffSessionVerified,true,'old-token failure cannot clear newer-session state');
documentCheck();
function documentCheck(){assert.ok(events.focus&&events.visibilitychange&&events.storage);assert.ok(clears>=4);assert.match(source,/loyaltyLink\.onclick=/);assert.match(source,/guestsLink\.onclick=.*staffSessionPermissions\.has\('orders'\)/);assert.match(source,/accessRevision!==staffAccessRevision/);assert.match(source,/revision!==staffAccessRevision/);}
console.log('STAFF EFFECTIVE PERMISSIONS QA: PASS (grant/revoke, empty authoritative, failed/recovered session, no duplicate apply, bounded single-flight refresh, sensitive-state invalidation)');
