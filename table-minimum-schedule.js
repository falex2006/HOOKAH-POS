'use strict';

function normalizeTableMinimumSchedule(start, end) {
  const normalize = (value) => value === null || value === undefined || value === '' ? null : String(value);
  const minimumOrderStartTime = normalize(start);
  const minimumOrderEndTime = normalize(end);
  const valid = (value) => value === null || /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
  if (!valid(minimumOrderStartTime) || !valid(minimumOrderEndTime)
      || (minimumOrderStartTime === null) !== (minimumOrderEndTime === null)
      || (minimumOrderStartTime !== null && minimumOrderStartTime === minimumOrderEndTime)) return null;
  return { minimumOrderStartTime, minimumOrderEndTime };
}

function tableMinimumWindowActive(table, timezone, now = new Date()) {
  const schedule = normalizeTableMinimumSchedule(table.minimumOrderStartTime, table.minimumOrderEndTime);
  if (schedule?.minimumOrderStartTime === null) return true;
  if (!schedule) return false;
  let local;
  try {
    local = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone || 'Asia/Yekaterinburg',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    }).format(now);
  } catch (_) { return false; }
  return tableMinimumWindowActiveAtClock(schedule, local);
}

function tableMinimumForTime(table, timezone, now = new Date()) {
  return tableMinimumWindowActive(table, timezone, now) ? Number(table.minimumOrderTotal ?? table.minOrderTotal ?? 0) : 0;
}

function tableMinimumWindowActiveAtClock(table, localClock) {
  const schedule = normalizeTableMinimumSchedule(table.minimumOrderStartTime, table.minimumOrderEndTime);
  if (schedule?.minimumOrderStartTime === null) return true;
  if (!schedule) return false;
  const clock = String(localClock || '');
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(clock)) return false;
  return schedule.minimumOrderStartTime < schedule.minimumOrderEndTime
    ? clock >= schedule.minimumOrderStartTime && clock < schedule.minimumOrderEndTime
    : clock >= schedule.minimumOrderStartTime || clock < schedule.minimumOrderEndTime;
}

function tableMinimumForClock(table, localClock) {
  return tableMinimumWindowActiveAtClock(table, localClock) ? Number(table.minimumOrderTotal ?? table.minOrderTotal ?? 0) : 0;
}

module.exports = { normalizeTableMinimumSchedule, tableMinimumWindowActive, tableMinimumWindowActiveAtClock, tableMinimumForTime, tableMinimumForClock };
