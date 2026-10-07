'use strict';

const { validatePayrollSnapshotEvidence } = require('./payroll-snapshot-evidence');
const fail = (suffix) => { const code = `payroll_milestone_storage_${suffix}`; throw Object.assign(new TypeError(code), { code }); };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const plain = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail('context_invalid');
  for (const key of Reflect.ownKeys(value)) if (typeof key !== 'string' || ['__proto__', 'prototype', 'constructor'].includes(key)
    || !Object.hasOwn(Object.getOwnPropertyDescriptor(value,key), 'value')) fail('context_invalid');
};
const uuid = (value, canonical = false) => {
  if (typeof value !== 'string' || !UUID.test(value) || (canonical && value !== value.toLowerCase())) fail('uuid_invalid');
  return value.toLowerCase();
};
const date = (value) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail('date_invalid');
  const stamp = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(stamp) || new Date(stamp).toISOString().slice(0,10) !== value) fail('date_invalid');
  return value;
};
const decimal = (value) => {
  const cents = typeof value === 'bigint' ? value : Number.isSafeInteger(value) ? BigInt(value) : null;
  if (cents === null || cents < 0n || cents > 9999999999999999n) fail('money_invalid');
  return `${cents/100n}.${String(cents%100n).padStart(2,'0')}`;
};

// Pure DTO preparation, not source approval or permission to create a ready
// run. Approval identity is supplied context and needs transactional DB checks.
// key/dayKey are transient: the future atomic writer resolves them to UUIDs.
// Version 1 requires every envelope and decision to be stored, or total rollback.
const mapPayrollMilestoneStorageRows = (input) => {
  plain(input);
  const context = validatePayrollSnapshotEvidence(input);
  if (context.milestoneEvidence === undefined) return { milestoneEvidenceVersion: 0, daySnapshots: [], decisionSnapshots: [] };
  if (!Object.hasOwn(input,'attendance') || !Array.isArray(input.attendance)) fail('attendance_required');
  const approvalId = uuid(input.attendanceApprovalId);
  const approval = input.sourceAttendanceApproval; plain(approval);
  if (uuid(approval.approvalId) !== approvalId) fail('approval_identity_mismatch');
  const approvalFrom = date(approval.periodFrom), approvalThrough = date(approval.periodTo);
  if (approvalFrom !== `${input.result.periodFrom.slice(0,7)}-01` || approvalThrough < input.result.periodTo
    || approvalThrough.slice(0,7) !== approvalFrom.slice(0,7)) fail('approval_period_mismatch');
  if (Object.hasOwn(approval,'timezone') && approval.timezone !== context.venueTimezone) fail('approval_timezone_mismatch');
  if (Object.hasOwn(approval,'venueId') && uuid(approval.venueId) !== context.venueId) fail('approval_venue_mismatch');
  if (Object.hasOwn(input,'attendanceCoverage')) {
    const coverage = input.attendanceCoverage; plain(coverage);
    if (coverage.kind !== 'approved_attendance_complete' || coverage.complete !== true || coverage.from !== approvalFrom
      || coverage.through !== approvalThrough || typeof approval.sourceWatermark !== 'string' || !approval.sourceWatermark.trim()
      || coverage.watermark !== approval.sourceWatermark) fail('approval_coverage_mismatch');
  }
  for (const shift of input.attendance) {
    if (!Number.isSafeInteger(shift.plannedMinutes) || shift.plannedMinutes < 1 || shift.plannedMinutes > 1440) fail('attendance_minutes_invalid');
    const employeeId = uuid(shift.employeeId);
    if (!context.employeeById.has(employeeId)) fail('employee_context_mismatch');
    if (shift.date < approvalFrom || shift.date > approvalThrough) fail('attendance_period_mismatch');
  }
  const daySnapshots = [], decisionSnapshots = [], days = new Map(input.result.daily.map(day => [day.date,day]));
  for (const envelope of context.milestoneEvidence) {
    const day = days.get(envelope.date), key = `${context.runId}|${envelope.date}`;
    if (envelope.milestoneDecisions.length > 2147483647) fail('decision_count_overflow');
    const awarded = envelope.milestoneDecisions.reduce((total,row) => total+BigInt(row.awardedAmountCents),0n);
    daySnapshots.push({ key, venue_id: context.venueId, run_id: context.runId, local_date: envelope.date, attendance_approval_id: approvalId,
      previous_venue_turnover: decimal(BigInt(day.cumulativeVenueTurnoverCents)-BigInt(day.venueTurnoverCents)),
      cumulative_venue_turnover: decimal(day.cumulativeVenueTurnoverCents), decision_count: envelope.milestoneDecisions.length, awarded_total: decimal(awarded) });
    for (const row of envelope.milestoneDecisions) {
      if (row.approvedWorkedMinutes > 2147483647) fail('attendance_minutes_invalid');
      const employeeId = uuid(row.employeeId,true), employee = context.employeeById.get(employeeId);
      if (!employee) fail('employee_context_mismatch');
      decisionSnapshots.push({ dayKey: key, venue_id: context.venueId, run_id: context.runId, local_date: envelope.date,
        employee_id: employeeId, employee_name_snapshot: employee.name, role_key_snapshot: row.roleId,
        threshold_amount: decimal(row.thresholdCents), declared_bonus: decimal(row.declaredBonusCents), eligibility: row.eligibility,
        apply_milestones: row.applyMilestones, employee_active: row.employeeActive, eligible: row.eligible, reason: row.reason,
        approved_worked_minutes: row.approvedWorkedMinutes, awarded_amount: decimal(row.awardedAmountCents),
        qualifying_shift_ids: row.qualifyingShiftIds.map(shiftId => uuid(shiftId,true)) });
    }
  }
  return { milestoneEvidenceVersion: 1, daySnapshots, decisionSnapshots };
};
module.exports = { mapPayrollMilestoneStorageRows };
