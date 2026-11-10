'use strict';

const { createHash } = require('node:crypto');
const { rebuildPayrollRefundAwareRunProvenance } = require('./payroll-refund-aware-provenance');
const { buildPayrollDeferredMonthSettlement } = require('./payroll-half-month-calculation');

const CAPABILITY = 'payroll-deferred-month-settlement-v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const fail = code => { throw Object.assign(new Error('payroll_h2_evidence_' + code), {code:'payroll_h2_evidence_' + code}); };
const hash = s => createHash('sha256').update(s, 'utf8').digest('hex');
const canonical = value => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
  : value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}'
  : JSON.stringify(value);
const freeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};

function rebuildDeferred(monthly, h1State, employeeId) {
  const rebuilt = rebuildPayrollRefundAwareRunProvenance(monthly);
  const bundle = monthly.sourceBundle;
  const source = {venueId:monthly.venueId, period:monthly.period, scheme:monthly.schemeSnapshot,
    periodClosure:monthly.periodClosure, recognitionEvidence:JSON.parse(bundle.recognitionEvidence.payload),
    employmentEligibility:bundle.employmentEligibility, approvedAttendanceSource:bundle.approvedAttendanceSource,
    departmentMapping:bundle.departmentMapping, costEvidenceByOrder:bundle.costEvidenceByOrder};
  const result = buildPayrollDeferredMonthSettlement(source, [h1State], employeeId);
  if (!result.economicEvidenceSha256 || result.employees.length !== 1) fail('reconciliation_invalid');
  return {result, monthlyHash:rebuilt.provenance.evidence_sha256};
}

function documentFor(monthly, state, context, calculation) {
  const {venueId, employeeId, month, monthlyRunId, h2RunId} = context;
  if (![venueId,employeeId,monthlyRunId,h2RunId].every(id => typeof id === 'string' && UUID.test(id))
      || h2RunId === monthlyRunId || monthly.runId !== monthlyRunId || monthly.venueId !== venueId
      || monthly.period.from !== month + '-01' || state.month !== month || state.employeeId !== employeeId
      || state.venueId !== venueId || state.usableForH2 !== true) fail('binding_invalid');
  const {result, monthlyHash} = calculation;
  const row = result.reconciliation.items[0];
  const days = result.employees[0].earnedDays;
  if (state.zeroBase === true) {
    const firstHalf = days.filter(day => day.date < row.period.from);
    const expected = {schemaVersion:1,venueId,employeeId,month,period:{from:month+'-01',to:month+'-14'},
      monthlyRunId,monthlySourceSha256:hash(canonical(monthly)),snapshotRowCount:firstHalf.length,
      grossMinor:0,activeOverlapCount:0};
    if (firstHalf.some(day => day.grossMinor !== 0) || canonical(state.zeroBaseEvidence) !== canonical(expected)
        || state.zeroBaseEvidenceSha256 !== hash(canonical(expected))) fail('zero_base_unproven');
  }
  const floor = rows => rows.reduce((sum,day) => sum + Math.min(day.fixedMinor,day.grossMinor),0);
  const monthlyProtectedFixedMinor = floor(days);
  const h2ProtectedFixedMinor = floor(days.filter(day => day.date >= row.period.from));
  const h1ProtectedFixedMinor = state.zeroBase === true ? 0 : state.protectedFixedMinor;
  if (!Number.isSafeInteger(h1ProtectedFixedMinor) || h1ProtectedFixedMinor < 0 || h1ProtectedFixedMinor > state.netDueMinor
      || h1ProtectedFixedMinor !== monthlyProtectedFixedMinor - h2ProtectedFixedMinor) fail('h1_fixed_basis_changed');
  if (h2ProtectedFixedMinor > row.h2GrossAccruedMinor) fail('h2_fixed_exceeds_residual');
  const document = {schemaVersion:5,capabilityVersion:CAPABILITY,venueId,employeeId,month,monthlyRunId,h2RunId,
    periodFrom:row.period.from,periodTo:row.period.to,currency:monthly.currency,monthlyEvidenceSha256:monthlyHash,
    economicEvidenceSha256:result.economicEvidenceSha256,settlementEvidenceSha256:result.evidenceSha256,
    monthlyGrossMinor:row.monthlyGrossMinor,h1GrossAccruedMinor:row.h1GrossAccruedMinor,h2GrossAccruedMinor:row.h2GrossAccruedMinor,
    requiresDeferred:result.requiresDeferred,monthlyProtectedFixedMinor,h1ProtectedFixedMinor,h2ProtectedFixedMinor,
    h2EligibleVariableMinor:row.h2GrossAccruedMinor-h2ProtectedFixedMinor,earnedDays:days,h1Binding:result.economicClaims[0],
    h1Observation:{status:state.status,paidMinor:state.paidMinor},reconciliation:row};
  const payload = canonical(document);
  return freeze({...document, payload, evidenceSha256:hash(payload)});
}

