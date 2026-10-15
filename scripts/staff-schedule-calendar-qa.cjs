'use strict';
// Opt-in integration QA. Run only after the local server is restarted and assets synced.
// Uses the identity-verified dedicated local runtime; retains its own synthetic rows/artifacts.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, randomBytes, scryptSync, createHash } = require('node:crypto');
const { Pool } = require('pg');
const { config, folder, options } = require('./staff-schedule-local-config.cjs');
const service = require('../staff-schedule-service');
const planning = require('../staff-schedule-planning');
const { setGrant } = require('../staff-schedule-access');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE_PATH || 'playwright');

const root = path.resolve(__dirname, '..');
const sourceFiles = ['staff-schedule-service.js', 'staff-schedule-ui.js', 'staff-schedule-ui.css',
  'staff-schedule-domain.js', 'staff-schedule-access.js', 'staff-schedule-routes.js',
  'dist/staff-schedule-ui.js', 'dist/staff-schedule-ui.css'];
const hashes = () => Object.fromEntries(sourceFiles.map(file =>
  [file, createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]));

async function main() {
  assert.ok(process.argv.includes('--run'), 'Integration writes are opt-in: restart/sync first, then pass --run');
  const c = config(); // Verifies container identity, exclusive volume, fixed loopback ports.
  assert.equal(c.appPort, 31944);
  const f = JSON.parse(fs.readFileSync(path.join(folder, 'fixtures.json'), 'utf8'));
  assert.equal(f.database, c.database);
  const run = randomUUID(), prefix = `calendar-${run}`;
  const report = { run, startedAt: new Date().toISOString(), status: 'RUNNING', checks: [], screenshots: [],
    sourcesStart: hashes(), syntheticIds: {}, failures: [] };
  const reportFile = path.join(folder, `${prefix}.json`);
  const pool = new Pool(options(c));
  const base = `http://127.0.0.1:${c.appPort}`;
  const principal = { userId: f.users[0].id, venueId: f.venues[0] };
  const employee = randomUUID(), reader = randomUUID();
  const employeeName = `Календарь QA ${run.slice(0, 8)} — Александра Константинопольская`;
  Object.assign(report.syntheticIds, { employee, reader });
  let browser, page, currentCheck = 'preflight';
  const pageErrors = [];
  async function check(name, action) {
    currentCheck = name;
    await action();
    report.checks.push({ name, status: 'PASS' });
  }
  async function screenshot(label, target = page) {
    const name = `${prefix}-${label}.png`;
    await target.screenshot({ path: path.join(folder, name), fullPage: false });
    report.screenshots.push(name);
  }
  async function open(user, password) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const login = await context.request.post(base + '/api/login', {
      data: { username: user.login, password }, maxRedirects: 0
    });
    assert.equal(login.status(), 200, 'Synthetic login must succeed');
    const session = await login.json();
    await context.addInitScript(({ token, user: actor }) => {
      localStorage.setItem('crm_session_token', token);
      localStorage.setItem('crm_session_user', JSON.stringify(actor));
    }, session);
    const tab = await context.newPage();
    tab.setDefaultTimeout(15000);
    tab.on('pageerror', error => pageErrors.push(error.message));
    return { context, page: tab, headers: { Authorization: `Bearer ${session.token}`, Origin: base } };
  }
  // textContent and inert work even when the explanatory details is closed.
  async function ready(tab = page) {
    await tab.waitForFunction(() => {
      const grid = document.querySelector('[data-grid]');
      return grid && !grid.inert && document.querySelector('[data-context]')?.textContent.includes('Asia/Yekaterinburg');
    });
  }
  async function revealTools(tab = page) {
    const details = tab.locator('details').filter({ has: tab.locator('[data-person]') });
    if (await details.count() && !await details.evaluate(el => el.open)) await details.locator('summary').click();
  }
  async function select(selector, value, tab = page) {
    const control = tab.locator(selector);
    const trigger = control.locator('..').locator('.custom-select-trigger');
    if (await trigger.isVisible()) {
      await trigger.click();
      await control.locator('..').locator(`[data-value="${value}"]`).click();
    } else await control.selectOption(value);
  }
  async function load(action, tab = page) {
    const response = tab.waitForResponse(r => new URL(r.url()).pathname === '/api/staff/schedule'
      && r.request().method() === 'GET');
    await action();
    assert.equal((await response).status(), 200, 'Calendar GET');
    await ready(tab);
  }
  async function date(value, tab = page) {
    await load(async () => {
      await tab.locator('[data-date]').fill(value);
      await tab.locator('[data-date]').dispatchEvent('change');
    }, tab);
  }
  async function mode(value, tab = page) {
    if (await tab.locator('[data-mode]').inputValue() !== value) await load(() => select('[data-mode]', value, tab), tab);
  }
  async function total(hours, tab = page) {
    assert.match(await tab.locator('[data-context]').textContent(), new RegExp(`(?:^|[ ·])${hours} ч по плану`));
  }
  const own = rows => rows.filter(row => row.userId === employee);
  async function httpList(actor, from, to) {
    const response = await actor.context.request.get(`${base}/api/staff/schedule?from=${from}&to=${to}`, {
      headers: actor.headers, maxRedirects: 0
    });
    assert.equal(response.status(), 200);
    const result = await response.json();
    assert.ok(Array.isArray(result.continuations), 'Running backend lacks continuations: restart before QA');
    return result;
  }
  async function employeeRow(id, name, role = 'bartender', passwordHash = null) {
    await pool.query(`INSERT INTO users(id,venue_id,organization_id,full_name,login,role,password_hash)
      VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [id, principal.venueId, f.organizations[0], name, `${id}@example.test`, role, passwordHash]);
  }
  try {
    assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name, c.database);
    const venue = (await pool.query('SELECT organization_id,timezone FROM venues WHERE id=$1', [principal.venueId])).rows[0];
    assert.equal(venue.organization_id, f.organizations[0]);
    assert.equal(venue.timezone, 'Asia/Yekaterinburg');
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const owner = await open(f.users[0], f.password);
    page = owner.page;
    await check('preflight: running HTTP supports continuations; published assets match source', async () => {
      await httpList(owner, '2026-11-23', '2026-11-29');
      for (const file of ['staff-schedule-ui.js', 'staff-schedule-ui.css']) {
        assert.equal(report.sourcesStart[file], report.sourcesStart[`dist/${file}`], `Sync required: ${file}`);
        const response = await owner.context.request.get(`${base}/${file}`, { maxRedirects: 0 });
        assert.equal(response.status(), 200);
        assert.equal(createHash('sha256').update(await response.body()).digest('hex'), report.sourcesStart[file], `Served ${file} differs`);
      }
    });
    currentCheck = 'seed own calendar fixtures';
    await employeeRow(employee, employeeName);
    async function shift(day, start, end) {
      return service.save(pool, principal, { userId: employee, workDate: day, plannedStart: start,
        plannedEnd: end, breakMinutes: 0, reason: 'Synthetic calendar QA', requestKey: randomUUID(),confirmWarnings:true });
    }
    const sunday = await shift('2026-11-22', '2026-11-22T22:00+05:00', '2026-11-23T06:00+05:00');
    const month = await shift('2026-11-30', '2026-11-30T22:00+05:00', '2026-12-01T06:00+05:00');
    const availableFunction=(await pool.query('SELECT id FROM staff_schedule_functions WHERE venue_id=$1 AND active ORDER BY id LIMIT 1',[principal.venueId])).rows[0];
    assert.ok(availableFunction,'calendar fixture needs an active function for a free shift');
    const planCall=(id,action,method,input)=>planning.handle(pool,principal,'drafts',id,action,method,input);
    let openDraft=await planCall(null,null,'POST',{name:`Calendar QA vacancy ${run}`,from:'2026-12-04',to:'2026-12-04',userIds:[employee],requestKey:randomUUID()});
    openDraft=await planCall(openDraft.id,null,'PATCH',{version:openDraft.version,requestKey:randomUUID(),operations:[{operation:'create',payload:{userId:null,workDate:'2026-12-04',kind:'open_shift',functionId:availableFunction.id,plannedStart:'2026-12-04T10:00:00+05:00',plannedEnd:'2026-12-04T18:00:00+05:00',breakMinutes:0,breakIntervals:[],note:'Synthetic calendar QA'}}]});
    const openPreview=await planCall(openDraft.id,'publish-preview','POST',{version:openDraft.version});
    openDraft=await planCall(openDraft.id,'publish','POST',{version:openDraft.version,fingerprint:openPreview.fingerprint,requestKey:randomUUID(),confirmWarnings:true,reason:'Synthetic calendar QA'});
    const openShift=(await pool.query("SELECT id FROM staff_schedules WHERE venue_id=$1 AND work_date='2026-12-04' AND kind='open_shift' ORDER BY created_at DESC LIMIT 1",[principal.venueId])).rows[0];
    assert.ok(openShift,'published fixture open shift');
    const expectedOpenCount=Number((await pool.query("SELECT count(*)::int AS n FROM staff_schedules WHERE venue_id=$1 AND work_date='2026-12-04' AND kind='open_shift' AND status='planned'",[principal.venueId])).rows[0].n);
    const midnight = await shift('2026-12-02', '2026-12-02T20:00+05:00', '2026-12-03T00:00+05:00');
    const cancelled = await shift('2026-11-25', '2026-11-25T10:00+05:00', '2026-11-25T12:00+05:00');
    await service.save(pool, principal, { status: 'cancelled', version: cancelled.version,
      reason: 'Synthetic cancelled fixture', requestKey: randomUUID() }, cancelled.id);
    Object.assign(report.syntheticIds, { sunday: sunday.id, month: month.id, midnight: midnight.id, cancelled: cancelled.id, openShift:openShift.id });
    await check('PG service + HTTP: Sunday carry-in, month boundary, exclusive midnight', async () => {
      for (const list of [(from, to) => service.list(pool, principal, from, to),
        (from, to) => httpList(owner, from, to)]) {
        const week = await list('2026-11-23', '2026-11-29');
        assert.deepEqual(own(week.continuations).map(row => row.id), [sunday.id]);
        assert.equal(own(week.items).filter(row => row.status === 'planned').length, 0);
        const december = await list('2026-12-01', '2026-12-31');
        assert.deepEqual(own(december.continuations).map(row => row.id), [month.id]);
        assert.deepEqual(own(december.items).map(row => row.id), [midnight.id]);
        const afterMidnight = await list('2026-12-03', '2026-12-03');
        assert.equal(own([...afterMidnight.items, ...afterMidnight.continuations]).length, 0);
      }
    });
    await page.goto(base + '/admin#staff-schedule');
    await ready();
    await revealTools();
    await select('[data-person]', employee);
    await check('week UI: 8h start week; Monday continuation, next week 0h', async () => {
      await date('2026-11-22'); await total(8);
      await date('2026-11-23'); await total(0);
      const card = page.locator(`.schedule-week [data-entry="${sunday.id}"]`);
      assert.equal(await card.count(), 1);
      assert.match(await card.textContent(), /Продолжение ночной смены/);
      await screenshot('week-carry');
    });
    await check('search/role/cancelled filters retain correct totals', async () => {
      await page.locator('[data-search]').fill('NO-MATCH-' + run);
      assert.equal(await page.locator(`[data-entry="${sunday.id}"]:visible`).count(), 0);
      await page.locator('[data-search]').fill(employeeName.slice(0, 20));
      assert.equal(await page.locator(`[data-entry="${sunday.id}"]:visible`).count(), 1);
      await page.locator('[data-search]').fill('');
      await select('[data-role]', 'owner');
      assert.equal(await page.locator(`[data-entry="${sunday.id}"]:visible`).count(), 0);
      await select('[data-role]', 'bartender');
      assert.equal(await page.locator(`[data-entry="${sunday.id}"]:visible`).count(), 1);
      await select('[data-role]', '');
      await page.locator('[data-cancelled]').uncheck();
      assert.equal(await page.locator(`[data-entry="${cancelled.id}"]:visible`).count(), 0);
      await page.locator('[data-cancelled]').check();
      assert.equal(await page.locator(`[data-entry="${cancelled.id}"]:visible`).count(), 1);
      await total(0);
      await page.locator('[data-cancelled]').uncheck();
    });
    await check('month grid seven columns; real day click; midnight absent next day; week 12h', async () => {
      await date('2026-12-01'); await mode('month'); await total(4);
      await select('[data-person]', '');
      assert.equal(await page.locator('.schedule-month-day[data-open-day]').count(), 31);
      assert.equal(await page.locator('.schedule-month').evaluate(el =>
        getComputedStyle(el).gridTemplateColumns.trim().split(/\s+/).length), 7);
      const vacancyDay=page.locator('.schedule-month-day[data-open-day="2026-12-04"]');
      assert.equal(await vacancyDay.locator('small').first().innerText(),'0 отсутств.','open shift must not inflate the absence count');
      assert.equal(await vacancyDay.locator('.schedule-month-open').innerText(),`${expectedOpenCount} свободн.`);
      assert.match(await vacancyDay.getAttribute('aria-label'),new RegExp(`0 отсутствий, ${expectedOpenCount} `));
      for(const width of [375,320]){
        await page.setViewportSize({width,height:812});
        assert.ok(await page.locator('.schedule-month').evaluate(el=>el.scrollWidth<=el.clientWidth),`${width}px month must not scroll horizontally`);
      }
      await page.setViewportSize({width:1440,height:1000});
      await screenshot('month');
      await select('[data-person]', employee);
      await load(() => page.locator('.schedule-month-day[data-open-day="2026-12-01"]').click());
      assert.equal(await page.locator('[data-mode]').inputValue(), 'day');
      assert.equal(await page.locator(`.schedule-days [data-entry="${month.id}"]:visible`).count(), 1);
      await total(0); await screenshot('day-carry');
      await date('2026-12-03');
      assert.equal(await page.locator(`[data-entry="${midnight.id}"]:visible`).count(), 0);
      await mode('week'); await total(12);
    });
    await check('native dirty dismiss: reject close/Escape preserves draft; accept discards without DB write', async () => {
      await date('2026-11-23');
      const before = (await pool.query('SELECT version,note FROM staff_schedules WHERE id=$1', [sunday.id])).rows[0];
      const eventCount = (await pool.query('SELECT count(*)::int AS n FROM staff_schedule_events WHERE schedule_id=$1', [sunday.id])).rows[0].n;
      const writes = [];
      const capture = request => {
        if (new URL(request.url()).pathname.startsWith('/api/staff/schedule') && request.method() !== 'GET') writes.push(request.method());
      };
      page.on('request', capture);
      try {
        await page.locator(`[data-entry="${sunday.id}"]:visible`).click();
        const dialog = page.locator('dialog[open]');
        await dialog.locator('[name=note]').fill('Unsaved calendar draft');
        async function confirm(action, accept) {
          const decision = page.waitForEvent('dialog').then(async native => {
            assert.equal(native.type(), 'confirm');
            if (accept) await native.accept(); else await native.dismiss();
          });
          await Promise.all([action(), decision]);
        }
        await confirm(() => dialog.locator('[data-close]').click(), false);
        assert.equal(await dialog.locator('[name=note]').inputValue(), 'Unsaved calendar draft');
        await confirm(() => page.keyboard.press('Escape'), false);
        assert.equal(await dialog.locator('[name=note]').inputValue(), 'Unsaved calendar draft');
        await screenshot('dirty-preserved');
        await confirm(() => dialog.locator('[data-close]').click(), true);
        await dialog.waitFor({ state: 'detached' });
        assert.deepEqual(writes, []);
        assert.deepEqual((await pool.query('SELECT version,note FROM staff_schedules WHERE id=$1', [sunday.id])).rows[0], before);
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM staff_schedule_events WHERE schedule_id=$1', [sunday.id])).rows[0].n, eventCount);
      } finally { page.off('request', capture); }
    });
    await check('refresh re-fetches employees without reload; selected employee retained', async () => {
      const added = randomUUID(); report.syntheticIds.refreshedEmployee = added;
      assert.equal(await page.locator(`[data-person] option[value="${added}"]`).count(), 0);
      await employeeRow(added, 'Calendar refresh ' + run.slice(0, 8));
      const employeesResponse = page.waitForResponse(r => new URL(r.url()).pathname === '/api/staff/schedule/employees');
      await load(() => page.locator('[data-refresh]').click());
      assert.equal((await employeesResponse).status(), 200);
      assert.equal(await page.locator(`[data-person] option[value="${added}"]`).count(), 1);
      assert.equal(await page.locator('[data-person]').inputValue(), employee);
      await page.locator('[data-create]').click();
      assert.equal(await page.locator(`dialog [name=userId] option[value="${added}"]`).count(), 1);
      await page.locator('dialog [data-close]').click();
    });
    await check('mobile 375/320: initial card in viewport, day-strip interaction, no overflow', async () => {
      await page.setViewportSize({ width:375, height:900 });
      const details = page.locator('details').filter({ has: page.locator('[data-person]') });
      if (await details.count() && await details.evaluate(el => el.open)) await details.locator('summary').click();
      for (const width of [375, 320]) {
        const height=width===375?812:900;
        await page.setViewportSize({ width, height });
        await mode('week'); await date('2026-11-23');
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await screenshot(`week-${width}`);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}: page overflow`);
        const coverage=page.locator('[data-coverage]');
        assert.equal(await coverage.count(),1,`${width}: coverage panel must be present`);
        assert.ok(await coverage.isVisible(),`${width}: coverage panel must be visible`);
        assert.match(await coverage.locator('summary').innerText(),/Подробности покрытия/);
        await coverage.locator('summary').click();
        assert.equal(await coverage.evaluate(node=>node.open),true,`${width}: coverage details open`);
        await coverage.getByText('Дефицит').first().waitFor();
        await coverage.locator('summary').click();
        assert.equal(await coverage.evaluate(node=>node.open),false,`${width}: coverage details can be collapsed`);
        const first = page.locator(`[data-entry="${sunday.id}"]:visible`).first();
        const box = await first.boundingBox();
        assert.ok(box && box.x >= 0 && box.x + box.width <= width + 1 && box.y >= 0 && box.y + box.height <= height,
          `${width}: first card must fit initial viewport without scrolling`);
        await page.locator('.schedule-day-strip [data-select-day="2026-11-24"]').click();
        assert.equal(await page.locator(`[data-entry="${sunday.id}"]:visible`).count(), 0);
        await page.locator('.schedule-day-strip [data-select-day="2026-11-23"]').click();
        assert.equal(await page.locator(`[data-entry="${sunday.id}"]:visible`).count(), 1);
        await mode('month');
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}: month overflow`);
        await screenshot(`month-${width}`);
        await load(() => page.locator('.schedule-month-day[data-open-day="2026-11-23"]').click());
        assert.equal(await page.locator(`.schedule-days [data-entry="${sunday.id}"]:visible`).count(), 1);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}: day overflow`);
        await screenshot(`day-${width}`);
      }
    });
    await check('own view-only actor: calendar readable, editor disabled, HTTP PATCH denied/DB unchanged', async () => {
      const password = randomBytes(24).toString('base64url'), salt = randomBytes(16).toString('hex');
      await employeeRow(reader, 'Calendar readonly ' + run.slice(0, 8), 'admin',
        `scrypt$${salt}$${scryptSync(password, salt, 64).toString('hex')}`);
      await pool.query(`INSERT INTO organization_memberships(organization_id,user_id,membership_role,status,is_primary)
        VALUES($1,$2,'member','active',false)`, [f.organizations[0], reader]);
      await setGrant(pool, principal, { userId: reader, access: 'view', version: 0 });
      const actor = await open({ login: `${reader}@example.test` }, password);
      const tab = actor.page;
      await tab.goto(base + '/admin#staff-schedule'); await ready(tab);
      await revealTools(tab); await select('[data-person]', employee, tab); await date('2026-11-23', tab);
      for (const control of ['[data-create]', '[data-copy-week]', '[data-grants]', '.schedule-add']) {
        assert.equal(await tab.locator(`${control}:visible`).count(), 0, `Readonly exposes ${control}`);
      }
      await tab.locator(`[data-entry="${sunday.id}"]:visible`).click();
      const dialog = tab.locator('dialog[open]');
      for (const field of ['userId', 'kind', 'workDate', 'start', 'end', 'breakMinutes', 'note'])
        assert.equal(await dialog.locator(`[name=${field}]`).isDisabled(), true, `Readonly ${field}`);
      assert.equal(await dialog.locator('button[type=submit]').isDisabled(), true);
      await screenshot('readonly', tab);
      const before = (await pool.query('SELECT version,status,note FROM staff_schedules WHERE id=$1', [sunday.id])).rows[0];
      const denied = await actor.context.request.patch(`${base}/api/staff/schedule/${sunday.id}`, {
        headers: actor.headers, data: { status: 'cancelled', version: before.version,
          reason: 'Must be denied', requestKey: randomUUID() }, maxRedirects: 0
      });
      assert.equal(denied.status(), 403);
      assert.equal((await denied.json()).error, 'schedule_forbidden');
      assert.deepEqual((await pool.query('SELECT version,status,note FROM staff_schedules WHERE id=$1', [sunday.id])).rows[0], before);
      await actor.context.close();
    });
    await check('no browser exceptions', async () => assert.deepEqual(pageErrors, []));
  } catch (error) {
    report.checks.push({ name: currentCheck, status: 'FAIL' });
    report.failures.push({ check: currentCheck, message: error.message });
    if (page && !page.isClosed()) await screenshot('failure').catch(() => {});
  } finally {
    try {
      report.sourcesEnd = hashes();
      report.sourcesUnchanged = JSON.stringify(report.sourcesStart) === JSON.stringify(report.sourcesEnd);
      if (!report.sourcesUnchanged) report.failures.push({ check: 'source stability', message: 'Product files changed during QA; rerun required' });
    } catch (error) { report.failures.push({ check: 'source hashes', message: error.message }); }
    for (const [name, close] of [['browser', () => browser?.close()], ['pool', () => pool.end()]]) {
      try { await close(); } catch { report.failures.push({ check: 'cleanup', message: `${name} close failed` }); }
    }
    report.status = report.failures.length ? 'FAIL' : 'PASS';
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2), { flag: 'wx' });
  }
  console.log(`CALENDAR QA: ${report.status}; ${report.checks.length} checks; ${path.relative(root, reportFile)}`);
  if (report.failures.length) {
    for (const failure of report.failures) console.error(`${failure.check}: ${failure.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
