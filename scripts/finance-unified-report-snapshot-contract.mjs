import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here=path.dirname(fileURLToPath(import.meta.url));
const require=createRequire(import.meta.url);
const {handleFinanceUnifiedReport}=require(path.join(here,'../finance-unified-report.js'));
const venueId='11111111-1111-4111-8111-111111111111';
const userId='22222222-2222-4222-8222-222222222222';
const snapshotId='33333333-3333-4333-8333-333333333333';
const idempotencyKey='44444444-4444-4444-8444-444444444444';
const reportRows=Array.from({length:501},(_,index)=>({paymentId:`payment-${index+1}`,orderId:`order-${index+1}`,method:'cash',status:'paid',amount:'1.00',accountCoverage:'assigned',cashEquivalent:true}));
let storedSnapshot=null;let expired=false;let payrollPermission=true;let forceSnapshotConflict=false;
const client={query:async(sql)=>{
  if(sql==='BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'||sql==='COMMIT'||sql==='ROLLBACK')return{rows:[]};
  if(sql.startsWith('SELECT id,name,timezone'))return{rows:[{id:venueId,name:'QA venue',timezone:'Asia/Yekaterinburg'}]};
  if(sql.includes('FROM payments p JOIN orders o')&&sql.includes('AS "paymentId"'))return{rows:reportRows};
  return{rows:[]};
},release(){}};
const pool={connect:async()=>client,query:async(sql,values=[])=>{
  if(sql.startsWith('DELETE FROM finance_unified_report_snapshots'))return{rows:[]};
  if(sql.startsWith('INSERT INTO finance_unified_report_snapshots')){if(forceSnapshotConflict)return{rows:[]};storedSnapshot={id:snapshotId,created_at:'2026-10-18T10:00:00.000Z',expires_at:'2026-10-18T10:15:00.000Z',request_sha256:values[3],report:JSON.parse(values[5]),cursor_secret:values[6]};return{rows:[{id:snapshotId,created_at:storedSnapshot.created_at,expires_at:storedSnapshot.expires_at}]};}
  if(sql.includes('SELECT id,created_at,expires_at,request_sha256,report,cursor_secret'))return{rows:storedSnapshot?[storedSnapshot]:[]};
  if(sql.startsWith('SELECT id,venue_id,created_by,created_at,expires_at,expires_at<=clock_timestamp()'))return{rows:storedSnapshot?[{...storedSnapshot,venue_id:venueId,created_by:userId,expired}]:[]};
  if(sql.includes("AS payroll_rows")&&sql.includes("payroll_included")){const rows=storedSnapshot.report.items[values[1]]||[];return{rows:[{payroll_rows:rows.some(row=>row.source==='payroll'),payroll_included:storedSnapshot.report.payrollIncluded===true}]};}
  if(sql.startsWith("SELECT report->'sections'")){const section=values[2],offset=values[3],end=values[4],all=storedSnapshot.report.items[section]||[];return{rows:[{section_meta:storedSnapshot.report.sections[section],total_count:all.length,page_items:all.slice(offset,end)}]};}
  throw new Error(`unexpected pool SQL: ${sql}`);
}};
const permissions=()=>payrollPermission?['finance']:['finance_read'];
const run=async({pathname='/api/finance/unified-report/snapshots',method='POST',body={from:'2026-10-01',to:'2026-10-31',venueId,source:'cash_in'},query='',cursor=null,role='owner',targetPayrollPermission=payrollPermission}={})=>{
  let response;const req={method,headers:{'idempotency-key':idempotencyKey},user:{id:userId,role}};
  const handled=await handleFinanceUnifiedReport({req,res:{},url:new URL(pathname+query,'http://local'),pool,venueId,json:(_res,status,payload)=>{response={status,body:payload};return true;},readBody:async()=>body,hasPermission:key=>permissions().includes(key),resolveVenues:async()=>[{id:venueId,name:'QA venue',timeZone:'Asia/Yekaterinburg',permissions:targetPayrollPermission?['finance']:['finance_read']}]});
  return{handled,response};
};

let result=await run();assert.equal(result.handled,true);assert.equal(result.response.status,201);assert.equal(result.response.body.items.cashInflows.length,500,'initial page contains exactly 500 rows');assert.equal(result.response.body.sections.cashInflows.count,501,'metadata counts the complete frozen section');assert.equal(result.response.body.sections.cashInflows.knownTotalMinor,'50100','full section total is independent of page size');assert.ok(result.response.body.nextCursorBySection.cashInflows,'501st row has a continuation cursor');
const cursor=result.response.body.nextCursorBySection.cashInflows;
forceSnapshotConflict=true;const replay=await run({targetPayrollPermission:false});assert.equal(replay.response.status,403,'idempotent POST replay cannot return payroll snapshot after target-venue permission downgrade');forceSnapshotConflict=false;
result=await run({method:'GET',pathname:`/api/finance/unified-report/snapshots/${snapshotId}/sections/cashInflows`,query:`?venueId=${venueId}&cursor=${encodeURIComponent(cursor)}`});assert.equal(result.response.status,200);assert.deepEqual(result.response.body.items.cashInflows.map(row=>row.paymentId),['payment-501'],'next page has no gap or duplicate');assert.equal(result.response.body.sections.cashInflows.knownTotalMinor,'50100','page keeps original report totals');
result=await run({method:'GET',pathname:`/api/finance/unified-report/snapshots/${snapshotId}/sections/cashInflows`,query:`?venueId=${venueId}&cursor=${encodeURIComponent(cursor+'x')}`});assert.equal(result.response.status,400,'tampered cursor is rejected');
storedSnapshot.report.payrollIncluded=true;storedSnapshot.report.items.cashOutflows=[{id:'payroll-expense',source:'payroll',payrollEntryId:'payroll-entry'}];
payrollPermission=true;result=await run({method:'GET',pathname:`/api/finance/unified-report/snapshots/${snapshotId}/sections/cashOutflows`,query:`?venueId=${venueId}`,targetPayrollPermission:false});assert.equal(result.response.status,403,'active finance permission cannot override target-venue payroll restriction');
result=await run({method:'GET',pathname:`/api/finance/unified-report/snapshots/${snapshotId}/sections/cashAccountCoverage`,query:`?venueId=${venueId}`,targetPayrollPermission:false});assert.equal(result.response.status,403,'cash account aggregates from a payroll-inclusive snapshot require target finance permission');
payrollPermission=false;result=await run({method:'GET',pathname:`/api/finance/unified-report/snapshots/${snapshotId}/sections/payrollAccruals`,query:`?venueId=${venueId}`});assert.equal(result.response.status,403,'current finance permission is required for payroll pages');payrollPermission=true;
expired=true;result=await run({method:'GET',pathname:`/api/finance/unified-report/snapshots/${snapshotId}/sections/cashInflows`,query:`?venueId=${venueId}`});assert.equal(result.response.status,410);assert.equal(result.response.body.error,'finance_report_snapshot_expired');
console.log('FINANCE UNIFIED REPORT SNAPSHOT CONTRACT: PASS (501 rows, stable page totals, signed cursor, payroll permission, expiry)');
