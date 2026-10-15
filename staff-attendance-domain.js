'use strict';

// Pure admission rules. Inputs are server-resolved data, never browser authority.
// Admission does not create cash shifts, change plans, or approve paid time.
class AttendanceError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}
const fail = (code, status) => { throw new AttendanceError(code, status); };
const MODES = Object.freeze(['free', 'warn', 'approval']);
function preparationMinutes(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 240) fail('attendance_preparation_invalid');
  return value;
}
function policy(input = { mode: 'free', preparationMinutes: 0 }) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !['mode', 'preparationMinutes'].includes(key))
    || !MODES.includes(input.mode)) fail('attendance_policy_invalid');
  return { mode: input.mode, preparationMinutes: preparationMinutes(input.preparationMinutes) };
}
function instant(value) {
  if (typeof value !== 'string') fail('attendance_instant_invalid');
  const parts = value.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-](\d{2}):(\d{2}))$/);
  if (!parts || +parts[2] > 23 || +parts[3] > 59 || +(parts[4] || 0) > 59
    || +(parts[7] || 0) > 14 || +(parts[8] || 0) > 59
    || (+parts[7] === 14 && +parts[8] !== 0)) fail('attendance_instant_invalid');
  const date = new Date(`${parts[1]}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== parts[1]) fail('attendance_instant_invalid');
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) fail('attendance_instant_invalid');
  return ms;
}
function reason(value) {
  if (typeof value !== 'string' || value.trim().length < 3 || value.trim().length > 500) fail('attendance_reason_required');
  return value.trim();
}
function evaluate({ settings, now, userId, shifts, scheduleAvailable = true }) {
  const rules = policy(settings);
  if (typeof userId !== 'string' || !userId) fail('attendance_employee_invalid');
  const at = instant(now);
  // A data failure is not an empty schedule, even when the UI offers an exception.
  if (!scheduleAvailable || !Array.isArray(shifts)) fail('attendance_schedule_unavailable', 503);
  // Published schedules live in staff_schedules with status=planned;
  // unpublished planning drafts live in a separate table and are never inputs.
  const windows = shifts.filter(item => item.kind === 'shift' && item.status === 'planned' && item.userId === userId)
    .map(item => {
      const start = instant(item.plannedStart), end = instant(item.plannedEnd);
      if (end <= start) fail('attendance_schedule_invalid', 503);
      // Snapshot override must come from the persisted published shift, not its mutable template.
      const minutes = item.preparationMinutes == null ? rules.preparationMinutes : preparationMinutes(item.preparationMinutes);
      return { id: item.id, start, end, allowedFrom: start - minutes * 60000, minutes };
    });
  // Prefer a currently running shift over preparation for a later shift.
  const matching = windows.filter(item => item.allowedFrom <= at && at < item.end)
    .sort((a, b) => Number(at < a.start) - Number(at < b.start) || a.start - b.start || String(a.id).localeCompare(String(b.id)))[0];
  if (matching) return {
    decision: 'allow', basis: at < matching.start ? 'preparation' : 'scheduled',
    scheduleId: matching.id, plannedStart: new Date(matching.start).toISOString(),
    plannedEnd: new Date(matching.end).toISOString(), allowedFrom: new Date(matching.allowedFrom).toISOString(),
    preparationMinutes: matching.minutes, lateMinutes: Math.max(0, Math.floor((at - matching.start) / 60000))
  };
  const upcoming = windows.filter(item => item.allowedFrom > at).sort((a, b) => a.allowedFrom - b.allowedFrom)[0];
  return {
    decision: rules.mode === 'free' ? 'allow' : rules.mode === 'warn' ? 'reason_required' : 'approval_required',
    basis: 'outside_schedule', scheduleId: null,
    nextAllowedFrom: upcoming ? new Date(upcoming.allowedFrom).toISOString() : null
  };
}
module.exports = { AttendanceError, MODES, policy, preparationMinutes, reason, evaluate };
