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
  'finance report allocates recognized sale value rather than a payment subtotal');
assert.match(summary, /financeDateLedger\(client, venueDbId, date, timezone\)/,
  'manager finance summary uses the same recognized-sales and event-date receipt/payout ledger as reports');
assert.match(summary, /BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY/,
  'manager summary keeps its finance ledger and operational counters on one repeatable snapshot');
assert.match(report, /financeDateLedger\(client, venueDbId, date, timezone\)/,
  'owner X/waiter reports load closed-date sales separately from event-date receipt and payout ledgers');
assert.match(report, /BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY/,
  'owner finance report reads its sales and cash ledgers on one repeatable snapshot');
assert.match(report, /sales: periodLedger\.sales, receipts: periodLedger\.receipts, payouts: periodLedger\.payouts/,
  'owner finance report exposes explicit sales, receipts, and payouts fields');
assert.match(report, /staffAttribution: 'order_opener'/,
  'report discloses that staff breakdown currently attributes orders to their opener');
const financeLedger = sliceBetween('const financeDateLedger = async', 'async function accrueGuestOrderBonus');
assert.match(financeLedger, /p\.created_at>=b\.starts_at AND p\.created_at<b\.ends_at/,
  'financial receipt and payout flows use event date rather than order close date');
assert.match(financeLedger, /p\.method IN \('cash','card','qr'\)/,
  'loyalty tender is excluded from external order-payment receipts');
assert.match(financeLedger, /guest_deposit_receipts/,
  'actual guest account top-ups are included as receipts');
assert.match(financeLedger, /reservation_pre_payment_receipts/,
  'reservation prepayments are included once at their receipt event');
assert.match(financeLedger, /reservation_pre_payment_receipt_reversals/,
  'reservation refund payouts are separated from receipts and sales');
assert.match(portal, /report\.sales\?\.net \?\? report\.revenue/,
  'finance report UI displays recognized sales while preserving legacy-compatible payload fallback');
assert.match(portal, /report\.receipts\?\.byMethod \|\| report\.byPaymentMethod/,
  'finance report UI renders cash receipts from the event-date receipt ledger');
assert.match(portal, /\['complete', 'guest_account_and_reservation_prepayment_refund_ledgers_only', 'guest_account_reservation_prepayment_and_order_refund_ledgers_only'\]\.includes\(payoutCoverage\)/,
  'finance report UI does not present unavailable payout data as a zero balance');
assert.match(summary, /order\.finalTotal !== undefined && order\.finalTotal !== null \? order\.finalTotal : orderNetTotal\(order\)/,
  'memory finance summary preserves explicit zero final totals instead of substituting gross sales');
assert.match(report, /order\.finalTotal !== undefined && order\.finalTotal !== null \? Number\(order\.finalTotal\) : Number\(orderNetTotal\(order\)\)/,
  'memory finance report preserves explicit zero final totals instead of substituting gross sales');
assert.match(report, /COALESCE\(o\.final_total_snapshot,GREATEST\(0,GREATEST\(COALESCE\(o\.vip_minimum,0\),COALESCE\(i\.subtotal,0\)-COALESCE\(d\.discount,0\)\)\)\) AS "finalTotal"/,
  'PostgreSQL finance report preserves locked order totals and derives the fallback from persisted order items and approved discounts');
assert.match(analytics, /manualExpenses\.filter\(\(expense\) => expense\.date === date && !\['purchase', 'payroll'\]\.includes\(expense\.source\)\)/,
  'memory-backed server analytics includes ordinary operating expenses while separating purchase/payroll treatment');
assert.match(analytics, /FROM order_refund_tenders t WHERE t\.venue_id=\$1 AND \(t\.created_at AT TIME ZONE \$4\)::date BETWEEN \$2::date AND \$3::date/,
  'POS refund payouts are independently scoped by venue and event-local date');
assert.match(analytics, /sale_period_refund_count[\s\S]*legacy_refunded_payment_count/,
  'closed-sale refunds and unreconstructable legacy refunded payments enter completeness coverage');
assert.match(analytics, /FROM payments p JOIN orders o ON o\.id=p\.order_id WHERE o\.venue_id=\$1[\s\S]*p\.status='refunded'/,
  'legacy refunds are tenant-scoped through their order because payments has no venue_id column');
assert.doesNotMatch(analytics, /payments p JOIN orders o ON o\.id=p\.order_id AND o\.venue_id=p\.venue_id/,
  'analytics does not query a nonexistent payments.venue_id column');
assert.match(analytics, /netProfit: profitIncomplete\?null:knownNetProfit/,
  'daily profit remains unavailable when POS refund recognition is incomplete');
