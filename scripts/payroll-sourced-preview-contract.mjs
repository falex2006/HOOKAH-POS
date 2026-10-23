import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { buildPayrollSourcedPreview } = require('../payroll-sourced-preview.js');
const { buildPayrollRecognitionPreview } = require('../payroll-recognition-preview.js');
const { buildPayrollCalculationInputContract } = require('../payroll-calculation-input-contract.js');
const { buildPayrollFullEmployeeNetRevenueSource } = require('../payroll-full-employee-net-revenue-source.js');
import { createHash } from 'node:crypto';
const { MODES } = require('../payroll-schemes.js');

const ids = { venue: '11111111-1111-4111-8111-111111111111', employee: '22222222-2222-4222-8222-222222222222',
  order: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', snapshot: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  sale: '33333333-3333-4333-8333-333333333333', saleLine: '44444444-4444-4444-8444-444444444444', item: '55555555-5555-4555-8555-555555555555',
  refund: '66666666-6666-4666-8666-666666666666', refundLine: '77777777-7777-4777-8777-777777777777' };
const policies = { schemaVersion: 1, selectionReason: 'Owner selected immutable sale and event-date refund facts.',
  saleCredit: { kind: 'line_seller_snapshot' }, discountAllocation: { kind: 'immutable_line_snapshot' },
  refunds: { recognition: 'recognized_event_date', closedRunTreatment: 'next_open_run_adjustment', paidAdjustment: 'owner_review_variable_pay_only',
    uncoveredBalance: 'carry_forward_review', clawback: 'no_automatic_clawback' } };
const manifest = { schemaVersion: 1, status: 'available', officialReady: false, venueId: ids.venue, currency: 'RUB',
  period: { from: '2026-10-01', to: '2026-10-31' }, watermark: 'a'.repeat(64), reasons: [],
  sales: [{ eventId: ids.sale, venueId: ids.venue, orderId: ids.order, snapshotId: ids.snapshot, currency: 'RUB', recognizedLocalDate: '2026-10-11',
    lines: [{ saleLineEventId: ids.saleLine, orderItemId: ids.item, sellerId: ids.employee, venueId: ids.venue }] }],
  saleLines: [{ saleLineEventId: ids.saleLine, saleEventId: ids.sale, venueId: ids.venue, orderId: ids.order, snapshotId: ids.snapshot,
    orderItemId: ids.item, sellerId: ids.employee, eligibilityStatus: 'same_venue', eligibilityVenueId: ids.venue,
    employeeVenueId: ids.venue, recognizedLocalDate: '2026-10-11', currency: 'RUB', grossMinor: 15000, discountMinor: 2500, netMinor: 12500 }],
  refundHistory: [], refundOriginalSaleAttributions: [], refundEvents: [] };
const components = {
  sourcePolicies: { status: 'available', reasons: [] },
  employeeEligibility: { status: 'incomplete', reasons: ['payroll_employment_eligibility_revision_required'],
    sourceWatermark: null, watermarkScope: 'owner_attested_payroll_employment_eligibility_revision' },
  approvedAttendance: { status: 'available', reasons: [], sourceWatermark: 'b'.repeat(64) },
  canonicalLinePricing: { status: 'available', reasons: [] },
  payrollSaleCredit: { status: 'incomplete', reasons: ['employee_net_coverage_missing'] },
  recognitionManifest: { status: 'available', reasons: [] },
  recognizedLineRefunds: { status: 'unsupported', reasons: ['recognized_line_refund_lineage_not_implemented'] },
  fullEmployeeNetRevenue: { status: 'unsupported', reasons: ['full_employee_net_revenue_source_not_implemented'] },
  marginCosts: { status: 'unsupported', reasons: ['immutable_margin_cost_source_not_implemented'] },
  departmentShiftAllocation: { status: 'unsupported', reasons: ['department_shift_allocation_source_not_implemented'] }
};
const args = { venueId: ids.venue, scheme: { id: '99999999-9999-4999-8999-999999999999', versionId: '88888888-8888-4888-8888-888888888888',
    venueId: ids.venue, mode: 'progressive_daily', currency: 'RUB', sourcePolicies: policies },
  period: { from: '2026-10-01', to: '2026-10-31' },
  readiness: { schemaVersion: 1, versionId: '88888888-8888-4888-8888-888888888888', period: { from: '2026-10-01', to: '2026-10-31', timezone: 'Asia/Yekaterinburg' },
    officialReady: false, requiredSourceFacts: [], components }, recognitionManifest: manifest };

