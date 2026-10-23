const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {spawn}=require('node:child_process');
const {chromium}=require(process.env.PLAYWRIGHT_PACKAGE_PATH||'playwright');
const orderId='33333333-3333-4333-8333-333333333333',paymentId='11111111-1111-4111-8111-111111111111',accountId='44444444-4444-4444-8444-444444444444';
const order={id:orderId,tableName:'QA Стол 1',guestName:'QA Гость',status:'closed',finalTotal:1000,createdAt:'2026-10-23T09:00:00Z',items:[{name:'QA Чай',quantity:2,unitPrice:500}]};
const payments={items:[{id:paymentId,method:'cash',status:'paid',amount:1000,createdAt:'2026-10-23T09:15:00Z',paymentAccountId:accountId}],posPaymentAccounts:[{id:accountId,name:'QA Касса заведения с длинным названием для проверки отображения',kind:'pos_cashbox',allowedPaymentMethods:['cash']}]};
payments.items[0].amount=700;
payments.items.push({id:'22222222-2222-4222-8222-222222222222',method:'card',status:'paid',amount:300,createdAt:'2026-10-23T09:16:00Z',paymentAccountId:'55555555-5555-4555-8555-555555555555'});
payments.posPaymentAccounts.push({id:'55555555-5555-4555-8555-555555555555',name:'QA Расчётный счёт заведения с длинным названием для проверки',kind:'bank',allowedPaymentMethods:['card']});
const refunds={lineSnapshotStatus:'complete',returnableItems:[{orderItemId:'66666666-6666-4666-8666-666666666666',soldQuantity:'2',returnedQuantity:'0',netMinor:100000,returnedItemValueMinor:0,productFacts:{productName:'QA Чай с длинным названием'}}],items:[]};
const waitForRead=promise=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Controlled GET did not start')),5000);promise.then(value=>{clearTimeout(timer);resolve(value);},error=>{clearTimeout(timer);reject(error);});});
(async()=>{
 const root=path.resolve(__dirname,'..'),folder=path.join(root,'tmp/order-refund-display-browser-qa');fs.mkdirSync(folder,{recursive:true});
 const server=spawn(process.execPath,['server.js'],{cwd:root,windowsHide:true,env:{...process.env,HOST:'127.0.0.1',PORT:'0',DATABASE_URL:'',AUTH_REQUIRED:'true',DEMO_MODE:'false',DEMO_OWNER_PASSWORD:'demo',DEMO_STAFF_PASSWORD:'demo',NODE_ENV:'test',API_RATE_LIMIT:'10000'},stdio:['ignore','pipe','pipe']});
 let browser;
 try{
  const base=await new Promise((resolve,reject)=>{let output='';const timeout=setTimeout(()=>reject(Error('QA server start timeout')),15000);server.stdout.on('data',chunk=>{output+=chunk;const port=output.match(/CRM running on http:\/\/localhost:(\d+)/)?.[1];if(port){clearTimeout(timeout);resolve('http://127.0.0.1:'+port);}});server.stderr.on('data',()=>{});server.once('error',reject);server.once('exit',code=>{clearTimeout(timeout);reject(Error('QA server exited '+code));});});
  const seed=await fetch(base+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'owner',password:'demo'})}).then(r=>r.json());
  const seeded=await fetch(base+'/api/staff',{method:'POST',headers:{authorization:'Bearer '+seed.token,'content-type':'application/json'},body:JSON.stringify({name:'QA Просмотр финансов',role:'manager',login:'qa_manager',password:'demo',birthDate:'1990-01-01'})});assert.equal(seeded.status,201);
  await fetch(base+'/api/logout',{method:'POST',headers:{authorization:'Bearer '+seed.token}});
  browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH}:{})});
  const errors=[],calls=[];
  const setup=async username=>{
   const context=await browser.newContext({viewport:{width:1440,height:1000},locale:'ru-RU'}),page=await context.newPage();page.setDefaultTimeout(8000);
   let failRead=false,hold=false,releases=[],readStarted;
   page.on('pageerror',error=>errors.push(error.message));
   await page.route('**/api/**',async route=>{
    const req=route.request(),url=new URL(req.url());
    if(url.pathname==='/api/orders')return route.fulfill({json:{items:[order]}});
    if(url.pathname===`/api/orders/${orderId}/payments`||url.pathname===`/api/finance/orders/${orderId}/refunds`){
     calls.push({method:req.method(),path:url.pathname});assert.equal(req.method(),'GET','this test never submits a refund');
     if(hold)await new Promise(resolve=>{releases.push(resolve);if(releases.length===2)readStarted?.();});
     return route.fulfill(failRead?{status:503,json:{error:'order_refunds_unavailable'}}:{json:url.pathname.endsWith('/payments')?payments:refunds});
    }
    return route.continue();
   });
   await page.goto(base+'/login');await page.locator('#login-username').fill(username);await page.locator('#login-password').fill('demo');await page.getByRole('button',{name:'Войти в систему',exact:true}).click();await page.waitForURL(url=>!url.pathname.includes('/login'));
   await page.goto(base+'/orders',{waitUntil:'networkidle'});
   return{page,context,fail(value){failRead=value;},hold(){hold=true;releases=[];return new Promise(resolve=>{readStarted=resolve;});},release(){hold=false;releases.splice(0).forEach(resolve=>resolve());}};
  };
  const owner=await setup('owner'),page=owner.page,opener=page.locator('[data-order-refunds]'),dialog=page.locator('.order-refund-dialog');
  await opener.click();await dialog.locator('[data-order-refund-form]').waitFor();
  for(const width of [320,390,768,1440]){
   await page.setViewportSize({width,height:width<500?844:1000});
   for(const row of await dialog.locator('.order-refund-payment:not(.order-refund-item)').all()){
   const fields=await row.locator('input[data-refund-source],.custom-select-trigger').evaluateAll(nodes=>nodes.map(e=>{const r=e.getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height,bottom:r.bottom};}));
   assert.ok(await row.locator('.custom-select-trigger').evaluateAll(nodes=>nodes.every(e=>parseFloat(getComputedStyle(e).paddingRight)>=36)),'select text reserves arrow space at '+width);
   assert.equal(fields.length,3);assert.ok(fields.every(r=>r.h>=44));assert.ok(Math.abs(fields[0].y-fields[1].y)<1,'amount and payout align at '+width);
   if(width<=700){assert.ok(fields[2].y>fields[0].bottom);assert.ok(fields[2].w>fields[0].w*1.8);}
   else assert.ok(Math.abs(fields[1].y-fields[2].y)<1,'all payment controls share row at '+width);
   }
   assert.equal(await dialog.evaluate(e=>e.scrollWidth>e.clientWidth),false);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
   await page.screenshot({path:path.join(folder,`owner-${width}.png`)});
  }
  await page.setViewportSize({width:390,height:844});
  await dialog.locator('[data-refund-source]').first().fill('100');await dialog.locator('[name="noItemReturn"]').check();await dialog.locator('[name="reason"]').fill('QA Проверка формы без отправки');
  assert.equal(await dialog.locator('[data-refund-footer] [type="submit"]').isEnabled(),true,'valid visible input enables the action without submitting');assert.match(await dialog.locator('[data-refund-total]').innerText(),/100/);
  const account=dialog.locator('[data-refund-account]').last().locator('..').locator('.custom-select-trigger');await account.click();
  const popup=dialog.locator('[role="listbox"]:visible');await popup.waitFor();
  const box=await popup.boundingBox();assert.ok(box.x>=0&&box.x+box.width<=390);
  await page.screenshot({path:path.join(folder,'account-options-390.png')});
  await page.keyboard.press('Escape');assert.equal(await dialog.isVisible(),true);assert.equal(await popup.count(),0);
  await dialog.locator('[name="reason"]').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(folder,'details-390.png')});
  await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});assert.equal(await opener.evaluate(e=>e===document.activeElement),true);
  owner.fail(true);await opener.click();await dialog.locator('[data-refund-retry]').waitFor();assert.equal(await dialog.locator('[role="alert"]').count(),1);
  await page.screenshot({path:path.join(folder,'error-390.png')});
  const readStarted=owner.hold();await dialog.locator('[data-refund-retry]').click();await waitForRead(readStarted);
  assert.equal(await dialog.locator('[data-refund-retry]').count(),0,'retry disappears while loading, no duplicate click target');
  assert.equal(await dialog.locator('[data-refund-content] [role="status"]:visible').count(),1);
  assert.equal(await dialog.locator('[data-refund-close]').evaluate(e=>e===document.activeElement),true,'focus survives removal of retry');
  owner.release();await dialog.locator('[data-refund-retry]').waitFor();owner.fail(false);
  await dialog.locator('[data-refund-retry]').click();await dialog.locator('[data-order-refund-form]').waitFor();assert.equal(await dialog.locator('[data-refund-close]').evaluate(e=>e===document.activeElement),true);
  await dialog.locator('[data-refund-close]').click();assert.equal(await opener.evaluate(e=>e===document.activeElement),true);
  const lateStarted=owner.hold();await opener.click();await waitForRead(lateStarted);await page.keyboard.press('Escape');owner.release();await page.waitForLoadState('networkidle');assert.equal(await dialog.isVisible(),false,'late GET does not reopen a closed dialog');assert.equal(await opener.evaluate(e=>e===document.activeElement),true);
  const manager=await setup('qa_manager');await manager.page.locator('[data-order-refunds]').click();const readOnly=manager.page.locator('.order-refund-dialog');await readOnly.getByText('Возвратов по этому заказу пока нет.',{exact:true}).waitFor();assert.equal(await readOnly.locator('[data-order-refund-form]').count(),0);assert.equal(await readOnly.locator('[data-refund-source],[data-refund-item]').count(),0);assert.match(await readOnly.innerText(),/Получено: 700/);assert.match(await readOnly.innerText(),/Получено: 300/);
  await manager.page.setViewportSize({width:320,height:844});await manager.page.screenshot({path:path.join(folder,'manager-320.png')});await readOnly.locator('[data-refund-close]').click();assert.equal(await manager.page.locator('[data-order-refunds]').evaluate(e=>e===document.activeElement),true);
  assert.ok(calls.length>0);assert.ok(calls.every(c=>c.method==='GET'));assert.deepEqual(errors,[]);
  console.log('PASS: refund display 320/390/768/1440, source controls alignment, popup/Escape, GET503/retry/live roles/focus/late-close; synthetic GET documents, no refund POST or SQL acceptance');
 }finally{await browser?.close();server.kill();}
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
