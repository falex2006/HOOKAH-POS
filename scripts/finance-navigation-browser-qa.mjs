import assert from 'node:assert/strict';
import { randomBytes, scryptSync } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { validateQaDatabaseUrl, assertQaDatabaseIdentity } from './postgres-qa-safety.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const target = validateQaDatabaseUrl(process.env.MIGRATIONS_PG_TEST_DATABASE_URL, 'MIGRATIONS_PG_TEST_DATABASE_URL');
assert.match(process.env.LOCAL_FULL_PG_OWNED_DATABASE || '', /^payables_qa_[a-f0-9]{16}$/i);
assert.equal(target.database, process.env.LOCAL_FULL_PG_OWNED_DATABASE);
assert.equal(process.env.MIGRATIONS_PG_TEST_DOCKER_CONTAINER, 'hookah-full-regression-qa-20261001');
const lock = JSON.parse(await readFile(path.join(root, 'tmp/full-local-qa/pg-regression-runner.lock'), 'utf8'));
assert.equal(Number(lock.pid), process.ppid);
assert.match(lock.id || '', /^[0-9a-f-]{36}$/i);
assert.ok(process.env.PLAYWRIGHT_PACKAGE_PATH, 'PLAYWRIGHT_PACKAGE_PATH required');
const require = createRequire(import.meta.url);
const { Client } = require('pg');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE_PATH);
const db = new Client({ connectionString: target.url.toString() });
const baseline = process.env.FINANCE_NAV_BASELINE === '1';
const artifacts = path.join(root, 'tmp/finance-navigation-qa', `${baseline ? 'baseline' : 'acceptance'}-${Date.now()}-${process.pid}`);
const evidence = { baseline, screenshots: [], assertions: [], errors: [] };
const password = randomBytes(24).toString('hex');
const salt = randomBytes(16).toString('hex');
const hash = `scrypt$${salt}$${scryptSync(password, salt, 64).toString('hex')}`;
let child, browser;
let serverDiagnostics='';
const selectOption = async (select, value) => {
  const disclosure = select.locator('xpath=ancestor::details[1]');
  if (await disclosure.count() && !await disclosure.evaluate(node => node.open)) await disclosure.locator(':scope > summary').click();
  if (await select.getAttribute('data-custom-select') === '1') {
    const wrapper = select.locator('xpath=..');
    await wrapper.locator('.custom-select-trigger').click();
    await wrapper.locator(`[role="option"][data-value="${value}"]`).click();
  } else await select.selectOption(value);
};
try {
  await mkdir(artifacts, { recursive: true });
  await db.connect();
  const identity = (await db.query('SELECT current_database() AS database,inet_server_addr() AS address,inet_server_port() AS port,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser')).rows[0];
  assertQaDatabaseIdentity(identity, target.database, Number(target.url.port), 'Finance navigation QA');
  const org = (await db.query("INSERT INTO organizations(name,slug,timezone) VALUES('Finance navigation QA',$1,'Asia/Yekaterinburg') RETURNING id", [`finance-navigation-${process.pid}`])).rows[0].id;
  await db.query("INSERT INTO organization_subscriptions(organization_id,status) VALUES($1,'trialing')", [org]);
  const venue = (await db.query("INSERT INTO venues(organization_id,name,timezone) VALUES($1,'Finance navigation QA','Asia/Yekaterinburg') RETURNING id", [org])).rows[0].id;
  const logins = {};
  for (const [key, role, membership] of [['owner','owner','owner'],['reader','manager','member']]) {
    logins[key] = `finance-nav-${process.pid}-${key}`;
    const user = (await db.query('INSERT INTO users(organization_id,venue_id,full_name,login,password_hash,role) VALUES($1,$2,$3,$4,$5,$6) RETURNING id', [org,venue,`Finance QA ${key}`,logins[key],hash,role])).rows[0].id;
    if(key==='reader')await db.query("UPDATE users SET permission_scopes='[\"finance_read\"]'::jsonb WHERE id=$1",[user]);
    await db.query("INSERT INTO organization_memberships(organization_id,user_id,membership_role,status) VALUES($1,$2,$3,'active')", [org,user,membership]);
  }
  const rent = (await db.query("INSERT INTO finance_categories(venue_id,name,kind) VALUES($1,'Аренда · QA','expense') RETURNING id", [venue])).rows[0].id;
  await db.query("INSERT INTO finance_categories(venue_id,name,kind,active) VALUES($1,'Прочие доходы · QA','income',true),($1,'Архив · QA','expense',false),($1,'Доход архив · QA','income',false)", [venue]);
  const paidOrder=(await db.query("INSERT INTO orders(venue_id,opened_by,status,vip_minimum) SELECT $1,id,'open',0 FROM users WHERE login=$2 RETURNING id",[venue,logins.owner])).rows[0].id;
  const account=(await db.query("INSERT INTO finance_accounts(venue_id,code,name,kind,allowed_payment_methods) VALUES($1,'qa-bank','QA bank','bank',ARRAY['card']) RETURNING id",[venue])).rows[0].id;
  await db.query("INSERT INTO payments(order_id,method,amount,status,finance_account_id,finance_account_name_snapshot) VALUES($1,'card',125,'paid',$2,'QA bank')",[paidOrder,account]);
  child = spawn(process.execPath, ['-e', `const pg=require('pg');const query=pg.Client.prototype.query;pg.Client.prototype.query=function(...args){const result=query.apply(this,args);if(result&&typeof result.catch==='function')return result.catch(error=>{console.error('QA_PG_ERROR',JSON.stringify({code:error.code,message:error.message}));throw error;});return result;};require('./server.js');`], { cwd: root, windowsHide: true, env: { ...process.env, SKIP_LOCAL_ENV:'true', DATABASE_URL:target.url.toString(), VENUE_ID:venue, HOST:'127.0.0.1', PORT:'0', NODE_ENV:'test', AUTH_REQUIRED:'true', COOKIE_SECURE:'false', DEMO_MODE:'false', API_RATE_LIMIT:'10000' }, stdio:['ignore','pipe','pipe'] });
  const base = await new Promise((resolve,reject) => {
    let output=''; const timer=setTimeout(()=>reject(Error('Finance QA server startup timeout')),15000);
    child.stdout.on('data',chunk=>{output+=chunk;const match=output.match(/CRM running on http:\/\/localhost:(\d+)/);if(match){clearTimeout(timer);resolve(`http://127.0.0.1:${match[1]}`);}});
    child.once('error',error=>{clearTimeout(timer);reject(error);});
    child.once('exit',code=>{clearTimeout(timer);reject(Error(`Finance QA server exited ${code}`));});
    child.stderr.on('data',chunk=>{serverDiagnostics=(serverDiagnostics+chunk.toString()).slice(-8000);});
  });
  assert.equal((await (await fetch(`${base}/api/health`)).json()).database,'postgres');
  browser = await chromium.launch({ headless:true, ...((process.env.CHROME_PATH || process.env.PLAYWRIGHT_EXECUTABLE_PATH) ? { executablePath:process.env.CHROME_PATH || process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
  let sessionWindow=Date.now(),sessionReads=0,sessionQueue=Promise.resolve();
  const paceSessionReads=async(p)=>p.route('**/api/session*',async route=>{
    if(route.request().method()!=='GET'||!['/api/session','/api/session/preferences'].includes(new URL(route.request().url()).pathname))return route.continue();
    const turn=sessionQueue.then(async()=>{if(Date.now()-sessionWindow>=61000){sessionWindow=Date.now();sessionReads=0;}if(sessionReads>=80){await new Promise(resolve=>setTimeout(resolve,Math.max(0,61000-(Date.now()-sessionWindow))));sessionWindow=Date.now();sessionReads=0;}sessionReads++;});
    sessionQueue=turn.catch(()=>{});await turn;return route.continue();
  });
  const page = await browser.newPage({ viewport:{width:1366,height:900},locale:'ru-RU' });
  page.setDefaultTimeout(90000);page.setDefaultNavigationTimeout(90000);
  await paceSessionReads(page);
  page.on('pageerror',error=>evidence.errors.push(error.message));
  const login = async (p, name) => { await p.goto(`${base}/login`);await p.locator('#login-username').fill(name);await p.locator('#login-password').fill(password);await p.locator('#login-form button[type=submit]').click();await p.waitForURL(url=>url.pathname!=='/login'); };
  await login(page,logins.owner);
  const sidebarState = async p => p.evaluate(()=>{const node=document.querySelector('.portal-sidebar'),r=node?.getBoundingClientRect(),style=node&&getComputedStyle(node);return {body:document.body.className,sidebar:node?.className,transform:style?.transform,width:style?.width,left:r?.left,right:r?.right,hover:node?.matches(':hover'),expanded:document.querySelector('.sidebar-mobile-toggle')?.getAttribute('aria-expanded'),active:document.activeElement?.outerHTML.slice(0,300),innerWidth,devicePixelRatio,touch:navigator.maxTouchPoints};});
  const settleClosedSidebar = async p => {await p.waitForFunction(()=>{const sidebar=document.querySelector('.portal-sidebar');return sidebar&&sidebar.getBoundingClientRect().right<=1;},{},{timeout:5000}).catch(async error=>{throw Error(`Closed mobile sidebar overlaps content: ${JSON.stringify(await sidebarState(p))}; ${error.message}`);});};
  const captureControl = async (locator,label) => {
    for(const width of [1366,390]) {
      await page.setViewportSize({width,height:900});
      if(width<901){await settleClosedSidebar(page);assert.equal(await page.locator('.portal-sidebar').evaluate(node=>node.inert),true);assert.equal(await page.locator('.portal-sidebar').getAttribute('aria-hidden'),'true');}
      await locator.evaluate(node=>{node.scrollIntoView({block:'start',inline:'nearest',behavior:'instant'});window.scrollTo({left:0,top:window.scrollY,behavior:'instant'});const main=document.querySelector('.portal-main');if(main)main.scrollLeft=0;});
      const geometry=await locator.evaluate(node=>({overflow:document.documentElement.scrollWidth>innerWidth+1,labels:[...node.querySelectorAll('label')].filter(el=>el.getClientRects().length).map(el=>{const r=el.getBoundingClientRect();return{text:el.textContent.trim().slice(0,100),left:r.left,right:r.right,width:innerWidth};})}));
      assert.equal(geometry.overflow,false,`${label}/${width} horizontal overflow`);
      assert.ok(geometry.labels.every(item=>item.left>=-1&&item.right<=item.width+1),`${label}/${width} labels outside viewport: ${JSON.stringify(geometry.labels)}`);
      const file=`control-${label}-${width}.png`;await page.screenshot({path:path.join(artifacts,file)});
      evidence.screenshots.push({file,kind:'control-viewport',width,label,geometry,sidebar:await sidebarState(page)});
    }
    await page.setViewportSize({width:1366,height:900});
    await page.waitForFunction(()=>!document.querySelector('.portal-sidebar').inert&&!document.querySelector('.portal-sidebar').hasAttribute('aria-hidden'));
  };

  const categories = async () => { await page.goto(`${base}/finance/categories`,{waitUntil:'networkidle'});await page.locator(`[data-category-report="${rent}"]`).waitFor(); };
  for (const theme of ['dark','light']) for (const width of [1366,390]) for (const route of ['categories','overview','report']) {
    await page.setViewportSize({width,height:900});
    await page.goto(`${base}/finance${route==='overview'?'':'/'+(route==='categories'?'categories':'report')}`,{waitUntil:'networkidle'});
    await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;document.body.classList.toggle('light-theme',theme==='light');document.dispatchEvent(new Event('management-theme-context-change'));},theme);
    await page.evaluate(()=>document.fonts.ready);
    await page.locator('#page-content').waitFor();
    const audit = await page.locator('#page-content').evaluate(node=>({buttons:[...node.querySelectorAll('button,a')].filter(el=>el.getClientRects().length).map(el=>({text:el.textContent.trim(),href:el.getAttribute('href'),disabled:el.disabled||false})),overflow:document.documentElement.scrollWidth>innerWidth+1}));
    const file=`${route}-${theme}-${width}.png`;await page.screenshot({path:path.join(artifacts,file),fullPage:true});
    evidence.screenshots.push({file,route,theme,width,...audit});
    if(!baseline)assert.equal(audit.overflow,false,`${route}/${theme}/${width} overflow`);
  }
  if (!baseline) {
    await page.setViewportSize({width:1366,height:900});await categories();
    await captureControl(page.locator('#finance-category-list .category-row').filter({hasText:'Аренда · QA'}),'category-row');
    const filters = page.locator('.finance-category-filter-options');
    assert.equal(await filters.evaluate(node=>node.open),false);
    assert.equal(await page.locator('#finance-category-search').isVisible(),true);
    await selectOption(page.locator('#finance-category-type'),'expense');
    await selectOption(page.locator('#finance-category-status'),'all');
    await page.locator('#finance-category-list .category-row').filter({hasText:'Архив · QA'}).waitFor();
    await page.locator('#finance-category-search').fill('Аренда');
    await filters.locator('summary').click();
    assert.equal(await filters.evaluate(node=>node.open),false);
    assert.match(await filters.locator('summary').textContent(),/Фильтры.*Расходы.*С архивом/);
    assert.equal(await page.locator('#finance-category-list .category-row').count(),1);
    assert.equal(await page.locator('#finance-category-type').inputValue(),'expense');
    assert.equal(await page.locator('#finance-category-status').inputValue(),'all');
    assert.equal(await page.locator('#finance-category-search').isVisible(),true);
    await filters.locator('summary').focus();await page.keyboard.press('Enter');
    assert.equal(await filters.evaluate(node=>node.open),true);
    await selectOption(page.locator('#finance-category-type'),'');
    await selectOption(page.locator('#finance-category-status'),'active');
    await filters.locator('summary').click();
    assert.equal(await filters.locator('summary').textContent(),'Фильтры');
    await page.locator('#finance-category-search').fill('');
    evidence.assertions.push('collapsed filters preserve type/status/search, show active summary, reopen by keyboard, and reset explicitly');
    await page.locator('#finance-category-search').fill('does-not-exist-qa');
    await page.locator('#finance-category-list .empty').waitFor();
    assert.equal(await page.locator('#finance-category-list .category-row').count(),0);
    await page.locator('#finance-category-search').fill('');
    await page.locator('#new-finance-category').click();
    await page.locator('#finance-category-name').fill('QA создано через форму');
    const created=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname==='/api/finance/categories');
    await page.locator('#finance-category-form button[type=submit]').click();assert.equal((await created).status(),201);
    const row=page.locator('#finance-category-list .category-row').filter({hasText:'QA создано через форму'});await row.waitFor();
    await row.locator('.finance-category-edit').click();await page.locator('#finance-category-name').fill('QA изменено через форму');
    const edited=page.waitForResponse(r=>r.request().method()==='PATCH'&&new URL(r.url()).pathname.startsWith('/api/finance/categories/'));
    await page.locator('#finance-category-form button[type=submit]').click();assert.equal((await edited).status(),200);
    await page.reload({waitUntil:'networkidle'});await page.locator('.category-row').filter({hasText:'QA изменено через форму'}).waitFor();
    evidence.assertions.push('category create/edit persisted after reload; empty search');
    const revised=page.locator('#finance-category-list .category-row').filter({hasText:'QA изменено через форму'});
    await revised.locator('.finance-category-overflow summary').click();
    await revised.locator('[data-category-status]').click();
    const archivedResponse=page.waitForResponse(r=>r.request().method()==='PATCH'&&new URL(r.url()).pathname.startsWith('/api/finance/categories/'));
    await page.locator('.action-modal.open .action-footer button[type=submit]').click();
    assert.equal((await archivedResponse).status(),200);await revised.waitFor({state:'detached'});
    await selectOption(page.locator('#finance-category-status'),'all');await revised.waitFor();
    assert.match(await revised.textContent(),/В архиве/);
    await revised.locator('.finance-category-overflow summary').click();
    const restoredResponse=page.waitForResponse(r=>r.request().method()==='PATCH'&&new URL(r.url()).pathname.startsWith('/api/finance/categories/'));
    await revised.locator('[data-category-status]').click();assert.equal((await restoredResponse).status(),200);
    await page.reload({waitUntil:'networkidle'});await revised.waitFor();assert.doesNotMatch(await revised.textContent(),/В архиве/);
    evidence.assertions.push('archive and restore through UI survive reload');

    let fail=true;
    await page.route('**/api/finance/categories*',route=>new URL(route.request().url()).pathname==='/api/finance/categories'&&route.request().method()==='GET'&&fail?route.fulfill({status:503,contentType:'application/json',body:'{"error":"temporary_unavailable"}'}):route.continue());
    await page.reload({waitUntil:'networkidle'});await page.locator('[data-finance-category-retry]').waitFor();fail=false;
    await page.locator('[data-finance-category-retry]').click();await page.locator(`[data-category-report="${rent}"]`).waitFor();await page.unroute('**/api/finance/categories*');
    evidence.assertions.push('failed category load is distinct from empty, retry recovers');
    await page.route('**/api/finance/categories*',route=>new URL(route.request().url()).pathname==='/api/finance/categories'&&route.request().method()==='GET'?route.fulfill({status:200,contentType:'application/json',body:'{"items":[]}'}):route.continue());
    await page.reload({waitUntil:'networkidle'});await page.locator('#finance-category-list .empty').waitFor();
    assert.equal(await page.locator('[data-finance-category-retry]').count(),0);
    assert.match(await page.locator('#finance-category-list').textContent(),/Категорий пока нет/);
    await page.unroute('**/api/finance/categories*');
    evidence.assertions.push('explicit empty API fixture renders successful empty state rather than error/search absence');

    await categories();
    for(const [index,tab] of [[1,'pos-mapping'],[2,'pos-report']]) {
      await page.locator(`#finance-category-tab-${index}`).click();
      await page.waitForURL(url=>url.searchParams.get('tab')===tab);
      const colors=await page.locator('.finance-category-tabs').evaluate(node=>({active:getComputedStyle(node.querySelector('[aria-selected="true"]')).backgroundColor,inactive:getComputedStyle(node.querySelector('[aria-selected="false"]')).backgroundColor}));
      assert.notEqual(colors.active,colors.inactive,'selected tab has distinct computed background');
      await page.reload({waitUntil:'networkidle'});
      assert.equal(await page.locator(`#finance-category-tab-${index}`).getAttribute('aria-selected'),'true');
      assert.equal(await page.locator(`#finance-category-panel-${index}`).isVisible(),true);
    }
    await page.goBack({waitUntil:'networkidle'});
    assert.equal(new URL(page.url()).searchParams.get('tab'),'pos-mapping');
    assert.equal(await page.locator('#finance-category-tab-1').getAttribute('aria-selected'),'true');
    await page.goForward({waitUntil:'networkidle'});
    assert.equal(await page.locator('#finance-category-tab-2').getAttribute('aria-selected'),'true');
    evidence.assertions.push('category tabs push URL state, reload and Back/Forward restore selected panel');
    const archivedId=(await db.query("SELECT id FROM finance_categories WHERE venue_id=$1 AND name='Архив · QA'",[venue])).rows[0].id;
    for(const [categoryId,archived] of [[rent,false],[archivedId,true]]) {
      await categories();
      if(archived)await selectOption(page.locator('#finance-category-status'),'all');
      if(archived){const archivedIncome=page.locator('#finance-category-list .category-row').filter({hasText:'Доход архив · QA'});await archivedIncome.waitFor();assert.equal(await archivedIncome.locator('[data-category-income],[data-category-start]').count(),0);}
      const link=page.locator(`[data-category-report="${categoryId}"]`);await link.waitFor();await link.click();
      await page.waitForURL(url=>url.pathname==='/finance/report'&&url.searchParams.get('categoryId')===categoryId);
      const reportUrl=new URL(page.url());
      assert.match(reportUrl.searchParams.get('from')||'',/^\d{4}-\d{2}-01$/);
      assert.match(reportUrl.searchParams.get('to')||'',/^\d{4}-\d{2}-\d{2}$/);
      if(archived)assert.equal(reportUrl.searchParams.get('includeArchived'),'true');
      const assertFilters=async()=>{
        await page.waitForFunction(id=>document.querySelector('[data-unified-category]')?.value===id,categoryId);
        assert.equal(await page.locator('[data-unified-from]').inputValue(),reportUrl.searchParams.get('from'));
        assert.equal(await page.locator('[data-unified-to]').inputValue(),reportUrl.searchParams.get('to'));
      };
      await assertFilters();await captureControl(page.locator('.finance-unified-report'),`report-${archived?'archived':'active'}`);await page.reload({waitUntil:'networkidle'});await assertFilters();
      const snapshot=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname==='/api/finance/unified-report/snapshots'&&r.request().postDataJSON()?.categoryId===categoryId);
      await page.locator('[data-unified-load]').click();const snapshotResponse=await snapshot;assert.equal(snapshotResponse.status(),201,`snapshot response: ${JSON.stringify(await snapshotResponse.json())}; ${serverDiagnostics}`);
      evidence.assertions.push(`category report ${archived?'archived':'active'} preserves period/category through reload and snapshot request`);
    }
    for(const action of ['expense','obligation','recurring']) {
      await categories();await page.locator(`[data-category-start="${rent}"]`).click();
      const dialog=page.locator('.finance-category-start-dialog[open]');await dialog.waitFor();
      if(action==='expense')await captureControl(dialog,'expense-choice');
      await dialog.locator(`a[href*="action=${action}"]`).click();
      await page.waitForURL(url=>url.pathname==='/finance');
      const control=page.locator(action==='expense'?'#expense-category':action==='obligation'?'[data-obligation-form] [name=categoryId]':'[data-rule-form] [name=categoryId]');
      await page.waitForFunction(({selector,id})=>document.querySelector(selector)?.value===id,{selector:action==='expense'?'#expense-category':action==='obligation'?'[data-obligation-form] [name=categoryId]':'[data-rule-form] [name=categoryId]',id:rent}).catch(async error=>{const state=await page.evaluate(()=>({url:location.href,notice:document.querySelector('#portal-notice')?.textContent,forms:[...document.querySelectorAll('[data-obligation-form],[data-rule-form]')].map(form=>({hidden:form.hidden,title:form.elements.title?.value,category:form.elements.categoryId?.value,options:[...(form.elements.categoryId?.options||[])].map(o=>({value:o.value,label:o.textContent})),message:form.querySelector('[data-form-message]')?.textContent}))}));await page.screenshot({path:path.join(artifacts,`failure-${action}.png`),fullPage:true});throw Error(`${action} category prefill failed: ${JSON.stringify(state)}; ${error.message}`);});
      assert.equal(await control.inputValue(),rent);
      const form=page.locator(action==='expense'?'#expense-form':action==='obligation'?'[data-obligation-form]':'[data-rule-form]');
      assert.equal(await form.isVisible(),true,`${action} form visible`);
      await captureControl(form,`${action}-form`);
      evidence.assertions.push(`category start ${action} opens selected category without submission`);
    }
    const incomeId=(await db.query("SELECT id FROM finance_categories WHERE venue_id=$1 AND name='Прочие доходы · QA'",[venue])).rows[0].id;
    await categories();
    const incomeRow=page.locator('#finance-category-list .category-row').filter({hasText:'Прочие доходы · QA'});
    let incomePosts=0;const incomeRequest=request=>{if(request.method()==='POST'&&new URL(request.url()).pathname.startsWith('/api/finance/other-income'))incomePosts++;};page.on('request',incomeRequest);
    await incomeRow.locator('[data-category-income]').click();await page.waitForURL(url=>url.pathname==='/finance');
    await page.waitForFunction(id=>document.querySelector('[data-other-income-form] [name=categoryId]')?.value===id,incomeId);
    const incomeForm=page.locator('[data-other-income-form]');assert.equal(await incomeForm.isVisible(),true);
    await captureControl(incomeForm,'other-income-form');assert.equal(incomePosts,0,'income entry does not create or post document');page.off('request',incomeRequest);
    evidence.assertions.push('income category opens other-income form with preset category and no POST');
    await page.goto(`${base}/finance/report`,{waitUntil:'networkidle'});
    await selectOption(page.locator('[data-unified-source]'),'cash_in');
    for(const status of ['paid','approved']) {
      await selectOption(page.locator('[data-unified-status]'),status);
      const responsePromise=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname==='/api/finance/unified-report/snapshots'&&r.request().postDataJSON()?.status===status&&r.request().postDataJSON()?.source==='cash_in');
      await page.locator('[data-unified-load]').click();const response=await responsePromise;const payload=await response.json();assert.equal(response.status(),201,JSON.stringify(payload));
      if(status==='paid')assert.equal(payload.sections.cashInflows.knownTotalMinor,'12500');
      else assert.equal(payload.sections.cashInflows.count,0);
      evidence.assertions.push(`cash_in/${status} enum-safe snapshot201 with real paid fixture`);
    }
    let failIncomeCategory=true;
    await page.route('**/api/finance/categories*',route=>new URL(route.request().url()).pathname==='/api/finance/categories'&&failIncomeCategory?route.fulfill({status:503,contentType:'application/json',body:'{"error":"temporary_unavailable"}'}):route.continue());
    await page.goto(`${base}/finance?action=other-income&categoryId=${incomeId}#other-income`,{waitUntil:'networkidle'});
    await page.locator('[data-other-income-categories-retry]').waitFor();failIncomeCategory=false;
    await page.locator('[data-other-income-categories-retry]').click();
    await page.waitForFunction(id=>document.querySelector('[data-other-income-form] [name=categoryId]')?.value===id,incomeId);
    await page.unroute('**/api/finance/categories*');
    evidence.assertions.push('income deep-link category503 retry restores requested category');
    let failIncomeAccounts=true;
    await page.route('**/api/finance/accounts*',route=>failIncomeAccounts?route.fulfill({status:503,contentType:'application/json',body:'{"error":"temporary_unavailable"}'}):route.continue());
    await page.goto(`${base}/finance?qaCase=income-accounts#other-income`,{waitUntil:'networkidle'});
    const accountsRetry=page.locator('[data-other-income-accounts-retry]');await accountsRetry.waitFor();
    assert.match(await page.locator('[data-other-income-list]').textContent(),/Прочих доходов по выбранным условиям нет/);
    failIncomeAccounts=false;await accountsRetry.click();await accountsRetry.waitFor({state:'detached'});
    await page.unroute('**/api/finance/accounts*');evidence.assertions.push('income accounts503 retains document list and supports retry');
    let failVenues=true;
    await page.route('**/api/finance/report-venues',route=>failVenues?route.fulfill({status:503,contentType:'application/json',body:'{"error":"temporary_unavailable"}'}):route.continue());
    await page.goto(`${base}/finance/categories?tab=pos-report`,{waitUntil:'networkidle'});
    await page.locator('[data-income-venues-retry]').waitFor();
    assert.equal(await page.locator('[data-income-report-load]').isDisabled(),true);
    failVenues=false;
    const posRecovered=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/finance/income-category-report');
    await page.locator('[data-income-venues-retry]').click();assert.equal((await posRecovered).status(),200);
    assert.equal(await page.locator('[data-income-report-load]').isDisabled(),false);
    await page.unroute('**/api/finance/report-venues');
    evidence.assertions.push('POS venue init503 disables report and recovers by retry');
    for(const failurePath of ['/api/finance/report-venues','/api/finance/categories']) {
      let failInit=true,snapshotCount=0;
      const countRequest=request=>{if(request.method()==='POST'&&new URL(request.url()).pathname==='/api/finance/unified-report/snapshots')snapshotCount++;};
      page.on('request',countRequest);
      const routePattern=`**${failurePath}*`;
      await page.route(routePattern,route=>new URL(route.request().url()).pathname===failurePath&&failInit?route.fulfill({status:503,contentType:'application/json',body:'{"error":"temporary_unavailable"}'}):route.continue());
      await page.goto(`${base}/finance/report`,{waitUntil:'networkidle'});
      await page.locator('[data-unified-init-retry]').waitFor();
      assert.equal(await page.locator('[data-unified-load]').isDisabled(),true);
      assert.equal(snapshotCount,0,'no snapshot request before report initialization succeeds');
      failInit=false;
      const recovered=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname==='/api/finance/unified-report/snapshots');
      await page.locator('[data-unified-init-retry]').click();assert.equal((await recovered).status(),201);
      assert.equal(await page.locator('[data-unified-load]').isDisabled(),false);
      page.off('request',countRequest);await page.unroute(routePattern);
      evidence.assertions.push(`unified ${failurePath}503 blocks snapshots and retry recovers`);
    }
    await page.goto(`${base}/finance#business-obligations`,{waitUntil:'networkidle'});
    let failForm=true;
    await page.route('**/api/finance/categories*',route=>new URL(route.request().url()).pathname==='/api/finance/categories'&&failForm?route.fulfill({status:503,contentType:'application/json',body:'{"error":"temporary_unavailable"}'}):route.continue());
    await page.locator('[data-obligation-new]').click();
    const obligationForm=page.locator('[data-obligation-form]');
    await obligationForm.locator('[data-form-categories-retry]').waitFor();
    await obligationForm.locator('[name=title]').fill('QA сохранённый ввод после503');
    assert.equal(await obligationForm.locator('[type=submit]').isDisabled(),true);
    failForm=false;await obligationForm.locator('[data-form-categories-retry]').click();
    await page.waitForFunction(()=>document.querySelector('[data-obligation-form] [type=submit]')?.disabled===false);
    assert.equal(await obligationForm.locator('[name=title]').inputValue(),'QA сохранённый ввод после503');
    await page.unroute('**/api/finance/categories*');
    evidence.assertions.push('obligation category503 disables submit; retry retains entered title');
    const ownerStorage=await page.context().storageState();
    for(const width of [390,320]) {
      const mobileContext=await browser.newContext({viewport:{width,height:900},screen:{width,height:900},isMobile:true,hasTouch:true,deviceScaleFactor:1,locale:'ru-RU',storageState:ownerStorage});
      const mobile=await mobileContext.newPage();mobile.setDefaultTimeout(90000);mobile.setDefaultNavigationTimeout(90000);await paceSessionReads(mobile);
      mobile.on('pageerror',error=>evidence.errors.push(error.message));
      const mobileCategories=async()=>{await mobile.goto(`${base}/finance/categories`,{waitUntil:'networkidle'});await mobile.locator(`[data-category-start="${rent}"]`).waitFor();await settleClosedSidebar(mobile);};
      const mobileCapture=async(locator,label)=>{
        await locator.scrollIntoViewIfNeeded();await settleClosedSidebar(mobile);
        const geometry=await locator.evaluate(node=>({overflow:document.documentElement.scrollWidth>innerWidth+1,labels:[...node.querySelectorAll('label')].filter(el=>el.getClientRects().length).map(el=>{const r=el.getBoundingClientRect();return{text:el.textContent.trim(),left:r.left,right:r.right,width:innerWidth};})}));
        assert.equal(geometry.overflow,false,`${label}/${width} mobile overflow`);assert.ok(geometry.labels.every(r=>r.left>=-1&&r.right<=r.width+1),`${label}/${width} mobile labels contained`);
        const file=`emulator-${label}-${width}.png`;await mobile.waitForTimeout(350);await mobile.screenshot({path:path.join(artifacts,file)});evidence.screenshots.push({file,kind:'chromium-mobile-touch',width,label,geometry,sidebar:await sidebarState(mobile)});
      };
      await mobileCategories();
      assert.equal(await mobile.evaluate(()=>navigator.maxTouchPoints>0),true);
      await mobile.locator('.sidebar-mobile-toggle').tap();
      await mobile.waitForFunction(()=>document.querySelector('.sidebar-mobile-toggle')?.getAttribute('aria-expanded')==='true'&&document.querySelector('.portal-sidebar').getBoundingClientRect().left>=-1);
      assert.equal(await mobile.locator('.portal-main').evaluate(node=>node.inert),true);assert.equal(await mobile.locator('.portal-sidebar').evaluate(node=>node.inert),false);
      evidence.assertions.push({mobileMenuOpen:width,state:await sidebarState(mobile)});
      await mobile.screenshot({path:path.join(artifacts,`emulator-menu-open-${width}.png`)});
      await mobile.locator('.sidebar-mobile-toggle').tap();await settleClosedSidebar(mobile);assert.equal(await mobile.locator('.portal-sidebar').evaluate(node=>node.inert),true);assert.equal(await mobile.locator('.portal-sidebar').getAttribute('aria-hidden'),'true');
      assert.equal(await mobile.locator('.portal-main').evaluate(node=>node.inert),false);
      await mobileCapture(mobile.locator('.category-row').filter({hasText:'Аренда · QA'}),'category-row');
      for(const action of ['expense','obligation','recurring']) {
        await mobileCategories();await mobile.locator(`[data-category-start="${rent}"]`).tap();
        const dialog=mobile.locator('.finance-category-start-dialog[open]');await dialog.waitFor();
        if(action==='expense')await mobileCapture(dialog,'expense-choice');
        await dialog.locator(`a[href*="action=${action}"]`).tap();await mobile.waitForURL(url=>url.pathname==='/finance');
        const selector=action==='expense'?'#expense-form':action==='obligation'?'[data-obligation-form]':'[data-rule-form]';
        const categorySelector=action==='expense'?'#expense-category':`${selector} [name=categoryId]`;
        await mobile.waitForFunction(({selector,id})=>document.querySelector(selector)?.value===id,{selector:categorySelector,id:rent});
        assert.equal(await mobile.locator(selector).isVisible(),true);await mobileCapture(mobile.locator(selector),`${action}-form`);
      }
      await mobileCategories();await mobile.locator(`a[data-category-income][href*="categoryId=${incomeId}"]`).tap();
      await mobile.waitForFunction(id=>document.querySelector('[data-other-income-form] [name=categoryId]')?.value===id,incomeId);
      await mobileCapture(mobile.locator('[data-other-income-form]'),'income-form');
      await mobileCategories();await mobile.locator(`[data-category-report="${rent}"]`).tap();
      await mobile.waitForFunction(id=>document.querySelector('[data-unified-category]')?.value===id,rent);
      await mobileCapture(mobile.locator('.finance-unified-report'),'unified-report');
      evidence.assertions.push(`real Chromium mobile/touch ${width}: menu open/close, three expense routes, income and report presets visible`);
      await mobileContext.close();
    }
    const reader=await browser.newPage();reader.setDefaultTimeout(90000);reader.setDefaultNavigationTimeout(90000);await paceSessionReads(reader);await login(reader,logins.reader);await reader.goto(`${base}/finance/categories`,{waitUntil:'networkidle'});await reader.locator(`[data-category-report="${rent}"]`).waitFor();
    assert.equal(await reader.locator('#new-finance-category,[data-category-start],[data-category-income],.finance-category-edit,[data-category-status]').count(),0);
    const denied=await reader.evaluate(async()=>{const r=await fetch('/api/finance/categories',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'forbidden',kind:'expense'})});return r.status;});assert.equal(denied,403);
    await reader.goto(`${base}/finance`,{waitUntil:'networkidle'});
    assert.equal(await reader.locator('#cash-register-action').isVisible(),false,'finance-only reader has no cash shift action');
    evidence.assertions.push('finance reader cannot create/edit/archive/start and API denies write');await reader.close();
  }
  assert.deepEqual(evidence.errors,[]);
  evidence.status=baseline?'BASELINE_CAPTURED':'PASS';
  console.log(`FINANCE NAVIGATION ${evidence.status}: ${artifacts}`);
} catch(error) { evidence.status='FAIL';evidence.failure={name:error.name,message:error.message};evidence.serverDiagnostics=serverDiagnostics;throw error; }
finally {
  await mkdir(artifacts,{recursive:true});await writeFile(path.join(artifacts,'evidence.json'),JSON.stringify(evidence,null,2));
  if(browser)await browser.close();
  if(child && child.exitCode===null){const ended=once(child,'exit');child.kill();await ended;}
  await db.end();
}
