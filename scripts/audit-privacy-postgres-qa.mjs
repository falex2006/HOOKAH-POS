import assert from 'node:assert/strict';
import { randomUUID, randomBytes, scryptSync } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { assertQaDatabaseIdentity, validateQaDatabaseUrl } from './postgres-qa-safety.mjs';

const require = createRequire(import.meta.url);
const { Pool } = require('pg');
const { AuditRepository } = require('../db.js');
const { redactAuditData, sanitizeAuditEvent } = require('../audit-privacy.js');
const databaseUrl = process.env.MIGRATIONS_PG_TEST_DATABASE_URL;
const target = validateQaDatabaseUrl(databaseUrl, 'audit privacy regression database');
assert.equal(Number(target.url.port), 31931, 'Audit fixtures only use the dedicated disposable regression PostgreSQL port');
assert.ok(process.env.MIGRATIONS_PG_TEST_DOCKER_CONTAINER, 'Explicit disposable container identity is required');
const pool = new Pool({ connectionString: databaseUrl, max: 2 });
const marker = `private-${randomUUID()}`;
const password = `qa-${randomUUID()}`;
const salt = randomBytes(16).toString('hex');
const passwordHash = `scrypt$${salt}$${scryptSync(password, salt, 64).toString('hex')}`;
const orgs = [randomUUID(),randomUUID()];
const venues = [randomUUID(),randomUUID()];
const suffix = randomUUID().slice(0,8);
const users = ['owner','manager','developer','hookah_master','owner'].map((role,index) => ({ id: randomUUID(), role, login: `audit_${suffix}_${index}`, venue: index === 4 ? venues[1] : venues[0], org: index === 4 ? orgs[1] : orgs[0] }));
const events = [randomUUID(),randomUUID(),randomUUID()];
const credentials = { passportData: { number: marker }, PIN: marker, pin_hash: marker, passwordHash: marker, newPassword: marker, old_password: marker, OwnerPassword: marker, token: marker, apiToken: marker, session_token: marker, Cookie: marker, authorization: marker, 'Proxy-Authorization': marker, credentials: { login: marker }, nested: [{ passport_data_encrypted: marker, password: marker, amount: 12 }] };
function privateDataAbsent(value, label) {
  assert.equal(JSON.stringify(value).includes(marker), false, `${label} must never contain secret values`);
  const visit = object => {
    if (!object || typeof object !== 'object') return;
    for (const [key, entry] of Object.entries(object)) {
      const normalized = key.replace(/[^a-z0-9]/gi,'').toLowerCase();
      assert.ok(!normalized.startsWith('passport') && !normalized.includes('password') && !['pin','pincode','pinhash','token','credentials','pindataencrypted','pindataiv','pindatatag','apitoken','sessiontoken','cookie','authorization','proxyauthorization'].includes(normalized), `${label} must remove sensitive keys`);
      visit(entry);
    }
  };
  visit(value);
}
function guestPiiAbsent(value, label) {
  assert.equal(JSON.stringify(value).includes(marker), false, `${label} must not contain guest profile values`);
  const blocked = new Set(['name','fullname','nickname','phone','phonenumbers','email','telegram','avatar','avatarurl','allergies','tobacco','tobaccopreferences','bowlpreferences','barpreferences','preferences','notes','guestname','guestphone']);
  const visit = object => {
    if (!object || typeof object !== 'object') return;
    for (const [key, entry] of Object.entries(object)) {
      const normalized = key.replace(/[^a-z0-9]/gi,'').toLowerCase();
      assert.ok(!blocked.has(normalized), `${label} must remove guest PII field ${key}`);
      visit(entry);
    }
  };
  visit(value);
}
const redacted = redactAuditData({ ...credentials, amount: 123.45, pinConfigured: true, pinUpdatedAt: '2026-10-01T10:00:00Z' });
privateDataAbsent(redacted, 'recursive redactor');
assert.equal(redacted.amount, 123.45); assert.equal(redacted.pinConfigured, true); assert.equal(redacted.pinUpdatedAt, '2026-10-01T10:00:00Z');
const safeEvent = sanitizeAuditEvent({ id: events[0], action: 'qa.audit', entityType: 'staff', beforeData: credentials, afterData: { ...credentials, amount: 55 } });
privateDataAbsent(safeEvent, 'event redactor'); assert.equal(safeEvent.action,'qa.audit'); assert.equal(safeEvent.afterData.amount,55);
const safeGuestEvent = sanitizeAuditEvent({ id: events[2], action: 'client.updated', entityType: 'client', beforeData: { name: marker, phone: marker, allergies: marker }, afterData: { name: marker, notes: marker, amount: 55, sourceKey: 'loyalty-adjustment:qa' } });
guestPiiAbsent(safeGuestEvent, 'guest event sanitizer');
assert.deepEqual(safeGuestEvent.afterData, { amount: 55, sourceKey: 'loyalty-adjustment:qa' }, 'guest audit retains required financial facts while stripping profile PII');

