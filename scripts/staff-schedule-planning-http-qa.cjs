'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const net=require('node:net');
const {spawn}=require('node:child_process');
const {randomUUID}=require('node:crypto');
const {Pool}=require('pg');
const {config,folder,options}=require('./staff-schedule-local-config.cjs');
const {isolatedEnvironment}=require('./staff-schedule-local-env.cjs');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function main(){
 const c=config(),f=JSON.parse(fs.readFileSync(path.join(folder,'fixtures.json'),'utf8'));
 assert.equal(f.database,c.database);
 const pool=new Pool(options(c)),root=path.join(__dirname,'..');let child;
 let checks=0; const eq=(a,b)=>{assert.deepEqual(a,b);checks++;};
 try{
  // New users keep the main browser QA's owner sessions/grants untouched.
  const users=[];
  for(const [index,role] of ['owner','manager','admin','owner'].entries()){
   const id=randomUUID(),login=`planning-http-${id}@example.test`,tenant=index===3?1:0;
   await pool.query(`INSERT INTO users(id,venue_id,organization_id,full_name,login,password_hash,role)
     SELECT $1,$2,$3,'Planning HTTP QA',$4,password_hash,$5 FROM users WHERE id=$6`,[id,f.venues[tenant],f.organizations[tenant],login,role,f.users[0].id]);
   await pool.query("INSERT INTO organization_memberships(organization_id,user_id,membership_role,status,is_primary) VALUES($1,$2,$3,'active',false)",[f.organizations[tenant],id,role==='owner'?'owner':'member']);
   users.push({id,login,role});
  }
  const probe=net.createServer();await new Promise((resolve,reject)=>{probe.once('error',reject);probe.listen(0,'127.0.0.1',resolve);});
  const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  child=spawn(process.execPath,[path.join(root,'server.js')],{cwd:root,env:{...isolatedEnvironment(c,f),PORT:String(port)},stdio:'ignore',windowsHide:true});
  let startupError=false;child.on('error',()=>{startupError=true;});
  const base=`http://127.0.0.1:${port}`,prefix='/api/staff/schedule';
  let ready=false;
  for(let i=0;i<100;i++){
   if(startupError||child.exitCode!==null)throw new Error('Isolated HTTP QA child failed to start');
   try{const h=await fetch(base+'/api/health',{signal:AbortSignal.timeout(500)});if(h.ok){ready=true;break;}}catch{}
   await sleep(100);
  }
  assert.ok(ready,'Isolated HTTP child readiness');
  async function req(user,suffix,method='GET',input,extra={}){
   const headers={'Content-Type':'application/json',...(user?{Authorization:`Bearer ${user.token}`}:{ }),...extra};
   const response=await fetch(base+prefix+suffix,{method,headers,body:input===undefined?undefined:JSON.stringify(input)});
   return {status:response.status,value:await response.json()};
  }
  for(const u of users){const r=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u.login,password:f.password})});eq(r.status,200);u.token=(await r.json()).token;u.cookie=r.headers.getSetCookie().find(s=>s.startsWith('crm_session=')).split(';')[0];}
  const [owner,manager,viewer,foreign]=users,key=()=>randomUUID();
  eq((await req(null,'/drafts')).status,401);
  eq((await req(manager,'/drafts')).status,403);
  eq((await req(owner,'/grants','PUT',{userId:manager.id,access:'manage',version:0,canPublish:false})).status,200);
  eq((await req(owner,'/grants','PUT',{userId:viewer.id,access:'view',version:0})).status,200);
  eq((await req(viewer,'/drafts')).status,403);
  const create={name:'HTTP draft',from:'2032-02-02',to:'2032-02-08',userIds:[manager.id],requestKey:key()};
  const origin=await req(null,'/drafts','POST',create,{Cookie:owner.cookie,Origin:'https://untrusted.example'});eq(origin.status,403);
  const first=await req(manager,'/drafts','POST',create);eq(first.status,201);let draft=first.value;
  eq((await req(manager,'/drafts','POST',create)).value.id,draft.id);
  eq((await req(foreign,`/drafts/${draft.id}`)).status,404);
  eq((await req(manager,`/drafts/${draft.id}`,'DELETE')).status,405);
  const definition={pattern:{type:'weekdays',weekdays:[1,2,3,4,5,6,7]},slots:[{kind:'day_off'}]};
  const created=await req(manager,'/templates','POST',{name:'HTTP template',definition,requestKey:key()});eq(created.status,201);
  const range={version:1,from:create.from,to:create.to,userIds:create.userIds,templateId:created.value.id,templateVersion:1};
  const preview=await req(manager,`/drafts/${draft.id}/range-preview`,'POST',range);eq(preview.status,200);eq(preview.value.operations.length,7);
  eq((await pool.query('SELECT count(*)::int n FROM staff_schedules WHERE user_id=$1',[manager.id])).rows[0].n,0);
  const applied=await req(manager,`/drafts/${draft.id}/range-apply`,'POST',{...range,fingerprint:preview.value.fingerprint,requestKey:key()});eq(applied.status,200);draft=applied.value;
  const pp=await req(manager,`/drafts/${draft.id}/publish-preview`,'POST',{version:draft.version});eq(pp.status,200);eq(pp.value.canPublish,false);
  const publish={version:draft.version,fingerprint:pp.value.fingerprint,requestKey:key()};
  eq((await req(manager,`/drafts/${draft.id}/publish`,'POST',publish)).status,403);
  eq((await req(manager,'/grants','PUT',{userId:manager.id,access:'manage',version:1,canPublish:true})).status,403);
  eq((await req(owner,'/grants','PUT',{userId:manager.id,access:'manage',version:1,canPublish:true})).status,200);
  const published=await req(manager,`/drafts/${draft.id}/publish`,'POST',publish);eq(published.status,200);eq(published.value.state,'published');
  eq((await req(manager,`/drafts/${draft.id}/publish`,'POST',publish)).value.version,published.value.version);
  eq((await req(manager,`/drafts/${draft.id}/discard`,'POST',{version:published.value.version,requestKey:key()})).status,409);
  eq((await req(manager,`?from=${create.from}&to=${create.to}`)).value.items.filter(e=>e.userId===manager.id).length,7);
  eq((await req(owner,'/grants','PUT',{userId:manager.id,access:'view',version:2})).value.canPublish,false);
  eq((await req(manager,`/drafts/${draft.id}`)).status,403);
  eq((await req(owner,`/templates/${created.value.id}`,'PATCH',{version:1,archived:true,requestKey:key()})).value.archived,true);
  console.log(`PLANNING HTTP PASS ${checks}: fresh full server; real login/cookie Origin/grants/readback/roles/replay/closed/tenant/range/template. Main runtime not restarted.`);
 }finally{
  if(child&&child.exitCode===null){child.kill();await Promise.race([new Promise(resolve=>child.once('exit',resolve)),sleep(3000)]);}
  await pool.end();
 }
}
main().catch(e=>{console.error(e.message);console.error(e.stack?.split('\n').filter(line=>line.trim().startsWith('at ')).slice(0,4).join('\n'));process.exitCode=1;});
