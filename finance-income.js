'use strict';
const { orderPricingSqlCtes } = require('./pos-order-pricing-sql');

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isoDate = (value) => { const raw=String(value||'');if(!/^\d{4}-\d{2}-\d{2}$/.test(raw))return false;const d=new Date(`${raw}T00:00:00Z`);return !Number.isNaN(d.getTime())&&d.toISOString().slice(0,10)===raw; };
const sourceKeyLength = (value) => Array.from(value).length;
const fail = (json,res,status,error) => { json(res,status,{error});return true; };
const mapRow = async (client,venueId,sourceKey,venueDate) => {
  const {rows}=await client.query(`SELECT m.id,m.category_id AS "categoryId",m.category_name_snapshot AS "categoryName"
    FROM (SELECT * FROM finance_income_category_mappings WHERE venue_id=$1 AND source_key=$2 AND effective_from<=$3::date ORDER BY effective_from DESC,revision DESC,id DESC LIMIT 1) m
    JOIN finance_categories c ON c.venue_id=m.venue_id AND c.id=m.category_id AND c.kind='income' AND c.active=true`,[venueId,sourceKey,venueDate]);
  return rows[0]||null;
};

async function writePosOrderIncomeCategorySnapshot(client,{venueId,orderId}) {
  const prior=await client.query('SELECT id FROM pos_order_income_category_snapshots WHERE venue_id=$1 AND order_id=$2',[venueId,orderId]);
  if(prior.rows[0])return prior.rows[0].id;
  const source=await client.query(`SELECT s.id AS "pricingSnapshotId",s.final_total_minor AS "recognizedTotalMinor",s.minimum_adjustment_minor AS "minimumAdjustmentMinor",
      o.closed_at::text AS "closedAt",COALESCE(NULLIF(v.timezone,''),NULLIF(org.timezone,''),'Asia/Yekaterinburg') AS "venueTimezone",
      (o.closed_at AT TIME ZONE COALESCE(NULLIF(v.timezone,''),NULLIF(org.timezone,''),'Asia/Yekaterinburg'))::date::text AS "venueDate"
    FROM orders o JOIN venues v ON v.id=o.venue_id
    LEFT JOIN organizations org ON org.id=v.organization_id
    JOIN pos_order_pricing_snapshots s ON s.venue_id=o.venue_id AND s.order_id=o.id
    WHERE o.venue_id=$1 AND o.id=$2 AND o.status='closed' AND o.closed_at IS NOT NULL
    FOR SHARE OF v`,[venueId,orderId]);
  if(!source.rows[0])return null;
  const head=source.rows[0];
  const header=await client.query(`INSERT INTO pos_order_income_category_snapshots
    (venue_id,order_id,pricing_snapshot_id,closed_at,venue_date,venue_timezone_snapshot,recognized_total_minor,unmapped_minor,status)
    VALUES($1,$2,$3,$4,$5,$6,$7,0,'building') RETURNING id`,[venueId,orderId,head.pricingSnapshotId,head.closedAt,head.venueDate,head.venueTimezone,head.recognizedTotalMinor]);
  const snapshotId=header.rows[0].id;
  const lines=await client.query(`SELECT order_item_id AS "orderItemId",net_minor AS "amountMinor",
      COALESCE(product_facts->>'category','') AS "sourceKey",
      COALESCE(product_facts->>'station','') AS "stationSnapshot",
      COALESCE(product_facts->>'productName','Позиция') AS "productName"
    FROM pos_order_pricing_snapshot_lines WHERE venue_id=$1 AND snapshot_id=$2 AND order_id=$3 ORDER BY order_item_id`,[venueId,head.pricingSnapshotId,orderId]);
  let unmapped=0n;
  for(const line of lines.rows){
    const rawSourceKey=String(line.sourceKey||'');
    const sourceKey=sourceKeyLength(rawSourceKey)>0&&sourceKeyLength(rawSourceKey)<=500?(rawSourceKey==='@minimum-adjustment'?'@menu:@minimum-adjustment':rawSourceKey==='@unclassified'?'@menu:@unclassified':rawSourceKey):'@unclassified';
    const mapping=sourceKey==='@unclassified'?null:await mapRow(client,venueId,sourceKey,head.venueDate);
    const amount=BigInt(line.amountMinor||0);if(!mapping)unmapped+=amount;
    await client.query(`INSERT INTO pos_order_income_category_allocations
      (venue_id,income_snapshot_id,order_id,allocation_kind,order_item_id,source_key,source_station_snapshot,source_menu_category,source_product_name,mapping_id,category_id,category_name_snapshot,amount_minor)
      VALUES($1,$2,$3,'item',$4,$5,$6,$7,$8,$9,$10,$11,$12)`,[venueId,snapshotId,orderId,line.orderItemId,sourceKey,String(line.stationSnapshot||'').slice(0,80),rawSourceKey,String(line.productName||'Позиция').slice(0,200),mapping?.id||null,mapping?.categoryId||null,mapping?.categoryName||'Не распределено',amount.toString()]);
  }
  const adjustment=BigInt(head.minimumAdjustmentMinor||0);
  if(adjustment>0n){
    const mapping=await mapRow(client,venueId,'@minimum-adjustment',head.venueDate);if(!mapping)unmapped+=adjustment;
    await client.query(`INSERT INTO pos_order_income_category_allocations
      (venue_id,income_snapshot_id,order_id,allocation_kind,source_key,source_station_snapshot,source_menu_category,source_product_name,mapping_id,category_id,category_name_snapshot,amount_minor)
      VALUES($1,$2,$3,'minimum_adjustment','@minimum-adjustment','','','',$4,$5,$6,$7)`,[venueId,snapshotId,orderId,mapping?.id||null,mapping?.categoryId||null,mapping?.categoryName||'Не распределено',adjustment.toString()]);
  }
  const status=unmapped>0n?'unmapped':'complete';
  await client.query('UPDATE pos_order_income_category_snapshots SET unmapped_minor=$3,status=$4 WHERE venue_id=$1 AND id=$2',[venueId,snapshotId,unmapped.toString(),status]);
  return snapshotId;
}

