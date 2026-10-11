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
  env: { ...process.env, HOST: '127.0.0.1', PORT: '0', DATABASE_URL: '', AUTH_REQUIRED: 'false', DEMO_MODE: 'false', NODE_ENV: 'test' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stdout.on('data', (chunk) => { output += chunk; });
child.stderr.on('data', (chunk) => { output += chunk; });
let browser;
try {
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Staff QA server did not start: ${output}`)), 15000);
    child.once('error', reject);
    child.stdout.on('data', () => { const match = output.match(/CRM running on http:\/\/localhost:(\d+)/); if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); } });
  });
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: 'ru-RU' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${base}/login`, { waitUntil: 'networkidle' });
  await page.locator('#login-username').fill('owner'); await page.locator('#login-password').fill('demo');
  await page.locator('#login-form button[type="submit"]').click(); await page.waitForURL(url => !url.pathname.includes('/login'));
  const api = async (route, method='GET', body) => page.evaluate(async ({route,method,body}) => {
    const response = await fetch(route,{method,headers:{Authorization:`Bearer ${localStorage.getItem('crm_session_token')}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
    if(!response.ok) throw new Error(`${route}: ${response.status} ${await response.text()}`); return response.json();
  },{route,method,body});
  const floor = await api('/api/floor');
  const zone = floor.zones?.[0] || await api('/api/floor/zones','POST',{expectedVenueId:floor.venueId,name:'QA totals'});
  const table = await api('/api/floor/tables','POST',{expectedVenueId:floor.venueId,zoneId:zone.id,name:'QA minimum table',capacity:2,minimumOrderTotal:1200,minimumOrderStartTime:null,minimumOrderEndTime:null});
  const product = await api('/api/products','POST',{name:'QA total item',category:'Услуги',price:250,inventoryMode:'non_stock'});
  const order = await api('/api/orders','POST',{tableId:table.id});
  await api(`/api/orders/${order.id}/items`,'POST',{productId:product.id,quantity:1});
  assert.equal((await api(`/api/orders/${order.id}/summary`)).due,1200);
  await page.goto(`${base}/`,{waitUntil:'networkidle'});
  const card = page.locator(`.table[data-table="${table.id}"]`);
  await card.locator('.table-order-total').waitFor();
  assert.match(await card.locator('.table-order-total').textContent(),/1[\s\u00a0]200 ₽/);
  for (const mode of ['default','density','grid']) {
    await page.evaluate(mode => { const tables=document.querySelector('#tables'); if(mode==='density')tables.classList.add('density-map'); if(mode==='grid')tables.classList.remove('has-map','density-map'); },mode);
    const boxes = await card.evaluate(node=>({total:node.querySelector('.table-order-total').getBoundingClientRect().toJSON(),status:node.querySelector('em').getBoundingClientRect().toJSON(),timer:node.querySelector('.table-elapsed').getBoundingClientRect().toJSON(),card:node.getBoundingClientRect().toJSON()}));
    assert.ok(boxes.total.top>=boxes.status.bottom-1,`${mode}: total must not overlap status`);
    assert.ok(boxes.timer.top>=boxes.total.bottom-1,`${mode}: timer must follow total`);
    assert.ok(boxes.timer.bottom<=boxes.card.bottom+1,`${mode}: timer must fit card`);
  }
  await mkdir(path.resolve('tmp/consolidated-qa'),{recursive:true});
  await page.screenshot({path:path.resolve('tmp/consolidated-qa/floor-total-desktop.png'),fullPage:true});
  assert.deepEqual(errors,[]);
  console.log('FLOOR ORDER TOTAL DESKTOP QA: PASS (authoritative minimum; separate status/total/timer rows; map/density/grid; no JS errors)');
} finally { await browser?.close(); child.kill(); }
