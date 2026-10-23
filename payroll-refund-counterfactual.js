'use strict';

// Full-period payroll-only counterfactual. No DB/source attestation, stored-run
// mutation, debt, correction, accrual or payment authority is created here.
const { createHash } = require('node:crypto');
const { buildSavedPayrollRefundRecalculationBasis } = require('./payroll-refund-recalculation-basis');
const { calculatePayrollScheme, employeeActiveOn } = require('./payroll-schemes');
const { normalizePayrollSourcePolicies, PAYROLL_FROZEN_SALE_DEPLETION_COST_PAYROLL_POLICY: COST_POLICY,
  PAYROLL_REFUND_ADJUSTED_VENUE_TURNOVER_POLICY: VENUE_POLICY } = require('./payroll-source-policies');
const POLICY = 'saved_run_refund_counterfactual_v1';
const fail = suffix => { throw Object.assign(new TypeError(`payroll_refund_counterfactual_${suffix}`), { code: `payroll_refund_counterfactual_${suffix}` }); };
const plain = value => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : plain(value) ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const inspectJson = input => {
  const active = new WeakSet(); let nodes = 0;
  const visit = (value, depth) => {
    if (++nodes > 2500000 || depth > 64) fail('structure_limit');
    if (value === null || typeof value === 'boolean') return;
    if (typeof value === 'string') { if (value.length > 1048576) fail('structure_limit'); return; }
    if (typeof value === 'number') { if (!Number.isSafeInteger(value) || Object.is(value, -0)) fail('json_invalid'); return; }
    if ((!plain(value) && !Array.isArray(value)) || active.has(value)) fail('json_invalid');
    active.add(value);
    const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(value);
    if (keys.some(key => typeof key !== 'string') || Object.values(descriptors).some(d => !Object.hasOwn(d, 'value') || !d.enumerable && !Array.isArray(value))) fail('json_invalid');
    if (Array.isArray(value) && (keys.length !== value.length + 1 || keys.some(key => key !== 'length' && !/^(0|[1-9][0-9]*)$/.test(key)))) fail('json_invalid');
    for (const key of keys) if (key !== 'length' || !Array.isArray(value)) visit(descriptors[key].value, depth + 1);
    active.delete(value);
  };
  visit(input, 0);
  if (Buffer.byteLength(canonical(input), 'utf8') > 40 * 1024 * 1024) fail('structure_limit');
};
const shape = (value, keys) => {
  if (!plain(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail('shape_invalid');
};
const freeze = value => { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const safe = value => { if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) fail('amount_overflow'); return Number(value); };
const money = value => { if (!Number.isSafeInteger(value) || value < 0) fail('amount_invalid'); return BigInt(value); };
const datesIn = period => {
  const dates = [];
  for (let ms = Date.parse(`${period.from}T00:00:00Z`), end = Date.parse(`${period.to}T00:00:00Z`); ms <= end; ms += 86400000) dates.push(new Date(ms).toISOString().slice(0, 10));
  return dates;
};
const exactDaily = (rows, dates, keys) => {
  if (!Array.isArray(rows) || rows.length !== dates.length) fail('venue_coverage_mismatch');
  const byDate = new Map();
  for (const row of rows) {
    shape(row, ['date', ...keys]);
    if (!dates.includes(row.date) || byDate.has(row.date)) fail('venue_coverage_mismatch');
    for (const key of keys) money(row[key]);
    byDate.set(row.date, row);
  }
  return byDate;
};
const buildVenueTurnover = (proof, original, basis, dates) => {
  shape(proof, ['policyCode', 'originalDaily', 'remainingDaily', 'adjustmentDaily']);
  if (proof.policyCode !== VENUE_POLICY) fail('venue_policy_invalid');
  const baseline = exactDaily(original.venueDailyTurnover, dates, ['turnoverCents']);
  const previous = exactDaily(proof.originalDaily, dates, ['turnoverCents']);
  const remaining = exactDaily(proof.remainingDaily, dates, ['turnoverCents']);
  const adjustments = exactDaily(proof.adjustmentDaily, dates, ['originalAdjustmentCents', 'remainingAdjustmentCents']);
  const originalMerchandise = new Map(), remainingMerchandise = new Map();
  for (const line of basis.saleLines) {
    originalMerchandise.set(line.date, (originalMerchandise.get(line.date) || 0n) + BigInt(line.originalNetCents));
    remainingMerchandise.set(line.date, (remainingMerchandise.get(line.date) || 0n) + BigInt(line.remainingNetCents));
  }
  return dates.map(date => {
    const prior = previous.get(date), next = remaining.get(date), adjustment = adjustments.get(date);
    if (prior.turnoverCents !== baseline.get(date).turnoverCents
        || BigInt(prior.turnoverCents) !== (originalMerchandise.get(date) || 0n) + BigInt(adjustment.originalAdjustmentCents)
        || adjustment.remainingAdjustmentCents !== adjustment.originalAdjustmentCents
        || BigInt(next.turnoverCents) !== (remainingMerchandise.get(date) || 0n) + BigInt(adjustment.remainingAdjustmentCents)) fail('venue_binding_mismatch');
    return { date, turnoverCents: next.turnoverCents };
  });
};
const buildCosts = (proof, original, basis) => {
  shape(proof, ['policyCode', 'currency', 'lines']);
  if (proof.policyCode !== COST_POLICY || proof.currency !== basis.currency || !Array.isArray(proof.lines)) fail('cost_policy_invalid');
  const required = new Map(original.sales.filter(line => Object.hasOwn(line, 'costSnapshot')).map(line => [line.id, line]));
  if (proof.lines.length !== required.size) fail('cost_coverage_mismatch');
  const basisLines = new Map(basis.saleLines.map(line => [line.saleLineEventId, line])), costs = new Map();
  for (const row of proof.lines) {
    shape(row, ['saleLineEventId', 'originalCostSnapshot', 'originalQuantity', 'remainingQuantity', 'remainingCostCents']);
    const source = required.get(row.saleLineEventId), line = basisLines.get(row.saleLineEventId);
    if (!source || !line || costs.has(row.saleLineEventId) || canonical(source.costSnapshot) !== canonical(row.originalCostSnapshot)
        || row.originalQuantity !== line.originalQuantity || row.remainingQuantity !== line.remainingQuantity
        || row.originalCostSnapshot.currency !== basis.currency) fail('cost_binding_mismatch');
    money(row.remainingCostCents); money(row.originalCostSnapshot.costCents);
    // Explicit payroll depletion policy retains the original consumed cost,
    // including a fully returned line. This is not actual COGS/restock accounting.
    if (row.remainingCostCents !== row.originalCostSnapshot.costCents) fail('cost_depletion_mismatch');
    costs.set(row.saleLineEventId, structuredClone(row.originalCostSnapshot));
  }
  return costs;
};
const components = row => {
  const value = field => row ? money(row[field]) : 0n;
  const fixedBaseCents = value('basePayCents'), commissionCents = value('commissionCents'), teamFundCents = value('teamFundCents'),
    milestoneBonusCents = value('milestoneBonusCents'), capReductionCents = value('capReductionCents'), amountCents = value('amountCents');
  const variableBeforeCapCents = commissionCents + teamFundCents + milestoneBonusCents;
  const residualAfterFixedCents = amountCents - fixedBaseCents;
  if (fixedBaseCents + variableBeforeCapCents - capReductionCents !== amountCents) fail('result_components_mismatch');
  return Object.fromEntries(Object.entries({ fixedBaseCents, commissionCents, teamFundCents, milestoneBonusCents,
    variableBeforeCapCents, capReductionCents, residualAfterFixedCents, amountCents }).map(([key, value]) => [key, safe(value)]));
};
const compare = (before, after) => {
  const baseline = components(before), counterfactual = components(after);
  const delta = Object.fromEntries(Object.keys(baseline).map(key => [key, safe(BigInt(counterfactual[key]) - BigInt(baseline[key]))]));
  if (delta.fixedBaseCents !== 0) fail('fixed_pay_changed');
  return { baseline, counterfactual, delta };
};
const buildDeltas = (original, baseline, result, dates) => {
  const ids = original.employees.map(employee => employee.id).sort();
  const mapEmployees = rows => new Map(rows.map(row => [row.employeeId, row]));
  const priorTotals = mapEmployees(baseline.employees), nextTotals = mapEmployees(result.employees);
  const employees = ids.map(employeeId => ({ employeeId, ...compare(priorTotals.get(employeeId), nextTotals.get(employeeId)) }));
  const priorDays = new Map(baseline.daily.map(row => [row.date, row])), nextDays = new Map(result.daily.map(row => [row.date, row]));
  const daily = dates.flatMap(date => {
    const prior = priorDays.get(date), next = nextDays.get(date);
    if (!prior || !next) fail('result_period_mismatch');
    const previous = mapEmployees(prior.employees), current = mapEmployees(next.employees);
    return ids.map(employeeId => ({ date, employeeId, ...compare(previous.get(employeeId), current.get(employeeId)) }));
  });
  const sum = (rows, part, key) => rows.reduce((amount, row) => amount + BigInt(row[part][key]), 0n);
  const totals = {};
  for (const part of ['baseline', 'counterfactual', 'delta']) {
    totals[part] = {};
    for (const key of Object.keys(components(null))) {
      const amount = sum(employees, part, key);
      if (amount !== sum(daily, part, key)) fail('result_daily_total_mismatch');
      totals[part][key] = safe(amount);
    }
  }
  return { signConvention: 'counterfactual_minus_saved_baseline', fixedBasis: 'base_pay_before_cap',
    capReductionTreatment: 'separate_component_not_allocated_to_fixed_or_variable',
    residualAfterFixedMeaning: 'signed_arithmetic_residual_not_deductible_variable_pay', employees, daily, totals };
};

function buildPayrollRefundCounterfactual(args) {
  inspectJson(args); shape(args, ['header', 'evidence', 'provenanceSha256', 'projection', 'economicInputs']);
  const { header, evidence, provenanceSha256, projection, economicInputs } = args;
  const basis = buildSavedPayrollRefundRecalculationBasis({ header, evidence, provenanceSha256, projection });
  shape(economicInputs, ['schemaVersion', 'basisWatermark', 'venueTurnover', 'remainingCosts']);
  if (economicInputs.schemaVersion !== 1 || economicInputs.basisWatermark !== basis.basisWatermark) fail('economic_basis_mismatch');
  const original = evidence.calculatorReplay.input, baselineResult = evidence.calculatorReplay.result, dates = datesIn(basis.period);
  const finish = (status, reasons, input = null, result = null, deltas = null) => {
    const output = { schemaVersion: 1, policyCode: POLICY, status, reasons: [...new Set(reasons)].sort(),
      officialReady: false, payoutEligible: false, sourceAttested: false, persistence: 'none', financialAction: 'none',
      deltaApplicationEligible: false, requiresPaidVariableProtectionReview: true,
      requiresSavedRunStorageAttestation: true, requiresEconomicSourceAttestation: true, costAccountingScope: 'payroll_only_not_actual_cogs',
      venueId: basis.venueId, currency: basis.currency, period: structuredClone(basis.period), basis,
      economicInputs: structuredClone(economicInputs), economicInputsWatermark: hash(economicInputs),
      baseline: { input: structuredClone(original), result: structuredClone(baselineResult),
        inputSha256: basis.replayHashes.inputSha256, resultSha256: basis.replayHashes.resultSha256 },
      counterfactual: input ? { input, result, inputSha256: hash(input), resultSha256: result ? hash(result) : null } : null, deltas };
    return freeze({ ...output, counterfactualWatermark: hash(output) });
  };
  const hasVenue = Object.hasOwn(original, 'venueDailyTurnover');
  if (hasVenue && economicInputs.venueTurnover === null) return finish('blocked', ['venue_economic_proof_required']);
  if (!hasVenue && economicInputs.venueTurnover !== null) fail('unexpected_venue_proof');
  if (basis.needsRemainingCostAttestation) {
    let policy;
    try { policy = normalizePayrollSourcePolicies(evidence.schemeSnapshot.sourcePolicies); }
    catch (_) { return finish('blocked', ['frozen_cost_policy_opt_in_required']); }
    if (policy?.schemaVersion !== 2 || policy.earnings?.marginCost !== COST_POLICY) return finish('blocked', ['frozen_cost_policy_opt_in_required']);
    if (economicInputs.remainingCosts === null) return finish('blocked', ['frozen_cost_economic_proof_required']);
  } else if (economicInputs.remainingCosts !== null) fail('unexpected_cost_proof');
  const costs = basis.needsRemainingCostAttestation ? buildCosts(economicInputs.remainingCosts, original, basis) : new Map();
  const input = structuredClone(original), lines = new Map(basis.saleLines.map(line => [line.saleLineEventId, line]));
  delete input.sourceEvidence;
  delete input.venueDailyTurnoverCoverage;
  input.sales = original.sales.map(sale => {
    const line = lines.get(sale.id), next = { id: sale.id, employeeId: sale.employeeId, date: sale.date, currency: basis.currency,
      menuItemId: sale.menuItemId, department: sale.department, turnoverCents: line.remainingNetCents, commissionBaseCents: line.remainingNetCents,
      sourceWatermark: hash({ policyCode: POLICY, basisWatermark: basis.basisWatermark, line }), economicBasis: POLICY, sourceAttested: false };
    if (costs.has(sale.id)) next.costSnapshot = costs.get(sale.id);
    return next;
  });
  const revenues = new Map(basis.employeeDaily.map(row => [JSON.stringify([row.employeeId, row.date]), row.remainingNetCents]));
  const daily = dates.flatMap(date => original.employees.filter(employee => employeeActiveOn(employee, date))
    .map(employee => ({ employeeId: employee.id, date, netRevenueCents: revenues.get(JSON.stringify([employee.id, date])) || 0 })));
  const revenueFacts = { schemaVersion: 1, policyCode: 'employee_attributed_merchandise_net_v1', currency: basis.currency,
    period: structuredClone(basis.period), coverage: { complete: true }, daily };
  input.personalRevenueSource = { ...revenueFacts, status: 'available', economicBasis: POLICY, sourceAttested: false,
    sourceWatermark: hash({ basisWatermark: basis.basisWatermark, policyCode: POLICY, revenueFacts }) };
  input.coverage = { kind: original.coverage.kind, from: basis.period.from, through: basis.period.to, complete: true,
    economicBasis: POLICY, sourceAttested: false, watermark: hash({ basisWatermark: basis.basisWatermark, economicInputsWatermark: hash(economicInputs) }) };
  if (hasVenue) {
    input.venueDailyTurnover = buildVenueTurnover(economicInputs.venueTurnover, original, basis, dates);
    input.venueDailyTurnoverCoverage = { from: basis.period.from, through: basis.period.to, complete: true,
      venueId: basis.venueId, currency: basis.currency, period: structuredClone(basis.period),
      sourceWatermark: hash({ basisWatermark: basis.basisWatermark, proof: economicInputs.venueTurnover }),
      watermarkScope: 'payroll_counterfactual_venue_economic_model', sourceAttested: false,
      refundsIncluded: true, amountBasis: VENUE_POLICY };
  }
  let result;
  try { result = calculatePayrollScheme(input); }
  catch (_) { return finish('blocked', ['counterfactual_engine_failed'], input); }
  if (result.status !== 'ready' || result.blockers?.length || result.criticalErrors?.length) {
    return finish('blocked', [...(result.blockers || []), ...(result.criticalErrors || []).map(row => row.code), 'counterfactual_engine_not_ready'], input, result);
  }
  return finish('counterfactual_calculated', [], input, result, buildDeltas(original, baselineResult, result, dates));
}

module.exports = { buildPayrollRefundCounterfactual, PAYROLL_REFUND_COUNTERFACTUAL_POLICY: POLICY };
