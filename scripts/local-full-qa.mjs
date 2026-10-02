import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

// Reviewed allowlists. New tests require explicit review; live/browser scripts are never discovered.
const staticTests = [
  "admin-section-heading-contract.mjs",
  "ai-team-contract.mjs",
  "auth-smoke-crop-contract.mjs",
  "auth-smoke-lifecycle-runtime-qa.mjs",
  "auth-smoke-runtime-qa.mjs",
  "auto-order-pending-qa.mjs",
  "brand-kit-contract.mjs",
  "client-form-race-qa.mjs",
  "client-form-submit-qa.mjs",
  "client-history-date-qa.mjs",
  "clients-editor-contract.mjs",
  "custom-select-groups-qa.mjs",
  "dashboard-greeting-contract.mjs",
  "dashboard-kpi-design-contract.mjs",
  "dashboard-overnight-employee-demo-qa.mjs",
  "dashboard-overnight-employee-memory-qa.mjs",
  "dashboard-shift-attribution-contract.mjs",
  "dashboard-shift-deeplink-contract.mjs",
  "delivery-ui-state-qa.mjs",
  "demo-premix-unit-runtime-qa.mjs",
  "demo-scenario-contract.mjs",
  "directory-rename-runtime-qa.mjs",
  "discount-groups-demo-qa.mjs",
  "loyalty-promotions-contract.mjs",
  "loyalty-pricing-qa.mjs",
  "final-acceptance-matrix-contract.mjs",
  "finance-api-consistency-contract.mjs",
  "finance-categories-ui-contract.mjs",
  "finance-chart-empty-state-contract.mjs",
  "finance-employee-contract.mjs",
  "finance-expense-payroll-status-contract.mjs",
  "finance-load-race-qa.mjs",
  "finance-report-date-qa.mjs",
  "finance-required-marker-contract.mjs",
  "finance-timezone-contract.mjs",
  "header-shell-contract.mjs",
  "hookah-additional-acceptance-contract.mjs",
  "integrations-scope-contract.mjs",
  "integrations-state-qa.mjs",
  "inventory-context-contract.mjs",
  "inventory-critical-state-qa.mjs",
  "inventory-form-pending-qa.mjs",
  "inventory-hierarchy-contract.mjs",
  "inventory-movement-transaction-qa.mjs",
  "inventory-premix-load-state-qa.mjs",
  "inventory-stock-status-qa.mjs",
  "inventory-subdepartment-api-qa.mjs",
  "local-click-contract.mjs",
  "local-date-contract.mjs",
  "local-design-contract.mjs",
  "local-insights-contract.mjs",
  "local-lock-contract.mjs",
  "local-preferences-contract.mjs",
  "local-role-contract.mjs",
  "local-schedule-validation-qa.mjs",
  "login-error-runtime-qa.mjs",
  "login-server-identity-runtime-qa.mjs",
  "loyalty-program-pending-qa.mjs",
  "loyalty-pos-explanation-contract.mjs",
  "metrics-database-failclosed-contract.mjs",
  "migrations-contract.mjs",
  "mode-navigation-contract.mjs",
  "network-action-pending-qa.mjs",
  "network-load-state-qa.mjs",
  "order-attention-qa.mjs",
  "order-close-transaction-qa.mjs",
  "order-item-close-guard-qa.mjs",
  "order-journal-display-contract.mjs",
  "orders-history-qa.mjs",
  "orders-receipt-qa.mjs",
  "orders-total-qa.mjs",
  "paid-order-balance-demo-qa.mjs",
  "payroll-calculation-qa.mjs",
  "payroll-lifecycle-runtime-qa.mjs",
  "payroll-register-load-state-qa.mjs",
  "payroll-register-ui-contract.mjs",
  "platform-saas-contract.mjs",
  "portal-action-keyboard-qa.mjs",
  "portal-api-auth-qa.mjs",
  "portal-context-refresh-qa.mjs",
  "pos-modal-a11y-contract.mjs",
  "premix-batch-lifecycle-qa.mjs",
  "premix-contract.mjs",
  "premix-create-route-qa.mjs",
  "premix-submit-pending-qa.mjs",
  "product-form-pending-qa.mjs",
  "purchase-document-date-contract.mjs",
  "purchase-document-pending-qa.mjs",
  "purchase-document-validation-qa.mjs",
  "purchase-documents-contract.mjs",
  "purchase-payment-api-validation-qa.mjs",
  "purchase-payments-runtime-qa.mjs",
  "recipe-chain-contract-qa.mjs",
  "recipe-depletion-pg-contract.mjs",
  "recipe-form-pending-qa.mjs",
  "reservation-form-qa.mjs",
  "session-venue-contract.mjs",
  "shift-close-ui-qa.mjs",
  "shift-state-runtime-qa.mjs",
  "shift-transaction-qa.mjs",
  "sidebar-brand-contract.mjs",
  "sidebar-navigation-contract.mjs",
  "sidebar-scrollbar-contract.mjs",
  "sidebar-disclosure-runtime-qa.mjs",
  "sidebar-venue-header-contract.mjs",
  "site-structure-contract.mjs",
  "staff-active-count-contract.mjs",
  "staff-catalog-add-pending-qa.mjs",
  "staff-catalog-load-state-contract.mjs",
  "staff-guests-page-contract.mjs",
  "staff-header-actions-runtime-qa.mjs",
  "staff-mode-navigation-contract.mjs",
  "staff-observer-stability-runtime-qa.mjs",
  "staff-partial-payment-pending-qa.mjs",
  "staff-pin-passport-contract.mjs",
  "staff-session-recovery-runtime-qa.mjs",
  "staff-worklog-runtime-qa.mjs",
  "task-deadline-qa.mjs",
  "task-ui-recovery-qa.mjs",
  "tobacco-catalog-demo-qa.mjs",
  "trusted-pin-return-contract.mjs",
  "ui-scenarios-contract.mjs",
  "visual-live-defects-contract.mjs",
  "visual-page-rules-contract.mjs",
  "session-authority-qa.mjs"
];
const memoryTests = [
  "discount-groups-memory-qa.mjs",
  "loyalty-promotions-memory-qa.mjs",
  "loyalty-reconciliation-memory-qa.mjs",
  "guest-account-ledger-memory-qa.mjs",
  "finance-rbac-runtime-qa.mjs",
  "local-static-boundary.mjs",
  "notifications-api-qa.mjs",
  "order-delete-qa.mjs",
  "order-journal-table-memory-qa.mjs",
  "paid-order-balance-memory-qa.mjs",
  "recipe-depletion-runtime-qa.mjs",
  "role-api-matrix-runtime-qa.mjs",
  "security-default-credential-qa.mjs",
  "security-qa.mjs",
  "session-preferences-concurrency-qa.mjs",
  "staff-pin-passport-runtime-qa.mjs",
  "tasks-qa.mjs",
  "tobacco-catalog-api-qa.mjs",
  "trusted-pin-return-runtime-qa.mjs",
  "venue-timezone-validation-runtime-qa.mjs"
];
const postgresTests = [
  'payroll-lifecycle-migration-preflight.mjs', 'migrations-pg-upgrade-qa.mjs',
  'migrations-pg-runtime-qa.mjs', 'migrations-pg-041-recovery-concurrency-qa.mjs',
  'venue-inventory-departments-postgres-qa.mjs', 'purchase-payment-postgres-api-qa.mjs',
  'guest-loyalty-postgres-api-qa.mjs', 'finance-categories-postgres-api-qa.mjs',
  'loyalty-promotions-postgres-qa.mjs',
  'reservation-prepayment-postgres-qa.mjs',
  'payroll-lifecycle-postgres-api-qa.mjs', 'tasks-postgres-e2e-qa.mjs', 'delivery-persistence-qa.mjs',
  'finance-employee-postgres-qa.mjs', 'shift-cash-postgres-e2e-qa.mjs',
  'finance-shift-analytics-postgres-qa.mjs', 'paid-order-balance-postgres-qa.mjs',
  'recipe-depletion-pg-runtime-qa.mjs',
  'dashboard-pending-metrics-postgres-qa.mjs', 'session-preferences-postgres-qa.mjs',
  'shift-notifications-e2e-qa.mjs', 'notifications-postgres-qa.mjs',
  'purchase-auto-order-postgres-e2e-qa.mjs', 'saas-quota-suspension-postgres-qa.mjs',
  'audit-privacy-postgres-qa.mjs', 'scoped-role-dependencies-postgres-qa.mjs',
  'reservation-local-date-postgres-qa.mjs',
  'staff-identity-postgres-qa.mjs', 'staff-login-race-postgres-qa.mjs',
];
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const folder = path.join(root, 'tmp', 'full-local-qa');
const require = createRequire(import.meta.url);
const { safeText } = require('./local-full-pg-regression.cjs');
const mode = process.argv[2] || '--all';
assert.ok(process.argv.length <= 3, 'Only one runner mode may be supplied');
assert.ok(['--all','--static','--memory','--postgres','--list','--check-guards'].includes(mode), 'Allowed modes: --all, --static, --memory, --postgres, --list, --check-guards');
const groups = {
  static: [...staticTests, 'local-api-read-failure-qa.mjs', 'local-employee-report-ui-qa.mjs', 'local-navigation-state-qa.mjs', 'local-dashboard-navigation-qa.mjs', 'staff-identity-demo-qa.mjs'],
  memory: memoryTests,
  postgres: postgresTests,
};
assert.equal(new Set([...groups.static,...groups.memory,...groups.postgres]).size, groups.static.length+groups.memory.length+groups.postgres.length, 'Duplicate suite names');
for (const name of Object.values(groups).flat()) assert.ok(fs.existsSync(path.join(root,'scripts',name)), 'Missing allowlisted suite: '+name);
if (mode === '--list') {
  console.log(JSON.stringify(groups, null, 2));
  process.exit(0);
}
fs.mkdirSync(folder, { recursive: true });
const lockPath = path.join(folder,'local-full-runner.lock');
const lockId = randomUUID();
try {
  const lock=fs.openSync(lockPath,'wx');
  fs.writeFileSync(lock,JSON.stringify({id:lockId,pid:process.pid}));fs.closeSync(lock);
} catch {
  console.error('LOCAL FULL QA STOPPED: another runner owns the local QA lock; inspect tmp/full-local-qa/local-full-runner.lock');
  process.exit(1);
}
const results = [];
const started = new Date().toISOString();
let fatalError = null;
function killOwnedChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
  else child.kill('SIGTERM');
}
async function run(group, name, args = []) {
  const testArgs = group === 'postgres' ? [path.join(root,'scripts','local-full-pg-regression.cjs'),name] : [path.join(root,'scripts',name),...args];
  const env = { ...process.env, DATABASE_URL:'', NODE_ENV:'test', HOST:'127.0.0.1' };
  // No inherited database endpoints or authentication material reaches memory/VM suites.
  if (group !== 'postgres') for (const key of Object.keys(env)) if (/DATABASE_URL|TEST_DOCKER_CONTAINER|^SAAS_OWNER_|^PG[A-Z_]+$|^(?:AUTH_REQUIRED|DEMO_MODE)$|(?:PASSWORD|TOKEN|PASSPORT_KEY|SESSION_SECRET)$/.test(key)) delete env[key];
  env.DATABASE_URL = '';
  const child = spawn(process.execPath,testArgs,{cwd:root,windowsHide:true,env,stdio:['ignore','pipe','pipe']});
  let output='',timedOut=false;
  child.stdout.on('data',chunk=>{output+=chunk;});child.stderr.on('data',chunk=>{output+=chunk;});
  const timer=setTimeout(()=>{timedOut=true;killOwnedChild(child);},group==='postgres'?16*60_000:90_000);
  let exit;
  try { exit=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);}); }
  finally { clearTimeout(timer); }
  const log='local-full-'+group+'-'+name+'.log';
  fs.writeFileSync(path.join(folder,log),safeText(output,{}));
  results.push({group,test:name,exit,timedOut,log});
  console.log((exit===0&&!timedOut?'PASS ':'FAIL ')+group+' '+name);
  assert.ok(exit===0&&!timedOut,'Stopped at '+name+'; sanitized details: tmp/full-local-qa/'+log);
}
try {
  await run('guard','local-full-pg-regression.cjs',['--check-guards']);
  await run('guard','local-full-qa-setup.cjs',['--check-guards']);
  if (mode !== '--check-guards') for (const [group,names] of Object.entries(groups)) {
    if (mode !== '--all' && mode !== '--'+group) continue;
    for (const name of names) await run(group,name);
  }
} catch (error) {
  fatalError=safeText(error.message,{});
  console.error('LOCAL FULL QA STOPPED: '+safeText(error.message,{}));
  process.exitCode=1;
} finally {
  const summary={started,finished:new Date().toISOString(),mode,ok:!fatalError,error:fatalError,total:results.length,pass:results.filter(x=>x.exit===0&&!x.timedOut).length,failures:results.filter(x=>x.exit!==0||x.timedOut),results};
  fs.writeFileSync(path.join(folder,'local-full-results.json'),JSON.stringify(summary,null,2));
  console.log(JSON.stringify({mode,ok:summary.ok,error:fatalError,total:summary.total,pass:summary.pass,failures:summary.failures.map(x=>x.test)}));
  if (JSON.parse(fs.readFileSync(lockPath,'utf8')).id===lockId) fs.unlinkSync(lockPath);
}
