import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { makePayrollRefundAwareFixture, payrollRefundAwareModes } from './payroll-refund-aware-calculation-contract.mjs';
const require = createRequire(import.meta.url);
const { PayrollSavedRunReadError, listSavedRuns, getSavedRun, getSavedRunEmployee, getSavedRunLines, replaySavedRun } =
  require('../payroll-saved-run-reader');
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const venue = id(1), run = id(2), version = id(3), employee = id(4), snapshot = id(5);
const cap = 'employee_attributed_merchandise_net_no_refund_v1';
function header(overrides = {}) {
  const evidence = { schemaVersion: 1, capabilityVersion: cap, venueId: venue, runId: run, schemeVersionId: version,
    period: { from: '2026-09-01', to: '2026-09-30' }, currency: 'RUB', venueTimezone: 'UTC',
    inputWatermark: 'a'.repeat(64), calculationWatermark: 'b'.repeat(64), snapshotInputWatermark: 'c'.repeat(64),
    closureWatermark: 'd'.repeat(64), sourceEvidence: {}, totalAmountCents: 123,
    schemeSnapshot: { id: id(7), versionId: version, versionNo: 2, name: 'Frozen scheme', currency: 'RUB', mode: 'percent_only' } };
  const evidence_payload = JSON.stringify(evidence), checksum = createHash('sha256').update(evidence_payload).digest('hex');
  return { id: run, venue_id: venue, scheme_version_id: version, period_from: '2026-09-01', period_to: '2026-09-30',
    status: 'ready', source_coverage: 'complete', commission_basis: 'net_after_discounts_refunds',
    unattributed_line_count: 0, missing_net_line_count: 0, eligible_line_count: 1, input_watermark: evidence.inputWatermark,
    input_checksum: checksum, engine_version: 'payroll-verified-no-refund-v1', blocked_reason: null,
    created_by_name: 'Frozen owner', created_at: '2026-10-01T12:00:00.123456Z', venue_timezone: 'UTC', currency: 'RUB',
    provenance_schema_version: 1, capability_version: cap, evidence_payload, evidence_sha256: checksum,
    total_amount_cents: '123', snapshot_total: '1.23', snapshot_line_count: '1', ...overrides };
}
function dbWith(...responses) {
  const calls = [];
  return { calls, async query(sql, values) {
    calls.push({ sql, values });
    assert.match(sql, /^SELECT /);
    assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|JOIN users|JOIN products|JOIN payroll_schemes)\b/i);
    assert.ok(responses.length, `unexpected query ${sql}`);
    const next = responses.shift(); if (typeof next === 'function') return next(sql, values);
    return { rows: structuredClone(next) };
  }, done() { assert.equal(responses.length, 0); } };
}
const rejects = (promise, suffix, status = 400) => assert.rejects(promise,
  error => error instanceof PayrollSavedRunReadError && error.code === `payroll_saved_run_${suffix}` && error.status === status);
