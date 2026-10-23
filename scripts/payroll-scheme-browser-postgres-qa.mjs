import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { randomBytes, randomUUID, scryptSync } from 'node:crypto';
import path from 'node:path';
import { validateQaDatabaseUrl, assertQaDatabaseIdentity } from './postgres-qa-safety.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const target = validateQaDatabaseUrl(process.env.MIGRATIONS_PG_TEST_DATABASE_URL);
const require = createRequire(import.meta.url);
const { Client, Pool } = require('pg');
const { makeService: makePayrollSchemeService } = require('../payroll-scheme-service.js');
const { beginPayrollSourceProducerTransaction } = require('../payroll-source-fence.js');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE_PATH || 'playwright');
const db = new Client({ connectionString: target.url.href });
const chooseCustomSelect = async (select, value) => {
  const wrapper = select.locator('..');
  await wrapper.locator('.custom-select-trigger').click();
  await wrapper.locator(`[data-value="${value}"]`).click();
};
const ensureDisclosureOpen = async (summary) => {
  const details = summary.locator('xpath=..');
  if (!(await details.evaluate((node) => node.open))) await summary.click();
};
const personalCardFor = async (page, path) => {
  const index = await page.locator('[data-grid-override]').evaluateAll((cards, expectedPath) => cards.findIndex((card) => card.querySelector('[data-grid-override-path]')?.value === expectedPath), path);
  assert.notEqual(index, -1, `personal override card for ${path} is present`);
  return page.locator('[data-grid-override]').nth(index);
};
const schema = `payroll_browser_qa_${process.pid}_${Date.now()}`;
assert.match(schema, /^payroll_browser_qa_\d+_\d+$/);
const scopedUrl = new URL(target.url);
scopedUrl.searchParams.set('options', `-c search_path=${schema},public`);
let child;
let browser;
let created = false;
try {
  await db.connect();
  const identity = (await db.query('SELECT current_database() AS database,inet_server_addr() AS address,inet_server_port() AS port,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser')).rows[0];
  assertQaDatabaseIdentity(identity, target.database, Number(target.url.port));
  await db.query(`CREATE SCHEMA "${schema}"`);
  created = true;
  await db.query(`SET search_path TO "${schema}",public`);
  await db.query(readFileSync(path.join(root, 'schema.sql'), 'utf8'));
  let organizationId = null;
  let venueId = null;
  for (const name of readdirSync(path.join(root, 'migrations')).filter((name) => /^\d{3}.*\.sql$/.test(name)).sort()) {
    if (name === '144_pos_payroll_recognition.sql') {
      organizationId = (await db.query("INSERT INTO organizations(name,slug) VALUES('Payroll editor QA',$1) RETURNING id", [schema])).rows[0].id;
      venueId = (await db.query("INSERT INTO venues(name,timezone,organization_id) VALUES('Payroll editor QA','Asia/Yekaterinburg',$1) RETURNING id", [organizationId])).rows[0].id;
    }
    await db.query(readFileSync(path.join(root, 'migrations', name), 'utf8'));
  }
  assert.ok(organizationId && venueId, 'test venue is present at migration 144 to exercise immutable existing-at-install coverage');
  await db.query("INSERT INTO organization_subscriptions(organization_id,status) VALUES($1,'active')", [organizationId]);
  const login = `payroll-editor-${process.pid}`;
  const password = randomBytes(16).toString('hex');
  const salt = randomBytes(16).toString('hex');
  const hash = `scrypt$${salt}$${scryptSync(password, salt, 64).toString('hex')}`;
  const ownerId = (await db.query("INSERT INTO users(venue_id,full_name,login,password_hash,role) VALUES($1,'Payroll QA owner',$2,$3,'owner') RETURNING id", [venueId, login, hash])).rows[0].id;
  const employeeId = (await db.query("INSERT INTO users(venue_id,full_name,login,role) VALUES($1,'Payroll QA employee',$2,'bartender') RETURNING id", [venueId, `${login}-staff`])).rows[0].id;
  await db.query('UPDATE users SET organization_id=$1 WHERE id=ANY($2::uuid[])', [organizationId, [ownerId, employeeId]]);
  await db.query("INSERT INTO organization_memberships(organization_id,user_id,membership_role) VALUES($1,$2,'owner'),($1,$3,'member')", [organizationId, ownerId, employeeId]);
  await db.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, employeeId]);
  const foreignVenueId = (await db.query("INSERT INTO venues(name,organization_id) VALUES('Foreign policy QA',$1) RETURNING id", [organizationId])).rows[0].id;
  const foreignOwnerId = (await db.query("INSERT INTO users(venue_id,organization_id,full_name,login,password_hash,role) VALUES($1,$2,'Foreign owner',$3,$4,'owner') RETURNING id", [foreignVenueId, organizationId, `${login}-foreign`, hash])).rows[0].id;
  const financeUserId = (await db.query("INSERT INTO users(venue_id,organization_id,full_name,login,password_hash,role,permission_scopes) VALUES($1,$2,'Finance only',$3,$4,'other_staff','[\"finance_read\"]') RETURNING id", [venueId, organizationId, `${login}-finance`, hash])).rows[0].id;
  await db.query("INSERT INTO organization_memberships(organization_id,user_id,membership_role) VALUES($1,$2,'owner'),($1,$3,'member')", [organizationId, foreignOwnerId, financeUserId]);
  const linkedPayrollExpenseId=(await db.query("INSERT INTO expenses(venue_id,category,amount,expense_date,description,source,created_by) VALUES($1,'salary',100,'2026-10-14','QA linked payroll expense','payroll',$2) RETURNING id",[venueId,ownerId])).rows[0].id;
  const unmatchedPayrollExpenseId=(await db.query("INSERT INTO expenses(venue_id,category,amount,expense_date,description,source,created_by) VALUES($1,'salary',999,'2026-10-14','QA unmatched payroll expense','payroll',$2) RETURNING id",[venueId,ownerId])).rows[0].id;
  await db.query("INSERT INTO payroll_entries(venue_id,user_id,period_from,period_to,amount,status) VALUES($1,$2,'2026-10-01','2026-10-14',100,'draft'),($1,$2,'2026-10-14','2026-10-31',100,'approved')",[venueId,employeeId]);
  await db.query("INSERT INTO payroll_entries(venue_id,user_id,period_from,period_to,amount,expense_id,status,payment_date) VALUES($1,$2,'2026-10-14','2026-10-14',101,$3,'paid','2026-10-15')",[venueId,employeeId,linkedPayrollExpenseId]);
  const foreignEmployeeId=(await db.query("INSERT INTO users(venue_id,full_name,login,password_hash,role) VALUES($1,'Foreign employee',$2,$3,'bartender') RETURNING id",[foreignVenueId,`${login}-foreign-staff`,hash])).rows[0].id;
  await db.query("INSERT INTO payroll_entries(venue_id,user_id,period_from,period_to,amount,status) VALUES($1,$2,'2026-10-01','2026-10-31',777,'paid')",[foreignVenueId,foreignEmployeeId]);
  const counts = async () => (await db.query('SELECT (SELECT count(*)::int FROM payroll_entries) AS entries,(SELECT count(*)::int FROM expenses) AS expenses,(SELECT count(*)::int FROM payroll_calculation_runs) AS runs')).rows[0];
  const before = await counts();
  child = spawn(process.execPath, ['server.js'], { cwd: root, windowsHide: true,
    env: { ...process.env, DATABASE_URL: scopedUrl.href, VENUE_ID: venueId, AUTH_REQUIRED: 'true', DEMO_MODE: 'false', NODE_ENV: 'test',
      HOST: '127.0.0.1', PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let startup = '';
  const base = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Isolated payroll browser server did not start')), 15000);
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
    child.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`QA server exited ${code}`)); });
    child.stdout.on('data', (chunk) => { startup += chunk; const match = startup.match(/CRM running on http:\/\/localhost:(\d+)/); if (match) { clearTimeout(timeout); resolve(`http://127.0.0.1:${match[1]}`); } });
    child.stderr.on('data', () => {}); // Never print connection/config secrets.
  });
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'ru-RU' });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${base}/login`, { waitUntil: 'networkidle' });
  await page.locator('#login-username').fill(login);
  await page.locator('#login-password').fill(password);
  const loginResponse = page.waitForResponse((response) => response.url().endsWith('/api/login') && response.request().method() === 'POST');
  await page.locator('#login-form button[type="submit"]').click();
  const authentication = await loginResponse;
  assert.equal(authentication.status(), 200, 'QA owner authentication must succeed');
  await page.waitForURL((url) => !url.pathname.includes('/login'));
  const diagnosticCountsBefore=await counts();
  const diagnosticResponse=await page.request.get(`${base}/api/payroll/entry-overlap-diagnostic?from=2026-10-14&to=2026-10-14`);
  assert.equal(diagnosticResponse.status(),200,'owner can read the payroll-entry diagnostic');
  const diagnostic=await diagnosticResponse.json();
  assert.equal(diagnostic.diagnosticOnly,true);assert.equal(diagnostic.snapshotProvenance,'unknown');
  assert.equal(diagnostic.entries.length,3,'inclusive boundary finds adjacent periods and the single-day paid entry');
  assert.ok(diagnostic.entries.every(row=>row.employeeId===employeeId),'diagnostic remains scoped to the owner venue');
  assert.ok(diagnostic.entries.some(row=>row.flags.includes('legacy_without_rule')),'legacy entries without a rule are visible');
  assert.ok(diagnostic.entries.some(row=>row.flags.includes('overlapping_period_partial')||row.flags.includes('overlapping_period_contained')),'overlapping periods are identified');
  assert.ok(diagnostic.entries.some(row=>row.expenseLink==='linked'&&row.flags.includes('payment_date_mismatch')&&row.flags.includes('amount_mismatch')),'explicit expense linkage and factual mismatches are reported');
  assert.ok(diagnostic.payrollExpenses.some(row=>row.id===unmatchedPayrollExpenseId&&row.linkage==='unmatched'),'unmatched payroll expense stays separate');
  assert.equal(diagnostic.payrollExpenses.some(row=>row.id===linkedPayrollExpenseId),true);
  assert.equal((await page.request.get(`${base}/api/payroll/entry-overlap-diagnostic?from=2026-10-15&to=2026-10-14`)).status(),400,'reversed period is rejected');
  assert.equal((await page.request.get(`${base}/api/payroll/entry-overlap-diagnostic?from=2026-10-14&to=2026-10-14&venueId=${foreignVenueId}`)).status(),400,'caller cannot supply tenant scope');
  assert.deepEqual(await counts(),diagnosticCountsBefore,'diagnostic is read-only for payroll entries, expenses and runs');
  const emptyEmploymentResponse = await page.request.get(`${base}/api/payroll/employment-eligibility`);
  assert.equal(emptyEmploymentResponse.status(), 200);
  assert.equal((await emptyEmploymentResponse.json()).current, null, 'new installation shows an explicit empty historical roster');
  const employmentRosterResponse = await page.request.get(`${base}/api/payroll/employment-eligibility/employees`);
  assert.equal(employmentRosterResponse.status(), 200);
  const employmentRoster = await employmentRosterResponse.json();
  const qaEmployee = employmentRoster.items.find(row => row.id === employeeId);
  assert.deepEqual(Object.keys(qaEmployee).sort(), ['active', 'id', 'name'], 'payroll roster exposes only the minimal owner-facing DTO');
  assert.equal(qaEmployee.name, 'Payroll QA employee');
  const employmentRequest = { reason: 'Confirm payroll eligibility for QA', idempotencyKey: 'browser-employment-eligibility',
    expectedRevisionId: null, periods: [{ employeeId, effectiveFrom: '2026-11-01', effectiveTo: '2026-11-30' }] };
  const employmentCreateResponse = await page.request.post(`${base}/api/payroll/employment-eligibility`, { headers: { origin: base }, data: employmentRequest });
  assert.equal(employmentCreateResponse.status(), 201);
  const employmentCreated = await employmentCreateResponse.json();
  assert.equal(employmentCreated.periods[0].employeeId, employeeId);
  assert.equal(employmentCreated.periods[0].employeeName, 'Payroll QA employee');
  const employmentReadback = await page.request.get(`${base}/api/payroll/employment-eligibility`);
  assert.equal((await employmentReadback.json()).current.id, employmentCreated.id, 'owner API readback returns the saved immutable roster after reload');
  const employmentReplay = await page.request.post(`${base}/api/payroll/employment-eligibility`, { headers: { origin: base }, data: employmentRequest });
  assert.equal(employmentReplay.status(), 200);
  assert.equal((await employmentReplay.json()).id, employmentCreated.id);
  assert.equal((await page.request.get(`${base}/api/payroll/employment-eligibility?venueId=forged`)).status(), 400);
  const employmentConflict = await page.request.post(`${base}/api/payroll/employment-eligibility`, { headers: { origin: base },
    data: { ...employmentRequest, reason: 'Changed request with the old key' } });
  assert.equal(employmentConflict.status(), 409, 'same idempotency key with changed content is rejected');
  const staleEmploymentRevision = await page.request.post(`${base}/api/payroll/employment-eligibility`, { headers: { origin: base },
    data: { ...employmentRequest, idempotencyKey: 'browser-employment-stale-base', reason: 'Confirm a stale edit attempt' } });
  assert.equal(staleEmploymentRevision.status(), 409, 'a new idempotency key cannot silently replace a newer full snapshot');
  await page.goto(`${base}/finance#payroll`, { waitUntil: 'networkidle' });
  const eligibilityPanel = page.locator('.finance-payroll-eligibility');
  await assert.doesNotReject(() => eligibilityPanel.waitFor({ state: 'visible' }));
  assert.match(await eligibilityPanel.locator('[data-eligibility-current]').innerText(), /Payroll QA employee/);
  await eligibilityPanel.locator('[data-eligibility-edit]').click();
  await eligibilityPanel.locator('[data-period-from]').fill('2026-11-02');
  await eligibilityPanel.locator('[data-eligibility-reason]').fill('Исправили дату начала работы');
  await eligibilityPanel.locator('[data-eligibility-save]').click();
  await page.waitForFunction(() => document.querySelector('.finance-payroll-eligibility [data-eligibility-status]')?.textContent.includes('Последнее изменение: версия 2'));
  assert.match(await eligibilityPanel.locator('[data-eligibility-current]').innerText(), /2026-11-02/);
  const editorBeforeRace = await page.request.get(`${base}/api/payroll/employment-eligibility`);
  const revision2 = (await editorBeforeRace.json()).current;
  await eligibilityPanel.locator('[data-eligibility-edit]').click();
  await eligibilityPanel.locator('[data-period-from]').fill('2026-11-04');
  await eligibilityPanel.locator('[data-eligibility-reason]').fill('Черновик из устаревшей вкладки');
  const competingRevisionResponse = await page.request.post(`${base}/api/payroll/employment-eligibility`, { headers: { origin: base },
    data: { expectedRevisionId: revision2.id, idempotencyKey: 'browser-employment-competing-write', reason: 'Параллельное актуальное изменение',
      periods: [{ employeeId, effectiveFrom: '2026-11-03', effectiveTo: '2026-11-30' }] } });
  assert.equal(competingRevisionResponse.status(), 201);
  await eligibilityPanel.locator('[data-eligibility-reload]').click();
  await page.waitForFunction(() => document.querySelector('.finance-payroll-eligibility [data-eligibility-status]')?.textContent.includes('Последнее изменение: версия 3'));
  await eligibilityPanel.locator('[data-eligibility-save]').click();
  await page.waitForFunction(() => document.querySelector('.finance-payroll-eligibility [data-eligibility-status]')?.textContent.includes('Ваш вариант не применён'));
  assert.equal(await eligibilityPanel.locator('[data-eligibility-editor]').isHidden(), true, 'stale draft closes on conflict');
  assert.match(await eligibilityPanel.locator('[data-eligibility-current]').innerText(), /2026-11-03/);
  const raceReadback = (await (await page.request.get(`${base}/api/payroll/employment-eligibility`)).json()).current;
  assert.equal(raceReadback.revisionNo, 3, 'refreshing an open stale editor cannot overwrite the competing revision');
  assert.equal(raceReadback.periods[0].effectiveFrom, '2026-11-03');
  const payrollSettingsSummary = page.getByText('Настройки схем и проверка расчётов', { exact: true });
  if (!(await payrollSettingsSummary.evaluate((node) => node.parentElement?.open))) await payrollSettingsSummary.click();
  const newSchemeButton = page.locator('[data-scheme-new]');
  if (!(await newSchemeButton.isVisible())) {
    const visibility = await newSchemeButton.evaluate((node) => {
      const chain = []; let current = node;
      while (current && chain.length < 8) { const style = getComputedStyle(current); chain.push({ tag: current.tagName, id: current.id,
        cls: typeof current.className === 'string' ? current.className : '', hidden: current.hidden,
        display: style.display, visibility: style.visibility, opacity: style.opacity }); current = current.parentElement; }
      return { role: JSON.parse(localStorage.getItem('crm_session_user') || '{}').role, chain,
        pageTitle: document.title, bodyText: document.body.innerText.slice(0, 500) };
    });
    throw new Error(`Payroll scheme owner control is not visible: ${JSON.stringify(visibility)}`);
  }
  await page.locator('[data-scheme-new]').click();
  assert.equal(await page.locator('[data-source-readiness-run]').isDisabled(), true, 'unsaved scheme has no readiness source');
  await page.locator('[data-scheme-name]').fill('Browser payroll role grid');
  const definition = { mode: 'progressive_daily', currency: 'RUB', effectiveFrom: '2026-11-01', effectiveTo: '2026-11-30',
    roleParameters: { bartender: { perShiftCents: 123456, bracketRatesBps: { 0: 1234, 100000: 2000 }, cap: { rateBps: 3000, basis: 'venue_day' }, extraPreserved: { note: 'keep' } } },
    roleAssignments: [{ employeeId, roleId: 'bartender', effectiveFrom: '2026-11-01', effectiveTo: '2026-11-30' }],
    employeeOverrides: [{ employeeId, path: 'perShiftCents', mode: 'override', value: 0, effectiveFrom: '2026-11-01', effectiveTo: '2026-11-10' },
      { employeeId, path: 'cap.rateBps', mode: 'override', value: 4000, effectiveFrom: '2026-11-01', effectiveTo: '2026-11-10' },
      { employeeId, path: 'applyMilestones', mode: 'inherit', effectiveFrom: '2026-11-01', effectiveTo: '2026-11-30' }], itemRules: [] };
  await page.getByText('Расширенная конфигурация JSON', { exact: true }).click();
  await page.locator('[data-scheme-definition]').fill(JSON.stringify(definition));
  await page.locator('[data-scheme-grid-rebuild]').click();
  await page.getByText('Пороговые премии: суммы по ролям', { exact: true }).click();
  await page.locator('[data-grid-new-milestone-threshold]').fill('300000');
  await page.locator('[data-grid-add-milestone-threshold]').click();
  const bonusField = page.locator('[data-grid-role="bartender"][data-grid-path="milestoneBonusesCents.30000000"]');
  assert.equal(await bonusField.inputValue(), '', 'new threshold does not invent an amount');
  await bonusField.fill('2000,25');
  await page.locator('[data-grid-new-milestone-threshold]').fill('500000');
  await page.locator('[data-grid-add-milestone-threshold]').click();
  await page.locator('[data-grid-role="bartender"][data-grid-path="milestoneBonusesCents.50000000"]').fill('0');
  definition.roleParameters.bartender.milestoneBonusesCents = { 30000000: 200025, 50000000: 0 };
  const milestoneRoleControl = page.locator('[data-grid-role="bartender"][data-grid-path="applyMilestones"]');
  await ensureDisclosureOpen(page.getByText('Индивидуальные условия сотрудников', { exact: true }));
  let milestonePersonalCard = await personalCardFor(page, 'applyMilestones');
  assert.match(await milestonePersonalCard.locator('p').innerText(), /2026-11-01/);
  assert.doesNotMatch(await milestonePersonalCard.locator('p').innerText(), /не задано|не начислять/);
  const wageBeforeCaptionCheck = await page.locator('[data-grid-role="bartender"][data-grid-path="perShiftCents"]').inputValue();
  await page.locator('[data-grid-role="bartender"][data-grid-path="perShiftCents"]').fill('ошибка');
  assert.match(await milestonePersonalCard.locator('p').innerText(), /начислять/);
  assert.doesNotMatch(await milestonePersonalCard.locator('p').innerText(), /Наследование не определено/);
  await page.locator('[data-grid-role="bartender"][data-grid-path="perShiftCents"]').fill(wageBeforeCaptionCheck);
  assert.equal(await milestoneRoleControl.inputValue(), '', 'omitted role setting remains inherited');
  const milestoneRoleDetails = milestoneRoleControl.locator('xpath=ancestor::details[2]');
  if (!(await milestoneRoleDetails.evaluate((node) => node.open))) await milestoneRoleDetails.locator('summary').click();
  const milestoneFieldGroup = milestoneRoleControl.locator('xpath=ancestor::details[1]');
  if (!(await milestoneFieldGroup.evaluate((node) => node.open))) await milestoneFieldGroup.locator('summary').click();
  const roleModeControl = page.locator('[data-grid-role="bartender"][data-grid-path="mode"]');
  await chooseCustomSelect(roleModeControl, 'stable_percent');
  assert.match(await milestonePersonalCard.locator('p').innerText(), /не начислять/);
  assert.match(await milestoneRoleControl.evaluate((node) => node.options[0].textContent), /Наследовать: не начислять/);
  await chooseCustomSelect(roleModeControl, '');
  assert.doesNotMatch(await milestonePersonalCard.locator('p').innerText(), /не начислять/);
  assert.match(await milestoneRoleControl.evaluate((node) => node.options[0].textContent), /Наследовать: начислять/);
  await chooseCustomSelect(milestoneRoleControl, 'true');
  await page.locator('[data-scheme-grid-apply]').click();
  milestonePersonalCard = await personalCardFor(page, 'applyMilestones');
  assert.equal(JSON.parse(await page.locator('[data-scheme-definition]').inputValue()).roleParameters.bartender.applyMilestones, true);
  const rebuiltRoleDetails = milestoneRoleControl.locator('xpath=ancestor::details[2]');
  if (!(await rebuiltRoleDetails.evaluate((node) => node.open))) await rebuiltRoleDetails.locator('summary').click();
  const rebuiltMilestoneGroup = milestoneRoleControl.locator('xpath=ancestor::details[1]');
  if (!(await rebuiltMilestoneGroup.evaluate((node) => node.open))) await rebuiltMilestoneGroup.locator('summary').click();
  await ensureDisclosureOpen(page.getByText('Индивидуальные условия сотрудников', { exact: true }));
  await chooseCustomSelect(milestoneRoleControl, 'false');
  assert.match(await milestonePersonalCard.locator('p').innerText(), /не начислять/);
  await page.locator('[data-scheme-grid-apply]').click();
  milestonePersonalCard = await personalCardFor(page, 'applyMilestones');
  assert.equal(JSON.parse(await page.locator('[data-scheme-definition]').inputValue()).roleParameters.bartender.applyMilestones, false);
  await ensureDisclosureOpen(page.getByText('Индивидуальные условия сотрудников', { exact: true }));
  definition.roleParameters.bartender.applyMilestones = false;
  await page.locator('[data-grid-role="bartender"][data-grid-path="perShiftCents"]').fill('1000,25');
  const roleImpact = page.locator('[data-grid-role-impact="bartender"]');
  const roleImpactDetails = roleImpact.locator('xpath=ancestor::details[2]');
  if (!(await roleImpactDetails.evaluate((node) => node.open))) await roleImpactDetails.locator('summary').click();
  const roleImpactDisclosure = roleImpact.locator('xpath=ancestor::details[1]');
  if (!(await roleImpactDisclosure.evaluate((node) => node.open))) await roleImpactDisclosure.locator('summary').click();
  assert.match(await roleImpact.innerText(), /Оклад за смену/);
  assert.match(await roleImpact.innerText(), /2026-11-01 — 2026-11-10/);
  assert.match(await roleImpact.innerText(), /0\.00/);
  await page.locator('[data-scheme-grid-apply]').click();
  assert.equal(JSON.parse(await page.locator('[data-scheme-definition]').inputValue()).roleParameters.bartender.perShiftCents, 100025);
  definition.roleParameters.bartender.perShiftCents = 100025;
  await ensureDisclosureOpen(page.getByText('Индивидуальные условия сотрудников', { exact: true }));
  for (const [personalPath, personalValue] of [['bracketRatesBps.100000', 0], ['milestoneBonusesCents.50000000', 0]]) {
    await page.locator('[data-grid-add-override]').click();
    const personalCard = page.locator('[data-grid-override="new"]').last();
    await chooseCustomSelect(personalCard.locator('[data-grid-employee]'), employeeId);
    await chooseCustomSelect(personalCard.locator('[data-grid-override-path]'), personalPath);
    await personalCard.locator('[data-grid-override-value]').fill('0');
    await personalCard.locator('[data-grid-override-from]').fill('2026-11-01');
    await personalCard.locator('[data-grid-override-to]').fill('2026-11-30');
    definition.employeeOverrides.push({ employeeId, path: personalPath, mode: 'override', value: personalValue, effectiveFrom: '2026-11-01', effectiveTo: '2026-11-30' });
  }
  await page.locator('[data-scheme-grid-apply]').click();
  for (const personalPath of ['bracketRatesBps.100000', 'milestoneBonusesCents.50000000']) {
    assert.equal(JSON.parse(await page.locator('[data-scheme-definition]').inputValue()).employeeOverrides.find((row) => row.path === personalPath).value, 0);
  }
  await ensureDisclosureOpen(page.getByText('Правила источников — расширенная настройка', { exact: true }));
  await page.locator('[data-source-policy-enabled]').check();
  await chooseCustomSelect(page.locator('[data-source-policy-sale]'), 'line_seller_snapshot');
  await chooseCustomSelect(page.locator('[data-source-policy-discount]'), 'immutable_line_snapshot');
  await chooseCustomSelect(page.locator('[data-source-policy-refund]'), 'recognized_event_date');
  await page.locator('[data-source-policy-reason]').fill('Владелец выбирает фактического автора строки');
  await page.locator('[data-source-policy-apply]').click();
  const initialPolicy = JSON.parse(await page.locator('[data-scheme-definition]').inputValue()).sourcePolicies;
  await page.locator('[data-personal-cap-confirmation]').waitFor({ state: 'visible' });
  assert.match(await page.locator('[data-personal-cap-exceptions]').innerText(), /30\.00% → 40\.00%/);
  const roleCapField = page.locator('[data-grid-role="bartender"][data-grid-path="cap.rateBps"]');
  const roleCapDetails = roleCapField.locator('xpath=ancestor::details[2]');
  if (!(await roleCapDetails.evaluate((node) => node.open))) await roleCapDetails.locator('summary').click();
  const roleCapGroup = roleCapField.locator('xpath=ancestor::details[1]');
  if (!(await roleCapGroup.evaluate((node) => node.open))) await roleCapGroup.locator('summary').click();
  await roleCapField.fill('50');
  assert.equal(await page.locator('[data-personal-cap-confirmation]').isHidden(), true, 'unsaved higher role cap removes increase warning');
  await roleCapField.fill('20');
  assert.match(await page.locator('[data-personal-cap-exceptions]').innerText(), /20\.00% → 40\.00%/);
  await roleCapField.fill('30');
  await page.locator('[data-scheme-grid-apply]').click();
  await page.locator('[data-scheme-risk-acknowledged]').check();
  await page.locator('[data-scheme-save]').click();
  await page.locator('[data-scheme-message]').getByText('Отдельно подтвердите повышение личного лимита выше роли.', { exact: true }).waitFor();
  assert.equal((await db.query("SELECT count(*)::int AS count FROM payroll_schemes WHERE name='Browser payroll role grid'")).rows[0].count, 0, 'missing extra confirmation does not save a scheme');
  await page.locator('[data-personal-cap-acknowledged]').check();
  await page.locator('[data-scheme-risk-acknowledged]').check();
  const createdResponse = page.waitForResponse((response) => response.url().endsWith('/api/payroll/schemes') && response.request().method() === 'POST');
  await page.locator('[data-scheme-save]').click();
  const createdResponseValue = await createdResponse;
  assert.equal(createdResponseValue.status(), 201);
  const createdScheme = await createdResponseValue.json();
  assert.deepEqual(createdScheme.versions[0].sourcePolicies, initialPolicy);
  assert.equal(createdScheme.versions[0].payoutRiskAcknowledgement.personalCapIncrease.exceptions[0].personalRateBps, 4000);
  const initialDigest = createdScheme.versions[0].payoutRiskAcknowledgement.configDigest;
  const versionId = createdScheme.versions[0].versionId;
  const compareDefinition = structuredClone(definition);
  compareDefinition.roleParameters.bartender.stableRateBps = 1500;
  const comparisonVersionResponse = await page.request.post(`${base}/api/payroll/schemes/${createdScheme.id}/versions`, {
    headers: { origin: base }, data: { definition: compareDefinition, payoutRiskAcknowledgement: {
      confirmed: true, policyCode: 'payroll-own-revenue-ceiling-v1',
      personalCapIncrease: { confirmed: true, policyCode: 'payroll-personal-cap-above-role-v1' }
    } }
  });
  assert.equal(comparisonVersionResponse.status(), 201);
  const comparisonVersion = await comparisonVersionResponse.json();
  await page.waitForFunction(() => document.querySelector('[data-scheme-editor-title]')?.textContent === 'Редактирование черновика');
  await page.reload({ waitUntil: 'networkidle' });
  await ensureDisclosureOpen(page.getByText('Настройки схем и проверка расчётов', { exact: true }));
  await page.locator(`[data-scheme-compare-version="${versionId}"]`).check();
  await page.locator(`[data-scheme-compare-version="${comparisonVersion.versionId}"]`).check();
  await page.locator(`[data-scheme-open-version="${versionId}"]`).click();
  await page.waitForFunction(() => Boolean(document.querySelector('[data-scheme-definition]')?.value));
  const readback = JSON.parse(await page.locator('[data-scheme-definition]').inputValue());
  milestonePersonalCard = await personalCardFor(page, 'applyMilestones');
  assert.deepEqual(readback.roleParameters, definition.roleParameters);
  await ensureDisclosureOpen(page.getByText('Премии и личный план', { exact: true }));
  await ensureDisclosureOpen(page.getByText('Индивидуальные условия сотрудников', { exact: true }));
  assert.equal(await milestoneRoleControl.inputValue(), 'false', 'saved false is visibly selected after reload');
  assert.equal(await milestoneRoleControl.locator('..').locator('.custom-select-trigger').innerText(), 'Не начислять');
  assert.match(await milestonePersonalCard.locator('p').innerText(), /не начислять/);
  await milestonePersonalCard.locator('[data-grid-override-from]').fill('2026-12-01');
  assert.doesNotMatch(await milestonePersonalCard.locator('p').innerText(), /не начислять/);
  await milestonePersonalCard.locator('[data-grid-override-from]').fill('2026-11-01');
  assert.match(await milestonePersonalCard.locator('p').innerText(), /не начислять/);
  await page.locator('[data-scheme-grid-rebuild]').click();
  assert.equal(readback.employeeOverrides.find((row) => row.path === 'perShiftCents').value, 0);
  for (const personalPath of ['bracketRatesBps.100000', 'milestoneBonusesCents.50000000']) {
    assert.equal(readback.employeeOverrides.find((row) => row.path === personalPath).value, 0, 'new personal threshold survives API/PG/reload');
  }
  assert.deepEqual(readback.sourcePolicies, initialPolicy);
  assert.equal(await page.locator('[data-personal-cap-acknowledged]').isChecked(), false);
  await ensureDisclosureOpen(page.getByText('Правила источников — расширенная настройка', { exact: true }));
  assert.equal(await page.locator('[data-source-policy-sale]').inputValue(), 'line_seller_snapshot');
  for (const field of ['sale', 'discount', 'refund']) {
    const select = page.locator(`[data-source-policy-${field}]`);
    const selectedText = await select.evaluate((node) => node.selectedOptions[0].textContent);
    assert.equal(await select.locator('..').locator('.custom-select-trigger').innerText(), selectedText, 'visible selection matches saved native value');
  }
  assert.match(await page.locator('[data-source-policy-fieldset]').innerText(), /ещё не подтверждены/);
  await page.locator('[data-scheme-workspace="trial"]').first().click();
  await ensureDisclosureOpen(page.getByText('Данные пробного сценария — JSON', { exact: true }));
  const scenario = { periodFrom: '2026-11-01', periodTo: '2026-11-01', employees: [{ id: employeeId }], attendance: [],
    coverage: { kind: 'month_to_date_complete', from: '2026-11-01', through: '2026-11-01', complete: true, watermark: 'scenario' },
    attendanceCoverage: { kind: 'approved_attendance_complete', from: '2026-11-01', through: '2026-11-01', complete: true, watermark: 'scenario' },
    sales: [{ id: 'scenario-sale', employeeId, department: 'bar', date: '2026-11-01', turnoverCents: 10000, commissionBaseCents: 10000 }] };
  await page.locator('[data-scheme-preview-input]').fill(JSON.stringify(scenario));
  const previewResponse = page.waitForResponse((response) => response.url().endsWith(`/api/payroll/versions/${versionId}/preview`) && response.request().method() === 'POST');
  await page.locator('[data-scheme-run-preview]').click();
  const previewValue = await previewResponse;
  assert.equal(previewValue.status(), 200);
  const previewPayload = await previewValue.json();
  assert.equal(previewPayload.official, false);
  assert.equal(previewPayload.persistence, 'none');
  assert.equal(previewPayload.scenario, true);
  assert.equal(previewPayload.result.sourcePolicyEvaluation.state, 'selected_not_applied');
  assert.equal(previewPayload.result.sourcePolicyEvaluation.officialReady, false);
  await page.locator('[data-source-policy-preview-notice]').waitFor({ state: 'visible' });
  assert.match(await page.locator('[data-source-policy-preview-notice]').innerText(), /не сохраняется/);
  const attendanceFunction = (await db.query(`INSERT INTO staff_schedule_functions(venue_id,name,created_by)
    VALUES ($1,'Бар — подмена QA',$2) RETURNING id`, [venueId, ownerId])).rows[0].id;
  await db.query(`INSERT INTO staff_schedules(venue_id,user_id,function_id,work_date,planned_start,planned_end)
    VALUES ($1,$2,$3,'2026-11-01','2026-11-01T10:00:00Z','2026-11-01T18:00:00Z')`, [venueId, employeeId, attendanceFunction]);
  await db.query(`INSERT INTO staff_work_logs(venue_id,user_id,started_at,ended_at,source)
    VALUES ($1,$2,'2026-11-01T10:00:00Z','2026-11-01T12:00:00Z','manual')`, [venueId, employeeId]);
  const attendanceQuery = 'from=2026-11-01&to=2026-11-01';
  const coverageResponse = await page.request.get(`${base}/api/payroll/attendance/approvals?${attendanceQuery}`);
  assert.equal(coverageResponse.status(), 200);
  const attendanceCoverage = await coverageResponse.json();
  // A source writer already holding the shared fence must finish before the
  // approval's exclusive session fence and SERIALIZABLE snapshot are taken.
  const staleApprovalKey = 'browser-stale-attendance-after-producer';
  await beginPayrollSourceProducerTransaction(db, venueId);
  const sourceFenceName = `payroll-official-source-v1:${venueId.toLowerCase()}`;
  const sourceFenceHash = BigInt((await db.query('SELECT hashtextextended($1,0)::text AS value', [sourceFenceName])).rows[0].value);
  const sourceFenceHashBits = BigInt.asUintN(64, sourceFenceHash);
  const sourceFenceClassId = Number(sourceFenceHashBits >> 32n);
  const sourceFenceObjectId = Number(sourceFenceHashBits & 0xffffffffn);
  await db.query(`UPDATE staff_work_logs SET ended_at='2026-11-01T13:00:00Z'
    WHERE venue_id=$1 AND user_id=$2 AND source='manual' AND started_at='2026-11-01T10:00:00Z'`, [venueId, employeeId]);
  let staleApprovalSettled = false;
  const staleApprovalPromise = page.request.post(`${base}/api/payroll/attendance/approvals`, { headers: { origin: base },
    data: { periodFrom: '2026-11-01', periodTo: '2026-11-01', sourceWatermark: attendanceCoverage.sourceWatermark,
      reason: 'QA rejects source changed during approval', idempotencyKey: staleApprovalKey } })
    .then((response) => { staleApprovalSettled = true; return response; });
  const waitForApprovalFence = async () => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const waiting = Number((await db.query(`SELECT count(*)::int AS count FROM pg_locks
        WHERE locktype='advisory' AND NOT granted AND objsubid=1 AND classid=$1::oid AND objid=$2::oid`,
      [sourceFenceClassId, sourceFenceObjectId])).rows[0].count);
      if (waiting > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('attendance approval did not wait on the producer source fence');
  };
  try {
    await waitForApprovalFence();
    assert.equal(staleApprovalSettled, false, 'approval remains blocked while source producer holds the shared fence');
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {});
    throw error;
  }
  const staleApprovalResponse = await staleApprovalPromise;
  assert.equal(staleApprovalResponse.status(), 409, 'approval rejects the pre-write attendance watermark');
  assert.equal((await staleApprovalResponse.json()).error, 'payroll_attendance_source_changed');
  const approvalCountAfterStale = Number((await db.query('SELECT count(*)::int AS count FROM payroll_attendance_approvals WHERE venue_id=$1', [venueId])).rows[0].count);
  assert.equal(approvalCountAfterStale, 0, 'stale attendance approval persists no immutable snapshot');
  const refreshedCoverageResponse = await page.request.get(`${base}/api/payroll/attendance/approvals?${attendanceQuery}`);
  assert.equal(refreshedCoverageResponse.status(), 200);
  const refreshedAttendanceCoverage = await refreshedCoverageResponse.json();
  assert.notEqual(refreshedAttendanceCoverage.sourceWatermark, attendanceCoverage.sourceWatermark);
  const approvedResponse = await page.request.post(`${base}/api/payroll/attendance/approvals`, { headers: { origin: base },
    data: { periodFrom: '2026-11-01', periodTo: '2026-11-01', sourceWatermark: refreshedAttendanceCoverage.sourceWatermark,
      reason: 'QA owner verifies actual attendance', idempotencyKey: 'browser-verified-attendance' } });
  assert.equal(approvedResponse.status(), 201);
  const approval = await approvedResponse.json();
  assert.equal(approval.shifts[0].scheduledFunctionId, attendanceFunction);
  assert.equal(approval.shifts[0].scheduledFunctionName, 'Бар — подмена QA');
  const approvalReload = await (await page.request.get(`${base}/api/payroll/attendance/approvals?${attendanceQuery}`)).json();
  assert.equal(approvalReload.currentApproval.shifts[0].scheduledFunctionName, 'Бар — подмена QA');
  await page.locator('[data-scheme-workspace="checks"]').first().click();
  await ensureDisclosureOpen(page.getByText('Источники: проверить сохранённую версию схемы', { exact: true }));
  await page.locator('[data-source-readiness-from]').fill('2026-11-01');
  await page.locator('[data-source-readiness-to]').fill('2026-11-01');
  await page.locator('[data-source-comparison-baseline]').selectOption(versionId);
  const sourcedComparisonUiResponse = page.waitForResponse((response) => response.url().endsWith('/api/payroll/compare/sourced') && response.request().method() === 'POST');
  await page.locator('[data-source-comparison-run]').click();
  const sourcedComparisonResponse = await sourcedComparisonUiResponse;
  assert.equal(sourcedComparisonResponse.status(), 200);
  const sourcedComparisonPayload = await sourcedComparisonResponse.json();
  assert.equal(sourcedComparisonPayload.comparisonKind, 'sourced_candidate');
  assert.equal(sourcedComparisonPayload.candidateOnly, true);
  assert.equal(sourcedComparisonPayload.persistence, 'none');
  assert.deepEqual(sourcedComparisonPayload.comparisons.map((item) => item.versionId), [comparisonVersion.versionId, versionId]);
  await page.locator('[data-sourced-comparison-status]').first().waitFor();
  assert.match(await page.locator('[data-sourced-comparison-candidate-only]').innerText(), /не создаёт начисление, расход или выплату/);
  if (sourcedComparisonPayload.status === 'blocked') {
    assert.ok(sourcedComparisonPayload.comparisons.every((item) => item.amountCents === null && item.deltaToBaselineCents === null),
      'blocked source comparisons never become zero in the UI response');
  }
  const comparisonRoute = '**/api/payroll/compare/sourced';
  const readyWithBlockedBaseline = structuredClone(sourcedComparisonPayload);
  readyWithBlockedBaseline.status = 'blocked';
  readyWithBlockedBaseline.sharedSourceWatermark = 'a'.repeat(64);
  readyWithBlockedBaseline.comparisons[0] = { ...readyWithBlockedBaseline.comparisons[0], status: 'scenario_ready',
    candidateStatus: 'scenario_ready', amountCents: 1234, deltaToBaselineCents: null, employeeDeltas: null, reasons: [] };
  readyWithBlockedBaseline.comparisons[1] = { ...readyWithBlockedBaseline.comparisons[1], status: 'blocked',
    candidateStatus: 'blocked', amountCents: null, deltaToBaselineCents: null, employeeDeltas: null };
  readyWithBlockedBaseline.results[0].candidateSnapshot = { schemaVersion: 1, snapshotKind: 'candidate_preview',
    venueId, schemeId: readyWithBlockedBaseline.comparisons[0].schemeId,
    schemeVersionId: readyWithBlockedBaseline.comparisons[0].versionId, amountCents: 1234, candidateOnly: true,
    officialReady: false, payoutEligible: false, persistence: 'none', period: readyWithBlockedBaseline.period,
    lines: [], snapshotWatermark: 'b'.repeat(64), candidateResultWatermark: 'c'.repeat(64) };
  readyWithBlockedBaseline.results[1].candidateSnapshot = null;
  await page.route(comparisonRoute, (route) => route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify(readyWithBlockedBaseline) }));
  await page.locator('[data-source-comparison-run]').click();
  await page.locator('[data-sourced-comparison-status="scenario_ready"]').waitFor();
  assert.match(await page.locator('[data-source-comparison-result]').innerText(), /База недоступна/,
    'a ready non-baseline version remains visible when its baseline is blocked');
  await page.unroute(comparisonRoute);
  const invalidWatermarkResponse = structuredClone(readyWithBlockedBaseline);
  invalidWatermarkResponse.sharedSourceWatermark = 'not-a-sha256';
  await page.route(comparisonRoute, (route) => route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify(invalidWatermarkResponse) }));
  await page.locator('[data-source-comparison-run]').click();
  await page.locator('[data-source-comparison-result]').getByText(/не удалось сравнить версии/i).waitFor();
  assert.doesNotMatch(await page.locator('[data-source-comparison-result]').innerText(), /12,34/,
    'a malformed but truthy source watermark cannot expose a numeric comparison');
  await page.unroute(comparisonRoute);
  await page.locator('[data-source-readiness-to]').fill('2026-11-01');
  const readinessUiResponse = page.waitForResponse((response) => response.url().includes(`/api/payroll/versions/${versionId}/source-readiness?`) && response.request().method() === 'GET');
  await page.locator('[data-source-readiness-run]').click();
  assert.equal((await readinessUiResponse).status(), 200);
  await page.locator('[data-source-readiness-component="approvedAttendance"]').getByText('Неизменяемый снимок табеля проверен.', { exact: true }).waitFor();
  await page.locator('[data-source-readiness-official]').waitFor();
  assert.match(await page.locator('[data-source-readiness-component="refundObservations"]').innerText(), /Доступен/);
  assert.match(await page.locator('[data-source-readiness-component="refundObservations"]').innerText(), /Возвратов, зарегистрированных за период: 0/);
  for (const [component, label] of [['itemReturnEvidence', 'Проверка возвратов по строкам товаров'],
    ['employeeEligibility', 'Допуск сотрудников к расчёту'], ['employeeRoleCoverage', 'Покрытие сотрудников назначениями ролей']]) {
    const card = page.locator(`[data-source-readiness-component="${component}"]`);
    assert.equal(await card.count(), 1, `${component} appears exactly once in the owner readiness report`);
    assert.match(await card.innerText(), new RegExp(label));
  }
  assert.match(await page.locator('[data-source-readiness-component="itemReturnEvidence"]').innerText(), /Подтверждённых строк возврата/);
  assert.match(await page.locator('[data-source-readiness-component="employeeEligibility"]').innerText(), /Периодов допуска сотрудников: 1/);
  assert.match(await page.locator('[data-source-readiness-component="employeeRoleCoverage"]').innerText(), /Дней с назначенной ролью/);
  assert.match(await page.locator('[data-source-readiness-summary]').innerText(), /Доступно:/);
  const readinessGrid = page.locator('[data-source-readiness-grid]').first();
  for (const width of [320, 375, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    const bounds = await readinessGrid.evaluate(node => ({ left: node.getBoundingClientRect().left, right: node.getBoundingClientRect().right,
      clientWidth: node.clientWidth, scrollWidth: node.scrollWidth }));
    assert.ok(bounds.left >= 0 && bounds.right <= width + 1, `source readiness cards fit the viewport at ${width}px`);
    assert.ok(bounds.scrollWidth <= bounds.clientWidth + 1, `source readiness cards do not cause horizontal overflow at ${width}px`);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  const knownReadinessSummary = await page.locator('[data-source-readiness-summary]').innerText();
  const knownUnknownReadinessCount = await page.locator('[data-source-readiness-kind="unknown"]').count();
  const readinessPattern = '**/api/payroll/versions/*/source-readiness?*';
  await page.route(readinessPattern, async route => {
    const response = await route.fetch();
    const payload = await response.json();
    payload.components.futurePayrollSource = { status: 'available', reasons: [], amount: 12345 };
    payload.components.futurePayrollReview = { status: 'incomplete', reasons: [] };
    payload.components.futurePayrollState = { status: 'future-status', reasons: [] };
    await route.fulfill({ response, json: payload });
  });
  await page.locator('[data-source-readiness-run]').click();
  const unknownReadiness = page.locator('[data-source-readiness-kind="unknown"]');
  await unknownReadiness.first().waitFor();
  assert.equal(await unknownReadiness.count(), knownUnknownReadinessCount + 3, 'injected unknown statuses are visible alongside existing unrecognized source components');
  assert.match(await unknownReadiness.nth(0).innerText(), /Новый источник — требуется проверка/);
  assert.match(await unknownReadiness.nth(1).innerText(), /Новый источник — требуется проверка/);
  assert.match(await unknownReadiness.nth(2).innerText(), /Новый источник — требуется проверка/);
  assert.equal(await page.locator('[data-source-readiness-result]').getByText(/futurePayrollSource|futurePayrollReview|futurePayrollState/).count(), 0,
    'internal future component keys are not leaked into the owner UI');
  const injectedReadinessSummary = await page.locator('[data-source-readiness-summary]').innerText();
  assert.match(injectedReadinessSummary, new RegExp(`интерфейс не распознал или не получил: ${knownUnknownReadinessCount + 3}`));
  assert.equal(injectedReadinessSummary.replace(/интерфейс не распознал или не получил: \d+/, 'интерфейс не распознал или не получил: —'),
    knownReadinessSummary.replace(/интерфейс не распознал или не получил: \d+/, 'интерфейс не распознал или не получил: —'),
    'unknown component statuses do not affect mapped availability totals');
  await page.unroute(readinessPattern);
  await page.waitForFunction(() => document.querySelector('[data-source-readiness-run]')?.disabled === false);
  await page.locator('[data-source-readiness-run]').click();
  await page.locator('[data-source-readiness-component="employeeEligibility"]').waitFor();
  const candidateUiResponse = page.waitForResponse((response) => response.url().endsWith(`/api/payroll/versions/${versionId}/preview/sourced`) && response.request().method() === 'POST');
  await page.locator('[data-source-candidate-run]').click();
  const candidateResponse = await candidateUiResponse;
  assert.equal(candidateResponse.status(), 200);
  const candidatePayload = await candidateResponse.json();
  assert.equal(candidatePayload.sources?.fullEmployeeNetRevenue?.status, 'available', 'API confirms the empty period as a complete zero source');
  assert.equal(candidatePayload.candidateCalculation?.payoutEligible, false, 'blocked candidate API response cannot be paid');
  await page.waitForFunction(() => document.querySelector('[data-full-net-candidate-status]') || document.querySelector('[data-source-candidate-result]')?.innerText.includes('Не удалось загрузить кандидатные данные:'));
  assert.ok(await page.locator('[data-full-net-candidate-status="available"]').count(), `candidate UI renders available source; observed: ${await page.locator('[data-source-candidate-result]').innerText()}`);
  assert.match(await page.locator('[data-full-net-candidate-warning]').innerText(), /не является комиссионной базой или суммой зарплаты/);
  assert.match(await page.locator('[data-full-net-candidate-amount]').innerText(), /0,00/);
  await page.locator('[data-full-net-candidate-empty]').waitFor();
  assert.equal(await page.locator('[data-full-net-candidate-status="available"] tbody tr').count(), 0,
    'confirmed empty source is rendered as zero without inventing employee/day rows');
  await page.locator('[data-source-readiness-to]').fill('2026-11-02');
  assert.equal(await page.locator('[data-source-readiness-official]').count(), 0, 'changing the period clears the previous report');
  await page.locator('[data-source-readiness-to]').fill('2026-11-01');
  await page.locator('[data-source-readiness-run]').click();
  await page.locator('[data-source-readiness-official]').waitFor();
  await page.locator('[data-entry-diagnostic-from]').fill('2026-10-14');
  await page.locator('[data-entry-diagnostic-to]').fill('2026-10-14');
  await page.locator('[data-entry-diagnostic-run]').click();
  await page.locator('[data-entry-diagnostic-result] table').first().waitFor();
  assert.match(await page.locator('[data-entry-diagnostic-result]').innerText(),/Диагностика только для чтения/);
  assert.match(await page.locator('[data-entry-diagnostic-result]').innerText(),/P&L/);
  let releaseReadiness;
  const readinessRelease = new Promise((resolve) => { releaseReadiness = resolve; });
  let observedReadiness;
  const readinessObserved = new Promise((resolve) => { observedReadiness = resolve; });
  await page.route(readinessPattern, async (route) => {
    const original = await route.fetch();
    observedReadiness();
    await readinessRelease;
    await route.fulfill({ response: original });
  });
  await page.locator('[data-source-readiness-run]').click();
  await readinessObserved;
  assert.equal(await page.locator('[data-source-readiness-run]').isDisabled(), true);
  await page.locator('[data-source-readiness-to]').fill('2026-11-02');
  const staleReadinessResponse = page.waitForResponse((response) => response.url().includes('/source-readiness?'));
  releaseReadiness();
  await (await staleReadinessResponse).finished();
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.waitForFunction(() => document.querySelector('[data-source-readiness-run]')?.disabled === false);
  assert.equal(await page.locator('[data-source-readiness-official]').count(), 0, 'delayed response does not restore a report for the old period');
  await page.unroute(readinessPattern);
  await page.route(readinessPattern, (route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: '<img src=x onerror=bad>' }) }));
  await page.locator('[data-source-readiness-run]').click();
  await page.locator('[data-source-readiness-result]').getByText('Не удалось проверить источники:', { exact: false }).waitFor();
  assert.equal(await page.locator('[data-source-readiness-result] img').count(), 0);
  assert.equal(await page.locator('[data-source-readiness-run]').isDisabled(), false);
  await page.unroute(readinessPattern);
  await page.locator('[data-source-readiness-to]').fill('2026-11-01');
  await page.locator('[data-source-readiness-run]').click();
  await page.locator('[data-source-readiness-official]').waitFor();
  const savedDefinitionForReadiness = await page.locator('[data-scheme-definition]').inputValue();
  await page.locator('[data-scheme-workspace="configuration"]').first().click();
  await ensureDisclosureOpen(page.getByText('Расширенная конфигурация JSON', { exact: true }));
  await page.locator('[data-scheme-definition]').fill(`${savedDefinitionForReadiness}\n`);
  await page.locator('[data-scheme-workspace="checks"]').first().click();
  await ensureDisclosureOpen(page.getByText('Источники: проверить сохранённую версию схемы', { exact: true }));
  await page.locator('[data-source-readiness-dirty]').waitFor({ state: 'visible' });
  assert.match(await page.locator('[data-source-readiness-dirty]').innerText(), /сохранённой версии/);
  await page.locator('[data-scheme-workspace="configuration"]').first().click();
  await page.locator('[data-scheme-definition]').fill(savedDefinitionForReadiness);
  await page.locator('[data-scheme-grid-rebuild]').click();
  const readinessResponse = await page.request.get(`${base}/api/payroll/versions/${versionId}/source-readiness?${attendanceQuery}`);
  assert.equal(readinessResponse.status(), 200);
  const readiness = await readinessResponse.json();
  assert.equal(readiness.officialReady, false);
  assert.equal(readiness.components.approvedAttendance.status, 'available');
  assert.equal(readiness.components.approvedAttendance.approvalId, approval.approvalId);
  assert.equal(readiness.components.canonicalLinePricing.status, 'available');
  assert.equal(readiness.components.orderObservations.closedOrderCount, 0);
  assert.equal(readiness.components.refundObservations.status, 'available');
  assert.equal(readiness.components.refundObservations.eventCount, 0);
  const sourcedCountsBefore = await counts();
  const sourcedPreviewResponse = await page.request.post(`${base}/api/payroll/versions/${versionId}/preview/sourced`, { headers: { origin: base },
    data: { periodFrom: '2026-11-01', periodTo: '2026-11-30' } });
  assert.equal(sourcedPreviewResponse.status(), 200,
    `real owner sourced preview resolves producer/readiness/service under one request: ${await sourcedPreviewResponse.text()}`);
  const sourcedPreview = await sourcedPreviewResponse.json();
  assert.equal(sourcedPreview.candidateOnly, true);
  assert.equal(sourcedPreview.officialReady, false);
  assert.equal(sourcedPreview.calculationStatus, 'unavailable');
  assert.equal(sourcedPreview.amount, null, 'unknown payroll is never serialized as zero');
  assert.equal(sourcedPreview.sourceStatus, sourcedPreview.status);
  assert.ok(['available', 'incomplete', 'unsupported'].includes(sourcedPreview.sourceStatus));
  assert.ok(['available', 'incomplete', 'unsupported'].includes(sourcedPreview.projectionStatus));
  assert.equal(sourcedPreview.period.from, '2026-11-01');
  assert.equal(sourcedPreview.period.to, '2026-11-30');
  assert.equal(sourcedPreview.period.timezone, 'Asia/Yekaterinburg');
  assert.equal(sourcedPreview.sources.recognitionProjection.saleNetRevenueCents, null);
  assert.equal(sourcedPreview.sources.recognitionProjection.refundNetRevenueAdjustmentCents, null);
  const fullNetComponent = sourcedPreview.sources.readiness.components.fullEmployeeNetRevenue;
  assert.equal(sourcedPreview.sources.readiness.components.recognitionManifest.status, 'available', 'new venue epoch proves full empty-period coverage');
  assert.equal(fullNetComponent.status, 'available', 'full recognition coverage makes the empty merchandise period a known zero');
  assert.equal(sourcedPreview.sources.fullEmployeeNetRevenue.status, fullNetComponent.status);
  assert.equal(sourcedPreview.sources.fullEmployeeNetRevenue.amount, 0, 'complete empty recognition coverage is a known zero merchandise series');
  assert.deepEqual(sourcedPreview.sources.fullEmployeeNetRevenue.daily, []);
  assert.equal(sourcedPreview.sources.venueDailyTurnover.status, 'available', 'venue/day cap dependency is sourced from closed-order totals in this preview');
  assert.equal(sourcedPreview.sources.venueDailyTurnover.daily.length, 30, 'venue turnover covers the full month through the requested period end');
  assert.ok(sourcedPreview.sources.venueDailyTurnover.daily.every((row) => row.turnoverCents === 0), 'empty closed-order days are explicit zeros');
  assert.equal(sourcedPreview.sources.venueDailyTurnover.coverage.refundsIncluded, false, 'venue turnover remains pre-refund and is not represented as net');
  assert.equal(sourcedPreview.sources.venueDailyTurnover.coverage.complete, true);
  assert.equal(sourcedPreview.modes.progressive_daily.facts.find((fact) => fact.fact === 'venueDailyTurnover').status, 'available');
  assert.equal(sourcedPreview.watermarkScope, 'sourced_payroll_candidate_input_fingerprint');
  assert.match(sourcedPreview.sourceWatermark, /^[a-f0-9]{64}$/);
  assert.equal(sourcedPreview.calculationInputContract.status, 'blocked');
  assert.equal(sourcedPreview.calculationInputContract.calculatorInput, null);
  assert.equal(Object.hasOwn(sourcedPreview.noRefundInput, 'calculatorInput'), false);
  assert.equal(sourcedPreview.noRefundInput.officialReady, false);
  assert.equal(sourcedPreview.noRefundInput.payoutEligible, false);
  assert.equal(sourcedPreview.noRefundInput.persistence, 'none');
  assert.equal(sourcedPreview.noRefundInput.capabilityVersion, 'employee_attributed_merchandise_net_no_refund_v1');
  assert.ok(!sourcedPreview.calculationInputContract.reasons.some(reason => reason.startsWith('payroll_calculation_recognized_line_')),
    'the internal candidate projection is bound to its manifest and readiness watermark');
  assert.ok(!sourcedPreview.calculationInputContract.reasons.includes('payroll_calculation_full_employee_net_revenue_binding_mismatch'));
  assert.ok(sourcedPreview.calculationInputContract.reasons.includes('payroll_calculator_signed_refund_input_missing'));
  assert.deepEqual(Object.keys(sourcedPreview.modes).sort(), ['final_month_threshold','margin_target','percent_only','personal_target','progressive_daily','stable_percent','team_fund']);
  for (const mode of Object.values(sourcedPreview.modes)) {
    assert.equal(mode.calculationStatus, 'unavailable'); assert.equal(mode.amount, null);
  }
  const sourcedRepeat = await (await page.request.post(`${base}/api/payroll/versions/${versionId}/preview/sourced`, { headers: { origin: base },
    data: { periodFrom: '2026-11-01', periodTo: '2026-11-30' } })).json();
  assert.equal(sourcedRepeat.sourceWatermark, sourcedPreview.sourceWatermark, 'same current inputs produce stable fingerprint');
  assert.equal((await page.request.post(`${base}/api/payroll/versions/${versionId}/preview/sourced`, { headers: { origin: base },
    data: { periodFrom: '2026-11-01', periodTo: '2026-11-30', sales: [] } })).status(), 400);
  assert.equal((await page.request.post(`${base}/api/payroll/versions/${versionId}/preview/sourced`, { headers: { origin: base },
    data: { periodFrom: '2026-11-02', periodTo: '2026-11-30' } })).status(), 400);
  const preEpochSourced = await (await page.request.post(`${base}/api/payroll/versions/${versionId}/preview/sourced`, { headers: { origin: base },
    data: { periodFrom: '2020-01-01', periodTo: '2020-01-31' } })).json();
  assert.equal(preEpochSourced.sources.readiness.components.recognitionManifest.status, 'incomplete');
  assert.equal(preEpochSourced.sources.fullEmployeeNetRevenue.status, 'incomplete');
  assert.equal(preEpochSourced.sources.fullEmployeeNetRevenue.amount, null, 'pre-epoch history never becomes a fabricated zero');
  assert.deepEqual(preEpochSourced.sources.fullEmployeeNetRevenue.daily, []);
  await page.locator('[data-scheme-workspace="checks"]').first().click();
  await ensureDisclosureOpen(page.getByText('Источники: проверить сохранённую версию схемы', { exact: true }));
  await page.locator('[data-source-readiness-from]').fill('2020-01-01');
  await page.locator('[data-source-readiness-to]').fill('2020-01-31');
  const incompleteCandidateUiResponse = page.waitForResponse((response) => response.url().endsWith(`/api/payroll/versions/${versionId}/preview/sourced`) && response.request().method() === 'POST');
  await page.locator('[data-source-candidate-run]').click();
  assert.equal((await incompleteCandidateUiResponse).status(), 200);
  await page.locator('[data-full-net-candidate-status="incomplete"]').waitFor();
  assert.equal(await page.locator('[data-full-net-candidate-amount]').count(), 0, 'incomplete candidate source does not display a misleading zero or partial total');
  assert.match(await page.locator('[data-full-net-candidate-status="incomplete"]').innerText(), /пока источник не подтверждён/);
  const syntheticEvents = [{ kind: 'sale', id: randomUUID(), eventId: randomUUID(), amountMinor: 12000 },
    { kind: 'refund', id: randomUUID(), eventId: randomUUID(), amountMinor: -3000 },
    ...Array.from({ length: 2000 }, () => ({ kind: 'sale', id: randomUUID(), eventId: randomUUID(), amountMinor: 1 }))];
  const hostileReason = '<img src=x onerror=alert(1)>';
  const makeRefundReview = (input, populated = false) => {
    const rows = populated ? [{ refundItemId: randomUUID(), refundEventId: randomUUID(), originalSaleLineId: randomUUID(),
      orderId: randomUUID(), orderItemId: randomUUID(), menuItemId: null, menuItemName: 'Позиция QA',
      employeeId, refundDate: input.periodFrom, originalSaleDate: '2026-10-31', merchandiseNetRevenueDeltaCents: -3000, currency: 'RUB' }] : [];
    return { schemaVersion: 1, status: 'available', officialReady: false, candidateOnly: true, nonPayable: true,
      nonAccrual: true, payoutEligible: false, impactStatus: 'not_applied', currency: 'RUB', period: { from: input.periodFrom, to: input.periodTo },
      totalMerchandiseNetRevenueDeltaCents: rows.reduce((sum, row) => sum + row.merchandiseNetRevenueDeltaCents, 0), rows, reasons: [], sourceWatermark: 'a'.repeat(64),
      employeeDays: rows.length ? [{ employeeId, recognizedDate: rows[0].refundDate, merchandiseNetRevenueDeltaCents: -3000,
        refundItemIds: [rows[0].refundItemId], refundEventIds: [rows[0].refundEventId], originalSaleLineIds: [rows[0].originalSaleLineId] }] : [],
      watermarkScope: 'payroll_refund_review_projection' };
  };
  const makeOrderRevenueReconciliation = input => ({ schemaVersion: 1, status: 'incomplete', candidateOnly: true,
    officialReady: false, persistence: 'none', currency: 'RUB', period: { from: input.periodFrom, to: input.periodTo },
    amountBasis: 'canonical_closed_order_total_pre_refund', closedOrderCount: 1, recognizedOrderCount: 0,
    unrecognizedOrderCount: 1, totals: { closedOrderTotalMinor: null, recognizedLineNetMinor: null,
      minimumPriceAdjustmentMinor: null, unattributedResidualMinor: null },
    coverage: { complete: false, missingSaleEventCount: 1, invalidSnapshotCount: 0 }, orders: [],
    reasons: ['payroll_recognition_manifest_incomplete'], sourceWatermark: 'a'.repeat(64),
    watermarkScope: 'payroll_owner_closed_order_to_recognized_line_reconciliation' });
  await page.route(`**/api/payroll/versions/${versionId}/preview/sourced`, async (route) => {
    const input = route.request().postDataJSON();
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ schemaVersion: 1, versionId,
      period: { from: input.periodFrom, to: input.periodTo }, candidateOnly: true, officialReady: false, calculationStatus: 'unavailable', amount: null,
      candidateCalculation: { schemaVersion: 1, status: 'blocked', candidateOnly: true, nonPayable: true, nonAccrual: true,
        officialReady: false, payoutEligible: false, amountCents: null, period: { from: input.periodFrom, to: input.periodTo }, reasons: [] },
      candidateSnapshot: null, candidateSnapshotStatus: 'not_applicable',
      sources: { orderRevenueReconciliation: makeOrderRevenueReconciliation(input), refundReview: makeRefundReview(input, true), fullEmployeeNetRevenue: { status: 'available', reasons: [], currency: 'RUB', amount: 11000,
        daily: [{ employeeId, date: '2020-01-15', netMinor: 11000, sourceEvents: syntheticEvents }] } } }) });
  });
  const populatedCandidateResponse = page.waitForResponse((response) => response.url().endsWith(`/api/payroll/versions/${versionId}/preview/sourced`));
  await page.locator('[data-source-candidate-run]').click();
  assert.equal((await populatedCandidateResponse).status(), 200);
  await page.locator('[data-full-net-candidate-status="available"]').waitFor();
  assert.match(await page.locator('[data-full-net-candidate-amount]').innerText(), /110,00/);
  assert.equal(await page.locator('[data-payroll-refund-review-status="available"]').count(), 1);
  assert.match(await page.locator('[data-payroll-refund-review-total]').innerText(), /[-−]\s*30,00/);
  assert.match(await page.getByRole('region', { name: 'Изменение стоимости возвратов по сотрудникам и датам' }).innerText(), /2020-01-01/);
  assert.match(await page.getByRole('region', { name: 'Изменение стоимости возвратов по сотрудникам и датам' }).innerText(), /30,00/);
  assert.match(await page.locator('[data-payroll-refund-review-status="available"]').innerText(), /не применены к зарплате/);
  assert.match(await page.locator('[data-payroll-refund-review-status="available"]').innerText(), /2026-10-31/);
  assert.match(await page.locator('[data-full-net-candidate-status="available"] tbody tr').innerText(), /110,00/);
  assert.match(await page.locator('[data-full-net-candidate-status="available"] details summary').innerText(), /2002 событий/);
  await page.locator('[data-full-net-candidate-status="available"] details summary').click();
  assert.match(await page.locator('[data-full-net-candidate-status="available"] details').innerText(), /2 событий скрыто/);
  assert.equal(await page.locator('[data-full-net-candidate-status="available"] img').count(), 0);
  const candidateTableRegion = page.locator('[data-full-net-candidate-status="available"] [role="region"]');
  const refundTableRegion = page.getByRole('region', { name: 'Изменение стоимости возвратов по сотрудникам и датам' });
  for (const width of [320, 375, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    const tableBounds = await candidateTableRegion.evaluate(node => ({ width: node.getBoundingClientRect().width,
      scrollWidth: node.scrollWidth, clientWidth: node.clientWidth, tabIndex: node.tabIndex, name: node.getAttribute('aria-label') }));
    assert.ok(tableBounds.width <= width, `candidate table fits its container at ${width}px`);
    assert.ok(tableBounds.scrollWidth >= tableBounds.clientWidth, 'overflow remains inside the focusable table region');
    assert.equal(tableBounds.tabIndex, 0);
    assert.equal(tableBounds.name, 'Чистая стоимость товаров по сотрудникам и датам');
    const refundBounds = await refundTableRegion.evaluate(node => ({ width: node.getBoundingClientRect().width,
      scrollWidth: node.scrollWidth, clientWidth: node.clientWidth, tabIndex: node.tabIndex }));
    assert.ok(refundBounds.width <= width, `refund summary fits its container at ${width}px`);
    assert.ok(refundBounds.scrollWidth >= refundBounds.clientWidth, 'refund summary overflow remains inside the focusable table region');
    assert.equal(refundBounds.tabIndex, 0);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.unroute(`**/api/payroll/versions/${versionId}/preview/sourced`);
  await page.route(`**/api/payroll/versions/${versionId}/preview/sourced`, async (route) => {
    const input = route.request().postDataJSON();
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ schemaVersion: 1, versionId,
      period: { from: input.periodFrom, to: input.periodTo }, candidateOnly: true, officialReady: false, calculationStatus: 'unavailable', amount: null,
      candidateCalculation: { schemaVersion: 1, status: 'blocked', candidateOnly: true, nonPayable: true, nonAccrual: true,
        officialReady: false, payoutEligible: false, amountCents: null, period: { from: input.periodFrom, to: input.periodTo }, reasons: [] },
      candidateSnapshot: null, candidateSnapshotStatus: 'not_applicable',
      sources: { orderRevenueReconciliation: makeOrderRevenueReconciliation(input), refundReview: makeRefundReview(input), fullEmployeeNetRevenue: { status: 'incomplete', reasons: [hostileReason], currency: 'RUB', amount: null, daily: [] } } }) });
  });
  await page.locator('[data-source-candidate-run]').click();
  await page.locator('[data-full-net-candidate-status="incomplete"]').waitFor();
  assert.equal(await page.locator('[data-full-net-candidate-amount]').count(), 0);
  assert.match(await page.locator('[data-full-net-candidate-status="incomplete"]').innerText(), /Покрытие или правило источника не подтверждено/);
  assert.equal(await page.locator('[data-full-net-candidate-status="incomplete"] img').count(), 0, 'untrusted source reasons are escaped');
  assert.doesNotMatch(await page.locator('[data-full-net-candidate-status="incomplete"]').innerText(), /<img src=x onerror=alert\(1\)>/);
  await page.unroute(`**/api/payroll/versions/${versionId}/preview/sourced`);
  await page.route(`**/api/payroll/versions/${versionId}/preview/sourced`, async (route) => {
    const input = route.request().postDataJSON();
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ schemaVersion: 1, versionId,
      period: { from: input.periodFrom, to: input.periodTo }, candidateOnly: true, officialReady: false, calculationStatus: 'unavailable', amount: null,
      candidateCalculation: { schemaVersion: 1, status: 'blocked', candidateOnly: true, nonPayable: true, nonAccrual: true,
        officialReady: false, payoutEligible: false, amountCents: null, period: { from: input.periodFrom, to: input.periodTo }, reasons: [] },
      candidateSnapshot: null, candidateSnapshotStatus: 'not_applicable',
      sources: { orderRevenueReconciliation: makeOrderRevenueReconciliation(input), refundReview: makeRefundReview(input), fullEmployeeNetRevenue: { status: 'available', reasons: [], currency: 'RUB', amount: 1,
        daily: [{ employeeId, date: '<img src=x onerror=alert(1)>', netMinor: 1, sourceEvents: [{ kind: 'sale', id: randomUUID(), eventId: randomUUID(), amountMinor: 1 }] }] } } }) });
  });
  await page.locator('[data-source-candidate-run]').click();
  await page.locator('[data-source-candidate-result]').getByText('Не удалось загрузить кандидатные данные:', { exact: false }).waitFor();
  assert.equal(await page.locator('[data-source-candidate-result] img').count(), 0, 'invalid date content is written as text, never markup');
  await page.unroute(`**/api/payroll/versions/${versionId}/preview/sourced`);
  assert.deepEqual(await counts(), sourcedCountsBefore, 'sourced preview creates no runs, payroll entries or expenses');
  // Approve the exact month so the service can source verified attendance rows
  // internally; the public response must still expose no employee/shift input,
  // and the calculation gate must remain blocked on the other missing sources.
  const monthAttendanceQuery = 'from=2026-11-01&to=2026-11-30';
  const monthCoverageResponse = await page.request.get(`${base}/api/payroll/attendance/approvals?${monthAttendanceQuery}`);
  assert.equal(monthCoverageResponse.status(), 200);
  const monthAttendanceCoverage = await monthCoverageResponse.json();
  assert.equal(monthAttendanceCoverage.complete, true);
  const monthApprovalResponse = await page.request.post(`${base}/api/payroll/attendance/approvals`, { headers: { origin: base },
    data: { periodFrom: '2026-11-01', periodTo: '2026-11-30', sourceWatermark: monthAttendanceCoverage.sourceWatermark,
      reason: 'QA verifies complete month attendance', idempotencyKey: 'browser-verified-month-attendance' } });
  assert.equal(monthApprovalResponse.status(), 201);
  const monthApproval = await monthApprovalResponse.json();
  const monthSourcedResponse = await page.request.post(`${base}/api/payroll/versions/${versionId}/preview/sourced`, { headers: { origin: base },
    data: { periodFrom: '2026-11-01', periodTo: '2026-11-30' } });
  assert.equal(monthSourcedResponse.status(), 200);
  const monthSourced = await monthSourcedResponse.json();
  assert.equal(monthSourced.calculationInputContract.status, 'blocked');
  assert.equal(monthSourced.calculationInputContract.calculatorInput, null);
  assert.ok(!monthSourced.calculationInputContract.reasons.some(reason => reason.startsWith('payroll_calculation_recognized_line_')),
    'manifest and candidate projection watermarks remain bound after attendance and eligibility join the internal bundle');
  assert.ok(monthSourced.calculationInputContract.reasons.includes('payroll_calculator_signed_refund_input_missing'));
  assert.equal(monthSourced.calculationInputContract.reasons.includes('payroll_calculation_sales_collection_missing'), false,
    'complete empty immutable recognition evidence binds an explicit empty sales collection');
  assert.equal(monthSourced.calculationInputContract.reasons.includes('payroll_calculation_employees_collection_missing'), false,
    'server candidate input includes the exact owner-attested period roster when available');
  assert.equal(monthSourced.calculationInputContract.reasons.includes('payroll_calculation_roleAssignments_collection_missing'), false,
    'server candidate input includes saved-version role assignments');
  assert.equal(monthSourced.calculationInputContract.reasons.includes('payroll_calculation_role_assignments_scheme_mismatch'), false,
    'candidate role assignments match the selected saved scheme version');
  const roleCoverage = monthSourced.sources.readiness.components.employeeRoleCoverage;
  assert.equal(roleCoverage.status, 'available', 'saved role assignment covers each owner-attested active day');
  assert.equal(roleCoverage.activeEmployeeCount, 1);
  assert.equal(roleCoverage.activeEmployeeDayCount, 28, 'latest owner eligibility revision starts on November 3');
  assert.equal(roleCoverage.coveredEmployeeDayCount, 28);
  assert.equal(roleCoverage.watermarkScope, 'saved_scheme_and_owner_eligibility_period_role_coverage');
  assert.deepEqual(Object.keys(roleCoverage).sort(), ['activeEmployeeCount', 'activeEmployeeDayCount', 'coveredEmployeeDayCount',
    'currency', 'period', 'reasons', 'sourceWatermark', 'status', 'venueId', 'watermarkScope'].sort(),
  'role coverage exposes aggregate evidence only');
  const repeatedSourced = await page.request.post(`${base}/api/payroll/versions/${versionId}/preview/sourced`, { headers: { origin: base },
    data: { periodFrom: '2026-11-01', periodTo: '2026-11-30' } });
  assert.equal(repeatedSourced.status(), 200);
  assert.equal((await repeatedSourced.json()).sources.readiness.components.employeeRoleCoverage.sourceWatermark,
    roleCoverage.sourceWatermark, 'same saved source revisions and period yield a stable role coverage watermark');
  const sourcedJson = JSON.stringify(monthSourced);
  for (const privateAttendanceId of [monthAttendanceCoverage.shifts[0]?.scheduleId,
    monthAttendanceCoverage.shifts[0]?.employeeId, monthApproval.shifts[0]?.shiftId].filter(Boolean)) {
    assert.equal(sourcedJson.includes(privateAttendanceId), false, 'private attendance row and employee IDs are never returned');
  }
  assert.equal(monthSourced.sources.readiness.components.approvedAttendance.approvalId, monthApproval.approvalId,
    'approval ID remains available as bounded source provenance');
  const internalPool = new Pool({ connectionString: scopedUrl.href, max: 1 });
  try {
    const statements = [];
    const tracedPool = { query: () => { throw new Error('preparation_must_use_single_transaction_client'); }, connect: async () => {
      const connection = await internalPool.connect();
      return { query: async (sql, values) => {
        statements.push(typeof sql === 'string' ? sql : sql.text);
        return connection.query(sql, values);
      }, release: error => connection.release(error) };
    } };
    const internalService = makePayrollSchemeService(tracedPool);
    const preparationInput = { periodFrom: '2026-11-01', periodTo: '2026-11-30', runId: randomUUID() };
    const prepared = await internalService.prepareVerifiedSnapshotInput({ userId: ownerId, venueId }, versionId, preparationInput);
    assert.equal(prepared.officialReady, false);
    assert.equal(prepared.payoutEligible, false);
    assert.equal(prepared.persistence, 'none');
    assert.equal(prepared.status, 'blocked', 'incomplete fixture sources cannot become a ready run');
    const lockIndex = statements.findIndex(sql => sql.includes('pg_advisory_lock('));
    const beginIndex = statements.findIndex(sql => sql === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const closureIndex = statements.findIndex(sql => sql.includes('transaction_timestamp()::text'));
    const commitIndex = statements.findIndex(sql => sql === 'COMMIT');
    const unlockIndex = statements.findIndex(sql => sql.includes('pg_advisory_unlock('));
    assert.ok(lockIndex >= 0 && lockIndex < beginIndex && beginIndex < closureIndex
      && closureIndex < commitIndex && commitIndex < unlockIndex,
    'preparation acquires source fence before snapshot, reads closure inside it, and releases after commit');
    for (const principal of [{ userId: employeeId, venueId }, { userId: foreignOwnerId, venueId }]) {
      await assert.rejects(() => internalService.prepareVerifiedSnapshotInput(principal, versionId, preparationInput),
        error => error.status === 403);
    }
    await assert.rejects(() => internalService.prepareVerifiedSnapshotInput({ userId: ownerId, venueId }, versionId,
      { ...preparationInput, sourceBundle: {} }), error => error.status === 400);
    const runInput = { schemeVersionId: versionId, periodFrom: '2026-11-01', periodTo: '2026-11-30',
      idempotencyKey: 'browser-internal-verified-run' };
    await assert.rejects(() => internalService.createVerifiedRun({ userId: ownerId, venueId }, runInput),
      error => error.code === 'payroll_run_version_not_available', 'draft versions cannot produce ready runs');
    for (const principal of [{ userId: employeeId, venueId }, { userId: foreignOwnerId, venueId }]) {
      await assert.rejects(() => internalService.createVerifiedRun(principal, runInput), error => error.status === 403);
    }
    await assert.rejects(() => internalService.createVerifiedRun({ userId: ownerId, venueId },
      { ...runInput, sourceBundle: {} }), error => error.code === 'invalid_payroll_verified_run_request');
    assert.deepEqual(await counts(), sourcedCountsBefore, 'private preparation and denied attempts write no financial rows');
  } finally { await internalPool.end(); }
  assert.deepEqual(await counts(), sourcedCountsBefore, 'attendance-backed sourced preview still writes no financial records');
  for (const invalidQuery of [`${attendanceQuery}&from=2026-11-01`, `${attendanceQuery}&coverage=complete`]) {
    assert.equal((await page.request.get(`${base}/api/payroll/versions/${versionId}/source-readiness?${invalidQuery}`)).status(), 400);
  }
  scenario.attendance = [{ id: 'forged', employeeId, date: '2026-11-01', approved: true, workedMinutes: 480, plannedMinutes: 480 }];
  await page.locator('[data-scheme-workspace="trial"]').first().click();
  await ensureDisclosureOpen(page.getByText('Данные пробного сценария — JSON', { exact: true }));
  await page.locator('[data-scheme-preview-input]').fill(JSON.stringify(scenario));
  const sourcedResponse = page.waitForResponse((response) => response.url().endsWith(`/api/payroll/versions/${versionId}/preview/approved-attendance`) && response.request().method() === 'POST');
  await page.locator('[data-scheme-run-approved-attendance]').click();
  const sourcedValue = await sourcedResponse;
  assert.equal(sourcedValue.status(), 200);
  const sourcedPayload = await sourcedValue.json();
  assert.equal(sourcedPayload.official, false); assert.equal(sourcedPayload.persistence, 'none');
  assert.equal(sourcedPayload.sourceAttendanceApproval.approvalId, approval.approvalId);
  assert.equal(sourcedPayload.attendanceContext[0].scheduledFunctionId, attendanceFunction);
  assert.equal(sourcedPayload.attendanceContext[0].scheduledFunctionName, 'Бар — подмена QA');
  const shiftDetails = sourcedPayload.result.daily.flatMap((day) => day.employees.flatMap((row) => row.shiftDetails));
  assert.equal(shiftDetails.length, 1); assert.equal(shiftDetails[0].workedMinutes, 180, 'approved preview reflects the source mutation committed before its watermark check');
  assert.notEqual(shiftDetails[0].shiftId, 'forged');
  await page.locator('[data-scheme-preview-result]').getByText('Сценарий с утверждённой посещаемостью, не официальный расчёт', { exact: true }).waitFor();
  await page.locator('[data-payroll-attendance-context]').getByText('Бар — подмена QA', { exact: true }).waitFor();
  assert.equal((await db.query('SELECT created_by FROM payroll_scheme_versions WHERE id=$1', [versionId])).rows[0].created_by, ownerId);
  const directory = path.join(root, 'tmp', 'payroll-editor-browser-qa');
  mkdirSync(directory, { recursive: true });
  await page.locator('[data-scheme-workspace="configuration"]').first().click();
  for (const width of [320, 375, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.locator('[data-scheme-editor]').scrollIntoViewIfNeeded();
    await page.locator('[data-scheme-editor-title]').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(directory, `editor-${width}.png`) });
    const snapshotRoleDetails = milestoneRoleControl.locator('xpath=ancestor::details[2]');
    if (!(await snapshotRoleDetails.evaluate((node) => node.open))) await snapshotRoleDetails.locator('summary').click();
    const snapshotMilestoneGroup = milestoneRoleControl.locator('xpath=ancestor::details[1]');
    if (!(await snapshotMilestoneGroup.evaluate((node) => node.open))) await snapshotMilestoneGroup.locator('summary').click();
    await milestoneRoleControl.locator('..').screenshot({ path: path.join(directory, `milestone-role-${width}.png`) });
    await ensureDisclosureOpen(page.getByText('Пороговые премии: суммы по ролям', { exact: true }));
    await page.locator('[data-grid-milestone-table]').screenshot({ path: path.join(directory, `milestone-bonus-${width}.png`) });
    await page.locator('[data-scheme-workspace="checks"]').first().click();
    await ensureDisclosureOpen(page.getByText('Источники: проверить сохранённую версию схемы', { exact: true }));
    await page.locator('[data-source-readiness]').scrollIntoViewIfNeeded();
    await page.locator('[data-source-readiness]').screenshot({ path: path.join(directory, `readiness-${width}.png`) });
    await page.locator('[data-scheme-workspace="configuration"]').first().click();
    await ensureDisclosureOpen(page.getByText('Правила источников — расширенная настройка', { exact: true }));
    await page.locator('[data-source-policy-fieldset]').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(directory, `source-policy-${width}.png`) });
    const overflow = await page.locator('.finance-payroll-schemes').evaluate((node) => ({ width: node.clientWidth, scroll: node.scrollWidth, offenders: [...node.querySelectorAll('*')].filter((entry) => entry.getBoundingClientRect().right > node.getBoundingClientRect().right + 1).slice(0, 8).map((entry) => ({ tag: entry.tagName, cls: entry.className, width: entry.clientWidth })) }));
    assert.equal(overflow.scroll > overflow.width + 1, false, `payroll editor fits ${width}px: ${JSON.stringify(overflow)}`);
    const eligibilityOverflow = await page.locator('.finance-payroll-eligibility').evaluate((node) => ({ width: node.clientWidth, scroll: node.scrollWidth }));
    assert.equal(eligibilityOverflow.scroll > eligibilityOverflow.width + 1, false, `employment history editor fits ${width}px`);
  }
  await page.locator('[data-scheme-workspace="configuration"]').first().click();
  await ensureDisclosureOpen(page.getByText('Индивидуальные условия сотрудников', { exact: true }));
  const wageCardIndex = await page.locator('[data-grid-override]').evaluateAll((cards) => cards.findIndex((card) => card.querySelector('[data-grid-override-path]')?.value === 'perShiftCents'));
  assert.notEqual(wageCardIndex, -1, 'personal wage override card is present');
  const wageCard = page.locator('[data-grid-override]').nth(wageCardIndex);
  await wageCard.locator('[data-grid-inherit]').click();
  assert.doesNotMatch(await roleImpact.innerText(), /perShiftCents/);
  assert.equal(await page.locator('[data-scheme-risk-acknowledged]').isChecked(), false);
  await page.locator('[data-scheme-risk-acknowledged]').check();
  await page.locator('[data-personal-cap-acknowledged]').check();
  const visibleRoleSelect = page.locator('[data-grid-role="bartender"][data-grid-path="mode"]').locator('..');
  await visibleRoleSelect.locator('.custom-select-trigger').click();
  await visibleRoleSelect.locator('[data-value="progressive_daily"]').click();
  assert.equal(await page.locator('[data-scheme-risk-acknowledged]').isChecked(), false, 'visible role dropdown resets acknowledgement');
  await page.locator('[data-scheme-grid-apply]').click();
  assert.equal(JSON.parse(await page.locator('[data-scheme-definition]').inputValue()).roleParameters.bartender.mode, 'progressive_daily');
  definition.roleParameters.bartender.mode = 'progressive_daily';
  await page.locator('[data-scheme-risk-acknowledged]').check();
  const visiblePolicySelect = page.locator('[data-source-policy-sale]').locator('..');
  await visiblePolicySelect.locator('.custom-select-trigger').click();
  await visiblePolicySelect.locator('[data-value="order_responsible_snapshot"]').click();
  assert.equal(await page.locator('[data-scheme-risk-acknowledged]').isChecked(), false, 'real visible dropdown resets acknowledgement');
  assert.equal(await page.locator('[data-personal-cap-acknowledged]').isChecked(), false, 'visible dropdown resets separate cap acknowledgement');
  assert.match(await page.locator('[data-source-policy-message]').innerText(), /неприменённые/);
  await page.locator('[data-source-policy-reason]').fill('Владелец выбирает зафиксированного ответственного');
  await page.locator('[data-source-policy-apply]').click();
  const selectedPolicy = JSON.parse(await page.locator('[data-scheme-definition]').inputValue()).sourcePolicies;
  const inherited = JSON.parse(await page.locator('[data-scheme-definition]').inputValue()).employeeOverrides.find((row) => row.path === 'perShiftCents');
  assert.equal(inherited.mode, 'inherit');
  assert.equal(Object.hasOwn(inherited, 'value'), false);
  assert.equal(inherited.effectiveFrom, '2026-11-01');
  assert.equal(inherited.effectiveTo, '2026-11-10');
  await page.locator('[data-scheme-risk-acknowledged]').check();
  await page.locator('[data-personal-cap-acknowledged]').check();
  const updatedResponse = page.waitForResponse((response) => response.url().includes(`/api/payroll/versions/${versionId}`) && response.request().method() === 'PUT');
  await page.locator('[data-scheme-save]').click();
  const updatedValue = await updatedResponse;
  assert.equal(updatedValue.status(), 200);
  const updatedVersion = await updatedValue.json();
  assert.deepEqual(updatedVersion.sourcePolicies, selectedPolicy);
  assert.notEqual(updatedVersion.payoutRiskAcknowledgement.configDigest, initialDigest);
  await page.waitForFunction(() => !document.querySelector('[data-scheme-save]')?.disabled);
  const revisionBefore = (await db.query('SELECT count(*)::int AS count FROM payroll_scheme_version_revisions WHERE scheme_version_id=$1', [versionId])).rows[0].count;
  const invalidDefinition = JSON.parse(await page.locator('[data-scheme-definition]').inputValue()); invalidDefinition.sourcePolicies = null;
  const ack = { confirmed: true, policyCode: 'payroll-own-revenue-ceiling-v1' };
  const mutationHeaders = { origin: base };
  assert.equal((await page.request.put(`${base}/api/payroll/versions/${versionId}`, { headers: mutationHeaders, data: { definition: invalidDefinition, payoutRiskAcknowledgement: ack } })).status(), 400);
  assert.equal((await page.request.post(`${base}/api/payroll/schemes`, { headers: mutationHeaders, data: { name: 'Invalid policy', definition: invalidDefinition, payoutRiskAcknowledgement: ack } })).status(), 400);
  assert.equal((await db.query('SELECT count(*)::int AS count FROM payroll_scheme_version_revisions WHERE scheme_version_id=$1', [versionId])).rows[0].count, revisionBefore);
  assert.equal((await db.query("SELECT count(*)::int AS count FROM payroll_schemes WHERE name='Invalid policy'")).rows[0].count, 0);
  const currentHttp = await (await page.request.get(`${base}/api/payroll/versions/${versionId}`)).json();
  assert.deepEqual(currentHttp.sourcePolicies, selectedPolicy);
  assert.equal(currentHttp.payoutRiskAcknowledgement.configDigest, updatedVersion.payoutRiskAcknowledgement.configDigest);
  const revisionHttp = await (await page.request.get(`${base}/api/payroll/versions/${versionId}/revisions`)).json();
  assert.deepEqual(revisionHttp.items.at(-1).snapshot.sourcePolicies, selectedPolicy);
  for (const [suffix, expected] of [['staff', 403], ['finance', 403], ['foreign', 404]]) {
    const isolated = await browser.newContext();
    try {
      const auth = await isolated.request.post(`${base}/api/login`, { data: { username: `${login}-${suffix}`, password } });
      assert.equal(auth.status(), 200);
      assert.equal((await isolated.request.get(`${base}/api/payroll/versions/${versionId}`)).status(), expected);
      assert.equal((await isolated.request.get(`${base}/api/payroll/versions/${versionId}/source-readiness?${attendanceQuery}`)).status(), expected);
      const diagnosticStatus=await isolated.request.get(`${base}/api/payroll/entry-overlap-diagnostic?from=2026-10-14&to=2026-10-14`);
      assert.equal(diagnosticStatus.status(),suffix==='foreign'?200:403,'only an owner can read payroll entry diagnostics; another venue owner sees their own venue scope');
      if(suffix==='foreign'){
        const foreignDiagnostic=await diagnosticStatus.json();
        assert.ok(foreignDiagnostic.entries.every(row=>row.employeeId===foreignEmployeeId),'foreign owner sees only payroll entries from their own venue');
        assert.ok(!foreignDiagnostic.entries.some(row=>row.employeeId===employeeId),'foreign owner receives no payroll entries from another venue');
        assert.deepEqual(foreignDiagnostic.payrollExpenses,[],'foreign owner receives no payroll expenses from another venue');
      }
      const employmentHistoryResponse = await isolated.request.get(`${base}/api/payroll/employment-eligibility`);
      assert.equal(employmentHistoryResponse.status(), suffix === 'foreign' ? 200 : 403,
        'non-owners cannot access eligibility; a different owner only sees their own empty venue source');
      if (suffix === 'foreign') assert.equal((await employmentHistoryResponse.json()).current, null);
      const employmentRosterResponse = await isolated.request.get(`${base}/api/payroll/employment-eligibility/employees`);
      assert.equal(employmentRosterResponse.status(), suffix === 'foreign' ? 200 : 403);
      if (suffix === 'foreign') assert.ok(!(await employmentRosterResponse.json()).items.some(row => row.id === employeeId), 'another owner never receives this venue payroll roster');
      if (suffix !== 'foreign') assert.equal((await isolated.request.post(`${base}/api/payroll/employment-eligibility`, { headers: mutationHeaders,
        data: employmentRequest })).status(), 403);
      if (suffix !== 'foreign') {
        const nonOwnerPage = await isolated.newPage();
        await nonOwnerPage.goto(`${base}/finance#payroll`, { waitUntil: 'networkidle' });
        assert.equal(await nonOwnerPage.locator('.finance-payroll-eligibility').count(), 0, 'non-owner cannot see the owner-only history editor');
      }
      assert.equal((await isolated.request.post(`${base}/api/payroll/versions/${versionId}/preview/sourced`, { headers: mutationHeaders,
        data: { periodFrom: '2026-11-01', periodTo: '2026-11-30' } })).status(), expected);
      assert.equal((await isolated.request.put(`${base}/api/payroll/versions/${versionId}`, { headers: mutationHeaders, data: { definition: invalidDefinition, payoutRiskAcknowledgement: ack } })).status(), expected);
    } finally { await isolated.close(); }
  }
  await page.locator('[data-scheme-workspace="list"]').first().click();
  const activatedResponse = page.waitForResponse((response) => response.url().endsWith(`/api/payroll/versions/${versionId}/activate`) && response.request().method() === 'POST');
  await page.locator(`[data-scheme-activate="${versionId}"]`).click();
  assert.equal((await activatedResponse).status(), 200);
  const runPool = new Pool({ connectionString: scopedUrl.href, max: 1 });
  try {
    const statements = [];
    const service = makePayrollSchemeService({ query: () => { throw new Error('verified_run_requires_one_client'); },
      connect: async () => {
        const connection = await runPool.connect();
        return { query: (sql, values) => { statements.push(sql); return connection.query(sql, values); },
          release: error => connection.release(error) };
      } });
    const runInput = { schemeVersionId: versionId, periodFrom: '2026-11-01', periodTo: '2026-11-30',
      idempotencyKey: 'browser-internal-verified-run' };
    const before = await counts();
    const blocked = await service.createVerifiedRun({ userId: ownerId, venueId }, runInput);
    assert.equal(blocked.status, 'blocked', 'incomplete actual sources cannot create a ready header');
    assert.ok(blocked.reasons.length > 0);
    assert.equal(blocked.persistence, 'none');
    assert.equal(blocked.payoutEligible, false);
    const lock = statements.findIndex(sql => sql.includes('pg_advisory_lock('));
    const begin = statements.indexOf('BEGIN ISOLATION LEVEL REPEATABLE READ READ WRITE');
    const closure = statements.findIndex(sql => sql.includes('transaction_timestamp()::text'));
    const commit = statements.indexOf('COMMIT');
    const unlock = statements.findIndex(sql => sql.includes('pg_advisory_unlock('));
    assert.ok(lock >= 0 && lock < begin && begin < closure && closure < commit && commit < unlock);
    assert.ok(statements.some(sql => /FROM venues WHERE id=\$1 FOR SHARE/.test(sql)));
    assert.ok(statements.some(sql => /FROM payroll_scheme_versions WHERE venue_id=\$1 AND id=\$2 FOR SHARE/.test(sql)));
    await assert.rejects(() => service.createVerifiedRun({ userId: ownerId, venueId },
      { ...runInput, periodFrom: '2026-10-01', periodTo: '2026-10-31' }),
    error => error.code === 'payroll_run_outside_scheme_version');
    assert.deepEqual(await counts(), before, 'blocked, denied and out-of-window runs create no entries, expenses or headers');
  } finally { await runPool.end(); }
  await page.locator(`[data-scheme-open-version="${versionId}"]`).click();
  await page.waitForFunction(() => document.querySelector('[data-scheme-grid-fieldset]')?.disabled === true);
  assert.equal(await page.locator('[data-grid-inherit]').first().isDisabled(), true);
  assert.equal(await page.locator('[data-grid-role="bartender"][data-grid-path="perShiftCents"]').isDisabled(), true);
  assert.equal(await page.locator('[data-scheme-definition]').evaluate((node) => node.readOnly), true);
  assert.equal(await page.locator('[data-scheme-save]').isHidden(), true);
  assert.equal(await page.locator('[data-source-policy-sale]').isDisabled(), true);
  assert.equal(await page.locator('[data-personal-cap-acknowledged]').isDisabled(), true);
  assert.equal(await page.locator('[data-source-policy-sale]').locator('..').locator('.custom-select-trigger').isDisabled(), true);
  const activeReadback = JSON.parse(await page.locator('[data-scheme-definition]').inputValue());
  assert.equal(await page.locator('[data-source-readiness-run]').isDisabled(), false, 'active saved version can be inspected');
  await page.locator('[data-scheme-workspace="checks"]').first().click();
  await ensureDisclosureOpen(page.getByText('Источники: проверить сохранённую версию схемы', { exact: true }));
  await page.locator('[data-source-readiness-run]').click();
  await page.locator('[data-source-readiness-official]').waitFor();
  await page.locator('[data-scheme-workspace="configuration"]').first().click();
  await page.locator('[data-scheme-editor-cancel]').click();
  assert.equal(await page.locator('[data-source-readiness-official]').count(), 0);
  assert.equal(await page.locator('[data-source-readiness-run]').isDisabled(), true);
  assert.deepEqual(activeReadback.employeeOverrides.find((row) => row.path === 'perShiftCents'), inherited);
  assert.deepEqual(activeReadback.roleParameters, definition.roleParameters);
  assert.deepEqual(activeReadback.sourcePolicies, selectedPolicy);
  assert.deepEqual(await counts(), before, 'editing configuration never posts payroll or expenses');
  assert.deepEqual(errors.filter((error) => !error.includes('ViewTransition opt-in disabled')), []);
  console.log('PAYROLL SCHEME BROWSER POSTGRES QA: PASS (owner grid/policies→API→PG→reload, scenario and sourced preview/read-only/refusal semantics, policy revision/digest, malformed atomicity, role/tenant isolation, dated inheritance, activation read-only, four widths and no financial posting)');
} finally {
  await browser?.close();
  if (child) { child.kill(); if (child.exitCode === null) await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 3000))]); }
  if (created) {
    await db.query('SET search_path TO public');
    await db.query(`DROP SCHEMA "${schema}" CASCADE`);
    assert.equal((await db.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [schema])).rows.length, 0);
  }
  await db.end();
}
