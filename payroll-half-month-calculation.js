'use strict';

// Pure second-half forecast adapter. The monthly refund-aware builder remains
// the sole verifier of source context; this adapter narrows only the earning
// window before independently rerunning the existing calculator.
const { createHash } = require('node:crypto');
const { buildPayrollRefundAwareCalculation } = require('./payroll-refund-aware-calculation');
const { reconcilePayrollHalfMonthSettlement } = require('./payroll-half-month-settlement');
const { calculatePayrollScheme } = require('./payroll-schemes');
const { buildPayrollHalfMonthPeriod } = require('./payroll-pay-periods');

const CAPABILITY = 'refund_aware_second_half_candidate_v1';
const SHA = /^[a-f0-9]{64}$/;
const copy = value => structuredClone(value);
const frozen = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(frozen);
    Object.freeze(value);
  }
  return value;
};
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().filter(key => value[key] !== undefined)
    .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
  && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const monthStart = date => `${date.slice(0, 7)}-01`;
const blocked = (reasons, basisPeriod = null, earningPeriod = null, parent = null) => frozen({
  schemaVersion: 1, capabilityVersion: CAPABILITY, status: 'blocked', candidateOnly: true,
  officialReady: false, payoutEligible: false, sourceAttested: false, persistence: 'none',
  settlementAuthorized: false, milestoneClaimRequired: true, reasons: [...new Set(reasons)].sort(), basisPeriod, earningPeriod,
  parentCalculationWatermark: parent?.calculationWatermark || null, input: null, engineResult: null,
  amountCents: null, candidateWatermark: null
});

