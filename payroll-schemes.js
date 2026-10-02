'use strict';

// Pure payroll scheme calculator. It consumes venue-local, normalized inputs and
// never reads/writes persistence or the existing payroll lifecycle.

const MODES = new Set(['progressive_daily', 'stable_percent', 'percent_only', 'final_month_threshold']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

const isDate = (value) => {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};
const monthStartOf = (date) => `${date.slice(0, 7)}-01`;
const daysInMonth = (date) => new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)), 0)).getUTCDate();
const monthEndOf = (date) => `${date.slice(0, 7)}-${String(daysInMonth(date)).padStart(2, '0')}`;
const addDays = (date, count) => {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + count);
  return value.toISOString().slice(0, 10);
};
const isNonNegativeInteger = (value) => Number.isSafeInteger(value) && value >= 0;
const cents = (value) => isNonNegativeInteger(value) ? BigInt(value) : null;
const toSafeNumber = (value) => value <= MAX_SAFE_BIGINT ? Number(value) : null;
const rateAmountCents = (baseCents, rateBps) => {
  // Round half up at each source line; money and rates remain integral.
  const base = typeof baseCents === 'bigint' ? baseCents : cents(baseCents);
  if (base === null || !Number.isSafeInteger(rateBps) || rateBps < 0) return null;
  const numerator = base * BigInt(rateBps);
  return (numerator + 5000n) / 10000n;
};
const rateWithinRange = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 10000;
const own = (object, key) => Object.prototype.hasOwnProperty.call(object || {}, key);
const getPath = (object, path) => path.split('.').reduce((current, part) => current && own(current, part) ? current[part] : undefined, object);
const setPath = (object, path, value) => {
  const parts = path.split('.');
  let current = object;
  for (const part of parts.slice(0, -1)) {
    if (!current[part] || typeof current[part] !== 'object' || Array.isArray(current[part])) current[part] = {};
    current = current[part];
  }
  current[parts.at(-1)] = value;
};
const clone = (value) => structuredClone(value);

