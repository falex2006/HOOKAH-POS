import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Run the real HTTP server with an isolated repository double, never a live DB.
const cwd = fileURLToPath(new URL('../', import.meta.url));
const childSource = `
const crypto=require('node:crypto');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const calls=new Map();
const db=require('./db');
db.createRepositories=()=>({sessions:{get:async token=>{
 const count=(calls.get(token)||0)+1;calls.set(token,count);
 if(token===hash('recover')&&count===1 || (token===hash('second-read')||token===hash('session-read'))&&count===2) throw new Error('private database connection details');
 if(token===hash('recover')||token===hash('second-read')||token===hash('session-read')) return {userId:'test-owner',role:'owner',name:'QA',createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+86400000).toISOString()};
 return null;
}}});
require('./server');`;
const child=spawn(process.execPath,['-e',childSource],{cwd,env:{...process.env,SKIP_LOCAL_ENV:'true',DATABASE_URL:'',AUTH_REQUIRED:'true',DEMO_MODE:'false',NODE_ENV:'test',PORT:'0',HOST:'127.0.0.1'},stdio:['ignore','pipe','pipe']});
let output='';
try {
 const port=await new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(new Error('server start timed out')),15000);
  child.stdout.on('data',chunk=>{output+=chunk;const match=output.match(/localhost:(\d+)/);if(match){clearTimeout(timer);resolve(Number(match[1]));}});
  child.stderr.on('data',chunk=>{output+=chunk;});
  child.once('exit',code=>{clearTimeout(timer);reject(new Error('server exited '+code+': '+output));});
 });
 const request=async(token,path='/api/session',options={})=>{
  const response=await fetch('http://127.0.0.1:'+port+path,{...options,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},signal:AbortSignal.timeout(5000)});
  return {status:response.status,payload:await response.json(),cookie:response.headers.get('set-cookie')};
 };
 const unavailable=await request('recover');
 assert.equal(unavailable.status,503);
 assert.deepEqual(unavailable.payload,{error:'authentication_unavailable'});
 assert.equal(unavailable.cookie,null,'transient failure must not revoke the cookie');
 const recovered=await request('recover');
 assert.equal(recovered.status,200,'same token recovers after transient store error');
 assert.equal(recovered.payload.user.id,'test-owner');
 assert.equal((await request('missing')).status,401,'missing/revoked token is still denied');
 assert.equal((await request('session-read')).status,503,'session route secondary lookup also maps outage to503');
 const extraLookup=await request('second-read','/api/session/pin-return',{method:'POST',body:JSON.stringify({pin:'1234'})});
 assert.equal(extraLookup.status,503,'PIN-return secondary lookup also maps outage to503');
 assert.deepEqual(extraLookup.payload,{error:'authentication_unavailable'});
 console.log('SESSION TRANSIENT HTTP QA: PASS (503 without revocation; same-token recovery; missing token401; secondary PIN lookup503)');
} finally {
 child.kill();
 await new Promise(resolve=>{if(child.exitCode!==null)return resolve();child.once('exit',resolve);});
}
