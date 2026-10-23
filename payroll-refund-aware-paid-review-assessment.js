'use strict';

// Pure whole-period paid correction assessment for immutable v2 runs. It has
// no database authority, correction ledger writes, expense creation or payout
// eligibility. A future service must supply independently verified DB proofs.
const { createHash } = require('node:crypto');
const { rebuildPayrollRefundAwareRunProvenance, buildPayrollRefundAwareRunProvenance } = require('./payroll-refund-aware-provenance');
const { PAYROLL_REFUND_AWARE_CAPABILITY } = require('./payroll-refund-aware-calculation');

const POLICY = 'payroll_refund_aware_paid_review_v1';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA = /^[a-f0-9]{64}$/i;
const HASH_KEYS = Object.freeze(['provenanceSha256', 'inputWatermark', 'closureWatermark', 'calculationWatermark',
  'snapshotInputWatermark', 'sourceEvidenceSha256', 'calculatorInputSha256', 'calculatorResultSha256', 'engineRevision']);
const NON_REFUND_FACTS = Object.freeze(['saleEvents', 'saleLines', 'orders', 'pricingHeaders', 'pricingLines', 'orderItems', 'candidateOrders']);
const REFUND_FACTS = Object.freeze(['refundEvents', 'refundLines', 'refundHeaders', 'relatedRefundHeaders', 'relatedRefundItems',
  'refundItems', 'refundTenders', 'candidateRefunds']);
const fail = code => { throw Object.assign(new TypeError(`payroll_refund_paid_review_${code}`), { code: `payroll_refund_paid_review_${code}` }); };
const plain = value => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value instanceof Date ? JSON.stringify(Date.prototype.toISOString.call(value))
    : plain(value) ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex');
const freeze = value => { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const safe = value => { if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) fail('amount_overflow'); return Number(value); };
const money = value => { if (!Number.isSafeInteger(value) || value < 0 || value > 999999999999) fail('amount_invalid'); return BigInt(value); };
const exactObject = (value, keys) => plain(value) && Reflect.ownKeys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key)) && Reflect.ownKeys(value).every(key => typeof key === 'string')
  && Object.values(Object.getOwnPropertyDescriptors(value)).every(descriptor => Object.hasOwn(descriptor, 'value'));
const uuid = value => { if (typeof value !== 'string' || !UUID.test(value)) fail('identity_invalid'); return value.toLowerCase(); };
const inspectJson = input => {
  const active = new WeakSet(); let nodes = 0;
  const visit = (value, depth, path) => {
    if (++nodes > 2500000 || depth > 64) fail('structure_limit');
    if (value === null || typeof value === 'boolean') return;
    if (typeof value === 'string') {
      const sourcePayload = path === '$.savedEvidence.sourceBundle.recognitionEvidence.payload';
      if (value.length > (sourcePayload ? 40 * 1024 * 1024 : 1048576)) fail('structure_limit');
      return;
    }
    if (typeof value === 'number') { if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER || Object.is(value, -0)) fail('json_invalid'); return; }
    if (value instanceof Date) {
      if (Reflect.ownKeys(value).length || !Number.isFinite(Date.prototype.getTime.call(value))) fail('json_invalid');
      return;
    }
    if ((!plain(value) && !Array.isArray(value)) || active.has(value)) fail('json_invalid');
    active.add(value);
    const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(value);
    if (keys.some(key => typeof key !== 'string') || Object.values(descriptors).some(descriptor => !Object.hasOwn(descriptor, 'value'))) fail('json_invalid');
    if (Array.isArray(value) && (keys.length !== value.length + 1 || keys.some(key => key !== 'length' && !/^(0|[1-9][0-9]*)$/.test(key)))) fail('json_invalid');
    for (const key of keys) if (key !== 'length' || !Array.isArray(value)) visit(descriptors[key].value, depth + 1,
      Array.isArray(value) ? `${path}[${key}]` : `${path}.${key}`);
    active.delete(value);
  };
  visit(input, 0, '$');
  if (Buffer.byteLength(canonical(input), 'utf8') > 40 * 1024 * 1024) fail('structure_limit');
};
const daysFor = period => {
  const result = [];
  for (let ms = Date.parse(`${period.from}T00:00:00Z`), end = Date.parse(`${period.to}T00:00:00Z`); ms <= end; ms += 86400000) {
    result.push(new Date(ms).toISOString().slice(0, 10));
  }
  return result;
};
const amountFields = Object.freeze(['basePayCents', 'commissionCents', 'teamFundCents', 'milestoneBonusCents', 'capReductionCents', 'amountCents']);
const components = row => {
  const result = Object.fromEntries(amountFields.map(field => [field, row ? money(row[field]) : 0n]));
  if (result.basePayCents + result.commissionCents + result.teamFundCents + result.milestoneBonusCents
      - result.capReductionCents !== result.amountCents) fail('engine_component_mismatch');
  result.variableBeforeCapCents = result.commissionCents + result.teamFundCents + result.milestoneBonusCents;
  return result;
};
const safeComponents = row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, safe(value)]));
const employeeRows = result => {
  if (!Array.isArray(result?.employees)) fail('engine_employee_coverage_invalid');
  const map = new Map();
  for (const row of result.employees) {
    const id = uuid(row?.employeeId);
    if (map.has(id)) fail('engine_employee_coverage_invalid');
    map.set(id, row);
  }
  return map;
};
const rawRecognitionEvidence = evidence => {
  const wrapped = evidence?.sourceBundle?.recognitionEvidence;
  if (!exactObject(wrapped, ['encoding', 'payload']) || wrapped.encoding !== 'json-preserved-property-order-v1'
      || typeof wrapped.payload !== 'string') fail('saved_recognition_evidence_invalid');
  let raw;
  try { raw = JSON.parse(wrapped.payload); } catch (_) { fail('saved_recognition_evidence_invalid'); }
  return raw;
};
const sameArray = (left, right) => Array.isArray(left) && Array.isArray(right)
  && canonical(left.map(row => canonical(row)).sort()) === canonical(right.map(row => canonical(row)).sort());
