'use strict';

// Builds detached typed snapshot DTOs only from a server-side source bundle.
// This is evidence preparation, not an official run or persistence capability.
const { createHash } = require('node:crypto');
const { buildPayrollVerifiedCalculation } = require('./payroll-verified-calculation');
const { mapPayrollTypedSnapshotRows } = require('./payroll-typed-snapshot-serializer');
const { mapPayrollMilestoneStorageRows } = require('./payroll-milestone-storage-serializer');
const fail = code => { throw Object.assign(new TypeError(code), { code }); };
const stable = value => Array.isArray(value) ? `[${value.map(stable).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().filter(key => value[key] !== undefined)
    .map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}` : JSON.stringify(value);
const digest = value => createHash('sha256').update(stable(value)).digest('hex');
const freeze = value => { if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(freeze); return Object.freeze(value); };
const cloneFreeze = value => freeze(structuredClone(value));

const buildPayrollVerifiedSnapshotInput = ({ venueId, runId, venueTimezone, scheme, period, readiness, attestations = {}, sourceBundle, periodClosure } = {}) => {
  const blocked = (reason, reasons = [reason]) => cloneFreeze({ schemaVersion: 1, status: 'blocked', officialReady: false,
    payoutEligible: false, persistence: 'none', reasons: [...new Set(reasons.filter(code => typeof code === 'string' && /^[A-Za-z0-9_]+$/.test(code)))].sort(),
    verifiedCalculation: null, snapshotInput: null, mappedRows: null, sourceWatermark: null, snapshotInputWatermark: null });
  let verified;
  try { verified = buildPayrollVerifiedCalculation({ venueId, scheme, period, readiness, attestations, sourceBundle, periodClosure }); }
  catch (_) { return blocked('payroll_verified_snapshot_calculation_unavailable'); }
  if (verified.status !== 'verified_calculation' || verified.officialReady !== false || verified.payoutEligible !== false
      || verified.persistence !== 'none') return blocked('payroll_verified_snapshot_calculation_unavailable', verified.reasons || []);
  try {
    const manifest = sourceBundle?.recognitionManifest, input = verified.input, result = verified.engineResult;
    if (!manifest || manifest.status !== 'available' || manifest.officialReady !== false
        || typeof manifest.watermark !== 'string' || !/^[a-f0-9]{64}$/.test(manifest.watermark)
        || sourceBundle.inputWatermark !== verified.inputWatermark) fail('source_binding_mismatch');
    const employeePeriods = sourceBundle.employmentEligibility?.periods;
    if (!Array.isArray(employeePeriods) || !Array.isArray(input.employees)) fail('employee_source_missing');
    if (venueTimezone !== readiness?.period?.timezone || venueTimezone !== periodClosure?.timezone) fail('timezone_context_mismatch');
    const requiredEmployeeIds = new Set(input.employees.map(employee => employee?.id));
    const employeeNames = new Map();
    for (const row of employeePeriods) {
      if (!requiredEmployeeIds.has(row?.employeeId)) continue;
      const name = typeof row.employeeName === 'string' ? row.employeeName.trim() : '';
      if (!name || (employeeNames.has(row.employeeId) && employeeNames.get(row.employeeId) !== name)) fail('employee_source_conflict');
      employeeNames.set(row.employeeId, name);
    }
    if (employeeNames.size !== requiredEmployeeIds.size) fail('employee_source_missing');
    const employees = [...employeeNames].map(([id, name]) => ({ id, name, venueId }));
    const sales = new Map(input.sales.map(sale => [sale.id, sale]));
    if (sales.size !== input.sales.length || !Array.isArray(manifest.saleLines)) fail('sale_coverage_mismatch');
    const manifestIds = new Set();
    for (const raw of manifest.saleLines) {
      if (manifestIds.has(raw?.saleLineEventId)) fail('manifest_sale_duplicate');
      manifestIds.add(raw?.saleLineEventId);
    }
    if (manifestIds.size !== sales.size || [...sales.keys()].some(id => !manifestIds.has(id))) fail('sale_coverage_mismatch');
    const from = result.periodFrom, to = result.periodTo;
    const periodSales = new Map([...sales].filter(([, sale]) => sale.date >= from && sale.date <= to));
    const calcLines = new Map();
    for (const day of result.daily) for (const line of day.lines || []) {
      if (calcLines.has(line.lineId)) fail('calculated_line_duplicate');
      calcLines.set(line.lineId, { day, line });
    }
    if (calcLines.size !== periodSales.size || manifest.saleLines.length !== sales.size) fail('sale_coverage_mismatch');
    const sourceLines = manifest.saleLines.filter(raw => raw.recognizedLocalDate >= from && raw.recognizedLocalDate <= to).map(raw => {
      const sale = sales.get(raw.saleLineEventId), calculated = calcLines.get(raw.saleLineEventId);
      if (!periodSales.has(raw.saleLineEventId) || !sale || !calculated || raw.sellerId !== sale.employeeId || raw.recognizedLocalDate !== sale.date
          || raw.netMinor !== sale.commissionBaseCents || raw.grossMinor - raw.discountMinor !== raw.netMinor
          || raw.productFacts?.productId !== sale.menuItemId || calculated.day.date !== sale.date
          || calculated.line.employeeId !== sale.employeeId || calculated.line.commissionBaseCents !== sale.commissionBaseCents
          || calculated.line.turnoverCents !== sale.turnoverCents) fail('manifest_calculation_binding_mismatch');
      const roleId = calculated.line.roleId;
      if (typeof roleId !== 'string' || !roleId.trim()) fail('calculated_role_missing');
      if (typeof raw.soldAt !== 'string' || typeof raw.recognizedAt !== 'string'
          || typeof raw.recognizedLocalDate !== 'string' || typeof raw.timezoneSnapshot !== 'string') fail('recognition_time_evidence_missing');
      return { id: raw.saleLineEventId, orderId: raw.orderId, orderItemId: raw.orderItemId,
        employeeId: raw.sellerId, menuItemId: raw.productFacts.productId,
        menuItemName: raw.productFacts.productName, department: sale.department, roleId,
        localDate: raw.recognizedLocalDate, soldAt: raw.soldAt, recognizedAt: raw.recognizedAt,
        recognizedLocalDate: raw.recognizedLocalDate, timezoneSnapshot: raw.timezoneSnapshot,
        quantity: raw.quantity, grossCents: raw.grossMinor, discountCents: raw.discountMinor,
        refundCents: raw.grossMinor - raw.discountMinor - raw.netMinor, commissionBaseCents: raw.netMinor,
        turnoverCents: sale.turnoverCents, venueId,
        ...(sale.costSnapshot ? { costSnapshot: structuredClone(sale.costSnapshot) } : {}) };
    });
    if (sourceLines.length !== periodSales.size) fail('sale_coverage_mismatch');
    const snapshotInput = { venueId, runId, venueTimezone, result: structuredClone(result), employees, sourceLines,
      ...(Array.isArray(input.attendance) ? { attendance: structuredClone(input.attendance) } : {}),
      ...(input.attendanceCoverage ? { attendanceCoverage: structuredClone(input.attendanceCoverage) } : {}),
      ...(sourceBundle.sourceAttendanceApproval ? { sourceAttendanceApproval: structuredClone(sourceBundle.sourceAttendanceApproval),
        attendanceApprovalId: sourceBundle.sourceAttendanceApproval.approvalId } : {}) };
    const mappedRows = mapPayrollTypedSnapshotRows(snapshotInput);
    const milestoneRows = mapPayrollMilestoneStorageRows(snapshotInput);
    const sourceWatermark = verified.inputWatermark;
    const snapshotInputWatermark = digest({ schemaVersion: 1, sourceWatermark, calculationWatermark: verified.calculationWatermark,
      snapshotInput, mappedRows, milestoneRows });
    return cloneFreeze({ schemaVersion: 1, status: 'verified_snapshot_input', officialReady: false, payoutEligible: false,
      persistence: 'none', reasons: [], sourceWatermark, calculationWatermark: verified.calculationWatermark,
      snapshotInputWatermark, verifiedCalculation: verified, snapshotInput, mappedRows, milestoneRows });
  } catch (error) {
    return blocked(error?.code || 'payroll_verified_snapshot_mapping_failed');
  }
};

module.exports = { buildPayrollVerifiedSnapshotInput };