const preview = buildPayrollSourcedPreview(args);
const previewWithDifferentBundleFingerprint = buildPayrollSourcedPreview({ ...args,
  calculationSourceBundle: { inputWatermark: 'e'.repeat(64) } });
assert.notEqual(previewWithDifferentBundleFingerprint.sourceWatermark, preview.sourceWatermark,
  'public preview fingerprint changes when its internal source bundle fingerprint changes');
assert.equal(preview.candidateOnly, true);
assert.equal(preview.officialReady, false);
assert.equal(preview.calculationStatus, 'unavailable');
assert.equal(preview.amount, null, 'unavailable amount must never be presented as zero');
assert.equal(preview.status, 'unsupported', 'selected-mode source status reflects the mode-specific gate');
assert.equal(preview.sourceStatus, 'unsupported', 'selected-mode source status must not hide an unsupported required source');
assert.equal(preview.projectionStatus, 'incomplete');
assert.equal(preview.calculationInputContract.status, 'blocked');
assert.equal(preview.calculationInputContract.calculatorInput, null, 'source preview cannot fabricate an engine input');
assert.ok(preview.calculationInputContract.reasons.includes('payroll_calculator_signed_refund_input_missing'));
assert.equal(preview.period.timezone, 'Asia/Yekaterinburg', 'venue timezone is sourced from readiness; manifest period is date-only');
assert.equal(preview.sources.recognitionProjection.saleLines.length, 1);
assert.equal(preview.sources.recognitionProjection.saleLines[0].commissionBaseCents, 12500);
assert.equal(preview.sources.recognitionProjection.saleNetRevenueCents, null, 'partial line sums cannot masquerade as full-period employee revenue');
assert.equal(preview.sources.recognitionProjection.refundNetRevenueAdjustmentCents, null);
assert.equal(preview.sources.recognitionProjection.aggregateStatus, 'unavailable');
assert.ok(preview.reasons.includes('payroll_recognition_aggregate_full_coverage_not_attested'));
assert.deepEqual(Object.keys(preview.modes).sort(), MODES.slice().sort());
for (const mode of MODES) {
  assert.equal(preview.modes[mode].calculationStatus, 'unavailable');
  assert.equal(preview.modes[mode].amount, null);
  assert.equal(preview.modes[mode].reasons.includes('payroll_official_run_not_available'), true);
  assert.equal(preview.modes[mode].inputStatus, 'unsupported');
  assert.ok(preview.modes[mode].requiredFacts.includes('employeeRoleCoverage'));
}
assert.ok(preview.modes.progressive_daily.requiredFacts.includes('venueDailyTurnover'));
assert.ok(preview.modes.final_month_threshold.requiredFacts.includes('closedMonthCoverage'));
assert.ok(preview.modes.team_fund.requiredFacts.includes('teamMembershipAndWeights'));
assert.ok(preview.modes.margin_target.requiredFacts.includes('marginCosts'));
assert.ok(!preview.modes.percent_only.requiredFacts.includes('venueDailyTurnover'));
const percentOnlyPreview = buildPayrollSourcedPreview({ ...args, scheme: { ...args.scheme, mode: 'percent_only' } });
assert.equal(percentOnlyPreview.sources.venueDailyTurnover.status, 'not_required',
  'a mode without venue turnover dependency must not look blocked by an unneeded source');
assert.deepEqual(percentOnlyPreview.sources.venueDailyTurnover.reasons, []);
assert.match(preview.sourceWatermark, /^[a-f0-9]{64}$/);
assert.equal(preview.watermarkScope, 'sourced_payroll_candidate_input_fingerprint');
assert.equal(preview.sourceWatermark, buildPayrollSourcedPreview(args).sourceWatermark, 'same immutable inputs keep a stable preview watermark');
assert.notEqual(preview.sourceWatermark, buildPayrollSourcedPreview({ ...args, readiness: { ...args.readiness, components: {
  ...components, approvedAttendance: { ...components.approvedAttendance, sourceWatermark: 'c'.repeat(64) } } } }).sourceWatermark,
  'changing an input source watermark changes the preview watermark');