assert.match(analytics, /posRefundCoverage:\{ status:incompletePosRefunds\?'incomplete':'complete'[\s\S]*payoutIncludedInProfit:false/,
  'analytics exposes payout facts as separate from profit recognition');
assert.match(analytics, /revenueBasis:'gross_paid_pos_sales_before_refund_recognition'/,
  'legacy totalRevenue explicitly identifies its gross paid-sales basis');
assert.match(analytics, /totalRecognizedRevenue, knownRecognizedRevenue, recognizedRevenueBasis:'closed_order_final_total_snapshot_or_safe_legacy_fallback'/,
  'analytics exposes close-recognized revenue separately from paid receipts');
assert.match(analytics, /recognizedRevenueCoverage:\{status:incompleteRecognizedRevenue\?'incomplete':'complete'/,
  'unpriceable legacy closed orders withhold the official recognized-revenue total');
assert.match(analytics, /const knownNetProfit = knownRecognizedRevenue - totalExpenses - totalCostOfGoods/,
  'profit subtracts recognized expenses and COGS from recognized closed-sale value, not payment totals');
assert.match(analytics, /const payrollSourceOfficialReady=false/,
  'official profit stays closed while payroll-source readiness is not established');
assert.match(analytics, /officialReady:payrollSourceOfficialReady/,
  'analytics exposes the payroll readiness boundary');
assert.match(portal, /finance-total-recognized/,
  'finance result distinguishes paid turnover from recognized sales');
assert.match(portal, /const financeIncomplete=.*recognizedRevenueCoverage\?\.status==='incomplete'/,
  'dashboard suppresses profit when closed-sale value coverage is incomplete');
assert.doesNotMatch(portal, /money\(analytics\.netProfit \|\| 0\)/,
  'dashboard does not convert unavailable profit into a displayed zero');
assert.match(portal, /analytics\?\.officialReady === false/,
  'finance chart gates profit while official payroll sources are unavailable');
assert.match(portal, /metric === 'profit' \? Number\(day\.netProfit \|\| 0\)/,
  'profit chart does not derive profit from paid revenue when the official value is unavailable');
assert.match(portal, /analytics\.posRefundCoverage\?\.status==='incomplete'/,
  'finance and dashboard interfaces warn when POS refund recognition makes profit incomplete');
assert.match(portal, /metric === 'profit' && analytics\?\.posRefundCoverage\?\.status === 'incomplete'/,
  'profit chart displays an explicit unavailable state instead of plotting an unknown as zero');
assert.match(portal, /Оплаченные продажи до учета возвратов; фактические выплаты отражены отдельно/,
  'finance turnover tooltip clarifies gross sales and separate refund payout treatment');
assert.match(portal, /const totalPayroll = null;/,
  'demo analytics does not invent payroll accrual without a payroll ledger');
assert.match(portal, /payrollCoverage: \{ status: 'unsupported', reason: 'payroll_requires_database' \}/,
  'demo analytics explicitly discloses unavailable payroll coverage');
assert.match(portal, /totalCostOfGoods, netProfit: null/,
  'demo analytics keeps COGS observable without asserting complete profit');
assert.match(subscription, /UPDATE organizations SET plan=\$1,is_active=\$2,updated_at=now\(\) WHERE id=\$3/,
  'organization plan changes update the organization modification timestamp');
assert.match(expenses, /LEFT JOIN LATERAL \(SELECT pe\.id,pe\.status,pe\.period_from,pe\.period_to FROM payroll_entries pe WHERE pe\.venue_id=e\.venue_id AND pe\.expense_id=e\.id ORDER BY pe\.created_at DESC,pe\.id DESC LIMIT 1\) payroll ON true/,
  'linked payroll period is read in a tenant-bound deterministic order');
assert.match(expenses, /'Выплата зарплаты за ' \|\| to_char\(payroll\.period_from,'DD\.MM\.YYYY'\) \|\| ' — ' \|\| to_char\(payroll\.period_to,'DD\.MM\.YYYY'\) ELSE e\.description/,
  'linked payroll expenses expose canonical Russian period text without rewriting legacy rows');
assert.match(expenses, /NOT EXISTS \(SELECT 1 FROM payroll_entries pe WHERE pe\.venue_id=e\.venue_id AND pe\.expense_id=e\.id AND pe\.status='paid'\)/,
  'payroll review status retains its existing all-linked-entries rule');

assert.ok(analytics.includes('const expenseTotalsIncomplete=incompletePayables||incompleteExpenseRefunds')&&analytics.includes('totalExpenses:expenseTotalsIncomplete?null:totalExpenses')&&analytics.includes('netProfit: profitIncomplete?null:knownNetProfit'),'manual expense refunds keep total expense and profit analytics explicitly incomplete');assert.ok(analytics.includes('sum + row.knownExpenses'),'known expenses remain available as a separate partial subtotal');console.log('FINANCE API CONSISTENCY CONTRACT: PASS (partial receipts, zero-total handling, PostgreSQL fail-closed, organization timestamp)');
