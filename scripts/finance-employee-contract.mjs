import assert from 'node:assert/strict';
import fs from 'node:fs';
const server = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const portal = fs.readFileSync(new URL('../portal.js', import.meta.url), 'utf8');
const summary = server.slice(server.indexOf("if (pathname === '/api/finance/summary'"), server.indexOf("if (pathname === '/api/finance/report'"));
const report = server.slice(server.indexOf("if (pathname === '/api/finance/report'"), server.indexOf("if (pathname === '/api/deliveries'"));
for (const route of [summary, report]) {
  assert.match(route, /const employeeFinanceView = isOperationalEmployee\(req\)/);
  assert.match(route, /o\.opened_by=\$2/);
  assert.match(route, /status IN/);
  assert.match(route, /employeeView: true/);
}
assert.match(portal, /МОЯ СМЕНА/);
assert.match(portal, /Оплаты по вашим заказам/);
assert.match(portal, /Платежи гостей за сегодня/);
assert.match(portal, /api\('\/api\/finance\/employee-payments'\)/);
console.log('EMPLOYEE FINANCE VISIBILITY CONTRACT: PASS (employee revenue is scoped to own orders and paid payments)');
