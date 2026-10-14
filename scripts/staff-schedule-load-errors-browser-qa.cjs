'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {config,folder}=require('./staff-schedule-local-config.cjs');
const {chromium}=require(process.env.PLAYWRIGHT_PACKAGE_PATH || 'playwright');
async function main() {
  const c=config(),f=JSON.parse(fs.readFileSync(path.join(folder,'fixtures.json'),'utf8'));
  const browser=await chromium.launch({channel:'msedge',headless:true});
  try {
    const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage(),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    const base=`http://127.0.0.1:${c.appPort}`;
    const login=await context.request.post(base+'/api/login',{data:{username:f.users[0].login,password:f.password}});
    assert.equal(login.status(),200);
    await context.addInitScript(({token,user})=>{localStorage.setItem('crm_session_token',token);localStorage.setItem('crm_session_user',JSON.stringify(user));},await login.json());
    let failEmployees=true,failList=false;
    await page.route('**/api/staff/schedule**',async route=>{
      const url=new URL(route.request().url());
      if ((failEmployees&&url.pathname.endsWith('/employees')) || (failList&&url.pathname==='/api/staff/schedule')) {
        return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'schedule_unavailable'})});
      }
      return route.continue();
    });
    await page.goto(base+'/admin#staff-schedule');
    await page.locator('[data-status]').filter({hasText:'Нажмите «Обновить»'}).waitFor();
    assert.equal(await page.locator('[data-date]').isDisabled(),true);
    failEmployees=false;
    await page.locator('[data-refresh]').click();
    await page.locator('[data-context]').filter({hasText:'Asia/Yekaterinburg'}).waitFor({state:'attached'});
    assert.equal(await page.locator('[data-copy-week]').count(),1);
    assert.equal(await page.locator('[data-create]').isDisabled(),false);
    failList=true;
    await page.locator('[data-next]').click();
    await page.locator('[data-status]').filter({hasText:'Нажмите «Обновить»'}).waitFor();
    assert.equal(await page.locator('[data-grid]').innerText(),'');
    assert.equal(await page.locator('[data-context]').innerText(),'');
    assert.equal(await page.locator('[data-create]').isDisabled(),true);
    assert.equal(await page.locator('[data-copy-week]').isDisabled(),true);
    await page.locator('[data-person]').dispatchEvent('change');
    assert.equal(await page.locator('[data-entry]').count(),0);
    failList=false;
    await page.locator('[data-refresh]').click();
    await page.locator('[data-context]').filter({hasText:'Asia/Yekaterinburg'}).waitFor({state:'attached'});
    assert.equal(await page.locator('[data-create]').isDisabled(),false);
    assert.equal(await page.locator('[data-copy-week]').count(),1);
    assert.deepEqual(errors,[]);
    console.log('SCHEDULE LOAD ERRORS BROWSER: PASS initialization503 retry, list503 clears stale data/disables edits, filter cannot restore stale data, retry restores controls without duplication; no pageerror.');
  } finally {await browser.close();}
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
