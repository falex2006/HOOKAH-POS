import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=path.dirname(fileURLToPath(import.meta.url));
const require=createRequire(import.meta.url);
const {handleFinancePayableRecognitionRoute}=require(path.join(root,'../finance-payable-recognition.js'));
const venueId='11111111-1111-4111-8111-111111111111';
const payableId='22222222-2222-4222-8222-222222222222';
const userId='33333333-3333-4333-8333-333333333333';
const recognitionId='44444444-4444-4444-8444-444444444444';
const payable={id:payableId,category_id:'55555555-5555-4555-8555-555555555555',category_name_snapshot:'Аренда',title:'Октябрьская аренда',counterparty_name:'Арендодатель',basis:'Договор 1',period_from:'2026-10-01',period_to:'2026-10-31',total_amount:'60000.00',status:'approved'};
let recognition=null;
const reversals=[];
const client={
  async query(sql,values=[]){
    if(sql==='BEGIN'||sql==='COMMIT'||sql==='ROLLBACK')return{rows:[]};
    if(sql.includes('FROM finance_payable_recognitions r WHERE r.venue_id=$1 AND r.idempotency_key=$2')){
      const row=recognition?.key===values[1]?recognition:null;
      return{rows:row?[{id:row.id,payable_id:row.payableId,recognition_date:row.date,document_reference:row.reference,amount:row.amount}]:[]};
    }
    if(sql.includes('FROM finance_payables WHERE venue_id=$1 AND id=$2 FOR UPDATE'))return{rows:values[1]===payableId?[payable]:[]};
    if(sql.includes('FROM finance_payable_recognitions WHERE venue_id=$1 AND payable_id=$2'))return{rows:recognition?.payableId===values[1]?[{id:recognition.id}]:[]};
    if(sql.includes('INSERT INTO finance_payable_recognitions')){recognition={id:recognitionId,payableId:values[1],amount:values[9],date:values[10],reference:values[11],key:values[12]};return{rows:[{id:recognitionId,amount:recognition.amount}]};}
    if(sql.includes('JOIN finance_payable_recognitions r ON r.venue_id=p.venue_id'))return{rows:recognition?.id===values[2]&&payableId===values[1]?[{payable_id:payableId,recognition_id:recognitionId}]:[]};
    if(sql.includes('FROM finance_payable_recognition_reversals WHERE venue_id=$1 AND idempotency_key=$2')){const row=reversals.find((item)=>item.key===values[1]);return{rows:row?[{id:row.id,recognition_id:row.recognitionId,amount:row.amount,reversal_date:row.date,reason:row.reason,document_reference:row.reference}]:[]};}
    if(sql.includes('FROM finance_payable_recognitions r LEFT JOIN finance_payable_recognition_reversals'))return{rows:recognition?.id===values[1]?[{amount:recognition.amount,reversed:reversals.reduce((sum,item)=>sum+Number(item.amount),0).toFixed(2)}]:[]};
    if(sql.includes('INSERT INTO finance_payable_recognition_reversals')){const item={id:`reversal-${reversals.length+1}`,recognitionId:values[1],amount:values[2],date:values[3],reason:values[4],reference:values[5],key:values[6]};reversals.push(item);return{rows:[{id:item.id}]};}
    if(sql.includes('FROM finance_payable_recognitions r LEFT JOIN LATERAL'))return{rows:recognition?[{id:recognitionId,payableId,amount:'60000.00',netRecognizedAmount:String(60000-reversals.reduce((sum,item)=>sum+Number(item.amount),0))}]:[]};
    throw new Error(`unhandled SQL: ${sql}`);
  },release(){}
};
const pool={query:client.query.bind(client),connect:async()=>client};
const run=async({method='POST',pathname=`/api/finance/payables/${payableId}/recognitions`,body={},permissions=['finance']}={})=>{
  let response;
  const handled=await handleFinancePayableRecognitionRoute({req:{method,user:{id:userId,role:'owner'}},res:{},url:new URL(pathname,'http://local'),pool,venueId,json:(_res,status,data)=>{response={status,body:data};},readBody:async()=>body,hasPermission:(permission)=>permissions.includes(permission)});
  return{handled,response};
};
let out=await run({body:{recognitionDate:'2026-10-31',documentReference:'Invoice-10',idempotencyKey:'recognition-key-1'}});
assert.equal(out.response.status,201);assert.equal(out.response.body.id,recognitionId);assert.equal(out.response.body.amount,'60000.00');
out=await run({body:{recognitionDate:'2026-10-31',documentReference:'Invoice-10',idempotencyKey:'recognition-key-1'}});
assert.equal(out.response.status,200);assert.equal(out.response.body.idempotent,true);
out=await run({body:{recognitionDate:'2026-11-01',documentReference:'Invoice-10',idempotencyKey:'recognition-key-1'}});assert.equal(out.response.status,409);
out=await run({pathname:`/api/finance/payables/${payableId}/recognitions/${recognitionId}/reversals`,body:{amount:'10000',reversalDate:'2026-11-01',reason:'Перерасчёт',documentReference:'Act-11',idempotencyKey:'reversal-key-1'}});
assert.equal(out.response.status,201);assert.equal(out.response.body.signedAmount,'-10000.00');
out=await run({pathname:`/api/finance/payables/${payableId}/recognitions/${recognitionId}/reversals`,body:{amount:'10000',reversalDate:'2026-11-01',reason:'Перерасчёт',documentReference:'Act-11',idempotencyKey:'reversal-key-1'}});assert.equal(out.response.status,200);assert.equal(out.response.body.idempotent,true);
out=await run({pathname:`/api/finance/payables/${payableId}/recognitions/${recognitionId}/reversals`,body:{amount:'50001',reversalDate:'2026-11-02',reason:'Превышение',idempotencyKey:'reversal-key-2'}});assert.equal(out.response.status,409);assert.equal(reversals.length,1);
out=await run({pathname:`/api/finance/payables/${payableId}/recognitions`,permissions:['finance_read']});assert.equal(out.response.status,403);
out=await run({method:'GET',pathname:`/api/finance/payables/${payableId}/recognitions`,permissions:['finance_read']});assert.equal(out.response.status,200);assert.equal(out.response.body.items[0].netRecognizedAmount,'50000');
const migration=fs.readFileSync(path.join(root,'../migrations/121_finance_payable_recognition.sql'),'utf8');
assert.match(migration,/UNIQUE \(venue_id,payable_id\)/);assert.match(migration,/finance_payable_recognitions_append_only/);assert.match(migration,/finance_payable_recognition_reversals_append_only/);assert.match(migration,/finance_payable_recognition_reversal_exceeds_balance/);assert.match(migration,/finance_payable_has_recognition/);
const confirmationMigration=fs.readFileSync(path.join(root,'../migrations/124_finance_variable_payable_confirmation.sql'),'utf8');
assert.match(confirmationMigration,/DECLARE recognized numeric\(14,2\);[\s\S]*?FROM finance_payable_recognitions r LEFT JOIN finance_payable_recognition_reversals x[\s\S]*?IF COALESCE\(recognized,0\)>0 THEN RAISE EXCEPTION 'finance_payable_has_recognition'/,'variable-amount trigger replacement preserves the recognized-balance cancellation guard');
const server=fs.readFileSync(path.join(root,'../server.js'),'utf8');assert.match(server,/NOT EXISTS\(SELECT 1 FROM finance_payable_payment_links l WHERE l\.venue_id=e\.venue_id AND l\.expense_id=e\.id\)/);assert.match(server,/finance_payable_recognition_reversals/);assert.match(server,/payableRecognitionCoverage/);
const portal=fs.readFileSync(path.join(root,'../portal.js'),'utf8');assert.match(portal,/data-payable-recognition=/);assert.match(portal,/data-payable-recognition-reversal=/);assert.match(portal,/saveFinanceEventAttempt/);assert.match(portal,/Данные неполные/);
const payableList=fs.readFileSync(path.join(root,'../finance-payables.js'),'utf8');
assert.match(payableList,/recognitionHistory/,'payable list supports history after reload');
assert.match(payableList,/reversal\.reason/,'payable list exposes immutable reversal reasons');
assert.match(payableList,/const replayMatches\s*=\s*String\(row\.payable_id\)\.toLowerCase\(\)===id\.toLowerCase\(\)[\s\S]*?row\.document_url[\s\S]*?row\.description/,'payment idempotency compares the linked payable, attachment, and memo with normalized UUIDs');
assert.equal((payableList.match(/const replayMatches\s*=\s*String\(row\.payable_id\)\.toLowerCase\(\)===id\.toLowerCase\(\)/g)||[]).length,2,'both ordinary and concurrent payment replay paths compare the complete payload');
assert.match(portal,/История признания и сторно/,'payable UI presents immutable recognition and reversal history');
assert.match(portal,/error\.status = response\.status/,'API errors retain HTTP status for definitive rejection recovery');
assert.match(portal,/clearFinanceEventAttempt\(kind,eventId\);message\.textContent='Операция отклонена/,'definitive event rejection unlocks the form for correction');
assert.ok(portal.includes("canCancel=item.status==='draft'||(item.status==='approved'&&Number(item.settledAmount??item.netPaidAmount??paid)<=0&&['not_recognized','reversed']"),'cancellation uses net settlement including offsets and requires full recognition reversal');
const reportSource=fs.readFileSync(path.join(root,'../finance-unified-report.js'),'utf8');
assert.match(reportSource,/EXISTS \(SELECT 1 FROM finance_payable_payment_links pl JOIN expenses e[\s\S]*?e\.expense_date BETWEEN \$2::date AND \$3::date\)/,'coverage includes legacy linked payments on their cash date');
const analyticsSource=fs.readFileSync(path.join(root,'../server.js'),'utf8');
assert.match(analyticsSource,/totalExpenses:expenseTotalsIncomplete\?null:totalExpenses, knownTotalExpenses:totalExpenses/,'payable-recognition and manual-refund gaps keep the official expense total incomplete');
assert.match(analyticsSource,/netProfit:\s*profitIncomplete\s*\?\s*null:\s*knownNetProfit/,'incomplete expense or POS-refund coverage keeps the official net profit incomplete');
assert.ok(analyticsSource.includes('const allFinanceDates=[...new Set([...dailyByDate.keys(),...Object.keys(expenseMap)'), 'days without sales remain in the finance calendar for expense totals');
console.log('FINANCE PAYABLE RECOGNITION CONTRACT: PASS (explicit recognition, idempotent replay, bounded reversal, coverage, P&L/cash separation)');