let child;
let base;
let fixturesTouched = false;
async function startServer(dbUrl = databaseUrl, authRequired = true) {
  const listener = net.createServer(); listener.listen(0,'127.0.0.1'); await once(listener,'listening'); const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [fileURLToPath(new URL('../server.js',import.meta.url))], { cwd: fileURLToPath(new URL('..',import.meta.url)), windowsHide: true, stdio: 'ignore', env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DATABASE_URL: dbUrl, AUTH_REQUIRED: String(authRequired), DEMO_MODE: 'false', VENUE_ID: venues[0], STAFF_PASSPORT_KEY: randomBytes(32).toString('hex'), SAAS_OWNER_EMAIL: `audit-platform-${suffix}@example.test`, SAAS_OWNER_PASSWORD: password, DEMO_ADMIN_PASSWORD: '', DEMO_OWNER_PASSWORD: '', DEMO_STAFF_PASSWORD: '' } });
  for (let attempt=0;attempt<100;attempt++) {
    if(child.exitCode!==null)throw new Error('Isolated audit QA server exited before readiness');
    try{const response=await fetch(base+'/api/health'); if(response.status===200 || dbUrl && dbUrl !== databaseUrl && response.status===503)return;}catch{}
    await new Promise(resolve=>setTimeout(resolve,150));
  }
  throw new Error('Isolated audit QA server startup timed out');
}
async function stopServer() { if(child && child.exitCode===null){const exited=once(child,'exit');child.kill('SIGTERM');await exited;}child=null; }
async function request(endpoint, token, method='GET', input, expected=200) {
  const response = await fetch(base+endpoint,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:input===undefined?undefined:JSON.stringify(input)});
  assert.equal(response.status,expected,`${method} ${endpoint} returns expected status`);return response.json();
}
async function login(loginName) { return (await request('/api/login',null,'POST',{username:loginName,password})).token; }

