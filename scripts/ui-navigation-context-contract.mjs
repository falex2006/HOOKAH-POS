import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const portal=fs.readFileSync('portal.js','utf8');
const start=portal.indexOf('// UI-03.2:'),end=portal.indexOf('// Keep the sidebar structure',start);
assert.ok(start>=0&&end>start);
const source=portal.slice(start,end)+'\nglobalThis.subject={sidebarDisclosureKey,readSidebarDisclosure,sidebarRouteGroup,createSidebarNavigation};';
let checks=0;const equal=(a,b,message)=>{assert.deepEqual(a,b,message);checks++;};
function fixture({user='u',venue='a',role='owner',route='/clients',type='navigate',store=new Map(),fail=false,denied=[]}={}) {
 const location=new URL(route,'http://example.invalid');
 const input={value:''};
 const link=(label,href,permission='orders')=>({textContent:label,dataset:{permission},hidden:false,getAttribute:()=>href});
 const groups=[['operations','Операции',[link('Гости','/clients'),link('Заказы','/orders')]],['menu','Меню',[link('Каталог товаров','/inventory?view=products','inventory_read')]],['inventory','Склад',[link('Остатки','/inventory','inventory_read')]],['finance','Финансы',[link('Обзор финансов','/finance','finance_read')]],['team','Команда',[link('Задачи','/admin#tasks')]],['system','Система',[link('Моя сеть','/network','settings'),link('Настройки','/admin#company','settings')]]].map(([key,label,links])=>{const attrs={};const summary={textContent:label,setAttribute:(k,v)=>{attrs[k]=v;}};return{dataset:{navGroup:key},links,summary,attrs,open:false,hidden:false,querySelector:()=>summary,querySelectorAll:()=>links};});
 const sidebar={querySelector:()=>input,querySelectorAll:()=>groups};
 const context=vm.createContext({URL,location,portalUser:{role},window:{__portalSessionVerified:{user:{id:user,venueId:venue}}},hasPortalPermission:p=>!denied.includes(p),performance:{getEntriesByType:()=>[{type}]},localStorage:{getItem:k=>{if(fail)throw Error('disabled');return store.get(k)??null;},setItem:(k,v)=>{if(fail)throw Error('disabled');store.set(k,v);}}});
 vm.runInContext(source,context);let syncs=0;const api=context.subject.createSidebarNavigation(sidebar,()=>syncs++);
 const key=context.subject.sidebarDisclosureKey(context.window.__portalSessionVerified);
 return{api,groups,input,store,key,subject:context.subject,open:()=>groups.filter(g=>g.open&&!g.hidden).map(g=>g.dataset.navGroup),saved:()=>JSON.parse(store.get(key)||'null'),toggle:k=>api.toggle({preventDefault(){}},groups.find(g=>g.dataset.navGroup===k),k),navigate:r=>{location.href=new URL(r,location).href;api.syncRoute();},syncs:()=>syncs};
}
const store=new Map([['crm_sidebar_group_u_finance','open'],['crm_sidebar_group_u_team','open']]);
let f=fixture({store});equal(f.open(),['operations'],'Ignore venue-less legacy flags');
f.toggle('finance');f.toggle('team');equal(f.open(),['team'],'Latest group replaces sibling');equal(f.saved().openGroup,'team','One object stores latest selection');
f=fixture({store,type:'reload'});equal(f.open(),['team'],'Same-route reload restores manual choice');f.toggle('team');equal(f.open(),[],'Repeat click collapses all');
f=fixture({store,type:'reload'});equal(f.open(),[],'Reload restores explicit null');
let other=fixture({store,user:'other',type:'reload'});equal(other.open(),['operations'],'Different user cannot read previous choice');
other=fixture({store,venue:'b',type:'reload'});equal(other.open(),['operations'],'Different venue isolated');other.toggle('finance');
f=fixture({store,type:'reload'});equal(f.open(),[],'Original venue keeps collapsed preference');
other=fixture({store,venue:'b',type:'reload'});equal(other.open(),['finance'],'Second venue keeps its own choice');
f.toggle('team');const beforeSearch=store.get(f.key);f.input.value='о';f.api.refresh();assert.ok(f.open().length>1);checks++;equal(store.get(f.key),beforeSearch,'Search multi-open is not persisted');
f.input.value='not-present';f.api.refresh();equal(f.open(),[],'No results hides groups');f.input.value='';f.api.refresh();equal(f.open(),['team'],'Clear restores presearch choice');assert.ok(f.groups.every(g=>!g.hidden));checks++;
f.input.value='о';f.api.refresh();f.toggle('team');equal(store.get(f.key),beforeSearch,'Manual search toggles are transient');f.input.value='';f.api.refresh();equal(f.open(),['team'],'Clear restores choice after search toggle');
f.input.value='команда';f.api.refresh();equal(f.groups.find(g=>g.dataset.navGroup==='team').links[0].hidden,false,'Group name exposes allowed children');
f.navigate('/admin#company');equal(f.input.value,'','Route clears transient search');equal(f.open(),['system'],'Hash route group synchronized');f.toggle('finance');f.api.syncRoute();equal(f.open(),['finance'],'Duplicate popstate/hash event leaves manual choice');f.api.syncRoute({force:true});equal(f.open(),['system'],'BFCache arrival opens current route group');
f.navigate('/inventory?view=products&workspace=desk#keep');equal(f.open(),['menu'],'Inventory product view');f.navigate('/inventory?workspace=desk#keep');equal(f.open(),['inventory'],'Inventory stock view');
f=fixture({role:'manager',denied:['settings']});f.input.value='система';f.api.refresh();equal(f.groups.find(g=>g.dataset.navGroup==='system').hidden,true,'Search retains permissions and manager exception');
f=fixture();f.input.value='фин';f.api.refresh();const finance=f.groups.find(g=>g.dataset.navGroup==='finance').links[0];finance.dataset.interfacePreferenceHidden='true';finance.hidden=true;f.api.preferencesChanged();equal(finance.hidden,true,'Late preference remains hidden during search');f.input.value='';f.api.refresh();equal(finance.hidden,true,'Clear never resurrects disabled preference');
f=fixture({fail:true});f.toggle('team');equal(f.open(),['team'],'Storage failure keeps usable in-memory menu');
f=fixture();f.toggle('finance');const hiddenFinance=f.groups.find(g=>g.dataset.navGroup==='finance').links[0];hiddenFinance.dataset.interfacePreferenceHidden='true';f.api.preferencesChanged();equal(f.open(),['operations'],'Late hidden selection falls back to route group');f.toggle('operations');f.api.preferencesChanged();equal(f.open(),[],'Preferences preserve intentional null');
f=fixture();f.toggle('team');f.api.home({button:0,ctrlKey:true});equal(f.open(),['team'],'Modified home activation does not mutate page');f.api.home({button:0});equal(f.open(),[],'Ordinary home activation collapses groups');
f=fixture({user:null});f.toggle('finance');equal(f.key,null,'Unknown confirmed identity has no storage namespace');equal(f.store.size,0,'No anonymous writes');
for(const raw of ['null','{}','broken','{"version":1,"route":"/clients","openGroup":"team"}','{"version":2,"route":"/clients","openGroup":"invalid"}'])equal(f.subject.readSidebarDisclosure(raw),null,'Malformed/version/unknown group ignored');
const keys=[{user:{id:'a:b',venueId:'c'}},{user:{id:'a',venueId:'b:c'}},{user:{id:'а',venueId:'точка'}}].map(f.subject.sidebarDisclosureKey);equal(new Set(keys).size,3,'Identity encoding is collision resistant');
assert.equal(fs.readFileSync('dist/portal.js','utf8'),portal);checks++;
assert.ok(!portal.includes('crm_sidebar_group_'));assert.ok(portal.includes("window.addEventListener('pageshow'"));assert.ok(portal.includes("document.querySelector('.portal-sidebar')?._navigationController?.syncRoute();"));checks+=3;
// Execute the actual active-link matcher separately from mocked disclosure DOM.
const activeStart=portal.indexOf('  const syncActiveNavigation = () => {'),activeEnd=portal.indexOf('  sidebar._navigationController =',activeStart);
assert.ok(activeStart>=0&&activeEnd>activeStart);
for(const [route,expected] of [['/inventory?view=products&workspace=desk#keep','/inventory?view=products'],['/inventory?workspace=desk#keep','/inventory?view=stock'],['/inventory?view=recipes#keep','/inventory?view=recipes'],['/admin#tasks','/admin#tasks'],['/finance#payroll','/finance#payroll'],['/finance','/finance']]){
 const links=['/inventory?view=products','/inventory?view=stock','/inventory?view=recipes','/admin#tasks','/finance','/finance#payroll'].map(href=>{const flags=new Set(),attrs=new Map([['href',href]]);return{href,flags,attrs,querySelector:()=>({textContent:'label'}),getAttribute:k=>attrs.get(k),setAttribute:(k,v)=>attrs.set(k,v),removeAttribute:k=>attrs.delete(k),classList:{toggle:(k,v)=>{if(v)flags.add(k);else flags.delete(k);}}};});
 const context=vm.createContext({URL,location:new URL(route,'http://example.invalid'),sidebar:{querySelectorAll:selector=>selector==='.portal-nav a'?links:[]}});
 vm.runInContext(portal.slice(activeStart,activeEnd)+'\nsyncActiveNavigation();',context);
 equal(links.filter(l=>l.flags.has('active')).map(l=>l.href),[expected],'Actual matcher retains query/hash route '+route);
 equal(links.filter(l=>l.attrs.has('aria-current')).map(l=>l.href),[expected],'Unique aria-current '+route);
}
console.log(`UI-03.2 actual-source navigation context PASS (${checks} checks; isolated VM, browser acceptance separate).`);
