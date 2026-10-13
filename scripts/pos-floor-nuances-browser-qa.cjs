'use strict';
// Owned local preview only. Mutations blocked; collaborator changes are GET-response simulations.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_PACKAGE_PATH||'playwright');
const m=JSON.parse(fs.readFileSync('tmp/full-local-qa/pos-payments-private.json','utf8'));
assert.equal(m.root,path.resolve('.'));assert.equal(m.ownerTag,'pos-payments-polish-20261013');assert.equal(m.state,'ready');assert.match(m.base,/^http:\/\/127\.0\.0\.1:\d+$/);
const dir=path.resolve('docs/design/POS_FLOOR_STATES_2026-10-13/evidence');fs.mkdirSync(dir,{recursive:true});
const errors=[],writes=[],results=[];let browser;
const clone=v=>JSON.parse(JSON.stringify(v));
async function run(){
 browser=await chromium.launch({channel:'chrome',headless:true});
 const auth={authorization:'Bearer '+m.actors.bartender.token};
 const floor=await (await fetch(m.base+'/api/floor',{headers:auth})).json(),orders=await (await fetch(m.base+'/api/orders?withPricing=1',{headers:auth})).json();
 assert.ok(floor.zones.length);assert.ok(orders.items.length);
 const source=orders.items.find(o=>o.items?.length&&o.status!=='closed');assert.ok(source);
 const tables=floor.zones.flatMap(z=>z.tables),ids=tables.slice(0,5).map(t=>t.id);
 const layout=clone(floor);layout.zones=[{...layout.zones[0],tables:tables.slice(0,5).map(clone)}];
 layout.zones[0].tables.forEach((t,i)=>{t.status=['free','blocked','reserved','occupied','occupied'][i];t.layout={...t.layout,amenities:{television:true,playstation5:true}};});
 layout.zones[0].tables[2].reservation={id:'qa-reservation',time:'21:30',date:'2026-10-13',guests:3,guestName:'Тестовая бронь'};
 layout.zones[0].tables[4].name='Очень длинное название стола для проверки удобства и переноса';
 const mixed={...clone(source),id:'qa-mixed-order',tableName:layout.zones[0].tables[3].name,tableId:ids[3],status:'in_progress',items:[{...clone(source.items[0]),id:'qa-bar-ready',preparationStation:'bar',preparationStatus:'ready'},{...clone(source.items[0]),id:'qa-bar-busy',preparationStation:'bar',preparationStatus:'in_progress'},{...clone(source.items[0]),id:'qa-hookah',preparationStation:'hookah',preparationStatus:'queued'}]};
 const long={...clone(source),id:'qa-long-order',tableName:layout.zones[0].tables[4].name,tableId:ids[4],status:'in_progress',items:Array.from({length:20},(_,i)=>({...clone(source.items[0]),id:'qa-item-'+i,name:'Позиция с длинным названием для проверки переноса '+i,preparationStation:'bar',preparationStatus:'in_progress'})),pricingTotal:123456.78};
 for(const width of [320,1366]){
  const p=await browser.newPage({viewport:{width,height:width===320?740:768}});p.setDefaultTimeout(12000);p.on('pageerror',e=>errors.push(e.message));
  let mode='normal',revision=0,floorRelease=null,ordersReads=0,simulatedMutationAttempts=0,mutationRelease=null;
  await p.route('**/api/**',async r=>{
   const url=new URL(r.request().url());if(!['GET','HEAD'].includes(r.request().method())){
    if(mode==='mutation-failure'&&url.pathname==='/api/orders/qa-long-order/items'){simulatedMutationAttempts++;await new Promise(resolve=>mutationRelease=resolve);mode='orders-error';return r.abort('failed');}
    writes.push(r.request().method()+' '+url.pathname);return r.abort();
   }
   if(url.pathname==='/api/floor'){
    if(mode==='loading')await new Promise(resolve=>floorRelease=resolve);
    if(mode==='floor-error')return r.fulfill({status:503,json:{error:'qa_unavailable'}});
    return r.fulfill({json:mode==='empty'?{...layout,zones:[]}:layout});
   }
   if(url.pathname==='/api/orders'){
    ordersReads++;if(mode==='orders-error')return r.fulfill({status:503,json:{error:'qa_unavailable'}});
    const updated=clone(long);if(revision)updated.items[0].name='Обновлено коллегой';
    return r.fulfill({json:{...orders,items:mode==='closed'?[]:[mixed,updated]}});
   }
   if(url.pathname==='/api/orders/qa-long-order/payments'||url.pathname==='/api/orders/qa-mixed-order/payments')return r.fulfill({json:{due:123456.78,paid:120000,remaining:3456.78,items:[],closed:false}});
   return r.continue();
  });
  await p.addInitScript(a=>{localStorage.setItem('crm_session_token',a.token);localStorage.setItem('crm_session_user',JSON.stringify(a.user));},m.actors.bartender);
  const ready=async()=>{await p.locator('#tables[data-data-state="ready"]').waitFor();await p.locator('[data-pos-counter="open"][data-state="ready"]').waitFor();};
  const closePanel=async()=>{const b=p.locator('[data-table-action="close-panel"]');if(width<=1180&&await b.isVisible())await b.click();};
  const focus=()=>p.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await p.goto(m.base);await ready();
  for(const theme of ['dark','light']){
   await p.evaluate(v=>{document.body.classList.toggle('light-theme',v==='light');document.documentElement.dataset.theme=v;},theme);await p.evaluate(()=>document.fonts.ready);await p.waitForTimeout(450);await closePanel();
   const free=p.locator(`.table[data-table="${ids[0]}"]`),blocked=p.locator(`.table[data-table="${ids[1]}"]`),reserved=p.locator(`.table[data-table="${ids[2]}"]`),mix=p.locator(`.table[data-table="${ids[3]}"]`);
   assert.doesNotMatch(await free.innerText(),/₽|\d{2}:\d{2}|\d+ гост/,'free table has no previous order fields');
   assert.match(await blocked.innerText(),/Недоступен/);assert.ok(await blocked.locator('.table-unavailable-icon').count(),'blocked lock visible');
   await blocked.click();await p.waitForTimeout(600);assert.match(await p.locator('.order').innerText(),/недоступ|управляющ|заблок/i);assert.ok(await p.locator('.order > .primary').isDisabled(),'blocked table cannot add order');await p.waitForTimeout(1500);await p.screenshot({path:path.join(dir,'blocked-'+width+'-'+theme+'.png'),fullPage:true});await closePanel();
   assert.match(await reserved.innerText(),/21:30/,'reservation time visible');
   assert.match(await mix.innerText(),/готово 1 из 2/);assert.match(await mix.innerText(),/Кальян ожидает/);assert.doesNotMatch(await mix.innerText(),/\+1/,'all station states visible');
   await p.locator('#floor-density-range').evaluate(n=>{n.value='70';n.dispatchEvent(new Event('input',{bubbles:true}));});await p.waitForTimeout(200);
   const geometry=await p.locator('#tables .table').evaluateAll(ns=>ns.map(n=>{const b=n.getBoundingClientRect();return {text:n.innerText,overflow:n.scrollWidth>n.clientWidth+1,children:[...n.children].filter(c=>!c.classList.contains('pos-workspace-sr-only')).map(c=>{const r=c.getBoundingClientRect();return{cls:c.className,inside:r.width===0||(r.left>=b.left-1&&r.right<=b.right+1&&r.bottom<=b.bottom+1)};})};}));
   assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);for(const g of geometry){assert.equal(g.overflow,false,'card horizontal overflow '+g.text);for(const c of g.children)assert.ok(c.inside,'card child inside '+JSON.stringify(c));}
   await p.waitForTimeout(1500);await p.screenshot({path:path.join(dir,`states-${width}-${theme}.png`),fullPage:true});
   if(width===320){await mix.scrollIntoViewIfNeeded();await p.screenshot({path:path.join(dir,`mixed-${width}-${theme}.png`),fullPage:true});}
   await p.locator(`.table[data-table="${ids[4]}"]`).click();await p.waitForFunction(()=>document.querySelector('#split-payment')?.textContent.includes('3')&&!document.querySelector('#split-payment').disabled).catch(async e=>{console.log(await p.locator('.order').innerText());console.log(await p.locator('#split-payment').evaluate(n=>({text:n.textContent,title:n.title,disabled:n.disabled})));throw e;});
   assert.match(await p.locator('#split-payment').innerText(),/3\s?456,78/,'partial amount is authoritative remainder');
   await p.waitForTimeout(1500);await p.screenshot({path:path.join(dir,`partial-${width}-${theme}.png`),fullPage:true});
   assert.equal(await p.locator('.table.sel').count(),1,'exactly one selected table');await closePanel();results.push({width,theme,checks:['free','blocked','reservation','mixed','long','partial','compact geometry']});
  }
  if(width===1366){
   await p.locator(`.table[data-table="${ids[4]}"]`).click();await p.waitForTimeout(1500);
   const before=await p.locator('.order').evaluate(n=>{const candidates=[n,...n.querySelectorAll('*')].filter(x=>x.scrollHeight>x.clientHeight+80&&['auto','scroll'].includes(getComputedStyle(x).overflowY));const target=candidates[0];if(target){target.scrollTop=90;target.dataset.qaScroll='true';return target.scrollTop;}return null;});assert.ok(before>0,'long order has scroll area');
   revision++;const readsBefore=ordersReads;await focus();await p.waitForFunction(()=>document.querySelector('.order')?.textContent.toLowerCase().includes('обновлено коллегой')).catch(async e=>{console.log(JSON.stringify({ordersReads,readsBefore,errors}));console.log(await p.locator('.order').innerText());throw e;});assert.ok(ordersReads>readsBefore);assert.equal(await p.locator('.table.sel').getAttribute('data-table'),ids[4]);const after=await p.locator('[data-qa-scroll="true"]').evaluate(n=>n.scrollTop);assert.ok(Math.abs(after-before)<3,'refresh preserves order scroll '+before+' -> '+after);results.push({check:'simulated collaborator GET update preserves selected table and scroll',before,after});
   mode='orders-error';await focus();await p.locator('[data-pos-counter="open"][data-state="error"]').waitFor();assert.ok(await p.locator('#split-payment').isDisabled());assert.match(await p.locator('#pos-workspace-feedback').innerText(),/не обновлены|устарел/);results.push({check:'failed order read blocks stale action, explicit feedback'});
   mode='normal';await focus();await ready();await p.waitForFunction(()=>!document.querySelector('#split-payment').disabled);
   mode='floor-error';await focus();await p.locator('#tables[data-data-state="error"]').waitFor();assert.match(await p.locator('#pos-workspace-feedback').innerText(),/последние данные|не обновлен/);assert.ok(await p.locator('#split-payment').isDisabled(),'stale floor blocks writes');results.push({check:'floor stale warns and blocks action'});
   mode='normal';await p.locator('[data-pos-floor-retry]').click();await ready();
   await p.context().setOffline(true);await p.waitForFunction(()=>document.querySelector('#split-payment')?.disabled);assert.match(await p.locator('#pos-workspace-feedback').innerText(),/Нет связи/);assert.match(await p.locator('#split-payment').getAttribute('title'),/Нет связи/);await p.context().setOffline(false);await focus();await ready();await p.waitForFunction(()=>!document.querySelector('#split-payment')?.disabled);results.push({check:'offline explicit feedback and disabled action, reconnect recovery'});
   mode='mutation-failure';await p.locator('.qty-plus').first().click();await p.waitForTimeout(100);assert.equal(simulatedMutationAttempts,1);await p.locator('.qty-plus').first().evaluate(n=>n.click());assert.equal(simulatedMutationAttempts,1,'pending blocks repeated quantity submission');mutationRelease();await p.locator('[data-pos-counter="open"][data-state="error"]').waitFor();assert.ok(await p.locator('.qty-plus').first().isDisabled());assert.match(await p.locator('#staff-notice').innerText(),/сверить|подтвердить/);mode='normal';await focus();await ready();results.push({check:'intercepted lost POST response plus failed reread blocks repeated mutation',simulatedMutationAttempts,liveWrites:0});
   mode='closed';await focus();await ready();await p.waitForFunction(()=>!document.querySelector('.order')?.textContent.toLowerCase().includes('обновлено коллегой'));results.push({check:'simulated colleague closing removes stale order'});
   mode='empty';await p.reload();await ready();assert.equal(await p.locator('.table').count(),0);assert.match(await p.locator('#tables').innerText(),/нет залов|нет столов/);results.push({check:'empty floor distinct'});
   mode='floor-error';await p.reload();await p.locator('#tables[data-data-state="error"]').waitFor();assert.match(await p.locator('#tables').innerText(),/Не удалось/);assert.ok(await p.locator('[data-staff-floor-retry]').isVisible());results.push({check:'initial failure distinct and retry available'});
   mode='loading';await p.reload({waitUntil:'domcontentloaded'});await p.locator('#tables[data-data-state="loading"]').waitFor();assert.match(await p.locator('#tables').innerText(),/Загружаем/);assert.ok(floorRelease);mode='normal';floorRelease();await ready();results.push({check:'loading distinct and recovers'});
  }
  await p.close();
 }
 assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);fs.writeFileSync(path.join(dir,'qa.json'),JSON.stringify({generatedAt:new Date().toISOString(),environment:'Owned preview, isolated Chrome; GET-response overrides simulate visual edge states and collaborator rereads, NOT a true two-actor database write E2E; all mutations blocked',results,errors,writes},null,2));console.log('PASS floor nuances: '+results.length+' groups; no browser errors or API writes');
}
run().catch(e=>{console.error(e.stack);fs.writeFileSync(path.join(dir,'checkpoint.json'),JSON.stringify({results,error:e.message},null,2));process.exitCode=1;}).finally(async()=>browser?.close());
