const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const src=fs.readFileSync('portal.js','utf8');
let badge=null;const attrs={};
const link={dataset:{},querySelector:()=>badge,append:b=>badge=b,removeAttribute:k=>delete attrs[k]};
const element=()=>({textContent:'',hidden:false,setAttribute(k,v){this[k]=v;},remove(){badge=null;}});
const bell=element(),counter=element(),label=element(),all=element();
const context={document:{querySelectorAll:()=>[link],createElement:element},notificationBadge:counter,notificationBell:bell,notificationCountLabel:label,notificationPanel:{querySelector:()=>all},notificationPageActive:()=>null};
vm.createContext(context);
const start=src.indexOf('let notificationCountRevision = 0;'),end=src.indexOf('const renderNotificationState',start);
vm.runInContext(src.slice(start,end)+'\nthis.update=updateNotificationCount;this.revision=()=>notificationCountRevision;',context);
context.update(1);assert.equal(badge.textContent,'1');assert.equal(counter.hidden,false);
context.update(0);assert.equal(badge,null);assert.equal(counter.hidden,true);assert.equal(label.textContent,'Все просмотрено');assert.equal(all.hidden,true);
context.update(123);assert.equal(badge.textContent,'99+');assert.equal(counter.textContent,'99+');assert.equal(context.revision(),3);
assert(src.includes("notifications.status === 'fulfilled' && countRevision === notificationCountRevision"));
assert(src.includes('if (countRevision !== notificationCountRevision) { notificationRefreshQueued = true; return; }'));
console.log('Notification count fanout PASS (1 -> 0 -> 123); GET guard source checks PASS');
// Execute the actual asynchronous list loader with a delayed pre-read response.
(async()=>{
  const pending=[];let rendered=0;
  const fixture={...context,notificationBusy:false,notificationRefreshQueued:false,notificationObserverDisposed:false,notificationFilter:'all',notificationData:{items:[],unreadCount:0},renderNotifications:()=>rendered++,renderNotificationState:()=>{},api:()=>new Promise(resolve=>pending.push(resolve))};
  vm.createContext(fixture);
  const loadStart=src.indexOf('const loadNotifications = async'),loadEnd=src.indexOf('const notificationChannel =',loadStart);
  vm.runInContext(src.slice(start,end)+src.slice(loadStart,loadEnd)+'\nthis.load=loadNotifications;this.update=updateNotificationCount;',fixture);
  const oldRequest=fixture.load();assert.equal(pending.length,1);
  fixture.update(0); // A successful read occurs after the GET started.
  pending.shift()({items:[{id:'old',readAt:null}],unreadCount:1});
  await oldRequest;
  assert.equal(pending.length,1,'stale response queues one fresh GET');
  assert.equal(badge,null,'old count must not revive sidebar badge');
  assert.equal(rendered,0,'stale items must not render');
  pending.shift()({items:[{id:'old',readAt:'2026-10-21'}],unreadCount:0});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(rendered,1);assert.equal(fixture.notificationBusy,false);assert.equal(pending.length,0);
  assert.equal(fixture.notificationData.items[0].readAt,'2026-10-21');
  console.log('Notification stale GET runtime PASS (ignored stale payload, one retry, no loop)');
})().catch(error=>{console.error(error);process.exitCode=1;});
