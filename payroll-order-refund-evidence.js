'use strict';

const {verifyPayrollOrderPricingFacts} = require('./payroll-order-pricing-evidence');
const POLICY = 'original_line_net_cumulative_half_up_v1';
const fail = suffix => { const code=`payroll_order_refund_${suffix}`; throw Object.assign(new TypeError(code),{code}); };
const inspect = (value, ancestors=new Set()) => {
  if(value===null || typeof value!=='object') {
    if(value!==null && !['string','number','boolean','undefined'].includes(typeof value))fail('shape_invalid');
    return;
  }
  const array=Array.isArray(value);
  if(ancestors.has(value) || Object.getPrototypeOf(value)!==(array?Array.prototype:Object.prototype))fail('shape_invalid');
  const keys=Reflect.ownKeys(value);
  if(array && (keys.length!==value.length+1 || keys.some(k=>typeof k!=='string' || (k!=='length'&&!/^(0|[1-9][0-9]*)$/.test(k)))))fail('shape_invalid');
  ancestors.add(value);
  for(const key of keys){const d=Object.getOwnPropertyDescriptor(value,key);
    if(typeof key!=='string'||['__proto__','prototype','constructor'].includes(key)||!Object.hasOwn(d,'value')||(!d.enumerable&&!(array&&key==='length')))fail('shape_invalid');
    inspect(d.value,ancestors);
  }
  ancestors.delete(value);
};
const exact=(value,keys)=>{if(!value||typeof value!=='object'||Array.isArray(value)||Reflect.ownKeys(value).length!==keys.length||keys.some(k=>!Object.hasOwn(value,k)))fail('shape_invalid');};
const uuid=value=>{if(typeof value!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value))fail('id_invalid');return value;};
const quantity=(value,allowZero=false)=>{
  if(typeof value!=='string'||value.length>32||!/^(0|[1-9][0-9]*)(?:\.[0-9]{1,3})?$/.test(value))fail('quantity_invalid');
  const [whole,fraction='']=value.split('.'),n=BigInt(whole)*1000n+BigInt(fraction.padEnd(3,'0'));
  if(n<0n||(!allowZero&&n===0n)||n>999999999999n)fail('quantity_invalid');return n;
};
const decimal=n=>`${n/1000n}.${String(n%1000n).padStart(3,'0')}`;
const money=value=>{if(!Number.isSafeInteger(value)||value<0)fail('money_invalid');return BigInt(value);};
const stamp=value=>{
  if(typeof value!=='string')fail('timestamp_invalid');
  const match=value.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-](\d{2}):(\d{2}))$/),n=Date.parse(value),day=match&&Date.parse(match[1]+'T00:00:00Z');
  if(!match||!Number.isFinite(n)||!Number.isFinite(day)||new Date(day).toISOString().slice(0,10)!==match[1]||Number(match[2])>23||Number(match[3])>59||Number(match[4])>59||Number(match[5]||0)>23||Number(match[6]||0)>59)fail('timestamp_invalid');return n;
};
const EVENT_KEYS=['eventId','replayKey','sequence','venueId','orderId','orderItemId','portionId','snapshotId','snapshotVersion','currency','sellerId','attributionStatus','recognizedAt','returnedQuantity','previousReturnedQuantity','cumulativeReturnedQuantity','previousReturnedItemValueCents','returnedItemValueCents','cumulativeReturnedItemValueCents'];

// Arithmetic only: callers must independently establish source lineage/history.
const verifyPayrollItemReturnArithmetic=input=>{
  inspect(input);exact(input,['originalQuantity','originalNetCents','previousReturnedQuantity','previousReturnedItemValueCents','returnedQuantity','returnedItemValueCents']);
  const originalQ=quantity(input.originalQuantity),originalNet=money(input.originalNetCents),previousQ=quantity(input.previousReturnedQuantity,true),previousValue=money(input.previousReturnedItemValueCents),deltaQ=quantity(input.returnedQuantity),deltaValue=money(input.returnedItemValueCents),nextQ=previousQ+deltaQ;
  if(previousQ>originalQ||nextQ>originalQ)fail('quantity_mismatch');
  const expectedPrevious=(2n*originalNet*previousQ+originalQ)/(2n*originalQ),expected=(2n*originalNet*nextQ+originalQ)/(2n*originalQ);
  if(previousValue!==expectedPrevious||deltaValue!==expected-previousValue||expected>originalNet)fail('value_mismatch');
  return {cumulativeReturnedQuantity:decimal(nextQ),cumulativeReturnedItemValueCents:Number(expected),remainingQuantity:decimal(originalQ-nextQ),remainingNetSaleCents:Number(originalNet-expected)};
};

