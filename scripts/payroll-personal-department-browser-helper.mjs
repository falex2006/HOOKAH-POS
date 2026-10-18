import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';

// Called only inside the guarded owned-database suite; no process or DB creation.
export async function runDepartmentBrowserQa({ base, password, users, venue, db, artifacts }) {
  const require = createRequire(import.meta.url);
  const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE_PATH);
  const executablePath = process.env.CHROME_PATH || process.env.PLAYWRIGHT_EXECUTABLE_PATH;
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'ru-RU' });
  page.setDefaultTimeout(20000);
  const errors = [], screenshots = [];
  page.on('pageerror', error => errors.push(error.message));
  const reveal = async locator => {
    const ancestors = locator.locator('xpath=ancestor::details');
    for (let i = 0; i < await ancestors.count(); i++) {
      const details = ancestors.nth(i);
      if (!await details.evaluate(node => node.open)) await details.locator(':scope > summary').click();
    }
  };
  const select = async (locator, value) => {
    await reveal(locator);
    assert.equal(await locator.evaluate(node => node.tagName), 'SELECT');
    const wrapper = locator.locator('xpath=..');
    await wrapper.locator(':scope > .custom-select-trigger').waitFor({ state: 'visible' });
    assert.equal(await locator.getAttribute('data-custom-select'), '1');
    assert.equal(await wrapper.locator('.custom-select').count(), 0, 'No nested select wrapper');
    await wrapper.locator(':scope > .custom-select-trigger').click();
    await wrapper.locator(`:scope > .custom-select-menu > [role=option][data-value="${value}"]`).click();
    assert.equal(await locator.inputValue(), value);
  };
  const card = parameter => page.locator('[data-grid-override]').filter({ has: page.locator(`[data-grid-override-path] > option[value="${parameter}"]:checked`) });
  const departmentNames = async locator => {
    assert.equal(await locator.locator('option[value="bar"]').textContent(), 'Бар · bar');
    assert.equal(await locator.locator('option[value="hookah"]').textContent(), 'Кальяны · hookah');
  };
  const responseFor = (pathname, method) => page.waitForResponse(r => new URL(r.url()).pathname === pathname && r.request().method() === method);
  const workspace = key => page.locator(`.scheme-workspace-nav [data-scheme-workspace="${key}"]`).click();
  const payroll = async () => {
    await page.goto(`${base}/finance`, { waitUntil: 'networkidle' });
    await page.locator('.finance-view-navigation [data-finance-view="payroll"]').click();
    await reveal(page.locator('[data-scheme-new]'));
  };
  const capture = async name => { const file = `${name}.png`; await page.screenshot({ path: path.join(artifacts, file), fullPage: true }); screenshots.push(file); };
  try {
    await page.goto(`${base}/login`);
    await page.locator('#login-username').fill(users.owner.login);
    await page.locator('#login-password').fill(password);
    const login = responseFor('/api/login', 'POST');
    await page.locator('#login-form button[type=submit]').click(); assert.equal((await login).status(), 200);
    await page.waitForURL(url => url.pathname !== '/login');
    const definition = { mode: 'stable_percent', currency: 'RUB', effectiveFrom: '2026-11-01', effectiveTo: '2026-11-30', applyMilestones: false,
      roleParameters: { bartender: { perShiftCents: 0, stableRateBps: 5000, department: 'bar', cap: { basis: 'employee_department_day', rateBps: 3000 } } },
      roleAssignments: [{ employeeId: users.a.id, roleId: 'bartender', effectiveFrom: '2026-11-01', effectiveTo: '2026-11-30' }], employeeOverrides: [], itemRules: [] };
    const scenario = { periodFrom: '2026-11-01', periodTo: '2026-11-02', employees: [{ id: users.a.id }], roleAssignments: definition.roleAssignments, attendance: [],
      sales: [['bar', 10000], ['hookah', 30000]].map(([department, amount]) => ({ id: department, employeeId: users.a.id, date: '2026-11-02', department, menuItemId: department, turnoverCents: amount, commissionBaseCents: amount })),
      coverage: { kind: 'month_to_date_complete', from: '2026-11-01', through: '2026-11-02', complete: true, watermark: 'scenario' },
      attendanceCoverage: { kind: 'approved_attendance_complete', from: '2026-11-01', through: '2026-11-02', complete: true, watermark: 'scenario' } };
    await payroll(); await page.locator('[data-scheme-new]').click(); await page.locator('[data-scheme-name]').fill('Personal department browser');
    await reveal(page.locator('[data-scheme-definition]')); await page.locator('[data-scheme-definition]').fill(JSON.stringify(definition));
    await page.locator('[data-scheme-grid-rebuild]').click();
    for (const [parameter, value] of [['department', 'hookah'], ['cap.department', 'bar']]) {
      await reveal(page.locator('[data-grid-add-override]')); await page.locator('[data-grid-add-override]').click();
      const fresh = page.locator('[data-grid-override="new"]').last();
      await select(fresh.locator('[data-grid-employee]'), users.a.id); await select(fresh.locator('[data-grid-override-path]'), parameter);
      await departmentNames(fresh.locator('[data-grid-override-value]'));
      await select(fresh.locator('[data-grid-override-value]'), value); await fresh.locator('[data-grid-override-from]').fill('2026-11-02'); await fresh.locator('[data-grid-override-to]').fill('2026-11-14');
    }
    await page.locator('[data-scheme-grid-apply]').click(); await page.locator('[data-scheme-risk-acknowledged]').check();
    const creation = responseFor('/api/payroll/schemes', 'POST'); await page.locator('[data-scheme-save]').click();
    const created = await creation; const body = await created.json(); assert.equal(created.status(), 201, JSON.stringify(body));
    const versionId = body.versions[0].versionId, endpoint = `/api/payroll/versions/${versionId}`;
    const pgRows = async () => (await db.query('SELECT parameter_path AS path,override_mode AS mode,value_json AS value,effective_from::text AS "from",effective_to::text AS "to" FROM payroll_employee_overrides WHERE venue_id=$1 AND scheme_version_id=$2 ORDER BY parameter_path', [venue, versionId])).rows;
    const verify = async (department, capDepartment) => {
      assert.deepEqual(await pgRows(), [['cap.department', capDepartment], ['department', department]].map(([key, value]) => ({ path: key, mode: value === null ? 'inherit' : 'override', value, from: '2026-11-02', to: '2026-11-14' })));
      const response = await page.request.get(`${base}${endpoint}`); assert.equal(response.status(), 200);
      assert.deepEqual((await response.json()).roleParameters, definition.roleParameters);
    };
    const reopen = async () => {
      await payroll(); await workspace('list'); const opening = responseFor(endpoint, 'GET');
      await page.locator(`[data-scheme-open-version="${versionId}"]`).click(); assert.equal((await opening).status(), 200);
      await page.waitForFunction(() => document.querySelector('[data-scheme-definition]')?.value.includes('cap.department'));
      await reveal(card('department').locator('[data-grid-override-value]'));
    };
    const save = async () => {
      await page.locator('[data-scheme-grid-apply]').click(); await page.locator('[data-scheme-risk-acknowledged]').check();
      const pending = responseFor(endpoint, 'PUT'); await page.locator('[data-scheme-save]').click();
      const response = await pending; assert.equal(response.status(), 200, JSON.stringify(await response.json()));
    };
    const preview = async amount => {
      await workspace('trial'); await reveal(page.locator('[data-scheme-preview-input]')); await page.locator('[data-scheme-preview-input]').fill(JSON.stringify(scenario));
      const pending = responseFor(`${endpoint}/preview`, 'POST'); await page.locator('[data-scheme-run-preview]').click();
      const response = await pending; assert.equal(response.status(), 200); const result = await response.json();
      assert.equal(result.official, false); assert.equal(result.persistence, 'none'); assert.equal(result.result.status, 'ready', JSON.stringify(result.result.blockers));
      assert.equal(result.result.employees[0].amountCents, amount);
      const rendered = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', minimumFractionDigits: 2 }).format(amount / 100);
      await page.waitForFunction(expected => [...document.querySelectorAll('[data-scheme-preview-result] table tbody tr td:nth-child(8) strong')].some(n => n.textContent === expected), rendered);
      assert.match(await page.locator('[data-scheme-preview-result]').innerText(), /сценар/i);
    };
    await verify('hookah', 'bar'); await reopen();
    assert.equal(await card('department').locator('[data-grid-override-value]').inputValue(), 'hookah');
    assert.equal(await card('cap.department').locator('[data-grid-override-value]').inputValue(), 'bar');
    assert.equal(await card('department').locator('[data-grid-override-from]').inputValue(), '2026-11-02');
    // Keep a stable card identity while its selected parameter changes. A select's
    // HTML value attribute is not its live value, and the old parameter stops matching.
    const capIndex = await card('cap.department').getAttribute('data-grid-override');
    assert.match(capIndex, /^\d+$/);
    const switchingCard = page.locator(`[data-grid-override="${capIndex}"]`);
    for (let cycle = 0; cycle < 3; cycle++) {
      await select(switchingCard.locator('[data-grid-override-path]'), 'perShiftCents');
      const field = switchingCard.locator('[data-grid-value-label]');
      assert.equal(await field.locator('[data-grid-override-value]').count(), 1);
      assert.equal(await field.locator('input[data-grid-override-value]').count(), 1);
      assert.equal(await field.locator('.custom-select,.custom-select-trigger,.custom-select-menu').count(), 0, 'Switch to numeric value removes all old select UI');
      await field.locator('input').fill(String(25 + cycle));
      await select(switchingCard.locator('[data-grid-override-path]'), 'cap.department');
      await departmentNames(field.locator('[data-grid-override-value]'));
      await select(field.locator('[data-grid-override-value]'), cycle === 1 ? 'hookah' : 'bar');
      assert.equal(await field.locator('[data-grid-override-value]').count(), 1);
      assert.equal(await field.locator('.custom-select').count(), 1);
      assert.equal(await field.locator('.custom-select-trigger').count(), 1);
      assert.equal(await field.locator('.custom-select-menu').count(), 1);
      assert.equal(await field.locator('.custom-select .custom-select').count(), 0);
    }
    await save(); await verify('hookah', 'bar'); await reopen();
    assert.equal(await card('cap.department').locator('[data-grid-override-value]').inputValue(), 'bar');
    await departmentNames(card('cap.department').locator('[data-grid-override-value]'));
    await preview(3000); await page.locator('[data-scheme-preview-result]').scrollIntoViewIfNeeded(); await capture('department-explicit-cap-30');
    await workspace('configuration'); await reveal(card('cap.department').locator('[data-grid-inherit]')); await card('cap.department').locator('[data-grid-inherit]').click();
    await save(); await verify('hookah', null); await reopen(); assert.equal(await card('cap.department').locator('[data-grid-override-value]').inputValue(), '');
    await preview(9000); await page.locator('[data-scheme-preview-result]').scrollIntoViewIfNeeded(); await capture('department-fallback-90');
    await workspace('configuration'); await reveal(card('department').locator('[data-grid-inherit]')); await card('department').locator('[data-grid-inherit]').click();
    await save(); await verify(null, null); await reopen(); await preview(3000);
    await workspace('configuration'); await select(card('cap.department').locator('[data-grid-override-mode]'), 'override');
    await select(card('cap.department').locator('[data-grid-override-value]'), 'hookah'); await save(); await verify(null, 'hookah'); await reopen(); await preview(9000);
    for (const width of [1024, 768, 375, 320]) {
      await page.setViewportSize({ width, height: 1000 }); await workspace('configuration'); await reveal(card('cap.department').locator('[data-grid-override-value]'));
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `overflow ${width}`);
      if (width === 375) { await card('cap.department').scrollIntoViewIfNeeded(); await capture('department-configuration-375'); }
    }
    await page.setViewportSize({ width: 1440, height: 1000 }); await workspace('list');
    const activation = responseFor(`${endpoint}/activate`, 'POST'); await page.locator(`[data-scheme-activate="${versionId}"]`).click(); assert.equal((await activation).status(), 200);
    await reopen(); await page.waitForFunction(() => document.querySelector('[data-scheme-grid-fieldset]')?.disabled === true);
    assert.equal(await card('cap.department').locator('[data-grid-override-value]').isDisabled(), true);
    assert.equal(await page.locator('[data-scheme-definition]').evaluate(n => n.readOnly), true); await verify(null, 'hookah');
    assert.deepEqual(errors.filter(e => !e.includes('ViewTransition opt-in disabled')), []);
    return { status: 'PASS', versionId, screenshots, errors, assertions: ['Named employee/department custom selects; three cap.department -> perShiftCents -> cap.department cycles without orphan/nested UI, saved and reloaded from HTTP/PG', 'UI save/HTTP/PG/reload; exact cap priority 30 -> fallback 90 -> role 30 -> restored explicit 90 rubles; independent inherit/date fields', 'Four narrow widths without page horizontal overflow; active configuration readonly; scenario-only; screenshots show viewport and numeric proof is API plus DOM'] };
  } catch (error) {
    const messages = await page.locator('[data-scheme-message],[data-scheme-grid-message]').allTextContents().catch(() => []);
    const invalid = await page.locator('[data-scheme-editor] :invalid').evaluateAll(nodes => nodes.map(node => ({ field: node.getAttribute('data-grid-path') || node.name || node.tagName, message: node.validationMessage }))).catch(() => []);
    await writeFile(path.join(artifacts, 'department-browser-failure.json'), JSON.stringify({ messages, invalid, errors }, null, 2)).catch(() => {});
    await page.screenshot({ path: path.join(artifacts, 'department-browser-failure.png'), fullPage: true }).catch(() => {});
    throw error;
  } finally { await browser.close(); }
}
