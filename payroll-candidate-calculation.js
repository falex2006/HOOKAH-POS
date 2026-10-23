'use strict';

// Owner-only ephemeral scenario execution. This path never creates or approves
// a payroll run and must never be used as an input to a writer.
const { calculatePayrollScheme } = require('./payroll-schemes');
const { buildPayrollCalculationInputContract } = require('./payroll-calculation-input-contract');

const blocked = (scheme, period, reasons, requiredFacts = []) => ({ schemaVersion: 1, status: 'blocked', candidateOnly: true, payoutEligible: false,
  nonPayable: true, nonAccrual: true, officialReady: false, amountCents: null,
  schemeVersionId: scheme?.versionId || null, period: { from: period?.from || null, to: period?.to || null },
  requiredFacts, reasons: [...new Set(reasons)].sort(), inputWatermark: null, daily: [], employees: [] });

const buildPayrollCandidateCalculation = ({ venueId, scheme, period, readiness, attestations = {}, sourceBundle }) => {
  const contract = buildPayrollCalculationInputContract({ venueId, scheme, period, readiness, attestations,
    sourceBundle, purpose: 'candidate_preview' });
  if (contract.status !== 'candidate_only' || !contract.calculatorInput || contract.reasons.length) {
    return blocked(scheme, period, contract.reasons.length ? contract.reasons : ['payroll_candidate_calculator_input_unavailable'], contract.requiredFacts || []);
  }
  const result = calculatePayrollScheme(contract.calculatorInput);
  if (result.status !== 'ready' || result.blockers?.length || result.criticalErrors?.length) {
    return blocked(scheme, period, [...(result.blockers || []), ...(result.criticalErrors || []),
      ...(result.status !== 'ready' ? ['payroll_candidate_calculation_not_ready'] : [])], contract.requiredFacts || []);
  }
  const amountCents = result.employees.reduce((sum, row) => sum + BigInt(row.amountCents), 0n);
  if (amountCents > BigInt(Number.MAX_SAFE_INTEGER) || amountCents < 0n) {
    return blocked(scheme, period, ['payroll_candidate_amount_out_of_range']);
  }
  return {
    schemaVersion: 1, status: 'scenario_ready', candidateOnly: true, nonPayable: true, nonAccrual: true,
    officialReady: false, payoutEligible: false, mode: result.mode, schemeVersionId: result.schemeVersionId,
    currency: result.currency, period: { from: result.periodFrom, to: result.periodTo },
    amountCents: Number(amountCents), inputWatermark: contract.inputWatermark, requiredFacts: contract.requiredFacts,
    venueTurnoverBasis: result.venueTurnoverBasis, monthTurnoverCents: result.monthTurnoverCents,
    employees: result.employees, daily: result.daily,
    reasons: [], disclaimers: ['scenario_only', 'not_payable', 'not_accrued', 'no_payroll_run_created']
  };
};

module.exports = { buildPayrollCandidateCalculation };
