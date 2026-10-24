import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { beginPayrollVerifiedRunSourceTransaction } = require('../payroll-source-fence');
const { readPayrollRefundEconomicSourceInTransaction } = require('../payroll-refund-economic-source');
const { readPayrollRefundFrozenCostSourceInTransaction, buildPayrollRefundFrozenCostSource } = require('../payroll-refund-frozen-cost-source');

// Called only by the guarded, HTTP-produced tracked-sale fixture. This verifies
// incentive source reads, not closed-period eligibility, payout or actual COGS.
export function trackedRefundCostProbe({ db, venueId, ownerId, orderId, orderItemId, productId, period, producerWatermark }) {
  const sourcePolicies = { schemaVersion: 2, selectionReason: 'QA explicit frozen historical payroll cost policy',
    saleCredit: { kind: 'line_seller_snapshot' }, discountAllocation: { kind: 'immutable_line_snapshot' },
    refunds: { recognition: 'recognized_event_date', closedRunTreatment: 'next_open_run_adjustment',
      paidAdjustment: 'owner_review_variable_pay_only', uncoveredBalance: 'carry_forward_review', clawback: 'no_automatic_clawback' },
    earnings: { refunds: 'remaining_merchandise_original_sale_date_v1',
      venueTurnover: 'canonical_total_less_merchandise_returns_v1', marginCost: 'frozen_sale_depletion_cost_payroll_v1' } };
  const ledger = async () => {
    const result = {};
    for (const table of ['payroll_calculation_runs', 'payroll_entries', 'expenses', 'stock_movements', 'order_costs', 'pos_sale_cost_evidence']) {
      result[table] = (await db.query(`SELECT count(*)::int AS count,
        encode(sha256(convert_to(COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text,'UTF8')),'hex') AS hash
        FROM ${table} t WHERE venue_id=$1`, [venueId])).rows[0];
    }
    return result;
  };
  return async ({ quantity, netCents }) => {
    const identity = (await db.query('SELECT current_database() AS name')).rows[0].name;
    assert.match(identity, /^inventory_qa_[a-f0-9]{16}$/);
    assert.equal(identity, process.env.LOCAL_FULL_PG_OWNED_DATABASE);
    const before = await ledger();
    const release = await beginPayrollVerifiedRunSourceTransaction(db, venueId);
    let cost;
    try {
      const owner = (await db.query("SELECT id FROM users WHERE venue_id=$1 AND id=$2 AND role='owner' AND is_active=true AND deleted_at IS NULL",
        [venueId, ownerId])).rows[0];
      assert.ok(owner, 'source fixture uses the authenticated venue owner');
      const economics = await readPayrollRefundEconomicSourceInTransaction(db, { venueId, currency: 'RUB', from: period.from, to: period.to });
      const args = { venueId, currency: 'RUB', period, sourcePolicies, projection: economics.projection };
      cost = await readPayrollRefundFrozenCostSourceInTransaction(db, args);
      assert.equal(cost.status, 'available', JSON.stringify(cost.reasons));
      assert.equal(cost.rows.length, 1);
      const row = cost.rows[0];
      assert.deepEqual([row.orderId, row.orderItemId, row.productId], [orderId, orderItemId, productId]);
      assert.equal(Number(row.originalQuantity), 2);
      assert.equal(Number(row.remainingQuantity), quantity);
      assert.equal(row.producerWatermark, producerWatermark);
      assert.deepEqual(row.costSnapshot, { id: `${orderId}/${orderItemId}`, version: producerWatermark, currency: 'RUB', costCents: 5000 });
      const sale = economics.projection.saleLines.find(item => item.saleLineEventId === row.saleLineEventId);
      assert.ok(sale, 'cost bound to the same verified sale projection');
      assert.equal(sale.remainingNetCents, netCents);
      assert.equal(cost.accountingScope, 'payroll_incentive_only_not_actual_cogs');
      assert.deepEqual([cost.refundAdjustedReady, cost.officialReady, cost.payoutEligible, cost.persistence, cost.financialAuthority],
        [false, false, false, 'none', 'none']);
      for (const evidenceByOrder of [[], cost.evidenceByOrder.map(item => ({ ...item, venueId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }))]) {
        const blocked = buildPayrollRefundFrozenCostSource({ ...args, evidenceByOrder });
        assert.equal(blocked.status, 'incomplete');
        assert.deepEqual(blocked.rows, []);
      }
      await db.query('COMMIT');
    } catch (error) { await db.query('ROLLBACK'); throw error; }
    finally { await release(); }
    assert.deepEqual(await ledger(), before, 'payroll reads add no run, entry, expense, stock movement or cost mutation');
    return cost;
  };
}