async function handleFinanceIncomeRoute({req,res,url,pool,venueId,json,readBody,hasPermission,recordAudit,resolveVenues}) {
  const path=url.pathname;const mappingsPath=path==='/api/finance/income-category-mappings';const reportPath=path==='/api/finance/income-category-report';
  if(!mappingsPath&&!reportPath)return false;
  if(!hasPermission('finance')&&!hasPermission('finance_read'))return fail(json,res,403,'forbidden');
  if(req.method==='GET'&&['bartender','hookah_master','senior_bartender','senior_hookah_master','cleaner','security','technician','other_staff','staff'].includes(String(req.user?.role||'').toLowerCase()))return fail(json,res,403,'forbidden');
  if(req.method!=='GET'&&!hasPermission('finance'))return fail(json,res,403,'forbidden');
  if(!pool)return fail(json,res,503,'finance_database_required');
  if(mappingsPath&&req.method==='GET'){
    try{
      const [mappings,sources]=await Promise.all([
        pool.query(`SELECT m.id,m.source_key AS "sourceKey",m.effective_from AS "effectiveFrom",m.category_id AS "categoryId",m.category_name_snapshot AS "categoryName",m.supersedes_mapping_id AS "supersedesMappingId",m.revision,m.created_at AS "createdAt",c.active AS "categoryActive"
          FROM finance_income_category_mappings m JOIN finance_categories c ON c.venue_id=m.venue_id AND c.id=m.category_id WHERE m.venue_id=$1 ORDER BY m.source_key,m.effective_from DESC,m.revision DESC,m.id DESC`,[venueId]),
        pool.query(`SELECT source_key AS "sourceKey",MAX(station) AS station,MAX(menu_category) AS "menuCategory",MAX(example_product) AS "exampleProduct",SUM(sale_lines)::int AS "saleLines"
          FROM (
            SELECT source_key,MAX(source_station_snapshot) AS station,MAX(source_menu_category) AS menu_category,MAX(source_product_name) AS example_product,COUNT(*)::int AS sale_lines
              FROM pos_order_income_category_allocations WHERE venue_id=$1 AND allocation_kind='item' AND source_key<>'@unclassified' GROUP BY source_key
            UNION ALL
            SELECT CASE WHEN p.category='@minimum-adjustment' THEN '@menu:@minimum-adjustment' WHEN p.category='@unclassified' THEN '@menu:@unclassified' ELSE p.category END AS source_key,''::text AS station,p.category AS menu_category,MAX(p.name) AS example_product,0::int AS sale_lines
              FROM products p WHERE p.venue_id=$1 AND p.is_active=true AND length(btrim(COALESCE(p.category,'')))>0 GROUP BY p.category
          ) available_sources GROUP BY source_key ORDER BY source_key`,[venueId]),
      ]);
      return json(res,200,{items:mappings.rows,sources:sources.rows});
    }catch(error){return json(res,503,{error:'finance_income_mappings_unavailable'});}
  }
  if(mappingsPath&&req.method==='POST'){
    const input=await readBody(req);const sourceKey=String(input.sourceKey||'');const categoryId=String(input.categoryId||'');const effectiveFrom=String(input.effectiveFrom||'');const expectedMappingId=input.expectedMappingId==null?'':String(input.expectedMappingId);
    if((sourceKey!=='@minimum-adjustment'&&(!sourceKey.trim()||sourceKeyLength(sourceKey)>500))||!uuid.test(categoryId)||!isoDate(effectiveFrom)||!effectiveFrom.endsWith('-01'))return fail(json,res,400,'invalid_finance_income_mapping');
    const client=await pool.connect();try{await client.query('BEGIN');
      const date=await client.query("SELECT date_trunc('month',now() AT TIME ZONE timezone)::date::text AS date FROM venues WHERE id=$1",[venueId]);
      if(!date.rows[0]||effectiveFrom<date.rows[0].date){await client.query('ROLLBACK');return fail(json,res,409,'finance_income_mapping_must_be_current_or_future');}
      const source=await client.query(`SELECT EXISTS(SELECT 1 FROM products WHERE venue_id=$1 AND is_active=true AND category=CASE WHEN $2='@menu:@minimum-adjustment' THEN '@minimum-adjustment' WHEN $2='@menu:@unclassified' THEN '@unclassified' ELSE $2 END)
        OR EXISTS(SELECT 1 FROM pos_order_income_category_allocations WHERE venue_id=$1 AND source_key=$2 AND allocation_kind='item')
        OR EXISTS(SELECT 1 FROM finance_income_category_mappings WHERE venue_id=$1 AND source_key=$2)
        AS available`,[venueId,sourceKey]);
      if(sourceKey!=='@minimum-adjustment'&&!source.rows[0]?.available){await client.query('ROLLBACK');return fail(json,res,400,'finance_income_source_not_found');}
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${venueId}:${sourceKey}:${effectiveFrom}`]);
      const category=await client.query("SELECT id,name FROM finance_categories WHERE venue_id=$1 AND id=$2 AND kind='income' AND active=true FOR KEY SHARE",[venueId,categoryId]);
      if(!category.rows[0]){await client.query('ROLLBACK');return fail(json,res,400,'invalid_finance_income_category');}
      const previous=await client.query(`SELECT id,category_id,category_name_snapshot,revision FROM finance_income_category_mappings
        WHERE venue_id=$1 AND source_key=$2 AND effective_from=$3::date ORDER BY revision DESC,id DESC LIMIT 1 FOR UPDATE`,[venueId,sourceKey,effectiveFrom]);
      if(previous.rows[0]?.category_id===categoryId&&previous.rows[0]?.category_name_snapshot===category.rows[0].name){
        await client.query('COMMIT');return json(res,200,{id:previous.rows[0].id,sourceKey,categoryId,categoryName:category.rows[0].name,effectiveFrom,idempotent:true});
      }
      if((previous.rows[0]?.id||'')!==expectedMappingId){await client.query('ROLLBACK');return fail(json,res,409,'finance_income_mapping_changed_retry');}
      const result=await client.query(`INSERT INTO finance_income_category_mappings(venue_id,source_key,category_id,category_name_snapshot,effective_from,revision,supersedes_mapping_id,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,source_key AS "sourceKey",category_id AS "categoryId",category_name_snapshot AS "categoryName",effective_from AS "effectiveFrom",revision,supersedes_mapping_id AS "supersedesMappingId",created_at AS "createdAt"`,[venueId,sourceKey,categoryId,category.rows[0].name,effectiveFrom,(previous.rows[0]?.revision||0)+1,previous.rows[0]?.id||null,req.user?.id||null]);
      await client.query('COMMIT');recordAudit?.(req,previous.rows[0]?'finance.income_category_mapping_corrected':'finance.income_category_mapping_created','finance_income_category_mapping',result.rows[0].id,previous.rows[0]||null,result.rows[0]);return json(res,previous.rows[0]?200:201,result.rows[0]);
    }catch(error){await client.query('ROLLBACK').catch(()=>{});return json(res,503,{error:'finance_income_mapping_save_failed'});}finally{client.release();}
  }
  if(reportPath&&req.method==='GET'){
    const from=String(url.searchParams.get('from')||'');const to=String(url.searchParams.get('to')||'');
    if(!isoDate(from)||!isoDate(to)||from>to)return fail(json,res,400,'invalid_finance_income_report_range');
    let selectedVenue=null;
    try{
      if(resolveVenues){
        const selectedVenueId=String(url.searchParams.get('venueId')||venueId||'');
        const venues=await resolveVenues(req,selectedVenueId);
        selectedVenue=venues.find(item=>String(item.id)===selectedVenueId)||null;
        if(!selectedVenue)return fail(json,res,403,'forbidden');
        venueId=selectedVenue.id;
      }
      const [sales,legacy,historicalUnclassified,refunds,refundCoverage]=await Promise.all([
        pool.query(`SELECT a.category_id AS "categoryId",a.category_name_snapshot AS "categoryName",SUM(a.amount_minor)::text AS "amountMinor",COUNT(DISTINCT s.order_id)::int AS "orderCount",COUNT(*)::int AS "allocationCount"
          FROM pos_order_income_category_snapshots s JOIN pos_order_income_category_allocations a ON a.venue_id=s.venue_id AND a.income_snapshot_id=s.id
          WHERE s.venue_id=$1 AND s.venue_date BETWEEN $2::date AND $3::date AND s.status IN ('complete','unmapped')
          GROUP BY a.category_id,a.category_name_snapshot ORDER BY a.category_id NULLS LAST,a.category_name_snapshot`,[venueId,from,to]),
        pool.query(`WITH ${orderPricingSqlCtes}
          SELECT COUNT(*)::int AS count,COALESCE(SUM(COALESCE(o.final_total_snapshot,
            GREATEST(0,GREATEST(COALESCE(o.vip_minimum,0),COALESCE(i.subtotal,0)-COALESCE(d.discount,0))))),0)::numeric(14,2)::text AS amount
          FROM orders o JOIN venues v ON v.id=o.venue_id LEFT JOIN pos_order_pricing_snapshots s ON s.venue_id=o.venue_id AND s.order_id=o.id
          LEFT JOIN item_totals i ON i.order_id=o.id LEFT JOIN discount_totals d ON d.order_id=o.id
          WHERE o.venue_id=$1 AND o.status='closed' AND s.id IS NULL AND (o.closed_at AT TIME ZONE v.timezone)::date BETWEEN $2::date AND $3::date`,[venueId,from,to]),
        pool.query(`SELECT COUNT(*)::int AS count,COALESCE(SUM(s.final_total_minor),0)::text AS "amountMinor"
          FROM orders o JOIN venues v ON v.id=o.venue_id
          JOIN pos_order_pricing_snapshots s ON s.venue_id=o.venue_id AND s.order_id=o.id
          LEFT JOIN pos_order_income_category_snapshots income ON income.venue_id=o.venue_id AND income.order_id=o.id
          WHERE o.venue_id=$1 AND o.status='closed' AND income.id IS NULL
            AND (o.closed_at AT TIME ZONE v.timezone)::date BETWEEN $2::date AND $3::date`,[venueId,from,to]),
        pool.query(`SELECT a.category_id AS "categoryId",a.category_name_snapshot AS "categoryName",SUM(ri.returned_item_value_minor)::text AS "amountMinor",COUNT(DISTINCT ri.refund_id)::int AS "refundCount",COUNT(*)::int AS "returnedLineCount"
          FROM order_refunds r JOIN order_refund_items ri ON ri.venue_id=r.venue_id AND ri.refund_id=r.id AND ri.order_id=r.order_id
          JOIN pos_order_income_category_snapshots s ON s.venue_id=ri.venue_id AND s.order_id=ri.order_id
          JOIN pos_order_income_category_allocations a ON a.venue_id=s.venue_id AND a.income_snapshot_id=s.id AND a.order_item_id=ri.order_item_id
          WHERE r.venue_id=$1 AND (r.created_at AT TIME ZONE (SELECT timezone FROM venues WHERE id=$1))::date BETWEEN $2::date AND $3::date
          GROUP BY a.category_id,a.category_name_snapshot ORDER BY a.category_id NULLS LAST,a.category_name_snapshot`,[venueId,from,to]),
        pool.query(`SELECT COUNT(*) FILTER(WHERE r.item_attribution_status='unattributed')::int AS "unattributedRefunds",COUNT(*) FILTER(WHERE r.item_attribution_status='complete')::int AS "itemAttributedRefunds"
          FROM order_refunds r WHERE r.venue_id=$1 AND (r.created_at AT TIME ZONE (SELECT timezone FROM venues WHERE id=$1))::date BETWEEN $2::date AND $3::date`,[venueId,from,to]),
      ]);
      const unclassified=sales.rows.find(row=>row.categoryId===null)||null;
      return json(res,200,{from,to,dateBasis:'venue_local_closed_at',...(selectedVenue?{venue:{id:selectedVenue.id,name:selectedVenue.name,timeZone:selectedVenue.timeZone}}:{}),items:sales.rows,refundItemValues:refunds.rows,
        coverage:{legacyUnclassifiedSalesCount:legacy.rows[0]?.count||0,legacyUnclassifiedSalesAmount:legacy.rows[0]?.amount||'0.00',pricedWithoutCategorySnapshotCount:historicalUnclassified.rows[0]?.count||0,pricedWithoutCategorySnapshotAmountMinor:historicalUnclassified.rows[0]?.amountMinor||'0',unmappedSalesAmountMinor:unclassified?.amountMinor||'0',unmappedAllocationCount:sales.rows.filter(row=>row.categoryId===null).reduce((sum,row)=>sum+Number(row.allocationCount||0),0),unattributedRefunds:refundCoverage.rows[0]?.unattributedRefunds||0,itemAttributedRefunds:refundCoverage.rows[0]?.itemAttributedRefunds||0,refundRecognition:'not_connected',refundItemValuesAreNotRevenueReversals:true}});
    }catch(error){return json(res,503,{error:'finance_income_report_unavailable'});}
  }
  return fail(json,res,405,'method_not_allowed');
}

module.exports={handleFinanceIncomeRoute,writePosOrderIncomeCategorySnapshot};