assert.throws(() => buildPayrollSourcedPreview({ ...args, recognitionManifest: { ...manifest, currency: 'USD' } }),
  /payroll_sourced_preview_evidence_mismatch/);
assert.throws(() => buildPayrollSourcedPreview({ ...args, recognitionManifest: { ...manifest,
  period: { ...manifest.period, timezone: 'Europe/Moscow' } } }), /payroll_sourced_preview_evidence_mismatch/);
assert.throws(() => buildPayrollSourcedPreview({ ...args, readiness: { ...args.readiness, versionId: ids.sale } }),
  /payroll_sourced_preview_evidence_mismatch/);

const refundArgs = structuredClone(args);
refundArgs.recognitionManifest.refundHistory = [{ originalSaleLineEventId: ids.saleLine, orderId: ids.order, orderItemId: ids.item,
  cumulativeReturnedQuantity: '0.400', cumulativeReturnedItemValueMinor: 4000 }];
refundArgs.recognitionManifest.refundEvents = [{ eventId: ids.refund, refundId: '88888888-8888-4888-8888-888888888888', orderId: ids.order, originalSaleEventId: ids.sale,
  currency: 'RUB', recognizedLocalDate: '2026-10-20', lines: [{ refundItemId: ids.refundLine,
    originalSaleLineEventId: ids.saleLine, orderItemId: ids.item, returnedItemValueMinor: 2500 }] }];
const refundPreview = buildPayrollSourcedPreview(refundArgs);
assert.equal(refundPreview.sources.recognitionProjection.refundAdjustments.length, 1);
assert.equal(refundPreview.sources.recognitionProjection.refundAdjustments[0].netRevenueAdjustmentCents, -2500,
  'candidate detail keeps the current-period event delta, while aggregate totals stay null');
assert.equal(refundPreview.sources.recognitionProjection.refundAdjustments[0].employeeId, ids.employee,
  'refund is attributed to the original sale seller, never to the refund actor');
assert.equal(refundPreview.sources.refundReview.status, 'available', JSON.stringify(refundPreview.sources.refundReview.reasons));
assert.equal(refundPreview.sources.refundReview.rows[0].refundDate, '2026-10-20');
assert.equal(refundPreview.sources.refundReview.rows[0].originalSaleDate, '2026-10-11');
assert.equal(refundPreview.sources.refundReview.rows[0].merchandiseNetRevenueDeltaCents, -2500,
  'refund review preserves a signed merchandise adjustment and original sale lineage without applying it to payroll');
assert.equal(refundPreview.sources.refundReview.totalMerchandiseNetRevenueDeltaCents, -2500);
assert.equal(refundPreview.sources.refundReview.payoutEligible, false);
assert.equal(refundPreview.sources.recognitionProjection.refundNetRevenueAdjustmentCents, null);
assert.equal(refundPreview.modes.progressive_daily.amount, null, 'a merchandise return is not a payroll deduction');
const incompleteRefundReview = buildPayrollSourcedPreview({ ...refundArgs, recognitionManifest: {
  ...refundArgs.recognitionManifest, status: 'incomplete', reasons: ['period_precedes_recognition_epoch'] } }).sources.refundReview;
assert.equal(incompleteRefundReview.status, 'incomplete');
assert.equal(incompleteRefundReview.totalMerchandiseNetRevenueDeltaCents, null);
assert.deepEqual(incompleteRefundReview.rows, [], 'partial refund evidence is never presented as a complete review amount');

const stable = value => {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
};
const fingerprint = value => createHash('sha256').update(stable(value)).digest('hex');
const candidateProjection = buildPayrollRecognitionPreview(refundArgs.recognitionManifest, policies);
const candidateFullNet = buildPayrollFullEmployeeNetRevenueSource(refundArgs.recognitionManifest, policies);
const candidateReadiness = structuredClone(refundArgs.readiness);
candidateReadiness.components.recognitionManifest = { status: 'available', reasons: [], sourceWatermark: manifest.watermark,
  watermarkScope: 'immutable_recognition_manifest' };
