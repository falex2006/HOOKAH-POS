const {chromium}=require(process.env.PLAYWRIGHT_PACKAGE_PATH || 'playwright');
const {spawn}=require('node:child_process');
const fs=require('node:fs');
const assert=require('node:assert/strict');
(async()=>{
 const server=spawn(process.execPath,['server.js'],{windowsHide:true,env:{...process.env,HOST:'127.0.0.1',PORT:'0',DATABASE_URL:'',API_RATE_LIMIT:'10000',AUTH_REQUIRED:'false',DEMO_MODE:'false',NODE_ENV:'test'},stdio:['ignore','pipe','pipe']});
 let output='';server.stdout.on('data',x=>output+=x);server.stderr.on('data',x=>output+=x);
 let browser;
 try{
  const base=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(output)),15000);server.stdout.on('data',()=>{const m=output.match(/CRM running on http:\/\/localhost:(\d+)/);if(m){clearTimeout(timer);resolve('http://127.0.0.1:'+m[1]);}});});
  browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? {executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH} : {})});
  const page=await browser.newPage({viewport:{width:1586,height:992},locale:'ru-RU'});let errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base+'/login');await page.locator('#login-username').fill('admin');await page.locator('#login-password').fill('admin');await page.locator('#login-form button[type=submit]').click();await page.waitForURL(u=>!u.pathname.includes('/login'));
  for(const [i,name] of ['Соколов Артём Сергеевич','Кузнецова Мария Андреевна','Иванов Дмитрий Алексеевич','Белова Екатерина Игоревна'].entries()){
   const res=await page.request.post(base+'/api/staff',{data:{name,login:'visual_staff_'+i,password:'visual123',role:i===0?'manager':i===1?'hookah_master':'bartender',birthDate:'1995-01-01',phoneNumbers:[{number:'+7 (925) 555-01-0'+i,primary:true,label:'Личный'}],workNotes:['Развиваем культуру. Люди — главное','Хороший кальян начинается с внимания','Внимание в деталях','Вкус в хорошей компании'][i]}});
   assert.equal(res.status(),201,await res.text());
  }
  await page.goto(base+'/admin#staff',{waitUntil:'networkidle'});await page.locator('.staff-card').first().waitFor();
  await page.locator('#staff-search').fill(''); await page.locator('h1').click();
  await page.evaluate(()=>{document.querySelectorAll('.portal-content,.portal-main').forEach(n=>n.scrollTop=0);window.scrollTo(0,0);});
  fs.mkdirSync('tmp/staff-visual',{recursive:true});
  await page.screenshot({path:'tmp/staff-visual/desktop.png',fullPage:true});
  console.log(JSON.stringify(await page.locator('.staff-card').evaluateAll(ns=>ns.map(n=>({name:n.querySelector('h3')?.textContent,width:n.getBoundingClientRect().width,height:n.getBoundingClientRect().height})))));
  const card=page.locator('.staff-card').filter({hasText:'Кузнецова Мария'});await card.locator('.staff-edit').click();await page.locator('.staff-admin-modal').waitFor();await page.locator('.staff-admin-close').click();
  await page.locator('#staff-search').fill('Кузнецова');assert.equal(await page.locator('.staff-card:visible').count(),1);await page.locator('#staff-search').fill('');
  await card.locator('.staff-delete').click();await page.getByRole('button',{name:'Заблокировать',exact:true}).last().click();await card.locator('.staff-restore').waitFor();await card.locator('.staff-restore').click();await card.locator('.staff-delete').waitFor();
  await page.goto(base+'/admin#permissions',{waitUntil:'networkidle'});assert.equal(await page.locator('.staff-catalog-page').count(),0);await page.goto(base+'/admin#tasks');assert.equal(await page.locator('.staff-catalog-page').count(),0);await page.goto(base+'/admin#staff',{waitUntil:'networkidle'});assert.equal(await page.locator('.staff-add-button').count(),1);await page.locator('.staff-card').first().waitFor();
  await card.locator('input[data-avatar]').setInputFiles('assets/brand/icons/favicon-32.png');
  await card.locator('.staff-card-avatar img').waitFor();
  await page.reload({waitUntil:'networkidle'});
  assert.equal(await card.locator('.staff-card-avatar img').evaluate(n=>n.complete && n.naturalWidth>0),true,'avatar persisted');
  for(const hash of ['#permissions','#tasks','#help','#settings','']){
    await page.locator('.staff-add-button').click();
    await page.locator('#staff-name').waitFor({state:'visible'});
    await page.evaluate(hash=>location.hash=hash,hash);
    await page.waitForTimeout(250);
    assert.equal(await page.locator('.staff-drawer.open').count(),0,'old drawer disposed');
    assert.equal(await page.locator('.staff-catalog-heading').count(),0,'catalog heading cleaned');
    assert.equal(await page.locator('.staff-add-button:visible').count(),0,'catalog add button hidden elsewhere');
    await page.evaluate(()=>location.hash='staff');
    await page.waitForTimeout(500);
    await page.locator('.staff-card').first().waitFor();
    assert.equal(await page.locator('.staff-add-button').count(),1);
    assert.equal(await page.locator('.staff-drawer').count(),1,'one drawer after return');
    await page.locator('.staff-add-button').click();
    await page.locator('#staff-name').waitFor({state:'visible'});
    await page.locator('.staff-drawer-close').click();
  }
  for(const width of [1250,1380,1440,1920]){
    await page.setViewportSize({width,height:1000});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'overflow at '+width);
    assert.equal(await page.locator('.staff-card').evaluateAll(nodes=>nodes.every(n=>n.scrollWidth<=n.clientWidth+1)),true,'card overflow at '+width);
  }
  await page.setViewportSize({width:912,height:900});await page.evaluate(()=>{document.querySelector('.portal-main').scrollTop=0;window.scrollTo(0,0);});await page.screenshot({path:'tmp/staff-visual/desktop-narrow.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:'tmp/staff-visual/mobile.png',fullPage:true});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'overflow');
  await page.setViewportSize({width:1586,height:992});
  await page.locator('#logout').click();await page.waitForURL(u=>u.pathname==='/login');
  assert.deepEqual(errors,[]);console.log('PASS staff catalog: create API, render, edit modal, search, block/restore, responsive, no browser errors');
 }finally{await browser?.close();server.kill();}
})().catch(e=>{console.error(e);process.exitCode=1});