// Called with verified H1 state inside the same owner/source-fenced transaction
// that binds the monthly run and the new employee settlement.
function buildPayrollDeferredMonthEvidence(monthly, candidate, context) {
  const calculation = rebuildDeferred(monthly, context.h1State, context.employeeId);
  if (canonical(calculation.result) !== canonical(candidate)) fail('candidate_mismatch');
  return documentFor(monthly,context.h1State,context,calculation);
}

function verifyPayrollDeferredMonthEvidence(payload, monthly, liveH1State) {
  try {
    if (typeof payload !== 'string' || !monthly) fail('monthly_source_required');
    const doc = JSON.parse(payload);
    if (doc.schemaVersion !== 5 || doc.capabilityVersion !== CAPABILITY) fail('capability_invalid');
    const binding = doc.h1Binding, observed = doc.h1Observation;
    const zero = binding.h1Origin === 'verified_zero_base';
    const original = {venueId:doc.venueId,employeeId:doc.employeeId,month:doc.month,currency:doc.currency,
      period:{from:doc.month+'-01',to:doc.month+'-14'},status:observed.status,paidMinor:observed.paidMinor,
      grossAccruedMinor:binding.h1GrossAccruedMinor,protectedFixedMinor:doc.h1ProtectedFixedMinor,netDueMinor:binding.h1NetDueMinor,
      appliedCorrectionMinor:binding.h1AppliedCorrectionMinor,usableForH2:true,
      claimId:binding.h1ClaimId,entryId:binding.h1EntryId,runId:binding.h1RunId,
      ...(zero ? {zeroBase:true,zeroBaseEvidence:doc.reconciliation.h1ZeroBaseEvidence,
        zeroBaseEvidenceSha256:binding.approvalLedgerSha256} : {ledgerHash:binding.approvalLedgerSha256})};
    const calculation = rebuildDeferred(monthly, original, doc.employeeId);
    const saved = documentFor(monthly,original,doc,calculation);
    if (saved.payload !== payload) fail('replay_mismatch');
    if (liveH1State !== undefined) {
      const current = rebuildDeferred(monthly,liveH1State,doc.employeeId);
      if ((liveH1State.zeroBase === true ? 0 : liveH1State.protectedFixedMinor) !== saved.h1ProtectedFixedMinor
          || current.result.economicEvidenceSha256 !== saved.economicEvidenceSha256
          || (observed.status === 'paid' && liveH1State.status !== 'paid')) fail('h1_binding_changed');
    }
    return {valid:true, reasons:[], evidenceSha256:saved.evidenceSha256, liveH1Verified:liveH1State !== undefined};
  } catch (error) {
    return {valid:false,reasons:[error.code || 'payroll_h2_evidence_invalid'],liveH1Verified:false};
  }
}

module.exports = {buildPayrollDeferredMonthEvidence, verifyPayrollDeferredMonthEvidence};
