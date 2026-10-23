// Real router, strict normalizers and service fence; store calls are seams.
// This contract does not claim PostgreSQL or browser acceptance.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { handlePayrollSchemeRoute } = require('../payroll-scheme-routes');
const { makeService } = require('../payroll-scheme-service');
const { normalizeReviewedCorrectionPreview } = require('../payroll-reviewed-correction-command');
const store = require('../payroll-reviewed-correction-store');
const { hasPayrollVerifiedWriteSnapshot } = require('../payroll-source-fence');
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const principal = { userId:id(1), venueId:id(2) };
const preview = { operation:'apply', originalEntryId:id(3), targetEntryId:id(4) };
const command = { ...preview, expectedPlanHash:'a'.repeat(64), reason:'Reviewed return', idempotencyKey:'correction-route-01' };
const contextPath = `/api/payroll/calculation-entries/${id(3)}/corrections`;
const previewPath = '/api/payroll/reviewed-corrections/preview';
const writePath = '/api/payroll/reviewed-corrections';
const calls=[];
const service = Object.fromEntries(['getReviewedCorrectionContext','previewReviewedCorrection','applyReviewedCorrection'].map(name=>
  [name,async(...args)=>{calls.push([name,...args]);return {schemaVersion:1,replayed:false};}]));
const req = (method,path,body) => ({method,url:path,user:{id:principal.userId,venueId:principal.venueId,role:'owner'},
  headers:{host:'crm.test',origin:'https://crm.test','sec-fetch-site':'same-origin','content-type':'application/json'},
  socket:{encrypted:true},body});
const dispatch = async (request,implementation=service,readBody=async r=>r.body) => {
  const res={status:null,body:null,headers:{},setHeader(key,value){this.headers[key]=value;}};
  res.handled=await handlePayrollSchemeRoute({req:request,res,url:new URL(request.url,'https://crm.test'),service:implementation,
    readBody,json:(_res,status,body)=>{res.status=status;res.body=body;}});
  return res;
};
for(const [method,path,body,name,status] of [['GET',contextPath,undefined,'getReviewedCorrectionContext',200],
  ['POST',previewPath,preview,'previewReviewedCorrection',200],['POST',writePath,command,'applyReviewedCorrection',201]]) {
  const result=await dispatch(req(method,path,body));
  assert.equal(result.handled,true);assert.equal(result.status,status);
  assert.deepEqual(calls.at(-1),[name,principal,body||id(3)]);
}
assert.deepEqual(normalizeReviewedCorrectionPreview({operation:'waive',originalEntryId:id(3),targetEntryId:null}),
  {operation:'waive',originalEntryId:id(3),targetEntryId:null});
const replay=await dispatch(req('POST',writePath,command),{...service,applyReviewedCorrection:async()=>({replayed:true})});
assert.equal(replay.status,200);
let prior=calls.length;
for(const role of ['manager','cashier','employee']) {
  for(const [method,path,body] of [['GET',contextPath],['POST',previewPath,preview],['POST',writePath,command]]) {
    const request=req(method,path,body);request.user.role=role;
    assert.equal((await dispatch(request)).status,403);
  }
}
const anonymous=req('GET',contextPath);anonymous.user=null;
assert.equal((await dispatch(anonymous)).status,401);
const badTenant=req('GET',contextPath);badTenant.user.venueId='bad';
assert.equal((await dispatch(badTenant)).status,403);
assert.equal(calls.length,prior,'role and tenant guards precede every service call');
for(const path of [contextPath,previewPath,writePath]) {
  const method=path===contextPath?'GET':'POST',body=path===previewPath?preview:command;
  assert.equal((await dispatch(req(method,`${path}?venueId=${id(9)}`,body))).status,400);
  const wrong=await dispatch(req('DELETE',path,body));
  assert.equal(wrong.status,405);assert.equal(wrong.headers.Allow,method);
}
for(const malformed of ['invalid','%ZZ','%2F']) assert.equal((await dispatch(req('GET',`/api/payroll/calculation-entries/${malformed}/corrections`))).status,400);
for(const path of [previewPath,writePath]) {
  const request=req('POST',path,path===previewPath?preview:command);request.headers.origin='https://evil.test';
  assert.equal((await dispatch(request)).status,403);
  request.headers.origin='https://crm.test';request.headers['content-type']='text/plain';
  const wrongType=await dispatch(request);assert.equal(wrongType.status,415);assert.equal(wrongType.body.error,'json_content_type_required');
}
const malformedPreviews=[null,[],{}, {...preview,targetEntryId:null}, {...preview,operation:'waive'},
  {...preview,originalEntryId:[]}, {...preview,operation:'automatic'}, {...preview,expectedPlanHash:'a'.repeat(64)},
  {...preview,venueId:id(9)}, Object.assign(Object.create({}),preview),
  {...preview,[Symbol('extra')]:true}, Object.defineProperty({...preview},'operation',{get(){throw new Error('getter must never run');}})];
for(const value of malformedPreviews) {
  assert.throws(()=>normalizeReviewedCorrectionPreview(value),error=>error.code==='payroll_correction_preview_invalid');
  assert.equal((await dispatch(req('POST',previewPath,value))).status,400);
}
for(const value of [{...command,reason:'x'},{...command,expectedPlanHash:'bad'}, {...command,amountCents:1},
  {...command,idempotencyKey:''},{...command,operation:'waive',targetEntryId:id(4)}])
  assert.equal((await dispatch(req('POST',writePath,value))).status,400);
