import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

// Isolated real HTTP server; repository double and controllable time, no live DB.
const useDefault = process.argv.includes('--default');
const ordinaryLimit = useDefault ? 600 : 30;
const child = spawn(process.execPath, ['-e', `
let now=1700000000000;Date.now=()=>now;
process.on('message',value=>{now+=value;process.send('advanced');});
const db=require('./db');
db.createRepositories=()=>({sessions:{get:async()=>({userId:'qa-user',role:'owner',name:'QA'})}});
require('./server');
`], {cwd:fileURLToPath(new URL('../',import.meta.url)),env:{...process.env,SKIP_LOCAL_ENV:'true',DATABASE_URL:'',AUTH_REQUIRED:'true',DEMO_MODE:'false',NODE_ENV:'test',API_RATE_LIMIT:useDefault?'':'30',PORT:'0',HOST:'127.0.0.1'},stdio:['ignore','pipe','pipe','ipc']});
try {
  const port = await new Promise((resolve,reject)=>{
    let output='';const timer=setTimeout(()=>reject(new Error('startup timeout')),15000);
    child.stdout.on('data',data=>{output+=data;const found=output.match(/localhost:(\d+)/);if(found){clearTimeout(timer);resolve(Number(found[1]));}});
    child.stderr.on('data',data=>{output+=data;});
    child.once('exit',code=>{clearTimeout(timer);reject(new Error(`exit ${code}: ${output}`));});
  });
  const advance=ms=>new Promise(resolve=>{child.once('message',resolve);child.send(ms);});
  const request=async(path,method='GET',token='qa')=>{
    const response=await fetch(`http://127.0.0.1:${port}${path}`,{method,headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(5000)});
    return {status:response.status,retry:response.headers.get('retry-after'),body:await response.json()};
  };
  for(let i=0;i<ordinaryLimit;i++) assert.equal((await request('/api/health')).status,200);
  assert.equal((await request('/api/health')).status,429);
  assert.equal((await request('/api/session')).status,200,'ordinary traffic cannot consume recovery reads');
  assert.equal((await request('/api/session/preferences')).status,200);
  for(const path of ['/api/session/preferences','/api/session/pin-return','/api/login'])
    assert.equal((await request(path,'POST')).status,429,'mutation remains in ordinary budget');
  for(let i=2;i<120;i++) assert.equal((await request(i%2?'/api/session':'/api/session/preferences','GET',`rotating-${i}`)).status,200);
  assert.equal((await request('/api/session','GET','new-token')).status,429,'token rotation must not reset IP budget');
  await advance(20500);
  for(const path of ['/api/health','/api/session/preferences']) {
    const limited=await request(path);assert.equal(limited.status,429);assert.equal(limited.retry,'40');assert.equal(limited.body.retryAfter,40);
  }
  await advance(40000);
  assert.equal((await request('/api/session')).status,200,'window expires normally');
  assert.equal((await request('/api/health')).status,200);
  console.log(`SESSION RATE BUDGET HTTP QA: PASS (ordinary limit ${ordinaryLimit}, independent bounded reads, rotating token cap, mutation isolation, exact retry window, expiry)`);
} finally {
  child.kill();
  await new Promise(resolve=>{if(child.exitCode!==null)return resolve();child.once('exit',resolve);});
}
