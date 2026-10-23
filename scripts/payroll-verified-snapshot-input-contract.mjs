import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
const require = createRequire(import.meta.url);
const { buildPayrollRunProvenance } = require('../payroll-run-provenance.js');
const { persistPayrollSnapshotBundleInTransaction } = require('../payroll-snapshot-persistence.js');
const { buildPayrollVerifiedCalculation } = require('../payroll-verified-calculation.js');
const { buildPayrollVerifiedSnapshotInput } = require('../payroll-verified-snapshot-input.js');
const { buildPayrollRecognitionPreview } = require('../payroll-recognition-preview.js');
const { buildPayrollFullEmployeeNetRevenueSource } = require('../payroll-full-employee-net-revenue-source.js');
const { buildPayrollOrderRevenueReconciliation } = require('../payroll-order-revenue-reconciliation.js');
const { buildPayrollPersonalRevenueSource } = require('../payroll-personal-revenue-source.js');
const { eligibilityPayloadSha256, eligibilitySourceWatermark, buildEligibleEmployees } = require('../payroll-employment-eligibility.js');
const { buildPayrollCalculatorSales } = require('../payroll-team-fund-source.js');

const stable = value => Array.isArray(value) ? `[${value.map(stable).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`
    : JSON.stringify(value);
const digest = value => createHash('sha256').update(stable(value)).digest('hex');
const venueId = '11111111-1111-4111-8111-111111111111';
const employeeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const orderId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const snapshotId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const saleEventId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const saleLineId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const orderItemId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const period = { from: '2026-10-11', to: '2026-10-31', timezone: 'UTC' };
const policies = { schemaVersion: 1, selectionReason: 'Owner selected immutable sale and event-date refund facts.',
  saleCredit: { kind: 'line_seller_snapshot' }, discountAllocation: { kind: 'immutable_line_snapshot' },
  refunds: { recognition: 'recognized_event_date', closedRunTreatment: 'next_open_run_adjustment', paidAdjustment: 'owner_review_variable_pay_only',
    uncoveredBalance: 'carry_forward_review', clawback: 'no_automatic_clawback' } };
const roleAssignment = { employeeId, roleId: 'bar', effectiveFrom: period.from, effectiveTo: null };
const scheme = { id: '22222222-2222-4222-8222-222222222222', versionId: '33333333-3333-4333-8333-333333333333',
  currency: 'RUB', mode: 'stable_percent', sourcePolicies: policies, roleAssignments: [roleAssignment],
  roleParameters: { bar: { perShiftCents: 0, stableRateBps: 1000 } },
  payoutRiskAcknowledgement: { confirmed: true, policyCode: 'payroll-own-revenue-ceiling-v1', configDigest: 'a'.repeat(64),
    acknowledgedBy: 'owner', acknowledgedAt: '2026-10-01T00:00:00.000Z' }, payoutRiskAcknowledgementCurrent: true };

const manifest = { schemaVersion: 1, status: 'available', officialReady: false, venueId, currency: 'RUB',
  period: { from: period.from, to: period.to }, watermark: digest({ fixture: 'verified-no-refund-sale' }), reasons: [],
  sales: [{ eventId: saleEventId, venueId, orderId, snapshotId, currency: 'RUB', recognizedLocalDate: '2026-10-11',
    sourceClosedAt: '2026-10-11T10:00:00.000000Z', coverageStatus: 'complete', lines: [{ saleEventId, orderId, venueId, netMinor: 10000 }] }],
  closedOrderSales: [{ eventId: saleEventId, venueId, orderId, snapshotId, currency: 'RUB', recognizedLocalDate: '2026-10-11',
    sourceClosedAt: '2026-10-11T10:00:00.000000Z', coverageStatus: 'complete', lines: [{ saleEventId, orderId, venueId, netMinor: 10000 }] }],
  saleEvents: [], saleLines: [{ saleLineEventId: saleLineId, saleEventId, venueId, orderId, snapshotId, orderItemId,
    sellerId: employeeId, eligibilityStatus: 'same_venue', eligibilityVenueId: venueId, employeeVenueId: venueId,
    recognizedAt: '2026-10-11T20:10:00.000000Z', recognizedLocalDate: '2026-10-11', timezoneSnapshot: 'UTC',
    soldAt: '2026-10-10T23:55:00.000000Z', grossMinor: 10000, discountMinor: 0, netMinor: 10000,
    quantity: '1.000', productFacts: { productId: orderItemId, productName: 'Тестовый товар' } }], refundEvents: [], refundHistory: [], refundOriginalSaleAttributions: [],
  relatedRefundCoverage: { schemaVersion: 1, status: 'complete',
    scope: 'all_recorded_refunds_for_payroll_related_orders_as_of_repeatable_read_snapshot', sourceWatermark: null,
    periodSaleOrderIds: [orderId], coveredOrderIds: [orderId], relatedRefundHeaderIds: [], relatedRefundEventIds: [],
    relatedRefundItemIds: [], relatedRefundLineEventIds: [] } };