const appendOnlyArray = (before, after) => {
  if (!Array.isArray(before) || !Array.isArray(after)) return false;
  const counts = new Map();
  for (const row of after) { const key = canonical(row); counts.set(key, (counts.get(key) || 0) + 1); }
  for (const row of before) {
    const key = canonical(row), count = counts.get(key) || 0;
    if (!count) return false;
    counts.set(key, count - 1);
  }
  return true;
};
const validateRecognitionAppendOnly = (original, current) => {
  if (!exactObject(original, ['manifest', 'facts']) || !exactObject(current, ['manifest', 'facts'])
      || !plain(original.facts) || !plain(current.facts) || canonical(original.facts.epoch) !== canonical(current.facts.epoch)) {
    fail('recognition_context_changed');
  }
  for (const name of NON_REFUND_FACTS) if (!sameArray(original.facts[name], current.facts[name])) fail('original_sale_facts_changed');
  for (const name of REFUND_FACTS) if (!appendOnlyArray(original.facts[name], current.facts[name])) fail('refund_history_rewritten');
};
const validatePaidEntries = (rows, savedEvidence, provenanceSha256, baseline, replay) => {
  if (!Array.isArray(rows) || rows.length > 500) fail('paid_entry_proof_invalid');
  const originals = employeeRows(baseline), paid = new Map(), ids = new Set();
  const byDay = new Map();
  for (const day of baseline.daily || []) for (const employee of day.employees || []) {
    const employeeId = uuid(employee.employeeId);
    byDay.set(employeeId, (byDay.get(employeeId) || 0n) + (components(employee).basePayCents < components(employee).amountCents
      ? components(employee).basePayCents : components(employee).amountCents));
  }
  for (const row of rows) {
    const keys = ['entryId', 'employeeId', 'runId', 'grossCents', 'netCents', 'protectedFixedCents', 'incomingSettledCents', 'evidenceHashes'];
    if (!exactObject(row, keys) || !exactObject(row.evidenceHashes, HASH_KEYS)) fail('paid_entry_proof_invalid');
    const entryId = uuid(row.entryId), employeeId = uuid(row.employeeId), runId = uuid(row.runId);
    if (ids.has(entryId) || paid.has(employeeId) || runId !== savedEvidence.runId) fail('paid_entry_duplicate_or_wrong_run');
    ids.add(entryId);
    const original = originals.get(employeeId);
    if (!original) fail('paid_entry_employee_mismatch');
    const gross = money(row.grossCents), net = money(row.netCents), fixed = money(row.protectedFixedCents), incoming = money(row.incomingSettledCents);
    if (gross !== BigInt(original.amountCents) || fixed > gross || incoming > gross || net !== gross - incoming || net < fixed
        || fixed !== (byDay.get(employeeId) || 0n)) fail('paid_entry_amount_binding_mismatch');
    const hashes = row.evidenceHashes, evidence = savedEvidence;
    for (const key of HASH_KEYS.slice(0, -1)) if (!SHA.test(hashes[key] || '')) fail('paid_entry_evidence_hash_invalid');
    if (typeof hashes.engineRevision !== 'string' || !hashes.engineRevision.trim()
        || hashes.provenanceSha256.toLowerCase() !== provenanceSha256.toLowerCase()
        || hashes.inputWatermark !== evidence.inputWatermark || hashes.closureWatermark !== evidence.closureWatermark
        || hashes.calculationWatermark !== evidence.calculationWatermark || hashes.snapshotInputWatermark !== evidence.snapshotInputWatermark
        || hashes.sourceEvidenceSha256 !== hash(evidence.sourceEvidence)
        || hashes.calculatorInputSha256 !== evidence.calculatorReplay.inputSha256
        || hashes.calculatorResultSha256 !== replay.resultSha256 || hashes.engineRevision !== replay.engineRevision) {
      fail('paid_entry_evidence_hash_mismatch');
    }
    paid.set(employeeId, { entryId, employeeId, runId, grossCents: safe(gross), netCents: safe(net),
      originalProtectedFixedCents: safe(fixed), incomingSettledCents: safe(incoming),
      paidProofWatermark: hash(row) });
  }
  return paid;
};
const outputComponents = (baseline, current, employeeId) => {
  const left = components(baseline.get(employeeId)), right = components(current.get(employeeId));
  if (left.basePayCents !== right.basePayCents) fail('frozen_fixed_pay_changed');
  const delta = Object.fromEntries(Object.keys(left).map(key => [key, safe(right[key] - left[key])]));
  return { baseline: safeComponents(left), current: safeComponents(right), delta };
};

