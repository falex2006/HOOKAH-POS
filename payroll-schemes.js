'use strict';

// Pure payroll scheme calculator. It consumes venue-local, normalized inputs and
// never reads/writes persistence or the existing payroll lifecycle.

const { calculateTargetIncentive, allocateIncentiveFund } = require('./payroll-incentive-math');
const MODES = new Set(['progressive_daily', 'stable_percent', 'percent_only', 'final_month_threshold', 'personal_target', 'team_fund', 'margin_target']);
const MILESTONE_ELIGIBILITY = new Set(['all_active', 'worked_on_threshold_day']);
const marginParameterErrors = (params) => [...targetParameterErrors(params),
  ...(params.lossPolicy === 'offset_daily_losses' ? [] : ['invalid_margin_loss_policy']),
  ...(params.itemRuleBasis === 'net_revenue' ? [] : ['invalid_margin_item_rule_basis'])];
const teamParameterErrors = (params) => {
  const pool = params.teamFund;
  if (!pool || typeof pool !== 'object' || Array.isArray(pool)) return ['team_fund_required'];
  const errors = targetParameterErrors(pool);
  if (typeof pool.poolId !== 'string' || !pool.poolId.trim() || pool.poolId !== pool.poolId.trim()) errors.push('invalid_team_pool_id');
  if (!Array.isArray(pool.departments) || !pool.departments.length || pool.departments.some((id) => typeof id !== 'string' || !id.trim() || id !== id.trim())
      || new Set(pool.departments).size !== pool.departments.length) errors.push('invalid_team_departments');
  if (!['approved_minutes', 'configured_weights'].includes(pool.distributionPolicy)) errors.push('invalid_team_distribution_policy');
  if (pool.distributionPolicy === 'configured_weights' && (!Number.isSafeInteger(params.teamWeight) || params.teamWeight < 0)) errors.push('invalid_team_weight');
  if (params.teamWeight !== undefined && (!Number.isSafeInteger(params.teamWeight) || params.teamWeight < 0)) errors.push('invalid_team_weight');
  return errors;
};
const teamPoolSignature = (pool) => JSON.stringify({ poolId: pool.poolId, targetCents: pool.targetCents, baseRateBps: pool.baseRateBps,
  bonusRateBps: pool.bonusRateBps, excessRatePolicy: pool.excessRatePolicy, distributionPolicy: pool.distributionPolicy, departments: pool.departments.slice().sort() });
const targetParameterErrors = (params) => {
  const errors = [];
  if (!Number.isSafeInteger(params.targetCents) || params.targetCents < 0) errors.push('invalid_targetCents');
  for (const key of ['baseRateBps', 'bonusRateBps']) if (!Number.isSafeInteger(params[key]) || params[key] < 0 || params[key] > 10000) errors.push(`invalid_${key}`);
  if (!['replace_base', 'add_to_base'].includes(params.excessRatePolicy)) errors.push('invalid_excess_rate_policy');
  return errors;
};
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const MAX_VENUE_DAILY_TURNOVER_DAYS = 31;

