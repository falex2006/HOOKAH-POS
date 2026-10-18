import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {validateQaDatabaseUrl,assertQaDatabaseIdentity} from './postgres-qa-safety.mjs';
const require=createRequire(import.meta.url),{Client,Pool}=require('pg');
const {readCanonicalPayrollPricingInTransaction:read}=require('../payroll-canonical-pricing-source.js');
const {readPayrollSourceReadinessInTransaction:readiness}=require('../payroll-source-readiness.js');
const {readPayrollItemReturnEvidenceInTransaction:readReturns}=require('../payroll-item-return-source.js');
const {makePayrollAttendanceManifestService}=require('../payroll-attendance-manifest.js');
const target=validateQaDatabaseUrl(process.env.MIGRATIONS_PG_TEST_DATABASE_URL),root=fileURLToPath(new URL('../',import.meta.url));
const schema=`payroll_sale_credit_qa_${process.pid}_${Date.now()}`,db=new Client({connectionString:target.url.href}),url=new URL(target.url);url.searchParams.set('options',`-c search_path=${schema}`);
let pool,created=false;
const insert=async(client,table,row)=>{const fields=Object.keys(row);return (await client.query(`INSERT INTO ${table}(${fields.join(',')}) VALUES(${fields.map((_,i)=>'$'+(i+1)).join(',')}) RETURNING id`,fields.map(k=>row[k]&&typeof row[k]==='object'&&!Array.isArray(row[k])?JSON.stringify(row[k]):row[k]))).rows[0].id;};
try{
 await db.connect();assertQaDatabaseIdentity((await db.query('SELECT current_database() AS database,inet_server_addr() AS address,inet_server_port() AS port,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser')).rows[0],target.database,+target.url.port);
 await db.query(`CREATE SCHEMA ${schema}`);created=true;await db.query(`SET search_path TO ${schema}`);await db.query(readFileSync(path.join(root,'schema.sql'),'utf8'));await db.query('DROP TRIGGER IF EXISTS pos_order_item_after_snapshot ON order_items');await db.query('DROP TABLE IF EXISTS order_refund_items,pos_order_item_return_balances,pos_order_pricing_snapshot_lines,pos_order_pricing_snapshots CASCADE');
 for(const name of readdirSync(path.join(root,'migrations')).filter(n=>/^\d{3}.*\.sql$/.test(n)&&+n.slice(0,3)<=89).sort())await db.query(readFileSync(path.join(root,'migrations',name),'utf8'));
 pool=new Pool({connectionString:url.href});
 const venue=async(name)=>insert(db,'venues',{name,timezone:'Asia/Yekaterinburg'}),tenant=await venue('Canonical QA'),foreign=await venue('Foreign QA'),bad=await venue('Bad QA');
 const user=async(venue_id,name)=>insert(db,'users',{venue_id,full_name:name,login:schema+name,role:'owner'}),owner=await user(tenant,'Owner'),foreignOwner=await user(foreign,'Foreign'),badOwner=await user(bad,'Bad');
 const products=new Map();for(const venueId of [tenant,foreign,bad])products.set(venueId,await insert(db,'products',{venue_id:venueId,name:'Tea',category:'bar',sale_price:'10.00'}));
 // Real090 guards apply to committed synthetic source fixtures. This test is
 // not an assertion that the POS HTTP producer generated these facts.
 const fixture=async(client=db,{venueId=tenant,ownerId=owner,sellerId=ownerId,lockAt='2026-10-31T19:00:00Z',closedAt='2026-11-01T12:00:00Z',legacy=false,unknown=false,gross='1000',minimum='0',quantity='1.000',price='10.00'}={})=>{
  await client.query('BEGIN');try{
   const aggregateGross=BigInt(gross)<=999999999999n?BigInt(gross):1000n;const aggregateDecimal=(aggregateGross/100n)+'.'+String(aggregateGross%100n).padStart(2,'0');const order=await insert(client,'orders',{venue_id:venueId,opened_by:ownerId,status:'closed',closed_at:closedAt,pricing_locked_at:lockAt,pricing_version:1,subtotal_snapshot:aggregateDecimal,discount_total_snapshot:'0.00',minimum_adjustment_snapshot:(Number(minimum)/100).toFixed(2),final_total_snapshot:((Number(aggregateGross)+Number(minimum))/100).toFixed(2)});
   const item=await insert(client,'order_items',{order_id:order,product_id:products.get(venueId),quantity,unit_price:price,station:'bar',sales_employee_id:unknown?null:sellerId,sold_at:unknown?null:lockAt});
   let snapshot,line;
   if(!legacy){snapshot=await insert(client,'pos_order_pricing_snapshots',{venue_id:venueId,order_id:order,sold_at:lockAt,transaction_at:lockAt,subtotal_minor:gross,discount_minor:'0',minimum_adjustment_minor:minimum,final_total_minor:String(BigInt(gross)+BigInt(minimum)),discount_source:'none',winner_source_ids:[],eligible_item_ids:[],winner_terms:{},frozen_terms:{allocationPolicy:'largest-remainder-item-id-v1',offers:[],inputs:{approvedDiscounts:[],promotions:[]},minimumAdjustment:Number(minimum)}});
    line=await insert(client,'pos_order_pricing_snapshot_lines',{venue_id:venueId,snapshot_id:snapshot,order_id:order,order_item_id:item,seller_id:unknown?null:sellerId,sold_at:unknown?null:lockAt,quantity,unit_price:price,gross_minor:gross,discount_minor:'0',net_minor:gross,eligible:false,product_facts:{productId:products.get(venueId),productName:'Tea',category:'bar',station:'bar',productActive:true}});
   }
   await client.query('COMMIT');return {order,item,snapshot,line};
  }catch(e){await client.query('ROLLBACK');throw e;}
 };
 const {buildPayrollSaleCreditComponent:build}=require('../payroll-sale-credit-source.js');
 const policies={schemaVersion:1,selectionReason:'PG source contract',saleCredit:{kind:'line_seller_snapshot'},discountAllocation:{kind:'immutable_line_snapshot'},refunds:{recognition:'recognized_event_date',closedRunTreatment:'next_open_run_adjustment',paidAdjustment:'owner_review_variable_pay_only',uncoveredBalance:'carry_forward_review',clawback:'no_automatic_clawback'}};
 const options={venueId:tenant,currency:'RUB',from:'2026-11-01',to:'2026-11-02',timezone:'Asia/Yekaterinburg',sourcePolicies:policies};
 const transaction=async(fn)=>{const client=await pool.connect();try{await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');assert.equal((await client.query("SHOW transaction_read_only")).rows[0].transaction_read_only,'on');const result=await fn(client);await client.query('COMMIT');return result;}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}};
 const component=(opts=options)=>transaction(async client=>build(await read(client,opts),opts));
 const integration=(opts=options,userId=owner)=>transaction(async client=>{const result=await readiness(client,{venueId:opts.venueId,userId},{versionId:'aaaaaaaa-aaaa-4aaa-8aaa-000000000001',currency:opts.currency,sourcePolicies:opts.sourcePolicies},{from:opts.from,to:opts.to},makePayrollAttendanceManifestService(pool));assert.equal(result.officialReady,false);for(const name of ['recognizedLineRefunds','fullEmployeeNetRevenue','marginCosts','departmentShiftAllocation'])assert.equal(result.components[name].status,'unsupported');assert.deepEqual(result.components.payrollSaleCredit,build(await read(client,opts),opts));return result.components.payrollSaleCredit;});
 // No public fallback: the runner initializes public with current 090 tables.
 assert.equal((await db.query("SELECT to_regclass('pos_order_pricing_snapshots') IS NULL AS missing")).rows[0].missing,true,'fixture schema alone must hide runner public canonical tables before 090');
 assert.equal((await component()).status,'unsupported','pre-090 isolated fixture has no canonical capability');
 await db.query(readFileSync(path.join(root,'migrations','090_pos_order_pricing_snapshots.sql'),'utf8'));
 const empty=await component();assert.equal(empty.status,'available');assert.equal(empty.merchandiseNetCents,0);assert.equal(empty.officialReady,false);
 const first=await fixture(db,{closedAt:'2026-10-31T19:00:00Z',minimum:'500'});
 await fixture(db,{lockAt:'2026-10-31T18:00:00Z',closedAt:'2026-10-31T18:59:59.999999Z'});
 await fixture(db,{closedAt:'2026-11-02T19:00:00Z'});
 await fixture(db,{venueId:foreign,ownerId:foreignOwner});
 const baseline=await component();assert.equal(baseline.status,'available',JSON.stringify(baseline));assert.equal(baseline.creditedLineCount,1);assert.equal(baseline.creditedLines[0].date,'2026-11-01');assert.equal(baseline.creditedLines[0].orderId,first.order);assert.equal(baseline.merchandiseNetCents,1000);assert.equal(baseline.minimumAdjustmentCents,500);assert.equal(baseline.finalTotalCents,1500);assert.equal(baseline.employees[0].netSaleCents,1000,'noncommission merchandise credited; venue minimum excluded');assert.equal(baseline.historicalEligibility,'not_attested');assert.equal(baseline.historicalDateAssignment,'not_attested');assert.equal(baseline.dateScope,'current_venue_timezone');assert.deepEqual(await integration(),baseline);
 const counts=async()=>(await db.query('SELECT (SELECT count(*)::int FROM payroll_entries) entries,(SELECT count(*)::int FROM expenses) expenses,(SELECT count(*)::int FROM payroll_calculation_runs) runs')).rows[0];const financialBefore=await counts();
 assert.equal((await component({...options,venueId:foreign})).merchandiseNetCents,1000);
 const alternative={...policies,saleCredit:{kind:'order_responsible_snapshot'}};assert.equal((await integration({...options,sourcePolicies:alternative})).status,'unsupported');assert.equal((await integration({...options,sourcePolicies:undefined})).status,'unsupported');
 await transaction(async client=>{const before=build(await read(client,options),options);await fixture(db,{});assert.deepEqual(build(await read(client,options),options),before,'committed source invisible within existing RR');});assert.equal((await component()).merchandiseNetCents,2000);
 // Membership is observed now, never asserted as historical authority.
 await transaction(async client=>{const before=build(await read(client,options),options);await db.query('UPDATE users SET venue_id=$1 WHERE id=$2',[foreign,owner]);assert.deepEqual(build(await read(client,options),options),before,'membership observation is RR stable');});
 const moved=await component();assert.equal(moved.status,'incomplete');assert.equal(moved.merchandiseNetCents,null);assert.equal(moved.historicalEligibility,'not_attested');await db.query('UPDATE users SET venue_id=$1 WHERE id=$2',[tenant,owner]);
 const organization=await insert(db,'organizations',{name:'Sale credit cross QA',slug:schema+'-cross'}),crossVenue=await insert(db,'venues',{name:'Cross venue source',timezone:options.timezone,organization_id:organization}),crossOwner=await user(crossVenue,'CrossOwner');products.set(crossVenue,await insert(db,'products',{venue_id:crossVenue,name:'Tea',category:'bar',sale_price:'10.00'}));await db.query("INSERT INTO organization_memberships(organization_id,user_id,membership_role,status) VALUES($1,$2,'member','active')",[organization,foreignOwner]);await fixture(db,{venueId:crossVenue,ownerId:crossOwner,sellerId:foreignOwner});const cross=await integration({...options,venueId:crossVenue},crossOwner);assert.equal(cross.status,'incomplete');assert.equal(cross.unsupportedCrossVenueLineCount,1);assert.equal(cross.unknownLineCount,0);assert(cross.reasons.includes('cross_venue_payroll_employee_unsupported'));assert.equal(cross.merchandiseNetCents,null);
 await fixture(db,{unknown:true});const unknown=await integration();assert.equal(unknown.status,'incomplete');assert.equal(unknown.unknownLineCount,1);assert.equal(unknown.merchandiseNetCents,null);
 await fixture(db,{legacy:true});const legacy=await component();assert.equal(legacy.status,'incomplete');assert.equal(legacy.legacyOrderCount,1);
 assert.deepEqual(await counts(),financialBefore,'source fixtures/readers never post payroll/expenses/runs');
 console.log('PAYROLL SALE CREDIT SOURCE POSTGRES: PASS (real090, noncommission/minimum conservation, boundary/tenant, sameRR source/membership, unknown/legacy, readiness blocked downstream, no posting)');
}finally{await pool?.end();if(created){await db.query('ROLLBACK');await db.query('SET search_path TO public');await db.query(`DROP SCHEMA ${schema} CASCADE`);assert.equal((await db.query('SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname=$1) present',[schema])).rows[0].present,false);}await db.end();}
