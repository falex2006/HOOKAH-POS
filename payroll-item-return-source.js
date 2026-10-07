'use strict';

const {createHash}=require('node:crypto');
const {validateCanonicalPayrollPricingOrder}=require('./payroll-canonical-pricing-source');
const {verifyPayrollItemReturnArithmetic}=require('./payroll-order-refund-evidence');
const fail=suffix=>{throw Object.assign(new TypeError(`payroll_item_return_${suffix}`),{code:`payroll_item_return_${suffix}`});};
const id=value=>{if(typeof value!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value))fail('identity_invalid');return value;};
const cents=value=>{if(typeof value!=='string'||!/^(0|[1-9][0-9]*)$/.test(value)||value.length>16||BigInt(value)>BigInt(Number.MAX_SAFE_INTEGER))fail('amount_invalid');return Number(value);};
const quantity=value=>{if(typeof value!=='string'||value.length>16||!/^(0|[1-9][0-9]*)(?:\.[0-9]{1,3})?$/.test(value))fail('quantity_invalid');const [whole,fraction='']=value.split('.'),result=BigInt(whole)*1000n+BigInt(fraction.padEnd(3,'0'));if(result>999999999999n)fail('quantity_invalid');return result;};
const sequence=value=>{if(typeof value!=='string'||!/^[1-9][0-9]*$/.test(value)||value.length>19||BigInt(value)>9223372036854775807n)fail('sequence_invalid');return BigInt(value);};
const TRANSITIONS=['previous_returned_quantity','cumulative_returned_quantity','previous_returned_item_value_minor','cumulative_returned_item_value_minor'];
// SQL emits UTC timestamps with all six PostgreSQL fractional digits. Do not
// collapse microseconds to Date milliseconds when determining event order.
const stamp=value=>{if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(Date.parse(value)).toISOString()!==value.slice(0,23)+'Z')fail('timestamp_invalid');return value;};
const group=(rows,key)=>{const result=new Map();for(const row of rows){const value=row[key];if(!result.has(value))result.set(value,[]);result.get(value).push(row);}return result;};
const key=row=>`${row.order_id}/${row.snapshot_id}/${row.order_item_id}`;
const observedError=error=>error.code?.startsWith('payroll_item_return_')||error.code?.startsWith('payroll_order_refund_')||error.code?.startsWith('payroll_canonical_pricing_');
const unsupported=reason=>({status:'unsupported',reasons:[reason],scopedRefundCount:null,validatedItemCount:null,sequencedEventCount:null,legacyUnsequencedEventCount:null,post092ValidatedItemCount:null,legacyBaselineItemCount:null,sourceWatermark:null,validationScope:'observed_item_return_arithmetic',paymentLinkage:'not_attested',producerSequence:'not_attested',sequenceScope:'unknown'});

