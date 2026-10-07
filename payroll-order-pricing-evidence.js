'use strict';

const { normalizePayrollSourcePolicies } = require('./payroll-source-policies');
const { allocateIncentiveFund } = require('./payroll-incentive-math');
const MAX = BigInt(Number.MAX_SAFE_INTEGER);
const fail = (suffix) => { const code = `payroll_order_pricing_${suffix}`; throw Object.assign(new TypeError(code), { code }); };
const ORDER_KEYS = ['orderId','venueId','snapshotId','snapshotVersion','pricingVersion','pricingLockedAt','closedAt','currency',
  'grossReconciliationPolicy','subtotalCents','discountCents','minimumAdjustmentCents','finalTotalCents','selectedDiscount','sourcePortionIds'];
const LINE_KEYS = ['portionId','orderItemId','orderId','venueId','snapshotId','snapshotVersion','currency','quantity','unitPrice','grossCents',
  'discountEligible','eligibleGrossCents','allocatedDiscountCents','netSaleCents','sellerId','attributionStatus','commissionEligible','departmentSnapshot'];
const inspect = (value, ancestors = new Set()) => {
  if (value === null || typeof value !== 'object') {
    if (!['string','number','boolean','undefined'].includes(typeof value) && value !== null) fail('shape_invalid');
    return;
  }
  if (ancestors.has(value)) fail('shape_invalid');
  const array = Array.isArray(value);
  if (Object.getPrototypeOf(value) !== (array ? Array.prototype : Object.prototype)) fail('shape_invalid');
  const keys = Reflect.ownKeys(value);
  if (array && (keys.length !== value.length + 1 || keys.some(key => typeof key !== 'string' || (key !== 'length' && !/^(0|[1-9][0-9]*)$/.test(key))))) fail('shape_invalid');
  ancestors.add(value);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value,key);
    if (typeof key !== 'string' || ['__proto__','prototype','constructor'].includes(key) || !Object.hasOwn(descriptor,'value')) fail('shape_invalid');
    if (!descriptor.enumerable && !(array && key === 'length')) fail('shape_invalid');
    inspect(descriptor.value, ancestors);
  }
  ancestors.delete(value);
};
const exact = (value, keys) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Reflect.ownKeys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value,key))) fail('shape_invalid');
};
const id = (value) => {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) fail('id_invalid');
  return value;
};
const text = (value, limit) => { if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > limit) fail('text_invalid'); return value; };
const money = (value) => { if (!Number.isSafeInteger(value) || value < 0) fail('money_invalid'); return BigInt(value); };
const bounded = (value) => { if (value < 0n || value > MAX) fail('amount_overflow'); return Number(value); };
const bool = (value) => { if (typeof value !== 'boolean') fail('boolean_invalid'); return value; };
const equal = (a,b,suffix) => { if (a !== b) fail(suffix); };
const timestamp = (value) => {
  if (typeof value !== 'string') fail('timestamp_invalid');
  const match = value.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-](\d{2}):(\d{2}))$/);
  const stamp = Date.parse(value), day = match && Date.parse(`${match[1]}T00:00:00Z`);
  if (!match || !Number.isFinite(stamp) || !Number.isFinite(day) || new Date(day).toISOString().slice(0,10) !== match[1]
    || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59 || Number(match[5] || 0) > 23 || Number(match[6] || 0) > 59) fail('timestamp_invalid');
  return stamp;
};
const quantity = (value) => {
  if (typeof value !== 'string' || value.length > 32 || !/^(0|[1-9][0-9]*)(?:\.[0-9]{1,3})?$/.test(value)) fail('quantity_invalid');
  const [whole, fraction=''] = value.split('.'), amount=BigInt(whole)*1000n+BigInt(fraction.padEnd(3,'0'));
  if (amount <= 0n || amount > 999999999999n) fail('quantity_invalid');
  return amount;
};
const unitPrice = (value) => {
  if (typeof value !== 'string' || value.length > 32 || !/^(0|[1-9][0-9]*)(?:\.[0-9]{1,2})?$/.test(value)) fail('unit_price_invalid');
  const [whole,fraction='']=value.split('.'), amount=BigInt(whole)*100n+BigInt(fraction.padEnd(2,'0'));
  if (amount>999999999999n) fail('unit_price_invalid');
  return amount;
};

