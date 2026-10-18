import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../portal.js',import.meta.url),'utf8');
const start=source.indexOf('const api =');const end=source.indexOf('window.__crmApi =',start);
assert.ok(start>0&&end>start);
const make=new Function('fetch','window','localStorage','staticDemo','demoJson','portalNotificationCenter',`localStorage.getItem ||= (()=>'token');window.fetch=fetch;const disposeNotificationObserver=()=>portalNotificationCenter?.dispose?.();const authHeaders=()=>({});${source.slice(start,end)}return api;`);
for(const deniedStorage of [false,true]) {
 const removed=[],window={location:{href:'/network'}};let success=false;
 let disposed=0;
 const api=make(async()=>({status:401}),window,{removeItem:key=>{if(deniedStorage)throw Error('storage unavailable');removed.push(key);}},()=>false,undefined,{dispose(){disposed++;}});
 await assert.rejects(api('/api/network/venues/test/select').then(()=>success=true),error=>error.status===401&&error.payload.error==='authentication_required');
 assert.equal(success,false);assert.equal(window.location.href,'/login');assert.equal(disposed,1,'401 stops the notification observer before leaving the session');
 if(!deniedStorage)assert.deepEqual(removed,['crm_session_token','crm_session_user']);
}
const api=make(async()=>({status:200,ok:true,json:async()=>({items:[]})}),{location:{}},{},()=>false);
assert.deepEqual(await api('/api/network/venues'),{items:[]});
const denied=make(async()=>({status:403,ok:false,json:async()=>({error:'forbidden'})}),{location:{}},{},()=>false);
await assert.rejects(denied('/api/network/venues'),error=>error.payload.error==='forbidden');
assert.equal(await make(()=>{throw Error('demo must not fetch');},{},{},()=>true,async()=> 'demo')('/api/network/venues'),'demo');
let currentToken='old',resolveStale;const removedStale=[];const staleWindow={location:{href:'/inventory'}};
const staleApi=make(()=>new Promise(resolve=>{resolveStale=resolve;}),staleWindow,{getItem:()=>currentToken,removeItem:key=>removedStale.push(key)},()=>false);
const staleRequest=staleApi('/api/inventory');currentToken='new';resolveStale({status:401,ok:false,json:async()=>({error:'unauthorized'})});
await assert.rejects(staleRequest);assert.deepEqual(removedStale,[],'stale401 must not clear the new session');assert.equal(staleWindow.location.href,'/inventory');
console.log('PORTAL API AUTH QA: PASS (401 cleanup, stale401 isolation, storage failure, success, forbidden and demo paths)');
