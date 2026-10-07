import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { evaluateLoyaltyPricing, subtotalFromLines } = require('../loyalty-pricing');
const at = '2030-10-01T10:00:00.000Z';
const promo = (overrides = {}) => ({ promotionId:'promo-a',version:2,name:'Бар по будням',status:'active',startsAt:at,endsAt:'2030-10-01T12:00:00.000Z',benefitKind:'percent',benefitValue:20,priority:1,includeProductIds:[],excludeProductIds:[],includeCategories:['bar'],excludeCategories:[],...overrides });
const lines = [{productId:'drink',category:'bar',quantity:2,unitPrice:100,productActive:true},{productId:'hookah',category:'hookah',quantity:1,unitPrice:1000,productActive:true}];
let result = evaluateLoyaltyPricing({subtotal:1200,promotions:[promo()],lines,now:new Date(at)});
assert.equal(result.source,'promotion'); assert.equal(result.discount,40); assert.equal(result.selectedPromotion.eligibleBasis,200); assert.equal(result.offers.at(-1).reasonCode,'selected');
result = evaluateLoyaltyPricing({subtotal:1200,promotions:[promo({benefitKind:'fixed',benefitValue:500})],lines,now:new Date(at)});
assert.equal(result.discount,200,'fixed promotion is capped at eligible line basis');
result = evaluateLoyaltyPricing({subtotal:1200,promotions:[promo({excludeCategories:['bar']})],lines,now:new Date(at)});
assert.equal(result.discount,0); assert.equal(result.offers.at(-1).reasonCode,'excluded_or_inactive_items');
result = evaluateLoyaltyPricing({subtotal:1000,promotions:[promo({benefitKind:'fixed',benefitValue:100,priority:1}),promo({promotionId:'promo-b',name:'Приоритет',benefitKind:'fixed',benefitValue:100,priority:2})],lines:[{productId:'drink',category:'bar',quantity:1,unitPrice:1000}],now:new Date(at)});
assert.equal(result.selectedPromotion.promotionId,'promo-b','priority resolves equal promotion savings deterministically');
result = evaluateLoyaltyPricing({subtotal:100,promotions:[promo({benefitKind:'fixed',benefitValue:10})],lines:[{productId:'drink',category:'bar',quantity:1,unitPrice:100}],groupPercent:10,hasGroup:true,groupName:'Гость',now:new Date(at)});
assert.equal(result.source,'promotion','promotion outranks group discount on equal savings');
result = evaluateLoyaltyPricing({subtotal:100,promotions:[promo({startsAt:'2030-10-01T09:00:00.000Z',endsAt:at})],lines:[{productId:'drink',category:'bar',quantity:1,unitPrice:100}],now:new Date(at)});
assert.equal(result.offers.at(-1).reasonCode,'expired','end instant is exclusive');
result = evaluateLoyaltyPricing({subtotal:100,promotions:[promo({startsAt:'2030-10-01T10:00:00.001Z'})],lines:[{productId:'drink',category:'bar',quantity:1,unitPrice:100}],now:new Date(at)});
assert.equal(result.offers.at(-1).reasonCode,'not_started','start instant is inclusive');
result = evaluateLoyaltyPricing({subtotal:100,approvedDiscounts:[{type:'percent',value:10}],groupPercent:10,hasGroup:true,now:new Date(at)});
assert.equal(result.source,'guest_group','group retains precedence over manual at a tie');
result = evaluateLoyaltyPricing({subtotal:100,approvedDiscounts:[{type:'percent',value:-10}],now:new Date(at)});
assert.equal(result.discount,0,'negative legacy/manual percent cannot create a negative discount');
const fractionalLines = [
  {orderItemId:'item-b',productId:'drink',category:'bar',quantity:0.5,unitPrice:0.01,productActive:true},
  {orderItemId:'item-a',productId:'drink',category:'bar',quantity:0.5,unitPrice:0.01,productActive:true},
];
const fractionalPromo = promo({benefitValue:100});
assert.equal(subtotalFromLines(fractionalLines),0.01,'memory subtotal uses exact aggregate decimal line value');
result = evaluateLoyaltyPricing({subtotal:0.01,promotions:[fractionalPromo],lines:fractionalLines,now:new Date(at)});
assert.equal(result.subtotal,0.01);
assert.equal(result.selectedPromotion.eligibleBasis,0.01,'aggregate line gross is reconciled to the order subtotal before promotion math');
assert.equal(result.discount,0.01,'promotion cannot exceed the aggregate subtotal');
assert.equal(result.net,0);
assert.deepEqual(result.selectedPromotion.eligibleItemIds,['item-a','item-b'],'selected eligibility uses stable item IDs');
assert.deepEqual(result.lineAllocations.map((line) => [line.orderItemId,line.grossCents,line.discountCents,line.netCents]), [['item-a',1,1,0],['item-b',0,0,0]], 'largest-remainder tie goes to the lower order item ID and the promo cents follow eligible gross');
const reversed = evaluateLoyaltyPricing({subtotal:0.01,promotions:[fractionalPromo],lines:[...fractionalLines].reverse(),now:new Date(at)});
assert.deepEqual(reversed.lineAllocations, result.lineAllocations, 'item penny reconciliation and discount allocation do not depend on input row order');
const ineligiblePenny = evaluateLoyaltyPricing({subtotal:0.01,promotions:[promo({benefitValue:100,includeProductIds:['eligible'],includeCategories:[]})],lines:[
  {orderItemId:'item-a',productId:'other',quantity:0.5,unitPrice:0.01,productActive:true},
  {orderItemId:'item-b',productId:'eligible',quantity:0.5,unitPrice:0.01,productActive:true},
],now:new Date(at)});
assert.equal(ineligiblePenny.selectedPromotion,null,'a promotion is not selected when the reconciled cent belongs only to an excluded line');
assert.equal(ineligiblePenny.offers.at(-1).eligibleBasis,0);
assert.throws(() => evaluateLoyaltyPricing({subtotal:2,lines:[{orderItemId:'item-a',quantity:1,unitPrice:1}]}), /pricing_line_subtotal_mismatch/, 'material order subtotal mismatch fails closed instead of inventing line value');
assert.throws(() => evaluateLoyaltyPricing({subtotal:0.02,lines:[{orderItemId:'same-item',quantity:1,unitPrice:0.01},{orderItemId:'same-item',quantity:1,unitPrice:0.01}]}), /pricing_line_id_duplicate/, 'duplicate stable line identity fails closed before allocation');
assert.ok(result.discount <= result.subtotal);
assert.equal(result.net, result.subtotal - result.discount);
console.log('LOYALTY PRICING QA: PASS (scope, exclusion, cap, priority, tie-break, half-open period)');