manifest.relatedRefundCoverage.sourceWatermark = manifest.watermark;
const projection = buildPayrollRecognitionPreview(manifest, policies);
assert.equal(projection.sourceStatus, 'available');
const fullNet = buildPayrollFullEmployeeNetRevenueSource(manifest, policies);
assert.equal(fullNet.status, 'available');
const eligibilityFacts = [{ employeeId, effectiveFrom: period.from, effectiveTo: '2026-10-20' },
  { employeeId, effectiveFrom: '2026-10-21', effectiveTo: null }];
const eligibilityPeriods = eligibilityFacts.map(row => ({ ...row, employeeName: 'QA employee' }));
const revision = { id: '44444444-4444-4444-8444-444444444444', revisionNo: 1, reason: 'Owner confirmed eligible roster',
  idempotency_key: 'verified-calculation-contract', payload_sha256: eligibilityPayloadSha256(eligibilityFacts, 'Owner confirmed eligible roster'),
  periodCount: eligibilityFacts.length, created_by: '55555555-5555-4555-8555-555555555555', created_by_name: 'Owner QA', created_at: '2026-10-01 00:00:00+00' };
revision.sourceWatermark = eligibilitySourceWatermark(venueId, revision, eligibilityPeriods);
const readinessComponents = {
  sourcePolicies: { status: 'available', reasons: [] },
  employeeEligibility: { status: 'available', reasons: [], sourceWatermark: revision.sourceWatermark,
    watermarkScope: 'owner_attested_payroll_employment_eligibility_revision', revisionId: revision.id, revisionNo: 1, periodCount: eligibilityFacts.length },
  approvedAttendance: { status: 'available', reasons: [], sourceWatermark: 'a'.repeat(64), watermarkScope: 'owner_approved_attendance_snapshot' },
  canonicalLinePricing: { status: 'available', reasons: [], sourceWatermark: 'b'.repeat(64), watermarkScope: 'canonical_line_pricing' },
  payrollSaleCredit: { status: 'available', reasons: [], sourceWatermark: 'c'.repeat(64), watermarkScope: 'payroll_sale_credit' },
  recognitionManifest: { status: 'available', reasons: [], sourceWatermark: manifest.watermark, watermarkScope: 'payroll_recognition_manifest' },
  recognizedLineRefunds: { status: 'available', reasons: [], sourceWatermark: projection.projectionWatermark,
    watermarkScope: 'immutable_recognized_sale_and_refund_candidate_projection' },
  fullEmployeeNetRevenue: { status: fullNet.status, reasons: fullNet.reasons, sourceWatermark: fullNet.sourceWatermark,
    watermarkScope: fullNet.watermarkScope },
  employeeRoleCoverage: { status: 'available', reasons: [], sourceWatermark: 'd'.repeat(64), watermarkScope: 'owner_attested_employee_role_coverage' }
};
for (const fact of ['employeeEligibility', 'approvedAttendance', 'canonicalLinePricing', 'payrollSaleCredit', 'recognitionManifest',
  'recognizedLineRefunds', 'fullEmployeeNetRevenue', 'employeeRoleCoverage']) {
  readinessComponents[fact] = { ...readinessComponents[fact], venueId, currency: 'RUB', period: { from: period.from, to: period.to } };
}
const readiness = { schemaVersion: 1, versionId: scheme.versionId, period, components: readinessComponents };
const reconciliation = buildPayrollOrderRevenueReconciliation({ venueId, currency: 'RUB', period,
  venueTimezone: period.timezone, orders: [{ orderId, closedAt: '2026-10-11T10:00:00.000000Z',
    canonicalPricing: { valid: true, subtotalMinor: '10000', discountMinor: '0', minimumAdjustmentMinor: '0', finalTotalMinor: '10000' } }],
  recognitionManifest: manifest });
