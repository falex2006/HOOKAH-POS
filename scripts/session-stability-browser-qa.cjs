const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE_PATH || 'playwright');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'tmp', `session-stability-browser-${Date.now()}`);
fs.mkdirSync(output, { recursive: true });
let status = 200;
let sessionRequests = 0;
let stallScript = false;
const hanging = new Set();
const session = { user: { id: 'fixture-user', role: 'owner', venueId: 'fixture-venue', organizationId: 'fixture-org' }, permissions: ['inventory_read'] };
const inventorySource = fs.readFileSync(path.join(root, 'inventory.html'), 'utf8');
const guardStyle = inventorySource.match(/<style id="portal-session-style">[\s\S]*?<\/style>/)?.[0];
assert.ok(guardStyle, 'inventory guard styles must be used without a fixture substitute');
const styles = [...inventorySource.matchAll(/<link[^>]*rel="stylesheet"[^>]*>/g)].map(match => match[0]).join('');
const html = `<!doctype html><html lang="ru" data-portal-access="checking"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Local session fixture</title>${styles}${guardStyle}</head><body class="portal velora-theme" data-page="inventory"><main><h1>Локальная проверка восстановления</h1><input id="unsaved" value="Черновик сохранён на странице"></main><script src="/portal-session.js"></script></body></html>`;
const login = '<!doctype html><meta charset="utf-8"><form id="login-form"><input id="login-username"><input id="login-password"><button type="submit">Войти</button><p id="login-message"></p></form><script src="/login.js"></script>';
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const send = (body, type='text/html', code=200) => { res.writeHead(code, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store' }); res.end(body); };
  if (['/style.css','/management-theme.css'].includes(url.pathname)) return send(fs.readFileSync(path.join(root,url.pathname.slice(1)), 'utf8'), 'text/css');
  if (url.pathname.startsWith('/assets/')) return send('', 'text/plain', 204);
  if (url.pathname === '/api/session') {
    sessionRequests++;
    if(status===429) res.setHeader('Retry-After','2');
    return send(JSON.stringify(status === 200 ? session : { error: 'fixture_error' }), 'application/json', status);
  }
  if (url.pathname === '/api/setup/status') return send('{"required":false}', 'application/json');
  if (url.pathname === '/portal-session.js' || url.pathname === '/login.js') return send(fs.readFileSync(path.join(root,url.pathname.slice(1)), 'utf8'), 'text/javascript');
  if (url.pathname === '/portal.js') {
    if (stallScript) { hanging.add(res); res.on('close', () => hanging.delete(res)); return; }
    return send('window.fixturePortalExecutions=(window.fixturePortalExecutions||0)+1;', 'text/javascript');
  }
  if (url.pathname === '/login') return send(login);
  if (url.pathname === '/favicon.ico') return send('', 'text/plain', 204);
  return send(html);
});
(async () => {
  let browser;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}), headless:true });
    const context = await browser.newContext({ viewport: { width:1366, height:768 } });
    const page = await context.newPage();
    const errors=[]; context.on('page', p => p.on('pageerror', e => errors.push(e.message))); page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${origin}/login`);
    await page.evaluate(() => localStorage.setItem('crm_session_token', 'fixture-token'));
    await page.goto(`${origin}/inventory`);
    await page.waitForFunction(() => window.fixturePortalExecutions === 1 && !window.__portalSessionGate.blocked);
    await page.locator('#unsaved').fill('Изменённый черновик');
    status=503;
    await page.evaluate(() => window.__portalSessionGate.refresh());
    await page.locator('[data-session-retry]').waitFor({ state:'visible' });
    assert.match(await page.locator('[data-session-message]').innerText(), /Не удалось проверить доступ/);
    assert.equal(await page.evaluate(() => localStorage.getItem('crm_session_token')), 'fixture-token');
    await page.screenshot({ path:path.join(output,'503-retry.png') });
    status=200;
    await page.locator('[data-session-retry]').click();
    await page.waitForFunction(() => !window.__portalSessionGate.blocked);
    assert.equal(await page.locator('#unsaved').inputValue(), 'Изменённый черновик');
    assert.equal(await page.evaluate(() => window.fixturePortalExecutions), 1);
    await page.screenshot({ path:path.join(output,'same-session-recovered.png') });
    await page.clock.install();
    status=503;
    await page.evaluate(() => window.__portalSessionGate.refresh());
    status=429;
    await page.locator('[data-session-retry]').click();
    await page.waitForFunction(() => document.querySelector('[data-session-message]')?.textContent.includes('Повтор через 2 с'));
    assert.equal(await page.locator('[data-session-retry]').isDisabled(),true);
    const beforeFocus = sessionRequests;
    await page.evaluate(() => { window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('focus')); return window.__portalSessionGate.refresh(); });
    assert.equal(sessionRequests,beforeFocus,'focus and manual refresh respect Retry-After');
    assert.equal(await page.evaluate(() => localStorage.getItem('crm_session_token')), 'fixture-token');
    await page.screenshot({path:path.join(output,'rate-limit-countdown.png')});
    status=200;
    await page.clock.fastForward(2100);
    await page.waitForFunction(() => !window.__portalSessionGate.blocked);
    assert.equal(sessionRequests,beforeFocus+1,'one automatic retry at cooldown expiry');
    assert.equal(await page.evaluate(() => localStorage.getItem('crm_session_token')), 'fixture-token');
    assert.equal(await page.locator('#unsaved').inputValue(), 'Изменённый черновик');
    const sibling = await context.newPage();
    await sibling.goto(`${origin}/login`);
    await sibling.waitForFunction(() => document.body.dataset.loginState === 'idle');
    assert.equal(await page.evaluate(() => localStorage.getItem('crm_session_token')), 'fixture-token');
    assert.equal(await page.locator('#unsaved').inputValue(), 'Изменённый черновик');
    await sibling.close();
    status=401;
    await page.evaluate(() => window.__portalSessionGate.refresh()).catch(() => {});
    await page.waitForURL('**/login');
    assert.equal(await page.evaluate(() => localStorage.getItem('crm_session_token')), null);
    for (const width of [1366, 390]) {
      await page.setViewportSize({ width, height:768 });
      status=200; stallScript=true;
      await page.evaluate(() => localStorage.setItem('crm_session_token','fixture-token'));
      await page.goto(`${origin}/inventory`, { waitUntil:'domcontentloaded' });
      await page.waitForFunction(() => document.querySelector('script[src^="/portal.js"]'));
      const guard = page.locator('#portal-session-guard');
      assert.equal((await guard.innerText()).trim(), '', 'initial loading has no brand or access-check text');
      assert.equal(await guard.getAttribute('data-loading'), 'true');
      await page.screenshot({path:path.join(output,`initial-loading-${width}.png`)});
      await page.clock.fastForward(16000);
      await page.locator('[data-session-retry]').waitFor({ state:'visible' });
      const message=await page.locator('[data-session-message]').innerText();
      assert.match(message, /Повторите/);
      assert.doesNotMatch(message, /\uFFFD|Hookah POS|Проверяем доступ/);
      const dimensions = await guard.evaluate(element => {
        const rect=element.getBoundingClientRect();
        return { left:rect.left, right:rect.right, height:rect.height, inner:element.scrollWidth, width:element.clientWidth, viewport:innerWidth, page:document.documentElement.scrollWidth };
      });
      assert.ok(dimensions.left>=0 && dimensions.right<=width, 'guard stays within viewport');
      assert.ok(dimensions.inner<=dimensions.width+1 && dimensions.page<=width, 'no horizontal overflow');
      assert.ok(dimensions.height<=150, 'retry notification remains compact');
      assert.equal(await page.evaluate(() => localStorage.getItem('crm_session_token')), 'fixture-token');
      await page.screenshot({path:path.join(output,`script-timeout-retry-${width}.png`)});
      stallScript=false;
      await page.locator('[data-session-retry]').click();
      await page.waitForFunction(() => window.fixturePortalExecutions === 1 && !window.__portalSessionGate.blocked);
      await page.screenshot({path:path.join(output,`script-recovered-${width}.png`)});
    }
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ result:'PASS', scope:'Real Chromium; actual portal-session.js/login.js; local mock HTTP and portal script sentinel, not live DB E2E', scenarios:['503 preserves token','429 Retry-After2 countdown disables retry, suppresses focus/manual requests and auto recovers','same-session retry retains DOM draft','sibling login retains session','current401 clears token','portal script deadline exposes retry','retry reloads exactly once','1366/390 actual inventory CSS: initial spinner only; compact retry without overflow'], screenshots:output, pageErrors:errors },null,2));
  } finally {
    if(browser) await browser.close();
    for(const response of hanging) response.destroy();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => {console.error(error);process.exitCode=1;});