const validateObservedPayrollItemReturnFacts=(facts,{venueId,currency})=>{
  id(venueId);
  const {orders,pricingHeaders,pricingLines,orderItems,refundHeaders,returnItems,scopedRefundIds}=facts;
  for(const rows of [orders,pricingHeaders,pricingLines,orderItems,refundHeaders,returnItems,scopedRefundIds])if(!Array.isArray(rows))fail('shape_invalid');
  const scoped=new Set(scopedRefundIds.map(id));if(scoped.size!==scopedRefundIds.length)fail('identity_duplicate');
  const reasons=new Set(),headers=new Map(),sources=new Map(),sourceLines=new Map(),sourceFailures=new Set(),linesByOrder=group(pricingLines,'order_id'),itemsByOrder=group(orderItems,'order_id'),pricingByOrder=new Map(pricingHeaders.map(row=>[row.order_id,row]));
  let missingSourceCount=0,invalidItemCount=0,ambiguousItemCount=0,validatedItemCount=0,unknownAttributionItemCount=0,unsupportedCrossVenueItemCount=0;
  const sequencedEventCount=returnItems.filter(row=>row.producer_sequence!=null).length,legacyUnsequencedEventCount=returnItems.length-sequencedEventCount;
  let post092ValidatedItemCount=0,legacyBaselineItemCount=0;
  if(legacyUnsequencedEventCount)reasons.add('item_return_legacy_unsequenced');
  for(const order of orders){const header=pricingByOrder.get(order.id);if(!header){sourceFailures.add(order.id);reasons.add('item_return_canonical_source_missing');continue;}
    try{const result=validateCanonicalPayrollPricingOrder({order,header,lines:linesByOrder.get(order.id)||[],itemIds:(itemsByOrder.get(order.id)||[]).map(row=>row.id)},{venueId,currency});sources.set(order.id,result.order);for(const line of result.order.lineSnapshots)sourceLines.set(`${order.id}/${result.order.snapshotId}/${line.orderItemId}`,line);}
    catch(error){if(!observedError(error))throw error;sourceFailures.add(order.id);reasons.add(error.code);}
  }
  for(const header of refundHeaders){id(header.id);if(headers.has(header.id))fail('identity_duplicate');headers.set(header.id,header);}
  for(const refundId of scoped)if(!headers.has(refundId))fail('scoped_header_missing');
  const scopedHeaders=refundHeaders.filter(row=>scoped.has(row.id)),byRefund=group(returnItems,'refund_id');
  let completeHeaderCount=0,unattributedHeaderCount=0,notApplicableHeaderCount=0,unknownHistoryHeaderCount=0;
  for(const header of refundHeaders){
    const rows=byRefund.get(header.id)||[],inScope=scoped.has(header.id);
    if(inScope){if(header.item_attribution_status==='complete')completeHeaderCount++;else if(header.item_attribution_status==='unattributed')unattributedHeaderCount++;else if(header.item_attribution_status==='not_applicable')notApplicableHeaderCount++;}
    if(header.venue_id!==venueId||!['complete','unattributed','not_applicable'].includes(header.item_attribution_status)||(header.item_attribution_status==='complete'?rows.length===0:rows.length!==0)){reasons.add('item_return_header_classification_invalid');}
    if(header.item_attribution_status==='unattributed'){unknownHistoryHeaderCount++;reasons.add('item_return_unattributed_history');}
    if(!sources.has(header.order_id)){reasons.add('item_return_canonical_source_missing');}
  }
  const seen=new Set();for(const row of returnItems){id(row.id);if(seen.has(row.id))fail('identity_duplicate');seen.add(row.id);}
  const histories=group(returnItems,'order_item_id');
  for(const history of histories.values()){
    const first=history[0],source=sources.get(first.order_id),line=sourceLines.get(key(first));
    if(!line||sourceFailures.has(first.order_id)){missingSourceCount++;reasons.add('item_return_canonical_source_missing');continue;}
    if(line.attributionStatus==='unknown'){unknownAttributionItemCount++;reasons.add('item_return_seller_unknown');}
    if(line.attributionStatus==='unsupported'){unsupportedCrossVenueItemCount++;reasons.add('cross_venue_payroll_employee_unsupported');}
    try{
      const legacy=[],sequenced=[];
      for(const row of history){const header=headers.get(row.refund_id);id(row.refund_id);id(row.order_id);id(row.snapshot_id);id(row.order_item_id);
        if(!header||header.venue_id!==venueId||row.venue_id!==venueId||header.order_id!==row.order_id||header.item_attribution_status!=='complete'||key(row)!==key(first)||row.return_policy_version!==1)fail('lineage_policy_invalid');
        const time=stamp(row.created_at);if(time!==stamp(header.created_at)||time<stamp(source.closedAt))fail('chronology_invalid');
        cents(row.returned_item_value_minor);
        if(quantity(row.returned_quantity)===0n)fail('quantity_invalid');
        if(row.producer_sequence==null){if(TRANSITIONS.some(field=>row[field]!=null))fail('sequence_transition_missing');legacy.push(row);}
        else{sequence(row.producer_sequence);if(TRANSITIONS.some(field=>row[field]==null))fail('sequence_transition_missing');sequenced.push(row);}
      }
      if(legacy.length)reasons.add('item_return_legacy_unsequenced');
      if(sequenced.length){
        let baselineQuantity=legacy.reduce((sum,row)=>sum+quantity(row.returned_quantity),0n),baselineValue=legacy.reduce((sum,row)=>sum+BigInt(cents(row.returned_item_value_minor)),0n);
        const originalQuantity=quantity(line.quantity),originalValue=BigInt(line.netSaleCents);
        if(baselineQuantity>originalQuantity||baselineValue>originalValue||baselineValue!==(2n*originalValue*baselineQuantity+originalQuantity)/(2n*originalQuantity))fail('legacy_baseline_invalid');
        if(legacy.length)legacyBaselineItemCount++;
        let expectedSequence=1n;
        for(const row of sequenced.slice().sort((a,b)=>sequence(a.producer_sequence)<sequence(b.producer_sequence)?-1:1)){
          if(sequence(row.producer_sequence)!==expectedSequence)fail('sequence_gap_or_duplicate');expectedSequence++;
          if(quantity(row.previous_returned_quantity)!==baselineQuantity||BigInt(cents(row.previous_returned_item_value_minor))!==baselineValue)fail('previous_transition_mismatch');
          const arithmetic=verifyPayrollItemReturnArithmetic({originalQuantity:line.quantity,originalNetCents:line.netSaleCents,previousReturnedQuantity:row.previous_returned_quantity,previousReturnedItemValueCents:cents(row.previous_returned_item_value_minor),returnedQuantity:row.returned_quantity,returnedItemValueCents:cents(row.returned_item_value_minor)});
          if(quantity(row.cumulative_returned_quantity)!==quantity(arithmetic.cumulativeReturnedQuantity)||cents(row.cumulative_returned_item_value_minor)!==arithmetic.cumulativeReturnedItemValueCents)fail('cumulative_transition_mismatch');
          baselineQuantity=quantity(row.cumulative_returned_quantity);baselineValue=BigInt(cents(row.cumulative_returned_item_value_minor));
        }
        post092ValidatedItemCount++;
        if(!legacy.length){validatedItemCount++;continue;}
      }
      const legacyTimestamps=new Set(legacy.map(row=>row.created_at));
      if(legacyTimestamps.size!==legacy.length){ambiguousItemCount++;reasons.add('item_return_chronology_ambiguous');continue;}
      let previousQuantity='0.000',previousValue=0;
      for(const row of legacy.slice().sort((a,b)=>a.created_at<b.created_at?-1:1)){
        const result=verifyPayrollItemReturnArithmetic({originalQuantity:line.quantity,originalNetCents:line.netSaleCents,previousReturnedQuantity:previousQuantity,previousReturnedItemValueCents:previousValue,returnedQuantity:row.returned_quantity,returnedItemValueCents:cents(row.returned_item_value_minor)});
        previousQuantity=result.cumulativeReturnedQuantity;previousValue=result.cumulativeReturnedItemValueCents;
      }
      validatedItemCount++;
    }catch(error){if(!observedError(error))throw error;invalidItemCount++;reasons.add(error.code);}
  }
  return {status:reasons.size?'incomplete':'available',reasons:[...reasons].sort(),scopedRefundCount:scopedHeaders.length,completeHeaderCount,unattributedHeaderCount,notApplicableHeaderCount,scopedItemReturnCount:returnItems.filter(row=>scoped.has(row.refund_id)).length,inspectedSourceItemCount:histories.size,fullHistoryRowCount:returnItems.length,validatedItemCount,invalidItemCount,ambiguousItemCount,missingSourceCount,unknownHistoryHeaderCount,unknownAttributionItemCount,unsupportedCrossVenueItemCount,sequencedEventCount,legacyUnsequencedEventCount,post092ValidatedItemCount,legacyBaselineItemCount,validationScope:'observed_item_return_arithmetic',historyScope:'full_observed_history_of_related_orders',paymentLinkage:'not_attested',producerSequence:sequencedEventCount&&!legacyUnsequencedEventCount&&!invalidItemCount&&!missingSourceCount?'per_source_post_092':'not_attested',sequenceScope:sequencedEventCount?(legacyUnsequencedEventCount?'mixed_post_092_and_legacy':'per_source_post_092'):(legacyUnsequencedEventCount?'legacy_unsequenced':'none')};
};