const verifyGrossReconciliation = (subtotal, rows) => {
  const rawTotal=rows.reduce((sum,row)=>sum+row.numerator,0n), expectedSubtotal=(rawTotal+500n)/1000n;
  bounded(expectedSubtotal); equal(subtotal,expectedSubtotal,'gross_subtotal_mismatch');
  const ranked=rows.map(row=>({...row,expected:row.numerator/1000n,remainder:row.numerator%1000n}));
  let residual=expectedSubtotal-ranked.reduce((sum,row)=>sum+row.expected,0n);
  ranked.sort((a,b)=>a.remainder>b.remainder?-1:a.remainder<b.remainder?1:a.orderItemId<b.orderItemId?-1:a.orderItemId>b.orderItemId?1:0);
  for (const row of ranked) {
    if (residual>0n) { row.expected+=1n; residual-=1n; }
    equal(row.gross,row.expected,'gross_allocation_mismatch');
  }
  if (residual!==0n) fail('gross_allocation_mismatch');
};

// Future Finance must persist this complete envelope. Caller declarations do
// not prove immutability, complete database coverage or authority for payroll.
// One immutable row per canonical order item. Portion identity is lineage only.
// Exact supplied quantity/price replay checks gross; it never synthesizes missing
// stored gross/net or proves the producer's winner/eligible set/database coverage.
const verifyPayrollOrderPricingFacts = (input) => {
  inspect(input); exact(input,['venueId','currency','sourcePolicies','orderSnapshot','lineSnapshots']);
  const venueId=id(input.venueId), currency=input.currency;
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) fail('currency_invalid');
  const policies=normalizePayrollSourcePolicies(input.sourcePolicies); if (!policies) fail('source_policy_required');
  const order=input.orderSnapshot; exact(order,ORDER_KEYS);
  const orderId=id(order.orderId), snapshotId=id(order.snapshotId); text(order.snapshotVersion,80);
  equal(order.grossReconciliationPolicy,'order_numeric_half_up_largest_remainder_order_item_v1','gross_policy_invalid');
  equal(id(order.venueId),venueId,'tenant_mismatch'); equal(order.currency,currency,'currency_mismatch');
  if (!Number.isSafeInteger(order.pricingVersion) || order.pricingVersion <= 0) fail('pricing_version_invalid');
  if (timestamp(order.pricingLockedAt) > timestamp(order.closedAt)) fail('lock_after_close');
  const subtotal=money(order.subtotalCents), discount=money(order.discountCents), minimum=money(order.minimumAdjustmentCents), final=money(order.finalTotalCents);
  if (discount > subtotal) fail('discount_bounds'); equal(final,subtotal-discount+minimum,'order_net_mismatch');
  exact(order.selectedDiscount,['kind','amountCents']);
  if (!['none','fixed_order','percent_order','mixed_order'].includes(order.selectedDiscount.kind)) fail('selected_discount_invalid');
  equal(money(order.selectedDiscount.amountCents),discount,'selected_discount_mismatch');
  if (order.selectedDiscount.kind === 'none' && discount !== 0n) fail('selected_discount_invalid');
  if (!Array.isArray(order.sourcePortionIds) || !Array.isArray(input.lineSnapshots)) fail('lines_required');
  const expected=new Set();
  for (const portionId of order.sourcePortionIds) { id(portionId); if (expected.has(portionId)) fail('portion_duplicate'); expected.add(portionId); }
  const portions=new Set(), orderItems=new Set(), grossRows=[]; let grossSum=0n, discountSum=0n, netSum=0n, eligibleSum=0n;
  for (const line of input.lineSnapshots) {
    exact(line,LINE_KEYS); const portionId=id(line.portionId), orderItemId=id(line.orderItemId);
    if (portions.has(portionId)) fail('portion_duplicate'); portions.add(portionId);
    if (orderItems.has(orderItemId)) fail('order_item_duplicate'); orderItems.add(orderItemId);
    if (!expected.has(portionId)) fail('portion_coverage_mismatch');
    equal(id(line.venueId),venueId,'tenant_mismatch'); equal(id(line.orderId),orderId,'order_mismatch');
    equal(id(line.snapshotId),snapshotId,'snapshot_mismatch'); equal(text(line.snapshotVersion,80),order.snapshotVersion,'snapshot_mismatch');
    equal(line.currency,currency,'currency_mismatch');
    const quantityMilli=quantity(line.quantity), priceCents=unitPrice(line.unitPrice); text(line.departmentSnapshot,80);
    const gross=money(line.grossCents), eligible=money(line.eligibleGrossCents), allocated=money(line.allocatedDiscountCents), net=money(line.netSaleCents);
    const discountEligible=bool(line.discountEligible); bool(line.commissionEligible);
    if (eligible !== (discountEligible?gross:0n) || allocated > eligible) fail('line_eligibility_bounds');
    equal(net,gross-allocated,'line_net_mismatch');
    if (!['known','unknown'].includes(line.attributionStatus)) fail('attribution_invalid');
    if (line.attributionStatus === 'known') id(line.sellerId); else if (line.sellerId !== null) fail('attribution_invalid');
    grossSum+=gross; discountSum+=allocated; netSum+=net; eligibleSum+=eligible;
    grossRows.push({orderItemId,numerator:quantityMilli*priceCents,gross});
    bounded(grossSum); bounded(discountSum); bounded(netSum); bounded(eligibleSum);
  }
  if (portions.size !== expected.size) fail('portion_coverage_mismatch');
  verifyGrossReconciliation(subtotal,grossRows);
  equal(grossSum,subtotal,'gross_conservation'); equal(discountSum,discount,'discount_conservation'); equal(netSum,subtotal-discount,'net_conservation');
  if (discount > eligibleSum) fail('discount_bounds');
  const fixed=policies.discountAllocation.kind === 'eligible_gross_proportional_fixed_order';
  if (fixed) {
    if (order.selectedDiscount.kind !== 'fixed_order' && !(order.selectedDiscount.kind === 'none' && discount === 0n)) fail('fixed_order_discount_required');
    const weights=input.lineSnapshots.map(line=>({id:line.orderItemId,weight:line.eligibleGrossCents}));
    const allocations=new Map(allocateIncentiveFund(order.discountCents,weights).map(row=>[row.id,row.amountCents]));
    for (const line of input.lineSnapshots) equal(line.allocatedDiscountCents,allocations.get(line.orderItemId),'fixed_allocation_mismatch');
  }
  return { validationScope:'supplied_pricing_arithmetic', venueId, currency, sourcePolicies:structuredClone(policies),
    orderSnapshot:{...structuredClone(order),sourcePortionIds:[...expected].sort()}, lineSnapshots:input.lineSnapshots.slice().sort((a,b)=>a.portionId<b.portionId?-1:a.portionId>b.portionId?1:0)
      .map(line=>({...structuredClone(line),netSaleBeforeRefundCents:line.netSaleCents})),
    totals:{grossCents:bounded(grossSum),discountCents:bounded(discountSum),netSaleBeforeRefundCents:bounded(netSum),
      venueOnlyMinimumAdjustmentCents:order.minimumAdjustmentCents,finalTotalCents:bounded(netSum+minimum)},
    ...(fixed?{allocationTieContract:'canonical_order_item_id_code_unit_v1'}:{}) };
};
module.exports={verifyPayrollOrderPricingFacts};
