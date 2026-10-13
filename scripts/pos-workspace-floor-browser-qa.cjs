const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_PACKAGE_PATH||'playwright');
const m=JSON.parse(fs.readFileSync('tmp/full-local-qa/pos-workspace-private.json','utf8'));
assert.equal(path.resolve(m.root),path.resolve('.'));assert.equal(m.ownerTag,'pos-employee-workspace-20261011');assert.equal(m.state,'ready');assert.match(m.base,/^http:\/\/127\.0\.0\.1:\d+$/);
const dir=path.resolve('docs/design/POS_EMPLOYEE_WORKSPACE_2026-10-11/evidence'),results=[],errors=[];let browser;
const pass=name=>{results.push(name);console.log('PASS '+name)};
async function api(route){const r=await fetch(m.base+route,{headers:{authorization:'Bearer '+m.actors.bartender.token}});assert.ok(r.ok);return r.json();}
async function run(){
 browser=await chromium.launch({channel:'chrome',headless:true});const p=await browser.newPage({viewport:{width:1366,height:768}});p.setDefaultTimeout(10000);p.on('pageerror',e=>errors.push(e.message));await p.addInitScript(a=>{localStorage.setItem('crm_session_token',a.token);localStorage.setItem('crm_session_user',JSON.stringify(a.user));},m.actors.bartender);await p.goto(m.base);await p.waitForFunction(()=>document.querySelector('[data-pos-counter="open"]')?.dataset.state==='ready');
 const first=()=>p.locator(`.table[data-table="${m.ids.tables[0]}"]`);const vip=()=>p.locator(`.table[data-table="${m.ids.tables[6]}"]`);await first().locator('.pos-table-attention').waitFor();assert.match(await first().locator('.pos-table-attention').innerText(),/Бар ожидает/);
 for(const theme of ['dark','light']){
  await p.evaluate(t=>document.body.classList.toggle('light-theme',t==='light'),theme);await p.waitForTimeout(250);
  const zones=p.locator('.tabs [role="tab"]');await zones.first().focus();await p.keyboard.press('ArrowRight');assert.equal(await zones.last().getAttribute('aria-selected'),'true');assert.equal(await zones.last().evaluate(n=>document.activeElement===n),true);await vip().locator('.pos-table-attention').waitFor();assert.match(await vip().locator('.pos-table-attention').innerText(),/готов/);await p.keyboard.press('Home');assert.equal(await zones.first().getAttribute('tabindex'),'0');assert.match(await first().locator('.pos-table-attention').innerText(),/Бар ожидает/);await p.keyboard.press('End');assert.equal(await zones.last().getAttribute('aria-selected'),'true');await p.keyboard.press('ArrowLeft');assert.equal(await zones.first().getAttribute('aria-selected'),'true');
  await p.locator('#floor-density-range').evaluate(input=>{input.value='70';input.dispatchEvent(new Event('input',{bubbles:true}));});await first().locator('.pos-table-attention').waitFor();await p.locator('[data-floor-fit]').click();assert.match(await first().locator('.pos-table-attention').innerText(),/Бар ожидает/);await first().click();assert.equal(await first().getAttribute('aria-pressed'),'true');assert.ok((await p.locator('.table:not(.sel)').evaluateAll(nodes=>nodes.map(n=>n.getAttribute('aria-pressed')))).every(value=>value==='false'));await p.waitForTimeout(200);await p.screenshot({path:path.join(dir,`floor-regression-${theme}-1366.png`)});
 }
 pass('badges survive zone/size/fit changes in both themes; tablist arrows Home End focus');
 const previousTables=await p.locator('.table').count();
 await p.route('**/api/floor',r=>r.fulfill({status:503,contentType:'application/json',body:'{"error":"qa_read_failure"}'}));
 await p.evaluate(()=>window.dispatchEvent(new Event('focus')));
 await p.waitForFunction(()=>document.querySelector('#tables')?.dataset.dataState==='error');
 const feedback=p.locator('#pos-workspace-feedback'),retry=p.locator('[data-pos-floor-retry]');
 await retry.waitFor();assert.match(await feedback.innerText(),/Схема зала не обновлена/);
 assert.equal(await p.locator('.table').count(),previousTables);assert.equal(await p.locator('.pos-table-attention').count(),0);
 assert.ok((await retry.boundingBox()).height>=44);await p.waitForTimeout(150);
 const action=await p.locator('#order-main-action').boundingBox();assert.ok(action&&action.height>=48&&action.y+action.height<=768);
 await p.screenshot({path:path.join(dir,'floor-read-error-retry-1366.png')});await p.unroute('**/api/floor');
 let releaseFloor,markFloorWaiting;const floorWaiting=new Promise(resolve=>{markFloorWaiting=resolve;});
 await p.route('**/api/floor',async r=>{await new Promise(resolve=>{releaseFloor=resolve;markFloorWaiting();});await r.continue();});
 await retry.click();await floorWaiting;await p.locator('[data-pos-view="preparation"]').click();releaseFloor();
 await p.waitForFunction(()=>document.querySelector('#tables')?.dataset.dataState==='ready');
 await p.waitForFunction(()=>document.querySelector('#pos-workspace-feedback')?.hidden);
 assert.equal(await p.locator('[data-pos-view="preparation"]').evaluate(n=>document.activeElement===n),true);
 await p.unroute('**/api/floor');await p.locator('[data-pos-view="floor"]').click();
 await first().locator('.pos-table-attention').waitFor();assert.match(await first().locator('.pos-table-attention').innerText(),/Бар ожидает/);
 pass('background floor503 preserves last tables; delayed retry restores badges without stealing focus; CTA stays visible');
 const orders=await api('/api/orders?withPricing=1'),active=orders.items.find(o=>o.id===m.qaNewOrderId);assert.ok(active);const bar=active.items.find(i=>i.preparationStation==='bar');assert.equal(bar.preparationStatus,'queued');
 const split={...active,id:'qa-render-only-split',status:'ready',items:[{...bar,id:'qa-render-only-ready-line',preparationStatus:'ready'}]};await p.route('**/api/orders?withPricing=1',r=>r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({...orders,items:[...orders.items,split]})}));await p.reload();await p.waitForFunction(()=>document.querySelector('[data-pos-counter="open"]')?.dataset.state==='ready');assert.equal(await first().locator('.pos-table-attention').count(),1);assert.match(await first().locator('.pos-table-attention').innerText(),/Бар ожидает/);assert.doesNotMatch(await first().locator('.pos-table-attention').innerText(),/Бар готов/);await p.unroute('**/api/orders?withPricing=1');pass('split bills aggregate all station lines; one ready split cannot hide waiting bar');
 const floor=await api('/api/floor');const room={...floor,zones:[{...floor.zones[0],tables:floor.zones.flatMap(z=>z.tables)}]};room.zones[0].tables[0]={...room.zones[0].tables[0],name:'Большой стол у панорамного окна — длинное название',layout:{...room.zones[0].tables[0].layout,amenities:{playstation5:true,television:true}}};await p.route('**/api/floor',r=>r.fulfill({status:200,contentType:'application/json',body:JSON.stringify(room)}));await p.reload();await p.waitForFunction(()=>document.querySelector('[data-pos-counter="open"]')?.dataset.state==='ready');assert.equal(await p.locator('.table').count(),10);assert.equal(await first().locator('.table-amenity').count(),2);assert.match(await first().getAttribute('aria-label'),/панорамного окна/);assert.equal(await first().locator('.pos-table-attention').count(),1);assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await p.screenshot({path:path.join(dir,'final-one-room-long-equipment-1366.png')});pass('one room ten tables: long accessible name equipment and badge together, no page overflow');
 await p.unroute('**/api/floor');await p.route('**/api/floor',r=>r.fulfill({status:503,contentType:'application/json',body:'{"error":"qa_initial_read_failure"}'}));
 await p.reload();await retry.waitFor();assert.equal(await p.locator('.table').count(),0);
 assert.match(await feedback.innerText(),/Не удалось загрузить схему зала/);assert.doesNotMatch(await feedback.innerText(),/Показаны последние данные/);
 await p.unroute('**/api/floor');await retry.click();await p.waitForFunction(()=>document.querySelector('#tables')?.dataset.dataState==='ready');
 await p.waitForFunction(()=>document.querySelector('#pos-workspace-feedback')?.hidden);assert.equal(await p.locator('.table').count(),previousTables);
 pass('initial floor503 has truthful unavailable state without invented last data; retry loads actual floor');
 assert.deepEqual(errors,[]);fs.writeFileSync(path.join(dir,'floor-qa.json'),JSON.stringify({createdAt:new Date().toISOString(),environment:'read-only actual API; explicit route overrides only read failure, split and long/equipment rendering, no database writes',results,errors},null,2));
}
run().catch(e=>{console.error(e.stack);process.exitCode=1;}).finally(async()=>{await browser?.close();});
