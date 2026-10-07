import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {verifyPayrollOrderPricingFacts:verify}=createRequire(import.meta.url)('../payroll-order-pricing-evidence.js');
const id=n=>`aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12,'0')}`;
const fixture=(fixed=false)=>({venueId:id(1),currency:'RUB',sourcePolicies:{schemaVersion:1,selectionReason:'Owner selected source policy',saleCredit:{kind:'line_seller_snapshot'},
 discountAllocation:fixed?{kind:'eligible_gross_proportional_fixed_order',rounding:'largest_remainder_code_unit_v1',eligibility:'pricing_source_snapshot'}:{kind:'immutable_line_snapshot'},
 refunds:{recognition:'recognized_event_date',closedRunTreatment:'next_open_run_adjustment',paidAdjustment:'owner_review_variable_pay_only',uncoveredBalance:'carry_forward_review',clawback:'no_automatic_clawback'}},
 orderSnapshot:{orderId:id(2),venueId:id(1),snapshotId:id(3),snapshotVersion:'v1',pricingVersion:1,pricingLockedAt:'2026-10-01T10:00:00Z',closedAt:'2026-10-01T12:00:00Z',currency:'RUB',subtotalCents:3,discountCents:1,minimumAdjustmentCents:100,finalTotalCents:102,
 grossReconciliationPolicy:'order_numeric_half_up_largest_remainder_order_item_v1',selectedDiscount:{kind:'fixed_order',amountCents:1},sourcePortionIds:[id(4),id(5),id(6)]},
 lineSnapshots:[4,5,6].map(n=>({portionId:id(n),orderItemId:id(n+10),orderId:id(2),venueId:id(1),snapshotId:id(3),snapshotVersion:'v1',currency:'RUB',quantity:'1.000',unitPrice:'0.01',grossCents:1,
 discountEligible:n!==6,eligibleGrossCents:n===6?0:1,allocatedDiscountCents:n===4?1:0,netSaleCents:n===4?0:1,sellerId:n===5?null:id(9),attributionStatus:n===5?'unknown':'known',commissionEligible:n!==6,departmentSnapshot:n===6?'kitchen':'bar'}))});
