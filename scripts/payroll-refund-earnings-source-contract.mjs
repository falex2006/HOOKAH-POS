// Actual manifest validator, source adapter and projector; fake SQL transport.
// This does not establish PostgreSQL producer/fence integration or payout readiness.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const require = createRequire(import.meta.url);
const recognition = require('../payroll-recognition-manifest');
const source = require('../payroll-refund-earnings-source');
const fence = require('../payroll-source-fence');
const id = n => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;
const venueId = id(1), options = { venueId, currency: 'RUB', from: '2026-10-01', to: '2026-10-31' };
// Reuse the existing standalone raw producer fixture without executing its
// contract suite or importing its assertions. New sibling cases below extend it.
const fixtureText = readFileSync(new URL('./payroll-recognition-manifest-contract.mjs', import.meta.url), 'utf8');
const start = fixtureText.indexOf('const crossPeriodSale=()=>{');
const end = fixtureText.indexOf('\nconst crossPeriodFacts=', start);
assert.ok(start >= 0 && end > start);
const empty = () => ({ epoch: { venue_id: venueId, policy_version: 1, activation_scope: 'new_venue',
  activated_at: '2026-10-01T00:00:00.000001Z', timezone_snapshot: 'Asia/Yekaterinburg', activated_local_date: '2026-10-01' },
  saleEvents: [], saleLines: [], orders: [], pricingHeaders: [], pricingLines: [], orderItems: [], candidateOrders: [],
  refundEvents: [], refundLines: [], refundHeaders: [], relatedRefundHeaders: [], relatedRefundItems: [], refundItems: [], refundTenders: [], candidateRefunds: [] });
const makeRaw = runInNewContext(`${fixtureText.slice(start, end)};crossPeriodSale`, { id, venueId, empty, epoch: () => empty().epoch });
const fixture = () => {
  const facts = structuredClone(makeRaw());
  facts.pricingLines[0].product_facts = { productId: id(90), productName: 'Frozen product' };
  return facts;
};
const adapt = (facts, opts = options) => source.buildPayrollRefundEarningsSource({ facts,
  manifest: recognition.buildPayrollRecognitionManifest(facts, opts) }, opts);