assert.equal(calls.length,prior,'malformed or cross-origin input never reaches the service');
const invalidJson=await dispatch(req('POST',previewPath,preview),service,async()=>{throw new SyntaxError('private body');});
assert.deepEqual(invalidJson.body,{error:'invalid_json_body'});assert.equal(invalidJson.status,400);
for(const error of [new Error('private SQL'),Object.assign(new Error('secret'),{code:'23514'}),
  Object.assign(new Error('secret'),{code:'arbitrary_database_error',status:409})]) {
  const result=await dispatch(req('POST',writePath,command),{...service,applyReviewedCorrection:async()=>{throw error;}});
  assert.deepEqual(result.body,{error:'payroll_correction_unavailable'});
}
const known=await dispatch(req('POST',writePath,command),{...service,applyReviewedCorrection:async()=>{
  throw Object.assign(new Error('private detail'),{code:'payroll_correction_plan_stale',status:409});}});
assert.equal(known.status,409);assert.deepEqual(known.body,{error:'payroll_correction_plan_stale'});

// Actual source-fenced service, owner lookup and error mapping around store seams.
const transactionCalls=[];
let currentOwner=true;
const db={async query(sql,params){
  const text=String(sql).replace(/\s+/g,' ').trim();transactionCalls.push(text);
  if(text.startsWith('SELECT pg_advisory_lock('))return {rows:[]};
  if(text.startsWith('SELECT pg_advisory_unlock('))return {rows:[{unlocked:true}]};
  if(['BEGIN ISOLATION LEVEL REPEATABLE READ READ WRITE','COMMIT','ROLLBACK'].includes(text))return {rows:[]};
  if(text.startsWith('SELECT id, full_name AS name FROM users')) {
    assert.deepEqual(params,[principal.userId,principal.venueId]);
    assert.match(text,/venue_id = \$2 AND role = 'owner' AND is_active = true AND deleted_at IS NULL FOR SHARE/);
    return {rows:currentOwner?[{id:principal.userId,name:'Owner'}]:[]};
  }
  assert.fail(`unexpected service query ${text}`);
},release(error){transactionCalls.push(error?'release-error':'release');}};
const real=makeService({query:async()=>({rows:[]}),connect:async()=>db});
const names=['readReviewedCorrectionContext','previewReviewedCorrection','applyReviewedCorrection'];
const originals=Object.fromEntries(names.map(name=>[name,store[name]]));
try {
  for(const [name,method,path,body] of [['readReviewedCorrectionContext','GET',contextPath],
    ['previewReviewedCorrection','POST',previewPath,preview],['applyReviewedCorrection','POST',writePath,command]]) {
    store[name]=async(client,actor,input,freshness)=>{
      assert.equal(client,db);assert.equal(hasPayrollVerifiedWriteSnapshot(client,principal.venueId),true);
      assert.deepEqual(actor,{...principal,name:'Owner'});assert.deepEqual(input,body||id(3));
      if(body)assert.equal(typeof freshness,'function');
      transactionCalls.push('STORE');return {schemaVersion:1,replayed:false};
    };
    transactionCalls.length=0;
    const result=await dispatch(req(method,path,body),real);assert.equal(result.status,method==='GET'||path===previewPath?200:201);
    assert.ok(transactionCalls.findIndex(text=>text.startsWith('SELECT pg_advisory_lock('))
      <transactionCalls.indexOf('BEGIN ISOLATION LEVEL REPEATABLE READ READ WRITE'));
    assert.ok(transactionCalls.indexOf('STORE')<transactionCalls.indexOf('COMMIT'));
    assert.ok(transactionCalls.some(text=>text.startsWith('SELECT pg_advisory_unlock(')));
    assert.equal(hasPayrollVerifiedWriteSnapshot(db,principal.venueId),false);
  }
  for(const [pgCode,expected] of [['23514','rejected'],['23503','rejected'],['55000','rejected'],
    ['40001','retry_required'],['40P01','retry_required'],['23505','conflict'],['42P01','schema_required'],['42703','schema_required']]) {
    store.applyReviewedCorrection=async()=>{throw Object.assign(new Error('private SQL'),{code:pgCode});};
    transactionCalls.length=0;const result=await dispatch(req('POST',writePath,command),real);
    assert.equal(result.status,409);assert.deepEqual(result.body,{error:`payroll_correction_${expected}`});
    assert.ok(transactionCalls.includes('ROLLBACK'));assert.ok(!transactionCalls.includes('COMMIT'));
    assert.equal(transactionCalls.at(-1),'release');
  }
  store.applyReviewedCorrection=async()=>{assert.fail('revoked owner must not reach correction store');};
  currentOwner=false;assert.equal((await dispatch(req('POST',writePath,command),real)).status,403);
} finally {
  for(const name of names)if(originals[name]===undefined)delete store[name];else store[name]=originals[name];
}
console.log('PASS reviewed correction API: strict preview/commit, owner/tenant/CSRF, methods/query/body, exact replay status, fenced service wiring and sanitized rollback errors');