const isDate = (value) => {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};
const monthStartOf = (date) => `${date.slice(0, 7)}-01`;
const daysInMonth = (date) => {
  const lastDay = new Date(0);
  lastDay.setUTCHours(0, 0, 0, 0);
  lastDay.setUTCFullYear(Number(date.slice(0, 4)), Number(date.slice(5, 7)), 0);
  return lastDay.getUTCDate();
};
const monthEndOf = (date) => `${date.slice(0, 7)}-${String(daysInMonth(date)).padStart(2, '0')}`;
const inclusiveDateCount = (from, through) => {
  if (!isDate(from) || !isDate(through) || through < from) return 0;
  const count = Math.floor((Date.parse(`${through}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86400000) + 1;
  return count <= MAX_VENUE_DAILY_TURNOVER_DAYS ? count : 0;
};
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
const thresholdLeaf = path => /^(bracketRatesBps|milestoneBonusesCents)\.\d+$/.test(path);
const PERSONAL_SCALAR_PATHS = new Set(['perShiftCents','stableRateBps','targetCents','baseRateBps','bonusRateBps','excessRatePolicy','lossPolicy','itemRuleBasis']);
const PERSONAL_CAP_PATHS = new Set(['cap.rateBps', 'cap.basis']);
const effectivePersonalParameterErrors = params => {
  const errors=[];
  if(params.mode==='personal_target')errors.push(...targetParameterErrors(params));
  if(params.mode==='margin_target')errors.push(...marginParameterErrors(params));
  if(params.mode==='team_fund')errors.push(...teamParameterErrors(params));
  if(['progressive_daily','final_month_threshold'].includes(params.mode)&&(!params.bracketRatesBps||!own(params.bracketRatesBps,'0')))errors.push('bracket_rates_required');
  if(['stable_percent','percent_only'].includes(params.mode)&&params.stableRateBps===undefined)errors.push('stable_rate_required');
  if(params.mode!=='percent_only'&&params.perShiftCents===undefined)errors.push('per_shift_rate_required');
  if (params.cap !== undefined) {
    if (!params.cap || typeof params.cap !== 'object' || Array.isArray(params.cap)
        || !rateWithinRange(params.cap.rateBps) || !['venue_day', 'employee_department_day'].includes(params.cap.basis)) errors.push('invalid_personal_cap');
    else if (params.cap.basis === 'employee_department_day' && !(params.cap.department || params.department)) errors.push('cap_department_required');
  }
  return errors;
};
const thresholdLeafError = (params, path) => {
  if (!thresholdLeaf(path)) return null;
  const [family,key]=path.split('.'), value=Number(key), map=params[family];
  if (!Number.isSafeInteger(value) || value < (family==='milestoneBonusesCents'?1:0)) return 'invalid_personal_threshold';
  if (!own(map,key) && !/^(0|[1-9]\d*)$/.test(key)) return 'noncanonical_new_personal_threshold';
  if (Object.keys(map||{}).some(other=>other!==key&&Number(other)===value)) return 'personal_threshold_alias_collision';
  return null;
};
// Evaluate assignment/override boundaries, not every calendar day of an open-ended version.
const validatePersonalScalarAssignments = (scheme, assignments) => validatePersonalThresholdAssignments(scheme,assignments,true);
const validatePersonalThresholdAssignments = (scheme, assignments, includeScalarParameters=false) => {
  const errors=[];
  const byEmployee=new Map();
  for(const row of (Array.isArray(scheme.employeeOverrides)?scheme.employeeOverrides:[])){
    if(!row||typeof row!=='object'||Array.isArray(row)||row.mode!=='override'||typeof row.path!=='string'
      ||(!includeScalarParameters&&!thresholdLeaf(row.path)&&!['mode','applyMilestones'].includes(row.path))
      ||(row.effectiveFrom&&!isDate(row.effectiveFrom))||(row.effectiveTo&&!isDate(row.effectiveTo)))continue;
    if(!byEmployee.has(row.employeeId))byEmployee.set(row.employeeId,[]);
    byEmployee.get(row.employeeId).push(row);
  }
  for(const assignment of assignments){
    const base=scheme.roleParameters?.[assignment.roleId];if(!base||typeof base!=='object'||Array.isArray(base))continue;
    const relevant=(byEmployee.get(assignment.employeeId)||[]).filter(row=>(!row.effectiveTo||row.effectiveTo>=assignment.effectiveFrom)
      &&(!assignment.effectiveTo||!row.effectiveFrom||row.effectiveFrom<=assignment.effectiveTo));
    if(!relevant.length)continue;
    const events=new Map();
    const eventAt=date=>{if(!events.has(date))events.set(date,{start:[],remove:[]});return events.get(date);};
    eventAt(assignment.effectiveFrom);
    relevant.forEach((row,index)=>{
      const start=row.effectiveFrom&&row.effectiveFrom>assignment.effectiveFrom?row.effectiveFrom:assignment.effectiveFrom;
      eventAt(start).start.push({index,row});
      // The end date is inclusive. An unbounded or final representable end has no removal event.
      if(row.effectiveTo&&row.effectiveTo<'9999-12-31'){
        const removal=addDays(row.effectiveTo,1);
        if(!assignment.effectiveTo||removal<=assignment.effectiveTo)eventAt(removal).remove.push(index);
      }
    });
    const activeRows=new Map();
    for(const date of [...events.keys()].sort()){
      if(assignment.effectiveTo&&date>assignment.effectiveTo)break;
      const event=events.get(date);
      for(const index of event.remove)activeRows.delete(index);
      for(const {index,row} of event.start)activeRows.set(index,row);
      // Keep original override order: mode/apply precedence must not depend on event insertion.
      const active=[...activeRows.entries()].sort((a,b)=>a[0]-b[0]).map(([,row])=>row);
      for(const row of active){const error=thresholdLeafError(base,row.path);if(error)errors.push(error);}
      const resolved=resolveRoleParameters({...scheme,employeeOverrides:active},assignment.employeeId,assignment.roleId,date);
      if(includeScalarParameters)errors.push(...effectivePersonalParameterErrors(resolved));
      for(const row of active){const error=thresholdLeafError(resolved,row.path);if(error)errors.push(error);}
      if(resolved.cap&&resolved.applyMilestones&&Object.keys(resolved.milestoneBonusesCents||{}).length
        &&!['included_in_cap','separate_from_shift_cap'].includes(scheme.milestoneCapPolicy))errors.push('milestone_cap_policy_required');
    }
  }
  return [...new Set(errors)];
};

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
      if (effectiveRoleMode === 'personal_target') errors.push(...targetParameterErrors(params));
      if (effectiveRoleMode === 'margin_target') errors.push(...marginParameterErrors(params));
      if (effectiveRoleMode === 'team_fund') errors.push(...teamParameterErrors(params));
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
        else {
          const thresholds = new Set();
          for (const [threshold, amount] of Object.entries(params.milestoneBonusesCents)) {
            const value = Number(threshold);
            if (!/^\d+$/.test(threshold) || !Number.isSafeInteger(value) || value <= 0
                || thresholds.has(value) || !isNonNegativeInteger(amount)) errors.push('invalid_milestone_bonuses');
            thresholds.add(value);
          }
        }
      }
      if (params.applyMilestones !== undefined && typeof params.applyMilestones !== 'boolean') errors.push('invalid_apply_milestones');
      if (params.milestoneEligibility !== undefined && !MILESTONE_ELIGIBILITY.has(params.milestoneEligibility)) errors.push('invalid_milestone_eligibility');
    }
  }
  if (scheme.applyMilestones !== undefined && typeof scheme.applyMilestones !== 'boolean') errors.push('invalid_apply_milestones');
  if (scheme.milestoneEligibility !== undefined && !MILESTONE_ELIGIBILITY.has(scheme.milestoneEligibility)) errors.push('invalid_milestone_eligibility');
  const teamPools = new Map();
  for (const params of Object.values(roleParameters || {})) if (params && (params.mode || scheme.mode) === 'team_fund' && !teamParameterErrors(params).length) {
    const signature = teamPoolSignature(params.teamFund);
    if (teamPools.has(params.teamFund.poolId) && teamPools.get(params.teamFund.poolId) !== signature) errors.push('conflicting_team_pool');
    teamPools.set(params.teamFund.poolId, signature);
  }
  const hasCappedMilestones = Object.values(roleParameters || {}).some((params) => params?.cap && Object.keys(params.milestoneBonusesCents || {}).length && (params.applyMilestones ?? scheme.applyMilestones ?? (params.mode || scheme.mode) === 'progressive_daily'));
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
  const seenOverrides = new Map();
  for (const override of Array.isArray(scheme.employeeOverrides) ? scheme.employeeOverrides : []) {
    if (!override || typeof override !== 'object' || Array.isArray(override)) { errors.push('invalid_employee_override'); continue; }
    const pathAllowed = /^(mode|applyMilestones|milestoneEligibility|perShiftCents|stableRateBps|targetCents|teamWeight|baseRateBps|bonusRateBps|excessRatePolicy|lossPolicy|itemRuleBasis|bracketRatesBps\.\d+|cap\.(rateBps|basis)|milestoneBonusesCents\.\d+)$/.test(String(override?.path || ''));
    if (!override?.employeeId || !pathAllowed || !['inherit', 'override'].includes(override.mode)) errors.push('invalid_employee_override');
    if (thresholdLeaf(String(override.path||''))) {
      const [family,key]=override.path.split('.'), number=Number(key);
      if(!Number.isSafeInteger(number)||number<(family==='milestoneBonusesCents'?1:0))errors.push('invalid_personal_threshold');
      if(!/^(0|[1-9]\d*)$/.test(key)&&!Object.values(roleParameters||{}).some(params=>own(params?.[family],key)))errors.push('noncanonical_new_personal_threshold');
    }
    if (override.mode === 'override' && override.value === undefined) errors.push('override_value_required');
    if (override.mode === 'override' && /^(perShiftCents|targetCents|teamWeight|milestoneBonusesCents\.\d+)$/.test(String(override.path || '')) && !isNonNegativeInteger(override.value)) errors.push('invalid_employee_override_value');
    if (override.mode === 'override' && /^(stableRateBps|baseRateBps|bonusRateBps|bracketRatesBps\.\d+|cap\.rateBps)$/.test(String(override.path || '')) && !rateWithinRange(override.value)) errors.push('invalid_employee_override_value');
    if (override.mode === 'override' && override.path === 'excessRatePolicy' && !['replace_base', 'add_to_base'].includes(override.value)) errors.push('invalid_employee_override_value');
    if (override.mode === 'override' && override.path === 'lossPolicy' && override.value !== 'offset_daily_losses') errors.push('invalid_employee_override_value');
    if (override.mode === 'override' && override.path === 'itemRuleBasis' && override.value !== 'net_revenue') errors.push('invalid_employee_override_value');
    if (override.mode === 'override' && override.path === 'cap.basis' && !['venue_day', 'employee_department_day'].includes(override.value)) errors.push('invalid_employee_override_value');
    if (override.mode === 'override' && override.path === 'mode' && !MODES.has(override.value)) errors.push('invalid_employee_override_value');
    if (override.mode === 'override' && override.path === 'applyMilestones' && typeof override.value !== 'boolean') errors.push('invalid_employee_override_value');
    if (override.mode === 'override' && override.path === 'milestoneEligibility' && !MILESTONE_ELIGIBILITY.has(override.value)) errors.push('invalid_employee_override_value');
    if ((override.effectiveFrom !== undefined && !isDate(override.effectiveFrom)) || (override.effectiveTo !== undefined && override.effectiveTo !== null && !isDate(override.effectiveTo))
        || (override.effectiveFrom && override.effectiveTo && override.effectiveTo < override.effectiveFrom)) errors.push('invalid_employee_override_window');
    const key = `${override?.employeeId}|${override?.path}`;
    const windowFrom = override?.effectiveFrom || '0000-01-01';
    const windowTo = override?.effectiveTo || '9999-12-31';
    const windows = seenOverrides.get(key) || [];
    if (windows.some((window) => windowFrom <= window.to && windowTo >= window.from)) errors.push('overlapping_employee_override');
    windows.push({ from: windowFrom, to: windowTo });
    seenOverrides.set(key, windows);
  }
  return [...new Set(errors)];
};

const resolveRoleParameters = (scheme, employeeId, roleId, date) => {
  const base = scheme.roleParameters?.[roleId];
  if (!base) return null;
  const resolved = clone(base);
  resolved.mode ??= scheme.mode;
  resolved.applyMilestones ??= scheme.applyMilestones ?? resolved.mode === 'progressive_daily';
  resolved.milestoneEligibility ??= scheme.milestoneEligibility ?? 'all_active';
  for (const override of (Array.isArray(scheme.employeeOverrides) ? scheme.employeeOverrides : [])) {
    if (!override || typeof override !== 'object' || Array.isArray(override)) continue;
    if (override.employeeId !== employeeId || override.mode !== 'override') continue;
    if (date && (override.effectiveFrom && override.effectiveFrom > date || override.effectiveTo && override.effectiveTo < date)) continue;
    // Explicit typed scalar leaves may be personal even when absent from the role.
    if (PERSONAL_SCALAR_PATHS.has(override.path) || PERSONAL_CAP_PATHS.has(override.path) || ['mode', 'applyMilestones', 'milestoneEligibility'].includes(override.path) || thresholdLeaf(override.path) || getPath(resolved, override.path) !== undefined) setPath(resolved, override.path, clone(override.value));
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
  const criticalErrors = [];
  const scheme = input?.scheme;
  const hasVenueDailyTurnover = own(input, 'venueDailyTurnover');
  blockers.push(...validateScheme(scheme));
  if (!isDate(input?.periodFrom) || !isDate(input?.periodTo) || input.periodTo < input.periodFrom || input.periodFrom.slice(0, 7) !== input.periodTo.slice(0, 7)) blockers.push('invalid_single_month_period');
  const monthStart = isDate(input?.periodFrom) ? monthStartOf(input.periodFrom) : '';
  const monthEnd = isDate(input?.periodFrom) ? monthEndOf(input.periodFrom) : '';
  const coverage = input?.coverage;
  if (!coverage || !['month_to_date_complete', 'month_closed_complete'].includes(coverage.kind) || coverage.from !== monthStart || !isDate(coverage.through) || coverage.complete !== true || typeof coverage.watermark !== 'string' || !coverage.watermark.trim()) blockers.push('sales_coverage_manifest_required');
  if (coverage && isDate(coverage.through) && coverage.through < input?.periodTo) blockers.push('sales_coverage_does_not_cover_period');
  if (coverage?.kind === 'month_to_date_complete' && coverage.through !== input?.periodTo) blockers.push('month_to_date_coverage_boundary_mismatch');
  if (coverage?.kind === 'month_closed_complete' && (input?.monthClosed !== true || coverage.through !== monthEnd)) blockers.push('closed_month_mismatch');
  const attendanceCoverage = input?.attendanceCoverage;
  if (!attendanceCoverage || attendanceCoverage.kind !== 'approved_attendance_complete'
      || attendanceCoverage.from !== monthStart || !isDate(attendanceCoverage.through)
      || attendanceCoverage.through < input?.periodTo || attendanceCoverage.complete !== true
      || typeof attendanceCoverage.watermark !== 'string' || !attendanceCoverage.watermark.trim()) blockers.push('attendance_coverage_manifest_required');
  if (scheme?.mode === 'final_month_threshold' && (coverage?.kind !== 'month_closed_complete' || input?.monthClosed !== true)) blockers.push('closed_month_required');
  const venueTurnoverByDate = new Map();
  if (hasVenueDailyTurnover) {
    let invalidVenueTurnoverManifest = !Array.isArray(input.venueDailyTurnover)
      || !isDate(coverage?.from) || !isDate(coverage?.through);
    let expectedDateCount = 0;
    if (isDate(coverage?.from) && isDate(coverage?.through)) {
      expectedDateCount = inclusiveDateCount(coverage.from, coverage.through);
      if (!expectedDateCount) invalidVenueTurnoverManifest = true;
    }
    for (const row of Array.isArray(input.venueDailyTurnover) ? input.venueDailyTurnover : []) {
      if (!row || !isDate(row.date) || !isDate(coverage?.from) || !isDate(coverage?.through)
          || row.date < coverage.from || row.date > coverage.through
          || !isNonNegativeInteger(row.turnoverCents) || venueTurnoverByDate.has(row.date)) {
        invalidVenueTurnoverManifest = true;
        continue;
      }
      venueTurnoverByDate.set(row.date, BigInt(row.turnoverCents));
    }
    if (expectedDateCount > 0) {
      for (let dayOffset = 0; dayOffset < expectedDateCount; dayOffset += 1) {
        const date = addDays(coverage.from, dayOffset);
        if (!venueTurnoverByDate.has(date)) invalidVenueTurnoverManifest = true;
      }
      if (venueTurnoverByDate.size !== expectedDateCount) invalidVenueTurnoverManifest = true;
    }
    if (invalidVenueTurnoverManifest) blockers.push('invalid_venue_daily_turnover_manifest');
  }
  if (!Array.isArray(input?.employees) || !Array.isArray(input?.roleAssignments) || !Array.isArray(input?.sales) || !Array.isArray(input?.attendance)) blockers.push('input_collections_required');
  const employees = Array.isArray(input?.employees) ? input.employees.filter((item) => item && typeof item === 'object' && !Array.isArray(item)) : [];
  if (Array.isArray(input?.employees) && employees.length !== input.employees.length) blockers.push('invalid_employee');
  const employeeIds = new Set(employees.map((item) => item?.id).filter(Boolean));
  if (employeeIds.size !== employees.length) blockers.push('duplicate_employee_id');
  for (const employee of employees) if (!employee?.id || (employee.activeFrom && !isDate(employee.activeFrom)) || (employee.activeTo && !isDate(employee.activeTo)) || (employee.activeFrom && employee.activeTo && employee.activeTo < employee.activeFrom)) blockers.push('invalid_employee');
  const attendanceByDay = new Map();
  const attendanceIds = new Set();
  for (const row of Array.isArray(input?.attendance) ? input.attendance : []) {
    if (!row?.id || attendanceIds.has(row.id) || !employeeIds.has(row.employeeId) || !isDate(row.date)
        || row.approved !== true || !isNonNegativeInteger(row.workedMinutes) || !isNonNegativeInteger(row.plannedMinutes)
        || row.plannedMinutes === 0 || row.workedMinutes > row.plannedMinutes) {
      blockers.push('invalid_attendance_row');
      continue;
    }
    attendanceIds.add(row.id);
    if (row.date < input?.periodFrom || row.date > input?.periodTo) continue;
    const employee = employees.find((item) => item.id === row.employeeId);
    if ((employee?.activeFrom && row.date < employee.activeFrom) || (employee?.activeTo && row.date > employee.activeTo)) {
      blockers.push('attendance_outside_employee_active_period');
      continue;
    }
    const key = `${row.date}|${row.employeeId}`;
    if (!attendanceByDay.has(key)) attendanceByDay.set(key, []);
    attendanceByDay.get(key).push(row);
  }
  for (const override of (Array.isArray(scheme?.employeeOverrides) ? scheme.employeeOverrides : [])) {
    if (override && typeof override === 'object' && !Array.isArray(override) && !employeeIds.has(override.employeeId)) blockers.push('employee_override_employee_unknown');
  }
  const assignments = Array.isArray(input?.roleAssignments)
    ? input.roleAssignments.filter((item) => item && typeof item === 'object' && !Array.isArray(item)) : [];
  if (Array.isArray(input?.roleAssignments) && assignments.length !== input.roleAssignments.length) blockers.push('invalid_role_assignment');
  if(assignments.every(row=>isDate(row.effectiveFrom)&&(!row.effectiveTo||isDate(row.effectiveTo)))&&isDate(input?.periodFrom)&&isDate(input?.periodTo)) {
    const relevantAssignments=assignments.filter(row=>row.effectiveFrom<=input.periodTo&&(!row.effectiveTo||row.effectiveTo>=input.periodFrom))
      .map(row=>({...row,effectiveFrom:row.effectiveFrom<input.periodFrom?input.periodFrom:row.effectiveFrom,
        effectiveTo:!row.effectiveTo||row.effectiveTo>input.periodTo?input.periodTo:row.effectiveTo}));
    blockers.push(...validatePersonalScalarAssignments(scheme||{},relevantAssignments));
  }
  for (const assignment of assignments) {
    if (!employeeIds.has(assignment?.employeeId) || !assignment?.roleId || !isDate(assignment?.effectiveFrom) || (assignment.effectiveTo && !isDate(assignment.effectiveTo)) || (assignment.effectiveTo && assignment.effectiveTo < assignment.effectiveFrom)) blockers.push('invalid_role_assignment');
    const params = scheme?.roleParameters?.[assignment?.roleId];
    if ((!assignment.effectiveTo || assignment.effectiveTo >= input?.periodFrom) && assignment.effectiveFrom <= input?.periodTo && !params) blockers.push('role_parameters_missing');
    if (params && (!assignment.effectiveTo || assignment.effectiveTo >= input?.periodFrom) && assignment.effectiveFrom <= input?.periodTo
        && isDate(assignment.effectiveFrom) && (!assignment.effectiveTo || isDate(assignment.effectiveTo))) {
      const start = assignment.effectiveFrom > input.periodFrom ? assignment.effectiveFrom : input.periodFrom;
      const end = assignment.effectiveTo && assignment.effectiveTo < input.periodTo ? assignment.effectiveTo : input.periodTo;
      for (let dayOffset = 0, dayCount = inclusiveDateCount(start, end); dayOffset < dayCount; dayOffset += 1) {
        const date = addDays(start, dayOffset);
        const resolved = resolveRoleParameters(scheme, assignment.employeeId, assignment.roleId, date);
        if (!resolved) continue;
        for (const override of (Array.isArray(scheme.employeeOverrides) ? scheme.employeeOverrides : [])) {
          if (!override || typeof override !== 'object' || Array.isArray(override)
              || override.employeeId !== assignment.employeeId || override.mode !== 'override'
              || (override.effectiveFrom && override.effectiveFrom > date)
              || (override.effectiveTo && override.effectiveTo < date)
              || ['mode', 'applyMilestones', 'milestoneEligibility'].includes(override.path)) continue;
          if (!PERSONAL_SCALAR_PATHS.has(override.path) && !PERSONAL_CAP_PATHS.has(override.path) && !thresholdLeaf(override.path) && getPath(params, override.path) === undefined) blockers.push('employee_override_parameter_missing');
        }
        if (!MILESTONE_ELIGIBILITY.has(resolved.milestoneEligibility)) blockers.push('invalid_milestone_eligibility');
        if (resolved.applyMilestones && resolved.cap && Object.keys(resolved.milestoneBonusesCents || {}).length
            && !['included_in_cap', 'separate_from_shift_cap'].includes(scheme.milestoneCapPolicy)) blockers.push('milestone_cap_policy_required');
        if (resolved.mode === 'personal_target') blockers.push(...targetParameterErrors(resolved));
        if (resolved.mode === 'margin_target') blockers.push(...marginParameterErrors(resolved));
        if (resolved.mode === 'team_fund') blockers.push(...teamParameterErrors(resolved));
        if (['progressive_daily', 'final_month_threshold'].includes(resolved.mode) && (!resolved.bracketRatesBps || !own(resolved.bracketRatesBps, '0'))) blockers.push('bracket_rates_required');
        if (['stable_percent', 'percent_only'].includes(resolved.mode) && resolved.stableRateBps === undefined) blockers.push('stable_rate_required');
        if (resolved.mode !== 'percent_only' && resolved.perShiftCents === undefined) blockers.push('per_shift_rate_required');
        if (resolved.cap?.basis === 'employee_department_day' && !(resolved.cap.department || resolved.department)) blockers.push('cap_department_required');
      }
    }
  }
  for (const rule of (Array.isArray(scheme?.itemRules) ? scheme.itemRules : [])) if (rule && typeof rule === 'object' && !Array.isArray(rule) && ((rule.employeeId && !employeeIds.has(rule.employeeId)) || (rule.roleId && !own(scheme.roleParameters || {}, rule.roleId)))) blockers.push('item_rule_scope_unknown');
  for (const employeeId of employeeIds) {
    const rows = assignments.filter((item) => item.employeeId === employeeId).slice().sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
    for (let index = 1; index < rows.length; index += 1) if (!rows[index - 1].effectiveTo || rows[index].effectiveFrom <= rows[index - 1].effectiveTo) blockers.push('overlapping_role_assignments');
    const employee = employees.find((item) => item.id === employeeId);
    const activeFrom = employee?.activeFrom && employee.activeFrom > input?.periodFrom ? employee.activeFrom : input?.periodFrom;
    const activeTo = employee?.activeTo && employee.activeTo < input?.periodTo ? employee.activeTo : input?.periodTo;
    for (let dayOffset = 0, dayCount = inclusiveDateCount(activeFrom, activeTo); dayOffset < dayCount; dayOffset += 1) {
      if (!resolveRoleAt(assignments, employeeId, addDays(activeFrom, dayOffset))) blockers.push('role_assignment_gap');
    }
  }
  const effectiveModes = new Set([scheme?.mode].filter(Boolean));
  if (isDate(input?.periodFrom) && isDate(input?.periodTo) && Array.isArray(input?.employees)) {
    for (let dayOffset = 0, dayCount = inclusiveDateCount(input.periodFrom, input.periodTo); dayOffset < dayCount; dayOffset += 1) for (const employee of employees) {
      const date = addDays(input.periodFrom, dayOffset);
      const roleId = resolveRoleAt(assignments, employee.id, date);
      if (!roleId) continue;
      const params = resolveRoleParameters(scheme || {}, employee.id, roleId, date);
      const mode = params?.mode || scheme?.mode;
      if (mode) effectiveModes.add(mode);
    }
  }
  if (isDate(input?.periodFrom) && isDate(input?.periodTo)) {
    for (let offset = 0, count = inclusiveDateCount(input.periodFrom, input.periodTo); offset < count; offset += 1) {
      const date = addDays(input.periodFrom, offset);
      const pools = new Map();
      for (const employee of employees) {
        if ((employee.activeFrom && date < employee.activeFrom) || (employee.activeTo && date > employee.activeTo)) continue;
        const params = resolveRoleParameters(scheme || {}, employee.id, resolveRoleAt(assignments, employee.id, date), date);
        if (params?.mode === 'team_fund' && (typeof employee.id !== 'string' || !employee.id.trim())) blockers.push('invalid_team_employee_id');
        if (params?.mode !== 'team_fund' || teamParameterErrors(params).length) continue;
        const signature = teamPoolSignature(params.teamFund);
        if (pools.has(params.teamFund.poolId) && pools.get(params.teamFund.poolId) !== signature) blockers.push('conflicting_team_pool');
        pools.set(params.teamFund.poolId, signature);
      }
    }
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
    if (!line?.employeeId && isNonNegativeInteger(line?.turnoverCents) && line.turnoverCents > 0 && line.date >= input.periodFrom && line.date <= input.periodTo) blockers.push('unattributed_sales_line');
    if (line?.employeeId && isDate(line.date) && !resolveRoleAt(assignments, line.employeeId, line.date)) blockers.push('sales_employee_unassigned');
    if (line?.employeeId && isDate(line.date)) {
      const employee = employees.find((item) => item.id === line.employeeId);
      const roleId = resolveRoleAt(assignments, line.employeeId, line.date);
      const resolvedMode = resolveRoleParameters(scheme || {}, line.employeeId, roleId, line.date)?.mode;
      if (resolvedMode === 'margin_target') {
        // costCents is the normalized NET TOTAL cost of this sale portion,
        // including quantity/refund cost adjustments; it is never unit cost.
        const cost = line.costSnapshot;
        if (!cost) blockers.push('margin_cost_snapshot_required');
        else if (typeof cost !== 'object' || Array.isArray(cost) || typeof cost.id !== 'string' || !cost.id.trim()
            || typeof cost.version !== 'string' || !cost.version.trim() || !isNonNegativeInteger(cost.costCents)) blockers.push('invalid_margin_cost_snapshot');
        else if (cost.currency !== (scheme.currency || 'RUB')) blockers.push('margin_cost_currency_mismatch');
      }
      if (['personal_target', 'team_fund', 'margin_target'].includes(resolvedMode)
          && (typeof line.id !== 'string' || !line.id.trim())) blockers.push('invalid_target_sales_line_id');
      if ((employee?.activeFrom && line.date < employee.activeFrom) || (employee?.activeTo && line.date > employee.activeTo)) blockers.push('sales_outside_employee_active_period');
    }
  }
  if (blockers.length) return { status: 'blocked', mode: scheme?.mode || null, periodFrom: input?.periodFrom || null, periodTo: input?.periodTo || null,
    venueTurnoverBasis: hasVenueDailyTurnover ? 'venue_daily_manifest_scenario' : 'sales_line_sum_scenario',
    blockers: [...new Set(blockers)], criticalErrors, payoutEligible: false, daily: [], employees: [] };

  const sortedSales = sales.slice().sort((a, b) => a.date.localeCompare(b.date) || String(a.id).localeCompare(String(b.id)));
  const turnoverByDate = new Map();
  for (const line of sortedSales) addToMap(turnoverByDate, line.date, BigInt(line.turnoverCents));
  const dailyVenueTurnover = new Map();
  let cumulativeMonthTurnover = 0n;
  for (let dayOffset = 0, dayCount = inclusiveDateCount(monthStart, monthEnd); dayOffset < dayCount; dayOffset += 1) {
    const day = addDays(monthStart, dayOffset);
    const dailyTurnover = hasVenueDailyTurnover ? (venueTurnoverByDate.get(day) || 0n) : (turnoverByDate.get(day) || 0n);
    cumulativeMonthTurnover += dailyTurnover;
    dailyVenueTurnover.set(day, { daily: dailyTurnover, cumulative: cumulativeMonthTurnover });
  }
  const finalMonthTurnover = cumulativeMonthTurnover;
  const monthTurnoverAtPeriodEnd = dailyVenueTurnover.get(input.periodTo)?.cumulative || 0n;
  const dailyRows = [];
  const employeeTotals = new Map();
  const explainMilestoneEligibility = scheme.milestoneEligibility !== undefined
    || Object.values(scheme.roleParameters || {}).some((params) => params.milestoneEligibility !== undefined)
    || (scheme.employeeOverrides || []).some((row) => row.path === 'milestoneEligibility');
  const ensureTotal = (employeeId) => {
    if (!employeeTotals.has(employeeId)) employeeTotals.set(employeeId, { employeeId, shifts: 0, personalRevenueCents: 0n, basePayCents: 0n, commissionCents: 0n, teamFundCents: 0n, milestoneBonusCents: 0n, amountBeforeCapCents: 0n, capReductionCents: 0n, amountCents: 0n });
    return employeeTotals.get(employeeId);
  };

  for (let dayOffset = 0, dayCount = inclusiveDateCount(input.periodFrom, input.periodTo); dayOffset < dayCount; dayOffset += 1) {
    const date = addDays(input.periodFrom, dayOffset);
    const monthTurnoverOnDay = dailyVenueTurnover.get(date)?.cumulative || 0n;
    const daySales = sortedSales.filter((line) => line.date === date);
    const lineCalculations = [];
    const teamFunds = [];
    const milestoneDecisions = [];
    const perEmployee = new Map();
    const ensureDayEmployee = (employeeId, roleId) => {
      const key = employeeId;
      if (!perEmployee.has(key)) perEmployee.set(key, { employeeId, roleId, shifts: 0, shiftDetails: [], personalRevenueCents: 0n, basePayCents: 0n, commissionCents: 0n, teamFundCents: 0n, milestoneBonusCents: 0n, amountBeforeCapCents: 0n, capCents: null, capReductionCents: 0n, amountCents: 0n, departmentSalesCents: new Map(), departmentTurnoverCents: new Map() });
      return perEmployee.get(key);
    };
    for (const line of daySales) {
      if (!line.employeeId) continue;
      const roleId = resolveRoleAt(assignments, line.employeeId, date);
      const params = resolveRoleParameters(scheme, line.employeeId, roleId, date);
      if (!params) { blockers.push('role_parameters_missing'); continue; }
      const effectiveMode = params.mode || scheme.mode;
      const employeeDay = ensureDayEmployee(line.employeeId, roleId);
      employeeDay.mode = effectiveMode;
      // Scenario-only proxy until upstream guarantees full discount/refund-adjusted
      // employee revenue. Turnover and commission base have distinct semantics.
      employeeDay.personalRevenueCents += BigInt(line.turnoverCents);
      addToMap(employeeDay.departmentSalesCents, line.department, BigInt(line.commissionBaseCents));
      addToMap(employeeDay.departmentTurnoverCents, line.department, BigInt(line.turnoverCents));
      const rateBps = effectiveMode === 'progressive_daily'
        ? selectedBracketRate(params, monthTurnoverOnDay)
        : effectiveMode === 'final_month_threshold'
          ? selectedBracketRate(params, finalMonthTurnover)
          : (params.stableRateBps || 0);
      const itemRule = itemRuleFor(scheme.itemRules || [], line, line.employeeId, roleId);
      if (effectiveMode === 'margin_target') {
        const marginCents = line.commissionBaseCents - line.costSnapshot.costCents;
        const ordinary = itemRule ? rateAmountCents(line.commissionBaseCents, itemRule.rateBps) : 0n;
        employeeDay.commissionCents += ordinary;
        lineCalculations.push({ lineId: line.id, employeeId: line.employeeId, roleId, menuItemId: line.menuItemId || null, department: line.department,
          commissionBaseCents: line.commissionBaseCents, turnoverCents: line.turnoverCents, costSnapshot: clone(line.costSnapshot), marginCents, signedMarginCents: marginCents,
          baseRateBps: itemRule?.mode === 'replace' ? 0 : null, appliedRateBps: itemRule?.mode === 'replace' ? itemRule.rateBps : null,
          itemRuleId: itemRule?.id || null, itemRuleMode: itemRule?.mode || null, itemRateBps: itemRule?.rateBps || 0,
          commissionCents: toSafeNumber(ordinary), ...(itemRule?.mode === 'replace' ? { marginPoolExcluded: true } : {
            marginAllocation: { additiveCommissionCents: toSafeNumber(ordinary), itemRuleBasis: 'net_revenue' } }) });
        continue;
      }
      if (effectiveMode === 'team_fund') {
        const included = itemRule?.mode !== 'replace' && params.teamFund.departments.includes(line.department);
        const ordinary = itemRule ? rateAmountCents(line.commissionBaseCents, itemRule.rateBps) : 0n;
        employeeDay.commissionCents += ordinary;
        lineCalculations.push({ lineId: line.id, employeeId: line.employeeId, roleId, menuItemId: line.menuItemId || null, department: line.department,
          commissionBaseCents: line.commissionBaseCents, turnoverCents: line.turnoverCents, baseRateBps: 0,
          itemRuleId: itemRule?.id || null, itemRuleMode: itemRule?.mode || null, itemRateBps: itemRule?.rateBps || 0,
          appliedRateBps: itemRule?.rateBps || 0, commissionCents: toSafeNumber(ordinary),
          teamFundSource: { poolId: params.teamFund.poolId, included, basisCents: included ? line.commissionBaseCents : 0,
            exclusionReason: included ? null : itemRule?.mode === 'replace' ? 'item_replacement' : 'department_outside_pool' } });
        continue;
      }
      if (effectiveMode === 'personal_target' && itemRule?.mode !== 'replace') {
        const additive = itemRule?.mode === 'additive' ? rateAmountCents(line.commissionBaseCents, itemRule.rateBps) : 0n;
        employeeDay.commissionCents += additive;
        lineCalculations.push({ lineId: line.id, employeeId: line.employeeId, roleId, menuItemId: line.menuItemId || null, department: line.department,
          commissionBaseCents: line.commissionBaseCents, turnoverCents: line.turnoverCents, baseRateBps: null, appliedRateBps: null,
          itemRuleId: itemRule?.id || null, itemRuleMode: itemRule?.mode || null, itemRateBps: itemRule?.rateBps || 0,
          commissionCents: toSafeNumber(additive), targetAllocation: { additiveCommissionCents: toSafeNumber(additive) } });
        continue;
      }
      const appliedRateBps = itemRule?.mode === 'replace' ? itemRule.rateBps : rateBps + (itemRule?.mode === 'additive' ? itemRule.rateBps : 0);
      const lineCommissionCents = rateAmountCents(line.commissionBaseCents, appliedRateBps);
      employeeDay.commissionCents += lineCommissionCents;
      lineCalculations.push({ lineId: line.id, employeeId: line.employeeId, roleId, menuItemId: line.menuItemId || null, department: line.department, commissionBaseCents: line.commissionBaseCents, turnoverCents: line.turnoverCents, baseRateBps: rateBps, itemRuleId: itemRule?.id || null, itemRuleMode: itemRule?.mode || null, itemRateBps: itemRule?.rateBps || 0, appliedRateBps, commissionCents: toSafeNumber(lineCommissionCents) });
    }
    // Offset all eligible signed daily losses before allocating the nonnegative
    // payable margin over positive source margins. Costs are explicit scenario snapshots.
    for (const [employeeId, employeeDay] of perEmployee) {
      if (employeeDay.mode !== 'margin_target') continue;
      const params = resolveRoleParameters(scheme, employeeId, employeeDay.roleId, date);
      const lines = lineCalculations.filter((line) => line.employeeId === employeeId && line.marginAllocation);
      try {
        const signed = lines.reduce((sum, line) => sum + BigInt(line.marginCents), 0n);
        const positive = lines.reduce((sum, line) => sum + (line.marginCents > 0 ? BigInt(line.marginCents) : 0n), 0n);
        const losses = positive - signed;
        if (signed > MAX_SAFE_BIGINT || signed < -MAX_SAFE_BIGINT || positive > MAX_SAFE_BIGINT || losses > MAX_SAFE_BIGINT) throw new RangeError('amount_exceeds_safe_integer_cents');
        const basis = signed > 0n ? signed : 0n;
        const incentive = calculateTargetIncentive({ basisCents: Number(basis), targetCents: params.targetCents,
          baseRateBps: params.baseRateBps, bonusRateBps: params.bonusRateBps, excessRatePolicy: params.excessRatePolicy });
        employeeDay.marginIncentive = { ...incentive, signedMarginCents: Number(signed), payableMarginCents: Number(basis), positiveMarginCents: Number(positive), lossCents: Number(losses), lossOffsetCents: Number(positive - basis),
          basis: 'employee_day_margin_cost_snapshot_scenario', lossPolicy: params.lossPolicy, itemRuleBasis: params.itemRuleBasis, roundingPolicy: 'component_half_up_v1' };
        const ids = lines.map((line) => ({ id: String(line.lineId), weight: Math.max(line.marginCents, 0) }));
        const payable = new Map(allocateIncentiveFund(Number(basis), ids).map((row) => [row.id, row.amountCents]));
        const below = new Map(allocateIncentiveFund(incentive.belowTargetCents, lines.map((line) => ({ id: String(line.lineId), weight: payable.get(String(line.lineId)) }))).map((row) => [row.id, row.amountCents]));
        const base = new Map(allocateIncentiveFund(incentive.baseCommissionCents, lines.map((line) => ({ id: String(line.lineId),
          weight: params.excessRatePolicy === 'add_to_base' ? payable.get(String(line.lineId)) : below.get(String(line.lineId)) }))).map((row) => [row.id, row.amountCents]));
        const excess = new Map(allocateIncentiveFund(incentive.excessCommissionCents, lines.map((line) => ({ id: String(line.lineId),
          weight: payable.get(String(line.lineId)) - below.get(String(line.lineId)) }))).map((row) => [row.id, row.amountCents]));
        for (const line of lines) {
          const key = String(line.lineId);
          line.marginAllocation = { ...line.marginAllocation, payableBasisCents: payable.get(key), payableMarginCents: payable.get(key), belowTargetCents: below.get(key),
            excessCents: payable.get(key) - below.get(key), baseCommissionCents: base.get(key), excessCommissionCents: excess.get(key),
            lossOffsetCents: Math.max(line.marginCents, 0) - payable.get(key), roundingPolicy: 'component_half_up_v1' };
          line.commissionCents = toSafeNumber(BigInt(line.commissionCents) + BigInt(base.get(key)) + BigInt(excess.get(key)));
        }
        employeeDay.commissionCents += BigInt(incentive.commissionCents);
      } catch (error) {
        if (!(error instanceof RangeError)) throw error;
        employeeDay.marginIncentive = { status: 'blocked', blocker: 'amount_exceeds_safe_integer_cents', basis: 'employee_day_margin_cost_snapshot_scenario',
          lossPolicy: params.lossPolicy, itemRuleBasis: params.itemRuleBasis, roundingPolicy: 'component_half_up_v1' };
        blockers.push('amount_exceeds_safe_integer_cents');
      }
    }
    // Daily target resets per employee; replacement item rules are outside its pool.
    for (const [employeeId, employeeDay] of perEmployee) {
      if (employeeDay.mode !== 'personal_target') continue;
      const params = resolveRoleParameters(scheme, employeeId, employeeDay.roleId, date);
      const lines = lineCalculations.filter((line) => line.employeeId === employeeId && line.targetAllocation);
      try {
        const basis = lines.reduce((sum, line) => sum + BigInt(line.commissionBaseCents), 0n);
        if (basis > MAX_SAFE_BIGINT) throw new RangeError('amount_exceeds_safe_integer_cents');
        const incentive = calculateTargetIncentive({ basisCents: Number(basis), targetCents: params.targetCents,
          baseRateBps: params.baseRateBps, bonusRateBps: params.bonusRateBps, excessRatePolicy: params.excessRatePolicy });
        employeeDay.targetIncentive = { ...incentive, basis: 'employee_day_commission_base_scenario', roundingPolicy: 'component_half_up_v1' };
        const weights = lines.map((line) => ({ id: String(line.lineId), weight: line.commissionBaseCents }));
        const below = new Map(allocateIncentiveFund(incentive.belowTargetCents, weights).map((row) => [row.id, row.amountCents]));
        const baseWeights = lines.map((line) => ({ id: String(line.lineId), weight: params.excessRatePolicy === 'add_to_base' ? line.commissionBaseCents : below.get(String(line.lineId)) }));
        const excessWeights = lines.map((line) => ({ id: String(line.lineId), weight: line.commissionBaseCents - below.get(String(line.lineId)) }));
        const baseAmounts = new Map(allocateIncentiveFund(incentive.baseCommissionCents, baseWeights).map((row) => [row.id, row.amountCents]));
        const excessAmounts = new Map(allocateIncentiveFund(incentive.excessCommissionCents, excessWeights).map((row) => [row.id, row.amountCents]));
        for (const line of lines) {
          const key = String(line.lineId);
          line.targetAllocation = { ...line.targetAllocation, belowTargetCents: below.get(key), excessCents: line.commissionBaseCents - below.get(key),
            baseCommissionCents: baseAmounts.get(key), excessCommissionCents: excessAmounts.get(key), roundingPolicy: 'component_half_up_v1' };
          line.commissionCents = toSafeNumber(BigInt(line.commissionCents) + BigInt(baseAmounts.get(key)) + BigInt(excessAmounts.get(key)));
        }
        employeeDay.commissionCents += BigInt(incentive.commissionCents);
      } catch (error) {
        if (!(error instanceof RangeError)) throw error;
        employeeDay.targetIncentive = { status: 'blocked', blocker: 'amount_exceeds_safe_integer_cents',
          basis: 'employee_day_commission_base_scenario', roundingPolicy: 'component_half_up_v1' };
        blockers.push('amount_exceeds_safe_integer_cents');
      }
    }
    for (const [attendanceKey, rows] of attendanceByDay) {
      if (!attendanceKey.startsWith(`${date}|`) || !rows.length) continue;
      const employeeId = attendanceKey.slice(date.length + 1);
      const roleId = resolveRoleAt(assignments, employeeId, date);
      if (!roleId) { blockers.push('attendance_employee_unassigned'); continue; }
      const params = resolveRoleParameters(scheme, employeeId, roleId, date);
      const effectiveMode = params?.mode || scheme.mode;
      const employeeDay = ensureDayEmployee(employeeId, roleId);
      employeeDay.mode = effectiveMode;
      if (effectiveMode !== 'percent_only') for (const row of rows.filter((item) => item.date === date)) {
        employeeDay.shifts += 1;
        const numerator = BigInt(params?.perShiftCents || 0) * BigInt(row.workedMinutes);
        const shiftAmountCents = (numerator + BigInt(row.plannedMinutes) / 2n) / BigInt(row.plannedMinutes);
        employeeDay.basePayCents += shiftAmountCents;
        employeeDay.shiftDetails.push({ shiftId: row.id, workedMinutes: row.workedMinutes, plannedMinutes: row.plannedMinutes, amountCents: toSafeNumber(shiftAmountCents) });
      }
    }
    const dailyPools = new Map();
    for (const employee of employees) {
      if ((employee.activeFrom && date < employee.activeFrom) || (employee.activeTo && date > employee.activeTo)) continue;
      const roleId = resolveRoleAt(assignments, employee.id, date);
      const params = resolveRoleParameters(scheme, employee.id, roleId, date);
      if (params?.mode !== 'team_fund') continue;
      const pool = params.teamFund;
      if (!dailyPools.has(pool.poolId)) dailyPools.set(pool.poolId, { config: pool, members: [] });
      const weight = pool.distributionPolicy === 'configured_weights' ? BigInt(params.teamWeight)
        : (attendanceByDay.get(`${date}|${employee.id}`) || []).reduce((sum, row) => sum + BigInt(row.workedMinutes), 0n);
      dailyPools.get(pool.poolId).members.push({ id: employee.id, weight });
      ensureDayEmployee(employee.id, roleId).mode = 'team_fund';
    }
    for (const [poolId, pool] of [...dailyPools].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
      const sources = lineCalculations.filter((line) => line.teamFundSource?.poolId === poolId && line.teamFundSource.included);
      try {
        const basis = sources.reduce((sum, line) => sum + BigInt(line.teamFundSource.basisCents), 0n);
        if (basis > MAX_SAFE_BIGINT || pool.members.some((row) => row.weight > MAX_SAFE_BIGINT)) throw new RangeError('amount_exceeds_safe_integer_cents');
        const incentive = calculateTargetIncentive({ basisCents: Number(basis), targetCents: pool.config.targetCents,
          baseRateBps: pool.config.baseRateBps, bonusRateBps: pool.config.bonusRateBps, excessRatePolicy: pool.config.excessRatePolicy });
        const allocations = allocateIncentiveFund(incentive.commissionCents, pool.members.map((row) => ({ id: row.id, weight: Number(row.weight) })));
        for (const row of allocations) perEmployee.get(row.id).teamFundCents += BigInt(row.amountCents);
        teamFunds.push({ poolId, ...incentive, fundCents: incentive.commissionCents, departments: pool.config.departments.slice().sort(),
          distributionPolicy: pool.config.distributionPolicy, roundingPolicy: 'component_half_up_v1',
          basis: 'member_department_commission_base_scenario', memberIds: allocations.map((row) => row.id), sourceLineIds: sources.map((line) => line.lineId).sort(), allocations });
      } catch (error) {
        if (!(error instanceof RangeError)) throw error;
        const blocker = error.message === 'positive_fund_requires_recipient_weight' ? 'positive_team_fund_requires_weight' : 'amount_exceeds_safe_integer_cents';
        blockers.push(blocker);
        teamFunds.push({ poolId, status: 'blocked', blocker, memberIds: pool.members.map((row) => row.id).sort(), sourceLineIds: sources.map((line) => line.lineId).sort() });
      }
    }
    const previousTurnover = date > monthStart ? (dailyVenueTurnover.get(addDays(date, -1))?.cumulative || 0n) : 0n;
    for (const employeeId of employeeIds) {
      const roleId = resolveRoleAt(assignments, employeeId, date);
      if (!roleId) continue;
      const params = resolveRoleParameters(scheme, employeeId, roleId, date);
      const employeeMode = params?.mode || scheme.mode;
      const applyMilestones = params?.applyMilestones ?? scheme.applyMilestones ?? employeeMode === 'progressive_daily';
      if (!applyMilestones && !explainMilestoneEligibility) continue;
      for (const [thresholdText, bonusCents] of Object.entries(params?.milestoneBonusesCents || {})) {
        const threshold = BigInt(thresholdText);
        if (!(previousTurnover < threshold && monthTurnoverOnDay >= threshold) || Number(bonusCents) === 0) continue;
        const employee = employees.find((item) => item.id === employeeId);
        const active = !(employee?.activeFrom && date < employee.activeFrom) && !(employee?.activeTo && date > employee.activeTo);
        const attendanceRows = (attendanceByDay.get(`${date}|${employeeId}`) || []).filter((row) => row.approved === true && row.workedMinutes > 0);
        const policy = params.milestoneEligibility;
        const eligible = applyMilestones && active && (policy === 'all_active' || attendanceRows.length > 0);
        if (explainMilestoneEligibility) {
          const workedMinutes = toSafeNumber(attendanceRows.reduce((sum, row) => sum + BigInt(row.workedMinutes), 0n));
          if (workedMinutes === null) blockers.push('amount_exceeds_safe_integer_cents');
          milestoneDecisions.push({ employeeId, roleId, date, thresholdCents: toSafeNumber(threshold), declaredBonusCents: bonusCents,
            previousTurnoverCents: toSafeNumber(previousTurnover), cumulativeTurnoverCents: toSafeNumber(monthTurnoverOnDay), applyMilestones, employeeActive: active,
            eligibility: policy, qualifyingShiftIds: attendanceRows.map((row) => row.id).sort((a, b) => String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0),
            approvedWorkedMinutes: workedMinutes, eligible, reason: !applyMilestones ? 'milestones_disabled' : !active ? 'employee_inactive'
              : !eligible ? 'no_approved_positive_work_on_threshold_day' : 'eligible', awardedAmountCents: eligible ? bonusCents : 0 });
        }
        if (!eligible) continue;
        const employeeDay = ensureDayEmployee(employeeId, roleId);
        employeeDay.mode = employeeMode;
        employeeDay.milestoneBonusCents += BigInt(bonusCents);
      }
    }
    for (const [employeeId, employeeDay] of perEmployee) {
      const params = resolveRoleParameters(scheme, employeeId, employeeDay.roleId, date);
      if (employeeDay.mode === 'margin_target' && !employeeDay.marginIncentive) employeeDay.marginIncentive = {
        ...calculateTargetIncentive({ basisCents: 0, targetCents: params.targetCents, baseRateBps: params.baseRateBps,
          bonusRateBps: params.bonusRateBps, excessRatePolicy: params.excessRatePolicy }), signedMarginCents: 0, payableMarginCents: 0, positiveMarginCents: 0,
        lossCents: 0, lossOffsetCents: 0, basis: 'employee_day_margin_cost_snapshot_scenario', lossPolicy: params.lossPolicy,
        itemRuleBasis: params.itemRuleBasis, roundingPolicy: 'component_half_up_v1'
      };
      if (employeeDay.mode === 'personal_target' && !employeeDay.targetIncentive) employeeDay.targetIncentive = {
        ...calculateTargetIncentive({ basisCents: 0, targetCents: params.targetCents, baseRateBps: params.baseRateBps,
          bonusRateBps: params.bonusRateBps, excessRatePolicy: params.excessRatePolicy }),
        basis: 'employee_day_commission_base_scenario', roundingPolicy: 'component_half_up_v1'
      };
      const totalBeforeCap = employeeDay.basePayCents + employeeDay.commissionCents + employeeDay.teamFundCents + employeeDay.milestoneBonusCents;
      const capSubject = params?.cap && scheme.milestoneCapPolicy === 'separate_from_shift_cap'
        ? employeeDay.basePayCents + employeeDay.commissionCents + employeeDay.teamFundCents
        : totalBeforeCap;
      let capCents = null;
      if (params?.cap) {
        const capBase = params.cap.basis === 'venue_day'
          ? (dailyVenueTurnover.get(date)?.daily || 0n)
          : (employeeDay.departmentTurnoverCents.get(params.cap.department || params.department) || 0n);
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
      if (employeeDay.amountCents > employeeDay.personalRevenueCents) criticalErrors.push({
        code: 'employee_daily_pay_exceeds_personal_revenue', employeeId, date,
        payoutCents: toSafeNumber(employeeDay.amountCents), personalRevenueCents: toSafeNumber(employeeDay.personalRevenueCents),
        excessCents: toSafeNumber(employeeDay.amountCents - employeeDay.personalRevenueCents)
      });
      const total = ensureTotal(employeeId);
      total.shifts += employeeDay.shifts;
      total.personalRevenueCents += employeeDay.personalRevenueCents;
      total.basePayCents += employeeDay.basePayCents;
      total.commissionCents += employeeDay.commissionCents;
      total.teamFundCents += employeeDay.teamFundCents;
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
      teamFunds,
      ...(explainMilestoneEligibility ? { milestoneDecisions: milestoneDecisions.sort((a, b) => String(a.employeeId) < String(b.employeeId) ? -1 : String(a.employeeId) > String(b.employeeId) ? 1 : a.thresholdCents - b.thresholdCents) } : {}),
      employees: [...perEmployee.values()].sort((a, b) => String(a.employeeId).localeCompare(String(b.employeeId))).map((row) => ({ ...row, shiftDetails: row.shiftDetails.map((shift) => ({ ...shift })), personalRevenueCents: toSafeNumber(row.personalRevenueCents), departmentSalesCents: Object.fromEntries([...row.departmentSalesCents].map(([key, value]) => [key, toSafeNumber(value)])), departmentTurnoverCents: Object.fromEntries([...row.departmentTurnoverCents].map(([key, value]) => [key, toSafeNumber(value)])), teamFundCents: toSafeNumber(row.teamFundCents), basePayCents: toSafeNumber(row.basePayCents), commissionCents: toSafeNumber(row.commissionCents), milestoneBonusCents: toSafeNumber(row.milestoneBonusCents), amountBeforeCapCents: toSafeNumber(row.amountBeforeCapCents), capCents: row.capCents === null ? null : toSafeNumber(row.capCents), capReductionCents: toSafeNumber(row.capReductionCents), amountCents: toSafeNumber(row.amountCents) }))
    });
  }

  const publicEmployees = [...employeeTotals.values()].sort((a, b) => String(a.employeeId).localeCompare(String(b.employeeId))).map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === 'bigint' ? toSafeNumber(value) : value])));
  const hasUnsafeAmount = (row) => Object.entries(row).some(([key, value]) => value === null && key !== 'capCents' && (key.endsWith('Cents') || key === 'venueTurnoverCents' || key === 'cumulativeVenueTurnoverCents'));
  const unsafeAmounts = publicEmployees.some(hasUnsafeAmount);
  if (unsafeAmounts || dailyRows.some((day) => day.venueTurnoverCents === null || day.cumulativeVenueTurnoverCents === null || day.employees.some(hasUnsafeAmount) || day.lines.some(hasUnsafeAmount))) blockers.push('amount_exceeds_safe_integer_cents');
  return {
    status: blockers.length ? 'blocked' : 'ready',
    payoutEligible: blockers.length === 0 && criticalErrors.length === 0,
    mode: scheme.mode,
    schemeId: scheme.id,
    schemeVersionId: scheme.versionId,
    currency: scheme.currency || 'RUB',
    periodFrom: input.periodFrom,
    periodTo: input.periodTo,
    venueTurnoverBasis: hasVenueDailyTurnover ? 'venue_daily_manifest_scenario' : 'sales_line_sum_scenario',
      monthTurnoverCents: toSafeNumber(effectiveModes.has('final_month_threshold') ? finalMonthTurnover : monthTurnoverAtPeriodEnd),
      modes: [...effectiveModes].sort(),
    blockers: [...new Set(blockers)],
    criticalErrors,
    daily: dailyRows,
    employees: publicEmployees
  };
};

module.exports = { MODES: [...MODES], calculatePayrollScheme, validateScheme, validatePersonalThresholdAssignments, validatePersonalScalarAssignments };
