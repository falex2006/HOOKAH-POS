import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { scryptSync, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { validateQaDatabaseUrl, assertQaDatabaseIdentity } from './postgres-qa-safety.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const target = validateQaDatabaseUrl(process.env.MIGRATIONS_PG_TEST_DATABASE_URL);
const require = createRequire(import.meta.url);
const { Client, Pool } = require('pg');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE_PATH || 'playwright');
const { makeService } = require('../payroll-scheme-service.js');
const schema = `payroll_department_api_qa_${process.pid}_${Date.now()}`;
assert.match(schema, /^payroll_department_api_qa_\d+_\d+$/);
const scopedUrl = new URL(target.url);
scopedUrl.searchParams.set('options', `-c search_path=${schema},public`);
const client = new Client({ connectionString: target.url.href });
let pool;
let created = false;
let server;
let browser;
try {
  await client.connect();
  const identity = (await client.query('SELECT current_database() AS database,inet_server_addr() AS address,inet_server_port() AS port,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser')).rows[0];
  assertQaDatabaseIdentity(identity, target.database, Number(target.url.port));
  await client.query(`CREATE SCHEMA "${schema}"`);
  created = true;
  await client.query(`SET search_path TO "${schema}",public`);
  await client.query(readFileSync(path.join(root, 'schema.sql'), 'utf8'));
  let organizationId, venueId;
  for (const name of readdirSync(path.join(root, 'migrations')).filter(file => file.endsWith('.sql')).sort()) {
    if (name === '144_pos_payroll_recognition.sql') {
      organizationId = (await client.query("INSERT INTO organizations(name,slug) VALUES('Payroll mapping API QA',$1) RETURNING id", [schema])).rows[0].id;
      venueId = (await client.query("INSERT INTO venues(name,timezone,organization_id) VALUES('Payroll mapping API QA','Asia/Yekaterinburg',$1) RETURNING id", [organizationId])).rows[0].id;
    }
    await client.query(readFileSync(path.join(root, 'migrations', name), 'utf8'));
  }
  assert.ok(venueId, 'venue is created before payroll migrations that inspect existing venues');
  await client.query("INSERT INTO organization_subscriptions(organization_id,status) VALUES($1,'active')", [organizationId]);
  const login = `${schema}-owner`;
  const password = randomBytes(16).toString('hex');
  const salt = randomBytes(16).toString('hex');
  const passwordHash = `scrypt$${salt}$${scryptSync(password, salt, 64).toString('hex')}`;
  const ownerId = (await client.query("INSERT INTO users(venue_id,organization_id,full_name,login,password_hash,role) VALUES($1,$2,'Payroll mapping owner',$3,$4,'owner') RETURNING id", [venueId, organizationId, login, passwordHash])).rows[0].id;
  await client.query("INSERT INTO organization_memberships(organization_id,user_id,membership_role) VALUES($1,$2,'owner')", [organizationId, ownerId]);
  const managerId = (await client.query("INSERT INTO users(venue_id,organization_id,full_name,login,role) VALUES($1,$2,'Payroll mapping manager',$3,'manager') RETURNING id", [venueId, organizationId, `${schema}-manager`])).rows[0].id;
  const foreignVenueId = (await client.query("INSERT INTO venues(name,timezone,organization_id) VALUES('Foreign mapping venue','Asia/Yekaterinburg',$1) RETURNING id", [organizationId])).rows[0].id;
  const foreignOwnerId = (await client.query("INSERT INTO users(venue_id,organization_id,full_name,login,role) VALUES($1,$2,'Foreign mapping owner',$3,'owner') RETURNING id", [foreignVenueId, organizationId, `${schema}-foreign`])).rows[0].id;
  const productId = (await client.query("INSERT INTO products(venue_id,name,category,sale_price) VALUES($1,'Payroll mapping product','Drinks',125.00) RETURNING id", [venueId])).rows[0].id;
  const foreignProductId = (await client.query("INSERT INTO products(venue_id,name,category,sale_price) VALUES($1,'Foreign mapping product','Drinks',125.00) RETURNING id", [foreignVenueId])).rows[0].id;
  pool = new Pool({ connectionString: scopedUrl.href, max: 3 });
  const service = makeService(pool);
  const owner = { userId: ownerId, venueId };
  const manager = { userId: managerId, venueId };
  const foreignOwner = { userId: foreignOwnerId, venueId: foreignVenueId };
  const initial = await service.getProductDepartmentMappings(owner);
  assert.equal(initial.currentRevision, null);
  assert.deepEqual(initial.currentAssignments, []);
  assert.ok(initial.nextEffectiveFrom);
  const baseline = await client.query('SELECT (SELECT count(*)::int FROM payroll_entries) AS entries,(SELECT count(*)::int FROM expenses) AS expenses,(SELECT count(*)::int FROM payroll_calculation_runs) AS runs');
  server = spawn(process.execPath, ['server.js'], { cwd: root, windowsHide: true,
    env: { ...process.env, DATABASE_URL: scopedUrl.href, VENUE_ID: venueId, AUTH_REQUIRED: 'true', DEMO_MODE: 'false',
      NODE_ENV: 'test', HOST: '127.0.0.1', PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let startup = '';
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Isolated mapping browser server did not start')), 15000);
    server.once('error', error => { clearTimeout(timer); reject(error); });
    server.once('exit', code => { clearTimeout(timer); reject(new Error(`Isolated mapping browser server exited ${code}`)); });
    server.stdout.on('data', chunk => {
      startup += chunk;
      const match = startup.match(/CRM running on http:\/\/localhost:(\d+)/);
      if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); }
    });
  });
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'ru-RU' });
  await page.goto(`${base}/login`, { waitUntil: 'networkidle' });
  await page.locator('#login-username').fill(login);
  await page.locator('#login-password').fill(password);
  const loginResponsePromise = page.waitForResponse(response => response.url().endsWith('/api/login') && response.request().method() === 'POST');
  await page.locator('#login-form button[type="submit"]').click();
  assert.equal((await loginResponsePromise).status(), 200);
  await page.waitForURL(url => !url.pathname.includes('/login'));
  await page.goto(`${base}/finance#payroll`, { waitUntil: 'networkidle' });
  const panel = page.locator('.finance-payroll-departments');
  await panel.waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('[data-department-status]')?.textContent.includes('Версия ещё не создана'));
  await panel.locator('[data-department-edit]').click();
  const row = panel.locator('[data-department-row]').first();
  await row.locator('[data-map-product]').selectOption(productId);
  await row.locator('[data-map-code]').fill('bar');
  await row.locator('[data-map-name]').fill('Бар');
  await panel.locator('[data-department-reason]').fill('Create first payroll product classification');
  const normalResponsePromise = page.waitForResponse(response => response.url().endsWith('/api/payroll/product-department-mappings/revisions')
    && response.request().method() === 'POST');
  await panel.locator('[data-department-save]').click();
  const normalResponse = await normalResponsePromise;
  assert.equal(normalResponse.status(), 201, 'owner UI posts the normal full snapshot');
  const normalInput = normalResponse.request().postDataJSON();
  const normal = await normalResponse.json();
  await page.waitForFunction(() => document.querySelector('[data-department-status]')?.textContent.includes('сохранена и повторно загружена'));
  assert.equal(normal.revisionNo, 1);
  assert.equal(normal.mappings[0].productName, 'Payroll mapping product', 'product name snapshot is loaded from the server-owned venue catalog');
  assert.equal((await client.query('SELECT count(*)::int AS count FROM payroll_product_department_mappings WHERE revision_id=$1', [normal.id])).rows[0].count, 1,
    'owner UI save is persisted in PostgreSQL');
  const normalReadback = await service.getProductDepartmentRevision(owner, normal.id);
  assert.equal(normalReadback.payloadSha256, normal.payloadSha256);
  assert.equal(normalReadback.mappings[0].departmentCode, 'bar');
  const replay = await service.writeProductDepartmentRevision(owner, normalInput);
  assert.equal(replay.id, normal.id);
  assert.equal(replay.replayed, true);
  await assert.rejects(service.writeProductDepartmentRevision(owner, { ...normalInput,
    mappings: [{ productId, departmentCode: 'hookah', departmentName: 'Кальян' }] }),
  error => error.code === 'payroll_product_department_idempotency_conflict' && error.status === 409);
  await assert.rejects(service.writeProductDepartmentRevision(owner, { ...normalInput, idempotencyKey: 'department-api:stale-qa-001' }),
  error => error.code === 'payroll_product_department_revision_conflict' && error.status === 409);
  await assert.rejects(service.writeProductDepartmentRevision(owner, { ...normalInput, idempotencyKey: 'department-api:foreign-qa-001',
    expectedRevisionId: normal.id, mappings: [{ productId: foreignProductId, departmentCode: 'bar', departmentName: 'Бар' }] }),
  error => error.code === 'payroll_product_department_product_invalid' && error.status === 400);
  await assert.rejects(service.getProductDepartmentMappings(manager),
  error => error.code === 'payroll_scheme_owner_only' && error.status === 403);
  await assert.rejects(service.getProductDepartmentRevision(foreignOwner, normal.id),
  error => error.code === 'payroll_product_department_revision_not_found' && error.status === 404);

  const localToday = (await client.query("SELECT (transaction_timestamp() AT TIME ZONE 'Asia/Yekaterinburg')::date::text AS day")).rows[0].day;
  await panel.locator('[data-department-history-details] summary').click();
  await panel.locator(`[data-department-inspect="${normal.id}"]`).click();
  await panel.locator('[data-department-inspected-details]').waitFor({ state: 'visible' });
  await panel.locator('[data-department-retro]').click();
  await panel.locator('[data-department-retro-date]').fill(localToday);
  await panel.locator('[data-department-retro-reason]').fill('Owner confirmed historic department correction');
  await panel.locator('[data-department-attestation]').check();
  await panel.locator('[data-department-reason]').fill('Correct historical product classification');
  await panel.locator('[data-map-code]').fill('hookah');
  await panel.locator('[data-map-name]').fill('Кальян');
  const retroResponsePromise = page.waitForResponse(response => response.url().endsWith('/api/payroll/product-department-mappings/retroactive-revisions')
    && response.request().method() === 'POST');
  await panel.locator('[data-department-save]').click();
  const retroResponse = await retroResponsePromise;
  assert.equal(retroResponse.status(), 201, 'owner UI posts a separately attested retroactive snapshot');
  const retroInput = retroResponse.request().postDataJSON();
  const retro = await retroResponse.json();
  await page.waitForFunction(() => document.querySelector('[data-department-status]')?.textContent.includes('сохранена и повторно загружена'));
  assert.equal((await client.query('SELECT count(*)::int AS count FROM payroll_product_department_mappings WHERE revision_id=$1', [retro.id])).rows[0].count, 1,
    'retroactive UI write persists its full snapshot');
  const replayFromService = await service.writeProductDepartmentRevision(owner, { ...retroInput,
    mappings: retroInput.mappings.map(mapping => ({ ...mapping, productName: 'Renamed client value' })) }, true);
  assert.equal(replayFromService.id, retro.id);
  assert.equal(replayFromService.replayed, true);

  const directRetroInput = { expectedRevisionId: retro.id, idempotencyKey: 'department-api:retro-direct-qa-001',
    reason: 'Correct historical product classification', effectiveFrom: localToday,
    retroactiveReason: 'Owner confirmed historic department correction',
    ownerAttestation: { confirmed: true, action: 'retroactive_payroll_product_department_mapping' },
    mappings: [{ productId, productName: 'Client supplied stale name', departmentCode: 'hookah', departmentName: 'Кальян',
      effectiveFrom: localToday, effectiveTo: null }] };
  const directRetro = await service.writeProductDepartmentRevision(owner, directRetroInput, true);
  assert.equal(directRetro.retroactiveAttested, true);
  assert.equal(directRetro.mappings[0].productName, 'Payroll mapping product', 'retroactive snapshot canonicalizes the product name from the venue catalog');
  const retroReplay = await service.writeProductDepartmentRevision(owner, directRetroInput, true);
  assert.equal(retroReplay.id, directRetro.id);
  assert.equal(retroReplay.replayed, true, 'retroactive replay ignores client product name because it is server-derived');
  await assert.rejects(service.writeProductDepartmentRevision(owner, { ...directRetroInput, idempotencyKey: 'department-api:retro-no-attestation',
    ownerAttestation: null }, true), error => error.status === 400);
  const oldRevision = await service.getProductDepartmentRevision(owner, normal.id);
  assert.equal(oldRevision.mappings[0].departmentCode, 'bar', 'retroactive revision never mutates the prior snapshot');
  const after = await client.query('SELECT (SELECT count(*)::int FROM payroll_entries) AS entries,(SELECT count(*)::int FROM expenses) AS expenses,(SELECT count(*)::int FROM payroll_calculation_runs) AS runs');
  assert.deepEqual(after.rows[0], baseline.rows[0], 'mapping version writes do not create payroll runs, entries or expenses');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await panel.evaluate(node => node.scrollWidth <= node.clientWidth), true, 'payroll mapping panel fits a mobile viewport without horizontal overflow');
  console.log('PASS payroll-product-department-api-postgres-qa.mjs');
} finally {
  if (browser) await browser.close();
  if (server && server.exitCode === null && server.signalCode === null) {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else server.kill('SIGTERM');
  }
  if (pool) await pool.end();
  if (created) await client.query(`DROP SCHEMA "${schema}" CASCADE`);
  await client.end();
}
