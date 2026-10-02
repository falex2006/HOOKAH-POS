import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../portal.js', import.meta.url), 'utf8');
const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../style.css', import.meta.url), 'utf8');

assert.match(source, /const payrollStatusLabel = \(status\) => \(\{ draft: 'Черновик', approved: 'Утверждено', paid: 'Выплачено', cancelled: 'Отменено' \}\[String\(status \|\| ''\)\.toLowerCase\(\)\] \|\| 'Требует проверки'\);/, 'known payroll statuses have Russian labels and unknown values have a safe fallback');
assert.ok(source.includes('статус: ${esc(payrollStatusLabel(item.payrollStatus))}'), 'expense journal renders the localized payroll status rather than the raw API value');
assert.doesNotMatch(source, /статус: \$\{esc\(item\.payrollStatus \|\| 'проверить'\)\}/, 'the old raw-status rendering has been removed');
assert.match(server, /e\.source <> 'purchase' AND \(e\.source <> 'payroll' OR EXISTS \(SELECT 1 FROM payroll_entries pe WHERE pe\.venue_id=e\.venue_id AND pe\.expense_id=e\.id AND pe\.status='paid'\)\)/, 'linked paid payroll expenses are included exactly once');
assert.match(server, /pe\.status='paid' AND pe\.expense_id IS NULL/, 'unlinked payroll rows are only counted after payment and never alongside a linked expense');
assert.doesNotMatch(server, /pe\.status IN \('approved','paid'\).*pe\.period_from <= \$3::date/, 'approved payroll obligations are not reported as factual expenses');
assert.match(styles, /\.velora-theme \.empty a\{color:#ffb08f;font-weight:700/, 'empty-state links have an explicit visible color');
assert.match(styles, /\.velora-theme \.empty a:focus-visible\{outline:2px solid #ffb08f/, 'empty-state links expose a keyboard focus indicator');

console.log('FINANCE EXPENSE PAYROLL STATUS CONTRACT: PASS (localized status labels, safe fallback, visible empty-state links)');
