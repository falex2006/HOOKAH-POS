const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE_PATH || 'playwright');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const assert = require('node:assert/strict');
(async () => {
  const server = spawn(process.execPath, ['server.js'], { windowsHide:true, env:{...process.env, HOST:'127.0.0.1',PORT:'0',DATABASE_URL:'',AUTH_REQUIRED:'false',DEMO_MODE:'false',NODE_ENV:'test',DEMO_OWNER_PASSWORD:'demo',API_RATE_LIMIT:'10000'},stdio:['ignore','pipe','pipe'] });
  let output='';server.stdout.on('data',d=>output+=d);server.stderr.on('data',d=>output+=d);let browser;
  try {
    const base=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(output)),15000);server.stdout.on('data',()=>{const m=output.match(/CRM running on http:\/\/localhost:(\d+)/);if(m){clearTimeout(timer);resolve('http://127.0.0.1:'+m[1]);}});});
    browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH});
    const page=await browser.newPage({viewport:{width:1440,height:1000},locale:'ru-RU',reducedMotion:'reduce'});const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(base+'/login');await page.locator('#login-username').fill('owner');await page.locator('#login-password').fill('demo');await page.locator('#login-form button[type=submit]').click();await page.waitForURL(u=>u.pathname!='/login');
    const asset=await page.request.get(base+'/help-content.js');assert.equal(asset.status(),200);assert.match(asset.headers()['content-type'],/javascript/);
    await page.goto(base+'/inventory?view=directories');await page.locator('#inventory-directory-help').click();await page.locator('.directory-help-content details').first().waitFor();
    const normalize=s=>s.replace(/\s+/g,' ').trim();const original=normalize(await page.locator('.directory-help-content').textContent());
    await page.locator('.directory-help-footer a').click();await page.locator('[data-help-article="inventory-directories"][open]').waitFor();
    assert.equal(normalize(await page.locator('[data-help-article="inventory-directories"] .knowledge-guide-content').textContent()),original,'local guide and KB use identical full text');
    assert.equal(await page.locator('[data-help-article]').count(),4);assert.equal(await page.locator('[data-help-article][open]').count(),1);assert.equal(await page.locator('[data-help-article="inventory-directories"] > summary').evaluate(node=>node.tabIndex),0,'deep-linked article remains keyboard focusable');
    for(const [id,count] of [['inventory-directories',6],['staff-schedule',15],['staff-attendance',7]]){assert.equal(await page.locator(`[data-help-article="${id}"] .knowledge-guide-content > details`).count(),count);}
    fs.mkdirSync('tmp/shared-help-visual',{recursive:true});
    for(const width of [320,390,768,1440]){
      await page.setViewportSize({width,height:900});await page.locator('[data-help-article="inventory-directories"]').scrollIntoViewIfNeeded();
      const menu=page.locator('.sidebar-mobile-toggle');if(width<=800&&await menu.getAttribute('aria-expanded')==='true')await menu.click();
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,'KB fits '+width);
      await page.screenshot({path:`tmp/shared-help-visual/knowledge-${width}.png`});
    }
    await page.goto(base+'/admin?helpTopic=unknown#help');await page.locator('[data-help-article]').first().waitFor();assert.equal(await page.locator('[data-help-article][open]').count(),0,'unknown topic does not expand/inject content');
    // New document: fail the first module fetch; the retry must make a new real request.
    let failed=true;await page.route('**/help-content.js?*',route=>failed?route.fulfill({status:503,contentType:'application/javascript',body:'unavailable'}):route.continue());
    await page.reload();await page.locator('[data-knowledge-retry]').waitFor();failed=false;await page.locator('[data-knowledge-retry]').click();await page.locator('[data-help-article]').first().waitFor();await page.unroute('**/help-content.js?*');
    await page.setViewportSize({width:1440,height:1000});
    // Read-only schedule response fixtures: exercise real help UI without requiring a PostgreSQL scheduling database.
    const scheduleAccess = { view:true, self:true, manage:false, grant:false, publish:false, role:'owner', timezone:'Asia/Yekaterinburg', venueId:'help-ui-fixture' };
    await page.route('**/api/staff/schedule**', route => { assert.equal(route.request().method(),'GET'); const path = new URL(route.request().url()).pathname; return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(path.endsWith('/access')?scheduleAccess:path.endsWith('/employees')?{items:[]}:{items:[],actual:[],access:scheduleAccess})}); });
    await page.route(base+'/qa-help-fixture.html*', route => route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><html lang="ru"><head><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/staff-schedule-ui.css"><link rel="stylesheet" href="/staff-attendance-ui.css"></head><body><main id="help-ui-fixture"></main></body></html>'}));
    // Component harness has no portal/session mocks and grants no application access.
    // Real route RBAC stays covered by the existing role suites; only read-only help presentation is tested here.
    await page.goto(base+'/qa-help-fixture.html#staff-schedule');await page.addScriptTag({url:base+'/staff-schedule-ui.js'});await page.evaluate(()=>window.mountStaffSchedule(document.querySelector('#help-ui-fixture')));
const scheduleHelp=page.getByRole('button',{name:'Справка по графику',exact:true});await scheduleHelp.waitFor({timeout:5000});failed=true;await page.route('**/help-content.js?*',route=>failed?route.fulfill({status:503,contentType:'application/javascript',body:'unavailable'}):route.continue());await scheduleHelp.click();await page.locator('[data-help-load-error]').waitFor();failed=false;await scheduleHelp.click();await page.locator('[data-schedule-help][open]').waitFor();assert.equal(await page.locator('.schedule-help-topic').count(),15);await page.unroute('**/help-content.js?*');await page.locator('[data-help-search]').fill('подготов');assert.ok(await page.locator('.schedule-help-topic:visible').count()>0);await page.locator('[data-schedule-help] a[href*="helpTopic"]').click();await page.locator('[data-help-article="staff-schedule"][open]').waitFor();
    await page.goto(base+'/qa-help-fixture.html#staff-attendance');await page.addScriptTag({url:base+'/staff-attendance-ui.js'});await page.evaluate(()=>window.HOOKAH_ATTENDANCE.mountManagement(document.querySelector('#help-ui-fixture'),{api:async()=>{throw Error('Read-only help fixture: attendance data unavailable');}}));failed=true;await page.route('**/help-content.js?*',route=>failed?route.fulfill({status:503,contentType:'application/javascript',body:'unavailable'}):route.continue());await page.locator('.attendance-help-toggle').click();await page.locator('.attendance-help-guide [role=alert]').waitFor();failed=false;await page.locator('.attendance-help-toggle').click();await page.locator('.attendance-help-toggle').click();await page.locator('.attendance-help-guide details').first().waitFor();await page.unroute('**/help-content.js?*');assert.equal(await page.locator('.attendance-help-guide details').count(),7);await page.locator('.attendance-help-guide a[href*="helpTopic"]').click();await page.locator('[data-help-article="staff-attendance"][open]').waitFor();
    await page.goto(base+'/finance/categories');await page.locator('.finance-category-help summary').click();await page.waitForFunction(() => document.querySelector('[data-finance-help-body]')?.textContent.includes('Архивные категории'));assert.match(await page.locator('[data-finance-help-body]').innerText(),/архив/i);await page.locator('.finance-category-help a[href*="helpTopic"]').click();await page.locator('[data-help-article="finance-categories"][open]').waitFor();
    assert.deepEqual(errors,[]);console.log('PASS shared help: same article text, four contextual links, schedule search, attendance topics, safe deep links, module 503/retry, 320/390/768/1440 layout');
  } catch (error) { const page = browser?.contexts()[0]?.pages()[0]; if (page) console.error('HELP UI STATE:',(await page.locator('body').innerText()).slice(-1500)); throw error; } finally {await browser?.close();server.kill();}
})().catch(e=>{console.error(e);process.exitCode=1});
