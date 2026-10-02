import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../portal.js', import.meta.url), 'utf8');
const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../style.css', import.meta.url), 'utf8');

assert.match(source, /const payrollStatusLabel = \(status\) => \(\{ draft: 'Черновик', approved: 'Утверждено', paid: 'Выплачено', cancelled: 'Отменено' \}\[String\(status \|\| ''\)\.toLowerCase\(\)\] \|\| 'Требует проверки'\);/, 'known payroll statuses have Russian labels and unknown values have a safe fallback');
assert.ok(source.includes('статус: ${esc(payrollStatusLabel(item.payrollStatus))}'), 'expense journal renders the localized payroll status rather than the raw API value');
assert.doesNotMatch(source, /статус: \$\{esc\(item\.payrollStatus \|\| 'проверить'\)\}/, 'the old raw-status rendering has been removed');
assert.match(server, /e\.source <> 'purchase' AND e\.source <> 'payroll'/, 'payroll expenses are represented by payroll entries exactly once');
assert.match(server, /pe\.status IN \('approved','paid'\).*pe\.period_from <= \$3::date/, 'approved and paid payroll entries accrue once while linked expenses remain cash-only');
assert.match(styles, /\.velora-theme \.empty a\{color:#ffb08f;font-weight:700/, 'empty-state links have an explicit visible color');
assert.match(styles, /\.velora-theme \.empty a:focus-visible\{outline:2px solid #ffb08f/, 'empty-state links expose a keyboard focus indicator');

console.log('FINANCE EXPENSE PAYROLL STATUS CONTRACT: PASS (localized status labels, safe fallback, visible empty-state links)');