try {
  const identity=(await pool.query('SELECT current_database() AS database,inet_server_addr()::text AS address,inet_server_port() AS port,COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname=current_user),false) AS superuser')).rows[0];
  assertQaDatabaseIdentity(identity,target.database,31931,'audit privacy PostgreSQL');
  fixturesTouched = true;
  for(let index=0;index<2;index++){
    await pool.query("INSERT INTO organizations(id,name,slug,plan) VALUES($1,'Audit privacy QA',$2,'enterprise')",[orgs[index],`audit-privacy-${suffix}-${index}`]);
    await pool.query("INSERT INTO organization_subscriptions(organization_id,plan,status,seats_limit,venues_limit) VALUES($1,'enterprise','active',100,10)",[orgs[index]]);
    await pool.query("INSERT INTO venues(id,organization_id,name,city,address) VALUES($1,$2,'Audit QA','QA','QA')",[venues[index],orgs[index]]);
  }
  for(const user of users){
    await pool.query("INSERT INTO users(id,venue_id,organization_id,full_name,login,password_hash,role,birth_date) VALUES($1,$2,$3,'Synthetic audit QA',$4,$5,$6,'1990-01-01')",[user.id,user.venue,user.org,user.login,passwordHash,user.role]);
    await pool.query("INSERT INTO organization_memberships(organization_id,user_id,membership_role,status) VALUES($1,$2,$3,'active')",[user.org,user.id,user.role==='owner'?'owner':'member']);
  }
  await startServer();
  await request('/api/audit',null,'GET',undefined,401);
  const ownerToken=await login(users[0].login);
  await request(`/api/staff/${users[3].id}/profile`,ownerToken,'PATCH',{passportData:{number:marker,issuer:'SYNTHETIC QA',issuedAt:'2000-01-01'}});
  let profileEvent;
  for(let attempt=0;attempt<30;attempt++){
    profileEvent=(await pool.query("SELECT before_data,after_data FROM audit_events WHERE venue_id=$1 AND action='staff.profile_updated' AND entity_id=$2 ORDER BY created_at DESC LIMIT 1",[venues[0],users[3].id])).rows[0];
    if(profileEvent)break;await new Promise(resolve=>setTimeout(resolve,50));
  }
  assert.ok(profileEvent,'real profile HTTP patch records an audit event'); privateDataAbsent(profileEvent,'new PostgreSQL audit row');
  const encrypted=(await pool.query('SELECT passport_data_encrypted IS NOT NULL AS encrypted FROM users WHERE id=$1',[users[3].id])).rows[0];assert.equal(encrypted.encrypted,true,'staff document remains encrypted in its dedicated user field');
  const repository=new AuditRepository(pool);
  await repository.record({venueId:venues[0],actorId:users[0].id,action:'qa.audit_direct',entityType:'staff',entityId:users[3].id,beforeData:credentials,afterData:{...credentials,amount:123.45,pinConfigured:true}});
  const storedDirect=(await pool.query("SELECT before_data,after_data FROM audit_events WHERE venue_id=$1 AND action='qa.audit_direct'",[venues[0]])).rows[0];privateDataAbsent(storedDirect,'direct repository write'); assert.equal(storedDirect.after_data.amount,123.45);
  await repository.record({venueId:venues[0],actorId:users[0].id,action:'qa.guest_direct',entityType:'client',entityId:randomUUID(),beforeData:{name:marker,phone:marker,allergies:marker},afterData:{name:marker,email:marker,amount:55,sourceKey:'loyalty-adjustment:qa'}});
  const storedGuest=(await pool.query("SELECT before_data,after_data FROM audit_events WHERE venue_id=$1 AND action='qa.guest_direct'",[venues[0]])).rows[0];guestPiiAbsent(storedGuest,'direct guest audit write');assert.deepEqual(storedGuest.after_data,{amount:55,sourceKey:'loyalty-adjustment:qa'});
  for(let index=0;index<2;index++)await pool.query("INSERT INTO audit_events(id,venue_id,actor_id,action,entity_type,entity_id,before_data,after_data) VALUES($1,$2,$3,'qa.audit_legacy','staff',$3,$4,$5)",[events[index],venues[index],users[index?4:0].id,credentials,{...credentials,amount:index?987:321}]);
  await pool.query("INSERT INTO audit_events(id,venue_id,actor_id,action,entity_type,entity_id,before_data,after_data) VALUES($1,$2,$3,'qa.guest_legacy','client',$4,$5,$6)",[events[2],venues[0],users[0].id,randomUUID(),{name:marker,phone:marker,allergies:marker},{name:marker,notes:marker,amount:55,sourceKey:'legacy:guest'}]);
  const legacyRaw=(await pool.query('SELECT after_data FROM audit_events WHERE id=$1',[events[0]])).rows[0];assert.equal(JSON.stringify(legacyRaw).includes(marker),true,'historical fixture proves read redaction without rewriting stored history');
  const directRows=await repository.list(venues[0],{action:'qa.audit_legacy'});privateDataAbsent(directRows,'repository historical read');assert.equal(directRows[0].afterData.amount,321);
  const legacyGuestRows=await repository.list(venues[0],{action:'qa.guest_legacy'});guestPiiAbsent(legacyGuestRows,'repository historical guest read');assert.deepEqual(legacyGuestRows[0].afterData,{amount:55,sourceKey:'legacy:guest'});
  for(const user of users){
    const token=await login(user.login);
    if(user.role==='hookah_master')await request('/api/audit',token,'GET',undefined,403);
    else{
      const data=await request('/api/audit?action=qa.audit_legacy',token);privateDataAbsent(data,'owner/manager/developer historical HTTP read');assert.equal(data.items.length,1,'audit read remains scoped to the authenticated venue');assert.equal(data.items[0].id,events[user.org===orgs[1]?1:0]);assert.equal(data.items[0].afterData.amount,user.org===orgs[1]?987:321);assert.equal(data.items[0].action,'qa.audit_legacy');
    }
    await request('/api/logout',token,'POST',{});
  }
  await request('/api/logout',ownerToken,'POST',{});
  await stopServer();
  const unavailable=new URL(databaseUrl);unavailable.pathname=`/audit_qa_missing_${suffix}`;
  // Total database loss blocks persisted authentication first. This isolated
  // fault child bypasses auth solely to exercise the downstream audit503 guard.
  await startServer(unavailable.href,false);
  const failure=await request('/api/audit',null,'GET',undefined,503);assert.equal(failure.error,'audit_unavailable','configured PostgreSQL failure must not return a memory audit');
  await stopServer();
  // The same audit boundary applies to isolated no-database development mode.
  await startServer('');
  const platformToken=await login(`audit-platform-${suffix}@example.test`);
  const memoryOwners=[];
  for(let index=0;index<2;index++){
    const ownerLogin=`audit-memory-${suffix}-${index}@example.test`;
    await request('/api/platform/organizations',platformToken,'POST',{name:`Audit memory ${index}`,slug:`audit-memory-${suffix}-${index}`,ownerName:'QA Owner',ownerLogin,ownerPassword:password,plan:'enterprise'},201);
    const token=await login(ownerLogin);const guest=await request('/api/clients',token,'POST',{name:`QA isolated guest ${index}`,phone:marker,email:marker,notes:marker},201);memoryOwners.push({token,guest});
  }
  const foreignGuest=memoryOwners[1].guest;
  const ownerOneGuestList=await request('/api/clients',memoryOwners[0].token);
  assert.equal(ownerOneGuestList.items.some(item=>item.id===foreignGuest.id),false,'memory guest listing cannot expose another venue profile');
  for(const [method,path,input] of [
    ['GET',`/api/clients/${foreignGuest.id}/history`],
    ['PATCH',`/api/clients/${foreignGuest.id}`,{name:'Cross-tenant overwrite'}],
    ['POST',`/api/clients/${foreignGuest.id}/archive`,{}],
    ['DELETE',`/api/clients/${foreignGuest.id}`],
    ['POST',`/api/clients/${foreignGuest.id}/loyalty`,{delta:10,reason:'Cross-tenant QA',idempotencyKey:'qa-foreign-tenant'}],
    ['GET',`/api/clients/${foreignGuest.id}/account-entries`]
  ]) await request(path,memoryOwners[0].token,method,input,404);
  const foreignGuestAfter=await request('/api/clients',memoryOwners[1].token);
  assert.equal(foreignGuestAfter.items.some(item=>item.id===foreignGuest.id),true,'cross-venue delete attempt leaves the owner venue guest intact');
  assert.equal(foreignGuestAfter.items.find(item=>item.id===foreignGuest.id).name,'QA isolated guest 1','cross-venue profile/archive attempts leave guest data unchanged');
  for(const owner of memoryOwners){const audit=await request('/api/audit?action=client.created',owner.token);assert.equal(audit.items.length,1,'memory audit excludes events of the other venue');assert.equal(audit.items[0].entityId,owner.guest.id);guestPiiAbsent(audit,'memory guest audit read');await request('/api/logout',owner.token,'POST',{});}
  console.log('AUDIT PRIVACY POSTGRES QA: PASS (encrypted profile, recursive write/read redaction, historical data, owner/manager/developer RBAC, PostgreSQL and memory tenant isolation, unavailable database503)');
}finally{
  await stopServer();
  try{
    if (fixturesTouched) {
    await pool.query('BEGIN');
    await pool.query('DELETE FROM notification_reads WHERE venue_id=ANY($1::uuid[])',[venues]);
    await pool.query('DELETE FROM audit_events WHERE venue_id=ANY($1::uuid[])',[venues]);
    await pool.query('DELETE FROM auth_sessions WHERE user_id=ANY($1::uuid[])',[users.map(user=>user.id)]);
    await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[users.map(user=>user.id)]);
    await pool.query('DELETE FROM venues WHERE id=ANY($1::uuid[])',[venues]);
    await pool.query('DELETE FROM organizations WHERE id=ANY($1::uuid[])',[orgs]);
    await pool.query('COMMIT');
    }
  }catch{await pool.query('ROLLBACK').catch(()=>{});throw new Error('Owned audit QA fixture cleanup failed');}finally{await pool.end();}
}
