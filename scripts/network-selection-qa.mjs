import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const {SessionRepository}=createRequire(import.meta.url)('../db.js');
const source=readFileSync(new URL('../server.js',import.meta.url),'utf8');
const start=source.indexOf('  const networkVenueSelect =');
const end=source.indexOf("  if (pathname === '/api/finance/categories'",start);
const id='00000000-0000-0000-0000-000000000002';
const handler=new Function('req','repositories','sessionRepository','json','audit','canManageVenueIdentity',`return (async()=>{
 const pathname='/api/network/venues/${id}/select',res={},process={env:{DATABASE_URL:'configured'}};
 const denyUnless=(candidate,response,permission)=>{if(candidate.user.permissions.includes(permission))return false;json(response,403,{error:'forbidden'});return true;},requireOrganizationContext=()=>false,requestOrganizationId=()=> 'org';
 const requestAuthToken=()=> 'qa-token',hashToken=x=>x,recordAudit=audit;
 let venueDbId='old';
 ${source.slice(start,end)}
})()`);
async function scenario(mode) {
 const events=[]; const req={method:'POST',user:{venueId:'old',role:mode==='identity-denied'||mode==='permission-denied'?'manager':'owner',permissions:mode==='permission-denied'?[]:['settings']}};let response;let poolConnects=0;
 const client={release:()=>events.push('release'),query:async(sql,params)=>{
  events.push(sql);
  if(sql.startsWith('SELECT')) {assert.deepEqual(params,[id,'org']);return {rows:mode==='missing'?[]:[{id,name:'QA'}]};}
  if(sql.startsWith('UPDATE auth_sessions')) {assert.equal(req.user.venueId,'old');assert.deepEqual(params,[id,'qa-token']);if(mode==='write-error')throw Error('private diagnostic');return {rowCount:mode==='expired'?0:1};}
  if(sql==='COMMIT'&&mode==='commit-error')throw Error('commit failed');
  return {rows:[]};
 }};
 const pool={connect:async()=>{poolConnects++;return client;},query:()=>{throw Error('must use transaction client');}};
 await handler(req,{pool},new SessionRepository(pool),(_res,status,data)=>response={status,data},()=>events.push('audit'),candidate=>candidate.user.role==='owner');
 if(mode==='identity-denied'||mode==='permission-denied'){
  assert.equal(response.status,403);assert.equal(response.data.error,mode==='identity-denied'?'venue_admin_required':'forbidden');assert.equal(poolConnects,0);
  assert.equal(req.user.venueId,'old');assert.equal(events.length,0);return;
 }
 assert.equal(events.at(-1),'release');assert.ok(!events.some(x=>x.startsWith('UPDATE venues')));
 if(mode==='ok'){assert.equal(response.status,200);assert.equal(req.user.venueId,id);assert.ok(events.indexOf('COMMIT')<events.indexOf('audit'));}
 else {assert.equal(req.user.venueId,'old');assert.ok(events.includes('ROLLBACK'));assert.ok(!events.includes('audit'));assert.equal(response.status,mode==='missing'?404:mode==='expired'?401:503);assert.ok(!JSON.stringify(response).includes('private'));}
}
for(const mode of ['permission-denied','identity-denied','ok','missing','expired','write-error','commit-error'])await scenario(mode);
console.log('NETWORK SELECTION QA: PASS (settings and identity gates before database access; same transaction session write, rollback, expiry, missing venue, commit failure, no global marker mutation)');
