import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {validateQaDatabaseUrl,assertQaDatabaseIdentity} from './postgres-qa-safety.mjs';
const require=createRequire(import.meta.url),{Client,Pool}=require('pg'),{makeService}=require('../payroll-scheme-service');
const target=validateQaDatabaseUrl(process.env.MIGRATIONS_PG_TEST_DATABASE_URL),root=fileURLToPath(new URL('../',import.meta.url));
const schema=`payroll_scalar_qa_${process.pid}_${Date.now()}`;assert.match(schema,/^payroll_scalar_qa_\d+_\d+$/);
const db=new Client({connectionString:target.url.href}),url=new URL(target.url);url.searchParams.set('options',`-c search_path=${schema},public`);
let pool,created=false;
try{
 await db.connect();
 assertQaDatabaseIdentity((await db.query('SELECT current_database() AS database,inet_server_addr() AS address,inet_server_port() AS port,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser')).rows[0],target.database,Number(target.url.port));
 await db.query(`CREATE SCHEMA "${schema}"`);created=true;await db.query(`SET search_path TO "${schema}",public`);
 await db.query(readFileSync(path.join(root,'schema.sql'),'utf8'));
 for(const name of readdirSync(path.join(root,'migrations')).filter(name=>/^\d{3}.*\.sql$/.test(name)&&Number(name.slice(0,3))<=87).sort())await db.query(readFileSync(path.join(root,'migrations',name),'utf8'));
 pool=new Pool({connectionString:url.href});const service=makeService(pool);
 const venue=(await db.query("INSERT INTO venues(name) VALUES('Scalar QA') RETURNING id")).rows[0].id;
 const user=async(role)=>(await db.query('INSERT INTO users(venue_id,full_name,login,role) VALUES($1,$2,$3,$4) RETURNING id',[venue,role,`${schema}-${role}`,role])).rows[0].id;
 const owner=await user('owner'),employee=await user('bartender'),actor={venueId:venue,userId:owner};
 const ack={confirmed:true,policyCode:'payroll-own-revenue-ceiling-v1'};
 const definition={mode:'stable_percent',currency:'RUB',effectiveFrom:'2026-10-01',effectiveTo:'2026-10-31',roleParameters:{bar:{perShiftCents:0,stableRateBps:1000}},
  roleAssignments:[{employeeId:employee,roleId:'bar',effectiveFrom:'2026-10-01',effectiveTo:'2026-10-31'}],
  employeeOverrides:Object.entries({mode:'personal_target',targetCents:10000,baseRateBps:1000,bonusRateBps:2000,excessRatePolicy:'replace_base'})
   .map(([path,value])=>({employeeId:employee,path,mode:'override',value,effectiveFrom:'2026-10-02',effectiveTo:'2026-10-14'})),itemRules:[]};
 const create=async(d,name)=>(await service.createScheme(actor,{name,definition:d,payoutRiskAcknowledgement:ack})).versions[0];
 const version=await create(definition,'Missing role scalar');
 const normalized=rows=>rows.map(row=>({path:row.path,mode:row.mode,value:row.value,from:row.effectiveFrom,to:row.effectiveTo})).sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
 const read=async(id,expected)=>{const saved=await service.getVersion(actor,id);assert.deepEqual(normalized(saved.employeeOverrides),normalized(expected.employeeOverrides));assert.deepEqual(saved.roleParameters,definition.roleParameters);return saved;};
 await read(version.versionId,definition);
 const pgRows=(await db.query('SELECT parameter_path AS path,override_mode AS mode,value_json AS value,effective_from::text AS "effectiveFrom",effective_to::text AS "effectiveTo" FROM payroll_employee_overrides WHERE venue_id=$1 AND scheme_version_id=$2',[venue,version.versionId])).rows;
 assert.deepEqual(normalized(pgRows),normalized(definition.employeeOverrides),'typed values and windows persisted');
 const scenario={periodFrom:'2026-10-01',periodTo:'2026-10-02',employees:[{id:employee}],roleAssignments:definition.roleAssignments,attendance:[],
  coverage:{kind:'month_to_date_complete',from:'2026-10-01',through:'2026-10-02',complete:true,watermark:'scenario'},attendanceCoverage:{kind:'approved_attendance_complete',from:'2026-10-01',through:'2026-10-02',complete:true,watermark:'scenario'},
  sales:[{id:'line',employeeId:employee,date:'2026-10-02',department:'bar',turnoverCents:20000,commissionBaseCents:20000}]};
 const preview=async(id,amount)=>{const p=await service.preview(actor,id,scenario);assert.equal(p.official,false);assert.equal(p.persistence,'none');assert.equal(p.result.status,'ready',JSON.stringify(p.result.blockers));assert.equal(p.result.employees[0].amountCents,amount);};
 await preview(version.versionId,3000);
 const zero=structuredClone(definition);for(const row of zero.employeeOverrides)if(typeof row.value==='number')row.value=0;
 await service.replaceDraftVersion(actor,version.versionId,zero,ack);await read(version.versionId,zero);await preview(version.versionId,0);
 const inherited=structuredClone(definition);for(const row of inherited.employeeOverrides){row.mode='inherit';delete row.value;}
 await service.replaceDraftVersion(actor,version.versionId,inherited,ack);await read(version.versionId,inherited);await preview(version.versionId,2000);
 await service.replaceDraftVersion(actor,version.versionId,definition,ack);await read(version.versionId,definition);
 assert.equal((await service.activateVersion(actor,version.versionId)).status,'active');await read(version.versionId,definition);await preview(version.versionId,3000);
 await assert.rejects(()=>service.replaceDraftVersion(actor,version.versionId,zero,ack),error=>error.status===409);
 await read(version.versionId,definition);
 const incomplete=structuredClone(definition);incomplete.employeeOverrides=incomplete.employeeOverrides.filter(row=>row.path!=='targetCents');
 const mismatched=structuredClone(definition);mismatched.employeeOverrides.find(row=>row.path==='targetCents').effectiveTo='2026-10-13';
 for(const [name,bad] of [['missing required leaf',incomplete],['missing on Oct14 outside preview',mismatched]])await assert.rejects(()=>create(bad,name),error=>error.status===400&&error.message==='invalid_personal_parameters');
 const tampered=await create(definition,'Incomplete activation fixture');
 await db.query("DELETE FROM payroll_employee_overrides WHERE venue_id=$1 AND scheme_version_id=$2 AND parameter_path='targetCents'",[venue,tampered.versionId]);
 await assert.rejects(()=>service.activateVersion(actor,tampered.versionId),error=>error.message==='invalid_personal_parameters');
 assert.equal((await service.getVersion(actor,tampered.versionId)).status,'draft','activation revalidates effective personal configuration');
 for(const [leaf,value] of [['targetCents','10000'],['baseRateBps',10001],['bonusRateBps',-1],['excessRatePolicy','guess']]){
  const bad=structuredClone(definition);bad.employeeOverrides.find(row=>row.path===leaf).value=value;
  await assert.rejects(()=>create(bad,'Invalid typed scalar'),error=>error.status===400);
 }
 await assert.rejects(()=>service.getVersion({venueId:venue,userId:employee},version.versionId),error=>error.status===403);
 await assert.rejects(()=>service.createScheme({venueId:venue,userId:employee},{name:'Unauthorized',definition,payoutRiskAcknowledgement:ack}),error=>error.status===403);
 assert.deepEqual((await db.query('SELECT (SELECT count(*) FROM payroll_calculation_runs)::int AS runs,(SELECT count(*) FROM payroll_entries)::int AS entries,(SELECT count(*) FROM expenses)::int AS expenses')).rows[0],{runs:0,entries:0,expenses:0});
 console.log('PAYROLL PERSONAL SCALAR POSTGRES: PASS (owner save/direct PG/read/scenario 3000, zero/inherit, immutable activation, full-window rejection, typed errors and no posting)');
}finally{
 await pool?.end();if(created){await db.query('SET search_path TO public');await db.query(`DROP SCHEMA "${schema}" CASCADE`);assert.equal((await db.query('SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname=$1) AS present',[schema])).rows[0].present,false);}await db.end();
}
