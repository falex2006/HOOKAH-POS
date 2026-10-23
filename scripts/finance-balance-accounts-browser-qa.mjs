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
  let accountMode='error', reads=0, writes=0;
  const accounts=[{id:'bank-qa',name:'Основной расчётный счёт',kind:'bank'},{id:'cash-qa',name:'Наличные вне кассы смены',kind:'cash'}];
  await page.route('**/api/finance/balance-event-accounts',route=>{
    reads++;
    return route.fulfill({status:accountMode==='error'?503:200,contentType:'application/json',body:JSON.stringify(accountMode==='error'?{error:'qa_accounts_unavailable'}:{items:accountMode==='empty'?[]:accountMode==='single'?accounts.slice(0,1):accounts})});
  });
  await page.route('**/api/finance/account-transfers',route=>{if(route.request().method()!=='GET')writes++;return route.fulfill({status:200,contentType:'application/json',body:'{"items":[]}'});});
  await page.route('**/api/finance/opening-balances',route=>{if(route.request().method()!=='GET')writes++;return route.fulfill({status:200,contentType:'application/json',body:'{"items":[]}'});});
  await page.goto(`${base}/finance/report`,{waitUntil:'networkidle'});
  const panel=page.locator('[data-finance-balance-events]');
  const status=panel.locator('[data-balance-accounts-status]');
  const transfer=panel.locator('[data-balance-kind="transfer"]');
  const opening=panel.locator('[data-balance-kind="opening"]');
  await status.getByText('Не удалось загрузить счета. Повторите загрузку.',{exact:true}).waitFor({timeout:4000});
  assert.equal(await transfer.locator('[type="submit"]').isEnabled(),false);
  assert.equal(await opening.locator('[type="submit"]').isEnabled(),false);
  await transfer.locator('[name="note"]').fill('Черновик сохраняется при повторной загрузке');
  await transfer.locator('[name="amount"]').fill('123.45');
  const outputDir=path.resolve('tmp/finance-balance-accounts');await mkdir(outputDir,{recursive:true});
  for(const width of [320,390,768,1440]){
    await page.setViewportSize({width,height:900});await status.scrollIntoViewIfNeeded();
    const fit=await panel.evaluate(node=>{const r=node.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1&&node.scrollWidth<=node.clientWidth+1});
    assert.equal(fit,true,`accounts error fits ${width}`);
    await page.screenshot({path:path.join(outputDir,`accounts-error-${width}.png`),animations:'disabled'});
  }
  accountMode='empty';await status.getByRole('button',{name:'Повторить загрузку счетов'}).click();
  await status.getByText('Доступных счетов пока нет. Добавьте их в разделе «Финансы → Смена и касса».',{exact:true}).waitFor();
  assert.equal(await transfer.locator('[type="submit"]').isEnabled(),false);
  accountMode='single';await status.getByRole('button',{name:'Повторить загрузку счетов'}).click();
  await status.getByText('Для перевода нужны два разных счёта. Добавьте ещё один в разделе «Финансы → Смена и касса».',{exact:true}).waitFor();
  assert.equal(await transfer.locator('[type="submit"]').isEnabled(),false);
  assert.equal(await opening.locator('[type="submit"]').isEnabled(),true);
  accountMode='ready';await status.getByRole('button',{name:'Повторить загрузку счетов'}).click();
  await page.waitForFunction(()=>!document.querySelector('[data-balance-kind="transfer"] button[type="submit"]').disabled);
  assert.equal(await transfer.locator('[name="note"]').inputValue(),'Черновик сохраняется при повторной загрузке');
  assert.equal(await transfer.locator('[name="amount"]').inputValue(),'123.45');
  async function choose(name,label){
    const wrap=transfer.locator(`[name="${name}"]`).locator('..');
    await wrap.locator('.custom-select-trigger').click();await wrap.getByRole('option',{name:label,exact:true}).click();
  }
  await choose('fromAccountId','Основной расчётный счёт · банк');await choose('toAccountId','Наличные вне кассы смены · наличные');
  assert.equal(await transfer.locator('[name="fromAccountId"]').inputValue(),'bank-qa');
  assert.equal(await transfer.locator('[name="toAccountId"]').inputValue(),'cash-qa');
  assert.equal(await opening.locator('[type="submit"]').isEnabled(),true);
  assert.equal(reads,4);assert.equal(writes,0);
  await page.setViewportSize({width:390,height:844});await transfer.scrollIntoViewIfNeeded();await page.screenshot({path:path.join(outputDir,'accounts-ready-390.png'),animations:'disabled'});
  const pendingKey=await page.evaluate(()=>{
    const user=JSON.parse(localStorage.getItem('crm_session_user'));
    const key=`hookah-pos:pending-funding:${user.venueId||'venue'}:${user.id||'user'}:balance:transfer:new`;
    sessionStorage.setItem(key,JSON.stringify({key:'11111111-1111-4111-8111-111111111111',payload:{fromAccountId:'bank-qa',toAccountId:'cash-qa',amount:'91.23',transferDate:'2026-10-23',note:'Сохранённая тестовая попытка'}}));
    return key;
  });
  accountMode='error';await page.reload({waitUntil:'networkidle'});
  await status.getByText('Не удалось загрузить счета. Повторите загрузку.',{exact:true}).waitFor();
  assert.equal(await transfer.locator('[type="submit"]').innerText(),'Повторить сохранённую попытку');
  assert.equal(await transfer.locator('[type="submit"]').isEnabled(),true,'account GET failure does not block saved attempt');
  assert.equal(await transfer.locator('[name="amount"]').inputValue(),'91.23');
  assert.equal(await transfer.locator('[name="amount"]').isEnabled(),false);
  accountMode='ready';await status.getByRole('button',{name:'Повторить загрузку счетов'}).click();
  await status.waitFor({state:'hidden'});
  assert.equal(await transfer.locator('[name="fromAccountId"]').inputValue(),'bank-qa');
  assert.equal(await transfer.locator('[name="toAccountId"]').inputValue(),'cash-qa');
  assert.equal(await transfer.locator('[name="fromAccountId"]').isEnabled(),false);
  assert.equal(await transfer.getAttribute('data-key'),'11111111-1111-4111-8111-111111111111');
  assert.equal(await page.evaluate(key=>JSON.parse(sessionStorage.getItem(key)).payload.note,pendingKey),'Сохранённая тестовая попытка');
  assert.equal(writes,0);
  assert.deepEqual(exceptions,[]);
  console.log('BALANCE ACCOUNTS BROWSER QA: PASS (503, empty, retry, draft retention, visible account choices, four widths, no writes)');
} finally {
  await browser?.close();child.kill();
  if(child.exitCode===null)await Promise.race([once(child,'exit'),new Promise(resolve=>setTimeout(resolve,3000))]);
}