const personalRevenue = buildPayrollPersonalRevenueSource({ venueId, currency: 'RUB', period,
  recognitionManifest: manifest, sourcePolicies: policies, fullEmployeeNetRevenue: fullNet,
  orderRevenueReconciliation: reconciliation });
assert.equal(personalRevenue.status, 'available');
const calculatorSales = buildPayrollCalculatorSales({ currency: 'RUB', recognitionManifest: manifest, recognitionProjection: projection });
const calculatorInput = { periodFrom: period.from, periodTo: period.to, employmentEligibilityRevisionId: revision.id,
  employees: buildEligibleEmployees(eligibilityFacts, period.from, period.to), roleAssignments: [roleAssignment], attendance: [], sales: calculatorSales,
  coverage: { kind: 'month_to_date_complete', from: '2026-10-01', through: period.to, complete: true, watermark: 'e'.repeat(64) },
  attendanceCoverage: { kind: 'approved_attendance_complete', from: '2026-10-01', through: period.to, complete: true,
    watermark: readinessComponents.approvedAttendance.sourceWatermark }, personalRevenueSource: personalRevenue };
const components = Object.fromEntries(Object.entries(readinessComponents).filter(([key]) => key !== 'sourcePolicies')
  .map(([key, value]) => [key, structuredClone(value)]));
const sourceBundle = { schemaVersion: 1, venueId, schemeVersionId: scheme.versionId, currency: 'RUB',
  period: { from: period.from, to: period.to }, readinessWatermark: digest(readiness.components), components,
  recognitionManifest: manifest,
  recognizedLineProjection: { schemaVersion: 1, venueId, currency: 'RUB', period: { from: period.from, to: period.to },
    sourceWatermark: manifest.watermark, projectionWatermark: projection.projectionWatermark, sourceStatus: projection.sourceStatus,
    sourceReasons: projection.sourceReasons, saleLines: projection.saleLines, refundAdjustments: projection.refundAdjustments },
  fullEmployeeNetRevenue: fullNet, orderRevenueReconciliation: reconciliation,
  employmentEligibility: { revision, periods: eligibilityPeriods },
  venueDailyTurnover: { from: '2026-10-01', through: period.to, venueTimezone: period.timezone,
    amountBasis: 'finance_recognized_closed_order_total_pre_refund', refundsIncluded: false,
    sourceWatermark: 'f'.repeat(64), venueDailyTurnover: Array.from({ length: 31 }, (_, index) => ({
      date: `2026-10-${String(index + 1).padStart(2, '0')}`, turnoverCents: index === 4 ? 50000 : index === 10 ? 10000 : 0 })) },
  calculatorInput: { ...calculatorInput } };
sourceBundle.components.venueDailyTurnover = { status: 'available', reasons: [], sourceWatermark: 'f'.repeat(64),
  watermarkScope: 'owner_closed_order_turnover_pre_refund', venueId, currency: 'RUB', period: { from: period.from, to: period.to } };