const day = () => ({
  id: snapshot, venue_id: venue, run_id: run, employee_id: employee, employee_name_snapshot: 'Frozen employee',
  local_date: '2026-09-01', role_key_snapshot: 'bartender', calculation_kind: 'percent_only', eligible_shift_count: 0,
  venue_turnover: '12.30', cumulative_venue_turnover: '12.30', base_pay: '0.00', commission_pay: '1.23', team_fund_pay: '0.00',
  milestone_bonus: '0.00', item_adjustments: '0.00', amount_before_cap: '1.23', cap_reduction: '0.00', final_amount: '1.23',
  cap_amount: null, incentive_json: {}, explanation_json: { personalRevenueCents: 1230 }
});
const line = () => ({
  id: id(10), venue_id: venue, run_id: run, snapshot_id: snapshot, order_id: id(11), order_item_id: id(12),
  employee_id: employee, employee_name_snapshot: 'Frozen employee', menu_item_id: id(13), menu_item_name_snapshot: 'Frozen product',
  department_key: 'bar', local_date: '2026-09-01', sold_at: '2026-09-01T12:00:00.123456Z', quantity: '1.000',
  gross_amount: '13.00', discount_amount: '0.70', refund_amount: '0.00', commission_base_net: '12.30', applied_rate_bps: 1000,
  item_rule_id: null, commission_amount: '1.23', calculation_kind: 'percent_only', commission_kind: 'scalar',
  incentive_json: { sourceRecognition: { recognizedAt: '2026-09-01T12:00:00.123456Z' } },
  cost_snapshot_json: null, net_cost_amount: null, signed_margin_amount: null,
  team_pool_snapshot_id: null, pool_included: null, pool_basis_amount: null, pool_exclusion_reason: null
});
{
  const db = dbWith([header(), header()]);
  const result = await listSavedRuns(db, venue, { limit: 1 });
  assert.equal(result.items[0].state, 'saved'); assert.equal(result.items[0].scheme.name, 'Frozen scheme');
  assert.equal(result.items[0].amountCents, 123); assert.equal(result.items[0].payoutEligible, false);
  assert.equal(result.items[0].replayAvailable, false);
  assert.equal(JSON.parse(Buffer.from(result.nextCursor, 'base64url')).after[0], '2026-10-01T12:00:00.123456Z');
  const next = dbWith([]);
  await listSavedRuns(next, venue, { cursor: result.nextCursor });
  assert.deepEqual(next.calls[0].values.slice(3, 5), ['2026-10-01T12:00:00.123456Z', run]);
  await rejects(listSavedRuns(dbWith(), id(99), { cursor: result.nextCursor }), 'invalid_cursor');
  await rejects(listSavedRuns(dbWith(), venue, { schemeVersionId: version, cursor: result.nextCursor }), 'invalid_cursor');
  db.done(); next.done();
}
{
  const db = dbWith([header()], [{ employee_id: employee, employee_name: 'Frozen employee', amount: '1.23', day_count: '1' }]);
  const result = await getSavedRun(db, venue, run);
  assert.equal(result.runId, run); assert.equal(result.schemeSnapshot.name, 'Frozen scheme');
  assert.deepEqual(result.employees, [{ employeeId: employee, employeeName: 'Frozen employee', amountCents: 123, dayCount: 1 }]);
  assert.deepEqual(db.calls[0].values, [venue, run, ['payroll-verified-no-refund-v1', 'payroll-verified-remaining-net-v2']]);
  assert.match(db.calls[1].sql, /WHERE venue_id=\$1 AND run_id=\$2/);
  db.done();
}
{
  const db = dbWith([header()], [day()]);
  const result = await getSavedRunEmployee(db, venue, run, employee);
  assert.equal(result.days[0].localDate, '2026-09-01');
  assert.equal(result.amountCents, 123); assert.equal(result.days[0].capCents, null);
  assert.equal(result.days[0].explanation.personalRevenueCents, 1230);
  assert.deepEqual(db.calls[1].values, [venue, run, employee]); db.done();
  await rejects(getSavedRunEmployee(dbWith([header()], []), venue, run, employee), 'employee_not_found', 404);
  await rejects(getSavedRunEmployee(dbWith([header()], [day(), { ...day(), venue_id: id(99) }]), venue, run, employee), 'evidence_invalid', 409);
  await rejects(getSavedRunEmployee(dbWith([header()], Array.from({ length: 32 }, day)), venue, run, employee), 'evidence_invalid', 409);
}
{
  const parent = { id: snapshot, employee_id: employee, local_date: '2026-09-01' };
  const db = dbWith([header()], [parent], [line(), { ...line(), id: id(14) }]);
  const result = await getSavedRunLines(db, venue, run, snapshot, { limit: 1 });
  assert.equal(result.items[0].menuItemName, 'Frozen product'); assert.equal(result.items[0].quantity, '1.000');
  assert.equal(result.items[0].commissionCents, 123); assert.ok(result.nextCursor);
  assert.deepEqual(db.calls[2].values, [venue, run, snapshot, null, 2]); db.done();
  await rejects(getSavedRunLines(dbWith(), venue, run, id(99), { cursor: result.nextCursor }), 'invalid_cursor');
  await rejects(getSavedRunLines(dbWith([header()], []), venue, run, snapshot), 'day_not_found', 404);
  await rejects(getSavedRunLines(dbWith([header()], [parent], [{ ...line(), employee_id: id(99) }]), venue, run, snapshot), 'evidence_invalid', 409);
  const exact = await getSavedRunLines(dbWith([header()], [parent], [{ ...line(), gross_amount: '90071992547409.91' }]), venue, run, snapshot);
  assert.equal(exact.items[0].grossCents, Number.MAX_SAFE_INTEGER);
  await rejects(getSavedRunLines(dbWith([header()], [parent], [{ ...line(), gross_amount: '90071992547409.92' }]), venue, run, snapshot), 'evidence_invalid', 409);
}
for (const patch of [
  { evidence_payload: '{}' }, { input_checksum: '0'.repeat(64) }, { evidence_sha256: '0'.repeat(64) },
  { snapshot_total: '1.24' }, { snapshot_line_count: '2' }, { provenance_schema_version: 2 },
  { venue_id: id(99) }, { total_amount_cents: '9007199254740992' }, { input_watermark: 'x' }
]) await rejects(getSavedRun(dbWith([header(patch)]), venue, run), 'evidence_invalid', 409);
{
  const row = header(), evidence = JSON.parse(row.evidence_payload);
  evidence.period.to = '2026-09-29';
  row.evidence_payload = JSON.stringify(evidence);
  row.input_checksum = row.evidence_sha256 = createHash('sha256').update(row.evidence_payload).digest('hex');
  await rejects(getSavedRun(dbWith([row]), venue, run), 'evidence_invalid', 409);
}
for (const query of [{ limit: 0 }, { limit: 101 }, { limit: '01' }, { limit: null }, { venueId: venue }, { cursor: '' }, []]) {
  await rejects(listSavedRuns(dbWith(), venue, query), query.limit !== undefined ? 'invalid_limit' : Array.isArray(query) || query.venueId ? 'invalid_query' : 'invalid_cursor');
}
await rejects(listSavedRuns(dbWith(), venue, { get schemeVersionId() { throw new Error('getter must never run'); } }), 'invalid_query');
await rejects(getSavedRun(dbWith([]), venue, run), 'not_found', 404);
await rejects(getSavedRun(dbWith(), venue, 'bad'), 'invalid_id');
await rejects(getSavedRun(dbWith(), venue, run, { cursor: Buffer.from(JSON.stringify({ scope: `employees:${venue}:${run}`, after: ['bad'] })).toString('base64url') }), 'invalid_cursor');
{
  const { calculatePayrollScheme } = require('../payroll-schemes');
  const { buildCalculatorReplay } = require('../payroll-calculator-replay');
  const row = header(), evidence = JSON.parse(row.evidence_payload);
  const input = { scheme: { ...evidence.schemeSnapshot, applyMilestones: false, employeeOverrides: [], itemRules: [],
    roleParameters: { bartender: { stableRateBps: 1000 } } }, periodFrom: row.period_from, periodTo: row.period_to,
    employees: [{ id: employee }], roleAssignments: [{ employeeId: employee, roleId: 'bartender', effectiveFrom: row.period_from }],
    sales: [{ id: 'sale', date: row.period_from, employeeId: employee, department: 'bar', turnoverCents: 1230, commissionBaseCents: 1230 }],
    sourceEvidence: {}, coverage: { kind: 'month_to_date_complete', from: row.period_from, through: row.period_to, complete: true, watermark: 'test' } };
  const result = calculatePayrollScheme(input);
  assert.equal(result.status, 'ready'); assert.equal(result.employees[0].amountCents, 123);
  evidence.schemeSnapshot = input.scheme;
  evidence.calculatorReplay = structuredClone(buildCalculatorReplay(input, result));
  const withPayload = payload => {
    const evidence_payload = JSON.stringify(payload), checksum = createHash('sha256').update(evidence_payload).digest('hex');
    return { ...row, evidence_payload, evidence_sha256: checksum, input_checksum: checksum };
  };
  const good = await replaySavedRun(dbWith([withPayload(evidence)]), venue, run);
  assert.equal(good.verification.status, 'matched'); assert.equal(good.verification.replayVerified, true);
  assert.equal(Object.hasOwn(good.verification, 'result'), false);
  const unavailable = structuredClone(evidence); unavailable.calculatorReplay.engineRevision = '0'.repeat(64);
  assert.equal((await listSavedRuns(dbWith([withPayload(unavailable)]), venue)).items[0].replay.state, 'engine_unavailable');
  assert.equal((await replaySavedRun(dbWith([withPayload(unavailable)]), venue, run)).verification.status, 'engine_unavailable');
  assert.equal((await replaySavedRun(dbWith([header()]), venue, run)).verification.status, 'not_recorded');
  for (const mutate of [
    value => { value.calculatorReplay.input.sales[0].turnoverCents++; },
    value => { value.calculatorReplay.result.employees[0].amountCents++; },
    value => { value.calculatorReplay = null; },
    value => { value.schemeSnapshot.name = 'Wrong scheme'; }
  ]) {
    const bad = structuredClone(evidence); mutate(bad);
    await rejects(replaySavedRun(dbWith([withPayload(bad)]), venue, run), 'evidence_invalid', 409);
  }
}
// Version2 uses the real source, engine, snapshot and provenance builders. SQL
// transport remains fake; no DB or financial writes are made by this contract.
const { buildPayrollRefundAwareRunProvenance } = require('../payroll-refund-aware-provenance');
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const minorDecimal = value => `${Math.floor(value / 100)}.${String(value % 100).padStart(2, '0')}`;
function version2(mode = 'percent_only', opts = {}) {
  const args = { ...makePayrollRefundAwareFixture(mode, opts), runId: id(800) };
  const built = buildPayrollRefundAwareRunProvenance(args);
  assert.equal(built.status, 'verified_run_evidence');
  const p = built.provenance, e = JSON.parse(p.evidence_payload), mapped = built.prepared.mappedRows;
  const row = header({ id: args.runId, venue_id: args.venueId, scheme_version_id: args.scheme.versionId,
    period_from: args.period.from, period_to: args.period.to, input_watermark: e.inputWatermark,
    input_checksum: p.evidence_sha256, evidence_sha256: p.evidence_sha256, evidence_payload: p.evidence_payload,
    engine_version: built.engineVersion, provenance_schema_version: 2, capability_version: e.capabilityVersion,
    venue_timezone: e.venueTimezone, total_amount_cents: String(p.total_amount_cents), snapshot_total: minorDecimal(p.total_amount_cents),
    snapshot_line_count: String(mapped.snapshotLines.length), eligible_line_count: mapped.snapshotLines.length });
  const days = mapped.dailySnapshots.map((day, i) => ({ ...day, id: id(810 + i) }));
  const parentIds = new Map(days.map(day => [day.key, day.id]));
  const lines = mapped.snapshotLines.map((line, i) => ({ ...line, id: id(850 + i), snapshot_id: parentIds.get(line.snapshotKey),
    team_pool_snapshot_id: null }));
  return { args, row, evidence: e, days, lines };
}
const repack = (row, evidence) => {
  const evidence_payload = canonical(evidence), checksum = createHash('sha256').update(evidence_payload).digest('hex');
  return { ...row, evidence_payload, input_checksum: checksum, evidence_sha256: checksum };
};
const publicOnly = value => {
  assert.equal(value.schemaVersion, 1); assert.equal(value.officialReady, false); assert.equal(value.payoutEligible, false);
  for (const key of ['sourceBundle', 'sourceBundleWatermark', 'refundQuantityEvidence', 'calculatorReplay', 'evidence_payload'])
    assert.equal(JSON.stringify(value).includes(`"${key}"`), false, `${key} must not leak through public DTOs`);
};
for (const mode of payrollRefundAwareModes) for (const opts of [{}, { fullReturn: true }]) {
  const f = version2(mode, opts), v = f.args.venueId, r = f.args.runId;
  const employeeId = f.days[0].employee_id;
  const listed = await listSavedRuns(dbWith([f.row]), v);
  publicOnly(listed.items[0]);
  assert.equal(listed.items[0].capabilityVersion, 'employee_attributed_remaining_net_refund_v2');
  assert.equal(listed.items[0].replayAvailable, true);
  const details = await getSavedRun(dbWith([f.row], [{ employee_id: employeeId, employee_name: f.days[0].employee_name_snapshot,
    amount: f.row.snapshot_total, day_count: String(f.days.length) }]), v, r);
  publicOnly(details); assert.equal(details.schemeSnapshot.sourcePolicies.schemaVersion, 2);
  assert.equal(details.amountCents, f.evidence.totalAmountCents);
  const daily = await getSavedRunEmployee(dbWith([f.row], f.days), v, r, employeeId);
  publicOnly(daily); assert.equal(daily.amountCents, f.evidence.totalAmountCents);
  const lineRow = f.lines[0], parent = f.days.find(day => day.id === lineRow.snapshot_id);
  const lines = await getSavedRunLines(dbWith([f.row], [parent], f.lines), v, r, lineRow.snapshot_id);
  publicOnly(lines); assert.equal(lines.items.length, 1);
  assert.equal(lines.items[0].refundCents, opts.fullReturn ? 10000 : 2500);
  assert.equal(lines.items[0].commissionBaseCents, opts.fullReturn ? 0 : 7500);
  assert.equal(lines.items[0].quantity, '1.000', 'typed quantity is original, remaining quantity stays in private evidence');
  if (mode === 'margin_target') {
    assert.equal(lines.items[0].netCostCents, 100);
    assert.equal(lines.items[0].signedMarginCents, opts.fullReturn ? -100 : 7400);
  }
  const replay = await replaySavedRun(dbWith([f.row]), v, r);
  publicOnly(replay); assert.equal(replay.verification.status, 'matched');
  assert.equal(replay.verification.replayVerified, true); assert.equal(replay.persistence, 'none');
}
{
  const f = version2(), v = f.args.venueId, r = f.args.runId;
  for (const patch of [
    { engine_version: 'payroll-verified-no-refund-v1' }, { engine_version: 'payroll-unrecognized-v3' },
    { capability_version: cap }, { provenance_schema_version: 1 }, { provenance_schema_version: 3 },
    { snapshot_total: '7.51' }, { snapshot_line_count: '0' }, { venue_id: id(999) }
  ]) await rejects(getSavedRun(dbWith([{ ...f.row, ...patch }]), v, r), 'evidence_invalid', 409);
  for (const mutate of [
    e => { e.schemaVersion = 1; }, e => { e.capabilityVersion = cap; }, e => { e.venueId = id(999); },
    e => { delete e.sourceBundle; }, e => { delete e.sourceBundleWatermark; }, e => { delete e.calculatorReplay; },
    e => { e.sourceBundle.schemaVersion = 1; },
    e => { e.sourceBundle.employmentEligibility.periods[0].employeeName += ' altered'; e.sourceBundleWatermark = hash(e.sourceBundle); },
    e => { e.sourceBundle.recognitionEvidence.payload += ' '; e.sourceBundleWatermark = hash(e.sourceBundle); },
    e => { e.refundQuantityEvidence.lines[0].remainingQuantity = '0.999'; },
    e => { e.periodClosure.venueLocalDate = '2026-11-07'; },
    e => { e.calculatorReplay.input.sales[0].commissionBaseCents++; },
    e => { e.calculatorReplay.engineRevision = '0'.repeat(64); },
    e => { e.totalAmountCents++; }, e => { e.unexpected = 'ignored payload must not be accepted'; }
  ]) {
    const evidence = structuredClone(f.evidence); mutate(evidence);
    await rejects(replaySavedRun(dbWith([repack(f.row, evidence)]), v, r), 'evidence_invalid', 409);
  }
  // SQL applies both tenant and exact supported-engine filters on every load.
  const db = dbWith([f.row], []); await getSavedRun(db, v, r);
  assert.match(db.calls[0].sql, /WHERE r.venue_id=\$1 AND r.id=\$2/);
  assert.match(db.calls[0].sql, /r.engine_version=ANY\(\$3::text\[\]\)/);
  assert.deepEqual(db.calls[0].values, [v, r, ['payroll-verified-no-refund-v1', 'payroll-verified-remaining-net-v2']]);
  const listing = dbWith([f.row]); await listSavedRuns(listing, v);
  assert.match(listing.calls[0].sql, /WHERE r.venue_id=\$1.*r.engine_version=ANY\(\$2::text\[\]\)/);
  assert.deepEqual(listing.calls[0].values.slice(0, 2), [v, ['payroll-verified-no-refund-v1', 'payroll-verified-remaining-net-v2']]);
  await rejects(getSavedRun(dbWith([f.row]), id(999), r), 'evidence_invalid', 409);
  await rejects(getSavedRunEmployee(dbWith([f.row], [{ ...f.days[0], venue_id: id(999) }]), v, r, f.days[0].employee_id), 'evidence_invalid', 409);
  await rejects(getSavedRunLines(dbWith([f.row], [f.days[0]], [{ ...f.lines[0], venue_id: id(999) }]), v, r, f.days[0].id), 'evidence_invalid', 409);
}
console.log('PASS payroll-saved-run-reader-contract: v1 unchanged; all7 v2 partial/full return read/list/employee/lines/exact replay; strict pair/source tampering and tenant checks; fake SQL, no PG');