function buildPayrollHalfMonthCalculation(monthlySourceArgs = {}) {
  if (!monthlySourceArgs || typeof monthlySourceArgs !== 'object' || Array.isArray(monthlySourceArgs)) {
    return blocked(['payroll_half_month_month_context_required']);
  }
  const period = monthlySourceArgs.period;
  if (!validDate(period?.from) || !validDate(period?.to) || period.from !== monthStart(period.from)
      || period.to !== buildPayrollHalfMonthPeriod(period.from.slice(0, 7), 2).monthBasisPeriod.to) {
    return blocked(['payroll_half_month_month_context_required']);
  }
  const payContext = buildPayrollHalfMonthPeriod(period.from.slice(0, 7), 2);
  if (payContext.monthBasisPeriod.from !== period.from || payContext.monthBasisPeriod.to !== period.to
      || payContext.settlementAuthorized !== false) return blocked(['payroll_half_month_window_mismatch']);
  const earningPeriod = copy(payContext.earningPeriod);
  const basisPeriod = copy(payContext.monthBasisPeriod);

  // Verify the entire monthly source context first. Never accept a prebuilt
  // calculation or caller-supplied engine result as source authority.
  const parent = buildPayrollRefundAwareCalculation(monthlySourceArgs);
  if (parent.status !== 'refund_aware_calculated' || parent.officialReady !== false
      || parent.payoutEligible !== false || parent.sourceAttested !== false
      || parent.period?.from !== basisPeriod.from || parent.period?.to !== basisPeriod.to
      || !SHA.test(parent.calculationWatermark || '') || !parent.input || !parent.engineResult) {
    return blocked([...(parent.reasons || []), 'payroll_half_month_month_context_unverified'], basisPeriod, earningPeriod, parent);
  }
  if (parent.input.periodFrom !== basisPeriod.from || parent.input.periodTo !== basisPeriod.to
      || parent.input.coverage?.from !== basisPeriod.from || parent.input.coverage?.through !== basisPeriod.to
      || !Array.isArray(parent.economics?.remainingDaily)
      || parent.economics.remainingDaily.length !== Number(basisPeriod.to.slice(-2))) {
    return blocked(['payroll_half_month_month_basis_mismatch'], basisPeriod, earningPeriod, parent);
  }
  if (monthlySourceArgs.scheme?.mode === 'final_month_threshold') {
    return blocked(['payroll_half_month_final_month_threshold_requires_advance_policy'], basisPeriod, earningPeriod, parent);
  }

  const input = copy(parent.input);
  input.periodFrom = earningPeriod.from;
  input.periodTo = earningPeriod.to;
  // Keep full month-to-date venue turnover and source coverage. The engine
  // consumes it as the cumulative pricing basis while emitting only earning
  // period dates.
  input.venueDailyTurnover = copy(parent.economics.remainingDaily);
  input.venueDailyTurnoverCoverage = { from: basisPeriod.from, through: basisPeriod.to, complete: true,
    venueId: parent.venueId, currency: parent.currency, period: copy(basisPeriod),
    venueTimezone: monthlySourceArgs.periodClosure?.timezone || null,
    sourceWatermark: parent.economics.sourceWatermark,
    watermarkScope: 'frozen_sale_date_remaining_canonical_turnover_v2', refundsIncluded: true,
    amountBasis: monthlySourceArgs.scheme?.sourcePolicies?.earnings?.venueTurnover };
  input.sales = input.sales.filter(row => row.date >= earningPeriod.from && row.date <= earningPeriod.to);
  if (!input.personalRevenueSource || !Array.isArray(input.personalRevenueSource.daily)
      || !SHA.test(input.personalRevenueSource.sourceWatermark || '')) {
    return blocked(['payroll_half_month_personal_revenue_context_missing'], basisPeriod, earningPeriod, parent);
  }
  const personalRevenueSource = copy(input.personalRevenueSource);
  personalRevenueSource.period = copy(earningPeriod);
  personalRevenueSource.daily = personalRevenueSource.daily.filter(row => row.date >= earningPeriod.from && row.date <= earningPeriod.to);
  // Rebind its hash after narrowing the earning facts. Other sourceEvidence,
  // approved attendance rows/coverage, employees, and role assignments stay
  // tied to the verified monthly context.
  personalRevenueSource.sourceWatermark = hash({ schemaVersion: personalRevenueSource.schemaVersion,
    policyCode: personalRevenueSource.policyCode, currency: personalRevenueSource.currency,
    period: personalRevenueSource.period, coverage: personalRevenueSource.coverage,
    daily: personalRevenueSource.daily, parentSourceWatermark: parent.input.personalRevenueSource.sourceWatermark,
    earningPeriod });
  input.personalRevenueSource = personalRevenueSource;

  const engineResult = calculatePayrollScheme(input);
  if (engineResult.status !== 'ready' || engineResult.blockers?.length || engineResult.criticalErrors?.length) {
    return blocked([...(engineResult.blockers || []), ...(engineResult.criticalErrors || []).map(row => row.code),
      'payroll_half_month_engine_not_ready'], basisPeriod, earningPeriod, parent);
  }
  if (engineResult.periodFrom !== earningPeriod.from || engineResult.periodTo !== earningPeriod.to
      || engineResult.daily.some(row => row.date < earningPeriod.from || row.date > earningPeriod.to)) {
    return blocked(['payroll_half_month_engine_period_mismatch'], basisPeriod, earningPeriod, parent);
  }
  let total = 0n;
  for (const row of engineResult.employees || []) {
    if (!Number.isSafeInteger(row.amountCents) || row.amountCents < 0) {
      return blocked(['payroll_half_month_amount_invalid'], basisPeriod, earningPeriod, parent);
    }
    total += BigInt(row.amountCents);
  }
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) return blocked(['payroll_half_month_amount_overflow'], basisPeriod, earningPeriod, parent);

  const payload = { schemaVersion: 1, capabilityVersion: CAPABILITY, status: 'second_half_forecast',
    candidateOnly: true, officialReady: false, payoutEligible: false, sourceAttested: false, persistence: 'none',
    milestoneClaimRequired: true, reasons: [], venueId: parent.venueId, schemeVersionId: parent.schemeVersionId,
    currency: parent.currency, basisPeriod, earningPeriod, scheduledPaymentDate: payContext.scheduledPaymentDate,
    settlementAuthorized: false, parentCalculationWatermark: parent.calculationWatermark,
    parentInputWatermark: parent.inputWatermark, sourceWatermarks: {
      recognition: parent.input.sourceEvidence?.recognitionManifest?.sourceWatermark || null,
      eligibility: parent.input.sourceEvidence?.employmentEligibility?.sourceWatermark || null,
      attendance: parent.input.attendanceCoverage?.watermark || null,
      economics: parent.economics?.sourceWatermark || null
    }, amountCents: Number(total), input, engineResult,
    inputWatermark: hash(input), engineResultWatermark: hash(engineResult) };
  return frozen({ ...payload, candidateWatermark: hash(payload) });
}

// Per-day results already incorporate dated role and personal overrides.
function payrollMonthHasDeferredPay(result, employeeId = null) {
  return result?.status === 'ready' && result.daily.some(day => day.employees.some(employee =>
    (employeeId === null || employee.employeeId === employeeId)
    && (employee.mode === 'final_month_threshold' || employee.milestoneBonusCents > 0)));
}

