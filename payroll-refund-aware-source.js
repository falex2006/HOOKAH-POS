'use strict';

// Internal collection only. The same fenced client owns every source read.
const { createHash } = require('node:crypto');
const { hasPayrollVerifiedSourceSnapshot } = require('./payroll-source-fence');
const { readPayrollRecognitionEvidenceInTransaction } = require('./payroll-recognition-manifest');
const { buildPayrollRefundEconomicSource } = require('./payroll-refund-economic-source');
const { loadLatestEligibilitySourceInTransaction } = require('./payroll-employment-eligibility');
const { loadLatestProductDepartmentMappingInTransaction } = require('./payroll-product-department-source');
const { buildPayrollRefundFrozenCostSource, readPayrollRefundFrozenCostSourceInTransaction } = require('./payroll-refund-frozen-cost-source');
const { readSaleCostEvidence } = require('./pos-sale-cost-evidence');
const { buildPayrollRefundAwareCalculation } = require('./payroll-refund-aware-calculation');
const { buildPayrollModeAvailability } = require('./payroll-mode-availability');
const { normalizePayrollSourcePolicies } = require('./payroll-source-policies');
const { buildPayrollRefundAwareSourcedComparison } = require('./payroll-refund-aware-sourced-comparison');
const fail = suffix => { const code = `payroll_refund_aware_${suffix}`; throw Object.assign(new Error(code), { code, status: 409 }); };
const blocked = reasons => ({ schemaVersion: 2, status: 'blocked', officialReady: false, payoutEligible: false,
  sourceAttested: false, persistence: 'none', reasons, input: null, engineResult: null, amountCents: null });

async function readPayrollRefundAwareSourceArgsInTransaction(db, actor, scheme, period, attendanceManifest) {
  if (!hasPayrollVerifiedSourceSnapshot(db, actor?.venueId)) fail('verified_write_snapshot_required');
  const owner = (await db.query(`SELECT u.id FROM users u WHERE u.venue_id=$1 AND u.id=$2 AND u.role='owner'
    AND u.is_active=true AND u.deleted_at IS NULL`, [actor.venueId, actor.userId])).rows[0];
  if (!owner) throw Object.assign(new Error('authenticated_owner_required'), { code: 'authenticated_owner_required', status: 403 });
  let policy;
  try { policy = normalizePayrollSourcePolicies(scheme?.sourcePolicies); } catch (_) { /* blocked below */ }
  if (policy?.schemaVersion !== 2) return blocked(['payroll_refund_aware_explicit_policy_required']);
  const required = buildPayrollModeAvailability({}, {}, scheme, period)[scheme.mode]?.requiredFacts;
  if (!required) return blocked(['payroll_refund_aware_mode_invalid']);
  const closure = (await db.query(`SELECT transaction_timestamp()::text AS "transactionTimestamp",
    (transaction_timestamp() AT TIME ZONE timezone)::date::text AS "venueLocalDate",timezone
    FROM venues WHERE id=$1`, [actor.venueId])).rows[0];
  if (!closure) fail('venue_missing');
  const recognitionEvidence = await readPayrollRecognitionEvidenceInTransaction(db,
    { venueId: actor.venueId, currency: scheme.currency, from: period.from, to: period.to });
  let economics;
  try { economics = buildPayrollRefundEconomicSource(recognitionEvidence,
    { venueId: actor.venueId, currency: scheme.currency, from: period.from, to: period.to }); }
  catch (error) {
    if (error?.code?.startsWith('payroll_')) return blocked([error.code]);
    throw error;
  }
  const employmentEligibility = await loadLatestEligibilitySourceInTransaction(db, actor.venueId);
  let approvedAttendanceSource = null;
  if (required.includes('approvedAttendance')) {
    try { approvedAttendanceSource = await attendanceManifest.loadVerifiedApprovedAttendanceSourceInTransaction(db, actor,
      { periodFrom: period.from, periodTo: period.to }); }
    catch (error) {
      if (['payroll_attendance_source_incomplete', 'payroll_attendance_approval_required', 'payroll_attendance_approval_stale',
        'payroll_attendance_snapshot_invalid', 'payroll_attendance_function_context_schema_required'].includes(error?.code)) return blocked([error.code]);
      throw error;
    }
  }
  let departmentMapping = null;
  if (required.includes('immutableDepartmentAttribution')) {
    departmentMapping = await loadLatestProductDepartmentMappingInTransaction(db, actor.venueId);
    if (departmentMapping.component.status !== 'available') return blocked(departmentMapping.component.reasons);
  }
  let costEvidenceByOrder = null;
  if (required.includes('marginCosts')) {
    const cost = await readPayrollRefundFrozenCostSourceInTransaction(db, { venueId: actor.venueId, currency: scheme.currency,
      period, sourcePolicies: policy, projection: economics.projection });
    if (cost.status !== 'available') return blocked(cost.reasons);
    costEvidenceByOrder = cost.evidenceByOrder;
  }
  return { status: 'source_arguments_collected', sourceArgs: { venueId: actor.venueId, scheme, period,
    periodClosure: { schemaVersion: 1, venueId: actor.venueId, period, ...closure },
    recognitionEvidence, employmentEligibility, approvedAttendanceSource, departmentMapping, costEvidenceByOrder } };
}