candidateReadiness.components.recognizedLineRefunds = { status: candidateProjection.sourceStatus, reasons: candidateProjection.sourceReasons,
  sourceWatermark: candidateProjection.projectionWatermark, watermarkScope: 'immutable_recognized_sale_and_refund_candidate_projection' };
candidateReadiness.components.fullEmployeeNetRevenue = { status: candidateFullNet.status, reasons: candidateFullNet.reasons,
  sourceWatermark: candidateFullNet.sourceWatermark, watermarkScope: candidateFullNet.watermarkScope };
const turnoverWatermark = 'd'.repeat(64);
const turnoverComponent = { status: 'available', reasons: [], sourceWatermark: turnoverWatermark,
  watermarkScope: 'owner_closed_order_turnover_pre_refund', venueId: ids.venue, currency: 'RUB',
  period: { from: '2026-10-01', to: '2026-10-31' } };
const turnoverRows = Array.from({ length: 31 }, (_, index) => ({ date: `2026-10-${String(index + 1).padStart(2, '0')}`,
  turnoverCents: index === 10 ? 12500 : 0 }));
const turnoverCoverage = { from: '2026-10-01', through: '2026-10-31', complete: true, venueId: ids.venue,
  currency: 'RUB', period: { from: '2026-10-01', to: '2026-10-31' }, venueTimezone: 'Asia/Yekaterinburg',
  sourceWatermark: turnoverWatermark, watermarkScope: turnoverComponent.watermarkScope, refundsIncluded: false,
  amountBasis: 'finance_recognized_closed_order_total_pre_refund' };
const readinessWatermark = fingerprint(candidateReadiness.components);
const candidateBundle = {
  schemaVersion: 1, venueId: ids.venue, schemeVersionId: args.scheme.versionId, currency: 'RUB',
  period: { from: '2026-10-01', to: '2026-10-31' }, readinessWatermark,
  components: {
    recognitionManifest: { ...candidateReadiness.components.recognitionManifest, venueId: ids.venue, currency: 'RUB', period: { from: '2026-10-01', to: '2026-10-31' } },
    recognizedLineRefunds: { ...candidateReadiness.components.recognizedLineRefunds, venueId: ids.venue, currency: 'RUB', period: { from: '2026-10-01', to: '2026-10-31' } },
    fullEmployeeNetRevenue: { ...candidateReadiness.components.fullEmployeeNetRevenue, venueId: ids.venue, currency: 'RUB', period: { from: '2026-10-01', to: '2026-10-31' } },
    venueDailyTurnover: turnoverComponent
  },
  recognitionManifest: refundArgs.recognitionManifest,
  recognizedLineProjection: { schemaVersion: 1, venueId: ids.venue, currency: 'RUB', period: { from: '2026-10-01', to: '2026-10-31' },
    sourceWatermark: manifest.watermark, projectionWatermark: candidateProjection.projectionWatermark,
    sourceStatus: candidateProjection.sourceStatus, sourceReasons: candidateProjection.sourceReasons,
    saleLines: candidateProjection.saleLines, refundAdjustments: candidateProjection.refundAdjustments },
  fullEmployeeNetRevenue: candidateFullNet,
  venueDailyTurnover: { from: '2026-10-01', through: '2026-10-31', venueTimezone: 'Asia/Yekaterinburg',
    amountBasis: turnoverCoverage.amountBasis, refundsIncluded: false, sourceWatermark: turnoverWatermark,
    venueDailyTurnover: turnoverRows.map(row => ({ ...row })) },
  calculatorInput: { periodFrom: '2026-10-01', periodTo: '2026-10-31', venueDailyTurnover: turnoverRows.map(row => ({ ...row })),
    venueDailyTurnoverCoverage: turnoverCoverage }
};
candidateBundle.inputWatermark = fingerprint(candidateBundle);
const candidateGate = buildPayrollCalculationInputContract({ venueId: ids.venue, scheme: args.scheme,
  period: { from: '2026-10-01', to: '2026-10-31' }, readiness: candidateReadiness,
  attestations: { venueDailyTurnover: turnoverComponent }, sourceBundle: candidateBundle });
