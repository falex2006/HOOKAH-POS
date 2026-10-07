import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {validateQaDatabaseUrl,assertQaDatabaseIdentity} from './postgres-qa-safety.mjs';
const require=createRequire(import.meta.url),{Client,Pool}=require('pg'),{makeService}=require('../payroll-scheme-service');
const target=validateQaDatabaseUrl(process.env.MIGRATIONS_PG_TEST_DATABASE_URL),root=fileURLToPath(new URL('../',import.meta.url));
const schema=`payroll_standalone_cap_qa_${process.pid}_${Date.now()}`;assert.match(schema,/^payroll_standalone_cap_qa_\d+_\d+$/);
const db=new Client({connectionString:target.url.href}),url=new URL(target.url);url.searchParams.set('options',`-c search_path=${schema},public`);
let pool,created=false;
try{
 await db.connect();
 assertQaDatabaseIdentity((await db.query('SELECT current_database() AS database,inet_server_addr() AS address,inet_server_port() AS port,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser')).rows[0],target.database,Number(target.url.port));
 await db.query(`CREATE SCHEMA "${schema}"`);created=true;await db.query(`SET search_path TO "${schema}",public`);
 await db.query(readFileSync(path.join(root,'schema.sql'),'utf8'));
 for(const name of readdirSync(path.join(root,'migrations')).filter(name=>/^\d{3}.*\.sql$/.test(name)&&Number(name.slice(0,3))<=87).sort())await db.query(readFileSync(path.join(root,'migrations',name),'utf8'));
 pool=new Pool({connectionString:url.href});const service=makeService(pool);
 const venue=(await db.query("INSERT INTO venues(name) VALUES('Standalone cap QA') RETURNING id")).rows[0].id;
 const user=async(role)=>(await db.query('INSERT INTO users(venue_id,full_name,login,role) VALUES($1,$2,$3,$4) RETURNING id',[venue,role,`${schema}-${role}`,role])).rows[0].id;
 const owner=await user('owner'),employee=await user('bartender'),actor={venueId:venue,userId:owner};
 const ack={confirmed:true,policyCode:'payroll-own-revenue-ceiling-v1'};
 const secondEmployee=(await db.query("INSERT INTO users(venue_id,full_name,login,role) VALUES($1,'Other employee',$2,'bartender') RETURNING id",[venue,`${schema}-other`])).rows[0].id;
 const definition={mode:'stable_percent',currency:'RUB',effectiveFrom:'2026-10-01',effectiveTo:'2026-10-31',roleParameters:{bar:{perShiftCents:10000,stableRateBps:1000}},roleAssignments:[employee,secondEmployee].map(employeeId=>({employeeId,roleId:'bar',effectiveFrom:'2026-10-01',effectiveTo:'2026-10-31'})),employeeOverrides:[{employeeId:employee,path:'cap.rateBps',mode:'override',value:2500,effectiveFrom:'2026-10-01',effectiveTo:'2026-10-14'},{employeeId:employee,path:'cap.basis',mode:'override',value:'venue_day',effectiveFrom:'2026-10-01',effectiveTo:'2026-10-14'}],itemRules:[]};
 // Only the subject sells in this fixture: venue_day=20000. Other employee
 // has no shifts/sales; cap edits must not create a wage for them.
 const scenario={periodFrom:'2026-10-01',periodTo:'2026-10-01',employees:[{id:employee},{id:secondEmployee}],roleAssignments:definition.roleAssignments,attendance:[{id:'shift',employeeId:employee,date:'2026-10-01',approved:true,workedMinutes:60,plannedMinutes:60}],sales:[{id:'line',employeeId:employee,date:'2026-10-01',department:'bar',turnoverCents:20000,commissionBaseCents:20000}],coverage:{kind:'month_to_date_complete',from:'2026-10-01',through:'2026-10-01',complete:true,watermark:'scenario'},attendanceCoverage:{kind:'approved_attendance_complete',from:'2026-10-01',through:'2026-10-01',complete:true,watermark:'scenario'}};
 const createScheme=(d,name,a=ack)=>service.createScheme(actor,{name,definition:d,payoutRiskAcknowledgement:a});
 const scheme=await createScheme(definition,'Standalone personal cap'),version=scheme.versions[0];
 const read=async()=>{const saved=await service.getVersion(actor,version.versionId);assert.deepEqual(saved.roleParameters,definition.roleParameters);assert.equal(saved.payoutRiskAcknowledgement.personalCapIncrease,undefined);return saved;};
 let saved=await read();assert.deepEqual(saved.employeeOverrides.map(r=>[r.path,r.value]).sort(),[['cap.basis','venue_day'],['cap.rateBps',2500]]);
 assert.deepEqual((await db.query('SELECT parameter_path AS path,value_json AS value,effective_from::text AS "from",effective_to::text AS "to" FROM payroll_employee_overrides WHERE venue_id=$1 AND scheme_version_id=$2 ORDER BY parameter_path',[venue,version.versionId])).rows,[{path:'cap.basis',value:'venue_day',from:'2026-10-01',to:'2026-10-14'},{path:'cap.rateBps',value:2500,from:'2026-10-01',to:'2026-10-14'}]);
 const preview=async(id,amount,input=scenario)=>{const p=await service.preview(actor,id,input);assert.equal(p.official,false);assert.equal(p.persistence,'none');assert.equal(p.result.status,'ready',JSON.stringify(p.result.blockers));assert.equal(p.result.employees.find(r=>r.employeeId===employee).amountCents,amount);return p.result;};
 const initial=await preview(version.versionId,5000);assert.equal(initial.employees.find(r=>r.employeeId===employee).capReductionCents,7000);
 const zero=structuredClone(definition);zero.employeeOverrides[0].value=0;await service.replaceDraftVersion(actor,version.versionId,zero,ack);await preview(version.versionId,0);assert.equal((await read()).employeeOverrides.find(r=>r.path==='cap.rateBps').value,0);
 const inherit=structuredClone(definition);for(const r of inherit.employeeOverrides){r.mode='inherit';delete r.value;}await service.replaceDraftVersion(actor,version.versionId,inherit,ack);const uncapped=await preview(version.versionId,12000);assert.deepEqual(initial.employees.filter(r=>r.employeeId===secondEmployee),uncapped.employees.filter(r=>r.employeeId===secondEmployee));
 const upper=structuredClone(definition);upper.employeeOverrides[0].value=10000;await service.replaceDraftVersion(actor,version.versionId,upper,ack);await preview(version.versionId,12000);await read();
 await service.replaceDraftVersion(actor,version.versionId,definition,ack);
 // An active second seller must keep their own commission when the subject's
 // explicit department cap changes. Department/day is still scenario-only.
 const departmentDefinition=structuredClone(definition);departmentDefinition.roleParameters.bar.department='bar';departmentDefinition.employeeOverrides[1].value='employee_department_day';
 const departmentVersion=(await createScheme(departmentDefinition,'Department cap with other seller')).versions[0];
 const otherSaleInput=structuredClone(scenario);otherSaleInput.sales.push({id:'other-line',employeeId:secondEmployee,date:'2026-10-01',department:'kitchen',turnoverCents:10000,commissionBaseCents:10000});
 const cappedOther=await preview(departmentVersion.versionId,5000,otherSaleInput);assert.equal(cappedOther.employees.find(r=>r.employeeId===secondEmployee).amountCents,1000);
 for(const row of departmentDefinition.employeeOverrides){row.mode='inherit';delete row.value;}await service.replaceDraftVersion(actor,departmentVersion.versionId,departmentDefinition,ack);
 const inheritedOther=await preview(departmentVersion.versionId,12000,otherSaleInput);assert.deepEqual(cappedOther.employees.filter(r=>r.employeeId===secondEmployee),inheritedOther.employees.filter(r=>r.employeeId===secondEmployee));
 const snapshot=async()=>({version:(await db.query('SELECT * FROM payroll_scheme_versions WHERE id=$1',[version.versionId])).rows,overrides:(await db.query('SELECT * FROM payroll_employee_overrides WHERE scheme_version_id=$1 ORDER BY parameter_path',[version.versionId])).rows,counts:(await db.query('SELECT (SELECT count(*)::int FROM payroll_schemes) AS schemes,(SELECT count(*)::int FROM payroll_scheme_versions) AS versions,(SELECT count(*)::int FROM payroll_scheme_version_revisions) AS revisions')).rows});
 const invalid=[];
 const partial=structuredClone(definition);partial.employeeOverrides.pop();invalid.push(['partial',partial,'invalid_personal_cap']);
 const mismatch=structuredClone(definition);mismatch.employeeOverrides[1].effectiveTo='2026-10-13';invalid.push(['outside-preview expiry',mismatch,'invalid_personal_cap']);
 const department=structuredClone(definition);department.employeeOverrides[1].value='employee_department_day';invalid.push(['missing department',department,'invalid_personal_cap']);
 const milestones=structuredClone(definition);milestones.roleParameters.bar.applyMilestones=true;milestones.roleParameters.bar.milestoneBonusesCents={20000:1000};invalid.push(['missing milestone policy',milestones,'milestone_cap_policy_required']);
 for(const [label,bad,code] of invalid){for(const mutate of [()=>createScheme(bad,label),()=>service.replaceDraftVersion(actor,version.versionId,bad,ack),()=>service.createVersion(actor,scheme.id,bad,ack)]){const before=await snapshot();await assert.rejects(mutate,e=>e.status===400&&e.code===code);assert.deepEqual(await snapshot(),before,'rejected '+label+' is atomic');}}
 for(const [index,value] of [[0,'2500'],[0,-1],[0,10001],[1,'guess']]){const bad=structuredClone(definition);bad.employeeOverrides[index].value=value;const before=await snapshot();await assert.rejects(()=>createScheme(bad,'Invalid type'),e=>e.status===400);assert.deepEqual(await snapshot(),before);}
 for (const upperFamily of ['roleAssignments','employeeOverrides']) {
  const mixed=structuredClone(definition);for(const row of mixed[upperFamily])row.employeeId=row.employeeId.toUpperCase();
  const beforeInput=structuredClone(mixed),mixedVersion=(await createScheme(mixed,'Mixed UUID '+upperFamily)).versions[0];assert.deepEqual(mixed,beforeInput,'validation never mutates caller identity');await preview(mixedVersion.versionId,5000);
  const partialMixed=structuredClone(mixed);partialMixed.employeeOverrides.pop();
  const expiredMixed=structuredClone(mixed);expiredMixed.employeeOverrides[1].effectiveTo='2026-10-13';
  const premiumMixed=structuredClone(mixed);premiumMixed.roleParameters.bar.applyMilestones=true;premiumMixed.roleParameters.bar.milestoneBonusesCents={20000:1000};
  const scalarMixed=structuredClone(mixed);scalarMixed.employeeOverrides=Object.entries({mode:'personal_target',baseRateBps:1000,bonusRateBps:2000,excessRatePolicy:'replace_base'}).map(([path,value])=>({...mixed.employeeOverrides[0],path,value}));
  const thresholdMixed=structuredClone(mixed);thresholdMixed.roleParameters.bar.bracketRatesBps={0:1000,100:2000};thresholdMixed.roleParameters.alias={perShiftCents:0,stableRateBps:1000,bracketRatesBps:{0:1000,'0100':2000}};thresholdMixed.employeeOverrides=[{...mixed.employeeOverrides[0],path:'bracketRatesBps.0100',value:2000}];
  for(const [bad,code] of [[partialMixed,'invalid_personal_cap'],[expiredMixed,'invalid_personal_cap'],[premiumMixed,'milestone_cap_policy_required'],[scalarMixed,'invalid_personal_parameters'],[thresholdMixed,'invalid_personal_threshold']]){
   const before=await snapshot(),original=structuredClone(bad);await assert.rejects(()=>createScheme(bad,'Mixed UUID negative'),e=>e.code===code&&e.status===400);assert.deepEqual(await snapshot(),before);assert.deepEqual(bad,original);
  }
 }
 const changed=structuredClone(definition);changed.roleParameters.capped={perShiftCents:10000,stableRateBps:1000,cap:{rateBps:2000,basis:'venue_day'}};changed.roleAssignments=changed.roleAssignments.filter(r=>r.employeeId!==employee);changed.roleAssignments.push({employeeId:employee,roleId:'capped',effectiveFrom:'2026-10-01',effectiveTo:'2026-10-01'},{employeeId:employee,roleId:'bar',effectiveFrom:'2026-10-02',effectiveTo:'2026-10-31'});
 const increasedAck={...ack,personalCapIncrease:{confirmed:true,policyCode:'payroll-personal-cap-above-role-v1'}};
 const changedVersion=(await createScheme(changed,'Capped to uncapped',increasedAck)).versions[0];
 const changedSaved=await service.getVersion(actor,changedVersion.versionId);assert.deepEqual(changedSaved.payoutRiskAcknowledgement.personalCapIncrease.exceptions.map(r=>[r.roleId,r.effectiveFrom,r.effectiveTo,r.roleRateBps,r.personalRateBps]),[['capped','2026-10-01','2026-10-01',2000,2500]]);
 const twoDays=structuredClone(scenario);twoDays.periodTo='2026-10-02';twoDays.roleAssignments=changed.roleAssignments;twoDays.coverage.through=twoDays.periodTo;twoDays.attendanceCoverage.through=twoDays.periodTo;twoDays.attendance.push({...twoDays.attendance[0],id:'shift2',date:'2026-10-02'});twoDays.sales.push({...twoDays.sales[0],id:'line2',date:'2026-10-02'});const transition=await preview(changedVersion.versionId,10000,twoDays);assert.deepEqual(transition.daily.map(d=>d.employees.find(r=>r.employeeId===employee).amountCents),[5000,5000]);
 const tampered=(await createScheme(definition,'Tampered cap')).versions[0];await db.query("DELETE FROM payroll_employee_overrides WHERE scheme_version_id=$1 AND parameter_path='cap.basis'",[tampered.versionId]);const tamperedBefore=(await db.query('SELECT status FROM payroll_scheme_versions WHERE id=$1',[tampered.versionId])).rows;await assert.rejects(()=>service.activateVersion(actor,tampered.versionId),e=>e.code==='invalid_personal_cap');assert.deepEqual((await db.query('SELECT status FROM payroll_scheme_versions WHERE id=$1',[tampered.versionId])).rows,tamperedBefore);assert.equal(tamperedBefore[0].status,'draft');
 assert.equal((await service.activateVersion(actor,version.versionId)).status,'active');await read();await preview(version.versionId,5000);await assert.rejects(()=>service.replaceDraftVersion(actor,version.versionId,zero,ack),e=>e.status===409);
 await assert.rejects(()=>service.getVersion({venueId:venue,userId:employee},version.versionId),e=>e.status===403);
 const foreignVenue=(await db.query("INSERT INTO venues(name) VALUES('Foreign cap') RETURNING id")).rows[0].id,foreignOwner=(await db.query("INSERT INTO users(venue_id,full_name,login,role) VALUES($1,'Foreign owner',$2,'owner') RETURNING id",[foreignVenue,`${schema}-foreign`])).rows[0].id;await assert.rejects(()=>service.getVersion({venueId:foreignVenue,userId:foreignOwner},version.versionId),e=>e.status===404);
 assert.deepEqual((await db.query('SELECT (SELECT count(*)::int FROM payroll_calculation_runs) AS runs,(SELECT count(*)::int FROM payroll_entries) AS entries,(SELECT count(*)::int FROM expenses) AS expenses')).rows[0],{runs:0,entries:0,expenses:0});
 console.log('PAYROLL STANDALONE CAP POSTGRES: PASS (save/direct PG/read/scenario5000/zero/inherit12000, dated baselines, complete-window atomic rejection, activation tamper/immutability, owner/tenant and no posting)');
}finally{
 await pool?.end();if(created){await db.query('SET search_path TO public');await db.query(`DROP SCHEMA "${schema}" CASCADE`);assert.equal((await db.query('SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname=$1) AS present',[schema])).rows[0].present,false);}await db.end();
}
