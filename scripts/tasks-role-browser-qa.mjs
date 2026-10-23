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
  const request = async (path, token, method = 'GET', body, expected = 200) => {
    const response = await fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json(); assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(data)}`); return data;
  };
  const owner = await request('/api/login', '', 'POST', { username: 'owner', password: 'demo' });
  const serial = Date.now();
  let staffSequence = 0;
  const makeStaff = async (role) => {
    const staff = await request('/api/staff', owner.token, 'POST', { name: `Tasks visual ${role}`, role, login: `taskvis_${++staffSequence}_${serial.toString(36)}`, password: 'demo', birthDate: '1990-01-01' }, 201);
    return { staff, session: await request('/api/login', '', 'POST', { username: staff.login, password: 'demo' }) };
  };
  const manager = await makeStaff('manager'); const bartender = await makeStaff('bartender');
  await request('/api/tasks', owner.token, 'POST', { title: 'QA исполнитель', assigneeId: bartender.staff.id, description: 'Проверка карточки и статуса' }, 201);
  await request('/api/tasks', owner.token, 'POST', { title: 'QA другая задача', assigneeId: manager.staff.id }, 201);
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' });
  const results = [];
  for (const [role, actor] of [['manager', manager], ['bartender', bartender]]) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce', locale: 'ru-RU' });
    await context.addInitScript(({ token, user }) => { localStorage.setItem('crm_session_token', token); localStorage.setItem('crm_session_user', JSON.stringify(user)); }, { token: actor.session.token, user: actor.session.user });
    const page = await context.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message));
    if (role === 'manager') {
      let failTaskReads = true;
      await page.route('**/api/tasks', route => failTaskReads && route.request().method() === 'GET'
        ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'temporary_unavailable' }) })
        : route.continue());
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(base + '/admin#tasks', { waitUntil: 'domcontentloaded' });
      await page.getByText('Не удалось загрузить задачи.').waitFor();
      assert.equal(await page.locator('.task-card').count(), 0, 'failed first read does not show a false empty result');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'mobile task load error fits viewport');
      await page.screenshot({ path: 'tmp/tasks-load-error-manager-390.png' });
      failTaskReads = false;
      await page.getByRole('button', { name: 'Повторить' }).click();
      await page.waitForFunction(() => document.querySelectorAll('#tasks-list .task-card').length === 2);
      await page.unroute('**/api/tasks');
    }
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.goto(base + '/admin#tasks', { waitUntil: 'domcontentloaded' });
      await page.locator('.task-card').first().waitFor();
      await page.waitForFunction(() => document.querySelector('#tasks-list')?.querySelectorAll('.task-card').length >= 1);
      const cards = await page.locator('.task-card').allInnerTexts();
      assert.equal(cards.some(text => text.includes('QA исполнитель')), true, `${role} sees assigned task`);
      assert.equal(cards.some(text => text.includes('QA другая задача')), role === 'manager', `${role} task scope`);
      assert.equal(await page.locator('#task-new').count(), role === 'manager' ? 1 : 0, `${role} create action`);
      assert.equal(await page.locator('[data-task-edit]').count(), role === 'manager' ? 2 : 0, `${role} edit action`);
      assert.equal(await page.locator('[data-task-delete]').count(), role === 'manager' ? 2 : 0, `${role} delete action`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${role} ${width}px horizontal fit`);
      const metric = await page.locator('.task-card').first().evaluate(node => { const r = node.getBoundingClientRect(); return { x: r.x, right: r.right, width: r.width }; });
      assert.ok(metric.x >= -1 && metric.right <= width + 1, `${role} ${width}px card bounds ${JSON.stringify(metric)}`);
      await page.screenshot({ path: `tmp/tasks-role-${role}-${width}.png`, fullPage: true });
      if (role === 'manager' && width === 390) {
        const actions = page.locator('.task-card').first().locator('.task-card-actions button');
        await actions.first().scrollIntoViewIfNeeded();
        const bounds = await actions.evaluateAll(nodes => nodes.map(node => { const rect = node.getBoundingClientRect(); return { x: rect.x, right: rect.right, top: rect.top, bottom: rect.bottom, height: rect.height, text: node.textContent.trim() }; }));
        assert.equal(bounds.length, 2);
        assert.ok(Math.abs(bounds[0].top - bounds[1].top) < 2 && bounds[0].right < bounds[1].x && bounds[1].right <= width, 'mobile task actions are aligned in one row');
        assert.ok(bounds.every(item => item.height >= 40), 'mobile task actions have readable tap targets');
        await page.screenshot({ path: 'tmp/tasks-role-manager-390-actions.png' });
      }
      results.push(`${role}/${width}: ${cards.length} cards`);
    }
    if (role === 'manager') {
      let postAttempts = 0;
      await page.route('**/api/tasks', route => {
        if (route.request().method() !== 'POST') return route.continue();
        postAttempts += 1;
        return postAttempts === 1
          ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'temporary_unavailable' }) })
          : route.continue();
      });
      await page.locator('#task-new').click();
      const editor = page.locator('[data-ui-dialog]');
      await editor.waitFor({ state: 'visible' });
      await editor.locator('[name="title"]').fill('QA повтор после ошибки');
      await editor.locator('[name="assigneeId"]').selectOption(bartender.staff.id);
      const submit = editor.getByRole('button', { name: 'Создать задачу' });
      await submit.evaluate(button => { button.click(); button.click(); });
      await editor.locator('.ui-modal-message').getByText('Не удалось создать задачу. Введённые данные сохранены — повторите попытку.').waitFor();
      assert.equal(postAttempts, 1, 'rapid double submit sends only one create request');
      assert.equal(await editor.locator('[name="title"]').inputValue(), 'QA повтор после ошибки', 'create draft survives POST error');
      assert.equal(await submit.isEnabled(), true, 'create action returns after POST error');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'create error fits mobile viewport');
      await page.screenshot({ path: 'tmp/tasks-create-error-manager-390.png' });
      await submit.click();
      await editor.waitFor({ state: 'detached' });
      await page.getByText('QA повтор после ошибки').waitFor();
      assert.equal(postAttempts, 2, 'create retry sends one request');
      assert.equal((await request('/api/tasks', owner.token)).items.filter(task => task.title === 'QA повтор после ошибки').length, 1, 'create retry persists one task');
      await page.unroute('**/api/tasks');
      let patchAttempts = 0;
      await page.route('**/api/tasks/*', route => {
        if (route.request().method() !== 'PATCH') return route.continue();
        patchAttempts += 1;
        return patchAttempts === 1
          ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'temporary_unavailable' }) })
          : route.continue();
      });
      await page.locator('.task-card').filter({ hasText: 'QA повтор после ошибки' }).locator('[data-task-edit]').click();
      const editDialog = page.locator('[data-ui-dialog]');
      await editDialog.waitFor({ state: 'visible' });
      assert.equal(await page.locator('#portal-notice[data-kind="success"]').count(), 0, 'previous success notice does not cover the new editor');
      await editDialog.locator('[name="title"]').fill('QA изменена после ошибки');
      const save = editDialog.getByRole('button', { name: 'Сохранить изменения' });
      await save.evaluate(button => { button.click(); button.click(); });
      await editDialog.locator('.ui-modal-message').getByText('Не удалось изменить задачу. Введённые данные сохранены — повторите попытку.').waitFor();
      assert.equal(patchAttempts, 1, 'rapid double submit sends only one edit request');
      assert.equal(await editDialog.locator('[name="title"]').inputValue(), 'QA изменена после ошибки', 'edit draft survives PATCH error');
      assert.equal(await save.isEnabled(), true, 'edit action returns after PATCH error');
      const errorWithinBody = await editDialog.evaluate(dialog => {
        const error = dialog.querySelector('.ui-modal-message').getBoundingClientRect();
        const body = dialog.querySelector('.ui-modal-body').getBoundingClientRect();
        return error.top >= body.top - 1 && error.bottom <= body.bottom + 1;
      });
      assert.equal(errorWithinBody, true, 'edit failure message is visible in the scrollable body');
      await page.screenshot({ path: 'tmp/tasks-edit-error-manager-390.png' });
      await page.setViewportSize({ width: 320, height: 568 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'edit failure fits 320px');
      assert.equal(await editDialog.locator('.ui-modal-message').isVisible(), true, 'edit error remains visible at 320px');
      assert.equal(await save.isVisible(), true, 'edit retry action remains visible at 320px');
      await page.screenshot({ path: 'tmp/tasks-edit-error-manager-320.png' });
      await page.setViewportSize({ width: 390, height: 844 });
      await save.click();
      await editDialog.waitFor({ state: 'detached' });
      await page.getByText('QA изменена после ошибки').waitFor();
      assert.equal(patchAttempts, 2, 'edit retry sends one request');
      assert.equal((await request('/api/tasks', owner.token)).items.filter(task => task.title === 'QA изменена после ошибки').length, 1, 'edit retry persists the updated task');
      await page.unroute('**/api/tasks/*');
      const deleteButton = page.locator('.task-card').filter({ hasText: 'QA изменена после ошибки' }).locator('[data-task-delete]');
      await deleteButton.evaluate(button => { button.click(); button.click(); });
      await page.locator('.action-modal.open').first().waitFor();
      assert.equal(await page.locator('.action-modal.open').count(), 1, 'rapid delete taps open one confirmation');
      await page.locator('.action-modal.open').getByRole('button', { name: 'Отмена' }).click();
      assert.equal(await page.locator('.action-modal.open').count(), 0, 'cancel closes delete confirmation');
      assert.equal(await deleteButton.isEnabled(), true, 'cancel restores delete action');
      assert.equal((await request('/api/tasks', owner.token)).items.some(task => task.title === 'QA изменена после ошибки'), true, 'cancel preserves task');
      let deleteAttempts = 0;
      await page.route('**/api/tasks/*', route => {
        if (route.request().method() !== 'DELETE') return route.continue();
        deleteAttempts += 1;
        return deleteAttempts === 1
          ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'temporary_unavailable' }) })
          : route.continue();
      });
      await deleteButton.click();
      await page.locator('.action-modal.open').getByRole('button', { name: 'Удалить' }).click();
      await page.getByText('Не удалось удалить задачу').waitFor();
      assert.equal(deleteAttempts, 1, 'failed delete sends one request');
      assert.equal((await request('/api/tasks', owner.token)).items.some(task => task.title === 'QA изменена после ошибки'), true, 'failed delete preserves task');
      const retryDelete = page.locator('.task-card').filter({ hasText: 'QA изменена после ошибки' }).locator('[data-task-delete]');
      await retryDelete.waitFor({ state: 'visible' });
      await retryDelete.click();
      await page.locator('.action-modal.open').getByRole('button', { name: 'Удалить' }).click();
      await page.waitForFunction(() => ![...document.querySelectorAll('.task-card')].some(card => card.textContent.includes('QA изменена после ошибки')));
      assert.equal(deleteAttempts, 2, 'delete retry sends one request');
      assert.equal((await request('/api/tasks', owner.token)).items.some(task => task.title === 'QA изменена после ошибки'), false, 'delete retry removes task');
      await page.unroute('**/api/tasks/*');
    }
    if (role === 'bartender') {
      const options = await page.locator('[data-task-status]').first().locator('option').evaluateAll(nodes => nodes.map(node => node.value));
      assert.deepEqual(options, ['open', 'in_progress', 'done']);
      await page.locator('[data-task-status]').first().selectOption('in_progress');
      await page.locator('[data-task-column="in_progress"] .task-card').waitFor();
      assert.equal((await request('/api/tasks', owner.token)).items.find(task => task.title === 'QA исполнитель')?.status, 'in_progress', 'bartender status action persisted');
      let statusAttempts = 0;
      await page.route('**/api/tasks/*', route => {
        if (route.request().method() !== 'PATCH') return route.continue();
        statusAttempts += 1;
        return statusAttempts === 1
          ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'temporary_unavailable' }) })
          : route.continue();
      });
      await page.locator('[data-task-status]').first().selectOption('done');
      await page.getByText('Не удалось изменить задачу').waitFor();
      assert.equal(statusAttempts, 1, 'status error sends one request');
      assert.equal((await request('/api/tasks', owner.token)).items.find(task => task.title === 'QA исполнитель')?.status, 'in_progress', 'failed status does not persist');
      await page.waitForFunction(() => document.querySelector('[data-task-status]')?.value === 'in_progress');
      await page.locator('[data-task-status]').first().selectOption('done');
      await page.locator('[data-task-column="done"] .task-card').waitFor();
      assert.equal(statusAttempts, 2, 'status retry sends one request');
      assert.equal((await request('/api/tasks', owner.token)).items.find(task => task.title === 'QA исполнитель')?.status, 'done', 'status retry persists');
      await page.unroute('**/api/tasks/*');
    }
    assert.deepEqual(errors, [], `${role} browser errors`);
    await context.close();
  }
  const urgentTask = await request('/api/tasks', owner.token, 'POST', { title: 'QA срочная задача', assigneeId: bartender.staff.id, status: 'in_progress', priority: 'urgent' }, 201);
  await request('/api/tasks', owner.token, 'POST', { title: 'QA отменённая задача', assigneeId: bartender.staff.id, status: 'cancelled', priority: 'low' }, 201);
  const filterContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce', locale: 'ru-RU' });
  await filterContext.addInitScript(({ token, user }) => { localStorage.setItem('crm_session_token', token); localStorage.setItem('crm_session_user', JSON.stringify(user)); }, { token: manager.session.token, user: manager.session.user });
  const filterPage = await filterContext.newPage();
  const filterErrors = []; filterPage.on('pageerror', error => filterErrors.push(error.message));
  const visibleTaskColumns = () => filterPage.locator('#tasks-list [data-task-column]:visible').count();
  for (const width of [1440, 390, 320]) {
    await filterPage.setViewportSize({ width, height: width === 320 ? 568 : width === 390 ? 844 : 900 });
    await filterPage.goto(base + '/admin#tasks', { waitUntil: 'domcontentloaded' });
    await filterPage.getByText('QA срочная задача').waitFor();
    await filterPage.locator('#task-priority-filter').selectOption('urgent');
    assert.equal(await visibleTaskColumns(), 1, `${width}px priority filter shows only matching status column`);
    assert.equal(await filterPage.locator('#tasks-list .task-card:visible').count(), 1, `${width}px priority filter shows one task`);
    await filterPage.screenshot({ path: `tmp/tasks-priority-filter-manager-${width}.png` });
    await filterPage.locator('#task-status-filter').selectOption('done');
    assert.equal(await visibleTaskColumns(), 0, `${width}px unmatched filter hides empty columns`);
    assert.equal(await filterPage.locator('.tasks-filter-empty:visible').innerText(), 'По выбранным условиям задач нет');
    assert.equal(await filterPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${width}px unmatched filter fits viewport`);
    await filterPage.screenshot({ path: `tmp/tasks-filter-empty-manager-${width}.png` });
    await filterPage.locator('#task-status-filter').selectOption('');
    await filterPage.locator('#task-priority-filter').selectOption('');
    assert.equal(await visibleTaskColumns(), 4, `${width}px reset restores task columns`);
    assert.equal(await filterPage.locator('.tasks-filter-empty:visible').count(), 0, `${width}px reset hides global empty state`);
  }
  await filterPage.locator('#task-status-filter').selectOption('in_progress');
  await filterPage.locator('#task-priority-filter').selectOption('urgent');
  await filterPage.locator('[data-task-status="' + urgentTask.id + '"]').selectOption('done');
  await filterPage.locator('.tasks-filter-empty:visible').waitFor();
  assert.equal(await visibleTaskColumns(), 0, 'moving a filtered task shows one clear empty state');
  assert.equal((await request('/api/tasks', owner.token)).items.find(task => task.id === urgentTask.id)?.status, 'done', 'filtered status change persists');
  await filterPage.locator('#task-status-filter').selectOption('done');
  await filterPage.getByText('QA срочная задача').waitFor();
  assert.deepEqual(filterErrors, [], 'task filter browser errors');
  await filterContext.close();
  const roleActors = [['owner', owner, true]];
  for (const role of ['admin', 'developer', 'senior_bartender', 'hookah_master', 'senior_hookah_master']) {
    const actor = await makeStaff(role);
    roleActors.push([role, actor.session, ['admin', 'developer'].includes(role)]);
    if (role === 'senior_bartender') await request('/api/tasks', owner.token, 'POST', { title: 'QA старший бармен', assigneeId: actor.staff.id }, 201);
  }
  for (const [role, session, canManage] of roleActors) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce', locale: 'ru-RU' });
    await context.addInitScript(({ token, user }) => { localStorage.setItem('crm_session_token', token); localStorage.setItem('crm_session_user', JSON.stringify(user)); }, { token: session.token, user: session.user });
    const page = await context.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(base + '/admin#tasks', { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'Задачи' }).waitFor();
    await page.waitForFunction(() => document.querySelector('#tasks-list')?.previousElementSibling?.textContent.includes('Обновлено'));
    assert.equal(await page.locator('#task-new').count(), canManage ? 1 : 0, `${role} create permission`);
    assert.equal(await page.locator('[data-task-edit]').count() > 0, canManage, `${role} edit permission`);
    assert.equal(await page.locator('[data-task-delete]').count() > 0, canManage, `${role} delete permission`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${role} task page fits 390px`);
    if (role === 'senior_bartender') assert.equal(await page.locator('.task-card').allTextContents().then(texts => texts.some(text => text.includes('QA старший бармен'))), true, 'senior bartender sees assigned task');
    if (role === 'hookah_master') assert.equal(await page.locator('.tasks-filter-empty').innerText(), 'Задач пока нет', 'unassigned role sees one empty state');
    assert.deepEqual(errors, [], `${role} task page errors`);
    await context.close();
  }
  const cancelledContext = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce', locale: 'ru-RU' });
  await cancelledContext.addInitScript(({ token, user }) => { localStorage.setItem('crm_session_token', token); localStorage.setItem('crm_session_user', JSON.stringify(user)); }, { token: bartender.session.token, user: bartender.session.user });
  const cancelledPage = await cancelledContext.newPage();
  await cancelledPage.goto(base + '/admin#tasks', { waitUntil: 'domcontentloaded' });
  await cancelledPage.getByText('QA отменённая задача').waitFor();
  await cancelledPage.locator('#task-status-filter').selectOption('cancelled');
  const cancelledCard = cancelledPage.locator('.task-card').filter({ hasText: 'QA отменённая задача' });
  assert.equal(await cancelledCard.count(), 1, 'worker can inspect cancelled assigned task');
  assert.equal(await cancelledCard.getByText('Отменена руководителем').count(), 1, 'worker sees cancellation reason badge');
  assert.equal(await cancelledCard.locator('[data-task-status], [data-task-edit], [data-task-delete]').count(), 0, 'worker cannot change cancelled task');
  assert.equal(await cancelledPage.locator('#tasks-list [data-task-column]:visible').count(), 1, 'cancelled filter hides other columns');
  await cancelledPage.screenshot({ path: 'tmp/tasks-cancelled-bartender-390.png' });
  await cancelledContext.close();
  const raceTask = await request('/api/tasks', owner.token, 'POST', { title: 'QA задача двух сессий', assigneeId: bartender.staff.id }, 201);
  const raceContext = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce', locale: 'ru-RU' });
  await raceContext.addInitScript(({ token, user }) => { localStorage.setItem('crm_session_token', token); localStorage.setItem('crm_session_user', JSON.stringify(user)); }, { token: bartender.session.token, user: bartender.session.user });
  const racePage = await raceContext.newPage(); const raceErrors = []; racePage.on('pageerror', error => raceErrors.push(error.message));
  const raceCard = () => racePage.locator('.task-card').filter({ hasText: 'QA задача двух сессий' });
  await racePage.goto(base + '/admin#tasks', { waitUntil: 'domcontentloaded' });
  await raceCard().waitFor();
  await request('/api/tasks/' + raceTask.id, manager.session.token, 'PATCH', { assigneeId: manager.staff.id });
  await raceCard().locator('[data-task-status]').selectOption('in_progress');
  await racePage.getByText('Задача изменена руководителем. Список обновлён.').waitFor();
  await raceCard().waitFor({ state: 'detached' });
  assert.equal((await request('/api/tasks', owner.token)).items.find(task => task.id === raceTask.id)?.status, 'open', 'stale worker cannot change reassigned task');
  await request('/api/tasks/' + raceTask.id, manager.session.token, 'PATCH', { assigneeId: bartender.staff.id, status: 'open' });
  await racePage.reload({ waitUntil: 'domcontentloaded' });
  await raceCard().waitFor();
  await request('/api/tasks/' + raceTask.id, manager.session.token, 'PATCH', { status: 'cancelled' });
  await raceCard().locator('[data-task-status]').selectOption('done');
  await raceCard().getByText('Отменена руководителем').waitFor();
  assert.equal((await request('/api/tasks', owner.token)).items.find(task => task.id === raceTask.id)?.status, 'cancelled', 'stale worker cannot complete cancelled task');
  await request('/api/tasks/' + raceTask.id, manager.session.token, 'PATCH', { status: 'open' });
  await racePage.reload({ waitUntil: 'domcontentloaded' });
  await raceCard().waitFor();
  await request('/api/tasks/' + raceTask.id, manager.session.token, 'DELETE');
  await raceCard().locator('[data-task-status]').selectOption('in_progress');
  await racePage.getByText('Задача удалена руководителем. Список обновлён.').waitFor();
  await raceCard().waitFor({ state: 'detached' });
  assert.equal((await request('/api/tasks', owner.token)).items.some(task => task.id === raceTask.id), false, 'deleted task stays absent');
  await racePage.screenshot({ path: 'tmp/tasks-deleted-while-open-bartender-390.png' });
  assert.deepEqual(raceErrors, [], 'two-session task browser errors');
  await raceContext.close();
  console.log(`PASS tasks role browser QA: ${results.join(', ')}; filter 1440/390/320, eight login roles, worker conflict states; mutations and errors; no overflow or page errors`);
} finally { await browser?.close(); child.kill(); }