function buildPayrollRefundAwarePaidReviewAssessment(input) {
  inspectJson(input);
  const keys = ['savedEvidence', 'provenanceSha256', 'currentRecognitionEvidence', 'periodClosure', 'paidEntries'];
  if (!exactObject(input, keys) || !plain(input.savedEvidence) || !SHA.test(input.provenanceSha256 || '')
      || !plain(input.periodClosure) || !Array.isArray(input.paidEntries)) fail('input_invalid');
  const { savedEvidence, provenanceSha256, currentRecognitionEvidence, periodClosure, paidEntries } = input;
  if (savedEvidence.schemaVersion !== 2 || savedEvidence.capabilityVersion !== PAYROLL_REFUND_AWARE_CAPABILITY
      || hash(savedEvidence) !== provenanceSha256.toLowerCase()) fail('saved_provenance_hash_mismatch');
  let originalBuilt;
  try { originalBuilt = rebuildPayrollRefundAwareRunProvenance(savedEvidence); }
  catch (_) { fail('saved_provenance_rebuild_failed'); }
  if (originalBuilt.status !== 'verified_run_evidence' || originalBuilt.prepared.status !== 'refund_aware_snapshot_input') fail('saved_provenance_rebuild_failed');
  const originalRaw = rawRecognitionEvidence(savedEvidence);
  validateRecognitionAppendOnly(originalRaw, currentRecognitionEvidence);
  const frozen = savedEvidence.sourceBundle;
  const candidateArgs = { venueId: savedEvidence.venueId, runId: savedEvidence.runId,
    scheme: structuredClone(savedEvidence.schemeSnapshot), period: structuredClone(savedEvidence.period),
    periodClosure: structuredClone(periodClosure), recognitionEvidence: structuredClone(currentRecognitionEvidence),
    employmentEligibility: structuredClone(frozen.employmentEligibility),
    approvedAttendanceSource: structuredClone(frozen.approvedAttendanceSource),
    departmentMapping: structuredClone(frozen.departmentMapping), costEvidenceByOrder: structuredClone(frozen.costEvidenceByOrder) };
  let currentBuilt;
  try { currentBuilt = buildPayrollRefundAwareRunProvenance(candidateArgs); }
  catch (_) { fail('current_source_rebuild_failed'); }
  if (currentBuilt.status !== 'verified_run_evidence' || currentBuilt.prepared.status !== 'refund_aware_snapshot_input') fail('current_source_rebuild_failed');
  const baselineCalculation = originalBuilt.prepared.verifiedCalculation;
  const currentCalculation = currentBuilt.prepared.verifiedCalculation;
  const baseline = baselineCalculation.engineResult, current = currentCalculation.engineResult;
  const baselineMap = employeeRows(baseline), currentMap = employeeRows(current);
  const employeeIds = [...baselineMap.keys()].sort();
  if (canonical(employeeIds) !== canonical([...currentMap.keys()].sort())) fail('employee_cohort_changed');
  const replay = require('./payroll-calculator-replay').executeCalculatorReplay(savedEvidence.calculatorReplay);
  const paid = validatePaidEntries(paidEntries, savedEvidence, provenanceSha256, baseline, replay);
  const employeeDeltas = employeeIds.map(employeeId => ({ employeeId, ...outputComponents(baselineMap, currentMap, employeeId),
    settlement: paid.has(employeeId) ? 'paid_entry_proof_supplied' : 'no_paid_entry_in_review' }));
  const dates = daysFor(savedEvidence.period), baselineDays = new Map((baseline.daily || []).map(row => [row.date, row])),
    currentDays = new Map((current.daily || []).map(row => [row.date, row]));
  if (baselineDays.size !== dates.length || currentDays.size !== dates.length) fail('daily_period_coverage_invalid');
  const dailyDeltas = [];
  for (const date of dates) {
    const oldDay = baselineDays.get(date), newDay = currentDays.get(date);
    if (!oldDay || !newDay) fail('daily_period_coverage_invalid');
    const oldEmployees = employeeRows({ employees: oldDay.employees || [] }), newEmployees = employeeRows({ employees: newDay.employees || [] });
    for (const employeeId of employeeIds) dailyDeltas.push({ date, employeeId,
      ...outputComponents(oldEmployees, newEmployees, employeeId) });
  }
  const totals = {};
  for (const part of ['baseline', 'current', 'delta']) {
    totals[part] = {};
    for (const field of [...amountFields, 'variableBeforeCapCents']) {
      const employeeTotal = employeeDeltas.reduce((sum, row) => sum + BigInt(row[part][field]), 0n);
      const dailyTotal = dailyDeltas.reduce((sum, row) => sum + BigInt(row[part][field]), 0n);
      if (employeeTotal !== dailyTotal) fail('daily_total_mismatch');
      totals[part][field] = safe(employeeTotal);
    }
  }
  const paidReviews = [...paid.values()].sort((a, b) => a.employeeId.localeCompare(b.employeeId)).map(row => {
    const candidateGrossCents = currentMap.get(row.employeeId).amountCents;
    const originalNet = BigInt(row.grossCents) - BigInt(row.incomingSettledCents);
    const candidateAfterIncoming = BigInt(candidateGrossCents) - BigInt(row.incomingSettledCents);
    const retainedFloor = BigInt(row.originalProtectedFixedCents) > candidateAfterIncoming
      ? BigInt(row.originalProtectedFixedCents) : candidateAfterIncoming;
    const claimBasis = originalNet > retainedFloor ? originalNet - retainedFloor : 0n;
    const positiveEntitlement = candidateAfterIncoming > originalNet ? candidateAfterIncoming - originalNet : 0n;
    return { ...row, candidateGrossCents, originalNetAfterIncomingCents: safe(originalNet),
      candidateAfterIncomingCents: safe(candidateAfterIncoming), protectedFloorCents: row.originalProtectedFixedCents,
      potentialReductionReviewCents: safe(claimBasis), positiveEntitlementInformationCents: safe(positiveEntitlement),
      signedCounterfactualDeltaCents: safe(BigInt(candidateGrossCents) - BigInt(row.grossCents)),
      incomingSettledTreatment: 'deducted_once_from_baseline_and_candidate',
      fixedPayTreatment: 'original_paid_protected_fixed_amount_is_floor',
      settlementEffect: 'assessment_only_no_claim_or_payment' };
  });
  const summary = { paidEntryCount: paidReviews.length,
    potentialReductionReviewCents: safe(paidReviews.reduce((sum, row) => sum + BigInt(row.potentialReductionReviewCents), 0n)),
    positiveEntitlementInformationCents: safe(paidReviews.reduce((sum, row) => sum + BigInt(row.positiveEntitlementInformationCents), 0n)),
    unpaidOrUnprovedEmployeeCount: employeeIds.length - paidReviews.length,
    crossEmployeeOffsetApplied: false, negativeClaimsCreated: false };
  const originalSaleIdentities = (savedEvidence.refundQuantityEvidence?.lines || []).map(row => ({
    saleLineEventId: row.saleLineEventId, orderId: row.orderId, orderItemId: row.orderItemId,
    originalSaleEventId: row.originalSaleEventId, sellerId: row.sellerId, recognizedAt: row.recognizedAt,
    recognizedLocalDate: row.recognizedLocalDate, timezoneSnapshot: row.timezoneSnapshot,
    originalQuantity: row.originalQuantity, originalGrossMinor: row.originalGrossMinor, originalDiscountMinor: row.originalDiscountMinor
  })).sort((a, b) => String(a.saleLineEventId).localeCompare(String(b.saleLineEventId)));
  const currentRefundIdentities = (currentCalculation.economics?.projection?.recognitionHistory?.refundLines || [])
    .map(row => ({ refundLineEventId: row.refundLineEventId || row.eventId || row.id,
      refundEventId: row.refundEventId, originalSaleLineEventId: row.originalSaleLineEventId,
      orderId: row.orderId, orderItemId: row.orderItemId }))
    .sort((a, b) => String(a.refundLineEventId).localeCompare(String(b.refundLineEventId)));
  const sourceCohortSha256 = hash({ schemaVersion: 1, runId: savedEvidence.runId,
    originalProvenanceSha256: provenanceSha256.toLowerCase(), originalInputWatermark: savedEvidence.inputWatermark,
    currentInputWatermark: currentCalculation.inputWatermark, employeeIds, originalSaleIdentities, currentRefundIdentities });
  const counterfactualModelWatermark = hash({ schemaVersion: 1, policyCode: POLICY,
    currentInputWatermark: currentCalculation.inputWatermark, engineRevision: replay.engineRevision,
    calculatorResultSha256: hash(currentCalculation.engineResult) });
  const payload = { schemaVersion: 1, policyCode: POLICY, status: 'paid_review_assessed',
    officialReady: false, payoutEligible: false, sourceAttested: false, persistence: 'none',
    deltaApplicationEligible: false, financialAction: 'none', positiveEntitlementAction: 'none',
    venueId: savedEvidence.venueId, runId: savedEvidence.runId, currency: savedEvidence.currency,
    period: structuredClone(savedEvidence.period), schemeVersionId: savedEvidence.schemeVersionId,
    originalProvenanceSha256: provenanceSha256.toLowerCase(), originalInputWatermark: savedEvidence.inputWatermark,
    currentInputWatermark: currentCalculation.inputWatermark, counterfactualModelWatermark,
    sourceCohortSha256, refundHistoryPolicy: 'exact_original_sales_and_append_only_refund_facts',
    mode: savedEvidence.schemeSnapshot.mode, baselineAmountCents: baselineCalculation.amountCents,
    counterfactualAmountCents: currentCalculation.amountCents, employeeDeltas, dailyDeltas, totals, paidReviews, summary,
    deltaSemantics: 'signed_current_minus_saved_whole_period; caps and loss floors remain separate engine components',
    protectedFixedSemantics: 'original paid fixed component is preserved per employee; no cross employee offsets',
    capAndLossFloorSemantics: 'cap reduction remains a separate signed engine component; daily loss offset stays inside unchanged engine replay',
    sourceFactChangeSemantics: 'only append-only refund recognition facts may differ from the saved provenance' };
  return freeze({ ...payload, assessmentWatermark: hash(payload) });
}

module.exports = { buildPayrollRefundAwarePaidReviewAssessment, PAYROLL_REFUND_AWARE_PAID_REVIEW_POLICY: POLICY };
