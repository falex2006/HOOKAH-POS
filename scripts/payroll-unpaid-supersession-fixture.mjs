import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { makeService } = require('../payroll-scheme-service');
const { beginPayrollSourceProducerTransaction } = require('../payroll-source-fence');

// Called only after the parent validates its owned disposable PostgreSQL DB.
// Seed uses real producer triggers with a session-local historical clock.
export async function seedUnpaidSupersessionFixture({ pool, period, sourcePolicies, withTarget = false, withCostEvidence = false,
  withSecondPositiveSale = false }) {
  const dbName = (await pool.query('SELECT current_database() AS name')).rows[0].name;
  assert.match(dbName, /^orders_qa_[a-f0-9]{16}$/);
  assert.equal(dbName, process.env.LOCAL_FULL_PG_OWNED_DATABASE);
  const ids = Object.fromEntries(['org','venue','owner','employee','zeroEmployee','product','order','item','zeroItem','pricing','payment','account'].map(k => [k, randomUUID()]));
  const secondPrice = withSecondPositiveSale ? 100 : 0, totalPrice = 100 + secondPrice;
  const clockSchema = 'payroll_seed_clock_' + randomUUID().replaceAll('-', '');
  const seed = await pool.connect();
  let targetSource = null;
  try {
  await seed.query('BEGIN');
  await seed.query(`CREATE SCHEMA "${clockSchema}"`);
  await seed.query(`CREATE FUNCTION "${clockSchema}".transaction_timestamp() RETURNS timestamptz
    LANGUAGE sql STABLE AS $$ SELECT current_setting('qa.payroll_seed_clock')::timestamptz $$`);
  await seed.query(`SET LOCAL search_path="${clockSchema}",public,pg_catalog`);
  await seed.query("SELECT set_config('qa.payroll_seed_clock',$1,true)", [`${period.from}T12:00:00Z`]);
  assert.equal((await seed.query('SELECT transaction_timestamp() < pg_catalog.transaction_timestamp() AS historical')).rows[0].historical, true);
  // Disposable historical-clock fixture only.187 pins its search_path and its
  // defaults bind pg_catalog at DDL time, so the session clock cannot reach it.
  // Preserve every real guard condition and specialize ONLY its clock calls;
  // restore byte-exact function/default definitions before committing any rows.
  let costClock = null;
  const clockDefinitions = async () => ({
    guard: (await seed.query("SELECT pg_get_functiondef('public.guard_pos_sale_cost_evidence()'::regprocedure) AS ddl")).rows[0].ddl,
    defaults: (await seed.query(`SELECT c.relname AS table_name,a.attname AS column_name,pg_get_expr(d.adbin,d.adrelid) AS expression
      FROM pg_attrdef d JOIN pg_class c ON c.oid=d.adrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_attribute a ON a.attrelid=d.adrelid AND a.attnum=d.adnum
      WHERE n.nspname='public' AND (c.relname,a.attname) IN
        (('pos_sale_cost_epochs','activated_at'),('pos_sale_cost_evidence','captured_at')) ORDER BY c.relname`)).rows
  });
  if (withCostEvidence) {
    costClock = await clockDefinitions();
    assert.equal(costClock.defaults.length,2);
    assert.ok(!costClock.guard.includes('payroll_seed_clock_'));
    const clockCall = `"${clockSchema}".transaction_timestamp()`;
    const patched = costClock.guard.replace(/(?<![\w.])transaction_timestamp\(\)/g,clockCall);
    assert.notEqual(patched,costClock.guard);
    assert.equal(patched.split(clockCall).join('transaction_timestamp()'),costClock.guard);
    await seed.query(patched);
    for (const row of costClock.defaults) await seed.query(`ALTER TABLE public.${row.table_name} ALTER COLUMN ${row.column_name} SET DEFAULT ${clockCall}`);
  }
  await seed.query("INSERT INTO organizations(id,name,slug,plan) VALUES($1,'Verified run QA',$2,'network')", [ids.org, `verified-${ids.org}`]);
  await seed.query("INSERT INTO venues(id,organization_id,name,timezone) VALUES($1,$2,'Verified run QA','UTC')", [ids.venue, ids.org]);
  for (const role of ['owner', 'employee', 'zeroEmployee']) {
    await seed.query(`INSERT INTO users(id,venue_id,organization_id,full_name,login,role)
      VALUES($1,$2,$3,$4,$5,$6)`, [ids[role], ids.venue, ids.org, `Verified ${role}`, `verified-${ids[role]}`, role === 'owner' ? 'owner' : 'bartender']);
    await seed.query(`INSERT INTO organization_memberships(organization_id,user_id,membership_role,status)
      VALUES($1,$2,$3,'active')`, [ids.org, ids[role], role === 'owner' ? 'owner' : 'member']);
  }
  await seed.query(`INSERT INTO products(id,venue_id,name,category,sale_price,inventory_mode)
    VALUES($1,$2,'Historical tea','bar',100,'non_stock')`, [ids.product, ids.venue]);
  await seed.query(`INSERT INTO orders(id,venue_id,opened_by,status,created_at)
    VALUES($1,$2,$3,'open',transaction_timestamp())`, [ids.order, ids.venue, ids.owner]);
  await seed.query(`INSERT INTO order_items(id,order_id,product_id,quantity,unit_price,station,sales_employee_id,sold_at)
    VALUES($1,$2,$3,1,100,'bar',$4,transaction_timestamp())`, [ids.item, ids.order, ids.product, ids.employee]);
  await seed.query(`INSERT INTO order_items(id,order_id,product_id,quantity,unit_price,station,sales_employee_id,sold_at)
    VALUES($1,$2,$3,1,$5,'bar',$4,transaction_timestamp())`, [ids.zeroItem, ids.order, ids.product, ids.zeroEmployee,secondPrice]);
  await seed.query(`INSERT INTO pos_order_pricing_snapshots(id,venue_id,order_id,sold_at,transaction_at,
    subtotal_minor,discount_minor,minimum_adjustment_minor,final_total_minor,discount_source,winner_source_ids,
    eligible_item_ids,winner_terms,frozen_terms)
    VALUES($1,$2,$3,transaction_timestamp(),transaction_timestamp(),$5,0,0,$5,'none','{}','{}','{}',$4)`,
  [ids.pricing, ids.venue, ids.order, JSON.stringify({ allocationPolicy: 'largest-remainder-item-id-v1',
    offers: [], inputs: { approvedDiscounts: [], promotions: [] }, minimumAdjustment: 0 }),totalPrice*100]);
  await seed.query(`INSERT INTO pos_order_pricing_snapshot_lines(venue_id,snapshot_id,order_id,order_item_id,seller_id,
    sold_at,quantity,unit_price,gross_minor,discount_minor,net_minor,eligible,product_facts)
    VALUES($1,$2,$3,$4,$5,transaction_timestamp(),1,100,10000,0,10000,false,$6)`,
  [ids.venue, ids.pricing, ids.order, ids.item, ids.employee,
    JSON.stringify({ productId: ids.product, productName: 'Historical tea', category: 'bar', station: 'bar', productActive: true })]);
  await seed.query(`INSERT INTO pos_order_pricing_snapshot_lines(venue_id,snapshot_id,order_id,order_item_id,seller_id,
    sold_at,quantity,unit_price,gross_minor,discount_minor,net_minor,eligible,product_facts)
    VALUES($1,$2,$3,$4,$5,transaction_timestamp(),1,$7,$8,0,$8,false,$6)`,
  [ids.venue, ids.pricing, ids.order, ids.zeroItem, ids.zeroEmployee,
    JSON.stringify({ productId: ids.product, productName: 'Historical tea', category: 'bar', station: 'bar', productActive: true }),secondPrice,secondPrice*100]);
  await seed.query(`INSERT INTO finance_accounts(id,venue_id,code,name,kind,allowed_payment_methods,created_by)
    VALUES($1,$2,'freshness_bank','Freshness QA bank','bank',ARRAY['card']::text[],$3)`, [ids.account, ids.venue, ids.owner]);
  await seed.query(`INSERT INTO payments(id,order_id,method,amount,status,created_at,finance_account_id,finance_account_name_snapshot)
    VALUES($1,$2,'card',$4,'paid',transaction_timestamp(),$3,'Freshness QA bank')`, [ids.payment, ids.order, ids.account,totalPrice]);
  await seed.query(`UPDATE orders SET pricing_locked_at=transaction_timestamp(),pricing_version=1,
    subtotal_snapshot=$2,discount_total_snapshot=0,minimum_adjustment_snapshot=0,final_total_snapshot=$2,
    closed_at=transaction_timestamp(),status='closed' WHERE id=$1`, [ids.order,totalPrice]);

  if (withCostEvidence) {
    // This optional fixture is a real non-stock sale: no inventory consumption
    // exists. Capture the actual locked rows and use the production producer in
    // the close transaction; never backfill a cost payload after the close.
    const cards = (await seed.query(`SELECT oi.id AS "orderItemId",oi.product_id AS "productId",
      oi.quantity::text AS "orderQuantity",p.inventory_mode AS "inventoryMode"
      FROM order_items oi JOIN products p ON p.id=oi.product_id AND p.venue_id=$2
      WHERE oi.order_id=$1 ORDER BY oi.id FOR SHARE OF oi,p`, [ids.order,ids.venue])).rows;
    assert.equal(cards.length,2); assert.ok(cards.every(card => card.inventoryMode === 'non_stock'));
    assert.equal((await seed.query('SELECT count(*)::int AS count FROM stock_movements WHERE venue_id=$1 AND order_id=$2',
      [ids.venue,ids.order])).rows[0].count,0);
    const { createInventoryOrderCostCapture } = require('../inventory-order-cost-capture');
    const { persistSaleCostEvidence } = require('../pos-sale-cost-evidence');
    const capture = createInventoryOrderCostCapture(cards).snapshot();
    assert.equal(capture.status,'captured');
    await seed.query('INSERT INTO order_costs(venue_id,order_id,cost) VALUES($1,$2,0)',[ids.venue,ids.order]);
    const cost = await persistSaleCostEvidence(seed,{venueId:ids.venue,orderId:ids.order,capture});
    assert.equal(cost.payload.status,'complete'); assert.equal(cost.payload.totalCostMinor,0);
  }

    if (withTarget) {
      const { seedCorrectionTargetSources } = await import('./payroll-correction-target-source-fixture.mjs');
      targetSource = await seedCorrectionTargetSources(seed, { ids, period, clockSchema });
    }
    if (costClock) {
      await seed.query(costClock.guard);
      for (const row of costClock.defaults) await seed.query(`ALTER TABLE public.${row.table_name} ALTER COLUMN ${row.column_name} SET DEFAULT ${row.expression}`);
      assert.deepEqual(await clockDefinitions(),costClock,'restore exact187 function/defaults before historical fixture commit');
    }
    await seed.query('COMMIT');
    await seed.query('DROP SCHEMA "' + clockSchema + '" CASCADE');
  } catch (error) { await seed.query('ROLLBACK').catch(() => {}); throw error; }
  finally { seed.release(); }
  const owner = { venueId: ids.venue, userId: ids.owner }, service = makeService(pool);
  await service.createEmploymentEligibilityRevision(owner, { expectedRevisionId: null,
    reason: 'Owner confirms historical unpaid cohort', idempotencyKey: 'supersession-eligible',
    periods: [ids.employee,ids.zeroEmployee].map(employeeId => ({ employeeId, effectiveFrom: period.from, effectiveTo: targetSource?.eligibilityTo || period.to })) });
  const version = (await service.createScheme(owner, { name: 'Unpaid refund-aware whole cohort',
    payoutRiskAcknowledgement: { confirmed: true, policyCode: 'payroll-own-revenue-ceiling-v1' },
    definition: { mode:'percent_only', currency:'RUB', effectiveFrom:period.from, effectiveTo:period.to, applyMilestones:false,
      roleParameters:{bar:{stableRateBps:1000}}, roleAssignments:[ids.employee,ids.zeroEmployee].map(employeeId =>
        ({ employeeId,roleId:'bar',effectiveFrom:period.from,effectiveTo:period.to })), employeeOverrides:[],itemRules:[],sourcePolicies }
  })).versions[0];
  await service.activateVersion(owner,version.versionId);
  const run = await service.createRefundAwareRun(owner,{schemeVersionId:version.versionId,periodFrom:period.from,periodTo:period.to,idempotencyKey:'unpaid-original'});
  assert.equal(run.status,'ready'); assert.equal(run.amountCents,totalPrice*10);
  const refund = async (quantity = '1', key = 'unpaid-source-return') => {
    const client = await pool.connect();
    try {
      await beginPayrollSourceProducerTransaction(client,ids.venue);
      const shift = (await client.query('SELECT id FROM shifts WHERE venue_id=$1 AND closed_at IS NULL FOR UPDATE', [ids.venue])).rows[0]
        || (await client.query('INSERT INTO shifts(venue_id,opened_by) VALUES($1,$2) RETURNING id',[ids.venue,ids.owner])).rows[0];
      const returned = (await client.query(`INSERT INTO order_refunds(venue_id,order_id,shift_id,amount,reason,idempotency_key,actor_id,item_attribution_status)
        VALUES($1,$2,$3,0.50,'Unpaid whole run return',$5,$4,'complete') RETURNING id`,[ids.venue,ids.order,shift.id,ids.owner,key])).rows[0];
      await client.query(`INSERT INTO order_refund_tenders(venue_id,refund_id,order_id,source_payment_id,amount,payout_method,finance_account_id,finance_account_name_snapshot)
        VALUES($1,$2,$3,$4,0.50,'card',$5,'Freshness QA bank')`,[ids.venue,returned.id,ids.order,ids.payment,ids.account]);
      await client.query(`INSERT INTO order_refund_items(venue_id,refund_id,order_id,snapshot_id,order_item_id,returned_quantity,returned_item_value_minor)
        VALUES($1,$2,$3,$4,$5,$6,NULL)`,[ids.venue,returned.id,ids.order,ids.pricing,ids.item,quantity]);
      await client.query('COMMIT');
    } catch(error) { await client.query('ROLLBACK').catch(()=>{}); throw error; }
    finally { client.release(); }
  };
  return {ids,owner,service,version,run,refund,targetSource,period};
}