let checks = 0;
const reject = mutate => {
  const facts = fixture(); mutate(facts);
  assert.throws(() => adapt(facts), error => /^payroll_/.test(error.code || '')); checks++;
};
{
  const facts = fixture(), before = structuredClone(facts), manifest = recognition.buildPayrollRecognitionManifest(facts, options);
  const projected = adapt(facts);
  assert.deepEqual(facts, before); checks++;
  assert.deepEqual(manifest.refundEvents, []); checks++;
  assert.equal(projected.recognitionHistory.refundEvents.length, 1); checks++;
  assert.equal(projected.recognitionHistory.refundEvents[0].recognizedLocalDate, '2026-11-05'); checks++;
  assert.equal(projected.saleLines[0].remainingNetCents, 7500); checks++;
  assert.equal(projected.saleLines[0].remainingQuantity, '0.750'); checks++;
  assert.equal(projected.saleLines[0].recognizedLocalDate, '2026-10-10'); checks++;
  assert.equal(projected.manifestWatermark, manifest.watermark); checks++;
  assert.equal(projected.payoutEligible, false); checks++;
  const prior = adapt(facts, { ...options, from: '2026-11-01', to: '2026-11-30' });
  assert.equal(prior.saleLines[0].inEarningPeriod, false); checks++;
  assert.equal(prior.saleLines[0].quantity, '1.000'); checks++;
  const tampered = structuredClone(manifest); tampered.watermark = 'a'.repeat(64);
  assert.throws(() => source.buildPayrollRefundEarningsSource({ facts, manifest: tampered }, options)); checks++;
}
function withSibling() {
  const facts = fixture();
  facts.saleLines.push({ ...facts.saleLines[0], id: id(80), order_item_id: id(81), pricing_line_id: id(82) });
  facts.pricingLines.push({ ...structuredClone(facts.pricingLines[0]), id: id(82), order_item_id: id(81) });
  facts.orderItems.push({ id: id(81), order_id: id(20) });
  facts.pricingHeaders[0].subtotal_minor = facts.pricingHeaders[0].final_total_minor = '20000';
  return facts;
}
{
  const facts = withSibling(), opts = { ...options, from: '2026-11-01', to: '2026-11-30' };
  const output = adapt(facts, opts);
  assert.equal(output.saleLines.length, 2); checks++;
  assert.equal(output.saleLines.find(row => row.saleLineEventId === id(80)).remainingNetCents, 10000); checks++;
  assert.equal(output.coverage.lineTotals.find(row => row.saleLineEventId === id(80)).cumulativeReturnedItemValueMinor, 0); checks++;
  facts.saleLines[1].seller_id = id(99);
  assert.throws(() => adapt(facts, opts), /payroll_/); checks++;
}
for (const mutate of [
  f => { f.relatedRefundHeaders = []; }, f => { f.relatedRefundItems = []; }, f => { f.refundEvents = []; },
  f => { f.refundLines = []; }, f => { f.refundItems = []; }, f => { f.refundHeaders = []; }, f => { f.refundTenders = []; },
  f => { f.refundItems[0].cumulative_returned_item_value_minor = '2499'; },
  f => { f.refundLines[0].producer_sequence = '2'; }, f => { f.refundEvents[0].currency_code = 'USD'; },
  f => { f.refundEvents[0].recognized_local_date = '2026-11-06'; },
  f => { f.refundEvents[0].original_sale_event_id = id(99); },
  f => { f.refundLines[0].original_sale_line_event_id = id(99); },
  f => { f.saleLines[0].seller_id = id(99); }, f => { f.saleLines[0].eligibility_status = 'cross_venue'; },
  f => { f.saleLines[0].attribution_captured_at = null; }, f => { f.orders[0].status = 'open'; },
  f => { f.saleLines[0].attribution_captured_at = '2026-02-30T12:00:00.000000Z'; },
  f => { f.pricingLines[0].product_facts = {}; }, f => { f.pricingLines[0].gross_minor = '10001'; },
  f => { f.pricingLines[0].quantity = '1.001'; }, f => { f.orderItems = []; },
  f => { f.refundLines.push(structuredClone(f.refundLines[0])); },
  f => { f.refundItems.push(structuredClone(f.refundItems[0])); },
  f => { f.saleEvents.push(structuredClone(f.saleEvents[0])); },
  f => { f.saleLines.push(structuredClone(f.saleLines[0])); }
]) reject(mutate);
{
  const facts = fixture();
  for (const key of ['refundEvents', 'refundLines', 'refundHeaders', 'relatedRefundHeaders', 'relatedRefundItems', 'refundItems', 'refundTenders']) facts[key] = [];
  assert.equal(adapt(facts).saleLines[0].remainingNetCents, 10000); checks++;
  assert.deepEqual(adapt(facts).recognitionHistory, { refundEvents: [], refundLines: [] }); checks++;
}
{
  const facts = fixture();
  for (const row of [facts.refundItems[0], facts.refundLines[0]]) {
    row.returned_quantity = row.cumulative_returned_quantity = '1.000';
    row.returned_item_value_minor = row.cumulative_returned_item_value_minor = '10000';
  }
  const output = adapt(facts);
  assert.equal(output.saleLines[0].remainingQuantity, '0.000'); checks++;
  assert.equal(output.saleLines[0].remainingNetCents, 0); checks++;
  assert.equal(output.saleLines.length, 1); checks++;
}
{
  const facts = fixture(); facts.saleLines[0].sold_at = facts.pricingLines[0].sold_at = '2026-10-10T09:00:00.000001Z';
  facts.orders[0].pricing_locked_at = facts.pricingHeaders[0].transaction_at = '2026-10-10T09:00:00.000001Z';
  assert.equal(adapt(facts).saleLines[0].soldAt, '2026-10-10T09:00:00.000001Z'); checks++;
}
function fakeDb(facts, { missingSchema = false, failTable = null } = {}) {
  const queries = [];
  const db = { async query(sql, values = []) {
    const text = sql.replace(/\s+/g, ' ').trim(); queries.push({ text, values });
    if (text.startsWith('SELECT pg_advisory_unlock')) return { rows: [{ unlocked: true }] };
    if (/^(SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT|BEGIN|COMMIT|ROLLBACK)/.test(text) || text.startsWith('SELECT pg_advisory_lock')) return { rows: [] };
    if (text === 'SHOW transaction_isolation') return { rows: [{ transaction_isolation: 'repeatable read' }] };
    if (text === 'SHOW transaction_read_only') return { rows: [{ transaction_read_only: 'off' }] };
    if (text.startsWith('WITH required AS')) return { rows: [{ missing_count: missingSchema ? 1 : 0 }] };
    const table = [...text.matchAll(/FROM (\w+)/g)].at(-1)?.[1];
    if (table === failTable) throw new Error('injected source read failure');
    assert.equal(values[0], venueId, `tenant required for ${table}`);
    let result;
    switch (table) {
      case 'pos_payroll_recognition_epochs': result = [facts.epoch]; break;
      case 'orders': result = text.includes('id=ANY') ? facts.orders : facts.candidateOrders; break;
      case 'order_refunds': result = text.includes('created_at>=') ? facts.candidateRefunds
        : text.includes('order_id=ANY') ? facts.relatedRefundHeaders : facts.refundHeaders; break;
      case 'pos_payroll_sale_events': result = facts.saleEvents; break;
      case 'pos_payroll_sale_line_events': result = facts.saleLines; break;
      case 'pos_order_pricing_snapshots': result = facts.pricingHeaders; break;
      case 'pos_order_pricing_snapshot_lines': result = facts.pricingLines; break;
      case 'order_items': result = facts.orderItems; break;
      case 'pos_payroll_refund_events': result = facts.refundEvents; break;
      case 'pos_payroll_refund_line_events': result = facts.refundLines; break;
      case 'order_refund_items': result = text.includes('SELECT id::text,venue_id::text,refund_id::text,order_id::text FROM') ? facts.relatedRefundItems : facts.refundItems; break;
      case 'order_refund_tenders': result = facts.refundTenders; break;
      default: assert.fail(`Unexpected source SQL: ${text}`);
    }
    return { rows: structuredClone(result) };
  } };
  return { db, queries };
}
for (const reader of [recognition.readPayrollRecognitionEvidenceInTransaction, source.readPayrollRefundEarningsSourceInTransaction]) {
  const f = fakeDb(fixture());
  await assert.rejects(async () => reader(f.db, options), /verified_write_snapshot_required/); checks++;
  assert.equal(f.queries.length, 0); checks++;
}
{
  const facts = withSibling(), f = fakeDb(facts), release = await fence.beginPayrollVerifiedRunSourceTransaction(f.db, venueId);
  try {
    const legacy = await recognition.readPayrollRecognitionManifestInTransaction(f.db, options);
    const detailed = await recognition.readPayrollRecognitionEvidenceInTransaction(f.db, options);
    assert.deepEqual(detailed.manifest, legacy); checks++;
    assert.deepEqual(legacy, recognition.buildPayrollRecognitionManifest(facts, options)); checks++;
    assert.equal(Object.hasOwn(legacy, 'facts'), false); checks++;
    assert.equal(detailed.facts.refundEvents[0].recognized_at, '2026-11-05T10:00:00.000000Z'); checks++;
    const projected = await source.readPayrollRefundEarningsSourceInTransaction(f.db, options);
    assert.deepEqual(projected, adapt(facts)); checks++;
    const refundHeaderQuery = f.queries.find(row => row.text.includes('FROM order_refunds WHERE venue_id=$1 AND order_id=ANY'));
    assert.ok(refundHeaderQuery); assert.doesNotMatch(refundHeaderQuery.text, /BETWEEN|created_at[<>]/); checks++;
  } finally { await f.db.query('ROLLBACK'); await release(); }
}
for (const settings of [{ missingSchema: true }, { failTable: 'pos_payroll_refund_events' }]) {
  const f = fakeDb(fixture(), settings), release = await fence.beginPayrollVerifiedRunSourceTransaction(f.db, venueId);
  try { await assert.rejects(source.readPayrollRefundEarningsSourceInTransaction(f.db, options)); checks++; }
  finally { await f.db.query('ROLLBACK'); await release(); }
  if (settings.failTable) { assert.ok(f.queries.some(row => row.text.startsWith('ROLLBACK TO SAVEPOINT'))); checks++; }
}
console.log(`PASS payroll-refund-earnings-source-contract: ${checks} actual validator/adapter checks, fake SQL transport; no PG or payout acceptance`);
