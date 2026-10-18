import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../portal-session.js',import.meta.url),'utf8');
assert.equal(source.includes('\uFFFD'),false,'UI source must not contain Unicode replacement characters');
function harness() {
 const scripts=[],timers=new Map(),storage=new Map([['crm_session_token','token']]);let timerId=0,guard=null,reloads=0,status=200,now=1000,calls=0,retryAfter='3',deferred=null;const listeners={};
 const session={user:{id:'owner',role:'owner',venueId:'venue'},permissions:['inventory_read']};
 const document={documentElement:{dataset:{}},hidden:false,addEventListener(){},getElementById(){return guard;},createElement(tag){if(tag==='script')return {};const controls={};return {setAttribute(){},querySelector(key){return controls[key]||=( {} );},remove(){guard=null;}};},body:{append(node){guard=node;}},head:{append(node){scripts.push(node);}}};
 const window={location:{origin:'http://local',pathname:'/inventory',hash:'',reload(){reloads++;},replace(){}},addEventListener(event,fn){listeners[event]=fn;}};
 const context={document,window,localStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},URL,AbortController,Date:{now:()=>now},setInterval(fn){listeners.poll=fn;},setTimeout(fn,ms){const id=++timerId;timers.set(id,{fn,ms});return id;},clearTimeout(id){timers.delete(id);},fetch:async()=>{calls++;if(deferred)await deferred;return {status,ok:status===200,headers:{get:()=>retryAfter},json:async()=>JSON.parse(JSON.stringify(session))};}};
 vm.runInNewContext(source,context);
 return {window,scripts,timers,session,document,storage,listeners,get calls(){return calls;},set deferred(value){deferred=value;},set retryAfter(value){retryAfter=value;},advance(ms){now+=ms;},get reloads(){return reloads;},set status(value){status=value;},get guard(){return guard;}};
}
const settle=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
{
 const h=harness();await settle();assert.equal(h.scripts.length,1);
 const deadline=[...h.timers.values()].find(t=>t.ms===15000);assert.ok(deadline);deadline.fn();
 assert.equal(h.window.__portalSessionGate.blocked,true);assert.equal(h.guard.querySelector('[data-session-retry]').hidden,false);
 h.scripts[0].onload();assert.equal(h.window.__portalSessionGate.blocked,true,'late load must not bypass timeout guard');
 await h.window.__portalSessionGate.refresh();assert.equal(h.reloads,1);assert.equal(h.scripts.length,1,'retry never inserts duplicate classic script');
 assert.equal(h.guard.querySelector('[data-session-message]').textContent,'Повторно загружаем интерфейс…');
}
{
 const h=harness();await settle();h.scripts[0].onerror();await h.window.__portalSessionGate.refresh();assert.equal(h.reloads,1);assert.equal(h.scripts.length,1);
}
{
 const h=harness();await settle();h.scripts[0].onload();assert.equal(h.guard,null);
 h.document.unsavedInput='draft';h.status=503;await h.window.__portalSessionGate.refresh();assert.equal(h.window.__portalSessionGate.blocked,true);
 h.status=200;await h.window.__portalSessionGate.refresh();assert.equal(h.window.__portalSessionGate.blocked,false);assert.equal(h.guard,null);assert.equal(h.reloads,0);assert.equal(h.document.unsavedInput,'draft');assert.equal(h.scripts.length,1);
 h.session.permissions=[];await h.window.__portalSessionGate.refresh();assert.equal(h.reloads,1,'changed access still requires fresh authorized workspace');assert.equal(h.window.__portalSessionGate.blocked,true);
}
console.log('PORTAL SESSION LOAD QA: PASS (load deadline/error retry, no duplicate script, late-load guard, transient recovery preserves document, changed permissions reload)');

{
 const h=harness();await settle();h.scripts[0].onload();h.status=503;await h.window.__portalSessionGate.refresh();
 let release;h.deferred=new Promise(resolve=>{release=resolve;});h.status=200;
 const retry=h.window.__portalSessionGate.refresh();
 assert.equal(h.guard.querySelector('[data-session-retry]').textContent,'Повторяем…');
 assert.equal(h.guard.querySelector('[data-session-retry]').disabled,true);
 const count=h.calls;h.listeners.focus();h.listeners.poll();assert.equal(h.calls,count,'pending retry is deduplicated');
 release();await retry;assert.equal(h.guard,null);assert.equal(h.storage.get('crm_session_token'),'token');
}
{
 const h=harness();await settle();h.scripts[0].onload();h.status=429;await h.window.__portalSessionGate.refresh();
 const count=h.calls;
 assert.equal(h.guard.querySelector('[data-session-message]').textContent,'Слишком много запросов. Повтор через 3 с.');
 assert.equal(h.guard.querySelector('[data-session-retry]').disabled,true);
 h.listeners.focus();h.listeners.poll();await h.window.__portalSessionGate.refresh();assert.equal(h.calls,count,'cooldown prevents manual/focus/poll fetch');
 assert.equal(h.storage.get('crm_session_token'),'token');
 h.status=200;h.advance(3000);
 const tick=[...h.timers.values()].find(t=>t.ms===1000);assert.ok(tick);tick.fn();await settle();
 assert.equal(h.calls,count+1,'cooldown automatically retries once');assert.equal(h.guard,null);assert.equal(h.storage.get('crm_session_token'),'token');
}
{
 const h=harness();await settle();h.status=429;h.retryAfter=null;await h.window.__portalSessionGate.refresh();
 assert.match(h.guard.querySelector('[data-session-message]').textContent,/30 с/,'missing retry-after uses a bounded default delay');
}
console.log('PORTAL SESSION RATE QA: PASS (visible pending, deduplicated retries, Retry-After cooldown, automatic recovery, token retained)');
