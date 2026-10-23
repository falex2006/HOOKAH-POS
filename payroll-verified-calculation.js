'use strict';

// Pure server-side adapter: revalidates the source bundle, then invokes the
// wage engine itself. It never consumes a caller-provided calculation result.
const { createHash } = require('node:crypto');
const { calculatePayrollScheme } = require('./payroll-schemes');
const { buildPayrollCalculationInputContract, NO_REFUND_INPUT_CAPABILITY } = require('./payroll-calculation-input-contract');

const stable = value => Array.isArray(value) ? `[${value.map(stable).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`
    : JSON.stringify(value);
const digest = value => createHash('sha256').update(stable(value)).digest('hex');
const deepFreeze = value => {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
};
const detachedFrozen = value => deepFreeze(structuredClone(value));
const blocked = ({ scheme, period, reason, reasons = null, requiredFacts = [] }) => detachedFrozen({ schemaVersion: 1,
  status: 'blocked', officialReady: false, payoutEligible: false, persistence: 'none',
  schemeVersionId: scheme?.versionId || null, period: { from: period?.from || null, to: period?.to || null },
  requiredFacts: [...requiredFacts], reasons: [...new Set((Array.isArray(reasons) ? reasons : [reason])
    .filter(value => typeof value === 'string' && /^[A-Za-z0-9_]+$/.test(value)))].sort(), inputWatermark: null, closureWatermark: null,
  calculationWatermark: null, input: null, engineResult: null, provenance: null });

const buildPayrollVerifiedCalculation = ({ venueId, scheme, period, readiness, attestations = {}, sourceBundle, periodClosure }) => {
  let contract;
  try {
    contract = buildPayrollCalculationInputContract({ venueId, scheme, period, readiness, attestations,
      sourceBundle, purpose: 'official_no_refund_input', periodClosure });
  } catch (_) {
    return blocked({ scheme, period, reason: 'payroll_verified_calculation_input_contract_invalid' });
  }
  if (contract.status !== 'verified_no_refund_input' || !contract.calculatorInput || contract.reasons?.length) {
    return blocked({ scheme, period, reason: 'payroll_verified_calculation_inputs_unavailable', reasons: contract.reasons?.length
      ? contract.reasons : ['payroll_verified_calculation_inputs_unavailable'], requiredFacts: contract.requiredFacts || [] });
  }

  let result;
  try { result = calculatePayrollScheme(contract.calculatorInput); }
  catch (_) {
    return blocked({ scheme, period, reason: 'payroll_verified_calculation_engine_error', requiredFacts: contract.requiredFacts || [] });
  }
  if (!result || result.status !== 'ready' || result.blockers?.length || result.criticalErrors?.length
      || !Array.isArray(result.employees) || !Array.isArray(result.daily)) {
    return blocked({ scheme, period, reason: 'payroll_verified_calculation_engine_not_ready', requiredFacts: contract.requiredFacts || [] });
  }
  if (result.schemeVersionId !== scheme.versionId || result.mode !== scheme.mode || result.currency !== scheme.currency
      || result.periodFrom !== period.from || result.periodTo !== period.to) {
    return blocked({ scheme, period, reason: 'payroll_verified_calculation_result_context_mismatch', requiredFacts: contract.requiredFacts || [] });
  }
  let amount = 0n;
  for (const employee of result.employees) {
    if (!Number.isSafeInteger(employee?.amountCents) || employee.amountCents < 0) {
      return blocked({ scheme, period, reason: 'payroll_verified_calculation_amount_invalid', requiredFacts: contract.requiredFacts || [] });
    }
    amount += BigInt(employee.amountCents);
    if (amount > BigInt(Number.MAX_SAFE_INTEGER)) {
      return blocked({ scheme, period, reason: 'payroll_verified_calculation_amount_out_of_range', requiredFacts: contract.requiredFacts || [] });
    }
  }

  const input = detachedFrozen(contract.calculatorInput);
  const calculation = detachedFrozen(result);
  const provenance = detachedFrozen({ capabilityVersion: NO_REFUND_INPUT_CAPABILITY,
    inputWatermark: contract.inputWatermark, closureWatermark: contract.closureWatermark,
    requiredFacts: [...contract.requiredFacts] });
  const calculationWatermark = digest({ schemaVersion: 1, capabilityVersion: NO_REFUND_INPUT_CAPABILITY,
    inputWatermark: contract.inputWatermark, closureWatermark: contract.closureWatermark, result: calculation });
  return detachedFrozen({ schemaVersion: 1, status: 'verified_calculation', officialReady: false, payoutEligible: false,
    persistence: 'none', candidateOnly: false, schemeVersionId: result.schemeVersionId, mode: result.mode,
    currency: result.currency, period: { from: result.periodFrom, to: result.periodTo }, amountCents: Number(amount),
    capabilityVersion: NO_REFUND_INPUT_CAPABILITY, inputWatermark: contract.inputWatermark,
    closureWatermark: contract.closureWatermark, calculationWatermark, requiredFacts: [...contract.requiredFacts],
    reasons: [], input, engineResult: calculation, provenance });
};

module.exports = { buildPayrollVerifiedCalculation };
