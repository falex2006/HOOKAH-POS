import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {verifyPayrollOrderPricingFacts:verify}=createRequire(import.meta.url)('../payroll-order-pricing-evidence.js');
const id=n=>`aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12,'0')}`;
const fixture=()=>({venueId:id(1),currency:'RUB',sourcePolicies:{schemaVersion:1,selectionReason:'Owner source policy',saleCredit:{kind:'line_seller_snapshot'},
 discountAllocation:{kind:'eligible_gross_proportional_fixed_order',rounding:'largest_remainder_code_unit_v1',eligibility:'pricing_source_snapshot'},
 refunds:{recognition:'recognized_event_date',closedRunTreatment:'next_open_run_adjustment',paidAdjustment:'owner_review_variable_pay_only',uncoveredBalance:'carry_forward_review',clawback:'no_automatic_clawback'}},
 orderSnapshot:{orderId:id(2),venueId:id(1),snapshotId:id(3),snapshotVersion:'v1',pricingVersion:1,pricingLockedAt:'2026-10-01T10:00:00Z',closedAt:'2026-10-01T12:00:00Z',currency:'RUB',
 grossReconciliationPolicy:'order_numeric_half_up_largest_remainder_order_item_v1',subtotalCents:2,discountCents:1,minimumAdjustmentCents:0,finalTotalCents:1,selectedDiscount:{kind:'fixed_order',amountCents:1},sourcePortionIds:[id(4),id(5)]},
 lineSnapshots:[4,5].map(n=>({portionId:id(n),orderItemId:id(n===4?15:14),orderId:id(2),venueId:id(1),snapshotId:id(3),snapshotVersion:'v1',currency:'RUB',quantity:'1.000',unitPrice:'0.01',grossCents:1,
 discountEligible:true,eligibleGrossCents:1,allocatedDiscountCents:n===5?1:0,netSaleCents:n===5?0:1,sellerId:id(9),attributionStatus:'known',commissionEligible:true,departmentSnapshot:'bar'}))});
const opposed=fixture(),before=structuredClone(opposed),result=verify(opposed);
assert.equal(result.allocationTieContract,'canonical_order_item_id_code_unit_v1');
assert.deepEqual(opposed,before);
const reversed=structuredClone(opposed);reversed.lineSnapshots.reverse();reversed.orderSnapshot.sourcePortionIds.reverse();assert.deepEqual(verify(reversed),result);
const reject=(mutate,code)=>{const data=fixture();mutate(data);assert.throws(()=>verify(data),e=>e.code===`payroll_order_pricing_${code}`);};
reject(data=>{data.lineSnapshots[0].allocatedDiscountCents=1;data.lineSnapshots[0].netSaleCents=0;data.lineSnapshots[1].allocatedDiscountCents=0;data.lineSnapshots[1].netSaleCents=1;},'fixed_allocation_mismatch');
reject(data=>data.lineSnapshots[1].orderItemId=data.lineSnapshots[0].orderItemId,'order_item_duplicate');
reject(data=>delete data.lineSnapshots[0].unitPrice,'shape_invalid');
reject(data=>delete data.orderSnapshot.grossReconciliationPolicy,'shape_invalid');
reject(data=>data.orderSnapshot.grossReconciliationPolicy='future_v2','gross_policy_invalid');
reject(data=>{data.lineSnapshots[0].eligibleGrossCents=0;},'line_eligibility_bounds');
reject(data=>data.lineSnapshots[0].unitPrice='0.02','gross_subtotal_mismatch');

