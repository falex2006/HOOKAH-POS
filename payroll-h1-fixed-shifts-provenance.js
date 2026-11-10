'use strict';

// H1 is a separate run capability over the same frozen V2 source families.
// It never changes or relabels a normal V2 run.
const { createHash } = require('node:crypto');
const { buildPayrollRefundAwareSnapshot } = require('./payroll-refund-aware-snapshot');
const { buildPayrollH1FixedShiftsReplay, executePayrollH1FixedShiftsReplay } = require('./payroll-calculator-replay');

const ENGINE_VERSION = 'h1_fixed_shifts_v1';
const CAPABILITY_VERSION = 'employee_attributed_h1_fixed_shifts_v1';
const canonical = value => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || Number.isSafeInteger(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && Object.getPrototypeOf(value) === Object.prototype) return `{${Object.keys(value).sort()
    .filter(key => value[key] !== undefined).map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  throw new TypeError('payroll_h1_provenance_json_invalid');
};
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const freeze = value => { if (value && typeof value === 'object' && !Object.isFrozen(value)) {
  Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const clone = value => structuredClone(value);
const fail = suffix => { const code = `payroll_h1_provenance_${suffix}`; throw Object.assign(new TypeError(code), { code }); };

function buildPayrollH1FixedShiftsRunProvenance(sourceArgs) {
  const prepared = buildPayrollRefundAwareSnapshot({ ...sourceArgs, h1FixedShifts: true });
  if (prepared.status !== 'h1_fixed_shifts_snapshot_input') return freeze({ schemaVersion: 4, status: 'blocked',
    officialReady: false, payoutEligible: false, persistence: 'none', reasons: prepared.reasons, prepared: null, provenance: null });
  const verified = prepared.verifiedCalculation;
  const sourceBundle = { schemaVersion: 2, recognitionEvidence: clone(verified.economics.evidence),
    employmentEligibility: clone(sourceArgs.employmentEligibility),
    approvedAttendanceSource: clone(sourceArgs.approvedAttendanceSource || null),
    departmentMapping: clone(sourceArgs.departmentMapping || null), costEvidenceByOrder: clone(sourceArgs.costEvidenceByOrder || null) };
  const calculatorReplay = buildPayrollH1FixedShiftsReplay(verified.input, verified.engineResult);
  const evidence = { schemaVersion: 4, capabilityVersion: CAPABILITY_VERSION,
    venueId: sourceArgs.venueId, runId: sourceArgs.runId, schemeVersionId: sourceArgs.scheme.versionId,
    period: clone(sourceArgs.period), currency: sourceArgs.scheme.currency, venueTimezone: sourceArgs.periodClosure.timezone,
    inputWatermark: verified.inputWatermark, closureWatermark: verified.closureWatermark,
    calculationWatermark: verified.calculationWatermark, snapshotInputWatermark: prepared.snapshotInputWatermark,
    schemeSnapshot: clone(verified.input.scheme), periodClosure: clone(sourceArgs.periodClosure),
    sourceEvidence: clone(verified.input.sourceEvidence), sourceBundle, sourceBundleWatermark: hash(sourceBundle),
    refundQuantityEvidence: clone(prepared.refundQuantityEvidence), calculatorReplay, totalAmountCents: verified.amountCents };
  const payload = canonical(evidence), sha256 = createHash('sha256').update(payload).digest('hex');
  return freeze({ schemaVersion: 4, status: 'verified_h1_fixed_shifts_evidence', officialReady: false,
    payoutEligible: false, persistence: 'none', reasons: [], engineVersion: ENGINE_VERSION, prepared,
    provenance: { venue_id: sourceArgs.venueId, run_id: sourceArgs.runId, schema_version: 4,
      capability_version: CAPABILITY_VERSION, evidence_payload: payload, evidence_sha256: sha256,
      total_amount_cents: verified.amountCents } });
}

function rebuildPayrollH1FixedShiftsRunProvenance(evidence) {
  if (!evidence || evidence.schemaVersion !== 4 || evidence.capabilityVersion !== CAPABILITY_VERSION
      || evidence.sourceBundle?.schemaVersion !== 2 || hash(evidence.sourceBundle) !== evidence.sourceBundleWatermark
      || evidence.sourceBundle.recognitionEvidence?.encoding !== 'json-preserved-property-order-v1'
      || typeof evidence.sourceBundle.recognitionEvidence.payload !== 'string') fail('context_invalid');
  let recognitionEvidence;
  try { recognitionEvidence = JSON.parse(evidence.sourceBundle.recognitionEvidence.payload); } catch (_) { fail('source_json_invalid'); }
  const replay = executePayrollH1FixedShiftsReplay(evidence.calculatorReplay);
  if (!replay.matched || !replay.replayVerified) fail('replay_unavailable');
  const rebuilt = buildPayrollH1FixedShiftsRunProvenance({ venueId: evidence.venueId, runId: evidence.runId,
    scheme: evidence.schemeSnapshot, period: evidence.period, periodClosure: evidence.periodClosure, recognitionEvidence,
    employmentEligibility: evidence.sourceBundle.employmentEligibility,
    approvedAttendanceSource: evidence.sourceBundle.approvedAttendanceSource,
    departmentMapping: evidence.sourceBundle.departmentMapping, costEvidenceByOrder: evidence.sourceBundle.costEvidenceByOrder });
  if (rebuilt.status !== 'verified_h1_fixed_shifts_evidence'
      || rebuilt.provenance.evidence_payload !== canonical(evidence)) fail('rebuild_mismatch');
  return rebuilt;
}

module.exports = { buildPayrollH1FixedShiftsRunProvenance, rebuildPayrollH1FixedShiftsRunProvenance,
  ENGINE_VERSION, CAPABILITY_VERSION };
