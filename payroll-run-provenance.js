'use strict';

// Internal evidence builder. Its caller must collect sourceArgs in the owner's
// fenced transaction. No browser-provided result or provenance is accepted.
const { createHash } = require('node:crypto');
const { buildPayrollVerifiedSnapshotInput } = require('./payroll-verified-snapshot-input');
const { buildCalculatorReplay } = require('./payroll-calculator-replay');
const ENGINE_VERSION = 'payroll-verified-no-refund-v1';
const canonical = value => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && Object.getPrototypeOf(value) === Object.prototype) return `{${Object.keys(value).sort()
    .filter(key => value[key] !== undefined).map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  throw new TypeError('payroll_provenance_json_value_invalid');
};
const fingerprint = value => createHash('sha256').update(canonical(value)).digest('hex');
const freeze = value => {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(freeze);
  return Object.freeze(value);
};
const buildPayrollRunProvenance = sourceArgs => {
  const prepared = buildPayrollVerifiedSnapshotInput(sourceArgs);
  if (prepared.status !== 'verified_snapshot_input') return freeze({
    schemaVersion: 1, status: 'blocked', officialReady: false, payoutEligible: false, persistence: 'none',
    reasons: [...prepared.reasons], prepared: null, provenance: null
  });
  const verified = prepared.verifiedCalculation;
  const snapshot = prepared.snapshotInput;
  const closure = structuredClone(sourceArgs.periodClosure);
  if (fingerprint({ periodClosure: closure, inputWatermark: verified.inputWatermark }) !== verified.closureWatermark) {
    throw new TypeError('payroll_provenance_closure_binding_mismatch');
  }
  const evidence = {
    schemaVersion: 1, capabilityVersion: verified.capabilityVersion,
    venueId: snapshot.venueId, runId: snapshot.runId,
    schemeVersionId: verified.schemeVersionId, period: { ...verified.period },
    currency: verified.currency, venueTimezone: snapshot.venueTimezone,
    inputWatermark: verified.inputWatermark, closureWatermark: verified.closureWatermark,
    calculationWatermark: verified.calculationWatermark, snapshotInputWatermark: prepared.snapshotInputWatermark,
    schemeSnapshot: structuredClone(verified.input.scheme), periodClosure: closure,
    sourceEvidence: structuredClone(verified.input.sourceEvidence),
    calculatorReplay: buildCalculatorReplay(verified.input, verified.engineResult),
    totalAmountCents: verified.amountCents
  };
  const payload = canonical(evidence);
  const evidenceSha256 = createHash('sha256').update(payload).digest('hex');
  return freeze({
    schemaVersion: 1, status: 'verified_run_evidence', officialReady: false, payoutEligible: false, persistence: 'none',
    reasons: [], engineVersion: ENGINE_VERSION, prepared,
    provenance: { venue_id: snapshot.venueId, run_id: snapshot.runId, schema_version: 1,
      capability_version: verified.capabilityVersion, evidence_payload: payload, evidence_sha256: evidenceSha256,
      total_amount_cents: verified.amountCents }
  });
};

module.exports = { buildPayrollRunProvenance, ENGINE_VERSION };
