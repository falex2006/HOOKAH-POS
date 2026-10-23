'use strict';

const {normalizePayrollSourcePolicies}=require('./payroll-source-policies');
const {createHash}=require('node:crypto');
const MAX=BigInt(Number.MAX_SAFE_INTEGER);
const fail=reason=>{throw Object.assign(new TypeError(reason),{code:reason});};
const identity=value=>{if(typeof value!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value))fail('payroll_sale_credit_identity_invalid');return value;};
const amount=value=>{if(!Number.isSafeInteger(value)||value<0)fail('payroll_sale_credit_amount_invalid');return BigInt(value);};
const safe=value=>{if(value>MAX)fail('payroll_sale_credit_amount_overflow');return Number(value);};
const date=value=>{if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value+'T00:00:00Z'))||new Date(value+'T00:00:00Z').toISOString().slice(0,10)!==value)fail('payroll_sale_credit_period_invalid');return value;};
// Preserve PostgreSQL civil/offset forms accepted by the upstream validator.
// Intl requires an instant; normalize the offset and keep microsecond ordering
// upstream. Milliseconds suffice solely for the local calendar date here.
const instant=value=>{
  const match=typeof value==='string'&&value.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}(?::\d{2}(?::\d{2})?|\d{2}(?:\d{2})?)?)$/);
  if(!match)fail('payroll_sale_credit_timestamp_invalid');
  const civil=match[1]+'T'+match[2],base=Date.parse(civil+'Z');
  if(!Number.isFinite(base)||new Date(base).toISOString().slice(0,19)!==civil)fail('payroll_sale_credit_timestamp_invalid');
  let offset=0;if(match[4]!=='Z'){const digits=match[4].slice(1).replaceAll(':',''),h=+digits.slice(0,2),m=+(digits.slice(2,4)||0),s=+(digits.slice(4,6)||0);if(h>23||m>59||s>59)fail('payroll_sale_credit_timestamp_invalid');offset=(h*3600+m*60+s)*1000*(match[4][0]==='-'?-1:1);}
  return new Date(base+Number((match[3]||'').padEnd(3,'0').slice(0,3))-offset);
};

