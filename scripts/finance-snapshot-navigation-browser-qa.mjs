import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const playwrightPath = process.env.PLAYWRIGHT_PACKAGE_PATH;
if (!playwrightPath) throw new Error('Set PLAYWRIGHT_PACKAGE_PATH');
const { chromium } = createRequire(import.meta.url)(playwrightPath);
const child = spawn(process.execPath, ['server.js'], {
  cwd: fileURLToPath(new URL('../', import.meta.url)), windowsHide: true,
  env: { ...process.env, HOST: '127.0.0.1', PORT: '0', DATABASE_URL: '', AUTH_REQUIRED: 'false', DEMO_MODE: 'true', NODE_ENV: 'test' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stdout.on('data', (chunk) => { output += chunk; });
child.stderr.on('data', (chunk) => { output += chunk; });
const base = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`Coverage QA server did not start: ${output}`)), 15000);
  child.once('error', reject);
  child.stdout.on('data', () => { const match = output.match(/CRM running on http:\/\/localhost:(\d+)/); if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); } });
});
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: 'ru-RU' });
  const exceptions = [];
  page.on('pageerror', (error) => exceptions.push(error.message));
  await page.goto(`${base}/login`, { waitUntil: 'networkidle' });
  await page.locator('#login-username').fill('admin');
  await page.locator('#login-password').fill('admin');
  await page.locator('#login-form button[type="submit"]').click();
  await page.waitForURL((url) => !url.pathname.includes('/login'));
  const expense = n => ({ id: `expense-${n}`, source: 'manual', categoryName: 'Аренда', counterpartyName: `Арендодатель ${n}`, amount: '100.00', eventDate: '2026-10-22' });
  const orderId='33333333-3333-4333-8333-333333333333';
  let snapshots=0, pageReads=0, failFirst=true, expire=false, holdNext=false, releaseNext, signalNext;
  const nextGate=new Promise(resolve=>{releaseNext=resolve;});
  const nextSeen=new Promise(resolve=>{signalNext=resolve;});
  const report=()=>({ venue:{id:'venue-test',name:'Тестовое заведение',timeZone:'Asia/Yekaterinburg'}, snapshot:{id:`snapshot-${snapshots}`,expiresAt:new Date(Date.now()+900000).toISOString()}, items:{cashOutflows:[expense(1)],pos:[{orderId,includedAmountMinor:'150000',status:'complete',venueDate:'2026-10-22'}]}, sections:{cashOutflows:{count:3,knownTotalMinor:'30000',unknownAmountCount:0},pos:{count:1,knownTotalMinor:'150000',unknownAmountCount:0}},nextCursorBySection:{cashOutflows:'cursor-a'},coverage:{} });
  const fulfill=(route,data,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
  await page.route('**/api/finance/report-venues*',route=>fulfill(route,{items:[{id:'venue-test',name:'Тестовое заведение',timeZone:'Asia/Yekaterinburg',isCurrent:true}]}));
  await page.route('**/api/finance/categories?*',route=>fulfill(route,{items:[]}));
  await page.route('**/api/finance/unified-report/snapshots',route=>{snapshots++;return fulfill(route,report());});
  await page.route('**/api/finance/unified-report/snapshots/*/sections/cashOutflows?*',async route=>{
    pageReads++;
    if(holdNext){holdNext=false;signalNext();await nextGate;}
    if(expire)return fulfill(route,{error:'finance_report_snapshot_expired'},410);
    if(failFirst){failFirst=false;return fulfill(route,{error:'temporarily_unavailable'},503);}
    const cursor=new URL(route.request().url()).searchParams.get('cursor');
    assert.equal(new URL(route.request().url()).searchParams.get('venueId'),'venue-test');
    assert.ok(['cursor-a','cursor-b'].includes(cursor));
    return fulfill(route,{items:{cashOutflows:[expense(cursor==='cursor-a'?2:3)]},nextCursor:cursor==='cursor-a'?'cursor-b':null});
  });
  await page.route('**/api/finance/source-documents/pos/*',route=>fulfill(route,{venue:{id:'venue-test'},document:{orderId,subtotal:1800,discount:300,due:1500,paid:1500,pricingLines:[{productName:'Напиток с длинным названием для проверки мобильного окна',quantity:2,unitPrice:750}]}}));
  await page.goto(`${base}/finance/report`,{waitUntil:'networkidle'});
  const group=page.locator('.report-source-group').filter({has:page.locator('[data-unified-report-next="cashOutflows"]')});
  await group.locator('summary').click();
  let next=group.locator('[data-unified-report-next]');
  await next.click();
  await page.getByText('Не удалось загрузить страницу снимка. Повторите попытку.',{exact:true}).waitFor();
  assert.equal(await group.locator('.report-row').count(),1,'failed page keeps existing records');
  assert.equal(await next.isEnabled(),true,'failed page permits retry');
  await next.scrollIntoViewIfNeeded();
  const firstRowTop=await group.locator('.report-row').first().evaluate(node=>node.getBoundingClientRect().top);
  await next.click();
  await page.waitForFunction(()=>[...document.querySelectorAll('.report-row')].some(node=>node.textContent.includes('Арендодатель 2')));
  assert.equal(await group.evaluate(node=>node.open),true,'load more keeps section expanded');
  assert.equal(await group.locator('.report-row').count(),2);
  assert.equal(await next.evaluate(node=>document.activeElement===node),true,'next page preserves button focus');
  assert.ok(Math.abs((await group.locator('.report-row').first().evaluate(node=>node.getBoundingClientRect().top))-firstRowTop)<3,'appending preserves the current scroll position');
  assert.equal(await page.getByText('Не удалось загрузить страницу снимка. Повторите попытку.',{exact:true}).count(),0,'successful retry removes page error');
  await next.click();
  const completed=page.locator('.report-source-group').filter({hasText:'Арендодатель 3'});
  await completed.waitFor();
  assert.equal(await completed.evaluate(node=>node.open),true);
  assert.equal(await completed.locator('.report-row').count(),3,'last page appends once');
  assert.equal(await completed.locator('[data-unified-report-next]').count(),0,'finished report has no more-pages action');
  assert.equal(await completed.getByText('Все строки показаны',{exact:true}).count(),1);
  assert.equal(await completed.getByText('Все строки показаны',{exact:true}).evaluate(node=>document.activeElement===node),true,'last page keeps focus inside the expanded group');
  const outputDir=path.resolve(process.env.QA_OUTPUT_DIR||'tmp/finance-snapshot-navigation');await mkdir(outputDir,{recursive:true});
  for(const width of [320,390,768,1440]){
    await page.setViewportSize({width,height:844});
    await completed.locator('summary').scrollIntoViewIfNeeded();
    const bounds=await completed.evaluate(node=>{const r=node.getBoundingClientRect();return{left:r.left,right:r.right,viewport:innerWidth}});
    assert.ok(bounds.left>=0&&bounds.right<=width+1,`snapshot group fits ${width}`);
    const pos=page.locator('.report-source-group').filter({has:page.locator('[data-report-source="pos"]')});
    if(!await pos.evaluate(node=>node.open))await pos.locator('summary').click();
    const opener=pos.locator('[data-report-source="pos"]');await opener.click();
    const dialog=page.getByRole('dialog').filter({hasText:'Исходный чек'});await dialog.waitFor({state:'visible'});
    await dialog.getByText('Итог: 1 500 ₽',{exact:true}).waitFor();
    const fit=await dialog.evaluate(node=>{const r=node.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1&&node.scrollWidth<=node.clientWidth+1});assert.equal(fit,true,`POS source fits ${width}`);
    await dialog.screenshot({path:path.join(outputDir,`pos-source-${width}.png`)});
    await dialog.locator('[type="submit"]').click();await dialog.waitFor({state:'hidden'});
    assert.equal(await opener.evaluate(node=>document.activeElement===node),true);
  }
  await page.locator('[data-unified-load]').click();await group.waitFor();await group.locator('summary').click();
  await page.setViewportSize({width:320,height:844});
  expire=true;next=group.locator('[data-unified-report-next]');await next.click();
  await group.getByText('Снимок истёк. Сформируйте новый отчёт.',{exact:true}).waitFor();
  await next.scrollIntoViewIfNeeded();await page.screenshot({path:path.join(outputDir,'snapshot-expired-320.png')});
  const oldReads=pageReads,oldSnapshots=snapshots;
  await group.getByRole('button',{name:'Сформировать новый отчёт',exact:true}).click();await group.waitFor();
  assert.equal(snapshots,oldSnapshots+1,'expiry action creates a new snapshot');assert.equal(pageReads,oldReads,'expiry action does not reuse the expired cursor');
  expire=false;holdNext=true;
  await group.locator('summary').click();await group.locator('[data-unified-report-next]').click();await nextSeen;
  await page.locator('[data-unified-load]').click();await group.waitFor();
  const lateResponse=page.waitForResponse(response=>response.url().includes('/sections/cashOutflows?'));
  releaseNext();await (await lateResponse).finished();
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  assert.equal(await group.locator('.report-row').count(),1,'late old-snapshot page cannot enter refreshed report');
  assert.deepEqual(exceptions,[]);
  console.log('FINANCE SNAPSHOT NAVIGATION BROWSER QA: PASS (page error/retry, expanded state/focus, append/final, expiry refresh, POS source at four widths)');
} finally {
  await browser?.close();child.kill();
  if(child.exitCode===null)await Promise.race([once(child,'exit'),new Promise(resolve=>setTimeout(resolve,3000))]);
}