for(const fixed of [false,true]){
 const data=fixture(fixed),before=structuredClone(data),result=verify(data);assert.deepEqual(data,before);
 assert.equal(result.validationScope,'supplied_pricing_arithmetic');assert.equal(result.officialReady,undefined);assert.equal(result.complete,undefined);
 assert.equal(result.totals.netSaleBeforeRefundCents,2);assert.equal(result.totals.venueOnlyMinimumAdjustmentCents,100);
 assert.equal(result.lineSnapshots[1].sellerId,null);assert.equal(result.lineSnapshots[2].commissionEligible,false);assert.equal(result.lineSnapshots.length,3);
 const shuffled=structuredClone(data);shuffled.lineSnapshots.reverse();shuffled.orderSnapshot.sourcePortionIds.reverse();assert.deepEqual(verify(shuffled),result,'stable item ties independent of input permutation');
 result.lineSnapshots[0].quantity='9';result.orderSnapshot.sourcePortionIds.push(id(99));result.sourcePolicies.saleCredit.kind='mutated';assert.deepEqual(data,before,'detached output');
}
const rejects=(change,code,fixed=true)=>{const data=fixture(fixed);change(data);assert.throws(()=>verify(data),error=>code?error.code===`payroll_order_pricing_${code}`:typeof error.code==='string');};
rejects(data=>{data.lineSnapshots[0].allocatedDiscountCents=0;data.lineSnapshots[0].netSaleCents=1;data.lineSnapshots[1].allocatedDiscountCents=1;data.lineSnapshots[1].netSaleCents=0;},'fixed_allocation_mismatch');
const immutable=fixture();immutable.lineSnapshots[0].allocatedDiscountCents=0;immutable.lineSnapshots[0].netSaleCents=1;immutable.lineSnapshots[1].allocatedDiscountCents=1;immutable.lineSnapshots[1].netSaleCents=0;assert.equal(verify(immutable).totals.discountCents,1,'canonical policy checks stored allocations, does not invent proportional policy');
for(const kind of ['mixed_order','percent_order'])rejects(data=>data.orderSnapshot.selectedDiscount.kind=kind,'fixed_order_discount_required');
rejects(data=>data.orderSnapshot.selectedDiscount.amountCents=0,'selected_discount_mismatch');
rejects(data=>delete data.lineSnapshots[0].allocatedDiscountCents,'shape_invalid');
rejects(data=>delete data.lineSnapshots[0].netSaleCents,'shape_invalid');
rejects(data=>delete data.sourcePolicies);
rejects(data=>data.orderSnapshot.sourcePortionIds.pop(),'portion_coverage_mismatch');
rejects(data=>data.lineSnapshots.pop(),'portion_coverage_mismatch');
rejects(data=>data.lineSnapshots.push(structuredClone(data.lineSnapshots[0])),'portion_duplicate');
rejects(data=>data.orderSnapshot.sourcePortionIds.push(id(4)),'portion_duplicate');
rejects(data=>data.lineSnapshots[0].snapshotVersion='v2','snapshot_mismatch');
rejects(data=>data.lineSnapshots[0].snapshotId=id(22),'snapshot_mismatch');
rejects(data=>data.lineSnapshots[0].currency='USD','currency_mismatch');
rejects(data=>data.lineSnapshots[0].venueId=id(22),'tenant_mismatch');
rejects(data=>data.lineSnapshots[0].orderId=id(22),'order_mismatch');
rejects(data=>data.lineSnapshots[0].discountEligible=false,'line_eligibility_bounds');
rejects(data=>data.lineSnapshots[0].eligibleGrossCents=2,'line_eligibility_bounds');
rejects(data=>data.lineSnapshots[0].netSaleCents=1,'line_net_mismatch');
rejects(data=>data.orderSnapshot.finalTotalCents=103,'order_net_mismatch');
rejects(data=>data.lineSnapshots[1].sellerId=id(9),'attribution_invalid');
rejects(data=>data.lineSnapshots[0].sellerId=null,'id_invalid');
rejects(data=>data.lineSnapshots[0].commissionEligible='false','boolean_invalid');
for(const quantity of [1,'0','1e3','1.0000','01.0','9007199254740992.001'])rejects(data=>data.lineSnapshots[0].quantity=quantity,'quantity_invalid');
const fractional=fixture();fractional.lineSnapshots[0].quantity='0.001';fractional.lineSnapshots[0].unitPrice='10.00';assert.equal(verify(fractional).lineSnapshots[0].quantity,'0.001');
for(const timestamp of ['2026-02-30T10:00:00Z','2026-10-01T25:00:00Z','2026-10-01T10:00:00'])rejects(data=>data.orderSnapshot.pricingLockedAt=timestamp,'timestamp_invalid');
rejects(data=>data.orderSnapshot.pricingLockedAt='2026-10-02T10:00:00Z','lock_after_close');
const zero=fixture(true);Object.assign(zero.orderSnapshot,{subtotalCents:0,discountCents:0,minimumAdjustmentCents:0,finalTotalCents:0,selectedDiscount:{kind:'none',amountCents:0}});
zero.lineSnapshots.forEach(line=>Object.assign(line,{unitPrice:'0',grossCents:0,eligibleGrossCents:0,allocatedDiscountCents:0,netSaleCents:0}));assert.equal(verify(zero).totals.netSaleBeforeRefundCents,0);
rejects(data=>{data.orderSnapshot.subtotalCents=Number.MAX_SAFE_INTEGER;data.orderSnapshot.discountCents=0;data.orderSnapshot.selectedDiscount={kind:'none',amountCents:0};data.orderSnapshot.minimumAdjustmentCents=0;data.orderSnapshot.finalTotalCents=Number.MAX_SAFE_INTEGER;
data.lineSnapshots.forEach(line=>Object.assign(line,{grossCents:Number.MAX_SAFE_INTEGER,eligibleGrossCents:line.discountEligible?Number.MAX_SAFE_INTEGER:0,allocatedDiscountCents:0,netSaleCents:Number.MAX_SAFE_INTEGER}));},'amount_overflow');
rejects(data=>{Object.defineProperty(data.lineSnapshots[0],'grossCents',{enumerable:true,get(){throw new Error('getter must never run');}});},'shape_invalid');
rejects(data=>{delete data.lineSnapshots[1];},'shape_invalid');
rejects(data=>Object.setPrototypeOf(data.orderSnapshot,{evil:true}),'shape_invalid');
for(const node of [data=>data,data=>data.orderSnapshot,data=>data.lineSnapshots[0]]){
 rejects(data=>Object.defineProperty(node(data),'hiddenExtra',{value:1,enumerable:false}),'shape_invalid');
}
rejects(data=>Object.defineProperty(data.orderSnapshot,'subtotalCents',{value:3,enumerable:false}),'shape_invalid');
rejects(data=>Object.defineProperty(data.sourcePolicies,'schemaVersion',{value:1,enumerable:false}),'shape_invalid');
rejects(data=>data.lineSnapshots[0].portionId=id(4).toUpperCase(),'id_invalid');
console.log('PAYROLL ORDER PRICING EVIDENCE: PASS (both policies, deterministic stored allocation, all-line/VIP conservation, missing/tampered facts and detached arithmetic-only output)');