// This consumes an already-read canonical result from the owner's RR snapshot.
// It observes current eligibility and dates, and makes no historic credit,
// recognition, commission, cost, department or official-run attestation.
const buildPayrollSaleCreditComponent=(canonical,{sourcePolicies,currency,venueId,from,to,timezone})=>{
  identity(venueId);date(from);date(to);if(from>to)fail('payroll_sale_credit_period_invalid');
  const formatter=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'});
  const localDate=value=>{const parts=Object.fromEntries(formatter.formatToParts(instant(value)).map(p=>[p.type,p.value]));return `${parts.year}-${parts.month}-${parts.day}`;};
  const base={schemaVersion:1,currency,venueId,period:{from,to,timezone},scope:'pre_refund_sale_credit',watermarkScope:'owner_policy_bound_pre_refund_sale_credit',dateScope:'current_venue_timezone',eligibilityScope:'current_eligibility_observation',historicalEligibility:'not_attested',historicalDateAssignment:'not_attested',officialReady:false,canonicalSourceWatermark:canonical?.component?.sourceWatermark??null,sourceWatermark:null};
  const empty={creditedLines:[],employees:[],grossCents:null,discountCents:null,merchandiseNetCents:null,minimumAdjustmentCents:null,finalTotalCents:null};
  const diagnostic={closedOrderCount:canonical?.component?.closedOrderCount??null,snapshotOrderCount:canonical?.component?.snapshotOrderCount??null,legacyOrderCount:canonical?.component?.legacyOrderCount??null,invalidOrderCount:canonical?.component?.invalidOrderCount??null,unknownLineCount:canonical?.attribution?.unknownLineCount??null,unsupportedCrossVenueLineCount:canonical?.attribution?.unsupportedCrossVenueLineCount??null};
  const blocked=(status,reasons)=>({...base,...diagnostic,...empty,status,reasons:[...new Set(reasons)].sort()});
  const policy=normalizePayrollSourcePolicies(sourcePolicies);
  if(typeof base.canonicalSourceWatermark==='string'&&/^[a-f0-9]{64}$/.test(base.canonicalSourceWatermark))base.sourceWatermark=createHash('sha256').update(JSON.stringify({schemaVersion:base.schemaVersion,scope:base.scope,canonicalSourceWatermark:base.canonicalSourceWatermark,sourcePolicies:policy??null,venueId,currency,from,to,timezone,dateScope:base.dateScope,eligibilityScope:base.eligibilityScope})).digest('hex');
  if(!policy)return blocked('unsupported',['explicit_owner_source_policy_selection_required']);
  if(policy.saleCredit.kind!=='line_seller_snapshot'||policy.discountAllocation.kind!=='immutable_line_snapshot')return blocked('unsupported',['payroll_sale_credit_policy_not_supported']);
  if(canonical?.component?.status==='unsupported')return blocked('unsupported',canonical.component.reasons||['canonical_pricing_schema_missing']);
  if(canonical?.component?.status!=='available'||canonical?.attribution?.status!=='available')return blocked('incomplete',[...(canonical?.component?.reasons||[]),...(canonical?.attribution?.reasons||[]),'payroll_sale_credit_canonical_incomplete']);
  try{
    if(!base.sourceWatermark)fail('payroll_sale_credit_watermark_invalid');
    if(currency!=='RUB'||!Array.isArray(canonical.orders)||canonical.component.closedOrderCount!==canonical.orders.length||canonical.component.snapshotOrderCount!==canonical.orders.length||canonical.component.legacyOrderCount!==0||canonical.component.invalidOrderCount!==0||canonical.attribution.unknownLineCount!==0||canonical.attribution.unsupportedCrossVenueLineCount!==0)fail('payroll_sale_credit_coverage_invalid');
    const seen={order:new Set(),snapshot:new Set(),item:new Set(),portion:new Set()},lines=[],employees=new Map();let gross=0n,discount=0n,net=0n,minimum=0n,final=0n;
    const unique=(type,value)=>{identity(value);if(seen[type].has(value))fail('payroll_sale_credit_identity_duplicate');seen[type].add(value);};
    for(const order of canonical.orders){unique('order',order.orderId);unique('snapshot',order.snapshotId);if(order.currency!==currency||!Array.isArray(order.lineSnapshots))fail('payroll_sale_credit_currency_shape_invalid');const saleDate=localDate(order.closedAt);if(saleDate<from||saleDate>to)fail('payroll_sale_credit_period_coverage_invalid');let og=0n,od=0n,on=0n;
      for(const line of order.lineSnapshots){unique('item',line.orderItemId);unique('portion',line.portionId);identity(line.sellerId);if(line.attributionStatus!=='known')fail('payroll_sale_credit_attribution_incomplete');const g=amount(line.grossCents),d=amount(line.allocatedDiscountCents),n=amount(line.netSaleCents);if(g-d!==n)fail('payroll_sale_credit_line_conservation_invalid');og+=g;od+=d;on+=n;
        lines.push({orderId:order.orderId,snapshotId:order.snapshotId,portionId:line.portionId,orderItemId:line.orderItemId,employeeId:line.sellerId,soldAt:line.soldAt,closedAt:order.closedAt,date:saleDate,currency,grossCents:Number(g),allocatedDiscountCents:Number(d),netSaleCents:Number(n),creditPolicy:'line_seller_snapshot',discountPolicy:'immutable_line_snapshot',sourcePolicySchemaVersion:policy.schemaVersion});
        const employee=employees.get(line.sellerId)||{employeeId:line.sellerId,lineCount:0,gross:0n,discount:0n,net:0n};employee.lineCount++;employee.gross+=g;employee.discount+=d;employee.net+=n;employees.set(line.sellerId,employee);
      }
      const m=amount(order.minimumAdjustmentCents),f=amount(order.finalTotalCents);if(og!==amount(order.subtotalCents)||od!==amount(order.discountCents)||on+m!==f)fail('payroll_sale_credit_order_conservation_invalid');gross+=og;discount+=od;net+=on;minimum+=m;final+=f;
    }
    const compare=(a,b)=>a<b?-1:a>b?1:0;
    lines.sort((a,b)=>compare(a.orderId,b.orderId)||compare(a.orderItemId,b.orderItemId));
    const summaries=[...employees.values()].sort((a,b)=>a.employeeId<b.employeeId?-1:1).map(e=>({employeeId:e.employeeId,lineCount:e.lineCount,grossCents:safe(e.gross),allocatedDiscountCents:safe(e.discount),netSaleCents:safe(e.net)}));
    if([...employees.values()].reduce((sum,e)=>sum+e.net,0n)!==net||net+minimum!==final)fail('payroll_sale_credit_employee_conservation_invalid');
    return {...base,...diagnostic,status:'available',reasons:[],creditedLineCount:lines.length,creditedLines:lines,employees:summaries,grossCents:safe(gross),discountCents:safe(discount),merchandiseNetCents:safe(net),minimumAdjustmentCents:safe(minimum),finalTotalCents:safe(final)};
  }catch(error){if(!error.code?.startsWith('payroll_sale_credit_'))throw error;return blocked('incomplete',[error.code]);}
};
module.exports={buildPayrollSaleCreditComponent};
