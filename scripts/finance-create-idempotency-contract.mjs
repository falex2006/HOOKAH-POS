import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleFinancePayableRoute } from '../finance-payables.js';

const portal=fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../portal.js'),'utf8');

const categoryId='11111111-1111-4111-8111-111111111111';
const venueId='22222222-2222-4222-8222-222222222222';
const userId='33333333-3333-4333-8333-333333333333';
const claims=new Map();
const entities={payables:[],rules:[],lines:[],versions:[]};
let sequence=0;
let loseNextCommitAcknowledgement=false;
const nextId=()=>`44444444-4444-4444-8444-${String(++sequence).padStart(12,'0')}`;
const client={query:async(sql,values=[])=>{
  if(sql==='COMMIT'&&loseNextCommitAcknowledgement){loseNextCommitAcknowledgement=false;const error=new Error('connection_lost_after_commit');error.code='08006';throw error;}
  if(['BEGIN','COMMIT','ROLLBACK'].includes(sql))return{rows:[]};
  if(sql.includes('INSERT INTO finance_create_idempotency')){
    const [venue,operation,key,hash,actor]=values;const claimKey=`${venue}:${operation}:${key}`;
    if(claims.has(claimKey))return{rows:[]};claims.set(claimKey,{venue,operation,key,hash,actor,entityId:null,response:null});return{rows:[{id:nextId()}]};
  }
  if(/SELECT request_sha256,entity_id,response\s+FROM finance_create_idempotency/.test(sql)){
    const claim=claims.get(`${values[0]}:${values[1]}:${values[2]}`);return{rows:claim?[{request_sha256:claim.hash,entity_id:claim.entityId,response:claim.response}]:[]};
  }
  if(sql.includes('SELECT id,name FROM finance_categories'))return{rows:[{id:categoryId,name:'Аренда'}]};
  if(sql.includes('INSERT INTO finance_payables')){const id=nextId();entities.payables.push({id,values});return{rows:[{id}]};}
  if(sql.includes('INSERT INTO finance_payable_lines')){entities.lines.push(values);return{rows:[]};}
  if(sql.includes('INSERT INTO finance_recurring_rules')){const id=nextId();entities.rules.push({id,values});return{rows:[{id}]};}
  if(sql.includes('INSERT INTO finance_recurring_rule_versions')){entities.versions.push(values);return{rows:[]};}
  if(sql.includes('UPDATE finance_create_idempotency')){const [entityId,response,venue,operation,key]=values;const claim=claims.get(`${venue}:${operation}:${key}`);claim.entityId=entityId;claim.response=JSON.parse(response);return{rows:[],rowCount:1};}
  throw new Error(`Unexpected SQL in create-idempotency contract: ${sql}`);
},release(){}};
const pool={connect:async()=>client};
async function post(path,body,activeVenue=venueId){
  let response;
  const handled=await handleFinancePayableRoute({
    req:{method:'POST',user:{role:'owner',id:userId}},res:{},url:new URL(path,'http://local'),pool,venueId:activeVenue,
    json:(_res,status,payload)=>{response={status,body:payload};return true;},readBody:async()=>body,
    hasPermission:(permission)=>permission==='finance',
  });
  assert.equal(handled,true);return response;
}

