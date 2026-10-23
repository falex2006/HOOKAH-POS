import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {buildPayrollRecognitionManifest:build,readPayrollRecognitionManifestInTransaction:read}=createRequire(import.meta.url)('../payroll-recognition-manifest');

const id=n=>`aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12,'0')}`;
const venueId=id(1),saleId=id(2),orderId=id(3),instant='2026-10-01T00:00:00.000001Z';
const epoch=()=>({venue_id:venueId,policy_version:1,activation_scope:'new_venue',activated_at:instant,
  timezone_snapshot:'Asia/Yekaterinburg',activated_local_date:'2026-10-01'});
const empty=()=>({epoch:epoch(),saleEvents:[],saleLines:[],orders:[],pricingHeaders:[],pricingLines:[],orderItems:[],candidateOrders:[],
  refundEvents:[],refundLines:[],refundHeaders:[],relatedRefundHeaders:[],relatedRefundItems:[],refundItems:[],refundTenders:[],candidateRefunds:[]});
const options={venueId,currency:'RUB',from:'2026-10-01',to:'2026-10-31'};

const original=empty(),before=structuredClone(original),first=build(original,options),second=build(original,options);
assert.deepEqual(original,before,'pure builder must not mutate source facts');
assert.equal(first.status,'available');assert.equal(first.officialReady,false);assert.deepEqual(first.sales,[]);assert.deepEqual(first.refunds,[]);
assert.equal(first.watermark,second.watermark,'identical source facts must produce a stable watermark');

const incomplete=build({...empty(),epoch:{...epoch(),activation_scope:'existing_at_install'}},options);
assert.equal(incomplete.status,'incomplete');assert(incomplete.reasons.includes('period_precedes_recognition_epoch'));
assert.equal(incomplete.officialReady,false);

const missingSale=empty();missingSale.candidateOrders=[{id:orderId,venue_id:venueId,status:'closed',closed_at:instant}];
const missing=build(missingSale,options);assert.equal(missing.status,'incomplete');assert(missing.reasons.includes('post_epoch_sale_recognition_missing'));

const badRecognition=empty();badRecognition.saleEvents=[{id:saleId,venue_id:venueId,order_id:orderId,snapshot_id:id(4),policy_version:1,
  recognized_at:instant,timezone_snapshot:'Asia/Yekaterinburg',recognized_local_date:null,source_closed_at:instant,currency_code:'RUB',
  coverage_status:'incomplete',coverage_reasons:['missing'],}];
const unassignable=build(badRecognition,options);assert.equal(unassignable.status,'incomplete');
assert(unassignable.reasons.includes('unassignable_sale_recognition_present'));
assert(unassignable.reasons.includes('sale_recognition_date_unassignable'));
assert(unassignable.reasons.includes('sale_pricing_source_missing'));

const badHistoricalRefund=empty();badHistoricalRefund.refundEvents=[{id:id(5),venue_id:venueId,refund_id:id(6),order_id:orderId,
  original_sale_event_id:saleId,policy_version:1,recognized_at:'2026-09-30T12:00:00.000001Z',timezone_snapshot:'Asia/Yekaterinburg',
  recognized_local_date:'2026-09-30',currency_code:'RUB',item_attribution_status:'not_applicable',payout_minor:'100',tender_total_minor:'100',
  coverage_status:'incomplete',coverage_reasons:['historical_gap']}];
const brokenHistory=build(badHistoricalRefund,options);assert.equal(brokenHistory.status,'incomplete');
assert(brokenHistory.reasons.includes('refund_source_coverage_incomplete'),
  'out-of-period source events linked to a period sale must be coverage-validated before contributing to full 092 history');
assert.notEqual(brokenHistory.watermark,first.watermark,'historical refund source metadata must participate in the watermark');

