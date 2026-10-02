import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ui = fs.readFileSync(path.join(root, 'payroll-scheme-ui.js'), 'utf8');
const distUi = fs.readFileSync(path.join(root, 'dist', 'payroll-scheme-ui.js'), 'utf8');
const finance = fs.readFileSync(path.join(root, 'finance.html'), 'utf8');
const distFinance = fs.readFileSync(path.join(root, 'dist', 'finance.html'), 'utf8');
const sync = fs.readFileSync(path.join(root, 'scripts', 'sync-published-assets.mjs'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

assert.equal(ui, distUi, 'published UI asset matches the source');
assert.match(finance, /payroll-scheme-ui\.js\?rev=1/, 'finance source loads the owner payroll UI');
assert.match(distFinance, /payroll-scheme-ui\.js\?rev=1/, 'published finance page loads the owner payroll UI');
assert.match(sync, /payrollSchemeUiRevision = '1'/, 'asset revision is managed by the publish sync');
assert.ok(sync.includes(String.raw`payroll-scheme-ui\.js\?rev=\d+`), 'publish sync updates the payroll UI cache revision');
assert.match(sync, /cpSync\(resolve\(root, 'payroll-scheme-ui\.js'\), resolve\(root, 'dist', 'payroll-scheme-ui\.js'\)\)/,
  'publish sync copies the payroll UI source into dist');
assert.match(server, /'\/payroll-scheme-ui\.js'/, 'local server explicitly allows the payroll UI asset');
assert.match(ui, /sessionUser\.role !== 'owner'/, 'non-owner browser sessions receive no payroll scheme UI');
assert.match(ui, /document\.querySelector\('\.finance-payroll-panel'\)/, 'scheme UI stays inside the existing finance payroll page');
assert.ok(ui.includes('/api/payroll/schemes'),
  'owner UI reads and creates versioned schemes through the payroll API');
for (const pathPart of ['/versions/${encodeURIComponent(versionId)}', '/activate', '/revisions', '/preview', '/api/payroll/compare']) {
  assert.ok(ui.includes(pathPart), `owner UI supports ${pathPart}`);
}
assert.match(ui, /manual-scenario|Сценарный расчёт/, 'scenario preview is visibly separated from production data');
assert.ok(ui.includes('не является официальным расчётом'), 'preview is described as non-official');
assert.match(ui, /не создаёт расчётный run, начисление или расход/, 'UI explains that scenario preview has no financial side effects');
assert.match(ui, /roleAssignments: \[\], employeeOverrides: \[\], itemRules: \[\]/,
  'owner can configure assignments, employee overrides and item rules');
assert.match(ui, /data-scheme-definition/, 'owner can edit the complete versioned configuration');
assert.match(ui, /data-scheme-compare-version/, 'owner can select versions for comparison');
assert.equal(['/api/payroll/entries', '/api/expenses', '/api/orders', '/api/loyalty'].some((pathPart) => ui.includes(pathPart)), false,
  'scheme configuration UI never mutates existing payroll, expense, order or loyalty data');

console.log('PAYROLL SCHEME UI CONTRACT: PASS (owner-only finance mount, published asset, version config, audit and scenario UI)');
