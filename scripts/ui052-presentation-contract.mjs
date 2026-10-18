import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const root=new URL('../',import.meta.url),portal=fs.readFileSync(new URL('portal.js',root),'utf8'),css=fs.readFileSync(new URL('style.css',root),'utf8');
const extract=(from,to,source=portal)=>{const a=source.indexOf(from),b=source.indexOf(to,a+from.length);assert.ok(a>=0&&b>a,`actual boundaries ${from}`);return source.slice(a,b);};
const harness=fs.readFileSync(new URL('scripts/ui-dialog-lifecycle-contract.mjs',root),'utf8'),source=fs.readFileSync(new URL('ui-dialog.js',root),'utf8');
const factory=extract('function fixture() {','\nconst defaults =',harness),decode=value=>String(value).replace(/&(amp|lt|gt|quot|#39);/g,(_,k)=>({amp:'&',lt:'<',gt:'>',quot:'"','#39':"'"})[k]);
const settle=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
function fixture(){
 const f=vm.runInNewContext(factory+'\nfixture()',{vm,source,decode}),{Node,document,context:c}=f;
 Node.prototype.prepend=function(n){n.remove();n.parentNode=this;this.children.unshift(n);};
 Node.prototype.before=function(n){const p=this.parentNode,index=p.children.indexOf(this);n.remove();n.parentNode=p;p.children.splice(index,0,n);};
 Node.prototype.scrollIntoView=function(){};
 const target=f.main;target.textContent='';
 const requests=[],notices=[];const api=(path,options)=>new Promise((resolve,reject)=>requests.push({path,options,resolve,reject}));
 Object.assign(c,{identity:'verified-qa',portalEditorIdentity:()=>c.identity,api,portalNotice:(...a)=>notices.push(a),icon:()=>'<svg></svg>',pluralRu:(_n,a)=>a,money:n=>String(n)+' ₽',esc:s=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;')});
 vm.runInContext(extract('function mountOperationalListPresentation(','function renderDelivery()'),c);
 return{...f,c,target,requests,notices,run:code=>vm.runInContext(code,c)};
}
function clientReadFixture(){
 const f=fixture();f.target.innerHTML='<div id="clients-list"></div><span id="clients-count"></span><span id="clients-total"></span><span id="clients-loyal"></span><span id="clients-turnover"></span><input id="clients-search"><select id="clients-period"></select><select id="client-discount-group"></select>';f.c.target=f.target;f.c.drawn=[];
 vm.runInContext(extract("let clientListState = 'loading';","  const formatPhones ="),f.c);
 const section=extract('function renderClients()','const reservationTableCapacityLabel ='),a=section.indexOf('const load = () =>'),b=section.indexOf('\n  const phoneInput',a);assert.ok(a>=0&&b>a);vm.runInContext('let clients=[],discountGroups=[];const draw=q=>drawn.push(q);'+section.slice(a,b),f.c);
 vm.runInContext(extract("document.querySelector('#clients-period')?.addEventListener('change'","  if (!['owner', 'admin', 'developer', 'manager'].includes(portalUser.role))",section),f.c);return f;
}
let passed=0;const failures=[];async function test(name,fn){try{await fn();passed++;}catch(e){failures.push(name+': '+e.stack);}}
await test('current source/dist parity',()=>{for(const f of ['portal.js','style.css'])assert.equal(fs.readFileSync(new URL('dist/'+f,root),'utf8'),f==='portal.js'?portal:css);});
await test('scoped primitive mount leaves guest financial editor and wizard outside opt-in',()=>{
 const f=fixture();f.target.innerHTML='<div class="page-title"><h1>Guests</h1><button class="primary">New</button></div><section class="panel"><div class="clients-toolbar"><input aria-label="Search"></div><div id="clients-list"><button>Open</button><span class="badge success">VIP</span></div></section><section id="client-editor"><button>Financial</button><input></section><div id="reservation-dialog"><input><button>Wizard</button></div>';
 f.run("mountOperationalListPresentation(document.querySelector('#page-content'))");
 assert.ok(f.target.querySelector('.page-title').classList.contains('ui-components'));assert.ok(f.target.querySelector('h1').classList.contains('ui-heading'));
 assert.ok(f.target.querySelector('#clients-list').closest('.panel').classList.contains('ui-components'));
 assert.ok(f.target.querySelector('#clients-list button').classList.contains('ui-button'));
 assert.equal(f.target.querySelector('#client-editor button').classList.contains('ui-button'),false);assert.equal(f.target.querySelector('#reservation-dialog input').classList.contains('ui-input'),false);
 const control=f.target.querySelector('.clients-toolbar input');assert.equal(control.closest('label').textContent,'Search');
 f.run("mountOperationalListPresentation(document.querySelector('#page-content'))");assert.equal(f.target.querySelectorAll('.clients-toolbar label').length,1,'mount idempotent labels');
});
await test('reservation financial row controls keep original visual contract',()=>{
 const f=fixture();f.target.innerHTML='<section class="panel"><div id="reservation-list"><button data-reservation-prepayment>Receipt</button><button data-reservation-receipt-refund>Refund</button><button data-reservation-allocation-reversal>Allocation</button><button data-reservation-edit>Edit</button></div></section>';
 f.run("mountOperationalListPresentation(document.querySelector('#page-content'))");
 for(const selector of ['prepayment','receipt-refund','allocation-reversal'])assert.equal(f.target.querySelector(`[data-reservation-${selector}]`).classList.contains('ui-button'),false);
 assert.ok(f.target.querySelector('[data-reservation-edit]').classList.contains('ui-button'));
});
await test('actual delivery attached editor preserves draft and blocks pending close',async()=>{
 const f=fixture();vm.runInContext(extract('function renderDelivery()','function renderEmployeeFinanceReport('),f.c);f.run('renderDelivery()');
 const editor=f.target.querySelector('#delivery-editor'),form=f.target.querySelector('#delivery-form'),opener=f.target.querySelector('#delivery-new'),close=f.target.querySelector('#delivery-close');
 assert.equal(editor.hidden,true);assert.equal(f.target.querySelector('.delivery-workspace').children[0].querySelector('#delivery-list')!==null,true,'queue first');assert.equal(f.target.querySelectorAll('#delivery-form').length,1);
 opener.dispatch('click');assert.equal(editor.hidden,false);assert.equal(f.document.activeElement,f.target.querySelector('#delivery-name'));assert.equal(opener.getAttribute('aria-expanded'),'true');
 f.target.querySelector('#delivery-name').value='QA guest';f.target.querySelector('#delivery-address').value='Long address';close.dispatch('click');assert.equal(editor.hidden,true);assert.equal(f.document.activeElement,opener);opener.dispatch('click');assert.equal(f.target.querySelector('#delivery-name').value,'QA guest');assert.equal(f.target.querySelector('#delivery-address').value,'Long address');
 f.target.querySelector('#delivery-phone').value='+79990000000';f.target.querySelector('#delivery-total').value='125';f.target.querySelector('#delivery-payment').value='card';f.target.querySelector('#delivery-comment').value='Preserve me';
 form.dispatch('submit');assert.equal(f.requests.at(-1).path,'/api/deliveries');assert.deepEqual(JSON.parse(f.requests.at(-1).options.body),{customerName:'QA guest',phone:'+79990000000',address:'Long address',total:125,paymentMethod:'card',comment:'Preserve me'});
 close.dispatch('click');assert.equal(editor.hidden,false,'pending close guarded');const count=f.requests.length;form.dispatch('submit');assert.equal(f.requests.length,count,'no duplicate POST');
 f.requests.at(-1).reject(Error('offline'));await settle();assert.equal(f.target.querySelector('#delivery-name').value,'QA guest');assert.match(f.target.querySelector('#delivery-message').textContent,/Не удалось/);close.dispatch('click');assert.equal(editor.hidden,true);assert.equal(f.document.activeElement,opener);
});
await test('actual clients loading/error/retry keep filters and unknown statistics',async()=>{
 const f=fixture();f.target.innerHTML='<div id="clients-list"></div><span id="clients-count"></span><span id="clients-total"></span><span id="clients-loyal"></span><span id="clients-turnover"></span><input id="clients-search"><select id="clients-status-filter"></select><select id="clients-sort"></select><select id="clients-period"></select><select id="client-discount-group"></select>';
 for(const[id,value]of [['clients-search','long'],['clients-status-filter','vip'],['clients-sort','name'],['clients-period','90']])f.target.querySelector('#'+id).value=value;
 f.c.target=f.target;f.c.drawn=[];vm.runInContext(extract("let clientListState = 'loading';","  const formatPhones ="),f.c);
 const clientSection=extract('function renderClients()','const reservationTableCapacityLabel =');const a=clientSection.indexOf("const load = () =>"),b=clientSection.indexOf('\n  const phoneInput',a);assert.ok(a>=0&&b>a);vm.runInContext('let clients=[],discountGroups=[];const draw=q=>drawn.push(q);'+clientSection.slice(a,b),f.c);
 assert.equal(f.target.querySelector('#clients-list').dataset.readState,'loading');assert.equal(f.target.querySelector('#clients-total').textContent,'—');
 f.run('load()');assert.equal(f.requests[0].path,'/api/clients?days=90');f.requests[0].reject(Error('offline'));f.requests[1].resolve({items:[]});await settle();assert.equal(f.target.querySelector('#clients-list').dataset.readState,'error');assert.ok(f.target.querySelector('#clients-list [role="alert"]'));assert.equal(f.target.querySelector('#clients-count').textContent,'Данные не загружены');
 f.target.querySelector('#clients-list').dispatch('click',{target:f.target.querySelector('[data-clients-retry]')});assert.equal(f.requests[2].path,'/api/clients?days=90');assert.equal(f.target.querySelector('#clients-list').getAttribute('aria-busy'),'true');f.requests[2].resolve({items:[]});f.requests[3].resolve({items:[]});await settle();assert.equal(f.run('clientListState'),'ready');assert.equal(f.c.drawn.at(-1),'long');
 for(const[id,value]of [['clients-search','long'],['clients-status-filter','vip'],['clients-sort','name'],['clients-period','90']])assert.equal(f.target.querySelector('#'+id).value,value);
});
await test('actual delivery load error, retry, empty and filter-empty remain distinct',async()=>{
 const f=fixture();vm.runInContext(extract('function renderDelivery()','function renderEmployeeFinanceReport('),f.c);f.run('renderDelivery()');
 f.requests[0].reject(Error('offline'));await settle();assert.ok(f.target.querySelector('#delivery-list [role="alert"]'));assert.match(f.target.querySelector('#delivery-count').textContent,/Ошибка/);
 const retry=f.target.querySelector('[data-delivery-retry]');f.target.querySelector('#delivery-list').dispatch('click',{target:retry});assert.equal(retry.disabled,true);assert.equal(f.requests[1].path,'/api/deliveries');f.requests[1].resolve({items:[]});await settle();assert.match(f.target.querySelector('#delivery-list').textContent,/Доставок пока нет/);
 retry.disabled=false;f.target.querySelector('#delivery-list').dispatch('click',{target:retry});f.requests[2].resolve({items:[{id:'qa',customerName:'<QA>',phone:'123',address:'Long address',total:10,status:'new',paymentMethod:'cash'}]});await settle();assert.ok(f.target.querySelector('#delivery-list .delivery-row'));assert.equal(f.target.querySelector('#delivery-list').querySelectorAll('QA').length,0,'escaped guest text cannot create markup');
 const filter=f.target.querySelector('#delivery-filter');filter.value='delivered';filter.dispatch('change');assert.match(f.target.querySelector('#delivery-list').textContent,/по выбранному фильтру/);assert.equal(filter.value,'delivered');
});
await test('actual task status options depend on permission authority rather than role label',()=>{
 const tasks=extract('function renderTasks()','function renderLoyalty()'),code=extract('  const taskStatusControl =','  const runTaskMutation =',tasks);
 for(const manage of [false,true]){const c=vm.createContext({canManageTasks:manage,esc:s=>s});vm.runInContext(code+';globalThis.control=taskStatusControl;',c);const result=c.control({id:'qa',title:'Long title',status:'open'});assert.match(result,/value="open"/);assert.match(result,/value="in_progress"/);assert.match(result,/value="done"/);assert.equal(result.includes('value="cancelled"'),manage);if(!manage)assert.match(c.control({id:'qa',title:'QA',status:'cancelled'}),/Отменена руководителем/);}
});
await test('clients older failed retry cannot overwrite a newer ready read',async()=>{
 const f=fixture();f.target.innerHTML='<div id="clients-list"></div><span id="clients-count"></span><span id="clients-total"></span><span id="clients-loyal"></span><span id="clients-turnover"></span><input id="clients-search"><select id="clients-period"></select><select id="client-discount-group"></select>';f.c.target=f.target;f.c.drawn=[];
 vm.runInContext(extract("let clientListState = 'loading';","  const formatPhones ="),f.c);const section=extract('function renderClients()','const reservationTableCapacityLabel ='),a=section.indexOf("const load = () =>"),b=section.indexOf('\n  const phoneInput',a);assert.ok(a>=0&&b>a);vm.runInContext('let clients=[],discountGroups=[];const draw=q=>drawn.push(q);'+section.slice(a,b),f.c);
 f.run('load()');f.run('load()');f.requests[2].resolve({items:[{id:'fresh'}]});f.requests[3].resolve({items:[]});await settle();assert.equal(f.run('clientListState'),'ready');f.requests[0].reject(Error('old failure'));f.requests[1].resolve({items:[]});await settle();assert.equal(f.run('clientListState'),'ready','stale older error must not replace fresh visible results');assert.equal(f.run('clients[0].id'),'fresh');
});
await test('actual period and retry share generation, retaining latest successful period',async()=>{
 const f=clientReadFixture(),period=f.target.querySelector('#clients-period');period.value='30';f.run('load()');period.value='90';period.dispatch('change');assert.equal(f.requests[2].path,'/api/clients?days=90');f.requests[2].resolve({items:[{id:'period90'}]});await settle();f.requests[0].resolve({items:[{id:'old30'}]});f.requests[1].resolve({items:[]});await settle();assert.equal(f.run('clients[0].id'),'period90');assert.equal(f.run('clientListState'),'ready');
 period.value='7';period.dispatch('change');f.run('load()');f.requests[4].resolve({items:[{id:'retry7'}]});f.requests[5].resolve({items:[]});await settle();f.requests[3].reject(Error('old period failure'));await settle();assert.equal(f.run('clients[0].id'),'retry7');assert.equal(f.run('clientListState'),'ready');assert.equal(period.value,'7');
});
for(const outcome of ['resolve','reject'])for(const obsolete of ['detached','context','replaced'])await test(`clients ${outcome} ignored after ${obsolete}`,async()=>{
 const f=clientReadFixture();f.run('load()');const original=f.target.querySelector('#clients-list');if(obsolete==='context')f.c.identity='other-verified-context';else if(obsolete==='detached')original.remove();else{original.remove();const newer=new f.Node('div');newer.id='clients-list';newer.textContent='New render';f.target.append(newer);}
 if(outcome==='resolve')f.requests[0].resolve({items:[{id:'stale'}]});else f.requests[0].reject(Error('stale'));f.requests[1].resolve({items:[]});await settle();assert.equal(f.run('clients.length'),0);assert.equal(f.c.drawn.length,0);assert.equal(f.run('clientListState'),'loading','stale response cannot mutate current state');if(obsolete==='replaced')assert.equal(f.target.querySelector('#clients-list').textContent,'New render');
});
await test('task worker authority and lifecycle remain guarded; no new task search',()=>{
 const tasks=extract('function renderTasks()','function renderLoyalty()');assert.match(tasks,/const canManageTasks = hasPortalPermission\('tasks_manage'\) \|\| hasPortalPermission\('staff_manage'\)/);assert.match(tasks,/if \(canManageTasks\) list\.addEventListener\('click'/);assert.match(tasks,/if \(canManageTasks\) document\.querySelector\('#task-new'\)/);assert.match(tasks,/!canManageTasks && \(previousStatus === 'cancelled' \|\| !\['open', 'in_progress', 'done'\]\.includes\(nextStatus\)\)/);assert.match(tasks,/loadGeneration/);assert.match(tasks,/interactionActive/);assert.match(tasks,/target\._tasksCleanup = cleanup/);assert.doesNotMatch(tasks,/id="tasks?-search"/);
});
await test('distinct empty presentation, preserved reservation wizard and scoped tokens',()=>{
 const clients=extract('function renderClients()','const reservationTableCapacityLabel ='),delivery=extract('function renderDelivery()','function renderEmployeeFinanceReport('),reservations=extract('function renderReservations()',"if (page === 'dashboard'",portal);
 assert.match(clients,/Гости по выбранным фильтрам не найдены/);assert.match(clients,/Гостей пока нет/);assert.match(delivery,/Доставок по выбранному фильтру нет/);assert.match(delivery,/Доставок пока нет/);
 for(const marker of ['reservation-form','reservation-filter','reservation-list-date','focus-reservation','data-reservation-step'])assert.ok(reservations.includes(marker));assert.match(reservations,/params\.get\('action'\) === 'seat'/);
 const scopeStart=css.indexOf('/* UI-05.2:'),scopeEnd=css.indexOf('/* UI-06.1:',scopeStart);assert.ok(scopeStart>=0&&scopeEnd>scopeStart,'UI-05.2 operational list block boundaries');
 const scope=css.slice(scopeStart,scopeEnd);assert.ok(scope.includes('.ui-operational-list'));assert.match(scope,/var\(--ui-panel\)/);assert.doesNotMatch(scope,/#[0-9a-fA-F]{3,8}\b|linear-gradient|backdrop-filter/);assert.match(scope,/#delivery-editor\[hidden\]/);
});
await test('task and guest consumer foreground/background win inherited legacy specificity',()=>{
 const scoped=css.slice(css.indexOf('/* Resolve legacy task/guest specificity'));
 assert.ok(scoped.length>0,'declared scoped legacy conflict fix');
 assert.match(scoped,/\.velora-theme \.ui-operational-list :is\(\.tasks-column,\.task-card,\.client-groups,\.empty\)\s*\{[^}]*background:var\(--ui-panel\)/,'empty and segments use matching semantic surface');
 assert.match(scoped,/\.velora-theme \.ui-operational-list :is\(\.tasks-column>h3,\.task-card>b\)\s*\{[^}]*color:var\(--ui-text-primary\)/,'task identity and column names use semantic text at sufficient specificity');
 assert.match(scoped,/\.client-card small,\.client-tags>span,\.empty[^}]*color:var\(--ui-text-secondary\)/,'secondary row and empty text coordinated');
 assert.match(scoped,/\.velora-theme \.ui-operational-list \.client-groups button\s*\{[^}]*color:var\(--ui-text-primary\);background:transparent/,'segment text/background pairing');
});
if(failures.length){console.error(failures.join('\n\n'));process.exitCode=1;}console.log(`UI052 actual-source presentation: ${passed} PASS, ${failures.length} FAIL (VM/source only; no browser/API persistence claim)`);
