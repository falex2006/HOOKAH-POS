'use strict';

// Candidate-only server envelope. The owner-checked caller supplies source
// evidence and an ephemeral calculation result; this module never writes payroll.
const { createHash } = require('node:crypto');
const { buildPayrollRecognitionPreview } = require('./payroll-recognition-preview');
const { buildPayrollModeAvailability } = require('./payroll-mode-availability');
const { buildPayrollCalculationInputContract, NO_REFUND_INPUT_CAPABILITY } = require('./payroll-calculation-input-contract');
const { buildPayrollRefundReview } = require('./payroll-refund-review');
const { verifyPayrollCandidateSnapshotBundle } = require('./payroll-candidate-snapshot-bundle');

const stable = value => {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
};
const digest = value => createHash('sha256').update(stable(value)).digest('hex');
const componentReasons = components => [...new Set(Object.values(components || {})
  .flatMap(component => Array.isArray(component?.reasons) ? component.reasons : []))].sort();
const readinessStatus = components => {
  const statuses = Object.values(components || {}).map(component => component?.status);
  if (statuses.includes('incomplete')) return 'incomplete';
  if (statuses.includes('unsupported')) return 'unsupported';
  if (statuses.length && statuses.every(status => status === 'available')) return 'available';
  return 'incomplete';
};

