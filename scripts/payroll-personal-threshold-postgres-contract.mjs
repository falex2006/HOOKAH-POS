import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {validateQaDatabaseUrl,assertQaDatabaseIdentity} from './postgres-qa-safety.mjs';
const require=createRequire(import.meta.url),{Client,Pool}=require('pg'),{makeService}=require('../payroll-scheme-service');
const target=validateQaDatabaseUrl(process.env.MIGRATIONS_PG_TEST_DATABASE_URL),root=fileURLToPath(new URL('../',import.meta.url));
const schema=`payroll_threshold_qa_${process.pid}_${Date.now()}`;assert.match(schema,/^payroll_threshold_qa_\d+_\d+$/);
const db=new Client({connectionString:target.url.href}),url=new URL(target.url);url.searchParams.set('options',`-c search_path=${schema},public`);
let pool,created=false;
try {
 await db.connect();
 assertQaDatabaseIdentity((await db.query('SELECT current_database() AS database,inet_server_addr() AS address,inet_server_port() AS port,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser')).rows[0],target.database,Number(target.url.port));
 await db.query(`CREATE SCHEMA "${schema}"`);created=true;await db.query(`SET search_path TO "${schema}",public`);
 await db.query(readFileSync(path.join(root,'schema.sql'),'utf8'));
 for(const name of readdirSync(path.join(root,'migrations')).filter(name=>/^\d{3}.*\.sql$/.test(name)&&Number(name.slice(0,3))<=87).sort())await db.query(readFileSync(path.join(root,'migrations',name),'utf8'));
 pool=new Pool({connectionString:url.href});const service=makeService(pool);
 const venue=(await db.query("INSERT INTO venues(name) VALUES('Threshold QA') RETURNING id")).rows[0].id;
 const user=async(role)=> (await db.query('INSERT INTO users(venue_id,full_name,login,role) VALUES($1,$2,$3,$4) RETURNING id',[venue,role,`${schema}-${role}`,role])).rows[0].id;
 const owner=await user('owner'),employee=await user('bartender'),actor={venueId:venue,userId:owner};
 const ack={confirmed:true,policyCode:'payroll-own-revenue-ceiling-v1'};
 const definition={mode:'progressive_daily',currency:'RUB',effectiveFrom:'2026-10-01',effectiveTo:'2026-10-31',roleParameters:{bar:{perShiftCents:0,bracketRatesBps:{0:1000}}},
  roleAssignments:[{employeeId:employee,roleId:'bar',effectiveFrom:'2026-10-01',effectiveTo:'2026-10-31'}],
  employeeOverrides:[{employeeId:employee,path:'bracketRatesBps.5000',mode:'override',value:0,effectiveFrom:'2026-10-01',effectiveTo:'2026-10-14'},
   {employeeId:employee,path:'milestoneBonusesCents.5000',mode:'override',value:100,effectiveFrom:'2026-10-01',effectiveTo:'2026-10-14'}],itemRules:[]};
 const first=(await service.createScheme(actor,{name:'Personal thresholds',definition,payoutRiskAcknowledgement:ack})).versions[0];
 const saved=await service.getVersion(actor,first.versionId);assert.deepEqual(saved.employeeOverrides.map(row=>({path:row.path,value:row.value,from:row.effectiveFrom,to:row.effectiveTo})),definition.employeeOverrides.map(row=>({path:row.path,value:row.value,from:row.effectiveFrom,to:row.effectiveTo})));
 const scenario={periodFrom:'2026-10-01',periodTo:'2026-10-02',employees:[{id:employee}],roleAssignments:definition.roleAssignments,attendance:[],
  coverage:{kind:'month_to_date_complete',from:'2026-10-01',through:'2026-10-02',complete:true,watermark:'scenario'},attendanceCoverage:{kind:'approved_attendance_complete',from:'2026-10-01',through:'2026-10-02',complete:true,watermark:'scenario'},
  sales:[{id:'line',employeeId:employee,date:'2026-10-01',department:'bar',turnoverCents:10000,commissionBaseCents:10000}]};
 const preview=await service.preview(actor,first.versionId,scenario);assert.equal(preview.result.status,'ready');assert.equal(preview.result.employees[0].commissionCents,0);assert.equal(preview.result.employees[0].milestoneBonusCents,100);
 assert.equal((await service.activateVersion(actor,first.versionId)).status,'active');
 const inherit=structuredClone(definition);inherit.employeeOverrides=inherit.employeeOverrides.map(({value,...row})=>({...row,mode:'inherit'}));
 const second=(await service.createScheme(actor,{name:'Inherit thresholds',definition:inherit,payoutRiskAcknowledgement:ack})).versions[0];
 assert.equal((await service.preview(actor,second.versionId,scenario)).result.employees[0].amountCents,1000);
 // Persist typed independent parameters through the actual version lifecycle.
 // Mode-specific arithmetic is covered by the separate pure inheritance matrix.
 const parameterBase=structuredClone(definition);
 parameterBase.mode='personal_target';parameterBase.milestoneCapPolicy='included_in_cap';
 parameterBase.roleParameters.bar={perShiftCents:0,stableRateBps:1000,bracketRatesBps:{0:1000},targetCents:5000,baseRateBps:1000,bonusRateBps:2000,
   excessRatePolicy:'replace_base',lossPolicy:'offset_daily_losses',itemRuleBasis:'net_revenue',teamWeight:1,department:'bar',
   cap:{rateBps:3000,basis:'venue_day'},applyMilestones:false,milestoneBonusesCents:{5000:100}};
 const parameters=[['perShiftCents',0],['stableRateBps',0],['bracketRatesBps.5000',0],['targetCents',0],['baseRateBps',0],['bonusRateBps',0],
   ['excessRatePolicy','add_to_base'],['lossPolicy','offset_daily_losses'],['itemRuleBasis','net_revenue'],['teamWeight',0],
   ['cap.rateBps',0],['cap.basis','employee_department_day'],['applyMilestones',false],['milestoneBonusesCents.7000',0],['mode','stable_percent']];
 for(const [parameter,value] of parameters){
   const personal=structuredClone(parameterBase);
   personal.employeeOverrides=[{employeeId:employee,path:parameter,mode:'override',value,effectiveFrom:'2026-10-02',effectiveTo:'2026-10-14'}];
   const scheme=await service.createScheme(actor,{name:`Parameter ${parameter}`,definition:personal,payoutRiskAcknowledgement:ack});
   const version=scheme.versions[0];
   const verify=async(id,expectedMode)=>{
     const loaded=await service.getVersion(actor,id),row=loaded.employeeOverrides[0];
     assert.equal(row.path,parameter);assert.equal(row.mode,expectedMode);
     assert.equal(row.value,expectedMode==='override'?value:undefined);
     assert.equal(row.effectiveFrom,'2026-10-02');assert.equal(row.effectiveTo,'2026-10-14');
     assert.deepEqual(loaded.roleParameters,parameterBase.roleParameters,'personal edit preserves every role sibling');
     const response=await service.preview(actor,id,scenario);assert.equal(response.official,false);assert.equal(response.persistence,'none');
   };
   await verify(version.versionId,'override');
   const inherited=structuredClone(personal);inherited.employeeOverrides[0].mode='inherit';delete inherited.employeeOverrides[0].value;
   await service.replaceDraftVersion(actor,version.versionId,inherited,ack);await verify(version.versionId,'inherit');
   const next=await service.createVersion(actor,scheme.id,personal,ack);await verify(next.versionId,'override');
   assert.equal((await service.activateVersion(actor,next.versionId)).status,'active');await verify(next.versionId,'override');
 }
 const cap=structuredClone(definition);cap.roleParameters.bar.cap={rateBps:3000,basis:'venue_day'};
 await assert.rejects(()=>service.createScheme(actor,{name:'Missing policy',definition:cap,payoutRiskAcknowledgement:ack}),error=>error.message.includes('milestone_cap_policy_required'));
 for(const policy of ['included_in_cap','separate_from_shift_cap']){cap.milestoneCapPolicy=policy;const version=(await service.createScheme(actor,{name:policy,definition:cap,payoutRiskAcknowledgement:ack})).versions[0];assert.equal((await service.activateVersion(actor,version.versionId)).status,'active');}
 for(const threshold of ['05000','0','9007199254740992']){const bad=structuredClone(definition);bad.employeeOverrides[1].path=`milestoneBonusesCents.${threshold}`;await assert.rejects(()=>service.createScheme(actor,{name:'Bad threshold',definition:bad,payoutRiskAcknowledgement:ack}));}
 await assert.rejects(()=>service.getVersion({venueId:venue,userId:employee},first.versionId),error=>error.status===403);
 assert.deepEqual((await db.query('SELECT (SELECT count(*) FROM payroll_calculation_runs)::int AS runs,(SELECT count(*) FROM payroll_entries)::int AS entries,(SELECT count(*) FROM expenses)::int AS expenses')).rows[0],{runs:0,entries:0,expenses:0});
 console.log('PAYROLL PERSONAL THRESHOLD POSTGRES: PASS (15 typed parameters create/read/edit/new-version/activate/scenario, zero/inherit, threshold cap gates, owner and no posting)');
}finally{await pool?.end();if(created){await db.query('SET search_path TO public');await db.query(`DROP SCHEMA "${schema}" CASCADE`);}await db.end();}