// Checks provided merchandise-return arithmetic only. No DB reads, payout
// recognition, employee clawback, completeness or source authority is implied.
const verifyPayrollOrderRefundFacts=input=>{
  inspect(input);exact(input,['pricingFacts','orderItemId','refundValuePolicy','itemReturnEvents']);
  if(input.refundValuePolicy!==POLICY)fail('policy_invalid');
  const pricing=verifyPayrollOrderPricingFacts(input.pricingFacts),itemId=uuid(input.orderItemId);
  const original=pricing.lineSnapshots.find(row=>row.orderItemId===itemId);
  if(!original)fail('item_missing');
  if(!Array.isArray(input.itemReturnEvents))fail('events_invalid');
  const originalQ=quantity(original.quantity),originalNet=money(original.netSaleCents);
  const ids=new Set(),keys=new Set(),sequences=new Set();
  for(const event of input.itemReturnEvents){
    exact(event,EVENT_KEYS);uuid(event.eventId);
    if(typeof event.replayKey!=='string'||!event.replayKey.trim()||event.replayKey!==event.replayKey.trim()||event.replayKey.length>200)fail('replay_key_invalid');
    if(!Number.isSafeInteger(event.sequence)||event.sequence<=0)fail('sequence_invalid');
    if(ids.has(event.eventId)||keys.has(event.replayKey)||sequences.has(event.sequence))fail('duplicate');
    ids.add(event.eventId);keys.add(event.replayKey);sequences.add(event.sequence);
  }
  let cumulativeQ=0n,cumulativeValue=0n,previousSequence=0,previousStamp=stamp(pricing.orderSnapshot.closedAt);
  for(const event of input.itemReturnEvents){
    for(const key of ['venueId','orderId','orderItemId','portionId','snapshotId','snapshotVersion','currency','sellerId','attributionStatus'])if(event[key]!==original[key])fail('lineage_mismatch');
    if(event.sequence<=previousSequence)fail('sequence_invalid');
    const time=stamp(event.recognizedAt);if(time<previousStamp)fail('chronology_invalid');
    const deltaQ=quantity(event.returnedQuantity),previousQ=quantity(event.previousReturnedQuantity,true),nextQ=quantity(event.cumulativeReturnedQuantity);
    const previousValue=money(event.previousReturnedItemValueCents),deltaValue=money(event.returnedItemValueCents),nextValue=money(event.cumulativeReturnedItemValueCents);
    if(previousQ!==cumulativeQ||previousValue!==cumulativeValue)fail('history_mismatch');
    if(nextQ!==previousQ+deltaQ||nextQ>originalQ)fail('quantity_mismatch');
    const arithmetic=verifyPayrollItemReturnArithmetic({originalQuantity:original.quantity,originalNetCents:original.netSaleCents,previousReturnedQuantity:event.previousReturnedQuantity,previousReturnedItemValueCents:event.previousReturnedItemValueCents,returnedQuantity:event.returnedQuantity,returnedItemValueCents:event.returnedItemValueCents});
    const expected=BigInt(arithmetic.cumulativeReturnedItemValueCents);
    if(nextValue!==expected||nextValue>originalNet||deltaValue!==expected-previousValue)fail('value_mismatch');
    cumulativeQ=nextQ;cumulativeValue=nextValue;previousSequence=event.sequence;previousStamp=time;
  }
  return {validationScope:'supplied_item_return_arithmetic',coverage:'not_attested',paymentLinkage:'unknown',
    refundValuePolicy:POLICY,sourcePolicies:structuredClone(pricing.sourcePolicies),originalLine:structuredClone(original),
    attributionStatus:original.attributionStatus,sellerId:original.sellerId,
    cumulativeReturnedQuantity:decimal(cumulativeQ),cumulativeReturnedItemValueCents:Number(cumulativeValue),
    remainingQuantity:decimal(originalQ-cumulativeQ),remainingNetSaleCents:Number(originalNet-cumulativeValue),
    itemReturnEvents:structuredClone(input.itemReturnEvents)};
};
module.exports={verifyPayrollOrderRefundFacts,verifyPayrollItemReturnArithmetic};
