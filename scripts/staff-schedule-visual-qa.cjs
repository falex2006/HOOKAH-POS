'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {randomUUID}=require('node:crypto');
const {Pool}=require('pg');
const {config,folder,options}=require('./staff-schedule-local-config.cjs');
const {save}=require('../staff-schedule-service');
const {chromium}=require(process.env.PLAYWRIGHT_PACKAGE_PATH || 'playwright');
async function main(){
  const c=config(),f=JSON.parse(fs.readFileSync(path.join(folder,'fixtures.json'),'utf8')),pool=new Pool(options(c));
  const employee=randomUUID(),principal={userId:f.users[0].id,venueId:f.venues[0]};let browser;
  try{
    await pool.query("INSERT INTO users(id,venue_id,organization_id,full_name,login,role) VALUES($1,$2,$3,$4,$5,'bartender')",[employee,principal.venueId,f.organizations[0],'Александра Константинопольская — старший администратор',`${employee}@example.test`]);
    for(const [day,start,end] of [['07','08:00','12:00'],['07','13:00','17:00'],['07','18:00','22:00'],['08','20:00','04:00']]) await save(pool,principal,{userId:employee,workDate:`2026-12-${day}`,plannedStart:`2026-12-${day}T${start}+05:00`,plannedEnd:`2026-12-${day==='08'?'09':day}T${end}+05:00`,breakMinutes:30,requestKey:randomUUID(),reason:'Visual QA',confirmWarnings:true});
    for(const [day,kind] of [['10','day_off'],['11','vacation'],['12','sick']]) await save(pool,principal,{userId:employee,workDate:`2026-12-${day}`,kind,requestKey:randomUUID(),reason:'Visual QA'});
    browser=await chromium.launch({channel:'msedge',headless:true});const context=await browser.newContext(),page=await context.newPage(),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    const base=`http://127.0.0.1:${c.appPort}`,login=await context.request.post(base+'/api/login',{data:{username:f.users[0].login,password:f.password}});assert.equal(login.status(),200);
    await context.addInitScript(({token,user})=>{localStorage.setItem('crm_session_token',token);localStorage.setItem('crm_session_user',JSON.stringify(user));},await login.json());
    await page.goto(base+'/admin#staff-schedule');await page.locator('[data-context]').filter({hasText:'Asia/Yekaterinburg'}).waitFor({state:'attached'});
    await page.locator('[data-person]').selectOption(employee);await page.locator('[data-date]').fill('2026-12-07');await page.locator('[data-date]').dispatchEvent('change');
    await page.locator('[data-context]').filter({hasText:'18 ч по плану'}).waitFor({state:'attached'});
    const viewControl=page.locator('[data-mode]').locator('..');
    await viewControl.locator('.custom-select-trigger').click();
    await viewControl.locator('[data-value="month"]').click();
    await page.locator('.schedule-month.schedule-days').waitFor();
    await viewControl.locator('.custom-select-trigger').click();
    await viewControl.locator('[data-value="week"]').click();
    await page.locator('.schedule-week').waitFor();
    for(const theme of ['dark','light']){
      await page.evaluate(theme=>{document.body.classList.toggle('light-theme',theme==='light');document.documentElement.dataset.theme=theme;},theme);
      for(const width of [1440,768,375,320]){
        await page.setViewportSize({width,height:1000});await page.waitForTimeout(350);
        assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`${theme}/${width} overflow`);
        await page.screenshot({path:path.join(folder,`dense-${theme}-${width}.png`),fullPage:true});
        if(width<1100){await page.locator('.schedule-mobile section').first().scrollIntoViewIfNeeded();await page.screenshot({path:path.join(folder,`cards-${theme}-${width}.png`)});await page.locator('.schedule-heading').scrollIntoViewIfNeeded();}
        for(const mode of ['month','day']){
          await viewControl.locator('.custom-select-trigger').click();
          await viewControl.locator(`[data-value="${mode}"]`).click();
          await page.locator(mode==='month'?'.schedule-month.schedule-days':width>1100?'.schedule-timeline':'.schedule-day-detail').waitFor();
          if(mode==='day')await page.locator('.schedule-day-detail').waitFor();
          assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`${mode}/${theme}/${width} overflow`);
          await page.screenshot({path:path.join(folder,`${mode}-${theme}-${width}.png`),fullPage:true});
        }
        await viewControl.locator('.custom-select-trigger').click();
        await viewControl.locator('[data-value="week"]').click();
        await page.locator('[data-context]').filter({hasText:'18 ч по плану'}).waitFor({state:'attached'});
      }
      await page.locator('[data-create]').click();const dialog=page.locator('dialog[open]');
      await dialog.locator('[name=userId]').selectOption(employee);
      await page.screenshot({path:path.join(folder,`editor-${theme}-320.png`)});
      assert.ok(await dialog.evaluate(el=>el.getBoundingClientRect().width<=innerWidth));
      const discard=page.waitForEvent('dialog').then(async prompt=>{
        assert.equal(prompt.type(),'confirm');assert.match(prompt.message(),/несохранённые изменения/i);await prompt.accept();
      });
      await page.keyboard.press('Escape');await discard;await dialog.waitFor({state:'detached'});
    }
    assert.deepEqual(errors,[]);console.log('DENSE VISUAL: PASS render/no overflow 1440/768/375/320 dark/light, overnight/absence/multiple shifts/long name, editor Escape; screenshots require visual inspection.');
  }finally{await browser?.close();await pool.end();}
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