assert.ok(!candidateGate.reasons.some(reason => reason.startsWith('payroll_calculation_recognized_line_')),
  'separate sale/refund candidate collections bind to the same readiness manifest and projection');
assert.ok(candidateGate.reasons.includes('payroll_calculator_signed_refund_input_missing'));
assert.ok(!candidateGate.reasons.includes('payroll_calculation_full_employee_net_revenue_binding_mismatch'));
assert.equal(candidateGate.calculatorInput, null, 'candidate rows do not create a calculator input');
assert.ok(!candidateGate.reasons.some(reason => reason.startsWith('payroll_calculation_venueDailyTurnover_')),
  'separate venue turnover coverage binds its date series, scope and source watermark');
assert.equal(candidateBundle.calculatorInput.fullEmployeeNetRevenue, undefined, 'candidate metric stays outside calculator input');
assert.equal(candidateFullNet.amount, 10000, 'the sale and partial item refund net across their separate recognition dates');
const tamperedFullNetBundle = structuredClone(candidateBundle);
tamperedFullNetBundle.fullEmployeeNetRevenue.amount += 1;
tamperedFullNetBundle.inputWatermark = fingerprint(Object.fromEntries(Object.entries(tamperedFullNetBundle).filter(([key]) => key !== 'inputWatermark')));
const tamperedFullNetGate = buildPayrollCalculationInputContract({ venueId: ids.venue, scheme: args.scheme,
  period: { from: '2026-10-01', to: '2026-10-31' }, readiness: candidateReadiness, sourceBundle: tamperedFullNetBundle });
assert.ok(tamperedFullNetGate.reasons.includes('payroll_calculation_full_employee_net_revenue_binding_mismatch'),
  'candidate content is recomputed from the immutable recognition manifest');
const tamperedCandidateBundle = structuredClone(candidateBundle);
tamperedCandidateBundle.recognizedLineProjection.refundAdjustments[0].employeeId = ids.refund;
tamperedCandidateBundle.inputWatermark = fingerprint(Object.fromEntries(Object.entries(tamperedCandidateBundle).filter(([key]) => key !== 'inputWatermark')));
const tamperedCandidateGate = buildPayrollCalculationInputContract({ venueId: ids.venue, scheme: args.scheme,
  period: { from: '2026-10-01', to: '2026-10-31' }, readiness: candidateReadiness, sourceBundle: tamperedCandidateBundle });
assert.ok(tamperedCandidateGate.reasons.includes('payroll_calculation_recognized_line_projection_content_mismatch'),
  'a self-consistent outer fingerprint cannot substitute a different refund recipient for the verified sale seller');
const tamperedDiagnosticBundle = structuredClone(candidateBundle);
tamperedDiagnosticBundle.recognizedLineProjection.sourceReasons.push('invented_candidate_diagnostic');
tamperedDiagnosticBundle.inputWatermark = fingerprint(Object.fromEntries(Object.entries(tamperedDiagnosticBundle).filter(([key]) => key !== 'inputWatermark')));
const tamperedDiagnosticGate = buildPayrollCalculationInputContract({ venueId: ids.venue, scheme: args.scheme,
  period: { from: '2026-10-01', to: '2026-10-31' }, readiness: candidateReadiness, sourceBundle: tamperedDiagnosticBundle });
assert.ok(tamperedDiagnosticGate.reasons.includes('payroll_calculation_recognized_line_projection_content_mismatch'),
  'candidate diagnostic reasons are recomputed from the manifest along with the line rows');
const tamperedTurnoverBundle = structuredClone(candidateBundle);
tamperedTurnoverBundle.calculatorInput.venueDailyTurnover[0].turnoverCents = 1;
tamperedTurnoverBundle.inputWatermark = fingerprint(Object.fromEntries(Object.entries(tamperedTurnoverBundle).filter(([key]) => key !== 'inputWatermark')));
const tamperedTurnoverGate = buildPayrollCalculationInputContract({ venueId: ids.venue, scheme: args.scheme,
  period: { from: '2026-10-01', to: '2026-10-31' }, readiness: candidateReadiness,
  attestations: { venueDailyTurnover: turnoverComponent }, sourceBundle: tamperedTurnoverBundle });