// Monthly rates can apply to sales earned before the 15th. Preserve those
// earning dates and the complete monthly replay. The H1 claim is a separate
// credit against the employee's closed-month entitlement.
function buildPayrollDeferredMonthSettlement(monthlySourceArgs, h1States, employeeId = null) {
  const monthly = buildPayrollRefundAwareCalculation(monthlySourceArgs);
  if (monthly.status !== 'refund_aware_calculated' || monthly.periodClosure?.venueLocalDate <= monthly.period.to
      || !payrollMonthHasDeferredPay(monthly.engineResult, employeeId)) {
    return blocked(['payroll_half_month_closed_threshold_run_required']);
  }
  const month = monthly.period.from.slice(0, 7);
  const window = buildPayrollHalfMonthPeriod(month, 2);
  if (monthly.period.from !== window.monthBasisPeriod.from || monthly.period.to !== window.monthBasisPeriod.to
      || !Array.isArray(h1States)) return blocked(['payroll_half_month_month_context_required']);
  const employees = monthly.engineResult.employees.filter(row => employeeId === null || row.employeeId === employeeId);
  if (!employees.length) return blocked(['payroll_half_month_employee_binding_mismatch']);
  const earnedByEmployee = new Map(employees.map(row => [row.employeeId, []]));
  for (const day of monthly.engineResult.daily) {
    for (const row of day.employees) {
      earnedByEmployee.get(row.employeeId)?.push({date: day.date, grossMinor: row.amountCents,
        fixedMinor: row.basePayCents, commissionMinor: row.commissionCents, milestoneMinor: row.milestoneBonusCents,
        teamFundMinor: row.teamFundCents, capReductionMinor: row.capReductionCents});
    }
  }
  const h1ByEmployee = new Map(h1States.map(row => [row?.employeeId, row]));
  const residuals = [];
  for (const [employeeId, days] of earnedByEmployee) {
    const advance = h1ByEmployee.get(employeeId)?.grossAccruedMinor;
    if (!Number.isSafeInteger(advance) || advance < 0) return blocked(['payroll_half_month_h1_not_usable']);
    const earned = days.reduce((sum, day) => sum + BigInt(day.grossMinor), 0n);
    const outstanding = earned - BigInt(advance);
    if (outstanding < 0n) return blocked(['payroll_half_month_negative_residual_requires_review']);
    residuals.push({employeeId, grossMinor: Number(outstanding)});
  }
  const reconciliation = reconcilePayrollHalfMonthSettlement({venueId: monthly.venueId, month,
    currency: monthly.currency, monthClosed: true, sourcesFresh: true, h1States,
    monthlyGrossByEmployee: employees.map(row => ({employeeId: row.employeeId, grossMinor: row.amountCents})),
    h2GrossByEmployee: residuals});
  if (reconciliation.status !== 'h2_reconciled_candidate') return reconciliation;
  const evidence = {schemaVersion: 1, policy: 'closed_month_less_confirmed_h1_gross_v1',
    monthlyCalculationWatermark: monthly.calculationWatermark, reconciliation,
    employees: reconciliation.items.map(row => ({employeeId: row.employeeId, earnedDays: earnedByEmployee.get(row.employeeId),
      h1CreditMinor: row.h1GrossAccruedMinor, h2GrossMinor: row.h2GrossAccruedMinor}))};
  const economicClaims = [];
  for (const row of reconciliation.items) {
    const state = h1ByEmployee.get(row.employeeId);
    const approvalLedgerSha256 = state.zeroBase === true ? state.zeroBaseEvidenceSha256 : state.ledgerHash;
    if (!SHA.test(approvalLedgerSha256 || '')) return blocked(['payroll_half_month_h1_ledger_mismatch']);
    economicClaims.push({employeeId: row.employeeId, h1Origin: row.h1Origin, h1ClaimId: row.h1ClaimId,
      h1EntryId: row.h1EntryId, h1RunId: row.h1RunId, approvalLedgerSha256,
      h1GrossAccruedMinor: row.h1GrossAccruedMinor, h1AppliedCorrectionMinor: row.h1AppliedCorrectionMinor,
      h1NetDueMinor: row.h1NetDueMinor});
  }
  const economicEvidenceSha256 = hash({schemaVersion: evidence.schemaVersion, policy: evidence.policy,
    monthlyCalculationWatermark: evidence.monthlyCalculationWatermark, employees: evidence.employees, economicClaims});
  return frozen({...evidence, economicClaims, economicEvidenceSha256,
    evidenceSha256: hash({...evidence, economicClaims}), settlementAuthorized: false});
}

function verifyPayrollHalfMonthCalculationCandidate(candidate, monthlySourceArgs) {
  const rebuilt = buildPayrollHalfMonthCalculation(monthlySourceArgs);
  return candidate?.status === 'second_half_forecast'
    && candidate.candidateWatermark === rebuilt.candidateWatermark
    && canonical(candidate) === canonical(rebuilt);
}

module.exports = { payrollMonthHasDeferredPay, buildPayrollDeferredMonthSettlement, buildPayrollHalfMonthCalculation, verifyPayrollHalfMonthCalculationCandidate,
  PAYROLL_HALF_MONTH_CALCULATION_CAPABILITY: CAPABILITY };
