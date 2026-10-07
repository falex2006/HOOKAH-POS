import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {validateCanonicalPayrollPricingOrder:verify}=createRequire(import.meta.url)('../payroll-canonical-pricing-source.js');
const id=n=>`aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12,'0')}`;
const fixture=()=>({order:{id:id(1),venue_id:id(2),closed_at:'2026-10-02T12:00:00Z',pricing_locked_at:'2026-10-01T12:00:00Z'},header:{id:id(3),venue_id:id(2),order_id:id(1),schema_version:1,policy_version:1,currency_code:'RUB',currency_scale:2,transaction_at:'2026-10-01T12:00:00Z',subtotal_minor:'1',discount_minor:'1',minimum_adjustment_minor:'0',final_total_minor:'0',discount_source:'promotion',eligible_item_ids:[id(4),id(5)],winner_terms:{source:'promotion',reasonCode:'selected',amountCents:1,eligibleBasisCents:1,eligibleItemIds:[id(4),id(5)]},frozen_terms:{allocationPolicy:'largest-remainder-item-id-v1'}},itemIds:[id(4),id(5)],lines:[4,5].map(n=>({id:id(n+10),venue_id:id(2),order_id:id(1),snapshot_id:id(3),order_item_id:id(n),quantity:'0.500',unit_price:'0.01',gross_minor:n===4?'1':'0',discount_minor:n===4?'1':'0',net_minor:'0',eligible:true,seller_id:id(6),sold_at:'2026-10-01T11:00:00Z',seller_in_venue:true,product_facts:{productId:id(8),category:'bar',station:'bar'}}))});
const options={venueId:id(2),currency:'RUB'},input=fixture(),copy=structuredClone(input),result=verify(input,options);assert.deepEqual(input,copy);assert.equal(result.unknownSellerLineCount,0);assert.equal(result.order.lineSnapshots[0].grossCents,1);assert.equal(result.order.lineSnapshots[1].grossCents,0);assert.equal(Object.hasOwn(result.order.lineSnapshots[0],'commissionEligible'),false);result.order.lineSnapshots[0].productFacts.category='changed';assert.deepEqual(input,copy);
const reject=change=>{const d=fixture();change(d);assert.throws(()=>verify(d,options),e=>e.code?.startsWith('payroll_canonical_pricing_'));};
reject(d=>d.itemIds.pop());reject(d=>d.lines.pop());reject(d=>d.lines[0].venue_id=id(9));reject(d=>d.header.currency_code='USD');reject(d=>d.header.subtotal_minor='9007199254740992');reject(d=>d.lines[0].gross_minor='0');reject(d=>d.lines[0].eligible=false);reject(d=>d.header.winner_terms.amountCents=0);reject(d=>d.header.eligible_item_ids.reverse());reject(d=>d.header.policy_version=2);reject(d=>d.header.frozen_terms.allocationPolicy='future');reject(d=>d.lines[0].quantity='1e0');
const unknown=fixture();unknown.lines[0].seller_in_venue=false;assert.equal(verify(unknown,options).unknownSellerLineCount,1);assert.equal(verify(unknown,options).order.lineSnapshots[0].attributionStatus,'unknown');
const crossVenue=fixture();crossVenue.lines[0].seller_in_venue=false;crossVenue.lines[0].seller_in_organization=true;
const cross=verify(crossVenue,options);assert.equal(cross.unknownSellerLineCount,0);assert.equal(cross.unsupportedCrossVenueLineCount,1);assert.equal(cross.order.lineSnapshots[0].sellerId,id(6));assert.equal(cross.order.lineSnapshots[0].attributionReason,'cross_venue_payroll_employee_unsupported');
reject(d=>d.lines[0].sold_at='2026-10-02T11:00:00Z');reject(d=>d.order.closed_at='2026-09-30T12:00:00Z');
// Independent small integer oracle; no production allocator is used to build expected rows.
for(let n=1;n<=300;n++){
  const d=fixture(),a=n%97+1,b=n%31+1,total=a+b,discount=n%(total+1);
  d.lines.forEach((line,index)=>{const gross=index?b:a;line.quantity='1.000';line.unit_price=(gross/100).toFixed(2);line.gross_minor=String(gross);line.eligible=true;});
  const floors=[Math.floor(discount*a/total),Math.floor(discount*b/total)];
  if(floors[0]+floors[1]<discount)floors[(discount*a)%total>=(discount*b)%total?0:1]++;
  d.lines.forEach((line,index)=>{line.discount_minor=String(floors[index]);line.net_minor=String((index?b:a)-floors[index]);});
  Object.assign(d.header,{subtotal_minor:String(total),discount_minor:String(discount),final_total_minor:String(total-discount),discount_source:['manual','guest_group','promotion'][n%3]});
  Object.assign(d.header.winner_terms,{source:d.header.discount_source,amountCents:discount,eligibleBasisCents:total});
  const actual=verify(d,options).order;assert.deepEqual(actual.lineSnapshots.map(line=>line.allocatedDiscountCents),floors);assert.equal(actual.finalTotalCents,total-discount);
  if(discount>0&&floors[0]<a&&floors[1]>0){d.lines[0].discount_minor=String(floors[0]+1);d.lines[0].net_minor=String(a-floors[0]-1);d.lines[1].discount_minor=String(floors[1]-1);d.lines[1].net_minor=String(b-floors[1]+1);assert.throws(()=>verify(d,options),e=>e.code==='payroll_canonical_pricing_discount_allocation_invalid');}
}
const none=fixture();none.header.discount_source='none';none.header.discount_minor='0';none.header.final_total_minor='1';none.header.eligible_item_ids=[];none.header.winner_terms=null;none.lines.forEach(line=>{line.eligible=false;line.discount_minor='0';line.net_minor=line.gross_minor;});assert.equal(verify(none,options).order.finalTotalCents,1);
console.log('PAYROLL CANONICAL PRICING SOURCE: PASS (300 independent discount oracles; minor cents, complete items, gross/discount replay, frozen eligibility, tenant/currency, chronology, unknown/cross-venue seller and detached pricing-only facts)');
