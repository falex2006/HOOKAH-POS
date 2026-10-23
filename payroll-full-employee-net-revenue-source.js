'use strict';

// Candidate-only employee/day merchandise net source. This is a distinct
// series from commission base and never produces payroll calculations/writes.
const { createHash } = require('node:crypto');
const { buildPayrollRecognitionPreview } = require('./payroll-recognition-preview');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = value => typeof value === 'string' && DATE.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))
  && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
const stable = value => {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
};
const digest = value => createHash('sha256').update(stable(value)).digest('hex');
const invalid = (reason, status = 'incomplete', manifest = null, sourcePolicies = null) => ({ schemaVersion: 1, status,
  officialReady: false, amount: null, reasons: [reason], venueId: manifest?.venueId || null,
  currency: manifest?.currency || null, period: manifest?.period ? structuredClone(manifest.period) : null, daily: [],
  sourceWatermark: manifest?.watermark && /^[a-f0-9]{64}$/.test(String(manifest.watermark))
    ? digest({ schemaVersion: 1, manifestWatermark: manifest.watermark, sourcePolicies, status, reason }) : null,
  watermarkScope: 'full_employee_net_revenue_candidate_series', manifestWatermark: manifest?.watermark || null,
  projectionWatermark: null });

const buildPayrollFullEmployeeNetRevenueSource = (manifest, sourcePolicies) => {
  let projection;
  try {
    projection = buildPayrollRecognitionPreview(manifest, sourcePolicies);
  } catch (error) {
    if (error?.code === 'payroll_recognition_preview_total_overflow') {
      return invalid('full_employee_net_revenue_total_overflow', 'incomplete', manifest, sourcePolicies);
    }
    throw error;
  }
  if (projection?.status === 'unsupported' || sourcePolicies?.refunds?.recognition !== 'recognized_event_date') {
    return invalid('full_employee_net_revenue_source_policy_unsupported', 'unsupported', manifest, sourcePolicies);
  }
  if (!manifest || !projection || manifest.schemaVersion !== 1 || projection.schemaVersion !== 1
      || !UUID.test(String(manifest.venueId || '')) || !validDate(manifest.period?.from) || !validDate(manifest.period?.to)
      || manifest.period?.from !== projection.period?.from || manifest.period?.to !== projection.period?.to
      || manifest.venueId !== projection.venueId || manifest.currency !== projection.currency
      || !/^[a-f0-9]{64}$/.test(String(manifest.watermark || ''))
      || !/^[a-f0-9]{64}$/.test(String(projection.projectionWatermark || ''))) return invalid('full_employee_net_revenue_source_context_invalid');
  const reasons = new Set();
  const dailyMap = new Map();
  const seenSaleLines = new Set();
  const seenRefundLines = new Set();
  const add = (row, { idField, eventIdField, amountField, sign, seen, kind, originalSaleLineId = null }) => {
    const id = row?.[idField], eventId = row?.[eventIdField], employeeId = row?.employeeId, date = row?.date;
    if (!UUID.test(String(id || '')) || !UUID.test(String(eventId || '')) || !UUID.test(String(employeeId || ''))
        || !validDate(date) || date < manifest.period.from || date > manifest.period.to || row.currency !== manifest.currency
        || seen.has(id) || !Number.isSafeInteger(row[amountField])
        || (sign > 0 ? row[amountField] < 0 : row[amountField] > 0)) {
      reasons.add(`full_employee_net_revenue_${kind}_invalid`);
      return;
    }
    if (originalSaleLineId !== null && !UUID.test(String(row[originalSaleLineId] || ''))) {
      reasons.add('full_employee_net_revenue_refund_lineage_invalid');
      return;
    }
    seen.add(id);
    const key = `${employeeId}/${date}`;
    if (!dailyMap.has(key)) dailyMap.set(key, { employeeId, date, netMinor: 0n, lineIds: [], sourceEvents: [] });
    const day = dailyMap.get(key);
    day.netMinor += BigInt(row[amountField]);
    day.lineIds.push(id);
    day.sourceEvents.push({ kind, id, eventId, ...(originalSaleLineId ? { originalSaleLineId: row[originalSaleLineId] } : {}), amountMinor: row[amountField] });
  };
  if (!Array.isArray(projection.saleLines) || !Array.isArray(projection.refundAdjustments)) return invalid('full_employee_net_revenue_projection_invalid');
  for (const row of projection.saleLines) add(row, { idField: 'id', eventIdField: 'saleEventId', amountField: 'netRevenueCents', sign: 1,
    seen: seenSaleLines, kind: 'sale' });
  for (const row of projection.refundAdjustments) add(row, { idField: 'id', eventIdField: 'refundEventId', amountField: 'netRevenueAdjustmentCents', sign: -1,
    seen: seenRefundLines, kind: 'refund', originalSaleLineId: 'originalSaleLineId' });
  if (projection.sourceStatus !== 'available' || manifest.status !== 'available') {
    for (const reason of [...(Array.isArray(manifest.reasons) ? manifest.reasons : []),
      ...(Array.isArray(projection.sourceReasons) ? projection.sourceReasons : []), 'full_employee_net_revenue_period_coverage_unproven']) reasons.add(reason);
  }
  const status = reasons.size ? 'incomplete' : 'available';
  const mappedDaily = status === 'available' ? [...dailyMap.values()].map(row => {
    row.lineIds.sort();
    row.sourceEvents.sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
    if (row.netMinor > BigInt(Number.MAX_SAFE_INTEGER) || row.netMinor < BigInt(Number.MIN_SAFE_INTEGER)) {
      reasons.add('full_employee_net_revenue_total_overflow');
    }
    return { employeeId: row.employeeId, date: row.date, netMinor: Number(row.netMinor), lineIds: row.lineIds, sourceEvents: row.sourceEvents };
  }).sort((a, b) => a.date.localeCompare(b.date) || a.employeeId.localeCompare(b.employeeId)) : [];
  const finalStatus = reasons.size ? 'incomplete' : status;
  const daily = finalStatus === 'available' ? mappedDaily : [];
  const sourceWatermark = digest({ schemaVersion: 1, venueId: manifest.venueId, currency: manifest.currency,
    period: manifest.period, manifestWatermark: manifest.watermark, projectionWatermark: projection.projectionWatermark,
    sourcePolicies, status: finalStatus, reasons: [...reasons].sort(), daily });
  const total = finalStatus === 'available' ? daily.reduce((sum, row) => sum + BigInt(row.netMinor), 0n) : null;
  if (total !== null && (total > BigInt(Number.MAX_SAFE_INTEGER) || total < BigInt(Number.MIN_SAFE_INTEGER))) {
    return invalid('full_employee_net_revenue_total_overflow', 'incomplete', manifest, sourcePolicies);
  }
  return { schemaVersion: 1, status: finalStatus, officialReady: false, amount: total === null ? null : Number(total),
    reasons: [...reasons].sort(), venueId: manifest.venueId, currency: manifest.currency,
    period: structuredClone(manifest.period), daily, sourceWatermark,
    watermarkScope: 'full_employee_net_revenue_candidate_series', manifestWatermark: manifest.watermark,
    projectionWatermark: projection.projectionWatermark };
};

module.exports = { buildPayrollFullEmployeeNetRevenueSource };
