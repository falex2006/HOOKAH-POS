import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { validateQaDatabaseUrl, assertQaDatabaseIdentity } from './postgres-qa-safety.mjs';

const databaseUrl = process.env.MIGRATIONS_PG_TEST_DATABASE_URL;
const target = validateQaDatabaseUrl(databaseUrl, 'MIGRATIONS_PG_TEST_DATABASE_URL');
assert.equal(target.database, 'territory_qa');
const playwrightPath = process.env.PLAYWRIGHT_PACKAGE_PATH;
if (!playwrightPath) throw new Error('Set PLAYWRIGHT_PACKAGE_PATH');
const require = createRequire(import.meta.url);
const { Client } = require('pg');
const { chromium } = require(playwrightPath);
const db = new Client({ connectionString: databaseUrl });
const now = new Date();
const previousMonthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
const periodTo = previousMonthEnd.toISOString().slice(0, 10);
const periodFrom = `${periodTo.slice(0, 7)}-01`;
const workDate = `${periodTo.slice(0, 7)}-15`;
let browser;
let child;
let venueId;
try {
  await db.connect();
  const identity = (await db.query('SELECT current_database() AS database, inet_server_addr() AS address, inet_server_port() AS port, (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser')).rows[0];
  assertQaDatabaseIdentity(identity, target.database, Number(target.url.port), 'Payroll browser QA database');
  venueId = (await db.query("INSERT INTO venues (name,timezone) VALUES ('Isolated payroll browser QA','Asia/Yekaterinburg') RETURNING id")).rows[0].id;
  const employeeId = (await db.query(`INSERT INTO users (venue_id,full_name,login,role) VALUES ($1,'Payroll browser employee',$2,'bartender') RETURNING id`, [venueId, `payroll-browser-${process.pid}`])).rows[0].id;
  const ruleId = (await db.query("INSERT INTO payroll_rules (venue_id,name,rule_type,rate) VALUES ($1,'QA hourly browser','hourly',500) RETURNING id", [venueId])).rows[0].id;
  await db.query("INSERT INTO staff_work_logs (venue_id,user_id,started_at,ended_at,source) VALUES ($1,$2,$3,$4,'manual')", [venueId, employeeId, `${workDate}T05:00:00Z`, `${workDate}T13:00:00Z`]);
  child = spawn(process.execPath, ['server.js'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), windowsHide: true,
    env: { ...process.env, DATABASE_URL: databaseUrl, VENUE_ID: venueId, AUTH_REQUIRED: 'false', DEMO_MODE: 'false', NODE_ENV: 'test', HOST: '127.0.0.1', PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Payroll QA server did not start: ${output}`)), 15000);
    child.once('error', reject);
    child.stdout.on('data', () => { const match = output.match(/CRM running on http:\/\/localhost:(\d+)/); if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); } });
  });
  const health = await (await fetch(`${base}/api/health`)).json();
  assert.equal(health.database, 'postgres');
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 375, height: 812 }, locale: 'ru-RU' });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${base}/login`, { waitUntil: 'networkidle' });
  await page.locator('#login-username').fill('admin');
  await page.locator('#login-password').fill('admin');
  await page.locator('#login-form button[type="submit"]').click();
  await page.waitForURL((url) => !url.pathname.includes('/login'));
  await page.goto(`${base}/finance`, { waitUntil: 'networkidle' });
  await page.locator('#payroll-create-toggle').click();
  await page.locator('#payroll-create-user').selectOption(employeeId);
  await page.locator('#payroll-create-rule').selectOption(ruleId);
  await page.locator('#payroll-create-from').fill(periodFrom);
  await page.locator('#payroll-create-to').fill(periodTo);
  await page.locator('#payroll-create-form button[type="submit"]').click();
  await page.waitForFunction(() => document.querySelector('[data-payroll-action="approve"]') !== null);
  await page.locator('#payroll-create-form').waitFor({ state: 'hidden' });
  const drafted = (await db.query('SELECT id,status,amount FROM payroll_entries WHERE venue_id=$1', [venueId])).rows;
  assert.equal(drafted.length, 1);
  assert.equal(drafted[0].status, 'draft');
  assert.equal(Number(drafted[0].amount), 4000);
  await page.locator('[data-payroll-action="approve"]').click();
  await page.waitForFunction(() => document.querySelector('[data-payroll-action="pay"]') !== null);
  assert.equal((await db.query('SELECT status FROM payroll_entries WHERE id=$1', [drafted[0].id])).rows[0].status, 'approved');
  await page.locator(`[data-payroll-payment-date="${drafted[0].id}"]`).fill(periodTo);
  await page.locator('[data-payroll-action="pay"]').click();
  await page.waitForFunction((id) => document.querySelector(`[data-entry="${id}"]`) === null && document.querySelector('#payroll-register .badge')?.textContent?.includes('Выплачено'), drafted[0].id);
  const saved = (await db.query("SELECT pe.status,pe.expense_id,e.amount,e.source,to_char(e.expense_date,'YYYY-MM-DD') AS expense_date FROM payroll_entries pe JOIN expenses e ON e.id=pe.expense_id WHERE pe.id=$1", [drafted[0].id])).rows;
  assert.equal(saved.length, 1);
  assert.equal(saved[0].status, 'paid');
  assert.equal(Number(saved[0].amount), 4000);
  assert.equal(saved[0].source, 'payroll');
  assert.equal(saved[0].expense_date, periodTo);
  assert.doesNotMatch(await page.locator('.finance-payroll-panel').textContent(), /Черновик начисления сохранён/, 'paid state does not retain the earlier draft notice');
  for (const width of [320, 375, 768, 1440, 2560]) {
    await page.setViewportSize({ width, height: 800 });
    const overflow = await page.evaluate(() => {
      const main = document.querySelector('.portal-main');
      const panel = document.querySelector('.finance-payroll-panel');
      return document.documentElement.scrollWidth > innerWidth + 1 || main.scrollWidth > main.clientWidth + 1 || panel.scrollWidth > panel.clientWidth + 1;
    });
    assert.equal(overflow, false, `payroll horizontal overflow at ${width}px`);
    assert.match(await page.locator('#payroll-register').textContent(), /Выплачено/);
    if ([320, 768, 1440].includes(width)) {
      const outputDir = path.resolve('docs/ai-team/responsive-emulator');
      await mkdir(outputDir, { recursive: true });
      await page.locator('.finance-payroll-panel').screenshot({ path: path.join(outputDir, `payroll-paid-${width}.png`) });
    }
  }
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('#payroll-filter-from').fill(periodFrom);
  await page.locator('#payroll-filter-to').fill(periodTo);
  await page.locator('#payroll-reload').click();
  await page.waitForFunction(() => document.querySelector('#payroll-register')?.textContent?.includes('Выплачено'));
  const cancelMonthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 0));
  const cancelTo = cancelMonthEnd.toISOString().slice(0, 10);
  const cancelFrom = `${cancelTo.slice(0, 7)}-01`;
  await page.locator('#payroll-create-toggle').click();
  await page.locator('#payroll-create-user').selectOption(employeeId);
  await page.locator('#payroll-create-rule').selectOption(ruleId);
  await page.locator('#payroll-create-from').fill(cancelFrom);
  await page.locator('#payroll-create-to').fill(cancelTo);
  await page.locator('#payroll-create-form button[type="submit"]').click();
  await page.waitForFunction(() => document.querySelector('[data-payroll-action="approve"]') !== null);
  const cancelDraft = (await db.query("SELECT id,status FROM payroll_entries WHERE venue_id=$1 AND period_from=$2::date", [venueId, cancelFrom])).rows[0];
  assert.equal(cancelDraft.status, 'draft');
  await page.locator(`[data-payroll-cancel-open="${cancelDraft.id}"]`).click();
  await page.locator(`[data-payroll-cancel-editor="${cancelDraft.id}"] textarea`).fill('ab');
  await page.locator(`[data-payroll-cancel-editor="${cancelDraft.id}"] button[type="submit"]`).click();
  assert.match(await page.locator(`[data-payroll-cancel-editor="${cancelDraft.id}"]`).textContent(), /от 3 до 500 символов/);
  assert.equal((await db.query('SELECT status FROM payroll_entries WHERE id=$1', [cancelDraft.id])).rows[0].status, 'draft');
  await page.locator(`[data-payroll-cancel-editor="${cancelDraft.id}"] textarea`).fill('QA browser cancellation');
  let releaseFailedPatch;
  const failedPatchGate = new Promise((resolve) => { releaseFailedPatch = resolve; });
  await page.route(`**/api/payroll/entries/${cancelDraft.id}`, async (route) => { await failedPatchGate; await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'qa_save_failed' }) }); }, { times: 1 });
  await page.locator(`[data-payroll-cancel-editor="${cancelDraft.id}"] button[type="submit"]`).click();
  const cancelClose = page.locator(`[data-payroll-cancel-close="${cancelDraft.id}"]`);
  await page.waitForFunction((id) => document.querySelector(`[data-payroll-cancel-close="${id}"]`)?.disabled === true, cancelDraft.id);
  await cancelClose.evaluate((button) => button.click());
  assert.equal(await page.locator(`[data-payroll-cancel-editor="${cancelDraft.id}"]`).isVisible(), true, 'pending PATCH keeps cancellation editor open');
  assert.equal(await page.locator(`[data-payroll-cancel-editor="${cancelDraft.id}"] textarea`).inputValue(), 'QA browser cancellation', 'pending PATCH preserves reason');
  releaseFailedPatch();
  await page.waitForFunction(() => document.querySelector('#payroll-message')?.textContent?.includes('Не удалось изменить начисление'));
  assert.equal((await db.query('SELECT status FROM payroll_entries WHERE id=$1', [cancelDraft.id])).rows[0].status, 'draft', 'failed PATCH leaves draft intact');
  await page.locator(`[data-payroll-cancel-editor="${cancelDraft.id}"] button[type="submit"]`).click();
  await page.waitForFunction(() => document.querySelector('#payroll-register')?.textContent?.includes('Отменено'));
  const cancelled = (await db.query('SELECT status,cancellation_reason,cancelled_at,expense_id FROM payroll_entries WHERE id=$1', [cancelDraft.id])).rows[0];
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.cancellation_reason, 'QA browser cancellation');
  assert.ok(cancelled.cancelled_at, 'cancellation timestamp persisted');
  assert.equal(cancelled.expense_id, null, 'cancelled draft has no salary expense');
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('#payroll-filter-from').fill(cancelFrom);
  await page.locator('#payroll-filter-to').fill(cancelTo);
  await page.locator('#payroll-reload').click();
  await page.waitForFunction(() => document.querySelector('#payroll-register')?.textContent?.includes('Отменено'));
  const approvedMonthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 0));
  const approvedTo = approvedMonthEnd.toISOString().slice(0, 10);
  const approvedFrom = `${approvedTo.slice(0, 7)}-01`;
  await page.locator('#payroll-create-toggle').click();
  await page.locator('#payroll-create-user').selectOption(employeeId);
  await page.locator('#payroll-create-rule').selectOption(ruleId);
  await page.locator('#payroll-create-from').fill(approvedFrom);
  await page.locator('#payroll-create-to').fill(approvedTo);
  await page.locator('#payroll-create-form button[type="submit"]').click();
  await page.locator('[data-payroll-action="approve"]').waitFor();
  const approvedCandidate = (await db.query('SELECT id,status FROM payroll_entries WHERE venue_id=$1 AND period_from=$2::date', [venueId, approvedFrom])).rows[0];
  assert.equal(approvedCandidate.status, 'draft');
  await page.locator(`[data-payroll-action="approve"][data-entry="${approvedCandidate.id}"]`).click();
  await page.locator(`[data-payroll-action="pay"][data-entry="${approvedCandidate.id}"]`).waitFor();
  await page.locator(`[data-payroll-cancel-open="${approvedCandidate.id}"]`).click();
  await page.locator(`[data-payroll-cancel-editor="${approvedCandidate.id}"] textarea`).fill('QA approved cancellation');
  await page.locator(`[data-payroll-cancel-editor="${approvedCandidate.id}"] button[type="submit"]`).click();
  await page.waitForFunction((id) => !document.querySelector(`[data-payroll-cancel-open="${id}"]`) && document.querySelector('#payroll-register')?.textContent?.includes('Отменено'), approvedCandidate.id);
  const approvedCancelled = (await db.query('SELECT status,cancellation_reason,approved_at,cancelled_at,paid_at,payment_date,expense_id FROM payroll_entries WHERE id=$1', [approvedCandidate.id])).rows[0];
  assert.equal(approvedCancelled.status, 'cancelled');
  assert.equal(approvedCancelled.cancellation_reason, 'QA approved cancellation');
  assert.ok(approvedCancelled.approved_at, 'approval history remains visible in database');
  assert.ok(approvedCancelled.cancelled_at);
  assert.equal(approvedCancelled.paid_at, null);
  assert.equal(approvedCancelled.payment_date, null);
  assert.equal(approvedCancelled.expense_id, null, 'approved cancellation creates no payout expense');
  assert.equal((await db.query("SELECT count(*)::int AS total FROM expenses WHERE venue_id=$1 AND source='payroll'", [venueId])).rows[0].total, 1, 'only the paid entry created a salary expense');
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('#payroll-filter-from').fill(approvedFrom);
  await page.locator('#payroll-filter-to').fill(approvedTo);
  await page.locator('#payroll-reload').click();
  await page.waitForFunction(() => document.querySelector('#payroll-register')?.textContent?.includes('Отменено'));
  await page.setViewportSize({ width: 320, height: 800 });
  await page.waitForFunction(() => {
    const sidebar = document.querySelector('.portal-sidebar');
    const main = document.querySelector('.portal-main');
    return !sidebar.classList.contains('is-expanded') && sidebar.getBoundingClientRect().right <= 1 && !main.inert;
  });
  assert.equal(await page.locator('.finance-payroll-panel').evaluate((panel) => panel.scrollWidth > panel.clientWidth + 1), false, 'cancelled payroll row fits 320px');
  await page.locator('.finance-payroll-panel').screenshot({ path: path.resolve('docs/ai-team/responsive-emulator/payroll-cancelled-320.png') });
  assert.deepEqual(errors.filter((message) => !message.includes('ViewTransition opt-in disabled')), [], 'no application page errors');
  console.log('PAYROLL BROWSER POSTGRES QA: PASS (create → approve → pay/cancel draft/cancel approved, failed PATCH retry, SQL reread, 5 widths)');
} finally {
  await browser?.close();
  if (child) { child.kill(); if (child.exitCode === null) await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 3000))]); }
  if (db._connected) {
    const cleanupErrors = [];
    try {
      if (venueId) {
        for (const table of ['expenses', 'payroll_entries', 'staff_work_logs', 'payroll_rules', 'audit_events', 'users']) {
          try { await db.query(`DELETE FROM ${table} WHERE venue_id=$1`, [venueId]); }
          catch (error) { cleanupErrors.push(new Error(`${table}: ${error.message}`)); }
        }
        try { await db.query("DELETE FROM venues WHERE id=$1 AND name='Isolated payroll browser QA'", [venueId]); }
        catch (error) { cleanupErrors.push(new Error(`venues: ${error.message}`)); }
        const remaining = await db.query('SELECT 1 FROM venues WHERE id=$1', [venueId]);
        if (remaining.rows.length) cleanupErrors.push(new Error(`QA venue ${venueId} was not removed`));
      }
    } finally {
      await db.end();
    }
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Payroll browser QA cleanup failed');
  }
}