const payable={idempotencyKey:'payable-create-key-001',categoryId,title:'Аренда октября',counterpartyName:'Арендодатель',basis:'Договор 7',periodFrom:'2026-10-01',periodTo:'2026-10-31',dueDate:'2026-11-05',lines:[{description:'Аренда помещения',amount:'60000'}]};
loseNextCommitAcknowledgement=true;
const lostAckPayable=await post('/api/finance/payables',payable);
assert.equal(lostAckPayable.status,503,'a lost commit acknowledgement is reported as an unknown result');
assert.equal(lostAckPayable.body.error,'finance_create_result_unknown');
loseNextCommitAcknowledgement=true;
const lostReplayAckPayable=await post('/api/finance/payables',payable);
assert.equal(lostReplayAckPayable.status,503,'a lost acknowledgement while replaying stays retryable');
assert.equal(lostReplayAckPayable.body.error,'finance_create_result_unknown');
const firstPayable=await post('/api/finance/payables',payable);
assert.equal(firstPayable.status,200,'same-key replay recovers the document after a lost commit acknowledgement');
const replayPayable=await post('/api/finance/payables',payable);
assert.equal(replayPayable.status,200,JSON.stringify(replayPayable.body));
assert.deepEqual(replayPayable.body,firstPayable.body,'a retry returns the exact originally saved result');
assert.equal(entities.payables.length,1,'a lost response retry cannot create a second manual obligation');
assert.equal(entities.lines.length,1,'a retry cannot duplicate obligation lines');
const conflictPayable=await post('/api/finance/payables',{...payable,title:'Другая аренда'});
assert.equal(conflictPayable.status,409);
assert.equal(conflictPayable.body.error,'finance_create_idempotency_conflict');
assert.equal(entities.payables.length,1,'reusing a key for changed data does not create an entity');

const recurring={idempotencyKey:'recurring-rule-key-001',categoryId,title:'Регулярная аренда',counterpartyName:'Арендодатель',basis:'Договор 8',amount:'60000',lines:[{description:'Аренда',amount:'60000'}],dayOfMonth:5,startsOn:'2026-10-01',endsOn:null,variableAmount:false};
loseNextCommitAcknowledgement=true;
const lostAckRule=await post('/api/finance/recurring-rules',recurring);
assert.equal(lostAckRule.status,503,'a recurring-rule commit acknowledgement loss remains retryable');
assert.equal(lostAckRule.body.error,'finance_create_result_unknown');
loseNextCommitAcknowledgement=true;
const lostReplayAckRule=await post('/api/finance/recurring-rules',recurring);
assert.equal(lostReplayAckRule.status,503,'a recurring-rule replay commit acknowledgement loss remains retryable');
assert.equal(lostReplayAckRule.body.error,'finance_create_result_unknown');
const firstRule=await post('/api/finance/recurring-rules',recurring);
assert.equal(firstRule.status,200,'same-key replay recovers the original recurring rule');
const replayRule=await post('/api/finance/recurring-rules',recurring);
assert.equal(replayRule.status,200);
assert.deepEqual(replayRule.body,firstRule.body,'a recurring-rule retry returns the original result');
assert.equal(entities.rules.length,1,'a retry cannot create a second recurring rule');
assert.equal(entities.versions.length,1,'a retry cannot duplicate the first rate version');
const conflictRule=await post('/api/finance/recurring-rules',{...recurring,amount:'65000',lines:[{description:'Аренда',amount:'65000'}]});
assert.equal(conflictRule.status,409);
assert.equal(conflictRule.body.error,'finance_create_idempotency_conflict');
assert.equal(entities.rules.length,1,'changed data with the same key does not create another rule');

const missingKey=await post('/api/finance/payables',{...payable,idempotencyKey:''});
assert.equal(missingKey.status,400,'new creates require an idempotency key');
const otherVenueRule=await post('/api/finance/recurring-rules',recurring,'55555555-5555-4555-8555-555555555555');
assert.equal(otherVenueRule.status,201,'the same client key is independent across venues');
assert.equal(entities.rules.length,2);
assert.match(portal,/saveFinanceEventAttempt\(kind,'pending',attempt\)/,'both create forms persist their exact payload and key before sending');
assert.match(portal,/restoreFinanceCreateAttempt/,'the pending create payload is restored after reload');
assert.match(portal,/confirmFinanceCreateReadback[\s\S]*?clearFinanceEventAttempt\(kind,'pending'\)/,'the UI clears a pending create only after server readback confirms it');
assert.match(portal,/Number\(error\.status\)>=400&&Number\(error\.status\)<500/,'the UI preserves pending create attempts after an unknown 5xx result');
console.log('FINANCE CREATE IDEMPOTENCY CONTRACT: PASS (manual obligations and recurring rules; replay, changed-payload conflict, tenant scope)');
