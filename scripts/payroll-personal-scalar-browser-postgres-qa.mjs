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
const schema = `payroll_scalar_browser_qa_${process.pid}_${Date.now()}`;
assert.match(schema, /^payroll_scalar_browser_qa_\d+_\d+$/);
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
  for (const name of readdirSync(path.join(root, 'migrations')).filter((name) => /^\d{3}.*\.sql$/.test(name) && Number(name.slice(0, 3)) <= 88).sort()) {
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

  const matrix=[['mode','personal_target','personal_target'],['targetCents','100',10000],['baseRateBps','10',1000],['bonusRateBps','20',2000],['excessRatePolicy','replace_base','replace_base']];
  const definition={mode:'stable_percent',currency:'RUB',effectiveFrom:'2026-11-01',effectiveTo:'2026-11-30',roleParameters:{bartender:{perShiftCents:0,stableRateBps:1000}},roleAssignments:[{employeeId,roleId:'bartender',effectiveFrom:'2026-11-01',effectiveTo:'2026-11-30'}],employeeOverrides:[],itemRules:[]};
  await page.locator('[data-scheme-new]').click();await page.locator('[data-scheme-name]').fill('Personal missing scalars browser');
  await page.locator('details').filter({has:page.locator('[data-scheme-definition]')}).locator('summary').click();
  await page.locator('[data-scheme-definition]').fill(JSON.stringify(definition));await page.locator('[data-scheme-grid-rebuild]').click();
  for(const [parameter,text] of matrix){await page.locator('[data-grid-add-override]').click();const card=page.locator('[data-grid-override="new"]').last();await card.locator('[data-grid-employee]').fill(employeeId);await card.locator('[data-grid-override-path]').fill(parameter);await card.locator('[data-grid-override-value]').fill(text);await card.locator('[data-grid-override-from]').fill('2026-11-02');await card.locator('[data-grid-override-to]').fill('2026-11-14');}
  await page.locator('[data-scheme-grid-apply]').click();await page.locator('[data-scheme-risk-acknowledged]').check();
  const creation=page.waitForResponse(r=>r.url().endsWith('/api/payroll/schemes')&&r.request().method()==='POST');await page.locator('[data-scheme-save]').click();const createdResponse=await creation;assert.equal(createdResponse.status(),201);const versionId=(await createdResponse.json()).versions[0].versionId;
  const cardFor=p=>page.locator('[data-grid-override]').filter({has:page.locator('[data-grid-override-path][value="'+p+'"]')});
  const verify=async(inherit=false)=>{
    const saved=await(await page.request.get(base+'/api/payroll/versions/'+versionId)).json();assert.deepEqual(saved.roleParameters,definition.roleParameters);assert.equal(saved.employeeOverrides.length,5);
    const pg=(await db.query('SELECT parameter_path AS path,override_mode AS mode,value_json AS value,effective_from::text AS "from",effective_to::text AS "to" FROM payroll_employee_overrides WHERE venue_id=$1 AND scheme_version_id=$2',[venueId,versionId])).rows;assert.equal(pg.length,5);
    for(const [p,,v] of matrix){const row=saved.employeeOverrides.find(r=>r.path===p),dbrow=pg.find(r=>r.path===p);assert.equal(row.employeeId,employeeId);assert.equal(row.mode,inherit?'inherit':'override');assert.equal(row.value,inherit?undefined:v);assert.equal(row.effectiveFrom,'2026-11-02');assert.equal(row.effectiveTo,'2026-11-14');assert.deepEqual(dbrow,{path:p,mode:inherit?'inherit':'override',value:inherit?null:v,from:'2026-11-02',to:'2026-11-14'});}
  };
  const reopen=async()=>{await page.reload({waitUntil:'networkidle'});const pending=page.waitForResponse(r=>r.url().endsWith('/api/payroll/versions/'+versionId)&&r.request().method()==='GET');await page.locator('[data-scheme-open-version="'+versionId+'"]').click();const response=await pending;assert.equal(response.status(),200);assert.equal((await response.json()).versionId,versionId);await page.waitForFunction(()=>{try{return JSON.parse(document.querySelector('[data-scheme-definition]')?.value||'{}').employeeOverrides?.length===5&&!document.querySelector('[data-scheme-save]')?.disabled;}catch{return false;}});};
  await verify();await reopen();
  for(const [p,t,v] of matrix){assert.equal(await cardFor(p).locator('[data-grid-override-value]').inputValue(),typeof v==='number'?(v/100).toFixed(2):t);assert.equal(await cardFor(p).locator('[data-grid-override-from]').inputValue(),'2026-11-02');assert.equal(await cardFor(p).locator('[data-grid-override-to]').inputValue(),'2026-11-14');}
  const scenario={periodFrom:'2026-11-01',periodTo:'2026-11-02',employees:[{id:employeeId}],roleAssignments:definition.roleAssignments,attendance:[],sales:[{id:'line',employeeId,date:'2026-11-02',department:'bar',turnoverCents:20000,commissionBaseCents:20000}],coverage:{kind:'month_to_date_complete',from:'2026-11-01',through:'2026-11-02',complete:true,watermark:'scenario'},attendanceCoverage:{kind:'approved_attendance_complete',from:'2026-11-01',through:'2026-11-02',complete:true,watermark:'scenario'}};
  const preview=async(amount)=>{await page.locator('[data-scheme-preview-input]').fill(JSON.stringify(scenario));const pending=page.waitForResponse(r=>r.url().endsWith('/api/payroll/versions/'+versionId+'/preview')&&r.request().method()==='POST');await page.locator('[data-scheme-run-preview]').click();const response=await pending;assert.equal(response.status(),200);const body=await response.json();assert.equal(body.official,false);assert.equal(body.persistence,'none');assert.equal(body.result.status,'ready');assert.equal(body.result.employees[0].amountCents,amount);const expectedAmount=new Intl.NumberFormat('ru-RU',{style:'currency',currency:'RUB',minimumFractionDigits:2}).format(amount/100);await page.waitForFunction(expected=>document.querySelector('[data-scheme-preview-result] table tbody tr td:nth-child(8) strong')?.textContent===expected,expectedAmount);assert.equal(await page.locator('[data-scheme-preview-result] table').first().locator('tbody tr td').nth(7).locator('strong').innerText(),expectedAmount);assert.match(await page.locator('[data-scheme-preview-result]').innerText(),/сценар/i);};
  await preview(3000);
  const save=async(status=200)=>{await page.locator('[data-scheme-risk-acknowledged]').check();const pending=page.waitForResponse(r=>r.url().endsWith('/api/payroll/versions/'+versionId)&&r.request().method()==='PUT');await page.locator('[data-scheme-save]').click();const response=await pending;assert.equal(response.status(),status);return response;};
  const revisionCount=async()=>(await db.query('SELECT count(*)::int AS n FROM payroll_scheme_version_revisions WHERE venue_id=$1 AND scheme_version_id=$2',[venueId,versionId])).rows[0].n;const revisionsBeforeFailure=await revisionCount();
  const originalPg=(await db.query('SELECT * FROM payroll_employee_overrides WHERE venue_id=$1 AND scheme_version_id=$2 ORDER BY parameter_path',[venueId,versionId])).rows;
  await cardFor('targetCents').locator('[data-grid-inherit]').click();await page.locator('[data-scheme-grid-apply]').click();const rejected=await save(400);assert.equal((await rejected.json()).error,'invalid_personal_parameters');await page.waitForFunction(()=>document.querySelector('[data-scheme-message]')?.textContent.includes('Личные параметры неполны'));assert.match(await page.locator('[data-scheme-message]').innerText(),/Личные параметры неполны/);assert.deepEqual((await db.query('SELECT * FROM payroll_employee_overrides WHERE venue_id=$1 AND scheme_version_id=$2 ORDER BY parameter_path',[venueId,versionId])).rows,originalPg);
  assert.equal(await revisionCount(),revisionsBeforeFailure,'failed save creates no revision');
  await reopen();for(const [p]of matrix)await cardFor(p).locator('[data-grid-inherit]').click();await page.locator('[data-scheme-grid-apply]').click();await save();await verify(true);await reopen();await preview(2000);
  for(const [p]of matrix){assert.equal(await cardFor(p).locator('[data-grid-override-mode]').inputValue(),'inherit');assert.equal(await cardFor(p).locator('[data-grid-override-value]').inputValue(),'');}
  // Restore the complete missing-role personal configuration before activating it.
  for(const [p,t]of matrix){await cardFor(p).locator('[data-grid-override-mode]').selectOption('override');await cardFor(p).locator('[data-grid-override-value]').fill(t);}await page.locator('[data-scheme-grid-apply]').click();await save();await verify();await reopen();await preview(3000);
  const directory=path.join(root,'tmp','payroll-personal-scalar-browser-qa');mkdirSync(directory,{recursive:true});
  for(const width of [1440,1024,768,375,320]){await page.setViewportSize({width,height:1000});await cardFor('targetCents').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(directory,'scalar-'+width+'.png')});const size=await page.locator('.finance-payroll-schemes').evaluate(n=>({width:n.clientWidth,scroll:n.scrollWidth}));assert(size.scroll<=size.width+1,'overflow '+width);}
  await page.setViewportSize({width:1440,height:1000});const pending=page.waitForResponse(r=>r.url().endsWith('/api/payroll/versions/'+versionId+'/activate')&&r.request().method()==='POST');await page.locator('[data-scheme-activate="'+versionId+'"]').click();const activated=await pending;assert.equal(activated.status(),200);assert.equal((await activated.json()).status,'active');await page.locator('[data-scheme-open-version="'+versionId+'"]').click();await page.waitForFunction(()=>document.querySelector('[data-scheme-grid-fieldset]')?.disabled===true);
  for(const [p]of matrix){assert.equal(await cardFor(p).locator('[data-grid-override-value]').isDisabled(),true);assert.equal(await cardFor(p).locator('[data-grid-inherit]').isDisabled(),true);assert.equal(await cardFor(p).locator('[data-grid-override-mode]').isDisabled(),true);assert.equal(await cardFor(p).locator('.custom-select-trigger').isDisabled(),true);}assert.equal(await page.locator('[data-scheme-definition]').evaluate(n=>n.readOnly),true);assert.equal(await page.locator('[data-scheme-save]').isHidden(),true);await verify();
  assert.deepEqual(await counts(),before);assert.deepEqual(errors.filter(e=>!e.includes('ViewTransition opt-in disabled')),[]);
  console.log('PAYROLL PERSONAL SCALAR BROWSER POSTGRES: PASS (five absent-role cards→HTTP→PG→reload, actual UI scenario3000/inherit2000, invalid save retained DB, activation readonly, five widths, no posting; no official source claim)');
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
