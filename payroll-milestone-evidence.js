'use strict';

// Replays declared arithmetic and attendance references. It does not prove the
// declared scheme, roster, turnover, or attendance came from official sources.
const MAX = BigInt(Number.MAX_SAFE_INTEGER);
const KEYS = ['employeeId', 'roleId', 'date', 'thresholdCents', 'declaredBonusCents', 'previousTurnoverCents',
  'cumulativeTurnoverCents', 'applyMilestones', 'employeeActive', 'eligibility', 'qualifyingShiftIds',
  'approvedWorkedMinutes', 'eligible', 'reason', 'awardedAmountCents'];
const fail = (suffix) => { const code = `payroll_milestone_evidence_${suffix}`; throw Object.assign(new TypeError(code), { code }); };
const plain = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail('object_invalid');
  for (const key of Reflect.ownKeys(value)) if (typeof key !== 'string' || ['__proto__', 'prototype', 'constructor'].includes(key)
    || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value')) fail('object_invalid');
};
const id = (value) => { if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > 160) fail('id_invalid'); return value; };
const date = (value) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail('date_invalid');
  const stamp = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(stamp) || new Date(stamp).toISOString().slice(0, 10) !== value) fail('date_invalid');
  return value;
};
const integer = (value) => { if (!Number.isSafeInteger(value) || value < 0) fail('integer_invalid'); return BigInt(value); };
const bool = (value) => { if (typeof value !== 'boolean') fail('boolean_invalid'); return value; };
const equal = (a, b, suffix) => { if (a !== b) fail(suffix); };
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const bounded = (value) => { if (value > MAX) fail('sum_overflow'); return value; };
const typedArray = (value, suffix) => {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) fail(suffix);
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string' || (key !== 'length' && !/^(0|[1-9][0-9]*)$/.test(key))
    || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value')) || keys.length !== value.length + 1) fail(suffix);
  return value;
};
const normalizePayrollMilestoneEvidence = (result, context = {}) => {
  plain(result); typedArray(result.daily, 'result_invalid');
  for (const day of result.daily) plain(day);
  if (!result.daily.some(day => Object.hasOwn(day, 'milestoneDecisions'))) return undefined;
  const from = date(result.periodFrom), through = date(result.periodTo);
  if (from > through || from.slice(0, 7) !== through.slice(0, 7)) fail('period_invalid');
  plain(context);
  const hasAttendance = Object.hasOwn(context, 'attendance');
  if (hasAttendance) typedArray(context.attendance, 'attendance_invalid');
  const attendanceDays = new Map(), attendanceIds = new Set();
  if (hasAttendance) for (const row of context.attendance) {
    plain(row); const shiftId = id(row.id), employeeId = id(row.employeeId), current = date(row.date);
    if (attendanceIds.has(shiftId)) fail('attendance_duplicate'); attendanceIds.add(shiftId);
    bool(row.approved); integer(row.workedMinutes); const planned = integer(row.plannedMinutes);
    if (planned === 0n || row.workedMinutes > row.plannedMinutes) fail('attendance_invalid');
    if (row.approved && row.workedMinutes > 0) {
      const key = JSON.stringify([current, employeeId]), rows = attendanceDays.get(key) || [];
      rows.push({ id: shiftId, minutes: row.workedMinutes }); attendanceDays.set(key, rows);
    }
  }
  const normalized = [], dates = new Set(), periodBonuses = new Map(), wageShiftIds = new Set();
  let previousDay = null, previousCumulative = null;
  for (const day of result.daily) {
    typedArray(day.milestoneDecisions, 'day_invalid'); typedArray(day.employees, 'day_invalid');
    const current = date(day.date);
    if (dates.has(current) || current < from || current > through || !Array.isArray(day.milestoneDecisions) || !Array.isArray(day.employees)) fail('day_invalid');
    if (previousDay !== null && Date.parse(`${current}T00:00:00Z`) - Date.parse(`${previousDay}T00:00:00Z`) !== 86400000) fail('day_sequence_invalid');
    dates.add(current);
    const cumulative = integer(day.cumulativeVenueTurnoverCents), turnover = integer(day.venueTurnoverCents);
    if (turnover > cumulative) fail('turnover_invalid');
    const previous = cumulative - turnover;
    if (previousCumulative !== null) equal(previous, previousCumulative, 'turnover_continuity');
    else if (from.endsWith('-01')) equal(previous, 0n, 'month_start_turnover');
    previousDay = current; previousCumulative = cumulative;
    const employees = new Map(), wageShifts = new Map();
    for (const row of day.employees) {
      plain(row);
      const employeeId = id(row.employeeId); if (employees.has(employeeId)) fail('employee_duplicate'); employees.set(employeeId, row);
      integer(row.milestoneBonusCents);
      typedArray(row.shiftDetails, 'shift_details_invalid');
      const rows = [], ids = new Set();
      for (const shift of row.shiftDetails) {
        plain(shift);
        const shiftId = id(shift.shiftId); if (ids.has(shiftId) || wageShiftIds.has(shiftId)) fail('shift_duplicate'); ids.add(shiftId); wageShiftIds.add(shiftId);
        const worked = integer(shift.workedMinutes), planned = integer(shift.plannedMinutes); if (planned === 0n) fail('shift_invalid');
        if (worked > 0n) rows.push({ id: shiftId, minutes: shift.workedMinutes });
      }
      wageShifts.set(employeeId, rows);
    }
    const decisions = [], seen = new Set(), bonuses = new Map();
    for (const row of day.milestoneDecisions) {
      plain(row);
      if (Object.keys(row).length !== KEYS.length || KEYS.some(key => !Object.hasOwn(row, key))) fail('decision_shape_invalid');
      const employeeId = id(row.employeeId), roleId = id(row.roleId); equal(date(row.date), current, 'decision_date_mismatch');
      const threshold = integer(row.thresholdCents), bonus = integer(row.declaredBonusCents), award = integer(row.awardedAmountCents);
      if (bonus === 0n || !(previous < threshold && cumulative >= threshold)) fail('crossing_invalid');
      equal(integer(row.previousTurnoverCents), previous, 'previous_turnover_mismatch'); equal(integer(row.cumulativeTurnoverCents), cumulative, 'cumulative_turnover_mismatch');
      const key = JSON.stringify([employeeId, row.thresholdCents]); if (seen.has(key)) fail('decision_duplicate'); seen.add(key);
      if (!['all_active', 'worked_on_threshold_day'].includes(row.eligibility)) fail('eligibility_invalid');
      const enabled = bool(row.applyMilestones), active = bool(row.employeeActive), eligible = bool(row.eligible);
      const worked = integer(row.approvedWorkedMinutes);
      typedArray(row.qualifyingShiftIds, 'qualifying_shifts_invalid');
      const declaredIds = row.qualifyingShiftIds.map(id), unique = new Set(declaredIds);
      if (unique.size !== declaredIds.length || declaredIds.some((value, index) => index > 0 && compare(declaredIds[index-1], value) >= 0)) fail('qualifying_shifts_invalid');
      if ((worked > 0n) !== (declaredIds.length > 0)) fail('worked_minutes_mismatch');
      const employee = employees.get(employeeId);
      if (employee && employee.roleId !== roleId) fail('role_mismatch');
      if (!hasAttendance && (!employee || employee.mode === 'percent_only')) fail('attendance_context_required');
      const shifts = hasAttendance ? attendanceDays.get(JSON.stringify([current, employeeId])) || [] : wageShifts.get(employeeId);
      if (hasAttendance && employee && employee.mode !== 'percent_only') {
        const sourceRows = shifts.map(shift => [shift.id, shift.minutes]).sort((a,b) => compare(a[0],b[0]));
        const wageRows = wageShifts.get(employeeId).map(shift => [shift.id, shift.minutes]).sort((a,b) => compare(a[0],b[0]));
        if (JSON.stringify(sourceRows) !== JSON.stringify(wageRows)) fail('wage_attendance_mismatch');
      }
      const expectedIds = shifts.map(shift => shift.id).sort(compare);
      if (JSON.stringify(declaredIds) !== JSON.stringify(expectedIds)) fail('attendance_set_mismatch');
      equal(worked, bounded(shifts.reduce((sum, shift) => sum + integer(shift.minutes), 0n)), 'worked_minutes_mismatch');
      const expectedEligible = enabled && active && (row.eligibility === 'all_active' || worked > 0n);
      equal(eligible, expectedEligible, 'eligibility_gate_mismatch');
      const reason = !enabled ? 'milestones_disabled' : !active ? 'employee_inactive' : !expectedEligible ? 'no_approved_positive_work_on_threshold_day' : 'eligible';
      equal(row.reason, reason, 'reason_mismatch'); equal(award, expectedEligible ? bonus : 0n, 'award_mismatch');
      if (award > 0n && !employee) fail('awarded_employee_missing');
      bonuses.set(employeeId, bounded((bonuses.get(employeeId) || 0n) + award));
      const detached = {}; for (const field of KEYS) detached[field] = field === 'qualifyingShiftIds' ? [...declaredIds] : row[field]; decisions.push(detached);
    }
    for (const [employeeId, row] of employees) {
      equal(integer(row.milestoneBonusCents), bonuses.get(employeeId) || 0n, 'daily_bonus_mismatch');
      periodBonuses.set(employeeId, bounded((periodBonuses.get(employeeId) || 0n) + integer(row.milestoneBonusCents)));
    }
    normalized.push({ date: current, milestoneDecisions: decisions.sort((a,b) => compare(a.employeeId,b.employeeId) || a.thresholdCents-b.thresholdCents) });
  }
  if (previousDay !== through || normalized[0]?.date !== from) fail('period_coverage_invalid');
  typedArray(result.employees, 'period_employees_invalid');
  const periodIds = new Set();
  for (const row of result.employees) {
    plain(row);
    const employeeId = id(row.employeeId); if (periodIds.has(employeeId)) fail('period_employee_duplicate'); periodIds.add(employeeId);
    equal(integer(row.milestoneBonusCents), periodBonuses.get(employeeId) || 0n, 'period_bonus_mismatch'); periodBonuses.delete(employeeId);
  }
  if (periodBonuses.size) fail('period_employee_missing');
  return normalized;
};
module.exports = { normalizePayrollMilestoneEvidence };
