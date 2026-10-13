'use strict';
// Isolated browser GET/POST response simulation; no mutation is sent to the owned preview.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_PACKAGE_PATH||'playwright');
const m=JSON.parse(fs.readFileSync('tmp/full-local-qa/pos-payments-private.json','utf8'));
assert.equal(m.root,path.resolve('.'));assert.equal(m.ownerTag,'pos-payments-polish-20261013');assert.equal(m.state,'ready');assert.match(m.base,/^http:\/\/127\.0\.0\.1:\d+$/);
const dir=path.resolve('docs/design/POS_BUTTONS_CLARITY_2026-10-13/evidence');fs.mkdirSync(dir,{recursive:true});
const results=[],errors=[],blockedUnexpectedWrites=[];let browser;
const copy=v=>JSON.parse(JSON.stringify(v));
async function run(){
 const auth={authorization:'Bearer '+m.actors.bartender.token};
 const floor=await(await fetch(m.base+'/api/floor',{headers:auth})).json(),orders=await(await fetch(m.base+'/api/orders?withPricing=1',{headers:auth})).json();
 const source=orders.items.find(o=>o.items?.length&&!['closed','cancelled'].includes(o.status));assert.ok(source);const table=floor.zones.flatMap(z=>z.tables).find(t=>t.id===source.tableId);assert.ok(table);
 browser=await chromium.launch({channel:'chrome',headless:true});
 for(const [role,permissions]of [['all',['bar_tasks','hookah_tasks']],['bar',['bar_tasks']],['hookah',['hookah_tasks']],['no-station',[]]]){
  for(const width of (role==='all'?[1366,320]:[1366])){
   const p=await browser.newPage({viewport:{width,height:width===320?740:768}});p.setDefaultTimeout(12000);p.on('pageerror',e=>errors.push(e.message));
   let mode='normal',dispatchCalls=[],releaseDispatch=null;
   const order={...copy(source),id:'qa-clarity-order',tableName:table.name,status:'open',items:['bar','hookah'].map((station,i)=>({...copy(source.items[0]),id:'qa-clarity-item-'+i,preparationStation:station,preparationStatus:'new'}))};
   const payment={due:700,paid:200,remaining:500,items:[],closed:false};
   await p.route('**/api/**',async r=>{
    const url=new URL(r.request().url()),method=r.request().method();
    if(!['GET','HEAD'].includes(method)){
     if(url.pathname==='/api/orders/qa-clarity-order/dispatch'&&method==='POST'){
      const body=r.request().postDataJSON();dispatchCalls.push(body);
      if(mode==='pending-dispatch')await new Promise(resolve=>releaseDispatch=resolve);
      for(const item of order.items)if(body.itemIds.includes(item.id))item.preparationStatus='queued';order.status='in_progress';
      return r.fulfill({json:copy(order)});
     }
     blockedUnexpectedWrites.push(method+' '+url.pathname);return r.abort();
    }
    if(url.pathname==='/api/session'){const response=await r.fetch(),data=await response.json();data.permissions=[...data.permissions.filter(x=>!['tasks_manage','bar_tasks','hookah_tasks'].includes(x)),...permissions];return r.fulfill({response,json:data});}
    if(url.pathname==='/api/floor')return r.fulfill({json:floor});
    if(url.pathname==='/api/orders')return mode==='orders-error'?r.fulfill({status:503,json:{error:'qa_unavailable'}}):r.fulfill({json:{...orders,items:[copy(order)]}});
    if(url.pathname==='/api/orders/qa-clarity-order/payments'||url.pathname==='/api/orders/qa-clarity-order/summary')return r.fulfill({json:payment});
    if(url.pathname==='/api/preparation/queue')return r.fulfill({json:{items:order.items.filter(i=>permissions.includes(i.preparationStation+'_tasks')&&i.preparationStatus!=='new').map(i=>({...i,orderId:order.id,tableId:table.id,tableName:table.name,orderStatus:order.status}))}});
    return r.continue();
   });
   await p.addInitScript(a=>{localStorage.setItem('crm_session_token',a.token);localStorage.setItem('crm_session_user',JSON.stringify(a.user));},m.actors.bartender);
   await p.goto(m.base);await p.locator('#tables[data-data-state="ready"]').waitFor();await p.waitForTimeout(400);
   const dispatch=p.locator('#order-main-action'),pay=p.locator('#split-payment');
   assert.equal(await dispatch.isVisible(),false,'no order has no dispatch action');assert.equal(await pay.isVisible(),false,'no order has no payment action');
   await p.locator(`.table[data-table="${table.id}"]`).click();await pay.waitFor({state:'visible'});await p.waitForTimeout(300);
   assert.match(await dispatch.innerText(),/Отправить/);assert.match(await pay.innerText(),/Оплатить|Принять оплату/);assert.match(await pay.innerText(),/500/);assert.equal(await dispatch.getAttribute('data-action'),'dispatch');
   for(const theme of (role==='all'?['dark','light']:['dark'])){
    await p.evaluate(v=>{document.body.classList.toggle('light-theme',v==='light');document.documentElement.dataset.theme=v;},theme);await p.evaluate(()=>document.fonts.ready);await p.waitForTimeout(1500);
    assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    for(const button of [dispatch,pay]){const box=await button.boundingBox();assert.ok(box.height>=44);assert.ok(box.width>=44);}
    await p.screenshot({path:path.join(dir,`order-${role}-${width}-${theme}.png`),fullPage:true});
    assert.ok(await pay.isDisabled(),'unsent items cannot be paid and closed');assert.match(await p.locator('.pos-payment-hint').innerText(),/Сначала отправьте/);assert.ok(await p.locator('.order .close').isDisabled(),'legacy close path also gated');await pay.evaluate(n=>n.click());assert.equal(await p.locator('#payment-modal.open').count(),0);
    assert.equal(await p.locator('[data-pos-counter="preparation"]').count(),0,'no duplicate preparation control');assert.equal(await p.locator('[data-pos-view="preparation"]').count(),1);
    results.push({role,width,theme,check:'stable dispatch and payment controls, unsent payment visibly gated, duplicate preparation removed'});
   }
   mode='pending-dispatch';await dispatch.click();await p.waitForTimeout(100);assert.equal(dispatchCalls.length,1);assert.ok(await dispatch.isDisabled());assert.ok(await pay.isDisabled(),'payment unavailable during dispatch');await dispatch.evaluate(n=>n.click());assert.equal(dispatchCalls.length,1,'duplicate dispatch suppressed');mode='normal';releaseDispatch();await p.waitForFunction(()=>document.querySelector('#order-main-action')?.disabled&&!document.querySelector('#split-payment')?.disabled);assert.equal(dispatchCalls.length,2,'mixed directions each sent once');assert.deepEqual(dispatchCalls.map(c=>c.station).sort(),['bar','hookah']);assert.doesNotMatch(await dispatch.innerText(),/оплат/i);await p.waitForFunction(()=>document.querySelector('#split-payment')?.textContent.includes('500'));
   await pay.click();await p.locator('#payment-modal.open').waitFor();await p.waitForFunction(()=>document.querySelector('#payment-due')?.textContent.includes('500'));await p.locator('#payment-close').click();assert.match(await dispatch.innerText(),/Все позиции отправлены/,'payment modal never changes dispatch meaning');
   const close=p.locator('[data-table-action="close-panel"]');if(width<=1180&&await close.isVisible())await close.click();
   if(permissions.length){await p.locator('[data-pos-view="preparation"]').click();await p.locator('#preparation-refresh').click();await p.waitForTimeout(300);const stationRows=await p.locator('.preparation-row').evaluateAll(ns=>ns.map(n=>n.dataset.station));assert.deepEqual(stationRows.sort(),permissions.map(x=>x.replace('_tasks','')).sort());assert.equal(await p.locator('.pos-preparation-filters').isVisible(),permissions.length>1,'single station needs no duplicate filter');await p.screenshot({path:path.join(dir,`queue-${role}-${width}.png`),fullPage:true});await p.locator('[data-pos-view="floor"]').click();}
   else assert.equal(await p.locator('[data-pos-view="preparation"]').isVisible(),false,'no station access hides preparation');
   await p.locator(`.table[data-table="${table.id}"]`).click();mode='orders-error';await p.evaluate(()=>window.dispatchEvent(new Event('focus')));await p.waitForFunction(()=>document.querySelector('#split-payment')?.disabled);assert.ok(await dispatch.isDisabled());assert.match(await pay.getAttribute('title'),/обнов|свер/i);mode='normal';if(width<=1180)await p.locator('[data-table-action="close-panel"]').click();await p.locator('[data-pos-floor-retry]').click();await p.waitForFunction(()=>!document.querySelector('#split-payment')?.disabled);await p.locator('.table.sel').click();
   await p.context().setOffline(true);await p.waitForFunction(()=>document.querySelector('#split-payment')?.disabled);assert.ok(await dispatch.isDisabled());assert.match(await pay.getAttribute('title'),/связ/i);await p.context().setOffline(false);
   results.push({role,width,check:'mixed dispatch once per station, pending gate, station-specific visibility, stale/offline gates',simulatedPosts:dispatchCalls.length,liveWrites:0});await p.close();
  }
 }
 assert.deepEqual(errors,[]);assert.deepEqual(blockedUnexpectedWrites,[]);fs.writeFileSync(path.join(dir,'qa.json'),JSON.stringify({generatedAt:new Date().toISOString(),environment:'Isolated browser on owned preview; session permissions, order state, station queues and dispatch responses are simulations. No mutation forwarded to server.',results,errors,blockedUnexpectedWrites},null,2));console.log('PASS buttons clarity '+results.length+' groups, 0 live API writes');
}
run().catch(e=>{console.error(e.stack);fs.writeFileSync(path.join(dir,'checkpoint.json'),JSON.stringify({results,error:e.message,errors},null,2));process.exitCode=1;}).finally(async()=>browser?.close());
