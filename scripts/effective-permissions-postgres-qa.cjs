'use strict';
// FIX01: target-contract regression, never an assertion that old defects exist.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {randomUUID,randomBytes,scryptSync}=require('node:crypto');
const {spawn,spawnSync}=require('node:child_process');
const {Pool}=require('pg');
const guards=require('./local-full-pg-regression.cjs');
const root=path.resolve(__dirname,'..');
const config=guards.validateConfig(JSON.parse(fs.readFileSync(path.join(root,'tmp/full-local-qa/runtime.json'),'utf8')));
const database='audit_qa_'+randomBytes(8).toString('hex');
const url=name=>`postgresql://${encodeURIComponent(config.dbUser)}:${encodeURIComponent(config.dbPassword)}@127.0.0.1:31931/${name}`;
let admin,pool,child,created=false,checks=0,base,ownerToken;
const sorted=x=>[...x].sort();
function equal(a,b,label){checks++;assert.deepEqual(a,b,label);}
function ok(a,label){checks++;assert.ok(a,label);}
async function inspect(){
 const output=spawnSync('docker',['inspect',config.regressionContainer],{encoding:'utf8',windowsHide:true,timeout:5000});
 assert.equal(output.status,0,'Owned disposable container inspection');
 guards.validateContainer(JSON.parse(output.stdout)[0],config);
 const safety=await import('./postgres-qa-safety.mjs');
 process.env.MIGRATIONS_PG_TEST_DOCKER_CONTAINER=config.regressionContainer;
 safety.validateQaDatabaseUrl(url(config.database));
 const verify=new Pool({connectionString:url(config.database),max:1,connectionTimeoutMillis:5000});
 try{safety.assertQaDatabaseIdentity((await verify.query('SELECT current_database() AS database,inet_server_addr()::text AS address,inet_server_port() AS port,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser')).rows[0],config.database,31931);}finally{await verify.end();}
}
async function api(endpoint,token,method='GET',body,expected=200){
 const response=await fetch(base+endpoint,{method,headers:{...(token?{authorization:'Bearer '+token}:{}),'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
 const payload=await response.json();equal(response.status,expected,`${method} ${endpoint}: expected ${expected}; error=${payload.error||'none'}`);return payload;
}
const basePermissions={
 owner:['floor','orders','reservations','inventory','inventory_read','finance','finance_read','staff','staff_manage','staff_sensitive','tasks_manage','settings','diagnostics','integrations','delivery','loyalty'],
 admin:['floor','orders','reservations','inventory','inventory_read','finance','finance_read','staff','staff_manage','staff_view','staff_sensitive','tasks_manage','settings','diagnostics','integrations','delivery','loyalty'],
 manager:['floor','orders','reservations','inventory_read','finance_read','staff_view','tasks_manage','settings','loyalty'],
 bartender:['floor','orders','bar_tasks','finance_read'],hookah_master:['floor','orders','hookah_tasks','finance_read']
};
async function main(){
 await inspect();admin=new Pool({connectionString:url(config.database),max:1});
 equal((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[database])).rowCount,0,'Never reuse database');
 await admin.query(`CREATE DATABASE "${database}"`);created=true;
 pool=new Pool({connectionString:url(database),max:2});
 await pool.query(fs.readFileSync(path.join(root,'schema.sql'),'utf8'));
 for(const file of fs.readdirSync(path.join(root,'migrations')).filter(x=>x.endsWith('.sql')).sort())await pool.query(fs.readFileSync(path.join(root,'migrations',file),'utf8'));
 const org=randomUUID(),venue=randomUUID(),otherOrg=randomUUID(),otherVenue=randomUUID();
 const password=randomBytes(24).toString('hex'),salt=randomBytes(16).toString('hex');
 const hash=`scrypt$${salt}$${scryptSync(password,salt,64).toString('hex')}`;
 for(const [organizationId,venueId] of [[org,venue],[otherOrg,otherVenue]]){
 await pool.query('INSERT INTO organizations(id,name,slug) VALUES($1,$2,$3)',[organizationId,'Effective permissions QA','qa-'+organizationId]);
 await pool.query("INSERT INTO organization_subscriptions(organization_id,plan,status,seats_limit,venues_limit) VALUES($1,'enterprise','active',50,5)",[organizationId]);
 await pool.query('INSERT INTO venues(id,organization_id,name) VALUES($1,$2,$3)',[venueId,organizationId,'Effective permissions synthetic']);
 }
 const actors=Object.fromEntries(Object.keys(basePermissions).map(role=>[role,randomUUID()]));
 for(const [role,id] of Object.entries(actors)){
 await pool.query('INSERT INTO users(id,venue_id,organization_id,full_name,login,password_hash,role) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,venue,org,'QA '+role,'qa_'+id,hash,role]);
 await pool.query("INSERT INTO organization_memberships(organization_id,user_id,membership_role,status) VALUES($1,$2,'member','active')",[org,id]);
 }
 const inherited={...process.env};for(const key of Object.keys(inherited))if(/DATABASE_URL|^PG[A-Z_]+$|^SAAS_OWNER_|(?:PASSWORD|TOKEN|PASSPORT_KEY|SESSION_SECRET)$/.test(key))delete inherited[key];
 child=spawn(process.execPath,['server.js'],{cwd:root,windowsHide:true,env:{...inherited,HOST:'127.0.0.1',PORT:'0',NODE_ENV:'test',AUTH_REQUIRED:'true',DEMO_MODE:'false',DATABASE_URL:url(database),VENUE_ID:venue,API_RATE_LIMIT:'10000'},stdio:['ignore','pipe','pipe']});
 base=await new Promise((resolve,reject)=>{let output='';const timeout=setTimeout(()=>reject(Error('QA server startup timeout')),20000);child.once('error',error=>{clearTimeout(timeout);reject(error);});child.once('exit',()=>{clearTimeout(timeout);reject(Error('QA server exited during startup'));});child.stdout.on('data',chunk=>{output+=chunk;const port=output.match(/CRM running on http:\/\/localhost:(\d+)/)?.[1];if(port){clearTimeout(timeout);resolve('http://127.0.0.1:'+port);}});child.stderr.on('data',()=>{});});
 async function login(id){const value=await api('/api/login',null,'POST',{username:'qa_'+id,password});const session=await api('/api/session',value.token);equal(sorted(value.permissions),sorted(session.permissions),'Login/session effective equality');equal(value.permissionPolicy,session.permissionPolicy,'Login/session policy equality');equal(sorted(value.user.workspacePermissions),sorted(value.permissions),'Login user permissions');equal(value.user.permissionPolicy,value.permissionPolicy,'Login user policy');return value.token;}
 ownerToken=await login(actors.owner);
 async function state(role,token,expected,source,ceiling=false){
 const s=await api('/api/session',token),p=await api(`/api/staff/${actors[role]}/profile`,ownerToken);
 equal(sorted(s.permissions),sorted(expected),role+' effective permissions');equal(sorted(s.user.workspacePermissions),sorted(expected),role+' session.user');equal(sorted(p.workspacePermissions),sorted(expected),role+' profile');
 equal(s.permissionPolicy.version,1,'Policy version');equal(s.permissionPolicy.source,source,'Policy source');equal(s.permissionPolicy.systemRoleCeilingActive,ceiling,'Ceiling metadata');ok(Array.isArray(s.permissionPolicy.blockedPermissions),'Blocked permissions array');equal(s.user.permissionPolicy,s.permissionPolicy,'Session user policy');equal(p.permissionPolicy,s.permissionPolicy,'Profile policy');return s;
 }
 const personal=(id,permissionScopes)=>api(`/api/staff/${id}/profile`,ownerToken,'PATCH',{permissionScopes});
 const system=(role,permissionScopes)=>api('/api/staff/system-roles/'+role,ownerToken,'PATCH',{permissionScopes});
 const assign=(id,customRoleId)=>api(`/api/staff/${id}/profile`,ownerToken,'PATCH',{customRoleId});
 for(const [role,id] of Object.entries(actors)){
 const token=await login(id);await state(role,token,basePermissions[role],role==='owner'?'protected':'base');
 if(role==='owner'){
 await api('/api/staff/system-roles/owner',ownerToken,'PATCH',{permissionScopes:[]},409);
 // Synthetic stored personal scopes cannot alter protected owner permissions.
 await pool.query("UPDATE users SET permission_scopes='[\"inventory\"]'::jsonb WHERE id=$1",[id]);await state(role,token,basePermissions.owner,'protected');continue;
 }
 await api('/api/staff/system-roles/bartender',token,'PATCH',{permissionScopes:[]},403);
 await personal(id,['inventory']);await state(role,token,['inventory','inventory_read'],'personal');await api('/api/inventory',token);
 await personal(id,[]);await state(role,token,basePermissions[role],'base');
 await personal(id,['inventory']);await personal(id,null);await state(role,token,basePermissions[role],'base');
 await personal(id,['orders']);
 const custom=await api('/api/staff/roles',ownerToken,'POST',{name:'QA '+role+' custom',permissionScopes:['inventory']},201);
 await assign(id,custom.id);await state(role,token,['inventory','inventory_read'],'custom');
 await system(role,['inventory_categories']);const clipped=await state(role,token,['inventory_read'],'custom',true);ok(clipped.permissionPolicy.blockedPermissions.includes('inventory'),'Ceiling removes inventory write');await api('/api/inventory',token);
 await api('/api/inventory/items',token,'POST',{},403);
 await system(role,[]);await state(role,token,[],'custom',true);await api('/api/inventory',token,'GET',undefined,403);
 // Remove only this fixture system row to assert absent versus explicitly empty.
 await pool.query('DELETE FROM system_role_permission_overrides WHERE venue_id=$1 AND role=$2',[venue,role]);
 await api('/api/staff/roles/'+custom.id,ownerToken,'PATCH',{permissionScopes:[]});await state(role,token,[],'custom');await api('/api/inventory',token,'GET',undefined,403);
 await api('/api/staff/roles/'+custom.id,ownerToken,'PATCH',{permissionScopes:['inventory']});await state(role,token,['inventory','inventory_read'],'custom');await api('/api/inventory',token);
 await assign(id,null);const orderExpected=['orders','floor',...(role==='bartender'?['bar_tasks']:role==='hookah_master'?['hookah_tasks']:[])];await state(role,token,orderExpected,'personal');await api('/api/inventory',token,'GET',undefined,403);
 await personal(id,[]);await system(role,['inventory']);await state(role,token,['inventory','inventory_read'],'system',true);
 await system(role,[]);await state(role,token,[],'system',true);const relogin=await login(id);await state(role,relogin,[],'system',true);
 await pool.query('DELETE FROM system_role_permission_overrides WHERE venue_id=$1 AND role=$2',[venue,role]);
 await personal(id,['settings']);await state(role,token,['settings',...(role==='admin'?['diagnostics']:[])],'personal');
 await personal(id,[]);await state(role,token,basePermissions[role],'base');
 console.log('PASS role '+role+' precedence/null/empty/relogin/same-session/metadata');
 }
 const staff=actors.bartender,staffToken=await login(staff);
 const archived=await api('/api/staff/roles',ownerToken,'POST',{name:'QA archived',permissionScopes:['inventory']},201);await api(`/api/staff/roles/${archived.id}/archive`,ownerToken,'POST');
 await api(`/api/staff/${staff}/profile`,ownerToken,'PATCH',{customRoleId:archived.id},400);await state('bartender',staffToken,basePermissions.bartender,'base');
 const foreignRole=randomUUID(),foreignUser=randomUUID();
 await pool.query('INSERT INTO custom_staff_roles(id,organization_id,venue_id,name,permission_scopes) VALUES($1,$2,$3,$4,$5::jsonb)',[foreignRole,otherOrg,otherVenue,'Foreign QA','["inventory"]']);
 await pool.query('INSERT INTO users(id,organization_id,venue_id,full_name,login,password_hash,role) VALUES($1,$2,$3,$4,$5,$6,$7)',[foreignUser,otherOrg,otherVenue,'Foreign QA','qa_'+foreignUser,hash,'bartender']);
 await api(`/api/staff/${staff}/profile`,ownerToken,'PATCH',{customRoleId:foreignRole},400);await state('bartender',staffToken,basePermissions.bartender,'base');
 await api('/api/staff/'+foreignUser+'/profile',ownerToken,'GET',undefined,404);await api('/api/staff/roles/'+foreignRole,ownerToken,'PATCH',{permissionScopes:[]},404);
 // Same-organization active venue must select its ceiling, not home custom role.
 const secondVenue=randomUUID();await pool.query('INSERT INTO venues(id,organization_id,name) VALUES($1,$2,$3)',[secondVenue,org,'Second effective permissions QA']);
 const homeRole=await api('/api/staff/roles',ownerToken,'POST',{name:'Home-only QA inventory',permissionScopes:['inventory']},201);await assign(staff,homeRole.id);await state('bartender',staffToken,['inventory','inventory_read'],'custom');
 await pool.query("INSERT INTO system_role_permission_overrides(venue_id,role,permission_scopes,updated_by) VALUES($1,'bartender','[\"orders\"]'::jsonb,$2)",[secondVenue,actors.owner]);
 await pool.query('UPDATE auth_sessions SET active_venue_id=$1 WHERE user_id=$2',[secondVenue,staff]);
 const switched=await api('/api/session',staffToken);equal(switched.user.venueId,secondVenue,'Active venue selected');equal(sorted(switched.permissions),sorted(['floor','orders','bar_tasks']),'Active venue ceiling replaces absent local custom');equal(switched.permissionPolicy.source,'system','No home custom role leaked');equal(switched.permissionPolicy.systemRoleCeilingActive,true,'Active venue ceiling present');await api('/api/inventory',staffToken,'GET',undefined,403);
 await pool.query('UPDATE auth_sessions SET active_venue_id=$1 WHERE user_id=$2',[venue,staff]);await state('bartender',staffToken,['inventory','inventory_read'],'custom');
 // Source outage is confined to this test-owned database and always restored.
 await pool.query('ALTER TABLE system_role_permission_overrides RENAME TO qa_unavailable_role_overrides');
 try{
 await api('/api/session',staffToken,'GET',undefined,401);
 await api('/api/login',null,'POST',{username:'qa_'+staff,password},503);
 await api('/api/staff/'+staff+'/profile',ownerToken,'GET',undefined,401);
 }finally{await pool.query('ALTER TABLE qa_unavailable_role_overrides RENAME TO system_role_permission_overrides');}
 await state('bartender',staffToken,['inventory','inventory_read'],'custom');
 console.log(`EFFECTIVE PERMISSIONS POSTGRES QA: PASS (${checks} assertions; five roles, canonical metadata, hierarchy, empty-deny, legacy inherit, same token and relogin, foreign/archive isolation)`);
}
main().catch(error=>{console.error(guards.safeText(error.stack,config));process.exitCode=1;}).finally(async()=>{
 try{if(child&&child.exitCode===null){const stopped=new Promise(resolve=>child.once('exit',resolve));child.kill();await stopped;}if(pool)await pool.end();if(created){await inspect();assert.match(database,/^audit_qa_[a-f0-9]{16}$/);await admin.query(`DROP DATABASE "${database}"`);console.log('CLEANUP PASS owned disposable database removed');}}finally{if(admin)await admin.end();}
});