const validateScheme = (scheme) => {
  const errors = [];
  if (!scheme || typeof scheme !== 'object' || Array.isArray(scheme)) return ['scheme_required'];
  if (!MODES.has(scheme.mode)) errors.push('invalid_mode');
  if (!scheme.id || !scheme.versionId) errors.push('scheme_version_required');
  const roleParameters = scheme.roleParameters;
  if (!roleParameters || typeof roleParameters !== 'object' || Array.isArray(roleParameters) || !Object.keys(roleParameters).length) errors.push('role_parameters_required');
  else {
    for (const [roleId, params] of Object.entries(roleParameters)) {
      if (!roleId || !params || typeof params !== 'object' || Array.isArray(params)) { errors.push('invalid_role_parameters'); continue; }
      if (params.mode !== undefined && !MODES.has(params.mode)) errors.push('invalid_role_mode');
      const effectiveRoleMode = params.mode || scheme.mode;
      if (['progressive_daily', 'final_month_threshold'].includes(effectiveRoleMode) && (!params.bracketRatesBps || typeof params.bracketRatesBps !== 'object' || !own(params.bracketRatesBps, '0'))) errors.push('bracket_rates_required');
      if (['stable_percent', 'percent_only'].includes(effectiveRoleMode) && params.stableRateBps === undefined) errors.push('stable_rate_required');
      if (effectiveRoleMode !== 'percent_only' && params.perShiftCents === undefined) errors.push('per_shift_rate_required');
      for (const key of ['perShiftCents']) if (params[key] !== undefined && !isNonNegativeInteger(params[key])) errors.push(`invalid_${key}`);
      for (const key of ['stableRateBps']) if (params[key] !== undefined && !rateWithinRange(params[key])) errors.push(`invalid_${key}`);
      for (const key of ['bracketRatesBps']) {
        if (params[key] !== undefined) {
          if (!params[key] || typeof params[key] !== 'object' || Array.isArray(params[key]) || !own(params[key], '0')) errors.push('invalid_bracket_rates');
          else for (const [threshold, rate] of Object.entries(params[key])) if (!/^\d+$/.test(threshold) || !isNonNegativeInteger(Number(threshold)) || !rateWithinRange(rate)) errors.push('invalid_bracket_rates');
        }
      }
      if (params.cap !== undefined) {
        if (!params.cap || typeof params.cap !== 'object' || !rateWithinRange(params.cap.rateBps) || !['venue_day', 'employee_department_day'].includes(params.cap.basis) || (params.cap.basis === 'employee_department_day' && !(params.cap.department || params.department))) errors.push('invalid_cap');
      }
      if (params.milestoneBonusesCents !== undefined) {
        if (!params.milestoneBonusesCents || typeof params.milestoneBonusesCents !== 'object' || Array.isArray(params.milestoneBonusesCents)) errors.push('invalid_milestone_bonuses');
        else for (const [threshold, amount] of Object.entries(params.milestoneBonusesCents)) if (!/^\d+$/.test(threshold) || Number(threshold) <= 0 || !isNonNegativeInteger(amount)) errors.push('invalid_milestone_bonuses');
      }
      if (params.applyMilestones !== undefined && typeof params.applyMilestones !== 'boolean') errors.push('invalid_apply_milestones');
    }
  }
  if (scheme.applyMilestones !== undefined && typeof scheme.applyMilestones !== 'boolean') errors.push('invalid_apply_milestones');
  const hasCappedMilestones = Object.values(roleParameters || {}).some((params) => params?.cap && Object.keys(params.milestoneBonusesCents || {}).length && (scheme.applyMilestones ?? params.applyMilestones ?? (params.mode || scheme.mode) === 'progressive_daily'));
  if (hasCappedMilestones && !['included_in_cap', 'separate_from_shift_cap'].includes(scheme.milestoneCapPolicy)) errors.push('milestone_cap_policy_required');
  if (scheme.itemRules !== undefined && !Array.isArray(scheme.itemRules)) errors.push('invalid_item_rules');
  const seenItems = new Set();
  for (const rule of Array.isArray(scheme.itemRules) ? scheme.itemRules : []) {
    const roleScope = Boolean(rule?.roleId);
    const employeeScope = Boolean(rule?.employeeId);
    if (!rule?.menuItemId || roleScope === employeeScope || !rateWithinRange(rule.rateBps) || !['replace', 'additive'].includes(rule.mode)) errors.push('invalid_item_rule');
    const key = `${rule?.menuItemId}|${roleScope ? `role:${rule.roleId}` : `employee:${rule?.employeeId}`}`;
    if (seenItems.has(key)) errors.push('duplicate_item_rule');
    seenItems.add(key);
  }
  if (scheme.employeeOverrides !== undefined && !Array.isArray(scheme.employeeOverrides)) errors.push('invalid_employee_overrides');
  const seenOverrides = new Set();
  for (const override of Array.isArray(scheme.employeeOverrides) ? scheme.employeeOverrides : []) {
    const pathAllowed = /^(mode|applyMilestones|perShiftCents|stableRateBps|bracketRatesBps\.\d+|cap\.(rateBps|basis)|milestoneBonusesCents\.\d+)$/.test(String(override?.path || ''));
    if (!override?.employeeId || !pathAllowed || !['inherit', 'override'].includes(override.mode)) errors.push('invalid_employee_override');
    if (override.mode === 'override' && override.value === undefined) errors.push('override_value_required');
    if (override.mode === 'override' && /^(perShiftCents|milestoneBonusesCents\.\d+)$/.test(String(override.path || '')) && !isNonNegativeInteger(override.value)) errors.push('invalid_employee_override_value');
    if (override.mode === 'override' && /^(stableRateBps|bracketRatesBps\.\d+|cap\.rateBps)$/.test(String(override.path || '')) && !rateWithinRange(override.value)) errors.push('invalid_employee_override_value');
    if (override.mode === 'override' && override.path === 'cap.basis' && !['venue_day', 'employee_department_day'].includes(override.value)) errors.push('invalid_employee_override_value');
    if (override.mode === 'override' && override.path === 'mode' && !MODES.has(override.value)) errors.push('invalid_employee_override_value');
    if (override.mode === 'override' && override.path === 'applyMilestones' && typeof override.value !== 'boolean') errors.push('invalid_employee_override_value');
    const key = `${override?.employeeId}|${override?.path}`;
    if (seenOverrides.has(key)) errors.push('duplicate_employee_override');
    seenOverrides.add(key);
  }
  return [...new Set(errors)];
};