const buildPayrollSourcedPreview = ({ venueId, scheme, period, readiness, recognitionManifest, calculationSourceBundle = null,
  attestations = {}, candidateCalculation = null, candidateSnapshot = null, candidateSnapshotStatus = null, periodClosure = null }) => {
  if (!venueId || !scheme || !period || !readiness || !recognitionManifest) throw new TypeError('payroll_sourced_preview_evidence_required');
  if (readiness.versionId !== scheme.versionId || readiness.period?.from !== period.from || readiness.period?.to !== period.to
      || recognitionManifest.venueId !== venueId || recognitionManifest.currency !== scheme.currency
      || recognitionManifest.period?.from !== period.from || recognitionManifest.period?.to !== period.to
      || (recognitionManifest.period?.timezone !== undefined && readiness.period?.timezone
        && recognitionManifest.period.timezone !== readiness.period.timezone)) {
    throw new TypeError('payroll_sourced_preview_evidence_mismatch');
  }
  if (candidateSnapshot && (candidateCalculation?.status !== 'scenario_ready'
      || candidateSnapshot.schemaVersion !== 1 || candidateSnapshot.snapshotKind !== 'candidate_preview'
      || candidateSnapshot.candidateOnly !== true || candidateSnapshot.officialReady !== false
      || candidateSnapshot.payoutEligible !== false || candidateSnapshot.nonPayable !== true
      || candidateSnapshot.nonAccrual !== true || candidateSnapshot.persistence !== 'none'
      || candidateSnapshot.venueId !== venueId || candidateSnapshot.currency !== scheme.currency
      || candidateSnapshot.schemeId !== scheme.id || candidateSnapshot.schemeVersionId !== scheme.versionId
      || candidateSnapshot.amountCents !== candidateCalculation.amountCents
      || candidateSnapshot.source?.inputWatermark !== calculationSourceBundle?.inputWatermark
      || !verifyPayrollCandidateSnapshotBundle({ snapshot: candidateSnapshot, candidateCalculation })
      || candidateSnapshot.period?.from !== period.from || candidateSnapshot.period?.to !== period.to
      || candidateSnapshot.period?.timezone !== readiness.period?.timezone)) {
    throw new TypeError('payroll_sourced_preview_candidate_snapshot_mismatch');
  }
  const projection = buildPayrollRecognitionPreview(recognitionManifest, scheme.sourcePolicies);
  const refundReview = buildPayrollRefundReview(recognitionManifest, projection);
  // The underlying projection totals sum only the lines that survived current
  // attribution validation. They are not full-period employee revenue totals
  // when coverage is incomplete, so expose them only as null at this envelope.
  const candidateProjection = { ...projection, saleNetRevenueCents: null, refundNetRevenueAdjustmentCents: null,
    aggregateStatus: 'unavailable', aggregateReasons: ['payroll_recognition_aggregate_full_coverage_not_attested'] };
  const sourceReasons = [...new Set([...componentReasons(readiness.components), ...componentReasons(attestations)])].sort();
  const reasons = [...new Set([...sourceReasons, ...projection.reasons, 'payroll_official_run_not_available',
    'payroll_recognition_aggregate_full_coverage_not_attested'])].sort();
  const watermark = digest({ schemaVersion: 1, venueId: recognitionManifest.venueId,
    scheme, period: readiness.period, readiness: readiness.components,
    recognitionManifestWatermark: recognitionManifest.watermark, projectionWatermark: projection.projectionWatermark || null,
    refundReviewWatermark: refundReview.sourceWatermark || null,
    orderRevenueReconciliationWatermark: calculationSourceBundle?.orderRevenueReconciliation?.sourceWatermark || null,
    calculationSourceBundleWatermark: calculationSourceBundle?.inputWatermark || null });
  const modes = buildPayrollModeAvailability(readiness.components, attestations, scheme, period);
  const venueTurnoverRequired = modes[scheme.mode]?.requiredFacts?.includes('venueDailyTurnover') === true;
  const calculationInputContract = buildPayrollCalculationInputContract({ venueId, scheme, period, readiness, attestations,
    sourceBundle: calculationSourceBundle });
  const noRefundInputContract = buildPayrollCalculationInputContract({ venueId, scheme, period, readiness, attestations,
    sourceBundle: calculationSourceBundle, purpose: 'official_no_refund_input', periodClosure });
  const sourceStatus = modes[scheme.mode]?.inputStatus || readinessStatus(readiness.components);
  const fullNetCandidate = calculationSourceBundle?.fullEmployeeNetRevenue || null;
  const fullEmployeeNetRevenue = fullNetCandidate ? {
    status: fullNetCandidate.status,
    reasons: fullNetCandidate.reasons,
    amount: fullNetCandidate.status === 'available' ? fullNetCandidate.amount : null,
    currency: fullNetCandidate.currency || null,
    daily: fullNetCandidate.status === 'available' ? fullNetCandidate.daily : [],
    sourceWatermark: fullNetCandidate.sourceWatermark,
    watermarkScope: fullNetCandidate.watermarkScope,
    metric: 'net_merchandise_value_by_original_employee_and_recognition_date',
    label: 'Чистая стоимость товаров по сотрудникам',
    description: 'После скидок и товарных возвратов, по датам признания. Не сумма зарплаты.'
  } : { status: 'incomplete', reasons: ['full_employee_net_revenue_candidate_missing'], amount: null, daily: [],
    sourceWatermark: null, watermarkScope: 'full_employee_net_revenue_candidate_series',
    metric: 'net_merchandise_value_by_original_employee_and_recognition_date' };
  return {
    schemaVersion: 1,
    status: sourceStatus,
    sourceStatus,
    projectionStatus: projection.status,
    versionId: scheme.versionId,
    schemeId: scheme.id,
    selectedMode: scheme.mode,
    period: { ...period, timezone: readiness.period?.timezone || null },
    calculationStatus: 'unavailable',
    amount: null,
    candidateOnly: true,
    officialReady: false,
    reasons,
    modes,
    calculationInputContract: calculationInputContract.status === 'blocked' || calculationInputContract.candidateOnly
      ? calculationInputContract : { schemaVersion: calculationInputContract.schemaVersion, status: calculationInputContract.status,
        candidateOnly: true, officialReady: false, payoutEligible: false, persistence: 'none', selectedMode: calculationInputContract.selectedMode,
        requiredFacts: calculationInputContract.requiredFacts, reasons: calculationInputContract.reasons,
        inputWatermark: calculationInputContract.inputWatermark },
    noRefundInput: { schemaVersion: noRefundInputContract.schemaVersion, status: noRefundInputContract.status,
      capabilityVersion: noRefundInputContract.capabilityVersion || NO_REFUND_INPUT_CAPABILITY,
      officialReady: false, payoutEligible: false, persistence: 'none',
      requiredFacts: noRefundInputContract.requiredFacts, reasons: noRefundInputContract.reasons,
      inputWatermark: noRefundInputContract.inputWatermark, closureWatermark: noRefundInputContract.closureWatermark || null },
    candidateCalculation: candidateCalculation ? structuredClone(candidateCalculation) : {
      schemaVersion: 1, status: 'blocked', candidateOnly: true, payoutEligible: false, nonPayable: true, nonAccrual: true,
      officialReady: false, amountCents: null, schemeVersionId: scheme.versionId,
      period: { from: period.from, to: period.to }, reasons: ['payroll_candidate_calculation_unavailable'],
      inputWatermark: null, daily: [], employees: []
    },
    candidateSnapshot: candidateSnapshot ? structuredClone(candidateSnapshot) : null,
    candidateSnapshotStatus: candidateSnapshot ? 'available' : (candidateSnapshotStatus
      || (candidateCalculation?.status === 'scenario_ready' ? 'unavailable' : 'not_applicable')),
    sources: {
      readiness,
      recognitionProjection: candidateProjection,
      fullEmployeeNetRevenue,
      orderRevenueReconciliation: calculationSourceBundle?.orderRevenueReconciliation ?
        structuredClone(calculationSourceBundle.orderRevenueReconciliation) : {
          schemaVersion: 1, status: 'unsupported', candidateOnly: true, officialReady: false, persistence: 'none',
          currency: scheme.currency, period: { from: period.from, to: period.to, timezone: readiness.period?.timezone || null },
          amountBasis: 'canonical_closed_order_total_pre_refund', closedOrderCount: null, recognizedOrderCount: null,
          unrecognizedOrderCount: null, totals: { closedOrderTotalMinor: null, recognizedLineNetMinor: null,
            minimumPriceAdjustmentMinor: null, unattributedResidualMinor: null },
          coverage: { complete: false, missingSaleEventCount: null, invalidSnapshotCount: null }, orders: [],
          reasons: ['payroll_order_revenue_reconciliation_unavailable'], sourceWatermark: null,
          watermarkScope: 'payroll_owner_closed_order_to_recognized_line_reconciliation'
        },
      refundReview,
      departmentAttribution: calculationSourceBundle?.departmentAttribution ? {
        status: calculationSourceBundle.departmentAttribution.status,
        reasons: calculationSourceBundle.departmentAttribution.reasons,
        rows: calculationSourceBundle.departmentAttribution.rows,
        refunds: calculationSourceBundle.departmentAttribution.refunds,
        coverage: calculationSourceBundle.departmentAttribution.coverage,
        mappingRevision: calculationSourceBundle.departmentAttribution.mappingRevision,
        sourceWatermark: calculationSourceBundle.departmentAttribution.sourceWatermark,
        watermarkScope: calculationSourceBundle.departmentAttribution.watermarkScope
      } : {
        status: attestations?.immutableDepartmentAttribution?.status || 'not_required',
        reasons: attestations?.immutableDepartmentAttribution?.reasons || [], rows: [], refunds: [], coverage: null,
        mappingRevision: null, sourceWatermark: null,
        watermarkScope: 'payroll_owner_attested_product_department_classification'
      },
      venueDailyTurnover: calculationSourceBundle?.venueDailyTurnover ? {
        status: calculationSourceBundle.components?.venueDailyTurnover?.status || 'incomplete',
        reasons: calculationSourceBundle.components?.venueDailyTurnover?.reasons || [],
        daily: calculationSourceBundle.venueDailyTurnover.venueDailyTurnover,
        coverage: calculationSourceBundle.calculatorInput?.venueDailyTurnoverCoverage || null,
        sourceWatermark: calculationSourceBundle.venueDailyTurnover.sourceWatermark,
        venueTimezone: calculationSourceBundle.venueDailyTurnover.venueTimezone,
        amountBasis: calculationSourceBundle.venueDailyTurnover.amountBasis,
        refundsIncluded: false,
        financeFallbackOrderCount: calculationSourceBundle.venueDailyTurnover.financeFallbackOrderCount
      } : {
        status: attestations?.venueDailyTurnover?.status || (venueTurnoverRequired ? 'unsupported' : 'not_required'),
        reasons: attestations?.venueDailyTurnover?.reasons || (venueTurnoverRequired ? ['payroll_venue_daily_turnover_unavailable'] : []),
        daily: [], coverage: null, sourceWatermark: null, venueTimezone: null,
        amountBasis: 'finance_recognized_closed_order_total_pre_refund', refundsIncluded: false
      }
    },
    sourceWatermark: watermark,
    watermarkScope: 'sourced_payroll_candidate_input_fingerprint'
  };
};

module.exports = { buildPayrollSourcedPreview };
