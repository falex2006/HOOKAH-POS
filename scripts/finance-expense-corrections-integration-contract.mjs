import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const report = readFileSync(new URL('../finance-unified-report.js', import.meta.url), 'utf8');
const expenseModule = readFileSync(new URL('../finance-expense-corrections.js', import.meta.url), 'utf8');
const portal = readFileSync(new URL('../portal.js', import.meta.url), 'utf8');
const publishedPortal = readFileSync(new URL('../dist/portal.js', import.meta.url), 'utf8');

assert.match(server, /handleFinanceExpenseCorrectionRoute/);
assert.match(server, /finance_expense_corrections[\s\S]*?effectiveAmount[\s\S]*?effectiveCategoryName[\s\S]*?correctionVersion[\s\S]*?canCorrect/,
  'expense history list exposes the effective amount/article and correction eligibility');
assert.match(server, /UNION ALL SELECT e\.expense_date,c\.amount_delta FROM finance_expense_corrections[\s\S]*?e\.source IN \('manual','other'\)/,
  'dashboard applies signed corrections to the original expense date');
const shiftSummary = server.slice(server.indexOf('async function getShiftCashSummary'), server.indexOf('async function captureShiftCloseLedger'));
const shiftCloseStart = server.indexOf('async function captureShiftCloseLedger');
const shiftCloseEnd = server.indexOf('\n}', shiftCloseStart) + 2;
const shiftCloseLedger = server.slice(shiftCloseStart, shiftCloseEnd);
assert.match(shiftSummary, /SUM\(e\.amount\)/);
assert.doesNotMatch(shiftSummary, /finance_expense_corrections|amount_delta/,
  'accounting correction does not alter expected POS cash');
assert.doesNotMatch(shiftCloseLedger, /manual_expense_correction|finance_expense_corrections/,
  'accounting correction does not create a cash event in the close snapshot');
const cashOutflowEnd = server.indexOf(') cash_events GROUP BY event_date');
const cashOutflowStart = server.lastIndexOf('repositories.pool.query(`SELECT to_char(event_date', cashOutflowEnd);
const dashboardCashQuery = server.slice(cashOutflowStart, cashOutflowEnd);
assert.ok(cashOutflowStart >= 0 && cashOutflowEnd > cashOutflowStart);
assert.doesNotMatch(dashboardCashQuery, /finance_expense_corrections|amount_delta/,
  'cash flow keeps only the original payment');
assert.match(report, /\['manual','other','manual_correction'\]\.includes\(source\)[\s\S]*?manualExpenseCorrections/);
assert.match(report, /finance_expense_corrections[\s\S]*?c\.amount_delta<>0[\s\S]*?signedAmount/,
  'unified report exposes signed amount changes separately from gross cash expense events');
assert.match(report, /manualExpenseCorrection:'original_expense_date'/);
assert.match(expenseModule, /UPDATE finance_expense_corrections|INSERT INTO finance_expense_corrections/);
assert.doesNotMatch(expenseModule, /UPDATE\s+expenses\s/i, 'the original expense cash fact must stay immutable');
for (const [name, source] of [['portal.js', portal], ['dist/portal.js', publishedPortal]]) {
  assert.match(source, /value="manual_correction"/, `${name} exposes the accounting correction filter`);
  assert.match(source, /manualExpenseCorrections:'Корректировки ручных расходов · дата исходной операции'/, `${name} labels correction rows`);
  assert.match(source, /key==='manualExpenseCorrections'\?row\.signedAmount/, `${name} renders signed accounting deltas`);
  assert.match(source, /row\.originalDate/, `${name} dates correction rows on the original expense date`);
  assert.match(source, /не создавая второй денежный платёж/, `${name} explains that corrections do not move cash`);
}

console.log('FINANCE EXPENSE CORRECTIONS INTEGRATION CONTRACT: PASS');
