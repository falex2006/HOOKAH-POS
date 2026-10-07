'use strict';

// Configuration risk only: this does not authorize payment or attest sources.
const fail = (suffix) => {
  const code = `payroll_personal_cap_${suffix}`;
  throw Object.assign(new TypeError(code), { code });
};
const plain = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) fail('definition_invalid');
};
const inspect = (value, ancestors = new Set()) => {
  if (value === null || typeof value !== 'object') {
    if (!['undefined', 'string', 'number', 'boolean'].includes(typeof value) && value !== null) fail('definition_invalid');
    return;
  }
  if (ancestors.has(value)) fail('definition_invalid');
  if (!Array.isArray(value)) plain(value);
  else if (Object.getPrototypeOf(value) !== Array.prototype) fail('definition_invalid');
  ancestors.add(value);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || ['__proto__', 'prototype', 'constructor'].includes(key)) fail('definition_invalid');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!Object.hasOwn(descriptor, 'value')) fail('definition_invalid');
    inspect(descriptor.value, ancestors);
  }
  ancestors.delete(value);
};
const date = (value) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail('window_invalid');
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) fail('window_invalid');
  return value;
};
const uuid = (value) => {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) fail('employee_invalid');
  return value.toLowerCase();
};
const rate = (value) => {
  if (!Number.isSafeInteger(value) || value < 0 || value > 10000) fail('rate_invalid');
  return value;
};
const window = (row, defaults, requireFrom = false) => {
  const from = date(requireFrom ? row.effectiveFrom : row.effectiveFrom ?? defaults.from);
  const to = row.effectiveTo == null ? defaults.to : date(row.effectiveTo);
  if (to !== null && to < from) fail('window_invalid');
  return { from, to };
};
const intersects = (a, b) => (a.to === null || b.from <= a.to) && (b.to === null || a.from <= b.to);
const intersection = (a, b) => {
  if (!intersects(a, b)) return null;
  return { from: a.from > b.from ? a.from : b.from,
    to: a.to === null ? b.to : b.to === null ? a.to : a.to < b.to ? a.to : b.to };
};
const codeUnitCompare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const checkGroupedWindows = (groups, error) => {
  for (const rows of groups.values()) {
    rows.sort((a, b) => codeUnitCompare(a.from, b.from));
    for (let i = 1; i < rows.length; i++) if (intersects(rows[i - 1], rows[i])) fail(error);
  }
};

const collectPersonalCapIncreases = (definition) => {
  inspect(definition); plain(definition); plain(definition.roleParameters);
  const version = { from: date(definition.effectiveFrom), to: definition.effectiveTo == null ? null : date(definition.effectiveTo) };
  if (version.to !== null && version.to < version.from) fail('window_invalid');
  const assignmentRows = definition.roleAssignments ?? [];
  const overrideRows = definition.employeeOverrides ?? [];
  if (!Array.isArray(assignmentRows) || !Array.isArray(overrideRows)
      || assignmentRows.length + overrideRows.length > 15000) fail('definition_invalid');
  const assignments = assignmentRows.map((row) => {
    plain(row);
    if (typeof row.roleId !== 'string' || !row.roleId || !Object.hasOwn(definition.roleParameters, row.roleId)) fail('role_invalid');
    return { employeeId: uuid(row.employeeId), roleId: row.roleId, ...window(row, version, true) };
  });
  const assignmentWindows = new Map();
  for (const row of assignments) {
    const prior = assignmentWindows.get(row.employeeId) || [];
    prior.push(row); assignmentWindows.set(row.employeeId, prior);
  }
  checkGroupedWindows(assignmentWindows, 'assignment_ambiguous');
  const overrideWindows = new Map();
  const normalizedOverrides = [];
  for (const row of overrideRows) {
    plain(row);
    const employeeId = uuid(row.employeeId);
    if (typeof row.path !== 'string' || !row.path || !['inherit', 'override'].includes(row.mode)) fail('override_invalid');
    const period = window(row, version);
    const key = `${employeeId}|${row.path}`;
    const prior = overrideWindows.get(key) || [];
    prior.push(period); overrideWindows.set(key, prior);
    normalizedOverrides.push({ row, employeeId, period });
  }
  checkGroupedWindows(overrideWindows, 'override_ambiguous');
  const exceptions = [];
  for (const { row, employeeId, period } of normalizedOverrides) {
    if (row.path !== 'cap.rateBps' || row.mode !== 'override') continue;
    const personalRateBps = rate(row.value);
    const relevant = assignmentWindows.get(employeeId) || [];
    // Disjoint sorted assignment windows allow logarithmic lookup, avoiding
    // a full employee history scan for every dated cap override.
    let low = 0, high = relevant.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (relevant[middle].to !== null && relevant[middle].to < period.from) low = middle + 1;
      else high = middle;
    }
    for (let i = low; i < relevant.length; i++) {
      const assignment = relevant[i];
      if (period.to !== null && assignment.from > period.to) break;
      const overlap = intersection(period, assignment);
      const effective = overlap && intersection(version, overlap);
      if (!effective) continue;
      const params = definition.roleParameters[assignment.roleId]; plain(params);
      if (params.cap === undefined) continue;
      if (!params.cap || !Object.hasOwn(params.cap, 'rateBps')) fail('role_baseline_missing');
      plain(params.cap);
      const roleRateBps = rate(params.cap.rateBps);
      if (personalRateBps <= roleRateBps) continue;
      exceptions.push({ employeeId, roleId: assignment.roleId, path: 'cap.rateBps',
        effectiveFrom: effective.from, effectiveTo: effective.to, roleRateBps, personalRateBps });
    }
  }
  exceptions.sort((a, b) => {
    for (const key of ['employeeId', 'roleId', 'path', 'effectiveFrom', 'effectiveTo']) {
      const result = codeUnitCompare(a[key] ?? '9999-12-31', b[key] ?? '9999-12-31');
      if (result) return result;
    }
    return a.roleRateBps - b.roleRateBps || a.personalRateBps - b.personalRateBps;
  });
  return exceptions;
};

module.exports = { collectPersonalCapIncreases };
