'use strict';

class ScheduleError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}
const fail = (code, status) => { throw new ScheduleError(code, status); };
// PostgreSQL and the original seed permit canonical UUIDs without RFC version bits.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function date(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail('schedule_date_invalid');
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) fail('schedule_date_invalid');
  return value;
}
function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::00(?:\.000)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) fail('schedule_time_invalid');
  date(value.slice(0, 10));
  if (+value.slice(11, 13) > 23 || +value.slice(14, 16) > 59) fail('schedule_time_invalid');
  const offset = value.match(/[+-](\d{2}):(\d{2})$/);
  if (offset && (+offset[1] > 14 || +offset[2] > 59 || (+offset[1] === 14 && +offset[2] !== 0))) fail('schedule_time_invalid');
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) fail('schedule_time_invalid');
  return new Date(ms).toISOString();
}
function localDate(value, timezone) {
  let parts;
  try { parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(value)); }
  catch { fail('schedule_timezone_invalid'); }
  const part = type => parts.find(p => p.type === type).value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
function normalize(input, timezone) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('schedule_input_invalid');
  if (!UUID.test(String(input.userId || ''))) fail('schedule_employee_invalid');
  const workDate = date(input.workDate);
  const kind = input.kind || 'shift';
  if (!['shift', 'day_off', 'vacation', 'sick', 'other_absence'].includes(kind)) fail('schedule_kind_invalid');
  const note = input.note == null ? '' : input.note;
  if (typeof note !== 'string' || note.length > 500) fail('schedule_note_invalid');
  const breakMinutes = input.breakMinutes === undefined ? 0 : input.breakMinutes;
  if (!Number.isSafeInteger(breakMinutes) || breakMinutes < 0) fail('schedule_break_invalid');
  if (kind !== 'shift') {
    if (input.plannedStart != null || input.plannedEnd != null || breakMinutes !== 0) fail('schedule_absence_time_forbidden');
    return { userId: input.userId, workDate, kind, plannedStart: null, plannedEnd: null, breakMinutes: 0, note: note.trim() };
  }
  const plannedStart = timestamp(input.plannedStart);
  const plannedEnd = timestamp(input.plannedEnd);
  const duration = (Date.parse(plannedEnd) - Date.parse(plannedStart)) / 60000;
  if (duration <= 0 || duration > 1440) fail('schedule_duration_invalid');
  if (breakMinutes >= duration) fail('schedule_break_invalid');
  if (localDate(plannedStart, timezone) !== workDate) fail('schedule_start_date_mismatch');
  return { userId: input.userId, workDate, kind, plannedStart, plannedEnd, breakMinutes, note: note.trim() };
}
function range(from, to) {
  date(from); date(to);
  const days = (Date.parse(to) - Date.parse(from)) / 86400000;
  if (days < 0 || days > 92) fail('schedule_range_invalid');
  return { from, to };
}
function version(value) {
  if (!Number.isSafeInteger(value) || value < 1) fail('schedule_version_required');
  return value;
}
function capabilities(role, grant) {
  if (role === 'owner') return { view: true, manage: true, grant: true };
  if (!['admin', 'manager'].includes(role)) return { view: false, manage: false, grant: false };
  return { view: ['view', 'manage'].includes(grant), manage: grant === 'manage', grant: false };
}
module.exports = { ScheduleError, normalize, range, version, capabilities, localDate, UUID };
