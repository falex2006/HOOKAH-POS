import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

if (!process.env.PLAYWRIGHT_PACKAGE_PATH) throw new Error('Set PLAYWRIGHT_PACKAGE_PATH');
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_PACKAGE_PATH);
const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
const { port } = probe.address(); await new Promise(resolve => probe.close(resolve));
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['server.js'], {
  cwd: fileURLToPath(new URL('../', import.meta.url)), windowsHide: true,
  env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DATABASE_URL: '', AUTH_REQUIRED: 'true', DEMO_OWNER_PASSWORD: 'demo', API_RATE_LIMIT: '5000' },
  stdio: ['ignore', 'pipe', 'pipe']
});
let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
let browser;
try {
  if (!output.includes('CRM running on')) await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server timeout: ${output}`)), 15_000);
    child.stdout.on('data', chunk => { if (String(chunk).includes('CRM running on')) { clearTimeout(timer); resolve(); } });
    child.once('exit', code => reject(new Error(`server exited ${code}: ${output}`)));
  });
  const login = async (username, password) => {
    const response = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
    const payload = await response.json(); assert.equal(response.status, 200, `${username} login: ${JSON.stringify(payload)}`); return payload;
  };
  const owner = await login('owner', 'demo');
  const sessions = [['owner', owner]];
  const tenantRoles = ['admin', 'manager', 'developer', 'bartender', 'senior_bartender', 'hookah_master', 'senior_hookah_master'];
  for (const [index, role] of tenantRoles.entries()) {
    const staffName = `helpqa_${index}_${Date.now().toString(36)}`;
    const created = await fetch(base + '/api/staff', { method: 'POST', headers: { Authorization: `Bearer ${owner.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: `Help QA ${role}`, role, login: staffName, password: 'demo', birthDate: '1990-01-01' }) });
    assert.equal(created.status, 201, `${role} fixture: ${await created.text()}`);
    sessions.push([role, await login(staffName, 'demo')]);
  }
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' });
  const helpDestinations = ['/', '/orders', '/clients', '/inventory', '/finance', '/admin#permissions'];
  const managementRoles = new Set(['owner', 'admin', 'manager', 'developer']);
  for (const [sessionIndex, [role, session]] of sessions.entries()) {
    // Isolate the session-read rate bucket for each synthetic browser user.
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ru-RU', permissions: ['clipboard-read', 'clipboard-write'], reducedMotion: 'reduce', extraHTTPHeaders: { 'X-Forwarded-For': `127.0.1.${sessionIndex + 1}` } });
    await context.addInitScript(({ token, user }) => { localStorage.setItem('crm_session_token', token); localStorage.setItem('crm_session_user', JSON.stringify(user)); }, { token: session.token, user: session.user });
    const page = await context.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(base + '/admin#help', { waitUntil: 'domcontentloaded' });
    const form = page.locator('#help-feedback-form'); await form.waitFor({ state: 'visible' });
    assert.equal(await page.locator('.help-topic[open]').count(), 0, `${role} help starts collapsed`);
    const topics = page.locator('.help-topic');
    assert.equal(await topics.count(), 6, `${role} sees six help topics`);
    const chevronRightEdges = [];
    for (let index = 0; index < 6; index++) {
      const topic = topics.nth(index);
      const summary = topic.locator('summary');
      const chevron = topic.locator('.help-topic-chevron');
      chevronRightEdges.push((await chevron.boundingBox()).x + (await chevron.boundingBox()).width);
      await summary.click();
      assert.equal(await topic.evaluate(node => node.open), true, `${role} topic ${index} opens`);
      assert.equal(await topic.locator('li').count(), 3, `${role} topic ${index} has three steps`);
      const allowed = index < 3 || (index === 3 && managementRoles.has(role)) || (index === 4 && managementRoles.has(role)) || (index === 5 && role === 'owner');
      const link = topic.locator('a.button');
      if (allowed) {
        assert.equal(await link.isVisible(), true, `${role} topic ${index} link is visible`);
        assert.equal(await link.getAttribute('href'), helpDestinations[index], `${role} topic ${index} destination`);
      } else {
        assert.equal(await link.count(), 0, `${role} topic ${index} has no inaccessible link`);
        assert.equal(await topic.locator('.help-topic-access-note').isVisible(), true, `${role} topic ${index} explains access`);
        if (role === 'bartender' && [3, 5].includes(index)) {
          await topic.scrollIntoViewIfNeeded();
          await page.screenshot({ path: `tmp/help-topic-denied-${index}-bartender-390.png` });
        }
      }
      await summary.click();
      assert.equal(await topic.evaluate(node => node.open), false, `${role} topic ${index} closes`);
    }
    assert.equal(Math.max(...chevronRightEdges) - Math.min(...chevronRightEdges) < 1, true, `${role} disclosure arrows align`);
    assert.match(await page.locator('.help-feedback-card').innerText(), /не отправляется автоматически/);
    const field = page.locator('#help-feedback'); const copy = form.getByRole('button', { name: 'Скопировать текст' });
    assert.equal(await field.getAttribute('maxlength'), '1000');
    await field.fill('   '); await copy.click();
    assert.match(await field.evaluate(node => node.validationMessage), /Опишите вопрос/);
    assert.equal(await page.evaluate(() => localStorage.getItem('crm_help_feedback')), null, 'whitespace is not saved');
    const question = `QA вопрос ${role}`;
    await field.fill(question); await copy.click();
    await page.getByText('Текст скопирован. Передайте его управляющему.').waitFor();
    await page.waitForFunction(() => document.querySelector('#help-feedback-form button[type=submit]')?.textContent === 'Скопировать текст');
    assert.equal(await copy.isEnabled(), true, 'copy action returns to its ready state');
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), question, `${role} clipboard content`);
    assert.equal(await field.inputValue(), question, 'successful copy preserves editable text');
    assert.equal((await page.evaluate(() => JSON.parse(localStorage.getItem('crm_help_feedback')))).length, 1, 'local backup retained');
    await copy.click();
    assert.equal((await page.evaluate(() => JSON.parse(localStorage.getItem('crm_help_feedback')))).length, 1, 'repeat copy does not duplicate local backup');
    await field.scrollIntoViewIfNeeded();
    if (['owner', 'manager', 'bartender'].includes(role)) await page.screenshot({ path: `tmp/help-feedback-${role}-390-success.png` });
    await page.evaluate(() => {
      window.__helpOriginalSetItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) { if (key === 'crm_help_feedback') throw new Error('storage unavailable'); return window.__helpOriginalSetItem.call(this, key, value); };
    });
    await field.fill(`QA без хранилища ${role}`); await copy.click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), `QA без хранилища ${role}`, 'copy works if local backup fails');
    assert.equal(await field.inputValue(), `QA без хранилища ${role}`);
    assert.equal((await page.evaluate(() => JSON.parse(localStorage.getItem('crm_help_feedback')))).length, 1, 'failed local backup is not misreported as saved');
    await page.evaluate(() => { Storage.prototype.setItem = window.__helpOriginalSetItem; delete window.__helpOriginalSetItem; });
    await page.evaluate(() => { Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: async () => { throw new Error('clipboard denied'); } }); });
    await field.fill(`QA ошибка копирования ${role}`); await copy.click();
    await page.getByText('Не удалось скопировать. Текст выделен: передайте его управляющему вручную.').waitFor();
    assert.equal(await copy.textContent(), 'Скопировать текст', 'copy failure does not show a save spinner');
    assert.equal(await copy.isEnabled(), true);
    assert.equal(await field.inputValue(), `QA ошибка копирования ${role}`);
    assert.equal(await field.evaluate(node => node.selectionStart === 0 && node.selectionEnd === node.value.length), true, 'failed copy selects original text');
    for (const width of [320, 390, 1440]) {
      await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${role} help fits ${width}px`);
      if (width === 390 && ['owner', 'manager', 'bartender'].includes(role)) { await field.scrollIntoViewIfNeeded(); await page.screenshot({ path: `tmp/help-feedback-${role}-390.png` }); }
    }
    await page.setViewportSize({ width: 390, height: 844 });
    const allowedDestinations = role === 'owner' ? helpDestinations : managementRoles.has(role) ? helpDestinations.slice(0, 5) : helpDestinations.slice(0, 3);
    for (const destination of allowedDestinations) {
      const index = helpDestinations.indexOf(destination);
      await page.locator('#help-feedback-form').waitFor({ state: 'visible' });
      assert.equal(await page.locator('.help-topic[open]').count(), 0, `${role} help resets closed before ${destination}`);
      const topic = page.locator('.help-topic').nth(index);
      await topic.locator('summary').click();
      await topic.locator('a.button').click();
      const expected = new URL(destination, base);
      await page.waitForURL(url => url.pathname === expected.pathname && url.hash === expected.hash, { timeout: 10_000 });
      await page.waitForFunction(() => !document.documentElement.dataset.portalAccess, null, { timeout: 10_000 });
      try {
        await page.locator(destination === '/' ? '#shift-toggle' : '#page-content h1').first().waitFor({ state: destination === '/' ? 'attached' : 'visible', timeout: 10_000 });
      } catch (error) {
        const diagnostic = await page.evaluate(() => ({ url: location.href, access: document.documentElement.dataset.portalAccess, guard: document.querySelector('#portal-session-guard')?.innerText, content: document.querySelector('#page-content')?.innerText?.slice(0, 300), body: document.body.innerText.slice(0, 300) }));
        throw new Error(`${role} ${destination} did not render destination content: ${JSON.stringify(diagnostic)}; ${error.message}`);
      }
      assert.equal(await page.locator('#portal-session-guard').isVisible(), false, `${role} ${destination} opens without access denial`);
      await page.goBack({ waitUntil: 'domcontentloaded' });
      await page.waitForURL(url => url.pathname === '/admin' && url.hash === '#help', { timeout: 10_000 });
      await page.locator('#help-feedback-form').waitFor({ state: 'visible' });
    }
    assert.deepEqual(errors, [], `${role} browser errors`);
    await context.close();
  }
  console.log(`PASS help feedback browser QA: ${sessions.length} tenant roles, topic disclosure, allowed link navigation, validation, copy, storage/clipboard failures, 320/390/1440 widths`);
} finally { await browser?.close(); child.kill(); }
