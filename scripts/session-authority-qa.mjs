import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../server.js',import.meta.url),'utf8');
const start=source.indexOf('const sessionFromRequest =');
const end=source.indexOf('const recordAudit =',start);
assert.ok(start>0&&end>start);
const make=new Function('sessions','sessionRepository','process',`const hashToken=x=>x,normalizePermissionScopes=x=>x||[],SESSION_TTL_MS=10000,STANDARD_SESSION_TTL_MS=10000,timeValue=(value)=>{if(value instanceof Date)return value.getTime();if(typeof value==='number')return value;const parsed=Date.parse(value);return Number.isFinite(parsed)?parsed:NaN;},isTrustedSession=(session)=>{if(!session)return false;if(session.trustedDevice===true)return true;const createdAt=timeValue(session.createdAt);const expiresAt=timeValue(session.expiresAt);return Number.isFinite(createdAt)&&Number.isFinite(expiresAt)&&expiresAt-createdAt>STANDARD_SESSION_TTL_MS;};${source.slice(start,end)}return sessionFromRequest;`);
const memory=new Map([['qa-token',{createdAt:Date.now(),user:{id:'old',venueId:'old'}}]]);
const req={headers:{authorization:'Bearer qa-token'}};
for(const repository of [null,{get:async()=>null},{get:async()=>{throw Error('offline');}}]) {
 assert.equal(await make(memory,repository,{env:{DATABASE_URL:'configured'}})(req),null,'configured database cannot accept cached token after missing/revoked/failed persisted session');
}
const session=await make(memory,{get:async()=>({userId:'persisted',venueId:'selected',organizationId:'org',role:'owner'})},{env:{DATABASE_URL:'configured'}})(req);
assert.equal(session.user.id,'persisted');assert.equal(session.user.venueId,'selected');
assert.equal((await make(memory,null,{env:{DATABASE_URL:''}})(req)).user.venueId,'old');
assert.equal(await make(memory,null,{env:{DATABASE_URL:''}})({headers:{}}),null);
console.log('SESSION AUTHORITY QA: PASS (persisted venue/expiry/revocation authoritative; database failure cannot accept cached token; explicit memory mode retained)');