const crossPeriodSale=()=>{
  const saleAt='2026-10-10T10:00:00.000000Z',soldAt='2026-10-10T09:00:00.000000Z',refundAt='2026-11-05T10:00:00.000000Z';
  const orderId=id(20),snapshotId=id(21),itemId=id(22),pricingLineId=id(23),sellerId=id(24),saleEventId=id(25),saleLineEventId=id(26),refundEventId=id(27),refundId=id(28),refundItemId=id(29),refundLineEventId=id(30);
  const event={id:saleEventId,venue_id:venueId,order_id:orderId,snapshot_id:snapshotId,policy_version:1,recognized_at:saleAt,
    timezone_snapshot:'Asia/Yekaterinburg',recognized_local_date:'2026-10-10',source_closed_at:saleAt,currency_code:'RUB',coverage_status:'complete',coverage_reasons:[]};
  const line={id:saleLineEventId,venue_id:venueId,sale_event_id:saleEventId,snapshot_id:snapshotId,order_id:orderId,order_item_id:itemId,
    pricing_line_id:pricingLineId,seller_id:sellerId,sold_at:soldAt,attribution_captured_at:saleAt,attribution_policy_version:1,
    eligibility_status:'same_venue',eligibility_venue_id:venueId,employee_venue_id:venueId};
  const refundEvent={id:refundEventId,venue_id:venueId,refund_id:refundId,order_id:orderId,original_sale_event_id:saleEventId,
    policy_version:1,recognized_at:refundAt,timezone_snapshot:'Asia/Yekaterinburg',recognized_local_date:'2026-11-05',currency_code:'RUB',
    item_attribution_status:'complete',payout_minor:'10000',tender_total_minor:'10000',coverage_status:'complete',coverage_reasons:[]};
  const refundLine={id:refundLineEventId,venue_id:venueId,refund_event_id:refundEventId,refund_item_id:refundItemId,order_id:orderId,
    snapshot_id:snapshotId,order_item_id:itemId,original_sale_line_event_id:saleLineEventId,producer_sequence:'1',
    previous_returned_quantity:'0.000',returned_quantity:'0.250',cumulative_returned_quantity:'0.250',
    previous_returned_item_value_minor:'0',returned_item_value_minor:'2500',cumulative_returned_item_value_minor:'2500'};
  return {...empty(),epoch:epoch(),saleEvents:[event],saleLines:[line],orders:[{id:orderId,venue_id:venueId,status:'closed',closed_at:saleAt,pricing_locked_at:soldAt}],
    pricingHeaders:[{id:snapshotId,venue_id:venueId,order_id:orderId,schema_version:1,policy_version:1,currency_code:'RUB',currency_scale:2,
      transaction_at:soldAt,subtotal_minor:'10000',discount_minor:'0',minimum_adjustment_minor:'0',final_total_minor:'10000',discount_source:'none',
      eligible_item_ids:[],winner_terms:null,frozen_terms:{allocationPolicy:'largest-remainder-item-id-v1'}}],
    pricingLines:[{id:pricingLineId,venue_id:venueId,order_id:orderId,snapshot_id:snapshotId,order_item_id:itemId,quantity:'1.000',unit_price:'100.00',
      gross_minor:'10000',discount_minor:'0',net_minor:'10000',eligible:false,seller_id:sellerId,sold_at:soldAt,seller_in_venue:true,seller_in_organization:true,product_facts:{}}],
    orderItems:[{id:itemId,order_id:orderId}],refundEvents:[refundEvent],refundLines:[refundLine],
    refundHeaders:[{id:refundId,venue_id:venueId,order_id:orderId,item_attribution_status:'complete',recognition_policy_version:1,
      payroll_recognized_at:refundAt,payroll_timezone_snapshot:'Asia/Yekaterinburg',payroll_recognized_local_date:'2026-11-05',payout_minor:'10000'}],
    relatedRefundHeaders:[{id:refundId,venue_id:venueId,order_id:orderId,created_at:refundAt}],
    relatedRefundItems:[{id:refundItemId,venue_id:venueId,refund_id:refundId,order_id:orderId}],
    refundItems:[{id:refundItemId,venue_id:venueId,refund_id:refundId,order_id:orderId,snapshot_id:snapshotId,order_item_id:itemId,
      returned_quantity:'0.250',returned_item_value_minor:'2500',producer_sequence:'1',previous_returned_quantity:'0.000',
      cumulative_returned_quantity:'0.250',previous_returned_item_value_minor:'0',cumulative_returned_item_value_minor:'2500'}],
    refundTenders:[{refund_id:refundId,tender_total_minor:'10000'}]};
};
const crossPeriodFacts=crossPeriodSale(),november={...options,from:'2026-11-01',to:'2026-11-30'};
const crossPeriod=build(crossPeriodFacts,november);
assert.equal(crossPeriod.status,'available',JSON.stringify(crossPeriod.reasons));
for (const status of ['cancelled', 'open', null, undefined]) {
  const changed = structuredClone(crossPeriodFacts);
  changed.orders[0].status = status;
  for (const selectedPeriod of [options, november]) {
    const rejected = build(changed, selectedPeriod);
    assert.equal(rejected.status, 'incomplete', 'non-closed original sales cannot supply payroll/margin evidence');
    assert.ok(rejected.reasons.includes('sale_order_not_closed'));
    assert.notEqual(rejected.watermark, build(crossPeriodFacts, selectedPeriod).watermark);
    assert.equal(rejected.saleLines.length, 0, 'invalid sale line evidence is not made calculator-ready');
    if (selectedPeriod === options) assert.equal(rejected.sales.length, 1, 'immutable recognition event remains visible for review');
  }
}
assert.equal(crossPeriod.sales.length,0,'prior-month sale must not enter current-period sale totals');
assert.equal(crossPeriod.saleLines.length,0,'prior-month sale lines remain outside current-period line totals');
assert.equal(crossPeriod.refundOriginalSaleAttributions.length,1);
assert.deepEqual(crossPeriod.refundOriginalSaleAttributions[0],{
  saleEventId:id(25),saleLineEventId:id(26),venueId,orderId:id(20),snapshotId:id(21),orderItemId:id(22),sellerId:id(24),
  eligibilityStatus:'same_venue',eligibilityVenueId:venueId,employeeVenueId:venueId,attributionPolicyVersion:1,
  recognizedAt:'2026-10-10T10:00:00.000000Z',recognizedLocalDate:'2026-10-10',timezoneSnapshot:'Asia/Yekaterinburg',currency:'RUB',
  productFacts:{},grossMinor:10000,discountMinor:0,netMinor:10000,cumulativeReturnedQuantity:'0.250',cumulativeReturnedItemValueMinor:2500
});
assert.notEqual(crossPeriod.watermark,build({...crossPeriodFacts,saleLines:[]},november).watermark,
  'related original-sale attribution must contribute to source watermark');