const fractional=fixture();fractional.orderSnapshot.discountCents=0;fractional.orderSnapshot.selectedDiscount={kind:'none',amountCents:0};
Object.assign(fractional.orderSnapshot,{subtotalCents:1,finalTotalCents:1});
fractional.lineSnapshots.forEach((line,index)=>Object.assign(line,{quantity:'0.500',grossCents:index===1?1:0,eligibleGrossCents:index===1?1:0,allocatedDiscountCents:0,netSaleCents:index===1?1:0}));
assert.equal(verify(fractional).totals.grossCents,1,'aggregate two half cents rounds once; lower item ID receives residual');
const wrongGross=structuredClone(fractional);[wrongGross.lineSnapshots[0].grossCents,wrongGross.lineSnapshots[1].grossCents]=[1,0];
wrongGross.lineSnapshots.forEach(line=>Object.assign(line,{eligibleGrossCents:line.grossCents,netSaleCents:line.grossCents}));
assert.throws(()=>verify(wrongGross),e=>e.code==='payroll_order_pricing_gross_allocation_mismatch');
const half=structuredClone(fractional);half.lineSnapshots.pop();half.orderSnapshot.sourcePortionIds.pop();Object.assign(half.lineSnapshots[0],{grossCents:1,eligibleGrossCents:1,netSaleCents:1});
assert.equal(verify(half).totals.grossCents,1,'exact order half cent rounds up');
for(const unitPrice of [0,'-1','01.00',' 1.00','1e3','0.001','10000000000.00','NaN','Infinity'])reject(data=>data.lineSnapshots[0].unitPrice=unitPrice,'unit_price_invalid');
for(const quantity of ['1000000000.000','999999999.9999','0.000'])reject(data=>data.lineSnapshots[0].quantity=quantity,'quantity_invalid');
const bounded=fixture();Object.assign(bounded.orderSnapshot,{subtotalCents:999999999999,discountCents:0,finalTotalCents:999999999999,selectedDiscount:{kind:'none',amountCents:0}});
bounded.lineSnapshots[0].quantity='999999999.999';bounded.lineSnapshots[0].unitPrice='0';Object.assign(bounded.lineSnapshots[0],{grossCents:0,eligibleGrossCents:0,allocatedDiscountCents:0,netSaleCents:0});
Object.assign(bounded.lineSnapshots[1],{unitPrice:'9999999999.99',grossCents:999999999999,eligibleGrossCents:999999999999,allocatedDiscountCents:0,netSaleCents:999999999999});assert.equal(verify(bounded).totals.grossCents,999999999999);
result.lineSnapshots[0].unitPrice='9';assert.deepEqual(opposed,before,'output detached');assert.equal(result.officialReady,undefined);
// Independent Number/integer oracle restricted to small exact numerators.
// Product code uses BigInt; no expected values come from its allocator.
let seed=0x3189a7;
const random=limit=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%limit;};
const decimal=(value,scale)=>`${Math.floor(value/10**scale)}.${String(value%10**scale).padStart(scale,'0')}`;
for(let sample=0;sample<1000;sample++) {
 const data=fixture(),count=1+random(9),rows=[];
 for(let index=0;index<count;index++) {
  const milli=1+random(2000),cents=random(1001),numerator=milli*cents;
  rows.push({...data.lineSnapshots[0],portionId:id(100+index),orderItemId:id(1000+count-index),quantity:decimal(milli,3),unitPrice:decimal(cents,2),
    numerator,gross:Math.floor(numerator/1000),remainder:numerator%1000,discountEligible:random(2)===1});
 }
 const subtotal=Math.floor((rows.reduce((sum,row)=>sum+row.numerator,0)+500)/1000);
 let extra=subtotal-rows.reduce((sum,row)=>sum+row.gross,0);
 for(const row of rows.slice().sort((a,b)=>b.remainder-a.remainder||(a.orderItemId<b.orderItemId?-1:1)))if(extra>0){row.gross++;extra--;}
 const eligibleTotal=rows.reduce((sum,row)=>sum+(row.discountEligible?row.gross:0),0),discount=eligibleTotal?random(eligibleTotal+1):0;
 let allocated=0;
 for(const row of rows){const weight=row.discountEligible?row.gross:0;row.allocation=eligibleTotal?Math.floor(discount*weight/eligibleTotal):0;row.discountRemainder=eligibleTotal?(discount*weight)%eligibleTotal:0;allocated+=row.allocation;}
 let pennies=discount-allocated;
 for(const row of rows.slice().sort((a,b)=>b.discountRemainder-a.discountRemainder||(a.orderItemId<b.orderItemId?-1:1)))if(pennies>0){row.allocation++;pennies--;}
 data.lineSnapshots=rows.map(({numerator,gross,remainder,allocation,discountRemainder,...line})=>({...line,grossCents:gross,eligibleGrossCents:line.discountEligible?gross:0,allocatedDiscountCents:allocation,netSaleCents:gross-allocation}));
 Object.assign(data.orderSnapshot,{subtotalCents:subtotal,discountCents:discount,finalTotalCents:subtotal-discount,sourcePortionIds:data.lineSnapshots.map(line=>line.portionId),selectedDiscount:{kind:discount?'fixed_order':'none',amountCents:discount}});
 const snapshot=structuredClone(data),checked=verify(data);assert.equal(checked.totals.grossCents,subtotal);assert.equal(checked.totals.discountCents,discount);assert.deepEqual(data,snapshot);
 data.lineSnapshots.reverse();data.orderSnapshot.sourcePortionIds.reverse();assert.deepEqual(verify(data),checked,`independent oracle ${sample}`);
}
console.log('PAYROLL PRICING FINANCE ALIGNMENT: PASS (canonical item ties, exact aggregate gross, scale/bounds, 1000 independent integer oracle cases, frozen eligibility and supplied-only scope)');
