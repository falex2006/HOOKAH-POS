'use strict';

// Separate v2 envelope. The legacy v1 provenance builder/hashes stay unchanged.
const { createHash } = require('node:crypto');
const { buildPayrollRefundAwareSnapshot } = require('./payroll-refund-aware-snapshot');
const { buildCalculatorReplay, executeCalculatorReplay } = require('./payroll-calculator-replay');
const { PAYROLL_REFUND_AWARE_CAPABILITY } = require('./payroll-refund-aware-calculation');
const ENGINE_VERSION = 'payroll-verified-remaining-net-v2';
const canonical = value => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || Number.isSafeInteger(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && Object.getPrototypeOf(value) === Object.prototype) return `{${Object.keys(value).sort()
    .filter(key => value[key] !== undefined).map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  throw new TypeError('payroll_refund_provenance_json_invalid');
};
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const freeze = value => { if (value && typeof value === 'object' && !Object.isFrozen(value)) {
  Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const clone = value => structuredClone(value);
const fail = suffix => { const code = `payroll_refund_provenance_${suffix}`; throw Object.assign(new TypeError(code), { code }); };

function buildPayrollRefundAwareRunProvenance(sourceArgs) {
  const prepared = buildPayrollRefundAwareSnapshot(sourceArgs);
  if (prepared.status !== 'refund_aware_snapshot_input') return freeze({ schemaVersion: 2, status: 'blocked',
    officialReady: false, payoutEligible: false, persistence: 'none', reasons: prepared.reasons, prepared: null, provenance: null });
  const verified = prepared.verifiedCalculation;
  const sourceBundle = { schemaVersion: 2, recognitionEvidence: clone(verified.economics.evidence),
    employmentEligibility: clone(sourceArgs.employmentEligibility),
    approvedAttendanceSource: clone(sourceArgs.approvedAttendanceSource || null),
    departmentMapping: clone(sourceArgs.departmentMapping || null), costEvidenceByOrder: clone(sourceArgs.costEvidenceByOrder || null) };
  const evidence = { schemaVersion: 2, capabilityVersion: PAYROLL_REFUND_AWARE_CAPABILITY,
    venueId: sourceArgs.venueId, runId: sourceArgs.runId, schemeVersionId: sourceArgs.scheme.versionId,
    period: clone(sourceArgs.period), currency: sourceArgs.scheme.currency, venueTimezone: sourceArgs.periodClosure.timezone,
    inputWatermark: verified.inputWatermark, closureWatermark: verified.closureWatermark,
    calculationWatermark: verified.calculationWatermark, snapshotInputWatermark: prepared.snapshotInputWatermark,
    schemeSnapshot: clone(verified.input.scheme), periodClosure: clone(sourceArgs.periodClosure),
    sourceEvidence: clone(verified.input.sourceEvidence), sourceBundle, sourceBundleWatermark: hash(sourceBundle),
    refundQuantityEvidence: clone(prepared.refundQuantityEvidence),
    calculatorReplay: buildCalculatorReplay(verified.input, verified.engineResult), totalAmountCents: verified.amountCents };
  const payload = canonical(evidence), sha256 = createHash('sha256').update(payload).digest('hex');
  return freeze({ schemaVersion: 2, status: 'verified_run_evidence', officialReady: false, payoutEligible: false, persistence: 'none',
    reasons: [], engineVersion: ENGINE_VERSION, prepared,
    provenance: { venue_id: sourceArgs.venueId, run_id: sourceArgs.runId, schema_version: 2,
      capability_version: PAYROLL_REFUND_AWARE_CAPABILITY, evidence_payload: payload, evidence_sha256: sha256,
      total_amount_cents: verified.amountCents } });
}

function rebuildPayrollRefundAwareRunProvenance(evidence) {
  if (!evidence || evidence.schemaVersion !== 2 || evidence.capabilityVersion !== PAYROLL_REFUND_AWARE_CAPABILITY
      || evidence.sourceBundle?.schemaVersion !== 2 || hash(evidence.sourceBundle) !== evidence.sourceBundleWatermark
      || evidence.sourceBundle.recognitionEvidence?.encoding !== 'json-preserved-property-order-v1'
      || typeof evidence.sourceBundle.recognitionEvidence.payload !== 'string') fail('context_invalid');
  let recognitionEvidence;
  try { recognitionEvidence = JSON.parse(evidence.sourceBundle.recognitionEvidence.payload); } catch (_) { fail('source_json_invalid'); }
  const replay = executeCalculatorReplay(evidence.calculatorReplay);
  if (!replay.matched) fail('replay_unavailable');
  const rebuilt = buildPayrollRefundAwareRunProvenance({ venueId: evidence.venueId, runId: evidence.runId,
    scheme: evidence.schemeSnapshot, period: evidence.period, periodClosure: evidence.periodClosure, recognitionEvidence,
    employmentEligibility: evidence.sourceBundle.employmentEligibility,
    approvedAttendanceSource: evidence.sourceBundle.approvedAttendanceSource,
    departmentMapping: evidence.sourceBundle.departmentMapping, costEvidenceByOrder: evidence.sourceBundle.costEvidenceByOrder });
  if (rebuilt.status !== 'verified_run_evidence' || rebuilt.provenance.evidence_payload !== canonical(evidence)) fail('rebuild_mismatch');
  return rebuilt;
}

module.exports = { buildPayrollRefundAwareRunProvenance, rebuildPayrollRefundAwareRunProvenance, ENGINE_VERSION };
