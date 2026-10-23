const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync('portal.js','utf8');
const start=source.indexOf('let notificationMutationQueue ='),end=source.indexOf('const closeNotificationPanel',start);
const pending=[],counts=[];
const context={api:(url)=>new Promise((resolve,reject)=>pending.push({url,resolve,reject})),notificationData:{items:[{id:'a'},{id:'b'}],unreadCount:2},updateNotificationCount:n=>counts.push(n),renderNotifications:()=>{},notificationChannel:null};
vm.createContext(context);vm.runInContext(source.slice(start,end)+';this.read=setNotificationRead;this.queue=queueNotificationMutation;',context);
const tick=()=>new Promise(resolve=>setImmediate(resolve));
(async()=>{
 const a=context.read('a'),b=context.read('b');await tick();assert.equal(pending.length,1);
 pending[0].resolve({unreadCount:1,readAt:'now'});await a;await tick();assert.equal(pending.length,2);
 pending[1].resolve({unreadCount:0,readAt:'now'});await b;assert.deepEqual(counts,[1,0]);
 const failed=context.read('bad');const rejection=assert.rejects(failed,/offline/);const next=context.read('next');await tick();pending[2].reject(new Error('offline'));await rejection;await tick();assert.equal(pending.length,4);
 pending[3].resolve({unreadCount:0});await next;assert.equal(counts.at(-1),0);
 assert(source.includes("try { await queueNotificationMutation(async () => { const result = await api('/api/notifications', { method: 'POST' });"));
 console.log('Notification mutation queue PASS: serial requests/state, rejection propagation, recovery; read-all binding source checked');
})().catch(error=>{console.error(error);process.exitCode=1;});
// Exercise the actual read-all click callback together with individual mutations.
(async()=>{
 const requests=[],values=[],errors=[];let click;
 const button={disabled:false,addEventListener:(_,fn)=>click=fn};
 const fixture={api:(url,options)=>new Promise((resolve,reject)=>requests.push({url,options,resolve,reject})),notificationData:{items:[{id:'x'},{id:'y'}],unreadCount:2},updateNotificationCount:n=>values.push(n),renderNotifications:()=>{},renderNotificationState:(...args)=>errors.push(args),notificationChannel:null,notificationPanel:{querySelector:()=>button,querySelectorAll:()=>[]}};
 vm.createContext(fixture);
 const handlerStart=source.indexOf('const bindNotificationControls =');
 const handlerEnd=source.indexOf("notificationBell?.setAttribute",handlerStart);
 assert(handlerStart>=0&&handlerEnd>handlerStart);
 vm.runInContext(source.slice(start,end)+source.slice(handlerStart,handlerEnd)+';this.read=setNotificationRead;',fixture);
 const first=fixture.read('x');const rejected=assert.rejects(first,/offline/);
 const all=click({currentTarget:button});assert.equal(button.disabled,true);
 await tick();assert.equal(requests.length,1);
 requests[0].reject(new Error('offline'));await rejected;await tick();
 assert.equal(requests.length,2);assert.equal(requests[1].url,'/api/notifications');assert.equal(requests[1].options.method,'POST');
 requests[1].resolve({unreadCount:0});await all;
 assert.deepEqual(values,[0]);assert(fixture.notificationData.items.every(x=>x.readAt));assert.equal(button.disabled,false);
 const failAll=click({currentTarget:button});await tick();requests[2].reject(new Error('offline'));await failAll;
 assert.equal(errors.length,1);assert.equal(button.disabled,false);assert.deepEqual(values,[0]);
 console.log('Notification read-all runtime PASS: single failure then bulk success, bulk failure preserves count and enables retry');
})().catch(error=>{console.error(error);process.exitCode=1;});
