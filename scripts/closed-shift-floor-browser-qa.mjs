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

const artifacts = path.join(root, 'tmp/closed-shift-floor-qa', `acceptance-${Date.now()}-${process.pid}`);
const evidence = { screenshots: [], assertions: [], errors: [] };
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
  for (const [key, role, membership] of [['owner','bartender','member']]) {
    logins[key] = `finance-nav-${process.pid}-${key}`;
    const user = (await db.query('INSERT INTO users(organization_id,venue_id,full_name,login,password_hash,role) VALUES($1,$2,$3,$4,$5,$6) RETURNING id', [org,venue,`Finance QA ${key}`,logins[key],hash,role])).rows[0].id;
    if(key==='reader')await db.query("UPDATE users SET permission_scopes='[\"finance_read\"]'::jsonb WHERE id=$1",[user]);
    await db.query("INSERT INTO organization_memberships(organization_id,user_id,membership_role,status) VALUES($1,$2,$3,'active')", [org,user,membership]);
  }
  const zone=(await db.query("INSERT INTO zones(venue_id,name) VALUES($1,'QA зал') RETURNING id",[venue])).rows[0].id;
  const table=(await db.query("INSERT INTO tables(zone_id,name,capacity) VALUES($1,'QA стол',4) RETURNING id",[zone])).rows[0].id;
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
  const gate=page.locator('#staff-floor-shift-gate');
  const assertBlocked=async(state)=>{
    await page.locator(`#staff-floor-shift-gate[data-state="${state}"]`).waitFor();
    assert.equal(await gate.isVisible(),true);
    if(state==='closed'){assert.equal(await gate.locator('h2').textContent(),'Смена закрыта');assert.equal(await page.getByRole('button',{name:'Открыть смену',exact:true}).count(),1);assert.equal(await page.locator('#shift-toggle').isVisible(),false);}
    for(const selector of ['#tables','.pos-floor-heading','.order'])assert.equal(await page.locator(selector).isVisible(),false,`${state} hides ${selector}`);
  };
  const shot=async(label)=>{const file=`${label}.png`;await page.screenshot({path:path.join(artifacts,file)});evidence.screenshots.push(file);};
  const assertOpen=async()=>{await page.locator('#shift-toggle[data-shift-state="open"]').waitFor();await page.locator(`#tables .table[data-table="${table}"]`).waitFor();assert.equal(await gate.isVisible(),false);};
  const openShift=async()=>{
    await page.locator('[data-floor-shift-open]').click();await page.locator('#staff-action-modal.open').waitFor();
    assert.equal(await page.locator('#staff-action-title').textContent(),'Открыть смену');
    await page.locator('[name=openingCash]').fill('0');
    const response=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname==='/api/shifts');
    await page.locator('#staff-action-submit').click();const result=await response;assert.equal(result.status(),201);await assertOpen();return(await result.json()).id;
  };
  await page.goto(base,{waitUntil:'networkidle'});await assertBlocked('closed');await shot('closed-desktop');
  assert.equal(Number((await db.query('SELECT count(*) FROM shifts WHERE venue_id=$1 AND closed_at IS NULL',[venue])).rows[0].count),0);
  evidence.assertions.push('authentic closed shift hides floor, table creation controls and order panel');
  let shift=await openShift();await shot('open-desktop');
  await page.reload({waitUntil:'networkidle'});await assertOpen();
  assert.equal((await db.query('SELECT id FROM shifts WHERE venue_id=$1 AND closed_at IS NULL',[venue])).rows[0].id,shift);
  evidence.assertions.push('gate CTA uses existing shift form; actual POST persists open shift across reload');
  await page.locator('#shift-toggle').click();await page.locator('#staff-action-modal.open').waitFor();await page.locator('[name=closingCash]').fill('0');
  const checks=page.locator('#staff-action-fields input[type=checkbox]');assert.equal(await checks.count(),4);for(const checkbox of await checks.all())await checkbox.check();
  const closed=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname===`/api/shifts/${shift}/close`);
  await page.locator('#staff-action-submit').click();assert.equal((await closed).status(),200);await assertBlocked('closed');
  await page.reload({waitUntil:'networkidle'});await assertBlocked('closed');
  evidence.assertions.push('UI close with four required checklist attestations hides floor and persists after reload');
  shift=await openShift();
  const closeRemote=await page.context().request.post(`${base}/api/shifts/${shift}/close`,{data:{closingCash:0,checklist:{version:1,items:{ordersReviewed:true,cashCounted:true,inventoryReviewed:true,externalFiscalReportsHandled:true}}}});
  assert.equal(closeRemote.status(),200);await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await assertBlocked('closed');
  evidence.assertions.push('remote API closure refreshes on focus and hides stale floor');
  let releaseShiftRead;const readGate=new Promise(resolve=>{releaseShiftRead=resolve;});let requestObserved;
  const observed=new Promise(resolve=>{requestObserved=resolve;});
  await page.route('**/api/shifts',async route=>{if(route.request().method()==='GET'){requestObserved();await readGate;}await route.continue();});
  await page.goto(base,{waitUntil:'domcontentloaded'});await observed;await assertBlocked('loading');await shot('loading-desktop');releaseShiftRead();await assertBlocked('closed');await page.unroute('**/api/shifts');
  shift=await openShift();
  let failShift=true;
  await page.route('**/api/shifts',route=>failShift&&route.request().method()==='GET'?route.fulfill({status:503,contentType:'application/json',body:'{"error":"temporary_unavailable"}'}):route.continue());
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await assertBlocked('error');await shot('error-desktop');
  assert.equal(await page.locator('[data-floor-shift-open]').isVisible(),false);
  failShift=false;await page.locator('[data-floor-shift-retry]').click();await assertOpen();await page.unroute('**/api/shifts');
  const finalClose=await page.context().request.post(`${base}/api/shifts/${shift}/close`,{data:{closingCash:0,checklist:{version:1,items:{ordersReviewed:true,cashCounted:true,inventoryReviewed:true,externalFiscalReportsHandled:true}}}});assert.equal(finalClose.status(),200);await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await assertBlocked('closed');
  evidence.assertions.push('pending shift read and error invalidate formerly open floor; explicit retry restores verified open state');
  for(const malformed of [{},{id:123}]) {
    await page.route('**/api/shifts',route=>route.request().method()==='GET'?route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({current:malformed,items:[]})}):route.continue());
    await page.reload({waitUntil:'networkidle'});await assertBlocked('error');assert.equal(await page.locator('[data-floor-shift-open]').isVisible(),false);await page.unroute('**/api/shifts');
  }
  evidence.assertions.push('fresh document rejects malformed current {} and numeric id123 as error, floor remains hidden');
  await page.reload({waitUntil:'networkidle'});await assertBlocked('closed');
  const mobileContext=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:1,storageState:await page.context().storageState()});
  const mobile=await mobileContext.newPage();await paceSessionReads(mobile);await mobile.goto(base,{waitUntil:'networkidle'});
  await mobile.locator('#staff-floor-shift-gate[data-state=closed]').waitFor();assert.equal(await mobile.locator('#tables').isVisible(),false);assert.equal(await mobile.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
  assert.equal(await mobile.getByRole('button',{name:'Открыть смену',exact:true}).count(),1);assert.equal(await mobile.locator('#shift-toggle').isVisible(),false);
  await mobile.screenshot({path:path.join(artifacts,'closed-mobile390.png')});evidence.screenshots.push('closed-mobile390.png');
  await mobile.locator('[data-floor-shift-open]').tap();await mobile.locator('#staff-action-modal.open').waitFor();await mobile.locator('[name=openingCash]').fill('0');
  const mobileOpened=mobile.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname==='/api/shifts');await mobile.locator('#staff-action-submit').tap();assert.equal((await mobileOpened).status(),201);
  await mobile.locator(`#tables .table[data-table="${table}"]`).waitFor();await mobile.screenshot({path:path.join(artifacts,'open-mobile390.png')});evidence.screenshots.push('open-mobile390.png');await mobileContext.close();
  evidence.assertions.push('Chromium touch390 closed gate has no overflow and real open form restores table');
  assert.deepEqual(evidence.errors,[]);evidence.status='PASS';console.log(`CLOSED SHIFT FLOOR PASS: ${artifacts}`);
} catch(error) { if(browser){for(const context of browser.contexts()){const p=context.pages().at(-1);if(p)await p.screenshot({path:path.join(artifacts,'failure.png')}).catch(()=>{});}}evidence.status='FAIL';evidence.failure={name:error.name,message:error.message};evidence.serverDiagnostics=serverDiagnostics;throw error; }
finally {
  await mkdir(artifacts,{recursive:true});await writeFile(path.join(artifacts,'evidence.json'),JSON.stringify(evidence,null,2));
  if(browser)await browser.close();
  if(child && child.exitCode===null){const ended=once(child,'exit');child.kill();await ended;}
  await db.end();
}
