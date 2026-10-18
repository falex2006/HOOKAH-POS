import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../portal-session.js',import.meta.url),'utf8');
assert.equal(source.includes('\uFFFD'),false,'UI source must not contain Unicode replacement characters');
function harness() {
 const scripts=[],timers=new Map(),storage=new Map([['crm_session_token','token']]);let timerId=0,guard=null,reloads=0,status=200;
 const session={user:{id:'owner',role:'owner',venueId:'venue'},permissions:['inventory_read']};
 const document={documentElement:{dataset:{}},hidden:false,addEventListener(){},getElementById(){return guard;},createElement(tag){if(tag==='script')return {};const controls={};return {setAttribute(){},querySelector(key){return controls[key]||=( {} );},remove(){guard=null;}};},body:{append(node){guard=node;}},head:{append(node){scripts.push(node);}}};
 const window={location:{origin:'http://local',pathname:'/inventory',hash:'',reload(){reloads++;},replace(){}},addEventListener(){}};
 const context={document,window,localStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},URL,AbortController,setInterval(){},setTimeout(fn,ms){const id=++timerId;timers.set(id,{fn,ms});return id;},clearTimeout(id){timers.delete(id);},fetch:async()=>({status,ok:status===200,json:async()=>JSON.parse(JSON.stringify(session))})};
 vm.runInNewContext(source,context);
 return {window,scripts,timers,session,document,get reloads(){return reloads;},set status(value){status=value;},get guard(){return guard;}};
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

