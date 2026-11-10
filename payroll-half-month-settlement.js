'use strict';

// Reconciles a source-verified, closed monthly run with the official H1 claim
// and an independently rebuilt H2 earning-window calculation. This module is
// deliberately pure: the source-fenced service must load all three inputs in
// one transaction, and the DB claim/205 transition remain the write authority.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{64}$/;
const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;
const fail = suffix => { throw Object.assign(new TypeError(`payroll_half_month_settlement_${suffix}`), {
  code: `payroll_half_month_settlement_${suffix}`
}); };
const isRecord = value => value && Object.getPrototypeOf(value) === Object.prototype;
const safeMinor = value => Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
const frozen = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(frozen);
    Object.freeze(value);
  }
  return value;
};
const blocked = reasons => frozen({ schemaVersion: 1, status: 'blocked', candidateOnly: true,
  officialReady: false, payoutEligible: false, settlementAuthorized: false, sourceAttested: false,
  ledgerAttested: false, persistence: 'none', reasons: [...new Set(reasons)].sort(), items: [] });

function validateRows(rows, label) {
  if (!Array.isArray(rows)) fail(`${label}_invalid`);
  const map = new Map();
  for (const row of rows) {
    if (!isRecord(row) || !UUID.test(row.employeeId || '') || !safeMinor(row.grossMinor)
        || map.has(row.employeeId)) fail(`${label}_invalid`);
    map.set(row.employeeId, row.grossMinor);
  }
  return map;
}

/**
 * @param {object} input trusted service-composed values from one source fence:
 * venueId, month, currency, monthClosed, sourcesFresh,
 * monthlyGrossByEmployee[{employeeId,grossMinor}],
 * h2GrossByEmployee[{employeeId,grossMinor}], and h1States returned by the
 * reviewed H1 reader. No caller-provided request payload may populate proofs.
 */
function reconcilePayrollHalfMonthSettlement(input) {
  if (!isRecord(input) || !UUID.test(input.venueId || '') || !MONTH.test(input.month || '')
      || input.month.startsWith('0000') || input.currency !== 'RUB'
      || input.monthClosed !== true || input.sourcesFresh !== true) {
    return blocked(['payroll_half_month_month_context_unverified']);
  }
  const monthFrom = `${input.month}-01`;
  const [, year, month] = MONTH.exec(input.month);
  const lastDay = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
  const monthTo = `${input.month}-${String(lastDay).padStart(2, '0')}`;
  const monthly = validateRows(input.monthlyGrossByEmployee, 'monthly_gross');
  const h2 = validateRows(input.h2GrossByEmployee, 'h2_gross');
  if (!Array.isArray(input.h1States) || monthly.size === 0 || monthly.size !== h2.size) {
    return blocked(['payroll_half_month_employee_coverage_invalid']);
  }
  const h1 = new Map();
  const reasons = [];
  for (const state of input.h1States) {
    if (!isRecord(state) || !UUID.test(state.employeeId || '') || h1.has(state.employeeId)) {
      return blocked(['payroll_half_month_h1_state_invalid']);
    }
    if (state.usableForH2 !== true) reasons.push('payroll_half_month_h1_not_usable');
    const zeroBase = state.status === 'zero_base' && state.zeroBase === true;
    if (state.venueId !== input.venueId || state.month !== input.month || state.currency !== input.currency
        || state.period?.from !== monthFrom || state.period?.to !== `${input.month}-14`
        || (!zeroBase && (!UUID.test(state.runId || '') || !UUID.test(state.entryId || '') || !UUID.test(state.claimId || '')))) {
      reasons.push('payroll_half_month_h1_binding_mismatch');
    }
    if (!zeroBase && !['approved', 'paid'].includes(state.status)) reasons.push('payroll_half_month_h1_not_finalized');
    if (zeroBase && (!SHA.test(state.zeroBaseEvidenceSha256 || '') || state.grossAccruedMinor !== 0
        || state.netDueMinor !== 0 || state.paidMinor !== 0 || state.appliedCorrectionMinor !== 0)) {
      reasons.push('payroll_half_month_h1_zero_base_unproven');
    }
    if (![state.grossAccruedMinor, state.netDueMinor, state.paidMinor, state.appliedCorrectionMinor].every(safeMinor)
        || !Number.isSafeInteger(state.netDueMinor + state.appliedCorrectionMinor)
        || state.netDueMinor + state.appliedCorrectionMinor !== state.grossAccruedMinor
        || state.paidMinor > state.netDueMinor
        || (state.status === 'approved' && state.paidMinor !== 0)
        || (state.status === 'paid' && state.paidMinor !== state.netDueMinor)) reasons.push('payroll_half_month_h1_ledger_mismatch');
    h1.set(state.employeeId, state);
  }
  if (h1.size !== monthly.size || [...monthly.keys()].some(id => !h1.has(id))
      || [...h1.keys()].some(id => !monthly.has(id) || !h2.has(id))) {
    reasons.push('payroll_half_month_employee_binding_mismatch');
  }
  if (reasons.length) return blocked(reasons);

  const items = [];
  for (const [employeeId, monthGrossMinor] of monthly) {
    const h1State = h1.get(employeeId);
    const h2GrossMinor = monthGrossMinor - h1State.grossAccruedMinor;
    if (h2GrossMinor < 0) return blocked(['payroll_half_month_negative_residual_requires_review']);
    if (h2.get(employeeId) !== h2GrossMinor) return blocked(['payroll_half_month_h2_calculation_mismatch']);
    items.push({ employeeId, currency: input.currency, month: input.month,
      period: { from: `${input.month}-15`, to: monthTo },
      monthlyGrossMinor: monthGrossMinor,
      h1GrossAccruedMinor: h1State.grossAccruedMinor,
      h2GrossAccruedMinor: h2GrossMinor,
      h1NetDueMinor: h1State.netDueMinor,
      h1PaidMinor: h1State.paidMinor,
      h1OutstandingPayableMinor: h1State.netDueMinor - h1State.paidMinor,
      h1AppliedCorrectionMinor: h1State.appliedCorrectionMinor,
      h1ClaimId: h1State.claimId || null,
      h1EntryId: h1State.entryId || null,
      h1RunId: h1State.runId || null,
      h1Origin: h1State.zeroBase === true ? 'verified_zero_base' : 'official_claim',
      h1ZeroBaseEvidenceSha256: h1State.zeroBaseEvidenceSha256 || null,
      h1ZeroBaseEvidence: h1State.zeroBaseEvidence || null
    });
  }
  items.sort((a, b) => a.employeeId.localeCompare(b.employeeId));
  return frozen({ schemaVersion: 1, status: 'h2_reconciled_candidate', candidateOnly: true,
    officialReady: false, payoutEligible: false, settlementAuthorized: false, sourceAttested: false,
    ledgerAttested: false, persistence: 'none', reasons: [], venueId: input.venueId,
    month: input.month, currency: input.currency, closedPeriod: { from: monthFrom, to: monthTo }, items });
}

module.exports = { reconcilePayrollHalfMonthSettlement };
