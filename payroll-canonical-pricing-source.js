'use strict';

const {createHash}=require('node:crypto');
const {allocateIncentiveFund}=require('./payroll-incentive-math');
const MAX=BigInt(Number.MAX_SAFE_INTEGER);
const fail=suffix=>{const code=`payroll_canonical_pricing_${suffix}`;throw Object.assign(new TypeError(code),{code});};
const uuid=value=>{if(typeof value!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value))fail('identity_invalid');return value;};
const minor=value=>{if(typeof value!=='string'||!/^(0|[1-9][0-9]*)$/.test(value)||value.length>16)fail('amount_invalid');const n=BigInt(value);if(n>MAX)fail('amount_overflow');return n;};
const decimal=(value,scale,positive)=>{if(typeof value!=='string'||value.length>16||!new RegExp(`^(0|[1-9][0-9]*)(?:\\.[0-9]{1,${scale}})?$`).test(value))fail('decimal_invalid');const [whole,fraction='']=value.split('.'),n=BigInt(whole)*10n**BigInt(scale)+BigInt(fraction.padEnd(scale,'0'));if(n>999999999999n||(positive&&n===0n))fail('decimal_invalid');return n;};
// PostgreSQL timestamptz stores microseconds. Date.parse alone would silently
// accept a sale after lock, or a different capture instant within the same ms.
const timestamp=value=>{
  const match=typeof value==='string'&&value.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}(?::\d{2}(?::\d{2})?|\d{2}(?:\d{2})?)?)$/);
  if(!match)fail('timestamp_invalid');
  const civil=`${match[1]}T${match[2]}:${match[3]}:${match[4]}`,milliseconds=Date.parse(civil+'.000Z');
  if(!Number.isFinite(milliseconds)||new Date(milliseconds).toISOString().slice(0,19)!==civil)fail('timestamp_invalid');
  let offset=0n;
  if(match[6]!=='Z'){
    const digits=match[6].slice(1).replaceAll(':',''),hours=Number(digits.slice(0,2)),minutes=Number(digits.slice(2,4)||0),seconds=Number(digits.slice(4,6)||0);
    if(![2,4,6].includes(digits.length)||hours>23||minutes>59||seconds>59)fail('timestamp_invalid');
    offset=BigInt(hours*3600+minutes*60+seconds)*1000000n*(match[6][0]==='-'?-1n:1n);
  }
  return BigInt(milliseconds)*1000n+BigInt((match[5]||'').padEnd(6,'0'))-offset;
};
const ids=value=>{if(!Array.isArray(value))fail('item_set_invalid');value.forEach(uuid);const sorted=[...value].sort();if(new Set(value).size!==value.length||JSON.stringify(value)!==JSON.stringify(sorted))fail('item_set_invalid');return sorted;};
const sameSet=(a,b)=>{if(JSON.stringify(a)!==JSON.stringify(b))fail('item_coverage_invalid');};

