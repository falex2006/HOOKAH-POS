import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_PACKAGE_PATH || 'playwright');
const widths=[[375,812],[768,1024],[1440,900],[1920,1080]];
const nonce=randomBytes(8).toString('hex');
const store='tmp/payroll-owner-demo';
const root=store+'/visual-'+nonce;
const output=root+'/screenshots';
await mkdir(output,{recursive:true});
const instance=JSON.parse(await readFile(store+'/db.local.json','utf8'));
assert.match(instance.name,/^orders_qa_[a-f0-9]{16}$/);
const name='orders_qa_'+nonce;
const {Pool}=require('pg');
const admin=new Pool({host:'127.0.0.1',port:54561,user:'postgres',password:instance.password,database:instance.name});
let server,browser,owned=false;
try {
 await admin.query('CREATE DATABASE "'+name+'"');
 owned=true;
 await writeFile(root+'/db.local.json',JSON.stringify({name,password:instance.password}),{flag:'wx',mode:0o600});
 server=spawn(process.execPath,['scripts/payroll-owner-ux-stand.mjs','--visual-qa'],{windowsHide:true,env:{...process.env,PAYROLL_OWNER_VISUAL_RUN:nonce},stdio:['ignore','pipe','inherit']});
 const base=await new Promise((resolve,reject)=>{
  let ready='';
  const timeout=setTimeout(()=>reject(Error('Isolated demo startup timed out')),90000);
  server.once('exit',code=>{clearTimeout(timeout);reject(Error('Isolated demo exited '+code));});
  server.stdout.on('data',bytes=>{ready+=bytes;const port=ready.match(/CRM running on http:\/\/localhost:(\d+)/);if(port){clearTimeout(timeout);resolve('http://127.0.0.1:'+port[1]);}});
 });
 const fixture=JSON.parse(await readFile(root+'/demo.local.json','utf8'));
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH});
 const page=await browser.newPage({viewport:{width:1440,height:900},locale:'ru-RU'});
 page.setDefaultTimeout(10000);
 const capture=async(stage,anchor)=>{
   await anchor.waitFor({state:'visible'});
   for(const [width,height] of widths){
    await page.setViewportSize({width,height});
    await anchor.evaluate(el=>el.scrollIntoView({block:'center',behavior:'instant'}));
    if(width===1920) {
     const frame=await anchor.boundingBox();
     assert.ok(frame && frame.y>=0 && frame.y+frame.height<=height,
      stage+' Full HD capture must contain the complete subject: '+JSON.stringify(frame));
    }
    await page.screenshot({path:output+'/'+stage+'-'+width+'.png',animations:'disabled'});
    const geometry=await page.evaluate(()=>({outer:document.documentElement.scrollWidth,viewport:innerWidth}));
    assert.ok(geometry.outer<=width+1,stage+' document overflow '+JSON.stringify(geometry));
   }
 };
 const choose=async(selector,value)=>{
   const input=page.locator(selector),wrap=input.locator('..');
   const trigger=wrap.locator('.custom-select-trigger');
   if(await input.isVisible()) await input.selectOption(value);
   else {await trigger.click();await wrap.locator('[data-value="'+value+'"]').click();}
 };
 await page.goto(base+'/login');
 await page.locator('#login-username').fill(fixture.username);
 await page.locator('#login-password').fill(fixture.password);
 await page.locator('#login-form button[type=submit]').click();
 await page.waitForURL(url=>url.pathname!='/login');
 await page.goto(base+'/finance#payroll');
 const summary=page.getByText('Настройки схем и проверка расчётов',{exact:true});
 if(await summary.isVisible() && !(await summary.locator('..').evaluate(n=>n.open))) await summary.click();
 const start=page.locator('[data-payroll-quick-start]');
 await page.getByRole('button',{name:'Настроить ставку',exact:true}).waitFor({state:'visible'});
 const secondary = page.locator('.payroll-other-actions');
 const modelAction = page.locator('#payroll-create-toggle');
 assert.equal(await modelAction.isVisible(),false);
 await secondary.locator('summary').click();
 await modelAction.click();
 assert.equal(await page.locator('#payroll-create-form').isVisible(),true);
 await page.locator('#payroll-create-cancel').click();
 await secondary.locator('summary').click();
 await start.click();
 await choose('[data-quick-employee]',fixture.ids.employee);
 await choose('[data-quick-method]','combined');
 await page.locator('[data-quick-rate]').fill('10');
 await page.locator('[data-quick-percent]').fill('10');
 await page.locator('[data-quick-from]').fill(fixture.period.from);
 await page.locator('[data-scheme-name]').fill('Бармен · смена и процент с продаж');
 await page.locator('[data-quick-sources]').check();
 const ack=page.locator('[data-scheme-risk-acknowledged]');
 if(await ack.isVisible()) await ack.check();
 await capture('01-setup',page.locator('[data-quick-pay]'));
 const [response]=await Promise.all([page.waitForResponse(r=>r.url().endsWith('/api/payroll/schemes') && r.request().method()==='POST'),page.locator('[data-scheme-save]').click()]);
 assert.ok(response.ok(),'save '+response.status()+' '+(await response.text()).slice(0,200));
 const saved=await response.json();
 await choose('[data-trial-employee]',fixture.ids.employee);
 await page.locator('[data-trial-date]').fill(fixture.period.from);
 await page.locator('[data-trial-sales]').fill('100');
 const [trial]=await Promise.all([page.waitForResponse(r=>r.url().endsWith('/preview') && r.request().method()==='POST'),page.locator('[data-trial-run]').click()]);
 assert.equal(trial.status(),200);await page.locator('[data-scheme-preview-result]').waitFor();
 await capture('02-trial',page.locator('[data-scheme-preview-result]'));
 const equation=(await page.locator('.payroll-trial-equation').innerText()).replace(/\s+/g,' ');
 assert.match(equation,/10(?:,00)? ₽ за смену \+ 10% от 100(?:,00)? ₽ = 20(?:,00)? ₽/);
 const command=async(path,control)=>{
  const [reply]=await Promise.all([page.waitForResponse(r=>r.url()===base+path && r.request().method()==='POST'),control.click()]).catch(async error=>{console.error(path, (await page.locator('#payroll').innerText()).slice(-2400));throw error;});
  const text=await reply.text();
  assert.ok(reply.ok(),path+' '+reply.status()+' '+text.slice(0,500));
  return JSON.parse(text);
 };
 await page.reload({waitUntil:'networkidle'});
 await page.getByRole('button',{name:'Проверить ставку',exact:true}).click();
 await page.locator('[data-trial-date]').fill(fixture.period.from);
 await command('/api/payroll/versions/'+saved.versions[0].versionId+'/preview',page.locator('[data-trial-run]'));
 const version=saved.versions[0].versionId;
 await command('/api/payroll/versions/'+version+'/activate',page.locator('[data-trial-official]'));
 await page.waitForFunction(id=>document.querySelector('[data-saved-run-version]')?.value===id && !document.querySelector('[data-saved-run-create]')?.disabled,version);
 await page.getByRole('button',{name:'Рассчитать зарплату',exact:true}).click();
 await page.locator('[data-saved-run-to]').fill(fixture.period.to);
 assert.equal(await page.locator('[data-saved-run-from]').inputValue(),fixture.period.from);
 assert.equal(await page.locator('[data-saved-run-to]').inputValue(),fixture.period.to);
 assert.equal(await page.locator('[data-saved-run-version]').inputValue(),version);
 const run=await command('/api/payroll/refund-aware-calculation-runs',page.locator('[data-saved-run-create]'));
 assert.equal(run.status,'ready',JSON.stringify(run.blockedReasons));
 await page.locator('[data-saved-run-open="'+run.runId+'"]').click();
 const receipt=await command('/api/payroll/calculation-runs/'+run.runId+'/entries',page.locator('[data-saved-entry-create="'+fixture.ids.employee+'"]:not([data-saved-entry-half])'));
 const entry=Object.hasOwn(receipt,'currentEntry')?receipt.currentEntry:receipt.entry;
 assert.equal(entry.amountCents,2000);
 await page.locator('[data-saved-entry-register="'+entry.id+'"]').click();
 const registry=page.locator('article[data-payroll-entry="'+entry.id+'"]');
 await registry.waitFor({state:'visible'});
 await page.waitForFunction(id=>document.querySelector('#payroll-filter-user')?.value===id,fixture.ids.employee);
 assert.equal(await page.locator('#payroll-filter-from').inputValue(),entry.periodFrom);
 assert.equal(await page.locator('#payroll-filter-to').inputValue(),entry.periodTo);
 assert.equal(await page.locator('.finance-view-navigation').isVisible(),false);

 assert.equal(await registry.locator('.payroll-register-amounts dt').count(),4);
 for(const action of ['approve','pay']){
  await registry.locator('[data-payroll-linked-check]').click();
  if(action==='pay') await registry.locator('[data-payroll-payment-date]').fill(fixture.period.to);
  const [reply]=await Promise.all([page.waitForResponse(r=>r.url().endsWith('/'+entry.id+'/transition') && r.request().method()==='POST'),
   registry.locator('[data-payroll-action="'+action+'"]').click()]);
  assert.ok(reply.ok(),action+': '+await reply.text());
  if(action==='pay'){
   const paid=(await reply.json()).entry;
   assert.equal(paid.status,'paid');assert.ok(paid.expenseId);
   const creds=JSON.parse(await readFile(root+'/db.local.json','utf8'));
   const pool=new (require('pg').Pool)({host:'127.0.0.1',port:54561,user:'postgres',database:creds.name,password:creds.password});
   try {
    const result=await pool.query("SELECT (amount*100)::int cents FROM expenses WHERE id=$1 AND venue_id=$2 AND source='payroll'",[paid.expenseId,fixture.ids.venue]);
    assert.deepEqual(result.rows,[{cents:entry.amountCents}]);
    const payrollExpenses = () => pool.query("SELECT id FROM expenses WHERE venue_id=$1 AND source='payroll' ORDER BY id", [fixture.ids.venue]);
    const beforeRetry = await payrollExpenses();
    assert.deepEqual(beforeRetry.rows,[{id:paid.expenseId}]);
    const retry = await page.request.post(reply.url(), { headers: {origin:base}, data:reply.request().postDataJSON() });
    assert.ok(retry.ok(), 'repeat the confirmed payout: '+retry.status());
    const repeatedEntry = (await retry.json()).entry;
    assert.equal(repeatedEntry.expenseId, paid.expenseId);
    assert.deepEqual((await payrollExpenses()).rows, beforeRetry.rows);
    const detail=registry.locator('.payroll-entry-breakdown');
    await detail.locator('summary').click();
    await capture('03-paid', registry);
   } finally {await pool.end();}
  }
 }
 console.log('PASS: payroll owner 3 stages × 4 sizes: '+output);
} finally {
 if(browser) await browser.close();
 if(server && server.exitCode===null && !server.signalCode){const exited=once(server,'exit');server.kill();await exited;}
 try {if(owned) await admin.query('DROP DATABASE "'+name+'"');} finally {await admin.end();}
}