const readPayrollItemReturnEvidenceInTransaction=async(db,{venueId,currency,from,to,timezone})=>{
  const ready=(await db.query("SELECT to_regclass('order_refund_items') IS NOT NULL AND to_regclass('order_refunds') IS NOT NULL AND to_regclass('pos_order_pricing_snapshots') IS NOT NULL AND to_regclass('pos_order_pricing_snapshot_lines') IS NOT NULL AS ready")).rows[0]?.ready;
  if(!ready)return unsupported('item_return_evidence_schema_missing');
  const scoped=(await db.query(`SELECT r.id::text,r.order_id::text FROM order_refunds r JOIN orders o ON o.id=r.order_id AND o.venue_id=r.venue_id WHERE r.venue_id=$1 AND ((r.created_at>=($2::date::timestamp AT TIME ZONE $4) AND r.created_at<(($3::date+1)::timestamp AT TIME ZONE $4)) OR (o.status='closed' AND o.closed_at>=($2::date::timestamp AT TIME ZONE $4) AND o.closed_at<(($3::date+1)::timestamp AT TIME ZONE $4))) ORDER BY r.id`,[venueId,from,to,timezone])).rows;
  const orderIds=[...new Set(scoped.map(row=>row.order_id))].sort(),params=[venueId,orderIds];
  const time=column=>`to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
  const orders=(await db.query(`SELECT id::text,venue_id::text,${time('closed_at')} AS closed_at,${time('pricing_locked_at')} AS pricing_locked_at FROM orders WHERE venue_id=$1 AND id=ANY($2::uuid[]) ORDER BY id`,params)).rows;
  const pricingHeaders=(await db.query(`SELECT s.*,${time('s.transaction_at')} AS transaction_at FROM pos_order_pricing_snapshots s WHERE s.venue_id=$1 AND s.order_id=ANY($2::uuid[]) ORDER BY s.order_id`,params)).rows;
  const pricingLines=(await db.query(`SELECT l.*,l.quantity::text AS quantity,l.unit_price::text AS unit_price,l.sold_at::text AS sold_at,EXISTS(SELECT 1 FROM users u WHERE u.id=l.seller_id AND u.venue_id=l.venue_id) AS seller_in_venue,EXISTS(SELECT 1 FROM users u JOIN venues v ON v.id=l.venue_id WHERE u.id=l.seller_id AND v.organization_id IS NOT NULL AND (u.organization_id=v.organization_id OR EXISTS(SELECT 1 FROM organization_memberships m WHERE m.organization_id=v.organization_id AND m.user_id=u.id AND m.status='active'))) AS seller_in_organization FROM pos_order_pricing_snapshot_lines l WHERE l.venue_id=$1 AND l.order_id=ANY($2::uuid[]) ORDER BY l.order_id,l.order_item_id`,params)).rows;
  const orderItems=(await db.query(`SELECT oi.id::text,oi.order_id::text FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE o.venue_id=$1 AND o.id=ANY($2::uuid[]) ORDER BY oi.order_id,oi.id`,params)).rows;
  const refundHeaders=(await db.query(`SELECT r.id::text,r.venue_id::text,r.order_id::text,r.item_attribution_status,${time('r.created_at')} AS created_at FROM order_refunds r WHERE r.venue_id=$1 AND r.order_id=ANY($2::uuid[]) ORDER BY r.id`,params)).rows;
  const sequenceCapability=(await db.query(`SELECT count(*)::int AS column_count,count(*)=5 AS ready FROM pg_attribute WHERE attrelid=to_regclass('order_refund_items') AND NOT attisdropped AND attname=ANY($1::text[])`,[['producer_sequence',...TRANSITIONS]])).rows[0];
  if(sequenceCapability?.column_count>0&&sequenceCapability.column_count<5)return unsupported('item_return_sequence_schema_incomplete');
  const hasSequence=sequenceCapability?.ready;
  const transitionColumns=['producer_sequence',...TRANSITIONS].map(field=>`${hasSequence?'i.'+field+'::text':'NULL::text'} AS ${field}`).join(',');
  // Legacy UUID ordering only makes the raw watermark deterministic; it never
  // supplies a missing sequence. Sequenced rows use the persisted source order.
  const returnOrder=hasSequence?'i.order_id,i.snapshot_id,i.order_item_id,i.producer_sequence NULLS FIRST,i.id':'i.order_id,i.snapshot_id,i.order_item_id,i.created_at,i.id';
  const returnItems=(await db.query(`SELECT i.id::text,i.venue_id::text,i.refund_id::text,i.order_id::text,i.snapshot_id::text,i.order_item_id::text,i.returned_quantity::text,i.returned_item_value_minor::text,i.return_policy_version,${transitionColumns},${time('i.created_at')} AS created_at FROM order_refund_items i WHERE i.venue_id=$1 AND i.order_id=ANY($2::uuid[]) ORDER BY ${returnOrder}`,params)).rows;
  const facts={orders,pricingHeaders,pricingLines,orderItems,refundHeaders,returnItems,scopedRefundIds:scoped.map(row=>row.id)};
  return {...validateObservedPayrollItemReturnFacts(facts,{venueId,currency}),sourceWatermark:createHash('sha256').update(JSON.stringify({venueId,currency,from,to,timezone,facts})).digest('hex'),watermarkScope:'scoped_refund_headers_and_full_related_order_item_history'};
};
module.exports={validateObservedPayrollItemReturnFacts,readPayrollItemReturnEvidenceInTransaction};