// Validates merchandise pricing only. No commission eligibility, shift facts,
// refund coverage or official payroll readiness are inferred from a price.
const validateCanonicalPayrollPricingOrder=({order,header,lines,itemIds},{venueId,currency})=>{
  uuid(venueId);uuid(order.id);uuid(header.id);
  if(order.venue_id!==venueId||header.venue_id!==venueId||header.order_id!==order.id)fail('tenant_invalid');
  if(header.schema_version!==1||header.policy_version!==1||header.currency_scale!==2||header.currency_code!=='RUB'||currency!==header.currency_code)fail('version_currency_invalid');
  if(header.frozen_terms?.allocationPolicy!=='largest-remainder-item-id-v1')fail('policy_invalid');
  const closed=timestamp(order.closed_at),locked=timestamp(order.pricing_locked_at),captured=timestamp(header.transaction_at);
  if(locked!==captured||captured>closed)fail('chronology_invalid');
  const subtotal=minor(header.subtotal_minor),discount=minor(header.discount_minor),minimum=minor(header.minimum_adjustment_minor),final=minor(header.final_total_minor);
  if(discount>subtotal||final!==subtotal-discount+minimum)fail('header_conservation_invalid');
  if(!Array.isArray(lines))fail('lines_invalid');
  const current=ids([...itemIds].sort()),lineIds=lines.map(l=>uuid(l.order_item_id));sameSet(current,ids([...lineIds].sort()));
  const portions=new Set(),eligible=[],grossRows=[];let grossSum=0n,discountSum=0n,netSum=0n,unknownSellerLineCount=0,unsupportedCrossVenueLineCount=0;
  const lineSnapshots=lines.slice().sort((a,b)=>a.order_item_id<b.order_item_id?-1:a.order_item_id>b.order_item_id?1:0).map(line=>{
    uuid(line.id);if(portions.has(line.id))fail('identity_duplicate');portions.add(line.id);
    if(line.venue_id!==venueId||line.order_id!==order.id||line.snapshot_id!==header.id)fail('lineage_invalid');
    const quantity=decimal(line.quantity,3,true),price=decimal(line.unit_price,2,false),gross=minor(line.gross_minor),allocated=minor(line.discount_minor),net=minor(line.net_minor);
    if(typeof line.eligible!=='boolean'||allocated>gross||net!==gross-allocated||(!line.eligible&&allocated!==0n))fail('line_conservation_invalid');
    if(!line.product_facts||typeof line.product_facts!=='object'||Array.isArray(line.product_facts))fail('product_facts_invalid');
    if(line.eligible)eligible.push(line.order_item_id);
    grossRows.push({id:line.order_item_id,numerator:quantity*price,gross});grossSum+=gross;discountSum+=allocated;netSum+=net;
    let known=line.seller_id!==null&&line.sold_at!==null&&line.seller_in_venue===true;
    if(line.seller_id!==null)uuid(line.seller_id);
    if(line.sold_at!==null&&timestamp(line.sold_at)>locked)fail('line_time_invalid');
    const crossVenue=line.seller_id!==null&&line.sold_at!==null&&line.seller_in_venue!==true&&line.seller_in_organization===true;
    if(crossVenue)unsupportedCrossVenueLineCount++;else if(!known)unknownSellerLineCount++;
    return {portionId:line.id,orderItemId:line.order_item_id,quantity:line.quantity,unitPrice:line.unit_price,grossCents:Number(gross),allocatedDiscountCents:Number(allocated),netSaleCents:Number(net),discountEligible:line.eligible,sellerId:line.seller_id,attributionStatus:crossVenue?'unsupported':known?'known':'unknown',...(crossVenue?{attributionReason:'cross_venue_payroll_employee_unsupported'}:{}),soldAt:line.sold_at,productFacts:structuredClone(line.product_facts)};
  });
  if(grossSum!==subtotal||discountSum!==discount||netSum!==subtotal-discount)fail('line_totals_invalid');
  const totalNumerator=grossRows.reduce((s,r)=>s+r.numerator,0n);if((totalNumerator+500n)/1000n!==subtotal)fail('gross_total_invalid');
  const ranked=grossRows.map(r=>({...r,expected:r.numerator/1000n,remainder:r.numerator%1000n})).sort((a,b)=>a.remainder>b.remainder?-1:a.remainder<b.remainder?1:a.id<b.id?-1:a.id>b.id?1:0);
  let residual=subtotal-ranked.reduce((s,r)=>s+r.expected,0n);
  for(const row of ranked){if(residual>0n){row.expected++;residual--;}if(row.gross!==row.expected)fail('gross_allocation_invalid');}
  if(residual!==0n)fail('gross_allocation_invalid');
  sameSet(eligible,ids(header.eligible_item_ids));
  if(!['none','manual','guest_group','promotion'].includes(header.discount_source))fail('winner_invalid');
  if(header.discount_source==='none'){if(discount!==0n||eligible.length!==0)fail('winner_invalid');}
  else{
    const winner=header.winner_terms,eligibleGross=lineSnapshots.filter(r=>r.discountEligible).reduce((s,r)=>s+BigInt(r.grossCents),0n);
    if(winner?.source!==header.discount_source||winner.reasonCode!=='selected'||!Number.isSafeInteger(winner.amountCents)||BigInt(winner.amountCents)!==discount||!Number.isSafeInteger(winner.eligibleBasisCents)||BigInt(winner.eligibleBasisCents)!==eligibleGross)fail('winner_invalid');
    sameSet(eligible,ids(winner.eligibleItemIds));
  }
  const allocations=new Map(allocateIncentiveFund(Number(discount),lineSnapshots.map(r=>({id:r.orderItemId,weight:r.discountEligible?r.grossCents:0}))).map(r=>[r.id,r.amountCents]));
  for(const row of lineSnapshots)if(row.allocatedDiscountCents!==(allocations.get(row.orderItemId)||0))fail('discount_allocation_invalid');
  return {unknownSellerLineCount,unsupportedCrossVenueLineCount,order:{snapshotId:header.id,orderId:order.id,currency,pricingLockedAt:order.pricing_locked_at,closedAt:order.closed_at,subtotalCents:Number(subtotal),discountCents:Number(discount),minimumAdjustmentCents:Number(minimum),finalTotalCents:Number(final),lineSnapshots,winnerTerms:structuredClone(header.winner_terms),frozenTerms:structuredClone(header.frozen_terms)}};
};

