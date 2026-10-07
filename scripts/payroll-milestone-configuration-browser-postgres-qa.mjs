import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { randomBytes, scryptSync } from 'node:crypto';
import path from 'node:path';
import { validateQaDatabaseUrl, assertQaDatabaseIdentity } from './postgres-qa-safety.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const target = validateQaDatabaseUrl(process.env.MIGRATIONS_PG_TEST_DATABASE_URL);
const require = createRequire(import.meta.url);
const { Client } = require('pg');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE_PATH || 'playwright');
const db = new Client({ connectionString: target.url.href });
const schema = `payroll_milestone_config_browser_qa_${process.pid}_${Date.now()}`;
assert.match(schema, /^payroll_milestone_config_browser_qa_\d+_\d+$/);
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
  for (const name of readdirSync(path.join(root, 'migrations')).filter((name) => /^\d{3}.*\.sql$/.test(name) && Number(name.slice(0, 3)) <= 89).sort()) {
    await db.query(readFileSync(path.join(root, 'migrations', name), 'utf8'));
  }
  const organizationId = (await db.query("INSERT INTO organizations(name,slug) VALUES('Payroll editor QA',$1) RETURNING id", [schema])).rows[0].id;
  await db.query("INSERT INTO organization_subscriptions(organization_id,status) VALUES($1,'active')", [organizationId]);
  const venueId = (await db.query("INSERT INTO venues(name,timezone,organization_id) VALUES('Payroll editor QA','Asia/Yekaterinburg',$1) RETURNING id", [organizationId])).rows[0].id;
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
  const counts = async () => (await db.query('SELECT (SELECT count(*)::int FROM payroll_entries) AS entries,(SELECT count(*)::int FROM expenses) AS expenses,(SELECT count(*)::int FROM payroll_calculation_runs) AS runs')).rows[0];
  const before = await counts();
  child = spawn(process.execPath, ['server.js'], { cwd: root, windowsHide: true,
    env: { ...process.env, DATABASE_URL: scopedUrl.href, VENUE_ID: venueId, AUTH_REQUIRED: 'true', DEMO_MODE: 'false', NODE_ENV: 'test', HOST: '127.0.0.1', PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
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
  await page.goto(`${base}/finance`, { waitUntil: 'networkidle' });
  const financeSummary = await page.request.get(`${base}/api/finance/summary?date=2026-11-01`);
  assert.equal(financeSummary.status(), 200, 'current finance summary reads migration 088 in this isolated fixture');
  assert.equal((await page.request.get(`${base}/api/analytics?days=all`)).status(), 200);
  const other=(await db.query("INSERT INTO users(venue_id,full_name,login,role) VALUES($1,'Refused employee',$2,'bartender') RETURNING id",[venueId,login+'-refused'])).rows[0].id;
  const definition={mode:'stable_percent',currency:'RUB',effectiveFrom:'2026-11-01',effectiveTo:'2026-11-30',applyMilestones:true,roleParameters:{bartender:{perShiftCents:0,stableRateBps:0,milestoneBonusesCents:{10000:100}}},roleAssignments:[employeeId,other].map(employeeId=>({employeeId,roleId:'bartender',effectiveFrom:'2026-11-01',effectiveTo:'2026-11-30'})),employeeOverrides:[],itemRules:[]};
  await page.locator('[data-scheme-new]').click();await page.locator('[data-scheme-name]').fill('Milestone eligibility browser');await page.locator('details').filter({has:page.locator('[data-scheme-definition]')}).locator('summary').click();await page.locator('[data-scheme-definition]').fill(JSON.stringify(definition));await page.locator('[data-scheme-grid-rebuild]').click();
  const schemeControl=()=>page.locator('[data-grid-scheme-milestone-eligibility]'),roleControl=()=>page.locator('[data-grid-role="bartender"][data-grid-path="milestoneEligibility"]');
  await schemeControl().selectOption('worked_on_threshold_day');await roleControl().selectOption('all_active');await page.locator('[data-grid-add-override]').click();const card=()=>page.locator('[data-grid-override]').filter({has:page.locator('[data-grid-override-path][value="milestoneEligibility"]')});const newCard=page.locator('[data-grid-override="new"]').last();await newCard.locator('[data-grid-employee]').fill(other);await newCard.locator('[data-grid-override-path]').fill('milestoneEligibility');await newCard.locator('[data-grid-override-value]').fill('worked_on_threshold_day');await newCard.locator('[data-grid-override-from]').fill('2026-11-01');await newCard.locator('[data-grid-override-to]').fill('2026-11-14');
  await page.locator('[data-scheme-grid-apply]').click();await page.locator('[data-scheme-risk-acknowledged]').check();const creating=page.waitForResponse(r=>r.url().endsWith('/api/payroll/schemes')&&r.request().method()==='POST');await page.locator('[data-scheme-save]').click();const creation=await creating;assert.equal(creation.status(),201);const createdScheme=await creation.json(),versionId=createdScheme.versions[0].versionId;
  const verify=async(inherit=false)=>{const response=await page.request.get(base+'/api/payroll/versions/'+versionId);assert.equal(response.status(),200);const s=await response.json();assert.equal(s.milestoneEligibility,'worked_on_threshold_day');assert.equal(s.roleParameters.bartender.milestoneEligibility,'all_active');const row=s.employeeOverrides[0];assert.equal(row.path,'milestoneEligibility');assert.equal(row.mode,inherit?'inherit':'override');assert.equal(row.value,inherit?undefined:'worked_on_threshold_day');assert.equal(row.effectiveFrom,'2026-11-01');assert.equal(row.effectiveTo,'2026-11-14');const pg=(await db.query('SELECT parameter_path,override_mode,value_json,effective_from::text,effective_to::text FROM payroll_employee_overrides WHERE scheme_version_id=$1',[versionId])).rows[0];assert.deepEqual(pg,{parameter_path:'milestoneEligibility',override_mode:inherit?'inherit':'override',value_json:inherit?null:'worked_on_threshold_day',effective_from:'2026-11-01',effective_to:'2026-11-14'});const config=(await db.query('SELECT config_json FROM payroll_scheme_versions WHERE id=$1',[versionId])).rows[0].config_json;assert.equal(config.milestoneEligibility,s.milestoneEligibility);assert.equal(config.roleParameters.bartender.milestoneEligibility,'all_active');return s;};
  const reopen=async()=>{await page.reload({waitUntil:'networkidle'});const pending=page.waitForResponse(r=>r.url().endsWith('/api/payroll/versions/'+versionId)&&r.request().method()==='GET');await page.locator('[data-scheme-open-version="'+versionId+'"]').click();assert.equal((await pending).status(),200);await page.waitForFunction(()=>document.querySelector('[data-grid-scheme-milestone-eligibility]')?.value==='worked_on_threshold_day');};
  const first=await verify();await reopen();assert.equal(await roleControl().inputValue(),'all_active');assert.equal(await card().locator('[data-grid-override-value]').inputValue(),'worked_on_threshold_day');assert.equal(await card().locator('[data-grid-override-to]').inputValue(),'2026-11-14');
  const scenario={periodFrom:'2026-11-01',periodTo:'2026-11-02',employees:[{id:employeeId},{id:other}],attendance:[{id:'later-shift',employeeId:other,date:'2026-11-02',approved:true,workedMinutes:60,plannedMinutes:60}],sales:[{id:'line',employeeId,date:'2026-11-01',department:'bar',turnoverCents:10000,commissionBaseCents:10000}],coverage:{kind:'month_to_date_complete',from:'2026-11-01',through:'2026-11-02',complete:true,watermark:'scenario'},attendanceCoverage:{kind:'approved_attendance_complete',from:'2026-11-01',through:'2026-11-02',complete:true,watermark:'scenario'}};
  const preview=async(eligible)=>{await page.locator('[data-scheme-preview-input]').fill(JSON.stringify(scenario));const pending=page.waitForResponse(r=>r.url().endsWith('/api/payroll/versions/'+versionId+'/preview')&&r.request().method()==='POST');await page.locator('[data-scheme-run-preview]').click();const response=await pending;assert.equal(response.status(),200);const b=await response.json();assert.equal(b.official,false);assert.equal(b.persistence,'none');assert.equal(b.result.status,'ready');const decision=b.result.daily[0].milestoneDecisions.find(r=>r.employeeId===other);assert.equal(decision.eligible,eligible);assert.equal(b.result.daily[1].milestoneDecisions.length,0,'no catchup nextday');if(!eligible)assert.equal(b.result.daily[0].employees.some(r=>r.employeeId===other),false,'no fabricated payout');await page.waitForFunction(()=>document.querySelectorAll('[data-scheme-preview-result] [data-milestone-decision-row]').length===2);const day=page.locator('[data-scheme-preview-result] details.finance-scheme-day').filter({has:page.locator('summary').filter({hasText:'2026-11-01'})});assert.equal(await day.count(),1);if(!(await day.evaluate(n=>n.open)))await day.locator(':scope > summary').click();const row=day.locator('[data-milestone-decision-row]').filter({hasText:new RegExp(other+'|Refused employee')});assert.equal(await row.count(),1);assert.equal(await row.isVisible(),true);assert.match(await row.innerText(),eligible?/Премия разрешена/:/Нет утверждённой работы в день порога/);};
  await preview(false);await card().locator('[data-grid-inherit]').click();await page.locator('[data-scheme-grid-apply]').click();await page.locator('[data-scheme-risk-acknowledged]').check();const updating=page.waitForResponse(r=>r.url().endsWith('/api/payroll/versions/'+versionId)&&r.request().method()==='PUT');await page.locator('[data-scheme-save]').click();assert.equal((await updating).status(),200);const inherited=await verify(true);assert.notEqual(first.payoutRiskAcknowledgement.configDigest,inherited.payoutRiskAcknowledgement.configDigest);await reopen();await preview(true);
  await card().locator('[data-grid-override-mode]').selectOption('override');await card().locator('[data-grid-override-value]').fill('worked_on_threshold_day');await page.locator('[data-scheme-grid-apply]').click();await page.locator('[data-scheme-risk-acknowledged]').check();const restoring=page.waitForResponse(r=>r.url().endsWith('/api/payroll/versions/'+versionId)&&r.request().method()==='PUT');await page.locator('[data-scheme-save]').click();assert.equal((await restoring).status(),200);await reopen();await preview(false);
  const directory=path.join(root,'tmp','payroll-milestone-configuration-browser-qa');mkdirSync(directory,{recursive:true});for(const width of [1440,1024,768,375,320]){await page.setViewportSize({width,height:1000});await schemeControl().scrollIntoViewIfNeeded();await page.screenshot({path:path.join(directory,'eligibility-'+width+'.png')});const size=await page.locator('.finance-payroll-schemes').evaluate(n=>({width:n.clientWidth,scroll:n.scrollWidth}));assert(size.scroll<=size.width+1,'overflow '+width);}
  await page.setViewportSize({width:1440,height:1000});const activating=page.waitForResponse(r=>r.url().endsWith('/api/payroll/versions/'+versionId+'/activate')&&r.request().method()==='POST');await page.locator('[data-scheme-activate="'+versionId+'"]').click();assert.equal((await activating).status(),200);await reopen();assert.equal(await schemeControl().isDisabled(),true);assert.equal(await roleControl().isDisabled(),true);assert.equal(await card().locator('[data-grid-override-value]').isDisabled(),true);assert.equal(await page.locator('[data-scheme-definition]').evaluate(n=>n.readOnly),true);assert.equal(await page.locator('[data-scheme-save]').isHidden(),true);await verify();
  await page.locator('[data-scheme-new-version="'+createdScheme.id+'"]').click();await page.waitForFunction(()=>document.querySelector('[data-scheme-editor-title]')?.textContent==='Новая версия схемы');assert.equal(await schemeControl().inputValue(),'worked_on_threshold_day');assert.equal(await roleControl().inputValue(),'all_active');assert.equal(await card().locator('[data-grid-override-value]').inputValue(),'worked_on_threshold_day');assert.equal(await schemeControl().isDisabled(),false);await page.locator('[data-scheme-risk-acknowledged]').check();const addingVersion=page.waitForResponse(r=>r.url().endsWith('/api/payroll/schemes/'+createdScheme.id+'/versions')&&r.request().method()==='POST');await page.locator('[data-scheme-save]').click();const nextResponse=await addingVersion;assert.equal(nextResponse.status(),201);const nextVersion=await nextResponse.json();assert.equal(nextVersion.versionNo,2);assert.equal(nextVersion.milestoneEligibility,'worked_on_threshold_day');assert.equal(nextVersion.roleParameters.bartender.milestoneEligibility,'all_active');assert.equal(nextVersion.employeeOverrides[0].value,'worked_on_threshold_day');assert.equal(nextVersion.employeeOverrides[0].effectiveTo,'2026-11-14');const nextConfig=(await db.query('SELECT config_json FROM payroll_scheme_versions WHERE id=$1',[nextVersion.versionId])).rows[0].config_json;assert.equal(nextConfig.milestoneEligibility,'worked_on_threshold_day');await page.reload({waitUntil:'networkidle'});await page.locator('[data-scheme-open-version="'+nextVersion.versionId+'"]').click();await page.waitForFunction(()=>document.querySelector('[data-grid-scheme-milestone-eligibility]')?.value==='worked_on_threshold_day');assert.equal(await roleControl().inputValue(),'all_active');assert.equal(await card().locator('[data-grid-override-value]').inputValue(),'worked_on_threshold_day');assert.equal(await card().locator('[data-grid-override-from]').inputValue(),'2026-11-01');assert.equal(await card().locator('[data-grid-override-to]').inputValue(),'2026-11-14');
  assert.deepEqual(await counts(),before);assert.deepEqual(errors.filter(e=>!e.includes('ViewTransition opt-in disabled')),[]);
  console.log('PAYROLL MILESTONE CONFIGURATION BROWSER POSTGRES: PASS (typed scheme/role/personal, HTTP/PG/reload, inherit/digest, refusal renderer/no catchup, readonly, five widths and no posting)');
} finally {
  await browser?.close();if(child){child.kill();if(child.exitCode===null)await Promise.race([once(child,'exit'),new Promise(resolve=>setTimeout(resolve,3000))]);}
  if(created){await db.query('ROLLBACK');await db.query('SET search_path TO public');await db.query(`DROP SCHEMA "${schema}" CASCADE`);assert.equal((await db.query('SELECT 1 FROM pg_namespace WHERE nspname=$1',[schema])).rows.length,0);}await db.end();
}





