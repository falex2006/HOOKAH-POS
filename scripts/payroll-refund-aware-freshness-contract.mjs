// Actual saved reader, provenance, calculation and freshness dispatcher.
// Current-source transport is an explicit module callback seam; no PostgreSQL.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { makePayrollRefundAwareFixture, payrollRefundAwareModes } from './payroll-refund-aware-calculation-contract.mjs';
const require = createRequire(import.meta.url);
const { buildPayrollRefundAwareRunProvenance } = require('../payroll-refund-aware-provenance');
const { checkPayrollRunSourceFreshnessInTransaction: inspect } = require('../payroll-run-source-freshness');
const { beginPayrollVerifiedReadSourceTransaction: begin, hasPayrollVerifiedSourceSnapshot: hasRead,
  hasPayrollVerifiedWriteSnapshot: hasWrite } = require('../payroll-source-fence');
const { eligibilityPayloadSha256, eligibilitySourceWatermark } = require('../payroll-employment-eligibility');
const { mappingPayloadSha256 } = require('../payroll-product-department-source');
const id = n => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;
const runId = id(999), clone = value => structuredClone(value);
let checks = 0;
const eq = (a, b, label) => { assert.deepEqual(a, b, label); checks++; };
const check = (value, label) => { assert.ok(value, label); checks++; };
const decimal = cents => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
function saved(mode, opts = { noRefunds: true }) {
  const args = { ...makePayrollRefundAwareFixture(mode, opts), runId };
  const built = buildPayrollRefundAwareRunProvenance(args);
  eq(built.status, 'verified_run_evidence');
  const e = JSON.parse(built.provenance.evidence_payload), p = built.provenance;
  return { args, evidence: e, row: { id: runId, venue_id: args.venueId, scheme_version_id: args.scheme.versionId,
    period_from: args.period.from, period_to: args.period.to, status: 'ready', source_coverage: 'complete',
    commission_basis: 'net_after_discounts_refunds', unattributed_line_count: 0, missing_net_line_count: 0,
    eligible_line_count: built.prepared.mappedRows.snapshotLines.length, input_watermark: e.inputWatermark,
    input_checksum: p.evidence_sha256, engine_version: built.engineVersion, blocked_reason: null,
    created_by_name: 'Frozen owner', created_at: '2026-11-06T00:00:00.000000Z', venue_timezone: e.venueTimezone, currency: e.currency,
    provenance_schema_version: 2, capability_version: e.capabilityVersion, evidence_payload: p.evidence_payload,
    evidence_sha256: p.evidence_sha256, total_amount_cents: String(p.total_amount_cents), snapshot_total: decimal(p.total_amount_cents),
    snapshot_line_count: String(built.prepared.mappedRows.snapshotLines.length) } };
}
async function run(f, currentArgs, { blockedContext, collectorError, omitCollector = false, actorVenue, onCollect } = {}) {
  const venueId = f.args.venueId, actor = { venueId: actorVenue || venueId, userId: id(451), name: 'Current owner' };
  const calls = [], frozen = clone(f), before = clone(currentArgs);
  let collected = 0;
  const db = { async query(sql, values = []) {
    const text = sql.replace(/\s+/g, ' ').trim(); calls.push({ text, values });
    assert.doesNotMatch(text, /^(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|CREATE)\b/);
    if (text.startsWith('SELECT pg_advisory_unlock')) return { rows: [{ unlocked: true }] };
    if (text.startsWith('SELECT pg_advisory_lock') || text === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'
      || text === 'ROLLBACK') return { rows: [] };
    if (text.startsWith('SELECT r.id,r.venue_id,r.scheme_version_id')) {
      eq(values, [actor.venueId, runId, ['payroll-verified-no-refund-v1', 'payroll-verified-remaining-net-v2']]);
      return { rows: [clone(f.row)] };
    }
    if (text === 'SELECT transaction_timestamp()::text AS "checkedAt"') return { rows: [{ checkedAt: '2026-11-08 00:00:00+00' }] };
    assert.fail(`unexpected SQL: ${text}`);
  } };
  const collector = async (client, receivedActor, scheme, period) => {
    collected++;
    eq(client, db); eq(receivedActor, actor);
    eq(scheme, f.evidence.schemeSnapshot, 'collect against exact saved scheme, never current mutable version');
    eq(period, f.evidence.period);
    check(scheme !== f.args.scheme && period !== f.args.period, 'frozen context cloned');
    eq(hasRead(db, venueId), true); eq(hasWrite(db, venueId), false);
    if (onCollect) onCollect({ scheme, period });
    if (collectorError) throw collectorError;
    return blockedContext || { status: 'source_arguments_collected', sourceArgs: { ...clone(currentArgs), scheme, period } };
  };
  const release = await begin(db, venueId);
  try {
    const result = await inspect(db, actor, runId, () => assert.fail('v2 must not dispatch legacy collector'), omitCollector ? undefined : collector);
    eq(f, frozen, 'saved evidence never rewritten'); eq(currentArgs, before, 'current source arguments never mutated');
    eq(collected, 1); eq(result.schemaVersion, 1); eq(result.runId, runId);
    eq([result.officialReady, result.payoutEligible, result.persistence], [false, false, 'none']);
    eq(result.validity, 'transaction_snapshot_only');
    for (const key of ['sourceBundle', 'calculatorReplay', 'refundQuantityEvidence', 'input', 'engineResult', 'amountCents'])
      eq(Object.hasOwn(result, key), false, `private ${key} absent`);
    return { result, calls };
  } finally {
    await db.query('ROLLBACK'); await release();
    eq(hasRead(db, venueId), false); eq(hasWrite(db, venueId), false);
    eq(calls.filter(c => c.text.startsWith('BEGIN')).map(c => c.text), ['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY']);
  }
}
for (const mode of payrollRefundAwareModes) {
  const f = saved(mode), same = makePayrollRefundAwareFixture(mode, { noRefunds: true });
  // A new transaction date is not an economic source change.
  same.periodClosure.transactionTimestamp = '2026-11-07T00:00:00.000Z'; same.periodClosure.venueLocalDate = '2026-11-07';
  const current = (await run(f, same)).result;
  eq([current.status, current.sourceChanged, current.changedFacts, current.reasons], ['current', false, [], []]);
  eq(current.checkedAt, same.periodClosure.transactionTimestamp);
  const afterLateReturn = (await run(f, makePayrollRefundAwareFixture(mode))).result;
  eq(afterLateReturn.status, 'stale'); eq(afterLateReturn.sourceChanged, true);
  check(afterLateReturn.changedFacts.includes('remainingMerchandise'));
  check(afterLateReturn.reasons.includes('payroll_saved_run_source_changed'));
  const partial = saved(mode, {}), full = (await run(partial, makePayrollRefundAwareFixture(mode, { fullReturn: true }))).result;
  eq(full.status, 'stale'); eq(full.sourceChanged, true);
  const missing = makePayrollRefundAwareFixture(mode); missing.employmentEligibility = null;
  const blocked = (await run(f, missing)).result;
  eq(blocked.status, 'blocked'); eq(blocked.sourceChanged, null); eq(blocked.changedFacts, []);
  check(blocked.reasons.length > 0);
  const absentSource = (await run(f, null, { blockedContext: { status: 'blocked', reasons: ['missing_source', 'missing_source', '<private payload>'] } })).result;
  eq(absentSource.status, 'blocked'); eq(absentSource.reasons, ['missing_source']);
  eq(absentSource.checkedAt, '2026-11-08 00:00:00+00', 'missing source closure uses current DB timestamp');
}
{
  const f = saved('stable_percent'), args = makePayrollRefundAwareFixture('stable_percent', { noRefunds: true });
  args.approvedAttendanceSource.attendanceCoverage.watermark = 'c'.repeat(64);
  args.approvedAttendanceSource.sourceAttendanceApproval.sourceWatermark = 'c'.repeat(64);
  args.approvedAttendanceSource.sourceAttendanceApproval.revision++;
  const r = (await run(f, args)).result;
  eq(r.status, 'stale'); check(r.changedFacts.includes('approvedAttendance'));
  args.approvedAttendanceSource = null;
  eq((await run(f, args)).result.status, 'blocked');
}
{
  const f = saved('percent_only'), args = makePayrollRefundAwareFixture('percent_only', { noRefunds: true });
  const source = args.employmentEligibility;
  source.revision.reason += ' reviewed';
  source.revision.payload_sha256 = eligibilityPayloadSha256(source.periods.map(({ employeeId, effectiveFrom, effectiveTo }) =>
    ({ employeeId, effectiveFrom, effectiveTo })), source.revision.reason);
  source.revision.sourceWatermark = eligibilitySourceWatermark(args.venueId, source.revision, source.periods);
  source.component.sourceWatermark = source.revision.sourceWatermark;
  const r = (await run(f, args)).result; eq(r.status, 'stale'); check(r.changedFacts.includes('employmentEligibility'));
}
{
  const f = saved('team_fund'), args = makePayrollRefundAwareFixture('team_fund', { noRefunds: true });
  args.departmentMapping.mappings[0].departmentName = 'Updated frozen department label';
  args.departmentMapping.revision.payloadSha256 = mappingPayloadSha256(args.departmentMapping.mappings);
  const r = (await run(f, args)).result; eq(r.status, 'stale'); check(r.changedFacts.includes('department'));
  args.departmentMapping = null; eq((await run(f, args)).result.status, 'blocked');
}
{
  const f = saved('margin_target'), args = makePayrollRefundAwareFixture('margin_target', { noRefunds: true });
  args.costEvidenceByOrder[0].allocation.lines[0].totalCostMinor = 0;
  eq((await run(f, args)).result.status, 'blocked', 'invalid frozen costs cannot report current');
}
{
  const f = saved('percent_only'), args = makePayrollRefundAwareFixture('percent_only', { noRefunds: true });
  args.periodClosure.timezone = 'UTC';
  const r = (await run(f, args)).result;
  eq(r.status, 'stale'); check(r.reasons.includes('payroll_saved_run_timezone_changed'));
  await assert.rejects(run(f, args, { omitCollector: true }), /source_collector_required/); checks++;
  const error = new Error('collector SQL failure');
  await assert.rejects(run(f, args, { collectorError: error }), actual => actual === error); checks++;
  await assert.rejects(run(f, args, { actorVenue: id(888) }), /evidence_invalid/); checks++;
  // The source callback receives a saved clone even if unrelated caller state
  // points at a currently renamed or reconfigured scheme.
  args.scheme.name = 'Mutable current scheme'; args.scheme.roleParameters.bar.stableRateBps = 9999;
  args.periodClosure.timezone = 'Asia/Yekaterinburg';
  const unchanged = (await run(f, args)).result;
  eq(unchanged.status, 'current'); eq(unchanged.sourceChanged, false);
}
console.log(`payroll-refund-aware-freshness-contract: PASS ${checks} checks (all7 actual provenance/source/engine replay, collector seam, private RO capability; no PG)`);