assert.equal(crossPeriod.relatedRefundCoverage.status,'complete');
assert.equal(crossPeriod.relatedRefundCoverage.sourceWatermark,crossPeriod.watermark);
assert.deepEqual(crossPeriod.relatedRefundCoverage.relatedRefundHeaderIds,[id(28)]);
const octoberCrossPeriod=build(crossPeriodFacts,options);
assert.equal(octoberCrossPeriod.status,'available',JSON.stringify(octoberCrossPeriod.reasons));
assert.deepEqual(octoberCrossPeriod.refundEvents,[],'future refund is outside the sale period projection');
assert.deepEqual(octoberCrossPeriod.relatedRefundCoverage.periodSaleOrderIds,[id(20)]);
assert.deepEqual(octoberCrossPeriod.relatedRefundCoverage.relatedRefundHeaderIds,[id(28)],
  'all-time related refund coverage carries a later refund even when the period projection is empty');
// A padded discovery sale and its later return can both be outside the period.
// Their history must be validated without adding either to period totals.
const outsideHistory = structuredClone(crossPeriodFacts);
outsideHistory.relatedRefundHeaders=[]; outsideHistory.relatedRefundItems=[];
outsideHistory.candidateOrders=[{id:id(20),venue_id:venueId,status:'closed',closed_at:outsideHistory.orders[0].closed_at}];
const beforeSale={...options,to:'2026-10-09'};
const outsideResult=build(outsideHistory,beforeSale);
assert.equal(outsideResult.status,'available',JSON.stringify(outsideResult.reasons));
assert.deepEqual(outsideResult.sales,[]); assert.deepEqual(outsideResult.saleLines,[]);
assert.deepEqual(outsideResult.refunds,[]); assert.deepEqual(outsideResult.refundOriginalSaleAttributions,[]);
assert.equal(outsideResult.refundHistory.length,1);
assert.equal(outsideResult.refundHistory[0].cumulativeReturnedItemValueMinor,2500);
assert.deepEqual(outsideResult.relatedRefundCoverage.coveredOrderIds,[]);
assert.equal(build({...outsideHistory,saleLines:[]},beforeSale).status,'incomplete');
const invalidOutside=structuredClone(outsideHistory);invalidOutside.orders[0].status='open';
assert.ok(build(invalidOutside,beforeSale).reasons.includes('sale_order_not_closed'));
const lateHeaderWithoutRecognition=structuredClone(crossPeriodFacts);
lateHeaderWithoutRecognition.refundEvents=[];lateHeaderWithoutRecognition.refundLines=[];lateHeaderWithoutRecognition.refundHeaders=[];
lateHeaderWithoutRecognition.refundItems=[];lateHeaderWithoutRecognition.refundTenders=[];
const lateHeaderBlocked=build(lateHeaderWithoutRecognition,options);
assert.equal(lateHeaderBlocked.status,'incomplete');
assert(lateHeaderBlocked.reasons.includes('related_refund_recognition_missing'),
  'a related raw refund header outside the period must not be hidden by the period-only candidate query');
