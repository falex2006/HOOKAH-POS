'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE_PATH || 'playwright');
const { config, folder, options } = require('./staff-schedule-local-config.cjs');
const { isolatedEnvironment } = require('./staff-schedule-local-env.cjs');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
  const c = config();
  const fixtures = JSON.parse(fs.readFileSync(path.join(folder, 'fixtures.json'), 'utf8'));
  assert.equal(fixtures.database, c.database);
  const pool = new Pool(options(c));
  const employeeId = randomUUID();
  const employeeName = `Defaults browser ${employeeId.slice(0, 8)}`;
  const functionId = randomUUID();
  const functionName = `Browser function ${functionId.slice(0, 8)}`;
  let server, browser;
  try {
    const identity = (await pool.query('SELECT current_database() AS database, current_user AS username')).rows[0];
    assert.equal(identity.database, c.database);
    assert.equal(identity.username, c.dbUser);
    const owner = (await pool.query('SELECT venue_id, organization_id, role FROM users WHERE id=$1', [fixtures.users[0].id])).rows[0];
    assert.deepEqual(owner, { venue_id: fixtures.venues[0], organization_id: fixtures.organizations[0], role: 'owner' });
    assert.equal((await pool.query("SELECT 1 FROM schedule_qa_migrations WHERE name='104_staff_schedule_foundation.sql'")).rowCount, 1);
    await pool.query(`INSERT INTO users(id,venue_id,organization_id,full_name,login,role)
      VALUES($1,$2,$3,$4,$5,'bartender')`, [employeeId, fixtures.venues[0], fixtures.organizations[0], employeeName, `${employeeId}@example.test`]);
    await pool.query('INSERT INTO staff_schedule_functions(id,venue_id,name,created_by) VALUES($1,$2,$3,$4)',[functionId,fixtures.venues[0],functionName,fixtures.users[0].id]);
    await pool.query('INSERT INTO staff_schedule_employee_functions(venue_id,user_id,function_id,created_by) VALUES($1,$2,$3,$4)',[fixtures.venues[0],employeeId,functionId,fixtures.users[0].id]);
    const probe = net.createServer();
    await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
    const port = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    const root = path.join(__dirname, '..');
    server = spawn(process.execPath, [path.join(root, 'server.js')], {
      cwd: root, env: { ...isolatedEnvironment(c, fixtures), PORT: String(port) }, stdio: 'ignore', windowsHide: true
    });
    const base = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (server.exitCode !== null) throw new Error('Isolated QA server exited');
      try { if ((await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(500) })).ok) { ready = true; break; } } catch { /* starting */ }
      await sleep(100);
    }
    assert.ok(ready, 'isolated QA server ready');
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => dialog.accept());
    const login = await context.request.post(`${base}/api/login`, { data: { username: fixtures.users[0].login, password: fixtures.password } });
    assert.equal(login.status(), 200);
    await context.addInitScript(({ token, user }) => {
      localStorage.setItem('crm_session_token', token);
      localStorage.setItem('crm_session_user', JSON.stringify(user));
    }, await login.json());
    await page.goto(`${base}/admin#staff-schedule`);
    await page.locator('[data-planning]').click();
    await page.locator('[data-settings-open]').click();
    const settings = page.locator('dialog[open]').last();
    await settings.locator('[data-employee]').selectOption(employeeId);
    await settings.locator('[data-defaults-open]:not([disabled])').waitFor();
    await settings.locator('[data-defaults-open]').click();
    let defaults = page.locator('dialog[open]').last();
    await defaults.locator('[name=startTime]').fill('10:00');
    await defaults.locator('[name=endTime]').fill('17:00');
    await defaults.locator('[type=submit]').click();
    await settings.getByText('Значение сохранено и повторно загружено.').waitFor();
    const savedDefault = (await pool.query(`SELECT start_time::text AS start_time,end_time::text AS end_time,version
      FROM staff_schedule_employee_defaults WHERE venue_id=$1 AND user_id=$2 AND function_id IS NULL`, [fixtures.venues[0], employeeId])).rows;
    assert.equal(savedDefault.length, 1);
    assert.equal(savedDefault[0].start_time.slice(0, 5), '10:00');
    assert.equal(savedDefault[0].end_time.slice(0, 5), '17:00');
    await settings.locator('[data-defaults-open]').click();
    defaults = page.locator('dialog[open]').last();
    assert.equal(await defaults.locator('[name=startTime]').inputValue(), '10:00');
    assert.equal(await defaults.locator('[name=endTime]').inputValue(), '17:00');
    await defaults.locator('[data-close]').click();
    for (const theme of ['dark', 'light']) for (const width of [375, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(value => document.body.classList.toggle('light-theme', value === 'light'), theme);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${theme}/${width} settings overflow`);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await settings.locator('[data-close]').click();
    await page.locator('dialog[open]').last().locator('[data-close]').click();
    await page.locator('[data-person]').selectOption(employeeId);
    await page.locator('[data-create]').click();
    let editor = page.locator('dialog[open]').last();
    await editor.locator('[name=workDate]').fill('2031-03-12');
    await editor.locator('[name=workDate]').dispatchEvent('change');
    await editor.locator('[name=start]').waitFor();
    await page.waitForFunction(() => document.querySelector('dialog[open] [name=start]')?.value.endsWith('T10:00') && document.querySelector('dialog[open] [name=end]')?.value.endsWith('T17:00'));
    assert.equal(await editor.locator('[name=start]').inputValue(), '2031-03-12T10:00');
    assert.equal(await editor.locator('[name=end]').inputValue(), '2031-03-12T17:00');
    await editor.locator('[data-close]').click();
    let releaseSuggestion;
    let intercepted = false;
    await page.route('**/api/staff/schedule/template-suggestions?**', async route => {
      if (!intercepted && route.request().url().includes(employeeId)) {
        intercepted = true;
        await new Promise(resolve => { releaseSuggestion = resolve; });
      }
      await route.continue();
    });
    await page.locator('[data-create]').click();
    editor = page.locator('dialog[open]').last();
    await editor.locator('[name=workDate]').fill('2031-03-13');
    await editor.locator('[name=workDate]').dispatchEvent('change');
    await editor.locator('[data-suggestion]').getByText('Загрузка', { exact: false }).waitFor();
    await editor.locator('[name=start]').fill('2031-03-13T11:00');
    await editor.locator('[name=end]').fill('2031-03-13T18:00');
    await page.waitForFunction(() => document.querySelector('dialog[open] [data-suggestion]')?.textContent.includes('Загрузка') === true);
    assert.ok(intercepted, 'suggestion response intercepted');
    releaseSuggestion();
    await editor.locator('[data-suggestion]').getByText('Подходящее время найдено:', { exact: false }).waitFor();
    assert.equal(await editor.locator('[name=start]').inputValue(), '2031-03-13T11:00', 'late suggestion preserves manual start');
    assert.equal(await editor.locator('[name=end]').inputValue(), '2031-03-13T18:00', 'late suggestion preserves manual end');
    await editor.locator('[name=functionId]').selectOption(functionId);
    await editor.locator('[type=submit]').click();
    await Promise.race([page.waitForFunction(() => !document.querySelector('dialog[open]'), { timeout: 5000 }), editor.locator('[name=confirmWarnings]').waitFor({ state: 'visible', timeout: 5000 })]);
    if (await editor.locator('[name=confirmWarnings]').count()) {
      await editor.locator('[name=confirmWarnings]').check();
      await editor.locator('[name=reason]').fill('Synthetic browser policy QA');
      await editor.locator('[type=submit]').click();
    }
    await page.waitForTimeout(1500);
    if (await editor.isVisible()) throw new Error(`Shift save did not complete: ${await editor.locator('[data-error]').textContent()}`);
    const savedShift = (await pool.query(`SELECT s.id,s.function_id,s.work_date::text AS work_date,
      to_char(s.planned_start AT TIME ZONE v.timezone,'YYYY-MM-DD"T"HH24:MI') AS local_start,
      to_char(s.planned_end AT TIME ZONE v.timezone,'YYYY-MM-DD"T"HH24:MI') AS local_end
      FROM staff_schedules s JOIN venues v ON v.id=s.venue_id
      WHERE s.venue_id=$1 AND s.user_id=$2 AND s.work_date='2031-03-13' AND s.status='planned'`, [fixtures.venues[0], employeeId])).rows;
    assert.equal(savedShift.length, 1);
    assert.equal(savedShift[0].work_date, '2031-03-13');
    assert.equal(savedShift[0].local_start, '2031-03-13T11:00');
    assert.equal(savedShift[0].local_end, '2031-03-13T18:00');
    assert.equal(savedShift[0].function_id,functionId);
    await pool.query('UPDATE staff_schedule_employee_functions SET active=false WHERE venue_id=$1 AND user_id=$2 AND function_id=$3',[fixtures.venues[0],employeeId,functionId]);
    await page.reload();
    await page.locator('[data-person]').selectOption(employeeId);
    await page.locator('[data-date]').fill('2031-03-13');
    await page.locator('[data-date]').dispatchEvent('change');
    await page.waitForFunction(name => document.body.textContent.includes(name) && document.body.textContent.includes('11:00'), employeeName);
    await page.locator(`[data-entry="${savedShift[0].id}"]`).first().click();
    editor=page.locator('dialog[open]').last();
    await editor.locator('[data-suggestion]').getByText('Рабочую функцию можно изменить вручную.').waitFor();
    assert.equal(await editor.locator('[name=functionId]').inputValue(),functionId);
    const selectedFunctionLabel=await editor.locator('[name=functionId] option:checked').textContent();
    assert.ok(selectedFunctionLabel.includes(functionName),`archived qualification remains visible and selected; found: ${selectedFunctionLabel}`);
    await editor.locator('[name=note]').fill('Edited after qualification removal');
    await editor.locator('[type=submit]').click();
    await Promise.race([page.waitForFunction(() => !document.querySelector('dialog[open]'), { timeout: 5000 }), editor.locator('[name=confirmWarnings]').waitFor({ state: 'visible', timeout: 5000 })]);
    if (await editor.locator('[name=confirmWarnings]').count()) {
      await editor.locator('[name=confirmWarnings]').check();
      await editor.locator('[name=reason]').fill('QA подтверждает сохранение выбранной функции после снятия квалификации');
      await editor.locator('[type=submit]').click();
    }
    await page.locator('dialog[open]').waitFor({state:'hidden'});
    const editedShift=(await pool.query('SELECT function_id,note FROM staff_schedules WHERE id=$1',[savedShift[0].id])).rows[0];
    assert.equal(editedShift.function_id,functionId,'editing unrelated fields keeps the saved function');
    assert.equal(editedShift.note,'Edited after qualification removal');
    for (const theme of ['dark', 'light']) for (const width of [375, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(value => document.body.classList.toggle('light-theme', value === 'light'), theme);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${theme}/${width} calendar overflow`);
    }
    assert.deepEqual(errors, [], 'no page errors');
    console.log('DEFAULTS BROWSER PASS: owner saves/reloads 10:00-17:00; calendar autofill; late suggestion preserves manual input; removed qualification stays visible and survives unrelated edit; DB/reload; dark/light 375/1440 no overflow');
  } finally {
    if (typeof server !== 'undefined' && server && server.exitCode === null) server.kill();
    await browser?.close();
    await pool.end();
  }
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