sourceBundle.calculatorInput.venueDailyTurnover = sourceBundle.venueDailyTurnover.venueDailyTurnover;
sourceBundle.calculatorInput.venueDailyTurnoverCoverage = { from: '2026-10-01', through: period.to, complete: true,
  venueId, currency: 'RUB', period: { from: period.from, to: period.to }, venueTimezone: period.timezone,
  sourceWatermark: 'f'.repeat(64), watermarkScope: 'owner_closed_order_turnover_pre_refund', refundsIncluded: false,
  amountBasis: 'finance_recognized_closed_order_total_pre_refund' };
readinessComponents.venueDailyTurnover = { ...sourceBundle.components.venueDailyTurnover };
sourceBundle.readinessWatermark = digest(readiness.components);
sourceBundle.inputWatermark = digest(sourceBundle);
const periodClosure = { schemaVersion: 1, venueId, period: { from: period.from, to: period.to },
  transactionTimestamp: '2026-11-01T02:00:00.000Z', venueLocalDate: '2026-11-01', timezone: period.timezone };

const calculated = buildPayrollVerifiedCalculation({ venueId, scheme, period, readiness, sourceBundle, periodClosure });
assert.equal(calculated.status, 'verified_calculation', calculated.reasons.join(', '));
assert.equal(calculated.officialReady, false);
assert.equal(calculated.payoutEligible, false);
assert.equal(calculated.persistence, 'none');
assert.equal(calculated.engineResult.status, 'ready', 'the wage engine ran on verified server-owned input');
assert.equal(calculated.amountCents, 1000, '10 percent is calculated by the wage engine on the recognized clean line net');
assert.equal(Object.isFrozen(calculated), true);
assert.equal(Object.isFrozen(calculated.input), true);
assert.equal(Object.isFrozen(calculated.engineResult.employees), true);
assert.equal(calculated.inputWatermark, sourceBundle.inputWatermark);
assert.equal(calculated.closureWatermark.length, 64);
assert.equal(calculated.calculationWatermark.length, 64);
assert.throws(() => { calculated.engineResult.mode = 'forged'; }, TypeError, 'returned result is immutable');

const snapshot = buildPayrollVerifiedSnapshotInput({ venueId, runId: '77777777-7777-4777-8777-777777777777',
  venueTimezone: period.timezone, scheme, period, readiness, sourceBundle, periodClosure });
assert.equal(snapshot.status, 'verified_snapshot_input', snapshot.reasons.join(', '));
assert.equal(snapshot.officialReady, false);
assert.equal(snapshot.payoutEligible, false);
assert.equal(snapshot.persistence, 'none');
assert.equal(snapshot.snapshotInput.sourceLines[0].recognizedLocalDate, '2026-10-11');
assert.equal(snapshot.snapshotInput.result.periodFrom, '2026-10-11', 'partial-period DTO follows the engine result window');
assert.equal(snapshot.snapshotInput.result.daily.length, 21, 'partial-period calculation contains only requested days');
assert.equal(snapshot.snapshotInput.result.daily[0].cumulativeVenueTurnoverCents, 60000,
  'partial-period cumulative turnover includes the separate October 5 MTD turnover input');
assert.equal(snapshot.snapshotInput.sourceLines[0].soldAt, '2026-10-10T23:55:00.000000Z', 'overnight sale retains its actual sale timestamp');
assert.equal(snapshot.mappedRows.snapshotLines[0].sold_at, '2026-10-10T23:55:00.000000Z');
assert.equal(snapshot.mappedRows.snapshotLines[0].local_date, '2026-10-11');
assert.equal(Object.isFrozen(snapshot.mappedRows.snapshotLines[0]), true);

const provenanceArgs = { venueId, runId: '77777777-7777-4777-8777-777777777777',
  venueTimezone: period.timezone, scheme, period, readiness, sourceBundle, periodClosure };
const provenance = buildPayrollRunProvenance(provenanceArgs);
assert.equal(provenance.status, 'verified_run_evidence');
assert.equal(provenance.engineVersion, 'payroll-verified-no-refund-v1');
assert.equal(provenance.payoutEligible, false);
assert.equal(provenance.provenance.evidence_sha256,
  createHash('sha256').update(provenance.provenance.evidence_payload).digest('hex'));
