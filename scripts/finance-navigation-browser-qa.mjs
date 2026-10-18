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
let child, browser, diagnosticPage;
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
  diagnosticPage=page;
  page.setDefaultTimeout(90000);page.setDefaultNavigationTimeout(90000);
  await paceSessionReads(page);
  page.on('pageerror',error=>evidence.errors.push(error.message));
  const login = async (p, name) => { await p.goto(`${base}/login`);await p.locator('#login-username').fill(name);await p.locator('#login-password').fill(password);await p.locator('#login-form button[type=submit]').click();await p.waitForURL(url=>url.pathname!=='/login'); };
  await login(page,logins.owner);
  let seededIncomeId=null,seededPayrollUser=null;const seededDiscounts=[];
  const priorMonthEnd=new Date(Date.UTC(new Date().getUTCFullYear(),new Date().getUTCMonth(),0)).toISOString().slice(0,10);
  const payrollFrom=priorMonthEnd.slice(0,7)+'-01';
  if(process.env.FINANCE_NAV_SECTIONS_ONLY==='1') {
    seededPayrollUser=(await db.query("INSERT INTO users(organization_id,venue_id,full_name,login,role) VALUES($1,$2,'QA бармен для начисления',$3,'bartender') RETURNING id",[org,venue,`finance-payroll-${process.pid}`])).rows[0].id;
    await db.query("INSERT INTO staff_work_logs(venue_id,user_id,started_at,ended_at,source) VALUES($1,$2,$3,$4,'manual')",[venue,seededPayrollUser,`${priorMonthEnd.slice(0,7)}-15T05:00:00Z`,`${priorMonthEnd.slice(0,7)}-15T13:00:00Z`]);
    for(const action of ['approve','reject']) {
      const order=(await db.query("INSERT INTO orders(venue_id,opened_by,status,vip_minimum) SELECT $1,id,'open',1000 FROM users WHERE login=$2 RETURNING id",[venue,logins.owner])).rows[0].id;
      const discount=(await db.query("INSERT INTO discounts(order_id,requested_by,type,value,reason,status) SELECT $1,id,'percent',10,$3,'requested' FROM users WHERE login=$2 RETURNING id",[order,logins.owner,`QA ${action} request`])).rows[0].id;
      seededDiscounts.push({id:discount,action});
    }
    const incomeCategory=(await db.query("SELECT id FROM finance_categories WHERE venue_id=$1 AND kind='income' AND active=true",[venue])).rows[0].id;
    const fixtureApi=async(pathname,method,body)=>page.evaluate(async({pathname,method,body})=>{const response=await fetch(pathname,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:response.status,body:await response.json()};},{pathname,method,body});
    const fixtureDate=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Yekaterinburg'}).format(new Date());
    for(const [index,title] of ['Аренда оборудования · QA','Проведённая услуга · QA'].entries()) {
      const income=await fixtureApi('/api/finance/other-income','POST',{categoryId:incomeCategory,title,basis:'Акт QA',counterpartyName:'Тестовый партнёр',recognitionDate:fixtureDate,totalAmount:'15000.00',idempotencyKey:`nav-income-${process.pid}-${index}`});
      assert.equal(income.status,201,JSON.stringify(income.body));
      if(index===0)seededIncomeId=income.body.id;
      else assert.equal((await fixtureApi(`/api/finance/other-income/${income.body.id}/post`,'POST',{})).status,200);
    }
    const payable=await fixtureApi('/api/finance/payables','POST',{categoryId:rent,title:'Аренда помещения · QA',counterpartyName:'Арендодатель QA',basis:'Договор QA',periodFrom:fixtureDate.slice(0,7)+'-01',periodTo:fixtureDate,dueDate:fixtureDate,lines:[{description:'Аренда зала',amount:'25000.00'}],idempotencyKey:`nav-payable-${process.pid}`});
    assert.equal(payable.status,201,JSON.stringify(payable.body));
    evidence.assertions.push('owned disposable database seeded with draft/posted income, rent obligation and paid POS card payment');
  }

  const sidebarState = async p => p.evaluate(()=>{const node=document.querySelector('.portal-sidebar'),r=node?.getBoundingClientRect(),style=node&&getComputedStyle(node);return {body:document.body.className,sidebar:node?.className,transform:style?.transform,width:style?.width,left:r?.left,right:r?.right,hover:node?.matches(':hover'),expanded:document.querySelector('.sidebar-mobile-toggle')?.getAttribute('aria-expanded'),active:document.activeElement?.outerHTML.slice(0,300),innerWidth,devicePixelRatio,touch:navigator.maxTouchPoints};});
  const settleClosedSidebar = async p => {await p.waitForFunction(()=>{const sidebar=document.querySelector('.portal-sidebar');return sidebar&&sidebar.getBoundingClientRect().right<=1;},{},{timeout:5000}).catch(async error=>{throw Error(`Closed mobile sidebar overlaps content: ${JSON.stringify(await sidebarState(p))}; ${error.message}`);});};
  const captureControl = async (locator,label) => {
    for(const width of [1366,768,390,320]) {
      await page.setViewportSize({width,height:900});
      if(width<901){await settleClosedSidebar(page);assert.equal(await page.locator('.portal-sidebar').evaluate(node=>node.inert),true);assert.equal(await page.locator('.portal-sidebar').getAttribute('aria-hidden'),'true');}
      await locator.evaluate(node=>{node.scrollIntoView({block:'start',inline:'nearest',behavior:'instant'});window.scrollTo({left:0,top:window.scrollY,behavior:'instant'});const main=document.querySelector('.portal-main');if(main)main.scrollLeft=0;});
      const geometry=await locator.evaluate(node=>({overflow:document.documentElement.scrollWidth>innerWidth+1,labels:[...node.querySelectorAll('label')].filter(el=>el.getClientRects().length).map(el=>{const r=el.getBoundingClientRect();return{text:el.textContent.trim().slice(0,100),left:r.left,right:r.right,width:innerWidth};})}));
      assert.equal(geometry.overflow,false,`${label}/${width} horizontal overflow`);
      assert.ok(geometry.labels.every(item=>item.left>=-1&&item.right<=item.width+1),`${label}/${width} labels outside viewport: ${JSON.stringify(geometry.labels)}`);
      const file=`control-${label}-${width}.png`;await page.screenshot({path:path.join(artifacts,file)});
      evidence.screenshots.push({file,kind:'control-viewport',width,label,geometry,sidebar:await sidebarState(page)});
    }
    await page.evaluate(()=>{document.documentElement.dataset.theme='light';document.body.classList.add('light-theme');document.dispatchEvent(new Event('management-theme-context-change'));});
    await page.setViewportSize({width:390,height:900});
    const lightFile=`control-${label}-light-390.png`;await page.screenshot({path:path.join(artifacts,lightFile)});evidence.screenshots.push({file:lightFile,kind:'control-viewport',width:390,label,theme:'light'});
    await page.evaluate(()=>{document.documentElement.dataset.theme='dark';document.body.classList.remove('light-theme');document.dispatchEvent(new Event('management-theme-context-change'));});
    await page.setViewportSize({width:1366,height:900});
    await page.waitForFunction(()=>!document.querySelector('.portal-sidebar').inert&&!document.querySelector('.portal-sidebar').hasAttribute('aria-hidden'));
  };

  const sectionKeys = ['overview','expenses','income','obligations','suppliers','payments','cash','result','staff','discounts','payroll'];
  const chooseSection = async (key) => {
    if (page.viewportSize().width <= 700) await selectOption(page.locator('.finance-view-picker select'),key);
    else await page.locator(`.finance-view-navigation [data-finance-view="${key}"]`).click();
    await page.waitForFunction(key=>document.querySelector('#page-content')?.dataset.financeView===key,key);
  };
  const revealControl = async locator => {
    const summaries=await locator.evaluate(node=>{const result=[];for(let parent=node.parentElement;parent;parent=parent.parentElement)if(parent.tagName==='DETAILS'&&!parent.open)result.unshift(parent.querySelector(':scope > summary').textContent.trim());return result;});
    for(const summary of summaries)await page.locator('summary').filter({hasText:new RegExp('^'+summary.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'$')}).click();
  };
  await page.goto(`${base}/finance`,{waitUntil:'networkidle'});
  for(const width of [1366,768,390,320]) {
    await page.setViewportSize({width,height:width===1366?900:844});
    if(width<901)await settleClosedSidebar(page);
    for(const key of sectionKeys) {
      await chooseSection(key);
      await page.evaluate(()=>document.fonts.ready);
      const geometry=await page.locator('#page-content').evaluate(node=>({
        overflow:document.documentElement.scrollWidth>innerWidth+1,
        visiblePanels:[...node.querySelectorAll(':scope > .finance-view-panel')].filter(panel=>panel.getClientRects().length).map(panel=>({id:panel.id,classes:panel.className})),
        controls:[...node.querySelectorAll('button,input:not([type=hidden]),select,summary')].filter(control=>control.getClientRects().length&&getComputedStyle(control).visibility!=='hidden').map(control=>{const r=control.getBoundingClientRect();return {text:(control.getAttribute('aria-label')||control.textContent||control.id).trim().slice(0,80),left:r.left,right:r.right};})
      }));
      const file=`section-${key}-${width}.png`;
      await page.screenshot({path:path.join(artifacts,file),fullPage:true});
      evidence.screenshots.push({file,kind:'section',key,width,geometry});
      if(!baseline){
        assert.equal(geometry.overflow,false,`${key}/${width} document overflow`);
        assert.ok(geometry.visiblePanels.length,`${key}/${width} visible content`);
        assert.equal(await page.locator('.finance-view-navigation [aria-current="page"]').getAttribute('data-finance-view'),key);
        assert.ok(geometry.controls.every(control=>control.left>=-1&&control.right<=width+1),`${key}/${width} controls outside viewport: ${JSON.stringify(geometry.controls.filter(control=>control.left< -1||control.right>width+1))}`);
      }
    }
  }
  evidence.assertions.push('all 11 finance sections captured at desktop 1366, tablet 768 and mobile 390/320; active section and visible controls checked');
  await page.setViewportSize({width:1366,height:900});

  if (!baseline) {
    await page.goto(`${base}/finance`,{waitUntil:'networkidle'});
    const activeView=()=>page.locator('#page-content').getAttribute('data-finance-view');
    assert.equal(await activeView(),'overview');
    for(const key of ['expenses','income','obligations','suppliers','payments','cash','result','staff','discounts','payroll','overview']) {
      await page.locator(`[data-finance-view="${key}"]`).click();
      await page.waitForFunction(key=>document.querySelector('#page-content').dataset.financeView===key,key);
      const visible=await page.locator('#page-content>.finance-view-panel').evaluateAll(nodes=>nodes.filter(n=>n.getClientRects().length).map(n=>n.id||n.className));
      assert.ok(visible.length>0,`${key} has a visible panel`);
      assert.equal(await page.locator('.finance-view-navigation [aria-current="page"]').count(),1);
      if(key!=='overview')assert.equal(await page.locator('.finance-kpi-grid').isVisible(),false);
    }
    await page.locator('[data-kpi-target="#payment-list"]').first().click();
    await page.waitForFunction(()=>document.querySelector('#page-content').dataset.financeView==='payments');
    assert.equal(await page.locator('#payment-list').isVisible(),true);
    await page.locator('[data-finance-view="expenses"]').click();
    await page.locator('#expense-form').locator('xpath=..').locator(':scope > summary').click();
    await page.locator('#expense-amount').fill('123.45');
    await page.locator('[data-finance-view="suppliers"]').click();
    await page.locator('#payables').waitFor({state:'visible'});
    await page.goBack();
    await page.waitForFunction(()=>document.querySelector('#page-content').dataset.financeView==='expenses');
    assert.equal(await page.locator('#expense-amount').inputValue(),'123.45');
    await page.reload({waitUntil:'networkidle'});assert.equal(await activeView(),'expenses');
    for(const width of [390,320]) {
      await page.setViewportSize({width,height:844});
      await selectOption(page.locator('.finance-view-picker select'),'suppliers');
      await page.waitForFunction(()=>document.querySelector('#page-content').dataset.financeView==='suppliers');
      assert.equal(await page.locator('#payables').isVisible(),true);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
      const file=`section-picker-${width}.png`;await page.screenshot({path:path.join(artifacts,file),fullPage:true});evidence.screenshots.push({file,width});
    }
    evidence.assertions.push('finance sections isolate panels, supplier target works, KPI reveals payments, Back preserves input, reload and mobile picker restore selection');
    await page.setViewportSize({width:1366,height:900});
    const mutationRequests=[];
    const trackMutation=request=>{if(['POST','PATCH','DELETE'].includes(request.method())&&/^\/api\/(finance|expenses|payroll)/.test(new URL(request.url()).pathname))mutationRequests.push(request.url());};
    page.on('request',trackMutation);
    await chooseSection('income');
    const incomeCreate=page.locator('[data-other-income-form]');
    assert.equal(await incomeCreate.isVisible(),false,'income creation collapsed until requested');
    await revealControl(incomeCreate);
    await incomeCreate.locator('[name=totalAmount]').fill('456.78');
    await incomeCreate.locator('[name=title]').fill('Доход: несохранённый ввод QA');
    await chooseSection('expenses');
    await revealControl(page.locator('#expense-form'));
    await page.locator('#expense-amount').fill('234.56');
    await chooseSection('income');
    assert.equal(await incomeCreate.locator('[name=totalAmount]').inputValue(),'456.78');
    assert.equal(await incomeCreate.locator('[name=title]').inputValue(),'Доход: несохранённый ввод QA');
    await chooseSection('expenses');
    assert.equal(await page.locator('#expense-amount').inputValue(),'234.56');
    evidence.assertions.push('expense and income creation are separate from journals and unsaved input survives section switches');

    await chooseSection('obligations');
    for(const [opener,form] of [['[data-obligation-new]','[data-obligation-form]'],['[data-rule-new]','[data-rule-form]']]) {
      await page.locator(opener).click();await page.locator(form).waitFor({state:'visible'});
      await page.locator(form+' [name=title]').fill('Форма QA без сохранения');
      await page.locator(form+' [data-line-name]').first().fill('Аренда');
      await page.locator(form+' [data-line-amount]').first().fill('1000');
      await page.locator(form+' [data-line-add]').click();
      assert.equal(await page.locator(form+' [data-line-amount]').count(),2);
      await page.locator(form+' [data-line-name]').nth(1).fill('Уборка');
      await page.locator(form+' [data-line-amount]').nth(1).fill('200');
      if(form==='[data-rule-form]')assert.equal(Number(await page.locator(form+' [name=amount]').inputValue()),1200);
      await captureControl(page.locator(form),form.includes('rule')?'section-rule-form':'section-obligation-form');
      await page.locator(form+' [data-form-close]').click();assert.equal(await page.locator(form).isVisible(),false);
    }
    const accountsLink=page.locator('#business-obligations a[href="#finance-account-settings"]');
    await accountsLink.click();await page.waitForFunction(()=>document.querySelector('#page-content').dataset.financeView==='cash');
    assert.equal(await page.locator('[data-finance-account-list]').isVisible(),true);
    await page.reload({waitUntil:'networkidle'});
    assert.equal(await activeView(),'cash');assert.equal(await page.locator('[data-finance-account-list]').isVisible(),true);
    evidence.assertions.push('obligation and recurring forms add priced lines, recurring total is correct, close works; account shortcut and deep-link reload select cash');

    await chooseSection('overview');
    for(const view of ['bars','table','line']){
      await page.locator(`[data-finance-chart-view="${view}"]`).click();
      assert.equal(await page.locator(`[data-finance-chart-view="${view}"]`).getAttribute('aria-pressed'),'true');
      assert.equal(await page.locator('[data-finance-chart-view][aria-pressed="true"]').count(),1);
      assert.ok((await page.locator('#finance-chart').textContent()).trim());
    }
    await selectOption(page.locator('#finance-chart-period'),'30');
    assert.equal(await page.locator('#finance-chart-period').inputValue(),'30');
    await chooseSection('payments');
    for(const view of ['bars','line','table','donut']){
      await page.locator(`[data-payment-view="${view}"]`).click();
      assert.equal(await page.locator(`[data-payment-view="${view}"]`).getAttribute('aria-pressed'),'true');
      assert.equal(await page.locator('[data-payment-view][aria-pressed="true"]').count(),1);
      assert.match(await page.locator('#payment-list').textContent(),/125/);
    }
    evidence.assertions.push('chart period and all chart/payment presentations switch correctly with seeded card payment');

    await chooseSection('suppliers');
    await revealControl(page.locator('#payables-search'));
    await page.locator('#payables-search').fill('Нет такого поставщика QA');
    await selectOption(page.locator('#payables-status'),'');
    await page.locator('#payables-date-from').fill('2026-01-01');
    const supplierFiltered=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/finance/purchase-payables'&&new URL(response.url()).searchParams.get('documentDateFrom')==='2026-01-01');
    await page.locator('#payables-filter-apply').click();assert.equal((await supplierFiltered).status(),200);
    await page.locator('#payables-filter-reset').click();assert.equal(await page.locator('#payables-search').inputValue(),'');
    await chooseSection('income');
    await revealControl(page.locator('[data-other-income-search]'));
    await page.locator('[data-other-income-search]').fill('Нет такого дохода QA');
    await selectOption(page.locator('[data-other-income-status]'),'draft');
    const incomeFiltered=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/finance/other-income'&&new URL(response.url()).searchParams.get('q')==='Нет такого дохода QA'&&new URL(response.url()).searchParams.get('status')==='draft');
    await page.locator('[data-other-income-filter]').click();assert.equal((await incomeFiltered).status(),200);
    await page.waitForFunction(()=>document.querySelector('[data-other-income-list]').textContent.includes('Прочих доходов по выбранным условиям нет'));
    await chooseSection('expenses');
    await revealControl(page.locator('#expenses-filter-from'));
    await page.locator('#expenses-filter-from').fill('2026-01-01');await page.locator('#expenses-filter-to').fill('2026-01-31');
    const expenseFiltered=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/expenses'&&new URL(response.url()).searchParams.get('from')==='2026-01-01');
    await page.locator('#expenses-filter-apply').click();assert.equal((await expenseFiltered).status(),200);
    await page.locator('#expenses-filter-reset').click();assert.equal(await page.locator('#expenses-filter-from').inputValue(),'');
    evidence.assertions.push('supplier, income and expense filter controls issue expected queries; reset clears applied values');

    await chooseSection('payroll');await page.locator('#payroll-create-toggle').click();
    await page.locator('#payroll-create-form').waitFor({state:'visible'});
    await page.locator('#payroll-create-from').fill('2026-01-01');
    const payrollSettings=page.locator('.finance-payroll-settings');
    await payrollSettings.waitFor({state:'attached'});
    assert.equal(await payrollSettings.evaluate(node=>node.open),false);
    await payrollSettings.locator(':scope > summary').click();
    assert.equal(await payrollSettings.locator('[data-scheme-new]').isVisible(),true);
    await captureControl(payrollSettings,'section-payroll-settings');
    await payrollSettings.locator(':scope > summary').click();
    assert.equal(await page.locator('#payroll-create-from').inputValue(),'2026-01-01','settings toggle preserves payroll creation input');
    await captureControl(page.locator('#payroll-create-form'),'section-payroll-create');
    await page.locator('#payroll-create-cancel').click();
    assert.equal(await page.locator('#payroll-create-form').isVisible(),false);
    assert.deepEqual(mutationRequests,[],'exploration and cancellation must not create or mutate finance records');
    page.off('request',trackMutation);
    evidence.assertions.push('payroll creation opens and cancels; all section controls explored without financial mutations');
    if(seededDiscounts.length){
      await chooseSection('discounts');
      await captureControl(page.locator('#discount-list'),'discount-decisions');
      let holdDiscountRefresh=true,releaseDiscountRefresh;
      const discountRefreshGate=new Promise(resolve=>{releaseDiscountRefresh=resolve;});
      await page.route('**/api/finance/summary*',async route=>{if(holdDiscountRefresh)await discountRefreshGate;await route.continue();});
      try { for(const {id,action} of seededDiscounts){
        await page.waitForFunction(()=>!document.querySelector('#discount-reload').disabled);
        const decided=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname===`/api/discount-requests/${id}/${action}`);
        await page.locator(`.discount-${action}[data-discount="${id}"]`).click();assert.equal((await decided).status(),200);
        await page.waitForFunction(({reason,status})=>[...document.querySelectorAll('#discount-list .discount-row')].some(row=>row.textContent.includes(reason)&&row.textContent.includes(status)),{reason:`QA ${action} request`,status:action==='approve'?'Применена':'Отклонена'});
        assert.equal((await db.query('SELECT status FROM discounts WHERE id=$1',[id])).rows[0].status,action==='approve'?'approved':'rejected');
        evidence.assertions.push(`discount ${action} persisted in owned database`);
        if(action==='approve'){
          const pendingControls=await page.locator('#discount-list button[data-discount]').evaluateAll(nodes=>nodes.map(node=>({disabled:node.disabled,text:node.textContent})));
          evidence.discountPendingControls=pendingControls;
          assert.ok(pendingControls.length&&pendingControls.every(control=>control.disabled),'freshly rendered discount controls remain disabled until summary refresh settles');
          holdDiscountRefresh=false;releaseDiscountRefresh();
        }
      }} finally {holdDiscountRefresh=false;releaseDiscountRefresh();await page.unroute('**/api/finance/summary*');}
      await page.reload({waitUntil:'networkidle'});
      assert.equal(await page.locator('#discount-list button[data-discount]').count(),0);
      evidence.assertions.push('populated discount requests approved and rejected through actual UI; database and reload retain both decisions');
    }
    if(seededIncomeId){
      await chooseSection('income');
      await page.locator('[data-other-income-search]').fill('');await selectOption(page.locator('[data-other-income-status]'),'');
      await page.locator('[data-other-income-filter]').click();
      await page.locator(`[data-other-income-edit="${seededIncomeId}"]`).waitFor();
      await page.locator(`[data-other-income-edit="${seededIncomeId}"]`).click();
      await incomeCreate.waitFor({state:'visible'});await page.waitForFunction(()=>document.querySelector('[data-other-income-form] [name=title]').value==='Аренда оборудования · QA');
      await incomeCreate.locator('[data-other-income-form-cancel]').click();
      const receipt=page.locator('.finance-receipt-disclosure');assert.ok(await receipt.count()>0);
      assert.equal(await receipt.first().evaluate(node=>node.open),false);await receipt.first().locator(':scope > summary').click();
      await captureControl(receipt.first(),'income-receipt-expanded');
      evidence.assertions.push('populated income draft edit reopens creation, cancel works, posted income receipt opens separately');
    }
    await chooseSection('cash');
    await revealControl(page.locator('[data-finance-account-form]'));
    await page.locator('[data-finance-account-form] [name=name]').fill('QA счёт через интерфейс');
    await selectOption(page.locator('[data-finance-account-form] [name=kind]'),'bank');
    const accountSaved=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname==='/api/finance/accounts');
    await page.locator('[data-finance-account-form] [type=submit]').click();assert.equal((await accountSaved).status(),201);
    await page.locator('[data-finance-account-list]').getByText('QA счёт через интерфейс',{exact:true}).waitFor();
    let failAccounts=true;
    await page.route('**/api/finance/accounts*',route=>failAccounts&&route.request().method()==='GET'?route.fulfill({status:503,contentType:'application/json',body:'{"error":"temporary_unavailable"}'}):route.continue());
    await page.reload({waitUntil:'networkidle'});
    await revealControl(page.locator('[data-finance-account-list]'));await page.locator('[data-finance-accounts-retry]').waitFor();failAccounts=false;
    await page.locator('[data-finance-accounts-retry]').click();
    await page.locator('[data-finance-account-list]').getByText('QA счёт через интерфейс',{exact:true}).waitFor();
    await page.unroute('**/api/finance/accounts*');
    evidence.assertions.push('cash account creation persists; failed account loading is recoverable via visible retry');
    if(seededPayrollUser){
      await chooseSection('payroll');
      const settings=page.locator('.finance-payroll-settings');
      await revealControl(settings.locator('[data-scheme-new]'));
      await settings.locator('[data-scheme-new]').click();
      const configuration=settings.locator('[data-scheme-pane="configuration"]');
      await configuration.waitFor({state:'visible'});
      await settings.locator('[data-scheme-name]').fill('QA пошаговая схема');
      const rate=settings.locator('[data-grid-role="bartender"][data-grid-path="perShiftCents"]');
      await revealControl(rate);await rate.fill('500');
      await settings.locator('.scheme-workspace-nav [data-scheme-workspace="list"]').click();
      await settings.locator('.scheme-workspace-nav [data-scheme-workspace="configuration"]').click();
      assert.equal(await settings.locator('[data-scheme-name]').inputValue(),'QA пошаговая схема');assert.equal(await rate.inputValue(),'500');
      assert.equal(await settings.locator('[data-scheme-pane]:visible').count(),1);
      await settings.locator('[data-scheme-grid-apply]').click();
      await settings.locator('[data-scheme-risk-acknowledged]').check();
      const schemeSave=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname==='/api/payroll/schemes');
      await settings.locator('[data-scheme-save]').click();const schemeResponse=await schemeSave;assert.equal(schemeResponse.status(),201);
      const savedScheme=await schemeResponse.json();const savedVersion=savedScheme.versions[0].versionId;
      await settings.locator('[data-scheme-pane="checks"]').waitFor({state:'visible'});
      await settings.locator('[data-attendance-refresh]').click();
      await settings.locator('.scheme-workspace-nav [data-scheme-workspace="trial"]').click();
      await settings.locator('[data-scheme-preview]').waitFor({state:'visible'});
      const trialRun=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname===`/api/payroll/versions/${savedVersion}/preview`);
      await settings.locator('[data-scheme-run-preview]').click();assert.equal((await trialRun).status(),200);
      await settings.locator('[data-scheme-preview-result]').waitFor({state:'visible'});
      assert.equal((await db.query('SELECT config_json FROM payroll_scheme_versions WHERE id=$1',[savedVersion])).rows[0].config_json.roleParameters.bartender.perShiftCents,50000);
      for(const key of ['configuration','checks','trial']) {
        await settings.locator(`.scheme-workspace-nav [data-scheme-workspace="${key}"]`).click();
        const pane=settings.locator(`[data-scheme-pane="${key}"]`);
        for(const width of [1366,768,390,320]){
          await page.setViewportSize({width,height:900});await pane.evaluate(node=>node.scrollIntoView({block:'start',inline:'nearest',behavior:'instant'}));
          assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,`payroll ${key}/${width} overflow`);
          const file=`payroll-workflow-${key}-${width}.png`;await page.screenshot({path:path.join(artifacts,file)});evidence.screenshots.push({file,key,width,kind:'payroll-workflow'});
          if(key==='configuration'){const rateControl=settings.locator('[data-grid-role="bartender"][data-grid-path="perShiftCents"]');await revealControl(rateControl);await rateControl.evaluate(node=>node.closest('details').scrollIntoView({block:'start',behavior:'instant'}));const rateFile=`payroll-workflow-rate-${width}.png`;await page.screenshot({path:path.join(artifacts,rateFile)});evidence.screenshots.push({file:rateFile,key:'rate',width,kind:'payroll-workflow'});}
        }
        await page.setViewportSize({width:1366,height:900});
      }
      evidence.assertions.push('guided scheme configuration retains unsaved input across panes, saves version, advances to checks and runs real preview without payroll entries');
      await settings.locator(':scope > summary').click();
      await page.locator('#payroll-create-toggle').click();
      await page.waitForFunction(id=>[...document.querySelector('#payroll-create-user').options].some(option=>option.value===id),seededPayrollUser);
      await selectOption(page.locator('#payroll-create-user'),seededPayrollUser);
      await page.locator('#payroll-create-from').fill(payrollFrom);await page.locator('#payroll-create-to').fill(priorMonthEnd);
      await selectOption(page.locator('#payroll-create-finance-category'),rent);
      await page.locator('#payroll-rule-new').click();
      await page.locator('#payroll-rule-name').fill('QA почасовая 500');
      await selectOption(page.locator('#payroll-rule-type'),'hourly');await page.locator('#payroll-rule-rate').fill('500');
      await captureControl(page.locator('#payroll-rule-form'),'payroll-basic-model');
      const newModel=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname==='/api/payroll/rules');
      await page.locator('#payroll-rule-form [type=submit]').click();const newModelResponse=await newModel;assert.equal(newModelResponse.status(),201);
      const model=(await newModelResponse.json());const modelId=model.id||model.item?.id;
      await page.waitForFunction(id=>document.querySelector('#payroll-create-rule').value===id,modelId);
      assert.equal(await page.locator('#payroll-create-user').inputValue(),seededPayrollUser);
      assert.equal(await page.locator('#payroll-create-from').inputValue(),payrollFrom);
      assert.equal(await page.locator('#payroll-create-to').inputValue(),priorMonthEnd);
      assert.equal(await page.locator('#payroll-create-finance-category').inputValue(),rent);
      await page.route('**/api/payroll/rules*',route=>route.fulfill({status:503,contentType:'application/json',body:'{"error":"temporary_unavailable"}'}),{times:1});
      const failedOptions=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/payroll/rules'&&response.status()===503);
      await page.locator('#payroll-options-retry').click();await failedOptions;
      await page.waitForFunction(()=>!document.querySelector('#payroll-options-retry').disabled);
      await page.locator('#payroll-options-retry').click();
      await page.waitForFunction(id=>document.querySelector('#payroll-create-rule').value===id&&!document.querySelector('#payroll-options-retry').disabled,modelId);
      assert.equal(await page.locator('#payroll-create-user').inputValue(),seededPayrollUser);assert.equal(await page.locator('#payroll-create-from').inputValue(),payrollFrom);
      await captureControl(page.locator('#payroll-create-form'),'payroll-prepared-accrual');
      const draftSave=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname==='/api/payroll/entries');
      await page.locator('#payroll-create-form [type=submit]').click();const draftResponse=await draftSave;assert.equal(draftResponse.status(),201);
      const payrollDraft=(await db.query('SELECT id,status,amount FROM payroll_entries WHERE venue_id=$1 AND user_id=$2',[venue,seededPayrollUser])).rows[0];
      assert.equal(payrollDraft.status,'draft');assert.equal(Number(payrollDraft.amount),4000);
      await page.locator(`[data-payroll-action="approve"][data-entry="${payrollDraft.id}"]`).waitFor();
      const approveEntry=page.waitForResponse(response=>response.request().method()==='PATCH'&&new URL(response.url()).pathname===`/api/payroll/entries/${payrollDraft.id}`);
      await page.locator(`[data-payroll-action="approve"][data-entry="${payrollDraft.id}"]`).click();assert.equal((await approveEntry).status(),200);
      await page.locator(`[data-payroll-payment-account="${payrollDraft.id}"]`).waitFor();
      await page.waitForFunction(id=>{const select=document.querySelector(`[data-payroll-payment-account="${id}"]`);return select&&!select.disabled&&!select.parentElement.querySelector(".custom-select-trigger")?.disabled;},payrollDraft.id,{timeout:5000});
      await selectOption(page.locator(`[data-payroll-payment-account="${payrollDraft.id}"]`),account);
      await selectOption(page.locator(`[data-payroll-payment-method="${payrollDraft.id}"]`),'card');
      await page.locator(`[data-payroll-payment-date="${payrollDraft.id}"]`).fill(priorMonthEnd);
      await captureControl(page.locator('.payroll-entry-row').filter({has:page.locator(`[data-payroll-action="pay"][data-entry="${payrollDraft.id}"]`)}),'payroll-approved-entry');
      const paidEntry=page.waitForResponse(response=>response.request().method()==='PATCH'&&new URL(response.url()).pathname===`/api/payroll/entries/${payrollDraft.id}`);
      await page.locator(`[data-payroll-action="pay"][data-entry="${payrollDraft.id}"]`).click();assert.equal((await paidEntry).status(),200);
      await page.waitForFunction(()=>document.querySelector('#payroll-register').textContent.includes('Выплачено'));
      const payout=(await db.query('SELECT pe.status,pe.expense_id,e.amount,e.source,e.finance_account_id,e.payment_method FROM payroll_entries pe JOIN expenses e ON e.id=pe.expense_id WHERE pe.id=$1',[payrollDraft.id])).rows[0];
      assert.equal(payout.status,'paid');assert.equal(Number(payout.amount),4000);assert.equal(payout.source,'payroll');assert.equal(payout.finance_account_id,account);assert.equal(payout.payment_method,'card');
      await captureControl(page.locator('#payroll-register'),'payroll-paid-register');
      await page.reload({waitUntil:'networkidle'});await page.locator('#payroll-filter-from').fill(payrollFrom);await page.locator('#payroll-filter-to').fill(priorMonthEnd);await page.locator('#payroll-reload').click();
      await page.waitForFunction(()=>document.querySelector('#payroll-register').textContent.includes('Выплачено'));
      evidence.assertions.push('actual hourly model created, selected employee/period/category retained through 503 retry; 8h × 500 = 4000 draft approved and paid from bank/card, linked expense and reload verified');

    }


  }

  if (process.env.FINANCE_NAV_SECTIONS_ONLY !== '1') {
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
  }
  assert.deepEqual(evidence.errors,[]);
  evidence.scope=process.env.FINANCE_NAV_SECTIONS_ONLY==='1'?'section-navigation':'full-finance';
  evidence.status=baseline?'BASELINE_CAPTURED':'PASS';
  console.log(`FINANCE NAVIGATION ${evidence.status}: ${artifacts}`);
} catch(error) { evidence.status='FAIL';evidence.failure={name:error.name,message:error.message};evidence.serverDiagnostics=serverDiagnostics;if(diagnosticPage&&!diagnosticPage.isClosed()){evidence.failureUi=await diagnosticPage.locator('#payroll-create-message,#payroll-message,#payroll-rule-message,[data-scheme-message]').allTextContents().catch(()=>[]);await diagnosticPage.screenshot({path:path.join(artifacts,'failure.png')}).catch(()=>{});}throw error; }
finally {
  await mkdir(artifacts,{recursive:true});await writeFile(path.join(artifacts,'evidence.json'),JSON.stringify(evidence,null,2));
  if(browser)await browser.close();
  if(child && child.exitCode===null){const ended=once(child,'exit');child.kill();await ended;}
  await db.end();
}
