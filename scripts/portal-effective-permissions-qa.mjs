import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../portal-session.js',import.meta.url),'utf8');
const read=path=>fs.readFileSync(new URL('../'+path,import.meta.url),'utf8').replaceAll('\r\n','\n');
const entries=JSON.parse(read('site-map.json')).entries.filter(entry=>!['index.html','login.html','platform.html'].includes(entry.file));
for(const entry of entries){for(const file of [entry.file,'dist/'+entry.file,'dist'+entry.path+'/index.html']){const html=read(file);assert.match(html,/data-portal-access="checking"/);assert.match(html,/portal-session\.js\?rev=1/);assert.doesNotMatch(html,/<script[^>]+src="\/portal\.js/);assert.match(html,/display:none!important/);}}
assert.equal(read('portal-session.js'),read('dist/portal-session.js'));
assert.match(read('Dockerfile'),/COPY[^\n]*\bportal-session\.js\b/);
assert.match(read('server.js'),/'\/portal-session\.js'/);
const portalRevision=read('scripts/sync-published-assets.mjs').match(/portalRevision = '(\d+)'/)?.[1];assert.ok(portalRevision);assert.ok(source.includes('/portal.js?rev='+portalRevision),'bootstrap matches canonical portal revision');
function harness(pathname='/inventory') {
 const values=new Map([['crm_session_token','token-A'],['crm_session_user','{"role":"owner"}']]);const nodes=new Map(),scripts=[],requests=[],redirects=[],events={};let reloads=0;
 const node=()=>({dataset:{},setAttribute(){},querySelector(selector){return this.children[selector]||=(node());},children:{},remove(){nodes.delete(this.id);}});
 const document={documentElement:node(),hidden:false,body:{append(n){nodes.set(n.id,n);}},head:{append(n){scripts.push(n);}},createElement:node,getElementById:id=>nodes.get(id),addEventListener:(key,fn)=>events[key]=fn};
 const window={location:{origin:'http://127.0.0.1',pathname,hash:'',replace:url=>redirects.push(url),reload:()=>reloads++},addEventListener:(key,fn)=>events[key]=fn};
 const storage={getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)};
 vm.runInNewContext(source,{window,document,localStorage:storage,URL,AbortController,setTimeout:()=>1,clearTimeout(){},setInterval(){},fetch:(_url,options)=>new Promise(resolve=>requests.push({options,resolve}))});
 const respond=async(status,payload,index=requests.length-1)=>{const pending=window.__portalSessionGate.refresh();requests[index].resolve({status,ok:status>=200&&status<300,json:async()=>payload});await pending;};
 return {window,document,values,scripts,requests,redirects,events,respond,get reloads(){return reloads;},get gate(){return window.__portalSessionGate;}};
}
const session=permissions=>({user:{id:'staff-1',venueId:'venue-A',role:'admin'},permissions,permissionPolicy:{source:'system'}});
const success=harness();assert.equal(success.scripts.length,0);const flight=success.gate.refresh();assert.equal(flight,success.gate.refresh());assert.equal(success.requests.length,1);
await success.respond(200,session(['inventory_read']));assert.equal(success.scripts.length,1);assert.equal(success.window.__portalSessionVerified.user.id,'staff-1');assert.deepEqual(JSON.parse(success.values.get('crm_session_user')).workspacePermissions,['inventory_read']);success.scripts[0].onload();assert.equal(success.gate.blocked,false);
const stable=success.gate.refresh();await success.respond(200,session(['inventory_read']));await stable;assert.equal(success.scripts.length,1);assert.equal(success.reloads,0);
const changed=success.gate.refresh();await success.respond(200,session([]));await changed;assert.equal(success.reloads,1);assert.equal(success.gate.blocked,true);
const empty=harness();await empty.respond(200,session([]));assert.equal(empty.scripts.length,0);assert.equal(empty.gate.blocked,true);assert.deepEqual(JSON.parse(empty.values.get('crm_session_user')).workspacePermissions,[]);
const grant=empty.gate.refresh();await empty.respond(200,session(['inventory_read']));await grant;assert.equal(empty.scripts.length,1);
for(const status of [401,503]){const failed=harness();await failed.respond(status,{});assert.equal(failed.scripts.length,0);assert.equal(failed.gate.blocked,true);if(status===401){assert.equal(failed.values.has('crm_session_token'),false);assert.deepEqual(failed.redirects,['/login']);}else{assert.equal(failed.values.get('crm_session_token'),'token-A');}}
const malformed=harness();await malformed.respond(200,{user:{id:'x'},permissions:[42]});assert.equal(malformed.scripts.length,0);
const stale=harness();stale.values.set('crm_session_token','token-B');await stale.respond(401,{});assert.equal(stale.values.get('crm_session_token'),'token-B');assert.equal(stale.redirects.length,0);assert.equal(stale.scripts.length,0);
const recovery=harness();await recovery.respond(200,session(['inventory_read']));recovery.scripts[0].onload();recovery.gate.refresh();await recovery.respond(503,{});assert.equal(recovery.gate.blocked,true);recovery.gate.refresh();await recovery.respond(200,session(['inventory_read']));assert.equal(recovery.reloads,1);
assert.equal(success.gate.canAccessRoute(session(['orders']),'/clients'),true);assert.equal(success.gate.canAccessRoute(session([]),'/clients'),false);
assert.equal(success.gate.canAccessRoute(session(['finance_read']),'/finance/report'),true,'canonical report route');
assert.equal(success.gate.canAccessRoute(session(['finance']),'/finance/categories'),true,'canonical category route');
assert.equal(success.gate.canAccessRoute(session(['finance_read']),'/finance/categories'),false);
const lateLoad=harness();await lateLoad.respond(200,session(['inventory_read']));lateLoad.gate.refresh();await lateLoad.respond(503,{});lateLoad.scripts[0].onload();assert.equal(lateLoad.gate.blocked,true,'late script load cannot reveal UI after failed session revalidation');
const hash=harness('/admin');await hash.respond(200,session(['orders']));hash.scripts[0].onload();hash.window.location.hash='#staff';let stopped=false;hash.events.hashchange({stopImmediatePropagation(){stopped=true;}});assert.equal(stopped,true);assert.equal(hash.gate.blocked,true);hash.window.location.hash='#tasks';hash.events.hashchange({stopImmediatePropagation(){}});assert.equal(hash.reloads,1,'return to allowed hash rebuilds disposed/blocked state');
console.log('PORTAL EFFECTIVE PERMISSIONS QA: PASS (exact grants, empty deny, bootstrap ordering, singleflight, change reload,401/503/malformed, stale token, recovery, canonical routes)');
