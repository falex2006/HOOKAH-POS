'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { Pool } = require('pg');
const { config, folder, options } = require('./staff-schedule-local-config.cjs');
const { isolatedEnvironment } = require('./staff-schedule-local-env.cjs');
const {capturePolicy}=require('./staff-schedule-policy-fixture.cjs');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE_PATH || 'playwright');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function clickEntry(page, entryId, phase, folder) {
  try { await page.locator(`[data-entry="${entryId}"]:visible`).click(); }
  catch (error) {
    const state = await page.evaluate(id => ({
      date: document.querySelector('[data-date]')?.value,
      person: document.querySelector('[data-person]')?.value,
      view: document.querySelector('[data-view]')?.value,
      entries: [...document.querySelectorAll('[data-entry]')].slice(0, 12).map(node => ({ id: node.dataset.entry, text: node.textContent.trim().slice(0, 100) })),
      targetCount: document.querySelectorAll(`[data-entry="${id}"]`).length
    }), entryId).catch(() => ({ pageUnavailable: true }));
    console.error(`SCHEDULE BROWSER CRUD ${phase}: ${JSON.stringify(state)}`);
    await page.screenshot({ path: path.join(folder, `crud-failure-${phase}.png`), fullPage: true }).catch(() => {});
    throw error;
  }
}
async function main() {
  const c = config(), f = JSON.parse(fs.readFileSync(path.join(folder, 'fixtures.json'), 'utf8'));
  const employee = randomUUID(), root = path.join(__dirname, '..');
  const pool = new Pool(options(c)),restorePolicy=await capturePolicy(pool,f.venues[0]);
  let browser, server;
  try {
    await pool.query(`INSERT INTO users(id,venue_id,organization_id,full_name,login,role) VALUES($1,$2,$3,'Анна — браузерная проверка',$4,'bartender')`, [employee, f.venues[0], f.organizations[0], `${employee}@example.test`]);
    await pool.query(`INSERT INTO staff_schedule_venue_policies(venue_id,max_weekly_minutes,created_by,updated_by) VALUES($1,1,$2,$2)
      ON CONFLICT(venue_id) DO UPDATE SET max_weekly_minutes=1,version=staff_schedule_venue_policies.version+1,updated_by=EXCLUDED.updated_by,updated_at=now()`,[f.venues[0],f.users[0].id]);
    const probe = net.createServer();
    await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
    const port = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    server = spawn(process.execPath, [path.join(root, 'server.js')], { cwd: root, env: { ...isolatedEnvironment(c, f), PORT: String(port) }, stdio: 'ignore', windowsHide: true });
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (server.exitCode !== null) throw new Error('Isolated browser CRUD QA child failed to start');
      try { const health = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(500) }); if (health.ok) { ready = true; break; } } catch {}
      await sleep(100);
    }
    assert.ok(ready, 'isolated browser CRUD server readiness');
    const base = `http://127.0.0.1:${port}`;
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const login = await context.request.post(base + '/api/login', { data: { username: f.users[0].login, password: f.password } });
    assert.equal(login.status(), 200);
    const session = await login.json();
    await context.addInitScript(({ token, user }) => { localStorage.setItem('crm_session_token', token); localStorage.setItem('crm_session_user', JSON.stringify(user)); }, session);
    await page.goto(base + '/admin#staff-schedule');
    await page.locator('[data-context]').filter({ hasText: 'Asia/Yekaterinburg' }).waitFor({state:'attached'});
    const day = await page.locator('[data-date]').inputValue();
    await page.locator('[data-person]').selectOption(employee);
    await page.locator('[data-create]').click();
    const dialog = page.locator('dialog[open]');
    await dialog.locator('[name=userId]').selectOption(employee);
    await dialog.locator('[name=start]').fill(day + 'T10:00');
    await dialog.locator('[name=end]').fill(day + 'T18:00');
    await dialog.locator('[name=breakMinutes]').fill('30');
    await dialog.locator('[name=note]').fill('Создано через форму');
    await dialog.getByRole('button', { name: 'Добавить в график', exact: true }).click();
    await dialog.locator('[name=confirmWarnings]').waitFor();
    await dialog.locator('[name=reason]').fill('Подтверждение предупреждений браузерной проверки');
    await dialog.locator('[name=confirmWarnings]').check();
    const retry = page.waitForResponse(r => r.url().endsWith('/api/staff/schedule') && r.request().method() === 'POST' && r.status()===201);
    await dialog.locator('form').evaluate(form=>form.requestSubmit());
    const response = await retry; assert.equal(response.status(), 201, await response.text());
    const record = await response.json();
    await page.locator(`[data-entry="${record.id}"]:visible`).waitFor();
    assert.equal((await pool.query('SELECT break_minutes,note FROM staff_schedules WHERE id=$1', [record.id])).rows[0].break_minutes, 30);
    await pool.query(`INSERT INTO staff_work_logs(venue_id,user_id,started_at,ended_at,source) VALUES($1,$2,$3,$4,'manual'),($1,$2,$5,NULL,'manual')`,
      [f.venues[0],employee,day+'T10:00:00+05:00',day+'T11:00:00+05:00',day+'T12:00:00+05:00']);
    await page.reload();
    await page.locator('[data-context]').filter({ hasText: 'Asia/Yekaterinburg' }).waitFor({state:'attached'});
    await page.locator('[data-person]').selectOption(employee);
    await page.locator('[data-context]').filter({hasText:'7,5 ч по плану'}).waitFor({state:'attached'});
    await page.locator('[data-context]').filter({hasText:'Факт: 1 ч'}).waitFor({state:'attached'});
    await page.locator('[data-context]').filter({hasText:'факт неполный'}).waitFor({state:'attached'});
    await page.locator(`[data-entry="${record.id}"]:visible`).click();
    assert.equal(await dialog.locator('[name=note]').inputValue(), 'Создано через форму');
    await dialog.locator('[name=note]').fill('Изменено после перезагрузки');
    const edited = page.waitForResponse(r => r.url().endsWith('/' + record.id) && r.request().method() === 'PATCH');
    await dialog.getByRole('button', { name: 'Сохранить изменения', exact: true }).click();
    const editResponse=await edited;assert.equal(editResponse.status(),409);
    await dialog.locator('[name=confirmWarnings]').waitFor();await dialog.locator('[name=reason]').fill('Подтверждение предупреждений при редактировании');await dialog.locator('[name=confirmWarnings]').check();
    const editRetry=page.waitForResponse(r=>r.url().endsWith('/'+record.id)&&r.request().method()==='PATCH'&&r.status()===200);await dialog.locator('form').evaluate(form=>form.requestSubmit());assert.equal((await editRetry).status(),200);
    await dialog.waitFor({ state: 'detached' });
    await page.locator('[data-copy-week]').click();
    await dialog.locator('[name=targetFrom]').fill('2020-12-07');
    await dialog.locator('[name=targetFrom]').dispatchEvent('change');
    await dialog.locator('[data-preview]').click();
    await dialog.locator('[data-copy-preview] input:checked').waitFor();
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM staff_schedules WHERE user_id=$1', [employee])).rows[0].n, 1, 'Preview must not save');
    await dialog.locator('[data-error]').filter({hasText:'прошлые даты'}).waitFor();
    await dialog.getByRole('button', { name: 'Копировать выбранные', exact: true }).click();
    await dialog.locator('[data-error]').filter({hasText:'укажите причину'}).waitFor();
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM staff_schedules WHERE user_id=$1',[employee])).rows[0].n,1);
    await dialog.locator('[name=reason]').fill('Восстановление графика через браузер');
    const warningResponse = page.waitForResponse(r => r.url().endsWith('/copy/apply') && r.request().method() === 'POST');
    await dialog.getByRole('button', { name: 'Копировать выбранные', exact: true }).click();
    assert.equal((await warningResponse).status(),409);
    const copiedResponse = page.waitForResponse(r => r.url().endsWith('/copy/apply') && r.request().method() === 'POST');
    await dialog.getByRole('button', { name: 'Копировать выбранные', exact: true }).click();
    const copied = await copiedResponse; if(copied.status()!==200)throw new Error(`copy apply retry ${copied.status()}: ${await copied.text()} UI: ${await dialog.locator('[data-error]').textContent()}`);
    const copiedRecord = (await copied.json()).items[0];
    assert.equal((await pool.query('SELECT reason FROM staff_schedule_events WHERE schedule_id=$1',[copiedRecord.id])).rows[0].reason,'Восстановление графика через браузер');
    await page.locator(`[data-entry="${copiedRecord.id}"]:visible`).waitFor();
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM staff_schedules WHERE user_id=$1', [employee])).rows[0].n, 2);
    await page.locator('[data-date]').fill(day);
    await page.locator('[data-date]').dispatchEvent('change');
    await page.locator(`[data-entry="${record.id}"]:visible`).click();
    await dialog.locator('[name=reason]').fill('Отмена в браузерной проверке');
    const cancelled = page.waitForResponse(r => r.url().endsWith('/' + record.id) && r.request().method() === 'PATCH');
    await dialog.locator('[data-cancel]').click();
    assert.equal((await cancelled).status(), 200);
    await dialog.waitFor({ state: 'detached' });
    await page.locator('[data-status]').filter({ hasText: 'Запись отменена' }).waitFor();
    assert.equal(await page.locator(`[data-entry="${record.id}"]:visible`).count(), 0, 'Cancelled entry hidden by default');
    await page.locator('[data-cancelled]').check();
    await page.locator(`[data-entry="${record.id}"]:visible`).filter({ hasText: 'Отменена' }).waitFor();
    await page.locator(`[data-entry="${record.id}"]:visible`).click();
    await dialog.getByRole('button', { name: 'История изменений', exact: true }).click();
    await dialog.getByText('Версия 3 · Отменена', { exact: true }).waitFor();
    await dialog.locator('[data-close]').click();
    const row = (await pool.query('SELECT status,version,note FROM staff_schedules WHERE id=$1', [record.id])).rows[0];
    assert.deepEqual(row, { status: 'cancelled', version: 3, note: 'Изменено после перезагрузки' });
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM staff_schedule_events WHERE schedule_id=$1', [record.id])).rows[0].n, 3);
    // Transfer/reassignment and employee archived while a form is open.
    const replacement=randomUUID();
    await pool.query("INSERT INTO users(id,venue_id,organization_id,full_name,login,role) VALUES($1,$2,$3,'Replacement browser QA',$4,'bartender')",[replacement,f.venues[0],f.organizations[0],`${replacement}@example.test`]);
    await page.reload();await page.locator('[data-context]').filter({hasText:'Asia/Yekaterinburg'}).waitFor({state:'attached'});
    await page.locator('[data-date]').fill(copiedRecord.workDate);await page.locator('[data-date]').dispatchEvent('change');
    await clickEntry(page, copiedRecord.id, 'before-transfer', folder);
    const movedDay=new Date(Date.parse(copiedRecord.workDate+'T12:00Z')+86400000).toISOString().slice(0,10);
    await dialog.locator('[name=userId]').selectOption(replacement);
    await dialog.locator('[name=workDate]').fill(movedDay);
    await dialog.locator('[name=start]').fill(movedDay+'T10:00');await dialog.locator('[name=end]').fill(movedDay+'T18:00');
    await dialog.locator('[name=reason]').fill('Перенос и замена сотрудника');
    await pool.query('UPDATE users SET is_active=false WHERE id=$1',[replacement]);
    const archived=page.waitForResponse(r=>r.url().endsWith('/'+copiedRecord.id)&&r.request().method()==='PATCH');
    await dialog.getByRole('button',{name:'Сохранить изменения',exact:true}).click();assert.equal((await archived).status(),409);
    assert.equal(await dialog.locator('[name=reason]').inputValue(),'Перенос и замена сотрудника');
    assert.equal((await pool.query('SELECT user_id FROM staff_schedules WHERE id=$1',[copiedRecord.id])).rows[0].user_id,employee);
    await pool.query('UPDATE users SET is_active=true WHERE id=$1',[replacement]);
    const moved=page.waitForResponse(r=>r.url().endsWith('/'+copiedRecord.id)&&r.request().method()==='PATCH');
    await dialog.getByRole('button',{name:'Сохранить изменения',exact:true}).click();assert.equal((await moved).status(),409);await dialog.locator('[name=confirmWarnings]').waitFor();await dialog.locator('[name=confirmWarnings]').check();const moveRetry=page.waitForResponse(r=>r.url().endsWith('/'+copiedRecord.id)&&r.request().method()==='PATCH'&&r.status()===200);await dialog.locator('form').evaluate(form=>form.requestSubmit());assert.equal((await moveRetry).status(),200);
    await dialog.waitFor({state:'detached'});
    assert.equal(await page.locator('[data-date]').inputValue(), movedDay, 'Save navigates to moved date');
    await page.reload();await page.locator('[data-context]').filter({hasText:'Asia/Yekaterinburg'}).waitFor({state:'attached'});
    await page.locator('[data-date]').fill(movedDay);await page.locator('[data-date]').dispatchEvent('change');
    await clickEntry(page, copiedRecord.id, 'after-transfer', folder);
    assert.equal(await dialog.locator('[name=userId]').inputValue(),replacement);
    assert.equal(await dialog.locator('[name=workDate]').inputValue(),movedDay);
    const movedDb=(await pool.query('SELECT user_id,work_date::text AS day,version FROM staff_schedules WHERE id=$1',[copiedRecord.id])).rows[0];
    assert.deepEqual(movedDb,{user_id:replacement,day:movedDay,version:2});
    await dialog.locator('[data-close]').click();
    assert.deepEqual(errors, []);
    await page.screenshot({ path: path.join(folder, 'crud-complete.png'), fullPage: true });
    console.log('SCHEDULE BROWSER CRUD: PASS create/DB/reload/edit, copy preview without writes/apply/visible target, cancel/history UI3; no pageerror.');
  } finally {
    await browser?.close();
    if (server && server.exitCode === null) { server.kill(); await Promise.race([new Promise(resolve => server.once('exit', resolve)), sleep(3000)]); }
    await restorePolicy();
    await pool.end();
  }
}
main().catch(error => { console.error(error.stack||error.message); process.exitCode = 1; });
