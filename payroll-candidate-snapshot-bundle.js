'use strict';

// Deterministic, source-bound snapshot preview. This is not an official run,
// contains no database-shaped rows, and has no persistence or payout path.
const { createHash } = require('node:crypto');
const { buildPayrollFullEmployeeNetRevenueSource } = require('./payroll-full-employee-net-revenue-source');
const { buildPayrollMarginCostSource } = require('./payroll-margin-cost-source');
const { buildPayrollPersonalRevenueSource } = require('./payroll-personal-revenue-source');
const { resolveRoleAt, resolveRoleParameters } = require('./payroll-schemes');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_CANDIDATE_SNAPSHOT_LINES = 20000;
const fail = suffix => { const code = `payroll_candidate_snapshot_${suffix}`; throw Object.assign(new TypeError(code), { code }); };
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().filter(key => value[key] !== undefined)
    .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value);
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))
  && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
const cents = value => Number.isSafeInteger(value) && value >= 0;
const id = value => typeof value === 'string' && UUID.test(value);
const same = (left, right) => canonical(left) === canonical(right);

const buildPayrollCandidateSnapshotBundle = ({ venueId, scheme, period, venueTimezone, sourceBundle, candidateCalculation } = {}) => {
  if (!id(venueId) || !scheme || !id(scheme.versionId) || !/^[A-Z]{3}$/.test(String(scheme.currency || ''))
      || !period || !date(period.from) || !date(period.to) || period.from > period.to
      || period.from.slice(0, 7) !== period.to.slice(0, 7)) fail('context_invalid');
  if (typeof venueTimezone !== 'string' || !venueTimezone.trim() || venueTimezone !== venueTimezone.trim()) fail('timezone_invalid');
  try { new Intl.DateTimeFormat('en', { timeZone: venueTimezone }); } catch (_) { fail('timezone_invalid'); }
  if (!sourceBundle || !candidateCalculation || typeof sourceBundle !== 'object' || typeof candidateCalculation !== 'object') fail('evidence_required');
  if (candidateCalculation.status !== 'scenario_ready' || candidateCalculation.candidateOnly !== true
      || candidateCalculation.officialReady !== false || candidateCalculation.payoutEligible !== false
      || candidateCalculation.nonPayable !== true || candidateCalculation.nonAccrual !== true
      || candidateCalculation.official === true || candidateCalculation.persisted === true
      || Object.hasOwn(candidateCalculation, 'runId') || Object.hasOwn(candidateCalculation, 'run')) fail('candidate_only_required');
  if (sourceBundle.schemaVersion !== 1 || sourceBundle.venueId !== venueId || sourceBundle.schemeVersionId !== scheme.versionId
      || sourceBundle.currency !== scheme.currency || sourceBundle.period?.from !== period.from || sourceBundle.period?.to !== period.to
      || !SHA256.test(sourceBundle.inputWatermark || '') || !SHA256.test(sourceBundle.readinessWatermark || '')
      || candidateCalculation.inputWatermark !== sourceBundle.inputWatermark
      || !SHA256.test(sourceBundle.recognitionManifest?.watermark || '')
      || sourceBundle.recognitionManifest.venueId !== venueId || sourceBundle.recognitionManifest.currency !== scheme.currency
      || sourceBundle.recognitionManifest.status !== 'available' || sourceBundle.recognitionManifest.officialReady !== false
      || sourceBundle.recognitionManifest.period?.from !== period.from || sourceBundle.recognitionManifest.period?.to !== period.to
      || sourceBundle.recognizedLineProjection?.schemaVersion !== 1 || sourceBundle.recognizedLineProjection.venueId !== venueId
      || sourceBundle.recognizedLineProjection.currency !== scheme.currency
      || sourceBundle.recognizedLineProjection.period?.from !== period.from || sourceBundle.recognizedLineProjection.period?.to !== period.to
      || sourceBundle.recognizedLineProjection.sourceWatermark !== sourceBundle.recognitionManifest.watermark
      || !SHA256.test(sourceBundle.recognizedLineProjection.projectionWatermark || '')) {
    fail('source_binding_mismatch');
  }
  const sourceWatermark = sourceBundle.inputWatermark;
  const sourceCopy = structuredClone(sourceBundle); delete sourceCopy.inputWatermark;
  if (digest(sourceCopy) !== sourceWatermark) fail('source_watermark_mismatch');
  const personalSource = sourceBundle.calculatorInput?.personalRevenueSource;
  if (personalSource !== undefined) {
    const expected = buildPayrollPersonalRevenueSource({ venueId, currency: scheme.currency, period,
      recognitionManifest: sourceBundle.recognitionManifest, sourcePolicies: scheme.sourcePolicies,
      fullEmployeeNetRevenue: sourceBundle.fullEmployeeNetRevenue,
      orderRevenueReconciliation: sourceBundle.orderRevenueReconciliation });
    if (expected.status !== 'available' || !same(personalSource, expected)) fail('personal_revenue_input_binding_mismatch');
  }
  const marginSource = sourceBundle.marginCostSource;
  const marginRows = new Map();
  if (marginSource) {
    const expected = buildPayrollMarginCostSource({ venueId, currency: scheme.currency, period,
      recognitionManifest: sourceBundle.recognitionManifest, evidenceByOrder: sourceBundle.marginCostEvidenceByOrder });
    if (marginSource.status !== 'available' || !same(marginSource, expected)
        || marginSource.sourceWatermark !== sourceBundle.components?.marginCosts?.sourceWatermark) {
      fail('margin_cost_source_binding_mismatch');
    }
    for (const row of marginSource.rows) marginRows.set(row.saleLineEventId, row);
    for (const sale of sourceBundle.calculatorInput?.sales || []) {
      if (!same(sale.costSnapshot, marginRows.get(sale.id)?.costSnapshot)) fail('margin_cost_sale_binding_mismatch');
    }
    if (marginRows.size !== sourceBundle.calculatorInput?.sales?.length) fail('margin_cost_coverage_mismatch');
  }
  const fullNet = sourceBundle.fullEmployeeNetRevenue;
  const expectedFullNet = buildPayrollFullEmployeeNetRevenueSource(sourceBundle.recognitionManifest, scheme.sourcePolicies);
  if (!fullNet || fullNet.status !== 'available' || !same(fullNet, expectedFullNet)
      || fullNet.sourceWatermark !== sourceBundle.components?.fullEmployeeNetRevenue?.sourceWatermark) {
    fail('personal_revenue_source_binding_mismatch');
  }
  if (!Array.isArray(sourceBundle.recognitionManifest.refundEvents) || sourceBundle.recognitionManifest.refundEvents.length
      || !Array.isArray(sourceBundle.recognizedLineProjection?.refundAdjustments)
      || sourceBundle.recognizedLineProjection.refundAdjustments.length) fail('refund_scope_unsupported');
  if (candidateCalculation.schemeVersionId !== scheme.versionId || candidateCalculation.mode !== scheme.mode
      || candidateCalculation.currency !== scheme.currency || candidateCalculation.period?.from !== period.from
      || candidateCalculation.period?.to !== period.to || !cents(candidateCalculation.amountCents)
      || !Array.isArray(candidateCalculation.employees) || !Array.isArray(candidateCalculation.daily)
      || !Array.isArray(sourceBundle.calculatorInput?.sales)
      || !Array.isArray(sourceBundle.recognizedLineProjection.saleLines)
      || !Array.isArray(sourceBundle.recognitionManifest.saleLines)) fail('calculation_shape_invalid');

  const employees = sourceBundle.employmentEligibility?.periods;
  if (!Array.isArray(employees)) fail('employee_source_missing');
  const candidateEmployeeDayCount = candidateCalculation.daily.reduce((sum, day) => sum + (Array.isArray(day?.employees) ? day.employees.length : 0), 0);
  if (candidateEmployeeDayCount > MAX_CANDIDATE_SNAPSHOT_LINES) fail('line_limit_exceeded');
  const employeeNames = new Map();
  for (const employee of employees) {
    if (!id(employee?.employeeId) || typeof employee.employeeName !== 'string' || !employee.employeeName.trim()
        || employeeNames.has(employee.employeeId)) fail('employee_source_invalid');
    employeeNames.set(employee.employeeId, employee.employeeName.trim());
  }
  const calculatorSales = new Map(), saleRevenueByDay = new Map();
  for (const sale of sourceBundle.calculatorInput.sales) {
    if (!id(sale?.id) || calculatorSales.has(sale.id) || !id(sale.employeeId) || !date(sale.date)
        || sale.date < period.from || sale.date > period.to || sale.currency !== scheme.currency
        || !cents(sale.turnoverCents) || !cents(sale.commissionBaseCents) || !SHA256.test(sale.sourceWatermark || '')) {
      fail('calculator_sale_invalid');
    }
    calculatorSales.set(sale.id, sale);
    const key = `${sale.employeeId}|${sale.date}`;
    saleRevenueByDay.set(key, (saleRevenueByDay.get(key) || 0n) + BigInt(sale.turnoverCents));
  }
  const netRevenueByDay = new Map();
  for (const row of fullNet.daily) {
    const key = `${row.employeeId}|${row.date}`;
    if (!employeeNames.has(row.employeeId) || netRevenueByDay.has(key) || !cents(row.netMinor)
        || !saleRevenueByDay.has(key) || saleRevenueByDay.get(key) !== BigInt(row.netMinor)) {
      fail('personal_revenue_line_reconciliation_failed');
    }
    netRevenueByDay.set(key, BigInt(row.netMinor));
  }
  if (netRevenueByDay.size !== saleRevenueByDay.size) fail('personal_revenue_line_reconciliation_failed');
  const projectionLines = new Map();
  for (const line of sourceBundle.recognizedLineProjection.saleLines) {
    if (!id(line?.id) || projectionLines.has(line.id) || !calculatorSales.has(line.id)
        || line.employeeId !== calculatorSales.get(line.id).employeeId || line.date !== calculatorSales.get(line.id).date
        || line.currency !== scheme.currency || line.sourceWatermark !== sourceBundle.recognitionManifest.watermark
        || line.commissionBaseCents !== calculatorSales.get(line.id).commissionBaseCents
        || line.netRevenueCents !== calculatorSales.get(line.id).turnoverCents) fail('projection_sale_binding_mismatch');
    projectionLines.set(line.id, line);
  }
  const rawLines = new Map();
  for (const line of sourceBundle.recognitionManifest.saleLines) {
    if (!id(line?.saleLineEventId) || rawLines.has(line.saleLineEventId) || !projectionLines.has(line.saleLineEventId)) fail('manifest_sale_binding_mismatch');
    rawLines.set(line.saleLineEventId, line);
  }
  if (calculatorSales.size !== projectionLines.size || projectionLines.size !== rawLines.size) fail('sale_coverage_mismatch');
  if (rawLines.size + candidateEmployeeDayCount + candidateCalculation.daily.length > MAX_CANDIDATE_SNAPSHOT_LINES) fail('line_limit_exceeded');
  const calculatedLines = new Map(), employeeDays = [], daySnapshots = [], dailyTotals = new Map(), employeeDayKeys = new Set();
  for (const day of candidateCalculation.daily) {
    if (!date(day?.date) || day.date < period.from || day.date > period.to || dailyTotals.has(day.date)
        || !Array.isArray(day.employees) || !Array.isArray(day.lines)) fail('daily_shape_invalid');
    dailyTotals.set(day.date, { amountCents: 0n, employeeAmounts: new Map() });
    const dayEmployeeRows = [];
    for (const row of day.employees) {
      const employeeDayKey = `${row?.employeeId}|${day.date}`;
      if (!id(row?.employeeId) || !employeeNames.has(row.employeeId) || !cents(row.amountCents) || employeeDayKeys.has(employeeDayKey)) fail('daily_employee_invalid');
      // Sparse source days mean zero only after complete source/line reconciliation.
      if (!cents(row.personalRevenueCents)
          || BigInt(row.personalRevenueCents) !== (netRevenueByDay.get(employeeDayKey) || 0n)) {
        fail('personal_revenue_day_reconciliation_failed');
      }
      employeeDayKeys.add(employeeDayKey);
      dailyTotals.get(day.date).amountCents += BigInt(row.amountCents);
      dailyTotals.get(day.date).employeeAmounts.set(row.employeeId, BigInt(row.amountCents));
      const employeeDay = { date: day.date, employeeId: row.employeeId, employeeName: employeeNames.get(row.employeeId), ...structuredClone(row) };
      employeeDays.push(employeeDay); dayEmployeeRows.push(employeeDay);
    }
    for (const line of day.lines) {
      const lineId = line?.lineId, sale = calculatorSales.get(lineId), projection = projectionLines.get(lineId), raw = rawLines.get(lineId);
      if (!sale || !projection || !raw || calculatedLines.has(lineId) || sale.date !== day.date
          || line.employeeId !== sale.employeeId || line.commissionBaseCents !== sale.commissionBaseCents
          || line.turnoverCents !== sale.turnoverCents || line.menuItemId !== sale.menuItemId
          || line.department !== sale.department || !cents(line.commissionCents)) fail('calculated_line_binding_mismatch');
      const roleId = resolveRoleAt(sourceBundle.calculatorInput.roleAssignments, sale.employeeId, day.date);
      const mode = resolveRoleParameters(scheme, sale.employeeId, roleId, day.date)?.mode || scheme.mode;
      if (mode === 'margin_target') {
        const cost = marginRows.get(lineId)?.costSnapshot;
        if (!cost || !same(line.costSnapshot, cost) || !same(sale.costSnapshot, cost)
            || !Number.isSafeInteger(line.signedMarginCents)
            || line.signedMarginCents !== sale.commissionBaseCents - cost.costCents
            || line.marginCents !== line.signedMarginCents) fail('margin_cost_calculated_binding_mismatch');
      } else if (line.costSnapshot !== undefined || line.signedMarginCents !== undefined) fail('margin_cost_unexpected');
      calculatedLines.set(lineId, { day, line });
    }
    daySnapshots.push({ date: day.date, venueTurnoverCents: day.venueTurnoverCents,
      cumulativeVenueTurnoverCents: day.cumulativeVenueTurnoverCents, employees: structuredClone(dayEmployeeRows),
      teamFunds: structuredClone(day.teamFunds || []), lines: day.lines.map(line => line.lineId).sort() });
  }
  if (dailyTotals.size !== periodDays(period.from, period.to).length || calculatedLines.size !== rawLines.size) fail('result_coverage_mismatch');
  if ([...netRevenueByDay.keys()].some(key => !employeeDayKeys.has(key))) fail('personal_revenue_employee_coverage_mismatch');
  const employeeTotals = new Map();
  for (const employee of candidateCalculation.employees) {
    if (!id(employee?.employeeId) || !employeeNames.has(employee.employeeId) || employeeTotals.has(employee.employeeId)
        || !cents(employee.amountCents)) fail('employee_result_invalid');
    employeeTotals.set(employee.employeeId, BigInt(employee.amountCents));
  }
  const summedEmployees = [...employeeTotals.values()].reduce((sum, value) => sum + value, 0n);
  const summedDays = [...dailyTotals.values()].reduce((sum, value) => sum + value.amountCents, 0n);
  if (summedEmployees !== BigInt(candidateCalculation.amountCents) || summedDays !== summedEmployees) fail('total_reconciliation_failed');
  for (const [employeeId, amount] of employeeTotals) {
    const daily = [...dailyTotals.values()].reduce((sum, value) => sum + (value.employeeAmounts.get(employeeId) || 0n), 0n);
    if (daily !== amount) fail('employee_day_reconciliation_failed');
  }

  const lineSnapshots = [...calculatedLines.entries()].map(([lineId, { line }]) => {
    const raw = rawLines.get(lineId), sale = calculatorSales.get(lineId), projection = projectionLines.get(lineId);
    if (raw.orderId !== projection.orderId || raw.orderItemId !== projection.orderItemId || raw.sellerId !== projection.employeeId
        || raw.recognizedLocalDate !== projection.date || projection.currency !== scheme.currency
        || !Number.isSafeInteger(raw.grossMinor) || !Number.isSafeInteger(raw.discountMinor) || !Number.isSafeInteger(raw.netMinor)
        || raw.grossMinor - raw.discountMinor !== raw.netMinor || raw.netMinor !== sale.commissionBaseCents
        || (raw.productFacts?.productId && raw.productFacts.productId !== sale.menuItemId)) fail('raw_line_amount_mismatch');
    return { saleLineEventId: lineId, saleEventId: raw.saleEventId, orderId: raw.orderId, orderItemId: raw.orderItemId,
      employeeId: sale.employeeId, employeeName: employeeNames.get(sale.employeeId), localDate: sale.date, soldAt: raw.soldAt,
      productId: sale.menuItemId, productFacts: structuredClone(raw.productFacts || {}), department: sale.department,
      currency: scheme.currency, grossMinor: raw.grossMinor, discountMinor: raw.discountMinor, refundMinor: 0,
      recognizedNetMinor: raw.netMinor, turnoverCents: sale.turnoverCents, commissionBaseCents: sale.commissionBaseCents,
      commissionCents: line.commissionCents, appliedRateBps: line.appliedRateBps,
      ...(line.costSnapshot ? { costSnapshot: structuredClone(line.costSnapshot), signedMarginCents: line.signedMarginCents,
        costSourceWatermark: marginSource.sourceWatermark, producerWatermark: marginRows.get(lineId).producerWatermark } : {}),
      itemRuleId: line.itemRuleId || null, calculationEvidence: structuredClone(line),
      sourceWatermark: sourceBundle.recognitionManifest.watermark };
  }).sort((a, b) => a.localDate.localeCompare(b.localDate) || a.saleLineEventId.localeCompare(b.saleLineEventId));
  const snapshot = { schemaVersion: 1, snapshotKind: 'candidate_preview', candidateOnly: true, officialReady: false,
    payoutEligible: false, nonPayable: true, nonAccrual: true, persistence: 'none', venueId, schemeId: scheme.id,
    schemeVersionId: scheme.versionId, currency: scheme.currency, period: { from: period.from, to: period.to, timezone: venueTimezone },
    source: { inputWatermark: sourceWatermark, recognitionWatermark: sourceBundle.recognitionManifest.watermark,
      readinessWatermark: sourceBundle.readinessWatermark, projectionWatermark: sourceBundle.recognizedLineProjection.projectionWatermark || null },
    personalRevenueReconciliation: { status: 'matched', scope: 'no_refund_merchandise_net_only',
      sourceWatermark: fullNet.sourceWatermark, amountCents: fullNet.amount, employeeDayCount: employeeDayKeys.size },
    ...(personalSource ? { personalRevenueCeilingSource: structuredClone(personalSource) } : {}),
    candidateResultWatermark: digest(candidateCalculation),
    amountCents: candidateCalculation.amountCents,
    days: daySnapshots,
    employees: candidateCalculation.employees.map(row => ({ ...structuredClone(row), employeeName: employeeNames.get(row.employeeId) }))
      .sort((a, b) => a.employeeId.localeCompare(b.employeeId)),
    employeeDays: employeeDays.sort((a, b) => a.date.localeCompare(b.date) || a.employeeId.localeCompare(b.employeeId)),
    lines: lineSnapshots };
  snapshot.snapshotWatermark = digest(snapshot);
  return snapshot;
};

const periodDays = (from, to) => {
  const result = [];
  for (let current = from; current <= to; current = new Date(Date.parse(`${current}T00:00:00.000Z`) + 86400000).toISOString().slice(0, 10)) result.push(current);
  return result;
};

const verifyPayrollCandidateSnapshotBundle = ({ snapshot, candidateCalculation } = {}) => {
  if (!snapshot || !candidateCalculation || !SHA256.test(snapshot.snapshotWatermark || '')
      || !SHA256.test(snapshot.candidateResultWatermark || '')) return false;
  const snapshotCopy = structuredClone(snapshot); delete snapshotCopy.snapshotWatermark;
  return digest(candidateCalculation) === snapshot.candidateResultWatermark
    && digest(snapshotCopy) === snapshot.snapshotWatermark
    && snapshot.candidateOnly === true && snapshot.officialReady === false && snapshot.payoutEligible === false
    && snapshot.nonPayable === true && snapshot.nonAccrual === true && snapshot.persistence === 'none'
    && snapshot.amountCents === candidateCalculation.amountCents
    && snapshot.source?.inputWatermark === candidateCalculation.inputWatermark;
};

module.exports = { buildPayrollCandidateSnapshotBundle, verifyPayrollCandidateSnapshotBundle };
