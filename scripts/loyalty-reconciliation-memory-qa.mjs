import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const child = spawn(process.execPath, ['server.js'], {
  cwd: root,
  windowsHide: true,
  env: { ...process.env, HOST: '127.0.0.1', PORT: '0', DATABASE_URL: '', AUTH_REQUIRED: 'true', DEMO_ADMIN_PASSWORD: 'qa-admin', DEMO_STAFF_PASSWORD: 'qa-staff' },
  stdio: ['ignore', 'pipe', 'pipe']
});
let output = '';
child.stdout.on('data', (chunk) => { output += String(chunk); });
child.stderr.on('data', (chunk) => { output += String(chunk); });
const baseUrl = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`isolated memory server did not start: ${output}`)), 15000);
  child.once('error', reject);
  child.once('exit', (code) => reject(new Error(`isolated memory server exited (${code}): ${output}`)));
  child.stdout.on('data', (chunk) => {
    const match = String(chunk).match(/CRM running on http:\/\/localhost:(\d+)/);
    if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); }
  });
});
let token = '';
const call = async (route, method = 'GET', body) => {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  return { status: response.status, data: await response.json() };
};
const expect = (result, status, error) => {
  assert.equal(result.status, status, JSON.stringify(result));
  if (error) assert.equal(result.data.error, error);
  return result.data;
};
try {
  expect(await call('/api/loyalty/reconciliation'), 401);
  token = expect(await call('/api/login', 'POST', { username: 'admin', password: 'qa-admin' }), 200).token;
  const report = expect(await call('/api/loyalty/reconciliation'), 200);
  assert.equal(report.period.timeZone, 'Asia/Yekaterinburg');
  assert.match(report.period.from, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(report.period.to, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(report.legacyReservations, []);
  assert.equal(report.periodBusiness.sales.orders,0);assert.equal(report.periodBusiness.sales.gross,0,'memory can confirm an empty supported sales period');assert.deepEqual(report.periodBusiness.receipts.byMethod,{});assert.equal(report.periodBusiness.payouts.byMethod,null,'unsupported payout source is unknown, not zero');assert.equal(report.balances.bonus.outstandingClawback,null);assert.equal(report.deposit.externalRefund,null);assert.equal(report.balances.reservationPrepayment.verifiedCounterMismatchCount,0);assert.equal(report.coverage.complete,false);
  expect(await call('/api/loyalty/reconciliation?from=2026-02-30'), 400, 'invalid_reconciliation_date');
  token = expect(await call('/api/login', 'POST', { username: 'staff', password: 'qa-staff' }), 200).token;
  expect(await call('/api/loyalty/reconciliation'), 403, 'forbidden');
  console.log('LOYALTY RECONCILIATION MEMORY QA: PASS (timezone/default period, true zero vs unknown, empty ledger, auth/RBAC, invalid date)');
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit'); child.kill(); await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
  }
}
