import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {handleFinanceUnifiedReport}=require('../finance-unified-report');
const id='11111111-1111-4111-8111-111111111111',venue='22222222-2222-4222-8222-222222222222';
let reads=[];
async function run({kind='purchase',permissions=['finance_read','inventory_read'],available=true,document={id},role='owner',method='GET',target=venue,loader=true}={}){
 let out;
 await handleFinanceUnifiedReport({req:{method,user:{role}},res:{},url:new URL(`/api/finance/source-documents/${kind}/${id}?venueId=${target}`,'http://local'),venueId:id,pool:{},hasPermission:p=>['finance','finance_read','inventory'].includes(p),resolveVenues:async(_req,selected)=>available?[{id:venue,name:'Selected',permissions}]:[],readSource:loader?async args=>{reads.push(args);return document;}:undefined,json:(_r,status,body)=>{out={status,body};}});
 return out;
}
let out=await run();assert.equal(out.status,200);assert.equal(out.body.venue.id,venue);assert.deepEqual(reads.pop(),{kind:'purchase',id,venueId:venue});
for(const kind of ['purchase','payroll','pos']){reads=[];out=await run({kind,permissions:['finance_read']});assert.equal(out.status,403);assert.equal(reads.length,0);}
assert.equal((await run({kind:'payroll',permissions:['finance']})).status,200);
assert.equal((await run({kind:'pos',permissions:['finance_read','orders'],document:{orderId:id}})).status,200);
for(const options of [{available:false},{role:'bartender'},{target:id},{permissions:['inventory_read']}]){reads=[];assert.equal((await run(options)).status,403);assert.equal(reads.length,0);}
assert.equal((await run({document:null})).status,404);
assert.equal((await run({document:{id:'wrong'}})).status,503);
assert.equal((await run({method:'POST'})).status,405);
assert.equal((await run({target:'invalid'})).status,400);
assert.equal((await run({loader:false})).status,503);
console.log('FINANCE SOURCE DOCUMENT CONTRACT: PASS (target-venue and domain permissions, no unauthorized reads,404, ID match, read-only method)');