const storedEvidence = JSON.parse(provenance.provenance.evidence_payload);
assert.equal(storedEvidence.totalAmountCents, calculated.amountCents);
assert.deepEqual(storedEvidence.periodClosure, periodClosure);
assert.deepEqual(storedEvidence.schemeSnapshot, JSON.parse(JSON.stringify(calculated.input.scheme)));
const { executeCalculatorReplay } = require('../payroll-calculator-replay');
assert.deepEqual(storedEvidence.calculatorReplay.input, JSON.parse(JSON.stringify(calculated.input)));
assert.deepEqual(storedEvidence.calculatorReplay.result, JSON.parse(JSON.stringify(calculated.engineResult)));
assert.equal(executeCalculatorReplay(storedEvidence.calculatorReplay).status, 'matched',
  'serialized provenance alone can replay the full result without the original source bundle');
assert.equal(storedEvidence.snapshotInputWatermark, snapshot.snapshotInputWatermark);
assert.equal(buildPayrollRunProvenance(provenanceArgs).provenance.evidence_payload, provenance.provenance.evidence_payload,
  'same source, closure and run identity produce identical canonical evidence');
assert.equal(Object.isFrozen(provenance.provenance), true);

// Pure wiring proof: genuine evidence-builder output enters the real storage
// primitive unchanged. The source fixture and DB are substitutes; this proves
// neither owner/source authorization nor PostgreSQL constraint behavior.
const prepared = provenance.prepared;
const storageInput = prepared.snapshotInput;
const storageRun = {
  id: storageInput.runId, venue_id: storageInput.venueId, scheme_version_id: storedEvidence.schemeVersionId,
  period_from: storedEvidence.period.from, period_to: storedEvidence.period.to,
  status: 'ready', source_coverage: 'complete', commission_basis: 'net_after_discounts_refunds',
  eligible_line_count: prepared.mappedRows.snapshotLines.length, unattributed_line_count: 0, missing_net_line_count: 0,
  input_watermark: storedEvidence.inputWatermark, input_checksum: provenance.provenance.evidence_sha256,
  engine_version: provenance.engineVersion, idempotency_key: 'pure-verified-provenance-wiring',
  created_by: revision.created_by, created_by_name: revision.created_by_name,
  venue_timezone: storageInput.venueTimezone, currency: storedEvidence.currency,
  milestone_evidence_version: prepared.milestoneRows.milestoneEvidenceVersion
};
const storageBundle = { run: storageRun, input: storageInput, provenance: provenance.provenance };
const beforeStorage = structuredClone(storageBundle);
const storedRows = [], storageCalls = [];
let savepointActive = false;
const constraintGroups = {
  typed_totals: ['payroll_daily_snapshots', 'payroll_daily_snapshot_lines', 'payroll_team_fund_snapshots', 'payroll_team_fund_snapshot_allocations'],
  milestone_totals: ['payroll_calculation_runs', 'payroll_daily_snapshots', 'payroll_milestone_day_snapshots', 'payroll_milestone_decision_snapshots'],
  provenance_commit: ['payroll_calculation_runs', 'payroll_run_provenance', 'payroll_daily_snapshots']
};
const constraintRows = Object.entries(constraintGroups).flatMap(([suffix, tables]) =>
  tables.map(table => ({ table_name: table, constraint_name: `${table}_${suffix}`, schema_name: 'pure_wiring' })));