// Caller owns the existing tenant-authorized RR READ ONLY transaction.
const readCanonicalPayrollPricingInTransaction=async(db,{venueId,currency,from,to,timezone})=>{
  const capability=(await db.query("SELECT to_regclass('pos_order_pricing_snapshots') IS NOT NULL AND to_regclass('pos_order_pricing_snapshot_lines') IS NOT NULL AS ready")).rows[0]?.ready;
  if(!capability)return {component:{status:'unsupported',reasons:['canonical_pricing_schema_missing'],sourceWatermark:null},orders:[],attribution:{status:'incomplete',unknownLineCount:null,unsupportedCrossVenueLineCount:null,reasons:['canonical_pricing_schema_missing']}};
  const params=[venueId,from,to,timezone];
  const orders=(await db.query(`SELECT id::text,venue_id::text,closed_at::text,pricing_locked_at::text FROM orders WHERE venue_id=$1 AND status='closed' AND closed_at>=($2::date::timestamp AT TIME ZONE $4) AND closed_at<(($3::date+1)::timestamp AT TIME ZONE $4) ORDER BY id`,params)).rows;
  const missingClosedAt=Number((await db.query("SELECT count(*)::text AS n FROM orders WHERE venue_id=$1 AND status='closed' AND closed_at IS NULL",[venueId])).rows[0].n);
  if(!Number.isSafeInteger(missingClosedAt)||missingClosedAt<0)fail('count_overflow');
  const headers=(await db.query(`SELECT s.*,s.transaction_at::text AS transaction_at FROM pos_order_pricing_snapshots s JOIN orders o ON o.venue_id=s.venue_id AND o.id=s.order_id WHERE o.venue_id=$1 AND o.status='closed' AND o.closed_at>=($2::date::timestamp AT TIME ZONE $4) AND o.closed_at<(($3::date+1)::timestamp AT TIME ZONE $4) ORDER BY s.order_id`,params)).rows;
  const lines=(await db.query(`SELECT l.*,l.quantity::text AS quantity,l.unit_price::text AS unit_price,l.sold_at::text AS sold_at,EXISTS(SELECT 1 FROM users u WHERE u.id=l.seller_id AND u.venue_id=l.venue_id) AS seller_in_venue,EXISTS(SELECT 1 FROM users u JOIN venues v ON v.id=l.venue_id WHERE u.id=l.seller_id AND v.organization_id IS NOT NULL AND (u.organization_id=v.organization_id OR EXISTS(SELECT 1 FROM organization_memberships m WHERE m.organization_id=v.organization_id AND m.user_id=u.id AND m.status='active'))) AS seller_in_organization FROM pos_order_pricing_snapshot_lines l JOIN pos_order_pricing_snapshots s ON s.venue_id=l.venue_id AND s.id=l.snapshot_id AND s.order_id=l.order_id JOIN orders o ON o.venue_id=s.venue_id AND o.id=s.order_id WHERE o.venue_id=$1 AND o.status='closed' AND o.closed_at>=($2::date::timestamp AT TIME ZONE $4) AND o.closed_at<(($3::date+1)::timestamp AT TIME ZONE $4) ORDER BY l.order_id,l.order_item_id`,params)).rows;
  const items=(await db.query(`SELECT oi.id::text,oi.order_id::text FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE o.venue_id=$1 AND o.status='closed' AND o.closed_at>=($2::date::timestamp AT TIME ZONE $4) AND o.closed_at<(($3::date+1)::timestamp AT TIME ZONE $4) ORDER BY oi.order_id,oi.id`,params)).rows;
  const validated=[],reasons=new Set();let legacyOrderCount=0,invalidOrderCount=0,unknownLineCount=0,unsupportedCrossVenueLineCount=0;
  const headersByOrder=new Map(headers.map(h=>[h.order_id,h])),linesByOrder=new Map(),itemsByOrder=new Map();
  for(const line of lines){if(!linesByOrder.has(line.order_id))linesByOrder.set(line.order_id,[]);linesByOrder.get(line.order_id).push(line);}
  for(const item of items){if(!itemsByOrder.has(item.order_id))itemsByOrder.set(item.order_id,[]);itemsByOrder.get(item.order_id).push(item.id);}
  if(missingClosedAt)reasons.add('closed_order_date_missing_venue_wide');
  for(const order of orders){const header=headersByOrder.get(order.id);if(!header){legacyOrderCount++;reasons.add('canonical_pricing_legacy_unknown');continue;}
    try{const result=validateCanonicalPayrollPricingOrder({order,header,lines:linesByOrder.get(order.id)||[],itemIds:itemsByOrder.get(order.id)||[]},{venueId,currency});validated.push(result.order);unknownLineCount+=result.unknownSellerLineCount;unsupportedCrossVenueLineCount+=result.unsupportedCrossVenueLineCount;}
    catch(error){if(!error.code?.startsWith('payroll_canonical_pricing_'))throw error;invalidOrderCount++;reasons.add(error.code);}
  }
  const sourceWatermark=createHash('sha256').update(JSON.stringify({venueId,currency,from,to,timezone,missingClosedAt,orders,headers,lines,items})).digest('hex');
  const attributionReasons=[];
  if(unknownLineCount)attributionReasons.push('canonical_sale_seller_unknown');
  if(unsupportedCrossVenueLineCount)attributionReasons.push('cross_venue_payroll_employee_unsupported');
  if(legacyOrderCount)attributionReasons.push('canonical_pricing_legacy_unknown');
  if(invalidOrderCount)attributionReasons.push('canonical_pricing_evidence_invalid');
  if(missingClosedAt)attributionReasons.push('closed_order_date_missing_venue_wide');
  return {component:{status:reasons.size?'incomplete':'available',reasons:[...reasons].sort(),closedOrderCount:orders.length,snapshotOrderCount:headers.length,legacyOrderCount,invalidOrderCount,sourceWatermark,watermarkScope:'canonical_closed_order_pricing_and_item_coverage'},orders:validated,attribution:{status:attributionReasons.length?'incomplete':'available',unknownLineCount,unsupportedCrossVenueLineCount,reasons:attributionReasons.sort()}};
};
module.exports={validateCanonicalPayrollPricingOrder,readCanonicalPayrollPricingInTransaction};
