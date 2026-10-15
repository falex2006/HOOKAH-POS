'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),net=require('node:net');
const {spawn}=require('node:child_process'),{randomUUID}=require('node:crypto'),{Pool}=require('pg');
const {config,folder,options}=require('./staff-schedule-local-config.cjs');
const {isolatedEnvironment}=require('./staff-schedule-local-env.cjs');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function main(){
 const c=config(),f=JSON.parse(fs.readFileSync(path.join(folder,'fixtures.json'),'utf8'));assert.equal(f.database,c.database);
 const pool=new Pool(options(c)),root=path.join(__dirname,'..');let child,checks=0;
 const eq=(actual,expected)=>{assert.deepEqual(actual,expected);checks++;};
 try{
  const ownerId=f.users[0].id,managerId=randomUUID(),login=`availability-${managerId}@example.test`;
  await pool.query(`INSERT INTO users(id,venue_id,organization_id,full_name,login,password_hash,role)
    SELECT $1,$2,$3,'Availability QA',$4,password_hash,'manager' FROM users WHERE id=$5`,[managerId,f.venues[0],f.organizations[0],login,ownerId]);
  await pool.query("INSERT INTO organization_memberships(organization_id,user_id,membership_role,status,is_primary) VALUES($1,$2,'member','active',false)",[f.organizations[0],managerId]);
  const probe=net.createServer();await new Promise((resolve,reject)=>{probe.once('error',reject);probe.listen(0,'127.0.0.1',resolve);});const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  child=spawn(process.execPath,[path.join(root,'server.js')],{cwd:root,env:{...isolatedEnvironment(c,f),PORT:String(port)},stdio:'ignore',windowsHide:true});
  let ready=false;for(let i=0;i<100;i++){if(child.exitCode!==null)throw new Error('Isolated availability QA server exited');try{if((await fetch(`http://127.0.0.1:${port}/api/health`,{signal:AbortSignal.timeout(500)})).ok){ready=true;break;}}catch{}await sleep(100);}assert.ok(ready);
  const base=`http://127.0.0.1:${port}`,prefix='/api/staff/schedule';
  async function loginAs(username){const response=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password:f.password})});eq(response.status,200);return (await response.json()).token;}
  const owner={id:ownerId,token:await loginAs(f.users[0].login)},manager={id:managerId,token:await loginAs(login)};
  async function req(user,suffix,method='GET',body){const response=await fetch(base+prefix+suffix,{method,headers:{'Content-Type':'application/json',...(user?{Authorization:`Bearer ${user.token}`}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,value:await response.json()};}
  eq((await req(manager,`/employees/${managerId}/availability`,'PUT',{version:0,rules:[],exceptions:[],requestKey:randomUUID()})).status,403);
  eq((await req(owner,'/grants','PUT',{userId:managerId,access:'manage',version:0,canPublish:true,canManageSettings:true})).status,200);
  let state=await req(manager,`/employees/${managerId}/availability`);eq(state.status,200);eq(state.value.version,0);
  const payload={version:0,requestKey:randomUUID(),rules:[
   {weekday:1,kind:'available',startTime:'10:00',endTime:'18:00',endDayOffset:0,effectiveFrom:'2032-02-01',effectiveTo:'2032-02-28',note:'Окно по понедельникам'},
   {weekday:2,kind:'preferred',startTime:'10:00',endTime:'12:00',endDayOffset:0,effectiveFrom:'2032-02-01',effectiveTo:'2032-02-28',note:'Предпочтение по вторникам'},
   {weekday:3,kind:'unavailable',startTime:'12:00',endTime:'13:00',endDayOffset:0,effectiveFrom:'2032-02-01',effectiveTo:'2032-02-28',note:'Занятие'}
  ],exceptions:[{workDate:'2032-02-02',kind:'available',startTime:'09:00',endTime:'18:00',endDayOffset:0,note:'Переопределяет недельное окно'},
   {workDate:'2032-02-04',kind:'unavailable',startTime:'22:00',endTime:'02:00',endDayOffset:1,note:'Ночная недоступность'},
   {workDate:'2032-02-09',kind:'preferred',startTime:'10:00',endTime:'12:00',endDayOffset:0,note:'Предпочтительно утром'}]};
  const saved=await req(manager,`/employees/${managerId}/availability`,'PUT',payload);eq(saved.status,200);eq(saved.value.rules.length,3);eq(saved.value.exceptions.length,3);assert.ok(saved.value.version>0);checks++;
  const read=await req(manager,`/employees/${managerId}/availability`);eq(read.value.version,saved.value.version);eq(read.value.exceptions[2].kind,'preferred');
  eq((await req(manager,`/employees/${managerId}/availability`,'PUT',{...payload,version:0,requestKey:randomUUID()})).status,409);
  eq((await req(manager,`/employees/${managerId}/availability`,'PUT',{...payload,requestKey:payload.requestKey})).value.version,saved.value.version);
  eq((await req(manager,`/employees/${managerId}/availability`,'PUT',{...payload,version:saved.value.version,rules:[{...payload.rules[0],effectiveFrom:'2032-99-99'}],requestKey:randomUUID()})).status,400);
  async function preview(date,startTime,endTime){
   const created=await req(manager,'/drafts','POST',{name:`Availability ${date}`,from:date,to:date,userIds:[managerId],requestKey:randomUUID()});eq(created.status,201);
   return req(manager,`/drafts/${created.value.id}/range-preview`,'POST',{version:created.value.version,from:date,to:date,userIds:[managerId],definition:{pattern:{type:'weekdays',weekdays:[(new Date(`${date}T12:00:00Z`).getUTCDay()+6)%7+1]},slots:[{kind:'shift',startTime,endTime,endDayOffset:0,breakMinutes:0,note:''}]}});
  }
  let result=await preview('2032-02-02','08:00','17:00');eq(result.status,200);eq(result.value.conflicts[0].code,'schedule_availability_outside_window');
  result=await preview('2032-02-02','09:00','17:00');eq(result.status,200);eq(result.value.conflicts.length,0);
  result=await preview('2032-02-11','12:30','17:00');eq(result.status,200);eq(result.value.conflicts[0].code,'schedule_availability_unavailable');
  result=await preview('2032-02-05','01:00','03:00');eq(result.status,200);eq(result.value.conflicts[0].code,'schedule_availability_unavailable');
  result=await preview('2032-02-09','13:00','17:00');eq(result.status,200);eq(result.value.conflicts.length,0);eq(result.value.warnings[0].code,'schedule_preferred_availability_mismatch');
  result=await preview('2032-02-09','10:00','12:00');eq(result.status,200);eq(result.value.warnings.some(w=>w.code==='schedule_preferred_availability_mismatch'),false);
  eq((await req(manager,'','POST',{userId:managerId,workDate:'2032-02-02',plannedStart:'2032-02-02T03:00:00Z',plannedEnd:'2032-02-02T12:00:00Z',kind:'shift',breakMinutes:0,note:'',requestKey:randomUUID()})).status,409);
  const directPayload={userId:managerId,workDate:'2032-02-09',plannedStart:'2032-02-09T08:00:00Z',plannedEnd:'2032-02-09T12:00:00Z',kind:'shift',breakMinutes:0,note:'',requestKey:randomUUID()};
  const directDenied=await req(manager,'','POST',directPayload);eq(directDenied.status,409);eq(directDenied.value.error,'schedule_warnings_confirmation_required');
  eq((await req(manager,'','POST',{...directPayload,confirmWarnings:'false',reason:'Не подтверждено'})).value.error,'schedule_warnings_confirmation_required');
  const directPreferred=await req(manager,'','POST',{...directPayload,confirmWarnings:true,reason:'Сотрудник попросил именно этот интервал'});eq(directPreferred.status,201);eq(directPreferred.value.warnings[0].code,'schedule_preferred_availability_mismatch');
  const directAudit=await pool.query('SELECT reason FROM staff_schedule_events WHERE venue_id=$1 AND schedule_id=$2 ORDER BY id DESC LIMIT 1',[f.venues[0],directPreferred.value.id]);eq(directAudit.rows[0].reason,'Сотрудник попросил именно этот интервал');
  eq((await req(manager,`/employees/${f.users[5].id}/availability`)).status,404);
  const dbState=await pool.query(`SELECT count(*)::int AS rules FROM staff_schedule_availability_rules WHERE venue_id=$1 AND user_id=$2 AND active`,[f.venues[0],managerId]);eq(dbState.rows[0].rules,3);
  const warnDate='2032-02-17',warnDraft=await req(manager,'/drafts','POST',{name:'Warnings must be confirmed',from:warnDate,to:warnDate,userIds:[managerId],requestKey:randomUUID()});eq(warnDraft.status,201);
  const warnDefinition={pattern:{type:'weekdays',weekdays:[2]},slots:[{kind:'shift',startTime:'13:00',endTime:'17:00',endDayOffset:0,breakMinutes:0,note:''}]};
  const warnRange={version:warnDraft.value.version,from:warnDate,to:warnDate,userIds:[managerId],definition:warnDefinition};
  const warnPreview=await req(manager,`/drafts/${warnDraft.value.id}/range-preview`,'POST',warnRange);eq(warnPreview.status,200);assert.equal(warnPreview.value.warnings.some(w=>w.code==='schedule_preferred_availability_mismatch'),true,JSON.stringify(warnPreview.value));checks++;
  const warnApply=await req(manager,`/drafts/${warnDraft.value.id}/range-apply`,'POST',{...warnRange,fingerprint:warnPreview.value.fingerprint,requestKey:randomUUID(),confirmWarnings:true,reason:'Synthetic availability policy QA'});eq(warnApply.status,200);
  const publishPreview=await req(manager,`/drafts/${warnDraft.value.id}/publish-preview`,'POST',{version:warnApply.value.version});eq(publishPreview.status,200);eq(publishPreview.value.warnings.some(w=>w.code==='schedule_preferred_availability_mismatch'),true);
  eq((await req(manager,`/drafts/${warnDraft.value.id}/publish`,'POST',{version:warnApply.value.version,fingerprint:publishPreview.value.fingerprint,reason:'',requestKey:randomUUID()})).status,409);
  eq((await req(manager,`/drafts/${warnDraft.value.id}/publish`,'POST',{version:warnApply.value.version,fingerprint:publishPreview.value.fingerprint,reason:'Не подтверждено',confirmWarnings:'false',requestKey:randomUUID()})).status,409);
  const published=await req(manager,`/drafts/${warnDraft.value.id}/publish`,'POST',{version:warnApply.value.version,fingerprint:publishPreview.value.fingerprint,reason:'Сотрудник подтвердил время, назначение согласовано',confirmWarnings:true,requestKey:randomUUID()});eq(published.status,200);
  const staleDate='2032-02-23',staleDraft=await req(manager,'/drafts','POST',{name:'Availability preview invalidation',from:staleDate,to:staleDate,userIds:[managerId],requestKey:randomUUID()});eq(staleDraft.status,201);
  const staleRange={version:staleDraft.value.version,from:staleDate,to:staleDate,userIds:[managerId],definition:{pattern:{type:'weekdays',weekdays:[1]},slots:[{kind:'shift',startTime:'10:00',endTime:'18:00',endDayOffset:0,breakMinutes:0,note:''}]}};
  const stalePreview=await req(manager,`/drafts/${staleDraft.value.id}/range-preview`,'POST',staleRange);eq(stalePreview.status,200);eq(stalePreview.value.conflicts.length,0);
  const latestAvailability=(await req(manager,`/employees/${managerId}/availability`)).value;
  const changedAvailability=await req(manager,`/employees/${managerId}/availability`,'PUT',{version:latestAvailability.version,rules:latestAvailability.rules,exceptions:[...latestAvailability.exceptions,{workDate:staleDate,kind:'unavailable',startTime:'11:00',endTime:'12:00',endDayOffset:0,note:'Добавлено после предпросмотра'}],requestKey:randomUUID()});eq(changedAvailability.status,200);
  eq((await req(manager,`/drafts/${staleDraft.value.id}/range-apply`,'POST',{...staleRange,fingerprint:stalePreview.value.fingerprint,requestKey:randomUUID()})).status,409);
  const refreshedPreview=await req(manager,`/drafts/${staleDraft.value.id}/range-preview`,'POST',staleRange);eq(refreshedPreview.status,200);eq(refreshedPreview.value.conflicts[0].code,'schedule_availability_unavailable');
  eq((await req(owner,'/grants','PUT',{userId:managerId,access:'manage',version:1,canPublish:true,canManageSettings:false})).status,200);
  eq((await req(manager,`/employees/${managerId}/availability`)).status,403,'availability notes require settings permission');
  eq((await req(owner,`/employees/${managerId}/availability`)).status,200);
  const response={at:new Date().toISOString(),passed:true,checks,availabilityRules:2,exceptions:1,database:c.database,server:'ephemeral loopback isolated child'};
  const file=path.join(folder,`availability-http-${Date.now()}.json`);fs.writeFileSync(file,JSON.stringify(response,null,2),{flag:'wx'});console.log(`AVAILABILITY HTTP PASS ${checks}; evidence ${path.basename(file)}`);
 }finally{if(child&&!child.killed)child.kill();await pool.end();}
}
main().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