const allowedTables = new Set(constraintRows.map(row => row.table_name));
const fakeStorageDb = { async query(sql, values = []) {
  storageCalls.push(sql);
  assert.doesNotMatch(sql, /\b(?:BEGIN|COMMIT|UPDATE|DELETE|TRUNCATE|payroll_entries|expenses)\b/i,
    'the private snapshot writer cannot take over the transaction or write financial ledgers');
  assert.doesNotMatch(sql, /SET\s+CONSTRAINTS\s+ALL/i);
  if (/^SAVEPOINT /.test(sql)) {
    assert.equal(savepointActive, false); savepointActive = true;
    return { rows: [], rowCount: 0 };
  }
  assert.equal(savepointActive, true, 'all storage work follows the savepoint');
  if (sql.includes('pg_trigger')) return { rows: constraintRows, rowCount: constraintRows.length };
  if (/^SET CONSTRAINTS /.test(sql)) {
    for (const row of constraintRows) assert.ok(sql.includes(`"pure_wiring"."${row.constraint_name}"`));
    return { rows: [], rowCount: 0 };
  }
  if (/^RELEASE SAVEPOINT /.test(sql)) {
    savepointActive = false;
    return { rows: [], rowCount: 0 };
  }
  const insert = sql.match(/^INSERT INTO ([a-z_]+) \(([^)]+)\) VALUES \(([^)]+)\) RETURNING (id|run_id)$/);
  assert.ok(insert, `expected a parameterized snapshot insert: ${sql}`);
  assert.ok(allowedTables.has(insert[1]), `unexpected storage table: ${insert[1]}`);
  const columns = insert[2].split(',');
  assert.equal(columns.length, values.length);
  assert.equal(insert[3], values.map((_, index) => `$${index + 1}`).join(','));
  const row = Object.fromEntries(columns.map((column, index) => [column, values[index]]));
  storedRows.push({ table: insert[1], row });
  return { rows: [{ [insert[4]]: row[insert[4]] }], rowCount: 1 };
} };
const persisted = await persistPayrollSnapshotBundleInTransaction(fakeStorageDb, storageBundle);
assert.equal(persisted.runId, storageInput.runId);
assert.deepEqual(storageBundle, beforeStorage, 'persistence accepts and does not mutate genuine frozen prepared evidence');
const rowsFor = table => storedRows.filter(record => record.table === table).map(record => record.row);
assert.equal(rowsFor('payroll_calculation_runs').length, 1);
assert.deepEqual(rowsFor('payroll_calculation_runs')[0], { ...storageRun, blocked_reason: null });
assert.deepEqual(rowsFor('payroll_run_provenance'), [provenance.provenance],
  'the exact builder sidecar is inserted without synthesizing or replacing its checksum');
assert.equal(persisted.counts.payroll_run_provenance, 1);
assert.equal(rowsFor('payroll_daily_snapshots').length, prepared.mappedRows.dailySnapshots.length);
assert.equal(rowsFor('payroll_daily_snapshot_lines').length, prepared.mappedRows.snapshotLines.length);
assert.equal(rowsFor('payroll_daily_snapshot_lines').length, 1, 'fixture has one actual recognized sale line');
const persistedLine = rowsFor('payroll_daily_snapshot_lines')[0];
const persistedDay = rowsFor('payroll_daily_snapshots').find(row => row.id === persistedLine.snapshot_id);
assert.ok(persistedDay, 'stored line points to its inserted employee/day snapshot');
assert.equal(persistedDay.employee_id, employeeId);
assert.equal(persistedDay.local_date, '2026-10-11');
assert.equal(persistedDay.final_amount, '10.00');
assert.equal(persistedLine.order_id, orderId);
assert.equal(persistedLine.order_item_id, orderItemId);
assert.equal(persistedLine.sold_at, '2026-10-10T23:55:00.000000Z');
assert.equal(persistedLine.local_date, '2026-10-11', 'overnight recognition survives the full storage mapping');
assert.equal(persistedLine.commission_base_net, '100.00');
assert.equal(persistedLine.commission_amount, '10.00');
for (const record of storedRows) {
  assert.equal(record.row.venue_id, storageRun.venue_id);
  if (record.table !== 'payroll_calculation_runs') assert.equal(record.row.run_id, storageRun.id);
}
assert.equal(savepointActive, false);
assert.match(storageCalls.at(-1), /^RELEASE SAVEPOINT /);
assert.ok(storageCalls.findIndex(sql => /^SET CONSTRAINTS .* IMMEDIATE$/.test(sql))
  > storageCalls.findLastIndex(sql => /^INSERT INTO /.test(sql)), 'all rows precede deferred-constraint flush');