assert.ok(tamperedTurnoverGate.reasons.includes('payroll_calculation_venueDailyTurnover_source_binding_mismatch'),
  `altering venue daily turnover rows is caught even when the outer bundle digest is recomputed: ${tamperedTurnoverGate.requiredFacts.join(',')} | ${tamperedTurnoverGate.reasons.join(',')}`);
const incompleteTurnoverBundle = structuredClone(candidateBundle);
incompleteTurnoverBundle.calculatorInput.venueDailyTurnover.pop();
incompleteTurnoverBundle.inputWatermark = fingerprint(Object.fromEntries(Object.entries(incompleteTurnoverBundle).filter(([key]) => key !== 'inputWatermark')));
const incompleteTurnoverGate = buildPayrollCalculationInputContract({ venueId: ids.venue, scheme: args.scheme,
  period: { from: '2026-10-01', to: '2026-10-31' }, readiness: candidateReadiness,
  attestations: { venueDailyTurnover: turnoverComponent }, sourceBundle: incompleteTurnoverBundle });
assert.ok(incompleteTurnoverGate.reasons.includes('payroll_calculation_venueDailyTurnover_rows_incomplete'),
  'a missing daily total blocks turnover coverage even if the bundle digest is recomputed');
const tamperedCoverageBundle = structuredClone(candidateBundle);
tamperedCoverageBundle.calculatorInput.venueDailyTurnoverCoverage.sourceWatermark = 'e'.repeat(64);
tamperedCoverageBundle.inputWatermark = fingerprint(Object.fromEntries(Object.entries(tamperedCoverageBundle).filter(([key]) => key !== 'inputWatermark')));
const tamperedCoverageGate = buildPayrollCalculationInputContract({ venueId: ids.venue, scheme: args.scheme,
  period: { from: '2026-10-01', to: '2026-10-31' }, readiness: candidateReadiness,
  attestations: { venueDailyTurnover: turnoverComponent }, sourceBundle: tamperedCoverageBundle });
assert.ok(tamperedCoverageGate.reasons.includes('payroll_calculation_venueDailyTurnover_coverage_context_mismatch'),
  'coverage watermark must match its attested component, even if the outer digest is recomputed');
const unsupportedPolicies = { ...policies, refunds: { ...policies.refunds, recognition: 'original_sale_period_correction' } };
const unsupportedProjection = buildPayrollRecognitionPreview(refundArgs.recognitionManifest, unsupportedPolicies);
const unsupportedReadiness = structuredClone(candidateReadiness);
unsupportedReadiness.components.recognizedLineRefunds = { ...unsupportedReadiness.components.recognizedLineRefunds,
  status: unsupportedProjection.sourceStatus, reasons: unsupportedProjection.sourceReasons, sourceWatermark: null };
const unsupportedBundle = structuredClone(candidateBundle);
unsupportedBundle.readinessWatermark = fingerprint(unsupportedReadiness.components);
unsupportedBundle.components.recognizedLineRefunds = { ...unsupportedReadiness.components.recognizedLineRefunds,
  venueId: ids.venue, currency: 'RUB', period: { from: '2026-10-01', to: '2026-10-31' } };
unsupportedBundle.recognizedLineProjection = { ...unsupportedBundle.recognizedLineProjection,
  projectionWatermark: null, sourceStatus: unsupportedProjection.sourceStatus, sourceReasons: unsupportedProjection.sourceReasons,
  saleLines: unsupportedProjection.saleLines, refundAdjustments: unsupportedProjection.refundAdjustments };
unsupportedBundle.inputWatermark = fingerprint(Object.fromEntries(Object.entries(unsupportedBundle).filter(([key]) => key !== 'inputWatermark')));
const unsupportedGate = buildPayrollCalculationInputContract({ venueId: ids.venue, scheme: { ...args.scheme, sourcePolicies: unsupportedPolicies },
  period: { from: '2026-10-01', to: '2026-10-31' }, readiness: unsupportedReadiness, sourceBundle: unsupportedBundle });
assert.ok(!unsupportedGate.reasons.includes('payroll_calculation_recognized_line_projection_content_mismatch'),
  'an unsupported policy with no projection watermark keeps the true readiness reason without a false mismatch');

console.log('PASS payroll-sourced-preview-contract');