assert(lateHeaderBlocked.reasons.includes('related_refund_item_history_missing'),
  'a raw related refund item without detailed immutable history blocks coverage');
assert.deepEqual(lateHeaderBlocked.relatedRefundCoverage.relatedRefundItemIds,[crossPeriodFacts.refundItems[0].id],
  'raw related refund items are attested independently from recognized item history');
assert.notEqual(lateHeaderBlocked.watermark,build({...lateHeaderWithoutRecognition,relatedRefundHeaders:[]},options).watermark,
  'an unrecognized related refund header changes the source fingerprint');
const orphanRecognition=build({...crossPeriodFacts,relatedRefundHeaders:[]},november);
assert(orphanRecognition.reasons.includes('related_refund_header_missing'));
const unrelated=structuredClone(crossPeriodFacts);unrelated.refundEvents=[];unrelated.refundLines=[];unrelated.refundHeaders=[];unrelated.refundItems=[];unrelated.refundTenders=[];
unrelated.relatedRefundHeaders=[];
const noCurrentRefund=build(unrelated,november);
assert.equal(noCurrentRefund.refundOriginalSaleAttributions.length,0,'unreferenced older sale lines are not returned as related attribution');

const wrongTenant=empty();wrongTenant.epoch={...epoch(),venue_id:id(9)};
const wrongTenantResult=build(wrongTenant,options);assert.equal(wrongTenantResult.status,'incomplete');assert(wrongTenantResult.reasons.includes('recognition_epoch_invalid'));
assert.deepEqual(wrongTenantResult.saleEvents,[]);assert.deepEqual(wrongTenantResult.refundEvents,[]);
assert.throws(()=>build(empty(),{...options,from:'2026-10-02'}),/payroll_recognition_manifest_period_invalid/);
assert.throws(()=>build(empty(),{...options,currency:'USD'}),/payroll_recognition_manifest_currency_unsupported/);

const statements=[];let capabilityColumns=[];
const db={query:async (sql,params)=>{
  const text=String(sql);statements.push(text);
  if(text==='SHOW transaction_isolation')return {rows:[{transaction_isolation:'repeatable read'}]};
  if(text==='SHOW transaction_read_only')return {rows:[{transaction_read_only:'on'}]};
  if(text.includes('FROM unnest($1::text[])')){capabilityColumns=params[0];return {rows:[{missing_count:0}]};}
  if(text.includes('FROM pos_payroll_recognition_epochs'))return {rows:[{venue_id:venueId,policy_version:1,
    activated_at:instant,activation_scope:'new_venue',timezone_snapshot:'Asia/Yekaterinburg',activated_local_date:'2026-10-01'}]};
  return {rows:[]};
}};
const readResult=await read(db,options);assert.equal(readResult.status,'available');assert.equal(readResult.officialReady,false);
for(const statement of statements)assert.match(statement,/^(?:WITH|SELECT|SHOW|SAVEPOINT|ROLLBACK TO SAVEPOINT|RELEASE SAVEPOINT)\b/i,
  `consumer must remain read-only: ${statement}`);
