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
const {capturePolicy}=require('./staff-schedule-policy-fixture.cjs');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function main(){
 const c=config(),f=JSON.parse(fs.readFileSync(path.join(folder,'fixtures.json'),'utf8'));
 assert.equal(f.database,c.database);
 const pool=new Pool(options(c)),root=path.join(__dirname,'..'),restorePolicy=await capturePolicy(pool,f.venues[0]);let child;
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
  const managerGrant=await req(owner,'/grants','PUT',{userId:manager.id,access:'manage',version:0,canPublish:false});eq(managerGrant.status,200);eq(managerGrant.value.canManageSettings,false);
  eq((await req(owner,'/grants','PUT',{userId:viewer.id,access:'view',version:0})).status,200);
  eq((await req(viewer,'/drafts')).status,403);
  const create={name:'HTTP draft',from:'2032-02-02',to:'2032-02-08',userIds:[manager.id],requestKey:key()};
  const origin=await req(null,'/drafts','POST',create,{Cookie:owner.cookie,Origin:'https://untrusted.example'});eq(origin.status,403);
  const first=await req(manager,'/drafts','POST',create);eq(first.status,201);let draft=first.value;
  eq((await req(manager,'/drafts','POST',create)).value.id,draft.id);
  eq((await req(foreign,`/drafts/${draft.id}`)).status,404);
  eq((await req(manager,`/drafts/${draft.id}`,'DELETE')).status,405);
  const definition={pattern:{type:'weekdays',weekdays:[1,2,3,4,5,6,7]},slots:[{kind:'day_off'}]};
  eq((await req(manager,'/templates','POST',{name:'Denied template',definition,requestKey:key()})).status,403);
  eq((await req(manager,'/series','POST',{name:'Denied series',userId:manager.id,functionId:null,anchorDate:'2036-01-01',untilDate:'2036-01-07',recurrence:{pattern:definition.pattern,slots:[{kind:'day_off'}]},requestKey:key()})).status,403);
  const settingsGrant=await req(owner,'/grants','PUT',{userId:manager.id,access:'manage',version:1,canManageSettings:true});eq(settingsGrant.status,200);eq(settingsGrant.value.canManageSettings,true);
  eq((await req(manager,'/access')).value.canManageSettings,true);
  const demandFunctions=await req(manager,'/functions');eq(demandFunctions.status,200);assert.ok(demandFunctions.value.items.some(item=>item.active));
  const demandFunction=demandFunctions.value.items.find(item=>item.active),demandDate=new Date(Date.UTC(2050,0,1)+Math.floor(Math.random()*36500)*86400000).toISOString().slice(0,10),demandTo=new Date(Date.parse(`${demandDate}T12:00:00Z`)+86400000).toISOString().slice(0,10);
  const demandBody={functionId:demandFunction.id,scope:'date_range',effectiveFrom:demandDate,effectiveTo:demandTo,startTime:'10:00',endTime:'14:00',endDayOffset:0,requiredCount:2,active:true,requestKey:key()};
  eq((await req(viewer,'/demand-rules','POST',{...demandBody,requestKey:key()})).status,403);
  eq((await req(viewer,'/demand-rules')).status,200);
  const demandCreated=await req(manager,'/demand-rules','POST',demandBody);eq(demandCreated.status,201);eq(demandCreated.value.version,1);
  eq((await req(manager,`/demand-rules?functionId=${demandFunction.id}`)).value.items.some(item=>item.id===demandCreated.value.id),true);
  eq((await req(foreign,`/demand-rules/${demandCreated.value.id}`,'PATCH',{...demandBody,requestKey:key(),version:1})).status,404);
  const demandUpdated=await req(manager,`/demand-rules/${demandCreated.value.id}`,'PATCH',{...demandBody,requiredCount:3,requestKey:key(),version:1});eq(demandUpdated.status,200);eq(demandUpdated.value.version,2);
  eq((await req(manager,`/demand-rules/${demandCreated.value.id}`,'PATCH',{...demandBody,requestKey:key(),version:1})).status,409);
  const defaultsPolicy=await req(manager,'/venue-policy');eq(defaultsPolicy.status,200);const policyVersion=defaultsPolicy.value.version;
  const deniedPolicy=await req(viewer,'/venue-policy');eq(deniedPolicy.status,403);
  const policySaved=await req(manager,'/venue-policy','PUT',{version:policyVersion,requestKey:key(),thresholds:{maxWeeklyMinutes:100,minimumRestMinutes:720,maximumConsecutiveDays:5},businessHoursEnabled:true,intervals:[{weekday:2,startTime:'10:00',endTime:'18:00',endDayOffset:0}]});eq(policySaved.status,200);eq(policySaved.value.version,policyVersion+1);eq(policySaved.value.intervals.length,1);
  const stalePolicy=await req(manager,'/venue-policy','PUT',{version:policyVersion,requestKey:key(),thresholds:{maxWeeklyMinutes:null,minimumRestMinutes:null,maximumConsecutiveDays:null},businessHoursEnabled:false,intervals:[]});eq(stalePolicy.status,409);
  eq((await req(manager,'/venue-policy','PUT',{version:policyVersion+1,requestKey:'not-a-uuid',thresholds:{maxWeeklyMinutes:null,minimumRestMinutes:null,maximumConsecutiveDays:null},businessHoursEnabled:false,intervals:[]})).status,400);
  const functionName=`QA Hookah ${key().slice(0,8)}`,functionCreate=await req(manager,'/functions','POST',{name:functionName,requestKey:key()});eq(functionCreate.status,201);const functionId=functionCreate.value.id;
  eq((await req(manager,'/functions','POST',{name:` ${functionName.toLowerCase()} `,requestKey:key()})).status,409);
  const qualificationKey=key(),qualifications=await req(manager,`/employees/${manager.id}/functions`,'PUT',{version:0,functionIds:[functionId],primaryFunctionId:functionId,requestKey:qualificationKey});eq(qualifications.status,200);eq(qualifications.value.items.length,1);eq(qualifications.value.items[0].isPrimary,true);
  eq((await req(manager,`/employees/${manager.id}/functions`)).value.version,qualifications.value.version);
  eq((await req(manager,`/employees/${foreign.id}/functions`)).status,404);
  eq((await req(manager,`/employees/${manager.id}/functions`,'PUT',{version:0,functionIds:[],requestKey:key()})).status,409);
  eq((await req(manager,`/employees/${manager.id}/functions`,'PUT',{version:0,functionIds:[functionId],primaryFunctionId:functionId,requestKey:qualificationKey})).value.version,qualifications.value.version);
  const seriesInput={name:'HTTP recurring series',userId:manager.id,functionId:functionId,anchorDate:'2036-01-01',untilDate:'2036-01-07',recurrence:{pattern:{type:'weekdays',weekdays:[1,3,5]},slots:[{kind:'shift',startTime:'10:00',endTime:'18:00',endDayOffset:0,breakMinutes:30,note:'HTTP series'}]},exceptions:[],state:'active',reason:'HTTP QA',requestKey:key()};
  const createdSeries=await req(manager,'/series','POST',seriesInput);eq(createdSeries.status,201);eq(createdSeries.value.version,1);eq((await req(manager,`/series/${createdSeries.value.id}`)).value.recurrence.slotKeys.length,1);
  eq((await req(manager,`/series/${createdSeries.value.id}`,'PATCH',{...seriesInput,state:'paused',version:1,requestKey:key()})).status,200);
  eq((await req(manager,`/series/${createdSeries.value.id}`,'PATCH',{...seriesInput,state:'active',version:1,requestKey:key()})).status,409);
  const teamDefinition={schemaVersion:2,mode:'team',pattern:definition.pattern,members:[{userId:manager.id,functionId,slots:[{kind:'shift',startTime:'10:00',endTime:'18:00',breakMinutes:30,note:'Утро'}]}]};
  const teamTemplate=await req(manager,'/templates','POST',{name:'HTTP team template',definition:teamDefinition,requestKey:key()});eq(teamTemplate.status,201);eq(teamTemplate.value.definition.mode,'team');
  const teamDraftInput={name:'HTTP team draft',from:'2032-02-10',to:'2032-02-16',userIds:[manager.id],requestKey:key()};
  const teamDraftResult=await req(manager,'/drafts','POST',teamDraftInput);eq(teamDraftResult.status,201);let teamDraft=teamDraftResult.value;
  const teamRange={version:1,from:teamDraftInput.from,to:teamDraftInput.to,userIds:teamDraftInput.userIds,templateId:teamTemplate.value.id,templateVersion:1};
  const teamPreview=await req(manager,`/drafts/${teamDraft.id}/range-preview`,'POST',teamRange);eq(teamPreview.status,200);eq(teamPreview.value.operations.length,7);eq(teamPreview.value.operations[0].payload.functionId,functionId);
  eq(teamPreview.value.warnings.some(w=>w.code==='schedule_max_weekly_minutes'),true);eq(teamPreview.value.warnings.some(w=>w.code==='schedule_max_consecutive_days'),true);eq(teamPreview.value.warnings.some(w=>w.code==='schedule_outside_business_hours'),true);
  eq((await req(manager,`/drafts/${teamDraft.id}/range-apply`,'POST',{...teamRange,fingerprint:teamPreview.value.fingerprint,requestKey:key()})).status,409);
  const warningKey=key(),warningApply=await req(manager,`/drafts/${teamDraft.id}/range-apply`,'POST',{...teamRange,fingerprint:teamPreview.value.fingerprint,requestKey:warningKey,confirmWarnings:true,reason:'Тестовое подтверждение policy'});if(warningApply.status!==200)throw new Error(`warning apply failed ${warningApply.status}: ${JSON.stringify(warningApply.value)}`);teamDraft=warningApply.value;eq(teamDraft.operations.length,7);
  const applyAudit=(await pool.query("SELECT after_data FROM staff_schedule_planning_events WHERE entity_id=$1 AND action='warning-confirmation' ORDER BY id DESC LIMIT 1",[teamDraft.id])).rows[0].after_data;eq(applyAudit.actorId,manager.id);eq(applyAudit.action,'range-apply');eq(applyAudit.requestKey,warningKey);eq(applyAudit.policyFingerprint.length,64);eq(applyAudit.availabilityFingerprint.length,64);eq(applyAudit.warningFingerprint.length,64);eq(applyAudit.reason,'Тестовое подтверждение policy');eq(applyAudit.warnings.length>0,true);
  const forged=structuredClone(teamDraft.operations);forged[0].sourceTemplate={templateId:key(),templateVersion:99,templateName:'Forged'};
  eq((await req(manager,`/drafts/${teamDraft.id}`,'PATCH',{version:teamDraft.version,operations:forged,requestKey:key()})).status,400);
  const edited=structuredClone(teamDraft.operations).reverse();for(const op of edited)delete op.sourceTemplate;edited[0].payload.note='Edited after reorder; source retained';
  teamDraft=(await req(manager,`/drafts/${teamDraft.id}`,'PATCH',{version:teamDraft.version,operations:edited,requestKey:key()})).value;eq(teamDraft.operations.every(op=>op.sourceTemplate.templateId===teamTemplate.value.id),true);
  const emptyComposition={...teamRange,version:teamDraft.version,composition:[{userId:manager.id,selected:true,functionId,slots:[]}]};
  const emptyPreview=await req(manager,`/drafts/${teamDraft.id}/range-preview`,'POST',emptyComposition);eq(emptyPreview.status,200);eq(emptyPreview.value.operations.length,0);
  const teamPublishPreview=await req(manager,`/drafts/${teamDraft.id}/publish-preview`,'POST',{version:teamDraft.version});eq(teamPublishPreview.status,200);eq(teamPublishPreview.value.conflicts.length,0);eq(teamPublishPreview.value.warnings.length>0,true);
  const created=await req(manager,'/templates','POST',{name:'HTTP template',definition,requestKey:key()});eq(created.status,201);
  const range={version:1,from:create.from,to:create.to,userIds:create.userIds,templateId:created.value.id,templateVersion:1};
  const preview=await req(manager,`/drafts/${draft.id}/range-preview`,'POST',range);eq(preview.status,200);eq(preview.value.operations.length,7);
  eq((await pool.query('SELECT count(*)::int n FROM staff_schedules WHERE user_id=$1',[manager.id])).rows[0].n,0);
  const applied=await req(manager,`/drafts/${draft.id}/range-apply`,'POST',{...range,fingerprint:preview.value.fingerprint,requestKey:key()});eq(applied.status,200);draft=applied.value;
  const pp=await req(manager,`/drafts/${draft.id}/publish-preview`,'POST',{version:draft.version});eq(pp.status,200);eq(pp.value.canPublish,false);
  const publish={version:draft.version,fingerprint:pp.value.fingerprint,requestKey:key()};
  eq((await req(manager,`/drafts/${draft.id}/publish`,'POST',publish)).status,403);
  eq((await req(manager,'/grants','PUT',{userId:manager.id,access:'manage',version:1,canPublish:true})).status,403);
  eq((await req(owner,'/grants','PUT',{userId:manager.id,access:'manage',version:2,canPublish:true})).status,200);
  const published=await req(manager,`/drafts/${draft.id}/publish`,'POST',publish);eq(published.status,200);eq(published.value.state,'published');
  const teamPublished=await req(manager,`/drafts/${teamDraft.id}/publish`,'POST',{version:teamDraft.version,fingerprint:teamPublishPreview.value.fingerprint,requestKey:key(),confirmWarnings:true,reason:'Тестовое подтверждение публикации'});eq(teamPublished.status,200);eq(teamPublished.value.state,'published');
  const publishEvidence=(await pool.query(`SELECT se.actor_id,se.after_data FROM staff_schedule_events se WHERE se.after_data->'planningSource'->>'draftId'=$1 AND se.after_data->'warningConfirmation' IS NOT NULL ORDER BY se.id LIMIT 1`,[teamDraft.id])).rows[0];
  eq(publishEvidence.actor_id,manager.id);const confirmation=publishEvidence.after_data.warningConfirmation;eq(confirmation.actorId,manager.id);eq(confirmation.action,'publish');eq(confirmation.requestKey!==undefined,true);eq(confirmation.warningFingerprint.length,64);eq(confirmation.policyFingerprint.length,64);eq(confirmation.policy.configurationFingerprint.length,64);eq(confirmation.availabilityFingerprint.length,64);eq(confirmation.reason,'Тестовое подтверждение публикации');
  eq((await pool.query(`SELECT after_data->'planningSource'->>'templateId' template_id FROM staff_schedule_events WHERE after_data->'planningSource'->>'draftId'=$1 AND after_data->'planningSource' IS NOT NULL LIMIT 1`,[teamDraft.id])).rows[0].template_id,teamTemplate.value.id);
  eq((await pool.query(`SELECT function_id,kind FROM staff_schedules WHERE venue_id=$1 AND user_id=$2 AND work_date BETWEEN $3::date AND $4::date`,[f.venues[0],manager.id,teamDraftInput.from,teamDraftInput.to])).rows.every(row=>row.function_id===functionId&&row.kind==='shift'),true);
  const archived=await req(manager,`/functions/${functionId}`,'PATCH',{version:1,active:false,requestKey:key()});eq(archived.value.active,false);
  eq((await req(manager,'/functions')).value.items.some(item=>item.id===functionId&&item.active===false),true);
  eq((await req(manager,`/drafts/${draft.id}/publish`,'POST',publish)).value.version,published.value.version);
  eq((await req(manager,`/drafts/${draft.id}/discard`,'POST',{version:published.value.version,requestKey:key()})).status,409);
  eq((await req(manager,`?from=${create.from}&to=${create.to}`)).value.items.filter(e=>e.userId===manager.id).length,7);
  eq((await req(owner,'/grants','PUT',{userId:manager.id,access:'view',version:3})).value.canPublish,false);
  eq((await req(manager,`/drafts/${draft.id}`)).status,403);
  eq((await req(owner,`/templates/${created.value.id}`,'PATCH',{version:1,archived:true,requestKey:key()})).value.archived,true);
  console.log(`PLANNING HTTP PASS ${checks}: fresh full server; real login/cookie Origin/grants/readback/roles/replay/closed/tenant/range/template. Main runtime not restarted.`);
 }finally{
  if(child&&child.exitCode===null){child.kill();await Promise.race([new Promise(resolve=>child.once('exit',resolve)),sleep(3000)]);}
  await restorePolicy();
  await pool.end();
 }
}
main().catch(e=>{console.error(e.message);console.error(e.stack?.split('\n').filter(line=>line.trim().startsWith('at ')).slice(0,4).join('\n'));process.exitCode=1;});
