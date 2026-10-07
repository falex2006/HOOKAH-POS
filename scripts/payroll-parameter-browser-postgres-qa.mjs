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
const schema = `payroll_parameter_qa_${process.pid}_${Date.now()}`;
assert.match(schema, /^payroll_parameter_qa_\d+_\d+$/);
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

  // This suite proves owner UI configuration persistence, not mode arithmetic or official source readiness.
  const matrix=[
    ['mode','stable_percent','stable_percent'],['perShiftCents','0',0],['stableRateBps','12,34',1234],
    ['targetCents','1234,56',123456],['baseRateBps','10,25',1025],['bonusRateBps','65',6500],
    ['excessRatePolicy','add_to_base','add_to_base'],['lossPolicy','offset_daily_losses','offset_daily_losses'],
    ['itemRuleBasis','net_revenue','net_revenue'],['teamWeight','0',0],['cap.rateBps','0',0],
    ['cap.basis','employee_department_day','employee_department_day'],['applyMilestones','false',false],
    ['bracketRatesBps.40000000','0',0],['milestoneBonusesCents.40000000','2000,25',200025]
  ];
  assert.equal(matrix.length,15);
  const definition={mode:'personal_target',currency:'RUB',effectiveFrom:'2026-11-01',effectiveTo:'2026-11-30',milestoneCapPolicy:'included_in_cap',
    roleParameters:{bartender:{perShiftCents:10000,stableRateBps:1000,bracketRatesBps:{0:500},targetCents:100000,
      baseRateBps:1600,bonusRateBps:4000,excessRatePolicy:'replace_base',lossPolicy:'offset_daily_losses',itemRuleBasis:'net_revenue',
      teamWeight:1,cap:{rateBps:3000,basis:'venue_day',department:'bar'},applyMilestones:false,milestoneBonusesCents:{30000000:200000},
      untouched:{note:'matrix preserves extra role facts'}}},
    roleAssignments:[{employeeId,roleId:'bartender',effectiveFrom:'2026-11-01',effectiveTo:'2026-11-30'}],employeeOverrides:[],itemRules:[]};
  await page.locator('[data-scheme-new]').click();
  await page.locator('[data-scheme-name]').fill('Full personal parameter browser matrix');
  await page.locator('details').filter({has:page.locator('[data-scheme-definition]')}).locator('summary').click();
  await page.locator('[data-scheme-definition]').fill(JSON.stringify(definition));
  await page.locator('[data-scheme-grid-rebuild]').click();
  for(const [parameter,text] of matrix){
    await page.locator('[data-grid-add-override]').click();const card=page.locator('[data-grid-override="new"]').last();
    await card.locator('[data-grid-employee]').fill(employeeId);await card.locator('[data-grid-override-path]').fill(parameter);
    await card.locator('[data-grid-override-value]').fill(text);await card.locator('[data-grid-override-from]').fill('2026-11-03');
    await card.locator('[data-grid-override-to]').fill('2026-11-20');
  }
  await page.locator('[data-scheme-grid-apply]').click();
  const expected=new Map(matrix.map(([parameter,,value])=>[parameter,value]));
  const assertRows=(rows,inherit=false)=>{
    assert.equal(rows.length,matrix.length);
    for(const [parameter,value] of expected){const row=rows.find(row=>row.path===parameter);assert(row,parameter);
      assert.equal(row.employeeId,employeeId);assert.equal(row.mode,inherit?'inherit':'override');
      if(inherit)assert.equal(Object.hasOwn(row,'value'),false,parameter+' inherits without a scalar');else assert.equal(row.value,value,parameter+' typed value');
      assert.equal(row.effectiveFrom,'2026-11-03');assert.equal(row.effectiveTo,'2026-11-20');}
  };
  assertRows(JSON.parse(await page.locator('[data-scheme-definition]').inputValue()).employeeOverrides);
  await page.locator('[data-scheme-risk-acknowledged]').check();
  assert.equal(await page.locator('[data-personal-cap-confirmation]').isHidden(),true,'zero cap below role needs no increase acknowledgement');
  const createResponse=page.waitForResponse(response=>response.url().endsWith('/api/payroll/schemes')&&response.request().method()==='POST');
  await page.locator('[data-scheme-save]').click();const createdResponse=await createResponse;assert.equal(createdResponse.status(),201);
  const createdBody=await createdResponse.json();const versionId=createdBody.versions[0].versionId;
  assertRows(createdBody.versions[0].employeeOverrides);
  const pgRows=async()=> (await db.query('SELECT employee_id AS "employeeId",parameter_path AS path,override_mode AS mode,value_json AS value,effective_from::text AS "effectiveFrom",effective_to::text AS "effectiveTo" FROM payroll_employee_overrides WHERE venue_id=$1 AND scheme_version_id=$2 ORDER BY parameter_path',[venueId,versionId])).rows;
  const verifyPg=async(inherit=false)=>{const rows=await pgRows();assert.equal(rows.length,matrix.length);for(const row of rows){assert(expected.has(row.path));assert.equal(row.employeeId,employeeId);assert.equal(row.mode,inherit?'inherit':'override');assert.equal(row.value,inherit?null:expected.get(row.path));assert.equal(row.effectiveFrom,'2026-11-03');assert.equal(row.effectiveTo,'2026-11-20');}};
  const reopen=async()=>{
    await page.reload({waitUntil:'networkidle'});await page.locator('[data-scheme-open-version="'+versionId+'"]').click();
    await page.waitForFunction(id=>{try{return JSON.parse(document.querySelector('[data-scheme-definition]')?.value||'{}').employeeOverrides?.length===15&&!document.querySelector('[data-scheme-save]')?.disabled;}catch{return false;}},versionId);
  };
  const cardFor=parameter=>page.locator('[data-grid-override]').filter({has:page.locator('[data-grid-override-path][value="'+parameter+'"]')});
  await verifyPg();await reopen();assertRows(JSON.parse(await page.locator('[data-scheme-definition]').inputValue()).employeeOverrides);
  for(const [parameter,text,value] of matrix){
    const familiar=/^(perShiftCents|targetCents|stableRateBps|baseRateBps|bonusRateBps|cap\.rateBps|bracketRatesBps\.\d+|milestoneBonusesCents\.\d+)$/.test(parameter)?(value/100).toFixed(2):text;
    assert.equal(await cardFor(parameter).locator('[data-grid-override-value]').inputValue(),familiar,parameter+' familiar units');
  }
  const saveEdit=async()=>{await page.locator('[data-scheme-risk-acknowledged]').check();const responsePromise=page.waitForResponse(response=>response.url().endsWith('/api/payroll/versions/'+versionId)&&response.request().method()==='PUT');await page.locator('[data-scheme-save]').click();const response=await responsePromise;assert.equal(response.status(),200);return response.json();};
  // Three personally selected modes persist while all other parameter choices remain independent.
  for(const mode of ['personal_target','margin_target']){
    await cardFor('mode').locator('[data-grid-override-value]').fill(mode);await page.locator('[data-scheme-grid-apply]').click();expected.set('mode',mode);
    assertRows((await saveEdit()).employeeOverrides);await verifyPg();await reopen();assertRows(JSON.parse(await page.locator('[data-scheme-definition]').inputValue()).employeeOverrides);
  }
  const directory=path.join(root,'tmp','payroll-parameter-browser-qa');mkdirSync(directory,{recursive:true});
  for(const width of [1440,1024,768,375,320]){
    await page.setViewportSize({width,height:1000});await cardFor('applyMilestones').scrollIntoViewIfNeeded();
    await page.screenshot({path:path.join(directory,'parameters-'+width+'.png')});
    const overflow=await page.locator('.finance-payroll-schemes').evaluate(node=>({width:node.clientWidth,scroll:node.scrollWidth}));
    assert(overflow.scroll<=overflow.width+1,'parameter panel overflow '+width+': '+JSON.stringify(overflow));
  }
  await page.setViewportSize({width:1440,height:1000});
  for(const [parameter] of matrix){const card=cardFor(parameter);await card.locator('[data-grid-inherit]').click();assert.equal(await card.locator('[data-grid-override-value]').inputValue(),'','inherit clears '+parameter);}
  await page.locator('[data-scheme-grid-apply]').click();assertRows(JSON.parse(await page.locator('[data-scheme-definition]').inputValue()).employeeOverrides,true);
  assertRows((await saveEdit()).employeeOverrides,true);await verifyPg(true);await reopen();
  assertRows(JSON.parse(await page.locator('[data-scheme-definition]').inputValue()).employeeOverrides,true);
  for(const [parameter] of matrix){assert.equal(await cardFor(parameter).locator('[data-grid-override-mode]').inputValue(),'inherit');assert.equal(await cardFor(parameter).locator('[data-grid-override-value]').inputValue(),'');}
  const activateResponse=page.waitForResponse(response=>response.url().endsWith('/api/payroll/versions/'+versionId+'/activate')&&response.request().method()==='POST');
  await page.locator('[data-scheme-activate="'+versionId+'"]').click();const activation=await activateResponse;assert.equal(activation.status(),200);
  const activatedBody=await activation.json();assert.equal(activatedBody.versionId,versionId);assert.equal(activatedBody.status,'active');assertRows(activatedBody.employeeOverrides,true);
  await page.locator('[data-scheme-open-version="'+versionId+'"]').click();await page.waitForFunction(()=>document.querySelector('[data-scheme-grid-fieldset]')?.disabled===true);
  for(const [parameter] of matrix){const card=cardFor(parameter);assert.equal(await card.locator('[data-grid-inherit]').isDisabled(),true);assert.equal(await card.locator('[data-grid-override-value]').isDisabled(),true);assert.equal(await card.locator('[data-grid-override-mode]').isDisabled(),true);assert.equal(await card.locator('.custom-select-trigger').isDisabled(),true);}
  assert.equal(await page.locator('[data-scheme-definition]').evaluate(node=>node.readOnly),true);assert.equal(await page.locator('[data-scheme-save]').isHidden(),true);
  const readback=await (await page.request.get(base+'/api/payroll/versions/'+versionId)).json();assertRows(readback.employeeOverrides,true);assert.deepEqual(readback.roleParameters,definition.roleParameters);
  assert.deepEqual(await counts(),before,'configuration QA creates no payroll/expense/run postings');assert.deepEqual(errors.filter(error=>!error.includes('ViewTransition opt-in disabled')),[]);
  console.log('PAYROLL PARAMETER BROWSER POSTGRES QA: PASS (15 individual paths, typed units/zero/false/enums, three modes, real owner cards→HTTP→PG→reload, dated inherit, activation read-only, five widths; persistence only, no official payroll claim)');

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