async function collectPayrollRefundAwareCalculationInTransaction(...args) {
  const collected = await readPayrollRefundAwareSourceArgsInTransaction(...args);
  return collected.status === 'source_arguments_collected' ? buildPayrollRefundAwareCalculation(collected.sourceArgs) : collected;
}

// A sourced comparison shares the expensive raw facts across every v2 scheme.
// This is intentionally separate from the single-run collector above so its
// existing call contract and source-read behavior remain unchanged.
async function collectPayrollRefundAwareComparisonInTransaction(db, actor, schemes, period, attendanceManifest,
  { baselineVersionId, onSharedSources, legacyPreviewsByVersionId } = {}) {
  if (!hasPayrollVerifiedSourceSnapshot(db, actor?.venueId)) fail('verified_write_snapshot_required');
  const owner = (await db.query(`SELECT u.id FROM users u WHERE u.venue_id=$1 AND u.id=$2 AND u.role='owner'
    AND u.is_active=true AND u.deleted_at IS NULL`, [actor.venueId, actor.userId])).rows[0];
  if (!owner) throw Object.assign(new Error('authenticated_owner_required'), { code: 'authenticated_owner_required', status: 403 });
  if (!Array.isArray(schemes) || schemes.length < 2 || schemes.length > 8 || !period?.from || !period?.to
      || !schemes.some(row => row?.versionId === baselineVersionId)) fail('comparison_input_invalid');

  const policies = [], requiredByVersion = [];
  for (const scheme of schemes) {
    let policy;
    try { policy = normalizePayrollSourcePolicies(scheme?.sourcePolicies); } catch (_) { /* blocked candidate below */ }
    policies.push(policy);
    requiredByVersion.push(buildPayrollModeAvailability({}, {}, scheme, period)[scheme.mode]?.requiredFacts || []);
  }
  const v2Schemes = schemes.filter((_, index) => policies[index]?.schemaVersion === 2);
  if (!v2Schemes.length) fail('comparison_v2_candidate_required');
  const currencies = new Set(schemes.map(scheme => scheme.currency));
  if (currencies.size !== 1) fail('comparison_currency_mismatch');
  const currency = schemes[0].currency;

  const closure = (await db.query(`SELECT transaction_timestamp()::text AS "transactionTimestamp",
    (transaction_timestamp() AT TIME ZONE timezone)::date::text AS "venueLocalDate",timezone
    FROM venues WHERE id=$1`, [actor.venueId])).rows[0];
  if (!closure) fail('venue_missing');
  let recognitionEvidence, economics, eligibility;
  try {
    recognitionEvidence = await readPayrollRecognitionEvidenceInTransaction(db,
      { venueId: actor.venueId, currency, from: period.from, to: period.to });
    economics = buildPayrollRefundEconomicSource(recognitionEvidence,
      { venueId: actor.venueId, currency, from: period.from, to: period.to });
    eligibility = await loadLatestEligibilitySourceInTransaction(db, actor.venueId);
  } catch (error) {
    if (error?.code?.startsWith('payroll_')) {
      return buildPayrollRefundAwareSourcedComparison({ venueId: actor.venueId, currency, period, baselineVersionId,
        versions: schemes, policies, calculations: schemes.map(() => ({ status: 'blocked', reasons: [error.code], amountCents: null,
          inputWatermark: null, employees: [], sourceWatermarks: {} })), commonSource: { venueId: actor.venueId, currency,
          period: { from: period.from, to: period.to }, timezone: closure.timezone, recognitionManifestWatermark: null,
          economicsSourceWatermark: null, eligibilityWatermark: null, optionalRawWatermarks: {} }, commonFailure: error.code });
    }
    throw error;
  }

  const requiredUnion = new Set(requiredByVersion.flat());
  const optional = {};
  const hasLegacy = policies.some(policy => policy?.schemaVersion === 1);
  if (requiredUnion.has('approvedAttendance') || hasLegacy) {
    try {
      optional.approvedAttendanceSource = await attendanceManifest.loadVerifiedApprovedAttendanceSourceInTransaction(db, actor,
        { periodFrom: period.from, periodTo: period.to });
    } catch (error) {
      if (!['payroll_attendance_source_incomplete', 'payroll_attendance_approval_required', 'payroll_attendance_approval_stale',
        'payroll_attendance_snapshot_invalid', 'payroll_attendance_function_context_schema_required'].includes(error?.code)) throw error;
      optional.approvedAttendanceError = error.code;
    }
  }
  if (requiredUnion.has('immutableDepartmentAttribution')) {
    try {
      optional.departmentMapping = await loadLatestProductDepartmentMappingInTransaction(db, actor.venueId);
      if (optional.departmentMapping.component.status !== 'available') {
        optional.departmentMappingError = optional.departmentMapping.component.reasons?.[0] || 'payroll_refund_aware_department_source_unavailable';
      }
    } catch (error) {
      if (!error?.code?.startsWith('payroll_')) throw error;
      optional.departmentMappingError = error.code;
    }
  }
  if (requiredUnion.has('marginCosts')) {
    try {
      const schema = await db.query(`SELECT count(*)::int AS count FROM unnest($1::text[]) AS required(name)
        WHERE EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass(split_part(required.name,'.',1))
        AND attname=split_part(required.name,'.',2) AND NOT attisdropped)`, [[
        'pos_sale_cost_evidence.venue_id','pos_sale_cost_evidence.order_id','pos_sale_cost_evidence.payload',
        'pos_sale_cost_evidence.watermark','pos_sale_cost_epochs.venue_id','pos_sale_cost_epochs.activated_at']]);
      if (schema.rows[0]?.count !== 6) optional.costError = 'payroll_margin_cost_source_schema_missing';
      else {
        const orderIds = new Set();
        for (const scheme of schemes) if (requiredByVersion[schemes.indexOf(scheme)].includes('marginCosts')
            && policies[schemes.indexOf(scheme)]?.schemaVersion === 1) {
          for (const sale of recognitionEvidence.manifest.sales || []) orderIds.add(sale.orderId);
        }
        const inPeriod = economics.projection.saleLines.filter(line => line.inEarningPeriod);
        optional.refundPeriodOrderIds = new Set(inPeriod.map(line => line.orderId));
        for (const scheme of v2Schemes) if (requiredByVersion[schemes.indexOf(scheme)].includes('marginCosts'))
          for (const line of inPeriod) orderIds.add(line.orderId);
        optional.rawCostEvidenceByOrder = [];
        for (const orderId of [...orderIds].sort()) optional.rawCostEvidenceByOrder.push(
          await readSaleCostEvidence(db, { venueId: actor.venueId, orderId }));
        const legacyOrderIds = new Set((recognitionEvidence.manifest.sales || []).map(sale => sale.orderId));
        optional.legacyCostEvidenceByOrder = optional.rawCostEvidenceByOrder.filter(evidence => legacyOrderIds.has(evidence.orderId));
      }
    } catch (error) {
      if (!error?.code?.startsWith('payroll_')) throw error;
      optional.costError = error.code;
    }
  }

  // V1 readiness consumes approved attendance, eligibility, and optional department
  // and cost sources even when its mode does not price all of them. Read each raw
  // optional family once for the mixed comparison, then let each version-specific
  // immutable builder derive its own shape and readiness result.
  if (hasLegacy && !optional.approvedAttendanceSource && !optional.approvedAttendanceError) {
    try { optional.approvedAttendanceSource = await attendanceManifest.loadVerifiedApprovedAttendanceSourceInTransaction(db, actor,
      { periodFrom: period.from, periodTo: period.to }); }
    catch (error) {
      if (!['payroll_attendance_source_incomplete','payroll_attendance_approval_required','payroll_attendance_approval_stale',
        'payroll_attendance_snapshot_invalid','payroll_attendance_function_context_schema_required'].includes(error?.code)) throw error;
      optional.approvedAttendanceError = error.code;
    }
  }
  if (hasLegacy && requiredUnion.has('immutableDepartmentAttribution') && !optional.departmentMapping && !optional.departmentMappingError) {
    try { optional.departmentMapping = await loadLatestProductDepartmentMappingInTransaction(db, actor.venueId); }
    catch (error) { if (!error?.code?.startsWith('payroll_')) throw error; optional.departmentMappingError = error.code; }
  }

  const commonSource = { schemaVersion: 2, venueId: actor.venueId, currency, period: { from: period.from, to: period.to },
    timezone: closure.timezone, recognitionManifestWatermark: recognitionEvidence?.manifest?.watermark || null,
    economicsSourceWatermark: economics?.sourceWatermark || null,
    eligibilityWatermark: eligibility?.component?.sourceWatermark || null,
    optionalRawWatermarks: {
      approvedAttendance: optional.approvedAttendanceSource?.sourceAttendanceApproval?.sourceWatermark || null,
      departmentMapping: optional.departmentMapping?.component?.sourceWatermark || null,
      frozenDepletionCost: optional.rawCostEvidenceByOrder ? createHash('sha256').update(JSON.stringify(optional.rawCostEvidenceByOrder)).digest('hex') : null,
      frozenSaleCostByOrder: Object.fromEntries((optional.rawCostEvidenceByOrder || []).map(row => [row.orderId, row.watermark])),
      departmentMappingRevision: optional.departmentMapping?.component?.sourceWatermark || null
    } };
  if (onSharedSources !== undefined) {
    if (typeof onSharedSources !== 'function') fail('comparison_callback_invalid');
    await onSharedSources({ recognitionManifest: recognitionEvidence.manifest, recognitionEvidence, economics, closure,
      employmentEligibility: eligibility,
      approvedAttendanceSource: optional.approvedAttendanceSource || null, approvedAttendanceError: optional.approvedAttendanceError || null,
      departmentMapping: optional.departmentMapping || null, departmentMappingError: optional.departmentMappingError || null,
      legacyCostEvidenceByOrder: optional.legacyCostEvidenceByOrder || null, legacyCostSchemaAvailable: !optional.costError,
      commonSource });
  }
  const candidateRawBindings = schemes.map((scheme, index) => policies[index]?.schemaVersion === 2 ? {
    departmentMappingRevision: requiredByVersion[index].includes('immutableDepartmentAttribution')
      ? optional.departmentMapping?.component?.sourceWatermark || null : null,
    frozenSaleCostByOrder: requiredByVersion[index].includes('marginCosts')
      ? Object.fromEntries((optional.rawCostEvidenceByOrder || []).filter(evidence => optional.refundPeriodOrderIds?.has(evidence.orderId))
        .map(evidence => [evidence.orderId, evidence.watermark])) : null
  } : null);
  const calculations = await Promise.all(schemes.map(async (scheme, index) => {
    const policy = policies[index];
    if (policy?.schemaVersion !== 2) return { status: 'blocked', reasons: ['payroll_refund_aware_policy_not_supported_in_v2_comparison'],
      amountCents: null, inputWatermark: null, employees: [], sourceWatermarks: {} };
    const required = requiredByVersion[index];
    const missingOptional = [];
    if (required.includes('approvedAttendance') && optional.approvedAttendanceError) missingOptional.push(optional.approvedAttendanceError);
    if (required.includes('immutableDepartmentAttribution') && optional.departmentMappingError) missingOptional.push(optional.departmentMappingError);
    if (required.includes('marginCosts') && optional.costError) missingOptional.push(optional.costError);
    if (missingOptional.length) return { status: 'blocked', reasons: [...new Set(missingOptional)].sort(), amountCents: null,
      inputWatermark: null, employees: [], sourceWatermarks: {} };
    const result = buildPayrollRefundAwareCalculation({ venueId: actor.venueId, scheme, period,
      periodClosure: { schemaVersion: 1, venueId: actor.venueId, period: { from: period.from, to: period.to }, ...closure },
      recognitionEvidence, employmentEligibility: eligibility,
      approvedAttendanceSource: required.includes('approvedAttendance') ? optional.approvedAttendanceSource : null,
      departmentMapping: required.includes('immutableDepartmentAttribution') ? optional.departmentMapping : null,
      costEvidenceByOrder: required.includes('marginCosts') ? optional.rawCostEvidenceByOrder?.filter(evidence =>
        optional.refundPeriodOrderIds?.has(evidence.orderId)) : null });
    return result.status === 'refund_aware_calculated' ? result : { ...result, status: 'blocked' };
  }));
  const combinedCalculations = calculations.map((candidate, index) => policies[index]?.schemaVersion === 1
    ? { ...candidate, legacyPreview: legacyPreviewsByVersionId?.[schemes[index].versionId] || null }
    : candidate);
  return buildPayrollRefundAwareSourcedComparison({ venueId: actor.venueId, currency, period, baselineVersionId,
    versions: schemes, policies, calculations: combinedCalculations, candidateRawBindings, commonSource });
}

module.exports = { collectPayrollRefundAwareCalculationInTransaction, readPayrollRefundAwareSourceArgsInTransaction,
  collectPayrollRefundAwareComparisonInTransaction };