const callCountBeforeTampering = storageCalls.length;
const alteredChecksum = structuredClone(storageBundle);
alteredChecksum.run.input_checksum = '0'.repeat(64);
await assert.rejects(() => persistPayrollSnapshotBundleInTransaction(fakeStorageDb, alteredChecksum),
  error => error.code === 'payroll_snapshot_persistence_provenance_checksum_mismatch');
assert.equal(storageCalls.length, callCountBeforeTampering, 'a mismatched genuine evidence checksum fails before any SQL');
const alteredReplay = structuredClone(storageBundle);
const replayEvidence = JSON.parse(alteredReplay.provenance.evidence_payload);
replayEvidence.calculatorReplay.input.sales[0].commissionBaseCents++;
alteredReplay.provenance.evidence_payload = JSON.stringify(replayEvidence);
alteredReplay.run.input_checksum = alteredReplay.provenance.evidence_sha256 = createHash('sha256')
  .update(alteredReplay.provenance.evidence_payload).digest('hex');
await assert.rejects(() => persistPayrollSnapshotBundleInTransaction(fakeStorageDb, alteredReplay),
  error => error.code === 'payroll_calculator_replay_checksum_mismatch');
assert.equal(storageCalls.length, callCountBeforeTampering, 'rehashed outer payload cannot conceal a changed replay input');

const forgedRecognition = structuredClone(sourceBundle);
forgedRecognition.recognitionManifest.saleLines[0].recognizedLocalDate = '2026-10-12';
forgedRecognition.inputWatermark = digest(Object.fromEntries(Object.entries(forgedRecognition).filter(([key]) => key !== 'inputWatermark')));
const rejectedRecognition = buildPayrollVerifiedSnapshotInput({ venueId, runId: '77777777-7777-4777-8777-777777777777',
  venueTimezone: period.timezone, scheme, period, readiness, sourceBundle: forgedRecognition, periodClosure });
assert.equal(rejectedRecognition.status, 'blocked');
assert.ok(rejectedRecognition.reasons.length > 0, JSON.stringify(rejectedRecognition));
const rejectedProvenance = buildPayrollRunProvenance({ ...provenanceArgs, sourceBundle: forgedRecognition });
assert.equal(rejectedProvenance.status, 'blocked');
assert.equal(rejectedProvenance.provenance, null, 'invalid sources cannot produce a checksum-bearing run record');

const missingRefundHistory = structuredClone(sourceBundle);
missingRefundHistory.recognitionManifest.relatedRefundCoverage.relatedRefundHeaderIds = ['66666666-6666-4666-8666-666666666666'];
missingRefundHistory.inputWatermark = digest(Object.fromEntries(Object.entries(missingRefundHistory).filter(([key]) => key !== 'inputWatermark')));
const blockedSource = buildPayrollVerifiedCalculation({ venueId, scheme, period, readiness, sourceBundle: missingRefundHistory, periodClosure });
assert.equal(blockedSource.status, 'blocked');
assert.equal(blockedSource.engineResult, null);
assert.equal(blockedSource.input, null);
assert.ok(blockedSource.reasons.includes('payroll_official_no_refund_coverage_not_proven'));

const openPeriod = buildPayrollVerifiedCalculation({ venueId, scheme, period, readiness, sourceBundle,
  periodClosure: { ...periodClosure, venueLocalDate: period.to } });
assert.equal(openPeriod.status, 'blocked');
assert.equal(openPeriod.engineResult, null);
assert.ok(openPeriod.reasons.includes('payroll_calculation_period_not_closed'));
sourceBundle.calculatorInput.sales.push({ id: '99999999-9999-4999-8999-999999999999' });
assert.equal(calculated.input.sales.length, 1, 'returned verified input is detached from its mutable source bundle');
console.log('PASS payroll-verified-snapshot-input-contract (real provenance-to-storage mapping; fake DB, not owner-source or PostgreSQL proof)');
