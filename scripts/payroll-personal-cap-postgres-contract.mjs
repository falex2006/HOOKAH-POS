import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { validateQaDatabaseUrl, assertQaDatabaseIdentity } from './postgres-qa-safety.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'), require=createRequire(import.meta.url);
const {Client}=require('pg'), {makeService,PayrollSchemeServiceError}=require('../payroll-scheme-service.js');
const target=validateQaDatabaseUrl(process.env.MIGRATIONS_PG_TEST_DATABASE_URL);
assert.ok(['hookah_local_qa','territory_qa'].includes(target.database));
const client=new Client({connectionString:target.url.href}), schema=`payroll_cap_qa_${process.pid}_${Date.now()}`;
assert.match(schema,/^payroll_cap_qa_\d+_\d+$/);
const insert=async(table,data)=>{const keys=Object.keys(data);return(await client.query(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map((_,i)=>`$${i+1}`).join(',')}) RETURNING *`,Object.values(data))).rows[0];};
const reject=(action,code,status)=>assert.rejects(action,error=>error instanceof PayrollSchemeServiceError&&error.code===code&&error.status===status);
let sequence=0;
const pool={query:(...args)=>client.query(...args),async connect(){const point=`cap_service_${sequence++}`;return{async query(sql,args){
  if(/^BEGIN\b/i.test(sql))return client.query(`SAVEPOINT ${point}`);
  if(/^COMMIT\b/i.test(sql))return client.query(`RELEASE SAVEPOINT ${point}`);
  if(/^ROLLBACK$/i.test(sql)){await client.query(`ROLLBACK TO SAVEPOINT ${point}`);return client.query(`RELEASE SAVEPOINT ${point}`);}
  return client.query(sql,args);
},release(){}};}};
try{
 await client.connect();
 const identity=(await client.query('SELECT current_database() AS database,inet_server_addr() AS address,inet_server_port() AS port,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser')).rows[0];
 assertQaDatabaseIdentity(identity,target.database,Number(target.url.port));
 await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');await client.query(`CREATE SCHEMA "${schema}"`);await client.query(`SET LOCAL search_path TO "${schema}",public`);
 await client.query(fs.readFileSync(path.join(root,'schema.sql'),'utf8'));
 for(const name of fs.readdirSync(path.join(root,'migrations')).filter(name=>name.endsWith('.sql')&&Number(name.slice(0,3))<=86).sort())await client.query(fs.readFileSync(path.join(root,'migrations',name),'utf8'));
 const venue=await insert('venues',{name:'Personal cap QA'}), foreign=await insert('venues',{name:'Foreign cap QA'});
 const owner=await insert('users',{venue_id:venue.id,full_name:'Owner',login:schema,role:'owner'}), employee=await insert('users',{venue_id:venue.id,full_name:'Employee',login:`${schema}-staff`,role:'bartender'});
 const principal={venueId:venue.id,userId:owner.id}, service=makeService(pool);
 const ack={confirmed:true,policyCode:'payroll-own-revenue-ceiling-v1'}, childAck={...ack,personalCapIncrease:{confirmed:true,policyCode:'payroll-personal-cap-above-role-v1',acknowledgedBy:'forged',exceptions:[]}};
 const definition={mode:'stable_percent',currency:'RUB',effectiveFrom:'2026-10-01',effectiveTo:'2026-10-31',roleParameters:{bar:{stableRateBps:1000,perShiftCents:0,cap:{rateBps:3000,basis:'venue_day'}}},
  roleAssignments:[{employeeId:employee.id.toUpperCase(),roleId:'bar',effectiveFrom:'2026-10-01',effectiveTo:'2026-10-31'}],employeeOverrides:[{employeeId:employee.id,path:'cap.rateBps',mode:'override',value:3001,effectiveFrom:'2026-10-15',effectiveTo:'2026-10-31'}]};
 const create=(def=definition,risk=ack)=>service.createScheme(principal,{name:`Cap ${sequence++}`,definition:def,payoutRiskAcknowledgement:risk});
 const required='payroll_personal_cap_increase_acknowledgement_required';
 for (const level of ['scheme','role','employee']) {
  const staged=structuredClone(definition);
  if(level==='scheme')staged.milestoneEligibility='worked_on_threshold_day';
  if(level==='role')staged.roleParameters.bar.milestoneEligibility='all_active';
  if(level==='employee')staged.employeeOverrides.push({employeeId:employee.id,path:'milestoneEligibility',mode:'override',value:'worked_on_threshold_day'});
  await reject(()=>create(staged,childAck),'payroll_milestone_eligibility_schema_required',409);
 }
 assert.equal((await client.query('SELECT count(*)::int AS n FROM payroll_schemes')).rows[0].n,0,'staged milestone choices cannot be silently dropped or partly saved');
 await reject(()=>create(),required,400);
 assert.equal((await client.query('SELECT count(*)::int AS n FROM payroll_schemes')).rows[0].n,0,'failed create rolls header back');
 const created=await create(definition,childAck),version=created.versions[0];
 const audit=version.payoutRiskAcknowledgement, child=audit.personalCapIncrease;
 assert.equal(child.acknowledgedBy,owner.id);assert.equal(child.acknowledgedByName,'Owner');assert.equal(child.configDigest,audit.configDigest);
 assert.equal(child.exceptions.length,1);assert.equal(child.exceptions[0].personalRateBps,3001);assert.equal(child.exceptions[0].employeeId,employee.id);
 assert.deepEqual((await service.getVersion(principal,version.versionId)).payoutRiskAcknowledgement,audit);
 const revisions=await service.listVersionRevisions(principal,version.versionId);assert.ok(JSON.stringify(revisions).includes('personalCapIncrease'));
 await reject(()=>service.replaceDraftVersion(principal,version.versionId,definition,ack),required,400);
 const edited=await service.replaceDraftVersion(principal,version.versionId,definition,childAck);assert.equal(edited.payoutRiskAcknowledgement.personalCapIncrease.exceptions[0].roleRateBps,3000);
 await reject(()=>service.createVersion(principal,created.id,definition,ack),required,400);
 const newer=await service.createVersion(principal,created.id,definition,childAck);assert.equal(newer.payoutRiskAcknowledgement.personalCapIncrease.policyCode,child.policyCode);
 const mutate=async(callback)=>{await client.query('SAVEPOINT cap_tamper');const config=(await client.query('SELECT config_json FROM payroll_scheme_versions WHERE id=$1',[version.versionId])).rows[0].config_json;callback(config);
  await client.query('UPDATE payroll_scheme_versions SET config_json=$1 WHERE id=$2',[config,version.versionId]);await reject(()=>service.activateVersion(principal,version.versionId),required,409);
  await client.query('ROLLBACK TO SAVEPOINT cap_tamper');await client.query('RELEASE SAVEPOINT cap_tamper');};
 await mutate(config=>delete config.payoutRiskAcknowledgement.personalCapIncrease);
 for(const patch of [{policyCode:'wrong'},{configDigest:'0'.repeat(64)},{exceptions:[]},{acknowledgedBy:employee.id},{acknowledgedByName:'Forged'},{acknowledgedAt:'invalid'}])await mutate(config=>Object.assign(config.payoutRiskAcknowledgement.personalCapIncrease,patch));
 const lowered=structuredClone(definition);lowered.roleParameters.bar.cap.rateBps=2000;
 await reject(()=>service.replaceDraftVersion(principal,version.versionId,lowered,ack),required,400);
 const savedLower=await service.replaceDraftVersion(principal,version.versionId,lowered,childAck);assert.equal(savedLower.payoutRiskAcknowledgement.personalCapIncrease.exceptions[0].roleRateBps,2000);
 assert.equal((await service.activateVersion(principal,version.versionId)).status,'active');
 await reject(()=>service.replaceDraftVersion(principal,version.versionId,definition,childAck),'payroll_scheme_version_immutable',409);
 for(const value of [0,2999,3000]){const normal=structuredClone(definition);normal.employeeOverrides[0].value=value;
  const first=(await create(normal)).versions[0],second=(await create(normal,childAck)).versions[0];
  assert.equal(first.payoutRiskAcknowledgement.personalCapIncrease,undefined);assert.equal(second.payoutRiskAcknowledgement.personalCapIncrease,undefined);
  assert.equal(first.payoutRiskAcknowledgement.configDigest,second.payoutRiskAcknowledgement.configDigest,'unused child leaves legacy digest unchanged');}
 const inherit=structuredClone(definition);inherit.employeeOverrides[0].mode='inherit';delete inherit.employeeOverrides[0].value;
 assert.equal((await create(inherit)).versions[0].payoutRiskAcknowledgement.personalCapIncrease,undefined);
 const missingBase=structuredClone(definition);delete missingBase.roleParameters.bar.cap;
 await reject(()=>create(missingBase,childAck),'invalid_personal_cap',400);
 missingBase.employeeOverrides.push({employeeId:employee.id,path:'cap.basis',mode:'override',value:'venue_day',effectiveFrom:'2026-10-15',effectiveTo:'2026-10-31'});
 assert.equal((await create(missingBase)).versions[0].payoutRiskAcknowledgement.personalCapIncrease,undefined,'complete new personal restriction does not invent a role baseline');
 await reject(()=>service.createScheme({venueId:venue.id,userId:employee.id},{name:'Denied',definition,payoutRiskAcknowledgement:childAck}),'payroll_scheme_owner_only',403);
 await reject(()=>service.createScheme({venueId:foreign.id,userId:owner.id},{name:'Denied',definition,payoutRiskAcknowledgement:childAck}),'payroll_scheme_owner_only',403);
 const effects=(await client.query('SELECT (SELECT count(*) FROM payroll_calculation_runs)::int AS runs,(SELECT count(*) FROM payroll_entries)::int AS entries,(SELECT count(*) FROM expenses)::int AS expenses')).rows[0];assert.deepEqual(effects,{runs:0,entries:0,expenses:0});
 console.log('PAYROLL PERSONAL CAP POSTGRES: PASS (create/edit/new-version audit, activation tamper, legacy digest, tenant/owner, no posting)');
}finally{await client.query('ROLLBACK').catch(()=>{});await client.end();}
