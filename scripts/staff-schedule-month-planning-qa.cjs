'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto'),net=require('node:net'),{spawn}=require('node:child_process');
const {Pool}=require('pg'),{config,folder,options}=require('./staff-schedule-local-config.cjs');
const {isolatedEnvironment}=require('./staff-schedule-local-env.cjs');
const {chromium}=require(process.env.PLAYWRIGHT_PACKAGE_PATH||'playwright');
async function main(){
 const c=config(),f=JSON.parse(fs.readFileSync(path.join(folder,'fixtures.json'),'utf8')),pool=new Pool(options(c)),id=randomUUID(),label=`Месяц QA ${id.slice(0,8)}`;let browser,server;
 try{
  await pool.query("INSERT INTO users(id,venue_id,organization_id,full_name,login,role) VALUES($1,$2,$3,$4,$5,'bartender')",[id,f.venues[0],f.organizations[0],label,`${id}@example.test`]);
  const root=path.join(__dirname,'..'),probe=net.createServer();await new Promise((resolve,reject)=>{probe.once('error',reject);probe.listen(0,'127.0.0.1',resolve);});const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  server=spawn(process.execPath,[path.join(root,'server.js')],{cwd:root,env:{...isolatedEnvironment(c,f),PORT:String(port)},stdio:'ignore',windowsHide:true});let serverReady=false;
  for(let i=0;i<100;i++){if(server.exitCode!==null)throw new Error('Isolated month planning server exited');try{if((await fetch(`http://127.0.0.1:${port}/api/health`,{signal:AbortSignal.timeout(500)})).ok){serverReady=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,100));}assert.ok(serverReady,'isolated month planning server readiness');
  browser=await chromium.launch({channel:'msedge',headless:true});const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage(),errors=[];
    const failedApi=[];page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());page.on('response',r=>{if(r.url().includes('/api/staff/schedule')&&r.status()>=400)failedApi.push({url:r.url(),status:r.status()});});
  const base=`http://127.0.0.1:${port}`,login=await context.request.post(base+'/api/login',{data:{username:f.users[0].login,password:f.password}});assert.equal(login.status(),200);
  const session=await login.json();await context.addInitScript(({token,user})=>{localStorage.setItem('crm_session_token',token);localStorage.setItem('crm_session_user',JSON.stringify(user));},session);
  const top=()=>page.locator('dialog[open]').last();
  const saveWithWarnings=async dialog=>{const closed=page.locator('dialog[open]').waitFor({state:'hidden',timeout:5000}).then(()=>false,()=>false),warned=dialog.locator('[name=confirmWarnings]').waitFor({state:'visible',timeout:5000}).then(()=>true,()=>false);if(await Promise.race([closed,warned])){await dialog.locator('[name=confirmWarnings]').check();const reason=dialog.locator('[name=reason]');if(await reason.count()&&!(await reason.inputValue()).trim())await reason.fill('QA подтверждает тестовую смену вне настроенных интервалов');await dialog.locator('[type=submit]').click();}await page.locator('dialog[open]').waitFor({state:'hidden'});};
  const ready=async()=>{const started=Date.now();try{await page.waitForFunction(()=>{const b=document.querySelector('[data-create]');return b&&!b.disabled;},null,{timeout:15000});const elapsed=Date.now()-started;if(elapsed>5000)throw new Error(`Calendar UI readiness exceeded 5s (${elapsed}ms)`);}catch(error){const state=await page.evaluate(()=>({date:document.querySelector('[data-date]')?.value,mode:document.querySelector('[data-mode]')?.value,status:document.querySelector('[data-status]')?.textContent,disabled:document.querySelector('[data-create]')?.disabled})).catch(()=>({pageUnavailable:true}));console.error('MONTH PLANNING NOT READY',JSON.stringify({state,failedApi,errors}));throw error;}};
  await page.goto(base+'/admin#staff-schedule');await ready();
  const today=await page.locator('[data-date]').inputValue(),next=new Date(today.slice(0,7)+'-01T12:00Z');next.setUTCMonth(next.getUTCMonth()+1);
  const start=next.toISOString().slice(0,10),month=start.slice(0,7),end=new Date(Date.UTC(next.getUTCFullYear(),next.getUTCMonth()+1,0,12)).toISOString().slice(0,10);
  await page.locator('[data-month-jump]').selectOption('next');await ready();assert.equal(await page.locator('[data-mode]').inputValue(),'month');assert.equal(await page.locator('[data-date]').inputValue(),start);
  await page.locator('[data-person]').selectOption(id);await page.locator(`[data-open-day="${month}-05"]`).click();await ready();
  await page.locator('[data-create]').click();let d=top();await d.locator('[name=userId]').selectOption(id);await d.locator('[name=kind]').selectOption('day_off');await d.locator('[type=submit]').click();await page.locator('dialog[open]').waitFor({state:'hidden'});await ready();
  let rows=(await pool.query('SELECT id,work_date::text,kind,version FROM staff_schedules WHERE user_id=$1',[id])).rows;assert.equal(rows.length,1);assert.equal(rows[0].work_date,month+'-05');assert.equal(rows[0].kind,'day_off');const dayOff=rows[0];
  await page.locator('[data-create]').click();d=top();await d.locator('[name=userId]').selectOption(id);await d.locator('[name=start]').fill(month+'-05T20:00');await d.locator('[name=end]').fill(month+'-06T04:00');await d.locator('[name=workDate]').fill(month+'-07');await d.locator('[name=workDate]').dispatchEvent('change');
  assert.equal(await d.locator('[name=start]').inputValue(),month+'-07T20:00');assert.equal(await d.locator('[name=end]').inputValue(),month+'-08T04:00');await d.locator('[type=submit]').click();await saveWithWarnings(d);await ready();
  rows=(await pool.query('SELECT kind,work_date::text FROM staff_schedules WHERE user_id=$1 ORDER BY work_date',[id])).rows;assert.equal(rows.length,2);assert.equal(rows[1].work_date,month+'-07');
  await page.reload();await ready();await page.locator('[data-month-jump]').selectOption('next');await ready();await page.locator('[data-person]').selectOption(id);
  assert.ok((await page.locator(`[data-open-day="${month}-05"]`).innerText()).includes('Выходной'));assert.ok((await page.locator(`[data-open-day="${month}-07"]`).innerText()).includes('20:00'));
  await page.locator('[data-planning]').click();await page.locator('[data-new-draft]').click();d=top();assert.equal(await d.locator('[name=from]').inputValue(),start);assert.equal(await d.locator('[name=to]').inputValue(),end);
  await d.locator('[name=periodPreset]').selectOption('next');assert.equal(await d.locator('[name=from]').inputValue(),start);assert.equal(await d.locator('[name=to]').inputValue(),end);
  await d.locator('[name=name]').fill(label);await d.locator(`[name=person][value="${id}"]`).check();await d.locator('[type=submit]').click();await page.locator('[data-range]').click();d=top();
  for(const el of await d.locator('[name=weekday]').all())await el.check();await d.locator('[data-range-preview]').click();await d.locator('[data-range-result]').filter({hasText:'Пересекающиеся'}).waitFor();assert.equal(await d.locator('[type=submit]').isDisabled(),true);
  assert.equal(Number((await pool.query('SELECT count(*) FROM staff_schedules WHERE user_id=$1',[id])).rows[0].count),2);
  assert.deepEqual((await pool.query('SELECT id,work_date::text,kind,version FROM staff_schedules WHERE id=$1',[dayOff.id])).rows[0],dayOff);
  // Server independently rejects conflicting range application; UI disabling is not the only guard.
  const draft=(await pool.query('SELECT id,version FROM staff_schedule_drafts WHERE name=$1',[label])).rows[0];
  const headers={Authorization:`Bearer ${session.token}`,Origin:base},query={version:draft.version,from:start,to:end,userIds:[id],definition:{pattern:{type:'weekdays',weekdays:[1,2,3,4,5,6,7]},slots:[{kind:'shift',startTime:'10:00',endTime:'18:00',endDayOffset:0,breakMinutes:0,note:''}]}};
  const preview=await context.request.post(base+`/api/staff/schedule/drafts/${draft.id}/range-preview`,{headers,data:query});assert.equal(preview.status(),200);const result=await preview.json();assert.ok(result.conflicts.length);
  const apply=await context.request.post(base+`/api/staff/schedule/drafts/${draft.id}/range-apply`,{headers,data:{...query,fingerprint:result.fingerprint,requestKey:randomUUID()}});assert.equal(apply.status(),409);
  // Calendar arithmetic: year boundary, leap February, and editable custom dates.
  for(const [selected,last] of [['2031-12-17','2031-12-31'],['2032-02-12','2032-02-29']]){
   await page.reload();await ready();await page.locator('[data-date]').fill(selected);await page.locator('[data-date]').dispatchEvent('change');await ready();await page.locator('[data-planning]').click();await page.locator('[data-new-draft]').click();d=top();assert.equal(await d.locator('[name=from]').inputValue(),selected);assert.equal(await d.locator('[name=to]').inputValue(),last);
   await d.locator('[name=periodPreset]').selectOption('month');assert.equal(await d.locator('[name=from]').inputValue(),selected.slice(0,7)+'-01');
   await d.locator('[name=to]').fill('2032-03-03');assert.equal(await d.locator('[name=periodPreset]').inputValue(),'custom');
  }
  await page.reload();await ready();
  for(const width of [1440,768,375,320]){
   await page.setViewportSize({width,height:900});
   const monthJump=page.locator('[data-month-jump]'),monthJumpLabel=monthJump.locator('..');
   if(width>480){
    const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/staff/schedule'&&r.request().method()==='GET');
    await monthJumpLabel.locator('.custom-select-trigger').click();
    await monthJumpLabel.locator('[data-value="next"]').click();
    assert.equal((await response).status(),200);await ready();
    assert.equal(await page.locator('[data-mode]').inputValue(),'month');
    assert.match(await page.locator('[data-date]').inputValue(),/\d{4}-\d{2}-01/);
   }else assert.equal(await monthJumpLabel.isVisible(),false,'redundant month jump is intentionally hidden on phone; date navigation remains available');
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`overflow ${width}`);
   await page.screenshot({path:path.join(folder,`month-planning-${width}.png`)});
  }
  assert.deepEqual(errors,[]);console.log('MONTH PLANNING: PASS (future day off/overnight shift, DB/reload, month presets, leap/year boundary, custom period, existing-record conflict preserved, server409, four viewports)');
 }finally{if(browser)await browser.close();if(server&&server.exitCode===null){server.kill();await Promise.race([new Promise(resolve=>server.once('exit',resolve)),new Promise(resolve=>setTimeout(resolve,3000))]);}await pool.end();}
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
