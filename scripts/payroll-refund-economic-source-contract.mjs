// Real canonical/manifest/refund validators with fake SQL transport, no PG.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const require = createRequire(import.meta.url);
const recognition = require('../payroll-recognition-manifest');
const { buildPayrollRefundEconomicSource: build, readPayrollRefundEconomicSourceInTransaction: read,
  validatePayrollRefundEconomicSource: validate } = require('../payroll-refund-economic-source');
const fence = require('../payroll-source-fence');
const id = n => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;
const venueId = id(1), options = { venueId, currency: 'RUB', from: '2026-10-01', to: '2026-10-31' };
const clone = value => structuredClone(value);
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const empty = () => ({ epoch: { venue_id: venueId, policy_version: 1, activation_scope: 'new_venue',
  activated_at: '2026-10-01T00:00:00.000001Z', timezone_snapshot: 'Asia/Yekaterinburg', activated_local_date: '2026-10-01' },
  saleEvents: [], saleLines: [], orders: [], pricingHeaders: [], pricingLines: [], orderItems: [], candidateOrders: [],
  refundEvents: [], refundLines: [], refundHeaders: [], relatedRefundHeaders: [], relatedRefundItems: [], refundItems: [], refundTenders: [], candidateRefunds: [] });
// Shared raw immutable producer fixture; execute no other contract assertions.
const fixtureText = readFileSync(new URL('./payroll-recognition-manifest-contract.mjs', import.meta.url), 'utf8');
const start = fixtureText.indexOf('const crossPeriodSale=()=>{'), end = fixtureText.indexOf('\nconst crossPeriodFacts=', start);
assert.ok(start >= 0 && end > start);
const rawFixture = runInNewContext(`${fixtureText.slice(start, end)};crossPeriodSale`, { id, venueId, empty, epoch: () => empty().epoch });
const fixture = () => {
  const facts = clone(rawFixture());
  facts.pricingLines[0].product_facts = { productId: id(90), productName: 'Frozen product' };
  facts.pricingHeaders[0].minimum_adjustment_minor = '700'; facts.pricingHeaders[0].final_total_minor = '10700';
  facts.pricingHeaders[0].sold_at = new Date('2026-10-10T09:00:00.000Z'); // Native pg SELECT s.* metadata.
  for (const row of [facts.refundEvents[0], facts.refundHeaders[0]]) row.payout_minor = '50';
  facts.refundEvents[0].tender_total_minor = facts.refundTenders[0].tender_total_minor = '50';
  return facts;
};
const adapt = (facts, opts = options) => build({ facts, manifest: recognition.buildPayrollRecognitionManifest(facts, opts) }, opts);
export { fixture as makePayrollRefundEconomicFacts, options as payrollRefundEconomicFixtureOptions };
// Other pure all-mode/snapshot contracts can reuse facts without running this
// transport suite as an import side effect.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
let checks = 0;
const check = (value, label) => { assert.ok(value, label); checks++; };
const invalid = mutate => { const facts = fixture(); mutate(facts); assert.throws(() => adapt(facts), error => /^payroll_/.test(error.code || '')); checks++; };
const frozen = value => !value || typeof value !== 'object' || Object.isFrozen(value) && Object.values(value).every(frozen);
{
  const facts = fixture(), before = clone(facts), result = adapt(facts);
  assert.deepEqual(facts, before); checks++;
  check(result.status === 'economic_source_prepared' && result.sourceAttested === false && result.officialReady === false && result.payoutEligible === false);
  check(result.savedSourceComparison === 'not_performed' && result.dateBasis === 'frozen_original_sale_recognized_local_date');
  check(result.originalDaily.length === 31 && result.remainingDaily.length === 31 && result.adjustmentDaily.length === 31);
  check(result.originalDaily[9].turnoverCents === 10700 && result.remainingDaily[9].turnoverCents === 8200);
  check(result.adjustmentDaily[9].originalAdjustmentCents === 700 && result.adjustmentDaily[9].remainingAdjustmentCents === 700);
  check(result.originalDaily[0].turnoverCents === 0 && result.remainingDaily[30].turnoverCents === 0);
  check(result.treasuryRefundFacts[0].payoutMinor === 50 && result.treasuryRefundFacts[0].returnedMerchandiseMinor === 2500);
  check(result.projection.recognitionHistory.refundEvents[0].recognizedLocalDate === '2026-11-05', 'late complete history retained');
  check(result.orderEconomics[0].pricingSnapshot.minimumAdjustmentCents === 700 && result.orderEconomics[0].cumulativeReturnedMerchandiseCents === 2500);
  check(result.coverage.complete && result.coverage.orderIds.length === 1 && result.coverage.saleLineEventIds.length === 1);
  check(frozen(result));
  check(result.sourceWatermark === adapt(facts).sourceWatermark);
  assert.deepEqual(validate(result), result); checks++;
  // Canonical saved provenance may reorder all object keys. The evidence JSON
  // string preserves legacy raw-fact insertion order for a subsequent rebuild.
  assert.deepEqual(validate(JSON.parse(canonical(result))), result); checks++;
  const embedded = JSON.parse(result.evidence.payload);
  check(embedded.facts.pricingHeaders[0].sold_at === '2026-10-10T09:00:00.000Z');
  assert.deepEqual(build(embedded, options), result); checks++;
}
{
  const result = adapt(empty());
  check(result.totals.originalTurnoverCents === 0 && result.totals.remainingTurnoverCents === 0 && result.originalDaily.length === 31);
  check(result.orderEconomics.length === 0 && result.projection.saleLines.length === 0);
  check(validate(result).sourceWatermark === result.sourceWatermark);
}
{
  const facts = fixture(), result = adapt(facts, { ...options, from: '2026-11-01', to: '2026-11-30' });
  check(result.orderEconomics.length === 1 && result.orderEconomics[0].inEarningPeriod === false, 'foreign-period original stays in proof cohort');
  check(result.originalDaily.length === 30 && result.originalDaily.every(row => row.turnoverCents === 0) && result.remainingDaily.every(row => row.turnoverCents === 0));
  check(result.coverage.inPeriodOrderIds.length === 0 && result.coverage.orderIds.length === 1);
}
{
  const facts = fixture();
  facts.saleEvents[0].recognized_at = facts.saleEvents[0].source_closed_at = facts.orders[0].closed_at = '2026-10-10T20:00:00.000001Z';
  facts.saleEvents[0].recognized_local_date = '2026-10-11';
  facts.saleLines[0].attribution_captured_at = '2026-10-10T20:00:00.000001Z';
  const result = adapt(facts);
  check(result.originalDaily[9].turnoverCents === 0 && result.originalDaily[10].turnoverCents === 10700, 'frozen local date beats current/UTC date');
  check(result.orderEconomics[0].recognizedAt.endsWith('.000001Z'), 'microseconds retained');
}
{
  const facts = fixture();
  for (const row of [facts.refundItems[0], facts.refundLines[0]]) {
    row.returned_quantity = row.cumulative_returned_quantity = '1.000'; row.returned_item_value_minor = row.cumulative_returned_item_value_minor = '10000';
  }
  const result = adapt(facts);
  check(result.remainingDaily[9].turnoverCents === 700 && result.projection.saleLines[0].remainingNetCents === 0);
  check(result.projection.saleLines.length === 1 && result.orderEconomics[0].saleLineEventIds.length === 1, 'zero lines retained after full return');
}
{
  const facts = fixture();
  facts.saleLines.push({ ...facts.saleLines[0], id: id(80), order_item_id: id(81), pricing_line_id: id(82) });
  facts.pricingLines.push({ ...clone(facts.pricingLines[0]), id: id(82), order_item_id: id(81), unit_price: '0.00', gross_minor: '0', net_minor: '0' });
  facts.orderItems.push({ id: id(81), order_id: id(20) });
  const result = adapt(facts);
  check(result.orderEconomics[0].saleLineEventIds.length === 2 && result.projection.saleLines.length === 2 && result.remainingDaily[9].turnoverCents === 8200);
  facts.saleLines.pop(); assert.throws(() => adapt(facts)); checks++;
}
{
  const facts = fixture(), baseline = adapt(facts);
  for (const row of [facts.refundEvents[0], facts.refundHeaders[0]]) row.payout_minor = '99999';
  facts.refundEvents[0].tender_total_minor = facts.refundTenders[0].tender_total_minor = '99999';
  const result = adapt(facts);
  assert.deepEqual(result.remainingDaily, baseline.remainingDaily); checks++;
  check(result.sourceWatermark !== baseline.sourceWatermark && result.factsWatermark !== baseline.factsWatermark, 'cash affects provenance, not economic turnover');
}
for (const mutate of [
  facts => { facts.pricingHeaders[0].minimum_adjustment_minor = '-1'; },
  facts => { facts.pricingHeaders[0].final_total_minor = '10700.5'; },
  facts => { facts.pricingHeaders[0].final_total_minor = '9007199254740992'; },
  facts => { facts.pricingHeaders[0].currency_code = 'USD'; },
  facts => { facts.pricingHeaders[0].venue_id = id(999); },
  facts => { facts.pricingHeaders[0].subtotal_minor = '10001'; },
  facts => { facts.pricingHeaders.push(clone(facts.pricingHeaders[0])); },
  facts => { facts.pricingHeaders = []; }, facts => { facts.pricingLines = []; }, facts => { facts.orderItems = []; },
  facts => { facts.saleEvents[0].snapshot_id = id(999); }, facts => { facts.saleLines[0].pricing_line_id = id(999); },
  facts => { facts.saleEvents[0].recognized_local_date = '2026-10-11'; },
  facts => { facts.saleEvents[0].recognized_at = new Date(); },
  facts => { facts.relatedRefundItems = []; }, facts => { facts.refundEvents = []; }, facts => { facts.refundLines = []; },
  facts => { facts.refundItems[0].returned_item_value_minor = '2501'; },
  facts => { facts.refundLines[0].cumulative_returned_quantity = '1.001'; },
  facts => { facts.pricingHeaders[0].sold_at = new Date('invalid'); }
]) invalid(mutate);
{
  const facts = fixture();
  for (const name of ['saleEvents', 'saleLines', 'orders', 'pricingHeaders', 'pricingLines', 'orderItems']) {
    const row = clone(facts[name][0]);
    for (const key of Object.keys(row)) if (typeof row[key] === 'string' && /^aaaaaaaa-aaaa-4aaa-8aaa-/.test(row[key]) && row[key] !== venueId && key !== 'seller_id'
      && !['eligibility_venue_id', 'employee_venue_id'].includes(key)) row[key] = id(Number(row[key].slice(-12)) + 200);
    facts[name].push(row);
  }
  for (const row of facts.pricingHeaders) { row.minimum_adjustment_minor = String(BigInt(Number.MAX_SAFE_INTEGER) - 10000n); row.final_total_minor = String(Number.MAX_SAFE_INTEGER); }
  assert.throws(() => adapt(facts), /amount_overflow/); checks++;
}
{
  const facts = fixture(), manifest = recognition.buildPayrollRecognitionManifest(facts, options);
  assert.throws(() => build({ manifest, facts, extra: true }, options), /shape_invalid/); checks++;
  assert.throws(() => build({ manifest, facts }, { ...options, timezone: 'UTC' }), /shape_invalid/); checks++;
  assert.throws(() => build({ manifest, facts }, { ...options, currency: 'USD' }), /payroll_/); checks++;
  Object.defineProperty(facts, 'saleEvents', { enumerable: true, get() { throw new Error('getter executed'); } });
  assert.throws(() => build({ manifest, facts }, options), /json_invalid/); checks++;
}
for (const mutate of [result => { result.remainingDaily[9].turnoverCents++; }, result => { result.adjustmentDaily[9].remainingAdjustmentCents--; },
  result => { result.projection.saleLines[0].remainingNetCents++; }, result => { result.orderEconomics[0].remainingTotalCents++; },
  result => { result.sourceWatermark = 'b'.repeat(64); }, result => { result.evidence.payload = '{}'; }, result => { result.evidence.extra = true; }]) {
  const result = clone(adapt(fixture())); mutate(result); assert.throws(() => validate(result), /payroll_/); checks++;
}
{
  const result = clone(adapt(fixture())); result.remainingDaily[9].turnoverCents++; const payload = clone(result); delete payload.sourceWatermark;
  result.sourceWatermark = hash(payload); assert.throws(() => validate(result), /replay_mismatch/); checks++;
}
// Reuse the established SQL transport fixture without replacing any validator.
const transportText = readFileSync(new URL('./payroll-refund-earnings-source-contract.mjs', import.meta.url), 'utf8');
const transportStart = transportText.indexOf('function fakeDb('), transportEnd = transportText.indexOf('\nfor (const reader of', transportStart);
assert.ok(transportStart >= 0 && transportEnd > transportStart);
const fakeDb = runInNewContext(`${transportText.slice(transportStart, transportEnd)};fakeDb`, { assert, venueId, structuredClone });
{
  const f = fakeDb(fixture());
  await assert.rejects(read(f.db, options), /verified_write_snapshot_required/); checks++;
  check(f.queries.length === 0, 'unfenced call performs no SQL');
  const release = await fence.beginPayrollVerifiedRunSourceTransaction(f.db, venueId);
  try {
    const result = await read(f.db, options); assert.deepEqual(result, adapt(fixture())); checks++;
    const before = f.queries.length;
    await assert.rejects(read(f.db, { ...options, venueId: id(999) }), /verified_write_snapshot_required/); checks++;
    check(f.queries.length === before, 'wrong-venue fence cannot read');
    const headerQuery = f.queries.find(row => row.text.includes('FROM order_refunds WHERE venue_id=$1 AND order_id=ANY'));
    check(headerQuery && !/BETWEEN|created_at[<>]/.test(headerQuery.text), 'all related refund history has no date cutoff');
    check(!f.queries.some(row => /^(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|CREATE)\b/.test(row.text)), 'source reader performs no writes');
  } finally { await f.db.query('ROLLBACK'); await release(); }
  const before = f.queries.length; await assert.rejects(read(f.db, options), /verified_write_snapshot_required/); checks++;
  check(f.queries.length === before, 'released private capability cannot be reused');
}
for (const settings of [{ missingSchema: true }, { failTable: 'pos_payroll_refund_events' }]) {
  const f = fakeDb(fixture(), settings), release = await fence.beginPayrollVerifiedRunSourceTransaction(f.db, venueId);
  try { await assert.rejects(read(f.db, options)); checks++; }
  finally { await f.db.query('ROLLBACK'); await release(); }
  if (settings.failTable) check(f.queries.some(row => row.text.startsWith('ROLLBACK TO SAVEPOINT')));
}
console.log(`payroll-refund-economic-source-contract: ok (${checks} checks; actual validators, fake SQL, no PG)`);
}
