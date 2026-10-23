'use strict';

const { createHash } = require('node:crypto');
const { buildPayrollFullEmployeeNetRevenueSource } = require('./payroll-full-employee-net-revenue-source');
const { manifestHasCompleteNoRefundHistory } = require('./payroll-no-refund-coverage');
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const same = (a, b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));
const hash = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
const SHA = /^[a-f0-9]{64}$/;

// The independent series includes every credited sale line, regardless of the
// scheme's commission rules. Tender liabilities are not new sales or deductions.
function buildPayrollPersonalRevenueSource({ venueId, currency, period, recognitionManifest: manifest,
  sourcePolicies, fullEmployeeNetRevenue, orderRevenueReconciliation: reconciliation } = {}) {
  const reasons = new Set();
  const expected = buildPayrollFullEmployeeNetRevenueSource(manifest, sourcePolicies);
  if (manifest?.status !== 'available' || manifest.venueId !== venueId || manifest.currency !== currency
      || manifest.period?.from !== period?.from || manifest.period?.to !== period?.to
      || !Array.isArray(manifest.refundEvents) || manifest.refundEvents.length || !manifestHasCompleteNoRefundHistory(manifest)) {
    reasons.add('payroll_personal_revenue_no_refund_source_required');
  }
  if (expected.status !== 'available' || !same(expected, fullEmployeeNetRevenue)
      || !SHA.test(expected.sourceWatermark || '')) reasons.add('payroll_personal_revenue_full_source_mismatch');
  if (reconciliation?.status !== 'available' || reconciliation.coverage?.complete !== true
      || reconciliation.currency !== currency || reconciliation.period?.from !== period?.from
      || reconciliation.period?.to !== period?.to || !SHA.test(reconciliation.sourceWatermark || '')
      || !Array.isArray(reconciliation.orders)
      || reconciliation.orders.some(row => !row || typeof row !== 'object' || Array.isArray(row))) {
    reasons.add('payroll_personal_revenue_order_coverage_required');
  }
  else {
    const expectedOrders = [...new Set((manifest?.sales || []).map(row => row.orderId))].sort();
    const actualOrders = reconciliation.orders.map(row => row.orderId).sort();
    if (!same(expectedOrders, actualOrders)) reasons.add('payroll_personal_revenue_order_coverage_mismatch');
    const lineTotals = new Map();
    for (const line of manifest?.saleLines || []) {
      if (!Number.isSafeInteger(line?.netMinor) || line.netMinor < 0) {
        reasons.add('payroll_personal_revenue_order_line_mismatch'); continue;
      }
      lineTotals.set(line.orderId, (lineTotals.get(line.orderId) || 0n) + BigInt(line.netMinor));
    }
    let net = 0n;
    for (const row of reconciliation.orders) {
      if (row.status !== 'available' || !Number.isSafeInteger(row.recognizedLineNetMinor) || row.recognizedLineNetMinor < 0
          || row.minimumPriceAdjustmentMinor !== 0 || row.unattributedResidualMinor !== 0
          || row.closedOrderTotalMinor !== row.recognizedLineNetMinor) {
        reasons.add('payroll_personal_revenue_unattributed_order_amount'); continue;
      }
      const lineNet = lineTotals.get(row.orderId) || 0n;
      if (lineNet !== BigInt(row.recognizedLineNetMinor)) reasons.add('payroll_personal_revenue_order_line_mismatch');
      net += BigInt(row.recognizedLineNetMinor);
    }
    if (!Number.isSafeInteger(expected.amount) || net !== BigInt(expected.amount)) reasons.add('payroll_personal_revenue_total_mismatch');
  }
  const daily = (expected.daily || []).map(row => ({ employeeId: row.employeeId, date: row.date, netRevenueCents: row.netMinor }));
  if (daily.some(row => !Number.isSafeInteger(row.netRevenueCents) || row.netRevenueCents < 0)) {
    reasons.add('payroll_personal_revenue_signed_input_unsupported');
  }
  const complete = reasons.size === 0;
  const payload = { schemaVersion: 1, policyCode: 'employee_attributed_merchandise_net_v1', venueId, currency,
    period: period && { from: period.from, to: period.to }, status: complete ? 'available' : 'incomplete',
    reasons: [...reasons].sort(), coverage: { complete }, daily: complete ? daily : [],
    manifestWatermark: manifest?.watermark || null, fullNetWatermark: expected.sourceWatermark || null,
    orderReconciliationWatermark: reconciliation?.sourceWatermark || null };
  return { ...payload, sourceWatermark: hash(payload) };
}

module.exports = { buildPayrollPersonalRevenueSource };
