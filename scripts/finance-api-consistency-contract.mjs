import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const portal = readFileSync(new URL('../portal.js', import.meta.url), 'utf8');
const sliceBetween = (start, end) => {
  const from = server.indexOf(start);
  const to = server.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `route boundary missing: ${start}`);
  return server.slice(from, to);
};

const summary = sliceBetween("if (pathname === '/api/finance/summary'", "if (pathname === '/api/finance/report'");
const report = sliceBetween("if (pathname === '/api/finance/report'", "if (pathname === '/api/deliveries'");
const analytics = sliceBetween("if (pathname === '/api/analytics'", "if (pathname === '/api/audit'");
const subscription = sliceBetween("if (platformOrgSubscription && req.method === 'PATCH')", "const platformOrgPath = pathname.match(");
const expenses = sliceBetween("if (pathname === '/api/expenses' && req.method === 'GET')", "if (pathname === '/api/expenses' && req.method === 'POST')");

for (const [name, route] of [['finance summary', summary], ['finance report', report]]) {
  assert.match(route, /\['paid', 'partially_paid'\]\.includes\(payment\.status\)/,
    `${name} memory mode counts both collected full and partial payments like PostgreSQL`);
  assert.doesNotMatch(route, /payment\.status === 'paid'/,
    `${name} must not silently omit partially-paid receipts in memory mode`);
}

assert.match(analytics, /catch \(error\) \{ return json\(res, 503, \{ error: 'database_unavailable'/,
  'analytics returns a database error rather than serving stale memory data when PostgreSQL context queries fail');
assert.doesNotMatch(analytics, /catch \(_\) \{ startDate = '2000-01-01'; \}/,
  'all-time analytics must not silently widen its query after a failed PostgreSQL context lookup');
assert.doesNotMatch(analytics, /Fall through to the zero-safe in-memory analytics response/,
  'PostgreSQL analytics query errors must not silently return a memory-backed response');
assert.match(analytics, /allocateMoneyByGross\(rows, checkAmountsByOrder\.get\(orderId\) \|\| 0/,
  'PostgreSQL product breakdown allocates the actual paid amount instead of gross line prices');
assert.match(analytics, /const byStation = Object\.fromEntries\(\[\.\.\.stationMap\]/,
  'PostgreSQL station revenue uses the same paid-amount allocation');
assert.match(report, /allocateMoneyByGross\(order\.items \|\| \[\], orderRevenue/,
  'finance reports reconcile station breakdown to actual payment revenue');
assert.match(summary, /order\.finalTotal !== undefined && order\.finalTotal !== null \? order\.finalTotal : orderNetTotal\(order\)/,
  'memory finance summary preserves explicit zero final totals instead of substituting gross sales');
assert.match(report, /order\.finalTotal !== undefined && order\.finalTotal !== null \? Number\(order\.finalTotal\) : Number\(orderNetTotal\(order\)\)/,
  'memory finance report preserves explicit zero final totals instead of substituting gross sales');
assert.match(report, /COALESCE\(o\.final_total_snapshot,GREATEST\(0,GREATEST\(COALESCE\(o\.vip_minimum,0\),COALESCE\(i\.subtotal,0\)-COALESCE\(d\.discount,0\)\)\)\) AS "finalTotal"/,
  'PostgreSQL finance report preserves locked order totals and derives the fallback from persisted order items and approved discounts');
assert.match(analytics, /manualExpenses\.filter\(\(expense\) => expense\.date === date && !\['purchase', 'payroll'\]\.includes\(expense\.source\)\)/,
  'memory-backed server analytics includes ordinary operating expenses while separating purchase/payroll treatment');
assert.match(portal, /const totalPayroll = days\.reduce\(\(sum, row\) => sum \+ Number\(row\.payroll \|\| 0\), 0\)/,
  'demo analytics exposes paid payroll separately and includes it in total expenses');
assert.match(portal, /netProfit: totalRevenue - totalExpenses - totalCostOfGoods/,
  'demo analytics net profit subtracts both expenses and cost of goods');
assert.match(subscription, /UPDATE organizations SET plan=\$1,is_active=\$2,updated_at=now\(\) WHERE id=\$3/,
  'organization plan changes update the organization modification timestamp');
assert.match(expenses, /LEFT JOIN LATERAL \(SELECT pe\.id,pe\.status,pe\.period_from,pe\.period_to FROM payroll_entries pe WHERE pe\.venue_id=e\.venue_id AND pe\.expense_id=e\.id ORDER BY pe\.created_at DESC,pe\.id DESC LIMIT 1\) payroll ON true/,
  'linked payroll period is read in a tenant-bound deterministic order');
assert.match(expenses, /'Выплата зарплаты за ' \|\| to_char\(payroll\.period_from,'DD\.MM\.YYYY'\) \|\| ' — ' \|\| to_char\(payroll\.period_to,'DD\.MM\.YYYY'\) ELSE e\.description/,
  'linked payroll expenses expose canonical Russian period text without rewriting legacy rows');
assert.match(expenses, /NOT EXISTS \(SELECT 1 FROM payroll_entries pe WHERE pe\.venue_id=e\.venue_id AND pe\.expense_id=e\.id AND pe\.status='paid'\)/,
  'payroll review status retains its existing all-linked-entries rule');

console.log('FINANCE API CONSISTENCY CONTRACT: PASS (partial receipts, zero-total handling, PostgreSQL fail-closed, organization timestamp)');