const lateHeaderStatements=[];
const lateHeaderDb={query:async (sql,params)=>{
  const text=String(sql);lateHeaderStatements.push(text);
  if(text==='SHOW transaction_isolation')return {rows:[{transaction_isolation:'repeatable read'}]};
  if(text==='SHOW transaction_read_only')return {rows:[{transaction_read_only:'on'}]};
  if(text.includes('FROM unnest($1::text[])'))return {rows:[{missing_count:0}]};
  if(text.includes('FROM pos_payroll_recognition_epochs'))return {rows:[{venue_id:venueId,policy_version:1,
    activated_at:instant,activation_scope:'new_venue',timezone_snapshot:'Asia/Yekaterinburg',activated_local_date:'2026-10-01'}]};
  if(text.includes('FROM order_refunds') && text.includes('created_at>='))return {rows:[{id:id(31),venue_id:venueId,order_id:orderId,created_at:instant}]};
  if(text.includes('FROM order_refunds WHERE venue_id=$1 AND order_id=ANY($2::uuid[])'))return {rows:[{id:id(31),venue_id:venueId,
    order_id:orderId,created_at:'2026-11-05T10:00:00.000000Z'}]};
  if(text.includes('FROM orders WHERE venue_id=$1 AND id=ANY($2::uuid[])'))return {rows:[{id:orderId,venue_id:venueId,
    closed_at:instant,pricing_locked_at:instant,status:'closed'}]};
  return {rows:[]};
}};
const lateHeaderRead=await read(lateHeaderDb,options);
assert.equal(lateHeaderRead.status,'incomplete');
assert(lateHeaderRead.reasons.includes('related_refund_recognition_missing'), JSON.stringify(lateHeaderRead.reasons));
assert(lateHeaderStatements.some(sql=>sql.includes('FROM order_refunds WHERE venue_id=$1 AND order_id=ANY($2::uuid[])')
  && !sql.includes('created_at>=')), 'all-time raw refund headers are read by selected order IDs without a period date cutoff');
assert(lateHeaderStatements.some(sql=>sql.includes('FROM order_refund_items WHERE venue_id=$1 AND order_id=ANY($2::uuid[])')
  && !sql.includes('created_at>=')), 'all-time raw refund items are read by selected order IDs without a period date cutoff');
const rejectedStatements=[];
const wrongMode={query:async sql=>{
  const text=String(sql);rejectedStatements.push(text);
  if(text==='SHOW transaction_isolation')return {rows:[{transaction_isolation:'read committed'}]};
  if(text==='SHOW transaction_read_only')return {rows:[{transaction_read_only:'on'}]};
  return {rows:[]};
}};
await assert.rejects(()=>read(wrongMode,options),/payroll_recognition_manifest_repeatable_read_read_only_required/);
assert(rejectedStatements.some(statement=>/^ROLLBACK TO SAVEPOINT\b/i.test(statement)),'invalid caller transaction is rolled back to the reader savepoint');
const partialSchemaColumns=['order_refund_items.created_at','order_refund_items.return_policy_version',
  'pos_order_pricing_snapshots.frozen_terms','pos_order_pricing_snapshot_lines.net_minor'];
for(const missingColumn of partialSchemaColumns){
  assert(capabilityColumns.includes(missingColumn),`capability guard must require ${missingColumn}`);
  const oldSchemaStatements=[];
  const oldSchema={query:async (sql,params)=>{
    const text=String(sql);oldSchemaStatements.push(text);
    if(text==='SHOW transaction_isolation')return {rows:[{transaction_isolation:'repeatable read'}]};
    if(text==='SHOW transaction_read_only')return {rows:[{transaction_read_only:'on'}]};
    if(text.includes('FROM unnest($1::text[])'))return {rows:[{missing_count:params[0].includes(missingColumn)?1:0}]};
    return {rows:[]};
  }};
  const oldSchemaResult=await read(oldSchema,options);
  assert.equal(oldSchemaResult.status,'unsupported',`missing ${missingColumn} must fail closed`);
  assert.equal(oldSchemaResult.officialReady,false);
  assert.deepEqual(oldSchemaResult.reasons,['recognition_source_schema_missing']);
  assert.equal(oldSchemaResult.watermark,null,'an unavailable source must not look like an observed empty period');
  assert.deepEqual(oldSchemaResult.refundOriginalSaleAttributions,[]);
  assert.equal(oldSchemaStatements.filter(statement=>statement.includes('FROM pos_payroll_recognition_epochs')).length,0,
    'schema capability must be checked before referencing optional recognition tables');
}

console.log('PAYROLL RECOGNITION MANIFEST: PASS (epoch coverage, full related refund history, old/partial schema guard, read-only transaction boundary, missing events, purity, deterministic watermark)');
