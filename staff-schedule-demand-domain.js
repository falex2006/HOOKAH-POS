'use strict';

const { ScheduleError, UUID } = require('./staff-schedule-domain');
const fail = code => { throw new ScheduleError(code); };
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

function validDate(value) {
  if (typeof value !== 'string' || !DATE.test(value)) fail('schedule_demand_date_invalid');
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) fail('schedule_demand_date_invalid');
  return value;
}
function normalizeRule(input, timezone, previous = null) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('schedule_demand_input_invalid');
  if (!UUID.test(String(input.functionId || ''))) fail('schedule_demand_function_invalid');
  const scope = input.scope;
  if (!['weekly', 'date_range'].includes(scope)) fail('schedule_demand_scope_invalid');
  const weekday = scope === 'weekly' ? input.weekday : null;
  if (scope === 'weekly' && (!Number.isSafeInteger(weekday) || weekday < 1 || weekday > 7)) fail('schedule_demand_weekday_invalid');
  let effectiveFrom = null, effectiveTo = null;
  if (scope === 'date_range') {
    effectiveFrom = validDate(input.effectiveFrom);
    effectiveTo = validDate(input.effectiveTo);
    if (effectiveTo < effectiveFrom || Date.parse(`${effectiveTo}T00:00:00Z`) - Date.parse(`${effectiveFrom}T00:00:00Z`) > 365 * 86400000)
      fail('schedule_demand_range_invalid');
  }
  if (input.timezone !== undefined && input.timezone !== timezone) fail('schedule_timezone_changed');
  if (!TIME.test(input.startTime) || !TIME.test(input.endTime)) fail('schedule_demand_time_invalid');
  const endDayOffset = input.endDayOffset ?? 0;
  if (![0, 1].includes(endDayOffset) || (endDayOffset === 0 && input.endTime <= input.startTime)
      || (endDayOffset === 1 && input.endTime === input.startTime)) fail('schedule_demand_time_invalid');
  const requiredCount = input.requiredCount;
  if (!Number.isSafeInteger(requiredCount) || requiredCount < 1 || requiredCount > 100) fail('schedule_demand_count_invalid');
  const active = input.active === undefined ? true : input.active;
  if (typeof active !== 'boolean') fail('schedule_demand_active_invalid');
  return { id: previous?.id || null, functionId: String(input.functionId).toLowerCase(), scope, weekday,
    effectiveFrom, effectiveTo, startTime: input.startTime, endTime: input.endTime, endDayOffset,
    requiredCount, active, timezone };
}

function interval(rule) {
  const start = Number(rule.startTime.slice(0, 2)) * 60 + Number(rule.startTime.slice(3));
  const end = Number(rule.endTime.slice(0, 2)) * 60 + Number(rule.endTime.slice(3)) + rule.endDayOffset * 1440;
  return { start, end };
}
function overlaps(a, b) {
  if (a.functionId !== b.functionId || a.scope !== b.scope) return false;
  const x = interval(a), y = interval(b);
  if (a.scope === 'weekly') {
    const week = 7 * 1440, xStart = (a.weekday - 1) * 1440 + x.start, yStart = (b.weekday - 1) * 1440 + y.start;
    return [-week, 0, week].some(offset => xStart < yStart + offset + y.end - y.start
      && yStart + offset < xStart + x.end - x.start);
  }
  const first = a.effectiveFrom > b.effectiveFrom ? a.effectiveFrom : b.effectiveFrom;
  const last = a.effectiveTo < b.effectiveTo ? a.effectiveTo : b.effectiveTo;
  if (first <= last) {
    if (x.start < y.end && y.start < x.end) return true;
    if (first < last && (x.end > 1440 + y.start || y.end > 1440 + x.start)) return true;
  }
  const day = 86400000;
  if (a.effectiveTo < b.effectiveFrom && Date.parse(`${b.effectiveFrom}T00:00:00Z`) - Date.parse(`${a.effectiveTo}T00:00:00Z`) === day)
    return x.end > 1440 + y.start;
  if (b.effectiveTo < a.effectiveFrom && Date.parse(`${a.effectiveFrom}T00:00:00Z`) - Date.parse(`${b.effectiveTo}T00:00:00Z`) === day)
    return y.end > 1440 + x.start;
  return false;
}
function assertNoOverlap(candidate, rules) {
  if (!candidate.active) return;
  const active = rules.filter(rule => rule.active && !(candidate.id && rule.id === candidate.id));
  if (active.some(rule => overlaps(candidate, rule))) fail('schedule_demand_overlap');
  const all = [...active, candidate];
  const isCandidate = rule => rule === candidate || (candidate.id && rule.id === candidate.id);
  const sameDayOverlap = (a, b) => { const x=interval(a), y=interval(b); return x.start<y.end && y.start<x.end; };
  const crossesMidnight = (a, b) => interval(a).end > 1440 + interval(b).start;
  const spans = candidate.scope === 'date_range' ? [candidate] : active.filter(rule => rule.scope === 'date_range');
  const scanned = new Set();
  for (const span of spans) {
    const from = new Date(`${span.effectiveFrom}T12:00:00Z`), to = new Date(`${span.effectiveTo}T12:00:00Z`);
    from.setUTCDate(from.getUTCDate()-1); to.setUTCDate(to.getUTCDate()+1);
    for (let cursor=from;cursor<=to;cursor.setUTCDate(cursor.getUTCDate()+1)) scanned.add(cursor.toISOString().slice(0,10));
  }
  for (const date of scanned) {
    const day = resolveForDate(all,candidate.functionId,date);
    for (let i=0;i<day.length;i++) for (let j=i+1;j<day.length;j++)
      if ((isCandidate(day[i]) || isCandidate(day[j])) && sameDayOverlap(day[i],day[j])) fail('schedule_demand_overlap');
    const previous = resolveForDate(all,candidate.functionId,new Date(Date.parse(`${date}T12:00:00Z`)-86400000).toISOString().slice(0,10));
    for (const a of previous) for (const b of day)
      if ((isCandidate(a) || isCandidate(b)) && crossesMidnight(a,b)) fail('schedule_demand_overlap');
  }
}
function resolveForDate(rules, functionId, date) {
  validDate(date);
  const overrides = rules.filter(rule => rule.active && rule.functionId === functionId && rule.scope === 'date_range'
    && rule.effectiveFrom <= date && date <= rule.effectiveTo);
  const weekday = (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7 + 1;
  return (overrides.length ? overrides : rules.filter(rule => rule.active && rule.functionId === functionId
    && rule.scope === 'weekly' && rule.weekday === weekday)).slice().sort((a, b) => a.startTime.localeCompare(b.startTime) || a.id.localeCompare(b.id));
}

module.exports = { normalizeRule, overlaps, assertNoOverlap, resolveForDate };