const resolveRoleParameters = (scheme, employeeId, roleId) => {
  const base = scheme.roleParameters?.[roleId];
  if (!base) return null;
  const resolved = clone(base);
  resolved.mode ??= scheme.mode;
  resolved.applyMilestones ??= scheme.applyMilestones ?? resolved.mode === 'progressive_daily';
  for (const override of scheme.employeeOverrides || []) {
    if (override.employeeId !== employeeId || override.mode !== 'override') continue;
    // Never create an implicit new parameter through an override.
    if (['mode', 'applyMilestones'].includes(override.path) || getPath(resolved, override.path) !== undefined) setPath(resolved, override.path, clone(override.value));
  }
  return resolved;
};

const resolveRoleAt = (assignments, employeeId, date) => assignments.find((item) => item.employeeId === employeeId && item.effectiveFrom <= date && (!item.effectiveTo || item.effectiveTo >= date))?.roleId || null;
const selectedBracketRate = (roleParameters, turnoverCents) => {
  const brackets = Object.entries(roleParameters.bracketRatesBps || {}).map(([threshold, rate]) => [BigInt(threshold), rate]).sort((left, right) => left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0);
  let selected = 0;
  for (const [threshold, rate] of brackets) if (threshold <= turnoverCents) selected = rate; else break;
  return selected;
};
const itemRuleFor = (rules, line, employeeId, roleId) => {
  const applicable = rules.filter((rule) => rule.menuItemId === line.menuItemId && (rule.employeeId === employeeId || (!rule.employeeId && rule.roleId === roleId)));
  return applicable.find((rule) => rule.employeeId === employeeId) || applicable.find((rule) => rule.roleId === roleId) || null;
};
const addToMap = (map, key, amount) => map.set(key, (map.get(key) || 0n) + amount);

