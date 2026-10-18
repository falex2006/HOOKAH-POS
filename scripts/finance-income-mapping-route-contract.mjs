import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
const here=path.dirname(fileURLToPath(import.meta.url));
const require=createRequire(import.meta.url);
const {handleFinanceIncomeRoute}=require(path.join(here,'../finance-income.js'));
const incomeSource=fs.readFileSync(path.join(here,'../finance-income.js'),'utf8');
const venueId='11111111-1111-4111-8111-111111111111';
const userId='22222222-2222-4222-8222-222222222222';
const sourceKey='Кухня';
const firstCategory='33333333-3333-4333-8333-333333333333';
const correctedCategory='44444444-4444-4444-8444-444444444444';
let mappings=[];let sourceAvailable=true;let nextId=0;const audit=[];
const client={async query(sql,values=[]){
  if(['BEGIN','COMMIT','ROLLBACK'].includes(sql))return{rows:[]};
  if(sql.includes("SELECT date_trunc('month'"))return{rows:[{date:'2026-10-01'}]};
  if(sql.includes('SELECT EXISTS(SELECT 1 FROM products'))return{rows:[{available:sourceAvailable}]};
  if(sql.includes('pg_advisory_xact_lock'))return{rows:[]};
  if(sql.includes('SELECT id,name FROM finance_categories'))return{rows:[{id:values[1],name:values[1]===firstCategory?'Доходы кухни':'Доходы бара'}]};
  if(sql.includes('FROM finance_income_category_mappings')&&sql.includes('ORDER BY revision DESC,id DESC LIMIT 1 FOR UPDATE')){const matching=mappings.filter(item=>item.sourceKey===values[1]&&item.effectiveFrom===values[2]).sort((a,b)=>b.revision-a.revision);return{rows:matching.length?[{id:matching[0].id,category_id:matching[0].categoryId,category_name_snapshot:matching[0].categoryName,revision:matching[0].revision}]:[]};}
  if(sql.includes('INSERT INTO finance_income_category_mappings')){const item={id:`mapping-${++nextId}`,sourceKey:values[1],categoryId:values[2],categoryName:values[3],effectiveFrom:values[4],revision:values[5],supersedesMappingId:values[6],createdOrder:nextId};mappings.push(item);return{rows:[{id:item.id,sourceKey:item.sourceKey,categoryId:item.categoryId,categoryName:item.categoryName,effectiveFrom:item.effectiveFrom,revision:item.revision,supersedesMappingId:item.supersedesMappingId,createdAt:`2026-10-17T12:00:0${nextId}Z`}]};}
  throw new Error(`unhandled SQL: ${sql}`);
},release(){}};
const pool={connect:async()=>client};
const run=async(categoryId,expectedMappingId=null)=>{let response;const handled=await handleFinanceIncomeRoute({req:{method:'POST',user:{id:userId,role:'owner'}},res:{},url:new URL('/api/finance/income-category-mappings','http://local'),pool,venueId,json:(_res,status,body)=>{response={status,body};},readBody:async()=>({sourceKey,categoryId,effectiveFrom:'2026-10-01',expectedMappingId}),hasPermission:permission=>permission==='finance',recordAudit:(_req,event,_type,_id,_before,after)=>audit.push({event,after})});return{handled,response};};
let result=await run(firstCategory);assert.equal(result.response.status,201);assert.equal(mappings.length,1);assert.equal(mappings[0].supersedesMappingId,null);assert.equal(mappings[0].revision,1);
result=await run(firstCategory);assert.equal(result.response.status,200);assert.equal(result.response.body.idempotent,true);assert.equal(mappings.length,1);
result=await run(correctedCategory,'mapping-1');assert.equal(result.response.status,200);assert.equal(result.response.body.supersedesMappingId,'mapping-1');assert.equal(mappings.length,2);assert.equal(mappings[0].categoryId,firstCategory,'correction leaves original mapping immutable');assert.equal(mappings[1].revision,2);assert.equal(audit.at(-1).event,'finance.income_category_mapping_corrected');
result=await run(firstCategory,'mapping-1');assert.equal(result.response.status,409);assert.equal(result.response.body.error,'finance_income_mapping_changed_retry');assert.equal(mappings.length,2,'stale retry cannot overwrite a newer correction');
sourceAvailable=false;result=await run(firstCategory,'mapping-2');assert.equal(result.response.status,400);assert.equal(result.response.body.error,'finance_income_source_not_found');assert.equal(mappings.length,2);
assert.match(incomeSource,/o\.closed_at::text AS "closedAt"/,'POS income snapshot round-trips close timestamps without JavaScript millisecond truncation');
console.log('FINANCE INCOME MAPPING ROUTE CONTRACT: PASS (pre-sale source, append-only revisions, stale correction conflict and known-source validation)');
