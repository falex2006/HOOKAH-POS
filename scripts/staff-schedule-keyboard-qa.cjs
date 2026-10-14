'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {config,folder}=require('./staff-schedule-local-config.cjs');
const {chromium}=require(process.env.PLAYWRIGHT_PACKAGE_PATH || 'playwright');
async function main(){
  const c=config(),f=JSON.parse(fs.readFileSync(path.join(folder,'fixtures.json'),'utf8')),browser=await chromium.launch({channel:'msedge',headless:true});
  try{
    const context=await browser.newContext(),page=await context.newPage(),base=`http://127.0.0.1:${c.appPort}`;
    const login=await context.request.post(base+'/api/login',{data:{username:f.users[0].login,password:f.password}});assert.equal(login.status(),200);
    await context.addInitScript(({token,user})=>{localStorage.setItem('crm_session_token',token);localStorage.setItem('crm_session_user',JSON.stringify(user));},await login.json());
    await page.goto(base+'/admin#staff-schedule');await page.locator('[data-context]').filter({hasText:'Asia/Yekaterinburg'}).waitFor({state:'attached'});
    await page.locator('[data-create]').focus();await page.keyboard.press('Enter');await page.locator('dialog[open]').waitFor();
    async function tab(key){
      await page.keyboard.press(key);
      const focus=await page.evaluate(()=>({inside:document.querySelector('dialog[open]').contains(document.activeElement),tag:document.activeElement.tagName}));
      if(!focus.inside){
        // Native modal permits browser chrome focus, represented by BODY. It
        // must never expose a background control, and the next Tab must return.
        assert.equal(focus.tag,'BODY','Background control received focus');
        await page.keyboard.press(key);
        assert.ok(await page.evaluate(()=>document.querySelector('dialog[open]').contains(document.activeElement)),'Focus did not return from browser chrome');
      }
    }
    for(let i=0;i<25;i++)await tab('Tab');
    for(let i=0;i<5;i++)await tab('Shift+Tab');
    await page.keyboard.press('Escape');await page.locator('dialog[open]').waitFor({state:'detached'});
    assert.ok(await page.locator('[data-create]').evaluate(el=>el===document.activeElement),'Focus not restored');
    await page.keyboard.press('Enter');
    const editor=page.locator('dialog[open]');
    await editor.locator('[name=note]').fill('Keyboard unsaved draft');
    const keep=page.waitForEvent('dialog').then(async prompt=>{
      assert.equal(prompt.type(),'confirm');assert.match(prompt.message(),/несохранённые изменения/i);await prompt.dismiss();
    });
    await page.keyboard.press('Escape');await keep;
    assert.equal(await editor.locator('[name=note]').inputValue(),'Keyboard unsaved draft');
    const discard=page.waitForEvent('dialog').then(async prompt=>{
      assert.equal(prompt.type(),'confirm');assert.match(prompt.message(),/несохранённые изменения/i);await prompt.accept();
    });
    await page.keyboard.press('Escape');await discard;await editor.waitFor({state:'detached'});
    assert.ok(await page.locator('[data-create]').evaluate(el=>el===document.activeElement),'Dirty close restores focus');
    console.log('KEYBOARD PASS: Enter opens; Tab/Shift+Tab do not focus background controls (native browser-chrome transition returns); Escape restores invoking control. No saves.');
  }finally{await browser.close();}
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
