import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const route = server.indexOf("if (pathname === '/api/dashboard/shift-kpis'");
const start = server.indexOf('    if (employeeView) {\n      const totals =', route);
const end = server.indexOf('    const localShifts =', start);
assert.ok(route >= 0 && start > route && end > start, 'memory employee current-day aggregation exists');
const timezone = 'Asia/Yekaterinburg';
const dayKey = (value) => new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
const now = new Date();
const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
const orders = [
  { openedById: 'employee-a', status: 'closed', closedAt: now.toISOString(), payments: [
    { method: 'cash', amount: 40, status: 'paid', createdAt: yesterday.toISOString(), shiftId: 'prior-day-shift' },
    { method: 'card', amount: 60, status: 'paid', createdAt: now.toISOString(), shiftId: 'prior-day-shift' },
  ] },
  { openedById: 'employee-b', status: 'closed', closedAt: now.toISOString(), payments: [{ method: 'cash', amount: 70, status: 'paid', createdAt: now.toISOString() }] },
];
const clients = [{ depositTopUps: [
  { actorId: 'employee-a', amount: 25, method: 'card', createdAt: now.toISOString() },
  { actorId: 'employee-b', amount: 900, method: 'cash', createdAt: now.toISOString() },
  { actorId: 'employee-a', amount: 70, method: 'cash', createdAt: yesterday.toISOString() },
] }];
const reservations = [{ prepaymentReceipts: [
  { actorId: 'employee-a', amount: 15, method: 'cash', createdAt: now.toISOString() },
  { actorId: 'employee-b', amount: 800, method: 'card', createdAt: now.toISOString() },
  { actorId: 'employee-a', amount: 35, method: 'card', createdAt: yesterday.toISOString() },
] }];
const run = new Function('orders', 'clients', 'reservations', 'req', 'reportDate', 'businessDateKey', 'json', 'res', 'businessTimezone', 'employeeView',
  `${server.slice(start, end)}\nreturn null;`);
const result = run(orders, clients, reservations, { user: { id: 'employee-a' } }, dayKey(now), dayKey, (_res, status, body) => { assert.equal(status, 200); return body; }, {}, timezone, true);
assert.equal(result.employeeView, true);
assert.equal(result.totals.revenue, 60);
assert.equal(result.totals.paymentCount, 1);
assert.equal(result.totals.closedOrders, 1);
assert.equal(result.totals.cashless, 60);
assert.deepEqual(result.totals.depositTopUps, { total: 25, cash: 0, cashless: 25, count: 1 });
assert.deepEqual(result.totals.reservationPrepayments, { total: 15, cash: 15, cashless: 0, count: 1 });
assert.deepEqual(result.shifts, [{ id: 'employee-today' }]);
const financeRoute = server.indexOf("if (pathname === '/api/finance/summary'");
const financeStart = server.indexOf('    if (employeeFinanceView) {\n      const revenue =', financeRoute);
const financeEnd = server.indexOf('    const closed = orders.filter', financeStart);
assert.ok(financeRoute >= 0 && financeStart > financeRoute && financeEnd > financeStart, 'memory employee finance calculation exists');
const financeRun = new Function('orders', 'req', 'date', 'businessDateKey', 'json', 'res', 'employeeFinanceView',
  `${server.slice(financeStart, financeEnd)}\nreturn null;`);
const financeResult = financeRun(orders, { user: { id: 'employee-a' } }, dayKey(now), dayKey, (_res, status, body) => { assert.equal(status, 200); return body; }, {}, true);
assert.equal(financeResult.revenue, 60, 'memory finance headline uses own payments made today');
assert.equal(financeResult.employeeView, true);
assert.equal(financeResult.byPaymentMethod, undefined);
console.log('DASHBOARD OVERNIGHT EMPLOYEE MEMORY QA: PASS (post-midnight own events, aligned finance headline, actor isolation, masked shift)');
