import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

// Call inside the initial disposable-QA seed transaction, after the original
// order is closed. The caller owns BEGIN/COMMIT and the session-only clock
// function. All pricing, recognition and attribution triggers remain enabled.
export async function seedCorrectionTargetSources(seed, { ids, period, clockSchema }) {
  assert.match(clockSchema, /^payroll_seed_clock_[a-f0-9]{32}$/);
  assert.match(period.from, /^\d{4}-\d{2}-\d{2}$/);
  const context = (await seed.query(`SELECT current_setting('qa.payroll_seed_clock') AS previous_clock,
    current_schemas(true) AS schemas,
    (date_trunc('month',$1::date)+interval '1 month')::date::text AS next_day,
    (date_trunc('month',$1::date)+interval '2 months'-interval '1 day')::date::text AS next_month_end,
    (date_trunc('month',$1::date)+interval '1 month')::date < (pg_catalog.transaction_timestamp() AT TIME ZONE 'UTC')::date AS closed`, [period.from])).rows[0];
  assert.ok(context.schemas.includes(clockSchema), 'the parent historical seed clock is active');
  assert.equal(context.closed, true, 'next-month first day must already be closed on the real UTC clock');
  const nextPeriod = { from: context.next_day, to: context.next_day };
  assert.ok(nextPeriod.from > period.to);
  const target = Object.fromEntries(['order', 'item', 'pricing', 'payment'].map(key => [key, randomUUID()]));
  try {
    await seed.query("SELECT set_config('qa.payroll_seed_clock',$1,true)", [`${nextPeriod.from}T12:00:00Z`]);
    assert.equal((await seed.query('SELECT transaction_timestamp() < pg_catalog.transaction_timestamp() AS historical')).rows[0].historical, true);
    await seed.query(`INSERT INTO orders(id,venue_id,opened_by,status,created_at)
      VALUES($1,$2,$3,'open',transaction_timestamp())`, [target.order, ids.venue, ids.owner]);
    await seed.query(`INSERT INTO order_items(id,order_id,product_id,quantity,unit_price,station,sales_employee_id,sold_at)
      VALUES($1,$2,$3,1,100,'bar',$4,transaction_timestamp())`, [target.item, target.order, ids.product, ids.employee]);
    await seed.query(`INSERT INTO pos_order_pricing_snapshots(id,venue_id,order_id,sold_at,transaction_at,
      subtotal_minor,discount_minor,minimum_adjustment_minor,final_total_minor,discount_source,winner_source_ids,
      eligible_item_ids,winner_terms,frozen_terms)
      VALUES($1,$2,$3,transaction_timestamp(),transaction_timestamp(),10000,0,0,10000,'none','{}','{}','{}',$4)`,
    [target.pricing, ids.venue, target.order, JSON.stringify({ allocationPolicy: 'largest-remainder-item-id-v1',
      offers: [], inputs: { approvedDiscounts: [], promotions: [] }, minimumAdjustment: 0 })]);
    await seed.query(`INSERT INTO pos_order_pricing_snapshot_lines(venue_id,snapshot_id,order_id,order_item_id,seller_id,
      sold_at,quantity,unit_price,gross_minor,discount_minor,net_minor,eligible,product_facts)
      VALUES($1,$2,$3,$4,$5,transaction_timestamp(),1,100,10000,0,10000,false,$6)`,
    [ids.venue, target.pricing, target.order, target.item, ids.employee,
      JSON.stringify({ productId: ids.product, productName: 'Historical tea', category: 'bar', station: 'bar', productActive: true })]);
    await seed.query(`INSERT INTO payments(id,order_id,method,amount,status,created_at,finance_account_id,finance_account_name_snapshot)
      VALUES($1,$2,'card',100,'paid',transaction_timestamp(),$3,'Freshness QA bank')`, [target.payment, target.order, ids.account]);
    await seed.query(`UPDATE orders SET pricing_locked_at=transaction_timestamp(),pricing_version=1,
      subtotal_snapshot=100,discount_total_snapshot=0,minimum_adjustment_snapshot=0,final_total_snapshot=100,
      closed_at=transaction_timestamp(),status='closed' WHERE id=$1`, [target.order]);
    const recognized = (await seed.query(`SELECT e.coverage_status,e.coverage_reasons,e.recognized_local_date::text,
      e.recognized_at=e.source_closed_at AS close_bound,count(l.id)::int AS line_count,
      min(l.seller_id::text) AS seller_id
      FROM pos_payroll_sale_events e JOIN pos_payroll_sale_line_events l ON l.sale_event_id=e.id
      WHERE e.venue_id=$1 AND e.order_id=$2 GROUP BY e.id`, [ids.venue, target.order])).rows;
    assert.equal(recognized.length, 1);
    assert.equal(recognized[0].coverage_status, 'complete', JSON.stringify(recognized));
    assert.deepEqual(recognized[0].coverage_reasons, []);
    assert.equal(recognized[0].recognized_local_date, nextPeriod.from);
    assert.equal(recognized[0].close_bound, true); assert.equal(recognized[0].line_count, 1);
    assert.equal(recognized[0].seller_id, ids.employee);
  } catch (error) {
    // An aborted PostgreSQL transaction cannot restore its setting; the caller
    // must roll it back. Never hide the producer error behind cleanup failure.
    await seed.query("SELECT set_config('qa.payroll_seed_clock',$1,true)", [context.previous_clock]).catch(() => {});
    throw error;
  }
  await seed.query("SELECT set_config('qa.payroll_seed_clock',$1,true)", [context.previous_clock]);
  return { nextPeriod, eligibilityTo: context.next_month_end, schemeTo: context.next_month_end, ...target };
}

// Optional next step: call in a real-clock source-producer transaction owned by
// the caller after the target payroll has been settled. Quantity0.2 of a100RUB
// line means20RUB merchandise return; the caller's frozen5% scheme yields100 cents.
export async function insertCorrectionTargetPartialRefund(client, { ids, target, shiftId }) {
  assert.ok(shiftId, 'caller supplies the existing QA refund shift');
  const refund = (await client.query(`INSERT INTO order_refunds(venue_id,order_id,shift_id,amount,reason,idempotency_key,actor_id,item_attribution_status)
    VALUES($1,$2,$3,20,'Target own partial return after zero settlement','correction-target-partial-return',$4,'complete') RETURNING id`,
  [ids.venue, target.order, shiftId, ids.owner])).rows[0];
  await client.query(`INSERT INTO order_refund_tenders(venue_id,refund_id,order_id,source_payment_id,amount,payout_method,finance_account_id,finance_account_name_snapshot)
    VALUES($1,$2,$3,$4,20,'card',$5,'Freshness QA bank')`, [ids.venue, refund.id, target.order, target.payment, ids.account]);
  await client.query(`INSERT INTO order_refund_items(venue_id,refund_id,order_id,snapshot_id,order_item_id,returned_quantity,returned_item_value_minor)
    VALUES($1,$2,$3,$4,$5,0.2,NULL)`, [ids.venue, refund.id, target.order, target.pricing, target.item]);
  return refund.id;
}