const calculatePayrollScheme = (input) => {
  const blockers = [];
  const scheme = input?.scheme;
  blockers.push(...validateScheme(scheme));
  if (!isDate(input?.periodFrom) || !isDate(input?.periodTo) || input.periodTo < input.periodFrom || input.periodFrom.slice(0, 7) !== input.periodTo.slice(0, 7)) blockers.push('invalid_single_month_period');
  const monthStart = isDate(input?.periodFrom) ? monthStartOf(input.periodFrom) : '';
  const monthEnd = isDate(input?.periodFrom) ? monthEndOf(input.periodFrom) : '';
  const coverage = input?.coverage;
  if (!coverage || !['month_to_date_complete', 'month_closed_complete'].includes(coverage.kind) || coverage.from !== monthStart || !isDate(coverage.through) || coverage.complete !== true || typeof coverage.watermark !== 'string' || !coverage.watermark.trim()) blockers.push('sales_coverage_manifest_required');
  if (coverage && isDate(coverage.through) && coverage.through < input?.periodTo) blockers.push('sales_coverage_does_not_cover_period');
  if (coverage?.kind === 'month_to_date_complete' && coverage.through !== input?.periodTo) blockers.push('month_to_date_coverage_boundary_mismatch');
  if (coverage?.kind === 'month_closed_complete' && (input?.monthClosed !== true || coverage.through !== monthEnd)) blockers.push('closed_month_mismatch');
  if (scheme?.mode === 'final_month_threshold' && (coverage?.kind !== 'month_closed_complete' || input?.monthClosed !== true)) blockers.push('closed_month_required');
  if (!Array.isArray(input?.employees) || !Array.isArray(input?.roleAssignments) || !Array.isArray(input?.sales)) blockers.push('input_collections_required');
  const employees = Array.isArray(input?.employees) ? input.employees : [];
  const employeeIds = new Set(employees.map((item) => item?.id).filter(Boolean));
  for (const employee of employees) if (!employee?.id || (employee.activeFrom && !isDate(employee.activeFrom)) || (employee.activeTo && !isDate(employee.activeTo)) || (employee.activeFrom && employee.activeTo && employee.activeTo < employee.activeFrom)) blockers.push('invalid_employee');
  for (const override of scheme?.employeeOverrides || []) if (!employeeIds.has(override.employeeId)) blockers.push('employee_override_employee_unknown');
  const assignments = Array.isArray(input?.roleAssignments) ? input.roleAssignments : [];
  for (const assignment of assignments) {
    if (!employeeIds.has(assignment?.employeeId) || !assignment?.roleId || !isDate(assignment?.effectiveFrom) || (assignment.effectiveTo && !isDate(assignment.effectiveTo)) || (assignment.effectiveTo && assignment.effectiveTo < assignment.effectiveFrom)) blockers.push('invalid_role_assignment');
    const params = scheme?.roleParameters?.[assignment?.roleId];
    if ((!assignment.effectiveTo || assignment.effectiveTo >= input?.periodFrom) && assignment.effectiveFrom <= input?.periodTo && !params) blockers.push('role_parameters_missing');
    if (params && (!assignment.effectiveTo || assignment.effectiveTo >= input?.periodFrom) && assignment.effectiveFrom <= input?.periodTo) {
      const resolved = resolveRoleParameters(scheme, assignment.employeeId, assignment.roleId);
      if (['progressive_daily', 'final_month_threshold'].includes(resolved.mode) && (!resolved.bracketRatesBps || !own(resolved.bracketRatesBps, '0'))) blockers.push('bracket_rates_required');
      if (['stable_percent', 'percent_only'].includes(resolved.mode) && resolved.stableRateBps === undefined) blockers.push('stable_rate_required');
      if (resolved.mode !== 'percent_only' && resolved.perShiftCents === undefined) blockers.push('per_shift_rate_required');
      if (resolved.cap?.basis === 'employee_department_day' && !(resolved.cap.department || resolved.department)) blockers.push('cap_department_required');
    }
    if (params) for (const override of scheme.employeeOverrides || []) if (override.employeeId === assignment.employeeId && override.mode === 'override' && !['mode', 'applyMilestones'].includes(override.path) && getPath(params, override.path) === undefined) blockers.push('employee_override_parameter_missing');
  }
  for (const rule of scheme?.itemRules || []) if ((rule.employeeId && !employeeIds.has(rule.employeeId)) || (rule.roleId && !own(scheme.roleParameters || {}, rule.roleId))) blockers.push('item_rule_scope_unknown');
  for (const employeeId of employeeIds) {
    const rows = assignments.filter((item) => item.employeeId === employeeId).slice().sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
    for (let index = 1; index < rows.length; index += 1) if (!rows[index - 1].effectiveTo || rows[index].effectiveFrom <= rows[index - 1].effectiveTo) blockers.push('overlapping_role_assignments');
    const employee = employees.find((item) => item.id === employeeId);
    const activeFrom = employee?.activeFrom && employee.activeFrom > input?.periodFrom ? employee.activeFrom : input?.periodFrom;
    const activeTo = employee?.activeTo && employee.activeTo < input?.periodTo ? employee.activeTo : input?.periodTo;
    if (isDate(activeFrom) && isDate(activeTo) && activeFrom <= activeTo) for (let date = activeFrom; date <= activeTo; date = addDays(date, 1)) if (!resolveRoleAt(assignments, employeeId, date)) blockers.push('role_assignment_gap');
  }
  const effectiveModes = new Set([scheme?.mode].filter(Boolean));
  for (const assignment of assignments) {
    if (assignment.effectiveTo && assignment.effectiveTo < input?.periodFrom || assignment.effectiveFrom > input?.periodTo) continue;
    const params = resolveRoleParameters(scheme || {}, assignment.employeeId, assignment.roleId);
    const mode = params?.mode || scheme?.mode;
    if (mode) effectiveModes.add(mode);
  }
  if (effectiveModes.has('final_month_threshold')) {
    if (coverage?.kind !== 'month_closed_complete' || input?.monthClosed !== true) blockers.push('closed_month_required');
    if (input?.periodFrom !== monthStart || input?.periodTo !== monthEnd) blockers.push('full_month_period_required');
  }
  const sales = Array.isArray(input?.sales) ? input.sales : [];
  const seenSales = new Set();
  for (const line of sales) {
    if (!line?.id || seenSales.has(line.id) || !isDate(line.date) || line.date < monthStart || line.date > monthEnd || (isDate(coverage?.through) && line.date > coverage.through) || !line.department || !isNonNegativeInteger(line.turnoverCents) || !isNonNegativeInteger(line.commissionBaseCents)) blockers.push('invalid_sales_line');
    if (line?.id) seenSales.add(line.id);
    if (line?.employeeId && !employeeIds.has(line.employeeId)) blockers.push('unknown_sales_employee');
    if (!line?.employeeId && isNonNegativeInteger(line?.commissionBaseCents) && line.commissionBaseCents > 0 && line.date >= input.periodFrom && line.date <= input.periodTo) blockers.push('unattributed_sales_line');
    if (line?.employeeId && isDate(line.date) && !resolveRoleAt(assignments, line.employeeId, line.date)) blockers.push('sales_employee_unassigned');
  }
  if (blockers.length) return { status: 'blocked', mode: scheme?.mode || null, periodFrom: input?.periodFrom || null, periodTo: input?.periodTo || null, blockers: [...new Set(blockers)], daily: [], employees: [] };

  const sortedSales = sales.slice().sort((a, b) => a.date.localeCompare(b.date) || String(a.id).localeCompare(String(b.id)));
  const turnoverByDate = new Map();
  for (const line of sortedSales) addToMap(turnoverByDate, line.date, BigInt(line.turnoverCents));
  const dailyVenueTurnover = new Map();
  let cumulativeMonthTurnover = 0n;
  for (let day = monthStart; day <= monthEnd; day = addDays(day, 1)) {
    cumulativeMonthTurnover += turnoverByDate.get(day) || 0n;
    dailyVenueTurnover.set(day, { daily: turnoverByDate.get(day) || 0n, cumulative: cumulativeMonthTurnover });
  }
  const finalMonthTurnover = cumulativeMonthTurnover;
  const monthTurnoverAtPeriodEnd = dailyVenueTurnover.get(input.periodTo)?.cumulative || 0n;
  const dailyRows = [];
  const employeeTotals = new Map();
  const ensureTotal = (employeeId) => {
    if (!employeeTotals.has(employeeId)) employeeTotals.set(employeeId, { employeeId, shifts: 0, basePayCents: 0n, commissionCents: 0n, milestoneBonusCents: 0n, amountBeforeCapCents: 0n, capReductionCents: 0n, amountCents: 0n });
    return employeeTotals.get(employeeId);
  };

  for (let date = input.periodFrom; date <= input.periodTo; date = addDays(date, 1)) {
    const monthTurnoverOnDay = dailyVenueTurnover.get(date)?.cumulative || 0n;
    const daySales = sortedSales.filter((line) => line.date === date);
    const lineCalculations = [];
    const perEmployee = new Map();
    const ensureDayEmployee = (employeeId, roleId) => {
      const key = employeeId;
      if (!perEmployee.has(key)) perEmployee.set(key, { employeeId, roleId, shifts: 0, basePayCents: 0n, commissionCents: 0n, milestoneBonusCents: 0n, amountBeforeCapCents: 0n, capCents: null, capReductionCents: 0n, amountCents: 0n, departmentSalesCents: new Map() });
      return perEmployee.get(key);
    };
    for (const line of daySales) {
      if (!line.employeeId) continue;
      const roleId = resolveRoleAt(assignments, line.employeeId, date);
      const params = resolveRoleParameters(scheme, line.employeeId, roleId);
      if (!params) { blockers.push('role_parameters_missing'); continue; }
      const effectiveMode = params.mode || scheme.mode;
      const employeeDay = ensureDayEmployee(line.employeeId, roleId);
      employeeDay.mode = effectiveMode;
      employeeDay.shifts = 1;
      addToMap(employeeDay.departmentSalesCents, line.department, BigInt(line.commissionBaseCents));
      const rateBps = effectiveMode === 'progressive_daily'
        ? selectedBracketRate(params, monthTurnoverOnDay)
        : effectiveMode === 'final_month_threshold'
          ? selectedBracketRate(params, finalMonthTurnover)
          : (params.stableRateBps || 0);
      const itemRule = itemRuleFor(scheme.itemRules || [], line, line.employeeId, roleId);
      const appliedRateBps = itemRule?.mode === 'replace' ? itemRule.rateBps : rateBps + (itemRule?.mode === 'additive' ? itemRule.rateBps : 0);
      const lineCommissionCents = rateAmountCents(line.commissionBaseCents, appliedRateBps);
      employeeDay.commissionCents += lineCommissionCents;
      lineCalculations.push({ lineId: line.id, employeeId: line.employeeId, roleId, menuItemId: line.menuItemId || null, department: line.department, commissionBaseCents: line.commissionBaseCents, turnoverCents: line.turnoverCents, baseRateBps: rateBps, itemRuleId: itemRule?.id || null, itemRuleMode: itemRule?.mode || null, itemRateBps: itemRule?.rateBps || 0, appliedRateBps, commissionCents: toSafeNumber(lineCommissionCents) });
    }
    for (const [employeeId, employeeDay] of perEmployee) {
      const params = resolveRoleParameters(scheme, employeeId, employeeDay.roleId);
      employeeDay.mode = params?.mode || scheme.mode;
      if (employeeDay.mode !== 'percent_only') employeeDay.basePayCents = BigInt(params?.perShiftCents || 0);
    }
    const previousTurnover = date > monthStart ? (dailyVenueTurnover.get(addDays(date, -1))?.cumulative || 0n) : 0n;
    for (const employeeId of employeeIds) {
      const roleId = resolveRoleAt(assignments, employeeId, date);
      if (!roleId) continue;
      const params = resolveRoleParameters(scheme, employeeId, roleId);
      const employeeMode = params?.mode || scheme.mode;
      const applyMilestones = params?.applyMilestones ?? scheme.applyMilestones ?? employeeMode === 'progressive_daily';
      if (!applyMilestones) continue;
      for (const [thresholdText, bonusCents] of Object.entries(params?.milestoneBonusesCents || {})) {
        const threshold = BigInt(thresholdText);
        if (!(previousTurnover < threshold && monthTurnoverOnDay >= threshold) || Number(bonusCents) === 0) continue;
        const employeeDay = ensureDayEmployee(employeeId, roleId);
        employeeDay.mode = employeeMode;
        employeeDay.milestoneBonusCents += BigInt(bonusCents);
      }
    }
    for (const [employeeId, employeeDay] of perEmployee) {
      const params = resolveRoleParameters(scheme, employeeId, employeeDay.roleId);
      const totalBeforeCap = employeeDay.basePayCents + employeeDay.commissionCents + employeeDay.milestoneBonusCents;
      const capSubject = params?.cap && scheme.milestoneCapPolicy === 'separate_from_shift_cap'
        ? employeeDay.basePayCents + employeeDay.commissionCents
        : totalBeforeCap;
      let capCents = null;
      if (params?.cap) {
        const capBase = params.cap.basis === 'venue_day'
          ? (dailyVenueTurnover.get(date)?.daily || 0n)
          : (employeeDay.departmentSalesCents.get(params.cap.department || params.department) || 0n);
        capCents = rateAmountCents(capBase, params.cap.rateBps);
      }
      const cappedSubject = capCents === null || capSubject <= capCents ? capSubject : capCents;
      const amount = params?.cap && scheme.milestoneCapPolicy === 'separate_from_shift_cap'
        ? cappedSubject + employeeDay.milestoneBonusCents
        : cappedSubject;
      employeeDay.amountBeforeCapCents = totalBeforeCap;
      employeeDay.capCents = capCents;
      employeeDay.capReductionCents = capSubject - cappedSubject;
      employeeDay.amountCents = amount;
      const total = ensureTotal(employeeId);
      total.shifts += employeeDay.shifts;
      total.basePayCents += employeeDay.basePayCents;
      total.commissionCents += employeeDay.commissionCents;
      total.milestoneBonusCents += employeeDay.milestoneBonusCents;
      total.amountBeforeCapCents += totalBeforeCap;
      total.capReductionCents += employeeDay.capReductionCents;
      total.amountCents += amount;
    }
    for (const employee of employees) {
      const roleId = resolveRoleAt(assignments, employee.id, date);
      if (roleId) ensureTotal(employee.id);
    }
    dailyRows.push({
      date,
      venueTurnoverCents: toSafeNumber(dailyVenueTurnover.get(date)?.daily || 0n),
      cumulativeVenueTurnoverCents: toSafeNumber(monthTurnoverOnDay),
      lines: lineCalculations,
      employees: [...perEmployee.values()].sort((a, b) => String(a.employeeId).localeCompare(String(b.employeeId))).map((row) => ({ ...row, departmentSalesCents: Object.fromEntries([...row.departmentSalesCents].map(([key, value]) => [key, toSafeNumber(value)])), basePayCents: toSafeNumber(row.basePayCents), commissionCents: toSafeNumber(row.commissionCents), milestoneBonusCents: toSafeNumber(row.milestoneBonusCents), amountBeforeCapCents: toSafeNumber(row.amountBeforeCapCents), capCents: row.capCents === null ? null : toSafeNumber(row.capCents), capReductionCents: toSafeNumber(row.capReductionCents), amountCents: toSafeNumber(row.amountCents) }))
    });
  }

  const publicEmployees = [...employeeTotals.values()].sort((a, b) => String(a.employeeId).localeCompare(String(b.employeeId))).map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === 'bigint' ? toSafeNumber(value) : value])));
  const hasUnsafeAmount = (row) => Object.entries(row).some(([key, value]) => value === null && key !== 'capCents' && (key.endsWith('Cents') || key === 'venueTurnoverCents' || key === 'cumulativeVenueTurnoverCents'));
  const unsafeAmounts = publicEmployees.some(hasUnsafeAmount);
  if (unsafeAmounts || dailyRows.some((day) => day.venueTurnoverCents === null || day.cumulativeVenueTurnoverCents === null || day.employees.some(hasUnsafeAmount) || day.lines.some(hasUnsafeAmount))) blockers.push('amount_exceeds_safe_integer_cents');
  return {
    status: blockers.length ? 'blocked' : 'ready',
    mode: scheme.mode,
    schemeId: scheme.id,
    schemeVersionId: scheme.versionId,
    currency: scheme.currency || 'RUB',
    periodFrom: input.periodFrom,
    periodTo: input.periodTo,
      monthTurnoverCents: toSafeNumber(effectiveModes.has('final_month_threshold') ? finalMonthTurnover : monthTurnoverAtPeriodEnd),
      modes: [...effectiveModes].sort(),
    blockers: [...new Set(blockers)],
    daily: dailyRows,
    employees: publicEmployees
  };
};

module.exports = { MODES: [...MODES], calculatePayrollScheme, validateScheme };
