'use strict';

// Shared proof over the server-owned recognition manifest; no database reads.
const unique = values => [...new Set(values)].sort();
const stable = value => {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
};

const manifestHasCompleteNoRefundHistory = manifest => {
  const coverage = manifest?.relatedRefundCoverage;
  const saleOrderIds = unique((Array.isArray(manifest?.sales) ? manifest.sales : [])
    .map(row => typeof row?.orderId === 'string' ? row.orderId : '').filter(Boolean));
  return coverage?.schemaVersion === 1
    && coverage.status === 'complete'
    && coverage.scope === 'all_recorded_refunds_for_payroll_related_orders_as_of_repeatable_read_snapshot'
    && coverage.sourceWatermark === manifest?.watermark
    && Array.isArray(coverage.periodSaleOrderIds)
    && stable(coverage.periodSaleOrderIds) === stable(saleOrderIds)
    && Array.isArray(coverage.coveredOrderIds)
    && saleOrderIds.every(id => coverage.coveredOrderIds.includes(id))
    && Array.isArray(coverage.relatedRefundHeaderIds) && coverage.relatedRefundHeaderIds.length === 0
    && Array.isArray(coverage.relatedRefundEventIds) && coverage.relatedRefundEventIds.length === 0
    && Array.isArray(coverage.relatedRefundItemIds) && coverage.relatedRefundItemIds.length === 0
    && Array.isArray(coverage.relatedRefundLineEventIds) && coverage.relatedRefundLineEventIds.length === 0;
};

module.exports = { manifestHasCompleteNoRefundHistory };
