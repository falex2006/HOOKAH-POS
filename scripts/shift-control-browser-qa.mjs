import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

if (!process.env.PLAYWRIGHT_PACKAGE_PATH) throw new Error('Set PLAYWRIGHT_PACKAGE_PATH');
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_PACKAGE_PATH);
const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
const { port } = probe.address(); await new Promise(resolve => probe.close(resolve));
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['server.js'], { cwd: fileURLToPath(new URL('../', import.meta.url)), windowsHide: true,
  env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DATABASE_URL: '', AUTH_REQUIRED: 'true', DEMO_OWNER_PASSWORD: 'demo', API_RATE_LIMIT: '5000' }, stdio: ['ignore', 'pipe', 'pipe'] });
let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
let browser;
try {
  if (!output.includes('CRM running on')) await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server timeout: ${output}`)), 15_000);
    child.stdout.on('data', chunk => { if (String(chunk).includes('CRM running on')) { clearTimeout(timer); resolve(); } });
    child.once('exit', code => reject(new Error(`server exited ${code}: ${output}`)));
  });
  const api = async (path, token, method = 'GET', body, expected = 200) => {
    const response = await fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json(); assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(data)}`); return data;
  };
  const owner = await api('/api/login', '', 'POST', { username: 'owner', password: 'demo' });
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ru-RU', reducedMotion: 'reduce' });
  await context.addInitScript(({ token, user }) => { localStorage.setItem('crm_session_token', token); localStorage.setItem('crm_session_user', JSON.stringify(user)); }, { token: owner.token, user: owner.user });
  const page = await context.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message));
  let failRead = true;
  await page.route('**/api/shifts', route => route.request().method() === 'GET' && failRead
    ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'temporary_unavailable' }) })
    : route.continue());
  await page.goto(base + '/admin#shift-control', { waitUntil: 'domcontentloaded' });
  await page.getByText('Состояние смены недоступно').waitFor();
  assert.equal(await page.locator('#shift-open, #shift-close').count(), 0, 'read error hides shift mutations');
  failRead = false;
  await page.locator('[data-shift-retry]').click();
  await page.locator('#shift-open').waitFor();
  await page.unroute('**/api/shifts');
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: width === 320 ? 568 : width === 390 ? 844 : 900 });
    await page.goto(base + '/admin#shift-control', { waitUntil: 'domcontentloaded' });
    await page.locator('#shift-open').waitFor();
    assert.equal(await page.locator('#shift-control h2').innerText(), 'Текущая смена', 'shift card uses distinct heading');
    assert.equal(await page.locator('#shift-close').count(), 0, `${width}px closed shift has only open action`);
    assert.equal(await page.locator('.page-title .muted').innerText(), 'Откройте смену, чтобы начать работу.', `${width}px closed-shift guidance`);
    if (width <= 390) assert.ok((await page.locator('#shift-open').boundingBox()).width >= width - 110, `${width}px open action uses card width`);
    if (width === 320) await page.screenshot({ path: 'tmp/shift-control-closed-320.png' });
    await page.locator('#shift-open').click();
    const modal = page.locator('.action-modal.open'); await modal.waitFor();
    assert.equal(await modal.getByRole('heading', { name: 'Открыть смену' }).count(), 1);
    assert.equal(await modal.locator('[name="openingCash"]').inputValue(), '0');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${width}px open modal fits page width`);
    const bounds = await modal.locator('.action-box').boundingBox(); assert.ok(bounds.x >= -1 && bounds.x + bounds.width <= width + 1, `${width}px open modal bounds`);
    await page.screenshot({ path: `tmp/shift-control-open-modal-${width}.png` });
    await modal.getByRole('button', { name: 'Отмена' }).click();
    assert.equal(await modal.count(), 0, `${width}px cancel closes open form`);
    assert.equal((await api('/api/shifts', owner.token)).current, null, `${width}px cancel does not open a shift`);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#shift-open').click();
  await page.locator('.action-modal.open [name="openingCash"]').fill('1000');
  await page.locator('.action-modal.open').getByRole('button', { name: 'Открыть смену' }).click();
  await page.locator('#shift-close').waitFor();
  const shift = (await api('/api/shifts', owner.token)).current;
  assert.equal(Number(shift.openingCash), 1000, 'UI opening cash persisted in isolated API');
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: width === 320 ? 568 : width === 390 ? 844 : 900 });
    await page.goto(base + '/admin#shift-control', { waitUntil: 'domcontentloaded' });
    await page.locator('#shift-close').waitFor();
    assert.equal(await page.locator('#shift-open').count(), 0, `${width}px open shift has only close action`);
    assert.equal(await page.locator('.page-title .muted').innerText(), 'Смена открыта. Проверьте кассу или завершите работу.', `${width}px open-shift guidance`);
    if (width === 320) await page.screenshot({ path: 'tmp/shift-control-open-320.png' });
    await page.locator('#shift-close').click();
    const modal = page.locator('.action-modal.open'); await modal.waitFor();
    assert.equal(await modal.locator('input[type="checkbox"]').count(), 4, `${width}px close checklist has four attestations`);
    assert.match(await modal.innerText(), /внутренний снимок POS.*не является фискальным Z-отчётом/i);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${width}px close modal fits page width`);
    const bounds = await modal.locator('.action-box').boundingBox(); assert.ok(bounds.x >= -1 && bounds.x + bounds.width <= width + 1, `${width}px close modal bounds`);
    await page.screenshot({ path: `tmp/shift-control-close-modal-${width}.png` });
    if (width === 320) {
      await modal.locator('.action-box').evaluate(box => { box.scrollTop = box.scrollHeight; });
      const footer = await modal.locator('.action-footer').boundingBox();
      assert.ok(footer.y >= bounds.y && footer.y + footer.height <= bounds.y + bounds.height + 1, '320px close actions reachable inside dialog scroll');
      assert.equal(await modal.getByRole('button', { name: 'Закрыть смену' }).evaluate(button => {
        const rect = button.getBoundingClientRect();
        return document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)?.closest('button') === button;
      }), true, '320px close action is not covered by the previous success notice');
      await page.screenshot({ path: 'tmp/shift-control-close-modal-320-footer.png' });
    }
    await modal.getByRole('button', { name: 'Отмена' }).click();
    assert.equal((await api('/api/shifts', owner.token)).current?.id, shift.id, `${width}px cancel preserves open shift`);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#shift-close').click();
  const closeModal = page.locator('.action-modal.open'); await closeModal.waitFor();
  await closeModal.locator('[name="closingCash"]').fill('1000');
  for (const checkbox of await closeModal.locator('input[type="checkbox"]').all()) await checkbox.check();
  await closeModal.getByRole('button', { name: 'Закрыть смену' }).click();
  await page.locator('#shift-open').waitFor();
  assert.equal((await api('/api/shifts', owner.token)).current, null, 'UI close persisted in isolated API');
  await page.reload({ waitUntil: 'domcontentloaded' }); await page.locator('#shift-open').waitFor();
  assert.deepEqual(errors, [], 'shift-control page errors');
  const managerStaff = await api('/api/staff', owner.token, 'POST', {
    name: 'Shift control QA manager', role: 'manager', login: `shift_manager_${Date.now().toString(36)}`,
    password: 'demo', birthDate: '1990-01-01',
  }, 201);
  const manager = await api('/api/login', '', 'POST', { username: managerStaff.login, password: 'demo' });
  const managerContext = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ru-RU', reducedMotion: 'reduce' });
  await managerContext.addInitScript(({ token, user }) => {
    localStorage.setItem('crm_session_token', token);
    localStorage.setItem('crm_session_user', JSON.stringify(user));
  }, { token: manager.token, user: manager.user });
  const managerPage = await managerContext.newPage();
  const managerErrors = []; managerPage.on('pageerror', error => managerErrors.push(error.message));
  await managerPage.goto(base + '/admin#shift-control', { waitUntil: 'domcontentloaded' });
  await managerPage.locator('#shift-open').waitFor();
  await managerPage.locator('#shift-open').evaluate(button => { button.click(); button.click(); });
  assert.equal(await managerPage.locator('.action-modal.open').count(), 1, 'rapid open clicks produce one dialog');
  let failPost = true; let postAttempts = 0;
  const routeShiftPost = route => {
    if (route.request().method() !== 'POST') return route.continue();
    postAttempts += 1;
    return failPost ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'temporary_unavailable' }) }) : route.continue();
  };
  await managerPage.route('**/api/shifts', routeShiftPost);
  await managerPage.route('**/api/shifts/**', routeShiftPost);
  await managerPage.locator('.action-modal.open [name="openingCash"]').fill('800');
  await managerPage.locator('.action-modal.open').getByRole('button', { name: 'Открыть смену' }).click();
  await managerPage.getByText('Не удалось открыть смену').waitFor();
  assert.equal(postAttempts, 1, 'failed open sent once');
  assert.equal((await api('/api/shifts', manager.token)).current, null, 'failed open leaves shift closed');
  await managerPage.locator('#shift-open').waitFor();
  failPost = false;
  await managerPage.locator('#shift-open').click();
  await managerPage.locator('.action-modal.open [name="openingCash"]').fill('800');
  await managerPage.locator('.action-modal.open').getByRole('button', { name: 'Открыть смену' }).click();
  await managerPage.locator('#shift-close').waitFor();
  assert.equal(Number((await api('/api/shifts', manager.token)).current?.openingCash), 800, 'manager retry opens one shift');
  await managerPage.locator('#shift-close').evaluate(button => { button.click(); button.click(); });
  assert.equal(await managerPage.locator('.action-modal.open').count(), 1, 'rapid close clicks produce one dialog');
  const managerClose = managerPage.locator('.action-modal.open'); await managerClose.waitFor();
  await managerClose.locator('[name="closingCash"]').fill('800');
  for (const checkbox of await managerClose.locator('input[type="checkbox"]').all()) await checkbox.check();
  failPost = true;
  await managerClose.getByRole('button', { name: 'Закрыть смену' }).click();
  await managerPage.getByText('Не удалось закрыть смену').waitFor();
  const closeActionBounds = await managerPage.locator('#shift-close').boundingBox();
  assert.ok(closeActionBounds.width >= 280 && closeActionBounds.height <= 60, '390px close action stays readable on one row');
  await managerPage.screenshot({ path: 'tmp/shift-control-manager-close-error-390.png' });
  assert.ok((await api('/api/shifts', manager.token)).current, 'failed close leaves shift open');
  await managerPage.locator('#shift-close').waitFor();
  failPost = false;
  await managerPage.locator('#shift-close').click();
  const managerRetryClose = managerPage.locator('.action-modal.open'); await managerRetryClose.waitFor();
  for (const checkbox of await managerRetryClose.locator('input[type="checkbox"]').all()) await checkbox.check();
  await managerRetryClose.getByRole('button', { name: 'Закрыть смену' }).click();
  await managerPage.locator('#shift-open').waitFor();
  assert.equal((await api('/api/shifts', manager.token)).current, null, 'manager retry closes shift');
  assert.equal(postAttempts, 4, 'manager open/close each sent one failure and one success');
  assert.deepEqual(managerErrors, [], 'manager shift-control page errors');
  await managerContext.close();
  await context.close();
  console.log('PASS shift-control browser QA: owner and manager, GET/POST 503/retry, rapid click, open/close forms 1440/390/320, persistence and no page errors');
} finally { await browser?.close(); child.kill(); }
