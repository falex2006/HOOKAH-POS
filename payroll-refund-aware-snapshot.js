'use strict';

// Detached typed snapshot preparation for the explicit refund-aware v2 path.
// It is not persistence, source attestation, official readiness or payout authority.
const { createHash } = require('node:crypto');
const { buildPayrollRefundAwareCalculation } = require('./payroll-refund-aware-calculation');
const { mapPayrollTypedSnapshotRows } = require('./payroll-typed-snapshot-serializer');
const { mapPayrollMilestoneStorageRows } = require('./payroll-milestone-storage-serializer');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[a-f0-9]{64}$/;
const fail = code => { throw Object.assign(new TypeError(code), { code }); };
const stable = value => Array.isArray(value) ? `[${value.map(stable).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().filter(key => value[key] !== undefined)
    .map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}` : JSON.stringify(value);
const digest = value => createHash('sha256').update(stable(value)).digest('hex');
const freeze = value => { if (value && typeof value === 'object' && !Object.isFrozen(value)) {
  Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const cloneFreeze = value => freeze(structuredClone(value));
const exact = (a, b) => stable(a) === stable(b);

function buildPayrollRefundAwareSnapshot({ venueId, runId, ...sourceArgs } = {}) {
  const blocked = (code, calculation = null) => cloneFreeze({ schemaVersion: 2, status: 'blocked', officialReady: false,
    payoutEligible: false, sourceAttested: false, persistence: 'none', reasons: [code], verifiedCalculation: calculation,
    snapshotInput: null, mappedRows: null, milestoneRows: null, refundQuantityEvidence: null,
    sourceWatermark: null, snapshotInputWatermark: null });
  let calculation;
  try { calculation = buildPayrollRefundAwareCalculation({ venueId, ...sourceArgs }); }
  catch (error) { return blocked(error?.code || 'payroll_refund_aware_calculation_unavailable'); }
  if (calculation?.status !== 'refund_aware_calculated' || calculation.officialReady !== false
      || calculation.payoutEligible !== false || calculation.sourceAttested !== false || calculation.persistence !== 'none') {
    return blocked('payroll_refund_aware_calculation_unavailable', calculation);
  }
  try {
    if (!UUID.test(venueId || '') || !UUID.test(runId || '') || calculation.venueId !== venueId
        || !SHA.test(calculation.inputWatermark || '') || !SHA.test(calculation.calculationWatermark || '')) fail('context_invalid');
    const { scheme, period, periodClosure, recognitionEvidence, employmentEligibility, approvedAttendanceSource } = sourceArgs;
    const manifest = recognitionEvidence?.manifest, projection = calculation.economics?.projection;
    const input = calculation.input, result = calculation.engineResult;
    if (!manifest || manifest.status !== 'available' || manifest.officialReady !== false || !SHA.test(manifest.watermark || '')
        || !projection || projection.status !== 'projected' || projection.manifestWatermark !== manifest.watermark
        || input?.periodFrom !== period?.from || input?.periodTo !== period?.to || result?.periodFrom !== period.from
        || result?.periodTo !== period.to || result?.status !== 'ready') fail('source_binding_mismatch');
    const venueTimezone = periodClosure?.timezone;
    if (typeof venueTimezone !== 'string' || !venueTimezone.trim() || periodClosure.venueId !== venueId
        || periodClosure.period?.from !== period.from || periodClosure.period?.to !== period.to) fail('timezone_context_mismatch');

    const requiredEmployeeIds = new Set(input.employees.map(row => row?.id));
    if (requiredEmployeeIds.size !== input.employees.length || !Array.isArray(employmentEligibility?.periods)) fail('employee_source_missing');
    const names = new Map();
    for (const row of employmentEligibility.periods) {
      if (!requiredEmployeeIds.has(row?.employeeId)) continue;
      const name = typeof row.employeeName === 'string' ? row.employeeName.trim() : '';
      if (!name || (names.has(row.employeeId) && names.get(row.employeeId) !== name)) fail('employee_source_conflict');
      names.set(row.employeeId, name);
    }
    if (names.size !== requiredEmployeeIds.size) fail('employee_source_missing');
    const employees = [...names].map(([id, name]) => ({ id, name, venueId }));

    const sales = new Map(input.sales.map(row => [row.id, row]));
    const calcLines = new Map();
    for (const day of result.daily || []) for (const line of day.lines || []) {
      if (calcLines.has(line.lineId)) fail('calculated_line_duplicate');
      calcLines.set(line.lineId, { day, line });
    }
    const projectedInPeriod = projection.saleLines.filter(row => row.inEarningPeriod);
    if (sales.size !== input.sales.length || projectedInPeriod.length !== sales.size || calcLines.size !== sales.size) fail('sale_coverage_mismatch');
    const manifestLines = new Map();
    const costByLine = new Map((calculation.costs?.rows || []).map(row => [row.saleLineEventId, row]));
    for (const raw of manifest.saleLines || []) {
      if (!raw?.saleLineEventId || manifestLines.has(raw.saleLineEventId)) fail('manifest_sale_duplicate');
      manifestLines.set(raw.saleLineEventId, raw);
    }
    if (manifestLines.size !== projectedInPeriod.length) fail('sale_coverage_mismatch');

    const sourceLines = [], returnEvidence = [];
    const refundEventsBySaleLine = new Map();
    for (const refundLine of projection.recognitionHistory?.refundLines || []) {
      if (!refundEventsBySaleLine.has(refundLine.originalSaleLineEventId)) refundEventsBySaleLine.set(refundLine.originalSaleLineEventId, new Set());
      refundEventsBySaleLine.get(refundLine.originalSaleLineEventId).add(refundLine.refundEventId);
    }
    for (const projected of projectedInPeriod) {
      const id = projected.saleLineEventId, sale = sales.get(id), raw = manifestLines.get(id), calculated = calcLines.get(id);
      if (!sale || !raw || !calculated || projected.recognizedLocalDate !== sale.date
          || projected.sellerId !== sale.employeeId || projected.productFacts?.productId !== sale.menuItemId
          || projected.remainingNetCents !== sale.commissionBaseCents || projected.remainingNetCents !== sale.turnoverCents
          || projected.refundCents !== projected.netMinor - projected.remainingNetCents
          || raw.orderId !== projected.orderId || raw.orderItemId !== projected.orderItemId
          || raw.sellerId !== projected.sellerId || raw.recognizedAt !== projected.recognizedAt
          || raw.recognizedLocalDate !== projected.recognizedLocalDate || raw.timezoneSnapshot !== projected.timezoneSnapshot
          || raw.soldAt !== projected.soldAt || raw.quantity !== projected.quantity || raw.grossMinor !== projected.grossMinor
          || raw.discountMinor !== projected.discountMinor || raw.netMinor !== projected.netMinor
          || !exact(raw.productFacts, projected.productFacts)) fail('manifest_projection_binding_mismatch');
      const roleId = calculated.line.roleId;
      if (calculated.day.date !== sale.date || calculated.line.employeeId !== sale.employeeId
          || calculated.line.menuItemId !== sale.menuItemId || calculated.line.commissionBaseCents !== sale.commissionBaseCents
          || calculated.line.turnoverCents !== sale.turnoverCents || typeof roleId !== 'string' || !roleId.trim()) fail('calculation_line_binding_mismatch');
      const sourceLine = { id, orderId: projected.orderId, orderItemId: projected.orderItemId,
        employeeId: projected.sellerId, menuItemId: projected.productFacts.productId,
        menuItemName: projected.productFacts.productName, department: sale.department, roleId,
        localDate: projected.recognizedLocalDate, soldAt: projected.soldAt, recognizedAt: projected.recognizedAt,
        recognizedLocalDate: projected.recognizedLocalDate, timezoneSnapshot: projected.timezoneSnapshot,
        quantity: projected.quantity, grossCents: projected.grossMinor, discountCents: projected.discountMinor,
        refundCents: projected.refundCents, commissionBaseCents: projected.remainingNetCents,
        turnoverCents: sale.turnoverCents, venueId,
        ...(sale.costSnapshot ? { costSnapshot: structuredClone(sale.costSnapshot) } : {}) };
      sourceLines.push(sourceLine);
      returnEvidence.push({ saleLineEventId: id, orderId: projected.orderId, orderItemId: projected.orderItemId,
        originalSaleEventId: projected.saleEventId, sellerId: projected.sellerId,
        recognizedAt: projected.recognizedAt, recognizedLocalDate: projected.recognizedLocalDate,
        timezoneSnapshot: projected.timezoneSnapshot, originalQuantity: projected.quantity,
        returnedQuantity: projected.cumulativeReturnedQuantity, remainingQuantity: projected.remainingQuantity,
        originalGrossMinor: projected.grossMinor, originalDiscountMinor: projected.discountMinor,
        originalNetMinor: projected.netMinor, refundCents: projected.refundCents,
        remainingNetCents: projected.remainingNetCents, refundLineEventIds: projected.refundLineEventIds.slice(),
        refundEventIds: [...(refundEventsBySaleLine.get(id) || [])].sort(),
        manifestWatermark: manifest.watermark, economicWatermark: calculation.economics.sourceWatermark,
        producerWatermark: costByLine.get(id)?.producerWatermark || null });
    }
    const snapshotInput = { venueId, runId, venueTimezone, result: structuredClone(result), employees, sourceLines,
      ...(Array.isArray(input.attendance) ? { attendance: structuredClone(input.attendance) } : {}),
      ...(input.attendanceCoverage ? { attendanceCoverage: structuredClone(input.attendanceCoverage) } : {}),
      ...(Array.isArray(input.attendance) && approvedAttendanceSource?.sourceAttendanceApproval ? {
        sourceAttendanceApproval: structuredClone(approvedAttendanceSource.sourceAttendanceApproval),
        attendanceApprovalId: approvedAttendanceSource.sourceAttendanceApproval.approvalId } : {}) };
    const mappedRows = mapPayrollTypedSnapshotRows(snapshotInput);
    const milestoneRows = mapPayrollMilestoneStorageRows(snapshotInput);
    const refundQuantityEvidence = { schemaVersion: 2, capabilityVersion: calculation.capabilityVersion,
      policyVersion: scheme.sourcePolicies.schemaVersion, manifestWatermark: manifest.watermark,
      projectionWatermark: projection.projectionWatermark, economicWatermark: calculation.economics.sourceWatermark,
      producerWatermarks: [...new Set(returnEvidence.map(row => row.producerWatermark).filter(Boolean))].sort(),
      lines: returnEvidence };
    const sourceWatermark = calculation.inputWatermark;
    const snapshotInputWatermark = digest({ schemaVersion: 2, sourceWatermark,
      calculationWatermark: calculation.calculationWatermark, snapshotInput, mappedRows, milestoneRows, refundQuantityEvidence });
    return cloneFreeze({ schemaVersion: 2, status: 'refund_aware_snapshot_input', officialReady: false,
      payoutEligible: false, sourceAttested: false, persistence: 'none', reasons: [], sourceWatermark,
      calculationWatermark: calculation.calculationWatermark, snapshotInputWatermark,
      verifiedCalculation: calculation, snapshotInput, mappedRows, milestoneRows, refundQuantityEvidence });
  } catch (error) {
    return blocked(error?.code || 'payroll_refund_aware_snapshot_mapping_failed', calculation);
  }
}

module.exports = { buildPayrollRefundAwareSnapshot };
